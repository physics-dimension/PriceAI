#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { safeFetch } from "./safe-fetch.mjs";
import {
  claimScriptRuntimeLease,
  releaseScriptRuntimeLease,
  startScriptRuntimeLeaseHeartbeat,
} from "./runtime-lease.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "config", "api-transit-sources.json");
const envPath = path.join(repoRoot, ".env.local");
const defaultOutPath = path.join(repoRoot, "data", "api-transit", "latest-public-pricing.json");

const userAgent = "Mozilla/5.0 PriceAI/1.0 APITransitCollector";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RECHARGE_RATIO = "1:1";
const NEW_API_USD_UNIT_PRICE_FACTOR = 2;
const CALLAI_PARTNER_STATUS_COLLECTORS = new Set([
  "callai_partner_status",
  "sub2api_partner_status",
  "subway_api_partner_status",
]);
const ONEHOP_PUBLIC_MODEL_COLLECTORS = new Set(["onehop_public_models"]);
const SUB2API_MODEL_PLAZA_COLLECTORS = new Set(["sub2api_model_plaza"]);
const SUB2API_PUBLIC_PROFILE_COLLECTORS = new Set(["sub2api_public_profile"]);
const APINODE_PUBLIC_SITE_INFO_COLLECTORS = new Set(["apinode_public_site_info", "sub2api_public_site_info"]);
const ZIVV_MODEL_HUB_COLLECTORS = new Set(["zivv_model_hub"]);
const AI_TRANSIT_SNAPSHOT_COLLECTORS = new Set(["ai_transit_snapshot"]);
const MAX_PUBLIC_AVAILABILITY_SAMPLE_COUNT = 60;
const AVAILABILITY_SNAPSHOT_DELETE_BATCH_SIZE = 500;
const AVAILABILITY_SNAPSHOT_DELETE_MAX_BATCHES = 20;
const SOURCE_SKIPPED = Symbol("source_skipped");
const AVAILABILITY_SOURCES = {
  publicStatus: {
    type: "public_status",
    label: "公开监测页",
  },
  publicModelCatalog: {
    type: "public_model_catalog",
    label: "公开模型页",
  },
  partnerApi: {
    type: "partner_api",
    label: "站长接口",
  },
  unknown: {
    type: "unknown",
    label: null,
  },
};
const STALE_UNKNOWN_AVAILABILITY_NOTE_PATTERN = /PriceAI API Key 探测|PriceAI 临时 Key|单轮准入抽样|近 7 日 .*样本成功/;
const officialTransitPrices = {
  "Claude Opus 5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, imageOutput: null, currency: "USD" },
  "Claude Fable 5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, imageOutput: null, currency: "USD" },
  "Claude Sonnet 5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, imageOutput: null, currency: "USD" },
  "Claude Sonnet 4.5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, imageOutput: null, currency: "USD" },
  "Claude Sonnet 4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, imageOutput: null, currency: "USD" },
  "Claude Haiku 4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, imageOutput: null, currency: "USD" },
  "Claude Opus 4.5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, imageOutput: null, currency: "USD" },
  "Claude Opus 4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, imageOutput: null, currency: "USD" },
  "Claude Opus 4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, imageOutput: null, currency: "USD" },
  "Claude Opus 4.8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, imageOutput: null, currency: "USD" },
  "Codex Compact": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "GPT 5.6 Sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, imageOutput: null, currency: "USD" },
  "GPT 5.6 Terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125, imageOutput: null, currency: "USD" },
  "GPT 5.6 Luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25, imageOutput: null, currency: "USD" },
  "GPT 5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0.5, imageOutput: null, currency: "USD" },
  "GPT 5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0.25, imageOutput: null, currency: "USD" },
  "GPT 5.4 Mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.075, imageOutput: null, currency: "USD" },
  "Gemini 3.5 Flash": { input: 1.5, output: 9, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Gemini 3.1 Pro": { input: 2, output: 12, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Grok 4.20": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Grok 4.3": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Grok 4.5": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Grok Build": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Composer 2.5": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "GLM-5.2": { input: 8, output: 28, cacheRead: 2, cacheWrite: null, imageOutput: null, currency: "CNY" },
  "GLM-5.1": { input: 6, output: 24, cacheRead: 1.3, cacheWrite: null, imageOutput: null, currency: "CNY" },
  "DeepSeek V4 Flash": { input: 1, output: 2, cacheRead: 0.02, cacheWrite: null, imageOutput: null, currency: "CNY" },
  "DeepSeek V4 Pro": { input: 3, output: 6, cacheRead: 0.025, cacheWrite: null, imageOutput: null, currency: "CNY" },
  "Kimi K3": { input: 20, output: 100, cacheRead: 2, cacheWrite: null, imageOutput: null, currency: "CNY" },
  "Qwen3.8-Max-Preview": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "CNY" },
  "Qwen3.7-Max": { input: 12, output: 36, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "CNY" },
  "GPT Image 2": { input: 5, output: null, cacheRead: 1.25, cacheWrite: null, imageOutput: 30, currency: "USD" },
  "Grok Image": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Nano Banana Pro": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Nano Banana 2": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Nano Banana": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Nano Banana Lite": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Sora 2": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Sora 2 Pro": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Grok Video": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Veo 3.1": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Veo 3.1 Lite": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Gemini Omni Flash": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Seedance 2.0": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "HappyHorse 1.1 I2V": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
  "Kling 2.5 Turbo": { input: null, output: null, cacheRead: null, cacheWrite: null, imageOutput: null, currency: "USD" },
};
const modelFamilyByStandard = {
  "Claude Opus 5": "claude",
  "Claude Fable 5": "claude",
  "Claude Sonnet 5": "claude",
  "Claude Sonnet 4.5": "claude",
  "Claude Sonnet 4.6": "claude",
  "Claude Haiku 4.5": "claude",
  "Claude Opus 4.5": "claude",
  "Claude Opus 4.6": "claude",
  "Claude Opus 4.7": "claude",
  "Claude Opus 4.8": "claude",
  "Codex Compact": "gpt",
  "GPT 5.6 Sol": "gpt",
  "GPT 5.6 Terra": "gpt",
  "GPT 5.6 Luna": "gpt",
  "GPT 5.5": "gpt",
  "GPT 5.4": "gpt",
  "GPT 5.4 Mini": "gpt",
  "Gemini 3.5 Flash": "gemini",
  "Gemini 3.1 Pro": "gemini",
  "Grok 4.20": "grok",
  "Grok 4.3": "grok",
  "Grok 4.5": "grok",
  "Grok Build": "grok",
  "Composer 2.5": "grok",
  "GLM-5.2": "glm",
  "GLM-5.1": "glm",
  "DeepSeek V4 Flash": "deepseek",
  "DeepSeek V4 Pro": "deepseek",
  "Kimi K3": "kimi",
  "Qwen3.8-Max-Preview": "qwen",
  "Qwen3.7-Max": "qwen",
  "GPT Image 2": "image",
  "Grok Image": "grok",
  "Nano Banana Pro": "image",
  "Nano Banana 2": "image",
  "Nano Banana": "image",
  "Nano Banana Lite": "image",
  "Sora 2": "video",
  "Sora 2 Pro": "video",
  "Grok Video": "grok",
  "Veo 3.1": "video",
  "Veo 3.1 Lite": "video",
  "Gemini Omni Flash": "video",
  "Seedance 2.0": "video",
  "HappyHorse 1.1 I2V": "video",
  "Kling 2.5 Turbo": "video",
};
const fixedPriceMediaStandards = new Set([
  "GPT Image 2",
  "Grok Image",
  "Nano Banana Pro",
  "Nano Banana 2",
  "Nano Banana",
  "Nano Banana Lite",
  "Sora 2",
  "Sora 2 Pro",
  "Grok Video",
  "Veo 3.1",
  "Veo 3.1 Lite",
  "Gemini Omni Flash",
  "Seedance 2.0",
  "HappyHorse 1.1 I2V",
  "Kling 2.5 Turbo",
]);

if (isCli()) {
  const args = normalizeOptions(parseArgs(process.argv.slice(2)));
  const runtimeEnv = { ...readEnvFile(envPath), ...process.env };
  const leaseOwner = `api-transit:${process.env.GITHUB_RUN_ID || process.env.HOSTNAME || "local"}:${process.pid}`;
  let lease = null;
  let leaseHeartbeat = null;

  try {
    if (args.post || args.db) {
      lease = await claimScriptRuntimeLease({
        key: "api-transit-collection",
        owner: leaseOwner,
        leaseSeconds: 7200,
        metadata: {
          source: args.source || null,
          runtime: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "collector-runtime",
        },
        env: runtimeEnv,
      });
      if (!lease.acquired) {
        console.log(JSON.stringify({
          skipped: true,
          reason: "lease_busy",
          owner: lease.owner,
          expiresAt: lease.expiresAt,
        }));
        process.exitCode = 0;
      } else {
        leaseHeartbeat = startScriptRuntimeLeaseHeartbeat({
          key: lease.key,
          owner: leaseOwner,
          leaseSeconds: 7200,
          env: runtimeEnv,
          onError: (error) => console.error(`Runtime lease heartbeat failed: ${errorMessage(error)}`),
        });
      }
    }

    if (lease && !lease.acquired) {
      // Another runtime is already performing the shared collection.
    } else {
      const result = await collectApiTransitPrices(args);
      leaseHeartbeat?.assertOwned();
      printSummary(result);

      if (args.dryRun) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const outPath = path.resolve(repoRoot, args.out || defaultOutPath);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        console.log(`Snapshot written to ${path.relative(repoRoot, outPath)}`);
      }
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  } finally {
    await leaseHeartbeat?.stop();
    if (lease?.acquired) {
      await releaseScriptRuntimeLease({
        key: lease.key,
        owner: leaseOwner,
        env: runtimeEnv,
      }).catch((error) => {
        console.error(`Runtime lease release failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      });
    }
  }
}

export async function collectApiTransitPrices(options = {}) {
  options = normalizeOptions(options);

  const selectedSources = selectSources(await loadCollectionSources(options), options);
  const startedAt = new Date().toISOString();
  const stations = [];
  const offers = [];
  const runs = [];
  const availabilitySamples = [];
  const availabilitySampleSnapshots = [];

  for (const source of selectedSources) {
    const runStartedAt = new Date().toISOString();
    try {
      const sourceOptions = withSourceOptions(options, source);
      const payload = await fetchPricingJson(source, sourceOptions);
      const parsed = parsePricingPayload(source, payload, runStartedAt);
      const sourceCollectionSucceeded = parsed.offers.length > 0 || parsed.profileOnly === true;
      let availabilityPayload = null;
      let availabilityError = null;
      try {
        availabilityPayload = await fetchAvailabilityPayload(source, sourceOptions);
        applyAvailabilityPayloadToParsedRows(source, parsed, availabilityPayload, runStartedAt);
      } catch (error) {
        availabilityError = errorMessage(error);
      }
      const runId = stableId("api-transit-run", source.id, runStartedAt);
      parsed.offers = parsed.offers.map(clearUnpricedPreviewModelRates);
      stations.push(parsed.station);
      offers.push(...parsed.offers);
      runs.push({
        id: runId,
        station_id: source.id,
        run_type: "public_pricing",
        status: sourceCollectionSucceeded ? "success" : "partial",
        model_count: parsed.modelCount,
        offer_count: parsed.offers.length,
        error_message: sourceCollectionSucceeded ? null : parsed.collectionError || "未识别到已支持的标准模型。",
        source_url: source.pricingEndpointUrl,
        started_at: runStartedAt,
        finished_at: new Date().toISOString(),
        raw_snapshot: compactSnapshot(availabilityPayload ? {
          pricing: payload,
          availability: availabilityPayload,
        } : payload),
        logs: {
          collectorKind: source.collectorKind,
          selectedModels: parsed.offers.map((offer) => offer.raw_model_name),
          availabilitySourceUrl: source.monitorEndpointUrl || null,
          availabilitySamples: parsed.availabilitySamples?.length || 0,
          availabilityError,
        },
      });
      availabilitySamples.push(
        ...(parsed.availabilitySamples || []).map((sample) => ({
          ...sample,
          run_id: runId,
        })),
      );
      if (isZivvModelHubSource(source) && parsed.availabilitySamples?.length) {
        availabilitySampleSnapshots.push({
          stationId: source.id,
          sourceType: AVAILABILITY_SOURCES.publicStatus.type,
          runId,
        });
      }
    } catch (error) {
      if (error?.code === SOURCE_SKIPPED) {
        runs.push({
          id: stableId("api-transit-run", source.id, runStartedAt),
          station_id: null,
          run_type: "public_pricing",
          status: "partial",
          model_count: 0,
          offer_count: 0,
          error_message: error.message,
          source_url: source.pricingEndpointUrl,
          started_at: runStartedAt,
          finished_at: new Date().toISOString(),
          raw_snapshot: {},
          logs: {
            collectorKind: source.collectorKind,
            skipped: true,
            reason: error.reason || "source_skipped",
          },
        });
        continue;
      }

      stations.push(buildStationRow(source, runStartedAt, { status: "failed", error: errorMessage(error) }));
      runs.push({
        id: stableId("api-transit-run", source.id, runStartedAt),
        station_id: source.id,
        run_type: "public_pricing",
        status: "failed",
        model_count: 0,
        offer_count: 0,
        error_message: errorMessage(error),
        source_url: source.pricingEndpointUrl,
        started_at: runStartedAt,
        finished_at: new Date().toISOString(),
        raw_snapshot: {},
        logs: { collectorKind: source.collectorKind },
      });
    }
  }

  const dedupedAvailabilitySamples = dedupeRowsById(availabilitySamples);
  const result = {
    dryRun: Boolean(options.dryRun),
    post: Boolean(options.post || options.db),
    publish: Boolean(options.publish),
    source: "api_transit_public_pricing",
    generatedAt: new Date().toISOString(),
    startedAt,
    counts: {
      sources: selectedSources.length,
      stations: stations.length,
      offers: offers.length,
      runs: runs.length,
      availabilitySamples: dedupedAvailabilitySamples.length,
    },
    stations,
    offers,
    runs,
    availabilitySamples: dedupedAvailabilitySamples,
    availabilitySampleSnapshots,
  };

  if (options.post || options.db) {
    result.database = await postRows({
      stations,
      offers,
      runs,
      availabilitySamples: dedupedAvailabilitySamples,
      availabilitySampleSnapshots,
    }, options);
  }

  return result;
}

function clearUnpricedPreviewModelRates(offer) {
  if (offer.standard_model !== "Qwen3.8-Max-Preview") return offer;

  return {
    ...offer,
    model_multiplier: null,
    input_price: null,
    output_price: null,
    cache_read_price: null,
    cache_write_price: null,
    raw_payload: {
      ...(offer.raw_payload || {}),
      priceai_unpriced_preview: {
        observed_model_multiplier: offer.model_multiplier ?? null,
        observed_input_price: offer.input_price ?? null,
        observed_output_price: offer.output_price ?? null,
        observed_cache_read_price: offer.cache_read_price ?? null,
        reason: "official_payg_price_unavailable",
      },
    },
  };
}

function withSourceOptions(options, source) {
  const timeoutMs = Number(source.timeoutMs || source.timeout_ms || options.timeoutMs || options["timeout-ms"] || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return options;
  return { ...options, timeoutMs };
}

async function fetchPricingJson(source, options) {
  if (isCallaiPartnerStatusSource(source)) {
    return fetchCallaiPartnerStatus(source, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  try {
    const response = await safeFetch(source.pricingEndpointUrl, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": userAgent,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("公开价格接口没有返回 JSON。");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCallaiPartnerStatus(source, options) {
  const token = source.partnerToken || envValue(source.partnerTokenEnv, options);
  if (!token) {
    throw skippedSource(
      `缺少 ${source.partnerTokenEnv || "partnerToken"}，已跳过 ${source.name} partner API 采集。`,
      "missing_partner_token",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  try {
    const response = await safeFetch(source.pricingEndpointUrl, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${token}`,
        "user-agent": userAgent,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("partner API 没有返回 JSON。");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAvailabilityPayload(source, options) {
  if (!source.monitorEndpointUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  try {
    const response = await safeFetch(source.monitorEndpointUrl, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": userAgent,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("公开监测接口没有返回 JSON。");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function applyAvailabilityPayloadToParsedRows(source, parsed, payload, collectedAt) {
  if (!payload) return;
  if (isZivvModelHubSource(source)) {
    applyZivvStatusAvailability(source, parsed, payload, collectedAt);
    return;
  }
  if (isNewApiPricingSource(source) && isNewApiPerformanceSummaryPayload(payload)) {
    applyNewApiPerformanceSummaryAvailability(source, parsed, payload, collectedAt);
  }
}

function parsePricingPayload(source, payload, collectedAt) {
  if (isCallaiPartnerStatusSource(source)) {
    return parseCallaiPartnerStatusPayload(source, payload, collectedAt);
  }
  if (isOneHopPublicModelsSource(source)) {
    return parseOneHopPublicModelsPayload(source, payload, collectedAt);
  }
  if (isSub2ApiPublicProfileSource(source)) {
    return parseSub2ApiPublicProfilePayload(source, payload, collectedAt);
  }
  if (isSub2ApiModelPlazaSource(source)) {
    return parseSub2ApiModelPlazaPayload(source, payload, collectedAt);
  }
  if (isApinodePublicSiteInfoSource(source)) {
    return parseApinodePublicSiteInfoPayload(source, payload, collectedAt);
  }
  if (isZivvModelHubSource(source)) {
    return parseZivvModelHubPayload(source, payload, collectedAt);
  }
  if (isAiTransitSnapshotSource(source)) {
    return parseAiTransitSnapshotPayload(source, payload, collectedAt);
  }

  const items = normalizePricingItems(payload);
  const groupRatioState = normalizeGroupRatios(payload);
  const selected = [];

  for (const item of items) {
    const standard = standardizeModelName(item.model_name || item.name || "");
    if (!standard) continue;

    const groups = normalizeItemGroups(item, groupRatioState);
    for (const group of groups) {
      const offer = buildOfferRow(source, item, group, standard, collectedAt);
      if (offer) selected.push(offer);
    }
  }

  const deduped = dedupeBestOffers(selected);
  return {
    modelCount: items.length,
    collectionError: null,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? "success" : "partial",
      offerCount: deduped.length,
    }),
    offers: deduped,
  };
}

function parseOneHopPublicModelsPayload(source, payload, collectedAt) {
  const items = normalizeOneHopPublicModels(payload);
  const selected = [];

  for (const item of items) {
    const standard = standardizeModelName(
      [
        item?.fullSlug,
        item?.modelSlug,
        item?.upstreamModelId,
        item?.displayName,
      ].filter(Boolean).join(" "),
    );
    if (!standard) continue;

    const offer = buildOneHopPublicModelOfferRow(source, item, standard, collectedAt);
    if (offer) selected.push(offer);
  }

  const deduped = dedupeBestOffers(selected);
  return {
    modelCount: items.length,
    collectionError: null,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? "success" : "partial",
      offerCount: deduped.length,
      availability: summarizeOneHopStationAvailability(deduped, collectedAt),
    }),
    offers: deduped,
  };
}

function parseSub2ApiModelPlazaPayload(source, payload, collectedAt) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const offers = [];
  let modelCount = 0;

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const models = Array.isArray(group.models) ? group.models : [];
    modelCount += models.length;

    for (const model of models) {
      const standard = standardizeModelName([model?.name, model?.platform, group?.platform].filter(Boolean).join(" "));
      if (!standard) continue;
      const offer = buildSub2ApiModelPlazaOfferRow(source, group, model, standard, collectedAt);
      if (offer) offers.push(offer);
    }
  }

  const deduped = dedupeBestOffers(offers);
  const collectionError = deduped.length
    ? null
    : "Sub2API 模型广场未返回可识别的 PriceAI 标准模型倍率。";
  return {
    modelCount,
    collectionError,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? "success" : "partial",
      offerCount: deduped.length,
      collectionError,
      availability: {
        rate: null,
        samples: 0,
        firstCheckedAt: null,
        lastCheckedAt: collectedAt,
        note: "Sub2API 公开模型广场价格已抓取；尚未使用 PriceAI API Key 验证真实扣费和可用性。",
        ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicModelCatalog),
      },
    }),
    offers: deduped,
  };
}

function parseSub2ApiPublicProfilePayload(source, payload, collectedAt) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : null;
  if (!data) {
    return {
      modelCount: 0,
      collectionError: "Sub2API 公开设置接口没有返回有效 data。",
      station: buildStationRow(source, collectedAt, {
        status: "partial",
        offerCount: 0,
        collectionError: "Sub2API 公开设置接口没有返回有效 data。",
      }),
      offers: [],
      profileOnly: false,
    };
  }

  const publicSiteName = stringOrNull(data.site_name);
  const configuredName = stringOrNull(source.name) || source.id;
  const resolvedName = publicSiteName && publicSiteName.toLowerCase() !== "sub2api"
    ? publicSiteName
    : configuredName;
  const registrationEnabled = data.registration_enabled === true;
  const paymentEnabled = data.payment_enabled === true;
  const invitationRequired = data.invitation_code_enabled === true;
  const publicApiBaseUrl = stringOrNull(data.api_base_url);
  const apiBaseUrl = publicApiBaseUrl && /^https?:\/\//i.test(publicApiBaseUrl)
    ? publicApiBaseUrl
    : source.apiBaseUrl;
  const registrationText = registrationEnabled
    ? invitationRequired ? "开放邀请制注册" : "开放公开注册"
    : "当前关闭公开注册";
  const paymentText = paymentEnabled ? "公开设置显示站内支付已启用" : "公开设置未启用站内支付";
  const version = stringOrNull(data.version);
  const profileSource = {
    ...source,
    name: resolvedName,
    apiBaseUrl,
    summary:
      source.summary ||
      `${resolvedName} 使用 Sub2API，公开站点资料接口在线；${registrationText}，${paymentText}。当前未发现无需登录的结构化价格接口，因此本页独立记录站点资料但不混入其他商家的倍率。`,
    strengths: source.strengths || [
      "公开 /health、/setup/status 和 /api/v1/settings/public 指纹可用于独立识别 Sub2API 实例。",
      registrationEnabled ? "公开设置显示当前可注册。" : "站点仍在线，可持续监测公开注册状态变化。",
    ],
    cautions: source.cautions || [
      registrationEnabled
        ? "开放注册不代表 PriceAI 已验证真实扣费、退款或售后能力。"
        : "当前关闭公开注册，可能是私用、内部部署或暂停营业，不应视为可直接购买商家。",
      "暂无公开结构化价格接口，页面不会展示或借用其他中转站的倍率。",
    ],
    adminNote:
      source.adminNote ||
      `公开网络发现；Sub2API 公开设置核验成功，${registrationText}，payment_enabled=${paymentEnabled}${version ? `，version=${version}` : ""}。暂无公开模型广场或 ai-transit 价格快照。`,
  };
  const station = buildStationRow(profileSource, collectedAt, {
    status: "success",
    offerCount: 0,
    availability: {
      rate: null,
      samples: 0,
      firstCheckedAt: null,
      lastCheckedAt: collectedAt,
      note: "Sub2API 公开站点资料接口在线；暂无公开价格和 PriceAI API Key 可用性样本。",
      ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicModelCatalog),
    },
  });

  return {
    modelCount: 0,
    collectionError: null,
    station: {
      ...station,
      usage_advice: registrationEnabled ? station.usage_advice : "pending",
    },
    offers: [],
    profileOnly: true,
  };
}

function buildSub2ApiModelPlazaOfferRow(source, group, model, standard, collectedAt) {
  const groupMultiplier = numberValue(group?.rate_multiplier);
  const pricing = model?.pricing && typeof model.pricing === "object" ? model.pricing : null;
  const billingMode = normalizeBillingMode(pricing?.billing_mode);
  if (groupMultiplier === null || groupMultiplier <= 0 || !pricing || billingMode !== "token") return null;

  const input = sub2ApiModelPlazaMetricRate(pricing.input_price, groupMultiplier);
  const output = sub2ApiModelPlazaMetricRate(pricing.output_price, groupMultiplier);
  const cacheRead = sub2ApiModelPlazaMetricRate(pricing.cache_read_price, groupMultiplier);
  const cacheWrite = sub2ApiModelPlazaMetricRate(pricing.cache_write_price, groupMultiplier);
  const imageOutput = sub2ApiModelPlazaMetricRate(pricing.image_output_price, groupMultiplier);
  if ([input, output, cacheRead, cacheWrite, imageOutput].every((value) => value === null)) return null;

  const groupName = stringOrNull(group?.name) || `group-${group?.id || "default"}`;
  const sourceText = [
    groupName,
    group?.description,
    group?.platform,
    group?.subscription_type,
    model?.platform,
  ].filter(Boolean).join(" ");
  const autoPublish = shouldAutoPublishSource(source);

  return {
    id: stableId("api-transit-offer", source.id, standard, groupName),
    station_id: source.id,
    family: familyForStandardModel(standard),
    standard_model: standard,
    raw_model_name: String(model?.name || standard),
    group_name: groupName,
    recharge_ratio: source.rechargeRatio || DEFAULT_RECHARGE_RATIO,
    billing_mode: "token",
    model_multiplier: round(groupMultiplier, 6),
    input_price: input === null ? null : round(input, 6),
    output_price: output === null ? null : round(output, 6),
    cache_read_price: cacheRead === null ? null : round(cacheRead, 6),
    cache_write_price: cacheWrite === null ? null : round(cacheWrite, 6),
    cache_hit_rate: null,
    cache_hit_sample_tokens: 0,
    image_output_price: imageOutput === null ? null : round(imageOutput, 6),
    fixed_price: null,
    fixed_price_currency: "CNY",
    fixed_price_unit: null,
    fixed_price_tiers: [],
    currency: "CNY",
    account_pool: inferAccountPool(sourceText),
    channel_type: inferChannelType(sourceText),
    price_source: "Sub2API 公开模型广场",
    source_url: source.pricingUrl || source.pricingEndpointUrl,
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_first_checked_at: null,
    availability_last_checked_at: collectedAt,
    availability_note: "Sub2API 公开模型广场价格已抓取；尚未使用 PriceAI API Key 验证真实扣费和可用性。",
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicModelCatalog),
    last_verified_at: collectedAt,
    status: autoPublish ? "active" : "needs_review",
    auto_publish: autoPublish,
    raw_payload: {
      collector_kind: source.collectorKind,
      group: compactSub2ApiModelPlazaGroup(group),
      model: {
        name: stringOrNull(model?.name),
        platform: stringOrNull(model?.platform),
        pricing,
        official_pricing: model?.official_pricing || null,
      },
      multiplier_basis: "sub2api_model_plaza_group_rate_multiplier",
    },
    created_at: collectedAt,
  };
}

function sub2ApiModelPlazaMetricRate(value, groupMultiplier) {
  const price = numberValue(value);
  if (price === null) return null;
  return price === 0 ? 0 : groupMultiplier;
}

function compactSub2ApiModelPlazaGroup(group) {
  return {
    id: numberValue(group?.id),
    name: stringOrNull(group?.name),
    description: stringOrNull(group?.description),
    platform: stringOrNull(group?.platform),
    subscription_type: stringOrNull(group?.subscription_type),
    rate_multiplier: numberValue(group?.rate_multiplier),
    user_rate_multiplier: numberValue(group?.user_rate_multiplier),
    peak_rate_enabled: group?.peak_rate_enabled === true,
    peak_start: stringOrNull(group?.peak_start),
    peak_end: stringOrNull(group?.peak_end),
    peak_rate_multiplier: numberValue(group?.peak_rate_multiplier),
    is_exclusive: group?.is_exclusive === true,
  };
}

function parseApinodePublicSiteInfoPayload(source, payload, collectedAt) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const generatedAt = stringOrNull(data.generated_at) || collectedAt;
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const availabilityByStandard = apinodeAvailabilityByStandard(data.model_availability, generatedAt);
  const rechargeRatio = rechargeRatioFromBilling(data.recharge) || source.rechargeRatio || DEFAULT_RECHARGE_RATIO;
  const offers = [];

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const platform = String(group.platform || "").toLowerCase();
    if (platform && platform !== "openai") continue;

    const groupName = stringOrNull(group.name) || `group-${group.id || "default"}`;
    const groupText = `${groupName} ${group.platform || ""}`;
    if (isApinodeImageGroup(group)) {
      const imageMultiplier = numberValue(group.image_rate_multiplier);
      if (imageMultiplier !== null && imageMultiplier > 0) {
        offers.push(
          buildApinodePublicSiteInfoOfferRow({
            source,
            group,
            standard: "GPT Image 2",
            rawModelName: "gpt-image-2",
            multiplier: imageMultiplier,
            rechargeRatio,
            availability: availabilityByStandard.get("GPT Image 2"),
            generatedAt,
            collectedAt,
          }),
        );
      }
      continue;
    }

    const multiplier = numberValue(group.rate_multiplier);
    if (multiplier === null || multiplier <= 0) continue;

    for (const standard of ["GPT 5.4", "GPT 5.5"]) {
      offers.push(
        buildApinodePublicSiteInfoOfferRow({
          source,
          group: { ...group, inferred_group_text: groupText },
          standard,
          rawModelName: standard === "GPT 5.4" ? "gpt-5.4" : "gpt-5.5",
          multiplier,
          rechargeRatio,
          availability: availabilityByStandard.get(standard),
          generatedAt,
          collectedAt,
        }),
      );
    }
  }

  const deduped = dedupeBestOffers(offers.filter(Boolean));
  const collectionError = deduped.length ? null : "APINode site-info 未返回可识别 OpenAI 分组倍率。";
  return {
    modelCount: availabilityByStandard.size,
    collectionError,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? "success" : "partial",
      offerCount: deduped.length,
      meta: { generated_at: generatedAt },
      collectionError,
      availability: summarizeApinodePublicAvailability(availabilityByStandard, generatedAt),
    }),
    offers: deduped,
  };
}

function parseCallaiPartnerStatusPayload(source, payload, collectedAt) {
  const sections = Array.isArray(payload?.pricing_sections) ? payload.pricing_sections : [];
  const entries = sections.flatMap((section) => {
    const sectionEntries = Array.isArray(section?.entries) ? section.entries : [];
    return sectionEntries.map((entry) => ({ section, entry }));
  });
  const monitoringByKey = new Map(
    (Array.isArray(payload?.monitoring?.latest) ? payload.monitoring.latest : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => [String(item.key || ""), item]),
  );
  const offers = [];

  for (const { section, entry } of entries) {
    const groups = Array.isArray(entry?.groups) ? entry.groups : [];
    const models = Array.isArray(entry?.models) ? entry.models : [];

    for (const model of models) {
      const standard = standardizeModelName(model?.base_model || model?.model || model?.label || "");
      if (!standard) continue;

      for (const group of groups) {
        const offer = buildCallaiPartnerOfferRow({
          source,
          payload,
          section,
          entry,
          group,
          model,
          standard,
          monitoring: monitoringByKey.get(`${section?.key || ""}.${entry?.key || ""}`) || null,
          collectedAt,
        });
        if (offer) offers.push(offer);
      }
    }
  }

  const deduped = dedupeBestOffers(offers);
  const collectionError =
    payload?.meta?.stale === true ? "partner API 快照标记为 stale，已保留价格但需关注刷新状态。" : null;

  return {
    modelCount: entries.reduce((total, { entry }) => total + (Array.isArray(entry?.models) ? entry.models.length : 0), 0),
    collectionError,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? (collectionError ? "partial" : "success") : "partial",
      offerCount: deduped.length,
      site: payload?.site,
      meta: payload?.meta,
      collectionError,
      availability: summarizeCallaiPartnerAvailability(payload?.monitoring?.latest, collectedAt),
    }),
    offers: deduped,
  };
}

function isCallaiPartnerStatusSource(source) {
  return CALLAI_PARTNER_STATUS_COLLECTORS.has(source.collectorKind);
}

function isOneHopPublicModelsSource(source) {
  return ONEHOP_PUBLIC_MODEL_COLLECTORS.has(source.collectorKind);
}

function isSub2ApiModelPlazaSource(source) {
  return SUB2API_MODEL_PLAZA_COLLECTORS.has(source.collectorKind);
}

function isSub2ApiPublicProfileSource(source) {
  return SUB2API_PUBLIC_PROFILE_COLLECTORS.has(source.collectorKind);
}

function isApinodePublicSiteInfoSource(source) {
  return APINODE_PUBLIC_SITE_INFO_COLLECTORS.has(source.collectorKind);
}

function isZivvModelHubSource(source) {
  return ZIVV_MODEL_HUB_COLLECTORS.has(source.collectorKind);
}

function isAiTransitSnapshotSource(source) {
  return AI_TRANSIT_SNAPSHOT_COLLECTORS.has(source.collectorKind);
}

function isNewApiPricingSource(source) {
  return source?.collectorKind === "new_api_pricing";
}

function normalizeOneHopPublicModels(payload) {
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function parseZivvModelHubPayload(source, payload, collectedAt) {
  const items = normalizeZivvModelHubItems(payload);
  const selected = [];
  const skippedFixedPriceModels = [];

  for (const item of items) {
    const rawName = [item?.id, item?.name, item?.model].filter(Boolean).join(" ");
    const standard = standardizeModelName(rawName);
    if (!standard) continue;

    const groups = normalizeZivvGroups(item);
    const countBefore = selected.length;
    for (const group of groups) {
      const offer = buildZivvModelHubOfferRow(source, item, group, standard, collectedAt);
      if (offer) selected.push(offer);
    }
    if (selected.length === countBefore && isZivvFixedPriceQuota(item)) {
      skippedFixedPriceModels.push(String(item?.id || standard));
    }
  }

  const deduped = dedupeBestOffers(selected);
  const collectionError = skippedFixedPriceModels.length
    ? `跳过 ${skippedFixedPriceModels.length} 个固定按次计费模型：${skippedFixedPriceModels.join(", ")}。`
    : null;

  return {
    modelCount: items.length,
    collectionError,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? "success" : "partial",
      offerCount: deduped.length,
      collectionError,
      availability: {
        rate: null,
        samples: 0,
        firstCheckedAt: null,
        lastCheckedAt: null,
        note: "Zivv 公开模型广场价格已抓取；状态页公开存在，但尚未接入 PriceAI API Key 可用性检测。",
        ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
      },
    }),
    offers: deduped,
  };
}

function parseAiTransitSnapshotPayload(source, payload, collectedAt) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const generatedAt = stringOrNull(payload?.generated_at) || collectedAt;
  const rechargeRatio =
    rechargeRatioFromAiTransitBilling(payload?.billing) ||
    source.rechargeRatio ||
    DEFAULT_RECHARGE_RATIO;
  const availabilityIndex = aiTransitAvailabilityByKey(payload, generatedAt, source);
  const offers = [];
  let usedConfiguredGroupModels = false;
  let modelCount = 0;

  for (const group of groups) {
    const rawGroupName = stringOrNull(group?.name) || "default";
    const groupName = normalizeSourceGroupName(source, rawGroupName);
    const groupModels = Array.isArray(group?.models) ? group.models : [];
    const configuredModels = groupModels.length
      ? []
      : configuredAiTransitGroupModels(source, rawGroupName, groupName);
    if (configuredModels.length) usedConfiguredGroupModels = true;
    const models = groupModels.length ? groupModels : configuredModels;
    modelCount += models.length;

    for (const model of models) {
      const standard = standardizeModelName([model?.standard_model, model?.raw_model].filter(Boolean).join(" "));
      if (!standard) continue;

      const offer = buildAiTransitSnapshotOfferRow({
        source,
        payload,
        group,
        model,
        standard,
        rechargeRatio,
        generatedAt,
        collectedAt,
        rawGroupName,
        groupName,
        availability: selectAiTransitAvailabilityForOffer(availabilityIndex, source, {
          groupName,
          rawGroupName,
          standard,
        }),
      });
      if (offer) offers.push(offer);
    }
  }

  const deduped = dedupeBestOffers(offers);
  const availabilitySamples = aiTransitAvailabilitySamples(source, payload, collectedAt);
  applyAiTransitTimelineAvailability(deduped, availabilitySamples);
  const collectionError = deduped.length ? null : "ai-transit 快照未返回可识别的 PriceAI 标准模型。";
  const warnings = Array.isArray(payload?.completeness?.warnings)
    ? payload.completeness.warnings.map(stringOrNull).filter(Boolean)
    : [];
  const blockingWarnings = usedConfiguredGroupModels
    ? warnings.filter((warning) => !/no public model pricing found/i.test(warning))
    : warnings;

  return {
    modelCount,
    collectionError,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? (blockingWarnings.length ? "partial" : "success") : "partial",
      offerCount: deduped.length,
      meta: { generated_at: generatedAt },
      collectionError,
      minimumTopUp: numberValue(payload?.billing?.minimum_top_up),
      availability: summarizeAiTransitSnapshotAvailability(availabilityIndex, availabilitySamples, generatedAt, source, payload),
    }),
    offers: deduped,
    availabilitySamples,
  };
}

function configuredAiTransitGroupModels(source, rawGroupName, groupName) {
  const configured = source?.aiTransitGroupModels;
  if (!configured || typeof configured !== "object") return [];

  const specs = configured[rawGroupName] || configured[groupName];
  if (!Array.isArray(specs)) return [];

  return specs
    .map((spec) => configuredAiTransitGroupModel(spec))
    .filter(Boolean);
}

function configuredAiTransitGroupModel(spec) {
  const standard = typeof spec === "string"
    ? spec
    : stringOrNull(spec?.standardModel || spec?.standard_model || spec?.model);
  if (!standard || !officialTransitPrices[standard]) return null;

  return {
    standard_model: standard,
    raw_model: typeof spec === "object" ? stringOrNull(spec.rawModel || spec.raw_model) || standard : standard,
    price: aiTransitOfficialPricePayload(officialTransitPrices[standard]),
    source: {
      upstream_type: "configured_mapping",
      account_pool_type: "configured_mapping",
      disclosure: "PriceAI mapped this public group multiplier to a known standard model because the station snapshot omitted per-model pricing.",
    },
  };
}

function aiTransitOfficialPricePayload(official) {
  return {
    input_usd_per_token: official.input === null ? null : official.input / 1_000_000,
    output_usd_per_token: official.output === null ? null : official.output / 1_000_000,
    cache_read_usd_per_token: official.cacheRead === null ? null : official.cacheRead / 1_000_000,
    cache_write_usd_per_token: official.cacheWrite === null ? null : official.cacheWrite / 1_000_000,
    image_output_usd_per_token: official.imageOutput ?? null,
  };
}

function buildAiTransitSnapshotOfferRow({
  source,
  payload,
  group,
  model,
  standard,
  rechargeRatio,
  generatedAt,
  collectedAt,
  rawGroupName,
  groupName,
  availability,
}) {
  const family = familyForStandardModel(standard);
  const official = officialTransitPrices[standard];
  const unitPricesUsd = aiTransitUnitPricesUsd(model?.price);
  const fixedPrice = aiTransitFixedPriceInfo(model, rechargeRatio, standard);
  const splitMultipliers = fixedPrice
    ? fixedPriceSplitMultipliers(fixedPrice, "ai_transit_per_request_fixed_price")
    : getAiTransitSnapshotSplitMultipliers(unitPricesUsd, official, group?.rate_multiplier);
  if (
    !splitMultipliers ||
    (!splitMultipliers.isFixedPrice && (splitMultipliers.model === null || splitMultipliers.model <= 0))
  ) {
    return null;
  }

  groupName = stringOrNull(groupName) || normalizeSourceGroupName(source, stringOrNull(group?.name) || "default");
  rawGroupName = stringOrNull(rawGroupName) || stringOrNull(group?.name) || groupName;
  const sourceText = [
    groupName,
    rawGroupName,
    group?.platform,
    group?.subscription_type,
    payload?.disclosure?.upstream_type,
    payload?.disclosure?.account_pool_type,
    model?.source?.upstream_type,
    model?.source?.account_pool_type,
  ].filter(Boolean).join(" ");
  const autoPublish = shouldAutoPublishSource(source);
  const cacheUsage = splitMultipliers.isFixedPrice
    ? { hitRate: null, sampleTokens: 0 }
    : cacheHitUsageFromGroup(group);
  const fallbackAvailability = {
    rate: null,
    samples: 0,
    firstCheckedAt: null,
    lastCheckedAt: generatedAt,
    note: "ai-transit 公开快照已返回价格；该模型暂无公开监测样本，非 PriceAI API Key 实测。",
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicModelCatalog),
  };
  const availabilitySource = availability || fallbackAvailability;

  return {
    id: stableId("api-transit-offer", source.id, standard, groupName),
    station_id: source.id,
    family,
    standard_model: standard,
    raw_model_name: String(model?.raw_model || model?.standard_model || standard),
    group_name: groupName,
    recharge_ratio: rechargeRatio,
    billing_mode: splitMultipliers.billingMode,
    model_multiplier: splitMultipliers.model === null ? null : round(splitMultipliers.model, 6),
    input_price: splitMultipliers.input === null ? null : round(splitMultipliers.input, 6),
    output_price: splitMultipliers.output === null ? null : round(splitMultipliers.output, 6),
    cache_read_price: splitMultipliers.cacheRead === null ? null : round(splitMultipliers.cacheRead, 6),
    cache_write_price: splitMultipliers.cacheWrite === null ? null : round(splitMultipliers.cacheWrite, 6),
    cache_hit_rate: cacheUsage.hitRate,
    cache_hit_sample_tokens: cacheUsage.sampleTokens,
    image_output_price: splitMultipliers.imageOutput === null ? null : round(splitMultipliers.imageOutput, 6),
    fixed_price: splitMultipliers.fixedPrice,
    fixed_price_currency: splitMultipliers.fixedPrice === null ? "CNY" : splitMultipliers.fixedPriceCurrency,
    fixed_price_unit: splitMultipliers.fixedPrice === null ? null : splitMultipliers.fixedPriceUnit,
    fixed_price_tiers: splitMultipliers.fixedPriceTiers,
    currency: "CNY",
    account_pool: aiTransitAccountPool({ payload, model, groupName, rawGroupName, sourceText }),
    channel_type: aiTransitChannelType({ payload, model, sourceText }),
    price_source: "ai-transit 公开快照",
    source_url: source.pricingEndpointUrl,
    availability_seven_day_rate: availabilitySource.rate,
    availability_seven_day_samples: availabilitySource.samples,
    availability_first_checked_at: availabilitySource.firstCheckedAt,
    availability_last_checked_at: availabilitySource.lastCheckedAt,
    availability_latest_latency_ms: availabilitySource.latestLatencyMs ?? null,
    availability_avg_latency_7d_ms: availabilitySource.avgLatency7dMs ?? null,
    availability_note: availabilitySource.note,
    availability_source_type: availabilitySource.availability_source_type || "public_model_catalog",
    availability_source_label: availabilitySource.availability_source_label || "公开模型页",
    availability_source_url: availabilitySource.availability_source_url || source.pricingEndpointUrl,
    availability_scope: availabilitySource.availability_scope || null,
    availability_match_level: availabilitySource.availability_match_level || null,
    monitoring_scope_id: availabilitySource.monitoring_scope_id || null,
    last_verified_at: generatedAt || collectedAt,
    status: autoPublish ? "active" : "needs_review",
    auto_publish: autoPublish,
    raw_payload: {
      collector_kind: source.collectorKind,
      schema_version: stringOrNull(payload?.schema_version),
      snapshot_generated_at: generatedAt,
      system: stringOrNull(payload?.system),
      group: compactAiTransitGroupPayload(group),
      raw_group_name: rawGroupName,
      model,
      billing: payload?.billing || null,
      disclosure: payload?.disclosure || null,
      unit_prices_usd: unitPricesUsd,
      multiplier_basis: splitMultipliers.basis,
      fixed_price: splitMultipliers.fixedPrice,
      fixed_price_tiers: splitMultipliers.fixedPriceTiers,
    },
    created_at: collectedAt,
  };
}

function getAiTransitSnapshotSplitMultipliers(unitPricesUsd, official, groupMultiplierValue) {
  const groupMultiplier = numberValue(groupMultiplierValue) ?? 1;
  if (official && hasComparableOfficialPrice(official)) {
    const input = aiTransitMetricRate(unitPricesUsd.input, official.input, groupMultiplier);
    const output = aiTransitMetricRate(unitPricesUsd.output, official.output, groupMultiplier);
    const cacheRead = aiTransitMetricRate(unitPricesUsd.cacheRead, official.cacheRead, groupMultiplier);
    const cacheWrite = aiTransitMetricRate(unitPricesUsd.cacheWrite, official.cacheWrite, groupMultiplier);
    const imageOutput = aiTransitMetricRate(unitPricesUsd.imageOutput, official.imageOutput, groupMultiplier);
    return {
      model: groupMultiplier,
      input,
      output,
      cacheRead,
      cacheWrite,
      imageOutput,
      billingMode: "token",
      fixedPrice: null,
      fixedPriceCurrency: "CNY",
      fixedPriceUnit: null,
      fixedPriceTiers: [],
      isFixedPrice: false,
      basis: "ai_transit_group_rate_multiplier",
    };
  }

  return {
    model: groupMultiplier,
    input: groupMultiplier,
    output: groupMultiplier,
    cacheRead: null,
    cacheWrite: null,
    imageOutput: null,
    billingMode: "token",
    fixedPrice: null,
    fixedPriceCurrency: "CNY",
    fixedPriceUnit: null,
    fixedPriceTiers: [],
    isFixedPrice: false,
    basis: "ai_transit_group_rate_multiplier",
  };
}

function aiTransitMetricRate(value, officialValue, groupMultiplier) {
  if (value === null || officialValue === null || officialValue <= 0) return null;
  return value === 0 ? 0 : groupMultiplier;
}

function aiTransitUnitPricesUsd(price) {
  const imageSizePrices = price?.image_size_prices && typeof price.image_size_prices === "object" ? price.image_size_prices : {};
  const tokenUnitFactor = 1_000_000;
  return {
    input: multiplyNullable(numberValue(price?.input_usd_per_token), tokenUnitFactor),
    output: multiplyNullable(numberValue(price?.output_usd_per_token), tokenUnitFactor),
    cacheRead: multiplyNullable(numberValue(price?.cache_read_usd_per_token), tokenUnitFactor),
    cacheWrite: multiplyNullable(numberValue(price?.cache_write_usd_per_token), tokenUnitFactor),
    imageOutput: numberValue(price?.image_output_usd_per_token) ?? maxNumber(Object.values(imageSizePrices)),
  };
}

function aiTransitFixedPriceInfo(model, rechargeRatio, standard) {
  if (!fixedPriceMediaStandards.has(standard)) return null;
  const price = model?.price && typeof model.price === "object" ? model.price : {};
  const billingMode = normalizeBillingMode(model?.billing_mode);
  const perRequestCreditPrice = numberValue(
    price.per_request_usd ??
      price.per_request_price ??
      price.per_request ??
      price.fixed_usd ??
      model?.per_request_usd
  );
  const fixedPriceTiers = aiTransitFixedPriceTiers(price, rechargeRatio);
  const primaryPrice = perRequestCreditPrice !== null && perRequestCreditPrice > 0
    ? fixedPriceCnyFromCreditPrice(perRequestCreditPrice, rechargeRatio)
    : minNumber(fixedPriceTiers.map((tier) => tier.price));

  if (primaryPrice === null || primaryPrice <= 0) return null;

  return {
    billingMode: billingMode === "fixed" ? "fixed" : "per_request",
    fixedPrice: roundFixedPrice(primaryPrice),
    fixedPriceCurrency: "CNY",
    fixedPriceUnit: "request",
    fixedPriceTiers,
  };
}

function aiTransitFixedPriceTiers(price, rechargeRatio) {
  return [
    ...imageSizeFixedPriceTiers(price?.image_size_prices, rechargeRatio),
    ...intervalFixedPriceTiers(price?.intervals, rechargeRatio),
  ];
}

function imageSizeFixedPriceTiers(imageSizePrices, rechargeRatio) {
  if (!imageSizePrices || typeof imageSizePrices !== "object") return [];
  return Object.entries(imageSizePrices)
    .map(([label, value]) => fixedPriceTier(label, value, rechargeRatio))
    .filter(Boolean);
}

function intervalFixedPriceTiers(intervals, rechargeRatio) {
  if (!Array.isArray(intervals)) return [];
  return intervals
    .map((interval, index) => {
      if (!interval || typeof interval !== "object") return null;
      const label = stringOrNull(
        interval.label ??
          interval.name ??
          interval.size ??
          interval.resolution ??
          interval.quality ??
          interval.duration
      ) || `档位 ${index + 1}`;
      return fixedPriceTier(
        label,
        interval.per_request_usd ?? interval.per_request_price ?? interval.price_usd ?? interval.price,
        rechargeRatio
      );
    })
    .filter(Boolean);
}

function fixedPriceTier(label, creditPriceValue, rechargeRatio) {
  const creditPrice = numberValue(creditPriceValue);
  if (creditPrice === null || creditPrice <= 0) return null;
  const price = fixedPriceCnyFromCreditPrice(creditPrice, rechargeRatio);
  if (price === null || price <= 0) return null;
  return {
    label: String(label || "默认").trim(),
    price: roundFixedPrice(price),
    unit: "request",
  };
}

function fixedPriceSplitMultipliers(fixedPrice, basis) {
  return {
    model: null,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    imageOutput: null,
    billingMode: fixedPrice.billingMode,
    fixedPrice: fixedPrice.fixedPrice,
    fixedPriceCurrency: fixedPrice.fixedPriceCurrency,
    fixedPriceUnit: fixedPrice.fixedPriceUnit,
    fixedPriceTiers: fixedPrice.fixedPriceTiers,
    isFixedPrice: true,
    unitPricesUsd: null,
    basis,
  };
}

function rechargeRatioFromAiTransitBilling(billing) {
  const directMultiplier = numberValue(billing?.recharge_multiplier ?? billing?.balance_per_cny);
  if (directMultiplier !== null && directMultiplier > 0) return `1:${round(directMultiplier, 6)}`;

  const ratioText = stringOrNull(billing?.recharge_ratio ?? billing?.display_text);
  if (!ratioText) return null;

  const ratioMatch = ratioText.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (ratioMatch) return `${round(Number(ratioMatch[1]), 6)}:${round(Number(ratioMatch[2]), 6)}`;

  const balanceMatch = ratioText.match(
    /(\d+(?:\.\d+)?)\s*(?:CNY|RMB|人民币|元|￥|¥)?\s*=\s*(\d+(?:\.\d+)?)\s*(?:USD\s*)?(?:balance|余额|额度|credit|credits)?/i,
  );
  if (!balanceMatch) return ratioText;

  return `${round(Number(balanceMatch[1]), 6)}:${round(Number(balanceMatch[2]), 6)}`;
}

function multiplyNullable(value, multiplier) {
  return value === null ? null : value * multiplier;
}

function maxNumber(values) {
  const numbers = (values || []).map(numberValue).filter((value) => value !== null);
  return numbers.length ? Math.max(...numbers) : null;
}

function minNumber(values) {
  const numbers = (values || []).map(numberValue).filter((value) => value !== null);
  return numbers.length ? Math.min(...numbers) : null;
}

function compactAiTransitGroupPayload(group) {
  if (!group || typeof group !== "object") return null;
  return {
    name: stringOrNull(group.name),
    platform: stringOrNull(group.platform),
    subscription_type: stringOrNull(group.subscription_type),
    rate_multiplier: numberValue(group.rate_multiplier),
    is_exclusive: group.is_exclusive === undefined ? null : Boolean(group.is_exclusive),
    cache_usage: group.cache_usage || null,
  };
}

function cacheHitUsageFromGroup(group) {
  const usage = selectCacheHitUsageWindow(group?.cache_usage);
  const hitRate = normalizedCacheHitRate(numberValue(usage?.cache_hit_rate));
  const sampleTokens = Math.max(
    0,
    (numberValue(usage?.input_tokens) || 0) +
      (numberValue(usage?.cache_creation_tokens) || 0) +
      (numberValue(usage?.cache_read_tokens) || 0)
  );

  return {
    hitRate,
    sampleTokens: Math.trunc(sampleTokens),
  };
}

function selectCacheHitUsageWindow(cacheUsage) {
  if (!cacheUsage || typeof cacheUsage !== "object") return null;
  const candidates = [
    cacheUsage.last_7d,
    cacheUsage.last7d,
    cacheUsage["7d"],
    cacheUsage.last_24h,
    cacheUsage.last24h,
    cacheUsage["24h"],
    cacheUsage.total,
  ];
  const parsed = candidates
    .filter((candidate) => candidate && typeof candidate === "object")
    .map((candidate) => ({
      candidate,
      hitRate: normalizedCacheHitRate(numberValue(candidate.cache_hit_rate)),
      sampleTokens:
        (numberValue(candidate.input_tokens) || 0) +
        (numberValue(candidate.cache_creation_tokens) || 0) +
        (numberValue(candidate.cache_read_tokens) || 0),
    }));
  return parsed.find((item) => item.hitRate !== null && item.sampleTokens > 0)?.candidate || parsed[0]?.candidate || null;
}

function normalizedCacheHitRate(value) {
  if (value === null || value < 0) return null;
  return value > 1 ? Math.min(round(value / 100, 6), 1) : Math.min(round(value, 6), 1);
}

function aiTransitAvailabilityByKey(payload, generatedAt, source) {
  const index = {
    exact: new Map(),
    group: new Map(),
    model: new Map(),
    family: new Map(),
  };
  for (const item of Array.isArray(payload?.monitoring) ? payload.monitoring : []) {
    const standard = standardizeModelName([item?.primary_model, item?.name].filter(Boolean).join(" "));
    const rawGroupName = stringOrNull(item?.group_name) || stringOrNull(item?.name);
    const groupName = rawGroupName ? normalizeSourceGroupName(source, rawGroupName) : null;
    if (standard) {
      addAiTransitAvailabilityCandidate(index, {
        sourceId: source.id,
        rawGroupName,
        groupName,
        standard,
        availability: aiTransitAvailabilityFromMonitoringItem(item, standard, generatedAt, source),
      });
    }

    for (const model of Array.isArray(item?.models) ? item.models : []) {
      const modelStandard = standardizeModelName(model?.model || "");
      if (!modelStandard) continue;
      const availability = aiTransitAvailabilityFromMonitoringItem({ ...item, ...model }, modelStandard, generatedAt, source);
      addAiTransitAvailabilityCandidate(index, {
        sourceId: source.id,
        rawGroupName,
        groupName,
        standard: modelStandard,
        availability,
      });
    }
  }
  return index;
}

function addAiTransitAvailabilityCandidate(index, { sourceId, rawGroupName, groupName, standard, availability }) {
  if (!availability || !standard) return;
  const family = familyForStandardModel(standard);
  const scope = groupName ? "group" : "model";
  const candidate = {
    id: [
      stringOrNull(groupName) || "*",
      stringOrNull(rawGroupName) || "*",
      standard,
      availability.lastCheckedAt || "",
      availability.rate ?? "",
      availability.samples ?? "",
    ].join("|"),
    groupName: stringOrNull(groupName),
    rawGroupName: stringOrNull(rawGroupName),
    sourceId: stringOrNull(sourceId),
    standard,
    family,
    scope,
    monitoringScopeId: stableId(
      "api-transit-monitoring",
      sourceId,
      scope,
      groupName || "*",
      standard,
    ),
    availability,
  };
  appendAiTransitAvailabilityCandidate(index.exact, aiTransitAvailabilityKey(groupName, standard), candidate);
  if (rawGroupName && rawGroupName !== groupName) {
    appendAiTransitAvailabilityCandidate(index.exact, aiTransitAvailabilityKey(rawGroupName, standard), candidate);
  }
  if (groupName) appendAiTransitAvailabilityCandidate(index.group, groupName, candidate);
  if (rawGroupName && rawGroupName !== groupName) appendAiTransitAvailabilityCandidate(index.group, rawGroupName, candidate);
  appendAiTransitAvailabilityCandidate(index.model, standard, candidate);
  appendAiTransitAvailabilityCandidate(index.family, family, candidate);
}

function appendAiTransitAvailabilityCandidate(map, key, candidate) {
  const normalizedKey = stringOrNull(key);
  if (!normalizedKey) return;
  const candidates = map.get(normalizedKey) || [];
  if (candidates.some((item) => item.id === candidate.id)) return;
  map.set(normalizedKey, [...candidates, candidate]);
}

function selectAiTransitAvailabilityForOffer(index, source, { groupName, rawGroupName, standard }) {
  const exact =
    getAiTransitAvailability(index.exact, aiTransitAvailabilityKey(groupName, standard), "exact", standard) ||
    getAiTransitAvailability(index.exact, aiTransitAvailabilityKey(rawGroupName, standard), "exact", standard);
  if (exact) return exact;

  const group =
    getAiTransitAvailability(index.group, groupName, "group", standard) ||
    getAiTransitAvailability(index.group, rawGroupName, "group", standard);
  if (group) return group;

  if (!source.disableGlobalModelAvailabilityFallback) {
    const model = getAiTransitAvailability(index.model, standard, "model", standard);
    if (model) return model;

    const family = getAiTransitAvailability(index.family, familyForStandardModel(standard), "family", standard);
    if (family) return family;
  }

  return null;
}

function getAiTransitAvailability(map, key, matchLevel, standard) {
  const candidates = map.get(stringOrNull(key) || "");
  if (!candidates?.length) return null;
  return summarizeMatchedAiTransitAvailability(candidates, matchLevel, standard);
}

function summarizeMatchedAiTransitAvailability(candidates, matchLevel, standard) {
  const values = candidates.map((candidate) => candidate.availability).filter(Boolean);
  if (!values.length) return null;
  const rate = weightedAvailabilityValueRate(values);
  const samples = values.reduce((total, value) => total + Math.max(0, integerValue(value.samples) || 0), 0);
  const firstCheckedAt = values.map((item) => item.firstCheckedAt).filter(Boolean).sort().at(0) || null;
  const lastCheckedAt = values.map((item) => item.lastCheckedAt).filter(Boolean).sort().at(-1) || null;
  const latest = [...values]
    .filter((item) => item.latestLatencyMs !== null && item.latestLatencyMs !== undefined && item.lastCheckedAt)
    .sort((left, right) => new Date(right.lastCheckedAt).getTime() - new Date(left.lastCheckedAt).getTime())[0];
  const latestLatencyMs = latest?.latestLatencyMs ?? null;
  const avgLatency7dMs = averageValue(values.map((item) => item.avgLatency7dMs));
  const primary = values[0];
  const sourceId = candidates[0]?.sourceId || "unknown";
  const groupName = candidates[0]?.groupName || candidates[0]?.rawGroupName || null;
  const scope = matchLevel === "exact" || matchLevel === "group"
    ? candidates[0]?.scope || (groupName ? "group" : "model")
    : "model";
  const candidateScopeIds = Array.from(
    new Set(candidates.map((candidate) => candidate.monitoringScopeId).filter(Boolean))
  ).sort();
  const monitoringScopeId = candidateScopeIds.length === 1
    ? candidateScopeIds[0]
    : stableId(
      "api-transit-monitoring-aggregate",
      sourceId,
      matchLevel,
      ...candidateScopeIds,
    );
  return {
    rate,
    samples,
    firstCheckedAt,
    lastCheckedAt,
    latestLatencyMs,
    avgLatency7dMs,
    note: aiTransitAvailabilityMatchNote(candidates, matchLevel, standard, rate, samples),
    availability_source_type: primary.availability_source_type || "public_status",
    availability_source_label: primary.availability_source_label || "公开监测页",
    availability_source_url: primary.availability_source_url || null,
    availability_scope: scope,
    availability_match_level: matchLevel,
    monitoring_scope_id: monitoringScopeId,
  };
}

function aiTransitAvailabilityMatchNote(candidates, matchLevel, standard, rate, samples) {
  const sourceName = candidates[0]?.availability?.availability_source_label || "公开监测页";
  const groups = Array.from(new Set(candidates.map((candidate) => candidate.groupName || candidate.rawGroupName).filter(Boolean)));
  const models = Array.from(new Set(candidates.map((candidate) => candidate.standard).filter(Boolean)));
  const basis =
    matchLevel === "exact" ? "模型与分组精确监测" :
      matchLevel === "group" ? `同分组监测${groups.length ? `（${groups.join(" / ")}）` : ""}` :
        matchLevel === "model" ? `同模型监测${models.length ? `（${models.join(" / ")}）` : ""}` :
          `同模型族参考${models.length ? `（${models.slice(0, 3).join(" / ")}${models.length > 3 ? " 等" : ""}）` : ""}`;
  return `${sourceName} ${basis}：${standard || "模型"} 7 日可用率 ${formatPercentValue(rate)}，样本 ${samples}；非 PriceAI API Key 实测。`;
}

function aiTransitAvailabilityFromMonitoringItem(item, standard, generatedAt, source) {
  const rateValue = numberValue(item?.availability_7d);
  const rate = rateValue === null ? null : percentValueToRate(rateValue);
  const lastCheckedAt = stringOrNull(item?.last_checked_at) || generatedAt;
  const timeline = Array.isArray(item?.timeline) ? recentPublicAvailabilityTimeline(item.timeline) : [];
  const sampleCount = cappedPublicAvailabilitySampleCount(explicitAvailabilitySampleCount(item) ?? timeline.length);
  const firstCheckedAt = earliestTimestampFromValues([
    ...timeline.map((point) => stringOrNull(point?.checked_at)),
    lastCheckedAt,
  ]);
  return {
    rate,
    samples: rate === null ? 0 : Math.max(0, sampleCount),
    firstCheckedAt,
    lastCheckedAt,
    latestLatencyMs: integerValue(item?.latest_latency_ms),
    avgLatency7dMs: integerValue(item?.avg_latency_7d_ms),
    note: `${source.name} ai-transit 公开监测：${standard || "模型"} 最新状态 ${stringOrNull(item?.latest_status || item?.primary_status) || "unknown"}，7 日可用率 ${formatPercentValue(rateValue)}，最近延迟 ${formatLatencyMs(item?.latest_latency_ms)}；非 PriceAI API Key 实测。`,
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
  };
}

function aiTransitAvailabilitySamples(source, payload, collectedAt) {
  const samples = [];
  for (const item of Array.isArray(payload?.monitoring) ? payload.monitoring : []) {
    const rawGroupName = stringOrNull(item?.group_name) || stringOrNull(item?.name);
    const groupName = rawGroupName ? normalizeSourceGroupName(source, rawGroupName) : null;
    const standard = standardizeModelName(item?.primary_model || groupName || "");
    const timeline = Array.isArray(item?.timeline) ? recentPublicAvailabilityTimeline(item.timeline) : [];
    timeline.forEach((point, index) => {
      const sampleInput = {
        stationId: source.id,
        standardModel: standard,
        groupName,
        ok: String(point?.status || "").toLowerCase() === "operational",
        checkedAt: stringOrNull(point?.checked_at) || collectedAt,
        latencyMs: integerValue(point?.latency_ms),
        pingLatencyMs: integerValue(point?.ping_latency_ms),
        index,
        source,
        availabilitySource: AVAILABILITY_SOURCES.publicStatus,
      };
      samples.push(buildAvailabilitySampleRow({
        ...sampleInput,
        scope: "station",
      }));
      if (standard && groupName) {
        samples.push(buildAvailabilitySampleRow({
          ...sampleInput,
          scope: "offer",
        }));
      }
    });
  }
  return samples;
}

function applyAiTransitTimelineAvailability(offers, availabilitySamples) {
  const samplesByOffer = new Map();
  for (const sample of availabilitySamples || []) {
    if (sample.scope !== "offer") continue;
    const key = offerKey({
      station_id: sample.station_id,
      standard_model: sample.standard_model,
      group_name: sample.group_name,
    });
    samplesByOffer.set(key, [...(samplesByOffer.get(key) || []), sample]);
  }

  for (const offer of offers || []) {
    const samples = samplesByOffer.get(offerKey(offer));
    if (!samples?.length) continue;
    const times = samples.map((sample) => stringOrNull(sample.checked_at)).filter(Boolean).sort();
    const okSamples = samples.filter((sample) => sample.ok).length;
    if (!Number.isFinite(offer.availability_seven_day_samples) || offer.availability_seven_day_samples <= 0) {
      offer.availability_seven_day_samples = samples.length;
    }
    offer.availability_first_checked_at = times[0] || offer.availability_first_checked_at;
    offer.availability_last_checked_at = times.at(-1) || offer.availability_last_checked_at;
    offer.availability_latest_latency_ms = offer.availability_latest_latency_ms ?? latestLatencyFromSamples(samples);
    offer.availability_avg_latency_7d_ms = offer.availability_avg_latency_7d_ms ?? averageLatencyFromSamples(samples);
    if (offer.availability_seven_day_rate === null || offer.availability_seven_day_rate === undefined) {
      offer.availability_seven_day_rate = round(okSamples / samples.length, 6);
    }
  }
}

function summarizeAiTransitSnapshotAvailability(availabilityIndex, availabilitySamples, generatedAt, source, payload = null) {
  const availabilityValues = uniqueAiTransitAvailabilityValues(availabilityIndex).filter((item) => item.rate !== null);
  const stationSamples = (availabilitySamples || []).filter((sample) => sample.scope !== "offer");
  const summarySamples = stationSamples.length ? stationSamples : (availabilitySamples || []);
  const sampleTimes = summarySamples.map((sample) => stringOrNull(sample.checked_at)).filter(Boolean).sort();
  if (!availabilityValues.length && !summarySamples.length) {
    return {
      rate: null,
      samples: 0,
      firstCheckedAt: null,
      lastCheckedAt: generatedAt,
      note: "ai-transit 快照暂未返回公开监测样本；非 PriceAI API Key 实测。",
      ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicModelCatalog),
    };
  }

  const okSamples = summarySamples.filter((sample) => sample.ok).length;
  const sampleRate = summarySamples.length ? okSamples / summarySamples.length : null;
  const valueRate = weightedAvailabilityValueRate(availabilityValues);
  const monitoringSamples = explicitAiTransitMonitoringSampleCount(payload);
  const availabilityValueSamples = explicitAvailabilityValueSampleCount(availabilityValues);
  return {
    rate: valueRate ?? sampleRate,
    samples: monitoringSamples || cappedPublicAvailabilitySampleCount(summarySamples.length) || availabilityValueSamples || availabilityValues.length,
    firstCheckedAt: sampleTimes[0] || availabilityValues.map((item) => item.firstCheckedAt).filter(Boolean).sort().at(0) || null,
    lastCheckedAt: sampleTimes.at(-1) || availabilityValues.map((item) => item.lastCheckedAt).filter(Boolean).sort().at(-1) || generatedAt,
    latestLatencyMs:
      latestLatencyFromAvailabilityValues(availabilityValues) ??
      latestLatencyFromSamples(summarySamples) ??
      availabilityValues.map((item) => item.latestLatencyMs).filter((value) => value !== null && value !== undefined).at(0) ??
      null,
    avgLatency7dMs: averageValue(availabilityValues.map((item) => item.avgLatency7dMs)) ?? averageLatencyFromSamples(summarySamples),
    note: "ai-transit 公开快照监测汇总；该口径来自站点公开监测，不等同 PriceAI API Key 实测。",
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
  };
}

function uniqueAiTransitAvailabilityValues(availabilityIndex) {
  const values = [];
  const seen = new Set();
  for (const candidates of availabilityIndex?.exact?.values?.() || []) {
    for (const candidate of candidates) {
      const value = candidate.availability;
      const key = candidate.id;
      if (!value || seen.has(key)) continue;
      seen.add(key);
      values.push(value);
    }
  }
  return values;
}

function weightedAvailabilityValueRate(availabilityValues) {
  const values = (availabilityValues || []).filter((item) => item.rate !== null && item.rate !== undefined);
  if (!values.length) return null;
  const totalSamples = values.reduce((total, item) => total + Math.max(1, item.samples || 0), 0);
  if (totalSamples <= 0) return round(values.reduce((sum, item) => sum + item.rate, 0) / values.length, 6);
  return round(values.reduce((sum, item) => sum + item.rate * Math.max(1, item.samples || 0), 0) / totalSamples, 6);
}

function explicitAvailabilityValueSampleCount(availabilityValues) {
  return cappedPublicAvailabilitySampleCount(
    (availabilityValues || []).reduce((total, item) => total + Math.max(0, integerValue(item?.samples) || 0), 0),
  );
}

function explicitAiTransitMonitoringSampleCount(payload) {
  const monitoring = Array.isArray(payload?.monitoring) ? payload.monitoring : [];
  let topLevelSamples = 0;
  let hasTopLevelSamples = false;
  for (const item of monitoring) {
    const samples = explicitAvailabilitySampleCount(item);
    if (samples === null) continue;
    hasTopLevelSamples = true;
    topLevelSamples += Math.max(0, samples);
  }
  if (hasTopLevelSamples) return cappedPublicAvailabilitySampleCount(topLevelSamples);

  return cappedPublicAvailabilitySampleCount(monitoring.reduce((total, item) => {
    const models = Array.isArray(item?.models) ? item.models : [];
    return total + models.reduce((modelTotal, model) => {
      const samples = explicitAvailabilitySampleCount(model);
      return modelTotal + Math.max(0, samples || 0);
    }, 0);
  }, 0));
}

function explicitAvailabilitySampleCount(item) {
  return integerValue(item?.sample_count_7d ?? item?.samples_7d ?? item?.check_count_7d ?? item?.checks_7d);
}

function cappedPublicAvailabilitySampleCount(value) {
  const count = integerValue(value);
  if (count === null || count <= 0) return 0;
  return Math.min(count, MAX_PUBLIC_AVAILABILITY_SAMPLE_COUNT);
}

function recentPublicAvailabilityTimeline(timeline) {
  return [...(timeline || [])]
    .sort((left, right) => {
      const leftParsed = new Date(stringOrNull(left?.checked_at) || 0).getTime();
      const rightParsed = new Date(stringOrNull(right?.checked_at) || 0).getTime();
      const leftTime = Number.isFinite(leftParsed) ? leftParsed : 0;
      const rightTime = Number.isFinite(rightParsed) ? rightParsed : 0;
      return leftTime - rightTime;
    })
    .slice(-MAX_PUBLIC_AVAILABILITY_SAMPLE_COUNT);
}

function latestLatencyFromAvailabilityValues(values) {
  return (values || [])
    .filter((item) => item.latestLatencyMs !== null && item.latestLatencyMs !== undefined && item.lastCheckedAt)
    .sort((left, right) => new Date(right.lastCheckedAt).getTime() - new Date(left.lastCheckedAt).getTime())[0]?.latestLatencyMs ?? null;
}

function latestLatencyFromSamples(samples) {
  return (samples || [])
    .filter((sample) => sample.latency_ms !== null && sample.latency_ms !== undefined && sample.checked_at)
    .sort((left, right) => new Date(right.checked_at).getTime() - new Date(left.checked_at).getTime())[0]?.latency_ms ?? null;
}

function averageLatencyFromSamples(samples) {
  return averageValue((samples || []).map((sample) => sample.latency_ms));
}

function averageValue(values) {
  const numbers = (values || []).map(numberValue).filter((value) => value !== null && Number.isFinite(value));
  if (!numbers.length) return null;
  return Math.round(numbers.reduce((total, value) => total + value, 0) / numbers.length);
}

function earliestTimestampFromValues(values) {
  return values.filter(Boolean).sort().at(0) || null;
}

function aiTransitAvailabilityKey(groupName, standard) {
  return `${stringOrNull(groupName) || "*"}|${stringOrNull(standard) || "*"}`;
}

function normalizeZivvModelHubItems(payload) {
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeZivvGroups(item) {
  const groups = Array.isArray(item?.groups) && item.groups.length ? item.groups : [null];
  return groups.map((group) => {
    const raw = group && typeof group === "object" ? group : {};
    const key = stringOrNull(raw.id) || stringOrNull(raw.name) || "default";
    const name = stringOrNull(raw.name) || "default";
    const multiplier = numberValue(raw.multiplier);
    return {
      key,
      name,
      description: stringOrNull(raw.description),
      multiplier,
      inputRate: numberValue(raw.input_rate ?? item?.input_rate),
      outputRate: numberValue(raw.output_rate ?? item?.output_rate),
      cacheReadRate: numberValue(raw.cache_read_rate ?? item?.cache_read_rate),
      cacheWriteRate: numberValue(raw.cache_write_rate ?? item?.cache_write_rate),
      fixedPrice: zivvResolvedGroupFixedPrice(raw, item, multiplier, "fixed_price"),
      imageRate1k: zivvResolvedGroupFixedPrice(raw, item, multiplier, "image_rate_1k"),
      imageRate2k: zivvResolvedGroupFixedPrice(raw, item, multiplier, "image_rate_2k"),
      imageRate4k: zivvResolvedGroupFixedPrice(raw, item, multiplier, "image_rate_4k"),
      videoRate720p: zivvResolvedGroupFixedPrice(raw, item, multiplier, "video_rate_720p"),
      videoRate1080p: zivvResolvedGroupFixedPrice(raw, item, multiplier, "video_rate_1080p"),
    };
  });
}

function zivvResolvedGroupFixedPrice(group, item, multiplier, field) {
  const groupValue = numberValue(group?.[field]);
  if (groupValue !== null) return groupValue;
  const itemValue = numberValue(item?.[field]);
  if (itemValue === null) return null;
  return multiplier !== null && multiplier > 0 ? itemValue * multiplier : itemValue;
}

function isZivvFixedPriceQuota(item) {
  const quotaType = numberValue(item?.quota_type);
  return quotaType === 2 || quotaType === 5;
}

function buildZivvModelHubOfferRow(source, item, group, standard, collectedAt) {
  const family = familyForStandardModel(standard);
  const official = officialTransitPrices[standard];
  if (!official) return null;
  const rechargeRatio = source.rechargeRatio || DEFAULT_RECHARGE_RATIO;
  const fixedPrice = zivvFixedPriceInfo(group, standard, rechargeRatio);

  const unitPricesUsd = {
    input: group.inputRate,
    output: group.outputRate,
    cacheRead: group.cacheReadRate,
    cacheWrite: group.cacheWriteRate,
    imageOutput: null,
    fixedPrice: group.fixedPrice,
    imageRate1k: group.imageRate1k,
    imageRate2k: group.imageRate2k,
    imageRate4k: group.imageRate4k,
    videoRate720p: group.videoRate720p,
    videoRate1080p: group.videoRate1080p,
    quotaType: numberValue(item?.quota_type),
  };
  const input = unitRatioValue(unitPricesUsd.input, official.input);
  const output = unitRatioValue(unitPricesUsd.output, official.output);
  const cacheRead = unitRatioValue(unitPricesUsd.cacheRead, official.cacheRead);
  const cacheWrite = unitRatioValue(unitPricesUsd.cacheWrite, official.cacheWrite);
  const splitMultipliers = fixedPrice
    ? fixedPriceSplitMultipliers(fixedPrice, "zivv_public_fixed_price")
    : {
        model: input ?? output ?? cacheRead ?? cacheWrite,
        input,
        output,
        cacheRead,
        cacheWrite,
        imageOutput: null,
        billingMode: "token",
        fixedPrice: null,
        fixedPriceCurrency: "CNY",
        fixedPriceUnit: null,
        fixedPriceTiers: [],
        isFixedPrice: false,
        basis: "zivv_public_usd_per_million",
      };
  if (
    !splitMultipliers.isFixedPrice &&
    input === null &&
    output === null &&
    cacheRead === null &&
    cacheWrite === null
  ) return null;

  const groupName = group.name || group.key || "default";
  const sourceText = [item?.id, item?.provider, groupName, group.description].filter(Boolean).join(" ");
  const autoPublish = shouldAutoPublishSource(source);

  return {
    id: stableId("api-transit-offer", source.id, standard, groupName),
    station_id: source.id,
    family,
    standard_model: standard,
    raw_model_name: String(item?.id || item?.name || standard),
    group_name: groupName,
    recharge_ratio: rechargeRatio,
    billing_mode: splitMultipliers.billingMode,
    model_multiplier: splitMultipliers.model === null ? null : round(splitMultipliers.model, 6),
    input_price: splitMultipliers.input === null ? null : round(splitMultipliers.input, 6),
    output_price: splitMultipliers.output === null ? null : round(splitMultipliers.output, 6),
    cache_read_price: splitMultipliers.cacheRead === null ? null : round(splitMultipliers.cacheRead, 6),
    cache_write_price: splitMultipliers.cacheWrite === null ? null : round(splitMultipliers.cacheWrite, 6),
    image_output_price: null,
    fixed_price: splitMultipliers.fixedPrice,
    fixed_price_currency: splitMultipliers.fixedPrice === null ? "CNY" : splitMultipliers.fixedPriceCurrency,
    fixed_price_unit: splitMultipliers.fixedPrice === null ? null : splitMultipliers.fixedPriceUnit,
    fixed_price_tiers: splitMultipliers.fixedPriceTiers,
    currency: "CNY",
    account_pool: inferAccountPool(sourceText),
    channel_type: inferChannelType(sourceText),
    price_source: "Zivv 公开模型广场",
    source_url: source.pricingUrl || source.pricingEndpointUrl,
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_first_checked_at: null,
    availability_last_checked_at: null,
    availability_note: "价格已抓取，尚未运行 API 可用性检测。",
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.unknown),
    last_verified_at: collectedAt,
    status: autoPublish ? "active" : "needs_review",
    auto_publish: autoPublish,
    raw_payload: {
      collector_kind: source.collectorKind,
      provider: stringOrNull(item?.provider),
      model: compactZivvModelPayload(item),
      group: {
        id: group.key,
        name: groupName,
        description: group.description,
        multiplier: group.multiplier,
      },
      unit_prices_usd: unitPricesUsd,
      fixed_price: splitMultipliers.fixedPrice,
      fixed_price_unit: splitMultipliers.fixedPriceUnit,
      fixed_price_tiers: splitMultipliers.fixedPriceTiers,
      multiplier_basis: splitMultipliers.basis,
    },
    created_at: collectedAt,
  };
}

function zivvFixedPriceInfo(group, standard, rechargeRatio) {
  if (!fixedPriceMediaStandards.has(standard)) return null;
  const tiers = zivvFixedPriceTiers(group, standard, rechargeRatio);
  const directPrice = numberValue(group.fixedPrice);
  const primaryPrice = directPrice !== null && directPrice > 0
    ? fixedPriceCnyFromCreditPrice(directPrice, rechargeRatio)
    : minNumber(tiers.map((tier) => tier.price));
  if (primaryPrice === null || primaryPrice <= 0) return null;

  const family = familyForStandardModel(standard);
  return {
    billingMode: "fixed",
    fixedPrice: roundFixedPrice(primaryPrice),
    fixedPriceCurrency: "CNY",
    fixedPriceUnit: family === "image" ? "image" : "video",
    fixedPriceTiers: tiers,
  };
}

function zivvFixedPriceTiers(group, standard, rechargeRatio) {
  const family = familyForStandardModel(standard);
  const fields = family === "video"
    ? [
        ["720P", group.videoRate720p],
        ["1080P", group.videoRate1080p],
      ]
    : [
        ["1K", group.imageRate1k],
        ["2K", group.imageRate2k],
        ["4K", group.imageRate4k],
      ];
  return fields
    .map(([label, value]) => zivvFixedPriceTier(label, value, rechargeRatio, family === "image" ? "image" : "video"))
    .filter(Boolean);
}

function zivvFixedPriceTier(label, creditPriceValue, rechargeRatio, unit) {
  const creditPrice = numberValue(creditPriceValue);
  if (creditPrice === null || creditPrice <= 0) return null;
  const price = fixedPriceCnyFromCreditPrice(creditPrice, rechargeRatio);
  if (price === null || price <= 0) return null;
  return {
    label,
    price: roundFixedPrice(price),
    unit,
  };
}

function compactZivvModelPayload(item) {
  if (!item || typeof item !== "object") return item || null;
  return {
    id: stringOrNull(item.id),
    provider: stringOrNull(item.provider),
    quota_type: numberValue(item.quota_type),
    input_rate: numberValue(item.input_rate),
    output_rate: numberValue(item.output_rate),
    cache_read_rate: numberValue(item.cache_read_rate),
    cache_write_rate: numberValue(item.cache_write_rate),
    fixed_price: numberValue(item.fixed_price),
    image_rate_1k: numberValue(item.image_rate_1k),
    image_rate_2k: numberValue(item.image_rate_2k),
    image_rate_4k: numberValue(item.image_rate_4k),
    video_rate_720p: numberValue(item.video_rate_720p),
    video_rate_1080p: numberValue(item.video_rate_1080p),
    context_window: stringOrNull(item.context_window),
    capabilities: Array.isArray(item.capabilities) ? item.capabilities.map(stringOrNull).filter(Boolean) : [],
    features: Array.isArray(item.features) ? item.features.map(stringOrNull).filter(Boolean) : [],
  };
}

function applyZivvStatusAvailability(source, parsed, payload, collectedAt) {
  const services = normalizeZivvStatusServices(payload)
    .map((service) => normalizeZivvStatusService(service))
    .filter(Boolean);
  if (!services.length) return;

  const samples = [];
  const offerAvailabilityByKey = new Map();
  const activeOfferKeys = new Set((parsed.offers || []).map((offer) => offerKey(offer)));
  for (const service of services) {
    for (const point of service.history) {
      samples.push(buildAvailabilitySampleRow({
        stationId: source.id,
        scope: "station",
        standardModel: service.standardModel,
        groupName: service.groupName,
        ok: point.ok,
        checkedAt: point.checkedAt,
        index: point.index,
        source,
        availabilitySource: AVAILABILITY_SOURCES.publicStatus,
      }));
    }

    if (!service.standardModel || !service.groupName) continue;
    const key = offerKey({
      station_id: source.id,
      standard_model: service.standardModel,
      group_name: service.groupName,
    });
    if (!activeOfferKeys.has(key)) continue;
    const availability = {
      ...availabilityFromZivvStatusService(service, collectedAt),
      ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
    };
    offerAvailabilityByKey.set(key, availability);
    for (const point of service.history) {
      samples.push(buildAvailabilitySampleRow({
        stationId: source.id,
        scope: "offer",
        standardModel: service.standardModel,
        groupName: service.groupName,
        ok: point.ok,
        checkedAt: point.checkedAt,
        index: point.index,
        source,
        availabilitySource: AVAILABILITY_SOURCES.publicStatus,
      }));
    }
  }

  parsed.availabilitySamples = samples;

  for (const offer of parsed.offers || []) {
    const availability = offerAvailabilityByKey.get(offerKey(offer));
    applyAvailabilityToOffer(offer, availability || emptyZivvPublicStatusAvailability(source, offer));
  }

  const stationAvailability = summarizeZivvStatusAvailability(services, collectedAt);
  if (parsed.station && stationAvailability.samples) {
    Object.assign(parsed.station, {
      availability_seven_day_rate: stationAvailability.rate,
      availability_seven_day_samples: stationAvailability.samples,
      availability_first_checked_at: stationAvailability.firstCheckedAt,
      availability_last_checked_at: stationAvailability.lastCheckedAt,
      availability_note: stationAvailability.note,
      ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
    });
  }
}

function isNewApiPerformanceSummaryPayload(payload) {
  return normalizeNewApiPerformanceSummaryModels(payload).some((model) => {
    const rawName = stringOrNull(model?.model_name) || stringOrNull(model?.model) || stringOrNull(model?.name);
    return Boolean(rawName && percentValueToRate(model?.success_rate ?? model?.successRate) !== null);
  });
}

function applyNewApiPerformanceSummaryAvailability(source, parsed, payload, collectedAt) {
  const availabilityByStandard = new Map();

  for (const model of normalizeNewApiPerformanceSummaryModels(payload)) {
    const rawName = stringOrNull(model?.model_name) || stringOrNull(model?.model) || stringOrNull(model?.name);
    const standard = rawName ? standardizeModelName(rawName) : null;
    if (!standard) continue;

    const availability = newApiPerformanceAvailabilityFromModel(source, model, rawName, standard, collectedAt);
    if (!availability) continue;

    availabilityByStandard.set(standard, availability);
  }

  if (!availabilityByStandard.size) return;

  for (const offer of parsed.offers || []) {
    const availability = availabilityByStandard.get(offer.standard_model);
    if (!availability) continue;
    applyAvailabilityToOffer(offer, availability);
  }

  const stationAvailability = summarizeNewApiPerformanceAvailability(source, availabilityByStandard, collectedAt);
  if (parsed.station && stationAvailability) {
    Object.assign(parsed.station, {
      availability_seven_day_rate: stationAvailability.rate,
      availability_seven_day_samples: stationAvailability.samples,
      availability_first_checked_at: stationAvailability.firstCheckedAt,
      availability_last_checked_at: stationAvailability.lastCheckedAt,
      availability_note: stationAvailability.note,
      availability_source_type: stationAvailability.availability_source_type,
      availability_source_label: stationAvailability.availability_source_label,
      availability_source_url: stationAvailability.availability_source_url,
    });
  }
}

function normalizeNewApiPerformanceSummaryModels(payload) {
  if (Array.isArray(payload?.data?.models)) return payload.data.models;
  if (Array.isArray(payload?.models)) return payload.models;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function newApiPerformanceAvailabilityFromModel(source, model, rawName, standard, collectedAt) {
  const rate = percentValueToRate(model?.success_rate ?? model?.successRate);
  if (rate === null) return null;

  const recentRates = Array.isArray(model?.recent_success_rates)
    ? model.recent_success_rates.map(numberValue).filter((value) => value !== null)
    : [];
  const samples = recentRates.length || 1;
  const latencyMs = numberValue(model?.avg_latency_ms ?? model?.average_latency_ms);
  const tps = numberValue(model?.avg_tps ?? model?.tps);
  const suffix = [
    `成功率 ${formatPercentValue(model?.success_rate ?? model?.successRate)}`,
    latencyMs === null ? null : `平均延迟 ${formatLatencyMs(latencyMs)}`,
    tps === null ? null : `TPS ${formatNumberValue(tps)}`,
  ].filter(Boolean).join("，");

  return {
    rate,
    samples,
    firstCheckedAt: collectedAt,
    lastCheckedAt: collectedAt,
    note: `${source.name} 公开 performance summary 近 24 小时：${rawName}${suffix ? ` ${suffix}` : ""}；非 PriceAI API Key 实测。`,
    raw: model,
    availability_scope: "model",
    availability_match_level: "model",
    monitoring_scope_id: stableId("api-transit-monitoring", source.id, "model", standard),
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
  };
}

function summarizeNewApiPerformanceAvailability(source, availabilityByStandard, collectedAt) {
  const entries = Array.from(availabilityByStandard.values()).filter((availability) => availability.rate !== null);
  const samples = entries.reduce((total, availability) => total + Math.max(availability.samples || 0, 1), 0);
  if (!entries.length || !samples) return null;

  const weightedRate = entries.reduce(
    (total, availability) => total + availability.rate * Math.max(availability.samples || 0, 1),
    0,
  ) / samples;

  return {
    rate: round(weightedRate, 6),
    samples,
    firstCheckedAt: collectedAt,
    lastCheckedAt: collectedAt,
    note: `${source.name} 公开 performance summary 近 24 小时汇总：${entries.length} 个标准模型，${samples} 个近段成功率样本；非 PriceAI API Key 实测。`,
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
  };
}

function normalizeZivvStatusServices(payload) {
  if (Array.isArray(payload?.services)) return payload.services;
  if (Array.isArray(payload?.data?.services)) return payload.data.services;
  return [];
}

function normalizeZivvStatusService(service) {
  if (!service || typeof service !== "object") return null;
  const standardModel = standardizeZivvStatusModel(service?.model);
  const groupName = zivvStatusGroupName(service);
  const history = normalizeZivvStatusHistory(service);
  if (!history.length) return null;
  return {
    name: stringOrNull(service.name),
    model: stringOrNull(service.model),
    type: stringOrNull(service.type),
    standardModel,
    groupName,
    uptimePercent: numberValue(service.uptime_percent),
    checkedAt: stringOrNull(service?.current?.timestamp),
    currentOk: typeof service?.current?.ok === "boolean" ? service.current.ok : null,
    history,
  };
}

function standardizeZivvStatusModel(model) {
  const standard = standardizeModelName(model);
  if (standard) return standard;
  const value = String(model || "").toLowerCase();
  if (value.includes("gemini-3-flash")) return "Gemini 3.5 Flash";
  return null;
}

function zivvStatusGroupName(service) {
  const name = String(service?.name || "").toLowerCase();
  if (name.includes("gemini anti")) return "Gemini Anti";
  if (name.includes("gemini cli")) return "Gemini CLI";
  if (name.includes("claude anti")) return "Claude Anti【目前不稳定】";
  if (name.includes("claude max")) return "Claude MAX";
  if (name.includes("codex plus")) return "Codex Plus";
  if (name.includes("codex pro")) return "Codex Pro";
  return stringOrNull(service?.name);
}

function emptyZivvPublicStatusAvailability(source, offer) {
  return {
    rate: null,
    samples: 0,
    firstCheckedAt: null,
    lastCheckedAt: null,
    note: `Zivv 公开状态页未返回 ${offer.standard_model} / ${offer.group_name} 的服务监测；暂显示样本不足。`,
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
  };
}

function normalizeZivvStatusHistory(service) {
  const history = Array.isArray(service?.history) ? service.history : [];
  return history
    .map((point, index) => ({
      ok: typeof point?.ok === "boolean" ? point.ok : null,
      checkedAt: stringOrNull(point?.timestamp),
      latencyMs: numberValue(point?.latency_ms),
      error: stringOrNull(point?.error),
      statusCode: numberValue(point?.status_code),
      index,
    }))
    .filter((point) => typeof point.ok === "boolean" && point.checkedAt);
}

function availabilityFromZivvStatusService(service, collectedAt) {
  const window = sampleWindowFromPoints(service.history);
  const success = service.history.filter((point) => point.ok).length;
  const rateFromHistory = service.history.length ? success / service.history.length : null;
  const displayRate = numberValue(service.uptimePercent);
  const rate = displayRate === null ? rateFromHistory : displayRate / 100;
  const currentText = service.currentOk === null ? "" : `；当前${service.currentOk ? "正常" : "异常"}`;
  return {
    rate: rate === null ? null : round(rate, 6),
    samples: service.history.length,
    success,
    firstCheckedAt: window.first,
    lastCheckedAt: window.last || service.checkedAt || collectedAt,
    note: `Zivv 公开状态页 7 日服务监测：${service.name || service.groupName || "未命名服务"}，页面 uptime ${displayRate === null ? "未公开" : `${round(displayRate, 2)}%`}，历史点 ${service.history.length} 个${currentText}。`,
    ...availabilitySourceFields(null, AVAILABILITY_SOURCES.publicStatus),
  };
}

function summarizeZivvStatusAvailability(services, collectedAt) {
  const valid = services.filter((service) => service.history.length);
  const samples = valid.reduce((total, service) => total + service.history.length, 0);
  const success = valid.reduce((total, service) => total + service.history.filter((point) => point.ok).length, 0);
  const weightedRate = samples
    ? valid.reduce((total, service) => {
        const availability = availabilityFromZivvStatusService(service, collectedAt);
        return total + (availability.rate ?? 0) * availability.samples;
      }, 0) / samples
    : null;
  const window = sampleWindowFromPoints(valid.flatMap((service) => service.history));
  return {
    rate: weightedRate === null ? null : round(weightedRate, 6),
    samples,
    success,
    firstCheckedAt: window.first,
    lastCheckedAt: window.last || collectedAt,
    note: `Zivv 公开状态页 7 日汇总：${valid.length} 个服务、${samples} 个历史点，按服务页面 uptime 加权汇总；非 PriceAI API Key 实测。`,
    ...availabilitySourceFields(null, AVAILABILITY_SOURCES.publicStatus),
  };
}

function sampleWindowFromPoints(points) {
  const times = (points || []).map((point) => stringOrNull(point?.checkedAt)).filter(Boolean).sort();
  return {
    first: times[0] || null,
    last: times.at(-1) || null,
  };
}

function applyAvailabilityToOffer(offer, availability) {
  offer.availability_seven_day_rate = availability.rate;
  offer.availability_seven_day_samples = availability.samples;
  offer.availability_first_checked_at = availability.firstCheckedAt;
  offer.availability_last_checked_at = availability.lastCheckedAt;
  offer.availability_note = availability.note;
  offer.availability_latest_latency_ms = availability.latestLatencyMs ?? null;
  offer.availability_avg_latency_7d_ms = availability.avgLatency7dMs ?? null;
  offer.availability_source_type = availability.availability_source_type || offer.availability_source_type || "unknown";
  offer.availability_source_label = availability.availability_source_label ?? offer.availability_source_label ?? null;
  offer.availability_source_url = availability.availability_source_url ?? offer.availability_source_url ?? null;
  offer.availability_scope = availability.availability_scope ?? offer.availability_scope ?? null;
  offer.availability_match_level = availability.availability_match_level ?? offer.availability_match_level ?? null;
  offer.monitoring_scope_id = availability.monitoring_scope_id ?? offer.monitoring_scope_id ?? null;
}

function buildAvailabilitySampleRow(input) {
  const stationId = stringOrNull(input.stationId);
  const checkedAt = stringOrNull(input.checkedAt) || new Date().toISOString();
  const standardModel = stringOrNull(input.standardModel) || null;
  const groupName = stringOrNull(input.groupName) || null;
  const scope = input.scope === "offer" ? "offer" : "station";
  const sourceType = input.availabilitySource?.type || "unknown";

  return {
    id: stableId(
      "api-transit-availability-sample",
      stationId,
      scope,
      standardModel || "station",
      groupName || "default",
      sourceType,
      checkedAt,
    ),
    run_id: null,
    station_id: stationId,
    scope,
    standard_model: standardModel,
    group_name: groupName,
    ok: Boolean(input.ok),
    latency_ms: integerValue(input.latencyMs),
    ping_latency_ms: integerValue(input.pingLatencyMs),
    checked_at: checkedAt,
    source_type: sourceType,
    source_label: input.availabilitySource?.label || null,
    source_url: availabilitySourceUrl(input.source, input.availabilitySource),
  };
}

function availabilitySourceFields(source, availabilitySource) {
  const sourceType = availabilitySource?.availability_source_type || availabilitySource?.type || "unknown";
  const sourceLabel = availabilitySource?.availability_source_label ?? availabilitySource?.label ?? null;
  const sourceUrl = availabilitySource?.availability_source_url ?? availabilitySourceUrl(source, availabilitySource);
  return {
    availability_source_type: sourceType,
    availability_source_label: sourceLabel,
    availability_source_url: sourceUrl,
  };
}

function availabilitySourceUrl(source, availabilitySource) {
  if (!source) return null;
  const type = availabilitySource?.sourceType || availabilitySource?.type || "unknown";
  if (type === "public_status") return source.monitorUrl || source.monitorEndpointUrl || source.pricingEndpointUrl || source.pricingUrl || null;
  if (type === "public_model_catalog") return source.pricingUrl || source.pricingEndpointUrl || null;
  if (type === "partner_api") return source.pricingEndpointUrl || source.pricingUrl || null;
  return null;
}

function normalizeSourceGroupName(source, groupName) {
  const name = stringOrNull(groupName) || "default";
  const aliases = source.groupAliases && typeof source.groupAliases === "object" ? source.groupAliases : {};
  return stringOrNull(aliases[name]) || name;
}

function normalizePricingItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  const modelInfo = payload?.data?.model_info || payload?.model_info;
  if (Array.isArray(modelInfo)) return modelInfo;
  if (modelInfo && typeof modelInfo === "object") return Object.values(modelInfo);
  return [];
}

function normalizeGroupRatios(payload) {
  const candidates = [payload?.group_ratio, payload?.data?.group_info, payload?.group_info];
  const raw = candidates.find((value) => value && typeof value === "object" && !Array.isArray(value));
  const groups = new Map();
  if (!raw) return { groups, declared: false };

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") {
      groups.set(key, { name: key, ratio: value, description: null });
    } else if (value && typeof value === "object") {
      groups.set(key, {
        name: String(value.DisplayName || value.display_name || key),
        ratio: numberValue(value.GroupRatio ?? value.group_ratio ?? value.ratio),
        description: value.Description || value.description || null,
      });
    }
  }
  return { groups, declared: true };
}

function normalizeItemGroups(item, groupRatioState) {
  const { groups: groupRatios, declared: groupRatiosDeclared } = groupRatioState;
  if (item.price_info && typeof item.price_info === "object") {
    const groups = [];
    for (const [groupName, groupPayload] of Object.entries(item.price_info)) {
      const defaultPayload = groupPayload?.default && typeof groupPayload.default === "object" ? groupPayload.default : groupPayload;
      const meta = groupRatios.get(groupName) || { name: groupName, ratio: null, description: null };
      groups.push({
        key: groupName,
        name: meta.name || groupName,
        groupRatio: meta.ratio,
        groupRatioMissing: groupRatiosDeclared && (!groupRatios.has(groupName) || meta.ratio === null),
        description: meta.description,
        modelRatio: numberValue(defaultPayload?.model_ratio),
        completionRatio: numberValue(defaultPayload?.model_completion_ratio ?? defaultPayload?.completion_ratio),
        cacheRatio: numberValue(defaultPayload?.model_cache_ratio ?? defaultPayload?.cache_ratio),
        createCacheRatio: numberValue(defaultPayload?.model_create_cache_ratio ?? defaultPayload?.create_cache_ratio),
      });
    }
    return groups;
  }

  const enableGroups = Array.isArray(item.enable_groups) && item.enable_groups.length ? item.enable_groups : ["default"];
  return enableGroups.map((groupName) => {
    const meta = groupRatios.get(groupName) || { name: groupName, ratio: null, description: null };
    return {
      key: groupName,
      name: meta.name || groupName,
      groupRatio: meta.ratio,
      groupRatioMissing: groupRatiosDeclared && (!groupRatios.has(groupName) || meta.ratio === null),
      description: meta.description,
      modelRatio: numberValue(item.model_ratio),
      completionRatio: numberValue(item.completion_ratio),
      cacheRatio: numberValue(item.cache_ratio),
      createCacheRatio: numberValue(item.create_cache_ratio),
    };
  });
}

function buildOneHopPublicModelOfferRow(source, item, standard, collectedAt) {
  const family = familyForStandardModel(standard);
  const official = officialPriceFromOneHopModel(item, standard);
  if (!official) return null;

  const unitPricesUsd = {
    input: numberValue(item?.inputPricePer1m),
    output: numberValue(item?.outputPricePer1m),
    cacheRead: null,
    cacheWrite: null,
    imageOutput: numberValue(item?.imageOutputPricePer1m),
    priorityInput: numberValue(item?.priorityInputPricePer1m),
    priorityOutput: numberValue(item?.priorityOutputPricePer1m),
    officialInput: numberValue(item?.officialInputPricePer1m),
    officialOutput: numberValue(item?.officialOutputPricePer1m),
    officialImageOutput: numberValue(item?.officialImageOutputPricePer1m),
    officialPriorityInput: numberValue(item?.officialPriorityInputPricePer1m),
    officialPriorityOutput: numberValue(item?.officialPriorityOutputPricePer1m),
  };
  const input = unitRatioValue(unitPricesUsd.input, official.input);
  const output = unitRatioValue(unitPricesUsd.output, official.output);
  const imageOutput = unitRatioValue(unitPricesUsd.imageOutput, official.imageOutput);
  if (input === null && output === null && imageOutput === null) return null;
  const officialCurrency = official.currency || "USD";
  const multiplierBasis =
    officialCurrency === "CNY"
      ? "onehop_public_credit_price_against_priceai_cny_official"
      : "onehop_public_usd_per_million";

  const groupName = oneHopGroupName(item);
  const sourceText = [item?.source, item?.fullSlug, item?.provider].filter(Boolean).join(" ");
  const availability = oneHopAvailabilityFromDisplayMetrics(item?.displayMetrics, source.id, standard, collectedAt);
  const autoPublish = shouldAutoPublishSource(source);

  return {
    id: stableId("api-transit-offer", source.id, standard, groupName),
    station_id: source.id,
    family,
    standard_model: standard,
    raw_model_name: String(item?.fullSlug || item?.upstreamModelId || item?.displayName || standard),
    group_name: groupName,
    recharge_ratio: source.rechargeRatio || DEFAULT_RECHARGE_RATIO,
    model_multiplier: round(input ?? output ?? imageOutput, 6),
    input_price: input === null ? null : round(input, 6),
    output_price: output === null ? null : round(output, 6),
    cache_read_price: null,
    cache_write_price: null,
    image_output_price: imageOutput === null ? null : round(imageOutput, 6),
    currency: "CNY",
    account_pool: inferAccountPool(sourceText),
    channel_type: inferOneHopChannelType(item),
    price_source: "OneHop 公开模型目录",
    source_url: source.pricingUrl || source.pricingEndpointUrl,
    availability_seven_day_rate: availability.rate,
    availability_seven_day_samples: availability.samples,
    availability_first_checked_at: availability.firstCheckedAt ?? null,
    availability_last_checked_at: availability.lastCheckedAt,
    availability_note: availability.note,
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicModelCatalog),
    last_verified_at: collectedAt,
    status: autoPublish ? "active" : "needs_review",
    auto_publish: autoPublish,
    raw_payload: {
      collector_kind: source.collectorKind,
      model: compactOneHopModelPayload(item),
      unit_prices_usd: unitPricesUsd,
      official_prices_used: {
        input: official.input ?? null,
        output: official.output ?? null,
        cache_read: official.cacheRead ?? null,
        cache_write: official.cacheWrite ?? null,
        image_output: official.imageOutput ?? null,
        currency: officialCurrency,
      },
      supported_protocols: Array.isArray(item?.supportedProtocolList) ? item.supportedProtocolList : [],
      capabilities: Array.isArray(item?.capabilities) ? item.capabilities : [],
      multiplier_basis: multiplierBasis,
    },
    created_at: collectedAt,
  };
}

function buildApinodePublicSiteInfoOfferRow({
  source,
  group,
  standard,
  rawModelName,
  multiplier,
  rechargeRatio,
  availability,
  generatedAt,
  collectedAt,
}) {
  const family = familyForStandardModel(standard);
  const roundedMultiplier = round(multiplier, 6);
  const groupName = stringOrNull(group?.name) || `group-${group?.id || "default"}`;
  const accountPool = inferAccountPool(`${groupName} ${group?.inferred_group_text || ""}`);
  const channelType = inferChannelType(groupName);
  const isImage = family === "image";
  const autoPublish = shouldAutoPublishSource(source);

  return {
    id: stableId("api-transit-offer", source.id, standard, groupName),
    station_id: source.id,
    family,
    standard_model: standard,
    raw_model_name: rawModelName,
    group_name: groupName,
    recharge_ratio: rechargeRatio,
    model_multiplier: roundedMultiplier,
    input_price: isImage ? null : roundedMultiplier,
    output_price: isImage ? null : roundedMultiplier,
    cache_read_price: null,
    cache_write_price: null,
    image_output_price: isImage ? roundedMultiplier : null,
    currency: "CNY",
    account_pool: accountPool,
    channel_type: channelType,
    price_source: "APINode 公开 site-info",
    source_url: source.pricingEndpointUrl,
    availability_seven_day_rate: availability?.rate ?? null,
    availability_seven_day_samples: availability?.samples ?? 0,
    availability_first_checked_at: availability?.firstCheckedAt ?? null,
    availability_last_checked_at: availability?.lastCheckedAt ?? generatedAt,
    availability_note: apinodeAvailabilityNote(standard, availability),
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.publicStatus),
    last_verified_at: generatedAt || collectedAt,
    status: autoPublish ? "active" : "needs_review",
    auto_publish: autoPublish,
    raw_payload: {
      collector_kind: source.collectorKind,
      snapshot_generated_at: generatedAt,
      group,
      availability: availability?.raw || null,
      recharge_ratio: rechargeRatio,
      multiplier_basis: isImage ? "apinode_image_rate_multiplier" : "apinode_rate_multiplier",
    },
    created_at: collectedAt,
  };
}

function familyForStandardModel(standard) {
  return modelFamilyByStandard[standard] || "gpt";
}

function officialPriceFromOneHopModel(item, standard) {
  const fallback = officialTransitPrices[standard];
  if (!item || typeof item !== "object") return fallback || null;
  if (fallback?.currency === "CNY") return fallback;

  const official = {
    input: numberValue(item.officialInputPricePer1m) ?? fallback?.input ?? null,
    output: numberValue(item.officialOutputPricePer1m) ?? fallback?.output ?? null,
    cacheRead: fallback?.cacheRead ?? null,
    cacheWrite: fallback?.cacheWrite ?? null,
    imageOutput: numberValue(item.officialImageOutputPricePer1m) ?? fallback?.imageOutput ?? null,
    currency: fallback?.currency || "USD",
  };

  return [official.input, official.output, official.cacheRead, official.cacheWrite, official.imageOutput].some(
    (value) => value !== null,
  )
    ? official
    : null;
}

function compactOneHopModelPayload(item) {
  if (!item || typeof item !== "object") return item || null;
  return {
    fullSlug: stringOrNull(item.fullSlug),
    displayName: stringOrNull(item.displayName),
    provider: stringOrNull(item.provider),
    source: stringOrNull(item.source),
    family: stringOrNull(item.family),
    available: item.available === undefined ? null : Boolean(item.available),
    contextWindow: numberValue(item.contextWindow),
    upstreamModelId: stringOrNull(item.upstreamModelId),
    aliases: Array.isArray(item.aliases) ? item.aliases.map(stringOrNull).filter(Boolean) : [],
    inputModalities: Array.isArray(item.inputModalities) ? item.inputModalities.map(stringOrNull).filter(Boolean) : [],
    outputModalities: Array.isArray(item.outputModalities) ? item.outputModalities.map(stringOrNull).filter(Boolean) : [],
    maxOutputTokens: numberValue(item.maxOutputTokens),
    summary: stringOrNull(item.summary),
    displayMetrics: {
      usageTokens: numberValue(item?.displayMetrics?.usageTokens),
      successRate: numberValue(item?.displayMetrics?.successRate),
      uptime14d: Array.isArray(item?.displayMetrics?.uptime14d) ? item.displayMetrics.uptime14d : [],
    },
  };
}

function oneHopGroupName(item) {
  const source = stringOrNull(item?.source);
  if (source && source.toLowerCase() === "official") return "Official";
  if (source && source.toLowerCase() === "kiro") return "Kiro";
  return source || "OneHop";
}

function inferOneHopChannelType(item) {
  const source = String(item?.source || "").toLowerCase();
  const slug = String(item?.fullSlug || "").toLowerCase();
  if (source === "official") return "official_api";
  if (source === "kiro" || slug.includes("kiro")) return "reverse_engineered";
  return "undisclosed";
}

function oneHopAvailabilityFromDisplayMetrics(displayMetrics, sourceId, standard, collectedAt) {
  const uptime14d = Array.isArray(displayMetrics?.uptime14d) ? displayMetrics.uptime14d : [];
  const samples = uptime14d
    .map((point) => ({
      day: stringOrNull(point?.day),
      rate: numberValue(point?.rate),
    }))
    .filter((point) => point.day && point.rate !== null);
  const successRate = numberValue(displayMetrics?.successRate);
  const usageTokens = numberValue(displayMetrics?.usageTokens);
  const sampleDays = samples.map((point) => point.day).sort();
  const earliestDay = sampleDays.at(0);
  const latestDay = sampleDays.at(-1);

  if (!samples.length) {
    return {
      rate: successRate,
      samples: successRate === null ? 0 : 1,
      firstCheckedAt: successRate === null ? null : collectedAt,
      lastCheckedAt: collectedAt,
      note: "OneHop 公开模型目录未返回 14 日 uptime；保留页面 successRate 作为商家公开参考。",
      availability_scope: "model",
      availability_match_level: "model",
      monitoring_scope_id: stableId("api-transit-monitoring", sourceId, "model", standard),
      ...availabilitySourceFields(null, AVAILABILITY_SOURCES.publicModelCatalog),
    };
  }

  const average = samples.reduce((total, point) => total + point.rate, 0) / samples.length;
  const usageNote = usageTokens === null ? "" : `；页面展示使用量 ${Math.round(usageTokens).toLocaleString("en-US")} tokens`;
  return {
    rate: round(average, 6),
    samples: samples.length,
    firstCheckedAt: earliestDay ? `${earliestDay}T00:00:00.000Z` : null,
    lastCheckedAt: latestDay ? `${latestDay}T00:00:00.000Z` : collectedAt,
    note: `OneHop 公开模型目录 uptime14d，按日可用率样本，非 PriceAI API Key 实测${usageNote}。`,
    availability_scope: "model",
    availability_match_level: "model",
    monitoring_scope_id: stableId("api-transit-monitoring", sourceId, "model", standard),
    ...availabilitySourceFields(null, AVAILABILITY_SOURCES.publicModelCatalog),
  };
}

function summarizeOneHopStationAvailability(offers, collectedAt) {
  const rates = offers
    .map((offer) => numberValue(offer.availability_seven_day_rate))
    .filter((value) => value !== null);
  const samples = offers.reduce((total, offer) => total + (numberValue(offer.availability_seven_day_samples) || 0), 0);
  const lastCheckedAt = offers
    .map((offer) => stringOrNull(offer.availability_last_checked_at))
    .filter(Boolean)
    .sort()
    .at(-1);
  const firstCheckedAt = offers
    .map((offer) => stringOrNull(offer.availability_first_checked_at))
    .filter(Boolean)
    .sort()
    .at(0);

  return {
    rate: rates.length ? round(rates.reduce((total, rate) => total + rate, 0) / rates.length, 6) : null,
    samples,
    firstCheckedAt: firstCheckedAt || null,
    lastCheckedAt: lastCheckedAt || collectedAt,
    note: "OneHop 公开模型目录汇总 uptime14d；这些是商家页面公开样本，仍需 PriceAI 测试 Key 复核。",
    ...availabilitySourceFields(null, AVAILABILITY_SOURCES.publicModelCatalog),
  };
}

function apinodeAvailabilityByStandard(modelAvailability, generatedAt) {
  const output = new Map();
  const entries = Array.isArray(modelAvailability) ? modelAvailability : [];
  for (const entry of entries) {
    const models = Array.isArray(entry?.models) ? entry.models : [];
    for (const model of models) {
      const standard = standardizeModelName([model?.model, model?.name, entry?.name].filter(Boolean).join(" "));
      if (!standard) continue;
      const sevenDay = numberValue(model?.availability_7d);
      const fifteenDay = numberValue(model?.availability_15d);
      const thirtyDay = numberValue(model?.availability_30d);
      output.set(standard, {
        standard,
        status: stringOrNull(model?.latest_status) || "unknown",
        rate: percentValueToRate(sevenDay),
        samples: sevenDay === null ? 0 : 1,
        firstCheckedAt: generatedAt,
        lastCheckedAt: generatedAt,
        sevenDay,
        fifteenDay,
        thirtyDay,
        raw: {
          monitor: {
            id: numberValue(entry?.id),
            name: stringOrNull(entry?.name),
            provider: stringOrNull(entry?.provider),
            group_name: stringOrNull(entry?.group_name),
          },
          model,
        },
      });
    }
  }
  return output;
}

function summarizeApinodePublicAvailability(availabilityByStandard, generatedAt) {
  const samples = Array.from(availabilityByStandard.values()).filter((item) => item.rate !== null);
  if (!samples.length) {
    return {
      rate: null,
      samples: 0,
      firstCheckedAt: null,
      lastCheckedAt: generatedAt,
      note: "APINode site-info 暂未返回可识别模型可用率；非 PriceAI API Key 实测。",
      ...AVAILABILITY_SOURCES.publicStatus,
    };
  }

  return {
    rate: round(samples.reduce((total, item) => total + item.rate, 0) / samples.length, 6),
    samples: samples.length,
    firstCheckedAt: samples.map((item) => item.firstCheckedAt).filter(Boolean).sort().at(0) || generatedAt,
    lastCheckedAt: samples.map((item) => item.lastCheckedAt).filter(Boolean).sort().at(-1) || generatedAt,
    note: "APINode 公开 site-info 模型可用率汇总；接口未返回样本明细，非 PriceAI API Key 实测。",
    ...AVAILABILITY_SOURCES.publicStatus,
  };
}

function apinodeAvailabilityNote(standard, availability) {
  if (!availability) return `APINode site-info 未返回 ${standard} 公开可用率；非 PriceAI API Key 实测。`;
  const windows = [
    ["7 日", availability.sevenDay],
    ["15 日", availability.fifteenDay],
    ["30 日", availability.thirtyDay],
  ]
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label} ${formatPercentValue(value)}`);
  const status = availability.status ? `最新状态 ${availability.status}` : "最新状态未知";
  return `APINode 公开 site-info 监测：${status}${windows.length ? `，${windows.join("，")}` : ""}；接口未返回样本明细，非 PriceAI API Key 实测。`;
}

function isApinodeImageGroup(group) {
  const name = String(group?.name || "").toLowerCase();
  return Boolean(group?.allow_image_generation) && (name.includes("image") || name.includes("图像") || name.includes("生图"));
}

function percentValueToRate(value) {
  const number = numberValue(value);
  if (number === null) return null;
  return round(number > 1 ? number / 100 : number, 6);
}

function formatPercentValue(value) {
  const number = numberValue(value);
  if (number === null) return "未知";
  return `${round(number > 1 ? number : number * 100, 2).toFixed(2)}%`;
}

function formatLatencyMs(value) {
  const number = numberValue(value);
  if (number === null) return "未知";
  if (number >= 1000) return `${formatNumberValue(number / 1000)}s`;
  return `${formatNumberValue(number)}ms`;
}

function formatNumberValue(value) {
  const number = numberValue(value);
  if (number === null) return "未知";
  const rounded = round(number, 2);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function buildCallaiPartnerOfferRow({
  source,
  payload,
  section,
  entry,
  group,
  model,
  standard,
  monitoring,
  collectedAt,
}) {
  const family = familyForStandardModel(standard);
  const groupMultiplier = numberValue(group?.rate_multiplier);
  if (groupMultiplier === null || groupMultiplier <= 0) return null;
  if (shouldAutoPublishSource(source) && payload?.meta?.stale === true) return null;

  const basePrice = normalizePartnerBasePrice(model?.base_price);
  const official = officialTransitPrices[standard];
  const splitMultipliers = getPartnerSplitMultipliers(basePrice, official, groupMultiplier);
  if (!splitMultipliers || splitMultipliers.model === null || splitMultipliers.model <= 0) return null;

  const rawGroupName = stringOrNull(group?.name) || stringOrNull(entry?.name) || stringOrNull(entry?.key) || "default";
  const groupKey = normalizeSourceGroupName(source, rawGroupName);
  const checkedAt = stringOrNull(monitoring?.checked_at) || collectedAt;
  const availability = callaiAvailabilityFromMonitoring(monitoring, payload?.meta, collectedAt);
  const autoPublish = shouldAutoPublishSource(source) && payload?.meta?.stale !== true;
  const cacheUsage = cacheHitUsageFromGroup(group);

  return {
    id: stableId("api-transit-offer", source.id, standard, groupKey),
    station_id: source.id,
    family,
    standard_model: standard,
    raw_model_name: String(model?.model || model?.base_model || model?.label || standard),
    group_name: groupKey,
    recharge_ratio: source.rechargeRatio || rechargeRatioFromBilling(payload?.billing) || DEFAULT_RECHARGE_RATIO,
    model_multiplier: round(splitMultipliers.model, 6),
    input_price: splitMultipliers.input === null ? null : round(splitMultipliers.input, 6),
    output_price: splitMultipliers.output === null ? null : round(splitMultipliers.output, 6),
    cache_read_price: splitMultipliers.cacheRead === null ? null : round(splitMultipliers.cacheRead, 6),
    cache_write_price: splitMultipliers.cacheWrite === null ? null : round(splitMultipliers.cacheWrite, 6),
    cache_hit_rate: cacheUsage.hitRate,
    cache_hit_sample_tokens: cacheUsage.sampleTokens,
    image_output_price: splitMultipliers.imageOutput === null ? null : round(splitMultipliers.imageOutput, 6),
    currency: "CNY",
    account_pool: inferAccountPool(`${entry?.key || ""} ${entry?.name || ""} ${group?.name || ""}`),
    channel_type: inferChannelType(`${entry?.platform || ""} ${group?.platform || ""} ${entry?.name || ""}`),
    price_source: "站长 partner API",
    source_url: source.pricingEndpointUrl,
    availability_seven_day_rate: availability.rate,
    availability_seven_day_samples: availability.samples,
    availability_first_checked_at: availability.firstCheckedAt ?? null,
    availability_last_checked_at: checkedAt,
    availability_note: availability.note,
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.partnerApi),
    last_verified_at: checkedAt,
    status: autoPublish ? "active" : "needs_review",
    auto_publish: autoPublish,
    raw_payload: {
      collector_kind: source.collectorKind,
      schema_version: stringOrNull(payload?.meta?.schema_version),
      cache_ttl_seconds: numberValue(payload?.meta?.cache_ttl_seconds),
      snapshot_generated_at: stringOrNull(payload?.meta?.generated_at || payload?.site?.generated_at),
      stale: payload?.meta?.stale === true,
      section: {
        key: stringOrNull(section?.key),
        name: stringOrNull(section?.name),
      },
      entry,
      group,
      raw_group_name: rawGroupName,
      model,
      monitoring,
      billing: payload?.billing || null,
      base_price: basePrice,
      unit_prices_usd: splitMultipliers.unitPricesUsd || null,
      multiplier_basis: splitMultipliers.basis,
    },
    created_at: collectedAt,
  };
}

function getPartnerSplitMultipliers(basePrice, official, groupMultiplier) {
  if (!basePrice || !official) {
    return {
      model: groupMultiplier,
      input: groupMultiplier,
      output: groupMultiplier,
      cacheRead: null,
      cacheWrite: null,
      imageOutput: null,
      unitPricesUsd: null,
      basis: "partner_rate_multiplier",
    };
  }

  const input = partnerRateValue(basePrice.input, official.input, groupMultiplier);
  const output = partnerRateValue(basePrice.output, official.output, groupMultiplier);
  const cacheRead = partnerRateValue(basePrice.cacheRead, official.cacheRead, groupMultiplier);
  const cacheWrite = partnerRateValue(basePrice.cacheWrite, official.cacheWrite, groupMultiplier);
  const imageOutput = partnerRateValue(basePrice.imageOutput, official.imageOutput, groupMultiplier);
  return {
    model: input ?? output ?? cacheRead ?? cacheWrite ?? imageOutput ?? groupMultiplier,
    input,
    output,
    cacheRead,
    cacheWrite,
    imageOutput,
    unitPricesUsd: {
      input: priceWithMultiplier(basePrice.input, groupMultiplier),
      output: priceWithMultiplier(basePrice.output, groupMultiplier),
      cacheRead: priceWithMultiplier(basePrice.cacheRead, groupMultiplier),
      cacheWrite: priceWithMultiplier(basePrice.cacheWrite, groupMultiplier),
      imageOutput: priceWithMultiplier(basePrice.imageOutput, groupMultiplier),
      currency: basePrice.currency,
      unit: basePrice.unit,
    },
    basis: "partner_base_price_multiplier",
  };
}

function partnerRateValue(value, officialValue, groupMultiplier) {
  if (value === null || officialValue === null || officialValue <= 0) return null;
  return (value * groupMultiplier) / officialValue;
}

function priceWithMultiplier(value, multiplier) {
  return value === null ? null : round(value * multiplier, 6);
}

function normalizePartnerBasePrice(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input: numberValue(value.input),
    output: numberValue(value.output),
    cacheRead: numberValue(value.cache_read ?? value.cacheRead),
    cacheWrite: numberValue(value.cache_write ?? value.cacheWrite),
    imageOutput: numberValue(value.image_output ?? value.imageOutput),
    perRequest: numberValue(value.per_request ?? value.perRequest),
    unit: stringOrNull(value.unit),
    currency: stringOrNull(value.currency),
    source: stringOrNull(value.source),
  };
}

function callaiAvailabilityFromMonitoring(monitoring, meta, collectedAt) {
  if (!monitoring || typeof monitoring !== "object") {
    return {
      rate: null,
      samples: 0,
      firstCheckedAt: null,
      lastCheckedAt: null,
      note: "partner API 未返回该分组最近监测结果。",
      ...availabilitySourceFields(null, AVAILABILITY_SOURCES.partnerApi),
    };
  }

  const status = String(monitoring.status || "unknown");
  const checkedAt = stringOrNull(monitoring.checked_at) || collectedAt;
  const staleNote = meta?.stale === true ? "；快照已标记 stale" : "";
  if (status === "operational") {
    return {
      rate: null,
      samples: 0,
      firstCheckedAt: checkedAt,
      lastCheckedAt: checkedAt,
      note: `partner API 最近一次监测正常，非 7 日可用率${staleNote}。`,
      ...availabilitySourceFields(null, AVAILABILITY_SOURCES.partnerApi),
    };
  }
  if (status === "degraded") {
    return {
      rate: null,
      samples: 0,
      firstCheckedAt: checkedAt,
      lastCheckedAt: checkedAt,
      note: `partner API 最近一次监测异常或性能下降，非 7 日可用率${staleNote}。`,
      ...availabilitySourceFields(null, AVAILABILITY_SOURCES.partnerApi),
    };
  }

  return {
    rate: null,
    samples: 0,
    firstCheckedAt: checkedAt,
    lastCheckedAt: checkedAt,
    note: `partner API 最近监测状态为 ${status}，检查时间 ${checkedAt}${staleNote}。`,
    ...availabilitySourceFields(null, AVAILABILITY_SOURCES.partnerApi),
  };
}

function summarizeCallaiPartnerAvailability(latest, collectedAt) {
  const samples = Array.isArray(latest) ? latest.filter((item) => item && typeof item === "object") : [];
  if (!samples.length) {
    return {
      rate: null,
      samples: 0,
      firstCheckedAt: null,
      lastCheckedAt: null,
      note: "partner API 暂无最近监测结果。",
      ...availabilitySourceFields(null, AVAILABILITY_SOURCES.partnerApi),
    };
  }

  const checkedTimes = samples.map((item) => stringOrNull(item.checked_at)).filter(Boolean).sort();
  return {
    rate: null,
    samples: 0,
    firstCheckedAt: checkedTimes[0] || null,
    lastCheckedAt: checkedTimes.at(-1) || collectedAt,
    note: "partner API 最近一次监测汇总，非 7 日可用率。",
    ...availabilitySourceFields(null, AVAILABILITY_SOURCES.partnerApi),
  };
}

function buildStationRow(source, collectedAt, collection = {}) {
  const status = collection.status === "failed" ? "failed" : collection.status === "success" ? "success" : "partial";
  const availability = collection.availability || {};
  const autoPublish = shouldAutoPublishSource(source) && status === "success";
  return {
    id: source.id,
    slug: source.slug || source.id,
    name: source.name,
    website_url: source.websiteUrl,
    api_base_url: source.apiBaseUrl || null,
    pricing_url: source.pricingUrl || source.pricingEndpointUrl,
    monitor_url: source.monitorUrl || null,
    status: status === "failed" ? "unknown" : "active",
    source_type: "manual_collected",
    commercial_relation: source.commercialRelation || "none",
    station_system: normalizeConfiguredValue(source.stationSystem || source.station_system, null),
    operator_type: source.operatorType || source.operator_type || "individual",
    invoice_support: source.invoiceSupport || source.invoice_support || "unknown",
    summary: source.summary || "公开价格接口可读取，已进入 PriceAI API 中转站自动价格采集池；稳定性和扣费检测仍需测试 Key 或人工样本补充。",
    channel_types: source.channelTypes || ["undisclosed"],
    account_pools: source.accountPools || ["undisclosed"],
    payment_methods: source.paymentMethods || [],
    minimum_top_up: collection.minimumTopUp ?? source.minimumTopUp ?? null,
    balance_expiry: source.balanceExpiry || null,
    support_channels: source.supportChannels || [],
    refund_policy: source.refundPolicy || null,
    risk_labels: source.riskLabels || (status === "success" ? ["insufficient_samples"] : ["insufficient_samples", "pending_feedback"]),
    usage_advice: status === "success" ? "try_small" : "pending",
    data_status: autoPublish ? "verified" : "pending_review",
    availability_seven_day_rate: availability.rate ?? null,
    availability_seven_day_samples: availability.samples ?? 0,
    availability_first_checked_at: availability.firstCheckedAt ?? null,
    availability_last_checked_at: availability.lastCheckedAt ?? null,
    availability_latest_latency_ms: availability.latestLatencyMs ?? null,
    availability_avg_latency_7d_ms: availability.avgLatency7dMs ?? null,
    availability_note: availability.note || "已抓取公开价格，尚未接入 API Key 可用性检测。",
    ...availabilitySourceFields(source, availability),
    feedback_pending_count: 0,
    feedback_verified_risk_count: 0,
    feedback_merchant_responded_count: 0,
    feedback_main_themes: [],
    feedback_public_notes: collection.error || null,
    strengths: source.strengths || [],
    cautions: source.cautions || [],
    commercial_offers: source.commercialOffers || [],
    verification_events: source.verificationEvents || [],
    collector_kind: source.collectorKind || "new_api_pricing",
    pricing_endpoint_url: source.pricingEndpointUrl,
    collection_status: status,
    collection_error: collection.error || collection.collectionError || null,
    last_collected_at: collectedAt,
    last_updated_at: stringOrNull(collection?.meta?.generated_at || collection?.site?.generated_at) || collectedAt,
    published: autoPublish,
    auto_publish: autoPublish,
    admin_note: source.adminNote || (
      collection.offerCount
        ? autoPublish
          ? `自动抓取到 ${collection.offerCount} 条 API 中转价格，已按来源快照发布。`
          : `自动抓取到 ${collection.offerCount} 条 MVP 模型价格，待人工审核。`
        : "自动抓取未识别到 MVP 模型，待人工确认。"
    ),
    created_at: collectedAt,
  };
}

function buildOfferRow(source, item, group, standard, collectedAt) {
  const family = familyForStandardModel(standard);
  if (group.groupRatioMissing) return null;
  const groupMultiplier = group.groupRatio ?? 1;
  const rechargeRatio = source.rechargeRatio || DEFAULT_RECHARGE_RATIO;
  const splitMultipliers = getSplitMultipliers(item, group, standard, groupMultiplier, rechargeRatio);
  if (
    !splitMultipliers ||
    (!splitMultipliers.isFixedPrice && (splitMultipliers.model === null || splitMultipliers.model <= 0))
  ) {
    return null;
  }

  return {
    id: stableId("api-transit-offer", source.id, standard, group.key),
    station_id: source.id,
    family,
    standard_model: standard,
    raw_model_name: String(item.model_name || item.name || ""),
    group_name: group.name || group.key || "default",
    recharge_ratio: rechargeRatio,
    billing_mode: splitMultipliers.billingMode || "token",
    model_multiplier: splitMultipliers.model === null ? null : round(splitMultipliers.model, 6),
    input_price: splitMultipliers.input === null ? null : round(splitMultipliers.input, 6),
    output_price: splitMultipliers.output === null ? null : round(splitMultipliers.output, 6),
    cache_read_price: splitMultipliers.cacheRead === null ? null : round(splitMultipliers.cacheRead, 6),
    cache_write_price: splitMultipliers.cacheWrite === null ? null : round(splitMultipliers.cacheWrite, 6),
    image_output_price: splitMultipliers.imageOutput === null ? null : round(splitMultipliers.imageOutput, 6),
    fixed_price: splitMultipliers.fixedPrice,
    fixed_price_currency: splitMultipliers.fixedPrice === null ? "CNY" : splitMultipliers.fixedPriceCurrency,
    fixed_price_unit: splitMultipliers.fixedPrice === null ? null : splitMultipliers.fixedPriceUnit,
    fixed_price_tiers: splitMultipliers.fixedPriceTiers,
    currency: "CNY",
    account_pool: inferAccountPool(`${group.name} ${item.model_name || ""}`),
    channel_type: inferChannelType(`${group.name} ${group.description || ""}`),
    price_source: "公开 /api/pricing",
    source_url: source.pricingEndpointUrl,
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_first_checked_at: null,
    availability_last_checked_at: null,
    availability_note: "价格已抓取，尚未运行 API 可用性检测。",
    ...availabilitySourceFields(source, AVAILABILITY_SOURCES.unknown),
    last_verified_at: collectedAt,
    status: shouldAutoPublishSource(source) ? "active" : "needs_review",
    auto_publish: shouldAutoPublishSource(source),
    raw_payload: {
      model: item,
      group,
      unit_prices_usd: splitMultipliers.unitPricesUsd || null,
      multiplier_basis: splitMultipliers.basis || "unknown",
      fixed_price: splitMultipliers.fixedPrice ?? null,
      fixed_price_source: splitMultipliers.fixedPriceSource ?? null,
      fixed_price_tiers: splitMultipliers.fixedPriceTiers,
    },
    created_at: collectedAt,
  };
}

function getSplitMultipliers(item, group, standard, groupMultiplier, rechargeRatio) {
  const official = officialTransitPrices[standard];
  const fixed = getFixedPriceMultipliers(item, groupMultiplier, standard, rechargeRatio);
  if (fixed) return fixed;

  const billing = parseBillingExpression(item?.billing_expr);
  if (billing && official && hasComparableOfficialPrice(official)) {
    const input = ratioValue(billing.input, official.input, groupMultiplier);
    const output = ratioValue(billing.output, official.output, groupMultiplier);
    const cacheRead = ratioValue(billing.cacheRead, official.cacheRead, groupMultiplier);
    const cacheWrite = ratioValue(billing.cacheWrite, official.cacheWrite, groupMultiplier);
    const imageOutput = ratioValue(billing.imageOutput, official.imageOutput, groupMultiplier);
    return {
      model: input ?? output ?? cacheRead ?? cacheWrite ?? imageOutput,
      input,
      output,
      cacheRead,
      cacheWrite,
      imageOutput,
      billingMode: "token",
      fixedPrice: null,
      fixedPriceCurrency: "CNY",
      fixedPriceUnit: null,
      fixedPriceTiers: [],
      isFixedPrice: false,
    };
  }

  const modelRatio = group.modelRatio;
  if (modelRatio === null || modelRatio <= 0) return null;

  const unitPricesUsd = getNewApiUnitPricesUsd(group, groupMultiplier);
  if (official && hasComparableOfficialPrice(official) && unitPricesUsd.input !== null) {
    const input = unitRatioValue(unitPricesUsd.input, official.input);
    const output = unitRatioValue(unitPricesUsd.output, official.output);
    const cacheRead = unitRatioValue(unitPricesUsd.cacheRead, official.cacheRead);
    const cacheWrite = unitRatioValue(unitPricesUsd.cacheWrite, official.cacheWrite);
    const imageOutput = unitRatioValue(unitPricesUsd.imageOutput, official.imageOutput);
    return {
      model: input ?? output ?? cacheRead ?? cacheWrite ?? imageOutput,
      input,
      output,
      cacheRead,
      cacheWrite,
      imageOutput,
      unitPricesUsd,
      billingMode: "token",
      fixedPrice: null,
      fixedPriceCurrency: "CNY",
      fixedPriceUnit: null,
      fixedPriceTiers: [],
      isFixedPrice: false,
      basis: "new_api_usd_per_million",
    };
  }

  const input = modelRatio * groupMultiplier;
  return {
    model: input,
    input,
    output: group.completionRatio === null ? null : input * group.completionRatio,
    cacheRead: group.cacheRatio === null ? null : input * group.cacheRatio,
    cacheWrite: group.createCacheRatio === null ? null : input * group.createCacheRatio,
    imageOutput: null,
    billingMode: "token",
    fixedPrice: null,
    fixedPriceCurrency: "CNY",
    fixedPriceUnit: null,
    fixedPriceTiers: [],
    isFixedPrice: false,
    unitPricesUsd: null,
    basis: "legacy_multiplier",
  };
}

function ratioValue(value, officialValue, groupMultiplier) {
  if (value === null || officialValue === null || officialValue <= 0) return null;
  return (value * groupMultiplier) / officialValue;
}

function unitRatioValue(value, officialValue) {
  if (value === null || officialValue === null || officialValue <= 0) return null;
  return value / officialValue;
}

function getNewApiUnitPricesUsd(group, groupMultiplier) {
  const input = group.modelRatio * NEW_API_USD_UNIT_PRICE_FACTOR * groupMultiplier;
  return {
    input,
    output: group.completionRatio === null ? null : input * group.completionRatio,
    cacheRead: group.cacheRatio === null ? null : input * group.cacheRatio,
    cacheWrite: group.createCacheRatio === null ? null : input * group.createCacheRatio,
    imageOutput: null,
  };
}

function getFixedPriceMultipliers(item, groupMultiplier, standard, rechargeRatio) {
  const fixedPrice = numberValue(item?.model_price ?? item?.fixed_price);
  if (fixedPrice === null || fixedPrice <= 0) return null;
  if (!fixedPriceMediaStandards.has(standard)) return null;
  const quotaType = numberValue(item?.quota_type ?? item?.quotaType);
  if (quotaType !== null && quotaType !== 1) return null;

  const effectiveCreditPrice = fixedPrice * groupMultiplier;
  const fixedPriceCny = fixedPriceCnyFromCreditPrice(effectiveCreditPrice, rechargeRatio);
  if (fixedPriceCny === null || fixedPriceCny <= 0) return null;

  return {
    model: null,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    imageOutput: null,
    billingMode: "fixed",
    fixedPrice: roundFixedPrice(fixedPriceCny),
    fixedPriceCurrency: "CNY",
    fixedPriceUnit: "request",
    fixedPriceTiers: [],
    isFixedPrice: true,
    unitPricesUsd: null,
    basis: "new_api_fixed_price",
    fixedPriceSource: fixedPrice,
  };
}

function hasComparableOfficialPrice(official) {
  return [official?.input, official?.output, official?.cacheRead, official?.cacheWrite, official?.imageOutput].some(
    (value) => value !== null && Number.isFinite(value) && value > 0,
  );
}

function parseBillingExpression(value) {
  const text = String(value || "");
  if (!text) return null;

  const parsed = {
    input: extractBillingTerm(text, "p"),
    output: extractBillingTerm(text, "c"),
    cacheRead: extractBillingTerm(text, "cr"),
    cacheWrite: extractBillingTerm(text, "cc"),
    cacheWriteOneHour: extractBillingTerm(text, "cc1h"),
    imageOutput: extractBillingTerm(text, "image") ?? extractBillingTerm(text, "img") ?? extractBillingTerm(text, "io"),
  };

  return Object.values(parsed).some((item) => item !== null) ? parsed : null;
}

function extractBillingTerm(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}\\s*\\*\\s*(\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function dedupeBestOffers(offers) {
  const byKey = new Map();
  for (const offer of offers) {
    const key = `${offer.station_id}|${offer.standard_model}|${offer.group_name}`;
    const existing = byKey.get(key);
    const offerSortValue = nullableSortValue(offer.model_multiplier);
    const existingSortValue = nullableSortValue(existing?.model_multiplier);
    if (
      !existing ||
      offerSortValue < existingSortValue ||
      (offerSortValue === existingSortValue && rawModelAliasSpecificity(offer) > rawModelAliasSpecificity(existing))
    ) {
      byKey.set(key, offer);
    }
  }

  return Array.from(byKey.values()).sort((a, b) =>
    a.station_id.localeCompare(b.station_id) ||
    a.standard_model.localeCompare(b.standard_model) ||
    nullableSortValue(a.model_multiplier) - nullableSortValue(b.model_multiplier)
  );
}

function rawModelAliasSpecificity(offer) {
  const standard = String(offer?.standard_model || "");
  const raw = String(offer?.raw_model_name || "").toLowerCase();
  if (standard === "Grok Image") {
    if (raw.includes("image")) return 2;
    if (raw.includes("edit")) return 1;
  }
  if (standard === "Grok Video" && raw.includes("video")) return 2;
  return 0;
}

function standardizeModelName(name) {
  const value = String(name || "").toLowerCase();
  if (!value) return null;

  if (value.includes("gpt-image-2") || value.includes("gpt image 2") || value.includes("gpt_image_2")) {
    return "GPT Image 2";
  }
  if (
    value.includes("grok-imagine-image") ||
    value.includes("grok imagine image") ||
    value.includes("grok-image") ||
    value.includes("grok image")
  ) {
    return "Grok Image";
  }
  if (
    value.includes("gemini-3-pro-image") ||
    value.includes("gemini 3 pro image") ||
    value.includes("gemini-3-pro-image-preview")
  ) {
    return "Nano Banana Pro";
  }
  if (
    value.includes("gemini-3.1-flash-lite-image") ||
    value.includes("gemini-3-1-flash-lite-image") ||
    value.includes("gemini 3.1 flash lite image")
  ) {
    return "Nano Banana Lite";
  }
  if (
    value.includes("gemini-3.1-flash-image") ||
    value.includes("gemini-3-1-flash-image") ||
    value.includes("gemini 3.1 flash image")
  ) {
    return "Nano Banana 2";
  }
  if (
    value.includes("gemini-2.5-flash-image") ||
    value.includes("gemini-2-5-flash-image") ||
    value.includes("gemini 2.5 flash image")
  ) {
    return "Nano Banana";
  }
  if (value.includes("nano-banana-pro") || value.includes("nano banana pro")) return "Nano Banana Pro";
  if (value.includes("nano-banana-lite") || value.includes("nano banana lite")) return "Nano Banana Lite";
  if (value.includes("nano-banana-2") || value.includes("nano banana 2")) return "Nano Banana 2";
  if (value.includes("nano-banana") || value.includes("nano banana")) return "Nano Banana";
  if (value.includes("sora-2-pro") || value.includes("sora 2 pro")) return "Sora 2 Pro";
  if (value.includes("sora-2") || value.includes("sora 2")) return "Sora 2";
  if (
    value.includes("grok-imagine-video") ||
    value.includes("grok imagine video") ||
    value.includes("grok-video") ||
    value.includes("grok video") ||
    value.includes("grok-videos") ||
    value.includes("grok videos")
  ) return "Grok Video";
  if (
    value.includes("grok-imagine") ||
    value.includes("grok imagine")
  ) return "Grok Image";
  if (value.includes("veo-3.1-lite") || value.includes("veo 3.1 lite") || value.includes("veo-3-1-lite")) return "Veo 3.1 Lite";
  if (value.includes("veo-3.1") || value.includes("veo 3.1") || value.includes("veo-3-1")) return "Veo 3.1";
  if (value.includes("gemini-omni-flash") || value.includes("gemini omni flash")) return "Gemini Omni Flash";
  if (
    value.includes("seedance-2.0") ||
    value.includes("seedance 2.0") ||
    value.includes("seedance-2") ||
    value.includes("video-ds-2.0") ||
    value.includes("video-ds-2")
  ) return "Seedance 2.0";
  if (
    value.includes("happyhorse-1.1-i2v") ||
    value.includes("happyhorse-1-1-i2v") ||
    value.includes("happyhorse 1.1 i2v") ||
    value.includes("happy house 1.1 i2v") ||
    value.includes("happyhouse-1.1-i2v") ||
    value.includes("happyhouse-1-1-i2v") ||
    value.includes("hh1.1-i2v") ||
    value.includes("hh1-1-i2v") ||
    value.includes("alibaba/hh1.1-i2v")
  ) return "HappyHorse 1.1 I2V";
  if (value.includes("kling-2.5-turbo") || value.includes("kling 2.5 turbo") || value.includes("kling-2-5-turbo")) return "Kling 2.5 Turbo";

  if (value.includes("claude") && value.includes("fable")) {
    if (hasExplicitModelVersion(value, "fable", "5")) return "Claude Fable 5";
    return null;
  }

  if (value.includes("claude") && value.includes("haiku")) {
    if (hasExplicitModelVersion(value, "haiku", "4.5")) return "Claude Haiku 4.5";
    return null;
  }

  if (value.includes("claude") && value.includes("sonnet")) {
    if (hasExplicitModelVersion(value, "sonnet", "5")) return "Claude Sonnet 5";
    if (hasExplicitModelVersion(value, "sonnet", "4.6")) return "Claude Sonnet 4.6";
    if (hasExplicitModelVersion(value, "sonnet", "4.5")) return "Claude Sonnet 4.5";
    return null;
  }
  if (value.includes("claude") && value.includes("opus")) {
    if (hasExplicitModelVersion(value, "opus", "5")) return "Claude Opus 5";
    if (hasExplicitModelVersion(value, "opus", "4.8")) return "Claude Opus 4.8";
    if (hasExplicitModelVersion(value, "opus", "4.7")) return "Claude Opus 4.7";
    if (hasExplicitModelVersion(value, "opus", "4.6")) return "Claude Opus 4.6";
    if (hasExplicitModelVersion(value, "opus", "4.5")) return "Claude Opus 4.5";
    return null;
  }

  if (value.includes("gpt") || value.includes("codex") || value.includes("openai")) {
    if (value.includes("codex-auto-review") || value.includes("codex-compact") || value.includes("codex compact")) {
      return "Codex Compact";
    }
    if (hasExplicitGptVariant(value, "5.6", "sol")) return "GPT 5.6 Sol";
    if (hasExplicitGptVariant(value, "5.6", "terra")) return "GPT 5.6 Terra";
    if (hasExplicitGptVariant(value, "5.6", "luna")) return "GPT 5.6 Luna";
    if (hasExplicitGptVariant(value, "5.6", "mini") || hasExplicitGptVariant(value, "5.6", "nano")) return null;
    if (hasExplicitGptVersion(value, "5.6")) return "GPT 5.6 Sol";
    if (hasExplicitGptVariant(value, "5.4", "mini")) return "GPT 5.4 Mini";
    if (isExcludedGptVariant(value)) return null;
    if (hasExplicitGptVersion(value, "5.5")) return "GPT 5.5";
    if (hasExplicitGptVersion(value, "5.4")) return "GPT 5.4";
  }

  if (value.includes("grok")) {
    if (value.includes("grok-build") || value.includes("grok build")) return "Grok Build";
    if (value.includes("4.20") || value.includes("4-20") || value.includes("4_20")) return "Grok 4.20";
    if (value.includes("4.3") || value.includes("4-3") || value.includes("4_3")) return "Grok 4.3";
    if (value.includes("4.5") || value.includes("4-5") || value.includes("4_5")) return "Grok 4.5";
  }

  if (value.includes("composer")) {
    if (value.includes("2.5") || value.includes("2-5") || value.includes("2_5")) return "Composer 2.5";
  }

  if (value.includes("gemini")) {
    if (value.includes("3.5") || value.includes("3-5")) {
      if (value.includes("flash")) return "Gemini 3.5 Flash";
    }
    if (value.includes("3.1") || value.includes("3-1")) {
      if (value.includes("pro")) return "Gemini 3.1 Pro";
    }
  }

  if (value.includes("glm") || value.includes("zhipu")) {
    if (value.includes("5.2") || value.includes("5-2")) return "GLM-5.2";
    if (value.includes("5.1") || value.includes("5-1")) return "GLM-5.1";
  }

  if (value.includes("deepseek")) {
    if (value.includes("v4") || value.includes("deepseek-v4")) {
      if (value.includes("flash")) return "DeepSeek V4 Flash";
      if (value.includes("pro")) return "DeepSeek V4 Pro";
    }
  }

  if (value.includes("kimi") || value.includes("moonshot")) {
    if (hasExplicitModelVersion(value, "k", "3") || value.includes("kimi-k3") || value.includes("kimi k3")) {
      return "Kimi K3";
    }
  }

  if (value.includes("qwen") || value.includes("千问")) {
    if (hasExplicitModelVersion(value, "qwen", "3.8") || /千问\s*3[.\-_ ]?8/.test(value)) {
      if (value.includes("max") || value.includes("preview") || value.includes("旗舰")) {
        return "Qwen3.8-Max-Preview";
      }
    }
    if (hasExplicitModelVersion(value, "qwen", "3.7") || /千问\s*3[.\-_ ]?7/.test(value)) {
      if (value.includes("max") || value.includes("旗舰")) return "Qwen3.7-Max";
    }
  }

  return null;
}

function hasExplicitModelVersion(value, family, version) {
  const separator = "[-._ ]?";
  const escapedVersion = version.split(".").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(separator);
  const boundary = "(?:\\b|[-._ ])";
  return new RegExp(`${family}${separator}${escapedVersion}${boundary}`).test(value) ||
    new RegExp(`(?<![0-9][-._ ])${escapedVersion}${separator}${family}${boundary}`).test(value);
}

function hasExplicitGptVersion(value, version) {
  const separator = "[-._ ]?";
  const escapedVersion = version.split(".").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(separator);
  return new RegExp(`(?:\\bgpt|\\bcodex|\\bopenai)${separator}${escapedVersion}(?:\\b|[-._ ])`).test(value);
}

function hasExplicitGptVariant(value, version, variant) {
  const separator = "[-._ ]?";
  const escapedVersion = version.split(".").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(separator);
  const escapedVariant = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\bgpt|\\bcodex|\\bopenai)${separator}${escapedVersion}${separator}${escapedVariant}(?:\\b|[-._ ])`).test(value);
}

function isExcludedGptVariant(value) {
  return /\bgpt[-._ ]?5[-._ ]?[45]?[-._ ]?(mini|nano)\b/.test(value) ||
    /\b(gpt|codex|openai)[-._ ]?5[-._ ]?(mini|nano)\b/.test(value);
}

function inferAccountPool(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("official") || value.includes("官方") || value.includes("官转") || value.includes("官key")) return "official_api";
  if (value.includes("kiro") || value.includes("krio")) return "kiro";
  if (value.includes("max")) return "max";
  if (value.includes("team")) return "team";
  if (value.includes("plus")) return "plus";
  if (value.includes("pro")) return "pro";
  if (value.includes("mixed") || value.includes("混")) return "mixed";
  return "undisclosed";
}

function aiTransitAccountPool({ payload, model, groupName, rawGroupName, sourceText }) {
  const groupPool = inferAccountPool([groupName, rawGroupName].filter(Boolean).join(" "));
  if (groupPool !== "undisclosed") return groupPool;

  return normalizeAiTransitAccountPool(model?.source?.account_pool_type) ||
    normalizeAiTransitAccountPool(payload?.disclosure?.account_pool_type) ||
    inferAccountPool(sourceText);
}

function normalizeAiTransitAccountPool(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (["pro", "plus", "max", "team", "kiro", "enterprise", "mixed", "undisclosed"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "krio") return "kiro";
  if (normalized === "official" || normalized === "official_api") return "official_api";
  return null;
}

function aiTransitChannelType({ payload, model, sourceText }) {
  return normalizeAiTransitChannelType(model?.source?.upstream_type) ||
    normalizeAiTransitChannelType(payload?.disclosure?.upstream_type) ||
    inferChannelType(sourceText);
}

function normalizeAiTransitChannelType(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (
    [
      "official_api",
      "cloud",
      "first_party_pool",
      "reverse_engineered",
      "first_party_wholesale",
      "reseller",
      "mixed",
      "undisclosed",
    ].includes(normalized)
  ) {
    return normalized;
  }
  if (normalized === "official") return "official_api";
  if (normalized === "reverse") return "reverse_engineered";
  return null;
}

function inferChannelType(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("official") || value.includes("官方") || value.includes("官转") || value.includes("官key")) return "official_api";
  if (value.includes("kiro") || value.includes("krio")) return "reverse_engineered";
  if (value.includes("anti") || value.includes("反重力") || value.includes("逆向")) return "reverse_engineered";
  if (value.includes("自有") || value.includes("号池")) return "first_party_pool";
  if (value.includes("aws") || value.includes("azure") || value.includes("vertex") || value.includes("云")) return "cloud";
  if (value.includes("mixed") || value.includes("混")) return "mixed";
  if (value.includes("分销") || value.includes("reseller")) return "reseller";
  return "undisclosed";
}

async function postRows(rows, options) {
  const plan = {
    dryRun: Boolean(options.dryRun),
    stations: rows.stations.length,
    offers: rows.offers.length,
    runs: rows.runs.length,
    availabilitySamples: rows.availabilitySamples?.length || 0,
    publish: Boolean(options.publish),
  };

  if (options.dryRun) {
    return {
      ...plan,
      skipped: true,
      message: "--dry-run --post 只验证将要写入的 API 中转数据，不连接 Supabase。",
    };
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for --post/--db.");

  const autoPublishStationIds = collectSuccessfulAutoPublishStationIds(rows.stations);
  const existingStations = await readExistingStations(supabase, rows.stations.map((station) => station.id));
  const refreshStationIds = collectSuccessfulRefreshStationIds(rows.stations, existingStations, options);
  const refreshedOfferKeys = collectRefreshedOfferKeys(rows.offers, refreshStationIds);
  const stations = rows.stations.map((station) => mergeStationForRefresh(station, existingStations.get(station.id), options));
  const existingOffers = await readExistingOffers(supabase, rows.offers);
  const offers = rows.offers
    .map((offer) =>
      mergeOfferForRefresh(offer, existingOffers.get(offerKey(offer)), refreshStationIds.has(offer.station_id)),
    )
    .map(normalizeApiTransitOfferForWrite);
  const staleOfferIds = findStaleRefreshedOfferIds(existingOffers, refreshedOfferKeys);

  await upsertRows(supabase, "api_transit_stations", stations, { onConflict: "id" });
  await enforceRemovedStationStateAfterUpsert(supabase, stations.map((station) => station.id));
  const offerWriteResult = await upsertOfferRows(supabase, offers);
  await deactivateOffersById(supabase, staleOfferIds);
  await upsertRows(supabase, "api_transit_detection_runs", rows.runs, { onConflict: "id" });
  await upsertRows(supabase, "api_transit_availability_samples", rows.availabilitySamples || [], { onConflict: "id" });
  await deleteSupersededAvailabilitySampleSnapshots(supabase, rows.availabilitySampleSnapshots || []);

  return {
    ...plan,
    compatibility: offerWriteResult.compatibility,
    deactivatedOffers: staleOfferIds.length,
    skipped: false,
    message: postRowsMessage(options, refreshedOfferKeys, autoPublishStationIds),
  };
}

async function enforceRemovedStationStateAfterUpsert(supabase, stationIds) {
  const ids = uniqueText(stationIds).filter(Boolean);
  for (const chunk of chunks(ids, 300)) {
    if (!chunk.length) continue;
    const { error } = await supabase
      .from("api_transit_stations")
      .update({
        published: false,
        status: "unknown",
        data_status: "pending_review",
        usage_advice: "pending",
      })
      .in("id", chunk)
      .not("removed_at", "is", null);
    if (!error) continue;
    if (isMissingColumnError(error, "removed_at")) return;
    error.table = "api_transit_stations";
    throw error;
  }
}

async function deleteSupersededAvailabilitySampleSnapshots(supabase, snapshots) {
  for (const snapshot of snapshots) {
    for (let batch = 0; batch < AVAILABILITY_SNAPSHOT_DELETE_MAX_BATCHES; batch += 1) {
      const { data, error: readError } = await supabase
        .from("api_transit_availability_samples")
        .select("id")
        .eq("station_id", snapshot.stationId)
        .eq("source_type", snapshot.sourceType)
        .neq("run_id", snapshot.runId)
        .order("checked_at", { ascending: false })
        .limit(AVAILABILITY_SNAPSHOT_DELETE_BATCH_SIZE);
      if (readError) {
        readError.table = "api_transit_availability_samples";
        throw readError;
      }

      const ids = (data || []).map((row) => stringOrNull(row?.id)).filter(Boolean);
      if (!ids.length) break;

      const { error: deleteError } = await supabase
        .from("api_transit_availability_samples")
        .delete()
        .in("id", ids)
        .eq("station_id", snapshot.stationId)
        .eq("source_type", snapshot.sourceType)
        .neq("run_id", snapshot.runId);
      if (deleteError) {
        deleteError.table = "api_transit_availability_samples";
        throw deleteError;
      }
    }
  }
}

function collectSuccessfulAutoPublishStationIds(stations) {
  return new Set(
    stations
      .filter((station) => station.auto_publish === true && station.collection_status === "success")
      .map((station) => station.id),
  );
}

function collectSuccessfulRefreshStationIds(stations, existingStations, options) {
  const stationIds = new Set();
  for (const station of stations) {
    if (station.collection_status !== "success") continue;
    const existing = existingStations.get(station.id);
    if (options.publish || station.auto_publish === true || existing?.published === true) {
      stationIds.add(station.id);
    }
  }
  return stationIds;
}

function collectRefreshedOfferKeys(offers, stationIds) {
  const byStation = new Map();
  for (const offer of offers) {
    if (!stationIds.has(offer.station_id)) continue;
    const stationId = String(offer.station_id || "");
    if (!stationId) continue;
    if (!byStation.has(stationId)) byStation.set(stationId, new Set());
    byStation.get(stationId).add(offerKey(offer));
  }
  return byStation;
}

function findStaleRefreshedOfferIds(existingOffers, refreshedOfferKeys) {
  const ids = [];
  for (const existing of existingOffers.values()) {
    const currentKeys = refreshedOfferKeys.get(existing.station_id);
    if (!currentKeys || existing.status !== "active") continue;
    if (!currentKeys.has(offerKey(existing))) ids.push(existing.id);
  }
  return ids;
}

async function deactivateOffersById(supabase, offerIds) {
  for (const chunk of chunks(offerIds, 300)) {
    if (!chunk.length) continue;
    const { error } = await supabase.from("api_transit_offers").update({ status: "inactive" }).in("id", chunk);
    if (error) {
      error.table = "api_transit_offers";
      throw error;
    }
  }
}

async function upsertOfferRows(supabase, offers) {
  const baseAttempts = [
    { rows: offers, compatibility: null },
    {
      rows: removeLatencyFields(offers),
      compatibility: "api_transit_offers latency columns missing; wrote offers without latency summary.",
    },
    {
      rows: removeFieldsFromRows(offers, ["cache_hit_rate", "cache_hit_sample_tokens"]),
      compatibility: "api_transit_offers cache hit columns missing; wrote offers without cumulative cache hit usage.",
    },
    {
      rows: removeFieldsFromRows(offers, ["availability_first_checked_at"]),
      compatibility: "api_transit_offers.availability_first_checked_at column missing; wrote offers without first-check window.",
    },
    {
      rows: removeFieldsFromRows(offers, ["image_output_price"]),
      compatibility: "api_transit_offers.image_output_price column missing; wrote offers without image output split.",
    },
    {
      rows: removeFieldsFromRows(removeLatencyFields(offers), ["availability_first_checked_at", "image_output_price"]),
      compatibility: "api_transit_offers optional columns missing; wrote offers without first-check window and image output split.",
    },
    {
      rows: removeFieldsFromRows(removeLatencyFields(offers), ["availability_first_checked_at", "image_output_price", "cache_hit_rate", "cache_hit_sample_tokens"]),
      compatibility: "api_transit_offers optional columns missing; wrote offers without first-check window, image output split, and cache hit usage.",
    },
    {
      rows: removeAvailabilitySourceFields(removeLatencyFields(offers)),
      compatibility: "api_transit_offers availability source columns missing; wrote offers without source labels.",
    },
    {
      rows: removeFieldsFromRows(removeAvailabilitySourceFields(removeLatencyFields(offers)), ["availability_first_checked_at", "image_output_price"]),
      compatibility: "api_transit_offers optional columns missing; wrote offers without first-check window, image output split, or source labels.",
    },
    {
      rows: removeFieldsFromRows(removeAvailabilitySourceFields(removeLatencyFields(offers)), ["availability_first_checked_at", "image_output_price", "cache_hit_rate", "cache_hit_sample_tokens"]),
      compatibility: "api_transit_offers optional columns missing; wrote offers without first-check window, image output split, source labels, or cache hit usage.",
    },
  ];
  const attempts = withAvailabilityEvidenceOfferWriteFallbacks(withFixedPriceOfferWriteFallbacks(baseAttempts));

  let lastMissingColumnError = null;
  for (const attempt of attempts) {
    try {
      await upsertRows(supabase, "api_transit_offers", attempt.rows, { onConflict: "station_id,standard_model,group_name" });
      return { compatibility: attempt.compatibility };
    } catch (error) {
      if (
        !isMissingColumnError(error, "availability_first_checked_at") &&
        !isMissingColumnError(error, "image_output_price") &&
        !isMissingColumnError(error, "cache_hit_rate") &&
        !isMissingColumnError(error, "cache_hit_sample_tokens") &&
        !isFixedPriceOfferColumnError(error) &&
        !isMissingColumnError(error, "availability_latest_latency_ms") &&
        !isMissingColumnError(error, "availability_avg_latency_7d_ms") &&
        !isAvailabilitySourceColumnError(error) &&
        !isAvailabilityEvidenceColumnError(error)
      ) {
        throw error;
      }
      lastMissingColumnError = error;
    }
  }

  throw lastMissingColumnError;
}

function withFixedPriceOfferWriteFallbacks(attempts) {
  const output = [];
  const seen = new Set();
  for (const attempt of attempts) {
    for (const candidate of [
      attempt,
      {
        rows: removeFixedPriceOfferFields(attempt.rows),
        compatibility: attempt.compatibility || "api_transit_offers fixed price columns missing; wrote offers without fixed-price display fields.",
      },
    ]) {
      const key = Object.keys(candidate.rows[0] || {}).sort().join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(candidate);
    }
  }
  return output;
}

function withAvailabilityEvidenceOfferWriteFallbacks(attempts) {
  const output = [];
  const seen = new Set();
  for (const attempt of attempts) {
    for (const candidate of [
      attempt,
      {
        rows: removeAvailabilityEvidenceFields(attempt.rows),
        compatibility:
          attempt.compatibility ||
          "api_transit_offers availability evidence columns missing; wrote offers without structured scope metadata.",
      },
    ]) {
      const key = Object.keys(candidate.rows[0] || {}).sort().join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(candidate);
    }
  }
  return output;
}

function normalizeApiTransitOfferForWrite(offer) {
  return {
    ...offer,
    billing_mode: offer.billing_mode || "token",
    fixed_price: numberValue(offer.fixed_price),
    fixed_price_currency: offer.fixed_price_currency || "CNY",
    fixed_price_unit: offer.fixed_price_unit || null,
    cache_hit_sample_tokens: Math.max(0, integerValue(offer.cache_hit_sample_tokens) || 0),
    fixed_price_tiers: Array.isArray(offer.fixed_price_tiers) ? offer.fixed_price_tiers : [],
  };
}

function postRowsMessage(options, refreshedOfferKeys, autoPublishStationIds) {
  if (options.publish) return "API 中转公开价格已写入并发布。";
  if (autoPublishStationIds.size) return "API 中转公开价格已写入；自动发布来源已按最新快照同步。";
  if (refreshedOfferKeys.size) return "API 中转公开价格已写入；已发布来源已按最新快照同步。";
  return "API 中转公开价格已写入待审核队列。";
}

async function readExistingOffers(supabase, offers) {
  const stationIds = uniqueText(offers.map((offer) => offer.station_id)).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(stationIds, 100)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_offers")
      .select(
        [
          "id",
          "station_id",
          "standard_model",
          "group_name",
          "status",
          "created_at",
          "availability_source_type",
          "cache_hit_rate",
          "cache_hit_sample_tokens",
          "availability_seven_day_rate",
          "availability_seven_day_samples",
          "availability_first_checked_at",
          "availability_last_checked_at",
          "availability_latest_latency_ms",
          "availability_avg_latency_7d_ms",
          "availability_note",
          "availability_source_label",
          "availability_source_url",
        ].join(","),
      )
      .in("station_id", chunk);
    if (error) {
      if (
        isMissingColumnError(error, "cache_hit_rate") ||
        isMissingColumnError(error, "cache_hit_sample_tokens")
      ) {
        return readExistingOffersWithoutCacheHit(supabase, offers);
      }
      if (isMissingColumnError(error, "availability_first_checked_at")) {
        return readExistingOffersWithoutFirstCheckedAt(supabase, offers);
      }
      if (
        isMissingColumnError(error, "availability_latest_latency_ms") ||
        isMissingColumnError(error, "availability_avg_latency_7d_ms")
      ) {
        return readExistingOffersWithoutLatency(supabase, offers);
      }
      if (isAvailabilitySourceColumnError(error)) {
        return readExistingOffersWithoutOptionalAvailability(supabase, offers);
      }
      throw error;
    }
    for (const row of data || []) byId.set(offerKey(row), row);
  }
  return byId;
}

async function readExistingOffersWithoutCacheHit(supabase, offers) {
  const stationIds = uniqueText(offers.map((offer) => offer.station_id)).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(stationIds, 100)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_offers")
      .select(
        [
          "id",
          "station_id",
          "standard_model",
          "group_name",
          "status",
          "created_at",
          "availability_source_type",
          "availability_seven_day_rate",
          "availability_seven_day_samples",
          "availability_first_checked_at",
          "availability_last_checked_at",
          "availability_latest_latency_ms",
          "availability_avg_latency_7d_ms",
          "availability_note",
          "availability_source_label",
          "availability_source_url",
        ].join(","),
      )
      .in("station_id", chunk);
    if (error) {
      if (isMissingColumnError(error, "availability_first_checked_at")) {
        return readExistingOffersWithoutFirstCheckedAt(supabase, offers);
      }
      if (
        isMissingColumnError(error, "availability_latest_latency_ms") ||
        isMissingColumnError(error, "availability_avg_latency_7d_ms")
      ) {
        return readExistingOffersWithoutLatency(supabase, offers);
      }
      if (isAvailabilitySourceColumnError(error)) {
        return readExistingOffersWithoutOptionalAvailability(supabase, offers);
      }
      throw error;
    }
    for (const row of data || []) byId.set(offerKey(row), row);
  }
  return byId;
}

async function readExistingOffersWithoutLatency(supabase, offers) {
  const stationIds = uniqueText(offers.map((offer) => offer.station_id)).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(stationIds, 100)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_offers")
      .select(
        [
          "id",
          "station_id",
          "standard_model",
          "group_name",
          "status",
          "created_at",
          "availability_source_type",
          "availability_seven_day_rate",
          "availability_seven_day_samples",
          "availability_first_checked_at",
          "availability_last_checked_at",
          "availability_note",
          "availability_source_label",
          "availability_source_url",
        ].join(","),
      )
      .in("station_id", chunk);
    if (error) {
      if (isMissingColumnError(error, "availability_first_checked_at")) {
        return readExistingOffersWithoutFirstCheckedAt(supabase, offers);
      }
      if (isAvailabilitySourceColumnError(error)) {
        return readExistingOffersWithoutOptionalAvailability(supabase, offers);
      }
      throw error;
    }
    for (const row of data || []) byId.set(offerKey(row), row);
  }
  return byId;
}

async function readExistingOffersWithoutFirstCheckedAt(supabase, offers) {
  return readExistingOffersWithoutOptionalAvailability(supabase, offers);
}

async function readExistingOffersWithoutOptionalAvailability(supabase, offers) {
  const stationIds = uniqueText(offers.map((offer) => offer.station_id)).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(stationIds, 100)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_offers")
      .select("id,station_id,standard_model,group_name,status,created_at")
      .in("station_id", chunk);
    if (error) throw error;
    for (const row of data || []) byId.set(offerKey(row), row);
  }
  return byId;
}

function mergeOfferForRefresh(offer, existing, shouldActivate) {
  const row = { ...offer };
  delete row.auto_publish;
  const merged = mergeExistingCacheHit(mergeExistingAvailability({
    ...row,
    id: existing?.id || offer.id,
    status: shouldActivate ? "active" : existing?.status || offer.status,
    created_at: existing?.created_at || offer.created_at,
  }, existing), existing);
  return normalizeUnknownAvailability(merged, "价格已抓取，尚未运行 API 可用性检测。");
}

function shouldAutoPublishSource(source) {
  return source.autoPublish === true || source.auto_publish === true;
}

function offerKey(offer) {
  return [offer.station_id, offer.standard_model, offer.group_name].map((part) => String(part || "")).join("|");
}

async function readExistingStations(supabase, stationIds) {
  return readExistingStationsWithColumns(supabase, stationIds, [
    "id",
    "status",
    "source_type",
    "commercial_relation",
    "station_system",
    "operator_type",
    "invoice_support",
    "channel_types",
    "account_pools",
    "risk_labels",
    "usage_advice",
    "summary",
    "payment_methods",
    "minimum_top_up",
    "balance_expiry",
    "support_channels",
    "refund_policy",
    "data_status",
    "monitor_url",
    "commercial_offers",
    "verification_events",
    "availability_seven_day_rate",
    "availability_seven_day_samples",
    "availability_first_checked_at",
    "availability_last_checked_at",
    "availability_latest_latency_ms",
    "availability_avg_latency_7d_ms",
    "availability_note",
    "availability_source_type",
    "availability_source_label",
    "availability_source_url",
    "published",
    "removed_at",
    "removed_reason",
    "admin_note",
    "created_at",
  ]);
}

async function readExistingStationsWithColumns(supabase, stationIds, columns) {
  const ids = uniqueText(stationIds).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(ids, 300)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_stations")
      .select(columns.join(","))
      .in("id", chunk);
    if (error) {
      const missingColumn = missingExistingStationColumn(error, columns);
      if (missingColumn) {
        return readExistingStationsWithColumns(
          supabase,
          stationIds,
          withoutColumns(columns, ...compatibleExistingStationColumnsToRemove(missingColumn)),
        );
      }
      throw error;
    }
    for (const row of data || []) byId.set(row.id, row);
  }
  return byId;
}

function mergeStationForRefresh(station, existing, options) {
  const { auto_publish: autoPublish, ...row } = station;
  const manuallyRemoved = Boolean(stringOrNull(existing?.removed_at));
  const shouldPublish = !manuallyRemoved && (options.publish || autoPublish);
  const refreshFailed = row.collection_status === "failed";
  if (!existing) {
    return normalizeUnknownAvailability({
      ...row,
      published: Boolean(shouldPublish),
      data_status: shouldPublish ? "verified" : station.data_status,
      admin_note: row.admin_note,
    }, "已抓取公开价格，尚未接入 API Key 可用性检测。");
  }

  return normalizeUnknownAvailability(mergeExistingAvailability({
    ...row,
    status: manuallyRemoved ? existing.status || "unknown" : refreshFailed ? existing.status || station.status : row.status,
    source_type: existing.source_type || station.source_type,
    commercial_relation: existing.commercial_relation || station.commercial_relation,
    station_system: keepConfiguredValue(existing.station_system, station.station_system),
    operator_type: keepConfiguredValue(existing.operator_type, station.operator_type),
    invoice_support: keepConfiguredValue(existing.invoice_support, station.invoice_support),
    channel_types: keepConfiguredList(existing.channel_types, station.channel_types),
    account_pools: keepConfiguredList(existing.account_pools, station.account_pools),
    risk_labels: keepConfiguredList(existing.risk_labels, station.risk_labels),
    summary: shouldReplaceStaleStationSummary(existing.summary, station) ? station.summary : existing.summary || station.summary,
    payment_methods: Array.isArray(existing.payment_methods) ? existing.payment_methods : station.payment_methods,
    minimum_top_up: existing.minimum_top_up ?? station.minimum_top_up,
    balance_expiry: existing.balance_expiry ?? station.balance_expiry,
    support_channels: Array.isArray(existing.support_channels) ? existing.support_channels : station.support_channels,
    refund_policy: existing.refund_policy ?? station.refund_policy,
    usage_advice: manuallyRemoved ? existing.usage_advice || "pending" : row.usage_advice,
    data_status: manuallyRemoved
      ? existing.data_status || "pending_review"
      : refreshFailed ? existing.data_status || station.data_status : shouldPublish ? "verified" : existing.data_status || station.data_status,
    monitor_url: existing.monitor_url ?? station.monitor_url,
    commercial_offers: existing.commercial_offers ?? station.commercial_offers,
    verification_events: existing.verification_events ?? station.verification_events,
    availability_first_checked_at: existing.availability_first_checked_at || station.availability_first_checked_at,
    availability_latest_latency_ms: station.availability_latest_latency_ms ?? existing.availability_latest_latency_ms,
    availability_avg_latency_7d_ms: station.availability_avg_latency_7d_ms ?? existing.availability_avg_latency_7d_ms,
    published: manuallyRemoved ? false : refreshFailed ? Boolean(existing.published) : shouldPublish ? true : Boolean(existing.published),
    admin_note: manuallyRemoved
      ? existing.admin_note || station.admin_note
      : shouldPublish && row.collection_status === "success" ? row.admin_note : existing.admin_note || station.admin_note,
    created_at: existing.created_at || station.created_at,
  }, existing), "已抓取公开价格，尚未接入 API Key 可用性检测。");
}

function mergeExistingAvailability(row, existing) {
  if (!existing) return row;
  const incomingSamples = Math.max(0, integerValue(row.availability_seven_day_samples) || 0);
  const existingSamples = Math.max(0, integerValue(existing.availability_seven_day_samples) || 0);
  if (existingSamples <= 0) return row;
  const incomingClearsPublicStatus =
    Boolean(stringOrNull(row.standard_model) && stringOrNull(row.group_name)) &&
    incomingSamples === 0 &&
    row.availability_seven_day_rate === null &&
    row.availability_source_type === "public_status" &&
    existing.availability_source_type === "public_status";
  if (incomingClearsPublicStatus) return row;
  const incomingPriority = availabilitySourcePriority(row.availability_source_type);
  const existingPriority = availabilitySourcePriority(existing.availability_source_type);
  const keepIncoming =
    !isTrustedAvailabilitySource(existing.availability_source_type) ||
    (incomingSamples > 0 && incomingPriority >= existingPriority);
  if (keepIncoming) return row;
  const existingEvidence = availabilityEvidenceForStoredOffer(existing);
  return {
    ...row,
    availability_seven_day_rate: existing.availability_seven_day_rate ?? row.availability_seven_day_rate,
    availability_seven_day_samples: existing.availability_seven_day_samples ?? row.availability_seven_day_samples,
    availability_first_checked_at: existing.availability_first_checked_at || row.availability_first_checked_at,
    availability_last_checked_at: existing.availability_last_checked_at || row.availability_last_checked_at,
    availability_latest_latency_ms: existing.availability_latest_latency_ms ?? row.availability_latest_latency_ms,
    availability_avg_latency_7d_ms: existing.availability_avg_latency_7d_ms ?? row.availability_avg_latency_7d_ms,
    availability_note: existing.availability_note || row.availability_note,
    availability_source_type: existing.availability_source_type,
    availability_source_label: existing.availability_source_label ?? row.availability_source_label ?? null,
    availability_source_url: existing.availability_source_url ?? row.availability_source_url ?? null,
    availability_scope: existingEvidence.scope,
    availability_match_level: existingEvidence.matchLevel,
    monitoring_scope_id: existingEvidence.monitoringScopeId,
  };
}

function availabilityEvidenceForStoredOffer(offer) {
  const note = stringOrNull(offer.availability_note) || "";
  const matchLevel = stringOrNull(offer.availability_match_level) ||
    (/同模型族参考/.test(note) ? "family" :
      /同模型监测|performance summary|uptime14d/i.test(note) ? "model" :
        /同分组监测/.test(note) || offer.availability_source_type === "public_status" ? "group" : "exact");
  const scope = stringOrNull(offer.availability_scope) ||
    (matchLevel === "group" ? "group" :
      matchLevel === "model" || matchLevel === "family" ? "model" : "offer");
  const scopeKey =
    scope === "group" ? offer.group_name :
      scope === "model" && matchLevel === "family" ? offer.family :
        scope === "model" ? offer.standard_model :
          `${offer.group_name || ""}|${offer.standard_model || ""}`;
  return {
    scope,
    matchLevel,
    monitoringScopeId:
      stringOrNull(offer.monitoring_scope_id) ||
      stableId("api-transit-monitoring", offer.station_id, offer.availability_source_type, scope, scopeKey),
  };
}

function isTrustedAvailabilitySource(sourceType) {
  return sourceType && sourceType !== "unknown";
}

function availabilitySourcePriority(sourceType) {
  if (sourceType === "public_status") return 60;
  if (sourceType === "priceai_probe") return 50;
  if (sourceType === "partner_api") return 30;
  if (sourceType === "merchant_reported") return 20;
  if (sourceType === "public_model_catalog" || sourceType === "manual_snapshot") return 10;
  return 0;
}

function mergeExistingCacheHit(row, existing) {
  if (isFixedPriceOfferRow(row)) {
    return {
      ...row,
      cache_hit_rate: null,
      cache_hit_sample_tokens: 0,
    };
  }
  if (!existing) return row;
  const incomingTokens = Math.max(0, integerValue(row.cache_hit_sample_tokens) || 0);
  const existingTokens = Math.max(0, integerValue(existing.cache_hit_sample_tokens) || 0);
  if (incomingTokens > 0 || existingTokens <= 0) return row;
  return {
    ...row,
    cache_hit_rate: existing.cache_hit_rate ?? row.cache_hit_rate ?? null,
    cache_hit_sample_tokens: existingTokens,
  };
}

function isFixedPriceOfferRow(row) {
  const billingMode = stringOrNull(row?.billing_mode);
  return billingMode === "per_request" || billingMode === "fixed" || numberValue(row?.fixed_price) !== null;
}

function normalizeUnknownAvailability(row, fallbackNote) {
  if ((row.availability_source_type || "unknown") !== "unknown") return row;
  return {
    ...row,
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_first_checked_at: null,
    availability_last_checked_at: null,
    availability_note: unknownAvailabilityNote(row.availability_note, fallbackNote),
    availability_source_label: null,
    availability_source_url: null,
  };
}

function unknownAvailabilityNote(note, fallbackNote) {
  const text = stringOrNull(note);
  if (!text || STALE_UNKNOWN_AVAILABILITY_NOTE_PATTERN.test(text)) return fallbackNote || null;
  return text;
}

function keepConfiguredValue(existingValue, incomingValue) {
  return existingValue && existingValue !== "unknown" ? existingValue : incomingValue;
}

function keepConfiguredList(existingValue, incomingValue) {
  return Array.isArray(existingValue) ? existingValue : incomingValue;
}

function normalizeConfiguredValue(value, fallback) {
  return value && value !== "unknown" ? value : fallback;
}

function shouldReplaceStaleStationSummary(existingSummary, station) {
  const existing = stringOrNull(existingSummary);
  const incoming = stringOrNull(station?.summary);
  if (!existing || !incoming) return false;
  if (station?.collection_status !== "success") return false;
  if (station?.auto_publish !== true && station?.published !== true) return false;
  if (!AI_TRANSIT_SNAPSHOT_COLLECTORS.has(station?.collectorKind || station?.collector_kind)) return false;
  return /Turnstile|登录|后台|待人工|待采集|未授权|401|403|pending|manual_review/i.test(existing);
}

async function upsertRows(supabase, table, rows, options = {}) {
  for (const chunk of chunks(rows, 300)) {
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (
      error &&
      table === "api_transit_stations" &&
      (
        isMissingColumnError(error, "availability_first_checked_at") ||
        isMissingColumnError(error, "availability_latest_latency_ms") ||
        isMissingColumnError(error, "availability_avg_latency_7d_ms") ||
        isMissingColumnError(error, "station_system") ||
        isMissingColumnError(error, "operator_type") ||
        isMissingColumnError(error, "invoice_support")
      )
    ) {
      const compatibleChunk = removeFieldsFromRows(chunk, compatibleStationUpsertFieldsToRemove(error));
      const { error: fallbackError } = await supabase.from(table).upsert(compatibleChunk, options);
      if (!fallbackError) continue;
      fallbackError.table = table;
      throw fallbackError;
    }
    if (error && table === "api_transit_stations" && isAvailabilitySourceColumnError(error)) {
      const compatibleChunk = removeAvailabilitySourceFields(removeLatencyFields(chunk));
      const { error: fallbackError } = await supabase.from(table).upsert(compatibleChunk, options);
      if (!fallbackError) continue;
      fallbackError.table = table;
      throw fallbackError;
    }
    if (error && table === "api_transit_stations" && isAvailabilityEvidenceColumnError(error)) {
      const compatibleChunk = removeAvailabilityEvidenceFields(chunk);
      const { error: fallbackError } = await supabase.from(table).upsert(compatibleChunk, options);
      if (!fallbackError) continue;
      fallbackError.table = table;
      throw fallbackError;
    }
    if (error && table === "api_transit_availability_samples" && isSampleOptionalColumnError(error)) {
      const compatibleChunk = removeSampleOptionalFields(chunk, error);
      const { error: fallbackError } = await supabase.from(table).upsert(compatibleChunk, options);
      if (!fallbackError) continue;
      fallbackError.table = table;
      throw fallbackError;
    }
    if (error) {
      error.table = table;
      throw error;
    }
  }
}

function removeFieldsFromRows(rows, fieldNames) {
  return rows.map((row) => {
    const next = { ...row };
    for (const fieldName of fieldNames) delete next[fieldName];
    return next;
  });
}

function withoutColumns(columns, ...excluded) {
  return columns.filter((column) => !excluded.includes(column));
}

function missingExistingStationColumn(error, columns) {
  return columns.find((column) => isMissingColumnError(error, column)) || null;
}

function compatibleExistingStationColumnsToRemove(column) {
  if (column === "operator_type" || column === "invoice_support") return ["operator_type", "invoice_support"];
  return [column];
}

function compatibleStationUpsertFieldsToRemove() {
  return [
    "availability_first_checked_at",
    "availability_latest_latency_ms",
    "availability_avg_latency_7d_ms",
    "station_system",
    "operator_type",
    "invoice_support",
  ];
}

function removeAvailabilitySourceFields(rows) {
  return removeFieldsFromRows(rows, [
    "availability_source_type",
    "availability_source_label",
    "availability_source_url",
    "sourceType",
    "sourceLabel",
    "sourceUrl",
  ]);
}

function removeAvailabilityEvidenceFields(rows) {
  return removeFieldsFromRows(rows, [
    "availability_scope",
    "availability_match_level",
    "monitoring_scope_id",
  ]);
}

function removeLatencyFields(rows) {
  return removeFieldsFromRows(rows, [
    "availability_latest_latency_ms",
    "availability_avg_latency_7d_ms",
  ]);
}

function removeFixedPriceOfferFields(rows) {
  return removeFieldsFromRows(rows, [
    "billing_mode",
    "fixed_price",
    "fixed_price_currency",
    "fixed_price_unit",
    "fixed_price_tiers",
  ]);
}

function removeSampleSourceFields(rows) {
  return removeFieldsFromRows(rows, ["source_type", "source_label", "source_url"]);
}

function removeSampleLatencyFields(rows) {
  return removeFieldsFromRows(rows, ["latency_ms", "ping_latency_ms"]);
}

function removeSampleOptionalFields(rows, error) {
  let next = rows;
  if (isSampleSourceColumnError(error)) next = removeSampleSourceFields(next);
  if (isSampleLatencyColumnError(error)) next = removeSampleLatencyFields(next);
  return next;
}

function loadSources() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

async function loadCollectionSources(options) {
  const sources = loadSources();
  if (!shouldRestrictToPublishedStations(options)) return sources;

  const publishedStationIds = await readPublishedApiTransitStationIds();
  return filterSourcesByPublishedStationIds(sources, publishedStationIds);
}

function selectSources(sources, options) {
  const ids = optionList(options.source || options.sources);
  const selected = ids.length ? sources.filter((source) => ids.includes(source.id)) : sources;
  if (!selected.length) throw new Error("No API transit sources matched.");
  return selected;
}

function shouldRestrictToPublishedStations(options) {
  const ids = optionList(options.source || options.sources);
  return Boolean((options.post || options.db) && !options.dryRun && !options.publish && !ids.length);
}

function filterSourcesByPublishedStationIds(sources, publishedStationIds) {
  return sources.filter(
    (source) => publishedStationIds.has(source.id) || shouldAutoPublishSource(source),
  );
}

async function readPublishedApiTransitStationIds() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for published API transit source selection.");
  }

  const { data, error } = await supabase
    .from("api_transit_stations")
    .select("id")
    .eq("published", true)
    .is("removed_at", null);
  if (error) {
    if (isMissingRemovedAtColumnError(error)) return readPublishedApiTransitStationIdsWithoutRemovedFilter(supabase);
    throw error;
  }

  return new Set((data || []).map((row) => String(row.id || "")).filter(Boolean));
}

async function readPublishedApiTransitStationIdsWithoutRemovedFilter(supabase) {
  const { data, error } = await supabase
    .from("api_transit_stations")
    .select("id")
    .eq("published", true);
  if (error) throw error;
  return new Set((data || []).map((row) => String(row.id || "")).filter(Boolean));
}

function isMissingRemovedAtColumnError(error) {
  return isMissingColumnError(error, "removed_at");
}

function isMissingColumnError(error, columnName) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "");
  return (code === "42703" || code === "PGRST204") && message.includes(columnName);
}

function isAvailabilitySourceColumnError(error) {
  return (
    isMissingColumnError(error, "availability_source_type") ||
    isMissingColumnError(error, "availability_source_label") ||
    isMissingColumnError(error, "availability_source_url")
  );
}

function isAvailabilityEvidenceColumnError(error) {
  return (
    isMissingColumnError(error, "availability_scope") ||
    isMissingColumnError(error, "availability_match_level") ||
    isMissingColumnError(error, "monitoring_scope_id")
  );
}

function isFixedPriceOfferColumnError(error) {
  return (
    isMissingColumnError(error, "billing_mode") ||
    isMissingColumnError(error, "fixed_price") ||
    isMissingColumnError(error, "fixed_price_currency") ||
    isMissingColumnError(error, "fixed_price_unit") ||
    isMissingColumnError(error, "fixed_price_tiers")
  );
}

function isSampleSourceColumnError(error) {
  return (
    isMissingColumnError(error, "source_type") ||
    isMissingColumnError(error, "source_label") ||
    isMissingColumnError(error, "source_url")
  );
}

function isSampleLatencyColumnError(error) {
  return (
    isMissingColumnError(error, "latency_ms") ||
    isMissingColumnError(error, "ping_latency_ms")
  );
}

function isSampleOptionalColumnError(error) {
  return isSampleSourceColumnError(error) || isSampleLatencyColumnError(error);
}

function compactSnapshot(payload) {
  const text = JSON.stringify(payload);
  if (text.length <= 100000) return payload;
  return {
    truncated: true,
    keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    bytes: text.length,
  };
}

function getSupabaseClient() {
  const env = readEnvFile(path.join(repoRoot, ".env.local"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function readEnvFile(filePath) {
  const output = {};
  if (!existsSync(filePath)) return output;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    output[match[1]] = unquote(match[2].trim());
  }
  return output;
}

function unquote(value) {
  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const rawKey = item.slice(2);
    const [key, inlineValue] = rawKey.split("=", 2);
    const next = values[index + 1];

    if (inlineValue !== undefined) {
      result[key] = inlineValue;
    } else if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function normalizeOptions(options) {
  return {
    ...options,
    dryRun: truthyOption(options.dryRun ?? options["dry-run"]),
    post: truthyOption(options.post),
    db: truthyOption(options.db),
    publish: truthyOption(options.publish),
  };
}

function envValue(name, options = {}) {
  if (!name) return "";
  const env = readEnvFile(envPath);
  return options.env?.[name] || process.env[name] || env[name] || "";
}

function truthyOption(value) {
  return value === true || value === "true" || value === "1" || value === "";
}

function optionList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(optionList);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueText(values) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function dedupeRowsById(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = stringOrNull(row?.id);
    if (!id) continue;
    byId.set(id, row);
  }
  return Array.from(byId.values());
}

function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integerValue(value) {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.round(parsed);
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function rechargeRatioFromBilling(billing) {
  const multiplier = numberValue(billing?.balance_recharge_multiplier);
  if (multiplier === null || multiplier <= 0) return null;
  return `1:${round(multiplier, 6)}`;
}

function fixedPriceCnyFromCreditPrice(creditPrice, rechargeRatio) {
  const price = numberValue(creditPrice);
  if (price === null || price <= 0) return null;
  const creditsPerCny = creditsPerCnyFromRechargeRatio(rechargeRatio) ?? 1;
  if (creditsPerCny <= 0) return null;
  return price / creditsPerCny;
}

function creditsPerCnyFromRechargeRatio(text) {
  const value = stringOrNull(text);
  if (!value) return null;

  const ratioMatch = value.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (ratioMatch) {
    const base = Number(ratioMatch[1]);
    const quota = Number(ratioMatch[2]);
    if (!Number.isFinite(base) || !Number.isFinite(quota) || base <= 0 || quota <= 0) return null;
    return quota / base;
  }

  const balanceMatch = value.match(
    /(\d+(?:\.\d+)?)\s*(?:CNY|RMB|人民币|元|￥|¥)?\s*=\s*(\d+(?:\.\d+)?)\s*(?:USD\s*)?(?:balance|余额|额度|credit|credits)?/i,
  );
  if (!balanceMatch) return null;

  const base = Number(balanceMatch[1]);
  const quota = Number(balanceMatch[2]);
  if (!Number.isFinite(base) || !Number.isFinite(quota) || base <= 0 || quota <= 0) return null;
  return quota / base;
}

function normalizeBillingMode(value) {
  const mode = stringOrNull(value);
  if (mode === "per_request" || mode === "fixed" || mode === "token") return mode;
  return null;
}

function roundFixedPrice(value) {
  return round(value, 6);
}

function skippedSource(message, reason) {
  const error = new Error(message);
  error.code = SOURCE_SKIPPED;
  error.reason = reason;
  return error;
}

function round(value, digits) {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function nullableSortValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function stableId(...parts) {
  const input = parts.filter((part) => part !== null && part !== undefined).join("|");
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) hash = (hash * 33) ^ input.charCodeAt(index);
  return `id-${(hash >>> 0).toString(36)}`;
}

function printSummary(result) {
  console.log(
    [
      "API transit collect plan.",
      `sources=${result.counts.sources}`,
      `stations=${result.counts.stations}`,
      `offers=${result.counts.offers}`,
      `runs=${result.counts.runs}`,
      result.database ? `database=${result.database.skipped ? "dry-run" : "posted"}` : "database=not-requested",
      result.publish ? "publish=true" : "publish=false",
    ].join(" "),
  );
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function errorMessage(error) {
  if (error?.name === "AbortError") return "请求超时。";
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return JSON.stringify(error, null, 2);
  return String(error);
}

export const __test = {
  buildAvailabilitySampleRow,
  collectSuccessfulRefreshStationIds,
  collectRefreshedOfferKeys,
  clearUnpricedPreviewModelRates,
  dedupeRowsById,
  enforceRemovedStationStateAfterUpsert,
  filterSourcesByPublishedStationIds,
  findStaleRefreshedOfferIds,
  mergeStationForRefresh,
  applyNewApiPerformanceSummaryAvailability,
  applyZivvStatusAvailability,
  mergeOfferForRefresh,
  removeAvailabilityEvidenceFields,
  parseApinodePublicSiteInfoPayload,
  parseOneHopPublicModelsPayload,
  parsePricingPayload,
  parseSub2ApiModelPlazaPayload,
  parseSub2ApiPublicProfilePayload,
  parseZivvModelHubPayload,
  readExistingOffers,
  selectSources,
  standardizeModelName,
  shouldRestrictToPublishedStations,
  upsertRows,
};
