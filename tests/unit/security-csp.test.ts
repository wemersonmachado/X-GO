import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "@/lib/security/csp";

describe("CSP de runtime", () => {
  it("exige nonce de scripts em produção e bloqueia objetos/framing", () => {
    const csp = contentSecurityPolicy("nonce-teste", "https://example.supabase.co", true);
    expect(csp).toContain("'nonce-nonce-teste' 'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp.split(";").find((s) => s.trim().startsWith("script-src"))).not.toContain("'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://checkout.stripe.com");
    expect(csp).toContain("wss://example.supabase.co");
  });
  it("mantém instalação HTTP local e não força HTTPS em todos os subdomínios", () => {
    const csp = contentSecurityPolicy("test", "http://localhost:54321", false);
    expect(csp).toContain("ws://localhost:54321");
    // O logo vem do bucket público do Storage. No ambiente local ele está em
    // outra origem HTTP, então `img-src` precisa aceitar somente esta origem,
    // nunca o esquema `http:` inteiro.
    expect(csp).toContain("img-src 'self' https: http://localhost:54321 data: blob:");
    expect(csp).not.toContain("img-src 'self' https: http: data: blob:");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
