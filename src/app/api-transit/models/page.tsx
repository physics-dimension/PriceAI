import type { Metadata } from "next";
import { getTransitStations, readTransitModelIndexSnapshot } from "@/lib/api-transit-db";
import { buildTransitModelIndex, compactTransitStationsForList, formatRate, getTransitModelFamilyOptions } from "@/lib/api-transit";
import TransitModelExplorer from "@/components/TransitModelExplorer";
import { JsonLd } from "@/components/JsonLd";
import { ApiTransitPageShell } from "@/components/ApiTransitPageShell";
import { getSponsorSettingsSummary } from "@/lib/sponsor-settings";

export const metadata: Metadata = {
  title: "中转 API 模型对比",
  description: "按 ChatGPT、Claude、Gemini、Grok、GLM、DeepSeek、Kimi、千问、图片生成、视频生成等标准模型对比各 API 中转站的充值系数、模型倍率、综合倍率和近 7 日稳定性。",
  alternates: {
    canonical: "/api-transit/models",
  },
  openGraph: {
    title: "PriceAI 中转 API 模型对比",
    description: "按主流标准模型对比中转站价格与稳定性。",
    url: "https://priceai.cc/api-transit/models",
  },
};

export const revalidate = 300;

export default async function ApiTransitModelsPage() {
  const { modelIndex, sponsorSettings } = await loadTransitModelsPageData();
  const familyOptions = getTransitModelFamilyOptions();
  const modelSummaries = modelIndex.summaries;
  const bestRate = modelSummaries.reduce<number | null>((best, summary) => {
    const rate = summary.bestCombinedRate;
    if (rate === null) return best;
    return best === null || rate < best ? rate : best;
  }, null);
  const sampleCount = modelSummaries.reduce((total, summary) => total + summary.sampleCount, 0);

  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: "PriceAI 中转 API 模型对比",
          url: "https://priceai.cc/api-transit/models",
          inLanguage: "zh-CN",
          description: "按主流标准模型对比 API 中转站价格与稳定性。",
        }}
      />

      <ApiTransitPageShell
        familyOptions={familyOptions}
        title="中转 API 模型对比"
        meta={
          <>
            <span>标准模型 {modelSummaries.length}</span>
            <span className="h-1 w-1 rounded-full bg-[#adb3b4]" />
            <span>样本 {sampleCount}</span>
            <span className="hidden h-1 w-1 rounded-full bg-[#adb3b4] md:inline-block" />
            <span className="hidden md:inline">最低综合倍率 {formatRate(bestRate)}</span>
          </>
        }
        description="按标准模型横向对比各中转站的充值系数、模型倍率、综合倍率和近 7 日稳定性。站点榜仍是主入口，模型页用于快速查某个模型在哪些站点更便宜。"
        sponsorSettings={sponsorSettings}
      >
        <TransitModelExplorer modelIndex={modelIndex} />
      </ApiTransitPageShell>
    </>
  );
}

async function loadTransitModelsPageData() {
  const startedAt = performance.now();
  let indexSnapshotMs = 0;
  let stationsMs = 0;
  let indexBuildMs = 0;
  let sponsorMs = 0;

  const sponsorPromise = measureAsync(
    () => getSponsorSettingsSummary().catch(() => null),
    (elapsed) => { sponsorMs = elapsed; },
  );
  const snapshot = await measureAsync(
    readTransitModelIndexSnapshot,
    (elapsed) => { indexSnapshotMs = elapsed; },
  );

  let source: "snapshot" | "stale_snapshot" | "fallback" = snapshot?.fresh
    ? "snapshot"
    : snapshot
      ? "stale_snapshot"
      : "fallback";
  let modelIndex = snapshot?.index ?? null;
  if (!modelIndex) {
    source = "fallback";
    const stations = await measureAsync(
      getTransitStations,
      (elapsed) => { stationsMs = elapsed; },
    );
    const indexBuildStartedAt = performance.now();
    modelIndex = buildTransitModelIndex(compactTransitStationsForList(stations));
    indexBuildMs = performance.now() - indexBuildStartedAt;
  }

  const sponsorSettings = await sponsorPromise;

  if (process.env.NEXT_PHASE !== "phase-production-build") {
    console.info("api_transit_models_render", {
      source,
      indexSnapshotMs: Math.round(indexSnapshotMs),
      stationsMs: Math.round(stationsMs),
      indexBuildMs: Math.round(indexBuildMs),
      sponsorMs: Math.round(sponsorMs),
      dataReadyMs: Math.round(performance.now() - startedAt),
      stationCount: modelIndex.stations.length,
      modelCount: modelIndex.summaries.length,
      priceReferenceCount: modelIndex.priceEntries.length,
      snapshotGeneratedAt: modelIndex.generatedAt,
    });
  }

  return { modelIndex, sponsorSettings };
}

async function measureAsync<T>(task: () => Promise<T>, record: (elapsedMs: number) => void): Promise<T> {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    record(performance.now() - startedAt);
  }
}
