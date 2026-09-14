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
const ENTRY_ID = "33333333-3333-4333-8333-333333333333";
const CHART_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const rpc = vi.fn();

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/financeiro/classificacao", {
    method: "PATCH", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, org: { orgId: ORG_ID }, user: { id: USER_ID },
  } as never);
  rpc.mockResolvedValue({ data: {
    id: ENTRY_ID, revision: 4, chart_account_id: CHART_ID,
    competence_date: "2026-09-15", account_id: ACCOUNT_ID,
  }, error: null });
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
});

describe("PATCH /api/v1/financeiro/classificacao", () => {
  it("exige a escolha explícita da conta financeira, inclusive quando nula", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(request({
      id: ENTRY_ID, revision: 3, chart_account_id: CHART_ID, competence_date: "2026-09-15",
    }));

    expect(response.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("classifica e atribui a conta pelo RPC atômico com organização e ator da sessão", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(request({
      id: ENTRY_ID, revision: 3, chart_account_id: CHART_ID,
      competence_date: "2026-09-15", account_id: ACCOUNT_ID,
    }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_finance_classify_entry", {
      p_org: ORG_ID, p_id: ENTRY_ID, p_revision: 3, p_actor: USER_ID,
      p_chart_account: CHART_ID, p_competence_date: "2026-09-15", p_account: ACCOUNT_ID,
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "finance.entry_classified", organizationId: ORG_ID,
      metadata: expect.objectContaining({ account_id: ACCOUNT_ID }),
    }));
  });

  it("impede trocar a conta de um lançamento já conciliado", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23514" } });
    const { PATCH } = await import("./route");
    const response = await PATCH(request({
      id: ENTRY_ID, revision: 3, chart_account_id: null,
      competence_date: null, account_id: ACCOUNT_ID,
    }));

    expect(response.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});
