# 18 — Financeiro empresarial

Status: **Fases 1–5 implementadas** (estado confirmado no código em 2026-09-14).

## Limite do produto

Este módulo controla o financeiro da organização. É distinto do Billing, que cobra a instalação; do orçamento de IA; e do valor de negócio no CRM. Nenhum lançamento desta fase dispara banco, Asaas, Pix, boleto, nota fiscal, reembolso, estorno, desconto ou transferência. “Baixar” registra que uma pessoa administradora confirmou um fato ocorrido fora do sistema.

## Fase 1 — operacional

- contas a pagar e receber manuais;
- vencimento, atrasos, saldo previsto e realizado;
- manager vê e registra; admin confirma baixa, cancela ou reabre;
- confirmação literal e revisão otimista contra aprovação concorrente;
- histórico preservado, Audit Log e RLS entre organizações.

## Regra do agente financeiro

O agente pode ler indicadores, organizar documentos e **propor** operações financeiras. Toda delegação usa o modo `propose` e exige decisão explícita de uma pessoa administradora autenticada. A permissão ausente, revogada ou acima do limite bloqueia a proposta.

Quando uma proposta de lançamento é aprovada, o lançamento nasce com `source=agent_proposal` e em aberto. A decisão exige `confirmation: true`, usa `revision` para rejeitar concorrência e registra auditoria. Operações irreversíveis ou que movimentam valor permanecem sob decisão humana.

## Estado final das fases 2–5

### Fase 2 — cadastros, documentos e propostas

**CONFIRMADO:** existem categorias, centros de custo e contas financeiras por organização; anexos privados aceitam PDF, PNG ou JPEG, ficam no Storage com vínculo a lançamento ou proposta e são entregues por URL assinada de curta duração. A fila de propostas do agente cobre `entry`, `payment`, `refund`, `discount`, `transfer` e `commitment`, com limite opcional em centavos e decisão administrativa concorrente.

**INFERIDO:** a permissão e a fila são a superfície de delegação prevista para o agente; a spec não define execução automática de nenhuma operação após a aprovação.

### Fase 3 — importação e conciliação

**CONFIRMADO:** um manager pode importar extrato CSV ou OFX de até 2 MB para uma conta BRL ativa. O parser exige identificador único por movimento, data válida, descrição e valor em centavos; o hash SHA-256 do arquivo impede importar o mesmo extrato duas vezes para a mesma conta. Cada movimento começa pendente. A conciliação é assistida: uma pessoa admin escolhe `match` (vincula a um lançamento) ou `ignore`, confirma literalmente e a revisão impede dupla decisão ou concorrência.

**INFERIDO:** os formatos e limites descritos acima são o contrato atual da API, mas não constituem homologação de qualquer layout bancário específico além dos campos que o parser reconhece.

### Fase 4 — fiscal Brasil

**CONFIRMADO:** há contrato para provedor fiscal brasileiro (`country=BR`), município de sete dígitos e documento `nfse` ou `nfe`. Somente receita não cancelada pode entrar na fila; o pedido exige `Idempotency-Key` no cabeçalho e confirmação humana, e repetição da mesma chave e payload é idempotente. Sem provedor configurado, o pedido permanece `awaiting_provider`, é explicitamente reportado como `provider_configured: false` e não é enviado nem emitido.

**INFERIDO:** o contrato permite futura implementação de conectores e recibos (`submitted`, `issued`, `rejected`), mas nenhum provedor, município ou credencial está escolhido ou registrado nesta versão. A fila fica bloqueada até que essa configuração exista.

### Fase 5 — competência, plano de contas e DRE gerencial

**CONFIRMADO:** lançamentos podem receber conta gerencial e `competence_date`; a conta deve pertencer à mesma organização e ter a mesma direção (receita ou despesa). A DRE gerencial (`/api/v1/financeiro/dre?month=AAAA-MM`) agrupa por competência, soma receitas menos despesas, inclui lançamentos abertos e exclui cancelados. Lançamentos sem competência não entram no período e são contados como `unclassified_count`. A resposta declara `accounting_statement: false`.

**INFERIDO:** a DRE é um relatório gerencial operacional e não substitui escrituração ou demonstração contábil formal; o código confirma essa fronteira, mas não define integração com contador.

## Critérios de aceite da fase 1

- baseline novo e atualização criam a mesma tabela e policies;
- outro tenant e papéis abaixo de manager não leem dados;
- manager não baixa; criação rejeita campos de estado/autoria;
- baixa sem `confirmation: true` é recusada;
- dois pedidos com a mesma `revision` não confirmam duas vezes;
- tela permite registrar, filtrar e confirmar com aviso humano.
