import { existsSync, readFileSync } from "node:fs";

export const CLOUDFLARE_LOCAL_ENV_FILES = [".env.local", ".dev.vars", ".env", ".env.standby.local"];

export const CLOUDFLARE_BUILD_REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_UMAMI_SCRIPT_URL",
  "NEXT_PUBLIC_UMAMI_WEBSITE_ID",
  "NEXT_PUBLIC_TRANSIT_DETECTOR_API_BASE_URL",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
];

export const CLOUDFLARE_DEPLOY_REQUIRED_ENV = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "NEXT_PUBLIC_GA_MEASUREMENT_ID",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "ADMIN_SESSION_VERSION",
  "CRON_SECRET",
  "API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY",
];

export const CLOUDFLARE_REQUIRED_ENV = [
  ...CLOUDFLARE_DEPLOY_REQUIRED_ENV,
  ...CLOUDFLARE_BUILD_REQUIRED_ENV,
];

export const CLOUDFLARE_OPTIONAL_ENV = ["NEXT_PUBLIC_UMAMI_ALLOWED_DOMAINS"];

export function loadCloudflareLocalEnv(files = CLOUDFLARE_LOCAL_ENV_FILES) {
  const loaded = [];

  for (const file of files) {
    if (!existsSync(file)) continue;

    loaded.push(file);
    const content = readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [name, value] = parsed;
      if (!hasEnv(name)) {
        process.env[name] = value;
      }
    }
  }

  loadWranglerVars();
  return loaded;
}

export function missingEnv(names) {
  return names.filter((name) => !hasEnv(name));
}

export function hasEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

export function assertRequiredEnv(names, label) {
  const missing = missingEnv(names);

  if (missing.length === 0) return;

  console.error(`Missing required ${label}:`);
  for (const name of missing) {
    console.error(`- ${name}`);
  }
  process.exit(1);
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;

  const [, name, rawValue] = match;
  return [name, unwrapValue(rawValue.trim())];
}

function unwrapValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

function loadWranglerVars(file = "wrangler.jsonc") {
  if (!existsSync(file)) return;

  try {
    const config = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
    const vars = config && typeof config === "object" ? config.vars : null;
    if (!vars || typeof vars !== "object") return;

    for (const [name, value] of Object.entries(vars)) {
      if (typeof value === "string" && !hasEnv(name)) {
        process.env[name] = value;
      }
    }
  } catch (error) {
    console.warn(`Could not load vars from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stripJsonComments(content) {
  return content
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}
