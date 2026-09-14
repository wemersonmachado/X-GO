import { describe, expect, it } from "vitest";

import { calcularDre, type ContaDre, type EntradaDre } from "./dre";

const accounts: ContaDre[] = [
  { id: "account-revenue", code: "3.1", name: "Vendas", direction: "receivable" },
  { id: "account-expense", code: "4.1", name: "Despesas operacionais", direction: "payable" },
];

describe("calcularDre", () => {
  it("calcula por competência, inclui abertos e exclui cancelados", () => {
    const entries: EntradaDre[] = [
      { direction: "receivable", status: "open", amount_cents: 10_000, chart_account_id: "account-revenue", competence_date: "2026-09-02" },
      { direction: "receivable", status: "settled", amount_cents: 3_000, chart_account_id: "account-revenue", competence_date: "2026-09-03" },
      { direction: "payable", status: "open", amount_cents: 2_500, chart_account_id: "account-expense", competence_date: "2026-09-04" },
      { direction: "payable", status: "cancelled", amount_cents: 99_000, chart_account_id: "account-expense", competence_date: "2026-09-05" },
      { direction: "receivable", status: "open", amount_cents: 77_000, chart_account_id: "account-revenue", competence_date: "2026-10-01" },
    ];

    const report = calcularDre(entries, accounts, "2026-09-01", "2026-10-01");

    expect(report.revenue_cents).toBe(13_000);
    expect(report.expense_cents).toBe(2_500);
    expect(report.result_cents).toBe(10_500);
    expect(report.lines).toEqual([
      {
        chart_account_id: "account-expense",
        code: "4.1",
        name: "Despesas operacionais",
        direction: "payable",
        amount_cents: 2_500,
        entry_count: 1,
      },
      {
        chart_account_id: "account-revenue",
        code: "3.1",
        name: "Vendas",
        direction: "receivable",
        amount_cents: 13_000,
        entry_count: 2,
      },
    ]);
  });

  it("conta como não classificados os lançamentos não cancelados sem competência", () => {
    const entries: EntradaDre[] = [
      { direction: "receivable", status: "open", amount_cents: 1_000, chart_account_id: null, competence_date: null },
      { direction: "payable", status: "settled", amount_cents: 2_000, chart_account_id: null, competence_date: null },
      { direction: "receivable", status: "cancelled", amount_cents: 3_000, chart_account_id: null, competence_date: null },
    ];

    expect(calcularDre(entries, [], "2026-09-01", "2026-10-01")).toMatchObject({
      revenue_cents: 0,
      expense_cents: 0,
      result_cents: 0,
      lines: [],
      unclassified_count: 2,
    });
  });

  it("agrupa lançamentos sem conta gerencial e respeita o limite final do período", () => {
    const entries: EntradaDre[] = [
      { direction: "receivable", status: "open", amount_cents: 1_500, chart_account_id: null, competence_date: "2026-09-30" },
      { direction: "receivable", status: "open", amount_cents: 2_500, chart_account_id: null, competence_date: "2026-10-01" },
    ];

    expect(calcularDre(entries, [], "2026-09-01", "2026-10-01")).toMatchObject({
      revenue_cents: 1_500,
      expense_cents: 0,
      result_cents: 1_500,
      unclassified_count: 0,
      lines: [{ chart_account_id: null, code: null, name: "Sem conta gerencial", amount_cents: 1_500, entry_count: 1 }],
    });
  });
});
