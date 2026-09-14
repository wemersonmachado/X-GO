import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const rpc = vi.fn();

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/financeiro/propostas", { method: "PATCH", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG_ID }, user: { id: USER_ID } } as never);
  rpc.mockResolvedValue({ data: { id: PROPOSAL_ID, operation: "entry", revision: 2, status: "approved" }, error: null });
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
});

describe("PATCH /api/v1/financeiro/propostas", () => {
  it("exige confirmação explícita antes de aprovar ou rejeitar uma proposta", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(request({ id: PROPOSAL_ID, action: "approve", revision: 1 }));

    expect(response.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("aprova pelo RPC transacional com organização, ator e revisão da sessão", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(request({ id: PROPOSAL_ID, action: "approve", revision: 1, confirmation: true }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_finance_decide_proposal", {
      p_org: ORG_ID, p_id: PROPOSAL_ID, p_action: "approve", p_revision: 1, p_actor: USER_ID,
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "finance.proposal_approved", organizationId: ORG_ID }));
  });

  it("não permite que proposta desatualizada seja aprovada", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "40001" } });
    const { PATCH } = await import("./route");
    const response = await PATCH(request({ id: PROPOSAL_ID, action: "reject", revision: 1, confirmation: true }));

    expect(response.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});
