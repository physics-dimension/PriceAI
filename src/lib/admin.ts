import "server-only";

import { nextSourceAvailabilityObservation } from "../../scripts/out-of-stock-observation.mjs";
import { canonicalCatalog, classifyOffer } from "./catalog";
import { freshnessFields } from "./freshness";
import {
  collectorHostsForKind,
  inferCollectorKindFromHost,
  normalizeCollectorKind as normalizeRegisteredCollectorKind,
} from "./collector-registry";
import { pruneOperationalLogs } from "./operational-logs";
import { safeFetch } from "./safe-fetch";
import { isFeedbackEvidenceReference } from "./feedback-evidence";
import { getSupabaseServerClient } from "./supabase";
import {
  buildSubmissionPriceEvidence,
  channelSubmissionKey,
  classifySubmission,
  normalizeSubmissionUrl,
  storedPreclassification,
  type SubmissionPreclassification as StoredSubmissionPreclassification,
  type SubmissionPriceBenchmark,
  type SubmissionProbeResult as ReviewSubmissionProbeResult,
} from "./submission-review";
import {
  buildInitialFeedbackVerificationResult,
  feedbackRequiresContact,
  feedbackRequiresEvidence,
  feedbackRequiresImageEvidence,
  hasFeedbackImageEvidenceReference,
  HIGH_RISK_FEEDBACK_REASONS,
  inferSuggestedActionForFeedback,
  MODEL_PRECHECK_FEEDBACK_REASONS,
} from "./trust-risk";
import {
  mergeRiskPrecheckResult,
  reviewRiskFeedback,
  type RiskFeedbackReviewInput,
} from "./trust-risk-reviewer";
import type {
  ChannelSubmission,
  CollectionMethod,
  CollectorKind,
  OfferInput,
  OfferFeedback,
  OfferFeedbackIssueDimension,
  OfferFeedbackPublicStatus,
  OfferFeedbackReason,
  OfferFeedbackRiskPrecheck,
  OfferFeedbackScope,
  OfferFeedbackSuggestedAction,
  OfferFeedbackStatus,
  OfferFeedbackUserExpectedAction,
  OfferFeedbackVerificationResult,
  OfferFeedbackVerificationStatus,
  OfferStatus,
  RawOffer,
  SiteFeedback,
  SiteFeedbackStatus,
  SiteFeedbackType,
  Source,
  SourceBuyerFeePolicyInput,
  SubmissionReviewStage,
  SubmissionStatus,
} from "./types";
import { updateSourceBuyerFeeNote } from "./source-buyer-fee";
import {
  normalizeEffectiveStatus,
  normalizeFreshnessStatus,
  normalizeStatus,
  parseTags,
  slugify,
  stableId,
  stableOfferInputId,
} from "./utils";

export const ADMIN_SOURCE_HIDE_REASON_PREFIX = "管理员手动下架渠道";
export const ADMIN_OFFER_HIDE_REASON_PREFIX = "管理员手动下架报价";
export const ADMIN_MANUAL_HIDE_REASON_PREFIX = "管理员手动下架";
export const ADMIN_TEMPORARY_SOURCE_HIDE_REASON_PREFIX = "管理员临时下架渠道";
export const ADMIN_TEMPORARY_OFFER_HIDE_REASON_PREFIX = "管理员临时下架报价";
const ADMIN_SOURCE_DISABLE_NOTE_REASON_PREFIX = "后台停用原因：";
const ADMIN_SOURCE_DISABLE_NOTE_TIME_PREFIX = "后台停用时间：";
const RAW_OFFER_WRITE_CHUNK_SIZE = 25;
const RAW_OFFER_CONFIRMATION_WRITE_CHUNK_SIZE = 100;
const MISSING_OFFER_HIDE_CHUNK_SIZE = 25;
const MAX_MISSING_OFFERS_TO_HIDE_PER_COLLECTION = 100;
const MISSING_OFFER_SYSTEM_HIDE_REASON = "高覆盖采集未再返回该商品，疑似已下架；如源站后续重新返回会自动恢复展示。";
const MISSING_OFFER_CONFIRMED_SYSTEM_HIDE_REASON = "连续两次高覆盖采集未再返回该商品，疑似已下架；如源站后续重新返回会自动恢复展示。";
const MISSING_OFFER_CANDIDATE_REASON = "高覆盖采集首次未再返回该商品，暂时退出有货列表并等待下一次确认。";
const STALE_OFFER_FAILURE_THRESHOLD = 3;
const DEFAULT_STALE_OFFER_FAILURE_AGE_MS = 24 * 60 * 60 * 1000;
const SHOP_API_STALE_OFFER_FAILURE_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_STALE_OFFERS_TO_EXPIRE_PER_FAILURE = 50;

function stripAdminSourceDisableNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const kept = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !line.startsWith(ADMIN_SOURCE_DISABLE_NOTE_REASON_PREFIX) &&
      !line.startsWith(ADMIN_SOURCE_DISABLE_NOTE_TIME_PREFIX),
    );
  return kept.length ? kept.join("\n") : null;
}

function buildAdminSourceDisableNotes(notes: string | null | undefined, reason: string, at: string): string {
  const preservedNotes = stripAdminSourceDisableNotes(notes);
  return [
    `${ADMIN_SOURCE_DISABLE_NOTE_REASON_PREFIX}${reason}`,
    `${ADMIN_SOURCE_DISABLE_NOTE_TIME_PREFIX}${at}`,
    preservedNotes,
  ].filter(Boolean).join("\n");
}

export type RawOfferUpsertResult = {
  receivedCount: number;
  writtenCount: number;
  unchangedCount: number;
  refreshedCount: number;
  confirmedCount: number;
};

type AdminOfferHideMode = "manual" | "temporary";

let canonicalProductsEnsurePromise: Promise<void> | null = null;

type SubmissionProbeResult = {
  sourceId?: string;
  sourceName?: string;
  sourceUrl?: string;
  baseUrl?: string;
  kind?: string | null;
  status?: string;
  offerCount?: number;
  offers?: Array<Record<string, unknown>>;
  ms?: number;
  message?: string;
  finishedAt?: string;
};

type SubmissionProbeQueueInput = {
  sourceId?: string | null;
  sourceName?: string | null;
  sourceUrl: string;
  baseUrl?: string | null;
  collectorKind?: CollectorKind | string | null;
};

type ShopGoodsLookupResult = {
  checkedAt: string;
  goodsKey: string;
  httpStatus?: number;
  apiCode?: number | string | null;
  apiMessage?: string | null;
  token?: string | null;
  sourceUrl?: string | null;
  sourceName?: string | null;
  title?: string | null;
  price?: number | null;
  realPrice?: number | null;
  status?: string | null;
  category?: string | null;
  descriptionPreview?: string | null;
  error?: string | null;
};

type ShopInfoLookupResult = {
  checkedAt: string;
  token: string;
  httpStatus?: number;
  apiCode?: number | string | null;
  apiMessage?: string | null;
  sourceUrl?: string | null;
  sourceName?: string | null;
  status?: string | null;
  shopCreatedAt?: string | null;
  error?: string | null;
};

type SubmissionParseContext = {
  submissionId?: string | null;
  submittedName?: string | null;
  submittedUrl?: string | null;
  submittedAt?: string | null;
  parsedTitle?: string | null;
  contact?: string | null;
  notes?: string | null;
  currentMeta?: Record<string, unknown> | null;
};

export function getAdminPasswordFromRequest(request: Request): string | null {
  const header = request.headers.get("x-admin-password");
  if (header) return header;

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);

  return null;
}

export async function upsertSource(input: {
  id?: string | null;
  name: string;
  entryUrl: string;
  baseUrl?: string | null;
  collectionMethod?: CollectionMethod;
  collectorKind?: CollectorKind | null;
  enabled?: boolean;
  notes?: string | null;
  shopCreatedAt?: string | null;
}): Promise<Source> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法保存来源。");

  const normalizedEntryUrl = normalizeSourceEntryUrl(input.entryUrl) || input.entryUrl;
  let id = input.id || slugify(input.name || normalizedEntryUrl);
  const existingByEntryUrl = await findSourceRowByEntryUrl(normalizedEntryUrl);
  if (existingByEntryUrl?.id) id = String(existingByEntryUrl.id);

  const { data: existing, error: existingError } = await supabase
    .from("sources")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (existingError) throw existingError;

  const matchedExisting = existing || existingByEntryUrl;
  const matchedByEntryUrl = Boolean(existingByEntryUrl?.id);
  const sourceName = matchedByEntryUrl && matchedExisting?.name
    ? String(matchedExisting.name)
    : input.name;

  const nextUpdatedAt = new Date().toISOString();
  const shopCreatedAt = normalizedDateString(input.shopCreatedAt || null) ||
    (matchedExisting?.shop_created_at ? String(matchedExisting.shop_created_at) : null);
  const source: Source = {
    id,
    name: sourceName,
    baseUrl: input.baseUrl || deriveBaseUrl(normalizedEntryUrl),
    entryUrl: normalizedEntryUrl,
    collectionMethod: input.collectionMethod || String(matchedExisting?.collection_method || "manual") as CollectionMethod,
    collectorKind: input.collectorKind ?? normalizeCollectorKind(matchedExisting?.collector_kind),
    enabled: input.enabled ?? (matchedExisting ? Boolean(matchedExisting.enabled) : true),
    notes: input.notes || (matchedExisting?.notes ? String(matchedExisting.notes) : null),
    createdAt: matchedExisting?.created_at ? String(matchedExisting.created_at) : null,
    shopCreatedAt,
    updatedAt: nextUpdatedAt,
  };

  const row: Record<string, unknown> = {
    id: source.id,
    name: source.name,
    base_url: source.baseUrl,
    entry_url: source.entryUrl,
    collection_method: source.collectionMethod,
    enabled: source.enabled,
    notes: source.notes,
    updated_at: source.updatedAt,
  };
  if (input.collectorKind !== undefined) row.collector_kind = source.collectorKind;
  if (input.shopCreatedAt !== undefined) row.shop_created_at = source.shopCreatedAt;

  if (matchedExisting && isSourceRowUnchanged(row, matchedExisting)) {
    return {
      ...source,
      createdAt: matchedExisting.created_at ? String(matchedExisting.created_at) : source.createdAt,
      shopCreatedAt: matchedExisting.shop_created_at ? String(matchedExisting.shop_created_at) : source.shopCreatedAt,
      updatedAt: matchedExisting.updated_at ? String(matchedExisting.updated_at) : source.updatedAt,
    };
  }

  const { error } = await supabase.from("sources").upsert(row);

  if (error) throw error;
  return source;
}

export async function updateSourceState(input: {
  id: string;
  enabled?: boolean;
  collectionMethod?: CollectionMethod;
  collectorKind?: CollectorKind | null;
  collectionGroup?: Source["collectionGroup"];
  buyerFeePolicy?: SourceBuyerFeePolicyInput;
  notes?: string | null;
}): Promise<Source> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法更新来源。");

  let existingSource: Record<string, unknown> | null = null;
  if (
    input.collectionGroup !== undefined ||
    input.collectionMethod !== undefined ||
    input.collectorKind !== undefined ||
    input.buyerFeePolicy !== undefined
  ) {
    const { data: existing, error: existingError } = await supabase
      .from("sources")
      .select("id,base_url,entry_url,collector_kind,collection_method,collection_group,notes")
      .eq("id", input.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw new Error("来源不存在。");
    existingSource = existing;
    const sourceUrl = String(existing.entry_url || existing.base_url || "");
    let sourceHost = "";
    try {
      sourceHost = new URL(sourceUrl).hostname;
    } catch {
      sourceHost = "";
    }
    const nextGroup = input.collectionGroup || (existing.collection_group === "vip_15m" ? "vip_15m" : "automatic");
    const nextCollectorKind = input.collectorKind !== undefined
      ? input.collectorKind
      : normalizeCollectorKind(existing.collector_kind) || inferCollectorKindFromHost(sourceHost);
    const nextCollectionMethod = input.collectionMethod || String(existing.collection_method || "");
    const supportedHost = ["www.ldxp.cn", "pay.ldxp.cn", "ldxp.cn"].includes(sourceHost);
    if (nextGroup === "vip_15m" && (nextCollectorKind !== "shopApi" || nextCollectionMethod !== "http" || !supportedHost)) {
      throw new Error("VIP 15分钟监测组目前只支持 LDXP ShopApi 渠道。");
    }
  }

  const row: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof input.enabled === "boolean") row.enabled = input.enabled;
  if (input.collectionMethod) row.collection_method = input.collectionMethod;
  if (input.collectorKind !== undefined) row.collector_kind = input.collectorKind || null;
  if (input.collectionGroup !== undefined) row.collection_group = input.collectionGroup;
  if (input.buyerFeePolicy !== undefined) {
    const baseNotes = input.notes !== undefined
      ? input.notes
      : existingSource?.notes
        ? String(existingSource.notes)
        : null;
    if (input.buyerFeePolicy.mode === "manual") {
      row.buyer_fee_rate = input.buyerFeePolicy.rate;
      row.buyer_fee_payment_method = input.buyerFeePolicy.paymentMethod;
      row.buyer_fee_strategy = "manual_verified";
      row.notes = updateSourceBuyerFeeNote(
        baseNotes,
        input.buyerFeePolicy.note,
      );
    } else {
      row.buyer_fee_rate = null;
      row.buyer_fee_payment_method = null;
      row.buyer_fee_strategy = null;
      row.notes = updateSourceBuyerFeeNote(
        baseNotes,
        null,
      );
    }
  }
  if (input.notes !== undefined && input.buyerFeePolicy === undefined) row.notes = input.notes;

  const { data, error } = await supabase
    .from("sources")
    .update(row)
    .eq("id", input.id)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("来源不存在。");
  return mapSourceRow(data);
}

export async function deleteSource(input: {
  id: string;
  deleteOffers?: boolean;
}): Promise<{ deletedOfferCount: number }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法删除来源。");

  let deletedOfferCount = 0;
  if (input.deleteOffers) {
    const { count, error: offerError } = await supabase
      .from("raw_offers")
      .delete({ count: "exact" })
      .eq("source_id", input.id);
    if (offerError) throw offerError;
    deletedOfferCount = count || 0;
  }

  const { error } = await supabase.from("sources").delete().eq("id", input.id);
  if (error) throw error;

  return { deletedOfferCount };
}

export async function setSourceOffersHidden(input: {
  sourceId: string;
  hidden: boolean;
  reason?: string | null;
  mode?: AdminOfferHideMode;
}): Promise<{ source: Source; updatedOfferCount: number }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法更新渠道报价。");

  const now = new Date().toISOString();
  const mode = input.mode || "manual";
  let nextSourceNotes: string | null | undefined;
  if (mode !== "temporary") {
    const { data: sourceRow, error: sourceReadError } = await supabase
      .from("sources")
      .select("notes")
      .eq("id", input.sourceId)
      .maybeSingle();
    if (sourceReadError) throw sourceReadError;

    const existingNotes = sourceRow?.notes ? String(sourceRow.notes) : null;
    nextSourceNotes = input.hidden
      ? buildAdminSourceDisableNotes(
          existingNotes,
          input.reason?.trim() || "后台手动下架渠道报价",
          now,
        )
      : stripAdminSourceDisableNotes(existingNotes);
  }
  const source = await updateSourceState({
    id: input.sourceId,
    enabled: mode === "temporary" ? undefined : !input.hidden,
    notes: nextSourceNotes,
  });

  if (input.hidden) {
    const reason = input.reason?.trim() || "线上反馈/临时处理";
    const row = mode === "temporary"
      ? {
          hidden: true,
          status: "out_of_stock",
          source_status: "out_of_stock",
          effective_status: "unavailable",
          freshness_status: "fresh",
          verified_at: now,
          failure_reason: `${ADMIN_TEMPORARY_SOURCE_HIDE_REASON_PREFIX}：${reason}；后续采集重新确认后自动恢复。`,
          last_failed_at: null,
          updated_at: now,
        }
      : {
          hidden: true,
          failure_reason: `${ADMIN_SOURCE_HIDE_REASON_PREFIX}：${reason}`,
          last_failed_at: now,
          updated_at: now,
        };
    let query = supabase
      .from("raw_offers")
      .update(row, { count: "exact" })
      .eq("source_id", input.sourceId)
      .eq("hidden", false);
    if (mode === "temporary") {
      query = query.or(`failure_reason.is.null,failure_reason.not.ilike.${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);
    }
    const { count, error } = await query;

    if (error) throw error;
    return { source, updatedOfferCount: count || 0 };
  }

  const { count, error } = await supabase
    .from("raw_offers")
    .update({
      hidden: false,
      failure_reason: null,
      last_failed_at: null,
      updated_at: now,
    }, { count: "exact" })
    .eq("source_id", input.sourceId)
    .eq("hidden", true)
    .ilike("failure_reason", `${ADMIN_SOURCE_HIDE_REASON_PREFIX}%`);

  if (error) throw error;
  return { source, updatedOfferCount: count || 0 };
}

export async function setRawOfferHidden(input: {
  id: string;
  hidden: boolean;
  reason?: string | null;
  mode?: AdminOfferHideMode;
}): Promise<{ updatedOfferCount: number }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法更新报价。");

  const now = new Date().toISOString();
  const mode = input.mode || "manual";
  const reason = input.reason?.trim() || "线上反馈/临时处理";
  const row = input.hidden
    ? mode === "temporary"
      ? {
          hidden: true,
          status: "out_of_stock",
          source_status: "out_of_stock",
          effective_status: "unavailable",
          freshness_status: "fresh",
          verified_at: now,
          failure_reason: `${ADMIN_TEMPORARY_OFFER_HIDE_REASON_PREFIX}：${reason}；后续采集重新确认后自动恢复。`,
          last_failed_at: null,
          updated_at: now,
        }
      : {
          hidden: true,
          failure_reason: `${ADMIN_OFFER_HIDE_REASON_PREFIX}：${reason}`,
          last_failed_at: now,
          updated_at: now,
        }
    : {
        hidden: false,
        failure_reason: null,
        last_failed_at: null,
        updated_at: now,
      };

  let query = supabase
    .from("raw_offers")
    .update(row, { count: "exact" })
    .eq("id", input.id);
  if (input.hidden && mode === "temporary") {
    query = query.or(`failure_reason.is.null,failure_reason.not.ilike.${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);
  }
  if (!input.hidden) {
    query = query.ilike("failure_reason", `${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);
  }
  const { count, error } = await query;

  if (error) throw error;
  return { updatedOfferCount: count || 0 };
}

export async function upsertRawOffer(input: OfferInput & { sourceId?: string | null }): Promise<RawOffer> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法保存报价。");

  await ensureCanonicalProducts(supabase);

  const sourceId = input.sourceId || slugify(input.sourceName || input.sourceUrl);
  const source = await upsertSource({
    id: sourceId,
    name: input.sourceName,
    entryUrl: input.sourceUrl,
    collectionMethod: "manual",
    shopCreatedAt: input.sourceShopCreatedAt,
    notes: "由后台调试补录或采集助手自动创建。",
  });

  const now = new Date().toISOString();
  const tags = parseTags(input.tags || "");
  const status = normalizeStatus(input.status || "");
  const trustFields = freshnessFields({ method: "manual", status, verifiedAt: now });
  const canonical = classifyOffer(input.sourceTitle, { tags });
  const existingManualHidden = await getManualHiddenOffer(rawOfferInputId(input));
  const offer: RawOffer = {
    id: rawOfferInputId(input),
    sourceId: sourceId || source.id,
    sourceName: input.sourceName,
    sourceStoreName: input.sourceStoreName || input.sourceName,
    sourceTitle: input.sourceTitle,
    price: input.price ?? null,
    listedPrice: input.listedPrice ?? null,
    feeAmount: input.feeAmount ?? null,
    priceBasis: input.priceBasis ?? null,
    currency: input.currency || "CNY",
    status,
    url: input.url,
    tags,
    stockCount: input.stockCount ?? null,
    minOrderQuantity: input.minOrderQuantity ?? null,
    bulkPricingTiers: input.bulkPricingTiers ?? [],
    hidden: Boolean(existingManualHidden),
    canonicalProductId: canonical.id,
    categorySlug: canonical.platform,
    capturedAt: now,
    sourceUpdatedAt: now,
    lastSeenAt: now,
    verifiedAt: now,
    expiresAt: trustFields.expires_at,
    sourcePriority: trustFields.source_priority,
    confidence: trustFields.confidence,
    effectiveStatus: trustFields.effective_status,
    freshnessStatus: trustFields.freshness_status,
    lastFailedAt: existingManualHidden?.lastFailedAt,
    failureReason: existingManualHidden?.failureReason,
  };

  const { error } = await supabase.from("raw_offers").upsert(toRawOfferRow(offer));
  if (error) throw error;

  return offer;
}

export async function upsertRawOffers(
  offers: OfferInput[],
  options: { collectionMethod?: CollectionMethod; checkedAt?: string } = {},
): Promise<RawOfferUpsertResult> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法保存报价。");

  await ensureCanonicalProducts(supabase);

  const collectedRows = [];
  const collectionMethod = options.collectionMethod || "browser";
  const sourceCache = new Map<string, Source>();
  const checkedAt = normalizedDateString(options.checkedAt) || new Date().toISOString();
  const explicitEffectiveStatusById = new Map<string, string>();

  for (const offer of offers) {
    const sourceKey = offer.sourceId || `${offer.sourceName}|${offer.sourceUrl}|${collectionMethod}`;
    let source = sourceCache.get(sourceKey);
    if (!source) {
      source = await upsertSource({
        id: offer.sourceId,
        name: offer.sourceName,
        entryUrl: offer.sourceUrl,
        collectionMethod,
        shopCreatedAt: offer.sourceShopCreatedAt,
        notes: collectionMethod === "http" ? undefined : "由半自动浏览器采集助手创建。",
      });
      sourceCache.set(sourceKey, source);
    }
    const normalizedOffer = {
      ...offer,
      sourceName: source.name,
      sourceStoreName: offer.sourceStoreName || source.name,
    };
    const status = normalizeStatus(offer.status || "");
    const tags = parseTags(offer.tags || "");
    const canonical = classifyOffer(offer.sourceTitle, { tags });
    const trustFields = freshnessFields({ method: collectionMethod, status, verifiedAt: checkedAt });
    const explicitEffectiveStatus = normalizeEffectiveStatus(offer.effectiveStatus || null);
    const effectiveStatus = explicitEffectiveStatus || trustFields.effective_status;
    const freshnessStatus = normalizeFreshnessStatus(offer.freshnessStatus || null) || trustFields.freshness_status;
    const failureReason = normalizeFailureReason(offer.failureReason);
    const id = rawOfferInputId(normalizedOffer);
    if (explicitEffectiveStatus) explicitEffectiveStatusById.set(id, explicitEffectiveStatus);

    const row = toRawOfferRow({
      id,
      sourceId: source.id,
      sourceName: source.name,
      sourceStoreName: normalizedOffer.sourceStoreName,
      sourceTitle: offer.sourceTitle,
      price: offer.price ?? null,
      listedPrice: offer.listedPrice ?? null,
      feeAmount: offer.feeAmount ?? null,
      priceBasis: offer.priceBasis ?? null,
      currency: offer.currency || "CNY",
      status,
      url: offer.url,
      tags,
      stockCount: offer.stockCount ?? null,
      minOrderQuantity: offer.minOrderQuantity ?? null,
      bulkPricingTiers: offer.bulkPricingTiers ?? [],
      hidden: false,
      canonicalProductId: canonical.id,
      categorySlug: canonical.platform,
      capturedAt: checkedAt,
      sourceUpdatedAt: checkedAt,
      lastSeenAt: checkedAt,
      verifiedAt: checkedAt,
      expiresAt: trustFields.expires_at,
      sourcePriority: trustFields.source_priority,
      confidence: trustFields.confidence,
      effectiveStatus,
      freshnessStatus,
      failureReason,
      lastFailedAt: null,
    });
    row.updated_at = checkedAt;
    collectedRows.push(row);
  }

  const rows = dedupeRawOfferRowsById(collectedRows);
  if (!rows.length) return { receivedCount: 0, writtenCount: 0, unchangedCount: 0, refreshedCount: 0, confirmedCount: 0 };

  const manualHiddenById = await getManualHiddenOffersById(rows.map((row) => String(row.id)));
  for (const row of rows) {
    const existing = manualHiddenById.get(String(row.id));
    if (!existing) continue;
    row.hidden = true;
    row.failure_reason = existing.failureReason;
    row.last_failed_at = existing.lastFailedAt;
  }

  const existingById = await getExistingOfferRowsById(rows.map((row) => String(row.id)));
  const changedRows = [];
  const unchangedRows = [];

  for (const row of rows) {
    const existingRow = existingById.get(String(row.id));
    preserveExistingUnavailableStateForImplicitConfirmation(
      row,
      existingRow,
      explicitEffectiveStatusById.get(String(row.id)) || null,
    );
    if (isRawOfferRowUnchanged(row, existingRow)) {
      unchangedRows.push(row);
    } else {
      changedRows.push(row);
    }
  }

  for (const rowChunk of chunks(changedRows, RAW_OFFER_WRITE_CHUNK_SIZE)) {
    const { error } = await supabase.from("raw_offers").upsert(rowChunk);
    if (error) throw error;
  }

  const confirmedCount = await upsertRawOfferConfirmations(rows);

  return {
    receivedCount: rows.length,
    writtenCount: changedRows.length,
    unchangedCount: unchangedRows.length,
    refreshedCount: unchangedRows.length,
    confirmedCount,
  };
}

async function getExistingOfferRowsById(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const supabase = getSupabaseServerClient();
  const output = new Map<string, Record<string, unknown>>();
  if (!supabase || !ids.length) return output;

  for (const idChunk of chunks(Array.from(new Set(ids)), 100)) {
    const { data, error } = await supabase
      .from("raw_offers")
      .select("id,source_id,source_name,source_store_name,source_title,price,listed_price,fee_amount,price_basis,currency,status,source_status,effective_status,freshness_status,expires_at,source_priority,confidence,url,tags,stock_count,min_order_quantity,bulk_pricing_tiers,hidden,canonical_product_id,category_slug,last_seen_at,verified_at,updated_at,last_failed_at,failure_reason")
      .in("id", idChunk);

    if (error) throw error;
    for (const row of data || []) output.set(String(row.id), row as Record<string, unknown>);
  }

  return output;
}

function isRawOfferRowUnchanged(next: Record<string, unknown>, existing?: Record<string, unknown>): boolean {
  if (!existing) return false;

  const keys = [
    "source_id",
    "source_name",
    "source_store_name",
    "source_title",
    "price",
    "listed_price",
    "fee_amount",
    "price_basis",
    "currency",
    "status",
    "source_status",
    "effective_status",
    "freshness_status",
    "url",
    "tags",
    "stock_count",
    "min_order_quantity",
    "bulk_pricing_tiers",
    "hidden",
    "canonical_product_id",
    "category_slug",
    "last_failed_at",
    "failure_reason",
  ];

  return keys.every((key) => comparableValue(next[key]) === comparableValue(existing[key]));
}

function preserveExistingUnavailableStateForImplicitConfirmation(
  next: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  explicitEffectiveStatus: string | null,
) {
  if (!existing || explicitEffectiveStatus) return;

  const existingEffectiveStatus = String(existing.effective_status || "");
  if (!shouldPreserveUnavailableBaseStatus(existing, existingEffectiveStatus)) return;

  const nextEffectiveStatus = String(next.effective_status || "");
  if (nextEffectiveStatus !== "available") return;

  next.source_status = existing.source_status || next.source_status;
  next.effective_status = existing.effective_status;
  next.freshness_status = existing.freshness_status || next.freshness_status;
  next.expires_at = existing.expires_at || next.expires_at;
  next.source_priority = existing.source_priority ?? next.source_priority;
  next.confidence = existing.confidence ?? next.confidence;
  next.last_failed_at = existing.last_failed_at || next.last_failed_at || null;
  next.failure_reason = existing.failure_reason || next.failure_reason || null;
}

function shouldPreserveUnavailableBaseStatus(existing: Record<string, unknown>, effectiveStatus: string): boolean {
  if (effectiveStatus !== "unavailable") return false;
  if (String(existing.status || "") === "out_of_stock") return false;
  if (existing.last_failed_at) return false;

  const reason = String(existing.failure_reason || "");
  return !reason.startsWith("连续采集失败");
}

function normalizeFailureReason(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function dedupeRawOfferRowsById(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const id = String(row.id || "");
    if (!id) continue;
    const existing = byId.get(id);
    byId.set(id, existing ? preferredRawOfferRow(existing, row) : row);
  }

  return Array.from(byId.values());
}

function preferredRawOfferRow(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const statusDiff = offerStatusRank(right.status) - offerStatusRank(left.status);
  if (statusDiff > 0) return right;
  if (statusDiff < 0) return left;

  const rightTitleLength = String(right.source_title || "").length;
  const leftTitleLength = String(left.source_title || "").length;
  if (rightTitleLength > leftTitleLength) return right;

  return left;
}

function offerStatusRank(value: unknown): number {
  if (value === "in_stock") return 4;
  if (value === "low_stock") return 3;
  if (value === "unknown") return 2;
  if (value === "out_of_stock") return 1;
  return 0;
}

async function refreshSeenRawOfferRows(rows: Array<Record<string, unknown>>): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !rows.length) return 0;

  const groups = new Map<string, { ids: string[]; update: Record<string, unknown> }>();
  for (const row of rows) {
    const update = compactUndefined({
      captured_at: row.captured_at,
      source_updated_at: row.source_updated_at,
      last_seen_at: row.last_seen_at,
      verified_at: row.verified_at,
      expires_at: row.expires_at,
      source_status: row.source_status,
      effective_status: row.effective_status,
      freshness_status: row.freshness_status,
      source_priority: row.source_priority,
      confidence: row.confidence,
      updated_at: row.updated_at,
    });
    const key = JSON.stringify(update);
    const current = groups.get(key) || { ids: [], update };
    current.ids.push(String(row.id));
    groups.set(key, current);
  }

  let refreshedCount = 0;
  for (const group of groups.values()) {
    for (const ids of chunks(group.ids, RAW_OFFER_WRITE_CHUNK_SIZE)) {
      const { count, error } = await supabase
        .from("raw_offers")
        .update(group.update, { count: "exact" })
        .in("id", ids);

      if (error) throw error;
      refreshedCount += count || 0;
    }
  }

  return refreshedCount;
}

async function upsertRawOfferConfirmations(rows: Array<Record<string, unknown>>): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !rows.length) return 0;

  const confirmationRows = rows.map(rawOfferConfirmationRow);

  try {
    for (const rowChunk of chunks(confirmationRows, RAW_OFFER_CONFIRMATION_WRITE_CHUNK_SIZE)) {
      const { error } = await supabase
        .from("raw_offer_confirmations")
        .upsert(rowChunk, { onConflict: "raw_offer_id" });

      if (error) throw error;
    }
  } catch (error) {
    if (!isMissingRawOfferConfirmationsTableError(error)) throw error;

    // Compatibility during deploy ordering: once the migration is live,
    // unchanged offers write only to raw_offer_confirmations.
    return refreshSeenRawOfferRows(rows);
  }

  return confirmationRows.length;
}

function rawOfferConfirmationRow(row: Record<string, unknown>): Record<string, unknown> {
  const confirmedAt =
    normalizedDateString(stringOrNull(row.verified_at)) ||
    normalizedDateString(stringOrNull(row.last_seen_at)) ||
    normalizedDateString(stringOrNull(row.captured_at)) ||
    normalizedDateString(stringOrNull(row.updated_at)) ||
    new Date().toISOString();

  return compactUndefined({
    raw_offer_id: String(row.id),
    source_id: row.source_id ? String(row.source_id) : null,
    confirmed_at: confirmedAt,
    captured_at: normalizedDateString(stringOrNull(row.captured_at)) || confirmedAt,
    last_seen_at: normalizedDateString(stringOrNull(row.last_seen_at)) || confirmedAt,
    verified_at: normalizedDateString(stringOrNull(row.verified_at)) || confirmedAt,
    expires_at: normalizedDateString(stringOrNull(row.expires_at)),
    source_status: row.source_status ? String(row.source_status) : String(row.status || "unknown"),
    effective_status: row.effective_status ? String(row.effective_status) : "low_confidence",
    freshness_status: row.freshness_status ? String(row.freshness_status) : "fresh",
    source_priority: row.source_priority,
    confidence: row.confidence,
    price: row.price,
    stock_count: row.stock_count,
    updated_at: confirmedAt,
  });
}

function compactUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizedDateString(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

function isMissingRawOfferConfirmationsTableError(error: unknown): boolean {
  const maybe = error as { code?: string; message?: string } | null;
  return maybe?.code === "42P01" || /raw_offer_confirmations/i.test(String(maybe?.message || ""));
}

function isMissingRawOfferPublicStateError(error: unknown): boolean {
  const maybe = error as { code?: string; message?: string } | null;
  return maybe?.code === "42P01" || /raw_offer_public_state/i.test(String(maybe?.message || ""));
}

function isMissingRawOfferMissingCandidatesTableError(error: unknown): boolean {
  const maybe = error as { code?: string; message?: string } | null;
  return maybe?.code === "42P01" || /raw_offer_missing_candidates/i.test(String(maybe?.message || ""));
}

function isPriorMissingCandidate(candidate: Record<string, unknown>, checkedAt: string): boolean {
  const latestMissingAt = stringOrNull(candidate.latest_missing_at);
  const candidateTime = latestMissingAt ? new Date(latestMissingAt).getTime() : Number.NaN;
  const checkedTime = new Date(checkedAt).getTime();
  if (!Number.isFinite(candidateTime) || !Number.isFinite(checkedTime)) return true;
  return candidateTime < checkedTime;
}

function comparableValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || item === undefined || typeof item !== "object")) {
      return JSON.stringify(value.map(String).sort());
    }
    return JSON.stringify(value.map(stableComparableJsonValue));
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(stableComparableJsonValue(value));
  return String(value);
}

function stableComparableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableComparableJsonValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableComparableJsonValue(item)]),
  );
}

function isSourceRowUnchanged(next: Record<string, unknown>, existing: Record<string, unknown>): boolean {
  const keys = [
    "id",
    "name",
    "base_url",
    "entry_url",
    "collection_method",
    "enabled",
    "notes",
    "collector_kind",
    "shop_created_at",
  ];

  return keys.every((key) => {
    if (!(key in next) && key === "collector_kind") return true;
    if (!(key in next) && key === "shop_created_at") return true;
    return comparableValue(next[key]) === comparableValue(existing[key]);
  });
}

function isCanonicalProductRowUnchanged(next: Record<string, unknown>, existing?: Record<string, unknown>): boolean {
  if (!existing) return false;

  const keys = [
    "id",
    "slug",
    "display_name",
    "platform",
    "product_type",
    "spec",
    "summary",
    "aliases",
    "is_active",
  ];

  return keys.every((key) => comparableValue(next[key]) === comparableValue(existing[key]));
}

async function getManualHiddenOffer(id: string): Promise<{ lastFailedAt?: string | null; failureReason?: string | null } | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("raw_offers")
    .select("last_failed_at,failure_reason")
    .eq("id", id)
    .eq("hidden", true)
    .ilike("failure_reason", `${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`)
    .maybeSingle();

  if (error) throw error;
  return data
    ? {
        lastFailedAt: data.last_failed_at ? String(data.last_failed_at) : null,
        failureReason: data.failure_reason ? String(data.failure_reason) : null,
      }
    : null;
}

async function getManualHiddenOffersById(ids: string[]): Promise<Map<string, { lastFailedAt?: string | null; failureReason?: string | null }>> {
  const supabase = getSupabaseServerClient();
  const output = new Map<string, { lastFailedAt?: string | null; failureReason?: string | null }>();
  if (!supabase || !ids.length) return output;

  for (const idChunk of chunks(Array.from(new Set(ids)), 100)) {
    const { data, error } = await supabase
      .from("raw_offers")
      .select("id,last_failed_at,failure_reason")
      .in("id", idChunk)
      .eq("hidden", true)
      .ilike("failure_reason", `${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);

    if (error) throw error;
    for (const row of data || []) {
      output.set(String(row.id), {
        lastFailedAt: row.last_failed_at ? String(row.last_failed_at) : null,
        failureReason: row.failure_reason ? String(row.failure_reason) : null,
      });
    }
  }

  return output;
}

async function ensureCanonicalProducts(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  if (canonicalProductsEnsurePromise) return canonicalProductsEnsurePromise;

  canonicalProductsEnsurePromise = ensureCanonicalProductsOnce(supabase).finally(() => {
    canonicalProductsEnsurePromise = null;
  });

  return canonicalProductsEnsurePromise;
}

async function ensureCanonicalProductsOnce(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>) {
  const desiredRows = canonicalCatalog.map((product) => ({
      id: product.id,
      slug: product.slug,
      display_name: product.displayName,
      platform: product.platform,
      product_type: product.productType,
      spec: product.spec,
      summary: product.summary,
      aliases: product.aliases,
      is_active: true,
    }));

  const { data, error: readError } = await supabase
    .from("canonical_products")
    .select("id,slug,display_name,platform,product_type,spec,summary,aliases,is_active");
  if (readError) throw readError;

  const existingById = new Map((data || []).map((row) => [String(row.id), row as Record<string, unknown>]));
  const changedRows = desiredRows
    .filter((row) => !isCanonicalProductRowUnchanged(row, existingById.get(String(row.id))))
    .map((row) => ({
      ...row,
      updated_at: new Date().toISOString(),
    }));

  if (!changedRows.length) return;

  const { error } = await supabase.from("canonical_products").upsert(changedRows);

  if (error) throw error;
}

export function rawOfferInputId(offer: Pick<OfferInput, "sourceName" | "sourceStoreName" | "sourceTitle" | "url">): string {
  return stableOfferInputId(offer);
}

export async function recordSourceCollectionResult(input: {
  sourceId: string;
  status: "success" | "partial" | "failed" | "skipped";
  checkedAt: string;
  message?: string | null;
  seenOfferIds?: string[];
  fullSnapshot?: boolean;
  hasSellableOffers?: boolean;
  hideMissingOffersImmediately?: boolean;
}): Promise<{ changedOfferCount: number }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法记录来源采集状态。");

  let { data: existing, error: existingError } = await supabase
    .from("sources")
    .select("collector_kind,consecutive_failures,last_success_at,availability_status,out_of_stock_since,consecutive_out_of_stock_snapshots")
    .eq("id", input.sourceId)
    .maybeSingle();

  let availabilityObservationColumnsAvailable = true;
  if (isMissingSourceAvailabilityObservationColumnError(existingError)) {
    availabilityObservationColumnsAvailable = false;
    const compatibilityResult = await supabase
      .from("sources")
      .select("collector_kind,consecutive_failures,last_success_at")
      .eq("id", input.sourceId)
      .maybeSingle();
    existing = compatibilityResult.data as typeof existing;
    existingError = compatibilityResult.error;
  }
  if (existingError) throw existingError;

  // Skip failure if another channel succeeded recently (within 1 hour)
  if (input.status === "failed" && existing?.last_success_at) {
    const ageMs = Date.now() - new Date(existing.last_success_at).getTime();
    if (ageMs < 60 * 60 * 1000) return { changedOfferCount: 0 };
  }

  const previousFailures = Number(existing?.consecutive_failures || 0);
  if (input.status === "skipped") {
    return { changedOfferCount: 0 };
  }
  if (input.status === "failed" && isCollectorWritebackFailureMessage(input.message)) {
    return { changedOfferCount: 0 };
  }

  const consecutiveFailures = input.status === "failed" ? previousFailures + 1 : 0;
  const healthStatus =
    input.status === "success"
      ? "healthy"
      : input.status === "partial"
        ? "partial"
        : consecutiveFailures >= STALE_OFFER_FAILURE_THRESHOLD
          ? "failing"
          : "retrying";

  const completeAvailabilitySnapshot = input.status === "success" && input.fullSnapshot === true && typeof input.hasSellableOffers === "boolean";
  const sourceUpdate: Record<string, unknown> = {
    health_status: healthStatus,
    last_checked_at: input.checkedAt,
    last_success_at: input.status === "failed" ? existing?.last_success_at || null : input.checkedAt,
    consecutive_failures: consecutiveFailures,
    last_error: input.status === "failed" ? input.message || "采集失败，等待重试。" : null,
    updated_at: input.checkedAt,
  };
  if (availabilityObservationColumnsAvailable && completeAvailabilitySnapshot) {
    Object.assign(sourceUpdate, nextSourceAvailabilityObservation(existing, input.checkedAt, input.hasSellableOffers));
  }

  const { error: sourceError } = await supabase
    .from("sources")
    .update(sourceUpdate)
    .eq("id", input.sourceId);

  if (sourceError) throw sourceError;

  if (input.status === "failed") {
    const changedOfferCount = await expireStaleOffersAfterRepeatedFailures(
      input.sourceId,
      input.checkedAt,
      input.message || null,
      consecutiveFailures,
      existing?.collector_kind === "shopApi"
        ? SHOP_API_STALE_OFFER_FAILURE_AGE_MS
        : DEFAULT_STALE_OFFER_FAILURE_AGE_MS,
    );
    return { changedOfferCount };
  }

  const seenOfferIds = Array.isArray(input.seenOfferIds) ? uniqueOfferIds(input.seenOfferIds) : null;
  let changedOfferCount = seenOfferIds?.length
    ? await clearOfferCollectionFailureForSeenOffers(input.sourceId, seenOfferIds)
    : 0;

  if (seenOfferIds?.length) {
    await clearMissingOfferCandidatesForSeenOffers(input.sourceId, seenOfferIds, input.checkedAt);
  }

  if (input.status === "success" && input.fullSnapshot && seenOfferIds) {
    changedOfferCount += await reconcileMissingOffersFromFullSnapshot(
      input.sourceId,
      seenOfferIds,
      input.checkedAt,
      { hideImmediately: input.hideMissingOffersImmediately === true },
    );
  }

  return { changedOfferCount };
}

function isCollectorWritebackFailureMessage(message: string | null | undefined): boolean {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("记录采集结果失败") ||
    text.includes("upload failed after") ||
    text.includes("crawl-log upload failed")
  );
}

function isMissingSourceAvailabilityObservationColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const text = [candidate.message, candidate.details, candidate.hint].map((value) => String(value || "")).join(" ");
  return String(candidate.code || "") === "42703" || /availability_status|out_of_stock_since|consecutive_out_of_stock_snapshots/.test(text);
}

async function expireStaleOffersAfterRepeatedFailures(
  sourceId: string,
  failedAt: string,
  message: string | null,
  consecutiveFailures: number,
  staleAgeMs: number,
): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return 0;
  if (consecutiveFailures < STALE_OFFER_FAILURE_THRESHOLD) return 0;

  const failureReason = message || "本次采集失败，旧报价暂不更新。";
  const staleBefore = new Date(new Date(failedAt).getTime() - staleAgeMs).toISOString();
  const ids = await selectStaleOfferIdsAfterFailures(supabase, sourceId, staleBefore);
  if (!ids.length) return 0;

  let changedCount = 0;
  for (const chunk of chunks(ids, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const { count, error: expireError } = await supabase
      .from("raw_offers")
      .update({
        effective_status: "unavailable",
        freshness_status: "expired",
        last_failed_at: failedAt,
        failure_reason: `连续采集失败 ${consecutiveFailures} 次：${failureReason}`,
        updated_at: failedAt,
      }, { count: "exact" })
      .eq("source_id", sourceId)
      .in("id", chunk)
      .or(`failure_reason.is.null,failure_reason.not.ilike.${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);

    if (expireError) throw expireError;
    changedCount += count || 0;
  }

  return changedCount;
}

async function clearOfferCollectionFailureForSeenOffers(sourceId: string, seenOfferIds: string[]): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return 0;
  const uniqueIds = uniqueOfferIds(seenOfferIds);
  if (!uniqueIds.length) return 0;

  let changedCount = 0;
  for (const ids of chunks(uniqueIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const { count, error } = await supabase
      .from("raw_offers")
      .update({
        last_failed_at: null,
        failure_reason: null,
      }, { count: "exact" })
      .eq("source_id", sourceId)
      .in("id", ids)
      .or("last_failed_at.not.is.null,failure_reason.not.is.null")
      .or(`failure_reason.is.null,failure_reason.not.ilike.${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);

    if (error) throw error;
    changedCount += count || 0;
  }

  return changedCount;
}

async function clearMissingOfferCandidatesForSeenOffers(
  sourceId: string,
  seenOfferIds: string[],
  seenAt: string,
): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return 0;
  const uniqueIds = uniqueOfferIds(seenOfferIds);
  if (!uniqueIds.length) return 0;

  let changedCount = 0;
  for (const ids of chunks(uniqueIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const { count, error } = await supabase
      .from("raw_offer_missing_candidates")
      .update({
        status: "resolved_seen",
        latest_seen_run_at: seenAt,
        reason: null,
        updated_at: seenAt,
      }, { count: "exact" })
      .eq("source_id", sourceId)
      .eq("status", "pending")
      .in("raw_offer_id", ids);

    if (error) {
      if (isMissingRawOfferMissingCandidatesTableError(error)) return changedCount;
      throw error;
    }
    changedCount += count || 0;
  }

  return changedCount;
}

async function reconcileMissingOffersFromFullSnapshot(
  sourceId: string,
  seenOfferIds: string[],
  checkedAt: string,
  options: { hideImmediately?: boolean } = {},
): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return 0;

  const seen = new Set(seenOfferIds);
  const data = await selectPotentialMissingOfferRows(supabase, sourceId, checkedAt, seenOfferIds.length);

  const missingIds = (data || [])
    .map((row) => String(row.id))
    .filter((id) => !seen.has(id))
    .slice(0, MAX_MISSING_OFFERS_TO_HIDE_PER_COLLECTION);

  if (!missingIds.length) return 0;

  const candidates = await selectMissingOfferCandidateRows(supabase, sourceId, missingIds);
  if (!candidates) return 0;

  if (options.hideImmediately) {
    const changedCount = await hideMissingOfferRows(sourceId, missingIds, checkedAt, MISSING_OFFER_SYSTEM_HIDE_REASON);
    if (missingIds.length) {
      await upsertMissingOfferCandidatesHidden(sourceId, missingIds, checkedAt, 1, MISSING_OFFER_SYSTEM_HIDE_REASON);
    }
    return changedCount;
  }

  const candidateByOfferId = new Map(candidates.map((row) => [String(row.raw_offer_id), row]));
  const idsToHide: string[] = [];
  const idsToStage: string[] = [];

  for (const id of missingIds) {
    const candidate = candidateByOfferId.get(id);
    if (
      candidate?.status === "pending" &&
      Number(candidate.missing_count || 0) >= 1 &&
      isPriorMissingCandidate(candidate, checkedAt)
    ) {
      idsToHide.push(id);
    } else {
      idsToStage.push(id);
    }
  }

  let changedCount = 0;
  if (idsToStage.length) {
    const staged = await stageMissingOfferCandidates(sourceId, idsToStage, checkedAt);
    if (!staged && !idsToHide.length) return 0;
    if (staged) {
      changedCount += await markMissingOfferRowsUnavailable(sourceId, idsToStage, checkedAt);
    }
  }

  changedCount += await hideMissingOfferRows(
    sourceId,
    idsToHide,
    checkedAt,
    MISSING_OFFER_CONFIRMED_SYSTEM_HIDE_REASON,
  );

  if (idsToHide.length) {
    await markMissingOfferCandidatesHidden(sourceId, idsToHide, checkedAt, MISSING_OFFER_CONFIRMED_SYSTEM_HIDE_REASON);
  }

  return changedCount;
}

async function markMissingOfferRowsUnavailable(
  sourceId: string,
  rawOfferIds: string[],
  checkedAt: string,
): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !rawOfferIds.length) return 0;

  let changedCount = 0;
  for (const ids of chunks(rawOfferIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const { count, error } = await supabase
      .from("raw_offers")
      .update({
        effective_status: "unavailable",
        freshness_status: "aging",
        last_failed_at: null,
        failure_reason: MISSING_OFFER_CANDIDATE_REASON,
        updated_at: checkedAt,
      }, { count: "exact" })
      .eq("source_id", sourceId)
      .eq("hidden", false)
      .neq("effective_status", "unavailable")
      .in("id", ids)
      .or(`failure_reason.is.null,failure_reason.not.ilike.${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);

    if (error) throw error;
    changedCount += count || 0;
  }

  return changedCount;
}

async function hideMissingOfferRows(
  sourceId: string,
  rawOfferIds: string[],
  checkedAt: string,
  reason: string,
): Promise<number> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !rawOfferIds.length) return 0;

  let changedCount = 0;
  for (const ids of chunks(rawOfferIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const { count, error: updateError } = await supabase
      .from("raw_offers")
      .update({
        hidden: true,
        status: "out_of_stock",
        source_status: "out_of_stock",
        effective_status: "unavailable",
        freshness_status: "fresh",
        verified_at: checkedAt,
        last_failed_at: null,
        failure_reason: reason,
        updated_at: checkedAt,
      }, { count: "exact" })
      .eq("source_id", sourceId)
      .eq("hidden", false)
      .in("id", ids)
      .or(`failure_reason.is.null,failure_reason.not.ilike.${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`);

    if (updateError) throw updateError;
    changedCount += count || 0;
  }

  return changedCount;
}

async function selectMissingOfferCandidateRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  sourceId: string,
  rawOfferIds: string[],
): Promise<Array<Record<string, unknown>> | null> {
  const output: Array<Record<string, unknown>> = [];
  for (const ids of chunks(rawOfferIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("raw_offer_missing_candidates")
      .select("raw_offer_id,latest_missing_at,missing_count,status")
      .eq("source_id", sourceId)
      .in("raw_offer_id", ids);

    if (error) {
      if (isMissingRawOfferMissingCandidatesTableError(error)) return null;
      throw error;
    }
    output.push(...((data || []) as Array<Record<string, unknown>>));
  }
  return output;
}

async function stageMissingOfferCandidates(
  sourceId: string,
  rawOfferIds: string[],
  checkedAt: string,
): Promise<boolean> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return false;

  for (const ids of chunks(rawOfferIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const rows = ids.map((id) => ({
      raw_offer_id: id,
      source_id: sourceId,
      first_missing_at: checkedAt,
      latest_missing_at: checkedAt,
      missing_count: 1,
      status: "pending",
      reason: MISSING_OFFER_CANDIDATE_REASON,
      updated_at: checkedAt,
    }));
    const { error } = await supabase
      .from("raw_offer_missing_candidates")
      .upsert(rows, { onConflict: "raw_offer_id" });

    if (error) {
      if (isMissingRawOfferMissingCandidatesTableError(error)) return false;
      throw error;
    }
  }

  return true;
}

async function markMissingOfferCandidatesHidden(
  sourceId: string,
  rawOfferIds: string[],
  checkedAt: string,
  reason: string = MISSING_OFFER_CONFIRMED_SYSTEM_HIDE_REASON,
): Promise<void> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  for (const ids of chunks(rawOfferIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const { error } = await supabase
      .from("raw_offer_missing_candidates")
      .update({
        status: "resolved_hidden",
        latest_missing_at: checkedAt,
        missing_count: 2,
        reason,
        updated_at: checkedAt,
      })
      .eq("source_id", sourceId)
      .in("raw_offer_id", ids);

    if (error) {
      if (isMissingRawOfferMissingCandidatesTableError(error)) return;
      throw error;
    }
  }
}

async function upsertMissingOfferCandidatesHidden(
  sourceId: string,
  rawOfferIds: string[],
  checkedAt: string,
  missingCount: number,
  reason: string,
): Promise<void> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  for (const ids of chunks(rawOfferIds, MISSING_OFFER_HIDE_CHUNK_SIZE)) {
    const rows = ids.map((id) => ({
      raw_offer_id: id,
      source_id: sourceId,
      first_missing_at: checkedAt,
      latest_missing_at: checkedAt,
      missing_count: missingCount,
      status: "resolved_hidden",
      reason,
      updated_at: checkedAt,
    }));
    const { error } = await supabase
      .from("raw_offer_missing_candidates")
      .upsert(rows, { onConflict: "raw_offer_id" });

    if (error) {
      if (isMissingRawOfferMissingCandidatesTableError(error)) return;
      throw error;
    }
  }
}

async function selectStaleOfferIdsAfterFailures(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  sourceId: string,
  staleBefore: string,
): Promise<string[]> {
  for (const tableName of ["raw_offer_public_state", "raw_offers"]) {
    const { data, error } = await supabase
      .from(tableName)
      .select("id")
      .eq("source_id", sourceId)
      .or(`failure_reason.is.null,failure_reason.not.ilike.${ADMIN_MANUAL_HIDE_REASON_PREFIX}%`)
      .or(`verified_at.is.null,verified_at.lt.${staleBefore}`)
      .order("verified_at", { ascending: true, nullsFirst: true })
      .limit(MAX_STALE_OFFERS_TO_EXPIRE_PER_FAILURE);

    if (!error) return (data || []).map((row) => String(row.id)).filter(Boolean);
    if (tableName === "raw_offer_public_state" && isMissingRawOfferPublicStateError(error)) continue;
    throw error;
  }

  return [];
}

async function selectPotentialMissingOfferRows(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  sourceId: string,
  checkedAt: string,
  seenOfferCount: number,
): Promise<Array<Record<string, unknown>>> {
  for (const tableName of ["raw_offer_public_state", "raw_offers"]) {
    const { data, error } = await supabase
      .from(tableName)
      .select("id,last_seen_at")
      .eq("source_id", sourceId)
      .eq("hidden", false)
      .or(`last_seen_at.is.null,last_seen_at.lt.${checkedAt}`)
      .order("last_seen_at", { ascending: true, nullsFirst: true })
      .limit(MAX_MISSING_OFFERS_TO_HIDE_PER_COLLECTION + seenOfferCount);

    if (!error) return (data || []) as Array<Record<string, unknown>>;
    if (tableName === "raw_offer_public_state" && isMissingRawOfferPublicStateError(error)) continue;
    throw error;
  }

  return [];
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function uniqueOfferIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map(String).filter(Boolean)));
}

export function toRawOfferRow(offer: RawOffer) {
  return {
    id: offer.id,
    source_id: offer.sourceId,
    source_name: offer.sourceName,
    source_store_name: offer.sourceStoreName,
    source_title: offer.sourceTitle,
    price: offer.price,
    listed_price: offer.listedPrice,
    fee_amount: offer.feeAmount,
    price_basis: offer.priceBasis,
    currency: offer.currency,
    status: offer.status,
    url: normalizeOfferUrlForStorage(offer.url),
    tags: offer.tags,
    stock_count: offer.stockCount,
    min_order_quantity: offer.minOrderQuantity ?? null,
    bulk_pricing_tiers: offer.bulkPricingTiers ?? [],
    hidden: offer.hidden ?? false,
    canonical_product_id: offer.canonicalProductId,
    category_slug: offer.categorySlug,
    captured_at: offer.capturedAt,
    source_updated_at: offer.sourceUpdatedAt,
    last_seen_at: offer.lastSeenAt || offer.capturedAt,
    verified_at: offer.verifiedAt,
    expires_at: offer.expiresAt,
    source_priority: offer.sourcePriority,
    confidence: offer.confidence,
    source_status: offer.status,
    effective_status: offer.effectiveStatus,
    freshness_status: offer.freshnessStatus,
    last_failed_at: offer.lastFailedAt,
    failure_reason: offer.failureReason,
    updated_at: new Date().toISOString(),
  };
}

function normalizeOfferUrlForStorage(value: string): string {
  const parsed = safeUrl(value);
  if (!parsed) return value;

  const commodityId = parsed.searchParams.get("commodity");
  if (!commodityId || !collectorHostsForKind("kami").has(normalizeHostname(parsed.hostname))) return value;

  parsed.pathname = `/item/${encodeURIComponent(commodityId)}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function deriveBaseUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function normalizeSourceEntryUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = normalizeHostname(parsed.hostname);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function sourceEntryUrlCandidates(value: string | null | undefined): string[] {
  const normalized = normalizeSourceEntryUrl(value);
  if (!normalized) return [];

  const candidates = new Set<string>([normalized]);
  if (normalized.endsWith("/")) candidates.add(normalized.replace(/\/+$/, ""));
  else candidates.add(`${normalized}/`);
  return [...candidates].filter(Boolean);
}

async function findSourceRowByEntryUrl(entryUrl: string | null | undefined): Promise<Record<string, unknown> | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const candidates = sourceEntryUrlCandidates(entryUrl);
  if (!candidates.length) return null;

  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .in("entry_url", candidates)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

function mapSubmissionRow(row: Record<string, unknown>): ChannelSubmission {
  const parsedMeta = row.parsed_meta && typeof row.parsed_meta === "object"
    ? (row.parsed_meta as Record<string, unknown>)
    : {};
  const duplicateColumnPresent = Object.prototype.hasOwnProperty.call(row, "duplicate_of_submission_id");
  const duplicateOfSubmissionId = duplicateColumnPresent
    ? (row.duplicate_of_submission_id ? String(row.duplicate_of_submission_id) : null)
    : stringValue(parsedMeta.duplicate_pending_submission_id);
  const safeDuplicateId = duplicateOfSubmissionId && duplicateOfSubmissionId !== String(row.id)
    ? duplicateOfSubmissionId
    : null;
  const storedClassification = row.preclassification && typeof row.preclassification === "object" && !Array.isArray(row.preclassification)
    ? row.preclassification as ChannelSubmission["preclassification"]
    : null;
  return {
    id: String(row.id),
    url: String(row.url || ""),
    name: row.name ? String(row.name) : null,
    contact: row.contact ? String(row.contact) : null,
    notes: row.notes ? String(row.notes) : null,
    parsedTitle: row.parsed_title ? String(row.parsed_title) : null,
    parsedMeta,
    normalizedUrl: row.normalized_url ? String(row.normalized_url) : stringValue(parsedMeta.normalized_url),
    canonicalChannelKey: row.canonical_channel_key
      ? String(row.canonical_channel_key)
      : channelSubmissionKey(stringValue(parsedMeta.canonical_source_url) || String(row.url || "")),
    reviewStage: String(row.review_stage || parsedMeta.review_stage || "submitted") as SubmissionReviewStage,
    duplicateOfSubmissionId: safeDuplicateId,
    preclassification: storedClassification && typeof storedClassification.kind === "string" ? storedClassification : null,
    status: String(row.status || "pending") as SubmissionStatus,
    reviewerNote: row.reviewer_note ? String(row.reviewer_note) : null,
    approvedSourceId: row.approved_source_id ? String(row.approved_source_id) : null,
    submitterIp: row.submitter_ip ? String(row.submitter_ip) : null,
    createdAt: String(row.created_at || new Date().toISOString()),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  };
}

function mapOfferFeedbackRow(row: Record<string, unknown>): OfferFeedback {
  const reason = String(row.reason || "other") as OfferFeedbackReason;

  return {
    id: String(row.id),
    feedbackScope: normalizeOfferFeedbackScope(row.feedback_scope),
    productId: row.product_id ? String(row.product_id) : null,
    productSlug: row.product_slug ? String(row.product_slug) : null,
    productName: row.product_name ? String(row.product_name) : null,
    offerId: row.offer_id ? String(row.offer_id) : null,
    sourceId: row.source_id ? String(row.source_id) : null,
    sourceName: row.source_name ? String(row.source_name) : null,
    sourceTitle: row.source_title ? String(row.source_title) : null,
    offerUrl: row.offer_url ? String(row.offer_url) : null,
    offerPrice: row.offer_price === null || row.offer_price === undefined ? null : Number(row.offer_price),
    offerCurrency: row.offer_currency ? String(row.offer_currency) : null,
    offerStatus: row.offer_status ? String(row.offer_status) as OfferStatus : null,
    offerCapturedAt: row.offer_captured_at ? String(row.offer_captured_at) : null,
    offerSourceUpdatedAt: row.offer_source_updated_at ? String(row.offer_source_updated_at) : null,
    offerLastSeenAt: row.offer_last_seen_at ? String(row.offer_last_seen_at) : null,
    reason,
    issueDimension: normalizeOfferFeedbackIssueDimension(row.issue_dimension),
    expectedProductId: row.expected_product_id ? String(row.expected_product_id) : null,
    classificationVersion: row.classification_version ? String(row.classification_version) : null,
    classificationResult: row.classification_result && typeof row.classification_result === "object" ? row.classification_result as Record<string, unknown> : null,
    userExpectedAction: normalizeOfferFeedbackUserExpectedAction(row.user_expected_action),
    suggestedAction: normalizeOfferFeedbackSuggestedAction(row.suggested_action, reason),
    evidenceText: row.evidence_text ? String(row.evidence_text) : null,
    evidenceUrls: parseFeedbackEvidenceUrls(row.evidence_urls),
    aiReviewResult: row.ai_review_result && typeof row.ai_review_result === "object" ? row.ai_review_result as Record<string, unknown> : null,
    riskPrecheck: parseOfferFeedbackRiskPrecheck(row.ai_review_result),
    verificationStatus: normalizeOfferFeedbackVerificationStatus(row.verification_status),
    verificationResult: normalizeOfferFeedbackVerificationResult(row.verification_result),
    verifiedAt: row.verification_checked_at ? String(row.verification_checked_at) : null,
    verificationMessage: row.verification_message ? String(row.verification_message) : verificationMessageFromAiReview(row.ai_review_result),
    createdCollectionJobId: row.created_collection_job_id ? String(row.created_collection_job_id) : collectionJobIdFromAiReview(row.ai_review_result),
    notes: row.notes ? String(row.notes) : null,
    contact: row.contact ? String(row.contact) : null,
    status: String(row.status || "pending") as OfferFeedbackStatus,
    publicStatus: normalizeOfferFeedbackPublicStatus(row.public_status),
    withdrawnAt: row.withdrawn_at ? String(row.withdrawn_at) : null,
    withdrawReason: row.withdraw_reason ? String(row.withdraw_reason) : null,
    reviewerNote: row.reviewer_note ? String(row.reviewer_note) : null,
    submitterIp: row.submitter_ip ? String(row.submitter_ip) : null,
    userId: row.user_id ? String(row.user_id) : null,
    userEmail: row.user_email ? String(row.user_email) : null,
    userDisplayName: row.user_display_name ? String(row.user_display_name) : null,
    createdAt: String(row.created_at || new Date().toISOString()),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  };
}

function normalizeOfferFeedbackScope(value: unknown): OfferFeedbackScope {
  return value === "merchant" ? "merchant" : "offer";
}

function normalizeOfferFeedbackIssueDimension(value: unknown): OfferFeedbackIssueDimension | null {
  if (value === "product_category" || value === "filter_tag" || value === "source_placement" || value === "unsure") return value;
  return null;
}

function normalizeOfferFeedbackPublicStatus(value: unknown): OfferFeedbackPublicStatus {
  if (value === "pending_review" || value === "public" || value === "withdrawn" || value === "not_public") {
    return value;
  }
  return "not_public";
}

function parseOfferFeedbackRiskPrecheck(value: unknown): OfferFeedbackRiskPrecheck | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw = record.riskPrecheck;
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const status = item.status === "ready" || item.status === "skipped" || item.status === "failed" ? item.status : null;
  const riskCategory = item.riskCategory === "description_mismatch" ||
    item.riskCategory === "fraud" ||
    item.riskCategory === "bad_source" ||
    item.riskCategory === "aftersales_shipping"
    ? item.riskCategory
    : null;
  if (!status || !riskCategory) return null;

  return {
    status,
    provider: typeof item.provider === "string" ? item.provider : "unknown",
    model: typeof item.model === "string" ? item.model : "unknown",
    reviewedAt: typeof item.reviewedAt === "string" ? item.reviewedAt : "",
    canShowPublicly: item.canShowPublicly === true,
    riskLevel: item.riskLevel === "low" || item.riskLevel === "medium" || item.riskLevel === "high" ? item.riskLevel : "medium",
    riskScope: item.riskScope === "source" || item.riskScope === "mixed" || item.riskScope === "offer" ? item.riskScope : "offer",
    riskCategory,
    confidence: numberValue(item.confidence) ?? 0,
    abuseRisk: item.abuseRisk === "low" || item.abuseRisk === "medium" || item.abuseRisk === "high" ? item.abuseRisk : "medium",
    evidenceQuality: item.evidenceQuality === "none" || item.evidenceQuality === "low" || item.evidenceQuality === "medium" || item.evidenceQuality === "high" ? item.evidenceQuality : "low",
    publicSummary: typeof item.publicSummary === "string" ? item.publicSummary : "",
    offerSummary: typeof item.offerSummary === "string" ? item.offerSummary : null,
    offerPublicSummary: typeof item.offerPublicSummary === "string" ? item.offerPublicSummary : null,
    sourceCanShowPublicly: item.sourceCanShowPublicly === true,
    sourcePublicSummary: typeof item.sourcePublicSummary === "string" ? item.sourcePublicSummary : null,
    imageEvidenceCount: numberValue(item.imageEvidenceCount) ?? undefined,
    imageEvidenceUsedCount: numberValue(item.imageEvidenceUsedCount) ?? undefined,
    publicHidden: item.publicHidden === true,
    publicHiddenAt: typeof item.publicHiddenAt === "string" ? item.publicHiddenAt : null,
    publicHiddenReason: typeof item.publicHiddenReason === "string" ? item.publicHiddenReason : null,
    privateReason: typeof item.privateReason === "string" ? item.privateReason : "",
    expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : null,
    error: typeof item.error === "string" ? item.error : undefined,
  };
}

function normalizeOfferFeedbackUserExpectedAction(value: unknown): OfferFeedbackUserExpectedAction {
  return value === "hide_offer" || value === "hide_source" || value === "unsure" || value === "recheck"
    ? value
    : "unsure";
}

function normalizeOfferFeedbackSuggestedAction(value: unknown, reason: OfferFeedbackReason): OfferFeedbackSuggestedAction {
  if (
    value === "recollect" ||
    value === "reclassify" ||
    value === "hide_offer" ||
    value === "hide_source" ||
    value === "todo" ||
    value === "ignore"
  ) {
    return value;
  }

  return inferOfferFeedbackSuggestedAction(reason);
}

function inferOfferFeedbackSuggestedAction(reason: OfferFeedbackReason): OfferFeedbackSuggestedAction {
  return inferSuggestedActionForFeedback(reason);
}

function normalizeOfferFeedbackVerificationStatus(value: unknown): OfferFeedbackVerificationStatus {
  return value === "not_needed" ||
    value === "pending" ||
    value === "running" ||
    value === "auto_fixed" ||
    value === "recollection_created" ||
    value === "manual_review" ||
    value === "failed"
    ? value
    : "not_needed";
}

function normalizeOfferFeedbackVerificationResult(value: unknown): OfferFeedbackVerificationResult | null {
  return value === "offer_changed" ||
    value === "item_removed" ||
    value === "out_of_stock" ||
    value === "still_available" ||
    value === "recollection_created" ||
    value === "inconclusive" ||
    value === "blocked"
    ? value
    : null;
}

function verificationMessageFromAiReview(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const message = (value as Record<string, unknown>).verificationMessage;
  return typeof message === "string" && message.trim() ? message : null;
}

function collectionJobIdFromAiReview(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const jobId = (value as Record<string, unknown>).createdCollectionJobId;
  return typeof jobId === "string" && jobId.trim() ? jobId : null;
}

function parseFeedbackEvidenceUrls(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? tryParseJsonArray(value)
      : [];

  return items
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0)
    .slice(0, 10);
}

function sanitizeFeedbackEvidenceUrls(value: string[]): string[] {
  return value
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => {
      try {
        const url = new URL(item);
        return url.protocol === "http:" || url.protocol === "https:" || isFeedbackEvidenceReference(item);
      } catch {
        return false;
      }
    })
    .slice(0, 10);
}

function tryParseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapSiteFeedbackRow(row: Record<string, unknown>): SiteFeedback {
  return {
    id: String(row.id),
    type: String(row.type || "other") as SiteFeedbackType,
    message: String(row.message || ""),
    contact: row.contact ? String(row.contact) : null,
    pageUrl: row.page_url ? String(row.page_url) : null,
    status: String(row.status || "pending") as SiteFeedbackStatus,
    reviewerNote: row.reviewer_note ? String(row.reviewer_note) : null,
    submitterIp: row.submitter_ip ? String(row.submitter_ip) : null,
    createdAt: String(row.created_at || new Date().toISOString()),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  };
}

function mapSourceRow(row: Record<string, unknown>): Source {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    baseUrl: row.base_url ? String(row.base_url) : null,
    entryUrl: String(row.entry_url || row.base_url || ""),
    collectionMethod: String(row.collection_method || "http") as CollectionMethod,
    collectorKind: normalizeCollectorKind(row.collector_kind),
    buyerFeeRate: row.buyer_fee_rate === null || row.buyer_fee_rate === undefined ? null : Number(row.buyer_fee_rate),
    buyerFeePaymentMethod: row.buyer_fee_payment_method ? String(row.buyer_fee_payment_method) as Source["buyerFeePaymentMethod"] : null,
    buyerFeeStrategy: row.buyer_fee_strategy === "manual_verified" ? "manual_verified" : null,
    collectionGroup: row.collection_group === "vip_15m" ? "vip_15m" : "automatic",
    enabled: Boolean(row.enabled),
    notes: row.notes ? String(row.notes) : null,
    healthStatus: row.health_status ? String(row.health_status) as Source["healthStatus"] : null,
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
    consecutiveFailures:
      row.consecutive_failures === null || row.consecutive_failures === undefined
        ? null
        : Number(row.consecutive_failures),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: row.created_at ? String(row.created_at) : null,
    shopCreatedAt: row.shop_created_at ? String(row.shop_created_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

const MAX_FETCH_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const SHOP_API_TIMEOUT_MS = 8000;
const CURRENCY_PRICE_RE = /[¥￥]\s*\d+(?:\.\d{1,2})?/;
export async function parseSubmissionMetadata(rawUrl: string, context: SubmissionParseContext = {}): Promise<{
  url: string;
  parsedTitle: string | null;
  parsedMeta: Record<string, unknown>;
}> {
  const meta: Record<string, unknown> = {};
  let parsedTitle: string | null = null;
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("URL 格式不正确。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https。");
  }

  meta.domain = parsed.host;
  const initialSourceNameHint = context.submittedName || null;
  Object.assign(meta, analyzeSubmissionUrl(parsed, initialSourceNameHint));

  Object.assign(meta, await resolveSubmittedSource(parsed, initialSourceNameHint, null, context));
  parsedTitle = submittedProductTitleFromMeta(meta);
  if (parsedTitle) {
    Object.assign(meta, classifySubmissionTitleMeta(parsedTitle));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await safeFetch(parsed.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "AIPriceHubBot/1.0 (+https://priceai.cc)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    meta.http_status = response.status;
    if (!response.ok) {
      meta.parse_error = `HTTP ${response.status}`;
      return { url: parsed.toString(), parsedTitle, parsedMeta: await enrichSubmissionReviewMeta(meta, context) };
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return { url: parsed.toString(), parsedTitle, parsedMeta: await enrichSubmissionReviewMeta(meta, context) };
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    let received = 0;
    let html = "";
    while (received < MAX_FETCH_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (received >= MAX_FETCH_BYTES) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      parsedTitle = titleMatch[1]
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    }

    if (parsedTitle) {
      Object.assign(meta, classifySubmissionTitleMeta(parsedTitle));
      if (!stringValue(meta.canonical_source_url)) {
        Object.assign(meta, await resolveSubmittedSource(parsed, parsedTitle, html, context));
      }
    }
    Object.assign(meta, refineSubmissionCollectorFromHtml(parsed, html, meta));
  } catch (error) {
    meta.parse_error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  return { url: parsed.toString(), parsedTitle, parsedMeta: await enrichSubmissionReviewMeta(meta, context) };
}

function classifySubmissionTitleMeta(title: string): Record<string, unknown> {
  const canonical = classifyOffer(title);
  return {
    canonical_product_id: canonical.id,
    platform: canonical.platform,
    product_type: canonical.productType,
  };
}

function submittedProductTitleFromMeta(meta: Record<string, unknown>): string | null {
  const preview = meta.submitted_product_preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  return stringValue((preview as Record<string, unknown>).title);
}

function analyzeSubmissionUrl(parsed: URL, parsedTitle: string | null): Record<string, unknown> {
  const host = normalizeHostname(parsed.hostname);
  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const shopToken = getShopToken(parsed.pathname);
  const submittedUrlType = getSubmittedUrlType(parsed);
  const collectorKind = inferCollectorKind(host);
  const collectionMethod: CollectionMethod = collectorKind === "browser" ? "browser" : "http";
  const suggestedName = inferSubmittedSourceName(host, parsedTitle, shopToken);
  const canonicalSourceUrl = shopToken
    ? `${baseUrl}/shop/${encodeURIComponent(shopToken)}`
    : submittedUrlType === "source" && !isSharedShopApiPlatformHost(host)
      ? baseUrl
      : null;

  return {
    normalized_url: parsed.toString(),
    submitted_url_type: submittedUrlType,
    base_url: baseUrl,
    ...(canonicalSourceUrl ? { canonical_source_url: canonicalSourceUrl } : {}),
    shop_token: shopToken,
    suggested_source_name: suggestedName,
    suggested_source_id: inferSubmittedSourceId(host, suggestedName, shopToken),
    suggested_collection_method: collectionMethod,
    suggested_collector_kind: collectorKind,
    support_status:
      collectorKind === "browser"
        ? "needs_browser_probe"
        : "supported",
    support_reason:
      collectorKind === "browser"
        ? "暂未识别到公开接口，建议先试采集；失败后加入采集器待办。"
        : `已识别 ${collectorKind} 采集器，可通过自动采集拉取商品。`,
  };
}

async function resolveSubmittedSource(
  parsed: URL,
  parsedTitle: string | null,
  html: string | null = null,
  context: SubmissionParseContext = {},
): Promise<Record<string, unknown>> {
  const host = normalizeHostname(parsed.hostname);
  const baseMeta = analyzeSubmissionUrl(parsed, parsedTitle);
  const knownSourceMeta = await resolveSourceFromKnownOffer(parsed, parsedTitle, baseMeta);
  if (knownSourceMeta) return knownSourceMeta;

  const goodsKey = getSubmittedGoodsKey(parsed);
  const shopToken = getShopToken(parsed.pathname);
  if (shopToken && isSharedShopApiPlatformHost(host)) {
    const baseUrl = `${parsed.protocol}//${parsed.host}`;
    const shopUrl = `${baseUrl}/shop/${encodeURIComponent(shopToken)}`;
    const shopInfo = await fetchShopInfoFromToken(baseUrl, shopUrl, shopToken);
    const shopMeta = shopInfo ? shopInfoLookupMeta(shopInfo) : {};
    const suggestedName = shopInfo?.sourceName || inferSubmittedSourceName(host, parsedTitle, shopToken);
    return {
      ...baseMeta,
      ...shopMeta,
      submitted_url_type: "source",
      canonical_source_url: shopInfo?.sourceUrl || shopUrl,
      shop_token: shopToken,
      suggested_source_name: suggestedName,
      suggested_source_id: inferSubmittedSourceId(host, suggestedName, shopToken),
      ...(shopInfo?.sourceName
        ? {
            canonical_source_status: "resolved",
            canonical_source_reason: "已从店铺接口识别到店铺名，审核通过时会按该渠道入口入库。",
          }
        : {}),
    };
  }

  if (!isSharedShopApiPlatformHost(host) || !goodsKey || shopToken) {
    return baseMeta;
  }

  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const tokenFromHtml = getShopTokenFromHtml(html);
  const goodsLookup = tokenFromHtml
    ? null
    : await fetchShopGoodsFromGoods(baseUrl, parsed.toString(), goodsKey);
  const tokenFromApi = goodsLookup?.token || null;
  const productMeta = goodsLookup ? shopGoodsLookupMeta(goodsLookup) : {};
  const sourceToken = tokenFromHtml || tokenFromApi;
  if (!sourceToken) {
    const peerSourceMeta = await resolveSourceFromPeerSubmission(parsed, parsedTitle, baseMeta, productMeta, context);
    if (peerSourceMeta) return peerSourceMeta;

    const detail = goodsLookup?.apiMessage || goodsLookup?.error;
    return {
      ...baseMeta,
      ...productMeta,
      submitted_url_type: "product",
      canonical_source_status: "unresolved",
      canonical_source_reason: detail
        ? `商品接口未返回店铺入口：${detail}`
        : "商品链接暂未反查到店铺入口；请重新解析，或手动填写真实店铺入口后再通过。",
    };
  }

  const shopUrl = goodsLookup?.sourceUrl || `${baseUrl}/shop/${encodeURIComponent(sourceToken)}`;
  const suggestedName = goodsLookup?.sourceName || inferSubmittedSourceName(host, parsedTitle, sourceToken);
  return {
    ...baseMeta,
    ...productMeta,
    submitted_url_type: "product",
    canonical_source_status: "resolved",
    canonical_source_reason: "已从商品链接反查到店铺入口，审核通过时会按渠道入口入库。",
    canonical_source_url: shopUrl,
    shop_token: sourceToken,
    suggested_source_name: suggestedName,
    suggested_source_id: inferSubmittedSourceId(host, suggestedName, sourceToken),
  };
}

async function enrichSubmissionReviewMeta(
  meta: Record<string, unknown>,
  context: SubmissionParseContext = {},
): Promise<Record<string, unknown>> {
  const next = { ...meta };
  const canonicalSourceUrl = stringValue(meta.canonical_source_url);
  const reviewUrl = canonicalSourceUrl || stringValue(meta.normalized_url);
  delete next.matched_existing_source;
  delete next.existing_source_id;
  delete next.existing_source_name;
  delete next.duplicate_pending_submission_id;
  delete next.duplicate_pending_submission_name;
  delete next.duplicate_pending_submission_url;
  delete next.duplicate_pending_reason;

  if (canonicalSourceUrl) {
    const existing = await findSourceRowByEntryUrl(canonicalSourceUrl);
    if (existing?.id) {
      next.matched_existing_source = true;
      next.existing_source_id = String(existing.id);
      next.existing_source_name = existing.name ? String(existing.name) : String(existing.id);
    }
  }

  if (!reviewUrl) return next;

  const duplicate = await findPreferredPendingSubmissionByCanonicalUrl(reviewUrl, {
    ...context,
    submittedUrl: context.submittedUrl || stringValue(meta.normalized_url),
    currentMeta: next,
  });
  if (duplicate) {
    next.duplicate_pending_submission_id = duplicate.id;
    next.duplicate_pending_submission_name = duplicate.name || duplicate.parsedTitle || duplicate.suggestedSourceName || duplicate.url;
    next.duplicate_pending_submission_url = duplicate.url;
    next.duplicate_pending_reason = "same_canonical_source_url";
  }

  return next;
}

type PendingSubmissionDuplicate = {
  id: string;
  url: string;
  name: string | null;
  parsedTitle: string | null;
  suggestedSourceName: string | null;
  createdAt: string | null;
};

async function findPreferredPendingSubmissionByCanonicalUrl(
  canonicalSourceUrl: string,
  context: SubmissionParseContext = {},
): Promise<PendingSubmissionDuplicate | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const normalizedCanonical = normalizeSourceEntryUrl(canonicalSourceUrl);
  const normalizedSubmission = normalizeSubmissionUrlForReview(canonicalSourceUrl);
  if (!normalizedCanonical && !normalizedSubmission) return null;

  const submittedAt = context.submittedAt ? Date.parse(context.submittedAt) : NaN;
  const currentScore = submissionCompletenessScore({
    id: context.submissionId || null,
    url: context.submittedUrl || canonicalSourceUrl,
    name: context.submittedName || null,
    contact: context.contact || null,
    notes: context.notes || null,
    parsedTitle: context.parsedTitle || null,
    meta: context.currentMeta || {},
    createdAt: context.submittedAt || null,
  });
  const { data, error } = await supabase
    .from("channel_submissions")
    .select("id,url,name,contact,notes,parsed_title,parsed_meta,created_at,status")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;

  let preferred: (PendingSubmissionDuplicate & { score: number; createdMs: number }) | null = null;

  for (const row of data || []) {
    if (context.submissionId && row.id === context.submissionId) continue;

    const rowMeta = row.parsed_meta && typeof row.parsed_meta === "object" && !Array.isArray(row.parsed_meta)
      ? row.parsed_meta as Record<string, unknown>
      : {};
    const rowCanonicalUrl = stringValue(rowMeta.canonical_source_url) || stringValue(row.url);
    if (!rowCanonicalUrl) continue;
    const normalizedRowCanonical = normalizeSourceEntryUrl(rowCanonicalUrl);
    const normalizedRowSubmission = normalizeSubmissionUrlForReview(rowCanonicalUrl);
    const canonicalMatches = Boolean(normalizedCanonical && normalizedRowCanonical === normalizedCanonical);
    const submissionMatches = Boolean(normalizedSubmission && normalizedRowSubmission === normalizedSubmission);
    if (!canonicalMatches && !submissionMatches) {
      continue;
    }

    const rowCreatedAt = row.created_at ? String(row.created_at) : null;
    const rowCreatedMs = rowCreatedAt ? Date.parse(rowCreatedAt) : NaN;
    const candidate: PendingSubmissionDuplicate & { score: number; createdMs: number } = {
      id: String(row.id),
      url: String(row.url || ""),
      name: row.name ? String(row.name) : null,
      parsedTitle: row.parsed_title ? String(row.parsed_title) : null,
      suggestedSourceName: stringValue(rowMeta.suggested_source_name),
      createdAt: rowCreatedAt,
      score: submissionCompletenessScore({
        id: String(row.id),
        url: String(row.url || ""),
        name: row.name ? String(row.name) : null,
        contact: row.contact ? String(row.contact) : null,
        notes: row.notes ? String(row.notes) : null,
        parsedTitle: row.parsed_title ? String(row.parsed_title) : null,
        meta: rowMeta,
        createdAt: rowCreatedAt,
      }),
      createdMs: rowCreatedMs,
    };

    if (
      !preferred ||
      candidate.score > preferred.score ||
      (candidate.score === preferred.score && Number.isFinite(candidate.createdMs) && candidate.createdMs > preferred.createdMs)
    ) {
      preferred = candidate;
    }
  }

  if (!preferred) return null;

  const isMoreComplete = preferred.score > currentScore;
  const isTieBreakerPreferred =
    preferred.score === currentScore &&
    (
      Number.isFinite(submittedAt)
        ? Number.isFinite(preferred.createdMs) && preferred.createdMs > submittedAt
        : !context.submissionId
    );
  if (!isMoreComplete && !isTieBreakerPreferred) return null;

  return {
    id: preferred.id,
    url: preferred.url,
    name: preferred.name,
    parsedTitle: preferred.parsedTitle,
    suggestedSourceName: preferred.suggestedSourceName,
    createdAt: preferred.createdAt,
  };
}

function submissionCompletenessScore(input: {
  id?: string | null;
  url?: string | null;
  name?: string | null;
  contact?: string | null;
  notes?: string | null;
  parsedTitle?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string | null;
}): number {
  const meta = input.meta || {};
  let score = 0;

  const submittedUrlType = stringValue(meta.submitted_url_type);
  if (submittedUrlType === "source") score += 28;
  else if (submittedUrlType === "product") score += 12;

  if (stringValue(meta.canonical_source_url)) score += 24;
  if (stringValue(meta.shop_token)) score += 8;
  if (stringValue(meta.suggested_source_id) || stringValue(meta.existing_source_id)) score += 8;
  if (stringValue(meta.suggested_source_name) || input.name) score += 8;
  if (input.parsedTitle || submittedProductTitleFromMeta(meta)) score += 4;
  if (input.contact) score += 3;
  if (input.notes) score += 3;

  const canonicalStatus = stringValue(meta.canonical_source_status);
  if (canonicalStatus === "resolved") score += 28;
  else if (canonicalStatus === "unresolved") score -= 10;

  const collectorKind = normalizeCollectorKind(meta.suggested_collector_kind);
  if (collectorKind && collectorKind !== "auto" && collectorKind !== "browser" && collectorKind !== "unsupported") score += 10;
  if (stringValue(meta.suggested_collection_method)) score += 4;

  const productPreview = meta.submitted_product_preview;
  if (productPreview && typeof productPreview === "object" && !Array.isArray(productPreview)) {
    const preview = productPreview as Record<string, unknown>;
    score += 6;
    if (stringValue(preview.sourceUrl)) score += 10;
    if (stringValue(preview.sourceName)) score += 6;
    if (stringValue(preview.title)) score += 4;
    if (numberValue(preview.price) !== null || numberValue(preview.realPrice) !== null) score += 4;
  }

  const probe = getStoredProbeResult(meta);
  if (probe?.status === "success") {
    score += 36 + Math.min(30, Math.max(0, Number(probe.offerCount || 0)));
  } else if (probe?.status === "queued" || probe?.status === "running") {
    score += 8;
  } else if (probe?.status === "failed" || probe?.status === "empty") {
    score += 3;
  }

  const parsedUrl = safeUrl(input.url);
  if (parsedUrl) {
    const type = getSubmittedUrlType(parsedUrl);
    if (type === "source") score += 6;
    else if (type === "product") score += 2;
  }

  return score;
}

function normalizeSubmissionUrlForReview(value: string | null | undefined): string | null {
  const parsed = safeUrl(value);
  if (!parsed) return null;

  const host = normalizeHostname(parsed.hostname);
  const goodsKey = getSubmittedGoodsKey(parsed);
  if (goodsKey && isSharedShopApiPlatformHost(host)) {
    return `${parsed.protocol}//${host}/item/${encodeURIComponent(goodsKey)}`;
  }

  parsed.hostname = host;
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
}

async function resolveSourceFromPeerSubmission(
  parsed: URL,
  parsedTitle: string | null,
  baseMeta: Record<string, unknown>,
  productMeta: Record<string, unknown>,
  context: SubmissionParseContext,
): Promise<Record<string, unknown> | null> {
  const submittedName = context.submittedName || parsedTitle;
  if (!submittedName || isGenericSubmissionSourceName(submittedName)) return null;

  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const host = normalizeHostname(parsed.hostname);
  const submittedAt = context.submittedAt ? Date.parse(context.submittedAt) : NaN;
  const since = Number.isFinite(submittedAt)
    ? new Date(submittedAt - 3 * 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("channel_submissions")
    .select("id,url,name,parsed_title,parsed_meta,created_at,status")
    .eq("status", "pending")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;

  for (const row of data || []) {
    if (context.submissionId && row.id === context.submissionId) continue;

    const rowMeta = row.parsed_meta && typeof row.parsed_meta === "object" && !Array.isArray(row.parsed_meta)
      ? row.parsed_meta as Record<string, unknown>
      : {};
    const sourceUrl = stringValue(rowMeta.canonical_source_url) || stringValue(row.url);
    const source = safeUrl(sourceUrl);
    if (!source || normalizeHostname(source.hostname) !== host) continue;

    const shopToken = getShopToken(source.pathname);
    if (!shopToken) continue;

    const rowCreatedAt = row.created_at ? Date.parse(String(row.created_at)) : NaN;
    if (Number.isFinite(submittedAt) && Number.isFinite(rowCreatedAt)) {
      const diffMs = Math.abs(submittedAt - rowCreatedAt);
      if (diffMs > 3 * 24 * 60 * 60 * 1000) continue;
    }

    if (!matchesPeerSubmissionName(submittedName, [
      stringValue(row.name),
      stringValue(row.parsed_title),
      stringValue(rowMeta.suggested_source_name),
    ])) {
      continue;
    }

    const canonicalSourceUrl = normalizeSourceEntryUrl(source.toString()) || source.toString();
    const sourceName =
      stringValue(rowMeta.suggested_source_name) ||
      stringValue(row.name) ||
      inferSubmittedSourceName(host, parsedTitle, shopToken);

    return {
      ...baseMeta,
      ...productMeta,
      submitted_url_type: "product",
      canonical_source_status: "resolved",
      canonical_source_reason: "商品接口未返回店铺入口，已按同名待审店铺链接补齐渠道入口。",
      canonical_source_url: canonicalSourceUrl,
      shop_token: shopToken,
      suggested_source_name: sourceName,
      suggested_source_id: inferSubmittedSourceId(host, sourceName, shopToken),
      duplicate_submission_id: String(row.id),
      duplicate_submission_reason: "same_pending_shop_submission",
    };
  }

  return null;
}

function matchesPeerSubmissionName(submittedName: string, candidates: Array<string | null>): boolean {
  const normalized = normalizeSubmissionNameForMatch(submittedName);
  if (!normalized || normalized.length < 2) return false;
  return candidates.some((candidate) => normalizeSubmissionNameForMatch(candidate) === normalized);
}

function normalizeSubmissionNameForMatch(value: string | null): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, "")
    .trim();
}

function isGenericSubmissionSourceName(value: string): boolean {
  const normalized = normalizeSubmissionNameForMatch(value);
  return new Set([
    "ai",
    "openai",
    "chatgpt",
    "gpt",
    "gptplus",
    "plus",
    "claude",
    "gemini",
    "账号",
    "卡网",
    "商店",
    "小店",
  ]).has(normalized);
}

async function resolveSourceFromKnownOffer(
  parsed: URL,
  parsedTitle: string | null,
  baseMeta: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (getSubmittedUrlType(parsed) !== "product") return null;

  const source = await findSourceFromKnownOfferUrl(parsed.toString());
  if (!source) return null;

  const canonicalSourceUrl = normalizeSourceEntryUrl(source.entryUrl) || source.entryUrl;
  const sourceUrl = safeUrl(canonicalSourceUrl);
  const sourceHost = sourceUrl ? normalizeHostname(sourceUrl.hostname) : normalizeHostname(parsed.hostname);
  const shopToken = sourceUrl ? getShopToken(sourceUrl.pathname) : null;

  return {
    ...baseMeta,
    submitted_url_type: "product",
    canonical_source_status: "resolved",
    canonical_source_reason: "已从历史报价反查到店铺入口，审核通过时会合并到已有渠道。",
    canonical_source_url: canonicalSourceUrl,
    shop_token: shopToken,
    suggested_source_name: source.name || inferSubmittedSourceName(sourceHost, parsedTitle, shopToken),
    suggested_source_id: source.id,
    suggested_collection_method: source.collectionMethod,
    suggested_collector_kind: source.collectorKind || inferCollectorKind(sourceHost),
  };
}

function inferCollectorKind(host: string): string {
  return inferCollectorKindFromHost(host, host, "browser") || "browser";
}

function refineSubmissionCollectorFromHtml(
  parsed: URL,
  html: string,
  currentMeta: Record<string, unknown>,
): Record<string, unknown> {
  const currentKind = normalizeCollectorKind(currentMeta.suggested_collector_kind);
  if (currentKind && currentKind !== "browser" && currentKind !== "unsupported") return {};

  const detectedKind = inferCollectorKindFromSubmissionFingerprint(parsed, html);
  if (!detectedKind || detectedKind === "browser" || detectedKind === "unsupported") return {};

  return {
    suggested_collection_method: "http",
    suggested_collector_kind: detectedKind,
    support_status: "fingerprint_supported",
    support_reason: `页面指纹识别到 ${detectedKind} 采集器，建议试采集确认后入库。`,
  };
}

function inferCollectorKindFromSubmissionFingerprint(parsed: URL, html: string): CollectorKind | null {
  const hostKind = inferCollectorKindFromHost(parsed.hostname);
  if (hostKind) return hostKind;

  const lower = html.toLowerCase();
  if (lower.includes("/user/api/index/commodity") || (lower.includes("commodity_name") && lower.includes("/assets/static/acg.js"))) {
    return "kami";
  }
  if (lower.includes("/api/v1/public/products") || lower.includes("dujiaoka")) return "dujiao";
  if (lower.includes("/shop/user/products")) return "shopUserProductsApi";
  if (lower.includes("mooncake_catalog") || lower.includes("mooncake-official-media/catalog")) return "mooncakeCatalog";
  if (lower.includes("/api/shop/products")) return "ikunloveApi";
  if (lower.includes("/api/products")) return "publicProductsApi";
  if (/card position-relative/i.test(html) && /card-title/i.test(html) && /\/buy\/\d+/i.test(html)) return "unicornHtml";
  if (/atelier-catalog-card/i.test(html)) return "beibeiHtml";
  if (parsed.pathname.match(/\/(?:product|products|goods|item)\//i) && CURRENCY_PRICE_RE.test(html)) return "genericHtml";
  return null;
}

function inferSubmittedSourceName(host: string, parsedTitle: string | null, shopToken: string | null): string {
  if (host === "ai666.dnxb.cc") return "T佬的gmail批发渠道";
  if ((host === "www.ldxp.cn" || host === "pay.ldxp.cn") && shopToken) return `链动小铺 / ${shopToken}`;
  if (host === "pay.qxvx.cn" && shopToken) return `QXVX Pay / ${shopToken}`;
  if (host === "catfk.com" && shopToken) return `云猫寄售 / ${shopToken}`;
  if (host === "kapay.shop") return "Auto Subscribe / kapay.shop";
  if (host === "shop.auto-subscribe.com") return "Auto Subscribe";
  if (host === "zhang520.store") return "zhang520.store";
  if (host === "shopcardai.click") return "购物 - DN发卡网";
  if (host === "ldxp.cn" && shopToken) return `链动小铺 / ${shopToken}`;
  if (host === "ldxp.cn") return "ldxp.cn";
  if (host === "ikunlove.best") return "AI 商品站";
  if (host === "getgpt.pro") return parsedTitle || "ChatGPT Plus 充值服务|GPT Pro官方充值|GPT5代充|Codex充值";
  if (host === "aifk.opensora.de") return "AUTO FK";
  if (host === "aisou.pro") return "Aisou智充";
  if (host === "caowo.store") return "GPT专卖-cw";
  if (host === "makerich.club") return "AI创富俱乐部";
  if (parsedTitle) return parsedTitle;
  return host;
}

function getSubmittedUrlType(parsed: URL): "source" | "product" | "unknown" {
  if (getShopToken(parsed.pathname)) return "source";
  if (getSubmittedGoodsKey(parsed)) return "product";
  if (parsed.pathname.match(/\/products\/[^/?#]+/i)) return "product";
  return parsed.pathname === "/" || parsed.pathname === "" ? "source" : "unknown";
}

function inferSubmittedSourceId(host: string, sourceName: string, shopToken: string | null): string {
  if (host === "ai666.dnxb.cc") return "ai666-gmail-wholesale";
  if (host === "www.ldxp.cn" || host === "pay.ldxp.cn") return `ldxp-${slugify(shopToken || sourceName) || stableId("ldxp", sourceName)}`;
  if (host === "pay.qxvx.cn") return `qxvx-${slugify(shopToken || sourceName) || stableId(host, sourceName)}`;
  if (host === "catfk.com") return `catfk-${slugify(shopToken || sourceName) || stableId(host, sourceName)}`;
  if (host === "shop.auto-subscribe.com") return "auto-subscribe";
  if (host === "zhang520.store") return "zhang520-store";
  if (host === "shopcardai.click") return "购物-dn发卡网";
  if (host === "ldxp.cn") return "ldxp-cn";
  if (host === "ikunlove.best") return "ai-商品站";
  if (host === "getgpt.pro") return "chatgpt-plus-充值服务-gpt-pro官方充值-gpt5代充-codex充值";
  if (host === "aifk.opensora.de") return "opensora-aifk";
  if (host === "aisou.pro") return "aisou-pro";
  if (host === "caowo.store") return "caowo-store";
  if (host === "makerich.club") return "makerich-club";
  return slugify(sourceName) || slugify(host) || stableId(host, sourceName);
}

function getShopToken(pathname: string): string | null {
  const match = pathname.match(/\/shop\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getGoodsKey(pathname: string): string | null {
  const match = pathname.match(/\/item\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getSubmittedGoodsKey(parsed: URL): string | null {
  const raw = getGoodsKey(parsed.pathname) || parsed.searchParams.get("commodity") || parsed.searchParams.get("id");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function getShopTokenFromHtml(html: string | null): string | null {
  if (!html) return null;
  const hrefMatch = html.match(/href=["'][^"']*\/shop\/([^"'/?#]+)[^"']*["']/i);
  if (hrefMatch?.[1]) return decodeURIComponent(hrefMatch[1]);
  const tokenMatch = html.match(/["']token["']\s*:\s*["']([^"']+)["']/i);
  if (tokenMatch?.[1]) return tokenMatch[1];
  return null;
}

async function fetchShopInfoFromToken(baseUrl: string, shopUrl: string, token: string): Promise<ShopInfoLookupResult | null> {
  if (!token) return null;

  let lastResult: ShopInfoLookupResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(`${baseUrl}/shopApi/Shop/info`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/plain, */*",
          "user-agent": attempt === 0
            ? "AIPriceHubBot/1.0 (+https://priceai.cc)"
            : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          origin: baseUrl,
          referer: shopUrl,
          visitorid: `review${Math.random().toString(36).slice(2, 10)}`,
        },
        body: JSON.stringify({ token, category_key: "" }),
        signal: AbortSignal.timeout(SHOP_API_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null);
      lastResult = getShopInfoLookupResult(payload, {
        baseUrl,
        checkedAt,
        httpStatus: response.status,
        token,
      });
      if (lastResult.sourceName) return lastResult;
    } catch (error) {
      lastResult = {
        checkedAt,
        token,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return lastResult;
}

function getShopInfoLookupResult(
  payload: unknown,
  context: { baseUrl: string; checkedAt: string; httpStatus?: number; token: string },
): ShopInfoLookupResult {
  const result: ShopInfoLookupResult = {
    checkedAt: context.checkedAt,
    token: context.token,
    httpStatus: context.httpStatus,
  };
  if (!payload || typeof payload !== "object") {
    return { ...result, error: "店铺接口未返回 JSON。" };
  }

  const record = payload as Record<string, unknown>;
  result.apiCode = stringValue(record.code) || numberValue(record.code);
  result.apiMessage = stringValue(record.msg) || stringValue(record.message);

  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return result;
  const dataRecord = data as Record<string, unknown>;
  result.sourceName = stringValue(dataRecord.nickname);
  result.sourceUrl = stringValue(dataRecord.link) || `${context.baseUrl}/shop/${encodeURIComponent(context.token)}`;
  result.status = stringValue(dataRecord.status) || (numberValue(dataRecord.status) !== null ? String(numberValue(dataRecord.status)) : null);
  result.shopCreatedAt = timestampFromShopApiValue(dataRecord.create_time);
  return result;
}

async function fetchShopGoodsFromGoods(baseUrl: string, itemUrl: string, goodsKey: string): Promise<ShopGoodsLookupResult | null> {
  if (!goodsKey) return null;

  let lastResult: ShopGoodsLookupResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(`${baseUrl}/shopApi/Shop/goodsInfo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/plain, */*",
          "user-agent": attempt === 0
            ? "AIPriceHubBot/1.0 (+https://priceai.cc)"
            : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          origin: baseUrl,
          referer: itemUrl,
          visitorid: `review${Math.random().toString(36).slice(2, 10)}`,
        },
        body: JSON.stringify({ goods_key: goodsKey, trade_no: "" }),
        signal: AbortSignal.timeout(SHOP_API_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null);
      lastResult = getShopGoodsLookupResult(payload, {
        baseUrl,
        goodsKey,
        checkedAt,
        httpStatus: response.status,
      });
      if (lastResult.token) return lastResult;
    } catch (error) {
      lastResult = {
        checkedAt,
        goodsKey,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return lastResult;
}

function getShopGoodsLookupResult(
  payload: unknown,
  context: { baseUrl: string; goodsKey: string; checkedAt: string; httpStatus?: number },
): ShopGoodsLookupResult {
  const result: ShopGoodsLookupResult = {
    checkedAt: context.checkedAt,
    goodsKey: context.goodsKey,
    httpStatus: context.httpStatus,
  };
  if (!payload || typeof payload !== "object") {
    return { ...result, error: "商品接口未返回 JSON。" };
  }

  const record = payload as Record<string, unknown>;
  result.apiCode = stringValue(record.code) || numberValue(record.code);
  result.apiMessage = stringValue(record.msg) || stringValue(record.message);

  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return result;
  const dataRecord = data as Record<string, unknown>;
  const user = dataRecord.user && typeof dataRecord.user === "object" && !Array.isArray(dataRecord.user)
    ? dataRecord.user as Record<string, unknown>
    : {};

  const token = stringValue(user.token) || shopTokenFromUserLink(user.link);
  result.token = token;
  result.sourceUrl = token
    ? stringValue(user.link) || `${context.baseUrl}/shop/${encodeURIComponent(token)}`
    : stringValue(user.link);
  result.sourceName = stringValue(user.nickname);
  result.title = stringValue(dataRecord.name);
  result.price = numberValue(dataRecord.price);
  result.realPrice = numberValue(dataRecord.real_price);
  result.status = stringValue(dataRecord.status) || (numberValue(dataRecord.status) !== null ? String(numberValue(dataRecord.status)) : null);
  result.descriptionPreview = summarizeHtmlText(stringValue(dataRecord.description));

  const category = dataRecord.category;
  if (category && typeof category === "object" && !Array.isArray(category)) {
    result.category = stringValue((category as Record<string, unknown>).name);
  } else {
    result.category = stringValue(category);
  }

  return result;
}

function shopTokenFromUserLink(value: unknown): string | null {
  const link = stringValue(value);
  if (!link) return null;
  const parsed = safeUrl(link);
  return parsed ? getShopToken(parsed.pathname) : null;
}

function shopInfoLookupMeta(lookup: ShopInfoLookupResult): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    shop_api_shop_checked_at: lookup.checkedAt,
    shop_api_shop_token: lookup.token,
  };
  if (typeof lookup.httpStatus === "number") meta.shop_api_shop_http_status = lookup.httpStatus;
  if (lookup.apiCode !== undefined && lookup.apiCode !== null) meta.shop_api_shop_code = lookup.apiCode;
  if (lookup.apiMessage) meta.shop_api_shop_message = lookup.apiMessage;
  if (lookup.error) meta.shop_api_shop_error = lookup.error;
  if (lookup.sourceName) meta.shop_api_shop_name = lookup.sourceName;
  if (lookup.sourceUrl) meta.shop_api_shop_url = lookup.sourceUrl;
  if (lookup.shopCreatedAt) meta.shop_api_shop_created_at = lookup.shopCreatedAt;
  if (lookup.status) meta.shop_api_shop_status = lookup.status;
  return meta;
}

function shopGoodsLookupMeta(lookup: ShopGoodsLookupResult): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    shop_api_checked_at: lookup.checkedAt,
    shop_api_goods_key: lookup.goodsKey,
  };
  if (typeof lookup.httpStatus === "number") meta.shop_api_http_status = lookup.httpStatus;
  if (lookup.apiCode !== undefined && lookup.apiCode !== null) meta.shop_api_code = lookup.apiCode;
  if (lookup.apiMessage) meta.shop_api_message = lookup.apiMessage;
  if (lookup.error) meta.shop_api_error = lookup.error;

  const preview: Record<string, unknown> = {
    checkedAt: lookup.checkedAt,
    goodsKey: lookup.goodsKey,
    currency: "CNY",
  };
  if (lookup.title) preview.title = lookup.title;
  if (lookup.sourceName) preview.sourceName = lookup.sourceName;
  if (lookup.sourceUrl) preview.sourceUrl = lookup.sourceUrl;
  if (typeof lookup.price === "number") preview.price = lookup.price;
  if (typeof lookup.realPrice === "number") preview.realPrice = lookup.realPrice;
  if (lookup.status) {
    preview.status = lookup.status;
    preview.statusText = shopGoodsStatusLabel(lookup.status);
  }
  if (lookup.category) preview.category = lookup.category;
  if (lookup.descriptionPreview) preview.descriptionPreview = lookup.descriptionPreview;
  if (lookup.apiMessage) preview.apiMessage = lookup.apiMessage;

  if (Object.keys(preview).length > 3) meta.submitted_product_preview = preview;
  return meta;
}

function shopGoodsStatusLabel(value: string): string {
  if (value === "1" || value.toLowerCase() === "available") return "上架";
  if (value === "0" || value.toLowerCase() === "unavailable") return "未上架";
  return value;
}

function timestampFromShopApiValue(value: unknown): string | null {
  const numeric = numberValue(value);
  if (numeric === null) return null;

  const ms = numeric > 1e12 ? numeric : numeric * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summarizeHtmlText(value: string | null): string | null {
  if (!value) return null;
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 260) : null;
}

async function findSourceFromKnownOfferUrl(itemUrl: string): Promise<Source | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const candidates = knownOfferUrlCandidates(itemUrl);
  if (!candidates.length) return null;

  const { data: exactRows, error: exactError } = await supabase
    .from("raw_offer_public_state")
    .select("source_id,url,last_seen_at,captured_at")
    .in("url", candidates)
    .not("source_id", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (exactError && !isMissingRawOfferPublicStateError(exactError)) throw exactError;

  const fallbackExactSourceId = exactError && isMissingRawOfferPublicStateError(exactError)
    ? await findSourceIdByKnownOfferUrls("raw_offers", candidates)
    : null;
  const exactSourceId = !exactError && exactRows?.[0]?.source_id
    ? String(exactRows[0].source_id)
    : fallbackExactSourceId;
  if (exactSourceId) return getSourceById(exactSourceId);

  const parsed = safeUrl(itemUrl);
  if (!parsed) return null;

  const pathPattern = `%://${parsed.host}${parsed.pathname}%`;
  const { data: pathRows, error: pathError } = await supabase
    .from("raw_offer_public_state")
    .select("source_id,url,last_seen_at,captured_at")
    .ilike("url", pathPattern)
    .not("source_id", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (pathError && !isMissingRawOfferPublicStateError(pathError)) throw pathError;

  const fallbackPathSourceId = pathError && isMissingRawOfferPublicStateError(pathError)
    ? await findSourceIdByKnownOfferPath("raw_offers", pathPattern)
    : null;
  const pathSourceId = !pathError && pathRows?.[0]?.source_id
    ? String(pathRows[0].source_id)
    : fallbackPathSourceId;
  return pathSourceId ? getSourceById(pathSourceId) : null;
}

async function findSourceIdByKnownOfferUrls(tableName: string, candidates: string[]): Promise<string | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !candidates.length) return null;

  const { data, error } = await supabase
    .from(tableName)
    .select("source_id,url,last_seen_at,captured_at")
    .in("url", candidates)
    .not("source_id", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (error) throw error;

  return data?.[0]?.source_id ? String(data[0].source_id) : null;
}

async function findSourceIdByKnownOfferPath(tableName: string, pathPattern: string): Promise<string | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(tableName)
    .select("source_id,url,last_seen_at,captured_at")
    .ilike("url", pathPattern)
    .not("source_id", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (error) throw error;

  return data?.[0]?.source_id ? String(data[0].source_id) : null;
}

function knownOfferUrlCandidates(value: string): string[] {
  const parsed = safeUrl(value);
  if (!parsed) return [value];

  const candidates = new Set<string>([parsed.toString()]);
  parsed.hash = "";
  candidates.add(parsed.toString());
  parsed.search = "";
  candidates.add(parsed.toString());
  return [...candidates].filter(Boolean);
}

function safeUrl(value: string | null | undefined): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^www\./, "");
}

function isSharedShopApiPlatformHost(host: string): boolean {
  return host === "www.ldxp.cn" || host === "pay.ldxp.cn" || host === "pay.qxvx.cn" || host === "ldxp.cn" || host === "catfk.com";
}

function normalizeCollectorKind(value: unknown): CollectorKind | null {
  return normalizeRegisteredCollectorKind(value);
}

function isRuntimeCollectionIssue(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("验证") ||
    text.includes("风控") ||
    text.includes("captcha") ||
    text.includes("challenge") ||
    text.includes("waf") ||
    text.includes("安全")
  );
}

export async function createSubmission(input: {
  url: string;
  name?: string | null;
  contact?: string | null;
  notes?: string | null;
  honeypot?: string | null;
  submitterIp?: string | null;
  rateLimitPerHour?: number;
}): Promise<{ id: string; status: SubmissionStatus; merged?: boolean } | { ignored: true }> {
  if (input.honeypot) {
    return { ignored: true };
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法接受提交。");

  const normalizedUrl = normalizeSubmissionUrl(input.url);
  if (!normalizedUrl) {
    throw new Error("URL 格式不正确。");
  }

  const ip = input.submitterIp || null;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  if (ip) {
    const rateLimitPerHour = input.rateLimitPerHour ?? 5;
    const { count } = await supabase
      .from("channel_submissions")
      .select("id", { count: "exact", head: true })
      .eq("submitter_ip", ip)
      .gte("created_at", oneHourAgo);
    if ((count || 0) >= rateLimitPerHour) {
      throw new Error("提交过于频繁，请稍后再试。");
    }
  }

  let parsedTitle: string | null = null;
  let parsedMeta: Record<string, unknown> = {};
  try {
    const parsed = await parseSubmissionMetadata(normalizedUrl, {
      submittedName: input.name?.trim() || null,
      submittedUrl: normalizedUrl,
      contact: input.contact?.trim() || null,
      notes: input.notes?.trim() || null,
    });
    parsedTitle = parsed.parsedTitle || submittedProductTitleFromMeta(parsed.parsedMeta);
    parsedMeta = parsed.parsedMeta;
  } catch (error) {
    parsedMeta = buildFallbackSubmissionMeta(normalizedUrl, error);
  }

  const canonicalSourceUrl = stringValue(parsedMeta.canonical_source_url) || stringValue(parsedMeta.normalized_url) || normalizedUrl;
  const canonicalKey = channelSubmissionKey(canonicalSourceUrl);
  const existingRoot = canonicalKey ? await findPendingSubmissionRootByCanonicalKey(canonicalKey) : null;
  if (existingRoot) {
    return mergeSubmissionIntoPendingRoot(existingRoot, {
      name: input.name?.trim() || null,
      contact: input.contact?.trim() || null,
      notes: input.notes?.trim() || null,
      parsedTitle,
      parsedMeta,
      normalizedUrl,
      canonicalKey,
    });
  }
  const duplicatePending = await findPreferredPendingSubmissionByCanonicalUrl(canonicalSourceUrl, {
    submittedName: input.name?.trim() || null,
    submittedUrl: normalizedUrl,
    parsedTitle,
    contact: input.contact?.trim() || null,
    notes: input.notes?.trim() || null,
    currentMeta: parsedMeta,
  });
  if (duplicatePending) {
    const duplicateRoot = await findSubmissionRowById(duplicatePending.id);
    if (duplicateRoot) {
      return mergeSubmissionIntoPendingRoot(duplicateRoot, {
        name: input.name?.trim() || null,
        contact: input.contact?.trim() || null,
        notes: input.notes?.trim() || null,
        parsedTitle,
        parsedMeta,
        normalizedUrl,
        canonicalKey,
      });
    }
    throw new Error("该渠道已有信息更完整的待审记录，请勿重复提交。");
  }

  const id = stableId("submission", normalizedUrl, ip || "", Date.now().toString());
  const preclassification = storedPreclassification(classifySubmission({
    suggestedCollector: normalizeCollectorKind(parsedMeta.suggested_collector_kind),
    existingSourceName: stringValue(parsedMeta.existing_source_name),
  }));
  const insertRow = {
    id,
    url: normalizedUrl,
    name: input.name?.trim() || null,
    contact: input.contact?.trim() || null,
    notes: input.notes?.trim() || null,
    parsed_title: parsedTitle,
    parsed_meta: parsedMeta,
    status: "pending",
    submitter_ip: ip,
    ...submissionReviewColumns({
      reviewStage: "parsed",
      preclassification,
      normalizedUrl,
      canonicalChannelKey: canonicalKey,
      duplicateOfSubmissionId: null,
    }),
  };
  const { error } = await supabase.from("channel_submissions").insert(insertRow);
  if (error) {
    if (error.code === "23505" && canonicalKey) {
      const concurrentRoot = await findPendingSubmissionRootByCanonicalKey(canonicalKey);
      if (concurrentRoot) {
        return mergeSubmissionIntoPendingRoot(concurrentRoot, {
          name: input.name?.trim() || null,
          contact: input.contact?.trim() || null,
          notes: input.notes?.trim() || null,
          parsedTitle,
          parsedMeta,
          normalizedUrl,
          canonicalKey,
        });
      }
    }
    throw error;
  }

  return { id, status: "pending" };
}

async function findPendingSubmissionRootByCanonicalKey(canonicalKey: string): Promise<Record<string, unknown> | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("status", "pending")
    .eq("canonical_channel_key", canonicalKey)
    .is("duplicate_of_submission_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingSubmissionReviewContractError(error)) return null;
    throw error;
  }
  return data?.[0] || null;
}

async function findSubmissionRowById(id: string): Promise<Record<string, unknown> | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.from("channel_submissions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function mergeSubmissionIntoPendingRoot(
  row: Record<string, unknown>,
  incoming: {
    name: string | null;
    contact: string | null;
    notes: string | null;
    parsedTitle: string | null;
    parsedMeta: Record<string, unknown>;
    normalizedUrl: string;
    canonicalKey: string | null;
  },
): Promise<{ id: string; status: SubmissionStatus; merged: true }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法合并提交。");
  const current = mapSubmissionRow(row);
  const mergedMeta: Record<string, unknown> = {
    ...current.parsedMeta,
    ...incoming.parsedMeta,
    normalized_url: current.normalizedUrl || incoming.normalizedUrl,
    merged_submission_at: new Date().toISOString(),
  };
  for (const key of [
    "probe_result",
    "probe_checked_at",
    "probe_job_id",
    "review_stage",
    "collector_todo_at",
    "collector_todo_reason",
  ]) {
    if (current.parsedMeta[key] !== undefined) mergedMeta[key] = current.parsedMeta[key];
  }
  delete mergedMeta.duplicate_pending_submission_id;
  delete mergedMeta.duplicate_pending_submission_name;
  delete mergedMeta.duplicate_pending_submission_url;
  delete mergedMeta.duplicate_pending_reason;
  const mergedSubmission: ChannelSubmission = {
    ...current,
    name: current.name || incoming.name,
    contact: current.contact || incoming.contact,
    notes: current.notes || incoming.notes,
    parsedTitle: current.parsedTitle || incoming.parsedTitle,
    parsedMeta: mergedMeta,
    normalizedUrl: current.normalizedUrl || incoming.normalizedUrl,
    canonicalChannelKey: current.canonicalChannelKey || incoming.canonicalKey,
  };
  const preclassification = await buildStoredSubmissionPreclassification(mergedSubmission, mergedMeta);
  const { error } = await supabase.from("channel_submissions").update({
    name: mergedSubmission.name,
    contact: mergedSubmission.contact,
    notes: mergedSubmission.notes,
    parsed_title: mergedSubmission.parsedTitle,
    parsed_meta: mergedMeta,
    ...submissionReviewColumns({
      reviewStage: mergedSubmission.reviewStage === "submitted" ? "parsed" : mergedSubmission.reviewStage,
      preclassification,
      normalizedUrl: mergedSubmission.normalizedUrl,
      canonicalChannelKey: mergedSubmission.canonicalChannelKey,
      duplicateOfSubmissionId: null,
    }),
  }).eq("id", current.id).eq("status", "pending");
  if (error) throw error;
  return { id: current.id, status: "pending", merged: true };
}

export async function createOfferFeedback(input: {
  id?: string | null;
  feedbackScope?: OfferFeedbackScope | null;
  publicStatus?: OfferFeedbackPublicStatus | null;
  productId?: string | null;
  productSlug?: string | null;
  productName?: string | null;
  offerId?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  sourceTitle?: string | null;
  offerUrl?: string | null;
  offerPrice?: number | null;
  offerCurrency?: string | null;
  offerStatus?: OfferStatus | null;
  offerCapturedAt?: string | null;
  offerSourceUpdatedAt?: string | null;
  offerLastSeenAt?: string | null;
  reason: OfferFeedbackReason;
  issueDimension?: OfferFeedbackIssueDimension | null;
  expectedProductId?: string | null;
  classificationVersion?: string | null;
  classificationResult?: Record<string, unknown> | null;
  userExpectedAction?: OfferFeedbackUserExpectedAction | null;
  suggestedAction?: OfferFeedbackSuggestedAction | null;
  evidenceText?: string | null;
  evidenceUrls?: string[] | null;
  notes?: string | null;
  contact?: string | null;
  submitterIp?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  userDisplayName?: string | null;
  rateLimitPerHour?: number;
}): Promise<{ id: string; status: "pending" }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法接受反馈。");

  const ip = input.submitterIp || null;
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  if (input.offerId) {
    const { data: dupRows } = await supabase
      .from("offer_feedback")
      .select("id")
      .eq("offer_id", input.offerId)
      .eq("reason", input.reason)
      .gte("created_at", fiveMinAgo)
      .limit(1);
    if (dupRows && dupRows.length) {
      throw new Error("这条问题刚刚被反馈过，请稍后再试。");
    }
  }

  if (!input.offerId && input.sourceId) {
    const { data: dupRows } = await supabase
      .from("offer_feedback")
      .select("id")
      .eq("feedback_scope", input.feedbackScope === "merchant" ? "merchant" : "offer")
      .eq("source_id", input.sourceId)
      .eq("reason", input.reason)
      .gte("created_at", fiveMinAgo)
      .limit(1);
    if (dupRows && dupRows.length) {
      throw new Error("这个商家问题刚刚被反馈过，请稍后再试。");
    }
  }

  if (ip) {
    const rateLimitPerHour = input.rateLimitPerHour ?? 10;
    const { count } = await supabase
      .from("offer_feedback")
      .select("id", { count: "exact", head: true })
      .eq("submitter_ip", ip)
      .gte("created_at", oneHourAgo);
    if ((count || 0) >= rateLimitPerHour) {
      throw new Error("反馈过于频繁，请稍后再试。");
    }
  }

  const feedbackScope = input.feedbackScope === "merchant" ? "merchant" : "offer";
  const id = input.id?.trim() || stableId(`${feedbackScope}-feedback`, input.offerId || input.sourceId || "", input.reason, ip || "", Date.now().toString());
  const userExpectedAction = normalizeOfferFeedbackUserExpectedAction(input.userExpectedAction);
  const evidenceText = input.evidenceText?.trim() || null;
  const evidenceUrls = sanitizeFeedbackEvidenceUrls(input.evidenceUrls || []);
  const hasEvidence = Boolean(evidenceText || evidenceUrls.length);
  const needsImageEvidence = feedbackRequiresImageEvidence(input.reason, userExpectedAction);
  if (needsImageEvidence && !hasFeedbackImageEvidenceReference(evidenceUrls)) {
    throw new Error(input.reason === "description_mismatch"
      ? "标题党或商家描述误导需要至少上传 1 张截图证据，方便判断哪里不一致。"
      : "这类高风险反馈需要至少上传 1 张图片证据，文字或链接只能作为补充。");
  }
  if (feedbackRequiresEvidence(input.reason, userExpectedAction) && !hasEvidence) {
    throw new Error("这类反馈需要提交图片、链接或较完整说明作为证据。");
  }
  if (feedbackRequiresContact(input.reason) && !input.contact?.trim()) {
    throw new Error("这类反馈需要留下 QQ、微信或 Telegram，方便后台核验和追问证据。");
  }

  const aiReviewResult = buildInitialFeedbackVerificationResult({
    reason: input.reason,
    notes: input.notes || null,
    evidenceText,
    offerStatus: input.offerStatus || null,
  });
  const verificationStatus = typeof aiReviewResult?.verificationStatus === "string"
    ? aiReviewResult.verificationStatus
    : "not_needed";
  const verificationMessage = typeof aiReviewResult?.verificationMessage === "string"
    ? aiReviewResult.verificationMessage
    : null;
  const suggestedAction = input.suggestedAction
    ? normalizeOfferFeedbackSuggestedAction(input.suggestedAction, input.reason)
    : inferOfferFeedbackSuggestedAction(input.reason);
  const publicStatus = input.publicStatus || (HIGH_RISK_FEEDBACK_REASONS.has(input.reason) ? "pending_review" : "not_public");
  const { error } = await supabase.from("offer_feedback").insert({
    id,
    feedback_scope: feedbackScope,
    product_id: input.productId || null,
    product_slug: input.productSlug || null,
    product_name: input.productName || null,
    offer_id: input.offerId || null,
    source_id: input.sourceId || null,
    source_name: input.sourceName || null,
    source_title: input.sourceTitle || null,
    offer_url: input.offerUrl || null,
    offer_price: input.offerPrice ?? null,
    offer_currency: input.offerCurrency || null,
    offer_status: input.offerStatus || null,
    offer_captured_at: input.offerCapturedAt || null,
    offer_source_updated_at: input.offerSourceUpdatedAt || null,
    offer_last_seen_at: input.offerLastSeenAt || null,
    reason: input.reason,
    issue_dimension: input.reason === "wrong_category" ? input.issueDimension || "product_category" : null,
    expected_product_id: input.reason === "wrong_category" ? input.expectedProductId || null : null,
    classification_version: input.classificationVersion || null,
    classification_result: input.classificationResult || null,
    user_expected_action: userExpectedAction,
    suggested_action: suggestedAction,
    evidence_text: evidenceText,
    evidence_urls: evidenceUrls,
    ai_review_result: aiReviewResult,
    verification_status: verificationStatus,
    verification_message: verificationMessage,
    notes: input.notes?.trim() || null,
    contact: input.contact?.trim() || null,
    status: "pending",
    public_status: publicStatus,
    submitter_ip: ip,
    user_id: input.userId || null,
    user_email: input.userEmail || null,
    user_display_name: input.userDisplayName || null,
  });
  if (error) throw error;

  return { id, status: "pending" };
}

export async function runOfferFeedbackRiskPrecheck(feedbackId: string): Promise<OfferFeedback> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法运行风险预审。");
  await ensureOfferFeedbackVerificationSchema(supabase);

  const { data: row, error } = await supabase
    .from("offer_feedback")
    .select("*")
    .eq("id", feedbackId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("反馈记录不存在。");

  const feedback = mapOfferFeedbackRow(row);
  if (!MODEL_PRECHECK_FEEDBACK_REASONS.has(feedback.reason)) {
    throw new Error("这类临时数据反馈不运行模型预审，请使用自动复核或创建重采。");
  }

  const result = await reviewRiskFeedback(toRiskFeedbackReviewInput(feedback));
  const nextAiReviewResult = mergeRiskPrecheckResult(feedback.aiReviewResult, result);
  const nextVerificationMessage = result.status === "ready"
    ? result.canShowPublicly
      ? "模型预审已生成前台临时风险摘要，等待人工核验。"
      : "模型预审未达到前台临时公开条件，等待人工核验。"
    : result.status === "skipped"
      ? result.privateReason
      : "模型预审失败，暂不公开到前台。";

  const { data: updatedRow, error: updateError } = await supabase
    .from("offer_feedback")
    .update({
      ai_review_result: nextAiReviewResult,
      verification_status: result.status === "failed" ? "failed" : "manual_review",
      verification_message: nextVerificationMessage,
      verification_checked_at: result.reviewedAt,
    })
    .eq("id", feedback.id)
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updatedRow) throw new Error("反馈记录不存在。");

  return mapOfferFeedbackRow(updatedRow);
}

export async function updateOfferFeedbackRiskPrecheckVisibility(input: {
  id: string;
  mode: "hide_public" | "expand_source";
  reviewerNote?: string | null;
}): Promise<OfferFeedback> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data: row, error } = await supabase
    .from("offer_feedback")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("反馈记录不存在。");

  const feedback = mapOfferFeedbackRow(row);
  const current = feedback.aiReviewResult || {};
  const riskPrecheck = current.riskPrecheck && typeof current.riskPrecheck === "object"
    ? current.riskPrecheck as Record<string, unknown>
    : null;
  if (!riskPrecheck) throw new Error("这条反馈还没有模型预审结果。");

  const now = new Date().toISOString();
  const note = input.reviewerNote?.trim() || null;
  const nextRiskPrecheck = input.mode === "hide_public"
    ? {
        ...riskPrecheck,
        publicHidden: true,
        publicHiddenAt: now,
        publicHiddenReason: note || "后台人工撤销前台风险提示。",
        canShowPublicly: false,
        expiresAt: null,
      }
    : {
        ...riskPrecheck,
        sourceCanShowPublicly: true,
        riskScope: "mixed",
        sourcePublicSummary: String(riskPrecheck.sourcePublicSummary || riskPrecheck.offerPublicSummary || riskPrecheck.publicSummary || ""),
      };

  const { data: updatedRow, error: updateError } = await supabase
    .from("offer_feedback")
    .update({
      ai_review_result: {
        ...current,
        riskPrecheck: nextRiskPrecheck,
      },
      public_status: input.mode === "hide_public" ? "not_public" : "pending_review",
      verification_status: "manual_review",
      verification_message: input.mode === "hide_public"
        ? "已人工撤销前台风险提示，反馈记录保留。"
        : "已人工扩展为商家级风险提示，等待后续核验。",
      verification_checked_at: now,
      reviewer_note: note,
    })
    .eq("id", feedback.id)
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updatedRow) throw new Error("反馈记录不存在。");

  return mapOfferFeedbackRow(updatedRow);
}

async function ensureOfferFeedbackVerificationSchema(supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>): Promise<void> {
  const { error } = await supabase
    .from("offer_feedback")
    .select("id,verification_status,verification_checked_at,created_collection_job_id")
    .limit(1);

  if (!error) return;
  if (isMissingOfferFeedbackVerificationSchemaError(error)) {
    throw new Error("反馈核验字段尚未迁移，请先应用 Supabase migration 后再重试。");
  }
  throw error;
}

function isMissingOfferFeedbackVerificationSchemaError(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  const message = typeof record.message === "string" ? record.message : "";
  return record.code === "42703" ||
    record.code === "PGRST204" ||
    /verification_(status|checked_at)|created_collection_job_id/.test(message);
}

function toRiskFeedbackReviewInput(feedback: OfferFeedback): RiskFeedbackReviewInput {
  return {
    id: feedback.id,
    productName: feedback.productName,
    offerId: feedback.offerId,
    sourceId: feedback.sourceId,
    sourceName: feedback.sourceName,
    sourceTitle: feedback.sourceTitle,
    offerUrl: feedback.offerUrl,
    offerPrice: feedback.offerPrice,
    offerStatus: feedback.offerStatus,
    reason: feedback.reason,
    userExpectedAction: feedback.userExpectedAction,
    evidenceText: feedback.evidenceText,
    evidenceUrls: feedback.evidenceUrls,
    notes: feedback.notes,
    submitterIp: feedback.submitterIp,
  };
}

type OfferFeedbackListOptions = {
  status?: OfferFeedbackStatus;
  query?: string | null;
};

export async function listOfferFeedback(statusOrOptions: OfferFeedbackStatus | OfferFeedbackListOptions = "pending"): Promise<OfferFeedback[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return [];

  const options = typeof statusOrOptions === "string" ? { status: statusOrOptions } : statusOrOptions;
  const status = options.status || "pending";
  const search = toOfferFeedbackSearchPattern(options.query || "");

  let query = supabase
    .from("offer_feedback")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false });

  if (search) {
    query = query.or(
      [
        `source_name.ilike.${search}`,
        `source_id.ilike.${search}`,
        `source_title.ilike.${search}`,
        `offer_url.ilike.${search}`,
        `offer_id.ilike.${search}`,
        `product_id.ilike.${search}`,
        `product_slug.ilike.${search}`,
        `product_name.ilike.${search}`,
        `evidence_text.ilike.${search}`,
        `notes.ilike.${search}`,
        `contact.ilike.${search}`,
        `reviewer_note.ilike.${search}`,
      ].join(","),
    );
  }

  const { data, error } = await query.limit(300);
  if (error) throw error;
  return (data || []).map(mapOfferFeedbackRow);
}

function toOfferFeedbackSearchPattern(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  return `%${normalized.replace(/[%,()]/g, " ").replace(/\s+/g, "%")}%`;
}

export async function updateOfferFeedbackStatus(input: {
  id: string;
  status: OfferFeedbackStatus;
  reviewerNote?: string | null;
}): Promise<OfferFeedback> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const reviewedAt = input.status === "pending" ? null : new Date().toISOString();
  const { data, error } = await supabase
    .from("offer_feedback")
    .update({
      status: input.status,
      reviewer_note: input.reviewerNote?.trim() || null,
      reviewed_at: reviewedAt,
      ...(input.status === "ignored" ? { public_status: "not_public" } : {}),
    })
    .eq("id", input.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("反馈记录不存在。");

  return mapOfferFeedbackRow(data);
}

export async function updateOfferFeedbackVerification(input: {
  id: string;
  verificationStatus: OfferFeedbackVerificationStatus;
  verificationResult?: OfferFeedbackVerificationResult | null;
  verificationMessage?: string | null;
  reviewerNote?: string | null;
}): Promise<OfferFeedback> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data, error } = await supabase
    .from("offer_feedback")
    .update({
      verification_status: input.verificationStatus,
      verification_result: input.verificationResult || null,
      verification_message: input.verificationMessage?.trim() || null,
      verification_checked_at: new Date().toISOString(),
      reviewer_note: input.reviewerNote?.trim() || null,
    })
    .eq("id", input.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("反馈记录不存在。");

  return mapOfferFeedbackRow(data);
}

export async function createFeedbackRecollectionJob(input: {
  feedbackId: string;
  priority?: number;
  maxAttempts?: number;
}): Promise<{ feedback: OfferFeedback; jobId: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法创建采集任务。");

  const { data: feedbackRow, error: feedbackError } = await supabase
    .from("offer_feedback")
    .select("*")
    .eq("id", input.feedbackId)
    .maybeSingle();
  if (feedbackError) throw feedbackError;
  if (!feedbackRow) throw new Error("反馈记录不存在。");

  const feedback = mapOfferFeedbackRow(feedbackRow);
  if (!feedback.sourceId) throw new Error("这条反馈没有关联渠道，无法创建来源重采任务。");

  const existingJobId = feedback.createdCollectionJobId;
  if (existingJobId) {
    return { feedback, jobId: existingJobId };
  }

  const now = new Date().toISOString();
  const jobId = stableId("feedback-recollection", feedback.id, feedback.sourceId, now);
  const { error: jobError } = await supabase.from("collection_jobs").insert({
    id: jobId,
    job_type: "source",
    source_id: feedback.sourceId,
    source_name: feedback.sourceName || feedback.sourceId,
    status: "pending",
    priority: input.priority ?? 30,
    attempts: 0,
    max_attempts: input.maxAttempts ?? 1,
    requested_by: "feedback",
    result: {
      feedbackId: feedback.id,
      reason: feedback.reason,
      offerId: feedback.offerId,
      verificationIntent: "low_risk_feedback_recollection",
      force: true,
      noCooldown: true,
    },
    created_at: now,
    updated_at: now,
  });
  if (jobError) throw jobError;

  const { data: updatedRow, error: updateError } = await supabase
    .from("offer_feedback")
    .update({
      verification_status: "recollection_created",
      verification_result: "recollection_created",
      verification_message: "已创建来源重采任务，等待现有采集队列处理；未在前台请求中同步抓取原站。",
      verification_checked_at: now,
      created_collection_job_id: jobId,
      ai_review_result: {
        ...(feedback.aiReviewResult || {}),
        verificationStatus: "recollection_created",
        verificationResult: "recollection_created",
        verifiedAt: now,
        verificationMessage: "已创建来源重采任务，等待现有采集队列处理；未在前台请求中同步抓取原站。",
        createdCollectionJobId: jobId,
      },
    })
    .eq("id", feedback.id)
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updatedRow) throw new Error("反馈记录不存在。");

  return { feedback: mapOfferFeedbackRow(updatedRow), jobId };
}

export async function createSiteFeedback(input: {
  type: SiteFeedbackType;
  message: string;
  contact?: string | null;
  pageUrl?: string | null;
  submitterIp?: string | null;
  rateLimitPerHour?: number;
}): Promise<{ id: string; status: "pending" }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，无法接受反馈。");

  const ip = input.submitterIp || null;
  const message = input.message.trim();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  if (!message) throw new Error("请填写反馈内容。");

  let duplicateQuery = supabase
    .from("site_feedback")
    .select("id")
    .eq("type", input.type)
    .eq("message", message)
    .gte("created_at", fiveMinAgo)
    .limit(1);
  if (ip) duplicateQuery = duplicateQuery.eq("submitter_ip", ip);

  const { data: dupRows } = await duplicateQuery;
  if (dupRows && dupRows.length) {
    throw new Error("这条意见刚刚提交过，请稍后再试。");
  }

  if (ip) {
    const rateLimitPerHour = input.rateLimitPerHour ?? 8;
    const { count } = await supabase
      .from("site_feedback")
      .select("id", { count: "exact", head: true })
      .eq("submitter_ip", ip)
      .gte("created_at", oneHourAgo);
    if ((count || 0) >= rateLimitPerHour) {
      throw new Error("反馈过于频繁，请稍后再试。");
    }
  }

  const id = stableId("site-feedback", input.type, ip || "", Date.now().toString());
  const { error } = await supabase.from("site_feedback").insert({
    id,
    type: input.type,
    message,
    contact: input.contact?.trim() || null,
    page_url: input.pageUrl || null,
    status: "pending",
    submitter_ip: ip,
  });
  if (error) throw error;

  return { id, status: "pending" };
}

export async function listSiteFeedback(status: SiteFeedbackStatus = "pending"): Promise<SiteFeedback[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("site_feedback")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data || []).map(mapSiteFeedbackRow);
}

export async function updateSiteFeedbackStatus(input: {
  id: string;
  status: SiteFeedbackStatus;
  reviewerNote?: string | null;
}): Promise<SiteFeedback> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const reviewedAt = input.status === "pending" ? null : new Date().toISOString();
  const { data, error } = await supabase
    .from("site_feedback")
    .update({
      status: input.status,
      reviewer_note: input.reviewerNote?.trim() || null,
      reviewed_at: reviewedAt,
    })
    .eq("id", input.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("反馈记录不存在。");

  return mapSiteFeedbackRow(data);
}

function buildFallbackSubmissionMeta(url: string, error: unknown): Record<string, unknown> {
  try {
    const parsed = new URL(url);
    return {
      domain: parsed.host,
      ...analyzeSubmissionUrl(parsed, null),
      parse_error: error instanceof Error ? error.message : String(error),
    };
  } catch {
    return { parse_error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listSubmissions(status: SubmissionStatus = "pending"): Promise<ChannelSubmission[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data || []).map(mapSubmissionRow);
}

async function buildStoredSubmissionPreclassification(
  submission: ChannelSubmission,
  meta: Record<string, unknown> = submission.parsedMeta || {},
): Promise<StoredSubmissionPreclassification> {
  const probe = getStoredProbeResult(meta) as ReviewSubmissionProbeResult | null;
  const priceEvidence = probe?.status === "success"
    ? buildSubmissionPriceEvidence(probe, await listSubmissionPriceBenchmarks(probe))
    : null;
  const duplicateName = submission.duplicateOfSubmissionId
    ? stringValue(meta.duplicate_pending_submission_name) || stringValue(meta.duplicate_pending_submission_url) || "另一条待审记录"
    : null;
  return storedPreclassification(classifySubmission({
    probe,
    suggestedCollector: normalizeCollectorKind(meta.suggested_collector_kind),
    duplicateName,
    existingSourceName: stringValue(meta.existing_source_name),
    priceEvidence,
  }));
}

async function listSubmissionPriceBenchmarks(
  probe: ReviewSubmissionProbeResult,
): Promise<Map<string, SubmissionPriceBenchmark>> {
  const productIds = Array.from(new Set((probe.offers || [])
    .map((offer) => classifyOffer(offer.sourceTitle, { tags: offer.tags }).id)
    .filter((id) => id !== "other-product")));
  if (!productIds.length) return new Map();

  const supabase = getSupabaseServerClient();
  if (!supabase) return new Map();
  const { data, error } = await supabase.rpc("list_submission_price_benchmarks", { p_product_ids: productIds });
  if (error) {
    if (isMissingSubmissionReviewContractError(error)) return new Map();
    throw error;
  }

  const benchmarks = new Map<string, SubmissionPriceBenchmark>();
  for (const row of (data || []) as unknown as Record<string, unknown>[]) {
    const productId = String(row.product_id || "");
    if (!productId) continue;
    benchmarks.set(productId, {
      productId,
      offerCount: numberValue(row.offer_count) || 0,
      minPrice: numberValue(row.min_price) || 0,
      top5Price: numberValue(row.top5_price) || 0,
    });
  }
  return benchmarks;
}

function isMissingSubmissionReviewContractError(error: { message?: string; code?: string }): boolean {
  const message = `${error.code || ""} ${error.message || ""}`.toLowerCase();
  return message.includes("list_submission_price_benchmarks") || message.includes("preclassification") || message.includes("review_stage");
}

function submissionReviewColumns(input: {
  reviewStage: SubmissionReviewStage;
  preclassification: StoredSubmissionPreclassification;
  normalizedUrl?: string | null;
  canonicalChannelKey?: string | null;
  duplicateOfSubmissionId?: string | null;
}): Record<string, unknown> {
  return {
    review_stage: input.reviewStage,
    preclassification_kind: input.preclassification.kind,
    preclassification: input.preclassification,
    classification_version: input.preclassification.version || null,
    classified_at: input.preclassification.classifiedAt || null,
    ...(input.normalizedUrl !== undefined ? { normalized_url: input.normalizedUrl } : {}),
    ...(input.canonicalChannelKey !== undefined ? { canonical_channel_key: input.canonicalChannelKey } : {}),
    ...(input.duplicateOfSubmissionId !== undefined ? { duplicate_of_submission_id: input.duplicateOfSubmissionId } : {}),
  };
}

export async function reparseSubmission(id: string): Promise<ChannelSubmission> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data: row, error } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("提交记录不存在。");
  if (row.status !== "pending") throw new Error("该提交已被处理。");

  const submission = mapSubmissionRow(row);
  let parsedTitle: string | null = null;
  let parsedMeta: Record<string, unknown> = {};
  try {
    const parsed = await parseSubmissionMetadata(submission.url, {
      submissionId: submission.id,
      submittedName: submission.name,
      submittedUrl: submission.url,
      submittedAt: submission.createdAt,
      parsedTitle: submission.parsedTitle,
      contact: submission.contact,
      notes: submission.notes,
    });
    parsedTitle = parsed.parsedTitle || submittedProductTitleFromMeta(parsed.parsedMeta);
    parsedMeta = parsed.parsedMeta;
  } catch (parseError) {
    parsedMeta = buildFallbackSubmissionMeta(submission.url, parseError);
  }

  const previousMeta = submission.parsedMeta || {};
  const nextMeta: Record<string, unknown> = {
    ...parsedMeta,
    probe_result: previousMeta.probe_result,
    probe_checked_at: previousMeta.probe_checked_at,
    reparsed_at: new Date().toISOString(),
  };
  if (!nextMeta.probe_result) delete nextMeta.probe_result;
  if (!nextMeta.probe_checked_at) delete nextMeta.probe_checked_at;
  const normalizedUrl = normalizeSubmissionUrl(submission.url);
  const canonicalKey = channelSubmissionKey(stringValue(nextMeta["canonical_source_url"]) || normalizedUrl);
  const nextSubmission = {
    ...submission,
    parsedTitle,
    parsedMeta: nextMeta,
    normalizedUrl,
    canonicalChannelKey: canonicalKey,
  };
  const preclassification = await buildStoredSubmissionPreclassification(nextSubmission, nextMeta);

  const { data: updated, error: updateError } = await supabase
    .from("channel_submissions")
    .update({
      parsed_title: parsedTitle,
      parsed_meta: nextMeta,
      ...submissionReviewColumns({
        reviewStage: submission.reviewStage === "collector_todo" ? "collector_todo" : "parsed",
        preclassification,
        normalizedUrl,
        canonicalChannelKey: canonicalKey,
        duplicateOfSubmissionId: submission.duplicateOfSubmissionId,
      }),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new Error("提交记录不存在或已被处理。");

  return mapSubmissionRow(updated);
}

export async function recordSubmissionProbeResult(
  id: string,
  result: SubmissionProbeResult,
): Promise<ChannelSubmission> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data: row, error } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("提交记录不存在。");
  if (row.status !== "pending") throw new Error("该提交已被处理。");

  const submission = mapSubmissionRow(row);
  const checkedAt = new Date().toISOString();
  const success = result.status === "success" && Number(result.offerCount || 0) > 0;
  const collectorKind = normalizeCollectorKind(result.kind) || normalizeCollectorKind(submission.parsedMeta.suggested_collector_kind);
  const runtimeIssue = !success && isRuntimeCollectionIssue(result.message || "");
  const knownCollector = collectorKind && collectorKind !== "browser" && collectorKind !== "unsupported";
  const supportStatus = success
    ? "probe_success"
    : runtimeIssue && knownCollector
      ? "known_collector_probe_failed"
      : knownCollector
        ? "known_collector_probe_failed"
        : "needs_collector";
  const supportReason = success
    ? `试采集成功，识别到 ${Number(result.offerCount || 0)} 条报价。`
    : runtimeIssue && knownCollector
      ? `已识别 ${collectorKind} 采集器，但本次运行触发验证或风控；可先确认解析器入库，后续云端和本地采集脚本都会继续尝试。`
      : result.message || "当前采集器暂不支持，需要加入采集器待办后补解析脚本。";
  const resolvedSourceMeta = success
    ? resolveSubmissionSourceFromProbeResult(submission, result, collectorKind)
    : {};
  const nextMeta = await enrichSubmissionReviewMeta({
    ...submission.parsedMeta,
    ...resolvedSourceMeta,
    probe_result: result,
    probe_checked_at: checkedAt,
    suggested_collector_kind: collectorKind || submission.parsedMeta.suggested_collector_kind,
    review_stage: success ? "ready_to_approve" : knownCollector ? "known_collector_probe_failed" : "needs_collector_review",
    support_status: supportStatus,
    support_reason: supportReason,
  }, {
    submissionId: submission.id,
    submittedName: submission.name,
    submittedUrl: submission.url,
    submittedAt: submission.createdAt,
    parsedTitle: submission.parsedTitle,
    contact: submission.contact,
    notes: submission.notes,
  });
  const reviewStage: SubmissionReviewStage = success
    ? "ready_to_approve"
    : knownCollector
      ? "known_collector_probe_failed"
      : "needs_collector_review";
  const nextSubmission = { ...submission, parsedMeta: nextMeta, reviewStage };
  const preclassification = await buildStoredSubmissionPreclassification(nextSubmission, nextMeta);

  const { data: updated, error: updateError } = await supabase
    .from("channel_submissions")
    .update({
      parsed_meta: nextMeta,
      ...submissionReviewColumns({
        reviewStage,
        preclassification,
        duplicateOfSubmissionId: submission.duplicateOfSubmissionId,
      }),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new Error("提交记录不存在或已被处理。");

  return mapSubmissionRow(updated);
}

export async function queueSubmissionProbeJob(
  id: string,
  input: SubmissionProbeQueueInput,
): Promise<{ submission: ChannelSubmission; result: SubmissionProbeResult; jobId: string }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data: row, error } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("提交记录不存在。");
  if (row.status !== "pending") throw new Error("该提交已被处理。");

  const submission = mapSubmissionRow(row);
  const queuedAt = new Date().toISOString();
  const collectorKind = normalizeCollectorKind(input.collectorKind) ||
    normalizeCollectorKind(submission.parsedMeta.suggested_collector_kind) ||
    "shopApi";
  const sourceUrl = input.sourceUrl;
  const parsedSourceUrl = safeUrl(sourceUrl);
  const sourceHost = parsedSourceUrl ? normalizeHostname(parsedSourceUrl.hostname) : "";
  const shopToken = parsedSourceUrl ? getShopToken(parsedSourceUrl.pathname) : null;
  const sourceName =
    input.sourceName ||
    getSuggestedSourceName(submission.parsedMeta) ||
    submission.name ||
    (sourceHost ? inferSubmittedSourceName(sourceHost, submission.parsedTitle, shopToken) : null) ||
    submission.parsedTitle ||
    sourceUrl;
  const sourceId = input.sourceId ||
    getSuggestedSourceId(submission.parsedMeta) ||
    (sourceHost ? inferSubmittedSourceId(sourceHost, sourceName, shopToken) : stableId("submission-probe-source", sourceName, sourceUrl));
  const baseUrl = input.baseUrl || deriveBaseUrl(sourceUrl);
  const { data: activeJobs, error: activeJobError } = await supabase
    .from("collection_jobs")
    .select("id,status")
    .eq("requested_by", "submission_probe")
    .in("status", ["pending", "running"])
    .contains("result", { intent: "submission_probe", submissionId: id })
    .order("created_at", { ascending: false })
    .limit(1);
  if (activeJobError) throw activeJobError;
  const activeJob = activeJobs?.[0];
  if (activeJob) {
    const existingProbe = getStoredProbeResult(submission.parsedMeta);
    const result: SubmissionProbeResult = existingProbe && (existingProbe.status === "queued" || existingProbe.status === "running")
      ? existingProbe
      : {
          sourceId,
          sourceName,
          sourceUrl,
          baseUrl: baseUrl || undefined,
          kind: collectorKind,
          status: activeJob.status === "running" ? "running" : "queued",
          offerCount: 0,
          offers: [],
          message: activeJob.status === "running" ? "轻量采集节点正在执行试采集。" : "已在低频试采集队列中，等待轻量采集节点领取。",
        };
    return { submission, result, jobId: String(activeJob.id) };
  }
  const jobId = stableId("submission-probe", id, sourceId, queuedAt);
  const result: SubmissionProbeResult = {
    sourceId,
    sourceName,
    sourceUrl,
    baseUrl: baseUrl || undefined,
    kind: collectorKind,
    status: "queued",
    offerCount: 0,
    offers: [],
    finishedAt: queuedAt,
    message: "已加入低频试采集队列，等待支持 submissionProbe 的轻量采集节点领取。",
  };

  const { error: jobError } = await supabase.from("collection_jobs").insert({
    id: jobId,
    job_type: "source",
    source_id: null,
    source_name: sourceName,
    status: "pending",
    priority: 35,
    attempts: 0,
    max_attempts: 2,
    requested_by: "submission_probe",
    result: {
      intent: "submission_probe",
      submissionId: id,
      sourceId,
      sourceName,
      sourceUrl,
      baseUrl,
      collectorKind,
      queuedAt,
      noWriteBack: true,
    },
    created_at: queuedAt,
    updated_at: queuedAt,
  });
  if (jobError) throw jobError;

  const nextMeta = await enrichSubmissionReviewMeta({
    ...submission.parsedMeta,
    probe_result: result,
    probe_checked_at: queuedAt,
    probe_job_id: jobId,
    suggested_source_id: sourceId,
    suggested_source_name: sourceName,
    suggested_collection_method: "http",
    suggested_collector_kind: collectorKind,
    canonical_source_url: sourceUrl,
    review_stage: "probe_queued",
    support_status: "probe_queued",
    support_reason: result.message,
  }, {
    submissionId: submission.id,
    submittedName: submission.name,
    submittedUrl: submission.url,
    submittedAt: submission.createdAt,
    parsedTitle: submission.parsedTitle,
    contact: submission.contact,
    notes: submission.notes,
  });
  const nextSubmission = { ...submission, parsedMeta: nextMeta, reviewStage: "probe_queued" as const };
  const preclassification = await buildStoredSubmissionPreclassification(nextSubmission, nextMeta);

  const { data: updated, error: updateError } = await supabase
    .from("channel_submissions")
    .update({
      parsed_meta: nextMeta,
      ...submissionReviewColumns({
        reviewStage: "probe_queued",
        preclassification,
        duplicateOfSubmissionId: submission.duplicateOfSubmissionId,
      }),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (updateError || !updated) {
    await supabase.from("collection_jobs").delete().eq("id", jobId).eq("status", "pending");
    if (updateError) throw updateError;
    throw new Error("提交记录不存在或已被处理。");
  }

  return { submission: mapSubmissionRow(updated), result, jobId };
}

export async function markSubmissionCollectorTodo(id: string, note?: string | null): Promise<ChannelSubmission> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data: row, error } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("提交记录不存在。");
  if (row.status !== "pending") throw new Error("该提交已被处理。");

  const submission = mapSubmissionRow(row);
  const todoAt = new Date().toISOString();
  const reason = note?.trim() || "当前没有可用自动采集器，需要补解析脚本后重新试采集。";
  const nextMeta = {
    ...submission.parsedMeta,
    review_stage: "collector_todo",
    collector_todo_at: todoAt,
    collector_todo_reason: reason,
    support_status: "needs_collector",
    support_reason: reason,
  };
  const nextSubmission = { ...submission, parsedMeta: nextMeta, reviewStage: "collector_todo" as const };
  const preclassification = await buildStoredSubmissionPreclassification(nextSubmission, nextMeta);

  const { data: updated, error: updateError } = await supabase
    .from("channel_submissions")
    .update({
      parsed_meta: nextMeta,
      reviewer_note: reason,
      ...submissionReviewColumns({
        reviewStage: "collector_todo",
        preclassification,
        duplicateOfSubmissionId: submission.duplicateOfSubmissionId,
      }),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new Error("提交记录不存在或已被处理。");

  return mapSubmissionRow(updated);
}

export async function approveSubmission(
  id: string,
  overrides: {
    name?: string | null;
    sourceUrl?: string | null;
    collectionMethod?: CollectionMethod;
    collectorKind?: CollectorKind | null;
  } = {},
): Promise<{ submission: ChannelSubmission; source: Source; importedOfferCount: number; matchedExistingSource: boolean }> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data: row, error } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("提交记录不存在。");
  if (row.status !== "pending") throw new Error("该提交已被处理。");

  const submission = mapSubmissionRow(row);
  const manualSourceUrl = normalizeOverrideSourceUrl(overrides.sourceUrl);
  const canonicalSourceUrl = manualSourceUrl || getCanonicalSourceUrl(submission.parsedMeta) || submission.url;
  const duplicatePending = await findPreferredPendingSubmissionByCanonicalUrl(canonicalSourceUrl, {
    submissionId: submission.id,
    submittedName: submission.name,
    submittedUrl: submission.url,
    submittedAt: submission.createdAt,
    parsedTitle: submission.parsedTitle,
    contact: submission.contact,
    notes: submission.notes,
    currentMeta: submission.parsedMeta,
  });
  if (duplicatePending) {
    throw new Error(`该渠道已有信息更完整的待审记录：${duplicatePending.name || duplicatePending.parsedTitle || duplicatePending.url}。请处理主记录或忽略重复提交。`);
  }
  const baseUrl = deriveBaseUrl(canonicalSourceUrl);
  const suggestedMethod = getSuggestedCollectionMethod(submission.parsedMeta);
  const suggestedCollectorKind = getSuggestedCollectorKind(submission.parsedMeta);
  const selectedCollectorKind = overrides.collectorKind || suggestedCollectorKind;
  const suggestedId = getSuggestedSourceId(submission.parsedMeta);
  const existingSourceId = getExistingSourceId(submission.parsedMeta);
  const existingSource = await findExistingSourceForApproval(existingSourceId || suggestedId, canonicalSourceUrl);
  const storedProbe = getStoredProbeResult(submission.parsedMeta);
  const hasProbeOffers = storedProbe?.status === "success" && Array.isArray(storedProbe.offers) && storedProbe.offers.length > 0;
  const hasRunnableCollector = Boolean(
    selectedCollectorKind &&
    selectedCollectorKind !== "auto" &&
    selectedCollectorKind !== "browser" &&
    selectedCollectorKind !== "unsupported"
  );
  if (!existingSource && !hasProbeOffers && !hasRunnableCollector) {
    throw new Error("请先试采集成功；或手动指定一个已支持采集器后再通过。");
  }

  const approvalStartedAt = new Date().toISOString();
  const { error: approvalStartError } = await supabase
    .from("channel_submissions")
    .update({
      review_stage: "approval_in_progress",
      parsed_meta: {
        ...submission.parsedMeta,
        review_stage: "approval_in_progress",
        approval_started_at: approvalStartedAt,
      },
    })
    .eq("id", id)
    .eq("status", "pending");
  if (approvalStartError && !isMissingSubmissionReviewContractError(approvalStartError)) throw approvalStartError;
  const fallbackName =
    overrides.name?.trim() ||
    submission.name ||
    getSuggestedSourceName(submission.parsedMeta) ||
    submission.parsedTitle ||
    (baseUrl ? new URL(baseUrl).host : submission.url);

  let source =
    existingSource ||
    await upsertSource({
      id: suggestedId,
      name: fallbackName,
      entryUrl: canonicalSourceUrl,
      baseUrl,
      collectionMethod: overrides.collectionMethod || suggestedMethod || "http",
      collectorKind: selectedCollectorKind,
      enabled: false,
      notes: submission.notes ? `用户提交：${submission.notes}` : "由用户提交渠道入口审核通过。",
    });

  if (existingSource && selectedCollectorKind) {
    source = await upsertSource({
      id: existingSource.id,
      name: existingSource.name || fallbackName,
      entryUrl: canonicalSourceUrl,
      baseUrl,
      collectionMethod: overrides.collectionMethod || existingSource.collectionMethod || suggestedMethod || "http",
      collectorKind: selectedCollectorKind || existingSource.collectorKind || null,
      enabled: existingSource.enabled,
      notes: existingSource.notes,
    });
  }

  const importedOffers = getProbeOffersForImport(submission.parsedMeta, source, canonicalSourceUrl);
  const importedOfferResult = importedOffers.length
    ? await upsertRawOffers(importedOffers, { collectionMethod: source.collectionMethod === "manual" ? "http" : source.collectionMethod })
    : { receivedCount: 0, writtenCount: 0, unchangedCount: 0, refreshedCount: 0, confirmedCount: 0 };
  const importedOfferCount = importedOfferResult.receivedCount;

  const reviewedAt = new Date().toISOString();
  if (importedOfferCount) {
    const { error: logError } = await supabase.from("crawl_runs").insert({
      id: stableId(source.name, submission.url, reviewedAt),
      source_id: source.id,
      source_name: source.name,
      mode: source.collectionMethod === "manual" ? "http" : source.collectionMethod,
      status: "success",
      started_at: reviewedAt,
      finished_at: reviewedAt,
      success_count: importedOfferCount,
      failure_count: 0,
      message: `审核通过时从试采集结果读取 ${importedOfferCount} 条报价，写入 ${importedOfferResult.writtenCount} 条，刷新 ${importedOfferResult.refreshedCount} 条。`,
      details: {
        review_action: "submission_approve",
        submission_id: submission.id,
        matched_existing_source: Boolean(existingSource),
        collector: selectedCollectorKind || null,
        writeStats: {
          receivedCount: importedOfferResult.receivedCount,
          writtenCount: importedOfferResult.writtenCount,
          unchangedCount: importedOfferResult.unchangedCount,
          refreshedCount: importedOfferResult.refreshedCount,
          confirmedCount: importedOfferResult.confirmedCount,
        },
      },
    });
    if (logError) throw logError;
    await pruneOperationalLogs(supabase);
  }

  const nextMeta = {
    ...submission.parsedMeta,
    review_stage: "approved",
    approved_at: reviewedAt,
    approved_source_id: source.id,
    approved_offer_count: importedOfferCount,
    matched_existing_source: Boolean(existingSource),
    approved_collector_kind: selectedCollectorKind || null,
    approved_source_url: canonicalSourceUrl,
    manual_source_url: manualSourceUrl,
  };
  const approvedClassification = storedPreclassification(classifySubmission({
    probe: storedProbe as ReviewSubmissionProbeResult | null,
    suggestedCollector: selectedCollectorKind,
    existingSourceName: existingSource?.name || null,
  }), reviewedAt);
  const { data: finalizedRows, error: updateError } = await supabase.rpc("finalize_channel_submission_approval", {
    p_submission_id: id,
    p_source_id: source.id,
    p_parsed_meta: nextMeta,
    p_reviewed_at: reviewedAt,
    p_preclassification: approvedClassification,
    p_classification_version: approvedClassification.version || null,
  });
  if (updateError) throw updateError;
  const updated = Array.isArray(finalizedRows) ? finalizedRows[0] : finalizedRows;
  if (!updated) throw new Error("提交记录不存在或已被处理。");
  source = { ...source, enabled: true, updatedAt: reviewedAt };

  return {
    submission: updated ? mapSubmissionRow(updated) : { ...submission, status: "approved", approvedSourceId: source.id, reviewedAt },
    source,
    importedOfferCount,
    matchedExistingSource: Boolean(existingSource),
  };
}

export async function rejectSubmission(id: string, note?: string | null): Promise<ChannelSubmission> {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置。");

  const { data: currentRow, error: currentError } = await supabase
    .from("channel_submissions")
    .select("*")
    .eq("id", id)
    .eq("status", "pending")
    .maybeSingle();
  if (currentError) throw currentError;
  if (!currentRow) throw new Error("提交记录不存在或已被处理。");
  const current = mapSubmissionRow(currentRow);
  const reviewedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("channel_submissions")
    .update({
      status: "rejected",
      reviewer_note: note?.trim() || null,
      reviewed_at: reviewedAt,
      review_stage: "rejected",
      parsed_meta: { ...current.parsedMeta, review_stage: "rejected", rejected_at: reviewedAt },
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("提交记录不存在或已被处理。");

  return mapSubmissionRow(data);
}

export async function markSubmissionApprovalFailed(id: string, reason: string): Promise<void> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return;
  const { data, error } = await supabase
    .from("channel_submissions")
    .select("id,status,review_stage,parsed_meta")
    .eq("id", id)
    .maybeSingle();
  if (error || !data || data.status !== "pending" || data.review_stage !== "approval_in_progress") return;
  const meta = data.parsed_meta && typeof data.parsed_meta === "object" && !Array.isArray(data.parsed_meta)
    ? data.parsed_meta as Record<string, unknown>
    : {};
  await supabase.from("channel_submissions").update({
    review_stage: "approval_failed",
    reviewer_note: reason.slice(0, 500),
    parsed_meta: {
      ...meta,
      review_stage: "approval_failed",
      approval_failed_at: new Date().toISOString(),
      approval_error: reason.slice(0, 1000),
    },
  }).eq("id", id).eq("status", "pending");
}

async function getSourceById(id: string): Promise<Source | null> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("sources")
    .select("id,name,base_url,entry_url,collection_method,collector_kind,enabled,notes,updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapSourceRow(data) : null;
}

async function findExistingSourceForApproval(suggestedId: string | null, sourceUrl: string): Promise<Source | null> {
  const byEntryUrl = await findSourceRowByEntryUrl(sourceUrl);
  if (byEntryUrl) return mapSourceRow(byEntryUrl);

  const byId = suggestedId ? await getSourceById(suggestedId) : null;
  return byId;
}

function getProbeOffersForImport(
  meta: Record<string, unknown>,
  source: Source,
  fallbackUrl: string,
): OfferInput[] {
  const probe = getStoredProbeResult(meta);
  if (!probe || probe.status !== "success" || !Array.isArray(probe.offers)) return [];

  const offers: OfferInput[] = [];
  for (const offer of probe.offers) {
    const sourceTitle = stringValue(offer.sourceTitle) || stringValue(offer.title);
    const url = stringValue(offer.url) || fallbackUrl;
    if (!sourceTitle || !url) continue;

    offers.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.entryUrl || fallbackUrl,
      sourceStoreName: stringValue(offer.sourceStoreName) || source.name,
      sourceTitle,
      price: numberValue(offer.price),
      currency: stringValue(offer.currency) || "CNY",
      status: normalizeStatus(stringValue(offer.status)),
      url,
      tags: Array.isArray(offer.tags) ? offer.tags.map(String).filter(Boolean) : [],
      stockCount: numberValue(offer.stockCount),
    });
  }

  return offers;
}

function getStoredProbeResult(meta: Record<string, unknown>): SubmissionProbeResult | null {
  const value = meta.probe_result;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SubmissionProbeResult)
    : null;
}

function resolveSubmissionSourceFromProbeResult(
  submission: ChannelSubmission,
  result: SubmissionProbeResult,
  collectorKind: CollectorKind | null,
): Record<string, unknown> {
  const sourceUrl =
    firstProbeOfferSourceUrl(result) ||
    stringValue(result.sourceUrl) ||
    stringValue(submission.parsedMeta.canonical_source_url);
  const parsed = safeUrl(sourceUrl);
  if (!parsed) return {};

  const host = normalizeHostname(parsed.hostname);
  const shopToken = getShopToken(parsed.pathname);
  if (isSharedShopApiPlatformHost(host) && !shopToken) return {};

  const sourceName =
    firstProbeOfferSourceName(result) ||
    stringValue(result.sourceName) ||
    submission.name ||
    getSuggestedSourceName(submission.parsedMeta) ||
    inferSubmittedSourceName(host, submission.parsedTitle, shopToken);
  const normalizedSourceUrl = normalizeSourceEntryUrl(parsed.toString()) || parsed.toString();

  return {
    canonical_source_status: "resolved",
    canonical_source_reason: "已通过试采集结果反查到真实店铺入口，审核通过时会按该渠道入口入库。",
    canonical_source_url: normalizedSourceUrl,
    shop_token: shopToken,
    suggested_source_name: sourceName,
    suggested_source_id: inferSubmittedSourceId(host, sourceName, shopToken),
    suggested_collection_method: "http",
    suggested_collector_kind: collectorKind || submission.parsedMeta.suggested_collector_kind,
  };
}

function firstProbeOfferSourceUrl(result: SubmissionProbeResult): string | null {
  if (!Array.isArray(result.offers)) return null;
  for (const offer of result.offers) {
    if (!offer || typeof offer !== "object" || Array.isArray(offer)) continue;
    const sourceUrl = stringValue((offer as Record<string, unknown>).sourceUrl);
    if (sourceUrl) return sourceUrl;
  }
  return null;
}

function firstProbeOfferSourceName(result: SubmissionProbeResult): string | null {
  if (!Array.isArray(result.offers)) return null;
  for (const offer of result.offers) {
    if (!offer || typeof offer !== "object" || Array.isArray(offer)) continue;
    const record = offer as Record<string, unknown>;
    const sourceName = stringValue(record.sourceStoreName) || stringValue(record.sourceName);
    if (sourceName) return sourceName;
  }
  return null;
}

function getSuggestedSourceName(meta: Record<string, unknown>): string | null {
  return typeof meta.suggested_source_name === "string" && meta.suggested_source_name.trim()
    ? meta.suggested_source_name.trim()
    : null;
}

function getSuggestedSourceId(meta: Record<string, unknown>): string | null {
  return typeof meta.suggested_source_id === "string" && meta.suggested_source_id.trim()
    ? meta.suggested_source_id.trim()
    : null;
}

function getExistingSourceId(meta: Record<string, unknown>): string | null {
  return typeof meta.existing_source_id === "string" && meta.existing_source_id.trim()
    ? meta.existing_source_id.trim()
    : null;
}

function getCanonicalSourceUrl(meta: Record<string, unknown>): string | null {
  return typeof meta.canonical_source_url === "string" && meta.canonical_source_url.trim()
    ? meta.canonical_source_url.trim()
    : null;
}

function normalizeOverrideSourceUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("手动渠道入口 URL 格式不正确。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("手动渠道入口仅支持 http/https。");
  }

  return parsed.toString();
}

function getSuggestedCollectionMethod(meta: Record<string, unknown>): CollectionMethod | null {
  const value = typeof meta.suggested_collection_method === "string" ? meta.suggested_collection_method : "";
  return value === "public_json" || value === "browser" || value === "http" || value === "manual"
    ? value
    : null;
}

function getSuggestedCollectorKind(meta: Record<string, unknown>): CollectorKind | null {
  return normalizeCollectorKind(meta.suggested_collector_kind);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
