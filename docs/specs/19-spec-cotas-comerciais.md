# Spec 19 — Cotas comerciais e adicionais Stripe

## Contrato

Planos são fonte de capacidade, não apenas preço: Standard = 3 usuários, 3 WhatsApps, 3 agentes ativos e 3.000 conversas automatizadas mensais; Pro = 10/10/10/15.000; Enterprise = 20/20/25/50.000. Todos incluem MCP, sujeito aos escopos já existentes.

Uma conversa entra na franquia quando a IA inicia um atendimento. Entrada de WhatsApp e atendimento humano nunca são bloqueados. Rascunhos e agentes pausados não usam vaga; um agente publicado, ativo e não arquivado usa uma vaga.

## Compra

Visitantes contratam plano e recebem organização e convite após confirmação Stripe. Cliente autenticado compra adicional para sua organização ativa; o `organization_id` é congelado na intenção server-side e o webhook não cria organização. Replays são idempotentes pela assinatura Stripe.

## Segurança e degradação

Cotas finais são gatilhos/RPCs do banco com lock da organização. Falha de leitura não equivale a ilimitado. Cancelamento/reembolso de adicional revoga somente aquele adicional; dados e assinatura-base não são apagados.
