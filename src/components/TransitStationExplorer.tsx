"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowUpDown, ChevronRight, Filter, ShieldCheck } from "lucide-react";
import {
  DataTableHead,
  DataTableShell,
  MobileFilterSheet,
  SearchField,
  SelectFilter,
  StatusChip,
} from "@/components/ComparisonUi";
import { TransitAvailabilityStrip } from "@/components/TransitAvailabilityStrip";
import { TransitLatencyBadge } from "@/components/TransitLatencyBadge";
import { TransitStationSystemIcon } from "@/components/TransitStationSystemIcon";
import { TransitViewTabs } from "@/components/TransitViewTabs";
import { useDebouncedValue } from "@/lib/client-hooks";
import { replaceClientSearchParams, useClientSearchParams } from "@/lib/client-url-state";
import { listDetailNavigationHref, shouldHandleListDetailClick } from "@/lib/list-return";
import { saveCurrentListScrollPosition, useListScrollRestoration } from "@/lib/list-scroll-restoration";
import { formatDateMinute, formatDateShortMinute } from "@/lib/utils";
import type {
  TransitAccountPool,
  TransitChannelType,
  TransitModelFamily,
  TransitStandardModel,
  TransitOperatorType,
  TransitStation,
} from "@/data/api-transit/types";
import {
  TRANSIT_ACCOUNT_POOL_LABELS,
  TRANSIT_CHANNEL_TYPE_LABELS,
  TRANSIT_DATA_STATUS_LABELS,
  TRANSIT_INVOICE_SUPPORT_LABELS,
  TRANSIT_MODEL_FAMILY_LABELS,
  TRANSIT_MODEL_FAMILY_ORDER,
  TRANSIT_TEXT_MODEL_FAMILY_ORDER,
  TRANSIT_OPERATOR_TYPE_LABELS,
  TRANSIT_STANDARD_MODELS,
  TRANSIT_STANDARD_MODEL_FAMILY,
  TRANSIT_STANDARD_MODEL_MODALITY,
  isTransitTextModelFamily,
  isTransitModelFamily,
  transitModelPriceMatchesFamily,
} from "@/data/api-transit/types";
import {
  compareStations,
  buildTransitDetectorHref,
  formatAvailability,
  formatCacheHitRate,
  formatTransitModelDetectionLabel,
  formatTransitModelDetectionMeta,
  getRechargeCoefficientFromRatio,
  formatMultiplierRange,
  formatRate,
  getCacheHitRateBadgeClass,
  getRateBadgeClass,
  getEffectiveTransitChannelTypes,
  getAvailabilitySourceMeta,
  getFamilyAvailabilitySourceMeta,
  getFamilyRateSummary,
  getStandardModelAvailabilitySourceMeta,
  getStandardModelRateSummary,
  getNormalizedSourceTags,
  getTransitOperatorType,
  getPrimaryTransitCommercialOffer,
  getAggregatedTransitCacheUsage,
  getStationComparisonSummary,
  getTextStationComparisonSummary,
  getStationPublishedAvailabilitySummary,
  getTransitAvailabilityFreshness,
  getTransitStationAvailabilityPresentation,
  getTransitStationPriceFreshness,
  getStationRechargeCoefficient,
  getTransitModelDetectionBadgeClass,
  getTransitPriceDetectionSummary,
  getTransitStationDetectionSummary,
  hasPublicTransitModelDetectionReport,
  hasTransitAffRelation,
  isDollarTransitModelFamily,
  getTransitReviewTags,
  getTransitStationSystemLabel,
  formatTransitFixedPriceRange,
  formatYuanPerDollar,
  hasTransitFixedPriceSummary,
  parseRechargeRatio,
  type TransitSortKey,
} from "@/lib/api-transit";
import {
  TRANSIT_CACHE_HIT_RATE_EXPLANATION,
  TRANSIT_COMBINED_RATE_EXPLANATION,
  TRANSIT_RATE_BREAKDOWN_EXPLANATION,
} from "@/lib/api-transit-copy";

const CHANNEL_OPTIONS: { value: TransitChannelType | "all"; label: string }[] = [
  { value: "all", label: "全部渠道" },
  ...Object.entries(TRANSIT_CHANNEL_TYPE_LABELS).map(([value, label]) => ({
    value: value as TransitChannelType,
    label,
  })),
];

const POOL_OPTIONS: { value: TransitAccountPool | "all"; label: string }[] = [
  { value: "all", label: "全部号池" },
  ...Object.entries(TRANSIT_ACCOUNT_POOL_LABELS).map(([value, label]) => ({
    value: value as TransitAccountPool,
    label,
  })),
];

const SORT_OPTIONS: { value: TransitSortKey; label: string }[] = [
  { value: "overall", label: "综合推荐" },
  { value: "rate", label: "最低价格" },
  { value: "stability", label: "稳定性优先" },
];

function sortLabel(value: TransitSortKey) {
  return SORT_OPTIONS.find((option) => option.value === value)?.label ?? "综合推荐";
}

function isFixedPriceScope(
  family: "all" | TransitModelFamily,
  standardModel: "all" | TransitStandardModel
): boolean {
  if (standardModel !== "all") {
    const modality = TRANSIT_STANDARD_MODEL_MODALITY[standardModel];
    return modality === "image" || modality === "video";
  }
  return family === "image" || family === "video";
}

function coerceParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T
): T {
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

interface Props {
  stations: TransitStation[];
  rankingReferenceAt: string;
}

export default function TransitStationExplorer({ stations, rankingReferenceAt }: Props) {
  useListScrollRestoration();
  const router = useRouter();
  const routeSearchParams = useSearchParams();
  const searchParams = useClientSearchParams(routeSearchParams.toString());
  const [urlReady, setUrlReady] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState(searchParams.get("q") || "");
  const debouncedSearch = useDebouncedValue(search, 250);
  const rawModelParam = searchParams.get("model");
  const modelFilter = coerceParam(
    rawModelParam,
    ["all", ...TRANSIT_STANDARD_MODELS] as const,
    "all"
  );
  const familyFilter = coerceParam(
    searchParams.get("family") ?? (isTransitModelFamily(rawModelParam) ? rawModelParam : null),
    ["all", ...TRANSIT_MODEL_FAMILY_ORDER] as const,
    "all"
  );
  const effectiveFamilyFilter: "all" | TransitModelFamily =
    modelFilter === "all" ? familyFilter : TRANSIT_STANDARD_MODEL_FAMILY[modelFilter];
  const [channelFilter, setChannelFilter] = useState<TransitChannelType | "all">(
    coerceParam(searchParams.get("channel"), CHANNEL_OPTIONS.map((item) => item.value), "all")
  );
  const [poolFilter, setPoolFilter] = useState<TransitAccountPool | "all">(
    coerceParam(searchParams.get("pool"), POOL_OPTIONS.map((item) => item.value), "all")
  );
  const [sortBy, setSortBy] = useState<TransitSortKey>(
    coerceParam(searchParams.get("sort"), ["overall", "rate", "stability"] as const, "overall")
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => setUrlReady(true), 60);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!urlReady) return;

    replaceClientSearchParams("/api-transit", {
      q: debouncedSearch || null,
      channel: channelFilter === "all" ? null : channelFilter,
      pool: poolFilter === "all" ? null : poolFilter,
      sort: sortBy === "overall" ? null : sortBy,
    });
  }, [channelFilter, debouncedSearch, poolFilter, sortBy, urlReady]);

  const filtered = useMemo(() => {
    let result = [...stations];

    if (search) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (station) =>
          station.name.toLowerCase().includes(q) ||
          station.slug.toLowerCase().includes(q) ||
          station.summary.toLowerCase().includes(q)
      );
    }

    if (modelFilter !== "all") {
      result = result.filter((station) =>
        station.prices.some((price) => price.standardModel === modelFilter)
      );
    } else if (familyFilter !== "all") {
      result = result.filter((station) =>
        station.prices.some((price) => transitModelPriceMatchesFamily(price, familyFilter))
      );
    }

    if (channelFilter !== "all") {
      result = result.filter((station) => getEffectiveTransitChannelTypes(station).includes(channelFilter));
    }

    if (poolFilter !== "all") {
      result = result.filter((station) => station.accountPools.includes(poolFilter));
    }

    return compareStations(result, sortBy, {
      activeFamily: familyFilter,
      activeStandardModel: modelFilter,
      now: rankingReferenceAt,
    });
  }, [channelFilter, familyFilter, modelFilter, poolFilter, rankingReferenceAt, search, sortBy, stations]);

  const advancedFilterCount = [channelFilter, poolFilter].filter((value) => value !== "all").length;

  const returnQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (modelFilter !== "all") params.set("model", modelFilter);
    if (familyFilter !== "all") params.set("family", familyFilter);
    if (channelFilter !== "all") params.set("channel", channelFilter);
    if (poolFilter !== "all") params.set("pool", poolFilter);
    if (sortBy !== "overall") params.set("sort", sortBy);
    return params.toString();
  }, [channelFilter, familyFilter, modelFilter, poolFilter, search, sortBy]);

  const fixedPriceScope = isFixedPriceScope(effectiveFamilyFilter, modelFilter);
  const rateColumnLabel = modelFilter !== "all"
    ? `${modelFilter} ${fixedPriceScope ? "人民币固定价" : "综合倍率"}`
    : effectiveFamilyFilter === "all"
      ? "最低文本综合倍率"
      : `${TRANSIT_MODEL_FAMILY_LABELS[effectiveFamilyFilter]} ${fixedPriceScope ? "固定价" : "综合倍率"}`;
  const availabilityColumnExplanation = modelFilter !== "all"
    ? `${modelFilter} 近 7 日可用性样本汇总；最近样本只使用同模型、同分组或同家族的兼容监测范围。响应延迟是监测请求耗时，不等同于首 Token 或 TPS。`
    : effectiveFamilyFilter === "all"
      ? "近 7 日文本模型可用性样本汇总；图片和视频不参与全部综合排序。标签会标明来自 PriceAI 实测、公开监测页、公开模型页或站长接口。响应延迟是监测请求耗时，不等同于首 Token 或 TPS。"
      : `${TRANSIT_MODEL_FAMILY_LABELS[effectiveFamilyFilter]} 近 7 日可用性样本汇总；最近样本只使用同模型、同分组或同家族的兼容监测范围。响应延迟是监测请求耗时，不等同于首 Token 或 TPS。`;

  const stationDetailHref = useCallback(
    (slug: string) => listDetailNavigationHref(`/api-transit/${slug}`, returnQuery),
    [returnQuery]
  );

  const navigateToStation = useCallback(
    (href: string) => {
      saveCurrentListScrollPosition();
      router.push(href);
    },
    [router]
  );

  const prefetchStation = useCallback(
    (slug: string) => {
      router.prefetch(`/api-transit/${slug}`);
    },
    [router]
  );

  return (
    <div>
      <div className="mb-4 space-y-2.5 md:mb-5 md:space-y-3">
        <div className="grid gap-3 xl:grid-cols-[minmax(260px,460px)_auto] xl:items-center xl:justify-start">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="搜索站点名称、描述..."
            className="w-full"
          />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 xl:flex xl:w-auto xl:shrink-0">
            <div className="min-w-0 rounded-full bg-[#edf0f1] p-1 xl:w-auto xl:shrink-0">
              <TransitViewTabs
                active="stations"
                className="w-full bg-transparent p-0 xl:w-auto"
                itemClassName="flex-1 px-2 sm:px-4 xl:flex-none"
              />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <label className="relative inline-flex h-11 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3 text-sm font-semibold text-[#2d3435] ring-1 ring-[#adb3b4]/15 transition hover:bg-[#f5f7f7] hover:text-[#202829] sm:px-4">
                <ArrowUpDown className="h-4 w-4 shrink-0" />
                <span className="pointer-events-none hidden min-w-[5.25em] sm:inline">{sortLabel(sortBy)}</span>
                <span className="pointer-events-none sm:hidden">排序</span>
                <select
                  aria-label="排序"
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value as TransitSortKey)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setShowFilters((value) => !value)}
                className={`inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors sm:px-4 ${
                  showFilters || advancedFilterCount > 0
                    ? "bg-[#2d3435] text-[#f8f8f8]"
                    : "bg-white text-[#5a6061] ring-1 ring-[#adb3b4]/15 hover:bg-[#f5f7f7] hover:text-[#202829]"
                }`}
              >
                <Filter className="h-3.5 w-3.5" />
                筛选{advancedFilterCount > 0 ? ` ${advancedFilterCount}` : ""}
              </button>
            </div>
          </div>
        </div>
        {showFilters ? (
          <div className="mt-3 hidden grid-cols-1 gap-3 rounded-lg bg-[#f2f4f4] p-3 ring-1 ring-[#adb3b4]/10 md:grid md:grid-cols-2">
            <SelectFilter
              label="渠道类型"
              value={channelFilter}
              onChange={(value) => setChannelFilter(value as TransitChannelType | "all")}
              options={CHANNEL_OPTIONS}
            />
            <SelectFilter
              label="号池"
              value={poolFilter}
              onChange={(value) => setPoolFilter(value as TransitAccountPool | "all")}
              options={POOL_OPTIONS}
            />
          </div>
        ) : null}
      </div>

      <MobileFilterSheet
        open={showFilters}
        title="筛选中转站"
        description="按渠道类型和号池来源缩小列表。模型族请使用顶部分类。"
        resultCount={filtered.length}
        onClose={() => setShowFilters(false)}
        onReset={() => {
          setChannelFilter("all");
          setPoolFilter("all");
        }}
      >
        <SelectFilter
          label="渠道类型"
          value={channelFilter}
          onChange={(value) => setChannelFilter(value as TransitChannelType | "all")}
          options={CHANNEL_OPTIONS}
        />
        <SelectFilter
          label="号池"
          value={poolFilter}
          onChange={(value) => setPoolFilter(value as TransitAccountPool | "all")}
          options={POOL_OPTIONS}
        />
      </MobileFilterSheet>

      {filtered.length === 0 ? (
        <div className="rounded-lg bg-white px-6 py-16 text-center text-[#5a6061] ring-1 ring-[#adb3b4]/15">
          <p className="mb-2 text-lg font-semibold text-[#202829]">
            {stations.length === 0 ? "暂无已发布的真实中转站数据" : "没有匹配的中转站"}
          </p>
          <p className="mx-auto max-w-[560px] text-sm leading-6">
            {stations.length === 0
              ? "后台候选数据需要完成清洗、审核和发布后才会出现在这里；没有真实发布数据时不会展示样例榜单。"
              : "尝试调整模型、渠道或号池筛选。"}
          </p>
        </div>
      ) : (
        <>
          <DataTableShell className="hidden md:block">
            <table className="w-full min-w-[1360px] border-collapse text-left text-sm" role="table">
                <thead className="bg-[#f2f4f4] text-[0.68rem] font-semibold text-[#5a6061]">
                  <tr role="row">
                    <DataTableHead className="w-[300px]">站点</DataTableHead>
                    <DataTableHead className="whitespace-nowrap" explanation={TRANSIT_COMBINED_RATE_EXPLANATION}>
                      {rateColumnLabel}
                    </DataTableHead>
                    <DataTableHead explanation={TRANSIT_RATE_BREAKDOWN_EXPLANATION}>倍率构成</DataTableHead>
                    <DataTableHead explanation={availabilityColumnExplanation}>稳定性</DataTableHead>
                    <DataTableHead explanation="模型真实性检测报告：用于识别模型掺水、暗调路由、私下替换等风险；无公开报告时只显示待检测。">模型检测</DataTableHead>
                    <DataTableHead explanation="公开披露或 PriceAI 推断的上游来源与号池类型，用于判断风险边界。">来源渠道</DataTableHead>
                    <DataTableHead explanation="价格数据的最近更新时间；若站方同步失败，会单独显示最近检查时间。">价格更新</DataTableHead>
                    <DataTableHead className="w-[120px] text-center">操作</DataTableHead>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#edf0f1]" role="rowgroup">
                  {filtered.map((station) => (
                    <StationRow
                      key={station.id}
                      station={station}
                      href={stationDetailHref(station.slug)}
                      activeFamily={effectiveFamilyFilter}
                      activeStandardModel={modelFilter}
                      rankingReferenceAt={rankingReferenceAt}
                      onClick={navigateToStation}
                      onWarm={() => prefetchStation(station.slug)}
                    />
                  ))}
                </tbody>
            </table>
          </DataTableShell>

          <div className="grid grid-cols-1 gap-3 md:hidden">
            {filtered.map((station) => (
              <StationCard
                key={station.id}
                station={station}
                href={stationDetailHref(station.slug)}
                activeFamily={effectiveFamilyFilter}
                activeStandardModel={modelFilter}
                rankingReferenceAt={rankingReferenceAt}
                rateLabel={rateColumnLabel}
                onClick={navigateToStation}
                onWarm={() => prefetchStation(station.slug)}
              />
            ))}
          </div>

          <div className="mt-4 text-center text-xs text-[#5a6061]">
            共 {filtered.length} 个站点
            {filtered.length !== stations.length ? `（总收录 ${stations.length} 个）` : ""}
          </div>
        </>
      )}
    </div>
  );
}

function RechargeRatioDisplay({ station }: { station: TransitStation }) {
  const primaryRatioText = station.prices[0]?.rechargeRatio ?? null;
  const ratioText = getDisplayRechargeRatio(primaryRatioText);
  const coefficient =
    getRechargeCoefficientFromRatio(ratioText) ??
    getStationRechargeCoefficient(station);

  if (!ratioText || coefficient === null) {
    return <span className="rounded-full bg-[#f2f4f4] px-2 py-0.5 text-[11px] font-semibold text-[#7f8889]">未公开</span>;
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[#f2f4f4] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[#5a6061]"
      title={rechargeRatioTitle(primaryRatioText, ratioText)}
    >
      <span className="font-extrabold text-[#2d3435]">{formatRate(coefficient)}</span>
      <span className="text-[#9aa2a3]">·</span>
      <span className="text-[10px] font-bold text-[#47657a]">{ratioText}</span>
    </span>
  );
}

function getDisplayRechargeRatio(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?/);
  return match?.[0]?.replace(/\s+/g, "") ?? null;
}

function rechargeRatioTitle(originalText: string | null, displayRatio: string): string {
  const quota = parseRechargeRatio(displayRatio);
  const quotaText = quota === null ? "未解析" : `1 元约等于 ${quota.toFixed(2)} 站内额度`;
  const suffix = "这里只影响充值倍率，不代表模型倍率。";
  return originalText && originalText !== displayRatio
    ? `充值比例：${displayRatio}；原始说明：${originalText}；${quotaText}；${suffix}`
    : `充值比例：${displayRatio}；${quotaText}；${suffix}`;
}

function CombinedRateCell({
  station,
  family,
  standardModel = "all",
  rankingReferenceAt,
  compact = false,
}: {
  station: TransitStation;
  family: "all" | TransitModelFamily;
  standardModel?: "all" | TransitStandardModel;
  rankingReferenceAt: string;
  compact?: boolean;
}) {
  const comparison = family === "all" && standardModel === "all"
    ? getTextStationComparisonSummary(station)
    : getStationComparisonSummary(station);
  const summary = standardModel !== "all"
    ? getStandardModelRateSummary(station, standardModel)
    : family === "all"
      ? null
      : comparison.families[family];
  const rate = summary ? summary.combinedRateMin : comparison.bestCombinedRate;
  const fixedPrice = summary && hasTransitFixedPriceSummary(summary)
    ? formatTransitFixedPriceRange(summary)
    : null;
  const showYuanPerDollar = summary !== null &&
    !fixedPrice &&
    isDollarTransitModelFamily(summary.family) &&
    summary.family !== "image" &&
    summary.family !== "video" &&
    (standardModel === "all" || TRANSIT_STANDARD_MODEL_MODALITY[standardModel] === "text");
  const yuanPerDollarLabel = showYuanPerDollar ? formatYuanPerDollar(rate) : null;
  const priceFreshness = getTransitStationPriceFreshness(station, {
    activeFamily: family,
    activeStandardModel: standardModel,
    now: rankingReferenceAt,
  });
  const historicalValue = fixedPrice || formatRate(rate);

  if (summary && summary.priceCount === 0) {
    return <span className="text-xs text-[#7f8889]">未收录</span>;
  }

  if (!summary && rate === null) {
    return <span className="text-xs text-[#7f8889]">暂无价格</span>;
  }

  if (priceFreshness.state === "stale" || priceFreshness.state === "empty") {
    return (
      <div className={compact ? "min-w-0" : "min-w-[108px]"}>
        <div className="flex items-center gap-1 text-[11px] font-bold text-[#9a5d12]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>暂无近期价格</span>
        </div>
        <div className="mt-1 text-[10px] font-semibold leading-4 text-[#7f8889]">
          历史 {historicalValue}
          {priceFreshness.lastVerifiedAt ? ` · ${formatDateShortMinute(priceFreshness.lastVerifiedAt)}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? "" : "min-w-[108px]"}>
      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-extrabold ${
        priceFreshness.state === "delayed"
          ? "bg-[#fff7e8] text-[#7a541b]"
          : getRateBadgeClass(rate)
      }`}>
        {fixedPrice || formatRate(rate)}
      </span>
      <div className={`mt-1 text-[10px] font-semibold ${priceFreshness.state === "delayed" ? "text-[#9a5d12]" : "text-[#7f8889]"}`}>
        {priceFreshness.state === "delayed"
          ? `价格待更新${priceFreshness.lastVerifiedAt ? ` · ${formatDateShortMinute(priceFreshness.lastVerifiedAt)}` : ""}`
          : fixedPrice
            ? "人民币固定价"
            : yuanPerDollarLabel
              ? yuanPerDollarLabel
            : standardModel !== "all"
              ? standardModel
              : summary
                ? formatMultiplierRange(summary)
                : bestFamilyLabel(comparison)}
      </div>
    </div>
  );
}

function PriceBreakdownCell({
  station,
  activeFamily,
  activeStandardModel = "all",
  rankingReferenceAt,
  compact = false,
}: {
  station: TransitStation;
  activeFamily: "all" | TransitModelFamily;
  activeStandardModel?: "all" | TransitStandardModel;
  rankingReferenceAt: string;
  compact?: boolean;
}) {
  const summary = activeFamily === "all" && activeStandardModel === "all"
    ? getTextStationComparisonSummary(station)
    : getStationComparisonSummary(station);
  const cacheUsage = getScopedCacheUsage(station, activeFamily, activeStandardModel);
  const visibleSummaries = activeStandardModel !== "all"
    ? [getStandardModelRateSummary(station, activeStandardModel)].filter((item) => item.priceCount > 0)
    : TRANSIT_TEXT_MODEL_FAMILY_ORDER
      .map((family) => summary.families[family])
      .filter((item) => item.priceCount > 0 && (activeFamily === "all" || item.family === activeFamily))
      .slice(0, compact ? 3 : 4);
  const fixedPriceOnly = visibleSummaries.length > 0 && visibleSummaries.every(hasTransitFixedPriceSummary);
  const priceFreshness = getTransitStationPriceFreshness(station, {
    activeFamily,
    activeStandardModel,
    now: rankingReferenceAt,
  });
  const historical = priceFreshness.state === "stale" || priceFreshness.state === "empty";
  const delayed = priceFreshness.state === "delayed";

  return (
    <div className={compact ? "space-y-1" : "min-w-[166px] space-y-1"}>
      {historical || delayed ? (
        <div className="flex items-center gap-1 text-[10px] font-bold text-[#9a5d12]">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{historical ? "以下为历史倍率" : "倍率待更新"}</span>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        <span className="shrink-0 text-[10px] font-extrabold text-[#7f8889]">充值倍率</span>
        <RechargeRatioDisplay station={station} />
      </div>
      <div className="flex items-start gap-1.5 text-[11px] font-semibold">
        <span className="mt-0.5 shrink-0 text-[10px] font-extrabold text-[#7f8889]">
          {fixedPriceOnly ? "固定价" : "模型倍率"}
        </span>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {visibleSummaries.length ? (
            visibleSummaries.map((item) => (
              <CompactRateTag
                key={activeStandardModel !== "all" ? activeStandardModel : item.family}
                label={activeStandardModel !== "all" ? "模型" : TRANSIT_MODEL_FAMILY_LABELS[item.family]}
                value={hasTransitFixedPriceSummary(item) ? formatTransitFixedPriceRange(item) : formatMultiplierRange(item)}
                missing={false}
                historical={historical || delayed}
              />
            ))
          ) : (
            <CompactRateTag label="模型" value="—" missing />
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        <span className="shrink-0 text-[10px] font-extrabold text-[#7f8889]" title={TRANSIT_CACHE_HIT_RATE_EXPLANATION}>
          缓存命中率
        </span>
        <span
          className={`rounded-full px-2 py-0.5 tabular-nums ${
            historical || delayed || fixedPriceOnly
              ? "bg-[#f2f4f4] text-[#7f8889]"
              : getCacheHitRateBadgeClass(cacheUsage)
          }`}
          title={TRANSIT_CACHE_HIT_RATE_EXPLANATION}
        >
          {fixedPriceOnly ? "不适用" : formatCacheHitRate(cacheUsage)}
        </span>
      </div>
    </div>
  );
}

function getScopedCacheUsage(
  station: TransitStation,
  activeFamily: "all" | TransitModelFamily,
  activeStandardModel: "all" | TransitStandardModel
) {
  const prices = station.prices.filter((price) => {
    if (activeStandardModel !== "all") return price.standardModel === activeStandardModel;
    if (activeFamily !== "all") return transitModelPriceMatchesFamily(price, activeFamily);
    return isTransitTextModelFamily(price.family);
  });

  return getAggregatedTransitCacheUsage(prices, {
    equalWeightFamilies: activeFamily === "all" && activeStandardModel === "all",
  });
}

function bestFamilyLabel(summary: ReturnType<typeof getStationComparisonSummary>): string {
  const best = TRANSIT_MODEL_FAMILY_ORDER
    .map((family) => summary.families[family])
    .filter((item) => item.combinedRateMin !== null)
    .sort((left, right) => (left.combinedRateMin ?? Infinity) - (right.combinedRateMin ?? Infinity))[0];
  return best ? `${TRANSIT_MODEL_FAMILY_LABELS[best.family]} 最低` : "全模型";
}

function CompactRateTag({
  label,
  value,
  missing,
  historical = false,
}: {
  label: string;
  value: string;
  missing: boolean;
  historical?: boolean;
}) {
  return (
    <span className={`rounded-full px-2 py-0.5 ${
      missing || historical ? "bg-[#f2f4f4] text-[#7f8889]" : "bg-[#fff7e8] text-[#7a541b]"
    }`}>
      {label} {missing ? "未收录" : value}
    </span>
  );
}

function StationRow({
  station,
  href,
  activeFamily,
  activeStandardModel,
  rankingReferenceAt,
  onClick,
  onWarm,
}: {
  station: TransitStation;
  href: string;
  activeFamily: "all" | TransitModelFamily;
  activeStandardModel: "all" | TransitStandardModel;
  rankingReferenceAt: string;
  onClick: (href: string) => void;
  onWarm: () => void;
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick(href);
    }
  };

  return (
    <tr
      className="cursor-pointer align-top transition hover:bg-[#f7f9f9] focus-visible:bg-[#f7f9f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#45bf78]/40"
      onClick={() => onClick(href)}
      onFocus={onWarm}
      onKeyDown={handleKeyDown}
      onMouseEnter={onWarm}
      tabIndex={0}
      role="row"
      aria-label={`查看 ${station.name} 详情`}
    >
      <td className="w-[300px] min-w-[300px] max-w-[340px] px-5 py-4">
        <StationIdentity station={station} />
      </td>
      <td className="px-5 py-4">
        <CombinedRateCell
          station={station}
          family={activeFamily}
          standardModel={activeStandardModel}
          rankingReferenceAt={rankingReferenceAt}
        />
      </td>
      <td className="px-5 py-4">
        <PriceBreakdownCell
          station={station}
          activeFamily={activeFamily}
          activeStandardModel={activeStandardModel}
          rankingReferenceAt={rankingReferenceAt}
        />
      </td>
      <td className="px-5 py-4">
        <AvailabilityCell
          station={station}
          activeFamily={activeFamily}
          activeStandardModel={activeStandardModel}
          rankingReferenceAt={rankingReferenceAt}
        />
      </td>
      <td className="px-5 py-4">
        <ModelDetectionCell
          station={station}
          activeFamily={activeFamily}
          activeStandardModel={activeStandardModel}
        />
      </td>
      <td className="max-w-[220px] px-5 py-4">
        <SourceChannelCell station={station} />
      </td>
      <td className="px-5 py-4">
        <UpdatedAtCell station={station} />
      </td>
      <td className="px-5 py-4 text-center">
        <Link
          href={href}
          prefetch={false}
          onClick={(event) => {
            event.stopPropagation();
            if (shouldHandleListDetailClick(event)) saveCurrentListScrollPosition();
          }}
          onFocus={onWarm}
          onMouseEnter={onWarm}
          className="inline-flex h-9 min-w-[76px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-[#f8f8f8] transition hover:bg-[#1f2526]"
        >
          查看
          <ChevronRight size={14} />
        </Link>
      </td>
    </tr>
  );
}

function StationCard({
  station,
  href,
  activeFamily,
  activeStandardModel,
  rankingReferenceAt,
  rateLabel,
  onClick,
  onWarm,
}: {
  station: TransitStation;
  href: string;
  activeFamily: "all" | TransitModelFamily;
  activeStandardModel: "all" | TransitStandardModel;
  rankingReferenceAt: string;
  rateLabel: string;
  onClick: (href: string) => void;
  onWarm: () => void;
}) {
  const sourceTags = getNormalizedSourceTags(station);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick(href);
    }
  };

  return (
    <div
      className="cursor-pointer rounded-lg bg-white px-4 py-3.5 ring-1 ring-[#adb3b4]/15 transition-colors hover:bg-[#fbfcfc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#45bf78]/40"
      onClick={() => onClick(href)}
      onFocus={onWarm}
      onKeyDown={handleKeyDown}
      onMouseEnter={onWarm}
      tabIndex={0}
      role="button"
      aria-label={`查看 ${station.name} 详情`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <StationIdentity station={station} />
        </div>
        <ChevronRight size={17} className="mt-2 shrink-0 text-[#adb3b4]" />
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 border-t border-[#edf0f1] pt-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold leading-4 text-[#5a6061]">{rateLabel}</p>
          <div className="mt-1.5">
            <CombinedRateCell
              station={station}
              family={activeFamily}
              standardModel={activeStandardModel}
              rankingReferenceAt={rankingReferenceAt}
              compact
            />
          </div>
        </div>
        <AvailabilityCell
          station={station}
          activeFamily={activeFamily}
          activeStandardModel={activeStandardModel}
          rankingReferenceAt={rankingReferenceAt}
          compact
        />
      </div>

      <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 overflow-hidden">
          <PillList items={sourceTags} max={2} />
        </div>
        <UpdatedAtCell station={station} compact />
      </div>
    </div>
  );
}

function AvailabilityCell({
  station,
  activeFamily,
  activeStandardModel = "all",
  rankingReferenceAt,
  compact = false,
}: {
  station: TransitStation;
  activeFamily: "all" | TransitModelFamily;
  activeStandardModel?: "all" | TransitStandardModel;
  rankingReferenceAt: string;
  compact?: boolean;
}) {
  const scopedSummary = activeStandardModel !== "all"
    ? getStandardModelRateSummary(station, activeStandardModel)
    : activeFamily === "all"
      ? null
      : getFamilyRateSummary(station, activeFamily);
  const textSummary = activeFamily === "all" && activeStandardModel === "all"
    ? getTextStationComparisonSummary(station)
    : null;
  const stationAvailability = textSummary?.availability ?? getStationPublishedAvailabilitySummary(station);
  const presentation = scopedSummary
    ? null
    : getTransitStationAvailabilityPresentation(station, stationAvailability, rankingReferenceAt);
  const availability = scopedSummary || presentation?.availability || stationAvailability;
  const freshness = presentation?.freshness
    ?? getTransitAvailabilityFreshness(availability, rankingReferenceAt, station);
  const isHistorical = freshness === "stale" || freshness === "empty";
  const isDelayed = freshness === "delayed";
  const source = activeStandardModel !== "all"
    ? getStandardModelAvailabilitySourceMeta(station, activeStandardModel)
    : scopedSummary
      ? getFamilyAvailabilitySourceMeta(station, scopedSummary.family)
      : getAvailabilitySourceMeta(presentation?.availability ?? stationAvailability);
  const scopeLabel = activeStandardModel !== "all"
    ? `${activeStandardModel} 稳定性`
    : scopedSummary
      ? `${scopedSummary.familyLabel} 稳定性`
    : "文本综合稳定性";
  const sourceTitle = activeStandardModel !== "all"
    ? `${activeStandardModel} 近 7 日可用性样本；最近样本只使用同模型、同分组或同家族的兼容监测范围。`
    : scopedSummary
      ? `${scopedSummary.familyLabel} 分组近 7 日可用性样本；最近样本只使用同模型、同分组或同家族的兼容监测范围。`
    : "仅按当前公开文本模型分组汇总的近 7 日可用性样本；图片和视频不参与综合排序。";
  const hasLatencySummary = !isHistorical && (
    (availability.latestLatencyMs !== null && availability.latestLatencyMs !== undefined) ||
    (availability.avgLatency7dMs !== null && availability.avgLatency7dMs !== undefined)
  );
  const title = hasLatencySummary
    ? `${sourceTitle} 响应延迟表示公开监测或 PriceAI 实测的请求耗时，不等同于首 Token 时间或 TPS 输出速度。`
    : sourceTitle;

  return (
    <div className={compact ? "" : "min-w-[118px]"} title={title}>
      {isHistorical ? (
        <>
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#9a5d12]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{freshness === "empty" ? "暂无监测数据" : "暂无近期监测"}</span>
          </div>
          {availability.sevenDaySamples > 0 ? (
            <div className="mt-0.5 text-[10px] font-semibold text-[#7f8889]">
              历史 {formatAvailability(availability)}
            </div>
          ) : null}
        </>
      ) : compact ? (
        <div className="mb-1 text-xs font-semibold text-[#5a6061]">
          {isDelayed ? "监测延迟" : scopeLabel} <span className={isDelayed ? "text-[#9a5d12]" : "text-[#202829]"}>{formatAvailability(availability)}</span>
        </div>
      ) : (
        <>
          <div className={`text-[10px] font-bold ${isDelayed ? "text-[#9a5d12]" : "text-[#7f8889]"}`}>
            {isDelayed ? "监测延迟" : scopeLabel}
          </div>
          <div className="mt-0.5 text-xs font-semibold text-[#202829]">{formatAvailability(availability)}</div>
        </>
      )}
      {isHistorical ? (
        <HistoricalAvailabilityStrip className="mt-1" />
      ) : (
        <TransitAvailabilityStrip
          rate={availability.sevenDayRate}
          samples={availability.sevenDaySamples}
          firstCheckedAt={availability.firstCheckedAt}
          lastCheckedAt={availability.lastCheckedAt}
          recentSamples={availability.recentSamples}
          className="mt-1"
        />
      )}
      <div className="mt-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[10px] text-[#7f8889]">
        <span>{availability.lastCheckedAt ? `${isHistorical || isDelayed ? "最后监测 " : ""}${formatDateShortMinute(availability.lastCheckedAt)}` : "未记录监测时间"}</span>
        <AvailabilitySourceBadge
          source={source}
          compact={compact}
          hidden={!shouldShowAvailabilitySourceBadge(availability, source)}
        />
      </div>
      {presentation?.replacedPublicEvidence ? (
        <div className="mt-1 text-[10px] font-semibold leading-4 text-[#9a5d12]">
          站方公开监测已中断，当前为 PriceAI 实测
        </div>
      ) : station.collectionStatus === "failed" && (isHistorical || isDelayed) ? (
        <div className="mt-1 text-[10px] font-semibold leading-4 text-[#9a5d12]">站方同步失败</div>
      ) : null}
      {hasLatencySummary ? (
        <div className="mt-1">
          <TransitLatencyBadge
            latestLatencyMs={availability.latestLatencyMs}
            avgLatency7dMs={availability.avgLatency7dMs}
            latestLabel="最近"
            singleLine
          />
        </div>
      ) : null}
    </div>
  );
}

function HistoricalAvailabilityStrip({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex h-4 items-end gap-[2px] ${className}`}
      role="img"
      aria-label="最近没有可用的监测样本"
    >
      {Array.from({ length: 20 }, (_, index) => (
        <span
          key={index}
          className="h-2.5 min-w-[3px] flex-1 rounded-[1px] bg-[#dfe4e4]"
        />
      ))}
    </div>
  );
}

function ModelDetectionCell({
  station,
  activeFamily,
  activeStandardModel = "all",
  compact = false,
}: {
  station: TransitStation;
  activeFamily: "all" | TransitModelFamily;
  activeStandardModel?: "all" | TransitStandardModel;
  compact?: boolean;
}) {
  const price = getScopedDetectionPrice(station, activeFamily, activeStandardModel);
  const summary = price
    ? getTransitPriceDetectionSummary(station, price)
    : getTransitStationDetectionSummary(station);
  const detectorHref = buildTransitDetectorHref(station, price ?? undefined);
  const hasReport = hasPublicTransitModelDetectionReport(summary);
  const checkedAt = hasReport && summary.checkedAt ? formatDateShortMinute(summary.checkedAt) : null;
  const title = summary?.note ?? "暂无公开模型真实性检测报告。";

  return (
    <div className={compact ? "rounded-lg bg-[#f7f9f9] px-3 py-2" : "min-w-[132px]"} title={title}>
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#7f8889]" aria-hidden="true" />
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${getTransitModelDetectionBadgeClass(summary)}`}>
          {formatTransitModelDetectionLabel(summary)}
        </span>
      </div>
      <div className="mt-1 text-[10px] leading-4 text-[#7f8889]">
        {hasReport ? formatTransitModelDetectionMeta(summary) : compact ? "暂无公开报告" : "暂无模型真伪报告"}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] font-semibold">
        {checkedAt ? (
          <span className="truncate text-[#7f8889]">
            {summary?.sourceLabel ?? "检测"} · {checkedAt}
          </span>
        ) : null}
        {hasReport ? (
          <a
            href={summary.reportUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="shrink-0 text-[#2f7a4b] hover:text-[#245f3b]"
          >
            报告
          </a>
        ) : (
          <Link
            href={detectorHref}
            prefetch={false}
            onClick={(event) => event.stopPropagation()}
            className="shrink-0 text-[#2f7a4b] hover:text-[#245f3b]"
          >
            去检测
          </Link>
        )}
      </div>
    </div>
  );
}

function getScopedDetectionPrice(
  station: TransitStation,
  activeFamily: "all" | TransitModelFamily,
  activeStandardModel: "all" | TransitStandardModel
): TransitStation["prices"][number] | null {
  const prices = station.prices.filter((price) => {
    if (activeStandardModel !== "all") return price.standardModel === activeStandardModel;
    if (activeFamily !== "all") return transitModelPriceMatchesFamily(price, activeFamily);
    return true;
  });
  const withReport = prices.find((price) => {
    const summary = getTransitPriceDetectionSummary(station, price);
    return hasPublicTransitModelDetectionReport(summary);
  });
  return withReport ?? prices[0] ?? null;
}

function AvailabilitySourceBadge({
  source,
  compact,
  hidden = false,
}: {
  source: ReturnType<typeof getAvailabilitySourceMeta>;
  compact: boolean;
  hidden?: boolean;
}) {
  if (hidden) return null;

  const className = [
    "inline-flex max-w-full items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none",
    availabilitySourceToneClass(source.tone),
    compact ? "" : "whitespace-nowrap",
  ].filter(Boolean).join(" ");

  if (source.url) {
    return (
      <a
        href={source.url}
        className={className}
        title={source.title}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        {source.label}
      </a>
    );
  }

  return (
    <span className={className} title={source.title}>
      {source.label}
    </span>
  );
}

function availabilitySourceToneClass(tone: ReturnType<typeof getAvailabilitySourceMeta>["tone"]): string {
  switch (tone) {
    case "success":
      return "bg-[#e8f3ec] text-[#2f7a4b]";
    case "info":
      return "bg-[#eef3f8] text-[#47657a]";
    case "warning":
      return "bg-[#fff7e8] text-[#7a541b]";
    default:
      return "bg-[#f2f4f4] text-[#5a6061]";
  }
}

function shouldShowAvailabilitySourceBadge(
  availability: Pick<TransitStation["availability"], "sevenDaySamples">,
  source: ReturnType<typeof getAvailabilitySourceMeta>
): boolean {
  return availability.sevenDaySamples > 0 || source.tone !== "muted" || Boolean(source.url);
}

function UpdatedAtCell({ station, compact = false }: { station: TransitStation; compact?: boolean }) {
  const failed = station.collectionStatus === "failed";
  const checkedAt = station.lastCollectedAt || station.lastUpdatedAt;
  if (compact) {
    return (
      <span
        className={`shrink-0 text-[0.68rem] font-semibold ${failed ? "text-[#9a5d12]" : "text-[#5a6061]"}`}
        title={failed ? `最近检查 ${formatDateMinute(checkedAt)} · 同步失败` : `价格更新 ${formatDateMinute(station.lastUpdatedAt)}`}
      >
        {failed ? `检查 ${formatDateShortMinute(checkedAt)} · 失败` : formatDateShortMinute(station.lastUpdatedAt)}
      </span>
    );
  }

  return (
    <div className="min-w-[102px] whitespace-nowrap">
      <span
        className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${failed ? "bg-[#fff4df] text-[#9a5d12]" : "bg-[#f2f4f4] text-[#5a6061]"}`}
        title={failed ? station.collectionError || "最近一次站方数据同步失败" : `${formatDateMinute(station.lastUpdatedAt)} · ${TRANSIT_DATA_STATUS_LABELS[station.dataStatus]}`}
      >
        {failed ? `检查 ${formatDateShortMinute(checkedAt)}` : formatDateShortMinute(station.lastUpdatedAt)}
      </span>
      {failed ? <div className="mt-1 text-[10px] font-semibold text-[#9a5d12]">同步失败</div> : null}
    </div>
  );
}

function StationIdentity({ station }: { station: TransitStation }) {
  const offer = getPrimaryTransitCommercialOffer(station);
  const offerLabel = offer ? formatListOfferLabel(offer) : null;
  const offerTitle = offer ? offer.title || offer.listLabel || offer.description || "优惠说明" : "";
  const hasAff = hasTransitAffRelation(station);
  const operatorType = getTransitOperatorType(station);
  const operatorLabel = TRANSIT_OPERATOR_TYPE_LABELS[operatorType];
  const invoiceLabel = station.invoiceSupport === "supported" ? TRANSIT_INVOICE_SUPPORT_LABELS[station.invoiceSupport] : null;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <TransitStationSystemIcon station={station} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[#202829]">{station.name}</div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
          <span className="inline-flex h-5 w-[72px] shrink-0 items-center justify-center rounded-full bg-[#f2f4f4] px-2 text-[10px] font-bold text-[#5a6061]">
            <span className="truncate">{getTransitStationSystemLabel(station)}</span>
          </span>
          {hasAff ? (
            <span
              className="inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-dashed border-[#adb3b4]/70 px-2 text-[10px] font-extrabold text-[#5a6061]"
              title="后台标记该站点存在 AFF 关系，不影响页面价格口径。"
            >
              AFF
            </span>
          ) : null}
          {offerLabel ? (
            <span
              className="inline-flex h-5 min-w-0 max-w-[132px] shrink items-center justify-center whitespace-nowrap rounded-full bg-[#fff7e8] px-2 text-[10px] font-bold text-[#7a541b]"
              title={offerTitle}
            >
              <span className="truncate">{offerLabel}</span>
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
          <StationInfoTag label={operatorLabel} tone={operatorType} />
          {invoiceLabel ? <StationInfoTag label={invoiceLabel} tone="invoice" /> : null}
        </div>
      </div>
    </div>
  );
}

function StationInfoTag({
  label,
  tone,
}: {
  label: string;
  tone: TransitOperatorType | "invoice";
}) {
  const className = tone === "invoice"
    ? "bg-[#eef3f8] text-[#47657a]"
    : tone === "company"
      ? "bg-[#e8f3ec] text-[#2f7a4b]"
      : "bg-[#f2f4f4] text-[#5a6061]";

  return (
    <span className={`inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-2 text-[10px] font-bold ${className}`}>
      {label}
    </span>
  );
}

function formatListOfferLabel(offer: NonNullable<TransitStation["commercialOffers"]>[number]): string | null {
  return offer.listLabel || null;
}

function PillList({ items, max = items.length }: { items: { id: string; label: string }[]; max?: number }) {
  const visible = items.slice(0, max);

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((item) => (
        <span
          key={item.id}
          className="rounded-full bg-[#f2f4f4] px-2 py-0.5 text-[11px] font-semibold text-[#2d3435]"
        >
          {item.label}
        </span>
      ))}
      {items.length > max ? <StatusChip tone="muted" className="px-2 py-0.5 text-[11px]">+{items.length - max}</StatusChip> : null}
    </div>
  );
}

function SourceChannelCell({ station }: { station: TransitStation }) {
  const channelItems = getNormalizedSourceTags(station);
  const reviewHints = getTransitReviewTags(station);

  return (
    <div className="space-y-1.5">
      <PillList items={channelItems} max={3} />
      {reviewHints.length ? (
        <div className="flex flex-wrap gap-1.5">
          {reviewHints.slice(0, 2).map((hint) => (
            <span key={hint.id} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${hint.tone === "neutral" ? "bg-[#f2f4f4] text-[#5a6061]" : "bg-[#fff7e8] text-[#7a541b]"}`}>
              {hint.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
