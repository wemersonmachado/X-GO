# Entrega — isolamento Asaas entre X-GO e Paint Inspector Pro (15/09/2026)

## Pedido

Garantir dois links de pagamento e dois webhooks totalmente isolados entre
X-GO (este repositório) e Paint Inspector Pro (`D:\PROJETOS\Paint Inspector Pro`,
repositório separado), que hoje dividem a mesma conta Asaas.

## Estado encontrado

- Um único webhook cadastrado na conta Asaas, apontando para a função
  Supabase do Paint Inspector Pro.
- Webhook do X-GO (app/api/v1/webhooks/asaas/route.ts, publicado em
  `https://xgoos.com.br/api/v1/webhooks/asaas`) existe em código e está
  deployado, mas **não está cadastrado como destino na Asaas**.
- Os 3 links do X-GO (Standard/Pro/Enterprise) foram criados na mesma conta
  do Paint Inspector Pro. Nenhuma subconta Asaas existe ainda.

## Lado X-GO (verificado, já seguro)

`fn_provision_paid_checkout` (migration
`20260911120000_0238_acesso_apos_pagamento.sql:65`) só provisiona acesso se
`payment.paymentLink` bater com um `platform_billing_plans.asaas_payment_link_id`
ativo **e** o valor pago for exatamente igual ao cadastrado — qualquer link
estranho (ex.: do Paint Inspector Pro) é rejeitado com
`unknown_or_inactive_payment_link`. Confirmado por leitura direta da
migration nesta sessão. Nada precisou mudar aqui.

## Lado Paint Inspector Pro (achado crítico, corrigido)

O webhook dele **não tinha esse filtro**: pagamento sem `externalReference`
(caso de qualquer link estático, inclusive os 3 do X-GO) caía num fallback
por e-mail que podia criar conta nova e conceder plano pago no Paint
Inspector Pro para quem só pagou X-GO. Corrigido nos commits `43af1df` e
`bc1aeda` do repositório do Paint Inspector Pro — detalhe completo em
`AUDITORIA-ASAAS-ISOLAMENTO-XGO-2026-09-15.md` naquele repo.

## Preparado neste repositório (X-GO) — SUPERSEDIDO em 15/09/2026

Esta seção descreve o que foi feito nesta sessão especificamente: runbook de
migração pra subconta Asaas exclusiva, script de sincronização e uma
migration-rascunho. **Nenhum desses artefatos sobreviveu ao fim do dia** — o
dono do produto decidiu trocar de provedor inteiramente (ver
`ENTREGA-STRIPE-X-GO-2026-09-15.md`), o que resolveu o isolamento sem precisar
de subconta. O runbook virou docs/runbooks/stripe.md, o script e a migration
foram apagados. Ficam citados aqui sem crase (não são mais caminhos válidos)
só pra registro histórico de que existiram: docs/runbooks/asaas.md,
scripts/migrar-asaas-xgo-subconta.ts,
supabase/migrations/20260915100000_0245_platform_billing_plans_asaas_subconta_xgo.sql.
O nó `asaas_subconta_xgo` também foi removido do mapa de arquitetura.

## Pendente (fora do alcance desta sessão)

1. **Deploy em produção do fix do Paint Inspector Pro**
   (`supabase functions deploy asaas-webhook`) — não executado: sem
   Supabase CLI/credencial no ambiente desta sessão. Ação manual do dono.
2. **Criação da subconta/conta Asaas exclusiva do X-GO** — só o dono do
   produto pode fazer isso no painel Asaas (login/criação de conta não é
   ação que um agente deva executar). Depois de criada, ele devolve API key
   + webhook token novos e o script/migration preparados aqui completam a
   migração.
3. Até 1 e 2 saírem, **não divulgar os 3 links do X-GO** — recomendação já
   dada pelo usuário e mantida.

## Commits

- Paint Inspector Pro: `43af1df` (fix), `bc1aeda` (teste), `594197d` (doc).
  Nenhum push feito — branch local `auditoria/correcoes-2026-09-11`.
- Este repositório: nenhum commit ainda (arquivos novos listados acima,
  ver checklist de commit pendente na resposta ao usuário).
