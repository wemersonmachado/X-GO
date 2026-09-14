import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const banco = vi.hoisted(() => ({
  linhas: [] as Array<{ id: string; amount_cents: number }>,
  intervalos: [] as Array<[number, number]>,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ ok: true, org: { orgId: "org-a" }, user: { id: "user-a" } })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => {
        const query = {
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: (inicio: number, fim: number) => {
            banco.intervalos.push([inicio, fim]);
            return Promise.resolve({
              data: banco.linhas.slice(inicio, fim + 1),
              count: banco.linhas.length,
              error: null,
            });
          },
        };
        return query;
      },
    }),
  }),
}));

import { GET } from "./route";

beforeEach(() => {
  banco.linhas = [];
  banco.intervalos = [];
});

describe("GET financeiro", () => {
  it("inclui o lançamento 501 para que o saldo da tela não fique incompleto", async () => {
    banco.linhas = Array.from({ length: 501 }, (_, i) => ({ id: String(i), amount_cents: 100 }));

    const response = await GET(new NextRequest("http://localhost/api/v1/financeiro/lancamentos"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.entries).toHaveLength(501);
    expect(body.data.entries[500].id).toBe("500");
    expect(banco.intervalos).toEqual([[0, 499], [500, 999]]);
  });
});
