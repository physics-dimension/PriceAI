import type { Metadata } from "next";
import { ArrowRight, Clock3, ExternalLink, Layers3 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { JsonLd } from "@/components/JsonLd";
import { ProductDetailHeader, ProductReturnLink } from "@/components/ProductDetailHeader";
import { ProductOffersPanel } from "@/components/ProductOffersPanel";
import { publicCatalogProducts } from "@/lib/catalog";
import { getPublicProductSummary, listPublicProductOffers } from "@/lib/data";
import {
  getOfficialPricePlanSummaryFromDataset,
  getOfficialPriceRowsByIdFromDataset,
  officialPricePlanId,
  type OfficialPricePlanSummary,
  type OfficialPriceRow,
  type OfficialPricesDataset,
} from "@/lib/official-prices";
import { getOfficialPricesDataset } from "@/lib/official-prices-db";
import { PUBLIC_OFFER_DEFAULT_LIMIT } from "@/lib/public-offer-query";
import { getProductSeoProfile, shouldNoIndexProduct, type ProductSeoProfile } from "@/lib/product-seo";
import type { ExplorerProductSummary } from "@/lib/types";
import { formatCurrency, formatRelativeTime } from "@/lib/utils";

export const revalidate = 300;
export const dynamicParams = true;

export function generateStaticParams() {
  return publicCatalogProducts().map((product) => ({ id: product.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const product = await getPublicProductSummary(id);

  if (!product) {
    return {
      title: "商品详情",
    };
  }

  const priceText = product.lowestPrice !== null
    ? `${formatCurrency(product.lowestPrice, product.lowestOffer?.currency)} 起`
    : "暂无有货报价";
  const seoProfile = getProductSeoProfile(product);
  const detailText = getOfficialPricePlanMapping(product)
    ? "有货最低价、渠道报价、官方参考价和最近更新时间"
    : "有货最低价、渠道报价和最近更新时间";
  const title = seoProfile?.metadataTitle || `${product.displayName} 价格对比`;
  const description = seoProfile
    ? `${seoProfile.metadataDescription} 当前参考：${priceText}。`
    : `查看 ${product.displayName} 的${detailText}。当前参考：${priceText}。`;

  return {
    title,
    description,
    robots: shouldNoIndexProduct(product)
      ? {
          index: false,
          follow: true,
        }
      : undefined,
    alternates: {
      canonical: `/products/${product.slug}`,
    },
    openGraph: {
      title,
      description: seoProfile?.metadataDescription || `对比 ${product.displayName} 的渠道报价、库存状态和更新时间。`,
      url: `https://priceai.cc/products/${product.slug}`,
    },
  };
}

const productTypeLabels: Record<string, string> = {
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

export default async function ProductDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await getPublicProductSummary(id);

  if (!product) notFound();

  const seoProfile = getProductSeoProfile(product);
  const initialOffers = await listPublicProductOffers(product.id, { limit: PUBLIC_OFFER_DEFAULT_LIMIT, offset: 0 });

  return (
    <>
    <JsonLd data={buildProductJsonLd(product, seoProfile)} />
    <main className="min-h-screen bg-[#f9f9f9] text-[#2d3435]">
      <ProductDetailHeader />

      <div className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6 md:py-8 lg:px-8 lg:py-12">
        <div className="mb-2 md:mb-5">
          <ProductReturnLink />
        </div>

        <section className="bg-transparent py-1 md:rounded-lg md:bg-[var(--color-surface)] md:p-5 md:shadow-[0_20px_60px_rgba(45,52,53,0.04)] lg:p-6">
          <div className="min-w-0 max-w-4xl">
            <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0">
              <Badge>{platformIcon(product.platform, product.id)} {product.platform}</Badge>
              <Badge>{productTypeLabel(product.productType)}</Badge>
              <Badge>{product.spec}</Badge>
            </div>
            <h1 className="mt-3 text-balance font-serif text-[1.45rem] font-bold leading-8 tracking-normal text-[#202829] sm:text-3xl md:mt-4 md:text-4xl">
              {product.displayName}
            </h1>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#5a6061] md:mt-3 md:line-clamp-none md:leading-7">{product.summary}</p>
          </div>
        </section>

        <Suspense fallback={<OfficialPriceReferenceSkeleton />}>
          <OfficialPriceReferenceSection product={product} />
        </Suspense>

        <div className="mt-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 md:mt-7">
          <div>
            <h2 className="font-serif text-xl font-semibold tracking-normal text-[#202829] sm:text-2xl md:text-3xl">渠道报价表</h2>
            <p className="mt-1 text-xs text-[#5a6061] md:mt-2 md:text-sm">
              {product.offerCount} 条报价 · {product.inStockCount} 有货 · 按有货优先和低价排序
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-[#5a6061] md:text-sm">
            <Clock3 size={15} />
            最近记录 {formatRelativeTime(product.latestSeenAt)}
          </div>
        </div>

        <ProductOffersPanel
          productId={product.id}
          productSlug={product.slug}
          productName={product.displayName}
          initialCount={product.offerCount}
          initialData={initialOffers}
        />

        <ProductRelatedCta product={product} />

        <p className="mt-8 text-xs leading-6 text-[#5a6061]">
          免责声明：本站仅聚合公开采集或审核通过的报价信息，不参与交易，实际价格、库存、质保和售后规则以原平台为准。
        </p>
      </div>
    </main>
    </>
  );
}

type OfficialPriceReference = {
  summary: OfficialPricePlanSummary;
  rows: OfficialPriceRow[];
  usRow: OfficialPriceRow | null;
};

const officialPlanByProductId: Record<string, { appSlug: "chatgpt" | "claude" | "gemini" | "grok"; planSlug: string }> = {
  "chatgpt-plus-recharge": { appSlug: "chatgpt", planSlug: "plus-monthly" },
  "chatgpt-pro-5x": { appSlug: "chatgpt", planSlug: "pro-5x" },
  "chatgpt-pro-20x": { appSlug: "chatgpt", planSlug: "pro-20x" },
  "claude-pro-month": { appSlug: "claude", planSlug: "pro-monthly" },
  "claude-max-5x": { appSlug: "claude", planSlug: "max-5x-monthly" },
  "claude-max-20x": { appSlug: "claude", planSlug: "max-20x-monthly" },
  "gemini-pro-recharge": { appSlug: "gemini", planSlug: "ai-pro" },
  "gemini-ultra": { appSlug: "gemini", planSlug: "ai-ultra" },
  "super-grok": { appSlug: "grok", planSlug: "supergrok" },
  "super-grok-heavy": { appSlug: "grok", planSlug: "supergrok-heavy" },
};

function buildOfficialPriceReference(
  product: ExplorerProductSummary,
  dataset: OfficialPricesDataset,
): OfficialPriceReference | null {
  const mapping = getOfficialPricePlanMapping(product);
  if (!mapping) return null;

  const id = officialPricePlanId(mapping.appSlug, mapping.planSlug);
  const summary = getOfficialPricePlanSummaryFromDataset(dataset, id);
  if (!summary?.lowestRow) return null;

  const rows = getOfficialPriceRowsByIdFromDataset(dataset, id);
  return {
    summary,
    rows,
    usRow: rows.find((row) => row.countryCode === "US") || null,
  };
}

function getOfficialPricePlanMapping(product: Pick<ExplorerProductSummary, "id" | "slug">) {
  return officialPlanByProductId[product.id] || officialPlanByProductId[product.slug] || null;
}

const platformBreadcrumbUrls: Record<string, string> = {
  ChatGPT: "https://priceai.cc/platforms/chatgpt",
  Claude: "https://priceai.cc/platforms/claude",
  Gemini: "https://priceai.cc/platforms/gemini",
};

async function OfficialPriceReferenceSection({ product }: { product: ExplorerProductSummary }) {
  const mapping = getOfficialPricePlanMapping(product);
  if (!mapping) return null;

  const officialPricesDataset = await getOfficialPricesDataset();
  const officialReference = buildOfficialPriceReference(product, officialPricesDataset);
  if (!officialReference) return null;

  return <OfficialPriceReferenceStrip reference={officialReference} product={product} />;
}

function OfficialPriceReferenceStrip({
  reference,
  product,
}: {
  reference: OfficialPriceReference;
  product: ExplorerProductSummary;
}) {
  const { summary, rows, usRow } = reference;
  const lowest = summary.lowestRow;
  if (!lowest) return null;

  return (
    <section className="mt-3 rounded-lg bg-white px-3 py-2.5 ring-1 ring-[#adb3b4]/15 md:mt-4 md:px-4 md:py-3 md:shadow-[0_14px_42px_rgba(45,52,53,0.035)]">
      <div className="flex items-center justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold text-[#47657a]">官方价格参考</p>
          <p className="mt-1 truncate text-xs text-[#5a6061]">
            渠道最低 <span className="font-semibold text-[#202829]">{formatCurrency(product.lowestPrice, product.lowestOffer?.currency)}</span>
            <span className="mx-1.5 text-[#adb3b4]">·</span>
            官方最低 <span className="font-semibold text-[#202829]">{formatCurrency(lowest.cnyPrice, "CNY")}</span>
          </p>
        </div>
        <Link
          href={`/official-prices/${summary.id}`}
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-[#e4e9ea] px-3 text-xs font-semibold text-[#2d3435]"
        >
          地区价
        </Link>
      </div>
      <div className="hidden flex-col gap-3 md:flex lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[#5a6061]">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eef3f8] px-3 py-1 text-xs font-semibold text-[#47657a]">
            <BrandIcon platform={summary.platform} className="h-[15px] w-[15px]" />
            官方参考
          </span>
          <ReferenceText label="第三方有货最低" value={formatCurrency(product.lowestPrice, product.lowestOffer?.currency)} />
          <ReferenceText label="官方最低" value={formatCurrency(lowest.cnyPrice, "CNY")} detail={`${lowest.countryLabel} ${lowest.priceText}`} />
          <ReferenceText
            label="美国公开价"
            value={usRow ? formatCurrency(usRow.cnyPrice, "CNY") : "暂无"}
            detail={usRow ? `${usRow.priceText} · ${usRow.currencyCode}` : undefined}
          />
          <span className="text-xs text-[#adb3b4]">{rows.length} 个地区 · 汇率 {lowest.fxDate}</span>
        </div>
        <Link
          href={`/official-prices/${summary.id}`}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#2d3435] px-4 text-sm font-semibold text-[#f8f8f8] transition hover:bg-[#202829]"
        >
          查看地区价
          <ExternalLink size={15} />
        </Link>
      </div>
    </section>
  );
}

function OfficialPriceReferenceSkeleton() {
  return (
    <section className="mt-3 rounded-lg bg-white px-3 py-2.5 ring-1 ring-[#adb3b4]/15 md:mt-4 md:px-4 md:py-3 md:shadow-[0_14px_42px_rgba(45,52,53,0.035)]">
      <div className="flex items-center justify-between gap-3 md:hidden">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-3 w-24 rounded-full" />
          <Skeleton className="mt-2 h-4 w-full rounded-full" />
        </div>
        <Skeleton className="h-9 w-16 rounded-full" />
      </div>
      <div className="hidden flex-col gap-3 md:flex lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <Skeleton className="h-7 w-24 rounded-full" />
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-5 w-36 rounded-full" />
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-4 w-28 rounded-full" />
        </div>
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>
    </section>
  );
}

function Skeleton({ className }: { className: string }) {
  return <div className={`bg-[#e4e9ea] ${className}`} />;
}

function ReferenceText({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className="text-xs text-[#5a6061]">{label}</span>
      <span className="font-semibold text-[#202829]">{value}</span>
      {detail ? <span className="hidden max-w-[180px] truncate text-xs text-[#adb3b4] sm:inline">{detail}</span> : null}
    </span>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-2.5 py-1 text-[0.7rem] font-semibold text-[#5a6061] ring-1 ring-[#adb3b4]/15 md:px-3 md:py-1.5 md:text-xs">
      {children}
    </span>
  );
}

function platformIcon(platform: string, productId?: string) {
  const className = "h-[15px] w-[15px]";

  if (productId) return <BrandIcon platform={platform} productId={productId} className={className} />;
  if (platform !== "其他") return <BrandIcon platform={platform} className={className} />;
  return <Layers3 className={`${className} text-[#5a6061]`} />;
}

function productTypeLabel(productType: string): string {
  return productTypeLabels[productType] || productType;
}

type RelatedCta = {
  title: string;
  description: string;
  links: Array<{
    label: string;
    href: string;
    tone?: "primary" | "secondary";
  }>;
};

function ProductRelatedCta({ product }: { product: ExplorerProductSummary }) {
  const cta = getRelatedCta(product);
  if (!cta) return null;

  return (
    <section className="mb-5 mt-5 rounded-lg bg-white px-4 py-3 ring-1 ring-[#adb3b4]/15 md:mt-6 md:shadow-[0_14px_42px_rgba(45,52,53,0.035)]">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold text-[#47657a]">买前指南</p>
          <h2 className="mt-1 text-base font-semibold tracking-normal text-[#202829]">{cta.title}</h2>
          <p className="mt-1 hidden text-sm leading-6 text-[#5a6061] md:block">{cta.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {cta.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold transition ${
                link.tone === "primary"
                  ? "bg-[#2d3435] text-[#f8f8f8] hover:bg-[#202829]"
                  : "bg-[#dde4e5] text-[#2d3435] hover:bg-[#d3dcdd]"
              }`}
            >
              {link.label}
              <ArrowRight size={15} />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function getRelatedCta(product: ExplorerProductSummary): RelatedCta | null {
  if (product.platform === "ChatGPT") {
    return {
      title: "想先弄清 ChatGPT 各种获取方式？",
      description: "可以先看平台价格页和新手指南，再回到这里核验具体渠道报价。",
      links: [
        { label: "平台页", href: "/platforms/chatgpt" },
        { label: "指南", href: "/guides/chatgpt-subscription-options", tone: "primary" },
      ],
    };
  }

  if (product.platform === "Gemini") {
    return {
      title: "想先弄清 Gemini 和 Google AI 的价格路径？",
      description: "可以先看 Gemini 平台页、Google Play 指南和地区价风险，再核验具体渠道报价。",
      links: [
        { label: "Gemini 平台页", href: "/platforms/gemini" },
        { label: "Google Play 指南", href: "/guides/google-play-ai-subscription" },
        { label: "地区价风险", href: "/guides/ai-subscription-region-price-risks", tone: "primary" },
      ],
    };
  }

  if (product.platform === "Claude") {
    return {
      title: "想先分清 Claude Pro、Max 和账号类商品？",
      description: "可以先看 Claude 平台页和官方参考价，再回到这里比较渠道报价和库存状态。",
      links: [
        { label: "Claude 平台页", href: "/platforms/claude" },
        { label: "官方地区价", href: "/official-prices" },
        { label: "渠道判断", href: "/guides/are-ai-subscription-card-shops-reliable", tone: "primary" },
      ],
    };
  }

  return null;
}

function buildProductJsonLd(
  product: ExplorerProductSummary,
  seoProfile: ProductSeoProfile | null,
) {
  const productUrl = `https://priceai.cc/products/${product.slug}`;
  const priceCurrency = product.lowestOffer?.currency || "CNY";
  const lowestOffer = product.lowestPrice !== null && product.lowestOffer
    ? {
        "@type": "AggregateOffer",
        lowPrice: product.lowestPrice,
        highPrice: product.lowestPrice,
        priceCurrency,
        offerCount: Math.max(product.inStockCount, 1),
        availability: "https://schema.org/InStock",
        url: productUrl,
      }
    : {
        "@type": "AggregateOffer",
        offerCount: 0,
        availability: "https://schema.org/OutOfStock",
        url: productUrl,
      };

  const productSchema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.displayName,
    description: seoProfile?.metadataDescription || product.summary,
    category: `${product.platform} / ${product.productType}`,
    brand: {
      "@type": "Brand",
      name: product.platform,
    },
    url: productUrl,
    offers: lowestOffer,
  };

  const schemas: Record<string, unknown>[] = [
    productSchema,
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "PriceAI",
          item: "https://priceai.cc",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: product.platform,
          item: platformBreadcrumbUrls[product.platform] || "https://priceai.cc",
        },
        {
          "@type": "ListItem",
          position: 3,
          name: product.displayName,
          item: productUrl,
        },
      ],
    },
  ];

  if (seoProfile?.faq.length) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: seoProfile.faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.answer,
        },
      })),
    });
  }

  return schemas;
}
