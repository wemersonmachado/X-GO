import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

describe("processamento durável da Stripe", () => {
  it("não concorre, retoma falha e encerra exatamente uma vez", () => {
    const result = sql(`
      select (public.fn_claim_stripe_event(
        'evt_retry', 'checkout.session.completed', 'cs_retry', 'cus_retry',
        'standard', 19700, 'complete', now(), '{}'::jsonb
      )->>'claimed');
      select (public.fn_claim_stripe_event(
        'evt_retry', 'checkout.session.completed', 'cs_retry', 'cus_retry',
        'standard', 19700, 'complete', now(), '{}'::jsonb
      )->>'state');
      select public.fn_finish_stripe_event('evt_retry', 1, false, 'resend_unavailable');
      select (public.fn_claim_stripe_event(
        'evt_retry', 'checkout.session.completed', 'cs_retry', 'cus_retry',
        'standard', 19700, 'complete', now(), '{}'::jsonb
      )->>'claimed');
      select public.fn_finish_stripe_event('evt_retry', 2, true, null);
      select (public.fn_claim_stripe_event(
        'evt_retry', 'checkout.session.completed', 'cs_retry', 'cus_retry',
        'standard', 19700, 'complete', now(), '{}'::jsonb
      )->>'state');
      select processing_attempts || ':' || processing_status
        from public.platform_payment_events where event_id = 'evt_retry';
    `).split("\n");
    expect(result).toEqual(["true", "processing", "t", "true", "t", "completed", "2:completed"]);
  });

  it("provisiona pelo preço congelado mesmo que o catálogo mude depois", () => {
    const result = sql(`
      begin;
      insert into public.platform_checkout_intents(
        id, plan_slug, price_cents, currency, stripe_session_id, status
      ) values (
        '24600000-0000-4000-8000-000000000001', 'standard', 19700, 'BRL', 'cs_snapshot', 'open'
      );
      update public.platform_billing_plans set price_cents = 29700 where slug = 'standard';
      select (public.fn_provision_paid_checkout(
        'stripe', 'cs_snapshot', 'pi_snapshot', 'sub_snapshot', 'cus_snapshot',
        '24600000-0000-4000-8000-000000000001', 'standard', 19700,
        'Cliente Snapshot', repeat('a', 64)
      )->>'eligible');
      select status from public.platform_checkout_intents
       where id = '24600000-0000-4000-8000-000000000001';
      select (public.fn_sync_stripe_subscription(
        'invoice.paid', 'sub_snapshot', 'cus_snapshot', 'pi_renewal', 'paid', now()
      )->>'status');
      select (public.fn_sync_stripe_subscription(
        'charge.dispute.created', null, null, 'pi_renewal', 'needs_response', null
      )->>'status');
      select o.status from public.organizations o
        join public.organization_subscriptions s on s.organization_id = o.id
       where s.provider_subscription_id = 'sub_snapshot';
      select (public.fn_sync_stripe_subscription(
        'charge.dispute.closed', null, null, 'pi_renewal', 'won', null
      )->>'status');
      select o.status from public.organizations o
        join public.organization_subscriptions s on s.organization_id = o.id
       where s.provider_subscription_id = 'sub_snapshot';
      select (public.fn_sync_stripe_subscription(
        'charge.refunded', null, null, 'pi_renewal', 'partially_refunded', null
      )->>'status');
      rollback;
    `).split("\n").filter((line) => ["true", "paid", "active", "disputed", "suspended"].includes(line));
    expect(result).toEqual([
      "true", "paid", "active", "disputed", "suspended", "active", "active", "active",
    ]);
  });
});
