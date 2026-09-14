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
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const state = {
  entry: { id: ENTRY_ID, direction: "receivable", status: "open" } as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
  inserted: { id: REQUEST_ID, status: "awaiting_provider", created_at: "2026-09-14T12:00:00.000Z" } as Record<string, unknown> | null,
  insertPayload: null as Record<string, unknown> | null,
  filters: [] as Array<[string, unknown]>,
};

function single(data: Record<string, unknown> | null) {
  return { data, error: null };
}

function adminStub() {
  return {
    from: (table: string) => {
      if (table === "finance_entries") {
        const query = {
          eq: vi.fn((field: string, value: unknown) => { state.filters.push([field, value]); return query; }),
          maybeSingle: vi.fn(async () => single(state.entry)),
        };
        return { select: vi.fn(() => query) };
      }
      const query = {
        eq: vi.fn((field: string, value: unknown) => { state.filters.push([field, value]); return query; }),
        maybeSingle: vi.fn(async () => single(state.existing)),
      };
      return {
        select: vi.fn(() => query),
        insert: vi.fn((payload: Record<string, unknown>) => {
          state.insertPayload = payload;
          return { select: vi.fn(() => ({ single: vi.fn(async () => single(state.inserted)) })) };
        }),
      };
    },
  };
}

function request(key?: string) {
  return new NextRequest("http://localhost/api/v1/financeiro/fiscal", {
    method: "POST",
    headers: key ? { "idempotency-key": key } : undefined,
    body: JSON.stringify({ entry_id: ENTRY_ID, municipality_code: "3550308", document_kind: "nfse", confirmation: true }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.entry = { id: ENTRY_ID, direction: "receivable", status: "open" };
  state.existing = null;
  state.inserted = { id: REQUEST_ID, status: "awaiting_provider", created_at: "2026-09-14T12:00:00.000Z" };
  state.insertPayload = null;
  state.filters = [];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG_ID }, user: { id: USER_ID } } as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
});

describe("POST /api/v1/financeiro/fiscal", () => {
  it("não consulta nem cria solicitação quando a autorização administrativa falha", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const { POST } = await import("./route");

    const response = await POST(request("chave-fiscal-1"));

    expect(response.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("exige Idempotency-Key antes de colocar uma nota na fila fiscal", async () => {
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("repete a mesma solicitação sem duplicar e sempre a busca na organização autenticada", async () => {
    const { POST } = await import("./route");
    const created = await POST(request("chave-fiscal-2"));
    expect(created.status).toBe(201);
    const fingerprint = state.insertPayload?.request_fingerprint;
    state.existing = { id: REQUEST_ID, status: "awaiting_provider", request_fingerprint: fingerprint! };
    state.insertPayload = null;
    const replay = await POST(request("chave-fiscal-2"));

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ data: { duplicate: true, request: { id: REQUEST_ID } } });
    expect(state.insertPayload).toBeNull();
    expect(state.filters).toContainEqual(["organization_id", ORG_ID]);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("cria com a organização e aprovação da sessão, nunca com dados controlados pelo body", async () => {
    const { POST } = await import("./route");
    const response = await POST(request("chave-fiscal-3"));

    expect(response.status).toBe(201);
    expect(state.insertPayload).toMatchObject({
      organization_id: ORG_ID,
      entry_id: ENTRY_ID,
      approved_by_user_id: USER_ID,
      idempotency_key: "chave-fiscal-3",
      status: "awaiting_provider",
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "finance.fiscal_requested", organizationId: ORG_ID }));
  });
});
