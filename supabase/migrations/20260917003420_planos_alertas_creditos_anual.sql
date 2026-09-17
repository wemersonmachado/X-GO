-- Política comercial controlada pelo superadmin, planos anuais, trial e
-- créditos pré-pagos. Todas as tabelas são server-only: nenhum catálogo de
-- preço ou saldo fica exposto à anon key.

alter table public.platform_billing_plans
  add column if not exists annual_discount_percent integer not null default 0
    check (annual_discount_percent between 0 and 40),
  add column if not exists trial_days integer not null default 0
    check (trial_days between 0 and 30);

-- Migra apenas os valores-padrão antigos. Preços já personalizados pelo
-- superadmin são preservados.
update public.platform_billing_addons set price_cents=2999, revision=revision+1, updated_at=now()
 where slug='extra_user' and price_cents=3900;
update public.platform_billing_addons set price_cents=5900, revision=revision+1, updated_at=now()
 where slug='extra_whatsapp' and price_cents=9900;
update public.platform_billing_addons set price_cents=2900, revision=revision+1, updated_at=now()
 where slug='extra_active_agent' and price_cents=7900;
update public.platform_billing_addons set price_cents=1999, revision=revision+1, updated_at=now()
 where slug='extra_conversations_1000' and price_cents=4900;

create table if not exists public.platform_billing_policy (
  id smallint primary key default 1 check (id=1),
  usage_alert_percent integer not null default 80 check (usage_alert_percent between 50 and 99),
  hard_limit_percent integer not null default 100 check (hard_limit_percent between 100 and 200),
  overage_unit_price_cents integer not null default 0 check (overage_unit_price_cents>=0),
  outcome_billing_enabled boolean not null default false,
  outcome_price_cents integer not null default 0 check (outcome_price_cents>=0),
  meta_fees_notice text not null default 'Tarifas da Meta/WhatsApp não estão incluídas e são cobradas conforme a categoria e o país da conversa.',
  updated_at timestamptz not null default now()
);
insert into public.platform_billing_policy(id) values(1) on conflict(id) do nothing;

create table if not exists public.platform_billing_credit_packs (
  slug text primary key check(slug in('ai_credits_5000','ai_credits_10000','ai_credits_25000')),
  name text not null check(char_length(name) between 1 and 100),
  credits integer not null check(credits>0),
  price_cents integer not null check(price_cents>0),
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.platform_billing_credit_packs(slug,name,credits,price_cents) values
 ('ai_credits_5000','5.000 respostas de IA',5000,9995),
 ('ai_credits_10000','10.000 respostas de IA',10000,19990),
 ('ai_credits_25000','25.000 respostas de IA',25000,49975)
on conflict(slug) do nothing;

create table if not exists public.organization_ai_credit_balances (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  available_credits integer not null default 0 check(available_credits>=0),
  updated_at timestamptz not null default now()
);
create table if not exists public.organization_ai_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  delta integer not null check(delta<>0),
  reason text not null check(reason in('purchase','usage','adjustment','refund')),
  provider_payment_id text,
  checkout_intent_id uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists organization_ai_credit_purchase_once
  on public.organization_ai_credit_ledger(provider_payment_id)
  where reason='purchase' and provider_payment_id is not null;

create table if not exists public.organization_billing_preferences (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  limit_action text not null default 'block' check(limit_action in('block','credits','overage')),
  alerts_enabled boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create table if not exists public.organization_usage_overages (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_start date not null,
  resource text not null check(resource='monthly_conversations'),
  units integer not null default 0 check(units>=0),
  unit_price_per_1000_cents integer not null check(unit_price_per_1000_cents>0),
  status text not null default 'pending' check(status in('pending','invoiced','waived')),
  updated_at timestamptz not null default now(),
  primary key(organization_id,period_start,resource)
);

alter table public.platform_billing_policy enable row level security;
alter table public.platform_billing_credit_packs enable row level security;
alter table public.organization_ai_credit_balances enable row level security;
alter table public.organization_ai_credit_ledger enable row level security;
alter table public.organization_billing_preferences enable row level security;
alter table public.organization_usage_overages enable row level security;
revoke all on public.platform_billing_policy,public.platform_billing_credit_packs,
  public.organization_ai_credit_balances,public.organization_ai_credit_ledger,
  public.organization_billing_preferences,public.organization_usage_overages
  from public,anon,authenticated;
grant select,insert,update,delete on public.platform_billing_policy,public.platform_billing_credit_packs,
  public.organization_ai_credit_balances,public.organization_ai_credit_ledger,
  public.organization_billing_preferences,public.organization_usage_overages to service_role;

alter table public.platform_checkout_intents
  add column if not exists billing_interval text not null default 'month'
    check(billing_interval in('month','year')),
  add column if not exists trial_days integer not null default 0 check(trial_days between 0 and 30),
  add column if not exists credit_pack_slug text references public.platform_billing_credit_packs(slug);
alter table public.platform_checkout_intents alter column plan_slug drop not null;
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.platform_checkout_intents'::regclass and contype='c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.platform_checkout_intents drop constraint %I',c.conname);
  end loop;
end $$;
alter table public.platform_checkout_intents add constraint platform_checkout_intents_kind_check
  check(kind in('new_org','addon','credit_pack'));

alter table public.organization_subscriptions
  add column if not exists billing_interval text not null default 'month'
    check(billing_interval in('month','year')),
  add column if not exists trial_ends_at timestamptz;

create or replace function public.fn_plan_entitlements(p_org uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_plan text;v_limits jsonb;v_features jsonb;v_extra jsonb;v_credits int;
begin
  select e.plan_slug into v_plan from public.organization_plan_entitlements e where e.organization_id=p_org and e.status='active';
  if v_plan is null then select coalesce(nullif(settings->>'plan',''),'standard') into v_plan from public.organizations where id=p_org;end if;
  select limits,features into v_limits,v_features from public.platform_billing_plans where slug=coalesce(v_plan,'standard');
  if v_limits is null then v_limits:='{"users":0,"whatsapp":0,"active_agents":0,"monthly_conversations":0,"mcp":false}'::jsonb;end if;
  select coalesce(jsonb_object_agg(resource,units),'{}'::jsonb) into v_extra from(
    select a.resource,sum(s.quantity*s.units_snapshot)::integer units from public.organization_addon_subscriptions s
    join public.platform_billing_addons a on a.slug=s.addon_slug where s.organization_id=p_org and s.status='active' group by a.resource)q;
  select coalesce(available_credits,0) into v_credits from public.organization_ai_credit_balances where organization_id=p_org;
  return jsonb_build_object('plan_slug',coalesce(v_plan,'standard'),'capabilities',coalesce(v_features->'capabilities','[]'::jsonb),'prepaid_ai_credits',coalesce(v_credits,0),'limits',jsonb_build_object(
    'users',coalesce((v_limits->>'users')::int,0)+coalesce((v_extra->>'users')::int,0),
    'whatsapp',coalesce((v_limits->>'whatsapp')::int,0)+coalesce((v_extra->>'whatsapp')::int,0),
    'active_agents',coalesce((v_limits->>'active_agents')::int,0)+coalesce((v_extra->>'active_agents')::int,0),
    'monthly_conversations',coalesce((v_limits->>'monthly_conversations')::int,0)+coalesce((v_extra->>'monthly_conversations')::int,0),
    'mcp',coalesce((v_limits->>'mcp')::boolean,false)));
end;$$;
revoke all on function public.fn_plan_entitlements(uuid) from public,anon,authenticated;
grant execute on function public.fn_plan_entitlements(uuid) to service_role;

create or replace function public.fn_assert_plan_capacity(p_org uuid,p_resource text,p_conversation uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare v_limit int;v_used int;v_action text;v_credits int;v_hard int;v_overage_price int;
begin
  perform 1 from public.organizations where id=p_org for update;
  if not found then raise exception 'plan_organization_not_found' using errcode='P0001';end if;
  select coalesce((public.fn_plan_entitlements(p_org)->'limits'->>p_resource)::int,0) into v_limit;
  if v_limit<=0 then raise exception 'plan_%_not_included',p_resource using errcode='P0001';end if;
  if p_resource='users' then select count(*) into v_used from public.user_organizations where organization_id=p_org and accepted_at is not null and revoked_at is null;
  elsif p_resource='whatsapp' then select count(*) into v_used from public.channel_sessions where organization_id=p_org and archived_at is null;
  elsif p_resource='active_agents' then select count(*) into v_used from public.ai_agents where organization_id=p_org and published_version_id is not null and archived_at is null and is_active and paused_at is null;
  elsif p_resource='monthly_conversations' then select count(*) into v_used from public.llm_calls where organization_id=p_org and purpose='agent_turn' and created_at>=date_trunc('month',now());
  else raise exception 'plan_resource_unknown' using errcode='P0001';end if;
  if v_used<v_limit then return;end if;
  if p_resource<>'monthly_conversations' then raise exception 'plan_%_limit_exceeded',p_resource using errcode='P0001';end if;
  select coalesce(p.limit_action,'block'),coalesce(b.available_credits,0) into v_action,v_credits
    from (select p_org organization_id)x left join public.organization_billing_preferences p using(organization_id)
    left join public.organization_ai_credit_balances b using(organization_id);
  if v_action='credits' and v_credits>0 then
    update public.organization_ai_credit_balances set available_credits=available_credits-1,updated_at=now() where organization_id=p_org and available_credits>0;
    insert into public.organization_ai_credit_ledger(organization_id,delta,reason) values(p_org,-1,'usage');return;
  end if;
  select hard_limit_percent,overage_unit_price_cents into v_hard,v_overage_price from public.platform_billing_policy where id=1;
  if v_action='overage' and v_overage_price>0 and v_used < floor(v_limit*coalesce(v_hard,100)/100.0) then
    insert into public.organization_usage_overages(organization_id,period_start,resource,units,unit_price_per_1000_cents)
    values(p_org,date_trunc('month',now())::date,p_resource,1,v_overage_price)
    on conflict(organization_id,period_start,resource) do update set units=public.organization_usage_overages.units+1,updated_at=now();return;
  end if;
  raise exception 'plan_%_limit_exceeded',p_resource using errcode='P0001';
end;$$;
revoke all on function public.fn_assert_plan_capacity(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_assert_plan_capacity(uuid,text,uuid) to service_role;

create or replace function public.fn_plan_usage(p_org uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin return jsonb_build_object(
 'users',(select count(*) from public.user_organizations where organization_id=p_org and accepted_at is not null and revoked_at is null),
 'whatsapp',(select count(*) from public.channel_sessions where organization_id=p_org and archived_at is null),
 'active_agents',(select count(*) from public.ai_agents where organization_id=p_org and published_version_id is not null and archived_at is null and is_active and paused_at is null),
 'monthly_conversations',(select count(*) from public.llm_calls where organization_id=p_org and purpose='agent_turn' and created_at>=date_trunc('month',now())),
 'ai_tokens',(select coalesce(sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) from public.llm_calls where organization_id=p_org and purpose='agent_turn' and created_at>=date_trunc('month',now())),
 'prepaid_ai_credits',(select coalesce(available_credits,0) from public.organization_ai_credit_balances where organization_id=p_org),
 'overage_responses',(select coalesce(units,0) from public.organization_usage_overages where organization_id=p_org and period_start=date_trunc('month',now())::date and resource='monthly_conversations'));
end;$$;
revoke all on function public.fn_plan_usage(uuid) from public,anon,authenticated;
grant execute on function public.fn_plan_usage(uuid) to service_role;

create or replace function public.fn_apply_paid_stripe_credit_pack(
 p_checkout_session_id text,p_payment_id text,p_checkout_intent_id uuid,p_value_cents integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_intent public.platform_checkout_intents%rowtype;v_pack public.platform_billing_credit_packs%rowtype;
begin
 select * into v_intent from public.platform_checkout_intents where id=p_checkout_intent_id and stripe_session_id=p_checkout_session_id for update;
 if not found or v_intent.kind<>'credit_pack' or v_intent.organization_id is null or v_intent.credit_pack_slug is null then return jsonb_build_object('eligible',false,'reason','unknown_credit_intent');end if;
 select * into v_pack from public.platform_billing_credit_packs where slug=v_intent.credit_pack_slug;
 if not found or v_intent.price_cents<>p_value_cents or v_pack.price_cents<>v_intent.price_cents then return jsonb_build_object('eligible',false,'reason','credit_snapshot_mismatch');end if;
 insert into public.organization_ai_credit_ledger(organization_id,delta,reason,provider_payment_id,checkout_intent_id)
 values(v_intent.organization_id,v_pack.credits,'purchase',p_payment_id,v_intent.id) on conflict(provider_payment_id) where reason='purchase' and provider_payment_id is not null do nothing;
 if found then insert into public.organization_ai_credit_balances(organization_id,available_credits) values(v_intent.organization_id,v_pack.credits)
   on conflict(organization_id) do update set available_credits=public.organization_ai_credit_balances.available_credits+excluded.available_credits,updated_at=now();end if;
 update public.platform_checkout_intents set status='paid',last_error=null,updated_at=now() where id=v_intent.id;
 return jsonb_build_object('eligible',true,'organization_id',v_intent.organization_id,'credits',v_pack.credits);
end;$$;
revoke all on function public.fn_apply_paid_stripe_credit_pack(text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.fn_apply_paid_stripe_credit_pack(text,text,uuid,integer) to service_role;

-- A cesta continua validando cada snapshot do servidor. Em trial a Stripe
-- confirma a criação com total zero; o valor recorrente congelado permanece
-- na intenção e passa a valer no fim do período gratuito.
create or replace function public.fn_apply_paid_stripe_plan_bundle(
 p_checkout_session_id text,p_payment_id text,p_subscription_id text,p_customer_id text,
 p_checkout_intent_id uuid,p_plan_slug text,p_total_value_cents integer,p_customer_name text,p_email_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_intent public.platform_checkout_intents%rowtype;v_expected int;v_receipt jsonb;v_org uuid;v_trial boolean;
begin
 select * into v_intent from public.platform_checkout_intents where id=p_checkout_intent_id and stripe_session_id=p_checkout_session_id for update;
 if not found or v_intent.kind<>'new_org' or v_intent.plan_slug<>p_plan_slug then return jsonb_build_object('eligible',false,'reason','unknown_plan_bundle');end if;
 select v_intent.price_cents+coalesce(sum((item->>'price_cents')::int*(item->>'quantity')::int),0) into v_expected from jsonb_array_elements(v_intent.addons_snapshot)item;
 v_trial:=v_intent.trial_days>0 and p_total_value_cents=0;
 if v_expected<>v_intent.total_price_cents or (not v_trial and v_expected<>p_total_value_cents) then return jsonb_build_object('eligible',false,'reason','checkout_snapshot_mismatch');end if;
 select public.fn_provision_paid_checkout('stripe',p_checkout_session_id,p_payment_id,p_subscription_id,p_customer_id,p_checkout_intent_id,p_plan_slug,v_intent.price_cents,p_customer_name,p_email_hash) into v_receipt;
 if coalesce((v_receipt->>'eligible')::boolean,false)is not true then return v_receipt;end if;
 v_org:=(v_receipt->>'organization_id')::uuid;
 update public.organization_subscriptions set billing_interval=v_intent.billing_interval,
   status=case when v_trial then 'trialing' else 'active' end,
   trial_ends_at=case when v_trial then now()+make_interval(days=>v_intent.trial_days) else null end,
   updated_at=now() where organization_id=v_org;
 insert into public.organization_addon_subscriptions(organization_id,addon_slug,provider,provider_subscription_id,provider_payment_id,quantity,units_snapshot,price_cents_snapshot,status)
 select v_org,item->>'slug','stripe',p_subscription_id,p_payment_id,(item->>'quantity')::int,(item->>'units')::int,(item->>'price_cents')::int,'active'
 from jsonb_array_elements(v_intent.addons_snapshot)item where(item->>'quantity')::int>0
 on conflict(organization_id,provider_subscription_id,addon_slug)do update set provider_payment_id=excluded.provider_payment_id,quantity=excluded.quantity,units_snapshot=excluded.units_snapshot,price_cents_snapshot=excluded.price_cents_snapshot,status='active',updated_at=now();
 return v_receipt||jsonb_build_object('bundle_total_cents',v_expected,'trialing',v_trial,'billing_interval',v_intent.billing_interval);
end;$$;
revoke all on function public.fn_apply_paid_stripe_plan_bundle(text,text,text,text,uuid,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.fn_apply_paid_stripe_plan_bundle(text,text,text,text,uuid,text,integer,text,text) to service_role;

notify pgrst,'reload schema';
