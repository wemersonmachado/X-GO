# Billing comercial — fonte operacional

## Etapa 1 — catálogo e governança

- Standard e Pro mantêm capacidade separada de recursos funcionais.
- Planos, adicionais, desconto anual, trial, pacotes de créditos, alertas e excedente são editáveis pelo superadmin em **Configurações > Landing page**.
- Valores iniciais: usuário R$ 29,99/mês; WhatsApp R$ 59,00/mês; agente ativo R$ 29,00/mês; 1.000 respostas de IA R$ 19,99/mês.
- Preços enviados pelo navegador nunca têm autoridade: o servidor relê e congela o catálogo em uma intenção idempotente.

## Etapa 2 — contratação

- A landing calcula plano, adicionais e periodicidade mensal/anual antes do checkout.
- A Stripe recebe exatamente os itens congelados pelo backend.
- Trial aceita somente cartão; boleto continua disponível sem trial.
- O acesso nasce somente por webhook Stripe assinado e reconciliado. Redirect de sucesso não libera nada.
- Tarifas da Meta/WhatsApp aparecem separadas e não são apresentadas como receita da plataforma.

## Etapa 3 — consumo e expansão

- A tela de cobrança mostra uso por recurso, alerta no percentual configurado e saldo pré-pago.
- Ao atingir a franquia, cada organização escolhe: bloquear IA, consumir créditos ou usar excedente limitado. Excedente só aparece se o superadmin definir preço maior que zero.
- Créditos são compra avulsa, creditados uma vez por pagamento e consumidos atomicamente após a franquia.
- O comparador recomenda o próximo plano quando a expansão deixa de ser econômica.

## Etapa 4 — limites honestos

- Cobrança por resultado fica configurável, mas desativada por padrão. Ativá-la exige antes definir um evento de resultado auditável por nicho; sem esse contrato, nenhuma cobrança é gerada.
- Enterprise diferencia atendimento e escopo, mas SSO, SLA contratual e personalização só devem ser prometidos quando constarem na proposta assinada.
- Upgrade imediato com prorrata depende de catálogo de Prices persistentes na Stripe. O checkout dinâmico atual cria preços inline; por segurança, esta operação não é simulada nem aplicada automaticamente até existir uma transação de upgrade reconciliável.

## Evidência mínima para publicação

`pnpm gov:verify`, `pnpm test:db`, `pnpm build` e Playwright da landing/cobrança. Produção só está concluída depois da migration remota, deploy saudável e leitura do comportamento publicado.
