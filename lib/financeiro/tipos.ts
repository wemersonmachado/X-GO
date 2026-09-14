export const DIRECOES_FINANCEIRAS = ["receivable", "payable"] as const;
export const SITUACOES_FINANCEIRAS = ["open", "settled", "cancelled"] as const;

export type DirecaoFinanceira = (typeof DIRECOES_FINANCEIRAS)[number];
export type SituacaoFinanceira = (typeof SITUACOES_FINANCEIRAS)[number];

export interface LancamentoFinanceiro {
  id: string;
  direction: DirecaoFinanceira;
  status: SituacaoFinanceira;
  description: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  notes: string | null;
  source: "manual" | "agent_proposal" | "import" | "integration";
  settled_amount_cents: number | null;
  settled_at: string | null;
  revision: number;
  created_at: string;
}
