import { describe, it, expect } from "vitest";
import { DEFAULT_LANDING, landingSchema } from "./schema";
import { canSee } from "@/lib/navigation/interface";
describe("landing pública", () => {
  it("valida os padrões e mantém três planos contratáveis", () => {
    expect(landingSchema.safeParse(DEFAULT_LANDING).success).toBe(true);
    expect(DEFAULT_LANDING.pricing_note).toContain("contratação");
    expect(DEFAULT_LANDING.plans).toHaveLength(3);
    expect(DEFAULT_LANDING.plans.every((plan) => plan.price_cents > 0)).toBe(true);
    expect(DEFAULT_LANDING.addons.map((addon) => addon.price_cents)).toEqual([2999, 5900, 2900, 1999]);
    expect(DEFAULT_LANDING.billing.usage_alert_percent).toBe(80);
    expect(DEFAULT_LANDING.billing.hard_limit_percent).toBe(100);
    expect(DEFAULT_LANDING.credit_packs).toHaveLength(3);
    expect(DEFAULT_LANDING.addons.map((addon) => addon.price_cents)).toEqual([2999, 5900, 2900, 1999]);
    expect(DEFAULT_LANDING.billing.usage_alert_percent).toBe(80);
    expect(DEFAULT_LANDING.billing.hard_limit_percent).toBe(100);
    expect(DEFAULT_LANDING.credit_packs).toHaveLength(3);
  });
  it.each(["javascript:alert(1)", "//evil.test", "/\\evil.test", "http://evil.test", "https://user:pass@example.com"])("recusa CTA inseguro %s", cta_url => {
    expect(landingSchema.safeParse({ ...DEFAULT_LANDING, cta_url }).success).toBe(false);
  });
  it("não libera configurações públicas para administrador de tenant", () => {
    const entry = { href: "/app/settings/landing-page", minRole: "admin" as const };
    expect(canSee(entry, false, "admin")).toBe(false);
    expect(canSee(entry, true, null)).toBe(true);
  });
});
