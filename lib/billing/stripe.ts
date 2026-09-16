import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

function configured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** Stripe só aceita `application/x-www-form-urlencoded`, com colchetes pra
 * estrutura aninhada (`line_items[0][price_data][currency]=brl`). Sem SDK
 * oficial neste projeto (mesma escolha já feita pro Asaas) — serializa à mão. */
function toStripeForm(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  function walk(value: unknown, prefix: string) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${prefix}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, prefix ? `${prefix}[${key}]` : key);
      }
      return;
    }
    params.append(prefix, String(value));
  }
  for (const [key, value] of Object.entries(input)) walk(value, key);
  return params;
}

async function stripeApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!configured()) throw new Error("stripe_not_configured");
  const response = await fetch(`${env.STRIPE_API_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`stripe_http_${response.status}:${body.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

export interface StripeChargeReference {
  id: string;
  customer: string | { id?: string } | null;
  payment_intent: string | { id?: string } | null;
}

export async function retrieveStripeCharge(chargeId: string): Promise<StripeChargeReference> {
  return stripeApi<StripeChargeReference>(`/charges/${encodeURIComponent(chargeId)}`, {
    method: "GET",
  });
}

/** Preço vem SEMPRE do chamador (lido do banco na hora do clique) — nunca de
 * um Price/Product pré-criado na Stripe. Isso é o que torna o link dinâmico:
 * o super admin muda `price_cents` e o próximo checkout já cobra o valor
 * novo, sem sincronizar nada com a Stripe. */
export async function createCheckoutSession(input: {
  planSlug: string;
  planName: string;
  priceCents: number;
  currency: string;
  customerEmail?: string | null;
  clientReferenceId: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}): Promise<StripeCheckoutSession> {
  const body = toStripeForm({
    mode: "subscription",
    // Sem isto, a Stripe tenta detectar métodos automaticamente a partir do
    // dashboard da conta — e uma conta nova, sem nada ativado pra BRL, rejeita
    // a sessão inteira com 400 ("No valid payment method types"). `card`
    // funciona em qualquer conta Stripe sem ativação prévia; boleto foi
    // habilitado em Settings › Payment methods em 2026-09-15. Pix segue de
    // fora — conta BR só ganha acesso por convite da Stripe.
    //
    // Boleto é ASSÍNCRONO: `checkout.session.completed` dispara na hora em
    // que o cliente GERA o boleto, não quando ele PAGA — `payment_status`
    // vem "unpaid" nesse momento. A confirmação de dinheiro de verdade chega
    // depois, em `checkout.session.async_payment_succeeded` (dias depois,
    // fora do processo de checkout). O webhook (route.ts) trata os dois
    // eventos e só provisiona quando `payment_status === "paid"` — sem essa
    // checagem, gerar um boleto e nunca pagar liberaria acesso na hora.
    payment_method_types: ["card", "boleto"],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.clientReferenceId,
    customer_email: input.customerEmail || undefined,
    metadata: input.metadata,
    subscription_data: { metadata: input.metadata },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: input.priceCents,
          recurring: { interval: "month" },
          product_data: { name: input.planName, metadata: { plan_slug: input.planSlug } },
        },
      },
    ],
  });
  return stripeApi<StripeCheckoutSession>("/checkout/sessions", {
    method: "POST",
    body,
    headers: { "idempotency-key": input.idempotencyKey },
  });
}

/** Limpeza de sessão de teste: encerra sem esperar expirar sozinha (24h). */
export async function expireCheckoutSession(sessionId: string): Promise<void> {
  await stripeApi(`/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, { method: "POST" });
}

/**
 * Formato do header `Stripe-Signature`: `t=<unix>,v1=<hex>[,v1=<hex>...]`.
 * Assinatura = HMAC-SHA256(secret, `${t}.${rawBody}`). Compara em tempo
 * constante contra CADA v1 (a Stripe pode mandar mais de um durante rotação
 * de secret) e rejeita timestamp fora da tolerância (replay).
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!header || !secret) return false;
  const parts = new Map<string, string[]>();
  for (const segment of header.split(",")) {
    const [key, value] = segment.split("=");
    if (!key || !value) continue;
    const list = parts.get(key) ?? [];
    list.push(value);
    parts.set(key, list);
  }
  const timestamp = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!timestamp || signatures.length === 0) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected);
  return signatures.some((candidate) => {
    const candidateBuf = Buffer.from(candidate);
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(expectedBuf, candidateBuf);
  });
}

export function stripeConfigured(): boolean {
  return configured();
}
