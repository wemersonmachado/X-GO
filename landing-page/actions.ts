"use server";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { mfaEmDivida } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { landingSchema } from "./schema";

const PLAN_CAPABILITIES = {
  standard: ["shared_inbox", "crm", "mcp"],
  pro: ["shared_inbox", "crm", "mcp", "advanced_automation", "advanced_reports", "ai_workflows"],
  enterprise: ["shared_inbox", "crm", "mcp", "advanced_automation", "advanced_reports", "ai_workflows", "sso", "priority_support", "customization", "multiple_workspaces"],
} as const;

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
    parsed.data.plans.map((plan) => ({
      slug: plan.slug, name: plan.name, price_cents: plan.price_cents, limits: plan.limits,
      currency: "BRL", billing_cycle: "MONTHLY", active: true, revision: new Date().getTime(),
      annual_discount_percent: published.billing.annual_discount_percent,
      trial_days: published.billing.trial_days,
      features: { capabilities: PLAN_CAPABILITIES[plan.slug], display: plan.features },
    })) as never,
    { onConflict: "slug" } as never,
  );
  if (planError) return { error: "Não foi possível salvar os planos. Tente novamente." };
  const { error: addonError } = await admin.from("platform_billing_addons" as never).upsert(
    published.addons.map((addon) => ({ ...addon, revision: new Date().getTime() })) as never,
    { onConflict: "slug" } as never,
  );
  if (addonError) return { error: "Não foi possível salvar os adicionais. Tente novamente." };
  const { error: packError } = await admin.from("platform_billing_credit_packs" as never).upsert(
    published.credit_packs.map((pack) => ({
      slug: pack.slug, name: pack.name, credits: pack.units, price_cents: pack.price_cents,
      active: pack.active, revision: new Date().getTime(), updated_at: new Date().toISOString(),
    })) as never,
    { onConflict: "slug" } as never,
  );
  if (packError) return { error: "Não foi possível salvar os pacotes de créditos. Tente novamente." };
  const { error: policyError } = await admin.from("platform_billing_policy" as never).upsert({
    id: 1,
    usage_alert_percent: published.billing.usage_alert_percent,
    hard_limit_percent: published.billing.hard_limit_percent,
    overage_unit_price_cents: published.billing.overage_unit_price_cents,
    outcome_billing_enabled: published.billing.outcome_billing_enabled,
    outcome_price_cents: published.billing.outcome_price_cents,
    meta_fees_notice: published.billing.meta_fees_notice,
    updated_at: new Date().toISOString(),
  } as never, { onConflict: "id" } as never);
  if (policyError) return { error: "Não foi possível salvar a política comercial. Tente novamente." };
  const { error } = await admin.from("platform_branding").update({ landing_page: published } as never).eq("id", 1).select("id").single();
  if (error) return { error: "Não foi possível salvar. Tente novamente; suas alterações continuam no formulário." };
  await audit({ action: "platform_branding.updated", actorUserId: user.id, resourceType: "platform_branding", actingAsPlatformAdmin: true, metadata: { area: "landing_page" } });
  revalidatePath("/");
  revalidatePath("/app/settings/landing-page");
  return { success: true };
}
