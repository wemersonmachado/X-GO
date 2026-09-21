# Modo econômico da Railway — pré-lançamento

> **Estado operacional confirmado em 2026-09-21.** Este é um modo temporário de
> homologação. Antes de testar WhatsApp/IA ou declarar a plataforma pronta para
> produção, siga a reativação descrita neste documento.

## Objetivo

Manter `https://xgoos.com.br` disponível para demonstrações e desenvolvimento de
telas sem pagar continuamente pelos processos de WhatsApp, fila e Redis enquanto
a plataforma ainda não foi lançada.

## Estado atual

| Serviço Railway | Estado | Motivo |
|---|---|---|
| `app` | **Ativo com Serverless** | Mantém landing, login e aplicação online; dorme após inatividade e acorda por HTTP. |
| `worker` | **Parado** | Evita polling contínuo do banco e execução de IA/filas. |
| `waha` | **Parado** | É o maior consumidor ocioso; só precisa rodar durante testes de WhatsApp. |
| `redis` | **Parado** | Não precisa permanecer ativo sem os fluxos operacionais. |
| `srh` | **Parado** | É a ponte HTTP para o Redis e deve acompanhar o estado dele. |
| `scheduler` | **Não existe como serviço separado nesta Railway** | Os laços de cron relevantes desta topologia vivem no processo `worker`. |

O volume do WAHA em `/app/.sessions` continua anexado e **não foi apagado**. Não
delete o serviço, o volume, as variáveis ou a sessão para economizar; use Stop e
Redeploy.

### Prova registrada na ativação deste modo

- `https://xgoos.com.br/` → HTTP `200`.
- `https://xgoos.com.br/login` → HTTP `200`.
- `/api/v1/health` → HTTP `503` esperado enquanto WAHA/Redis estão parados.
- `app.sleepApplication = true` e novo deploy do app concluído com sucesso.
- deploys de `waha`, `redis` e `srh` marcados como parados; `worker` sem instância
  de execução ativa.
- todos os serviços permanecem configurados na região `sfo`, a mesma região do
  volume persistente do WAHA.

## O que pode ser testado neste modo

- landing page e navegação pública;
- login, telas e cadastros que usam Supabase diretamente;
- responsividade, textos e fluxos de interface;
- administração e configurações sem dependência de WhatsApp;
- abertura do checkout, com a ressalva de cold start abaixo.

## O que não está operacional neste modo

- receber ou enviar mensagens pelo WhatsApp;
- respostas e execuções assíncronas dos agentes de IA;
- processamento contínuo da fila, follow-ups e tarefas do worker;
- rate limit distribuído em Redis; o código pode degradar para o fallback local;
- health geral verde;
- garantia de primeira resposta sem cold start para webhooks e checkout.

O Serverless pode devolver `502` na primeira requisição enquanto o contêiner
acorda. Isso é aceitável em homologação, mas não é evidência de prontidão para
lançamento. Stripe e outros emissores podem repetir webhooks, porém o fluxo final
de pagamento deve ser validado novamente com a pilha completa.

## Quando reativar a pilha completa

O agente responsável deve avisar o usuário e reativar tudo quando ocorrer qualquer
um destes casos:

1. teste de conexão, entrada ou saída do WhatsApp;
2. teste real de agente de IA, fila, follow-up ou automação;
3. validação final do pagamento até acesso à conta;
4. ensaio de lançamento, teste de carga ou observação de estabilidade;
5. início da operação com clientes.

Para ajustes apenas visuais ou de CRUD, permaneça no modo econômico.

## Reativação para uma sessão de testes completos

Na Railway, use **Redeploy** nesta ordem e espere cada serviço ficar saudável:

1. `redis`;
2. `srh`;
3. `waha` — confirme que a sessão persistida voltou conectada;
4. `worker`;
5. em `app`, desabilite **Settings → Deploy → Serverless** e faça Redeploy.

Depois, confirme:

```text
GET https://xgoos.com.br/api/v1/health
```

O resultado esperado para a pilha completa é HTTP `200`, com `supabase`, `redis`
e `waha` em `ok`. Faça então um teste real de entrada e saída no WhatsApp, um
turno de IA e o fluxo de checkout/acesso.

Terminada a sessão de homologação, pare novamente nesta ordem:

1. `worker`;
2. `waha`;
3. `srh`;
4. `redis`;
5. reative Serverless no `app` e faça Redeploy.

## Ativação definitiva para produção

No lançamento, a condição mínima é:

- `app` sempre ativo, com Serverless **desabilitado**;
- `redis`, `srh`, `waha` e `worker` ativos;
- volume do WAHA montado e sessão conectada;
- `/api/v1/health` em HTTP `200`;
- checkout, webhook, convite/acesso, WhatsApp e agente validados de ponta a ponta;
- pelo menos 3 dias de métricas de CPU, RAM, rede e erros sem crescimento anormal;
- alertas e limite de gasto definidos no painel conforme o orçamento aprovado pelo
  responsável financeiro.

Não escolha um limite monetário em nome do usuário. O valor é uma decisão
financeira; registre-o quando for aprovado.

## Como medir antes de otimizar

No painel da Railway, abra **Workspace → Usage → Projects → deskcomm-crm** e
compare RAM, CPU e egress por serviço. Limites de CPU/RAM protegem contra picos,
mas não reduzem o consumo normal abaixo do que o processo realmente usa.

Para o polling do worker, consulte
[`docs/runbooks/custo-e-cota-do-supabase.md`](docs/runbooks/custo-e-cota-do-supabase.md).
`QUEUE_POLL_INTERVAL_MS` pode chegar a `10000`; acima disso o pool pode reconectar
e aumentar o custo em vez de reduzi-lo.

## Regra para agentes futuros

- Leia este arquivo antes de qualquer deploy ou teste operacional na Railway.
- Não trate `/api/v1/health = 503` como regressão enquanto o modo econômico estiver
  ativo; confirme primeiro se WAHA/Redis foram intencionalmente parados.
- Não reative toda a pilha para mudança apenas visual.
- Não declare pagamento, WhatsApp, IA ou lançamento validados com a pilha parcial.
- Não apague o volume do WAHA.
- Depois de reativar ou parar serviços, atualize a seção **Estado atual** e registre
  a data da mudança.
