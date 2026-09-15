"use server";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { mfaEmDivida } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { landingSchema } from "./schema";

/**
 * Checkout é 100% dinâmico (Stripe Checkout Session com `price_data` inline,
 * ver `app/checkout/[slug]/route.ts`) — não existe link fixo pra sincronizar.
 * Salvar aqui já É a publicação: o próximo clique em "Contratar" já cobra o
 * `price_cents` novo, sem chamada externa nenhuma.
 */
export async function saveLanding(input: unknown) {
  const { user, platformAdmin } = await requirePlatformAdmin();
  if (platformAdmin.scope !== "full" || await mfaEmDivida()) return { error: "Acesso administrativo completo e sessão verificada são necessários." };
  const parsed = landingSchema.safeParse(input);
  if (!parsed.success) return { error: `Confira os campos: ${parsed.error.issues.map(i => i.path.join(".")).join(", ")}` };
  const published = parsed.data;
  const admin = createAdminClient();
  const { error: planError } = await admin.from("platform_billing_plans" as never).upsert(
    parsed.data.plans.map((plan) => ({ slug: plan.slug, name: plan.name, price_cents: plan.price_cents, currency: "BRL", billing_cycle: "MONTHLY", active: true })) as never,
    { onConflict: "slug" } as never,
  );
  if (planError) return { error: "Não foi possível salvar os planos. Tente novamente." };
  const { error } = await admin.from("platform_branding").update({ landing_page: published } as never).eq("id", 1).select("id").single();
  if (error) return { error: "Não foi possível salvar. Tente novamente; suas alterações continuam no formulário." };
  await audit({ action: "platform_branding.updated", actorUserId: user.id, resourceType: "platform_branding", actingAsPlatformAdmin: true, metadata: { area: "landing_page" } });
  revalidatePath("/");
  revalidatePath("/app/settings/landing-page");
  return { success: true };
}
