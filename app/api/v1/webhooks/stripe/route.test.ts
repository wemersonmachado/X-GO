import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  audit: vi.fn(),
  sendPaidAccess: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  verifyStripeSignature: () => true,
  retrieveStripeCharge: vi.fn(),
}));
vi.mock("@/lib/billing/paid-access", () => ({ sendPaidAccess: mocks.sendPaidAccess }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, hashEmail: () => "a".repeat(64) }));
vi.mock("@/lib/env", () => ({ env: { STRIPE_WEBHOOK_SECRET: "whsec_test" } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mocks.rpc }),
}));

import { POST } from "./route";

const receipt = {
  eligible: true,
  created: false,
  organization_id: "24600000-0000-4000-8000-000000000010",
  organization_name: "Cliente",
  plan_name: "Standard",
  invite_id: "24600000-0000-4000-8000-000000000011",
  issued_at: 1_800_000_000,
  email_sent_at: null,
};

function request(id = "evt_1"): Request {
  return new Request("https://xgoos.com.br/api/v1/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "assinada" },
    body: JSON.stringify({
      id,
      type: "checkout.session.completed",
      created: 1_800_000_000,
      data: {
        object: {
          id: "cs_1",
          customer: "cus_1",
          subscription: "sub_1",
          payment_intent: "pi_1",
          payment_status: "paid",
          amount_total: 19700,
          metadata: {
            plan_slug: "standard",
            checkout_intent_id: "24600000-0000-4000-8000-000000000001",
          },
          customer_details: { email: "cliente@example.com", name: "Cliente" },
        },
      },
    }),
  });
}

function refundRequest(partial: boolean): Request {
  return new Request("https://xgoos.com.br/api/v1/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "assinada" },
    body: JSON.stringify({
      id: partial ? "evt_partial" : "evt_full",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          customer: "cus_1",
          payment_intent: "pi_1",
          amount: 19_700,
          amount_refunded: partial ? 5_000 : 19_700,
          refunded: !partial,
        },
      },
    }),
  });
}

describe("webhook Stripe durável", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.audit.mockReset();
    mocks.sendPaidAccess.mockReset();
  });

  it("marca falha e devolve 503 para a Stripe retentar quando a entrega falha", async () => {
    mocks.rpc.mockImplementation(async (name: string, args: { p_succeeded?: boolean }) => {
      if (name === "fn_claim_stripe_event") return { data: { claimed: true, state: "processing", attempt: 1 }, error: null };
      if (name === "fn_apply_paid_stripe_plan_bundle") return { data: receipt, error: null };
      if (name === "fn_finish_stripe_event") return { data: true, error: null, succeeded: args.p_succeeded };
      throw new Error(`RPC inesperada: ${name}`);
    });
    mocks.sendPaidAccess.mockResolvedValue({ sent: false, accessUrl: "https://xgoos.com.br/convite" });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_finish_stripe_event",
      expect.objectContaining({ p_event_id: "evt_1", p_attempt: 1, p_succeeded: false }),
    );
  });

  it("encerra cedo somente quando o evento já está completed", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { claimed: false, state: "completed", attempt: 1 }, error: null });

    const response = await POST(request("evt_completed"));

    expect(response.status).toBe(200);
    expect(mocks.sendPaidAccess).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("distingue reembolso parcial do reembolso integral", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "fn_claim_stripe_event") {
        return { data: { claimed: true, state: "processing", attempt: 1 }, error: null };
      }
      if (name === "fn_sync_stripe_subscription") {
        return {
          data: {
            matched: true,
            organization_id: "24600000-0000-4000-8000-000000000010",
            previous_status: "active",
            status: "active",
            organization_action: "none",
          },
          error: null,
        };
      }
      if (name === "fn_finish_stripe_event") return { data: true, error: null };
      throw new Error(`RPC inesperada: ${name}`);
    });

    expect((await POST(refundRequest(true))).status).toBe(200);
    expect((await POST(refundRequest(false))).status).toBe(200);

    const syncCalls = mocks.rpc.mock.calls.filter(([name]) => name === "fn_sync_stripe_subscription");
    expect(syncCalls[0]?.[1]).toEqual(expect.objectContaining({ p_status: "partially_refunded" }));
    expect(syncCalls[1]?.[1]).toEqual(expect.objectContaining({ p_status: "refunded" }));
  });
});
