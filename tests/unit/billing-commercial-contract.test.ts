import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20260917003420_planos_alertas_creditos_anual.sql", "utf8");
const baseline = readFileSync("supabase/baseline.sql", "utf8");

describe("contrato comercial de billing", () => {
  it("mantém os preços novos no catálogo versionado", () => {
    expect(migration).toContain("slug='extra_user' and price_cents=3900");
    expect(migration).toContain("set price_cents=2999");
    expect(migration).toContain("set price_cents=5900");
    expect(migration).toContain("set price_cents=2900");
    expect(migration).toContain("set price_cents=1999");
  });

  it("protege saldo, preferência e excedente por RLS", () => {
    for (const table of ["organization_ai_credit_balances", "organization_ai_credit_ledger", "organization_billing_preferences", "organization_usage_overages"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(migration).toContain("fn_apply_paid_stripe_credit_pack");
    expect(migration).toContain("on conflict(provider_payment_id)");
  });

  it("leva a mesma alteração para instalações novas", () => {
    expect(baseline).toContain("BEGIN 0249 planos, alertas, creditos e anual");
    expect(baseline).toContain("fn_apply_paid_stripe_credit_pack");
  });
});
