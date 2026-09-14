// @vitest-environment node
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
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const BATCH_ID = "44444444-4444-4444-8444-444444444444";
const state = {
  filters: [] as Array<[string, unknown]>,
  rpc: [] as Array<[string, Record<string, unknown>]>,
  rpcResult: { data: { batch_id: BATCH_ID, duplicate: true }, error: null as { code: string } | null },
};

function adminStub() {
  return {
    from: (_table: string) => {
      const query = {
        eq: vi.fn((field: string, value: unknown) => { state.filters.push([field, value]); return query; }),
        maybeSingle: vi.fn(async () => ({ data: { id: ACCOUNT_ID, active: true, currency: "BRL" }, error: null })),
      };
      return { select: vi.fn(() => query) };
    },
    rpc: vi.fn(async (name: string, input: Record<string, unknown>) => {
      state.rpc.push([name, input]);
      return state.rpcResult;
    }),
  };
}

function request() {
  const form = new FormData();
  form.set("account_id", ACCOUNT_ID);
  form.set("file", new File(["id,data,descricao,valor\nmov-1,14/09/2026,Recebimento,\"10,00\""], "extrato.csv", { type: "text/csv" }));
  return new NextRequest("http://localhost/api/v1/financeiro/extratos", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.filters = [];
  state.rpc = [];
  state.rpcResult = { data: { batch_id: BATCH_ID, duplicate: true }, error: null };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG_ID }, user: { id: USER_ID } } as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
});

describe("POST /api/v1/financeiro/extratos", () => {
  it("deduplica o mesmo extrato por conta e organização, sem criar movimentos novamente", async () => {
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.filters).toContainEqual(["organization_id", ORG_ID]);
    expect(state.filters).toContainEqual(["id", ACCOUNT_ID]);
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0]).toMatchObject(["fn_finance_import_statement", {
      p_org: ORG_ID, p_account: ACCOUNT_ID, p_actor: USER_ID, p_format: "csv",
      p_movements: [{ external_id: "mov-1", amount_cents: 1000, direction: "receivable" }],
    }]);
    expect(await response.json()).toMatchObject({ data: { batch_id: BATCH_ID, duplicate: true, count: 0 } });
    expect(audit).not.toHaveBeenCalled();
  });

  it("não abre o multipart quando a autorização falha", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) } as never);
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("converte FITID repetido com dados divergentes em conflito, sem auditar", async () => {
    state.rpcResult = { data: null, error: { code: "23505" } } as never;
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
    expect(audit).not.toHaveBeenCalled();
  });
});
