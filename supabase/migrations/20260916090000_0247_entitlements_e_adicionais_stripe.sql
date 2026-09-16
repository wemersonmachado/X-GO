-- Cotas comerciais e adicionais Stripe. A regra final fica no banco para
-- cobrir UI, MCP, onboarding e integrações que usam service role.

alter table public.platform_billing_plans
  add column if not exists limits jsonb not null default '{"users":3,"whatsapp":3,"active_agents":3,"monthly_conversations":3000,"mcp":true}'::jsonb,
  add column if not exists features jsonb not null default '{}'::jsonb,
  add column if not exists revision bigint not null default 1;

update public.platform_billing_plans set limits = case slug
  when 'standard' then '{"users":3,"whatsapp":3,"active_agents":3,"monthly_conversations":3000,"mcp":true}'::jsonb
  when 'pro' then '{"users":10,"whatsapp":10,"active_agents":10,"monthly_conversations":15000,"mcp":true}'::jsonb
  when 'enterprise' then '{"users":20,"whatsapp":20,"active_agents":25,"monthly_conversations":50000,"mcp":true,"priority_support":true,"customization":true}'::jsonb
  else limits end;

create table if not exists public.organization_plan_entitlements (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plan_slug text not null references public.platform_billing_plans(slug),
  source text not null check (source in ('manual','stripe')),
  status text not null default 'active' check (status in ('active','past_due','canceled','suspended')),
  effective_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.organization_plan_entitlements enable row level security;
revoke all on public.organization_plan_entitlements from public, anon, authenticated;
grant select, insert, update, delete on public.organization_plan_entitlements to service_role;

insert into public.organization_plan_entitlements(organization_id, plan_slug, source, status)
select o.id, coalesce(s.plan_slug, nullif(o.settings->>'plan',''), 'standard'),
  case when s.organization_id is null then 'manual' else 'stripe' end,
  case when coalesce(s.status,'active') in ('active','trialing') then 'active' else 'suspended' end
from public.organizations o
left join public.organization_subscriptions s on s.organization_id=o.id
where coalesce(s.plan_slug, nullif(o.settings->>'plan',''), 'standard') in ('standard','pro','enterprise')
on conflict (organization_id) do nothing;

create or replace function public.fn_sync_plan_entitlement_from_subscription() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_plan_entitlements(organization_id,plan_slug,source,status,effective_at,updated_at)
  values(new.organization_id,new.plan_slug,case when new.provider='stripe' then 'stripe' else 'manual' end,
    case when new.status in ('active','trialing') then 'active' else 'suspended' end,now(),now())
  on conflict(organization_id) do update set plan_slug=excluded.plan_slug,source=excluded.source,status=excluded.status,updated_at=now();
  return new;
end; $$;
revoke all on function public.fn_sync_plan_entitlement_from_subscription() from public,anon,authenticated;
drop trigger if exists trg_sync_plan_entitlement_from_subscription on public.organization_subscriptions;
create trigger trg_sync_plan_entitlement_from_subscription after insert or update of plan_slug,status on public.organization_subscriptions for each row execute function public.fn_sync_plan_entitlement_from_subscription();

-- A criação manual pela plataforma também inicia na fonte única de cotas.
-- Sem isto, uma edição posterior do plano ficaria apenas no JSON histórico.
create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare prior public.idempotency_keys%rowtype; org public.organizations%rowtype; result jsonb;
  interface_default jsonb := coalesce(p_request->'owner_interface_settings','{"preset":"completa"}'::jsonb);
begin
  if not exists(select 1 from public.platform_admins where user_id=p_actor and revoked_at is null and scope='full') then raise exception 'platform_admin_required' using errcode='42501'; end if;
  if jsonb_typeof(interface_default)<>'object' or interface_default->>'preset' not in('completa','simplificada') then raise exception 'invalid_interface_settings' using errcode='22023'; end if;
  if p_request->>'plan' not in('standard','pro','enterprise') then raise exception 'invalid_plan' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_key::text,0));
  select * into prior from public.idempotency_keys where key=p_key::text and endpoint='/api/v1/admin/tenants:'||p_actor::text and expires_at>now() and tenant_creation_trusted;
  if found then
    if prior.request_hash<>decode(p_hash,'hex') then raise exception 'idempotency_conflict' using errcode='22023'; end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text or not exists(select 1 from public.organizations where id=prior.organization_id and created_by=p_actor) then raise exception 'idempotency_provenance_invalid' using errcode='22023'; end if;
    return prior.response_body||jsonb_build_object('created',false);
  end if;
  insert into public.organizations(display_name,slug,legal_name,cnpj,status,settings,created_by) values(p_request->>'display_name',p_request->>'slug',coalesce(nullif(p_request->>'legal_name',''),p_request->>'display_name'),p_request->>'cnpj','active',jsonb_build_object('plan',p_request->>'plan','interface_default',interface_default),p_actor) returning * into org;
  insert into public.organization_plan_entitlements(organization_id,plan_slug,source,status,updated_by) values(org.id,p_request->>'plan','manual','active',p_actor);
  insert into public.user_organizations(organization_id,user_id,role,accepted_at,interface_settings) values(org.id,p_actor,'admin',now(),interface_default);
  result:=jsonb_build_object('id',org.id,'slug',org.slug,'display_name',org.display_name,'invite_id',gen_random_uuid(),'issued_at',floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id,key,endpoint,request_hash,status_code,response_body,tenant_creation_trusted) values(org.id,p_key::text,'/api/v1/admin/tenants:'||p_actor::text,decode(p_hash,'hex'),201,result,true);
  return result||jsonb_build_object('created',true);
end; $$;
revoke all on function public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text) to service_role;

create table if not exists public.platform_billing_addons (
  slug text primary key check (slug in ('extra_user','extra_whatsapp','extra_active_agent','extra_conversations_1000')),
  name text not null check (char_length(name) between 1 and 100),
  resource text not null check (resource in ('users','whatsapp','active_agents','monthly_conversations')),
  units integer not null check (units > 0),
  price_cents integer not null check (price_cents > 0),
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.platform_billing_addons enable row level security;
revoke all on public.platform_billing_addons from public, anon, authenticated;
grant select, insert, update, delete on public.platform_billing_addons to service_role;
insert into public.platform_billing_addons(slug,name,resource,units,price_cents) values
 ('extra_user','Usuário adicional','users',1,3900),
 ('extra_whatsapp','WhatsApp adicional','whatsapp',1,9900),
 ('extra_active_agent','Agente ativo adicional','active_agents',1,7900),
 ('extra_conversations_1000','Mais 1.000 conversas automatizadas','monthly_conversations',1000,4900)
on conflict (slug) do nothing;

create table if not exists public.organization_addon_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  addon_slug text not null references public.platform_billing_addons(slug),
  provider text not null check (provider = 'stripe'),
  provider_subscription_id text not null unique,
  provider_payment_id text,
  quantity integer not null check (quantity > 0),
  units_snapshot integer not null check (units_snapshot > 0),
  price_cents_snapshot integer not null check (price_cents_snapshot > 0),
  status text not null default 'active' check (status in ('active','past_due','canceled','unpaid','refunded','disputed')),
  current_period_end timestamptz,
  last_event_created timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.organization_addon_subscriptions enable row level security;
revoke all on public.organization_addon_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.organization_addon_subscriptions to service_role;
create index if not exists organization_addon_subscriptions_org_status_idx on public.organization_addon_subscriptions(organization_id,status);

alter table public.platform_checkout_intents
  add column if not exists kind text not null default 'new_org' check (kind in ('new_org','addon')),
  add column if not exists organization_id uuid references public.organizations(id) on delete cascade,
  add column if not exists actor_user_id uuid,
  add column if not exists addon_slug text references public.platform_billing_addons(slug),
  add column if not exists quantity integer not null default 1 check (quantity > 0),
  add column if not exists units_snapshot integer,
  add column if not exists catalog_revision bigint;
create index if not exists platform_checkout_intents_org_created_idx on public.platform_checkout_intents(organization_id,created_at desc) where organization_id is not null;

create or replace function public.fn_plan_entitlements(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_plan text; v_limits jsonb; v_extra jsonb;
begin
  select e.plan_slug into v_plan from public.organization_plan_entitlements e
   where e.organization_id=p_org and e.status='active';
  if v_plan is null then
    select coalesce(nullif(settings->>'plan',''),'standard') into v_plan from public.organizations where id=p_org;
  end if;
  select limits into v_limits from public.platform_billing_plans where slug=coalesce(v_plan,'standard');
  if v_limits is null then v_limits := '{"users":0,"whatsapp":0,"active_agents":0,"monthly_conversations":0,"mcp":false}'::jsonb; end if;
  select coalesce(jsonb_object_agg(resource, units), '{}'::jsonb) into v_extra from (
    select a.resource, sum(s.quantity*s.units_snapshot)::integer units
    from public.organization_addon_subscriptions s join public.platform_billing_addons a on a.slug=s.addon_slug
    where s.organization_id=p_org and s.status='active' group by a.resource
  ) q;
  return jsonb_build_object('plan_slug',coalesce(v_plan,'standard'),'limits',jsonb_build_object(
    'users',coalesce((v_limits->>'users')::int,0)+coalesce((v_extra->>'users')::int,0),
    'whatsapp',coalesce((v_limits->>'whatsapp')::int,0)+coalesce((v_extra->>'whatsapp')::int,0),
    'active_agents',coalesce((v_limits->>'active_agents')::int,0)+coalesce((v_extra->>'active_agents')::int,0),
    'monthly_conversations',coalesce((v_limits->>'monthly_conversations')::int,0)+coalesce((v_extra->>'monthly_conversations')::int,0),
    'mcp',coalesce((v_limits->>'mcp')::boolean,false)
  ));
end; $$;
revoke all on function public.fn_plan_entitlements(uuid) from public, anon, authenticated;
grant execute on function public.fn_plan_entitlements(uuid) to service_role;

create or replace function public.fn_assert_plan_capacity(p_org uuid,p_resource text,p_conversation uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_limit int; v_used int; v_exists boolean;
begin
  perform 1 from public.organizations where id=p_org for update;
  if not found then raise exception 'plan_organization_not_found' using errcode='P0001'; end if;
  select coalesce((fn_plan_entitlements(p_org)->'limits'->>p_resource)::int,0) into v_limit;
  if v_limit <= 0 then raise exception 'plan_%_not_included',p_resource using errcode='P0001'; end if;
  if p_resource='users' then
    select count(*) into v_used from public.user_organizations where organization_id=p_org and accepted_at is not null and revoked_at is null;
  elsif p_resource='whatsapp' then
    select count(*) into v_used from public.channel_sessions where organization_id=p_org and archived_at is null;
  elsif p_resource='active_agents' then
    select count(*) into v_used from public.ai_agents where organization_id=p_org and published_version_id is not null and archived_at is null and is_active and paused_at is null;
  elsif p_resource='monthly_conversations' then
    if p_conversation is null then raise exception 'plan_conversation_required' using errcode='P0001'; end if;
    select exists(select 1 from public.ai_agent_runs where organization_id=p_org and conversation_id=p_conversation and is_dry_run=false and created_at>=date_trunc('month',now())) into v_exists;
    if v_exists then return; end if;
    select count(distinct conversation_id) into v_used from public.ai_agent_runs where organization_id=p_org and conversation_id is not null and is_dry_run=false and created_at>=date_trunc('month',now());
  else raise exception 'plan_resource_unknown' using errcode='P0001'; end if;
  if v_used >= v_limit then raise exception 'plan_%_limit_exceeded',p_resource using errcode='P0001'; end if;
end; $$;
revoke all on function public.fn_assert_plan_capacity(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.fn_assert_plan_capacity(uuid,text,uuid) to service_role;

create or replace function public.fn_plan_usage(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'users',(select count(*) from public.user_organizations where organization_id=p_org and accepted_at is not null and revoked_at is null),
    'whatsapp',(select count(*) from public.channel_sessions where organization_id=p_org and archived_at is null),
    'active_agents',(select count(*) from public.ai_agents where organization_id=p_org and published_version_id is not null and archived_at is null and is_active and paused_at is null),
    'monthly_conversations',(select count(distinct conversation_id) from public.ai_agent_runs where organization_id=p_org and conversation_id is not null and is_dry_run=false and created_at>=date_trunc('month',now()))
  );
end; $$;
revoke all on function public.fn_plan_usage(uuid) from public,anon,authenticated;
grant execute on function public.fn_plan_usage(uuid) to service_role;

create or replace function public.fn_enforce_plan_user_capacity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.accepted_at is not null and new.revoked_at is null
    and (tg_op='INSERT' or (tg_op='UPDATE' and (old.accepted_at is null or old.revoked_at is not null))) then perform public.fn_assert_plan_capacity(new.organization_id,'users'); end if;
 return new;
end; $$;
create or replace function public.fn_enforce_plan_channel_capacity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.archived_at is null and (tg_op='INSERT' or (tg_op='UPDATE' and old.archived_at is not null)) then perform public.fn_assert_plan_capacity(new.organization_id,'whatsapp'); end if;
 return new;
end; $$;
create or replace function public.fn_enforce_plan_agent_capacity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.published_version_id is not null and new.archived_at is null and new.is_active and new.paused_at is null
    and (tg_op='INSERT' or (tg_op='UPDATE' and (old.published_version_id is null or old.archived_at is not null or not old.is_active or old.paused_at is not null))) then perform public.fn_assert_plan_capacity(new.organization_id,'active_agents'); end if;
 return new;
end; $$;
create or replace function public.fn_enforce_plan_conversation_capacity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.is_dry_run=false and new.conversation_id is not null then perform public.fn_assert_plan_capacity(new.organization_id,'monthly_conversations',new.conversation_id); end if;
 return new;
end; $$;
revoke all on function public.fn_enforce_plan_user_capacity() from public,anon,authenticated;
revoke all on function public.fn_enforce_plan_channel_capacity() from public,anon,authenticated;
revoke all on function public.fn_enforce_plan_agent_capacity() from public,anon,authenticated;
revoke all on function public.fn_enforce_plan_conversation_capacity() from public,anon,authenticated;

drop trigger if exists trg_plan_user_capacity on public.user_organizations;
create trigger trg_plan_user_capacity before insert or update of accepted_at,revoked_at on public.user_organizations for each row execute function public.fn_enforce_plan_user_capacity();
drop trigger if exists trg_plan_channel_capacity on public.channel_sessions;
create trigger trg_plan_channel_capacity before insert or update of archived_at on public.channel_sessions for each row execute function public.fn_enforce_plan_channel_capacity();
drop trigger if exists trg_plan_agent_capacity on public.ai_agents;
create trigger trg_plan_agent_capacity before insert or update of published_version_id,is_active,paused_at,archived_at on public.ai_agents for each row execute function public.fn_enforce_plan_agent_capacity();
drop trigger if exists trg_plan_conversation_capacity on public.ai_agent_runs;
create trigger trg_plan_conversation_capacity before insert on public.ai_agent_runs for each row execute function public.fn_enforce_plan_conversation_capacity();

create or replace function public.fn_apply_paid_stripe_addon(
  p_checkout_session_id text,p_payment_id text,p_subscription_id text,p_checkout_intent_id uuid,p_value_cents integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.platform_checkout_intents%rowtype; v_addon public.platform_billing_addons%rowtype;
begin
  if p_subscription_id is null or p_subscription_id='' then return jsonb_build_object('eligible',false,'reason','missing_subscription'); end if;
  select * into v_intent from public.platform_checkout_intents where id=p_checkout_intent_id and stripe_session_id=p_checkout_session_id for update;
  if not found or v_intent.kind<>'addon' or v_intent.organization_id is null or v_intent.addon_slug is null then return jsonb_build_object('eligible',false,'reason','unknown_addon_intent'); end if;
  if v_intent.price_cents<>p_value_cents then return jsonb_build_object('eligible',false,'reason','checkout_snapshot_mismatch'); end if;
  select * into v_addon from public.platform_billing_addons where slug=v_intent.addon_slug;
  if not found then return jsonb_build_object('eligible',false,'reason','unknown_addon'); end if;
  insert into public.organization_addon_subscriptions(organization_id,addon_slug,provider,provider_subscription_id,provider_payment_id,quantity,units_snapshot,price_cents_snapshot,status)
  values(v_intent.organization_id,v_intent.addon_slug,'stripe',p_subscription_id,p_payment_id,v_intent.quantity,v_intent.units_snapshot,v_intent.price_cents,'active')
  on conflict(provider_subscription_id) do update set provider_payment_id=excluded.provider_payment_id,status='active',updated_at=now();
  update public.platform_checkout_intents set status='paid',last_error=null,updated_at=now() where id=v_intent.id;
  return jsonb_build_object('eligible',true,'organization_id',v_intent.organization_id,'addon_slug',v_intent.addon_slug,'quantity',v_intent.quantity);
end; $$;
revoke all on function public.fn_apply_paid_stripe_addon(text,text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.fn_apply_paid_stripe_addon(text,text,text,uuid,integer) to service_role;

create or replace function public.fn_sync_stripe_addon(p_event_type text,p_subscription_id text,p_payment_id text,p_status text,p_current_period_end timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if p_subscription_id is null or p_subscription_id='' then return jsonb_build_object('matched',false); end if;
  v_status := case p_event_type when 'invoice.paid' then 'active' when 'invoice.payment_failed' then 'past_due' when 'customer.subscription.deleted' then 'canceled' when 'charge.refunded' then 'refunded' when 'charge.dispute.created' then 'disputed' else coalesce(nullif(p_status,''),'active') end;
  update public.organization_addon_subscriptions set status=v_status,provider_payment_id=coalesce(nullif(p_payment_id,''),provider_payment_id),current_period_end=coalesce(p_current_period_end,current_period_end),updated_at=now()
   where provider='stripe' and provider_subscription_id=p_subscription_id;
  return jsonb_build_object('matched',found,'status',v_status);
end; $$;
revoke all on function public.fn_sync_stripe_addon(text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_sync_stripe_addon(text,text,text,text,timestamptz) to service_role;

-- Nunca associe o ciclo de vida de uma assinatura pelo customer_id: um mesmo
-- cliente Stripe pode ter plano-base e vários adicionais independentes.
create or replace function public.fn_sync_stripe_subscription(
  p_event_type text, p_subscription_id text, p_customer_id text, p_payment_id text,
  p_status text, p_current_period_end timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sub public.organization_subscriptions%rowtype; v_previous text; v_next text; v_org_action text := 'none';
begin
  select s.* into v_sub from public.organization_subscriptions s
  left join public.platform_subscription_payments pay on pay.organization_id=s.organization_id
  where s.provider='stripe' and (
    (nullif(p_payment_id,'') is not null and (s.provider_payment_id=p_payment_id or pay.provider_payment_id=p_payment_id))
    or (nullif(p_subscription_id,'') is not null and s.provider_subscription_id=p_subscription_id)
  ) order by case when nullif(p_payment_id,'') is not null and pay.provider_payment_id=p_payment_id then 0 else 1 end limit 1 for update of s;
  if not found then return jsonb_build_object('matched',false); end if;
  v_previous:=v_sub.status;
  v_next:=case p_event_type when 'invoice.paid' then 'active' when 'invoice.payment_failed' then 'past_due' when 'customer.subscription.deleted' then 'canceled' when 'charge.refunded' then case when p_status='partially_refunded' then v_sub.status else 'refunded' end when 'charge.dispute.created' then 'disputed' when 'charge.dispute.closed' then case when p_status='won' then 'active' else 'disputed' end else coalesce(nullif(p_status,''),v_sub.status) end;
  update public.organization_subscriptions set status=v_next,provider_subscription_id=coalesce(nullif(p_subscription_id,''),provider_subscription_id),provider_payment_id=coalesce(nullif(p_payment_id,''),provider_payment_id),current_period_end=coalesce(p_current_period_end,current_period_end),updated_at=now() where organization_id=v_sub.organization_id;
  if nullif(p_payment_id,'') is not null then insert into public.platform_subscription_payments(provider_payment_id,organization_id,provider_subscription_id) values(p_payment_id,v_sub.organization_id,coalesce(nullif(p_subscription_id,''),v_sub.provider_subscription_id)) on conflict(provider_payment_id) do update set organization_id=excluded.organization_id,provider_subscription_id=excluded.provider_subscription_id; end if;
  if v_next in ('unpaid','canceled','refunded','disputed','paused','incomplete_expired') then update public.organizations set status='suspended',suspended_at=now(),suspended_by=null,suspended_reason='billing:'||v_next,updated_at=now() where id=v_sub.organization_id and(status='active' or(status='suspended' and suspended_reason like 'billing:%')); if found then v_org_action:='suspended'; end if;
  elsif v_next in ('active','trialing') then update public.organizations set status='active',suspended_at=null,suspended_by=null,suspended_reason=null,updated_at=now() where id=v_sub.organization_id and status='suspended' and suspended_reason like 'billing:%'; if found then v_org_action:='reactivated'; end if; end if;
  return jsonb_build_object('matched',true,'organization_id',v_sub.organization_id,'previous_status',v_previous,'status',v_next,'organization_action',v_org_action);
end; $$;
revoke all on function public.fn_sync_stripe_subscription(text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_sync_stripe_subscription(text,text,text,text,text,timestamptz) to service_role;

notify pgrst, 'reload schema';
