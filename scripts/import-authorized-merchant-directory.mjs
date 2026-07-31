#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {
  ...readEnvFile(".env.local"),
  ...process.env,
};
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args["authorized-by-owner"]) {
  throw new Error("此导入器只用于权利人明确授权的商家目录迁移；请传入 --authorized-by-owner。");
}

const sourceBaseUrl = String(args.endpoint || "https://priceai.cc").replace(/\/$/, "");
const apply = Boolean(args.apply);
const enable = Boolean(args.enable);
const concurrency = integerInRange(args.concurrency, 1, 2, 2);
const pageSize = 200;
const stockScopes = ["available", "out_of_stock"];

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，无法访问本地来源库。");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

console.log(
  `${apply ? "导入" : "只分析"}已获权利人授权的商家目录；` +
  `来源 ${sourceBaseUrl}，并发 ${concurrency}。`,
);

const directoryCandidates = [];
let scannedOfferRows = 0;
for (const stock of stockScopes) {
  const firstPage = await fetchOfferPage(stock, 0);
  const total = Number(firstPage.total || 0);
  const offsets = [];
  for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);
  const remainingPages = await mapConcurrent(
    offsets,
    concurrency,
    (offset) => fetchOfferPage(stock, offset),
  );
  const pages = [firstPage, ...remainingPages];

  for (const page of pages) {
    const rows = Array.isArray(page.rows) ? page.rows : [];
    scannedOfferRows += rows.length;
    for (const row of rows) {
      const candidate = merchantDirectoryCandidate(row?.offer);
      if (candidate) directoryCandidates.push(candidate);
    }
  }

  console.log(`${stock}: 接口总数 ${total}，已读取 ${pages.reduce((sum, page) => sum + (page.rows?.length || 0), 0)} 条。`);
}

const uniqueBySource = preferCompleteCandidates(directoryCandidates);
let resolvedViaShopApi = 0;
if (args["resolve-shop-api"]) {
  const unresolvedShopApi = uniqueBySource.filter(
    (candidate) => candidate.collectorKind === "shopApi" && !candidate.entryUrl && candidate.itemUrl,
  );
  const resolved = await mapConcurrent(
    unresolvedShopApi,
    concurrency,
    resolveShopApiEntryUrl,
  );
  for (let index = 0; index < unresolvedShopApi.length; index += 1) {
    const entryUrl = resolved[index];
    if (!entryUrl) continue;
    unresolvedShopApi[index].entryUrl = normalizeEntryUrl(entryUrl, "shopApi");
    resolvedViaShopApi += 1;
  }
}
const resolvedCandidates = uniqueDirectoryCandidates(uniqueBySource.filter((candidate) => candidate.entryUrl));
const unresolved = uniqueBySource.filter((candidate) => !candidate.entryUrl);

const { data: existingRows, error: existingError } = await supabase
  .from("sources")
  .select("id,entry_url,base_url,collector_kind");
if (existingError) throw existingError;

const existingKeys = new Set(
  (existingRows || [])
    .map((row) => directoryKey(row.entry_url || row.base_url, row.collector_kind))
    .filter(Boolean),
);
const existingIds = new Set((existingRows || []).map((row) => String(row.id)));
const fresh = resolvedCandidates.filter((candidate) => !existingKeys.has(candidate.key));

let imported = 0;
if (apply && fresh.length) {
  const now = new Date().toISOString();
  const rows = fresh.map((candidate) => {
    const id = uniqueSourceId(candidate.sourceId, candidate.key, existingIds);
    existingIds.add(id);
    return {
      id,
      name: candidate.storeName || candidate.sourceName || candidate.sourceId,
      base_url: new URL(candidate.entryUrl).origin,
      entry_url: candidate.entryUrl,
      collection_method: "http",
      collector_kind: candidate.collectorKind,
      collection_group: "automatic",
      enabled: enable,
      notes:
        "经 PriceAI 权利人明确授权，仅从线上公开接口迁移商家目录字段；" +
        "未导入商品标题、价格、库存或历史数据。" +
        (enable ? " 已按命令启用，仍建议先做本地试采集。" : " 当前禁用，等待本地试采集。"),
      shop_created_at: validDateOrNull(candidate.shopCreatedAt),
      updated_at: now,
    };
  });

  for (const batch of chunks(rows, 100)) {
    const { error } = await supabase.from("sources").insert(batch);
    if (error) throw error;
    imported += batch.length;
  }
}

const byCollector = Object.entries(
  Object.groupBy(fresh, (candidate) => candidate.collectorKind || "unknown"),
)
  .map(([kind, rows]) => ({ kind, count: rows.length }))
  .sort((left, right) => right.count - left.count);

console.log(JSON.stringify({
  scannedOfferRows,
  uniqueSourceIds: uniqueBySource.length,
  resolvedDirectoryEntries: resolvedCandidates.length,
  resolvedViaShopApi,
  unresolvedShopApiEntries: unresolved.length,
  alreadyLocal: resolvedCandidates.length - fresh.length,
  newDirectoryEntries: fresh.length,
  imported,
  importedEnabled: apply && enable ? imported : 0,
  newByCollector: byCollector,
  ...(args["show-unresolved"]
    ? {
        unresolvedSources: unresolved.map((candidate) => ({
          sourceId: candidate.sourceId,
          name: candidate.storeName || candidate.sourceName || candidate.sourceId,
          collectorKind: candidate.collectorKind,
        })),
      }
    : {}),
}, null, 2));

async function fetchOfferPage(stock, offset) {
  const url = new URL("/api/offers", sourceBaseUrl);
  url.searchParams.set("stock", stock);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String(offset));

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "PriceAI-Authorized-Merchant-Directory-Importer/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(500 * attempt);
    }
  }
  throw lastError;
}

function merchantDirectoryCandidate(offer) {
  if (!offer || typeof offer !== "object") return null;
  const sourceId = cleanText(offer.sourceId);
  const collectorKind = cleanText(offer.collectorKind);
  const itemUrl = validHttpUrl(offer.url);
  const shopUrl = validHttpUrl(offer.shopUrl);
  if (!sourceId || !collectorKind) return null;

  let entryUrl = shopUrl;
  if (!entryUrl && collectorKind !== "shopApi" && itemUrl) {
    entryUrl = `${new URL(itemUrl).origin}/`;
  }

  return {
    sourceId,
    sourceName: cleanText(offer.sourceName),
    storeName: cleanText(offer.sourceStoreName),
    collectorKind,
    entryUrl: normalizeEntryUrl(entryUrl, collectorKind),
    itemUrl,
    includedAt: validDateOrNull(offer.sourceIncludedAt),
    shopCreatedAt: validDateOrNull(offer.sourceShopCreatedAt),
  };
}

async function resolveShopApiEntryUrl(candidate) {
  const itemUrl = validHttpUrl(candidate.itemUrl);
  if (!itemUrl) return null;
  const item = new URL(itemUrl);
  const goodsKey = item.pathname.match(/\/item\/([^/?#]+)/i)?.[1];
  if (!goodsKey) return null;

  const apiBase = item.hostname.toLowerCase().endsWith("ldxp.cn")
    ? "https://www.ldxp.cn"
    : item.origin;
  const referer = `${apiBase}/item/${encodeURIComponent(goodsKey)}`;

  try {
    const response = await fetch(`${apiBase}/shopApi/Shop/goodsInfo`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        referer,
        "user-agent": "PriceAI-Authorized-Merchant-Directory-Importer/1.0",
        visitorid: crypto.randomUUID(),
      },
      body: JSON.stringify({ goods_key: goodsKey, trade_no: "" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;
    const payload = await response.json();
    const token = cleanText(payload?.data?.user?.token);
    return token ? `${apiBase}/shop/${encodeURIComponent(token)}` : null;
  } catch {
    return null;
  }
}

function preferCompleteCandidates(candidates) {
  const byId = new Map();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.sourceId);
    if (!existing || candidateCompleteness(candidate) > candidateCompleteness(existing)) {
      byId.set(candidate.sourceId, candidate);
    }
  }
  return Array.from(byId.values());
}

function candidateCompleteness(candidate) {
  return [
    candidate.entryUrl,
    candidate.storeName,
    candidate.sourceName,
    candidate.shopCreatedAt,
  ].filter(Boolean).length;
}

function uniqueDirectoryCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = directoryKey(candidate.entryUrl, candidate.collectorKind);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || candidateCompleteness(candidate) > candidateCompleteness(existing)) {
      byKey.set(key, { ...candidate, key });
    }
  }
  return Array.from(byKey.values());
}

function directoryKey(value, collectorKind) {
  const url = validHttpUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (collectorKind === "shopApi") {
    const token = parsed.pathname.match(/\/shop\/([^/?#]+)/i)?.[1];
    if (!token) return null;
    const family = host.endsWith("ldxp.cn") ? "ldxp.cn" : host;
    return `shopApi:${family}:${token.toLowerCase()}`;
  }

  return `${collectorKind || "auto"}:${host}`;
}

function normalizeEntryUrl(value, collectorKind) {
  const url = validHttpUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";

  if (collectorKind === "shopApi") {
    const token = parsed.pathname.match(/\/shop\/([^/?#]+)/i)?.[1];
    if (!token) return null;
    parsed.pathname = `/shop/${token}`;
  } else {
    parsed.pathname = "/";
  }

  return parsed.toString();
}

function uniqueSourceId(preferred, key, existingIds) {
  const normalized = cleanText(preferred) || `authorized-${shortHash(key)}`;
  if (!existingIds.has(normalized)) return normalized;
  return `${normalized}-authorized-${shortHash(key)}`;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function validDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function cleanText(value) {
  return String(value || "").trim();
}

async function mapConcurrent(items, workerCount, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function integerInRange(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
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
  node scripts/import-authorized-merchant-directory.mjs --authorized-by-owner [选项]

选项：
  --endpoint URL          已获授权的 PriceAI 站点，默认 https://priceai.cc
  --concurrency N         并发数，默认 2，最大 2
  --apply                 把去重后的新商家写入本地 sources 表
  --enable                搭配 --apply，立即启用新来源；默认禁用等待本地试采集
  --resolve-shop-api      用公开 goodsInfo 接口补全缺少店铺主页的 ShopApi 来源
  --show-unresolved       只输出仍无法补全入口的商家名称和来源标识
  --authorized-by-owner   必填，确认权利人已明确授权迁移商家目录
  --help                  显示帮助

导入器只保留商家名称、店铺入口、采集器类型和来源时间。
商品标题、价格、库存及历史数据不会写入本地。`);
}
