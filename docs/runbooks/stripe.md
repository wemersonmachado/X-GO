# Stripe — cobrança por planos (X-GO)

## Estado e fonte de verdade

- Não existe link fixo. Cada clique em "Contratar" cria uma **Checkout Session** nova
  (`app/checkout/[slug]/route.ts`) com `price_data` montado na hora a partir de
  `platform_billing_plans.price_cents` — o preço cobrado é sempre o valor atual do banco.
- O superadministrador altera o preço em **Configurações da landing page** e usa
  **Salvar e publicar**. Não há sincronização externa: salvar já é publicar, o próximo
  checkout já usa o valor novo.
- Ninguém pré-cria Product/Price na Stripe. `product_data`/`price_data` inline evitam esse
  passo inteiro — não há ID de preço pra manter em sincronia com o banco.

## Variáveis

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` e `STRIPE_API_BASE_URL` (default
`https://api.stripe.com/v1`). Nunca registrar valores em documentação, logs ou Git.

## Webhook

Endpoint: `POST /api/v1/webhooks/stripe`. O header `Stripe-Signature` é obrigatório;
`lib/billing/stripe.ts#verifyStripeSignature` recalcula o HMAC-SHA256 sobre
`${timestamp}.${rawBody}` e compara em tempo constante, com tolerância de 5 minutos contra
replay. `event.id` é chave única via `fn_record_stripe_event` — reentregas são idempotentes.

Escopo do processamento: **só `checkout.session.completed` provisiona acesso** (mesmo escopo
que o webhook Asaas anterior tinha — só pagamento confirmado agia). Os demais eventos
registrados no endpoint da Stripe (`invoice.paid`, `invoice.payment_failed`,
`customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`,
`charge.dispute.created`) são só **auditados** em `platform_payment_events` — nenhum consumidor
lê hoje `organization_subscriptions.status`/`current_period_end` pra bloquear acesso por
vencimento ou chargeback. Quando essa checagem existir, o handler evolui junto (não é
esquecimento: é não construir estado que nada consome ainda).

`plan_slug` vem de `session.metadata`, escrito pelo PRÓPRIO backend ao criar a sessão — nunca
inferido por valor pago nem por e-mail do cliente. Isso elimina a classe de bug que a auditoria
de 2026-09-15 encontrou no Paint Inspector Pro (fallback por e-mail criando conta errada pra
pagamento de outro produto na mesma conta Asaas): aqui não existe fallback nenhum — sem
`metadata.plan_slug` reconhecido, o evento só é auditado, nunca provisiona.

## Operação

1. Confirme que `https://xgoos.com.br/api/v1/webhooks/stripe` está publicado.
2. Webhook `we_1UFzRfIGMuUppnm9OfUa762Y` já está cadastrado na conta Stripe (criado em
   2026-09-15), assinando `checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`.
3. Publique os preços na landing (**Configurações › Landing page**). O painel
   **Administração › Pagamentos** mostra o valor atual de cada plano e os eventos recebidos.
4. Uma transação real só é considerada validada depois de um pagamento controlado, criação do
   recibo em `platform_checkout_access`, entrega observada no Resend e aceite do convite.
   Criar uma Checkout Session não prova liquidação financeira.

## Isolamento entre produtos

X-GO tem conta Stripe própria — não compartilha com nenhum outro produto do mesmo dono. O
problema de isolamento que motivou a revisão deste runbook (ver histórico em
`ENTREGA-ASAAS-ISOLAMENTO-XGO-PIP-2026-09-15.md`) era específico da conta Asaas compartilhada
com o Paint Inspector Pro; ele deixou de existir para o X-GO ao trocar de provedor, não porque
foi corrigido no provedor antigo.

## Recuperação

Como não há link fixo, não há "reconciliar link duplicado". Se a Checkout Session falhar ao
ser criada, o usuário volta pra landing com `?checkout=indisponivel` e pode tentar de novo —
nenhum estado fica pendente no banco (a linha em `organization_subscriptions` só nasce depois
do pagamento confirmado, via webhook).

## Migração histórica (Asaas → Stripe, 2026-09-15)

X-GO usava Asaas (mesma conta do Paint Inspector Pro) até 2026-09-15. Substituído por decisão
do dono do produto após uma auditoria encontrar que a conta compartilhada expunha o Paint
Inspector Pro a eventos de pagamento do X-GO. Em vez de separar em subconta Asaas (opção
avaliada e descartada), o X-GO trocou de provedor inteiramente — o que resolve o isolamento
por construção, sem depender de configuração de conta. O cliente Asaas e o webhook antigos do
X-GO foram removidos neste mesmo commit; use `git log --diff-filter=D -- '*asaas*'` pra achar
os caminhos exatos e o conteúdo original se precisar do runbook Asaas de referência.
