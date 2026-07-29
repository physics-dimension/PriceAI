import "server-only";

import type {
  TransitAvailability,
  TransitAvailabilityMatchLevel,
  TransitAvailabilityScope,
  TransitAvailabilitySourceType,
  TransitCollectionStatus,
  TransitModelFamily,
  TransitMultiplierHistoryPoint,
  TransitModelPrice,
  TransitStation,
} from "@/data/api-transit/types";
import {
  isTransitModelFamily,
  isTransitStandardModel,
} from "@/data/api-transit/types";
import { seedStations } from "@/data/api-transit/stations";
import {
  buildTransitModelIndex,
  compactTransitStationsForList,
  getTransitRecentAvailabilitySampleLookupScopes,
  isTransitModelIndex,
  type TransitModelIndex,
  withTransitCommercialOfferDisclosure,
} from "@/lib/api-transit";
import { readPublicApiSnapshot, writePublicApiSnapshot } from "@/lib/public-api-snapshots";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { getSupabaseServerClient } from "@/lib/supabase";

let cached: TransitStation[] | null = null;
let cachedAt = 0;
const cachedBySlug = new Map<string, { station: TransitStation; cachedAt: number }>();
let hasWarnedMissingEnhancementColumns = false;
let hasWarnedMissingHistoryTable = false;
const CACHE_TTL_MS = 30_000;
const PUBLIC_TRANSIT_READ_TIMEOUT_MS = 2_500;
const PUBLIC_TRANSIT_REFRESH_READ_TIMEOUT_MS = 15_000;
const PUBLIC_TRANSIT_BUILD_READ_TIMEOUT_MS = 15_000;
const API_TRANSIT_SNAPSHOT_KEY = "default";
const API_TRANSIT_MODEL_INDEX_SNAPSHOT_KEY = "models:v1";
const API_TRANSIT_SNAPSHOT_MAX_STALE_MS = 10 * 60 * 1000;
const NEXT_PRODUCTION_BUILD_PHASE = "phase-production-build";
const TRANSIT_HISTORY_DAYS = 45;
const TRANSIT_HISTORY_STATION_LIMIT = 320;
const TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIMIT = 60;
const TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIST_ROW_LIMIT = 24_000;
const TRANSIT_RECENT_AVAILABILITY_SAMPLE_DETAIL_ROW_LIMIT = 2400;
const TRANSIT_RECENT_AVAILABILITY_SAMPLE_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const STATION_CORE_BASE_COLUMNS = [
  "id",
  "slug",
  "name",
  "website_url",
  "api_base_url",
  "status",
  "source_type",
  "commercial_relation",
  "station_system",
  "operator_type",
  "invoice_support",
  "summary",
  "collector_kind",
  "channel_types",
  "account_pools",
  "payment_methods",
  "minimum_top_up",
  "balance_expiry",
  "support_channels",
  "refund_policy",
  "risk_labels",
  "usage_advice",
  "data_status",
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
  "feedback_pending_count",
  "feedback_verified_risk_count",
  "feedback_merchant_responded_count",
  "feedback_main_themes",
  "feedback_public_notes",
  "collection_status",
  "collection_error",
  "last_collected_at",
  "last_updated_at",
  "updated_at",
];
const STATION_CORE_COLUMNS = STATION_CORE_BASE_COLUMNS.join(",");
const STATION_OPERATOR_COLUMNS = ["operator_type", "invoice_support"] as const;
const STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED = withoutColumns(
  STATION_CORE_BASE_COLUMNS,
  "availability_first_checked_at"
);
const STATION_CORE_COLUMNS_WITHOUT_LATENCY = withoutColumns(
  STATION_CORE_BASE_COLUMNS,
  "availability_latest_latency_ms",
  "availability_avg_latency_7d_ms"
);
const STATION_CORE_COLUMNS_WITHOUT_AVAILABILITY_SOURCE = withoutColumns(
  STATION_CORE_BASE_COLUMNS,
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE = withoutColumns(
  STATION_CORE_BASE_COLUMNS,
  "availability_first_checked_at",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const STATION_CORE_COLUMNS_WITHOUT_LATENCY_OR_AVAILABILITY_SOURCE = withoutColumns(
  STATION_CORE_BASE_COLUMNS,
  "availability_latest_latency_ms",
  "availability_avg_latency_7d_ms",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const STATION_CORE_COLUMNS_WITHOUT_API_BASE_URL = withoutColumns(
  STATION_CORE_BASE_COLUMNS,
  "api_base_url",
  "availability_first_checked_at",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const STATION_CORE_COLUMNS_WITHOUT_API_BASE_URL_OR_STATION_SYSTEM = withoutColumn(
  STATION_CORE_COLUMNS_WITHOUT_API_BASE_URL,
  "station_system"
);
const STATION_ENHANCEMENT_COLUMNS = [
  "id",
  "logo_url",
  "monitor_url",
  "strengths",
  "cautions",
  "commercial_offers",
  "verification_events",
].join(",");
const STATION_ENHANCEMENT_COLUMNS_WITHOUT_LOGO = [
  "id",
  "monitor_url",
  "strengths",
  "cautions",
  "commercial_offers",
  "verification_events",
].join(",");
const OFFER_BASE_COLUMNS = [
  "id",
  "station_id",
  "family",
  "standard_model",
  "group_name",
  "recharge_ratio",
  "billing_mode",
  "model_multiplier",
  "input_price",
  "output_price",
  "cache_read_price",
  "cache_write_price",
  "cache_hit_rate",
  "cache_hit_sample_tokens",
  "image_output_price",
  "fixed_price",
  "fixed_price_currency",
  "fixed_price_unit",
  "fixed_price_tiers",
  "currency",
  "account_pool",
  "channel_type",
  "price_source",
  "last_verified_at",
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
  "availability_scope",
  "availability_match_level",
  "monitoring_scope_id",
];
const OFFER_AVAILABILITY_EVIDENCE_COLUMNS = [
  "availability_scope",
  "availability_match_level",
  "monitoring_scope_id",
] as const;
const OFFER_FIXED_PRICE_COLUMNS = [
  "billing_mode",
  "fixed_price",
  "fixed_price_currency",
  "fixed_price_unit",
  "fixed_price_tiers",
] as const;
const OFFER_COLUMNS = OFFER_BASE_COLUMNS.join(",");
const OFFER_COLUMNS_WITH_RAW_PAYLOAD = `${OFFER_COLUMNS},raw_payload`;
const OFFER_COLUMNS_WITHOUT_CACHE_HIT = withoutColumns(OFFER_BASE_COLUMNS, "cache_hit_rate", "cache_hit_sample_tokens");
const OFFER_COLUMNS_WITHOUT_LATENCY = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_latest_latency_ms",
  "availability_avg_latency_7d_ms"
);
const OFFER_COLUMNS_WITHOUT_LATENCY_OR_CACHE_HIT = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_latest_latency_ms",
  "availability_avg_latency_7d_ms",
  "cache_hit_rate",
  "cache_hit_sample_tokens"
);
const OFFER_COLUMNS_WITHOUT_LATENCY_OR_AVAILABILITY_SOURCE = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_latest_latency_ms",
  "availability_avg_latency_7d_ms",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const OFFER_COLUMNS_WITHOUT_IMAGE_OUTPUT = withoutColumns(OFFER_BASE_COLUMNS, "image_output_price");
const OFFER_COLUMNS_WITHOUT_FIRST_CHECKED = withoutColumns(OFFER_BASE_COLUMNS, "availability_first_checked_at");
const OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_OR_IMAGE_OUTPUT = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_first_checked_at",
  "image_output_price"
);
const OFFER_COLUMNS_WITHOUT_AVAILABILITY_SOURCE = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const OFFER_COLUMNS_WITHOUT_CACHE_HIT_OR_AVAILABILITY_SOURCE = withoutColumns(
  OFFER_BASE_COLUMNS,
  "cache_hit_rate",
  "cache_hit_sample_tokens",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const OFFER_COLUMNS_WITHOUT_LATENCY_CACHE_HIT_OR_AVAILABILITY_SOURCE = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_latest_latency_ms",
  "availability_avg_latency_7d_ms",
  "cache_hit_rate",
  "cache_hit_sample_tokens",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const OFFER_COLUMNS_WITHOUT_IMAGE_OUTPUT_OR_AVAILABILITY_SOURCE = withoutColumns(
  OFFER_BASE_COLUMNS,
  "image_output_price",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_first_checked_at",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);
const OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_IMAGE_OUTPUT_OR_AVAILABILITY_SOURCE = withoutColumns(
  OFFER_BASE_COLUMNS,
  "availability_first_checked_at",
  "image_output_price",
  "availability_source_type",
  "availability_source_label",
  "availability_source_url"
);

function withoutColumns(columns: string[], ...excluded: string[]): string {
  const excludedSet = new Set(excluded);
  return columns.filter((column) => !excludedSet.has(column)).join(",");
}

export function clearTransitStationsCache(): void {
  cached = null;
  cachedAt = 0;
  cachedBySlug.clear();
}

export type TransitStationsSnapshotRefreshResult = {
  generatedAt: string;
  snapshotWritten: boolean;
  modelIndexWritten: boolean;
  slugs: string[];
  stationCount: number;
  modelCount: number;
};

type TransitStationsReadOptions = {
  signal?: AbortSignal;
};

export async function refreshTransitStationsSnapshot(): Promise<TransitStationsSnapshotRefreshResult> {
  const generatedAt = new Date().toISOString();
  const stations = await readStationsFromSupabase({ signal: publicTransitRefreshReadSignal() });

  setTransitStationsCache(stations, new Date(generatedAt).getTime());
  const modelIndex = buildTransitModelIndex(compactTransitStationsForList(stations), generatedAt);
  const [snapshotWritten, modelIndexWritten] = await Promise.all([
    writeTransitStationsSnapshot(stations, generatedAt),
    writeTransitModelIndexSnapshot(modelIndex, generatedAt),
  ]);

  return {
    generatedAt,
    snapshotWritten,
    modelIndexWritten,
    slugs: stations.map((station) => station.slug),
    stationCount: stations.length,
    modelCount: modelIndex.summaries.length,
  };
}

export async function getTransitStations(): Promise<TransitStation[]> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

  const staleMemory = cached && cached.length ? cached : null;
  const snapshot = await readTransitStationsSnapshot();
  if (snapshot?.fresh) {
    setTransitStationsCache(snapshot.stations, now);
    return snapshot.stations;
  }

  try {
    const stations = await readStationsFromSupabase();
    setTransitStationsCache(stations, now);
    if (!hasStaticDemoTransitStations(stations)) await writeTransitStationsSnapshot(stations);
    return stations;
  } catch (error) {
    const fallback = filterStaticDemoTransitStations(staleMemory || snapshot?.stations || []);
    if (fallback.length) {
      console.warn("Using cached API transit stations because Supabase read failed:", error);
      setTransitStationsCache(fallback, now);
      return fallback;
    }
    const demoFallback = staticTransitDemoFallbackStations("Supabase read failed");
    if (demoFallback.length) {
      console.warn("Falling back to static API transit demo stations because Supabase read failed:", error);
      setTransitStationsCache(demoFallback, now);
      return demoFallback;
    }
    console.warn("Rendering API transit as empty because Supabase read failed and no public fallback is available:", error);
    setTransitStationsCache([], now);
    return [];
  }
}

function setTransitStationsCache(stations: TransitStation[], cachedAtValue = Date.now()): void {
  cached = stations;
  cachedAt = cachedAtValue;
  cachedBySlug.clear();
  for (const station of cached) {
    cacheStationLookup(station, cachedAt);
  }
}

function cacheStationLookup(station: TransitStation, cachedAtValue: number, ...aliases: string[]): void {
  for (const key of [station.slug, station.id, ...aliases]) {
    if (key) cachedBySlug.set(key, { station, cachedAt: cachedAtValue });
  }
}

async function readTransitStationsSnapshot(): Promise<{ stations: TransitStation[]; fresh: boolean } | null> {
  const snapshot = await readPublicApiSnapshot<TransitStation[]>("api_transit", API_TRANSIT_SNAPSHOT_KEY);
  if (!snapshot || !isTransitStationsSnapshot(snapshot.value)) return null;

  const stations = filterStaticDemoTransitStations(snapshot.value);
  if (!stations.length) return null;

  const generatedAt = new Date(snapshot.generatedAt).getTime();
  return {
    stations,
    fresh: Number.isFinite(generatedAt) && Date.now() - generatedAt <= API_TRANSIT_SNAPSHOT_MAX_STALE_MS,
  };
}

async function writeTransitStationsSnapshot(
  stations: TransitStation[],
  generatedAt?: string,
): Promise<boolean> {
  return writePublicApiSnapshot({
    kind: "api_transit",
    key: API_TRANSIT_SNAPSHOT_KEY,
    payload: stations,
    generatedAt,
  });
}

export async function readTransitModelIndexSnapshot(): Promise<{
  index: TransitModelIndex;
  fresh: boolean;
} | null> {
  const snapshot = await readPublicApiSnapshot<TransitModelIndex>(
    "api_transit",
    API_TRANSIT_MODEL_INDEX_SNAPSHOT_KEY,
  );
  if (!snapshot || !isTransitModelIndex(snapshot.value)) return null;

  const generatedAt = new Date(snapshot.generatedAt).getTime();
  return {
    index: snapshot.value,
    fresh: Number.isFinite(generatedAt) && Date.now() - generatedAt <= API_TRANSIT_SNAPSHOT_MAX_STALE_MS,
  };
}

async function writeTransitModelIndexSnapshot(
  index: TransitModelIndex,
  generatedAt?: string,
): Promise<boolean> {
  return writePublicApiSnapshot({
    kind: "api_transit",
    key: API_TRANSIT_MODEL_INDEX_SNAPSHOT_KEY,
    payload: index,
    generatedAt,
  });
}

function isTransitStationsSnapshot(value: unknown): value is TransitStation[] {
  return Array.isArray(value) && value.every((station) => {
    if (!station || typeof station !== "object") return false;
    const record = station as Record<string, unknown>;
    return typeof record.slug === "string" && typeof record.name === "string";
  });
}

function filterStaticDemoTransitStations(stations: TransitStation[]): TransitStation[] {
  if (shouldUseStaticTransitDemoFallback()) return stations;
  return stations.filter((station) => !isStaticDemoTransitStation(station));
}

function hasStaticDemoTransitStations(stations: TransitStation[]): boolean {
  return stations.some(isStaticDemoTransitStation);
}

function isStaticDemoTransitStation(station: TransitStation): boolean {
  const riskLabels = Array.isArray(station.riskLabels) ? station.riskLabels : [];
  return (
    station.id.startsWith("stn-") ||
    riskLabels.includes("sample_data")
  );
}

function staticTransitDemoFallbackStations(reason: string): TransitStation[] {
  if (shouldUseStaticTransitDemoFallback()) return seedStations;
  console.warn(`API transit ${reason}; returning empty public data instead of static demo stations.`);
  return [];
}

function shouldUseStaticTransitDemoFallback(): boolean {
  const override = getRuntimeEnv("PRICEAI_ENABLE_API_TRANSIT_SEED_FALLBACK")?.trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes") return true;
  if (override === "0" || override === "false" || override === "no") return false;
  return process.env.NODE_ENV !== "production";
}

export async function getTransitStationBySlug(
  slug: string,
  options: { includeHistory?: boolean } = {}
): Promise<TransitStation | undefined> {
  const cachedStation = getCachedStationBySlug(slug);
  if (!options.includeHistory && cachedStation) return cachedStation;

  let station: TransitStation | undefined;
  try {
    station = await readStationFromSupabaseBySlug(slug);
  } catch (error) {
    station = await getTransitStationFallbackBySlug(slug);
    if (!station) {
      console.warn(
        `Returning no API transit station for ${slug} because the live read failed and no fallback was available:`,
        error
      );
      return undefined;
    }
    console.warn(`Using fallback API transit station for ${slug} because the live read failed:`, error);
  }

  if (!station || !options.includeHistory) return station;
  return getTransitStationDetailData(station);
}

export async function getTransitStationDetailData(station: TransitStation): Promise<TransitStation> {
  return enrichStationWithDetailData(station);
}

async function getTransitStationFallbackBySlug(slug: string): Promise<TransitStation | undefined> {
  const cachedStation = getCachedStationBySlug(slug, { allowStale: true });
  if (cachedStation) return cachedStation;

  const snapshot = await readTransitStationsSnapshot();
  const snapshotStation = snapshot ? findTransitStationBySlug(snapshot.stations, slug) : undefined;
  if (snapshotStation) {
    cacheStationLookup(snapshotStation, Date.now(), slug);
    return snapshotStation;
  }

  return findTransitStationBySlug(staticTransitDemoFallbackStations("station detail fallback is unavailable"), slug);
}

function getCachedStationBySlug(
  slug: string,
  options: { allowStale?: boolean } = {}
): TransitStation | undefined {
  const now = Date.now();
  if (cached && (options.allowStale || now - cachedAt < CACHE_TTL_MS)) {
    return findTransitStationBySlug(cached, slug);
  }
  const entry = cachedBySlug.get(slug);
  if (!entry || (!options.allowStale && now - entry.cachedAt >= CACHE_TTL_MS)) return undefined;
  return entry.station;
}

function findTransitStationBySlug(stations: TransitStation[], slug: string): TransitStation | undefined {
  return stations.find((item) => item.slug === slug || item.id === slug);
}

async function readStationsFromSupabase(options: TransitStationsReadOptions = {}): Promise<TransitStation[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase) return staticTransitDemoFallbackStations("Supabase is not configured");
  const client = supabase;
  const signal = options.signal || publicTransitReadSignal();

  try {
    const [stationsResult, offerRows] = await Promise.all([
      queryPublishedStationRows(supabase, signal),
      readPublicOfferRows(supabase, signal),
    ]);

    const stationRows = stationsResult;
    if (!stationRows.length) return [];
    const stationIds = stationRows.map((row) => stringValue(row.id)).filter(Boolean);
    const sampleRowLimit = Math.min(
      TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIST_ROW_LIMIT,
      Math.max(stationRows.length + offerRows.length, 1) * TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIMIT
    );
    const [enhancementRows, recentSampleRows] = await Promise.all([
      readStationEnhancementRows(),
      readTransitRowsOrEmpty(
        "recent availability samples",
        () => readRecentAvailabilitySampleRows(supabase, stationIds, sampleRowLimit, signal)
      ),
    ]);
    const enhancementsByStation = new Map<string, DbRow>();
    for (const row of enhancementRows) {
      const id = stringValue(row.id);
      if (id) enhancementsByStation.set(id, row);
    }
    const recentSamplesByKey = buildRecentAvailabilitySamplesByKey(recentSampleRows);

    const offersByStation = new Map<string, DbRow[]>();
    for (const offer of offerRows) {
      const stationId = stringValue(offer.station_id);
      if (!stationId) continue;
      offersByStation.set(stationId, [...(offersByStation.get(stationId) || []), offer]);
    }

    return stationRows.map((row) => {
      const id = stringValue(row.id);
      return mapStationRow(
        row,
        offersByStation.get(id) || [],
        enhancementsByStation.get(id),
        new Map(),
        recentSamplesByKey
      );
    });
  } catch (error) {
    console.warn("API transit Supabase read failed:", error);
    throw error;
  }

  async function readStationEnhancementRows(): Promise<DbRow[]> {
    async function queryStationEnhancementRows(columns: string, filterRemoved: boolean): Promise<DbRow[]> {
      let query = client
        .from("api_transit_stations")
        .select(columns)
        .eq("published", true);
      if (filterRemoved) query = query.is("removed_at", null);
      const { data, error } = await query.abortSignal(signal);
      if (error) throw error;
      return dbRows(data);
    }

    const attempts = [STATION_ENHANCEMENT_COLUMNS, STATION_ENHANCEMENT_COLUMNS_WITHOUT_LOGO];
    let lastError: unknown = null;
    for (const columns of attempts) {
      try {
        return await queryStationEnhancementRows(columns, true);
      } catch (error) {
        if (isMissingRemovedAtColumnError(error)) {
          try {
            return await queryStationEnhancementRows(columns, false);
          } catch (fallbackError) {
            if (!isMissingColumnError(fallbackError)) throw fallbackError;
            lastError = fallbackError;
            continue;
          }
        }
        if (!isMissingColumnError(error)) throw error;
        lastError = error;
      }
    }
    if (!hasWarnedMissingEnhancementColumns) {
      hasWarnedMissingEnhancementColumns = true;
      console.warn("API transit station enhancement columns are unavailable:", lastError);
    }
    return [];
  }

}

async function readStationFromSupabaseBySlug(slug: string): Promise<TransitStation | undefined> {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return staticTransitDemoFallbackStations("Supabase is not configured")
      .find((station) => station.slug === slug || station.id === slug);
  }

  const stationRow = (await queryPublishedStationRows(supabase, publicTransitReadSignal(), slug))[0];
  if (!stationRow) return undefined;

  const stationId = stringValue(stationRow.id);
  if (!stationId) return undefined;

  const signal = publicTransitReadSignal();
  const [offerRows, enhancementRow, recentSampleRows] = await Promise.all([
    readTransitRowsOrEmpty(
      `offers for station ${stationId}`,
      () => readPublicOfferRows(supabase, signal, stationId, { includeRawPayload: true })
    ),
    readTransitRowOrUndefined(
      `enhancement for station ${stationId}`,
      () => readStationEnhancementRow(supabase, stationId, signal)
    ),
    readTransitRowsOrEmpty(
      `recent availability samples for station ${stationId}`,
      () => readRecentAvailabilitySampleRows(
        supabase,
        [stationId],
        TRANSIT_RECENT_AVAILABILITY_SAMPLE_DETAIL_ROW_LIMIT,
        signal
      )
    ),
  ]);

  const station = mapStationRow(
    stationRow,
    offerRows,
    enhancementRow,
    new Map(),
    buildRecentAvailabilitySamplesByKey(recentSampleRows)
  );
  cacheStationLookup(station, Date.now(), slug);
  return station;
}

async function readTransitRowsOrEmpty(label: string, readRows: () => Promise<DbRow[]>): Promise<DbRow[]> {
  try {
    return await readRows();
  } catch (error) {
    console.warn(`Rendering API transit data without ${label} because the read failed:`, error);
    return [];
  }
}

async function readTransitRowOrUndefined(
  label: string,
  readRow: () => Promise<DbRow | undefined>
): Promise<DbRow | undefined> {
  try {
    return await readRow();
  } catch (error) {
    console.warn(`Rendering API transit data without ${label} because the read failed:`, error);
    return undefined;
  }
}

async function readPublicOfferRows(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  signal: AbortSignal,
  stationId?: string,
  options: { includeRawPayload?: boolean } = {}
): Promise<DbRow[]> {
  const baseAttempts = [
    ...(options.includeRawPayload ? [OFFER_COLUMNS_WITH_RAW_PAYLOAD] : []),
    OFFER_COLUMNS,
    OFFER_COLUMNS_WITHOUT_LATENCY,
    OFFER_COLUMNS_WITHOUT_CACHE_HIT,
    OFFER_COLUMNS_WITHOUT_LATENCY_OR_CACHE_HIT,
    OFFER_COLUMNS_WITHOUT_AVAILABILITY_SOURCE,
    OFFER_COLUMNS_WITHOUT_LATENCY_OR_AVAILABILITY_SOURCE,
    OFFER_COLUMNS_WITHOUT_CACHE_HIT_OR_AVAILABILITY_SOURCE,
    OFFER_COLUMNS_WITHOUT_LATENCY_CACHE_HIT_OR_AVAILABILITY_SOURCE,
  ];
  const attempts = withOfferAvailabilityEvidenceFallbacks(withOfferFixedPriceColumnFallbacks(baseAttempts));
  let lastError: unknown = null;
  for (const columns of attempts) {
    try {
      return await queryPublicOfferRows(client, signal, columns, stationId);
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      lastError = error;
    }
  }
  return readPublicOfferRowsWithoutNewOptionalColumns(client, signal, stationId, lastError);
}

async function readPublicOfferRowsWithoutNewOptionalColumns(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  signal: AbortSignal,
  stationId?: string,
  previousError: unknown = null
): Promise<DbRow[]> {
  const baseAttempts = [
    OFFER_COLUMNS_WITHOUT_FIRST_CHECKED,
    withoutColumnsFromSelect(OFFER_COLUMNS_WITHOUT_FIRST_CHECKED, "cache_hit_rate", "cache_hit_sample_tokens"),
    OFFER_COLUMNS_WITHOUT_IMAGE_OUTPUT,
    withoutColumnsFromSelect(OFFER_COLUMNS_WITHOUT_IMAGE_OUTPUT, "cache_hit_rate", "cache_hit_sample_tokens"),
    OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_OR_IMAGE_OUTPUT,
    withoutColumnsFromSelect(OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_OR_IMAGE_OUTPUT, "cache_hit_rate", "cache_hit_sample_tokens"),
    OFFER_COLUMNS_WITHOUT_IMAGE_OUTPUT_OR_AVAILABILITY_SOURCE,
    withoutColumnsFromSelect(OFFER_COLUMNS_WITHOUT_IMAGE_OUTPUT_OR_AVAILABILITY_SOURCE, "cache_hit_rate", "cache_hit_sample_tokens"),
    OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE,
    withoutColumnsFromSelect(OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE, "cache_hit_rate", "cache_hit_sample_tokens"),
    OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_IMAGE_OUTPUT_OR_AVAILABILITY_SOURCE,
    withoutColumnsFromSelect(OFFER_COLUMNS_WITHOUT_FIRST_CHECKED_IMAGE_OUTPUT_OR_AVAILABILITY_SOURCE, "cache_hit_rate", "cache_hit_sample_tokens"),
  ];
  const attempts = withOfferAvailabilityEvidenceFallbacks(Array.from(new Set(baseAttempts.flatMap((columns) => [
    columns,
    withoutColumnsFromSelect(columns, ...OFFER_FIXED_PRICE_COLUMNS),
    withoutColumnsFromSelect(columns, "availability_latest_latency_ms", "availability_avg_latency_7d_ms"),
    withoutColumnsFromSelect(columns, "availability_latest_latency_ms", "availability_avg_latency_7d_ms", ...OFFER_FIXED_PRICE_COLUMNS),
  ]))));
  let lastError: unknown = previousError;
  for (const columns of attempts) {
    try {
      return await queryPublicOfferRows(client, signal, columns, stationId);
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function withOfferFixedPriceColumnFallbacks(columns: string[]): string[] {
  return Array.from(new Set(columns.flatMap((columnList) => [
    columnList,
    withoutColumnsFromSelect(columnList, ...OFFER_FIXED_PRICE_COLUMNS),
  ])));
}

function withOfferAvailabilityEvidenceFallbacks(columns: string[]): string[] {
  return Array.from(new Set(columns.flatMap((columnList) => [
    columnList,
    withoutColumnsFromSelect(columnList, ...OFFER_AVAILABILITY_EVIDENCE_COLUMNS),
  ])));
}

async function queryPublishedStationRows(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  signal: AbortSignal,
  slug?: string
): Promise<DbRow[]> {
  const attempts = Array.from(new Set([
    STATION_CORE_COLUMNS,
    STATION_CORE_COLUMNS_WITHOUT_LATENCY,
    withoutColumnsFromSelect(STATION_CORE_COLUMNS, ...STATION_OPERATOR_COLUMNS),
    withoutColumnsFromSelect(STATION_CORE_COLUMNS_WITHOUT_LATENCY, ...STATION_OPERATOR_COLUMNS),
    withoutColumn(STATION_CORE_COLUMNS, "station_system"),
    withoutColumn(STATION_CORE_COLUMNS_WITHOUT_LATENCY, "station_system"),
    withoutColumnsFromSelect(withoutColumn(STATION_CORE_COLUMNS, "station_system"), ...STATION_OPERATOR_COLUMNS),
    withoutColumnsFromSelect(withoutColumn(STATION_CORE_COLUMNS_WITHOUT_LATENCY, "station_system"), ...STATION_OPERATOR_COLUMNS),
    STATION_CORE_COLUMNS_WITHOUT_AVAILABILITY_SOURCE,
    STATION_CORE_COLUMNS_WITHOUT_LATENCY_OR_AVAILABILITY_SOURCE,
    withoutColumnsFromSelect(STATION_CORE_COLUMNS_WITHOUT_AVAILABILITY_SOURCE, ...STATION_OPERATOR_COLUMNS),
    withoutColumn(STATION_CORE_COLUMNS_WITHOUT_AVAILABILITY_SOURCE, "station_system"),
    withoutColumnsFromSelect(withoutColumn(STATION_CORE_COLUMNS_WITHOUT_AVAILABILITY_SOURCE, "station_system"), ...STATION_OPERATOR_COLUMNS),
    STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED,
    withoutColumnsFromSelect(STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED, ...STATION_OPERATOR_COLUMNS),
    withoutColumn(STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED, "station_system"),
    withoutColumnsFromSelect(withoutColumn(STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED, "station_system"), ...STATION_OPERATOR_COLUMNS),
    STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE,
    withoutColumnsFromSelect(STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE, ...STATION_OPERATOR_COLUMNS),
    withoutColumn(STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE, "station_system"),
    withoutColumnsFromSelect(withoutColumn(STATION_CORE_COLUMNS_WITHOUT_FIRST_CHECKED_OR_AVAILABILITY_SOURCE, "station_system"), ...STATION_OPERATOR_COLUMNS),
    STATION_CORE_COLUMNS_WITHOUT_API_BASE_URL,
    withoutColumnsFromSelect(STATION_CORE_COLUMNS_WITHOUT_API_BASE_URL, ...STATION_OPERATOR_COLUMNS),
    STATION_CORE_COLUMNS_WITHOUT_API_BASE_URL_OR_STATION_SYSTEM,
    withoutColumnsFromSelect(STATION_CORE_COLUMNS_WITHOUT_API_BASE_URL_OR_STATION_SYSTEM, ...STATION_OPERATOR_COLUMNS),
  ]));

  let lastMissingColumnError: unknown = null;
  for (const columns of attempts) {
    try {
      return await queryStationRows(client, signal, columns, slug);
    } catch (error) {
      if (isMissingRemovedAtColumnError(error)) {
        try {
          return await queryStationRows(client, signal, columns, slug, false);
        } catch (fallbackError) {
          if (!isMissingColumnError(fallbackError)) throw fallbackError;
          lastMissingColumnError = fallbackError;
          continue;
        }
      }
      if (!isMissingColumnError(error)) throw error;
      lastMissingColumnError = error;
    }
  }

  throw lastMissingColumnError;
}

async function queryStationRows(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  signal: AbortSignal,
  columns: string,
  slug?: string,
  filterRemoved = true
): Promise<DbRow[]> {
  let query = client
    .from("api_transit_stations")
    .select(columns)
    .eq("published", true);
  if (filterRemoved) query = query.is("removed_at", null);
  query = query.order("last_updated_at", { ascending: false }).abortSignal(signal);
  if (slug) query = query.eq("slug", slug).limit(1);
  const { data, error } = await query;
  if (error) throw error;
  const rows = dbRows(data);
  if (rows.length || !slug) return rows;

  let fallbackQuery = client
    .from("api_transit_stations")
    .select(columns)
    .eq("published", true)
    .eq("id", slug);
  if (filterRemoved) fallbackQuery = fallbackQuery.is("removed_at", null);
  const fallback = await fallbackQuery
    .order("last_updated_at", { ascending: false })
    .limit(1)
    .abortSignal(signal);
  if (fallback.error) throw fallback.error;
  return dbRows(fallback.data);
}

async function queryPublicOfferRows(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  signal: AbortSignal,
  columns: string,
  stationId?: string
): Promise<DbRow[]> {
  let query = client
    .from("api_transit_offers")
    .select(columns)
    .eq("status", "active")
    .order("standard_model", { ascending: true })
    .abortSignal(signal);

  if (stationId) query = query.eq("station_id", stationId);
  const { data, error } = await query;
  if (error) throw error;
  return dbRows(data);
}

async function readStationEnhancementRow(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  stationId: string,
  signal: AbortSignal
): Promise<DbRow | undefined> {
  try {
    const { data, error } = await client
      .from("api_transit_stations")
      .select(STATION_ENHANCEMENT_COLUMNS)
      .eq("id", stationId)
      .limit(1)
      .abortSignal(signal);
    if (error) throw error;
    return dbRows(data)[0];
  } catch (error) {
    if (isMissingColumnError(error)) {
      return readStationEnhancementRowWithoutLogo(client, stationId, signal);
    }
    if (!hasWarnedMissingEnhancementColumns) {
      hasWarnedMissingEnhancementColumns = true;
      console.warn("API transit station enhancement columns are unavailable:", error);
    }
    return undefined;
  }
}

async function readStationEnhancementRowWithoutLogo(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  stationId: string,
  signal: AbortSignal
): Promise<DbRow | undefined> {
  try {
    const { data, error } = await client
      .from("api_transit_stations")
      .select(STATION_ENHANCEMENT_COLUMNS_WITHOUT_LOGO)
      .eq("id", stationId)
      .limit(1)
      .abortSignal(signal);
    if (error) throw error;
    return dbRows(data)[0];
  } catch (fallbackError) {
    if (!hasWarnedMissingEnhancementColumns) {
      hasWarnedMissingEnhancementColumns = true;
      console.warn("API transit station enhancement columns are unavailable:", fallbackError);
    }
    return undefined;
  }
}

async function enrichStationWithDetailData(station: TransitStation): Promise<TransitStation> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !station.prices.length) return station;

  const cutoff = new Date(Date.now() - TRANSIT_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const signal = publicTransitReadSignal();
  try {
    const [historyResult, samplesResult, recentSampleRows] = await Promise.all([
      supabase
        .from("api_transit_multiplier_history")
        .select(
          [
            "station_id",
            "family",
            "standard_model",
            "group_name",
            "recharge_ratio",
            "recharge_coefficient",
            "model_multiplier",
            "combined_rate",
            "price_source",
            "observed_at",
          ].join(",")
        )
        .eq("station_id", station.id)
        .gte("observed_at", cutoff)
        .order("observed_at", { ascending: false })
        .limit(TRANSIT_HISTORY_STATION_LIMIT)
        .abortSignal(signal),
      supabase
        .from("api_transit_availability_samples")
        .select("scope,standard_model,group_name,checked_at")
        .eq("station_id", station.id)
        .gte("checked_at", cutoff)
        .order("checked_at", { ascending: true })
        .limit(1200)
        .abortSignal(signal),
      readRecentAvailabilitySampleRows(
        supabase,
        [station.id],
        TRANSIT_RECENT_AVAILABILITY_SAMPLE_DETAIL_ROW_LIMIT,
        signal
      ),
    ]);
    if (historyResult.error) throw historyResult.error;
    if (samplesResult.error && !isMissingTableError(samplesResult.error)) throw samplesResult.error;

    const historyByOffer = new Map<string, TransitMultiplierHistoryPoint[]>();
    for (const row of dbRows(historyResult.data)) {
      const key = historyKey(row);
      if (!key) continue;
      historyByOffer.set(key, [...(historyByOffer.get(key) || []), mapHistoryRow(row)]);
    }
    for (const points of historyByOffer.values()) {
      points.sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime());
    }

    const availabilityWindows = buildAvailabilityWindows(dbRows(samplesResult.data), station.id);
    const recentSamplesByKey = buildRecentAvailabilitySamplesByKey(recentSampleRows);
    const stationWindow = availabilityWindows.get(availabilityWindowKey(station.id, "station", "", ""));
    const preferPublicStatusSamples = shouldPreferPublicStatusAvailability(station.availability);

    return {
      ...station,
      availability: {
        ...station.availability,
        firstCheckedAt: earliestTimestamp(station.availability.firstCheckedAt, stationWindow?.first),
        lastCheckedAt: station.availability.lastCheckedAt || stationWindow?.last || null,
        recentSamples:
          getRecentAvailabilitySamplesForScope(
            recentSamplesByKey,
            station.id,
            "station",
            "",
            "",
            station.availability.sourceType,
            { preferPublicStatusSamples }
          ) || station.availability.recentSamples,
      },
      prices: station.prices.map((price) => ({
        ...price,
        availability: {
          ...price.availability,
          firstCheckedAt: earliestTimestamp(
            price.availability.firstCheckedAt,
            availabilityWindows.get(availabilityWindowKey(station.id, "offer", price.standardModel, price.groupName))?.first
          ),
          lastCheckedAt:
            price.availability.lastCheckedAt ||
            availabilityWindows.get(availabilityWindowKey(station.id, "offer", price.standardModel, price.groupName))?.last ||
            null,
          recentSamples:
            price.availability.sevenDaySamples > 0 && price.availability.sevenDayRate !== null
              ? getRecentAvailabilitySamplesForScope(
                recentSamplesByKey,
                station.id,
                "offer",
                price.standardModel,
                price.groupName,
                price.availability.sourceType,
                {
                  preferPublicStatusSamples:
                    preferPublicStatusSamples || shouldPreferPublicStatusAvailability(price.availability),
                }
              ) || price.availability.recentSamples
              : undefined,
        },
        history: historyByOffer.get(historyKey({
          station_id: station.id,
          family: price.family,
          standard_model: price.standardModel,
          group_name: price.groupName,
        })) || [],
      })),
    };
  } catch (error) {
    if (!isMissingTableError(error) && !isMissingColumnError(error) && !hasWarnedMissingHistoryTable) {
      hasWarnedMissingHistoryTable = true;
      console.warn("API transit multiplier history is unavailable:", error);
    }
    return station;
  }
}

function buildAvailabilityWindows(rows: DbRow[], stationId: string): Map<string, { first: string; last: string }> {
  const windows = new Map<string, { first: string; last: string }>();

  for (const row of rows) {
    const checkedAt = nullableTimestamp(row.checked_at);
    if (!checkedAt) continue;
    const key = availabilityWindowKey(
      stationId,
      stringValue(row.scope) === "offer" ? "offer" : "station",
      stringValue(row.standard_model),
      stringValue(row.group_name)
    );
    const existing = windows.get(key);
    if (!existing) {
      windows.set(key, { first: checkedAt, last: checkedAt });
      continue;
    }
    if (new Date(checkedAt).getTime() < new Date(existing.first).getTime()) existing.first = checkedAt;
    if (new Date(checkedAt).getTime() > new Date(existing.last).getTime()) existing.last = checkedAt;
  }

  return windows;
}

type RecentAvailabilitySamplesByKey = Map<string, NonNullable<TransitAvailability["recentSamples"]>>;
type RecentAvailabilitySampleOptions = {
  preferPublicStatusSamples?: boolean;
};

async function readRecentAvailabilitySampleRows(
  client: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  stationIds: string[],
  rowLimit: number,
  signal: AbortSignal = publicTransitReadSignal()
): Promise<DbRow[]> {
  const ids = Array.from(new Set(stationIds.filter(Boolean)));
  if (!ids.length || rowLimit <= 0) return [];
  const since = new Date(Date.now() - TRANSIT_RECENT_AVAILABILITY_SAMPLE_LOOKBACK_MS).toISOString();
  const perScopeLimit = Math.min(TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIMIT, Math.max(1, rowLimit));

  const scopedRpcResult = await client
    .rpc("list_recent_api_transit_availability_sample_scopes", {
      p_station_ids: ids,
      p_limit_per_scope: perScopeLimit,
      p_since: since,
    })
    .abortSignal(signal);
  if (!scopedRpcResult.error) return expandRecentAvailabilitySampleScopeRows(scopedRpcResult.data);
  if (!isMissingRecentAvailabilitySampleScopesRpc(scopedRpcResult.error)) throw scopedRpcResult.error;

  const rpcResult = await client
    .rpc("list_recent_api_transit_availability_samples", {
      p_station_ids: ids,
      p_limit_per_scope: perScopeLimit,
      p_since: since,
    })
    .abortSignal(signal);
  if (!rpcResult.error) return dbRows(rpcResult.data);
  if (!isMissingRecentAvailabilitySamplesRpc(rpcResult.error)) throw rpcResult.error;

  const query = () => client
    .from("api_transit_availability_samples")
    .select("station_id,scope,standard_model,group_name,ok,checked_at,source_type")
    .in("station_id", ids)
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(rowLimit)
    .abortSignal(signal);

  const { data, error } = await query();

  if (error && isMissingColumnError(error)) {
    const fallback = await client
      .from("api_transit_availability_samples")
      .select("station_id,scope,standard_model,group_name,ok,checked_at")
      .in("station_id", ids)
      .gte("checked_at", since)
      .order("checked_at", { ascending: false })
      .limit(rowLimit)
      .abortSignal(signal);
    if (fallback.error) {
      if (isMissingTableError(fallback.error) || isMissingColumnError(fallback.error)) return [];
      throw fallback.error;
    }
    return dbRows(fallback.data);
  }

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return dbRows(data);
}

function expandRecentAvailabilitySampleScopeRows(value: unknown): DbRow[] {
  return dbRows(value).flatMap((row) => {
    const samples = Array.isArray(row.samples) ? row.samples : [];
    return samples.flatMap((sample) => {
      if (!sample || typeof sample !== "object") return [];
      const record = sample as Record<string, unknown>;
      return [{
        station_id: row.station_id,
        scope: row.scope,
        standard_model: row.standard_model,
        group_name: row.group_name,
        source_type: row.source_type,
        ok: record.ok,
        checked_at: record.checked_at,
      }];
    });
  });
}

function buildRecentAvailabilitySamplesByKey(rows: DbRow[]): RecentAvailabilitySamplesByKey {
  const samplesByKey: RecentAvailabilitySamplesByKey = new Map();

  for (const row of rows) {
    const stationId = stringValue(row.station_id);
    const checkedAt = nullableTimestamp(row.checked_at);
    if (!stationId || !checkedAt) continue;
    const scope = stringValue(row.scope) === "offer" ? "offer" : "station";
    const standardModel = stringValue(row.standard_model);
    const groupName = stringValue(row.group_name);
    const sourceType = availabilitySourceType(stringValue(row.source_type));
    const sample = {
      ok: booleanValue(row.ok),
      checkedAt,
    };
    for (const lookupScope of getTransitRecentAvailabilitySampleLookupScopes(standardModel, groupName, {
      includeStationFallback: scope === "station",
    })) {
      appendRecentAvailabilitySample(
        samplesByKey,
        availabilityWindowKey(stationId, scope, lookupScope.standardModel, lookupScope.groupName, lookupScope.family),
        sourceType,
        sample
      );
    }
  }

  for (const [key, samples] of samplesByKey.entries()) {
    samplesByKey.set(key, normalizeRecentAvailabilitySamples(samples));
  }

  return samplesByKey;
}

function getRecentAvailabilitySamplesForScope(
  samplesByKey: RecentAvailabilitySamplesByKey,
  stationId: string,
  scope: "station" | "offer",
  standardModel: string,
  groupName: string,
  sourceType: TransitAvailabilitySourceType,
  options: RecentAvailabilitySampleOptions = {}
): TransitAvailability["recentSamples"] {
  const publicStatusSamples = getRecentAvailabilitySamplesBySource(
    samplesByKey,
    stationId,
    scope,
    standardModel,
    groupName,
    "public_status"
  );
  if (publicStatusSamples?.length) return publicStatusSamples;
  if (options.preferPublicStatusSamples) return undefined;

  if (sourceType !== "unknown") {
    const sourceSamples = getRecentAvailabilitySamplesBySource(
      samplesByKey,
      stationId,
      scope,
      standardModel,
      groupName,
      sourceType
    );
    if (sourceSamples?.length) return sourceSamples;
  }
  return getRecentAvailabilitySamplesBySource(samplesByKey, stationId, scope, standardModel, groupName, null);
}

function recentAvailabilitySampleKey(baseKey: string, sourceType: TransitAvailabilitySourceType | null): string {
  return `${baseKey}|${sourceType || ""}`;
}

function recentAvailabilitySampleBaseKeys(
  stationId: string,
  scope: "station" | "offer",
  standardModel: string,
  groupName: string
): string[] {
  return getTransitRecentAvailabilitySampleLookupScopes(standardModel, groupName, {
    includeStationFallback: scope === "station",
  }).map((lookupScope) =>
    availabilityWindowKey(stationId, scope, lookupScope.standardModel, lookupScope.groupName, lookupScope.family)
  );
}

function getRecentAvailabilitySamplesBySource(
  samplesByKey: RecentAvailabilitySamplesByKey,
  stationId: string,
  scope: "station" | "offer",
  standardModel: string,
  groupName: string,
  sourceType: TransitAvailabilitySourceType | null
): TransitAvailability["recentSamples"] {
  for (const key of recentAvailabilitySampleBaseKeys(stationId, scope, standardModel, groupName)) {
    const samples = samplesByKey.get(recentAvailabilitySampleKey(key, sourceType));
    if (samples?.length) return samples;
  }
  return undefined;
}

function appendRecentAvailabilitySample(
  samplesByKey: RecentAvailabilitySamplesByKey,
  baseKey: string,
  sourceType: TransitAvailabilitySourceType,
  sample: NonNullable<TransitAvailability["recentSamples"]>[number]
): void {
  const scopedKey = recentAvailabilitySampleKey(baseKey, sourceType === "unknown" ? null : sourceType);
  samplesByKey.set(scopedKey, [...(samplesByKey.get(scopedKey) || []), sample]);
}

function normalizeRecentAvailabilitySamples(
  samples: NonNullable<TransitAvailability["recentSamples"]>
): NonNullable<TransitAvailability["recentSamples"]> {
  const deduped = new Map<string, NonNullable<TransitAvailability["recentSamples"]>[number]>();
  for (const sample of samples) {
    const key = sample.checkedAt || `missing:${deduped.size}`;
    if (!deduped.has(key)) deduped.set(key, sample);
  }

  return Array.from(deduped.values())
    .map((sample, index) => ({
      ok: sample.ok,
      checkedAt: sample.checkedAt,
      index,
    }))
    .sort((left, right) => {
      const diff = timestampSortValue(left.checkedAt) - timestampSortValue(right.checkedAt);
      return diff || left.index - right.index;
    })
    .slice(-TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIMIT)
    .map(({ ok, checkedAt }) => ({ ok, checkedAt }));
}

function availabilityWindowKey(
  stationId: string,
  scope: "station" | "offer",
  standardModel: string,
  groupName: string,
  family: TransitModelFamily | null = null
): string {
  return [stationId, scope, standardModel || "", groupName || "", family || ""].join("|");
}

type DbRow = Record<string, unknown>;

function publicTransitReadSignal(): AbortSignal {
  return AbortSignal.timeout(publicTransitReadTimeoutMs());
}

function publicTransitRefreshReadSignal(): AbortSignal {
  return AbortSignal.timeout(PUBLIC_TRANSIT_REFRESH_READ_TIMEOUT_MS);
}

function publicTransitReadTimeoutMs(): number {
  return process.env.NEXT_PHASE === NEXT_PRODUCTION_BUILD_PHASE
    ? PUBLIC_TRANSIT_BUILD_READ_TIMEOUT_MS
    : PUBLIC_TRANSIT_READ_TIMEOUT_MS;
}

function mapStationRow(
  row: DbRow,
  offerRows: DbRow[],
  enhancementRow?: DbRow,
  historyByOffer: Map<string, TransitMultiplierHistoryPoint[]> = new Map(),
  recentSamplesByKey: RecentAvailabilitySamplesByKey = new Map()
): TransitStation {
  const id = stringValue(row.id);
  const updatedAt = timestampValue(row.last_updated_at || row.updated_at);
  const enhancement = enhancementRow || {};
  const source = availabilitySourceFromRow(row);
  const preferPublicStatusSamples = shouldPreferPublicStatusSamples(row, enhancement, source);
  const stationRecentSamples = getRecentAvailabilitySamplesForScope(
    recentSamplesByKey,
    id,
    "station",
    "",
    "",
    source.type,
    { preferPublicStatusSamples }
  );

  return {
    id,
    slug: stringValue(row.slug) || id,
    name: stringValue(row.name) || id,
    websiteUrl: stringValue(row.website_url),
    apiBaseUrl: nullableString(row.api_base_url),
    logoUrl: nullableString(enhancement.logo_url),
    monitorUrl: nullableString(enhancement.monitor_url),
    collectorKind: nullableString(row.collector_kind),
    status: stationStatus(row.status),
    sourceType: sourceType(row.source_type),
    commercialRelation: commercialRelation(row.commercial_relation),
    stationSystem: stationSystem(row.station_system),
    operatorType: operatorType(row.operator_type),
    invoiceSupport: invoiceSupport(row.invoice_support),
    summary: stringValue(row.summary),
    channelTypes: enumArray(row.channel_types, isTransitChannelType),
    accountPools: enumArray(row.account_pools, isTransitAccountPool),
    paymentMethods: stringArray(row.payment_methods),
    minimumTopUp: nullableString(row.minimum_top_up),
    balanceExpiry: nullableString(row.balance_expiry),
    supportChannels: stringArray(row.support_channels),
    refundPolicy: nullableString(row.refund_policy),
    riskLabels: enumArray(row.risk_labels, isTransitRiskLabel),
    usageAdvice: usageAdvice(row.usage_advice),
    lastUpdatedAt: updatedAt,
    collectionStatus: collectionStatus(row.collection_status),
    collectionError: nullableString(row.collection_error),
    lastCollectedAt: nullableTimestamp(row.last_collected_at),
    dataStatus: dataStatus(row.data_status),
    availability: {
      sevenDayRate: numberValue(row.availability_seven_day_rate),
      sevenDaySamples: integerValue(row.availability_seven_day_samples) || 0,
      firstCheckedAt: nullableTimestamp(row.availability_first_checked_at),
      lastCheckedAt: nullableTimestamp(row.availability_last_checked_at),
      recentSamples: stationRecentSamples,
      latestLatencyMs: integerValue(row.availability_latest_latency_ms),
      avgLatency7dMs: integerValue(row.availability_avg_latency_7d_ms),
      note: nullableString(row.availability_note) || undefined,
      sourceType: source.type,
      sourceLabel: source.label,
      sourceUrl: source.url,
      scope: "station",
      matchLevel: "exact",
      monitoringScopeId: `station:${id}:${source.type}`,
    },
    prices: offerRows
      .map((offer) => mapOfferRow(offer, historyByOffer, recentSamplesByKey, { preferPublicStatusSamples }))
      .filter((price): price is TransitModelPrice => Boolean(price)),
    feedback: {
      pendingCount: integerValue(row.feedback_pending_count) || 0,
      verifiedRiskCount: integerValue(row.feedback_verified_risk_count) || 0,
      merchantRespondedCount: integerValue(row.feedback_merchant_responded_count) || 0,
      mainThemes: stringArray(row.feedback_main_themes),
      publicNotes: nullableString(row.feedback_public_notes),
    },
    strengths: stringArray(enhancement.strengths),
    cautions: stringArray(enhancement.cautions),
    commercialOffers: commercialOffers(enhancement.commercial_offers),
    verificationEvents: verificationEvents(enhancement.verification_events),
  };
}

function mapOfferRow(
  row: DbRow,
  historyByOffer: Map<string, TransitMultiplierHistoryPoint[]> = new Map(),
  recentSamplesByKey: RecentAvailabilitySamplesByKey = new Map(),
  options: RecentAvailabilitySampleOptions = {}
): TransitModelPrice | null {
  const family = modelFamily(row.family);
  const standardModel = standardModelValue(row.standard_model);
  if (!family || !standardModel) return null;
  const groupName = stringValue(row.group_name) || "默认分组";
  const source = availabilitySourceFromRow(row, nullableString(row.source_url));
  const stationId = stringValue(row.station_id);
  const sevenDayRate = numberValue(row.availability_seven_day_rate);
  const sevenDaySamples = integerValue(row.availability_seven_day_samples) || 0;
  const availabilityEvidence = availabilityEvidenceFromRow(row, source.type, family, standardModel, groupName);
  const recentSamples = sevenDaySamples > 0 && sevenDayRate !== null
    ? getRecentAvailabilitySamplesForScope(
        recentSamplesByKey,
        stationId,
        "offer",
        standardModel,
        groupName,
        source.type,
        options
      )
    : undefined;

  return {
    family,
    standardModel,
    groupName,
    rechargeRatio: nullableString(row.recharge_ratio),
    billingMode: billingMode(row.billing_mode),
    modelMultiplier: numberValue(row.model_multiplier),
    stationGroupMultiplier: stationGroupMultiplierFromRawPayload(row.raw_payload),
    inputPrice: numberValue(row.input_price),
    outputPrice: numberValue(row.output_price),
    cacheReadPrice: numberValue(row.cache_read_price),
    cacheWritePrice: numberValue(row.cache_write_price),
    imageOutputPrice: numberValue(row.image_output_price),
    fixedPrice: numberValue(row.fixed_price),
    fixedPriceCurrency: fixedPriceCurrency(row.fixed_price_currency),
    fixedPriceUnit: nullableString(row.fixed_price_unit),
    fixedPriceTiers: fixedPriceTiers(row.fixed_price_tiers),
    currency: "CNY",
    accountPool: accountPool(row.account_pool),
    channelType: channelType(row.channel_type),
    priceSource: stringValue(row.price_source) || "公开价格页",
    lastVerifiedAt: timestampValue(row.last_verified_at),
    availability: {
      sevenDayRate,
      sevenDaySamples,
      firstCheckedAt: nullableTimestamp(row.availability_first_checked_at),
      lastCheckedAt: nullableTimestamp(row.availability_last_checked_at),
      recentSamples,
      latestLatencyMs: integerValue(row.availability_latest_latency_ms),
      avgLatency7dMs: integerValue(row.availability_avg_latency_7d_ms),
      note: nullableString(row.availability_note) || undefined,
      sourceType: source.type,
      sourceLabel: source.label,
      sourceUrl: source.url,
      scope: availabilityEvidence.scope,
      matchLevel: availabilityEvidence.matchLevel,
      monitoringScopeId: availabilityEvidence.monitoringScopeId,
    },
    cacheUsage: transitCacheUsageFromRow(row),
    history: historyByOffer.get(historyKey({
      station_id: row.station_id,
      family,
      standard_model: standardModel,
      group_name: groupName,
    })) || [],
  };
}

function availabilityEvidenceFromRow(
  row: DbRow,
  sourceType: TransitAvailabilitySourceType,
  family: TransitModelFamily,
  standardModel: TransitModelPrice["standardModel"],
  groupName: string,
): {
  scope: TransitAvailabilityScope;
  matchLevel: TransitAvailabilityMatchLevel;
  monitoringScopeId: string;
} {
  const note = stringValue(row.availability_note);
  const storedScope = availabilityScope(row.availability_scope);
  const storedMatchLevel = availabilityMatchLevel(row.availability_match_level);
  const matchLevel = storedMatchLevel || inferAvailabilityMatchLevel(sourceType, note);
  const scope = storedScope || inferAvailabilityScope(sourceType, matchLevel, note);
  const scopeKey =
    scope === "station" ? stringValue(row.station_id) :
      scope === "group" ? groupName :
        scope === "model" && matchLevel === "family" ? family :
          scope === "model" ? standardModel :
            `${groupName}|${standardModel}`;
  return {
    scope,
    matchLevel,
    monitoringScopeId:
      nullableString(row.monitoring_scope_id) ||
      ["legacy", row.station_id, sourceType, scope, scopeKey].map(stringValue).join(":"),
  };
}

function inferAvailabilityMatchLevel(
  sourceType: TransitAvailabilitySourceType,
  note: string,
): TransitAvailabilityMatchLevel {
  if (/同模型族参考/.test(note)) return "family";
  if (/同模型监测|performance summary|uptime14d/i.test(note)) return "model";
  if (/同分组监测/.test(note)) return "group";
  if (sourceType === "public_model_catalog") return "model";
  if (sourceType === "public_status") return "group";
  return "exact";
}

function inferAvailabilityScope(
  sourceType: TransitAvailabilitySourceType,
  matchLevel: TransitAvailabilityMatchLevel,
  note: string,
): TransitAvailabilityScope {
  if (matchLevel === "group" || /分组监测/.test(note)) return "group";
  if (matchLevel === "model" || matchLevel === "family" || sourceType === "public_model_catalog") return "model";
  if (sourceType === "priceai_probe") return "offer";
  return "offer";
}

function stationGroupMultiplierFromRawPayload(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const group = (value as { group?: unknown }).group;
  if (!group || typeof group !== "object") return null;
  return numberValue((group as { rate_multiplier?: unknown }).rate_multiplier);
}

function billingMode(value: unknown): TransitModelPrice["billingMode"] {
  const text = nullableString(value);
  return text === "token" || text === "per_request" || text === "fixed" ? text : null;
}

function collectionStatus(value: unknown): TransitCollectionStatus | undefined {
  const text = nullableString(value);
  return text === "pending" || text === "success" || text === "partial" || text === "failed" || text === "manual_review"
    ? text
    : undefined;
}

function fixedPriceCurrency(value: unknown): TransitModelPrice["fixedPriceCurrency"] {
  return nullableString(value) === "CNY" ? "CNY" : null;
}

function fixedPriceTiers(value: unknown): NonNullable<TransitModelPrice["fixedPriceTiers"]> {
  if (!Array.isArray(value)) return [];
  const tiers: NonNullable<TransitModelPrice["fixedPriceTiers"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const label = nullableString((item as { label?: unknown }).label);
    const price = numberValue((item as { price?: unknown }).price);
    if (!label || price === null || price <= 0) continue;
    tiers.push({
      label,
      price,
      unit: nullableString((item as { unit?: unknown }).unit),
    });
  }
  return tiers;
}

function dbRows(value: unknown): DbRow[] {
  return Array.isArray(value) ? value.filter((item): item is DbRow => Boolean(item && typeof item === "object")) : [];
}

function isMissingColumnError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "42703" || (error as { code?: unknown }).code === "PGRST204")
  );
}

function isMissingRemovedAtColumnError(error: unknown): boolean {
  if (!isMissingColumnError(error) || !error || typeof error !== "object") return false;
  const value = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [value.message, value.details, value.hint]
    .some((item) => typeof item === "string" && item.includes("removed_at"));
}

function isMissingTableError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "42P01"
  );
}

function isMissingRecentAvailabilitySamplesRpc(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  return code === "PGRST202" || message.includes("list_recent_api_transit_availability_samples");
}

function isMissingRecentAvailabilitySampleScopesRpc(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  return code === "PGRST202" || message.includes("list_recent_api_transit_availability_sample_scopes");
}

function historyKey(row: DbRow): string {
  const stationId = stringValue(row.station_id);
  const family = stringValue(row.family);
  const standardModel = stringValue(row.standard_model);
  const groupName = stringValue(row.group_name);
  if (!stationId || !family || !standardModel || !groupName) return "";
  return [stationId, family, standardModel, groupName].join("|");
}

function mapHistoryRow(row: DbRow): TransitMultiplierHistoryPoint {
  return {
    observedAt: timestampValue(row.observed_at),
    rechargeRatio: nullableString(row.recharge_ratio),
    rechargeCoefficient: numberValue(row.recharge_coefficient),
    modelMultiplier: numberValue(row.model_multiplier),
    combinedRate: numberValue(row.combined_rate),
    priceSource: nullableString(row.price_source),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  if (typeof value === "number") return value === 1;
  return false;
}

function transitCacheUsageFromRow(row: DbRow): TransitModelPrice["cacheUsage"] {
  const hitRate = normalizedPercentRate(numberValue(row.cache_hit_rate));
  const sampleTokens = Math.max(0, integerValue(row.cache_hit_sample_tokens) || 0);

  if (hitRate === null && sampleTokens <= 0) return undefined;

  return {
    hitRate,
    sampleTokens,
  };
}

function normalizedPercentRate(value: number | null): number | null {
  if (value === null || value < 0) return null;
  return value > 1 ? Math.min(value / 100, 1) : Math.min(value, 1);
}

function integerValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function timestampValue(value: unknown): string {
  return nullableTimestamp(value) || new Date().toISOString();
}

function availabilitySourceType(value: unknown): TransitAvailabilitySourceType {
  const type = stringValue(value);
  return isTransitAvailabilitySourceType(type) ? type : "unknown";
}

function availabilityScope(value: unknown): TransitAvailabilityScope | null {
  const scope = stringValue(value);
  return scope === "station" || scope === "group" || scope === "model" || scope === "offer" ? scope : null;
}

function availabilityMatchLevel(value: unknown): TransitAvailabilityMatchLevel | null {
  const level = stringValue(value);
  return level === "exact" || level === "group" || level === "model" || level === "family" ? level : null;
}

function availabilitySourceFromRow(
  row: DbRow,
  fallbackUrl: string | null = null
): { type: TransitAvailabilitySourceType; label: string | null; url: string | null } {
  const storedType = availabilitySourceType(row.availability_source_type);
  const storedLabel = nullableString(row.availability_source_label);
  const storedUrl = nullableString(row.availability_source_url);

  if (isPublicSiteInfoAvailability(row) && (storedType === "unknown" || storedType === "manual_snapshot")) {
    return {
      type: "public_status",
      label: "公开来源",
      url: storedUrl || fallbackUrl,
    };
  }

  return {
    type: storedType,
    label: storedLabel,
    url: storedUrl,
  };
}

function shouldPreferPublicStatusSamples(
  row: DbRow,
  enhancement: DbRow,
  source: { type: TransitAvailabilitySourceType; url: string | null }
): boolean {
  return (
    source.type === "public_status" ||
    isPublicMonitorAvailabilityUrl(source.url) ||
    isPublicMonitorAvailabilityUrl(nullableString(enhancement.monitor_url)) ||
    isPublicMonitorAvailabilityUrl(nullableString(row.availability_source_url)) ||
    isPublicSiteInfoAvailability(row)
  );
}

function shouldPreferPublicStatusAvailability(
  availability: Pick<TransitAvailability, "sourceType" | "sourceUrl">
): boolean {
  return availability.sourceType === "public_status" || isPublicMonitorAvailabilityUrl(availability.sourceUrl);
}

function isPublicSiteInfoAvailability(row: DbRow): boolean {
  const text = [
    row.station_id,
    row.collector_kind,
    row.price_source,
    row.availability_note,
  ].map(stringValue).join(" ");
  return /(?:APINode\s*(?:公开)?\s*site-info|apinode_public_site_info|sub2api_public_site_info)/i.test(text);
}

function isPublicMonitorAvailabilityUrl(value: string | null | undefined): boolean {
  const text = value?.toLowerCase() || "";
  return Boolean(
    text &&
      (text.includes("view=monitoring") ||
        text.includes("/public/transit") ||
        text.includes("/status") ||
        text.includes("status.") ||
        text.includes("monitor"))
  );
}

function isTransitAvailabilitySourceType(value: string): value is TransitAvailabilitySourceType {
  return (
    value === "priceai_probe" ||
    value === "public_status" ||
    value === "public_model_catalog" ||
    value === "partner_api" ||
    value === "merchant_reported" ||
    value === "manual_snapshot" ||
    value === "unknown"
  );
}

function nullableTimestamp(value: unknown): string | null {
  const text = nullableString(value);
  if (!text) return null;
  return text;
}

function timestampSortValue(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const normalized = /^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(" ", "T") : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function earliestTimestamp(...values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(0) ?? null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => stringValue(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，\n|｜]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function objectArray(value: unknown): DbRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is DbRow => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function commercialOffers(value: unknown): NonNullable<TransitStation["commercialOffers"]> {
  const offers: NonNullable<TransitStation["commercialOffers"]> = [];
  objectArray(value).forEach((item, index) => {
    const offer: NonNullable<TransitStation["commercialOffers"]>[number] = {
      id: nullableString(item.id) || `offer-${index}`,
      type: commercialOfferType(item.type),
      title: stringValue(item.title),
      listLabel: nullableString(item.listLabel || item.list_label),
      description: nullableString(item.description),
      code: nullableString(item.code),
      url: nullableString(item.url),
      validUntil: nullableString(item.validUntil || item.valid_until),
      disclosure: nullableString(item.disclosure),
      enabled: item.enabled === undefined ? true : Boolean(item.enabled),
    };
    if (hasCommercialOfferContent(offer)) offers.push(withTransitCommercialOfferDisclosure(offer));
  });
  return offers;
}

function hasCommercialOfferContent(
  offer: Pick<NonNullable<TransitStation["commercialOffers"]>[number], "title" | "listLabel" | "description" | "code" | "url" | "validUntil">
): boolean {
  return Boolean(offer.title || offer.listLabel || offer.description || offer.code || offer.url || offer.validUntil);
}

function verificationEvents(value: unknown): NonNullable<TransitStation["verificationEvents"]> {
  return objectArray(value).map((item, index) => ({
    id: nullableString(item.id) || `event-${index}`,
    source: verificationEventSource(item.source),
    status: verificationEventStatus(item.status),
    title: stringValue(item.title) || "核验记录",
    description: nullableString(item.description),
    happenedAt: timestampValue(item.happenedAt || item.happened_at),
  })).filter((item) => item.title);
}

function commercialOfferType(value: unknown): NonNullable<TransitStation["commercialOffers"]>[number]["type"] {
  return value === "affiliate" || value === "sponsored" || value === "coupon" ? value : "coupon";
}

function verificationEventSource(value: unknown): NonNullable<TransitStation["verificationEvents"]>[number]["source"] {
  return value === "official" || value === "user" || value === "merchant" || value === "priceai" ? value : "priceai";
}

function verificationEventStatus(value: unknown): NonNullable<TransitStation["verificationEvents"]>[number]["status"] {
  return value === "warning" || value === "failed" || value === "info" || value === "success" ? value : "info";
}

function enumArray<T extends string>(value: unknown, guard: (value: string) => value is T): T[] {
  return stringArray(value).filter(guard);
}

function withoutColumn(columns: string, column: string): string {
  return columns
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== column)
    .join(",");
}

function withoutColumnsFromSelect(columns: string, ...excluded: readonly string[]): string {
  return columns
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && !excluded.includes(item))
    .join(",");
}

function stationStatus(value: unknown): TransitStation["status"] {
  const text = stringValue(value);
  return text === "active" || text === "limited" || text === "unavailable" || text === "unknown" ? text : "unknown";
}

function stationSystem(value: unknown): TransitStation["stationSystem"] {
  const text = stringValue(value);
  return text === "new_api" || text === "sub_to_api" || text === "custom" ? text : undefined;
}

function operatorType(value: unknown): TransitStation["operatorType"] {
  const text = stringValue(value);
  return text === "company" || text === "individual" ? text : "individual";
}

function invoiceSupport(value: unknown): TransitStation["invoiceSupport"] {
  const text = stringValue(value);
  return text === "supported" || text === "unsupported" || text === "unknown" ? text : "unknown";
}

function sourceType(value: unknown): TransitStation["sourceType"] {
  const text = stringValue(value);
  return text === "manual_collected" || text === "user_submitted" || text === "merchant_submitted" ? text : "manual_collected";
}

function commercialRelation(value: unknown): TransitStation["commercialRelation"] {
  const text = stringValue(value);
  return text === "none" || text === "listed" || text === "partner" || text === "affiliate" || text === "sponsored" || text === "unknown" ? text : "unknown";
}

function usageAdvice(value: unknown): TransitStation["usageAdvice"] {
  const text = stringValue(value);
  return text === "try_small" || text === "cautious" || text === "not_recommended" || text === "pending" ? text : "pending";
}

function dataStatus(value: unknown): TransitStation["dataStatus"] {
  const text = stringValue(value);
  return text === "sample" || text === "pending_review" || text === "verified" ? text : "pending_review";
}

function modelFamily(value: unknown): TransitModelFamily | null {
  const text = stringValue(value);
  return isTransitModelFamily(text) ? text : null;
}

function standardModelValue(value: unknown): TransitModelPrice["standardModel"] | null {
  const text = stringValue(value);
  return isTransitStandardModel(text) ? text : null;
}

function accountPool(value: unknown): TransitModelPrice["accountPool"] {
  const text = stringValue(value);
  return isTransitAccountPool(text) ? text : "undisclosed";
}

function channelType(value: unknown): TransitModelPrice["channelType"] {
  const text = stringValue(value);
  return isTransitChannelType(text) ? text : "undisclosed";
}

function isTransitChannelType(value: string): value is TransitModelPrice["channelType"] {
  return [
    "official_api",
    "cloud",
    "first_party_pool",
    "reverse_engineered",
    "first_party_wholesale",
    "reseller",
    "mixed",
    "undisclosed",
  ].includes(value);
}

function isTransitAccountPool(value: string): value is TransitModelPrice["accountPool"] {
  return [
    "pro",
    "plus",
    "max",
    "team",
    "kiro",
    "enterprise",
    "official_api",
    "mixed",
    "undisclosed",
  ].includes(value);
}

function isTransitRiskLabel(value: string): value is TransitStation["riskLabels"][number] {
  return [
    "sample_data",
    "insufficient_samples",
    "mixed_pool",
    "reseller",
    "undisclosed_upstream",
    "third_party_aggregate",
    "pending_feedback",
  ].includes(value);
}
