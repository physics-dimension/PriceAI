import { logApiError, safeApiErrorMessage } from "@/lib/api-errors";
import { authorizeCronRequest, cronMethodNotAllowed } from "@/lib/cron-auth";
import { getSupabaseServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function GET() {
  return cronMethodNotAllowed("执行 API 中转留存维护");
}

export async function POST(request: Request) {
  const authError = authorizeCronRequest(request, "执行 API 中转留存维护");
  if (authError) return authError;

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") === "offers" ? "offers" : "all";
  const dryRun = url.searchParams.get("apply") !== "1";
  const batchSize = boundedInteger(url.searchParams.get("batch"), 5000, 100, 20000);
  const startedAt = new Date().toISOString();

  try {
    const supabase = getSupabaseServerClient();
    if (!supabase) throw new Error("Supabase 尚未配置。");
    const { data, error } = scope === "offers"
      ? await supabase.rpc("prune_api_transit_offer_retention", {
          p_inactive_retention_days: 7,
          p_batch_size: batchSize,
          p_dry_run: dryRun,
        })
      : await supabase.rpc("prune_api_transit_retention", {
          p_batch_size: batchSize,
          p_dry_run: dryRun,
        });
    if (error) throw error;
    return Response.json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      scope,
      dryRun,
      batchSize,
      result: data,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logApiError("cron api transit retention", error);
    return Response.json({
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      scope,
      dryRun,
      batchSize,
      message: safeApiErrorMessage(error, "API 中转留存维护失败。"),
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}
