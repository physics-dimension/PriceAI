#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { syncSub2ApiMonitor } from "./import-sub2api-api-transit.mjs";

const env = {
  ...readEnvFile(new URL("../.env.local", import.meta.url)),
  ...process.env,
};
const options = parseArgs(process.argv.slice(2));
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY。");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const stationFilter = optionList(options.station || options.stations);
const concurrency = integerOption(options.concurrency, 1, 4, 2);
const timeoutMs = integerOption(options["timeout-ms"], 5_000, 120_000, 30_000);
const post = options.post !== "false";

const { data: credentialRows, error: credentialError } = await supabase
  .from("api_transit_credentials")
  .select("station_id")
  .eq("credential_type", "test_account")
  .eq("status", "ready");
if (credentialError) throw credentialError;

let stationIds = Array.from(new Set((credentialRows || []).map((row) => row.station_id).filter(Boolean)));
if (stationFilter.length) stationIds = stationIds.filter((id) => stationFilter.includes(id));

const stations = [];
for (const ids of chunks(stationIds, 100)) {
  const { data, error } = await supabase
    .from("api_transit_stations")
    .select("id,name,website_url")
    .in("id", ids);
  if (error) throw error;
  stations.push(...(data || []));
}
stations.sort((left, right) => left.id.localeCompare(right.id));

const results = await mapConcurrent(stations, concurrency, async (station) => {
  const started = Date.now();
  try {
    const result = await syncSub2ApiMonitor({
      stationId: station.id,
      name: station.name,
      url: station.website_url,
      post,
      timeoutMs,
    });
    return {
      station: station.id,
      status: "success",
      monitors: result.counts.channelMonitors,
      offers: result.counts.offers,
      samples: result.counts.availabilitySamples,
      ms: Date.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      station: station.id,
      status: "failed",
      monitors: 0,
      offers: 0,
      samples: 0,
      ms: Date.now() - started,
      error: error instanceof Error
        ? error.message
        : error && typeof error === "object"
          ? JSON.stringify(error)
          : String(error),
    };
  }
});

for (const result of results) {
  console.log(JSON.stringify(result));
}
console.log(JSON.stringify({
  summary: {
    checked: results.length,
    succeeded: results.filter((result) => result.status === "success").length,
    failed: results.filter((result) => result.status === "failed").length,
    withMonitor: results.filter((result) => result.monitors > 0).length,
    monitors: results.reduce((total, result) => total + result.monitors, 0),
    offers: results.reduce((total, result) => total + result.offers, 0),
    samples: results.reduce((total, result) => total + result.samples, 0),
  },
}));

async function mapConcurrent(items, workerCount, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, runWorker));
  return results;
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

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function readEnvFile(fileUrl) {
  const output = {};
  if (!existsSync(fileUrl)) return output;
  for (const line of readFileSync(fileUrl, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[match[1]] = value;
  }
  return output;
}
