#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import accountBootstrap from "../config/api-transit-account-bootstrap.json" with { type: "json" };
import transitSources from "../config/api-transit-sources.json" with { type: "json" };
import { collectApiTransitPrices } from "./collect-api-transit.mjs";
import { importSub2ApiTransit } from "./import-sub2api-api-transit.mjs";

const env = {
  ...readEnvFile(new URL("../.env.local", import.meta.url)),
  ...process.env,
};
const options = parseArgs(process.argv.slice(2));
const selectedIds = optionList(options.station || options.stations);
const configuredIds = selectedIds.length ? selectedIds : accountBootstrap.stationIds;
const registrationEmail = String(
  options.email || env.PRICEAI_SUB2API_REGISTRATION_EMAIL || accountBootstrap.registrationEmail || "",
).trim();
const timeoutMs = integerOption(options["timeout-ms"], 5_000, 120_000, 30_000);
const skipPublicCollection = truthyOption(options["skip-public-collection"]);
const dryRun = truthyOption(options["dry-run"]);

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY。");
}
if (!env.API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY && !env.ADMIN_SESSION_SECRET) {
  throw new Error("缺少 API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY 或 ADMIN_SESSION_SECRET，不能安全保存账号和 Key。");
}
if (!registrationEmail) {
  throw new Error("缺少 --email 或 PRICEAI_SUB2API_REGISTRATION_EMAIL。");
}

const sourcesById = new Map(transitSources.map((source) => [source.id, source]));
const sources = configuredIds.map((id) => {
  const source = sourcesById.get(id);
  if (!source) throw new Error(`账号引导配置引用了不存在的来源：${id}`);
  if (source.stationSystem !== "sub_to_api") throw new Error(`${id} 不是 Sub2API 来源。`);
  return source;
});

if (!skipPublicCollection) {
  const collection = await collectApiTransitPrices({
    sources: sources.map((source) => source.id).join(","),
    post: !dryRun,
    dryRun,
    timeoutMs,
  });
  console.log(JSON.stringify({
    phase: "public_profiles",
    ...collection.counts,
    posted: Boolean(collection.database && !collection.database.skipped),
  }));
}

const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const results = [];
for (const source of sources) {
  const startedAt = Date.now();
  try {
    const existingAccount = await hasReadyAccount(database, source.id);
    const result = await importSub2ApiTransit({
      stationId: source.id,
      name: source.name,
      url: source.websiteUrl,
      apiBaseUrl: source.apiBaseUrl,
      register: !existingAccount,
      registerEmail: registrationEmail,
      monitorKeyOnly: true,
      post: !dryRun,
      publish: !dryRun,
      dryRun,
      timeoutMs,
    });
    const row = {
      station: source.id,
      status: "success",
      account: result.accountAction,
      groups: result.counts.groups,
      offers: result.counts.offers,
      monitors: result.counts.channelMonitors,
      samples: result.counts.availabilitySamples,
      createdKeys: result.counts.createdKeys,
      ms: Date.now() - startedAt,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  } catch (error) {
    const row = {
      station: source.id,
      status: "failed",
      reason: classifyFailure(error),
      message: errorMessage(error),
      ms: Date.now() - startedAt,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}

const summary = {
  checked: results.length,
  succeeded: results.filter((result) => result.status === "success").length,
  failed: results.filter((result) => result.status === "failed").length,
  emailVerificationRequired: results.filter((result) => result.reason === "email_verification").length,
  gateRequired: results.filter((result) => ["invitation", "turnstile", "registration_closed"].includes(result.reason)).length,
  createdKeys: results.reduce((total, result) => total + Number(result.createdKeys || 0), 0),
  offers: results.reduce((total, result) => total + Number(result.offers || 0), 0),
  monitorTargets: results.reduce((total, result) => total + Number(result.monitors || 0), 0),
  availabilitySamples: results.reduce((total, result) => total + Number(result.samples || 0), 0),
};
console.log(JSON.stringify({ summary }));

if (summary.failed > 0 && truthyOption(options["fail-on-partial"])) process.exitCode = 1;

async function hasReadyAccount(client, stationId) {
  const { count, error } = await client
    .from("api_transit_credentials")
    .select("id", { count: "exact", head: true })
    .eq("station_id", stationId)
    .eq("credential_type", "test_account")
    .eq("status", "ready");
  if (error) throw error;
  return Number(count || 0) > 0;
}

function classifyFailure(error) {
  const message = errorMessage(error);
  if (/邮箱验证码|email verify|email verification/i.test(message)) return "email_verification";
  if (/邀请码|invitation/i.test(message)) return "invitation";
  if (/turnstile|人机验证|captcha/i.test(message)) return "turnstile";
  if (/没有开放注册|registration.+(?:disabled|closed)/i.test(message)) return "registration_closed";
  if (/已经注册|already.+(?:registered|exist)/i.test(message)) return "existing_unmanaged_account";
  return "runtime_error";
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const [key, inlineValue] = item.slice(2).split("=", 2);
    const next = values[index + 1];
    if (inlineValue !== undefined) result[key] = inlineValue;
    else if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function optionList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function integerOption(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function truthyOption(value) {
  return value === true || value === "true" || value === "1" || value === "";
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return JSON.stringify(error);
  return String(error);
}

function readEnvFile(fileUrl) {
  const output = {};
  if (!existsSync(fileUrl)) return output;
  for (const line of readFileSync(fileUrl, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[match[1]] = value;
  }
  return output;
}
