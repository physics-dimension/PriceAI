create or replace function public.prune_api_transit_offer_retention(
  p_inactive_retention_days integer default 7,
  p_batch_size integer default 5000,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retention_days integer := greatest(7, least(coalesce(p_inactive_retention_days, 7), 90));
  v_batch_size integer := greatest(100, least(coalesce(p_batch_size, 5000), 20000));
  v_cutoff timestamptz := now() - make_interval(days => v_retention_days);
  v_candidates bigint := 0;
  v_deleted bigint := 0;
  v_oldest_candidate timestamptz;
  v_newest_candidate timestamptz;
begin
  select count(*)::bigint, min(updated_at), max(updated_at)
  into v_candidates, v_oldest_candidate, v_newest_candidate
  from public.api_transit_offers
  where status = 'inactive'
    and updated_at < v_cutoff;

  if coalesce(p_dry_run, true) then
    return jsonb_build_object(
      'dryRun', true,
      'candidates', v_candidates,
      'oldestCandidate', v_oldest_candidate,
      'newestCandidate', v_newest_candidate,
      'settings', jsonb_build_object(
        'inactiveRetentionDays', v_retention_days,
        'batchSize', v_batch_size,
        'cutoff', v_cutoff
      )
    );
  end if;

  with stale as (
    select id
    from public.api_transit_offers
    where status = 'inactive'
      and updated_at < v_cutoff
    order by updated_at, id
    limit v_batch_size
    for update skip locked
  ), deleted as (
    delete from public.api_transit_offers as offers
    using stale
    where offers.id = stale.id
    returning offers.id
  )
  select count(*)::bigint into v_deleted from deleted;

  return jsonb_build_object(
    'dryRun', false,
    'candidates', v_candidates,
    'deleted', v_deleted,
    'oldestCandidate', v_oldest_candidate,
    'newestCandidate', v_newest_candidate,
    'settings', jsonb_build_object(
      'inactiveRetentionDays', v_retention_days,
      'batchSize', v_batch_size,
      'cutoff', v_cutoff
    )
  );
end;
$$;

revoke all on function public.prune_api_transit_offer_retention(integer, integer, boolean)
from public, anon, authenticated;
grant execute on function public.prune_api_transit_offer_retention(integer, integer, boolean)
to service_role;

create or replace function public.prune_api_transit_retention(
  p_batch_size integer default 5000,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('priceai:api-transit-retention', 0)) then
    return jsonb_build_object('dryRun', coalesce(p_dry_run, true), 'skipped', 'lease_busy');
  end if;

  return jsonb_build_object(
    'dryRun', coalesce(p_dry_run, true),
    'offers', public.prune_api_transit_offer_retention(7, p_batch_size, p_dry_run),
    'availability', public.prune_api_transit_availability_retention(8, 90, 365, p_batch_size, p_dry_run),
    'detectionRuns', public.prune_api_transit_detection_run_retention(14, 30, p_batch_size, p_dry_run)
  );
end;
$$;

revoke all on function public.prune_api_transit_retention(integer, boolean)
from public, anon, authenticated;
grant execute on function public.prune_api_transit_retention(integer, boolean)
to service_role;

comment on function public.prune_api_transit_offer_retention(integer, integer, boolean) is
  'Deletes inactive API transit offer entities after seven days while preserving independent multiplier history. Service role only; dry-run by default.';
comment on function public.prune_api_transit_retention(integer, boolean) is
  'Unified, service-role-only API transit retention entry point with a transaction advisory lock. Dry-run remains the default.';
