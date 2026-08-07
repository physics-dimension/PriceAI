import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_COLLECTOR_RUNTIME_ROOT = "/opt/priceai-nonshop";

export const COLLECTOR_RUNTIME_DEPENDENCY_FILES = [".nvmrc", "package.json", "package-lock.json"];

export const COLLECTOR_RUNTIME_SOURCE_FILES = [
  "scripts/collect-api-transit.mjs",
  "scripts/collect-prices.mjs",
  "scripts/out-of-stock-observation.mjs",
  "scripts/verify-hot-offers.mjs",
  "scripts/import-sub2api-api-transit.mjs",
  "scripts/probe-api-transit.mjs",
  "scripts/refresh-public-api-snapshots.mjs",
  "scripts/runtime-lease.mjs",
  "scripts/safe-fetch.mjs",
  "config/api-transit-probes.json",
  "config/api-transit-sources.json",
  "config/collectors.json",
];

export const COLLECTOR_RUNTIME_LAUNCHER_FILES = [
  "ops/collector-runtime/run-api-transit-public.sh",
  "ops/collector-runtime/run-domestic-nonshop.sh",
  "ops/collector-runtime/run-dujiao.sh",
  "ops/collector-runtime/run-generic-html-canary.sh",
  "ops/collector-runtime/run-main.sh",
  "ops/shop-collectors/run-hot-offer-verifier.sh",
  "ops/shop-collectors/hot-offer-verifier.env.example",
  "ops/shop-collectors/systemd/priceai-hot-offer-verifier.service",
  "ops/shop-collectors/systemd/priceai-hot-offer-verifier-hangzhou.timer",
  "ops/shop-collectors/systemd/priceai-hot-offer-verifier-heyuan.timer",
];

export const COLLECTOR_RUNTIME_WATCHLIST = uniqueSorted([
  ...COLLECTOR_RUNTIME_SOURCE_FILES,
  ...COLLECTOR_RUNTIME_LAUNCHER_FILES,
  ...COLLECTOR_RUNTIME_DEPENDENCY_FILES,
]);

export const COLLECTOR_RUNTIME_TIMERS = [
  "priceai-api-transit-public.timer",
  "priceai-generic-html-canary.timer",
  "priceai-nonshop-dujiao.timer",
  "priceai-nonshop-main.timer",
  "priceai-snapshot-refresh.timer",
];

export const COLLECTOR_RUNTIME_SERVICES = [
  "priceai-api-transit-public.service",
  "priceai-generic-html-canary.service",
  "priceai-nonshop-dujiao.service",
  "priceai-nonshop-main.service",
  "priceai-snapshot-refresh.service",
];

export function evaluateCollectorRuntimeGuard({
  cwd = process.cwd(),
  baseRef,
  targetRef = "HEAD",
  includeWorkingTree = false,
  fetchRef = "",
} = {}) {
  const resolvedTargetRef = targetRef || "HEAD";
  if (fetchRef) ensureGitObject(cwd, resolvedTargetRef, fetchRef);

  const resolvedBaseRef = baseRef || inferCollectorRuntimeBaseRef(cwd, resolvedTargetRef);
  const changedFiles = resolvedBaseRef ? changedFilesBetween(cwd, resolvedBaseRef, resolvedTargetRef) : [];
  const watchedChangedFiles = filterWatchedFiles(changedFiles);
  const workingTreeFiles = includeWorkingTree ? changedTrackedWorkingTreeFiles(cwd) : [];
  const watchedWorkingTreeFiles = filterWatchedFiles(workingTreeFiles);
  const dependencyChangedFiles = filterDependencyFiles([...watchedChangedFiles, ...watchedWorkingTreeFiles]);

  return {
    baseRef: resolvedBaseRef,
    targetRef: resolvedTargetRef,
    changedFiles: uniqueSorted([...watchedChangedFiles, ...watchedWorkingTreeFiles]),
    dependencyChangedFiles,
    workingTreeFiles: watchedWorkingTreeFiles,
    watchlist: COLLECTOR_RUNTIME_WATCHLIST,
  };
}

export function formatCollectorRuntimeGuardReport(result, { syncRef = "", overrideReason = "", dryRun = false } = {}) {
  const lines = [
    "Collector runtime preflight:",
    `- base: ${result.baseRef || "(unresolved)"}`,
    `- target: ${result.targetRef || "(unresolved)"}`,
  ];

  if (!result.changedFiles.length) {
    lines.push("- watched changes: none");
    return lines.join("\n");
  }

  lines.push(`- watched changes: ${result.changedFiles.length}`);
  for (const file of result.changedFiles) {
    const marker = result.dependencyChangedFiles.includes(file) ? " [dependency]" : "";
    lines.push(`  ${file}${marker}`);
  }

  if (syncRef) lines.push(`- runtime sync reference: ${syncRef}`);
  if (overrideReason) lines.push(`- explicit override reason: ${overrideReason}`);
  if (dryRun) lines.push("- dry run: a real deploy would require a sync reference or override reason.");

  return lines.join("\n");
}

export function filterWatchedFiles(files) {
  const watchlist = new Set(COLLECTOR_RUNTIME_WATCHLIST);
  return uniqueSorted(files.map(normalizeRepoPath).filter((file) => watchlist.has(file)));
}

export function filterDependencyFiles(files) {
  const dependencyFiles = new Set(COLLECTOR_RUNTIME_DEPENDENCY_FILES);
  return uniqueSorted(files.map(normalizeRepoPath).filter((file) => dependencyFiles.has(file)));
}

export function changedFilesBetween(cwd, baseRef, targetRef) {
  const output = gitOutput(["diff", "--name-only", `${baseRef}..${targetRef}`], { cwd });
  if (!output) return [];
  return output.split("\n").map(normalizeRepoPath).filter(Boolean);
}

export function changedTrackedWorkingTreeFiles(cwd) {
  const output = gitOutput(["status", "--short", "--untracked-files=no"], { cwd });
  if (!output) return [];

  return output
    .split("\n")
    .map((line) => line.slice(3).trim())
    .map((file) => file.split(" -> ").at(-1))
    .map(normalizeRepoPath)
    .filter(Boolean);
}

export function inferCollectorRuntimeBaseRef(cwd, targetRef = "HEAD") {
  const candidates = [];
  if (targetRef && /^[0-9a-f]{40}$/i.test(targetRef)) candidates.push(`${targetRef}^`);
  if (targetRef) candidates.push(`${targetRef}~1`);
  candidates.push("origin/main~1", "HEAD~1");

  for (const candidate of candidates) {
    if (gitOutput(["rev-parse", "--verify", `${candidate}^{commit}`], { cwd, allowFailure: true })) {
      return candidate;
    }
  }

  return "";
}

export function ensureGitObject(cwd, ref, fetchRef = "") {
  if (!ref || gitCommandSucceeds(["cat-file", "-e", `${ref}^{commit}`], { cwd })) return;
  if (!fetchRef || /^[0-9a-f]{40}$/i.test(fetchRef)) return;
  spawnSync("git", ["fetch", "--quiet", "origin", fetchRef], { cwd, encoding: "utf8" });
}

export function currentGitSha(cwd = process.cwd(), ref = "HEAD") {
  return gitOutput(["rev-parse", ref], { cwd });
}

export function gitOutput(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr || result.stdout || ""}`.trim());
  }
  return result.stdout.trim();
}

export function gitCommandSucceeds(args, { cwd = process.cwd() } = {}) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

export function buildRuntimeManifest({
  cwd = process.cwd(),
  mode,
  gitSha,
  baseRef = "",
  targetRef = "",
  files = COLLECTOR_RUNTIME_SOURCE_FILES,
  dependencyFiles = COLLECTOR_RUNTIME_DEPENDENCY_FILES,
  workflowRunUrl = "",
  extra = {},
} = {}) {
  const resolvedGitSha = gitSha || currentGitSha(cwd, targetRef || "HEAD");
  return {
    schemaVersion: 1,
    app: "priceai",
    component: "collector-runtime",
    mode,
    gitSha: resolvedGitSha,
    shortSha: resolvedGitSha.slice(0, 12),
    baseRef,
    targetRef: targetRef || resolvedGitSha,
    generatedAt: new Date().toISOString(),
    workflowRunUrl: workflowRunUrl || null,
    runtimeRoot: DEFAULT_COLLECTOR_RUNTIME_ROOT,
    files: files.map((file) => fileManifestEntry(cwd, file)),
    dependencies: dependencyFiles.map((file) => fileManifestEntry(cwd, file)),
    ...extra,
  };
}

export function fileManifestEntry(cwd, file) {
  const repoPath = normalizeRepoPath(file);
  const absolute = path.join(cwd, repoPath);
  if (!existsSync(absolute)) throw new Error(`Missing runtime file: ${repoPath}`);

  const stat = statSync(absolute);
  if (!stat.isFile()) throw new Error(`Runtime path is not a file: ${repoPath}`);

  return {
    path: repoPath,
    bytes: stat.size,
    mode: `0${(stat.mode & 0o777).toString(8)}`,
    sha256: sha256File(absolute),
  };
}

export function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

export function checksumFileContent(entries) {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

export function validateRuntimeFiles(cwd, files) {
  return files.map((file) => fileManifestEntry(cwd, file));
}

export function normalizeRepoPath(file) {
  return String(file || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

export function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
