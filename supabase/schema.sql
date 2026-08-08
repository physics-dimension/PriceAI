create table if not exists canonical_products (
  id text primary key,
  slug text not null unique,
  display_name text not null,
  platform text not null,
  product_type text not null,
  spec text not null default '',
  summary text not null default '',
  aliases text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sources (
  id text primary key,
  name text not null,
  base_url text,
  entry_url text not null,
  collection_method text not null default 'manual',
  collector_kind text,
  runtime_region text not null default 'default',
  buyer_fee_rate numeric check (buyer_fee_rate is null or (buyer_fee_rate >= 0 and buyer_fee_rate <= 0.2)),
  buyer_fee_payment_method text,
  buyer_fee_strategy text check (buyer_fee_strategy is null or buyer_fee_strategy = 'manual_verified'),
  collection_group text not null default 'automatic' check (collection_group in ('automatic', 'vip_15m')),
  constraint sources_vip_collection_contract_check check (
    collection_group <> 'vip_15m'
    or (collector_kind = 'shopApi' and collection_method = 'http')
  ),
  enabled boolean not null default true,
  notes text,
  health_status text not null default 'unknown',
  last_checked_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error text,
  availability_status text not null default 'unknown' check (availability_status in ('unknown', 'available', 'out_of_stock')),
  out_of_stock_since timestamptz,
  consecutive_out_of_stock_snapshots integer not null default 0 check (consecutive_out_of_stock_snapshots >= 0),
  collector_lock_until timestamptz,
  collector_lock_owner text,
  collector_lock_started_at timestamptz,
  shop_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table sources add column if not exists health_status text not null default 'unknown';
alter table sources add column if not exists last_checked_at timestamptz;
alter table sources add column if not exists last_success_at timestamptz;
alter table sources add column if not exists consecutive_failures integer not null default 0;
alter table sources add column if not exists last_error text;
alter table sources add column if not exists availability_status text not null default 'unknown';
alter table sources add column if not exists out_of_stock_since timestamptz;
alter table sources add column if not exists consecutive_out_of_stock_snapshots integer not null default 0;
alter table sources add column if not exists collector_kind text;
alter table sources add column if not exists runtime_region text not null default 'default';
alter table sources add column if not exists buyer_fee_rate numeric;
alter table sources add column if not exists buyer_fee_payment_method text;
alter table sources add column if not exists buyer_fee_strategy text;
alter table sources add column if not exists collection_group text not null default 'automatic';
alter table sources add column if not exists collector_lock_until timestamptz;
alter table sources add column if not exists collector_lock_owner text;
alter table sources add column if not exists collector_lock_started_at timestamptz;
alter table sources add column if not exists shop_created_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sources_availability_status_check'
      and conrelid = 'sources'::regclass
  ) then
    alter table sources
      add constraint sources_availability_status_check
      check (availability_status in ('unknown', 'available', 'out_of_stock'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'sources_out_of_stock_snapshot_count_check'
      and conrelid = 'sources'::regclass
  ) then
    alter table sources
      add constraint sources_out_of_stock_snapshot_count_check
      check (consecutive_out_of_stock_snapshots >= 0);
  end if;
end
$$;

create index if not exists sources_collection_group_enabled_idx
  on sources (collection_group, id)
  where enabled = true;

create index if not exists sources_availability_observation_idx
  on sources (availability_status, out_of_stock_since, last_checked_at)
  where enabled = true;

create table if not exists raw_offers (
  id text primary key,
  source_id text references sources(id) on delete set null,
  source_name text not null,
  source_store_name text,
  source_title text not null,
  price numeric,
  listed_price numeric,
  fee_amount numeric,
  price_basis text,
  currency text not null default 'CNY',
  status text not null default 'unknown',
  source_status text not null default 'unknown',
  effective_status text not null default 'low_confidence',
  freshness_status text not null default 'fresh',
  url text not null,
  tags text[] not null default '{}',
  stock_count integer,
  min_order_quantity integer,
  bulk_pricing_tiers jsonb not null default '[]'::jsonb,
  hidden boolean not null default false,
  canonical_product_id text references canonical_products(id) on delete set null,
  category_slug text,
  captured_at timestamptz not null default now(),
  source_updated_at timestamptz,
  last_seen_at timestamptz not null default now(),
  verified_at timestamptz,
  expires_at timestamptz,
  source_priority integer not null default 50,
  confidence numeric not null default 0.5,
  last_failed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table raw_offers add column if not exists source_status text not null default 'unknown';
alter table raw_offers add column if not exists listed_price numeric;
alter table raw_offers add column if not exists fee_amount numeric;
alter table raw_offers add column if not exists price_basis text;
alter table raw_offers add column if not exists effective_status text not null default 'low_confidence';
alter table raw_offers add column if not exists freshness_status text not null default 'fresh';
alter table raw_offers add column if not exists verified_at timestamptz;
alter table raw_offers add column if not exists expires_at timestamptz;
alter table raw_offers add column if not exists source_priority integer not null default 50;
alter table raw_offers add column if not exists confidence numeric not null default 0.5;
alter table raw_offers add column if not exists last_failed_at timestamptz;
alter table raw_offers add column if not exists failure_reason text;
alter table raw_offers add column if not exists min_order_quantity integer;
alter table raw_offers add column if not exists bulk_pricing_tiers jsonb not null default '[]'::jsonb;

update raw_offers
set
  source_status = status,
  verified_at = coalesce(verified_at, last_seen_at, captured_at, source_updated_at),
  source_priority = case
    when exists (
      select 1 from sources
      where sources.id = raw_offers.source_id
        and sources.collection_method = 'public_json'
    ) then 40
    else 90
  end,
  confidence = case
    when exists (
      select 1 from sources
      where sources.id = raw_offers.source_id
        and sources.collection_method = 'public_json'
    ) then 0.55
    else 0.90
  end,
  effective_status = case
    when status = 'out_of_stock' then 'unavailable'
    else 'available'
  end,
  freshness_status = case
    when coalesce(expires_at, verified_at + interval '24 hours', last_seen_at + interval '24 hours', captured_at + interval '24 hours') < now() then 'expired'
    else 'fresh'
  end,
  expires_at = coalesce(
    expires_at,
    coalesce(verified_at, last_seen_at, captured_at, source_updated_at) +
      interval '24 hours'
  )
where true;

create table if not exists raw_offer_confirmations (
  raw_offer_id text primary key references raw_offers(id) on delete cascade,
  source_id text references sources(id) on delete set null,
  confirmed_at timestamptz not null,
  captured_at timestamptz,
  last_seen_at timestamptz not null,
  verified_at timestamptz not null,
  expires_at timestamptz,
  source_status text not null default 'unknown',
  effective_status text not null default 'low_confidence',
  freshness_status text not null default 'fresh',
  source_priority integer,
  confidence numeric,
  price numeric,
  stock_count integer,
  updated_at timestamptz not null default now()
);

create table if not exists raw_offer_missing_candidates (
  raw_offer_id text primary key references raw_offers(id) on delete cascade,
  source_id text not null references sources(id) on delete cascade,
  first_missing_at timestamptz not null,
  latest_missing_at timestamptz not null,
  missing_count integer not null default 1 check (missing_count >= 1),
  latest_seen_run_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'resolved_seen', 'resolved_hidden', 'ignored')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists offer_matches (
  id text primary key,
  raw_offer_id text not null references raw_offers(id) on delete cascade,
  canonical_product_id text not null references canonical_products(id) on delete cascade,
  match_method text not null default 'rule',
  confidence numeric not null default 0.75,
  created_at timestamptz not null default now(),
  unique(raw_offer_id, canonical_product_id)
);

create table if not exists crawl_runs (
  id text primary key,
  source_id text references sources(id) on delete set null,
  source_name text,
  mode text not null,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  message text,
  details jsonb not null default '{}'::jsonb
);

create table if not exists crawl_log_ingest_runs (
  id text primary key,
  source_id text references sources(id) on delete set null,
  source_name text,
  started_at timestamptz not null,
  batch_index integer,
  batch_count integer,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  result jsonb,
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists collection_jobs (
  id text primary key,
  job_type text not null check (job_type in ('all', 'source', 'official_prices', 'api_models', 'api_transit_public_pricing')),
  source_id text references sources(id) on delete set null,
  source_name text,
  status text not null default 'pending' check (status in ('pending', 'running', 'success', 'failed', 'cancelled')),
  priority integer not null default 0,
  attempts integer not null default 0,
  max_attempts integer not null default 1,
  requested_by text,
  locked_by text,
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists source_shard_assignments (
  source_id text not null references sources(id) on delete cascade,
  collector_kind text not null default 'shopApi',
  family text not null,
  shard_count integer not null check (shard_count between 1 and 32),
  shard_index integer not null check (shard_index >= 0 and shard_index < shard_count),
  weight numeric not null default 1,
  weight_signals jsonb not null default '{}'::jsonb,
  assignment_version text not null default 'manual',
  active boolean not null default true,
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, collector_kind, family, shard_count)
);

create table if not exists shop_api_fee_policies (
  source_id text not null references sources(id) on delete cascade,
  shop_token text not null,
  source_name text,
  shop_url text,
  strategy text not null check (strategy in ('no_fee', 'fixed_3pct', 'observed_rate')),
  rate numeric not null check (rate >= 0 and rate <= 0.2),
  sample_size integer not null default 0 check (sample_size >= 0),
  resolved_sample_size integer not null default 0 check (resolved_sample_size >= 0),
  sample_selection text,
  probes jsonb not null default '[]'::jsonb check (jsonb_typeof(probes) = 'array'),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  collector_node_id text,
  last_seen_run_id text references crawl_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, shop_token)
);

create table if not exists collector_heartbeats (
  node_id text primary key,
  node_name text not null,
  node_type text,
  runtime text,
  region text,
  scope text,
  status text not null default 'unknown' check (status in ('running', 'success', 'partial', 'failed', 'idle', 'unknown')),
  started_at timestamptz,
  finished_at timestamptz,
  last_seen_at timestamptz not null default now(),
  success_count integer not null default 0,
  failure_count integer not null default 0,
  skipped_count integer not null default 0,
  offer_count integer not null default 0,
  message text,
  details jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists raw_offers_canonical_product_id_idx on raw_offers(canonical_product_id);
create index if not exists raw_offers_source_id_idx on raw_offers(source_id);
create index if not exists raw_offers_status_idx on raw_offers(status);
create index if not exists raw_offers_effective_status_idx on raw_offers(effective_status);
create index if not exists raw_offers_verified_at_idx on raw_offers(verified_at desc);
create index if not exists raw_offers_expires_at_idx on raw_offers(expires_at);
create index if not exists raw_offers_hidden_idx on raw_offers(hidden);
create index if not exists raw_offers_product_public_page_idx
on raw_offers (
  canonical_product_id,
  hidden,
  status,
  price,
  verified_at desc,
  last_seen_at desc,
  captured_at desc,
  source_updated_at desc,
  id
);
create index if not exists canonical_products_slug_idx on canonical_products(slug);
create index if not exists sources_health_status_idx on sources(health_status);
create index if not exists sources_last_checked_at_idx on sources(last_checked_at desc);
create index if not exists sources_collector_kind_idx on sources(collector_kind);
create index if not exists sources_collector_lock_until_idx on sources(collector_lock_until);
create index if not exists sources_shop_created_at_idx on sources(shop_created_at desc);
create index if not exists raw_offers_visible_product_price_idx
  on raw_offers(canonical_product_id, price)
  where hidden = false and price is not null;
create index if not exists crawl_runs_started_at_idx on crawl_runs(started_at desc);
create index if not exists crawl_log_ingest_runs_status_expires_at_idx
  on crawl_log_ingest_runs(status, expires_at);
create index if not exists crawl_log_ingest_runs_source_started_at_idx
  on crawl_log_ingest_runs(source_id, started_at desc);
create index if not exists collection_jobs_status_created_at_idx on collection_jobs(status, created_at desc);
create index if not exists collection_jobs_source_status_idx on collection_jobs(source_id, status);
create index if not exists collection_jobs_locked_until_idx on collection_jobs(locked_until);
create index if not exists source_shard_assignments_lookup_idx
  on source_shard_assignments(collector_kind, family, shard_count, shard_index)
  where active = true;
create index if not exists source_shard_assignments_assigned_at_idx
  on source_shard_assignments(assigned_at desc);
create index if not exists shop_api_fee_policies_source_expires_idx
  on shop_api_fee_policies(source_id, expires_at desc);
create index if not exists shop_api_fee_policies_expires_idx
  on shop_api_fee_policies(expires_at);
create index if not exists shop_api_fee_policies_strategy_idx
  on shop_api_fee_policies(strategy);
create index if not exists collector_heartbeats_last_seen_at_idx on collector_heartbeats(last_seen_at desc);
create index if not exists collector_heartbeats_status_last_seen_at_idx on collector_heartbeats(status, last_seen_at desc);

create or replace function priceai_public_offer_filter_tags(
  p_source_title text,
  p_tags text[] default '{}'
)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  text_value text := regexp_replace(
    lower(
      regexp_replace(
        coalesce(p_source_title, '') || ' ' || array_to_string(coalesce(p_tags, array[]::text[]), ' '),
        '[[:space:]]+',
        '',
        'g'
      )
    ),
    '[【】\[\]（）()]',
    ' ',
    'g'
  );
  title_text text := regexp_replace(
    lower(
      regexp_replace(coalesce(p_source_title, ''), '[[:space:]]+', '', 'g')
    ),
    '[【】\[\]（）()]',
    ' ',
    'g'
  );
  tags_text text := regexp_replace(
    lower(
      regexp_replace(array_to_string(coalesce(p_tags, array[]::text[]), ' '), '[[:space:]]+', '', 'g')
    ),
    '[【】\[\]（）()]',
    ' ',
    'g'
  );
  global_warranty_text text;
  output text[] := array[]::text[];
begin
  global_warranty_text := regexp_replace(
    text_value,
    '(不质保(封号|封禁|被封|账号|账户)|封号(不质保|无质保|无售后|不保|不售后|不在售后范围)|封禁(不质保|无质保|无售后|不保|不售后|不在售后范围)|不保(封号|封禁|被封|账号|账户)|不管(封号|封禁|被封)|封号不管)',
    '',
    'g'
  );

  if text_value !~ '(非拼车|不是拼车|不拼车|无拼车|拒绝拼车|非团购|不是团购|不团购|非共享|不是共享|不共享|无共享|非合租|不是合租|不合租|非车位|不是车位)'
    and (
      text_value ~ '(拼车|团购|拼团|车位|多人共享|多人共用|(多人|二人|两人|双人|三人|四人|五人|六人|七人|八人|九人|十人|[2-9]人|[1-9][0-9]人)体验(号|账号|帐号)|(二|两|双|三|四|五|六|七|八|九|十|[2-9]|[1-9][0-9])人(车|共享|共用|位)|多人车|车友|车队|家庭车|团号|团购车|拼车位|共享车)'
      or (
        text_value !~ '(独享|独立|一人一号|一人一户|专享)'
        and text_value ~ '(共享|共用|合租|共享号)'
      )
    )
  then
    output := array_append(output, 'shared_access');
  end if;

  if text_value ~ '(国内镜像站|国内镜像|网页镜像|镜像站|镜像|mirror)' then
    output := array_append(output, 'domestic_mirror_site');
  end if;

  if text_value ~ '(网页号|仅限网页|仅支持?网页|只支持网页|只能网页|仅网页|只可网页|只能网页登录|仅网页登录)' then
    output := array_append(output, 'web_only_account');
  end if;

  if title_text ~ '(自助充值|自助开通|自助卡密|卡密自助|自助激活|自动充值|自动开通|自动激活|全自动激活|全自动开通|直充|代充|卡充|充值|续费|代开|内购|激活码|兑换码|cdk|卡密|提链|提取链接|支付二维码|扫码对接|upi扫码|pix渠道|ideal渠道|i deal渠道)'
    or tags_text ~ '(自助充值|自助开通|自助卡密|卡密自助|自助激活|自动充值|自动开通|自动激活|全自动激活|全自动开通|直充|代充|卡充|充值|续费|代开|内购|激活码|兑换码|cdk|提链|提取链接|支付二维码|扫码对接|upi扫码|pix渠道|ideal渠道|i deal渠道)'
  then
    output := array_append(output, 'delivery_recharge');
  end if;

  if text_value ~ '(提链|提炼|链接提取|提取链接|长链提取|长链接提取|支付链接提取|提取支付链接)' then
    output := array_append(output, 'chatgpt_service_link');
  end if;

  if text_value !~ '(不包括扫码|不含扫码|无需扫码|不用扫码|非扫码服务)'
    and text_value ~ '(扫码对接|代付代扫|代扫服务|支付二维码生成|二维码生成率|提取支付二维码|支付二维码提取)'
  then
    output := array_append(output, 'chatgpt_service_scan');
  end if;

  if text_value ~ '(自助充值|自助开通|自助卡密|卡密自助|自助激活|自动充值|自动开通|自动激活|全自动充值|全自动开通|全自动激活)' then
    output := array_append(output, 'chatgpt_service_self_recharge');
  end if;

  if text_value ~ '(未接码|未完成接码|没接码|未绑手机|未绑定手机|没绑手机|没绑定手机|未绑手机号|未绑定手机号|无手机绑定|无绑手机|自行接码|自己接码|需自行接码|需自己接码|需要自行接码|需要自己接码|需要接码|需接码|要接码|接码登录codex|codex.{0,12}(需|要|需要|自行|自己)接码)' then
    output := array_append(output, 'account_unverified');
  elsif text_value ~ '(已接码|已完成接码|已经接码|已手机接码|已绑手机|已绑定手机|已经绑手机|已经绑定手机|已绑手机号|已绑定手机号|带2fa|带二验|可二验)' then
    output := array_append(output, 'account_verified');
  end if;

  if text_value !~ '(非成品|不是成品|非账号|不是账号|非账户|不是账户|不交付账号|不发账号|不提供账号|不含账号|无需账号|自备账号|自备号|自己账号|自己的账号|到自己账号|冲自己号|充值自己号|给自己号)'
    and title_text !~ '(自助充值|自助开通|自助领取|自助激活|自动充值|自动开通|自动激活|全自动激活|全自动开通|免费试用资格|试用资格|资格新号|仅支持新号|老号有试用|新号都可以|充值渠道非成品|非成品|自备账号|国内镜像站|国内镜像|网页镜像|镜像站|镜像|mirror|拼车|团购|拼团|车位|多人共享|多人共用|多人体验号)'
    and title_text ~ '(成品号|成品账号|成品帐号|成品会员账号|成品|账号购买|账号|帐号|账户|账密|独享号|独享账号|独享账户|库存号|会员号|普通号|普号|白号|网页号|半成品|首登|保首登|质保首登|直登|未接码|已接码|已接|未接|带2fa|带二验|可二验|已绑手机|未绑手机)'
  then
    output := array_append(output, 'delivery_account');
  end if;

  if text_value ~ '(18个月|十八个月|1\.5年|一年半)'
    and text_value ~ '(提链|提取链接|提取优惠链接|优惠链接|活动链接|领取链接|兑换链接|激活链接|链接|jio|googleone)'
  then
    output := array_append(output, 'gemini_18_month_link');
  elsif text_value ~ '(12个月|十二个月|一年|1年|365天|三百六十五天|年卡|年度|全年)'
    and text_value !~ '(18个月|十八个月|1\.5年|一年半)'
    and text_value !~ '(不含绑卡|无绑卡|无需绑卡|免绑卡|不包绑卡|自行绑卡|自己绑卡)'
    and text_value ~ '(含绑卡|包绑卡|包含绑卡|带绑卡|代绑卡|绑卡完成|绑定卡|自动订阅|自动开通|包开通|代开通|全包)'
  then
    output := array_append(output, 'gemini_12_month_card_binding');
  elsif text_value ~ '(12个月|十二个月|一年|1年|365天|三百六十五天|年卡|年度|全年)'
    and text_value !~ '(18个月|十八个月|1\.5年|一年半)'
    and text_value ~ '(提链|提取链接|提取优惠链接|优惠链接|活动链接|领取链接|兑换链接|激活链接|链接|jio|googleone)'
    and (
      text_value !~ '(含绑卡|包绑卡|包含绑卡|带绑卡|代绑卡|绑卡完成|绑定卡|自动订阅|自动开通|包开通|代开通|全包)'
      or text_value ~ '(不含绑卡|无绑卡|无需绑卡|免绑卡|不包绑卡|自行绑卡|自己绑卡)'
    )
  then
    output := array_append(output, 'gemini_12_month_link');
  end if;

  if text_value ~ '(巴西|brazil|巴西区)'
    and text_value ~ '((^|[^a-z])pix([^a-z]|$)|pix渠道|pix充值|巴西pix)'
  then
    output := array_append(output, 'chatgpt_plus_brazil_pix');
  elsif text_value ~ '(荷兰|netherlands|holland|nl区|荷区)'
    and text_value ~ '(ideal|i-deal|i/deal)'
  then
    output := array_append(output, 'chatgpt_plus_netherlands_ideal');
  elsif text_value ~ '(印度|india|印度区)'
    and text_value ~ '((^|[^a-z])upi([^a-z]|$)|upi渠道|upi扫码|印度upi)'
  then
    output := array_append(output, 'chatgpt_plus_india_upi');
  elsif text_value ~ '(欧洲渠道|欧洲|欧区|欧盟|奥地利|austria|at未接码|at渠道|at号)' then
    output := array_append(output, 'chatgpt_plus_europe_channel');
  end if;

  if text_value ~ '(菲区|菲律宾|菲律宾区|philippines|ph区)'
    and text_value ~ '(卡充|卡冲|卡付|卡密|cdk|官方充值|充值|代充|直充)'
  then
    output := array_append(output, 'chatgpt_plus_recharge_ph_card');
  elsif text_value ~ '(美区|美国|美国区|us区|usa|u\.s\.)'
    and text_value ~ '(ios|appstore|app-store|内购|苹果内购)'
  then
    output := array_append(output, 'chatgpt_plus_recharge_us_ios');
  elsif text_value ~ '(官方直充|官方充值|官方代充|官方订阅|正价代充|正价充值|正规充值|正规官方|正规卡付|正规卡冲|官网直充|官网直冲|官网代充|人工直充|自动直充|带账单|(google|谷歌).{0,8}(内购|正价)|(内购|正价).{0,8}(google|谷歌)|(google|谷歌)(pay)?渠道.{0,32}(充值|代充|直充|秒冲|cdk|卡密)|(充值|代充|直充|秒冲|cdk|卡密).{0,32}(google|谷歌)(pay)?渠道)' then
    output := array_append(output, 'chatgpt_plus_recharge_official_direct');
  end if;

  if title_text ~ '(正价|正规官方|官方.{0,12}(team|business|团队|席位)|business\(team\)|gptbusiness|48个月|48月|四十八个月|4年|四年|全程质保订阅|无限续费|可无限续费|可用pro模型额度比plus高|首次激活码|续费码)' then
    output := array_append(output, 'team_official');
  elsif title_text ~ 'k12' then
    output := array_append(output, 'team_k12');
  elsif title_text ~ '(bugteam|teambug|bug号|bug號|漏洞)' then
    output := array_append(output, 'team_bug');
  elsif tags_text ~ '(正价|正规官方|官方.{0,12}(team|business|团队|席位)|business\(team\)|gptbusiness|48个月|48月|四十八个月|4年|四年|全程质保订阅|无限续费|可无限续费|可用pro模型额度比plus高|首次激活码|续费码)' then
    output := array_append(output, 'team_official');
  elsif tags_text ~ 'k12' then
    output := array_append(output, 'team_k12');
  elsif tags_text ~ '(bugteam|teambug|bug号|bug號|漏洞)' then
    output := array_append(output, 'team_bug');
  end if;

  if text_value ~ '(12个月|十二个月|一年|1年|365天|三百六十五天|年卡|年度|全年)' then
    output := array_append(output, 'duration_year');
  end if;

  if text_value ~ '(6个月|六个月|180天|一百八十天|半年|半年卡)' then
    output := array_append(output, 'duration_half_year');
  end if;

  if text_value ~ '(3个月|三个月|90天|九十天|季度|季卡)' then
    output := array_append(output, 'duration_quarter');
  end if;

  if text_value ~ '(月卡|月会员|一个月|1个月|30天|三十天|一月|单月)' then
    output := array_append(output, 'duration_month');
  end if;

  if text_value ~ '((^|[^0-9])([1-9]|10)天(号|会员|体验)?|(二|两|三|四|五|六|七|八|九|十)天(号|会员|体验)?|[1-9]-10天|2到10天|2至10天|3-7天|7-10天|周会员|一周会员|体验卡|短期体验)' then
    output := array_append(output, 'duration_trial');
  end if;

  if text_value ~ '(月租|包月接码|接码包月|包月号码|长期租号|月付接码|30天接码|一个月接码|1个月接码)' then
    output := array_append(output, 'verification_monthly');
  elsif text_value ~ '(长效接码|长期接码|长效手机号|长期手机号|原始接码链接|电话接码链接|带电话接码链接|接码链接|取码url|取码链接|可续接|续接)' then
    output := array_append(output, 'verification_long');
  elsif text_value ~ '(短效接码|短效手机号|短期接码|短时接码|临时号码|短效号码|实卡接码|实体卡接码)' then
    output := array_append(output, 'verification_short');
  elsif text_value ~ '(单次接码|一次性接码|一次性验证|1次接码|1次验证|一次码|单号接码|接一次|质保1次成功接码|质保一次成功接码)' then
    output := array_append(output, 'verification_single');
  end if;

  if text_value !~ '(仅支持?网页|只能网页|仅网页|网页号|不支持codex|无法使用codex|不能使用codex|不能直接登录codex|无法直接登录codex|无法codex|codex不售后|不可反代|无法反代|不能反代|不支持反代)'
    and text_value ~ '(可反代|支持反代|反代\+?codex|可用codex|支持codex|直接登录codex|sub2|cpa|api格式|json格式|json文件|sub格式|cpa格式)'
    and text_value ~ '(chatgpt|gpt|openai|codex)'
    and text_value ~ '(plus|team|business|free|普号|普通号|白号|账号|成品号|网页号|半成品|独享|母号|邀请|k12|bug|首登|已接码|未接码|已接|未接)'
    and text_value !~ '(gemini|claude|grok|kiro|cursor|perplexity|suno|dreamina|api|中转|余额|额度|号池|token|倍率|openrouter|nvidia)'
  then
    output := array_append(output, 'proxy_supported');
  end if;

  if (
      (
        text_value ~ '(包gcp|支持gcp|gcp可用|gcp已开|gcp正常|googlecloud|谷歌云)'
        and text_value !~ '(不包gcp|无gcp|gcp已禁用|gcp禁用|不支持gcp|gcp不可用|不带gcp|不含gcp|不送gcp)'
      )
      or (
        text_value ~ '(包反重力|支持反重力|反重力直接用|反重力可用|可用反重力|antigravity)'
        and text_value !~ '(不包反重力|不支持反重力|反重力不可用|无法反重力|不能反重力|不等于反重力)'
      )
      or (
        text_value ~ '((gemini|googleai|googleaipro|gcp|反重力|antigravity).{0,16}cli|cli.{0,16}(gemini|googleai|googleaipro|gcp|反重力|antigravity)|codeassist)'
        and text_value !~ '(不支持cli|cli不可用|无法cli|不能cli)'
      )
    )
  then
    output := array_append(output, 'gemini_antigravity_gcp');
  end if;

  if text_value !~ '(无需绑定手机|无需绑手机|无须绑定手机|无须绑手机|免绑手机|不用绑手机|不需要绑定手机|不需要绑手机)'
    and text_value ~ '(需要绑定手机|需绑定手机|需要绑手机|需绑手机|绑定手机号|绑定手机|手机号接码|手机接码|长效接码|接码|人机号|人机账号|人机帐号)'
  then
    output := array_append(output, 'gemini_phone_required');
  end if;

  if text_value !~ '(无需申诉|无须申诉|免申诉|不用申诉|不需要申诉|无需注册|无须注册|免注册|不用注册|不需要注册)'
    and text_value ~ '(首登需要申诉|需要申诉|需申诉|申诉|需注册|需要注册|没注册过谷歌|未注册过谷歌|没注册过google|未注册过google)'
  then
    output := array_append(output, 'gemini_appeal_required');
  end if;

  if global_warranty_text !~ '(无.{0,4}质保|没.{0,4}质保|不质保|不保|不售后|售后不管|一律不售后|无售后|不作售后条件|不做售后|不管售后)'
    and text_value !~ '(质保首登|保首登|包首登|首登质保|首次登录|首次登陆|质保首次|质保购买一小时内首登|质保[0-9]+h?内首登|质保(一|二|三|四|五|六|七|八|九|十)+小时内首登|质保上车|只质保上车|仅质保上车|包上车|保上车|上车质保|质保登上|质保登录|质保登陆|质保直登|质保首登成功)'
    and text_value !~ '(质保([1-9]|1[0-4]|一|二|三|四|五|六|七|八|九|十|十一|十二|十三|十四)天|(^|[^0-9])([1-9]|1[0-4])天质保|(一|二|三|四|五|六|七|八|九|十|十一|十二|十三|十四)天质保|质保(一周|1周|两周|2周|二周)|(一周|1周|两周|2周|二周)质保|7天售后|七天售后|质保[0-9]{1,2}h|质保(24|48|72)小时|质保[0-9]+小时|[0-9]+h质保|[0-9]+小时质保|质保(1|2|3|4|5|6|7|8|9|一|二|三|四|五|六|七|八|九)次成功接码|质保(1|2|3|4|5|6|7|8|9|一|二|三|四|五|六|七|八|九)次接码|质保(1|2|3|4|5|6|7|8|9|一|二|三|四|五|六|七|八|九)次|质保额度|质保不来码|质保开通|仅质保开通|只质保开通|质保充值成功|质保激活成功|质保到手|质保上车|只质保上车|仅质保上车|包上车|保上车|上车质保)'
    and text_value ~ '(质保(1[5-9]|[2-9][0-9]|[1-9][0-9]{2,})天|(1[5-9]|[2-9][0-9]|[1-9][0-9]{2,})天质保|质保((订阅|定阅|稳定|权益|会员|掉会员|掉订阅|封号|封订阅|封号和订阅|封号封订阅)|[/丨·、,，和+&-]){1,6}(1[5-9]|[2-9][0-9]|[1-9][0-9]{2,})天|质保(十五|二十|二十五|二十八|三十|一百八十)天|(十五|二十|二十五|二十八|三十|一百八十)天质保|质保((订阅|定阅|稳定|权益|会员|掉会员|掉订阅|封号|封订阅|封号和订阅|封号封订阅)|[/丨·、,，和+&-]){1,6}(十五|二十|二十五|二十八|三十|一百八十)天|质保(半个月|一个月|1个月|一月|整月|两个月|2个月|二个月|三个月|3个月|一年|1年|12个月|180天)|(半个月|一个月|1个月|一月|整月|两个月|2个月|二个月|三个月|3个月|一年|1年|12个月|180天)质保|质保((订阅|定阅|稳定|权益|会员|掉会员|掉订阅|封号|封订阅|封号和订阅|封号封订阅)|[/丨·、,，和+&-]){1,6}(半个月|一个月|1个月|一月|整月|两个月|2个月|二个月|三个月|3个月|一年|1年|12个月|180天)|全程质保|全程保|质保全程(订阅|定阅|权益|会员)?|质保((订阅|定阅|稳定|权益|会员|掉会员|掉订阅)|[/丨·、,，和+&-]){1,6}全程|全程((订阅|定阅|稳定|权益|会员|掉会员|掉订阅)|[/丨·、,，和+&-]){1,6}质保|包月售后|包月质保|质保包月)'
  then
    output := array_append(output, 'warranty_long');
  end if;

  return output;
end;
$$;

create or replace function priceai_public_offer_normalized_url(
  p_url text
)
returns text
language sql
immutable
set search_path = public
as $$
  with parsed as (
    select
      trim(coalesce(p_url, '')) as value,
      lower((regexp_match(trim(coalesce(p_url, '')), '^https?://(?:www\.)?([^/?#]+)'))[1]) as host,
      (regexp_match(trim(coalesce(p_url, '')), '^https?://(?:www\.)?[^/?#]+/item/([^/?#]+)'))[1] as path_goods_key,
      (regexp_match(trim(coalesce(p_url, '')), '[?&](commodity|id)=([^&#]+)'))[2] as query_goods_key
  )
  select
    case
      when host in ('catfk.com', 'ldxp.cn', 'pay.ldxp.cn', 'pay.qxvx.cn')
        and coalesce(path_goods_key, query_goods_key) is not null
      then 'https://' || host || '/item/' || coalesce(path_goods_key, query_goods_key)
      else regexp_replace(regexp_replace(lower(value), '#.*$', ''), '/$', '')
    end
  from parsed;
$$;

create or replace function priceai_public_offer_dedupe_key(
  p_product_id text,
  p_url text,
  p_source_title text,
  p_price numeric
)
returns text
language sql
immutable
set search_path = public
as $$
  select concat_ws(
    '|',
    coalesce(p_product_id, ''),
    priceai_public_offer_normalized_url(p_url),
    regexp_replace(lower(coalesce(p_source_title, '')), '[[:space:]]+', '', 'g'),
    regexp_replace(
      regexp_replace(coalesce(to_char(p_price, 'FM999999999999990.0000'), ''), '0+$', ''),
      '\.$',
      ''
    )
  );
$$;

alter table raw_offers
  add column if not exists public_filter_tags text[]
  generated always as (priceai_public_offer_filter_tags(source_title, tags)) stored;

create index if not exists raw_offers_public_filter_tags_idx
  on raw_offers using gin (public_filter_tags)
  where hidden = false;

create index if not exists raw_offer_confirmations_confirmed_at_idx
  on raw_offer_confirmations(confirmed_at desc);

create index if not exists raw_offer_confirmations_source_confirmed_at_idx
  on raw_offer_confirmations(source_id, confirmed_at desc);

create index if not exists raw_offer_confirmations_expires_at_idx
  on raw_offer_confirmations(expires_at);

create index if not exists raw_offer_missing_candidates_source_status_idx
  on raw_offer_missing_candidates(source_id, status, latest_missing_at desc);

create index if not exists raw_offer_missing_candidates_latest_missing_at_idx
  on raw_offer_missing_candidates(latest_missing_at desc);

drop view if exists raw_offer_public_state;

create view raw_offer_public_state as
select
  raw_offers.id,
  raw_offers.source_id,
  raw_offers.source_name,
  raw_offers.source_store_name,
  raw_offers.source_title,
  raw_offers.price,
  raw_offers.listed_price,
  raw_offers.fee_amount,
  raw_offers.price_basis,
  raw_offers.currency,
  raw_offers.status,
  coalesce(raw_offer_confirmations.source_status, raw_offers.source_status) as source_status,
  coalesce(raw_offer_confirmations.effective_status, raw_offers.effective_status) as effective_status,
  coalesce(raw_offer_confirmations.freshness_status, raw_offers.freshness_status) as freshness_status,
  raw_offers.url,
  raw_offers.tags,
  raw_offers.public_filter_tags,
  raw_offers.stock_count,
  raw_offers.min_order_quantity,
  coalesce(raw_offers.bulk_pricing_tiers, '[]'::jsonb) as bulk_pricing_tiers,
  raw_offers.hidden,
  raw_offers.canonical_product_id,
  raw_offers.category_slug,
  coalesce(raw_offer_confirmations.captured_at, raw_offers.captured_at) as captured_at,
  raw_offers.source_updated_at,
  coalesce(raw_offer_confirmations.last_seen_at, raw_offers.last_seen_at) as last_seen_at,
  coalesce(raw_offer_confirmations.verified_at, raw_offers.verified_at) as verified_at,
  coalesce(raw_offer_confirmations.expires_at, raw_offers.expires_at) as expires_at,
  coalesce(raw_offer_confirmations.source_priority, raw_offers.source_priority) as source_priority,
  coalesce(raw_offer_confirmations.confidence, raw_offers.confidence) as confidence,
  raw_offers.last_failed_at,
  raw_offers.failure_reason,
  raw_offers.created_at,
  raw_offers.updated_at
from raw_offers
left join raw_offer_confirmations
  on raw_offer_confirmations.raw_offer_id = raw_offers.id;

create or replace function acquire_source_collection_lock(
  p_source_id text,
  p_owner text,
  p_lock_seconds integer default 600
)
returns table(acquired boolean, lock_owner text, lock_until timestamptz)
language plpgsql
security definer
as $$
declare
  v_now timestamptz := now();
  v_lock_until timestamptz := now() + make_interval(secs => greatest(60, least(coalesce(p_lock_seconds, 600), 3600)));
begin
  update sources
  set
    collector_lock_owner = p_owner,
    collector_lock_started_at = v_now,
    collector_lock_until = v_lock_until,
    updated_at = v_now
  where id = p_source_id
    and (
      collector_lock_until is null
      or collector_lock_until < v_now
      or collector_lock_owner = p_owner
    );

  if found then
    return query select true, p_owner, v_lock_until;
    return;
  end if;

  return query
  select
    false,
    sources.collector_lock_owner,
    sources.collector_lock_until
  from sources
  where sources.id = p_source_id;
end;
$$;

create or replace function release_source_collection_lock(
  p_source_id text,
  p_owner text
)
returns boolean
language plpgsql
security definer
as $$
begin
  update sources
  set
    collector_lock_owner = null,
    collector_lock_started_at = null,
    collector_lock_until = null,
    updated_at = now()
  where id = p_source_id
    and collector_lock_owner = p_owner;

  return found;
end;
$$;

create or replace function list_public_product_offers_page(
  p_product_id text,
  p_limit integer default 80,
  p_offset integer default 0
)
returns table (
  id text,
  source_id text,
  source_name text,
  source_store_name text,
  source_title text,
  price numeric,
  currency text,
  status text,
  url text,
  tags text[],
  stock_count integer,
  min_order_quantity integer,
  bulk_pricing_tiers jsonb,
  hidden boolean,
  canonical_product_id text,
  category_slug text,
  captured_at timestamptz,
  source_updated_at timestamptz,
  last_seen_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz,
  source_priority integer,
  confidence numeric,
  effective_status text,
  freshness_status text,
  last_failed_at timestamptz,
  failure_reason text,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select
      raw_offers.*,
      count(*) over() as total_count,
      case
        when raw_offers.status <> 'out_of_stock'
          and raw_offers.price is not null
          and raw_offers.url <> ''
          and coalesce(raw_offers.effective_status, '') not in ('unavailable', 'stale', 'failed')
          and coalesce(raw_offers.freshness_status, '') not in ('expired', 'failed')
          and (raw_offers.expires_at is null or raw_offers.expires_at > now())
        then 0
        else 1
      end as availability_rank,
      case
        when coalesce(raw_offers.public_filter_tags, priceai_public_offer_filter_tags(raw_offers.source_title, raw_offers.tags)) && array['shared_access', 'web_only_account', 'domestic_mirror_site']::text[]
        then 1
        else 0
      end as special_delivery_rank,
      coalesce(raw_offers.verified_at, raw_offers.last_seen_at, raw_offers.captured_at, raw_offers.source_updated_at) as public_updated_at,
      coalesce(raw_offers.source_store_name, raw_offers.source_name, '') as public_source_label
    from raw_offer_public_state raw_offers
    where raw_offers.hidden = false
      and raw_offers.canonical_product_id = p_product_id
  )
  select
    ranked.id,
    ranked.source_id,
    ranked.source_name,
    ranked.source_store_name,
    ranked.source_title,
    ranked.price,
    ranked.currency,
    ranked.status,
    ranked.url,
    ranked.tags,
    ranked.stock_count,
    ranked.min_order_quantity,
    ranked.bulk_pricing_tiers,
    ranked.hidden,
    ranked.canonical_product_id,
    ranked.category_slug,
    ranked.captured_at,
    ranked.source_updated_at,
    ranked.last_seen_at,
    ranked.verified_at,
    ranked.expires_at,
    ranked.source_priority,
    ranked.confidence,
    ranked.effective_status,
    ranked.freshness_status,
    ranked.last_failed_at,
    ranked.failure_reason,
    ranked.total_count
  from ranked
  order by
    ranked.availability_rank asc,
    ranked.special_delivery_rank asc,
    ranked.price asc nulls last,
    ranked.public_updated_at desc nulls last,
    ranked.public_source_label asc,
    ranked.source_title asc,
    ranked.url asc,
    ranked.id asc
  limit greatest(least(coalesce(p_limit, 80), 1200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function list_public_product_offers_page_v2(
  p_product_id text,
  p_filter_tags text[] default '{}',
  p_query text default null,
  p_exclude_query text default null,
  p_collector text default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_min_stock integer default null,
  p_fresh_within_minutes integer default null,
  p_limit integer default 80,
  p_offset integer default 0
)
returns table (
  id text,
  source_id text,
  source_name text,
  source_store_name text,
  source_title text,
  price numeric,
  currency text,
  status text,
  url text,
  tags text[],
  stock_count integer,
  min_order_quantity integer,
  bulk_pricing_tiers jsonb,
  hidden boolean,
  canonical_product_id text,
  category_slug text,
  captured_at timestamptz,
  source_updated_at timestamptz,
  last_seen_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz,
  source_priority integer,
  confidence numeric,
  effective_status text,
  freshness_status text,
  last_failed_at timestamptz,
  failure_reason text,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with product as (
    select id
    from canonical_products
    where is_active = true
      and (canonical_products.id = p_product_id or canonical_products.slug = p_product_id)
    limit 1
  ),
  filtered as (
    select
      raw_offers.*,
      sources.collector_kind,
      concat_ws(
        ' ',
        raw_offers.source_title,
        raw_offers.source_name,
        raw_offers.source_store_name,
        raw_offers.url,
        array_to_string(raw_offers.tags, ' ')
      ) as public_haystack,
      case
        when sources.collector_kind = 'shopApi' then 'shopApi'
        when sources.collector_kind = 'dujiao' then 'dujiao'
        when sources.collector_kind = 'kami' then 'kami'
        else 'other'
      end as collector_group
    from raw_offer_public_state raw_offers
    join product on product.id = raw_offers.canonical_product_id
    left join sources on sources.id = raw_offers.source_id
    where raw_offers.hidden = false
  ),
  ranked as (
    select
      filtered.*,
      count(*) over() as total_count,
      case
        when filtered.status <> 'out_of_stock'
          and filtered.price is not null
          and filtered.url <> ''
          and coalesce(filtered.effective_status, '') not in ('unavailable', 'stale', 'failed')
          and coalesce(filtered.freshness_status, '') not in ('expired', 'failed')
          and (filtered.expires_at is null or filtered.expires_at > now())
        then 0
        else 1
      end as availability_rank,
      case
        when filtered.public_filter_tags && array['shared_access', 'web_only_account', 'domestic_mirror_site']::text[]
        then 1
        else 0
      end as special_delivery_rank,
      coalesce(filtered.verified_at, filtered.last_seen_at, filtered.captured_at, filtered.source_updated_at) as public_updated_at,
      coalesce(filtered.source_store_name, filtered.source_name, '') as public_source_label
    from filtered
    where (coalesce(array_length(p_filter_tags, 1), 0) = 0 or filtered.public_filter_tags @> p_filter_tags)
      and (p_query is null or trim(p_query) = '' or filtered.public_haystack ilike ('%' || trim(p_query) || '%'))
      and (
        p_exclude_query is null
        or trim(p_exclude_query) = ''
        or not exists (
          select 1
          from regexp_split_to_table(trim(p_exclude_query), '[,，[:space:]]+') as excluded_term(term)
          where excluded_term.term <> ''
            and filtered.public_haystack ilike ('%' || excluded_term.term || '%')
        )
      )
      and (p_collector is null or trim(p_collector) = '' or p_collector = 'all' or filtered.collector_group = p_collector)
      and (p_min_price is null or filtered.price >= p_min_price)
      and (p_max_price is null or filtered.price <= p_max_price)
      and (p_min_stock is null or filtered.stock_count >= p_min_stock)
      and (
        p_fresh_within_minutes is null
        or coalesce(filtered.verified_at, filtered.last_seen_at, filtered.captured_at, filtered.source_updated_at)
          >= now() - make_interval(mins => p_fresh_within_minutes)
      )
  )
  select
    ranked.id,
    ranked.source_id,
    ranked.source_name,
    ranked.source_store_name,
    ranked.source_title,
    ranked.price,
    ranked.currency,
    ranked.status,
    ranked.url,
    ranked.tags,
    ranked.stock_count,
    ranked.min_order_quantity,
    ranked.bulk_pricing_tiers,
    ranked.hidden,
    ranked.canonical_product_id,
    ranked.category_slug,
    ranked.captured_at,
    ranked.source_updated_at,
    ranked.last_seen_at,
    ranked.verified_at,
    ranked.expires_at,
    ranked.source_priority,
    ranked.confidence,
    ranked.effective_status,
    ranked.freshness_status,
    ranked.last_failed_at,
    ranked.failure_reason,
    ranked.total_count
  from ranked
  order by
    ranked.availability_rank asc,
    ranked.special_delivery_rank asc,
    ranked.price asc nulls last,
    ranked.public_updated_at desc nulls last,
    ranked.public_source_label asc,
    ranked.source_title asc,
    ranked.url asc,
    ranked.id asc
  limit greatest(least(coalesce(p_limit, 80), 1200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function list_public_offers_page(
  p_query text default null,
  p_platform text default null,
  p_product_type text default null,
  p_stock text default null,
  p_sort text default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_limit integer default 80,
  p_offset integer default 0
)
returns table (
  id text,
  source_id text,
  source_name text,
  source_store_name text,
  source_title text,
  price numeric,
  currency text,
  status text,
  url text,
  tags text[],
  stock_count integer,
  min_order_quantity integer,
  bulk_pricing_tiers jsonb,
  hidden boolean,
  canonical_product_id text,
  category_slug text,
  captured_at timestamptz,
  source_updated_at timestamptz,
  last_seen_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz,
  source_priority integer,
  confidence numeric,
  effective_status text,
  freshness_status text,
  last_failed_at timestamptz,
  failure_reason text,
  product_id text,
  product_slug text,
  product_display_name text,
  product_platform text,
  product_type text,
  product_spec text,
  product_summary text,
  product_updated_at timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with filtered as (
    select
      raw_offers.*,
      canonical_products.id as product_id,
      canonical_products.slug as product_slug,
      canonical_products.display_name as product_display_name,
      canonical_products.platform as product_platform,
      canonical_products.product_type,
      canonical_products.spec as product_spec,
      canonical_products.summary as product_summary,
      canonical_products.updated_at as product_updated_at,
      case
        when raw_offers.status <> 'out_of_stock'
          and raw_offers.price is not null
          and raw_offers.url <> ''
          and coalesce(raw_offers.effective_status, '') not in ('unavailable', 'stale', 'failed')
          and coalesce(raw_offers.freshness_status, '') not in ('expired', 'failed')
          and (raw_offers.expires_at is null or raw_offers.expires_at > now())
        then true
        else false
      end as is_public_available,
      case
        when coalesce(raw_offers.public_filter_tags, priceai_public_offer_filter_tags(raw_offers.source_title, raw_offers.tags)) && array['shared_access', 'web_only_account', 'domestic_mirror_site']::text[]
        then 1
        else 0
      end as shared_access_rank,
      coalesce(raw_offers.verified_at, raw_offers.last_seen_at, raw_offers.captured_at, raw_offers.source_updated_at) as public_updated_at,
      coalesce(raw_offers.source_store_name, raw_offers.source_name, '') as public_source_label,
      priceai_public_offer_dedupe_key(
        raw_offers.canonical_product_id,
        raw_offers.url,
        raw_offers.source_title,
        raw_offers.price
      ) as public_dedupe_key,
      concat_ws(
        ' ',
        raw_offers.source_title,
        raw_offers.source_name,
        raw_offers.source_store_name,
        raw_offers.url,
        substring(raw_offers.url from '/item/([^/?#]+)'),
        substring(raw_offers.url from '[?&]commodity=([^&#]+)'),
        substring(raw_offers.url from '[?&]id=([^&#]+)'),
        canonical_products.display_name,
        canonical_products.platform,
        canonical_products.product_type,
        canonical_products.spec
      ) as public_haystack
    from raw_offer_public_state raw_offers
    join canonical_products on canonical_products.id = raw_offers.canonical_product_id
    where raw_offers.hidden = false
      and canonical_products.is_active = true
      and (p_platform is null or p_platform = '' or p_platform = '全部' or canonical_products.platform = p_platform)
      and (p_product_type is null or p_product_type = '' or p_product_type = '全部' or canonical_products.product_type = p_product_type)
      and (p_min_price is null or raw_offers.price >= p_min_price)
      and (p_max_price is null or raw_offers.price <= p_max_price)
  ),
  matched_filter as (
    select *
    from filtered
    where (p_query is null or trim(p_query) = '' or filtered.public_haystack ilike ('%' || trim(p_query) || '%'))
      and (p_stock is null or p_stock = '' or p_stock = 'all'
        or (p_stock = 'available' and filtered.is_public_available = true)
        or (p_stock = 'out_of_stock' and filtered.is_public_available = false))
  ),
  deduped as (
    select *
    from (
      select
        matched_filter.*,
        row_number() over (
          partition by matched_filter.public_dedupe_key
          order by
            case when matched_filter.is_public_available then 0 else 1 end asc,
            matched_filter.shared_access_rank asc,
            matched_filter.source_priority desc nulls last,
            matched_filter.confidence desc nulls last,
            matched_filter.public_updated_at desc nulls last,
            matched_filter.public_source_label asc,
            matched_filter.source_title asc,
            matched_filter.url asc,
            matched_filter.id asc
        ) as dedupe_rank
      from matched_filter
    ) ranked_dedupe
    where ranked_dedupe.dedupe_rank = 1
  ),
  matched as (
    select
      deduped.*,
      count(*) over() as total_count
    from deduped
  )
  select
    matched.id,
    matched.source_id,
    matched.source_name,
    matched.source_store_name,
    matched.source_title,
    matched.price,
    matched.currency,
    matched.status,
    matched.url,
    matched.tags,
    matched.stock_count,
    matched.min_order_quantity,
    matched.bulk_pricing_tiers,
    matched.hidden,
    matched.canonical_product_id,
    matched.category_slug,
    matched.captured_at,
    matched.source_updated_at,
    matched.last_seen_at,
    matched.verified_at,
    matched.expires_at,
    matched.source_priority,
    matched.confidence,
    matched.effective_status,
    matched.freshness_status,
    matched.last_failed_at,
    matched.failure_reason,
    matched.product_id,
    matched.product_slug,
    matched.product_display_name,
    matched.product_platform,
    matched.product_type,
    matched.product_spec,
    matched.product_summary,
    matched.product_updated_at,
    matched.total_count
  from matched
  order by
    case matched.product_platform
      when 'ChatGPT' then 1
      when 'Claude' then 2
      when 'Gemini' then 3
      when 'Grok' then 4
      when 'Google' then 5
      when 'API/CDK' then 6
      when '邮箱' then 7
      when '接码' then 8
      when '其他' then 99
      else 50
    end asc,
    case when p_sort = 'updated' then null else case when matched.is_public_available then 0 else 1 end end asc nulls last,
    case when p_sort = 'updated' then matched.public_updated_at end desc nulls last,
    case when p_sort = 'channels' then matched.public_source_label end asc nulls last,
    case when p_sort = 'updated' or p_sort = 'channels' then null else case when matched.is_public_available then matched.shared_access_rank else 0 end end asc nulls last,
    case when p_sort = 'price' or p_sort is null or p_sort = '' or p_sort = 'available_price' then matched.price end asc nulls last,
    matched.public_updated_at desc nulls last,
    matched.public_source_label asc,
    matched.source_title asc,
    matched.url asc,
    matched.id asc
  limit greatest(least(coalesce(p_limit, 80), 1200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function list_public_product_offer_filter_facets(
  p_product_id text
)
returns table (
  tag_id text,
  offer_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with product as (
    select id
    from canonical_products
    where is_active = true
      and (canonical_products.id = p_product_id or canonical_products.slug = p_product_id)
    limit 1
  ),
  tag_rows as (
    select distinct
      priceai_public_offer_dedupe_key(
        raw_offers.canonical_product_id,
        raw_offers.url,
        raw_offers.source_title,
        raw_offers.price
      ) as offer_key,
      unnest(raw_offers.public_filter_tags) as tag_id
    from raw_offers
    join product on product.id = raw_offers.canonical_product_id
    where raw_offers.hidden = false
      and coalesce(array_length(raw_offers.public_filter_tags, 1), 0) > 0
  )
  select
    tag_rows.tag_id,
    count(*) as offer_count
  from tag_rows
  where tag_rows.tag_id is not null
    and tag_rows.tag_id <> ''
  group by tag_rows.tag_id
  order by array_position(
    array[
      'shared_access',
      'web_only_account',
      'domestic_mirror_site',
      'delivery_recharge',
      'chatgpt_service_link',
      'chatgpt_service_scan',
      'chatgpt_service_self_recharge',
      'delivery_account',
      'account_verified',
      'account_unverified',
      'gemini_12_month_link',
      'gemini_12_month_card_binding',
      'gemini_18_month_link',
      'chatgpt_plus_brazil_pix',
      'chatgpt_plus_netherlands_ideal',
      'chatgpt_plus_india_upi',
      'chatgpt_plus_europe_channel',
      'chatgpt_plus_recharge_ph_card',
      'chatgpt_plus_recharge_us_ios',
      'chatgpt_plus_recharge_official_direct',
      'team_k12',
      'team_bug',
      'team_official',
      'duration_trial',
      'duration_month',
      'duration_quarter',
      'duration_half_year',
      'duration_year',
      'verification_single',
      'verification_short',
      'verification_long',
      'verification_monthly',
      'telegram_region_us',
      'telegram_region_india',
      'telegram_premium_quarter',
      'telegram_premium_half_year',
      'telegram_premium_year',
      'telegram_stars',
      'proxy_supported',
      'gemini_antigravity_gcp',
      'gemini_phone_required',
      'gemini_appeal_required',
      'warranty_long'
    ]::text[],
    tag_rows.tag_id
  ),
  tag_rows.tag_id;
$$;

drop function if exists get_public_product_summary(text);
drop function if exists list_public_product_summaries();

create or replace function list_public_product_summaries()
returns table (
  id text,
  slug text,
  display_name text,
  platform text,
  product_type text,
  spec text,
  summary text,
  aliases text[],
  updated_at timestamptz,
  offer_count bigint,
  in_stock_count bigint,
  out_of_stock_count bigint,
  lowest_price numeric,
  warranty_lowest_price numeric,
  warranty_offer_count bigint,
  latest_seen_at timestamptz,
  lowest_offer jsonb,
  warranty_lowest_offer jsonb,
  has_out_of_stock boolean,
  offer_search_text text
)
language sql
stable
security definer
set search_path = public
as $$
  with products as (
    select *
    from canonical_products
    where is_active = true
  ),
  offers as (
    select
      raw_offers.*,
      case
        when raw_offers.status <> 'out_of_stock'
          and raw_offers.price is not null
          and raw_offers.url <> ''
          and coalesce(raw_offers.effective_status, '') not in ('unavailable', 'stale', 'failed')
          and coalesce(raw_offers.freshness_status, '') not in ('expired', 'failed')
          and (raw_offers.expires_at is null or raw_offers.expires_at > now())
        then true
        else false
      end as is_public_available,
      coalesce(raw_offers.public_filter_tags, priceai_public_offer_filter_tags(raw_offers.source_title, raw_offers.tags)) as public_offer_filter_tags,
      coalesce(raw_offers.verified_at, raw_offers.last_seen_at, raw_offers.captured_at, raw_offers.source_updated_at) as public_updated_at,
      coalesce(raw_offers.source_store_name, raw_offers.source_name, '') as public_source_label
    from raw_offer_public_state raw_offers
    join products on products.id = raw_offers.canonical_product_id
    where raw_offers.hidden = false
  ),
  lowest_ranked as (
    select
      offers.*,
      row_number() over (
        partition by offers.canonical_product_id
        order by
          offers.price asc nulls last,
          offers.public_updated_at desc nulls last,
          offers.public_source_label asc,
          offers.source_title asc,
          offers.url asc,
          offers.id asc
      ) as lowest_rank
    from offers
    where offers.is_public_available = true
      and not (offers.public_offer_filter_tags @> array['shared_access']::text[])
      and not (offers.public_offer_filter_tags @> array['web_only_account']::text[])
      and not (offers.public_offer_filter_tags @> array['domestic_mirror_site']::text[])
  ),
  warranty_lowest_ranked as (
    select
      offers.*,
      row_number() over (
        partition by offers.canonical_product_id
        order by
          offers.price asc nulls last,
          offers.public_updated_at desc nulls last,
          offers.public_source_label asc,
          offers.source_title asc,
          offers.url asc,
          offers.id asc
      ) as warranty_lowest_rank
    from offers
    where offers.is_public_available = true
      and offers.public_offer_filter_tags @> array['warranty_long']::text[]
      and not (offers.public_offer_filter_tags @> array['shared_access']::text[])
      and not (offers.public_offer_filter_tags @> array['web_only_account']::text[])
      and not (offers.public_offer_filter_tags @> array['domestic_mirror_site']::text[])
  ),
  stats as (
    select
      offers.canonical_product_id,
      count(*) as offer_count,
      count(*) filter (where offers.is_public_available = true) as in_stock_count,
      count(*) filter (
        where offers.is_public_available = true
          and offers.public_offer_filter_tags @> array['warranty_long']::text[]
      ) as warranty_offer_count,
      count(*) filter (where offers.is_public_available = false) as out_of_stock_count,
      max(offers.public_updated_at) as latest_seen_at,
      bool_or(offers.is_public_available = false) as has_out_of_stock,
      left(
        string_agg(
          distinct concat_ws(' ', offers.source_title, offers.source_name, offers.source_store_name),
          ' '
        ),
        480
      ) as offer_search_text
    from offers
    group by offers.canonical_product_id
  )
  select
    products.id,
    products.slug,
    products.display_name,
    products.platform,
    products.product_type,
    products.spec,
    products.summary,
    products.aliases,
    products.updated_at,
    coalesce(stats.offer_count, 0) as offer_count,
    coalesce(stats.in_stock_count, 0) as in_stock_count,
    coalesce(stats.out_of_stock_count, 0) as out_of_stock_count,
    lowest.price as lowest_price,
    warranty_lowest.price as warranty_lowest_price,
    coalesce(stats.warranty_offer_count, 0) as warranty_offer_count,
    stats.latest_seen_at,
    case
      when lowest.id is null then null
      else jsonb_build_object(
        'id', lowest.id,
        'source_id', lowest.source_id,
        'source_name', lowest.source_name,
        'source_store_name', lowest.source_store_name,
        'source_title', lowest.source_title,
        'price', lowest.price,
        'currency', lowest.currency,
        'status', lowest.status,
        'url', lowest.url
      )
    end as lowest_offer,
    case
      when warranty_lowest.id is null then null
      else jsonb_build_object(
        'id', warranty_lowest.id,
        'source_id', warranty_lowest.source_id,
        'source_name', warranty_lowest.source_name,
        'source_store_name', warranty_lowest.source_store_name,
        'source_title', warranty_lowest.source_title,
        'price', warranty_lowest.price,
        'currency', warranty_lowest.currency,
        'status', warranty_lowest.status,
        'url', warranty_lowest.url
      )
    end as warranty_lowest_offer,
    coalesce(stats.has_out_of_stock, false) as has_out_of_stock,
    coalesce(stats.offer_search_text, '') as offer_search_text
  from products
  left join stats on stats.canonical_product_id = products.id
  left join lowest_ranked lowest
    on lowest.canonical_product_id = products.id
    and lowest.lowest_rank = 1
  left join warranty_lowest_ranked warranty_lowest
    on warranty_lowest.canonical_product_id = products.id
    and warranty_lowest.warranty_lowest_rank = 1
  order by products.platform, products.display_name, products.id;
$$;

create or replace function get_public_product_summary(p_product_key text)
returns table (
  id text,
  slug text,
  display_name text,
  platform text,
  product_type text,
  spec text,
  summary text,
  aliases text[],
  updated_at timestamptz,
  offer_count bigint,
  in_stock_count bigint,
  out_of_stock_count bigint,
  lowest_price numeric,
  warranty_lowest_price numeric,
  warranty_offer_count bigint,
  latest_seen_at timestamptz,
  lowest_offer jsonb,
  warranty_lowest_offer jsonb,
  has_out_of_stock boolean,
  offer_search_text text
)
language sql
stable
security definer
set search_path = public
as $$
  select *
  from list_public_product_summaries()
  where list_public_product_summaries.id = p_product_key
    or list_public_product_summaries.slug = p_product_key
  limit 1;
$$;

revoke execute on function priceai_public_offer_filter_tags(text, text[]) from anon, public;
revoke execute on function list_public_product_offers_page_v2(text, text[], text, text, text, numeric, numeric, integer, integer, integer, integer) from anon, authenticated, public;
revoke execute on function list_public_product_offer_filter_facets(text) from anon, authenticated, public;
revoke execute on function list_public_offers_page(
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  integer,
  integer
) from anon, authenticated, public;
revoke execute on function list_public_product_summaries() from anon, public;
revoke execute on function get_public_product_summary(text) from anon, public;

grant execute on function priceai_public_offer_filter_tags(text, text[]) to service_role;
grant execute on function list_public_product_offers_page_v2(text, text[], text, text, text, numeric, numeric, integer, integer, integer, integer) to service_role;
grant execute on function list_public_product_offer_filter_facets(text) to service_role;
grant execute on function list_public_offers_page(
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  integer,
  integer
) to service_role;
grant execute on function list_public_product_summaries() to service_role;
grant execute on function get_public_product_summary(text) to service_role;

create or replace function claim_collection_job(
  p_worker text,
  p_lock_seconds integer default 1800
)
returns setof collection_jobs
language plpgsql
security definer
as $$
declare
  v_job_id text;
  v_now timestamptz := now();
  v_lock_until timestamptz := now() + make_interval(secs => greatest(60, least(coalesce(p_lock_seconds, 1800), 7200)));
begin
  select id into v_job_id
  from collection_jobs
  where
    status = 'pending'
    or (
      status = 'running'
      and locked_until is not null
      and locked_until < v_now
      and attempts < max_attempts
    )
  order by priority desc, created_at asc
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  update collection_jobs
  set
    status = 'running',
    locked_by = p_worker,
    locked_until = v_lock_until,
    started_at = coalesce(started_at, v_now),
    finished_at = null,
    attempts = attempts + 1,
    updated_at = v_now
  where id = v_job_id;

  return query
  select *
  from collection_jobs
  where id = v_job_id;
end;
$$;

create or replace function claim_collection_job_by_id(
  p_job_id text,
  p_worker text,
  p_lock_seconds integer default 1800
)
returns setof collection_jobs
language plpgsql
security definer
as $$
declare
  v_job_id text;
  v_now timestamptz := now();
  v_lock_until timestamptz := now() + make_interval(secs => greatest(60, least(coalesce(p_lock_seconds, 1800), 7200)));
begin
  select id into v_job_id
  from collection_jobs
  where id = p_job_id
    and (
      status = 'pending'
      or (
        status = 'running'
        and locked_until is not null
        and locked_until < v_now
        and attempts < max_attempts
      )
    )
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  update collection_jobs
  set
    status = 'running',
    locked_by = p_worker,
    locked_until = v_lock_until,
    started_at = coalesce(started_at, v_now),
    finished_at = null,
    attempts = attempts + 1,
    updated_at = v_now
  where id = v_job_id;

  return query
  select *
  from collection_jobs
  where id = v_job_id;
end;
$$;

alter function claim_collection_job_by_id(text, text, integer) set search_path = public;

revoke execute on function claim_collection_job_by_id(text, text, integer) from anon, authenticated, public;
grant execute on function claim_collection_job_by_id(text, text, integer) to service_role;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists canonical_products_set_updated_at on canonical_products;
create trigger canonical_products_set_updated_at
before update on canonical_products
for each row execute function set_updated_at();

drop trigger if exists sources_set_updated_at on sources;
create trigger sources_set_updated_at
before update on sources
for each row execute function set_updated_at();

drop trigger if exists raw_offers_set_updated_at on raw_offers;
create trigger raw_offers_set_updated_at
before update on raw_offers
for each row execute function set_updated_at();

drop trigger if exists raw_offer_confirmations_set_updated_at on raw_offer_confirmations;
create trigger raw_offer_confirmations_set_updated_at
before update on raw_offer_confirmations
for each row execute function set_updated_at();

drop trigger if exists raw_offer_missing_candidates_set_updated_at on raw_offer_missing_candidates;
create trigger raw_offer_missing_candidates_set_updated_at
before update on raw_offer_missing_candidates
for each row execute function set_updated_at();

drop trigger if exists crawl_log_ingest_runs_set_updated_at on crawl_log_ingest_runs;
create trigger crawl_log_ingest_runs_set_updated_at
before update on crawl_log_ingest_runs
for each row execute function set_updated_at();

drop trigger if exists collection_jobs_set_updated_at on collection_jobs;
create trigger collection_jobs_set_updated_at
before update on collection_jobs
for each row execute function set_updated_at();

drop trigger if exists source_shard_assignments_set_updated_at on source_shard_assignments;
create trigger source_shard_assignments_set_updated_at
before update on source_shard_assignments
for each row execute function set_updated_at();

drop trigger if exists shop_api_fee_policies_set_updated_at on shop_api_fee_policies;
create trigger shop_api_fee_policies_set_updated_at
before update on shop_api_fee_policies
for each row execute function set_updated_at();

drop trigger if exists collector_heartbeats_set_updated_at on collector_heartbeats;
create trigger collector_heartbeats_set_updated_at
before update on collector_heartbeats
for each row execute function set_updated_at();

-- Default-deny RLS. The Next.js app talks to Supabase via the service role key
-- (server-only), which bypasses RLS. The anon key cannot read or write.
alter table canonical_products enable row level security;
alter table sources enable row level security;
alter table raw_offers enable row level security;
alter table raw_offer_confirmations enable row level security;
alter table raw_offer_missing_candidates enable row level security;
alter table offer_matches enable row level security;
alter table crawl_runs enable row level security;
alter table crawl_log_ingest_runs enable row level security;
alter table collection_jobs enable row level security;
alter table source_shard_assignments enable row level security;
alter table shop_api_fee_policies enable row level security;
alter table collector_heartbeats enable row level security;

create table if not exists channel_submissions (
  id text primary key,
  url text not null,
  normalized_url text,
  canonical_channel_key text,
  name text,
  contact text,
  notes text,
  parsed_title text,
  parsed_meta jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  review_stage text not null default 'submitted',
  duplicate_of_submission_id text references channel_submissions(id) on delete set null,
  preclassification_kind text,
  preclassification jsonb not null default '{}'::jsonb,
  classification_version text,
  classified_at timestamptz,
  reviewer_note text,
  approved_source_id text references sources(id) on delete set null,
  submitter_ip text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists channel_submissions_status_idx on channel_submissions(status);
create index if not exists channel_submissions_created_at_idx on channel_submissions(created_at desc);
create index if not exists channel_submissions_url_idx on channel_submissions(url);
create index if not exists channel_submissions_canonical_key_idx on channel_submissions(canonical_channel_key, status, created_at desc);
create index if not exists channel_submissions_review_stage_idx on channel_submissions(status, review_stage, created_at desc);
create index if not exists channel_submissions_duplicate_of_idx on channel_submissions(duplicate_of_submission_id);
create unique index if not exists channel_submissions_pending_root_key_uidx
  on channel_submissions(canonical_channel_key)
  where status = 'pending' and duplicate_of_submission_id is null and canonical_channel_key is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'channel_submissions_duplicate_not_self'
  ) then
    alter table channel_submissions
      add constraint channel_submissions_duplicate_not_self
      check (duplicate_of_submission_id is null or duplicate_of_submission_id <> id);
  end if;
end;
$$;

alter table channel_submissions enable row level security;

create table if not exists public_user_profiles (
  id uuid primary key,
  email text,
  display_name text,
  avatar_url text,
  provider text not null default 'google',
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public_user_profiles enable row level security;

drop policy if exists public_user_profiles_select_own on public_user_profiles;
create policy public_user_profiles_select_own on public_user_profiles for select to authenticated using (auth.uid() = id);

drop trigger if exists public_user_profiles_set_updated_at on public_user_profiles;
create trigger public_user_profiles_set_updated_at
before update on public_user_profiles
for each row execute function set_updated_at();

create table if not exists offer_feedback (
  id text primary key,
  feedback_scope text not null default 'offer',
  product_id text,
  product_slug text,
  product_name text,
  offer_id text references raw_offers(id) on delete set null,
  source_id text references sources(id) on delete set null,
  source_name text,
  source_title text,
  offer_url text,
  offer_price numeric,
  offer_currency text,
  offer_status text,
  offer_captured_at timestamptz,
  offer_source_updated_at timestamptz,
  offer_last_seen_at timestamptz,
  reason text not null,
  issue_dimension text,
  expected_product_id text,
  classification_version text,
  classification_result jsonb,
  user_expected_action text not null default 'recheck',
  suggested_action text not null default 'recollect',
  evidence_text text,
  evidence_urls jsonb not null default '[]'::jsonb,
  ai_review_result jsonb,
  notes text,
  contact text,
  status text not null default 'pending',
  public_status text not null default 'not_public',
  withdrawn_at timestamptz,
  withdraw_reason text,
  reviewer_note text,
  submitter_ip text,
  user_id uuid,
  user_email text,
  user_display_name text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table offer_feedback
  add column if not exists issue_dimension text,
  add column if not exists expected_product_id text,
  add column if not exists classification_version text,
  add column if not exists classification_result jsonb,
  add column if not exists verification_status text not null default 'not_needed',
  add column if not exists verification_result text,
  add column if not exists verification_message text,
  add column if not exists verification_checked_at timestamptz,
  add column if not exists created_collection_job_id text references collection_jobs(id) on delete set null,
  add column if not exists feedback_scope text not null default 'offer',
  add column if not exists public_status text not null default 'not_public',
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdraw_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'offer_feedback_issue_dimension_check'
  ) then
    alter table offer_feedback
      add constraint offer_feedback_issue_dimension_check
      check (
        issue_dimension is null or
        issue_dimension in ('product_category', 'filter_tag', 'source_placement', 'unsure')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'offer_feedback_scope_check'
  ) then
    alter table offer_feedback
      add constraint offer_feedback_scope_check
      check (feedback_scope in ('offer', 'merchant'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'offer_feedback_public_status_check'
  ) then
    alter table offer_feedback
      add constraint offer_feedback_public_status_check
      check (public_status in ('not_public', 'pending_review', 'public', 'withdrawn'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'offer_feedback_verification_status_check'
  ) then
    alter table offer_feedback
      add constraint offer_feedback_verification_status_check
      check (
        verification_status in (
          'not_needed',
          'pending',
          'running',
          'auto_fixed',
          'recollection_created',
          'manual_review',
          'failed'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'offer_feedback_verification_result_check'
  ) then
    alter table offer_feedback
      add constraint offer_feedback_verification_result_check
      check (
        verification_result is null
        or verification_result in (
          'offer_changed',
          'item_removed',
          'out_of_stock',
          'still_available',
          'recollection_created',
          'inconclusive',
          'blocked'
        )
      );
  end if;
end $$;

create index if not exists offer_feedback_status_idx on offer_feedback(status);
create index if not exists offer_feedback_created_at_idx on offer_feedback(created_at desc);
create index if not exists offer_feedback_offer_id_idx on offer_feedback(offer_id);
create index if not exists offer_feedback_source_id_idx on offer_feedback(source_id);
create index if not exists offer_feedback_suggested_action_idx on offer_feedback(suggested_action);
create index if not exists offer_feedback_pending_category_idx
  on offer_feedback(offer_id, created_at desc)
  where reason = 'wrong_category' and status = 'pending';
create index if not exists offer_feedback_verification_status_idx
  on offer_feedback(verification_status, created_at desc);
create index if not exists offer_feedback_created_collection_job_id_idx
  on offer_feedback(created_collection_job_id);
create index if not exists offer_feedback_user_id_created_at_idx on offer_feedback(user_id, created_at desc);
create index if not exists offer_feedback_scope_created_at_idx
  on offer_feedback(feedback_scope, created_at desc);
create index if not exists offer_feedback_public_status_idx
  on offer_feedback(public_status, created_at desc);
create index if not exists offer_feedback_user_public_status_idx
  on offer_feedback(user_id, public_status, created_at desc);

alter table offer_feedback enable row level security;

drop policy if exists offer_feedback_select_own on offer_feedback;
create policy offer_feedback_select_own on offer_feedback for select to authenticated using (auth.uid() = user_id);

create table if not exists feedback_followups (
  id text primary key,
  feedback_id text not null references offer_feedback(id) on delete cascade,
  user_id uuid,
  role text not null default 'user' check (role in ('user', 'admin')),
  message text not null,
  evidence_urls jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists feedback_followups_feedback_created_at_idx on feedback_followups(feedback_id, created_at asc);

alter table feedback_followups enable row level security;

drop policy if exists feedback_followups_select_own on feedback_followups;
create policy feedback_followups_select_own on feedback_followups for select to authenticated using (auth.uid() = user_id);

create table if not exists feedback_evidence_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  draft_id uuid not null,
  feedback_id text references offer_feedback(id) on delete set null,
  object_key text not null unique,
  reference text not null unique,
  status text not null default 'draft' check (status in ('draft', 'bound', 'deleted')),
  original_name text,
  mime_type text,
  size_bytes integer,
  expires_at timestamptz default (now() + interval '24 hours'),
  bound_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedback_evidence_objects_expiry_idx on feedback_evidence_objects(status, expires_at) where status = 'draft';
create index if not exists feedback_evidence_objects_user_created_idx on feedback_evidence_objects(user_id, created_at desc);

alter table feedback_evidence_objects enable row level security;
drop policy if exists feedback_evidence_objects_select_own on feedback_evidence_objects;
create policy feedback_evidence_objects_select_own on feedback_evidence_objects for select to authenticated using (auth.uid() = user_id);

drop trigger if exists feedback_evidence_objects_set_updated_at on feedback_evidence_objects;
create trigger feedback_evidence_objects_set_updated_at
before update on feedback_evidence_objects
for each row execute function set_updated_at();

create or replace function reap_expired_collection_jobs(
  p_worker text default 'collector-agent',
  p_limit integer default 50
)
returns setof collection_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 500));
begin
  return query
  with expired as (
    select id
    from collection_jobs
    where status = 'running'
      and locked_until is not null
      and locked_until < v_now
      and attempts >= max_attempts
    order by locked_until asc, created_at asc
    for update skip locked
    limit v_limit
  ),
  reaped as (
    update collection_jobs jobs
    set
      status = 'failed',
      finished_at = v_now,
      locked_by = null,
      locked_until = null,
      last_error = coalesce(
        jobs.last_error,
        '采集任务锁已过期，且重试次数已用尽；系统已自动收敛为失败。'
      ),
      result = coalesce(jobs.result, '{}'::jsonb) || jsonb_build_object(
        'reapedBy', coalesce(nullif(p_worker, ''), 'collector-agent'),
        'reapedAt', v_now,
        'reapReason', 'expired_lock_max_attempts'
      ),
      updated_at = v_now
    from expired
    where jobs.id = expired.id
    returning jobs.*
  ),
  feedback_updated as (
    update offer_feedback feedback
    set
      verification_status = 'failed',
      verification_result = 'blocked',
      verification_message = '自动重采任务锁已过期且重试次数已用尽；请人工复核或重新触发重采。',
      verification_checked_at = v_now,
      ai_review_result = coalesce(feedback.ai_review_result, '{}'::jsonb) || jsonb_build_object(
        'verificationStatus', 'failed',
        'verificationResult', 'blocked',
        'verificationMessage', '自动重采任务锁已过期且重试次数已用尽；请人工复核或重新触发重采。',
        'verifiedAt', v_now,
        'completedCollectionJobId', feedback.created_collection_job_id,
        'reapReason', 'expired_lock_max_attempts'
      )
    from reaped
    where feedback.created_collection_job_id = reaped.id
      and reaped.requested_by = 'feedback'
      and feedback.verification_status in ('pending', 'running', 'recollection_created')
    returning feedback.id
  )
  select * from reaped;
end;
$$;

revoke execute on function reap_expired_collection_jobs(text, integer) from anon, authenticated, public;
grant execute on function reap_expired_collection_jobs(text, integer) to service_role;

create or replace function list_public_merchant_summaries()
returns table (
  id text,
  source_id text,
  name text,
  store_name text,
  source_name text,
  entry_url text,
  shop_url text,
  host text,
  collector_kind text,
  health_status text,
  last_success_at timestamptz,
  consecutive_failures integer,
  product_count bigint,
  offer_count bigint,
  in_stock_count bigint,
  out_of_stock_count bigint,
  platform_count bigint,
  platforms text[],
  product_types text[],
  lowest_hit_count bigint,
  warranty_lowest_hit_count bigint,
  risk_feedback_count bigint,
  latest_seen_at timestamptz,
  observation_started_at timestamptz,
  included_at timestamptz,
  shop_created_at timestamptz,
  representative_product text,
  representative_offer_title text,
  representative_price numeric,
  representative_currency text,
  has_platform_aftersales_mechanism boolean,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with products as (
    select *
    from canonical_products
    where is_active = true
  ),
  offers as (
    select
      raw_offers.*,
      products.display_name as product_display_name,
      products.platform as product_platform,
      products.product_type as product_type,
      coalesce(sources.name, raw_offers.source_name, raw_offers.source_store_name, '') as resolved_source_name,
      sources.entry_url,
      sources.base_url,
      sources.collector_kind,
      sources.health_status,
      sources.last_success_at,
      sources.consecutive_failures,
      sources.created_at as source_created_at,
      sources.shop_created_at,
      case
        when raw_offers.status <> 'out_of_stock'
          and raw_offers.price is not null
          and raw_offers.url <> ''
          and coalesce(raw_offers.effective_status, '') not in ('unavailable', 'stale', 'failed')
          and coalesce(raw_offers.freshness_status, '') not in ('expired', 'failed')
          and (raw_offers.expires_at is null or raw_offers.expires_at > now())
        then true
        else false
      end as is_public_available,
      coalesce(raw_offers.public_filter_tags, priceai_public_offer_filter_tags(raw_offers.source_title, raw_offers.tags)) as public_offer_filter_tags,
      coalesce(raw_offers.verified_at, raw_offers.last_seen_at, raw_offers.captured_at, raw_offers.source_updated_at) as public_updated_at,
      coalesce(raw_offers.source_store_name, raw_offers.source_name, sources.name, '') as public_source_label,
      priceai_public_offer_dedupe_key(
        raw_offers.canonical_product_id,
        raw_offers.url,
        raw_offers.source_title,
        raw_offers.price
      ) as public_dedupe_key
    from raw_offer_public_state raw_offers
    join products on products.id = raw_offers.canonical_product_id
    left join sources on sources.id = raw_offers.source_id
    where raw_offers.hidden = false
  ),
  deduped as (
    select *
    from (
      select
        offers.*,
        row_number() over (
          partition by offers.public_dedupe_key
          order by
            case when offers.is_public_available then 0 else 1 end asc,
            offers.source_priority desc nulls last,
            offers.confidence desc nulls last,
            offers.public_updated_at desc nulls last,
            offers.public_source_label asc,
            offers.source_title asc,
            offers.url asc,
            offers.id asc
        ) as dedupe_rank
      from offers
    ) ranked
    where ranked.dedupe_rank = 1
  ),
  lowest_ranked as (
    select
      deduped.*,
      row_number() over (
        partition by deduped.canonical_product_id
        order by
          deduped.price asc nulls last,
          deduped.public_updated_at desc nulls last,
          deduped.public_source_label asc,
          deduped.source_title asc,
          deduped.url asc,
          deduped.id asc
      ) as lowest_rank
    from deduped
    where deduped.is_public_available = true
      and not (deduped.public_offer_filter_tags @> array['shared_access']::text[])
      and not (deduped.public_offer_filter_tags @> array['web_only_account']::text[])
      and not (deduped.public_offer_filter_tags @> array['domestic_mirror_site']::text[])
  ),
  warranty_lowest_ranked as (
    select
      deduped.*,
      row_number() over (
        partition by deduped.canonical_product_id
        order by
          deduped.price asc nulls last,
          deduped.public_updated_at desc nulls last,
          deduped.public_source_label asc,
          deduped.source_title asc,
          deduped.url asc,
          deduped.id asc
      ) as warranty_lowest_rank
    from deduped
    where deduped.is_public_available = true
      and deduped.public_offer_filter_tags @> array['warranty_long']::text[]
      and not (deduped.public_offer_filter_tags @> array['shared_access']::text[])
      and not (deduped.public_offer_filter_tags @> array['web_only_account']::text[])
      and not (deduped.public_offer_filter_tags @> array['domestic_mirror_site']::text[])
  ),
  feedback as (
    select
      source_id,
      count(*) as risk_feedback_count
    from offer_feedback
    where status <> 'ignored'
      and source_id is not null
      and ai_review_result -> 'riskPrecheck' is not null
      and ai_review_result -> 'riskPrecheck' ->> 'status' = 'ready'
      and ai_review_result -> 'riskPrecheck' ->> 'canShowPublicly' = 'true'
      and coalesce(ai_review_result -> 'riskPrecheck' ->> 'publicHidden', 'false') <> 'true'
      and ai_review_result -> 'riskPrecheck' ->> 'sourceCanShowPublicly' = 'true'
    group by source_id
  ),
  merchant_rows as (
    select
      coalesce(deduped.source_id, 'fallback:' || md5(coalesce(deduped.public_source_label, '') || '|' || coalesce(deduped.collector_kind, '') || '|' || coalesce(deduped.url, ''))) as merchant_key,
      min(deduped.source_id) as source_id,
      coalesce(max(deduped.public_source_label), max(deduped.resolved_source_name), '未记录商家') as name,
      max(deduped.source_store_name) as store_name,
      coalesce(max(deduped.source_name), max(deduped.resolved_source_name), max(deduped.public_source_label), '未记录渠道') as source_name,
      max(deduped.entry_url) as entry_url,
      coalesce(
        max(deduped.entry_url) filter (where deduped.entry_url ~ '/shop/'),
        max(deduped.entry_url) filter (where deduped.entry_url !~ '/item/'),
        'https://pay.ldxp.cn/shop/' || nullif(substring(
          coalesce(
            min(deduped.source_id) filter (where deduped.source_id ~* '^ldxp-[^/]+$' and deduped.source_id <> 'ldxp-cn'),
            max(deduped.source_name) filter (where deduped.source_name ~* 'LDXP\s*/\s*[^/\s]+')
          )
          from '(?:^ldxp-|LDXP\s*/\s*)([^/\s]+)'
        ), ''),
        max(deduped.base_url)
      ) as shop_url,
      lower(regexp_replace((regexp_match(coalesce(max(deduped.entry_url), max(deduped.base_url), ''), '^https?://(?:www\.)?([^/?#]+)'))[1], '^www\.', '')) as host,
      max(deduped.collector_kind) as collector_kind,
      max(deduped.health_status) as health_status,
      max(deduped.last_success_at) as last_success_at,
      max(deduped.consecutive_failures) as consecutive_failures,
      count(distinct deduped.canonical_product_id) as product_count,
      count(*) as offer_count,
      count(*) filter (where deduped.is_public_available = true) as in_stock_count,
      count(*) filter (where deduped.is_public_available = false) as out_of_stock_count,
      count(distinct deduped.product_platform) as platform_count,
      array_agg(distinct deduped.product_platform order by deduped.product_platform) as platforms,
      array_agg(distinct deduped.product_type order by deduped.product_type) as product_types,
      count(*) filter (where lowest_ranked.lowest_rank = 1) as lowest_hit_count,
      count(*) filter (where warranty_lowest_ranked.warranty_lowest_rank = 1) as warranty_lowest_hit_count,
      max(coalesce(feedback.risk_feedback_count, 0)) as risk_feedback_count,
      max(deduped.public_updated_at) as latest_seen_at,
      min(coalesce(deduped.public_updated_at, deduped.captured_at)) as observation_started_at,
      min(deduped.source_created_at) as included_at,
      min(deduped.shop_created_at) as shop_created_at,
      (array_agg(deduped.product_display_name order by deduped.is_public_available desc, deduped.price asc nulls last, deduped.public_updated_at desc nulls last))[1] as representative_product,
      (array_agg(deduped.source_title order by deduped.is_public_available desc, deduped.price asc nulls last, deduped.public_updated_at desc nulls last))[1] as representative_offer_title,
      (array_agg(deduped.price order by deduped.is_public_available desc, deduped.price asc nulls last, deduped.public_updated_at desc nulls last))[1] as representative_price,
      (array_agg(deduped.currency order by deduped.is_public_available desc, deduped.price asc nulls last, deduped.public_updated_at desc nulls last))[1] as representative_currency,
      bool_or(deduped.collector_kind = 'shopApi') as has_platform_aftersales_mechanism
    from deduped
    left join lowest_ranked
      on lowest_ranked.id = deduped.id
      and lowest_ranked.lowest_rank = 1
    left join warranty_lowest_ranked
      on warranty_lowest_ranked.id = deduped.id
      and warranty_lowest_ranked.warranty_lowest_rank = 1
    left join feedback on feedback.source_id = deduped.source_id
    group by coalesce(deduped.source_id, 'fallback:' || md5(coalesce(deduped.public_source_label, '') || '|' || coalesce(deduped.collector_kind, '') || '|' || coalesce(deduped.url, '')))
  )
  select
    'merchant-' || md5(merchant_rows.merchant_key) as id,
    merchant_rows.source_id,
    merchant_rows.name,
    merchant_rows.store_name,
    merchant_rows.source_name,
    merchant_rows.entry_url,
    merchant_rows.shop_url,
    merchant_rows.host,
    merchant_rows.collector_kind,
    merchant_rows.health_status,
    merchant_rows.last_success_at,
    merchant_rows.consecutive_failures,
    merchant_rows.product_count,
    merchant_rows.offer_count,
    merchant_rows.in_stock_count,
    merchant_rows.out_of_stock_count,
    merchant_rows.platform_count,
    merchant_rows.platforms,
    merchant_rows.product_types,
    merchant_rows.lowest_hit_count,
    merchant_rows.warranty_lowest_hit_count,
    merchant_rows.risk_feedback_count,
    merchant_rows.latest_seen_at,
    merchant_rows.observation_started_at,
    merchant_rows.included_at,
    merchant_rows.shop_created_at,
    merchant_rows.representative_product,
    merchant_rows.representative_offer_title,
    merchant_rows.representative_price,
    merchant_rows.representative_currency,
    merchant_rows.has_platform_aftersales_mechanism,
    count(*) over() as total_count
  from merchant_rows
  order by
    merchant_rows.in_stock_count desc,
    merchant_rows.warranty_lowest_hit_count desc,
    merchant_rows.lowest_hit_count desc,
    merchant_rows.has_platform_aftersales_mechanism desc,
    merchant_rows.latest_seen_at desc nulls last,
    merchant_rows.product_count desc,
    merchant_rows.risk_feedback_count asc,
    merchant_rows.name asc;
$$;

revoke execute on function list_public_merchant_summaries() from anon, public;
grant execute on function list_public_merchant_summaries() to service_role;

create or replace function build_source_quality_price_benchmark_rows()
returns table (
  source_id text,
  competitive_scope_count bigint,
  priced_offer_count bigint,
  benchmark_offer_count bigint,
  lowest_hit_count bigint,
  top5_hit_count bigint,
  within_10pct_count bigint,
  within_20pct_count bigint,
  high_gap_count bigint,
  high_gap_share numeric,
  median_gap_to_min numeric,
  median_gap_to_top5 numeric,
  avg_gap_to_min numeric,
  sample_scopes jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with scope_definitions(scope_key, scope_label, tag_id, exclude_shared_mirror) as (
    values
      ('default', '默认最低', null::text, true),
      ('warranty_long', '质保最低', 'warranty_long', true),
      ('shared_access', '拼车/团购', 'shared_access', false),
      ('web_only_account', '网页号', 'web_only_account', false),
      ('domestic_mirror_site', '国内镜像站', 'domestic_mirror_site', false),
      ('delivery_recharge', '充值', 'delivery_recharge', false),
      ('chatgpt_service_link', '提链', 'chatgpt_service_link', false),
      ('chatgpt_service_scan', '扫码', 'chatgpt_service_scan', false),
      ('chatgpt_service_self_recharge', '自助充值', 'chatgpt_service_self_recharge', false),
      ('delivery_account', '成品号', 'delivery_account', false),
      ('account_verified', '已接码成品号', 'account_verified', false),
      ('account_unverified', '未接码成品号', 'account_unverified', false),
      ('gemini_12_month_link', '12个月提链', 'gemini_12_month_link', false),
      ('gemini_12_month_card_binding', '12个月含绑卡', 'gemini_12_month_card_binding', false),
      ('gemini_18_month_link', '18个月链接', 'gemini_18_month_link', false),
      ('chatgpt_plus_brazil_pix', '巴西 Pix', 'chatgpt_plus_brazil_pix', false),
      ('chatgpt_plus_netherlands_ideal', '荷兰 iDEAL', 'chatgpt_plus_netherlands_ideal', false),
      ('chatgpt_plus_india_upi', '印度 UPI', 'chatgpt_plus_india_upi', false),
      ('chatgpt_plus_europe_channel', '欧洲渠道', 'chatgpt_plus_europe_channel', false),
      ('chatgpt_plus_recharge_ph_card', '菲区卡充', 'chatgpt_plus_recharge_ph_card', false),
      ('chatgpt_plus_recharge_us_ios', '美区 iOS', 'chatgpt_plus_recharge_us_ios', false),
      ('chatgpt_plus_recharge_official_direct', '官方直充', 'chatgpt_plus_recharge_official_direct', false),
      ('pro_max_official_recharge', '正价代充', 'pro_max_official_recharge', false),
      ('pro_max_short_term', '速刷/短期', 'pro_max_short_term', false),
      ('pro_max_us_ios', 'iOS/美区', 'pro_max_us_ios', false),
      ('team_k12', 'K12', 'team_k12', false),
      ('team_bug', 'Bug Team', 'team_bug', false),
      ('team_official', '正价/官方 Team', 'team_official', false),
      ('duration_trial', '短体验', 'duration_trial', false),
      ('duration_month', '月卡', 'duration_month', false),
      ('duration_quarter', '3个月', 'duration_quarter', false),
      ('duration_half_year', '6个月', 'duration_half_year', false),
      ('duration_year', '年卡', 'duration_year', false),
      ('verification_single', '单次', 'verification_single', false),
      ('verification_short', '短效', 'verification_short', false),
      ('verification_long', '长效链接', 'verification_long', false),
      ('verification_monthly', '月租/包月', 'verification_monthly', false),
      ('telegram_region_us', '美区 +1', 'telegram_region_us', false),
      ('telegram_region_india', '印度 +91', 'telegram_region_india', false),
      ('telegram_premium_quarter', 'Premium 3个月', 'telegram_premium_quarter', false),
      ('telegram_premium_half_year', 'Premium 6个月', 'telegram_premium_half_year', false),
      ('telegram_premium_year', 'Premium 年费', 'telegram_premium_year', false),
      ('telegram_stars', 'Telegram Stars', 'telegram_stars', false),
      ('proxy_supported', '可反代', 'proxy_supported', false),
      ('gemini_antigravity_gcp', 'Antigravity/GCP', 'gemini_antigravity_gcp', false),
      ('gemini_phone_required', '需手机验证', 'gemini_phone_required', false),
      ('gemini_appeal_required', '需申诉', 'gemini_appeal_required', false)
  ),
  products as (
    select id, display_name
    from canonical_products
    where is_active = true
  ),
  base_offers as (
    select
      raw_offers.id,
      raw_offers.source_id,
      raw_offers.source_name,
      raw_offers.source_store_name,
      raw_offers.source_title,
      raw_offers.price,
      raw_offers.currency,
      raw_offers.url,
      raw_offers.canonical_product_id as product_id,
      products.display_name as product_name,
      coalesce(raw_offers.public_filter_tags, priceai_public_offer_filter_tags(raw_offers.source_title, raw_offers.tags), '{}'::text[]) as public_offer_filter_tags,
      coalesce(raw_offers.verified_at, raw_offers.last_seen_at, raw_offers.captured_at, raw_offers.source_updated_at) as public_updated_at,
      coalesce(raw_offers.source_store_name, raw_offers.source_name, '') as public_source_label,
      raw_offers.source_priority,
      raw_offers.confidence,
      priceai_public_offer_dedupe_key(
        raw_offers.canonical_product_id,
        raw_offers.url,
        raw_offers.source_title,
        raw_offers.price
      ) as public_dedupe_key
    from raw_offer_public_state raw_offers
    join products on products.id = raw_offers.canonical_product_id
    where raw_offers.hidden = false
      and raw_offers.source_id is not null
      and raw_offers.status <> 'out_of_stock'
      and raw_offers.price is not null
      and raw_offers.price >= 0
      and coalesce(raw_offers.url, '') <> ''
      and coalesce(raw_offers.effective_status, '') not in ('unavailable', 'stale', 'failed')
      and coalesce(raw_offers.freshness_status, '') not in ('expired', 'failed')
      and (raw_offers.expires_at is null or raw_offers.expires_at > now())
  ),
  deduped as (
    select *
    from (
      select
        base_offers.*,
        row_number() over (
          partition by base_offers.public_dedupe_key
          order by
            base_offers.source_priority desc nulls last,
            base_offers.confidence desc nulls last,
            base_offers.public_updated_at desc nulls last,
            base_offers.public_source_label asc,
            base_offers.source_title asc,
            base_offers.url asc,
            base_offers.id asc
        ) as dedupe_rank
      from base_offers
    ) ranked_dedupe
    where ranked_dedupe.dedupe_rank = 1
  ),
  scope_offers as (
    select
      deduped.*,
      matched_scope.scope_key,
      matched_scope.scope_label
    from deduped
    join lateral (
      select
        scope_definitions.scope_key,
        scope_definitions.scope_label
      from scope_definitions
      where scope_definitions.scope_key = 'default'
        and not (deduped.public_offer_filter_tags @> array['shared_access']::text[])
        and not (deduped.public_offer_filter_tags @> array['web_only_account']::text[])
        and not (deduped.public_offer_filter_tags @> array['domestic_mirror_site']::text[])
      union all
      select
        scope_definitions.scope_key,
        scope_definitions.scope_label
      from scope_definitions
      where scope_definitions.tag_id is not null
        and scope_definitions.tag_id = any(deduped.public_offer_filter_tags)
        and (
          scope_definitions.exclude_shared_mirror = false
          or (
            not (deduped.public_offer_filter_tags @> array['shared_access']::text[])
            and not (deduped.public_offer_filter_tags @> array['web_only_account']::text[])
            and not (deduped.public_offer_filter_tags @> array['domestic_mirror_site']::text[])
          )
        )
    ) matched_scope on true
  ),
  scope_stats as (
    select
      scope_offers.product_id,
      scope_offers.product_name,
      scope_offers.scope_key,
      scope_offers.scope_label,
      count(*) as scope_offer_count,
      count(distinct scope_offers.source_id) as scope_source_count,
      min(scope_offers.price) as min_price
    from scope_offers
    group by
      scope_offers.product_id,
      scope_offers.product_name,
      scope_offers.scope_key,
      scope_offers.scope_label
    having count(*) >= 3
      and count(distinct scope_offers.source_id) >= 2
  ),
  ranked_scope_offers as (
    select
      scope_offers.*,
      scope_stats.scope_offer_count,
      scope_stats.scope_source_count,
      scope_stats.min_price,
      row_number() over (
        partition by scope_offers.product_id, scope_offers.scope_key
        order by
          scope_offers.price asc,
          scope_offers.public_updated_at desc nulls last,
          scope_offers.public_source_label asc,
          scope_offers.source_title asc,
          scope_offers.url asc,
          scope_offers.id asc
      ) as price_rank
    from scope_offers
    join scope_stats
      on scope_stats.product_id = scope_offers.product_id
      and scope_stats.scope_key = scope_offers.scope_key
  ),
  top5_stats as (
    select
      ranked_scope_offers.product_id,
      ranked_scope_offers.scope_key,
      max(ranked_scope_offers.price) filter (where ranked_scope_offers.price_rank <= 5) as top5_price
    from ranked_scope_offers
    group by ranked_scope_offers.product_id, ranked_scope_offers.scope_key
  ),
  offer_metrics as (
    select
      ranked_scope_offers.*,
      top5_stats.top5_price,
      case
        when ranked_scope_offers.min_price > 0
        then greatest(0::numeric, (ranked_scope_offers.price - ranked_scope_offers.min_price) / ranked_scope_offers.min_price)
        else null
      end as gap_to_min,
      case
        when top5_stats.top5_price > 0
        then greatest(0::numeric, (ranked_scope_offers.price - top5_stats.top5_price) / top5_stats.top5_price)
        else null
      end as gap_to_top5
    from ranked_scope_offers
    join top5_stats
      on top5_stats.product_id = ranked_scope_offers.product_id
      and top5_stats.scope_key = ranked_scope_offers.scope_key
  ),
  sampled_metrics as (
    select
      offer_metrics.*,
      row_number() over (
        partition by offer_metrics.source_id
        order by
          case
            when offer_metrics.price = offer_metrics.min_price then 0
            when offer_metrics.price_rank <= 5 then 1
            when offer_metrics.gap_to_min is not null and offer_metrics.gap_to_min >= 0.5 and offer_metrics.price > offer_metrics.top5_price then 2
            when offer_metrics.gap_to_min is not null and offer_metrics.gap_to_min <= 0.2 then 3
            else 4
          end,
          offer_metrics.gap_to_min desc nulls last,
          offer_metrics.price_rank asc,
          offer_metrics.public_updated_at desc nulls last
      ) as sample_rank
    from offer_metrics
  ),
  source_aggregates as (
    select
      offer_metrics.source_id,
      count(distinct offer_metrics.product_id || '|' || offer_metrics.scope_key) as competitive_scope_count,
      count(distinct offer_metrics.id) as priced_offer_count,
      count(*) as benchmark_offer_count,
      count(*) filter (where offer_metrics.price = offer_metrics.min_price) as lowest_hit_count,
      count(*) filter (where offer_metrics.price_rank <= 5) as top5_hit_count,
      count(*) filter (
        where case
          when offer_metrics.min_price > 0 then offer_metrics.price <= offer_metrics.min_price * 1.1
          else offer_metrics.price = offer_metrics.min_price
        end
      ) as within_10pct_count,
      count(*) filter (
        where case
          when offer_metrics.min_price > 0 then offer_metrics.price <= offer_metrics.min_price * 1.2
          else offer_metrics.price = offer_metrics.min_price
        end
      ) as within_20pct_count,
      count(*) filter (
        where offer_metrics.gap_to_min is not null
          and offer_metrics.gap_to_min >= 0.5
          and offer_metrics.price > offer_metrics.top5_price
      ) as high_gap_count,
      case
        when count(*) > 0
        then round(
          count(*) filter (
            where offer_metrics.gap_to_min is not null
              and offer_metrics.gap_to_min >= 0.5
              and offer_metrics.price > offer_metrics.top5_price
          )::numeric / count(*)::numeric,
          4
        )
        else 0
      end as high_gap_share,
      percentile_disc(0.5) within group (order by offer_metrics.gap_to_min)
        filter (where offer_metrics.gap_to_min is not null) as median_gap_to_min,
      percentile_disc(0.5) within group (order by offer_metrics.gap_to_top5)
        filter (where offer_metrics.gap_to_top5 is not null) as median_gap_to_top5,
      avg(offer_metrics.gap_to_min) filter (where offer_metrics.gap_to_min is not null) as avg_gap_to_min
    from offer_metrics
    group by offer_metrics.source_id
  ),
  source_samples as (
    select
      sampled_metrics.source_id,
      jsonb_agg(
        jsonb_build_object(
          'productId', sampled_metrics.product_id,
          'productName', sampled_metrics.product_name,
          'scopeKey', sampled_metrics.scope_key,
          'scopeLabel', sampled_metrics.scope_label,
          'offerTitle', sampled_metrics.source_title,
          'price', sampled_metrics.price,
          'minPrice', sampled_metrics.min_price,
          'top5Price', sampled_metrics.top5_price,
          'rank', sampled_metrics.price_rank,
          'gapToMin', case when sampled_metrics.gap_to_min is null then null else round(sampled_metrics.gap_to_min, 4) end,
          'gapToTop5', case when sampled_metrics.gap_to_top5 is null then null else round(sampled_metrics.gap_to_top5, 4) end
        )
        order by sampled_metrics.sample_rank
      ) as sample_scopes
    from sampled_metrics
    where sampled_metrics.sample_rank <= 5
    group by sampled_metrics.source_id
  )
  select
    source_aggregates.source_id,
    source_aggregates.competitive_scope_count,
    source_aggregates.priced_offer_count,
    source_aggregates.benchmark_offer_count,
    source_aggregates.lowest_hit_count,
    source_aggregates.top5_hit_count,
    source_aggregates.within_10pct_count,
    source_aggregates.within_20pct_count,
    source_aggregates.high_gap_count,
    source_aggregates.high_gap_share,
    source_aggregates.median_gap_to_min,
    source_aggregates.median_gap_to_top5,
    source_aggregates.avg_gap_to_min,
    coalesce(source_samples.sample_scopes, '[]'::jsonb) as sample_scopes
  from source_aggregates
  left join source_samples on source_samples.source_id = source_aggregates.source_id
  order by
    source_aggregates.lowest_hit_count desc,
    source_aggregates.top5_hit_count desc,
    source_aggregates.benchmark_offer_count desc,
    source_aggregates.source_id asc;
$$;

revoke execute on function build_source_quality_price_benchmark_rows() from anon, authenticated, public;
grant execute on function build_source_quality_price_benchmark_rows() to service_role;

drop materialized view if exists source_quality_price_benchmarks;

create materialized view source_quality_price_benchmarks as
select
  build_source_quality_price_benchmark_rows.source_id,
  build_source_quality_price_benchmark_rows.competitive_scope_count,
  build_source_quality_price_benchmark_rows.priced_offer_count,
  build_source_quality_price_benchmark_rows.benchmark_offer_count,
  build_source_quality_price_benchmark_rows.lowest_hit_count,
  build_source_quality_price_benchmark_rows.top5_hit_count,
  build_source_quality_price_benchmark_rows.within_10pct_count,
  build_source_quality_price_benchmark_rows.within_20pct_count,
  build_source_quality_price_benchmark_rows.high_gap_count,
  build_source_quality_price_benchmark_rows.high_gap_share,
  build_source_quality_price_benchmark_rows.median_gap_to_min,
  build_source_quality_price_benchmark_rows.median_gap_to_top5,
  build_source_quality_price_benchmark_rows.avg_gap_to_min,
  build_source_quality_price_benchmark_rows.sample_scopes,
  now() as computed_at
from build_source_quality_price_benchmark_rows();

create unique index source_quality_price_benchmarks_source_id_idx
  on source_quality_price_benchmarks(source_id);

revoke all on table source_quality_price_benchmarks from anon, authenticated, public;
grant select on table source_quality_price_benchmarks to service_role;

create or replace function refresh_source_quality_price_benchmarks()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  refreshed_count bigint;
begin
  refresh materialized view source_quality_price_benchmarks;

  select count(*)
  into refreshed_count
  from source_quality_price_benchmarks;

  return refreshed_count;
end;
$$;

revoke execute on function refresh_source_quality_price_benchmarks() from anon, authenticated, public;
grant execute on function refresh_source_quality_price_benchmarks() to service_role;

create or replace function refresh_source_quality_price_benchmarks_if_stale(
  p_max_age_minutes integer default 15
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  latest_computed_at timestamptz;
  max_age interval := make_interval(mins => greatest(5, least(coalesce(p_max_age_minutes, 15), 180)));
begin
  select max(computed_at)
  into latest_computed_at
  from source_quality_price_benchmarks;

  if latest_computed_at is not null and latest_computed_at >= now() - max_age then
    return false;
  end if;

  if not pg_try_advisory_xact_lock(19370015) then
    return false;
  end if;

  select max(computed_at)
  into latest_computed_at
  from source_quality_price_benchmarks;

  if latest_computed_at is not null and latest_computed_at >= now() - max_age then
    return false;
  end if;

  refresh materialized view source_quality_price_benchmarks;
  return true;
end;
$$;

revoke execute on function refresh_source_quality_price_benchmarks_if_stale(integer) from anon, authenticated, public;
grant execute on function refresh_source_quality_price_benchmarks_if_stale(integer) to service_role;

create or replace function list_source_quality_price_benchmarks()
returns table (
  source_id text,
  competitive_scope_count bigint,
  priced_offer_count bigint,
  benchmark_offer_count bigint,
  lowest_hit_count bigint,
  top5_hit_count bigint,
  within_10pct_count bigint,
  within_20pct_count bigint,
  high_gap_count bigint,
  high_gap_share numeric,
  median_gap_to_min numeric,
  median_gap_to_top5 numeric,
  avg_gap_to_min numeric,
  sample_scopes jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    source_quality_price_benchmarks.source_id,
    source_quality_price_benchmarks.competitive_scope_count,
    source_quality_price_benchmarks.priced_offer_count,
    source_quality_price_benchmarks.benchmark_offer_count,
    source_quality_price_benchmarks.lowest_hit_count,
    source_quality_price_benchmarks.top5_hit_count,
    source_quality_price_benchmarks.within_10pct_count,
    source_quality_price_benchmarks.within_20pct_count,
    source_quality_price_benchmarks.high_gap_count,
    source_quality_price_benchmarks.high_gap_share,
    source_quality_price_benchmarks.median_gap_to_min,
    source_quality_price_benchmarks.median_gap_to_top5,
    source_quality_price_benchmarks.avg_gap_to_min,
    source_quality_price_benchmarks.sample_scopes
  from source_quality_price_benchmarks
  order by
    source_quality_price_benchmarks.lowest_hit_count desc,
    source_quality_price_benchmarks.top5_hit_count desc,
    source_quality_price_benchmarks.benchmark_offer_count desc,
    source_quality_price_benchmarks.source_id asc;
$$;

revoke execute on function list_source_quality_price_benchmarks() from anon, authenticated, public;
grant execute on function list_source_quality_price_benchmarks() to service_role;

create table if not exists site_feedback (
  id text primary key,
  type text not null,
  message text not null,
  contact text,
  page_url text,
  status text not null default 'pending',
  reviewer_note text,
  submitter_ip text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists site_feedback_status_idx on site_feedback(status);
create index if not exists site_feedback_created_at_idx on site_feedback(created_at desc);

alter table site_feedback enable row level security;

create extension if not exists pgcrypto;

create table if not exists official_subscription_apps (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  provider text not null,
  app_store_id text not null,
  app_store_slug text not null,
  logo_key text,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists official_subscription_regions (
  id uuid primary key default gen_random_uuid(),
  country_code text not null unique,
  storefront_code text not null,
  country_label text not null,
  currency_code text not null,
  enabled boolean not null default true,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists official_subscription_plans (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references official_subscription_apps(id) on delete cascade,
  slug text not null,
  label text not null,
  billing_period text not null check (billing_period in ('monthly', 'annual', 'one_time')),
  notes text,
  aliases text[] not null default '{}'::text[],
  match_rules jsonb not null default '{}'::jsonb,
  canonical_product_id text references canonical_products(id) on delete set null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id, slug)
);

create table if not exists official_subscription_collect_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null default 'manual' check (mode in ('manual', 'cron', 'worker')),
  target_app_slug text,
  target_region_codes text[],
  status text not null check (status in ('success', 'partial_success', 'failed')),
  success_count integer not null default 0,
  failure_count integer not null default 0,
  unmatched_count integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  logs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists official_subscription_region_prices (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references official_subscription_apps(id) on delete cascade,
  plan_id uuid not null references official_subscription_plans(id) on delete cascade,
  region_id uuid not null references official_subscription_regions(id) on delete cascade,
  price_text text,
  price_value numeric,
  currency_code text,
  cny_price numeric,
  fx_rate_to_cny numeric,
  fx_date date,
  source_url text not null,
  evidence_source text not null default 'app_store_html' check (evidence_source in ('app_store_html', 'amp_catalog', 'manual_verified')),
  status text not null check (status in ('available', 'stale', 'missing', 'parse_failed', 'needs_review')),
  raw_title text,
  raw_snippet_hash text,
  last_success_at timestamptz,
  last_checked_at timestamptz not null default now(),
  failure_reason text,
  updated_at timestamptz not null default now(),
  unique (app_id, plan_id, region_id)
);

create table if not exists official_subscription_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references official_subscription_collect_runs(id) on delete set null,
  app_id uuid not null references official_subscription_apps(id) on delete cascade,
  plan_id uuid not null references official_subscription_plans(id) on delete cascade,
  region_id uuid not null references official_subscription_regions(id) on delete cascade,
  price_text text,
  price_value numeric,
  currency_code text,
  cny_price numeric,
  fx_rate_to_cny numeric,
  fx_date date,
  source_url text not null,
  evidence_source text not null default 'app_store_html' check (evidence_source in ('app_store_html', 'amp_catalog', 'manual_verified')),
  raw_title text,
  raw_snippet_hash text,
  fetched_at timestamptz not null,
  status text not null check (status in ('available', 'stale', 'missing', 'parse_failed', 'needs_review')),
  failure_reason text,
  created_at timestamptz not null default now()
);

create table if not exists fx_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency text not null,
  target_currency text not null,
  rate numeric not null,
  date date not null,
  source text not null,
  fetched_at timestamptz not null default now(),
  unique (base_currency, target_currency, date, source)
);

create index if not exists official_subscription_apps_enabled_sort_idx
  on official_subscription_apps(enabled, sort_order);
create index if not exists official_subscription_plans_app_sort_idx
  on official_subscription_plans(app_id, enabled, sort_order);
create index if not exists official_subscription_regions_enabled_priority_idx
  on official_subscription_regions(enabled, priority);
create index if not exists official_subscription_region_prices_status_idx
  on official_subscription_region_prices(status, updated_at desc);
create index if not exists official_subscription_region_prices_plan_idx
  on official_subscription_region_prices(plan_id, status, cny_price);
create index if not exists official_subscription_price_snapshots_run_idx
  on official_subscription_price_snapshots(run_id, created_at desc);
create index if not exists official_subscription_collect_runs_finished_idx
  on official_subscription_collect_runs(finished_at desc);

drop trigger if exists official_subscription_apps_set_updated_at on official_subscription_apps;
create trigger official_subscription_apps_set_updated_at
before update on official_subscription_apps
for each row execute function set_updated_at();

drop trigger if exists official_subscription_regions_set_updated_at on official_subscription_regions;
create trigger official_subscription_regions_set_updated_at
before update on official_subscription_regions
for each row execute function set_updated_at();

drop trigger if exists official_subscription_plans_set_updated_at on official_subscription_plans;
create trigger official_subscription_plans_set_updated_at
before update on official_subscription_plans
for each row execute function set_updated_at();

drop trigger if exists official_subscription_region_prices_set_updated_at on official_subscription_region_prices;
create trigger official_subscription_region_prices_set_updated_at
before update on official_subscription_region_prices
for each row execute function set_updated_at();

alter table official_subscription_apps enable row level security;
alter table official_subscription_regions enable row level security;
alter table official_subscription_plans enable row level security;
alter table official_subscription_collect_runs enable row level security;
alter table official_subscription_region_prices enable row level security;
alter table official_subscription_price_snapshots enable row level security;
alter table fx_rates enable row level security;
create table if not exists api_model_families (
  id text primary key,
  name text not null,
  slug text not null unique,
  logo_url text,
  official_url text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_models (
  id text primary key,
  family_id text not null references api_model_families(id) on delete restrict,
  display_name text not null,
  model_id text not null,
  aliases text[] not null default '{}'::text[],
  context_window text,
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'inactive', 'needs_review')),
  source_url text not null,
  source_label text not null default '公开来源',
  capabilities text[] not null default '{}'::text[],
  suitable_tools text[] not null default '{}'::text[],
  data_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_providers (
  id text primary key,
  name text not null,
  slug text not null unique,
  type text not null check (type in ('official', 'router', 'free', 'subscription')),
  billing_mode text not null,
  official_url text not null,
  pricing_url text,
  logo_url text,
  description text not null default '',
  limit_summary text not null default '',
  limitations text not null default '',
  source_label text not null default '公开来源',
  collector_kind text,
  enabled boolean not null default true,
  data_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_plans (
  id text primary key,
  provider_id text not null references api_providers(id) on delete cascade,
  name text not null,
  type text not null check (type in ('official', 'router', 'free', 'subscription')),
  price_label text not null default '',
  price_usd_monthly numeric,
  price_cny_monthly numeric,
  quota_summary text not null default '',
  reset_summary text not null default '',
  limit_summary text not null default '',
  limitations text not null default '',
  coverage_label text,
  compatibility text[] not null default '{}'::text[],
  suitable_tools text[] not null default '{}'::text[],
  source_url text not null,
  source_label text not null default '公开来源',
  enabled boolean not null default true,
  data_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_plan_models (
  plan_id text not null references api_plans(id) on delete cascade,
  model_id text not null references api_models(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (plan_id, model_id)
);

create table if not exists api_model_offers (
  id text primary key,
  model_id text not null references api_models(id) on delete cascade,
  provider_id text not null references api_providers(id) on delete cascade,
  plan_id text references api_plans(id) on delete set null,
  route_model_id text,
  input_price jsonb not null default '{"kind":"text","text":"待确认"}'::jsonb,
  output_price jsonb not null default '{"kind":"text","text":"待确认"}'::jsonb,
  cache_read_price jsonb,
  cache_write_price jsonb,
  free_or_plan text not null default '',
  limit_summary text not null default '',
  limitations text not null default '',
  compatibility text[] not null default '{}'::text[],
  suitable_tools text[] not null default '{}'::text[],
  pricing_url text,
  source_label text not null default '公开来源',
  collected_at timestamptz,
  status text not null default 'active' check (status in ('active', 'inactive', 'needs_review')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_provider_submissions (
  id text primary key,
  submitted_url text not null,
  submitted_name text,
  submitted_contact text,
  submitted_note text,
  parsed_provider_url text,
  parsed_provider_name text,
  parsed_type text,
  parse_status text not null default 'pending',
  probe_status text not null default 'pending',
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'collector_todo', 'rejected')),
  admin_note text,
  provider_id text references api_providers(id) on delete set null,
  parsed_meta jsonb not null default '{}'::jsonb,
  submitter_ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_collection_runs (
  id text primary key,
  provider_id text references api_providers(id) on delete set null,
  collector_kind text,
  status text not null check (status in ('success', 'partial', 'failed')),
  model_count integer not null default 0,
  offer_count integer not null default 0,
  error_message text,
  raw_snapshot_url text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  logs jsonb not null default '{}'::jsonb
);

create index if not exists api_models_family_id_idx on api_models(family_id);
create index if not exists api_models_status_idx on api_models(status);
create index if not exists api_providers_type_idx on api_providers(type);
create index if not exists api_providers_enabled_idx on api_providers(enabled);
create index if not exists api_plans_provider_id_idx on api_plans(provider_id);
create index if not exists api_model_offers_model_id_idx on api_model_offers(model_id);
create index if not exists api_model_offers_provider_id_idx on api_model_offers(provider_id);
create index if not exists api_model_offers_status_idx on api_model_offers(status);
create index if not exists api_collection_runs_started_at_idx on api_collection_runs(started_at desc);
create index if not exists api_provider_submissions_review_status_idx on api_provider_submissions(review_status);
create index if not exists api_provider_submissions_created_at_idx on api_provider_submissions(created_at desc);

drop trigger if exists api_model_families_set_updated_at on api_model_families;
create trigger api_model_families_set_updated_at
before update on api_model_families
for each row execute function set_updated_at();

drop trigger if exists api_models_set_updated_at on api_models;
create trigger api_models_set_updated_at
before update on api_models
for each row execute function set_updated_at();

drop trigger if exists api_providers_set_updated_at on api_providers;
create trigger api_providers_set_updated_at
before update on api_providers
for each row execute function set_updated_at();

drop trigger if exists api_plans_set_updated_at on api_plans;
create trigger api_plans_set_updated_at
before update on api_plans
for each row execute function set_updated_at();

drop trigger if exists api_model_offers_set_updated_at on api_model_offers;
create trigger api_model_offers_set_updated_at
before update on api_model_offers
for each row execute function set_updated_at();

drop trigger if exists api_provider_submissions_set_updated_at on api_provider_submissions;
create trigger api_provider_submissions_set_updated_at
before update on api_provider_submissions
for each row execute function set_updated_at();

alter table api_model_families enable row level security;
alter table api_models enable row level security;
alter table api_providers enable row level security;
alter table api_plans enable row level security;
alter table api_plan_models enable row level security;
alter table api_model_offers enable row level security;
alter table api_provider_submissions enable row level security;
alter table api_collection_runs enable row level security;

create table if not exists app_runtime_settings (
  id text primary key,
  provider text not null default 'opencode',
  base_url text not null,
  model text not null,
  timeout_ms integer not null default 12000 check (timeout_ms between 3000 and 60000),
  encrypted_api_key jsonb,
  api_key_hint text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists app_runtime_settings_set_updated_at on app_runtime_settings;
create trigger app_runtime_settings_set_updated_at
before update on app_runtime_settings
for each row execute function set_updated_at();

alter table app_runtime_settings enable row level security;

create or replace function prune_priceai_operational_logs(
  p_crawl_runs_per_source integer default 5,
  p_crawl_run_failure_retention_days integer default 7,
  p_crawl_run_global_limit integer default 1000,
  p_collection_jobs_limit integer default 200,
  p_official_collect_runs_limit integer default 5,
  p_api_collect_runs_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crawl_runs_per_source integer := greatest(1, least(coalesce(p_crawl_runs_per_source, 5), 50));
  v_crawl_run_failure_retention_days integer := greatest(1, least(coalesce(p_crawl_run_failure_retention_days, 7), 90));
  v_crawl_run_global_limit integer := greatest(100, least(coalesce(p_crawl_run_global_limit, 1000), 100000));
  v_collection_jobs_limit integer := greatest(30, least(coalesce(p_collection_jobs_limit, 200), 10000));
  v_official_collect_runs_limit integer := greatest(1, least(coalesce(p_official_collect_runs_limit, 5), 5000));
  v_api_collect_runs_limit integer := greatest(1, least(coalesce(p_api_collect_runs_limit, 5), 5000));
  v_crawl_success_deleted integer := 0;
  v_crawl_failure_deleted integer := 0;
  v_crawl_global_deleted integer := 0;
  v_collection_jobs_deleted integer := 0;
  v_official_snapshots_deleted integer := 0;
  v_official_runs_deleted integer := 0;
  v_api_runs_deleted integer := 0;
begin
  with ranked as (
    select
      id,
      row_number() over (
        partition by coalesce(source_id, source_name, 'unknown')
        order by started_at desc nulls last, id desc
      ) as run_rank
    from crawl_runs
    where status = 'success'
  )
  delete from crawl_runs
  using ranked
  where crawl_runs.id = ranked.id
    and ranked.run_rank > v_crawl_runs_per_source;
  get diagnostics v_crawl_success_deleted = row_count;

  delete from crawl_runs
  where status <> 'success'
    and started_at < now() - make_interval(days => v_crawl_run_failure_retention_days);
  get diagnostics v_crawl_failure_deleted = row_count;

  with ranked as (
    select
      id,
      row_number() over (
        order by started_at desc nulls last, id desc
      ) as global_rank
    from crawl_runs
  )
  delete from crawl_runs
  using ranked
  where crawl_runs.id = ranked.id
    and ranked.global_rank > v_crawl_run_global_limit;
  get diagnostics v_crawl_global_deleted = row_count;

  with ranked as (
    select
      id,
      row_number() over (
        order by created_at desc nulls last, id desc
      ) as job_rank
    from collection_jobs
    where status in ('success', 'failed', 'cancelled')
  )
  delete from collection_jobs
  using ranked
  where collection_jobs.id = ranked.id
    and ranked.job_rank > v_collection_jobs_limit;
  get diagnostics v_collection_jobs_deleted = row_count;

  with stale_runs as (
    select id
    from (
      select
        id,
        row_number() over (
          order by finished_at desc nulls last, created_at desc nulls last, id desc
        ) as run_rank
      from official_subscription_collect_runs
    ) ranked
    where run_rank > v_official_collect_runs_limit
  )
  delete from official_subscription_price_snapshots
  using stale_runs
  where official_subscription_price_snapshots.run_id = stale_runs.id;
  get diagnostics v_official_snapshots_deleted = row_count;

  with stale_runs as (
    select id
    from (
      select
        id,
        row_number() over (
          order by finished_at desc nulls last, created_at desc nulls last, id desc
        ) as run_rank
      from official_subscription_collect_runs
    ) ranked
    where run_rank > v_official_collect_runs_limit
  )
  delete from official_subscription_collect_runs
  using stale_runs
  where official_subscription_collect_runs.id = stale_runs.id;
  get diagnostics v_official_runs_deleted = row_count;

  with ranked as (
    select
      id,
      row_number() over (
        order by started_at desc nulls last, id desc
      ) as run_rank
    from api_collection_runs
  )
  delete from api_collection_runs
  using ranked
  where api_collection_runs.id = ranked.id
    and ranked.run_rank > v_api_collect_runs_limit;
  get diagnostics v_api_runs_deleted = row_count;

  return jsonb_build_object(
    'crawlRunsDeleted',
      v_crawl_success_deleted + v_crawl_failure_deleted + v_crawl_global_deleted,
    'crawlSuccessRunsDeleted', v_crawl_success_deleted,
    'crawlFailureRunsDeleted', v_crawl_failure_deleted,
    'crawlGlobalCapDeleted', v_crawl_global_deleted,
    'collectionJobsDeleted', v_collection_jobs_deleted,
    'officialSnapshotsDeleted', v_official_snapshots_deleted,
    'officialRunsDeleted', v_official_runs_deleted,
    'apiRunsDeleted', v_api_runs_deleted,
    'settings', jsonb_build_object(
      'crawlRunsPerSource', v_crawl_runs_per_source,
      'crawlRunFailureRetentionDays', v_crawl_run_failure_retention_days,
      'crawlRunGlobalLimit', v_crawl_run_global_limit,
      'collectionJobsLimit', v_collection_jobs_limit,
      'officialCollectRunsLimit', v_official_collect_runs_limit,
      'apiCollectRunsLimit', v_api_collect_runs_limit
    )
  );
end;
$$;

revoke execute on function prune_priceai_operational_logs(
  integer,
  integer,
  integer,
  integer,
  integer,
  integer
) from public, anon, authenticated;

grant execute on function prune_priceai_operational_logs(
  integer,
  integer,
  integer,
  integer,
  integer,
  integer
) to service_role;
create table if not exists api_transit_stations (
  id text primary key,
  slug text not null unique,
  name text not null,
  website_url text not null,
  logo_url text,
  api_base_url text,
  pricing_url text,
  monitor_url text,
  status text not null default 'unknown' check (status in ('active', 'limited', 'unavailable', 'unknown')),
  source_type text not null default 'manual_collected' check (source_type in ('manual_collected', 'user_submitted', 'merchant_submitted')),
  commercial_relation text not null default 'unknown' check (commercial_relation in ('none', 'listed', 'partner', 'affiliate', 'sponsored', 'unknown')),
  station_system text check (station_system in ('new_api', 'sub_to_api', 'custom', 'unknown')),
  operator_type text not null default 'individual' check (operator_type in ('company', 'individual', 'unknown')),
  invoice_support text not null default 'unknown' check (invoice_support in ('supported', 'unsupported', 'unknown')),
  summary text not null default '',
  channel_types text[] not null default '{}'::text[],
  account_pools text[] not null default '{}'::text[],
  payment_methods text[] not null default '{}'::text[],
  minimum_top_up text,
  balance_expiry text,
  support_channels text[] not null default '{}'::text[],
  refund_policy text,
  risk_labels text[] not null default '{}'::text[],
  usage_advice text not null default 'pending' check (usage_advice in ('try_small', 'cautious', 'not_recommended', 'pending')),
  data_status text not null default 'pending_review' check (data_status in ('sample', 'pending_review', 'verified')),
  availability_seven_day_rate numeric,
  availability_seven_day_samples integer not null default 0,
  availability_first_checked_at timestamptz,
  availability_last_checked_at timestamptz,
  availability_latest_latency_ms integer,
  availability_avg_latency_7d_ms integer,
  availability_note text,
  feedback_pending_count integer not null default 0,
  feedback_verified_risk_count integer not null default 0,
  feedback_merchant_responded_count integer not null default 0,
  feedback_main_themes text[] not null default '{}'::text[],
  feedback_public_notes text,
  strengths text[] not null default '{}'::text[],
  cautions text[] not null default '{}'::text[],
  commercial_offers jsonb not null default '[]'::jsonb,
  verification_events jsonb not null default '[]'::jsonb,
  collector_kind text not null default 'manual_review',
  pricing_endpoint_url text,
  collection_status text not null default 'pending' check (collection_status in ('pending', 'success', 'partial', 'failed', 'manual_review')),
  collection_error text,
  last_collected_at timestamptz,
  last_updated_at timestamptz not null default now(),
  published boolean not null default false,
  removed_at timestamptz,
  removed_reason text,
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_transit_offers (
  id text primary key,
  station_id text not null references api_transit_stations(id) on delete cascade,
  family text not null check (family in ('gpt', 'claude', 'gemini', 'grok', 'glm', 'deepseek', 'kimi', 'qwen', 'image', 'video')),
  standard_model text not null,
  raw_model_name text not null,
  group_name text not null,
  recharge_ratio text,
  billing_mode text check (billing_mode is null or billing_mode in ('token', 'per_request', 'fixed')),
  model_multiplier numeric,
  input_price numeric,
  output_price numeric,
  cache_read_price numeric,
  cache_write_price numeric,
  cache_hit_rate numeric,
  cache_hit_sample_tokens bigint not null default 0,
  image_output_price numeric,
  fixed_price numeric,
  fixed_price_currency text not null default 'CNY' check (fixed_price_currency in ('CNY')),
  fixed_price_unit text,
  fixed_price_tiers jsonb not null default '[]'::jsonb,
  currency text not null default 'CNY',
  account_pool text not null default 'undisclosed',
  channel_type text not null default 'undisclosed',
  price_source text not null default '公开价格页',
  source_url text,
  availability_seven_day_rate numeric,
  availability_seven_day_samples integer not null default 0,
  availability_first_checked_at timestamptz,
  availability_last_checked_at timestamptz,
  availability_latest_latency_ms integer,
  availability_avg_latency_7d_ms integer,
  availability_note text,
  availability_scope text check (availability_scope is null or availability_scope in ('station', 'group', 'model', 'offer')),
  availability_match_level text check (availability_match_level is null or availability_match_level in ('exact', 'group', 'model', 'family')),
  monitoring_scope_id text,
  last_verified_at timestamptz,
  status text not null default 'needs_review' check (status in ('active', 'needs_review', 'inactive')),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station_id, standard_model, group_name)
);

create table if not exists api_transit_submissions (
  id text primary key,
  submission_type text not null default 'user' check (submission_type in ('user', 'merchant')),
  submitted_url text not null,
  submitted_name text,
  api_base_url text,
  pricing_url text,
  contact text,
  notes text,
  submitted_models text[] not null default '{}'::text[],
  submitted_meta jsonb not null default '{}'::jsonb,
  parse_status text not null default 'pending' check (parse_status in ('pending', 'parsed', 'failed')),
  probe_status text not null default 'pending' check (probe_status in ('pending', 'public_pricing_found', 'needs_login', 'failed')),
  review_status text not null default 'pending' check (review_status in ('pending', 'collector_todo', 'approved', 'rejected')),
  station_id text references api_transit_stations(id) on delete set null,
  normalized_url text,
  normalized_host text,
  duplicate_of text references api_transit_submissions(id) on delete set null,
  duplicate_count integer not null default 0,
  admin_note text,
  submitter_ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_transit_credentials (
  id text primary key,
  submission_id text not null references api_transit_submissions(id) on delete cascade,
  station_id text references api_transit_stations(id) on delete set null,
  credential_type text not null check (credential_type in ('test_key', 'test_account')),
  status text not null default 'submitted' check (status in ('submitted', 'ready', 'failed', 'revoked', 'deleted')),
  encrypted_payload jsonb not null,
  credential_meta jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  last_used_at timestamptz,
  failure_message text,
  submitter_ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (submission_id, credential_type)
);

create table if not exists api_transit_detection_runs (
  id text primary key,
  station_id text references api_transit_stations(id) on delete cascade,
  run_type text not null default 'public_pricing' check (run_type in ('public_pricing', 'model_list', 'api_probe', 'manual_review')),
  status text not null check (status in ('success', 'partial', 'failed')),
  model_count integer not null default 0,
  offer_count integer not null default 0,
  error_message text,
  source_url text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  raw_snapshot jsonb not null default '{}'::jsonb,
  logs jsonb not null default '{}'::jsonb
);

create table if not exists transit_detector_jobs (
  id text primary key,
  user_id uuid not null,
  user_email text,
  protocol text not null,
  base_url text,
  target_model text not null,
  intensity text not null default 'standard',
  include_long_context boolean not null default false,
  upstream_type text,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error', 'timed_out')),
  detector_job_id text,
  status_url text,
  result_url text,
  json_url text,
  image_url text,
  error_message text,
  idempotency_key text,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  attempt_count integer not null default 0,
  submitted_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists transit_detector_jobs_user_submitted_idx on transit_detector_jobs(user_id, submitted_at desc);
create index if not exists transit_detector_jobs_detector_job_id_idx on transit_detector_jobs(detector_job_id);
create unique index if not exists transit_detector_jobs_user_idempotency_idx on transit_detector_jobs(user_id, idempotency_key) where idempotency_key is not null;
create index if not exists transit_detector_jobs_active_lease_idx on transit_detector_jobs(user_id, lease_expires_at) where status in ('queued', 'running');

alter table transit_detector_jobs enable row level security;

drop trigger if exists transit_detector_jobs_set_updated_at on transit_detector_jobs;
create trigger transit_detector_jobs_set_updated_at
before update on transit_detector_jobs
for each row execute function set_updated_at();

create or replace function claim_transit_detector_job(
  p_id text,
  p_user_id uuid,
  p_user_email text,
  p_protocol text,
  p_base_url text,
  p_target_model text,
  p_intensity text,
  p_include_long_context boolean,
  p_upstream_type text,
  p_idempotency_key text,
  p_daily_limit integer,
  p_active_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.transit_detector_jobs%rowtype;
  v_recent_count integer := 0;
  v_active_count integer := 0;
  v_now timestamptz := now();
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  if p_user_id is null or nullif(trim(p_id), '') is null or nullif(trim(p_idempotency_key), '') is null then
    raise exception 'invalid detector job claim';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_existing
  from public.transit_detector_jobs
  where user_id = p_user_id and idempotency_key = p_idempotency_key
  limit 1;

  if found then
    return jsonb_build_object('outcome', 'existing', 'jobId', v_existing.id, 'status', v_existing.status);
  end if;

  update public.transit_detector_jobs
  set status = 'timed_out',
      error_message = coalesce(error_message, '检测任务超过等待时间，已自动释放名额。'),
      completed_at = v_now,
      lease_expires_at = null,
      updated_at = v_now
  where user_id = p_user_id
    and status in ('queued', 'running')
    and coalesce(lease_expires_at, updated_at + interval '30 minutes') < v_now;

  select count(*)::integer into v_recent_count
  from public.transit_detector_jobs
  where user_id = p_user_id and submitted_at >= v_now - interval '24 hours';

  if v_recent_count >= greatest(1, least(coalesce(p_daily_limit, 8), 100)) then
    return jsonb_build_object('outcome', 'quota_exceeded', 'recentCount', v_recent_count, 'activeCount', 0);
  end if;

  select count(*)::integer into v_active_count
  from public.transit_detector_jobs
  where user_id = p_user_id and status in ('queued', 'running');

  if v_active_count >= greatest(1, least(coalesce(p_active_limit, 2), 20)) then
    return jsonb_build_object('outcome', 'active_limit', 'recentCount', v_recent_count, 'activeCount', v_active_count);
  end if;

  insert into public.transit_detector_jobs (
    id, user_id, user_email, protocol, base_url, target_model, intensity,
    include_long_context, upstream_type, status, idempotency_key,
    lease_expires_at, last_heartbeat_at, attempt_count
  ) values (
    p_id, p_user_id, p_user_email, p_protocol, p_base_url, p_target_model, p_intensity,
    coalesce(p_include_long_context, false), p_upstream_type, 'queued', p_idempotency_key,
    v_now + make_interval(secs => v_lease_seconds), v_now, 1
  );

  return jsonb_build_object(
    'outcome', 'created', 'jobId', p_id, 'status', 'queued',
    'recentCount', v_recent_count + 1, 'activeCount', v_active_count + 1
  );
end;
$$;

revoke all on function claim_transit_detector_job(text, uuid, text, text, text, text, text, boolean, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function claim_transit_detector_job(text, uuid, text, text, text, text, text, boolean, text, text, integer, integer, integer) to service_role;

drop policy if exists transit_detector_jobs_select_own on transit_detector_jobs;
create policy transit_detector_jobs_select_own on transit_detector_jobs for select to authenticated using (auth.uid() = user_id);

create table if not exists transit_detector_report_shares (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references transit_detector_jobs(id) on delete cascade,
  user_id uuid not null,
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists transit_detector_report_shares_user_job_idx on transit_detector_report_shares(user_id, job_id, created_at desc);
create unique index if not exists transit_detector_report_shares_one_active_job_idx on transit_detector_report_shares(job_id) where status = 'active';

alter table transit_detector_report_shares enable row level security;
drop policy if exists transit_detector_report_shares_select_own on transit_detector_report_shares;
create policy transit_detector_report_shares_select_own on transit_detector_report_shares for select to authenticated using (auth.uid() = user_id);

create table if not exists account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'cancelled', 'completed', 'rejected')),
  requested_at timestamptz not null default now(),
  scheduled_for timestamptz not null default (now() + interval '7 days'),
  cancelled_at timestamptz,
  completed_at timestamptz,
  resolution_note text,
  updated_at timestamptz not null default now()
);

create unique index if not exists account_deletion_requests_one_active_idx
  on account_deletion_requests(user_id)
  where status in ('pending', 'processing');
create index if not exists account_deletion_requests_status_schedule_idx on account_deletion_requests(status, scheduled_for);

alter table account_deletion_requests enable row level security;
drop policy if exists account_deletion_requests_select_own on account_deletion_requests;
create policy account_deletion_requests_select_own on account_deletion_requests for select to authenticated using (auth.uid() = user_id);

drop trigger if exists account_deletion_requests_set_updated_at on account_deletion_requests;
create trigger account_deletion_requests_set_updated_at
before update on account_deletion_requests
for each row execute function set_updated_at();

create table if not exists api_transit_availability_samples (
  id text primary key,
  run_id text not null references api_transit_detection_runs(id) on delete cascade,
  station_id text not null references api_transit_stations(id) on delete cascade,
  scope text not null check (scope in ('station', 'offer')),
  standard_model text,
  group_name text,
  ok boolean not null,
  latency_ms integer,
  ping_latency_ms integer,
  source_type text not null default 'unknown' check (
    source_type in (
      'priceai_probe',
      'public_status',
      'public_model_catalog',
      'partner_api',
      'merchant_reported',
      'manual_snapshot',
      'unknown'
    )
  ),
  source_label text,
  source_url text,
  checked_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists api_transit_feedback (
  id text primary key,
  station_id text references api_transit_stations(id) on delete set null,
  station_name text,
  station_url text,
  feedback_type text not null default 'general' check (feedback_type in ('general', 'price_change', 'unavailable', 'risk', 'merchant_response')),
  message text not null,
  evidence_urls jsonb not null default '[]'::jsonb,
  contact text,
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'rejected')),
  reviewer_note text,
  submitter_ip text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists api_transit_stations_published_idx on api_transit_stations(published, updated_at desc);
create index if not exists api_transit_stations_removed_at_idx on api_transit_stations(removed_at, published, updated_at desc);
create index if not exists api_transit_stations_status_idx on api_transit_stations(status);
create index if not exists api_transit_stations_collector_kind_idx on api_transit_stations(collector_kind);
create index if not exists api_transit_offers_station_id_idx on api_transit_offers(station_id);
create index if not exists api_transit_offers_family_idx on api_transit_offers(family);
create index if not exists api_transit_offers_status_idx on api_transit_offers(status);
create index if not exists api_transit_offers_monitoring_scope_idx
  on api_transit_offers(station_id, monitoring_scope_id)
  where status = 'active' and availability_seven_day_samples > 0;
create index if not exists api_transit_submissions_review_status_idx on api_transit_submissions(review_status, created_at desc);
create index if not exists api_transit_submissions_submitted_url_idx on api_transit_submissions(submitted_url);
create index if not exists api_transit_submissions_normalized_host_idx on api_transit_submissions(normalized_host, review_status, created_at desc);
create index if not exists api_transit_submissions_normalized_url_idx on api_transit_submissions(normalized_url, review_status, created_at desc);
create index if not exists api_transit_submissions_duplicate_of_idx on api_transit_submissions(duplicate_of);
create index if not exists api_transit_stations_commercial_offers_idx on api_transit_stations using gin (commercial_offers);
create index if not exists api_transit_stations_verification_events_idx on api_transit_stations using gin (verification_events);
create index if not exists api_transit_credentials_submission_id_idx on api_transit_credentials(submission_id);
create index if not exists api_transit_credentials_status_idx on api_transit_credentials(status, created_at desc);
create index if not exists api_transit_detection_runs_started_at_idx on api_transit_detection_runs(started_at desc);
create index if not exists api_transit_detection_runs_station_id_idx on api_transit_detection_runs(station_id);
create index if not exists api_transit_availability_samples_station_time_idx on api_transit_availability_samples(station_id, checked_at desc);
create index if not exists api_transit_availability_samples_offer_time_idx on api_transit_availability_samples(station_id, scope, standard_model, group_name, checked_at desc);
create index if not exists api_transit_availability_samples_source_time_idx on api_transit_availability_samples(station_id, source_type, checked_at desc);
create index if not exists api_transit_availability_samples_checked_time_idx on api_transit_availability_samples(checked_at desc, station_id) include (scope, standard_model, group_name, ok, source_type);
create index if not exists api_transit_feedback_status_idx on api_transit_feedback(status, created_at desc);

drop trigger if exists api_transit_stations_set_updated_at on api_transit_stations;
create trigger api_transit_stations_set_updated_at
before update on api_transit_stations
for each row execute function set_updated_at();

drop trigger if exists api_transit_offers_set_updated_at on api_transit_offers;
create trigger api_transit_offers_set_updated_at
before update on api_transit_offers
for each row execute function set_updated_at();

drop trigger if exists api_transit_submissions_set_updated_at on api_transit_submissions;
create trigger api_transit_submissions_set_updated_at
before update on api_transit_submissions
for each row execute function set_updated_at();

drop trigger if exists api_transit_credentials_set_updated_at on api_transit_credentials;
create trigger api_transit_credentials_set_updated_at
before update on api_transit_credentials
for each row execute function set_updated_at();

alter table api_transit_stations enable row level security;
alter table api_transit_offers enable row level security;
alter table api_transit_submissions enable row level security;
alter table api_transit_credentials enable row level security;
alter table api_transit_detection_runs enable row level security;
alter table api_transit_availability_samples enable row level security;
alter table api_transit_feedback enable row level security;

create table if not exists external_api_daily_usage (
  usage_date date not null,
  service text not null,
  usage_count integer not null default 0 check (usage_count >= 0),
  last_used_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (usage_date, service)
);

alter table external_api_daily_usage enable row level security;
drop trigger if exists external_api_daily_usage_set_updated_at on external_api_daily_usage;
create trigger external_api_daily_usage_set_updated_at
before update on external_api_daily_usage
for each row execute function set_updated_at();

create or replace function claim_external_api_daily_budget(
  p_service text,
  p_daily_limit integer,
  p_units integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service text := lower(trim(coalesce(p_service, '')));
  v_limit integer := greatest(1, least(coalesce(p_daily_limit, 1), 100000));
  v_units integer := greatest(1, least(coalesce(p_units, 1), 1000));
  v_used integer := 0;
  v_date date := (now() at time zone 'UTC')::date;
begin
  if v_service = '' or v_service !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    raise exception 'invalid external api service';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service || ':' || v_date::text, 0));
  select usage_count into v_used from external_api_daily_usage where usage_date = v_date and service = v_service;
  v_used := coalesce(v_used, 0);

  if v_used + v_units > v_limit then
    return jsonb_build_object('allowed', false, 'service', v_service, 'date', v_date, 'used', v_used, 'limit', v_limit, 'remaining', greatest(0, v_limit - v_used));
  end if;

  insert into external_api_daily_usage (usage_date, service, usage_count, last_used_at)
  values (v_date, v_service, v_units, now())
  on conflict (usage_date, service) do update
  set usage_count = external_api_daily_usage.usage_count + excluded.usage_count,
      last_used_at = excluded.last_used_at,
      updated_at = now()
  returning usage_count into v_used;

  return jsonb_build_object('allowed', true, 'service', v_service, 'date', v_date, 'used', v_used, 'limit', v_limit, 'remaining', greatest(0, v_limit - v_used));
end;
$$;

revoke all on function claim_external_api_daily_budget(text, integer, integer) from public, anon, authenticated;
grant execute on function claim_external_api_daily_budget(text, integer, integer) to service_role;

create or replace function prune_api_transit_offer_retention(
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
  from api_transit_offers
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
    from api_transit_offers
    where status = 'inactive'
      and updated_at < v_cutoff
    order by updated_at, id
    limit v_batch_size
    for update skip locked
  ), deleted as (
    delete from api_transit_offers as offers
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

revoke all on function prune_api_transit_offer_retention(integer, integer, boolean) from public, anon, authenticated;
grant execute on function prune_api_transit_offer_retention(integer, integer, boolean) to service_role;

create or replace function prune_api_transit_retention(
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
    'offers', prune_api_transit_offer_retention(7, p_batch_size, p_dry_run),
    'availability', prune_api_transit_availability_retention(8, 90, 365, p_batch_size, p_dry_run),
    'detectionRuns', prune_api_transit_detection_run_retention(14, 30, p_batch_size, p_dry_run)
  );
end;
$$;

revoke all on function prune_api_transit_retention(integer, boolean) from public, anon, authenticated;
grant execute on function prune_api_transit_retention(integer, boolean) to service_role;

comment on function prune_api_transit_offer_retention(integer, integer, boolean) is
  'Deletes inactive API transit offer entities after seven days while preserving independent multiplier history. Service role only; dry-run by default.';

-- Runtime leases, persistent admin throttling, and account deletion executor.
-- Keep this section aligned with 20260716120000_audit_closeout_runtime_controls.sql.
create table if not exists public.runtime_leases (
  lease_key text primary key,
  owner text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists runtime_leases_expires_at_idx
  on public.runtime_leases(expires_at);

alter table public.runtime_leases enable row level security;

create or replace function public.claim_runtime_lease(
  p_lease_key text,
  p_owner text,
  p_lease_seconds integer default 1800,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_expires_at timestamptz := v_now + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 1800), 7200)));
  v_row public.runtime_leases%rowtype;
begin
  if nullif(trim(p_lease_key), '') is null or nullif(trim(p_owner), '') is null then
    raise exception 'runtime lease key and owner are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(trim(p_lease_key), 0));

  insert into public.runtime_leases (lease_key, owner, acquired_at, expires_at, heartbeat_at, metadata)
  values (trim(p_lease_key), trim(p_owner), v_now, v_expires_at, v_now, coalesce(p_metadata, '{}'::jsonb))
  on conflict (lease_key) do update
  set owner = excluded.owner,
      acquired_at = case
        when public.runtime_leases.owner = excluded.owner then public.runtime_leases.acquired_at
        else excluded.acquired_at
      end,
      expires_at = excluded.expires_at,
      heartbeat_at = excluded.heartbeat_at,
      metadata = excluded.metadata
  where public.runtime_leases.expires_at <= v_now
     or public.runtime_leases.owner = excluded.owner;

  select * into v_row
  from public.runtime_leases
  where lease_key = trim(p_lease_key);

  return jsonb_build_object(
    'acquired', v_row.owner = trim(p_owner),
    'leaseKey', v_row.lease_key,
    'owner', v_row.owner,
    'expiresAt', v_row.expires_at,
    'heartbeatAt', v_row.heartbeat_at
  );
end;
$$;

create or replace function public.release_runtime_lease(
  p_lease_key text,
  p_owner text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.runtime_leases
  where lease_key = trim(p_lease_key)
    and owner = trim(p_owner);
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.claim_runtime_lease(text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.release_runtime_lease(text, text) from public, anon, authenticated;
grant execute on function public.claim_runtime_lease(text, text, integer, jsonb) to service_role;
grant execute on function public.release_runtime_lease(text, text) to service_role;

comment on table public.runtime_leases is
  'Cross-runtime leases shared by VPS timers, GitHub Actions, Workers cron routes, and manual recovery runs.';


create or replace function public.renew_runtime_lease(
  p_lease_key text,
  p_owner text,
  p_lease_seconds integer default 1800
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_expires_at timestamptz := v_now + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 1800), 7200)));
  v_row public.runtime_leases%rowtype;
  v_renewed boolean := false;
begin
  if nullif(trim(p_lease_key), '') is null or nullif(trim(p_owner), '') is null then
    raise exception 'runtime lease key and owner are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(trim(p_lease_key), 0));

  update public.runtime_leases
  set expires_at = v_expires_at,
      heartbeat_at = v_now
  where lease_key = trim(p_lease_key)
    and owner = trim(p_owner)
    and expires_at > v_now
  returning * into v_row;

  v_renewed := found;

  if not v_renewed then
    select * into v_row
    from public.runtime_leases
    where lease_key = trim(p_lease_key);
  end if;

  return jsonb_build_object(
    'renewed', v_renewed,
    'leaseKey', trim(p_lease_key),
    'owner', coalesce(v_row.owner, ''),
    'expiresAt', v_row.expires_at,
    'heartbeatAt', v_row.heartbeat_at
  );
end;
$$;

revoke all on function public.renew_runtime_lease(text, text, integer) from public, anon, authenticated;
grant execute on function public.renew_runtime_lease(text, text, integer) to service_role;

create table if not exists public.feedback_evidence_upload_rate_limits (
  key_hash text primary key,
  upload_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedback_evidence_upload_rate_limits_updated_at_idx
  on public.feedback_evidence_upload_rate_limits(updated_at);

alter table public.feedback_evidence_upload_rate_limits enable row level security;

create or replace function public.consume_feedback_evidence_upload_quota(
  p_key_hash text,
  p_window_seconds integer default 3600,
  p_max_uploads integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_seconds integer := greatest(60, least(coalesce(p_window_seconds, 3600), 86400));
  v_max_uploads integer := greatest(1, least(coalesce(p_max_uploads, 30), 1000));
  v_row public.feedback_evidence_upload_rate_limits%rowtype;
  v_retry_after integer := 0;
begin
  if nullif(trim(p_key_hash), '') is null then
    raise exception 'feedback evidence upload rate-limit key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(trim(p_key_hash), 0));

  select * into v_row
  from public.feedback_evidence_upload_rate_limits
  where key_hash = trim(p_key_hash)
  for update;

  if not found or v_row.window_started_at <= v_now - make_interval(secs => v_window_seconds) then
    insert into public.feedback_evidence_upload_rate_limits (
      key_hash,
      upload_count,
      window_started_at,
      updated_at
    )
    values (trim(p_key_hash), 1, v_now, v_now)
    on conflict (key_hash) do update
    set upload_count = 1,
        window_started_at = v_now,
        updated_at = v_now
    returning * into v_row;

    return jsonb_build_object(
      'allowed', true,
      'count', v_row.upload_count,
      'retryAfterSeconds', 0
    );
  end if;

  if v_row.upload_count >= v_max_uploads then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (
        v_row.window_started_at + make_interval(secs => v_window_seconds) - v_now
      )))::integer
    );
    return jsonb_build_object(
      'allowed', false,
      'count', v_row.upload_count,
      'retryAfterSeconds', v_retry_after
    );
  end if;

  update public.feedback_evidence_upload_rate_limits
  set upload_count = upload_count + 1,
      updated_at = v_now
  where key_hash = trim(p_key_hash)
  returning * into v_row;

  return jsonb_build_object(
    'allowed', true,
    'count', v_row.upload_count,
    'retryAfterSeconds', 0
  );
end;
$$;

revoke all on function public.consume_feedback_evidence_upload_quota(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_feedback_evidence_upload_quota(text, integer, integer) to service_role;

comment on table public.feedback_evidence_upload_rate_limits is
  'Persistent upload quotas shared across Workers isolates and PoPs. Keys are HMAC-derived and do not store raw user or network identifiers.';


create table if not exists public.admin_login_rate_limits (
  key_hash text primary key,
  failure_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists admin_login_rate_limits_updated_at_idx
  on public.admin_login_rate_limits(updated_at);

alter table public.admin_login_rate_limits enable row level security;

create or replace function public.read_admin_login_rate_limit(
  p_key_hash text,
  p_window_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.admin_login_rate_limits%rowtype;
begin
  if nullif(trim(p_key_hash), '') is null then
    raise exception 'admin login rate-limit key is required';
  end if;

  select * into v_row
  from public.admin_login_rate_limits
  where key_hash = trim(p_key_hash);

  if not found then
    return jsonb_build_object('retryAfterSeconds', 0, 'failureCount', 0);
  end if;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object(
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_row.locked_until - v_now)))::integer),
      'failureCount', v_row.failure_count
    );
  end if;

  if v_row.window_started_at < v_now - make_interval(secs => greatest(60, least(coalesce(p_window_seconds, 900), 86400))) then
    delete from public.admin_login_rate_limits where key_hash = trim(p_key_hash);
    return jsonb_build_object('retryAfterSeconds', 0, 'failureCount', 0);
  end if;

  return jsonb_build_object('retryAfterSeconds', 0, 'failureCount', v_row.failure_count);
end;
$$;

create or replace function public.record_admin_login_attempt(
  p_key_hash text,
  p_succeeded boolean,
  p_window_seconds integer default 900,
  p_max_failures integer default 8,
  p_lock_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_seconds integer := greatest(60, least(coalesce(p_window_seconds, 900), 86400));
  v_max_failures integer := greatest(2, least(coalesce(p_max_failures, 8), 100));
  v_lock_seconds integer := greatest(60, least(coalesce(p_lock_seconds, 900), 86400));
  v_row public.admin_login_rate_limits%rowtype;
begin
  if nullif(trim(p_key_hash), '') is null then
    raise exception 'admin login rate-limit key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(trim(p_key_hash), 0));

  if coalesce(p_succeeded, false) then
    delete from public.admin_login_rate_limits where key_hash = trim(p_key_hash);
    return jsonb_build_object('retryAfterSeconds', 0, 'failureCount', 0);
  end if;

  select * into v_row
  from public.admin_login_rate_limits
  where key_hash = trim(p_key_hash)
  for update;

  if not found or v_row.window_started_at < v_now - make_interval(secs => v_window_seconds) then
    insert into public.admin_login_rate_limits (key_hash, failure_count, window_started_at, locked_until, updated_at)
    values (trim(p_key_hash), 1, v_now, null, v_now)
    on conflict (key_hash) do update
    set failure_count = 1,
        window_started_at = v_now,
        locked_until = null,
        updated_at = v_now
    returning * into v_row;
  else
    update public.admin_login_rate_limits
    set failure_count = failure_count + 1,
        locked_until = case
          when failure_count + 1 >= v_max_failures then v_now + make_interval(secs => v_lock_seconds)
          else locked_until
        end,
        updated_at = v_now
    where key_hash = trim(p_key_hash)
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'retryAfterSeconds', case
      when v_row.locked_until is not null and v_row.locked_until > v_now
        then greatest(1, ceil(extract(epoch from (v_row.locked_until - v_now)))::integer)
      else 0
    end,
    'failureCount', v_row.failure_count
  );
end;
$$;

revoke all on function public.read_admin_login_rate_limit(text, integer) from public, anon, authenticated;
revoke all on function public.record_admin_login_attempt(text, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.read_admin_login_rate_limit(text, integer) to service_role;
grant execute on function public.record_admin_login_attempt(text, boolean, integer, integer, integer) to service_role;

comment on table public.admin_login_rate_limits is
  'Persistent, privacy-preserving rate-limit counters for administrator password login. Only HMAC-derived request keys are stored.';

alter table public.account_deletion_requests
  alter column user_id drop not null,
  add column if not exists subject_hash text,
  add column if not exists processing_started_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_error text;

create index if not exists account_deletion_requests_processing_lease_idx
  on public.account_deletion_requests(status, lease_expires_at)
  where status = 'processing';

create or replace function public.claim_due_account_deletion_request(
  p_worker text,
  p_lease_seconds integer default 900
)
returns table (
  id uuid,
  user_id uuid,
  user_email text,
  attempt_count integer,
  scheduled_for timestamptz,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_lease_until timestamptz := v_now + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 900), 3600)));
begin
  return query
  with candidate as (
    select request.id
    from public.account_deletion_requests request
    where request.user_id is not null
      and request.scheduled_for <= v_now
      and (
        request.status = 'pending'
        or (request.status = 'processing' and coalesce(request.lease_expires_at, request.processing_started_at, request.updated_at) <= v_now)
      )
    order by request.scheduled_for asc, request.requested_at asc
    for update skip locked
    limit 1
  )
  update public.account_deletion_requests request
  set status = 'processing',
      processing_started_at = v_now,
      lease_expires_at = v_lease_until,
      attempt_count = request.attempt_count + 1,
      last_error = null,
      resolution_note = concat('由 ', left(trim(coalesce(p_worker, 'account-deletion-worker')), 120), ' 处理'),
      updated_at = v_now
  from candidate
  where request.id = candidate.id
  returning request.id, request.user_id, request.user_email, request.attempt_count, request.scheduled_for, request.lease_expires_at;
end;
$$;

create or replace function public.purge_account_data(
  p_request_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_feedback integer := 0;
  v_followups integer := 0;
  v_evidence_metadata integer := 0;
  v_detector_jobs integer := 0;
  v_profiles integer := 0;
begin
  if p_request_id is null or p_user_id is null then
    raise exception 'account deletion request and user are required';
  end if;

  if not exists (
    select 1 from public.account_deletion_requests
    where id = p_request_id and user_id = p_user_id and status = 'processing'
  ) then
    raise exception 'account deletion request is not processing';
  end if;

  delete from public.feedback_followups where user_id = p_user_id;
  get diagnostics v_followups = row_count;

  delete from public.feedback_evidence_objects where user_id = p_user_id;
  get diagnostics v_evidence_metadata = row_count;

  update public.offer_feedback
  set user_id = null,
      user_email = null,
      user_display_name = null,
      contact = null,
      evidence_text = null,
      evidence_urls = '[]'::jsonb,
      notes = case when notes is null then null else '[账号删除后已清除用户补充说明]' end,
      public_status = case when public_status = 'public' then 'withdrawn' else public_status end,
      withdrawn_at = case when public_status = 'public' then now() else withdrawn_at end,
      withdraw_reason = case when public_status = 'public' then 'account_deleted' else withdraw_reason end
  where user_id = p_user_id;
  get diagnostics v_feedback = row_count;

  delete from public.transit_detector_jobs where user_id = p_user_id;
  get diagnostics v_detector_jobs = row_count;

  delete from public.public_user_profiles where id = p_user_id;
  get diagnostics v_profiles = row_count;

  return jsonb_build_object(
    'feedbackAnonymized', v_feedback,
    'followupsDeleted', v_followups,
    'evidenceMetadataDeleted', v_evidence_metadata,
    'detectorJobsDeleted', v_detector_jobs,
    'profilesDeleted', v_profiles
  );
end;
$$;

create or replace function public.complete_account_deletion_request(
  p_request_id uuid,
  p_user_id uuid,
  p_subject_hash text,
  p_resolution_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  update public.account_deletion_requests
  set status = 'completed',
      subject_hash = nullif(trim(p_subject_hash), ''),
      user_id = null,
      user_email = null,
      completed_at = now(),
      lease_expires_at = null,
      last_error = null,
      resolution_note = left(coalesce(nullif(trim(p_resolution_note), ''), '账号与关联数据已按隐私策略处理。'), 1000),
      updated_at = now()
  where id = p_request_id
    and user_id = p_user_id
    and status = 'processing';
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.retry_account_deletion_request(
  p_request_id uuid,
  p_user_id uuid,
  p_error text,
  p_retry_seconds integer default 3600
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  update public.account_deletion_requests
  set status = case when attempt_count >= 10 then 'rejected' else 'pending' end,
      scheduled_for = case
        when attempt_count >= 10 then scheduled_for
        else now() + make_interval(secs => greatest(300, least(coalesce(p_retry_seconds, 3600), 86400)))
      end,
      lease_expires_at = null,
      last_error = left(coalesce(nullif(trim(p_error), ''), '账号删除处理失败。'), 1000),
      resolution_note = case when attempt_count >= 10 then '自动处理多次失败，需要人工复核。' else resolution_note end,
      updated_at = now()
  where id = p_request_id
    and user_id = p_user_id
    and status = 'processing';
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.claim_due_account_deletion_request(text, integer) from public, anon, authenticated;
revoke all on function public.purge_account_data(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_account_deletion_request(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.retry_account_deletion_request(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_account_deletion_request(text, integer) to service_role;
grant execute on function public.purge_account_data(uuid, uuid) to service_role;
grant execute on function public.complete_account_deletion_request(uuid, uuid, text, text) to service_role;
grant execute on function public.retry_account_deletion_request(uuid, uuid, text, integer) to service_role;

comment on function public.claim_due_account_deletion_request(text, integer) is
  'Atomically claims one due account-deletion request with an expiring lease so repeated cron invocations remain idempotent.';
comment on function public.purge_account_data(uuid, uuid) is
  'Deletes private account records and anonymizes retained feedback after evidence objects have been removed from R2.';

create or replace function priceai_channel_submission_key(p_url text)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_url text := btrim(p_url);
  v_host text;
  v_path text;
  v_query text;
begin
  v_url := regexp_replace(v_url, '#.*$', '');
  v_host := lower((regexp_match(v_url, '^https?://(?:www\.)?([^/?#]+)', 'i'))[1]);
  if coalesce(v_host, '') = '' then return null; end if;
  v_path := coalesce((regexp_match(v_url, '^https?://[^/?#]+([^?#]*)', 'i'))[1], '');
  v_path := regexp_replace(v_path, '/+$', '');
  if v_path = '/' then v_path := ''; end if;
  if v_host = any (array['catfk.com', 'pay.ldxp.cn', 'ldxp.cn', 'pay.qxvx.cn']) and v_path ~* '^/shop/' then
    v_path := lower(v_path);
  end if;
  v_query := coalesce((regexp_match(v_url, '\?([^#]*)$'))[1], '');
  return v_host || v_path || case when v_query <> '' then '?' || v_query else '' end;
end;
$$;

create or replace function list_submission_price_benchmarks(p_product_ids text[])
returns table (product_id text, offer_count bigint, min_price numeric, top5_price numeric)
language sql
stable
security definer
set search_path = public
as $$
  with valid_offers as (
    select
      offers.canonical_product_id as product_id,
      offers.price,
      row_number() over (
        partition by offers.canonical_product_id
        order by offers.price asc, offers.verified_at desc nulls last, offers.id asc
      ) as price_rank
    from raw_offer_public_state offers
    where offers.canonical_product_id = any(coalesce(p_product_ids, '{}'::text[]))
      and offers.hidden = false
      and offers.status <> 'out_of_stock'
      and offers.price is not null
      and offers.price > 0
      and coalesce(offers.url, '') <> ''
      and coalesce(offers.effective_status, '') not in ('unavailable', 'stale', 'failed')
      and coalesce(offers.freshness_status, '') not in ('expired', 'failed')
      and (offers.expires_at is null or offers.expires_at > now())
  )
  select
    valid_offers.product_id,
    count(*) as offer_count,
    min(valid_offers.price) as min_price,
    max(valid_offers.price) filter (where valid_offers.price_rank <= 5) as top5_price
  from valid_offers
  group by valid_offers.product_id;
$$;

create or replace function finalize_channel_submission_approval(
  p_submission_id text,
  p_source_id text,
  p_parsed_meta jsonb,
  p_reviewed_at timestamptz,
  p_preclassification jsonb,
  p_classification_version text
)
returns setof channel_submissions
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from channel_submissions where id = p_submission_id and status = 'pending' for update
  ) then
    raise exception '提交记录不存在或已被处理。';
  end if;
  update sources set enabled = true, updated_at = p_reviewed_at where id = p_source_id;
  if not found then raise exception '待启用渠道不存在。'; end if;
  return query
  update channel_submissions
  set status = 'approved', review_stage = 'approved', approved_source_id = p_source_id,
      parsed_meta = coalesce(p_parsed_meta, '{}'::jsonb), reviewed_at = p_reviewed_at,
      preclassification_kind = nullif(p_preclassification->>'kind', ''),
      preclassification = coalesce(p_preclassification, '{}'::jsonb),
      classification_version = p_classification_version, classified_at = p_reviewed_at
  where id = p_submission_id and status = 'pending'
  returning *;
end;
$$;

revoke execute on function priceai_channel_submission_key(text) from anon, authenticated, public;
revoke execute on function list_submission_price_benchmarks(text[]) from anon, authenticated, public;
revoke execute on function finalize_channel_submission_approval(text, text, jsonb, timestamptz, jsonb, text) from anon, authenticated, public;
grant execute on function priceai_channel_submission_key(text) to service_role;
grant execute on function list_submission_price_benchmarks(text[]) to service_role;
grant execute on function finalize_channel_submission_approval(text, text, jsonb, timestamptz, jsonb, text) to service_role;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create table if not exists public_offer_read_model (
  public_dedupe_key text primary key,
  id text not null,
  source_id text,
  source_name text,
  source_store_name text,
  source_title text not null,
  price numeric,
  currency text,
  status text,
  url text,
  tags text[],
  stock_count integer,
  min_order_quantity integer,
  bulk_pricing_tiers jsonb not null default '[]'::jsonb,
  hidden boolean not null default false,
  canonical_product_id text,
  category_slug text,
  captured_at timestamptz,
  source_updated_at timestamptz,
  last_seen_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz,
  source_priority integer,
  confidence numeric,
  effective_status text,
  freshness_status text,
  last_failed_at timestamptz,
  failure_reason text,
  product_id text not null,
  product_slug text not null,
  product_display_name text not null,
  product_platform text not null,
  product_type text not null,
  product_spec text,
  product_summary text,
  product_updated_at timestamptz,
  is_public_available boolean not null,
  shared_access_rank integer not null default 0,
  public_updated_at timestamptz,
  public_source_label text not null default '',
  public_haystack text not null default '',
  refresh_generation text not null,
  refreshed_at timestamptz not null
);

create index if not exists public_offer_read_model_product_idx
  on public_offer_read_model(product_id);
create index if not exists public_offer_read_model_platform_type_idx
  on public_offer_read_model(product_platform, product_type);
create index if not exists public_offer_read_model_availability_price_idx
  on public_offer_read_model(is_public_available, price, public_updated_at desc);
create index if not exists public_offer_read_model_updated_idx
  on public_offer_read_model(public_updated_at desc);
create index if not exists public_offer_read_model_source_idx
  on public_offer_read_model(public_source_label, public_updated_at desc);
create index if not exists public_offer_read_model_haystack_trgm_idx
  on public_offer_read_model using gin(public_haystack extensions.gin_trgm_ops);

alter table public_offer_read_model enable row level security;
revoke all on table public_offer_read_model from anon, authenticated, public;
grant select on table public_offer_read_model to service_role;

create or replace function refresh_public_offer_read_model()
returns table (
  row_count bigint,
  generated_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_generated_at timestamptz := clock_timestamp();
  v_generation text := md5(txid_current()::text || ':' || clock_timestamp()::text || ':' || random()::text);
  v_row_count bigint := 0;
begin
  with base as (
    select
      raw_offers.*,
      canonical_products.id as product_id,
      canonical_products.slug as product_slug,
      canonical_products.display_name as product_display_name,
      canonical_products.platform as product_platform,
      canonical_products.product_type,
      canonical_products.spec as product_spec,
      canonical_products.summary as product_summary,
      canonical_products.updated_at as product_updated_at,
      case
        when raw_offers.status <> 'out_of_stock'
          and raw_offers.price is not null
          and raw_offers.url <> ''
          and coalesce(raw_offers.effective_status, '') not in ('unavailable', 'stale', 'failed')
          and coalesce(raw_offers.freshness_status, '') not in ('expired', 'failed')
          and (raw_offers.expires_at is null or raw_offers.expires_at > now())
        then true
        else false
      end as is_public_available,
      case
        when coalesce(
          raw_offers.public_filter_tags,
          priceai_public_offer_filter_tags(raw_offers.source_title, raw_offers.tags),
          '{}'::text[]
        ) && array['shared_access', 'web_only_account', 'domestic_mirror_site']::text[]
        then 1
        else 0
      end as shared_access_rank,
      coalesce(
        raw_offers.verified_at,
        raw_offers.last_seen_at,
        raw_offers.captured_at,
        raw_offers.source_updated_at
      ) as public_updated_at,
      coalesce(raw_offers.source_store_name, raw_offers.source_name, '') as public_source_label,
      priceai_public_offer_dedupe_key(
        raw_offers.canonical_product_id,
        raw_offers.url,
        raw_offers.source_title,
        raw_offers.price
      ) as public_dedupe_key,
      lower(concat_ws(
        ' ',
        raw_offers.source_title,
        raw_offers.source_name,
        raw_offers.source_store_name,
        raw_offers.url,
        substring(raw_offers.url from '/item/([^/?#]+)'),
        substring(raw_offers.url from '[?&]commodity=([^&#]+)'),
        substring(raw_offers.url from '[?&]id=([^&#]+)'),
        canonical_products.display_name,
        canonical_products.platform,
        canonical_products.product_type,
        canonical_products.spec
      )) as public_haystack
    from raw_offer_public_state raw_offers
    join canonical_products on canonical_products.id = raw_offers.canonical_product_id
    where raw_offers.hidden = false
      and canonical_products.is_active = true
  ),
  ranked as (
    select
      base.*,
      row_number() over (
        partition by base.public_dedupe_key
        order by
          case when base.is_public_available then 0 else 1 end asc,
          base.shared_access_rank asc,
          base.source_priority desc nulls last,
          base.confidence desc nulls last,
          base.public_updated_at desc nulls last,
          base.public_source_label asc,
          base.source_title asc,
          base.url asc,
          base.id asc
      ) as dedupe_rank
    from base
  )
  insert into public_offer_read_model (
    public_dedupe_key, id, source_id, source_name, source_store_name, source_title,
    price, currency, status, url, tags, stock_count, min_order_quantity,
    bulk_pricing_tiers, hidden, canonical_product_id, category_slug, captured_at,
    source_updated_at, last_seen_at, verified_at, expires_at, source_priority,
    confidence, effective_status, freshness_status, last_failed_at, failure_reason,
    product_id, product_slug, product_display_name, product_platform, product_type,
    product_spec, product_summary, product_updated_at, is_public_available,
    shared_access_rank, public_updated_at, public_source_label, public_haystack,
    refresh_generation, refreshed_at
  )
  select
    ranked.public_dedupe_key, ranked.id, ranked.source_id, ranked.source_name,
    ranked.source_store_name, ranked.source_title, ranked.price, ranked.currency,
    ranked.status, ranked.url, ranked.tags, ranked.stock_count,
    ranked.min_order_quantity, coalesce(ranked.bulk_pricing_tiers, '[]'::jsonb),
    ranked.hidden, ranked.canonical_product_id, ranked.category_slug,
    ranked.captured_at, ranked.source_updated_at, ranked.last_seen_at,
    ranked.verified_at, ranked.expires_at, ranked.source_priority, ranked.confidence,
    ranked.effective_status, ranked.freshness_status, ranked.last_failed_at,
    ranked.failure_reason, ranked.product_id, ranked.product_slug,
    ranked.product_display_name, ranked.product_platform, ranked.product_type,
    ranked.product_spec, ranked.product_summary, ranked.product_updated_at,
    ranked.is_public_available, ranked.shared_access_rank, ranked.public_updated_at,
    ranked.public_source_label, ranked.public_haystack, v_generation, v_generated_at
  from ranked
  where ranked.dedupe_rank = 1
  on conflict (public_dedupe_key) do update set
    id = excluded.id,
    source_id = excluded.source_id,
    source_name = excluded.source_name,
    source_store_name = excluded.source_store_name,
    source_title = excluded.source_title,
    price = excluded.price,
    currency = excluded.currency,
    status = excluded.status,
    url = excluded.url,
    tags = excluded.tags,
    stock_count = excluded.stock_count,
    min_order_quantity = excluded.min_order_quantity,
    bulk_pricing_tiers = excluded.bulk_pricing_tiers,
    hidden = excluded.hidden,
    canonical_product_id = excluded.canonical_product_id,
    category_slug = excluded.category_slug,
    captured_at = excluded.captured_at,
    source_updated_at = excluded.source_updated_at,
    last_seen_at = excluded.last_seen_at,
    verified_at = excluded.verified_at,
    expires_at = excluded.expires_at,
    source_priority = excluded.source_priority,
    confidence = excluded.confidence,
    effective_status = excluded.effective_status,
    freshness_status = excluded.freshness_status,
    last_failed_at = excluded.last_failed_at,
    failure_reason = excluded.failure_reason,
    product_id = excluded.product_id,
    product_slug = excluded.product_slug,
    product_display_name = excluded.product_display_name,
    product_platform = excluded.product_platform,
    product_type = excluded.product_type,
    product_spec = excluded.product_spec,
    product_summary = excluded.product_summary,
    product_updated_at = excluded.product_updated_at,
    is_public_available = excluded.is_public_available,
    shared_access_rank = excluded.shared_access_rank,
    public_updated_at = excluded.public_updated_at,
    public_source_label = excluded.public_source_label,
    public_haystack = excluded.public_haystack,
    refresh_generation = excluded.refresh_generation,
    refreshed_at = excluded.refreshed_at;

  select count(*)::bigint
  into v_row_count
  from public_offer_read_model
  where refresh_generation = v_generation;

  if v_row_count = 0 and exists (
    select 1
    from public_offer_read_model
    where refresh_generation <> v_generation
  ) then
    raise exception 'public offer read model refresh produced zero rows; preserving the previous generation';
  end if;

  delete from public_offer_read_model where refresh_generation <> v_generation;

  return query
  select v_row_count, v_generated_at;
end;
$$;

create or replace function list_public_offers_page_v2(
  p_query text default null,
  p_platform text default null,
  p_product_type text default null,
  p_stock text default null,
  p_sort text default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_limit integer default 80,
  p_offset integer default 0
)
returns table (
  id text,
  source_id text,
  source_name text,
  source_store_name text,
  source_title text,
  price numeric,
  currency text,
  status text,
  url text,
  tags text[],
  stock_count integer,
  min_order_quantity integer,
  bulk_pricing_tiers jsonb,
  hidden boolean,
  canonical_product_id text,
  category_slug text,
  captured_at timestamptz,
  source_updated_at timestamptz,
  last_seen_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz,
  source_priority integer,
  confidence numeric,
  effective_status text,
  freshness_status text,
  last_failed_at timestamptz,
  failure_reason text,
  product_id text,
  product_slug text,
  product_display_name text,
  product_platform text,
  product_type text,
  product_spec text,
  product_summary text,
  product_updated_at timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with matched as (
    select
      public_offer_read_model.*,
      count(*) over() as total_count
    from public_offer_read_model
    where (p_query is null or trim(p_query) = '' or public_offer_read_model.public_haystack like ('%' || lower(trim(p_query)) || '%'))
      and (p_platform is null or p_platform = '' or p_platform = '全部' or public_offer_read_model.product_platform = p_platform)
      and (p_product_type is null or p_product_type = '' or p_product_type = '全部' or public_offer_read_model.product_type = p_product_type)
      and (p_min_price is null or public_offer_read_model.price >= p_min_price)
      and (p_max_price is null or public_offer_read_model.price <= p_max_price)
      and (p_stock is null or p_stock = '' or p_stock = 'all'
        or (p_stock = 'available' and public_offer_read_model.is_public_available = true)
        or (p_stock = 'out_of_stock' and public_offer_read_model.is_public_available = false))
  )
  select
    matched.id,
    matched.source_id,
    matched.source_name,
    matched.source_store_name,
    matched.source_title,
    matched.price,
    matched.currency,
    matched.status,
    matched.url,
    matched.tags,
    matched.stock_count,
    matched.min_order_quantity,
    matched.bulk_pricing_tiers,
    matched.hidden,
    matched.canonical_product_id,
    matched.category_slug,
    matched.captured_at,
    matched.source_updated_at,
    matched.last_seen_at,
    matched.verified_at,
    matched.expires_at,
    matched.source_priority,
    matched.confidence,
    matched.effective_status,
    matched.freshness_status,
    matched.last_failed_at,
    matched.failure_reason,
    matched.product_id,
    matched.product_slug,
    matched.product_display_name,
    matched.product_platform,
    matched.product_type,
    matched.product_spec,
    matched.product_summary,
    matched.product_updated_at,
    matched.total_count
  from matched
  order by
    case matched.product_platform
      when 'ChatGPT' then 1
      when 'Claude' then 2
      when 'Gemini' then 3
      when 'Grok' then 4
      when 'Google' then 5
      when 'API/CDK' then 6
      when '邮箱' then 7
      when '接码' then 8
      when '其他' then 99
      else 50
    end asc,
    case when p_sort = 'updated' then null else case when matched.is_public_available then 0 else 1 end end asc nulls last,
    case when p_sort = 'updated' then matched.public_updated_at end desc nulls last,
    case when p_sort = 'channels' then matched.public_source_label end asc nulls last,
    case when p_sort = 'updated' or p_sort = 'channels' then null else case when matched.is_public_available then matched.shared_access_rank else 0 end end asc nulls last,
    case when p_sort = 'price' or p_sort is null or p_sort = '' or p_sort = 'available_price' then matched.price end asc nulls last,
    matched.public_updated_at desc nulls last,
    matched.public_source_label asc,
    matched.source_title asc,
    matched.url asc,
    matched.id asc
  limit greatest(least(coalesce(p_limit, 80), 1200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke execute on function refresh_public_offer_read_model() from anon, authenticated, public;
revoke execute on function list_public_offers_page_v2(text, text, text, text, text, numeric, numeric, integer, integer) from anon, authenticated, public;
grant execute on function refresh_public_offer_read_model() to service_role;
grant execute on function list_public_offers_page_v2(text, text, text, text, text, numeric, numeric, integer, integer) to service_role;

comment on table public_offer_read_model is
  'Precomputed, deduplicated public offer read model. Rebuilt by the protected snapshot refresh path; public requests must not rebuild it.';
comment on function refresh_public_offer_read_model() is
  'Atomically rebuilds the deduplicated public offer read model and removes rows from older generations.';
comment on function list_public_offers_page_v2(text, text, text, text, text, numeric, numeric, integer, integer) is
  'Lists public offers from the precomputed read model without scanning and deduplicating raw offer state per request.';
