import {
  buildTransitAvailabilityBars,
  buildTransitModelIndex,
  compareStations,
  compactTransitStationsForList,
  TRANSIT_RANKING_WEIGHTS,
  TRANSIT_RESPONSE_LATENCY_WEIGHTS,
  getActiveTransitCommercialOffers,
  getAvailabilityEvidenceMeta,
  getAggregatedTransitCacheUsage,
  getFamilyRateSummary,
  getTransitFocusedFamilyFromReturnQuery,
  getStationComparisonSummary,
  getTextStationComparisonSummary,
  getStationPublishedAvailabilitySummary,
  getTransitAvailabilityFreshness,
  getTransitStationAvailabilityPresentation,
  getTransitStationPriceFreshness,
  getStandardModelRateSummary,
  getTransitRecentAvailabilitySampleLookupScopes,
  getTransitAvailabilityRollupPrices,
  getPreferredTransitAvailabilityRollupPrices,
  getTransitModelSummaries,
  hydrateTransitModelIndexSummaries,
  isTransitModelIndex,
  getOfficialTransitModelPrice,
  getNormalizedSourceTags,
  getTransitPriceAvailabilitySourceMeta,
  getTransitStationDetectionSummary,
  getTransitReviewTags,
  getTransitStationRankingBreakdowns,
  formatAvailability,
  formatTransitModelDetectionLabel,
  formatTransitModelDetectionMeta,
  hasPublicTransitModelDetectionReport,
  normalizedTransitCommercialOfferDisclosure,
  getRechargeCoefficientFromRatio,
  formatTransitFixedPriceValue,
  scoreTransitRelativeCost,
  scoreTransitReliability,
  scoreTransitResponseLatency,
} from "../src/lib/api-transit";
import {
  TRANSIT_DEFAULT_COMMERCIAL_OFFER_DISCLOSURE,
  TRANSIT_STANDARD_MODELS,
  type TransitStation,
} from "../src/data/api-transit/types";

const now = "2026-07-02T07:00:00.000Z";

assertEqual(getTransitFocusedFamilyFromReturnQuery("family=claude"), "claude");
assertEqual(getTransitFocusedFamilyFromReturnQuery("model=Claude%20Sonnet%205"), "claude");
assertEqual(getTransitFocusedFamilyFromReturnQuery("model=qwen"), "qwen");
assertEqual(getTransitFocusedFamilyFromReturnQuery("family=video"), "video");
assertEqual(getTransitFocusedFamilyFromReturnQuery("family=claude&model=Kimi%20K3"), "kimi");
assertEqual(getTransitFocusedFamilyFromReturnQuery("family=unknown"), null);
assertEqual(getTransitFocusedFamilyFromReturnQuery(["family=image", "family=video"]), "image");
assertEqual(getTransitFocusedFamilyFromReturnQuery(null), null);
assertEqual(TRANSIT_STANDARD_MODELS.includes("Claude Opus 5"), true);
const emptyClaudeOpus5Summary = getTransitModelSummaries([], "claude")
  .find((summary) => summary.standardModel === "Claude Opus 5");
assertEqual(emptyClaudeOpus5Summary?.stationCount, 0);
assertEqual(emptyClaudeOpus5Summary?.prices.length, 0);

assertDeepEqual(getOfficialTransitModelPrice("Claude Opus 5"), {
  input: 5,
  output: 25,
  cacheWrite: 6.25,
  cacheRead: 0.5,
  imageOutput: null,
  currency: "USD",
  sourceLabel: "Anthropic API",
  sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
});
assertDeepEqual(getOfficialTransitModelPrice("Kimi K3"), {
  input: 20,
  output: 100,
  cacheWrite: null,
  cacheRead: 2,
  imageOutput: null,
  currency: "CNY",
  sourceLabel: "Kimi API",
  sourceUrl: "https://platform.kimi.com/docs/pricing/chat-k3",
});
assertEqual(getOfficialTransitModelPrice("Qwen3.8-Max-Preview").input, null);
assertEqual(getOfficialTransitModelPrice("Qwen3.8-Max-Preview").output, null);
assertEqual(getOfficialTransitModelPrice("Qwen3.7-Max").input, 12);
assertEqual(getOfficialTransitModelPrice("Qwen3.7-Max").output, 36);

function station(input: {
  id: string;
  name: string;
  claudeRate: number;
  availabilityRate: number;
  availabilitySamples: number;
}): TransitStation {
  return {
    id: input.id,
    slug: input.id,
    name: input.name,
    websiteUrl: `https://${input.id}.example.test/`,
    operatorType: "individual",
    invoiceSupport: "unknown",
    status: "active",
    sourceType: "manual_collected",
    commercialRelation: "none",
    summary: "",
    channelTypes: ["first_party_pool"],
    accountPools: ["max"],
    paymentMethods: [],
    minimumTopUp: null,
    balanceExpiry: null,
    supportChannels: ["官网后台"],
    refundPolicy: null,
    riskLabels: ["insufficient_samples"],
    usageAdvice: "try_small",
    lastUpdatedAt: now,
    dataStatus: "verified",
    availability: availability(input.availabilityRate, input.availabilitySamples),
    prices: [
      {
        family: "claude",
        standardModel: "Claude Fable 5",
        groupName: "Claude",
        rechargeRatio: "1:1",
        modelMultiplier: input.claudeRate,
        inputPrice: input.claudeRate,
        outputPrice: input.claudeRate,
        cacheReadPrice: input.claudeRate,
        cacheWritePrice: input.claudeRate,
        imageOutputPrice: null,
        currency: "CNY",
        accountPool: "max",
        channelType: "first_party_pool",
        priceSource: "test",
        lastVerifiedAt: now,
        availability: availability(input.availabilityRate, input.availabilitySamples),
      },
    ],
    feedback: {
      pendingCount: 0,
      verifiedRiskCount: 0,
      merchantRespondedCount: 0,
      mainThemes: [],
      publicNotes: null,
    },
  };
}

function imageStation(input: {
  id: string;
  name: string;
  fixedPrice: number;
  availabilityRate: number;
  availabilitySamples: number;
}): TransitStation {
  const base = station({
    id: input.id,
    name: input.name,
    claudeRate: 0.2,
    availabilityRate: input.availabilityRate,
    availabilitySamples: input.availabilitySamples,
  });
  base.prices = [
    {
      family: "image",
      standardModel: "GPT Image 2",
      groupName: "image",
      rechargeRatio: "1:1",
      billingMode: "per_request",
      modelMultiplier: null,
      inputPrice: null,
      outputPrice: null,
      cacheReadPrice: null,
      cacheWritePrice: null,
      imageOutputPrice: null,
      fixedPrice: input.fixedPrice,
      fixedPriceCurrency: "CNY",
      fixedPriceUnit: "request",
      fixedPriceTiers: [],
      currency: "CNY",
      accountPool: "max",
      channelType: "first_party_pool",
      priceSource: "test",
      lastVerifiedAt: now,
      availability: availability(input.availabilityRate, input.availabilitySamples),
      cacheUsage: { hitRate: 0.99, sampleTokens: 100_000 },
    },
  ];
  return base;
}

function availability(sevenDayRate: number, sevenDaySamples: number): TransitStation["availability"] {
  return {
    sevenDayRate,
    sevenDaySamples,
    firstCheckedAt: now,
    lastCheckedAt: now,
    sourceType: "priceai_probe",
    sourceLabel: "PriceAI 实测",
    sourceUrl: null,
  };
}

const mixedQwenStation = station({
  id: "mixed-qwen",
  name: "Mixed Qwen",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 100,
});
mixedQwenStation.prices = [
  {
    ...mixedQwenStation.prices[0],
    family: "qwen",
    standardModel: "Qwen3.7-Max",
    groupName: "Qwen Max",
    modelMultiplier: 0.5,
    inputPrice: 0.5,
    outputPrice: 0.5,
    lastVerifiedAt: "2026-07-19T07:00:00.000Z",
  },
  {
    ...mixedQwenStation.prices[0],
    family: "qwen",
    standardModel: "Qwen3.8-Max-Preview",
    groupName: "Qwen Max",
    modelMultiplier: null,
    inputPrice: null,
    outputPrice: null,
    cacheReadPrice: null,
    cacheWritePrice: null,
    lastVerifiedAt: "2026-07-20T07:00:00.000Z",
  },
];
assertEqual(getFamilyRateSummary(mixedQwenStation, "qwen").combinedRateMin, 0.5);

assertEqual(scoreTransitRelativeCost(0.3, [0.3, 1.5]) > scoreTransitRelativeCost(1.5, [0.3, 1.5]), true);
assertEqual(scoreTransitReliability(0.99, 600) > scoreTransitReliability(1, 3), true);
assertEqual(
  scoreTransitResponseLatency(500, [500, 2000]) > scoreTransitResponseLatency(2000, [500, 2000]),
  true,
);
assertEqual(
  TRANSIT_RESPONSE_LATENCY_WEIGHTS.average7d + TRANSIT_RESPONSE_LATENCY_WEIGHTS.latest,
  TRANSIT_RANKING_WEIGHTS.responseLatency,
);
assertEqual(getRechargeCoefficientFromRatio("1 CNY = 1 USD balance"), 1);
assertEqual(getRechargeCoefficientFromRatio("1 CNY = 5 USD balance"), 0.2);
assertEqual(
  formatAvailability({
    sevenDayRate: null,
    sevenDaySamples: 0,
    recentSamples: [
      { ok: true, checkedAt: "2026-07-14T10:00:00.000Z" },
      { ok: false, checkedAt: "2026-07-14T10:01:00.000Z" },
      { ok: true, checkedAt: "2026-07-14T10:02:00.000Z" },
    ],
  }),
  "最近 3 次样本",
);
assertEqual(formatAvailability({ sevenDayRate: null, sevenDaySamples: 0 }), "样本不足");

const scopedSamplesStation = station({
  id: "scoped-samples",
  name: "Scoped Samples",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
scopedSamplesStation.availability.recentSamples = [
  { ok: false, checkedAt: "2026-07-14T10:00:00.000Z" },
  { ok: false, checkedAt: "2026-07-14T10:01:00.000Z" },
  { ok: false, checkedAt: "2026-07-14T10:02:00.000Z" },
];
assertEqual(getFamilyRateSummary(scopedSamplesStation, "claude").recentSamples, undefined);

const neko = station({
  id: "999555999-com",
  name: "猫肥NekoAPI",
  claudeRate: 1.5,
  availabilityRate: 0.9847,
  availabilitySamples: 250,
});
const wawa = station({
  id: "wawazz-xyz",
  name: "WAWA ZZ API",
  claudeRate: 0.3,
  availabilityRate: 0.9867,
  availabilitySamples: 600,
});

assertDeepEqual(
  compareStations([neko, wawa], "overall", { activeFamily: "claude", now }).map((item) => item.id),
  ["wawazz-xyz", "999555999-com"],
);

assertDeepEqual(
  compareStations([neko, wawa], "rate", { activeFamily: "claude", now }).map((item) => item.id),
  ["wawazz-xyz", "999555999-com"],
);

const cheaperStation = station({
  id: "cheaper-station",
  name: "Cheaper Station",
  claudeRate: 0.05,
  availabilityRate: 0.985,
  availabilitySamples: 180,
});
const pricierStation = station({
  id: "pricier-station",
  name: "Pricier Station",
  claudeRate: 0.1,
  availabilityRate: 0.99,
  availabilitySamples: 360,
});
assertDeepEqual(
  compareStations([pricierStation, cheaperStation], "overall", {
    activeFamily: "claude",
    now,
  }).map((item) => item.id),
  ["cheaper-station", "pricier-station"],
);

function setResponseLatency(target: TransitStation, latestLatencyMs: number, avgLatency7dMs: number) {
  target.availability.latestLatencyMs = latestLatencyMs;
  target.availability.avgLatency7dMs = avgLatency7dMs;
  for (const price of target.prices) {
    price.availability.latestLatencyMs = latestLatencyMs;
    price.availability.avgLatency7dMs = avgLatency7dMs;
  }
}

const fastLatencyStation = station({
  id: "fast-latency-station",
  name: "Fast Latency Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const mediumLatencyStation = station({
  id: "medium-latency-station",
  name: "Medium Latency Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const slowLatencyStation = station({
  id: "slow-latency-station",
  name: "Slow Latency Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const missingLatencyStation = station({
  id: "missing-latency-station",
  name: "Missing Latency Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
setResponseLatency(fastLatencyStation, 450, 600);
setResponseLatency(mediumLatencyStation, 900, 1200);
setResponseLatency(slowLatencyStation, 1800, 2400);
const latencyStations = [
  slowLatencyStation,
  missingLatencyStation,
  mediumLatencyStation,
  fastLatencyStation,
];
const latencyScores = getTransitStationRankingBreakdowns(latencyStations, {
  activeFamily: "claude",
  now,
});
assertEqual(latencyScores.get(fastLatencyStation.id)?.responseLatencyEnabled, true);
assertEqual(latencyScores.get(fastLatencyStation.id)?.responseLatencyCoverage, 0.75);
assertEqual(latencyScores.get(fastLatencyStation.id)?.responseLatencyScore, 15);
assertEqual(
  (latencyScores.get(fastLatencyStation.id)?.averageLatencyScore ?? 0) >
    (latencyScores.get(slowLatencyStation.id)?.averageLatencyScore ?? 0),
  true,
);
assertEqual(
  (latencyScores.get(fastLatencyStation.id)?.latestLatencyScore ?? 0) >
    (latencyScores.get(slowLatencyStation.id)?.latestLatencyScore ?? 0),
  true,
);
assertEqual(latencyScores.get(missingLatencyStation.id)?.responseLatencyScore, 0);
assertDeepEqual(
  compareStations(latencyStations, "overall", { activeFamily: "claude", now }).map((item) => item.id),
  ["fast-latency-station", "medium-latency-station", "slow-latency-station", "missing-latency-station"],
);

const insufficientLatencyCoverageScores = getTransitStationRankingBreakdowns(
  [fastLatencyStation, slowLatencyStation, missingLatencyStation],
  { activeFamily: "claude", now },
);
assertEqual(insufficientLatencyCoverageScores.get(fastLatencyStation.id)?.responseLatencyEnabled, false);
assertEqual(insufficientLatencyCoverageScores.get(fastLatencyStation.id)?.responseLatencyScore, 0);

const lowSampleLatencyStation = station({
  id: "low-sample-latency-station",
  name: "Low Sample Latency Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 29,
});
setResponseLatency(lowSampleLatencyStation, 300, 400);
const lowSampleLatencyScores = getTransitStationRankingBreakdowns(
  [fastLatencyStation, mediumLatencyStation, slowLatencyStation, lowSampleLatencyStation],
  { activeFamily: "claude", now },
);
assertEqual(lowSampleLatencyScores.get(fastLatencyStation.id)?.responseLatencyCoverage, 0.75);
assertEqual(lowSampleLatencyScores.get(lowSampleLatencyStation.id)?.responseLatencyScore, 0);

const familyBalancedLatencyStation = station({
  id: "family-balanced-latency-station",
  name: "Family Balanced Latency Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 1000,
});
setResponseLatency(familyBalancedLatencyStation, 1000, 1000);
familyBalancedLatencyStation.prices.push({
  ...familyBalancedLatencyStation.prices[0]!,
  family: "gpt",
  standardModel: "GPT 5.4",
  groupName: "GPT",
  availability: {
    ...familyBalancedLatencyStation.prices[0]!.availability,
    sevenDaySamples: 100,
    latestLatencyMs: 9000,
    avgLatency7dMs: 9000,
  },
});
const familyBalancedLatency = getStationPublishedAvailabilitySummary(familyBalancedLatencyStation);
assertEqual(familyBalancedLatency.latestLatencyMs, 5000);
assertEqual(familyBalancedLatency.avgLatency7dMs, 5000);

const textOnlyOverallStation = station({
  id: "text-only-overall-station",
  name: "Text Only Overall Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
setResponseLatency(textOnlyOverallStation, 1000, 1000);
textOnlyOverallStation.prices[0]!.cacheUsage = { hitRate: 0.2, sampleTokens: 1000 };
textOnlyOverallStation.prices.push({
  ...textOnlyOverallStation.prices[0]!,
  family: "image",
  standardModel: "GPT Image 2",
  groupName: "Image",
  billingMode: "per_request",
  modelMultiplier: null,
  inputPrice: null,
  outputPrice: null,
  cacheReadPrice: null,
  cacheWritePrice: null,
  imageOutputPrice: 0.02,
  fixedPrice: 0.02,
  fixedPriceCurrency: "CNY",
  fixedPriceUnit: "request",
  availability: {
    ...textOnlyOverallStation.prices[0]!.availability,
    sevenDaySamples: 240,
    latestLatencyMs: 37_000,
    avgLatency7dMs: 37_000,
  },
  cacheUsage: { hitRate: 0.99, sampleTokens: 100_000 },
});
const textOnlySummary = getTextStationComparisonSummary(textOnlyOverallStation);
assertEqual(textOnlySummary.availability.latestLatencyMs, 1000);
assertEqual(textOnlySummary.availability.avgLatency7dMs, 1000);
const textOnlyBreakdown = getTransitStationRankingBreakdowns([textOnlyOverallStation], { now }).get(
  textOnlyOverallStation.id,
);
assertEqual(textOnlyBreakdown?.latestLatencyMs, 1000);
assertEqual(textOnlyBreakdown?.avgLatency7dMs, 1000);
assertEqual(textOnlyBreakdown?.cacheHitRate, 0.2);

const cacheScopeStation = station({
  id: "cache-scope-station",
  name: "Cache Scope Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
cacheScopeStation.prices = [
  {
    ...cacheScopeStation.prices[0]!,
    family: "gpt",
    standardModel: "GPT 5.5",
    groupName: "GPT Shared",
    cacheUsage: { hitRate: 0.9, sampleTokens: 1000 },
  },
  {
    ...cacheScopeStation.prices[0]!,
    family: "gpt",
    standardModel: "GPT 5.4",
    groupName: "GPT Shared",
    cacheUsage: { hitRate: 0.9, sampleTokens: 1000 },
  },
  {
    ...cacheScopeStation.prices[0]!,
    family: "claude",
    standardModel: "Claude Fable 5",
    groupName: "Claude Shared",
    cacheUsage: { hitRate: 0.5, sampleTokens: 100 },
  },
];
const gptCacheUsage = getAggregatedTransitCacheUsage(
  cacheScopeStation.prices.filter((price) => price.family === "gpt")
);
assertEqual(gptCacheUsage?.hitRate, 0.9);
assertEqual(gptCacheUsage?.sampleTokens, 1000);
const allCacheUsage = getAggregatedTransitCacheUsage(cacheScopeStation.prices, {
  equalWeightFamilies: true,
});
assertEqual(allCacheUsage?.hitRate, 0.7);
assertEqual(allCacheUsage?.sampleTokens, 1100);
const cacheScopeScore = getTransitStationRankingBreakdowns([cacheScopeStation], { now })
  .get(cacheScopeStation.id);
assertEqual(cacheScopeScore?.cacheHitRate, 0.7);
assertEqual(cacheScopeScore?.cacheHitScore, 7);

const cheapImageStation = imageStation({
  id: "cheap-image-station",
  name: "Cheap Image Station",
  fixedPrice: 0.016,
  availabilityRate: 0.99,
  availabilitySamples: 240,
});
const expensiveImageStation = imageStation({
  id: "expensive-image-station",
  name: "Expensive Image Station",
  fixedPrice: 0.08,
  availabilityRate: 0.99,
  availabilitySamples: 240,
});
assertDeepEqual(
  compareStations([expensiveImageStation, cheapImageStation], "rate", { activeFamily: "image", now }).map((item) => item.id),
  ["cheap-image-station", "expensive-image-station"],
);
const imageSummary = getTransitModelSummaries([expensiveImageStation, cheapImageStation], "image")
  .find((summary) => summary.standardModel === "GPT Image 2");
assertEqual(imageSummary?.bestCombinedRate, null);
assertEqual(imageSummary?.bestFixedPrice, 0.016);
assertEqual(formatTransitFixedPriceValue(imageSummary?.bestFixedPrice ?? null), "¥0.016/次");

const imageModelIndex = buildTransitModelIndex(
  [expensiveImageStation, cheapImageStation],
  "2026-07-30T00:00:00.000Z",
);
const persistedImageModelIndex: unknown = JSON.parse(JSON.stringify(imageModelIndex));
assertEqual(isTransitModelIndex(persistedImageModelIndex), true);
if (!isTransitModelIndex(persistedImageModelIndex)) throw new Error("Expected a valid persisted image model index.");
assertDeepEqual(
  hydrateTransitModelIndexSummaries(persistedImageModelIndex, "image"),
  getTransitModelSummaries([expensiveImageStation, cheapImageStation], "image"),
);
const invalidImageModelIndex = structuredClone(persistedImageModelIndex);
const firstImagePriceEntry = invalidImageModelIndex.priceEntries[0];
if (!firstImagePriceEntry) throw new Error("Expected an image model price reference.");
firstImagePriceEntry.stationIndex = invalidImageModelIndex.stations.length;
assertEqual(isTransitModelIndex(invalidImageModelIndex), false);

const mismatchedImageModelIndex = structuredClone(persistedImageModelIndex);
const gptImageSummary = mismatchedImageModelIndex.summariesByFamily.image
  .find((summary) => summary.standardModel === "GPT Image 2");
if (!gptImageSummary?.priceEntryIndexes.length) throw new Error("Expected a GPT Image 2 summary reference.");
const grokSummary = mismatchedImageModelIndex.summariesByFamily.image
  .find((summary) => summary.standardModel === "Grok Image");
if (!grokSummary) throw new Error("Expected a Grok Image summary.");
grokSummary.priceEntryIndexes = [gptImageSummary.priceEntryIndexes[0]!];
assertEqual(isTransitModelIndex(mismatchedImageModelIndex), false);

const crossFamilyImageStation = structuredClone(cheapImageStation);
crossFamilyImageStation.id = "cross-family-image-station";
crossFamilyImageStation.slug = crossFamilyImageStation.id;
crossFamilyImageStation.prices[0]!.standardModel = "Grok Image";
crossFamilyImageStation.prices[0]!.family = "grok";
const crossFamilyModelIndex = buildTransitModelIndex([crossFamilyImageStation]);
assertDeepEqual(
  hydrateTransitModelIndexSummaries(crossFamilyModelIndex, "image"),
  getTransitModelSummaries([crossFamilyImageStation], "image"),
);
assertDeepEqual(
  hydrateTransitModelIndexSummaries(crossFamilyModelIndex, "grok"),
  getTransitModelSummaries([crossFamilyImageStation], "grok"),
);

const neutralStation = station({
  id: "neutral-station",
  name: "Neutral Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const sponsoredStation = station({
  id: "sponsored-station",
  name: "Sponsored Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
sponsoredStation.commercialRelation = "sponsored";
neutralStation.stationSystem = "custom";
sponsoredStation.stationSystem = "custom";
const neutralScores = getTransitStationRankingBreakdowns(
  [neutralStation, sponsoredStation],
  { activeFamily: "claude", now },
);
assertEqual(
  neutralScores.get(neutralStation.id)?.totalScore,
  neutralScores.get(sponsoredStation.id)?.totalScore,
);

const newApiStation = station({
  id: "new-api-station",
  name: "New API Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const subToApiStation = station({
  id: "sub-to-api-station",
  name: "Sub To API Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
newApiStation.stationSystem = "new_api";
subToApiStation.stationSystem = "sub_to_api";
const systemScores = getTransitStationRankingBreakdowns(
  [newApiStation, subToApiStation],
  { activeFamily: "claude", now },
);
assertEqual(
  systemScores.get(newApiStation.id)?.totalScore,
  systemScores.get(subToApiStation.id)?.totalScore,
);

const publicStatusStation = station({
  id: "public-status-station",
  name: "Public Status Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
publicStatusStation.availability.sourceType = "public_status";
publicStatusStation.availability.sourceLabel = "站方公开";
publicStatusStation.prices[0]!.availability.sourceType = "public_status";
publicStatusStation.prices[0]!.availability.sourceLabel = "站方公开";
const independentProbeStation = station({
  id: "independent-probe-station",
  name: "Independent Probe Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const sourceNeutralScores = getTransitStationRankingBreakdowns(
  [publicStatusStation, independentProbeStation],
  { activeFamily: "claude", now },
);
assertEqual(
  sourceNeutralScores.get(independentProbeStation.id)?.totalScore,
  sourceNeutralScores.get(publicStatusStation.id)?.totalScore,
);

const recentHealthyStation = station({
  id: "recent-healthy-station",
  name: "Recent Healthy Station",
  claudeRate: 0.2,
  availabilityRate: 0.98,
  availabilitySamples: 360,
});
const recentFailingStation = station({
  id: "recent-failing-station",
  name: "Recent Failing Station",
  claudeRate: 0.2,
  availabilityRate: 0.98,
  availabilitySamples: 360,
});
recentHealthyStation.prices[0]!.availability.recentSamples = Array.from({ length: 60 }, (_, index) => ({
  ok: index !== 0,
  checkedAt: new Date(Date.UTC(2026, 6, 2, 6, index)).toISOString(),
}));
recentFailingStation.prices[0]!.availability.recentSamples = Array.from({ length: 60 }, (_, index) => ({
  ok: index >= 6,
  checkedAt: new Date(Date.UTC(2026, 6, 2, 6, index)).toISOString(),
}));
const recentScores = getTransitStationRankingBreakdowns(
  [recentHealthyStation, recentFailingStation],
  { activeFamily: "claude", now },
);
assertEqual(
  (recentScores.get(recentHealthyStation.id)?.recentReliabilityScore ?? 0) >
    (recentScores.get(recentFailingStation.id)?.recentReliabilityScore ?? 0),
  true,
);

const cacheHealthyStation = station({
  id: "cache-healthy-station",
  name: "Cache Healthy Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
cacheHealthyStation.prices[0]!.cacheUsage = { hitRate: 0.95, sampleTokens: 1_000_000 };
const cacheMissingStation = station({
  id: "cache-missing-station",
  name: "Cache Missing Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const cacheScores = getTransitStationRankingBreakdowns(
  [cacheHealthyStation, cacheMissingStation],
  { activeFamily: "claude", now },
);
assertEqual(
  (cacheScores.get(cacheHealthyStation.id)?.cacheHitScore ?? 0) >
    (cacheScores.get(cacheMissingStation.id)?.cacheHitScore ?? 0),
  true,
);

const detectedStation = station({
  id: "detected-station",
  name: "Detected Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
detectedStation.modelDetection = {
  verdict: "passed",
  score: 92,
  checkedAt: now,
  reportCount: 1,
  issueCount: 0,
  source: "priceai",
  sourceLabel: "PriceAI 检测",
  reportUrl: "https://example.test/reports/detected-station",
};
const untestedStation = station({
  id: "untested-station",
  name: "Untested Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const detectionScores = getTransitStationRankingBreakdowns(
  [detectedStation, untestedStation],
  { activeFamily: "claude", now },
);
assertEqual(
  (detectionScores.get(detectedStation.id)?.modelDetectionScore ?? 0) >
    (detectionScores.get(untestedStation.id)?.modelDetectionScore ?? 0),
  true,
);

const publicSnapshotOnlyStation = station({
  id: "onepig123-com",
  name: "粉猪模型网关/路由层",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
publicSnapshotOnlyStation.verificationEvents = [
  {
    id: "onepig123-ai-transit-v1-2026-07-14",
    source: "priceai",
    status: "success",
    title: "ai-transit.v1 公开快照可读取",
    description:
      "2026-07-14 检查 https://onepig123.com/.well-known/ai-transit.json 可发现 snapshot_url，/api/public/transit/v1/snapshot 返回 2 个分组、10 个模型条目、1:1 充值口径、缓存命中率和公开监控时间线。",
    happenedAt: now,
  },
  {
    id: "onepig123-public-page-2026-07-14",
    source: "priceai",
    status: "info",
    title: "公开页显示 Sub2API 站点资料",
    description:
      "2026-07-14 检查 https://onepig123.com/public/transit 返回站点名粉猪模型网关/路由层、public_transit_enabled=true、公开监控入口和 QQ 联系方式。",
    happenedAt: now,
  },
];
const publicSnapshotDetectionSummary = getTransitStationDetectionSummary(publicSnapshotOnlyStation);
assertEqual(publicSnapshotDetectionSummary, null);
assertEqual(hasPublicTransitModelDetectionReport(publicSnapshotDetectionSummary), false);
assertEqual(formatTransitModelDetectionLabel(publicSnapshotDetectionSummary), "待检测");
assertEqual(formatTransitModelDetectionMeta(publicSnapshotDetectionSummary), "暂无公开报告");

const detectedByEventStation = station({
  id: "detected-by-event-station",
  name: "Detected By Event Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
detectedByEventStation.verificationEvents = [
  {
    id: "detected-by-event-report",
    source: "priceai",
    status: "warning",
    title: "模型检测报告：Claude Fable 5 需复核",
    description: "检测报告 https://example.test/reports/claude-fable-5 显示疑似暗调路由。",
    happenedAt: now,
  },
];
const detectedByEventSummary = getTransitStationDetectionSummary(detectedByEventStation, "Claude Fable 5");
assertEqual(hasPublicTransitModelDetectionReport(detectedByEventSummary), true);
assertEqual(formatTransitModelDetectionLabel(detectedByEventSummary), "需复核");

const oldEvidenceStation = station({
  id: "old-evidence-station",
  name: "Old Evidence Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
oldEvidenceStation.availability.lastCheckedAt = "2026-06-01T07:00:00.000Z";
oldEvidenceStation.prices[0]!.availability.lastCheckedAt = "2026-06-01T07:00:00.000Z";
const eligibilityScores = getTransitStationRankingBreakdowns(
  [independentProbeStation, oldEvidenceStation],
  { activeFamily: "claude", now },
);
assertEqual(
  eligibilityScores.get(independentProbeStation.id)?.eligible,
  true,
);
assertEqual(
  eligibilityScores.get(oldEvidenceStation.id)?.eligible,
  false,
);
assertEqual(
  eligibilityScores.get(oldEvidenceStation.id)?.totalScore,
  0,
);

const enoughSamplesStation = station({
  id: "enough-samples-station",
  name: "Enough Samples Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
enoughSamplesStation.riskLabels = [];
const insufficientLabelStation = station({
  id: "insufficient-label-station",
  name: "Insufficient Label Station",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 180,
});
const sampleLabelScores = getTransitStationRankingBreakdowns(
  [enoughSamplesStation, insufficientLabelStation],
  { activeFamily: "claude", now },
);
assertEqual(
  sampleLabelScores.get(enoughSamplesStation.id)?.totalScore,
  sampleLabelScores.get(insufficientLabelStation.id)?.totalScore,
);

const mixedAvailabilityStation = station({
  id: "mixed-availability",
  name: "Mixed Availability",
  claudeRate: 0.8,
  availabilityRate: 0.389,
  availabilitySamples: 702,
});
mixedAvailabilityStation.prices[0]!.availability = availability(0.966, 149);
mixedAvailabilityStation.prices.push({
  ...mixedAvailabilityStation.prices[0]!,
  family: "gpt",
  standardModel: "GPT 5.5",
  groupName: "GPT",
  modelMultiplier: 0.3,
  inputPrice: 0.3,
  outputPrice: 0.3,
  cacheReadPrice: 0.3,
  cacheWritePrice: 0.3,
  availability: availability(0.866, 149),
});

const publishedAvailability = getStationPublishedAvailabilitySummary(mixedAvailabilityStation);
assertEqual(publishedAvailability.sevenDaySamples, 298);
assertEqual(publishedAvailability.sevenDayRate, 0.916);
assertEqual(getStationComparisonSummary(mixedAvailabilityStation).stabilityRate, 0.916);

const publicMonitorCompatibilityStation = station({
  id: "public-monitor-compatibility",
  name: "Public Monitor Compatibility",
  claudeRate: 0.8,
  availabilityRate: 0.972,
  availabilitySamples: 500,
});
publicMonitorCompatibilityStation.monitorUrl = "https://public-monitor-compatibility.example.test/public/transit?view=monitoring";
publicMonitorCompatibilityStation.availability.sourceUrl =
  "https://public-monitor-compatibility.example.test/public/transit?view=monitoring";
const publicMonitorCompatibilityAvailability = getStationPublishedAvailabilitySummary(publicMonitorCompatibilityStation);
assertEqual(publicMonitorCompatibilityAvailability.sourceType, "public_status");
assertEqual(publicMonitorCompatibilityAvailability.sourceUrl, publicMonitorCompatibilityStation.monitorUrl);

const duplicateAvailabilityStation = station({
  id: "duplicate-availability",
  name: "Duplicate Availability",
  claudeRate: 0.8,
  availabilityRate: 0.99,
  availabilitySamples: 130,
});
duplicateAvailabilityStation.monitorUrl = "https://duplicate-availability.example.test/public/transit";
const duplicateProbePrice = {
  ...duplicateAvailabilityStation.prices[0]!,
  family: "gpt" as const,
  standardModel: "GPT 5.5" as const,
  groupName: "gpt-plus",
  modelMultiplier: 0.1,
  availability: {
    ...availability(0.99, 130),
    recentSamples: [
      { ok: true, checkedAt: "2026-07-02T06:00:00.000Z" },
      { ok: true, checkedAt: "2026-07-02T06:01:00.000Z" },
    ],
  },
};
const duplicatePublicStatusPrice = {
  ...duplicateProbePrice,
  availability: {
    ...availability(0.95, 60),
    sourceType: "public_status" as const,
    sourceLabel: "公开监测页",
    sourceUrl: "https://duplicate-availability.example.test/public/transit",
    recentSamples: [
      { ok: true, checkedAt: "2026-07-02T06:02:00.000Z" },
      { ok: false, checkedAt: "2026-07-02T06:03:00.000Z" },
      { ok: true, checkedAt: "2026-07-02T06:04:00.000Z" },
    ],
  },
};
duplicateAvailabilityStation.prices.push(duplicateProbePrice, duplicatePublicStatusPrice);
const duplicateRollupPrices = getTransitAvailabilityRollupPrices(duplicateAvailabilityStation, duplicateAvailabilityStation.prices);
assertEqual(duplicateRollupPrices.filter((price) => price.standardModel === "GPT 5.5").length, 1);
assertEqual(duplicateRollupPrices.find((price) => price.standardModel === "GPT 5.5")?.availability.sourceType, "priceai_probe");
const duplicateGptSummary = getFamilyRateSummary(duplicateAvailabilityStation, "gpt");
assertEqual(duplicateGptSummary.sevenDaySamples, 130);
assertEqual(Math.round((duplicateGptSummary.sevenDayRate || 0) * 100), 99);
assertDeepEqual(duplicateGptSummary.recentSamples, duplicateProbePrice.availability.recentSamples);
assertEqual(getAvailabilityEvidenceMeta(duplicatePublicStatusPrice.availability).label, "分组公开监测");

const zeroSampleExactPrice = {
  ...duplicatePublicStatusPrice,
  availability: {
    ...duplicatePublicStatusPrice.availability,
    sevenDayRate: null,
    sevenDaySamples: 0,
    recentSamples: [],
    sourceType: "unknown" as const,
    sourceLabel: null,
    sourceUrl: null,
    scope: "offer" as const,
    matchLevel: "exact" as const,
    monitoringScopeId: "scope:zero-sample-exact",
  },
};
const validModelReferencePrice = {
  ...duplicatePublicStatusPrice,
  availability: {
    ...duplicatePublicStatusPrice.availability,
    sevenDayRate: 1,
    sevenDaySamples: 1,
    sourceType: "public_status" as const,
    sourceLabel: "公开监测页",
    sourceUrl: "https://duplicate-availability.example.test/status",
    scope: "model" as const,
    matchLevel: "model" as const,
    monitoringScopeId: "scope:valid-model-reference",
  },
};
const modelFallbackPrices = getPreferredTransitAvailabilityRollupPrices(
  duplicateAvailabilityStation,
  [zeroSampleExactPrice, validModelReferencePrice],
);
assertEqual(modelFallbackPrices.length, 1);
assertEqual(modelFallbackPrices[0]?.availability.matchLevel, "model");
assertEqual(getAvailabilityEvidenceMeta(modelFallbackPrices[0]!.availability).label, "同模型参考");
assertEqual(getAvailabilityEvidenceMeta(zeroSampleExactPrice.availability).label, "监测样本不足");

const validExactPrice = {
  ...zeroSampleExactPrice,
  availability: {
    ...zeroSampleExactPrice.availability,
    sevenDayRate: 0.99,
    sevenDaySamples: 2,
    sourceType: "public_status" as const,
    sourceLabel: "公开监测页",
    sourceUrl: "https://duplicate-availability.example.test/status",
  },
};
const exactPreferredPrices = getPreferredTransitAvailabilityRollupPrices(
  duplicateAvailabilityStation,
  [validExactPrice, validModelReferencePrice],
);
assertEqual(exactPreferredPrices.length, 1);
assertEqual(exactPreferredPrices[0]?.availability.matchLevel, "exact");

const sharedGroupEvidenceStation = station({
  id: "shared-group-evidence",
  name: "Shared Group Evidence",
  claudeRate: 0.8,
  availabilityRate: 0.96,
  availabilitySamples: 60,
});
const sharedGroupModels = ["GPT 5.5", "GPT 5.4", "GPT 5.4 Mini"] as const;
sharedGroupEvidenceStation.prices = sharedGroupModels.map((standardModel) => ({
  ...duplicatePublicStatusPrice,
  standardModel,
  groupName: "GPT Plus",
  availability: {
    ...duplicatePublicStatusPrice.availability,
    scope: "group" as const,
    matchLevel: standardModel === "GPT 5.5" ? "exact" as const : "group" as const,
    monitoringScopeId: "scope:gpt-plus",
  },
}));
const sharedGroupSummary = getFamilyRateSummary(sharedGroupEvidenceStation, "gpt");
assertEqual(sharedGroupSummary.sevenDaySamples, 60);
assertEqual(sharedGroupSummary.sevenDayRate, 0.95);
assertEqual(sharedGroupSummary.referenceOnly, false);
assertEqual(getStationPublishedAvailabilitySummary(sharedGroupEvidenceStation).sevenDaySamples, 60);
const sharedGroupModelSummaries = getTransitModelSummaries([sharedGroupEvidenceStation], "gpt")
  .filter((summary) => sharedGroupModels.includes(summary.standardModel as typeof sharedGroupModels[number]));
assertEqual(sharedGroupModelSummaries.length, 3);
assertEqual(sharedGroupModelSummaries.every((summary) => summary.prices.length === 1), true);
assertEqual(sharedGroupModelSummaries.every((summary) => summary.sampleCount === 60), true);

const familyReferenceStation = station({
  id: "family-reference-only",
  name: "Family Reference Only",
  claudeRate: 0.8,
  availabilityRate: 0.95,
  availabilitySamples: 60,
});
familyReferenceStation.prices = sharedGroupModels.map((standardModel, index) => ({
  ...duplicatePublicStatusPrice,
  standardModel,
  groupName: `GPT ${index}`,
  availability: {
    ...duplicatePublicStatusPrice.availability,
    scope: "model" as const,
    matchLevel: "family" as const,
    monitoringScopeId: "scope:gpt-family",
  },
}));
assertEqual(getFamilyRateSummary(familyReferenceStation, "gpt").sevenDaySamples, 60);
assertEqual(getFamilyRateSummary(familyReferenceStation, "gpt").referenceOnly, true);
assertEqual(getTransitStationRankingBreakdowns([familyReferenceStation], { now }).get(familyReferenceStation.id)?.stabilityRate, null);

const modelEvidenceStation = station({
  id: "model-evidence-station",
  name: "Model Evidence Station",
  claudeRate: 0.2,
  availabilityRate: 0.94,
  availabilitySamples: 60,
});
modelEvidenceStation.prices = sharedGroupModels.map((standardModel) => ({
  ...duplicatePublicStatusPrice,
  standardModel,
  groupName: `Model ${standardModel}`,
  availability: {
    ...duplicatePublicStatusPrice.availability,
    sevenDayRate: 0.94,
    sevenDaySamples: 60,
    scope: "model" as const,
    matchLevel: "model" as const,
    monitoringScopeId: `scope:model:${standardModel}`,
  },
}));
assertEqual(getFamilyRateSummary(modelEvidenceStation, "gpt").referenceOnly, false);
assertEqual(getStandardModelRateSummary(modelEvidenceStation, "GPT 5.5").referenceOnly, false);
const modelEvidenceSummary = getStationPublishedAvailabilitySummary(modelEvidenceStation);
assertEqual(modelEvidenceSummary.referenceOnly, false);
assertEqual(modelEvidenceSummary.sevenDaySamples, 180);
assertEqual(
  getTransitStationRankingBreakdowns([modelEvidenceStation], { now }).get(modelEvidenceStation.id)?.eligible,
  true,
);

const publicCatalogReferenceStation = station({
  id: "public-catalog-reference",
  name: "Public Catalog Reference",
  claudeRate: 0.2,
  availabilityRate: 0.98,
  availabilitySamples: 60,
});
publicCatalogReferenceStation.prices = modelEvidenceStation.prices.map((price) => ({
  ...price,
  availability: {
    ...price.availability,
    sourceType: "public_model_catalog" as const,
  },
}));
assertEqual(getFamilyRateSummary(publicCatalogReferenceStation, "gpt").referenceOnly, true);
assertEqual(
  getTransitStationRankingBreakdowns([publicCatalogReferenceStation], { now })
    .get(publicCatalogReferenceStation.id)?.eligible,
  false,
);

const stationFallbackEvidenceStation = station({
  id: "station-fallback-evidence",
  name: "Station Fallback Evidence",
  claudeRate: 0.2,
  availabilityRate: 0.93,
  availabilitySamples: 60,
});
stationFallbackEvidenceStation.availability = {
  ...availability(0.93, 60),
  scope: "station",
  matchLevel: "exact",
};
stationFallbackEvidenceStation.prices = familyReferenceStation.prices.map((price) => ({
  ...price,
  availability: { ...price.availability },
}));
const stationFallbackSummary = getStationPublishedAvailabilitySummary(stationFallbackEvidenceStation);
assertEqual(stationFallbackSummary.referenceOnly, false);
assertEqual(stationFallbackSummary.sevenDayRate, 0.93);
assertEqual(stationFallbackSummary.sevenDaySamples, 60);
assertEqual(
  getTransitStationRankingBreakdowns([stationFallbackEvidenceStation], { now })
    .get(stationFallbackEvidenceStation.id)?.eligible,
  true,
);
const duplicateModelSummary = getTransitModelSummaries([duplicateAvailabilityStation], "gpt")
  .find((summary) => summary.standardModel === "GPT 5.5");
assertEqual(duplicateModelSummary?.prices.length, 2);
assertEqual(duplicateModelSummary?.sampleCount, 130);
assertEqual(Math.round((duplicateModelSummary?.averageAvailability || 0) * 100), 99);
assertEqual(duplicateModelSummary?.prices.some((entry) => entry.price.availability.sourceType === "public_status"), true);
assertEqual(getTransitPriceAvailabilitySourceMeta(duplicateAvailabilityStation, duplicateProbePrice).label, "站方公开");
assertDeepEqual(
  getTransitRecentAvailabilitySampleLookupScopes("GPT 5.5", "gpt-plus"),
  [
    { standardModel: "GPT 5.5", groupName: "gpt-plus", family: null, level: "exact" },
    { standardModel: "", groupName: "gpt-plus", family: null, level: "group" },
    { standardModel: "GPT 5.5", groupName: "", family: null, level: "model" },
    { standardModel: "", groupName: "", family: "gpt", level: "family" },
  ],
);
assertDeepEqual(
  getTransitRecentAvailabilitySampleLookupScopes("GPT 5.5", ""),
  [
    { standardModel: "GPT 5.5", groupName: "", family: null, level: "model" },
    { standardModel: "", groupName: "", family: "gpt", level: "family" },
  ],
);
assertDeepEqual(
  getTransitRecentAvailabilitySampleLookupScopes("", "gpt-plus"),
  [
    { standardModel: "", groupName: "gpt-plus", family: null, level: "group" },
  ],
);
assertDeepEqual(
  getTransitRecentAvailabilitySampleLookupScopes("GPT 5.5", "gpt-plus", { includeStationFallback: true }),
  [
    { standardModel: "GPT 5.5", groupName: "gpt-plus", family: null, level: "exact" },
    { standardModel: "", groupName: "gpt-plus", family: null, level: "group" },
    { standardModel: "GPT 5.5", groupName: "", family: null, level: "model" },
    { standardModel: "", groupName: "", family: "gpt", level: "family" },
    { standardModel: "", groupName: "", family: null, level: "station" },
  ],
);

const stationOnlyProbeAvailability = station({
  id: "station-only-probe",
  name: "Station Only Probe",
  claudeRate: 0.8,
  availabilityRate: 0,
  availabilitySamples: 1000,
});
stationOnlyProbeAvailability.prices[0]!.availability = {
  ...stationOnlyProbeAvailability.prices[0]!.availability,
  sevenDayRate: null,
  sevenDaySamples: 0,
  firstCheckedAt: null,
  lastCheckedAt: null,
};
const stationOnlyPublishedAvailability = getStationPublishedAvailabilitySummary(stationOnlyProbeAvailability);
assertEqual(stationOnlyPublishedAvailability.sevenDaySamples, 0);
assertEqual(stationOnlyPublishedAvailability.sevenDayRate, null);
assertEqual(stationOnlyPublishedAvailability.firstCheckedAt, null);
assertEqual(stationOnlyPublishedAvailability.lastCheckedAt, null);

const recentTimeline = Array.from({ length: 63 }, (_, index) => ({
  ok:
    index < 3 ? false :
      index < 6 ? true :
        index < 9 ? false :
          index < 12 ? index !== 10 :
            true,
  checkedAt: new Date(Date.UTC(2026, 6, 2, 7, index)).toISOString(),
})).reverse();
const recentBars = buildTransitAvailabilityBars({
  rate: 0.98,
  samples: 63,
  recentSamples: recentTimeline,
});
assertEqual(recentBars.length, 20);
assertDeepEqual(recentBars.slice(0, 4), ["good", "bad", "warn", "good"]);

const partialRecentBars = buildTransitAvailabilityBars({
  rate: 1,
  samples: 2,
  recentSamples: [
    { ok: true, checkedAt: "2026-07-02T07:00:00.000Z" },
    { ok: false, checkedAt: "2026-07-02T07:01:00.000Z" },
  ],
});
assertEqual(partialRecentBars.length, 20);
assertEqual(partialRecentBars[0], "warn");
assertDeepEqual(partialRecentBars.slice(1), Array(19).fill("empty"));

const fallbackAvailabilityBars = buildTransitAvailabilityBars({
  rate: 1,
  samples: 16,
  firstCheckedAt: now,
  lastCheckedAt: now,
});
assertEqual(fallbackAvailabilityBars.length, 20);
assertDeepEqual(fallbackAvailabilityBars.slice(0, 6), Array(6).fill("good"));
assertDeepEqual(fallbackAvailabilityBars.slice(6), Array(14).fill("empty"));

const fullFallbackAvailabilityBars = buildTransitAvailabilityBars({
  rate: 0.99,
  samples: 360,
  firstCheckedAt: now,
  lastCheckedAt: now,
});
assertEqual(fullFallbackAvailabilityBars.length, 20);
assertEqual(fullFallbackAvailabilityBars.filter((tone) => tone === "empty").length, 0);

const compactRecentSamplesStation = station({
  id: "compact-recent-samples-station",
  name: "Compact Recent Samples Station",
  claudeRate: 0.42,
  availabilityRate: 0.98,
  availabilitySamples: 480,
});
compactRecentSamplesStation.availability.recentSamples = recentTimeline;
compactRecentSamplesStation.prices[0]!.availability.recentSamples = recentTimeline.slice(0, 12);
const compactedRecentSamplesStation = compactTransitStationsForList([compactRecentSamplesStation])[0]!;
assertEqual(compactedRecentSamplesStation.availability.recentSampleBits, undefined);
assertEqual(compactedRecentSamplesStation.availability.recentSamples?.length, 60);
assertEqual(compactedRecentSamplesStation.availability.recentSamples?.[0]?.checkedAt, "2026-07-02T07:03:00.000Z");
const compactedPublishedAvailability = getStationPublishedAvailabilitySummary(compactedRecentSamplesStation);
assertEqual(compactedPublishedAvailability.recentSamples?.length, 60);
assertEqual(compactedPublishedAvailability.recentSamples?.[0]?.checkedAt, "2026-07-02T07:03:00.000Z");

mixedAvailabilityStation.prices[0]!.availability.recentSamples = [
  { ok: true, checkedAt: "2026-07-02T06:00:00.000Z" },
  { ok: false, checkedAt: "2026-07-02T06:01:00.000Z" },
];
mixedAvailabilityStation.prices[1]!.availability.recentSamples = [
  { ok: true, checkedAt: "2026-07-02T06:02:00.000Z" },
];
assertDeepEqual(
  getStationPublishedAvailabilitySummary(mixedAvailabilityStation).recentSamples,
  [
    { ok: true, checkedAt: "2026-07-02T06:00:00.000Z" },
    { ok: false, checkedAt: "2026-07-02T06:01:00.000Z" },
    { ok: true, checkedAt: "2026-07-02T06:02:00.000Z" },
  ],
);

const mixedClaudeGroupStation = station({
  id: "mixed-claude-group",
  name: "Mixed Claude Group",
  claudeRate: 1.32,
  availabilityRate: 1,
  availabilitySamples: 1,
});
mixedClaudeGroupStation.prices = [
  {
    ...mixedClaudeGroupStation.prices[0]!,
    standardModel: "Claude Sonnet 4.6",
    groupName: "GPT",
    modelMultiplier: 0.06,
    inputPrice: 0.06,
    outputPrice: 0.06,
    cacheReadPrice: 0.06,
    cacheWritePrice: 0.06,
  },
  {
    ...mixedClaudeGroupStation.prices[0]!,
    standardModel: "Claude Opus 4.6",
    groupName: "GPT",
    modelMultiplier: 0.9,
    inputPrice: 0.9,
    outputPrice: 0.9,
    cacheReadPrice: 0.9,
    cacheWritePrice: 0.9,
  },
  {
    ...mixedClaudeGroupStation.prices[0]!,
    standardModel: "Claude Opus 4.6",
    groupName: "Kiro",
    modelMultiplier: 0.22,
    inputPrice: 0.22,
    outputPrice: 0.22,
    cacheReadPrice: 0.22,
    cacheWritePrice: 0.22,
  },
  {
    ...mixedClaudeGroupStation.prices[0]!,
    standardModel: "Claude Opus 4.6",
    groupName: "Claude",
    modelMultiplier: 1.32,
    inputPrice: 1.32,
    outputPrice: 1.32,
    cacheReadPrice: 1.32,
    cacheWritePrice: 1.32,
  },
];
const mixedClaudeSummary = getStationComparisonSummary(mixedClaudeGroupStation);
assertEqual(mixedClaudeSummary.claude.priceCount, 4);
assertEqual(mixedClaudeSummary.claude.combinedRateMin, 0.22);
assertEqual(mixedClaudeSummary.bestCombinedRate, 0.22);
assertEqual(getStandardModelRateSummary(mixedClaudeGroupStation, "Claude Sonnet 4.6").combinedRateMin, 0.06);

const grokMediaStation = station({
  id: "grok-media",
  name: "Grok Media",
  claudeRate: 1,
  availabilityRate: 1,
  availabilitySamples: 1,
});
grokMediaStation.prices = [
  {
    ...grokMediaStation.prices[0]!,
    family: "grok",
    standardModel: "Grok Image",
    groupName: "Grok Image",
    modelMultiplier: 0.12,
    inputPrice: null,
    outputPrice: null,
    cacheReadPrice: null,
    cacheWritePrice: null,
    imageOutputPrice: 0.12,
  },
  {
    ...grokMediaStation.prices[0]!,
    family: "grok",
    standardModel: "Grok Video",
    groupName: "Grok Video",
    modelMultiplier: 0.3,
    inputPrice: null,
    outputPrice: null,
    cacheReadPrice: null,
    cacheWritePrice: null,
    imageOutputPrice: 0.3,
  },
];
assertEqual(getFamilyRateSummary(grokMediaStation, "grok").priceCount, 2);
assertEqual(getFamilyRateSummary(grokMediaStation, "image").priceCount, 1);
assertEqual(getFamilyRateSummary(grokMediaStation, "video").priceCount, 1);
assertEqual(
  getTransitModelSummaries([grokMediaStation], "image").some((summary) => summary.standardModel === "Grok Image"),
  true,
);
assertEqual(
  getTransitModelSummaries([grokMediaStation], "video").some((summary) => summary.standardModel === "Grok Video"),
  true,
);

const commercialStation = station({
  id: "commercial-test",
  name: "Commercial Test",
  claudeRate: 0.8,
  availabilityRate: 1,
  availabilitySamples: 10,
});
commercialStation.commercialOffers = [
  {
    id: "enabled-empty-disclosure",
    type: "coupon",
    title: "首充优惠",
    description: null,
    code: "PRICEAI",
    url: "https://commercial-test.example.test/register",
    validUntil: null,
    disclosure: null,
    enabled: true,
  },
  {
    id: "disabled-offer",
    type: "coupon",
    title: "不展示优惠",
    description: null,
    code: null,
    url: "https://commercial-test.example.test/hidden",
    validUntil: null,
    disclosure: "不应展示",
    enabled: false,
  },
];

const activeCommercialOffers = getActiveTransitCommercialOffers(commercialStation);
assertEqual(activeCommercialOffers.length, 1);
assertEqual(activeCommercialOffers[0]?.disclosure, TRANSIT_DEFAULT_COMMERCIAL_OFFER_DISCLOSURE);
commercialStation.commercialOffers = [
  {
    id: "enabled-url-without-title",
    type: "affiliate",
    title: "",
    description: null,
    code: null,
    url: "https://commercial-test.example.test/aff",
    validUntil: null,
    disclosure: null,
    enabled: true,
  },
];
const activeUntitledOffers = getActiveTransitCommercialOffers(commercialStation);
assertEqual(activeUntitledOffers.length, 1);
assertEqual(activeUntitledOffers[0]?.title, "");
assertEqual(activeUntitledOffers[0]?.url, "https://commercial-test.example.test/aff");
assertEqual(
  normalizedTransitCommercialOfferDisclosure("该链接包含AFF,但不影响排序口径。"),
  TRANSIT_DEFAULT_COMMERCIAL_OFFER_DISCLOSURE,
);
assertEqual(
  normalizedTransitCommercialOfferDisclosure("特殊活动说明：仅限老用户。"),
  "特殊活动说明：仅限老用户。",
);

const blankNewApiSourceStation = station({
  id: "blank-new-api-source",
  name: "Blank New API Source",
  claudeRate: 1,
  availabilityRate: 1,
  availabilitySamples: 1,
});
blankNewApiSourceStation.collectorKind = "new_api";
blankNewApiSourceStation.channelTypes = [];
blankNewApiSourceStation.accountPools = [];
blankNewApiSourceStation.riskLabels = [];
assertDeepEqual(getNormalizedSourceTags(blankNewApiSourceStation), []);
assertDeepEqual(getTransitReviewTags(blankNewApiSourceStation), []);

const explicitUndisclosedSourceStation = station({
  id: "explicit-undisclosed-source",
  name: "Explicit Undisclosed Source",
  claudeRate: 1,
  availabilityRate: 1,
  availabilitySamples: 1,
});
explicitUndisclosedSourceStation.channelTypes = ["undisclosed"];
assertDeepEqual(getNormalizedSourceTags(explicitUndisclosedSourceStation), [
  { id: "channel-undisclosed", label: "未披露", tone: "warn" },
]);

const accountPoolOnlySourceStation = station({
  id: "account-pool-only-source",
  name: "Account Pool Only Source",
  claudeRate: 1,
  availabilityRate: 1,
  availabilitySamples: 1,
});
accountPoolOnlySourceStation.channelTypes = [];
accountPoolOnlySourceStation.accountPools = ["kiro"];
assertDeepEqual(getNormalizedSourceTags(accountPoolOnlySourceStation), []);

const delayedAvailability = {
  ...availability(0.99, 60),
  lastCheckedAt: "2026-07-02T04:00:00.000Z",
};
assertEqual(getTransitAvailabilityFreshness(delayedAvailability, now), "delayed");

const staleAvailability = {
  ...availability(0.99, 60),
  lastCheckedAt: "2026-07-01T06:59:59.000Z",
};
assertEqual(getTransitAvailabilityFreshness(staleAvailability, now), "stale");
assertEqual(
  getTransitAvailabilityFreshness(delayedAvailability, now, {
    collectionStatus: "failed",
    collectionError: "HTTP 404: Not Found",
  }),
  "stale",
);

const probeFallbackStation = station({
  id: "probe-fallback",
  name: "Probe Fallback",
  claudeRate: 0.2,
  availabilityRate: 0.995,
  availabilitySamples: 60,
});
const stalePublicEvidence = {
  ...getStationPublishedAvailabilitySummary(probeFallbackStation),
  sourceType: "public_status" as const,
  sourceLabel: "站方公开",
  lastCheckedAt: "2026-07-01T00:00:00.000Z",
};
const probePresentation = getTransitStationAvailabilityPresentation(
  probeFallbackStation,
  stalePublicEvidence,
  now,
);
assertEqual(probePresentation.availability.sourceType, "priceai_probe");
assertEqual(probePresentation.freshness, "fresh");
assertEqual(Boolean(probePresentation.replacedPublicEvidence), true);

const staleRankingStation = station({
  id: "stale-ranking",
  name: "Stale Ranking",
  claudeRate: 0.01,
  availabilityRate: 1,
  availabilitySamples: 600,
});
staleRankingStation.availability.lastCheckedAt = "2026-07-01T00:00:00.000Z";
staleRankingStation.prices[0]!.availability.lastCheckedAt = "2026-07-01T00:00:00.000Z";
const staleRanking = getTransitStationRankingBreakdowns([staleRankingStation], { now });
assertEqual(staleRanking.get(staleRankingStation.id)?.eligible, false);
assertEqual(staleRanking.get(staleRankingStation.id)?.reliabilityScore, 0);

const freshRankingStation = station({
  id: "fresh-ranking",
  name: "Fresh Ranking",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 120,
});
const delayedRankingStation = station({
  id: "delayed-ranking",
  name: "Delayed Ranking",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 120,
});
delayedRankingStation.availability.lastCheckedAt = delayedAvailability.lastCheckedAt;
delayedRankingStation.prices[0]!.availability.lastCheckedAt = delayedAvailability.lastCheckedAt;
const freshnessRanking = getTransitStationRankingBreakdowns(
  [freshRankingStation, delayedRankingStation],
  { now },
);
assertEqual(
  (freshnessRanking.get(delayedRankingStation.id)?.reliabilityScore ?? 0) <
    (freshnessRanking.get(freshRankingStation.id)?.reliabilityScore ?? 0),
  true,
);

const delayedPriceStation = station({
  id: "delayed-price",
  name: "Delayed Price",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 120,
});
delayedPriceStation.prices[0]!.lastVerifiedAt = "2026-07-02T04:00:00.000Z";
assertEqual(getTransitStationPriceFreshness(delayedPriceStation, { now }).state, "delayed");

const stalePriceStation = station({
  id: "stale-price",
  name: "Stale Price",
  claudeRate: 0.01,
  availabilityRate: 0.99,
  availabilitySamples: 120,
});
stalePriceStation.prices[0]!.lastVerifiedAt = "2026-07-01T00:00:00.000Z";
assertEqual(getTransitStationPriceFreshness(stalePriceStation, { now }).state, "stale");
stalePriceStation.prices.push({
  ...stalePriceStation.prices[0]!,
  standardModel: "Claude Sonnet 5",
  groupName: "Fresh expensive price",
  modelMultiplier: 0.5,
  inputPrice: 0.5,
  outputPrice: 0.5,
  cacheReadPrice: 0.5,
  cacheWritePrice: 0.5,
  lastVerifiedAt: now,
});
assertEqual(
  getTransitStationPriceFreshness(stalePriceStation, { activeFamily: "claude", now }).state,
  "stale",
);
const stalePriceRanking = getTransitStationRankingBreakdowns([stalePriceStation], { now });
assertEqual(stalePriceRanking.get(stalePriceStation.id)?.eligible, false);
assertEqual(stalePriceRanking.get(stalePriceStation.id)?.comparisonRate, null);
assertEqual(stalePriceRanking.get(stalePriceStation.id)?.costScore, 0);

const freshPriceStation = station({
  id: "fresh-price",
  name: "Fresh Price",
  claudeRate: 0.2,
  availabilityRate: 0.99,
  availabilitySamples: 120,
});
assertEqual(
  compareStations([stalePriceStation, freshPriceStation], "rate", { now })[0]?.id,
  freshPriceStation.id,
);
const priceFreshnessRanking = getTransitStationRankingBreakdowns(
  [freshPriceStation, delayedPriceStation],
  { now },
);
assertEqual(
  (priceFreshnessRanking.get(delayedPriceStation.id)?.costScore ?? 0) <
    (priceFreshnessRanking.get(freshPriceStation.id)?.costScore ?? 0),
  true,
);

console.log("api transit sorting test passed");

function assertEqual(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`Expected ${actualText} to equal ${expectedText}.`);
  }
}
