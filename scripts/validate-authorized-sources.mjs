#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  probeShopApiSourceLightweight,
  runPriceCollection,
} from "./collect-prices.mjs";

const env = {
  ...readEnvFile(".env.local"),
  ...process.env,
};
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY。");
}
if (!env.CRON_SECRET) {
  throw new Error("缺少 CRON_SECRET，无法把本地采集结果写回 PriceAI。");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
const limit = integerInRange(args.limit, 1, 20, 5);
const slowMode = Boolean(args.slow);
const concurrency = slowMode ? 1 : integerInRange(args.concurrency, 1, 2, 1);
const validateAll = slowMode && Boolean(args.all);
const delaySeconds = slowMode
  ? integerInRange(args["delay-seconds"], 30, 3_600, 180)
  : 0;
const startDelaySeconds = slowMode
  ? integerInRange(args["start-delay-seconds"], 0, 3_600, 0)
  : 0;
const collectorKind = cleanText(args.kind);
const sourceId = cleanText(args.id);
const retryFailed = Boolean(args["retry-failed"]);
const probePageSize = integerInRange(args["probe-page-size"], 1, 100, 20);

let query = supabase
  .from("sources")
  .select("id,name,entry_url,base_url,collector_kind,health_status,consecutive_failures,last_error,last_checked_at,notes")
  .eq("enabled", false)
  .like("notes", "经 PriceAI 权利人明确授权%")
  .order("id", { ascending: true });
if (!validateAll) query = query.limit(limit);
if (!retryFailed) query = query.is("last_checked_at", null);
if (collectorKind) query = query.eq("collector_kind", collectorKind);
if (sourceId) query = query.eq("id", sourceId);

const { data: sources, error: sourceError } = await query;
if (sourceError) throw sourceError;
if (!sources?.length) {
  console.log("没有符合条件的待验证来源。");
  process.exit(0);
}

if (startDelaySeconds > 0) {
  console.log(`先等待 ${startDelaySeconds} 秒，让上一次平台限流完成冷却。`);
  await delay(startDelaySeconds * 1_000);
}

console.log(
  `从本机验证 ${sources.length} 个授权导入来源；` +
  (slowMode
    ? `慢速模式，每次 1 家、间隔 ${delaySeconds} 秒`
    : `并发 ${concurrency}`) +
  `${collectorKind ? `，采集器 ${collectorKind}` : ""}。`,
);
const results = slowMode
  ? await mapSlowly(sources, validateSource, delaySeconds * 1_000)
  : await mapConcurrent(sources, concurrency, validateSource);
console.table(
  results.map((result) => ({
    id: result.id,
    name: result.name,
    kind: result.kind,
    status: result.status,
    offers: result.offers,
    enabled: result.enabled ? "yes" : "",
    ms: result.ms,
    message: truncate(result.message, 80),
  })),
);
console.log(JSON.stringify({
  checked: results.length,
  enabled: results.filter((result) => result.enabled).length,
  failed: results.filter((result) => !result.enabled && !result.rateLimited).length,
  paused: results.filter((result) => result.rateLimited).length,
  offers: results.reduce((sum, result) => sum + result.offers, 0),
}, null, 2));

async function validateSource(source) {
  if (source.collector_kind === "shopApi") {
    return validateShopApiSourceLightweight(source);
  }
  return validateSourceWithFullCollection(source);
}

async function validateShopApiSourceLightweight(source) {
  const startedAt = Date.now();
  try {
    const probe = await probeShopApiSourceLightweight(source, {
      pageSize: probePageSize,
    });
    const offers = Number(probe.comparableItemCount || 0);
    if (offers <= 0) {
      const message = "店铺接口可访问，但第一页没有返回带标题和价格的商品。";
      await markFailed(source, message);
      return {
        id: source.id,
        name: source.name,
        kind: source.collector_kind,
        status: "empty",
        offers: 0,
        enabled: false,
        rateLimited: false,
        ms: Date.now() - startedAt,
        message,
      };
    }

    const now = new Date().toISOString();
    const { error: enableError } = await supabase
      .from("sources")
      .update({
        enabled: true,
        health_status: "healthy",
        last_checked_at: now,
        last_success_at: now,
        consecutive_failures: 0,
        last_error: null,
        notes: source.notes,
        updated_at: now,
      })
      .eq("id", source.id);
    if (enableError) throw enableError;

    return {
      id: source.id,
      name: source.name,
      kind: source.collector_kind,
      status: "success",
      offers,
      enabled: true,
      rateLimited: false,
      ms: Date.now() - startedAt,
      message:
        `轻量验证成功：${probe.requestCount} 次接口请求，` +
        `第一页识别到 ${offers} 个商品；未逐商品查询价格。`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRateLimitMessage(message)) {
      await markRateLimited(source);
      return {
        id: source.id,
        name: source.name,
        kind: source.collector_kind,
        status: "paused",
        offers: 0,
        enabled: false,
        rateLimited: true,
        ms: Date.now() - startedAt,
        message: `${message} 已停止本批，稍后可从这家继续。`,
      };
    }
    await markFailed(source, message);
    return {
      id: source.id,
      name: source.name,
      kind: source.collector_kind,
      status: "failed",
      offers: 0,
      enabled: false,
      rateLimited: false,
      ms: Date.now() - startedAt,
      message,
    };
  }
}

async function validateSourceWithFullCollection(source) {
  const startedAt = Date.now();
  const now = new Date().toISOString();
  const { error: enableError } = await supabase
    .from("sources")
    .update({ enabled: true, updated_at: now })
    .eq("id", source.id);
  if (enableError) throw enableError;

  try {
    const collection = await runPriceCollection({
      source: source.id,
      post: true,
      retries: 1,
      concurrency: 1,
      pageDelayMs: 100,
      endpoint: env.CRON_PUBLIC_BASE_URL || "http://127.0.0.1:3010",
      password: env.CRON_SECRET,
      silent: true,
    });
    const summary = collection.summary.find((row) => row.sourceId === source.id);
    const offers = Number(summary?.offers || 0);
    if (summary?.status === "success" && offers > 0) {
      return {
        id: source.id,
        name: source.name,
        kind: source.collector_kind,
        status: "success",
        offers,
        enabled: true,
        rateLimited: false,
        ms: Date.now() - startedAt,
        message: `本地完整采集成功，写入 ${offers} 条商品。`,
      };
    }

    const message = summary?.message || (
      summary?.status === "success"
        ? "采集器连接成功，但没有返回可比价商品。"
        : "本地采集失败。"
    );
    if (isRateLimitMessage(message)) {
      await markRateLimited(source);
      return {
        id: source.id,
        name: source.name,
        kind: source.collector_kind,
        status: "paused",
        offers,
        enabled: false,
        rateLimited: true,
        ms: Date.now() - startedAt,
        message: `${message} 已停止本批，稍后可从这家继续。`,
      };
    }
    await markFailed(source, message);
    return {
      id: source.id,
      name: source.name,
      kind: source.collector_kind,
      status: summary?.status || "failed",
      offers,
      enabled: false,
      rateLimited: false,
      ms: Date.now() - startedAt,
      message,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRateLimitMessage(message)) {
      await markRateLimited(source);
      return {
        id: source.id,
        name: source.name,
        kind: source.collector_kind,
        status: "paused",
        offers: 0,
        enabled: false,
        rateLimited: true,
        ms: Date.now() - startedAt,
        message: `${message} 已停止本批，稍后可从这家继续。`,
      };
    }
    await markFailed(source, message);
    return {
      id: source.id,
      name: source.name,
      kind: source.collector_kind,
      status: "failed",
      offers: 0,
      enabled: false,
      rateLimited: false,
      ms: Date.now() - startedAt,
      message,
    };
  }
}

async function markRateLimited(source) {
  const { error } = await supabase
    .from("sources")
    .update({
      enabled: false,
      health_status: source.health_status || "unknown",
      last_checked_at: source.last_checked_at || null,
      consecutive_failures: Math.max(0, Number(source.consecutive_failures || 0)),
      last_error: source.last_error || null,
      notes: source.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.id);
  if (error) throw error;
}

async function markFailed(source, message) {
  const { error } = await supabase
    .from("sources")
    .update({
      enabled: false,
      health_status: "failing",
      last_checked_at: new Date().toISOString(),
      consecutive_failures: Math.max(1, Number(source.consecutive_failures || 0) + 1),
      last_error: String(message || "本地验证失败。").slice(0, 500),
      notes: source.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.id);
  if (error) throw error;
}

async function mapSlowly(items, worker, waitMs) {
  const results = [];
  for (let index = 0; index < items.length; index += 1) {
    const result = await worker(items[index]);
    results.push(result);
    console.log(
      `[${index + 1}/${items.length}] ${result.name}: ${result.status}` +
      `${result.offers ? `，${result.offers} 条商品` : ""}。`,
    );
    if (result.rateLimited) {
      console.log("检测到平台限流或验证页，本批立即暂停；该商家仍保留为未验证。");
      break;
    }
    if (index < items.length - 1 && waitMs > 0) {
      console.log(`等待 ${Math.ceil(waitMs / 1_000)} 秒后再验证下一家。`);
      await delay(waitMs);
    }
  }
  return results;
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

function isRateLimitMessage(value) {
  return /(?:HTTP|status|returned HTTP)\s*(?:403|429|520)\b|风控|验证(?:页|页面)?|熔断|challenge|captcha|forbidden|http_ratelimit|ip_access_rule/i
    .test(String(value || ""));
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

function cleanText(value) {
  return String(value || "").trim();
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
  node scripts/validate-authorized-sources.mjs [选项]

选项：
  --limit N          本批验证数量，默认 5，最大 20
  --concurrency N    并发数，默认 1，最大 2
  --kind KIND        只验证指定采集器类型
  --id SOURCE_ID     只验证一个指定来源
  --retry-failed     重新验证已经失败过的禁用来源
  --slow             慢速模式：强制单线程，并在商家之间等待
  --all              慢速模式下处理全部待验证来源，默认仍受 --limit 限制
  --delay-seconds N  慢速模式的等待秒数，默认 180，范围 30-3600
  --probe-page-size N
                    ShopApi 轻量验证只读第一页，默认最多读取 20 个商品
  --start-delay-seconds N
                    启动前先等待，供上一次限流冷却，范围 0-3600
  --help             显示帮助

脚本只选择经权利人授权导入且当前禁用的来源。
完整采集成功并返回商品时才保持启用，失败来源会重新禁用。
ShopApi 默认只发 2 次请求：店铺信息和第一页商品，不查询逐商品价格。
慢速模式遇到平台限流或验证页会立即停止，当前商家仍保留为未验证。`);
}
