import {
  rawOfferInputId,
  recordSourceCollectionResult,
  upsertRawOffers,
  upsertSource,
} from "@/lib/admin";
import { logApiError, safeApiErrorMessage } from "@/lib/api-errors";
import { classifyOffer } from "@/lib/catalog";
import { normalizeCollectorKind } from "@/lib/collector-registry";
import { clearAdminDataCache, clearPublicDataCache, markPublicApiSnapshotsDirty } from "@/lib/data";
import { requireAdminOrCronRequest } from "@/lib/env";
import { pruneOperationalLogs } from "@/lib/operational-logs";
import { getSupabaseServerClient } from "@/lib/supabase";
import { stableId } from "@/lib/utils";
import { hasSellableOffers as crawlOffersHaveSellableInventory } from "../../../../../scripts/out-of-stock-observation.mjs";
import { z } from "zod";

const bulkPricingTierSchema = z.object({
  minQuantity: z.number().int().min(1),
  value: z.number().nonnegative().nullable().optional(),
  discountType: z.number().int().nullable().optional(),
  label: z.string().max(80).nullable().optional(),
});

const offerSchema = z.object({
  sourceId: z.string().min(1).optional(),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceStoreName: z.string().optional(),
  sourceShopCreatedAt: z.string().datetime().nullable().optional(),
  sourceTitle: z.string().min(1),
  price: z.number().nonnegative().nullable().optional(),
  listedPrice: z.number().nonnegative().nullable().optional(),
  feeAmount: z.number().nonnegative().nullable().optional(),
  priceBasis: z.enum(["settled", "modeled", "listed", "listed_fallback"]).nullable().optional(),
  currency: z.string().optional(),
  status: z.enum(["in_stock", "low_stock", "out_of_stock", "unknown"]).optional(),
  effectiveStatus: z.enum(["available", "low_confidence", "unavailable", "stale", "failed"]).nullable().optional(),
  freshnessStatus: z.enum(["fresh", "aging", "stale", "expired", "failed"]).nullable().optional(),
  failureReason: z.string().max(500).nullable().optional(),
  url: z.string().url(),
  tags: z.array(z.string()).optional(),
  stockCount: z.number().int().nullable().optional(),
  minOrderQuantity: z.number().int().min(2).nullable().optional(),
  bulkPricingTiers: z.array(bulkPricingTierSchema).max(20).optional(),
});

const crawlLogPayloadSchema = z.object({
  sourceId: z.string().min(1).optional(),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceEntryUrl: z.string().url().optional(),
  sourceShopCreatedAt: z.string().datetime().nullable().optional(),
  mode: z.enum(["browser", "http", "manual"]).default("browser"),
  status: z.enum(["success", "partial", "failed", "skipped"]).default("success"),
  message: z.string().optional(),
  offers: z.array(offerSchema).default([]),
  details: z.record(z.string(), z.unknown()).optional(),
});

const batchSchema = z.object({
  runs: z.array(crawlLogPayloadSchema).min(1).max(50),
  batch: z.record(z.string(), z.unknown()).optional(),
});

const CRAWL_LOG_INGEST_PROCESSING_TTL_MS = 2 * 60 * 1000;
const CRAWL_LOG_INGEST_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const CRAWL_LOG_INGEST_FAILED_RETRY_MS = 60 * 1000;
const CRAWL_LOG_INGEST_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const COVERED_COLLECTION_JOB_LIMIT = 20;
const SHOP_API_FEE_POLICY_TTL_HOURS = 7 * 24;
const PERSISTABLE_SHOP_API_FEE_STRATEGIES = new Set(["no_fee", "fixed_3pct", "observed_rate"]);

let lastCrawlLogIngestPrunedAt = 0;

type CrawlLogPayload = z.infer<typeof crawlLogPayloadSchema>;
type CrawlLogStatus = CrawlLogPayload["status"];

type SaveCrawlLogRunResult = {
  sourceId: string;
  sourceName: string;
  status: string;
  successCount: number;
  writtenCount: number;
  unchangedCount: number;
  refreshedCount: number;
  confirmedCount: number;
  affectedProductIds: string[];
  affectedOfferIds: string[];
  affectedSourceIds: string[];
  shouldClearCache: boolean;
  completedCollectionJobs?: string[];
  duplicate?: boolean;
  duplicateReason?: "completed" | "processing";
};

type CrawlLogIngestClaim =
  | { shouldProcess: true }
  | { shouldProcess: false; reason: "completed" | "processing" };

export async function POST(request: Request) {
  try {
    await requireAdminOrCronRequest(request);

    const supabase = getSupabaseServerClient();
    if (!supabase) throw new Error("Supabase 尚未配置，无法保存采集结果。");

    const rawBody = await request.json();
    const isBatch = rawBody && typeof rawBody === "object" && Array.isArray(rawBody.runs);
    const runs = isBatch ? batchSchema.parse(rawBody).runs : [crawlLogPayloadSchema.parse(rawBody)];
    const results = [];
    let shouldClearCache = false;
    let snapshotRefreshQueued = false;
    const affectedProductIds = new Set<string>();
    const affectedOfferIds = new Set<string>();
    const affectedSourceIds = new Set<string>();

    for (const run of runs) {
      const result = await saveCrawlLogRun(supabase, run);
      results.push(result);
      shouldClearCache = shouldClearCache || result.shouldClearCache;
      for (const id of result.affectedProductIds) affectedProductIds.add(id);
      for (const id of result.affectedOfferIds) affectedOfferIds.add(id);
      for (const id of result.affectedSourceIds) affectedSourceIds.add(id);
    }

    await pruneOperationalLogs(supabase);
    await pruneCrawlLogIngestRuns(supabase);

    if (shouldClearCache) {
      clearPublicDataCache();
      snapshotRefreshQueued = await markPublicApiSnapshotsDirty("admin crawl log", {
        productIds: [...affectedProductIds],
        offerIds: [...affectedOfferIds],
        sourceIds: [...affectedSourceIds],
        global: false,
        fullOnProductScopeLimitOnly: true,
        preferProductScope: true,
        resetRefreshScope: true,
      });
    }

    const totals = aggregateResults(results);
    return Response.json({
      ok: true,
      successCount: totals.successCount,
      writtenCount: totals.writtenCount,
      unchangedCount: totals.unchangedCount,
      refreshedCount: totals.refreshedCount,
      confirmedCount: totals.confirmedCount,
      snapshotRefreshQueued,
      runCount: results.length,
      results: isBatch ? results.map(compactResult) : undefined,
    });
  } catch (error) {
    logApiError("admin crawl log", error);
    return Response.json(
      { ok: false, message: safeApiErrorMessage(error, "记录采集结果失败。") },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}

async function saveCrawlLogRun(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  payload: CrawlLogPayload,
): Promise<SaveCrawlLogRunResult> {
  const receivedAt = new Date().toISOString();
  const collectedAt = dateFromDetails(payload.details, "collectedAt") || receivedAt;
  const startedAt = dateFromDetails(payload.details, "collectionStartedAt") || receivedAt;
  const runId = stableId(payload.sourceName, payload.sourceUrl, startedAt, crawlLogRunIdSuffix(payload.details, payload.status));
  const ingestClaim = await claimCrawlLogIngest(supabase, {
    id: runId,
    startedAt,
    payload,
  });
  if (!ingestClaim.shouldProcess) return duplicateCrawlLogResult(payload, ingestClaim.reason);

  try {
    const source = await upsertSource({
      id: payload.sourceId,
      name: payload.sourceName,
      entryUrl: payload.sourceEntryUrl || payload.sourceUrl,
      collectionMethod: payload.mode,
      collectorKind: collectorKindFromDetails(payload.details),
      shopCreatedAt: payload.sourceShopCreatedAt || shopCreatedAtFromDetails(payload.details),
    });
    const offers = payload.offers.map((offer) => ({
      ...offer,
      sourceId: offer.sourceId || payload.sourceId || source.id,
      sourceShopCreatedAt: offer.sourceShopCreatedAt || payload.sourceShopCreatedAt || shopCreatedAtFromDetails(payload.details),
    }));
    const upsertResult = await upsertRawOffers(offers, { collectionMethod: payload.mode, checkedAt: collectedAt });
    const successCount = upsertResult.receivedCount;
    const savedAt = new Date().toISOString();
    const seenOfferIds = seenOfferIdsFromDetails(payload.details) || offers.map(rawOfferInputId);
    const fullSnapshot = fullSnapshotFromDetails(payload.details, payload.status, offers.length);
    const collectionStatus = normalizeCrawlLogCollectionStatus(payload, fullSnapshot, offers.length);
    const hasSellableOffers = fullSnapshot ? crawlOffersHaveSellableInventory(offers) : undefined;
    const hideMissingOffersImmediately = false;
    const changedByPayload = upsertResult.writtenCount > 0 || upsertResult.refreshedCount > 0;
    const affectedOfferIds = changedByPayload ? offers.map(rawOfferInputId) : [];
    const affectedProductIds = changedByPayload ? offers.map(productIdFromCrawlOffer) : [];

    const sourceCollectionResult = payload.details?.hotVerification === true
      ? { changedOfferCount: 0 }
      : await recordSourceCollectionResult({
          sourceId: source.id,
          status: collectionStatus,
          checkedAt: collectedAt,
          message: payload.message || null,
          seenOfferIds,
          fullSnapshot,
          hasSellableOffers,
          hideMissingOffersImmediately,
        });

    const crawlRunRow = {
      id: runId,
      source_id: source.id,
      source_name: payload.sourceName,
      mode: payload.mode,
      status: collectionStatus,
      started_at: startedAt,
      finished_at: collectedAt,
      success_count: successCount,
      failure_count: Math.max(0, payload.offers.length - successCount),
      message:
        payload.message ||
        `采集到 ${successCount} 条报价，写入 ${upsertResult.writtenCount} 条，刷新 ${upsertResult.refreshedCount} 条。`,
      details: {
        ...(payload.details || {}),
        receivedStatus: payload.status,
        receivedAt,
        savedAt,
        collectedAt,
        writeStats: {
          receivedCount: upsertResult.receivedCount,
          writtenCount: upsertResult.writtenCount,
          unchangedCount: upsertResult.unchangedCount,
          refreshedCount: upsertResult.refreshedCount,
          confirmedCount: upsertResult.confirmedCount,
        },
        missingOfferReconciliation: {
          hideImmediately: hideMissingOffersImmediately,
        },
      },
    };

    const { error } = await supabase.from("crawl_runs").insert(crawlRunRow);

    if (error) {
      if (isDuplicateKeyError(error)) {
        const duplicateResult = duplicateCrawlLogResult(payload, "completed");
        await completeCrawlLogIngest(supabase, runId, source.id, compactResult(duplicateResult));
        return duplicateResult;
      }
      throw error;
    }

    await persistShopApiFeePolicies(supabase, payload, {
      sourceId: source.id,
      sourceName: source.name,
      runId,
      collectedAt,
    }).catch((error) => {
      if (isMissingShopApiFeePoliciesError(error)) return;
      logApiError("shop api fee policy persist", error);
    });

    const completedCollectionJobs = await completeCoveredCollectionJobs(supabase, {
      sourceId: source.id,
      sourceName: source.name,
      collectedAt,
      fullSnapshot,
      collectionStatus,
      runId,
      collectorNodeId: collectorNodeIdFromDetails(payload.details),
      explicitJobId: stringFromDetails(payload.details, "collectionJobId"),
    });

    const result = {
      sourceId: source.id,
      sourceName: source.name,
      status: collectionStatus,
      successCount,
      writtenCount: upsertResult.writtenCount,
      unchangedCount: upsertResult.unchangedCount,
      refreshedCount: upsertResult.refreshedCount,
      confirmedCount: upsertResult.confirmedCount,
      affectedProductIds,
      affectedOfferIds,
      affectedSourceIds: sourceCollectionResult.changedOfferCount > 0 ? [source.id] : [],
      shouldClearCache:
        upsertResult.writtenCount > 0 ||
        upsertResult.refreshedCount > 0 ||
        sourceCollectionResult.changedOfferCount > 0,
      completedCollectionJobs,
    };
    await completeCrawlLogIngest(supabase, runId, source.id, compactResult(result));
    return result;
  } catch (error) {
    await failCrawlLogIngest(supabase, runId, safeApiErrorMessage(error, "采集结果写入失败。"));
    throw error;
  }
}

function aggregateResults(
  results: Array<Pick<SaveCrawlLogRunResult, "successCount" | "writtenCount" | "unchangedCount" | "refreshedCount" | "confirmedCount">>,
) {
  return results.reduce(
    (totals, result) => ({
      successCount: totals.successCount + result.successCount,
      writtenCount: totals.writtenCount + result.writtenCount,
      unchangedCount: totals.unchangedCount + result.unchangedCount,
      refreshedCount: totals.refreshedCount + result.refreshedCount,
      confirmedCount: totals.confirmedCount + result.confirmedCount,
    }),
    { successCount: 0, writtenCount: 0, unchangedCount: 0, refreshedCount: 0, confirmedCount: 0 },
  );
}

async function persistShopApiFeePolicies(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  payload: CrawlLogPayload,
  input: {
    sourceId: string;
    sourceName: string;
    runId: string;
    collectedAt: string;
  },
): Promise<void> {
  const rows = shopApiFeePolicyRowsFromPayload(payload, input);
  if (!rows.length) return;

  const { error } = await supabase
    .from("shop_api_fee_policies")
    .upsert(rows, { onConflict: "source_id,shop_token" });

  if (error) throw error;
}

function shopApiFeePolicyRowsFromPayload(
  payload: CrawlLogPayload,
  input: {
    sourceId: string;
    sourceName: string;
    runId: string;
    collectedAt: string;
  },
): Array<Record<string, unknown>> {
  if (payload.status !== "success" && payload.status !== "partial") return [];

  const details = payload.details || {};
  const pricingSummaries = details.shopApiPricing;
  if (!Array.isArray(pricingSummaries)) return [];

  const collectorNodeId = collectorNodeIdFromDetails(details);
  const defaultShopToken = shopTokenFromUrl(String(payload.sourceEntryUrl || payload.sourceUrl || "")) || "source";
  const defaultShopUrl = payload.sourceEntryUrl || payload.sourceUrl;
  const rows = new Map<string, Record<string, unknown>>();

  for (const summaryValue of pricingSummaries) {
    const summary = objectRecord(summaryValue);
    const strategy = String(summary.strategy || "");
    if (!PERSISTABLE_SHOP_API_FEE_STRATEGIES.has(strategy)) continue;
    if (String(summary.sampleSelection || "") === "cached_policy") continue;
    if (String(summary.policySource || "") === "persisted") continue;

    const resolvedSampleSize = nonNegativeIntegerValue(summary.resolvedSampleSize);
    if (!resolvedSampleSize) continue;

    const rate = normalizedShopApiFeeRate(strategy, summary.rate);
    if (rate === null) continue;

    const observedAt = validDateString(summary.observedAt) ||
      validDateString(summary.sampledAt) ||
      dateFromDetails(details, "collectedAt") ||
      input.collectedAt;
    const expiresAt = addHours(observedAt, SHOP_API_FEE_POLICY_TTL_HOURS);
    const shopToken = String(summary.shopToken || "").trim() || defaultShopToken;
    const probes = Array.isArray(summary.probes) ? summary.probes : [];

    rows.set(shopToken, {
      source_id: input.sourceId,
      shop_token: shopToken,
      source_name: input.sourceName,
      shop_url: String(summary.shopUrl || defaultShopUrl || ""),
      strategy,
      rate,
      sample_size: nonNegativeIntegerValue(summary.sampleSize) || 0,
      resolved_sample_size: resolvedSampleSize,
      sample_selection: typeof summary.sampleSelection === "string" ? summary.sampleSelection : null,
      probes,
      observed_at: observedAt,
      expires_at: expiresAt,
      collector_node_id: collectorNodeId,
      last_seen_run_id: input.runId,
      updated_at: new Date().toISOString(),
    });
  }

  return Array.from(rows.values());
}

function normalizedShopApiFeeRate(strategy: string, value: unknown): number | null {
  if (strategy === "no_fee") return 0;
  if (strategy === "fixed_3pct") return 0.03;

  const rate = numberValue(value);
  if (rate === null || rate <= 0 || rate > 0.2) return null;
  return Math.round(rate * 10_000) / 10_000;
}

function nonNegativeIntegerValue(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric === null || !Number.isInteger(numeric) || numeric < 0) return null;
  return numeric;
}

function validDateString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function addHours(isoDate: string, hours: number): string {
  return new Date(new Date(isoDate).getTime() + hours * 60 * 60 * 1000).toISOString();
}

async function completeCoveredCollectionJobs(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  input: {
    sourceId: string;
    sourceName: string;
    collectedAt: string;
    fullSnapshot: boolean;
    collectionStatus: string;
    runId: string;
    collectorNodeId: string | null;
    explicitJobId: string | null;
  },
): Promise<string[]> {
  if (input.collectionStatus !== "success") return [];

  const { data, error } = await supabase
    .from("collection_jobs")
    .select("id,created_at,requested_by,result,status,locked_until")
    .eq("job_type", "source")
    .eq("source_id", input.sourceId)
    .in("status", ["pending", "running"])
    .lte("created_at", input.collectedAt)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(COVERED_COLLECTION_JOB_LIMIT);
  if (error) throw error;

  const now = new Date().toISOString();
  const jobs = (data || [])
    .filter(() => {
      if (input.explicitJobId) return true;
      return input.fullSnapshot;
    });
  if (!jobs.length) return [];

  const jobIds = jobs.map((job) => String(job.id));
  const resultByJobId = new Map(
    jobs.map((job) => [
      String(job.id),
      job.result && typeof job.result === "object"
        ? job.result as Record<string, unknown>
        : {},
    ]),
  );

  for (const jobId of jobIds) {
    const previousResult = resultByJobId.get(jobId) || {};
    const { error: updateError } = await supabase
      .from("collection_jobs")
      .update({
        status: "success",
        finished_at: now,
        locked_by: null,
        locked_until: null,
        last_error: null,
        result: {
          ...previousResult,
          coveredBy: "crawl_log",
          sourceId: input.sourceId,
          sourceName: input.sourceName,
          crawlRunId: input.runId,
          collectedAt: input.collectedAt,
          collectorNodeId: input.collectorNodeId,
        },
        updated_at: now,
      })
      .eq("id", jobId);
    if (updateError) throw updateError;
  }

  const feedbackJobIds = jobs
    .filter((job) => String(job.requested_by || "") === "feedback")
    .map((job) => String(job.id));
  if (feedbackJobIds.length) {
    await markFeedbackRecollectionCovered(supabase, {
      jobIds: feedbackJobIds,
      sourceName: input.sourceName,
      collectedAt: input.collectedAt,
      now,
    });
  }

  clearAdminDataCache();
  return jobIds;
}

async function markFeedbackRecollectionCovered(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  input: {
    jobIds: string[];
    sourceName: string;
    collectedAt: string;
    now: string;
  },
): Promise<void> {
  const { data: feedbackRows, error: readError } = await supabase
    .from("offer_feedback")
    .select("id,reason,offer_id,source_title,offer_price,offer_status,ai_review_result")
    .in("created_collection_job_id", input.jobIds);
  if (readError && !isMissingFeedbackVerificationColumnError(readError)) throw readError;

  const rows = feedbackRows || [];
  const offerIds = rows
    .map((row) => String((row as Record<string, unknown>).offer_id || ""))
    .filter(Boolean);
  const offerById = new Map<string, Record<string, unknown>>();
  if (offerIds.length) {
    const { data: offerRows, error: offerReadError } = await supabase
      .from("raw_offers")
      .select("id,source_title,price,status,hidden,effective_status")
      .in("id", offerIds);
    if (offerReadError) throw offerReadError;
    for (const offer of offerRows || []) {
      offerById.set(String((offer as Record<string, unknown>).id), offer as Record<string, unknown>);
    }
  }

  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const offerId = String(record.offer_id || "");
    const outcome = feedbackRecollectionOutcome(record, offerId ? offerById.get(offerId) || null : null, input);
    const currentReview = objectRecord(record.ai_review_result);
    const { error } = await supabase
      .from("offer_feedback")
      .update({
        status: outcome.feedbackStatus,
        reviewed_at: outcome.feedbackStatus === "resolved" ? input.now : null,
        verification_status: outcome.verificationStatus,
        verification_result: outcome.verificationResult,
        verification_message: outcome.message,
        verification_checked_at: input.now,
        ai_review_result: {
          ...currentReview,
          verificationStatus: outcome.verificationStatus,
          verificationResult: outcome.verificationResult,
          verificationMessage: outcome.message,
          verifiedAt: input.now,
          coveredCollectionJobIds: input.jobIds,
          recollectionOutcome: outcome.details,
        },
      })
      .eq("id", record.id);
    if (error && !isMissingFeedbackVerificationColumnError(error)) throw error;
  }
}

function feedbackRecollectionOutcome(
  feedback: Record<string, unknown>,
  offer: Record<string, unknown> | null,
  input: {
    sourceName: string;
    collectedAt: string;
    now: string;
  },
): {
  feedbackStatus: "pending" | "resolved";
  verificationStatus: "auto_fixed" | "manual_review";
  verificationResult: "offer_changed" | "item_removed" | "out_of_stock" | "inconclusive";
  message: string;
  details: Record<string, unknown>;
} {
  const reason = String(feedback.reason || "");
  const baseDetails = {
    sourceName: input.sourceName,
    collectedAt: input.collectedAt,
    reason,
    offerId: feedback.offer_id || null,
  };

  if (!offer) {
    return {
      feedbackStatus: "pending",
      verificationStatus: "manual_review",
      verificationResult: "inconclusive",
      message: `来源「${input.sourceName}」已完成重采，但没有匹配到反馈报价；请人工复核。`,
      details: { ...baseDetails, outcome: "missing_offer" },
    };
  }

  const currentStatus = String(offer.status || "");
  const currentEffectiveStatus = String(offer.effective_status || "");
  const currentHidden = offer.hidden === true;
  if (currentHidden || currentEffectiveStatus === "unavailable" || currentStatus === "out_of_stock") {
    const verificationResult = currentStatus === "out_of_stock" ? "out_of_stock" : "item_removed";
    return {
      feedbackStatus: "resolved",
      verificationStatus: "auto_fixed",
      verificationResult,
      message: `来源「${input.sourceName}」重采完成后，该报价已不可售，自动标记已处理。`,
      details: {
        ...baseDetails,
        outcome: "offer_unavailable",
        currentStatus,
        currentEffectiveStatus,
        currentHidden,
      },
    };
  }

  const snapshotPrice = numberValue(feedback.offer_price);
  const currentPrice = numberValue(offer.price);
  if (reason === "wrong_price" && snapshotPrice !== null && currentPrice !== null && Math.abs(snapshotPrice - currentPrice) >= 0.01) {
    return {
      feedbackStatus: "resolved",
      verificationStatus: "auto_fixed",
      verificationResult: "offer_changed",
      message: `来源「${input.sourceName}」重采完成后，报价价格已从 ¥${snapshotPrice} 变为 ¥${currentPrice}，自动标记已处理。`,
      details: {
        ...baseDetails,
        outcome: "price_changed",
        snapshotPrice,
        currentPrice,
      },
    };
  }

  const snapshotStatus = String(feedback.offer_status || "");
  if (reason === "stock_mismatch" && snapshotStatus && currentStatus && snapshotStatus !== currentStatus) {
    return {
      feedbackStatus: "resolved",
      verificationStatus: "auto_fixed",
      verificationResult: "offer_changed",
      message: `来源「${input.sourceName}」重采完成后，库存状态已从「${snapshotStatus}」变为「${currentStatus}」，自动标记已处理。`,
      details: {
        ...baseDetails,
        outcome: "status_changed",
        snapshotStatus,
        currentStatus,
      },
    };
  }

  return {
    feedbackStatus: "pending",
    verificationStatus: "manual_review",
    verificationResult: "inconclusive",
    message: `来源「${input.sourceName}」已完成重采，最近确认时间 ${input.collectedAt}；当前报价仍与反馈快照一致，请人工复核。`,
    details: {
      ...baseDetails,
      outcome: "still_consistent",
      currentPrice,
      currentStatus,
      currentEffectiveStatus,
      currentHidden,
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function numberValue(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function compactResult(result: {
  sourceId: string;
  sourceName: string;
  status: string;
  successCount: number;
  writtenCount: number;
  unchangedCount: number;
  refreshedCount?: number;
  confirmedCount?: number;
  completedCollectionJobs?: string[];
  duplicate?: boolean;
  duplicateReason?: string;
}) {
  return {
    sourceId: result.sourceId,
    sourceName: result.sourceName,
    status: result.status,
    successCount: result.successCount,
    writtenCount: result.writtenCount,
    unchangedCount: result.unchangedCount,
    refreshedCount: result.refreshedCount || 0,
    confirmedCount: result.confirmedCount || 0,
    completedCollectionJobs: result.completedCollectionJobs?.length ? result.completedCollectionJobs : undefined,
    duplicate: result.duplicate || undefined,
    duplicateReason: result.duplicateReason || undefined,
  };
}

async function pruneCrawlLogIngestRuns(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
): Promise<void> {
  const now = Date.now();
  if (now - lastCrawlLogIngestPrunedAt < CRAWL_LOG_INGEST_PRUNE_INTERVAL_MS) return;
  lastCrawlLogIngestPrunedAt = now;

  const { error } = await supabase
    .from("crawl_log_ingest_runs")
    .delete()
    .lt("expires_at", new Date(now).toISOString());
  if (error && !isMissingCrawlLogIngestTableError(error)) {
    console.warn("Failed to prune crawl log ingest locks:", error.message);
  }
}

async function claimCrawlLogIngest(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  input: {
    id: string;
    startedAt: string;
    payload: z.infer<typeof crawlLogPayloadSchema>;
  },
): Promise<CrawlLogIngestClaim> {
  const now = new Date();
  const row = {
    id: input.id,
    source_id: null,
    source_name: input.payload.sourceName,
    started_at: input.startedAt,
    batch_index: positiveIntegerFromDetails(input.payload.details, "batchIndex"),
    batch_count: positiveIntegerFromDetails(input.payload.details, "batchCount"),
    status: "processing",
    result: null,
    expires_at: new Date(now.getTime() + CRAWL_LOG_INGEST_PROCESSING_TTL_MS).toISOString(),
    updated_at: now.toISOString(),
  };

  const { error: insertError } = await supabase.from("crawl_log_ingest_runs").insert(row);
  if (!insertError) return { shouldProcess: true };
  if (isMissingCrawlLogIngestTableError(insertError)) return { shouldProcess: true };
  if (!isDuplicateKeyError(insertError)) throw insertError;

  const { data, error: readError } = await supabase
    .from("crawl_log_ingest_runs")
    .select("status,expires_at")
    .eq("id", input.id)
    .maybeSingle();
  if (readError) {
    if (isMissingCrawlLogIngestTableError(readError)) return { shouldProcess: true };
    throw readError;
  }

  const existingStatus = String(data?.status || "");
  const expiresAt = new Date(String(data?.expires_at || "")).getTime();
  if (existingStatus === "completed") return { shouldProcess: false, reason: "completed" };
  if (existingStatus === "processing" && Number.isFinite(expiresAt) && expiresAt > now.getTime()) {
    return { shouldProcess: false, reason: "processing" };
  }

  const { error: updateError } = await supabase
    .from("crawl_log_ingest_runs")
    .update(row)
    .eq("id", input.id);
  if (updateError) {
    if (isMissingCrawlLogIngestTableError(updateError)) return { shouldProcess: true };
    throw updateError;
  }

  return { shouldProcess: true };
}

async function completeCrawlLogIngest(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  id: string,
  sourceId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  const { error } = await supabase
    .from("crawl_log_ingest_runs")
    .update({
      source_id: sourceId,
      status: "completed",
      result,
      expires_at: new Date(now + CRAWL_LOG_INGEST_COMPLETED_RETENTION_MS).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    .eq("id", id);
  if (error && !isMissingCrawlLogIngestTableError(error)) {
    console.warn("Failed to complete crawl log ingest lock:", error.message);
  }
}

async function failCrawlLogIngest(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  id: string,
  message: string,
): Promise<void> {
  const now = Date.now();
  const { error } = await supabase
    .from("crawl_log_ingest_runs")
    .update({
      status: "failed",
      result: { message },
      expires_at: new Date(now + CRAWL_LOG_INGEST_FAILED_RETRY_MS).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    .eq("id", id);
  if (error && !isMissingCrawlLogIngestTableError(error)) {
    console.warn("Failed to mark crawl log ingest lock failed:", error.message);
  }
}

function duplicateCrawlLogResult(
  payload: CrawlLogPayload,
  reason: "completed" | "processing",
): SaveCrawlLogRunResult {
  return {
    sourceId: payload.sourceId || stableId("source", payload.sourceName, payload.sourceUrl),
    sourceName: payload.sourceName,
    status: payload.status,
    successCount: 0,
    writtenCount: 0,
    unchangedCount: 0,
    refreshedCount: 0,
    confirmedCount: 0,
    affectedProductIds: [],
    affectedOfferIds: [],
    affectedSourceIds: [],
    shouldClearCache: false,
    duplicate: true,
    duplicateReason: reason,
  };
}

function normalizeCrawlLogCollectionStatus(
  payload: CrawlLogPayload,
  fullSnapshot: boolean,
  offerCount: number,
): CrawlLogStatus {
  if (payload.status === "partial" && isIntermediateBatch(payload.details)) return "success";
  if (fullSnapshot && payload.status === "failed" && offerCount === 0) return "success";
  return payload.status;
}

function isIntermediateBatch(details: Record<string, unknown> | undefined): boolean {
  const batchIndex = positiveIntegerFromDetails(details, "batchIndex");
  const batchCount = positiveIntegerFromDetails(details, "batchCount");
  return Boolean(batchIndex && batchCount && batchIndex < batchCount);
}

function isDuplicateKeyError(error: unknown): boolean {
  return supabaseErrorCode(error) === "23505";
}

function isMissingCrawlLogIngestTableError(error: unknown): boolean {
  const code = supabaseErrorCode(error);
  const message = supabaseErrorMessage(error);
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (code === "PGRST204" && message.includes("crawl_log_ingest_runs")) ||
    message.includes("crawl_log_ingest_runs")
  );
}

function isMissingFeedbackVerificationColumnError(error: unknown): boolean {
  const code = supabaseErrorCode(error);
  const message = supabaseErrorMessage(error);
  return code === "PGRST204" && /verification_(status|result|message|checked_at)|created_collection_job_id|ai_review_result/.test(message);
}

function supabaseErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code || "") : "";
}

function supabaseErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String(error.message || "") : "";
}

function productIdFromCrawlOffer(offer: z.infer<typeof offerSchema>): string {
  return classifyOffer(offer.sourceTitle, {
    tags: offer.tags || [],
  }).id;
}

function collectorKindFromDetails(details: Record<string, unknown> | undefined) {
  return normalizeCollectorKind(details?.collector);
}

function collectorNodeIdFromDetails(details: Record<string, unknown> | undefined): string | null {
  const node = details?.collectorNode;
  if (!node || typeof node !== "object") return null;
  const id = (node as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function stringFromDetails(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fullSnapshotFromDetails(details: Record<string, unknown> | undefined, status: string, offerCount: number): boolean {
  if (status === "failed" && offerCount === 0 && isCompleteEmptySnapshot(details)) return true;
  if (typeof details?.fullSnapshot === "boolean") return status === "success" && details.fullSnapshot;
  return status === "success";
}

function seenOfferIdsFromDetails(details: Record<string, unknown> | undefined): string[] | null {
  const value = details?.seenOfferIds;
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item)).filter(Boolean);
}

function isCompleteEmptySnapshot(details: Record<string, unknown> | undefined): boolean {
  const collector = normalizeCollectorKind(details?.collector);
  if (!["kami"].includes(collector || "")) return false;

  const attempts = details?.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return false;
  return attempts.every((attempt) => {
    if (!attempt || typeof attempt !== "object") return false;
    const record = attempt as Record<string, unknown>;
    return record.status === "empty" && Number(record.offers || 0) === 0;
  });
}

function crawlLogRunIdSuffix(details: Record<string, unknown> | undefined, status: string): string | null {
  const batchIndex = positiveIntegerFromDetails(details, "batchIndex");
  const batchCount = positiveIntegerFromDetails(details, "batchCount");
  if (batchIndex && batchCount) return `batch:${batchIndex}/${batchCount}`;
  if (batchIndex) return `batch:${batchIndex}`;
  if (status === "partial") return "partial";
  return null;
}

function positiveIntegerFromDetails(details: Record<string, unknown> | undefined, key: string): number | null {
  const value = details?.[key];
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1) return null;
  return number;
}

function dateFromDetails(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  if (typeof value !== "string") return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function shopCreatedAtFromDetails(details: Record<string, unknown> | undefined): string | null {
  return dateFromDetails(details, "shopCreatedAt") || dateFromDetails(details, "sourceShopCreatedAt");
}

function shopTokenFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/shop\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    const match = value.match(/\/shop\/([^/?#]+)/i);
    return match?.[1] || null;
  }
}

function isMissingShopApiFeePoliciesError(error: unknown): boolean {
  const code = supabaseErrorCode(error);
  const message = supabaseErrorMessage(error);
  const text = `${code} ${message}`;
  return /shop_api_fee_policies/i.test(text) && /PGRST|42P01|not found|does not exist|schema cache/i.test(text);
}
