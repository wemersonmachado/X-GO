import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { createCheckoutSession } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const slugSchema = z.enum(["ai_credits_5000", "ai_credits_10000", "ai_credits_25000"]);
const formSchema = z.object({ intent_key: z.string().uuid() });

/** Compra avulsa de respostas de IA. O saldo só é creditado pelo webhook
 * assinado depois de a Stripe confirmar pagamento, nunca pelo redirect. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  if (request.headers.get("origin") !== new URL(base).origin) return Response.redirect(`${base}/app/settings/billing?checkout=origem_invalida`, 303);
  const auth = await requireRole("admin", { resource: "billing_credit_pack" });
  if (!auth.ok) return Response.redirect(`${base}/login?next=/app/settings/billing`, 303);
  const slug = slugSchema.safeParse((await params).slug);
  const form = formSchema.safeParse(Object.fromEntries(await request.formData().catch(() => new FormData())));
  if (!slug.success || !form.success) return Response.redirect(`${base}/app/settings/billing?checkout=requisicao_invalida`, 303);

  const admin = createAdminClient();
  const { data } = await admin.from("platform_billing_credit_packs" as never)
    .select("slug,name,credits,price_cents,revision,active" as never).eq("slug" as never, slug.data).maybeSingle();
  const pack = data as unknown as { slug: string; name: string; credits: number; price_cents: number; revision: number; active: boolean } | null;
  if (!pack?.active) return Response.redirect(`${base}/app/settings/billing?checkout=indisponivel`, 303);
  const { error } = await admin.from("platform_checkout_intents" as never).insert({
    id: form.data.intent_key, plan_slug: null, price_cents: pack.price_cents, total_price_cents: pack.price_cents,
    currency: "BRL", status: "creating", kind: "credit_pack", organization_id: auth.org.orgId,
    actor_user_id: auth.user.id, credit_pack_slug: pack.slug, catalog_revision: pack.revision,
  } as never);
  if (error) return Response.redirect(`${base}/app/settings/billing?checkout=indisponivel`, 303);
  try {
    const session = await createCheckoutSession({
      planSlug: pack.slug, planName: pack.name, priceCents: pack.price_cents, currency: "BRL", mode: "payment",
      clientReferenceId: auth.user.id,
      metadata: { checkout_intent_id: form.data.intent_key, checkout_kind: "credit_pack", credit_pack_slug: pack.slug, organization_id: auth.org.orgId },
      successUrl: `${base}/checkout/sucesso`, cancelUrl: `${base}/app/settings/billing`, idempotencyKey: `credits-${form.data.intent_key}`,
    });
    if (!session.url) throw new Error("stripe_session_sem_url");
    await admin.from("platform_checkout_intents" as never).update({ stripe_session_id: session.id, status: "open", updated_at: new Date().toISOString() } as never).eq("id" as never, form.data.intent_key);
    return Response.redirect(session.url, 303);
  } catch (cause) {
    await admin.from("platform_checkout_intents" as never).update({ status: "failed", last_error: "stripe_checkout_creation_failed", updated_at: new Date().toISOString() } as never).eq("id" as never, form.data.intent_key);
    logger.error("[billing.stripe] falha ao criar checkout de créditos", { pack: pack.slug, reason: cause instanceof Error ? cause.message : "unknown" });
    return Response.redirect(`${base}/app/settings/billing?checkout=indisponivel`, 303);
  }
}
