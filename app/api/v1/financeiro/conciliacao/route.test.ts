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
const MOVEMENT_ID = "33333333-3333-4333-8333-333333333333";
const ENTRY_ID = "44444444-4444-4444-8444-444444444444";
const rpc = vi.fn();

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/financeiro/conciliacao", { method: "PATCH", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG_ID }, user: { id: USER_ID } } as never);
  rpc.mockResolvedValue({ data: { id: MOVEMENT_ID, status: "matched" }, error: null });
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
});

describe("PATCH /api/v1/financeiro/conciliacao", () => {
  it("recusa match sem lançamento e não aciona a função privilegiada", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(request({ movement_id: MOVEMENT_ID, action: "match", entry_id: null, revision: 1, confirmation: true }));

    expect(response.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("concilia apenas pelo RPC atômico com organização e ator obtidos da sessão", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(request({ movement_id: MOVEMENT_ID, action: "match", entry_id: ENTRY_ID, revision: 3, confirmation: true }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_finance_reconcile_movement", {
      p_org: ORG_ID, p_movement: MOVEMENT_ID, p_entry: ENTRY_ID,
      p_action: "match", p_revision: 3, p_actor: USER_ID,
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "finance.transaction_reconciled", organizationId: ORG_ID }));
  });

  it("traduz corrida de reconciliação em conflito, sem expor o erro do banco", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505" } });
    const { PATCH } = await import("./route");
    const response = await PATCH(request({ movement_id: MOVEMENT_ID, action: "ignore", entry_id: null, revision: 1, confirmation: true }));

    expect(response.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});
