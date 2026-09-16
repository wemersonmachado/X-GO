-- Uma contratação pode conter plano-base e adicionais no MESMO ciclo Stripe.
-- O navegador só manda quantidade; preço, catálogo e o total são congelados aqui.

alter table public.platform_checkout_intents
  add column if not exists total_price_cents integer,
  add column if not exists addons_snapshot jsonb not null default '[]'::jsonb;

update public.platform_checkout_intents
set total_price_cents = price_cents
where total_price_cents is null;

alter table public.platform_checkout_intents
  alter column total_price_cents set not null;

alter table public.platform_checkout_intents
  drop constraint if exists platform_checkout_intents_total_price_cents_check;
alter table public.platform_checkout_intents
  add constraint platform_checkout_intents_total_price_cents_check check (total_price_cents >= price_cents);

-- Um checkout de cesta gera uma assinatura Stripe só: plano e cada adicional
-- compartilham provider_subscription_id, mas permanecem linhas separadas.
alter table public.organization_addon_subscriptions
  drop constraint if exists organization_addon_subscriptions_provider_subscription_id_key;
create unique index if not exists organization_addon_subscriptions_subscription_addon_key
  on public.organization_addon_subscriptions(organization_id, provider_subscription_id, addon_slug);

create or replace function public.fn_apply_paid_stripe_plan_bundle(
  p_checkout_session_id text,
  p_payment_id text,
  p_subscription_id text,
  p_customer_id text,
  p_checkout_intent_id uuid,
  p_plan_slug text,
  p_total_value_cents integer,
  p_customer_name text,
  p_email_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.platform_checkout_intents%rowtype;
  v_expected integer;
  v_receipt jsonb;
  v_org uuid;
begin
  select * into v_intent
    from public.platform_checkout_intents
   where id = p_checkout_intent_id and stripe_session_id = p_checkout_session_id
   for update;
  if not found or v_intent.kind <> 'new_org' or v_intent.plan_slug <> p_plan_slug then
    return jsonb_build_object('eligible', false, 'reason', 'unknown_plan_bundle');
  end if;

  select v_intent.price_cents + coalesce(sum((item->>'price_cents')::integer * (item->>'quantity')::integer), 0)
    into v_expected
    from jsonb_array_elements(v_intent.addons_snapshot) item;
  if v_expected <> v_intent.total_price_cents or v_expected <> p_total_value_cents then
    return jsonb_build_object('eligible', false, 'reason', 'checkout_snapshot_mismatch');
  end if;

  -- A função original registra o valor do plano-base. A validação acima é a
  -- autoridade para o total efetivamente cobrado pela cesta Stripe.
  select public.fn_provision_paid_checkout(
    'stripe', p_checkout_session_id, p_payment_id, p_subscription_id, p_customer_id,
    p_checkout_intent_id, p_plan_slug, v_intent.price_cents, p_customer_name, p_email_hash
  ) into v_receipt;
  if coalesce((v_receipt->>'eligible')::boolean, false) is not true then return v_receipt; end if;
  v_org := (v_receipt->>'organization_id')::uuid;

  insert into public.organization_addon_subscriptions(
    organization_id, addon_slug, provider, provider_subscription_id,
    provider_payment_id, quantity, units_snapshot, price_cents_snapshot, status
  )
  select v_org, item->>'slug', 'stripe', p_subscription_id, p_payment_id,
    (item->>'quantity')::integer, (item->>'units')::integer,
    (item->>'price_cents')::integer, 'active'
  from jsonb_array_elements(v_intent.addons_snapshot) item
  where (item->>'quantity')::integer > 0
  on conflict (organization_id, provider_subscription_id, addon_slug) do update set
    provider_payment_id = excluded.provider_payment_id,
    quantity = excluded.quantity,
    units_snapshot = excluded.units_snapshot,
    price_cents_snapshot = excluded.price_cents_snapshot,
    status = 'active', updated_at = now();

  return v_receipt || jsonb_build_object('bundle_total_cents', v_expected);
end;
$$;
revoke all on function public.fn_apply_paid_stripe_plan_bundle(text,text,text,text,uuid,text,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.fn_apply_paid_stripe_plan_bundle(text,text,text,text,uuid,text,integer,text,text)
  to service_role;

-- A franquia mede respostas reais da IA (llm_calls), e não contatos distintos.
-- Tokens continuam registrados em cada chamada para custo/auditoria; a cota de
-- respostas evita inventar uma conversão de tokens que o catálogo não define.
update public.platform_billing_plans set limits = case slug
  when 'standard' then '{"users":3,"whatsapp":1,"active_agents":3,"monthly_conversations":3000,"mcp":true}'::jsonb
  when 'pro' then '{"users":10,"whatsapp":3,"active_agents":10,"monthly_conversations":15000,"mcp":true}'::jsonb
  when 'enterprise' then '{"users":20,"whatsapp":20,"active_agents":25,"monthly_conversations":50000,"mcp":true,"priority_support":true,"customization":true}'::jsonb
  else limits end;

create or replace function public.fn_plan_usage(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'users',(select count(*) from public.user_organizations where organization_id=p_org and accepted_at is not null and revoked_at is null),
    'whatsapp',(select count(*) from public.channel_sessions where organization_id=p_org and archived_at is null),
    'active_agents',(select count(*) from public.ai_agents where organization_id=p_org and published_version_id is not null and archived_at is null and is_active and paused_at is null),
    'monthly_conversations',(select count(*) from public.llm_calls where organization_id=p_org and purpose='agent_turn' and created_at>=date_trunc('month',now())),
    'ai_tokens',(select coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) from public.llm_calls where organization_id=p_org and purpose='agent_turn' and created_at>=date_trunc('month',now()))
  );
end; $$;
revoke all on function public.fn_plan_usage(uuid) from public, anon, authenticated;
grant execute on function public.fn_plan_usage(uuid) to service_role;

create or replace function public.fn_enforce_plan_ai_response_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.purpose = 'agent_turn' then
    perform public.fn_assert_plan_capacity(new.organization_id, 'monthly_conversations', null);
  end if;
  return new;
end; $$;
revoke all on function public.fn_enforce_plan_ai_response_capacity() from public, anon, authenticated;

create or replace function public.fn_assert_plan_capacity(p_org uuid,p_resource text,p_conversation uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_limit int; v_used int;
begin
  perform 1 from public.organizations where id=p_org for update;
  if not found then raise exception 'plan_organization_not_found' using errcode='P0001'; end if;
  select coalesce((public.fn_plan_entitlements(p_org)->'limits'->>p_resource)::int,0) into v_limit;
  if v_limit <= 0 then raise exception 'plan_%_not_included',p_resource using errcode='P0001'; end if;
  if p_resource='users' then select count(*) into v_used from public.user_organizations where organization_id=p_org and accepted_at is not null and revoked_at is null;
  elsif p_resource='whatsapp' then select count(*) into v_used from public.channel_sessions where organization_id=p_org and archived_at is null;
  elsif p_resource='active_agents' then select count(*) into v_used from public.ai_agents where organization_id=p_org and published_version_id is not null and archived_at is null and is_active and paused_at is null;
  elsif p_resource='monthly_conversations' then select count(*) into v_used from public.llm_calls where organization_id=p_org and purpose='agent_turn' and created_at>=date_trunc('month',now());
  else raise exception 'plan_resource_unknown' using errcode='P0001'; end if;
  if v_used >= v_limit then raise exception 'plan_%_limit_exceeded',p_resource using errcode='P0001'; end if;
end; $$;
revoke all on function public.fn_assert_plan_capacity(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.fn_assert_plan_capacity(uuid,text,uuid) to service_role;

drop trigger if exists trg_plan_conversation_capacity on public.ai_agent_runs;
drop trigger if exists trg_plan_ai_response_capacity on public.llm_calls;
create trigger trg_plan_ai_response_capacity before insert on public.llm_calls
  for each row execute function public.fn_enforce_plan_ai_response_capacity();

notify pgrst, 'reload schema';
