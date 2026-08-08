#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const failures = [];

const routeFilesWithPriceCache = [
  "src/app/api/explorer/route.ts",
  "src/app/api/offers/route.ts",
  "src/app/api/products/[id]/offers/route.ts",
  "src/app/api/merchants/route.ts",
];

const publicDataModules = [
  {
    file: "src/lib/data.ts",
    timeoutPattern: /PUBLIC_SUPABASE_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(publicSupabaseReadSignal\(\)\)/,
    label: "public offer reads",
  },
  {
    file: "src/lib/api-transit-db.ts",
    timeoutPattern: /PUBLIC_TRANSIT_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(signal\)/,
    label: "API transit public reads",
  },
  {
    file: "src/lib/api-models-db.ts",
    timeoutPattern: /PUBLIC_API_MODEL_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(signal\)/,
    label: "API model public reads",
  },
  {
    file: "src/lib/official-prices-db.ts",
    timeoutPattern: /PUBLIC_OFFICIAL_PRICE_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(signal\)/,
    label: "official price public reads",
  },
];

for (const dataModule of publicDataModules) {
  const text = read(dataModule.file);
  assert(dataModule.timeoutPattern.test(text), `${dataModule.file}: ${dataModule.label} must keep a short 2.5s runtime timeout.`);
  assert(dataModule.abortPattern.test(text), `${dataModule.file}: ${dataModule.label} must pass an AbortSignal to Supabase reads.`);
}

for (const routeFile of routeFilesWithPriceCache) {
  const text = read(routeFile);
  assert(/priceDataCacheHeaders/.test(text), `${routeFile}: public price API must use shared CDN cache headers.`);
  assert(!/no-store/i.test(text), `${routeFile}: public price API must not use no-store caching.`);
}

const dataText = read("src/lib/data.ts");
const publicPriceEmergencyText = read("src/lib/public-price-emergency.ts");
assert(/PUBLIC_FALLBACK_MAX_ROWS\s*=\s*5000/.test(dataText), "src/lib/data.ts: public raw_offers fallback must keep a hard row cap.");
assert(/for\s*\(\s*let\s+from\s*=\s*0;\s*from\s*<\s*PUBLIC_FALLBACK_MAX_ROWS/.test(dataText), "src/lib/data.ts: public raw_offers fallback must be bounded by PUBLIC_FALLBACK_MAX_ROWS.");
assert(!/PUBLIC_OFFER_LIMIT\s*=\s*1200/.test(dataText), "src/lib/data.ts: public offer APIs must not allow 1200-row public pages.");
assert(/PUBLIC_DATA_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(dataText), "src/lib/data.ts: public data in-memory TTL must use the shared price cache policy.");
assert(/EXPLORER_DATA_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(dataText), "src/lib/data.ts: explorer data TTL must use the shared price cache policy.");
assert(/priceDataCacheTtlMsForProduct\(filterProductId\)/.test(dataText), "src/lib/data.ts: product offer TTL must use the shared per-product price cache policy.");
assert(/function\s+toExplorerOfferSearchText/.test(dataText), "src/lib/data.ts: explorer search text must use a JSON-safe truncation helper.");
assert(/function\s+truncateJsonSafeString/.test(dataText), "src/lib/data.ts: public snapshot text truncation must preserve complete Unicode characters.");
assert(!/offerSearchText:\s*String\(row\.offer_search_text\s*\|\|\s*["']["']\)\.slice/.test(dataText), "src/lib/data.ts: explorer row search text must not use raw slice truncation.");
assert(/filterFacetsPromise\.catch/.test(dataText), "src/lib/data.ts: auxiliary product offer facets must not be allowed to fail the primary offer page.");
assert(/readPublicApiSnapshot<ExplorerData>\(\s*["']explorer["']/.test(dataText), "src/lib/data.ts: explorer API must try the shared public API snapshot before expensive source reads.");
assert(/readPublicApiSnapshot<PublicOffersResult>\(\s*["']offers["']/.test(dataText), "src/lib/data.ts: default public offer list must try the shared public API snapshot before expensive source reads.");
assert(/readPublicApiSnapshot<PublicProductOffersResult>\(\s*[\r\n\s]*["']product_offers["']/.test(dataText), "src/lib/data.ts: default product offer pages must try the shared public API snapshot before expensive source reads.");
assert(/readPublicApiSnapshot<PublicMerchantsResult>\(\s*["']merchants["']/.test(dataText), "src/lib/data.ts: default public merchant list must try the shared public API snapshot before expensive source reads.");
assert(/if \(!platform && !stock && !collector && !signal\) return PUBLIC_MERCHANTS_SNAPSHOT_KEY/.test(dataText), "src/lib/data.ts: the unfiltered merchant route must reuse the warmed default merchant snapshot key.");
assert(/needsDefaultCatalogPagination[\s\S]{0,220}hydrate[dD]Value\.limit == null[\s\S]{0,220}paginatePublicMerchants\(hydratedValue, normalizedFilters\)/.test(dataText), "src/lib/data.ts: full default merchant catalog snapshots must be paginated once without re-paginating already paginated snapshots.");
assert(/refreshPublicApiSnapshots/.test(dataText), "src/lib/data.ts: public API snapshot refresh must stay available for writes and manual warmup.");
assert(/markPublicApiSnapshotsDirty/.test(dataText), "src/lib/data.ts: public API snapshot writes must support a cheap dirty marker.");
assert(/refreshPublicApiSnapshotsIfDue/.test(dataText), "src/lib/data.ts: public API snapshot refresh must be coalesced and rate-limited.");
assert(
  !/refreshPublicApiSnapshotsIfDue[\s\S]{0,1200}PUBLIC_PRICE_CACHE_ONLY_MODE/.test(dataText),
  "src/lib/data.ts: cache-only public reads must not disable the protected background snapshot refresh path.",
);
assert(/inspectPublicSnapshotRefreshFailures/.test(dataText), "src/lib/data.ts: snapshot refresh must inspect partial global and product failures.");
assert(/snapshot refresh incomplete/.test(dataText), "src/lib/data.ts: partial snapshot refresh failures must propagate to the protected refresh endpoint.");
assert(/PUBLIC_API_SNAPSHOT_INCREMENTAL_REFRESH_MIN_INTERVAL_MS\s*=\s*3\s*\*\s*60\s*\*\s*1000/.test(dataText), "src/lib/data.ts: public API snapshot incremental refresh must stay on the 3 minute cadence.");
assert(/PUBLIC_API_SNAPSHOT_GLOBAL_REFRESH_MIN_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(dataText), "src/lib/data.ts: explorer/offers snapshot refresh must stay coalesced to 5 minutes.");
assert(/PUBLIC_SUPABASE_REFRESH_READ_TIMEOUT_MS\s*=\s*15_000/.test(dataText), "src/lib/data.ts: protected snapshot refresh may use a longer 15 second Supabase read window.");
assert(/options\.background\s*\?\s*publicSupabaseRefreshReadSignal\(\)\s*:\s*publicSupabaseReadSignal\(\)/.test(dataText), "src/lib/data.ts: long Supabase reads must be limited to protected background refreshes.");
assert(/refresh_public_offer_read_model/.test(dataText), "src/lib/data.ts: protected offers snapshot refresh must rebuild the public offer read model first.");
assert(/refreshPublicApiSnapshotsForScope[\s\S]{0,500}refreshPublicOfferReadModel\(\)/.test(dataText), "src/lib/data.ts: product-scoped snapshot refreshes must also rebuild the global offer read model.");
assert(/list_public_offers_page_v2/.test(dataText), "src/lib/data.ts: public offer reads must prefer the precomputed v2 read-model RPC.");
assert(/isMissingPublicOfferReadModelRpc/.test(dataText), "src/lib/data.ts: the legacy offers RPC may only bridge a missing read-model migration or schema cache entry.");
assert(/refresh produced zero rows; preserving the previous generation/.test(readFileSync(path.join(repoRoot, "supabase", "schema.sql"), "utf8")), "supabase/schema.sql: an empty read-model rebuild must preserve the last known good generation.");
assert(/PUBLIC_PRICE_CACHE_ONLY_MODE\s*=\s*false/.test(publicPriceEmergencyText), "src/lib/public-price-emergency.ts: incident cache-only mode must be disabled after the public offer read model is verified.");
assert(/namespace:\s*["']offers-v4-read-model["']/.test(read("src/app/api/offers/route.ts")), "offers route must use the post-incident read-model cache namespace.");
assert(/namespace:\s*["']explorer-v4-read-model["']/.test(read("src/app/api/explorer/route.ts")), "explorer route must use the post-incident read-model cache namespace.");
assert(/namespace:\s*["']product-offers-v4-read-model["']/.test(read("src/app/api/products/[id]/offers/route.ts")), "product offers route must use the post-incident read-model cache namespace.");
assert(/PUBLIC_API_SNAPSHOT_FULL_REFRESH_MAX_INTERVAL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/.test(dataText), "src/lib/data.ts: full public snapshot refresh must remain a low-frequency 60 minute fallback.");
assert(/PUBLIC_API_SNAPSHOT_MAX_STALE_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS\s*\*\s*2/.test(dataText), "src/lib/data.ts: public API snapshots must stop serving old default snapshots after two public cache TTLs.");
assert(/PUBLIC_API_SNAPSHOT_PRODUCT_REFRESH_BATCH_SIZE\s*=\s*4/.test(dataText), "src/lib/data.ts: product snapshot refreshes must stay batched to protect Worker CPU.");
assert(/remainingProductIds/.test(dataText), "src/lib/data.ts: batched product snapshot refreshes must keep unprocessed products queued.");
assert(/isPublicApiSnapshotFresh/.test(dataText), "src/lib/data.ts: default public API snapshot reads must validate snapshot freshness before returning cached data.");
assert(/affectedProductIds/.test(dataText), "src/lib/data.ts: dirty snapshot state must keep affected product IDs for incremental refresh.");
assert(/resolvePublicSnapshotProductIds/.test(dataText), "src/lib/data.ts: dirty source/offer scopes must resolve to product snapshot refreshes.");
assert(!/PUBLIC_PRODUCT_OFFERS_SNAPSHOT_PRODUCT_LIMIT/.test(dataText), "src/lib/data.ts: product offer snapshots must warm all products with offers, not only a small top-N subset.");
assert(/async function buildExplorerDataFromSource[\s\S]{0,300}if \(isSupabaseConfigured\(\)\) return emptyDegradedExplorerData\(\)/.test(dataText), "src/lib/data.ts: explorer RPC failures must not fall through to raw Supabase reads.");
assert(/async function loadPublicProductOffers[\s\S]{0,3500}if \(isSupabaseConfigured\(\)\) \{[\s\S]{0,500}degraded: true/.test(dataText), "src/lib/data.ts: product offer RPC failures must not fall through to raw Supabase reads.");
assert(/async function buildPublicMerchants[\s\S]{0,1800}if \(isSupabaseConfigured\(\)\) \{[\s\S]{0,250}emptyCacheOnlyPublicMerchantsResult/.test(dataText), "src/lib/data.ts: merchant RPC failures must not fall through to raw Supabase reads.");
assert(/async function loadPublicOffers[\s\S]{0,500}if \(isSupabaseConfigured\(\)\) \{[\s\S]{0,250}degraded: true/.test(dataText), "src/lib/data.ts: public offer RPC failures must not fall through to raw Supabase reads.");

const publicApiSnapshotsText = read("src/lib/public-api-snapshots.ts");
assert(/public_api_snapshots/.test(publicApiSnapshotsText), "src/lib/public-api-snapshots.ts: public API snapshots must use the shared snapshot table.");
assert(/SNAPSHOT_READ_TIMEOUT_MS\s*=\s*PUBLIC_PRICE_CACHE_ONLY_MODE\s*\?\s*10_000\s*:\s*2_500/.test(publicApiSnapshotsText), "src/lib/public-api-snapshots.ts: normal snapshot reads must keep a short 2.5s timeout while explicit incident mode may use 10s.");
assert(/PUBLIC_API_SNAPSHOT_SCHEMA_VERSION\s*=\s*1/.test(publicApiSnapshotsText), "src/lib/public-api-snapshots.ts: snapshot schema version must be explicit.");
assert(/refresh_state/.test(publicApiSnapshotsText), "src/lib/public-api-snapshots.ts: snapshot dirty state must use the shared snapshot table.");

const publicApiSnapshotsRouteText = read("src/app/api/admin/public-api-snapshots/route.ts");
assert(/refreshPublicApiSnapshotsIfDue/.test(publicApiSnapshotsRouteText), "src/app/api/admin/public-api-snapshots/route.ts: snapshot refresh endpoint must coalesce dirty writes instead of always refreshing.");
assert(/publishPriceRadarSnapshot/.test(publicApiSnapshotsRouteText), "src/app/api/admin/public-api-snapshots/route.ts: protected refresh must publish the anonymous price radar after snapshots are healthy.");

const priceRadarContractText = read("src/lib/price-radar-contract.ts");
const priceRadarStorageText = read("src/lib/price-radar-storage.ts");
const wranglerText = read("wrangler.jsonc");
assert(/PRICE_RADAR_TOP_OFFER_LIMIT\s*=\s*5/.test(priceRadarContractText), "src/lib/price-radar-contract.ts: anonymous rankings must keep a fixed Top 5 payload.");
assert(/PRICE_RADAR_MAX_PRESETS_PER_PRODUCT\s*=\s*5/.test(priceRadarContractText), "src/lib/price-radar-contract.ts: anonymous preset fanout must stay bounded.");
assert(!/offerSearchText|riskFeedback|failureReason/.test(priceRadarContractText), "src/lib/price-radar-contract.ts: anonymous price radar must not expose internal search or risk fields.");
assert(/readPublicApiSnapshotsByKind/.test(priceRadarStorageText), "src/lib/price-radar-storage.ts: price radar publishing must read stored snapshots instead of rebuilding public data.");
assert(!/listPublicOffers|listPublicProductOffers|getExplorerData/.test(priceRadarStorageText), "src/lib/price-radar-storage.ts: price radar publishing must not trigger public query or aggregation functions.");
assert(!/priceRadarPresetTagsForProduct/.test(dataText), "src/lib/data.ts: price radar presets must not multiply snapshot refresh RPCs.");
assert(/const objects: PriceRadarObject\[\] = \[\{/.test(priceRadarContractText), "src/lib/price-radar-contract.ts: each publication must remain a single immutable data object.");
assert(/bucket\.head\(PRICE_RADAR_LATEST_KEY\)/.test(priceRadarStorageText), "src/lib/price-radar-storage.ts: unchanged snapshots must skip R2 writes.");
assert(/PRICE_RADAR_LATEST_KEY[\s\S]{0,2600}putJson\(bucket, PRICE_RADAR_LATEST_KEY/.test(priceRadarStorageText), "src/lib/price-radar-storage.ts: latest.json must be written only after immutable snapshot objects.");
assert(/"binding"\s*:\s*"PRICE_RADAR_BUCKET"/.test(wranglerText), "wrangler.jsonc: production Worker must bind the dedicated price radar R2 bucket for publishing.");

const channelsPageText = read("src/app/channels/page.tsx");
assert(!/listPublicOffers/.test(channelsPageText), "src/app/channels/page.tsx: the default product view must not prefetch the expensive all-offers list.");

const middlewareText = read("src/middleware.ts");
assert(!/staleDeploymentCssResponse/.test(middlewareText), "src/middleware.ts: deployment-skewed CSS must fail visibly so the client can recover instead of accepting an empty stylesheet.");
assert(/www\.priceai\.cc/.test(middlewareText) && /\(\?!_next\/static/.test(middlewareText), "src/middleware.ts: canonical www redirects must cover public pages while excluding static assets.");

const chunkRecoveryText = read("src/lib/chunk-load-recovery.ts");
assert(/static\\\/\(\?:chunks\|css\)/.test(chunkRecoveryText), "src/lib/chunk-load-recovery.ts: both stale JavaScript and CSS deployment assets must trigger guarded recovery.");

const rootLayoutText = read("src/app/layout.tsx");
assert(/priceai-resource-recovery/.test(rootLayoutText) && /strategy="beforeInteractive"/.test(rootLayoutText), "src/app/layout.tsx: initial deployment asset failures need recovery before hydration starts.");

const crawlLogRouteText = read("src/app/api/admin/crawl-log/route.ts");
assert(/markPublicApiSnapshotsDirty/.test(crawlLogRouteText), "src/app/api/admin/crawl-log/route.ts: crawl-log writes must only mark public snapshots dirty.");
assert(!/refreshPublicApiSnapshots/.test(crawlLogRouteText), "src/app/api/admin/crawl-log/route.ts: crawl-log writes must not synchronously refresh all public API snapshots.");
assert(/payload\.details\?\.hotVerification === true[\s\S]{0,100}\? \{ changedOfferCount: 0 \}/.test(crawlLogRouteText), "src/app/api/admin/crawl-log/route.ts: hot verification writes must not refresh source-level full-store collection timestamps.");

const adminText = read("src/lib/admin.ts");
assert(/upsertRawOfferConfirmations/.test(adminText), "src/lib/admin.ts: unchanged offers must write lightweight confirmation rows instead of refreshing raw_offers.");
assert(/raw_offer_confirmations/.test(adminText), "src/lib/admin.ts: offer confirmation writes must use raw_offer_confirmations.");
assert(/const changedRows = \[\];[\s\S]{0,700}isRawOfferRowUnchanged\(row, existingRow\)/.test(adminText), "src/lib/admin.ts: automated raw offer writes must compare content before writing the main table.");
assert(/for \(const rowChunk of chunks\(changedRows, RAW_OFFER_WRITE_CHUNK_SIZE\)\)/.test(adminText), "src/lib/admin.ts: changed raw offers must use bounded batch upserts.");
assert(/preserveExistingUnavailableStateForImplicitConfirmation/.test(adminText), "src/lib/admin.ts: implicit collector confirmations must not revive explicitly unavailable offers.");
assert(!/UNCHANGED_OFFER_REFRESH_INTERVAL_MS/.test(adminText), "src/lib/admin.ts: unchanged confirmation timing must not be implemented by raw_offers refresh intervals.");
assert(!/function\s+shouldRefreshUnchangedOffer/.test(adminText), "src/lib/admin.ts: unchanged offer confirmation must not depend on old raw_offers refresh logic.");
assert(/function expireStaleOffersAfterRepeatedFailures/.test(adminText), "src/lib/admin.ts: repeated collector failures must only expire stale offers after a threshold.");
assert(/MAX_STALE_OFFERS_TO_EXPIRE_PER_FAILURE\s*=\s*50/.test(adminText), "src/lib/admin.ts: repeated collector failure expiry must stay capped per failure.");
assert(!/recordOfferCollectionFailure/.test(adminText), "src/lib/admin.ts: single collector failures must not bulk-write all raw_offers for a source.");
assert(!/async function clearOfferCollectionFailure\s*\(/.test(adminText), "src/lib/admin.ts: successful collections must not bulk-clear all source offer failure markers.");
assert(/clearOfferCollectionFailureForSeenOffers/.test(adminText), "src/lib/admin.ts: successful collections should clear failure markers only for offers seen in the current result.");

const migrationText = listMigrationFiles().map((file) => read(file)).join("\n");
assert(/create index if not exists raw_offers_public_dedupe_key_idx/.test(migrationText), "supabase/migrations: raw_offers duplicate-hide trigger must have a public dedupe-key index.");
assert(/priceai_public_offer_dedupe_key\(\s*canonical_product_id,\s*url,\s*source_title,\s*price\s*\)/.test(migrationText), "supabase/migrations: raw_offers public dedupe index must match the trigger key expression.");
assert(/raw_offers_public_dedupe_key_idx[\s\S]{0,300}where hidden = false/.test(migrationText), "supabase/migrations: raw_offers public dedupe index must stay scoped to visible offers.");
assert(/prefer_base_unavailable/.test(migrationText), "supabase/migrations: raw_offer_public_state must guard against stale confirmation rows.");
assert(/raw_offers\.effective_status = 'unavailable'/.test(migrationText), "supabase/migrations: unavailable raw offer rows must be able to dominate stale confirmation rows.");
assert(/api_transit_availability_samples_checked_time_idx[\s\S]{0,220}checked_at desc,\s*station_id/.test(migrationText), "supabase/migrations: recent API transit samples must have a global checked_at-first index for ordered multi-station reads.");

const cloudflareSmokeText = read("scripts/smoke-cloudflare.mjs");
assert(/\/api\/offers\?limit=30/.test(cloudflareSmokeText), "scripts/smoke-cloudflare.mjs: production smoke must verify the 30-row cached offers path.");
assert(/\/api\/products\/chatgpt-plus\/offers\?limit=30/.test(cloudflareSmokeText), "scripts/smoke-cloudflare.mjs: production smoke must verify the 30-row cached product offers path.");
assert(!/\/api\/offers\?limit=80/.test(cloudflareSmokeText), "scripts/smoke-cloudflare.mjs: production smoke must not use the heavy 80-row offers path as the default health signal.");
assert(!/\/api\/products\/chatgpt-plus\/offers\?limit=80/.test(cloudflareSmokeText), "scripts/smoke-cloudflare.mjs: production smoke must not use the heavy 80-row product offers path as the default health signal.");

const cloudflareDeployWorkflowText = read(".github/workflows/deploy-cloudflare-worker.yml");
assert(/Promote staged candidate[\s\S]{0,800}Revalidate deployment page cache[\s\S]{0,400}Smoke production deployment/.test(cloudflareDeployWorkflowText), ".github/workflows/deploy-cloudflare-worker.yml: production promotion must revalidate deployment-skewed HTML before smoke.");

const deploymentRevalidationRouteText = read("src/app/api/cron/deployment-revalidate/route.ts");
assert(/authorizeCronRequest/.test(deploymentRevalidationRouteText), "src/app/api/cron/deployment-revalidate/route.ts: deployment-wide cache invalidation must require cron authorization.");
assert(/revalidatePath\(["']\/["'],\s*["']layout["']\)/.test(deploymentRevalidationRouteText), "src/app/api/cron/deployment-revalidate/route.ts: deployment releases must invalidate the root layout and all nested pages.");

const snapshotRefreshScriptText = read("scripts/refresh-public-api-snapshots.mjs");
assert(/PRICEAI_BASE_URL/.test(snapshotRefreshScriptText), "scripts/refresh-public-api-snapshots.mjs: server snapshot refresh must support an explicit production base URL.");
assert(/CRON_SECRET/.test(snapshotRefreshScriptText), "scripts/refresh-public-api-snapshots.mjs: server snapshot refresh must use the protected cron secret.");
assert(/PRICEAI_ALERT_WEBHOOK_URL/.test(snapshotRefreshScriptText), "scripts/refresh-public-api-snapshots.mjs: server snapshot refresh must alert on failures or dirty backlog.");

const collectPricesScriptText = read("scripts/collect-prices.mjs");
assert(!/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(collectPricesScriptText), "scripts/collect-prices.mjs: collector Supabase client must not fall back to the public anon key.");
assert(/function cronWriteHeaders/.test(collectPricesScriptText), "scripts/collect-prices.mjs: collector writeback must use shared cron auth headers.");
assert(!/["']x-admin-password["']\s*:/.test(collectPricesScriptText), "scripts/collect-prices.mjs: collector writeback must not post with the legacy admin password header.");
assert(/run\.details\?\.hotVerification === true\) continue/.test(collectPricesScriptText), "scripts/collect-prices.mjs: full-store scheduling must ignore hot verification crawl runs.");

const publicApiSnapshotsMigrationText = read("supabase/migrations/20260624083000_public_api_snapshots.sql");
assert(/create table if not exists public_api_snapshots/.test(publicApiSnapshotsMigrationText), "public API snapshots migration must create the snapshot table.");
assert(/primary key \(kind, cache_key\)/.test(publicApiSnapshotsMigrationText), "public API snapshots migration must key snapshots by kind and cache key.");
assert(/grant select, insert, update, delete on table public_api_snapshots to service_role/.test(publicApiSnapshotsMigrationText), "public API snapshots migration must grant service_role access only.");

const publicOfferReadModelMigrationText = read("supabase/migrations/20260721180000_public_offer_read_model.sql");
assert(/create table if not exists public_offer_read_model/.test(publicOfferReadModelMigrationText), "public offer read model migration must create a precomputed table.");
assert(/create or replace function refresh_public_offer_read_model\(\)/.test(publicOfferReadModelMigrationText), "public offer read model migration must provide a protected atomic rebuild RPC.");
assert(/create or replace function list_public_offers_page_v2/.test(publicOfferReadModelMigrationText), "public offer read model migration must provide the v2 pagination RPC.");
assert(!/delete from public_api_snapshots\s+where kind = 'offers'/i.test(publicOfferReadModelMigrationText), "public offer read model migration must preserve last-known-good offers snapshots.");

const latestFacetMigration = latestMigrationDefining("list_public_product_offer_filter_facets");
assert(Boolean(latestFacetMigration), "supabase/migrations: list_public_product_offer_filter_facets must be defined by a migration.");
if (latestFacetMigration) {
  const latestFacetMigrationText = read(latestFacetMigration);
  assert(/unnest\(raw_offers\.public_filter_tags\)/.test(latestFacetMigrationText), `${latestFacetMigration}: public filter facets must use stored raw_offers.public_filter_tags.`);
  assert(!/priceai_public_offer_filter_tags\(raw_offers\.source_title,\s*raw_offers\.tags\)[\s\S]{0,250}as tag_id/.test(latestFacetMigrationText), `${latestFacetMigration}: public filter facets must not derive tags during public reads.`);
}

const publicCachePolicyText = read("src/lib/public-cache-policy.ts");
assert(/PRICE_DATA_EDGE_SECONDS\s*=\s*300/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: price data edge TTL must stay at 300s unless the cost plan is updated.");
assert(/PRICE_DATA_STALE_SECONDS\s*=\s*1800/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: price data stale window must stay at 1800s unless the cost plan is updated.");
assert(/PRICE_DATA_DEGRADED_EDGE_SECONDS\s*=\s*60/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: degraded public price responses must use a short 60s edge TTL.");
assert(/PRICE_DATA_CACHE_TTL_MS\s*=\s*PRICE_DATA_EDGE_SECONDS\s*\*\s*1000/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: client/server TTL must derive from the shared edge TTL.");
assert(/HOT_PRODUCT_PRICE_DATA_EDGE_SECONDS\s*=\s*60/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: Plus and Team hot product edge TTL must stay at 60s.");
assert(/HOT_PRODUCT_PRICE_DATA_IDS\s*=\s*new Set\(\["chatgpt-plus",\s*"chatgpt-team-business"\]\)/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: hot product TTL scope must remain limited to Plus and Team.");

const priceExplorerText = read("src/components/PriceExplorer.tsx");
assert(/EXPLORER_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(priceExplorerText), "src/components/PriceExplorer.tsx: explorer client cache must use the shared price cache policy.");
assert(/OFFER_LIST_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(priceExplorerText), "src/components/PriceExplorer.tsx: offer list client cache must use the shared price cache policy.");

const productOffersPanelText = read("src/components/ProductOffersPanel.tsx");
assert(/priceDataCacheTtlMsForProduct\(productId\)/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: product offer client cache must use the shared per-product price cache policy.");
assert(/PRODUCT_OFFERS_REFRESH_TIMEOUT_MS\s*=\s*10_000/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: product offer refresh timeout must tolerate slow-tail product API responses.");
assert(/createTimeoutSignal\(PRODUCT_OFFERS_REFRESH_TIMEOUT_MS\)/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: product offers must use the product-specific refresh timeout.");
assert(!/IntersectionObserver/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: deep product offer pages must require an explicit load-more action.");
assert(/hasMoreProductOfferPage\(activeData\)/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: product offer pagination must honor the server end-of-list signal.");
assert(/mergeProductOfferPages\(current, nextPage\)/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: empty or duplicate product offer pages must stop pagination.");
assert(/pagingControllerRef\.current\?\.abort\(\)/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: changing filters must abort the previous pagination request.");
assert(/PRODUCT_OFFER_QUICK_STOCK_THRESHOLD/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: keep the fixed stock quick filter.");
assert(/PRODUCT_OFFER_QUICK_FRESHNESS_MINUTES/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: keep the fixed freshness quick filter.");
assert(!/PRODUCT_OFFER_STOCK_THRESHOLDS|PRODUCT_OFFER_FRESHNESS_MINUTES/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: operational quick filters must not expand back into full threshold matrices.");

const productOfferFiltersText = read("src/lib/product-offer-filters.ts");
assert(/PRODUCT_OFFER_QUICK_STOCK_THRESHOLD\s*=\s*50/.test(productOfferFiltersText), "src/lib/product-offer-filters.ts: stock quick preset must stay fixed at 50.");
assert(/PRODUCT_OFFER_QUICK_FRESHNESS_MINUTES\s*=\s*60/.test(productOfferFiltersText), "src/lib/product-offer-filters.ts: freshness quick preset must stay fixed at 60 minutes.");
assert(!/PRODUCT_OFFER_STOCK_THRESHOLDS|PRODUCT_OFFER_FRESHNESS_MINUTES/.test(productOfferFiltersText), "src/lib/product-offer-filters.ts: API parsers must not accept arbitrary operational threshold matrices.");
assert(/filterPublicProductOffersSnapshot/.test(dataText), "src/lib/data.ts: fixed operational quick filters must narrow the last-known-good snapshot before live RPC.");

const clientHooksText = read("src/lib/client-hooks.ts");
assert(/export function useMediaQuery/.test(clientHooksText), "src/lib/client-hooks.ts: shared client media query hook must stay centralized.");
assert(/export function useDebouncedValue/.test(clientHooksText), "src/lib/client-hooks.ts: shared debounced value hook must stay centralized.");
for (const componentFile of [
  "src/components/PriceExplorer.tsx",
  "src/components/ProductOffersPanel.tsx",
  "src/components/ApiModelsExplorer.tsx",
  "src/components/OfficialPricesExplorer.tsx",
  "src/components/TransitStationDetail.tsx",
]) {
  const text = read(componentFile);
  assert(!/function useMediaQuery/.test(text), `${componentFile}: useMediaQuery must be imported from src/lib/client-hooks.ts.`);
  assert(!/function useDebouncedValue/.test(text), `${componentFile}: useDebouncedValue must be imported from src/lib/client-hooks.ts.`);
}

for (const routeStateFile of [
  "src/app/channels/loading.tsx",
  "src/app/channels/error.tsx",
  "src/app/official-api/loading.tsx",
  "src/app/official-api/error.tsx",
  "src/app/official-prices/loading.tsx",
  "src/app/official-prices/error.tsx",
  "src/app/api-transit/models/loading.tsx",
  "src/app/api-transit/models/error.tsx",
]) {
  assert(existsSync(path.join(repoRoot, routeStateFile)), `${routeStateFile}: high-traffic public routes must keep route-level loading/error states.`);
}

const officialPriceCollectText = read("scripts/collect-official-prices.mjs");
assert(/DEFAULT_FETCH_CONCURRENCY\s*=\s*4/.test(officialPriceCollectText), "scripts/collect-official-prices.mjs: official price collection must keep a conservative default fetch concurrency.");
assert(/MAX_FETCH_CONCURRENCY\s*=\s*8/.test(officialPriceCollectText), "scripts/collect-official-prices.mjs: official price collection must cap fetch concurrency.");
assert(/mapWithConcurrency/.test(officialPriceCollectText), "scripts/collect-official-prices.mjs: official price collection must avoid fully serial app-region fetches.");
assert(/PRICEAI_OFFICIAL_PRICE_FETCH_CONCURRENCY/.test(officialPriceCollectText), "scripts/collect-official-prices.mjs: official price collection concurrency must be configurable by env.");

const productPageText = read("src/app/products/[id]/page.tsx");
assert(/listPublicProductOffers/.test(productPageText), "src/app/products/[id]/page.tsx: product pages must server-prefetch the first offer page.");
assert(/initialData=\{initialOffers\}/.test(productPageText), "src/app/products/[id]/page.tsx: product offer panel must receive server-prefetched initialData.");

const transitDetailPageText = read("src/app/api-transit/[slug]/page.tsx");
assert(/revalidate\s*=\s*300/.test(transitDetailPageText), "src/app/api-transit/[slug]/page.tsx: transit detail shell should use the shared 5 minute public cache window.");
assert(/dynamicParams\s*=\s*true/.test(transitDetailPageText), "src/app/api-transit/[slug]/page.tsx: newly published transit detail slugs must still render on demand.");
assert(/generateStaticParams/.test(transitDetailPageText), "src/app/api-transit/[slug]/page.tsx: known transit detail slugs should be pre-rendered into the stable cached shell.");
assert(!/dynamic\s*=\s*["']force-dynamic["']/.test(transitDetailPageText), "src/app/api-transit/[slug]/page.tsx: transit detail shell should not force every request through live database reads.");
assert(!/revalidate\s*=\s*0/.test(transitDetailPageText), "src/app/api-transit/[slug]/page.tsx: transit detail shell must not disable ISR caching.");
assert(/TransitStationLivePricingPanels/.test(transitDetailPageText), "src/app/api-transit/[slug]/page.tsx: volatile pricing and monitoring panels must refresh separately from the cached shell.");

const transitDetailApiText = read("src/app/api/api-transit-stations/[slug]/detail/route.ts");
assert(/TRANSIT_DETAIL_EDGE_SECONDS\s*=\s*600/.test(transitDetailApiText), "src/app/api/api-transit-stations/[slug]/detail/route.ts: volatile transit detail data should use a 10 minute edge cache.");
assert(/publicDataCacheHeaders/.test(transitDetailApiText), "src/app/api/api-transit-stations/[slug]/detail/route.ts: transit detail data API must set public CDN cache headers.");
assert(/noStoreCacheHeaders/.test(transitDetailApiText), "src/app/api/api-transit-stations/[slug]/detail/route.ts: not-found transit detail API responses must not be negatively cached.");

const transitLivePricingPanelsText = read("src/components/TransitStationLivePricingPanels.tsx");
assert(/setStation\(initialStation\)/.test(transitLivePricingPanelsText), "src/components/TransitStationLivePricingPanels.tsx: live pricing panels must start from the cached shell's last known good data.");
assert(/TransitStationPricingSkeleton/.test(transitLivePricingPanelsText), "src/components/TransitStationLivePricingPanels.tsx: live pricing panels must keep a skeleton state for missing volatile data.");
assert(!/setStation\(null\)/.test(transitLivePricingPanelsText), "src/components/TransitStationLivePricingPanels.tsx: transient refresh failures must not erase last known good station data.");

const publicOfferQueryText = read("src/lib/public-offer-query.ts");
assert(/PUBLIC_OFFER_MAX_LIMIT\s*=\s*200/.test(publicOfferQueryText), "src/lib/public-offer-query.ts: public offer pages must stay capped at 200 rows or less.");
assert(/PUBLIC_OFFER_MAX_OFFSET\s*=\s*5000/.test(publicOfferQueryText), "src/lib/public-offer-query.ts: public offer offset must keep a bounded public scan window.");
assert(/PUBLIC_OFFER_MAX_QUERY_LENGTH\s*=\s*80/.test(publicOfferQueryText), "src/lib/public-offer-query.ts: public offer search query must keep a bounded length.");
assert(/normalizePublicOfferQuery/.test(publicOfferQueryText), "src/lib/public-offer-query.ts: public offer search query normalization must stay centralized.");

const transitPublicText = read("src/lib/api-transit-db.ts");
assert(/queryStationEnhancementRows[\s\S]{0,500}\.is\("removed_at", null\)/.test(transitPublicText), "src/lib/api-transit-db.ts: public station enhancement reads must exclude removed stations.");
assert(/function\s+queryStationRows[\s\S]{0,700}\.is\("removed_at", null\)/.test(transitPublicText), "src/lib/api-transit-db.ts: public station list/detail reads must exclude removed stations.");
assert(/refreshTransitStationsSnapshot[\s\S]{0,500}writeTransitStationsSnapshot\(stations, generatedAt\)/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit snapshot refresh must replace snapshots even when the public station set is empty.");
assert(/API_TRANSIT_MODEL_INDEX_SNAPSHOT_KEY\s*=\s*["']models:v1["']/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit model index snapshot key must remain explicitly versioned.");
assert(/refreshTransitStationsSnapshot[\s\S]{0,900}writeTransitModelIndexSnapshot\(modelIndex, generatedAt\)/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit refresh must precompute and write the model index snapshot.");
const transitModelsPageText = read("src/app/api-transit/models/page.tsx");
const transitModelExplorerText = read("src/components/TransitModelExplorer.tsx");
assert(/readTransitModelIndexSnapshot/.test(transitModelsPageText), "src/app/api-transit/models/page.tsx: model page must read the precomputed model index snapshot.");
assert(/buildTransitModelIndex\(compactTransitStationsForList\(stations\)\)/.test(transitModelsPageText), "src/app/api-transit/models/page.tsx: model page must preserve the live-computation fallback.");
assert(/api_transit_models_render/.test(transitModelsPageText), "src/app/api-transit/models/page.tsx: model page fallback work must keep segmented performance instrumentation.");
assert(/hydrateTransitModelIndexSummaries/.test(transitModelExplorerText), "src/components/TransitModelExplorer.tsx: model explorer must hydrate precomputed summaries.");
assert(!/getTransitModelSummaries/.test(transitModelExplorerText), "src/components/TransitModelExplorer.tsx: model explorer must not repeat full model grouping and sorting in the browser.");
const transitLogicText = read("src/lib/api-transit.ts");
assert(!/api_transit_detection_runs/.test(transitPublicText), "src/lib/api-transit-db.ts: public API transit reads must not query detection runs.");
assert(!/raw_snapshot/.test(transitPublicText), "src/lib/api-transit-db.ts: public API transit reads must not parse raw snapshots.");
assert(/PUBLIC_TRANSIT_READ_TIMEOUT_MS\s*=\s*2_500/.test(transitPublicText), "src/lib/api-transit-db.ts: normal API transit public reads must keep the 2.5s fallback timeout.");
assert(/PUBLIC_TRANSIT_REFRESH_READ_TIMEOUT_MS\s*=\s*15_000/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit snapshot refresh must use a longer Supabase read timeout.");
assert(/refreshTransitStationsSnapshot[\s\S]{0,500}readStationsFromSupabase\(\{\s*signal:\s*publicTransitRefreshReadSignal\(\)\s*\}\)/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit snapshot refresh must pass the long refresh signal into Supabase reads.");
assert(/function\s+publicTransitRefreshReadSignal\(\):\s*AbortSignal\s*\{\s*return\s+AbortSignal\.timeout\(PUBLIC_TRANSIT_REFRESH_READ_TIMEOUT_MS\);\s*\}/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit refresh signal must derive from PUBLIC_TRANSIT_REFRESH_READ_TIMEOUT_MS.");
assert(/readRecentAvailabilitySampleRows\(\s*supabase,\s*stationIds,\s*sampleRowLimit,\s*signal\s*\)/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit list recent sample reads must inherit the caller read signal.");
assert(/readRecentAvailabilitySampleRows\([\s\S]{0,300}signal:\s*AbortSignal\s*=\s*publicTransitReadSignal\(\)/.test(transitPublicText), "src/lib/api-transit-db.ts: recent sample reads must accept a caller signal while defaulting normal pages to 2.5s.");
assert(/TRANSIT_RECENT_AVAILABILITY_SAMPLE_LOOKBACK_MS\s*=\s*8\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(transitPublicText), "src/lib/api-transit-db.ts: recent availability samples must keep an 8 day lookback window.");
assert(/list_recent_api_transit_availability_sample_scopes[\s\S]{0,300}p_since:\s*since/.test(transitPublicText), "src/lib/api-transit-db.ts: scoped recent-sample RPC reads must keep the lookback boundary.");
assert(/const query =[\s\S]{0,500}\.gte\("checked_at", since\)[\s\S]{0,900}\.gte\("checked_at", since\)/.test(transitPublicText), "src/lib/api-transit-db.ts: legacy recent-sample fallbacks must filter checked_at before sorting the growing table.");
assert(/preferPublicStatusSamples[\s\S]{0,400}return undefined/.test(transitPublicText), "src/lib/api-transit-db.ts: public-monitor rows must not fall back to stale priceai_probe recent samples.");
assert(/for\s*\(const lookupScope of getTransitRecentAvailabilitySampleLookupScopes\(standardModel, groupName,[\s\S]{0,120}includeStationFallback:\s*scope === "station"[\s\S]{0,300}appendRecentAvailabilitySample/.test(transitPublicText), "src/lib/api-transit-db.ts: recent public samples must use shared scoped lookup keys and restrict station fallback to station summaries.");
assert(/pushScope\(normalizedStandardModel, normalizedGroupName, null, "exact"\);[\s\S]{0,260}pushScope\("", normalizedGroupName, null, "group"\);[\s\S]{0,260}pushScope\(normalizedStandardModel, "", null, "model"\);[\s\S]{0,260}pushScope\("", "", family, "family"\);[\s\S]{0,220}includeStationFallback[\s\S]{0,120}pushScope\("", "", null, "station"\);/.test(transitLogicText), "src/lib/api-transit.ts: recent sample lookup scopes must preserve exact, group, model, family order and make station fallback explicit.");
assert(!/\.abortSignal\(publicTransitReadSignal\(\)\)/.test(transitPublicText), "src/lib/api-transit-db.ts: nested API transit queries must not silently recreate the short 2.5s signal.");
assert(/function\s+findTransitStationBySlug[\s\S]{0,180}item\.slug === slug \|\| item\.id === slug/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit detail cache must resolve both station slug and station id.");
assert(/\.eq\("slug", slug\)[\s\S]{0,500}\.eq\("id", slug\)/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit detail reads must fall back from slug lookup to station id lookup.");
assert(/readTransitRowsOrEmpty/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit detail optional reads must not turn existing stations into not-found pages.");
assert(/readStationFromSupabaseBySlug[\s\S]{0,1800}readTransitRowsOrEmpty\([\s\S]{0,500}recent availability samples/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit detail recent sample timeouts must degrade instead of returning not-found.");
assert(/getTransitStationFallbackBySlug/.test(transitPublicText), "src/lib/api-transit-db.ts: API transit detail pages must fall back to cached or snapshot station data when live station reads fail.");
assert(!/Returning no API transit station because Supabase station read failed/.test(transitPublicText), "src/lib/api-transit-db.ts: failed live station reads must not be treated as station absence.");

const transitAdminText = read("src/lib/api-transit-admin.ts");
assert(/ADMIN_RUN_SELECT/.test(transitAdminText), "src/lib/api-transit-admin.ts: admin run lists must use an explicit field projection.");
assert(!/select\(\s*["'`]\*,\s*api_transit_stations\(name\)["'`]\s*\)/.test(transitAdminText), "src/lib/api-transit-admin.ts: admin run lists must not select raw snapshots with *.");
assert(/ADMIN_LATEST_RUN_SCAN_LIMIT/.test(transitAdminText), "src/lib/api-transit-admin.ts: latest-run lookup must keep a bounded scan limit.");

const globalSponsorPlacementsText = read("src/components/GlobalSponsorPlacements.tsx");
assert(/sponsorSettingsCacheFreshAgeMs\s*=\s*30\s*\*\s*60\s*\*\s*1000/.test(globalSponsorPlacementsText), "src/components/GlobalSponsorPlacements.tsx: valid sponsor settings should avoid a network refresh for 30 minutes.");
assert(/cachedSettings\?\.isFresh[\s\S]{0,180}cancelled\s*=\s*true/.test(globalSponsorPlacementsText), "src/components/GlobalSponsorPlacements.tsx: fresh sponsor settings must skip the network request while preserving effect cleanup.");
assert(/sponsorSettingsCacheMaxAgeMs\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(globalSponsorPlacementsText), "src/components/GlobalSponsorPlacements.tsx: stale sponsor settings must remain available as a seven-day last-known-good fallback.");

const publicAssetCacheText = read("src/lib/cloudflare-public-asset-cache.ts");
assert(/url\.search\s*=\s*["']["']/.test(publicAssetCacheText), "src/lib/cloudflare-public-asset-cache.ts: public asset cache keys must discard unrelated query parameters.");
assert(/url\.searchParams\.set\(["']ref["'],\s*reference\)/.test(publicAssetCacheText), "src/lib/cloudflare-public-asset-cache.ts: public asset cache keys must retain only the validated R2 reference.");
assert(/cache\.match\(cacheKey\)/.test(publicAssetCacheText), "src/lib/cloudflare-public-asset-cache.ts: public assets must read the regional Cloudflare Cache API before R2.");
assert(/cache\.put\(cacheKey,\s*responseWithStatus\.clone\(\)\)/.test(publicAssetCacheText), "src/lib/cloudflare-public-asset-cache.ts: successful public asset responses must populate the regional Cloudflare Cache API.");
for (const publicAssetRoute of [
  "src/app/api/sponsor-assets/route.ts",
  "src/app/api/api-transit/logo/route.ts",
]) {
  const text = read(publicAssetRoute);
  assert(/readPublicAssetCache\(cacheKey\)/.test(text), `${publicAssetRoute}: public image reads must check the regional cache before R2.`);
  assert(/writePublicAssetCache\(cacheKey,\s*new Response/.test(text), `${publicAssetRoute}: public image reads must cache successful R2 responses.`);
}

const openNextConfigText = read("open-next.config.ts");
assert(/overrides\/queue\/do-queue/.test(openNextConfigText), "open-next.config.ts: production ISR revalidation must use the durable object queue override.");
assert(/queue:\s*doQueue/.test(openNextConfigText), "open-next.config.ts: the durable object queue must be wired into the Cloudflare adapter config.");
assert(/overrides\/incremental-cache\/regional-cache/.test(openNextConfigText), "open-next.config.ts: the R2 incremental cache must use the regional Cache API wrapper.");
assert(/withRegionalCache\(r2IncrementalCache/.test(openNextConfigText), "open-next.config.ts: regional cache must wrap the existing R2 cache instead of replacing durable storage.");
assert(/mode:\s*OPEN_NEXT_REGIONAL_CACHE_MODE/.test(openNextConfigText), "open-next.config.ts: regional cache mode must come from the admin-visible runtime profile.");

const infrastructureRuntimeProfileText = read("src/lib/infrastructure-runtime-profile.ts");
assert(/regionalCacheMode:\s*["']short-lived["']/.test(infrastructureRuntimeProfileText), "src/lib/infrastructure-runtime-profile.ts: regional cache must stay short-lived until P3 review.");
assert(/regionalCacheMaxAgeSeconds:\s*60/.test(infrastructureRuntimeProfileText), "src/lib/infrastructure-runtime-profile.ts: the admin workflow must describe the one-minute regional-cache bound.");
assert(/cacheInterceptionEnabled:\s*false/.test(infrastructureRuntimeProfileText), "src/lib/infrastructure-runtime-profile.ts: cache interception must remain disabled during the regional-cache-only trial.");

const infrastructureRouteText = read("src/app/api/admin/infrastructure/route.ts");
assert(/requireAdminRequest\(request\)/.test(infrastructureRouteText), "src/app/api/admin/infrastructure/route.ts: infrastructure data must require an authenticated admin request.");
assert(/getInfrastructureOverview/.test(infrastructureRouteText), "src/app/api/admin/infrastructure/route.ts: infrastructure route must use the centralized read-only overview.");
assert(/private, no-store/.test(infrastructureRouteText), "src/app/api/admin/infrastructure/route.ts: infrastructure snapshots must not be cached publicly.");

const infrastructureOverviewText = read("src/lib/infrastructure-overview.ts");
assert(/get_priceai_infrastructure_snapshot/.test(infrastructureOverviewText), "src/lib/infrastructure-overview.ts: Supabase capacity data must come from the service-role snapshot RPC.");
assert(/liveDataConnected:\s*false/.test(infrastructureOverviewText), "src/lib/infrastructure-overview.ts: dated Cloudflare audit evidence must not be presented as live analytics.");
assert(/2026-07-14 Cloudflare 24h/.test(infrastructureOverviewText), "src/lib/infrastructure-overview.ts: non-live traffic evidence must keep an explicit observation date.");

const infrastructurePanelText = read("src/components/admin/InfrastructureOverviewPanel.tsx");
assert(/\/api\/admin\/infrastructure/.test(infrastructurePanelText), "src/components/admin/InfrastructureOverviewPanel.tsx: infrastructure panel must load the protected overview endpoint.");
assert(/这里没有删除、封禁或修改配置按钮/.test(infrastructurePanelText), "src/components/admin/InfrastructureOverviewPanel.tsx: infrastructure workflow must remain read-only in P2.");

const adminConsoleText = read("src/components/AdminConsole.tsx");
assert(/["']infrastructure["']/.test(adminConsoleText), "src/components/AdminConsole.tsx: admin navigation must expose the infrastructure workflow.");
assert(/<InfrastructureOverviewPanel\s*\/>/.test(adminConsoleText), "src/components/AdminConsole.tsx: infrastructure tab must render the dedicated panel.");

const wranglerConfigText = read("wrangler.jsonc");
assert(/"name"\s*:\s*"NEXT_CACHE_DO_QUEUE"/.test(wranglerConfigText), "wrangler.jsonc: the OpenNext revalidation queue must keep its durable object binding.");
assert(/"new_sqlite_classes"[\s\S]{0,120}"DOQueueHandler"/.test(wranglerConfigText), "wrangler.jsonc: the OpenNext queue durable object must keep its SQLite migration.");
assert(/"NEXT_PUBLIC_TRANSIT_DETECTOR_API_BASE_URL"\s*:\s*"https:\/\/[^"]+"/.test(wranglerConfigText), "wrangler.jsonc: detector service URL must stay in Worker runtime vars.");
assert(/"NEXT_PUBLIC_TURNSTILE_SITE_KEY"\s*:\s*"0x[^"]+"/.test(wranglerConfigText), "wrangler.jsonc: Turnstile site key must stay in Worker runtime vars.");

const intentPrefetchLinkText = read("src/components/IntentPrefetchLink.tsx");
assert(/prefetch=\{shouldPrefetch \? null : false\}/.test(intentPrefetchLinkText), "src/components/IntentPrefetchLink.tsx: main navigation must wait for hover or focus intent before prefetching.");

const siteHeaderText = read("src/components/SiteHeader.tsx");
assert(/IntentPrefetchLink/.test(siteHeaderText), "src/components/SiteHeader.tsx: high-traffic module navigation must use intent-based prefetching.");

const globalSiteFooterText = read("src/components/GlobalSiteFooter.tsx");
assert(/IntentPrefetchLink/.test(globalSiteFooterText), "src/components/GlobalSiteFooter.tsx: global footer links must wait for user intent before prefetching.");

const authButtonText = read("src/components/AuthButton.tsx");
assert(/IntentPrefetchLink/.test(authButtonText), "src/components/AuthButton.tsx: login and account links must wait for user intent before prefetching.");

const accountClientText = read("src/lib/account-client.ts");
assert(/readAccountAuthHint\(\) === ["']anonymous["']/.test(accountClientText), "src/lib/account-client.ts: known anonymous browsers must skip repeated account probes.");

for (const authRouteFile of ["src/app/auth/callback/route.ts", "src/app/auth/signout/route.ts"]) {
  const text = read(authRouteFile);
  assert(/ACCOUNT_AUTH_HINT_COOKIE/.test(text), `${authRouteFile}: auth transitions must keep the non-authoritative account hint synchronized.`);
}

for (const longListFile of [
  "src/components/PriceExplorer.tsx",
  "src/components/OfficialPricesExplorer.tsx",
  "src/components/ApiModelsExplorer.tsx",
  "src/components/TransitStationExplorer.tsx",
  "src/components/GuidesDirectory.tsx",
  "src/components/GuideDocsLayout.tsx",
  "src/components/GuideReadingFooter.tsx",
  "src/components/GuideMobileNav.tsx",
  "src/app/guides/page.tsx",
]) {
  const text = read(longListFile);
  assert(/prefetch=\{false\}/.test(text), `${longListFile}: long link lists must not prefetch every viewport entry.`);
}

const probeText = read("scripts/probe-api-transit.mjs");
assert(/api_transit_availability_samples/.test(probeText), "scripts/probe-api-transit.mjs: availability rollup must use structured sample rows.");
assert(
  !/\.from\(\s*["'`]api_transit_detection_runs["'`]\s*\)[\s\S]{0,500}\.select\([\s\S]{0,120}raw_snapshot/.test(probeText),
  "scripts/probe-api-transit.mjs: availability rollup must not read historical raw snapshots.",
);
assert(/AVAILABILITY_SAMPLE_LOOKBACK_LIMIT\s*=\s*2000/.test(probeText), "scripts/probe-api-transit.mjs: structured availability sample lookup must stay bounded.");

const transitSamplesMigration = read("supabase/migrations/20260618134500_api_transit_availability_samples.sql");
assert(/create table if not exists api_transit_availability_samples/.test(transitSamplesMigration), "api transit availability sample migration must create the structured sample table.");
assert(/checked_at desc/.test(transitSamplesMigration), "api transit availability sample migration must index station time lookups.");

const transitCheckedTimeIndexMigration = read("supabase/migrations/20260713155000_api_transit_availability_checked_time_index.sql");
assert(/api_transit_availability_samples_checked_time_idx/.test(transitCheckedTimeIndexMigration), "API transit recent-sample reads must keep the checked_at-first covering index.");
assert(/include \(scope, standard_model, group_name, ok, source_type\)/.test(transitCheckedTimeIndexMigration), "API transit checked-time index must keep the fields needed for index-only recent-sample reads.");

const transitRetentionMigration = read("supabase/migrations/20260714200000_api_transit_availability_rollups_retention.sql");
assert(/create table if not exists public\.api_transit_availability_hourly_rollups/.test(transitRetentionMigration), "API transit retention must keep hourly availability rollups.");
assert(/create table if not exists public\.api_transit_availability_daily_rollups/.test(transitRetentionMigration), "API transit retention must keep daily availability rollups.");
assert(/refresh_api_transit_availability_rollups/.test(transitRetentionMigration), "API transit retention must provide a repeatable rollup refresh function.");
assert(/p_raw_retention_days integer default 8/.test(transitRetentionMigration), "API transit raw availability retention must default to the eight-day product window.");
assert(/p_hourly_retention_days integer default 90/.test(transitRetentionMigration), "API transit hourly rollups must default to 90-day retention.");
assert(/p_daily_retention_days integer default 365/.test(transitRetentionMigration), "API transit daily rollups must default to 365-day retention.");
assert(/p_batch_size integer default 5000/.test(transitRetentionMigration), "API transit retention must default to bounded 5,000-row batches.");
assert(/p_dry_run boolean default true/.test(transitRetentionMigration), "API transit retention must default to preview-only mode.");
assert(/refusing raw availability deletion/.test(transitRetentionMigration), "API transit retention must refuse raw deletion when hourly rollup coverage is incomplete.");
assert(!/\nselect\s+public\.prune_api_transit_availability_retention\s*\(/i.test(transitRetentionMigration), "API transit retention migration must not execute destructive pruning while the migration is applied.");
assert(!/vacuum\s+full|reindex/i.test(transitRetentionMigration), "API transit retention migration must not run table-rewriting maintenance during rollout.");

const transitDetectionRetentionMigration = read("supabase/migrations/20260714213000_api_transit_detection_retention_infrastructure_snapshot.sql");
assert(/prune_api_transit_detection_run_retention/.test(transitDetectionRetentionMigration), "API transit retention must include detection-run payload and metadata cleanup.");
assert(/p_payload_retention_days integer default 14/.test(transitDetectionRetentionMigration), "Detection payload retention must default to 14 days.");
assert(/p_run_retention_days integer default 30/.test(transitDetectionRetentionMigration), "Detection run metadata retention must default to 30 days.");
assert(/p_batch_size integer default 5000/.test(transitDetectionRetentionMigration), "Detection retention must default to bounded 5,000-row batches.");
assert(/p_dry_run boolean default true/.test(transitDetectionRetentionMigration), "Detection retention must default to preview-only mode.");
assert(/not exists \([\s\S]{0,220}api_transit_availability_samples/.test(transitDetectionRetentionMigration), "Detection retention must refuse to delete runs that still own availability samples.");
assert(/prune_api_transit_retention/.test(transitDetectionRetentionMigration), "API transit retention must expose one unified preview/apply entry point.");
assert(/get_priceai_infrastructure_snapshot/.test(transitDetectionRetentionMigration), "Infrastructure admin must use a service-role-only database snapshot RPC.");
assert(/'decision', 'keep'/.test(transitDetectionRetentionMigration), "Infrastructure snapshot must preserve the evidence-backed covering-index decision.");
assert(!/drop\s+index[\s\S]{0,160}api_transit_availability_samples_checked_time_idx/i.test(transitDetectionRetentionMigration), "P2 must not drop the actively used availability covering index.");
assert(!/\nselect\s+public\.prune_api_transit_(?:detection_run_)?retention\s*\(/i.test(transitDetectionRetentionMigration), "Detection retention migration must not execute destructive pruning while it is applied.");
assert(!/vacuum\s+full|reindex/i.test(transitDetectionRetentionMigration), "Detection retention migration must not run table-rewriting maintenance during rollout.");

const transitOfferRetentionMigration = read("supabase/migrations/20260808135000_api_transit_inactive_offer_retention.sql");
const transitMultiplierHistoryMigration = read("supabase/migrations/20260627103000_api_transit_multiplier_history.sql");
const transitRetentionRoute = read("src/app/api/cron/api-transit-retention/route.ts");
assert(/prune_api_transit_offer_retention/.test(transitOfferRetentionMigration), "API transit retention must prune obsolete inactive offer entities.");
assert(/p_inactive_retention_days integer default 7/.test(transitOfferRetentionMigration), "Inactive API transit offers must default to seven-day retention.");
assert(/greatest\(7, least\(coalesce\(p_inactive_retention_days, 7\), 90\)\)/.test(transitOfferRetentionMigration), "Inactive API transit offer retention must enforce seven days as a hard minimum.");
assert(/where status = 'inactive'[\s\S]{0,120}updated_at < v_cutoff/.test(transitOfferRetentionMigration), "Offer retention must only target inactive rows beyond the retention cutoff.");
assert(/'offers', public\.prune_api_transit_offer_retention\(7, p_batch_size, p_dry_run\)/.test(transitOfferRetentionMigration), "Unified API transit retention must include inactive offers.");
assert(/p_dry_run boolean default true/.test(transitOfferRetentionMigration), "Inactive offer retention must default to preview-only mode.");
assert(!/\nselect\s+public\.prune_api_transit_(?:offer_)?retention\s*\(/i.test(transitOfferRetentionMigration), "Inactive offer retention migration must not execute destructive pruning while applied.");
assert(!/vacuum\s+full|reindex/i.test(transitOfferRetentionMigration), "Inactive offer retention migration must not run table-rewriting maintenance during rollout.");
assert(/offer_id text references api_transit_offers\(id\) on delete set null/.test(transitMultiplierHistoryMigration), "Deleting obsolete inactive offers must preserve independent multiplier history.");
assert(/scope === "offers"[\s\S]{0,180}prune_api_transit_offer_retention/.test(transitRetentionRoute), "API transit retention must expose an independent inactive-offer scope so large legacy retention tables cannot roll it back.");
assert(/p_inactive_retention_days: 7/.test(transitRetentionRoute), "The inactive-offer retention endpoint must request the seven-day policy.");

const smokeText = read("scripts/smoke-cloudflare.mjs");
assert(/SMOKE_FETCH_TIMEOUT_MS/.test(smokeText), "scripts/smoke-cloudflare.mjs: smoke checks must have a request timeout.");
assert(/fetchWithTimeout/.test(smokeText), "scripts/smoke-cloudflare.mjs: smoke checks must use fetchWithTimeout.");
assert(/validateApiTransitDetailPages/.test(smokeText), "scripts/smoke-cloudflare.mjs: production smoke must validate API transit detail pages.");
assert(/extractApiTransitDetailPaths/.test(smokeText), "scripts/smoke-cloudflare.mjs: API transit detail smoke must derive detail paths from sitemap.");
assert(/readPublishedApiTransitDetailPathsFromSupabase/.test(smokeText), "scripts/smoke-cloudflare.mjs: API transit detail smoke must also cover newly published stations from Supabase.");
assert(/API 中转站详情/.test(smokeText), "scripts/smoke-cloudflare.mjs: API transit detail smoke must reject cached not-found detail pages.");

const packageText = read("package.json");
assert(/"check:performance"\s*:\s*"node scripts\/check-performance-guards\.mjs"/.test(packageText), "package.json: add npm run check:performance.");
assert(/"refresh:snapshots"\s*:\s*"node scripts\/refresh-public-api-snapshots\.mjs"/.test(packageText), "package.json: add npm run refresh:snapshots for the server timer.");

const buildCloudflareText = read("scripts/build-cloudflare.mjs");
assert(/check-performance-guards\.mjs/.test(buildCloudflareText), "scripts/build-cloudflare.mjs: run performance guards before OpenNext build.");

const hotVerifierLauncherText = read("ops/shop-collectors/run-hot-offer-verifier.sh");
assert(/STATE_DIRECTORY/.test(hotVerifierLauncherText), "hot offer verifier must persist proxy leases in its systemd state directory.");
assert(/--proxy-state-path/.test(hotVerifierLauncherText), "hot offer verifier must pass the proxy lease state path.");
assert(/--proxy-max-runs/.test(hotVerifierLauncherText), "hot offer verifier must cap cross-run proxy lease reuse.");
assert(/PRICEAI_HOT_VERIFY_PROXY_REUSE_TTL_MS:-600000/.test(hotVerifierLauncherText), "hot offer verifier fallback lease TTL must cover two five-minute runs.");

const hotVerifierServiceText = read("ops/shop-collectors/systemd/priceai-hot-offer-verifier.service");
assert(/StateDirectory=priceai-hot-offer-verifier/.test(hotVerifierServiceText), "hot offer verifier must use a protected systemd state directory.");
assert(/StateDirectoryMode=0700/.test(hotVerifierServiceText), "hot offer verifier state directory must remain private.");

const hotVerifierEnvExampleText = read("ops/shop-collectors/hot-offer-verifier.env.example");
assert(/PRICEAI_HOT_VERIFY_PROXY_REUSE_TTL_MS=600000/.test(hotVerifierEnvExampleText), "hot offer verifier env must preserve the ten-minute proxy lease TTL.");
assert(/PRICEAI_HOT_VERIFY_PROXY_MAX_RUNS=2/.test(hotVerifierEnvExampleText), "hot offer verifier env must cap proxy leases at two runs.");

for (const file of listSourceFiles(["src/app", "src/lib"])) {
  if (!isPublicRuntimeFile(file)) continue;
  const text = read(file);
  if (/api_transit_detection_runs|raw_snapshot/.test(text)) {
    failures.push(`${file}: public runtime code must not read API transit raw detection snapshots.`);
  }
}

if (failures.length) {
  console.error("Performance guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Performance guard passed.");

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`${relativePath}: file is missing.`);
    return "";
  }
  return readFileSync(absolutePath, "utf8");
}

function listSourceFiles(roots) {
  const files = [];
  for (const root of roots) walk(path.join(repoRoot, root), files);
  return files.map((file) => path.relative(repoRoot, file).split(path.sep).join("/"));
}

function latestMigrationDefining(functionName) {
  return listMigrationFiles()
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => read(file).includes(`create or replace function ${functionName}`))
    .at(-1);
}

function listMigrationFiles() {
  return readdirSync(path.join(repoRoot, "supabase/migrations"))
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => `supabase/migrations/${entry}`);
}

function walk(directory, files) {
  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      walk(absolutePath, files);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) files.push(absolutePath);
  }
}

function isPublicRuntimeFile(file) {
  if (file.includes("/admin/") || file.includes("/api/admin/") || file.includes("/api/cron/")) return false;
  if (file.endsWith("api-transit-admin.ts")) return false;
  if (file.endsWith("official-price-jobs.ts")) return false;
  return true;
}
