# Entrega — Auditoria funcional e de segurança ao vivo (X-GO / xgoos.com.br)

Auditoria pedida pelo dono do produto: testar fluxos reais (webhooks, agentes de IA,
follow-ups, roteadores, conexões, CRM, agenda, Meta Ads, configurações) e revisar
segurança de ponta a ponta, direto na instância de produção, dirigindo a sessão já
logada do Chrome do usuário. Executada por Claude Code em 2026-09-16.

## Corrigido

- **`lib/auth/invite-token.ts`** — removido o fallback público `"dev-fallback"` na
  assinatura/verificação de token de convite (risco **T4** em `docs/threat-model.md`,
  **M4** em `docs/testing/user-journey-map.md` e `docs/testing/HANDOFF-vps-qa.md`, agora
  marcados como corrigidos). Sem `INVITE_TOKEN_SECRET`/`INTERNAL_SECRET`, a função lança
  em vez de degradar para um literal escrito no próprio código público.
- **`tests/setup/vitest.setup.ts`** — adicionado `INTERNAL_SECRET` ao mapa de
  placeholders de teste (mesmo padrão já usado pra chaves Supabase), porque o CI não
  tem `.env` e a correção acima derrubava todo teste que assina/verifica convite.
- Fragmento de versionamento: `.changes/invite-token-sem-fallback-publico.md`.
- PR [#18](https://github.com/wemersonmachado/X-GO/pull/18), mesclado (squash) em
  `92fcd5a2` na `main`, com os 5 checks obrigatórios verdes (verify, invariants, e2e,
  build-and-size, imagens-ok). Deploy disparado no Railway (`serviceInstanceDeployV2`,
  deployment `381d02ac`) e confirmado ao vivo: `xgoos.com.br/api/v1/health` responde
  `version: "92fcd5a"`, Supabase/Redis/WAHA todos `ok`.

## Renomeado

- Repositório GitHub `wemersonmachado/deskcomm-crm` → **`wemersonmachado/X-GO`**
  (redirect automático do GitHub cobre URLs antigas; remote local já atualizado).

## Testado ao vivo, sem achado

RLS/multi-tenant, RBAC (4 roles), `getUser()` vs `getSession()`, reset de senha (sem
enumeração, rate limit, hash), bearer tokens (SHA256, nunca query string), webhooks
(HMAC + anti-SSRF), e-mails (HTML escapado), MFA (opcional, bate com a doutrina),
distribuição de atendimento, agenda (falha segura sem horário fictício, não oferece
compromisso fictício), Meta Ads (sem dado guardado localmente), fluxo webhook → lead
ponta a ponta (fonte → recebimento → estágio certo no Kanban), construtor de agente de
IA (11 verificações pré-envio incluindo opt-out/LGPD/anti-banimento, capacidades
irreversíveis exigem ligar uma a uma).

Dois falsos positivos investigados e descartados (não são bugs):
- Texto "Este contexto não está disponível para você" na Central de Avisos — proteção
  anti-enumeração deliberada (`lib/ai/inbox-destino.ts`), documentada no próprio código.
- Exclusão de tarefa sem confirmação — o componente já tem confirmação em dois toques
  (`app/app/tasks/_components/ListaDeTarefas.tsx`); observação ao vivo foi inconclusiva
  por metodologia (só uma captura de tela, depois do clique).

## Achados sem correção (infraestrutura, fora do escopo de código)

- **3 conexões WhatsApp reais desconectadas** no momento do teste — confirmado pelo
  usuário como estado conhecido; precisa reescanear QR, não é bug de código.
- **~50% das requisições de prefetch (RSC) retornando 503 intermitente** no Railway,
  mascarado por retry automático do Next.js como "carregando". Não reproduzido sob
  demanda (rajada manual de 15 requisições concorrentes deu 100% 200); medido ao vivo
  no tráfego real do navegador. Hipótese: limite de conexão/cold-start no plano Railway.
- **Branch `main` de `wemersonmachado/X-GO` sem branch protection** — os 5 checks
  obrigatórios descritos no `CLAUDE.md` (verify, build-and-size, invariants, e2e,
  imagens-ok) rodam, mas nada os torna obrigatórios *neste* repositório: um push direto
  em `main` vai para produção via Railway sem gate nenhum. A medição de branch
  protection em `CLAUDE.md` foi feita contra `melgarafael/DeskcommCRM` (upstream), não
  contra este fork, que é o que está deployado.
- **Job `cortar-tag` falhou** no push de merge em `main` (não bloqueou build nem
  deploy) — não investigado a fundo neste ciclo.

## Pendências

1. Decidir sobre `branch protection` em `wemersonmachado/X-GO` (replicar as 5 checks
   obrigatórias do upstream, ou aceitar o risco por ser fork de uso único).
2. Decidir sobre visibilidade do repositório. **Não recomendado tornar privado sem
   mudar o canal de distribuição**: `hostgator-setup-kit/install.sh` faz `git clone`
   direto na URL pública para buscar o kit self-host + `baseline.sql` — é a jornada P0
   (`vps-fresh-onboarding`) da doutrina de QA Visual. Repo privado quebra essa
   instalação para quem não tiver um token.
3. Investigar o 503 intermitente no Railway (plano/min-replicas/connection limit).
4. Investigar a falha do job `cortar-tag`.
5. Possível tarefa de teste residual `TESTE-delete-confirm (apagar)` em
   `/app/tasks` — criada durante o teste ao vivo, não confirmada como removida
   (sessão do Chrome do usuário ficou inacessível — janela 0×0 — no meio da limpeza).
6. Simulação de múltiplas organizações/usuários reais não foi feita — exigiria criar
   conta/logar, ação que o agente não executa por conta própria; fazer em ambiente
   local fresco (`supabase/baseline.sql` + `bootstrap-owner.ts`, doutrina de QA Visual)
   ou com o usuário logando e o agente conduzindo a partir daí.

## Limite desta auditoria

Cobertura de RBAC foi por amostragem (~10 de ~150 rotas de mutação), não linha a linha.
Suíte completa local (`vitest run`, 566 arquivos) foi iniciada mas não terminou antes
do fechamento deste ciclo — o sinal que valeu para o merge foi o `verify` do CI (que
roda a mesma suíte). `pnpm test:db` e `pnpm test:e2e` locais não foram executados fora
do que o próprio CI já roda.
