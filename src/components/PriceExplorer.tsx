"use client";

import {
  BookOpenText,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  X,
  Database,
  Flag,
  Filter,
  LayoutGrid,
  Layers3,
  PackageCheck,
  Search,
  Store,
  Table2,
} from "lucide-react";
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { CategoryTabBar, CategoryTabStrip, type CategoryTabItem } from "@/components/CategoryTabBar";
import { CollectorSourceLogo } from "@/components/MerchantCollectorSource";
import { GuidePromptStrip } from "@/components/GuidePromptStrip";
import { MerchantFeedbackDialog, OfferActions, OfferFeedbackButton, OfferFeedbackDialog, OfferLink, OfferMerchantLink } from "@/components/ProductOffersPanel";
import { SiteHeader } from "@/components/SiteHeader";
import { clearFeedbackResumeRequest, getFeedbackResumeRequest } from "@/lib/feedback-draft";
import { listDetailNavigationHref, shouldHandleListDetailClick } from "@/lib/list-return";
import { rewriteLdxpUrlHost } from "@/lib/ldxp-domain-settings-shared";
import { safeExternalShopUrl } from "@/lib/external-url";
import { saveCurrentListScrollPosition, useListScrollRestoration } from "@/lib/list-scroll-restoration";
import {
  compareProductDisplayOrder,
  isAvailable,
  platformOptions,
  productTypeOptions,
} from "@/lib/catalog";
import { trackAnalyticsEvent } from "@/lib/analytics";
import { readSessionCache, writeSessionCache } from "@/lib/client-cache";
import { useMediaQuery } from "@/lib/client-hooks";
import { createTimeoutSignal, isGeneratedDatasetStale, newestGeneratedDataset, newestUsableGeneratedDataset } from "@/lib/client-refresh";
import { withPriceAiUtm } from "@/lib/outbound-analytics-client";
import {
  MERCHANT_COLLECTOR_FILTERS,
  merchantCollectorLabel,
  merchantSourceDisplayName,
  merchantSourcePlatform,
  parseMerchantCollectorFilter,
} from "@/lib/merchant-collectors";
import { PRICE_DATA_CACHE_TTL_MS } from "@/lib/public-cache-policy";
import { PUBLIC_MERCHANT_PAGE_SIZE } from "@/lib/public-merchant-policy";
import { PUBLIC_OFFER_DEFAULT_LIMIT } from "@/lib/public-offer-query";
import { groupSameTitleOffers, type SameTitleOfferGroup } from "@/lib/same-title-offer-groups";
import type {
  CanonicalProduct,
  ExplorerData,
  ExplorerProductSummary,
  MerchantCollectorFilter,
  PublicMerchantSummary,
  RawOffer,
} from "@/lib/types";
import { formatCurrency, formatDateDay, formatRelativeTime } from "@/lib/utils";

type ViewMode = "cards" | "table";
type ScopeMode = "products" | "offers" | "merchants";
type FilterScope = {
  showProductType: boolean;
  showStock: boolean;
  showPrice: boolean;
  showMerchantFilters: boolean;
};

export type ExplorerInitialState = {
  query?: string;
  platform?: string;
  productType?: string;
  stock?: string;
  minPrice?: string;
  maxPrice?: string;
  viewMode?: ViewMode;
  scopeMode?: ScopeMode;
  merchantCollector?: MerchantCollectorFilter;
  merchantSignal?: MerchantSignalFilter;
};

type PlatformOfferRow = {
  offer: RawOffer;
  product: CanonicalProduct;
};

type OfferListResponse = {
  rows: PlatformOfferRow[];
  total: number;
  limited?: boolean;
  generatedAt: string;
  degraded?: boolean;
  message?: string | null;
};

type MerchantListResponse = {
  rows: PublicMerchantSummary[];
  total: number;
  limited?: boolean;
  limit?: number;
  offset?: number;
  generatedAt: string;
  degraded?: boolean;
  message?: string | null;
};

type MerchantSignalFilter = "all" | "lowest" | "warranty" | "platform_aftersales" | "risk_clear";

const productTypeLabels: Record<string, string> = {
  全部: "全部",
  "订阅/会员": "订阅/会员",
  会员充值: "订阅/会员",
  成品账号: "成品账号",
  成品号: "成品账号",
  "邮箱/账号": "邮箱/账号",
  辅助服务: "辅助服务",
  API额度: "API额度",
  "接码/验证": "接码/验证",
  虚拟卡: "虚拟卡",
  工具账号: "工具账号",
  礼品卡: "礼品卡",
  其他: "其他",
};

const OFFER_PAGE_SIZE = PUBLIC_OFFER_DEFAULT_LIMIT;
const PRODUCT_SKELETON_ROWS = [0, 1, 2];
const EXPLORER_CACHE_KEY = "priceai:explorer:v3";
const MERCHANT_LIST_CACHE_KEY = "priceai:merchants:v7:paged";
const EXPLORER_CACHE_TTL_MS = PRICE_DATA_CACHE_TTL_MS;
const OFFER_LIST_CACHE_TTL_MS = PRICE_DATA_CACHE_TTL_MS;
const MERCHANT_LIST_CACHE_TTL_MS = PRICE_DATA_CACHE_TTL_MS;
const OFFER_LIST_MEMORY_CACHE_LIMIT = 40;
const MERCHANT_LIST_MEMORY_CACHE_LIMIT = 40;
const stockOptions = ["all", "available", "out_of_stock"] as const;
const viewOptions = ["cards", "table"] as const;
const scopeOptions = ["products", "offers", "merchants"] as const;
const merchantCollectorOptions = MERCHANT_COLLECTOR_FILTERS;
const merchantSignalOptions = ["all", "lowest", "warranty", "platform_aftersales", "risk_clear"] as const;
const visiblePlatformOptions = platformOptions;

function defaultViewModeForScope(scopeMode: ScopeMode): ViewMode {
  return scopeMode === "merchants" ? "cards" : "table";
}

function normalizeViewModeForScope(scopeMode: ScopeMode, viewMode?: ViewMode): ViewMode {
  if (scopeMode !== "merchants") return "table";
  return viewMode ?? defaultViewModeForScope(scopeMode);
}

const EMPTY_EXPLORER_DATA: ExplorerData = {
  generatedAt: "",
  configured: true,
  degraded: false,
  message: null,
  products: [],
  sources: [],
  offerTotal: 0,
};

let explorerMemoryCache: ExplorerData | null = null;
const offerListMemoryCache = new Map<string, OfferListResponse>();
const merchantListMemoryCache = new Map<string, MerchantListResponse>();

export function PriceExplorer({
  data,
  initialOffers = null,
  initialMerchants = null,
  initialState = {},
  restoreStateFromUrl = false,
}: {
  data?: ExplorerData;
  initialOffers?: OfferListResponse | null;
  initialMerchants?: MerchantListResponse | null;
  initialState?: ExplorerInitialState;
  restoreStateFromUrl?: boolean;
}) {
  useListScrollRestoration();
  const initialExplorerData = newestGeneratedDataset(data, explorerMemoryCache) ?? EMPTY_EXPLORER_DATA;
  const [explorerData, setExplorerData] = useState<ExplorerData>(
    initialExplorerData,
  );
  const [dataLoading, setDataLoading] = useState(initialExplorerData === EMPTY_EXPLORER_DATA);
  const [dataError, setDataError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialState.query ?? "");
  const [effectiveQuery, setEffectiveQuery] = useState(initialState.query ?? "");
  const [platform, setPlatform] = useState(initialState.platform ?? "全部");
  const [productType, setProductType] = useState(initialState.productType ?? "全部");
  const [stock, setStock] = useState(initialState.stock ?? "all");
  const [minPrice, setMinPrice] = useState(initialState.minPrice ?? "");
  const [maxPrice, setMaxPrice] = useState(initialState.maxPrice ?? "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const initialScopeMode = initialState.scopeMode ?? "products";
  const initialViewMode = normalizeViewModeForScope(initialScopeMode, initialState.viewMode);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [scopeMode, setScopeMode] = useState<ScopeMode>(initialScopeMode);
  const [merchantCollector, setMerchantCollector] = useState<MerchantCollectorFilter>(initialState.merchantCollector ?? "all");
  const [merchantSignal, setMerchantSignal] = useState<MerchantSignalFilter>(initialState.merchantSignal ?? "all");
  const [urlStateReady, setUrlStateReady] = useState(!restoreStateFromUrl);
  const [offerResponse, setOfferResponse] = useState<OfferListResponse | null>(null);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersPaging, setOffersPaging] = useState(false);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [merchantResponse, setMerchantResponse] = useState<MerchantListResponse | null>(null);
  const [merchantsLoading, setMerchantsLoading] = useState(false);
  const [merchantsPaging, setMerchantsPaging] = useState(false);
  const [merchantsError, setMerchantsError] = useState<string | null>(null);
  const [feedbackRow, setFeedbackRow] = useState<PlatformOfferRow | null>(null);
  const [feedbackMerchant, setFeedbackMerchant] = useState<PublicMerchantSummary | null>(null);
  const offerLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const merchantLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const activeOfferQueryRef = useRef("");
  const activeMerchantQueryRef = useRef("");
  const isDesktopViewport = useMediaQuery("(min-width: 768px)");
  const platformTabs = useMemo<CategoryTabItem[]>(
    () => ["全部", ...visiblePlatformOptions].map((item) => ({
      id: item,
      label: item,
      icon: platformIcon(item),
    })),
    [],
  );

  useEffect(() => {
    if (!filtersOpen || isDesktopViewport !== false) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltersOpen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [filtersOpen, isDesktopViewport]);

  useEffect(() => {
    if (!restoreStateFromUrl || typeof window === "undefined") return;

    let readyFrameId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      const nextState = parseExplorerInitialState(new URLSearchParams(window.location.search));
      setQuery(nextState.query ?? "");
      setEffectiveQuery(nextState.query ?? "");
      setPlatform(nextState.platform ?? "全部");
      setProductType(nextState.productType ?? "全部");
      setStock(nextState.stock ?? "all");
      setMinPrice(nextState.minPrice ?? "");
      setMaxPrice(nextState.maxPrice ?? "");
      const nextScopeMode = nextState.scopeMode ?? "products";
      setScopeMode(nextScopeMode);
      setViewMode(normalizeViewModeForScope(nextScopeMode, nextState.viewMode));
      setMerchantCollector(nextState.merchantCollector ?? "all");
      setMerchantSignal(nextState.merchantSignal ?? "all");
      readyFrameId = window.requestAnimationFrame(() => setUrlStateReady(true));
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (readyFrameId !== null) window.cancelAnimationFrame(readyFrameId);
    };
  }, [restoreStateFromUrl]);

  const products = useMemo(() => {
    const normalizedQuery = effectiveQuery.trim().toLowerCase();

    const filtered = explorerData.products.filter((product) => {
      const haystack = [
        product.displayName,
        product.platform,
        product.productType,
        product.spec,
        product.summary,
        ...product.aliases,
        product.offerSearchText,
      ]
        .join(" ")
        .toLowerCase();

      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      if (platform !== "全部" && product.platform !== platform) return false;
      if (productType !== "全部" && product.productType !== productType) return false;
      if (stock === "available" && product.inStockCount === 0) return false;
      if (stock === "out_of_stock" && product.outOfStockCount === 0) return false;

      return true;
    });

    return filtered.sort((a, b) => {
      const displayOrderDelta = compareProductDisplayOrder(a, b);
      if (displayOrderDelta !== 0) return displayOrderDelta;

      const stockDelta = Number(b.inStockCount > 0) - Number(a.inStockCount > 0);
      if (stockDelta !== 0) return stockDelta;

      const trustDelta = productSortPenalty(a) - productSortPenalty(b);
      if (trustDelta !== 0) return trustDelta;

      const priceDelta = compareProductPrice(a, b);
      if (priceDelta !== 0) return priceDelta;

      return compareProductFallback(a, b);
    });
  }, [effectiveQuery, explorerData.products, platform, productType, stock]);

  const totalAvailable = explorerData.products.reduce((sum, product) => sum + product.inStockCount, 0);
  const totalOutOfStock = explorerData.products.reduce((sum, product) => sum + product.outOfStockCount, 0);
  const showingOffers = scopeMode === "offers";
  const showingMerchants = scopeMode === "merchants";
  const filterScope = filterScopeForMode(scopeMode);
  const scopedProductType = filterScope.showProductType ? productType : "全部";
  const scopedStock = filterScope.showStock ? stock : "all";
  const scopedMinPrice = filterScope.showPrice ? minPrice : "";
  const scopedMaxPrice = filterScope.showPrice ? maxPrice : "";
  const scopedMerchantCollector = filterScope.showMerchantFilters ? merchantCollector : "all";
  const scopedMerchantSignal = filterScope.showMerchantFilters ? merchantSignal : "all";
  const title = buildTitle(platform, scopedProductType, scopeMode);
  const searchPlaceholder = searchPlaceholderForScope(scopeMode);
  const activeFilterChips = buildActiveFilterChips({
    productType: scopedProductType,
    stock: scopedStock,
    minPrice: scopedMinPrice,
    maxPrice: scopedMaxPrice,
    merchantCollector: scopedMerchantCollector,
    merchantSignal: scopedMerchantSignal,
    showingMerchants,
  });
  const activeFilterCount = activeFilterChips.length;
  const renderMobileProductList = isDesktopViewport !== true;
  const renderDesktopProductTable = isDesktopViewport !== false;
  const explorerQueryString = useMemo(
    () =>
      buildExplorerSearchParams({
        query,
        platform,
        productType: scopedProductType,
        stock: scopedStock,
        minPrice: scopedMinPrice,
        maxPrice: scopedMaxPrice,
        viewMode,
        scopeMode,
        merchantCollector: scopedMerchantCollector,
        merchantSignal: scopedMerchantSignal,
      }).toString(),
    [
      platform,
      query,
      scopeMode,
      scopedMaxPrice,
      scopedMerchantCollector,
      scopedMerchantSignal,
      scopedMinPrice,
      scopedProductType,
      scopedStock,
      viewMode,
    ],
  );
  const offerQueryString = useMemo(
    () =>
      buildPublicListSearchParams({
        query: effectiveQuery,
        platform,
        productType: scopedProductType,
        stock: scopedStock,
        minPrice: scopedMinPrice,
        maxPrice: scopedMaxPrice,
      }).toString(),
    [effectiveQuery, platform, scopedMaxPrice, scopedMinPrice, scopedProductType, scopedStock],
  );
  const merchantQueryString = useMemo(
    () =>
      buildPublicListSearchParams({
        query: effectiveQuery,
        platform,
        productType: scopedProductType,
        stock: scopedStock,
        minPrice: scopedMinPrice,
        maxPrice: scopedMaxPrice,
        collector: scopedMerchantCollector,
        signal: scopedMerchantSignal,
      }).toString(),
    [
      effectiveQuery,
      platform,
      scopedMaxPrice,
      scopedMerchantCollector,
      scopedMerchantSignal,
      scopedMinPrice,
      scopedProductType,
      scopedStock,
    ],
  );
  const visibleOfferResponse = showingOffers && offerQueryString === "" ? offerResponse ?? initialOffers : offerResponse;
  const platformOffers = useMemo(() => visibleOfferResponse?.rows ?? [], [visibleOfferResponse]);
  const visibleMerchantResponse = showingMerchants && merchantQueryString === "" ? merchantResponse ?? initialMerchants : merchantResponse;
  const merchantRows = useMemo(() => visibleMerchantResponse?.rows ?? [], [visibleMerchantResponse]);
  const resultCount = showingMerchants ? visibleMerchantResponse?.total ?? 0 : showingOffers ? visibleOfferResponse?.total ?? 0 : products.length;
  const hasMoreOffers = showingOffers && Boolean(visibleOfferResponse) && platformOffers.length < (visibleOfferResponse?.total ?? 0);
  const hasMoreMerchants = showingMerchants && Boolean(visibleMerchantResponse) && merchantRows.length < (visibleMerchantResponse?.total ?? 0);

  useEffect(() => {
    if (feedbackRow || feedbackMerchant) return;
    const resume = getFeedbackResumeRequest();
    if (!resume) return;
    if (resume.kind === "offer") {
      const matchedRow = platformOffers.find((row) => row.offer.id === resume.id);
      if (!matchedRow) return;
      const frameId = window.requestAnimationFrame(() => {
        setFeedbackRow(matchedRow);
        clearFeedbackResumeRequest();
      });
      return () => window.cancelAnimationFrame(frameId);
    }
    const matchedMerchant = merchantRows.find((merchant) => merchant.id === resume.id);
    if (!matchedMerchant) return;
    const frameId = window.requestAnimationFrame(() => {
      setFeedbackMerchant(matchedMerchant);
      clearFeedbackResumeRequest();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [feedbackMerchant, feedbackRow, merchantRows, platformOffers]);

  useEffect(() => {
    activeOfferQueryRef.current = offerQueryString;
  }, [offerQueryString]);

  useEffect(() => {
    activeMerchantQueryRef.current = merchantQueryString;
  }, [merchantQueryString]);

  useEffect(() => {
    const timer = window.setTimeout(() => setEffectiveQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!data) return;

    const seededData = newestUsableGeneratedDataset(data, explorerMemoryCache) ?? data;
    rememberHealthyExplorerData(seededData);

    if (!isGeneratedDatasetStale(seededData, EXPLORER_CACHE_TTL_MS)) return;

    const timeout = createTimeoutSignal();
    let active = true;

    async function refreshExplorerData() {
      try {
        const nextData = await fetchExplorerData(timeout.signal);
        if (!active) return;
        const latestData = newestUsableGeneratedDataset(nextData, explorerMemoryCache) ?? nextData;
        rememberHealthyExplorerData(latestData);
        setExplorerData(latestData);
        setDataError(null);
      } catch (error) {
        if (active && !timeout.signal.aborted) {
          setDataError(error instanceof Error ? error.message : "商品数据加载失败");
        }
      } finally {
        timeout.clear();
      }
    }

    void refreshExplorerData();

    return () => {
      active = false;
      timeout.cancel();
    };
  }, [data]);

  useEffect(() => {
    if (!initialMerchants) return;

    const cacheKey = merchantListCacheKey("", 0);
    rememberHealthyMerchantList(cacheKey, initialMerchants);
  }, [initialMerchants]);

  useEffect(() => {
    if (!initialOffers) return;

    const cacheKey = offerListCacheKey("", 0);
    rememberHealthyOfferList(cacheKey, initialOffers);
  }, [initialOffers]);

  useEffect(() => {
    if (data) return;

    const controller = new AbortController();

    async function loadExplorerData() {
      const cachedData = newestUsableGeneratedDataset(
        explorerMemoryCache,
        readSessionCache<ExplorerData>(EXPLORER_CACHE_KEY, EXPLORER_CACHE_TTL_MS),
      );

      if (cachedData) {
        rememberHealthyExplorerData(cachedData);
        setExplorerData(cachedData);
        setDataLoading(false);
      } else {
        setDataLoading(true);
      }

      setDataError(null);

      try {
        const nextData = await fetchExplorerData(controller.signal);
        const latestData = newestUsableGeneratedDataset(nextData, explorerMemoryCache) ?? nextData;
        rememberHealthyExplorerData(latestData);
        setExplorerData(latestData);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDataError(error instanceof Error ? error.message : "商品数据加载失败");
      } finally {
        if (!controller.signal.aborted) setDataLoading(false);
      }
    }

    loadExplorerData();

    return () => controller.abort();
  }, [data]);

  function changePlatform(nextPlatform: string) {
    setPlatform(nextPlatform);
    trackAnalyticsEvent("platform_filter_change", { platform: nextPlatform });
  }

  function changeScope(nextScope: ScopeMode) {
    setScopeMode(nextScope);
    setViewMode(defaultViewModeForScope(nextScope));
    trackAnalyticsEvent("scope_change", { scope: nextScope, platform });
  }

  function openSubmission() {
    trackAnalyticsEvent("submit_channel_open", { source: "home" });
    window.dispatchEvent(new Event("open-submission-floater"));
  }

  function closeFilters() {
    setFiltersOpen(false);
  }

  function resetAdvancedFilters() {
    setProductType("全部");
    setStock("all");
    setMinPrice("");
    setMaxPrice("");
    setMerchantCollector("all");
    setMerchantSignal("all");
    trackAnalyticsEvent("advanced_filters_reset");
  }

  useEffect(() => {
    if (!urlStateReady) return;
    const currentPath = window.location.pathname;
    if (currentPath !== "/" && currentPath !== "/channels") return;

    const nextUrl = explorerQueryString ? `${currentPath}?${explorerQueryString}` : currentPath;
    const currentUrl = `${currentPath}${window.location.search}`;

    if (currentUrl !== nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [explorerQueryString, urlStateReady]);

  useEffect(() => {
    if (!urlStateReady) return;
    if (!showingOffers) return;

    const controller = new AbortController();
    const requestQueryString = offerQueryString;
    const cacheKey = offerListCacheKey(offerQueryString, 0);

    async function loadOffers() {
      const cachedOffers =
        newestUsableGeneratedDataset(
          offerListMemoryCache.get(cacheKey),
          readSessionCache<OfferListResponse>(cacheKey, OFFER_LIST_CACHE_TTL_MS),
        );

      if (cachedOffers) {
        rememberHealthyOfferList(cacheKey, cachedOffers);
        setOfferResponse(cachedOffers);
        setOffersLoading(false);
        if (!isGeneratedDatasetStale(cachedOffers, OFFER_LIST_CACHE_TTL_MS)) return;
      } else {
        setOffersLoading(true);
      }

      setOffersPaging(false);
      setOffersError(null);

      try {
        const nextResponse = await fetchOfferPage(requestQueryString, 0, controller.signal);
        if (activeOfferQueryRef.current !== requestQueryString) return;
        const latestResponse = newestUsableGeneratedDataset(nextResponse, offerListMemoryCache.get(cacheKey)) ?? nextResponse;
        rememberHealthyOfferList(cacheKey, latestResponse);
        setOfferResponse(latestResponse);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (activeOfferQueryRef.current !== requestQueryString) return;
        setOffersError(error instanceof Error ? error.message : "报价加载失败");
        if (!cachedOffers) setOfferResponse(null);
      } finally {
        if (!controller.signal.aborted && activeOfferQueryRef.current === requestQueryString) {
          setOffersLoading(false);
        }
      }
    }

    loadOffers();

    return () => controller.abort();
  }, [offerQueryString, showingOffers, urlStateReady]);

  const loadMoreOffers = useCallback(async () => {
    if (!showingOffers || !visibleOfferResponse || offersLoading || offersPaging) return;
    if (platformOffers.length >= visibleOfferResponse.total) return;

    setOffersPaging(true);
    const requestQueryString = offerQueryString;

    try {
      const nextPage = await fetchOfferPage(requestQueryString, platformOffers.length);
      if (activeOfferQueryRef.current !== requestQueryString) return;
      setOfferResponse((current) => {
        if (activeOfferQueryRef.current !== requestQueryString) return current;
        const baseResponse = current ?? visibleOfferResponse;
        if (!baseResponse) return nextPage;

        const seen = new Set(baseResponse.rows.map((row) => row.offer.id));
        const nextRows = nextPage.rows.filter((row) => !seen.has(row.offer.id));

        const mergedResponse = {
          ...nextPage,
          rows: [...baseResponse.rows, ...nextRows],
          total: nextPage.total,
          limited: nextPage.limited,
        };

        const cacheKey = offerListCacheKey(offerQueryString, 0);
        rememberHealthyOfferList(cacheKey, mergedResponse);

        return mergedResponse;
      });
    } catch (error) {
      if (activeOfferQueryRef.current !== requestQueryString) return;
      setOffersError(error instanceof Error ? error.message : "报价加载失败");
    } finally {
      if (activeOfferQueryRef.current === requestQueryString) setOffersPaging(false);
    }
  }, [offerQueryString, offersLoading, offersPaging, platformOffers.length, showingOffers, visibleOfferResponse]);

  useEffect(() => {
    if (!hasMoreOffers) return;

    const node = offerLoadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreOffers();
        }
      },
      { rootMargin: "640px 0px" },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [hasMoreOffers, loadMoreOffers]);

  useEffect(() => {
    if (!urlStateReady) return;
    if (!showingMerchants) return;

    const controller = new AbortController();
    const requestQueryString = merchantQueryString;
    const cacheKey = merchantListCacheKey(merchantQueryString, 0);

    async function loadMerchants() {
      const cachedMerchants =
        newestUsableGeneratedDataset(
          merchantListMemoryCache.get(cacheKey),
          readSessionCache<MerchantListResponse>(cacheKey, MERCHANT_LIST_CACHE_TTL_MS),
        );

      if (cachedMerchants) {
        rememberHealthyMerchantList(cacheKey, cachedMerchants);
        setMerchantResponse(cachedMerchants);
        setMerchantsLoading(false);
        if (!isGeneratedDatasetStale(cachedMerchants, MERCHANT_LIST_CACHE_TTL_MS)) return;
      } else {
        setMerchantsLoading(true);
      }

      setMerchantsPaging(false);
      setMerchantsError(null);

      try {
        const nextResponse = await fetchMerchantPage(requestQueryString, 0, controller.signal);
        if (activeMerchantQueryRef.current !== requestQueryString) return;
        const latestResponse = newestUsableGeneratedDataset(nextResponse, merchantListMemoryCache.get(cacheKey)) ?? nextResponse;
        rememberHealthyMerchantList(cacheKey, latestResponse);
        setMerchantResponse(latestResponse);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (activeMerchantQueryRef.current !== requestQueryString) return;
        setMerchantsError(error instanceof Error ? error.message : "商家数据加载失败");
        if (!cachedMerchants) setMerchantResponse(null);
      } finally {
        if (!controller.signal.aborted && activeMerchantQueryRef.current === requestQueryString) {
          setMerchantsLoading(false);
        }
      }
    }

    void loadMerchants();

    return () => controller.abort();
  }, [merchantQueryString, showingMerchants, urlStateReady]);

  const loadMoreMerchants = useCallback(async () => {
    if (!showingMerchants || !visibleMerchantResponse || merchantsLoading || merchantsPaging) return;
    if (merchantRows.length >= visibleMerchantResponse.total) return;

    setMerchantsPaging(true);
    const requestQueryString = merchantQueryString;

    try {
      const nextPage = await fetchMerchantPage(requestQueryString, merchantRows.length);
      if (activeMerchantQueryRef.current !== requestQueryString) return;
      setMerchantResponse((current) => {
        if (activeMerchantQueryRef.current !== requestQueryString) return current;
        const baseResponse = current ?? visibleMerchantResponse;
        if (!baseResponse) return nextPage;

        const seen = new Set(baseResponse.rows.map((merchant) => merchant.id));
        const nextRows = nextPage.rows.filter((merchant) => !seen.has(merchant.id));

        const mergedResponse = {
          ...nextPage,
          rows: [...baseResponse.rows, ...nextRows],
          total: nextPage.total,
          limited: nextPage.limited,
        };

        const cacheKey = merchantListCacheKey(merchantQueryString, 0);
        rememberHealthyMerchantList(cacheKey, mergedResponse);

        return mergedResponse;
      });
    } catch (error) {
      if (activeMerchantQueryRef.current !== requestQueryString) return;
      setMerchantsError(error instanceof Error ? error.message : "商家数据加载失败");
    } finally {
      if (activeMerchantQueryRef.current === requestQueryString) setMerchantsPaging(false);
    }
  }, [merchantQueryString, merchantRows.length, merchantsLoading, merchantsPaging, showingMerchants, visibleMerchantResponse]);

  useEffect(() => {
    if (!hasMoreMerchants) return;

    const node = merchantLoadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreMerchants();
        }
      },
      { rootMargin: "640px 0px" },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [hasMoreMerchants, loadMoreMerchants]);

  return (
    <div className="min-h-screen bg-[#f9f9f9] text-[#2d3435]">
      <div className="sticky top-0 z-40 bg-[#f9f9f9]/95 shadow-[0_10px_24px_rgba(45,52,53,0.035)] backdrop-blur-xl">
        <SiteHeader activeSection="channels" />

        <CategoryTabBar
          className="hidden md:block"
          items={platformTabs}
          value={platform}
          onChange={changePlatform}
        />
      </div>

      <main className="mx-auto max-w-[1500px] px-5 py-4 sm:px-8 md:py-10 lg:py-12">
        {!dataLoading && !explorerData.configured ? (
          <div className="mb-8 rounded-lg bg-[#fff7e8] px-5 py-4 text-sm text-[#6a4b16] shadow-[0_18px_50px_rgba(45,52,53,0.04)]">
            当前使用内置演示数据。配置 Supabase 后，可在后台维护渠道并保存真实采集结果。
          </div>
        ) : null}

        {!dataLoading && explorerData.degraded ? (
          <DegradedBanner message={explorerData.message} />
        ) : null}

        <div className="mb-4 space-y-3 md:mb-9 md:space-y-5">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
            <div className="min-w-0">
              <h1 className="min-w-0 font-serif text-[1.4rem] font-semibold leading-8 tracking-normal text-[#202829] sm:text-2xl md:text-4xl">
                {title}
              </h1>
              <div className="mt-3 flex items-center justify-between gap-3 md:mt-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.72rem] font-medium text-[#5a6061] md:gap-3">
                  <span>
                    最近更新：{dataLoading ? "正在同步" : <RelativeTime value={explorerData.generatedAt} />}
                  </span>
                  <span className="h-1 w-1 shrink-0 rounded-full bg-[#adb3b4]" />
                  <span>
                    {dataLoading && !showingOffers && !showingMerchants ? "正在加载" : resultCount} {showingMerchants ? "个商家" : showingOffers ? "条报价" : "个商品"}
                  </span>
                  <span className="hidden h-1 w-1 rounded-full bg-[#adb3b4] md:inline-block" />
                  <span className="hidden md:inline">主价格优先取有货最低价，缺货会明显标注</span>
                </div>
                <button
                  type="button"
                  onClick={openSubmission}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-[#e8f3ec] px-3 text-sm font-semibold text-[#2f7a4b] ring-1 ring-[#2f7a4b]/20 transition hover:bg-[#ddefe4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f7a4b]/45 md:hidden"
                  aria-label="申请收录自营店铺"
                >
                  <Store size={15} />
                  <span>申请收录</span>
                </button>
              </div>
              <p className="mt-3 hidden max-w-[78ch] text-sm leading-7 text-[#5a6061] md:block">
                {showingMerchants
                  ? "卡网商家页展示 PriceAI 从公开页面和公开接口观察到的店铺信号。本站不卖货、不担保，销量、库存和售后规则以原平台为准。"
                  : "PriceAI 聚合 AI 订阅卡网渠道报价。本站不卖货、不担保，价格仅供参考，实际交易和售后规则以原平台为准。"}
              </p>
            </div>

            <ExplorerMetrics
              loading={dataLoading}
              products={explorerData.products.length}
              offers={explorerData.offerTotal}
              available={totalAvailable}
              outOfStock={totalOutOfStock}
            />
          </div>

          <GuidePromptStrip
            className="hidden md:block"
            promptId="channels-buying-guides"
            links={[
              { label: "卡网渠道靠谱吗？", href: "/guides/are-ai-subscription-card-shops-reliable" },
              { label: "价格为什么差很多？", href: "/guides/why-ai-subscription-prices-differ" },
              { label: "ChatGPT 获取方式", href: "/guides/chatgpt-subscription-options" },
            ]}
            note="下单前先核验原店铺的交付、售后和投诉入口。"
            ctaHref="/guides"
            ctaLabel="入门指南"
          />

          <div className="space-y-2.5 md:hidden">
            <label className="flex h-11 min-w-0 items-center gap-2 rounded-full bg-white px-4 shadow-[0_16px_45px_rgba(45,52,53,0.05)] ring-1 ring-[#adb3b4]/15 sm:w-[360px]">
              <Search size={16} className="shrink-0 text-[#5a6061]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#9aa2a3]"
              />
            </label>
            <div className="-mx-5 overflow-x-auto px-5">
              <CategoryTabStrip
                className="w-max pb-1"
                items={platformTabs}
                value={platform}
                onChange={changePlatform}
              />
            </div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 overflow-x-auto">
                <div className="inline-flex h-11 min-w-max items-center rounded-full bg-[#e4e9ea] p-1">
                  <ViewToggleButton
                    active={scopeMode === "products"}
                    icon={<PackageCheck size={16} />}
                    label="标准"
                    onClick={() => changeScope("products")}
                  />
                  <ViewToggleButton
                    active={scopeMode === "offers"}
                    icon={<Database size={16} />}
                    label="报价"
                    onClick={() => changeScope("offers")}
                  />
                  <ViewToggleButton
                    active={scopeMode === "merchants"}
                    icon={<Store size={16} />}
                    label="商家"
                    onClick={() => changeScope("merchants")}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFiltersOpen(true)}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-[#e4e9ea] px-4 text-sm font-semibold text-[#2d3435] transition hover:bg-[#dde4e5]"
              >
                <Filter size={16} className="shrink-0" />
                筛选{activeFilterCount ? ` ${activeFilterCount}` : ""}
              </button>
            </div>
            {activeFilterChips.length ? (
              <div className="-mx-5 overflow-x-auto px-5" aria-label="当前筛选条件">
                <div className="flex w-max items-center gap-2 pb-1">
                  {activeFilterChips.map((filter) => (
                    <span
                      key={filter}
                      className="shrink-0 rounded-full bg-[#e4e9ea] px-3 py-1 text-xs font-medium text-[#2d3435]"
                    >
                      {filter}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="hidden flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center md:flex">
            <label className="flex h-11 min-w-0 items-center gap-2 rounded-full bg-white px-4 shadow-[0_16px_45px_rgba(45,52,53,0.05)] ring-1 ring-[#adb3b4]/15 sm:w-[360px]">
              <Search size={16} className="shrink-0 text-[#5a6061]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#9aa2a3]"
              />
            </label>
            <button
              type="button"
              onClick={() => setFiltersOpen((value) => !value)}
              className="inline-flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[#e4e9ea] px-5 text-sm font-semibold text-[#2d3435] transition hover:bg-[#dde4e5]"
            >
              <Filter size={17} />
              筛选{activeFilterChips.length ? ` ${activeFilterChips.length}` : ""}
            </button>
            <div className="inline-flex h-11 shrink-0 items-center rounded-full bg-[#e4e9ea] p-1">
              <ViewToggleButton
                active={scopeMode === "products"}
                icon={<PackageCheck size={16} />}
                label="标准商品"
                onClick={() => changeScope("products")}
              />
              <ViewToggleButton
                active={scopeMode === "offers"}
                icon={<Database size={16} />}
                label="全部报价"
                onClick={() => changeScope("offers")}
              />
              <ViewToggleButton
                active={scopeMode === "merchants"}
                icon={<Store size={16} />}
                label="卡网商家"
                onClick={() => changeScope("merchants")}
              />
            </div>
            {scopeMode === "merchants" ? (
              <div className="h-11 shrink-0 items-center rounded-full bg-[#edf0f1] p-1 md:inline-flex">
                <ViewToggleButton
                  active={viewMode === "cards"}
                  icon={<LayoutGrid size={16} />}
                  label="卡片"
                  onClick={() => setViewMode("cards")}
                />
                <ViewToggleButton
                  active={viewMode === "table"}
                  icon={<Table2 size={16} />}
                  label="表格"
                  onClick={() => setViewMode("table")}
                />
              </div>
            ) : null}
            <button
              type="button"
              onClick={openSubmission}
              aria-label="申请收录自营店铺"
              className="hidden h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[#e8f3ec] px-5 text-sm font-semibold text-[#2f7a4b] ring-1 ring-[#2f7a4b]/20 transition hover:bg-[#ddefe4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f7a4b]/45 md:inline-flex"
            >
              <Store size={16} />
              申请收录
            </button>
          </div>
          {activeFilterChips.length ? (
            <div className="hidden flex-wrap items-center gap-2 md:flex">
              {activeFilterChips.map((filter) => (
                <span
                  key={filter}
                  className="rounded-full bg-[#e4e9ea] px-3 py-1 text-xs font-medium text-[#2d3435]"
                >
                  {filter}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {filtersOpen ? (
          <div className="mb-8 hidden gap-3 rounded-lg bg-[#f2f4f4] p-4 shadow-[0_18px_50px_rgba(45,52,53,0.04)] sm:grid-cols-2 md:grid lg:grid-cols-4">
            <div className="sm:col-span-2 md:hidden">
              <FilterSelect
                label="平台"
                value={platform}
                onChange={changePlatform}
                options={["全部", ...visiblePlatformOptions]}
              />
            </div>
            {filterScope.showProductType ? (
              <div className="sm:col-span-2 lg:col-span-1">
                <FilterSelect
                  label="商品类型"
                  value={productType}
                  onChange={setProductType}
                  options={["全部", ...productTypeOptions].map((item) => [item, productTypeLabels[item] || item] as [string, string])}
                />
              </div>
            ) : null}
            {filterScope.showStock ? (
              <FilterSelect
                label="库存"
                value={stock}
                onChange={setStock}
                options={[
                  ["all", "全部库存"],
                  ["available", "有货"],
                  ["out_of_stock", "缺货"],
                ]}
              />
            ) : null}
            {filterScope.showPrice ? (
              <>
                <PriceInput label="最低价" value={minPrice} onChange={setMinPrice} />
                <PriceInput label="最高价" value={maxPrice} onChange={setMaxPrice} />
              </>
            ) : null}
            {filterScope.showMerchantFilters ? (
              <>
                <FilterSelect
                  label="采集来源"
                  value={merchantCollector}
                  onChange={(value) => setMerchantCollector(value as MerchantCollectorFilter)}
                  options={merchantCollectorOptions.map((item) => [item, merchantCollectorLabel(item)] as [string, string])}
                />
                <FilterSelect
                  label="商家信号"
                  value={merchantSignal}
                  onChange={(value) => setMerchantSignal(value as MerchantSignalFilter)}
                  options={merchantSignalOptions.map((item) => [item, merchantSignalLabel(item)] as [string, string])}
                />
              </>
            ) : null}
            <button
              type="button"
              onClick={resetAdvancedFilters}
              className="h-12 self-end rounded-full bg-white px-4 text-sm font-semibold text-[#2d3435] shadow-[0_12px_35px_rgba(45,52,53,0.04)] ring-1 ring-[#adb3b4]/15 transition hover:bg-[#dde4e5]"
            >
              重置筛选
            </button>
          </div>
        ) : null}

        <MobileFilterSheet
          open={filtersOpen}
          productType={productType}
          stock={stock}
          minPrice={minPrice}
          maxPrice={maxPrice}
          filterScope={filterScope}
          merchantCollector={merchantCollector}
          merchantSignal={merchantSignal}
          onProductTypeChange={setProductType}
          onStockChange={setStock}
          onMinPriceChange={setMinPrice}
          onMaxPriceChange={setMaxPrice}
          onMerchantCollectorChange={setMerchantCollector}
          onMerchantSignalChange={setMerchantSignal}
          onReset={resetAdvancedFilters}
          onClose={closeFilters}
        />

        {dataError ? (
          <div className="mb-6 rounded-lg bg-[#fff7e8] px-4 py-3 text-sm text-[#6a4b16] shadow-[0_16px_45px_rgba(45,52,53,0.04)] ring-1 ring-[#efdfbd]">
            {dataError}。页面已保留基础操作区，请稍后刷新或切换到全部报价视图。
          </div>
        ) : null}

        {showingMerchants ? (
          merchantsLoading && !visibleMerchantResponse ? (
            <EmptyState text="正在加载商家" />
          ) : merchantsError && !merchantRows.length ? (
            <EmptyState text={merchantsError} />
          ) : merchantRows.length ? (
            <>
              {visibleMerchantResponse?.degraded ? (
                <DegradedBanner message={visibleMerchantResponse.message} className="mb-4" />
              ) : null}
              {merchantsError ? (
                <div className="mb-4 rounded-lg bg-[#fff7e8] px-4 py-3 text-sm text-[#6a4b16] shadow-[0_16px_45px_rgba(45,52,53,0.04)] ring-1 ring-[#efdfbd]">
                  {merchantsError}。已保留当前商家数据，可稍后重试或切换筛选条件。
                </div>
              ) : null}
              <MerchantView merchants={merchantRows} viewMode={viewMode} onFeedback={setFeedbackMerchant} />
              {hasMoreMerchants ? (
                <div ref={merchantLoadMoreRef} className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={loadMoreMerchants}
                    disabled={merchantsPaging}
                    className="inline-flex h-10 items-center justify-center rounded-full bg-[#e4e9ea] px-4 text-sm font-semibold text-[#2d3435] transition hover:bg-[#dde4e5] disabled:opacity-60"
                  >
                    {merchantsPaging ? "正在加载更多商家..." : `继续加载商家 (${merchantRows.length}/${visibleMerchantResponse?.total ?? 0})`}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {visibleMerchantResponse?.degraded ? (
                <DegradedBanner message={visibleMerchantResponse.message} className="mb-4" />
              ) : null}
              <EmptyState text="没有符合条件的商家" />
            </>
          )
        ) : showingOffers ? (
          offersLoading && !offerResponse ? (
            <EmptyState text="正在加载报价" />
          ) : offersError && !platformOffers.length ? (
            <EmptyState text={offersError} />
          ) : platformOffers.length ? (
            <>
              {offerResponse?.degraded ? (
                <DegradedBanner message={offerResponse.message} className="mb-4" />
              ) : null}
              {offersError ? (
                <div className="mb-4 rounded-lg bg-[#fff7e8] px-4 py-3 text-sm text-[#6a4b16] shadow-[0_16px_45px_rgba(45,52,53,0.04)] ring-1 ring-[#efdfbd]">
                  {offersError}。已保留当前报价，可稍后重试或切换筛选条件。
                </div>
              ) : null}
              <PlatformOfferTable rows={platformOffers} onFeedback={setFeedbackRow} />
              {hasMoreOffers ? (
                <div ref={offerLoadMoreRef} className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={loadMoreOffers}
                    disabled={offersPaging}
                    className="inline-flex h-10 items-center justify-center rounded-full bg-[#e4e9ea] px-4 text-sm font-semibold text-[#2d3435] transition hover:bg-[#dde4e5] disabled:opacity-60"
                  >
                    {offersPaging ? "正在加载更多报价..." : `继续加载报价 (${platformOffers.length}/${offerResponse?.total ?? 0})`}
                  </button>
                </div>
              ) : null}
              {feedbackRow ? (
                <OfferFeedbackDialog
                  productId={feedbackRow.product.id}
                  productSlug={feedbackRow.product.slug}
                  productName={feedbackRow.product.displayName}
                  offer={feedbackRow.offer}
                  onClose={() => setFeedbackRow(null)}
                />
              ) : null}
            </>
          ) : (
            <>
              {offerResponse?.degraded ? (
                <DegradedBanner message={offerResponse.message} className="mb-4" />
              ) : null}
              <EmptyState text="没有符合条件的报价" />
            </>
          )
        ) : dataLoading ? (
          <ProductTableSkeleton />
        ) : products.length ? (
          <>
            {renderMobileProductList ? (
              <div className="grid grid-cols-1 gap-3 md:hidden">
                {products.map((product) => (
                  <MobileProductCard key={product.id} product={product} returnQuery={explorerQueryString} />
                ))}
              </div>
            ) : null}
            {renderDesktopProductTable ? (
              <div className="hidden md:block">
                <ProductTable products={products} returnQuery={explorerQueryString} />
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState text="没有符合条件的商品" />
        )}

        <Link
          href="/guides"
          className="mt-5 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-[#202829] ring-1 ring-[#adb3b4]/15 transition hover:bg-[#f5f7f7] md:hidden"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <BookOpenText size={17} className="shrink-0 text-[#47657a]" />
            <span className="truncate">购买前先看：渠道与售后判断</span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-[#7a8182]" />
        </Link>
      </main>

      {feedbackMerchant ? (
        <MerchantFeedbackDialog merchant={feedbackMerchant} onClose={() => setFeedbackMerchant(null)} />
      ) : null}

      <footer className="px-5 py-8 text-center text-xs leading-6 text-[#5a6061] sm:px-8">
        <p>价格仅供参考，实际价格、库存和售后规则以原平台为准。本工具不构成购买建议。</p>
      </footer>
    </div>
  );
}

function ProductTable({
  products,
  returnQuery,
}: {
  products: ExplorerProductSummary[];
  returnQuery: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15">
      <div className="overflow-x-auto">
        <table className="min-w-[1160px] w-full border-collapse text-left text-sm">
          <thead className="bg-[#f2f4f4] text-[0.68rem] font-semibold text-[#5a6061]">
            <tr>
              <TableHead>标准商品</TableHead>
              <TableHead>平台</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>最低价</TableHead>
              <TableHead>质保最低价</TableHead>
              <TableHead>库存</TableHead>
              <TableHead>渠道</TableHead>
              <TableHead>最低渠道</TableHead>
              <TableHead>最近更新</TableHead>
              <TableHead>操作</TableHead>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#edf0f1]">
            {products.map((product) => {
              const previewOffer = product.lowestOffer;
              const isAvailable = product.inStockCount > 0;
              const productHref = productDetailHref(product.slug, returnQuery);
              const handleProductClick = listDetailClickHandler(productHref, returnQuery, () => trackProductDetailOpen(product));

              return (
                <tr key={product.id} className="transition hover:bg-[#f7f9f9]">
                  <td className="max-w-[310px] px-5 py-4">
                    <Link
                      href={productHref}
                      prefetch={false}
                      onClick={handleProductClick}
                      className="group flex min-w-0 items-center gap-3"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f2f4f4] text-[#5e5e5e]">
                        {productIcon(product)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-[#202829] group-hover:text-[#5e5e5e]">
                          {product.displayName}
                        </span>
                        <span className="mt-1 block truncate text-xs text-[#5a6061]">{product.spec}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-5 py-4 text-[#2d3435]">{product.platform}</td>
                  <td className="px-5 py-4 text-[#5a6061]">
                    {productTypeLabels[product.productType] || product.productType}
                  </td>
                  <td className="px-5 py-4">
                    <Link
                      href={productHref}
                      prefetch={false}
                      onClick={handleProductClick}
                      aria-label={`查看 ${product.displayName} 最低价报价`}
                      title="查看最低价报价"
                      className="group inline-flex flex-col gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5a6061]/30 focus-visible:ring-offset-2"
                    >
                      <span className="text-lg font-bold text-[#202829] group-hover:text-[#5e5e5e]">
                        {formatCurrency(product.lowestPrice, previewOffer?.currency)}
                      </span>
                      <span className={`w-fit rounded-full px-2 py-0.5 text-[0.65rem] font-semibold transition group-hover:brightness-95 ${tableStatusClass(isAvailable)}`}>
                        {isAvailable ? "有货" : "缺货"}
                      </span>
                    </Link>
                  </td>
                  <td className="px-5 py-4">
                    <WarrantyLowestPrice
                      product={product}
                      returnQuery={returnQuery}
                      mode="table"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <CountBadge tone="good">有货 {product.inStockCount}</CountBadge>
                      <CountBadge tone="danger">缺货 {product.outOfStockCount}</CountBadge>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-[#2d3435]">{product.offerCount}</td>
                  <td className="max-w-[190px] px-5 py-4">
                    <span className="block truncate font-medium text-[#202829]">
                      {previewOffer ? sourceLabel(previewOffer) : "未记录"}
                    </span>
                    <span className="mt-1 block truncate text-xs text-[#5a6061]">
                      {previewOffer?.sourceTitle || "暂无原始商品名"}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-[#5a6061]">
                    <RelativeTime value={product.latestSeenAt} />
                  </td>
                  <td className="px-5 py-4">
                    <Link
                      href={productHref}
                      prefetch={false}
                      onClick={handleProductClick}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-[#f8f8f8] transition hover:bg-[#1f2526]"
                    >
                      查看
                      <ChevronRight size={14} />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlatformOfferTable({
  rows,
  onFeedback,
}: {
  rows: PlatformOfferRow[];
  onFeedback: (row: PlatformOfferRow) => void;
}) {
  const groups = useMemo(
    () => groupSameTitleOffers(rows, (row) => row.offer, (row) => row.product.id),
    [rows],
  );

  return (
    <>
      <div className="hidden overflow-hidden rounded-lg bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15 md:block">
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full border-collapse text-left text-sm">
            <colgroup>
              <col className="w-[110px]" />
              <col className="w-[190px]" />
              <col className="w-[220px]" />
              <col />
              <col className="w-[130px]" />
              <col className="w-[150px]" />
              <col className="w-[140px]" />
              <col className="w-[80px]" />
            </colgroup>
            <thead className="bg-[#f2f4f4] text-[0.68rem] font-semibold text-[#5a6061]">
              <tr>
                <TableHead>状态</TableHead>
                <TableHead>平台</TableHead>
                <TableHead>渠道</TableHead>
                <TableHead>原始商品名</TableHead>
                <TableHead>价格</TableHead>
                <TableHead>最近确认</TableHead>
                <TableHead className="text-center">操作</TableHead>
                <TableHead className="text-center">详情</TableHead>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#edf0f1]">
              {groups.map((group) => group.offerCount > 1 ? (
                <PlatformOfferTableGroup key={group.key} group={group} onFeedback={onFeedback} />
              ) : (
                <PlatformOfferTableRow key={group.key} row={group.representative} onFeedback={onFeedback} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="grid gap-3 md:hidden">
        {groups.map((group) => group.offerCount > 1 ? (
          <PlatformOfferGroupCard key={group.key} group={group} onFeedback={onFeedback} />
        ) : (
          <PlatformOfferCard
            key={group.key}
            offer={group.representative.offer}
            product={group.representative.product}
            onFeedback={(selectedOffer) => onFeedback({ offer: selectedOffer, product: group.representative.product })}
          />
        ))}
      </div>
    </>
  );
}

function PlatformOfferTableGroup({
  group,
  onFeedback,
}: {
  group: SameTitleOfferGroup<PlatformOfferRow>;
  onFeedback: (row: PlatformOfferRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { offer, product } = group.representative;
  const available = isAvailable(offer);
  const detailsId = `platform-offer-group-${offer.id}`;

  return (
    <>
      <tr className={`transition hover:bg-[#f7f9f9] ${available ? "" : "bg-[#fbf7f6]"}`}>
        <td className="px-5 py-4">
          <span className="flex flex-col items-start gap-1">
            <OfferStatusBadge available={available} />
            <span className="whitespace-nowrap text-[0.68rem] font-semibold text-[#5a6061]">{group.availableMerchantCount} 家有货</span>
          </span>
        </td>
        <td className="max-w-[190px] px-5 py-4"><PlatformProductSummary product={product} /></td>
        <td className="max-w-[220px] px-5 py-4">
          <OfferMerchantLink offer={offer} mode="table" />
          <span className="mt-1 block truncate text-xs text-[#5a6061]">最低价渠道 · 共 {group.merchantCount} 家</span>
        </td>
        <td className="max-w-[460px] px-5 py-4">
          <span className="block truncate text-[#2d3435]" title={group.title}>{group.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-[0.68rem] font-semibold text-[#7a8587]">
            <span>同名报价 {group.offerCount} 条</span>
            {group.riskMerchantCount > 0 ? <span className="text-[#8a5a10]">{group.riskMerchantCount} 家风险</span> : null}
          </span>
        </td>
        <td className="px-5 py-4">
          <span className={`text-lg font-bold tabular-nums ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>
            {formatCurrency(offer.price, offer.currency)} <span className="text-xs font-semibold text-[#5a6061]">起</span>
          </span>
        </td>
        <td className="px-5 py-4 text-[#5a6061]"><RelativeTime value={group.latestAt} /></td>
        <td className="px-3 py-3 text-center"><OfferLink offer={offer} available={available} compact /></td>
        <td className="px-3 py-3 text-center">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="inline-flex h-9 min-w-[76px] items-center justify-center gap-1 rounded-full bg-[#e4e9ea] px-3 text-xs font-semibold text-[#2d3435] transition hover:bg-[#dde4e5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#47657a]"
          >
            {expanded ? "收起" : `${group.offerCount} 条`}
            <ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        </td>
      </tr>
      {expanded ? group.items.map((row, index) => (
        <PlatformOfferTableRow
          key={row.offer.id}
          row={row}
          onFeedback={onFeedback}
          grouped
          rowId={index === 0 ? detailsId : undefined}
        />
      )) : null}
    </>
  );
}

function PlatformOfferTableRow({
  row: { offer, product },
  onFeedback,
  grouped = false,
  rowId,
}: {
  row: PlatformOfferRow;
  onFeedback: (row: PlatformOfferRow) => void;
  grouped?: boolean;
  rowId?: string;
}) {
  const available = isAvailable(offer);

  return (
    <tr id={rowId} className={`transition hover:bg-[#f7f9f9] ${grouped ? "bg-[#fbfcfc]" : available ? "" : "bg-[#fbf7f6]"}`}>
      <td className="px-5 py-4"><OfferStatusBadge available={available} /></td>
      <td className="max-w-[190px] px-5 py-4"><PlatformProductSummary product={product} /></td>
      <td className="max-w-[220px] px-5 py-4">
        <OfferMerchantLink offer={offer} mode="table" />
        {sourceSecondaryLabel(offer) ? <span className="mt-1 block truncate text-xs text-[#5a6061]">{sourceSecondaryLabel(offer)}</span> : null}
      </td>
      <td className="max-w-[460px] px-5 py-4"><span className="block truncate text-[#2d3435]" title={offer.sourceTitle}>{offer.sourceTitle}</span></td>
      <td className="px-5 py-4"><span className={`text-lg font-bold tabular-nums ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>{formatCurrency(offer.price, offer.currency)}</span></td>
      <td className="px-5 py-4 text-[#5a6061]"><RelativeTime value={offerTimestamp(offer)} /></td>
      <td className="px-3 py-3 text-center"><OfferLink offer={offer} available={available} compact /></td>
      <td className="px-3 py-3 text-center">
        <OfferFeedbackButton offer={offer} onFeedback={(selectedOffer) => onFeedback({ offer: selectedOffer, product })} compact />
      </td>
    </tr>
  );
}

function PlatformProductSummary({ product }: { product: CanonicalProduct }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f2f4f4] text-[#5a6061]">{productIcon(product)}</span>
      <span className="min-w-0">
        <span className="block truncate font-semibold text-[#202829]">{product.platform}</span>
        <span className="mt-1 block truncate text-xs text-[#5a6061]">{product.displayName}</span>
      </span>
    </span>
  );
}

function PlatformOfferCard({
  offer,
  product,
  onFeedback,
}: {
  offer: RawOffer;
  product: CanonicalProduct;
  onFeedback: (offer: RawOffer) => void;
}) {
  const available = isAvailable(offer);

  return (
    <article className={`rounded-lg p-4 shadow-[0_16px_45px_rgba(45,52,53,0.04)] ring-1 ${available ? "bg-white ring-[#adb3b4]/15" : "bg-[#fbf7f6] ring-[#ead8d5]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#5a6061]">
            {productIcon(product)}
            <span className="truncate">{product.platform} · {product.displayName}</span>
          </div>
          <OfferMerchantLink offer={offer} mode="card" />
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-[#5a6061]">{offer.sourceTitle}</p>
        </div>
        <OfferStatusBadge available={available} />
      </div>
      <div className="mt-4 flex items-end justify-between gap-4">
        <div>
          <p className={`text-2xl font-bold tracking-normal ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>
            {formatCurrency(offer.price, offer.currency)}
          </p>
          <p className="mt-1 text-xs text-[#5a6061]">
            <RelativeTime value={offerTimestamp(offer)} />
          </p>
        </div>
        <OfferActions offer={offer} available={available} onFeedback={onFeedback} />
      </div>
    </article>
  );
}

function PlatformOfferGroupCard({
  group,
  onFeedback,
}: {
  group: SameTitleOfferGroup<PlatformOfferRow>;
  onFeedback: (row: PlatformOfferRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { offer, product } = group.representative;
  const available = isAvailable(offer);
  const detailsId = `mobile-platform-offer-group-${offer.id}`;

  return (
    <section className="min-w-0">
      <article className={`rounded-lg p-4 shadow-[0_8px_8px_rgba(45,52,53,0.035)] ring-1 ${available ? "bg-white ring-[#adb3b4]/15" : "bg-[#fbf7f6] ring-[#ead8d5]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#5a6061]">
              {productIcon(product)}
              <span className="truncate">{product.platform} · {product.displayName}</span>
            </div>
            <p className="line-clamp-2 text-sm font-semibold leading-6 text-[#202829]">{group.title}</p>
            <div className="mt-2 min-w-0">
              <OfferMerchantLink offer={offer} mode="card" />
              <p className="mt-0.5 truncate text-xs text-[#5a6061]">最低价渠道 · 共 {group.merchantCount} 家</p>
            </div>
          </div>
          <OfferStatusBadge available={available} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-[#5a6061]">
          <span>{group.availableMerchantCount} 家有货</span>
          <span aria-hidden="true">·</span>
          <span>{group.offerCount} 条报价</span>
          {group.riskMerchantCount > 0 ? (
            <><span aria-hidden="true">·</span><span className="text-[#8a5a10]">{group.riskMerchantCount} 家风险</span></>
          ) : null}
        </div>
        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-2xl font-bold tracking-normal tabular-nums ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>
              {formatCurrency(offer.price, offer.currency)} <span className="text-xs font-semibold text-[#5a6061]">起</span>
            </p>
            <p className="mt-1 text-xs text-[#5a6061]"><RelativeTime value={group.latestAt} /></p>
          </div>
          <OfferLink offer={offer} available={available} compact />
        </div>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-[#e4e9ea] px-3 text-xs font-semibold text-[#2d3435] transition hover:bg-[#dde4e5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#47657a]"
        >
          {expanded ? "收起全部报价" : `查看全部 ${group.offerCount} 条报价`}
          <ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      </article>
      {expanded ? (
        <div id={detailsId} className="ml-3 mt-2 grid gap-2 border-l border-[#dfe4e5] pl-3">
          {group.items.map(({ offer: itemOffer, product: itemProduct }) => (
            <PlatformOfferCard
              key={itemOffer.id}
              offer={itemOffer}
              product={itemProduct}
              onFeedback={(selectedOffer) => onFeedback({ offer: selectedOffer, product: itemProduct })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function MerchantView({
  merchants,
  viewMode,
  onFeedback,
}: {
  merchants: PublicMerchantSummary[];
  viewMode: ViewMode;
  onFeedback: (merchant: PublicMerchantSummary) => void;
}) {
  if (viewMode === "table") {
    return (
      <>
        <MerchantTable merchants={merchants} onFeedback={onFeedback} />
        <div className="grid gap-3 md:hidden">
          {merchants.map((merchant) => (
            <MerchantCard key={merchant.id} merchant={merchant} onFeedback={onFeedback} />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {merchants.map((merchant) => (
        <MerchantCard key={merchant.id} merchant={merchant} onFeedback={onFeedback} />
      ))}
    </div>
  );
}

function MerchantTable({
  merchants,
  onFeedback,
}: {
  merchants: PublicMerchantSummary[];
  onFeedback: (merchant: PublicMerchantSummary) => void;
}) {
  return (
    <div className="hidden overflow-hidden rounded-lg bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15 md:block">
      <div className="overflow-x-auto">
        <table className="min-w-[1370px] w-full border-collapse text-left text-sm">
          <colgroup>
            <col className="w-[260px]" />
            <col className="w-[150px]" />
            <col className="w-[210px]" />
            <col className="w-[160px]" />
            <col className="w-[135px]" />
            <col className="w-[135px]" />
            <col className="w-[130px]" />
            <col className="w-[160px]" />
            <col className="w-[170px]" />
            <col className="w-[120px]" />
          </colgroup>
          <thead className="bg-[#f2f4f4] text-[0.68rem] font-semibold text-[#5a6061]">
            <tr>
              <TableHead>商家/店铺</TableHead>
              <TableHead>采集来源</TableHead>
              <TableHead>覆盖</TableHead>
              <TableHead>库存</TableHead>
              <TableHead>最低价命中</TableHead>
              <TableHead>质保命中</TableHead>
              <TableHead>观察标签</TableHead>
              <TableHead>时间</TableHead>
              <TableHead>最近更新</TableHead>
              <TableHead className="text-center">操作</TableHead>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#edf0f1]">
            {merchants.map((merchant) => (
              <MerchantTableRow key={merchant.id} merchant={merchant} onFeedback={onFeedback} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MerchantTableRow({
  merchant,
  onFeedback,
}: {
  merchant: PublicMerchantSummary;
  onFeedback: (merchant: PublicMerchantSummary) => void;
}) {
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: merchant.collectorKind,
    collectorGroup: merchant.collectorGroup,
    sourceId: merchant.sourceId,
    sourceName: merchant.sourceName,
    url: merchant.entryUrl,
    entryUrl: merchant.shopUrl || merchant.entryUrl,
    host: merchant.host,
  });

  return (
    <tr className="transition hover:bg-[#f7f9f9]">
      <td className="max-w-[260px] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <CollectorSourceLogo group={merchant.collectorGroup} platformId={sourcePlatform.id} size="table" />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-[#202829]">{merchant.name}</span>
            <span className="mt-1 block truncate text-xs text-[#5a6061]">{merchant.host || merchant.sourceName}</span>
          </span>
        </div>
      </td>
      <td className="px-5 py-4 align-middle">
        <CollectorBadge merchant={merchant} />
      </td>
      <td className="max-w-[210px] px-5 py-4">
        <p className="font-semibold text-[#202829]">{merchant.productCount} 个商品</p>
        <p className="mt-1 truncate text-xs text-[#5a6061]">{merchant.platforms.slice(0, 3).join(" / ") || "未记录平台"}</p>
      </td>
      <td className="px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          <CountBadge tone="good">有货 {merchant.inStockCount}</CountBadge>
          <CountBadge tone="danger">缺货 {merchant.outOfStockCount}</CountBadge>
        </div>
      </td>
      <td className="px-5 py-4">
        <MetricStack value={merchant.lowestHitCount} label="标准最低" />
      </td>
      <td className="px-5 py-4">
        <MetricStack value={merchant.warrantyLowestHitCount} label="质保最低" />
      </td>
      <td className="px-5 py-4">
        <MerchantSignalBadges merchant={merchant} />
      </td>
      <td className="px-5 py-4">
        <MerchantTimeSummary merchant={merchant} compact />
      </td>
      <td className="px-5 py-4 text-[#5a6061]">
        <RelativeTime value={merchant.latestSeenAt} />
      </td>
      <td className="px-5 py-4 text-center align-middle">
        <MerchantActions merchant={merchant} onFeedback={onFeedback} />
      </td>
    </tr>
  );
}

function MerchantCard({
  merchant,
  onFeedback,
}: {
  merchant: PublicMerchantSummary;
  onFeedback: (merchant: PublicMerchantSummary) => void;
}) {
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: merchant.collectorKind,
    collectorGroup: merchant.collectorGroup,
    sourceId: merchant.sourceId,
    sourceName: merchant.sourceName,
    url: merchant.entryUrl,
    entryUrl: merchant.shopUrl || merchant.entryUrl,
    host: merchant.host,
  });

  return (
    <article
      data-merchant-card="true"
      className="flex min-h-[260px] flex-col rounded-lg bg-white p-5 shadow-[0_16px_45px_rgba(45,52,53,0.04)] ring-1 ring-[#adb3b4]/15"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <CollectorSourceLogo group={merchant.collectorGroup} platformId={sourcePlatform.id} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-[#202829]">{merchant.name}</p>
            <p className="mt-1 truncate text-xs text-[#5a6061]">{merchant.host || merchant.sourceName}</p>
          </div>
        </div>
        <CollectorBadge merchant={merchant} />
      </div>

      <p className="mt-4 line-clamp-2 min-h-[48px] text-sm leading-6 text-[#5a6061]">
        {merchantDescription(merchant)}
      </p>

      <MerchantSignalBadges merchant={merchant} className="mt-3" />

      <MerchantTimeSummary merchant={merchant} />

      <div className="mt-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <MobileMerchantMetric label="商品" value={merchant.productCount} />
        <MobileMerchantMetric label="有货" value={merchant.inStockCount} />
        <MobileMerchantMetric label="低价" value={merchant.lowestHitCount} />
        <MobileMerchantMetric label="质保" value={merchant.warrantyLowestHitCount} />
      </div>

      <MerchantCoverageText merchant={merchant} />

      <div className="mt-auto flex items-end justify-between gap-3 pt-5">
        <p className="min-w-0 text-xs leading-5 text-[#5a6061]">
          <span className="block truncate">{merchant.representativeProduct || "未记录代表商品"}</span>
          <span className="block">更新 <RelativeTime value={merchant.latestSeenAt} /></span>
        </p>
        <MerchantActions merchant={merchant} onFeedback={onFeedback} />
      </div>
    </article>
  );
}

function CollectorBadge({ merchant }: { merchant: PublicMerchantSummary }) {
  const tone = merchant.collectorGroup === "shopApi" ? "info" : merchant.collectorGroup === "other" ? "muted" : "warn";
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: merchant.collectorKind,
    collectorGroup: merchant.collectorGroup,
    sourceId: merchant.sourceId,
    sourceName: merchant.sourceName,
    url: merchant.entryUrl,
    entryUrl: merchant.shopUrl || merchant.entryUrl,
    host: merchant.host,
  });
  return (
    <span className="inline-flex min-w-[5rem] justify-center whitespace-nowrap">
      <CountBadge tone={tone}>{sourcePlatform.label}</CountBadge>
    </span>
  );
}

function merchantDescription(merchant: PublicMerchantSummary): string {
  const platforms = merchant.platforms.slice(0, 3).join(" / ") || "未记录平台";
  const stockText = merchant.inStockCount > 0
    ? `当前观察到 ${merchant.inStockCount} 个有货报价`
    : "当前未观察到有货报价";
  const priceText = merchant.lowestHitCount || merchant.warrantyLowestHitCount
    ? `，有 ${merchant.lowestHitCount} 次标准最低、${merchant.warrantyLowestHitCount} 次质保最低命中`
    : "";

  return `覆盖 ${platforms} 等 ${merchant.productCount} 个标准商品，${stockText}${priceText}。`;
}

function MerchantSignalBadges({ merchant, className = "" }: { merchant: PublicMerchantSummary; className?: string }) {
  const observedDays = daysSince(merchant.observationStartedAt);
  const badges: ReactNode[] = [];

  if (merchant.hasPlatformAftersalesMechanism) {
    badges.push(<CountBadge key="platform-aftersales" tone="info">平台售后</CountBadge>);
  }

  if (merchant.riskFeedbackCount > 0) {
    badges.push(<CountBadge key="risk-feedback" tone="warn">待核验反馈 {merchant.riskFeedbackCount}</CountBadge>);
  }

  if (observedDays !== null && observedDays >= 30) {
    badges.push(<CountBadge key="observed-days" tone="muted">观察30天+</CountBadge>);
  }

  if (!badges.length) return null;

  return (
    <div className={`flex flex-wrap gap-1.5 text-xs ${className}`}>
      {badges}
    </div>
  );
}

function MerchantTimeSummary({ merchant, compact = false }: { merchant: PublicMerchantSummary; compact?: boolean }) {
  const includedAt = merchant.includedAt || merchant.observationStartedAt;
  const shopCreatedAt = merchant.shopCreatedAt || null;
  const className = compact
    ? "space-y-1 text-xs leading-5 text-[#5a6061]"
    : "mt-4 grid grid-cols-2 gap-2 text-xs";

  if (compact) {
    return (
      <div className={className}>
        <p>
          <span className="font-semibold text-[#202829]">收录</span>{" "}
          <MerchantElapsedDays value={includedAt} />
        </p>
        <p>
          <span className="font-semibold text-[#202829]">公开运营</span>{" "}
          {shopCreatedAt ? formatMerchantAge(shopCreatedAt) : "未公开"}
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <MerchantTimeTile label="PriceAI 收录" value={<MerchantElapsedDays value={includedAt} />} />
      <MerchantTimeTile
        label="公开运营"
        value={shopCreatedAt ? formatMerchantAge(shopCreatedAt) : "未公开"}
        detail={shopCreatedAt ? formatDateDay(shopCreatedAt) : undefined}
      />
    </div>
  );
}

function MerchantTimeTile({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="rounded-lg bg-[#f7f9f9] px-3 py-2 ring-1 ring-[#adb3b4]/10">
      <p className="font-semibold text-[#5a6061]">{label}</p>
      <p className="mt-1 font-bold text-[#202829]">{value}</p>
      {detail ? <p className="mt-0.5 text-[0.68rem] text-[#5a6061]">{detail}</p> : null}
    </div>
  );
}

function MerchantCoverageText({ merchant }: { merchant: PublicMerchantSummary }) {
  const platforms = merchant.platforms.slice(0, 4);
  if (!platforms.length) return null;

  const suffix = merchant.platformCount > platforms.length ? ` 等 ${merchant.platformCount} 类` : "";
  return (
    <p className="mt-4 min-w-0 truncate text-xs leading-5 text-[#5a6061]">
      <span className="font-semibold text-[#2d3435]">覆盖：</span>
      {platforms.join(" / ")}{suffix}
    </p>
  );
}

function MerchantActions({
  merchant,
  onFeedback,
}: {
  merchant: PublicMerchantSummary;
  onFeedback: (merchant: PublicMerchantSummary) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2">
      <MerchantSourceLink merchant={merchant} />
      <MerchantFeedbackButton merchant={merchant} onFeedback={onFeedback} />
    </div>
  );
}

function MerchantFeedbackButton({
  merchant,
  onFeedback,
}: {
  merchant: PublicMerchantSummary;
  onFeedback: (merchant: PublicMerchantSummary) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onFeedback(merchant)}
      title="反馈商家问题"
      aria-label={`反馈商家问题：${merchant.name}`}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#adb3b4]/30 bg-white text-[#5a6061] transition hover:border-[#5a6061]/35 hover:bg-[#f2f4f4]"
    >
      <Flag size={14} />
    </button>
  );
}

function MerchantElapsedDays({ value }: { value: string | null | undefined }) {
  return <span suppressHydrationWarning>{formatElapsedDays(value)}</span>;
}

function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function formatElapsedDays(value: string | null | undefined): string {
  const days = daysSince(value);
  if (days === null) return "未记录";
  if (days < 1) return "今天";
  return `${days}天前`;
}

function formatMerchantAge(value: string | null | undefined): string {
  const days = daysSince(value);
  if (days === null) return "未公开";
  if (days < 1) return "今天";
  if (days < 30) return `${days}天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return remainingMonths ? `${years}年${remainingMonths}个月` : `${years}年`;
}

function MetricStack({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="text-lg font-bold tabular-nums text-[#202829]">{value}</p>
      <p className="mt-0.5 text-xs text-[#5a6061]">{label}</p>
    </div>
  );
}

function MobileMerchantMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[#f2f4f4] px-3 py-2">
      <p className="text-[0.68rem] font-semibold text-[#5a6061]">{label}</p>
      <p className="mt-1 text-base font-bold tabular-nums text-[#202829]">{value}</p>
    </div>
  );
}

function MerchantSourceLink({ merchant }: { merchant: PublicMerchantSummary }) {
  const href = rewriteLdxpUrlHost(merchant.shopUrl || merchant.entryUrl) || merchant.shopUrl || merchant.entryUrl;
  const usableHref = safeExternalShopUrl(href);

  if (!usableHref) {
    return (
      <span className="inline-flex h-9 min-w-[72px] items-center justify-center whitespace-nowrap rounded-full bg-[#e4e9ea] px-3 text-xs font-semibold text-[#5a6061]">
        待补入口
      </span>
    );
  }

  const outboundUrl = withPriceAiUtm(usableHref, {
    medium: "merchant_shop",
    campaign: "priceai_merchant",
    content: merchant.sourceId || merchant.id,
  });

  return (
    <a
      href={outboundUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-9 min-w-[72px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-[#f8f8f8] transition hover:bg-[#1f2526]"
    >
      进店
      <ChevronRight size={14} />
    </a>
  );
}

function OfferStatusBadge({ available }: { available: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
        available ? "bg-[#e8f3ec] text-[#2f7a4b]" : "bg-[#fbe9e7] text-[#9b3328]"
      }`}
    >
      {available ? "有货" : "缺货"}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-white px-6 py-16 text-center shadow-[0_20px_60px_rgba(45,52,53,0.05)] ring-1 ring-[#adb3b4]/15">
      <p className="font-serif text-2xl font-semibold text-[#202829]">{text}</p>
      <p className="mt-3 text-sm text-[#5a6061]">放宽筛选条件，或者提交新的可采集渠道。</p>
    </div>
  );
}

function DegradedBanner({ message, className = "mb-8" }: { message?: string | null; className?: string }) {
  return (
    <div className={`${className} rounded-lg bg-[#fff2ef] px-5 py-4 text-sm text-[#7b2f26] shadow-[0_18px_50px_rgba(45,52,53,0.04)] ring-1 ring-[#efd0ca]`}>
      {message || "真实报价数据暂时不可用，请稍后刷新。"}
    </div>
  );
}

function ExplorerMetrics({
  loading,
  products,
  offers,
  available,
  outOfStock,
}: {
  loading: boolean;
  products: number;
  offers: number;
  available: number;
  outOfStock: number;
}) {
  const metrics = [
    { label: "标准商品", value: metricValue(products, loading), icon: <PackageCheck size={15} /> },
    { label: "报价", value: metricValue(offers, loading), icon: <Database size={15} /> },
    { label: "有货", value: metricValue(available, loading), icon: <CheckCircle2 size={15} /> },
    { label: "缺货", value: metricValue(outOfStock, loading), icon: <Store size={15} /> },
  ];

  return (
    <div className="hidden gap-2 md:grid md:grid-cols-2 xl:flex xl:flex-wrap xl:max-w-[560px] xl:justify-end">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="inline-flex h-10 min-w-0 items-center justify-between gap-2 rounded-full bg-white px-3 text-sm font-semibold text-[#2d3435] shadow-[0_10px_30px_rgba(45,52,53,0.04)] ring-1 ring-[#adb3b4]/15 sm:justify-start sm:px-3.5"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[#5a6061]">
            <span className="shrink-0">{metric.icon}</span>
            <span className="truncate">{metric.label}</span>
          </span>
          <span className="shrink-0 tabular-nums text-[#202829]">{metric.value}</span>
        </div>
      ))}
    </div>
  );
}

function ProductTableSkeleton() {
  return (
    <>
      <div
        aria-busy="true"
        className="grid grid-cols-1 gap-3 md:hidden"
      >
        {PRODUCT_SKELETON_ROWS.map((row) => (
          <div
            key={row}
            className="min-h-[150px] animate-pulse rounded-lg bg-white p-4 ring-1 ring-[#adb3b4]/15"
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-[#edf0f1]" />
                <div className="space-y-2">
                  <div className="h-3 w-28 rounded-full bg-[#edf0f1]" />
                  <div className="h-2.5 w-16 rounded-full bg-[#edf0f1]" />
                </div>
              </div>
              <div className="h-7 w-16 rounded-full bg-[#edf0f1]" />
            </div>
            <div className="h-7 w-2/3 rounded-full bg-[#edf0f1]" />
            <div className="mt-5 flex gap-2">
              <div className="h-7 w-20 rounded-full bg-[#edf0f1]" />
              <div className="h-7 w-20 rounded-full bg-[#edf0f1]" />
              <div className="h-7 w-16 rounded-full bg-[#edf0f1]" />
            </div>
            <div className="mt-5 h-8 rounded-full bg-[#edf0f1]" />
          </div>
        ))}
      </div>
      <div className="hidden md:block" aria-busy="true">
        <div className="overflow-hidden rounded-lg bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15">
          <div className="bg-[#f2f4f4] px-5 py-3 text-[0.68rem] font-semibold text-[#5a6061]">
            正在同步商品报价
          </div>
          <div className="divide-y divide-[#edf0f1]">
            {PRODUCT_SKELETON_ROWS.map((row) => (
              <div key={row} className="grid min-h-[74px] grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] items-center gap-5 px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-[#edf0f1]" />
                  <div className="space-y-2">
                    <div className="h-3.5 w-52 rounded-full bg-[#edf0f1]" />
                    <div className="h-3 w-32 rounded-full bg-[#edf0f1]" />
                  </div>
                </div>
                <div className="h-3.5 rounded-full bg-[#edf0f1]" />
                <div className="h-3.5 rounded-full bg-[#edf0f1]" />
                <div className="h-3.5 rounded-full bg-[#edf0f1]" />
                <div className="h-3.5 rounded-full bg-[#edf0f1]" />
                <div className="h-9 rounded-full bg-[#edf0f1]" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function RelativeTime({ value }: { value: string | null | undefined }) {
  return <span suppressHydrationWarning>{formatRelativeTime(value)}</span>;
}

function MobileProductCard({
  product,
  returnQuery,
}: {
  product: ExplorerProductSummary;
  returnQuery: string;
}) {
  const previewOffer = product.lowestOffer;
  const available = product.inStockCount > 0;
  const productHref = productDetailHref(product.slug, returnQuery);
  const handleProductClick = listDetailClickHandler(productHref, returnQuery, () => trackProductDetailOpen(product));

  return (
    <article className="group relative rounded-lg bg-white px-4 py-3.5 ring-1 ring-[#adb3b4]/15 transition hover:bg-[var(--color-panel-soft)] active:bg-[var(--color-surface-hover)] md:hidden">
      <Link
        href={productHref}
        prefetch={false}
        onClick={handleProductClick}
        className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-page)]"
        aria-label={`查看 ${product.displayName} 详情`}
      >
        <span className="sr-only">查看 {product.displayName} 详情</span>
      </Link>

      <div className="pointer-events-none flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f2f4f4] text-[#5a6061]">
            {productIcon(product)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.95rem] font-semibold text-[#202829]">{product.displayName}</p>
            <p className="mt-0.5 line-clamp-1 text-xs text-[#5a6061]">{product.spec || product.platform}</p>
          </div>
        </div>
        <OfferStatusBadge available={available} />
      </div>

      <div className="pointer-events-none mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-2xl font-bold tracking-normal ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>
            {formatCurrency(product.lowestPrice, previewOffer?.currency)}
          </p>
          <p className="mt-1 truncate text-xs text-[#5a6061]">
            {previewOffer ? sourceLabel(previewOffer) : "暂无最低渠道"} · <RelativeTime value={product.latestSeenAt} />
          </p>
          <WarrantyLowestPrice
            product={product}
            returnQuery={returnQuery}
            mode="mobile"
          />
        </div>
        <span
          aria-hidden="true"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#2d3435] text-[#f8f8f8] transition group-hover:bg-[#1f2526]"
        >
          <ChevronRight size={15} />
        </span>
      </div>

      <div className="pointer-events-none mt-2.5 flex flex-wrap gap-1.5 text-xs">
        <CountBadge tone="good">有货 {product.inStockCount}</CountBadge>
        <CountBadge tone="danger">缺货 {product.outOfStockCount}</CountBadge>
        <CountBadge tone="muted">渠道 {product.offerCount}</CountBadge>
      </div>

    </article>
  );
}

function WarrantyLowestPrice({
  product,
  returnQuery,
  mode,
}: {
  product: ExplorerProductSummary;
  returnQuery: string;
  mode: "table" | "card" | "mobile";
}) {
  const warrantyOffer = product.warrantyLowestOffer;
  const hasWarrantyPrice = product.warrantyLowestPrice !== null && warrantyOffer;
  const href = productDetailHref(product.slug, returnQuery);
  const handleWarrantyClick = listDetailClickHandler(href, returnQuery, () => trackProductDetailOpen(product), {
    tags: "warranty_long",
  });

  if (mode === "table") {
    if (!hasWarrantyPrice) {
      return (
        <span
          title="暂无明确长期质保报价"
          className="text-sm font-semibold text-[#9aa2a3]"
        >
          -
        </span>
      );
    }

    return (
      <Link
        href={href}
        prefetch={false}
        onClick={handleWarrantyClick}
        title="查看长期质保报价"
        className="group inline-flex flex-col gap-1"
      >
        <span className="text-lg font-bold text-[#202829] group-hover:text-[#5e5e5e]">
          {formatCurrency(product.warrantyLowestPrice, warrantyOffer.currency)}
        </span>
        <span className="w-fit rounded-full bg-[#eef3f8] px-2 py-0.5 text-[0.65rem] font-semibold text-[#47657a]">
          质保
        </span>
      </Link>
    );
  }

  if (mode === "mobile") {
    if (!hasWarrantyPrice) return null;

    return (
      <Link
        href={href}
        prefetch={false}
        onClick={handleWarrantyClick}
        className="pointer-events-auto relative z-20 mt-1 inline-flex max-w-full items-center gap-1.5 text-xs font-semibold text-[#47657a]"
      >
        <span className="shrink-0 rounded-full bg-[#eef3f8] px-2 py-0.5">质保</span>
        <span className="truncate">{formatCurrency(product.warrantyLowestPrice, warrantyOffer.currency)}</span>
      </Link>
    );
  }

  if (!hasWarrantyPrice) return null;

  return (
    <Link
      href={href}
      prefetch={false}
      onClick={handleWarrantyClick}
      className="mt-3 flex min-h-[40px] items-center justify-between gap-3 rounded-lg bg-[#eef3f8] px-4 py-2 text-sm text-[#47657a] transition hover:bg-[#e3edf5]"
    >
      <span className="font-semibold">质保最低价</span>
      <span className="shrink-0 font-bold text-[#202829]">
        {formatCurrency(product.warrantyLowestPrice, warrantyOffer.currency)}
      </span>
    </Link>
  );
}

function TableHead({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <th className={`px-5 py-3 font-semibold ${className}`}>{children}</th>;
}

function ViewToggleButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-semibold transition ${
        active
          ? "bg-white text-[#202829] shadow-[0_8px_24px_rgba(45,52,53,0.08)]"
          : "text-[#5a6061] hover:text-[#202829]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function MobileFilterSheet({
  open,
  productType,
  stock,
  minPrice,
  maxPrice,
  filterScope,
  merchantCollector,
  merchantSignal,
  onProductTypeChange,
  onStockChange,
  onMinPriceChange,
  onMaxPriceChange,
  onMerchantCollectorChange,
  onMerchantSignalChange,
  onReset,
  onClose,
}: {
  open: boolean;
  productType: string;
  stock: string;
  minPrice: string;
  maxPrice: string;
  filterScope: FilterScope;
  merchantCollector: MerchantCollectorFilter;
  merchantSignal: MerchantSignalFilter;
  onProductTypeChange: (value: string) => void;
  onStockChange: (value: string) => void;
  onMinPriceChange: (value: string) => void;
  onMaxPriceChange: (value: string) => void;
  onMerchantCollectorChange: (value: MerchantCollectorFilter) => void;
  onMerchantSignalChange: (value: MerchantSignalFilter) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="高级筛选">
      <button
        type="button"
        aria-label="关闭筛选"
        onClick={onClose}
        className="absolute inset-0 bg-[#202829]/28"
      />
      <div className="absolute inset-x-0 bottom-0 max-h-[82vh] overflow-y-auto rounded-t-[24px] bg-[#f9f9f9] px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-4 shadow-[0_-24px_70px_rgba(45,52,53,0.18)]">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-[#c8ced0]" />
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-bold text-[#202829]">筛选</p>
            <p className="mt-1 text-xs text-[#5a6061]">{mobileFilterHint(filterScope)}</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#e4e9ea] text-[#2d3435]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 rounded-lg bg-[#f2f4f4] p-4">
          {filterScope.showProductType ? (
            <FilterSelect
              label="商品类型"
              value={productType}
              onChange={onProductTypeChange}
              options={["全部", ...productTypeOptions].map((item) => [item, productTypeLabels[item] || item] as [string, string])}
            />
          ) : null}
          {filterScope.showStock ? (
            <FilterSelect
              label="库存"
              value={stock}
              onChange={onStockChange}
              options={[
                ["all", "全部库存"],
                ["available", "有货"],
                ["out_of_stock", "缺货"],
              ]}
            />
          ) : null}
          {filterScope.showPrice ? (
            <div className="grid grid-cols-2 gap-3">
              <PriceInput label="最低价" value={minPrice} onChange={onMinPriceChange} />
              <PriceInput label="最高价" value={maxPrice} onChange={onMaxPriceChange} />
            </div>
          ) : null}
          {filterScope.showMerchantFilters ? (
            <>
              <FilterSelect
                label="采集来源"
                value={merchantCollector}
                onChange={(value) => onMerchantCollectorChange(value as MerchantCollectorFilter)}
                options={merchantCollectorOptions.map((item) => [item, merchantCollectorLabel(item)] as [string, string])}
              />
              <FilterSelect
                label="商家信号"
                value={merchantSignal}
                onChange={(value) => onMerchantSignalChange(value as MerchantSignalFilter)}
                options={merchantSignalOptions.map((item) => [item, merchantSignalLabel(item)] as [string, string])}
              />
            </>
          ) : null}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onReset}
            className="h-12 rounded-full bg-[#e4e9ea] px-4 text-sm font-semibold text-[#2d3435] transition hover:bg-[#dde4e5]"
          >
            重置
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-12 rounded-full bg-[#2d3435] px-4 text-sm font-semibold text-[#f8f8f8] transition hover:bg-[#1f2526]"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<string | [string, string]>;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[0.68rem] font-medium uppercase tracking-[0.14em] text-[#5a6061]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 w-full rounded-full bg-white px-4 text-sm outline-none ring-1 ring-[#adb3b4]/15 focus:ring-[#5e5e5e]/40"
      >
        {options.map((option) => {
          const [optionValue, optionLabel] = Array.isArray(option) ? option : [option, option];
          return (
            <option key={optionValue} value={optionValue}>
              {optionLabel}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function PriceInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[0.68rem] font-medium uppercase tracking-[0.14em] text-[#5a6061]">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        type="number"
        min="0"
        placeholder="¥"
        className="h-12 w-full rounded-full bg-white px-4 text-sm outline-none ring-1 ring-[#adb3b4]/15 focus:ring-[#5e5e5e]/40"
      />
    </label>
  );
}

function CountBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "good" | "warn" | "info" | "muted" | "danger";
}) {
  const className = {
    good: "bg-[#e8f3ec] text-[#2f7a4b]",
    warn: "bg-[#fff7e8] text-[#7a541b]",
    info: "bg-[#eef3f8] text-[#47657a]",
    muted: "bg-[#f2f4f4] text-[#5a6061]",
    danger: "bg-[#fbe9e7] text-[#9b3328]",
  }[tone];

  return <span className={`rounded-full px-2.5 py-1 font-medium ${className}`}>{children}</span>;
}

function tableStatusClass(isAvailable: boolean): string {
  return isAvailable ? "bg-[#e8f3ec] text-[#2f7a4b]" : "bg-[#fbe9e7] text-[#9b3328]";
}

function productDetailHref(slug: string, _returnQuery: string): string {
  void _returnQuery;
  return `/products/${slug}`;
}

function listDetailClickHandler(
  path: string,
  returnQuery: string,
  onOpen: () => void,
  extraParams: Record<string, string> = {},
) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    onOpen();
    if (!shouldHandleListDetailClick(event)) return;
    event.preventDefault();
    saveCurrentListScrollPosition();
    window.location.assign(listDetailNavigationHref(path, returnQuery, extraParams));
  };
}

async function fetchOfferPage(
  queryString: string,
  offset: number,
  signal?: AbortSignal,
): Promise<OfferListResponse> {
  const params = new URLSearchParams(queryString);
  params.set("limit", String(OFFER_PAGE_SIZE));
  params.set("offset", String(offset));

  const response = await fetch(`/api/offers?${params.toString()}`, { signal });
  if (!response.ok) throw new Error("报价加载失败");

  return (await response.json()) as OfferListResponse;
}

async function fetchExplorerData(signal?: AbortSignal): Promise<ExplorerData> {
  const response = await fetch("/api/explorer", { signal });
  if (!response.ok) throw new Error("商品数据加载失败");

  return (await response.json()) as ExplorerData;
}

async function fetchMerchantPage(
  queryString: string,
  offset: number,
  signal?: AbortSignal,
): Promise<MerchantListResponse> {
  const params = new URLSearchParams(queryString);
  params.set("limit", String(PUBLIC_MERCHANT_PAGE_SIZE));
  params.set("offset", String(offset));

  const response = await fetch(`/api/merchants?${params.toString()}`, { signal });
  if (!response.ok) throw new Error("商家数据加载失败");

  return (await response.json()) as MerchantListResponse;
}

function offerListCacheKey(queryString: string, offset: number): string {
  return `priceai:offers:v4-risk-feedback:${queryString || "all"}:${offset}:${OFFER_PAGE_SIZE}`;
}

function merchantListCacheKey(queryString: string, offset: number): string {
  return `${MERCHANT_LIST_CACHE_KEY}:${queryString || "all"}:${offset}:${PUBLIC_MERCHANT_PAGE_SIZE}`;
}

function rememberHealthyExplorerData(value: ExplorerData) {
  if (value.degraded) return;

  explorerMemoryCache = value;
  writeSessionCache(EXPLORER_CACHE_KEY, value);
}

function rememberOfferList(cacheKey: string, value: OfferListResponse) {
  offerListMemoryCache.delete(cacheKey);
  offerListMemoryCache.set(cacheKey, value);

  while (offerListMemoryCache.size > OFFER_LIST_MEMORY_CACHE_LIMIT) {
    const oldestKey = offerListMemoryCache.keys().next().value;
    if (!oldestKey) break;
    offerListMemoryCache.delete(oldestKey);
  }
}

function rememberHealthyOfferList(cacheKey: string, value: OfferListResponse) {
  if (value.degraded) return;

  rememberOfferList(cacheKey, value);
  writeSessionCache(cacheKey, value);
}

function rememberMerchantList(cacheKey: string, value: MerchantListResponse) {
  merchantListMemoryCache.delete(cacheKey);
  merchantListMemoryCache.set(cacheKey, value);

  while (merchantListMemoryCache.size > MERCHANT_LIST_MEMORY_CACHE_LIMIT) {
    const oldestKey = merchantListMemoryCache.keys().next().value;
    if (!oldestKey) break;
    merchantListMemoryCache.delete(oldestKey);
  }
}

function rememberHealthyMerchantList(cacheKey: string, value: MerchantListResponse) {
  if (value.degraded) return;

  rememberMerchantList(cacheKey, value);
  writeSessionCache(cacheKey, value);
}

function metricValue(value: number, loading: boolean): string {
  return loading ? "--" : value.toString();
}

function buildExplorerSearchParams({
  query,
  platform,
  productType,
  stock,
  minPrice,
  maxPrice,
  viewMode,
  scopeMode,
  merchantCollector,
  merchantSignal,
}: Required<ExplorerInitialState>): URLSearchParams {
  const params = new URLSearchParams();
  const normalizedQuery = query.trim();

  if (normalizedQuery) params.set("q", normalizedQuery);
  if (platform !== "全部") params.set("platform", platform);
  if (productType !== "全部") params.set("type", productType);
  if (stock !== "all") params.set("stock", stock);
  if (minPrice) params.set("min", minPrice);
  if (maxPrice) params.set("max", maxPrice);
  if (scopeMode !== "products") params.set("scope", scopeMode);
  if (scopeMode === "merchants" && viewMode !== defaultViewModeForScope(scopeMode)) params.set("view", viewMode);
  if (scopeMode === "merchants" && merchantCollector !== "all") params.set("collector", merchantCollector);
  if (scopeMode === "merchants" && merchantSignal !== "all") params.set("signal", merchantSignal);

  return params;
}

function buildPublicListSearchParams({
  query,
  platform,
  productType,
  stock,
  minPrice,
  maxPrice,
  collector,
  signal,
}: {
  query: string;
  platform: string;
  productType: string;
  stock: string;
  minPrice: string;
  maxPrice: string;
  collector?: MerchantCollectorFilter;
  signal?: MerchantSignalFilter;
}): URLSearchParams {
  const params = new URLSearchParams();
  const normalizedQuery = query.trim();

  if (normalizedQuery) params.set("q", normalizedQuery);
  if (platform !== "全部") params.set("platform", platform);
  if (productType !== "全部") params.set("type", productType);
  if (stock !== "all") params.set("stock", stock);
  if (minPrice) params.set("min", minPrice);
  if (maxPrice) params.set("max", maxPrice);
  if (collector && collector !== "all") params.set("collector", collector);
  if (signal && signal !== "all") params.set("signal", signal);

  return params;
}

function parseExplorerInitialState(params: URLSearchParams): ExplorerInitialState {
  const scopeMode = pickParam(params.get("scope") || "", scopeOptions, "products");
  const defaultViewMode: ViewMode = scopeMode === "merchants" ? "cards" : "table";
  const viewMode = pickParam(params.get("view") || "", viewOptions, defaultViewMode);

  return {
    query: params.get("q") || "",
    platform: pickParam(params.get("platform") || "", ["全部", ...visiblePlatformOptions], "全部"),
    productType: pickParam(params.get("type") || "", ["全部", ...productTypeOptions], "全部"),
    stock: pickParam(params.get("stock") || "", stockOptions, "all"),
    minPrice: numericParam(params.get("min") || ""),
    maxPrice: numericParam(params.get("max") || ""),
    viewMode: normalizeViewModeForScope(scopeMode, viewMode),
    scopeMode,
    merchantCollector: parseMerchantCollectorFilter(params.get("collector")),
    merchantSignal: pickParam(params.get("signal") || "", merchantSignalOptions, "all"),
  };
}

function pickParam<T extends string>(value: string, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function numericParam(value: string): string {
  const normalized = value.trim();
  if (!normalized || Number.isNaN(Number(normalized))) return "";
  return Number(normalized) >= 0 ? normalized : "";
}

function productSortPenalty(product: ExplorerProductSummary): number {
  let penalty = 0;
  const text = `${product.displayName} ${product.platform} ${product.productType} ${product.spec}`.toLowerCase();

  if (product.platform === "其他" || product.productType === "其他" || text.includes("其他商品")) {
    penalty += 200;
  }

  return penalty;
}

function compareProductPrice(a: ExplorerProductSummary, b: ExplorerProductSummary): number {
  return (a.lowestPrice ?? Number.MAX_SAFE_INTEGER) - (b.lowestPrice ?? Number.MAX_SAFE_INTEGER);
}

function searchPlaceholderForScope(scopeMode: ScopeMode): string {
  if (scopeMode === "offers") return "搜索报价标题、渠道名或商品关键词";
  if (scopeMode === "merchants") return "搜索店铺名，或粘贴店铺链接";
  return "搜索标准商品，如 ChatGPT Plus、Gemini Pro、邮箱";
}

function compareProductFallback(a: ExplorerProductSummary, b: ExplorerProductSummary): number {
  const nameDelta = a.displayName.localeCompare(b.displayName, "zh-CN");
  if (nameDelta !== 0) return nameDelta;

  return a.id.localeCompare(b.id, "zh-CN");
}

function offerTimestamp(offer: RawOffer): string | null | undefined {
  return offer.verifiedAt || offer.lastSeenAt || offer.capturedAt || offer.sourceUpdatedAt;
}

function sourceLabel(offer: Pick<RawOffer, "sourceName" | "sourceStoreName">): string {
  return merchantSourceDisplayName(offer.sourceStoreName) || merchantSourceDisplayName(offer.sourceName) || "未记录渠道";
}

function sourceSecondaryLabel(offer: Pick<RawOffer, "sourceName" | "sourceStoreName">): string | null {
  const sourceName = merchantSourceDisplayName(offer.sourceName);
  if (!sourceName || sourceName === sourceLabel(offer)) return null;
  return sourceName;
}

function trackProductDetailOpen(product: Pick<CanonicalProduct, "id" | "platform" | "productType">) {
  trackAnalyticsEvent("product_detail_open", {
    product_id: product.id,
    platform: product.platform,
    product_type: product.productType,
  });
}

function buildActiveFilterChips({
  productType,
  stock,
  minPrice,
  maxPrice,
  merchantCollector,
  merchantSignal,
  showingMerchants,
}: {
  productType: string;
  stock: string;
  minPrice: string;
  maxPrice: string;
  merchantCollector: MerchantCollectorFilter;
  merchantSignal: MerchantSignalFilter;
  showingMerchants: boolean;
}): string[] {
  const filters: string[] = [];
  if (productType !== "全部") filters.push(productTypeLabels[productType] || productType);
  if (stock === "available") filters.push("有货");
  if (stock === "out_of_stock") filters.push("缺货");
  if (minPrice || maxPrice) filters.push(`¥${minPrice || "0"}-${maxPrice || "不限"}`);
  if (showingMerchants && merchantCollector !== "all") filters.push(merchantCollectorLabel(merchantCollector));
  if (showingMerchants && merchantSignal !== "all") filters.push(merchantSignalLabel(merchantSignal));
  return filters;
}

function filterScopeForMode(scopeMode: ScopeMode): FilterScope {
  if (scopeMode === "offers") {
    return {
      showProductType: true,
      showStock: true,
      showPrice: true,
      showMerchantFilters: false,
    };
  }

  if (scopeMode === "merchants") {
    return {
      showProductType: false,
      showStock: true,
      showPrice: false,
      showMerchantFilters: true,
    };
  }

  return {
    showProductType: true,
    showStock: true,
    showPrice: false,
    showMerchantFilters: false,
  };
}

function mobileFilterHint(scope: FilterScope): string {
  if (scope.showPrice) return "按商品类型、库存和报价价格收窄结果";
  if (scope.showMerchantFilters) return "按库存、采集来源和商家信号筛选";
  return "按商品类型和库存快速收窄标准商品";
}

function buildTitle(platform: string, productType: string, scopeMode: ScopeMode): string {
  const showingOffers = scopeMode === "offers";
  const showingMerchants = scopeMode === "merchants";

  if (platform === "全部" && productType === "全部" && showingMerchants) {
    return "卡网商家观察";
  }

  if (platform === "全部" && productType === "全部" && !showingOffers) {
    return "卡网订阅比价";
  }

  const platformName = platform === "全部" ? "全平台" : platform;
  const typeName = productType === "全部" ? "标准商品" : productTypeLabels[productType] || productType;

  if (showingOffers) {
    return productType === "全部" ? `${platformName} 全部报价` : `${platformName} ${typeName}全部报价`;
  }

  if (showingMerchants) {
    return productType === "全部" ? `${platformName} 卡网商家` : `${platformName} ${typeName}商家`;
  }

  return `${platformName} ${typeName}报价`;
}

function merchantSignalLabel(value: MerchantSignalFilter): string {
  if (value === "all") return "全部信号";
  if (value === "lowest") return "有最低价命中";
  if (value === "warranty") return "有质保最低价";
  if (value === "platform_aftersales") return "有平台售后机制";
  return "暂无风险反馈";
}

function platformIcon(platform: string): ReactNode {
  const className = "h-[18px] w-[18px]";

  if (platform !== "全部" && platform !== "其他") return <BrandIcon platform={platform} className={className} />;
  if (platform === "其他") return <Layers3 className={`${className} text-[#5a6061]`} />;
  return <Layers3 className={`${className} text-[#5a6061]`} />;
}

function productIcon(product: Pick<CanonicalProduct, "id" | "platform" | "productType" | "displayName">): ReactNode {
  const className = "h-[18px] w-[18px]";
  return <BrandIcon platform={product.platform} productId={product.id} className={className} />;
}
