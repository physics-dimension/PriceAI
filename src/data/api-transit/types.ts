export type TransitStationStatus = "active" | "limited" | "unavailable" | "unknown";
export type TransitSourceType = "manual_collected" | "user_submitted" | "merchant_submitted";
export type TransitCommercialRelation = "none" | "listed" | "partner" | "affiliate" | "sponsored" | "unknown";
export type TransitDataStatus = "sample" | "pending_review" | "verified";
export type TransitCollectionStatus = "pending" | "success" | "partial" | "failed" | "manual_review";
export type TransitModelFamily =
  | "gpt"
  | "claude"
  | "gemini"
  | "grok"
  | "glm"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "image"
  | "video";
export type TransitModelModality = "text" | "image" | "video";
export type TransitStationSystem = "new_api" | "sub_to_api" | "custom" | "unknown";
export type TransitOperatorType = "company" | "individual" | "unknown";
export type TransitInvoiceSupport = "supported" | "unsupported" | "unknown";
export type TransitChannelType =
  | "official_api"
  | "cloud"
  | "first_party_pool"
  | "reverse_engineered"
  | "first_party_wholesale"
  | "reseller"
  | "mixed"
  | "undisclosed";
export type TransitAccountPool = "pro" | "plus" | "max" | "team" | "kiro" | "enterprise" | "official_api" | "mixed" | "undisclosed";
export type TransitRiskLabel =
  | "sample_data"
  | "insufficient_samples"
  | "mixed_pool"
  | "reseller"
  | "undisclosed_upstream"
  | "third_party_aggregate"
  | "pending_feedback";
export type TransitUsageAdvice = "try_small" | "cautious" | "not_recommended" | "pending";
export type TransitAvailabilitySourceType =
  | "priceai_probe"
  | "station_monitor"
  | "public_status"
  | "public_model_catalog"
  | "partner_api"
  | "merchant_reported"
  | "manual_snapshot"
  | "unknown";
export type TransitAvailabilityScope = "station" | "group" | "model" | "offer";
export type TransitAvailabilityMatchLevel = "exact" | "group" | "model" | "family";

export interface TransitAvailability {
  sevenDayRate: number | null;
  sevenDaySamples: number;
  firstCheckedAt?: string | null;
  lastCheckedAt: string | null;
  recentSamples?: Array<{
    ok: boolean;
    checkedAt: string | null;
  }>;
  recentSampleBits?: string;
  latestLatencyMs?: number | null;
  avgLatency7dMs?: number | null;
  note?: string;
  sourceType: TransitAvailabilitySourceType;
  sourceLabel: string | null;
  sourceUrl: string | null;
  scope?: TransitAvailabilityScope | null;
  matchLevel?: TransitAvailabilityMatchLevel | null;
  monitoringScopeId?: string | null;
}

export interface TransitCacheUsage {
  hitRate: number | null;
  sampleTokens: number;
}

export type TransitModelDetectionVerdict = "passed" | "review" | "failed" | "untested";
export type TransitModelDetectionSource =
  | "priceai"
  | "station_public"
  | "user_submitted"
  | "merchant_submitted"
  | "unknown";

export interface TransitModelDetectionSummary {
  verdict: TransitModelDetectionVerdict;
  score: number | null;
  checkedAt: string | null;
  reportCount: number;
  issueCount: number;
  source: TransitModelDetectionSource;
  sourceLabel: string | null;
  reportUrl?: string | null;
  note?: string | null;
}

export interface TransitMultiplierHistoryPoint {
  observedAt: string;
  rechargeRatio: string | null;
  rechargeCoefficient: number | null;
  modelMultiplier: number | null;
  combinedRate: number | null;
  priceSource: string | null;
}

export type TransitStandardModel =
  | "Claude Opus 5"
  | "Claude Fable 5"
  | "Claude Sonnet 5"
  | "Claude Sonnet 4.5"
  | "Claude Sonnet 4.6"
  | "Claude Haiku 4.5"
  | "Claude Opus 4.5"
  | "Claude Opus 4.6"
  | "Claude Opus 4.7"
  | "Claude Opus 4.8"
  | "Codex Compact"
  | "GPT 5.6 Sol"
  | "GPT 5.6 Terra"
  | "GPT 5.6 Luna"
  | "GPT 5.5"
  | "GPT 5.4"
  | "GPT 5.4 Mini"
  | "Gemini 3.5 Flash"
  | "Gemini 3.1 Pro"
  | "Grok 4.20"
  | "Grok 4.3"
  | "Grok 4.5"
  | "Grok Build"
  | "Composer 2.5"
  | "GLM-5.2"
  | "GLM-5.1"
  | "DeepSeek V4 Flash"
  | "DeepSeek V4 Pro"
  | "Kimi K3"
  | "Qwen3.8-Max-Preview"
  | "Qwen3.7-Max"
  | "GPT Image 2"
  | "Grok Image"
  | "Nano Banana Pro"
  | "Nano Banana 2"
  | "Nano Banana"
  | "Nano Banana Lite"
  | "Sora 2"
  | "Sora 2 Pro"
  | "Grok Video"
  | "Veo 3.1"
  | "Veo 3.1 Lite"
  | "Gemini Omni Flash"
  | "Seedance 2.0"
  | "HappyHorse 1.1 I2V"
  | "Kling 2.5 Turbo";

export type TransitBillingMode = "token" | "per_request" | "fixed";

export interface TransitFixedPriceTier {
  label: string;
  price: number;
  unit?: string | null;
}

export interface TransitModelPrice {
  family: TransitModelFamily;
  standardModel: TransitStandardModel;
  groupName: string;
  rechargeRatio: string | null;
  billingMode?: TransitBillingMode | null;
  modelMultiplier: number | null;
  stationGroupMultiplier?: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  imageOutputPrice: number | null;
  fixedPrice?: number | null;
  fixedPriceCurrency?: "CNY" | null;
  fixedPriceUnit?: string | null;
  fixedPriceTiers?: TransitFixedPriceTier[];
  currency: "CNY";
  accountPool: TransitAccountPool;
  channelType: TransitChannelType;
  priceSource: string;
  lastVerifiedAt: string;
  availability: TransitAvailability;
  cacheUsage?: TransitCacheUsage;
  modelDetection?: TransitModelDetectionSummary;
  history?: TransitMultiplierHistoryPoint[];
}

export interface TransitFeedbackSummary {
  pendingCount: number;
  verifiedRiskCount: number;
  merchantRespondedCount: number;
  mainThemes: string[];
  publicNotes: string | null;
}

export type TransitCommercialOfferType = "coupon" | "affiliate" | "sponsored";
export type TransitVerificationEventSource = "priceai" | "official" | "user" | "merchant";
export type TransitVerificationEventStatus = "success" | "warning" | "failed" | "info";

export const TRANSIT_DEFAULT_COMMERCIAL_OFFER_DISCLOSURE =
  "该访问链接包含 AFF，但不影响页面排序及价格口径；注册后请回原站核验活动规则、充值比例和退款规则。";

export interface TransitCommercialOffer {
  id: string;
  type: TransitCommercialOfferType;
  title: string;
  listLabel?: string | null;
  description: string | null;
  code: string | null;
  url: string | null;
  validUntil: string | null;
  disclosure: string | null;
  enabled: boolean;
}

export interface TransitVerificationEvent {
  id: string;
  source: TransitVerificationEventSource;
  status: TransitVerificationEventStatus;
  title: string;
  description: string | null;
  happenedAt: string;
}

export interface TransitStation {
  id: string;
  slug: string;
  name: string;
  websiteUrl: string;
  apiBaseUrl?: string | null;
  logoUrl?: string | null;
  monitorUrl?: string | null;
  collectorKind?: string | null;
  stationSystem?: TransitStationSystem;
  operatorType: TransitOperatorType;
  invoiceSupport: TransitInvoiceSupport;
  status: TransitStationStatus;
  sourceType: TransitSourceType;
  commercialRelation: TransitCommercialRelation;
  summary: string;
  channelTypes: TransitChannelType[];
  accountPools: TransitAccountPool[];
  paymentMethods: string[];
  minimumTopUp: string | null;
  balanceExpiry: string | null;
  supportChannels: string[];
  refundPolicy: string | null;
  riskLabels: TransitRiskLabel[];
  usageAdvice: TransitUsageAdvice;
  lastUpdatedAt: string;
  collectionStatus?: TransitCollectionStatus;
  collectionError?: string | null;
  lastCollectedAt?: string | null;
  dataStatus: TransitDataStatus;
  availability: TransitAvailability;
  modelDetection?: TransitModelDetectionSummary;
  prices: TransitModelPrice[];
  feedback: TransitFeedbackSummary;
  strengths?: string[];
  cautions?: string[];
  commercialOffers?: TransitCommercialOffer[];
  verificationEvents?: TransitVerificationEvent[];
}

export const TRANSIT_MODEL_FAMILY_LABELS: Record<TransitModelFamily, string> = {
  gpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  glm: "GLM",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  qwen: "千问",
  image: "图片生成",
  video: "视频生成",
};

export const TRANSIT_MODEL_FAMILY_ORDER = [
  "gpt",
  "claude",
  "gemini",
  "grok",
  "glm",
  "deepseek",
  "kimi",
  "qwen",
  "image",
  "video",
] as const satisfies readonly TransitModelFamily[];

export const TRANSIT_TEXT_MODEL_FAMILY_ORDER = TRANSIT_MODEL_FAMILY_ORDER.filter(
  (family): family is Exclude<TransitModelFamily, "image" | "video"> =>
    family !== "image" && family !== "video",
);

export function isTransitTextModelFamily(
  family: TransitModelFamily,
): family is Exclude<TransitModelFamily, "image" | "video"> {
  return family !== "image" && family !== "video";
}

export const TRANSIT_MODEL_FAMILY_OPTIONS: { id: TransitModelFamily; label: string }[] = [
  ...TRANSIT_MODEL_FAMILY_ORDER.map((id) => ({
    id,
    label: TRANSIT_MODEL_FAMILY_LABELS[id],
  })),
];

export const TRANSIT_STATION_SYSTEM_LABELS: Record<TransitStationSystem, string> = {
  new_api: "New API",
  sub_to_api: "Sub2API",
  custom: "自研",
  unknown: "未知",
};

export const TRANSIT_OPERATOR_TYPE_LABELS: Record<TransitOperatorType, string> = {
  company: "企业",
  individual: "个人",
  unknown: "个人",
};

export const TRANSIT_INVOICE_SUPPORT_LABELS: Record<TransitInvoiceSupport, string> = {
  supported: "支持发票",
  unsupported: "不支持发票",
  unknown: "未知",
};

export const TRANSIT_STANDARD_MODELS = [
  "Claude Opus 5",
  "Claude Fable 5",
  "Claude Sonnet 5",
  "Claude Sonnet 4.5",
  "Claude Sonnet 4.6",
  "Claude Haiku 4.5",
  "Claude Opus 4.5",
  "Claude Opus 4.6",
  "Claude Opus 4.7",
  "Claude Opus 4.8",
  "Codex Compact",
  "GPT 5.6 Sol",
  "GPT 5.6 Terra",
  "GPT 5.6 Luna",
  "GPT 5.5",
  "GPT 5.4",
  "GPT 5.4 Mini",
  "Gemini 3.5 Flash",
  "Gemini 3.1 Pro",
  "Grok 4.20",
  "Grok 4.3",
  "Grok 4.5",
  "Grok Build",
  "Composer 2.5",
  "GLM-5.2",
  "GLM-5.1",
  "DeepSeek V4 Flash",
  "DeepSeek V4 Pro",
  "Kimi K3",
  "Qwen3.8-Max-Preview",
  "Qwen3.7-Max",
  "GPT Image 2",
  "Grok Image",
  "Nano Banana Pro",
  "Nano Banana 2",
  "Nano Banana",
  "Nano Banana Lite",
  "Sora 2",
  "Sora 2 Pro",
  "Grok Video",
  "Veo 3.1",
  "Veo 3.1 Lite",
  "Gemini Omni Flash",
  "Seedance 2.0",
  "HappyHorse 1.1 I2V",
  "Kling 2.5 Turbo",
] as const satisfies readonly TransitStandardModel[];

export const TRANSIT_STANDARD_MODEL_FAMILY: Record<TransitStandardModel, TransitModelFamily> = {
  "Claude Opus 5": "claude",
  "Claude Fable 5": "claude",
  "Claude Sonnet 5": "claude",
  "Claude Sonnet 4.5": "claude",
  "Claude Sonnet 4.6": "claude",
  "Claude Haiku 4.5": "claude",
  "Claude Opus 4.5": "claude",
  "Claude Opus 4.6": "claude",
  "Claude Opus 4.7": "claude",
  "Claude Opus 4.8": "claude",
  "Codex Compact": "gpt",
  "GPT 5.6 Sol": "gpt",
  "GPT 5.6 Terra": "gpt",
  "GPT 5.6 Luna": "gpt",
  "GPT 5.5": "gpt",
  "GPT 5.4": "gpt",
  "GPT 5.4 Mini": "gpt",
  "Gemini 3.5 Flash": "gemini",
  "Gemini 3.1 Pro": "gemini",
  "Grok 4.20": "grok",
  "Grok 4.3": "grok",
  "Grok 4.5": "grok",
  "Grok Build": "grok",
  "Composer 2.5": "grok",
  "GLM-5.2": "glm",
  "GLM-5.1": "glm",
  "DeepSeek V4 Flash": "deepseek",
  "DeepSeek V4 Pro": "deepseek",
  "Kimi K3": "kimi",
  "Qwen3.8-Max-Preview": "qwen",
  "Qwen3.7-Max": "qwen",
  "GPT Image 2": "image",
  "Grok Image": "grok",
  "Nano Banana Pro": "image",
  "Nano Banana 2": "image",
  "Nano Banana": "image",
  "Nano Banana Lite": "image",
  "Sora 2": "video",
  "Sora 2 Pro": "video",
  "Grok Video": "grok",
  "Veo 3.1": "video",
  "Veo 3.1 Lite": "video",
  "Gemini Omni Flash": "video",
  "Seedance 2.0": "video",
  "HappyHorse 1.1 I2V": "video",
  "Kling 2.5 Turbo": "video",
};

export const TRANSIT_STANDARD_MODEL_MODALITY: Record<TransitStandardModel, TransitModelModality> = {
  "Claude Opus 5": "text",
  "Claude Fable 5": "text",
  "Claude Sonnet 5": "text",
  "Claude Sonnet 4.5": "text",
  "Claude Sonnet 4.6": "text",
  "Claude Haiku 4.5": "text",
  "Claude Opus 4.5": "text",
  "Claude Opus 4.6": "text",
  "Claude Opus 4.7": "text",
  "Claude Opus 4.8": "text",
  "Codex Compact": "text",
  "GPT 5.6 Sol": "text",
  "GPT 5.6 Terra": "text",
  "GPT 5.6 Luna": "text",
  "GPT 5.5": "text",
  "GPT 5.4": "text",
  "GPT 5.4 Mini": "text",
  "Gemini 3.5 Flash": "text",
  "Gemini 3.1 Pro": "text",
  "Grok 4.20": "text",
  "Grok 4.3": "text",
  "Grok 4.5": "text",
  "Grok Build": "text",
  "Composer 2.5": "text",
  "GLM-5.2": "text",
  "GLM-5.1": "text",
  "DeepSeek V4 Flash": "text",
  "DeepSeek V4 Pro": "text",
  "Kimi K3": "text",
  "Qwen3.8-Max-Preview": "text",
  "Qwen3.7-Max": "text",
  "GPT Image 2": "image",
  "Grok Image": "image",
  "Nano Banana Pro": "image",
  "Nano Banana 2": "image",
  "Nano Banana": "image",
  "Nano Banana Lite": "image",
  "Sora 2": "video",
  "Sora 2 Pro": "video",
  "Grok Video": "video",
  "Veo 3.1": "video",
  "Veo 3.1 Lite": "video",
  "Gemini Omni Flash": "video",
  "Seedance 2.0": "video",
  "HappyHorse 1.1 I2V": "video",
  "Kling 2.5 Turbo": "video",
};

export function isTransitModelFamily(value: unknown): value is TransitModelFamily {
  return typeof value === "string" && TRANSIT_MODEL_FAMILY_ORDER.includes(value as TransitModelFamily);
}

export function isTransitStandardModel(value: unknown): value is TransitStandardModel {
  return typeof value === "string" && TRANSIT_STANDARD_MODELS.includes(value as TransitStandardModel);
}

export function isTransitStationSystem(value: unknown): value is TransitStationSystem {
  return value === "new_api" || value === "sub_to_api" || value === "custom" || value === "unknown";
}

export function transitStandardModelMatchesFamily(
  standardModel: TransitStandardModel,
  family: TransitModelFamily
): boolean {
  if (TRANSIT_STANDARD_MODEL_FAMILY[standardModel] === family) return true;

  const modality = TRANSIT_STANDARD_MODEL_MODALITY[standardModel];
  return (family === "image" && modality === "image") || (family === "video" && modality === "video");
}

export function transitModelPriceMatchesFamily(
  price: Pick<TransitModelPrice, "family" | "standardModel">,
  family: TransitModelFamily
): boolean {
  return price.family === family || transitStandardModelMatchesFamily(price.standardModel, family);
}

export function isTransitOperatorType(value: unknown): value is TransitOperatorType {
  return value === "company" || value === "individual" || value === "unknown";
}

export function isTransitInvoiceSupport(value: unknown): value is TransitInvoiceSupport {
  return value === "supported" || value === "unsupported" || value === "unknown";
}

export const TRANSIT_CHANNEL_TYPE_LABELS: Record<TransitChannelType, string> = {
  official_api: "官方 API",
  cloud: "云厂商",
  first_party_pool: "一手自建号池",
  reverse_engineered: "逆向",
  first_party_wholesale: "一手批发",
  reseller: "二级分销",
  mixed: "混合渠道",
  undisclosed: "未披露",
};

export const TRANSIT_ACCOUNT_POOL_LABELS: Record<TransitAccountPool, string> = {
  pro: "Pro",
  plus: "Plus",
  max: "Max",
  team: "Team",
  kiro: "Kiro",
  enterprise: "企业池",
  official_api: "官方 API",
  mixed: "混池",
  undisclosed: "未披露",
};

export const TRANSIT_RISK_LABELS: Record<TransitRiskLabel, string> = {
  sample_data: "样例数据",
  insufficient_samples: "样本不足",
  mixed_pool: "混池需确认",
  reseller: "二级分销",
  undisclosed_upstream: "上游未披露",
  third_party_aggregate: "第三方聚合",
  pending_feedback: "反馈待核验",
};

export const TRANSIT_USAGE_ADVICE_LABELS: Record<TransitUsageAdvice, string> = {
  try_small: "适合小额试用",
  cautious: "谨慎试用",
  not_recommended: "暂不建议",
  pending: "待核验",
};

export const TRANSIT_COMMERCIAL_LABELS: Record<TransitCommercialRelation, string> = {
  none: "无商业关系",
  listed: "免费收录",
  partner: "入驻",
  affiliate: "AFF",
  sponsored: "广告",
  unknown: "未知",
};

export const TRANSIT_COMMERCIAL_OFFER_TYPE_LABELS: Record<TransitCommercialOfferType, string> = {
  coupon: "用户优惠",
  affiliate: "AFF 链接",
  sponsored: "赞助权益",
};

export const TRANSIT_VERIFICATION_EVENT_SOURCE_LABELS: Record<TransitVerificationEventSource, string> = {
  priceai: "PriceAI 核验",
  official: "官方监测",
  user: "用户反馈",
  merchant: "商家提交",
};

export const TRANSIT_DATA_STATUS_LABELS: Record<TransitDataStatus, string> = {
  sample: "样例",
  pending_review: "待核验",
  verified: "已核验",
};

export const TRANSIT_STATION_STATUS_LABELS: Record<TransitStationStatus, string> = {
  active: "可用",
  limited: "受限",
  unavailable: "不可用",
  unknown: "未知",
};
