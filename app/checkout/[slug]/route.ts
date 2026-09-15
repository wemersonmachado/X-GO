import { createHash } from "node:crypto";

import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { loadAuthUser } from "@/lib/auth/server";
import { createCheckoutSession } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const slugSchema = z.enum(["standard", "pro", "enterprise"]);

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || null;
}

/**
 * Redireciona pro Checkout hospedado da Stripe. `price_data` é montado na
 * hora com o `price_cents` ATUAL de `platform_billing_plans` — não existe
 * link fixo nem sincronização: o super admin muda o preço em Configurações
 * da landing e o próximo clique aqui já cobra o valor novo.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const { slug } = await params;
  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return Response.redirect(`${base}/?checkout=plano_invalido`, 303);
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
  if (!plan || !plan.active) {
    return Response.redirect(`${base}/?checkout=indisponivel`, 303);
  }

  const user = await loadAuthUser().catch(() => null);
  const userId = user?.id ?? "guest";

  try {
    const session = await createCheckoutSession({
      planSlug: plan.slug,
      planName: plan.name,
      priceCents: plan.price_cents,
      currency: plan.currency,
      customerEmail: user?.email ?? null,
      clientReferenceId: userId,
      metadata: { plan_slug: plan.slug, user_id: userId },
      successUrl: `${base}/checkout/sucesso`,
      cancelUrl: `${base}/#planos`,
    });
    if (!session.url) throw new Error("stripe_session_sem_url");
    return Response.redirect(session.url, 303);
  } catch (cause) {
    logger.error("[billing.stripe] falha ao criar checkout session", {
      error: cause instanceof Error ? cause.message : "unknown",
      plan: plan.slug,
    });
    return Response.redirect(`${base}/?checkout=indisponivel`, 303);
  }
}
