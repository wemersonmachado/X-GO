export type LinhaDre = { chart_account_id: string | null; code: string | null; name: string;
  direction: "receivable" | "payable"; amount_cents: number; entry_count: number };
export type EntradaDre = { direction: "receivable" | "payable"; status: "open" | "settled" | "cancelled";
  amount_cents: number; chart_account_id: string | null; competence_date: string | null };
export type ContaDre = { id: string; code: string; name: string; direction: "receivable" | "payable" };

/** Competência explícita: lançamentos sem data não são presumidos no vencimento. */
export function calcularDre(entries: EntradaDre[], accounts: ContaDre[], from: string, toExclusive: string) {
  const accountById = new Map(accounts.map(account => [account.id, account]));
  const lines = new Map<string, LinhaDre>();
  let unclassified_count = 0;
  let revenue_cents = 0;
  let expense_cents = 0;
  for (const entry of entries) {
    if (entry.status === "cancelled") continue;
    if (!entry.competence_date) { unclassified_count += 1; continue; }
    if (entry.competence_date < from || entry.competence_date >= toExclusive) continue;
    if (!Number.isSafeInteger(entry.amount_cents) || entry.amount_cents < 1) throw new Error("Valor financeiro inválido.");
    const account = entry.chart_account_id ? accountById.get(entry.chart_account_id) : undefined;
    const key = `${entry.direction}:${account?.id ?? "none"}`;
    const line = lines.get(key) ?? { chart_account_id: account?.id ?? null, code: account?.code ?? null,
      name: account?.name ?? "Sem conta gerencial", direction: entry.direction, amount_cents: 0, entry_count: 0 };
    line.amount_cents += entry.amount_cents; line.entry_count += 1;
    lines.set(key, line);
    if (entry.direction === "receivable") revenue_cents += entry.amount_cents;
    else expense_cents += entry.amount_cents;
  }
  return { lines: [...lines.values()].sort((a, b) => a.direction.localeCompare(b.direction) ||
    (a.code ?? "~").localeCompare(b.code ?? "~")), revenue_cents, expense_cents,
    result_cents: revenue_cents - expense_cents, unclassified_count };
}
