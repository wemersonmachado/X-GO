import { declararTools } from "./tipos";

export const TOOLS_FINANCEIRO = declararTools([
  {
    name: "crm_propose_financial_action",
    category: "write",
    rotulo: "Preparar uma solicitação financeira",
    explicacao: "O agente organiza uma proposta de lançamento, pagamento, reembolso, desconto, transferência ou compromisso; uma pessoa precisa aprovar antes de qualquer execução.",
    oQueToca: "Financeiro da empresa",
    risco: "critico",
    pacotes: ["financeiro"],
  },
]);
