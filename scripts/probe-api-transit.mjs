#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { safeFetch } from "./safe-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "config", "api-transit-probes.json");
const envPath = path.join(repoRoot, ".env.local");

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_TARGET_LIMIT = 4;
const MAX_MODELS_SNAPSHOT = 200;
const AVAILABILITY_SAMPLE_LOOKBACK_LIMIT = 2000;
const PUBLIC_STATUS_SAMPLE_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const PUBLIC_STATUS_AVAILABILITY_SOURCE_TYPE = "public_status";
const HIGH_COST_AVAILABILITY_PROBE_MODELS = new Set(["Claude Fable 5"]);
const AVAILABILITY_PROBE_MODEL_COSTS = {
  "Claude Sonnet 5": 2,
  "Claude Sonnet 4.6": 3,
  "Claude Opus 4.6": 5,
  "Claude Opus 4.7": 5,
  "Claude Opus 4.8": 5,
  "GPT 5.6 Sol": 5,
  "GPT 5.6 Terra": 2.5,
  "GPT 5.6 Luna": 1,
  "GPT 5.4": 2.5,
  "GPT 5.4 Mini": 0.75,
  "GPT 5.5": 5,
  "Gemini 3.5 Flash": 1.5,
  "Gemini 3.1 Pro": 4,
  "GLM-5.1": 0.2,
  "GLM-5.2": 0.3,
  "DeepSeek V4 Flash": 0.05,
  "DeepSeek V4 Pro": 0.28,
  "Kimi K3": 20,
  "Qwen3.7-Max": 12,
};
const PRICEAI_PROBE_AVAILABILITY_SOURCE = {
  type: "priceai_probe",
  label: "PriceAI 实测",
};
const userAgent = "Mozilla/5.0 PriceAI/1.0 APITransitProbe";
let cachedFileEnv = null;

const defaultTargets = [
  {
    family: "claude",
    standardModel: "Claude Sonnet 5",
    candidates: [
      "claude-sonnet-5",
      "claude-sonnet-5-0",
      "claude-5-sonnet",
      "anthropic/claude-sonnet-5",
    ],
    keywords: ["claude", "sonnet", "5"],
  },
  {
    family: "claude",
    standardModel: "Claude Sonnet 4.6",
    candidates: [
      "claude-sonnet-4.6",
      "claude-sonnet-4-6",
      "claude-4.6-sonnet",
    ],
    keywords: ["claude", "sonnet", "4-6"],
  },
  {
    family: "claude",
    standardModel: "Claude Opus 4.6",
    candidates: [
      "claude-opus-4.6",
      "claude-opus-4-6",
      "claude-4.6-opus",
    ],
    keywords: ["claude", "opus", "4-6"],
  },
  {
    family: "claude",
    standardModel: "Claude Opus 4.7",
    candidates: ["claude-opus-4.7", "claude-opus-4-7", "claude-4.7-opus"],
    keywords: ["claude", "opus", "4.7"],
  },
  {
    family: "claude",
    standardModel: "Claude Opus 4.8",
    candidates: ["claude-opus-4.8", "claude-opus-4-8", "claude-4.8-opus"],
    keywords: ["claude", "opus", "4.8"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.6 Sol",
    candidates: ["gpt-5.6-sol", "gpt-5-6-sol"],
    keywords: ["gpt", "5.6", "sol"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.6 Terra",
    candidates: ["gpt-5.6-terra", "gpt-5-6-terra"],
    keywords: ["gpt", "5.6", "terra"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.6 Luna",
    candidates: ["gpt-5.6-luna", "gpt-5-6-luna"],
    keywords: ["gpt", "5.6", "luna"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.5",
    candidates: ["gpt-5.5", "gpt-5-5"],
    keywords: ["gpt", "5.5"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.4",
    candidates: ["gpt-5.4", "gpt-5-4"],
    keywords: ["gpt", "5.4"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.4 Mini",
    candidates: ["gpt-5.4-mini", "gpt-5-4-mini"],
    keywords: ["gpt", "5.4", "mini"],
  },
  {
    family: "gemini",
    standardModel: "Gemini 3.5 Flash",
    candidates: ["gemini-3.5-flash", "gemini-3-5-flash", "google/gemini-3.5-flash"],
    keywords: ["gemini", "3.5", "flash"],
  },
  {
    family: "gemini",
    standardModel: "Gemini 3.1 Pro",
    candidates: [
      "gemini-3.1-pro",
      "gemini-3-1-pro",
      "gemini-3.1-pro-preview",
      "google/gemini-3.1-pro-preview",
    ],
    keywords: ["gemini", "3.1", "pro"],
  },
  {
    family: "glm",
    standardModel: "GLM-5.2",
    candidates: ["glm-5.2", "glm-5-2", "zhipu/glm-5.2"],
    keywords: ["glm", "5.2"],
  },
  {
    family: "glm",
    standardModel: "GLM-5.1",
    candidates: ["glm-5.1", "glm-5-1", "zhipu/glm-5.1"],
    keywords: ["glm", "5.1"],
  },
  {
    family: "deepseek",
    standardModel: "DeepSeek V4 Flash",
    candidates: ["deepseek-v4-flash", "deepseek-v4-flash-chat", "deepseek/deepseek-v4-flash"],
    keywords: ["deepseek", "v4", "flash"],
  },
  {
    family: "deepseek",
    standardModel: "DeepSeek V4 Pro",
    candidates: ["deepseek-v4-pro", "deepseek-v4-pro-chat", "deepseek/deepseek-v4-pro"],
    keywords: ["deepseek", "v4", "pro"],
  },
  {
    family: "kimi",
    standardModel: "Kimi K3",
    candidates: ["kimi-k3", "moonshot/kimi-k3"],
    keywords: ["kimi", "k3"],
  },
  {
    family: "qwen",
    standardModel: "Qwen3.8-Max-Preview",
    candidates: ["qwen3.8-max-preview", "qwen-3.8-max-preview"],
    keywords: ["qwen", "max", "preview", "3.8"],
  },
  {
    family: "qwen",
    standardModel: "Qwen3.7-Max",
    candidates: ["qwen3.7-max", "qwen-3.7-max", "qwen/qwen3.7-max"],
    keywords: ["qwen", "max", "3.7"],
  },
];

if (isCli()) {
  const options = normalizeOptions(parseArgs(process.argv.slice(2)));

  try {
    const result = await probeApiTransitStations(options);
    printSummary(result);
    if (options.dryRun || options.verbose) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

export async function probeApiTransitStations(options = {}) {
  options = normalizeOptions(options);
  const startedAt = new Date().toISOString();
  const selectedProfiles = selectProfiles(await loadProbeProfilesForRun(options), options);
  const disabledProfiles = selectedProfiles.filter((profile) => !profile.enabled);
  const profiles = selectedProfiles.filter((profile) => profile.enabled);
  const supabase = getSupabaseClient();
  const stationIds = profiles.map((profile) => profile.stationId);
  const dbOfferModels = supabase ? await listOfferModels(supabase, stationIds) : new Map();
  const dbCredentials =
    supabase && options.dbCredentials
      ? await listCredentialApiKeys(supabase, stationIds)
      : emptyCredentialStore();
  const runs = [];
  const rollups = [];
  const skipped = [];

  for (const profile of disabledProfiles) {
    skipped.push(buildSkippedProfile(profile, "profile_disabled"));
  }

  for (const profile of profiles) {
    const envApiKey = options.env?.[profile.apiKeyEnv] || envValue(profile.apiKeyEnv);
    const credential = envApiKey
      ? { apiKey: envApiKey, source: "env", credentialId: null }
      : selectCredentialForProfile(dbCredentials, profile);
    const apiKey = credential?.apiKey || "";
    if (!apiKey) {
      skipped.push(buildSkippedProfile(profile, dbCredentials.unavailableReason || "missing_api_key"));
      continue;
    }

    const run = await probeProfile(profile, {
      apiKey,
      credentialSource: credential.source,
      credentialId: credential.credentialId,
      offerModels: dbOfferModels.get(profile.stationId) || [],
      targetLimit: profile.targetLimit || options.targetLimit,
      skipCompletions: options.skipCompletions,
      timeoutMs: options.timeoutMs,
    });

    runs.push(run);

    if ((options.post || options.db) && !options.dryRun) {
      if (!supabase) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for --post/--db.");
      await upsertRows(supabase, "api_transit_detection_runs", [run.row], { onConflict: "id" });
      await upsertAvailabilitySamples(supabase, run);
      if (credential.credentialId) await markCredentialUsed(supabase, credential.credentialId);
      rollups.push(await refreshAvailabilityRollup(supabase, profile.stationId));
    }
  }

  return {
    dryRun: Boolean(options.dryRun),
    post: Boolean(options.post || options.db),
    source: "api_transit_api_probe",
    startedAt,
    finishedAt: new Date().toISOString(),
    counts: {
      profiles: profiles.length,
      selectedProfiles: selectedProfiles.length,
      probed: runs.length,
      skipped: skipped.length,
      successfulRuns: runs.filter((run) => run.row.status === "success").length,
      failedRuns: runs.filter((run) => run.row.status === "failed").length,
    },
    skipped,
    runs,
    rollups,
  };
}

async function probeProfile(profile, options) {
  const startedAt = new Date().toISOString();
  const baseUrl = normalizeApiBaseUrl(profile.apiBaseUrl);
  const modelList = await probeModelList(profile, baseUrl, options);
  const availableModels = modelList.ok ? modelList.models : [];
  const targets = selectProbeTargets({
    profileFamily: inferProbeProfileFamily(profile),
    configuredTargets: profile.targets || [],
    offerModels: options.offerModels,
    availableModels,
    targetLimit: options.targetLimit,
    targetPriority: profile.targetPriority,
  });

  const targetResults = [];
  if (modelList.ok && !options.skipCompletions) {
    for (const target of targets) {
      if (!target.modelId) {
        targetResults.push({
          family: target.family,
          standardModel: target.standardModel,
          groupName: target.groupName || null,
          accountPool: target.accountPool || null,
          channelType: target.channelType || null,
          configuredModelId: null,
          ok: false,
          skipped: true,
          errorType: "model_not_found",
          message: "模型列表中未匹配到可探测模型。",
          latencyMs: null,
          checkedAt: new Date().toISOString(),
        });
        continue;
      }

      targetResults.push(await probeCompletion(profile, baseUrl, target, options));
    }
  }

  const attemptedTargetResults = targetResults.filter((item) => !item.skipped);
  const okTargets = attemptedTargetResults.filter((item) => item.ok).length;
  const status = runStatus({
    modelListOk: modelList.ok,
    modelCount: availableModels.length,
    attemptedTargets: attemptedTargetResults.length,
    okTargets,
    skippedTargets: targetResults.length - attemptedTargetResults.length,
    skipCompletions: options.skipCompletions,
  });
  const firstError =
    modelList.ok
      ? targetResults.find((item) => item.message)?.message || null
      : modelList.message || "模型列表探测失败。";

  const finishedAt = new Date().toISOString();
  const row = {
    id: stableId("api-transit-probe-run", profile.profileId || profile.stationId, startedAt),
    station_id: profile.stationId,
    run_type: "api_probe",
    status,
    model_count: availableModels.length,
    offer_count: attemptedTargetResults.length,
    error_message: status === "success" ? null : firstError,
    source_url: baseUrl,
    started_at: startedAt,
    finished_at: finishedAt,
    raw_snapshot: {
      protocol: profile.protocol,
      apiKeyEnv: profile.apiKeyEnv,
      modelList: {
        ok: modelList.ok,
        status: modelList.status,
        latencyMs: modelList.latencyMs,
        message: modelList.message,
      },
      availableModelIds: availableModels.slice(0, MAX_MODELS_SNAPSHOT),
      targetResults,
    },
    logs: {
      protocol: profile.protocol,
      profileId: profile.profileId || null,
      apiKeyEnv: profile.apiKeyEnv,
      credentialSource: options.credentialSource || "env",
      credentialId: options.credentialId || null,
      selectedTargets: targets,
      targetLimit: options.targetLimit,
      skipCompletions: Boolean(options.skipCompletions),
    },
  };

  const output = {
    stationId: profile.stationId,
    status,
    modelCount: row.model_count,
    attemptedTargets: row.offer_count,
    okTargets,
    startedAt,
    finishedAt,
    row,
  };
  output.availabilitySamples = availabilitySamplesFromProbe({
    runId: row.id,
    stationId: profile.stationId,
    modelList,
    targetResults,
    checkedAt: finishedAt || startedAt,
  });
  return output;
}

async function probeModelList(profile, baseUrl, options) {
  const started = Date.now();
  try {
    const response = await fetchJson(`${baseUrl}/models`, {
      timeoutMs: options.timeoutMs,
      headers: authHeaders(profile, options.apiKey),
    });
    return {
      ok: true,
      status: response.status,
      latencyMs: Date.now() - started,
      models: normalizeModelIds(response.json),
      message: null,
    };
  } catch (error) {
    const status = error.status || null;
    const message = errorMessage(error);
    const credentialDiagnosticFailure = isCredentialDiagnosticFailure({ status, message });
    return {
      ok: false,
      status,
      latencyMs: Date.now() - started,
      models: [],
      message,
      countsTowardAvailability: !credentialDiagnosticFailure,
      diagnosticOnly: credentialDiagnosticFailure,
    };
  }
}

async function probeCompletion(profile, baseUrl, target, options) {
  const checkedAt = new Date().toISOString();
  const endpoint = profile.protocol === "anthropic_compatible" ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`;
  const attempts = [];

  for (const attempt of completionAttempts(profile, target.modelId)) {
    const started = Date.now();
    try {
      const response = await fetchJson(endpoint, {
        timeoutMs: options.timeoutMs,
        method: "POST",
        headers: {
          ...authHeaders(profile, options.apiKey),
          "content-type": "application/json",
        },
        body: JSON.stringify(attempt.body),
      });

      attempts.push({
        ok: true,
        status: response.status,
        parameterMode: attempt.parameterMode,
        message: null,
        latencyMs: Date.now() - started,
      });

      return {
        family: target.family,
        standardModel: target.standardModel,
        groupName: target.groupName || null,
        accountPool: target.accountPool || null,
        channelType: target.channelType || null,
        configuredModelId: target.modelId,
        ok: true,
        skipped: false,
        status: response.status,
        errorType: null,
        message: null,
        latencyMs: attempts.reduce((total, item) => total + Number(item.latencyMs || 0), 0),
        checkedAt,
        attempts,
      };
    } catch (error) {
      const message = errorMessage(error);
      attempts.push({
        ok: false,
        status: error.status || null,
        parameterMode: attempt.parameterMode,
        message,
        latencyMs: Date.now() - started,
      });
      if (!isParameterRetryable(message)) break;
    }
  }

  const firstError = attempts.find((item) => item.message) || {};
  const status = firstError.status || null;
  const message = firstError.message || "探测请求失败。";
  const parameterCompatibilityFailure = isParameterCompatibilityFailure(attempts);
  const credentialDiagnosticFailure = isCredentialDiagnosticFailure({ status, message });
  return {
    family: target.family,
    standardModel: target.standardModel,
    groupName: target.groupName || null,
    accountPool: target.accountPool || null,
    channelType: target.channelType || null,
    configuredModelId: target.modelId,
    ok: false,
    skipped: false,
    status,
    errorType: classifyProbeError({ status, message }),
    message,
    countsTowardAvailability: !parameterCompatibilityFailure && !credentialDiagnosticFailure,
    diagnosticOnly: parameterCompatibilityFailure || credentialDiagnosticFailure,
    latencyMs: attempts.reduce((total, item) => total + Number(item.latencyMs || 0), 0),
    checkedAt,
    attempts,
  };
}

function selectProbeTargets(input) {
  const configuredTargets = normalizeConfiguredTargets(input.configuredTargets);
  const profileFamily = normalizeFamily(input.profileFamily);
  const targetPriority = stringValue(input.targetPriority);
  const priorityTargets = orderConfiguredTargetsForProbe(configuredTargets, targetPriority);
  const dbTargets = normalizeDbTargets(input.offerModels);
  const baseTargets = priorityTargets.length ? priorityTargets : [...dbTargets, ...defaultTargets];
  const merged = baseTargets.filter(
    (target) => (!profileFamily || target.family === profileFamily) && !isHighCostAvailabilityProbeTarget(target),
  );
  const byTargetKey = new Map();

  for (const target of merged) {
    const key = probeTargetKey(target);
    if (!target.standardModel || byTargetKey.has(key)) continue;
    byTargetKey.set(key, {
      family: target.family,
      standardModel: target.standardModel,
      groupName: target.groupName || null,
      accountPool: target.accountPool || null,
      channelType: target.channelType || null,
      modelId: matchAvailableModel(input.availableModels, target),
      candidates: target.candidates || [],
      keywords: target.keywords || [],
    });
  }

  const targets = Array.from(byTargetKey.values());
  const orderedTargets = orderMatchedTargetsForProbe(targets, targetPriority, input.availableModels);

  return orderedTargets.slice(0, input.targetLimit || DEFAULT_TARGET_LIMIT);
}

function orderConfiguredTargetsForProbe(configuredTargets, targetPriority) {
  if (targetPriority === "latest_highest_available" || targetPriority === "last_available") {
    return configuredTargets.toReversed();
  }
  if (targetPriority === "lowest_cost_available") {
    return configuredTargets.toSorted(compareProbeTargetCost);
  }
  return configuredTargets;
}

function normalizeConfiguredTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target) => ({
      family: normalizeFamily(target.family || target.standardModel),
      standardModel: String(target.standardModel || ""),
      groupName: stringValue(target.groupName || target.group_name),
      accountPool: stringValue(target.accountPool || target.account_pool),
      channelType: stringValue(target.channelType || target.channel_type),
      candidates: stringArray(target.candidates || target.modelIds),
      keywords: stringArray(target.keywords),
    }))
    .filter((target) => target.family && target.standardModel);
}

function inferProbeProfileFamily(profile) {
  const explicitFamily = normalizeFamily(profile.family || profile.profileId || profile.apiKeyEnv || profile.groupName);
  if (explicitFamily) return explicitFamily;

  const configuredFamilies = new Set(normalizeConfiguredTargets(profile.targets).map((target) => target.family));
  return configuredFamilies.size === 1 ? Array.from(configuredFamilies)[0] : null;
}

function normalizeDbTargets(offerModels) {
  if (!Array.isArray(offerModels)) return [];
  return offerModels
    .map((offer) => ({
      family: normalizeFamily(offer.family || offer.standard_model || offer.standardModel),
      standardModel: String(offer.standard_model || offer.standardModel || ""),
      groupName: stringValue(offer.group_name || offer.groupName),
      accountPool: stringValue(offer.account_pool || offer.accountPool),
      channelType: stringValue(offer.channel_type || offer.channelType),
      candidates: stringArray([offer.raw_model_name, offer.rawModelName]),
      keywords: keywordsForStandardModel(offer.standard_model || offer.standardModel),
    }))
    .filter((target) => target.family && target.standardModel);
}

function probeTargetKey(target) {
  return [
    normalizeLooseToken(target.family),
    normalizeLooseToken(target.standardModel),
    normalizeLooseToken(target.groupName || target.accountPool || target.channelType || "default"),
  ].join("|");
}

function isHighCostAvailabilityProbeTarget(target) {
  return isHighCostAvailabilityProbeModel(target?.standardModel);
}

function isHighCostAvailabilityProbeModel(model) {
  return HIGH_COST_AVAILABILITY_PROBE_MODELS.has(String(model || ""));
}

function orderMatchedTargetsForProbe(targets, targetPriority, availableModels) {
  const hasAvailableModels = Array.isArray(availableModels) && availableModels.length > 0;
  if (targetPriority === "lowest_cost_available") {
    const byCost = targets.toSorted(compareProbeTargetCost);
    if (!hasAvailableModels) return byCost;
    return [...byCost.filter((target) => target.modelId), ...byCost.filter((target) => !target.modelId)];
  }
  return hasAvailableModels
    ? [...targets.filter((target) => target.modelId), ...targets.filter((target) => !target.modelId)]
    : targets;
}

function compareProbeTargetCost(left, right) {
  return probeTargetCost(left) - probeTargetCost(right) ||
    normalizeLooseToken(left.standardModel).localeCompare(normalizeLooseToken(right.standardModel));
}

function probeTargetCost(target) {
  const model = String(target?.standardModel || "");
  return Number.isFinite(AVAILABILITY_PROBE_MODEL_COSTS[model])
    ? AVAILABILITY_PROBE_MODEL_COSTS[model]
    : Number.POSITIVE_INFINITY;
}

function matchAvailableModel(availableModels, target) {
  const models = availableModels.map((model) => String(model || "")).filter(Boolean);
  if (!models.length) return target.candidates?.[0] || null;

  for (const candidate of target.candidates || []) {
    const exact = models.find((model) => normalizeModelId(model) === normalizeModelId(candidate));
    if (exact) return exact;
  }

  for (const candidate of target.candidates || []) {
    const fuzzy = models.find((model) => normalizeModelId(model).includes(normalizeModelId(candidate)));
    if (fuzzy) return fuzzy;
  }

  const keywords = target.keywords || keywordsForStandardModel(target.standardModel);
  if (keywords.length) {
    const keywordMatch = models.find((model) => {
      const normalized = normalizeModelId(model);
      return keywords.every((keyword) => normalized.includes(normalizeModelId(keyword)));
    });
    if (keywordMatch) return keywordMatch;
  }

  return null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));

  try {
    const response = await safeFetch(url, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": userAgent,
        ...(options.headers || {}),
      },
      body: options.body,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) {
      const error = new Error(extractErrorMessage(json) || `HTTP ${response.status}`);
      error.status = response.status;
      error.body = safeTextPreview(text);
      throw error;
    }

    return { status: response.status, json };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("请求超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function completionBody(profile, modelId) {
  if (profile.protocol === "anthropic_compatible") {
    return {
      model: modelId,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    };
  }

  return {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  };
}

function completionAttempts(profile, modelId) {
  const primary = {
    parameterMode: "max_tokens",
    body: completionBody(profile, modelId),
  };
  if (profile.protocol === "anthropic_compatible") return [primary];

  return [
    primary,
    {
      parameterMode: "max_completion_tokens",
      body: {
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
        stream: false,
      },
    },
    {
      parameterMode: "minimal",
      body: {
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
      },
    },
  ];
}

function authHeaders(profile, apiKey) {
  if (profile.protocol === "anthropic_compatible") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  return {
    authorization: `Bearer ${apiKey}`,
  };
}

async function refreshAvailabilityRollup(supabase, stationId) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [samplesResult, offerRows, stationFirstCheckedAt] = await Promise.all([
    readPriceAIProbeAvailabilitySamples(supabase, stationId, since),
    readOfferRowsForAvailabilityRollup(supabase, stationId),
    readStationFirstCheckedAt(supabase, stationId),
  ]);

  if (samplesResult.error) throw samplesResult.error;

  const stationSamples = [];
  const samplesByOfferKey = new Map();
  const legacySamplesByModel = new Map();
  const offerGroupsByModel = groupOfferRowsByModel(offerRows);
  const activeOfferScope = buildActiveOfferScope(offerRows);
  const stationWindow = { first: null, last: null };

  for (const row of dbRows(samplesResult.data)) {
    const checkedAt = stringValue(row.checked_at);
    const sample = { ok: Boolean(row.ok), checkedAt };
    const scope = stringValue(row.scope);

    if (scope === "station") {
      if (!availabilitySampleMatchesActiveOfferScope(row, activeOfferScope, { allowModelFallbackWithGroup: true })) continue;
      stationSamples.push(sample);
      extendSampleWindow(stationWindow, checkedAt);
      continue;
    }

    if (scope !== "offer") continue;
    const standardModel = stringValue(row.standard_model);
    if (!standardModel) continue;
    if (!availabilitySampleMatchesActiveOfferScope(row, activeOfferScope)) continue;
    extendSampleWindow(stationWindow, checkedAt);
    const groupName = stringValue(row.group_name);
    if (!groupName) {
      const existing = legacySamplesByModel.get(standardModel) || [];
      existing.push(sample);
      legacySamplesByModel.set(standardModel, existing);
      continue;
    }
    const key = offerAvailabilityKey(standardModel, groupName);
    const existing = samplesByOfferKey.get(key) || [];
    existing.push(sample);
    samplesByOfferKey.set(key, existing);
  }

  const stationAvailability = summarizeSamples(stationSamples);
  if (stationAvailability.samples) {
    const stationUpdate = {
      availability_seven_day_rate: stationAvailability.rate,
      availability_seven_day_samples: stationAvailability.samples,
      availability_first_checked_at: stationFirstCheckedAt || stationWindow.first,
      availability_last_checked_at: stationWindow.last,
      availability_note: availabilityNote("站点", stationAvailability),
      availability_source_type: PRICEAI_PROBE_AVAILABILITY_SOURCE.type,
      availability_source_label: PRICEAI_PROBE_AVAILABILITY_SOURCE.label,
      availability_source_url: null,
      last_updated_at: new Date().toISOString(),
    };
    const { error: stationError } = await updateAvailabilityRollup(
      supabase.from("api_transit_stations").update(stationUpdate).eq("id", stationId),
      supabase.from("api_transit_stations").update(removeOptionalAvailabilityFields(stationUpdate)).eq("id", stationId),
    );
    if (stationError) throw stationError;
  }

  const offerRollups = [];
  for (const offer of offerRows) {
    const standardModel = stringValue(offer.standard_model);
    const groupName = stringValue(offer.group_name);
    if (!standardModel) continue;

    const key = offerAvailabilityKey(standardModel, groupName);
    const samples =
      samplesByOfferKey.get(key) ||
      legacySamplesForOffer(legacySamplesByModel, offerGroupsByModel, standardModel) ||
      [];
    const availability = summarizeSamples(samples);
    if (!availability.samples) {
      offerRollups.push({ standardModel, groupName: groupName || null, ...availability, skippedUpdate: true });
      continue;
    }
    const offerWindow = sampleWindow(samples);
    const existingOfferFirstCheckedAt = stringValue(offer.availability_first_checked_at);
    const offerUpdate = {
      availability_seven_day_rate: availability.rate,
      availability_seven_day_samples: availability.samples,
      availability_first_checked_at: existingOfferFirstCheckedAt || offerWindow.first,
      availability_last_checked_at: offerWindow.last,
      availability_note: availabilityNote(targetGroupLabel(standardModel, groupName), availability),
      availability_source_type: PRICEAI_PROBE_AVAILABILITY_SOURCE.type,
      availability_source_label: PRICEAI_PROBE_AVAILABILITY_SOURCE.label,
      availability_source_url: null,
    };
    const { error: offerError } = await updateAvailabilityRollup(
      withOfferAvailabilityFilter(supabase.from("api_transit_offers").update(offerUpdate), stationId, standardModel, groupName),
      withOfferAvailabilityFilter(
        supabase.from("api_transit_offers").update(removeOptionalAvailabilityFields(offerUpdate)),
        stationId,
        standardModel,
        groupName,
      ),
    );
    if (offerError) throw offerError;
    offerRollups.push({ standardModel, groupName: groupName || null, ...availability });
  }

  return {
    stationId,
    station: stationAvailability,
    offers: offerRollups,
    lastCheckedAt: stationWindow.last,
  };
}

async function readPriceAIProbeAvailabilitySamples(supabase, stationId, since) {
  const result = await supabase
    .from("api_transit_availability_samples")
    .select("scope,standard_model,group_name,ok,checked_at,source_type")
    .eq("station_id", stationId)
    .eq("source_type", PRICEAI_PROBE_AVAILABILITY_SOURCE.type)
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(AVAILABILITY_SAMPLE_LOOKBACK_LIMIT);
  if (!result.error || !isMissingColumnError(result.error, "source_type")) return result;

  return supabase
    .from("api_transit_availability_samples")
    .select("scope,standard_model,group_name,ok,checked_at")
    .eq("station_id", stationId)
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(AVAILABILITY_SAMPLE_LOOKBACK_LIMIT);
}

function summarizeSamples(samples) {
  const valid = samples.filter((sample) => sample && typeof sample.ok === "boolean");
  const success = valid.filter((sample) => sample.ok).length;
  return {
    rate: valid.length ? round(success / valid.length, 4) : null,
    samples: valid.length,
    success,
  };
}

async function readOfferRowsForAvailabilityRollup(supabase, stationId) {
  const { data, error } = await supabase
    .from("api_transit_offers")
    .select("standard_model,group_name,status,availability_first_checked_at")
    .eq("station_id", stationId)
    .in("status", ["active", "needs_review"]);
  if (!error) return dbRows(data);
  if (!isMissingColumnError(error, "availability_first_checked_at")) throw error;

  const fallback = await supabase
    .from("api_transit_offers")
    .select("standard_model,group_name,status")
    .eq("station_id", stationId)
    .in("status", ["active", "needs_review"]);
  if (fallback.error) throw fallback.error;
  return dbRows(fallback.data);
}

async function readStationFirstCheckedAt(supabase, stationId) {
  const { data, error } = await supabase
    .from("api_transit_stations")
    .select("availability_first_checked_at")
    .eq("id", stationId)
    .limit(1);
  if (!error) return stringValue(data?.[0]?.availability_first_checked_at);
  if (isMissingColumnError(error, "availability_first_checked_at")) return null;
  throw error;
}

function withOfferAvailabilityFilter(query, stationId, standardModel, groupName) {
  const filtered = query.eq("station_id", stationId).eq("standard_model", standardModel);
  return groupName ? filtered.eq("group_name", groupName) : filtered.is("group_name", null);
}

async function updateAvailabilityRollup(query, fallbackQuery) {
  const result = await query;
  if (result.error && (isMissingColumnError(result.error, "availability_first_checked_at") || isAvailabilitySourceColumnError(result.error))) {
    return await fallbackQuery;
  }
  return result;
}

function removeOptionalAvailabilityFields(row) {
  return removeFields(row, [
    "availability_first_checked_at",
    "availability_source_type",
    "availability_source_label",
    "availability_source_url",
  ]);
}

function removeFields(row, fieldNames) {
  const next = { ...row };
  for (const fieldName of fieldNames) delete next[fieldName];
  return next;
}

function sampleWindow(samples) {
  const checkedTimes = samples
    .map((sample) => stringValue(sample?.checkedAt))
    .filter(Boolean)
    .sort();
  return {
    first: checkedTimes[0] || null,
    last: checkedTimes.at(-1) || null,
  };
}

async function upsertAvailabilitySamples(supabase, run) {
  const samples = run.availabilitySamples || [];
  if (!samples.length) return;
  await upsertRowsWithSampleSourceFallback(supabase, "api_transit_availability_samples", samples, { onConflict: "id" });
  await pruneAvailabilitySamples(supabase, run.stationId);
}

async function pruneAvailabilitySamples(supabase, stationId) {
  const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("api_transit_availability_samples")
    .delete()
    .eq("station_id", stationId)
    .lt("checked_at", cutoff);
  if (error) throw error;
}

function availabilitySamplesFromProbe({ runId, stationId, modelList, targetResults, checkedAt }) {
  const normalizedCheckedAt = stringValue(checkedAt) || new Date().toISOString();
  const hasTargetResults = Array.isArray(targetResults) && targetResults.length > 0;
  const targetSamples = Array.isArray(targetResults)
    ? targetResults.filter(isAvailabilitySample)
    : [];
  const samples = [];

  if (targetSamples.length) {
    targetSamples.forEach((item, index) => {
      const standardModel = stringValue(item.standardModel);
      const groupName = stringValue(item.groupName);
      const targetCheckedAt = stringValue(item.checkedAt) || normalizedCheckedAt;
      samples.push(availabilitySampleRow({
        runId,
        stationId,
        scope: "station",
        standardModel,
        groupName,
        ok: Boolean(item.ok),
        checkedAt: targetCheckedAt,
        index,
        availabilitySource: PRICEAI_PROBE_AVAILABILITY_SOURCE,
      }));
      if (!standardModel) return;
      samples.push(availabilitySampleRow({
        runId,
        stationId,
        scope: "offer",
        standardModel,
        groupName,
        ok: Boolean(item.ok),
        checkedAt: targetCheckedAt,
        index,
        availabilitySource: PRICEAI_PROBE_AVAILABILITY_SOURCE,
      }));
    });
    return samples;
  }

  if (!hasTargetResults && modelList && typeof modelList.ok === "boolean" && modelList.countsTowardAvailability !== false) {
    samples.push(availabilitySampleRow({
      runId,
      stationId,
      scope: "station",
      standardModel: null,
      groupName: null,
      ok: Boolean(modelList.ok),
      checkedAt: normalizedCheckedAt,
      index: 0,
      availabilitySource: PRICEAI_PROBE_AVAILABILITY_SOURCE,
    }));
  }

  return samples;
}

function availabilitySampleRow(input) {
  const stationId = stringValue(input.stationId);
  const runId = stringValue(input.runId);
  const checkedAt = stringValue(input.checkedAt) || new Date().toISOString();
  const standardModel = stringValue(input.standardModel) || null;
  const groupName = stringValue(input.groupName) || null;
  const scope = input.scope === "offer" ? "offer" : "station";

  return {
    id: stableId(
      "api-transit-availability-sample",
      runId,
      stationId,
      scope,
      standardModel || "station",
      groupName || "default",
      checkedAt,
      String(input.index || 0),
    ),
    run_id: runId,
    station_id: stationId,
    scope,
    standard_model: standardModel,
    group_name: groupName,
    ok: Boolean(input.ok),
    checked_at: checkedAt,
    source_type: input.availabilitySource?.type || "unknown",
    source_label: input.availabilitySource?.label || null,
    source_url: null,
  };
}

function isAvailabilitySample(item) {
  return item &&
    typeof item === "object" &&
    typeof item.ok === "boolean" &&
    item.countsTowardAvailability !== false &&
    !isHighCostAvailabilityProbeModel(item.standardModel);
}

function availabilityNote(label, availability) {
  if (!availability.samples) return "暂无 PriceAI API Key 可用性探测样本。";
  return `PriceAI API Key 探测：近 7 日 ${label} ${availability.success}/${availability.samples} 个样本成功。`;
}

function groupOfferRowsByModel(offerRows) {
  const output = new Map();
  for (const offer of offerRows) {
    const standardModel = stringValue(offer.standard_model);
    if (!standardModel) continue;
    const groups = output.get(standardModel) || new Set();
    groups.add(stringValue(offer.group_name) || "default");
    output.set(standardModel, groups);
  }
  return output;
}

function buildActiveOfferScope(offerRows) {
  const offerKeys = new Set();
  const modelTokens = new Set();
  for (const offer of offerRows) {
    const standardModel = stringValue(offer.standard_model);
    if (!standardModel) continue;
    offerKeys.add(offerAvailabilityKey(standardModel, stringValue(offer.group_name)));
    modelTokens.add(normalizeLooseToken(standardModel));
  }
  return { offerKeys, modelTokens };
}

function availabilitySampleMatchesActiveOfferScope(row, activeOfferScope, options = {}) {
  const standardModel = stringValue(row.standard_model);
  if (isHighCostAvailabilityProbeModel(standardModel)) return false;
  if (!standardModel) return activeOfferScope.offerKeys.size === 0;
  const groupName = stringValue(row.group_name);
  if (groupName) {
    if (activeOfferScope.offerKeys.has(offerAvailabilityKey(standardModel, groupName))) return true;
    if (!options.allowModelFallbackWithGroup) return false;
  }
  return activeOfferScope.modelTokens.has(normalizeLooseToken(standardModel));
}

function extendSampleWindow(window, checkedAt) {
  const value = stringValue(checkedAt);
  if (!value) return;
  if (!window.first || value < window.first) window.first = value;
  if (!window.last || value > window.last) window.last = value;
}

function offerAvailabilityKey(standardModel, groupName) {
  return `${normalizeLooseToken(standardModel)}|${normalizeLooseToken(groupName || "default")}`;
}

function legacySamplesForOffer(legacySamplesByModel, offerGroupsByModel, standardModel) {
  const groups = offerGroupsByModel.get(standardModel);
  if (groups && groups.size > 1) return null;
  return legacySamplesByModel.get(standardModel) || null;
}

function targetGroupLabel(standardModel, groupName) {
  return groupName ? `${groupName} / ${standardModel}` : standardModel;
}

async function listOfferModels(supabase, stationIds) {
  const output = new Map();
  const ids = stationIds.filter(Boolean);
  if (!ids.length) return output;

  const { data, error } = await supabase
    .from("api_transit_offers")
    .select("station_id,family,standard_model,raw_model_name,group_name,account_pool,channel_type,status")
    .in("station_id", ids)
    .in("status", ["active", "needs_review"]);

  if (error) throw error;

  for (const row of dbRows(data)) {
    const stationId = stringValue(row.station_id);
    if (!stationId) continue;
    const existing = output.get(stationId) || [];
    existing.push(row);
    output.set(stationId, existing);
  }

  return output;
}

async function listCredentialApiKeys(supabase, stationIds) {
  const output = emptyCredentialStore();
  const ids = Array.from(new Set(stationIds.filter(Boolean)));
  if (!ids.length) return output;

  const { data, error } = await supabase
    .from("api_transit_credentials")
    .select("id,station_id,credential_type,status,encrypted_payload,credential_meta,expires_at,created_at")
    .in("station_id", ids)
    .eq("credential_type", "test_key")
    .in("status", ["submitted", "ready"])
    .order("created_at", { ascending: false });

  if (error) {
    if (error.code === "PGRST205" || String(error.message || "").includes("api_transit_credentials")) {
      output.unavailableReason = "credential_table_missing";
      return output;
    }
    throw error;
  }

  const secret = credentialEncryptionSecret({
    dedicatedSecret: envValue("API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY"),
    adminSecret: envValue("ADMIN_SESSION_SECRET"),
  });
  if (!secret) {
    output.unavailableReason = "missing_credential_encryption_key";
    return output;
  }

  for (const row of dbRows(data)) {
    if (isExpired(row.expires_at)) continue;
    const stationId = stringValue(row.station_id);
    if (!stationId) continue;

    const payload = await decryptCredentialPayload(row.encrypted_payload, secret).catch(() => null);
    const apiKey = stringValue(payload?.api_key);
    if (!apiKey) continue;

    const meta = row.credential_meta && typeof row.credential_meta === "object" ? row.credential_meta : {};
    const items = output.byStation.get(stationId) || [];
    items.push({
      credentialId: stringValue(row.id) || null,
      apiKey,
      allowedModels: stringArray(payload?.allowed_models || meta.allowed_models),
      allowedGroups: stringArray(payload?.allowed_groups || meta.allowed_groups),
      groupName: stringValue(payload?.group_name || meta.group_name),
      groupId: stringValue(payload?.group_id || meta.group_id),
      accountPool: stringValue(payload?.account_pool || meta.account_pool),
      family: stringValue(payload?.family || meta.family),
      createdAt: stringValue(row.created_at),
    });
    output.byStation.set(stationId, items);
  }

  return output;
}

function credentialEncryptionSecret({ dedicatedSecret, adminSecret }) {
  const dedicated = stringValue(dedicatedSecret);
  if (dedicated) return dedicated;
  const admin = stringValue(adminSecret);
  return admin ? `priceai:api-transit-credentials:v1:${admin}` : "";
}

function emptyCredentialStore() {
  return {
    byStation: new Map(),
    unavailableReason: null,
  };
}

function selectCredentialForProfile(store, profile) {
  const credentials = store.byStation.get(profile.stationId) || [];
  if (!credentials.length) return null;

  const exact = credentials.find((credential) => credentialMatchesProfile(credential, profile));
  const selected = exact || (profileRequiresSpecificCredential(profile) ? null : credentials[0]);
  if (!selected) return null;
  return {
    apiKey: selected.apiKey,
    credentialId: selected.credentialId,
    source: "database",
  };
}

function credentialMatchesProfile(credential, profile) {
  if (!credentialGroupMatchesProfile(credential, profile)) return false;
  if (!credential.allowedModels.length) return true;

  const profileTokens = [
    profile.profileId,
    profile.stationId,
    profile.apiKeyEnv,
    profile.groupName,
    profile.groupId,
    profile.accountPool,
    ...(Array.isArray(profile.targets) ? profile.targets.flatMap((target) => [
      target.family,
      target.standardModel,
      target.groupName,
      target.groupId,
      target.accountPool,
      ...(target.candidates || []),
      ...(target.keywords || []),
    ]) : []),
  ].map(normalizeLooseToken).filter(Boolean);

  return credential.allowedModels.some((allowed) => {
    const token = normalizeLooseToken(allowed);
    if (!token) return false;
    return profileTokens.some((profileToken) => looseTokenMatches(profileToken, token));
  });
}

function credentialGroupMatchesProfile(credential, profile) {
  const profileGroupTokens = [
    profile.groupName,
    profile.groupId,
    profile.accountPool,
    ...(Array.isArray(profile.targets)
      ? profile.targets.flatMap((target) => [target.groupName, target.groupId, target.accountPool])
      : []),
  ].map(normalizeLooseToken).filter(Boolean);

  if (!profileGroupTokens.length) return true;

  const credentialGroupTokens = [
    credential.groupName,
    credential.groupId,
    credential.accountPool,
    ...credential.allowedGroups,
  ].map(normalizeLooseToken).filter(Boolean);

  if (!credentialGroupTokens.length) return false;
  return profileGroupTokens.some((profileToken) =>
    credentialGroupTokens.some((credentialToken) => groupTokenMatches(profileToken, credentialToken)),
  );
}

function profileRequiresSpecificCredential(profile) {
  return Boolean(
    profile.groupName ||
      profile.groupId ||
      profile.accountPool ||
      (Array.isArray(profile.targets) &&
        profile.targets.some((target) => target.groupName || target.groupId || target.accountPool)),
  );
}

async function decryptCredentialPayload(encryptedPayload, secret) {
  if (!encryptedPayload || typeof encryptedPayload !== "object") return null;
  if (encryptedPayload.alg !== "AES-GCM") return null;

  const cryptoApi = globalThis.crypto || webcrypto;
  if (!cryptoApi?.subtle) return null;

  const encoder = new TextEncoder();
  const keyMaterial = await cryptoApi.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await cryptoApi.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = base64ToBytes(encryptedPayload.iv);
  const ciphertext = base64ToBytes(encryptedPayload.ciphertext);
  const decrypted = await cryptoApi.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function markCredentialUsed(supabase, credentialId) {
  const { error } = await supabase
    .from("api_transit_credentials")
    .update({ last_used_at: new Date().toISOString(), failure_message: null })
    .eq("id", credentialId);
  if (error && error.code !== "PGRST205") throw error;
}

function isExpired(value) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function base64ToBytes(value) {
  return Uint8Array.from(Buffer.from(String(value || ""), "base64"));
}

async function upsertRows(supabase, table, rows, options = {}) {
  for (const chunk of chunks(rows, 300)) {
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (error) {
      error.table = table;
      throw error;
    }
  }
}

async function upsertRowsWithSampleSourceFallback(supabase, table, rows, options = {}) {
  try {
    await upsertRows(supabase, table, rows, options);
  } catch (error) {
    if (!isSampleSourceColumnError(error)) throw error;
    await upsertRows(supabase, table, removeSampleSourceFields(rows), options);
  }
}

function removeSampleSourceFields(rows) {
  return rows.map((row) => removeFields(row, ["source_type", "source_label", "source_url"]));
}

function loadProbeProfiles() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

async function loadProbeProfilesForRun(options) {
  const profiles = options.profiles || loadProbeProfiles();
  if (!shouldRestrictToRunnableStations(options)) return profiles;

  const runnableStationIds = await readRunnableApiTransitStationIds();
  return filterProfilesByRunnableStationIds(profiles, runnableStationIds);
}

function selectProfiles(profiles, options) {
  const ids = optionList(options.station || options.stationId || options.source || options.sources);
  const selected = ids.length ? profiles.filter((profile) => ids.includes(profile.stationId)) : profiles;
  if (!selected.length && ids.length) throw new Error("No API transit probe profiles matched.");
  return selected;
}

function shouldRestrictToRunnableStations(options) {
  const ids = optionList(options.station || options.stationId || options.source || options.sources);
  return Boolean((options.post || options.db) && !options.dryRun && !ids.length);
}

function filterProfilesByRunnableStationIds(profiles, runnableStationIds) {
  return profiles.filter((profile) => runnableStationIds.has(profile.stationId));
}

async function readRunnableApiTransitStationIds() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for API transit probe selection.");
  }

  const [credentialedStationIds, publicMonitoredStationIds] = await Promise.all([
    readCredentialedApiTransitStationIds(supabase),
    readPublicMonitoredApiTransitStationIds(supabase),
  ]);
  return filterStationIdsWithoutPublicStatus(credentialedStationIds, publicMonitoredStationIds);
}

async function readCredentialedApiTransitStationIds(supabase) {
  const { data, error } = await supabase
    .from("api_transit_credentials")
    .select("station_id,expires_at")
    .eq("credential_type", "test_key")
    .in("status", ["submitted", "ready"]);
  if (error) {
    if (error.code === "PGRST205" || String(error.message || "").includes("api_transit_credentials")) return new Set();
    throw error;
  }

  return new Set(
    (data || [])
      .filter((row) => stringValue(row.station_id) && !isExpired(row.expires_at))
      .map((row) => String(row.station_id)),
  );
}

async function readPublicMonitoredApiTransitStationIds(supabase) {
  const [sampleStationIds, configuredStationIds] = await Promise.all([
    readPublicStatusSampleStationIds(supabase),
    readPublicMonitorConfiguredStationIds(supabase),
  ]);
  return mergeStationIdSets(sampleStationIds, configuredStationIds);
}

async function readPublicStatusSampleStationIds(supabase) {
  const since = new Date(Date.now() - PUBLIC_STATUS_SAMPLE_LOOKBACK_MS).toISOString();
  const { data, error } = await supabase
    .from("api_transit_availability_samples")
    .select("station_id")
    .eq("source_type", PUBLIC_STATUS_AVAILABILITY_SOURCE_TYPE)
    .gte("checked_at", since)
    .limit(10000);
  if (error) {
    if (
      isMissingTableError(error, "api_transit_availability_samples") ||
      isMissingColumnError(error, "source_type")
    ) {
      return new Set();
    }
    throw error;
  }

  return new Set((data || []).map((row) => stringValue(row.station_id)).filter(Boolean));
}

async function readPublicMonitorConfiguredStationIds(supabase) {
  const { data, error } = await supabase
    .from("api_transit_stations")
    .select("id,monitor_url,availability_source_type")
    .limit(10000);
  if (error) {
    if (
      isMissingTableError(error, "api_transit_stations") ||
      isMissingColumnError(error, "monitor_url") ||
      isMissingColumnError(error, "availability_source_type")
    ) {
      return new Set();
    }
    throw error;
  }

  return new Set(
    (data || [])
      .filter((row) => {
        const sourceType = stringValue(row.availability_source_type);
        return sourceType === PUBLIC_STATUS_AVAILABILITY_SOURCE_TYPE || isPublicMonitorUrl(row.monitor_url);
      })
      .map((row) => stringValue(row.id))
      .filter(Boolean),
  );
}

function filterStationIdsWithoutPublicStatus(stationIds, publicMonitoredStationIds) {
  return new Set(Array.from(stationIds || []).filter((stationId) => !publicMonitoredStationIds.has(stationId)));
}

function mergeStationIdSets(...sets) {
  return new Set(sets.flatMap((set) => Array.from(set || [])));
}

function isPublicMonitorUrl(value) {
  const text = stringValue(value).toLowerCase();
  return Boolean(text && (text.includes("view=monitoring") || text.includes("/status") || text.includes("status.") || text.includes("monitor")));
}

function isMissingTableError(error, tableName) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "");
  return (code === "42P01" || code === "PGRST205") && (!tableName || message.includes(tableName));
}

function isMissingColumnError(error, columnName) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "");
  return (code === "42703" || code === "PGRST204") && message.includes(columnName);
}

function isAvailabilitySourceColumnError(error) {
  return (
    isMissingColumnError(error, "availability_source_type") ||
    isMissingColumnError(error, "availability_source_label") ||
    isMissingColumnError(error, "availability_source_url")
  );
}

function isSampleSourceColumnError(error) {
  return (
    isMissingColumnError(error, "source_type") ||
    isMissingColumnError(error, "source_label") ||
    isMissingColumnError(error, "source_url")
  );
}

function getSupabaseClient() {
  const url = envValue("NEXT_PUBLIC_SUPABASE_URL");
  const key = envValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function envValue(name) {
  if (!name) return "";
  if (process.env[name]) return process.env[name];
  const fileEnv = readEnvFile(envPath);
  return fileEnv[name] || "";
}

function readEnvFile(filePath) {
  if (cachedFileEnv) return cachedFileEnv;

  const output = {};
  if (!existsSync(filePath)) {
    cachedFileEnv = output;
    return output;
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    output[match[1]] = unquote(match[2].trim());
  }

  cachedFileEnv = output;
  return output;
}

function unquote(value) {
  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeApiBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) throw new Error("API base URL is required.");
  return text.endsWith("/v1") ? text : `${text}/v1`;
}

function normalizeModelIds(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data.map((item) => item?.id || item?.name || item).map(String).filter(Boolean);
  }
  if (Array.isArray(payload?.models)) {
    return payload.models.map((item) => item?.id || item?.name || item).map(String).filter(Boolean);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => item?.id || item?.name || item).map(String).filter(Boolean);
  }
  return [];
}

function extractErrorMessage(json) {
  if (!json || typeof json !== "object") return null;
  const error = json.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return stringValue(error.message || error.type || error.code) || null;
  return stringValue(json.message || json.msg || json.error_message) || null;
}

function safeTextPreview(text) {
  const value = String(text || "");
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function classifyProbeError(error) {
  const status = Number(error?.status);
  const message = errorMessage(error).toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || message.includes("model")) return "model_unavailable";
  if (status === 429) return "rate_limited";
  if (message.includes("timeout") || message.includes("超时")) return "timeout";
  if (status >= 500) return "upstream";
  return "request_failed";
}

function isCredentialDiagnosticFailure(error) {
  const status = Number(error?.status);
  const message = errorMessage(error);
  if (status === 401 || status === 403) return true;
  return /insufficient.*balance|balance.*insufficient|insufficient.*credit|余额不足|额度不足|余额不够|余额为0|欠费|充值|billing|payment required|quota exceeded|exceeded.*quota|invalid api key|invalid key|api key.*invalid|unauthorized|forbidden|apikey|api key|密钥|令牌|token.*invalid|invalid token|分组.*停用|group.*disabled/i.test(message);
}

function isParameterRetryable(message) {
  return /max_tokens|max_completion_tokens|max_output_tokens|temperature|unsupported|not support|不支持/i.test(String(message || ""));
}

function isParameterCompatibilityFailure(attempts) {
  const failedAttempts = Array.isArray(attempts) ? attempts.filter((item) => item && item.ok === false) : [];
  if (!failedAttempts.length) return false;
  return failedAttempts.every((item) => isParameterRetryable(item.message) && isExplicitParameterMessage(item.message));
}

function isExplicitParameterMessage(message) {
  return /parameter|参数|max_tokens|max_completion_tokens|max_output_tokens|temperature/i.test(String(message || ""));
}

function runStatus(input) {
  if (!input.modelListOk) return "failed";
  if (input.skipCompletions) return input.modelCount > 0 ? "success" : "partial";
  if (input.attemptedTargets > 0 && input.okTargets === input.attemptedTargets) return "success";
  if (input.attemptedTargets > 0 && input.okTargets > 0) return "partial";
  if (input.skippedTargets > 0) return "partial";
  return "failed";
}

function buildSkippedProfile(profile, reason) {
  return {
    profileId: profile.profileId || null,
    stationId: profile.stationId,
    apiBaseUrl: profile.apiBaseUrl,
    apiKeyEnv: profile.apiKeyEnv,
    groupName: profile.groupName || null,
    reason,
  };
}

function keywordsForStandardModel(value) {
  const text = String(value || "").toLowerCase();
  const version = text.match(/\d+(?:\.\d+)?/)?.[0];
  const keywords = [];
  if (text.includes("claude")) keywords.push("claude");
  if (text.includes("fable")) keywords.push("fable");
  if (text.includes("sonnet")) keywords.push("sonnet");
  if (text.includes("opus")) keywords.push("opus");
  if (text.includes("gpt")) keywords.push("gpt");
  if (text.includes("gemini")) keywords.push("gemini");
  if (text.includes("glm")) keywords.push("glm");
  if (text.includes("deepseek")) keywords.push("deepseek");
  if (text.includes("kimi")) keywords.push("kimi");
  if (text.includes("qwen") || text.includes("千问")) keywords.push("qwen");
  if (text.includes("nano")) keywords.push("nano");
  if (text.includes("banana")) keywords.push("banana");
  if (text.includes("image")) keywords.push("image");
  if (text.includes("sora")) keywords.push("sora");
  if (text.includes("veo")) keywords.push("veo");
  if (text.includes("omni")) keywords.push("omni");
  if (text.includes("seedance")) keywords.push("seedance");
  if (text.includes("happyhorse") || text.includes("happy horse")) keywords.push("happyhorse");
  if (text.includes("kling")) keywords.push("kling");
  if (text.includes("video")) keywords.push("video");
  if (text.includes("flash")) keywords.push("flash");
  if (text.includes("pro")) keywords.push("pro");
  if (text.includes("max")) keywords.push("max");
  if (text.includes("preview")) keywords.push("preview");
  if (text.includes("lite")) keywords.push("lite");
  if (version) keywords.push(version);
  return keywords;
}

function normalizeFamily(value) {
  const text = String(value || "").toLowerCase();
  if (
    text.includes("sora") ||
    text.includes("veo") ||
    text.includes("omni") ||
    text.includes("seedance") ||
    text.includes("happyhorse") ||
    text.includes("happy horse") ||
    text.includes("hh1.1-i2v") ||
    text.includes("kling") ||
    text.includes("video") ||
    text.includes("视频")
  ) return "video";
  if (
    text.includes("gpt-image") ||
    text.includes("gpt image") ||
    text.includes("nano-banana") ||
    text.includes("nano banana") ||
    text.includes("image") ||
    text.includes("生图") ||
    text.includes("绘图")
  ) return "image";
  if (text.includes("claude")) return "claude";
  if (text.includes("gpt")) return "gpt";
  if (text.includes("gemini") || text.includes("google")) return "gemini";
  if (text.includes("glm") || text.includes("zhipu")) return "glm";
  if (text.includes("deepseek")) return "deepseek";
  if (text.includes("kimi") || text.includes("moonshot")) return "kimi";
  if (text.includes("qwen") || text.includes("千问")) return "qwen";
  return null;
}

function normalizeModelId(value) {
  return String(value || "").toLowerCase().replace(/[_\s]+/g, "-");
}

function normalizeLooseToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function looseTokenMatches(left, right) {
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function groupTokenMatches(left, right) {
  return Boolean(left && right && left === right);
}

function dbRows(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function stringArray(value) {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => String(item || "").trim()).filter(Boolean);
}

function stringValue(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function optionList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(optionList);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function round(value, digits) {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function stableId(...parts) {
  const input = parts.filter((part) => part !== null && part !== undefined).join("|");
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) hash = (hash * 33) ^ input.charCodeAt(index);
  return `id-${(hash >>> 0).toString(36)}`;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const rawKey = item.slice(2);
    const equalsIndex = rawKey.indexOf("=");
    const key = equalsIndex >= 0 ? rawKey.slice(0, equalsIndex) : rawKey;
    const inlineValue = equalsIndex >= 0 ? rawKey.slice(equalsIndex + 1) : undefined;
    const next = values[index + 1];

    if (inlineValue !== undefined) {
      result[key] = inlineValue;
    } else if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function normalizeOptions(options) {
  return {
    ...options,
    env: parseInlineEnv(options.env),
    dryRun: truthyOption(options.dryRun ?? options["dry-run"]),
    post: truthyOption(options.post),
    db: truthyOption(options.db),
    dbCredentials: !truthyOption(options.noDbCredentials ?? options["no-db-credentials"]),
    verbose: truthyOption(options.verbose),
    skipCompletions: truthyOption(options.skipCompletions ?? options["skip-completions"]),
    timeoutMs: positiveInteger(options.timeoutMs ?? options.timeout, DEFAULT_TIMEOUT_MS),
    targetLimit: positiveInteger(options.targetLimit ?? options["target-limit"], DEFAULT_TARGET_LIMIT),
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseInlineEnv(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;

  const output = {};
  for (const item of optionList(value)) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    output[item.slice(0, index)] = item.slice(index + 1);
  }
  return output;
}

function truthyOption(value) {
  return value === true || value === "true" || value === "1" || value === "";
}

function printSummary(result) {
  console.log(
    [
      "API transit probe plan.",
      `profiles=${result.counts.profiles}`,
      `probed=${result.counts.probed}`,
      `skipped=${result.counts.skipped}`,
      `success=${result.counts.successfulRuns}`,
      `failed=${result.counts.failedRuns}`,
      result.post ? "database=posted" : "database=not-requested",
    ].join(" "),
  );
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function errorMessage(error) {
  if (error?.name === "AbortError") return "请求超时。";
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return JSON.stringify(error, null, 2);
  return String(error);
}

export const __test = {
  completionAttempts,
  completionBody,
  credentialEncryptionSecret,
  availabilitySampleMatchesActiveOfferScope,
  availabilitySamplesFromProbe,
  filterStationIdsWithoutPublicStatus,
  summarizeSamples,
  filterProfilesByRunnableStationIds,
  isAvailabilitySample,
  isCredentialDiagnosticFailure,
  isExplicitParameterMessage,
  isParameterCompatibilityFailure,
  keywordsForStandardModel,
  normalizeFamily,
  selectProbeTargets,
  shouldRestrictToRunnableStations,
};
