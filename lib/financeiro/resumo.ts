import type { LancamentoFinanceiro } from "./tipos";

export interface ResumoFinanceiro {
  receberAbertoCents: number;
  pagarAbertoCents: number;
  saldoPrevistoCents: number;
  saldoRealizadoCents: number;
  vencidos: number;
}

export function resumirFinanceiro(lancamentos: LancamentoFinanceiro[], hoje: string): ResumoFinanceiro {
  let receberAbertoCents = 0;
  let pagarAbertoCents = 0;
  let saldoRealizadoCents = 0;
  let vencidos = 0;

  for (const item of lancamentos) {
    if (item.status === "open") {
      if (item.direction === "receivable") receberAbertoCents += item.amount_cents;
      else pagarAbertoCents += item.amount_cents;
      if (item.due_date < hoje) vencidos += 1;
    } else if (item.status === "settled") {
      const realizado = item.settled_amount_cents ?? item.amount_cents;
      saldoRealizadoCents += item.direction === "receivable" ? realizado : -realizado;
    }
  }

  return {
    receberAbertoCents,
    pagarAbertoCents,
    saldoPrevistoCents: receberAbertoCents - pagarAbertoCents,
    saldoRealizadoCents,
    vencidos,
  };
}
