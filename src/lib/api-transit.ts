import type {
  TransitAvailability,
  TransitCacheUsage,
  TransitChannelType,
  TransitCommercialOffer,
  TransitModelDetectionSource,
  TransitModelDetectionSummary,
  TransitModelDetectionVerdict,
  TransitModelFamily,
  TransitModelPrice,
  TransitOperatorType,
  TransitStation,
  TransitVerificationEvent,
  TransitStationSystem,
} from "@/data/api-transit/types";
import {
  TRANSIT_CHANNEL_TYPE_LABELS,
  TRANSIT_MODEL_FAMILY_OPTIONS,
  TRANSIT_MODEL_FAMILY_LABELS,
  TRANSIT_MODEL_FAMILY_ORDER,
  TRANSIT_TEXT_MODEL_FAMILY_ORDER,
  TRANSIT_STANDARD_MODELS,
  TRANSIT_STANDARD_MODEL_FAMILY,
  TRANSIT_COMMERCIAL_LABELS,
  TRANSIT_DEFAULT_COMMERCIAL_OFFER_DISCLOSURE,
  isTransitModelFamily,
  isTransitStandardModel,
  isTransitTextModelFamily,
  transitModelPriceMatchesFamily,
  transitStandardModelMatchesFamily,
} from "@/data/api-transit/types";
import { seedStations } from "@/data/api-transit/stations";

let cached: TransitStation[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;
const TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIMIT = 60;
const TRANSIT_RECENT_AVAILABILITY_BAR_COUNT = 20;
const TRANSIT_RECENT_AVAILABILITY_GROUP_SIZE = 3;
const sourceChannelPriority: TransitChannelType[] = [
  "official_api",
  "cloud",
  "first_party_pool",
  "reverse_engineered",
  "first_party_wholesale",
  "reseller",
  "mixed",
  "undisclosed",
];

export type TransitSortKey = "overall" | "rate" | "claude_rate" | "gpt_rate" | "stability";

export const ALLOWED_RETURN_KEYS = [
  "q",
  "family",
  "model",
  "channel",
  "pool",
  "risk",
  "sort",
] as const;

export function getTransitFocusedFamilyFromReturnQuery(
  back: string | string[] | null | undefined
): TransitModelFamily | null {
  const returnQuery = Array.isArray(back) ? back[0] : back;
  if (!returnQuery) return null;

  const params = new URLSearchParams(returnQuery.replace(/^\?/, ""));
  const model = params.get("model");
  if (isTransitStandardModel(model)) return TRANSIT_STANDARD_MODEL_FAMILY[model];
  if (isTransitModelFamily(model)) return model;

  const family = params.get("family");
  return isTransitModelFamily(family) ? family : null;
}

export async function getStations(): Promise<TransitStation[]> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

  cached = seedStations;
  cachedAt = now;
  return cached;
}

export async function getStationBySlug(
  slug: string
): Promise<TransitStation | undefined> {
  const stations = await getStations();
  return stations.find((station) => station.slug === slug);
}

export function parseRechargeRatio(text: string | null): number | null {
  if (!text) return null;

  const ratioMatch = text.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (ratioMatch) {
    const base = Number(ratioMatch[1]);
    const quota = Number(ratioMatch[2]);
    if (!Number.isFinite(base) || !Number.isFinite(quota) || base <= 0) return null;

    return quota / base;
  }

  const balanceMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:CNY|RMB|人民币|元|￥|¥)?\s*=\s*(\d+(?:\.\d+)?)\s*(?:USD\s*)?(?:balance|余额|额度|credit|credits)?/i
  );
  if (!balanceMatch) return null;

  const base = Number(balanceMatch[1]);
  const quota = Number(balanceMatch[2]);
  if (!Number.isFinite(base) || !Number.isFinite(quota) || base <= 0) return null;

  return quota / base;
}

export function getRechargeCoefficientFromRatio(text: string | null): number | null {
  const ratio = parseRechargeRatio(text);
  if (ratio === null) return null;
  if (ratio <= 0) return null;
  return 1 / ratio;
}

export function getStationRechargeCoefficient(station: TransitStation): number | null {
  return getRechargeCoefficientFromRatio(station.prices[0]?.rechargeRatio ?? null);
}

export function getCombinedRateForPrice(
  station: TransitStation,
  price: TransitModelPrice
): number | null {
  if (isTransitFixedPrice(price)) return null;
  if (!hasComparableTransitOfficialPrice(price.standardModel)) return null;

  const coefficient =
    getRechargeCoefficientFromRatio(price.rechargeRatio) ??
    getStationRechargeCoefficient(station);
  if (coefficient === null || price.modelMultiplier === null) return null;

  return coefficient * price.modelMultiplier;
}

export function isTransitFixedPrice(price: TransitModelPrice): boolean {
  return getTransitFixedPriceValue(price) !== null;
}

export function getTransitFixedPriceValue(price: TransitModelPrice): number | null {
  const values = [
    price.fixedPrice,
    ...(price.fixedPriceTiers || []).map((tier) => tier.price),
  ].filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : null;
}

export function formatTransitFixedPrice(price: TransitModelPrice): string {
  const value = getTransitFixedPriceValue(price);
  if (value === null) return "—";
  const prices = fixedPriceValues(price);
  const max = prices.length ? Math.max(...prices) : value;
  const unit = transitFixedPriceUnitLabel(price.fixedPriceUnit);
  const priceText = formatFixedTransitUnitPrice(value);
  return max > value ? `¥${priceText} 起/${unit}` : `¥${priceText}/${unit}`;
}

export function getRepresentativeTransitPrice(
  prices: TransitModelPrice[]
): TransitModelPrice | null {
  return [...prices].sort(compareTransitModelPriority)[0] ?? null;
}

export function compareTransitModelPriority(
  left: TransitModelPrice,
  right: TransitModelPrice
): number {
  return getTransitModelPriority(right.standardModel) - getTransitModelPriority(left.standardModel) ||
    new Date(right.lastVerifiedAt).getTime() - new Date(left.lastVerifiedAt).getTime();
}

function getTransitModelPriority(model: TransitModelPrice["standardModel"]): number {
  if (model === "GPT Image 2") return 602;
  if (model === "Grok Image") return 601;
  if (model === "Nano Banana Pro") return 595;
  if (model === "Nano Banana 2") return 594;
  if (model === "Nano Banana") return 593;
  if (model === "Nano Banana Lite") return 592;
  if (model === "Grok Video") return 591;
  if (model === "Sora 2 Pro") return 590;
  if (model === "Sora 2") return 589;
  if (model === "Veo 3.1") return 588;
  if (model === "Veo 3.1 Lite") return 587;
  if (model === "Gemini Omni Flash") return 586;
  if (model === "Seedance 2.0") return 585;
  if (model === "HappyHorse 1.1 I2V") return 584.5;
  if (model === "Kling 2.5 Turbo") return 584;
  if (model === "GPT 5.6 Sol") return 506;
  if (model === "GPT 5.6 Terra") return 505.8;
  if (model === "GPT 5.6 Luna") return 505.6;
  if (model === "GPT 5.5") return 505;
  if (model === "GPT 5.4") return 504;
  if (model === "GPT 5.4 Mini") return 503.5;
  if (model === "Codex Compact") return 503.2;
  if (model === "Grok 4.20") return 503.12;
  if (model === "Grok 4.3") return 503.15;
  if (model === "Grok 4.5") return 503;
  if (model === "Grok Build") return 502.5;
  if (model === "Composer 2.5") return 502;
  if (model === "Claude Opus 5") return 511;
  if (model === "Claude Fable 5") return 510;
  if (model === "Claude Sonnet 5") return 500;
  if (model === "Claude Opus 4.8") return 408;
  if (model === "Claude Opus 4.7") return 407;
  if (model === "Claude Opus 4.6") return 406;
  if (model === "Claude Opus 4.5") return 405;
  if (model === "Claude Sonnet 4.6") return 306;
  if (model === "Claude Sonnet 4.5") return 305;
  if (model === "Claude Haiku 4.5") return 304;
  if (model === "Gemini 3.5 Flash") return 335;
  if (model === "Gemini 3.1 Pro") return 331;
  if (model === "GLM-5.2") return 252;
  if (model === "GLM-5.1") return 251;
  if (model === "DeepSeek V4 Pro") return 244;
  if (model === "DeepSeek V4 Flash") return 243;
  if (model === "Kimi K3") return 242;
  // Keep the priced stable model representative until the preview has a comparable PAYG rate.
  if (model === "Qwen3.7-Max") return 241;
  if (model === "Qwen3.8-Max-Preview") return 240;
  return 0;
}

export type TransitPriceMetric = "input" | "output" | "cacheWrite" | "cacheRead" | "imageOutput";
export type TransitPriceCurrency = "USD" | "CNY";

export type TransitOfficialModelPrice = Record<TransitPriceMetric, number | null> & {
  currency: TransitPriceCurrency;
  sourceLabel: string;
  sourceUrl: string;
};

const anthropicPricingUrl = "https://platform.claude.com/docs/en/about-claude/pricing";
const openAiPricingUrl = "https://platform.openai.com/docs/pricing";
const openAiVideoGenerationUrl = "https://platform.openai.com/docs/guides/video-generation";
const geminiPricingUrl = "https://ai.google.dev/gemini-api/docs/pricing";
const geminiImageGenerationUrl = "https://ai.google.dev/gemini-api/docs/image-generation";
const geminiModelDocsUrl = "https://ai.google.dev/gemini-api/docs/models";
const xaiGrok45DocsUrl = "https://docs.x.ai/developers/models/grok-4.5";
const xaiModelsDocsUrl = "https://docs.x.ai/developers/models";
const xaiComposerNewsUrl = "https://x.ai/news/composer-2-5";
const xaiImageDocsUrl = "https://docs.x.ai/developers/models/grok-imagine-image";
const xaiVideoDocsUrl = "https://docs.x.ai/developers/models/grok-imagine-video";
const glmPricingUrl = "https://bigmodel.cn/pricing";
const deepseekPricingUrl = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const kimiK3PricingUrl = "https://platform.kimi.com/docs/pricing/chat-k3";
const qwenPricingUrl = "https://help.aliyun.com/zh/model-studio/model-pricing";
const qwenModelDocsUrl = "https://help.aliyun.com/zh/model-studio/models";
const seedanceDocsUrl = "https://docs.byteplus.com/en/docs/ModelArk/1520757";
const happyHorseDocsUrl = "https://developers.cloudflare.com/ai/models/alibaba/hh1.1-i2v/";
const klingDocsUrl = "https://app.klingai.com/global/dev/document-api/apiReference/model/video";

function unpricedOfficialModel(
  sourceLabel: string,
  sourceUrl: string,
  currency: TransitPriceCurrency = "USD"
): TransitOfficialModelPrice {
  return {
    input: null,
    output: null,
    cacheWrite: null,
    cacheRead: null,
    imageOutput: null,
    currency,
    sourceLabel,
    sourceUrl,
  };
}

const TRANSIT_OFFICIAL_MODEL_PRICES: Record<
  TransitModelPrice["standardModel"],
  TransitOfficialModelPrice
> = {
  "Claude Opus 5": {
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Fable 5": {
    input: 10,
    output: 50,
    cacheWrite: 12.5,
    cacheRead: 1,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Sonnet 5": {
    input: 2,
    output: 10,
    cacheWrite: 2.5,
    cacheRead: 0.2,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Sonnet 4.5": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Sonnet 4.6": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Haiku 4.5": {
    input: 1,
    output: 5,
    cacheWrite: 1.25,
    cacheRead: 0.1,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Opus 4.5": {
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Opus 4.6": {
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Opus 4.7": {
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "Claude Opus 4.8": {
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Anthropic API",
    sourceUrl: anthropicPricingUrl,
  },
  "GPT 5.6 Sol": {
    input: 5,
    output: 30,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "OpenAI API",
    sourceUrl: openAiPricingUrl,
  },
  "GPT 5.6 Terra": {
    input: 2.5,
    output: 15,
    cacheWrite: 3.125,
    cacheRead: 0.25,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "OpenAI API",
    sourceUrl: openAiPricingUrl,
  },
  "GPT 5.6 Luna": {
    input: 1,
    output: 6,
    cacheWrite: 1.25,
    cacheRead: 0.1,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "OpenAI API",
    sourceUrl: openAiPricingUrl,
  },
  "GPT 5.5": {
    input: 5,
    output: 30,
    cacheWrite: 0.5,
    cacheRead: 0.5,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "OpenAI API",
    sourceUrl: openAiPricingUrl,
  },
  "GPT 5.4": {
    input: 2.5,
    output: 15,
    cacheWrite: 0.25,
    cacheRead: 0.25,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "OpenAI API",
    sourceUrl: openAiPricingUrl,
  },
  "GPT 5.4 Mini": {
    input: 0.75,
    output: 4.5,
    cacheWrite: 0.075,
    cacheRead: 0.075,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "OpenAI API",
    sourceUrl: openAiPricingUrl,
  },
  "Codex Compact": unpricedOfficialModel("OpenAI API", openAiPricingUrl),
  "Gemini 3.5 Flash": {
    input: 1.5,
    output: 9,
    cacheWrite: null,
    cacheRead: null,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Google Gemini API",
    sourceUrl: geminiPricingUrl,
  },
  "Gemini 3.1 Pro": {
    input: 2,
    output: 12,
    cacheWrite: null,
    cacheRead: null,
    imageOutput: null,
    currency: "USD",
    sourceLabel: "Google Gemini API",
    sourceUrl: geminiPricingUrl,
  },
  "Grok 4.20": unpricedOfficialModel("xAI API", xaiModelsDocsUrl),
  "Grok 4.3": unpricedOfficialModel("xAI API", xaiModelsDocsUrl),
  "Grok 4.5": unpricedOfficialModel("xAI API", xaiGrok45DocsUrl),
  "Grok Build": unpricedOfficialModel("Grok Build", xaiModelsDocsUrl),
  "Composer 2.5": unpricedOfficialModel("Grok Build", xaiComposerNewsUrl),
  "GLM-5.2": {
    input: 8,
    output: 28,
    cacheWrite: null,
    cacheRead: 2,
    imageOutput: null,
    currency: "CNY",
    sourceLabel: "智谱 BigModel",
    sourceUrl: glmPricingUrl,
  },
  "GLM-5.1": {
    input: 6,
    output: 24,
    cacheWrite: null,
    cacheRead: 1.3,
    imageOutput: null,
    currency: "CNY",
    sourceLabel: "智谱 BigModel",
    sourceUrl: glmPricingUrl,
  },
  "DeepSeek V4 Flash": {
    input: 1,
    output: 2,
    cacheWrite: null,
    cacheRead: 0.02,
    imageOutput: null,
    currency: "CNY",
    sourceLabel: "DeepSeek API",
    sourceUrl: deepseekPricingUrl,
  },
  "DeepSeek V4 Pro": {
    input: 3,
    output: 6,
    cacheWrite: null,
    cacheRead: 0.025,
    imageOutput: null,
    currency: "CNY",
    sourceLabel: "DeepSeek API",
    sourceUrl: deepseekPricingUrl,
  },
  "Kimi K3": {
    input: 20,
    output: 100,
    cacheWrite: null,
    cacheRead: 2,
    imageOutput: null,
    currency: "CNY",
    sourceLabel: "Kimi API",
    sourceUrl: kimiK3PricingUrl,
  },
  "Qwen3.8-Max-Preview": unpricedOfficialModel("阿里云 Token Plan", qwenModelDocsUrl, "CNY"),
  "Qwen3.7-Max": {
    input: 12,
    output: 36,
    cacheWrite: null,
    cacheRead: null,
    imageOutput: null,
    currency: "CNY",
    sourceLabel: "阿里云百炼",
    sourceUrl: qwenPricingUrl,
  },
  "GPT Image 2": {
    input: 5,
    output: null,
    cacheWrite: null,
    cacheRead: 1.25,
    imageOutput: 30,
    currency: "USD",
    sourceLabel: "OpenAI API",
    sourceUrl: openAiPricingUrl,
  },
  "Grok Image": unpricedOfficialModel("xAI API", xaiImageDocsUrl),
  "Nano Banana Pro": unpricedOfficialModel("Google Gemini API", geminiImageGenerationUrl),
  "Nano Banana 2": unpricedOfficialModel("Google Gemini API", geminiImageGenerationUrl),
  "Nano Banana": unpricedOfficialModel("Google Gemini API", geminiImageGenerationUrl),
  "Nano Banana Lite": unpricedOfficialModel("Google Gemini API", geminiImageGenerationUrl),
  "Sora 2": unpricedOfficialModel("OpenAI Video API", openAiVideoGenerationUrl),
  "Sora 2 Pro": unpricedOfficialModel("OpenAI Video API", openAiVideoGenerationUrl),
  "Grok Video": unpricedOfficialModel("xAI API", xaiVideoDocsUrl),
  "Veo 3.1": unpricedOfficialModel("Google Gemini API", geminiModelDocsUrl),
  "Veo 3.1 Lite": unpricedOfficialModel("Google Gemini API", geminiModelDocsUrl),
  "Gemini Omni Flash": unpricedOfficialModel("Google Gemini API", geminiModelDocsUrl),
  "Seedance 2.0": unpricedOfficialModel("BytePlus ModelArk", seedanceDocsUrl),
  "HappyHorse 1.1 I2V": unpricedOfficialModel("Alibaba HappyHorse", happyHorseDocsUrl),
  "Kling 2.5 Turbo": unpricedOfficialModel("Kling API", klingDocsUrl),
};

export function getOfficialTransitModelPrice(
  standardModel: TransitModelPrice["standardModel"]
): TransitOfficialModelPrice {
  const price = TRANSIT_OFFICIAL_MODEL_PRICES[standardModel];
  if (!price) throw new Error(`Unknown API transit standard model: ${standardModel}`);
  return price;
}

export function getOfficialTransitUnitPrice(
  standardModel: TransitModelPrice["standardModel"],
  metric: TransitPriceMetric
): number | null {
  return getOfficialTransitModelPrice(standardModel)[metric];
}

export function getOfficialTransitUnitCurrency(
  standardModel: TransitModelPrice["standardModel"]
): TransitPriceCurrency {
  return getOfficialTransitModelPrice(standardModel).currency;
}

export function hasComparableTransitOfficialPrice(
  standardModel: TransitModelPrice["standardModel"]
): boolean {
  const price = getOfficialTransitModelPrice(standardModel);
  return [price.input, price.output, price.cacheRead, price.cacheWrite, price.imageOutput].some(
    (value) => value !== null && Number.isFinite(value) && value > 0
  );
}

export function getTransitSplitMultiplier(
  price: TransitModelPrice,
  metric: TransitPriceMetric
): number | null {
  if (metric === "input") return price.inputPrice ?? price.modelMultiplier;
  if (metric === "output") return price.outputPrice ?? price.modelMultiplier;
  if (metric === "imageOutput") return price.imageOutputPrice ?? price.modelMultiplier;
  if (metric === "cacheRead") return price.cacheReadPrice;

  if (price.cacheWritePrice !== null) return price.cacheWritePrice;

  const officialPrice = getOfficialTransitModelPrice(price.standardModel);
  if (
    officialPrice.cacheWrite !== null &&
    officialPrice.cacheRead !== null &&
    officialPrice.cacheWrite === officialPrice.cacheRead
  ) {
    return price.cacheReadPrice;
  }

  return null;
}

export function getTransitEffectiveMetricRate(
  station: TransitStation,
  price: TransitModelPrice,
  metric: TransitPriceMetric
): number | null {
  const coefficient =
    getRechargeCoefficientFromRatio(price.rechargeRatio) ??
    getStationRechargeCoefficient(station);
  const splitMultiplier = getTransitSplitMultiplier(price, metric);
  if (coefficient === null || splitMultiplier === null) return null;

  return coefficient * splitMultiplier;
}

export function getTransitConvertedUnitPrice(
  station: TransitStation,
  price: TransitModelPrice,
  metric: TransitPriceMetric
): number | null {
  const officialPrice = getOfficialTransitUnitPrice(price.standardModel, metric);
  const effectiveRate = getTransitEffectiveMetricRate(station, price, metric);
  if (officialPrice === null || effectiveRate === null) return null;

  return officialPrice * effectiveRate;
}

export function getFamilyPrices(
  station: TransitStation,
  family: TransitModelFamily
): TransitModelPrice[] {
  return station.prices.filter((price) => transitModelPriceMatchesFamily(price, family));
}

export function getStandardModelPrices(
  station: TransitStation,
  standardModel: TransitModelPrice["standardModel"]
): TransitModelPrice[] {
  return station.prices.filter((price) => price.standardModel === standardModel);
}

export function getFamilyAvailabilitySourceMeta(
  station: TransitStation,
  family: TransitModelFamily
): ReturnType<typeof getAvailabilitySourceMeta> {
  const prices = getFamilyPrices(station, family);
  const sorted = [...prices].sort(
    (left, right) =>
      availabilitySourcePriority(right.availability.sourceType) -
      availabilitySourcePriority(left.availability.sourceType)
  );
  const price = sorted.find((item) => item.availability.sourceType !== "unknown") || sorted[0];
  return price ? getTransitPriceAvailabilitySourceMeta(station, price) : getAvailabilitySourceMeta(station.availability);
}

export function getStandardModelAvailabilitySourceMeta(
  station: TransitStation,
  standardModel: TransitModelPrice["standardModel"]
): ReturnType<typeof getAvailabilitySourceMeta> {
  const prices = getStandardModelPrices(station, standardModel);
  const sorted = [...prices].sort(
    (left, right) =>
      availabilitySourcePriority(right.availability.sourceType) -
      availabilitySourcePriority(left.availability.sourceType)
  );
  const price = sorted.find((item) => item.availability.sourceType !== "unknown") || sorted[0];
  return price ? getTransitPriceAvailabilitySourceMeta(station, price) : getAvailabilitySourceMeta(station.availability);
}

function availabilitySourcePriority(sourceType: TransitModelPrice["availability"]["sourceType"]): number {
  switch (sourceType) {
    case "station_monitor":
      return 6;
    case "public_status":
      return 6;
    case "priceai_probe":
      return 5;
    case "public_model_catalog":
      return 4;
    case "partner_api":
      return 3;
    case "merchant_reported":
      return 2;
    case "manual_snapshot":
      return 1;
    default:
      return 0;
  }
}

export function getTransitPriceAvailabilitySource(
  station: TransitStation,
  price: TransitModelPrice
): Pick<TransitAvailability, "sourceType" | "sourceLabel" | "sourceUrl"> {
  if (
    price.availability.sourceType === "station_monitor" ||
    price.availability.sourceType === "public_status"
  ) {
    return {
      sourceType: price.availability.sourceType,
      sourceLabel: price.availability.sourceLabel,
      sourceUrl: price.availability.sourceUrl,
    };
  }

  const publicMonitorUrl = publicMonitorAvailabilityUrl(station);
  if (publicMonitorUrl) {
    const stationMonitor = station.availability.sourceType === "station_monitor";
    return {
      sourceType: stationMonitor ? "station_monitor" : "public_status",
      sourceLabel: stationMonitor
        ? station.availability.sourceLabel || "Sub2API 站方监测"
        : station.availability.sourceType === "public_status"
          ? station.availability.sourceLabel
          : "公开监测页",
      sourceUrl: publicMonitorUrl,
    };
  }

  return {
    sourceType: price.availability.sourceType,
    sourceLabel: price.availability.sourceLabel,
    sourceUrl: price.availability.sourceUrl,
  };
}

export function getTransitPriceAvailabilitySourceMeta(
  station: TransitStation,
  price: TransitModelPrice
): ReturnType<typeof getAvailabilitySourceMeta> {
  return getAvailabilitySourceMeta(getTransitPriceAvailabilitySource(station, price));
}

export function getTransitAvailabilityRollupPrices(
  station: TransitStation,
  prices: TransitModelPrice[]
): TransitModelPrice[] {
  const grouped = new Map<string, TransitModelPrice[]>();
  for (const price of prices) {
    const key = [price.standardModel, price.groupName || "默认分组"].join("|");
    grouped.set(key, [...(grouped.get(key) || []), price]);
  }

  const representatives = Array.from(grouped.values())
    .map((group) => [...group].sort((left, right) => compareTransitAvailabilityRollupPrice(station, left, right))[0])
    .filter((price): price is TransitModelPrice => Boolean(price));
  const byEvidence = new Map<string, TransitModelPrice>();
  for (const price of representatives) {
    const key = getTransitAvailabilityEvidenceKey(station, price);
    const existing = byEvidence.get(key);
    if (!existing || compareTransitAvailabilityRollupPrice(station, price, existing) < 0) {
      byEvidence.set(key, price);
    }
  }
  return Array.from(byEvidence.values());
}

export function getPreferredTransitAvailabilityRollupPrices(
  station: TransitStation,
  prices: TransitModelPrice[],
  rankingScope: TransitAvailabilityRankingScope = "offer"
): TransitModelPrice[] {
  const pricesWithEvidence = prices.filter((price) => hasValidTransitAvailabilityEvidence(price.availability));
  const availabilityPrices = getTransitAvailabilityRollupPrices(
    station,
    pricesWithEvidence.length ? pricesWithEvidence : prices
  );
  const directEvidence = availabilityPrices.filter(
    (price) => !isTransitAvailabilityReferenceForRankingScope(price.availability, rankingScope)
  );
  return directEvidence.length ? directEvidence : availabilityPrices;
}

function hasValidTransitAvailabilityEvidence(
  availability: Pick<TransitAvailability, "sevenDayRate" | "sevenDaySamples">
): boolean {
  return (
    availability.sevenDayRate !== null &&
    Number.isFinite(availability.sevenDayRate) &&
    availability.sevenDaySamples > 0
  );
}

export type TransitAvailabilityRankingScope = "station" | "family" | "model" | "offer";

export function isTransitAvailabilityReferenceForRankingScope(
  availability: Pick<TransitAvailability, "matchLevel" | "note" | "sourceType">,
  rankingScope: TransitAvailabilityRankingScope
): boolean {
  if (availability.sourceType === "public_model_catalog") return true;
  const matchLevel = getTransitAvailabilityMatchLevel(availability);
  if (matchLevel === "family") return true;
  if (matchLevel === "model") return rankingScope === "offer";
  return false;
}

export function getTransitAvailabilityMatchLevel(
  availability: Pick<TransitAvailability, "matchLevel" | "note" | "sourceType">
): NonNullable<TransitAvailability["matchLevel"]> {
  if (availability.matchLevel) return availability.matchLevel;
  const note = availability.note || "";
  if (/同模型族参考/.test(note)) return "family";
  if (/同模型监测|performance summary|uptime14d/i.test(note)) return "model";
  if (/同分组监测/.test(note)) return "group";
  if (availability.sourceType === "public_model_catalog") return "model";
  if (availability.sourceType === "public_status") return "group";
  return "exact";
}

export function getTransitAvailabilityScope(
  availability: Pick<TransitAvailability, "scope" | "matchLevel" | "note" | "sourceType">
): NonNullable<TransitAvailability["scope"]> {
  if (availability.scope) return availability.scope;
  const matchLevel = getTransitAvailabilityMatchLevel(availability);
  if (matchLevel === "group") return "group";
  if (matchLevel === "model" || matchLevel === "family" || availability.sourceType === "public_model_catalog") {
    return "model";
  }
  return availability.sourceType === "priceai_probe" ? "offer" : "offer";
}

export function isTransitAvailabilityReference(
  availability: Pick<TransitAvailability, "matchLevel" | "note" | "sourceType">
): boolean {
  const matchLevel = getTransitAvailabilityMatchLevel(availability);
  return matchLevel === "model" || matchLevel === "family";
}

function getTransitAvailabilityEvidenceKey(station: TransitStation, price: TransitModelPrice): string {
  const availability = price.availability;
  if (availability.monitoringScopeId) return availability.monitoringScopeId;
  const scope = getTransitAvailabilityScope(availability);
  const matchLevel = getTransitAvailabilityMatchLevel(availability);
  const scopeKey =
    scope === "station" ? station.id :
      scope === "group" ? price.groupName :
        scope === "model" && matchLevel === "family" ? price.family :
          scope === "model" ? price.standardModel :
            `${price.groupName}|${price.standardModel}`;
  return [station.id, availability.sourceType, availability.sourceUrl || "", scope, scopeKey].join("|");
}

function compareTransitAvailabilityRollupPrice(
  station: TransitStation,
  left: TransitModelPrice,
  right: TransitModelPrice
): number {
  return (
    availabilityMatchLevelPriority(right.availability) - availabilityMatchLevelPriority(left.availability) ||
    availabilitySourcePriority(right.availability.sourceType) -
      availabilitySourcePriority(left.availability.sourceType) ||
    right.availability.sevenDaySamples - left.availability.sevenDaySamples ||
    timestampSortValue(right.availability.lastCheckedAt || right.lastVerifiedAt) -
      timestampSortValue(left.availability.lastCheckedAt || left.lastVerifiedAt) ||
    compareTransitModelPriority(left, right) ||
    compareNullableNumber(
      getCombinedRateForPrice(station, left),
      getCombinedRateForPrice(station, right),
      "asc"
    )
  );
}

function availabilityMatchLevelPriority(availability: TransitAvailability): number {
  switch (getTransitAvailabilityMatchLevel(availability)) {
    case "exact":
      return 4;
    case "group":
      return 3;
    case "model":
      return 2;
    case "family":
      return 1;
  }
}

export type TransitFamilyRateSummary = {
  family: TransitModelFamily;
  familyLabel: string;
  priceCount: number;
  modelMultiplierMin: number | null;
  modelMultiplierMax: number | null;
  fixedPriceMin: number | null;
  fixedPriceMax: number | null;
  combinedRateMin: number | null;
  combinedRateMax: number | null;
  sevenDayRate: number | null;
  sevenDaySamples: number;
  firstCheckedAt: string | null;
  lastCheckedAt: string | null;
  recentSamples?: TransitAvailability["recentSamples"];
  latestLatencyMs: number | null;
  avgLatency7dMs: number | null;
  referenceOnly: boolean;
};

export type TransitAvailabilityRollup = Pick<
  TransitAvailability,
  | "sevenDayRate"
  | "sevenDaySamples"
  | "firstCheckedAt"
  | "lastCheckedAt"
  | "recentSamples"
  | "latestLatencyMs"
  | "avgLatency7dMs"
  | "sourceType"
  | "sourceLabel"
  | "sourceUrl"
> & {
  note?: string;
  referenceOnly: boolean;
};

export type TransitAvailabilityBarTone = "good" | "warn" | "bad" | "empty";

export type TransitAvailabilityFreshnessState = "fresh" | "delayed" | "stale" | "empty";

export type TransitAvailabilityPresentation = {
  availability: TransitAvailabilityRollup;
  freshness: TransitAvailabilityFreshnessState;
  replacedPublicEvidence: TransitAvailabilityRollup | null;
};

const TRANSIT_AVAILABILITY_DELAYED_AFTER_MS = 2 * 60 * 60 * 1000;
const TRANSIT_AVAILABILITY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function getTransitAvailabilityFreshness(
  availability: Pick<TransitAvailability, "lastCheckedAt" | "sevenDaySamples">,
  now: string | number | Date = Date.now(),
  station?: Pick<TransitStation, "collectionStatus" | "collectionError">,
): TransitAvailabilityFreshnessState {
  return getTransitEvidenceFreshness(
    availability.lastCheckedAt,
    availability.sevenDaySamples > 0,
    now,
    station,
  );
}

function getTransitEvidenceFreshness(
  verifiedAt: string | null | undefined,
  hasEvidence: boolean,
  now: string | number | Date,
  station?: Pick<TransitStation, "collectionStatus" | "collectionError">,
): TransitAvailabilityFreshnessState {
  if (!hasEvidence || !verifiedAt) return "empty";
  const checkedAt = parseAvailabilityTimestamp(verifiedAt);
  const referenceAt = rankingTimestamp(now);
  if (checkedAt === null || !Number.isFinite(referenceAt)) return "empty";

  const age = Math.max(0, referenceAt - checkedAt);
  if (age <= TRANSIT_AVAILABILITY_DELAYED_AFTER_MS) return "fresh";
  if (age > TRANSIT_AVAILABILITY_STALE_AFTER_MS) return "stale";

  const permanentSourceError =
    station?.collectionStatus === "failed" && /(?:^|\D)(?:404|410)(?:\D|$)/.test(station.collectionError || "");
  return permanentSourceError ? "stale" : "delayed";
}

export function getTransitStationAvailabilityPresentation(
  station: TransitStation,
  publishedAvailability: TransitAvailabilityRollup,
  now: string | number | Date = Date.now(),
): TransitAvailabilityPresentation {
  const publishedFreshness = getTransitAvailabilityFreshness(publishedAvailability, now, station);
  const probe = station.availability;
  const probeFreshness = getTransitAvailabilityFreshness(probe, now);

  if (
    publishedFreshness !== "fresh" &&
    publishedAvailability.sourceType !== "priceai_probe" &&
    probe.sourceType === "priceai_probe" &&
    probeFreshness === "fresh"
  ) {
    return {
      availability: {
        ...probe,
        firstCheckedAt: probe.firstCheckedAt ?? null,
        recentSamples: normalizeRecentAvailabilitySamples(
          transitAvailabilityRecentSamples(probe) || [],
        ),
        latestLatencyMs: probe.latestLatencyMs ?? null,
        avgLatency7dMs: probe.avgLatency7dMs ?? null,
        referenceOnly: false,
      },
      freshness: "fresh",
      replacedPublicEvidence: publishedAvailability,
    };
  }

  return {
    availability: publishedAvailability,
    freshness: publishedFreshness,
    replacedPublicEvidence: null,
  };
}

export function getRecentTransitAvailabilitySamples(
  prices: TransitModelPrice[]
): TransitAvailability["recentSamples"] {
  return normalizeRecentAvailabilitySamples(
    prices.flatMap((price) => transitAvailabilityRecentSamples(price.availability) || [])
  );
}

export function compactTransitStationsForList(stations: TransitStation[]): TransitStation[] {
  return stations.map((station) => ({
    ...station,
    apiBaseUrl: undefined,
    paymentMethods: [],
    balanceExpiry: null,
    supportChannels: [],
    refundPolicy: null,
    strengths: undefined,
    cautions: undefined,
    availability: compactTransitAvailability(station.availability),
    prices: station.prices.map((price) => ({
      ...price,
      history: undefined,
      availability: compactTransitAvailability(price.availability),
    })),
    feedback: {
      ...station.feedback,
      publicNotes: null,
    },
    commercialOffers: station.commercialOffers?.filter((offer) => offer.enabled).slice(0, 2),
    verificationEvents: station.verificationEvents?.slice(-4),
  }));
}

function compactTransitAvailability(availability: TransitAvailability): TransitAvailability {
  const { recentSampleBits: _recentSampleBits, ...rest } = availability;
  void _recentSampleBits;
  const samples = normalizeRecentAvailabilitySamples(transitAvailabilityRecentSamples(rest) || []);
  return {
    ...rest,
    recentSamples: samples,
  };
}

function transitAvailabilityRecentSamples(
  availability: Pick<TransitAvailability, "recentSamples" | "recentSampleBits">,
): TransitAvailability["recentSamples"] {
  if (availability.recentSamples?.length) return availability.recentSamples;
  const bits = availability.recentSampleBits;
  if (!bits || !/^[01]+$/.test(bits)) return undefined;
  return bits.slice(-TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIMIT).split("").map((bit) => ({
    ok: bit === "1",
    checkedAt: null,
  }));
}

export type TransitRecentAvailabilitySampleLookupScope = {
  standardModel: string;
  groupName: string;
  family: TransitModelFamily | null;
  level: "exact" | "group" | "model" | "family" | "station";
};

export function getTransitRecentAvailabilitySampleLookupScopes(
  standardModel: string,
  groupName: string,
  options: { includeStationFallback?: boolean } = {}
): TransitRecentAvailabilitySampleLookupScope[] {
  const scopes: TransitRecentAvailabilitySampleLookupScope[] = [];
  const seen = new Set<string>();
  const normalizedStandardModel = standardModel || "";
  const normalizedGroupName = groupName || "";
  const family = isTransitStandardModel(normalizedStandardModel)
    ? TRANSIT_STANDARD_MODEL_FAMILY[normalizedStandardModel]
    : null;
  const pushScope = (
    nextStandardModel: string,
    nextGroupName: string,
    nextFamily: TransitModelFamily | null,
    level: TransitRecentAvailabilitySampleLookupScope["level"]
  ) => {
    const key = `${nextStandardModel}|${nextGroupName}|${nextFamily || ""}|${level}`;
    if (seen.has(key)) return;
    seen.add(key);
    scopes.push({ standardModel: nextStandardModel, groupName: nextGroupName, family: nextFamily, level });
  };

  if (normalizedStandardModel && normalizedGroupName) {
    pushScope(normalizedStandardModel, normalizedGroupName, null, "exact");
  }
  if (normalizedGroupName) pushScope("", normalizedGroupName, null, "group");
  if (normalizedStandardModel) pushScope(normalizedStandardModel, "", null, "model");
  if (family) pushScope("", "", family, "family");
  if (options.includeStationFallback) pushScope("", "", null, "station");

  return scopes;
}

function normalizeRecentAvailabilitySamples(
  samples: NonNullable<TransitAvailability["recentSamples"]>
): TransitAvailability["recentSamples"] {
  if (!samples.length) return undefined;
  return samples
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

export function buildTransitAvailabilityBars({
  rate,
  samples,
  recentSamples,
}: {
  rate: number | null;
  samples: number;
  firstCheckedAt?: string | null;
  lastCheckedAt?: string | null;
  recentSamples?: TransitAvailability["recentSamples"];
}): TransitAvailabilityBarTone[] {
  if (recentSamples?.length) return buildRecentAvailabilityBars(recentSamples);

  return buildSummaryAvailabilityBars({ rate, samples });
}

function buildSummaryAvailabilityBars({
  rate,
  samples,
}: {
  rate: number | null;
  samples: number;
}): TransitAvailabilityBarTone[] {
  const total = TRANSIT_RECENT_AVAILABILITY_BAR_COUNT;
  if (rate === null || samples <= 0) return Array(total).fill("empty");
  const sampleBars = Math.max(
    1,
    Math.min(
      total,
      Math.ceil(Math.min(samples, TRANSIT_RECENT_AVAILABILITY_SAMPLE_LIMIT) / TRANSIT_RECENT_AVAILABILITY_GROUP_SIZE)
    )
  );

  const clamped = Math.max(0, Math.min(1, rate));
  return Array.from({ length: total }, (_, index) => {
    if (index >= sampleBars) return "empty";
    const expectedGoodCount = Math.round(clamped * (index + 1));
    const previousGoodCount = Math.round(clamped * index);
    if (expectedGoodCount > previousGoodCount) return "good";
    return clamped >= 0.75 ? "warn" : "bad";
  });
}

function buildRecentAvailabilityBars(
  samples: NonNullable<TransitAvailability["recentSamples"]>
): TransitAvailabilityBarTone[] {
  const recent = normalizeRecentAvailabilitySamples(samples) || [];
  const bars: TransitAvailabilityBarTone[] = Array(TRANSIT_RECENT_AVAILABILITY_BAR_COUNT).fill("empty");
  if (!recent.length) return bars;

  const groupCount = Math.ceil(recent.length / TRANSIT_RECENT_AVAILABILITY_GROUP_SIZE);
  const firstGroupSize = recent.length % TRANSIT_RECENT_AVAILABILITY_GROUP_SIZE || TRANSIT_RECENT_AVAILABILITY_GROUP_SIZE;
  let cursor = 0;

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const groupSize = groupIndex === 0 ? firstGroupSize : TRANSIT_RECENT_AVAILABILITY_GROUP_SIZE;
    const group = recent.slice(cursor, cursor + groupSize);
    bars[groupIndex] = availabilityToneForSampleGroup(group);
    cursor += groupSize;
  }

  return bars;
}

function availabilityToneForSampleGroup(
  group: NonNullable<TransitAvailability["recentSamples"]>
): TransitAvailabilityBarTone {
  if (!group.length) return "empty";
  const okCount = group.filter((sample) => sample.ok).length;
  if (okCount === group.length) return "good";
  if (okCount === 0) return "bad";
  return "warn";
}

function parseAvailabilityTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(" ", "T") : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampSortValue(value: string | null | undefined): number {
  return parseAvailabilityTimestamp(value) ?? Number.NEGATIVE_INFINITY;
}

function summarizeRateScope(
  station: TransitStation,
  family: TransitModelFamily,
  prices: TransitModelPrice[],
  options: {
    rollupByGroup?: boolean;
    rankingScope?: Extract<TransitAvailabilityRankingScope, "family" | "model">;
  } = {}
): TransitFamilyRateSummary {
  const scopePrices = options.rollupByGroup ? getRepresentativePricesByGroup(prices) : prices;
  const rankingScope = options.rankingScope ?? "family";
  const availabilityPrices = getPreferredTransitAvailabilityRollupPrices(station, prices, rankingScope);
  const multipliers = scopePrices
    .map((price) => price.modelMultiplier)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const fixedPrices = scopePrices
    .flatMap((price) => fixedPriceValues(price))
    .filter((value): value is number => Number.isFinite(value) && value > 0);
  const combinedRates = scopePrices
    .map((price) => getCombinedRateForPrice(station, price))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const availabilitySamples = availabilityPrices.reduce(
    (total, price) => total + price.availability.sevenDaySamples,
    0
  );
  const weightedAvailability =
    availabilitySamples > 0
      ? availabilityPrices.reduce((total, price) => {
          const rate = price.availability.sevenDayRate ?? 0;
          return total + rate * price.availability.sevenDaySamples;
        }, 0) / availabilitySamples
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
  const latestLatencyMs = latestLatencyFromPrices(availabilityPrices);
  const avgLatency7dMs = weightedAverageLatency(availabilityPrices);
  const recentSamples = getRecentTransitAvailabilitySamples(availabilityPrices);
  const referenceOnly =
    availabilitySamples > 0 && availabilityPrices.every((price) =>
      isTransitAvailabilityReferenceForRankingScope(price.availability, rankingScope)
    );

  return {
    family,
    familyLabel: TRANSIT_MODEL_FAMILY_LABELS[family],
    priceCount: prices.length,
    modelMultiplierMin: multipliers.length ? Math.min(...multipliers) : null,
    modelMultiplierMax: multipliers.length ? Math.max(...multipliers) : null,
    fixedPriceMin: fixedPrices.length ? Math.min(...fixedPrices) : null,
    fixedPriceMax: fixedPrices.length ? Math.max(...fixedPrices) : null,
    combinedRateMin: combinedRates.length ? Math.min(...combinedRates) : null,
    combinedRateMax: combinedRates.length ? Math.max(...combinedRates) : null,
    sevenDayRate: weightedAvailability,
    sevenDaySamples: availabilitySamples,
    firstCheckedAt,
    lastCheckedAt,
    recentSamples,
    latestLatencyMs,
    avgLatency7dMs,
    referenceOnly,
  };
}

export function getFamilyRateSummary(
  station: TransitStation,
  family: TransitModelFamily
): TransitFamilyRateSummary {
  return summarizeRateScope(station, family, getFamilyPrices(station, family), {
    rollupByGroup: true,
    rankingScope: "family",
  });
}

export function getStandardModelRateSummary(
  station: TransitStation,
  standardModel: TransitModelPrice["standardModel"]
): TransitFamilyRateSummary {
  return summarizeRateScope(
    station,
    TRANSIT_STANDARD_MODEL_FAMILY[standardModel],
    getStandardModelPrices(station, standardModel),
    { rankingScope: "model" }
  );
}

function getRepresentativePricesByGroup(prices: TransitModelPrice[]): TransitModelPrice[] {
  const grouped = new Map<string, TransitModelPrice[]>();
  for (const price of prices) {
    const groupName = price.groupName || "默认分组";
    const groupPrices = grouped.get(groupName) || [];
    groupPrices.push(price);
    grouped.set(groupName, groupPrices);
  }

  return Array.from(grouped.values())
    .map(getRepresentativeTransitPrice)
    .filter((price): price is TransitModelPrice => price !== null);
}

export type TransitStationComparisonSummary = {
  station: TransitStation;
  families: Record<TransitModelFamily, TransitFamilyRateSummary>;
  claude: TransitFamilyRateSummary;
  gpt: TransitFamilyRateSummary;
  availability: TransitAvailabilityRollup;
  bestCombinedRate: number | null;
  stabilityRate: number | null;
  stabilitySamples: number;
};

export function getStationComparisonSummary(
  station: TransitStation
): TransitStationComparisonSummary {
  return getStationComparisonSummaryForPrices(station, station.prices, TRANSIT_MODEL_FAMILY_ORDER);
}

export function getTextStationComparisonSummary(
  station: TransitStation
): TransitStationComparisonSummary {
  const prices = getTransitTextModelPrices(station.prices);
  return getStationComparisonSummaryForPrices(station, prices, TRANSIT_TEXT_MODEL_FAMILY_ORDER);
}

export function getTransitTextModelPrices(prices: TransitModelPrice[]): TransitModelPrice[] {
  return prices.filter((price) => isTransitTextModelFamily(price.family));
}

function getStationComparisonSummaryForPrices(
  station: TransitStation,
  prices: TransitModelPrice[],
  availabilityFamilies: readonly TransitModelFamily[],
): TransitStationComparisonSummary {
  const families = TRANSIT_MODEL_FAMILY_ORDER.reduce(
    (accumulator, family) => ({
      ...accumulator,
      [family]: summarizeRateScope(
        station,
        family,
        prices.filter((price) => price.family === family),
        { rollupByGroup: true, rankingScope: "family" },
      ),
    }),
    {} as Record<TransitModelFamily, TransitFamilyRateSummary>
  );
  const scopedFamilies = availabilityFamilies.map((family) => families[family]);
  const combinedRates = scopedFamilies.map((summary) => summary.combinedRateMin).filter(
    (value): value is number => value !== null
  );
  const bestCombinedRate = combinedRates.length ? Math.min(...combinedRates) : null;
  const availability = getStationPublishedAvailabilitySummary(station, scopedFamilies, prices);
  const stabilityRate = availability.sevenDayRate;
  const stabilitySamples = availability.sevenDaySamples;

  return {
    station,
    families,
    claude: families.claude,
    gpt: families.gpt,
    availability,
    bestCombinedRate,
    stabilityRate,
    stabilitySamples,
  };
}

export function getStationPublishedAvailabilitySummary(
  station: TransitStation,
  familySummaries?: TransitFamilyRateSummary[],
  prices: TransitModelPrice[] = station.prices,
): TransitAvailabilityRollup {
  const availabilityPrices = getPreferredTransitAvailabilityRollupPrices(station, prices, "station");
  const hasRankablePriceEvidence = availabilityPrices.some((price) =>
    !isTransitAvailabilityReferenceForRankingScope(price.availability, "station")
  );
  if (!hasRankablePriceEvidence && hasDirectStationAvailabilityEvidence(station.availability)) {
    const recentSamples = normalizeRecentAvailabilitySamples(
      transitAvailabilityRecentSamples(station.availability) || []
    );
    return {
      sevenDayRate: station.availability.sevenDayRate,
      sevenDaySamples: station.availability.sevenDaySamples,
      firstCheckedAt: station.availability.firstCheckedAt ?? null,
      lastCheckedAt: station.availability.lastCheckedAt,
      recentSamples,
      latestLatencyMs: station.availability.latestLatencyMs ?? null,
      avgLatency7dMs: station.availability.avgLatency7dMs ?? null,
      note: station.availability.note ?? "使用站点整体公开监测。",
      sourceType: station.availability.sourceType,
      sourceLabel: station.availability.sourceLabel,
      sourceUrl: station.availability.sourceUrl,
      referenceOnly: false,
    };
  }
  const samples = availabilityPrices.reduce(
    (total, price) => total + price.availability.sevenDaySamples,
    0
  );

  if (!samples) {
    const source = getStationPublishedAvailabilitySourceMeta(station);
    return {
      sevenDayRate: null,
      sevenDaySamples: 0,
      firstCheckedAt: null,
      lastCheckedAt: null,
      latestLatencyMs: null,
      avgLatency7dMs: null,
      note: "当前公开模型暂无可用性样本。",
      sourceType: source.sourceType,
      sourceLabel: source.sourceLabel,
      sourceUrl: source.sourceUrl,
      referenceOnly: false,
    };
  }

  const weightedRate = availabilityPrices.reduce((total, price) => {
    const rate = price.availability.sevenDayRate ?? 0;
    return total + rate * price.availability.sevenDaySamples;
  }, 0) / samples;
  const source = getStationPublishedAvailabilitySourceMeta(station);
  const firstCheckedAt =
    availabilityPrices
      .map((price) => price.availability.firstCheckedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(0) ?? null;
  const lastCheckedAt =
    availabilityPrices
      .map((price) => price.availability.lastCheckedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const stationRecentSamples = normalizeRecentAvailabilitySamples(
    transitAvailabilityRecentSamples(station.availability) || []
  );
  const summaryRecentSamples = getRecentTransitAvailabilitySamples(availabilityPrices);
  const latencyFamilies = familySummaries ?? TRANSIT_MODEL_FAMILY_ORDER.map((family) =>
    getFamilyRateSummary(station, family)
  );

  return {
    sevenDayRate: roundAvailabilityRate(weightedRate),
    sevenDaySamples: samples,
    firstCheckedAt,
    lastCheckedAt,
    recentSamples: stationRecentSamples || summaryRecentSamples,
    latestLatencyMs: averageFamilyLatency(latencyFamilies, "latestLatencyMs"),
    avgLatency7dMs: averageFamilyLatency(latencyFamilies, "avgLatency7dMs"),
    note: `按当前公开模型分组汇总：${formatPercent(roundAvailabilityRate(weightedRate))} · 样本 ${samples}`,
    sourceType: source.sourceType,
    sourceLabel: source.sourceLabel,
    sourceUrl: source.sourceUrl,
    referenceOnly: availabilityPrices.every((price) =>
      isTransitAvailabilityReferenceForRankingScope(price.availability, "station")
    ),
  };
}

function hasDirectStationAvailabilityEvidence(availability: TransitAvailability): boolean {
  return (
    getTransitAvailabilityScope(availability) === "station" &&
    getTransitAvailabilityMatchLevel(availability) === "exact" &&
    availability.sourceType !== "public_model_catalog" &&
    availability.sevenDayRate !== null &&
    Number.isFinite(availability.sevenDayRate) &&
    availability.sevenDaySamples > 0
  );
}

function averageFamilyLatency(
  summaries: TransitFamilyRateSummary[],
  field: "latestLatencyMs" | "avgLatency7dMs"
): number | null {
  const values = summaries
    .filter((summary) => summary.sevenDaySamples > 0)
    .map((summary) => summary[field])
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function getStationPublishedAvailabilitySourceMeta(station: TransitStation): Pick<
  TransitAvailability,
  "sourceType" | "sourceLabel" | "sourceUrl"
> {
  const stationMonitorPrice = station.prices.find(
    (item) => item.availability.sourceType === "station_monitor" && item.availability.sevenDaySamples > 0
  );
  if (stationMonitorPrice) {
    return {
      sourceType: stationMonitorPrice.availability.sourceType,
      sourceLabel: stationMonitorPrice.availability.sourceLabel,
      sourceUrl: stationMonitorPrice.availability.sourceUrl,
    };
  }

  const publicStatusPrice = station.prices.find(
    (item) => item.availability.sourceType === "public_status" && item.availability.sevenDaySamples > 0
  );
  if (publicStatusPrice) {
    return {
      sourceType: publicStatusPrice.availability.sourceType,
      sourceLabel: publicStatusPrice.availability.sourceLabel,
      sourceUrl: publicStatusPrice.availability.sourceUrl,
    };
  }

  const publicMonitorUrl = publicMonitorAvailabilityUrl(station);
  if (publicMonitorUrl) {
    const stationMonitor = station.availability.sourceType === "station_monitor";
    return {
      sourceType: stationMonitor ? "station_monitor" : "public_status",
      sourceLabel: stationMonitor
        ? station.availability.sourceLabel || "Sub2API 站方监测"
        : station.availability.sourceType === "public_status"
          ? station.availability.sourceLabel
          : "公开监测页",
      sourceUrl: publicMonitorUrl,
    };
  }

  const prices = [...station.prices].sort(
    (left, right) =>
      availabilitySourcePriority(right.availability.sourceType) -
      availabilitySourcePriority(left.availability.sourceType)
  );
  const price = prices.find((item) => item.availability.sourceType !== "unknown") || prices[0];
  if (!price) {
    return {
      sourceType: station.availability.sourceType,
      sourceLabel: station.availability.sourceLabel,
      sourceUrl: station.availability.sourceUrl,
    };
  }

  return {
    sourceType: price.availability.sourceType,
    sourceLabel: price.availability.sourceLabel,
    sourceUrl: price.availability.sourceUrl,
  };
}

function publicMonitorAvailabilityUrl(station: TransitStation): string | null {
  if (station.availability.sourceType === "station_monitor" && station.availability.sourceUrl) {
    return station.availability.sourceUrl;
  }
  if (station.availability.sourceType === "public_status" && station.availability.sourceUrl) {
    return station.availability.sourceUrl;
  }
  if (isPublicMonitorAvailabilityUrl(station.availability.sourceUrl)) return station.availability.sourceUrl;
  if (isPublicMonitorAvailabilityUrl(station.monitorUrl)) return station.monitorUrl;
  return null;
}

function isPublicMonitorAvailabilityUrl(value: string | null | undefined): value is string {
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

function roundAvailabilityRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function getTransitStationSystem(station: TransitStation): TransitStationSystem {
  if (station.stationSystem && station.stationSystem !== "unknown") return station.stationSystem;

  const text = [
    station.collectorKind,
    station.id,
    station.slug,
    station.name,
    station.websiteUrl,
  ].filter(Boolean).join(" ").toLowerCase();

  if (
    text.includes("sub2api") ||
    text.includes("sub-to-api") ||
    text.includes("sub_to_api") ||
    text.includes("subway") ||
    text.includes("apinode_public_site_info") ||
    text.includes("callai_partner_status")
  ) {
    return "sub_to_api";
  }

  if (text.includes("onehop") || text.includes("onehop_public_models")) {
    return "custom";
  }

  if (text.includes("new_api") || text.includes("new-api") || text.includes("new api")) {
    return "new_api";
  }

  if (station.collectorKind?.includes("new_api")) return "new_api";
  return "custom";
}

export function getTransitStationSystemLabel(station: TransitStation): string {
  const system = getTransitStationSystem(station);
  if (system === "new_api") return "New API";
  if (system === "sub_to_api") return "Sub2API";
  if (system === "custom") return "自研";
  return "未知";
}

export function getTransitOperatorType(station: TransitStation): TransitOperatorType {
  return station.operatorType === "company" ? "company" : "individual";
}

export function getNormalizedSourceTags(
  station: TransitStation
): { id: string; label: string; tone: "neutral" | "warn" }[] {
  const channelTypes = getExplicitTransitChannelTypes(station);
  const primary = sourceChannelPriority.filter((type) => channelTypes.includes(type));
  const tags = primary.map((type) => ({
    id: `channel-${type}`,
    label: TRANSIT_CHANNEL_TYPE_LABELS[type],
    tone: type === "undisclosed" ? "warn" as const : "neutral" as const,
  }));

  return dedupeTags(tags);
}

export function getTransitReviewTags(
  station: TransitStation
): { id: string; label: string; tone: "warn" | "danger" | "neutral" }[] {
  const tags: { id: string; label: string; tone: "warn" | "danger" | "neutral" }[] = [];

  if (station.feedback.pendingCount > 0) tags.push({ id: "pending-feedback", label: "反馈待核验", tone: "warn" });
  if (station.riskLabels.includes("reseller")) tags.push({ id: "reseller", label: "二级分销", tone: "warn" });
  if (station.riskLabels.includes("third_party_aggregate")) tags.push({ id: "third-party-risk", label: "渠道来源需复核", tone: "warn" });

  return dedupeTags(tags);
}

export function getEffectiveTransitChannelTypes(station: TransitStation): TransitChannelType[] {
  return getExplicitTransitChannelTypes(station);
}

function getExplicitTransitChannelTypes(station: TransitStation): TransitChannelType[] {
  return sourceChannelPriority.filter((type) => station.channelTypes.includes(type));
}

export function getActiveTransitCommercialOffers(
  station: TransitStation
): TransitCommercialOffer[] {
  return (station.commercialOffers || [])
    .filter((offer) => offer.enabled)
    .map(withTransitCommercialOfferDisclosure);
}

export function hasTransitAffRelation(station: TransitStation): boolean {
  return station.commercialRelation === "affiliate" ||
    getActiveTransitCommercialOffers(station).some((offer) => offer.type === "affiliate");
}

export function getTransitStationOutboundUrl(
  station: TransitStation,
  offer: TransitCommercialOffer | null | undefined
): string {
  return offer?.url || station.websiteUrl;
}

export function isTransitStationOutboundAff(
  station: TransitStation,
  offer: TransitCommercialOffer | null | undefined
): boolean {
  return Boolean(offer?.url) &&
    (station.commercialRelation === "affiliate" || offer?.type === "affiliate");
}

export function getPrimaryTransitCommercialOffer(
  station: TransitStation
): TransitCommercialOffer | null {
  const offers = getActiveTransitCommercialOffers(station);
  return offers.find((offer) => offer.type === "coupon") ?? offers[0] ?? null;
}

export function getPrimaryTransitOutboundOffer(
  station: TransitStation
): TransitCommercialOffer | null {
  const offers = getActiveTransitCommercialOffers(station).filter((offer) => Boolean(offer.url));
  return offers.find((offer) => offer.type === "affiliate") ?? offers[0] ?? null;
}

export function withTransitCommercialOfferDisclosure(
  offer: TransitCommercialOffer
): TransitCommercialOffer {
  if (!offer.enabled) return { ...offer, disclosure: null };
  return {
    ...offer,
    disclosure: normalizedTransitCommercialOfferDisclosure(offer.disclosure),
  };
}

export function normalizedTransitCommercialOfferDisclosure(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text || isLegacyTransitCommercialOfferDisclosure(text)) {
    return TRANSIT_DEFAULT_COMMERCIAL_OFFER_DISCLOSURE;
  }
  return text;
}

function isLegacyTransitCommercialOfferDisclosure(value: string): boolean {
  return [
    "该链接可能包含 AFF；优惠为首充充值折扣，不改变模型公开价格倍率，也不代表 PriceAI 担保。",
    "该站点存在商业合作信息，不影响页面价格口径；注册后请回原站核验活动规则、充值比例和退款规则。",
    "该链接包含AFF,但不影响排序口径。",
    "该链接包含AFF，但不影响排序口径。",
    "该链接可能包含 AFF，不影响排序口径。",
  ].includes(value);
}

export function getTransitVerificationEvents(
  station: TransitStation
): TransitVerificationEvent[] {
  const events = station.verificationEvents || [];
  if (events.length) {
    return [...events].sort((left, right) =>
      new Date(right.happenedAt).getTime() - new Date(left.happenedAt).getTime()
    );
  }

  const fallbackEvents: TransitVerificationEvent[] = [];
  if (station.availability.lastCheckedAt) {
    fallbackEvents.push({
      id: `${station.id}-availability`,
      source: "priceai",
      status: station.availability.sevenDayRate === null ? "warning" : "success",
      title: "可用性样本已记录",
      description: station.availability.note ?? null,
      happenedAt: station.availability.lastCheckedAt,
    });
  }
  if (station.lastUpdatedAt) {
    fallbackEvents.push({
      id: `${station.id}-updated`,
      source: "priceai",
      status: station.dataStatus === "verified" ? "success" : "info",
      title: `资料状态：${station.dataStatus === "verified" ? "已核验" : "待继续核验"}`,
      description: station.feedback.publicNotes,
      happenedAt: station.lastUpdatedAt,
    });
  }

  return fallbackEvents;
}

function dedupeTags<T extends { id: string; label: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const TRANSIT_RANKING_WEIGHTS = {
  cost: 30,
  recentReliability: 18,
  sevenDayReliability: 12,
  responseLatency: 15,
  cacheHit: 10,
  modelDetection: 15,
} as const;

export const TRANSIT_RESPONSE_LATENCY_WEIGHTS = {
  average7d: 12,
  latest: 3,
} as const;

export const TRANSIT_RESPONSE_LATENCY_MIN_SAMPLES = 30;
export const TRANSIT_RESPONSE_LATENCY_COVERAGE_THRESHOLD = 0.7;

export type TransitStationRankingOptions = {
  activeFamily?: TransitModelFamily | "all";
  activeStandardModel?: TransitModelPrice["standardModel"] | "all";
  now?: string | number | Date;
};

export type TransitPriceFreshnessSummary = {
  state: TransitAvailabilityFreshnessState;
  lastVerifiedAt: string | null;
};

export function getTransitStationPriceFreshness(
  station: TransitStation,
  options: TransitStationRankingOptions = {},
): TransitPriceFreshnessSummary {
  const prices = getActiveSortPrices(station, options);
  const pricedEvidence = prices
    .map((price) => ({
      price,
      value: getCombinedRateForPrice(station, price) ?? getTransitFixedPriceValue(price),
    }))
    .filter((entry): entry is { price: TransitModelPrice; value: number } =>
      entry.value !== null && Number.isFinite(entry.value) && entry.value > 0
    );
  const bestValue = pricedEvidence.length
    ? Math.min(...pricedEvidence.map((entry) => entry.value))
    : null;
  const evidencePrices = bestValue === null
    ? prices
    : pricedEvidence
      .filter((entry) => entry.value === bestValue)
      .map((entry) => entry.price);
  const lastVerifiedAt = evidencePrices
    .map((price) => price.lastVerifiedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    state: getTransitEvidenceFreshness(
      lastVerifiedAt,
      prices.length > 0,
      options.now ?? Date.now(),
      station,
    ),
    lastVerifiedAt,
  };
}

export type TransitStationRankingBreakdown = {
  totalScore: number;
  costScore: number;
  recentReliabilityScore: number;
  sevenDayReliabilityScore: number;
  reliabilityScore: number;
  responseLatencyScore: number;
  averageLatencyScore: number;
  latestLatencyScore: number;
  responseLatencyEnabled: boolean;
  responseLatencyCoverage: number;
  cacheHitScore: number;
  cacheHitRate: number | null;
  cacheHitSampleTokens: number;
  modelDetectionScore: number;
  eligible: boolean;
  comparisonRate: number | null;
  stabilityRate: number | null;
  stabilitySamples: number;
  recentSamples: number;
  latestLatencyMs: number | null;
  avgLatency7dMs: number | null;
};

type TransitStationSortContext = {
  station: TransitStation;
  summary: TransitStationComparisonSummary;
  scope: TransitFamilyRateSummary | null;
  cost: number | null;
  stabilityRate: number | null;
  stabilitySamples: number;
  recentSamples: TransitAvailability["recentSamples"];
  cacheUsage: TransitModelPrice["cacheUsage"] | undefined;
  lastCheckedAt: string | null;
  latestLatencyMs: number | null;
  avgLatency7dMs: number | null;
  freshness: TransitAvailabilityFreshnessState;
  priceFreshness: TransitAvailabilityFreshnessState;
};

export function compareStations(
  stations: TransitStation[],
  sortBy: TransitSortKey,
  options: TransitStationRankingOptions = {}
): TransitStation[] {
  const contexts = stations.map((station) => getTransitStationSortContext(station, options));
  const ranking = sortBy === "overall" ? scoreTransitStationContexts(contexts, options) : null;

  return contexts.sort((a, b) => {
    const left = a.station;
    const right = b.station;

    if (sortBy === "stability") {
      return (
        compareNullableNumber(a.stabilityRate, b.stabilityRate, "desc") ||
        b.stabilitySamples - a.stabilitySamples ||
        new Date(right.lastUpdatedAt).getTime() - new Date(left.lastUpdatedAt).getTime()
      );
    }

    if (sortBy === "rate") {
      return (
        compareNullableNumber(a.cost, b.cost, "asc") ||
        compareNullableNumber(a.stabilityRate, b.stabilityRate, "desc") ||
        b.stabilitySamples - a.stabilitySamples ||
        new Date(right.lastUpdatedAt).getTime() - new Date(left.lastUpdatedAt).getTime()
      );
    }

    if (sortBy === "claude_rate") {
      return (
        compareNullableNumber(
          rankableTransitFamilyRate(a, "claude", options),
          rankableTransitFamilyRate(b, "claude", options),
          "asc",
        ) ||
        compareNullableNumber(a.cost, b.cost, "asc") ||
        compareNullableNumber(a.stabilityRate, b.stabilityRate, "desc") ||
        b.stabilitySamples - a.stabilitySamples ||
        new Date(right.lastUpdatedAt).getTime() - new Date(left.lastUpdatedAt).getTime()
      );
    }

    if (sortBy === "gpt_rate") {
      return (
        compareNullableNumber(
          rankableTransitFamilyRate(a, "gpt", options),
          rankableTransitFamilyRate(b, "gpt", options),
          "asc",
        ) ||
        compareNullableNumber(a.cost, b.cost, "asc") ||
        compareNullableNumber(a.stabilityRate, b.stabilityRate, "desc") ||
        b.stabilitySamples - a.stabilitySamples ||
        new Date(right.lastUpdatedAt).getTime() - new Date(left.lastUpdatedAt).getTime()
      );
    }

    const aScore = ranking?.get(left.id)?.totalScore ?? 0;
    const bScore = ranking?.get(right.id)?.totalScore ?? 0;
    return (
      bScore - aScore ||
      compareNullableNumber(a.cost, b.cost, "asc") ||
      compareNullableNumber(a.stabilityRate, b.stabilityRate, "desc") ||
      b.stabilitySamples - a.stabilitySamples ||
      new Date(right.lastUpdatedAt).getTime() - new Date(left.lastUpdatedAt).getTime()
    );
  }).map((context) => context.station);
}

export function getTransitStationRankingBreakdowns(
  stations: TransitStation[],
  options: TransitStationRankingOptions = {}
): Map<string, TransitStationRankingBreakdown> {
  return scoreTransitStationContexts(
    stations.map((station) => getTransitStationSortContext(station, options)),
    options
  );
}

function getTransitStationSortContext(
  station: TransitStation,
  options: TransitStationRankingOptions
): TransitStationSortContext {
  const allTextScope =
    (!options.activeFamily || options.activeFamily === "all") &&
    (!options.activeStandardModel || options.activeStandardModel === "all");
  const summary = allTextScope
    ? getTextStationComparisonSummary(station)
    : getStationComparisonSummary(station);
  const scope = getActiveSortScope(station, summary, options);
  const prices = getActiveSortPrices(station, options);
  const now = options.now ?? Date.now();
  const presentation = allTextScope
    ? getTransitStationAvailabilityPresentation(station, summary.availability, now)
    : null;
  const rankingAvailability = presentation?.availability ?? (scope || summary.availability);
  const referenceOnly = presentation?.availability.referenceOnly
    ?? (scope ? scope.referenceOnly : summary.availability.referenceOnly);
  const freshness = presentation?.freshness ?? getTransitAvailabilityFreshness(rankingAvailability, now, station);
  const availabilityExcluded = referenceOnly || freshness === "stale" || freshness === "empty";
  const priceFreshness = getTransitStationPriceFreshness(station, { ...options, now }).state;
  const priceExcluded = priceFreshness === "stale" || priceFreshness === "empty";

  return {
    station,
    summary,
    scope,
    cost: priceExcluded ? null : transitSortCost(scope, summary),
    stabilityRate: availabilityExcluded ? null : rankingAvailability.sevenDayRate,
    stabilitySamples: availabilityExcluded ? 0 : rankingAvailability.sevenDaySamples,
    recentSamples: availabilityExcluded ? undefined : rankingAvailability.recentSamples,
    cacheUsage: getAggregatedTransitCacheUsage(prices, {
      equalWeightFamilies:
        (!options.activeFamily || options.activeFamily === "all") &&
        (!options.activeStandardModel || options.activeStandardModel === "all"),
    }),
    lastCheckedAt: rankingAvailability.lastCheckedAt,
    latestLatencyMs: rankingAvailability.latestLatencyMs ?? null,
    avgLatency7dMs: rankingAvailability.avgLatency7dMs ?? null,
    freshness,
    priceFreshness,
  };
}

function rankableTransitFamilyRate(
  context: TransitStationSortContext,
  family: TransitModelFamily,
  options: TransitStationRankingOptions,
): number | null {
  const priceFreshness = getTransitStationPriceFreshness(context.station, {
    ...options,
    activeFamily: family,
    activeStandardModel: "all",
  }).state;
  return priceFreshness === "stale" || priceFreshness === "empty"
    ? null
    : context.summary.families[family].combinedRateMin;
}

function getActiveSortPrices(
  station: TransitStation,
  options: TransitStationRankingOptions
): TransitModelPrice[] {
  if (options.activeStandardModel && options.activeStandardModel !== "all") {
    return getStandardModelPrices(station, options.activeStandardModel);
  }
  if (options.activeFamily && options.activeFamily !== "all") {
    return getFamilyPrices(station, options.activeFamily);
  }
  return getTransitTextModelPrices(station.prices);
}

function transitSortCost(
  scope: TransitFamilyRateSummary | null,
  summary: TransitStationComparisonSummary
): number | null {
  if (!scope) return summary.bestCombinedRate;
  return scope.combinedRateMin ?? scope.fixedPriceMin;
}

function scoreTransitStationContexts(
  contexts: TransitStationSortContext[],
  options: TransitStationRankingOptions
): Map<string, TransitStationRankingBreakdown> {
  const peerRates = contexts
    .map((context) => context.cost)
    .filter((rate): rate is number => rate !== null && Number.isFinite(rate) && rate > 0);
  const now = rankingTimestamp(options.now);
  const rankingEligibleContexts = contexts.filter((context) => isTransitRankingEligible(context, now));
  const latencyEligibleContexts = rankingEligibleContexts.filter((context) =>
    isTransitResponseLatencyEligible(context, now)
  );
  const responseLatencyCoverage = rankingEligibleContexts.length > 0
    ? latencyEligibleContexts.length / rankingEligibleContexts.length
    : 0;
  const responseLatencyEnabled =
    responseLatencyCoverage >= TRANSIT_RESPONSE_LATENCY_COVERAGE_THRESHOLD;
  const peerAverageLatencies = latencyEligibleContexts
    .map((context) => context.avgLatency7dMs)
    .filter((value): value is number => value !== null);
  const peerLatestLatencies = latencyEligibleContexts
    .map((context) => context.latestLatencyMs)
    .filter((value): value is number => value !== null);

  return new Map(contexts.map((context) => {
    const priceFreshnessWeight = context.priceFreshness === "delayed" ? 0.5 : 1;
    const costScore = scoreTransitRelativeCost(context.cost, peerRates) *
      TRANSIT_RANKING_WEIGHTS.cost * priceFreshnessWeight;
    const freshnessWeight = context.freshness === "delayed" ? 0.5 : 1;
    const sevenDayReliability = scoreTransitReliability(
      context.stabilityRate,
      context.stabilitySamples
    );
    const recentReliability = scoreTransitRecentReliability(
      context.recentSamples,
      sevenDayReliability,
      context.stabilitySamples
    ) * freshnessWeight;
    const recentReliabilityScore = recentReliability * TRANSIT_RANKING_WEIGHTS.recentReliability;
    const sevenDayReliabilityScore = sevenDayReliability * freshnessWeight * TRANSIT_RANKING_WEIGHTS.sevenDayReliability;
    const reliabilityScore = recentReliabilityScore + sevenDayReliabilityScore;
    const hasScoredLatency = responseLatencyEnabled && isTransitResponseLatencyEligible(context, now);
    const averageLatencyScore = hasScoredLatency
      ? scoreTransitResponseLatency(context.avgLatency7dMs, peerAverageLatencies) *
        TRANSIT_RESPONSE_LATENCY_WEIGHTS.average7d
      : 0;
    const latestLatencyScore = hasScoredLatency
      ? scoreTransitResponseLatency(context.latestLatencyMs, peerLatestLatencies) *
        TRANSIT_RESPONSE_LATENCY_WEIGHTS.latest
      : 0;
    const responseLatencyScore = averageLatencyScore + latestLatencyScore;
    const cacheHitScore = scoreTransitCacheHit(context.cacheUsage) * TRANSIT_RANKING_WEIGHTS.cacheHit;
    const modelDetectionScore = scoreTransitModelDetection(
      context.station,
      options.activeStandardModel && options.activeStandardModel !== "all"
        ? options.activeStandardModel
        : undefined,
      options.activeFamily && options.activeFamily !== "all"
        ? options.activeFamily
        : undefined
    ) * TRANSIT_RANKING_WEIGHTS.modelDetection;
    const eligible = isTransitRankingEligible(context, now);
    const totalScore = eligible
      ? clampNumber(
          costScore + reliabilityScore + responseLatencyScore + cacheHitScore + modelDetectionScore,
          0,
          100
        )
      : 0;

    return [context.station.id, {
      totalScore,
      costScore,
      recentReliabilityScore,
      sevenDayReliabilityScore,
      reliabilityScore,
      responseLatencyScore,
      averageLatencyScore,
      latestLatencyScore,
      responseLatencyEnabled,
      responseLatencyCoverage,
      cacheHitScore,
      cacheHitRate: context.cacheUsage?.hitRate ?? null,
      cacheHitSampleTokens: context.cacheUsage?.sampleTokens ?? 0,
      modelDetectionScore,
      eligible,
      comparisonRate: context.cost,
      stabilityRate: context.stabilityRate,
      stabilitySamples: context.stabilitySamples,
      recentSamples: context.recentSamples?.length ?? 0,
      latestLatencyMs: context.latestLatencyMs,
      avgLatency7dMs: context.avgLatency7dMs,
    }];
  }));
}

export function scoreTransitRelativeCost(rate: number | null, peerRates: number[]): number {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return 0;
  const rates = peerRates.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (rates.length <= 1) return 1;

  const lower = Math.log(percentile(rates, 0.1));
  const upper = Math.log(percentile(rates, 0.9));
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) return 1;
  return clampNumber((upper - Math.log(rate)) / (upper - lower), 0, 1);
}

export function scoreTransitReliability(rate: number | null, samples: number): number {
  if (rate === null || !Number.isFinite(rate) || samples <= 0) return 0;
  const sampleCount = Math.max(1, Math.round(samples));
  const proportion = clampNumber(rate, 0, 1);
  const z = 1.64;
  const zSquared = z * z;
  const denominator = 1 + zSquared / sampleCount;
  const centre = proportion + zSquared / (2 * sampleCount);
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * sampleCount)) / sampleCount
  );
  return clampNumber((centre - margin) / denominator, 0, 1);
}

export function scoreTransitRecentReliability(
  recentSamples: TransitAvailability["recentSamples"],
  sevenDayReliability: number,
  sevenDaySamples: number
): number {
  const samples = normalizeRecentAvailabilitySamples(recentSamples || []) || [];
  if (samples.length) {
    const successes = samples.filter((sample) => sample.ok).length;
    return scoreTransitReliability(successes / samples.length, samples.length);
  }

  const fallbackCoverage = Math.min(Math.max(sevenDaySamples, 0) / 60, 1);
  return sevenDayReliability * (0.6 + fallbackCoverage * 0.2);
}

export function scoreTransitCacheHit(
  cacheUsage: TransitModelPrice["cacheUsage"] | null | undefined
): number {
  if (!cacheUsage || cacheUsage.sampleTokens <= 0 || cacheUsage.hitRate === null) return 0;
  return clampNumber(cacheUsage.hitRate, 0, 1);
}

export function scoreTransitResponseLatency(
  latencyMs: number | null,
  peerLatencyValues: number[]
): number {
  return scoreTransitRelativeCost(latencyMs, peerLatencyValues);
}

export function scoreTransitModelDetection(
  station: TransitStation,
  standardModel?: TransitModelPrice["standardModel"],
  family?: TransitModelFamily
): number {
  if (standardModel) {
    return scoreTransitDetectionSummary(getTransitStationDetectionSummary(station, standardModel));
  }
  if (station.modelDetection) return scoreTransitDetectionSummary(station.modelDetection);

  const models = Array.from(new Set(
    station.prices
      .filter((price) => !family || transitModelPriceMatchesFamily(price, family))
      .map((price) => price.standardModel)
  ));
  if (!models.length) return 0;
  return models.reduce(
    (total, model) => total + scoreTransitDetectionSummary(getTransitStationDetectionSummary(station, model)),
    0
  ) / models.length;
}

function scoreTransitDetectionSummary(detection: TransitModelDetectionSummary | null): number {
  if (!hasPublicTransitModelDetectionReport(detection)) return 0;
  if (detection?.score !== null && detection?.score !== undefined && Number.isFinite(detection.score)) {
    return clampNumber(detection.score / 100, 0, 1);
  }
  if (detection?.verdict === "passed") return 1;
  if (detection?.verdict === "review") return 0.5;
  return 0;
}

function isTransitRankingEligible(context: TransitStationSortContext, now: number): boolean {
  if (context.cost === null || context.stabilityRate === null || context.stabilitySamples <= 0) return false;
  if (context.freshness === "stale" || context.freshness === "empty") return false;
  const checkedAt = parseAvailabilityTimestamp(context.lastCheckedAt);
  if (checkedAt === null) return false;
  return Math.max(0, now - checkedAt) <= TRANSIT_AVAILABILITY_STALE_AFTER_MS;
}

function isTransitResponseLatencyEligible(
  context: TransitStationSortContext,
  now: number
): boolean {
  if (!isTransitRankingEligible(context, now)) return false;
  if (context.stabilitySamples < TRANSIT_RESPONSE_LATENCY_MIN_SAMPLES) return false;
  return (
    context.latestLatencyMs !== null &&
    Number.isFinite(context.latestLatencyMs) &&
    context.latestLatencyMs > 0 &&
    context.avgLatency7dMs !== null &&
    Number.isFinite(context.avgLatency7dMs) &&
    context.avgLatency7dMs > 0
  );
}

function percentile(sortedValues: number[], fraction: number): number {
  if (!sortedValues.length) return Number.NaN;
  const position = clampNumber(fraction, 0, 1) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex] ?? sortedValues[0];
  const upper = sortedValues[upperIndex] ?? sortedValues.at(-1) ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function rankingTimestamp(value: TransitStationRankingOptions["now"]): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function getActiveSortScope(
  station: TransitStation,
  summary: TransitStationComparisonSummary,
  options: TransitStationRankingOptions
): TransitFamilyRateSummary | null {
  if (options.activeStandardModel && options.activeStandardModel !== "all") {
    return getStandardModelRateSummary(station, options.activeStandardModel);
  }

  if (options.activeFamily && options.activeFamily !== "all") {
    return summary.families[options.activeFamily];
  }

  return null;
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
  direction: "asc" | "desc"
) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

export type TransitModelPriceEntry = {
  station: TransitStation;
  price: TransitModelPrice;
  rechargeCoefficient: number | null;
  combinedRate: number | null;
};

export type TransitModelSummary = {
  standardModel: TransitModelPrice["standardModel"];
  family: TransitModelFamily;
  familyLabel: string;
  stationCount: number;
  bestCombinedRate: number | null;
  worstCombinedRate: number | null;
  bestFixedPrice: number | null;
  worstFixedPrice: number | null;
  averageAvailability: number | null;
  sampleCount: number;
  prices: TransitModelPriceEntry[];
};

export function getTransitModelFamilyOptions(): { id: TransitModelFamily; label: string }[] {
  return TRANSIT_MODEL_FAMILY_OPTIONS;
}

export function getTransitModelSummaries(
  stations: TransitStation[],
  family: "all" | TransitModelFamily = "all"
): TransitModelSummary[] {
  const byModel = new Map<TransitModelPrice["standardModel"], TransitModelPriceEntry[]>();
  const standardModels = TRANSIT_STANDARD_MODELS.filter((standardModel) => {
    if (family === "all") return true;
    return transitStandardModelMatchesFamily(standardModel, family);
  });
  const standardModelOrder = new Map(
    TRANSIT_STANDARD_MODELS.map((standardModel, index) => [standardModel, index])
  );

  stations.forEach((station) => {
    station.prices.forEach((price) => {
      if (family !== "all" && !transitModelPriceMatchesFamily(price, family)) return;

      const entry: TransitModelPriceEntry = {
        station,
        price,
        rechargeCoefficient:
          getRechargeCoefficientFromRatio(price.rechargeRatio) ??
          getStationRechargeCoefficient(station),
        combinedRate: getCombinedRateForPrice(station, price),
      };

      const existing = byModel.get(price.standardModel);
      if (existing) {
        existing.push(entry);
      } else {
        byModel.set(price.standardModel, [entry]);
      }
    });
  });

  const summaryModels = [...standardModels];
  byModel.forEach((_, standardModel) => {
    if (!summaryModels.includes(standardModel)) {
      summaryModels.push(standardModel);
    }
  });

  return summaryModels
    .map((standardModel) => {
      const prices = byModel.get(standardModel) ?? [];
      const entriesByStation = new Map<string, TransitModelPriceEntry[]>();
      for (const entry of prices) {
        entriesByStation.set(entry.station.id, [...(entriesByStation.get(entry.station.id) || []), entry]);
      }
      const availabilityEntries = Array.from(entriesByStation.values()).flatMap((stationEntries) => {
        const station = stationEntries[0]?.station;
        if (!station) return [];
        const selectedPrices = new Set(
          getPreferredTransitAvailabilityRollupPrices(station, stationEntries.map((entry) => entry.price))
        );
        return stationEntries.filter((entry) => selectedPrices.has(entry.price));
      });
      const finiteRates = prices
        .map((entry) => entry.combinedRate)
        .filter((rate): rate is number => rate !== null && Number.isFinite(rate))
        .sort((a, b) => a - b);
      const fixedPrices = prices
        .map((entry) => getTransitFixedPriceValue(entry.price))
        .filter((price): price is number => price !== null && Number.isFinite(price) && price > 0)
        .sort((a, b) => a - b);
      const sampleCount = availabilityEntries.reduce(
        (total, entry) => total + entry.price.availability.sevenDaySamples,
        0
      );
      const averageAvailability =
        sampleCount > 0
          ? availabilityEntries.reduce((total, entry) => {
              const rate = entry.price.availability.sevenDayRate ?? 0;
              return total + rate * entry.price.availability.sevenDaySamples;
            }, 0) / sampleCount
          : null;
      const modelFamily =
        family === "all"
          ? prices[0]?.price.family ?? TRANSIT_STANDARD_MODEL_FAMILY[standardModel]
          : family;

      return {
        standardModel,
        family: modelFamily,
        familyLabel: TRANSIT_MODEL_FAMILY_LABELS[modelFamily],
        stationCount: new Set(prices.map((entry) => entry.station.id)).size,
        bestCombinedRate: finiteRates[0] ?? null,
        worstCombinedRate: finiteRates[finiteRates.length - 1] ?? null,
        bestFixedPrice: fixedPrices[0] ?? null,
        worstFixedPrice: fixedPrices[fixedPrices.length - 1] ?? null,
        averageAvailability,
        sampleCount,
        prices: prices.sort((a, b) =>
          compareNullableNumber(a.combinedRate ?? getTransitFixedPriceValue(a.price), b.combinedRate ?? getTransitFixedPriceValue(b.price), "asc")
        ),
      };
    })
    .sort((a, b) => {
      const familyOrder = TRANSIT_MODEL_FAMILY_ORDER.indexOf(a.family) - TRANSIT_MODEL_FAMILY_ORDER.indexOf(b.family);
      if (familyOrder !== 0) return familyOrder;
      return (
        compareNullableNumber(a.bestCombinedRate, b.bestCombinedRate, "asc") ||
        compareNullableNumber(a.bestFixedPrice, b.bestFixedPrice, "asc") ||
        (standardModelOrder.get(a.standardModel) ?? Number.MAX_SAFE_INTEGER) -
          (standardModelOrder.get(b.standardModel) ?? Number.MAX_SAFE_INTEGER)
      );
    });
}

export function getSummaryStats(stations: TransitStation[]) {
  const summaries = stations.map(getStationComparisonSummary);
  const bestClaude = summaries
    .map((summary) => summary.claude.combinedRateMin)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0] ?? null;
  const bestGpt = summaries
    .map((summary) => summary.gpt.combinedRateMin)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0] ?? null;
  const bestByFamily = TRANSIT_MODEL_FAMILY_ORDER.reduce(
    (accumulator, family) => {
      accumulator[family] = summaries
        .map((summary) => summary.families[family].combinedRateMin)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b)[0] ?? null;
      return accumulator;
    },
    {} as Record<TransitModelFamily, number | null>
  );
  const sevenDaySamples = stations.reduce(
    (total, station) => total + getStationPublishedAvailabilitySummary(station).sevenDaySamples,
    0
  );

  return {
    total: stations.length,
    bestClaude,
    bestGpt,
    bestByFamily,
    sevenDaySamples,
    withRisk: stations.filter((station) => station.riskLabels.length > 0).length,
  };
}

export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  if (rate < 0.01) return `${rate.toFixed(4)}x`;
  if (rate < 0.1) return `${rate.toFixed(3)}x`;
  return `${rate.toFixed(2)}x`;
}

export function formatTransitModelMultiplier(price: TransitModelPrice): string {
  if (isTransitFixedPrice(price)) return "不适用";
  const value = price.modelMultiplier;
  if (value === null || !Number.isFinite(value)) return "—";
  if (!hasComparableTransitOfficialPrice(price.standardModel)) return `${formatFixedTransitUnitPrice(value)} 固定价`;
  return `${value.toFixed(2)}x`;
}

function formatFixedTransitUnitPrice(value: number): string {
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : value >= 1 ? 2 : value >= 0.1 ? 3 : 4;
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

export function formatTransitFixedPriceValue(value: number | null, unit?: string | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `¥${formatFixedTransitUnitPrice(value)}/${transitFixedPriceUnitLabel(unit)}`;
}

export function formatTransitFixedPriceRange(
  summary: Pick<TransitFamilyRateSummary, "fixedPriceMin" | "fixedPriceMax">
): string {
  if (summary.fixedPriceMin === null) return "—";
  if (summary.fixedPriceMax === null || summary.fixedPriceMax === summary.fixedPriceMin) {
    return formatTransitFixedPriceValue(summary.fixedPriceMin);
  }
  return `¥${formatFixedTransitUnitPrice(summary.fixedPriceMin)}-${formatFixedTransitUnitPrice(summary.fixedPriceMax)}/${transitFixedPriceUnitLabel(null)}`;
}

export function hasTransitFixedPriceSummary(
  summary: Pick<TransitFamilyRateSummary, "fixedPriceMin" | "combinedRateMin">
): boolean {
  return summary.fixedPriceMin !== null && summary.combinedRateMin === null;
}

function fixedPriceValues(price: TransitModelPrice): number[] {
  return [
    price.fixedPrice,
    ...(price.fixedPriceTiers || []).map((tier) => tier.price),
  ].filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0);
}

function transitFixedPriceUnitLabel(unit?: string | null): string {
  if (unit === "image") return "张";
  if (unit === "video") return "次";
  return "次";
}

export function formatUsdPerMTok(price: number | null): string {
  return formatOfficialUnitPrice(price, "USD");
}

export function formatOfficialUnitPrice(
  price: number | null,
  currency: TransitPriceCurrency
): string {
  if (price === null || !Number.isFinite(price)) return "未公开";
  if (price === 0) return currency === "CNY" ? "¥0/M" : "$0/M";

  const absolutePrice = Math.abs(price);
  const decimals = absolutePrice >= 1 ? (Number.isInteger(price) ? 0 : 2) : absolutePrice >= 0.1 ? 3 : 4;

  return `${currency === "CNY" ? "¥" : "$"}${price.toFixed(decimals)}/M`;
}

export function formatMultiplierRange(summary: TransitFamilyRateSummary): string {
  if (hasTransitFixedPriceSummary(summary)) return formatTransitFixedPriceRange(summary);
  if (summary.modelMultiplierMin === null) return "—";
  const suffix = summary.combinedRateMin === null && (summary.family === "image" || summary.family === "video") ? " 固定价" : "x";
  if (summary.modelMultiplierMax === null || summary.modelMultiplierMax === summary.modelMultiplierMin) {
    return `${summary.modelMultiplierMin.toFixed(2)}${suffix}`;
  }
  return `${summary.modelMultiplierMin.toFixed(2)}-${summary.modelMultiplierMax.toFixed(2)}${suffix}`;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "样本不足";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatCacheHitRate(cacheUsage: TransitModelPrice["cacheUsage"] | null | undefined): string {
  if (!cacheUsage || cacheUsage.sampleTokens <= 0 || cacheUsage.hitRate === null) return "样本不足";
  return formatPercent(cacheUsage.hitRate);
}

export function formatTransitTokenVolume(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "0 tokens";
  if (value >= 1_000_000_000) return `${formatCompactNumber(value / 1_000_000_000)}B tokens`;
  if (value >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}M tokens`;
  if (value >= 1_000) return `${formatCompactNumber(value / 1_000)}K tokens`;
  return `${Math.round(value)} tokens`;
}

export function getCacheHitRateBadgeClass(cacheUsage: TransitModelPrice["cacheUsage"] | null | undefined): string {
  if (!cacheUsage || cacheUsage.sampleTokens <= 0 || cacheUsage.hitRate === null) {
    return "bg-[#f2f4f4] text-[#7f8889]";
  }
  if (cacheUsage.hitRate >= 0.9) return "bg-[#e8f3ec] text-[#2f7a4b]";
  if (cacheUsage.hitRate >= 0.8) return "bg-[#eef3f8] text-[#47657a]";
  if (cacheUsage.hitRate >= 0.5) return "bg-[#fff7e8] text-[#7a541b]";
  return "bg-[#fbe9e7] text-[#9b3328]";
}

export function formatTransitLatencyMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未记录";
  if (value >= 1000) return `${formatCompactNumber(value / 1000)}s`;
  return `${Math.round(value)}ms`;
}

export function formatTransitLatencySummary(
  input: { latestLatencyMs?: number | null; avgLatency7dMs?: number | null },
  options: { latestLabel?: string; averageLabel?: string } = {}
): string | null {
  const latest = input.latestLatencyMs ?? null;
  const average = input.avgLatency7dMs ?? null;
  const latestLabel = options.latestLabel ?? "最近";
  const averageLabel = options.averageLabel ?? "7日均";

  if (latest === null && average === null) return null;
  if (latest !== null && average !== null) {
    return `${latestLabel} ${formatTransitLatencyMs(latest)} · ${averageLabel} ${formatTransitLatencyMs(average)}`;
  }
  if (latest !== null) return `${latestLabel} ${formatTransitLatencyMs(latest)}`;
  return `${averageLabel} ${formatTransitLatencyMs(average)}`;
}

export type TransitLatencyTone = "fast" | "normal" | "slow" | "very_slow" | "muted";

export function getTransitLatencyTone(value: number | null | undefined): TransitLatencyTone {
  if (value === null || value === undefined || !Number.isFinite(value)) return "muted";
  if (value <= 2000) return "fast";
  if (value <= 5000) return "normal";
  if (value <= 10000) return "slow";
  return "very_slow";
}

export function getRepresentativeCacheUsage(
  prices: TransitModelPrice[]
): TransitModelPrice["cacheUsage"] | undefined {
  return prices
    .filter((price) => !isTransitFixedPrice(price))
    .map((price) => price.cacheUsage)
    .filter((cacheUsage): cacheUsage is NonNullable<TransitModelPrice["cacheUsage"]> => Boolean(cacheUsage))
    .sort((left, right) => {
      const leftHasSamples = left.sampleTokens > 0 && left.hitRate !== null;
      const rightHasSamples = right.sampleTokens > 0 && right.hitRate !== null;
      if (leftHasSamples !== rightHasSamples) return leftHasSamples ? -1 : 1;
      return right.sampleTokens - left.sampleTokens;
    })[0];
}

export function getAggregatedTransitCacheUsage(
  prices: TransitModelPrice[],
  options: { equalWeightFamilies?: boolean } = {}
): TransitCacheUsage | undefined {
  const grouped = new Map<string, TransitCacheUsage>();
  for (const price of prices) {
    if (isTransitFixedPrice(price)) continue;
    const cacheUsage = price.cacheUsage;
    if (
      !cacheUsage ||
      cacheUsage.hitRate === null ||
      !Number.isFinite(cacheUsage.hitRate) ||
      cacheUsage.sampleTokens <= 0
    ) {
      continue;
    }
    const key = [price.family, price.groupName || "默认分组"].join("|");
    const existing = grouped.get(key);
    if (!existing || cacheUsage.sampleTokens > existing.sampleTokens) {
      grouped.set(key, cacheUsage);
    }
  }

  if (!grouped.size) return undefined;
  const byFamily = new Map<TransitModelFamily, TransitCacheUsage[]>();
  for (const [key, cacheUsage] of grouped) {
    const family = key.slice(0, key.indexOf("|")) as TransitModelFamily;
    byFamily.set(family, [...(byFamily.get(family) || []), cacheUsage]);
  }
  const familySummaries = Array.from(byFamily.values()).map(summarizeTransitCacheUsages);
  if (!options.equalWeightFamilies) return summarizeTransitCacheUsages(familySummaries);

  return {
    hitRate: familySummaries.reduce((total, cacheUsage) => total + (cacheUsage.hitRate ?? 0), 0) /
      familySummaries.length,
    sampleTokens: familySummaries.reduce((total, cacheUsage) => total + cacheUsage.sampleTokens, 0),
  };
}

function summarizeTransitCacheUsages(cacheUsages: TransitCacheUsage[]): TransitCacheUsage {
  const sampleTokens = cacheUsages.reduce((total, cacheUsage) => total + cacheUsage.sampleTokens, 0);
  const weightedHits = cacheUsages.reduce(
    (total, cacheUsage) => total + (cacheUsage.hitRate ?? 0) * cacheUsage.sampleTokens,
    0
  );
  return {
    hitRate: sampleTokens > 0 ? weightedHits / sampleTokens : null,
    sampleTokens,
  };
}

export type TransitModelDetectionTone = "success" | "info" | "warning" | "danger" | "muted";

export function getTransitPriceDetectionSummary(
  station: TransitStation,
  price: TransitModelPrice
): TransitModelDetectionSummary | null {
  return price.modelDetection ?? getTransitDetectionSummaryFromEvents(station, price.standardModel);
}

export function getTransitStationDetectionSummary(
  station: TransitStation,
  standardModel?: TransitModelPrice["standardModel"]
): TransitModelDetectionSummary | null {
  if (!standardModel && station.modelDetection) return station.modelDetection;

  return getTransitDetectionSummaryFromEvents(station, standardModel);
}

function getTransitDetectionSummaryFromEvents(
  station: TransitStation,
  standardModel?: TransitModelPrice["standardModel"]
): TransitModelDetectionSummary | null {
  const events = (station.verificationEvents ?? [])
    .filter((event) => isModelDetectionEvent(event, standardModel))
    .sort((left, right) => new Date(right.happenedAt).getTime() - new Date(left.happenedAt).getTime());

  const latest = events[0];
  if (!latest) return null;
  const reportUrl = extractFirstUrl(`${latest.title} ${latest.description ?? ""}`);

  return {
    verdict: detectionVerdictFromEvent(latest.status),
    score: null,
    checkedAt: latest.happenedAt,
    reportCount: events.length,
    issueCount: events.filter((event) => event.status === "warning" || event.status === "failed").length,
    source: detectionSourceFromEvent(latest.source),
    sourceLabel: detectionSourceLabelFromEvent(latest.source),
    reportUrl,
    note: latest.description,
  };
}

export function buildTransitDetectorHref(
  station?: TransitStation,
  price?: TransitModelPrice
): string {
  const params = new URLSearchParams();
  if (station?.slug) params.set("station", station.slug);
  if (price?.standardModel) params.set("model", price.standardModel);
  const query = params.toString();
  return query ? `/api-transit/detector?${query}` : "/api-transit/detector";
}

export function formatTransitModelDetectionLabel(
  summary: TransitModelDetectionSummary | null | undefined
): string {
  if (!hasPublicTransitModelDetectionReport(summary)) return "待检测";
  switch (summary.verdict) {
    case "passed":
      return "快检通过";
    case "review":
      return "需复核";
    case "failed":
      return "异常";
    default:
      return "待检测";
  }
}

export function formatTransitModelDetectionMeta(
  summary: TransitModelDetectionSummary | null | undefined
): string {
  if (!hasPublicTransitModelDetectionReport(summary)) return "暂无公开报告";
  const parts = [`${summary.reportCount} 份报告`];
  if (summary.issueCount > 0) parts.push(`${summary.issueCount} 项需复核`);
  if (summary.score !== null && Number.isFinite(summary.score)) parts.push(`${formatDetectionScore(summary.score)} 分`);
  return parts.join(" · ");
}

export function getTransitModelDetectionTone(
  summary: TransitModelDetectionSummary | null | undefined
): TransitModelDetectionTone {
  if (!hasPublicTransitModelDetectionReport(summary)) return "muted";
  if (summary.verdict === "passed") return "success";
  if (summary.verdict === "failed") return "danger";
  return "warning";
}

export function getTransitModelDetectionBadgeClass(
  summary: TransitModelDetectionSummary | null | undefined
): string {
  switch (getTransitModelDetectionTone(summary)) {
    case "success":
      return "bg-[#e8f3ec] text-[#2f7a4b]";
    case "warning":
      return "bg-[#fff7e8] text-[#7a541b]";
    case "danger":
      return "bg-[#fbe9e7] text-[#9b3328]";
    default:
      return "bg-[#f2f4f4] text-[#5a6061]";
  }
}

export function hasPublicTransitModelDetectionReport(
  summary: TransitModelDetectionSummary | null | undefined
): summary is TransitModelDetectionSummary & { reportUrl: string } {
  return Boolean(summary && summary.verdict !== "untested" && summary.reportCount > 0 && summary.reportUrl);
}

function isModelDetectionEvent(
  event: TransitVerificationEvent,
  standardModel?: TransitModelPrice["standardModel"]
): boolean {
  const text = `${event.title} ${event.description ?? ""}`.toLowerCase();
  if (!extractFirstUrl(text)) return false;
  const hasDetectionSignal =
    text.includes("模型检测") ||
    text.includes("检测报告") ||
    text.includes("真实性") ||
    text.includes("真伪") ||
    text.includes("暗调路由") ||
    text.includes("模型路由") ||
    text.includes("暗调") ||
    text.includes("掺水");
  if (!hasDetectionSignal) return false;
  return standardModel ? text.includes(standardModel.toLowerCase()) : true;
}

function detectionVerdictFromEvent(
  status: TransitVerificationEvent["status"]
): TransitModelDetectionVerdict {
  if (status === "success") return "passed";
  if (status === "failed") return "failed";
  return "review";
}

function detectionSourceFromEvent(
  source: TransitVerificationEvent["source"]
): TransitModelDetectionSource {
  switch (source) {
    case "priceai":
      return "priceai";
    case "merchant":
      return "merchant_submitted";
    case "user":
      return "user_submitted";
    case "official":
      return "station_public";
    default:
      return "unknown";
  }
}

function detectionSourceLabelFromEvent(source: TransitVerificationEvent["source"]): string {
  switch (source) {
    case "priceai":
      return "PriceAI";
    case "official":
      return "站方公开";
    case "user":
      return "用户反馈";
    case "merchant":
      return "商家提交";
    default:
      return "未知来源";
  }
}

function extractFirstUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s)）]+/)?.[0] ?? null;
}

function formatDetectionScore(score: number): string {
  if (score <= 1) return Math.round(score * 100).toString();
  return Math.round(score).toString();
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

function weightedAverageLatency(prices: TransitModelPrice[]): number | null {
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

function formatCompactNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function formatAvailability(
  availability: Pick<TransitAvailability, "sevenDayRate" | "sevenDaySamples"> &
    Partial<Pick<TransitAvailability, "recentSamples">>
): string {
  if (availability.sevenDaySamples > 0 && availability.sevenDayRate !== null) {
    return `${formatPercent(availability.sevenDayRate)} · 样本 ${availability.sevenDaySamples}`;
  }
  const recentSampleCount = availability.recentSamples?.length ?? 0;
  if (recentSampleCount > 0) return `最近 ${recentSampleCount} 次样本`;
  return "样本不足";
}

export type AvailabilitySourceTone = "success" | "info" | "warning" | "muted";

export function getAvailabilityEvidenceMeta(
  availability: Pick<
    TransitAvailability,
    "scope" | "matchLevel" | "note" | "sourceType" | "sevenDayRate" | "sevenDaySamples"
  >
): { label: string; tone: AvailabilitySourceTone; title: string; reference: boolean } {
  const scope = getTransitAvailabilityScope(availability);
  const matchLevel = getTransitAvailabilityMatchLevel(availability);
  if (!hasValidTransitAvailabilityEvidence(availability)) {
    return {
      label: "监测样本不足",
      tone: "muted",
      title: "当前记录没有可用于展示的成功率和监测样本。",
      reference: false,
    };
  }
  if (matchLevel === "family") {
    return {
      label: "同家族参考",
      tone: "warning",
      title: "该数值来自同模型家族的公开监测参考，不代表当前套餐或模型独立实测，也不参与稳定性排名。",
      reference: true,
    };
  }
  if (matchLevel === "model") {
    return {
      label: "同模型参考",
      tone: "warning",
      title: "该数值来自同一标准模型的公开监测，不代表当前套餐独立实测；在具体模型、模型家族或站点总览中可作为同模型证据聚合。",
      reference: true,
    };
  }
  if (scope === "station") {
    return {
      label: "站点整体参考",
      tone: "info",
      title: "该数值覆盖站点整体，不代表任一套餐独立实测。",
      reference: false,
    };
  }
  if (scope === "group" || matchLevel === "group") {
    return {
      label: "分组公开监测",
      tone: "info",
      title: "该数值覆盖当前价格分组，组内多个模型共享同一批样本，汇总时只计一次。",
      reference: false,
    };
  }
  if (availability.sourceType === "priceai_probe") {
    return {
      label: "套餐实测",
      tone: "success",
      title: "PriceAI 使用当前套餐测试 Key 发起真实请求后记录的独立样本。",
      reference: false,
    };
  }
  return {
    label: "套餐公开监测",
    tone: "info",
    title: "公开监测与当前模型和分组精确对应，但不等同 PriceAI 测试 Key 实测。",
    reference: false,
  };
}

export function getAvailabilitySourceMeta(
  availability: Pick<TransitAvailability, "sourceType" | "sourceLabel" | "sourceUrl">
): { label: string; tone: AvailabilitySourceTone; title: string; url: string | null } {
  const explicitLabel = availability.sourceLabel?.trim();
  switch (availability.sourceType) {
    case "priceai_probe":
      return {
        label: "PriceAI 实测",
        tone: "success",
        title: explicitLabel
          ? `PriceAI 使用测试 API Key 发起真实模型请求后汇总的可用性样本。原始来源：${explicitLabel}`
          : "PriceAI 使用测试 API Key 发起真实模型请求后汇总的可用性样本。",
        url: availability.sourceUrl,
      };
    case "station_monitor":
      return {
        label: "站方监测",
        tone: "info",
        title: explicitLabel
          ? `来自站点自身的渠道监测，非 PriceAI 独立实测。原始来源：${explicitLabel}`
          : "来自站点自身的渠道监测，非 PriceAI 独立实测。",
        url: availability.sourceUrl,
      };
    case "public_status":
      return {
        label: "站方公开",
        tone: "info",
        title: explicitLabel
          ? `来自站点公开状态页或公开监测接口，非 PriceAI API Key 实测。原始来源：${explicitLabel}`
          : "来自站点公开状态页或公开监测接口，非 PriceAI API Key 实测。",
        url: availability.sourceUrl,
      };
    case "public_model_catalog":
      return {
        label: "公开模型页",
        tone: "info",
        title: explicitLabel
          ? `来自站点公开模型目录中的可用性指标，非 PriceAI API Key 实测。原始来源：${explicitLabel}`
          : "来自站点公开模型目录中的可用性指标，非 PriceAI API Key 实测。",
        url: availability.sourceUrl,
      };
    case "partner_api":
      return {
        label: "站长接口",
        tone: "info",
        title: explicitLabel
          ? `来自站长提供的公开或合作接口，非 PriceAI API Key 实测。原始来源：${explicitLabel}`
          : "来自站长提供的公开或合作接口，非 PriceAI API Key 实测。",
        url: availability.sourceUrl,
      };
    case "merchant_reported":
      return {
        label: "未核验",
        tone: "warning",
        title: explicitLabel
          ? `来自商家提交的截图或资料，尚未视为 PriceAI 实测。原始来源：${explicitLabel}`
          : "来自商家提交的截图或资料，尚未视为 PriceAI 实测。",
        url: availability.sourceUrl,
      };
    case "manual_snapshot":
      return {
        label: "未核验",
        tone: "muted",
        title: explicitLabel
          ? `来自一次性快照或未完成自动核验的数据，后续应替换为公开接口或 PriceAI 实测。原始来源：${explicitLabel}`
          : "来自一次性快照或未完成自动核验的数据，后续应替换为公开接口或 PriceAI 实测。",
        url: availability.sourceUrl,
      };
    default:
      return {
        label: "未核验",
        tone: "muted",
        title: explicitLabel
          ? `当前稳定性来源尚未结构化记录。原始来源：${explicitLabel}`
          : "当前稳定性来源尚未结构化记录。",
        url: availability.sourceUrl,
      };
  }
}

export function getRateBadgeClass(rate: number | null): string {
  if (rate === null) return "bg-[#f2f4f4] text-[#5a6061]";
  if (rate <= 0.5) return "bg-[#e8f3ec] text-[#2f7a4b]";
  if (rate <= 1) return "bg-[#fff7e8] text-[#7a541b]";
  return "bg-[#f2f4f4] text-[#5a6061]";
}

export function getUsageAdviceBadgeClass(advice: TransitStation["usageAdvice"]): string {
  switch (advice) {
    case "try_small":
      return "bg-[#e8f3ec] text-[#2f7a4b]";
    case "cautious":
      return "bg-[#fff7e8] text-[#7a541b]";
    case "not_recommended":
      return "bg-[#fbe9e7] text-[#9b3328]";
    default:
      return "bg-[#f2f4f4] text-[#5a6061]";
  }
}

export { TRANSIT_COMMERCIAL_LABELS };
