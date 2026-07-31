#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __test } from "./probe-api-transit.mjs";
import { __test as sub2ApiTest } from "./import-sub2api-api-transit.mjs";

const probeProfiles = JSON.parse(
  readFileSync(new URL("../config/api-transit-probes.json", import.meta.url), "utf8"),
);
const claudeProbeModels = {
  "Claude Sonnet 5": "claude-sonnet-5",
  "Claude Sonnet 4.6": "claude-sonnet-4-6",
  "Claude Opus 4.8": "claude-opus-4-8",
};

assert.equal(__test.normalizeFamily("google/gemini-3.5-flash"), "gemini");
assert.equal(__test.normalizeFamily("zhipu/glm-5.2"), "glm");
assert.equal(__test.normalizeFamily("deepseek-v4-pro"), "deepseek");
assert.equal(__test.normalizeFamily("moonshot/kimi-k3"), "kimi");
assert.equal(__test.normalizeFamily("qwen3.8-max-preview"), "qwen");
assert.equal(__test.normalizeFamily("nano-banana-pro"), "image");
assert.equal(__test.normalizeFamily("sora-2-pro"), "video");
assert.equal(__test.normalizeFamily("happyhorse-1.1-i2v"), "video");
assert.equal(__test.normalizeFamily("kling-2.5-turbo"), "video");
assert.equal(
  __test.credentialEncryptionSecret({ dedicatedSecret: "dedicated-key", adminSecret: "admin-key" }),
  "dedicated-key",
);
assert.equal(
  __test.credentialEncryptionSecret({ dedicatedSecret: "", adminSecret: "admin-key" }),
  "priceai:api-transit-credentials:v1:admin-key",
);

assert.deepEqual(__test.keywordsForStandardModel("Claude Sonnet 5"), ["claude", "sonnet", "5"]);
assert.deepEqual(__test.keywordsForStandardModel("Claude Fable 5"), ["claude", "fable", "5"]);
assert.deepEqual(__test.keywordsForStandardModel("Gemini 3.1 Pro"), ["gemini", "pro", "3.1"]);
assert.deepEqual(__test.keywordsForStandardModel("DeepSeek V4 Flash"), ["deepseek", "flash", "4"]);
assert.deepEqual(__test.keywordsForStandardModel("Nano Banana"), ["nano", "banana"]);
assert.deepEqual(__test.keywordsForStandardModel("Nano Banana Lite"), ["nano", "banana", "lite"]);
assert.deepEqual(__test.keywordsForStandardModel("Sora 2 Pro"), ["sora", "pro", "2"]);
assert.deepEqual(__test.keywordsForStandardModel("HappyHorse 1.1 I2V"), ["happyhorse", "1.1"]);
assert.deepEqual(__test.keywordsForStandardModel("Kimi K3"), ["kimi", "3"]);
assert.deepEqual(__test.keywordsForStandardModel("Qwen3.8-Max-Preview"), ["qwen", "max", "preview", "3.8"]);

assert.deepEqual(
  sub2ApiTest
    .standardModelsFromAvailableModels(["kimi-k3", "qwen3.8-max-preview", "qwen3.7-max"])
    .map((model) => [model.family, model.standardModel, model.rawModelName]),
  [
    ["kimi", "Kimi K3", "kimi-k3"],
    ["qwen", "Qwen3.8-Max-Preview", "qwen3.8-max-preview"],
    ["qwen", "Qwen3.7-Max", "qwen3.7-max"],
  ],
);

assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "Moonshot Kimi K3", platform: "openai" }),
  { family: "kimi", standardModel: "Kimi K3", rawModelName: "kimi-k3" },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "百炼 Qwen3.7 Max", platform: "openai" }),
  { family: "qwen", standardModel: "Qwen3.7-Max", rawModelName: "qwen3.7-max" },
);

const unpricedPreviewOffer = sub2ApiTest.buildOfferRows(
  { id: "preview", dashboardUrl: "https://example.test/dashboard" },
  [],
  [{
    groupId: 1,
    groupName: "Qwen Preview",
    multiplier: 0.2,
    ok: true,
    family: "qwen",
    standardModel: "Qwen3.8-Max-Preview",
    rawModelName: "qwen3.8-max-preview",
    sampleModels: ["qwen3.8-max-preview"],
  }],
  "2026-07-20T00:00:00.000Z",
)[0];
assert.equal(unpricedPreviewOffer.model_multiplier, null);
assert.equal(unpricedPreviewOffer.input_price, null);
assert.equal(unpricedPreviewOffer.raw_payload.group.multiplier, 0.2);

const claudeTargets = __test.selectProbeTargets({
  profileFamily: "claude",
  configuredTargets: [],
  offerModels: [],
  availableModels: ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8"],
  targetLimit: 2,
});
assert.deepEqual(
  claudeTargets.map((target) => [target.family, target.standardModel, target.modelId]),
  [
    ["claude", "Claude Sonnet 5", "claude-sonnet-5"],
    ["claude", "Claude Opus 4.8", "claude-opus-4-8"],
  ],
  "Default Claude probes should not use Fable 5 as a high-frequency availability target.",
);

const lowestCostClaudeTargets = __test.selectProbeTargets({
  profileFamily: "claude",
  targetPriority: "lowest_cost_available",
  configuredTargets: [
    {
      family: "claude",
      standardModel: "Claude Opus 4.8",
      candidates: ["claude-opus-4-8"],
      keywords: ["claude", "opus", "4.8"],
    },
    {
      family: "claude",
      standardModel: "Claude Sonnet 4.6",
      candidates: ["claude-sonnet-4-6"],
      keywords: ["claude", "sonnet", "4.6"],
    },
    {
      family: "claude",
      standardModel: "Claude Sonnet 5",
      candidates: ["claude-sonnet-5"],
      keywords: ["claude", "sonnet", "5"],
    },
    {
      family: "claude",
      standardModel: "Claude Fable 5",
      candidates: ["claude-fable-5"],
      keywords: ["claude", "fable", "5"],
    },
  ],
  offerModels: [],
  availableModels: ["claude-fable-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-8"],
  targetLimit: 1,
});
assert.deepEqual(
  lowestCostClaudeTargets.map((target) => [target.standardModel, target.modelId]),
  [["Claude Sonnet 5", "claude-sonnet-5"]],
  "Lowest-cost availability probes should skip Fable 5 and choose the cheapest configured available model.",
);
const dbFableClaudeTargets = __test.selectProbeTargets({
  profileFamily: "claude",
  targetPriority: "lowest_cost_available",
  configuredTargets: [],
  offerModels: [
    {
      family: "claude",
      standard_model: "Claude Fable 5",
      raw_model_name: "claude-fable-5",
    },
  ],
  availableModels: ["claude-fable-5", "claude-sonnet-5"],
  targetLimit: 1,
});
assert.deepEqual(
  dbFableClaudeTargets.map((target) => [target.standardModel, target.modelId]),
  [["Claude Sonnet 5", "claude-sonnet-5"]],
  "DB-discovered Fable 5 offers should not become high-frequency availability probe targets.",
);

const enabledFableProbeProfiles = probeProfiles.filter(
  (profile) =>
    profile.enabled !== false &&
    (profile.targets || []).some((target) =>
      [target.standardModel, ...(target.candidates || []), ...(target.keywords || [])]
        .join(" ")
        .toLowerCase()
        .includes("fable"),
    ),
);
assert.deepEqual(
  enabledFableProbeProfiles.map((profile) => profile.profileId || profile.stationId),
  [],
  "Enabled high-frequency PriceAI probe profiles must not include Fable 5 targets.",
);

const enabledClaudeProbeProfiles = probeProfiles.filter(
  (profile) =>
    profile.enabled !== false &&
    (profile.targets || []).some((target) => target.family === "claude"),
);
assert.ok(enabledClaudeProbeProfiles.length > 0, "Claude probe profiles should exist.");
for (const profile of enabledClaudeProbeProfiles) {
  const selectedTargets = __test.selectProbeTargets({
    profileFamily: "claude",
    targetPriority: profile.targetPriority,
    configuredTargets: profile.targets,
    offerModels: [],
    availableModels: ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6"],
    targetLimit: profile.targetLimit,
  });
  const expectedStandardModel = ["Claude Sonnet 5", "Claude Sonnet 4.6", "Claude Opus 4.8"].find((standardModel) =>
    (profile.targets || []).some((target) => target.standardModel === standardModel),
  );
  assert.deepEqual(
    selectedTargets.map((target) => [target.standardModel, target.modelId]),
    [[expectedStandardModel, claudeProbeModels[expectedStandardModel]]],
    `${profile.profileId || profile.stationId} monitoring should use the lowest-cost configured Claude model.`,
  );
}

const enabledGptProbeProfiles = probeProfiles.filter(
  (profile) =>
    profile.enabled !== false &&
    profile.targetPriority === "lowest_cost_available" &&
    (profile.targets || []).some((target) => target.family === "gpt"),
);
assert.ok(enabledGptProbeProfiles.length > 0, "GPT lowest-cost probe profiles should exist.");
for (const profile of enabledGptProbeProfiles) {
  const selectedTargets = __test.selectProbeTargets({
    profileFamily: "gpt",
    targetPriority: profile.targetPriority,
    configuredTargets: profile.targets,
    offerModels: [],
    availableModels: ["gpt-5.5", "gpt-5.4"],
    targetLimit: profile.targetLimit,
  });
  assert.deepEqual(
    selectedTargets.map((target) => [target.standardModel, target.modelId]),
    [["GPT 5.4", "gpt-5.4"]],
    `${profile.profileId || profile.stationId} monitoring should use the lowest-cost configured GPT model.`,
  );
}

assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "Claude Fable 5 池", platform: "anthropic" }),
  {
    family: "claude",
    standardModel: "Claude Fable 5",
    rawModelName: "claude-fable-5",
  },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "Claude Sonnet 5 池", platform: "anthropic" }),
  {
    family: "claude",
    standardModel: "Claude Sonnet 5",
    rawModelName: "claude-sonnet-5",
  },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "Claude Sonnet 池", platform: "anthropic" }),
  {
    family: "claude",
    standardModel: "Claude Sonnet 4.6",
    rawModelName: "claude-sonnet-4-6",
  },
);
assert.deepEqual(
  sub2ApiTest
    .standardModelsFromAvailableModels(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "claude-fable-5", "claude-opus-4-8"])
    .map((model) => [model.family, model.standardModel, model.rawModelName]),
  [
    ["gpt", "GPT 5.5", "gpt-5.5"],
    ["gpt", "GPT 5.4", "gpt-5.4"],
    ["gpt", "GPT 5.4 Mini", "gpt-5.4-mini"],
    ["claude", "Claude Fable 5", "claude-fable-5"],
    ["claude", "Claude Opus 4.8", "claude-opus-4-8"],
  ],
);
assert.deepEqual(
  sub2ApiTest
    .modelsForProbeResult({
      family: "claude",
      standardModel: "Claude Opus 4.8",
      rawModelName: "claude-opus-4-8",
      sampleModels: ["claude-fable-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5"],
    })
    .map((model) => model.standardModel),
  ["Claude Fable 5", "Claude Opus 4.6", "Claude Opus 4.7", "Claude Opus 4.8", "Claude Sonnet 5"],
);

assert.equal(__test.summarizeSamples([]).samples, 0);
assert.equal(__test.summarizeSamples([]).rate, null);
assert.equal(
  __test.availabilitySampleMatchesActiveOfferScope(
    { standard_model: "Claude Opus 4.8", group_name: "kiro" },
    {
      offerKeys: new Set(["claude-opus-4.8|kiro"]),
      modelTokens: new Set(["claude-opus-4.8"]),
    },
  ),
  true,
  "Probe rollups should keep matching CallAI's normalized Kiro group after ai-transit snapshot ingestion.",
);
assert.equal(
  __test.availabilitySampleMatchesActiveOfferScope(
    { standard_model: "GPT 5.5", group_name: "gpt" },
    {
      offerKeys: new Set(["gpt-5.5|gpt"]),
      modelTokens: new Set(["gpt-5.5"]),
    },
  ),
  true,
  "Offer rollups should match CallAI's source-native GPT group.",
);
assert.equal(
  __test.availabilitySampleMatchesActiveOfferScope(
    { standard_model: "GPT 5.5", group_name: "gpt" },
    {
      offerKeys: new Set(["gpt-5.5|gpt"]),
      modelTokens: new Set(["gpt-5.5"]),
    },
    { allowModelFallbackWithGroup: true },
  ),
  true,
  "Station rollups should keep historical samples when a source renames the active group.",
);
const duplicateSub2ApiOffers = sub2ApiTest.buildOfferRows(
  { id: "neko", dashboardUrl: "https://example.test/dashboard" },
  [{ id: 6, name: "CC MAX官转", platform: "anthropic", multiplier: 1.5 }],
  [
    {
      targetId: "claude_fable_5",
      family: "claude",
      standardModel: "Claude Fable 5",
      rawModelName: "claude-fable-5",
      groupId: 6,
      groupName: "CC MAX官转",
      multiplier: 1.5,
      ok: true,
      modelListed: true,
      modelListStatus: 200,
      sampleModels: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"],
      attempts: [],
    },
    {
      targetId: "claude",
      family: "claude",
      standardModel: "Claude Opus 4.8",
      rawModelName: "claude-opus-4-8",
      groupId: 6,
      groupName: "CC MAX官转",
      multiplier: 1.5,
      ok: true,
      modelListed: true,
      modelListStatus: 200,
      sampleModels: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"],
      attempts: [],
    },
  ],
  "2026-07-02T00:00:00.000Z",
);
assert.equal(
  new Set(duplicateSub2ApiOffers.map((offer) => `${offer.station_id}|${offer.standard_model}|${offer.group_name}`)).size,
  duplicateSub2ApiOffers.length,
  "Sub2API import must not emit duplicate offer upsert keys.",
);
assert.equal(
  sub2ApiTest.apiTransitOfferStatusForProbeResult({
    groupId: 16,
    multiplier: 0.16,
    ok: false,
    error: "Unsupported parameter: max_output_tokens",
  }),
  "needs_review",
  "Sub2API groups returned by the source must not be hidden after one probe failure.",
);
const failedButReturnedSub2ApiOffers = sub2ApiTest.buildOfferRows(
  { id: "wawazz", dashboardUrl: "https://example.test/dashboard" },
  [{ id: 16, name: "gpt-pro", platform: "openai", multiplier: 0.16 }],
  [
    {
      targetId: "gpt_pro",
      family: "gpt",
      standardModel: "GPT 5.5",
      rawModelName: "gpt-5.5",
      groupId: 16,
      groupName: "gpt-pro",
      multiplier: 0.16,
      ok: false,
      modelListed: true,
      modelListStatus: 200,
      sampleModels: ["gpt-5.5"],
      attempts: [
        {
          ok: false,
          status: 400,
          message: "Unsupported parameter: max_output_tokens",
          parameterMode: "max_tokens",
        },
      ],
      error: "Unsupported parameter: max_output_tokens",
    },
  ],
  "2026-07-03T00:00:00.000Z",
);
assert.equal(failedButReturnedSub2ApiOffers.length, 1);
assert.equal(failedButReturnedSub2ApiOffers[0].status, "needs_review");
assert.equal(failedButReturnedSub2ApiOffers[0].availability_source_label, "PriceAI 实测");
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "gpt-image-2", platform: "openai" }),
  {
    family: "image",
    standardModel: "GPT Image 2",
    rawModelName: "gpt-image-2",
  },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "Nano Banana Lite 生图池", platform: "google" }),
  {
    family: "image",
    standardModel: "Nano Banana Lite",
    rawModelName: "nano-banana-lite",
  },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "gemini-2.5-flash-image 生图池", platform: "google" }),
  {
    family: "image",
    standardModel: "Nano Banana",
    rawModelName: "nano-banana",
  },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "Sora 2 Pro 视频池", platform: "openai" }),
  {
    family: "video",
    standardModel: "Sora 2 Pro",
    rawModelName: "sora-2-pro",
  },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "Kling 2.5 Turbo 视频池", platform: "kling" }),
  {
    family: "video",
    standardModel: "Kling 2.5 Turbo",
    rawModelName: "kling-2.5-turbo",
  },
);
assert.deepEqual(
  sub2ApiTest.representativeModelForGroup({ name: "HappyHorse 官方直连 视频池", platform: "aliyun" }),
  {
    family: "video",
    standardModel: "HappyHorse 1.1 I2V",
    rawModelName: "happyhorse-1.1-i2v",
  },
);
assert.deepEqual(
  sub2ApiTest
    .standardModelsFromAvailableModels([
      "nano-banana-pro",
      "nano-banana-2",
      "gemini-2.5-flash-image",
      "sora-2-pro",
      "veo-3.1-lite",
      "gemini-omni-flash",
      "seedance-2.0",
      "alibaba/hh1.1-i2v",
      "kling-2.5-turbo",
    ])
    .map((model) => [model.family, model.standardModel, model.rawModelName]),
  [
    ["image", "Nano Banana Pro", "nano-banana-pro"],
    ["image", "Nano Banana 2", "nano-banana-2"],
    ["image", "Nano Banana", "gemini-2.5-flash-image"],
    ["video", "Sora 2 Pro", "sora-2-pro"],
    ["video", "Veo 3.1 Lite", "veo-3.1-lite"],
    ["video", "Gemini Omni Flash", "gemini-omni-flash"],
    ["video", "Seedance 2.0", "seedance-2.0"],
    ["video", "HappyHorse 1.1 I2V", "alibaba/hh1.1-i2v"],
    ["video", "Kling 2.5 Turbo", "kling-2.5-turbo"],
  ],
);

const geminiTargets = __test.selectProbeTargets({
  profileFamily: "gemini",
  configuredTargets: [],
  offerModels: [],
  availableModels: ["google/gemini-3.1-pro-preview", "google/gemini-3.5-flash"],
  targetLimit: 4,
});
assert.deepEqual(
  geminiTargets.map((target) => [target.family, target.standardModel, target.modelId]),
  [
    ["gemini", "Gemini 3.5 Flash", "google/gemini-3.5-flash"],
    ["gemini", "Gemini 3.1 Pro", "google/gemini-3.1-pro-preview"],
  ],
);

const deepseekTargets = __test.selectProbeTargets({
  profileFamily: "deepseek",
  configuredTargets: [],
  offerModels: [],
  availableModels: ["deepseek/deepseek-v4-pro"],
  targetLimit: 4,
});
assert.deepEqual(
  deepseekTargets.map((target) => [target.family, target.standardModel, target.modelId]),
  [
    ["deepseek", "DeepSeek V4 Pro", "deepseek/deepseek-v4-pro"],
    ["deepseek", "DeepSeek V4 Flash", null],
  ],
);

const profiles = [
  { stationId: "published-with-key", profileId: "published-with-key-gpt" },
  { stationId: "pending-with-key", profileId: "pending-with-key-claude" },
  { stationId: "public-pricing-only", profileId: "public-pricing-only" },
];
assert.deepEqual(
  __test.filterProfilesByRunnableStationIds(profiles, new Set(["published-with-key", "pending-with-key"])),
  profiles.slice(0, 2),
);
assert.deepEqual(
  Array.from(
    __test.filterStationIdsWithoutPublicStatus(
      new Set(["published-with-key", "pending-with-key", "public-monitored"]),
      new Set(["public-monitored"]),
    ),
  ),
  ["published-with-key", "pending-with-key"],
);
assert.equal(__test.shouldRestrictToRunnableStations({ post: true }), true);
assert.equal(__test.shouldRestrictToRunnableStations({ post: true, station: "pending-with-key" }), false);
assert.equal(__test.shouldRestrictToRunnableStations({ post: true, dryRun: true }), false);

assert.deepEqual(__test.completionBody({ protocol: "anthropic_compatible" }, "claude-opus-4-8"), {
  model: "claude-opus-4-8",
  max_tokens: 1,
  messages: [{ role: "user", content: "ping" }],
});
const lightweightClaudeProbeBody = __test.completionBody({ protocol: "openai_compatible" }, "claude-sonnet-5");
assert.equal(JSON.stringify(lightweightClaudeProbeBody).includes("cache_control"), false);
assert.equal(JSON.stringify(lightweightClaudeProbeBody).includes("cache"), false);
assert.ok(
  JSON.stringify(lightweightClaudeProbeBody).length < 140,
  "Availability probe bodies must stay tiny; large prompt/cache creation belongs outside high-frequency monitoring.",
);
assert.deepEqual(__test.completionBody({ protocol: "openai_compatible" }, "gpt-5.5"), {
  model: "gpt-5.5",
  messages: [{ role: "user", content: "ping" }],
  max_tokens: 1,
  stream: false,
});
assert.deepEqual(
  __test.completionAttempts({ protocol: "openai_compatible" }, "gpt-5.5").map((attempt) => [
    attempt.parameterMode,
    Object.keys(attempt.body).sort(),
  ]),
  [
    ["max_tokens", ["max_tokens", "messages", "model", "stream"]],
    ["max_completion_tokens", ["max_completion_tokens", "messages", "model", "stream"]],
    ["minimal", ["messages", "model"]],
  ],
);
assert.deepEqual(
  __test.completionAttempts({ protocol: "anthropic_compatible" }, "claude-opus-4-8").map((attempt) => attempt.parameterMode),
  ["max_tokens"],
);

assert.equal(
  __test.isParameterCompatibilityFailure([
    { ok: false, status: 400, message: "Unsupported parameter: max_output_tokens", parameterMode: "max_tokens" },
    { ok: false, status: 400, message: "Unsupported parameter: max_output_tokens", parameterMode: "max_completion_tokens" },
  ]),
  true,
  "Probe request parameter compatibility failures are diagnostics, not merchant availability failures.",
);
assert.equal(
  __test.isParameterCompatibilityFailure([
    { ok: false, status: 400, message: "Unsupported model", parameterMode: "max_tokens" },
  ]),
  false,
  "Generic unsupported errors can still reflect real model availability.",
);

const probeSamples = __test.availabilitySamplesFromProbe({
  runId: "run-1",
  stationId: "station-1",
  checkedAt: "2026-06-30T08:00:00.000Z",
  targetResults: [
    {
      standardModel: "GPT 5.4",
      groupName: "Pro",
      ok: true,
      checkedAt: "2026-06-30T08:00:00.000Z",
    },
  ],
});
assert.equal(probeSamples.length, 2);
assert.equal(probeSamples[0].source_type, "priceai_probe");
assert.equal(probeSamples[0].source_label, "PriceAI 实测");
const fableProbeSamples = __test.availabilitySamplesFromProbe({
  runId: "run-fable",
  stationId: "station-1",
  checkedAt: "2026-07-07T08:00:00.000Z",
  modelList: { ok: true },
  targetResults: [
    {
      standardModel: "Claude Fable 5",
      groupName: "CC MAX官转",
      ok: true,
      checkedAt: "2026-07-07T08:00:00.000Z",
    },
  ],
});
assert.equal(
  fableProbeSamples.length,
  0,
  "Fable 5 probe results should not create high-frequency availability samples.",
);

const diagnosticOnlyProbeSamples = __test.availabilitySamplesFromProbe({
  runId: "run-parameter-diagnostic",
  stationId: "station-1",
  checkedAt: "2026-07-03T08:00:00.000Z",
  targetResults: [
    {
      standardModel: "GPT 5.5",
      groupName: "gpt-plus",
      ok: false,
      countsTowardAvailability: false,
      diagnosticOnly: true,
      errorType: "request_failed",
      message: "Unsupported parameter: max_output_tokens",
      checkedAt: "2026-07-03T08:00:00.000Z",
    },
  ],
});
assert.equal(
  diagnosticOnlyProbeSamples.length,
  0,
  "Diagnostic-only probe failures must not create availability samples.",
);

assert.equal(__test.isCredentialDiagnosticFailure({ status: 402, message: "Insufficient account balance" }), true);
assert.equal(__test.isCredentialDiagnosticFailure({ status: 400, message: "API Key 所属分组已停用" }), true);
assert.equal(__test.isCredentialDiagnosticFailure({ status: 500, message: "HTTP 502" }), false);

const credentialOnlyProbeSamples = __test.availabilitySamplesFromProbe({
  runId: "run-empty-balance",
  stationId: "station-1",
  checkedAt: "2026-07-07T08:00:00.000Z",
  modelList: {
    ok: false,
    message: "Insufficient account balance",
    countsTowardAvailability: false,
    diagnosticOnly: true,
  },
  targetResults: [],
});
assert.equal(
  credentialOnlyProbeSamples.length,
  0,
  "Credential or billing preflight failures must not create public availability samples.",
);

const upstreamModelListSamples = __test.availabilitySamplesFromProbe({
  runId: "run-model-list-upstream",
  stationId: "station-1",
  checkedAt: "2026-07-07T08:00:00.000Z",
  modelList: {
    ok: false,
    message: "HTTP 502",
  },
  targetResults: [],
});
assert.equal(
  upstreamModelListSamples.length,
  1,
  "Non-credential model-list failures can still create station availability samples.",
);

assert.equal(
  __test.availabilitySampleMatchesActiveOfferScope(
    { scope: "station", standard_model: null, group_name: null },
    { offerKeys: new Set(["gpt 5.5|pro"]), modelTokens: new Set(["gpt 5.5"]) },
  ),
  false,
  "Generic station-only samples must not roll up into stations with active public offers.",
);
assert.equal(
  __test.availabilitySampleMatchesActiveOfferScope(
    { scope: "station", standard_model: null, group_name: null },
    { offerKeys: new Set(), modelTokens: new Set() },
  ),
  true,
  "Generic station-only samples can still apply before active public offers exist.",
);

console.log("api transit probe target test passed");
