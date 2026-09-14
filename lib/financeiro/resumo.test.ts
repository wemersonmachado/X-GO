import { describe, expect, it } from "vitest";

import { resumirFinanceiro } from "./resumo";
import { alterarSituacaoSchema, criarLancamentoSchema } from "./schemas";
import type { LancamentoFinanceiro } from "./tipos";

const base: LancamentoFinanceiro = {
  id: "00000000-0000-4000-8000-000000000001", direction: "receivable", status: "open",
  description: "Venda", amount_cents: 10_000, currency: "BRL", due_date: "2026-09-10",
  notes: null, source: "manual", settled_amount_cents: null, settled_at: null, revision: 1,
  created_at: "2026-09-01T00:00:00Z",
};

describe("resumirFinanceiro", () => {
  it("separa previsto, realizado e vencidos sem misturar cancelados", () => {
    const resumo = resumirFinanceiro([
      base,
      { ...base, id: "2", direction: "payable", amount_cents: 3_000, due_date: "2026-09-13" },
      { ...base, id: "3", status: "settled", settled_amount_cents: 8_500, settled_at: "2026-09-11T00:00:00Z" },
      { ...base, id: "4", status: "cancelled", amount_cents: 99_000 },
    ], "2026-09-12");
    expect(resumo).toEqual({
      receberAbertoCents: 10_000, pagarAbertoCents: 3_000, saldoPrevistoCents: 7_000,
      saldoRealizadoCents: 8_500, vencidos: 1,
    });
  });
});

describe("contrato financeiro", () => {
  it("não aceita mass assignment na criação", () => {
    expect(criarLancamentoSchema.safeParse({ direction: "payable", description: "Fornecedor", amount_cents: 100,
      currency: "BRL", due_date: "2026-09-30", status: "settled" }).success).toBe(false);
  });
  it("exige confirmação humana literal para alterar situação", () => {
    const baseAction = { id: "00000000-0000-4000-8000-000000000001", action: "settle", revision: 1 };
    expect(alterarSituacaoSchema.safeParse(baseAction).success).toBe(false);
    expect(alterarSituacaoSchema.safeParse({ ...baseAction, confirmation: true }).success).toBe(true);
  });
});
