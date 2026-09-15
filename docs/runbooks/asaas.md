# Asaas — cobrança por planos

## Estado e fonte de verdade

- Cada plano possui um link mensal próprio. O cliente nunca escolhe o valor.
- O superadministrador altera o preço em **Configurações da landing page** e usa **Salvar e publicar**.
- A publicação atualiza o mesmo link no Asaas e só depois grava a landing. Assim, o preço exibido e o checkout convergem.
- Os identificadores públicos dos links ficam em `platform_billing_plans`; a chave da API e o token do webhook ficam apenas no `.env`/Railway.

## Variáveis

`ASAAS_API_KEY`, `ASAAS_API_BASE_URL` e `ASAAS_WEBHOOK_TOKEN`. Nunca registrar valores em documentação, logs ou Git.

## Webhook

Endpoint: `POST /api/v1/webhooks/asaas`. O header `asaas-access-token` é obrigatório e comparado em tempo constante. `event_id` é chave única: reentregas são idempotentes. O payload persistido é minimizado e não contém nome, CPF, e-mail ou endereço do pagador.

Eventos aceitos são registrados em `platform_payment_events`. Apenas `PAYMENT_CONFIRMED` e
`PAYMENT_RECEIVED`, associados a um link ativo e com valor idêntico ao plano publicado,
podem provisionar acesso. O app relê nome e e-mail em `GET /customers/{id}` no Asaas,
cria organização e assinatura uma única vez e envia pelo Resend o link assinado para o
pagador criar a própria senha. O e-mail aberto não é persistido na tabela financeira;
`platform_checkout_access` guarda apenas SHA-256 e o recibo idempotente.

Renovações da mesma assinatura reutilizam a organização. Retentativas do webhook reutilizam
o mesmo convite e a mesma chave de idempotência no Resend, sem duplicar tenant nem mensagem.

## Operação

1. Confirme que `https://xgoos.com.br/api/v1/webhooks/asaas` está publicado.
2. Cadastre o webhook no Asaas com o token da instalação.
3. Publique os preços na landing e abra cada checkout pelo painel **Administração › Pagamentos**.
4. Para redirecionar após a compra, cadastre `xgoos.com.br` em **Asaas › Minha Conta › Informações**. Sem esse cadastro a API rejeita o callback; cobrança e webhook continuam funcionando.
5. Uma transação real só é considerada validada depois de um pagamento controlado, criação
   do recibo em `platform_checkout_access`, entrega observada no Resend e aceite do convite.
   Criar/consultar links não prova liquidação financeira.

## Isolamento entre produtos

Uma chave Asaas compartilhada envia ao mesmo conjunto de webhooks os pagamentos de todos os
produtos daquela conta. Não aponte o webhook desta instalação para uma conta que também
processa outro produto sem uma fronteira determinística anterior ao legado. Use uma conta ou
subconta exclusiva e configure nela os três links e o webhook do X-GO. Conta Asaas de pessoa
física não pode criar subconta via API; nesse caso, crie uma conta empresarial independente
ou regularize a conta principal antes de ativar a cobrança.

## Recuperação

Links são reutilizados por ID. Se a sincronização falhar, nenhum conteúdo novo da landing é publicado. Corrija a configuração e publique novamente; a operação converge sem criar links duplicados quando os IDs já estão registrados.

## Migração para subconta Asaas exclusiva (X-GO)

**Por que:** X-GO e Paint Inspector Pro compartilham hoje a mesma conta Asaas — a mesma chave
de API envia os dois produtos para o mesmo conjunto de webhooks (ver "Isolamento entre
produtos" acima). Decisão do dono do produto: X-GO ganha conta/subconta Asaas própria, com
API key e webhook exclusivos. A correção equivalente do lado Paint Inspector Pro é conduzida
em paralelo, fora deste repositório.

**Enquanto esta migração não terminar (passo 8 abaixo), os 3 links de checkout atuais do
X-GO continuam apontando para a conta compartilhada. Não divulgue nem use esses links com
clientes reais nesse meio-tempo** — divulgar antes do corte não corrige o compartilhamento,
só adia; e um cliente real pago no meio da janela de corte é um caso a mais para reconciliar
manualmente.

Passos 1–4 são **manuais, exigem login no painel Asaas e não podem ser automatizados** por
este repositório nem por nenhum script:

1. **Criar a conta/subconta Asaas exclusiva do X-GO.** Conta Asaas de pessoa física não cria
   subconta via API — se a conta principal for pessoa física, crie uma conta empresarial
   independente para o X-GO (não uma subconta dela).
2. **Gerar uma API key nova** nessa conta (Configurações › Integrações › API). Copiar o valor
   uma única vez — a Asaas não reexibe o token depois.
3. **Definir um webhook token novo**: gere uma string aleatória com pelo menos 32 caracteres
   (ex.: `openssl rand -hex 32`). Esse é o valor que vai virar `ASAAS_WEBHOOK_TOKEN` do X-GO em
   produção no passo 6 — guarde-o junto com a API key do passo 2.
4. **Cadastrar `xgoos.com.br`** em **Asaas › Minha Conta › Informações** NA CONTA NOVA. Sem
   isso a API rejeita o `callback.successUrl` do checkout (cobrança e webhook continuam
   funcionando; só o redirecionamento pós-compra fica quebrado).

Depois que os passos 1–4 estiverem feitos e você tiver a API key nova e o webhook token novo
em mãos, devolva os dois valores (nunca em texto puro num canal permanente — ver aviso de
segurança abaixo) para continuar com os passos automatizáveis:

5. **Rodar o script utilitário em dry-run primeiro**, sem nenhuma chave nova, só para
   confirmar que o ambiente local está íntegro (não chama a Asaas, não toca o banco):

   ```bash
   npx tsx scripts/migrar-asaas-xgo-subconta.ts
   ```

   Isso deve imprimir `Faltam ASAAS_API_KEY_XGO_NOVA / ASAAS_WEBHOOK_TOKEN_XGO_NOVO` e sair —
   é o comportamento esperado antes da conta nova existir.

6. **Rodar o script de verdade**, com as credenciais da conta nova em variável de ambiente
   (nunca hardcoded, nunca digitadas em texto puro fora do shell da sua máquina):

   ```bash
   ASAAS_API_KEY_XGO_NOVA='<api key da conta nova>' \
   ASAAS_WEBHOOK_TOKEN_XGO_NOVO='<webhook token novo, ≥32 chars>' \
   CONFIRMAR_MIGRACAO_ASAAS=1 \
   npx tsx scripts/migrar-asaas-xgo-subconta.ts
   ```

   O script lê nome e preço atuais dos 3 planos direto de `platform_billing_plans` (fonte de
   verdade viva — nunca valor hardcoded), cadastra o webhook novo apontando para
   `https://xgoos.com.br/api/v1/webhooks/asaas` e recria os 3 links (Standard/Pro/Enterprise)
   na conta nova via `syncPaymentLink`/`createAsaasWebhook` (mesma lógica de
   `lib/billing/asaas.ts`). Ele **não escreve no banco** — só imprime os IDs novos e um bloco
   de `UPDATE` pronto para colar numa migration.
7. **Preencher a migration de UPDATE.** O esqueleto já existe em
   `supabase/migrations/20260915100000_0245_platform_billing_plans_asaas_subconta_xgo.sql`
   com placeholders (`PREENCHER_APOS_MIGRACAO_asaas_link_id_<plano>`) e uma guarda que faz a
   aplicação falhar alto se algum placeholder não for substituído. Troque os placeholders
   pelos IDs impressos no passo 6, confira o próximo número sequencial livre em
   `supabase/migrations/` (outra sessão pode ter avançado o contador nesse meio-tempo),
   aplique a migration, reflita o mesmo `UPDATE` no apêndice idempotente de
   `supabase/baseline.sql` e registre a linha em `supabase/migrations/MANIFEST.md` — só
   **depois** de aplicar (esta migration nasceu rascunho de propósito e não está listada no
   MANIFEST ainda).
8. **Trocar as env vars de produção**: `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` do deploy do
   X-GO passam a valer os da conta nova (as mesmas usadas no passo 6). Redeploy do `app`.
   Republique a landing (**Configurações › Landing page › Salvar e publicar**) para que
   `platform_branding.landing_page.plans[].payment_link_id`/`checkout_url` também reflitam os
   IDs novos — sem isso a landing mostra o link antigo mesmo com o banco já atualizado.
9. **Validação final: uma compra controlada de valor baixo.** Gere um link avulso de valor
   simbólico (ou use o plano Standard) na conta nova e pague de verdade. Confirme, nesta
   ordem:
   - o webhook novo recebe `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` (`platform_payment_events`
     ganha a linha, `event_id` novo);
   - `fn_provision_paid_checkout` aceita — o link pago bate com um `asaas_payment_link_id`
     ativo em `platform_billing_plans` e o valor confere exatamente;
   - o convite sai pelo Resend (log de entrega observado, não só "enviado sem erro");
   - o usuário abre o link, cria a senha e entra na organização nova.

   Criar ou consultar links não prova nada disso — só uma cobrança real, paga e confirmada
   fecha o ciclo. Reembolse a cobrança de teste depois de confirmar.

**Aviso de segurança:** a API key e o webhook token da conta nova nunca vão em issue, PR,
commit, mensagem de chat persistente ou qualquer lugar fora do `.env`/gestor de segredos do
deploy. Se precisar repassá-los entre pessoas, use o mesmo canal que já usam para as
credenciais atuais do `.env` de produção.
