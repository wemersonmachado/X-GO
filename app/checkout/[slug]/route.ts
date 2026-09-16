import { createHash } from "node:crypto";

import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { loadAuthUser } from "@/lib/auth/server";
import { createCheckoutSession } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const slugSchema = z.enum(["standard", "pro", "enterprise"]);
const formSchema = z.object({ intent_key: z.string().uuid() });
const ADDON_SLUGS = ["extra_user", "extra_whatsapp", "extra_active_agent", "extra_conversations_1000"] as const;
type AddonSnapshot = { slug: typeof ADDON_SLUGS[number]; name: string; resource: string; units: number; price_cents: number; quantity: number; revision: number };

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || null;
}

/**
 * Redireciona pro Checkout hospedado da Stripe. A primeira submissão congela
 * plano e preço em `platform_checkout_intents`; repetir a mesma submissão usa
 * a mesma intenção e a mesma chave idempotente na Stripe.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const expectedOrigin = new URL(base).origin;
  if (request.headers.get("origin") !== expectedOrigin) {
    return Response.redirect(`${base}/?checkout=origem_invalida`, 303);
  }

  const { slug } = await params;
  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return Response.redirect(`${base}/?checkout=plano_invalido`, 303);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect(`${base}/?checkout=requisicao_invalida`, 303);
  }
  const parsedForm = formSchema.safeParse(Object.fromEntries(form));
  if (!parsedForm.success) {
    return Response.redirect(`${base}/?checkout=requisicao_invalida`, 303);
  }

  const ip = clientIp(request);
  if (ip) {
    const bucket = `checkout:init:ip:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
    const { allowed } = await checkRateLimit(bucket, 20, 300);
    if (!allowed) return Response.redirect(`${base}/?checkout=muitas_tentativas`, 303);
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("platform_billing_plans" as never)
    .select("slug,name,price_cents,currency,active" as never)
    .eq("slug" as never, parsedSlug.data)
    .maybeSingle();
  const plan = data as unknown as
    | { slug: string; name: string; price_cents: number; currency: string; active: boolean }
    | null;
  if (!plan) {
    return Response.redirect(`${base}/?checkout=indisponivel`, 303);
  }
  const intentId = parsedForm.data.intent_key;
  const quantities = Object.fromEntries(ADDON_SLUGS.map((slug) => [slug, z.coerce.number().int().min(0).max(100).safeParse(form.get(`addon_${slug}`)).data ?? 0])) as Record<typeof ADDON_SLUGS[number], number>;
  const { data: existingIntent, error: existingError } = await admin
    .from("platform_checkout_intents" as never)
    .select("id,plan_slug,price_cents,currency,total_price_cents,addons_snapshot" as never)
    .eq("id" as never, intentId)
    .maybeSingle();
  if (existingError) {
    logger.error("[billing.stripe] falha ao consultar intenção de checkout", { plan: plan.slug });
    return Response.redirect(`${base}/?checkout=indisponivel`, 303);
  }
  const existing = existingIntent as unknown as
    | { id: string; plan_slug: string; price_cents: number; currency: string; total_price_cents: number | null; addons_snapshot: AddonSnapshot[] | null }
    | null;
  let intentSnapshot = existing;
  if (existing && existing.plan_slug !== plan.slug) {
    return Response.redirect(`${base}/?checkout=requisicao_invalida`, 303);
  }
  if (!existing) {
    if (!plan.active) return Response.redirect(`${base}/?checkout=indisponivel`, 303);
    const { data: catalogData, error: catalogError } = await admin.from("platform_billing_addons" as never)
      .select("slug,name,resource,units,price_cents,revision,active" as never).in("slug" as never, ADDON_SLUGS as unknown as string[]);
    if (catalogError) return Response.redirect(`${base}/?checkout=indisponivel`, 303);
    const addons = ((catalogData ?? []) as unknown as Array<{ slug: string; name: string; resource: string; units: number; price_cents: number; revision: number; active: boolean }>)
      .filter((addon): addon is typeof addon & { slug: typeof ADDON_SLUGS[number] } => ADDON_SLUGS.includes(addon.slug as typeof ADDON_SLUGS[number]) && addon.active && quantities[addon.slug as typeof ADDON_SLUGS[number]] > 0)
      .map((addon) => ({ ...addon, quantity: quantities[addon.slug] }));
    const totalPriceCents = plan.price_cents + addons.reduce((total, addon) => total + addon.price_cents * addon.quantity, 0);
    const { error: insertError } = await admin.from("platform_checkout_intents" as never).insert({
      id: intentId,
      plan_slug: plan.slug,
      price_cents: plan.price_cents,
      total_price_cents: totalPriceCents,
      addons_snapshot: addons,
      currency: plan.currency,
      status: "creating",
    } as never);
    if (insertError) {
      const { data: racedIntent } = await admin
        .from("platform_checkout_intents" as never)
        .select("plan_slug,price_cents,currency,total_price_cents,addons_snapshot" as never)
        .eq("id" as never, intentId)
        .maybeSingle();
      const raced = racedIntent as unknown as
        | { plan_slug: string; price_cents: number; currency: string; total_price_cents: number | null; addons_snapshot: AddonSnapshot[] | null }
        | null;
      if (!raced || raced.plan_slug !== plan.slug) {
        logger.error("[billing.stripe] falha ao persistir intenção de checkout", { plan: plan.slug });
        return Response.redirect(`${base}/?checkout=indisponivel`, 303);
      }
      intentSnapshot = { id: intentId, ...raced };
    } else {
      // A primeira compra também precisa usar o snapshot que acabou de ser
      // gravado. Sem atribuí-lo aqui, só tentativas repetidas levavam os
      // adicionais à Stripe — o card mostrava o total certo e o checkout não.
      intentSnapshot = {
        id: intentId,
        plan_slug: plan.slug,
        price_cents: plan.price_cents,
        currency: plan.currency,
        total_price_cents: totalPriceCents,
        addons_snapshot: addons,
      };
    }
  }

  const checkoutPrice = intentSnapshot?.price_cents ?? plan.price_cents;
  const checkoutCurrency = intentSnapshot?.currency ?? plan.currency;
  const selectedAddons = Array.isArray(intentSnapshot?.addons_snapshot) ? intentSnapshot.addons_snapshot : [];

  const user = await loadAuthUser().catch(() => null);
  const userId = user?.id ?? "guest";

  try {
    const session = await createCheckoutSession({
      planSlug: plan.slug,
      planName: plan.name,
      priceCents: checkoutPrice,
      currency: checkoutCurrency,
      customerEmail: user?.email ?? null,
      clientReferenceId: userId,
      metadata: { plan_slug: plan.slug, user_id: userId, checkout_intent_id: intentId, checkout_kind: "new_org" },
      successUrl: `${base}/checkout/sucesso`,
      cancelUrl: `${base}/#planos`,
      idempotencyKey: `checkout-${intentId}`,
      lineItems: [
        { name: plan.name, priceCents: checkoutPrice, quantity: 1, metadata: { plan_slug: plan.slug, kind: "base" } },
        ...selectedAddons.map((addon) => ({ name: addon.name, priceCents: addon.price_cents, quantity: addon.quantity, metadata: { addon_slug: addon.slug, kind: "addon" } })),
      ],
    });
    if (!session.url) throw new Error("stripe_session_sem_url");
    const { error: updateError } = await admin
      .from("platform_checkout_intents" as never)
      .update({ stripe_session_id: session.id, status: "open", last_error: null, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, intentId);
    if (updateError) throw new Error("checkout_intent_update_failed");
    return Response.redirect(session.url, 303);
  } catch (cause) {
    await admin
      .from("platform_checkout_intents" as never)
      .update({ status: "failed", last_error: "stripe_checkout_creation_failed", updated_at: new Date().toISOString() } as never)
      .eq("id" as never, intentId);
    logger.error("[billing.stripe] falha ao criar checkout session", {
      error: cause instanceof Error ? cause.message : "unknown",
      plan: plan.slug,
    });
    return Response.redirect(`${base}/?checkout=indisponivel`, 303);
  }
}
