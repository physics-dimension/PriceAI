#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { ProxyAgent } from "undici";
import { createClient } from "@supabase/supabase-js";
import { safeFetch } from "./safe-fetch.mjs";
import {
  DAILY_PROBE_INTERVAL_MINUTES,
  WEEKLY_PROBE_INTERVAL_MINUTES,
  legacyFailureObservationInterval,
  outOfStockObservationSchedule,
} from "./out-of-stock-observation.mjs";
import collectorRegistry from "../config/collectors.json" with { type: "json" };

const env = readEnvFile(".env.local");

const PRICE_VALUE_PATTERN = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const CURRENCY_PRICE_RE = new RegExp(String.raw`[¥￥]\s*${PRICE_VALUE_PATTERN}`);
const SUFFIX_PRICE_RE = new RegExp(String.raw`${PRICE_VALUE_PATTERN}\s*(?:CNY|RMB|元)`, "i");
const DEFAULT_COOLDOWN_MINUTES = 25;
const DEFAULT_LOCK_SECONDS = 10 * 60;
const DEFAULT_LIANDONG_SHOP_BULK_LIMIT = 0;
const DEFAULT_LIANDONG_SHOP_BULK_DELAY_MS = 15_000;
const DEFAULT_LIANDONG_SHOP_BREAKER_MINUTES = 30;
const DEFAULT_LIANDONG_SHOP_HTTP_403_COOLDOWN_MINUTES = 5;
const DEFAULT_LIANDONG_SHOP_HTTP_403_THRESHOLD = 3;
const DEFAULT_PAGE_DELAY_MS = 300;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_POST_BATCH_SIZE = 25;
const MIN_POST_BATCH_SIZE = 10;
const MAX_POST_BATCH_SIZE = 500;
const DEFAULT_FLUSH_SOURCE_COUNT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 120_000;
const DEFAULT_SPOOL_REPLAY_LIMIT = 40;
const DEFAULT_FULL_SNAPSHOT_OFFER_LIMIT = 200;
const SHOP_API_FULL_SNAPSHOT_OFFER_LIMIT = 500;
const SHOP_API_MAX_CATEGORY_PAGES = 10;
const SHOP_API_LIST_PAGE_SIZE = 100;
const SHOP_API_DEFAULT_PRICE_SAMPLE_SIZE = 3;
const SHOP_API_FEE_PROBE_MIN_LISTED_PRICE = 10;
const SHOP_API_FEE_PROBE_MAX_LISTED_PRICE = 10_000;
const SHOP_API_FIXED_FEE_RATE = 0.03;
const SHOP_API_CENT_TOLERANCE = 0.011;
const SHOP_API_PRODUCT_LEVEL_FEE_HOSTS = new Set(["catfk.com"]);
const SHOP_API_FULL_SNAPSHOT_MIN_COVERAGE = 0.8;
const DEFAULT_SHOP_API_PROXY_HOSTS = ["www.ldxp.cn", "pay.ldxp.cn", "ldxp.cn"];
const LDXP_WWW_HOST = "www.ldxp.cn";
const LDXP_PAY_HOST = "pay.ldxp.cn";
const LDXP_DOMAIN_SETTINGS_ID = "ldxp-domain";
const LDXP_AUTO_SWITCH_COOLDOWN_MS = 30 * 60 * 1000;
let ldxpRuntimeSettings = {
  mode: "auto",
  activeHost: LDXP_WWW_HOST,
  lastSwitchedAt: null,
  lastSwitchReason: null,
};
const SHOP_API_PROXY_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_SHOP_API_PROXY_REUSE_LIMIT = 0;
const DEFAULT_SHOP_API_PROXY_REUSE_TTL_MS = 55_000;
const DEFAULT_SHOP_API_PROXY_MAX_RUNS = 1;
const SHOP_API_PROXY_EXPIRY_SAFETY_MS = 45_000;
const SHOP_API_PROXY_ROTATION_WINDOW_MS = 10 * 60 * 1000;
const SHOP_API_PROXY_MAX_ROTATIONS_PER_WINDOW = 2;
const SHOP_API_PROXY_AUTO_TARGETS_PER_LANE = 30;
const SHOP_API_PROXY_AUTO_MAX_LANES = 2;
const DEFAULT_SHOP_API_PROXY_PARALLELISM = 1;
const DEFAULT_SHOP_API_PROXY_MODE = "always";
const DEFAULT_SHOP_API_EXIT_ERROR_FAMILY_PAUSE = false;
const SHOP_COLLECTION_SCHEDULER_CRAWL_RUN_SELECT =
  "id,source_id,source_name,mode,status,started_at,finished_at,success_count,failure_count,message,details";
const SHOP_COLLECTION_SCHEDULER_SOURCE_SELECT =
  "id,name,base_url,entry_url,collection_method,collector_kind,enabled,notes,health_status,last_success_at,last_checked_at,consecutive_failures,last_error,availability_status,out_of_stock_since,consecutive_out_of_stock_snapshots,created_at,shop_created_at,updated_at,buyer_fee_rate,buyer_fee_payment_method,buyer_fee_strategy,collection_group";
const SHOP_COLLECTION_SCHEDULER_SOURCE_NO_AVAILABILITY_SELECT =
  "id,name,base_url,entry_url,collection_method,collector_kind,enabled,notes,health_status,last_success_at,last_checked_at,consecutive_failures,last_error,created_at,shop_created_at,updated_at,buyer_fee_rate,buyer_fee_payment_method,buyer_fee_strategy,collection_group";
const SHOP_COLLECTION_SCHEDULER_SOURCE_NO_GROUP_SELECT =
  "id,name,base_url,entry_url,collection_method,collector_kind,enabled,notes,health_status,last_success_at,last_checked_at,consecutive_failures,last_error,created_at,shop_created_at,updated_at,buyer_fee_rate,buyer_fee_payment_method,buyer_fee_strategy";
const SHOP_COLLECTION_SCHEDULER_SOURCE_LEGACY_SELECT =
  "id,name,base_url,entry_url,collection_method,collector_kind,enabled,notes,health_status,last_success_at,last_checked_at,consecutive_failures,last_error,created_at,updated_at,buyer_fee_rate,buyer_fee_payment_method,buyer_fee_strategy";
const SHOP_COLLECTION_SCHEDULER_CRAWL_RUN_CHUNK_SIZE = 100;
const DEFAULT_SHOP_COLLECTION_SCHEDULER_BUCKET_MINUTES = 30;
const DEFAULT_SHOP_COLLECTION_SCHEDULER_SHARD_COUNT = 1;
const DEFAULT_SHOP_COLLECTION_SCHEDULER_SHARD_INDEX = 0;
const HOT_SHOP_COLLECTION_PRODUCT_IDS = new Set([
  "chatgpt-plus",
  "chatgpt-team-business",
  "super-grok",
  "gemini-pro-recharge",
  "chatgpt-free-account",
]);
const SHOP_COLLECTION_TIER_DEFINITIONS = [
  { tier: "vip_15m", label: "VIP 15分钟", intervalMinutes: 15, requestWeight: 8 },
  { tier: "new_source_bootstrap", label: "新店初始化", intervalMinutes: 30, requestWeight: 8 },
  { tier: "core_30m", label: "30m 核心", intervalMinutes: 30, requestWeight: 6 },
  { tier: "watch_1h", label: "1h 观察", intervalMinutes: 60, requestWeight: 3 },
  { tier: "lowprice_guard_1h", label: "1h 低价守护", intervalMinutes: 60, requestWeight: 3 },
  { tier: "low_3h", label: "3h 低频", intervalMinutes: 180, requestWeight: 1 },
  { tier: "retry_priority", label: "优先重试", intervalMinutes: 60, requestWeight: 1 },
  { tier: "retry_cooldown", label: "冷却重试", intervalMinutes: 180, requestWeight: 1 },
  { tier: "out_of_stock_watch_1h", label: "缺货观察 1h", intervalMinutes: 60, requestWeight: 1 },
  { tier: "out_of_stock_watch_3h", label: "缺货观察 3h", intervalMinutes: 180, requestWeight: 1 },
  { tier: "out_of_stock_watch_6h", label: "缺货观察 6h", intervalMinutes: 360, requestWeight: 1 },
  { tier: "daily_probe", label: "每日复检", intervalMinutes: DAILY_PROBE_INTERVAL_MINUTES, requestWeight: 1 },
  { tier: "weekly_probe", label: "每周复检", intervalMinutes: WEEKLY_PROBE_INTERVAL_MINUTES, requestWeight: 1 },
];
const STRUCTURED_FULL_SNAPSHOT_OFFER_LIMIT = 600;
const STRUCTURED_FULL_SNAPSHOT_COLLECTORS = new Set(["kami", "shopApi"]);
const EMPTY_FULL_SNAPSHOT_COLLECTORS = new Set(["kami"]);
const AUTO_DETECT_COLLECTOR_KINDS = [
  "dujiao",
  "kami",
  "publicProductsApi",
  "shopUserProductsApi",
  "mooncakeCatalog",
  "ikunloveApi",
  "unicornHtml",
  "opensoraHtml",
  "makerichHtml",
  "beibeiHtml",
  "blackcatWholesale",
  "genericHtml",
];
const BUILTIN_SOURCES = [
  { id: "ai666-gmail-wholesale", name: "T佬的gmail批发渠道", entry_url: "https://ai666.dnxb.cc/", collection_method: "http", collector_kind: "kami" },
  { id: "aisou-pro", name: "Aisou智充", entry_url: "https://aisou.pro/", collection_method: "http", collector_kind: "kami" },
  { id: "caowo-store", name: "GPT专卖-cw", entry_url: "https://caowo.store/", collection_method: "http", collector_kind: "kami" },
  { id: "fk-gptkt-pro", name: "fk.gptkt.pro", entry_url: "https://fk.gptkt.pro/", collection_method: "http", collector_kind: "kami" },
  { id: "auto-subscribe", name: "Auto Subscribe", entry_url: "https://shop.auto-subscribe.com/", collection_method: "http", collector_kind: "dujiao" },
  { id: "opensora-aifk", name: "AUTO FK", entry_url: "https://aifk.opensora.de/", collection_method: "http", collector_kind: "opensoraHtml" },
  { id: "makerich-club", name: "AI创富俱乐部", entry_url: "https://makerich.club/", collection_method: "http", collector_kind: "makerichHtml" },
  { id: "ldxp-jinyao", name: "LDXP 金钥", entry_url: "https://pay.ldxp.cn/shop/jinyao", collection_method: "http", collector_kind: "shopApi" },
  { id: "ldxp-pixelshop", name: "LDXP Pixelshop", entry_url: "https://pay.ldxp.cn/shop/pixelshop", collection_method: "http", collector_kind: "shopApi" },
  { id: "qxvx-pay", name: "QXVX Pay", entry_url: "https://pay.qxvx.cn/", collection_method: "http", collector_kind: "shopApi" },
];

export async function runPriceCollection(options = {}) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const logger = options.silent ? null : console;
  const targets = await loadTargets();
  let selectedTargets = selectTargets(targets, options);
  if (!selectedTargets.length) {
    selectedTargets.push(...selectBuiltinTargets(options));
  }
  const candidateTargetCount = selectedTargets.length;

  if (!selectedTargets.length) {
    throw new Error("No matching supported sources. Use --list to inspect available collectors.");
  }

  const shopSchedule = await applyShopCollectionScheduler(selectedTargets, options, logger);
  selectedTargets = shopSchedule.targets;
  const proxyTargetCount = selectedTargets.filter((target) => {
    const host = normalizeHostname(target.baseUrl || target.sourceUrl);
    return target.kind === "shopApi" && shopApiProxyHostsFor(options).has(host);
  }).length;
  const proxyParallelism = shopApiProxyParallelismFor(options, proxyTargetCount);
  options = { ...options, shopApiProxyParallelism: proxyParallelism };
  logger?.log(`Shop API proxy lanes: ${proxyParallelism} for ${proxyTargetCount} eligible source(s).`);
  const planMode = isShopCollectionSchedulerPlanMode(options);
  const lockOwner = collectionLockOwner(options);
  const familyState = options.collectionFamilyState || createCollectionFamilyState(options);
  const writeQueue = options.post && !planMode ? createCrawlLogWriteQueue(options, logger) : null;

  const groups = targetGroupsForCollection(selectedTargets, options);
  const concurrency = concurrencyFor(options);
  if (planMode) {
    const finishedAt = new Date().toISOString();
    const performance = buildCollectionPerformanceReport({
      summary: [],
      targets: selectedTargets,
      groups,
      concurrency,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedAtMs,
      shopSchedule: shopSchedule.summary,
    });

    return {
      summary: [],
      performance,
      scheduler: shopSchedule.summary,
      targetCount: selectedTargets.length,
      candidateTargetCount,
      successCount: 0,
      failureCount: 0,
      skippedCount: shopSchedule.summary.skippedCount || 0,
      offerCount: 0,
      startedAt,
      finishedAt,
    };
  }

  let summary;
  try {
    if (writeQueue) {
      await writeQueue.replaySpool("startup").catch((error) => {
        logger?.error(`Failed to replay crawl log spool: ${errorMessage(error)}`);
      });
    }

    if (options.post) {
      await postCollectorHeartbeat("running", options, {
        startedAt,
        message: `Price collector started for ${selectedTargets.length} source(s).`,
        details: {
          targetCount: selectedTargets.length,
          groupCount: groups.length,
          concurrency,
          shopScheduler: shopSchedule.summary,
        },
      }).catch((error) => {
        logger?.error(`Failed to post collector heartbeat: ${errorMessage(error)}`);
      });
    }

    summary = (await runWithConcurrency(
      groups,
      concurrency,
      async (group) => {
        const results = [];
        const shopApiProxyReusePool = createShopApiProxyReusePool(options);
        const groupOptions = { ...options, shopApiProxyReusePool };
        try {
          for (const target of group.targets) {
            const result = await collectOneTarget(target, groupOptions, logger, lockOwner, familyState, writeQueue);
            results.push(result);

            const familyPause = collectionFamilyRunPauseReason(target, familyState);
            if (familyPause) {
              logger?.log(`Paused ${familyPause.label}: ${familyPause.message}`);
              break;
            }
          }
        } finally {
          await closeShopApiProxyReusePool(shopApiProxyReusePool);
        }
        return results;
      },
    )).flat();
  } catch (error) {
    if (options.post) {
      await postCollectorHeartbeat("failed", options, {
        startedAt,
        finishedAt: new Date().toISOString(),
        failureCount: 1,
        message: errorMessage(error),
        details: {
          phase: "collection",
          targetCount: selectedTargets.length,
          groupCount: groups.length,
          shopScheduler: shopSchedule.summary,
        },
      }).catch((heartbeatError) => {
        logger?.error(`Failed to post collector failure heartbeat: ${errorMessage(heartbeatError)}`);
      });
    }
    throw error;
  } finally {
    if (writeQueue) {
      try {
        await writeQueue.flush("final", { persistOnFailure: true });
      } catch (error) {
        if (options.post) {
          const heartbeat = collectorHeartbeatForWritebackFailure(summary, error);
          await postCollectorHeartbeat(heartbeat.status, options, {
            startedAt,
            finishedAt: new Date().toISOString(),
            successCount: heartbeat.successCount,
            failureCount: heartbeat.failureCount,
            offerCount: heartbeat.offerCount,
            message: heartbeat.message,
            details: {
              phase: "crawl-log-final-flush",
              collectionCompleted: heartbeat.collectionCompleted,
              writebackPending: heartbeat.spoolPersisted,
              spoolPersisted: heartbeat.spoolPersisted,
              targetCount: selectedTargets.length,
              groupCount: groups.length,
              shopScheduler: shopSchedule.summary,
            },
          }).catch((heartbeatError) => {
            logger?.error(`Failed to post collector failure heartbeat: ${errorMessage(heartbeatError)}`);
          });
        }
        throw error;
      }
    }
  }

  try {
    if (writeQueue) writeQueue.throwIfFailed();
  } catch (error) {
    if (options.post) {
      const heartbeat = collectorHeartbeatForWritebackFailure(summary, error);
      await postCollectorHeartbeat(heartbeat.status, options, {
        startedAt,
        finishedAt: new Date().toISOString(),
        successCount: heartbeat.successCount,
        failureCount: heartbeat.failureCount,
        offerCount: heartbeat.offerCount,
        message: heartbeat.message,
        details: {
          phase: "crawl-log-flush",
          collectionCompleted: heartbeat.collectionCompleted,
          writebackPending: heartbeat.spoolPersisted,
          spoolPersisted: heartbeat.spoolPersisted,
          targetCount: selectedTargets.length,
          groupCount: groups.length,
          shopScheduler: shopSchedule.summary,
        },
      }).catch((heartbeatError) => {
        logger?.error(`Failed to post collector failure heartbeat: ${errorMessage(heartbeatError)}`);
      });
    }
    throw error;
  }

  const finishedAt = new Date().toISOString();
  const performance = buildCollectionPerformanceReport({
    summary,
    targets: selectedTargets,
    groups,
    concurrency,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedAtMs,
    shopSchedule: shopSchedule.summary,
  });
  const scheduleSkippedCount = shopSchedule.summary.skippedCount || 0;

  const result = {
    summary,
    performance,
    scheduler: shopSchedule.summary,
    targetCount: selectedTargets.length,
    candidateTargetCount,
    successCount: summary.filter((item) => item.status === "success").length,
    failureCount: summary.filter((item) => item.status !== "success" && item.status !== "skipped").length,
    skippedCount: summary.filter((item) => item.status === "skipped").length + scheduleSkippedCount,
    offerCount: summary.reduce((sum, item) => sum + item.offers, 0),
    startedAt,
    finishedAt,
  };

  if (options.post) {
    await postCollectorHeartbeat(collectorHeartbeatStatusForResult(result), options, {
      startedAt,
      finishedAt,
      successCount: result.successCount,
      failureCount: result.failureCount,
      skippedCount: result.skippedCount,
      offerCount: result.offerCount,
      message: `Price collector finished: ${result.successCount} success, ${result.failureCount} failed, ${result.skippedCount} skipped.`,
      details: {
        targetCount: result.targetCount,
        durationMs: performance.durationMs,
        byKind: performance.byKind,
        byStatus: performance.byStatus,
        shopScheduler: shopSchedule.summary,
      },
    }).catch((error) => {
      logger?.error(`Failed to post collector heartbeat: ${errorMessage(error)}`);
    });
  }

  return result;
}

async function collectOneTarget(target, options, logger, lockOwner, familyState, writeQueue = null) {
  const startedAt = Date.now();
  const collectionStartedAt = new Date(startedAt).toISOString();
  const skipped = (message) => ({
    sourceId: target.sourceId,
    source: target.sourceName,
    kind: target.kind,
    status: "skipped",
    offers: 0,
    attempts: 0,
    ms: Date.now() - startedAt,
    message,
  });

  const cooldown = cooldownSkipReason(target, options);
  if (cooldown) {
    logger?.log(`\n==> ${target.sourceName} [${target.kind}]`);
    logger?.log(`Skipped: ${cooldown.message}`);
    return skipped(cooldown.message);
  }

  const familySkip = collectionFamilySkipReason(target, familyState);
  if (familySkip) {
    logger?.log(`\n==> ${target.sourceName} [${target.kind}]`);
    logger?.log(`Skipped: ${familySkip.message}`);
    await postSkippedCrawlLog(target, familySkip, options, logger);
    return skipped(familySkip.message);
  }

  const lock = await acquireCollectionLock(target, lockOwner, options);
  if (!lock.acquired) {
    logger?.log(`\n==> ${target.sourceName} [${target.kind}]`);
    logger?.log(`Skipped: ${lock.message}`);
    return skipped(lock.message);
  }

  await waitForCollectionFamily(target, familyState, logger);
  markCollectionFamilyStarted(target, familyState);

  logger?.log(`\n==> ${target.sourceName} [${target.kind}]`);
  let releaseDeferred = false;
  const deferReleaseUntilWriteback = target.collectionGroup === "vip_15m";

  try {
    const collection = await collectTargetWithRetries(target, options, logger);
    const collectedAt = new Date().toISOString();
    const offers = collection.offers;
    const emptyFullSnapshot = !offers.length && isEmptyResultFullSnapshotTarget(target, collection.details);
    const status = offers.length || emptyFullSnapshot ? "success" : "failed";
    const message = offers.length
      ? `HTTP collector found ${offers.length} offers after ${collection.attempts.length} attempt(s).`
      : emptyFullSnapshot
        ? `HTTP collector found no offers after ${collection.attempts.length} attempt(s); treating as a complete empty snapshot.`
        : `HTTP collector found no offers after ${collection.attempts.length} attempt(s).`;

    if (logger) printOfferPreview(offers);

    if (options.post) {
      const posted = await postCrawlLogBatched(target, offers, status, message, options, {
        collectionStartedAt,
        collectedAt,
        attempts: collection.attempts,
        maxAttempts: collection.maxAttempts,
        ...(collection.details || {}),
      }, writeQueue, deferReleaseUntilWriteback
        ? async () => { await releaseCollectionLock(target, lockOwner, logger); }
        : null);
      if (posted.queued) {
        releaseDeferred = deferReleaseUntilWriteback;
        logger?.log(`Queued ${posted.successCount} offers for batched write.`);
      } else {
        logger?.log(
          `Posted ${posted.successCount} offers` +
            (posted.writtenCount !== undefined
              ? `, wrote ${posted.writtenCount}, refreshed ${posted.refreshedCount || 0}, unchanged ${posted.unchangedCount || 0}.`
              : "."),
        );
      }
    }

    recordCollectionFamilyResult(target, familyState, { status, message, attempts: collection.attempts });
    return {
      sourceId: target.sourceId,
      source: target.sourceName,
      kind: target.kind,
      status,
      offers: offers.length,
      attempts: collection.attempts.length,
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    const collectedAt = new Date().toISOString();
    const message = errorMessage(error);
    const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
    logger?.error(`Failed: ${message}`);
    recordCollectionFamilyResult(target, familyState, { status: "failed", message, attempts, logger });

    if (options.post) {
      await postCrawlLog(target, [], "failed", message, options, {
        collectionStartedAt,
        collectedAt,
        attempts,
        maxAttempts: maxAttemptsFor(options),
      }).catch((postError) => {
        logger?.error(`Failed to post failure log: ${errorMessage(postError)}`);
      });
    }

    return {
      sourceId: target.sourceId,
      source: target.sourceName,
      kind: target.kind,
      status: "failed",
      offers: 0,
      attempts: attempts.length || maxAttemptsFor(options),
      ms: Date.now() - startedAt,
      message,
    };
  } finally {
    if (!releaseDeferred) await releaseCollectionLock(target, lockOwner, logger);
  }
}

export async function probeSource(options = {}) {
  const sourceUrl = options.sourceUrl || options.entryUrl || options.url;
  if (!sourceUrl) throw new Error("Missing sourceUrl.");

  const sourceName = options.sourceName || options.name || sourceNameFromUrl(sourceUrl);
  const source = {
    id: options.sourceId || options.id || sourceIdFrom(sourceName, sourceUrl),
    name: sourceName,
    base_url: options.baseUrl || deriveBaseUrl(sourceUrl),
    entry_url: sourceUrl,
    collection_method: "http",
    collector_kind: options.collectorKind || options.kind || null,
  };
  const target = buildTarget(source, Array.isArray(options.rawOffers) ? options.rawOffers : []);
  const startedAt = Date.now();
  const limit = Math.max(1, Math.min(Number(options.limit || 12), 50));

  if (!target.kind) {
    const detected = shouldAutoDetectCollector(options)
      ? await detectCollectorByProbe(target, options)
      : null;
    if (detected?.offers?.length) {
      return probeSuccessResponse(detected.target, detected.offers, startedAt, limit, {
        attempts: detected.attempts,
        message: `自动试探成功，识别到 ${detected.target.kind} 采集器，采集到 ${detected.offers.length} 条报价。`,
      });
    }

    return {
      sourceId: target.sourceId,
      sourceName: target.sourceName,
      sourceUrl: target.sourceUrl,
      baseUrl: target.baseUrl,
      kind: null,
      status: "unsupported",
      offerCount: 0,
      offers: [],
      attempts: detected?.attempts || [],
      ms: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
      message: detected?.attempts?.length
        ? "已尝试现有 HTTP 采集器，但没有识别到可比价商品；若渠道真实，请加入采集器待办，补解析脚本后重新试采集。"
        : "当前链接暂未识别到自动采集器。若渠道真实，请加入采集器待办，补解析脚本后重新试采集。",
    };
  }

  try {
    const offers = dedupeOffers(await collectTarget(target, options));
    if (offers.length || !shouldFallbackDetectCollector(options, target.kind)) {
      return probeSuccessResponse(target, offers, startedAt, limit);
    }

    const detected = await detectCollectorByProbe(target, options, [target.kind]);
    if (detected?.offers?.length) {
      return probeSuccessResponse(detected.target, detected.offers, startedAt, limit, {
        attempts: detected.attempts,
        message: `原解析器 ${target.kind} 返回空结果，已自动试出 ${detected.target.kind} 采集器，采集到 ${detected.offers.length} 条报价。`,
      });
    }

    return probeSuccessResponse(target, offers, startedAt, limit, { attempts: detected?.attempts || [] });
  } catch (error) {
    if (shouldFallbackDetectCollector(options, target.kind)) {
      const detected = await detectCollectorByProbe(target, options, [target.kind]);
      if (detected?.offers?.length) {
        return probeSuccessResponse(detected.target, detected.offers, startedAt, limit, {
          attempts: detected.attempts,
          message: `原解析器 ${target.kind} 失败，已自动试出 ${detected.target.kind} 采集器，采集到 ${detected.offers.length} 条报价。`,
        });
      }
    }

    return {
      sourceId: target.sourceId,
      sourceName: target.sourceName,
      sourceUrl: target.sourceUrl,
      baseUrl: target.baseUrl,
      kind: target.kind,
      status: "failed",
      offerCount: 0,
      offers: [],
      ms: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
      message: errorMessage(error),
    };
  }
}

async function detectCollectorByProbe(target, options = {}, skipKinds = []) {
  const attempts = [];
  const skip = new Set(skipKinds.filter(Boolean));
  const candidates = collectorProbeCandidates(target).filter((kind) => !skip.has(kind));

  for (const kind of candidates) {
    const probeTarget = { ...target, kind, configuredKind: target.configuredKind || "auto" };
    const startedAt = Date.now();
    try {
      const offers = dedupeOffers(await collectTarget(probeTarget, { ...options, pageDelayMs: options.pageDelayMs ?? 0 }));
      attempts.push({
        kind,
        status: offers.length ? "success" : "empty",
        offerCount: offers.length,
        ms: Date.now() - startedAt,
      });
      if (offers.length) return { target: probeTarget, offers, attempts };
    } catch (error) {
      attempts.push({
        kind,
        status: "failed",
        offerCount: 0,
        ms: Date.now() - startedAt,
        message: errorMessage(error).slice(0, 240),
      });
    }
  }

  return { attempts };
}

function collectorProbeCandidates(target) {
  const candidates = [];
  const add = (kind) => {
    if (!candidates.includes(kind)) candidates.push(kind);
  };

  const url = safeUrl(target.sourceUrl);
  const text = `${target.sourceId} ${target.sourceName} ${target.sourceUrl}`.toLowerCase();
  if (shopTokenFromUrl(target.sourceUrl) || target.rawOffers.some((offer) => goodsKeyFromUrl(offer.url))) add("shopApi");
  if (text.includes("dujiao") || text.includes("独角")) add("dujiao");
  if (text.includes("kami") || text.includes("发卡")) add("kami");
  if (url?.pathname.match(/\/(?:product|products|goods|item)\//i)) add("genericHtml");

  for (const kind of AUTO_DETECT_COLLECTOR_KINDS) add(kind);
  return candidates;
}

function shouldAutoDetectCollector(options = {}) {
  return options.autoDetect !== false && options["auto-detect"] !== "false";
}

function shouldFallbackDetectCollector(options = {}, currentKind = null) {
  if (!shouldAutoDetectCollector(options)) return false;
  if (!currentKind || currentKind === "browser" || currentKind === "unsupported") return true;
  return options.fallbackDetect === true || options["fallback-detect"] === true;
}

function probeSuccessResponse(target, offers, startedAt, limit, extra = {}) {
  return {
    sourceId: target.sourceId,
    sourceName: target.sourceName,
    sourceUrl: target.sourceUrl,
    baseUrl: target.baseUrl,
    kind: target.kind,
    status: offers.length ? "success" : "empty",
    offerCount: offers.length,
    offers: offers.slice(0, limit),
    attempts: extra.attempts || [],
    ms: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
    message: extra.message || (offers.length
      ? `试采集成功，识别到 ${offers.length} 条报价。`
      : "已连接到采集器，但没有识别到可比价商品。"),
  };
}

export {
  applySourceBuyerFeePolicy,
  applyShopCollectionScheduler,
  assignShopCollectionSchedulerShard,
  classifyShopCollectionScheduleTier,
  blackcatWholesaleActionIdFromChunk,
  blockShopApiDirectExitForTarget,
  calculateShopApiBuyerAdjustment,
  collectorHeartbeatForWritebackFailure,
  cooldownSkipReason,
  createShopApiProxyReusePool,
  createShopApiVisitorId,
  closeShopApiProxyReusePool,
  discardShopApiProxyReuseForTarget,
  collectDujiaoProducts,
  collectGenericHtml,
  collectGenericHtmlProductCards,
  collectKamiItems,
  collectTargetWithRetries,
  extractProxyLeaseFromPayload,
  isDailyProbeFailure,
  isWeeklyProbeFailure,
  isShopApiDirectExitBlockedForTarget,
  isShopApiExitErrorMessage,
  isShopApiProxyTransportErrorMessage,
  isLdxpFailoverErrorMessage,
  isGenericProductDetailHref,
  isEmptyResultFullSnapshotTarget,
  kamiInventoryFromStock,
  normalizeLdxpRuntimeSettings,
  normalizeShopApiItemOfferUrl,
  nextStorefrontLowestAvailableSpec,
  latestShopCollectionCrawlRunBySource,
  listShopCollectionPriceStats,
  rewriteLdxpUrlHost,
  resolveShopApiFeeModel,
  alternateLdxpHost,
  shopApiFullSnapshotEvidenceReliable,
  shopApiProxyContextFromReusePool,
  restoreShopApiProxyReusePool,
  shopApiSnapshotReportedGoodsCount,
  shopApiProductLevelFeeModel,
  loadTargets,
  acquireCollectionLock,
  releaseCollectionLock,
  postCrawlLog,
  selectBuiltinTargets,
  selectTargets,
  shopApiFeeModelFromChannelRate,
  shopApiProxyParallelismFor,
  shopApiStoredFeePolicy,
  shopCollectionScheduleTiming,
  shopCollectionSchedulerGroupMatches,
  shopCollectionScheduleReferenceAt,
  selectShopApiPreferredChannel,
  stableHashInt,
  stableOfferInputId,
};

if (isCli()) {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const targets = await loadTargets();
    printTargetList(hasTargetFilters(args) ? selectTargets(targets, { ...args, all: true }) : targets);
    process.exit(0);
  }

  runPriceCollection({
    ...args,
    all: Boolean(args.all),
    post: Boolean(args.post),
  })
    .then((result) => {
      console.log("\nSummary");
      console.table(result.summary);
      printCollectionPerformance(result.performance);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}

async function collectTarget(target, options = {}) {
  if (target.kind === "kami") return collectKamiLike(target, options);
  if (target.kind === "dujiao") return collectDujiaoNext(target);
  if (target.kind === "shopApi") return collectShopApi(target, options);
  if (target.kind === "xiaoheiwan") return collectXiaoheiwan(target);
  if (target.kind === "opensoraHtml") return collectOpensoraHtml(target);
  if (target.kind === "makerichHtml") return collectMakerichHtml(target);
  if (target.kind === "beibeiHtml") return collectBeibeiHtml(target);
  if (target.kind === "ikunloveApi") return collectIkunloveApi(target);
  if (target.kind === "getgptApi") return collectGetgptApi(target);
  if (target.kind === "publicProductsApi") return collectPublicProductsApi(target);
  if (target.kind === "shopUserProductsApi") return collectShopUserProductsApi(target, options);
  if (target.kind === "unicornHtml") return collectUnicornHtml(target, options);
  if (target.kind === "mooncakeCatalog") return collectMooncakeCatalog(target);
  if (target.kind === "blackcatWholesale") return collectBlackcatWholesale(target);
  if (target.kind === "genericHtml") return collectGenericHtml(target, options);

  throw new Error(`Unsupported collector kind: ${target.kind}`);
}

async function collectTargetWithRetries(target, options = {}, logger = null) {
  const maxAttempts = maxAttemptsFor(options);
  const attempts = [];
  let lastError = null;
  let shopApiProxyActive =
    shopApiProxyModeFor(options) !== "on_exit" ||
    isShopApiDirectExitBlockedForTarget(target, options);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const attemptOptions = target.kind === "shopApi"
      ? {
          ...options,
          shopApiProxyLogger: logger,
          ...(shopApiProxyActive ? {} : { shopApiProxyDisabled: true }),
        }
      : options;

    try {
      const collected = await collectTarget(target, attemptOptions);
      const collectionDetails = collected?.collectionDetails || null;
      const offers = dedupeOffers(collected);
      const message = offers.length
        ? `采集到 ${offers.length} 条报价。`
        : emptyCollectionFailureMessage(target, collectionDetails);
      attempts.push({
        attempt,
        status: offers.length ? "success" : "empty",
        offers: offers.length,
        ms: Date.now() - startedAt,
        message,
      });

      if (offers.length || isEmptyResultFullSnapshotTarget(target, collectionDetails)) {
        return { offers, attempts, maxAttempts, details: collectionDetails };
      }

      lastError = new Error(message);
    } catch (error) {
      const message = errorMessage(error);
      attempts.push({
        attempt,
        status: "failed",
        offers: 0,
        ms: Date.now() - startedAt,
        message,
      });
      lastError = error;
      const exitError = isShopApiExitErrorMessage(message);
      const proxyTransportError = isShopApiProxyTransportErrorMessage(message);
      const proxyWasActive =
        target.kind === "shopApi" &&
        shopApiProxyActive &&
        hasShopApiProxyConfigured(options);

      if (proxyWasActive && (exitError || proxyTransportError)) {
        await discardShopApiProxyReuseForTarget(target, options, {
          logger,
          reason: exitError ? "upstream-exit-error" : "proxy-transport-error",
        });
      }

      if (collectionFamilyForTarget(target) && exitError) {
        if (shopApiProxyModeFor(options) === "on_exit" && hasShopApiProxyConfigured(options) && !shopApiProxyActive) {
          shopApiProxyActive = true;
          blockShopApiDirectExitForTarget(target, options);
          logger?.log("Shop API direct exit returned wind-control/server pressure; switching the next retry to the proxy pool.");
        }
      }
    }

    if (attempt < maxAttempts) {
      if (shouldStopRetryingTarget(target, lastError)) break;

      const waitMs = retryDelayMs(attempt);
      logger?.log(`Retrying ${target.sourceName} in ${waitMs}ms (${attempt + 1}/${maxAttempts})...`);
      await delay(waitMs);
    }
  }

  const error = new Error(lastError ? errorMessage(lastError) : "采集失败。");
  error.attempts = attempts;
  throw error;
}

async function collectKamiLike(target, options = {}) {
  const offers = [];
  const base = target.baseUrl;

  for (let page = 1; page <= 10; page += 1) {
    await waitBetweenPages(options);
    const payload = await fetchJson(`${base}/user/api/index/commodity?limit=100&page=${page}`);
    const items = Array.isArray(payload.data) ? payload.data : [];
    if (!items.length) break;

    offers.push(...collectKamiItems(target, items));

    if (items.length < 100) break;
  }

  return offers;
}

function collectKamiItems(target, items) {
  const offers = [];

  for (const item of items) {
    const title = cleanText(item.name);
    const price = numberOrNull(item.user_price ?? item.price);
    if (!title || price === null || isNonComparableTitle(title)) continue;

    const inventory = kamiInventoryFromStock(item.stock);
    const hidden = Number(item.hide || 0) !== 0;
    const disabled = Number(item.status ?? 1) !== 1 || hidden;
    const status = disabled ? "out_of_stock" : inventory.status;
    const categoryName = cleanText(item.category?.name || "");

    offers.push(
      makeOffer(target, {
        title,
        price,
        status,
        stockCount: disabled && inventory.stockCount === null ? 0 : inventory.stockCount,
        url: kamiCommodityUrl(target, item.id),
        tags: compact([
          categoryName,
          item.delivery_way === 0 ? "自动发货" : null,
          hidden ? "隐藏商品" : null,
        ]),
      }),
    );
  }

  return offers;
}

function kamiInventoryFromStock(value) {
  const text = cleanText(value);
  const stockCount = numberOrNull(value);
  if (stockCount !== null) return { stockCount, status: statusFromStock(stockCount) };
  if (/即将售罄|库存紧张|库存较少/.test(text)) return { stockCount: null, status: "low_stock" };
  if (/已售罄|^售罄$|缺货|无货/.test(text)) return { stockCount: 0, status: "out_of_stock" };
  return { stockCount: null, status: "in_stock" };
}

async function collectDujiaoNext(target) {
  const payload = await fetchJson(`${target.baseUrl}/api/v1/public/products`);
  const products = Array.isArray(payload.data) ? payload.data : [];
  return collectDujiaoProducts(target, products);
}

function collectDujiaoProducts(target, products) {
  const offers = [];

  for (const product of products) {
    const productTitle = localized(product.title) || cleanText(product.slug);
    const skus = Array.isArray(product.skus) && product.skus.length ? product.skus : [null];

    skus.forEach((sku, index) => {
      const skuTitle = localized(sku?.title || sku?.name || sku?.label || sku?.spec);
      const title = cleanText(
        skuTitle && skuTitle !== productTitle
          ? `${productTitle} / ${skuTitle}`
          : skus.length > 1 && sku
            ? `${productTitle} / 规格${index + 1}`
            : productTitle,
      );
      const price = numberOrNull(sku?.price_amount ?? product.price_amount);
      if (!title || price === null || isNonComparableTitle(title)) return;

      const stockCount = numberOrNull(
        sku?.auto_stock_available ??
          sku?.manual_stock_available ??
          product.auto_stock_available ??
          product.manual_stock_available,
      );
      const isSoldOut = Boolean(sku?.is_sold_out ?? product.is_sold_out);
      const stockStatus = String(sku?.stock_status || product.stock_status || "");
      const status = isSoldOut || stockStatus === "out_of_stock" ? "out_of_stock" : statusFromStock(stockCount);
      const categoryName = localized(product.category?.name);

      offers.push(
        makeOffer(target, {
          title,
          price,
          status,
          stockCount,
          url: `${target.baseUrl}/products/${encodeURIComponent(String(product.slug || product.id))}`,
          tags: compact([
            categoryName,
            product.fulfillment_type === "auto" ? "自动发货" : null,
            product.fulfillment_type === "manual" ? "人工处理" : null,
          ]),
        }),
      );
    });
  }

  return offers;
}

async function collectShopApi(target, options = {}) {
  if (!isLdxpTarget(target) || ldxpRuntimeSettings.mode !== "auto") {
    return collectShopApiOnce(target, options);
  }
  const activeTarget = rewriteLdxpTargetHost(target, ldxpRuntimeSettings.activeHost);

  try {
    return await collectShopApiOnce(activeTarget, options);
  } catch (error) {
    if (!isLdxpFailoverErrorMessage(errorMessage(error))) throw error;
    const fromHost = normalizeHostname(activeTarget.baseUrl || activeTarget.sourceUrl);
    const toHost = alternateLdxpHost(fromHost);
    if (!toHost) throw error;

    const fallbackTarget = rewriteLdxpTargetHost(activeTarget, toHost);
    const collected = await collectShopApiOnce(fallbackTarget, options);
    await persistLdxpAutomaticSwitch(fromHost, toHost, `采集 ${target.sourceId} 失败后备用域名成功：${errorMessage(error)}`)
      .catch((persistError) => options.shopApiProxyLogger?.error?.(`Failed to persist LDXP host switch: ${errorMessage(persistError)}`));
    ldxpRuntimeSettings = {
      ...ldxpRuntimeSettings,
      activeHost: toHost,
      lastSwitchedAt: new Date().toISOString(),
      lastSwitchReason: errorMessage(error),
    };
    return collected;
  }
}

export async function probeShopApiSourceLightweight(source, options = {}) {
  const sourceUrl = String(
    source?.entry_url ||
    source?.entryUrl ||
    source?.sourceUrl ||
    source?.url ||
    "",
  ).trim();
  const token = shopTokenFromUrl(sourceUrl);
  if (!sourceUrl || !token) {
    throw new Error("轻量验证需要有效的 /shop/<店铺标识> 入口。");
  }

  const base = String(
    options.baseUrl ||
    source?.base_url ||
    source?.baseUrl ||
    deriveBaseUrl(sourceUrl),
  ).replace(/\/$/, "");
  const pageSize = integerInRange(
    options.pageSize || options["page-size"],
    1,
    SHOP_API_LIST_PAGE_SIZE,
    20,
  );
  const requestJson = options.requestJson || options.shopApiRequestJson || postJson;
  const shopInfoUrl = `${base}/shopApi/Shop/info`;
  const shopInfo = await requestJson(
    shopInfoUrl,
    { token, category_key: "" },
    sourceUrl,
    null,
  );
  if (shopInfo?.code !== 1 || !shopInfo?.data) {
    const message = cleanText(shopInfo?.msg || shopInfo?.message);
    throw new Error(`${shopInfoUrl} 未返回可用店铺信息${message ? `：${message}` : ""}`);
  }

  const shopUrl = shopInfo.data.link || sourceUrl;
  const goodsListUrl = `${base}/shopApi/Shop/goodsList`;
  const goodsList = await requestJson(
    goodsListUrl,
    {
      token,
      keywords: "",
      category_id: 0,
      goods_type: "card",
      current: 1,
      pageSize,
    },
    shopUrl,
    null,
  );
  if (goodsList?.code !== 1 || !Array.isArray(goodsList?.data?.list)) {
    const message = cleanText(goodsList?.msg || goodsList?.message);
    throw new Error(`${goodsListUrl} 未返回可用商品列表${message ? `：${message}` : ""}`);
  }

  const items = goodsList.data.list;
  const comparableItems = items.filter((item) =>
    cleanText(item?.name) &&
    numberOrNull(item?.price ?? item?.real_price) !== null
  );
  return {
    sourceId: source?.id || source?.sourceId || null,
    sourceName: source?.name || source?.sourceName || null,
    storeName: cleanText(shopInfo.data.nickname || source?.name || source?.sourceName),
    shopUrl,
    requestCount: 2,
    pageSize,
    itemCount: items.length,
    comparableItemCount: comparableItems.length,
    reportedItemCount: nonNegativeInteger(goodsList.data.total),
    samples: comparableItems.slice(0, 3).map((item) => ({
      title: cleanText(item.name),
      price: numberOrNull(item.price ?? item.real_price),
      stockCount: numberOrNull(item.extend?.stock_count),
    })),
  };
}

export async function verifyShopApiOffer(target, currentOffer, options = {}) {
  const itemUrl = normalizeShopApiItemOfferUrl(currentOffer?.url) || currentOffer?.url;
  const goodsKey = goodsKeyFromUrl(itemUrl);
  if (!goodsKey) {
    return {
      status: "inconclusive",
      route: "none",
      message: "未能从报价链接识别 ShopApi 商品编号。",
      offer: null,
    };
  }

  const activeTarget = {
    ...target,
    baseUrl: deriveBaseUrl(itemUrl) || target.baseUrl,
  };
  const proxyMode = shopApiProxyModeFor(options);
  let useProxy = proxyMode !== "on_exit" || isShopApiDirectExitBlockedForTarget(activeTarget, options);
  const attempts = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptOptions = {
      ...options,
      shopApiProxyLogger: options.shopApiProxyLogger || console,
      ...(useProxy ? {} : { shopApiProxyDisabled: true }),
    };
    try {
      const result = await verifyShopApiOfferOnce(activeTarget, currentOffer, goodsKey, itemUrl, attemptOptions);
      return { ...result, attempts };
    } catch (error) {
      const message = errorMessage(error);
      attempts.push({ attempt, route: useProxy ? "proxy" : "direct", message });
      if (
        !useProxy &&
        proxyMode === "on_exit" &&
        hasShopApiProxyConfigured(options) &&
        isShopApiExitErrorMessage(message)
      ) {
        useProxy = true;
        blockShopApiDirectExitForTarget(activeTarget, options);
        options.shopApiProxyLogger?.log?.("Hot verifier direct exit failed; retrying through the shared proxy pool.");
        continue;
      }
      if (useProxy && (isShopApiExitErrorMessage(message) || isShopApiProxyTransportErrorMessage(message))) {
        await discardShopApiProxyReuseForTarget(activeTarget, options, {
          logger: options.shopApiProxyLogger,
          reason: isShopApiExitErrorMessage(message) ? "upstream-exit-error" : "proxy-transport-error",
        });
      }
      throw error;
    }
  }

  return {
    status: "inconclusive",
    route: useProxy ? "proxy" : "direct",
    message: "单链接核验未得到明确结果。",
    offer: null,
    attempts,
  };
}

async function verifyShopApiOfferOnce(target, currentOffer, goodsKey, itemUrl, options = {}) {
  const proxyContext = await createShopApiProxyContext(target, options);
  const requestOptions = proxyContext ? { dispatcher: proxyContext.dispatcher } : null;
  const route = proxyContext ? "proxy" : "direct";

  try {
    const requestJson = options.shopApiRequestJson || postJson;
    const payload = await requestJson(
      `${target.baseUrl}/shopApi/Shop/goodsInfo`,
      { goods_key: goodsKey, trade_no: "" },
      itemUrl,
      requestOptions,
    );
    const message = cleanText(payload?.msg || payload?.message || "");
    const data = payload?.data?.goods || payload?.data?.item || payload?.data || null;

    if (!data) {
      if (isShopApiExitErrorMessage(message)) throw new Error(message);
      if (isShopApiClosedMessage(message) || isShopApiRemovedMessage(message)) {
        return {
          status: "verified",
          route,
          message: message || "源站明确返回商品不可购买。",
          offer: hotShopApiUnavailableOffer(target, currentOffer, itemUrl, message || "商品未上架"),
        };
      }
      return {
        status: "inconclusive",
        route,
        message: message || "商品接口未返回详情，暂不改变公开状态。",
        offer: null,
      };
    }

    const listedPrice = numberOrNull(data.price ?? data.real_price ?? currentOffer?.listedPrice ?? currentOffer?.price);
    const stockCount = numberOrNull(data.extend?.stock_count ?? data.stock ?? data.inventory);
    const itemStatus = numberOrNull(data.status ?? data.state);
    const explicitlyUnavailable = itemStatus !== null && itemStatus !== 1;
    const closed = isShopApiClosedMessage(message);
    const outOfStock = explicitlyUnavailable || stockCount === 0 || isShopApiRemovedMessage(message);
    const pricing = hotShopApiPricing(target, currentOffer, listedPrice);
    const title = cleanText(data.name || data.goods_name || currentOffer?.sourceTitle || "");

    if (!title || pricing.price === null) {
      return {
        status: "inconclusive",
        route,
        message: "商品详情缺少可验证的标题或价格，暂不改变公开状态。",
        offer: null,
      };
    }

    return {
      status: "verified",
      route,
      message: closed
        ? message || "店铺已打烊。"
        : outOfStock
          ? message || "源站明确返回无库存或未上架。"
          : "源站商品详情核验成功。",
      offer: makeOffer(target, {
        title,
        price: pricing.price,
        listedPrice: pricing.listedPrice,
        feeAmount: pricing.feeAmount,
        priceBasis: pricing.priceBasis,
        status: outOfStock ? "out_of_stock" : statusFromStock(stockCount),
        effectiveStatus: closed || outOfStock ? "unavailable" : "available",
        freshnessStatus: "fresh",
        failureReason: closed || outOfStock ? `热门报价核验：${message || "源站明确不可购买"}` : null,
        stockCount,
        minOrderQuantity: shopApiMinOrderQuantity(data.extend?.limit_count ?? data.limit_count),
        bulkPricingTiers: Array.isArray(data.multipleoffers)
          ? shopApiBulkPricingTiers(data.multipleoffers)
          : currentOffer?.bulkPricingTiers || [],
        url: itemUrl,
        tags: Array.isArray(currentOffer?.tags) ? currentOffer.tags : [],
      }),
    };
  } finally {
    if (!proxyContext?.shared && proxyContext?.dispatcher?.close) {
      await proxyContext.dispatcher.close().catch(() => {});
    }
  }
}

function hotShopApiUnavailableOffer(target, currentOffer, itemUrl, reason) {
  return makeOffer(target, {
    title: currentOffer?.sourceTitle || "已下架商品",
    price: numberOrNull(currentOffer?.price),
    listedPrice: numberOrNull(currentOffer?.listedPrice),
    feeAmount: numberOrNull(currentOffer?.feeAmount),
    priceBasis: currentOffer?.priceBasis || null,
    status: "out_of_stock",
    effectiveStatus: "unavailable",
    freshnessStatus: "fresh",
    failureReason: `热门报价核验：${reason}`,
    stockCount: 0,
    minOrderQuantity: currentOffer?.minOrderQuantity ?? null,
    bulkPricingTiers: currentOffer?.bulkPricingTiers || [],
    url: itemUrl,
    tags: Array.isArray(currentOffer?.tags) ? currentOffer.tags : [],
  });
}

function hotShopApiPricing(target, currentOffer, listedPrice) {
  if (listedPrice === null) {
    return {
      price: numberOrNull(currentOffer?.price),
      listedPrice: numberOrNull(currentOffer?.listedPrice),
      feeAmount: numberOrNull(currentOffer?.feeAmount),
      priceBasis: currentOffer?.priceBasis || null,
    };
  }

  if (String(target?.buyerFeeStrategy || "") === "manual_verified") {
    return { price: listedPrice, listedPrice, feeAmount: 0, priceBasis: "listed" };
  }

  const previousListedPrice = numberOrNull(currentOffer?.listedPrice);
  const previousPrice = numberOrNull(currentOffer?.price);
  const priorBasis = String(currentOffer?.priceBasis || "");
  if (previousListedPrice && previousPrice !== null && ["modeled", "settled"].includes(priorBasis)) {
    const feeRate = (previousPrice - previousListedPrice) / previousListedPrice;
    if (feeRate >= 0 && feeRate <= 0.2) {
      const feeAmount = roundCurrency(listedPrice * feeRate);
      return {
        price: roundCurrency(listedPrice + feeAmount),
        listedPrice,
        feeAmount,
        priceBasis: priorBasis,
      };
    }
  }

  return { price: listedPrice, listedPrice, feeAmount: 0, priceBasis: "listed" };
}

function isShopApiClosedMessage(value) {
  return /店铺已打烊|店铺打烊|已打烊|暂停营业|停止营业|暂不营业/.test(String(value || ""));
}

function isShopApiRemovedMessage(value) {
  return /未上架|已下架|商品不存在|不存在该商品|已删除|停售|无此商品/.test(String(value || ""));
}

async function collectShopApiOnce(target, options = {}) {
  const base = target.baseUrl;
  const proxyContext = await createShopApiProxyContext(target, options);
  const requestOptions = proxyContext ? { dispatcher: proxyContext.dispatcher } : null;

  try {
    const tokens = await discoverShopTokens(target, options, requestOptions);
    const offers = [];
    const rawSeenOfferIds = new Set();
    const partialReasons = [];
    let fetchedItemCount = 0;
    let publishedItemCount = 0;
    let reportedGoodsCount = 0;
    let hasReportedGoodsCount = false;

    if (!tokens.length) {
      throw new Error("No shop token found. Need at least one /shop/<token> or /item/<goods_key> URL.");
    }

    for (const token of tokens) {
      const shopInfo = await postJson(`${base}/shopApi/Shop/info`, { token, category_key: "" }, `${base}/shop/${token}`, requestOptions);
      if (shopInfo.code !== 1 || !shopInfo.data) {
        partialReasons.push(`Shop info unavailable for token ${token}.`);
        continue;
      }

      const shopAvailability = shopApiShopAvailability(shopInfo.data);
      const storeName = cleanText(shopInfo.data.nickname || target.sourceStoreName || target.sourceName);
      const sourceUrl = shopInfo.data.link || `${base}/shop/${token}`;
      const shopCreatedAt = timestampFromShopApiValue(shopInfo.data.create_time);
      const useAllGoodsList = shopApiAllGoodsListEnabled(options);
      const pricingSummaries = [];

      if (useAllGoodsList) {
        const shopReportedGoods = shopApiReportedGoodsCount(shopInfo.data);

        const listResult = await fetchShopApiGoodsListPages({
          base,
          token,
          sourceUrl,
          categoryId: 0,
          options,
          requestOptions,
        });
        partialReasons.push(...listResult.partialReasons);
        fetchedItemCount += listResult.items.length;
        const reportedGoods = shopApiSnapshotReportedGoodsCount(listResult.reportedTotal, shopReportedGoods);
        if (reportedGoods !== null) {
          reportedGoodsCount += reportedGoods;
          hasReportedGoodsCount = true;
        }

        const priceResolver = await createShopApiSampledPriceResolver({
          target,
          base,
          token,
          sourceUrl,
          items: listResult.items,
          options,
          requestOptions,
        });
        pricingSummaries.push(priceResolver.summary);

        for (const item of listResult.items) {
          const offer = makeShopApiOfferFromItem({
            target,
            base,
            item,
            sourceUrl,
            storeName,
            shopCreatedAt,
            shopAvailability,
            priceResolver,
          });
          if (!offer) continue;

          const rawSeenOfferId = stableShopApiOfferIdFromUrl(offer.url);
          if (rawSeenOfferId) rawSeenOfferIds.add(rawSeenOfferId);
          offers.push(offer);
          publishedItemCount += 1;
        }

        if (reportedGoods !== null && listResult.items.length !== reportedGoods) {
          partialReasons.push(
            `All-goods list reported ${reportedGoods} goods but fetched ${listResult.items.length}.`,
          );
        }

        offers.collectionDetails = {
          ...(offers.collectionDetails || {}),
          shopApiListMode: "all_goods",
          shopApiPricing: pricingSummaries,
        };
        continue;
      }

      const defaultChannelId = await getShopApiDefaultChannelId(base, token, sourceUrl, options, requestOptions);
      const categoriesPayload = await postJson(
        `${base}/shopApi/Shop/categoryList`,
        { token, goods_type: "card", category_key: "" },
        sourceUrl,
        requestOptions,
      );
      if (categoriesPayload.code !== 1 || !Array.isArray(categoriesPayload.data)) {
        partialReasons.push(`Category list unavailable for token ${token}.`);
      }
      const categories = Array.isArray(categoriesPayload.data) ? categoriesPayload.data : [];
      const selectedCategories = categories.filter((category) => Number(category.goods_count || 0) > 0 && Number(category.id) !== 0);
      const categoryIds = selectedCategories.length
        ? selectedCategories.map((category) => Number(category.id))
        : categories.some((category) => Number(category.id) === 0)
          ? [0]
          : [];

      for (const categoryId of categoryIds) {
        const expectedItemCount = reportedGoodsCountForCategory(categories, selectedCategories, categoryId);
        let categoryFetchedItemCount = 0;
        if (expectedItemCount !== null) {
          reportedGoodsCount += expectedItemCount;
          hasReportedGoodsCount = true;
        }

        for (let page = 1; page <= SHOP_API_MAX_CATEGORY_PAGES; page += 1) {
          await waitBetweenPages(options);
          const listPayload = await postJson(
            `${base}/shopApi/Shop/goodsList`,
            {
              token,
              keywords: "",
              category_id: categoryId,
              goods_type: "card",
              current: page,
              pageSize: SHOP_API_LIST_PAGE_SIZE,
            },
            sourceUrl,
            requestOptions,
          );
          if (listPayload.code !== 1 || !Array.isArray(listPayload.data?.list)) {
            partialReasons.push(`Goods list unavailable for category ${categoryId} page ${page}.`);
            break;
          }

          const items = listPayload.data.list;
          if (!items.length) break;
          fetchedItemCount += items.length;
          categoryFetchedItemCount += items.length;
          if (page === SHOP_API_MAX_CATEGORY_PAGES && items.length >= SHOP_API_LIST_PAGE_SIZE) {
            partialReasons.push(`Category ${categoryId} reached page cap ${SHOP_API_MAX_CATEGORY_PAGES}.`);
          }

          for (const item of items) {
            const title = cleanText(item.name);
            const listedPrice = numberOrNull(item.price ?? item.real_price);
            if (!title || listedPrice === null || isNonComparableTitle(title)) continue;

            const itemUrl = item.link || (item.goods_key ? `${base}/item/${item.goods_key}` : "");
            const rawSeenOfferId = stableShopApiOfferIdFromUrl(itemUrl);
            if (rawSeenOfferId) rawSeenOfferIds.add(rawSeenOfferId);

            const effectivePrice = await resolveShopApiEffectivePrice({
              base,
              goodsKey: item.goods_key,
              listedPrice,
              channelId: defaultChannelId,
              referer: item.link || sourceUrl,
              options,
              requestOptions,
            });

            const offer = makeShopApiOfferFromItem({
              target,
              base,
              item,
              sourceUrl,
              storeName,
              shopCreatedAt,
              shopAvailability,
              priceResolver: {
                priceFor: () => effectivePrice,
              },
            });
            if (!offer) continue;

            offers.push(offer);
            publishedItemCount += 1;
          }

          if (items.length < 100) break;
        }

        if (expectedItemCount !== null && categoryFetchedItemCount !== expectedItemCount) {
          partialReasons.push(
            `Category ${categoryId} reported ${expectedItemCount} goods but fetched ${categoryFetchedItemCount}.`,
          );
        }
      }
    }

    offers.collectionDetails = {
      fullSnapshot: partialReasons.length === 0,
      seenOfferIds: Array.from(rawSeenOfferIds),
      rawSeenOfferCount: rawSeenOfferIds.size,
      fetchedItemCount,
      publishedItemCount,
      reportedGoodsCount: hasReportedGoodsCount ? reportedGoodsCount : null,
      partialReason: partialReasons.join(" "),
      shopApiListMode: shopApiAllGoodsListEnabled(options) ? "all_goods" : "category",
      shopApiPricing: offers.collectionDetails?.shopApiPricing,
      shopApiRequestRoute: proxyContext ? "proxy" : "direct",
    };

    return offers;
  } finally {
    if (!proxyContext?.shared && proxyContext?.dispatcher?.close) {
      await proxyContext.dispatcher.close().catch(() => {});
    }
  }
}

function reportedGoodsCountForCategory(categories, selectedCategories, categoryId) {
  const category =
    selectedCategories.find((item) => Number(item.id) === Number(categoryId)) ||
    categories.find((item) => Number(item.id) === Number(categoryId));
  const value = Number(category?.goods_count);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function makeShopApiOfferFromItem({
  target,
  base,
  item,
  sourceUrl,
  storeName,
  shopCreatedAt,
  shopAvailability,
  priceResolver,
}) {
  const title = cleanText(item.name);
  const listedPrice = numberOrNull(item.price ?? item.real_price);
  if (!title || listedPrice === null || isNonComparableTitle(title)) return null;

  const itemUrl = item.link || (item.goods_key ? `${base}/item/${item.goods_key}` : "");
  const stockCount = numberOrNull(item.extend?.stock_count);
  const minOrderQuantity = shopApiMinOrderQuantity(item.extend?.limit_count);
  const bulkPricingTiers = shopApiBulkPricingTiers(item.multipleoffers);
  const status = Number(item.status ?? 1) !== 1 ? "out_of_stock" : statusFromStock(stockCount);
  const categoryName = cleanText(item.category?.name || "");
  const effectivePrice = priceResolver.priceFor(item, listedPrice, itemUrl || sourceUrl);

  return makeOffer(
    {
      ...target,
      sourceUrl,
      sourceEntryUrl: sourceUrl,
      sourceStoreName: storeName,
      sourceShopCreatedAt: shopCreatedAt,
    },
    {
      title,
      price: effectivePrice.price,
      listedPrice: effectivePrice.listedPrice,
      feeAmount: effectivePrice.feeAmount,
      priceBasis: effectivePrice.priceBasis,
      status,
      effectiveStatus: shopAvailability.closed ? "unavailable" : "available",
      failureReason: shopAvailability.closed ? shopAvailability.reason : null,
      stockCount,
      minOrderQuantity,
      bulkPricingTiers,
      url: normalizeShopApiItemOfferUrl(itemUrl) || itemUrl,
      tags: compact([
        categoryName,
        item.goods_type === "card" ? "卡密" : null,
        item.extend?.send_order === 0 ? "自动发货" : null,
      ]),
    },
  );
}

async function fetchShopApiGoodsListPages({ base, token, sourceUrl, categoryId, options = {}, requestOptions = null }) {
  const items = [];
  const partialReasons = [];
  let reportedTotal = null;

  for (let page = 1; page <= SHOP_API_MAX_CATEGORY_PAGES; page += 1) {
    await waitBetweenPages(options);
    const listPayload = await postJson(
      `${base}/shopApi/Shop/goodsList`,
      {
        token,
        keywords: "",
        category_id: categoryId,
        goods_type: "card",
        current: page,
        pageSize: SHOP_API_LIST_PAGE_SIZE,
      },
      sourceUrl,
      requestOptions,
    );
    if (listPayload.code !== 1 || !Array.isArray(listPayload.data?.list)) {
      partialReasons.push(`Goods list unavailable for category ${categoryId} page ${page}.`);
      break;
    }

    const pageReportedTotal = nonNegativeInteger(listPayload.data?.total);
    if (pageReportedTotal !== null) {
      if (reportedTotal === null) {
        reportedTotal = pageReportedTotal;
      } else if (reportedTotal !== pageReportedTotal) {
        partialReasons.push(
          `Goods list total changed from ${reportedTotal} to ${pageReportedTotal} on category ${categoryId} page ${page}.`,
        );
      }
    }

    const pageItems = listPayload.data.list;
    if (!pageItems.length) break;
    items.push(...pageItems);
    if (page === SHOP_API_MAX_CATEGORY_PAGES && pageItems.length >= SHOP_API_LIST_PAGE_SIZE) {
      partialReasons.push(`Category ${categoryId} reached page cap ${SHOP_API_MAX_CATEGORY_PAGES}.`);
    }
    if (pageItems.length < SHOP_API_LIST_PAGE_SIZE) break;
  }

  return { items, partialReasons, reportedTotal };
}

async function createShopApiSampledPriceResolver({ target, base, token, sourceUrl, items, options = {}, requestOptions = null }) {
  const forcedModel = shopApiForcedFeeModel(options);
  if (forcedModel) {
    return {
      summary: {
        sampleSize: 0,
        resolvedSampleSize: 0,
        strategy: `${forcedModel.kind}_forced`,
        rate: forcedModel.rate,
      },
      priceFor(_item, listedPrice) {
        return applyShopApiFeeModel(listedPrice, forcedModel);
      },
    };
  }

  const sampleSize = shopApiPriceSampleSizeFor(options);
  const sampleItems = selectShopApiPriceSampleItems(items, sampleSize);
  const sampledPrices = new Map();
  const sampleResults = [];
  const channel = await getShopApiDefaultChannel(base, token, sourceUrl, options, requestOptions);
  const channelId = channel.id;
  const storedFeePolicy = shopApiStoredFeePolicy(target?.shopApiFeePolicies, token, {
    allowHighPriceProbe: !shopApiNeedsProductLevelFee(base),
  });
  const productFeePolicy = storedFeePolicy || (shopApiNeedsProductLevelFee(base)
    ? null
    : await probeShopApiProductFeePolicy({
        base,
        token,
        sourceUrl,
        item: sampleItems[0] || items[0],
        options,
        requestOptions,
      }));

  if (shopApiNeedsProductLevelFee(base)) {
    for (const item of sampleItems) {
      const listedPrice = numberOrNull(item.price ?? item.real_price);
      if (listedPrice === null || !item.goods_key) continue;
      const effectivePrice = await resolveShopApiEffectivePrice({
        base,
        goodsKey: item.goods_key,
        listedPrice,
        channelId,
        referer: item.link || sourceUrl,
        options,
        requestOptions,
        normalizePriceWithFee: true,
      });
      sampledPrices.set(String(item.goods_key), effectivePrice);
      sampleResults.push({ item, listedPrice, effectivePrice });
    }
  }

  for (const item of shopApiNeedsProductLevelFee(base) || storedFeePolicy
    ? []
    : sampleItems) {
    const listedPrice = numberOrNull(item.price ?? item.real_price);
    if (listedPrice === null) continue;
    const effectivePrice = sampledPrices.get(String(item.goods_key)) || await resolveShopApiEffectivePrice({
      base,
      goodsKey: item.goods_key,
      listedPrice,
      channelId,
      referer: item.link || sourceUrl,
      options,
      requestOptions,
      normalizePriceWithFee: true,
    });
    if (item.goods_key) sampledPrices.set(String(item.goods_key), effectivePrice);
    sampleResults.push({ item, listedPrice, effectivePrice });
  }

  const sampledModel = inferShopApiFeeModel(sampleResults);
  const model = resolveShopApiFeeModel({
    productLevel: shopApiNeedsProductLevelFee(base),
    storedFeePolicy,
    productFeePolicy,
    sampleResults,
    channelRate: channel.rate,
  });
  const productPolicyResolved = !shopApiNeedsProductLevelFee(base) && !storedFeePolicy && productFeePolicy?.status === "confirmed";
  const sampledPolicyResolved = !shopApiNeedsProductLevelFee(base) && sampleResults.length > 0;
  const summary = {
    sampleSize: shopApiNeedsProductLevelFee(base) ? sampleResults.length : (sampleResults.length || (productFeePolicy?.goodsKey ? 1 : 0)),
    resolvedSampleSize: shopApiNeedsProductLevelFee(base) ? sampleResults.length : (sampledPolicyResolved ? sampleResults.length : productPolicyResolved ? 1 : 0),
    sampleSelection: storedFeePolicy
      ? "cached_policy"
      : shopApiNeedsProductLevelFee(base)
        ? sampleSize > 0 ? "high_price_probe" : "disabled"
        : sampleResults.length ? "high_price_probe" : productPolicyResolved ? "product_detail_probe" : "channel_config",
    strategy: model ? model.kind : "listed_fallback",
    rate: model?.rate ?? null,
    channelId,
    channelRate: channel.rate,
    policySource: shopApiNeedsProductLevelFee(base)
      ? inferShopApiFeeModel(sampleResults)?.rate > 0 ? "sampled_probe" : channel.rate !== null ? "channel_config" : "sampled_probe"
      : storedFeePolicy
        ? productFeePolicy?.source || "persisted"
        : sampledModel ? "sampled_probe" : productPolicyResolved ? productFeePolicy?.source || "product_detail_probe" : channel.rate !== null ? "channel_config" : "product_detail_probe",
    feePolicy: (storedFeePolicy || (productPolicyResolved && !sampledModel)) ? productFeePolicy : (model
      ? { status: "confirmed", hasFee: model.rate > 0, rate: model.rate, source: "channel_config" }
      : { status: "unknown", hasFee: null, rate: null, source: "product_detail_probe" }),
    probes: sampleResults.map(shopApiPriceProbeSummary),
  };

  return {
    summary,
    priceFor(item, listedPrice) {
      const sampled = item.goods_key ? sampledPrices.get(String(item.goods_key)) : null;
      if (shopApiNeedsProductLevelFee(base) && model) return applyShopApiFeeModel(listedPrice, model);
      if (sampled) return sampled;
      if (model) return applyShopApiFeeModel(listedPrice, model);
      return {
        price: listedPrice,
        listedPrice,
        feeAmount: null,
        priceBasis: "listed_fallback",
      };
    },
  };
}

function shopApiStoredFeePolicy(policies, token, options = {}) {
  const acceptedSelections = options.allowHighPriceProbe
    ? ["manual_verified", "product_detail_probe", "high_price_probe"]
    : ["manual_verified", "product_detail_probe"];
  const selected = (Array.isArray(policies) ? policies : []).find((policy) =>
    String(policy.shopToken ?? policy.shop_token ?? "") === String(token || "") &&
    acceptedSelections.includes(String(policy.sampleSelection ?? policy.sample_selection ?? "")) &&
    new Date(policy.expiresAt ?? policy.expires_at).getTime() > Date.now()
  );
  if (!selected) return null;
  const rate = numberOrNull(selected.rate);
  if (rate === null || rate < 0 || rate > 0.2) return null;
  return {
    status: "confirmed",
    hasFee: rate > 0,
    rate,
    source: "persisted",
    observedAt: selected.observedAt ?? selected.observed_at ?? null,
    expiresAt: selected.expiresAt ?? selected.expires_at ?? null,
    model: shopApiFeeModelFromFractionalRate(rate),
  };
}

async function probeShopApiProductFeePolicy({ base, token, sourceUrl, item, options = {}, requestOptions = null }) {
  if (!item?.goods_key) {
    return { status: "unknown", hasFee: null, rate: null, source: "product_detail_probe" };
  }

  await waitBetweenPages(options);
  const payload = await postJson(
    `${base}/shopApi/Shop/goodsInfo`,
    { goods_key: String(item.goods_key), trade_no: "", token },
    item.link || `${base}/item/${item.goods_key}` || sourceUrl,
    requestOptions,
  ).catch((error) => {
    if (isShopApiExitErrorMessage(errorMessage(error))) throw error;
    return null;
  });
  const data = payload?.data;
  const feeData = data?.goods || data?.item || data;
  const explicitHasFee = firstBoolean(feeData?.has_fee, feeData?.hasFee, feeData?.fee_enabled, feeData?.feeEnabled);
  const explicitRate = firstNumber(feeData?.fee_rate, feeData?.feeRate, feeData?.service_fee_rate, feeData?.serviceFeeRate);
  if (explicitHasFee !== null || explicitRate !== null) {
    const rate = explicitRate !== null ? explicitRate / (explicitRate > 1 ? 100 : 1) : (explicitHasFee ? SHOP_API_FIXED_FEE_RATE : 0);
    return {
      status: "confirmed",
      hasFee: explicitHasFee !== null ? explicitHasFee : rate > 0,
      rate,
      source: "product_detail_probe",
      goodsKey: String(item.goods_key),
      model: shopApiFeeModelFromFractionalRate(rate),
    };
  }
  return { status: "unknown", hasFee: null, rate: null, source: "product_detail_probe", goodsKey: String(item.goods_key) };
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1 || value === "0" || value === "1") return Number(value) === 1;
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function shopApiNeedsProductLevelFee(base) {
  return SHOP_API_PRODUCT_LEVEL_FEE_HOSTS.has(normalizeHostname(base));
}

function shopApiFeeModelFromChannelRate(rate) {
  const normalizedRate = Math.round(Number(rate) * 100) / 100;
  if (!Number.isFinite(normalizedRate) || normalizedRate < 0 || normalizedRate > 20) return null;
  if (closeCurrency(normalizedRate, 0)) return { kind: "no_fee", rate: 0 };
  if (closeCurrency(normalizedRate, 3)) return { kind: "fixed_3pct", rate: SHOP_API_FIXED_FEE_RATE };
  return { kind: "observed_rate", rate: normalizedRate / 100 };
}

function shopApiFeeModelFromFractionalRate(rate) {
  if (Math.abs(rate) <= 0.0001) return { kind: "no_fee", rate: 0 };
  if (Math.abs(rate - SHOP_API_FIXED_FEE_RATE) <= 0.0001) return { kind: "fixed_3pct", rate: SHOP_API_FIXED_FEE_RATE };
  return { kind: "observed_rate", rate };
}

function resolveShopApiFeeModel({ productLevel, storedFeePolicy, productFeePolicy, sampleResults, channelRate }) {
  if (productLevel) return shopApiProductLevelFeeModel(channelRate, sampleResults);
  if (storedFeePolicy) return storedFeePolicy.model;
  const sampledModel = inferShopApiFeeModel(sampleResults);
  if (sampledModel) return sampledModel;
  if (productFeePolicy?.status === "confirmed") return productFeePolicy.model;
  return channelRate !== null && channelRate !== undefined ? shopApiFeeModelFromChannelRate(channelRate) : null;
}

function calculateShopApiBuyerAdjustment(totalAmount, originalAmount) {
  const total = numberOrNull(totalAmount);
  const original = numberOrNull(originalAmount);
  if (total === null || original === null) return null;
  return roundCurrency(Math.max(0, total - original));
}

function selectShopApiPriceSampleItems(items, sampleSize) {
  if (!sampleSize) return [];
  const candidates = items
    .filter((item) => item?.goods_key)
    .map((item) => ({
      item,
      listedPrice: numberOrNull(item.price ?? item.real_price),
      stockCount: numberOrNull(item.extend?.stock_count),
      status: numberOrNull(item.status),
    }))
    .filter((entry) => entry.listedPrice !== null && entry.listedPrice > 0)
    .sort(compareShopApiFeeProbeCandidates);
  if (candidates.length <= sampleSize) return candidates.map((entry) => entry.item);

  const selected = new Map();
  const add = (entry) => {
    if (!entry?.item?.goods_key) return;
    selected.set(String(entry.item.goods_key), entry.item);
  };
  add(candidates[0]);

  if (sampleSize > 1) {
    const priceOrdered = [...candidates].sort((left, right) => left.listedPrice - right.listedPrice);
    add(priceOrdered[Math.floor(priceOrdered.length / 2)]);
    add(priceOrdered[0]);
  }

  for (const entry of candidates) {
    if (selected.size >= sampleSize) break;
    add(entry);
  }

  return Array.from(selected.values()).slice(0, sampleSize);
}

function compareShopApiFeeProbeCandidates(left, right) {
  const leftAvailable = shopApiFeeProbeCandidateAvailable(left) ? 1 : 0;
  const rightAvailable = shopApiFeeProbeCandidateAvailable(right) ? 1 : 0;
  if (leftAvailable !== rightAvailable) return rightAvailable - leftAvailable;

  const leftRank = shopApiFeeProbePriceRank(left.listedPrice);
  const rightRank = shopApiFeeProbePriceRank(right.listedPrice);
  if (leftRank !== rightRank) return rightRank - leftRank;

  if (leftRank === 1) return left.listedPrice - right.listedPrice;
  return right.listedPrice - left.listedPrice;
}

function shopApiFeeProbeCandidateAvailable(entry) {
  return Number(entry?.status ?? 1) === 1 && Number(entry?.stockCount ?? 1) > 0;
}

function shopApiFeeProbePriceRank(listedPrice) {
  if (listedPrice >= SHOP_API_FEE_PROBE_MIN_LISTED_PRICE && listedPrice <= SHOP_API_FEE_PROBE_MAX_LISTED_PRICE) return 2;
  if (listedPrice > SHOP_API_FEE_PROBE_MAX_LISTED_PRICE) return 1;
  return 0;
}

function shopApiPriceProbeSummary(result) {
  const listedPrice = numberOrNull(result.effectivePrice?.listedPrice) ?? result.listedPrice;
  const feeAmount = numberOrNull(result.effectivePrice?.feeAmount);
  return {
    goodsKey: result.item?.goods_key ? String(result.item.goods_key) : null,
    listedPrice,
    feeAmount,
    price: numberOrNull(result.effectivePrice?.price),
    observedRate: feeAmount !== null && listedPrice > 0
      ? Math.round((feeAmount / listedPrice) * 10_000) / 10_000
      : null,
    priceBasis: result.effectivePrice?.priceBasis || null,
  };
}

function inferShopApiFeeModel(sampleResults) {
  const valid = sampleResults.filter((result) =>
    result.listedPrice > 0 &&
    result.effectivePrice?.priceBasis === "settled" &&
    result.effectivePrice?.feeAmount !== null &&
    result.effectivePrice?.feeAmount !== undefined
  );
  if (!valid.length) return null;

  const fixed3 = valid.every((result) =>
    feeMatchesRate(result.effectivePrice.feeAmount, result.effectivePrice.listedPrice || result.listedPrice, SHOP_API_FIXED_FEE_RATE)
  );
  if (fixed3) return { kind: "fixed_3pct", rate: SHOP_API_FIXED_FEE_RATE };

  const noFee = valid.every((result) => closeCurrency(result.effectivePrice.feeAmount, 0));
  if (noFee) return { kind: "no_fee", rate: 0 };

  const observedRates = valid
    .map((result) => {
      const listedPrice = numberOrNull(result.effectivePrice.listedPrice) ?? result.listedPrice;
      const feeAmount = numberOrNull(result.effectivePrice.feeAmount);
      if (!listedPrice || feeAmount === null || feeAmount <= 0) return null;
      return feeAmount / listedPrice;
    })
    .filter((rate) => rate !== null && Number.isFinite(rate) && rate > 0 && rate <= 0.2)
    .sort((left, right) => left - right);
  if (!observedRates.length) return null;

  const medianRate = observedRates[Math.floor(observedRates.length / 2)];
  return { kind: "observed_rate", rate: Math.round(medianRate * 10_000) / 10_000 };
}

function shopApiProductLevelFeeModel(channelRate, sampleResults) {
  const inferred = inferShopApiFeeModel(sampleResults);
  if (inferred?.rate > 0) return inferred;
  if (channelRate !== null && channelRate !== undefined && Number(channelRate) >= 0) {
    return shopApiFeeModelFromChannelRate(channelRate);
  }
  return inferred;
}

function applyShopApiFeeModel(listedPrice, model) {
  const feeAmount = roundCurrency(listedPrice * model.rate);
  return {
    price: roundCurrency(listedPrice + feeAmount),
    listedPrice,
    feeAmount,
    priceBasis: "modeled",
  };
}

function feeMatchesRate(feeAmount, listedPrice, rate) {
  const expected = listedPrice * rate;
  return [roundCurrency(expected), ceilCurrency(expected), floorCurrency(expected)].some((value) =>
    closeCurrency(feeAmount, value)
  );
}

function shopApiReportedGoodsCount(data) {
  const value = numberOrNull(data?.card_count ?? data?.goods_count);
  if (value === null || value < 0) return null;
  return Math.trunc(value);
}

function shopApiForcedFeeModel(options = {}) {
  const value =
    optionValue(options, "shopApiFeeModel", "shop-api-fee-model") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_FEE_MODEL");
  const normalized = String(value || "").trim().toLowerCase();
  if (["fixed_3pct", "fixed-3pct", "3pct", "3%", "fixed_rate"].includes(normalized)) {
    return { kind: "fixed_3pct", rate: SHOP_API_FIXED_FEE_RATE };
  }
  if (["no_fee", "no-fee", "none", "0"].includes(normalized)) {
    return { kind: "no_fee", rate: 0 };
  }
  return null;
}

async function getShopApiDefaultChannel(base, token, referer, options = {}, requestOptions = null) {
  await waitBetweenPages(options);
  const payload = await postJson(
    `${base}/shopApi/Shop/getUserChannel`,
    { token },
    referer,
    requestOptions,
  ).catch((error) => {
    if (isShopApiExitErrorMessage(errorMessage(error))) throw error;
    return null;
  });

  const channels = Array.isArray(payload?.data) ? payload.data : [];
  const defaultChannel = selectShopApiPreferredChannel(channels);
  const channelId = numberOrNull(defaultChannel?.id);
  const channelRate = numberOrNull(defaultChannel?.rate);
  return {
    id: channelId === null ? 0 : channelId,
    rate: channelRate,
  };
}

function selectShopApiPreferredChannel(channels) {
  const values = Array.isArray(channels) ? channels : [];
  const active = values.filter((channel) =>
    Number(channel?.status ?? 1) === 1 && Number(channel?.custom_status ?? 1) === 1
  );
  const candidates = active.length ? active : values;
  return candidates.find((channel) => {
    const text = [
      channel?.name,
      channel?.title,
      channel?.channel_name,
      channel?.pay_name,
      channel?.code,
      channel?.type,
    ].map((value) => String(value || "").toLowerCase()).join(" ");
    return /(?:支付宝|alipay)/i.test(text);
  }) || candidates[0];
}

async function getShopApiDefaultChannelId(base, token, referer, options = {}, requestOptions = null) {
  return (await getShopApiDefaultChannel(base, token, referer, options, requestOptions)).id;
}

async function resolveShopApiEffectivePrice({
  base,
  goodsKey,
  listedPrice,
  channelId,
  referer,
  options = {},
  requestOptions = null,
}) {
  if (!goodsKey) {
    return {
      price: listedPrice,
      listedPrice,
      feeAmount: null,
      priceBasis: "listed_fallback",
    };
  }

  await waitBetweenPages(options);
  const payload = await postJson(
    `${base}/shopApi/Shop/getGoodsPrice`,
    {
      goods_key: goodsKey,
      quantity: 1,
      coupon_code: "",
      channel_id: channelId ?? 0,
    },
    referer,
    requestOptions,
  ).catch(() => null);

  const totalAmount = numberOrNull(payload?.data?.total_amount);
  if (payload?.code === 1 && totalAmount !== null) {
    const originalAmount = numberOrNull(payload.data.original_amount) ?? listedPrice;
    const buyerAdjustmentAmount = calculateShopApiBuyerAdjustment(totalAmount, originalAmount);
    const feeAmount = buyerAdjustmentAmount;
    return {
      price: totalAmount,
      listedPrice: originalAmount,
      feeAmount,
      priceBasis: "settled",
    };
  }

  return {
    price: listedPrice,
    listedPrice,
    feeAmount: null,
    priceBasis: "listed_fallback",
  };
}

function shopApiMinOrderQuantity(value) {
  const quantity = numberOrNull(value);
  return Number.isInteger(quantity) && quantity > 1 ? quantity : null;
}

function shopApiBulkPricingTiers(multipleOffers) {
  if (!multipleOffers || Number(multipleOffers.available ?? 0) !== 1 || !Array.isArray(multipleOffers.rules)) {
    return [];
  }

  const discountType = numberOrNull(multipleOffers.discount_type);
  return multipleOffers.rules
    .map((rule) => {
      const minQuantity = numberOrNull(rule?.condition);
      const value = numberOrNull(rule?.value);
      if (!Number.isInteger(minQuantity) || minQuantity < 1 || value === null) return null;

      return {
        minQuantity,
        value,
        ...(discountType === null ? {} : { discountType }),
      };
    })
    .filter(Boolean);
}

async function collectXiaoheiwan(target) {
  const products = await fetchJson(`${target.baseUrl}/api/products`);
  const items = Array.isArray(products) ? products : [];

  return items
    .map((item) => {
      const title = cleanText(item.name);
      const price = numberOrNull(item.price ?? item.original_price);
      if (!title || price === null || isNonComparableTitle(title)) return null;

      const stockCount = numberOrNull(item.stock ?? item.stock_count ?? item.count);
      const status = String(item.status || "").toLowerCase() === "active" ? statusFromStock(stockCount) : "out_of_stock";

      return makeOffer(target, {
        title,
        price,
        status,
        stockCount,
        url: `${target.baseUrl}/purchase`,
        tags: compact([item.sku, "官方接口"]),
      });
    })
    .filter(Boolean);
}

async function collectOpensoraHtml(target) {
  const html = await fetchText(target.sourceUrl);
  const pattern =
    new RegExp(String.raw`<img[^>]+alt=["']([^"']+)["'][\s\S]*?<strong>\s*${PRICE_VALUE_PATTERN}\s*<\/strong>[\s\S]*?库存[:：]\s*(\d+)[\s\S]*?<a[^>]+href=["']([^"']*\/buy\/\d+[^"']*)["']`, "gi");
  const offers = [];
  let match;

  while ((match = pattern.exec(html))) {
    const body = html.slice(match.index, pattern.lastIndex);
    const heading = body.match(/<h6 class="card-title[^"]*">\s*([\s\S]*?)<\/h6>/i)?.[1];
    const title = cleanText(heading || match[1]);
    const price = numberOrNull(match[2]);
    const stockCount = numberOrNull(match[3]);
    if (!title || price === null || isNonComparableTitle(title)) continue;

    const near = html.slice(Math.max(0, match.index - 600), pattern.lastIndex + 200);

    offers.push(
      makeOffer(target, {
        title,
        price,
        status: statusFromStock(stockCount),
        stockCount,
        url: absolutize(match[4], target.baseUrl),
        tags: compact([
          near.includes("人工处理") ? "人工处理" : null,
          near.includes("自动发货") ? "自动发货" : null,
        ]),
      }),
    );
  }

  return offers;
}

async function collectMakerichHtml(target) {
  const html = await fetchText(target.sourceUrl);
  const blocks = [...html.matchAll(/<a[^>]+href=["']([^"']*(?:\/item\?id=\d+|\/item\/[^"']+))["'][\s\S]*?<\/a>/gi)];
  const offers = [];

  for (const block of blocks) {
    const body = stripHtml(block[0]);
    const priceMatch = body.match(CURRENCY_PRICE_RE);
    const stockMatch = body.match(/库存[:：]\s*(\d+)/);
    if (!priceMatch) continue;

    const price = numberOrNull(priceMatch[1]);
    const stockCount = stockMatch ? numberOrNull(stockMatch[1]) : null;
    const title = cleanText(
      body
        .replace(CURRENCY_PRICE_RE, "")
        .replace(/库存[:：]\s*\d+/, "")
        .replace(/销量[:：]\s*\d+/g, ""),
    );
    if (!title || price === null || isNonComparableTitle(title)) continue;

    offers.push(
      makeOffer(target, {
        title,
        price,
        status: statusFromStock(stockCount),
        stockCount,
        url: absolutize(block[1], target.baseUrl),
        tags: [],
      }),
    );
  }

  return offers;
}

async function collectBeibeiHtml(target) {
  const html = await fetchText(target.sourceUrl);
  const blocks = [...html.matchAll(/<article class="atelier-catalog-card[\s\S]*?<\/article>/gi)];
  const offers = [];

  for (const block of blocks) {
    const body = block[0];
    const title = cleanText(body.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1]);
    const price = numberOrNull(body.match(CURRENCY_PRICE_RE)?.[1]);
    if (!title || price === null || isNonComparableTitle(title)) continue;

    const stockMatch = body.match(/库存\s*(\d+)/);
    const soldOut = /sold-out|售罄|已售罄|action-disabled/i.test(body);
    const stockCount = soldOut ? 0 : numberOrNull(stockMatch?.[1]);
    const checkoutUrl = body.match(/href=["']([^"']*\/checkout\/[^"']+)["']/i)?.[1];
    const detailUrl = body.match(/href=["']([^"']*\/products\/[^"']+)["']/i)?.[1];
    const tags = [...body.matchAll(/<span class="atelier-pill[^"]*">([\s\S]*?)<\/span>/gi)].map((match) =>
      cleanText(match[1]),
    );

    offers.push(
      makeOffer(target, {
        title,
        price,
        status: soldOut ? "out_of_stock" : statusFromStock(stockCount),
        stockCount,
        url: absolutize(checkoutUrl || detailUrl || target.sourceUrl, target.baseUrl),
        tags,
      }),
    );
  }

  return offers;
}

async function collectIkunloveApi(target) {
  const payload = await fetchJson(`${target.baseUrl}/api/shop/products`);
  const products = Array.isArray(payload.data?.products) ? payload.data.products : [];
  const offers = [];

  for (const product of products) {
    const title = cleanText(product.title);
    const price = numberOrNull(product.priceCents) === null ? null : numberOrNull(product.priceCents) / 100;
    if (!title || price === null || isNonComparableTitle(title)) continue;

    const stockCount = numberOrNull(product.stockCount);
    const hidden = product.isDeleted === true || product.isActive === false;
    const status = hidden ? "out_of_stock" : statusFromStock(stockCount);
    const detailUrl = product.purchaseGuideUrl || product.consolePath || product.tutorialPath || target.sourceUrl;

    offers.push(
      makeOffer(target, {
        title,
        price,
        status,
        stockCount,
        url: absolutize(detailUrl, target.baseUrl),
        tags: compact([
          product.category,
          product.badge,
          product.isActive === false ? "已下架" : null,
          product.isDeleted === true ? "已删除" : null,
        ]),
      }),
    );
  }

  return offers;
}

async function collectGetgptApi(target) {
  const payload = await fetchJson("https://gpt.how2cs.cn/api/order/prices");
  const products = [
    {
      title: "ChatGPT Plus 充值",
      price: payload.gptplus_amount ?? payload.amount,
      originalPrice: payload.gptplus_original_amount ?? payload.original_amount,
      path: "/plus-price",
    },
    {
      title: "ChatGPT Pro 充值",
      price: payload.gptpro_amount,
      originalPrice: payload.gptpro_original_amount,
      path: "/gptpro",
    },
    {
      title: "ChatGPT Pro Lite 充值",
      price: payload.gptprolite_amount,
      originalPrice: payload.gptprolite_original_amount,
      path: "/gptpro",
    },
    {
      title: "ChatGPT Team / Business 充值",
      price: payload.team_amount,
      originalPrice: payload.team_original_amount,
      path: "/price",
    },
    {
      title: "Claude 充值",
      price: payload.claude_amount,
      originalPrice: payload.claude_original_amount,
      path: "/",
    },
  ];

  return products
    .map((product) => {
      const price = numberOrNull(product.price);
      if (price === null) return null;

      return makeOffer(target, {
        title: product.title,
        price,
        status: "in_stock",
        stockCount: null,
        url: absolutize(product.path, target.baseUrl),
        tags: compact([product.originalPrice ? `原价 ${product.originalPrice}` : null, "官方接口"]),
      });
    })
    .filter(Boolean);
}

async function collectPublicProductsApi(target) {
  const payload = await fetchJson(`${target.baseUrl}/api/products`);
  const products = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.products)
      ? payload.products
      : Array.isArray(payload.data?.products)
        ? payload.data.products
        : [];

  return products
    .map((product) => {
      const title = cleanText(
        product.display_name || product.displayName || product.name || product.productName || product.title,
      );
      const price = numberOrNull(product.price_cny ?? product.priceCny ?? product.price ?? product.amount);
      if (!title || price === null || isNonComparableTitle(title)) return null;

      const stockCount = numberOrNull(product.stock ?? product.stock_count ?? product.stockCount);
      const hidden = product.is_hidden === true || product.hidden === true || product.isVisible === false;
      const disabled = hidden || Number(product.status ?? 1) === 0;
      const tags = compact([
        product.project_title || product.projectTitle || product.project,
        product.group_name || product.groupName,
        product.delivery_label || product.deliveryLabel,
        product.product_type || product.productType,
        ...(Array.isArray(product.tags)
          ? product.tags.map((tag) => typeof tag === "string" ? tag : tag?.text || tag?.name)
          : []),
      ]);

      return makeOffer(target, {
        title,
        price,
        status: disabled ? "out_of_stock" : statusFromStock(stockCount),
        stockCount,
        url: publicProductUrl(target, product),
        tags,
      });
    })
    .filter(Boolean);
}

async function collectShopUserProductsApi(target, options = {}) {
  const offers = [];

  for (let page = 1; page <= 10; page += 1) {
    await waitBetweenPages(options);
    const payload = await fetchJson(`${target.baseUrl}/shop/user/products?page=${page}&size=100&productName=`);
    const records = Array.isArray(payload.data?.records) ? payload.data.records : [];
    if (!records.length) break;

    for (const product of records) {
      const title = cleanText(product.productName || product.name || product.title);
      const price = numberOrNull(product.price ?? product.salePrice);
      if (!title || price === null || isNonComparableTitle(title)) continue;

      const stockCount = numberOrNull(product.stock);
      const hidden = Number(product.isVisible ?? 1) !== 1 || Number(product.status ?? 1) !== 1;

      offers.push(
        makeOffer(target, {
          title,
          price,
          status: hidden ? "out_of_stock" : statusFromStock(stockCount),
          stockCount,
          url: `${target.baseUrl}/product/${encodeURIComponent(String(product.id))}`,
          tags: compact([product.category, product.cardType, product.isHot ? "热门" : null]),
        }),
      );
    }

    if (records.length < 100) break;
  }

  return offers;
}

async function collectUnicornHtml(target, options = {}) {
  const html = await fetchText(target.sourceUrl);
  const blocks = [...html.matchAll(/<div class="card position-relative">[\s\S]*?(?=<div class="col">|<!-- goods end -->|<\/section>|<\/body>)/gi)];
  const cardOffers = [];

  for (const block of blocks) {
    const body = block[0];
    const title = cleanText(body.match(/<h6[^>]*class=["'][^"']*card-title[^"']*["'][^>]*>([\s\S]*?)<\/h6>/i)?.[1]);
    const price = numberOrNull(body.match(/<strong>\s*([^<]+?)\s*<\/strong>/i)?.[1]);
    if (!title || price === null || isNonComparableTitle(title)) continue;

    const stockCount = numberOrNull(body.match(/库存[:：]\s*(\d+)/)?.[1]);
    const soldOut = /缺货|售罄|已售罄|disabled|btn-secondary/i.test(body) || stockCount === 0;
    const href = body.match(/<a[^>]+href=["']([^"']*(?:\/buy\/\d+|\/product\/\d+)[^"']*)["']/i)?.[1];
    const url = absolutize(href || target.sourceUrl, target.baseUrl);

    cardOffers.push({
      title,
      price,
      status: soldOut ? "out_of_stock" : statusFromStock(stockCount),
      stockCount: soldOut ? 0 : stockCount,
      url,
      tags: compact([
        /自动发货/.test(body) ? "自动发货" : null,
        /人工处理/.test(body) ? "人工处理" : null,
        "页面解析",
      ]),
    });
  }

  const uniqueCardOffers = [...new Map(cardOffers.map((offer) => [offer.url, offer])).values()];
  const expandedOffers = (await runWithConcurrency(
    uniqueCardOffers,
    unicornDetailConcurrencyFor(options),
    async (cardOffer) => {
      const skus = await fetchUnicornSkus(cardOffer.url).catch(() => []);
      if (!skus.length) {
        return [makeOffer(target, cardOffer)];
      }

      return skus.map((sku) =>
        makeOffer(target, {
          ...cardOffer,
          title: cleanText(`${cardOffer.title} / ${sku.name}`),
          price: sku.price,
          tags: compact([...cardOffer.tags, "规格价"]),
        }),
      );
    },
  )).flat();

  return dedupeOffers(expandedOffers);
}

async function fetchUnicornSkus(url) {
  if (!/\/buy\/\d+/i.test(url)) return [];

  const html = await fetchText(url);
  const skus = [];
  const pattern = /onclick=["']selectSku\((['"])((?:\\.|(?!\1).)*?)\1\s*,\s*(['"])([\d.,]+)\3/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const name = cleanText(decodeHtmlEntities(match[2].replace(/\\(['"\\])/g, "$1")));
    const price = numberOrNull(match[4]);
    if (!name || price === null) continue;
    skus.push({ name, price });
  }

  return skus;
}

function unicornDetailConcurrencyFor(options = {}) {
  const value = Number(options.unicornDetailConcurrency || options["unicorn-detail-concurrency"] || 4);
  if (!Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(Math.trunc(value), 8));
}

async function collectMooncakeCatalog(target) {
  const js = await fetchText(`${target.baseUrl}/mooncake-official-media/catalog.js`);
  const jsonText = js.match(/window\.MOONCAKE_CATALOG\s*=\s*([\s\S]*?);\s*(?:window\.|$)/)?.[1];
  if (!jsonText) throw new Error("Mooncake catalog data not found.");

  let categories;
  try {
    categories = JSON.parse(jsonText);
  } catch {
    throw new Error("Mooncake catalog JSON parse failed.");
  }

  const offers = [];
  for (const category of Array.isArray(categories) ? categories : []) {
    const categoryName = cleanText(category.name);
    for (const item of Array.isArray(category.items) ? category.items : []) {
      const title = cleanText(item.name);
      const price = numberOrNull(item.price);
      if (!title || price === null || isNonComparableTitle(title)) continue;
      const stockCount = numberOrNull(item.stock);

      offers.push(
        makeOffer(target, {
          title,
          price,
          status: statusFromStock(stockCount),
          stockCount,
          url: `${target.baseUrl}/#item-${encodeURIComponent(String(item.id))}`,
          tags: compact([categoryName, item.delivery_way === 0 ? "自动发货" : null]),
        }),
      );
    }
  }

  return offers;
}

async function collectBlackcatWholesale(target) {
  const products = await fetchBlackcatWholesaleProducts(target);
  const tab = blackcatSelectedTab(target);
  const offers = [];

  for (const product of products) {
    if (product?.is_archived === true) continue;
    if (product?.active === false || product?.is_active === false) continue;
    if (product?.is_wholesale_active === false) continue;

    const category = cleanText(product.category);
    if (tab && category.toLowerCase() !== tab.toLowerCase()) continue;

    const title = cleanText(product.wholesale_name || product.name || product.title);
    const price = blackcatPrice(product);
    if (!title || price === null || isNonComparableTitle(title)) continue;

    const rawStockCount = numberOrNull(product.stock_count ?? product.stockCount ?? product.stock);
    const stockCount = typeof rawStockCount === "number" && rawStockCount >= 0 ? rawStockCount : null;
    const status = rawStockCount === 0 ? "out_of_stock" : statusFromStock(stockCount);

    offers.push(
      makeOffer(target, {
        title,
        price,
        status,
        stockCount,
        url: blackcatProductUrl(target, product),
        tags: compact([
          category,
          product.badge,
          product.delivery_type === "static" ? "自动发货" : null,
          product.delivery_category,
          "BlackCat",
        ]),
      }),
    );
  }

  return dedupeOffers(offers).slice(0, 200);
}

async function fetchBlackcatWholesaleProducts(target) {
  const defaultActionId = "00fc36c4f4551a0ad0887d0946a6c93bc94960dfaf";
  let response = await fetchBlackcatWholesaleAction(target, defaultActionId);

  if (response.status === 404) {
    const discoveredActionId = await discoverBlackcatWholesaleActionId(target);
    if (discoveredActionId && discoveredActionId !== defaultActionId) {
      response = await fetchBlackcatWholesaleAction(target, discoveredActionId);
    }
  }

  if (!response.ok) throw new Error(`${target.sourceUrl} returned HTTP ${response.status}`);

  const payload = parseNextActionData(await response.text());
  if (payload?.success === false) {
    throw new Error(cleanText(payload.error || payload.message) || "BlackCat product action failed.");
  }

  if (!Array.isArray(payload?.data)) {
    throw new Error("BlackCat product action did not return a product list.");
  }

  return payload.data;
}

async function fetchBlackcatWholesaleAction(target, actionId) {
  return safeFetch(target.sourceUrl, {
    method: "POST",
    headers: {
      ...defaultHeaders(target.sourceUrl),
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId,
      origin: target.baseUrl,
      referer: target.sourceUrl,
    },
    body: "[]",
    signal: AbortSignal.timeout(20_000),
  });
}

async function discoverBlackcatWholesaleActionId(target) {
  const html = await fetchText(target.sourceUrl);
  const scriptUrls = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/gi))
    .map((match) => absolutize(match[1], target.baseUrl))
    .filter(Boolean)
    .slice(0, 24);

  for (const scriptUrl of scriptUrls) {
    const chunk = await fetchText(scriptUrl).catch(() => "");
    const actionId = blackcatWholesaleActionIdFromChunk(chunk);
    if (actionId) return actionId;
  }

  return null;
}

function blackcatWholesaleActionIdFromChunk(chunk) {
  const markerIndex = String(chunk || "").indexOf("fetchWholesaleProductsAction");
  if (markerIndex < 0) return null;

  const nearby = String(chunk).slice(Math.max(0, markerIndex - 500), markerIndex + 100);
  return nearby.match(/["']([a-f\d]{40,64})["']/i)?.[1] || null;
}

function parseNextActionData(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) continue;

    const rawPayload = line.slice(separatorIndex + 1).trim();
    if (!rawPayload.startsWith("{")) continue;

    try {
      const payload = JSON.parse(rawPayload);
      if (payload && typeof payload === "object" && ("data" in payload || "success" in payload)) return payload;
    } catch {
      // Ignore non-data React transport chunks.
    }
  }

  throw new Error("Next action response did not include JSON data.");
}

function blackcatSelectedTab(target) {
  const parsed = safeUrl(target.sourceUrl);
  const tab = cleanText(parsed?.searchParams.get("tab") || "");
  return tab && !/^all$/i.test(tab) ? tab : "";
}

function blackcatPrice(product) {
  const tierPrice = blackcatBulkTierPrice(product.bulk_tiers_wholesale);
  return tierPrice ?? numberOrNull(product.wholesale_price ?? product.price);
}

function blackcatBulkTierPrice(value) {
  let tiers = value;
  if (typeof tiers === "string") {
    try {
      tiers = JSON.parse(tiers);
    } catch {
      tiers = null;
    }
  }

  if (!Array.isArray(tiers)) return null;
  const prices = tiers
    .map((tier) => numberOrNull(tier?.unitPrice ?? tier?.unit_price ?? tier?.price))
    .filter((price) => price !== null);
  return prices.length ? Math.min(...prices) : null;
}

function blackcatProductUrl(target, product) {
  const parsed = safeUrl(target.sourceUrl) || safeUrl(`${target.baseUrl}/blackcat`);
  if (!parsed) return target.sourceUrl;

  const category = cleanText(product.category);
  if (category && !parsed.searchParams.get("tab")) parsed.searchParams.set("tab", category);
  if (product.id) parsed.hash = `product-${encodeURIComponent(String(product.id))}`;
  return parsed.toString();
}

function decodeKnownEncryptedHtml(html) {
  const text = String(html || "");
  if (!/CryptoJS|AES\.decrypt/i.test(text)) return null;

  const key = text.match(/var\s+_0x[a-f0-9]+\s*=\s*\[\s*["']([A-Za-z0-9]{16,32})["']/i)?.[1];
  const ciphertext = text.match(/["']VvdIy["']\s*:\s*["']([^"']+)["']/)?.[1];
  if (!key || !ciphertext) return null;

  const keyBuffer = Buffer.from(key, "utf8");
  if (![16, 24, 32].includes(keyBuffer.length)) return null;

  try {
    const decipher = crypto.createDecipheriv(`aes-${keyBuffer.length * 8}-cbc`, keyBuffer, keyBuffer.subarray(0, 16));
    const decoded = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");

    return /<html|<body|class=["'][^"']*(?:shop-item|product)/i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

async function collectGenericHtml(target, options = {}) {
  const requestText = options.fetchText || fetchText;
  const rawHtml = await requestText(target.sourceUrl);
  const html = decodeKnownEncryptedHtml(rawHtml) || rawHtml;
  const cardOffers = collectGenericHtmlProductCards(target, html);
  if (cardOffers.length) {
    const enrichedOffers = await enrichGenericStartingPriceOffers(target, cardOffers, requestText);
    return dedupeOffers(enrichedOffers).slice(0, 200);
  }

  const pageTitle = cleanPageTitle(html);
  const text = stripHtml(html)
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  const matches = [...text.matchAll(new RegExp(String.raw`[¥￥]\s*${PRICE_VALUE_PATTERN}`, "g"))];
  const offers = [];
  let previousPriceEnd = 0;
  const singleProductPage = isLikelySingleProductPage(target.sourceUrl, matches.length);

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const price = numberOrNull(match[0]);
    if (price === null) continue;

    const segment = text.slice(previousPriceEnd, match.index);
    const nextPriceIndex = matches[index + 1]?.index ?? Math.min(text.length, match.index + 260);
    const after = text.slice(match.index + match[0].length, nextPriceIndex);
    previousPriceEnd = match.index + match[0].length;

    const title = singleProductPage
      ? pageTitle || titleFromGenericSegment(segment, price)
      : titleFromGenericSegment(segment, price);
    if (!title || isNonComparableTitle(title)) continue;
    if (/合计|支付|订单|充值金额|余额|声明|举证|预览/.test(title)) continue;

    const context = `${segment} ${after}`;
    const stockCount = stockFromGenericContext(context);
    const soldOut = /缺货|已售罄|售罄|无货/.test(context) || stockCount === 0;

    offers.push(
      makeOffer(target, {
        title,
        price,
        status: soldOut ? "out_of_stock" : statusFromStock(stockCount),
        stockCount: soldOut ? 0 : stockCount,
        url: target.sourceUrl.replace(/#.*$/, ""),
        tags: compact([
          /自动发货/.test(context) ? "自动发货" : null,
          /人工/.test(context) ? "人工处理" : null,
          "页面解析",
        ]),
      }),
    );
    if (singleProductPage) break;
  }

  return singleProductPage ? dedupeOffers(offers).slice(0, 1) : [];
}

function collectGenericHtmlProductCards(target, html) {
  const offers = [];
  const cards = extractGenericProductCards(html);

  for (const card of cards) {
    const price = priceFromGenericProductCard(card);
    if (price === null) continue;

    const title = titleFromGenericProductCard(card);
    if (!title || isNonComparableTitle(title)) continue;

    const context = stripHtml(card);
    const stockCount = stockFromGenericContext(context);
    const soldOut = /缺货|已售罄|售罄|无货/.test(context) || stockCount === 0;
    const detailUrl = genericProductCardUrl(card, target);
    if (!detailUrl) continue;

    offers.push(
      makeOffer(target, {
        title,
        price,
        status: soldOut ? "out_of_stock" : statusFromStock(stockCount),
        stockCount: soldOut ? 0 : stockCount,
        url: detailUrl,
        tags: Array.from(new Set(compact([
          ...genericProductCardTags(card),
          /自动发货/.test(context) ? "自动发货" : null,
          /人工/.test(context) ? "人工处理" : null,
          "商品卡片解析",
        ]))),
      }),
    );
  }

  return offers;
}

function extractGenericProductCards(html) {
  const source = String(html || "");
  const patterns = [
    /<article\b[\s\S]*?<\/article>/gi,
    /<a\b(?=[^>]*class=["'][^"']*(?:df-product-card|shop-item)[^"']*["'])[\s\S]*?<\/a>/gi,
  ];
  const cards = [];
  const seen = new Set();

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const card = match[0];
      if (seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }
  }

  for (const card of extractBalancedHtmlElementsByClass(source, "div", ["group/card"])) {
    if (seen.has(card)) continue;
    seen.add(card);
    cards.push(card);
  }

  for (const match of source.matchAll(/<a\b([^>]*)>[\s\S]*?<\/a>/gi)) {
    const card = match[0];
    const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1] || "";
    if (!isGenericProductDetailHref(href) || priceFromGenericProductCard(card) === null || seen.has(card)) continue;
    seen.add(card);
    cards.push(card);
  }

  return cards;
}

function extractBalancedHtmlElementsByClass(html, tagName, requiredClassFragments) {
  const source = String(html || "");
  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  const output = [];
  let start = -1;
  let depth = 0;

  for (const match of source.matchAll(tagPattern)) {
    const tag = match[0];
    const closing = /^<\//.test(tag);
    if (start < 0) {
      if (closing) continue;
      const className = tag.match(/\bclass=["']([^"']+)["']/i)?.[1] || "";
      if (!requiredClassFragments.some((fragment) => className.includes(fragment))) continue;
      start = match.index;
      depth = 1;
      continue;
    }

    depth += closing ? -1 : 1;
    if (depth !== 0) continue;
    output.push(source.slice(start, match.index + tag.length));
    start = -1;
  }

  return output;
}

function isGenericProductDetailHref(value, baseUrl = "https://priceai.invalid") {
  const href = decodeHtmlEntities(value).trim();
  if (!href || /^(?:javascript:|#)/i.test(href)) return false;

  try {
    const parsed = new URL(href, baseUrl);
    if (/\/(?:product|products|checkout|buy|item|goods|post)\/[^/?#]+/i.test(parsed.pathname)) return true;
    if (/\/(?:product|products|checkout|buy|item|goods|post)\/?$/i.test(parsed.pathname) && parsed.searchParams.get("id")) {
      return true;
    }
    if (
      normalizeHostname(parsed.href) === "woaimaihao.com" &&
      /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/i.test(parsed.pathname) &&
      !/^\/(?:login|products?|orders?|blog|tutorials?|redeem|accounts?|cart|checkout|chatgpt|claude|gemini|grok)\/?$/i.test(parsed.pathname)
    ) {
      return true;
    }
    return ["post", "product", "product_id", "goods", "goods_id", "item", "item_id"]
      .some((key) => Boolean(parsed.searchParams.get(key)));
  } catch {
    return false;
  }
}

function priceFromGenericProductCard(card) {
  const priceBlock = genericClassText(card, [
    "df-product-price",
    "shop-item-price",
    "product-price",
    "price",
    "amount",
    "money",
  ]);
  const candidates = [priceBlock, stripHtml(card)];

  for (const candidate of candidates) {
    const text = String(candidate || "");
    const currencyMatch = text.match(CURRENCY_PRICE_RE);
    if (currencyMatch) return numberOrNull(currencyMatch[0]);

    const suffixMatch = text.match(SUFFIX_PRICE_RE);
    if (suffixMatch) return numberOrNull(suffixMatch[0]);
  }

  return null;
}

function titleFromGenericProductCard(card) {
  const namedTitle = genericClassText(card, [
    "df-product-name",
    "shop-item-name",
    "product-title",
    "product-name",
    "title",
  ]);
  const titleAttr = cleanText(card.match(/\btitle=["']([^"']+)["']/i)?.[1]);
  const heading = cleanText(card.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1]);
  const imageAlt = cleanText(card.match(/<img[^>]+alt=["']([^"']+)["']/i)?.[1]);
  const highlight = cleanText(
    card.match(/<p[^>]+class=["'][^"']*(?:highlight|subtitle|summary|description)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1],
  );
  const description = genericProductCardParagraphs(card).find((paragraph) => paragraph !== highlight) || "";
  const fallback = titleFromGenericProductCardText(card);
  const parts = compact([namedTitle || titleAttr || heading || imageAlt || fallback, highlight, description]);
  const uniqueParts = [];

  for (const part of parts) {
    const key = genericProductTitlePartKey(part);
    if (!key || uniqueParts.some((existing) => {
      const existingKey = genericProductTitlePartKey(existing);
      return existingKey === key || existingKey.includes(key) || key.includes(existingKey);
    })) continue;
    uniqueParts.push(part);
  }

  return uniqueParts.join(" ").slice(0, 180);
}

function genericProductTitlePartKey(value) {
  return cleanText(value)
    .replace(/[（(]\s*购买\s*[）)]/g, "")
    .replace(/(?:立即购买|查看详情|购买)/g, "")
    .replace(/[\s|｜·,，。.!！?？:：;；_-]+/g, "")
    .toLowerCase();
}

function titleFromGenericProductCardText(card) {
  const text = stripHtml(card);
  const priceIndexCandidates = [
    text.search(CURRENCY_PRICE_RE),
    text.search(SUFFIX_PRICE_RE),
    text.search(/\bPRICE\s+\d/i),
  ].filter((index) => index >= 0);
  const priceIndex = priceIndexCandidates.length ? Math.min(...priceIndexCandidates) : text.length;

  return cleanText(text.slice(0, priceIndex))
    .split(/\s+(?:库存|销量|已售)\s*[:：]?/)[0]
    .replace(/^(?:缺货|已售罄|售罄|自动发货|人工发货|手工发货)\s*/g, "")
    .replace(/\s*(?:自动发货|人工发货|手工发货)\s*$/g, "")
    .replace(/[（(]\s*购买\s*[）)]\s*$/g, "")
    .replace(/\s*(?:立即购买|查看详情|购买)\s*$/g, "")
    .trim()
    .slice(0, 180);
}

function genericClassText(card, classNames) {
  const classPattern = classNames.map(escapeRegExp).join("|");
  const match = String(card || "").match(
    new RegExp(String.raw`<[^>]+class=["'][^"']*(?:${classPattern})[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>`, "i"),
  );
  return cleanText(match?.[1]);
}

function genericProductCardParagraphs(card) {
  return [...card.matchAll(/<p([^>]*)>([\s\S]*?)<\/p>/gi)]
    .filter((match) => !/class=["'][^"']*(?:highlight|subtitle|summary|price|stock|badge)[^"']*["']/i.test(match[1] || ""))
    .map((match) => cleanText(match[2]))
    .filter(Boolean);
}

function genericProductCardTags(card) {
  const tagBlock = card.match(/<div[^>]+class=["'][^"']*(?:tags|category|badge)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const tags = [...tagBlock.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean)
    .slice(0, 4);
  if (/>(?:\s|<!--.*?-->)*起(?:\s|<!--.*?-->)*</is.test(card)) tags.push("起售价");
  return tags;
}

async function enrichGenericStartingPriceOffers(target, offers, requestText) {
  const output = [];

  for (const offer of offers) {
    if (!offer.tags?.includes("起售价")) {
      output.push(offer);
      continue;
    }

    try {
      const detailHtml = await requestText(offer.url);
      const inventory = nextStorefrontLowestAvailableSpec(detailHtml);
      if (!inventory) continue;

      const pricing = applySourceBuyerFeePolicy(target, { price: inventory.price });
      output.push({
        ...offer,
        ...pricing,
        stockCount: inventory.stockCount,
        status: inventory.status,
        tags: Array.from(new Set(compact([...offer.tags, "最低在售规格"]))),
      });
    } catch {
      // A starting price without a confirmed purchasable spec is not safe to publish.
    }
  }

  return output;
}

function nextStorefrontLowestAvailableSpec(html) {
  const product = extractNextFlightJsonValue(html, "product");
  const specs = Array.isArray(product?.specs) ? product.specs : [];
  if (!specs.length) return null;

  const available = specs
    .map((spec) => ({
      price: numberOrNull(spec?.price),
      stockCount: numberOrNull(spec?.stock_available),
    }))
    .filter((spec) => spec.price !== null && spec.stockCount !== null && spec.stockCount > 0)
    .sort((left, right) => left.price - right.price);

  if (available.length) {
    return {
      price: available[0].price,
      stockCount: available[0].stockCount,
      status: statusFromStock(available[0].stockCount),
    };
  }

  const prices = specs.map((spec) => numberOrNull(spec?.price)).filter((price) => price !== null);
  if (!prices.length) return null;
  return { price: Math.min(...prices), stockCount: 0, status: "out_of_stock" };
}

function extractNextFlightJsonValue(html, key) {
  const payload = [...String(html || "").matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => {
      try {
        const argument = match[1].match(/^\s*self\.__next_f\.push\(([\s\S]*)\)\s*$/)?.[1];
        if (!argument) return "";
        const chunk = JSON.parse(argument);
        return typeof chunk?.[1] === "string" ? chunk[1] : "";
      } catch {
        return "";
      }
    })
    .join("\n");
  const marker = `"${key}":`;
  let offset = 0;

  while (offset < payload.length) {
    const markerIndex = payload.indexOf(marker, offset);
    if (markerIndex < 0) return null;
    const start = payload.slice(markerIndex + marker.length).search(/[\[{]/);
    if (start < 0) return null;
    const valueStart = markerIndex + marker.length + start;
    const valueText = balancedJsonValueAt(payload, valueStart);
    if (valueText) {
      try {
        return JSON.parse(valueText);
      } catch {
        // Continue to the next matching key in the Flight payload.
      }
    }
    offset = markerIndex + marker.length;
  }

  return null;
}

function balancedJsonValueAt(text, start) {
  const opening = text[start];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : null;
  if (!closing) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return null;
}

function genericProductCardUrl(card, target) {
  const hrefs = [...card.matchAll(/href=["']([^"']+)["']/gi)].map((match) => match[1]);
  const preferred = hrefs.find((href) => isGenericProductDetailHref(href, target.baseUrl));

  return preferred ? absolutize(preferred, target.baseUrl) : null;
}

function titleFromGenericSegment(value, price = null) {
  let text = cleanText(value)
    .replace(/(?:库存|销量|已售)\s*\d+/g, " ")
    .replace(/\d+\s*件现货/g, " ")
    .replace(/\b(?:价格|售价|自动发货|人工处理)\b\s*$/g, " ")
    .replace(/价格\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let matchedDetailTitle = false;
  const detailMatch = text.match(/(.{4,220}?)(?:\s*(?:自动发货|人工处理))?\s*库存[:：]\s*\d+\s*(?:价格[:：]?)?$/);
  if (detailMatch) {
    const candidate = detailMatch[1]
      .split(/(?:购买商品|查询订单|补货通知|友情提醒|QQ[:：]|TG|-->|在线客服)/)
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1);
    if (candidate && candidate.length >= 4) {
      text = candidate;
      matchedDetailTitle = true;
    }
  }

  const markers = [
    "立即下单 查看详情",
    "查看并购买",
    "shopping_bag",
    "自动发货",
    "人工处理",
    "全部商品",
    "商品列表",
  ];
  let markerIndex = -1;
  let markerLength = 0;
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    const nextChar = index >= 0 ? text.slice(index + marker.length, index + marker.length + 1) : "";
    if ((marker === "自动发货" || marker === "人工处理") && /[】\]]/.test(nextChar)) continue;
    if ((marker === "自动发货" || marker === "人工处理") && !text.slice(index + marker.length).trim()) continue;
    if (index >= markerIndex) {
      markerIndex = index;
      markerLength = marker.length;
    }
  }
  if (markerIndex >= 0) text = text.slice(markerIndex + markerLength);

  text = text
    .split(/\s+/)
    .filter((token) => token && numberOrNull(token) !== price)
    .join(" ");

  text = text
    .replace(/^(?:热门|推荐|设计向|全部|进入分类)\s+/g, "")
    .replace(/^(?:AP|C|G|X|IN|TE)\s+/g, "")
    .replace(/^(ChatGPT|GPT|Claude|Grok|Gemini|OpenAI)\s+\1/gi, "$1")
    .replace(/(?:充值到自己账号|成品号|卡密发货|推荐|热销|价格)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!matchedDetailTitle) {
    const productNameMatch = text.match(
      /((?:ChatGPT|GPT|Claude|Grok|Gemini|OpenAI|Google|Gmail|Outlook|Telegram|Pixel|Apple ID|GV|API)[^，。,；;]{0,80})/i,
    );
    if (productNameMatch) text = productNameMatch[1].trim();
  }

  if (text.length > 96) {
    const parts = text.split(/\s{2,}|[。；;，,]/).map((part) => part.trim()).filter(Boolean);
    text = parts.at(-1) || text.slice(-96);
  }

  return text.slice(0, 140).trim();
}

function stockFromGenericContext(value) {
  const text = cleanText(value);
  const stockMatch = text.match(/库存\s*[:：]?\s*(\d+)/) || text.match(/(\d+)\s*件现货/);
  return stockMatch ? numberOrNull(stockMatch[1]) : null;
}

function cleanPageTitle(html) {
  const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  if (!title) return "";
  return title
    .split(/\s*(?:购买\s*\||\|\s*购买|-\s*购买|_\s*购买)\s*/)[0]
    .replace(/\s*\|\s*(?:office\s*365|发卡|小店|商城|商店).*$/i, "")
    .replace(/\s+-\s*(?:office\s*365|发卡|小店|商城|商店).*$/i, "")
    .trim()
    .slice(0, 140);
}

function isLikelySingleProductPage(url, priceCount) {
  const parsed = safeUrl(url);
  if (!parsed) return priceCount <= 2;
  return priceCount <= 2 && /\/(?:product|products|goods|item)\//i.test(parsed.pathname);
}

async function discoverShopTokens(target, options = {}, requestOptions = null) {
  const tokens = new Set();
  const entryToken = shopTokenFromUrl(target.sourceUrl);
  if (entryToken) tokens.add(entryToken);

  const itemUrls = target.rawOffers
    .map((offer) => offer.url)
    .filter(Boolean)
    .filter((url) => normalizeHostname(url) === normalizeHostname(target.baseUrl))
    .slice(0, 20);

  for (const itemUrl of itemUrls) {
    await waitBetweenPages(options);
    const goodsKey = goodsKeyFromUrl(itemUrl);
    if (!goodsKey) continue;

    const payload = await postJson(
      `${target.baseUrl}/shopApi/Shop/goodsInfo`,
      { goods_key: goodsKey, trade_no: "" },
      itemUrl,
      requestOptions,
    ).catch(() => null);

    const token = payload?.data?.user?.token;
    if (token) tokens.add(String(token));
    if (tokens.size >= 3) break;
  }

  return Array.from(tokens);
}

async function loadTargets() {
  let sources = BUILTIN_SOURCES;
  let rawOffers = [];

  const supabase = getSupabaseClient();
  if (supabase) {
    const [sourcesResult, offersResult, feePolicies, ldxpSettingsResult] = await Promise.all([
      selectCollectorSourceRows(supabase),
      supabase.from("raw_offers").select("source_id,source_name,source_store_name,source_title,url").limit(5000),
      listActiveShopApiFeePolicies(supabase),
      supabase.from("app_runtime_settings").select("settings,updated_at").eq("id", LDXP_DOMAIN_SETTINGS_ID).maybeSingle(),
    ]);

    if (sourcesResult.error) throw sourcesResult.error;
    if (offersResult.error) throw offersResult.error;
    if (ldxpSettingsResult.error) throw ldxpSettingsResult.error;
    ldxpRuntimeSettings = normalizeLdxpRuntimeSettings(ldxpSettingsResult.data?.settings);

    sources = (sourcesResult.data || []).map((source) => ({
      ...source,
      shopApiFeePolicies: feePolicies.filter((policy) => policy.source_id === source.id),
    }));
    rawOffers = offersResult.data || [];
  }

  const rawBySource = new Map();
  for (const offer of rawOffers) {
    const sourceId = offer.source_id;
    if (!sourceId) continue;
    const items = rawBySource.get(sourceId) || [];
    items.push({
      sourceId,
      sourceName: offer.source_name,
      sourceStoreName: offer.source_store_name,
      sourceTitle: offer.source_title,
      url: offer.url,
    });
    rawBySource.set(sourceId, items);
  }

  return sources
    .filter((source) => source.collection_method !== "public_json")
    .map((source) => buildTarget(source, rawBySource.get(source.id) || []))
    .map((target) => rewriteLdxpTargetHost(target, ldxpRuntimeSettings.activeHost));
}

function normalizeLdxpRuntimeSettings(value) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const mode = ["auto", "www", "pay"].includes(record.mode) ? record.mode : "auto";
  const activeHost = mode === "www"
    ? LDXP_WWW_HOST
    : mode === "pay"
      ? LDXP_PAY_HOST
      : [LDXP_WWW_HOST, LDXP_PAY_HOST].includes(record.activeHost)
        ? record.activeHost
        : LDXP_WWW_HOST;
  return {
    mode,
    activeHost,
    lastSwitchedAt: record.lastSwitchedAt || null,
    lastSwitchReason: record.lastSwitchReason || null,
  };
}

function isLdxpTarget(target) {
  return [LDXP_WWW_HOST, LDXP_PAY_HOST, "ldxp.cn"].includes(normalizeHostname(target?.baseUrl || target?.sourceUrl));
}

function alternateLdxpHost(host) {
  if (host === LDXP_WWW_HOST) return LDXP_PAY_HOST;
  if (host === LDXP_PAY_HOST || host === "ldxp.cn") return LDXP_WWW_HOST;
  return null;
}

function rewriteLdxpTargetHost(target, host) {
  if (!isLdxpTarget(target)) return target;
  return {
    ...target,
    baseUrl: rewriteLdxpUrlHost(target.baseUrl, host),
    rawOffers: Array.isArray(target.rawOffers)
      ? target.rawOffers.map((offer) => ({ ...offer, url: rewriteLdxpUrlHost(offer.url, host) }))
      : target.rawOffers,
  };
}

function rewriteLdxpUrlHost(value, host) {
  try {
    const url = new URL(String(value || ""));
    if (![LDXP_WWW_HOST, LDXP_PAY_HOST, "ldxp.cn"].includes(url.hostname.toLowerCase())) return value;
    url.protocol = "https:";
    url.hostname = host;
    url.port = "";
    if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
    return url.toString();
  } catch {
    return value;
  }
}

function isLdxpFailoverErrorMessage(message) {
  if (/returned HTTP (?:520|522|523|524)\b/i.test(String(message || ""))) return true;
  return /(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|AbortError|Connect Timeout|headers timeout|body timeout|fetch failed|DNS|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|TLS|socket hang up)/i.test(String(message || ""));
}

async function persistLdxpAutomaticSwitch(fromHost, toHost, reason) {
  const supabase = getSupabaseClient();
  if (!supabase || ldxpRuntimeSettings.mode !== "auto") return false;
  const { data: currentRow, error: currentError } = await supabase
    .from("app_runtime_settings")
    .select("settings")
    .eq("id", LDXP_DOMAIN_SETTINGS_ID)
    .maybeSingle();
  if (currentError) throw currentError;
  const current = normalizeLdxpRuntimeSettings(currentRow?.settings);
  if (current.mode !== "auto" || current.activeHost !== fromHost) return false;

  const switchedAtMs = current.lastSwitchedAt ? new Date(current.lastSwitchedAt).getTime() : 0;
  if (switchedAtMs && Date.now() - switchedAtMs < LDXP_AUTO_SWITCH_COOLDOWN_MS) return false;

  const now = new Date().toISOString();
  const nextSettings = {
    mode: "auto",
    activeHost: toHost,
    lastSwitchedAt: now,
    lastSwitchReason: String(reason || "").slice(0, 500),
  };
  const { error } = await supabase.from("app_runtime_settings").upsert({
    id: LDXP_DOMAIN_SETTINGS_ID,
    provider: "priceai",
    base_url: `https://${toHost}`,
    model: "ldxp-domain-settings",
    timeout_ms: 20_000,
    settings: nextSettings,
    updated_at: now,
  }, { onConflict: "id" });
  if (error) throw error;
  return true;
}

async function listActiveShopApiFeePolicies(supabase) {
  const { data, error } = await supabase
    .from("shop_api_fee_policies")
    .select("source_id,shop_token,strategy,rate,sample_selection,observed_at,expires_at")
    .gt("expires_at", new Date().toISOString());
  if (error) {
    if (/shop_api_fee_policies|schema cache|does not exist/i.test(error.message || "")) return [];
    throw error;
  }
  return data || [];
}

async function selectCollectorSourceRows(supabase) {
  const result = await supabase
    .from("sources")
    .select(SHOP_COLLECTION_SCHEDULER_SOURCE_SELECT)
    .eq("enabled", true);
  if (!result.error) return result;
  if (
    isMissingColumnError(result.error, "availability_status") ||
    isMissingColumnError(result.error, "out_of_stock_since") ||
    isMissingColumnError(result.error, "consecutive_out_of_stock_snapshots")
  ) {
    const compatibilityResult = await supabase
      .from("sources")
      .select(SHOP_COLLECTION_SCHEDULER_SOURCE_NO_AVAILABILITY_SELECT)
      .eq("enabled", true);
    if (!compatibilityResult.error || (!isMissingColumnError(compatibilityResult.error, "collection_group") && !isMissingColumnError(compatibilityResult.error, "shop_created_at"))) return compatibilityResult;

    const noGroupResult = await supabase
      .from("sources")
      .select(SHOP_COLLECTION_SCHEDULER_SOURCE_NO_GROUP_SELECT)
      .eq("enabled", true);
    if (!noGroupResult.error || !isMissingColumnError(noGroupResult.error, "shop_created_at")) return noGroupResult;

    return supabase
      .from("sources")
      .select(SHOP_COLLECTION_SCHEDULER_SOURCE_LEGACY_SELECT)
      .eq("enabled", true);
  }
  if (!isMissingColumnError(result.error, "collection_group") && !isMissingColumnError(result.error, "shop_created_at")) {
    return result;
  }

  const noGroupResult = await supabase
    .from("sources")
    .select(SHOP_COLLECTION_SCHEDULER_SOURCE_NO_GROUP_SELECT)
    .eq("enabled", true);
  if (!noGroupResult.error || !isMissingColumnError(noGroupResult.error, "shop_created_at")) return noGroupResult;

  return supabase
    .from("sources")
    .select(SHOP_COLLECTION_SCHEDULER_SOURCE_LEGACY_SELECT)
    .eq("enabled", true);
}

function buildTarget(source, rawOffers) {
  const sourceUrl = source.entry_url || source.base_url;
  const baseUrl = source.base_url || deriveBaseUrl(sourceUrl);
  const host = normalizeHostname(baseUrl || sourceUrl);
  const text = `${source.id} ${source.name} ${sourceUrl}`.toLowerCase();
  const configuredKind = normalizeCollectorKind(source.collector_kind);
  const inferredKind = inferCollectorKind(host, text);
  const kind =
    configuredKind && configuredKind !== "auto" && configuredKind !== "browser" && configuredKind !== "unsupported"
      ? configuredKind
      : inferredKind || configuredKind;
  const runnableKind = kind === "browser" || kind === "unsupported" ? null : kind;

  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl,
    sourceStoreName: source.name,
    baseUrl,
    kind: runnableKind,
    configuredKind: configuredKind || null,
    healthStatus: source.health_status || null,
    lastSuccessAt: source.last_success_at || null,
    lastCheckedAt: source.last_checked_at || null,
    consecutiveFailures:
      source.consecutive_failures === null || source.consecutive_failures === undefined
        ? null
        : Number(source.consecutive_failures),
    lastError: source.last_error || null,
    availabilityStatus: source.availability_status || "unknown",
    outOfStockSince: isoDateTimeOrNull(source.out_of_stock_since),
    consecutiveOutOfStockSnapshots:
      source.consecutive_out_of_stock_snapshots === null || source.consecutive_out_of_stock_snapshots === undefined
        ? 0
        : Number(source.consecutive_out_of_stock_snapshots),
    createdAt: isoDateTimeOrNull(source.created_at),
    sourceShopCreatedAt: isoDateTimeOrNull(source.shop_created_at),
    updatedAt: isoDateTimeOrNull(source.updated_at),
    buyerFeeRate: numberOrNull(source.buyer_fee_rate),
    buyerFeePaymentMethod: source.buyer_fee_payment_method || null,
    buyerFeeStrategy: source.buyer_fee_strategy || null,
    collectionGroup: source.collection_group === "vip_15m" ? "vip_15m" : "automatic",
    shopApiFeePolicies: Array.isArray(source.shopApiFeePolicies) ? source.shopApiFeePolicies : [],
    rawOffers,
  };
}

function kamiCommodityUrl(target, id) {
  const base = target.baseUrl;
  return `${base}/item/${encodeURIComponent(String(id))}`;
}

function makeOffer(target, input) {
  const pricing = applySourceBuyerFeePolicy(target, input);
  return {
    sourceId: target.sourceId,
    sourceName: target.sourceName,
    sourceUrl: target.sourceUrl,
    sourceStoreName: target.sourceStoreName || target.sourceName,
    sourceShopCreatedAt: isoDateTimeOrNull(target.sourceShopCreatedAt),
    sourceTitle: input.title,
    price: pricing.price,
    listedPrice: pricing.listedPrice ?? null,
    feeAmount: pricing.feeAmount ?? null,
    priceBasis: pricing.priceBasis ?? null,
    currency: "CNY",
    status: input.status || "unknown",
    effectiveStatus: input.effectiveStatus || null,
    freshnessStatus: input.freshnessStatus || null,
    failureReason: input.failureReason || null,
    url: input.url,
    tags: input.tags || [],
    stockCount: input.stockCount,
    minOrderQuantity: input.minOrderQuantity ?? null,
    bulkPricingTiers: input.bulkPricingTiers || [],
  };
}

function applySourceBuyerFeePolicy(target, input) {
  const strategy = String(target?.buyerFeeStrategy ?? target?.buyer_fee_strategy ?? "");
  const rate = numberOrNull(target?.buyerFeeRate ?? target?.buyer_fee_rate);
  const price = numberOrNull(input?.price);
  if (strategy !== "manual_verified" || rate === null || rate < 0 || rate > 0.2 || price === null) return input;
  const listedPrice = numberOrNull(input.listedPrice) ?? price;
  const feeAmount = roundCurrency(listedPrice * rate);
  return {
    ...input,
    price: roundCurrency(listedPrice + feeAmount),
    listedPrice,
    feeAmount,
    priceBasis: "modeled",
  };
}

function shopApiShopAvailability(data) {
  const customStatus = numberOrNull(data?.custom_status);
  if (customStatus === 0) {
    const message = cleanText(data?.custom_status_msg || data?.status_msg || data?.message || "");
    return {
      closed: true,
      reason: `店铺已打烊${message ? `：${message}` : ""}`,
    };
  }

  return { closed: false, reason: null };
}

function crawlLogPayloadFor(target, offers, status, message, options = {}, details = {}) {
  const sourceShopCreatedAt = isoDateTimeOrNull(
    target.sourceShopCreatedAt || offers.find((offer) => offer.sourceShopCreatedAt)?.sourceShopCreatedAt,
  );

  return {
    sourceId: target.sourceId,
    sourceName: target.sourceName,
    sourceUrl: target.sourceUrl,
    sourceEntryUrl: target.sourceEntryUrl,
    sourceShopCreatedAt: sourceShopCreatedAt || undefined,
    mode: "http",
    status,
    message,
    offers,
    details: {
      collectorNode: collectorNodeDetails(options),
      collector: target.kind,
      ...details,
    },
  };
}

function crawlLogPayloadsFor(target, offers, status, message, options = {}, details = {}) {
  const fullSnapshot = shouldIncludeFullSnapshot(target, offers, status, options, details);
  const seenOfferIds = fullSnapshot ? seenOfferIdsForSnapshot(offers, details) : undefined;

  if (status !== "success" || offers.length <= postBatchSizeFor(options)) {
    return [
      crawlLogPayloadFor(target, offers, status, message, options, {
        ...details,
        fullSnapshot,
        seenOfferIds,
        deferredFullSnapshot: status === "success" && !fullSnapshot,
      }),
    ];
  }

  const batches = chunks(offers, postBatchSizeFor(options));

  return batches.map((batch, index) => {
    const isLast = index === batches.length - 1;
    return crawlLogPayloadFor(
      target,
      batch,
      "success",
      `${message} 分批写入 ${index + 1}/${batches.length}。`,
      options,
      {
        ...details,
        batchIndex: index + 1,
        batchCount: batches.length,
        batchStage: isLast ? "final" : "intermediate",
        originalOfferCount: offers.length,
        fullSnapshot: isLast && fullSnapshot,
        seenOfferIds: isLast && fullSnapshot ? seenOfferIds : undefined,
        deferredFullSnapshot: isLast && !fullSnapshot,
      },
    );
  });
}

function crawlLogPostConfig(options = {}) {
  const endpoint =
    options.endpoint ||
    process.env.CRON_PUBLIC_BASE_URL ||
    env.CRON_PUBLIC_BASE_URL ||
    "http://localhost:3000";
  const password =
    options.password ||
    process.env.CRON_SECRET ||
    env.CRON_SECRET;
  if (!password) {
    throw new Error("写回采集结果需要 --password 或 CRON_SECRET。");
  }

  return {
    endpoint: endpoint.replace(/\/$/, ""),
    password,
  };
}

function cronWriteHeaders(config) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.password}`,
  };
}

async function postCollectorHeartbeat(status, options = {}, input = {}) {
  const config = crawlLogPostConfig(options);
  const payload = {
    node: collectorNodeDetails(options),
    scope: collectorHeartbeatScopeForOptions(options),
    status,
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null,
    successCount: Number(input.successCount || 0),
    failureCount: Number(input.failureCount || 0),
    skippedCount: Number(input.skippedCount || 0),
    offerCount: Number(input.offerCount || 0),
    message: input.message || null,
    details: compactObject({
      ...(input.details || {}),
      options: compactObject({
        all: Boolean(options.all),
        kind: options.kind || options.kinds || options["collector-kind"] || options["collector-kinds"] || null,
        includeFamily: options.includeFamily || options["include-family"] || options.includeFamilies || options["include-families"] || null,
        excludeKind: options.excludeKind || options["exclude-kind"] || options.excludeKinds || options["exclude-kinds"] || null,
        excludeFamily: options.excludeFamily || options["exclude-family"] || options.excludeFamilies || options["exclude-families"] || null,
        excludeSource: options.excludeSource || options["exclude-source"] || options.excludeSources || options["exclude-sources"] || null,
        shopApiListMode: shopApiAllGoodsListEnabled(options) ? "all_goods" : "category",
        shopApiPriceSampleSize: shopApiPriceSampleSizeFor(options),
        shopApiPriceSampleSelection: shopApiPriceSampleSizeFor(options) > 0 ? "high_price_probe" : "disabled",
        shopApiFeeModel: shopApiForcedFeeModel(options)?.kind || null,
        shopApiProxyMode: shopApiProxyModeFor(options),
        shopApiProxyHosts: Array.from(shopApiProxyHostsFor(options)).sort().join(",") || null,
      }),
    }),
  };
  const response = await fetch(`${config.endpoint}/api/admin/collector-heartbeat`, {
    method: "POST",
    headers: cronWriteHeaders(config),
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.message || `Heartbeat failed with HTTP ${response.status}`);
  }
  return body;
}

function collectorHeartbeatScopeForOptions(options = {}) {
  const selected = options.source || options.id || options.name;
  if (selected) return `source:${String(selected)}`;

  const includedFamilies = optionList(options.includeFamily || options["include-family"] || options.includeFamilies || options["include-families"]);
  if (includedFamilies.length) return `family:${includedFamilies.join(",")}`;

  const kinds = optionList(options.kind || options.kinds || options["collector-kind"] || options["collector-kinds"]);
  if (kinds.length) return `kind:${kinds.join(",")}`;

  const excludedKinds = optionList(options.excludeKind || options["exclude-kind"] || options.excludeKinds || options["exclude-kinds"]);
  const excludedFamilies = optionList(options.excludeFamily || options["exclude-family"] || options.excludeFamilies || options["exclude-families"]);
  const excluded = [
    excludedKinds.length ? `exclude-kind:${excludedKinds.join(",")}` : null,
    excludedFamilies.length ? `exclude-family:${excludedFamilies.join(",")}` : null,
  ].filter(Boolean);

  if (excluded.length) return excluded.join(";");
  return options.all ? "all" : "filtered";
}

function collectorHeartbeatStatusForResult(result = {}) {
  if (Number(result.failureCount || 0) > 0 && Number(result.successCount || 0) > 0) return "partial";
  if (Number(result.failureCount || 0) > 0) return "failed";
  if (Number(result.targetCount || 0) === 0) return "idle";
  return "success";
}

function collectorHeartbeatForWritebackFailure(summary = [], error = null) {
  const rows = Array.isArray(summary) ? summary : [];
  const successCount = rows.filter((item) => item?.status === "success").length;
  const sourceFailureCount = rows.filter((item) => item?.status !== "success" && item?.status !== "skipped").length;
  const offerCount = rows.reduce((sum, item) => sum + Number(item?.offers || 0), 0);
  const collectionCompleted = successCount > 0 && sourceFailureCount === 0;
  const spoolPersisted = error?.spoolPersisted === true;
  const writebackError = errorMessage(error);

  return {
    status: collectionCompleted && spoolPersisted ? "partial" : "failed",
    successCount,
    failureCount: sourceFailureCount,
    offerCount,
    collectionCompleted,
    spoolPersisted,
    message: collectionCompleted && spoolPersisted
      ? `源站采集已完成，结果回传延迟并已进入本地 spool，等待下轮补写：${writebackError}`
      : collectionCompleted
        ? `源站采集已完成，但结果回传和本地 spool 持久化均失败：${writebackError}`
        : `采集结果回传失败：${writebackError}`,
  };
}

async function postCrawlLogPayload(payload, options = {}) {
  const config = crawlLogPostConfig(options);
  const response = await fetch(`${config.endpoint}/api/admin/crawl-log`, {
    method: "POST",
    headers: cronWriteHeaders(config),
    body: JSON.stringify(sanitizeCrawlLogPayloadForPost(payload)),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.message || `Post failed with HTTP ${response.status}`);
  }

  return body;
}

async function postCrawlLogPayloadBatch(runs, options = {}, batchDetails = {}) {
  if (runs.length === 1) return postCrawlLogPayload(runs[0], options);

  const config = crawlLogPostConfig(options);
  const response = await fetch(`${config.endpoint}/api/admin/crawl-log`, {
    method: "POST",
    headers: cronWriteHeaders(config),
    body: JSON.stringify({
      runs: runs.map(sanitizeCrawlLogPayloadForPost),
      batch: {
        sourceCount: runs.length,
        ...batchDetails,
      },
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.message || `Post failed with HTTP ${response.status}`);
  }

  return body;
}

function sanitizeCrawlLogPayloadForPost(payload) {
  if (!payload || typeof payload !== "object") return payload;

  return {
    ...payload,
    sourceShopCreatedAt: isoDateTimeOrNull(payload.sourceShopCreatedAt) || undefined,
    offers: Array.isArray(payload.offers)
      ? payload.offers.map((offer) => ({
          ...offer,
          sourceShopCreatedAt: isoDateTimeOrNull(offer.sourceShopCreatedAt),
        }))
      : payload.offers,
  };
}

async function postCrawlLog(target, offers, status, message, options = {}, details = {}) {
  return postCrawlLogPayload(crawlLogPayloadFor(target, offers, status, message, options, details), options);
}

async function postCrawlLogBatched(target, offers, status, message, options = {}, details = {}, writeQueue = null, onSettled = null) {
  const runs = crawlLogPayloadsFor(target, offers, status, message, options, details);

  const canQueue = runs.every((run) => run.status === "success" || run.status === "partial");
  if (writeQueue && canQueue) {
    writeQueue.enqueue(runs, { sourceId: target.sourceId, sourceName: target.sourceName, onSettled });
    return { ok: true, queued: true, successCount: offers.length };
  }

  let successCount = 0;
  let writtenCount = 0;
  let unchangedCount = 0;
  let refreshedCount = 0;

  for (const run of runs) {
    const posted = await postCrawlLogPayload(run, options);
    successCount += Number(posted.successCount || 0);
    writtenCount += Number(posted.writtenCount || 0);
    unchangedCount += Number(posted.unchangedCount || 0);
    refreshedCount += Number(posted.refreshedCount || 0);
  }

  return { ok: true, successCount, writtenCount, unchangedCount, refreshedCount };
}

async function postSkippedCrawlLog(target, skip, options = {}, logger = null) {
  if (!options.post) return;

  await postCrawlLogBatched(target, [], "skipped", skip.message, options, {
    collectedAt: new Date().toISOString(),
    skip: {
      reason: skip.reason || "family_protection",
      family: skip.family || null,
      familyLabel: skip.familyLabel || null,
      limit: skip.limit ?? null,
      startedCount: skip.startedCount ?? null,
    },
  }, null).catch((error) => {
    logger?.error(`Failed to post skipped log: ${errorMessage(error)}`);
  });
}

function createCrawlLogWriteQueue(options = {}, logger = null) {
  const flushSourceCount = flushSourceCountFor(options);
  const flushIntervalMs = flushIntervalMsFor(options);
  const maxRunsPerRequest = postRunBatchSizeFor(options);
  const maxOffersPerRequest = postRequestOfferLimitFor(options);
  const spool = createCrawlLogSpool(options, logger);
  let pendingRuns = [];
  let pendingSourceCount = 0;
  let firstQueuedAt = 0;
  let pendingSettlers = [];
  let timer = null;
  let flushChain = Promise.resolve();
  let lastError = null;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const scheduleTimer = () => {
    if (timer || flushIntervalMs <= 0 || !pendingRuns.length) return;
    timer = setTimeout(() => {
      void flush("interval").catch((error) => {
        lastError = error;
        logger?.error(`Failed to flush crawl log queue: ${errorMessage(error)}`);
      });
    }, flushIntervalMs);
    timer.unref?.();
  };

  const flushNow = async (reason = "manual", flushOptions = {}) => {
    clearTimer();
    if (!pendingRuns.length) return { ok: true, runCount: 0, successCount: 0, writtenCount: 0, unchangedCount: 0, refreshedCount: 0 };

    const runs = pendingRuns;
    const sourceCount = pendingSourceCount;
    const queuedAt = firstQueuedAt;
    const settlers = pendingSettlers;
    pendingRuns = [];
    pendingSourceCount = 0;
    firstQueuedAt = 0;
    pendingSettlers = [];

    let successCount = 0;
    let writtenCount = 0;
    let unchangedCount = 0;
    let refreshedCount = 0;
    let requestCount = 0;

    try {
      for (const batch of crawlLogRequestBatches(runs, maxRunsPerRequest, maxOffersPerRequest)) {
        const posted = await postCrawlLogPayloadBatch(batch, options, {
          reason,
          sourceCount,
          runCount: runs.length,
          flushSourceCount,
          flushIntervalMs,
        });
        requestCount++;
        successCount += Number(posted.successCount || 0);
        writtenCount += Number(posted.writtenCount || 0);
        unchangedCount += Number(posted.unchangedCount || 0);
        refreshedCount += Number(posted.refreshedCount || 0);
      }
    } catch (error) {
      if (flushOptions.persistOnFailure) {
        try {
          spool.write(runs, {
            reason,
            sourceCount,
            queuedAt: queuedAt || Date.now(),
            error: errorMessage(error),
          });
          error.spoolPersisted = true;
          await settleCrawlLogQueue(settlers, logger);
        } catch (spoolError) {
          const combinedError = new Error(
            `${errorMessage(error)}; spool persistence failed: ${errorMessage(spoolError)}`,
            { cause: error },
          );
          combinedError.spoolPersisted = false;
          throw combinedError;
        }
      } else {
        pendingRuns = [...runs, ...pendingRuns];
        pendingSourceCount += sourceCount;
        firstQueuedAt = firstQueuedAt || queuedAt || Date.now();
        pendingSettlers = [...settlers, ...pendingSettlers];
        scheduleTimer();
      }
      throw error;
    }

    logger?.log(
      `Flushed ${runs.length} crawl log run(s) from ${sourceCount} source(s) via ${requestCount} request(s).`,
    );
    lastError = null;
    await settleCrawlLogQueue(settlers, logger);

    return { ok: true, runCount: runs.length, successCount, writtenCount, unchangedCount, refreshedCount };
  };

  const flush = (reason = "manual", flushOptions = {}) => {
    const operation = flushChain.then(() => flushNow(reason, flushOptions));
    flushChain = operation.catch(() => {});
    return operation;
  };

  return {
    enqueue(runs, source = {}) {
      const items = Array.isArray(runs) ? runs.filter(Boolean) : [];
      if (!items.length) return;

      pendingRuns.push(...items);
      pendingSourceCount++;
      if (typeof source.onSettled === "function") pendingSettlers.push(source.onSettled);
      if (!firstQueuedAt) firstQueuedAt = Date.now();
      scheduleTimer();

      const isCountReady = pendingSourceCount >= flushSourceCount;
      const isIntervalReady = flushIntervalMs > 0 && Date.now() - firstQueuedAt >= flushIntervalMs;
      if (isCountReady || isIntervalReady) {
        void flush(isCountReady ? "source-count" : "interval").catch((error) => {
          lastError = error;
          logger?.error(
            `Failed to flush crawl log queue after ${source.sourceName || source.sourceId || "source"}: ${errorMessage(error)}`,
          );
        });
      }
    },
    flush,
    replaySpool(reason = "startup") {
      const operation = flushChain.then(async () => {
        const result = await spool.replay(async (runs, meta) => {
          for (const batch of crawlLogRequestBatches(runs, maxRunsPerRequest, maxOffersPerRequest)) {
            await postCrawlLogPayloadBatch(batch, options, {
              reason: `${reason}-spool`,
              sourceCount: meta.sourceCount || 0,
              runCount: runs.length,
              spooledAt: meta.createdAt || null,
              spoolReason: meta.reason || null,
            });
          }
        });
        lastError = null;
        return result;
      });
      flushChain = operation.catch(() => {});
      return operation;
    },
    throwIfFailed() {
      if (lastError) throw lastError;
    },
  };
}

async function settleCrawlLogQueue(settlers, logger = null) {
  for (const settle of settlers) {
    try {
      await settle();
    } catch (error) {
      logger?.error(`Failed to settle crawl log queue source: ${errorMessage(error)}`);
    }
  }
}

function createCrawlLogSpool(options = {}, logger = null) {
  const directory = crawlLogSpoolDirectory(options);
  const replayLimit = spoolReplayLimitFor(options);

  const ensureDirectory = () => {
    mkdirSync(directory, { recursive: true });
  };

  return {
    write(runs, meta = {}) {
      const items = Array.isArray(runs) ? runs.filter(Boolean) : [];
      if (!items.length) return null;

      ensureDirectory();
      const createdAt = new Date().toISOString();
      const id = crypto
        .createHash("sha1")
        .update(`${createdAt}:${JSON.stringify(items).slice(0, 5000)}`)
        .digest("hex")
        .slice(0, 16);
      const file = join(directory, `${createdAt.replace(/[:.]/g, "-")}-${id}.json`);
      const tempFile = `${file}.tmp`;
      writeFileSync(tempFile, JSON.stringify({
        createdAt,
        ...meta,
        runs: items,
      }));
      renameSync(tempFile, file);
      logger?.error(`Saved ${items.length} crawl log run(s) for retry: ${file}`);
      return file;
    },
    async replay(post) {
      if (!existsSync(directory)) return { ok: true, fileCount: 0, runCount: 0 };

      const files = readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .slice(0, replayLimit);
      let runCount = 0;

      for (const file of files) {
        const path = join(directory, file);
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const runs = Array.isArray(raw.runs) ? raw.runs : [];
        if (!runs.length) {
          rmSync(path, { force: true });
          continue;
        }

        await post(runs, raw);
        runCount += runs.length;
        rmSync(path, { force: true });
      }

      if (files.length) {
        logger?.log(`Replayed ${runCount} spooled crawl log run(s) from ${files.length} file(s).`);
      }
      return { ok: true, fileCount: files.length, runCount };
    },
  };
}

function crawlLogRequestBatches(runs, maxRunsPerRequest, maxOffersPerRequest) {
  const batches = [];
  let current = [];
  let currentOffers = 0;

  for (const run of runs) {
    const offerCount = Array.isArray(run.offers) ? run.offers.length : 0;
    const wouldExceedRunLimit = current.length >= maxRunsPerRequest;
    const wouldExceedOfferLimit = current.length > 0 && currentOffers + offerCount > maxOffersPerRequest;

    if (wouldExceedRunLimit || wouldExceedOfferLimit) {
      batches.push(current);
      current = [];
      currentOffers = 0;
    }

    current.push(run);
    currentOffers += offerCount;
  }

  if (current.length) batches.push(current);
  return batches;
}

function postBatchSizeFor(options = {}) {
  const value = Number(
    options.postBatchSize ||
      options["post-batch-size"] ||
      process.env.PRICEAI_COLLECT_POST_BATCH_SIZE ||
      env.PRICEAI_COLLECT_POST_BATCH_SIZE ||
      DEFAULT_POST_BATCH_SIZE,
  );
  if (!Number.isFinite(value)) return DEFAULT_POST_BATCH_SIZE;
  return Math.max(MIN_POST_BATCH_SIZE, Math.min(Math.trunc(value), MAX_POST_BATCH_SIZE));
}

function postRunBatchSizeFor(options = {}) {
  const value = Number(
    options.postRunBatchSize ||
      options["post-run-batch-size"] ||
      process.env.PRICEAI_COLLECT_POST_RUN_BATCH_SIZE ||
      env.PRICEAI_COLLECT_POST_RUN_BATCH_SIZE ||
      10,
  );
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(Math.trunc(value), 50));
}

function postRequestOfferLimitFor(options = {}) {
  const fallback = postBatchSizeFor(options);
  const value = Number(
    options.postRequestOfferLimit ||
      options["post-request-offer-limit"] ||
      process.env.PRICEAI_COLLECT_POST_REQUEST_OFFER_LIMIT ||
      env.PRICEAI_COLLECT_POST_REQUEST_OFFER_LIMIT ||
      fallback,
  );
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), 1000));
}

function fullSnapshotOfferLimitFor(target, options = {}) {
  let defaultLimit = DEFAULT_FULL_SNAPSHOT_OFFER_LIMIT;
  if (target?.kind === "shopApi") {
    defaultLimit = SHOP_API_FULL_SNAPSHOT_OFFER_LIMIT;
  } else if (STRUCTURED_FULL_SNAPSHOT_COLLECTORS.has(target?.kind)) {
    defaultLimit = STRUCTURED_FULL_SNAPSHOT_OFFER_LIMIT;
  }

  const value = Number(
    options.fullSnapshotOfferLimit ||
      options["full-snapshot-offer-limit"] ||
      process.env.PRICEAI_COLLECT_FULL_SNAPSHOT_OFFER_LIMIT ||
      env.PRICEAI_COLLECT_FULL_SNAPSHOT_OFFER_LIMIT ||
      defaultLimit,
  );
  if (!Number.isFinite(value)) return defaultLimit;
  return Math.max(0, Math.min(Math.trunc(value), 2000));
}

function shouldIncludeFullSnapshot(target, offers, status, options = {}, details = {}) {
  if (status !== "success") return false;

  if (target?.kind === "shopApi") {
    if (!shopApiFullSnapshotEvidenceReliable(offers, details)) return false;
    return fullSnapshotEvidenceItemCount(offers, details) <= fullSnapshotOfferLimitFor(target, options);
  }

  if (details.fullSnapshot === false) return false;
  return offers.length <= fullSnapshotOfferLimitFor(target, options);
}

function shopApiFullSnapshotEvidenceReliable(offers, details = {}) {
  if (details.fullSnapshot === false) return false;
  const fetchedItemCount = nonNegativeInteger(details.fetchedItemCount);
  const rawSeenOfferCount = nonNegativeInteger(details.rawSeenOfferCount);
  const publishedItemCount = nonNegativeInteger(details.publishedItemCount);
  const reportedGoodsCount = nonNegativeInteger(details.reportedGoodsCount);

  if (
    fetchedItemCount === null ||
    rawSeenOfferCount === null ||
    publishedItemCount === null ||
    reportedGoodsCount === null
  ) {
    return false;
  }

  return (
    shopApiSnapshotCoverageIsSufficient(reportedGoodsCount, fetchedItemCount) &&
    fetchedItemCount >= rawSeenOfferCount &&
    rawSeenOfferCount >= publishedItemCount &&
    publishedItemCount >= offers.length
  );
}

function shopApiSnapshotCoverageIsSufficient(reportedGoodsCount, fetchedItemCount) {
  if (reportedGoodsCount === 0) return fetchedItemCount === 0;
  return fetchedItemCount / reportedGoodsCount >= SHOP_API_FULL_SNAPSHOT_MIN_COVERAGE;
}

function shopApiSnapshotReportedGoodsCount(listReportedTotal, shopReportedGoods) {
  return nonNegativeInteger(listReportedTotal) ?? nonNegativeInteger(shopReportedGoods);
}

function fullSnapshotEvidenceItemCount(offers, details = {}) {
  return Math.max(
    offers.length,
    nonNegativeInteger(details.fetchedItemCount) || 0,
    nonNegativeInteger(details.rawSeenOfferCount) || 0,
    nonNegativeInteger(details.publishedItemCount) || 0,
    nonNegativeInteger(details.reportedGoodsCount) || 0,
  );
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

function isEmptyResultFullSnapshotTarget(target, details = {}) {
  if (EMPTY_FULL_SNAPSHOT_COLLECTORS.has(target.kind)) return true;
  return target.kind === "shopApi" && shopApiFullSnapshotEvidenceReliable([], details);
}

function flushSourceCountFor(options = {}) {
  const value = Number(
    options.flushSourceCount ||
      options["flush-source-count"] ||
      process.env.PRICEAI_COLLECT_FLUSH_SOURCE_COUNT ||
      env.PRICEAI_COLLECT_FLUSH_SOURCE_COUNT ||
      DEFAULT_FLUSH_SOURCE_COUNT,
  );
  if (!Number.isFinite(value)) return DEFAULT_FLUSH_SOURCE_COUNT;
  return Math.max(1, Math.min(Math.trunc(value), 50));
}

function flushIntervalMsFor(options = {}) {
  const value = Number(
    options.flushIntervalMs ||
      options["flush-interval-ms"] ||
      process.env.PRICEAI_COLLECT_FLUSH_INTERVAL_MS ||
      env.PRICEAI_COLLECT_FLUSH_INTERVAL_MS ||
      DEFAULT_FLUSH_INTERVAL_MS,
  );
  if (!Number.isFinite(value)) return DEFAULT_FLUSH_INTERVAL_MS;
  return Math.max(5_000, Math.min(Math.trunc(value), 10 * 60_000));
}

function crawlLogSpoolDirectory(options = {}) {
  const value =
    options.crawlLogSpoolDir ||
    options["crawl-log-spool-dir"] ||
    process.env.PRICEAI_CRAWL_LOG_SPOOL_DIR ||
    env.PRICEAI_CRAWL_LOG_SPOOL_DIR;
  return value ? String(value) : join(tmpdir(), "priceai-crawl-log-spool");
}

function spoolReplayLimitFor(options = {}) {
  const value = Number(
    options.spoolReplayLimit ||
      options["spool-replay-limit"] ||
      process.env.PRICEAI_CRAWL_LOG_SPOOL_REPLAY_LIMIT ||
      env.PRICEAI_CRAWL_LOG_SPOOL_REPLAY_LIMIT ||
      DEFAULT_SPOOL_REPLAY_LIMIT,
  );
  if (!Number.isFinite(value)) return DEFAULT_SPOOL_REPLAY_LIMIT;
  return Math.max(0, Math.min(Math.trunc(value), 500));
}

function collectorNodeDetails(options = {}) {
  const id =
    options.collectorNodeId ||
    options["collector-node-id"] ||
    process.env.PRICEAI_COLLECTOR_NODE_ID ||
    env.PRICEAI_COLLECTOR_NODE_ID ||
    defaultCollectorNodeId();
  const name =
    options.collectorNodeName ||
    options["collector-node-name"] ||
    process.env.PRICEAI_COLLECTOR_NODE_NAME ||
    env.PRICEAI_COLLECTOR_NODE_NAME ||
    defaultCollectorNodeName(id);
  const type =
    options.collectorNodeType ||
    options["collector-node-type"] ||
    process.env.PRICEAI_COLLECTOR_NODE_TYPE ||
    env.PRICEAI_COLLECTOR_NODE_TYPE ||
    defaultCollectorNodeType();
  const runtime =
    options.collectorNodeRuntime ||
    options["collector-node-runtime"] ||
    process.env.PRICEAI_COLLECTOR_NODE_RUNTIME ||
    env.PRICEAI_COLLECTOR_NODE_RUNTIME ||
    defaultCollectorNodeRuntime();
  const region =
    options.collectorNodeRegion ||
    options["collector-node-region"] ||
    process.env.PRICEAI_COLLECTOR_NODE_REGION ||
    env.PRICEAI_COLLECTOR_NODE_REGION ||
    process.env.VERCEL_REGION ||
    null;

  return compactObject({
    id,
    name,
    type,
    runtime,
    region,
  });
}

function defaultCollectorNodeId() {
  if (process.env.GITHUB_ACTIONS === "true") return "github-actions";
  if (process.env.VERCEL) return "vercel-cron";
  return "unknown-node";
}

function defaultCollectorNodeName(id) {
  if (id === "github-actions") return "GitHub Actions";
  if (id === "vercel-cron") return "Vercel Cron";
  return "未知节点";
}

function defaultCollectorNodeType() {
  if (process.env.GITHUB_ACTIONS === "true") return "ci";
  if (process.env.VERCEL) return "vercel";
  return "unknown";
}

function defaultCollectorNodeRuntime() {
  if (process.env.GITHUB_ACTIONS === "true") return "github-actions";
  if (process.env.VERCEL) return "vercel-cron";
  return "manual";
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""),
  );
}

function offerIdsForSnapshot(offers) {
  return offers.map((offer) => stableOfferInputId(offer));
}

function seenOfferIdsForSnapshot(offers, details = {}) {
  if (Array.isArray(details.seenOfferIds)) {
    const ids = details.seenOfferIds.map((value) => String(value || "").trim()).filter(Boolean);
    if (ids.length) return ids;
  }

  return offerIdsForSnapshot(offers);
}

function stableShopApiOfferIdFromUrl(value) {
  const shopItemUrl = normalizeShopApiItemOfferUrl(value);
  return shopItemUrl ? stableId("shop-api-offer", shopItemUrl) : null;
}

function stableOfferInputId(offer) {
  const shopItemUrl = normalizeShopApiItemOfferUrl(offer.url);
  if (shopItemUrl) return stableId("shop-api-offer", shopItemUrl);

  return stableId(offer.sourceName, offer.sourceStoreName, offer.sourceTitle, offer.url);
}

function stableId(...parts) {
  return `id-${stableHashInt(...parts).toString(36)}`;
}

function stableHashInt(...parts) {
  const input = parts.filter((part) => part !== null && part !== undefined).join("|");
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return hash >>> 0;
}

function positiveModulo(value, divisor) {
  const normalizedDivisor = Math.max(1, Math.trunc(Number(divisor) || 1));
  return ((Math.trunc(Number(value) || 0) % normalizedDivisor) + normalizedDivisor) % normalizedDivisor;
}

function selectTargets(targets, options) {
  const selected = options.source || options.id || options.name;
  const runnable = (target) => target.kind;
  const applyExclusions = (items) => items
    .filter((target) => matchesTargetKinds(target, options))
    .filter((target) => matchesTargetFamilies(target, options))
    .filter((target) => !shouldExcludeTarget(target, options));
  if (!selected && !options.all) return applyExclusions(targets.filter(runnable));
  if (options.all) return applyExclusions(targets.filter(runnable));

  const query = String(selected).toLowerCase();
  const exact = applyExclusions(targets.filter((target) => runnable(target) && String(target.sourceId).toLowerCase() === query));
  if (exact.length) return exact;

  return applyExclusions(
    targets.filter((target) =>
      runnable(target) &&
      [target.sourceId, target.sourceName, target.sourceUrl, target.kind, target.configuredKind]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    ),
  );
}

function selectBuiltinTargets(options = {}) {
  const selected = options.source || options.id || options.name;
  if (!selected || options.all) return [];

  const query = String(selected).toLowerCase();
  return BUILTIN_SOURCES
    .map((source) => buildTarget(source, []))
    .map((target) => ({ ...target, builtinFallback: true }))
    .filter((target) => target.kind)
    .filter((target) => matchesTargetKinds(target, options))
    .filter((target) => matchesTargetFamilies(target, options))
    .filter((target) => !shouldExcludeTarget(target, options))
    .filter((target) =>
      [target.sourceId, target.sourceName, target.sourceUrl, target.kind, target.configuredKind]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
}

function targetGroupsForCollection(targets, options = {}) {
  const groups = new Map();
  for (const target of targets) {
    const key = collectionGroupKeyForTarget(target, options);
    const existing = groups.get(key);
    if (existing) {
      existing.targets.push(target);
    } else {
      groups.set(key, { key, targets: [target] });
    }
  }
  for (const group of groups.values()) {
    sortTargetsForCollectionGroup(group.targets);
  }
  return [...groups.values()];
}

function collectionGroupKeyForTarget(target, options = {}) {
  const host = normalizeHostname(target.baseUrl || target.sourceUrl) || target.sourceId;
  const proxyParallelism = shopApiProxyParallelismFor(options);
  if (
    proxyParallelism <= 1 ||
    !collectionFamilyForTarget(target) ||
    !hasShopApiProxyConfigured(options)
  ) {
    return host;
  }

  const lane = stableHashInt("shop-api-proxy-lane", target.sourceId || target.sourceName || "") % proxyParallelism;
  return `${host}:proxy-lane:${lane}`;
}

function shopApiProxyPoolKeyForTarget(target, options = {}) {
  const host = normalizeHostname(target.baseUrl || target.sourceUrl) || target.sourceId;
  const proxyParallelism = shopApiProxyParallelismFor(options);
  if (proxyParallelism <= 1) return host;

  const lane = stableHashInt("shop-api-proxy-lane", target.sourceId || target.sourceName || "") % proxyParallelism;
  return `${host}:proxy-lane:${lane}`;
}

function sortTargetsForCollectionGroup(targets) {
  if (targets.length <= 1) return targets;
  if (!targets.some((target) => collectionFamilyForTarget(target))) return targets;

  return targets.sort((a, b) => {
    const familyA = collectionFamilyForTarget(a);
    const familyB = collectionFamilyForTarget(b);
    if (familyA && !familyB) return -1;
    if (!familyA && familyB) return 1;
    if (familyA?.key !== familyB?.key) return String(familyA?.key || "").localeCompare(String(familyB?.key || ""));
    const scheduleDiff = collectionScheduleRank(a) - collectionScheduleRank(b);
    if (scheduleDiff) return scheduleDiff;

    return compareTargetFreshness(a, b);
  });
}

function collectionScheduleRank(target) {
  const tier = target.collectionSchedule?.tier;
  return tier ? shopCollectionTierRank(tier) : SHOP_COLLECTION_TIER_DEFINITIONS.length;
}

function compareTargetFreshness(a, b) {
  const checkedA = targetCheckedAtMs(a);
  const checkedB = targetCheckedAtMs(b);
  if (!Number.isFinite(checkedA) && !Number.isFinite(checkedB)) {
    return String(a.sourceName || a.sourceId).localeCompare(String(b.sourceName || b.sourceId));
  }
  if (!Number.isFinite(checkedA)) return -1;
  if (!Number.isFinite(checkedB)) return 1;
  if (checkedA !== checkedB) return checkedA - checkedB;
  return String(a.sourceName || a.sourceId).localeCompare(String(b.sourceName || b.sourceId));
}

function targetCheckedAtMs(target) {
  const value = target.lastCheckedAt || target.lastSuccessAt;
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildCollectionPerformanceReport({
  summary,
  targets,
  groups,
  concurrency,
  startedAt,
  finishedAt,
  durationMs,
  shopSchedule = null,
}) {
  const byKind = aggregateCollectionBy(summary, (item) => item.kind || "unknown");
  const byStatus = aggregateCollectionBy(summary, (item) => item.status || "unknown");
  const slowestTargets = [...summary]
    .sort((a, b) => Number(b.ms || 0) - Number(a.ms || 0))
    .slice(0, 10)
    .map((item) => ({
      sourceId: item.sourceId,
      source: item.source,
      kind: item.kind,
      status: item.status,
      offers: item.offers,
      attempts: item.attempts,
      ms: item.ms,
      message: item.message || null,
    }));
  const multiTargetGroups = groups
    .filter((group) => group.targets.length > 1)
    .map((group) => ({
      key: group.key,
      targetCount: group.targets.length,
      sourceIds: group.targets.map((target) => target.sourceId),
    }))
    .sort((a, b) => b.targetCount - a.targetCount);

  return {
    startedAt,
    finishedAt,
    durationMs,
    concurrency,
    targetCount: targets.length,
    groupCount: groups.length,
    multiTargetGroupCount: multiTargetGroups.length,
    offers: summary.reduce((sum, item) => sum + Number(item.offers || 0), 0),
    byStatus,
    byKind,
    shopScheduler: shopSchedule,
    slowestTargets,
    multiTargetGroups: multiTargetGroups.slice(0, 10),
  };
}

function aggregateCollectionBy(items, keyForItem) {
  const map = new Map();

  for (const item of items) {
    const key = String(keyForItem(item) || "unknown");
    const existing = map.get(key) || {
      key,
      targets: 0,
      offers: 0,
      attempts: 0,
      totalMs: 0,
      maxMs: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    };

    existing.targets += 1;
    existing.offers += Number(item.offers || 0);
    existing.attempts += Number(item.attempts || 0);
    existing.totalMs += Number(item.ms || 0);
    existing.maxMs = Math.max(existing.maxMs, Number(item.ms || 0));
    if (item.status === "success") existing.success += 1;
    else if (item.status === "skipped") existing.skipped += 1;
    else existing.failed += 1;
    map.set(key, existing);
  }

  return [...map.values()]
    .map((entry) => ({
      ...entry,
      avgMs: entry.targets ? Math.round(entry.totalMs / entry.targets) : 0,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function printCollectionPerformance(performance) {
  if (!performance) return;

  console.log("\nPerformance");
  console.table([
    {
      targets: performance.targetCount,
      groups: performance.groupCount,
      concurrency: performance.concurrency,
      durationMs: performance.durationMs,
      offers: performance.offers,
      multiTargetGroups: performance.multiTargetGroupCount,
    },
  ]);

  if (performance.byKind?.length) {
    console.log("\nBy collector kind");
    console.table(performance.byKind);
  }

  if (performance.shopScheduler?.enabled) {
    console.log("\nShop scheduler");
    console.table([
      {
        candidates: performance.shopScheduler.candidateCount,
        shardCandidates: performance.shopScheduler.shardCandidateCount,
        ready: performance.shopScheduler.readyCount,
        due: performance.shopScheduler.dueCount,
        skipped: performance.shopScheduler.skippedCount,
        deferredByLimit: performance.shopScheduler.deferredByLimitCount,
        skippedByShard: performance.shopScheduler.skippedByShardCount,
        passthrough: performance.shopScheduler.passthroughCount,
        effectiveTargets: performance.shopScheduler.effectiveTargetCount,
        shard: `${Number(performance.shopScheduler.schedulerShardIndex || 0) + 1}/${performance.shopScheduler.schedulerShardCount || 1}`,
      },
    ]);
    console.table(performance.shopScheduler.tiers);
  } else if (performance.shopScheduler?.reason) {
    console.log(`\nShop scheduler: ${performance.shopScheduler.reason}`);
  }

  if (performance.slowestTargets?.length) {
    console.log("\nSlowest targets");
    console.table(performance.slowestTargets);
  }
}

function hasTargetFilters(options = {}) {
  return Boolean(
    options.source ||
      options.id ||
      options.name ||
      options.kind ||
      options.kinds ||
      options["collector-kind"] ||
      options["collector-kinds"] ||
      options.includeFamily ||
      options["include-family"] ||
      options.includeFamilies ||
      options["include-families"] ||
      options.excludeKind ||
      options["exclude-kind"] ||
      options.excludeKinds ||
      options["exclude-kinds"] ||
      options.excludeFamily ||
      options["exclude-family"] ||
      options.excludeFamilies ||
      options["exclude-families"] ||
      options.excludeSource ||
      options["exclude-source"] ||
      options.excludeSources ||
      options["exclude-sources"],
  );
}

function shouldExcludeTarget(target, options = {}) {
  const kinds = optionList(options.excludeKind || options["exclude-kind"] || options.excludeKinds || options["exclude-kinds"]);
  if (
    kinds.includes(String(target.kind || "").toLowerCase()) ||
    kinds.includes(String(target.configuredKind || "").toLowerCase())
  ) {
    return true;
  }

  const families = optionList(options.excludeFamily || options["exclude-family"] || options.excludeFamilies || options["exclude-families"]);
  if (families.some((family) => targetFamilyAliases(target).has(family))) return true;

  const sourceIds = optionList(options.excludeSource || options["exclude-source"] || options.excludeSources || options["exclude-sources"]);
  if (sourceIds.includes(String(target.sourceId || "").toLowerCase())) return true;
  return false;
}

function matchesTargetKinds(target, options = {}) {
  const kinds = optionList(options.kind || options.kinds || options["collector-kind"] || options["collector-kinds"]);
  if (!kinds.length) return true;

  return kinds.includes(String(target.kind || "").toLowerCase()) ||
    kinds.includes(String(target.configuredKind || "").toLowerCase());
}

function matchesTargetFamilies(target, options = {}) {
  const families = optionList(options.includeFamily || options["include-family"] || options.includeFamilies || options["include-families"]);
  if (!families.length) return true;

  const aliases = targetFamilyAliases(target);
  return families.some((family) => aliases.has(family));
}

async function applyShopCollectionScheduler(targets, options = {}, logger = null) {
  const passthroughTargets = [];
  const shopTargets = [];
  const schedulerGroup = shopCollectionSchedulerGroupFor(options);

  for (const target of targets) {
    if (target.kind === "shopApi" && !shopCollectionSchedulerGroupMatches(target, options)) continue;
    if (target.kind === "shopApi" && schedulerGroup === "vip_15m" && !collectionFamilyForTarget(target)) continue;
    if (shouldScheduleShopCollectionTarget(target)) {
      shopTargets.push(target);
      continue;
    }
    passthroughTargets.push(target);
  }
  const eligibleTargets = [...passthroughTargets, ...shopTargets];
  const vipOnly = schedulerGroup === "vip_15m";

  const disabledSummary = (reason, extra = {}) => ({
    enabled: false,
    reason,
    candidateCount: shopTargets.length,
    readyCount: shopTargets.length,
    dueCount: shopTargets.length,
    skippedCount: 0,
    deferredByLimitCount: 0,
    passthroughCount: passthroughTargets.length,
    effectiveTargetCount: targets.length,
    tiers: [],
    dueSamples: [],
    skippedSamples: [],
    ...extra,
  });

  if (!shopTargets.length) {
    return {
      targets: passthroughTargets,
      summary: disabledSummary("no-shop-api-targets", {
        readyCount: 0,
        dueCount: 0,
        effectiveTargetCount: passthroughTargets.length,
      }),
    };
  }

  if (!shouldUseShopCollectionScheduler(options)) {
    return { targets: eligibleTargets, summary: disabledSummary("disabled", { effectiveTargetCount: eligibleTargets.length }) };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    const fallbackTargets = vipOnly ? passthroughTargets : eligibleTargets;
    return { targets: fallbackTargets, summary: disabledSummary("supabase-unconfigured", { effectiveTargetCount: fallbackTargets.length }) };
  }

  try {
    const contextLoader = typeof options.shopSchedulerContextLoader === "function"
      ? options.shopSchedulerContextLoader
      : loadShopCollectionSchedulerContext;
    const context = await contextLoader(supabase, shopTargets, options);
    const nowMs = Date.now();
    const schedulerOptions = shopCollectionSchedulerOptionsFor(options);
    const shardConfig = shopCollectionSchedulerShardConfig(options);
    const evaluated = shopTargets
      .map((target) => assignShopCollectionSchedulerShard(
        evaluateShopCollectionScheduleTarget(target, context, nowMs, schedulerOptions),
        shardConfig,
        context.shardAssignmentsBySource,
      ))
      .sort(compareShopCollectionScheduleRows);
    const shardRows = evaluated.filter((row) => row.shardMatches);
    const foreignShardRows = evaluated
      .filter((row) => !row.shardMatches)
      .map((row) => ({
        ...row,
        due: false,
        deferredReason: `分片 ${row.schedulerShardIndex + 1}/${row.schedulerShardCount} 由其他节点处理`,
      }));
    const readyRows = shardRows.filter((row) => row.due);
    const limited = limitShopCollectionDueRowsByFamily(readyRows, options);
    const dueRows = limited.dueRows;
    const skippedRows = [
      ...shardRows.filter((row) => !row.due),
      ...limited.deferredRows,
      ...foreignShardRows,
    ].sort(compareShopCollectionScheduleRows);
    const summaryRows = [...dueRows, ...skippedRows].sort(compareShopCollectionScheduleRows);
    const dueTargets = dueRows.map((row) => ({
      ...row.target,
      collectionSchedule: compactObject({
        tier: row.tier,
        tierLabel: row.tierLabel,
        intervalMinutes: row.intervalMinutes,
        lastRunAt: row.lastRunAt,
        nextRunAt: row.nextRunAt,
        reasons: row.reasons,
        schedulerShardIndex: row.schedulerShardIndex,
        schedulerShardCount: row.schedulerShardCount,
        schedulerBucketMinutes: row.schedulerBucketMinutes,
        schedulerBucketIndex: row.schedulerBucketIndex,
        schedulerBucketCount: row.schedulerBucketCount,
      }),
    }));
    const scheduledTargets = [...passthroughTargets, ...dueTargets];
    const summary = {
      enabled: true,
      reason: "ok",
      candidateCount: shopTargets.length,
      shardCandidateCount: shardRows.length,
      totalReadyCount: evaluated.filter((row) => row.due).length,
      readyCount: readyRows.length,
      dueCount: dueRows.length,
      skippedCount: skippedRows.length,
      deferredByLimitCount: limited.deferredRows.length,
      skippedByShardCount: foreignShardRows.length,
      passthroughCount: passthroughTargets.length,
      effectiveTargetCount: scheduledTargets.length,
      schedulerBucketMinutes: schedulerOptions.bucketMinutes,
      schedulerShardIndex: shardConfig.index,
      schedulerShardCount: shardConfig.count,
      tiers: buildShopCollectionScheduleTierStats(summaryRows),
      dueSamples: dueRows.slice(0, 10).map(compactShopCollectionScheduleRow),
      skippedSamples: skippedRows.slice(0, 10).map(compactShopCollectionScheduleRow),
    };

    logger?.log(
      `Shop scheduler selected ${dueRows.length}/${shopTargets.length} shopApi source(s); ` +
        `${skippedRows.length} held for later.`,
    );
    return { targets: scheduledTargets, summary };
  } catch (error) {
    logger?.error(`Shop scheduler fell back to existing cooldowns: ${errorMessage(error)}`);
    const fallbackTargets = vipOnly ? passthroughTargets : eligibleTargets;
    return {
      targets: fallbackTargets,
      summary: disabledSummary("scheduler-context-failed", {
        effectiveTargetCount: fallbackTargets.length,
        message: errorMessage(error),
      }),
    };
  }
}

function shouldScheduleShopCollectionTarget(target) {
  return target.kind === "shopApi" && Boolean(collectionFamilyForTarget(target));
}

function shopCollectionSchedulerGroupMatches(target, options = {}) {
  const group = shopCollectionSchedulerGroupFor(options);
  if (!group || group === "all") return true;
  if (group === "vip_15m") return target.collectionGroup === "vip_15m";
  return target.collectionGroup !== "vip_15m";
}

function shopCollectionSchedulerGroupFor(options = {}) {
  return String(
    optionValue(options, "shopSchedulerGroup", "shop-scheduler-group") ||
    runtimeEnvValue("PRICEAI_SHOP_SCHEDULER_GROUP") ||
    "automatic",
  ).trim().toLowerCase();
}

function shouldUseShopCollectionScheduler(options = {}) {
  if (truthyFlag(options["no-shop-scheduler"]) || truthyFlag(options.noShopScheduler)) return false;
  if (truthyFlag(options.force) || truthyFlag(options["no-cooldown"])) return false;
  if (options.source || options.id || options.name) return false;

  const explicit =
    options.shopScheduler ??
    options["shop-scheduler"] ??
    process.env.PRICEAI_SHOP_COLLECTION_SCHEDULER ??
    env.PRICEAI_SHOP_COLLECTION_SCHEDULER;
  if (falseyFlag(explicit)) return false;
  if (truthyFlag(explicit)) return true;

  return truthyFlag(options.all) || (!options.source && !options.id && !options.name);
}

function isShopCollectionSchedulerPlanMode(options = {}) {
  return truthyFlag(options.shopSchedulerPlan) || truthyFlag(options["shop-scheduler-plan"]);
}

async function loadShopCollectionSchedulerContext(supabase, targets, options = {}) {
  const sourceIds = Array.from(new Set(targets.map((target) => target.sourceId).filter(Boolean)));
  const [offerStats, priceStats, crawlRuns, shardAssignments] = await Promise.all([
    listShopCollectionSourceOfferStats(supabase),
    listShopCollectionPriceStats(supabase, { refresh: shopCollectionSchedulerGroupFor(options) !== "vip_15m" }),
    listShopCollectionRecentCrawlRuns(supabase, sourceIds),
    listShopCollectionShardAssignments(supabase, sourceIds),
  ]);

  return {
    offerStatsBySource: new Map(offerStats.map((row) => [row.sourceId, row])),
    priceStatsBySource: new Map(priceStats.map((row) => [row.sourceId, row])),
    latestRunBySource: latestShopCollectionCrawlRunBySource(crawlRuns),
    shardAssignmentsBySource: shardAssignments,
  };
}

async function listShopCollectionShardAssignments(supabase, sourceIds) {
  if (!sourceIds.length) return new Map();
  const { data, error } = await supabase
    .from("source_shard_assignments")
    .select("source_id,shard_index")
    .eq("collector_kind", "shopApi")
    .eq("family", "ldxp")
    .eq("shard_count", 2)
    .eq("active", true)
    .in("source_id", sourceIds);
  if (error) {
    if (/source_shard_assignments|schema cache|does not exist/i.test(error.message || "")) return new Map();
    throw error;
  }
  return new Map((data || []).map((row) => [String(row.source_id), Number(row.shard_index)]));
}

async function listShopCollectionSourceOfferStats(supabase) {
  const { data, error } = await supabase.rpc("list_source_offer_stats");
  if (error) throw error;

  return ((data || [])).map((row) => ({
    sourceId: String(row.source_id || ""),
    visibleCount: Number(row.visible_count || 0),
    hiddenCount: Number(row.hidden_count || 0),
    totalCount: Number(row.total_count || 0),
  })).filter((row) => row.sourceId);
}

async function listShopCollectionPriceStats(supabase, options = {}) {
  if (options.refresh !== false) {
    const refreshResult = await supabase.rpc("refresh_source_quality_price_benchmarks_if_stale", {
      p_max_age_minutes: 15,
    });
    if (refreshResult.error) {
      console.warn(`Shop scheduler benchmark refresh skipped: ${errorMessage(refreshResult.error)}`);
    }
  }

  const { data, error } = await supabase.rpc("list_source_quality_price_benchmarks");
  if (error) throw error;

  return ((data || [])).map((row) => ({
    sourceId: String(row.source_id || ""),
    benchmarkOfferCount: Number(row.benchmark_offer_count || 0),
    lowestHitCount: Number(row.lowest_hit_count || 0),
    top5HitCount: Number(row.top5_hit_count || 0),
    within10PctCount: Number(row.within_10pct_count || 0),
    within20PctCount: Number(row.within_20pct_count || 0),
    sampleScopes: shopCollectionPriceSampleScopes(row.sample_scopes),
  })).filter((row) => row.sourceId);
}

async function listShopCollectionRecentCrawlRuns(supabase, sourceIds) {
  const rows = [];
  for (const ids of chunks(sourceIds, SHOP_COLLECTION_SCHEDULER_CRAWL_RUN_CHUNK_SIZE)) {
    if (!ids.length) continue;
    const { data, error } = await supabase
      .from("crawl_runs")
      .select(SHOP_COLLECTION_SCHEDULER_CRAWL_RUN_SELECT)
      .in("source_id", ids)
      .order("started_at", { ascending: false })
      .limit(Math.max(120, ids.length * 4));
    if (error) throw error;
    rows.push(...(data || []).map(mapShopCollectionCrawlRun));
  }
  return rows;
}

function mapShopCollectionCrawlRun(row) {
  return {
    id: String(row.id),
    sourceId: row.source_id ? String(row.source_id) : null,
    sourceName: row.source_name ? String(row.source_name) : null,
    mode: String(row.mode || "manual"),
    status: String(row.status || "failed"),
    startedAt: String(row.started_at || new Date().toISOString()),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    successCount: Number(row.success_count || 0),
    failureCount: Number(row.failure_count || 0),
    message: row.message ? String(row.message) : null,
    details: asPlainRecord(row.details),
  };
}

function latestShopCollectionCrawlRunBySource(runs) {
  const latestGroups = new Map();
  for (const run of runs) {
    if (!run.sourceId) continue;
    if (run.details?.hotVerification === true) continue;
    const observedAt = shopCollectionCrawlRunObservedAt(run);
    const current = latestGroups.get(run.sourceId);
    if (!current || observedAt > current.observedAt) {
      latestGroups.set(run.sourceId, { observedAt, startedAt: run.startedAt, runs: [run] });
      continue;
    }
    if (observedAt === current.observedAt && run.startedAt === current.startedAt) current.runs.push(run);
  }
  return new Map(
    Array.from(latestGroups, ([sourceId, group]) => [sourceId, aggregateShopCollectionCrawlRunGroup(group.runs)]),
  );
}

function aggregateShopCollectionCrawlRunGroup(runs) {
  if (runs.length <= 1) return runs[0];
  const ordered = [...runs].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const statuses = new Set(ordered.map((run) => run.status));
  const writeStats = ordered.map(shopCollectionCrawlWriteStats);
  const sumNullable = (values) => values.every((value) => value === null)
    ? null
    : values.reduce((total, value) => total + Number(value || 0), 0);
  const first = ordered[0];
  return {
    ...first,
    id: ordered.map((run) => run.id).join("+"),
    status: statuses.size === 1 ? first.status : statuses.has("failed") ? "partial" : "success",
    successCount: ordered.reduce((total, run) => total + Number(run.successCount || 0), 0),
    failureCount: ordered.reduce((total, run) => total + Number(run.failureCount || 0), 0),
    details: {
      ...asPlainRecord(first.details),
      batchRunIds: ordered.map((run) => run.id),
      writeStats: {
        receivedCount: sumNullable(writeStats.map((stats) => stats.receivedCount)),
        writtenCount: sumNullable(writeStats.map((stats) => stats.writtenCount)),
        refreshedCount: sumNullable(writeStats.map((stats) => stats.refreshedCount)),
      },
    },
  };
}

function evaluateShopCollectionScheduleTarget(target, context, nowMs, schedulerOptions = shopCollectionSchedulerOptionsFor()) {
  const latestRun = context.latestRunBySource.get(target.sourceId);
  const offerStats = context.offerStatsBySource.get(target.sourceId);
  const priceStats = context.priceStatsBySource.get(target.sourceId);
  const writeStats = shopCollectionCrawlWriteStats(latestRun);
  const receivedCount = writeStats.receivedCount ??
    (latestRun?.status === "success" || latestRun?.status === "partial" ? latestRun.successCount : null);
  const writtenCount = writeStats.writtenCount;
  const changeDensity = receivedCount !== null && receivedCount > 0 && writtenCount !== null
    ? Math.round((writtenCount / receivedCount) * 1000) / 1000
    : null;
  const offerCount = offerStats?.visibleCount ?? target.rawOffers?.length ?? 0;
  const scaleBand = shopCollectionScaleBand(offerCount);
  const changeBand = shopCollectionChangeBand({ receivedCount, writtenCount, changeDensity });
  const lowPriceBand = shopCollectionLowPriceBand(priceStats);
  const hotEvidence = shopHotProductEvidenceFromPriceStats(priceStats);
  const tierResult = classifyShopCollectionScheduleTier({
    target,
    latestRun,
    scaleBand,
    changeBand,
    lowPriceBand,
    hotProductOfferCount: hotEvidence.offerCount,
    hotProductLowestHitCount: hotEvidence.lowestHitCount,
    hotProductTop5HitCount: hotEvidence.top5HitCount,
  });
  const tierDefinition = shopCollectionTierDefinition(tierResult.tier);
  const lastRunAt = shopCollectionScheduleReferenceAt(target, latestRun, tierResult.tier);
  const lastRunMs = timestampMs(lastRunAt);
  const intervalMs = tierDefinition.intervalMinutes * 60_000;
  const timing = shopCollectionScheduleTiming({
    sourceId: target.sourceId,
    tier: tierDefinition.tier,
    intervalMs,
    lastRunMs,
    nowMs,
    bucketMinutes: schedulerOptions.bucketMinutes,
    immediate: tierDefinition.tier === "new_source_bootstrap",
  });

  return {
    target,
    sourceId: target.sourceId,
    sourceName: target.sourceName,
    tier: tierDefinition.tier,
    tierLabel: tierDefinition.label,
    tierRank: shopCollectionTierRank(tierDefinition.tier),
    intervalMinutes: tierDefinition.intervalMinutes,
    due: timing.due,
    lastRunAt,
    nextRunAt: timing.nextRunAt,
    remainingMinutes: timing.remainingMinutes,
    schedulerBucketMinutes: schedulerOptions.bucketMinutes,
    schedulerBucketIndex: timing.bucketIndex,
    schedulerBucketCount: timing.bucketCount,
    schedulerBucketMatches: timing.bucketMatches,
    offerCount,
    scaleBand,
    changeBand,
    lowPriceBand,
    receivedCount,
    writtenCount,
    changeDensity,
    lowestHitCount: priceStats?.lowestHitCount || 0,
    top5HitCount: priceStats?.top5HitCount || 0,
    hotProductOfferCount: hotEvidence.offerCount,
    hotProductLowestHitCount: hotEvidence.lowestHitCount,
    hotProductTop5HitCount: hotEvidence.top5HitCount,
    reasons: tierResult.reasons,
  };
}

function classifyShopCollectionScheduleTier(input) {
  const reasons = [];
  const consecutiveFailures = Number(input.target.consecutiveFailures || 0);
  const hasSuccessfulHistory = Boolean(input.target.lastSuccessAt) ||
    ((input.latestRun?.status === "success" || input.latestRun?.status === "partial") && Number(input.latestRun?.successCount || 0) > 0);
  const hasAttemptHistory = Boolean(input.latestRun || input.target.lastCheckedAt);
  const runtimeIssue = sourceQualityRuntimeIssueLabel(input.target.lastError || input.latestRun?.message || null);
  const hasFailure =
    input.target.healthStatus === "failing" ||
    input.target.healthStatus === "retrying" ||
    consecutiveFailures > 0 ||
    input.latestRun?.status === "failed";
  const strongLowPrice = input.lowPriceBand === "strong" || input.lowPriceBand === "top5";
  const hotLowPrice = input.hotProductLowestHitCount > 0 || input.hotProductTop5HitCount > 0;
  const hasHotProduct = input.hotProductOfferCount > 0;

  if (!hasSuccessfulHistory && !hasAttemptHistory) {
    reasons.push("新审核通过来源，先立即完整初始化");
    return { tier: "new_source_bootstrap", reasons };
  }

  const outOfStockSchedule = outOfStockObservationSchedule(input.target);
  if (outOfStockSchedule) {
    reasons.push(outOfStockSchedule.reason);
    return { tier: outOfStockSchedule.tier, reasons };
  }

  if (hasFailure) {
    reasons.push(runtimeIssue ? `最近失败：${runtimeIssue}` : consecutiveFailures ? `连续失败 ${consecutiveFailures} 次` : "最近采集失败");
    if (isDailyProbeFailure(input.target.lastError, consecutiveFailures)) {
      reasons.push("店铺正常但完整商品快照为空，降为每日复检");
      return { tier: "daily_probe", reasons };
    }
    if (isWeeklyProbeFailure(input.target.lastError, consecutiveFailures)) {
      reasons.push("连续站点异常，保留原因并降为每周复检");
      return { tier: "weekly_probe", reasons };
    }
    if (input.target.collectionGroup === "vip_15m" && runtimeIssue) {
      reasons.push("VIP 来源发生可恢复运行错误，保持 1h 恢复重试");
      return { tier: "retry_priority", reasons };
    }
    if (strongLowPrice || hotLowPrice || hasHotProduct) {
      reasons.push("仍有低价或重点商品价值，冷却后优先重试");
      return { tier: "retry_priority", reasons };
    }
    reasons.push("价值信号较弱，先延长冷却");
    return { tier: "retry_cooldown", reasons };
  }

  if (input.target.collectionGroup === "vip_15m") {
    reasons.push("后台指定 VIP 15分钟监测");
    return { tier: "vip_15m", reasons };
  }

  if ((input.changeBand === "high" && strongLowPrice) || (hotLowPrice && strongLowPrice && input.changeBand !== "low")) {
    reasons.push(input.changeBand === "high" ? "高变化 + 低价优势" : "重点商品低价优势");
    return { tier: "core_30m", reasons };
  }

  if ((input.changeBand === "low" || input.changeBand === "unknown") && hotLowPrice) {
    reasons.push("低变化但固定重点商品低价命中");
    reasons.push("保留 1h 低价守护");
    return { tier: "lowprice_guard_1h", reasons };
  }

  if (input.changeBand === "high" || input.changeBand === "medium") {
    reasons.push(input.changeBand === "high" ? "变化高但低价证据不足" : "中等变化");
    if (input.scaleBand === "large" || input.scaleBand === "huge") reasons.push("大店按变化密度修正，不直接进 30m");
    return { tier: "watch_1h", reasons };
  }

  if (hasHotProduct || input.scaleBand === "small") {
    reasons.push(hasHotProduct ? "覆盖固定重点商品，继续观察" : "小店采集成本低");
    return { tier: "watch_1h", reasons };
  }

  reasons.push(input.changeBand === "unknown" ? "缺少变化密度样本" : "低变化");
  reasons.push(strongLowPrice ? "低价强但非重点商品，暂低频观察" : "低价优势弱");
  return { tier: "low_3h", reasons };
}

function isDailyProbeFailure(lastError, consecutiveFailures) {
  return legacyFailureObservationInterval(lastError, consecutiveFailures) === DAILY_PROBE_INTERVAL_MINUTES;
}

function isWeeklyProbeFailure(lastError, consecutiveFailures) {
  return legacyFailureObservationInterval(lastError, consecutiveFailures) === WEEKLY_PROBE_INTERVAL_MINUTES;
}

function shopCollectionScheduleReferenceAt(target, latestRun, tier) {
  const latestRunAt = latestRun ? shopCollectionCrawlRunObservedAt(latestRun) : null;
  if (tier === "retry_priority" || tier === "retry_cooldown" || tier.startsWith("out_of_stock_watch_") || tier === "daily_probe" || tier === "weekly_probe") {
    return target.lastCheckedAt || latestRunAt || target.lastSuccessAt || null;
  }
  return latestRunAt || target.lastSuccessAt || target.lastCheckedAt || null;
}

function shopCollectionSchedulerOptionsFor(options = {}) {
  const rawBucketMinutes =
    optionValue(options, "shopSchedulerBucketMinutes", "shop-scheduler-bucket-minutes") ||
    runtimeEnvValue("PRICEAI_SHOP_SCHEDULER_BUCKET_MINUTES") ||
    runtimeEnvValue("PRICEAI_SHOP_COLLECTION_SCHEDULER_BUCKET_MINUTES") ||
    DEFAULT_SHOP_COLLECTION_SCHEDULER_BUCKET_MINUTES;
  return {
    bucketMinutes: integerInRange(rawBucketMinutes, 5, 180, DEFAULT_SHOP_COLLECTION_SCHEDULER_BUCKET_MINUTES),
  };
}

function shopCollectionSchedulerShardConfig(options = {}) {
  const rawCount =
    optionValue(options, "shopSchedulerShardCount", "shop-scheduler-shard-count") ||
    runtimeEnvValue("PRICEAI_SHOP_SCHEDULER_SHARD_COUNT") ||
    runtimeEnvValue("PRICEAI_SHOP_COLLECTION_SCHEDULER_SHARD_COUNT") ||
    DEFAULT_SHOP_COLLECTION_SCHEDULER_SHARD_COUNT;
  const count = integerInRange(rawCount, 1, 32, DEFAULT_SHOP_COLLECTION_SCHEDULER_SHARD_COUNT);
  const rawIndex =
    optionValue(options, "shopSchedulerShardIndex", "shop-scheduler-shard-index") ||
    runtimeEnvValue("PRICEAI_SHOP_SCHEDULER_SHARD_INDEX") ||
    runtimeEnvValue("PRICEAI_SHOP_COLLECTION_SCHEDULER_SHARD_INDEX") ||
    DEFAULT_SHOP_COLLECTION_SCHEDULER_SHARD_INDEX;
  return {
    count,
    index: integerInRange(rawIndex, 0, count - 1, DEFAULT_SHOP_COLLECTION_SCHEDULER_SHARD_INDEX),
  };
}

function assignShopCollectionSchedulerShard(row, config, persistedAssignments = new Map()) {
  const shardCount = Math.max(1, Number(config?.count || 1));
  const persisted = persistedAssignments.get(row.sourceId);
  const schedulerShardIndex = Number.isInteger(persisted) && persisted >= 0 && persisted < shardCount
    ? persisted
    : stableHashInt("shop-scheduler-shard", row.sourceId || row.sourceName || "") % shardCount;

  return {
    ...row,
    schedulerShardIndex,
    schedulerShardCount: shardCount,
    schedulerShardActiveIndex: Math.max(0, Math.min(Number(config?.index || 0), shardCount - 1)),
    shardMatches: schedulerShardIndex === Math.max(0, Math.min(Number(config?.index || 0), shardCount - 1)),
  };
}

function shopCollectionScheduleTiming({
  sourceId,
  tier,
  intervalMs,
  lastRunMs,
  nowMs,
  bucketMinutes,
  immediate = false,
}) {
  if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) {
    return {
      due: true,
      nextRunAt: null,
      remainingMinutes: 0,
      bucketIndex: 0,
      bucketCount: 1,
      bucketMatches: true,
    };
  }

  const bucketMs = Math.max(5 * 60_000, Math.min(Number(bucketMinutes || DEFAULT_SHOP_COLLECTION_SCHEDULER_BUCKET_MINUTES) * 60_000, intervalMs));
  const bucketCount = immediate ? 1 : Math.max(1, Math.ceil(intervalMs / bucketMs));
  const bucketIndex = bucketCount <= 1
    ? 0
    : stableHashInt("shop-scheduler-bucket", sourceId || "", tier || "") % bucketCount;
  const currentBucketNumber = Math.floor(nowMs / bucketMs);
  const bucketMatches = immediate || bucketCount <= 1 || positiveModulo(currentBucketNumber, bucketCount) === bucketIndex;
  const earliestMs = lastRunMs + intervalMs;
  const ageDue = nowMs >= earliestMs;
  // Once the interval has elapsed, the next scheduler tick must be allowed to
  // run. Requiring the stable bucket as well can miss a window by seconds and
  // defer the source for another full interval (for example, 3h becoming 6h).
  const due = ageDue;
  const nextRunMs = due ? nowMs : earliestMs;

  return {
    due,
    nextRunAt: new Date(nextRunMs).toISOString(),
    remainingMinutes: due ? 0 : Math.max(1, Math.ceil((nextRunMs - nowMs) / 60_000)),
    bucketIndex,
    bucketCount,
    bucketMatches,
  };
}

function buildShopCollectionScheduleTierStats(rows) {
  return SHOP_COLLECTION_TIER_DEFINITIONS.map((definition) => {
    const tierRows = rows.filter((row) => row.tier === definition.tier);
    return {
      tier: definition.tier,
      label: definition.label,
      intervalMinutes: definition.intervalMinutes,
      count: tierRows.length,
      due: tierRows.filter((row) => row.due).length,
      skipped: tierRows.filter((row) => !row.due).length,
      offerCount: tierRows.reduce((total, row) => total + row.offerCount, 0),
    };
  });
}

function limitShopCollectionDueRowsByFamily(rows, options = {}) {
  if (!shouldUseCollectionFamilyProtection(options)) return { dueRows: rows, deferredRows: [] };

  const limit = liandongShopBulkLimitFor(options);
  if (limit <= 0) return { dueRows: rows, deferredRows: [] };

  const counts = new Map();
  const dueRows = [];
  const deferredRows = [];
  for (const row of rows) {
    const family = collectionFamilyForTarget(row.target);
    if (!family) {
      dueRows.push(row);
      continue;
    }

    const count = counts.get(family.key) || 0;
    if (count >= limit) {
      deferredRows.push({
        ...row,
        due: false,
        deferredReason: `${family.label} 本轮已达到 ${limit} 个店铺预算`,
      });
      continue;
    }

    counts.set(family.key, count + 1);
    dueRows.push(row);
  }

  return { dueRows, deferredRows };
}

function compactShopCollectionScheduleRow(row) {
  return {
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    tier: row.tier,
    intervalMinutes: row.intervalMinutes,
    due: row.due,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    remainingMinutes: row.remainingMinutes,
    schedulerShard: row.schedulerShardCount > 1 ? `${row.schedulerShardIndex + 1}/${row.schedulerShardCount}` : null,
    schedulerBucket: row.schedulerBucketCount > 1 ? `${row.schedulerBucketIndex + 1}/${row.schedulerBucketCount}` : null,
    offerCount: row.offerCount,
    changeBand: row.changeBand,
    lowPriceBand: row.lowPriceBand,
    deferredReason: row.deferredReason || null,
    reasons: row.reasons.slice(0, 3),
  };
}

function compareShopCollectionScheduleRows(left, right) {
  if (left.due !== right.due) return left.due ? -1 : 1;
  if (left.tierRank !== right.tierRank) return left.tierRank - right.tierRank;
  const leftLast = timestampMs(left.lastRunAt);
  const rightLast = timestampMs(right.lastRunAt);
  if (Number.isFinite(leftLast) && Number.isFinite(rightLast) && leftLast !== rightLast) return leftLast - rightLast;
  if (!Number.isFinite(leftLast) && Number.isFinite(rightLast)) return -1;
  if (Number.isFinite(leftLast) && !Number.isFinite(rightLast)) return 1;
  return String(left.sourceName || left.sourceId).localeCompare(String(right.sourceName || right.sourceId), "zh-CN");
}

function shopCollectionTierDefinition(tier) {
  return SHOP_COLLECTION_TIER_DEFINITIONS.find((definition) => definition.tier === tier) ||
    SHOP_COLLECTION_TIER_DEFINITIONS[1];
}

function shopCollectionTierRank(tier) {
  const index = SHOP_COLLECTION_TIER_DEFINITIONS.findIndex((definition) => definition.tier === tier);
  return index >= 0 ? index : SHOP_COLLECTION_TIER_DEFINITIONS.length;
}

function shopCollectionScaleBand(offerCount) {
  if (offerCount <= 0) return "empty";
  if (offerCount <= 10) return "small";
  if (offerCount <= 30) return "medium";
  if (offerCount <= 80) return "large";
  return "huge";
}

function shopCollectionChangeBand(input) {
  if (input.receivedCount === null || input.writtenCount === null || input.changeDensity === null) return "unknown";
  if (input.receivedCount === 0 || input.writtenCount === 0) return "low";
  if (input.writtenCount >= 8 || input.changeDensity >= 0.25) return "high";
  if (input.writtenCount >= 2 || input.changeDensity >= 0.08) return "medium";
  return "low";
}

function shopCollectionLowPriceBand(stats) {
  if (!stats || stats.benchmarkOfferCount <= 0) return "unknown";
  if (stats.lowestHitCount > 0 || stats.within10PctCount >= 3) return "strong";
  if (stats.top5HitCount > 0) return "top5";
  if (stats.within10PctCount > 0 || stats.within20PctCount > 0) return "competitive";
  return "weak";
}

function shopHotProductEvidenceFromPriceStats(stats) {
  const evidence = { offerCount: 0, lowestHitCount: 0, top5HitCount: 0 };
  for (const scope of stats?.sampleScopes || []) {
    if (!HOT_SHOP_COLLECTION_PRODUCT_IDS.has(scope.productId)) continue;
    evidence.offerCount += 1;
    if (scope.rank === 1) evidence.lowestHitCount += 1;
    if (scope.rank !== null && scope.rank !== undefined && scope.rank <= 5) evidence.top5HitCount += 1;
  }
  return evidence;
}

function shopCollectionCrawlWriteStats(run) {
  const details = asPlainRecord(run?.details);
  const writeStats = asPlainRecord(details?.writeStats);
  return {
    receivedCount:
      numberFromRecord(writeStats, "receivedCount") ??
      numberFromRecord(details, "receivedCount") ??
      numberFromRecord(details, "offerCount") ??
      null,
    writtenCount:
      numberFromRecord(writeStats, "writtenCount") ??
      numberFromRecord(details, "writtenCount") ??
      numberFromRecord(details, "changedCount") ??
      null,
    refreshedCount:
      numberFromRecord(writeStats, "refreshedCount") ??
      numberFromRecord(details, "refreshedCount") ??
      null,
  };
}

function numberFromRecord(record, key) {
  if (!record) return null;
  const value = Number(record[key]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sourceQualityRuntimeIssueLabel(message) {
  if (!message || /no offers|found no offers|无商品|空结果|empty result/i.test(message)) return null;
  const text = String(message).toLowerCase();
  if (/verification|challenge|captcha|验证码|风控|waf|http 403|status 403|\b403\b|forbidden|access denied|acw_tc|cdn_sec_tc|安全|拦截/.test(text)) {
    return "风控 / 验证 / 403";
  }
  if (/timeout|timed out|fetch failed|network|econn|socket|http 5\d{2}|status 5\d{2}|\b50[234]\b|cancelled|canceled|request was cancelled/.test(text)) {
    return "网络 / 源站失败";
  }
  return null;
}

function emptyCollectionFailureMessage(target, details) {
  if (target.kind !== "shopApi" || details?.fullSnapshot !== true) return "采集结果为空。";

  const reportedGoodsCount = numberOrNull(details.reportedGoodsCount);
  const fetchedItemCount = numberOrNull(details.fetchedItemCount);
  if ((reportedGoodsCount === null || reportedGoodsCount === 0) && (fetchedItemCount === null || fetchedItemCount === 0)) {
    const countLabel = reportedGoodsCount === 0 ? "goods_count=0" : "fetched_item_count=0";
    return `店铺接口正常，完整商品快照为空（${countLabel}）。`;
  }

  return "采集结果为空。";
}

function shopCollectionPriceSampleScopes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asPlainRecord(item);
      if (!record) return null;
      return {
        productId: String(record.productId || ""),
        productName: String(record.productName || ""),
        scopeKey: String(record.scopeKey || ""),
        scopeLabel: String(record.scopeLabel || ""),
        offerTitle: String(record.offerTitle || ""),
        price: numberOrNull(record.price),
        minPrice: numberOrNull(record.minPrice),
        top5Price: numberOrNull(record.top5Price),
        rank: integerOrNull(record.rank),
        gapToMin: numberOrNull(record.gapToMin),
        gapToTop5: numberOrNull(record.gapToTop5),
      };
    })
    .filter((item) => item && item.productId && item.scopeKey);
}

function shopCollectionCrawlRunObservedAt(run) {
  return run?.finishedAt || run?.startedAt || "";
}

function timestampMs(value) {
  if (!value) return NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function asPlainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function optionList(value) {
  if (Array.isArray(value)) return value.flatMap(optionList);
  if (value === true || value === false || value === null || value === undefined) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function cooldownSkipReason(target, options = {}) {
  if (!shouldUseCollectionCooldown(options)) return null;

  const outOfStockSchedule = outOfStockObservationSchedule(target);
  const observationIntervalMinutes = outOfStockSchedule?.intervalMinutes ?? (isDailyProbeFailure(target.lastError, target.consecutiveFailures)
    ? DAILY_PROBE_INTERVAL_MINUTES
    : isWeeklyProbeFailure(target.lastError, target.consecutiveFailures)
      ? WEEKLY_PROBE_INTERVAL_MINUTES
      : null);
  if (observationIntervalMinutes && target.lastCheckedAt) {
    const lastCheckedMs = new Date(target.lastCheckedAt).getTime();
    const ageMs = Date.now() - lastCheckedMs;
    const observationMs = observationIntervalMinutes * 60_000;
    if (Number.isFinite(lastCheckedMs) && ageMs >= 0 && ageMs < observationMs) {
      const remainingMinutes = Math.max(1, Math.ceil((observationMs - ageMs) / 60_000));
      const label = outOfStockSchedule
        ? outOfStockSchedule.reason
        : observationIntervalMinutes === DAILY_PROBE_INTERVAL_MINUTES
          ? "连续失败已记录，进入每日复检"
          : "连续失败已记录，进入每周复检";
      return { message: `${label}；约 ${remainingMinutes} 分钟后重试。` };
    }
  }

  const lastSuccessMs = target.lastSuccessAt ? new Date(target.lastSuccessAt).getTime() : NaN;
  if (!Number.isFinite(lastSuccessMs)) return null;

  const scheduledIntervalMinutes = Number(target.collectionSchedule?.intervalMinutes);
  const cooldownMinutes = Number.isFinite(scheduledIntervalMinutes) && scheduledIntervalMinutes > 0
    ? Math.min(cooldownMinutesFor(options), Math.trunc(scheduledIntervalMinutes))
    : cooldownMinutesFor(options);
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const ageMs = Date.now() - lastSuccessMs;
  if (ageMs < 0 || ageMs >= cooldownMs) return null;

  const remainingMinutes = Math.max(1, Math.ceil((cooldownMs - ageMs) / 60_000));
  return {
    message: `最近 ${cooldownMinutes} 分钟内已成功采集，跳过本轮；约 ${remainingMinutes} 分钟后可再次自动采集。`,
  };
}

function shouldUseCollectionCooldown(options = {}) {
  if (truthyFlag(options.force) || truthyFlag(options["no-cooldown"])) return false;
  if (options.source || options.id || options.name) return false;
  return truthyFlag(options.all) || !options.source;
}

function cooldownMinutesFor(options = {}) {
  const raw =
    options.cooldownMinutes ||
    options["cooldown-minutes"] ||
    process.env.PRICEAI_COLLECTOR_COOLDOWN_MINUTES ||
    env.PRICEAI_COLLECTOR_COOLDOWN_MINUTES ||
    DEFAULT_COOLDOWN_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_COOLDOWN_MINUTES;
  return Math.max(1, Math.min(Math.trunc(value), 24 * 60));
}

export function createCollectionFamilyState(options = {}) {
  return {
    enabled: shouldUseCollectionFamilyProtection(options),
    records: new Map(),
    limit: liandongShopBulkLimitFor(options),
    delayMs: liandongShopBulkDelayMsFor(options),
    breakerMs: liandongShopBreakerMsFor(options),
    http403CooldownMs: liandongShopHttp403CooldownMsFor(options),
    http403Threshold: liandongShopHttp403ThresholdFor(options),
    pauseOnExitErrors: shopApiExitErrorFamilyPauseEnabledFor(options),
  };
}

function shouldUseCollectionFamilyProtection(options = {}) {
  if (truthyFlag(options["no-family-protection"]) || truthyFlag(options.noFamilyProtection)) return false;
  if (truthyFlag(options["family-protection"]) || truthyFlag(options.familyProtection)) return true;
  if (options.source || options.id || options.name) return false;
  return truthyFlag(options.all) || !options.source;
}

function collectionFamilySkipReason(target, state) {
  const family = state.enabled ? collectionFamilyForTarget(target) : null;
  if (!family) return null;

  const record = collectionFamilyRecord(state, family);
  const now = Date.now();
  if (record.breakerUntil && record.breakerUntil > now) {
    return {
      message: `${family.label} 已触发风控熔断；约 ${Math.ceil((record.breakerUntil - now) / 60_000)} 分钟后再试。`,
    };
  }

  if (record.http403CooldownUntil && record.http403CooldownUntil > now) {
    return {
      message: `${family.label} 近期频繁 HTTP 403，进入短冷却；约 ${Math.ceil((record.http403CooldownUntil - now) / 60_000)} 分钟后再试。`,
    };
  }

  if (state.limit > 0 && record.startedCount >= state.limit) {
    return {
      message: `${family.label} 本轮已达到 ${state.limit} 个店铺上限，剩余店铺留到下一轮低频采集。`,
    };
  }

  return null;
}

async function waitForCollectionFamily(target, state, logger) {
  const family = state.enabled ? collectionFamilyForTarget(target) : null;
  if (!family || state.delayMs <= 0) return;

  const record = collectionFamilyRecord(state, family);
  const elapsedMs = record.lastStartedAt ? Date.now() - record.lastStartedAt : state.delayMs;
  const waitMs = state.delayMs - elapsedMs;
  if (waitMs <= 0) return;

  logger?.log(`Waiting ${Math.ceil(waitMs / 1000)}s before next ${family.label} request...`);
  await delay(waitMs);
}

function markCollectionFamilyStarted(target, state) {
  const family = state.enabled ? collectionFamilyForTarget(target) : null;
  if (!family) return;

  const record = collectionFamilyRecord(state, family);
  record.startedCount++;
  record.lastStartedAt = Date.now();
}

function recordCollectionFamilyResult(target, state, result = {}) {
  const family = state.enabled ? collectionFamilyForTarget(target) : null;
  if (!family) return;

  const record = collectionFamilyRecord(state, family);
  record.lastStatus = result.status || null;
  record.lastMessage = result.message || null;

  if (result.status === "success") {
    record.consecutiveHttp403Count = 0;
  }

  const http403Count = http403CountForResult(result);
  if (http403Count > 0) {
    if (!state.pauseOnExitErrors) {
      result.logger?.log?.(`${family.label} returned HTTP 403/520; keeping the family running and rotating the exit on retry.`);
      return;
    }

    record.consecutiveHttp403Count += http403Count;
    if (record.consecutiveHttp403Count >= state.http403Threshold) {
      record.http403CooldownUntil = Date.now() + state.http403CooldownMs;
      record.consecutiveHttp403Count = 0;
      result.logger?.log(
        `${family.label} returned frequent HTTP 403/520; cooling this family for ${Math.ceil(state.http403CooldownMs / 60_000)} minutes.`,
      );
    }
    return;
  }

  if (!isChallengeMessage(result.message)) return;

  if (!state.pauseOnExitErrors) {
    result.logger?.log?.(`${family.label} returned a verification/challenge page; keeping the family running and relying on exit rotation.`);
    return;
  }

  record.breakerUntil = Date.now() + state.breakerMs;
  result.logger?.log(
    `${family.label} returned a verification/challenge page; pausing this family for ${Math.ceil(state.breakerMs / 60_000)} minutes.`,
  );
}

function collectionFamilyRunPauseReason(target, state) {
  const family = state.enabled ? collectionFamilyForTarget(target) : null;
  if (!family) return null;

  const record = collectionFamilyRecord(state, family);
  const now = Date.now();
  if (record.breakerUntil && record.breakerUntil > now) {
    return {
      label: family.label,
      message: `已触发风控熔断，本轮停止继续请求；约 ${Math.ceil((record.breakerUntil - now) / 60_000)} 分钟后再试。`,
    };
  }

  if (record.http403CooldownUntil && record.http403CooldownUntil > now) {
    return {
      label: family.label,
      message: `连续多个店铺返回 HTTP 403/520，本轮停止继续请求；约 ${Math.ceil((record.http403CooldownUntil - now) / 60_000)} 分钟后再试。`,
    };
  }

  if (state.limit > 0 && record.startedCount >= state.limit) {
    return {
      label: family.label,
      message: `本轮已达到 ${state.limit} 个店铺上限，剩余店铺留到下一轮分层采集。`,
    };
  }

  return null;
}

function collectionFamilyRecord(state, family) {
  const existing = state.records.get(family.key);
  if (existing) return existing;

  const record = {
    startedCount: 0,
    lastStartedAt: 0,
    breakerUntil: 0,
    http403CooldownUntil: 0,
    consecutiveHttp403Count: 0,
    lastStatus: null,
    lastMessage: null,
  };
  state.records.set(family.key, record);
  return record;
}

function collectionFamilyForTarget(target) {
  if (target.kind !== "shopApi") return null;

  const host = normalizeHostname(target.baseUrl || target.sourceUrl);
  if (!["www.ldxp.cn", "pay.ldxp.cn", "ldxp.cn", "pay.qxvx.cn", "catfk.com"].includes(host)) return null;

  return {
    key: `shopApi:${host}`,
    label: `${host} shopApi`,
  };
}

function targetFamilyAliases(target) {
  const aliases = new Set();
  const family = collectionFamilyForTarget(target);
  const host = normalizeHostname(target.baseUrl || target.sourceUrl);

  if (family) {
    aliases.add("liandong-shop");
    aliases.add(family.key.toLowerCase());
  }
  if (host) aliases.add(host);

  if (["www.ldxp.cn", "pay.ldxp.cn", "ldxp.cn"].includes(host)) {
    aliases.add("ldxp");
  } else if (host === "pay.qxvx.cn") {
    aliases.add("qxvx");
  } else if (host === "catfk.com") {
    aliases.add("catfk");
    aliases.add("yunmao");
    aliases.add("yunmao-consignment");
  }

  return aliases;
}

function liandongShopBulkLimitFor(options = {}) {
  const raw =
    options.liandongShopLimit ||
    options["liandong-shop-limit"] ||
    process.env.PRICEAI_LIANDONG_SHOP_BULK_LIMIT ||
    env.PRICEAI_LIANDONG_SHOP_BULK_LIMIT ||
    DEFAULT_LIANDONG_SHOP_BULK_LIMIT;
  return integerInRange(raw, 0, 500, DEFAULT_LIANDONG_SHOP_BULK_LIMIT);
}

function liandongShopBulkDelayMsFor(options = {}) {
  const raw =
    options.liandongShopDelayMs ||
    options["liandong-shop-delay-ms"] ||
    process.env.PRICEAI_LIANDONG_SHOP_BULK_DELAY_MS ||
    env.PRICEAI_LIANDONG_SHOP_BULK_DELAY_MS ||
    DEFAULT_LIANDONG_SHOP_BULK_DELAY_MS;
  return integerInRange(raw, 0, 10 * 60 * 1000, DEFAULT_LIANDONG_SHOP_BULK_DELAY_MS);
}

function liandongShopBreakerMsFor(options = {}) {
  const raw =
    options.liandongShopBreakerMinutes ||
    options["liandong-shop-breaker-minutes"] ||
    process.env.PRICEAI_LIANDONG_SHOP_BREAKER_MINUTES ||
    env.PRICEAI_LIANDONG_SHOP_BREAKER_MINUTES ||
    DEFAULT_LIANDONG_SHOP_BREAKER_MINUTES;
  return integerInRange(raw, 1, 24 * 60, DEFAULT_LIANDONG_SHOP_BREAKER_MINUTES) * 60 * 1000;
}

function liandongShopHttp403CooldownMsFor(options = {}) {
  const raw =
    options.liandongShopHttp403CooldownMinutes ||
    options["liandong-shop-403-cooldown-minutes"] ||
    process.env.PRICEAI_LIANDONG_SHOP_403_COOLDOWN_MINUTES ||
    env.PRICEAI_LIANDONG_SHOP_403_COOLDOWN_MINUTES ||
    DEFAULT_LIANDONG_SHOP_HTTP_403_COOLDOWN_MINUTES;
  return integerInRange(raw, 1, 60, DEFAULT_LIANDONG_SHOP_HTTP_403_COOLDOWN_MINUTES) * 60 * 1000;
}

function liandongShopHttp403ThresholdFor(options = {}) {
  const raw =
    options.liandongShopHttp403Threshold ||
    options["liandong-shop-403-threshold"] ||
    process.env.PRICEAI_LIANDONG_SHOP_403_THRESHOLD ||
    env.PRICEAI_LIANDONG_SHOP_403_THRESHOLD ||
    DEFAULT_LIANDONG_SHOP_HTTP_403_THRESHOLD;
  return integerInRange(raw, 1, 10, DEFAULT_LIANDONG_SHOP_HTTP_403_THRESHOLD);
}

function shopApiExitErrorFamilyPauseEnabledFor(options = {}) {
  const value =
    optionValue(options, "shopApiExitErrorFamilyPause", "shop-api-exit-error-family-pause") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_EXIT_ERROR_FAMILY_PAUSE");
  if (truthyFlag(value)) return true;
  if (falseyFlag(value)) return false;
  return DEFAULT_SHOP_API_EXIT_ERROR_FAMILY_PAUSE;
}

function http403CountForResult(result = {}) {
  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  if (attempts.some((attempt) => isHttp403Message(attempt?.message))) return 1;
  return isHttp403Message(result.message) ? 1 : 0;
}

function isHttp403Message(message) {
  return /HTTP\s*(?:403|520)|status\s*(?:403|520)|returned HTTP (?:403|520)|denied by (?:ip_access_rule|http_ratelimit)|ip_access_rule|http_ratelimit|forbidden/i.test(String(message || ""));
}

function isShopApiExitErrorMessage(message) {
  return /HTTP\s*(?:403|520)|status\s*(?:403|520)|denied by (?:ip_access_rule|http_ratelimit)|ip_access_rule|http_ratelimit|proxy-status:\s*esa|response_incomplete|challenge|captcha|验证码|风控|acw_tc|cdn_sec_tc/i.test(String(message || ""));
}

function isShopApiProxyTransportErrorMessage(message) {
  return /UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET)|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|socket hang up|other side closed|proxy connection/i.test(
    String(message || ""),
  );
}

function shouldStopRetryingTarget(target, error) {
  if (!collectionFamilyForTarget(target)) return false;
  if (isShopApiExitErrorMessage(errorMessage(error))) return false;
  return false;
}

function isChallengeMessage(message) {
  return /验证|风控|challenge|captcha|本机浏览器采集|verification/i.test(String(message || ""));
}

function integerInRange(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.trunc(number), max));
}

function truthyFlag(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function falseyFlag(value) {
  return value === false || value === "false" || value === "0" || value === "no" || value === "off";
}

function collectionLockOwner(options = {}) {
  const node = collectorNodeDetails(options);
  return `${node.id || "unknown-node"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

async function acquireCollectionLock(target, owner, options = {}) {
  if (truthyFlag(options["no-lock"])) return { acquired: true };
  if (target.builtinFallback) return { acquired: true };

  const supabase = getSupabaseClient();
  if (!supabase) return { acquired: true };

  const { data, error } = await supabase.rpc("acquire_source_collection_lock", {
    p_source_id: target.sourceId,
    p_owner: owner,
    p_lock_seconds: lockSecondsFor(options),
  });

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (row?.acquired) return { acquired: true };

  const lockOwner = row?.lock_owner ? String(row.lock_owner) : "其他节点";
  const lockUntil = row?.lock_until ? String(row.lock_until) : null;
  return {
    acquired: false,
    message: lockUntil
      ? `已有采集节点 ${lockOwner} 正在处理，锁定到 ${lockUntil}。`
      : `已有采集节点 ${lockOwner} 正在处理。`,
  };
}

async function releaseCollectionLock(target, owner, logger) {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { error } = await supabase.rpc("release_source_collection_lock", {
    p_source_id: target.sourceId,
    p_owner: owner,
  });
  if (error) logger?.error(`Failed to release lock: ${errorMessage(error)}`);
}

function lockSecondsFor(options = {}) {
  const value = Number(options.lockSeconds || options["lock-seconds"] || DEFAULT_LOCK_SECONDS);
  if (!Number.isFinite(value)) return DEFAULT_LOCK_SECONDS;
  return Math.max(60, Math.min(Math.trunc(value), 3600));
}

function inferCollectorKind(host, text = "") {
  for (const entry of collectorRegistry.kinds) {
    if (collectorHostsForKind(entry.kind).has(host)) return entry.kind;
  }
  if (text.includes("burstpro")) return "dujiao";
  return null;
}

function normalizeCollectorKind(value) {
  const text = String(value || "").trim();
  return collectorKindValues().includes(text)
    ? text
    : null;
}

function collectorHostsForKind(kind) {
  return new Set(
    (collectorRegistry.kinds.find((entry) => entry.kind === kind)?.hosts || [])
      .map((host) => normalizeHostname(host)),
  );
}

function collectorKindValues() {
  return [
    "auto",
    ...collectorRegistry.kinds.map((entry) => entry.kind),
    "browser",
    "unsupported",
  ];
}

function publicProductUrl(target, product) {
  const id = product.id || product.slug || product.key;
  if (!id) return target.sourceUrl;
  if (normalizeHostname(target.baseUrl) === "catcard.uk") return `${target.baseUrl}/#product-${encodeURIComponent(String(id))}`;
  return `${target.baseUrl}/#${encodeURIComponent(String(id))}`;
}

function maxAttemptsFor(options = {}) {
  const value = Number(options.retries || options.retry || 3);
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(Math.trunc(value), 5));
}

function concurrencyFor(options = {}) {
  const value = Number(
    options.concurrency ||
      options["concurrency"] ||
      process.env.PRICEAI_COLLECT_CONCURRENCY ||
      env.PRICEAI_COLLECT_CONCURRENCY ||
      DEFAULT_CONCURRENCY,
  );
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(Math.trunc(value), 8));
}

function retryDelayMs(attempt) {
  return Math.min(1_000 * 2 ** (attempt - 1), 5_000);
}

function pageDelayMsFor(options = {}) {
  const value = Number(
    options.pageDelayMs ||
      options["page-delay-ms"] ||
      process.env.PRICEAI_COLLECT_PAGE_DELAY_MS ||
      env.PRICEAI_COLLECT_PAGE_DELAY_MS ||
      DEFAULT_PAGE_DELAY_MS,
  );
  if (!Number.isFinite(value)) return DEFAULT_PAGE_DELAY_MS;
  return Math.max(0, Math.min(Math.trunc(value), 5_000));
}

async function waitBetweenPages(options = {}) {
  const delayMs = pageDelayMsFor(options);
  if (delayMs > 0) await delay(delayMs);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printTargetList(targets) {
  console.table(
    targets.map((target) => ({
      id: target.sourceId,
      name: target.sourceName,
      kind: target.kind || "unsupported",
      configured: target.configuredKind || "auto",
      url: target.sourceUrl,
      seedItems: target.rawOffers.length,
    })),
  );
}

function printOfferPreview(offers) {
  console.table(
    offers.slice(0, 8).map((offer) => ({
      title: offer.sourceTitle.slice(0, 42),
      price: offer.price,
      status: offer.status,
      stock: offer.stockCount,
      minOrder: offer.minOrderQuantity,
      bulkTiers: offer.bulkPricingTiers?.length || 0,
      store: offer.sourceStoreName,
    })),
  );
  if (offers.length > 8) console.log(`... ${offers.length - 8} more`);
}

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY. collect-prices requires the service role key for Supabase reads and writes.");
  }
  if (!url && key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL. collect-prices cannot use SUPABASE_SERVICE_ROLE_KEY without the Supabase URL.");
  }
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

async function fetchJson(url) {
  const response = await safeFetch(url, {
    headers: defaultHeaders(url),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return parseJsonResponse(response, url);
}

async function fetchText(url) {
  const response = await safeFetch(url, {
    headers: defaultHeaders(url),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function postJson(url, body, referer, requestOptions = null) {
  const requestReferer = normalizeHttpHeaderUrl(referer || url);
  let response;
  try {
    response = await safeFetch(url, {
      method: "POST",
      headers: {
        ...defaultHeaders(requestReferer),
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        visitorid: createShopApiVisitorId(),
        referer: requestReferer,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      ...requestOptions,
    });
  } catch (error) {
    throw new Error(`${url} 请求失败：${errorMessage(error)}`, { cause: error });
  }

  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return parseJsonResponse(response, url);
}

function normalizeHttpHeaderUrl(value) {
  try {
    return new URL(String(value || "")).toString();
  } catch {
    return encodeURI(String(value || ""));
  }
}

async function parseJsonResponse(response, url) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    if (/<html|<script|captcha|verify|challenge|验证|风控|安全/i.test(text)) {
      throw new Error(`${url} 返回验证或风控页面，需要改用本机浏览器采集。`);
    }
    throw new Error(`${url} 返回了非 JSON 内容，暂时无法自动采集。`);
  }
}

function defaultHeaders(url) {
  return {
    accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
    referer: deriveBaseUrl(url) || url,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
}

function createShopApiVisitorId() {
  return crypto.randomBytes(12).toString("hex");
}

async function createShopApiProxyContext(target, options = {}) {
  if (truthyFlag(options.shopApiProxyDisabled)) return null;

  const hosts = shopApiProxyHostsFor(options);
  const host = normalizeHostname(target.baseUrl || target.sourceUrl);
  if (!hosts.has(host)) return null;
  const poolKey = shopApiProxyPoolKeyForTarget(target, options);

  const sharedProxyContext = await shopApiProxyContextFromReusePool(poolKey, options);
  if (sharedProxyContext) return sharedProxyContext;

  const proxyLease = await resolveShopApiProxyUrl(options);
  if (!proxyLease) return null;

  return {
    ...proxyLease,
    dispatcher: new ProxyAgent(proxyLease.proxyUrl),
  };
}

function createShopApiProxyReusePool(options = {}) {
  return {
    enabled: true,
    limit: shopApiProxyReuseLimitFor(options),
    ttlMs: shopApiProxyReuseTtlMsFor(options),
    statePath: String(optionValue(options, "shopApiProxyStatePath", "shop-api-proxy-state-path") || "").trim() || null,
    maxRuns: integerInRange(
      optionValue(options, "shopApiProxyMaxRuns", "shop-api-proxy-max-runs"),
      1,
      10,
      DEFAULT_SHOP_API_PROXY_MAX_RUNS,
    ),
    logger: options.shopApiProxyLogger || null,
    entries: new Map(),
    blockedDirectExits: new Set(),
    rotationStates: new Map(),
    nextAcquireReasons: new Map(),
  };
}

async function restoreShopApiProxyReusePool(pool) {
  if (!pool?.enabled || !pool.statePath || !existsSync(pool.statePath)) return 0;

  let stored;
  try {
    stored = JSON.parse(readFileSync(pool.statePath, "utf8"));
  } catch {
    removeShopApiProxyReuseState(pool);
    pool.logger?.log("Shop API proxy lease state was invalid and has been cleared.");
    return 0;
  }

  const now = Date.now();
  let restoredCount = 0;
  for (const [poolKey, lease] of Object.entries(stored?.version === 1 && stored?.leases ? stored.leases : {})) {
    const proxyUrl = String(lease?.proxyUrl || "").trim();
    const expiresAt = Number(lease?.expiresAt || 0);
    const usedRuns = Math.max(1, Math.trunc(Number(lease?.usedRuns) || 1));
    if (
      !poolKey ||
      !proxyUrl ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now + SHOP_API_PROXY_EXPIRY_SAFETY_MS ||
      usedRuns >= pool.maxRuns
    ) {
      continue;
    }

    const nextUsedRuns = usedRuns + 1;
    pool.entries.set(poolKey, {
      context: {
        proxyUrl,
        dispatcher: new ProxyAgent(proxyUrl),
      },
      expiresAt,
      remaining: pool.limit > 0 ? pool.limit : null,
      usedRuns: nextUsedRuns,
    });
    restoredCount += 1;
    pool.logger?.log(
      `Shop API proxy lease restored for ${poolKey}; run ${nextUsedRuns}/${pool.maxRuns}; expires at ${new Date(expiresAt).toISOString()}.`,
    );
  }

  persistShopApiProxyReusePool(pool);
  return restoredCount;
}

function isShopApiDirectExitBlockedForTarget(target, options = {}) {
  const blocked = options.shopApiProxyReusePool?.blockedDirectExits;
  return blocked instanceof Set && blocked.has(shopApiDirectExitKeyForTarget(target));
}

function blockShopApiDirectExitForTarget(target, options = {}) {
  const blocked = options.shopApiProxyReusePool?.blockedDirectExits;
  if (blocked instanceof Set) blocked.add(shopApiDirectExitKeyForTarget(target));
}

function shopApiDirectExitKeyForTarget(target) {
  return normalizeHostname(target.baseUrl || target.sourceUrl) || String(target.sourceId || "unknown");
}

async function shopApiProxyContextFromReusePool(poolKey, options = {}) {
  const pool = options.shopApiProxyReusePool;
  if (!pool?.enabled) return null;

  const now = Date.now();
  const logger = options.shopApiProxyLogger;
  const rotationState = shopApiProxyRotationState(pool, poolKey, now);
  if (rotationState.cooldownUntil > now) {
    const remainingSeconds = Math.max(1, Math.ceil((rotationState.cooldownUntil - now) / 1000));
    throw new Error(`Shop API proxy rotation cooling down for ${remainingSeconds}s after repeated exit failures.`);
  }

  const existing = pool.entries.get(poolKey);
  if (
    existing &&
    (existing.remaining === null || existing.remaining > 0) &&
    existing.expiresAt > now + SHOP_API_PROXY_EXPIRY_SAFETY_MS
  ) {
    if (existing.remaining !== null) existing.remaining -= 1;
    logger?.log(`Shop API proxy lease reused for ${poolKey}; expires at ${new Date(existing.expiresAt).toISOString()}.`);
    return {
      ...existing.context,
      shared: true,
    };
  }

  if (existing) {
    await closeShopApiProxyReuseEntry(existing);
    pool.entries.delete(poolKey);
    pool.nextAcquireReasons.set(poolKey, "lease-expired");
    persistShopApiProxyReusePool(pool);
  }

  const proxyLease = await resolveShopApiProxyUrl(options);
  if (!proxyLease) return null;
  const limit = pool.limit > 0 ? pool.limit : null;

  const entry = {
    context: {
      ...proxyLease,
      dispatcher: new ProxyAgent(proxyLease.proxyUrl),
    },
    expiresAt: proxyLease.expiresAt || now + pool.ttlMs,
    remaining: limit === null ? null : limit - 1,
    usedRuns: 1,
  };
  pool.entries.set(poolKey, entry);
  persistShopApiProxyReusePool(pool);
  const acquireReason = pool.nextAcquireReasons.get(poolKey) || "initial";
  pool.nextAcquireReasons.delete(poolKey);
  logger?.log(`Shop API proxy lease acquired for ${poolKey}; reason=${acquireReason}; expires at ${new Date(entry.expiresAt).toISOString()}.`);

  return {
    ...entry.context,
    shared: true,
  };
}

async function discardShopApiProxyReuseForTarget(target, options = {}, details = {}) {
  const pool = options.shopApiProxyReusePool;
  if (!pool?.enabled) return false;

  const poolKey = shopApiProxyPoolKeyForTarget(target, options);
  const entry = pool.entries.get(poolKey);
  if (!entry) return false;

  const now = Date.now();
  const rotationState = shopApiProxyRotationState(pool, poolKey, now);

  await closeShopApiProxyReuseEntry(entry);
  pool.entries.delete(poolKey);
  persistShopApiProxyReusePool(pool);

  if (rotationState.count >= SHOP_API_PROXY_MAX_ROTATIONS_PER_WINDOW) {
    rotationState.cooldownUntil = rotationState.windowStartedAt + SHOP_API_PROXY_ROTATION_WINDOW_MS;
    const remainingSeconds = Math.max(1, Math.ceil((rotationState.cooldownUntil - now) / 1000));
    details.logger?.log(
      `Shop API proxy rotation budget exhausted for ${poolKey}; cooling down for ${remainingSeconds}s without acquiring another IP.`,
    );
    return false;
  }

  rotationState.count += 1;
  pool.nextAcquireReasons.set(poolKey, details.reason || "exit-failure");
  details.logger?.log(
    `Shop API proxy lease discarded for ${poolKey}; reason=${details.reason || "exit-failure"}; rotation ${rotationState.count}/${SHOP_API_PROXY_MAX_ROTATIONS_PER_WINDOW}.`,
  );
  return true;
}

function shopApiProxyRotationState(pool, poolKey, now = Date.now()) {
  let state = pool.rotationStates.get(poolKey);
  if (!state || now >= state.windowStartedAt + SHOP_API_PROXY_ROTATION_WINDOW_MS) {
    state = {
      windowStartedAt: now,
      count: 0,
      cooldownUntil: 0,
    };
    pool.rotationStates.set(poolKey, state);
  }
  return state;
}

async function closeShopApiProxyReusePool(pool) {
  if (!pool?.entries) return;
  const entries = [...pool.entries.values()];
  pool.entries.clear();
  await Promise.all(entries.map((entry) => closeShopApiProxyReuseEntry(entry)));
}

async function closeShopApiProxyReuseEntry(entry) {
  await entry?.context?.dispatcher?.close?.().catch(() => {});
}

function persistShopApiProxyReusePool(pool) {
  if (!pool?.statePath) return;

  const now = Date.now();
  const leases = {};
  for (const [poolKey, entry] of pool.entries || []) {
    if (!entry?.context?.proxyUrl || entry.expiresAt <= now + SHOP_API_PROXY_EXPIRY_SAFETY_MS) continue;
    leases[poolKey] = {
      proxyUrl: entry.context.proxyUrl,
      expiresAt: entry.expiresAt,
      usedRuns: Math.max(1, Math.trunc(Number(entry.usedRuns) || 1)),
    };
  }

  if (!Object.keys(leases).length) {
    removeShopApiProxyReuseState(pool);
    return;
  }

  const temporaryPath = `${pool.statePath}.${process.pid}.tmp`;
  try {
    const stateDirectory = dirname(pool.statePath);
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, leases })}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, pool.statePath);
    chmodSync(pool.statePath, 0o600);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {}
    pool.logger?.log(`Shop API proxy lease state could not be persisted: ${errorMessage(error)}`);
  }
}

function removeShopApiProxyReuseState(pool) {
  if (!pool?.statePath) return;
  try {
    rmSync(pool.statePath, { force: true });
  } catch (error) {
    pool.logger?.log(`Shop API proxy lease state could not be cleared: ${errorMessage(error)}`);
  }
}

function shopApiProxyReuseLimitFor(options = {}) {
  const raw =
    optionValue(options, "shopApiProxyReuseLimit", "shop-api-proxy-reuse-limit") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_PROXY_REUSE_LIMIT") ||
    DEFAULT_SHOP_API_PROXY_REUSE_LIMIT;
  return integerInRange(raw, 0, 100, DEFAULT_SHOP_API_PROXY_REUSE_LIMIT);
}

function shopApiProxyReuseTtlMsFor(options = {}) {
  const raw =
    optionValue(options, "shopApiProxyReuseTtlMs", "shop-api-proxy-reuse-ttl-ms") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_PROXY_REUSE_TTL_MS") ||
    DEFAULT_SHOP_API_PROXY_REUSE_TTL_MS;
  return integerInRange(raw, 1_000, 10 * 60 * 1000, DEFAULT_SHOP_API_PROXY_REUSE_TTL_MS);
}

function shopApiProxyParallelismFor(options = {}, targetCount = null) {
  const raw =
    optionValue(options, "shopApiProxyParallelism", "shop-api-proxy-parallelism") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_PROXY_PARALLELISM") ||
    DEFAULT_SHOP_API_PROXY_PARALLELISM;
  if (String(raw).trim().toLowerCase() === "auto") {
    const count = Math.max(0, Math.trunc(Number(targetCount) || 0));
    return Math.max(
      1,
      Math.min(SHOP_API_PROXY_AUTO_MAX_LANES, Math.ceil(count / SHOP_API_PROXY_AUTO_TARGETS_PER_LANE)),
    );
  }
  return integerInRange(raw, 1, 8, DEFAULT_SHOP_API_PROXY_PARALLELISM);
}

function shopApiProxyModeFor(options = {}) {
  const value =
    optionValue(options, "shopApiProxyMode", "shop-api-proxy-mode") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_PROXY_MODE") ||
    DEFAULT_SHOP_API_PROXY_MODE;
  const normalized = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (["on_exit", "fallback", "after_exit_error"].includes(normalized)) return "on_exit";
  return "always";
}

function hasShopApiProxyConfigured(options = {}) {
  return Boolean(shopApiProxyApiUrlFor(options) || shopApiProxyUrlFor(options));
}

async function resolveShopApiProxyUrl(options = {}) {
  const proxyApiUrl = shopApiProxyApiUrlFor(options);
  if (proxyApiUrl) return fetchShopApiProxyLease(proxyApiUrl);

  const proxyUrl = shopApiProxyUrlFor(options);
  if (proxyUrl) return { proxyUrl, expiresAt: null };

  return null;
}

function shopApiProxyHostsFor(options = {}) {
  const raw =
    runtimeEnvValue("PRICEAI_SHOPAPI_PROXY_HOSTS") ||
    optionValue(options, "shopApiProxyHosts", "shop-api-proxy-hosts") ||
    DEFAULT_SHOP_API_PROXY_HOSTS.join(",");
  return new Set(
    String(raw)
      .split(",")
      .map((value) => normalizeHostname(value))
      .filter(Boolean),
  );
}

function shopApiProxyApiUrlFor(options = {}) {
  return (
    optionValue(options, "shopApiProxyApiUrl", "shop-api-proxy-api-url") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_PROXY_API_URL")
  );
}

function shopApiProxyUrlFor(options = {}) {
  return optionValue(options, "shopApiProxyUrl", "shop-api-proxy-url") || runtimeEnvValue("PRICEAI_SHOPAPI_PROXY_URL");
}

async function fetchShopApiProxyLease(proxyApiUrl) {
  const requestUrl = proxyApiUrlWithExpiryField(proxyApiUrl);
  const response = await safeFetch(requestUrl, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": defaultHeaders(proxyApiUrl)["user-agent"],
    },
    signal: AbortSignal.timeout(SHOP_API_PROXY_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Proxy API returned HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
  }

  const lease = extractProxyLeaseFromPayload(text);
  if (!lease) {
    throw new Error(`Proxy API response from ${requestUrl} did not contain a usable proxy address.`);
  }

  return {
    ...lease,
    proxyUrl: proxyUrlWithApiAuth(lease.proxyUrl, proxyApiUrl),
  };
}

function proxyApiUrlWithExpiryField(proxyApiUrl) {
  try {
    const url = new URL(proxyApiUrl);
    if (!url.searchParams.has("field")) url.searchParams.set("field", "ipport,expiretime");
    return url.toString();
  } catch {
    return proxyApiUrl;
  }
}

function extractProxyLeaseFromPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  const fromJson = extractProxyLeaseCandidate(parsed);
  if (fromJson) return fromJson;

  const fromText = extractProxyLeaseCandidate(trimmed);
  if (fromText) return fromText;

  return null;
}

function extractProxyLeaseCandidate(value) {
  const proxyUrl = extractProxyUrlCandidate(value);
  if (!proxyUrl) return null;

  return {
    proxyUrl,
    expiresAt: extractProxyExpiry(value),
  };
}

function extractProxyUrlCandidate(value) {
  if (!value) return null;
  if (typeof value === "string") return normalizeProxyUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractProxyUrlCandidate(item);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  if (typeof value.proxyUrl === "string") return normalizeProxyUrl(value.proxyUrl);
  if (typeof value.proxy_url === "string") return normalizeProxyUrl(value.proxy_url);
  if (typeof value.url === "string") return normalizeProxyUrl(value.url);
  if (typeof value.ipport === "string") return normalizeProxyUrl(value.ipport);

  if (typeof value.ip === "string" && value.ip.includes(":")) return normalizeProxyUrl(value.ip);
  if (typeof value.IP === "string" && value.IP.includes(":")) return normalizeProxyUrl(value.IP);

  const data = value.data ?? value.result ?? value.items ?? null;
  const nested = extractProxyUrlCandidate(data);
  if (nested) return nested;

  const ip = value.IP || value.ip || value.host;
  const port = value.Port || value.port;
  if (ip && port) return normalizeProxyUrl(`${ip}:${port}`);

  return null;
}

function extractProxyExpiry(value) {
  if (!value || typeof value !== "object") return null;

  const raw = value.expireTimeMillis ?? value.expire_time_millis ?? value.expireTime ?? value.expire_time;
  if (raw !== undefined && raw !== null && String(raw).trim()) {
    const number = Number(raw);
    if (Number.isFinite(number)) {
      const timestamp = number < 10_000_000_000 ? number * 1000 : number;
      if (timestamp > Date.now()) return timestamp;
    }

    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed) && parsed > Date.now()) return parsed;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const expiry = extractProxyExpiry(item);
      if (expiry) return expiry;
    }
  }

  if (typeof value === "object") {
    const nested = value.data ?? value.result ?? value.items ?? null;
    if (nested) return extractProxyExpiry(nested);
  }

  return null;
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const prefixed = text.includes("://") ? text : `http://${text}`;
  try {
    const url = new URL(prefixed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.port) return null;
    const auth = url.username || url.password ? `${url.username}:${url.password}@` : "";
    return `${url.protocol}//${auth}${url.hostname}:${url.port}`;
  } catch {
    return null;
  }
}

function proxyUrlWithApiAuth(proxyUrl, proxyApiUrl) {
  try {
    const proxy = new URL(proxyUrl);
    if (proxy.username || proxy.password) return proxyUrl;

    const api = new URL(proxyApiUrl);
    const accessName = api.searchParams.get("accessName") || api.searchParams.get("username") || "";
    const accessPassword = api.searchParams.get("accessPassword") || api.searchParams.get("password") || "";
    if (!accessName && !accessPassword) return proxyUrl;

    proxy.username = accessName;
    proxy.password = accessPassword;
    return proxy.toString();
  } catch {
    return proxyUrl;
  }
}

function runtimeEnvValue(name) {
  return String(process.env[name] || env[name] || "").trim();
}

function optionValue(options, camelKey, kebabKey) {
  const camel = options?.[camelKey];
  if (camel !== undefined && camel !== null && String(camel).trim()) return String(camel).trim();
  const kebab = options?.[kebabKey];
  if (kebab !== undefined && kebab !== null && String(kebab).trim()) return String(kebab).trim();
  return "";
}

function shopApiAllGoodsListEnabled(options = {}) {
  const value =
    optionValue(options, "shopApiListMode", "shop-api-list-mode") ||
    optionValue(options, "shopApiGoodsListMode", "shop-api-goods-list-mode") ||
    optionValue(options, "shopApiAllGoodsList", "shop-api-all-goods-list") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_LIST_MODE") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_GOODS_LIST_MODE") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_ALL_GOODS_LIST");

  return ["all", "all_goods", "all-goods", "category_0", "category-0", "true", "1", "yes"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function shopApiPriceSampleSizeFor(options = {}) {
  const raw =
    optionValue(options, "shopApiPriceSampleSize", "shop-api-price-sample-size") ||
    runtimeEnvValue("PRICEAI_SHOPAPI_PRICE_SAMPLE_SIZE") ||
    SHOP_API_DEFAULT_PRICE_SAMPLE_SIZE;
  return integerInRange(raw, 0, 50, SHOP_API_DEFAULT_PRICE_SAMPLE_SIZE);
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function ceilCurrency(value) {
  return Math.ceil((Number(value) - 1e-10) * 100) / 100;
}

function floorCurrency(value) {
  return Math.floor((Number(value) + 1e-10) * 100) / 100;
}

function closeCurrency(left, right, tolerance = SHOP_API_CENT_TOLERANCE) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function statusFromStock(stockCount) {
  if (typeof stockCount === "number") {
    if (stockCount <= 0) return "out_of_stock";
    if (stockCount <= 3) return "low_stock";
    return "in_stock";
  }

  return "in_stock";
}

function localized(value) {
  if (!value) return "";
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "object") {
    return cleanText(value["zh-CN"] || value["zh-TW"] || value["en-US"] || Object.values(value).find(Boolean) || "");
  }

  return cleanText(String(value));
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(quot|amp|lt|gt|apos|#039);/gi, (match) => decodeHtmlEntities(match))
    .replace(/&nbsp;/g, " ")
    .replace(/&#x?[a-f0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/gi, `"`)
    .replace(/&#039;/g, `'`)
    .replace(/&apos;/gi, `'`)
    .replace(/&amp;/gi, "&")
    .replace(/&yen;/gi, "¥")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value) {
  return cleanText(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
}

function isNonComparableTitle(title) {
  return ["Logo", "打赏", "测试", "公告", "请查看上方店铺", "其他（直接联系客服"].some((keyword) =>
    title.includes(keyword),
  );
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numericText = String(value).replace(/[^\d.-]/g, "");
  if (!numericText || numericText === "-" || numericText === "." || numericText === "-.") return null;
  const parsed = Number(numericText);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.trunc(number);
}

function timestampFromShopApiValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const milliseconds = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  return isoDateTimeOrNull(milliseconds);
}

function isoDateTimeOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  const now = Date.now();
  if (!Number.isFinite(date.getTime()) || date.getTime() > now + 86_400_000) return null;
  return date.toISOString();
}

function compact(values) {
  return values
    .map((value) => cleanText(value || ""))
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeOffers(offers) {
  const map = new Map();
  for (const offer of offers) {
    map.set(stableOfferInputId(offer), offer);
  }
  return Array.from(map.values());
}

function normalizeShopApiItemOfferUrl(value) {
  try {
    const parsed = new URL(value);
    const host = normalizeHostname(parsed.hostname);
    if (!["catfk.com", "ldxp.cn", "www.ldxp.cn", "pay.ldxp.cn", "pay.qxvx.cn"].includes(host)) return null;

    const pathGoodsKey = parsed.pathname.match(/^\/item\/([^/?#]+)/i)?.[1] || null;
    const goodsKey = pathGoodsKey || parsed.searchParams.get("commodity") || parsed.searchParams.get("id");
    if (!goodsKey) return null;

    const canonicalHost = [LDXP_WWW_HOST, LDXP_PAY_HOST, "ldxp.cn"].includes(host) ? LDXP_PAY_HOST : host;
    return `https://${canonicalHost}/item/${encodeURIComponent(decodeURIComponent(goodsKey))}`;
  } catch {
    return null;
  }
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function absolutize(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function deriveBaseUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function normalizeHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(value || "").replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").toLowerCase();
  }
}

function sourceNameFromUrl(value) {
  try {
    const url = new URL(value);
    const token = shopTokenFromUrl(value);
    if (url.hostname === "ai666.dnxb.cc") return "T佬的gmail批发渠道";
    if (token && [LDXP_WWW_HOST, LDXP_PAY_HOST, "ldxp.cn"].includes(url.hostname)) return `LDXP / ${token}`;
    if (token && url.hostname === "pay.qxvx.cn") return `QXVX / ${token}`;
    if (token && url.hostname === "catfk.com") return `云猫寄售 / ${token}`;
    return url.hostname.replace(/^www\./, "");
  } catch {
    return "Submitted Source";
  }
}

function sourceIdFrom(name, value) {
  const text = `${name || ""}-${normalizeHostname(value) || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return text || `source-${Date.now()}`;
}

function shopTokenFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/shop\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function goodsKeyFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/item\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function isMissingColumnError(error, column) {
  if (!error) return false;
  const message = String(error.message || "");
  return error.code === "42703" || message.includes(`'${column}' column`) || message.includes(`column ${column}`);
}

function errorMessage(error) {
  if (!(error instanceof Error)) {
    if (error && typeof error === "object") {
      const details = [error.message, error.details, error.hint, error.code]
        .filter(Boolean)
        .map((value) => redactErrorCredentials(value));
      if (details.length) return details.join(": ");
    }
    return String(error);
  }
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const code = typeof cause.code === "string" ? cause.code : "";
    const message = typeof cause.message === "string" ? redactErrorCredentials(cause.message) : "";
    if (code || message) return [error.message, code, message].filter(Boolean).join(": ");
  }
  return redactErrorCredentials(error.message);
}

function redactErrorCredentials(value) {
  return String(value || "")
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:accessPassword|accessName|password|rid|uid|skey)=)[^&\s]+/gi, "$1[redacted]");
}

function parseArgs(values) {
  const result = {};

  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = values[index + 1];

    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }

  return result;
}

function readEnvFile(path) {
  const output = {};
  if (!existsSync(path)) return output;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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

function isCli() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
