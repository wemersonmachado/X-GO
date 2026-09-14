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
const ENTRY_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const state = {
  owner: { id: ENTRY_ID } as Record<string, unknown> | null,
  document: { id: DOCUMENT_ID, file_name: "nota.pdf", mime_type: "application/pdf", size_bytes: 5, created_at: "2026-09-14T12:00:00.000Z" } as Record<string, unknown> | null,
  insertPayload: null as Record<string, unknown> | null,
  filters: [] as Array<[string, unknown]>,
  uploaded: [] as Array<[string, Uint8Array, Record<string, unknown>]>,
};

function adminStub() {
  const storage = {
    upload: vi.fn(async (path: string, bytes: Uint8Array, options: Record<string, unknown>) => { state.uploaded.push([path, bytes, options]); return { error: null }; }),
    remove: vi.fn(async () => ({ error: null })),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://files.invalid/signed" }, error: null })),
  };
  return {
    from: (table: string) => {
      const query = {
        eq: vi.fn((field: string, value: unknown) => { state.filters.push([field, value]); return query; }),
        maybeSingle: vi.fn(async () => ({ data: table === "finance_entries" ? state.owner : state.document, error: null })),
        order: vi.fn(() => query), limit: vi.fn(async () => ({ data: [], error: null })),
      };
      return {
        select: vi.fn(() => query),
        insert: vi.fn((payload: Record<string, unknown>) => {
          state.insertPayload = payload;
          return { select: vi.fn(() => ({ single: vi.fn(async () => ({ data: state.document, error: null })) })) };
        }),
      };
    },
    storage: { from: vi.fn(() => storage) },
  };
}

function postFile(bytes: Uint8Array, type = "application/pdf") {
  const form = new FormData();
  form.set("entry_id", ENTRY_ID);
  form.set("file", new File([bytes as BlobPart], "nota.pdf", { type }));
  return new NextRequest("http://localhost/api/v1/financeiro/documentos", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.owner = { id: ENTRY_ID };
  state.document = { id: DOCUMENT_ID, file_name: "nota.pdf", mime_type: "application/pdf", size_bytes: 5, created_at: "2026-09-14T12:00:00.000Z" };
  state.insertPayload = null;
  state.filters = [];
  state.uploaded = [];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG_ID }, user: { id: USER_ID } } as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
});

describe("POST /api/v1/financeiro/documentos", () => {
  it("não aceita arquivo que só declara MIME permitido, sem assinatura correspondente", async () => {
    const { POST } = await import("./route");
    const response = await POST(postFile(new TextEncoder().encode("não é PDF")));

    expect(response.status).toBe(415);
    expect(state.uploaded).toEqual([]);
    expect(state.insertPayload).toBeNull();
  });

  it("guarda PDF assinado abaixo do prefixo da organização e registra o dono validado", async () => {
    const { POST } = await import("./route");
    const response = await POST(postFile(new TextEncoder().encode("%PDF-1.7")));

    expect(response.status).toBe(201);
    expect(state.filters).toContainEqual(["organization_id", ORG_ID]);
    expect(state.uploaded[0]![0]).toMatch(new RegExp(`^${ORG_ID}/`));
    expect(state.uploaded[0]![2]).toEqual({ contentType: "application/pdf", upsert: false });
    expect(state.insertPayload).toMatchObject({ organization_id: ORG_ID, entry_id: ENTRY_ID, created_by_user_id: USER_ID, mime_type: "application/pdf" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "finance.document_uploaded", organizationId: ORG_ID }));
  });
});
