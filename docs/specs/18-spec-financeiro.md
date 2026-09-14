# 18 — Financeiro empresarial

Status: **Fase 1 implementada; fases 2–5 planejadas**.

## Limite do produto

Este módulo controla o financeiro da organização. É distinto do Billing, que cobra a instalação; do orçamento de IA; e do valor de negócio no CRM. Nenhum lançamento desta fase dispara banco, Asaas, Pix, boleto, nota fiscal, reembolso, estorno, desconto ou transferência. “Baixar” registra que uma pessoa administradora confirmou um fato ocorrido fora do sistema.

## Fase 1 — operacional

- contas a pagar e receber manuais;
- vencimento, atrasos, saldo previsto e realizado;
- manager vê e registra; admin confirma baixa, cancela ou reabre;
- confirmação literal e revisão otimista contra aprovação concorrente;
- histórico preservado, Audit Log e RLS entre organizações.

## Regra do agente financeiro

Na fase 2, o agente poderá ler indicadores, organizar documentos e **propor** lançamentos com `source=agent_proposal`. A proposta nunca nascerá baixada. Somente uma pessoa administradora autenticada e com MFA em dia pode confirmar efeito financeiro. Operações irreversíveis ou que movimentam valor devem escalar para uma pessoa.

## Roadmap

1. **Fase 2:** categorias, centros de custo, contas, anexos privados e fila de propostas do agente.
2. **Fase 3:** importação OFX/CSV e conciliação bancária assistida, sempre com aceite humano.
3. **Fase 4:** conectores fiscais por país/município, com confirmação e recibo idempotente.
4. **Fase 5:** competência, plano de contas e DRE gerencial. Até lá, o resumo não é uma DRE contábil.

## Critérios de aceite da fase 1

- baseline novo e atualização criam a mesma tabela e policies;
- outro tenant e papéis abaixo de manager não leem dados;
- manager não baixa; criação rejeita campos de estado/autoria;
- baixa sem `confirmation: true` é recusada;
- dois pedidos com a mesma `revision` não confirmam duas vezes;
- tela permite registrar, filtrar e confirmar com aviso humano.
