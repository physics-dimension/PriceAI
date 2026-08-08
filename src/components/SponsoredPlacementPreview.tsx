"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Megaphone, X } from "lucide-react";
import { type ComponentProps, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  defaultFooterSponsorCreatives,
  getVisibleSponsorCreatives,
  sponsorCreativeDisclosureLabel,
  type SponsorCreative,
  type SponsorPlacementKind,
  type SponsorSettingsSummary,
} from "@/lib/sponsor-settings-shared";
import { trackAnalyticsEvent } from "@/lib/analytics";
import { isQQGroupPromptUrl, qqGroupPromptEventName } from "@/lib/community";
import { trackOutboundEvent } from "@/lib/outbound-analytics-client";
import { sponsorAssetDisplayUrl } from "@/lib/sponsor-asset-url";

type SponsoredPlacementPreviewProps = {
  kind: SponsorPlacementKind;
  settings?: SponsorSettingsSummary | null;
  className?: string;
  reserveWhenEmpty?: boolean;
  hideOnMobile?: boolean;
};

type PlacementCopy = {
  id: string;
  label: string;
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  slot: string;
  fit: string;
  visualTitle: string;
  visualBody: string;
  visualMeta: string[];
  tone: "green" | "blue" | "amber";
};

const showSponsorPreview = process.env.NEXT_PUBLIC_PRICEAI_SHOW_SPONSOR_PREVIEW === "1";
const dismissStoragePrefix = "priceai.sponsor.preview.dismissed";
const dismissEventName = "priceai:sponsor-dismissed";
const inMemoryDismissedKeys = new Set<string>();
const sponsorRel = "sponsored nofollow noopener noreferrer";

const placementCopy: Record<SponsorPlacementKind, PlacementCopy> = {
  topBanner: {
    id: "top-banner",
    label: "广告",
    eyebrow: "全站顶部通知条",
    title: "AI 周边赞助位开放",
    body: "适合云服务器、开发者工具、监控、域名、支付、算力等服务，不放卡网订阅或中转站排名型推广。",
    cta: "查看投放要求",
    slot: "全站顶部",
    fit: "AI 周边",
    visualTitle: "AI 周边服务",
    visualBody: "云服务 / 监控 / 开发工具",
    visualMeta: ["可关闭", "明确标识", "不影响排序"],
    tone: "green",
  },
  home: {
    id: "home-ecosystem",
    label: "广告",
    eyebrow: "首页生态合作位",
    title: "PriceAI 生态合作展示",
    body: "承接 AI 周边服务、开发者基础设施或工具类品牌的轻曝光；不参与四个模块的客观排序。",
    cta: "查看合作方式",
    slot: "首页模块下方",
    fit: "生态合作",
    visualTitle: "Developer Stack",
    visualBody: "给购买决策前的开发者一个明确入口",
    visualMeta: ["品牌图", "短标题", "落地页"],
    tone: "blue",
  },
  apiTransit: {
    id: "api-transit-channel",
    label: "赞助",
    eyebrow: "中转 API 共用赞助位",
    title: "API Gateway / 中转站共用赞助展示",
    body: "适合展示品牌、优惠码和资料入口；站点页与模型页共用同一套素材与开关。",
    cta: "查看该位置要求",
    slot: "站点页 / 模型页共用",
    fit: "共用赞助展示",
    visualTitle: "API Gateway",
    visualBody: "公开价格、优惠码、监测资料入口",
    visualMeta: ["赞助标识", "优惠码", "资料核验"],
    tone: "green",
  },
  apiTransitModels: {
    id: "api-transit-models",
    label: "赞助",
    eyebrow: "中转 API 共用赞助位",
    title: "API Gateway / 中转站共用赞助展示",
    body: "适合展示品牌、优惠码和资料入口；站点页与模型页共用同一套素材与开关。",
    cta: "查看投放说明",
    slot: "站点页 / 模型页共用",
    fit: "共用赞助展示",
    visualTitle: "Model Router",
    visualBody: "GPT / Claude / Gemini / DeepSeek 分组说明",
    visualMeta: ["分组披露", "公开倍率", "监测页"],
    tone: "amber",
  },
  apiModels: {
    id: "api-models",
    label: "广告",
    eyebrow: "官方 API 合作位",
    title: "模型 API 与开发者工具赞助",
    body: "面向正在比较官方 API、Token Plan、模型路由和开发工具的用户，适合展示 API 周边服务与可核验资料。",
    cta: "查看合作入口",
    slot: "官方 API 页",
    fit: "开发者入口",
    visualTitle: "API Toolkit",
    visualBody: "Token Plan、路由、监控、SDK",
    visualMeta: ["开发者", "可核验", "轻曝光"],
    tone: "blue",
  },
  listFooter: {
    id: "list-footer",
    label: "广告",
    eyebrow: "底部赞助展示区",
    title: "低打扰赞助展示",
    body: "适合网络环境检测、云服务器、监控、支付、域名、开发者工具和中转 API 周边服务；中转 API 只能作为独立广告展示，不影响自然排序。",
    cta: "查看投放要求",
    slot: "页面最底部",
    fit: "独立赞助区",
    visualTitle: "Buyer Toolkit",
    visualBody: "购买前的网络、支付与安全检查",
    visualMeta: ["免责声明下方", "可关闭", "不影响排序"],
    tone: "green",
  },
};

export function SponsoredPlacementPreview({ kind, settings = null, className = "", reserveWhenEmpty = false, hideOnMobile = false }: SponsoredPlacementPreviewProps) {
  const copy = placementCopy[kind];
  const dismissStorageKey = `${dismissStoragePrefix}.${copy.id}.v2`;
  const pathname = usePathname();
  const previewEnabled = useSponsorPreviewEnabled();
  const dismissed = useDismissedState(dismissStorageKey);
  const visibleCreatives = getVisibleSponsorCreatives(settings, kind);
  const previewCreatives = previewEnabled ? getPreviewCreatives(kind) : [];
  const creatives = visibleCreatives.length ? visibleCreatives : previewCreatives;
  const impressionKey = creatives.map((creative) => creative.id).join("|");

  const dismiss = useCallback(() => {
    const value = localDateKey();
    inMemoryDismissedKeys.add(`${dismissStorageKey}:${value}`);
    try {
      window.localStorage.setItem(dismissStorageKey, value);
    } catch {
      // localStorage may be unavailable in private or restricted browser contexts.
    }
    trackAnalyticsEvent("sponsor_dismiss", {
      placement: kind,
      placement_id: copy.id,
      creative_ids: impressionKey,
      path: pathname,
    });
    window.dispatchEvent(new Event(dismissEventName));
  }, [copy.id, dismissStorageKey, impressionKey, kind, pathname]);

  useEffect(() => {
    if (!creatives.length || dismissed) return;
    if (hideOnMobile && window.matchMedia("(max-width: 767px)").matches) return;
    trackAnalyticsEvent("sponsor_impression", {
      placement: kind,
      placement_id: copy.id,
      creative_ids: impressionKey,
      creative_count: creatives.length,
      path: pathname,
    });
  }, [copy.id, creatives.length, dismissed, hideOnMobile, impressionKey, kind, pathname]);

  if (dismissed) return null;

  if (!creatives.length) {
    return reserveWhenEmpty && kind === "topBanner" ? <TopNoticeAdPlaceholder className={className} /> : null;
  }

  if (kind === "topBanner") {
    return <TopNoticeAd copy={copy} creative={creatives[0]} kind={kind} className={className} onDismiss={dismiss} pathname={pathname} />;
  }

  if (kind === "listFooter") {
    return <FooterSponsorSection copy={copy} creatives={creatives} kind={kind} className={className} onDismiss={dismiss} pathname={pathname} />;
  }

  if (kind === "apiTransit" || kind === "apiTransitModels") {
    return <TransitSponsorSection copy={copy} creatives={creatives} kind={kind} className={className} onDismiss={dismiss} pathname={pathname} />;
  }

  return <DisplayAdCard copy={copy} creative={creatives[0]} kind={kind} className={className} onDismiss={dismiss} pathname={pathname} />;
}

function TopNoticeAdPlaceholder({ className }: { className: string }) {
  return (
    <section
      aria-hidden="true"
      className={`border-b border-[#d8e3df] bg-[#edf7f3] ${className}`}
    >
      <div className="mx-auto min-h-9 max-w-[1500px] px-3 sm:min-h-11 sm:px-8" />
    </section>
  );
}

function useSponsorPreviewEnabled() {
  return useSyncExternalStore(subscribeSponsorPreviewEnabled, getSponsorPreviewEnabledSnapshot, getSponsorPreviewEnabledServerSnapshot);
}

function subscribeSponsorPreviewEnabled() {
  return () => {};
}

function getSponsorPreviewEnabledSnapshot() {
  if (showSponsorPreview) return true;

  return isLocalPreviewHostname(window.location.hostname);
}

function getSponsorPreviewEnabledServerSnapshot() {
  return showSponsorPreview;
}

function isLocalPreviewHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function TopNoticeAd({
  copy,
  creative,
  kind,
  className,
  onDismiss,
  pathname,
}: {
  copy: PlacementCopy;
  creative: SponsorCreative;
  kind: SponsorPlacementKind;
  className: string;
  onDismiss: () => void;
  pathname: string;
}) {
  const disclosureLabel = sponsorCreativeDisclosureLabel(creative, kind);

  return (
    <section
      aria-label={`${copy.eyebrow}广告位`}
      className={`border-b border-[#d8e3df] bg-[#edf7f3] text-[#202829] ${className}`}
    >
      <div className="mx-auto flex min-h-9 max-w-[1500px] items-center gap-2 px-3 sm:min-h-11 sm:gap-3 sm:px-8">
        <SponsorLink
          creative={creative}
          placement={kind}
          placementId={copy.id}
          path={pathname}
          className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs leading-5 text-[#2f6247] transition hover:text-[#1d4d34] sm:gap-2 sm:text-sm sm:leading-6"
        >
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-extrabold text-[#2f7a4b] ring-1 ring-[#b9d8c9]">
            <Megaphone className="h-3.5 w-3.5" />
            {disclosureLabel}
          </span>
          <span className="truncate">
            <span className="font-extrabold">{creative.title || copy.title}</span>
            <span className="mx-2 text-[#7d9690]">/</span>
            {creative.description || copy.body}
          </span>
          <ArrowRight className="h-4 w-4 shrink-0" />
        </SponsorLink>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-[#5a6061] ring-1 ring-[#d8e3df] transition hover:bg-[#f8f8f8] hover:text-[#202829] sm:h-8 sm:w-8"
          aria-label="关闭顶部广告"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}

function DisplayAdCard({
  copy,
  creative,
  kind,
  className,
  onDismiss,
  pathname,
}: {
  copy: PlacementCopy;
  creative: SponsorCreative;
  kind: SponsorPlacementKind;
  className: string;
  onDismiss: () => void;
  pathname: string;
}) {
  return (
    <section
      aria-label={`${copy.eyebrow}广告位`}
      className={`relative rounded-lg bg-white p-4 text-[#202829] ring-1 ring-[#dfe4e5] ${className}`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-extrabold text-[#202829]">赞助商</h2>
          <Link href="/commercial#slots" className="shrink-0 text-xs font-bold text-[#2f6fff] hover:text-[#1c52c7]">
            成为赞助商
          </Link>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#f2f4f4] text-[#5a6061] transition hover:bg-[#e4e9ea] hover:text-[#202829]"
          aria-label={`关闭${copy.eyebrow}广告`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <SponsorCard
        card={creative}
        copy={copy}
        kind={kind}
        placementId={copy.id}
        path={pathname}
        compact
      />
    </section>
  );
}

function TransitSponsorSection({
  copy,
  creatives,
  kind,
  className,
  onDismiss,
  pathname,
}: {
  copy: PlacementCopy;
  creatives: SponsorCreative[];
  kind: SponsorPlacementKind;
  className: string;
  onDismiss: () => void;
  pathname: string;
}) {
  return (
    <section
      aria-label={`${copy.eyebrow}广告位`}
      className={`relative rounded-lg bg-white p-4 text-[#202829] ring-1 ring-[#dfe4e5] ${className}`}
    >
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#f2f4f4] text-[#5a6061] transition hover:bg-[#e4e9ea] hover:text-[#202829]"
        aria-label="关闭中转 API 赞助展示区广告"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="pr-8">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-extrabold text-[#202829]">赞助商</h2>
          <Link href="/commercial#slots" className="text-xs font-bold text-[#2f6fff] transition hover:text-[#1c52c7]">
            成为赞助商
          </Link>
        </div>

        <div className="mt-4 flex flex-wrap items-start gap-3">
          {creatives.map((card) => (
            <SponsorCard
              key={card.id}
              card={card}
              copy={copy}
              kind={kind}
              placementId={copy.id}
              path={pathname}
              compact
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function FooterSponsorSection({
  copy,
  creatives,
  kind,
  className,
  onDismiss,
  pathname,
}: {
  copy: PlacementCopy;
  creatives: SponsorCreative[];
  kind: SponsorPlacementKind;
  className: string;
  onDismiss: () => void;
  pathname: string;
}) {
  return (
    <section
      aria-label={`${copy.eyebrow}广告位`}
      className={`relative rounded-lg bg-white p-4 text-left text-[#202829] ring-1 ring-[#dfe4e5] ${className}`}
    >
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#f2f4f4] text-[#5a6061] transition hover:bg-[#e4e9ea] hover:text-[#202829]"
        aria-label="关闭底部赞助展示区广告"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="pr-8">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-extrabold text-[#202829]">赞助商列表</h2>
          <Link href="/commercial#slots" className="text-xs font-bold text-[#2f6fff] transition hover:text-[#1c52c7]">
            成为赞助商
          </Link>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {creatives.map((card) => (
            <SponsorCard
              key={card.id}
              card={card}
              copy={copy}
              kind={kind}
              placementId={copy.id}
              path={pathname}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function SponsorCard({
  card,
  copy,
  kind,
  placementId,
  path,
  compact = false,
}: {
  card: SponsorCreative;
  copy: PlacementCopy;
  kind: SponsorPlacementKind;
  placementId: string;
  path: string;
  compact?: boolean;
}) {
  const disclosureLabel = sponsorCreativeDisclosureLabel(card, kind);
  const imageUrl = sponsorAssetDisplayUrl(card.imageUrl);

  return (
    <SponsorLink
      creative={card}
      placement={kind}
      placementId={placementId}
      path={path}
      className={`group block overflow-hidden rounded-lg bg-white text-[#202829] ring-1 ring-[#dfe4e5] transition hover:-translate-y-0.5 hover:ring-[#adb3b4] ${
        compact ? "w-full max-w-[320px]" : ""
      }`}
      aria-label={`${card.title}赞助商，打开赞助链接`}
    >
      <div className={`relative aspect-[16/5] overflow-hidden ${imageUrl ? "bg-[#f2f4f4]" : footerSponsorVisualClass(card.tone)}`}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            width={640}
            height={200}
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="text-[11px] font-extrabold text-[#5a6061]">赞助图片</p>
            <p className="mt-1 max-w-full truncate text-2xl font-black leading-none text-[#202829]">{card.visualTitle || card.title || copy.visualTitle}</p>
            <p className="mt-2 max-w-full truncate text-xs font-bold text-[#3e484a]">{card.visualMeta || copy.visualBody}</p>
          </div>
        )}
      </div>
      <div className={`p-4 ${compact ? "min-h-[92px]" : "min-h-[104px]"}`}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-sm font-extrabold leading-5 text-[#202829]">{card.title}</h3>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#fff7e8] px-2 py-0.5 text-[11px] font-extrabold text-[#7a541b]">
            <Megaphone className="h-3 w-3" />
            {disclosureLabel}
          </span>
        </div>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#5a6061]">{card.description}</p>
      </div>
    </SponsorLink>
  );
}

type SponsorLinkProps = Omit<ComponentProps<typeof Link>, "href" | "onClick"> & {
  creative: SponsorCreative;
  placement: SponsorPlacementKind;
  placementId: string;
  path: string;
  children: ReactNode;
};

function SponsorLink({ creative, placement, placementId, path, children, ...props }: SponsorLinkProps) {
  const href = useMemo(() => sponsorHref(creative.targetUrl || "/commercial#slots", placement, creative), [creative, placement]);
  const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
  const target = isExternal ? "_blank" : props.target;
  const shouldOpenQQGroupPrompt = isQQGroupPromptUrl(href);

  return (
    <Link
      {...props}
      href={href}
      target={target}
      rel={isExternal ? sponsorRel : props.rel}
      onClick={(event) => {
        trackAnalyticsEvent("sponsor_click", {
          placement,
          placement_id: placementId,
          creative_id: creative.id,
          sponsor_name: creative.sponsorName || creative.title,
          campaign_id: creative.campaignId || campaignSlug(placement, creative),
          target_url: href,
          path,
        });
        trackOutboundEvent({
          eventType: "sponsor_click",
          entityType: "sponsor",
          entityId: creative.campaignId || creative.id,
          placement,
          creativeId: creative.id,
          campaignId: creative.campaignId || campaignSlug(placement, creative),
          targetUrl: typeof href === "string" ? href : String(href),
          metadata: {
            placement_id: placementId,
            sponsor_name: creative.sponsorName || creative.title,
            path,
          },
        });
        if (shouldOpenQQGroupPrompt && shouldHandleInCurrentTab(event, target)) {
          event.preventDefault();
          window.dispatchEvent(new Event(qqGroupPromptEventName));
        }
      }}
    >
      {children}
    </Link>
  );
}

function shouldHandleInCurrentTab(event: MouseEvent<HTMLAnchorElement>, target: ComponentProps<typeof Link>["target"]) {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  return !target || target === "_self";
}

function footerSponsorVisualClass(tone: SponsorCreative["tone"]) {
  if (tone === "blue") return "bg-[#e8f1fa]";
  if (tone === "amber") return "bg-[#fff2dc]";
  return "bg-[#e8f3ec]";
}

function getPreviewCreatives(kind: SponsorPlacementKind): SponsorCreative[] {
  if (!showSponsorPreview && typeof window !== "undefined" && !isLocalPreviewHostname(window.location.hostname)) return [];
  if (kind === "listFooter") return defaultFooterSponsorCreatives;

  const copy = placementCopy[kind];
  return [{
    id: `${copy.id}-preview`,
    enabled: true,
    status: "live",
    title: copy.title,
    description: copy.body,
    targetUrl: "/commercial#slots",
    sponsorName: "PriceAI",
    campaignId: `${copy.id}-preview`,
    visualTitle: copy.visualTitle,
    visualMeta: copy.visualBody,
    label: copy.label,
    tone: copy.tone,
  }];
}

function readDismissed(storageKey: string) {
  const today = localDateKey();
  if (inMemoryDismissedKeys.has(`${storageKey}:${today}`)) return true;
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(storageKey) === today;
  } catch {
    return false;
  }
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sponsorHref(targetUrl: string, placement: SponsorPlacementKind, creative: SponsorCreative): string {
  if (targetUrl.startsWith("/")) {
    return targetUrl;
  }

  if (creative.appendUtm === false) {
    return targetUrl;
  }

  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return targetUrl;
    url.searchParams.set("utm_source", "priceai");
    url.searchParams.set("utm_medium", "sponsor");
    url.searchParams.set("utm_campaign", creative.campaignId || campaignSlug(placement, creative));
    url.searchParams.set("utm_content", `${placement}_${creative.id}`);
    return url.toString();
  } catch {
    return targetUrl;
  }
}

function campaignSlug(placement: SponsorPlacementKind, creative: SponsorCreative): string {
  const source = creative.sponsorName || creative.title || creative.id || placement;
  return `${placement}-${source}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || placement;
}

function useDismissedState(storageKey: string) {
  return useSyncExternalStore(
    subscribeToDismissChanges,
    () => readDismissed(storageKey),
    () => false,
  );
}

function subscribeToDismissChanges(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  window.addEventListener("storage", onStoreChange);
  window.addEventListener(dismissEventName, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(dismissEventName, onStoreChange);
  };
}
