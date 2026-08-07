"use client";

import Link from "next/link";
import { AlertTriangle, Boxes, ChevronDown, Clock3, ExternalLink, Filter, Flag, ShieldAlert, X } from "lucide-react";
import { type ClipboardEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CommunityPrompt } from "@/components/FeedbackLink";
import { FeedbackEvidenceUploader } from "@/components/FeedbackEvidenceUploader";
import { MobileFilterSheet } from "@/components/ComparisonUi";
import { CollectorSourceLogo } from "@/components/MerchantCollectorSource";
import { buildLoginHref as buildAuthLoginHref } from "@/lib/auth-paths";
import { useAccountUser } from "@/lib/account-client";
import { canonicalCatalog, compareProductDisplayOrder, isAvailable, isSharedAccessOffer } from "@/lib/catalog";
import { trackAnalyticsEvent } from "@/lib/analytics";
import { readSessionCache, writeSessionCache } from "@/lib/client-cache";
import { useMediaQuery } from "@/lib/client-hooks";
import { createTimeoutSignal, isGeneratedDatasetStale, newestUsableGeneratedDataset } from "@/lib/client-refresh";
import { safeExternalShopUrl } from "@/lib/external-url";
import { rewriteLdxpUrlHost } from "@/lib/ldxp-domain-settings-shared";
import { withPriceAiUtm } from "@/lib/outbound-analytics-client";
import {
  MERCHANT_COLLECTOR_FILTERS,
  merchantCollectorFilterLogo,
  merchantCollectorGroup,
  merchantCollectorLabel,
  merchantSourceDisplayName,
  merchantSourcePlatform,
  parseMerchantCollectorFilter,
} from "@/lib/merchant-collectors";
import {
  OFFER_FILTER_TAGS,
  OFFER_FILTER_TAG_BY_ID,
  deriveOfferFilterTags,
  isChatGptPlusChannelFilterTag,
  offerFilterTagAppliesToProduct,
  parseOfferFilterTagsForProduct,
  toggleOfferFilterTag,
  type OfferFilterTagFacet,
  type OfferFilterTagId,
} from "@/lib/offer-filter-tags";
import {
  AFTERSALES_FEEDBACK_REASON,
  HIGH_RISK_FEEDBACK_REASONS,
  OFFER_EXIT_NOTICE_MUTED_DATE_KEY,
  OFFER_HIGH_RISK_PRICE_THRESHOLD,
  feedbackRequiresContact,
  feedbackRequiresEvidence,
  feedbackRequiresImageEvidence,
  getOfferRiskHints,
  isHighRiskOutboundOffer,
  isShopApiOffer,
} from "@/lib/trust-risk";
import {
  buildFeedbackResumePath,
  clearFeedbackDraft,
  clearFeedbackResumeRequest,
  getFeedbackResumeRequest,
  readFeedbackDraft,
  writeFeedbackDraft,
} from "@/lib/feedback-draft";
import { priceDataCacheTtlMsForProduct } from "@/lib/public-cache-policy";
import { PUBLIC_OFFER_DEFAULT_LIMIT } from "@/lib/public-offer-query";
import {
  PRODUCT_OFFER_QUICK_FRESHNESS_MINUTES,
  PRODUCT_OFFER_QUICK_STOCK_THRESHOLD,
  parseProductOfferFreshnessMinutes,
  parseProductOfferStockThreshold,
  productOfferPublicTimestamp,
  type ProductOfferFreshnessMinutes,
  type ProductOfferStockThreshold,
} from "@/lib/product-offer-filters";
import { hasMoreProductOfferPage, mergeProductOfferPages } from "@/lib/product-offer-pagination";
import { groupSameTitleOffers, type SameTitleOfferGroup } from "@/lib/same-title-offer-groups";
import { useDialogFocus } from "@/lib/use-dialog-focus";
import { useFeedbackEvidenceUpload } from "@/lib/use-feedback-evidence-upload";
import type { MerchantCollectorFilter, OfferFeedbackIssueDimension, OfferFeedbackReason, OfferFeedbackUserExpectedAction, PublicMerchantSummary, RawOffer } from "@/lib/types";
import { formatCurrency, formatDateMinute, formatRelativeTime } from "@/lib/utils";

type ProductOffersResponse = {
  offers: RawOffer[];
  total: number;
  filterFacets?: OfferFilterTagFacet[];
  activeFilterTags?: OfferFilterTagId[];
  limited?: boolean;
  generatedAt: string;
  degraded?: boolean;
  message?: string | null;
};

const OFFER_PAGE_SIZE = PUBLIC_OFFER_DEFAULT_LIMIT;
const PRODUCT_OFFERS_REFRESH_TIMEOUT_MS = 10_000;
const PRODUCT_OFFERS_MEMORY_CACHE_LIMIT = 40;
const FEEDBACK_EVIDENCE_MAX_IMAGES = 5;
const INVENTORY_NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");
const CHATGPT_PLUS_QUICK_FILTER_TAG_IDS: OfferFilterTagId[] = [
  "shared_access",
  "web_only_account",
  "domestic_mirror_site",
  "delivery_recharge",
  "account_verified",
  "account_unverified",
  "warranty_long",
];
const productOffersMemoryCache = new Map<string, ProductOffersResponse>();

export function ProductOffersPanel({
  productId,
  productSlug,
  productName,
  initialCount,
  initialData = null,
  initialFilterTags = [],
  initialQuery = "",
  initialExcludeQuery = "",
  initialCollector = "all",
  initialMinPrice = "",
  initialMaxPrice = "",
  initialMinStock = null,
  initialFreshWithinMinutes = null,
}: {
  productId: string;
  productSlug: string;
  productName: string;
  initialCount: number;
  initialData?: ProductOffersResponse | null;
  initialFilterTags?: string[];
  initialQuery?: string;
  initialExcludeQuery?: string;
  initialCollector?: string;
  initialMinPrice?: string;
  initialMaxPrice?: string;
  initialMinStock?: number | null;
  initialFreshWithinMinutes?: number | null;
}) {
  const normalizedInitialFilterTags = useMemo(() => parseOfferFilterTagsForProduct(productId, initialFilterTags), [initialFilterTags, productId]);
  const normalizedInitialQuery = useMemo(() => normalizeOfferSearchQuery(initialQuery), [initialQuery]);
  const normalizedInitialExcludeQuery = useMemo(() => normalizeOfferSearchQuery(initialExcludeQuery, 160), [initialExcludeQuery]);
  const normalizedInitialCollector = useMemo(() => parseMerchantCollectorFilter(initialCollector), [initialCollector]);
  const normalizedInitialMinPrice = useMemo(() => normalizeOfferPriceInput(initialMinPrice), [initialMinPrice]);
  const normalizedInitialMaxPrice = useMemo(() => normalizeOfferPriceInput(initialMaxPrice), [initialMaxPrice]);
  const normalizedInitialMinStock = useMemo(() => parseProductOfferStockThreshold(initialMinStock), [initialMinStock]);
  const normalizedInitialFreshWithinMinutes = useMemo(
    () => parseProductOfferFreshnessMinutes(initialFreshWithinMinutes),
    [initialFreshWithinMinutes],
  );
  const [selectedFilterTags, setSelectedFilterTags] = useState<OfferFilterTagId[]>(normalizedInitialFilterTags);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedCollector, setSelectedCollector] = useState<MerchantCollectorFilter>(normalizedInitialCollector);
  const [queryInput, setQueryInput] = useState(normalizedInitialQuery);
  const [excludeInput, setExcludeInput] = useState(normalizedInitialExcludeQuery);
  const [minPriceInput, setMinPriceInput] = useState(normalizedInitialMinPrice);
  const [maxPriceInput, setMaxPriceInput] = useState(normalizedInitialMaxPrice);
  const [selectedMinStock, setSelectedMinStock] = useState<ProductOfferStockThreshold | null>(normalizedInitialMinStock);
  const [selectedFreshWithinMinutes, setSelectedFreshWithinMinutes] = useState<ProductOfferFreshnessMinutes | null>(normalizedInitialFreshWithinMinutes);
  const [offerQuery, setOfferQuery] = useState(normalizedInitialQuery);
  const [offerExcludeQuery, setOfferExcludeQuery] = useState(normalizedInitialExcludeQuery);
  const [offerMinPrice, setOfferMinPrice] = useState(normalizedInitialMinPrice);
  const [offerMaxPrice, setOfferMaxPrice] = useState(normalizedInitialMaxPrice);
  const selectedFilterKey = selectedFilterTags.join(",");
  const offerQueryKey = offerQuery.trim();
  const offerExcludeQueryKey = offerExcludeQuery.trim();
  const offerMinPriceKey = offerMinPrice.trim();
  const offerMaxPriceKey = offerMaxPrice.trim();
  const initialFilterKey = normalizedInitialFilterTags.join(",");
  const initialCacheKey = productOffersCacheKey(
    productId,
    0,
    normalizedInitialFilterTags,
    normalizedInitialQuery,
    normalizedInitialExcludeQuery,
    normalizedInitialCollector,
    normalizedInitialMinPrice,
    normalizedInitialMaxPrice,
    normalizedInitialMinStock,
    normalizedInitialFreshWithinMinutes,
  );
  const activeCacheKey = productOffersCacheKey(
    productId,
    0,
    selectedFilterTags,
    offerQueryKey,
    offerExcludeQueryKey,
    selectedCollector,
    offerMinPriceKey,
    offerMaxPriceKey,
    selectedMinStock,
    selectedFreshWithinMinutes,
  );
  const activeCacheKeyRef = useRef(activeCacheKey);
  const cachedInitialData = newestUsableGeneratedDataset(productOffersMemoryCache.get(initialCacheKey), initialData);
  const [data, setData] = useState<ProductOffersResponse | null>(cachedInitialData);
  const [dataCacheKey, setDataCacheKey] = useState<string | null>(cachedInitialData ? initialCacheKey : null);
  const [loading, setLoading] = useState(!cachedInitialData);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackOffer, setFeedbackOffer] = useState<RawOffer | null>(null);
  const [outboundOffer, setOutboundOffer] = useState<RawOffer | null>(null);
  const pagingControllerRef = useRef<AbortController | null>(null);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const purchaseTermsMockEnabled = useSyncExternalStore(
    subscribePurchaseTermsMock,
    isPurchaseTermsMockEnabled,
    disabledPurchaseTermsMockSnapshot,
  );

  useEffect(() => {
    activeCacheKeyRef.current = activeCacheKey;
    pagingControllerRef.current?.abort();
    pagingControllerRef.current = null;
  }, [activeCacheKey]);

  useEffect(() => () => pagingControllerRef.current?.abort(), []);

  useEffect(() => {
    const urlFilters = readOfferFiltersFromUrl();
    if (!urlFilters) return;

    const nextFilterTags = parseOfferFilterTagsForProduct(productId, urlFilters.tags);
    const nextQuery = normalizeOfferSearchQuery(urlFilters.query);
    const nextExcludeQuery = normalizeOfferSearchQuery(urlFilters.excludeQuery, 160);
    const nextCollector = parseMerchantCollectorFilter(urlFilters.collector);
    const nextMinPrice = normalizeOfferPriceInput(urlFilters.minPrice);
    const nextMaxPrice = normalizeOfferPriceInput(urlFilters.maxPrice);
    const nextMinStock = parseProductOfferStockThreshold(urlFilters.minStock);
    const nextFreshWithinMinutes = parseProductOfferFreshnessMinutes(urlFilters.freshWithinMinutes);
    const hasUrlFilters = nextFilterTags.length > 0 || Boolean(
      nextQuery || nextExcludeQuery || nextMinPrice || nextMaxPrice || nextCollector !== "all" || nextMinStock || nextFreshWithinMinutes,
    );
    if (!hasUrlFilters) return;

    const frameId = window.requestAnimationFrame(() => {
      setSelectedFilterTags(nextFilterTags);
      setSelectedCollector(nextCollector);
      setQueryInput(nextQuery);
      setExcludeInput(nextExcludeQuery);
      setMinPriceInput(nextMinPrice);
      setMaxPriceInput(nextMaxPrice);
      setSelectedMinStock(nextMinStock);
      setSelectedFreshWithinMinutes(nextFreshWithinMinutes);
      setOfferQuery(nextQuery);
      setOfferExcludeQuery(nextExcludeQuery);
      setOfferMinPrice(nextMinPrice);
      setOfferMaxPrice(nextMaxPrice);
      if (window.matchMedia("(min-width: 768px)").matches) setFilterOpen(true);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [productId]);

  useEffect(() => {
    const productOffersCacheTtlMs = priceDataCacheTtlMsForProduct(productId);
    const filterTags = parseOfferFilterTagsForProduct(productId, selectedFilterKey);
    const query = normalizeOfferSearchQuery(offerQuery);
    const excludeQuery = normalizeOfferSearchQuery(offerExcludeQuery, 160);
    const minPrice = normalizeOfferPriceInput(offerMinPrice);
    const maxPrice = normalizeOfferPriceInput(offerMaxPrice);
    const cacheKey = productOffersCacheKey(
      productId,
      0,
      filterTags,
      query,
      excludeQuery,
      selectedCollector,
      minPrice,
      maxPrice,
      selectedMinStock,
      selectedFreshWithinMinutes,
    );
    let cancelRefresh: (() => void) | null = null;
    let active = true;

    async function loadOffers() {
      setPaging(false);
      const shouldUseInitialData =
        filterTags.join(",") === initialFilterKey &&
        query === normalizedInitialQuery &&
        excludeQuery === normalizedInitialExcludeQuery &&
        selectedCollector === normalizedInitialCollector &&
        minPrice === normalizedInitialMinPrice &&
        maxPrice === normalizedInitialMaxPrice &&
        selectedMinStock === normalizedInitialMinStock &&
        selectedFreshWithinMinutes === normalizedInitialFreshWithinMinutes;
      const cachedData = newestUsableGeneratedDataset(
        productOffersMemoryCache.get(cacheKey),
        shouldUseInitialData ? initialData : null,
        readSessionCache<ProductOffersResponse>(cacheKey, productOffersCacheTtlMs),
      );

      if (cachedData) {
        rememberHealthyProductOffers(cacheKey, cachedData);
        setData(cachedData);
        setDataCacheKey(cacheKey);
        setLoading(false);
        setError(null);

        if (!isGeneratedDatasetStale(cachedData, productOffersCacheTtlMs)) return;
      } else {
        setLoading(true);
      }
      const timeout = createTimeoutSignal(PRODUCT_OFFERS_REFRESH_TIMEOUT_MS);
      cancelRefresh = timeout.cancel;

      try {
        const nextData = await fetchProductOfferPage(
          productId,
          0,
          filterTags,
          query,
          excludeQuery,
          selectedCollector,
          minPrice,
          maxPrice,
          selectedMinStock,
          selectedFreshWithinMinutes,
          timeout.signal,
        );
        if (!active) return;
        const latestData = newestUsableGeneratedDataset(nextData, productOffersMemoryCache.get(cacheKey)) ?? nextData;
        rememberHealthyProductOffers(cacheKey, latestData);
        setData(latestData);
        setDataCacheKey(cacheKey);
        setError(null);
      } catch (currentError) {
        if (!active) return;
        if (timeout.signal.aborted) {
          if (!cachedData) setError("报价加载超时，请稍后刷新");
        } else {
          setError(currentError instanceof Error ? currentError.message : "报价加载失败");
          if (!cachedData) {
            setData(null);
            setDataCacheKey(null);
          }
        }
      } finally {
        timeout.clear();
        if (active) setLoading(false);
      }
    }

    loadOffers();

    return () => {
      active = false;
      cancelRefresh?.();
    };
  }, [
    initialData,
    initialFilterKey,
    normalizedInitialExcludeQuery,
    normalizedInitialCollector,
    normalizedInitialMaxPrice,
    normalizedInitialMinStock,
    normalizedInitialFreshWithinMinutes,
    normalizedInitialMinPrice,
    normalizedInitialQuery,
    offerExcludeQuery,
    offerMaxPrice,
    offerMinPrice,
    offerQuery,
    productId,
    selectedCollector,
    selectedMinStock,
    selectedFreshWithinMinutes,
    selectedFilterKey,
  ]);

  const activeData = dataCacheKey === activeCacheKey ? data : null;
  const visibleData = useMemo(
    () => purchaseTermsMockEnabled ? withPurchaseTermsMock(activeData) : activeData,
    [activeData, purchaseTermsMockEnabled],
  );
  const offers = useMemo(() => visibleData?.offers ?? [], [visibleData]);
  const offerGroups = useMemo(
    () => groupSameTitleOffers(offers, (offer) => offer, () => productId),
    [offers, productId],
  );

  useEffect(() => {
    if (feedbackOffer || !offers.length) return;
    const resume = getFeedbackResumeRequest();
    if (resume?.kind !== "offer") return;
    const matchedOffer = offers.find((offer) => offer.id === resume.id);
    if (!matchedOffer) return;
    const frameId = window.requestAnimationFrame(() => {
      setFeedbackOffer(matchedOffer);
      clearFeedbackResumeRequest();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [feedbackOffer, offers]);
  const total = visibleData?.total ?? (selectedFilterTags.length > 0 || Boolean(
    offerQueryKey || offerExcludeQueryKey || offerMinPriceKey || offerMaxPriceKey || selectedCollector !== "all" || selectedMinStock || selectedFreshWithinMinutes,
  ) ? 0 : initialCount);
  const filterFacets = productOfferFilterFacets(
    activeData?.filterFacets,
    data?.filterFacets,
    initialData?.filterFacets,
    selectedFilterTags,
  );
  const hasMore = activeData ? !loading && hasMoreProductOfferPage(activeData) : false;
  const activeFilters = selectedFilterTags.length > 0 || Boolean(
    offerQueryKey || offerExcludeQueryKey || offerMinPriceKey || offerMaxPriceKey || selectedCollector !== "all" || selectedMinStock || selectedFreshWithinMinutes,
  );

  const loadMoreOffers = useCallback(async () => {
    if (!activeData || loading || paging || offers.length >= total) return;
    const filterTags = parseOfferFilterTagsForProduct(productId, selectedFilterTags);
    const query = normalizeOfferSearchQuery(offerQuery);
    const excludeQuery = normalizeOfferSearchQuery(offerExcludeQuery, 160);
    const minPrice = normalizeOfferPriceInput(offerMinPrice);
    const maxPrice = normalizeOfferPriceInput(offerMaxPrice);
    const requestCacheKey = productOffersCacheKey(
      productId,
      0,
      filterTags,
      query,
      excludeQuery,
      selectedCollector,
      minPrice,
      maxPrice,
      selectedMinStock,
      selectedFreshWithinMinutes,
    );
    if (dataCacheKey !== requestCacheKey) return;
    if (pagingControllerRef.current) return;

    const controller = new AbortController();
    pagingControllerRef.current = controller;
    setPaging(true);
    setError(null);

    try {
      const nextPage = await fetchProductOfferPage(
        productId,
        offers.length,
        filterTags,
        query,
        excludeQuery,
        selectedCollector,
        minPrice,
        maxPrice,
        selectedMinStock,
        selectedFreshWithinMinutes,
        controller.signal,
      );
      if (activeCacheKeyRef.current !== requestCacheKey) return;
      setData((current) => {
        if (activeCacheKeyRef.current !== requestCacheKey) return current;
        if (!current) return nextPage;

        const mergedData = mergeProductOfferPages(current, nextPage);

        const cacheKey = productOffersCacheKey(
          productId,
          0,
          filterTags,
          query,
          excludeQuery,
          selectedCollector,
          minPrice,
          maxPrice,
          selectedMinStock,
          selectedFreshWithinMinutes,
        );
        rememberHealthyProductOffers(cacheKey, mergedData);

        return mergedData;
      });
    } catch (currentError) {
      if (controller.signal.aborted) return;
      if (activeCacheKeyRef.current !== requestCacheKey) return;
      setError(currentError instanceof Error ? currentError.message : "报价加载失败");
    } finally {
      if (pagingControllerRef.current === controller) pagingControllerRef.current = null;
      if (!controller.signal.aborted && activeCacheKeyRef.current === requestCacheKey) setPaging(false);
    }
  }, [activeData, dataCacheKey, loading, offerExcludeQuery, offerMaxPrice, offerMinPrice, offerQuery, offers.length, paging, productId, selectedCollector, selectedFilterTags, selectedFreshWithinMinutes, selectedMinStock, total]);

  const handleToggleFilterTag = useCallback((tagId: OfferFilterTagId) => {
    const nextTags = toggleOfferFilterTag(selectedFilterTags, tagId);
    setSelectedFilterTags(nextTags);
    syncOfferFiltersToUrl(nextTags, offerQuery, offerExcludeQuery, selectedCollector, offerMinPrice, offerMaxPrice, selectedMinStock, selectedFreshWithinMinutes);
  }, [offerExcludeQuery, offerMaxPrice, offerMinPrice, offerQuery, selectedCollector, selectedFilterTags, selectedFreshWithinMinutes, selectedMinStock]);

  const handleClearFilterTags = useCallback((tagIds: OfferFilterTagId[]) => {
    if (!tagIds.length) return;
    const removeIds = new Set(tagIds);
    const nextTags = selectedFilterTags.filter((tagId) => !removeIds.has(tagId));
    setSelectedFilterTags(nextTags);
    syncOfferFiltersToUrl(nextTags, offerQuery, offerExcludeQuery, selectedCollector, offerMinPrice, offerMaxPrice, selectedMinStock, selectedFreshWithinMinutes);
  }, [offerExcludeQuery, offerMaxPrice, offerMinPrice, offerQuery, selectedCollector, selectedFilterTags, selectedFreshWithinMinutes, selectedMinStock]);

  const applyOfferFilters = useCallback(() => {
    const nextQuery = normalizeOfferSearchQuery(queryInput);
    const nextExcludeQuery = normalizeOfferSearchQuery(excludeInput, 160);
    const nextMinPrice = normalizeOfferPriceInput(minPriceInput);
    const nextMaxPrice = normalizeOfferPriceInput(maxPriceInput);
    setQueryInput(nextQuery);
    setExcludeInput(nextExcludeQuery);
    setMinPriceInput(nextMinPrice);
    setMaxPriceInput(nextMaxPrice);
    setOfferQuery(nextQuery);
    setOfferExcludeQuery(nextExcludeQuery);
    setOfferMinPrice(nextMinPrice);
    setOfferMaxPrice(nextMaxPrice);
    syncOfferFiltersToUrl(
      selectedFilterTags,
      nextQuery,
      nextExcludeQuery,
      selectedCollector,
      nextMinPrice,
      nextMaxPrice,
      selectedMinStock,
      selectedFreshWithinMinutes,
    );
  }, [excludeInput, maxPriceInput, minPriceInput, queryInput, selectedCollector, selectedFilterTags, selectedFreshWithinMinutes, selectedMinStock]);

  const handleSearchSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applyOfferFilters();
  }, [applyOfferFilters]);

  const applyOfferFiltersAndClose = useCallback(() => {
    applyOfferFilters();
    setFilterOpen(false);
  }, [applyOfferFilters]);

  const handleCollectorChange = useCallback((collector: MerchantCollectorFilter) => {
    setSelectedCollector(collector);
    syncOfferFiltersToUrl(selectedFilterTags, offerQuery, offerExcludeQuery, collector, offerMinPrice, offerMaxPrice, selectedMinStock, selectedFreshWithinMinutes);
  }, [offerExcludeQuery, offerMaxPrice, offerMinPrice, offerQuery, selectedFilterTags, selectedFreshWithinMinutes, selectedMinStock]);

  const handleMinStockChange = useCallback((minStock: ProductOfferStockThreshold | null) => {
    setSelectedMinStock(minStock);
    syncOfferFiltersToUrl(
      selectedFilterTags,
      offerQuery,
      offerExcludeQuery,
      selectedCollector,
      offerMinPrice,
      offerMaxPrice,
      minStock,
      selectedFreshWithinMinutes,
    );
  }, [offerExcludeQuery, offerMaxPrice, offerMinPrice, offerQuery, selectedCollector, selectedFilterTags, selectedFreshWithinMinutes]);

  const handleFreshWithinChange = useCallback((freshWithinMinutes: ProductOfferFreshnessMinutes | null) => {
    setSelectedFreshWithinMinutes(freshWithinMinutes);
    syncOfferFiltersToUrl(
      selectedFilterTags,
      offerQuery,
      offerExcludeQuery,
      selectedCollector,
      offerMinPrice,
      offerMaxPrice,
      selectedMinStock,
      freshWithinMinutes,
    );
  }, [offerExcludeQuery, offerMaxPrice, offerMinPrice, offerQuery, selectedCollector, selectedFilterTags, selectedMinStock]);

  const clearOfferFilters = useCallback(() => {
    setSelectedFilterTags([]);
    setSelectedCollector("all");
    setQueryInput("");
    setExcludeInput("");
    setMinPriceInput("");
    setMaxPriceInput("");
    setOfferQuery("");
    setOfferExcludeQuery("");
    setOfferMinPrice("");
    setOfferMaxPrice("");
    setSelectedMinStock(null);
    setSelectedFreshWithinMinutes(null);
    setFilterOpen(false);
    syncOfferFiltersToUrl([], "", "", "all", "", "", null, null);
  }, []);

  if (loading && !data) {
    return (
      <OfferTableSkeleton count={initialCount} />
    );
  }

  if (error && !data) {
    return (
      <div className="mt-6 rounded-lg bg-[#fff7e8] px-5 py-4 text-sm font-medium text-[#6a4b16]">
        {error}
      </div>
    );
  }

  return (
    <>
      {visibleData?.degraded ? (
        <DegradedBanner message={visibleData.message} />
      ) : null}
      {error ? (
        <InlineErrorBanner message={error} />
      ) : null}
      <OfferFilterBar
        productId={productId}
        facets={filterFacets}
        selectedTags={selectedFilterTags}
        selectedCollector={selectedCollector}
        selectedMinStock={selectedMinStock}
        selectedFreshWithinMinutes={selectedFreshWithinMinutes}
        total={total}
        active={activeFilters}
        pending={loading || !visibleData}
        excludeInput={excludeInput}
        activeExcludeQuery={offerExcludeQueryKey}
        filterOpen={filterOpen}
        maxPriceInput={maxPriceInput}
        minPriceInput={minPriceInput}
        activeMaxPrice={offerMaxPriceKey}
        activeMinPrice={offerMinPriceKey}
        queryInput={queryInput}
        activeQuery={offerQueryKey}
        onClear={clearOfferFilters}
        onCollectorChange={handleCollectorChange}
        onExcludeInputChange={setExcludeInput}
        onFilterOpenChange={setFilterOpen}
        onMaxPriceInputChange={setMaxPriceInput}
        onMinPriceInputChange={setMinPriceInput}
        onMinStockChange={handleMinStockChange}
        onFreshWithinChange={handleFreshWithinChange}
        onApply={applyOfferFiltersAndClose}
        onSearchInputChange={setQueryInput}
        onSearchSubmit={handleSearchSubmit}
        onClearTags={handleClearFilterTags}
        onToggle={handleToggleFilterTag}
      />
      {loading || !visibleData ? (
        <OfferTableSkeleton count={Math.min(Math.max(total, 3), 6)} />
      ) : offerGroups.length ? (
        isDesktop === false ? (
          <section className="mt-5 grid gap-3 md:hidden">
            {offerGroups.map((group) => group.offerCount > 1 ? (
              <OfferGroupListItem
                key={group.key}
                group={group}
                onFeedback={setFeedbackOffer}
                onRequestPurchase={setOutboundOffer}
              />
            ) : (
              <OfferListItem
                key={group.key}
                offer={group.representative}
                onFeedback={setFeedbackOffer}
                onRequestPurchase={setOutboundOffer}
              />
            ))}
          </section>
        ) : (
          <OfferTable groups={offerGroups} onFeedback={setFeedbackOffer} onRequestPurchase={setOutboundOffer} />
        )
      ) : (
        <EmptyOfferFilterState onClear={clearOfferFilters} />
      )}
      {hasMore ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={loadMoreOffers}
            disabled={paging}
            aria-busy={paging}
            className="inline-flex h-10 items-center justify-center rounded-full bg-[#e4e9ea] px-4 text-sm font-semibold text-[#2d3435] transition hover:bg-[#dde4e5] disabled:opacity-60"
          >
            {paging ? "正在加载更多报价..." : `继续加载报价 (${offers.length}/${total})`}
          </button>
        </div>
      ) : null}
      {feedbackOffer ? (
        <OfferFeedbackDialog
          productId={productId}
          productSlug={productSlug}
          productName={productName}
          offer={feedbackOffer}
          onClose={() => setFeedbackOffer(null)}
        />
      ) : null}
      {outboundOffer ? (
        <OfferExitNoticeDialog offer={outboundOffer} onClose={() => setOutboundOffer(null)} />
      ) : null}
    </>
  );
}

function DegradedBanner({ message }: { message?: string | null }) {
  return (
    <div className="mt-6 rounded-lg bg-[#fff2ef] px-5 py-4 text-sm text-[#7b2f26] ring-1 ring-[#efd0ca]">
      {message || "真实报价数据暂时不可用，请稍后刷新。"}
    </div>
  );
}

function InlineErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-lg bg-[#fff7e8] px-4 py-3 text-sm font-medium text-[#6a4b16] ring-1 ring-[#efdfbd]">
      {message}。已保留当前报价，可稍后重试或切换筛选条件。
    </div>
  );
}

async function fetchProductOfferPage(
  productId: string,
  offset: number,
  filterTags: OfferFilterTagId[] = [],
  query = "",
  excludeQuery = "",
  collector: MerchantCollectorFilter = "all",
  minPrice = "",
  maxPrice = "",
  minStock: ProductOfferStockThreshold | null = null,
  freshWithinMinutes: ProductOfferFreshnessMinutes | null = null,
  signal?: AbortSignal,
): Promise<ProductOffersResponse> {
  const params = new URLSearchParams({
    limit: String(OFFER_PAGE_SIZE),
    offset: String(offset),
  });
  if (filterTags.length) params.set("tags", filterTags.join(","));
  if (query) params.set("q", query);
  if (excludeQuery) params.set("exclude", excludeQuery);
  if (collector !== "all") params.set("collector", collector);
  if (minPrice) params.set("min", minPrice);
  if (maxPrice) params.set("max", maxPrice);
  if (minStock !== null) params.set("minStock", String(minStock));
  if (freshWithinMinutes !== null) params.set("freshWithin", String(freshWithinMinutes));
  const response = await fetch(`/api/products/${encodeURIComponent(productId)}/offers?${params.toString()}`, {
    signal,
  });

  if (!response.ok) throw new Error("报价加载失败");

  return (await response.json()) as ProductOffersResponse;
}

function productOffersCacheKey(
  productId: string,
  offset: number,
  filterTags: OfferFilterTagId[] = [],
  query = "",
  excludeQuery = "",
  collector: MerchantCollectorFilter = "all",
  minPrice = "",
  maxPrice = "",
  minStock: ProductOfferStockThreshold | null = null,
  freshWithinMinutes: ProductOfferFreshnessMinutes | null = null,
): string {
  return `priceai:product-offers:v16-operational:${productId}:${offset}:${OFFER_PAGE_SIZE}:${filterTags.join(",") || "all"}:${query || "none"}:${excludeQuery || "none"}:${collector}:${minPrice || "none"}:${maxPrice || "none"}:${minStock ?? "none"}:${freshWithinMinutes ?? "none"}`;
}

function productOfferFilterFacets(
  activeFacets: OfferFilterTagFacet[] | undefined,
  cachedFacets: OfferFilterTagFacet[] | undefined,
  initialFacets: OfferFilterTagFacet[] | undefined,
  selectedTags: OfferFilterTagId[],
): OfferFilterTagFacet[] {
  const facets = firstProductOfferFilterFacets(activeFacets, cachedFacets, initialFacets);
  if (selectedTags.length === 0) return facets;

  const visibleFacetIds = new Set(facets.map((facet) => facet.id));
  const missingSelectedFacets = selectedTags.flatMap((tagId) => {
    if (visibleFacetIds.has(tagId)) return [];

    const facet = OFFER_FILTER_TAG_BY_ID.get(tagId);
    return facet ? [{ ...facet, count: 0 }] : [];
  });

  return missingSelectedFacets.length > 0 ? [...facets, ...missingSelectedFacets] : facets;
}

function firstProductOfferFilterFacets(...candidates: Array<OfferFilterTagFacet[] | undefined>) {
  return candidates.find((candidate) => candidate && candidate.length > 0) ?? [];
}

function isPurchaseTermsMockEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (typeof window === "undefined") return false;

  return new URL(window.location.href).searchParams.get("mockPurchaseTerms") === "1";
}

function disabledPurchaseTermsMockSnapshot(): boolean {
  return false;
}

function subscribePurchaseTermsMock(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function withPurchaseTermsMock(data: ProductOffersResponse | null): ProductOffersResponse | null {
  if (!data?.offers.length) return data;

  return {
    ...data,
    offers: data.offers.map((offer, index) => {
      if (index === 0) {
        return {
          ...offer,
          minOrderQuantity: 10,
          bulkPricingTiers: [
            { minQuantity: 10, value: Math.max(0, Number(((offer.price ?? 0) * 0.96).toFixed(2))), discountType: 1 },
            { minQuantity: 50, value: Math.max(0, Number(((offer.price ?? 0) * 0.9).toFixed(2))), discountType: 1 },
          ],
        };
      }

      if (index === 1) {
        return {
          ...offer,
          minOrderQuantity: 5,
          bulkPricingTiers: offer.bulkPricingTiers?.length ? offer.bulkPricingTiers : [],
        };
      }

      return offer;
    }),
  };
}

function rememberProductOffers(cacheKey: string, value: ProductOffersResponse) {
  productOffersMemoryCache.delete(cacheKey);
  productOffersMemoryCache.set(cacheKey, value);

  while (productOffersMemoryCache.size > PRODUCT_OFFERS_MEMORY_CACHE_LIMIT) {
    const oldestKey = productOffersMemoryCache.keys().next().value;
    if (!oldestKey) break;
    productOffersMemoryCache.delete(oldestKey);
  }
}

function rememberHealthyProductOffers(cacheKey: string, value: ProductOffersResponse) {
  if (value.degraded) return;

  rememberProductOffers(cacheKey, value);
  writeSessionCache(cacheKey, value);
}

function normalizeOfferSearchQuery(value: string, limit = 80): string {
  return value.trim().slice(0, limit);
}

function normalizeOfferPriceInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return "";
  return String(parsed);
}

function readOfferFiltersFromUrl(): {
  tags: string | null;
  query: string;
  excludeQuery: string;
  collector: string | null;
  minPrice: string;
  maxPrice: string;
  minStock: string | null;
  freshWithinMinutes: string | null;
} | null {
  if (typeof window === "undefined") return null;

  const params = new URL(window.location.href).searchParams;
  return {
    tags: params.get("tags"),
    query: params.get("q") || "",
    excludeQuery: params.get("exclude") || "",
    collector: params.get("collector"),
    minPrice: params.get("min") || "",
    maxPrice: params.get("max") || "",
    minStock: params.get("minStock"),
    freshWithinMinutes: params.get("freshWithin"),
  };
}

function syncOfferFiltersToUrl(
  filterTags: OfferFilterTagId[],
  query: string,
  excludeQuery: string,
  collector: MerchantCollectorFilter,
  minPrice: string,
  maxPrice: string,
  minStock: ProductOfferStockThreshold | null,
  freshWithinMinutes: ProductOfferFreshnessMinutes | null,
) {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  if (filterTags.length) {
    url.searchParams.set("tags", filterTags.join(","));
  } else {
    url.searchParams.delete("tags");
  }
  const normalizedQuery = normalizeOfferSearchQuery(query);
  if (normalizedQuery) {
    url.searchParams.set("q", normalizedQuery);
  } else {
    url.searchParams.delete("q");
  }
  const normalizedExcludeQuery = normalizeOfferSearchQuery(excludeQuery, 160);
  if (normalizedExcludeQuery) {
    url.searchParams.set("exclude", normalizedExcludeQuery);
  } else {
    url.searchParams.delete("exclude");
  }
  if (collector !== "all") {
    url.searchParams.set("collector", collector);
  } else {
    url.searchParams.delete("collector");
  }
  const normalizedMinPrice = normalizeOfferPriceInput(minPrice);
  if (normalizedMinPrice) {
    url.searchParams.set("min", normalizedMinPrice);
  } else {
    url.searchParams.delete("min");
  }
  const normalizedMaxPrice = normalizeOfferPriceInput(maxPrice);
  if (normalizedMaxPrice) {
    url.searchParams.set("max", normalizedMaxPrice);
  } else {
    url.searchParams.delete("max");
  }
  if (minStock !== null) {
    url.searchParams.set("minStock", String(minStock));
  } else {
    url.searchParams.delete("minStock");
  }
  if (freshWithinMinutes !== null) {
    url.searchParams.set("freshWithin", String(freshWithinMinutes));
  } else {
    url.searchParams.delete("freshWithin");
  }

  window.history.replaceState(window.history.state, "", url);
}

function OfferFilterBar({
  productId,
  facets,
  selectedTags,
  selectedCollector,
  selectedMinStock,
  selectedFreshWithinMinutes,
  total,
  active,
  pending,
  excludeInput,
  activeExcludeQuery,
  filterOpen,
  maxPriceInput,
  minPriceInput,
  activeMaxPrice,
  activeMinPrice,
  queryInput,
  activeQuery,
  onClear,
  onCollectorChange,
  onExcludeInputChange,
  onFilterOpenChange,
  onMaxPriceInputChange,
  onMinPriceInputChange,
  onMinStockChange,
  onFreshWithinChange,
  onApply,
  onClearTags,
  onSearchInputChange,
  onSearchSubmit,
  onToggle,
}: {
  productId: string;
  facets: OfferFilterTagFacet[];
  selectedTags: OfferFilterTagId[];
  selectedCollector: MerchantCollectorFilter;
  selectedMinStock: ProductOfferStockThreshold | null;
  selectedFreshWithinMinutes: ProductOfferFreshnessMinutes | null;
  total: number;
  active: boolean;
  pending: boolean;
  excludeInput: string;
  activeExcludeQuery: string;
  filterOpen: boolean;
  maxPriceInput: string;
  minPriceInput: string;
  activeMaxPrice: string;
  activeMinPrice: string;
  queryInput: string;
  activeQuery: string;
  onClear: () => void;
  onCollectorChange: (collector: MerchantCollectorFilter) => void;
  onExcludeInputChange: (value: string) => void;
  onFilterOpenChange: (open: boolean) => void;
  onMaxPriceInputChange: (value: string) => void;
  onMinPriceInputChange: (value: string) => void;
  onMinStockChange: (value: ProductOfferStockThreshold | null) => void;
  onFreshWithinChange: (value: ProductOfferFreshnessMinutes | null) => void;
  onApply: () => void;
  onClearTags: (tagIds: OfferFilterTagId[]) => void;
  onSearchInputChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (tagId: OfferFilterTagId) => void;
}) {
  const facetById = new Map(facets.map((facet) => [facet.id, facet]));
  const pinnedQuickTagIds = productId === "chatgpt-plus" ? new Set(CHATGPT_PLUS_QUICK_FILTER_TAG_IDS) : null;
  const visibleFacets = Array.from(OFFER_FILTER_TAG_BY_ID.values())
    .flatMap((definition) => {
      if (productId === "chatgpt-plus" && isChatGptPlusChannelFilterTag(definition.id)) return [];
      const facet = facetById.get(definition.id);
      if (facet) return [facet];
      return pinnedQuickTagIds?.has(definition.id) ? [{ ...definition, count: 0 }] : [];
    });
  const plusChannelFacets = productId === "chatgpt-plus"
    ? Array.from(OFFER_FILTER_TAG_BY_ID.values()).flatMap((definition) => {
        const facet = facetById.get(definition.id);
        return facet && isChatGptPlusChannelFilterTag(definition.id) ? [facet] : [];
      })
    : [];
  const advancedTagIds = new Set(plusChannelFacets.map((facet) => facet.id));
  const stockQuickActive = selectedMinStock === PRODUCT_OFFER_QUICK_STOCK_THRESHOLD;
  const freshnessQuickActive = selectedFreshWithinMinutes === PRODUCT_OFFER_QUICK_FRESHNESS_MINUTES;
  const activeAdvancedChips = buildOfferActiveFilterChips({
    selectedTags: selectedTags.filter((tagId) => advancedTagIds.has(tagId)),
    selectedCollector,
    queryInput: activeQuery,
    excludeInput: activeExcludeQuery,
    minPriceInput: activeMinPrice,
    maxPriceInput: activeMaxPrice,
  });
  const advancedFilterCount = activeAdvancedChips.length + Number(stockQuickActive) + Number(freshnessQuickActive);

  return (
    <section className="mt-3 border-y border-[#e5eaea] py-3 md:mt-5">
      <div className="flex items-start justify-between gap-3 lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onFilterOpenChange(!filterOpen)}
              aria-expanded={filterOpen}
              className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition ${
                filterOpen || advancedFilterCount > 0
                  ? "bg-[#202829] text-white"
                  : "bg-[#eef1f1] text-[#4d5657] hover:bg-[#e3e9e9] hover:text-[#202829]"
              }`}
            >
              <Filter size={15} />
              筛选{advancedFilterCount ? ` ${advancedFilterCount}` : ""}
            </button>
            <span className="text-xs text-[#7a8587]">{pending ? "正在加载" : active ? `当前 ${total} 条` : `${total} 条报价`}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2" aria-label="库存与更新时间快捷筛选">
            <button
              type="button"
              onClick={() => onMinStockChange(stockQuickActive ? null : PRODUCT_OFFER_QUICK_STOCK_THRESHOLD)}
              aria-pressed={stockQuickActive}
              title="只看库存数量达到所选下限的报价；库存未知不会进入结果"
              className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#adb3b4]/50 ${
                stockQuickActive
                  ? "bg-[#202829] text-white"
                  : "bg-[#eef1f1] text-[#4d5657] hover:bg-[#e3e9e9] hover:text-[#202829]"
              }`}
            >
              <Boxes size={14} />
              库存 ≥50
            </button>
            <button
              type="button"
              onClick={() => onFreshWithinChange(freshnessQuickActive ? null : PRODUCT_OFFER_QUICK_FRESHNESS_MINUTES)}
              aria-pressed={freshnessQuickActive}
              title="按 PriceAI 最近成功确认时间筛选"
              className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#adb3b4]/50 ${
                freshnessQuickActive
                  ? "bg-[#202829] text-white"
                  : "bg-[#eef1f1] text-[#4d5657] hover:bg-[#e3e9e9] hover:text-[#202829]"
              }`}
            >
              <Clock3 size={14} />
              1小时内更新
            </button>
          </div>
          {visibleFacets.length ? (
            <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0" aria-label="商品特征">
              {visibleFacets.map((facet) => {
                const selected = selectedTags.includes(facet.id);

                return (
                  <button
                    key={facet.id}
                    type="button"
                    onClick={() => onToggle(facet.id)}
                    aria-pressed={selected}
                    title={facet.description}
                    className={`inline-flex h-8 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold transition ${
                      selected
                        ? "bg-[#202829] text-white"
                        : "bg-[#eef1f1] text-[#4d5657] hover:bg-[#e3e9e9] hover:text-[#202829]"
                    }`}
                  >
                    {facet.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {activeAdvancedChips.length ? (
            <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0" aria-label="当前筛选条件">
              {activeAdvancedChips.map((chip) => (
                <span key={chip} className="inline-flex h-7 max-w-[190px] items-center rounded-full bg-[#eef1f1] px-2.5 text-xs font-semibold text-[#4d5657]">
                  <span className="truncate">{chip}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {active ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-transparent px-2 text-xs font-semibold text-[#6c7677] transition hover:bg-[#eef1f1] hover:text-[#202829]"
          >
            <X size={13} />
            清除
          </button>
        ) : null}
      </div>

      {filterOpen ? (
        <form onSubmit={onSearchSubmit} className="mt-3 hidden rounded-lg bg-white p-3 ring-1 ring-[#adb3b4]/15 md:block">
          <OfferAdvancedFilterFields
            plusChannelFacets={plusChannelFacets}
            selectedTags={selectedTags}
            selectedCollector={selectedCollector}
            excludeInput={excludeInput}
            maxPriceInput={maxPriceInput}
            minPriceInput={minPriceInput}
            queryInput={queryInput}
            onCollectorChange={onCollectorChange}
            onExcludeInputChange={onExcludeInputChange}
            onMaxPriceInputChange={onMaxPriceInputChange}
            onMinPriceInputChange={onMinPriceInputChange}
            onClearTags={onClearTags}
            onSearchInputChange={onSearchInputChange}
            onToggleTag={onToggle}
          />
        </form>
      ) : null}

      <MobileFilterSheet
        open={filterOpen}
        title="筛选渠道报价"
        description="来源、价格和关键词可组合筛选；库存与更新时间使用顶部快捷标签。"
        resultCount={total}
        onClose={() => onFilterOpenChange(false)}
        onReset={onClear}
        onApply={onApply}
        primaryLabel="应用筛选"
      >
        <OfferAdvancedFilterFields
          compact
          plusChannelFacets={plusChannelFacets}
          selectedTags={selectedTags}
          selectedCollector={selectedCollector}
          excludeInput={excludeInput}
          maxPriceInput={maxPriceInput}
          minPriceInput={minPriceInput}
          queryInput={queryInput}
          onCollectorChange={onCollectorChange}
          onExcludeInputChange={onExcludeInputChange}
          onMaxPriceInputChange={onMaxPriceInputChange}
          onMinPriceInputChange={onMinPriceInputChange}
          onClearTags={onClearTags}
          onSearchInputChange={onSearchInputChange}
          onToggleTag={onToggle}
        />
      </MobileFilterSheet>
    </section>
  );
}

function OfferAdvancedFilterFields({
  compact = false,
  plusChannelFacets = [],
  selectedTags,
  selectedCollector,
  excludeInput,
  maxPriceInput,
  minPriceInput,
  queryInput,
  onCollectorChange,
  onExcludeInputChange,
  onClearTags,
  onMaxPriceInputChange,
  onMinPriceInputChange,
  onSearchInputChange,
  onToggleTag,
}: {
  compact?: boolean;
  plusChannelFacets?: OfferFilterTagFacet[];
  selectedTags: OfferFilterTagId[];
  selectedCollector: MerchantCollectorFilter;
  excludeInput: string;
  maxPriceInput: string;
  minPriceInput: string;
  queryInput: string;
  onCollectorChange: (collector: MerchantCollectorFilter) => void;
  onExcludeInputChange: (value: string) => void;
  onClearTags: (tagIds: OfferFilterTagId[]) => void;
  onMaxPriceInputChange: (value: string) => void;
  onMinPriceInputChange: (value: string) => void;
  onSearchInputChange: (value: string) => void;
  onToggleTag: (tagId: OfferFilterTagId) => void;
}) {
  const plusChannelTagIds = plusChannelFacets.map((facet) => facet.id);
  const hasSelectedPlusChannel = plusChannelTagIds.some((tagId) => selectedTags.includes(tagId));

  return (
    <div className="space-y-4">
      <fieldset className="min-w-0">
        <legend className="text-xs font-semibold text-[#5a6061]">渠道来源</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {MERCHANT_COLLECTOR_FILTERS.map((collector) => {
            const selected = selectedCollector === collector;
            const logo = merchantCollectorFilterLogo(collector);
            return (
              <button
                key={collector}
                type="button"
                onClick={() => onCollectorChange(collector)}
                className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition ${
                  selected
                    ? "bg-[#202829] text-white"
                    : "bg-[#eef1f1] text-[#4d5657] hover:bg-[#e3e9e9] hover:text-[#202829]"
                }`}
              >
                {logo ? <CollectorSourceLogo group={logo.group} platformId={logo.platformId} size="compact" /> : null}
                {merchantCollectorLabel(collector)}
              </button>
            );
          })}
        </div>
      </fieldset>

      {plusChannelFacets.length ? (
        <fieldset className="min-w-0 border-t border-[#edf0f1] pt-4">
          <legend className="text-xs font-semibold text-[#5a6061]">Plus 渠道</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onClearTags(plusChannelTagIds)}
              aria-pressed={!hasSelectedPlusChannel}
              className={`inline-flex h-9 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold transition ${
                !hasSelectedPlusChannel
                  ? "bg-[#202829] text-white"
                  : "bg-[#eef1f1] text-[#4d5657] hover:bg-[#e3e9e9] hover:text-[#202829]"
              }`}
            >
              全部渠道
            </button>
            {plusChannelFacets.map((facet) => {
              const selected = selectedTags.includes(facet.id);

              return (
                <button
                  key={facet.id}
                  type="button"
                  onClick={() => onToggleTag(facet.id)}
                  aria-pressed={selected}
                  title={facet.description}
                  className={`inline-flex h-9 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold transition ${
                    selected
                      ? "bg-[#202829] text-white"
                      : "bg-[#eef1f1] text-[#4d5657] hover:bg-[#e3e9e9] hover:text-[#202829]"
                  }`}
                >
                  {facet.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className={compact ? "space-y-4 border-t border-[#edf0f1] pt-4" : "grid gap-4 border-t border-[#edf0f1] pt-3 lg:grid-cols-[minmax(260px,0.8fr)_minmax(360px,1.15fr)_auto] lg:items-end"}>
        <fieldset className="min-w-0">
          <legend className="text-xs font-semibold text-[#5a6061]">价格区间</legend>
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <PriceFilterInput value={minPriceInput} onChange={onMinPriceInputChange} label="最低价" />
            <span className="text-xs font-semibold text-[#7a8587]">至</span>
            <PriceFilterInput value={maxPriceInput} onChange={onMaxPriceInputChange} label="最高价" />
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-xs font-semibold text-[#5a6061]">报价关键词</legend>
          <div className={`mt-2 grid min-w-0 grid-cols-1 gap-2 ${compact ? "" : "sm:grid-cols-2"}`}>
            <TextFilterInput label="包含" value={queryInput} onChange={onSearchInputChange} placeholder="关键词、渠道、商品名" />
            <TextFilterInput label="排除" value={excludeInput} onChange={onExcludeInputChange} placeholder="网页、无质保、日抛" danger />
          </div>
        </fieldset>

        {compact ? null : (
          <button
            type="submit"
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-[#202829] px-4 text-sm font-semibold text-white transition hover:opacity-90"
          >
            应用筛选
          </button>
        )}
      </div>
    </div>
  );
}

function PriceFilterInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <label className="relative min-w-0">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#7a8587]">¥</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        aria-label={label}
        placeholder={label}
        className="h-9 w-full rounded-full bg-[#f9fbfb] pl-7 pr-3 text-sm text-[#202829] outline-none ring-1 ring-[#dbe2e3] transition placeholder:text-[#7d8789] focus:ring-2 focus:ring-[#adb3b4]/35"
      />
    </label>
  );
}

function TextFilterInput({
  label,
  value,
  onChange,
  placeholder,
  danger = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  danger?: boolean;
}) {
  return (
    <label className="relative min-w-0">
      <span className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold ${danger ? "text-[#9b3328]" : "text-[#7a8587]"}`}>
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-full bg-[#f9fbfb] pl-12 pr-3 text-sm text-[#202829] outline-none ring-1 ring-[#dbe2e3] transition placeholder:text-[#7d8789] focus:ring-2 focus:ring-[#adb3b4]/35"
      />
    </label>
  );
}

function buildOfferActiveFilterChips({
  selectedTags,
  selectedCollector,
  queryInput,
  excludeInput,
  minPriceInput,
  maxPriceInput,
}: {
  selectedTags: OfferFilterTagId[];
  selectedCollector: MerchantCollectorFilter;
  queryInput: string;
  excludeInput: string;
  minPriceInput: string;
  maxPriceInput: string;
}): string[] {
  const chips: string[] = [];
  if (selectedCollector !== "all") chips.push(merchantCollectorLabel(selectedCollector));
  if (minPriceInput || maxPriceInput) chips.push(`¥${minPriceInput || "0"}-${maxPriceInput || "不限"}`);
  if (queryInput) chips.push(`包含：${queryInput}`);
  if (excludeInput) chips.push(`排除：${excludeInput}`);
  for (const tagId of selectedTags) {
    const tag = OFFER_FILTER_TAG_BY_ID.get(tagId);
    if (tag) chips.push(tag.label);
  }
  return chips;
}

function OfferTableSkeleton({ count }: { count: number }) {
  const rows = Array.from({ length: Math.min(Math.max(count, 3), 6) });

  return (
    <>
      <section className="mt-5 grid gap-3 md:hidden">
        {rows.map((_, index) => (
          <div key={index} className="rounded-lg bg-white p-4 shadow-[0_16px_45px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="mt-3 h-4 w-full rounded-full" />
                <Skeleton className="mt-2 h-4 w-3/4 rounded-full" />
              </div>
              <Skeleton className="h-7 w-16 rounded-full" />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <Skeleton className="h-7 w-20 rounded-full" />
                <Skeleton className="mt-2 h-4 w-24 rounded-full" />
              </div>
              <Skeleton className="h-9 w-20 rounded-full" />
            </div>
          </div>
        ))}
      </section>

      <section className="mt-6 hidden overflow-hidden rounded-lg bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15 md:block">
        {rows.map((_, index) => (
          <div key={index} className="grid grid-cols-[90px_205px_1fr_115px_120px_110px_130px_64px] gap-4 border-b border-[#edf0f1] px-5 py-5 last:border-b-0">
            <Skeleton className="h-8 w-16 rounded-full" />
            <div>
              <Skeleton className="h-5 w-32 rounded-full" />
              <Skeleton className="mt-3 h-4 w-24 rounded-full" />
            </div>
            <Skeleton className="h-5 w-full rounded-full" />
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-8 w-20 rounded-full" />
            <Skeleton className="h-9 w-24 rounded-full" />
            <Skeleton className="h-9 w-9 rounded-full" />
          </div>
        ))}
      </section>
    </>
  );
}

function Skeleton({ className }: { className: string }) {
  return <div className={`bg-[#e4e9ea] ${className}`} />;
}

function EmptyOfferFilterState({ onClear }: { onClear: () => void }) {
  return (
    <div className="mt-6 rounded-lg bg-white px-5 py-8 text-center shadow-[0_18px_45px_rgba(45,52,53,0.035)] ring-1 ring-[#adb3b4]/15">
      <p className="text-sm font-semibold text-[#202829]">没有匹配的报价</p>
      <p className="mt-2 text-sm text-[#5a6061]">换一组标签，或回到全部报价继续查看。</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 inline-flex h-9 items-center justify-center rounded-full bg-[#202829] px-4 text-sm font-semibold text-white transition hover:opacity-90"
      >
        查看全部报价
      </button>
    </div>
  );
}

function OfferTable({
  groups,
  onFeedback,
  onRequestPurchase,
}: {
  groups: SameTitleOfferGroup<RawOffer>[];
  onFeedback: (offer: RawOffer) => void;
  onRequestPurchase: (offer: RawOffer) => void;
}) {
  return (
    <section className="mt-6 hidden overflow-hidden rounded-lg bg-white shadow-[0_20px_55px_rgba(45,52,53,0.045)] ring-1 ring-[#adb3b4]/15 md:block">
      <div className="overflow-x-auto">
        <table className="min-w-[1200px] w-full table-fixed border-collapse text-left text-sm">
          <colgroup>
            <col className="w-[112px]" />
            <col className="w-[240px]" />
            <col />
            <col className="w-[118px]" />
            <col className="w-[112px]" />
            <col className="w-[118px]" />
            <col className="w-[130px]" />
            <col className="w-[108px]" />
          </colgroup>
          <thead className="bg-[#f2f4f4] text-[0.68rem] font-semibold text-[#5a6061]">
            <tr>
              <TableHead>库存</TableHead>
              <TableHead>渠道</TableHead>
              <TableHead>原始商品名</TableHead>
              <TableHead>价格</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead className="text-center">风险</TableHead>
              <TableHead className="text-center">操作</TableHead>
              <TableHead className="text-center">反馈</TableHead>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#edf0f1]">
            {groups.map((group) => group.offerCount > 1 ? (
              <OfferTableGroup
                key={group.key}
                group={group}
                onFeedback={onFeedback}
                onRequestPurchase={onRequestPurchase}
              />
            ) : (
              <OfferTableRow
                key={group.key}
                offer={group.representative}
                onFeedback={onFeedback}
                onRequestPurchase={onRequestPurchase}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OfferTableGroup({
  group,
  onFeedback,
  onRequestPurchase,
}: {
  group: SameTitleOfferGroup<RawOffer>;
  onFeedback: (offer: RawOffer) => void;
  onRequestPurchase: (offer: RawOffer) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const offer = group.representative;
  const available = isOfferAvailable(offer);
  const sharedAccess = isSharedAccessOffer(offer);
  const collectorGroup = merchantCollectorGroup(offer.collectorKind);
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: offer.collectorKind,
    sourceId: offer.sourceId,
    sourceName: offer.sourceName,
    sourceStoreName: offer.sourceStoreName,
    url: offer.url,
  });
  const detailsId = `offer-group-${offer.id}`;

  return (
    <>
      <tr className={`transition hover:bg-[#f7f9f9] ${available ? "" : "bg-[#fbf7f6]"}`}>
        <td className="px-5 py-4"><OfferInventorySummary offer={offer} available={available} /></td>
        <td className="px-4 py-4">
          <span className="flex min-w-0 items-center gap-2">
            <CollectorSourceLogo group={collectorGroup} platformId={sourcePlatform.id} size="compact" />
            <span className="min-w-0 max-w-full">
              <OfferMerchantLink offer={offer} mode="table" />
              <span className="mt-1 block truncate text-xs text-[#5a6061]">最低价渠道 · 共 {group.merchantCount} 家</span>
            </span>
          </span>
        </td>
        <td className="px-5 py-4">
          <OfferSourceTitle title={group.title} mode="table" sharedAccess={sharedAccess} />
          <span className="mt-1 block text-[0.68rem] font-semibold text-[#7a8587]">同名报价 {group.offerCount} 条</span>
        </td>
        <td className="px-4 py-4">
          <span className="block text-lg font-bold tabular-nums text-[#202829]">
            {formatCurrency(offer.price, offer.currency)} <span className="text-xs font-semibold text-[#5a6061]">起</span>
          </span>
          <OfferPurchaseTerms offer={offer} available={available} className="mt-1" />
        </td>
        <td className="whitespace-nowrap px-4 py-4 text-[#5a6061]">
          <OfferRelativeTime value={group.latestAt} />
        </td>
        <td className="px-3 py-3 text-center"><OfferRiskCell offer={offer} /></td>
        <td className="px-3 py-3 text-center">
          <OfferLink offer={offer} available={available} compact onRequestPurchase={onRequestPurchase} />
        </td>
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
      {expanded ? group.items.map((item, index) => (
        <OfferTableRow
          key={offerRowKey(item, index)}
          offer={item}
          onFeedback={onFeedback}
          onRequestPurchase={onRequestPurchase}
          grouped
          rowId={index === 0 ? detailsId : undefined}
        />
      )) : null}
    </>
  );
}

function OfferTableRow({
  offer,
  onFeedback,
  onRequestPurchase,
  grouped = false,
  rowId,
}: {
  offer: RawOffer;
  onFeedback: (offer: RawOffer) => void;
  onRequestPurchase: (offer: RawOffer) => void;
  grouped?: boolean;
  rowId?: string;
}) {
  const available = isOfferAvailable(offer);
  const sharedAccess = isSharedAccessOffer(offer);
  const collectorGroup = merchantCollectorGroup(offer.collectorKind);
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: offer.collectorKind,
    sourceId: offer.sourceId,
    sourceName: offer.sourceName,
    sourceStoreName: offer.sourceStoreName,
    url: offer.url,
  });

  return (
    <tr
      id={rowId}
      className={`group/row transition ${grouped ? "bg-[#eef3f8] hover:bg-[#e7eef4]" : available ? "hover:bg-[#f7f9f9]" : "bg-[#fbf7f6] hover:bg-[#f8efed]"}`}
    >
      <td className="px-5 py-4"><OfferInventorySummary offer={offer} available={available} /></td>
      <td className="px-4 py-4">
        <span className="flex min-w-0 items-center gap-2">
          <CollectorSourceLogo group={collectorGroup} platformId={sourcePlatform.id} size="compact" />
          <span className="min-w-0 max-w-full">
            <OfferMerchantLink offer={offer} mode="table" />
            {sourceSecondaryLabel(offer) ? <span className="mt-1 block truncate text-xs text-[#5a6061]">{sourceSecondaryLabel(offer)}</span> : null}
            <OfferMerchantTimeSummary offer={offer} />
          </span>
        </span>
      </td>
      <td className="px-5 py-4"><OfferSourceTitle title={offer.sourceTitle} mode="table" sharedAccess={sharedAccess} /></td>
      <td className="px-4 py-4"><OfferPriceCell offer={offer} available={available} /></td>
      <td className="whitespace-nowrap px-4 py-4 text-[#5a6061]"><OfferRelativeTime value={offerTimestamp(offer)} /></td>
      <td className="px-3 py-3 text-center"><OfferRiskCell offer={offer} /></td>
      <td className="px-3 py-3 text-center"><OfferLink offer={offer} available={available} compact onRequestPurchase={onRequestPurchase} /></td>
      <td className="px-3 py-3 text-center"><OfferFeedbackButton offer={offer} onFeedback={onFeedback} compact /></td>
    </tr>
  );
}

function OfferListItem({
  offer,
  onFeedback,
  onRequestPurchase,
}: {
  offer: RawOffer;
  onFeedback: (offer: RawOffer) => void;
  onRequestPurchase: (offer: RawOffer) => void;
}) {
  const available = isOfferAvailable(offer);
  const sharedAccess = isSharedAccessOffer(offer);
  const hasRisk = Boolean(offer.riskFeedback?.count);
  const collectorGroup = merchantCollectorGroup(offer.collectorKind);
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: offer.collectorKind,
    sourceId: offer.sourceId,
    sourceName: offer.sourceName,
    sourceStoreName: offer.sourceStoreName,
    url: offer.url,
  });

  return (
    <article
      className={`min-w-0 rounded-lg px-4 py-3.5 ring-1 ${
        available ? "bg-white ring-[#adb3b4]/15" : "bg-[#fbf7f6] ring-[#ead8d5]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <CollectorSourceLogo group={collectorGroup} platformId={sourcePlatform.id} size="compact" />
          <div className="min-w-0">
            <OfferMerchantLink offer={offer} mode="card" />
            <OfferSourceTitle title={offer.sourceTitle} mode="card" sharedAccess={sharedAccess} />
            <OfferMerchantTimeSummary offer={offer} />
            {hasRisk ? (
              <div className="mt-2">
                <OfferRiskButton offer={offer} compact />
              </div>
            ) : null}
          </div>
        </div>
        <OfferInventorySummary offer={offer} available={available} compact />
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-end gap-x-2 gap-y-1">
          <p className={`text-2xl font-bold leading-none tracking-normal ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>
            {formatCurrency(offer.price, offer.currency)}
          </p>
          <OfferPurchaseTerms offer={offer} available={available} />
          <p className="text-xs font-medium text-[#5a6061]">
            <OfferRelativeTime value={offerTimestamp(offer)} />
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <OfferActions offer={offer} available={available} onFeedback={onFeedback} onRequestPurchase={onRequestPurchase} />
        </div>
      </div>
    </article>
  );
}

function OfferGroupListItem({
  group,
  onFeedback,
  onRequestPurchase,
}: {
  group: SameTitleOfferGroup<RawOffer>;
  onFeedback: (offer: RawOffer) => void;
  onRequestPurchase: (offer: RawOffer) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const offer = group.representative;
  const available = isOfferAvailable(offer);
  const sharedAccess = isSharedAccessOffer(offer);
  const collectorGroup = merchantCollectorGroup(offer.collectorKind);
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: offer.collectorKind,
    sourceId: offer.sourceId,
    sourceName: offer.sourceName,
    sourceStoreName: offer.sourceStoreName,
    url: offer.url,
  });
  const detailsId = `mobile-offer-group-${offer.id}`;

  return (
    <section className="min-w-0">
      <article className={`min-w-0 rounded-lg px-4 py-3.5 ring-1 ${available ? "bg-white ring-[#adb3b4]/15" : "bg-[#fbf7f6] ring-[#ead8d5]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <CollectorSourceLogo group={collectorGroup} platformId={sourcePlatform.id} size="compact" />
            <div className="min-w-0">
              <OfferMerchantLink offer={offer} mode="card" />
              <p className="mt-0.5 truncate text-xs text-[#5a6061]">最低价渠道 · 共 {group.merchantCount} 家</p>
              <OfferSourceTitle title={group.title} mode="card" sharedAccess={sharedAccess} />
              <p className="mt-1 text-xs font-semibold text-[#5a6061]">同名报价 {group.offerCount} 条</p>
              {offer.riskFeedback?.count ? <div className="mt-2"><OfferRiskButton offer={offer} /></div> : null}
            </div>
          </div>
          <OfferInventorySummary offer={offer} available={available} compact />
        </div>
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
          <div className="min-w-0">
            <p className={`text-2xl font-bold leading-none tracking-normal tabular-nums ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>
              {formatCurrency(offer.price, offer.currency)} <span className="text-xs font-semibold text-[#5a6061]">起</span>
            </p>
            <p className="mt-1 text-xs text-[#5a6061]"><OfferRelativeTime value={group.latestAt} /></p>
          </div>
          <OfferLink offer={offer} available={available} compact onRequestPurchase={onRequestPurchase} />
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
        <div id={detailsId} className="mt-2 grid gap-2 rounded-lg bg-[#eef3f8] p-2">
          {group.items.map((item, index) => (
            <OfferListItem
              key={offerRowKey(item, index)}
              offer={item}
              onFeedback={onFeedback}
              onRequestPurchase={onRequestPurchase}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function offerRowKey(offer: RawOffer, index: number): string {
  return `${offer.id}:${offer.url}:${index}`;
}

function TableHead({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-5 py-3 font-semibold ${className}`}>{children}</th>;
}

function OfferSourceTitle({ title, mode, sharedAccess }: { title: string; mode: "table" | "card"; sharedAccess?: boolean }) {
  if (mode === "table") {
    return (
      <span className="block leading-6 text-[#2d3435]" title={title} aria-label={`原始商品名：${title}`}>
        {sharedAccess ? <OfferSharedAccessBadge /> : null}
        <span className="line-clamp-2">{title}</span>
      </span>
    );
  }

  return (
    <p className="mt-1 text-sm leading-5 text-[#5a6061]" title={title}>
      {sharedAccess ? <OfferSharedAccessBadge /> : null}
      <span className="line-clamp-2 min-h-10">{title}</span>
    </p>
  );
}

function OfferSharedAccessBadge() {
  return (
    <span className="mb-1 mr-1.5 inline-flex shrink-0 items-center rounded-full bg-[#fff7df] px-2 py-0.5 text-[0.68rem] font-semibold leading-5 text-[#8a5a10] ring-1 ring-[#efd38a]">
      拼车/团购
    </span>
  );
}

function OfferRiskCell({ offer }: { offer: RawOffer }) {
  if (!offer.riskFeedback?.count) {
    return <span aria-hidden="true" className="block h-8" />;
  }

  return <OfferRiskButton offer={offer} />;
}

export function OfferRiskButton({ offer, compact = false }: { offer: RawOffer; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const risk = offer.riskFeedback;
  if (!risk?.count) return null;

  const sourceOnly = risk.scope === "source";
  const label = compact
    ? "风险"
    : sourceOnly
      ? "商家风险"
      : risk.scope === "mixed"
        ? "多重风险"
        : "商品风险";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="查看风险详情"
        aria-label={`查看${label}详情`}
        className={`inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold ring-1 transition ${
          compact ? "h-7" : "h-8"
        } ${
          sourceOnly
            ? "bg-[#fff7df] text-[#8a5a10] ring-[#efd38a] hover:bg-[#fff1c7]"
            : "bg-[#fff0ed] text-[#9b3328] ring-[#efc4bc] hover:bg-[#fde5e0]"
        }`}
      >
        <AlertTriangle size={compact ? 14 : 13} />
        <span>{label}</span>
      </button>
      {open ? <OfferRiskDetailDialog offer={offer} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function OfferRiskDetailDialog({ offer, onClose }: { offer: RawOffer; onClose: () => void }) {
  const risk = offer.riskFeedback;
  const titleId = "offer-risk-dialog-title";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (!risk?.count) return null;

  const offerCount = risk.offerCount ?? (risk.scope === "offer" ? risk.count : 0);
  const sourceCount = risk.sourceCount ?? (risk.scope === "source" ? risk.count : 0);
  const reasonLabels = (risk.reasons?.length ? risk.reasons : ["fraud" as const]).map(riskFeedbackReasonLabel);
  const offerSummaries = risk.offerSummaries?.filter(Boolean).slice(0, 3) || [];
  const sourceSummaries = risk.sourceSummaries?.filter(Boolean).slice(0, 3) || [];
  const summaries = offerSummaries.length || sourceSummaries.length
    ? [...offerSummaries, ...sourceSummaries].slice(0, 3)
    : risk.summaries?.filter(Boolean).slice(0, 3) || [];
  const sourceOnly = risk.scope === "source";
  const title = sourceOnly ? "商家临时风险提示" : risk.scope === "mixed" ? "商品与商家临时风险提示" : "商品临时风险提示";
  const scopeSummary = [
    offerCount ? `商品 ${offerCount} 条` : null,
    sourceCount ? `商家 ${sourceCount} 条` : null,
  ].filter(Boolean).join(" / ") || `${risk.count} 条反馈`;
  const description = summaries[0] ||
    "有用户反馈该报价存在需要核验的问题。购买前建议先联系商家确认商品细节、交付方式和售后处理规则。";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#202829]/35 px-4 py-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[460px] rounded-lg bg-white p-5 text-left shadow-[0_24px_80px_rgba(32,40,41,0.22)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full ${
              sourceOnly ? "bg-[#fff7df] text-[#8a5a10]" : "bg-[#fff0ed] text-[#9b3328]"
            }`}>
              <AlertTriangle size={20} />
            </div>
            <h3 id={titleId} className="text-lg font-semibold text-[#202829]">
              {title}
            </h3>
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-[#5a6061]">{offer.sourceTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭风险提示"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#adb3b4]/25 text-[#5a6061] transition hover:bg-[#f2f4f4]"
          >
            <X size={16} />
          </button>
        </div>

        <p className="mt-4 rounded-lg bg-[#f7f9f9] px-3 py-2 text-sm leading-6 text-[#3d4749]">
          {description}
        </p>

        <div className="mt-4 grid gap-2 text-sm">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#edf0f1] px-3 py-2">
            <span className="text-[#6c7677]">当前状态</span>
            <span className="text-right font-semibold text-[#7a541b]">用户反馈，供购买前参考</span>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#edf0f1] px-3 py-2">
            <span className="text-[#6c7677]">风险类型</span>
            <span className="text-right font-semibold text-[#202829]">{Array.from(new Set(reasonLabels)).join("、")}</span>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#edf0f1] px-3 py-2">
            <span className="text-[#6c7677]">反馈范围</span>
            <span className="text-right font-semibold text-[#202829]">
              {scopeSummary}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#edf0f1] px-3 py-2">
            <span className="text-[#6c7677]">最近反馈</span>
            <span className="text-right font-semibold text-[#202829]">
              <OfferRelativeTime value={risk.latestAt} />
            </span>
          </div>
        </div>

        {offerSummaries.length ? (
          <div className="mt-4 rounded-lg border border-[#efd38a] bg-[#fffaf2] px-3 py-2.5">
            <p className="text-xs font-semibold text-[#7a541b]">该商品下的用户反馈摘要</p>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[#5a6061]">
              {offerSummaries.map((summary) => (
                <li key={summary}>• {summary}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {sourceSummaries.length ? (
          <div className="mt-3 rounded-lg border border-[#efc4bc] bg-[#fff7f5] px-3 py-2.5">
            <p className="text-xs font-semibold text-[#9b3328]">该商家的用户反馈摘要</p>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[#5a6061]">
              {sourceSummaries.map((summary) => (
                <li key={summary}>• {summary}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {!offerSummaries.length && !sourceSummaries.length && summaries.length ? (
          <div className="mt-4 rounded-lg border border-[#efd38a] bg-[#fffaf2] px-3 py-2.5">
            <p className="text-xs font-semibold text-[#7a541b]">用户反馈摘要</p>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[#5a6061]">
              {summaries.map((summary) => (
                <li key={summary}>• {summary}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="mt-4 text-xs leading-5 text-[#7a8587]">
          这里展示的是系统预审后的用户高风险反馈摘要，不等同于平台最终裁定。PriceAI 不售卖、不担保商品，购买前仍需你和原店铺确认。
        </p>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-lg bg-[#2d3435] px-4 text-sm font-semibold text-white transition hover:bg-[#202829]"
        >
          知道了
        </button>
      </div>
    </div>
  );
}

function riskFeedbackReasonLabel(reason: "description_mismatch" | "aftersales_shipping" | "bad_source" | "fraud"): string {
  if (reason === "description_mismatch") return "标题党/商家描述误导";
  if (reason === "aftersales_shipping") return "交付/使用/售后问题";
  if (reason === "bad_source") return "渠道不可信";
  return "疑似虚假/欺诈";
}

function OfferExitNoticeDialog({ offer, onClose }: { offer: RawOffer; onClose: () => void }) {
  const [muteToday, setMuteToday] = useState(false);
  const titleId = "offer-exit-notice-title";
  const sourcePlatform = merchantSourcePlatform({
    collectorKind: offer.collectorKind,
    sourceId: offer.sourceId,
    sourceName: offer.sourceName,
    sourceStoreName: offer.sourceStoreName,
    url: offer.url,
  });
  const hostedShopPlatform = sourcePlatform.hasPlatformAftersalesMechanism || isShopApiOffer(offer);
  const hostedShopLabel = sourcePlatform.hasPlatformAftersalesMechanism
    ? sourcePlatform.label
    : "ShopApi";
  const hostedShopExitLabel = sourcePlatform.hasPlatformAftersalesMechanism
    ? sourcePlatform.exitLabel
    : "ShopApi";
  const highRisk = isHighRiskOutboundOffer(offer);
  const highPrice = typeof offer.price === "number" && offer.price >= OFFER_HIGH_RISK_PRICE_THRESHOLD;
  const risks = getOfferRiskHints(offer);
  const primaryCopy = hostedShopPlatform
    ? `我已确认细节，前往${hostedShopExitLabel}`
    : "我会先联系商家，继续前往";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  function continueToOffer() {
    if (muteToday) muteOfferExitNoticeToday();
    window.open(cardOfferOutboundUrl(offer), "_blank", "noopener,noreferrer");
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#202829]/40 px-4 py-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[520px] rounded-lg bg-white p-5 shadow-[0_24px_80px_rgba(32,40,41,0.24)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full ${
              highRisk ? "bg-[#fff0ed] text-[#9b3328]" : "bg-[#eef3f8] text-[#47657a]"
            }`}>
              {highRisk ? <ShieldAlert size={20} /> : <AlertTriangle size={20} />}
            </div>
            <h3 id={titleId} className="font-serif text-xl font-semibold text-[#202829]">
              购买前先确认一下
            </h3>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#5a6061]">
              {offer.sourceTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭购买提醒"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#adb3b4]/25 text-[#5a6061] transition hover:bg-[#f2f4f4]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm leading-6 text-[#3d4749]">
          <p>
            PriceAI 只聚合公开报价，不售卖、不担保商品。分类和价格来自标题、标签和采集结果，最终商品细节、交付内容、售后规则仍以原店铺为准。
          </p>
          {hostedShopPlatform ? (
            <p className="rounded-lg bg-[#eef8f1] px-3 py-2 text-[#2f7a4b]">
              该渠道识别为{hostedShopLabel}来源。购买前仍建议确认套餐、有效期、质保和自动发货规则；如订单售后有问题，可优先在{hostedShopLabel}订单或投诉售后入口处理。
            </p>
          ) : (
            <p className="rounded-lg bg-[#fff7e8] px-3 py-2 text-[#7a541b]">
              该渠道暂未识别为链动小铺、云猫寄售或 QXVX Pay 这类平台来源。请先联系商家，确认店铺可信度、发货方式、售后路径和退款边界，再决定是否购买，不建议直接付款。
            </p>
          )}
          {highPrice ? (
            <p className="rounded-lg bg-[#fbe9e7] px-3 py-2 text-[#9b3328]">
              这是一条高额报价（¥{OFFER_HIGH_RISK_PRICE_THRESHOLD} 起触发提醒）。付款前请确认商品细节、账号归属、有效期、质保和售后条件。
            </p>
          ) : null}
          {risks.length ? (
            <div className="rounded-lg bg-[#f7f9f9] px-3 py-2">
              <p className="text-xs font-semibold text-[#2d3435]">当前提示</p>
              <ul className="mt-1 space-y-1 text-xs leading-5 text-[#5a6061]">
                {risks.map((risk) => (
                  <li key={risk.id}>• {risk.detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <label className="mt-4 flex items-center gap-2 rounded-lg border border-[#adb3b4]/20 bg-[#f7f9f9] px-3 py-2 text-sm text-[#5a6061]">
          <input
            type="checkbox"
            checked={muteToday}
            onChange={(event) => setMuteToday(event.target.checked)}
            className="h-4 w-4 rounded border-[#adb3b4]"
          />
          今天不再提示（普通和高风险提醒都关闭，明天恢复）
        </label>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-[#adb3b4]/30 px-4 text-sm font-semibold text-[#5a6061] transition hover:bg-[#f2f4f4]"
          >
            再看看
          </button>
          <button
            type="button"
            onClick={continueToOffer}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-[#2d3435] px-4 text-sm font-semibold text-white transition hover:bg-[#202829]"
          >
            {primaryCopy}
            <ExternalLink size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function OfferInventorySummary({ offer, available, compact = false }: { offer: RawOffer; available: boolean; compact?: boolean }) {
  const stockCount = typeof offer.stockCount === "number" && Number.isFinite(offer.stockCount)
    ? Math.max(0, Math.trunc(offer.stockCount))
    : null;

  return (
    <span className={`flex shrink-0 flex-col gap-1 ${compact ? "items-end" : "items-start"}`}>
      <OfferStatusBadge available={available} />
      {available && stockCount !== null ? (
        <span className="whitespace-nowrap text-[0.68rem] font-semibold leading-4 text-[#5a6061]">
          库存 {formatInventoryCount(stockCount)}
        </span>
      ) : null}
    </span>
  );
}

function OfferPriceCell({ offer, available }: { offer: RawOffer; available: boolean }) {
  return (
    <span className="block">
      <span className={`block text-lg font-bold ${available ? "text-[#202829]" : "text-[#9b3328]"}`}>
        {formatCurrency(offer.price, offer.currency)}
      </span>
      <OfferPurchaseTerms offer={offer} available={available} className="mt-1" />
    </span>
  );
}

function OfferPurchaseTerms({ offer, available, className = "" }: { offer: RawOffer; available: boolean; className?: string }) {
  if (!available) return null;

  const minOrderQuantity = typeof offer.minOrderQuantity === "number" && offer.minOrderQuantity > 1
    ? Math.trunc(offer.minOrderQuantity)
    : null;
  const hasBulkPricing = Boolean(offer.bulkPricingTiers?.length);
  if (!minOrderQuantity && !hasBulkPricing) return null;

  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 align-bottom text-[0.68rem] font-semibold leading-5 ${className}`}>
      {minOrderQuantity ? (
        <span className="whitespace-nowrap rounded-full bg-[#f2f4f4] px-2 text-[#5a6061]">
          {minOrderQuantity}件起购
        </span>
      ) : null}
      {hasBulkPricing ? (
        <span className="whitespace-nowrap rounded-full bg-[#eef3f8] px-2 text-[#47657a]" title={bulkPricingTitle(offer)}>
          阶梯价
        </span>
      ) : null}
    </span>
  );
}

function formatInventoryCount(value: number): string {
  return INVENTORY_NUMBER_FORMATTER.format(value);
}

function bulkPricingTitle(offer: RawOffer): string {
  const tiers = offer.bulkPricingTiers || [];
  if (!tiers.length) return "阶梯价";

  const summary = tiers
    .slice(0, 4)
    .map((tier) => {
      const value = typeof tier.value === "number" ? ` ${tier.value}` : "";
      return `${tier.minQuantity}件起${value}`;
    })
    .join(" / ");
  return summary ? `阶梯价：${summary}` : "阶梯价";
}

function OfferStatusBadge({ available }: { available: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${
        available ? "bg-[#e8f3ec] text-[#2f7a4b]" : "bg-[#fbe9e7] text-[#9b3328]"
      }`}
    >
      {available ? "有货" : "缺货"}
    </span>
  );
}

function OfferMerchantTimeSummary({ offer }: { offer: RawOffer }) {
  const includedAt = offer.sourceIncludedAt || null;
  const shopCreatedAt = offer.sourceShopCreatedAt || null;
  const parts = [
    includedAt ? `收录 ${formatElapsedDays(includedAt)}` : null,
    shopCreatedAt ? `公开运营 ${formatMerchantAge(shopCreatedAt)}` : null,
  ].filter((part): part is string => Boolean(part));

  if (!parts.length) return null;

  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.68rem] leading-4 text-[#7a8587]" suppressHydrationWarning>
      {parts.map((part) => (
        <span key={part} className="inline-flex shrink-0 items-center rounded-full bg-[#f2f4f4] px-1.5 py-0.5">
          {part}
        </span>
      ))}
    </span>
  );
}

function OfferRelativeTime({ value }: { value: string | null | undefined }) {
  const mounted = useClientHydrated();

  return <span suppressHydrationWarning>{mounted ? formatRelativeTime(value) : formatDateMinute(value)}</span>;
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

function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function useClientHydrated(): boolean {
  return useSyncExternalStore(subscribeToHydration, getHydratedSnapshot, getServerHydrationSnapshot);
}

function subscribeToHydration(onStoreChange: () => void): () => void {
  const timeoutId = window.setTimeout(onStoreChange, 0);
  return () => window.clearTimeout(timeoutId);
}

function getHydratedSnapshot(): boolean {
  return true;
}

function getServerHydrationSnapshot(): boolean {
  return false;
}

function isOfferExitNoticeMutedToday(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OFFER_EXIT_NOTICE_MUTED_DATE_KEY) === localDateKey();
  } catch {
    return false;
  }
}

function muteOfferExitNoticeToday(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFFER_EXIT_NOTICE_MUTED_DATE_KEY, localDateKey());
  } catch {
    // localStorage may be unavailable in private or restricted contexts.
  }
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function OfferLink({
  offer,
  available,
  compact = false,
  onRequestPurchase,
}: {
  offer: RawOffer;
  available: boolean;
  compact?: boolean;
  onRequestPurchase?: (offer: RawOffer) => void;
}) {
  const [localOutboundOffer, setLocalOutboundOffer] = useState<RawOffer | null>(null);
  const outboundUrl = cardOfferOutboundUrl(offer);

  return (
    <>
      <a
        href={outboundUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          trackAnalyticsEvent("purchase_link_click", {
            source_id: offer.sourceId || "unknown",
            available,
          });
          if (isOfferExitNoticeMutedToday()) {
            return;
          }
          event.preventDefault();
          if (onRequestPurchase) {
            onRequestPurchase(offer);
            return;
          }
          setLocalOutboundOffer(offer);
        }}
        className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-sm font-semibold leading-none transition hover:opacity-90 ${
          compact ? "h-9 min-w-[108px] px-3" : "h-10 min-w-[112px] px-4"
        } ${
          available
            ? "bg-[#2d3435] text-[#f8f8f8]"
            : "bg-[#ead8d5] text-[#8f2f24]"
        }`}
      >
        {available ? "前往购买" : "查看"}
        <ExternalLink size={compact ? 14 : 16} />
      </a>
      {localOutboundOffer ? (
        <OfferExitNoticeDialog offer={localOutboundOffer} onClose={() => setLocalOutboundOffer(null)} />
      ) : null}
    </>
  );
}

function cardOfferOutboundUrl(offer: RawOffer): string {
  return withPriceAiUtm(rewriteLdxpUrlHost(offer.url) || offer.url, {
    medium: "card_offer",
    campaign: "priceai_card_shop",
    content: offer.id,
  });
}

export function OfferActions({
  offer,
  available,
  onFeedback,
  compact = false,
  onRequestPurchase,
}: {
  offer: RawOffer;
  available: boolean;
  onFeedback: (offer: RawOffer) => void;
  compact?: boolean;
  onRequestPurchase?: (offer: RawOffer) => void;
}) {
  return (
    <div className="flex flex-nowrap items-center justify-end gap-2">
      <OfferLink offer={offer} available={available} compact={compact} onRequestPurchase={onRequestPurchase} />
      <OfferFeedbackButton offer={offer} onFeedback={onFeedback} compact={compact} />
    </div>
  );
}

export function OfferFeedbackButton({
  offer,
  onFeedback,
  compact = false,
}: {
  offer: RawOffer;
  onFeedback: (offer: RawOffer) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onFeedback(offer)}
      title="反馈报价问题"
      aria-label="反馈报价问题"
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-[#adb3b4]/30 bg-white text-xs font-semibold text-[#5a6061] transition hover:border-[#5a6061]/35 hover:bg-[#f2f4f4] ${
        compact ? "h-9 w-9" : "h-10 px-3"
      }`}
    >
      <Flag size={14} />
      {!compact ? <span className="ml-1.5">反馈</span> : null}
    </button>
  );
}

export function OfferFeedbackDialog({
  productId,
  productSlug,
  productName,
  offer,
  onClose,
}: {
  productId: string;
  productSlug: string;
  productName: string;
  offer: RawOffer;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<OfferFeedbackReason | "">("");
  const [issueDimension, setIssueDimension] = useState<OfferFeedbackIssueDimension | "">("");
  const [expectedProductId, setExpectedProductId] = useState("");
  const [reportedFilterTagId, setReportedFilterTagId] = useState<OfferFilterTagId | "">("");
  const [expectedFilterTagId, setExpectedFilterTagId] = useState<OfferFilterTagId | "">("");
  const [userExpectedAction, setUserExpectedAction] = useState<OfferFeedbackUserExpectedAction>("unsure");
  const [notes, setNotes] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [contact, setContact] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const { user: accountUser, loaded: accountLoaded } = useAccountUser();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = "offer-feedback-dialog-title";
  const requiresEvidence = needsHighRiskEvidence(reason, userExpectedAction);
  const requiresImageEvidence = needsHighRiskImageEvidence(reason, userExpectedAction);
  const requiresContact = feedbackRequiresContact(reason);
  const requiresLogin = reason ? HIGH_RISK_FEEDBACK_REASONS.has(reason) : false;
  const supportEscalationReminder = feedbackSupportEscalationReminder(reason);
  const isDescriptionMismatchFeedback = reason === "description_mismatch";
  const evidenceUpload = useFeedbackEvidenceUpload({
    canUpload: Boolean(accountUser),
    maxImages: FEEDBACK_EVIDENCE_MAX_IMAGES,
    onAuthRequired: () => {
      setAuthRequired(true);
      setMessage({ type: "error", text: "登录后才能上传图片证据；低风险文字纠错仍可匿名提交。" });
    },
    onError: (text) => setMessage({ type: "error", text }),
  });
  const uploadedEvidence = evidenceUpload.uploaded;
  const uploadingEvidence = evidenceUpload.uploading;
  const hasEvidence =
    uploadedEvidence.length > 0 ||
    extractEvidenceUrls(evidenceText).length > 0 ||
    evidenceText.trim().length >= 8;
  const currentFilterTagIds = useMemo(
    () => parseOfferFilterTagsForProduct(
      productId,
      offer.filterTags?.length ? offer.filterTags : deriveOfferFilterTags({ sourceTitle: offer.sourceTitle, tags: offer.tags }),
    ),
    [offer.filterTags, offer.sourceTitle, offer.tags, productId],
  );
  const expectedFilterTagOptions = useMemo(
    () => OFFER_FILTER_TAGS.filter(
      (tag) => offerFilterTagAppliesToProduct(productId, tag.id) && !currentFilterTagIds.includes(tag.id),
    ),
    [currentFilterTagIds, productId],
  );

  useEffect(() => {
    const draft = readFeedbackDraft("offer", offer.id);
    if (!draft) return;
    const frameId = window.requestAnimationFrame(() => {
      if (typeof draft.reason === "string" && feedbackReasonOptions.some((option) => option.value === draft.reason)) {
        setReason(draft.reason as OfferFeedbackReason);
      }
      if (typeof draft.userExpectedAction === "string" && expectedActionOptions.some((option) => option.value === draft.userExpectedAction)) {
        setUserExpectedAction(draft.userExpectedAction as OfferFeedbackUserExpectedAction);
      }
      if (typeof draft.issueDimension === "string" && categoryIssueDimensionOptions.some((option) => option.value === draft.issueDimension)) {
        setIssueDimension(draft.issueDimension as OfferFeedbackIssueDimension);
      }
      if (typeof draft.expectedProductId === "string") setExpectedProductId(draft.expectedProductId);
      if (typeof draft.reportedFilterTagId === "string" && OFFER_FILTER_TAG_BY_ID.has(draft.reportedFilterTagId as OfferFilterTagId)) {
        setReportedFilterTagId(draft.reportedFilterTagId as OfferFilterTagId);
      }
      if (typeof draft.expectedFilterTagId === "string" && OFFER_FILTER_TAG_BY_ID.has(draft.expectedFilterTagId as OfferFilterTagId)) {
        setExpectedFilterTagId(draft.expectedFilterTagId as OfferFilterTagId);
      }
      if (typeof draft.notes === "string") setNotes(draft.notes.slice(0, 500));
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [offer.id]);

  useDialogFocus({ dialogRef, onClose });

  function handleEvidencePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file && file.type.startsWith("image/")));
    if (!files.length) return;

    void evidenceUpload.uploadFiles(files);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);
    setAuthRequired(false);

    if (!reason) {
      setMessage({ type: "error", text: "请先选择问题类型。" });
      setLoading(false);
      return;
    }
    if (reason === "wrong_category" && !issueDimension) {
      setMessage({ type: "error", text: "请选择具体是哪一类分类问题。" });
      setLoading(false);
      return;
    }
    if (reason === "wrong_category" && issueDimension === "product_category" && !expectedProductId) {
      setMessage({ type: "error", text: "请选择正确分类。" });
      setLoading(false);
      return;
    }
    if (reason === "wrong_category" && issueDimension === "product_category" && expectedProductId === productId) {
      setMessage({ type: "error", text: "所选分类与当前分类相同；如果是标签不对，请选择“筛选标签错误”。" });
      setLoading(false);
      return;
    }
    if (reason === "wrong_category" && issueDimension === "filter_tag" && !reportedFilterTagId && !expectedFilterTagId) {
      setMessage({ type: "error", text: "请选择错误标签，或选择应该补充的标签。" });
      setLoading(false);
      return;
    }
    if (
      reason === "wrong_category" &&
      issueDimension === "filter_tag" &&
      reportedFilterTagId &&
      reportedFilterTagId === expectedFilterTagId
    ) {
      setMessage({ type: "error", text: "错误标签与期望标签不能相同。" });
      setLoading(false);
      return;
    }
    if (
      reason === "wrong_category" &&
      issueDimension === "filter_tag" &&
      expectedFilterTagId &&
      currentFilterTagIds.includes(expectedFilterTagId)
    ) {
      setMessage({ type: "error", text: "期望标签已经存在，请选择其他标签。" });
      setLoading(false);
      return;
    }
    if (requiresLogin && !accountUser) {
      persistOfferDraft();
      setAuthRequired(true);
      setMessage({ type: "error", text: "这类反馈会影响公开展示或商家声誉，需要先登录。草稿内容已暂存在当前标签页。" });
      setLoading(false);
      return;
    }
    if (requiresImageEvidence && uploadedEvidence.length === 0) {
      setMessage({ type: "error", text: isDescriptionMismatchFeedback ? "标题党或商家描述误导需要至少上传 1 张截图证据，方便判断哪里不一致。" : "这类高风险反馈需要至少上传 1 张图片证据，文字或链接只能作为补充。" });
      setLoading(false);
      return;
    }
    if (requiresEvidence && !hasEvidence) {
      setMessage({ type: "error", text: "这类反馈需要补充证据，方便后台判断是否处理。" });
      setLoading(false);
      return;
    }
    if (requiresContact && !contact.trim()) {
      setMessage({ type: "error", text: "这类反馈需要留下 QQ、微信或 Telegram，方便后台核验和追问证据。" });
      setLoading(false);
      return;
    }

    try {
      const evidenceUrls = [
        ...extractEvidenceUrls(evidenceText),
        ...uploadedEvidence.map((item) => item.url),
      ];
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          productSlug,
          productName,
          offerId: offer.id,
          sourceId: offer.sourceId || null,
          sourceName: sourceLabel(offer),
          sourceTitle: offer.sourceTitle,
          offerUrl: offer.url,
          offerPrice: offer.price,
          offerCurrency: offer.currency,
          offerStatus: offer.status,
          offerCapturedAt: offer.capturedAt || null,
          offerSourceUpdatedAt: offer.sourceUpdatedAt || null,
          offerLastSeenAt: offer.lastSeenAt || null,
          offerTags: offer.tags,
          reason,
          issueDimension: reason === "wrong_category" ? issueDimension : null,
          expectedProductId: reason === "wrong_category" && issueDimension === "product_category" ? expectedProductId || null : null,
          reportedFilterTagId: reason === "wrong_category" && issueDimension === "filter_tag" ? reportedFilterTagId || null : null,
          expectedFilterTagId: reason === "wrong_category" && issueDimension === "filter_tag" ? expectedFilterTagId || null : null,
          userExpectedAction,
          evidenceText: evidenceText || null,
          evidenceUrls,
          notes: notes || null,
          contact: contact.trim() || null,
          website: "",
        }),
      });
      const json = await response.json().catch(() => ({ ok: false, message: response.statusText }));
      if (!response.ok || !json.ok) {
        if (json.code === "auth_required") setAuthRequired(true);
        throw new Error(json.message || "反馈提交失败。");
      }
      setMessage({ type: "success", text: "已收到反馈，我会在后台审核处理。" });
      clearFeedbackDraft("offer", offer.id);
      evidenceUpload.clear();
    } catch (currentError) {
      setMessage({ type: "error", text: currentError instanceof Error ? currentError.message : "反馈提交失败。" });
    } finally {
      setLoading(false);
    }
  }

  function buildLoginHref() {
    return buildAuthLoginHref(buildFeedbackResumePath("offer", offer.id));
  }

  function persistOfferDraft() {
    writeFeedbackDraft("offer", offer.id, {
      reason,
      issueDimension,
      expectedProductId,
      reportedFilterTagId,
      expectedFilterTagId,
      userExpectedAction,
      notes,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#202829]/35 px-4 py-4 sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-[0_24px_80px_rgba(32,40,41,0.22)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={titleId} className="font-serif text-xl font-semibold text-[#202829]">反馈报价问题</h3>
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-[#5a6061]">{offer.sourceTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭反馈弹窗"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#adb3b4]/25 text-[#5a6061] transition hover:bg-[#f2f4f4]"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">问题类型（必选）</span>
            <select
              value={reason}
              onChange={(event) => {
                const nextReason = event.target.value as OfferFeedbackReason | "";
                setReason(nextReason);
                if (nextReason !== "wrong_category") {
                  setIssueDimension("");
                  setExpectedProductId("");
                  setReportedFilterTagId("");
                  setExpectedFilterTagId("");
                }
              }}
              required
              className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
            >
              <option value="" disabled>请选择问题类型</option>
              {feedbackReasonOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          {reason === "wrong_category" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[#5a6061]">分类问题类型（必选）</span>
                <select
                  value={issueDimension}
                  onChange={(event) => {
                    const nextDimension = event.target.value as OfferFeedbackIssueDimension | "";
                    setIssueDimension(nextDimension);
                    if (nextDimension !== "product_category") setExpectedProductId("");
                    if (nextDimension !== "filter_tag") {
                      setReportedFilterTagId("");
                      setExpectedFilterTagId("");
                    }
                  }}
                  required
                  className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
                >
                  <option value="" disabled>请选择</option>
                  {categoryIssueDimensionOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              {issueDimension === "product_category" ? (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[#5a6061]">应该归入（必选）</span>
                  <select
                    value={expectedProductId}
                    onChange={(event) => setExpectedProductId(event.target.value)}
                    className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
                  >
                    <option value="">请选择正确分类</option>
                    {feedbackExpectedProductOptions.filter((option) => option.id !== productId).map((option) => (
                      <option key={option.id} value={option.id}>{option.platform} · {option.displayName}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {issueDimension === "filter_tag" ? (
                <>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-[#5a6061]">当前哪个标签不对</span>
                    <select
                      value={reportedFilterTagId}
                      onChange={(event) => setReportedFilterTagId(event.target.value as OfferFilterTagId | "")}
                      className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
                    >
                      <option value="">没有错误标签</option>
                      {currentFilterTagIds.map((tagId) => (
                        <option key={tagId} value={tagId}>{OFFER_FILTER_TAG_BY_ID.get(tagId)?.label || tagId}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-[#5a6061]">应该补充哪个标签</span>
                    <select
                      value={expectedFilterTagId}
                      onChange={(event) => setExpectedFilterTagId(event.target.value as OfferFilterTagId | "")}
                      className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
                    >
                      <option value="">不需要补充标签</option>
                      {expectedFilterTagOptions.map((tag) => (
                        <option key={tag.id} value={tag.id}>{tag.label}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
            </div>
          ) : null}
          {requiresLogin && accountLoaded && !accountUser ? (
            <div className="rounded-lg border border-[#f1d6a8] bg-[#fff7e8] px-3 py-2 text-xs leading-5 text-[#7a541b]">
              <p>这类反馈需要登录后提交。登录后会回到当前页面并恢复问题类型、处理方式和补充说明。</p>
              <Link
                href={buildLoginHref()}
                onClick={persistOfferDraft}
                className="mt-2 inline-flex h-8 items-center justify-center rounded-full bg-[#2d3435] px-3 font-semibold text-white"
              >
                登录后继续
              </Link>
            </div>
          ) : null}
          {supportEscalationReminder ? (
            <div className="rounded-lg border border-[#f1d6a8] bg-[#fff7e8] px-3 py-2 text-xs leading-5 text-[#7a541b]">
              <p className="font-semibold text-[#6f4917]">{supportEscalationReminder.title}</p>
              {supportEscalationReminder.lines.map((line) => (
                <p key={line} className="mt-1">{line}</p>
              ))}
            </div>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">希望处理方式</span>
            <select
              value={userExpectedAction}
              onChange={(event) => setUserExpectedAction(event.target.value as OfferFeedbackUserExpectedAction)}
              className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
            >
              {expectedActionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">补充说明</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="例如：点进去实际价格是 1280，或原站已下架。"
              className="w-full resize-y rounded-lg border border-[#adb3b4]/40 bg-white px-3 py-2 text-sm outline-none transition focus:border-[#2d3435]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">
              证据链接或说明{requiresEvidence ? "（必填）" : "（可选）"}
            </span>
            <textarea
              value={evidenceText}
              onChange={(event) => setEvidenceText(event.target.value)}
              onPaste={handleEvidencePaste}
              rows={3}
              maxLength={1000}
              placeholder={requiresImageEvidence ? isDescriptionMismatchFeedback ? "截图是必填；这里说明标题承诺和实际描述、交付内容哪里不一致。" : "图片是必填；这里可补充订单页、聊天记录链接，或说明你看到的证据。" : "可粘贴截图、截图链接、订单页、聊天记录链接，或说明你看到的证据。"}
              className="w-full resize-y rounded-lg border border-[#adb3b4]/40 bg-white px-3 py-2 text-sm outline-none transition focus:border-[#2d3435]"
            />
          </label>
          <FeedbackEvidenceUploader
            accountLoaded={accountLoaded}
            canUpload={Boolean(accountUser)}
            description={`${requiresImageEvidence ? isDescriptionMismatchFeedback ? "标题党或描述误导至少上传 1 张截图；" : "高风险反馈至少上传 1 张图片；" : ""}支持 PNG、JPG、WebP，单张 4MB 内；电脑端也可以直接粘贴截图。`}
            failed={evidenceUpload.failed}
            maxImages={FEEDBACK_EVIDENCE_MAX_IMAGES}
            onRemoveFailed={evidenceUpload.removeFailed}
            onRemoveUploaded={(reference) => void evidenceUpload.removeUploaded(reference)}
            onRetryFailed={(id) => void evidenceUpload.retryFailed(id)}
            onUpload={(files) => void evidenceUpload.uploadFiles(files)}
            required={requiresImageEvidence}
            uploaded={uploadedEvidence}
            uploading={uploadingEvidence}
          />
          <label className="hidden">
            Website
            <input tabIndex={-1} autoComplete="off" name="website" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">
              联系方式{requiresContact ? "（必填）" : "（可选）"}
            </span>
            <input
              value={contact}
              onChange={(event) => setContact(event.target.value)}
              maxLength={200}
              required={requiresContact}
              placeholder="QQ / 微信 / Telegram，任选一种，便于及时联系"
              className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
            />
          </label>
          <CommunityPrompt>
            {message?.type === "success"
              ? "需要补充截图或查看处理进展？可以加入 PriceAI 交流群继续说明。"
              : "如果问题比较紧急，或需要补充截图/聊天记录，也可以加入 PriceAI 交流群同步反馈。"}
          </CommunityPrompt>
          {message ? (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              message.type === "success" ? "bg-[#e8f3ec] text-[#2f7a4b]" : "bg-[#fbe9e7] text-[#9b3328]"
            }`}>
              <p>{message.text}</p>
              {authRequired && message.type === "error" ? (
                <Link
                  href={buildLoginHref()}
                  onClick={persistOfferDraft}
                  className="mt-2 inline-flex h-8 items-center justify-center rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-white transition hover:bg-[#202829]"
                >
                  登录后提交
                </Link>
              ) : null}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={loading || uploadingEvidence || message?.type === "success"}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#2d3435] px-4 text-sm font-semibold text-white transition hover:bg-[#202829] disabled:opacity-60"
          >
            {message?.type === "success" ? "已提交" : loading ? "提交中..." : uploadingEvidence ? "图片上传中..." : "提交反馈"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function MerchantFeedbackDialog({
  merchant,
  onClose,
}: {
  merchant: PublicMerchantSummary;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(AFTERSALES_FEEDBACK_REASON);
  const [purchaseStage, setPurchaseStage] = useState("purchased_issue");
  const [userExpectedAction, setUserExpectedAction] = useState("unsure");
  const [notes, setNotes] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [contact, setContact] = useState("");
  const [publicConsent, setPublicConsent] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const { user: merchantAccountUser, loaded: merchantAccountLoaded } = useAccountUser();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = "merchant-feedback-dialog-title";
  const requiresEvidence = needsHighRiskEvidence(reason, userExpectedAction);
  const requiresImageEvidence = needsHighRiskImageEvidence(reason, userExpectedAction);
  const requiresContact = feedbackRequiresContact(reason);
  const evidenceUpload = useFeedbackEvidenceUpload({
    canUpload: Boolean(merchantAccountUser),
    maxImages: FEEDBACK_EVIDENCE_MAX_IMAGES,
    onAuthRequired: () => {
      setAuthRequired(true);
      setMessage({ type: "error", text: "登录后才能上传商家反馈的图片证据。" });
    },
    onError: (text) => setMessage({ type: "error", text }),
  });
  const uploadedEvidence = evidenceUpload.uploaded;
  const uploadingEvidence = evidenceUpload.uploading;
  const hasEvidence =
    uploadedEvidence.length > 0 ||
    extractEvidenceUrls(evidenceText).length > 0 ||
    evidenceText.trim().length >= 8;

  useEffect(() => {
    const draft = readFeedbackDraft("merchant", merchant.id);
    if (!draft) return;
    const frameId = window.requestAnimationFrame(() => {
      if (typeof draft.reason === "string" && merchantFeedbackReasonOptions.some((option) => option.value === draft.reason)) setReason(draft.reason);
      if (typeof draft.purchaseStage === "string" && merchantPurchaseStageOptions.some((option) => option.value === draft.purchaseStage)) setPurchaseStage(draft.purchaseStage);
      if (typeof draft.userExpectedAction === "string" && merchantExpectedActionOptions.some((option) => option.value === draft.userExpectedAction)) setUserExpectedAction(draft.userExpectedAction);
      if (typeof draft.notes === "string") setNotes(draft.notes.slice(0, 420));
      if (typeof draft.publicConsent === "boolean") setPublicConsent(draft.publicConsent);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [merchant.id]);

  useDialogFocus({ dialogRef, onClose });

  function handleEvidencePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file && file.type.startsWith("image/")));
    if (!files.length) return;

    void evidenceUpload.uploadFiles(files);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);
    setAuthRequired(false);

    if (!merchantAccountUser) {
      persistMerchantDraft();
      setAuthRequired(true);
      setMessage({ type: "error", text: "商家反馈需要登录后提交。草稿内容已暂存在当前标签页。" });
      setLoading(false);
      return;
    }

    if (requiresImageEvidence && uploadedEvidence.length === 0) {
      setMessage({ type: "error", text: "这类高风险反馈需要至少上传 1 张图片证据，文字或链接只能作为补充。" });
      setLoading(false);
      return;
    }
    if (requiresEvidence && !hasEvidence) {
      setMessage({ type: "error", text: "这类反馈需要补充证据，方便后台判断是否处理。" });
      setLoading(false);
      return;
    }
    if (requiresContact && !contact.trim()) {
      setMessage({ type: "error", text: "这类反馈需要留下 QQ、微信或 Telegram，方便后台核验和追问证据。" });
      setLoading(false);
      return;
    }

    try {
      const evidenceUrls = [
        ...extractEvidenceUrls(evidenceText),
        ...uploadedEvidence.map((item) => item.url),
      ];
      const merchantUrl = usableFeedbackUrl(merchant.shopUrl || merchant.entryUrl);
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedbackScope: "merchant",
          publicConsent,
          productId: null,
          productSlug: null,
          productName: merchant.representativeProduct || null,
          offerId: null,
          sourceId: merchant.sourceId || null,
          sourceName: merchant.name || merchant.sourceName,
          sourceTitle: merchant.representativeOfferTitle || `商家反馈：${merchant.name}`,
          offerUrl: merchantUrl,
          offerPrice: merchant.representativePrice ?? null,
          offerCurrency: merchant.representativeCurrency || null,
          offerStatus: null,
          reason,
          userExpectedAction,
          evidenceText: evidenceText || null,
          evidenceUrls,
          notes: buildMerchantFeedbackNotes({ purchaseStage, notes, publicConsent }),
          contact: contact.trim() || null,
          website: "",
        }),
      });
      const json = await response.json().catch(() => ({ ok: false, message: response.statusText }));
      if (!response.ok || !json.ok) {
        if (json.code === "auth_required") setAuthRequired(true);
        throw new Error(json.message || "商家反馈提交失败。");
      }
      setMessage({ type: "success", text: "已收到商家反馈，后台会先核验再决定是否进入前台摘要。" });
      clearFeedbackDraft("merchant", merchant.id);
      evidenceUpload.clear();
    } catch (currentError) {
      setMessage({ type: "error", text: currentError instanceof Error ? currentError.message : "商家反馈提交失败。" });
    } finally {
      setLoading(false);
    }
  }

  function buildLoginHref() {
    return buildAuthLoginHref(buildFeedbackResumePath("merchant", merchant.id));
  }

  function persistMerchantDraft() {
    writeFeedbackDraft("merchant", merchant.id, {
      reason,
      purchaseStage,
      userExpectedAction,
      notes,
      publicConsent,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#202829]/35 px-4 py-4 sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-[0_24px_80px_rgba(32,40,41,0.22)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={titleId} className="font-serif text-xl font-semibold text-[#202829]">反馈商家问题</h3>
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-[#5a6061]">{merchant.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭商家反馈弹窗"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#adb3b4]/25 text-[#5a6061] transition hover:bg-[#f2f4f4]"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="mt-4 space-y-3">
          {merchantAccountLoaded && !merchantAccountUser ? (
            <div className="rounded-lg border border-[#f1d6a8] bg-[#fff7e8] px-3 py-2 text-xs leading-5 text-[#7a541b]">
              <p>商家反馈会进入账户记录并可能影响商家公开信号，需要先登录。登录后会恢复当前非敏感草稿。</p>
              <Link
                href={buildLoginHref()}
                onClick={persistMerchantDraft}
                className="mt-2 inline-flex h-8 items-center justify-center rounded-full bg-[#2d3435] px-3 font-semibold text-white"
              >
                登录后继续
              </Link>
            </div>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">接触阶段</span>
            <select
              value={purchaseStage}
              onChange={(event) => setPurchaseStage(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
            >
              {merchantPurchaseStageOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">问题类型</span>
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
            >
              {merchantFeedbackReasonOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">希望处理方式</span>
            <select
              value={userExpectedAction}
              onChange={(event) => setUserExpectedAction(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
            >
              {merchantExpectedActionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">补充说明</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              maxLength={420}
              placeholder="例如：付款后发货延迟，已联系售后但暂未处理；或商品页面描述与实际交付不一致。"
              className="w-full resize-y rounded-lg border border-[#adb3b4]/40 bg-white px-3 py-2 text-sm outline-none transition focus:border-[#2d3435]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">
              证据链接或说明{requiresEvidence ? "（必填）" : "（可选）"}
            </span>
            <textarea
              value={evidenceText}
              onChange={(event) => setEvidenceText(event.target.value)}
              onPaste={handleEvidencePaste}
              rows={3}
              maxLength={1000}
              placeholder={requiresImageEvidence ? "图片是必填；这里可补充订单页、聊天记录链接，或说明你看到的证据。" : "可粘贴订单页、聊天记录链接，或说明你看到的证据。"}
              className="w-full resize-y rounded-lg border border-[#adb3b4]/40 bg-white px-3 py-2 text-sm outline-none transition focus:border-[#2d3435]"
            />
          </label>
          <FeedbackEvidenceUploader
            accountLoaded={merchantAccountLoaded}
            canUpload={Boolean(merchantAccountUser)}
            description={`${requiresImageEvidence ? "高风险反馈至少上传 1 张图片；" : ""}支持 PNG、JPG、WebP，单张 4MB 内。`}
            failed={evidenceUpload.failed}
            maxImages={FEEDBACK_EVIDENCE_MAX_IMAGES}
            onRemoveFailed={evidenceUpload.removeFailed}
            onRemoveUploaded={(reference) => void evidenceUpload.removeUploaded(reference)}
            onRetryFailed={(id) => void evidenceUpload.retryFailed(id)}
            onUpload={(files) => void evidenceUpload.uploadFiles(files)}
            required={requiresImageEvidence}
            uploaded={uploadedEvidence}
            uploading={uploadingEvidence}
          />
          <label className="hidden">
            Website
            <input tabIndex={-1} autoComplete="off" name="website" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5a6061]">
              联系方式{requiresContact ? "（必填）" : "（可选）"}
            </span>
            <input
              value={contact}
              onChange={(event) => setContact(event.target.value)}
              maxLength={200}
              required={requiresContact}
              placeholder="QQ / 微信 / Telegram，任选一种，便于及时联系"
              className="h-10 w-full rounded-lg border border-[#adb3b4]/40 bg-white px-3 text-sm outline-none transition focus:border-[#2d3435]"
            />
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-[#adb3b4]/20 bg-[#f7f9f9] px-3 py-2 text-xs leading-5 text-[#5a6061]">
            <input
              type="checkbox"
              checked={publicConsent}
              onChange={(event) => setPublicConsent(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[#adb3b4]"
            />
            <span>如果后台核验通过，允许 PriceAI 用脱敏摘要作为前台风险提示；你后续可以在“我的反馈”里撤销。</span>
          </label>
          {message ? (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              message.type === "success" ? "bg-[#e8f3ec] text-[#2f7a4b]" : "bg-[#fbe9e7] text-[#9b3328]"
            }`}>
              <p>{message.text}</p>
              {authRequired && message.type === "error" ? (
                <Link
                  href={buildLoginHref()}
                  onClick={persistMerchantDraft}
                  className="mt-2 inline-flex h-8 items-center justify-center rounded-full bg-[#2d3435] px-3 text-xs font-semibold text-white transition hover:bg-[#202829]"
                >
                  登录后提交
                </Link>
              ) : null}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={loading || uploadingEvidence || message?.type === "success"}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#2d3435] px-4 text-sm font-semibold text-white transition hover:bg-[#202829] disabled:opacity-60"
          >
            {message?.type === "success" ? "已提交" : loading ? "提交中..." : uploadingEvidence ? "图片上传中..." : "提交商家反馈"}
          </button>
        </form>
      </div>
    </div>
  );
}

const feedbackReasonOptions = [
  { value: "wrong_price", label: "价格不准" },
  { value: "item_removed", label: "商品/链接不可用" },
  { value: "stock_mismatch", label: "库存状态不准" },
  { value: "wrong_category", label: "分类错误" },
  { value: "description_mismatch", label: "标题党 / 商家描述误导" },
  { value: AFTERSALES_FEEDBACK_REASON, label: "交付/使用/售后问题" },
  { value: "fraud", label: "疑似虚假/欺诈" },
  { value: "bad_source", label: "渠道不可信" },
  { value: "other", label: "其他问题（以上都不符合）" },
];

const categoryIssueDimensionOptions: Array<{ value: OfferFeedbackIssueDimension; label: string }> = [
  { value: "product_category", label: "标准商品归错" },
  { value: "filter_tag", label: "筛选标签错误" },
  { value: "source_placement", label: "商家放错专区" },
  { value: "unsure", label: "不确定，交给后台判断" },
];

const feedbackExpectedProductOptions = [...canonicalCatalog].sort(compareProductDisplayOrder);

const merchantFeedbackReasonOptions = [
  { value: AFTERSALES_FEEDBACK_REASON, label: "售后/发货问题" },
  { value: "description_mismatch", label: "商品/套餐描述不符" },
  { value: "stock_mismatch", label: "店铺库存状态不准" },
  { value: "fraud", label: "疑似虚假/欺诈" },
  { value: "bad_source", label: "商家/渠道不可信" },
  { value: "other", label: "其他问题" },
];

const merchantPurchaseStageOptions = [
  { value: "before_purchase", label: "购买前咨询" },
  { value: "purchased_pending", label: "已付款，等待发货/交付" },
  { value: "purchased_issue", label: "已购买，交付或售后有问题" },
  { value: "resolved", label: "曾有问题，现已协商解决" },
  { value: "other", label: "其他阶段" },
];

const merchantExpectedActionOptions = [
  { value: "unsure", label: "先由后台判断" },
  { value: "recheck", label: "请重新核查该商家" },
  { value: "hide_source", label: "建议暂停展示该商家" },
];

const expectedActionOptions = [
  { value: "unsure", label: "交给管理员判断" },
  { value: "recheck", label: "请重新核查" },
  { value: "hide_offer", label: "建议下架这条报价" },
  { value: "hide_source", label: "建议下架整个渠道" },
];

function buildMerchantFeedbackNotes({
  purchaseStage,
  notes,
  publicConsent,
}: {
  purchaseStage: string;
  notes: string;
  publicConsent: boolean;
}): string {
  const stageLabel = merchantPurchaseStageOptions.find((option) => option.value === purchaseStage)?.label || "其他阶段";
  return [
    `接触阶段：${stageLabel}`,
    `允许脱敏公开：${publicConsent ? "是" : "否"}`,
    notes.trim() ? `说明：${notes.trim()}` : null,
  ].filter(Boolean).join("\n").slice(0, 500);
}

function usableFeedbackUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    return null;
  }
  return null;
}

function extractEvidenceUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s"'<>，。；、]+/g) || [];
  return Array.from(new Set(matches)).slice(0, 10);
}

function needsHighRiskEvidence(reason: string, userExpectedAction: string): boolean {
  return feedbackRequiresEvidence(reason, userExpectedAction);
}

function needsHighRiskImageEvidence(reason: string, userExpectedAction: string): boolean {
  return feedbackRequiresImageEvidence(reason, userExpectedAction);
}

function feedbackSupportEscalationReminder(
  reason: OfferFeedbackReason | "",
): { title: string; lines: string[] } | null {
  if (!reason) return null;
  if (reason === AFTERSALES_FEEDBACK_REASON) {
    return {
      title: "建议先走原交易链路",
      lines: [
        "这类问题建议按顺序处理：商家售后 → 平台售后/投诉 → PriceAI 反馈。",
        "PriceAI 会记录并审核这类反馈，用于风险提示和商家质量观察，但不能替代商家或平台处理订单。",
      ],
    };
  }
  if (
    reason === "description_mismatch" ||
    reason === "fraud" ||
    reason === "bad_source"
  ) {
    return {
      title: "PriceAI 是保底反馈入口",
      lines: [
        "如果你已经购买，建议先联系商家售后；商家无法处理后，再联系交易平台售后或投诉入口。",
        "仍无法解决时，再提交到 PriceAI 作为保底反馈；请尽量补充订单页、沟通记录或截图。",
      ],
    };
  }
  if (reason === "other") {
    return {
      title: "请先确认是否有更准确的类型",
      lines: [
        "如果是链接打不开、没货、账号不能用、描述不符或渠道不可信，请优先选择对应问题类型。",
        "已经购买且需要反馈体验时，也建议先联系商家售后和平台售后；无果后再提交给 PriceAI 记录。",
      ],
    };
  }
  return null;
}

function isOfferAvailable(offer: RawOffer): boolean {
  return isAvailable(offer);
}

function offerTimestamp(offer: RawOffer): string | null | undefined {
  return productOfferPublicTimestamp(offer);
}

function sourceLabel(offer: RawOffer): string {
  return merchantSourceDisplayName(offer.sourceStoreName) || merchantSourceDisplayName(offer.sourceName) || "未记录渠道";
}

function sourceSecondaryLabel(offer: RawOffer): string | null {
  const sourceName = merchantSourceDisplayName(offer.sourceName);
  if (!sourceName || sourceName === sourceLabel(offer)) return null;
  return sourceName;
}

export function OfferMerchantLink({ offer, mode }: { offer: RawOffer; mode: "table" | "card" }) {
  const label = sourceLabel(offer);
  const shopUrl = safeExternalShopUrl(rewriteLdxpUrlHost(offer.shopUrl) || offer.shopUrl);
  const className = mode === "table"
    ? "flex w-full items-center gap-1 truncate font-semibold text-[#202829] hover:text-[#47657a] hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#47657a]"
    : "flex items-center gap-1 truncate font-semibold text-[#202829] hover:text-[#47657a] hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#47657a]";

  if (!shopUrl) {
    return mode === "table"
      ? <span className="block truncate font-semibold text-[#202829]">{label}</span>
      : <p className="truncate font-semibold text-[#202829]">{label}</p>;
  }

  const outboundUrl = withPriceAiUtm(shopUrl, {
    medium: "merchant_shop",
    campaign: "priceai_merchant",
    content: offer.sourceId || offer.id,
  });

  return (
    <a
      href={outboundUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={`前往${label}店铺主页`}
      aria-label={`前往${label}店铺主页（新标签页打开）`}
      onClick={() => {
        trackAnalyticsEvent("merchant_shop_click", {
          source_id: offer.sourceId || "unknown",
        });
      }}
      className={className}
    >
      <span className="truncate">{label}</span>
      <ExternalLink aria-hidden="true" size={13} className="shrink-0" />
    </a>
  );
}
