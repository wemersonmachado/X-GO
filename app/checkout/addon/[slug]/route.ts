import { randomUUID } from "node:crypto";

import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { createCheckoutSession } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const slugSchema = z.enum(["extra_user", "extra_whatsapp", "extra_active_agent", "extra_conversations_1000"]);
const formSchema = z.object({ intent_key: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(100).default(1) });

/** Checkout de adicional só existe dentro da organização autenticada. O id da
 * organização é gravado na intenção pelo servidor e nunca vem do formulário. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  if (request.headers.get("origin") !== new URL(base).origin) return Response.redirect(`${base}/app/settings/billing?checkout=origem_invalida`, 303);
  const auth = await requireRole("admin", { resource: "billing_addon" });
  if (!auth.ok) return Response.redirect(`${base}/login?next=/app/settings/billing`, 303);
  const slug = slugSchema.safeParse((await params).slug);
  const form = formSchema.safeParse(Object.fromEntries(await request.formData().catch(() => new FormData())));
  if (!slug.success || !form.success) return Response.redirect(`${base}/app/settings/billing?checkout=requisicao_invalida`, 303);
  const admin = createAdminClient();
  const [{ data: addonData }, { data: planData }] = await Promise.all([
    admin.from("platform_billing_addons" as never).select("slug,name,units,price_cents,revision,active" as never).eq("slug" as never, slug.data).maybeSingle(),
    admin.rpc("fn_plan_entitlements" as never, { p_org: auth.org.orgId } as never),
  ]);
  const addon = addonData as unknown as { slug: string; name: string; units: number; price_cents: number; revision: number; active: boolean } | null;
  const planSlug = planData && typeof planData === "object" ? (planData as { plan_slug?: unknown }).plan_slug : null;
  if (!addon?.active || (planSlug !== "standard" && planSlug !== "pro" && planSlug !== "enterprise")) return Response.redirect(`${base}/app/settings/billing?checkout=indisponivel`, 303);
  const total = addon.price_cents * form.data.quantity;
  const { error: intentError } = await admin.from("platform_checkout_intents" as never).insert({
    id: form.data.intent_key, plan_slug: planSlug, price_cents: total, currency: "BRL", status: "creating", kind: "addon",
    organization_id: auth.org.orgId, actor_user_id: auth.user.id, addon_slug: addon.slug, quantity: form.data.quantity,
    units_snapshot: addon.units, catalog_revision: addon.revision,
  } as never);
  if (intentError) return Response.redirect(`${base}/app/settings/billing?checkout=indisponivel`, 303);
  try {
    const session = await createCheckoutSession({
      planSlug: `${planSlug}-${addon.slug}`, planName: `${addon.name} × ${form.data.quantity}`, priceCents: total, currency: "BRL",
      clientReferenceId: auth.user.id, metadata: { checkout_intent_id: form.data.intent_key, checkout_kind: "addon", addon_slug: addon.slug, organization_id: auth.org.orgId },
      successUrl: `${base}/checkout/sucesso`, cancelUrl: `${base}/app/settings/billing`, idempotencyKey: `addon-${form.data.intent_key}`,
    });
    if (!session.url) throw new Error("stripe_session_sem_url");
    await admin.from("platform_checkout_intents" as never).update({ stripe_session_id: session.id, status: "open", updated_at: new Date().toISOString() } as never).eq("id" as never, form.data.intent_key);
    return Response.redirect(session.url, 303);
  } catch (cause) {
    await admin.from("platform_checkout_intents" as never).update({ status: "failed", last_error: "stripe_checkout_creation_failed", updated_at: new Date().toISOString() } as never).eq("id" as never, form.data.intent_key);
    logger.error("[billing.stripe] falha ao criar checkout de adicional", { addon: addon.slug, reason: cause instanceof Error ? cause.message : "unknown" });
    return Response.redirect(`${base}/app/settings/billing?checkout=indisponivel`, 303);
  }
}
