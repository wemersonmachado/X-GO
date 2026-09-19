-- Compatibilidade segura para escritores anteriores à cesta Stripe.
-- O total permanece NOT NULL e validado; ausência significa plano sem adicionais.
create or replace function public.fn_checkout_intent_default_total() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.total_price_cents is null then
    new.total_price_cents := new.price_cents;
  end if;
  return new;
end; $$;

revoke execute on function public.fn_checkout_intent_default_total() from public, anon, authenticated;
grant execute on function public.fn_checkout_intent_default_total() to service_role;

drop trigger if exists trg_checkout_intent_default_total on public.platform_checkout_intents;
create trigger trg_checkout_intent_default_total
before insert or update of price_cents, total_price_cents on public.platform_checkout_intents
for each row execute function public.fn_checkout_intent_default_total();
