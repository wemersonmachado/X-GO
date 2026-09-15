# Página pública da instalação

## Organização

`LandingPage.tsx` e `landing.module.css`: página renderizada no servidor, cards e cena 3D em CSS, FAQ nativa e movimento reduzido. Não utiliza bibliotecas de animação, imagens remotas nem rastreadores adicionais.

`schema.ts`: conteúdo padrão e validação; três planos mensais com preço em centavos e checkout próprio. `server.ts`: leitura pública com fallback. `SettingsForm.tsx` e `actions.ts`: editor protegido por superadmin, escopo completo e MFA da sessão. Ao publicar, só grava em `platform_billing_plans` — checkout é dinâmico (Stripe Checkout Session criada na hora do clique), então não há nenhum provedor externo pra sincronizar.

Credenciais nunca ficam nesta pasta nem no JSON público. O preço vivo do plano fica em `platform_billing_plans`; eventos idempotentes e minimizados em `platform_payment_events`. Operação: `docs/runbooks/stripe.md`.

As únicas pontes fora desta pasta são as rotas `/` e `/app/settings/landing-page`, a navegação e a migration `0236`. Hospedagem: mesmo serviço Railway da aplicação, mesmo domínio e certificado. Não há segundo build ou infraestrutura para manter.

## Operação

Configurações → Página de apresentação → editar → Salvar e publicar. A edição não muda a marca ou preferências dos tenants. Configure o CTA com seu WhatsApp comercial ou outro destino HTTPS; até isso acontecer os botões apresentam os planos e explicam o acesso por convite. Não existe cadastro público livre nem checkout.

Os valores e pacotes iniciais são ilustrativos, não limites de produto implementados. Revise condições comerciais antes de anunciar. O editor permite alterar títulos, descrições, passos, recursos, perguntas, tema, cor e valores. O nome da instalação segue a configuração de Marca.

## Validação

`pnpm exec vitest run landing-page/schema.test.ts` verifica conteúdo padrão, URLs de CTA e acesso à navegação. Prova de navegador e publicação são registradas no relatório da raiz; testes unitários não certificam conversão nem desempenho em tráfego real.
