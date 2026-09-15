import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_LANDING, landingSchema } from "@/landing-page/schema";

describe("contrato de cobrança e exclusões", () => {
  it("mantém três planos mensais com centavos, slugs únicos e checkout isolado", () => {
    expect(landingSchema.parse(DEFAULT_LANDING)).toEqual(DEFAULT_LANDING);
    expect(DEFAULT_LANDING.plans.map((plan) => plan.slug)).toEqual(["standard", "pro", "enterprise"]);
    expect(new Set(DEFAULT_LANDING.plans.map((plan) => plan.payment_link_id)).size).toBe(2);
    expect(DEFAULT_LANDING.plans.every((plan) => Number.isInteger(plan.price_cents) && plan.price_cents > 0)).toBe(true);
  });

  it("protege webhook Stripe, idempotência e privilégios das tabelas financeiras", () => {
    const route = readFileSync("app/api/v1/webhooks/stripe/route.ts", "utf8");
    const client = readFileSync("lib/billing/stripe.ts", "utf8");
    const migration = readFileSync("supabase/migrations/20260910230000_0237_billing_asaas_e_exclusoes_definitivas.sql", "utf8");
    const migrationStripe = readFileSync("supabase/migrations/20260915140000_0245_billing_stripe_x_go.sql", "utf8");
    expect(client).toContain("timingSafeEqual");
    expect(route).toContain("stripe-signature");
    expect(route).not.toContain("cpf");
    expect(migration).toContain("event_id text primary key");
    expect(migration).toMatch(/revoke all on public\.platform_billing_plans[\s\S]+from public, anon, authenticated/);
    expect(migrationStripe).toContain("grant execute on function public.fn_record_stripe_event");
    expect(migrationStripe).toContain("grant execute on function public.fn_provision_paid_checkout");
  });

  it("exclusão definitiva é atômica e não deixa o agente na lista de arquivados", () => {
    const migration = readFileSync("supabase/migrations/20260910230000_0237_billing_asaas_e_exclusoes_definitivas.sql", "utf8");
    const actions = readFileSync("app/app/ai/agents/_actions.ts", "utf8");
    expect(migration).toContain("fn_delete_ai_agent_definitive");
    expect(migration).toContain("on delete cascade");
    expect(actions).toContain("ai_agent.deleted");
  });

  it("Inbox oferece silenciamento e seleção destrutiva explícita", () => {
    const list = readFileSync("components/inbox/ConversationList.tsx", "utf8");
    expect(list).toContain("Silenciar alertas");
    expect(list).toContain("Selecionar contatos");
    expect(list).toContain("EXCLUIR_TODOS_OS_CONTATOS");
  });
});
