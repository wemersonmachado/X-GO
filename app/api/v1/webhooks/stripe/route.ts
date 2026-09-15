import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit, hashEmail } from "@/lib/audit";
import { verifyStripeSignature } from "@/lib/billing/stripe";
import { sendPaidAccess, type PaidAccessReceipt } from "@/lib/billing/paid-access";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const VALID_PLANS = new Set(["standard", "pro", "enterprise"]);

const eventSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: z.string().min(1).max(100),
    created: z.number().optional(),
    data: z.object({ object: z.record(z.string(), z.unknown()) }),
  })
  .passthrough();

/**
 * Só `checkout.session.completed` provisiona acesso — mesmo escopo que o
 * webhook Asaas do X-GO já tinha (só PAYMENT_CONFIRMED/RECEIVED agiam).
 * Os demais eventos registrados no endpoint (`invoice.paid`,
 * `invoice.payment_failed`, `customer.subscription.*`, `charge.refunded`,
 * `charge.dispute.created`) só são AUDITADOS aqui: nada hoje em
 * `organization_subscriptions` é lido pra bloquear acesso por vencimento ou
 * chargeback, então mutar status por esses eventos seria estado que ninguém
 * consome — quando essa checagem existir, evolui este handler junto.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET)) {
    return fail("unauthorized", "Webhook não autorizado.", 401);
  }
  const parsed = eventSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return fail("validation_failed", "Evento inválido.", 422);
  const event = parsed.data;
  const object = event.data.object as Record<string, unknown>;

  const admin = createAdminClient();
  const occurredAt = event.created ? new Date(event.created * 1000).toISOString() : null;
  const metadata = (object.metadata as Record<string, unknown> | null) ?? null;
  const planSlugFromMetadata =
    typeof metadata?.plan_slug === "string" && VALID_PLANS.has(metadata.plan_slug)
      ? metadata.plan_slug
      : null;

  const { data: recorded, error: recordError } = await admin.rpc(
    "fn_record_stripe_event" as never,
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_payment_id: typeof object.id === "string" ? object.id : null,
      p_customer_id: typeof object.customer === "string" ? object.customer : null,
      p_plan_slug: planSlugFromMetadata,
      p_value_cents:
        typeof object.amount_total === "number"
          ? object.amount_total
          : typeof object.amount_paid === "number"
            ? object.amount_paid
            : null,
      p_status: typeof object.status === "string" ? object.status : null,
      p_occurred_at: occurredAt,
      p_payload_minimized: { mode: object.mode ?? null, subscription: object.subscription ?? null },
    } as never,
  );
  if (recordError) return fail("internal_error", "Evento não processado.", 500);
  if (!recorded) return ok({ received: true, duplicate: true });

  if (event.type !== "checkout.session.completed") {
    return ok({ received: true, access_provisioned: false, ignored: event.type });
  }

  const session = object;
  const customerId = typeof session.customer === "string" ? session.customer : null;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
  const amountTotal = typeof session.amount_total === "number" ? session.amount_total : null;
  const customerDetails = (session.customer_details as Record<string, unknown> | null) ?? null;
  const email = typeof customerDetails?.email === "string" ? customerDetails.email.toLowerCase() : null;
  const name =
    (typeof customerDetails?.name === "string" && customerDetails.name.trim()) ||
    (email ? email.split("@")[0] : null) ||
    "Cliente";

  if (!planSlugFromMetadata || !customerId || amountTotal == null || !email) {
    logger.error("[billing.stripe] checkout.session.completed sem dado obrigatório", {
      hasPlan: Boolean(planSlugFromMetadata),
      hasCustomer: Boolean(customerId),
      hasAmount: amountTotal != null,
      hasEmail: Boolean(email),
    });
    return ok({ received: true, access_provisioned: false });
  }

  const { data: provisioned, error: provisionError } = await admin.rpc(
    "fn_provision_paid_checkout" as never,
    {
      p_provider: "stripe",
      p_payment_id: paymentIntentId ?? String(session.id),
      p_subscription_id: subscriptionId ?? "",
      p_customer_id: customerId,
      p_plan_slug: planSlugFromMetadata,
      p_value_cents: amountTotal,
      p_customer_name: name,
      p_email_hash: hashEmail(email),
    } as never,
  );
  if (provisionError) return fail("internal_error", "Acesso não provisionado.", 500);

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
  const receipt = receiptSchema.safeParse(provisioned);
  if (!receipt.success) return ok({ received: true, access_provisioned: false });

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

  let delivery;
  try {
    delivery = await sendPaidAccess({
      receipt: receipt.data as PaidAccessReceipt,
      email,
      requestId: request.headers.get("x-request-id") ?? event.id,
    });
  } catch (cause) {
    logger.error("[billing.stripe] acesso criado, mas entrega ainda não foi confirmada", {
      error: cause instanceof Error ? cause.message : "unknown",
      request_id: request.headers.get("x-request-id"),
    });
    return fail("upstream_unavailable", "Acesso criado; e-mail aguardando nova tentativa.", 503);
  }
  if (!delivery.sent) {
    return fail("upstream_unavailable", "Acesso criado; e-mail aguardando nova tentativa.", 503);
  }
  return ok({ received: true, access_provisioned: true, email_dispatched: true });
}
