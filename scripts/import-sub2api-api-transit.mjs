#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { safeFetch } from "./safe-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const envPath = path.join(repoRoot, ".env.local");
const defaultOutPath = path.join(repoRoot, "tmp", "api-transit-sub2api-latest.json");

const userAgent = "Mozilla/5.0 PriceAI/1.0 APITransitSub2APICollector";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RECHARGE_RATIO = "1:1";
const STALE_UNKNOWN_AVAILABILITY_NOTE_PATTERN = /PriceAI API Key 探测|PriceAI 临时 Key|单轮准入抽样|近 7 日 .*样本成功/;

const targetPlans = [
  {
    id: "claude_fable_5",
    family: "claude",
    standardModel: "Claude Fable 5",
    rawModelName: "claude-fable-5",
    candidates: ["claude-fable-5", "claude-fable-5-0", "claude-5-fable"],
    groupSelector: "claude_general",
  },
  {
    id: "claude_sonnet_5",
    family: "claude",
    standardModel: "Claude Sonnet 5",
    rawModelName: "claude-sonnet-5",
    candidates: ["claude-sonnet-5", "claude-sonnet-5-0", "claude-5-sonnet"],
    groupSelector: "claude_sonnet",
  },
  {
    id: "gpt",
    family: "gpt",
    standardModel: "GPT 5.5",
    rawModelName: "gpt-5.5",
    candidates: ["gpt-5.5", "gpt-5-5"],
    groupSelector: "openai_general",
  },
  {
    id: "gpt_pro",
    family: "gpt",
    standardModel: "GPT 5.5",
    rawModelName: "gpt-5.5",
    candidates: ["gpt-5.5", "gpt-5-5"],
    groupSelector: "openai_pro",
  },
  {
    id: "claude",
    family: "claude",
    standardModel: "Claude Opus 4.8",
    rawModelName: "claude-opus-4-8",
    candidates: ["claude-opus-4-8", "claude-opus-4.8", "claude-4-8-opus", "claude-4.8-opus"],
    groupSelector: "claude_general",
  },
  {
    id: "kimi_k3",
    family: "kimi",
    standardModel: "Kimi K3",
    rawModelName: "kimi-k3",
    candidates: ["kimi-k3", "moonshot/kimi-k3"],
    groupSelector: "kimi",
  },
  {
    id: "qwen_3_7_max",
    family: "qwen",
    standardModel: "Qwen3.7-Max",
    rawModelName: "qwen3.7-max",
    candidates: ["qwen3.7-max", "qwen-3.7-max", "qwen/qwen3.7-max"],
    groupSelector: "qwen",
  },
];

const standardModelMatchers = [
  {
    family: "claude",
    standardModel: "Claude Fable 5",
    candidates: ["claude-fable-5", "claude-fable-5-0", "claude-5-fable"],
  },
  {
    family: "claude",
    standardModel: "Claude Sonnet 5",
    candidates: ["claude-sonnet-5", "claude-sonnet-5-0", "claude-5-sonnet"],
  },
  {
    family: "claude",
    standardModel: "Claude Sonnet 4.6",
    candidates: ["claude-sonnet-4.6", "claude-sonnet-4-6", "claude-4.6-sonnet"],
  },
  {
    family: "claude",
    standardModel: "Claude Opus 4.6",
    candidates: ["claude-opus-4.6", "claude-opus-4-6", "claude-4.6-opus"],
  },
  {
    family: "claude",
    standardModel: "Claude Opus 4.7",
    candidates: ["claude-opus-4.7", "claude-opus-4-7", "claude-4.7-opus"],
  },
  {
    family: "claude",
    standardModel: "Claude Opus 4.8",
    candidates: ["claude-opus-4.8", "claude-opus-4-8", "claude-4.8-opus"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.5",
    candidates: ["gpt-5.5", "gpt-5-5"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.4",
    candidates: ["gpt-5.4", "gpt-5-4"],
  },
  {
    family: "gpt",
    standardModel: "GPT 5.4 Mini",
    candidates: ["gpt-5.4-mini", "gpt-5-4-mini"],
  },
  {
    family: "kimi",
    standardModel: "Kimi K3",
    candidates: ["kimi-k3", "moonshot/kimi-k3"],
  },
  {
    family: "qwen",
    standardModel: "Qwen3.8-Max-Preview",
    candidates: ["qwen3.8-max-preview", "qwen-3.8-max-preview"],
  },
  {
    family: "qwen",
    standardModel: "Qwen3.7-Max",
    candidates: ["qwen3.7-max", "qwen-3.7-max", "qwen/qwen3.7-max"],
  },
  {
    family: "image",
    standardModel: "GPT Image 2",
    candidates: ["gpt-image-2", "gpt-image2"],
  },
  {
    family: "image",
    standardModel: "Nano Banana Pro",
    candidates: ["nano-banana-pro", "nano banana pro"],
  },
  {
    family: "image",
    standardModel: "Nano Banana 2",
    candidates: ["nano-banana-2", "nano banana 2", "gemini-3.1-flash-image", "gemini-3-1-flash-image"],
  },
  {
    family: "image",
    standardModel: "Nano Banana",
    candidates: ["nano-banana", "nano banana", "gemini-2.5-flash-image", "gemini-2-5-flash-image"],
  },
  {
    family: "image",
    standardModel: "Nano Banana Lite",
    candidates: ["nano-banana-lite", "nano banana lite"],
  },
  {
    family: "video",
    standardModel: "Sora 2 Pro",
    candidates: ["sora-2-pro", "sora 2 pro"],
  },
  {
    family: "video",
    standardModel: "Sora 2",
    candidates: ["sora-2", "sora 2"],
  },
  {
    family: "video",
    standardModel: "Veo 3.1 Lite",
    candidates: ["veo-3.1-lite", "veo-3-1-lite", "veo 3.1 lite"],
  },
  {
    family: "video",
    standardModel: "Veo 3.1",
    candidates: ["veo-3.1", "veo-3-1", "veo 3.1"],
  },
  {
    family: "video",
    standardModel: "Gemini Omni Flash",
    candidates: ["gemini-omni-flash", "gemini omni flash"],
  },
  {
    family: "video",
    standardModel: "Seedance 2.0",
    candidates: ["seedance-2.0", "seedance-2", "seedance 2.0"],
  },
  {
    family: "video",
    standardModel: "HappyHorse 1.1 I2V",
    candidates: [
      "happyhorse-1.1-i2v",
      "happyhorse-1-1-i2v",
      "happy house 1.1 i2v",
      "happyhouse-1.1-i2v",
      "hh1.1-i2v",
      "alibaba/hh1.1-i2v",
    ],
  },
  {
    family: "video",
    standardModel: "Kling 2.5 Turbo",
    candidates: ["kling-2.5-turbo", "kling-2-5-turbo", "kling 2.5 turbo"],
  },
];

if (isCli()) {
  const options = normalizeOptions(parseArgs(process.argv.slice(2)));

  try {
    const result = await importSub2ApiTransit(options);
    printSummary(result);

    if (options.verbose || options.dryRun) {
      console.log(JSON.stringify(result, null, 2));
    }

    if (options.out) {
      const outPath = path.resolve(repoRoot, options.out === true ? defaultOutPath : options.out);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(`Snapshot written to ${path.relative(repoRoot, outPath)}`);
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

export async function importSub2ApiTransit(options = {}) {
  options = normalizeOptions(options);
  const startedAt = new Date().toISOString();
  const source = normalizeSource(options);
  const accountCredential = await resolveLoginCredential(source, options);
  const auth = await login(source, options, accountCredential);
  if (options.saveAccountCredential && accountCredential.source !== "database") {
    await saveAccountCredential(source, accountCredential, startedAt, options);
  }
  const groups = await fetchGroups(source, auth, options);
  const selectedTargets = selectTargetGroups(groups);
  const keys = await fetchKeys(source, auth, options);
  const keyResults = await ensureTargetKeys(source, auth, selectedTargets, keys, options);
  const probeResults = await probeTargets(source, selectedTargets, keyResults, options);
  const rows = buildRows(source, groups, selectedTargets, keyResults, probeResults, startedAt, options);
  rows.credentialSubmissions = [];
  rows.credentials = [];
  if (options.postCredentials) {
    const credentialRows = await buildCredentialRows(source, selectedTargets, keyResults, startedAt, options);
    rows.credentialSubmissions = credentialRows.submissions;
    rows.credentials = credentialRows.credentials;
  }

  const result = {
    dryRun: Boolean(options.dryRun),
    post: Boolean(options.post || options.db),
    publish: Boolean(options.publish),
    source: "sub2api_account",
    startedAt,
    finishedAt: new Date().toISOString(),
    station: {
      id: source.id,
      name: source.name,
      websiteUrl: source.websiteUrl,
      apiBaseUrl: source.apiBaseUrl,
    },
    counts: {
      groups: groups.length,
      selectedGroups: selectedTargets.filter((target) => target.group).length,
      existingKeys: keys.length,
      createdKeys: keyResults.filter((result) => result.created).length,
      targets: targetPlans.length,
      successfulTargets: probeResults.filter((result) => result.ok).length,
      offers: rows.offers.length,
      runs: rows.runs.length,
      credentials: rows.credentials.length,
    },
    groups: groups.map(redactGroup),
    selectedTargets: selectedTargets.map(redactSelectedTarget),
    keyResults: keyResults.map(redactKeyResult),
    probeResults,
    stations: rows.stations,
    offers: rows.offers,
    runs: rows.runs,
  };

  if (options.post || options.db) {
    result.database = await postRows(rows, options);
  }

  return result;
}

function normalizeSource(options) {
  const websiteUrl = normalizeWebsiteUrl(requiredOption(options.url || options.websiteUrl, "--url"));
  const url = new URL(websiteUrl);
  const id = slugify(options.stationId || options.id || url.hostname);
  if (!id) throw new Error("Unable to infer station id from URL.");

  return {
    id,
    slug: slugify(options.slug || id),
    name: options.name || titleFromHost(url.hostname),
    websiteUrl,
    dashboardUrl: options.dashboardUrl || new URL("/dashboard", websiteUrl).href,
    apiBaseUrl: options.apiBaseUrl || new URL("/v1", websiteUrl).href.replace(/\/$/, ""),
    apiV1BaseUrl: options.apiV1BaseUrl || new URL("/api/v1", websiteUrl).href.replace(/\/$/, ""),
  };
}

async function login(source, options, credential) {
  const response = await fetchJson(`${source.apiV1BaseUrl}/auth/login`, {
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: JSON.stringify({ email: credential.email, password: credential.password }),
  });
  const token =
    response.json?.data?.token ||
    response.json?.data?.access_token ||
    response.json?.token ||
    response.json?.access_token;
  const cookie = response.headers.get("set-cookie")?.split(";")[0] || null;
  if (!token && !cookie) throw new Error(`${source.name} login did not return an auth token or session cookie.`);

  return { token, cookie };
}

async function resolveLoginCredential(source, options) {
  const fileEnv = readEnvFile(envPath);
  const email = options.email || process.env.SUB2API_EMAIL || fileEnv.SUB2API_EMAIL;
  const password = options.password || process.env.SUB2API_PASSWORD || fileEnv.SUB2API_PASSWORD;
  if (email && password) {
    return {
      source: "runtime",
      email: String(email),
      password: String(password),
      loginUrl: options.loginUrl || options["login-url"] || source.dashboardUrl,
    };
  }

  const stored = await readStoredAccountCredential(source, options);
  if (stored) return stored;

  throw new Error("Missing --email/--password, SUB2API_EMAIL/SUB2API_PASSWORD, or stored test_account credential.");
}

async function readStoredAccountCredential(source, options) {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("api_transit_credentials")
    .select("id,encrypted_payload,credential_meta,expires_at,created_at")
    .eq("station_id", source.id)
    .eq("credential_type", "test_account")
    .in("status", ["ready", "submitted"])
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    if (error.code === "PGRST205" || String(error.message || "").includes("api_transit_credentials")) return null;
    throw error;
  }

  const secret = credentialEncryptionSecret(options);
  for (const row of data || []) {
    if (isExpired(row.expires_at)) continue;
    const payload = await decryptCredentialPayload(row.encrypted_payload, secret).catch(() => null);
    const username = stringValue(payload?.username);
    const password = stringValue(payload?.password);
    if (!username || !password) continue;
    return {
      source: "database",
      credentialId: row.id,
      email: username,
      password,
      loginUrl: stringValue(payload?.login_url) || source.dashboardUrl,
    };
  }

  return null;
}

async function saveAccountCredential(source, credential, collectedAt, options) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for saving account credential.");

  const secret = credentialEncryptionSecret(options);
  const submissionId = stableId("api-transit-account-submission", source.id);
  const credentialType = "test_account";
  const loginUrl = credential.loginUrl || source.dashboardUrl;
  const meta = {
    accessMode: credentialType,
    access_mode: credentialType,
    credentialStatus: "ready",
    credentialType,
    stationId: source.id,
    login_host: safeHost(loginUrl),
    has_api_key: false,
    has_test_account: true,
    source: "sub2api_account_saved",
    collected_at: collectedAt,
  };

  await upsertRows(
    supabase,
    "api_transit_submissions",
    [
      {
        id: submissionId,
        submission_type: "merchant",
        submitted_url: source.websiteUrl,
        submitted_name: source.name,
        api_base_url: source.apiBaseUrl,
        pricing_url: source.dashboardUrl,
        contact: null,
        notes: "Sub2API 测试账号凭据，仅用于 PriceAI 分组倍率刷新与低频抽样。",
        submitted_models: [],
        submitted_meta: {
          ...meta,
          credentialLoginHost: meta.login_host,
        },
        parse_status: "parsed",
        probe_status: "needs_login",
        review_status: "approved",
        station_id: source.id,
        admin_note: "已保存加密测试账号凭据；不在后台明文展示。",
      },
    ],
    { onConflict: "id" },
  );

  await upsertRows(
    supabase,
    "api_transit_credentials",
    [
      {
        id: stableId("api-transit-credential", submissionId, credentialType),
        submission_id: submissionId,
        station_id: source.id,
        credential_type: credentialType,
        status: "ready",
        encrypted_payload: await encryptCredentialPayload(
          {
            type: credentialType,
            login_url: loginUrl,
            username: credential.email,
            password: credential.password,
            notes: `Sub2API ${source.name} 测试账号，仅用于 PriceAI 分组倍率刷新。`,
          },
          secret,
        ),
        credential_meta: meta,
        expires_at: null,
        last_used_at: null,
        failure_message: null,
        submitter_ip: null,
      },
    ],
    { onConflict: "id" },
  );
}

async function fetchGroups(source, auth, options) {
  const response = await fetchJson(`${source.apiV1BaseUrl}/groups/available`, {
    timeoutMs: options.timeoutMs,
    headers: authHeaders(auth),
  });
  const groups = Array.isArray(response.json?.data) ? response.json.data : Array.isArray(response.json) ? response.json : [];
  return groups.map(normalizeGroup).filter((group) => group.status === "active");
}

async function fetchKeys(source, auth, options) {
  const response = await fetchJson(`${source.apiV1BaseUrl}/keys?page=1&page_size=100`, {
    timeoutMs: options.timeoutMs,
    headers: authHeaders(auth),
  });
  return normalizeKeyRows(response.json);
}

async function ensureTargetKeys(source, auth, selectedTargets, keys, options) {
  const results = [];
  for (const selected of selectedTargets) {
    if (!selected.group) {
      results.push({ targetId: selected.plan.id, group: null, created: false, key: null, error: "missing_group" });
      continue;
    }

    const existing = keys.find(
      (key) =>
        Number(key.groupId) === Number(selected.group.id) &&
        key.key &&
        String(key.status || "").toLowerCase() === "active",
    );
    if (existing) {
      results.push({
        targetId: selected.plan.id,
        group: selected.group,
        created: false,
        key: existing.key,
        keyId: existing.id,
        keyName: existing.name,
      });
      continue;
    }

    if (!options.ensureKeys || options.dryRun) {
      results.push({
        targetId: selected.plan.id,
        group: selected.group,
        created: false,
        key: null,
        error: options.dryRun ? "missing_key_dry_run" : "missing_key",
      });
      continue;
    }

    const name = `priceai-${selected.plan.id}-${compactTimestamp(new Date())}`;
    const response = await fetchJson(`${source.apiV1BaseUrl}/keys`, {
      method: "POST",
      timeoutMs: options.timeoutMs,
      headers: authHeaders(auth),
      body: JSON.stringify({ name, group_id: selected.group.id }),
    });
    const row = response.json?.data || response.json || {};
    const key = row.key || row.api_key || row.token;
    results.push({
      targetId: selected.plan.id,
      group: selected.group,
      created: true,
      key,
      keyId: row.id || null,
      keyName: row.name || name,
      createStatus: response.status,
      error: key ? null : "created_key_missing_secret",
    });
  }

  return results;
}

async function probeTargets(source, selectedTargets, keyResults, options) {
  const results = [];
  for (const selected of selectedTargets) {
    const keyResult = keyResults.find((item) => item.targetId === selected.plan.id);
    if (!selected.group || !keyResult?.key) {
      results.push({
        targetId: selected.plan.id,
        family: selected.plan.family,
        standardModel: selected.plan.standardModel,
        rawModelName: selected.plan.rawModelName,
        groupId: selected.group?.id || null,
        groupName: selected.group?.name || null,
        ok: false,
        modelListed: null,
        modelListStatus: null,
        modelListLatencyMs: null,
        modelListCount: 0,
        attempts: [],
        error: keyResult?.error || "missing_key",
      });
      continue;
    }

    const modelList = await probeModelList(source, keyResult.key, options);
    const matchedModel = matchAvailableModel(modelList.models, selected.plan.candidates) || selected.plan.rawModelName;
    const completion = await probeCompletion(source, keyResult.key, matchedModel, options);

    results.push({
      targetId: selected.plan.id,
      family: selected.plan.family,
      standardModel: selected.plan.standardModel,
      rawModelName: matchedModel,
      groupId: selected.group.id,
      groupName: selected.group.name,
      multiplier: selected.group.multiplier,
      ok: completion.ok,
      modelListed: modelList.models.length ? Boolean(matchAvailableModel(modelList.models, selected.plan.candidates)) : null,
      modelListStatus: modelList.status,
      modelListLatencyMs: modelList.latencyMs,
      modelListCount: modelList.models.length,
      sampleModels: modelList.models.filter((model) => sampleModelMatcher(model)).slice(0, 30),
      attempts: completion.attempts,
      error: completion.ok ? null : completion.attempts.find((attempt) => attempt.message)?.message || modelList.error,
    });
  }
  return results;
}

async function probeModelList(source, apiKey, options) {
  const started = Date.now();
  try {
    const response = await fetchJson(`${source.apiBaseUrl}/models`, {
      timeoutMs: options.timeoutMs,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return {
      ok: true,
      status: response.status,
      latencyMs: Date.now() - started,
      models: normalizeModelIds(response.json),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status || null,
      latencyMs: Date.now() - started,
      models: [],
      error: errorMessage(error),
    };
  }
}

async function probeCompletion(source, apiKey, model, options) {
  const attempts = [];
  const bodies = [
    {
      parameterMode: "max_tokens",
      body: {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      },
    },
    {
      parameterMode: "max_completion_tokens",
      body: {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
        stream: false,
      },
    },
    {
      parameterMode: "minimal",
      body: {
        model,
        messages: [{ role: "user", content: "ping" }],
      },
    },
  ];

  for (const attempt of bodies) {
    const started = Date.now();
    try {
      const response = await fetchJson(`${source.apiBaseUrl}/chat/completions`, {
        method: "POST",
        timeoutMs: options.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(attempt.body),
      });
      attempts.push({
        ok: true,
        status: response.status,
        latencyMs: Date.now() - started,
        parameterMode: attempt.parameterMode,
        message: null,
        usage: response.json?.usage || null,
      });
      return { ok: true, attempts };
    } catch (error) {
      const message = errorMessage(error);
      attempts.push({
        ok: false,
        status: error.status || null,
        latencyMs: Date.now() - started,
        parameterMode: attempt.parameterMode,
        message,
        usage: null,
      });
      if (!isParameterRetryable(message)) break;
    }
  }

  return { ok: false, attempts };
}

function buildRows(source, groups, selectedTargets, keyResults, probeResults, collectedAt, options) {
  const attempted = probeResults.filter((result) => result.groupId);
  const okCount = attempted.filter((result) => result.ok).length;
  const groupCount = groups.length;
  const pricingStatus = groupCount ? "success" : "failed";
  const probeStatus = attempted.length && okCount === attempted.length ? "success" : okCount ? "partial" : "failed";
  const probeNote = probeResults
    .filter((result) => !result.ok)
    .map((result) => `${result.standardModel}: ${result.error || "probe_failed"}`)
    .join("；") || null;
  const channelTypes = unique(selectedTargets.map((target) => inferChannelType(target.group?.name || target.group?.platform || "")));
  const accountPools = unique(selectedTargets.map((target) => inferAccountPool(target.group?.name || "")));

  const station = {
    id: source.id,
    slug: source.slug,
    name: source.name,
    website_url: source.websiteUrl,
    api_base_url: source.apiBaseUrl,
    pricing_url: source.dashboardUrl,
    status: groupCount ? "active" : "unknown",
    source_type: "manual_collected",
    commercial_relation: "none",
    summary: `通过 Sub2API 登录态分组接口抓取 ${groups.length} 个活跃分组，并按 PriceAI 准入抽样只测试 GPT 5.5 与 Claude Opus 4.8。`,
    channel_types: channelTypes.length ? channelTypes : ["undisclosed"],
    account_pools: accountPools.length ? accountPools : ["undisclosed"],
    payment_methods: [],
    minimum_top_up: null,
    balance_expiry: null,
    support_channels: ["官网后台"],
    refund_policy: null,
    risk_labels: groupCount ? ["insufficient_samples"] : ["insufficient_samples", "pending_feedback"],
    usage_advice: groupCount ? "try_small" : "pending",
    data_status: groupCount ? "verified" : "pending_review",
    availability_seven_day_rate: attempted.length ? okCount / attempted.length : null,
    availability_seven_day_samples: attempted.length,
    availability_first_checked_at: attempted.length ? collectedAt : null,
    availability_last_checked_at: collectedAt,
    availability_note: "单轮准入抽样：每个家族只选择一个代表分组和一个目标模型；后续需接入定时监测替换为滚动样本。",
    availability_source_type: "priceai_probe",
    availability_source_label: "PriceAI 实测",
    availability_source_url: null,
    feedback_pending_count: 0,
    feedback_verified_risk_count: 0,
    feedback_merchant_responded_count: 0,
    feedback_main_themes: [],
    feedback_public_notes: null,
    collector_kind: "sub2api_account",
    pricing_endpoint_url: `${source.apiV1BaseUrl}/groups/available`,
    collection_status: pricingStatus,
    collection_error: groupCount ? null : probeNote,
    last_collected_at: collectedAt,
    last_updated_at: collectedAt,
    published: Boolean(options.publish),
    admin_note: `Sub2API 登录抓取 ${groups.length} 个分组，创建 ${keyResults.filter((result) => result.created).length} 个测试 Key，${okCount}/${attempted.length} 个目标模型通过。`,
  };

  const offers = buildOfferRows(source, groups, probeResults, collectedAt);

  const run = {
    id: stableId("api-transit-sub2api-run", source.id, collectedAt),
    station_id: source.id,
    run_type: "api_probe",
    status: probeStatus,
    model_count: groups.length,
    offer_count: offers.length,
    error_message: probeNote,
    source_url: `${source.apiV1BaseUrl}/groups/available`,
    started_at: collectedAt,
    finished_at: new Date().toISOString(),
    raw_snapshot: {
      groups: groups.map(redactGroup),
      selectedTargets: selectedTargets.map(redactSelectedTarget),
      keyResults: keyResults.map(redactKeyResult),
      probeResults,
    },
    logs: {
      collectorKind: "sub2api_account",
      auth: "account_login",
      targetPolicy: "one_gpt_group_one_gpt_pro_group_one_claude_group",
    },
  };

  return { stations: [station], offers, runs: [run] };
}

async function buildCredentialRows(source, selectedTargets, keyResults, collectedAt, options) {
  const credentials = [];
  const submissions = [];
  const secret = credentialEncryptionSecret(options);

  for (const result of keyResults) {
    if (!result.key || !result.group) continue;

    const selected = selectedTargets.find((target) => target.plan.id === result.targetId);
    if (!selected) continue;

    const groupName = result.group.name;
    const submissionId = stableId("api-transit-credential-submission", source.id, result.targetId, result.group.id);
    const credentialType = "test_key";
    const meta = {
      accessMode: "test_key",
      access_mode: "test_key",
      credentialStatus: "ready",
      credentialType,
      stationId: source.id,
      allowed_models: [selected.plan.standardModel, selected.plan.rawModelName],
      allowed_groups: [groupName, String(result.group.id)],
      group_name: groupName,
      group_id: String(result.group.id),
      account_pool: inferAccountPool(groupName),
      family: selected.plan.family,
      standard_model: selected.plan.standardModel,
      raw_model_name: selected.plan.rawModelName,
      source: "sub2api_account_import",
      source_key_id: result.keyId || null,
      source_key_name: result.keyName || null,
      collected_at: collectedAt,
    };

    submissions.push({
      id: submissionId,
      submission_type: "merchant",
      submitted_url: source.websiteUrl,
      submitted_name: source.name,
      api_base_url: source.apiBaseUrl,
      pricing_url: source.dashboardUrl,
      contact: null,
      notes: `Sub2API 自动导入 ${groupName} 分组测试 Key。`,
      submitted_models: [selected.plan.standardModel, selected.plan.rawModelName],
      submitted_meta: {
        ...meta,
        credentialAllowedModels: meta.allowed_models,
        credentialAllowedGroups: meta.allowed_groups,
        credentialGroupName: meta.group_name,
        credentialGroupId: meta.group_id,
        credentialAccountPool: meta.account_pool,
        credentialFamily: meta.family,
      },
      parse_status: "parsed",
      probe_status: "public_pricing_found",
      review_status: "approved",
      station_id: source.id,
      admin_note: "Sub2API 导入脚本生成的测试 Key 凭据记录。",
    });

    credentials.push({
      id: stableId("api-transit-credential", submissionId, credentialType),
      submission_id: submissionId,
      station_id: source.id,
      credential_type: credentialType,
      status: "ready",
      encrypted_payload: await encryptCredentialPayload({
        type: credentialType,
        api_key: result.key,
        allowed_models: meta.allowed_models,
        allowed_groups: meta.allowed_groups,
        group_name: meta.group_name,
        group_id: meta.group_id,
        account_pool: meta.account_pool,
        family: meta.family,
        standard_model: meta.standard_model,
        raw_model_name: meta.raw_model_name,
        notes: `Sub2API ${groupName} 分组 Key，仅用于 PriceAI 可用性监测。`,
      }, secret),
      credential_meta: meta,
      expires_at: null,
      last_used_at: null,
      failure_message: null,
      submitter_ip: null,
    });
  }

  return { submissions, credentials };
}

function buildOfferRow(source, result, collectedAt) {
  const multiplier = round(result.multiplier, 6);
  const publicMultiplier = publicMultiplierForStandardModel(result.standardModel, multiplier);
  const ok = Boolean(result.ok);
  const status = apiTransitOfferStatusForProbeResult(result);
  return {
    id: stableId("api-transit-offer", source.id, result.standardModel, result.groupId),
    station_id: source.id,
    family: result.family,
    standard_model: result.standardModel,
    raw_model_name: result.rawModelName,
    group_name: result.groupName,
    recharge_ratio: DEFAULT_RECHARGE_RATIO,
    model_multiplier: publicMultiplier,
    input_price: publicMultiplier,
    output_price: publicMultiplier,
    cache_read_price: publicMultiplier,
    cache_write_price: publicMultiplier,
    currency: "CNY",
    account_pool: inferAccountPool(result.groupName),
    channel_type: inferChannelType(result.groupName),
    price_source: "Sub2API 登录分组接口 + PriceAI 单轮抽样",
    source_url: source.dashboardUrl,
    availability_seven_day_rate: ok ? 1 : 0,
    availability_seven_day_samples: 1,
    availability_first_checked_at: collectedAt,
    availability_last_checked_at: collectedAt,
    availability_note: ok ? "单轮准入抽样通过；后续接入定时监测。" : result.error || "单轮准入抽样未通过，待复核。",
    availability_source_type: "priceai_probe",
    availability_source_label: "PriceAI 实测",
    availability_source_url: null,
    last_verified_at: collectedAt,
    status,
    raw_payload: {
      group: {
        id: result.groupId,
        name: result.groupName,
        multiplier,
      },
      probe: {
        ok,
        modelListed: result.modelListed,
        modelListStatus: result.modelListStatus,
        attempts: result.attempts,
      },
    },
    created_at: collectedAt,
  };
}

function apiTransitOfferStatusForProbeResult(result) {
  if (result?.ok) return "active";
  if (result?.groupId && typeof result.multiplier === "number" && Number.isFinite(result.multiplier)) return "needs_review";
  return "inactive";
}

function buildOfferRows(source, groups, probeResults, collectedAt) {
  const rows = [];
  const groupsById = new Map(groups.filter((group) => group.id !== null).map((group) => [Number(group.id), group]));
  const seen = new Set();

  for (const result of probeResults) {
    if (!result.groupId || typeof result.multiplier !== "number" || !Number.isFinite(result.multiplier)) continue;
    for (const model of modelsForProbeResult(result)) {
      const row = buildOfferRow(source, { ...result, ...model }, collectedAt);
      rows.push(row);
      seen.add(row.id);
    }
  }

  for (const group of groupsById.values()) {
    if (typeof group.multiplier !== "number" || !Number.isFinite(group.multiplier)) continue;
    const fallback = buildUnprobedOfferRow(source, group, collectedAt);
    if (seen.has(fallback.id)) continue;
    rows.push(fallback);
    seen.add(fallback.id);
  }

  return dedupeOfferRows(rows);
}

function dedupeOfferRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = offerKey(row);
    const existing = byKey.get(key);
    if (!existing || offerRowPriority(row) > offerRowPriority(existing)) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

function offerRowPriority(row) {
  const sourceScore = row.availability_source_type === "priceai_probe" ? 10 : 0;
  const sampleScore = Number(row.availability_seven_day_samples || 0);
  const statusScore = row.status === "active" ? 1 : 0;
  return sourceScore + sampleScore + statusScore;
}

function modelsForProbeResult(result) {
  const matchedModels = standardModelsFromAvailableModels(result.sampleModels || []);
  if (!matchedModels.length) {
    return [{ family: result.family, standardModel: result.standardModel, rawModelName: result.rawModelName }];
  }

  const byModel = new Map();
  for (const model of matchedModels) {
    const key = `${model.standardModel}|${model.rawModelName}`;
    if (!byModel.has(key)) byModel.set(key, model);
  }
  if (!byModel.has(`${result.standardModel}|${result.rawModelName}`)) {
    byModel.set(`${result.standardModel}|${result.rawModelName}`, {
      family: result.family,
      standardModel: result.standardModel,
      rawModelName: result.rawModelName,
    });
  }
  return Array.from(byModel.values());
}

function standardModelsFromAvailableModels(models) {
  const output = [];
  for (const rawModelName of models || []) {
    const matcher = standardModelMatchers.find((item) => matchAvailableModel([rawModelName], item.candidates));
    if (!matcher) continue;
    output.push({
      family: matcher.family,
      standardModel: matcher.standardModel,
      rawModelName: String(rawModelName),
    });
  }
  return output;
}

function buildUnprobedOfferRow(source, group, collectedAt) {
  const model = representativeModelForGroup(group);
  const multiplier = round(group.multiplier, 6);
  const publicMultiplier = publicMultiplierForStandardModel(model.standardModel, multiplier);
  return {
    id: stableId("api-transit-offer", source.id, model.standardModel, group.id),
    station_id: source.id,
    family: model.family,
    standard_model: model.standardModel,
    raw_model_name: model.rawModelName,
    group_name: group.name,
    recharge_ratio: DEFAULT_RECHARGE_RATIO,
    model_multiplier: publicMultiplier,
    input_price: publicMultiplier,
    output_price: publicMultiplier,
    cache_read_price: publicMultiplier,
    cache_write_price: publicMultiplier,
    currency: "CNY",
    account_pool: inferAccountPool(group.name),
    channel_type: inferChannelType(`${group.name} ${group.platform}`),
    price_source: "Sub2API 登录分组接口",
    source_url: source.dashboardUrl,
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_first_checked_at: null,
    availability_last_checked_at: null,
    availability_note: "已通过登录态分组接口刷新倍率；暂未用测试 Key 抽样。",
    availability_source_type: "unknown",
    availability_source_label: null,
    availability_source_url: null,
    last_verified_at: collectedAt,
    status: "active",
    raw_payload: {
      group: {
        id: group.id,
        name: group.name,
        platform: group.platform,
        multiplier,
        updatedAt: group.updatedAt,
      },
      probe: {
        ok: null,
        skipped: true,
        reason: "group_multiplier_only",
      },
    },
    created_at: collectedAt,
  };
}

function publicMultiplierForStandardModel(standardModel, multiplier) {
  return standardModel === "Qwen3.8-Max-Preview" ? null : multiplier;
}

function representativeModelForGroup(group) {
  const text = `${group.name} ${group.platform}`.toLowerCase();
  if (/sora[-_\s]?2[-_\s]?pro/.test(text)) {
    return {
      family: "video",
      standardModel: "Sora 2 Pro",
      rawModelName: "sora-2-pro",
    };
  }
  if (/sora[-_\s]?2/.test(text)) {
    return {
      family: "video",
      standardModel: "Sora 2",
      rawModelName: "sora-2",
    };
  }
  if (/veo[-_\s]?3[.\-_\s]?1[-_\s]?lite/.test(text)) {
    return {
      family: "video",
      standardModel: "Veo 3.1 Lite",
      rawModelName: "veo-3.1-lite",
    };
  }
  if (/veo[-_\s]?3[.\-_\s]?1/.test(text)) {
    return {
      family: "video",
      standardModel: "Veo 3.1",
      rawModelName: "veo-3.1",
    };
  }
  if (/gemini[-_\s]?omni[-_\s]?flash/.test(text)) {
    return {
      family: "video",
      standardModel: "Gemini Omni Flash",
      rawModelName: "gemini-omni-flash",
    };
  }
  if (/seedance[-_\s]?2(?:[.\-_\s]?0)?/.test(text)) {
    return {
      family: "video",
      standardModel: "Seedance 2.0",
      rawModelName: "seedance-2.0",
    };
  }
  if (/happy\s*horse|happyhorse|happyhouse|hh1[.\-_\s]?1[-_\s]?i2v/.test(text)) {
    return {
      family: "video",
      standardModel: "HappyHorse 1.1 I2V",
      rawModelName: "happyhorse-1.1-i2v",
    };
  }
  if (/kling[-_\s]?2[.\-_\s]?5[-_\s]?turbo/.test(text)) {
    return {
      family: "video",
      standardModel: "Kling 2.5 Turbo",
      rawModelName: "kling-2.5-turbo",
    };
  }
  if (/nano[-_\s]?banana[-_\s]?pro/.test(text)) {
    return {
      family: "image",
      standardModel: "Nano Banana Pro",
      rawModelName: "nano-banana-pro",
    };
  }
  if (/nano[-_\s]?banana[-_\s]?lite/.test(text)) {
    return {
      family: "image",
      standardModel: "Nano Banana Lite",
      rawModelName: "nano-banana-lite",
    };
  }
  if (/nano[-_\s]?banana[-_\s]?2/.test(text)) {
    return {
      family: "image",
      standardModel: "Nano Banana 2",
      rawModelName: "nano-banana-2",
    };
  }
  if (/nano[-_\s]?banana|gemini[-_\s]?2[.\-_\s]?5[-_\s]?flash[-_\s]?image/.test(text)) {
    return {
      family: "image",
      standardModel: "Nano Banana",
      rawModelName: "nano-banana",
    };
  }
  if (/image|draw|生图|绘图|flux/.test(text)) {
    return {
      family: "image",
      standardModel: "GPT Image 2",
      rawModelName: "gpt-image-2",
    };
  }
  if (/video|视频|生视频|文生视频|图生视频/.test(text)) {
    return {
      family: "video",
      standardModel: "Sora 2",
      rawModelName: "sora-2",
    };
  }

  if (/kimi[-_\s]?k?3|moonshot.*k3/.test(text)) {
    return {
      family: "kimi",
      standardModel: "Kimi K3",
      rawModelName: "kimi-k3",
    };
  }

  if (/qwen[-_\s]?3[.\-_\s]?8.*max|千问[-_\s]?3[.\-_\s]?8.*max/.test(text)) {
    return {
      family: "qwen",
      standardModel: "Qwen3.8-Max-Preview",
      rawModelName: "qwen3.8-max-preview",
    };
  }

  if (/qwen[-_\s]?3[.\-_\s]?7.*max|千问[-_\s]?3[.\-_\s]?7.*max/.test(text)) {
    return {
      family: "qwen",
      standardModel: "Qwen3.7-Max",
      rawModelName: "qwen3.7-max",
    };
  }

  if (/anthropic|claude|cc|max|kiro/.test(text)) {
    const isFable = text.includes("fable");
    const isSonnet = text.includes("sonnet");
    const isSonnetFive = isSonnet && /(?:sonnet[^0-9]*5|5[^a-z0-9]*sonnet)/.test(text);
    const standardModel = isFable ? "Claude Fable 5" : isSonnetFive ? "Claude Sonnet 5" : isSonnet ? "Claude Sonnet 4.6" : "Claude Opus 4.8";
    const rawModelName = isFable
      ? "claude-fable-5"
      : isSonnetFive
      ? "claude-sonnet-5"
      : isSonnet
        ? "claude-sonnet-4-6"
        : "claude-opus-4-8";
    return {
      family: "claude",
      standardModel,
      rawModelName,
    };
  }

  return {
    family: "gpt",
    standardModel: "GPT 5.5",
    rawModelName: "gpt-5.5",
  };
}

function selectTargetGroups(groups) {
  return targetPlans.map((plan) => ({
    plan,
    group: selectGroupForPlan(groups, plan),
  }));
}

function selectGroupForPlan(groups, plan) {
  if (plan.groupSelector === "openai_general") {
    return groups
      .filter((group) => group.platform === "openai" && !/pro|生图|image|draw|flux/i.test(group.name))
      .sort(compareGroupsForPrice)[0] || null;
  }

  if (plan.groupSelector === "openai_pro") {
    return groups
      .filter((group) => group.platform === "openai" && /pro/i.test(group.name) && !/生图|image|draw|flux/i.test(group.name))
      .sort(compareGroupsForPrice)[0] || null;
  }

  if (plan.groupSelector === "claude_sonnet") {
    return groups
      .filter((group) => /anthropic|claude/i.test(`${group.platform} ${group.name}`) && /sonnet/i.test(group.name))
      .sort(compareGroupsForPrice)[0] || null;
  }

  if (plan.groupSelector === "kimi") {
    return groups
      .filter((group) => /kimi|moonshot/i.test(`${group.platform} ${group.name}`))
      .sort(compareGroupsForPrice)[0] || null;
  }

  if (plan.groupSelector === "qwen") {
    return groups
      .filter((group) => /qwen|千问|百炼|bailian/i.test(`${group.platform} ${group.name}`))
      .sort(compareGroupsForPrice)[0] || null;
  }

  return groups
    .filter((group) => /anthropic|claude/i.test(`${group.platform} ${group.name}`))
    .sort(compareGroupsForPrice)[0] || null;
}

function compareGroupsForPrice(left, right) {
  return nullableSortValue(left.multiplier) - nullableSortValue(right.multiplier) || String(left.name).localeCompare(String(right.name));
}

function normalizeGroup(group) {
  return {
    id: numberValue(group.id),
    name: String(group.name || group.display_name || group.group_name || "").trim(),
    description: String(group.description || "").trim(),
    platform: String(group.platform || "").trim().toLowerCase(),
    multiplier: numberValue(group.rate_multiplier ?? group.multiplier ?? group.rate ?? group.group_ratio),
    status: String(group.status || "unknown"),
    updatedAt: group.updated_at ? String(group.updated_at) : null,
  };
}

function normalizeKeyRows(payload) {
  const data = payload?.data;
  const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
  return rows.map((row) => ({
    id: row.id || null,
    name: row.name || null,
    key: row.key || row.api_key || row.token || null,
    groupId: numberValue(row.group_id),
    groupName: row.group_name || row.group?.name || null,
    status: row.status || null,
  }));
}

function normalizeModelIds(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return rows
    .map((row) => (typeof row === "string" ? row : row?.id || row?.model || row?.name))
    .filter(Boolean)
    .map(String);
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
        "content-type": "application/json",
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
      const error = new Error(extractErrorMessage(json) || text.slice(0, 240) || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return { status: response.status, headers: response.headers, json };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("请求超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function postRows(rows, options) {
  const plan = {
    dryRun: Boolean(options.dryRun),
    stations: rows.stations.length,
    credentialSubmissions: rows.credentialSubmissions?.length || 0,
    credentials: rows.credentials?.length || 0,
    offers: rows.offers.length,
    runs: rows.runs.length,
    publish: Boolean(options.publish),
  };

  if (options.dryRun) {
    return {
      ...plan,
      skipped: true,
      message: "--dry-run --post 只验证将要写入的 Sub2API 中转数据，不连接 Supabase。",
    };
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for --post/--db.");

  const existingStations = await readExistingStations(supabase, rows.stations.map((station) => station.id));
  const stations = rows.stations.map((station) => mergeStationForRefresh(station, existingStations.get(station.id), options));
  const existingOffers = await readExistingOffers(supabase, rows.offers);
  const offers = rows.offers.map((offer) => mergeOfferForRefresh(offer, existingOffers.get(offerKey(offer)), options));
  const refreshedOfferKeys = new Set(offers.map((offer) => offerKey(offer)));
  const staleOfferIds = findStaleOfferIds(existingOffers, refreshedOfferKeys);

  await upsertRows(supabase, "api_transit_stations", stations, { onConflict: "id" });
  if (rows.credentialSubmissions?.length) {
    await upsertRows(supabase, "api_transit_submissions", rows.credentialSubmissions, { onConflict: "id" });
  }
  if (rows.credentials?.length) {
    await upsertRows(supabase, "api_transit_credentials", rows.credentials, { onConflict: "id" });
  }
  await upsertRows(supabase, "api_transit_offers", offers, { onConflict: "station_id,standard_model,group_name" });
  await deactivateOffersById(supabase, staleOfferIds);
  await upsertRows(supabase, "api_transit_detection_runs", rows.runs, { onConflict: "id" });

  return {
    ...plan,
    deactivatedOffers: staleOfferIds.length,
    skipped: false,
    message: options.publish ? "Sub2API 中转数据已写入并发布。" : "Sub2API 中转数据已写入待审核队列。",
  };
}

function findStaleOfferIds(existingOffers, refreshedOfferKeys) {
  const ids = [];
  for (const [key, offer] of existingOffers.entries()) {
    if (offer.status !== "active") continue;
    if (!refreshedOfferKeys.has(key)) ids.push(offer.id);
  }
  return ids;
}

async function deactivateOffersById(supabase, offerIds) {
  for (const chunk of chunks(offerIds, 300)) {
    if (!chunk.length) continue;
    const { error } = await supabase.from("api_transit_offers").update({ status: "inactive" }).in("id", chunk);
    if (error) {
      error.table = "api_transit_offers";
      throw error;
    }
  }
}

async function readExistingOffers(supabase, offers) {
  const stationIds = uniqueText(offers.map((offer) => offer.station_id)).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(stationIds, 100)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_offers")
      .select("id,station_id,standard_model,group_name,status,created_at,availability_first_checked_at")
      .in("station_id", chunk);
    if (error) {
      if (isMissingColumnError(error, "availability_first_checked_at")) {
        return readExistingOffersWithoutFirstCheckedAt(supabase, offers);
      }
      throw error;
    }
    for (const row of data || []) byId.set(offerKey(row), row);
  }
  return byId;
}

async function readExistingOffersWithoutFirstCheckedAt(supabase, offers) {
  const stationIds = uniqueText(offers.map((offer) => offer.station_id)).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(stationIds, 100)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_offers")
      .select("id,station_id,standard_model,group_name,status,created_at")
      .in("station_id", chunk);
    if (error) throw error;
    for (const row of data || []) byId.set(offerKey(row), row);
  }
  return byId;
}

function mergeOfferForRefresh(offer, existing, options) {
  const merged = {
    ...offer,
    id: existing?.id || offer.id,
    status: options.publish ? offer.status : existing?.status || offer.status,
    created_at: existing?.created_at || offer.created_at,
  };
  return normalizeUnknownAvailability(merged, "已通过登录态分组接口刷新倍率；暂未用测试 Key 抽样。");
}

function offerKey(offer) {
  return [offer.station_id, offer.standard_model, offer.group_name].map((part) => String(part || "")).join("|");
}

async function readExistingStations(supabase, stationIds) {
  const ids = uniqueText(stationIds).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(ids, 300)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_stations")
      .select(
        [
          "id",
          "source_type",
          "commercial_relation",
          "summary",
          "payment_methods",
          "minimum_top_up",
          "balance_expiry",
          "support_channels",
          "refund_policy",
          "data_status",
          "usage_advice",
          "risk_labels",
          "commercial_offers",
          "verification_events",
          "availability_first_checked_at",
          "published",
          "admin_note",
          "created_at",
        ].join(","),
      )
      .in("id", chunk);
    if (error) {
      if (isMissingColumnError(error, "availability_first_checked_at")) {
        return readExistingStationsWithoutFirstCheckedAt(supabase, stationIds);
      }
      throw error;
    }
    for (const row of data || []) byId.set(row.id, row);
  }
  return byId;
}

async function readExistingStationsWithoutFirstCheckedAt(supabase, stationIds) {
  const ids = uniqueText(stationIds).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(ids, 300)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_stations")
      .select(
        [
          "id",
          "source_type",
          "commercial_relation",
          "summary",
          "payment_methods",
          "minimum_top_up",
          "balance_expiry",
          "support_channels",
          "refund_policy",
          "data_status",
          "usage_advice",
          "risk_labels",
          "commercial_offers",
          "verification_events",
          "published",
          "admin_note",
          "created_at",
        ].join(","),
      )
      .in("id", chunk);
    if (error) throw error;
    for (const row of data || []) byId.set(row.id, row);
  }
  return byId;
}

function mergeStationForRefresh(station, existing, options) {
  if (!existing) {
    return normalizeUnknownAvailability({
      ...station,
      published: Boolean(options.publish),
      data_status: options.publish ? "verified" : station.data_status,
    }, "已通过登录态分组接口刷新倍率；暂未用测试 Key 抽样。");
  }

  return normalizeUnknownAvailability({
    ...station,
    name: existing.name || station.name,
    source_type: existing.source_type || station.source_type,
    commercial_relation: existing.commercial_relation || station.commercial_relation,
    summary: existing.summary || station.summary,
    payment_methods: Array.isArray(existing.payment_methods) ? existing.payment_methods : station.payment_methods,
    minimum_top_up: existing.minimum_top_up ?? station.minimum_top_up,
    balance_expiry: existing.balance_expiry ?? station.balance_expiry,
    support_channels: Array.isArray(existing.support_channels) ? existing.support_channels : station.support_channels,
    refund_policy: existing.refund_policy ?? station.refund_policy,
    data_status: options.publish ? "verified" : existing.data_status || station.data_status,
    usage_advice: options.publish ? station.usage_advice : existing.usage_advice || station.usage_advice,
    risk_labels: options.publish
      ? station.risk_labels
      : Array.isArray(existing.risk_labels)
        ? existing.risk_labels
        : station.risk_labels,
    commercial_offers: existing.commercial_offers ?? station.commercial_offers,
    verification_events: existing.verification_events ?? station.verification_events,
    availability_first_checked_at: existing.availability_first_checked_at || station.availability_first_checked_at,
    published: options.publish ? true : Boolean(existing.published),
    admin_note: appendRefreshNote(existing.admin_note, station.admin_note),
    created_at: existing.created_at || station.created_at,
  }, "已通过登录态分组接口刷新倍率；暂未用测试 Key 抽样。");
}

function normalizeUnknownAvailability(row, fallbackNote) {
  if ((row.availability_source_type || "unknown") !== "unknown") return row;
  return {
    ...row,
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_first_checked_at: null,
    availability_last_checked_at: null,
    availability_note: unknownAvailabilityNote(row.availability_note, fallbackNote),
    availability_source_label: null,
    availability_source_url: null,
  };
}

function unknownAvailabilityNote(note, fallbackNote) {
  const text = stringValue(note);
  if (!text || STALE_UNKNOWN_AVAILABILITY_NOTE_PATTERN.test(text)) return fallbackNote || null;
  return text;
}

function appendRefreshNote(existingNote, refreshNote) {
  const existing = String(existingNote || "").trim();
  const refresh = String(refreshNote || "").trim();
  if (!existing) return refresh || null;
  if (!refresh || existing.includes(refresh)) return existing;
  const withoutPrior = existing.replace(/\n\n\[最近采集刷新\]\n[\s\S]*$/, "");
  return `${withoutPrior}\n\n[最近采集刷新]\n${refresh}`;
}

async function upsertRows(supabase, table, rows, options = {}) {
  for (const chunk of chunks(rows, 300)) {
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (error && isMissingColumnError(error, "availability_first_checked_at")) {
      const { error: fallbackError } = await supabase
        .from(table)
        .upsert(removeFieldsFromRows(chunk, ["availability_first_checked_at"]), options);
      if (!fallbackError) continue;
      fallbackError.table = table;
      throw fallbackError;
    }
    if (error) {
      error.table = table;
      throw error;
    }
  }
}

function removeFieldsFromRows(rows, fieldNames) {
  return rows.map((row) => {
    const next = { ...row };
    for (const fieldName of fieldNames) delete next[fieldName];
    return next;
  });
}

function isMissingColumnError(error, columnName) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "");
  return (code === "42703" || code === "PGRST204") && message.includes(columnName);
}

function getSupabaseClient() {
  const env = readEnvFile(envPath);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function encryptCredentialPayload(payload, secret) {
  const cryptoApi = globalThis.crypto || webcrypto;
  if (!cryptoApi?.subtle) throw new Error("当前运行环境不支持凭据加密。");

  const encoder = new TextEncoder();
  const keyMaterial = await cryptoApi.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await cryptoApi.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const encrypted = await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));

  return {
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    encoded: "base64",
  };
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

function credentialEncryptionSecret(options) {
  const env = readEnvFile(envPath);
  const secret =
    options.credentialEncryptionKey ||
    options["credential-encryption-key"] ||
    process.env.API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY ||
    env.API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY;
  if (!secret || String(secret).length < 32) {
    if (options.dryRun) return "dry-run-api-transit-credential-key-00000000";
    throw new Error("写入测试凭据需要配置 API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY。");
  }
  return String(secret);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value) {
  return Uint8Array.from(Buffer.from(String(value || ""), "base64"));
}

function authHeaders(auth) {
  const headers = {};
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  return headers;
}

function extractErrorMessage(json) {
  return json?.error?.message || json?.message || json?.error || null;
}

function isParameterRetryable(message) {
  return /max_tokens|max_completion_tokens|temperature|unsupported|not support|不支持/i.test(String(message || ""));
}

function matchAvailableModel(models, candidates) {
  const normalizedModels = models.map((model) => normalizeModelId(model));
  for (const candidate of candidates || []) {
    const normalizedCandidate = normalizeModelId(candidate);
    const index = normalizedModels.indexOf(normalizedCandidate);
    if (index >= 0) return models[index];
  }
  return null;
}

function normalizeModelId(value) {
  return String(value || "").toLowerCase().replace(/[._]/g, "-");
}

function sampleModelMatcher(model) {
  return /gpt-5|claude.*opus|opus.*4|sonnet|fable|kimi[-_. ]?k?3|qwen[-_. ]?3[.-]?(?:8|7).*max/i.test(String(model));
}

function inferAccountPool(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("kiro")) return "kiro";
  if (value.includes("max")) return "max";
  if (value.includes("team")) return "team";
  if (value === "gpt" || value.includes("plus")) return "plus";
  if (value.includes("pro")) return "pro";
  if (value.includes("official") || value.includes("官方") || value.includes("官转") || value.includes("官key")) return "official_api";
  if (value.includes("mixed") || value.includes("混")) return "mixed";
  return "undisclosed";
}

function inferChannelType(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("kiro")) return "reverse_engineered";
  if (value === "gpt" || value.includes("max") || value.includes("team") || value.includes("plus") || value.includes("pro")) return "first_party_pool";
  if (value.includes("official") || value.includes("官方") || value.includes("官转") || value.includes("官key")) return "official_api";
  if (value.includes("aws") || value.includes("azure") || value.includes("vertex") || value.includes("云")) return "cloud";
  if (value.includes("cc") || value.includes("code") || value.includes("号池")) return "first_party_pool";
  if (value.includes("混")) return "mixed";
  if (value.includes("分销") || value.includes("reseller")) return "reseller";
  return "undisclosed";
}

function redactGroup(group) {
  return {
    id: group.id,
    name: group.name,
    platform: group.platform,
    status: group.status,
    multiplier: group.multiplier,
    updatedAt: group.updatedAt,
  };
}

function redactSelectedTarget(selected) {
  return {
    targetId: selected.plan.id,
    family: selected.plan.family,
    standardModel: selected.plan.standardModel,
    rawModelName: selected.plan.rawModelName,
    group: selected.group ? redactGroup(selected.group) : null,
  };
}

function redactKeyResult(result) {
  return {
    targetId: result.targetId,
    groupId: result.group?.id || null,
    groupName: result.group?.name || null,
    created: Boolean(result.created),
    hasKey: Boolean(result.key),
    keyId: result.keyId || null,
    keyName: result.keyName || null,
    error: result.error || null,
  };
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const rawKey = item.slice(2);
    const [key, inlineValue] = rawKey.split("=", 2);
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
    url: options.url || options.websiteUrl,
    stationId: options.stationId || options["station-id"] || options.id,
    apiBaseUrl: options.apiBaseUrl || options["api-base-url"],
    apiV1BaseUrl: options.apiV1BaseUrl || options["api-v1-base-url"],
    dashboardUrl: options.dashboardUrl || options["dashboard-url"],
    dryRun: truthyOption(options.dryRun ?? options["dry-run"]),
    post: truthyOption(options.post),
    db: truthyOption(options.db),
    publish: truthyOption(options.publish),
    verbose: truthyOption(options.verbose),
    ensureKeys: truthyOption(options.ensureKeys ?? options["ensure-keys"]),
    postCredentials: truthyOption(options.postCredentials ?? options["post-credentials"]),
    saveAccountCredential: truthyOption(options.saveAccountCredential ?? options["save-account-credential"]),
    timeoutMs: Number(options.timeoutMs || options["timeout-ms"] || DEFAULT_TIMEOUT_MS),
  };
}

function requiredOption(value, name) {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function truthyOption(value) {
  return value === true || value === "true" || value === "1" || value === "";
}

function normalizeWebsiteUrl(value) {
  const text = String(value || "").trim();
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  return new URL(withProtocol).href;
}

function titleFromHost(hostname) {
  return hostname.replace(/^www\./, "").split(".").filter(Boolean).map(capitalize).join(" ");
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
}

function readEnvFile(filePath) {
  const output = {};
  if (!existsSync(filePath)) return output;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    output[match[1]] = unquote(match[2].trim());
  }
  return output;
}

function unquote(value) {
  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isExpired(value) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function safeHost(value) {
  try {
    return new URL(String(value || "")).hostname;
  } catch {
    return null;
  }
}

function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nullableSortValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function round(value, digits) {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueText(values) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function stableId(...parts) {
  const input = parts.filter((part) => part !== null && part !== undefined).join("|");
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) hash = (hash * 33) ^ input.charCodeAt(index);
  return `id-${(hash >>> 0).toString(36)}`;
}

function printSummary(result) {
  console.log(
    [
      "Sub2API transit import.",
      `station=${result.station.id}`,
      `groups=${result.counts.groups}`,
      `createdKeys=${result.counts.createdKeys}`,
      `credentials=${result.counts.credentials}`,
      `targets=${result.counts.successfulTargets}/${result.counts.targets}`,
      `offers=${result.counts.offers}`,
      result.database ? `database=${result.database.skipped ? "dry-run" : "posted"}` : "database=not-requested",
      result.publish ? "publish=true" : "publish=false",
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
  apiTransitOfferStatusForProbeResult,
  buildOfferRows,
  modelsForProbeResult,
  representativeModelForGroup,
  selectGroupForPlan,
  standardModelsFromAvailableModels,
};
