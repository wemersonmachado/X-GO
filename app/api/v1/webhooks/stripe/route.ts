import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit, hashEmail } from "@/lib/audit";
import { sendPaidAccess, type PaidAccessReceipt } from "@/lib/billing/paid-access";
import { retrieveStripeCharge, verifyStripeSignature } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const VALID_PLANS = new Set(["standard", "pro", "enterprise"]);
const PROVISION_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);
const FAILED_CHECKOUT_EVENTS = new Set([
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);
const SUBSCRIPTION_EVENTS = new Set([
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

const eventSchema = z.object({
  id: z.string().min(1).max(160),
  type: z.string().min(1).max(100),
  created: z.number().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
}).passthrough();

const claimSchema = z.object({
  claimed: z.boolean(),
  state: z.enum(["processing", "completed", "failed", "received", "unknown"]),
  attempt: z.number().int().positive(),
});

const receiptSchema = z.object({
  eligible: z.literal(true),
  created: z.boolean(),
  organization_id: z.string().uuid(),
  organization_name: z.string().min(1),
  plan_name: z.string().min(1),
  invite_id: z.string().uuid(),
  issued_at: z.number().int().positive(),
  email_sent_at: z.string().nullable(),
});

const syncSchema = z.object({
  matched: z.boolean(),
  organization_id: z.string().uuid().optional(),
  previous_status: z.string().optional(),
  status: z.string().optional(),
  organization_action: z.enum(["none", "suspended", "reactivated"]).optional(),
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  const valueRecord = record(value);
  return typeof valueRecord?.id === "string" ? valueRecord.id : null;
}

function unixDate(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

function invoicePaymentIntent(object: Record<string, unknown>): string | null {
  const payments = record(object.payments);
  const entries = Array.isArray(payments?.data) ? payments.data : [];
  for (const entry of entries) {
    const payment = record(record(entry)?.payment);
    const paymentIntent = idOf(payment?.payment_intent);
    if (paymentIntent) return paymentIntent;
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET)) {
    return fail("unauthorized", "Webhook não autorizado.", 401);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return fail("validation_failed", "JSON inválido.", 400);
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return fail("validation_failed", "Evento inválido.", 422);

  const event = parsed.data;
  const object = event.data.object as Record<string, unknown>;
  const admin = createAdminClient();
  const occurredAt = event.created ? new Date(event.created * 1000).toISOString() : null;
  const metadata = record(object.metadata);
  const planSlug = typeof metadata?.plan_slug === "string" && VALID_PLANS.has(metadata.plan_slug)
    ? metadata.plan_slug
    : null;

  const { data: claimData, error: claimError } = await admin.rpc(
    "fn_claim_stripe_event" as never,
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_payment_id: idOf(object.payment_intent) ?? idOf(object.id),
      p_customer_id: idOf(object.customer),
      p_plan_slug: planSlug,
      p_value_cents: typeof object.amount_total === "number"
        ? object.amount_total
        : typeof object.amount_paid === "number" ? object.amount_paid : null,
      p_status: typeof object.status === "string" ? object.status : null,
      p_occurred_at: occurredAt,
      p_payload_minimized: {
        mode: object.mode ?? null,
        subscription: idOf(object.subscription),
        payment_intent: idOf(object.payment_intent),
      },
    } as never,
  );
  const claim = claimSchema.safeParse(claimData);
  if (claimError || !claim.success) return fail("internal_error", "Evento não registrado.", 500);
  if (!claim.data.claimed) {
    if (claim.data.state === "completed") return ok({ received: true, duplicate: true });
    return fail("upstream_unavailable", "Evento já está em processamento.", 503);
  }

  const finish = async (succeeded: boolean, error?: string): Promise<boolean> => {
    const result = await admin.rpc("fn_finish_stripe_event" as never, {
      p_event_id: event.id,
      p_attempt: claim.data.attempt,
      p_succeeded: succeeded,
      p_error: error ?? null,
    } as never);
    return !result.error && result.data === true;
  };

  try {
    if (FAILED_CHECKOUT_EVENTS.has(event.type)) {
      const intentId = z.string().uuid().safeParse(metadata?.checkout_intent_id);
      if (intentId.success) {
        const { error: intentError } = await admin.from("platform_checkout_intents" as never).update({
          status: event.type.endsWith("expired") ? "expired" : "failed",
          last_error: event.type,
          updated_at: new Date().toISOString(),
        } as never).eq("id" as never, intentId.data);
        if (intentError) throw new Error("checkout_intent_status_update_failed");
      }
      if (!await finish(true)) return fail("internal_error", "Evento não finalizado.", 500);
      return ok({ received: true, access_provisioned: false, checkout_status: event.type });
    }

    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const parent = record(object.parent);
      const subscriptionDetails = record(parent?.subscription_details);
      const subscriptionId = idOf(object.subscription)
        ?? idOf(subscriptionDetails?.subscription)
        ?? (event.type.startsWith("customer.subscription.") ? idOf(object.id) : null);
      let paymentIntentId = idOf(object.payment_intent) ?? invoicePaymentIntent(object);
      let customerId = idOf(object.customer);
      if (event.type.startsWith("charge.dispute.") && (!paymentIntentId || !customerId)) {
        const chargeId = idOf(object.charge);
        if (chargeId) {
          const charge = await retrieveStripeCharge(chargeId);
          paymentIntentId ??= idOf(charge.payment_intent);
          customerId ??= idOf(charge.customer);
        }
      }
      const periodEnd = unixDate(object.current_period_end) ?? unixDate(object.period_end);
      const refundedAmount = typeof object.amount_refunded === "number" ? object.amount_refunded : null;
      const chargeAmount = typeof object.amount === "number" ? object.amount : null;
      const lifecycleStatus = event.type === "charge.refunded"
        ? object.refunded === true || (refundedAmount != null && chargeAmount != null && refundedAmount >= chargeAmount)
          ? "refunded"
          : "partially_refunded"
        : typeof object.status === "string" ? object.status : null;
      const { data: syncedData, error: syncError } = await admin.rpc(
        "fn_sync_stripe_subscription" as never,
        {
          p_event_type: event.type,
          p_subscription_id: subscriptionId,
          p_customer_id: customerId,
          p_payment_id: paymentIntentId,
          p_status: lifecycleStatus,
          p_current_period_end: periodEnd,
        } as never,
      );
      const synced = syncSchema.safeParse(syncedData);
      if (syncError || !synced.success) throw new Error("subscription_sync_failed");
      if (!synced.data.matched) throw new Error("subscription_not_found");
      if (synced.data.matched && synced.data.organization_id) {
        await audit({
          action: "billing.subscription_synced",
          organizationId: synced.data.organization_id,
          resourceType: "organization_subscription",
          resourceId: subscriptionId ?? paymentIntentId ?? event.id,
          requestId: request.headers.get("x-request-id") ?? event.id,
          bypassedRls: true,
          metadata: {
            source: "stripe",
            event_type: event.type,
            previous_status: synced.data.previous_status,
            status: synced.data.status,
            organization_action: synced.data.organization_action,
          },
        });
      }
      if (!await finish(true)) return fail("internal_error", "Evento não finalizado.", 500);
      return ok({ received: true, subscription_updated: synced.data.matched, status: synced.data.status ?? null });
    }

    if (!PROVISION_EVENTS.has(event.type)) {
      if (!await finish(true)) return fail("internal_error", "Evento não finalizado.", 500);
      return ok({ received: true, access_provisioned: false, ignored: event.type });
    }

    const paymentStatus = typeof object.payment_status === "string" ? object.payment_status : null;
    if (paymentStatus !== "paid") {
      if (!await finish(true)) return fail("internal_error", "Evento não finalizado.", 500);
      return ok({ received: true, access_provisioned: false, payment_status: paymentStatus });
    }

    const checkoutIntent = z.string().uuid().safeParse(metadata?.checkout_intent_id);
    const customerId = idOf(object.customer);
    const subscriptionId = idOf(object.subscription);
    const paymentIntentId = idOf(object.payment_intent);
    const checkoutSessionId = idOf(object.id);
    const amountTotal = typeof object.amount_total === "number" ? object.amount_total : null;
    const customerDetails = record(object.customer_details);
    const email = typeof customerDetails?.email === "string" ? customerDetails.email.toLowerCase() : null;
    const name = (typeof customerDetails?.name === "string" && customerDetails.name.trim())
      || (email ? email.split("@")[0] : null)
      || "Cliente";

    if (!checkoutIntent.success || !planSlug || !checkoutSessionId || !customerId
      || amountTotal == null || !email) {
      logger.error(`[billing.stripe] ${event.type} pago sem dado obrigatório`, {
        hasIntent: checkoutIntent.success,
        hasPlan: Boolean(planSlug),
        hasSession: Boolean(checkoutSessionId),
        hasCustomer: Boolean(customerId),
        hasAmount: amountTotal != null,
        hasEmail: Boolean(email),
      });
      await finish(false, "paid_event_missing_required_data");
      return fail("validation_failed", "Pagamento sem dados reconciliáveis.", 500);
    }

    const { data: provisioned, error: provisionError } = await admin.rpc(
      "fn_provision_paid_checkout" as never,
      {
        p_provider: "stripe",
        p_checkout_session_id: checkoutSessionId,
        p_payment_id: paymentIntentId ?? checkoutSessionId,
        p_subscription_id: subscriptionId ?? "",
        p_customer_id: customerId,
        p_checkout_intent_id: checkoutIntent.data,
        p_plan_slug: planSlug,
        p_value_cents: amountTotal,
        p_customer_name: name,
        p_email_hash: hashEmail(email),
      } as never,
    );
    if (provisionError) throw new Error("checkout_provision_failed");

    const receipt = receiptSchema.safeParse(provisioned);
    if (!receipt.success) {
      const reason = record(provisioned)?.reason;
      throw new Error(typeof reason === "string" ? reason : "checkout_not_eligible");
    }

    if (receipt.data.created) {
      await audit({
        action: "tenant.created_by_payment",
        organizationId: receipt.data.organization_id,
        resourceType: "organization",
        resourceId: receipt.data.organization_id,
        requestId: request.headers.get("x-request-id"),
        bypassedRls: true,
        metadata: { source: "stripe", plan_name: receipt.data.plan_name },
      });
    }

    const delivery = await sendPaidAccess({
      receipt: receipt.data as PaidAccessReceipt,
      email,
      requestId: request.headers.get("x-request-id") ?? event.id,
    });
    if (!delivery.sent) throw new Error("paid_access_delivery_pending");
    if (!await finish(true)) return fail("internal_error", "Evento não finalizado.", 500);
    return ok({ received: true, access_provisioned: true, email_dispatched: true });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "stripe_event_processing_failed";
    await finish(false, reason);
    logger.error("[billing.stripe] processamento será retentado", {
      event_type: event.type,
      reason,
      request_id: request.headers.get("x-request-id"),
    });
    return fail("upstream_unavailable", "Evento aguardando nova tentativa.", 503);
  }
}
