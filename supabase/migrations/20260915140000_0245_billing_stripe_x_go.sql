-- X-GO troca Asaas por Stripe. Preço fica só no banco (platform_billing_plans);
-- o Checkout Session é construído com price_data inline a cada clique, então
-- não existe "link fixo" nem sincronização externa: o super admin edita
-- price_cents e o próximo checkout já cobra o valor novo.
--
-- provider default 'asaas' nas duas colunas novas é backfill-safe: qualquer
-- linha que já exista hoje só pode ter vindo do fluxo Asaas (fn_record_stripe_event
-- e o novo fn_provision_paid_checkout sempre passam 'stripe' explicitamente).

alter table public.organization_subscriptions
  add column if not exists provider text not null default 'asaas'
    check (provider in ('asaas','stripe'));

alter table public.platform_payment_events
  add column if not exists provider text not null default 'asaas'
    check (provider in ('asaas','stripe'));

create or replace function public.fn_record_stripe_event(
  p_event_id text,
  p_event_type text,
  p_payment_id text,
  p_customer_id text,
  p_plan_slug text,
  p_value_cents integer,
  p_status text,
  p_occurred_at timestamptz,
  p_payload_minimized jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.platform_payment_events(
    event_id, event_type, provider_payment_id, provider_customer_id,
    plan_slug, value_cents, status, occurred_at, payload_minimized, provider
  ) values (
    p_event_id, p_event_type, p_payment_id, p_customer_id,
    p_plan_slug, p_value_cents, p_status, p_occurred_at,
    coalesce(p_payload_minimized, '{}'::jsonb), 'stripe'
  )
  on conflict (event_id) do nothing;
  return found;
end;
$$;
revoke all on function public.fn_record_stripe_event(text,text,text,text,text,integer,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.fn_record_stripe_event(text,text,text,text,text,integer,text,timestamptz,jsonb) to service_role;

-- fn_provision_paid_checkout troca p_payment_link_id (opaco, exigia inferir
-- plano por valor/e-mail) por p_provider + p_plan_slug (vem direto do
-- metadata que o próprio backend escreveu ao criar o Checkout Session —
-- nunca controlado pelo pagador). Assinatura muda de 7 pra 8 parâmetros;
-- Postgres não permite CREATE OR REPLACE renomear parâmetro de entrada,
-- então dropa e recria.
drop function if exists public.fn_provision_paid_checkout(text,text,text,text,integer,text,text);

create or replace function public.fn_provision_paid_checkout(
  p_provider text,
  p_payment_id text,
  p_subscription_id text,
  p_customer_id text,
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
  v_access public.platform_checkout_access%rowtype;
  v_org public.organizations%rowtype;
begin
  if p_provider is null or p_provider not in ('asaas','stripe') then
    return jsonb_build_object('eligible', false, 'reason', 'unknown_provider');
  end if;
  if p_payment_id is null or p_customer_id is null or p_plan_slug is null
    or p_value_cents is null or p_customer_name is null or p_email_hash is null then
    return jsonb_build_object('eligible', false, 'reason', 'missing_required_data');
  end if;
  if p_email_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('eligible', false, 'reason', 'invalid_email_hash');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('paid-checkout:' || v_purchase_key, 0));
  select * into v_access from public.platform_checkout_access where purchase_key = v_purchase_key;
  if found then
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

  select * into v_plan from public.platform_billing_plans
    where slug = p_plan_slug and active;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'unknown_or_inactive_plan');
  end if;
  if v_plan.price_cents <> p_value_cents then
    return jsonb_build_object('eligible', false, 'reason', 'payment_value_mismatch');
  end if;

  insert into public.organizations(display_name, slug, legal_name, status, settings, created_by)
  values (
    left(trim(p_customer_name), 120),
    'xgo-' || substr(md5(p_customer_id || ':' || v_purchase_key), 1, 24),
    left(trim(p_customer_name), 255),
    'active',
    jsonb_build_object(
      'plan', v_plan.slug,
      'interface_default', jsonb_build_object('preset', 'completa')
    ),
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

revoke all on function public.fn_provision_paid_checkout(text,text,text,text,text,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.fn_provision_paid_checkout(text,text,text,text,text,integer,text,text)
  to service_role;

notify pgrst, 'reload schema';
