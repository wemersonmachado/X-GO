import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cotas e adicionais Stripe", () => {
  const sql = readFileSync("supabase/migrations/20260916090000_0247_entitlements_e_adicionais_stripe.sql", "utf8");
  const webhook = readFileSync("app/api/v1/webhooks/stripe/route.ts", "utf8");
  const addonCheckout = readFileSync("app/checkout/addon/[slug]/route.ts", "utf8");

  it("mantém cotas no banco e protege cada recurso contra concorrência", () => {
    for (const resource of ["users", "whatsapp", "active_agents", "monthly_conversations"]) expect(sql).toContain(`'${resource}'`);
    expect(sql).toContain("for update");
    expect(sql).toContain("trg_plan_user_capacity");
    expect(sql).toContain("trg_plan_channel_capacity");
    expect(sql).toContain("trg_plan_agent_capacity");
    expect(sql).toContain("trg_plan_conversation_capacity");
  });

  it("vincula adicional à organização resolvida no servidor e não cria tenant", () => {
    expect(addonCheckout).toContain('requireRole("admin"');
    expect(addonCheckout).toContain("organization_id: auth.org.orgId");
    expect(webhook).toContain('checkoutKind === "addon"');
    expect(webhook).toContain("fn_apply_paid_stripe_addon");
  });

  it("cria a organização manual já com a cota do plano escolhido", () => {
    const creation = sql.slice(sql.indexOf("create or replace function public.fn_create_tenant_with_owner"));
    expect(creation).toContain("insert into public.organization_plan_entitlements");
    expect(creation).toContain("p_request->>'plan'");
  });

  it("mantém RPCs comerciais fora de anon/authenticated", () => {
    expect(sql).toContain("revoke all on function public.fn_plan_entitlements(uuid) from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.fn_apply_paid_stripe_addon");
  });

  it("não reconcilia a assinatura-base pelo customer Stripe", () => {
    const sync = sql.slice(sql.lastIndexOf("create or replace function public.fn_sync_stripe_subscription"));
    expect(sync).not.toContain("provider_customer_id = p_customer_id");
  });
});
