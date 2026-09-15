# Entrega — X-GO migrado de Asaas para Stripe (15/09/2026)

## Pedido

Trocar o meio de pagamento do X-GO de Asaas pra Stripe, com preço 100% dinâmico
(super admin altera o valor no dashboard e o próximo checkout já cobra o valor novo,
sem link fixo nem sincronização externa). Escopo: só X-GO — Paint Inspector Pro não foi
tocado. Cartão + boleto por enquanto (Pix no Stripe pra conta brasileira é só por convite).
Assinantes existentes: nenhum encontrado no banco (webhook Asaas do X-GO nunca chegou a
ser cadastrado na conta Asaas — ver `ENTREGA-ASAAS-ISOLAMENTO-XGO-PIP-2026-09-15.md` —,
então não havia ninguém pra migrar de fato).

## O que mudou

**Banco** (`supabase/migrations/20260915140000_0245_billing_stripe_x_go.sql`, aplicada e
confirmada — 0 linhas existentes em `organization_subscriptions`/`platform_payment_events`
no momento da aplicação, sem backfill necessário):
- `provider` em `organization_subscriptions` e `platform_payment_events` (`asaas`/`stripe`).
- `fn_record_stripe_event` nova.
- `fn_provision_paid_checkout` recebe `p_provider` + `p_plan_slug` no lugar de
  `p_payment_link_id` (drop+recreate — Postgres não renomeia parâmetro via
  `CREATE OR REPLACE`). `p_plan_slug` vem do `metadata` que o PRÓPRIO backend escreve ao
  criar a Checkout Session — nunca inferido por valor pago nem por e-mail do cliente, a
  classe de bug que a auditoria Asaas encontrou no Paint Inspector Pro no mesmo dia.

**Código novo:**
- `lib/billing/stripe.ts` — client (form-urlencoded, sem SDK, mesmo estilo do `asaas.ts`
  antigo) e `verifyStripeSignature` (HMAC-SHA256, tolerância de 5min contra replay).
- `app/api/v1/webhooks/stripe/route.ts` — só `checkout.session.completed` provisiona
  acesso; os outros 6 eventos assinados no endpoint só auditam (não existe hoje nenhum
  consumidor de `status`/`current_period_end` pra justificar mutar estado por vencimento
  ou chargeback).
- `app/checkout/[slug]/route.ts` — cria a Checkout Session com `price_data` inline, lido de
  `platform_billing_plans` na hora do clique. Rate-limit por IP (rota pública).

**Removido** (Asaas do X-GO, cutover completo): lib/billing/asaas.ts,
app/api/v1/webhooks/asaas/route.ts, docs/runbooks/asaas.md (substituído por
`docs/runbooks/stripe.md`), e todo o prep de subconta Asaas exclusiva feito mais cedo hoje
(script, migration-rascunho, seção de runbook) — ficou obsoleto: trocar de provedor resolve
o isolamento por construção, sem depender de configuração de conta.

**Landing/admin:** `saveLanding` não sincroniza mais nada externo — salvar já publica.
`LandingPage.tsx` aponta pro checkout dinâmico. Dashboard
`app/admin/(protected)/billing/page.tsx` mostra Stripe em vez de Asaas.

## Achados corrigidos no caminho (não fazem parte do pedido original, mas bloqueavam)

1. **`import "server-only"` sem o pacote instalado** — `asaas.ts`/`paid-access.ts` já
   dependiam dele, mas nenhum teste jamais importou esses arquivos diretamente, então o gap
   nunca apareceu. Instalado (`pnpm add server-only`) + alias em `vitest.config.ts` (o
   pacote lança incondicionalmente fora do bundler do Next; sem alias nenhum teste consegue
   importar um módulo server-only puro).
2. **`/checkout/*` caía no gate de sessão** — `lib/auth/public-paths.ts` não tinha entrada
   pra `/checkout/sucesso` nem pra qualquer sub-rota nova. Quem clica em "Contratar" ou volta
   do pagamento NUNCA tem sessão (a conta só nasce depois do webhook). Sem isso, os dois
   caíam no `/login` e o convite — que ainda nem chegou — virava a única saída aparente.
3. **`payment_method_types` implícito quebrava em conta nova** — Stripe tenta detectar
   métodos automaticamente a partir do dashboard; uma conta recém-criada sem nada ativado
   pra BRL rejeitava toda sessão com 400. Fixado explicitamente em `["card"]` — boleto exige
   habilitar em Settings › Payment methods antes de entrar no código.
4. **3 strings novas sem tradução em espanhol** (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`).

## Validação (ambiente local, contra a conta Stripe real do X-GO)

- `pnpm typecheck` limpo.
- Testes tocados verdes: `lib/billing/stripe.test.ts` (7 casos de assinatura — válida,
  secret errado, corpo adulterado, replay, header ausente/incompleto, rotação de secret),
  `lib/auth/public-paths.test.ts`, `tests/unit/asaas-inbox-exclusao-contract.test.ts`,
  `tests/unit/pagamento-acesso-e-mcp-externo.test.ts`, `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
- **Prova pela tela** (dev local, `.env.local` com `NEXT_PUBLIC_APP_URL` temporariamente
  apontado pra localhost — revertido ao final): landing renderiza os 3 planos com preço
  vindo do banco; clique em "Contratar Standard" abre `checkout.stripe.com` de verdade,
  mostrando "Assinar Standard — R$ 199,00/mês". Preço do Standard alterado direto no banco
  (mesmo caminho de escrita do `saveLanding`) pra R$ 299,00 e um novo checkout já refletiu o
  valor — sem deploy, sem sincronizar nada.
- **Webhook simulado** (evento `checkout.session.completed` fabricado, assinado com o
  webhook secret real, contra a rota local — nenhuma cobrança de verdade): 503 esperado —
  não por bug, mas porque o Resend recusou o e-mail de teste (`@example.com`, domínio de
  sandbox). Confirmado direto no banco: organização criada, `organization_subscriptions`
  com `provider='stripe'`/`status='active'`/`value_cents=19900`, `platform_checkout_access`
  com `invite_id` gerado e `email_sent_at=null` (estado correto de "aguardando retry").
- **Limpeza**: as duas Checkout Sessions de teste foram expiradas via API
  (`POST /checkout/sessions/{id}/expire`), o preço do Standard voltou a R$ 199,00, a
  organização/assinatura/evento/recibo simulados foram apagados, `.env.local` voltou a só
  ter as chaves Stripe (sem o override de URL). Contagem final bateu exatamente com a de
  antes de qualquer teste (`subs:0 events:0 orgs:3 access:0`).

## Pendente

- **Boleto**: precisa ser habilitado em Settings › Payment methods na conta Stripe antes
  de entrar em `payment_method_types`.
- **Pix**: só por convite pra conta brasileira — decisão do usuário foi seguir sem ele por
  enquanto.
- **Deploy em produção**: `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` (live) precisam ser
  cadastrados nas variáveis do Railway antes do próximo deploy alcançar `xgoos.com.br`.
