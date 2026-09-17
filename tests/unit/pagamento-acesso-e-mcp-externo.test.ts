import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildPaidAccessEmail } from "@/lib/email/templates/paid-access";

describe("pagamento confirmado e conexão externa", () => {
  it("o e-mail confirmado leva à criação de senha sem expor HTML injetável", () => {
    const message = buildPaidAccessEmail({
      accessUrl: "https://xgoos.com.br/team/accept-invite/token",
      organizationName: '<script>alert("x")</script>',
      planName: "Pro",
      expiresAt: new Date("2026-09-11T15:00:00Z"),
      marca: {
        nome: "X-GO",
        logoUrl: null,
        accent: "#123456",
        accentFg: "#ffffff",
        origens: { nome: "padrao", cor: "padrao" },
      },
    });
    expect(message.subject).toContain("Pagamento confirmado");
    expect(message.html).toContain("Criar senha e acessar");
    expect(message.html).not.toContain("<script>");
    expect(message.text).toContain("/team/accept-invite/");
  });

  it("provisionamento é idempotente, confere snapshot e não persiste e-mail aberto", () => {
    const sql = readFileSync(
      "supabase/migrations/20260911120000_0238_acesso_apos_pagamento.sql",
      "utf8",
    );
    expect(sql).toContain("purchase_key text primary key");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("v_plan.price_cents <> p_value_cents");
    const stripeSql = readFileSync(
      "supabase/migrations/20260915220000_0246_stripe_processamento_duravel.sql",
      "utf8",
    );
    expect(stripeSql).toContain("unknown_checkout_intent");
    expect(stripeSql).toContain("checkout_snapshot_mismatch");
    expect(sql).toContain("email_hash text not null");
    expect(sql).not.toMatch(/\bemail\s+text\b/);
    expect(sql).toMatch(/revoke all on public\.platform_checkout_access[\s\S]+authenticated/);
  });

  it("webhook só libera em confirmação financeira e exige dados reconciliáveis", () => {
    const route = readFileSync("app/api/v1/webhooks/stripe/route.ts", "utf8");
    expect(route).toContain('"checkout.session.completed"');
    expect(route).toContain("verifyStripeSignature");
    expect(route).toContain("fn_apply_paid_stripe_plan_bundle");
    expect(route).toContain("sendPaidAccess");
    expect(route).toContain("fn_finish_stripe_event");
    expect(route).toContain("fn_sync_stripe_subscription");
    expect(route).not.toContain("return ok({ received: true, access_provisioned: false });");
  });

  it("a tela entrega o endpoint MCP, bearer e sequência de prova sem mandar ao painel humano", () => {
    const guide = readFileSync(
      "app/app/settings/api-tokens/_components/McpConnectionGuide.tsx",
      "utf8",
    );
    const page = readFileSync("app/app/settings/api-tokens/page.tsx", "utf8");
    expect(page).toContain("/api/mcp`");
    expect(guide).toContain("Authorization");
    expect(guide).toContain("Bearer COLE_AQUI_O_TOKEN_DSK");
    expect(guide).toContain("crm_get_agent_configuration");
    expect(guide).toContain("tools/list");
    expect(guide).toContain("/app/connections");
  });
});
