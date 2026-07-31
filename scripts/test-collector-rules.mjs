import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "collector-rules-test-key";

const {
  applySourceBuyerFeePolicy,
  applyShopCollectionScheduler,
  assignShopCollectionSchedulerShard,
  blackcatWholesaleActionIdFromChunk,
  blockShopApiDirectExitForTarget,
  calculateShopApiBuyerAdjustment,
  collectorHeartbeatForWritebackFailure,
  cooldownSkipReason,
  classifyShopCollectionScheduleTier,
  collectDujiaoProducts,
  collectGenericHtml,
  collectGenericHtmlProductCards,
  collectKamiItems,
  createShopApiProxyReusePool,
  closeShopApiProxyReusePool,
  createShopApiVisitorId,
  discardShopApiProxyReuseForTarget,
  extractProxyLeaseFromPayload,
  isDailyProbeFailure,
  isWeeklyProbeFailure,
  isShopApiDirectExitBlockedForTarget,
  isShopApiExitErrorMessage,
  isShopApiProxyTransportErrorMessage,
  isLdxpFailoverErrorMessage,
  isGenericProductDetailHref,
  isEmptyResultFullSnapshotTarget,
  kamiInventoryFromStock,
  latestShopCollectionCrawlRunBySource,
  listShopCollectionPriceStats,
  normalizeLdxpRuntimeSettings,
  normalizeShopApiItemOfferUrl,
  nextStorefrontLowestAvailableSpec,
  probeShopApiSourceLightweight,
  rewriteLdxpUrlHost,
  resolveShopApiFeeModel,
  alternateLdxpHost,
  selectTargets,
  shopApiFullSnapshotEvidenceReliable,
  shopApiSnapshotReportedGoodsCount,
  shopApiFeeModelFromChannelRate,
  shopApiProductLevelFeeModel,
  shopApiProxyParallelismFor,
  shopApiProxyContextFromReusePool,
  restoreShopApiProxyReusePool,
  shopApiStoredFeePolicy,
  shopCollectionScheduleTiming,
  shopCollectionSchedulerGroupMatches,
  shopCollectionScheduleReferenceAt,
  selectShopApiPreferredChannel,
  selectBuiltinTargets,
} = await import("./collect-prices.mjs");
const {
  hasSellableOffers,
  legacyFailureObservationInterval,
  nextSourceAvailabilityObservation,
  outOfStockObservationSchedule,
} = await import("./out-of-stock-observation.mjs");

const genericTarget = {
  sourceId: "generic-source",
  sourceName: "Generic Source",
  sourceStoreName: "Generic Source",
  sourceUrl: "https://store.example/",
  baseUrl: "https://store.example",
};

assert.equal(isGenericProductDetailHref("/product/abc"), true);
assert.equal(isGenericProductDetailHref("/checkout/abc"), true);
assert.equal(isGenericProductDetailHref("/buy/12"), true);
assert.equal(isGenericProductDetailHref("/item?id=97"), true);
assert.equal(isGenericProductDetailHref("/?post=3"), true);
assert.equal(isGenericProductDetailHref("/?id=97"), false);
assert.equal(isGenericProductDetailHref("/chatgpt-plus"), false);
assert.equal(isGenericProductDetailHref("/chatgpt-plus", "https://woaimaihao.com"), true);
assert.equal(isGenericProductDetailHref("/supergrok", "https://woaimaihao.com"), true);
assert.equal(isGenericProductDetailHref("/login", "https://woaimaihao.com"), false);
assert.equal(isGenericProductDetailHref("/product"), false);
assert.equal(isGenericProductDetailHref("javascript:void(0)"), false);

const anchorOffers = collectGenericHtmlProductCards(
  genericTarget,
  [
    '<a href="/buy/1"><strong>Google voice（购买）</strong><span>¥ 35.00</span></a>',
    '<a href="/product/43.html">Cursor Pro Student教育优惠成品号 库存: 3 | 销量: 26 | ￥399.90 自动</a>',
    '<a href="/post/13">自动发货 GPT plus菲区月费卡充 库存 8 销量 346 ¥120.00</a>',
    '<a href="/?post=4">GPT Pro 20x 月度会员 自动发货 库存：8 销量：356 PRICE 1100 CNY &yen;1400</a>',
    '<a href="javascript:void(0)">缺货商品 ¥10.00</a>',
  ].join(""),
);
assert.deepEqual(
  anchorOffers.map((offer) => ({ title: offer.sourceTitle, price: offer.price, stock: offer.stockCount, url: offer.url })),
  [
    { title: "Google voice", price: 35, stock: null, url: "https://store.example/buy/1" },
    { title: "Cursor Pro Student教育优惠成品号", price: 399.9, stock: 3, url: "https://store.example/product/43.html" },
    { title: "GPT plus菲区月费卡充", price: 120, stock: 8, url: "https://store.example/post/13" },
    { title: "GPT Pro 20x 月度会员", price: 1100, stock: 8, url: "https://store.example/?post=4" },
  ],
);

const cardsWithoutDetailLinks = collectGenericHtmlProductCards(
  genericTarget,
  '<article><a href="/">店铺首页</a><h3>不能安全绑定的商品</h3><span>¥10.00</span></article>',
);
assert.deepEqual(cardsWithoutDetailLinks, []);

const groupCardHtml = `
  <div class="group/card relative">
    <a href="/product/product-a"><h3>kakao自助充值</h3></a>
    <span>库存 255</span>
    <span>¥</span><span>12.80</span><span>起</span>
    <a href="/product/product-a">立即购买</a>
  </div>
`;
const flightProduct = {
  id: "product-a",
  specs: [
    { name: "低价缺货规格", price: 10.8, stock_available: 0 },
    { name: "kakao自助充值", price: 12.8, stock_available: 255 },
    { name: "快速通道", price: 13.8, stock_available: 3 },
  ],
};
const flightChunk = `9:["$","component",null,{"product":${JSON.stringify(flightProduct)}}]`;
const detailHtml = `<script>self.__next_f.push(${JSON.stringify([1, flightChunk])})</script>`;
assert.deepEqual(nextStorefrontLowestAvailableSpec(detailHtml), {
  price: 12.8,
  stockCount: 255,
  status: "in_stock",
});
const enrichedGenericOffers = await collectGenericHtml(genericTarget, {
  fetchText: async (url) => url === genericTarget.sourceUrl ? groupCardHtml : detailHtml,
});
assert.deepEqual(
  enrichedGenericOffers.map((offer) => ({ title: offer.sourceTitle, price: offer.price, stock: offer.stockCount, url: offer.url })),
  [{ title: "kakao自助充值", price: 12.8, stock: 255, url: "https://store.example/product/product-a" }],
);

const multiProductFallback = await collectGenericHtml(genericTarget, {
  fetchText: async () => "<html><body>商品 A ¥10 商品 B ¥20</body></html>",
});
assert.deepEqual(multiProductFallback, []);
const singleProductTarget = { ...genericTarget, sourceUrl: "https://store.example/product/only" };
const singleProductFallback = await collectGenericHtml(singleProductTarget, {
  fetchText: async () => "<html><head><title>唯一商品</title></head><body>唯一商品 库存 2 ¥10</body></html>",
});
assert.equal(singleProductFallback[0]?.url, singleProductTarget.sourceUrl);

assert.deepEqual(kamiInventoryFromStock("已售罄"), { stockCount: 0, status: "out_of_stock" });
assert.deepEqual(kamiInventoryFromStock("即将售罄"), { stockCount: null, status: "low_stock" });
assert.deepEqual(kamiInventoryFromStock("非常多"), { stockCount: null, status: "in_stock" });
assert.deepEqual(kamiInventoryFromStock("2"), { stockCount: 2, status: "low_stock" });
const kamiOffers = collectKamiItems(
  { ...genericTarget, baseUrl: "https://kami.example" },
  [
    { id: 1, name: "售罄商品", user_price: 10, stock: "已售罄", status: 1, hide: 0 },
    { id: 2, name: "库存紧张商品", user_price: 12, stock: "即将售罄", status: 1, hide: 0 },
  ],
);
assert.deepEqual(kamiOffers.map((offer) => ({ status: offer.status, stock: offer.stockCount, url: offer.url })), [
  { status: "out_of_stock", stock: 0, url: "https://kami.example/item/1" },
  { status: "low_stock", stock: null, url: "https://kami.example/item/2" },
]);

const dujiaoOffers = collectDujiaoProducts(
  { ...genericTarget, baseUrl: "https://dujiao.example" },
  [{
    id: 1,
    slug: "codex",
    title: "Codex 普号",
    price_amount: 9,
    skus: [
      { title: "在售规格", price_amount: 2, auto_stock_available: 3, is_sold_out: false },
      { title: "售罄规格", price_amount: 1, auto_stock_available: 0, is_sold_out: true },
    ],
  }],
);
assert.deepEqual(dujiaoOffers.map((offer) => ({ title: offer.sourceTitle, price: offer.price, status: offer.status, url: offer.url })), [
  { title: "Codex 普号 / 在售规格", price: 2, status: "low_stock", url: "https://dujiao.example/products/codex" },
  { title: "Codex 普号 / 售罄规格", price: 1, status: "out_of_stock", url: "https://dujiao.example/products/codex" },
]);

assert.deepEqual(shopApiFeeModelFromChannelRate(3), { kind: "fixed_3pct", rate: 0.03 });
assert.deepEqual(shopApiFeeModelFromChannelRate(2.5), { kind: "observed_rate", rate: 0.025 });
assert.deepEqual(shopApiFeeModelFromChannelRate(0), { kind: "no_fee", rate: 0 });

assert.deepEqual(
  applySourceBuyerFeePolicy(
    { buyerFeeRate: 0.04, buyerFeeStrategy: "manual_verified" },
    { price: 117.9 },
  ),
  { price: 122.62, listedPrice: 117.9, feeAmount: 4.72, priceBasis: "modeled" },
);
assert.deepEqual(
  applySourceBuyerFeePolicy(
    { buyerFeeRate: 0.04, buyerFeeStrategy: "manual_verified" },
    { price: 103, listedPrice: 100, feeAmount: 3, priceBasis: "settled" },
  ),
  { price: 104, listedPrice: 100, feeAmount: 4, priceBasis: "modeled" },
);
assert.deepEqual(
  applySourceBuyerFeePolicy(
    { buyerFeeRate: 0, buyerFeeStrategy: "manual_verified" },
    { price: 103, listedPrice: 100, feeAmount: 3, priceBasis: "modeled" },
  ),
  { price: 100, listedPrice: 100, feeAmount: 0, priceBasis: "modeled" },
);

const preferredAlipayChannel = selectShopApiPreferredChannel([
  { id: 9, name: "USDT", rate: 0, status: 1, custom_status: 1 },
  { id: 2, code: "AlipayPc", name: "支付宝电脑收款", rate: 3, status: 1, custom_status: 1 },
  { id: 3, name: "微信", rate: 5, status: 1, custom_status: 1 },
]);
assert.equal(preferredAlipayChannel.id, 2);

assert.deepEqual(
  resolveShopApiFeeModel({
    productLevel: false,
    storedFeePolicy: null,
    productFeePolicy: { status: "confirmed", model: { kind: "fixed_3pct", rate: 0.03 } },
    sampleResults: [
      { listedPrice: 100, effectivePrice: { listedPrice: 100, feeAmount: 4, priceBasis: "settled" } },
    ],
    channelRate: 3,
  }),
  { kind: "observed_rate", rate: 0.04 },
);

assert.equal(calculateShopApiBuyerAdjustment(100, 100), 0);
assert.equal(calculateShopApiBuyerAdjustment(102.8, 100), 2.8);
assert.equal(calculateShopApiBuyerAdjustment(99, 100), 0);

assert.equal(isDailyProbeFailure("店铺接口正常，完整商品快照为空（goods_count=0）。", 3), true);
assert.equal(isDailyProbeFailure("店铺正常但没有商品", 4), true);
assert.equal(isDailyProbeFailure("HTTP 404 from source", 3), false);
assert.equal(isDailyProbeFailure("采集结果为空", 4), false);
assert.equal(isDailyProbeFailure("店铺接口正常，完整商品快照为空（goods_count=0）。", 2), false);
assert.equal(isWeeklyProbeFailure("HTTP 404 from source", 3), true);
assert.equal(isWeeklyProbeFailure("采集结果为空", 4), false);
assert.equal(isWeeklyProbeFailure("fetch failed", 3), false);
assert.equal(isWeeklyProbeFailure("HTTP 403 challenge", 3), false);
assert.equal(isWeeklyProbeFailure("HTTP 468", 3), true);
assert.equal(isWeeklyProbeFailure("HTTP 502", 3), false);
assert.equal(isWeeklyProbeFailure("HTTP 522", 3), false);
assert.equal(isWeeklyProbeFailure("商家已被关闭交易", 3), true);
assert.equal(isWeeklyProbeFailure("域名跳转至运营商警告页", 3), true);
assert.equal(isWeeklyProbeFailure("No shop token found", 3), true);
assert.equal(isWeeklyProbeFailure("未知采集器错误", 3), true);
assert.equal(isWeeklyProbeFailure("HTTP 404 from source", 2), false);
assert.equal(isWeeklyProbeFailure("店铺接口正常，完整商品快照为空（goods_count=0）。", 3), false);
assert.equal(legacyFailureObservationInterval("HTTP 403 challenge", 3), null);
assert.equal(legacyFailureObservationInterval("采集结果为空。", 4), null);
assert.equal(legacyFailureObservationInterval("店铺接口正常，完整商品快照为空（goods_count=0）。", 3), 24 * 60);
assert.equal(legacyFailureObservationInterval("HTTP 404 from source", 3), 7 * 24 * 60);

const observationNow = Date.parse("2026-07-29T12:00:00.000Z");
assert.deepEqual(
  outOfStockObservationSchedule({
    availabilityStatus: "out_of_stock",
    outOfStockSince: "2026-07-29T06:00:00.000Z",
    consecutiveOutOfStockSnapshots: 1,
    collectionGroup: "vip_15m",
  }, observationNow),
  { tier: "out_of_stock_watch_1h", intervalMinutes: 60, reason: "VIP 来源刚确认缺货，按 1 小时观察补货" },
);
assert.equal(outOfStockObservationSchedule({
  availability_status: "out_of_stock",
  out_of_stock_since: "2026-07-28T06:00:00.000Z",
  consecutive_out_of_stock_snapshots: 2,
  collection_group: "automatic",
}, observationNow)?.tier, "out_of_stock_watch_6h");
assert.equal(outOfStockObservationSchedule({
  availabilityStatus: "out_of_stock",
  outOfStockSince: "2026-07-25T06:00:00.000Z",
  consecutiveOutOfStockSnapshots: 3,
  collectionGroup: "automatic",
}, observationNow)?.tier, "daily_probe");
assert.equal(outOfStockObservationSchedule({
  availabilityStatus: "out_of_stock",
  outOfStockSince: "2026-07-01T06:00:00.000Z",
  consecutiveOutOfStockSnapshots: 12,
  collectionGroup: "automatic",
}, observationNow)?.tier, "weekly_probe");
assert.equal(outOfStockObservationSchedule({
  availabilityStatus: "out_of_stock",
  outOfStockSince: "2026-07-01T06:00:00.000Z",
  consecutiveOutOfStockSnapshots: 12,
  collectionGroup: "vip_15m",
}, observationNow)?.tier, "daily_probe");
assert.equal(outOfStockObservationSchedule({ availabilityStatus: "available" }, observationNow), null);
assert.equal(hasSellableOffers([]), false);
assert.equal(hasSellableOffers([
  { status: "out_of_stock", stockCount: 0 },
  { status: "low_stock", stockCount: 0 },
]), false);
assert.equal(hasSellableOffers([
  { status: "out_of_stock", stockCount: 0 },
  { status: "in_stock", stockCount: 1 },
]), true);
assert.deepEqual(nextSourceAvailabilityObservation({
  out_of_stock_since: "2026-07-29T06:00:00.000Z",
  consecutive_out_of_stock_snapshots: 2,
}, "2026-07-29T12:00:00.000Z", false), {
  availability_status: "out_of_stock",
  out_of_stock_since: "2026-07-29T06:00:00.000Z",
  consecutive_out_of_stock_snapshots: 3,
});
assert.deepEqual(nextSourceAvailabilityObservation({}, "2026-07-29T12:00:00.000Z", true), {
  availability_status: "available",
  out_of_stock_since: null,
  consecutive_out_of_stock_snapshots: 0,
});

assert.equal(isEmptyResultFullSnapshotTarget({ kind: "shopApi" }, {
  fullSnapshot: true,
  reportedGoodsCount: 0,
  fetchedItemCount: 0,
  rawSeenOfferCount: 0,
  publishedItemCount: 0,
}), true);
assert.equal(isEmptyResultFullSnapshotTarget({ kind: "shopApi" }, {
  fullSnapshot: false,
  reportedGoodsCount: 0,
  fetchedItemCount: 0,
  rawSeenOfferCount: 0,
  publishedItemCount: 0,
}), false);
assert.equal(isEmptyResultFullSnapshotTarget({ kind: "shopApi" }, { reportedGoodsCount: 0 }), false);
assert.equal(
  blackcatWholesaleActionIdFromChunk(
    'createServerReference)("00fc36c4f4551a0ad0887d0946a6c93bc94960dfaf",callServer,void 0,findSourceMapURL,"fetchWholesaleProductsAction")',
  ),
  "00fc36c4f4551a0ad0887d0946a6c93bc94960dfaf",
);
assert.equal(blackcatWholesaleActionIdFromChunk("unrelated chunk"), null);
assert.equal(isShopApiExitErrorMessage("HTTP 520 from upstream"), true);
assert.equal(isShopApiExitErrorMessage("HTTP 403 from upstream"), true);
assert.equal(isShopApiProxyTransportErrorMessage("fetch failed: ECONNRESET: socket closed"), true);
assert.equal(isShopApiProxyTransportErrorMessage("fetch failed: UND_ERR_CONNECT_TIMEOUT"), true);
assert.equal(isShopApiProxyTransportErrorMessage("fetch failed"), false);
assert.equal(isShopApiProxyTransportErrorMessage("Shop info unavailable for token shop"), false);
const shopApiVisitorIds = Array.from({ length: 8 }, () => createShopApiVisitorId());
assert.equal(new Set(shopApiVisitorIds).size, shopApiVisitorIds.length);
assert.equal(shopApiVisitorIds.every((value) => /^[a-f0-9]{24}$/.test(value)), true);
assert.equal(shopApiVisitorIds.some((value) => value.startsWith("probe")), false);
const lightweightProbeCalls = [];
const lightweightProbe = await probeShopApiSourceLightweight(
  {
    id: "lightweight-shop",
    name: "轻量测试店",
    entry_url: "https://shop.example/shop/demo",
    base_url: "https://shop.example",
  },
  {
    pageSize: 20,
    async requestJson(url, body, referer) {
      lightweightProbeCalls.push({ url, body, referer });
      if (url.endsWith("/info")) {
        return {
          code: 1,
          data: {
            nickname: "轻量测试店",
            link: "https://shop.example/shop/demo",
          },
        };
      }
      return {
        code: 1,
        data: {
          total: 1,
          list: [
            {
              name: "ChatGPT Team",
              price: "99.00",
              extend: { stock_count: 3 },
            },
          ],
        },
      };
    },
  },
);
assert.equal(lightweightProbe.requestCount, 2);
assert.equal(lightweightProbe.comparableItemCount, 1);
assert.equal(lightweightProbe.samples[0].price, 99);
assert.equal(lightweightProbeCalls.length, 2);
assert.equal(lightweightProbeCalls[0].url, "https://shop.example/shopApi/Shop/info");
assert.equal(lightweightProbeCalls[1].url, "https://shop.example/shopApi/Shop/goodsList");
assert.equal(lightweightProbeCalls[1].body.current, 1);
assert.equal(lightweightProbeCalls[1].body.pageSize, 20);
let lightweightFailureCalls = 0;
await assert.rejects(
  () => probeShopApiSourceLightweight(
    {
      id: "limited-shop",
      name: "限流测试店",
      entry_url: "https://shop.example/shop/limited",
    },
    {
      async requestJson() {
        lightweightFailureCalls += 1;
        throw new Error("returned HTTP 520");
      },
    },
  ),
  /HTTP 520/,
);
assert.equal(lightweightFailureCalls, 1);
assert.deepEqual(normalizeLdxpRuntimeSettings(null), {
  mode: "auto",
  activeHost: "www.ldxp.cn",
  lastSwitchedAt: null,
  lastSwitchReason: null,
});
assert.equal(normalizeLdxpRuntimeSettings({ mode: "pay", activeHost: "www.ldxp.cn" }).activeHost, "pay.ldxp.cn");
assert.equal(alternateLdxpHost("www.ldxp.cn"), "pay.ldxp.cn");
assert.equal(alternateLdxpHost("pay.ldxp.cn"), "www.ldxp.cn");
assert.equal(rewriteLdxpUrlHost("https://pay.ldxp.cn", "www.ldxp.cn"), "https://www.ldxp.cn");
assert.equal(rewriteLdxpUrlHost("https://pay.ldxp.cn/", "www.ldxp.cn"), "https://www.ldxp.cn");
assert.equal(
  rewriteLdxpUrlHost("https://pay.ldxp.cn/item/abc123?channel=9#buy", "www.ldxp.cn"),
  "https://www.ldxp.cn/item/abc123?channel=9#buy",
);
assert.equal(normalizeShopApiItemOfferUrl("https://www.ldxp.cn/item/abc123"), "https://pay.ldxp.cn/item/abc123");
assert.equal(isLdxpFailoverErrorMessage("returned HTTP 520"), true);
assert.equal(isLdxpFailoverErrorMessage("fetch failed: UND_ERR_CONNECT_TIMEOUT"), true);
assert.equal(isLdxpFailoverErrorMessage("returned HTTP 403 (denied by http_ratelimit)"), false);
assert.equal(isLdxpFailoverErrorMessage("returned HTTP 429"), false);
assert.equal(shopApiSnapshotReportedGoodsCount(78, 79), 78);
assert.equal(shopApiSnapshotReportedGoodsCount(null, 79), 79);
assert.equal(
  shopApiFullSnapshotEvidenceReliable(Array(80), {
    reportedGoodsCount: 100,
    fetchedItemCount: 80,
    rawSeenOfferCount: 80,
    publishedItemCount: 80,
  }),
  true,
);
assert.equal(
  shopApiFullSnapshotEvidenceReliable(Array(79), {
    reportedGoodsCount: 100,
    fetchedItemCount: 79,
    rawSeenOfferCount: 79,
    publishedItemCount: 79,
  }),
  false,
);
assert.equal(
  shopApiFullSnapshotEvidenceReliable(Array(80), {
    reportedGoodsCount: 100,
    fetchedItemCount: 80,
    rawSeenOfferCount: 81,
    publishedItemCount: 80,
  }),
  false,
);
assert.equal(shopApiProxyParallelismFor({ shopApiProxyParallelism: "auto" }, 9), 1);
assert.equal(shopApiProxyParallelismFor({ shopApiProxyParallelism: "auto" }, 30), 1);
assert.equal(shopApiProxyParallelismFor({ shopApiProxyParallelism: "auto" }, 31), 2);
assert.equal(shopApiProxyParallelismFor({ shopApiProxyParallelism: "auto" }, 90), 2);

const mixedYunmaoFeeModel = shopApiProductLevelFeeModel(0, [
  { listedPrice: 100, effectivePrice: { listedPrice: 100, feeAmount: 0, priceBasis: "settled" } },
  { listedPrice: 10, effectivePrice: { listedPrice: 10, feeAmount: 0.18, priceBasis: "settled" } },
  { listedPrice: 1, effectivePrice: { listedPrice: 1, feeAmount: 0, priceBasis: "settled" } },
]);
assert.deepEqual(mixedYunmaoFeeModel, { kind: "observed_rate", rate: 0.018 });
assert.deepEqual(
  shopApiProductLevelFeeModel(0, [
    { listedPrice: 100, effectivePrice: { listedPrice: 100, feeAmount: 0, priceBasis: "settled" } },
  ]),
  { kind: "no_fee", rate: 0 },
);

const proxyLease = extractProxyLeaseFromPayload(
  JSON.stringify({ data: [{ ip: "203.0.113.10:54103", expireTimeMillis: Date.now() + 600_000 }] }),
);
assert.equal(proxyLease.proxyUrl, "http://203.0.113.10:54103");
assert.ok(proxyLease.expiresAt > Date.now());

const proxyReusePool = createShopApiProxyReusePool({ shopApiProxyReuseLimit: 0 });
const proxyStateOptions = { shopApiProxyReusePool: proxyReusePool };
const liandongTarget = { sourceId: "ldxp-shop", baseUrl: "https://pay.ldxp.cn" };
assert.equal(isShopApiDirectExitBlockedForTarget(liandongTarget, proxyStateOptions), false);
blockShopApiDirectExitForTarget(liandongTarget, proxyStateOptions);
assert.equal(isShopApiDirectExitBlockedForTarget(liandongTarget, proxyStateOptions), true);
assert.equal(
  isShopApiDirectExitBlockedForTarget({ sourceId: "yunmao", baseUrl: "https://catfk.com" }, proxyStateOptions),
  false,
);

{
  const stateDirectory = mkdtempSync(join(tmpdir(), "priceai-proxy-state-"));
  const statePath = join(stateDirectory, "proxy-leases.json");
  const proxyUrl = "http://proxy-user:proxy-password@203.0.113.10:54103";
  const logLines = [];
  const logger = { log: (message) => logLines.push(String(message)) };
  const poolOptions = {
    shopApiProxyReuseLimit: 0,
    shopApiProxyReuseTtlMs: 600_000,
    shopApiProxyStatePath: statePath,
    shopApiProxyMaxRuns: 2,
    shopApiProxyLogger: logger,
  };

  try {
    const firstPool = createShopApiProxyReusePool(poolOptions);
    const acquired = await shopApiProxyContextFromReusePool("pay.ldxp.cn", {
      shopApiProxyReusePool: firstPool,
      shopApiProxyUrl: proxyUrl,
      shopApiProxyLogger: logger,
    });
    assert.equal(acquired.shared, true);
    assert.equal(existsSync(statePath), true);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).leases["pay.ldxp.cn"].usedRuns, 1);
    await closeShopApiProxyReusePool(firstPool);

    const secondPool = createShopApiProxyReusePool(poolOptions);
    assert.equal(await restoreShopApiProxyReusePool(secondPool), 1);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).leases["pay.ldxp.cn"].usedRuns, 2);
    assert.equal(secondPool.entries.has("pay.ldxp.cn"), true);
    await closeShopApiProxyReusePool(secondPool);

    const thirdPool = createShopApiProxyReusePool(poolOptions);
    assert.equal(await restoreShopApiProxyReusePool(thirdPool), 0);
    assert.equal(existsSync(statePath), false);
    await closeShopApiProxyReusePool(thirdPool);

    writeFileSync(statePath, JSON.stringify({
      version: 1,
      leases: {
        "pay.ldxp.cn": { proxyUrl, expiresAt: Date.now() + 30_000, usedRuns: 1 },
      },
    }), { mode: 0o600 });
    const expiredPool = createShopApiProxyReusePool(poolOptions);
    assert.equal(await restoreShopApiProxyReusePool(expiredPool), 0);
    assert.equal(existsSync(statePath), false);

    writeFileSync(statePath, "{not-json", { mode: 0o600 });
    const invalidPool = createShopApiProxyReusePool(poolOptions);
    assert.equal(await restoreShopApiProxyReusePool(invalidPool), 0);
    assert.equal(existsSync(statePath), false);

    const discardPool = createShopApiProxyReusePool(poolOptions);
    await shopApiProxyContextFromReusePool("pay.ldxp.cn", {
      shopApiProxyReusePool: discardPool,
      shopApiProxyUrl: proxyUrl,
      shopApiProxyLogger: logger,
    });
    assert.equal(await discardShopApiProxyReuseForTarget(liandongTarget, {
      shopApiProxyReusePool: discardPool,
    }, { reason: "transport-error", logger }), true);
    assert.equal(existsSync(statePath), false);
    await closeShopApiProxyReusePool(discardPool);

    assert.equal(logLines.some((line) => line.includes(proxyUrl)), false);
    assert.equal(logLines.some((line) => line.includes("proxy-password")), false);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

const future = new Date(Date.now() + 60_000).toISOString();
assert.equal(shopApiStoredFeePolicy([{ shop_token: "shop", rate: 0, sample_selection: "high_price_probe", expires_at: future }], "shop"), null);
assert.deepEqual(
  shopApiStoredFeePolicy([{ shop_token: "shop", rate: 0, sample_selection: "manual_verified", observed_at: future, expires_at: future }], "shop")?.model,
  { kind: "no_fee", rate: 0 },
);
assert.deepEqual(
  shopApiStoredFeePolicy(
    [{ shopToken: "shop", rate: 0.04, sampleSelection: "high_price_probe", observedAt: future, expiresAt: future }],
    "shop",
    { allowHighPriceProbe: true },
  )?.model,
  { kind: "observed_rate", rate: 0.04 },
);

const assignment = new Map([["source-a", 1]]);
assert.equal(
  assignShopCollectionSchedulerShard(
    { sourceId: "source-a", sourceName: "A" },
    { count: 2, index: 1 },
    assignment,
  ).schedulerShardIndex,
  1,
);

const shardZero = assignShopCollectionSchedulerShard(
  { sourceId: "source-a", sourceName: "A" },
  { count: 2, index: 0 },
  assignment,
);
assert.equal(shardZero.shardMatches, false);
assert.equal(shopCollectionSchedulerGroupMatches({ collectionGroup: "vip_15m" }, { "shop-scheduler-group": "vip_15m" }), true);
assert.equal(shopCollectionSchedulerGroupMatches({ collectionGroup: "automatic" }, { "shop-scheduler-group": "vip_15m" }), false);
assert.equal(shopCollectionSchedulerGroupMatches({ collectionGroup: "vip_15m" }, {}), false);
assert.equal(shopCollectionSchedulerGroupMatches({ collectionGroup: "automatic" }, {}), true);

const lowFrequencyLastRunMs = Date.parse("2026-07-25T00:07:50.886Z");
const lowFrequencyBeforeDue = shopCollectionScheduleTiming({
  sourceId: "catfk-hththt",
  tier: "low_3h",
  intervalMs: 180 * 60_000,
  lastRunMs: lowFrequencyLastRunMs,
  nowMs: Date.parse("2026-07-25T03:07:34.680Z"),
  bucketMinutes: 30,
});
assert.equal(lowFrequencyBeforeDue.due, false);
assert.equal(lowFrequencyBeforeDue.nextRunAt, "2026-07-25T03:07:50.886Z");

const lowFrequencyNextTick = shopCollectionScheduleTiming({
  sourceId: "catfk-hththt",
  tier: "low_3h",
  intervalMs: 180 * 60_000,
  lastRunMs: lowFrequencyLastRunMs,
  nowMs: Date.parse("2026-07-25T03:37:34.680Z"),
  bucketMinutes: 30,
});
assert.equal(lowFrequencyNextTick.bucketMatches, false);
assert.equal(lowFrequencyNextTick.due, true);
assert.equal(lowFrequencyNextTick.remainingMinutes, 0);

const emptyVipSchedule = await applyShopCollectionScheduler(
  [{ sourceId: "source-a", sourceName: "A", kind: "shopApi", baseUrl: "https://pay.ldxp.cn", collectionGroup: "automatic" }],
  { "shop-scheduler-group": "vip_15m" },
);
assert.equal(emptyVipSchedule.targets.length, 0);
assert.equal(emptyVipSchedule.summary.effectiveTargetCount, 0);

const nonFamilyVipSchedule = await applyShopCollectionScheduler(
  [
    { sourceId: "auto-unknown", sourceName: "Unknown auto", kind: "shopApi", baseUrl: "https://shop.example.com", collectionGroup: "automatic" },
    { sourceId: "vip-unknown", sourceName: "Unknown VIP", kind: "shopApi", baseUrl: "https://shop.example.com", collectionGroup: "vip_15m" },
  ],
  { "shop-scheduler-group": "vip_15m" },
);
assert.equal(nonFamilyVipSchedule.targets.length, 0);

const failedVipContextSchedule = await applyShopCollectionScheduler(
  [
    { sourceId: "vip-source", sourceName: "VIP", kind: "shopApi", baseUrl: "https://pay.ldxp.cn", collectionGroup: "vip_15m" },
    { sourceId: "auto-source", sourceName: "Auto", kind: "shopApi", baseUrl: "https://pay.ldxp.cn", collectionGroup: "automatic" },
  ],
  {
    "shop-scheduler-group": "vip_15m",
    shopSchedulerContextLoader: async () => { throw new Error("context unavailable"); },
  },
);
assert.deepEqual(failedVipContextSchedule.targets.map((target) => target.sourceId), []);
assert.equal(failedVipContextSchedule.summary.effectiveTargetCount, 0);
assert.equal(failedVipContextSchedule.summary.reason, "scheduler-context-failed");

let forwardedSchedulerOptions = null;
await applyShopCollectionScheduler(
  [{ sourceId: "vip-source", sourceName: "VIP", kind: "shopApi", baseUrl: "https://pay.ldxp.cn", collectionGroup: "vip_15m" }],
  {
    "shop-scheduler-group": "vip_15m",
    shopSchedulerContextLoader: async (_supabase, _targets, schedulerOptions) => {
      forwardedSchedulerOptions = schedulerOptions;
      return {
        offerStatsBySource: new Map(),
        priceStatsBySource: new Map(),
        latestRunBySource: new Map(),
        shardAssignmentsBySource: new Map(),
      };
    },
  },
);
assert.equal(forwardedSchedulerOptions?.["shop-scheduler-group"], "vip_15m");

const originalWarn = console.warn;
const schedulerWarnings = [];
console.warn = (message) => schedulerWarnings.push(String(message));
const priceStatsAfterRefreshTimeout = await listShopCollectionPriceStats({
  async rpc(name) {
    if (name === "refresh_source_quality_price_benchmarks_if_stale") {
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
    assert.equal(name, "list_source_quality_price_benchmarks");
    return {
      data: [{ source_id: "ldxp-youzhi", benchmark_offer_count: 95, lowest_hit_count: 23 }],
      error: null,
    };
  },
});
console.warn = originalWarn;
assert.equal(priceStatsAfterRefreshTimeout.length, 1);
assert.equal(priceStatsAfterRefreshTimeout[0].sourceId, "ldxp-youzhi");
assert.match(schedulerWarnings[0], /statement timeout/);

const benchmarkCalls = [];
const vipPriceStats = await listShopCollectionPriceStats({
  async rpc(name) {
    benchmarkCalls.push(name);
    return {
      data: name === "list_source_quality_price_benchmarks"
        ? [{ source_id: "ldxp-youzhi", benchmark_offer_count: 75 }]
        : null,
      error: null,
    };
  },
}, { refresh: false });
assert.deepEqual(benchmarkCalls, ["list_source_quality_price_benchmarks"]);
assert.equal(vipPriceStats[0].sourceId, "ldxp-youzhi");

assert.deepEqual(
  collectorHeartbeatForWritebackFailure([
    { status: "success", offers: 77 },
  ], Object.assign(new Error("fetch failed: ETIMEDOUT"), { spoolPersisted: true })),
  {
    status: "partial",
    successCount: 1,
    failureCount: 0,
    offerCount: 77,
    collectionCompleted: true,
    spoolPersisted: true,
    message: "源站采集已完成，结果回传延迟并已进入本地 spool，等待下轮补写：fetch failed: ETIMEDOUT",
  },
);
assert.equal(
  collectorHeartbeatForWritebackFailure([{ status: "success", offers: 77 }], new Error("disk full")).status,
  "failed",
);
assert.equal(
  collectorHeartbeatForWritebackFailure([{ status: "failed", offers: 0 }], new Error("HTTP 520")).status,
  "failed",
);

const now = Date.now();
assert.equal(
  cooldownSkipReason(
    {
      lastSuccessAt: new Date(now - 16 * 60_000).toISOString(),
      collectionSchedule: { intervalMinutes: 15 },
    },
    { all: true },
  ),
  null,
);
assert.match(
  cooldownSkipReason(
    {
      lastSuccessAt: new Date(now - 16 * 60_000).toISOString(),
    },
    { all: true },
  )?.message || "",
  /最近 25 分钟/,
);

const aggregatedRuns = latestShopCollectionCrawlRunBySource([
  {
    id: "batch-b",
    sourceId: "ldxp-youzhi",
    status: "success",
    startedAt: "2026-07-19T18:18:21.050Z",
    finishedAt: "2026-07-19T18:18:26.137Z",
    successCount: 3,
    failureCount: 0,
    details: { writeStats: { receivedCount: 3, writtenCount: 0, refreshedCount: 3 } },
  },
  {
    id: "batch-a",
    sourceId: "ldxp-youzhi",
    status: "success",
    startedAt: "2026-07-19T18:18:21.050Z",
    finishedAt: "2026-07-19T18:18:26.137Z",
    successCount: 25,
    failureCount: 0,
    details: { writeStats: { receivedCount: 25, writtenCount: 5, refreshedCount: 20 } },
  },
]);
assert.equal(aggregatedRuns.get("ldxp-youzhi")?.successCount, 28);
assert.deepEqual(aggregatedRuns.get("ldxp-youzhi")?.details.writeStats, {
  receivedCount: 28,
  writtenCount: 5,
  refreshedCount: 23,
});

const fullStoreFinishedAt = "2026-07-19T18:18:26.137Z";
const hotVerificationFinishedAt = "2026-07-19T18:28:26.137Z";
const fullStoreRunAfterHotVerification = latestShopCollectionCrawlRunBySource([
  {
    id: "full-store",
    sourceId: "ldxp-youzhi",
    status: "success",
    startedAt: "2026-07-19T18:18:21.050Z",
    finishedAt: fullStoreFinishedAt,
    successCount: 81,
    failureCount: 0,
    details: { fullSnapshot: true },
  },
  {
    id: "hot-verification",
    sourceId: "ldxp-youzhi",
    status: "success",
    startedAt: "2026-07-19T18:28:21.050Z",
    finishedAt: hotVerificationFinishedAt,
    successCount: 8,
    failureCount: 0,
    details: { fullSnapshot: false, hotVerification: true },
  },
]);
assert.equal(fullStoreRunAfterHotVerification.get("ldxp-youzhi")?.id, "full-store");
assert.equal(
  shopCollectionScheduleReferenceAt(
    { lastSuccessAt: hotVerificationFinishedAt, lastCheckedAt: hotVerificationFinishedAt },
    fullStoreRunAfterHotVerification.get("ldxp-youzhi"),
    "vip_15m",
  ),
  fullStoreFinishedAt,
);

assert.equal(
  classifyShopCollectionScheduleTier({
    target: { collectionGroup: "vip_15m", healthStatus: "healthy", consecutiveFailures: 0, lastSuccessAt: "2026-07-19T18:18:26.137Z" },
    latestRun: aggregatedRuns.get("ldxp-youzhi"),
    scaleBand: "medium",
    changeBand: "medium",
    lowPriceBand: "unknown",
    hotProductOfferCount: 0,
    hotProductLowestHitCount: 0,
    hotProductTop5HitCount: 0,
  }).tier,
  "vip_15m",
);
assert.equal(
  classifyShopCollectionScheduleTier({
    target: {
      collectionGroup: "vip_15m",
      healthStatus: "healthy",
      consecutiveFailures: 0,
      lastSuccessAt: new Date().toISOString(),
      availabilityStatus: "out_of_stock",
      outOfStockSince: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      consecutiveOutOfStockSnapshots: 1,
    },
    latestRun: { status: "success", successCount: 2 },
    scaleBand: "small",
    changeBand: "low",
    lowPriceBand: "strong",
    hotProductOfferCount: 1,
    hotProductLowestHitCount: 1,
    hotProductTop5HitCount: 1,
  }).tier,
  "out_of_stock_watch_1h",
);
assert.equal(
  classifyShopCollectionScheduleTier({
    target: { collectionGroup: "vip_15m", healthStatus: "failing", consecutiveFailures: 1, lastSuccessAt: "2026-07-19T18:18:26.137Z", lastError: "fetch failed" },
    latestRun: { ...aggregatedRuns.get("ldxp-youzhi"), status: "failed", message: "fetch failed" },
    scaleBand: "medium",
    changeBand: "medium",
    lowPriceBand: "unknown",
    hotProductOfferCount: 0,
    hotProductLowestHitCount: 0,
    hotProductTop5HitCount: 0,
  }).tier,
  "retry_priority",
);
assert.equal(
  classifyShopCollectionScheduleTier({
    target: { collectionGroup: "automatic", healthStatus: "failing", consecutiveFailures: 4, lastError: "HTTP 403 challenge" },
    latestRun: { status: "failed", message: "HTTP 403 challenge" },
    scaleBand: "large",
    changeBand: "unknown",
    lowPriceBand: "weak",
    hotProductOfferCount: 0,
    hotProductLowestHitCount: 0,
    hotProductTop5HitCount: 0,
  }).tier,
  "retry_cooldown",
);
assert.equal(
  classifyShopCollectionScheduleTier({
    target: { collectionGroup: "automatic", healthStatus: "failing", consecutiveFailures: 4, lastError: "采集结果为空。" },
    latestRun: { status: "failed", message: "采集结果为空。" },
    scaleBand: "large",
    changeBand: "unknown",
    lowPriceBand: "weak",
    hotProductOfferCount: 0,
    hotProductLowestHitCount: 0,
    hotProductTop5HitCount: 0,
  }).tier,
  "retry_cooldown",
);
assert.equal(
  classifyShopCollectionScheduleTier({
    target: { collectionGroup: "automatic", healthStatus: "failing", consecutiveFailures: 4, lastError: "HTTP 404 from source" },
    latestRun: { status: "failed", message: "HTTP 404 from source" },
    scaleBand: "large",
    changeBand: "unknown",
    lowPriceBand: "weak",
    hotProductOfferCount: 0,
    hotProductLowestHitCount: 0,
    hotProductTop5HitCount: 0,
  }).tier,
  "weekly_probe",
);

const excludedSources = selectTargets(
  [
    { sourceId: "source-a", sourceName: "A", sourceUrl: "https://a.example", kind: "kami" },
    { sourceId: "source-b", sourceName: "B", sourceUrl: "https://b.example", kind: "kami" },
  ],
  { all: true, excludeSource: "source-a" },
);
assert.deepEqual(excludedSources.map((target) => target.sourceId), ["source-b"]);

const shopFamilyTargets = [
  { sourceId: "ldxp-shop", sourceName: "LDXP", sourceUrl: "https://pay.ldxp.cn/shop/demo", baseUrl: "https://pay.ldxp.cn", kind: "shopApi" },
  { sourceId: "yunmao-shop", sourceName: "Yunmao", sourceUrl: "https://catfk.com/shop/demo", baseUrl: "https://catfk.com", kind: "shopApi" },
  { sourceId: "qxvx-shop", sourceName: "QXVX", sourceUrl: "https://pay.qxvx.cn/shop/demo", baseUrl: "https://pay.qxvx.cn", kind: "shopApi" },
];
assert.deepEqual(
  selectTargets(shopFamilyTargets, { all: true, "collector-kind": "shopApi", "include-family": "yunmao" })
    .map((target) => target.sourceId),
  ["yunmao-shop"],
);
assert.deepEqual(
  selectTargets(shopFamilyTargets, { all: true, includeFamily: "catfk.com" })
    .map((target) => target.sourceId),
  ["yunmao-shop"],
);
assert.deepEqual(
  selectTargets(shopFamilyTargets, { all: true, excludeFamily: "yunmao" })
    .map((target) => target.sourceId),
  ["ldxp-shop", "qxvx-shop"],
);
assert.deepEqual(
  selectBuiltinTargets({ source: "ldxp", "include-family": "yunmao" }),
  [],
);

console.log("collector rules: ok");
