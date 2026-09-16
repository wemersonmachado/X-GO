# Spec 19 — Cotas comerciais e adicionais Stripe

## Contrato

Planos são fonte de capacidade, não apenas preço: Standard = 3 usuários, **1 WhatsApp**, 3 agentes ativos e 3.000 respostas de IA mensais; Pro = 10 usuários, **3 WhatsApps**, 10 agentes e 15.000 respostas; Enterprise é proposta com implantação e mensalidade personalizadas, sem promessa de ilimitado. Todos incluem MCP, sujeito aos escopos já existentes.

Uma resposta entra na franquia quando o runtime grava uma `llm_call` de `agent_turn`. Entrada de WhatsApp e atendimento humano nunca são bloqueados. Tokens de entrada/saída continuam registrados para custo e auditoria, mas não são convertidos artificialmente em respostas. Rascunhos e agentes pausados não usam vaga; um agente publicado, ativo e não arquivado usa uma vaga.

## Compra

No cartão de cada plano automático, o visitante escolhe quantidades de usuário, WhatsApp, agente e respostas de IA. O servidor lê o catálogo, congela plano, adicionais e total em uma intenção; a Stripe recebe todas as linhas na mesma assinatura. Após o pagamento confirmado, o webhook valida o total congelado, cria organização/convite e libera os adicionais na mesma transação. Cliente autenticado ainda pode comprar adicional para a organização ativa; o `organization_id` é congelado server-side. Replays são idempotentes pela sessão/assinatura Stripe.

## Segurança e degradação

Cotas finais são gatilhos/RPCs do banco com lock da organização. Falha de leitura não equivale a ilimitado. Cancelamento/reembolso de adicional revoga somente aquele adicional; dados e assinatura-base não são apagados.
