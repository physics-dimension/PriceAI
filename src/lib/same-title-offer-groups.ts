import { isAvailable } from "./catalog";
import { productOfferPublicTimestamp } from "./product-offer-filters";
import type { RawOffer } from "./types";

export type SameTitleOfferGroup<Item> = {
  key: string;
  title: string;
  items: Item[];
  representative: Item;
  offerCount: number;
  merchantCount: number;
  availableMerchantCount: number;
  riskMerchantCount: number;
  latestAt: string | null;
};

export function normalizeSameTitle(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function groupSameTitleOffers<Item>(
  items: Item[],
  getOffer: (item: Item) => RawOffer,
  getProductId: (item: Item) => string,
): SameTitleOfferGroup<Item>[] {
  const groups = new Map<string, Item[]>();

  for (const item of items) {
    const offer = getOffer(item);
    const normalizedTitle = normalizeSameTitle(offer.sourceTitle);
    const key = normalizedTitle
      ? `${getProductId(item)}\u0000${normalizedTitle}`
      : `${getProductId(item)}\u0000offer:${offer.id}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  return Array.from(groups.entries()).map(([key, groupItems]) => {
    const sortedItems = [...groupItems].sort((left, right) => compareGroupedOffers(getOffer(left), getOffer(right)));
    const representative = sortedItems[0];
    const representativeOffer = getOffer(representative);
    const merchants = new Set(sortedItems.map((item) => offerMerchantKey(getOffer(item))));
    const availableMerchants = new Set(
      sortedItems
        .filter((item) => isAvailable(getOffer(item)))
        .map((item) => offerMerchantKey(getOffer(item))),
    );
    const riskMerchants = new Set(
      sortedItems
        .filter((item) => Boolean(getOffer(item).riskFeedback?.count))
        .map((item) => offerMerchantKey(getOffer(item))),
    );

    return {
      key,
      title: normalizeSameTitle(representativeOffer.sourceTitle) || representativeOffer.sourceTitle || "未记录原始商品名",
      items: sortedItems,
      representative,
      offerCount: sortedItems.length,
      merchantCount: merchants.size,
      availableMerchantCount: availableMerchants.size,
      riskMerchantCount: riskMerchants.size,
      latestAt: newestOfferTimestamp(sortedItems.map(getOffer)),
    };
  });
}

function compareGroupedOffers(left: RawOffer, right: RawOffer): number {
  const availabilityDelta = Number(isAvailable(right)) - Number(isAvailable(left));
  if (availabilityDelta !== 0) return availabilityDelta;

  const priceDelta = normalizedPrice(left.price) - normalizedPrice(right.price);
  if (priceDelta !== 0) return priceDelta;

  const timestampDelta = timestampValue(productOfferPublicTimestamp(right)) - timestampValue(productOfferPublicTimestamp(left));
  if (timestampDelta !== 0) return timestampDelta;

  return left.id.localeCompare(right.id, "zh-CN");
}

function normalizedPrice(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function timestampValue(value: string | null | undefined): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function newestOfferTimestamp(offers: RawOffer[]): string | null {
  let latestValue = 0;
  let latestAt: string | null = null;

  for (const offer of offers) {
    const value = productOfferPublicTimestamp(offer) || null;
    const timestamp = timestampValue(value);
    if (timestamp > latestValue) {
      latestValue = timestamp;
      latestAt = value;
    }
  }

  return latestAt;
}

function offerMerchantKey(offer: RawOffer): string {
  return offer.sourceId || offer.sourceStoreName || offer.sourceName || `offer:${offer.id}`;
}
