import assert from "node:assert/strict";
import { groupSameTitleOffers, normalizeSameTitle } from "../src/lib/same-title-offer-groups";
import type { RawOffer } from "../src/lib/types";

function offer(overrides: Partial<RawOffer> & Pick<RawOffer, "id" | "sourceTitle">): RawOffer {
  return {
    sourceName: `source-${overrides.id}`,
    price: 10,
    currency: "CNY",
    status: "in_stock",
    url: `https://example.com/item/${overrides.id}`,
    tags: [],
    ...overrides,
  };
}

assert.equal(normalizeSameTitle("  Plus\u3000独享   账号  "), "Plus 独享 账号");

const groups = groupSameTitleOffers(
  [
    { productId: "chatgpt-plus", offer: offer({ id: "risk", sourceId: "merchant-a", sourceTitle: "Plus 独享账号", price: 9, riskFeedback: { count: 1, scope: "source", latestAt: null } }) },
    { productId: "chatgpt-plus", offer: offer({ id: "fresh", sourceId: "merchant-b", sourceTitle: " Plus\u3000独享账号 ", price: 11, verifiedAt: "2026-08-07T10:00:00.000Z" }) },
    { productId: "chatgpt-plus", offer: offer({ id: "out", sourceId: "merchant-c", sourceTitle: "Plus 独享账号", price: 1, status: "out_of_stock" }) },
    { productId: "chatgpt-team", offer: offer({ id: "other-product", sourceTitle: "Plus 独享账号", price: 2 }) },
    { productId: "chatgpt-plus", offer: offer({ id: "different-title", sourceTitle: "Plus 独享账号（未接码）", price: 8 }) },
  ],
  (item) => item.offer,
  (item) => item.productId,
);

assert.equal(groups.length, 3, "same title only groups inside one standard product");
const grouped = groups.find((group) => group.offerCount === 3);
assert.ok(grouped);
assert.equal(grouped.representative.offer.id, "risk", "lowest available offer represents the group");
assert.equal(grouped.availableMerchantCount, 2);
assert.equal(grouped.merchantCount, 3);
assert.equal(grouped.riskMerchantCount, 1);
assert.equal(grouped.latestAt, "2026-08-07T10:00:00.000Z");
assert.deepEqual(grouped.items.map((item) => item.offer.id), ["risk", "fresh", "out"]);

const unavailableGroup = groupSameTitleOffers(
  [
    offer({ id: "out-high", sourceTitle: "缺货商品", status: "out_of_stock", price: 12 }),
    offer({ id: "out-low", sourceTitle: "缺货商品", status: "out_of_stock", price: 8 }),
  ],
  (item) => item,
  () => "product",
)[0];
assert.equal(unavailableGroup.representative.id, "out-low", "all-unavailable groups still keep a deterministic representative");

const availabilityGuardGroup = groupSameTitleOffers(
  [
    offer({ id: "available", sourceTitle: "可用性边界", price: 20 }),
    offer({ id: "stale", sourceTitle: "可用性边界", price: 1, effectiveStatus: "stale" }),
    offer({ id: "failed", sourceTitle: "可用性边界", price: 2, freshnessStatus: "failed" }),
    offer({ id: "expired", sourceTitle: "可用性边界", price: 3, expiresAt: "2020-01-01T00:00:00.000Z" }),
    offer({ id: "no-url", sourceTitle: "可用性边界", price: 4, url: undefined }),
  ],
  (item) => item,
  () => "product",
)[0];
assert.equal(availabilityGuardGroup.representative.id, "available", "invalid low prices never represent the group");
assert.equal(availabilityGuardGroup.availableMerchantCount, 1);

console.log("same-title offer group tests passed");
