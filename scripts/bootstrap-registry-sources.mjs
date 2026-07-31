#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import collectorRegistry from "../config/collectors.json" with { type: "json" };
import { probeSource, runPriceCollection } from "./collect-prices.mjs";

const env = {
  ...readEnvFile(".env.local"),
  ...process.env,
};

const args = parseArgs(process.argv.slice(2));
const apply = Boolean(args.apply);
const collect = Boolean(args.collect);
const offset = integerInRange(args.offset, 0, 10_000, 0);
const limit = integerInRange(args.limit, 1, 20, 8);
const concurrency = integerInRange(args.concurrency, 1, 2, 1);
const includeKinds = new Set(optionList(args.kinds || args.kind));
const includeShopApi = Boolean(args["include-shop-api"]);

if (args.help) {
  printHelp();
  process.exit(0);
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，无法读取本地来源库。");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const { data: existingRows, error: existingError } = await supabase
  .from("sources")
  .select("id,entry_url,base_url,collector_kind");
if (existingError) throw existingError;

const existingHosts = new Set(
  (existingRows || [])
    .flatMap((row) => [hostnameOf(row.entry_url), hostnameOf(row.base_url)])
    .filter(Boolean),
);
const existingIds = new Set((existingRows || []).map((row) => String(row.id)));

const candidates = collectorRegistry.kinds
  .filter((entry) => includeKinds.size === 0 || includeKinds.has(entry.kind))
  .filter((entry) => includeShopApi || entry.kind !== "shopApi")
  .flatMap((entry) =>
    entry.hosts.map((host) => ({
      host: normalizeHost(host),
      kind: entry.kind,
      sourceUrl: `https://${normalizeHost(host)}/`,
    })),
  )
  .filter((candidate, index, rows) =>
    rows.findIndex((row) => row.host === candidate.host && row.kind === candidate.kind) === index,
  )
  .sort((left, right) => left.kind.localeCompare(right.kind) || left.host.localeCompare(right.host));

const batch = candidates.slice(offset, offset + limit);
if (!batch.length) {
  console.log(`没有待处理候选；注册表共 ${candidates.length} 个可直接按域名探测的来源。`);
  process.exit(0);
}

console.log(
  `${apply ? "导入" : "只探测"}注册表来源：第 ${offset + 1}-${offset + batch.length} 个，` +
  `共 ${candidates.length} 个；并发 ${concurrency}。`,
);
if (!includeShopApi) {
  console.log("已跳过 ShopApi 平台根域名；这类来源必须拿到具体 /shop/<店铺标识> 才能代表一家商家。");
}

const results = await mapConcurrent(batch, concurrency, probeCandidate);
console.table(
  results.map((result) => ({
    host: result.host,
    kind: result.kind,
    status: result.status,
    offers: result.offerCount,
    team: result.teamOfferCount,
    imported: result.imported ? "yes" : "",
    collected: result.collected ? "yes" : "",
    ms: result.ms,
    message: truncate(result.message, 72),
  })),
);

const totals = {
  checked: results.length,
  existing: results.filter((result) => result.status === "existing").length,
  reachable: results.filter((result) => result.status === "success").length,
  imported: results.filter((result) => result.imported).length,
  collected: results.filter((result) => result.collected).length,
  teamOffersSeenInProbe: results.reduce((sum, result) => sum + result.teamOfferCount, 0),
  failed: results.filter((result) => result.status === "failed").length,
  empty: results.filter((result) => result.status === "empty").length,
};
console.log(JSON.stringify(totals, null, 2));

async function probeCandidate(candidate) {
  const startedAt = Date.now();
  if (existingHosts.has(candidate.host)) {
    return {
      ...candidate,
      status: "existing",
      offerCount: 0,
      teamOfferCount: 0,
      imported: false,
      collected: false,
      ms: Date.now() - startedAt,
      message: "本地来源库已存在该域名。",
    };
  }

  const sourceId = uniqueSourceId(candidate.host, candidate.kind);
  const probe = await probeSource({
    sourceId,
    sourceName: candidate.host,
    sourceUrl: candidate.sourceUrl,
    collectorKind: candidate.kind,
    autoDetect: false,
    fallbackDetect: false,
    pageDelayMs: 0,
    limit: 50,
  });
  const teamOfferCount = (probe.offers || []).filter((offer) => isTeamOfferTitle(offer.sourceTitle)).length;

  let imported = false;
  let collected = false;
  let message = probe.message;
  if (probe.status === "success" && apply) {
    const now = new Date().toISOString();
    const { error: insertError } = await supabase.from("sources").insert({
      id: sourceId,
      name: candidate.host,
      base_url: probe.baseUrl || candidate.sourceUrl.replace(/\/$/, ""),
      entry_url: candidate.sourceUrl,
      collection_method: "http",
      collector_kind: probe.kind || candidate.kind,
      collection_group: "automatic",
      enabled: true,
      notes:
        `从仓库 config/collectors.json 本地注册表验证导入；` +
        `试采集发现 ${probe.offerCount} 条商品，预览中 ${teamOfferCount} 条与 GPT Team/Business 相关。`,
      updated_at: now,
    });
    if (insertError) throw insertError;
    existingHosts.add(candidate.host);
    existingIds.add(sourceId);
    imported = true;

    if (collect) {
      try {
        const collection = await runPriceCollection({
          source: sourceId,
          post: true,
          retries: 1,
          concurrency: 1,
          pageDelayMs: 100,
          endpoint: env.CRON_PUBLIC_BASE_URL || "http://127.0.0.1:3010",
          password: env.CRON_SECRET,
          silent: true,
        });
        collected = collection.summary.some((row) => row.status === "success");
        if (!collected) message = `${message}；已导入，但首次完整采集未成功。`;
      } catch (error) {
        message =
          `${message}；来源已导入，但首次完整采集失败：` +
          (error instanceof Error ? error.message : String(error));
      }
    }
  }

  return {
    ...candidate,
    status: probe.status,
    offerCount: probe.offerCount,
    teamOfferCount,
    imported,
    collected,
    ms: Date.now() - startedAt,
    message,
  };
}

function uniqueSourceId(host, kind) {
  const base = normalizeHost(host)
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!existingIds.has(base)) return base;
  return `${base}-${String(kind).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
}

function isTeamOfferTitle(value) {
  return /(?:\bteam\b|\bbusiness\b|\bk12\b|bug\s*team|团队|母号|子号|邀请|自动拉)/i.test(String(value || ""));
}

async function mapConcurrent(items, workerCount, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = {
          ...items[index],
          status: "failed",
          offerCount: 0,
          teamOfferCount: 0,
          imported: false,
          collected: false,
          ms: 0,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      output[key] = true;
    } else {
      output[key] = next;
      index += 1;
    }
  }
  return output;
}

function optionList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function integerInRange(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function hostnameOf(value) {
  try {
    return normalizeHost(new URL(String(value || "")).hostname);
  } catch {
    return "";
  }
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const output = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    output[match[1]] = unquote(match[2].trim());
  }
  return output;
}

function unquote(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function printHelp() {
  console.log(`用法：
  node scripts/bootstrap-registry-sources.mjs [选项]

选项：
  --offset N             从排序后的第 N 个候选开始，默认 0
  --limit N              本批处理数量，默认 8，最大 20
  --concurrency N        并发数，默认 1，最大 2
  --kind kami,dujiao     只处理指定采集器
  --apply                只把验证成功的来源写入本地数据库
  --collect              搭配 --apply，导入后立即做一次完整采集并写回报价
  --include-shop-api     包含平台根域名；通常不建议，因为它们不代表具体店铺
  --help                 显示帮助

默认只探测，不修改数据库。`);
}
