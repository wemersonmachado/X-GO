---
impacto: nada_mudou
secao: corrigido
titulo: Convite de equipe não depende mais de um segredo com valor padrão público
---

O token que assina um convite de equipe caía num valor padrão (`"dev-fallback"`) quando
`INVITE_TOKEN_SECRET`/`INTERNAL_SECRET` não estavam configuradas — e esse valor estava
escrito no próprio código público. Em instalação de produção normal (`NODE_ENV=production`)
o app já não subia sem `INTERNAL_SECRET` configurada, então o valor padrão nunca era
alcançado; agora ele deixou de existir — se o segredo faltar, assinar ou verificar um
convite falha alto em vez de aceitar o valor público. Nenhuma ação do operador é exigida.
