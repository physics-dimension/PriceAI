#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceConfigPath = path.join(repoRoot, "config", "api-transit-sources.json");
const userAgent = "PriceAI-public-discovery/1.0";
const defaultQuery = 'page.title:"Sub2API"';

export async function discoverSub2ApiStations(options = {}) {
  const normalized = normalizeOptions(options);
  const configuredHosts = readConfiguredHosts();
  const scans = await fetchUrlscanPages(normalized);
  const candidates = uniqueCandidates(scans);
  const pendingCandidates = normalized.includeConfigured
    ? candidates
    : candidates.filter((candidate) => !configuredHosts.has(new URL(candidate.origin).hostname));

  const rows = await mapLimit(
    pendingCandidates,
    normalized.concurrency,
    async (candidate, index) => {
      const plazaResult = await fetchJson(
        `${candidate.origin}/api/v1/model-plaza`,
        normalized.timeoutMs,
      );
      const plaza = modelPlazaStats(plazaResult.payload);
      if (!plaza.models.length || !plaza.multipliers.length) {
        reportProgress(normalized, index + 1, pendingCandidates.length);
        return null;
      }

      const settingsResult = await fetchJson(
        `${candidate.origin}/api/v1/settings/public`,
        normalized.timeoutMs,
      );
      const settings = settingsResult.payload?.data;
      reportProgress(normalized, index + 1, pendingCandidates.length);
      return {
        origin: candidate.origin,
        configured: configuredHosts.has(new URL(candidate.origin).hostname),
        title: candidate.title,
        lastPublicScanAt: candidate.scanTime,
        siteName: textValue(settings?.site_name),
        apiBaseUrl: textValue(settings?.api_base_url),
        registrationEnabled: booleanValue(settings?.registration_enabled),
        paymentEnabled: booleanValue(settings?.payment_enabled),
        modelPlazaEnabled: booleanValue(settings?.model_plaza_enabled),
        modelPlazaRequireAuth: booleanValue(settings?.model_plaza_require_auth),
        version: textValue(settings?.version),
        groups: plaza.groups.length,
        models: plaza.models.length,
        multipliers: plaza.multipliers,
        groupSummary: plaza.groups.map((group) => ({
          name: textValue(group?.name),
          platform: textValue(group?.platform),
          subscriptionType: textValue(group?.subscription_type),
          rateMultiplier: positiveNumber(group?.rate_multiplier),
          models: Array.isArray(group?.models) ? group.models.length : 0,
        })),
        pricingUrl: `${candidate.origin}/model-plaza`,
        pricingEndpointUrl: `${candidate.origin}/api/v1/model-plaza`,
      };
    },
  );

  const useful = rows.filter(Boolean).sort((left, right) => left.origin.localeCompare(right.origin));
  return {
    source: "urlscan_public_search",
    query: normalized.query,
    generatedAt: new Date().toISOString(),
    counts: {
      searchRows: scans.length,
      candidateHosts: candidates.length,
      skippedConfiguredHosts: candidates.length - pendingCandidates.length,
      probedHosts: pendingCandidates.length,
      usefulStations: useful.length,
    },
    stations: useful,
  };
}

async function fetchUrlscanPages(options) {
  const scans = [];
  let searchAfter = null;

  for (let page = 0; page < options.pages; page += 1) {
    const url = new URL("https://urlscan.io/api/v1/search/");
    url.searchParams.set("q", options.query);
    url.searchParams.set("size", String(options.pageSize));
    if (searchAfter) url.searchParams.set("search_after", searchAfter);

    const response = await fetchJson(url.href, options.searchTimeoutMs);
    if (response.status !== 200 || !Array.isArray(response.payload?.results)) {
      throw new Error(
        `URLScan search failed on page ${page + 1}: HTTP ${response.status || 0}`,
      );
    }

    const results = response.payload.results;
    scans.push(...results);
    if (!options.quiet) {
      console.error(
        `URLScan page=${page + 1} rows=${results.length} totalRows=${scans.length}`,
      );
    }
    if (results.length < options.pageSize) break;

    const sort = results.at(-1)?.sort;
    if (!Array.isArray(sort) || sort.length < 2) break;
    searchAfter = `${sort[0]},${sort[1]}`;
    await delay(options.searchDelayMs);
  }

  return scans;
}

function uniqueCandidates(scans) {
  const byHostname = new Map();

  for (const row of scans) {
    const rawUrl = row?.page?.url || row?.task?.url;
    if (!rawUrl) continue;
    try {
      const parsed = new URL(
        /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`,
      );
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      if (byHostname.has(parsed.hostname)) continue;
      byHostname.set(parsed.hostname, {
        origin: parsed.origin,
        title: textValue(row?.page?.title),
        scanTime: textValue(row?.task?.time),
      });
    } catch {
      // Ignore malformed public scan URLs.
    }
  }

  return [...byHostname.values()];
}

function modelPlazaStats(payload) {
  const groups = Array.isArray(payload?.data?.groups) ? payload.data.groups : [];
  const models = groups.flatMap((group) => (
    Array.isArray(group?.models) ? group.models : []
  ));
  const multipliers = [
    ...new Set(
      groups
        .map((group) => positiveNumber(group?.rate_multiplier))
        .filter((value) => value !== null),
    ),
  ].sort((left, right) => left - right);

  return { groups, models, multipliers };
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": userAgent,
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // HTML login pages and proxy errors are not useful discovery results.
    }
    return {
      status: response.status,
      url: response.url,
      payload,
    };
  } catch (error) {
    return {
      status: 0,
      url,
      payload: null,
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, callback) {
  const output = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await callback(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return output;
}

function reportProgress(options, completed, total) {
  if (options.quiet || completed % options.progressEvery !== 0) return;
  console.error(`Probed ${completed}/${total} public model plaza endpoints.`);
}

function readConfiguredHosts() {
  const rows = JSON.parse(readFileSync(sourceConfigPath, "utf8"));
  const hosts = new Set();
  for (const row of rows) {
    for (const value of [
      row?.websiteUrl,
      row?.apiBaseUrl,
      row?.pricingUrl,
      row?.pricingEndpointUrl,
    ]) {
      if (!value) continue;
      try {
        hosts.add(new URL(value).hostname);
      } catch {
        // Invalid configuration URLs are covered by the collector tests.
      }
    }
  }
  return hosts;
}

function normalizeOptions(options) {
  return {
    query: textValue(options.query) || defaultQuery,
    pages: boundedInteger(options.pages, 10, 1, 20),
    pageSize: boundedInteger(options.pageSize, 100, 1, 100),
    concurrency: boundedInteger(options.concurrency, 10, 1, 16),
    timeoutMs: boundedInteger(options.timeoutMs, 4500, 1000, 30000),
    searchTimeoutMs: boundedInteger(options.searchTimeoutMs, 15000, 1000, 30000),
    searchDelayMs: boundedInteger(options.searchDelayMs, 300, 0, 5000),
    progressEvery: boundedInteger(options.progressEvery, 100, 1, 1000),
    includeConfigured: Boolean(options.includeConfigured),
    quiet: Boolean(options.quiet),
  };
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--include-configured") {
      options.includeConfigured = true;
      continue;
    }
    if (argument === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : null;
}

function textValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  if (error?.name === "AbortError") return "request timeout";
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export const __test = {
  modelPlazaStats,
  normalizeOptions,
  uniqueCandidates,
};

if (isCli()) {
  try {
    const result = await discoverSub2ApiStations(parseCliArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
