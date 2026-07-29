"use client";

import { Fragment, type KeyboardEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import {
  DataTableHead,
  DataTableShell,
  SearchField,
  StatusChip,
} from "@/components/ComparisonUi";
import { TransitAvailabilityStrip } from "@/components/TransitAvailabilityStrip";
import { TransitModelIcon } from "@/components/TransitModelIcon";
import { TransitPriceBreakdown } from "@/components/TransitPriceBreakdown";
import { TransitViewTabs } from "@/components/TransitViewTabs";
import { useDebouncedValue } from "@/lib/client-hooks";
import { replaceClientSearchParams, useClientSearchParams } from "@/lib/client-url-state";
import { shouldHandleListDetailClick } from "@/lib/list-return";
import { saveCurrentListScrollPosition, useListScrollRestoration } from "@/lib/list-scroll-restoration";
import { formatDateMinute } from "@/lib/utils";
import type { TransitModelFamily, TransitStation } from "@/data/api-transit/types";
import {
  TRANSIT_ACCOUNT_POOL_LABELS,
  TRANSIT_CHANNEL_TYPE_LABELS,
  TRANSIT_RISK_LABELS,
  TRANSIT_USAGE_ADVICE_LABELS,
  isTransitModelFamily,
} from "@/data/api-transit/types";
import {
  buildTransitDetectorHref,
  formatAvailability,
  formatCacheHitRate,
  formatPercent,
  formatRate,
  formatTransitFixedPrice,
  formatTransitFixedPriceValue,
  formatTransitModelDetectionLabel,
  formatTransitModelDetectionMeta,
  formatTransitModelMultiplier,
  formatTransitTokenVolume,
  getAvailabilitySourceMeta,
  getCacheHitRateBadgeClass,
  getRateBadgeClass,
  hydrateTransitModelIndexSummaries,
  getTransitModelDetectionBadgeClass,
  getTransitPriceAvailabilitySourceMeta,
  getTransitPriceDetectionSummary,
  getTransitStationSystemLabel,
  getUsageAdviceBadgeClass,
  hasPublicTransitModelDetectionReport,
  isTransitFixedPrice,
  type TransitModelPriceEntry,
  type TransitModelIndex,
  type TransitModelSummary,
} from "@/lib/api-transit";
import {
  TRANSIT_CACHE_HIT_RATE_EXPLANATION,
  TRANSIT_COMBINED_RATE_EXPLANATION,
  TRANSIT_MODEL_MULTIPLIER_EXPLANATION,
  TRANSIT_RECHARGE_COEFFICIENT_EXPLANATION,
} from "@/lib/api-transit-copy";

type FamilyFilter = "all" | TransitModelFamily;

function coerceFamily(value: string | null): FamilyFilter {
  return isTransitModelFamily(value) ? value : "all";
}

interface Props {
  modelIndex: TransitModelIndex;
}

export default function TransitModelExplorer({ modelIndex }: Props) {
  useListScrollRestoration();
  const routeSearchParams = useSearchParams();
  const searchParams = useClientSearchParams(routeSearchParams.toString());
  const [urlReady, setUrlReady] = useState(false);
  const family = coerceFamily(searchParams.get("family") ?? searchParams.get("model"));
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const debouncedQuery = useDebouncedValue(query, 250);

  useEffect(() => {
    const timeout = window.setTimeout(() => setUrlReady(true), 60);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!urlReady) return;

    replaceClientSearchParams("/api-transit/models", {
      q: debouncedQuery || null,
    });
  }, [debouncedQuery, urlReady]);

  const hydratedModelSummaries = useMemo(
    () => hydrateTransitModelIndexSummaries(modelIndex, family),
    [family, modelIndex],
  );
  const modelSummaries = useMemo(() => {
    if (!query) return hydratedModelSummaries;

    const q = query.trim().toLowerCase();
    return hydratedModelSummaries.filter(
      (summary) =>
        summary.standardModel.toLowerCase().includes(q) ||
        summary.familyLabel.toLowerCase().includes(q)
    );
  }, [hydratedModelSummaries, query]);

  return (
    <div>
      <div className="mb-5 space-y-3">
        <div className="grid gap-3 xl:grid-cols-[minmax(260px,460px)_auto] xl:items-center xl:justify-start">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="搜索标准模型名..."
            className="w-full"
          />
          <TransitViewTabs
            active="models"
            className="w-full bg-[#edf0f1] xl:w-fit xl:justify-self-start"
            itemClassName="flex-1 xl:flex-none"
          />
        </div>
      </div>

      {modelSummaries.length === 0 ? (
        <div className="rounded-lg bg-white px-6 py-16 text-center text-[#5a6061] ring-1 ring-[#adb3b4]/15">
          <p className="mb-2 text-lg font-semibold text-[#202829]">
            {modelIndex.stations.length === 0 ? "暂无已发布的真实模型数据" : "没有匹配的模型"}
          </p>
          <p className="mx-auto max-w-[560px] text-sm leading-6">
            {modelIndex.stations.length === 0
              ? "后台候选数据完成清洗、审核和发布后，模型页才会展示可对比的真实报价。"
              : "尝试调整模型族或搜索关键词。"}
          </p>
        </div>
      ) : (
        <>
          <ModelSummaryTable summaries={modelSummaries} />
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {modelSummaries.map((summary) => (
              <ModelSummaryCard key={`${summary.family}-${summary.standardModel}`} summary={summary} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ModelSummaryTable({ summaries }: { summaries: TransitModelSummary[] }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  function toggleModel(summary: TransitModelSummary) {
    const key = modelKey(summary);
    setExpandedKey((current) => current === key ? null : key);
  }

  return (
    <DataTableShell className="hidden md:block">
        <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
          <thead className="bg-[#f2f4f4] text-[0.68rem] font-semibold text-[#5a6061]">
            <tr>
              <DataTableHead>标准模型</DataTableHead>
              <DataTableHead explanation={TRANSIT_COMBINED_RATE_EXPLANATION}>最优价格</DataTableHead>
              <DataTableHead>稳定性</DataTableHead>
              <DataTableHead>代表站点</DataTableHead>
              <DataTableHead>覆盖</DataTableHead>
              <DataTableHead className="w-[120px] text-center">操作</DataTableHead>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#edf0f1]">
            {summaries.map((summary) => {
              const expanded = expandedKey === modelKey(summary);

              return (
                <Fragment key={`${summary.family}-${summary.standardModel}`}>
                  <ModelSummaryRow
                    summary={summary}
                    expanded={expanded}
                    onToggleModel={() => toggleModel(summary)}
                  />
                  {expanded ? <ModelExpandedRow summary={summary} stationId="all" /> : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
    </DataTableShell>
  );
}

function ModelSummaryRow({
  summary,
  expanded,
  onToggleModel,
}: {
  summary: TransitModelSummary;
  expanded: boolean;
  onToggleModel: () => void;
}) {
  const bestEntry = summary.prices[0] ?? null;
  const hasPrices = summary.prices.length > 0;
  const hasFixedPrice = summary.bestFixedPrice !== null && summary.bestCombinedRate === null;

  function handleKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggleModel();
    }
  }

  return (
    <tr
      className="cursor-pointer align-top transition hover:bg-[#f7f9f9] focus-visible:bg-[#f7f9f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#45bf78]/40"
      onClick={onToggleModel}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "收起" : "展开"} ${summary.standardModel} 站点倍率`}
    >
      <td className="max-w-[330px] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f2f4f4] ring-1 ring-[#adb3b4]/15">
            <TransitModelIcon family={summary.family} standardModel={summary.standardModel} className="h-7 w-7" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-[#202829]">
              {summary.standardModel}
            </span>
            <span className="mt-1 block truncate text-xs text-[#5a6061]">
              {summary.familyLabel} · {summary.stationCount} 个站点 · 样本 {summary.sampleCount}
            </span>
          </span>
        </div>
      </td>
      <td className="px-5 py-4">
        <p className="font-semibold leading-6 text-[#202829]">
          {hasPrices ? (hasFixedPrice ? formatTransitFixedPriceValue(summary.bestFixedPrice) : formatRate(summary.bestCombinedRate)) : "暂无报价"}
        </p>
        {hasFixedPrice && summary.worstFixedPrice !== null && summary.worstFixedPrice !== summary.bestFixedPrice ? (
          <p className="mt-1 text-xs text-[#5a6061]">最高 {formatTransitFixedPriceValue(summary.worstFixedPrice)}</p>
        ) : summary.worstCombinedRate !== null && summary.worstCombinedRate !== summary.bestCombinedRate ? (
          <p className="mt-1 text-xs text-[#5a6061]">最高 {formatRate(summary.worstCombinedRate)}</p>
        ) : (
          <p className="mt-1 text-xs text-[#5a6061]">{hasPrices ? (hasFixedPrice ? "人民币固定价" : "综合倍率") : "等待站点采集"}</p>
        )}
      </td>
      <td className="px-5 py-4">
        <p className="font-semibold leading-6 text-[#202829]">{formatPercent(summary.averageAvailability)}</p>
        <p className="mt-1 text-xs text-[#5a6061]">样本 {summary.sampleCount}</p>
      </td>
      <td className="max-w-[260px] px-5 py-4">
        {bestEntry ? <RepresentativeStation entry={bestEntry} /> : <span className="text-sm text-[#5a6061]">暂无代表站点</span>}
      </td>
      <td className="px-5 py-4">
        <p className="font-semibold text-[#202829]">{summary.stationCount} 个站点</p>
        <p className="mt-1 text-xs text-[#5a6061]">报价样本 {summary.sampleCount}</p>
      </td>
      <td className="w-[120px] px-5 py-4 text-center">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleModel();
          }}
          className="inline-flex h-9 min-w-[76px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-[#f8f8f8] transition hover:bg-[#1f2526]"
          aria-expanded={expanded}
        >
          {expanded ? "收起" : hasPrices ? "展开" : "说明"}
          <ChevronDown size={14} className={`transition ${expanded ? "rotate-180" : ""}`} />
        </button>
      </td>
    </tr>
  );
}

function ModelSummaryCard({ summary }: { summary: TransitModelSummary }) {
  const bestEntry = summary.prices[0] ?? null;
  const hasPrices = summary.prices.length > 0;
  const hasFixedPrice = summary.bestFixedPrice !== null && summary.bestCombinedRate === null;
  const [expanded, setExpanded] = useState(false);

  function toggleModel() {
    setExpanded((current) => !current);
  }

  return (
    <article
      className="rounded-lg bg-white p-4 shadow-[0_20px_55px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15 transition hover:bg-[#fbfcfc]"
    >
      <div className="mb-3 flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f2f4f4] ring-1 ring-[#adb3b4]/15">
          <TransitModelIcon family={summary.family} standardModel={summary.standardModel} className="h-7 w-7" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[#202829]">{summary.standardModel}</span>
          <span className="mt-1 block truncate text-xs text-[#5a6061]">{summary.familyLabel} · {summary.stationCount} 个站点</span>
        </span>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${getRateBadgeClass(summary.bestCombinedRate)}`}>
          {hasPrices ? (hasFixedPrice ? formatTransitFixedPriceValue(summary.bestFixedPrice) : formatRate(summary.bestCombinedRate)) : "暂无报价"}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-[#5a6061]">
        <div>
          稳定性 <span className="font-semibold text-[#2d3435]">{formatPercent(summary.averageAvailability)}</span>
        </div>
        <div>
          样本 <span className="font-semibold text-[#2d3435]">{summary.sampleCount}</span>
        </div>
      </div>
      {bestEntry ? <RepresentativeStation entry={bestEntry} /> : <NoPublishedPricesMessage compact />}
      {expanded ? <ModelMobileExpandedPanel summary={summary} stationId="all" /> : null}
      <button
        type="button"
        onClick={toggleModel}
        className="mt-3 inline-flex h-8 items-center gap-1 rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-[#f8f8f8]"
        aria-expanded={expanded}
      >
        {expanded ? "收起站点报价" : hasPrices ? "展开站点报价" : "查看说明"}
        <ChevronDown size={13} className={`transition ${expanded ? "rotate-180" : ""}`} />
      </button>
    </article>
  );
}

function ModelExpandedRow({ summary, stationId }: { summary: TransitModelSummary; stationId: string }) {
  return (
    <tr>
      <td colSpan={6} className="bg-[#fbfcfc] px-5 pb-5 pt-0">
        <ModelExpandedPanel summary={summary} stationId={stationId} />
      </td>
    </tr>
  );
}

function ModelExpandedPanel({ summary, stationId }: { summary: TransitModelSummary; stationId: string }) {
  const entries = getExpandedEntries(summary, stationId);
  const selectedStation = stationId === "all" ? null : entries[0]?.station ?? null;
  const hasEntries = entries.length > 0;

  return (
    <div className="rounded-lg border border-[#dfe4e5] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dfe4e5] bg-[#f2f4f4] px-4 py-3">
        <div>
          <p className="text-sm font-extrabold text-[#202829]">
            {selectedStation ? selectedStation.name : "全部站点"} · {summary.standardModel}
          </p>
          <p className="mt-1 text-xs text-[#5a6061]">展示该模型在对应站点/分组下的价格、充值折算、缓存率、可用性和检测报告。</p>
        </div>
        {selectedStation ? (
          <Link
            href={`/api-transit/${selectedStation.slug}`}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-[#f8f8f8] hover:bg-[#202829]"
          >
            站点详情
            <ChevronRight size={13} />
          </Link>
        ) : null}
      </div>
      <div className="overflow-hidden">
        <table className="w-full table-fixed border-collapse text-left text-xs">
          <colgroup>
            <col className="w-[12%]" />
            <col className="w-[17%]" />
            <col className="w-[18%]" />
            <col className="w-[17%]" />
            <col className="w-[15%]" />
            <col className="w-[11%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="bg-[#f7f9f9] text-[#5a6061]">
            <tr>
              <DataTableHead>站点</DataTableHead>
              <DataTableHead>分组</DataTableHead>
              <DataTableHead explanation={`${TRANSIT_COMBINED_RATE_EXPLANATION}；${TRANSIT_MODEL_MULTIPLIER_EXPLANATION}；${TRANSIT_RECHARGE_COEFFICIENT_EXPLANATION}；${TRANSIT_CACHE_HIT_RATE_EXPLANATION}`}>
                倍率 / 缓存
              </DataTableHead>
              <DataTableHead>输入 / 输出</DataTableHead>
              <DataTableHead>可用性</DataTableHead>
              <DataTableHead explanation="模型真实性检测报告：用于识别模型掺水、暗调路由、私下替换等风险；无公开报告时只显示待检测。">模型检测</DataTableHead>
              <DataTableHead>渠道 / 时间</DataTableHead>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#edf0f1]">
            {hasEntries ? (
              entries.map((entry) => (
                <ModelExpandedEntryRow key={`${entry.station.id}-${entry.price.groupName}`} entry={entry} />
              ))
            ) : (
              <tr>
                <td colSpan={7} className="px-4 py-8">
                  <NoPublishedPricesMessage />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModelExpandedEntryRow({ entry }: { entry: TransitModelPriceEntry }) {
  const router = useRouter();
  const stationHref = `/api-transit/${entry.station.slug}`;

  function navigateToStation() {
    saveCurrentListScrollPosition();
    router.push(stationHref);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigateToStation();
    }
  }

  return (
    <tr
      className="cursor-pointer transition hover:bg-[#f7f9f9] focus-visible:bg-[#f7f9f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#45bf78]/40"
      onClick={navigateToStation}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label={`查看 ${entry.station.name} 详情`}
    >
      <td className="min-w-0 px-3 py-3">
        <Link
          href={stationHref}
          onClick={(event) => {
            event.stopPropagation();
            if (shouldHandleListDetailClick(event)) saveCurrentListScrollPosition();
          }}
          className="block truncate font-semibold text-[#202829] transition-colors hover:text-[#2f7a4b]"
        >
          {entry.station.name}
        </Link>
        <div className="mt-1 truncate text-[11px] text-[#5a6061]">{getTransitStationSystemLabel(entry.station)}</div>
      </td>
      <td className="min-w-0 px-3 py-3 text-[#2d3435]">
        <span className="block break-words leading-5">{entry.price.groupName}</span>
      </td>
      <td className="min-w-0 px-3 py-3">
        <RateAndCacheCell entry={entry} />
      </td>
      <td className="min-w-0 px-3 py-3">
        <TransitPriceBreakdown station={entry.station} price={entry.price} mode="compact" />
      </td>
      <td className="min-w-0 px-3 py-3">
        <PriceAvailabilityCell entry={entry} />
      </td>
      <td className="min-w-0 px-3 py-3">
        <ModelDetectionCell entry={entry} />
      </td>
      <td className="min-w-0 px-3 py-3 text-[#5a6061]">
        <ChannelTimeCell entry={entry} />
      </td>
    </tr>
  );
}

function RateAndCacheCell({ entry }: { entry: TransitModelPriceEntry }) {
  const cacheUsage = entry.price.cacheUsage;
  const sampleTokens = formatTransitTokenVolume(cacheUsage?.sampleTokens);

  if (isTransitFixedPrice(entry.price)) {
    return (
      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded-full bg-[#e8f3ec] px-2.5 py-1 text-[11px] font-extrabold text-[#2f7a4b]">
            {formatTransitFixedPrice(entry.price)}
          </span>
          <span className="truncate text-[10px] font-semibold text-[#7f8889]">人民币固定价</span>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-1.5">
          <div className="min-w-0 rounded-lg bg-[#eef3f8] px-2 py-1.5 text-[#47657a] ring-1 ring-[#47657a]/10">
            <span className="block truncate text-[10px] font-bold leading-none">计费口径</span>
            <span className="mt-1 block truncate text-[11px] font-extrabold leading-4">按次固定</span>
          </div>
          <div className="min-w-0 rounded-lg bg-[#f2f4f4] px-2 py-1.5 text-[#7f8889] ring-1 ring-[#adb3b4]/15">
            <span className="block truncate text-[10px] font-bold leading-none">缓存</span>
            <span className="mt-1 block truncate text-[11px] font-extrabold leading-4">不适用</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-1.5" title={TRANSIT_CACHE_HIT_RATE_EXPLANATION}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${getRateBadgeClass(entry.combinedRate)}`}>
          {formatRate(entry.combinedRate)}
        </span>
        <span className="truncate text-[10px] font-semibold text-[#7f8889]">综合倍率</span>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-1.5">
        <div className="min-w-0 rounded-lg bg-[#eef3f8] px-2 py-1.5 text-[#47657a] ring-1 ring-[#47657a]/10">
          <span className="block truncate text-[10px] font-bold leading-none">模型倍率</span>
          <span className="mt-1 block truncate text-[11px] font-extrabold leading-4 tabular-nums">
            {formatTransitModelMultiplier(entry.price)}
          </span>
        </div>
        <div className="min-w-0 rounded-lg bg-[#fff7e8] px-2 py-1.5 text-[#7a541b] ring-1 ring-[#7a541b]/10">
          <span className="block truncate text-[10px] font-bold leading-none">充值倍率</span>
          <span className="mt-1 block truncate text-[11px] font-extrabold leading-4 tabular-nums">
            {formatRate(entry.rechargeCoefficient)}
          </span>
        </div>
      </div>
      <div className="min-w-0 rounded-lg bg-[#f2f4f4] px-2 py-1.5 ring-1 ring-[#adb3b4]/15">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${getCacheHitRateBadgeClass(cacheUsage)}`}>
            缓存 {formatCacheHitRate(cacheUsage)}
          </span>
          <span className="min-w-0 truncate text-[10px] font-semibold text-[#7f8889]">
            {sampleTokens}
          </span>
        </div>
      </div>
    </div>
  );
}

function PriceAvailabilityCell({ entry }: { entry: TransitModelPriceEntry }) {
  const { availability, source } = getTransitModelPriceAvailabilityDisplay(entry);

  return (
    <div className="min-w-0" title={source.title}>
      <p className="font-semibold text-[#202829]">{formatAvailability(availability)}</p>
      <TransitAvailabilityStrip
        rate={availability.sevenDayRate}
        samples={availability.sevenDaySamples}
        firstCheckedAt={availability.firstCheckedAt}
        lastCheckedAt={availability.lastCheckedAt}
        recentSamples={availability.recentSamples}
        className="mt-1"
      />
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-[#7f8889]">
        <span>{formatDateMinute(availability.lastCheckedAt)}</span>
        <AvailabilitySourcePill source={source} />
      </div>
    </div>
  );
}

function getTransitModelPriceAvailabilityDisplay(entry: TransitModelPriceEntry) {
  return {
    availability: entry.price.availability,
    source: getTransitPriceAvailabilitySourceMeta(entry.station, entry.price),
  };
}

function AvailabilitySourcePill({
  source,
}: {
  source: ReturnType<typeof getAvailabilitySourceMeta>;
}) {
  const className = [
    "inline-flex max-w-full items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none",
    availabilitySourceToneClass(source.tone),
  ].join(" ");

  if (source.url) {
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className={className}
        title={source.title}
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

function ModelDetectionCell({ entry }: { entry: TransitModelPriceEntry }) {
  const summary = getTransitPriceDetectionSummary(entry.station, entry.price);
  const detectorHref = buildTransitDetectorHref(entry.station, entry.price);
  const hasReport = hasPublicTransitModelDetectionReport(summary);
  const checkedAt = hasReport && summary.checkedAt ? formatDateMinute(summary.checkedAt) : null;
  const title = summary?.note ?? "暂无公开模型真实性检测报告。";

  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#7f8889]" aria-hidden="true" />
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${getTransitModelDetectionBadgeClass(summary)}`}>
          {formatTransitModelDetectionLabel(summary)}
        </span>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-[#7f8889]">
        {hasReport ? formatTransitModelDetectionMeta(summary) : "暂无公开报告"}
      </p>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] font-semibold">
        {checkedAt ? <span className="truncate text-[#7f8889]">{checkedAt}</span> : null}
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

function ChannelTimeCell({ entry }: { entry: TransitModelPriceEntry }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-[11px] leading-5 text-[#5a6061]">
        {TRANSIT_CHANNEL_TYPE_LABELS[entry.price.channelType]} / {TRANSIT_ACCOUNT_POOL_LABELS[entry.price.accountPool]}
      </p>
      <p className="text-[10px] leading-4 text-[#7f8889]">{formatDateMinute(entry.price.lastVerifiedAt)}</p>
    </div>
  );
}

function ModelMobileExpandedPanel({ summary, stationId }: { summary: TransitModelSummary; stationId: string }) {
  const entries = getExpandedEntries(summary, stationId);
  const router = useRouter();

  function navigateToStation(slug: string) {
    saveCurrentListScrollPosition();
    router.push(`/api-transit/${slug}`);
  }

  return (
    <div className="mb-3 rounded-lg border border-[#dfe4e5] bg-[#fbfcfc] p-3">
      <div className="space-y-2">
        {entries.length > 0 ? (
          entries.slice(0, 8).map((entry) => {
            const detection = getTransitPriceDetectionSummary(entry.station, entry.price);
            const availabilityDisplay = getTransitModelPriceAvailabilityDisplay(entry);

            return (
              <button
                key={`${entry.station.id}-${entry.price.groupName}`}
                type="button"
                onClick={() => navigateToStation(entry.station.slug)}
                className="w-full border-b border-[#edf0f1] pb-3 text-left transition hover:bg-[#f7f9f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#45bf78]/35 last:border-0 last:pb-0"
                aria-label={`查看 ${entry.station.name} 详情`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[#202829]">{entry.station.name}</p>
                    <p className="mt-1 truncate text-[11px] text-[#5a6061]">
                      {entry.price.groupName} · {TRANSIT_CHANNEL_TYPE_LABELS[entry.price.channelType]} / {TRANSIT_ACCOUNT_POOL_LABELS[entry.price.accountPool]}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${getRateBadgeClass(entry.combinedRate)}`}>
                    {isTransitFixedPrice(entry.price) ? formatTransitFixedPrice(entry.price) : formatRate(entry.combinedRate)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <MobileQuoteMetric
                    label={isTransitFixedPrice(entry.price) ? "固定价" : "模型"}
                    value={isTransitFixedPrice(entry.price) ? formatTransitFixedPrice(entry.price) : formatTransitModelMultiplier(entry.price)}
                  />
                  <MobileQuoteMetric label="充值" value={isTransitFixedPrice(entry.price) ? "已折算" : formatRate(entry.rechargeCoefficient)} />
                  <MobileQuoteMetric
                    label="缓存"
                    value={isTransitFixedPrice(entry.price) ? "不适用" : `${formatCacheHitRate(entry.price.cacheUsage)} · ${formatTransitTokenVolume(entry.price.cacheUsage?.sampleTokens)}`}
                  />
                  <MobileQuoteMetric label="可用性" value={formatAvailability(availabilityDisplay.availability)} />
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#7f8889]" aria-hidden="true" />
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${getTransitModelDetectionBadgeClass(detection)}`}>
                    {formatTransitModelDetectionLabel(detection)}
                  </span>
                  <span className="min-w-0 truncate text-[10px] text-[#7f8889]">
                    {formatTransitModelDetectionMeta(detection)}
                  </span>
                </div>
              </button>
            );
          })
        ) : (
          <NoPublishedPricesMessage compact />
        )}
      </div>
    </div>
  );
}

function MobileQuoteMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-white px-2.5 py-2 ring-1 ring-[#adb3b4]/15">
      <p className="text-[10px] font-bold text-[#7f8889]">{label}</p>
      <p className="mt-1 truncate text-[11px] font-semibold text-[#202829]">{value}</p>
    </div>
  );
}

function NoPublishedPricesMessage({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`text-[#5a6061] ${compact ? "text-xs leading-5" : "text-center text-sm leading-6"}`}>
      <p className="font-semibold text-[#202829]">暂无已发布报价</p>
      <p className="mt-1">这个标准模型已纳入中转 API 观察清单，等站点价格完成采集和审核后会补齐倍率与代表站点。</p>
    </div>
  );
}

function RepresentativeStation({ entry }: { entry: TransitModelPriceEntry }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-semibold text-[#202829]">{entry.station.name}</p>
      <p className="mt-1 truncate text-xs text-[#5a6061]">
        {TRANSIT_ACCOUNT_POOL_LABELS[entry.price.accountPool]} · {isTransitFixedPrice(entry.price)
          ? `固定价 ${formatTransitFixedPrice(entry.price)}`
          : `充值 ${formatRate(entry.rechargeCoefficient)} · 模型 ${formatTransitModelMultiplier(entry.price)}`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${getRateBadgeClass(entry.combinedRate)}`}>
          {isTransitFixedPrice(entry.price) ? formatTransitFixedPrice(entry.price) : formatRate(entry.combinedRate)}
        </span>
        <RiskPills station={entry.station} />
      </div>
    </div>
  );
}

function RiskPills({ station }: { station: TransitStation }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {station.riskLabels.slice(0, 1).map((risk) => (
        <StatusChip key={risk} tone="warning" className="px-2 py-0.5 text-[11px]">
          {TRANSIT_RISK_LABELS[risk]}
        </StatusChip>
      ))}
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${getUsageAdviceBadgeClass(station.usageAdvice)}`}>
        {TRANSIT_USAGE_ADVICE_LABELS[station.usageAdvice]}
      </span>
    </div>
  );
}

function modelKey(summary: TransitModelSummary): string {
  return `${summary.family}:${summary.standardModel}`;
}

function getExpandedEntries(summary: TransitModelSummary, stationId: string): TransitModelPriceEntry[] {
  if (stationId === "all") return summary.prices;
  return summary.prices.filter((entry) => entry.station.id === stationId);
}
