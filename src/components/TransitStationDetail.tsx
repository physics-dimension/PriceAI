"use client";

import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Gift,
  HelpCircle,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { DataTableHead, StatusChip } from "@/components/ComparisonUi";
import { FeedbackDialog, transitStationFeedbackTypes } from "@/components/FeedbackLink";
import { TransitAvailabilityStrip } from "@/components/TransitAvailabilityStrip";
import { TransitLatencyBadge } from "@/components/TransitLatencyBadge";
import { TransitPriceBreakdown } from "@/components/TransitPriceBreakdown";
import { TransitStationSystemIcon } from "@/components/TransitStationSystemIcon";
import { useMediaQuery } from "@/lib/client-hooks";
import { withPriceAiUtm } from "@/lib/outbound-analytics-client";
import { formatDateDay, formatDateMinute, formatDateShortMinute } from "@/lib/utils";
import type {
  TransitCommercialOffer,
  TransitModelFamily,
  TransitMultiplierHistoryPoint,
  TransitModelPrice,
  TransitStation,
} from "@/data/api-transit/types";
import {
  TRANSIT_ACCOUNT_POOL_LABELS,
  TRANSIT_CHANNEL_TYPE_LABELS,
  TRANSIT_COMMERCIAL_OFFER_TYPE_LABELS,
  TRANSIT_DATA_STATUS_LABELS,
  TRANSIT_MODEL_FAMILY_LABELS,
  TRANSIT_MODEL_FAMILY_ORDER,
  TRANSIT_STATION_STATUS_LABELS,
  TRANSIT_USAGE_ADVICE_LABELS,
  TRANSIT_VERIFICATION_EVENT_SOURCE_LABELS,
  transitModelPriceMatchesFamily,
} from "@/data/api-transit/types";
import {
  ALLOWED_RETURN_KEYS,
  compareTransitModelPriority,
  getActiveTransitCommercialOffers,
  formatAvailability,
  formatCacheHitRate,
  formatPercent,
  formatTransitFixedPriceRange,
  formatTransitModelMultiplier,
  getAvailabilitySourceMeta,
  getAvailabilityEvidenceMeta,
  formatRate,
  getCacheHitRateBadgeClass,
  getCombinedRateForPrice,
  getFamilyAvailabilitySourceMeta,
  getFamilyPrices,
  getFamilyRateSummary,
  getRepresentativeTransitPrice,
  getPrimaryTransitCommercialOffer,
  getPrimaryTransitOutboundOffer,
  getRechargeCoefficientFromRatio,
  getRepresentativeCacheUsage,
  getTransitStationOutboundUrl,
  getNormalizedSourceTags,
  getRateBadgeClass,
  getRecentTransitAvailabilitySamples,
  getStationRechargeCoefficient,
  getStationPublishedAvailabilitySummary,
  getPreferredTransitAvailabilityRollupPrices,
  getTransitPriceAvailabilitySource,
  getTransitFixedPriceValue,
  getTransitVerificationEvents,
  getTransitReviewTags,
  getTransitStationSystemLabel,
  hasComparableTransitOfficialPrice,
  getUsageAdviceBadgeClass,
  hasTransitAffRelation,
  isTransitStationOutboundAff,
  hasTransitFixedPriceSummary,
  isTransitFixedPrice,
} from "@/lib/api-transit";
import {
  TRANSIT_CACHE_HIT_RATE_EXPLANATION,
  TRANSIT_COMBINED_RATE_EXPLANATION,
  TRANSIT_MODEL_MULTIPLIER_EXPLANATION,
  TRANSIT_MONITORED_PRICE_EXPLANATION,
  TRANSIT_RECHARGE_COEFFICIENT_EXPLANATION,
} from "@/lib/api-transit-copy";
import { sanitizeListReturnHref } from "@/lib/list-return";

interface Props {
  station: TransitStation;
  children?: ReactNode;
}

type TransitPriceGroup = {
  groupName: string;
  prices: TransitModelPrice[];
  primaryPrice: TransitModelPrice;
  combinedRate: number | null;
  rechargeCoefficient: number | null;
  modelMultiplierMin: number | null;
  modelMultiplierMax: number | null;
  modelMultiplierLabel: string;
  fixedPriceMin: number | null;
  fixedPriceMax: number | null;
  fixedPriceLabel: string;
  isFixedPrice: boolean;
  stationGroupMultiplierLabel: string | null;
  cacheUsage: TransitModelPrice["cacheUsage"];
  sevenDayRate: number | null;
  sevenDaySamples: number;
  firstCheckedAt: string | null;
  lastCheckedAt: string | null;
  recentSamples?: TransitModelPrice["availability"]["recentSamples"];
  latestLatencyMs: number | null;
  avgLatency7dMs: number | null;
  latestVerifiedAt: string;
  priceSource: string;
  availabilitySourceLabel: string;
  availabilitySourceTitle: string;
  availabilitySourceUrl: string | null;
  availabilitySourceType: TransitModelPrice["availability"]["sourceType"];
  availabilityEvidenceLabel: string;
  availabilityEvidenceTitle: string;
  availabilityEvidenceTone: "success" | "info" | "warning" | "muted";
  history: TransitMultiplierHistoryPoint[];
};

type TransitOutboundIntent = {
  url: string;
  isAff: boolean;
  offerId?: string | null;
  label?: string | null;
};

type StoredRiskConfirmation = {
  expiresAt: number;
  version: string;
};

const TRANSIT_RISK_CONFIRMATION_VERSION = "v1";
const TRANSIT_RISK_CONFIRMATION_DAYS = 30;
const TRANSIT_RISK_CONFIRMATION_STORAGE_PREFIX = "priceai.apiTransit.riskConfirmation";
const TRANSIT_RISK_WARNING_TEXT =
  "中转站存在跑路、余额损失、价格变动和渠道不可控风险。首次使用建议小额充值，勿囤积余额，充值前请回原站核验价格与规则。PriceAI 不售卖 API，也不替任何商家担保。";

export default function TransitStationDetail({ station, children }: Props) {
  const router = useRouter();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [copiedOfferId, setCopiedOfferId] = useState<string | null>(null);
  const [pendingOutbound, setPendingOutbound] = useState<TransitOutboundIntent | null>(null);
  const [rememberRiskConfirmation, setRememberRiskConfirmation] = useState(false);
  const familySummaries = getStationFamilySummaries(station);
  const stationAvailability = getStationPublishedAvailabilitySummary(station);
  const primaryOffer = getPrimaryTransitCommercialOffer(station);
  const commercialOffers = getActiveTransitCommercialOffers(station);
  const verificationEvents = getTransitVerificationEvents(station);
  const outboundOffer = getPrimaryTransitOutboundOffer(station);
  const outboundUrl = getTransitStationOutboundUrl(station, outboundOffer);
  const trackedOutboundUrl = transitOutboundUrl(station, outboundUrl, outboundOffer);
  const hasAffRelation = hasTransitAffRelation(station);
  const isAffOutbound = isTransitStationOutboundAff(station, outboundOffer);
  const outboundLabel = outboundOffer?.url ? "优惠入口" : "官网";
  const outboundButtonLabel = outboundOffer?.url ? "进入优惠入口" : "访问官网";

  const handleBack = useCallback(() => {
    const back = typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("back");
    if (back) {
      router.push(sanitizeListReturnHref(
        "/api-transit",
        back,
        ALLOWED_RETURN_KEYS as unknown as readonly string[]
      ));
      return;
    }
    router.back();
  }, [router]);

  const copyOfferCode = useCallback(async (offerId: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedOfferId(offerId);
      window.setTimeout(() => setCopiedOfferId(null), 1600);
    } catch {
      setCopiedOfferId(null);
    }
  }, []);

  const requestOutboundVisit = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, intent: TransitOutboundIntent) => {
      if (hasValidRiskConfirmation(station.slug, intent.url)) {
        return;
      }
      event.preventDefault();
      setRememberRiskConfirmation(false);
      setPendingOutbound(intent);
    },
    [station.slug],
  );

  const closeOutboundRiskDialog = useCallback(() => {
    setPendingOutbound(null);
    setRememberRiskConfirmation(false);
  }, []);

  const confirmOutboundVisit = useCallback(() => {
    if (!pendingOutbound) return;
    const targetUrl = pendingOutbound.url;
    if (rememberRiskConfirmation) {
      writeRiskConfirmation(station.slug, targetUrl);
    }
    closeOutboundRiskDialog();
    window.open(targetUrl, "_blank", "noopener,noreferrer");
  }, [closeOutboundRiskDialog, pendingOutbound, rememberRiskConfirmation, station.slug]);

  return (
    <div className="pb-16 sm:pb-14">
      <button
        type="button"
        onClick={handleBack}
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-[#5a6061] transition-colors hover:text-[#2d3435]"
      >
        <ArrowLeft className="h-4 w-4" />
        返回中转站列表
      </button>

      <section className="rounded-lg border border-[#dfe4e5] bg-white p-5 shadow-[0_20px_55px_rgba(45,52,53,0.045)]">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-start gap-4">
              <TransitStationSystemIcon station={station} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-[family-name:var(--font-serif)] text-2xl font-semibold leading-tight text-[#202829]">
                    {station.name}
                  </h1>
                  {primaryOffer ? (
                    <StatusChip tone={primaryOffer.type === "sponsored" ? "warning" : "success"}>
                      {TRANSIT_COMMERCIAL_OFFER_TYPE_LABELS[primaryOffer.type]}
                    </StatusChip>
                  ) : null}
                </div>
                <a
                  href={trackedOutboundUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => requestOutboundVisit(event, { url: trackedOutboundUrl, isAff: isAffOutbound, offerId: outboundOffer?.id || null, label: outboundLabel })}
                  aria-label={`访问 ${station.name} ${outboundLabel}`}
                  className="mt-1 inline-flex max-w-full items-center gap-1 text-sm font-semibold text-[#5a6061] transition-colors hover:text-[#2d3435]"
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{outboundLabel}</span>
                </a>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusChip tone={station.status === "active" ? "success" : station.status === "limited" ? "warning" : "muted"}>
                {TRANSIT_STATION_STATUS_LABELS[station.status]}
              </StatusChip>
              <StatusChip tone="info">{getTransitStationSystemLabel(station)}</StatusChip>
              <StatusChip tone={station.dataStatus === "verified" ? "success" : station.dataStatus === "sample" ? "warning" : "muted"}>
                数据状态：{TRANSIT_DATA_STATUS_LABELS[station.dataStatus]}
              </StatusChip>
              <span className="inline-flex items-center gap-1 text-xs text-[#5a6061]">
                <Clock className="h-3 w-3" />
                更新于 {formatDateDay(station.lastUpdatedAt)}
              </span>
            </div>

            <p className="mt-4 max-w-[86ch] text-sm leading-relaxed text-[#2d3435]">{station.summary}</p>

            <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              {familySummaries.slice(0, 2).map((summary) => (
                <MetricCard
                  key={summary.family}
                  label={`${TRANSIT_MODEL_FAMILY_LABELS[summary.family]} ${hasTransitFixedPriceSummary(summary) ? "固定价" : "综合倍率"}`}
                  value={hasTransitFixedPriceSummary(summary) ? formatTransitFixedPriceRange(summary) : formatRate(summary.combinedRateMin)}
                  helper={`${getFamilyPriceGroups(station, summary.family).length} 个分组`}
                />
              ))}
              {familySummaries.length === 0 ? (
                <MetricCard label="综合倍率" value="—" helper="暂无报价" />
              ) : null}
              <MetricCard label="可用率" value={formatPercent(stationAvailability.sevenDayRate)} helper={`样本 ${stationAvailability.sevenDaySamples}`} />
              <MetricCard label="最近检查" value={formatDateMinute(stationAvailability.lastCheckedAt)} helper={formatAvailabilityBasis(stationAvailability)} />
            </div>
          </div>

          <div className="rounded-lg bg-[#f7f9f9] p-4 ring-1 ring-[#adb3b4]/15">
            <CommercialOfferCard
              offers={commercialOffers}
              copiedOfferId={copiedOfferId}
              onCopy={copyOfferCode}
            />
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={trackedOutboundUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => requestOutboundVisit(event, { url: trackedOutboundUrl, isAff: isAffOutbound, offerId: outboundOffer?.id || null, label: outboundButtonLabel })}
                className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[#2d3435] px-4 text-sm font-bold text-[#f8f8f8] transition-colors hover:bg-[#202829]"
              >
                {outboundButtonLabel}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              {hasAffRelation ? (
                <span
                  className="inline-flex h-10 items-center rounded-full border border-dashed border-[#adb3b4]/70 px-3 text-xs font-extrabold text-[#5a6061]"
                  title="后台标记该站点存在 AFF 关系，不影响页面价格口径。"
                >
                  AFF
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                className="inline-flex h-10 items-center rounded-full bg-[#dde4e5] px-4 text-sm font-bold text-[#2d3435] transition-colors hover:bg-[#cfd8d9]"
              >
                提交反馈
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          {children ?? <TransitStationPricingPanels station={station} />}
        </div>

        <aside className="space-y-5">
          <TrustNotes station={station} />
          <VerificationTimeline events={verificationEvents} monitorUrl={station.monitorUrl} />
          <section className="rounded-lg border border-[#dfe4e5] bg-white p-5 shadow-[0_20px_55px_rgba(45,52,53,0.045)]">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-[#202829]">
              <AlertTriangle className="h-4 w-4" />
              来源渠道
            </h3>
            <InfoGroup label="公开标签" items={getNormalizedSourceTags(station).map((item) => item.label)} />
            {station.monitorUrl ? (
              <a
                href={station.monitorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex max-w-full items-center gap-1 text-xs font-semibold text-[#47657a] hover:text-[#202829]"
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">公开监测页</span>
              </a>
            ) : null}
          </section>
          <section className="rounded-lg border border-[#dfe4e5] bg-white p-5 shadow-[0_20px_55px_rgba(45,52,53,0.045)]">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-[#202829]">
              <HelpCircle className="h-4 w-4" />
              售后与规则
            </h3>
            <div className="space-y-3 text-xs">
              <InfoGroup label="支付方式" items={station.paymentMethods} />
              <TextLine label="最低充值" value={station.minimumTopUp} />
              <OptionalTextLine label="售后渠道" value={station.supportChannels.join("、")} />
              <OptionalTextLine label="余额有效期" value={station.balanceExpiry} />
              <OptionalTextLine label="退款说明" value={station.refundPolicy} />
            </div>
          </section>
        </aside>
      </div>

      {feedbackOpen ? (
        <FeedbackDialog
          onClose={() => setFeedbackOpen(false)}
          initialType="data"
          title={`${station.name} 数据反馈`}
          description="反馈这个中转站的价格、模型可用性、渠道来源或页面采集信息是否属实。"
          placeholder="例如：某个分组倍率变了、Claude Opus 不可用、渠道来源描述不准确、官网规则和这里不一致..."
          submitLabel="提交核验反馈"
          successMessage="已收到站点反馈，我会在后台和采集数据一起核验。"
          typeOptions={transitStationFeedbackTypes}
          messagePrefix={[
            "【API 中转站数据反馈】",
            `站点：${station.name}`,
            `官网：${station.websiteUrl}`,
            `系统：${getTransitStationSystemLabel(station)}`,
          ].join("\n")}
        />
      ) : null}
      {pendingOutbound ? (
        <OutboundRiskDialog
          station={station}
          intent={pendingOutbound}
          remember={rememberRiskConfirmation}
          onRememberChange={setRememberRiskConfirmation}
          onClose={closeOutboundRiskDialog}
          onConfirm={confirmOutboundVisit}
        />
      ) : null}
      <TransitRiskTicker />
    </div>
  );
}

export function TransitStationPricingPanels({
  station,
  focusedFamily = null,
}: {
  station: TransitStation;
  focusedFamily?: TransitModelFamily | null;
}) {
  const families = useMemo(() => getStationPriceFamilies(station), [station]);
  const familyKey = families.join("|");

  return (
    <TransitStationPricingPanelList
      key={`${station.id}:${familyKey}:${focusedFamily ?? "default"}`}
      station={station}
      families={families}
      focusedFamily={focusedFamily}
    />
  );
}

function TransitStationPricingPanelList({
  station,
  families,
  focusedFamily,
}: {
  station: TransitStation;
  families: TransitModelFamily[];
  focusedFamily: TransitModelFamily | null;
}) {
  const [expandedFamilies, setExpandedFamilies] = useState<Set<TransitModelFamily>>(
    () => getDefaultExpandedFamilies(families, focusedFamily),
  );

  const toggleFamily = useCallback((family: TransitModelFamily) => {
    setExpandedFamilies((current) => {
      const next = new Set(current);
      if (next.has(family)) {
        next.delete(family);
      } else {
        next.add(family);
      }
      return next;
    });
  }, []);

  return (
    <>
      {families.map((family) => (
        <PriceTable
          key={family}
          station={station}
          family={family}
          expanded={expandedFamilies.has(family)}
          onToggle={() => toggleFamily(family)}
        />
      ))}
      <AvailabilityTable station={station} />
    </>
  );
}

function getDefaultExpandedFamilies(
  families: TransitModelFamily[],
  focusedFamily: TransitModelFamily | null,
) {
  if (focusedFamily && families.includes(focusedFamily)) {
    return new Set<TransitModelFamily>([focusedFamily]);
  }

  const visibleCount = families.length > 3 ? 2 : families.length;
  return new Set(families.slice(0, visibleCount));
}

export function TransitStationPricingSkeleton() {
  return (
    <div className="space-y-5" aria-label="正在加载价格和监测历史" aria-busy="true">
      {["模型价格表", "监测样本"].map((title) => (
        <section
          key={title}
          className="overflow-hidden rounded-lg border border-[#dfe4e5] bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[#dfe4e5] bg-[#f2f4f4] px-4 py-3 sm:px-5">
            <div className="text-base font-extrabold text-[#202829]">{title}</div>
            <div className="h-5 w-24 rounded-full bg-[#dde4e5]" />
          </div>
          <div className="space-y-3 px-4 py-4 sm:px-5">
            <div className="h-[96px] rounded-lg border border-dashed border-[#cfd8d9] bg-[#f7f9f9]" />
            <div className="grid gap-2 md:grid-cols-4">
              {[0, 1, 2, 3].map((item) => (
                <div key={item} className="h-16 rounded-md bg-[#f2f4f4]" />
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function OutboundRiskDialog({
  station,
  intent,
  remember,
  onRememberChange,
  onClose,
  onConfirm,
}: {
  station: TransitStation;
  intent: TransitOutboundIntent;
  remember: boolean;
  onRememberChange: (checked: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const targetHost = getUrlHost(intent.url);

  useEffect(() => {
    confirmButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-[#202829]/35 px-3 py-4 backdrop-blur-[2px] sm:items-center sm:px-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-[720px] rounded-lg border border-[#dfe4e5] bg-[#f9f9f9] p-5 shadow-[0_24px_70px_rgba(32,40,41,0.18)] sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-[#c7efd5] bg-[#ecfff3] text-[#2f7a4b]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-extrabold text-[#2f7a4b]">风险提示</p>
              <h2 id={titleId} className="mt-1 text-xl font-extrabold leading-snug text-[#202829]">
                请在离站前阅读以下说明
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭风险提示"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#5a6061] transition-colors hover:bg-[#e9eeee] hover:text-[#202829] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f7a4b]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p id={descriptionId} className="mt-5 max-w-[70ch] text-sm leading-7 text-[#2d3435]">
          <strong className="font-extrabold text-[#2f7a4b]">外部站点不由 PriceAI 运营。</strong>
          PriceAI 只整理公开资料、监测结果和用户反馈，不等于背书、付款建议或服务承诺。中转站可能出现服务中断、价格变化、扣费异常、停运跑路、隐私泄露、余额无法退回等风险。请先核对目标站域名、服务条款、退款规则和密钥权限，并建议
          <strong className="font-extrabold text-[#202829]"> 按需小额充值，随用随充，不要一次性存入大额余额。</strong>
        </p>

        <div className="mt-5 rounded-lg border border-[#dfe4e5] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-[#7a8182]">目标站点</div>
              <div className="mt-1 text-sm font-extrabold text-[#202829]">{station.name}</div>
              <div className="mt-0.5 text-xs text-[#5a6061]">{targetHost}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {intent.isAff ? (
                <span className="rounded-full border border-dashed border-[#adb3b4]/70 px-3 py-1 text-xs font-extrabold text-[#5a6061]">
                  AFF
                </span>
              ) : null}
              <span className="rounded-full bg-[#e8f3ec] px-3 py-1 text-xs font-bold text-[#2f7a4b]">正在核验</span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[#5a6061]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => onRememberChange(event.target.checked)}
              className="h-4 w-4 rounded border-[#adb3b4] text-[#2f7a4b] focus:ring-[#2f7a4b]"
            />
            30 天内不再提示这个站点
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center rounded-full border border-[#dfe4e5] bg-white px-4 text-sm font-bold text-[#2d3435] transition-colors hover:bg-[#f2f4f4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f7a4b]"
            >
              返回详情页
            </button>
            <button
              type="button"
              ref={confirmButtonRef}
              onClick={onConfirm}
              className="inline-flex h-10 items-center rounded-full bg-[#bfeeca] px-5 text-sm font-extrabold text-[#1f5d36] transition-colors hover:bg-[#aee5ba] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f7a4b]"
            >
              我已了解，继续访问
            </button>
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] leading-5 text-[#9aa1a2]">
          勾选后，将按当前站点和目标域名记住 30 天；风险文案更新后会重新提示。
        </p>
      </section>
    </div>,
    document.body,
  );
}

function TransitRiskTicker() {
  const riskItems = [
    TRANSIT_RISK_WARNING_TEXT,
    "充值前请回原站核验价格、倍率、退款规则和服务条款。",
    "PriceAI 只整理公开资料、监测结果和用户反馈，不售卖 API，也不替任何商家担保。",
  ];

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-[#d97706]/50 bg-[#f59e0b] text-white shadow-[0_-8px_24px_rgba(45,52,53,0.10)]"
      role="status"
      aria-label="API 中转风险提示"
    >
      <div className="transit-risk-marquee overflow-hidden whitespace-nowrap">
        <div className="transit-risk-marquee-track inline-flex min-w-max items-center gap-8 py-2 text-sm font-extrabold">
          <TickerItems items={riskItems} />
          <span aria-hidden="true" className="inline-flex items-center gap-8">
            <TickerItems items={riskItems} />
          </span>
        </div>
      </div>
      <style>{`
        .transit-risk-marquee-track {
          animation: transit-risk-marquee 34s linear infinite;
        }

        .transit-risk-marquee:hover .transit-risk-marquee-track,
        .transit-risk-marquee:focus-within .transit-risk-marquee-track {
          animation-play-state: paused;
        }

        @keyframes transit-risk-marquee {
          from {
            transform: translateX(0);
          }
          to {
            transform: translateX(-50%);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .transit-risk-marquee-track {
            animation: none;
            transform: none;
          }
        }
      `}</style>
    </div>
  );
}

function TickerItems({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item) => (
        <span key={item} className="inline-flex items-center gap-8">
          <span>{item}</span>
          <span className="text-white/70">·</span>
        </span>
      ))}
    </>
  );
}

function getRiskConfirmationStorageKey(stationSlug: string, url: string) {
  return [
    TRANSIT_RISK_CONFIRMATION_STORAGE_PREFIX,
    TRANSIT_RISK_CONFIRMATION_VERSION,
    stationSlug,
    getUrlHost(url),
  ].join(".");
}

function hasValidRiskConfirmation(stationSlug: string, url: string) {
  if (typeof window === "undefined") return false;
  try {
    const key = getRiskConfirmationStorageKey(stationSlug, url);
    const rawValue = window.localStorage.getItem(key);
    if (!rawValue) return false;
    const parsed = JSON.parse(rawValue) as Partial<StoredRiskConfirmation>;
    if (parsed.version !== TRANSIT_RISK_CONFIRMATION_VERSION || typeof parsed.expiresAt !== "number") {
      window.localStorage.removeItem(key);
      return false;
    }
    if (parsed.expiresAt <= Date.now()) {
      window.localStorage.removeItem(key);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writeRiskConfirmation(stationSlug: string, url: string) {
  if (typeof window === "undefined") return;
  try {
    const value: StoredRiskConfirmation = {
      expiresAt: Date.now() + TRANSIT_RISK_CONFIRMATION_DAYS * 24 * 60 * 60 * 1000,
      version: TRANSIT_RISK_CONFIRMATION_VERSION,
    };
    window.localStorage.setItem(getRiskConfirmationStorageKey(stationSlug, url), JSON.stringify(value));
  } catch {
    // localStorage may be disabled; in that case the dialog simply appears next time.
  }
}

function getUrlHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function transitOutboundUrl(station: TransitStation, value: string, offer: TransitCommercialOffer | null): string {
  return withPriceAiUtm(value, {
    medium: "api_transit",
    campaign: "priceai_api_transit",
    content: offer?.id || station.slug,
  });
}

function CommercialOfferCard({
  offers,
  copiedOfferId,
  onCopy,
}: {
  offers: NonNullable<TransitStation["commercialOffers"]>;
  copiedOfferId: string | null;
  onCopy: (offerId: string, code: string) => void;
}) {
  const offer = offers[0];
  const shouldShowDisclosure = Boolean(offer?.disclosure);

  if (!offer) {
    return (
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-[#202829]">
          <Gift className="h-4 w-4" />
          可用优惠
        </h3>
        <p className="mt-2 text-xs leading-5 text-[#5a6061]">
          当前未收录公开优惠或 AFF 链接。使用前请回原站核验价格、充值比例和退款规则。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-[#202829]">
          <Gift className="h-4 w-4" />
          可用优惠
        </h3>
        <StatusChip tone={offer.type === "sponsored" ? "warning" : "success"} className="px-2 py-0.5 text-[11px]">
          {TRANSIT_COMMERCIAL_OFFER_TYPE_LABELS[offer.type]}
        </StatusChip>
      </div>
      {offer.title ? <p className="mt-2 text-sm font-bold leading-6 text-[#202829]">{offer.title}</p> : null}
      {offer.description ? <p className="mt-1 text-xs leading-5 text-[#5a6061]">{offer.description}</p> : null}
      {offer.code ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#dfe4e5] bg-white p-2">
          <code className="min-w-0 flex-1 truncate text-sm font-extrabold text-[#202829]">{offer.code}</code>
          <button
            type="button"
            onClick={() => onCopy(offer.id, offer.code || "")}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[#dde4e5] px-3 text-xs font-bold text-[#2d3435] hover:bg-[#cfd8d9]"
          >
            <Copy className="h-3.5 w-3.5" />
            {copiedOfferId === offer.id ? "已复制" : "复制"}
          </button>
        </div>
      ) : null}
      {offer.validUntil ? <p className="mt-2 text-xs text-[#5a6061]">有效期：{offer.validUntil}</p> : null}
      {shouldShowDisclosure ? (
        <p className="mt-2 rounded-lg bg-[#fff7e8] px-3 py-2 text-xs leading-5 text-[#7a541b]">{offer.disclosure}</p>
      ) : null}
    </div>
  );
}

function TrustNotes({ station }: { station: TransitStation }) {
  const strengths = station.strengths || [];
  const cautions = station.cautions || [];
  const reviewTags = getTransitReviewTags(station);

  return (
    <section className="rounded-lg border border-[#dfe4e5] bg-white p-5 shadow-[0_20px_55px_rgba(45,52,53,0.045)]">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-[#202829]">
        <ShieldCheck className="h-4 w-4" />
        核验提示
      </h3>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {reviewTags.map((tag) => (
          <span key={tag.id} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${tag.tone === "neutral" ? "bg-[#f2f4f4] text-[#5a6061]" : "bg-[#fff7e8] text-[#7a541b]"}`}>
            {tag.label}
          </span>
        ))}
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${getUsageAdviceBadgeClass(station.usageAdvice)}`}>
          {TRANSIT_USAGE_ADVICE_LABELS[station.usageAdvice]}
        </span>
      </div>

      <div className="grid gap-3">
        <NoteList title="优点" items={strengths.length ? strengths : ["已收录公开价格或运营整理信息"]} tone="success" />
        <NoteList title="注意事项" items={cautions.length ? cautions : ["首次使用建议小额充值，并回原站复核价格和规则"]} tone="warning" />
      </div>

      {station.feedback.publicNotes ? (
        <div className="mt-4 border-t border-[#dfe4e5] pt-4">
          <h4 className="mb-2 flex items-center gap-1 text-xs font-bold text-[#5a6061]">
            <Users className="h-3.5 w-3.5" />
            用户反馈
          </h4>
          <div className="mb-2 grid grid-cols-2 gap-2 text-xs">
            <span className="text-[#7a8182]">
              待核验：<strong className="text-[#7a541b]">{station.feedback.pendingCount}</strong>
            </span>
            <span className="text-[#7a8182]">
              已核验风险：<strong className="text-[#9b3328]">{station.feedback.verifiedRiskCount}</strong>
            </span>
          </div>
          {station.feedback.mainThemes.length ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {station.feedback.mainThemes.map((theme) => (
                <span key={theme} className="rounded-full bg-[#fff7e8] px-2 py-0.5 text-[10px] text-[#7a541b]">
                  {theme}
                </span>
              ))}
            </div>
          ) : null}
          <p className="text-xs leading-relaxed text-[#5a6061]">{station.feedback.publicNotes}</p>
        </div>
      ) : null}
    </section>
  );
}

function NoteList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "success" | "warning";
}) {
  const className = tone === "success" ? "bg-[#f5fbf7] text-[#2f7a4b]" : "bg-[#fffaf0] text-[#7a541b]";
  return (
    <div className={`rounded-lg px-3 py-3 ${className}`}>
      <div className="mb-1.5 text-xs font-extrabold">{title}</div>
      <ul className="space-y-1 text-xs leading-5">
        {items.slice(0, 4).map((item) => (
          <li key={item} className="flex gap-1.5">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerificationTimeline({
  events,
  monitorUrl,
}: {
  events: NonNullable<TransitStation["verificationEvents"]>;
  monitorUrl?: string | null;
}) {
  return (
    <section className="rounded-lg border border-[#dfe4e5] bg-white p-5 shadow-[0_20px_55px_rgba(45,52,53,0.045)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-[#202829]">
          <Clock className="h-4 w-4" />
          核验记录
        </h3>
        {monitorUrl ? (
          <StatusChip tone="info" className="px-2 py-0.5 text-[11px]">有监测页</StatusChip>
        ) : null}
      </div>
      <div className="space-y-3">
        {events.slice(0, 6).map((event) => (
          <div key={event.id} className="relative pl-4">
            <span className={`absolute left-0 top-1.5 h-2 w-2 rounded-full ${verificationDotClass(event.status)}`} />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold text-[#202829]">{event.title}</span>
              <span className="rounded-full bg-[#f2f4f4] px-2 py-0.5 text-[10px] font-bold text-[#5a6061]">
                {TRANSIT_VERIFICATION_EVENT_SOURCE_LABELS[event.source]}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-[#7a8182]">{formatDateMinute(event.happenedAt)}</p>
            {event.description ? <p className="mt-1 text-xs leading-5 text-[#5a6061]">{event.description}</p> : null}
          </div>
        ))}
        {!events.length ? (
          <p className="text-xs leading-5 text-[#5a6061]">暂无结构化核验记录，仅展示现有价格与反馈数据。</p>
        ) : null}
      </div>
    </section>
  );
}

function verificationDotClass(status: NonNullable<TransitStation["verificationEvents"]>[number]["status"]) {
  if (status === "success") return "bg-[#2f7a4b]";
  if (status === "warning") return "bg-[#c7861d]";
  if (status === "failed") return "bg-[#9b3328]";
  return "bg-[#47657a]";
}

function PriceTable({
  station,
  family,
  expanded,
  onToggle,
}: {
  station: TransitStation;
  family: TransitModelFamily;
  expanded: boolean;
  onToggle: () => void;
}) {
  const groups = getFamilyPriceGroups(station, family);
  const summary = getFamilyRateSummary(station, family);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const trend = buildFamilyTrend(groups);
  const fixedPriceSummary = hasTransitFixedPriceSummary(summary);
  const panelId = useId();
  const titleId = useId();

  return (
    <section className="overflow-hidden rounded-lg border border-[#dfe4e5] bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dfe4e5] bg-[#f2f4f4] px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-extrabold text-[#202829]">
            {TRANSIT_MODEL_FAMILY_LABELS[family]} 价格表
          </h2>
          <p className="mt-0.5 text-xs font-semibold text-[#5a6061]">
            {summary.priceCount} 条报价 · {groups.length} 个分组
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${expanded ? "收起" : "展开"} ${TRANSIT_MODEL_FAMILY_LABELS[family]} 价格表`}
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[#dfe4e5] bg-white px-3 py-2 text-xs font-extrabold text-[#2d3435] shadow-sm transition-colors hover:bg-[#edf4f1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f7a4b]"
        >
          <span className="hidden sm:inline">{fixedPriceSummary ? "最低固定价" : "最低综合倍率"}</span>
          <span>{fixedPriceSummary ? formatTransitFixedPriceRange(summary) : formatRate(summary.combinedRateMin)}</span>
          <span className="h-3.5 w-px bg-[#dfe4e5]" aria-hidden="true" />
          <span>{expanded ? "收起" : "展开"}</span>
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </div>
      <div id={panelId}>
        {expanded && groups.length ? (
          <>
            {fixedPriceSummary ? null : <MultiplierTrendPanel family={family} groups={groups} trend={trend} />}
            {isDesktop === false ? (
              <div className="divide-y divide-[#dfe4e5]">
                {groups.map((group) => (
                  <PriceGroupMobileCard
                    key={`${family}-${group.groupName}`}
                    station={station}
                    group={group}
                  />
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] table-fixed border-collapse">
                  <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[25%]" />
                    <col className="w-[21%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-[#f2f4f4]/50">
                      <DataTableHead compact>分组 / 模型</DataTableHead>
                      <DataTableHead compact explanation={TRANSIT_COMBINED_RATE_EXPLANATION}>{fixedPriceSummary ? "人民币固定价" : "综合倍率"}</DataTableHead>
                      <DataTableHead compact explanation={TRANSIT_CACHE_HIT_RATE_EXPLANATION}>缓存命中率</DataTableHead>
                      <DataTableHead compact explanation={TRANSIT_MONITORED_PRICE_EXPLANATION}>{fixedPriceSummary ? "公开价格" : "监测模型价格"}</DataTableHead>
                      <DataTableHead compact explanation="展示监测证据的真实覆盖范围、来源和更新时间。分组监测只计一次；同模型或同家族数据会明确标为参考，不代表套餐独立实测。">监测 / 来源</DataTableHead>
                    </tr>
                  </thead>
                  <tbody>
                  {groups.map((group) => (
                    <PriceGroupRow
                      key={`${family}-${group.groupName}`}
                      station={station}
                      group={group}
                    />
                  ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : expanded ? (
          <div className="px-4 py-8 text-sm text-[#5a6061] sm:px-5">这个站点暂未收录 {TRANSIT_MODEL_FAMILY_LABELS[family]} 报价。</div>
        ) : null}
      </div>
    </section>
  );
}

type FamilyTrend = {
  series: TrendSeries[];
  points: TrendPoint[];
  min: number | null;
  max: number | null;
  change: number | null;
  largestGroupChange: { groupName: string; change: number; from: number; to: number } | null;
  observedStart: string | null;
  observedEnd: string | null;
  hasHistoricalData: boolean;
};

type TrendSeries = {
  groupName: string;
  points: TrendPoint[];
  current: number | null;
  change: number | null;
};

type TrendPoint = {
  label: string;
  observedAt: string;
  value: number;
};

const TREND_SERIES_COLORS = ["#2f7a4b", "#47657a", "#c7861d", "#8a5fbf", "#9b3328", "#4f7c7a"];

function MultiplierTrendPanel({
  family,
  groups,
  trend,
}: {
  family: TransitModelFamily;
  groups: TransitPriceGroup[];
  trend: FamilyTrend;
}) {
  return (
    <div className="border-b border-[#dfe4e5] bg-white px-4 py-4 sm:px-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-extrabold text-[#202829]">
                {TRANSIT_MODEL_FAMILY_LABELS[family]} 综合倍率趋势
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-[#5a6061]">
                {formatTrendWindow(trend)}
              </p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ${trendAlertClass(trend.largestGroupChange?.change ?? null)}`}>
              {formatTrendChangeLabel(trend)}
            </span>
          </div>
          <TrendSparkline trend={trend} />
          {trend.series.length > 1 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {trend.series.map((series, index) => (
                <span key={series.groupName} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#5a6061]">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: trendSeriesColor(index) }}
                    aria-hidden="true"
                  />
                  <span className="max-w-[16ch] truncate">{series.groupName}</span>
                  <span className="tabular-nums text-[#202829]">{formatRate(series.current)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="grid gap-2 text-xs">
          <TrendFact label="当前最低" value={formatRate(getCurrentTrendMinimum(trend))} />
          <TrendFact label="观察范围" value={formatRateRange(trend.min, trend.max)} />
          <TrendFact label="分组数" value={`${groups.length} 个分组`} />
        </div>
      </div>
    </div>
  );
}

function TrendSparkline({ trend }: { trend: FamilyTrend }) {
  if (!trend.points.length || !trend.series.length) {
    return (
      <div className="flex h-[96px] items-center justify-center rounded-lg border border-dashed border-[#cfd8d9] bg-[#f7f9f9] text-xs font-semibold text-[#7a8182]">
        暂无倍率历史，等待后续采集沉淀曲线
      </div>
    );
  }

  const width = 720;
  const height = 156;
  const paddingLeft = 46;
  const paddingRight = 16;
  const paddingTop = 16;
  const paddingBottom = 30;
  const values = trend.points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const domainPadding = min === max ? Math.max(0.05, min * 0.1) : 0;
  const domainMin = Math.max(0, min - domainPadding);
  const domainMax = max + domainPadding;
  const range = domainMax - domainMin || 1;
  const yTicks = buildTrendTicks(domainMin, domainMax);
  const timestamps = Array.from(new Set(trend.points.map((point) => point.observedAt)))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  const xTicks = xAxisTicks(timestamps);
  const timeIndex = new Map(timestamps.map((timestamp, index) => [timestamp, index]));
  const denominator = Math.max(timestamps.length - 1, 1);
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;
  const xForIndex = (index: number) =>
    paddingLeft + (timestamps.length === 1 ? 0.5 : index / denominator) * plotWidth;
  const yForValue = (value: number) =>
    paddingTop + (1 - (value - domainMin) / range) * plotHeight;
  const seriesPaths = trend.series
    .map((series, seriesIndex) => {
      const coords = series.points
        .map((point) => {
          const index = timeIndex.get(point.observedAt);
          if (index === undefined) return null;
          const x = xForIndex(index);
          const y = yForValue(point.value);
          return { x, y, point };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const path = coords.map((item, index) => `${index === 0 ? "M" : "L"} ${item.x.toFixed(2)} ${item.y.toFixed(2)}`).join(" ");
      return { series, seriesIndex, coords, path };
    })
    .filter((item) => item.coords.length);

  return (
    <div className="overflow-hidden rounded-lg border border-[#dfe4e5] bg-[#f9fbfa]">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[156px] w-full" role="img" aria-label={trendAriaLabel(trend)}>
        <rect x={paddingLeft} y={paddingTop} width={plotWidth} height={plotHeight} fill="#ffffff" opacity="0.62" />
        {yTicks.map((tick) => {
          const y = yForValue(tick);
          return (
            <g key={`y-${tick}`}>
              <line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} stroke="#dfe4e5" strokeDasharray="3 4" />
              <text x={paddingLeft - 8} y={y + 3.5} textAnchor="end" className="fill-[#7a8182] text-[10px] font-semibold">
                {formatRate(tick)}
              </text>
            </g>
          );
        })}
        <line x1={paddingLeft} x2={paddingLeft} y1={paddingTop} y2={height - paddingBottom} stroke="#cfd8d9" />
        <line x1={paddingLeft} x2={width - paddingRight} y1={height - paddingBottom} y2={height - paddingBottom} stroke="#cfd8d9" />
        {xTicks.map((timestamp, index) => {
          const tickIndex = timeIndex.get(timestamp) ?? 0;
          const x = xForIndex(tickIndex);
          return (
            <g key={`x-${timestamp}`}>
              <line x1={x} x2={x} y1={height - paddingBottom} y2={height - paddingBottom + 4} stroke="#cfd8d9" />
              <text
                x={x}
                y={height - 10}
                textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
                className="fill-[#7a8182] text-[10px] font-semibold"
              >
                {formatDateShortMinute(timestamp)}
              </text>
            </g>
          );
        })}
        {seriesPaths.map(({ series, seriesIndex, path, coords }) => (
          <g key={series.groupName}>
            <path
              d={path}
              fill="none"
              stroke={trendSeriesColor(seriesIndex)}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={seriesIndex === 0 ? 2.8 : 2}
              opacity={seriesIndex === 0 ? 1 : 0.78}
            />
            {coords.map((item, index) => (
              <circle
                key={`${series.groupName}-${item.point.observedAt}-${index}`}
                cx={item.x}
                cy={item.y}
                r={index === coords.length - 1 ? 4 : 2.7}
                stroke="#ffffff"
                strokeWidth="1.5"
                fill={index === coords.length - 1 ? "#202829" : trendSeriesColor(seriesIndex)}
              >
                <title>{`${series.groupName} · 综合倍率 ${formatRate(item.point.value)} · ${formatDateShortMinute(item.point.observedAt)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

function buildTrendTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  return [max, (min + max) / 2, min];
}

function xAxisTicks(timestamps: string[]): string[] {
  if (timestamps.length <= 2) return timestamps;
  return [timestamps[0], timestamps[Math.floor((timestamps.length - 1) / 2)], timestamps.at(-1) as string];
}

function TrendFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[#f7f9f9] px-3 py-2 ring-1 ring-[#adb3b4]/15">
      <div className="text-[10px] font-bold text-[#7a8182]">{label}</div>
      <div className="mt-0.5 text-sm font-extrabold tabular-nums text-[#202829]">{value}</div>
    </div>
  );
}

function buildFamilyTrend(groups: TransitPriceGroup[]): FamilyTrend {
  const timestamps = new Set<string>();
  const series = groups
    .map((group) => {
      const points = group.history
        .filter((point) => point.combinedRate !== null && Number.isFinite(point.combinedRate))
        .map((point) => ({
          label: group.groupName,
          observedAt: point.observedAt,
          value: point.combinedRate as number,
        }))
        .sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime())
        .slice(-18);

      for (const point of points) timestamps.add(point.observedAt);
      const first = points[0]?.value ?? null;
      const last = points.at(-1)?.value ?? null;
      return {
        groupName: group.groupName,
        points,
        current: last,
        change: first !== null && last !== null && points.length >= 2 ? last - first : null,
      };
    })
    .filter((item) => item.points.length)
    .sort((left, right) => nullableSortValue(left.current) - nullableSortValue(right.current));

  const timeline = Array.from(timestamps)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())
    .slice(-18);
  const timelineSet = new Set(timeline);
  const points = series.flatMap((item) => item.points.filter((point) => timelineSet.has(point.observedAt)));
  const values = points.map((point) => point.value);
  const changeCandidates = series
    .filter((item): item is TrendSeries & { change: number; current: number } =>
      item.change !== null && item.current !== null && Number.isFinite(item.change)
    )
    .map((item) => ({
      groupName: item.groupName,
      change: item.change,
      from: item.current - item.change,
      to: item.current,
    }));
  const largestGroupChange = changeCandidates.sort((left, right) => Math.abs(right.change) - Math.abs(left.change))[0] || null;

  return {
    series,
    points,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    change: largestGroupChange?.change ?? null,
    largestGroupChange,
    observedStart: timeline[0] || null,
    observedEnd: timeline.at(-1) || null,
    hasHistoricalData: series.some((item) => item.points.length > 1),
  };
}

function normalizedGroupHistory(
  station: TransitStation,
  price: TransitModelPrice
): TransitMultiplierHistoryPoint[] {
  const combinedRate = getCombinedRateForPrice(station, price);
  const currentPoint =
    combinedRate === null
      ? null
      : {
          observedAt: price.lastVerifiedAt,
          rechargeRatio: price.rechargeRatio,
          rechargeCoefficient:
            getRechargeCoefficientFromRatio(price.rechargeRatio) ??
            getStationRechargeCoefficient(station),
          modelMultiplier: price.modelMultiplier,
          combinedRate,
          priceSource: price.priceSource,
        };
  const points = [...(price.history || [])];

  if (currentPoint) {
    const existingCurrent = points.some((point) =>
      point.observedAt === currentPoint.observedAt &&
      point.combinedRate !== null &&
      Math.abs(point.combinedRate - currentPoint.combinedRate) < 0.0001
    );
    if (!existingCurrent) points.push(currentPoint);
  }

  return points
    .filter((point) => point.combinedRate !== null && Number.isFinite(point.combinedRate))
    .sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime());
}

function formatTrendWindow(trend: FamilyTrend): string {
  if (!trend.points.length) return "暂无历史记录，后续采集后生成倍率曲线。";
  const windowText =
    trend.observedStart && trend.observedEnd && trend.observedStart !== trend.observedEnd
      ? `${formatDateShortMinute(trend.observedStart)} - ${formatDateShortMinute(trend.observedEnd)}`
      : `当前快照 ${formatDateShortMinute(trend.observedEnd)}`;
  const sourceText = trend.hasHistoricalData ? "历史快照" : "当前快照";
  return `${sourceText} · ${windowText}`;
}

function formatTrendChangeLabel(trend: FamilyTrend): string {
  if (!trend.points.length) return "等待记录";
  const change = trend.largestGroupChange?.change ?? trend.change;
  if (change === null || !Number.isFinite(change) || Math.abs(change) < 0.005) return "倍率稳定";
  return `最大变动 ${trend.largestGroupChange?.groupName ? `${trend.largestGroupChange.groupName} ` : ""}${formatRateDelta(change)}`;
}

function trendAlertClass(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return "bg-[#f2f4f4] text-[#5a6061]";
  const absolute = Math.abs(change);
  if (absolute >= 0.5) return "bg-[#fbe9e7] text-[#9b3328]";
  if (absolute >= 0.2) return "bg-[#fff7e8] text-[#7a541b]";
  return "bg-[#e8f3ec] text-[#2f7a4b]";
}

function trendAriaLabel(trend: FamilyTrend): string {
  if (!trend.points.length) return "暂无倍率历史趋势";
  return `综合倍率趋势，${formatTrendWindow(trend)}，${formatTrendChangeLabel(trend)}`;
}

function formatRateRange(min: number | null, max: number | null): string {
  if (min === null || max === null) return "—";
  if (min === max) return formatRate(min);
  return `${formatRate(min)} - ${formatRate(max)}`;
}

function formatRateDelta(value: number): string {
  const prefix = value > 0 ? "+" : "-";
  return `${prefix}${formatRate(Math.abs(value))}`;
}

function getCurrentTrendMinimum(trend: FamilyTrend): number | null {
  const values = trend.series
    .map((series) => series.current)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function trendSeriesColor(index: number): string {
  return TREND_SERIES_COLORS[index % TREND_SERIES_COLORS.length];
}

function PriceGroupMobileCard({
  station,
  group,
}: {
  station: TransitStation;
  group: TransitPriceGroup;
}) {
  const primaryPrice = group.primaryPrice;
  const channelLabels = uniqueStrings(group.prices.map((price) => TRANSIT_CHANNEL_TYPE_LABELS[price.channelType]));
  const poolLabels = uniqueStrings(group.prices.map((price) => TRANSIT_ACCOUNT_POOL_LABELS[price.accountPool]));

  return (
    <article className="px-4 py-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-extrabold leading-5 text-[#202829]">{group.groupName}</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {group.prices.map((price) => (
              <span
                key={`${group.groupName}-${price.standardModel}`}
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  price.standardModel === primaryPrice.standardModel
                    ? "bg-[#e8f3ec] text-[#2f7a4b]"
                    : "bg-[#f2f4f4] text-[#5a6061]"
                }`}
              >
                {shortModelLabel(price.standardModel)}
              </span>
            ))}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-extrabold ${getRateBadgeClass(group.combinedRate)}`}>
          {group.isFixedPrice ? group.fixedPriceLabel : formatRate(group.combinedRate)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <MobilePriceFact label="充值" value={group.isFixedPrice ? "已折算人民币" : formatRate(group.rechargeCoefficient)} />
        {group.stationGroupMultiplierLabel ? (
          <MobilePriceFact
            label="站方倍率"
            value={group.stationGroupMultiplierLabel}
            title="站方公开快照中的分组倍率，未乘官方模型价差。"
          />
        ) : null}
        <MobilePriceFact label={group.isFixedPrice ? "固定价" : "模型倍率"} value={group.isFixedPrice ? group.fixedPriceLabel : group.modelMultiplierLabel} />
        <MobilePriceFact
          label="缓存命中率"
          value={group.isFixedPrice ? "不适用" : formatCacheHitRate(group.cacheUsage)}
          valueClassName={getCacheHitRateTextClass(group.cacheUsage)}
          title={TRANSIT_CACHE_HIT_RATE_EXPLANATION}
        />
        <MobilePriceFact label="覆盖" value={`${group.prices.length} 个模型`} />
        <MobilePriceFact
          label="可用性"
          value={formatAvailability({
            sevenDayRate: group.sevenDayRate,
            sevenDaySamples: group.sevenDaySamples,
            recentSamples: group.recentSamples,
          })}
        />
      </div>

      <div className="mt-3">
        <TransitPriceBreakdown station={station} price={primaryPrice} mode="detail" />
        {group.isFixedPrice ? null : (
          <p className="mt-1.5 text-[11px] leading-5 text-[#5a6061]">
            按 {primaryPrice.standardModel} 官方价换算
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {channelLabels.map((label) => (
          <StatusChip key={label} tone="success" className="px-2 py-0.5 text-[10px]">
            {label}
          </StatusChip>
        ))}
        {poolLabels.map((label) => (
          <StatusChip key={label} tone="info" className="px-2 py-0.5 text-[10px]">
            {label}
          </StatusChip>
        ))}
        <span title={group.availabilityEvidenceTitle}>
          <StatusChip tone={group.availabilityEvidenceTone} className="px-2 py-0.5 text-[10px]">
            {group.availabilityEvidenceLabel}
          </StatusChip>
        </span>
        <ProbePolicyTag
          label={group.availabilitySourceLabel}
          title={group.availabilitySourceTitle}
          href={group.availabilitySourceUrl}
        />
      </div>

      <div className="mt-3 flex min-w-0 items-center gap-2">
        <TransitAvailabilityStrip
          rate={group.sevenDayRate}
          samples={group.sevenDaySamples}
          firstCheckedAt={group.firstCheckedAt}
          lastCheckedAt={group.lastCheckedAt}
          recentSamples={group.recentSamples}
          className="shrink-0"
        />
        <span className="min-w-0 break-words text-xs font-semibold leading-5 text-[#2d3435]">
          {group.priceSource || "未公开"}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[#5a6061]">{formatDateShortMinute(group.latestVerifiedAt)}</div>
    </article>
  );
}

function MobilePriceFact({
  label,
  value,
  valueClassName = "text-[#202829]",
  title,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-[#f7f9f9] px-2.5 py-2 ring-1 ring-[#adb3b4]/15" title={title}>
      <div className="truncate text-[10px] font-bold text-[#7a8182]">{label}</div>
      <div className={`mt-0.5 break-words text-xs font-extrabold tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  );
}

function CacheHitCell({
  cacheUsage,
  isFixedPrice = false,
}: {
  cacheUsage: TransitModelPrice["cacheUsage"];
  isFixedPrice?: boolean;
}) {
  return (
    <div
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-extrabold tabular-nums ${isFixedPrice ? "bg-[#f2f4f4] text-[#7f8889]" : getCacheHitRateBadgeClass(cacheUsage)}`}
      title={TRANSIT_CACHE_HIT_RATE_EXPLANATION}
    >
      {isFixedPrice ? "不适用" : formatCacheHitRate(cacheUsage)}
    </div>
  );
}

function PriceGroupRow({
  station,
  group,
}: {
  station: TransitStation;
  group: TransitPriceGroup;
}) {
  const primaryPrice = group.primaryPrice;
  const channelLabels = uniqueStrings(group.prices.map((price) => TRANSIT_CHANNEL_TYPE_LABELS[price.channelType]));
  const poolLabels = uniqueStrings(group.prices.map((price) => TRANSIT_ACCOUNT_POOL_LABELS[price.accountPool]));
  const hasLatencySummary = group.latestLatencyMs !== null && group.latestLatencyMs !== undefined
    || group.avgLatency7dMs !== null && group.avgLatency7dMs !== undefined;

  return (
    <tr className="border-b border-[#dfe4e5] align-top transition hover:bg-[#f7f9f9]">
      <td className="px-4 py-4">
        <div className="break-words text-sm font-extrabold text-[#202829]">{group.groupName}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {group.prices.map((price) => (
            <span
              key={`${group.groupName}-${price.standardModel}`}
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                price.standardModel === primaryPrice.standardModel
                  ? "bg-[#e8f3ec] text-[#2f7a4b]"
                  : "bg-[#f2f4f4] text-[#5a6061]"
              }`}
            >
              {shortModelLabel(price.standardModel)}
            </span>
          ))}
        </div>
        <ProbePolicyTag
          className="mt-2"
          label={`监测 ${shortModelLabel(primaryPrice.standardModel)}`}
          title={`当前价格分组以 ${shortModelLabel(primaryPrice.standardModel)} 作为代表模型；监测口径为“${group.availabilityEvidenceLabel}”。`}
        />
      </td>
      <td className="px-4 py-4">
        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-extrabold ${getRateBadgeClass(group.combinedRate)}`}>
          {group.isFixedPrice ? group.fixedPriceLabel : formatRate(group.combinedRate)}
        </span>
        <div className="mt-2 space-y-1 text-[11px] font-semibold text-[#5a6061]">
          <div title={TRANSIT_RECHARGE_COEFFICIENT_EXPLANATION}>
            {group.isFixedPrice ? "已按充值比例折算人民币" : `充值倍率 ${formatRate(group.rechargeCoefficient)}`}
          </div>
          {group.stationGroupMultiplierLabel ? (
            <div title="站方公开快照中的分组倍率，未乘官方模型价差。">
              站方倍率 {group.stationGroupMultiplierLabel}
            </div>
          ) : null}
          <div title={TRANSIT_MODEL_MULTIPLIER_EXPLANATION}>
            {group.isFixedPrice ? `固定价 ${group.fixedPriceLabel}` : `模型倍率 ${group.modelMultiplierLabel}`}
          </div>
          <div>{group.prices.length} 个模型</div>
        </div>
      </td>
      <td className="px-4 py-4">
        <CacheHitCell cacheUsage={group.cacheUsage} isFixedPrice={group.isFixedPrice} />
      </td>
      <td className="px-4 py-3">
        <TransitPriceBreakdown station={station} price={primaryPrice} mode="detail" />
        {group.isFixedPrice ? null : (
          <p className="mt-1.5 text-[11px] leading-5 text-[#5a6061]">
            按 {primaryPrice.standardModel} 官方价换算
          </p>
        )}
      </td>
      <td className="px-4 py-4">
        <div className="flex flex-wrap gap-1.5">
          {channelLabels.map((label) => (
            <StatusChip key={label} tone="success" className="px-2 py-0.5 text-[10px]">
              {label}
            </StatusChip>
          ))}
          {poolLabels.map((label) => (
            <StatusChip key={label} tone="info" className="px-2 py-0.5 text-[10px]">
              {label}
            </StatusChip>
          ))}
          <span title={group.availabilityEvidenceTitle}>
            <StatusChip tone={group.availabilityEvidenceTone} className="px-2 py-0.5 text-[10px]">
              {group.availabilityEvidenceLabel}
            </StatusChip>
          </span>
          <ProbePolicyTag
            label={group.availabilitySourceLabel}
            title={group.availabilitySourceTitle}
            href={group.availabilitySourceUrl}
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs font-bold text-[#202829]">
            {formatAvailability({
              sevenDayRate: group.sevenDayRate,
              sevenDaySamples: group.sevenDaySamples,
              recentSamples: group.recentSamples,
            })}
          </span>
          <TransitAvailabilityStrip
            rate={group.sevenDayRate}
            samples={group.sevenDaySamples}
            firstCheckedAt={group.firstCheckedAt}
            lastCheckedAt={group.lastCheckedAt}
            recentSamples={group.recentSamples}
          />
        </div>
        <div className="mt-2 break-words text-xs font-semibold text-[#2d3435]">{group.priceSource || "未公开"}</div>
        {hasLatencySummary ? (
          <div className="mt-1">
            <TransitLatencyBadge
              latestLatencyMs={group.latestLatencyMs}
              avgLatency7dMs={group.avgLatency7dMs}
              prefix="响应延迟："
            />
          </div>
        ) : null}
        <div className="mt-1 whitespace-nowrap text-[11px] text-[#5a6061]">
          {availabilityTimestampLabel(group.availabilitySourceType)} {formatDateShortMinute(group.lastCheckedAt || group.latestVerifiedAt)}
        </div>
      </td>
    </tr>
  );
}

function getFamilyPriceGroups(
  station: TransitStation,
  family: TransitModelFamily,
): TransitPriceGroup[] {
  const grouped = new Map<string, TransitModelPrice[]>();
  for (const price of getFamilyPrices(station, family)) {
    const groupName = price.groupName || "默认分组";
    const prices = grouped.get(groupName) || [];
    prices.push(price);
    grouped.set(groupName, prices);
  }

  return Array.from(grouped.entries())
    .map(([groupName, prices]) => buildPriceGroup(station, groupName, prices))
    .sort((left, right) => nullableSortValue(left.combinedRate) - nullableSortValue(right.combinedRate));
}

function buildPriceGroup(
  station: TransitStation,
  groupName: string,
  prices: TransitModelPrice[],
): TransitPriceGroup {
  const primaryPrice = getRepresentativeTransitPrice(prices) ?? prices[0];
  const availabilityPrices = getPreferredTransitAvailabilityRollupPrices(station, prices);
  const sortedPrices = [
    primaryPrice,
    ...prices.filter((price) => price !== primaryPrice).sort(comparePricePriority),
  ];
  const rechargeCoefficient =
    getRechargeCoefficientFromRatio(primaryPrice.rechargeRatio) ??
    getStationRechargeCoefficient(station);
  const modelMultipliers = prices
    .map((price) => price.modelMultiplier)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const fixedPrices = prices
    .map((price) => isTransitFixedPrice(price) ? getTransitFixedPriceValue(price) : null)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const stationGroupMultipliers = prices
    .map((price) => price.stationGroupMultiplier)
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  const availabilitySamples = availabilityPrices.reduce((total, price) => total + price.availability.sevenDaySamples, 0);
  const weightedAvailability =
    availabilitySamples > 0
      ? availabilityPrices.reduce(
          (total, price) => total + (price.availability.sevenDayRate ?? 0) * price.availability.sevenDaySamples,
          0
        ) / availabilitySamples
      : null;
  const lastCheckedAt =
    availabilityPrices
      .map((price) => price.availability.lastCheckedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const firstCheckedAt =
    availabilityPrices
      .map((price) => price.availability.firstCheckedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(0) ?? null;
  const latestVerifiedAt =
    prices
      .map((price) => price.lastVerifiedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? primaryPrice.lastVerifiedAt;
  const availabilityPrice = availabilityPrices[0] || primaryPrice;
  const availabilitySource = getTransitPriceAvailabilitySource(station, availabilityPrice);
  const recentSamples = getRecentTransitAvailabilitySamples(availabilityPrices);
  const sourceMeta = getAvailabilitySourceMeta(availabilitySource);
  const evidenceMeta = getAvailabilityEvidenceMeta(availabilityPrice.availability);

  return {
    groupName,
    prices: sortedPrices,
    primaryPrice,
    combinedRate: getCombinedRateForPrice(station, primaryPrice),
    rechargeCoefficient,
    modelMultiplierMin: modelMultipliers.length ? Math.min(...modelMultipliers) : null,
    modelMultiplierMax: modelMultipliers.length ? Math.max(...modelMultipliers) : null,
    modelMultiplierLabel: formatModelGroupMultiplierLabel(primaryPrice, modelMultipliers),
    fixedPriceMin: fixedPrices.length ? Math.min(...fixedPrices) : null,
    fixedPriceMax: fixedPrices.length ? Math.max(...fixedPrices) : null,
    fixedPriceLabel: formatTransitFixedPriceRange({
      fixedPriceMin: fixedPrices.length ? Math.min(...fixedPrices) : null,
      fixedPriceMax: fixedPrices.length ? Math.max(...fixedPrices) : null,
    }),
    isFixedPrice: fixedPrices.length > 0 && modelMultipliers.length === 0,
    stationGroupMultiplierLabel: formatOptionalModelRateRange(stationGroupMultipliers),
    cacheUsage: getRepresentativeCacheUsage(prices),
    sevenDayRate: weightedAvailability,
    sevenDaySamples: availabilitySamples,
    firstCheckedAt,
    lastCheckedAt,
    recentSamples,
    latestLatencyMs: latestLatencyFromPrices(availabilityPrices),
    avgLatency7dMs: weightedAverageLatencyFromPrices(availabilityPrices),
    latestVerifiedAt,
    priceSource: primaryPrice.priceSource,
    availabilitySourceLabel: sourceMeta.label,
    availabilitySourceTitle: sourceMeta.title,
    availabilitySourceUrl: sourceMeta.url,
    availabilitySourceType: availabilitySource.sourceType,
    availabilityEvidenceLabel: evidenceMeta.label,
    availabilityEvidenceTitle: evidenceMeta.title,
    availabilityEvidenceTone: evidenceMeta.tone,
    history: normalizedGroupHistory(station, primaryPrice),
  };
}

function availabilityTimestampLabel(sourceType: TransitModelPrice["availability"]["sourceType"]): string {
  if (sourceType === "priceai_probe") return "实测确认";
  if (sourceType === "station_monitor") return "站方监测";
  if (sourceType === "public_status") return "站方更新";
  if (sourceType === "public_model_catalog") return "快照更新";
  if (sourceType === "partner_api") return "接口更新";
  return "资料更新";
}

function comparePricePriority(left: TransitModelPrice, right: TransitModelPrice): number {
  return compareTransitModelPriority(left, right);
}

function shortModelLabel(model: TransitModelPrice["standardModel"]): string {
  if (model === "Nano Banana Pro") return "Banana Pro";
  if (model === "Nano Banana 2") return "Banana 2";
  if (model === "Nano Banana") return "Banana";
  if (model === "Nano Banana Lite") return "Banana Lite";
  if (model === "Gemini Omni Flash") return "Omni Flash";
  return model
    .replace("Claude ", "")
    .replace("Gemini ", "")
    .replace("DeepSeek ", "")
    .replace("GPT ", "GPT ");
}

function ProbePolicyTag({
  label,
  title,
  href,
  className = "",
}: {
  label: string;
  title: string;
  href?: string | null;
  className?: string;
}) {
  const classes = `inline-flex w-fit min-w-[64px] shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-dashed border-[#9aa5a7] px-2 py-0.5 text-[10px] font-bold leading-none text-[#5a6061] ${className}`;
  if (href) {
    return (
      <a
        className={classes}
        href={href}
        rel="noreferrer"
        target="_blank"
        title={title}
      >
        {label}
      </a>
    );
  }

  return (
    <span
      className={classes}
      title={title}
    >
      {label}
    </span>
  );
}

function AvailabilityTable({ station }: { station: TransitStation }) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const families = getStationPriceFamilies(station);
  const stationAvailability = getStationPublishedAvailabilitySummary(station);
  const rows: AvailabilityRow[] = [
    {
      label: "站点整体",
      rate: stationAvailability.sevenDayRate,
      sevenDaySamples: stationAvailability.sevenDaySamples,
      firstCheckedAt: stationAvailability.firstCheckedAt,
      lastCheckedAt: stationAvailability.lastCheckedAt,
      recentSamples: stationAvailability.recentSamples,
      latestLatencyMs: stationAvailability.latestLatencyMs ?? null,
      avgLatency7dMs: stationAvailability.avgLatency7dMs ?? null,
      monitorModel: families.length
        ? families.map((family) => TRANSIT_MODEL_FAMILY_LABELS[family]).join(" + ")
        : "代表模型",
      note: stationAvailability.note ?? "—",
      source: getAvailabilitySourceMeta(stationAvailability),
    },
    ...families.map((family) => {
      const summary = getFamilyRateSummary(station, family);
      return {
        label: TRANSIT_MODEL_FAMILY_LABELS[family],
        rate: summary.sevenDayRate,
        sevenDaySamples: summary.sevenDaySamples,
        firstCheckedAt: summary.firstCheckedAt,
        lastCheckedAt: summary.lastCheckedAt,
        recentSamples: summary.recentSamples,
        latestLatencyMs: summary.latestLatencyMs,
        avgLatency7dMs: summary.avgLatency7dMs,
        monitorModel: getFamilyMonitorModelLabel(station, family),
        note: formatAvailability({
          sevenDayRate: summary.sevenDayRate,
          sevenDaySamples: summary.sevenDaySamples,
          recentSamples: summary.recentSamples,
        }),
        source: getFamilyAvailabilitySourceMeta(station, family),
      };
    }),
  ];

  return (
    <section className="overflow-hidden rounded-lg border border-[#dfe4e5] bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dfe4e5] bg-[#f2f4f4] px-4 py-3 sm:px-5">
        <h2 className="text-base font-extrabold text-[#202829]">监测样本</h2>
        <ProbePolicyTag
          label="模型探测样本"
          title="模型可用性：先拉取可用模型列表，再按最新且级别最高的可用模型实际请求。监测区间按已记录样本的起止时间展示；价格和分组倍率按公开价格或后台确认记录沉淀。"
        />
      </div>
      {isDesktop === false ? (
        <div className="divide-y divide-[#dfe4e5]">
          {rows.map((row) => (
            <AvailabilityMobileCard key={row.label} row={row} />
          ))}
        </div>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] table-fixed border-collapse">
          <colgroup>
            <col className="w-[100px]" />
            <col className="w-[170px]" />
            <col className="w-[82px]" />
            <col className="w-[180px]" />
            <col className="w-[150px]" />
            <col className="w-[220px]" />
            <col className="w-[118px]" />
            <col />
          </colgroup>
          <thead>
            <tr className="bg-[#f2f4f4]/50">
              <DataTableHead>范围</DataTableHead>
              <DataTableHead explanation="近 7 日样本成功率，绿色条表示成功样本，灰色表示窗口内未检测。">可用状态</DataTableHead>
              <DataTableHead className="whitespace-nowrap text-right" explanation="PriceAI 在当前滚动窗口内记录的结构化可用性样本数。">样本数</DataTableHead>
              <DataTableHead explanation="同一范围内第一条与最新一条可用性样本的时间；只有一条样本时显示单次检查。">监测区间</DataTableHead>
              <DataTableHead explanation="公开监测或 PriceAI 实测返回的最近请求耗时和 7 日平均请求耗时；不等同于首 Token 时间或 TPS 输出速度，没有字段时显示未记录。">响应延迟</DataTableHead>
              <DataTableHead explanation="该范围实际使用的代表模型，不等同于站点支持的全部模型。">监测模型</DataTableHead>
              <DataTableHead explanation="说明稳定性样本来自 PriceAI 实测、公开监测页、公开模型页、站长接口或商家提交。">来源</DataTableHead>
              <DataTableHead>说明</DataTableHead>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-[#dfe4e5]">
                <td className="px-4 py-3 text-xs font-semibold text-[#202829]">{row.label}</td>
                <td className="px-4 py-3">
                  <AvailabilityStatus
                    rate={row.rate}
                    samples={row.sevenDaySamples}
                    firstCheckedAt={row.firstCheckedAt}
                    lastCheckedAt={row.lastCheckedAt}
                    recentSamples={row.recentSamples}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-sm tabular-nums text-[#2d3435]">{row.sevenDaySamples}</td>
                <td className="px-4 py-3 text-xs text-[#5a6061]">{formatMonitoringWindow(row)}</td>
                <td className="px-4 py-3">
                  <TransitLatencyBadge
                    latestLatencyMs={row.latestLatencyMs}
                    avgLatency7dMs={row.avgLatency7dMs}
                    fallback="未记录"
                  />
                </td>
                <td className="px-4 py-3 text-xs text-[#5a6061]">{row.monitorModel}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <ProbePolicyTag label={row.source.label} title={row.source.title} href={row.source.url} />
                </td>
                <td className="px-4 py-3 text-xs text-[#5a6061]">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
}

function getStationPriceFamilies(station: TransitStation): TransitModelFamily[] {
  return TRANSIT_MODEL_FAMILY_ORDER.filter((family) =>
    station.prices.some((price) => transitModelPriceMatchesFamily(price, family))
  );
}

function getStationFamilySummaries(station: TransitStation) {
  return getStationPriceFamilies(station).map((family) => getFamilyRateSummary(station, family));
}

type AvailabilityRow = {
  label: string;
  rate: number | null;
  sevenDaySamples: number;
  firstCheckedAt?: string | null;
  lastCheckedAt: string | null;
  recentSamples?: TransitModelPrice["availability"]["recentSamples"];
  latestLatencyMs: number | null;
  avgLatency7dMs: number | null;
  monitorModel: string;
  note: string;
  source: ReturnType<typeof getAvailabilitySourceMeta>;
};

function AvailabilityMobileCard({ row }: { row: AvailabilityRow }) {
  return (
    <article className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-extrabold text-[#202829]">{row.label}</h3>
          <p className="mt-1 text-xs text-[#5a6061]">样本 {row.sevenDaySamples}</p>
        </div>
        <AvailabilityStatus
          rate={row.rate}
          samples={row.sevenDaySamples}
          firstCheckedAt={row.firstCheckedAt}
          lastCheckedAt={row.lastCheckedAt}
          recentSamples={row.recentSamples}
        />
      </div>
      <div className="mt-3 grid gap-2">
        <MobileTextBlock label="监测区间" value={formatMonitoringWindow(row)} />
        <MobileTextBlock
          label="响应延迟"
          value={(
            <TransitLatencyBadge
              latestLatencyMs={row.latestLatencyMs}
              avgLatency7dMs={row.avgLatency7dMs}
              fallback="未记录"
            />
          )}
        />
        <MobileTextBlock label="监测模型" value={row.monitorModel} />
        <MobileTextBlock label="来源" value={row.source.label} />
        <MobileTextBlock label="说明" value={row.note} />
      </div>
    </article>
  );
}

function MobileTextBlock({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md bg-[#f7f9f9] px-3 py-2 ring-1 ring-[#adb3b4]/15">
      <div className="text-[10px] font-bold text-[#7a8182]">{label}</div>
      <div className="mt-0.5 break-words text-xs font-semibold leading-5 text-[#2d3435]">{value}</div>
    </div>
  );
}

function AvailabilityStatus({
  rate,
  samples,
  firstCheckedAt,
  lastCheckedAt,
  recentSamples,
}: {
  rate: number | null;
  samples: number;
  firstCheckedAt?: string | null;
  lastCheckedAt: string | null;
  recentSamples?: TransitModelPrice["availability"]["recentSamples"];
}) {
  return (
    <div className="min-w-[126px]">
      <div className="whitespace-nowrap text-sm font-semibold text-[#2d3435]">
        {formatAvailability({ sevenDayRate: rate, sevenDaySamples: samples, recentSamples })}
      </div>
      <TransitAvailabilityStrip
        rate={rate}
        samples={samples}
        firstCheckedAt={firstCheckedAt}
        lastCheckedAt={lastCheckedAt}
        recentSamples={recentSamples}
        className="mt-1"
      />
    </div>
  );
}

function getFamilyMonitorModelLabel(station: TransitStation, family: TransitModelFamily): string {
  const groups = getFamilyPriceGroups(station, family);
  const models = uniqueStrings(groups.map((group) => group.primaryPrice.standardModel));
  return models.length ? models.map((model) => shortModelLabel(model as TransitModelPrice["standardModel"])).join("、") : "暂无监测模型";
}

function formatMonitoringWindow(input: { firstCheckedAt?: string | null; lastCheckedAt: string | null; sevenDaySamples: number }): string {
  if (!input.lastCheckedAt || input.sevenDaySamples <= 0) return "暂无监测区间";
  const start = input.firstCheckedAt || input.lastCheckedAt;
  if (start === input.lastCheckedAt || input.sevenDaySamples === 1) {
    return `单次检查 ${formatDateShortMinute(input.lastCheckedAt)}`;
  }
  return `${formatDateShortMinute(start)} - ${formatDateShortMinute(input.lastCheckedAt)}`;
}

function latestLatencyFromPrices(prices: TransitModelPrice[]): number | null {
  return prices
    .filter((price) => price.availability.latestLatencyMs !== null && price.availability.latestLatencyMs !== undefined)
    .sort((left, right) => {
      const leftTime = new Date(left.availability.lastCheckedAt || left.lastVerifiedAt).getTime();
      const rightTime = new Date(right.availability.lastCheckedAt || right.lastVerifiedAt).getTime();
      return rightTime - leftTime;
    })[0]?.availability.latestLatencyMs ?? null;
}

function weightedAverageLatencyFromPrices(prices: TransitModelPrice[]): number | null {
  let total = 0;
  let samples = 0;
  for (const price of prices) {
    const latency = price.availability.avgLatency7dMs;
    if (latency === null || latency === undefined || !Number.isFinite(latency)) continue;
    const weight = Math.max(1, price.availability.sevenDaySamples || 0);
    total += latency * weight;
    samples += weight;
  }
  return samples > 0 ? total / samples : null;
}

function getCacheHitRateTextClass(cacheUsage: TransitModelPrice["cacheUsage"]): string {
  const badgeClass = getCacheHitRateBadgeClass(cacheUsage);
  return badgeClass.split(" ").find((className) => className.startsWith("text-")) || "text-[#202829]";
}

function formatAvailabilityBasis(
  availability: Pick<TransitStation["availability"], "sevenDaySamples" | "sourceType" | "sourceLabel" | "sourceUrl">
): string {
  const source = getAvailabilitySourceMeta(availability);
  if (availability.sevenDaySamples > 1) return `${source.label} · 样本 ${availability.sevenDaySamples}`;
  if (availability.sevenDaySamples === 1) return `${source.label} · 单次样本`;
  return source.label;
}

function MetricCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-lg border border-[#dfe4e5] bg-white p-4">
      <div className="text-xs font-bold text-[#5a6061]">{label}</div>
      <div className="mt-1.5 text-[20px] font-extrabold leading-tight text-[#202829]">{value}</div>
      <div className="mt-1 text-xs text-[#7a8182]">{helper}</div>
    </div>
  );
}

function InfoGroup({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 text-xs font-bold text-[#5a6061]">{label}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span key={item} className="rounded-full bg-[#f2f4f4] px-2.5 py-1 text-[11px] font-bold text-[#2d3435]">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function TextLine({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="font-bold text-[#5a6061]">{label}：</span>
      <span className="text-[#2d3435]">{value || "未公开"}</span>
    </div>
  );
}

function OptionalTextLine({ label, value }: { label: string; value: string | null }) {
  if (!isPublicRuleValue(value)) return null;
  return <TextLine label={label} value={value} />;
}

function isPublicRuleValue(value: string | null): value is string {
  const text = value?.trim();
  if (!text) return false;
  return !["未公开", "暂无", "无", "unknown", "n/a", "N/A", "-"].includes(text);
}

function formatModelRate(value: number | null) {
  return value === null || !Number.isFinite(value) ? "未公开" : `${value.toFixed(2)}x`;
}

function formatModelGroupMultiplierLabel(primaryPrice: TransitModelPrice, values: number[]): string {
  if (!values.length) return "未公开";
  if (!hasComparableTransitOfficialPrice(primaryPrice.standardModel)) return formatTransitModelMultiplier(primaryPrice);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return formatModelRateRange(min, max);
}

function formatOptionalModelRateRange(values: number[]): string | null {
  if (!values.length) return null;
  return formatModelRateRange(Math.min(...values), Math.max(...values));
}

function formatModelRateRange(min: number | null, max: number | null): string {
  if (min === null || max === null) return "未公开";
  if (min === max) return formatModelRate(min);
  return `${formatModelRate(min)}–${formatModelRate(max)}`;
}

function nullableSortValue(value: number | null): number {
  return value === null || !Number.isFinite(value) ? Number.POSITIVE_INFINITY : value;
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}
