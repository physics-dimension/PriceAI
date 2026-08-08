#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __test } from "./collect-api-transit.mjs";
import { COLLECTOR_RUNTIME_SOURCE_FILES } from "./collector-runtime-policy.mjs";

const collectorRuntimeSources = new Set(COLLECTOR_RUNTIME_SOURCE_FILES);
const collectorRuntimeSourceSync = readFileSync(
  new URL("./sync-collector-runtime-source.mjs", import.meta.url),
  "utf8",
);
assert.match(
  collectorRuntimeSourceSync,
  /current_real=.*readlink -f .*\/current/,
  "Source sync must resolve the active artifact release behind current/.",
);
assert.match(
  collectorRuntimeSourceSync,
  /target_roots=.*remote_root[\s\S]*target_roots\+=.*active_root/,
  "Source sync must update both the runtime root fallback and active artifact release.",
);
assert.match(
  collectorRuntimeSourceSync,
  /for target_root in .*target_roots/,
  "Source sync must checksum every runtime target after copying source files.",
);
for (const sourceFile of COLLECTOR_RUNTIME_SOURCE_FILES.filter((file) => file.endsWith(".mjs"))) {
  const source = readFileSync(new URL(`../${sourceFile}`, import.meta.url), "utf8");
  for (const match of source.matchAll(/from\s+["'](\.\/[^"']+\.mjs)["']/g)) {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), match[1]));
    assert.ok(
      collectorRuntimeSources.has(dependency),
      `${sourceFile} imports ${dependency}, which must be included in the collector runtime source manifest.`,
    );
  }
}

const stationWithOfferEvidenceFields = {
  id: "station-schema-compatibility",
  name: "Station schema compatibility",
  availability_scope: "model",
  availability_match_level: "family",
  monitoring_scope_id: "monitoring-scope",
};
assert.deepEqual(__test.removeAvailabilityEvidenceFields([stationWithOfferEvidenceFields]), [{
  id: "station-schema-compatibility",
  name: "Station schema compatibility",
}]);
assert.deepEqual(stationWithOfferEvidenceFields, {
  id: "station-schema-compatibility",
  name: "Station schema compatibility",
  availability_scope: "model",
  availability_match_level: "family",
  monitoring_scope_id: "monitoring-scope",
}, "Station compatibility fallback must not mutate the original collector payload.");

const stationUpsertAttempts = [];
await __test.upsertRows({
  from(table) {
    assert.equal(table, "api_transit_stations");
    return {
      async upsert(rows) {
        stationUpsertAttempts.push(rows);
        return stationUpsertAttempts.length === 1
          ? { error: { code: "PGRST204", message: "Could not find the 'availability_match_level' column of 'api_transit_stations' in the schema cache" } }
          : { error: null };
      },
    };
  },
}, "api_transit_stations", [stationWithOfferEvidenceFields], { onConflict: "id" });
assert.equal(stationUpsertAttempts.length, 2);
assert.deepEqual(stationUpsertAttempts[0], [stationWithOfferEvidenceFields]);
assert.deepEqual(stationUpsertAttempts[1], [{
  id: "station-schema-compatibility",
  name: "Station schema compatibility",
}]);

const paginatedExistingOffers = Array.from({ length: 1001 }, (_, index) => ({
  id: `existing-offer-${index}`,
  station_id: "large-station",
  standard_model: `Model ${index}`,
  group_name: "default",
  status: "active",
  created_at: "2026-08-08T00:00:00.000Z",
}));
const existingOfferRanges = [];
const existingOffersByKey = await __test.readExistingOffersWithColumns(
  {
    from(table) {
      assert.equal(table, "api_transit_offers");
      return {
        select() {
          return {
            in(column, stationIds) {
              assert.equal(column, "station_id");
              assert.deepEqual(stationIds, ["large-station"]);
              return {
                order(columnName, options) {
                  assert.equal(columnName, "id");
                  assert.deepEqual(options, { ascending: true });
                  return {
                    async range(from, to) {
                      existingOfferRanges.push([from, to]);
                      return { data: paginatedExistingOffers.slice(from, to + 1), error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  },
  ["large-station"],
  ["id", "station_id", "standard_model", "group_name", "status", "created_at"],
);
assert.equal(existingOffersByKey.size, 1001, "Existing offer reads must not stop at PostgREST's first 1000 rows.");
assert.deepEqual(existingOfferRanges, [[0, 999], [1000, 1999]]);
assert.equal(
  existingOffersByKey.get("large-station|Model 1000|default")?.id,
  "existing-offer-1000",
  "Offers beyond the first page must retain their stored primary key during refresh.",
);

const isolatedOfferWrites = [];
const isolatedWriteResult = await __test.upsertOfferRowsByStation(
  {
    from(table) {
      assert.equal(table, "api_transit_offers");
      return {
        async upsert(rows) {
          isolatedOfferWrites.push(rows.map((row) => row.station_id));
          return rows[0]?.station_id === "broken-station"
            ? { error: { code: "23503", message: "history foreign key conflict" } }
            : { error: null };
        },
      };
    },
  },
  [
    { id: "broken-offer", station_id: "broken-station" },
    { id: "healthy-offer", station_id: "healthy-station" },
  ],
  ["broken-station", "healthy-station", "empty-station"],
);
assert.deepEqual(isolatedOfferWrites, [["broken-station"], ["healthy-station"]]);
assert.deepEqual([...isolatedWriteResult.successfulStationIds], ["healthy-station"]);
assert.equal(isolatedWriteResult.failures.length, 1);
assert.equal(isolatedWriteResult.failures[0].stationId, "broken-station");
assert.equal(isolatedWriteResult.failures[0].code, "23503");

let oversizedOfferWriteCalls = 0;
const oversizedOfferWriteResult = await __test.upsertOfferRowsByStation(
  {
    from() {
      oversizedOfferWriteCalls += 1;
      return { async upsert() { return { error: null }; } };
    },
  },
  Array.from({ length: 301 }, (_, index) => ({ id: `oversized-${index}`, station_id: "oversized-station" })),
  ["oversized-station"],
);
assert.equal(oversizedOfferWriteCalls, 0, "Oversized station writes must fail before any partial database request.");
assert.equal(oversizedOfferWriteResult.successfulStationIds.size, 0);
assert.equal(oversizedOfferWriteResult.failures[0].code, "offer_batch_too_large");

const newStationShell = __test.buildNewStationShellForOfferWrite({
  id: "new-station",
  status: "active",
  usage_advice: "try_small",
  data_status: "verified",
  availability_seven_day_rate: 1,
  availability_seven_day_samples: 60,
  availability_first_checked_at: "2026-08-01T00:00:00.000Z",
  availability_last_checked_at: "2026-08-08T00:00:00.000Z",
  availability_latest_latency_ms: 1000,
  availability_avg_latency_7d_ms: 1200,
  availability_note: "fresh",
  collection_status: "success",
  last_collected_at: "2026-08-08T00:00:00.000Z",
  published: true,
});
assert.equal(newStationShell.published, false);
assert.equal(newStationShell.collection_status, "pending");
assert.equal(newStationShell.last_collected_at, null);
assert.equal(newStationShell.availability_last_checked_at, null);

const collectorWriteOrderSource = readFileSync(new URL("./collect-api-transit.mjs", import.meta.url), "utf8");
assert.match(
  collectorWriteOrderSource,
  /const offerWriteResult = await upsertOfferRowsByStation[\s\S]{0,2200}await upsertRows\(supabase, "api_transit_stations", successfulStations/,
  "Existing station freshness must only advance after that station's offer write succeeds.",
);

const leaseCliSmoke = spawnSync(process.execPath, [fileURLToPath(new URL("./collect-api-transit.mjs", import.meta.url)), "--post", "--source", "__lease_smoke__"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  encoding: "utf8",
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
    SUPABASE_SERVICE_ROLE_KEY: "local-test-key",
  },
});
const leaseCliOutput = `${leaseCliSmoke.stdout || ""}\n${leaseCliSmoke.stderr || ""}`;
assert.notEqual(leaseCliSmoke.status, 0, "Lease smoke must stop at the intentionally unreachable local Supabase endpoint.");
assert.doesNotMatch(leaseCliOutput, /ReferenceError:\s*env is not defined/, "CLI lease setup must use the initialized runtime environment.");
assert.match(leaseCliOutput, /fetch failed|ECONNREFUSED|bad port/i, "Lease smoke must reach the Supabase client without touching a real project.");

const transitSourceConfig = JSON.parse(readFileSync(new URL("../config/api-transit-sources.json", import.meta.url), "utf8"));
const configuredAcsGatewaySource = transitSourceConfig.find((source) => source.id === "acsgw-top");
assert.ok(configuredAcsGatewaySource, "ACS Gateway must stay saved as an API transit draft source.");
assert.equal(configuredAcsGatewaySource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredAcsGatewaySource.stationSystem, "custom");
assert.equal(configuredAcsGatewaySource.websiteUrl, "https://acsgw.top/");
assert.equal(configuredAcsGatewaySource.pricingUrl, "https://acsgw.top/.well-known/ai-transit.json");
assert.equal(configuredAcsGatewaySource.pricingEndpointUrl, "https://acsgw.top/api/public/transit/v1/snapshot");
assert.equal(configuredAcsGatewaySource.monitorUrl, "https://acsgw.top/status");
assert.equal(configuredAcsGatewaySource.monitorEndpointUrl, "https://acsgw.top/api/public/transit/v1/status");
assert.equal(configuredAcsGatewaySource.rechargeRatio, "1:1");
assert.equal(configuredAcsGatewaySource.autoPublish, false);
assert.equal(configuredAcsGatewaySource.operatorType, "company");
assert.equal(configuredAcsGatewaySource.invoiceSupport, "supported");
assert.match(configuredAcsGatewaySource.refundPolicy, /3%/);
assert.ok(
  configuredAcsGatewaySource.adminNote.includes("Codex Plus 0.2") &&
    configuredAcsGatewaySource.adminNote.includes("autoPublish=false"),
  "ACS Gateway 后台备注必须保留站长倍率口径并明确保持待审核草稿。",
);
const configuredRtocSource = transitSourceConfig.find((source) => source.id === "ai-rtoc-cc");
assert.ok(configuredRtocSource, "RTOC AI must stay in API transit public collection sources.");
assert.equal(configuredRtocSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredRtocSource.pricingUrl, "https://ai.rtoc.cc/.well-known/ai-transit.json");
assert.equal(configuredRtocSource.pricingEndpointUrl, "https://api.rtoc.cc/api/public/transit/v1/snapshot");
assert.equal(configuredRtocSource.monitorUrl, "https://ai.rtoc.cc/pricing");
assert.equal("monitorEndpointUrl" in configuredRtocSource, false);
const configuredAiTransitSnapshotSource = transitSourceConfig.find((source) => source.id === "sub-dimension-cc-cd");
assert.ok(configuredAiTransitSnapshotSource, "Sub2API ai-transit snapshot test station must stay in collection sources.");
assert.equal(configuredAiTransitSnapshotSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredAiTransitSnapshotSource.autoPublish, true);
const configuredApinodeSource = transitSourceConfig.find((source) => source.id === "apinode-ltd");
assert.ok(configuredApinodeSource, "APINode must stay in API transit public collection sources.");
assert.equal(configuredApinodeSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredApinodeSource.pricingUrl, "https://apinode.ltd/public/transit");
assert.equal(configuredApinodeSource.pricingEndpointUrl, "https://apinode.ltd/api/public/transit/v1/snapshot");
assert.equal(configuredApinodeSource.monitorUrl, "https://apinode.ltd/public/transit?view=monitoring");
assert.equal(configuredApinodeSource.stationSystem, "sub_to_api");
assert.equal(configuredApinodeSource.autoPublish, true);
assert.deepEqual(configuredApinodeSource.groupAliases, {
  "Team/Plus渠道": "Team/Plus-标准通道",
  "Plus渠道": "Plus-经济通道",
  "Pro/Team/Plus渠道": "Pro/Team/Plus-稳定通道",
  "grok-尝鲜渠道": "Grok尝鲜分组",
});
const configuredCallaiSource = transitSourceConfig.find((source) => source.id === "sub-callai-one");
assert.ok(configuredCallaiSource, "Sub Callai One must stay in API transit public collection sources.");
assert.equal(configuredCallaiSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredCallaiSource.pricingUrl, "https://sub.callai.one/public/transit");
assert.equal(configuredCallaiSource.pricingEndpointUrl, "https://sub.callai.one/api/public/transit/v1/snapshot");
assert.equal(configuredCallaiSource.monitorUrl, "https://sub.callai.one/public/transit?view=monitoring");
assert.equal(configuredCallaiSource.stationSystem, "sub_to_api");
assert.equal(configuredCallaiSource.rechargeRatio, "1:1");
assert.equal(configuredCallaiSource.autoPublish, true);
assert.equal("partnerTokenEnv" in configuredCallaiSource, false);
assert.equal(configuredCallaiSource.groupAliases, undefined);
const configuredAliuapiSource = transitSourceConfig.find((source) => source.id === "aliuapi-top");
assert.ok(configuredAliuapiSource, "A6-API must stay in API transit public collection sources.");
assert.equal(configuredAliuapiSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredAliuapiSource.pricingUrl, "https://aliuapi.top/public/transit");
assert.equal(configuredAliuapiSource.pricingEndpointUrl, "https://aliuapi.top/api/public/transit/v1/snapshot");
assert.equal(configuredAliuapiSource.monitorUrl, "https://aliuapi.top/public/transit?view=monitoring");
assert.equal(configuredAliuapiSource.stationSystem, "sub_to_api");
assert.equal(configuredAliuapiSource.autoPublish, true);
assert.deepEqual(configuredAliuapiSource.groupAliases, {
  Plus: "T0 - GPT Plus",
  Pro: "T1 - GPT Pro",
});
const configuredMfttaiSource = transitSourceConfig.find((source) => source.id === "mfttai-com");
assert.ok(configuredMfttaiSource, "MFAPI must stay in API transit public collection sources.");
assert.equal(configuredMfttaiSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredMfttaiSource.websiteUrl, "https://mfttai.com/register?aff=PRICEAI");
assert.equal(configuredMfttaiSource.pricingUrl, "https://mfttai.com/public/transit");
assert.equal(configuredMfttaiSource.pricingEndpointUrl, "https://mfttai.com/api/public/transit/v1/snapshot");
assert.equal(configuredMfttaiSource.monitorUrl, "https://mfttai.com/public/transit?view=monitoring");
assert.equal(configuredMfttaiSource.stationSystem, "sub_to_api");
assert.equal(configuredMfttaiSource.rechargeRatio, "1:1");
assert.equal(configuredMfttaiSource.autoPublish, true);
const configuredWawazzSource = transitSourceConfig.find((source) => source.id === "wawazz-xyz");
assert.ok(configuredWawazzSource, "WAWA ZZ API must stay in API transit public collection sources.");
assert.equal(configuredWawazzSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredWawazzSource.pricingUrl, "https://wawazz.xyz/public/transit");
assert.equal(configuredWawazzSource.pricingEndpointUrl, "https://wawazz.xyz/api/public/transit/v1/snapshot");
assert.equal(configuredWawazzSource.monitorUrl, "https://wawazz.xyz/public/transit?view=monitoring");
assert.equal(configuredWawazzSource.stationSystem, "sub_to_api");
assert.equal(configuredWawazzSource.rechargeRatio, "1:1");
assert.equal(configuredWawazzSource.autoPublish, true);
assert.equal(configuredWawazzSource.disableGlobalModelAvailabilityFallback, true);
assert.deepEqual(configuredWawazzSource.groupAliases, {
  "cc-kiro-power": "claude-krio-power",
  "cc-max分组": "claude-max-号池-不限制客户端",
  "gpt-plus分组": "gpt-plus",
  "gpt-pro分组": "gpt-pro",
});
assert.equal(configuredWawazzSource.aiTransitGroupModels["gpt-plus"], undefined);
assert.equal(configuredWawazzSource.aiTransitGroupModels["gpt-pro"], undefined);
const configuredMaofeiSource = transitSourceConfig.find((source) => source.id === "999555999-com");
assert.ok(configuredMaofeiSource, "猫肥NekoAPI public snapshot must stay attached to the existing station source.");
assert.ok(
  !transitSourceConfig.some((source) => source.id === "api-999555999-com"),
  "猫肥NekoAPI must not be collected as a duplicate api-999555999-com station.",
);
assert.equal(configuredMaofeiSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredMaofeiSource.websiteUrl, "https://www.999555999.com/");
assert.equal(configuredMaofeiSource.pricingUrl, "https://api.999555999.com/public/transit");
assert.equal(configuredMaofeiSource.pricingEndpointUrl, "https://api.999555999.com/api/public/transit/v1/snapshot");
assert.equal(configuredMaofeiSource.monitorUrl, "https://api.999555999.com/public/transit?view=monitoring");
assert.equal(configuredMaofeiSource.stationSystem, "sub_to_api");
assert.equal(configuredMaofeiSource.rechargeRatio, "1:1");
assert.equal(configuredMaofeiSource.autoPublish, true);
const configuredOnePkapiSource = transitSourceConfig.find((source) => source.id === "api-1pkapi-com");
assert.ok(configuredOnePkapiSource, "皓悦 API must stay saved as an API transit draft source.");
assert.equal(configuredOnePkapiSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredOnePkapiSource.stationSystem, "custom");
assert.equal(configuredOnePkapiSource.websiteUrl, "https://1pkapi.com/");
assert.equal(configuredOnePkapiSource.apiBaseUrl, "https://1pkapi.com/v1");
assert.equal(configuredOnePkapiSource.pricingUrl, "https://1pkapi.com/public/transit");
assert.equal(configuredOnePkapiSource.pricingEndpointUrl, "https://1pkapi.com/api/public/transit/v1/snapshot");
assert.equal(configuredOnePkapiSource.discoveryUrl, "https://1pkapi.com/.well-known/ai-transit.json");
assert.equal(configuredOnePkapiSource.monitorUrl, "https://1pkapi.com/public/transit?view=monitoring");
assert.equal(configuredOnePkapiSource.rechargeRatio, "1:1");
assert.equal(configuredOnePkapiSource.autoPublish, false);
assert.equal(configuredOnePkapiSource.commercialRelation, "none");
assert.equal(configuredOnePkapiSource.operatorType, "unknown");
assert.equal(configuredOnePkapiSource.invoiceSupport, "unknown");
assert.ok(
  configuredOnePkapiSource.adminNote.includes("autoPublish=false"),
  "皓悦 API 后台备注必须明确保持待审核草稿，不自动上前台。",
);
const configuredOnepigSource = transitSourceConfig.find((source) => source.id === "onepig123-com");
assert.ok(configuredOnepigSource, "粉猪模型网关/路由层 must stay saved as an API transit draft source.");
assert.equal(configuredOnepigSource.collectorKind, "ai_transit_snapshot");
assert.equal(configuredOnepigSource.stationSystem, "sub_to_api");
assert.equal(configuredOnepigSource.websiteUrl, "https://onepig123.com/");
assert.equal(configuredOnepigSource.apiBaseUrl, "https://onepig123.com/v1");
assert.equal(configuredOnepigSource.pricingUrl, "https://onepig123.com/public/transit");
assert.equal(configuredOnepigSource.pricingEndpointUrl, "https://onepig123.com/api/public/transit/v1/snapshot");
assert.equal(configuredOnepigSource.monitorUrl, "https://onepig123.com/public/transit?view=monitoring");
assert.equal(configuredOnepigSource.rechargeRatio, "1:1");
assert.equal(configuredOnepigSource.autoPublish, false);
assert.equal(configuredOnepigSource.commercialRelation, "none");
assert.equal(configuredOnepigSource.operatorType, "unknown");
assert.equal(configuredOnepigSource.invoiceSupport, "unknown");
assert.ok(
  configuredOnepigSource.adminNote.includes("autoPublish=false"),
  "粉猪模型网关/路由层后台备注必须明确保持待审核草稿，不自动上前台。",
);
const configuredCodex666Source = transitSourceConfig.find((source) => source.id === "codex666ai-com");
assert.ok(configuredCodex666Source, "codex666ai must stay saved as an API transit draft source.");
assert.equal(configuredCodex666Source.collectorKind, "ai_transit_snapshot");
assert.equal(configuredCodex666Source.stationSystem, "sub_to_api");
assert.equal(configuredCodex666Source.websiteUrl, "https://codex666ai.com/");
assert.equal(configuredCodex666Source.pricingUrl, "https://codex666ai.com/public/transit");
assert.equal(configuredCodex666Source.pricingEndpointUrl, "https://codex666ai.com/api/public/transit/v1/snapshot");
assert.equal(configuredCodex666Source.monitorUrl, "https://codex666ai.com/public/transit?view=monitoring");
assert.equal(configuredCodex666Source.rechargeRatio, "1:1");
assert.equal(configuredCodex666Source.autoPublish, false);
assert.equal(configuredCodex666Source.commercialRelation, "none");
assert.equal(configuredCodex666Source.operatorType, "individual");
assert.equal(configuredCodex666Source.invoiceSupport, "supported");
assert.ok(
  configuredCodex666Source.adminNote.includes("autoPublish=false"),
  "codex666ai 后台备注必须明确保持待审核草稿，不自动上前台。",
);
const configured790053500Source = transitSourceConfig.find((source) => source.id === "790053500-com");
assert.ok(configured790053500Source, "鑫旺Neko API must stay saved as an API transit draft source.");
assert.equal(configured790053500Source.collectorKind, "ai_transit_snapshot");
assert.equal(configured790053500Source.stationSystem, "sub_to_api");
assert.equal(configured790053500Source.websiteUrl, "https://790053500.com/");
assert.equal(configured790053500Source.pricingUrl, "https://790053500.com/public/transit");
assert.equal(configured790053500Source.pricingEndpointUrl, "https://790053500.com/api/public/transit/v1/snapshot");
assert.equal(configured790053500Source.monitorUrl, "https://790053500.com/public/transit?view=monitoring");
assert.equal(configured790053500Source.rechargeRatio, "1:1");
assert.equal(configured790053500Source.autoPublish, false);
assert.equal(configured790053500Source.commercialRelation, "none");
assert.equal(configured790053500Source.operatorType, "unknown");
assert.equal(configured790053500Source.invoiceSupport, "unknown");
assert.ok(
  configured790053500Source.adminNote.includes("autoPublish=false"),
  "鑫旺Neko API 后台备注必须明确保持待审核草稿，不自动上前台。",
);
const configuredYujianSource = transitSourceConfig.find((source) => source.id === "yujianwudi-top");
assert.ok(configuredYujianSource, "天机阁 must stay saved as an API transit draft source.");
assert.equal(configuredYujianSource.collectorKind, "new_api_pricing");
assert.equal(configuredYujianSource.stationSystem, "new_api");
assert.equal(configuredYujianSource.pricingUrl, "https://yujianwudi.top/pricing");
assert.equal(configuredYujianSource.pricingEndpointUrl, "https://yujianwudi.top/api/pricing");
assert.equal(configuredYujianSource.monitorEndpointUrl, "https://yujianwudi.top/api/perf-metrics/summary?period=24");
assert.equal(configuredYujianSource.rechargeRatio, "1:1");
assert.equal(configuredYujianSource.autoPublish, false);
assert.equal(configuredYujianSource.commercialRelation, "affiliate");
assert.equal(configuredYujianSource.operatorType, "individual");
assert.equal(configuredYujianSource.invoiceSupport, "supported");
assert.equal(Boolean(configuredYujianSource.monitorUrl), false);
assert.ok(
  configuredYujianSource.adminNote.includes("Pro 号池常规 0.20 倍率"),
  "天机阁后台备注必须保留站长提交的常规 Pro 倍率口径。",
);
const configuredUmapisSource = transitSourceConfig.find((source) => source.id === "umapis-com");
assert.ok(configuredUmapisSource, "悠米AI中转 must stay saved as an API transit draft source.");
assert.equal(configuredUmapisSource.collectorKind, "new_api_pricing");
assert.equal(configuredUmapisSource.stationSystem, "new_api");
assert.equal(configuredUmapisSource.websiteUrl, "https://www.umapis.com/");
assert.equal(configuredUmapisSource.pricingUrl, "https://www.umapis.com/pricing");
assert.equal(configuredUmapisSource.pricingEndpointUrl, "https://www.umapis.com/api/pricing");
assert.equal(configuredUmapisSource.monitorEndpointUrl, "https://www.umapis.com/api/perf-metrics/summary?period=24");
assert.equal(configuredUmapisSource.autoPublish, false);
assert.equal(configuredUmapisSource.commercialRelation, "none");
assert.equal(configuredUmapisSource.operatorType, "unknown");
assert.equal(configuredUmapisSource.invoiceSupport, "unknown");
assert.equal(Boolean(configuredUmapisSource.monitorUrl), false);
assert.ok(
  configuredUmapisSource.adminNote.includes("GPT-Pro 0.15"),
  "悠米AI中转后台备注必须保留公开读取到的 GPT-Pro 分组倍率。",
);
assert.ok(
  configuredUmapisSource.adminNote.includes("充值倍率"),
  "悠米AI中转后台备注必须列出正式上架前需要补充的充值倍率。",
);
const configuredDragonapiSource = transitSourceConfig.find((source) => source.id === "newapi-dragon3api-com");
assert.ok(configuredDragonapiSource, "DragonAPI must stay saved as an API transit draft source.");
assert.equal(configuredDragonapiSource.name, "DragonAPI");
assert.equal(configuredDragonapiSource.collectorKind, "new_api_pricing");
assert.equal(configuredDragonapiSource.stationSystem, "new_api");
assert.equal(configuredDragonapiSource.websiteUrl, "https://newapi.dragon3api.com/");
assert.equal(configuredDragonapiSource.apiBaseUrl, "https://newapi.dragon3api.com/v1");
assert.equal(configuredDragonapiSource.pricingUrl, "https://newapi.dragon3api.com/pricing");
assert.equal(configuredDragonapiSource.pricingEndpointUrl, "https://newapi.dragon3api.com/api/pricing");
assert.equal(
  configuredDragonapiSource.discoveryUrl,
  "https://newapi.dragon3api.com/.well-known/ai-transit.json",
);
assert.equal(
  configuredDragonapiSource.snapshotEndpointUrl,
  "https://newapi.dragon3api.com/api/public/transit/v1/snapshot",
);
assert.equal(configuredDragonapiSource.monitorUrl, "https://newapi.dragon3api.com/status");
assert.equal(
  configuredDragonapiSource.monitorEndpointUrl,
  "https://newapi.dragon3api.com/api/perf-metrics/summary?period=24",
);
assert.equal(configuredDragonapiSource.rechargeRatio, "1:1");
assert.equal(configuredDragonapiSource.autoPublish, false);
assert.equal(configuredDragonapiSource.commercialRelation, "none");
assert.equal(configuredDragonapiSource.operatorType, "company");
assert.equal(configuredDragonapiSource.invoiceSupport, "supported");
assert.equal(configuredDragonapiSource.refundPolicy, "可退余额，需联系客服处理。");
assert.ok(
  configuredDragonapiSource.adminNote.includes("Codex 0.045") &&
    configuredDragonapiSource.adminNote.includes("CCMax 0.75"),
  "DragonAPI 后台备注必须保留站长提交的主流模型倍率。",
);
assert.ok(
  configuredDragonapiSource.adminNote.includes("gpt-特惠 0.08") &&
    configuredDragonapiSource.adminNote.includes("claude-max 0.90"),
  "DragonAPI 后台备注必须保留公开价格与站长提交口径的差异。",
);
assert.ok(
  configuredDragonapiSource.adminNote.includes("标准 ai-transit.v1") &&
    configuredDragonapiSource.adminNote.includes("旧 schema_version=1.0 方言"),
  "DragonAPI 后台备注必须说明标准快照与旧协议方言的兼容边界。",
);
assert.ok(
  configuredDragonapiSource.adminNote.includes("autoPublish=false"),
  "DragonAPI 后台备注必须明确保持待审核草稿，不自动上前台。",
);

const configuredJuapiSource = transitSourceConfig.find((source) => source.id === "hejuapi-com");
assert.ok(configuredJuapiSource, "JuAPI must stay saved as an API transit draft source.");
assert.equal(configuredJuapiSource.name, "JuAPI");
assert.equal(configuredJuapiSource.collectorKind, "new_api_pricing");
assert.equal(configuredJuapiSource.stationSystem, "new_api");
assert.equal(configuredJuapiSource.websiteUrl, "https://www.hejuapi.com/");
assert.equal(configuredJuapiSource.apiBaseUrl, "https://www.hejuapi.com/v1");
assert.equal(configuredJuapiSource.pricingUrl, "https://www.hejuapi.com/pricing");
assert.equal(configuredJuapiSource.pricingEndpointUrl, "https://www.hejuapi.com/api/pricing");
assert.equal(configuredJuapiSource.monitorUrl, "https://www.hejuapi.com/status");
assert.equal(
  configuredJuapiSource.monitorEndpointUrl,
  "https://www.hejuapi.com/api/perf-metrics/summary?period=24",
);
assert.equal(configuredJuapiSource.autoPublish, false);
assert.equal(configuredJuapiSource.commercialRelation, "none");
assert.equal(configuredJuapiSource.operatorType, "unknown");
assert.equal(configuredJuapiSource.invoiceSupport, "unknown");
assert.equal(Boolean(configuredJuapiSource.rechargeRatio), false);
assert.ok(
  configuredJuapiSource.adminNote.includes("19 个模型") &&
    configuredJuapiSource.adminNote.includes("6 个已披露分组倍率") &&
    configuredJuapiSource.adminNote.includes("11 个站方监测项"),
  "JuAPI 后台备注必须保留公开价格与监测采集规模。",
);
assert.ok(
  configuredJuapiSource.adminNote.includes("自研Claude满血") &&
    configuredJuapiSource.adminNote.includes("充值倍率") &&
    configuredJuapiSource.adminNote.includes("autoPublish=false"),
  "JuAPI 后台备注必须保留价格口径缺口、待补资料和不自动上前台约束。",
);

const scheduledPublishedDragonapiSources = __test.selectSources(
  __test.filterSourcesByPublishedStationIds(
    transitSourceConfig,
    new Set(["newapi-dragon3api-com"]),
  ),
  { post: true },
);
assert.deepEqual(
  scheduledPublishedDragonapiSources.map((source) => source.id),
  ["newapi-dragon3api-com"],
  "DragonAPI must be eligible for scheduled pricing and monitoring refresh once published.",
);

const scheduledPublishedRtocSources = __test.selectSources(
  __test.filterSourcesByPublishedStationIds(transitSourceConfig, new Set(["ai-rtoc-cc"])),
  { post: true },
);
assert.deepEqual(
  scheduledPublishedRtocSources.map((source) => source.id),
  ["ai-rtoc-cc"],
  "RTOC AI must be eligible for the scheduled public pricing and monitoring refresh once published.",
);

const existingStations = new Map([
  ["published-new-api", { id: "published-new-api", published: true }],
  ["pending-new-api", { id: "pending-new-api", published: false }],
]);

const stations = [
  { id: "published-new-api", collection_status: "success", auto_publish: false },
  { id: "pending-new-api", collection_status: "success", auto_publish: false },
  { id: "auto-source", collection_status: "success", auto_publish: true },
  { id: "failed-published", collection_status: "failed", auto_publish: false },
];

const refreshIds = __test.collectSuccessfulRefreshStationIds(stations, existingStations, {});
assert.deepEqual([...refreshIds].sort(), ["auto-source", "published-new-api"]);

const publishRefreshIds = __test.collectSuccessfulRefreshStationIds(stations, existingStations, { publish: true });
assert.deepEqual([...publishRefreshIds].sort(), ["auto-source", "pending-new-api", "published-new-api"]);

const offers = [
  { station_id: "published-new-api", standard_model: "Claude Sonnet 4.6", group_name: "fresh" },
  { station_id: "pending-new-api", standard_model: "Claude Sonnet 4.6", group_name: "pending" },
  { station_id: "auto-source", standard_model: "GPT 5.5", group_name: "auto" },
];

const keys = __test.collectRefreshedOfferKeys(offers, refreshIds);
assert.equal(keys.get("published-new-api").has("published-new-api|Claude Sonnet 4.6|fresh"), true);
assert.equal(keys.has("pending-new-api"), false);
assert.equal(keys.get("auto-source").has("auto-source|GPT 5.5|auto"), true);

const existingOffers = new Map([
  [
    "published-new-api|Claude Sonnet 4.6|fresh",
    {
      id: "keep",
      station_id: "published-new-api",
      standard_model: "Claude Sonnet 4.6",
      group_name: "fresh",
      status: "active",
    },
  ],
  [
    "published-new-api|Claude Sonnet 4.6|stale",
    {
      id: "deactivate",
      station_id: "published-new-api",
      standard_model: "Claude Sonnet 4.6",
      group_name: "stale",
      status: "active",
    },
  ],
  [
    "pending-new-api|Claude Sonnet 4.6|old",
    {
      id: "pending-keep",
      station_id: "pending-new-api",
      standard_model: "Claude Sonnet 4.6",
      group_name: "old",
      status: "active",
    },
  ],
]);

assert.deepEqual(__test.findStaleRefreshedOfferIds(existingOffers, keys), ["deactivate"]);

assert.deepEqual(
  __test.dedupeRowsById([
    { id: "sample-1", ok: false },
    { id: "sample-1", ok: true },
    { id: "sample-2", ok: true },
  ]),
  [
    { id: "sample-1", ok: true },
    { id: "sample-2", ok: true },
  ],
);

existingOffers.set("published-new-api|GPT 5.5|priceai-probe", {
  id: "keep-priceai-probe",
  station_id: "published-new-api",
  standard_model: "GPT 5.5",
  group_name: "priceai-probe",
  status: "active",
  availability_source_type: "priceai_probe",
});
assert.deepEqual(__test.findStaleRefreshedOfferIds(existingOffers, keys), ["deactivate", "keep-priceai-probe"]);

assert.equal(
  __test.mergeOfferForRefresh(
    { id: "new", auto_publish: false, status: "needs_review", created_at: "new" },
    { id: "old", status: "active", created_at: "old" },
    true,
  ).status,
  "active",
);

const publicStatusPreferredStation = __test.mergeStationForRefresh(
  {
    id: "published-new-api",
    auto_publish: true,
    collection_status: "success",
    availability_seven_day_rate: 0.8,
    availability_seven_day_samples: 10,
    availability_source_type: "public_status",
    availability_source_label: "公开监测页",
    created_at: "incoming",
  },
  {
    id: "published-new-api",
    published: true,
    availability_seven_day_rate: 0.95,
    availability_seven_day_samples: 50,
    availability_source_type: "priceai_probe",
    availability_source_label: "PriceAI 实测",
    created_at: "existing",
  },
  {},
);
assert.equal(publicStatusPreferredStation.availability_source_type, "public_status");
assert.equal(publicStatusPreferredStation.availability_seven_day_rate, 0.8);
assert.equal(publicStatusPreferredStation.availability_seven_day_samples, 10);

assert.equal(
  __test.mergeOfferForRefresh(
    { id: "new", auto_publish: false, status: "needs_review", created_at: "new" },
    undefined,
    false,
  ).status,
  "needs_review",
);

const staleUnknownAvailabilityOffer = __test.mergeOfferForRefresh(
  {
    id: "new",
    auto_publish: false,
    status: "active",
    created_at: "new",
    availability_source_type: "unknown",
    availability_seven_day_rate: 0.6081,
    availability_seven_day_samples: 148,
    availability_first_checked_at: "2026-06-29T00:00:00.000Z",
    availability_last_checked_at: "2026-07-03T00:00:00.000Z",
    availability_note: "PriceAI API Key 探测：近 7 日 GPT 5.5 90/148 个样本成功。",
  },
  undefined,
  true,
);
assert.equal(staleUnknownAvailabilityOffer.availability_seven_day_rate, null);
assert.equal(staleUnknownAvailabilityOffer.availability_seven_day_samples, 0);
assert.equal(staleUnknownAvailabilityOffer.availability_first_checked_at, null);
assert.equal(staleUnknownAvailabilityOffer.availability_last_checked_at, null);
assert.equal(staleUnknownAvailabilityOffer.availability_note, "价格已抓取，尚未运行 API 可用性检测。");

const preservedTrustedAvailabilityOffer = __test.mergeOfferForRefresh(
  {
    id: "new",
    auto_publish: false,
    status: "active",
    created_at: "new",
    availability_source_type: "unknown",
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_note: "价格已抓取，尚未运行 API 可用性检测。",
  },
  {
    id: "old",
    status: "active",
    created_at: "old",
    availability_source_type: "priceai_probe",
    availability_source_label: "PriceAI 实测",
    availability_seven_day_rate: 0.98,
    availability_seven_day_samples: 50,
    availability_first_checked_at: "2026-07-01T00:00:00.000Z",
    availability_last_checked_at: "2026-07-03T00:00:00.000Z",
    availability_note: "PriceAI API Key 探测：近 7 日 GPT 5.5 49/50 个样本成功。",
  },
  true,
);
assert.equal(preservedTrustedAvailabilityOffer.availability_source_type, "priceai_probe");
assert.equal(preservedTrustedAvailabilityOffer.availability_seven_day_rate, 0.98);
assert.equal(preservedTrustedAvailabilityOffer.availability_seven_day_samples, 50);

const preservedRicherAvailabilityOffer = __test.mergeOfferForRefresh(
  {
    id: "new",
    auto_publish: true,
    status: "active",
    created_at: "new",
    cache_hit_rate: 0,
    cache_hit_sample_tokens: 0,
    availability_source_type: "public_model_catalog",
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_note: "ai-transit 公开快照已返回价格；该模型暂无公开监测样本，非 PriceAI API Key 实测。",
  },
  {
    id: "old",
    status: "active",
    created_at: "old",
    cache_hit_rate: 0.42,
    cache_hit_sample_tokens: 2000,
    availability_source_type: "public_status",
    availability_source_label: "公开监测页",
    availability_seven_day_rate: 0.75,
    availability_seven_day_samples: 8,
    availability_first_checked_at: "2026-07-01T00:00:00.000Z",
    availability_last_checked_at: "2026-07-03T00:00:00.000Z",
    availability_note: "旧公开监测样本。",
  },
  true,
);
assert.equal(preservedRicherAvailabilityOffer.availability_source_type, "public_status");
assert.equal(preservedRicherAvailabilityOffer.availability_seven_day_rate, 0.75);
assert.equal(preservedRicherAvailabilityOffer.cache_hit_rate, 0.42);
assert.equal(preservedRicherAvailabilityOffer.cache_hit_sample_tokens, 2000);

const clearedRemovedPublicStatusOffer = __test.mergeOfferForRefresh(
  {
    id: "new",
    station_id: "zivv-pro",
    standard_model: "Claude Sonnet 4.6",
    group_name: "Claude Anti【目前不稳定】",
    auto_publish: true,
    status: "active",
    created_at: "new",
    availability_source_type: "public_status",
    availability_source_label: "公开监测页",
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_first_checked_at: null,
    availability_last_checked_at: null,
    availability_note: "Zivv 公开状态页未返回 Claude Sonnet 4.6 / Claude Anti【目前不稳定】 的服务监测；暂显示样本不足。",
  },
  {
    id: "old",
    station_id: "zivv-pro",
    standard_model: "Claude Sonnet 4.6",
    group_name: "Claude Anti【目前不稳定】",
    status: "active",
    created_at: "old",
    availability_source_type: "public_status",
    availability_source_label: "公开监测页",
    availability_seven_day_rate: 0.737469,
    availability_seven_day_samples: 120,
    availability_first_checked_at: "2026-06-28T15:23:04.168617+00:00",
    availability_last_checked_at: "2026-07-05T14:01:46.184092+00:00",
    availability_note: "Zivv 公开状态页 7 日服务监测：Antigravity Claude，页面 uptime 73.75%，历史点 120 个；当前异常。",
  },
  true,
);
assert.equal(clearedRemovedPublicStatusOffer.availability_source_type, "public_status");
assert.equal(clearedRemovedPublicStatusOffer.availability_seven_day_rate, null);
assert.equal(clearedRemovedPublicStatusOffer.availability_seven_day_samples, 0);
assert.equal(clearedRemovedPublicStatusOffer.availability_first_checked_at, null);
assert.equal(clearedRemovedPublicStatusOffer.availability_last_checked_at, null);

const incomingPublicStatusBeatsEmptyProbeOffer = __test.mergeOfferForRefresh(
  {
    id: "new",
    auto_publish: true,
    status: "active",
    created_at: "new",
    availability_source_type: "public_status",
    availability_source_label: "公开监测页",
    availability_seven_day_rate: 1,
    availability_seven_day_samples: 1,
    availability_last_checked_at: "2026-07-07T09:38:10.000Z",
    availability_note: "ai-transit 公开监测样本。",
  },
  {
    id: "old",
    status: "active",
    created_at: "old",
    availability_source_type: "priceai_probe",
    availability_source_label: "PriceAI 实测",
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_note: "暂无 PriceAI API Key 可用性探测样本。",
  },
  true,
);
assert.equal(incomingPublicStatusBeatsEmptyProbeOffer.availability_source_type, "public_status");
assert.equal(incomingPublicStatusBeatsEmptyProbeOffer.availability_seven_day_samples, 1);

const refreshedAiTransitStation = __test.mergeStationForRefresh(
  {
    id: "aliuapi-top",
    name: "A6-API",
    auto_publish: true,
    published: true,
    collection_status: "success",
    collector_kind: "ai_transit_snapshot",
    summary: "A6-API 使用 Sub2API 系统，公开 ai-transit.v1 快照可读取模型价格和缓存命中率。",
    created_at: "new",
  },
  {
    id: "aliuapi-top",
    published: false,
    summary: "登录和分组接口启用 Turnstile，需要人工通过校验后才能采集分组倍率。",
    created_at: "old",
  },
  {},
);
assert.match(refreshedAiTransitStation.summary, /公开 ai-transit\.v1 快照/);

const removedAutoPublishStation = __test.mergeStationForRefresh(
  {
    id: "removed-auto-source",
    status: "active",
    auto_publish: true,
    published: true,
    collection_status: "success",
    data_status: "verified",
    usage_advice: "try_small",
    admin_note: "自动采集成功。",
    created_at: "new",
  },
  {
    id: "removed-auto-source",
    status: "unknown",
    published: false,
    removed_at: "2026-07-20T08:19:16.327Z",
    removed_reason: "后台移除",
    data_status: "pending_review",
    usage_advice: "pending",
    admin_note: "后台移除",
    created_at: "old",
  },
  { publish: true },
);
assert.equal(removedAutoPublishStation.published, false);
assert.equal(removedAutoPublishStation.status, "unknown");
assert.equal(removedAutoPublishStation.data_status, "pending_review");
assert.equal(removedAutoPublishStation.usage_advice, "pending");
assert.equal(removedAutoPublishStation.admin_note, "后台移除");

const removedStateWriteCalls = [];
const removedStateSupabase = {
  from(table) {
    const call = { table };
    removedStateWriteCalls.push(call);
    return {
      update(patch) {
        call.patch = patch;
        return this;
      },
      in(column, values) {
        call.idFilter = { column, values };
        return this;
      },
      async not(column, operator, value) {
        call.removedFilter = { column, operator, value };
        return { error: null };
      },
    };
  },
};
await __test.enforceRemovedStationStateAfterUpsert(removedStateSupabase, ["removed-auto-source"]);
assert.deepEqual(removedStateWriteCalls, [{
  table: "api_transit_stations",
  patch: {
    published: false,
    status: "unknown",
    data_status: "pending_review",
    usage_advice: "pending",
  },
  idFilter: { column: "id", values: ["removed-auto-source"] },
  removedFilter: { column: "removed_at", operator: "is", value: null },
}]);

const preservedManualStationSummary = __test.mergeStationForRefresh(
  {
    id: "manual-summary",
    auto_publish: true,
    published: true,
    collection_status: "success",
    collector_kind: "ai_transit_snapshot",
    summary: "公开快照简介。",
    created_at: "new",
  },
  {
    id: "manual-summary",
    published: true,
    summary: "站长已补充人工说明，保留该说明。",
    created_at: "old",
  },
  {},
);
assert.equal(preservedManualStationSummary.summary, "站长已补充人工说明，保留该说明。");

const preservedManualStationLabels = __test.mergeStationForRefresh(
  {
    id: "manual-labels",
    auto_publish: true,
    published: true,
    collection_status: "success",
    channel_types: ["first_party_pool", "reverse_engineered"],
    account_pools: ["plus", "kiro"],
    risk_labels: ["insufficient_samples", "third_party_aggregate"],
    created_at: "new",
  },
  {
    id: "manual-labels",
    published: true,
    channel_types: [],
    account_pools: [],
    risk_labels: [],
    created_at: "old",
  },
  {},
);
assert.deepEqual(preservedManualStationLabels.channel_types, []);
assert.deepEqual(preservedManualStationLabels.account_pools, []);
assert.deepEqual(preservedManualStationLabels.risk_labels, []);

const preservedNonEmptyManualStationLabels = __test.mergeStationForRefresh(
  {
    id: "manual-non-empty-labels",
    auto_publish: true,
    published: true,
    collection_status: "success",
    channel_types: ["first_party_pool", "reverse_engineered"],
    account_pools: ["plus", "kiro"],
    risk_labels: ["insufficient_samples", "third_party_aggregate"],
    created_at: "new",
  },
  {
    id: "manual-non-empty-labels",
    published: true,
    channel_types: ["official_api"],
    account_pools: ["official_api"],
    risk_labels: ["reseller"],
    created_at: "old",
  },
  {},
);
assert.deepEqual(preservedNonEmptyManualStationLabels.channel_types, ["official_api"]);
assert.deepEqual(preservedNonEmptyManualStationLabels.account_pools, ["official_api"]);
assert.deepEqual(preservedNonEmptyManualStationLabels.risk_labels, ["reseller"]);

const failedRefreshPreservesPublishedStationState = __test.mergeStationForRefresh(
  {
    id: "wawazz-xyz",
    status: "unknown",
    auto_publish: false,
    published: false,
    collection_status: "failed",
    collection_error: "HTTP 502",
    data_status: "pending_review",
    admin_note: "自动抓取未识别到 MVP 模型，待人工确认。",
    created_at: "new",
  },
  {
    id: "wawazz-xyz",
    status: "active",
    published: true,
    data_status: "verified",
    admin_note: "上一轮成功采集。",
    created_at: "old",
  },
  {},
);
assert.equal(failedRefreshPreservesPublishedStationState.status, "active");
assert.equal(failedRefreshPreservesPublishedStationState.published, true);
assert.equal(failedRefreshPreservesPublishedStationState.data_status, "verified");
assert.equal(failedRefreshPreservesPublishedStationState.collection_status, "failed");
assert.equal(failedRefreshPreservesPublishedStationState.collection_error, "HTTP 502");
assert.equal(failedRefreshPreservesPublishedStationState.admin_note, "上一轮成功采集。");

const sources = [
  { id: "published-new-api" },
  { id: "pending-new-api" },
  { id: "removed-new-api" },
];
assert.deepEqual(
  __test.filterSourcesByPublishedStationIds(sources, new Set(["published-new-api"])),
  [{ id: "published-new-api" }],
);

assert.equal(__test.shouldRestrictToPublishedStations({ post: true }), true);
assert.equal(__test.shouldRestrictToPublishedStations({ post: true, source: "pending-new-api" }), false);
assert.equal(__test.shouldRestrictToPublishedStations({ post: true, publish: true }), false);
assert.equal(__test.shouldRestrictToPublishedStations({ post: true, dryRun: true }), false);
const customAdminNoteParsedStation = __test.parsePricingPayload(
  {
    id: "custom-admin-note",
    name: "Custom Admin Note",
    websiteUrl: "https://example.com/",
    apiBaseUrl: "https://example.com/v1",
    pricingUrl: "https://example.com/pricing",
    pricingEndpointUrl: "https://example.com/api/pricing",
    collectorKind: "new_api_pricing",
    adminNote: "保留来源配置中的人工备注。",
  },
  {
    data: [
      {
        model_name: "gpt-5.5",
        model_ratio: 1,
        completion_ratio: 2,
        enable_groups: ["pro"],
      },
    ],
    group_ratio: { pro: 0.2 },
  },
  "2026-07-12T05:23:00.000Z",
).station;
assert.equal(customAdminNoteParsedStation.admin_note, "保留来源配置中的人工备注。");
assert.equal(customAdminNoteParsedStation.published, false);

const explicitMissingGroupRatioRows = __test.parsePricingPayload(
  {
    id: "explicit-missing-group-ratio",
    name: "Explicit Missing Group Ratio",
    websiteUrl: "https://example.com/",
    apiBaseUrl: "https://example.com/v1",
    pricingUrl: "https://example.com/pricing",
    pricingEndpointUrl: "https://example.com/api/pricing",
    collectorKind: "new_api_pricing",
    rechargeRatio: "1:1",
  },
  {
    data: [
      {
        model_name: "gpt-5.5",
        model_ratio: 1,
        completion_ratio: 2,
        enable_groups: ["gpt-plus", "plus"],
      },
    ],
    group_ratio: { "gpt-plus": 0.08 },
  },
  "2026-07-28T00:00:00.000Z",
);
assert.deepEqual(explicitMissingGroupRatioRows.offers.map((offer) => offer.group_name), ["gpt-plus"]);
assert.equal(explicitMissingGroupRatioRows.offers[0].raw_payload.group.groupRatio, 0.08);

const legacyImplicitGroupRatioRows = __test.parsePricingPayload(
  {
    id: "legacy-implicit-group-ratio",
    name: "Legacy Implicit Group Ratio",
    websiteUrl: "https://example.com/",
    apiBaseUrl: "https://example.com/v1",
    pricingUrl: "https://example.com/pricing",
    pricingEndpointUrl: "https://example.com/api/pricing",
    collectorKind: "new_api_pricing",
  },
  {
    data: [
      {
        model_name: "gpt-5.5",
        model_ratio: 1,
        completion_ratio: 2,
        enable_groups: ["default"],
      },
    ],
  },
  "2026-07-28T00:00:00.000Z",
);
assert.equal(legacyImplicitGroupRatioRows.offers.length, 1);
assert.equal(legacyImplicitGroupRatioRows.offers[0].raw_payload.group.groupRatio, null);
assert.equal(__test.standardizeModelName("anthropic/claude-sonnet-5"), "Claude Sonnet 5");
assert.equal(__test.standardizeModelName("Claude Sonnet 5"), "Claude Sonnet 5");
assert.equal(__test.standardizeModelName("claude-sonnet-5-0"), "Claude Sonnet 5");
assert.equal(__test.standardizeModelName("anthropic/claude-fable-5"), "Claude Fable 5");
assert.equal(__test.standardizeModelName("Claude Fable 5"), "Claude Fable 5");
assert.equal(__test.standardizeModelName("claude-fable-5-0"), "Claude Fable 5");
assert.equal(__test.standardizeModelName("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
assert.equal(__test.standardizeModelName("anthropic/claude-opus-5"), "Claude Opus 5");
assert.equal(__test.standardizeModelName("claude-opus-5-20260724"), "Claude Opus 5");
assert.equal(__test.standardizeModelName("claude-5-opus"), "Claude Opus 5");
assert.equal(__test.standardizeModelName("claude-opus-50"), null);
assert.equal(__test.standardizeModelName("claude-opus-4-5-20251101"), "Claude Opus 4.5");
assert.equal(__test.standardizeModelName("claude-sonnet-4-5-20250929-thinking"), "Claude Sonnet 4.5");
assert.equal(__test.standardizeModelName("openai/gpt-image-2"), "GPT Image 2");
assert.equal(__test.standardizeModelName("google/gemini-3-pro-image-preview"), "Nano Banana Pro");
assert.equal(__test.standardizeModelName("google/gemini-3.1-flash-lite-image"), "Nano Banana Lite");
assert.equal(__test.standardizeModelName("google/gemini-3.1-flash-image-preview"), "Nano Banana 2");
assert.equal(__test.standardizeModelName("google/gemini-2.5-flash-image"), "Nano Banana");
assert.equal(__test.standardizeModelName("google/nano-banana-pro"), "Nano Banana Pro");
assert.equal(__test.standardizeModelName("google/nano-banana-2"), "Nano Banana 2");
assert.equal(__test.standardizeModelName("google/nano-banana"), "Nano Banana");
assert.equal(__test.standardizeModelName("google/nano-banana-lite"), "Nano Banana Lite");
assert.equal(__test.standardizeModelName("openai/sora-2-pro"), "Sora 2 Pro");
assert.equal(__test.standardizeModelName("openai/sora-2"), "Sora 2");
assert.equal(__test.standardizeModelName("codex-auto-review"), "Codex Compact");
assert.equal(__test.standardizeModelName("grok-4.20-multi-agent-xhigh"), "Grok 4.20");
assert.equal(__test.standardizeModelName("grok-4.3-medium"), "Grok 4.3");
assert.equal(__test.standardizeModelName("grok-build-console"), "Grok Build");
assert.equal(__test.standardizeModelName("xai/grok-4.5-latest"), "Grok 4.5");
assert.equal(__test.standardizeModelName("xai/composer-2.5"), "Composer 2.5");
assert.equal(__test.standardizeModelName("xai/grok-composer-2.5-fast"), "Composer 2.5");
assert.equal(__test.standardizeModelName("xai/grok-imagine"), "Grok Image");
assert.equal(__test.standardizeModelName("xai/grok-imagine-edit"), "Grok Image");
assert.equal(__test.standardizeModelName("xai/grok-imagine-image"), "Grok Image");
assert.equal(__test.standardizeModelName("xai/grok-imagine-image-quality"), "Grok Image");
assert.equal(__test.standardizeModelName("xai/grok-imagine-video-1.5-preview"), "Grok Video");
assert.equal(__test.standardizeModelName("google/veo-3.1-lite"), "Veo 3.1 Lite");
assert.equal(__test.standardizeModelName("google/veo-3.1"), "Veo 3.1");
assert.equal(__test.standardizeModelName("google/gemini-omni-flash"), "Gemini Omni Flash");
assert.equal(__test.standardizeModelName("volcengine/video-ds-2.0"), "Seedance 2.0");
assert.equal(__test.standardizeModelName("bytedance/seedance-2.0"), "Seedance 2.0");
assert.equal(__test.standardizeModelName("alibaba/hh1.1-i2v"), "HappyHorse 1.1 I2V");
assert.equal(__test.standardizeModelName("happyhorse-1.1-i2v"), "HappyHorse 1.1 I2V");
assert.equal(__test.standardizeModelName("Happy House 1.1 I2V"), "HappyHorse 1.1 I2V");
assert.equal(__test.standardizeModelName("kling/kling-2.5-turbo"), "Kling 2.5 Turbo");
assert.equal(__test.standardizeModelName("moonshot/kimi-k3"), "Kimi K3");
assert.equal(__test.standardizeModelName("qwen3.8-max-preview"), "Qwen3.8-Max-Preview");
assert.equal(__test.standardizeModelName("千问 3.8 Max Preview"), "Qwen3.8-Max-Preview");
assert.equal(__test.standardizeModelName("qwen3.8-plus"), null);
assert.equal(__test.standardizeModelName("qwen/qwen3.7-max-2026-06-08"), "Qwen3.7-Max");
assert.equal(__test.standardizeModelName("qwen3.7-plus"), null);
assert.deepEqual(
  __test.clearUnpricedPreviewModelRates({
    standard_model: "Qwen3.8-Max-Preview",
    model_multiplier: 0.2,
    input_price: 0.2,
    output_price: 0.4,
    cache_read_price: 0.1,
    cache_write_price: null,
    raw_payload: { source: "test" },
  }),
  {
    standard_model: "Qwen3.8-Max-Preview",
    model_multiplier: null,
    input_price: null,
    output_price: null,
    cache_read_price: null,
    cache_write_price: null,
    raw_payload: {
      source: "test",
      priceai_unpriced_preview: {
        observed_model_multiplier: 0.2,
        observed_input_price: 0.2,
        observed_output_price: 0.4,
        observed_cache_read_price: 0.1,
        reason: "official_payg_price_unavailable",
      },
    },
  },
);
assert.equal(__test.standardizeModelName("claude-3-5-sonnet-20241022"), null);
assert.equal(__test.standardizeModelName("openai/gpt-5.6"), "GPT 5.6 Sol");
assert.equal(__test.standardizeModelName("openai/gpt-5.6-sol"), "GPT 5.6 Sol");
assert.equal(__test.standardizeModelName("openai/gpt-5.6-terra"), "GPT 5.6 Terra");
assert.equal(__test.standardizeModelName("openai/gpt-5.6-luna"), "GPT 5.6 Luna");
assert.equal(__test.standardizeModelName("openai/gpt-5.6-mini"), null);
assert.equal(__test.standardizeModelName("gpt-5.4-mini"), "GPT 5.4 Mini");
assert.equal(__test.standardizeModelName("gpt-5.4-nano"), null);

const fixedPricePayload = {
  data: [
    {
      model_name: "google/gemini-2.5-flash-image",
      quota_type: 1,
      model_ratio: 0,
      model_price: 0.04,
      enable_groups: ["default"],
    },
    {
      model_name: "openai/sora-2",
      quota_type: 1,
      model_ratio: 0,
      model_price: 0.1,
      enable_groups: ["default"],
    },
    {
      model_name: "openai/gpt-image-2",
      quota_type: 1,
      model_ratio: 0,
      model_price: 0.25,
      enable_groups: ["default"],
    },
    {
      model_name: "xai/grok-imagine-image",
      quota_type: 1,
      model_ratio: 0,
      model_price: 0.03,
      enable_groups: ["default"],
    },
    {
      model_name: "xai/grok-imagine-video",
      quota_type: 1,
      model_ratio: 0,
      model_price: 0.12,
      enable_groups: ["default"],
    },
  ],
  group_ratio: { default: 1 },
};
const fixedPriceRows = __test.parsePricingPayload(
  {
    id: "fixed-price-new-api",
    slug: "fixed-price-new-api",
    name: "Fixed Price New API",
    websiteUrl: "https://example.test",
    pricingEndpointUrl: "https://example.test/api/pricing",
    collectorKind: "new_api_pricing",
  },
  fixedPricePayload,
  "2026-07-02T00:00:00.000Z",
);
const fixedOffersByModel = new Map(fixedPriceRows.offers.map((offer) => [offer.standard_model, offer]));
assert.equal(fixedOffersByModel.get("Nano Banana").billing_mode, "fixed");
assert.equal(fixedOffersByModel.get("Nano Banana").model_multiplier, null);
assert.equal(fixedOffersByModel.get("Nano Banana").image_output_price, null);
assert.equal(fixedOffersByModel.get("Nano Banana").fixed_price, 0.04);
assert.equal(fixedOffersByModel.get("Sora 2").model_multiplier, null);
assert.equal(fixedOffersByModel.get("Sora 2").fixed_price, 0.1);
assert.equal(fixedOffersByModel.get("GPT Image 2").model_multiplier, null);
assert.equal(fixedOffersByModel.get("GPT Image 2").image_output_price, null);
assert.equal(fixedOffersByModel.get("GPT Image 2").fixed_price, 0.25);
assert.equal(fixedOffersByModel.get("GPT Image 2").raw_payload.fixed_price, 0.25);
assert.equal(fixedOffersByModel.get("Grok Image").family, "grok");
assert.equal(fixedOffersByModel.get("Grok Image").model_multiplier, null);
assert.equal(fixedOffersByModel.get("Grok Image").fixed_price, 0.03);
assert.equal(fixedOffersByModel.get("Grok Video").family, "grok");
assert.equal(fixedOffersByModel.get("Grok Video").model_multiplier, null);
assert.equal(fixedOffersByModel.get("Grok Video").fixed_price, 0.12);

const legacyNewApiPerformanceSource = {
  ...configuredRtocSource,
  collectorKind: "new_api_pricing",
  pricingUrl: "https://ai.rtoc.cc/pricing",
  pricingEndpointUrl: "https://api.rtoc.cc/api/pricing",
  monitorUrl: "https://ai.rtoc.cc/pricing",
  monitorEndpointUrl: "https://api.rtoc.cc/api/perf-metrics/summary?period=24",
};
const legacyNewApiParsed = __test.parsePricingPayload(
  legacyNewApiPerformanceSource,
  {
    data: [
      {
        model_name: "gpt-5.5",
        model_ratio: 2.5,
        completion_ratio: 6,
        enable_groups: ["GPT", "GPT Pro"],
      },
      {
        model_name: "claude-sonnet-4-6",
        model_ratio: 1.5,
        completion_ratio: 5,
        enable_groups: ["Claude"],
      },
    ],
    group_ratio: {
      GPT: 0.06,
      "GPT Pro": 0.2,
      Claude: 1.32,
    },
  },
  "2026-07-02T14:00:00.000Z",
);
__test.applyNewApiPerformanceSummaryAvailability(
  legacyNewApiPerformanceSource,
  legacyNewApiParsed,
  {
    data: {
      models: [
        {
          model_name: "gpt-5.5",
          success_rate: 97.61,
          avg_latency_ms: 17522,
          avg_tps: 38.64,
          recent_success_rates: [99.83, 100, 100],
        },
        {
          model_name: "claude-sonnet-4-6",
          success_rate: 97.27,
          avg_latency_ms: 8438,
          avg_tps: 64.94,
          recent_success_rates: [100, 100, 50],
        },
      ],
    },
  },
  "2026-07-02T14:00:00.000Z",
);
const legacyNewApiGptOffer = legacyNewApiParsed.offers.find((offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "GPT");
assert.equal(legacyNewApiGptOffer.availability_seven_day_rate, 0.9761);
assert.equal(legacyNewApiGptOffer.availability_seven_day_samples, 3);
assert.equal(legacyNewApiGptOffer.availability_source_type, "public_status");
assert.equal(legacyNewApiGptOffer.availability_source_url, "https://ai.rtoc.cc/pricing");
assert.match(legacyNewApiGptOffer.availability_note, /performance summary 近 24 小时/);
assert.equal(legacyNewApiParsed.station.availability_seven_day_rate, 0.9744);
assert.equal(legacyNewApiParsed.station.availability_seven_day_samples, 6);
assert.match(legacyNewApiParsed.station.availability_note, /2 个标准模型/);

const dragonPrimaryPricingFixture = {
  data: [
    {
      model_name: "gpt-5.5",
      model_ratio: 2.5,
      completion_ratio: 6,
      model_price: 0,
      cache_ratio: 0.1,
      create_cache_ratio: 1.25,
      enable_groups: ["gpt-plus", "gpt-pro"],
      supported_endpoint_types: ["openai"],
    },
  ],
  group_ratio: {
    "gpt-plus": 0.12,
    "gpt-pro": 0.2,
  },
};
const dragonTransitSnapshotFixture = {
  schema_version: "1.0",
  generated_at: "2026-08-03T05:50:02Z",
  site: {
    name: "Dragon3 API",
    url: "https://newapi.dragon3api.com",
    system: "new-api",
  },
  channel_source: {
    type: "self_hosted",
    label: "自建",
  },
  groups: {
    "gpt-plus": { ratio: 0.12, source: "self_hosted", model_count: 1 },
    "gpt-pro": { ratio: 0.2, source: "self_hosted", model_count: 1 },
  },
  models: [
    {
      name: "gpt-5.5",
      vendor: "OpenAI",
      billing_type: "per_token",
      model_ratio: 2.5,
      completion_ratio: 6,
      model_price: 0,
      cache_read_ratio: 0.1,
      cache_write_ratio: 1.25,
      groups: ["gpt-plus", "gpt-pro"],
      endpoint_types: ["openai"],
    },
  ],
  monitoring: {
    window_hours: 24,
    source: "real_traffic_aggregation",
    models: {
      "gpt-5.5": {
        requests: 1000,
        success_rate: 0.95,
        avg_latency_ms: 28000,
        avg_ttft_ms: 13000,
        by_group: {
          "gpt-plus": { requests: 700, success_rate: 0.98 },
          "gpt-pro": { requests: 300, success_rate: 0.999 },
        },
      },
      "gpt-5.5-openai-compact": {
        requests: 10,
        success_rate: 0.1,
        avg_latency_ms: 1000,
        avg_ttft_ms: null,
        by_group: {
          "gpt-plus": { requests: 10, success_rate: 0.1 },
        },
      },
    },
  },
};
const adaptedDragonTransitSnapshot = __test.adaptNewApiTransitSnapshot(dragonTransitSnapshotFixture);
assert.equal(adaptedDragonTransitSnapshot.schemaVersion, "1.0");
assert.equal(adaptedDragonTransitSnapshot.pricing.data.length, 1);
assert.equal(adaptedDragonTransitSnapshot.pricing.group_ratio["gpt-plus"], 0.12);
assert.equal(adaptedDragonTransitSnapshot.pricing.data[0].cache_ratio, 0.1);
assert.equal(adaptedDragonTransitSnapshot.pricing.data[0].create_cache_ratio, 1.25);
const matchingDragonSnapshot = __test.compareNewApiPricingWithTransitSnapshot(
  dragonPrimaryPricingFixture,
  adaptedDragonTransitSnapshot.pricing,
);
assert.equal(matchingDragonSnapshot.status, "match");
assert.equal(matchingDragonSnapshot.mismatchCount, 0);
const mismatchedDragonSnapshot = __test.compareNewApiPricingWithTransitSnapshot(
  dragonPrimaryPricingFixture,
  {
    ...adaptedDragonTransitSnapshot.pricing,
    group_ratio: { ...adaptedDragonTransitSnapshot.pricing.group_ratio, "gpt-plus": 0.13 },
  },
);
assert.equal(mismatchedDragonSnapshot.status, "mismatch");
assert.ok(mismatchedDragonSnapshot.mismatches.some((message) => message.includes("gpt-plus")));
const refreshWindowDriftSnapshot = __test.compareNewApiPricingWithTransitSnapshot(
  dragonPrimaryPricingFixture,
  {
    ...adaptedDragonTransitSnapshot.pricing,
    data: [
      ...adaptedDragonTransitSnapshot.pricing.data,
      {
        ...adaptedDragonTransitSnapshot.pricing.data[0],
        model_name: "snapshot-refresh-window-model",
      },
    ],
  },
);
assert.equal(refreshWindowDriftSnapshot.status, "mismatch");
assert.equal(refreshWindowDriftSnapshot.primaryModelCount, 1);
assert.equal(refreshWindowDriftSnapshot.snapshotModelCount, 2);
assert.ok(refreshWindowDriftSnapshot.mismatches.some((message) => message.includes("模型数量不一致")));

const dragonPricingParsed = __test.parsePricingPayload(
  configuredDragonapiSource,
  dragonPrimaryPricingFixture,
  "2026-08-03T05:50:02Z",
);
assert.equal(dragonPricingParsed.offers.length, 2);
__test.applyNewApiTransitSnapshotAvailability(
  configuredDragonapiSource,
  dragonPricingParsed,
  adaptedDragonTransitSnapshot,
  "2026-08-03T05:50:02Z",
);
const dragonPlusOffer = dragonPricingParsed.offers.find((offer) => offer.group_name === "gpt-plus");
assert.equal(dragonPlusOffer.availability_seven_day_rate, 0.98);
assert.equal(dragonPlusOffer.availability_seven_day_samples, 1);
assert.equal(dragonPlusOffer.availability_match_level, "exact");
assert.equal(dragonPlusOffer.availability_source_label, "公开 transit 快照");
assert.equal(dragonPlusOffer.availability_source_url, configuredDragonapiSource.snapshotEndpointUrl);
assert.equal(dragonPlusOffer.raw_payload.supplemental_transit_snapshot.requests, 700);
assert.match(dragonPlusOffer.availability_note, /聚合值按 1 个公开状态样本记录/);

const canonicalDragonTransitSnapshotFixture = {
  schema_version: "ai-transit.v1",
  system: "new-api",
  generated_at: "2026-08-07T10:15:00Z",
  billing: {
    recharge_ratio: "1 CNY = 1 USD credit",
    recharge_multiplier: 1,
  },
  disclosure: {
    upstream_type: "self_hosted",
    account_pool_type: "self_hosted",
  },
  groups: [
    {
      name: "gpt-plus",
      rate_multiplier: 0.12,
      cache_usage: {
        last_7d: {
          input_tokens: 100,
          cache_creation_tokens: 100,
          cache_read_tokens: 800,
          cache_hit_rate: 80,
        },
      },
      models: [
        {
          standard_model: "gpt-5.5",
          raw_model: "gpt-5.5",
          price: {
            input_usd_per_token: 0.0000006,
            output_usd_per_token: 0.0000036,
          },
          source: {
            upstream_type: "self_hosted",
            account_pool_type: "self_hosted",
          },
        },
      ],
    },
    {
      name: "gpt-pro",
      rate_multiplier: 0.2,
      models: [
        {
          standard_model: "gpt-5.5",
          raw_model: "gpt-5.5",
          price: {
            input_usd_per_token: 0.000001,
            output_usd_per_token: 0.000006,
          },
          source: {
            upstream_type: "self_hosted",
            account_pool_type: "self_hosted",
          },
        },
      ],
    },
  ],
  monitoring: [
    {
      name: "gpt-plus",
      group_name: "gpt-plus",
      primary_model: "gpt-5.5",
      primary_status: "operational",
      availability_7d: 0.98,
      sample_count_7d: 60,
      latest_latency_ms: 18000,
      avg_latency_7d_ms: 17000,
      last_checked_at: "2026-08-07T10:14:00Z",
      timeline: [
        { status: "operational", checked_at: "2026-08-07T10:13:00Z", latency_ms: 16000 },
        { status: "operational", checked_at: "2026-08-07T10:14:00Z", latency_ms: 18000 },
      ],
    },
    {
      name: "gpt-pro",
      group_name: "gpt-pro",
      primary_model: "gpt-5.5",
      primary_status: "operational",
      availability_7d: 0.999,
      sample_count_7d: 60,
      latest_latency_ms: 19000,
      avg_latency_7d_ms: 18000,
      last_checked_at: "2026-08-07T10:14:00Z",
      timeline: [
        { status: "operational", checked_at: "2026-08-07T10:13:00Z", latency_ms: 17000 },
        { status: "operational", checked_at: "2026-08-07T10:14:00Z", latency_ms: 19000 },
      ],
    },
  ],
  completeness: {
    warnings: [],
  },
};
const canonicalDragonParsed = __test.parsePricingPayload(
  configuredDragonapiSource,
  dragonPrimaryPricingFixture,
  "2026-08-07T10:15:00Z",
);
const canonicalDragonConsistency = __test.applyNewApiSupplementalSnapshot(
  configuredDragonapiSource,
  canonicalDragonParsed,
  dragonPrimaryPricingFixture,
  canonicalDragonTransitSnapshotFixture,
  "2026-08-07T10:15:00Z",
);
assert.equal(canonicalDragonConsistency.status, "match");
assert.equal(canonicalDragonConsistency.comparisonMode, "ai_transit_v1_catalog");
assert.equal(canonicalDragonConsistency.primaryModelCount, 1);
assert.equal(canonicalDragonConsistency.snapshotModelCount, 1);
const canonicalDragonPlusOffer = canonicalDragonParsed.offers.find((offer) => offer.group_name === "gpt-plus");
assert.equal(canonicalDragonPlusOffer.availability_seven_day_rate, 0.98);
assert.equal(canonicalDragonPlusOffer.availability_seven_day_samples, 60);
assert.equal(canonicalDragonPlusOffer.availability_match_level, "exact");
assert.equal(canonicalDragonPlusOffer.channel_type, "first_party_pool");
assert.equal(canonicalDragonPlusOffer.account_pool, "plus");
assert.equal(canonicalDragonPlusOffer.cache_hit_rate, 0.8);
assert.equal(canonicalDragonPlusOffer.cache_hit_sample_tokens, 1000);
assert.equal(canonicalDragonPlusOffer.raw_payload.supplemental_transit_snapshot.schema_version, "ai-transit.v1");
assert.ok(canonicalDragonParsed.availabilitySamples.length > 0);

const canonicalDragonMismatch = __test.compareNewApiPricingWithCanonicalTransitSnapshot(
  dragonPrimaryPricingFixture,
  {
    ...canonicalDragonTransitSnapshotFixture,
    groups: canonicalDragonTransitSnapshotFixture.groups.map((group) =>
      group.name === "gpt-plus" ? { ...group, rate_multiplier: 0.13 } : group,
    ),
  },
);
assert.equal(canonicalDragonMismatch.status, "mismatch");
assert.ok(canonicalDragonMismatch.mismatches.some((message) => message.includes("gpt-plus")));

const supplementalFailureParsed = __test.parsePricingPayload(
  configuredDragonapiSource,
  dragonPrimaryPricingFixture,
  "2026-08-07T10:15:00Z",
);
__test.markSupplementalSnapshotFailure(supplementalFailureParsed, "unsupported schema");
assert.equal(supplementalFailureParsed.station.collection_status, "partial");
assert.match(supplementalFailureParsed.collectionError, /补充快照采集失败/);

const rtocSnapshotParsed = __test.parsePricingPayload(
  configuredRtocSource,
  {
    schema_version: "ai-transit.v1",
    system: "new_api",
    generated_at: "2026-07-14T04:31:44Z",
    billing: {
      recharge_ratio: "1:1",
      minimum_top_up: 10,
    },
    groups: [
      {
        name: "GPT",
        platform: "openai",
        rate_multiplier: 0.03,
        cache_usage: {
          last_7d: {
            input_tokens: 1000,
            cache_creation_tokens: 500,
            cache_read_tokens: 8500,
            cache_hit_rate: 85,
          },
        },
        models: [
          {
            standard_model: "codex-auto-review",
            raw_model: "codex-auto-review",
            price: {
              input_usd_per_token: 0.000001,
              output_usd_per_token: 0.000006,
            },
          },
          {
            standard_model: "gpt-5.6-luna",
            raw_model: "gpt-5.6-luna",
            price: {
              input_usd_per_token: 0.000001,
              output_usd_per_token: 0.000006,
              cache_read_usd_per_token: 0.0000001,
              cache_write_usd_per_token: 0.00000125,
            },
          },
        ],
      },
      {
        name: "Kiro",
        platform: "anthropic",
        rate_multiplier: 0.22,
        models: [
          {
            standard_model: "claude-haiku-4-5-20251001",
            raw_model: "claude-haiku-4-5-20251001",
            price: {
              input_usd_per_token: 0.000001,
              output_usd_per_token: 0.000005,
              cache_read_usd_per_token: 0.0000001,
              cache_write_usd_per_token: 0.00000125,
            },
          },
        ],
      },
      {
        name: "claude",
        platform: "anthropic",
        rate_multiplier: 0.8,
        models: [
          {
            standard_model: "claude-sonnet-4-5-20250929",
            raw_model: "claude-sonnet-4-5-20250929",
            price: {
              input_usd_per_token: 0.000003,
              output_usd_per_token: 0.000015,
              cache_read_usd_per_token: 0.0000003,
              cache_write_usd_per_token: 0.00000375,
            },
          },
          {
            standard_model: "claude-opus-4-5-20251101",
            raw_model: "claude-opus-4-5-20251101",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.000025,
              cache_read_usd_per_token: 0.0000005,
              cache_write_usd_per_token: 0.00000625,
            },
          },
        ],
      },
      {
        name: "生图",
        platform: "google",
        rate_multiplier: 1,
        models: [
          {
            standard_model: "gemini-3.1-flash-lite-image",
            raw_model: "gemini-3.1-flash-lite-image",
            price: {
              image_output_usd_per_token: 0.03,
            },
          },
        ],
      },
      {
        name: "福利分组",
        platform: "xai",
        rate_multiplier: 0.1,
        models: [
          {
            standard_model: "grok-4.20-multi-agent-xhigh",
            raw_model: "grok-4.20-multi-agent-xhigh",
            price: {
              input_usd_per_token: null,
              output_usd_per_token: null,
              cache_read_usd_per_token: null,
              cache_write_usd_per_token: null,
            },
          },
          {
            standard_model: "grok-4.3-medium",
            raw_model: "grok-4.3-medium",
            price: {
              input_usd_per_token: null,
              output_usd_per_token: null,
              cache_read_usd_per_token: null,
              cache_write_usd_per_token: null,
            },
          },
          {
            standard_model: "grok-build-console",
            raw_model: "grok-build-console",
            price: {
              input_usd_per_token: null,
              output_usd_per_token: null,
              cache_read_usd_per_token: null,
              cache_write_usd_per_token: null,
            },
          },
        ],
      },
    ],
    monitoring: [
      {
        name: "GPT",
        primary_model: "gpt-5.6-luna",
        primary_status: "operational",
        availability_7d: 98.86,
        sample_count_7d: 270717,
        latest_latency_ms: 14789,
        avg_latency_7d_ms: 23298,
        last_checked_at: "2026-07-14T04:31:44Z",
      },
      {
        name: "福利分组",
        primary_model: "grok-4.20-multi-agent-xhigh",
        primary_status: "degraded",
        availability_7d: 93.5,
        sample_count_7d: 35141,
        latest_latency_ms: 5020,
        avg_latency_7d_ms: 8510,
        last_checked_at: "2026-07-14T04:31:44Z",
      },
    ],
  },
  "2026-07-14T04:35:00.000Z",
);
assert.equal(rtocSnapshotParsed.station.collector_kind, "ai_transit_snapshot");
assert.equal(rtocSnapshotParsed.station.station_system, "new_api");
assert.equal(rtocSnapshotParsed.station.pricing_endpoint_url, "https://api.rtoc.cc/api/public/transit/v1/snapshot");
assert.equal(rtocSnapshotParsed.station.availability_seven_day_samples, 60);
assert.equal(rtocSnapshotParsed.offers.length, 9);
assert.ok(rtocSnapshotParsed.offers.some((offer) => offer.standard_model === "Codex Compact" && offer.group_name === "GPT"));
assert.ok(rtocSnapshotParsed.offers.some((offer) => offer.standard_model === "Claude Haiku 4.5" && offer.group_name === "Kiro"));
assert.ok(rtocSnapshotParsed.offers.some((offer) => offer.standard_model === "Claude Sonnet 4.5" && offer.group_name === "claude"));
assert.ok(rtocSnapshotParsed.offers.some((offer) => offer.standard_model === "Claude Opus 4.5" && offer.group_name === "claude"));
assert.ok(rtocSnapshotParsed.offers.some((offer) => offer.standard_model === "Nano Banana Lite" && offer.group_name === "生图"));
assert.ok(rtocSnapshotParsed.offers.some((offer) => offer.standard_model === "Grok 4.20" && offer.group_name === "福利分组" && offer.cache_read_price === null));
const rtocLunaOffer = rtocSnapshotParsed.offers.find((offer) => offer.standard_model === "GPT 5.6 Luna" && offer.group_name === "GPT");
assert.equal(rtocLunaOffer.cache_read_price, 0.03);
assert.equal(rtocLunaOffer.cache_write_price, 0.03);
assert.equal(rtocLunaOffer.cache_hit_rate, 0.85);
assert.equal(rtocLunaOffer.availability_seven_day_samples, 60);

const apinodePayload = {
  code: 0,
  message: "success",
  data: {
    generated_at: "2026-06-30T07:11:17Z",
    groups: [
      {
        id: 15,
        name: "image2 渠道",
        platform: "openai",
        rate_multiplier: 0.1,
        allow_image_generation: true,
        image_rate_multiplier: 1,
      },
      {
        id: 11,
        name: "Plus-经济通道",
        platform: "openai",
        rate_multiplier: 0.3,
        allow_image_generation: true,
        image_rate_multiplier: 1,
      },
      {
        id: 12,
        name: "Team/Plus-标准通道",
        platform: "openai",
        rate_multiplier: 0.5,
        allow_image_generation: true,
        image_rate_multiplier: 1,
      },
      {
        id: 13,
        name: "Team/Plus/Pro-稳定通道",
        platform: "openai",
        rate_multiplier: 0.65,
        allow_image_generation: true,
        image_rate_multiplier: 1,
      },
    ],
    model_availability: [
      {
        id: 8,
        name: "Plus/Team渠道监控-GPT5.4",
        provider: "openai",
        group_name: "",
        models: [
          {
            model: "gpt-5.4",
            latest_status: "operational",
            availability_7d: 98.10397553516819,
            availability_15d: 98.10397553516819,
            availability_30d: 98.10397553516819,
          },
        ],
      },
      {
        id: 2,
        name: "Plus/Team渠道监控-GPT5.5",
        provider: "openai",
        group_name: "OpenAI",
        models: [
          {
            model: "gpt-5.5",
            latest_status: "operational",
            availability_7d: 97.64936336924583,
            availability_15d: 97.11141678129299,
            availability_30d: 98.24443848834093,
          },
        ],
      },
    ],
    recharge: {
      payment_enabled: true,
      balance_disabled: false,
      balance_recharge_multiplier: 1,
    },
  },
};
const apinodeSource = {
  id: "apinode-ltd",
  name: "APINode",
  websiteUrl: "https://apinode.ltd/",
  apiBaseUrl: "https://apinode.ltd/v1",
  pricingEndpointUrl: "https://apinode.ltd/api/v1/public/site-info",
  collectorKind: "sub2api_public_site_info",
  stationSystem: "sub_to_api",
  autoPublish: true,
};
const apinode = __test.parseApinodePublicSiteInfoPayload(apinodeSource, apinodePayload, "2026-06-30T07:12:00Z");
assert.equal(apinode.offers.length, 7);
assert.equal(apinode.station.collector_kind, "sub2api_public_site_info");
assert.equal(apinode.station.station_system, "sub_to_api");
assert.equal(apinode.station.availability_seven_day_samples, 2);
assert.equal(apinode.station.availability_seven_day_rate, 0.978767);
assert.equal(apinode.offers.some((offer) => offer.standard_model === "GPT 5.4" && offer.group_name === "image2 渠道"), false);
assert.equal(apinode.offers.some((offer) => offer.standard_model === "GPT Image 2" && offer.group_name === "image2 渠道"), true);
const apinodeGpt55Economy = apinode.offers.find(
  (offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "Plus-经济通道",
);
assert.equal(apinodeGpt55Economy.model_multiplier, 0.3);
assert.equal(apinodeGpt55Economy.availability_seven_day_rate, 0.976494);
assert.equal(apinodeGpt55Economy.last_verified_at, "2026-06-30T07:11:17Z");
assert.match(apinodeGpt55Economy.availability_note, /非 PriceAI API Key 实测/);

const aiTransitSnapshot = __test.parsePricingPayload(
  configuredAiTransitSnapshotSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-05T08:40:00.000Z",
    station: {
      name: "Sub2API",
      homepage_url: "https://sub.dimension.cc.cd/home",
      price_url: "https://sub.dimension.cc.cd/public/transit",
      monitor_url: "https://sub.dimension.cc.cd/public/transit?view=monitoring",
      system_type: "sub2api",
    },
    billing: {
      currency: "CNY",
      credit_currency: "USD",
      recharge_ratio: "1 CNY = 1 USD balance",
      recharge_multiplier: 1,
      minimum_top_up: 1,
    },
    groups: [
      {
        name: "gpt free号池",
        platform: "openai",
        rate_multiplier: 0.1,
        cache_usage: {
          total: {
            input_tokens: 1_000,
            cache_creation_tokens: 200,
            cache_read_tokens: 8_800,
            cache_hit_rate: 88,
          },
        },
        models: [
          {
            standard_model: "gpt-5.5",
            raw_model: "gpt-5.5",
            platform: "openai",
            billing_mode: "token",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.00003,
              cache_read_usd_per_token: 0.0000005,
            },
          },
        ],
      },
      {
        name: "image",
        platform: "openai",
        rate_multiplier: 1,
        cache_usage: {
          total: {
            input_tokens: 1_000,
            cache_creation_tokens: 0,
            cache_read_tokens: 9_000,
            cache_hit_rate: 99,
          },
        },
        models: [
          {
            standard_model: "gpt-image-2",
            raw_model: "gpt-image-2",
            platform: "openai",
            billing_mode: "per_request",
            price: {
              per_request_usd: 0.08,
              image_size_prices: {
                "1k": 0.08,
                "2k": 0.08,
              },
            },
          },
        ],
      },
    ],
    monitoring: [
      {
        name: "gpt free号池",
        provider: "openai",
        primary_model: "gpt-5.5",
        primary_status: "operational",
        availability_7d: 96.5,
        sample_count_7d: 42,
        latest_latency_ms: 1985,
        last_checked_at: "2026-07-05T08:35:59.000Z",
        timeline: [
          { status: "operational", latency_ms: 1985, checked_at: "2026-07-05T08:35:59.000Z" },
          { status: "error", latency_ms: 24, checked_at: "2026-07-05T08:25:59.000Z" },
        ],
      },
    ],
  },
  "2026-07-05T08:40:00.000Z",
);
assert.equal(aiTransitSnapshot.station.collector_kind, "ai_transit_snapshot");
assert.equal(aiTransitSnapshot.station.published, true);
assert.equal(aiTransitSnapshot.offers.length, 2);
const aiTransitGpt = aiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.5");
assert.equal(aiTransitGpt.recharge_ratio, "1:1");
assert.equal(aiTransitGpt.model_multiplier, 0.1);
assert.equal(aiTransitGpt.raw_payload.group.rate_multiplier, 0.1);
assert.equal(aiTransitGpt.input_price, 0.1);
assert.equal(aiTransitGpt.output_price, 0.1);
assert.equal(aiTransitGpt.cache_read_price, 0.1);
assert.equal(aiTransitGpt.cache_hit_rate, 0.88);
assert.equal(aiTransitGpt.cache_hit_sample_tokens, 10000);
assert.equal(aiTransitGpt.availability_seven_day_rate, 0.965);
assert.equal(aiTransitGpt.availability_seven_day_samples, 42);
assert.equal(aiTransitGpt.availability_latest_latency_ms, 1985);
assert.equal(aiTransitGpt.availability_avg_latency_7d_ms, 1005);
assert.equal(aiTransitGpt.availability_source_type, "public_status");
const aiTransitImage = aiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT Image 2");
assert.equal(aiTransitImage.family, "image");
assert.equal(aiTransitImage.billing_mode, "per_request");
assert.equal(aiTransitImage.model_multiplier, null);
assert.equal(aiTransitImage.image_output_price, null);
assert.equal(aiTransitImage.fixed_price, 0.08);
assert.deepEqual(aiTransitImage.fixed_price_tiers, [
  { label: "1k", price: 0.08, unit: "request" },
  { label: "2k", price: 0.08, unit: "request" },
]);
assert.equal(aiTransitImage.cache_hit_rate, null);
assert.equal(aiTransitImage.cache_hit_sample_tokens, 0);
assert.equal(aiTransitSnapshot.availabilitySamples.length, 4);
assert.equal(aiTransitSnapshot.station.availability_seven_day_rate, 0.965);
assert.equal(aiTransitSnapshot.station.availability_seven_day_samples, 42);

const acsSnapshot = {
  schema_version: "acs.public-transit.v1",
  generated_at: "2026-08-07T08:48:52Z",
  billing: { minimum_recharge_cny: 5 },
  models: [
    {
      id: "gpt-5.6-sol",
      input_price_per_million: 5,
      output_price_per_million: 30,
      cache_read_price_per_million: 0.5,
      cache_write_price_per_million: 6.25,
    },
    {
      id: "claude-opus-4-6",
      input_price_per_million: 5,
      output_price_per_million: 25,
      cache_read_price_per_million: 0.5,
      cache_write_price_per_million: 6.25,
    },
  ],
};
const acsStatus = {
  code: 200,
  data: {
    generated_at: "2026-08-07T08:50:58Z",
    groups: [
      {
        display_name: "Codex(Pro号池1)",
        multiplier: 0.35,
        status: "normal",
        supported_models: ["gpt-5.6-sol"],
        sample_count: 4503,
        success_rate: 1,
        uptime: 100,
        avg_first_token_latency_ms: 1988,
        timeline: [
          { date: "2026-08-07T08:00:00Z", status: "normal", has_data: true },
          { date: "2026-08-07T07:00:00Z", status: "normal", has_data: false },
        ],
      },
      {
        display_name: "claude(max限制客户端)",
        multiplier: 1.25,
        status: "normal",
        supported_models: ["claude-opus-4-6"],
        sample_count: 0,
        success_rate: 1,
        uptime: 100,
        avg_first_token_latency_ms: 0,
        timeline: [],
      },
    ],
  },
};
const adaptedAcsSnapshot = __test.adaptAcsPublicTransitSnapshot(acsSnapshot, acsStatus);
const parsedAcsSnapshot = __test.parsePricingPayload(
  configuredAcsGatewaySource,
  adaptedAcsSnapshot,
  "2026-08-07T08:51:00Z",
);
assert.equal(adaptedAcsSnapshot.schema_version, "acs.public-transit.v1");
assert.equal(adaptedAcsSnapshot.system, "custom");
assert.equal(parsedAcsSnapshot.offers.length, 2);
assert.equal(parsedAcsSnapshot.station.published, false);
assert.equal(parsedAcsSnapshot.station.data_status, "pending_review");
const acsCodexOffer = parsedAcsSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.6 Sol");
assert.equal(acsCodexOffer.group_name, "Codex(Pro号池1)");
assert.equal(acsCodexOffer.model_multiplier, 0.35);
assert.equal(acsCodexOffer.status, "needs_review");
assert.equal(acsCodexOffer.availability_seven_day_rate, 1);
assert.equal(acsCodexOffer.availability_seven_day_samples, 60);
assert.equal(acsCodexOffer.availability_source_type, "public_status");
assert.equal(parsedAcsSnapshot.availabilitySamples.length, 2);
const acsClaudeOffer = parsedAcsSnapshot.offers.find((offer) => offer.standard_model === "Claude Opus 4.6");
assert.equal(acsClaudeOffer.model_multiplier, 1.25);
assert.equal(acsClaudeOffer.availability_seven_day_samples, 0);
assert.equal(acsClaudeOffer.availability_seven_day_rate, null);
assert.equal(acsClaudeOffer.availability_latest_latency_ms, null);
assert.equal(acsClaudeOffer.price_source, "ACS 公开快照");
assert.equal(aiTransitSnapshot.station.availability_latest_latency_ms, 1985);
assert.equal(aiTransitSnapshot.station.availability_avg_latency_7d_ms, 1005);

const convertedAiTransitFixedPrice = __test.parsePricingPayload(
  configuredAiTransitSnapshotSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-05T08:40:00.000Z",
    billing: {
      recharge_multiplier: 5,
    },
    groups: [
      {
        name: "image",
        platform: "openai",
        rate_multiplier: 0.03,
        cache_usage: {
          total: {
            input_tokens: 1_000,
            cache_read_tokens: 9_000,
            cache_hit_rate: 90,
          },
        },
        models: [
          {
            standard_model: "gpt-image-2",
            raw_model: "gpt-image-2",
            platform: "openai",
            billing_mode: "per_request",
            price: {
              per_request_usd: 0.08,
            },
          },
        ],
      },
    ],
  },
  "2026-07-05T08:40:00.000Z",
);
const convertedAiTransitImage = convertedAiTransitFixedPrice.offers.find((offer) => offer.standard_model === "GPT Image 2");
assert.equal(convertedAiTransitImage.recharge_ratio, "1:5");
assert.equal(convertedAiTransitImage.model_multiplier, null);
assert.equal(convertedAiTransitImage.fixed_price, 0.016);
assert.equal(convertedAiTransitImage.cache_hit_rate, null);
assert.equal(convertedAiTransitImage.cache_hit_sample_tokens, 0);

const longAiTransitTimeline = Array.from({ length: 63 }, (_, index) => ({
  status: index === 40 ? "error" : "operational",
  latency_ms: 1000 + index,
  checked_at: new Date(Date.UTC(2026, 6, 5, 7, index, 0)).toISOString(),
}));
const longAiTransitSnapshot = __test.parsePricingPayload(
  configuredAiTransitSnapshotSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-05T09:00:00.000Z",
    billing: {
      recharge_ratio: "1 CNY = 1 USD balance",
    },
    groups: [
      {
        name: "gpt free号池",
        platform: "openai",
        rate_multiplier: 0.1,
        models: [
          {
            standard_model: "gpt-5.5",
            raw_model: "gpt-5.5",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.00003,
            },
          },
        ],
      },
    ],
    monitoring: [
      {
        name: "gpt free号池",
        primary_model: "gpt-5.5",
        primary_status: "operational",
        availability_7d: 98.3333,
        latest_latency_ms: 1062,
        last_checked_at: "2026-07-05T08:02:00.000Z",
        timeline: longAiTransitTimeline,
      },
    ],
  },
  "2026-07-05T09:00:00.000Z",
);
const longAiTransitStationSamples = longAiTransitSnapshot.availabilitySamples.filter((sample) => sample.scope === "station");
const longAiTransitOffer = longAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.5");
assert.equal(longAiTransitSnapshot.availabilitySamples.length, 120);
assert.equal(longAiTransitStationSamples.length, 60);
assert.equal(longAiTransitStationSamples[0].checked_at, longAiTransitTimeline[3].checked_at);
assert.equal(longAiTransitStationSamples.at(-1).checked_at, longAiTransitTimeline.at(-1).checked_at);
assert.equal(longAiTransitOffer.availability_seven_day_samples, 60);
assert.equal(longAiTransitOffer.last_verified_at, "2026-07-05T09:00:00.000Z");
assert.equal(longAiTransitSnapshot.station.availability_seven_day_samples, 60);

const aiTransitGroupRateSnapshot = __test.parsePricingPayload(
  configuredApinodeSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-10T16:53:18.000Z",
    station: {
      name: "APINode",
      homepage_url: "https://apinode.ltd/home",
      price_url: "https://apinode.ltd/public/transit",
      monitor_url: "https://apinode.ltd/public/transit?view=monitoring",
      system_type: "sub2api",
    },
    billing: {
      currency: "CNY",
      credit_currency: "USD",
      recharge_ratio: "1 CNY = 1 USD balance",
      recharge_multiplier: 1,
      minimum_top_up: 1,
    },
    groups: [
      {
        name: "Plus-经济通道",
        platform: "openai",
        rate_multiplier: 0.19,
        models: [
          {
            standard_model: "gpt-5.6-sol",
            raw_model: "gpt-5.6-sol",
            platform: "openai",
            billing_mode: "token",
            price: {
              input_usd_per_token: 0.0000025,
              output_usd_per_token: 0.000015,
              cache_write_usd_per_token: 0.000003125,
              cache_read_usd_per_token: 0.00000025,
            },
          },
        ],
      },
    ],
  },
  "2026-07-10T16:54:00.000Z",
);
const aiTransitGroupRateGpt = aiTransitGroupRateSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.6 Sol");
assert.equal(aiTransitGroupRateGpt.model_multiplier, 0.19);
assert.equal(aiTransitGroupRateGpt.input_price, 0.19);
assert.equal(aiTransitGroupRateGpt.output_price, 0.19);
assert.equal(aiTransitGroupRateGpt.raw_payload.group.rate_multiplier, 0.19);
assert.equal(aiTransitGroupRateGpt.raw_payload.multiplier_basis, "ai_transit_group_rate_multiplier");

const callaiAiTransitSnapshot = __test.parsePricingPayload(
  configuredCallaiSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-07T09:20:00.000Z",
    billing: {
      recharge_ratio: "1 USD balance per 1 CNY",
      recharge_multiplier: 1,
    },
    disclosure: {
      upstream_type: "mixed",
      account_pool_type: "mixed",
    },
    groups: [
      {
        name: "claude-kiro",
        platform: "anthropic",
        rate_multiplier: 0.3,
        cache_usage: {
          last_24h: {
            input_tokens: 6_353_524,
            cache_creation_tokens: 36_899_982,
            cache_read_tokens: 508_098_145,
            cache_hit_rate: 92.15500562634573,
          },
          last_7d: {
            input_tokens: 212_504_843,
            cache_creation_tokens: 406_339_026,
            cache_read_tokens: 2_545_453_770,
            cache_hit_rate: 80.44293111454678,
          },
          total: {
            input_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            cache_hit_rate: 0,
          },
        },
        models: [
          {
            standard_model: "claude-opus-4-8",
            raw_model: "claude-opus-4-8",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.000025,
              cache_read_usd_per_token: 0.0000005,
              cache_write_usd_per_token: 0.00000625,
            },
          },
        ],
      },
      {
        name: "gpt",
        platform: "openai",
        rate_multiplier: 0.1,
        cache_usage: {
          last_24h: {
            input_tokens: 550_673_960,
            cache_creation_tokens: 0,
            cache_read_tokens: 4_635_624_448,
            cache_hit_rate: 89.38213892300197,
          },
          last_7d: {
            input_tokens: 2_441_272_235,
            cache_creation_tokens: 0,
            cache_read_tokens: 22_916_770_246,
            cache_hit_rate: 90.37278907932593,
          },
          total: {
            input_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            cache_hit_rate: 0,
          },
        },
        models: [
          {
            standard_model: "gpt-5.5",
            raw_model: "gpt-5.5",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.00003,
              cache_read_usd_per_token: 0.0000005,
            },
          },
        ],
      },
    ],
    monitoring: [
      {
        name: "claude-kiro",
        primary_model: "claude-opus-4-8",
        primary_status: "operational",
        availability_7d: 81.18615491421204,
        latest_latency_ms: 1414,
        last_checked_at: "2026-07-07T09:19:11.000Z",
        timeline: [
          { status: "operational", latency_ms: 1414, checked_at: "2026-07-07T09:19:11.000Z" },
        ],
      },
      {
        name: "gpt",
        primary_model: "gpt-5.5",
        primary_status: "operational",
        availability_7d: 98.78012496280869,
        latest_latency_ms: 1311,
        last_checked_at: "2026-07-07T09:19:11.000Z",
        timeline: [
          { status: "operational", latency_ms: 1311, checked_at: "2026-07-07T09:19:11.000Z" },
        ],
      },
    ],
  },
  "2026-07-07T09:20:00.000Z",
);
const callaiClaudeOffer = callaiAiTransitSnapshot.offers.find((offer) => offer.standard_model === "Claude Opus 4.8");
assert.equal(callaiClaudeOffer.group_name, "claude-kiro");
assert.equal(callaiClaudeOffer.account_pool, "kiro");
assert.equal(callaiClaudeOffer.channel_type, "mixed");
assert.equal(callaiClaudeOffer.cache_hit_rate, 0.804429);
assert.equal(callaiClaudeOffer.cache_hit_sample_tokens, 3_164_297_639);
assert.equal(callaiClaudeOffer.availability_seven_day_rate, 0.811862);
assert.equal(callaiClaudeOffer.availability_seven_day_samples, 1);
assert.equal(callaiClaudeOffer.availability_latest_latency_ms, 1414);
const callaiGptOffer = callaiAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.5");
assert.equal(callaiGptOffer.group_name, "gpt");
assert.equal(callaiGptOffer.account_pool, "mixed");
assert.equal(callaiGptOffer.channel_type, "mixed");
assert.equal(callaiGptOffer.cache_hit_rate, 0.903728);
assert.equal(callaiGptOffer.cache_hit_sample_tokens, 25_358_042_481);
assert.equal(callaiGptOffer.availability_seven_day_rate, 0.987801);
assert.equal(callaiGptOffer.availability_seven_day_samples, 1);
assert.equal(callaiGptOffer.availability_latest_latency_ms, 1311);
assert.equal(callaiAiTransitSnapshot.station.availability_seven_day_rate, 0.899832);
assert.equal(callaiAiTransitSnapshot.station.availability_seven_day_samples, 2);

const aliuapiAiTransitSnapshot = __test.parsePricingPayload(
  configuredAliuapiSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-07T12:11:25.000Z",
    station: {
      name: "A6-API",
      homepage_url: "https://aliuapi.top/home",
      price_url: "https://aliuapi.top/public/transit",
      monitor_url: "https://aliuapi.top/public/transit?view=monitoring",
      system_type: "sub2api",
    },
    billing: {
      recharge_ratio: "1 CNY = 1 USD balance",
      recharge_multiplier: 1,
      minimum_top_up: 1,
    },
    groups: [
      {
        name: "T0 - GPT Plus",
        platform: "openai",
        rate_multiplier: 0.05,
        cache_usage: {
          total: {
            input_tokens: 25_816_238,
            cache_creation_tokens: 0,
            cache_read_tokens: 242_969_088,
            cache_hit_rate: 90.39522045931928,
          },
        },
        models: [
          {
            standard_model: "gpt-5.4",
            raw_model: "gpt-5.4",
            price: {
              input_usd_per_token: 0.0000025,
              output_usd_per_token: 0.000015,
              cache_read_usd_per_token: 0.00000025,
            },
          },
          {
            standard_model: "gpt-5.5",
            raw_model: "gpt-5.5",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.00003,
              cache_read_usd_per_token: 0.0000005,
            },
          },
        ],
      },
      {
        name: "T1 - GPT Pro",
        platform: "openai",
        rate_multiplier: 0.12,
        cache_usage: {
          total: {
            input_tokens: 3_455_029,
            cache_creation_tokens: 0,
            cache_read_tokens: 38_039_424,
            cache_hit_rate: 91.67351597573777,
          },
        },
        models: [
          {
            standard_model: "gpt-5.4-mini",
            raw_model: "gpt-5.4-mini",
            price: {
              input_usd_per_token: 0.00000075,
              output_usd_per_token: 0.0000045,
              cache_read_usd_per_token: 0.000000075,
            },
          },
          {
            standard_model: "gpt-5.5",
            raw_model: "gpt-5.5",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.00003,
              cache_read_usd_per_token: 0.0000005,
            },
          },
        ],
      },
    ],
    monitoring: [
      {
        name: "Plus",
        primary_model: "gpt-5.4",
        primary_status: "operational",
        availability_7d: 96.44970414201184,
        latest_latency_ms: 1320,
        last_checked_at: "2026-07-07T12:11:18.000Z",
        timeline: [
          { status: "operational", latency_ms: 1320, checked_at: "2026-07-07T12:11:18.000Z" },
        ],
      },
      {
        name: "Pro",
        primary_model: "gpt-5.4-mini",
        primary_status: "operational",
        availability_7d: 100,
        latest_latency_ms: 988,
        last_checked_at: "2026-07-07T12:11:18.000Z",
        timeline: [
          { status: "operational", latency_ms: 988, checked_at: "2026-07-07T12:11:18.000Z" },
        ],
      },
    ],
  },
  "2026-07-07T12:11:25.000Z",
);
assert.equal(aliuapiAiTransitSnapshot.station.published, true);
assert.equal(aliuapiAiTransitSnapshot.station.availability_source_type, "public_status");
assert.equal(aliuapiAiTransitSnapshot.station.minimum_top_up, 1);
const aliuapiPlusGpt54 = aliuapiAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.4" && offer.group_name === "T0 - GPT Plus");
assert.equal(aliuapiPlusGpt54.model_multiplier, 0.05);
assert.equal(aliuapiPlusGpt54.cache_hit_rate, 0.903952);
assert.equal(aliuapiPlusGpt54.cache_hit_sample_tokens, 268785326);
assert.equal(aliuapiPlusGpt54.availability_seven_day_samples, 1);
assert.equal(aliuapiPlusGpt54.availability_source_type, "public_status");
const aliuapiProGpt55 = aliuapiAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "T1 - GPT Pro");
assert.equal(aliuapiProGpt55.model_multiplier, 0.12);
assert.equal(aliuapiProGpt55.cache_hit_rate, 0.916735);
assert.equal(aliuapiProGpt55.cache_hit_sample_tokens, 41494453);
const aliuapiProGpt54Mini = aliuapiAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.4 Mini" && offer.group_name === "T1 - GPT Pro");
assert.equal(aliuapiProGpt54Mini.model_multiplier, 0.12);
assert.equal(aliuapiProGpt54Mini.availability_seven_day_samples, 1);
assert.equal(aliuapiProGpt54Mini.availability_source_type, "public_status");

const currentA6MonitoringGroups = [
  ["GPT Pro", "GPT Pro - 优质客户单独开通", 98.83],
  ["GPT Plus SOL - 兜底通道", "GPT Plus - 有SOL模型 - 兜底通道", 81.27],
  ["特殊 GPT Plus", "特殊 GPT Plus - 没有SOL模型 - 稳定", 98.44],
  ["GPT Plus SOL - 多通道综合", "GPT Plus - 有SOL模型 - 自动倍率", 96.05],
];
const currentA6Snapshot = __test.parsePricingPayload(
  configuredAliuapiSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-20T07:05:00.000Z",
    groups: currentA6MonitoringGroups.map(([, groupName], index) => ({
      name: groupName,
      platform: "openai",
      rate_multiplier: 0.04 + index * 0.01,
      models: [{
        standard_model: "gpt-5.5",
        raw_model: "gpt-5.5",
        price: {
          input_usd_per_token: 0.000005,
          output_usd_per_token: 0.00003,
          cache_read_usd_per_token: 0.0000005,
        },
      }],
    })),
    monitoring: currentA6MonitoringGroups.map(([name, groupName, availability], index) => ({
      name,
      group_name: groupName,
      primary_model: "gpt-5.5",
      primary_status: "operational",
      availability_7d: availability,
      latest_latency_ms: 1_000 + index,
      last_checked_at: `2026-07-20T07:0${index}:00.000Z`,
      timeline: [{
        status: "operational",
        latency_ms: 1_000 + index,
        checked_at: `2026-07-20T07:0${index}:00.000Z`,
      }],
    })),
  },
  "2026-07-20T07:05:00.000Z",
);
assert.equal(currentA6Snapshot.offers.length, 4);
assert.deepEqual(
  currentA6Snapshot.offers.map((offer) => offer.availability_seven_day_rate),
  [0.9883, 0.8127, 0.9844, 0.9605],
);
assert.ok(currentA6Snapshot.offers.every((offer) => offer.availability_scope === "group"));
assert.ok(currentA6Snapshot.offers.every((offer) => offer.availability_match_level === "exact"));
assert.equal(new Set(currentA6Snapshot.offers.map((offer) => offer.monitoring_scope_id)).size, 4);
assert.deepEqual(
  new Set(currentA6Snapshot.availabilitySamples.filter((sample) => sample.scope === "offer").map((sample) => sample.group_name)),
  new Set(currentA6MonitoringGroups.map(([, groupName]) => groupName)),
);

const sameGroupIndependentModels = __test.parsePricingPayload(
  configuredApinodeSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-20T07:10:00.000Z",
    groups: [{
      name: "Pro/Team/Plus-稳定通道",
      platform: "openai",
      rate_multiplier: 0.07,
      models: ["gpt-5.5", "gpt-5.6-sol", "gpt-5.4", "gpt-5.4-mini"].map((standard_model) => ({
        standard_model,
        raw_model: standard_model,
        price: { input_usd_per_token: 0.000005, output_usd_per_token: 0.00003 },
      })),
    }],
    monitoring: [
      { group_name: "Pro/Team/Plus渠道", primary_model: "gpt-5.5", availability_7d: 99, sample_count_7d: 60 },
      { group_name: "Pro/Team/Plus渠道", primary_model: "gpt-5.6-sol", availability_7d: 97, sample_count_7d: 60 },
    ],
  },
  "2026-07-20T07:10:00.000Z",
);
assert.equal(sameGroupIndependentModels.offers.length, 4);
const sameGroupExactOffers = sameGroupIndependentModels.offers.filter(
  (offer) => offer.availability_match_level === "exact",
);
const sameGroupFallbackOffers = sameGroupIndependentModels.offers.filter(
  (offer) => offer.availability_match_level === "group",
);
assert.equal(sameGroupExactOffers.length, 2);
assert.equal(new Set(sameGroupExactOffers.map((offer) => offer.monitoring_scope_id)).size, 2);
assert.equal(sameGroupFallbackOffers.length, 2);
assert.equal(new Set(sameGroupFallbackOffers.map((offer) => offer.monitoring_scope_id)).size, 1);
assert.ok(sameGroupFallbackOffers.every((offer) => offer.availability_seven_day_samples === 120));
assert.deepEqual(
  sameGroupExactOffers.map((offer) => offer.availability_seven_day_rate),
  [0.99, 0.97],
);

const mfttaiAiTransitSnapshot = __test.parsePricingPayload(
  configuredMfttaiSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-08T00:35:00.000Z",
    station: {
      name: "MFAPI",
      homepage_url: "https://mfttai.com/home",
      price_url: "https://mfttai.com/public/transit",
      monitor_url: "https://mfttai.com/public/transit?view=monitoring",
      support_url: "VX：lyw2465885900",
      system_type: "sub2api",
    },
    billing: {
      recharge_ratio: "1 CNY = 1 USD balance",
      recharge_multiplier: 1,
      minimum_top_up: 1,
    },
    groups: [
      {
        name: "Kiro",
        platform: "anthropic",
        rate_multiplier: 0.2,
        cache_usage: {
          last_7d: {
            input_tokens: 636_300_000,
            cache_creation_tokens: 1_907_100_000,
            cache_read_tokens: 637_200_000,
            cache_hit_rate: 79.48679152473383,
          },
        },
        models: [
          {
            standard_model: "claude-opus-4-8",
            raw_model: "claude-opus-4-8",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.000025,
              cache_read_usd_per_token: 0.0000005,
              cache_write_usd_per_token: 0.00000625,
            },
          },
        ],
      },
      {
        name: "GPT",
        platform: "openai",
        rate_multiplier: 0.3,
        cache_usage: {
          last_7d: {
            input_tokens: 3_249_918_852,
            cache_creation_tokens: 0,
            cache_read_tokens: 36_521_068_824,
            cache_hit_rate: 91.84133357579094,
          },
        },
        models: [
          {
            standard_model: "gpt-5.5",
            raw_model: "gpt-5.5",
            price: {
              input_usd_per_token: 0.000005,
              output_usd_per_token: 0.00003,
              cache_read_usd_per_token: 0.0000005,
              cache_write_usd_per_token: 0.0000005,
            },
          },
        ],
      },
    ],
    monitoring: [
      {
        name: "Kiro",
        primary_model: "claude-opus-4-8",
        primary_status: "operational",
        availability_7d: 97.83251231527093,
        latest_latency_ms: 1953,
        last_checked_at: "2026-07-08T00:34:41.000Z",
        models: [
          {
            model: "claude-opus-4-8",
            latest_status: "operational",
            availability_7d: 97.83251231527093,
            latest_latency_ms: 1953,
          },
        ],
        timeline: [
          { status: "operational", latency_ms: 1953, checked_at: "2026-07-08T00:34:41.000Z" },
        ],
      },
      {
        name: "GPT&Image",
        primary_model: "gpt-5.5",
        primary_status: "operational",
        availability_7d: 99.90138067061145,
        latest_latency_ms: 2106,
        last_checked_at: "2026-07-08T00:34:41.000Z",
        models: [
          {
            model: "gpt-5.5",
            latest_status: "operational",
            availability_7d: 99.90138067061145,
            latest_latency_ms: 2106,
          },
        ],
        timeline: [
          { status: "operational", latency_ms: 2106, checked_at: "2026-07-08T00:34:41.000Z" },
        ],
      },
    ],
  },
  "2026-07-08T00:35:00.000Z",
);
assert.equal(mfttaiAiTransitSnapshot.station.published, true);
assert.equal(mfttaiAiTransitSnapshot.station.minimum_top_up, 1);
assert.equal(mfttaiAiTransitSnapshot.station.availability_source_type, "public_status");
const mfttaiKiroClaude = mfttaiAiTransitSnapshot.offers.find((offer) => offer.standard_model === "Claude Opus 4.8" && offer.group_name === "Kiro");
assert.equal(mfttaiKiroClaude.model_multiplier, 0.2);
assert.equal(mfttaiKiroClaude.cache_hit_rate, 0.794868);
assert.equal(mfttaiKiroClaude.cache_hit_sample_tokens, 3_180_600_000);
assert.equal(mfttaiKiroClaude.availability_seven_day_rate, 0.978325);
assert.equal(mfttaiKiroClaude.availability_latest_latency_ms, 1953);
const mfttaiGpt55 = mfttaiAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "GPT");
assert.equal(mfttaiGpt55.model_multiplier, 0.3);
assert.equal(mfttaiGpt55.cache_hit_rate, 0.918413);
assert.equal(mfttaiGpt55.cache_hit_sample_tokens, 39_770_987_676);
assert.equal(mfttaiGpt55.availability_seven_day_rate, 0.999014);
assert.equal(mfttaiGpt55.availability_seven_day_samples, 1);
assert.equal(mfttaiGpt55.availability_latest_latency_ms, 2106);

const wawazzAiTransitSnapshot = __test.parsePricingPayload(
  configuredWawazzSource,
  {
    schema_version: "ai-transit.v1",
    system: "sub2api",
    generated_at: "2026-07-08T06:40:41.000Z",
    station: {
      name: "WAWA ZZ API",
      homepage_url: "https://wawazz.xyz/home",
      price_url: "https://wawazz.xyz/public/transit",
      monitor_url: "https://wawazz.xyz/public/transit?view=monitoring",
      support_url: "qq群：1073408363",
      system_type: "sub2api",
    },
    billing: {
      recharge_ratio: "1 CNY = 1 USD balance",
      recharge_multiplier: 1,
      minimum_top_up: 1,
    },
    disclosure: {
      upstream_type: "mixed",
      account_pool_type: "mixed",
    },
    groups: [
      {
        name: "claude-krio",
        platform: "anthropic",
        rate_multiplier: 0.3,
        cache_usage: {
          last_7d: {
            input_tokens: 6_440_345,
            cache_creation_tokens: 892_460,
            cache_read_tokens: 56_418_415,
            cache_hit_rate: 88.49778090521248,
          },
        },
        models: [],
      },
      {
        name: "claude-krio-power",
        platform: "anthropic",
        rate_multiplier: 0.4,
        cache_usage: {
          last_7d: {
            input_tokens: 2_000_000,
            cache_creation_tokens: 3_000_000,
            cache_read_tokens: 20_000_000,
            cache_hit_rate: 80,
          },
        },
        models: [],
      },
      {
        name: "claude-max-号池-不限制客户端",
        platform: "anthropic",
        rate_multiplier: 1.3,
        cache_usage: {
          last_7d: {
            input_tokens: 1_234_567,
            cache_creation_tokens: 2_345_678,
            cache_read_tokens: 6_364_371,
            cache_hit_rate: 86.0591822772783,
          },
        },
        models: [],
      },
      {
        name: "gpt-plus",
        platform: "openai",
        rate_multiplier: 0.07,
        cache_usage: {
          last_7d: {
            input_tokens: 1_226_680_734,
            cache_creation_tokens: 0,
            cache_read_tokens: 10_000_000_000,
            cache_hit_rate: 90.07147044251201,
          },
        },
        models: [
          {
            standard_model: "gpt-5.4",
            raw_model: "gpt-5.4",
            price: {
              input_usd_per_token: 0.0000025,
              output_usd_per_token: 0.000015,
              cache_read_usd_per_token: 0.00000025,
            },
          },
          {
            standard_model: "gpt-5.4-mini",
            raw_model: "gpt-5.4-mini",
            price: {
              input_usd_per_token: 0.00000075,
              output_usd_per_token: 0.0000045,
              cache_read_usd_per_token: 0.000000075,
            },
          },
        ],
      },
      {
        name: "gpt-pro",
        platform: "openai",
        rate_multiplier: 0.16,
        cache_usage: {
          last_7d: {
            input_tokens: 847_267_933,
            cache_creation_tokens: 0,
            cache_read_tokens: 6_495_000_000,
            cache_hit_rate: 88.46070447535655,
          },
        },
        models: [],
      },
    ],
    monitoring: [
      {
        name: "gpt-plus分组",
        primary_model: "gpt-5.5",
        primary_status: "operational",
        availability_7d: 88.08622675662333,
        latest_latency_ms: 1909,
        last_checked_at: "2026-07-08T06:40:12.000Z",
        models: [
          {
            model: "gpt-5.5",
            latest_status: "operational",
            availability_7d: 88.08622675662333,
            latest_latency_ms: 1909,
          },
        ],
        timeline: [
          { status: "operational", latency_ms: 1909, checked_at: "2026-07-08T06:40:12.000Z" },
        ],
      },
      {
        name: "cc-max分组",
        primary_model: "claude-sonnet-4-6",
        primary_status: "operational",
        availability_7d: 98.16362223085892,
        latest_latency_ms: 1547,
        last_checked_at: "2026-07-08T06:40:12.000Z",
        models: [
          {
            model: "claude-sonnet-4-6",
            latest_status: "operational",
            availability_7d: 98.16362223085892,
            latest_latency_ms: 1547,
          },
        ],
        timeline: [
          { status: "operational", latency_ms: 1547, checked_at: "2026-07-08T06:40:12.000Z" },
        ],
      },
      {
        name: "gpt-pro分组",
        primary_model: "gpt-5.4-mini",
        primary_status: "operational",
        availability_7d: 98.92397425583266,
        latest_latency_ms: 1542,
        last_checked_at: "2026-07-08T06:40:12.000Z",
        models: [
          {
            model: "gpt-5.4-mini",
            latest_status: "operational",
            availability_7d: 98.92397425583266,
            latest_latency_ms: 1542,
          },
        ],
        timeline: [
          { status: "operational", latency_ms: 1542, checked_at: "2026-07-08T06:40:12.000Z" },
        ],
      },
    ],
    completeness: {
      warnings: ["no public model pricing found"],
    },
  },
  "2026-07-08T06:40:41.000Z",
);
assert.equal(wawazzAiTransitSnapshot.modelCount, 5);
assert.equal(wawazzAiTransitSnapshot.offers.length, 5);
assert.equal(wawazzAiTransitSnapshot.station.collection_status, "success");
assert.equal(wawazzAiTransitSnapshot.station.published, true);
const wawazzPlusGpt55 = wawazzAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "gpt-plus");
assert.equal(wawazzPlusGpt55, undefined);
const wawazzPlusGpt54 = wawazzAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.4" && offer.group_name === "gpt-plus");
assert.equal(wawazzPlusGpt54.model_multiplier, 0.07);
assert.equal(wawazzPlusGpt54.account_pool, "plus");
assert.equal(wawazzPlusGpt54.channel_type, "mixed");
assert.equal(wawazzPlusGpt54.cache_hit_rate, 0.900715);
assert.equal(wawazzPlusGpt54.availability_seven_day_rate, 0.880862);
assert.equal(wawazzPlusGpt54.availability_seven_day_samples, 1);
assert.match(wawazzPlusGpt54.availability_note, /同分组监测/);
const wawazzClaudeMaxOpus = wawazzAiTransitSnapshot.offers.find(
  (offer) => offer.standard_model === "Claude Opus 4.8" && offer.group_name === "claude-max-号池-不限制客户端"
);
assert.equal(wawazzClaudeMaxOpus.availability_seven_day_rate, 0.981636);
assert.equal(wawazzClaudeMaxOpus.availability_seven_day_samples, 1);
assert.match(wawazzClaudeMaxOpus.availability_note, /同分组监测/);
const wawazzProGpt55 = wawazzAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "gpt-pro");
assert.equal(wawazzProGpt55, undefined);
const wawazzProGpt54Mini = wawazzAiTransitSnapshot.offers.find((offer) => offer.standard_model === "GPT 5.4 Mini" && offer.group_name === "gpt-pro");
assert.equal(wawazzProGpt54Mini, undefined);
const wawazzKrioClaude = wawazzAiTransitSnapshot.offers.find((offer) => offer.standard_model === "Claude Opus 4.8" && offer.group_name === "claude-krio");
assert.equal(wawazzKrioClaude.model_multiplier, 0.3);
assert.equal(wawazzKrioClaude.account_pool, "kiro");
assert.equal(wawazzKrioClaude.channel_type, "mixed");
assert.equal(wawazzKrioClaude.cache_hit_rate, 0.884978);
assert.equal(wawazzKrioClaude.cache_hit_sample_tokens, 63_751_220);
const wawazzKrioPowerClaude = wawazzAiTransitSnapshot.offers.find((offer) => offer.standard_model === "Claude Opus 4.8" && offer.group_name === "claude-krio-power");
assert.equal(wawazzKrioPowerClaude.model_multiplier, 0.4);
assert.equal(wawazzKrioPowerClaude.account_pool, "kiro");
assert.equal(wawazzKrioPowerClaude.channel_type, "mixed");
const wawazzMaxClaude = wawazzAiTransitSnapshot.offers.find((offer) => offer.standard_model === "Claude Opus 4.8" && offer.group_name === "claude-max-号池-不限制客户端");
assert.equal(wawazzMaxClaude.model_multiplier, 1.3);
assert.equal(wawazzMaxClaude.account_pool, "max");
assert.equal(wawazzMaxClaude.channel_type, "mixed");
assert.equal(wawazzMaxClaude.cache_hit_rate, 0.860592);

const onehopSource = {
  id: "onehop-ai",
  name: "OneHop",
  websiteUrl: "https://onehop.ai/",
  apiBaseUrl: "https://api.onehop.ai/v1",
  pricingUrl: "https://onehop.ai/platform/models",
  pricingEndpointUrl: "https://api.onehop.ai/public/models?locale=zh-Hans&limit=100",
  collectorKind: "onehop_public_models",
  rechargeRatio: "6.8:1",
};
const onehop = __test.parseOneHopPublicModelsPayload(
  onehopSource,
  {
    data: {
      items: [
        {
          fullSlug: "zhipu/glm-5.2",
          displayName: "GLM-5.2",
          provider: "zhipu",
          source: "Official",
          inputPricePer1m: "0.70000000",
          outputPricePer1m: "2.20000000",
          officialInputPricePer1m: "1.40000000",
          officialOutputPricePer1m: "4.40000000",
          available: true,
          displayMetrics: {
            uptime14d: [{ day: "2026-06-30", rate: 0.99 }],
          },
        },
        {
          fullSlug: "deepseek/deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          provider: "deepseek",
          source: "Official",
          inputPricePer1m: "0.11200000",
          outputPricePer1m: "0.22400000",
          officialInputPricePer1m: "0.14000000",
          officialOutputPricePer1m: "0.28000000",
          available: true,
        },
      ],
    },
  },
  "2026-07-02T07:30:00.000Z",
);
const onehopGlm = onehop.offers.find((offer) => offer.standard_model === "GLM-5.2");
assert.equal(onehopGlm.model_multiplier, 0.0875);
assert.equal(onehopGlm.input_price, 0.0875);
assert.equal(onehopGlm.output_price, 0.078571);
assert.equal(onehopGlm.last_verified_at, "2026-07-02T07:30:00.000Z");
const onehopDeepSeek = onehop.offers.find((offer) => offer.standard_model === "DeepSeek V4 Flash");
assert.equal(onehopDeepSeek.model_multiplier, 0.112);
assert.equal(onehopDeepSeek.output_price, 0.112);

const stationRefresh = __test.mergeStationForRefresh(
  { id: "apinode-ltd", station_system: "sub_to_api", published: true, data_status: "verified" },
  { id: "apinode-ltd", station_system: "custom", published: true },
  {},
);
assert.equal(stationRefresh.station_system, "custom");

const stationRefreshFromUnknown = __test.mergeStationForRefresh(
  { id: "wawazz-xyz", station_system: "sub_to_api", operator_type: "individual", invoice_support: "supported" },
  { id: "wawazz-xyz", station_system: "unknown", operator_type: "unknown", invoice_support: "unknown", published: true },
  {},
);
assert.equal(stationRefreshFromUnknown.station_system, "sub_to_api");
assert.equal(stationRefreshFromUnknown.operator_type, "individual");
assert.equal(stationRefreshFromUnknown.invoice_support, "supported");

const stationRefreshPrefersPublicStatusEvidence = __test.mergeStationForRefresh(
  {
    id: "sub-callai-one",
    availability_source_type: "public_status",
    availability_seven_day_rate: 0,
    availability_seven_day_samples: 3,
    availability_note: "ai-transit 公开快照监测汇总。",
  },
  {
    id: "sub-callai-one",
    availability_source_type: "priceai_probe",
    availability_source_label: "PriceAI 实测",
    availability_seven_day_rate: 0.992,
    availability_seven_day_samples: 250,
    availability_note: "PriceAI API Key 探测：近 7 日 站点 248/250 个样本成功。",
    published: true,
  },
  {},
);
assert.equal(stationRefreshPrefersPublicStatusEvidence.availability_source_type, "public_status");
assert.equal(stationRefreshPrefersPublicStatusEvidence.availability_seven_day_samples, 3);

const zivvParsed = __test.parseZivvModelHubPayload(
  {
    id: "zivv-pro",
    name: "Zivv",
    websiteUrl: "https://zivv.pro/",
    apiBaseUrl: "https://zivv.pro/v1",
    pricingUrl: "https://zivv.pro/model-hub",
    pricingEndpointUrl: "https://zivv.pro/api/models/hub",
    collectorKind: "zivv_model_hub",
    rechargeRatio: "1:1",
  },
  {
    data: [
      {
        id: "gpt-5.5",
        quota_type: 1,
        groups: [
          { name: "Codex Plus", input_rate: 0.45, output_rate: 2.7, cache_read_rate: 0.045, cache_write_rate: 0.045 },
          { name: "Codex Pro", input_rate: 0.7, output_rate: 4.2, cache_read_rate: 0.07, cache_write_rate: 0.07 },
        ],
      },
      {
        id: "claude-sonnet-4-6",
        quota_type: 1,
        groups: [
          { name: "Claude MAX", input_rate: 3, output_rate: 15, cache_read_rate: 0.3, cache_write_rate: 3.75 },
          { name: "Claude Anti【目前不稳定】", input_rate: 2.6, output_rate: 13, cache_read_rate: 0.26, cache_write_rate: 3.25 },
        ],
      },
      {
        id: "gpt-image-2",
        quota_type: 2,
        fixed_price: 0.08,
        groups: [
          { name: "GPT Image", multiplier: 1, fixed_price: 0.08 },
          { name: "GPT Image Pro", multiplier: 1.5, fixed_price: 0.12 },
        ],
      },
      {
        id: "happyhorse-1.1-i2v",
        provider: "aliyun",
        quota_type: 5,
        capabilities: ["video"],
        features: ["video"],
        video_rate_720p: 0.45,
        video_rate_1080p: 0.6,
        groups: [
          {
            id: 25,
            name: "HappyHorse",
            description: "官方直连",
            multiplier: 0.5,
            video_rate_720p: 0.45,
            video_rate_1080p: 0.6,
          },
        ],
      },
    ],
  },
  "2026-06-30T08:00:00.000Z",
);

const zivvStableSampleId = __test.buildAvailabilitySampleRow({
  stationId: "zivv-pro",
  scope: "offer",
  standardModel: "GPT 5.5",
  groupName: "Codex Pro",
  ok: true,
  checkedAt: "2026-06-30T08:00:00.000Z",
  index: 1,
  availabilitySource: { type: "public_status", label: "公开监测页" },
}).id;
assert.equal(
  __test.buildAvailabilitySampleRow({
    stationId: "zivv-pro",
    scope: "offer",
    standardModel: "GPT 5.5",
    groupName: "Codex Pro",
    ok: false,
    checkedAt: "2026-06-30T08:00:00.000Z",
    index: 99,
    availabilitySource: { type: "public_status", label: "公开监测页" },
  }).id,
  zivvStableSampleId,
);
assert.notEqual(
  __test.buildAvailabilitySampleRow({
    stationId: "zivv-pro",
    scope: "offer",
    standardModel: "GPT 5.5",
    groupName: "Codex Pro",
    ok: true,
    checkedAt: "2026-06-30T08:00:00.000Z",
    index: 1,
    availabilitySource: { type: "priceai_probe", label: "PriceAI 实测" },
  }).id,
  zivvStableSampleId,
);

__test.applyZivvStatusAvailability(
  { id: "zivv-pro", collectorKind: "zivv_model_hub" },
  zivvParsed,
  {
    services: [
      {
        name: "Codex Plus&Pro",
        model: "gpt-5.5",
        current: { ok: true, timestamp: "2026-06-30T08:00:00.000Z" },
        uptime_percent: 100,
        history: [
          { timestamp: "2026-06-30T07:55:00.000Z", ok: true, latency_ms: 1500 },
          { timestamp: "2026-06-30T08:00:00.000Z", ok: true, latency_ms: 1600 },
        ],
      },
      {
        name: "Codex Pro",
        model: "gpt-5.5",
        current: { ok: true, timestamp: "2026-06-30T08:00:00.000Z" },
        uptime_percent: 99.5,
        history: [
          { timestamp: "2026-06-30T07:55:00.000Z", ok: true, latency_ms: 1200 },
          { timestamp: "2026-06-30T08:00:00.000Z", ok: false, error: "timeout" },
        ],
      },
      {
        name: "Claude MAX",
        model: "claude-sonnet-4-6",
        current: { ok: true, timestamp: "2026-06-30T08:00:00.000Z" },
        uptime_percent: 90,
        history: [
          { timestamp: "2026-06-30T08:00:00.000Z", ok: true, latency_ms: 1800 },
        ],
      },
      {
        name: "Antigravity Claude",
        model: "claude-sonnet-4-6",
        current: { ok: false, timestamp: "2026-06-30T08:00:00.000Z" },
        uptime_percent: 73.75,
        history: [
          { timestamp: "2026-06-30T08:00:00.000Z", ok: false, error: "disabled" },
        ],
      },
    ],
  },
  "2026-06-30T08:00:00.000Z",
);

assert.equal(zivvParsed.station.availability_seven_day_samples, 6);
assert.equal(zivvParsed.station.availability_source_type, "public_status");
assert.equal(zivvParsed.station.availability_source_label, "公开监测页");
assert.equal(zivvParsed.availabilitySamples.length, 11);
assert.equal(zivvParsed.availabilitySamples[0].source_type, "public_status");
assert.equal(zivvParsed.collectionError, null);
const codexProOffer = zivvParsed.offers.find((offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "Codex Pro");
assert.equal(codexProOffer.availability_seven_day_samples, 2);
assert.equal(codexProOffer.availability_seven_day_rate, 0.995);
assert.equal(codexProOffer.availability_source_type, "public_status");
const codexPlusOffer = zivvParsed.offers.find((offer) => offer.standard_model === "GPT 5.5" && offer.group_name === "Codex Plus");
assert.equal(codexPlusOffer.availability_seven_day_samples, 2);
assert.equal(codexPlusOffer.availability_seven_day_rate, 1);
assert.equal(codexPlusOffer.availability_source_type, "public_status");
const claudeAntiOffer = zivvParsed.offers.find((offer) => offer.standard_model === "Claude Sonnet 4.6" && offer.group_name === "Claude Anti【目前不稳定】");
assert.equal(claudeAntiOffer.availability_seven_day_rate, null);
assert.equal(claudeAntiOffer.availability_seven_day_samples, 0);
assert.equal(claudeAntiOffer.availability_first_checked_at, null);
assert.equal(claudeAntiOffer.availability_last_checked_at, null);
assert.equal(claudeAntiOffer.availability_source_type, "public_status");
const zivvImageOffer = zivvParsed.offers.find((offer) => offer.standard_model === "GPT Image 2" && offer.group_name === "GPT Image");
assert.equal(zivvImageOffer.billing_mode, "fixed");
assert.equal(zivvImageOffer.model_multiplier, null);
assert.equal(zivvImageOffer.fixed_price, 0.08);
assert.equal(zivvImageOffer.fixed_price_unit, "image");
const zivvHappyHorseOffer = zivvParsed.offers.find((offer) => offer.standard_model === "HappyHorse 1.1 I2V" && offer.group_name === "HappyHorse");
assert.equal(zivvHappyHorseOffer.family, "video");
assert.equal(zivvHappyHorseOffer.billing_mode, "fixed");
assert.equal(zivvHappyHorseOffer.model_multiplier, null);
assert.equal(zivvHappyHorseOffer.fixed_price, 0.45);
assert.equal(zivvHappyHorseOffer.fixed_price_unit, "video");
assert.deepEqual(zivvHappyHorseOffer.fixed_price_tiers, [
  { label: "720P", price: 0.45, unit: "video" },
  { label: "1080P", price: 0.6, unit: "video" },
]);

console.log("api transit collector refresh test passed");
