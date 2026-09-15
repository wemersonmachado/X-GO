import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyStripeSignature } from "./stripe";

const SECRET = "whsec_test_" + "a".repeat(24);

function sign(body: string, secret: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

describe("verifyStripeSignature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const now = () => Math.floor(Date.now() / 1000);

  it("aceita assinatura válida dentro da tolerância", () => {
    expect(verifyStripeSignature(body, sign(body, SECRET, now()), SECRET)).toBe(true);
  });

  it("rejeita quando o secret não bate", () => {
    expect(verifyStripeSignature(body, sign(body, SECRET, now()), "whsec_outro_" + "b".repeat(20))).toBe(false);
  });

  it("rejeita corpo adulterado (mesma assinatura, payload diferente)", () => {
    const header = sign(body, SECRET, now());
    expect(verifyStripeSignature(body + "x", header, SECRET)).toBe(false);
  });

  it("rejeita timestamp fora da tolerância (replay)", () => {
    const old = now() - 3600;
    expect(verifyStripeSignature(body, sign(body, SECRET, old), SECRET)).toBe(false);
  });

  it("rejeita header ausente ou vazio", () => {
    expect(verifyStripeSignature(body, null, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, "", SECRET)).toBe(false);
  });

  it("rejeita header sem v1 ou sem t", () => {
    expect(verifyStripeSignature(body, `t=${now()}`, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, "v1=abcdef", SECRET)).toBe(false);
  });

  it("aceita quando qualquer um dos v1 múltiplos bate (rotação de secret)", () => {
    const t = now();
    const good = sign(body, SECRET, t).split(",")[1];
    const header = `t=${t},v1=deadbeef,${good}`;
    expect(verifyStripeSignature(body, header, SECRET)).toBe(true);
  });
});
