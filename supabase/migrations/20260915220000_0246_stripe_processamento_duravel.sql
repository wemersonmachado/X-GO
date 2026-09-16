-- Stripe: checkout idempotente, preço congelado por intenção e inbox reprocessável.

create table if not exists public.platform_checkout_intents (
  id uuid primary key,
  plan_slug text not null references public.platform_billing_plans(slug),
  price_cents integer not null check (price_cents > 0),
  currency text not null check (currency = 'BRL'),
  stripe_session_id text unique,
  status text not null default 'creating'
    check (status in ('creating','open','paid','failed','expired')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_checkout_intents enable row level security;
revoke all on public.platform_checkout_intents from public, anon, authenticated;
grant select, insert, update, delete on public.platform_checkout_intents to service_role;
create index if not exists idx_platform_checkout_intents_created
  on public.platform_checkout_intents(created_at desc);

create table if not exists public.platform_subscription_payments (
  provider_payment_id text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_subscription_id text,
  created_at timestamptz not null default now()
);
alter table public.platform_subscription_payments enable row level security;
revoke all on public.platform_subscription_payments from public, anon, authenticated;
grant select, insert, update, delete on public.platform_subscription_payments to service_role;
create index if not exists idx_platform_subscription_payments_subscription
  on public.platform_subscription_payments(provider_subscription_id);

alter table public.platform_payment_events
  add column if not exists processing_status text not null default 'completed'
    check (processing_status in ('received','processing','completed','failed')),
  add column if not exists processing_attempts integer not null default 1
    check (processing_attempts > 0),
  add column if not exists processing_started_at timestamptz,
  add column if not exists last_error text;

alter table public.platform_payment_events alter column processed_at drop not null;
alter table public.platform_payment_events alter column processed_at drop default;

create or replace function public.fn_claim_stripe_event(
  p_event_id text,
  p_event_type text,
  p_payment_id text,
  p_customer_id text,
  p_plan_slug text,
  p_value_cents integer,
  p_status text,
  p_occurred_at timestamptz,
  p_payload_minimized jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_claimed boolean := false;
  v_state text;
  v_attempt integer;
begin
  insert into public.platform_payment_events(
    event_id, event_type, provider_payment_id, provider_customer_id,
    plan_slug, value_cents, status, occurred_at, payload_minimized, provider,
    processing_status, processing_attempts, processing_started_at, processed_at, last_error
  ) values (
    p_event_id, p_event_type, p_payment_id, p_customer_id,
    p_plan_slug, p_value_cents, p_status, p_occurred_at,
    coalesce(p_payload_minimized, '{}'::jsonb), 'stripe',
    'processing', 1, now(), null, null
  )
  on conflict (event_id) do update set
    processing_status = 'processing',
    processing_attempts = public.platform_payment_events.processing_attempts + 1,
    processing_started_at = now(),
    processed_at = null,
    last_error = null
  where public.platform_payment_events.provider = 'stripe'
    and (
      public.platform_payment_events.processing_status in ('received','failed')
      or (
        public.platform_payment_events.processing_status = 'processing'
        and public.platform_payment_events.processing_started_at < now() - interval '5 minutes'
      )
    )
  returning true, processing_attempts into v_claimed, v_attempt;

  if coalesce(v_claimed, false) then
    return jsonb_build_object('claimed', true, 'state', 'processing', 'attempt', v_attempt);
  end if;

  select processing_status, processing_attempts into v_state, v_attempt
    from public.platform_payment_events
   where event_id = p_event_id and provider = 'stripe';
  return jsonb_build_object(
    'claimed', false, 'state', coalesce(v_state, 'unknown'), 'attempt', coalesce(v_attempt, 1)
  );
end;
$$;
revoke all on function public.fn_claim_stripe_event(text,text,text,text,text,integer,text,timestamptz,jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_claim_stripe_event(text,text,text,text,text,integer,text,timestamptz,jsonb)
  to service_role;

create or replace function public.fn_finish_stripe_event(
  p_event_id text,
  p_attempt integer,
  p_succeeded boolean,
  p_error text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_updated boolean;
begin
  update public.platform_payment_events set
    processing_status = case when p_succeeded then 'completed' else 'failed' end,
    processed_at = case when p_succeeded then now() else null end,
    last_error = case when p_succeeded then null else left(coalesce(p_error, 'processing_failed'), 500) end
  where event_id = p_event_id and provider = 'stripe'
    and processing_status = 'processing' and processing_attempts = p_attempt
  returning true into v_updated;
  return coalesce(v_updated, false);
end;
$$;
revoke all on function public.fn_finish_stripe_event(text,integer,boolean,text)
  from public, anon, authenticated;
grant execute on function public.fn_finish_stripe_event(text,integer,boolean,text) to service_role;

create or replace function public.fn_provision_paid_checkout(
  p_provider text,
  p_checkout_session_id text,
  p_payment_id text,
  p_subscription_id text,
  p_customer_id text,
  p_checkout_intent_id uuid,
  p_plan_slug text,
  p_value_cents integer,
  p_customer_name text,
  p_email_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_purchase_key text := coalesce(p_provider, 'unknown') || ':' ||
    coalesce(nullif(p_subscription_id, ''), 'payment:' || p_payment_id);
  v_plan public.platform_billing_plans%rowtype;
  v_intent public.platform_checkout_intents%rowtype;
  v_access public.platform_checkout_access%rowtype;
  v_org public.organizations%rowtype;
begin
  if p_provider <> 'stripe' then
    return jsonb_build_object('eligible', false, 'reason', 'unknown_provider');
  end if;
  if p_checkout_session_id is null or p_payment_id is null or p_customer_id is null
    or p_checkout_intent_id is null or p_plan_slug is null or p_value_cents is null
    or p_customer_name is null or p_email_hash is null then
    return jsonb_build_object('eligible', false, 'reason', 'missing_required_data');
  end if;
  if p_email_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('eligible', false, 'reason', 'invalid_email_hash');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('paid-checkout:' || v_purchase_key, 0));

  select * into v_intent from public.platform_checkout_intents
   where id = p_checkout_intent_id and stripe_session_id = p_checkout_session_id
   for update;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'unknown_checkout_intent');
  end if;
  if v_intent.plan_slug <> p_plan_slug or v_intent.price_cents <> p_value_cents then
    return jsonb_build_object('eligible', false, 'reason', 'checkout_snapshot_mismatch');
  end if;

  select * into v_access from public.platform_checkout_access where purchase_key = v_purchase_key;
  if found then
    update public.platform_checkout_intents set status = 'paid', updated_at = now(), last_error = null
     where id = v_intent.id;
    select display_name into v_org.display_name from public.organizations where id = v_access.organization_id;
    select name into v_plan.name
      from public.organization_subscriptions s
      join public.platform_billing_plans p on p.slug = s.plan_slug
      where s.organization_id = v_access.organization_id;
    return jsonb_build_object(
      'eligible', true, 'created', false,
      'organization_id', v_access.organization_id,
      'organization_name', v_org.display_name,
      'plan_name', v_plan.name,
      'invite_id', v_access.invite_id,
      'issued_at', v_access.issued_at,
      'email_sent_at', v_access.email_sent_at
    );
  end if;

  select * into v_plan from public.platform_billing_plans where slug = v_intent.plan_slug;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'unknown_plan');
  end if;

  insert into public.organizations(display_name, slug, legal_name, status, settings, created_by)
  values (
    left(trim(p_customer_name), 120),
    'xgo-' || substr(md5(p_customer_id || ':' || v_purchase_key), 1, 24),
    left(trim(p_customer_name), 255),
    'active',
    jsonb_build_object('plan', v_plan.slug, 'interface_default', jsonb_build_object('preset', 'completa')),
    null
  ) returning * into v_org;

  insert into public.organization_subscriptions(
    organization_id, plan_slug, provider, provider_customer_id, provider_subscription_id,
    provider_payment_id, status, value_cents
  ) values (
    v_org.id, v_plan.slug, p_provider, p_customer_id, nullif(p_subscription_id, ''),
    p_payment_id, 'active', p_value_cents
  );

  insert into public.platform_checkout_access(
    purchase_key, provider_payment_id, provider_subscription_id, provider_customer_id,
    organization_id, invite_id, issued_at, email_hash
  ) values (
    v_purchase_key, p_payment_id, nullif(p_subscription_id, ''), p_customer_id,
    v_org.id, gen_random_uuid(), floor(extract(epoch from now()))::bigint, p_email_hash
  ) returning * into v_access;

  insert into public.platform_subscription_payments(
    provider_payment_id, organization_id, provider_subscription_id
  ) values (p_payment_id, v_org.id, nullif(p_subscription_id, ''))
  on conflict (provider_payment_id) do update set
    organization_id = excluded.organization_id,
    provider_subscription_id = excluded.provider_subscription_id;

  update public.platform_checkout_intents set status = 'paid', updated_at = now(), last_error = null
   where id = v_intent.id;

  return jsonb_build_object(
    'eligible', true, 'created', true,
    'organization_id', v_org.id,
    'organization_name', v_org.display_name,
    'plan_name', v_plan.name,
    'invite_id', v_access.invite_id,
    'issued_at', v_access.issued_at,
    'email_sent_at', null
  );
end;
$$;
revoke all on function public.fn_provision_paid_checkout(text,text,text,text,text,uuid,text,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.fn_provision_paid_checkout(text,text,text,text,text,uuid,text,integer,text,text)
  to service_role;

create or replace function public.fn_sync_stripe_subscription(
  p_event_type text,
  p_subscription_id text,
  p_customer_id text,
  p_payment_id text,
  p_status text,
  p_current_period_end timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_sub public.organization_subscriptions%rowtype;
  v_previous text;
  v_next text;
  v_org_action text := 'none';
begin
  select s.* into v_sub from public.organization_subscriptions s
   left join public.platform_subscription_payments pay
     on pay.organization_id = s.organization_id
   where s.provider = 'stripe' and (
     (p_payment_id is not null and (
       s.provider_payment_id = p_payment_id or pay.provider_payment_id = p_payment_id
     ))
     or (p_subscription_id is not null and s.provider_subscription_id = p_subscription_id)
     or (p_customer_id is not null and s.provider_customer_id = p_customer_id)
   )
   order by case
     when p_payment_id is not null and pay.provider_payment_id = p_payment_id then 0
     when p_subscription_id is not null and s.provider_subscription_id = p_subscription_id then 1
     else 2
   end
   limit 1 for update of s;
  if not found then
    return jsonb_build_object('matched', false);
  end if;

  v_previous := v_sub.status;
  v_next := case p_event_type
    when 'invoice.paid' then 'active'
    when 'invoice.payment_failed' then 'past_due'
    when 'customer.subscription.deleted' then 'canceled'
    when 'charge.refunded' then
      case when p_status = 'partially_refunded' then v_sub.status else 'refunded' end
    when 'charge.dispute.created' then 'disputed'
    when 'charge.dispute.closed' then
      case when p_status = 'won' then 'active' else 'disputed' end
    else coalesce(nullif(p_status, ''), v_sub.status)
  end;

  update public.organization_subscriptions set
    status = v_next,
    provider_subscription_id = coalesce(nullif(p_subscription_id, ''), provider_subscription_id),
    provider_payment_id = coalesce(nullif(p_payment_id, ''), provider_payment_id),
    current_period_end = coalesce(p_current_period_end, current_period_end),
    updated_at = now()
  where organization_id = v_sub.organization_id;

  if p_payment_id is not null then
    insert into public.platform_subscription_payments(
      provider_payment_id, organization_id, provider_subscription_id
    ) values (
      p_payment_id, v_sub.organization_id,
      coalesce(nullif(p_subscription_id, ''), v_sub.provider_subscription_id)
    )
    on conflict (provider_payment_id) do update set
      organization_id = excluded.organization_id,
      provider_subscription_id = excluded.provider_subscription_id;
  end if;

  if v_next in ('unpaid','canceled','refunded','disputed','paused','incomplete_expired') then
    update public.organizations set
      status = 'suspended', suspended_at = now(), suspended_by = null,
      suspended_reason = 'billing:' || v_next, updated_at = now()
    where id = v_sub.organization_id
      and (status = 'active' or (status = 'suspended' and suspended_reason like 'billing:%'));
    if found then v_org_action := 'suspended'; end if;
  elsif v_next in ('active','trialing') then
    update public.organizations set
      status = 'active', suspended_at = null, suspended_by = null,
      suspended_reason = null, updated_at = now()
    where id = v_sub.organization_id and status = 'suspended'
      and suspended_reason like 'billing:%';
    if found then v_org_action := 'reactivated'; end if;
  end if;

  return jsonb_build_object(
    'matched', true,
    'organization_id', v_sub.organization_id,
    'previous_status', v_previous,
    'status', v_next,
    'organization_action', v_org_action
  );
end;
$$;
revoke all on function public.fn_sync_stripe_subscription(text,text,text,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.fn_sync_stripe_subscription(text,text,text,text,text,timestamptz)
  to service_role;

notify pgrst, 'reload schema';
