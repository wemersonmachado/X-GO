/**
 * Migração do X-GO para subconta/conta Asaas EXCLUSIVA.
 *
 * Hoje X-GO e Paint Inspector Pro compartilham a mesma conta Asaas (risco de
 * contaminação cruzada — ver `docs/runbooks/asaas.md`, seção "Isolamento entre
 * produtos"). Este script cadastra o webhook e sincroniza os 3 links de plano
 * (Standard/Pro/Enterprise) contra uma conta Asaas NOVA, dada por API key e
 * webhook token próprios do X-GO. Ele NÃO grava nada no banco: só chama a API
 * Asaas e IMPRIME os IDs novos, prontos para colar na migration de UPDATE
 * (ver `supabase/migrations/<próxima>_platform_billing_plans_asaas_subconta_xgo.sql`).
 *
 * Pré-requisito manual (só o dono do produto pode fazer — painel Asaas):
 *   1. Criar a subconta/conta Asaas exclusiva do X-GO.
 *   2. Gerar uma API key nessa conta nova.
 *   3. Definir um webhook token novo (string aleatória ≥32 chars — o mesmo
 *      valor vai para `ASAAS_WEBHOOK_TOKEN` do X-GO em produção depois).
 *   4. Cadastrar `xgoos.com.br` em Asaas › Minha Conta › Informações NA CONTA
 *      NOVA (senão o callback de redirecionamento pós-compra é rejeitado).
 *
 * Uso (nunca hardcode as chaves; nunca digite em texto puro em outro lugar):
 *   ASAAS_API_KEY_XGO_NOVA='...' \
 *   ASAAS_WEBHOOK_TOKEN_XGO_NOVO='...' \
 *   CONFIRMAR_MIGRACAO_ASAAS=1 \
 *   npx tsx scripts/migrar-asaas-xgo-subconta.ts
 *
 * Sem `CONFIRMAR_MIGRACAO_ASAAS=1` o script só valida env e sai — não chama
 * a Asaas. Isso permite rodar `npx tsx scripts/migrar-asaas-xgo-subconta.ts`
 * sem nenhuma chave nova só para provar que o arquivo compila (dry-run).
 *
 * Preços e nomes dos planos são lidos de `platform_billing_plans` (fonte de
 * verdade viva, a mesma que `landing-page/actions.ts` grava) via Supabase
 * admin client — nunca hardcoded aqui, para nunca divergir do que está
 * publicado hoje na landing.
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]!]) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

const env = loadEnv();

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const ASAAS_API_KEY_NOVA = env.ASAAS_API_KEY_XGO_NOVA;
const ASAAS_WEBHOOK_TOKEN_NOVO = env.ASAAS_WEBHOOK_TOKEN_XGO_NOVO;
const ASAAS_API_BASE_URL = env.ASAAS_API_BASE_URL || "https://api.asaas.com/v3";
const WEBHOOK_URL = env.XGO_WEBHOOK_URL || "https://xgoos.com.br/api/v1/webhooks/asaas";
const CALLBACK_URL = env.XGO_CHECKOUT_SUCESSO_URL || "https://xgoos.com.br/checkout/sucesso";
const CONFIRMAR = env.CONFIRMAR_MIGRACAO_ASAAS === "1";

type PlanoSlug = "standard" | "pro" | "enterprise";
const SLUGS: PlanoSlug[] = ["standard", "pro", "enterprise"];

interface PlanoAtual {
  slug: PlanoSlug;
  name: string;
  price_cents: number;
  asaas_payment_link_id: string | null;
}

interface PaymentLinkResponse {
  id: string;
  url: string;
}

/** Mesmo payload de `lib/billing/asaas.ts` — mantido manualmente em sincronia. */
function paymentLinkPayload(name: string, priceCents: number) {
  return {
    name,
    description: `Plano ${name} — assinatura mensal`,
    endDate: null,
    value: priceCents / 100,
    billingType: "UNDEFINED",
    chargeType: "RECURRENT",
    subscriptionCycle: "MONTHLY",
    dueDateLimitDays: 7,
    notificationEnabled: true,
    callback: { successUrl: CALLBACK_URL, autoRedirect: true },
  };
}

async function asaasFetch<T>(apiKey: string, path_: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ASAAS_API_BASE_URL}${path_}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      access_token: apiKey,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`asaas_http_${response.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function main() {
  if (!ASAAS_API_KEY_NOVA || !ASAAS_WEBHOOK_TOKEN_NOVO) {
    throw new Error(
      "Faltam ASAAS_API_KEY_XGO_NOVA / ASAAS_WEBHOOK_TOKEN_XGO_NOVO. " +
        "Isso é esperado antes de criar a subconta — ver docs/runbooks/asaas.md.",
    );
  }
  if (ASAAS_WEBHOOK_TOKEN_NOVO.length < 32) {
    throw new Error("ASAAS_WEBHOOK_TOKEN_XGO_NOVO precisa ter ao menos 32 caracteres.");
  }
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  }

  if (!CONFIRMAR) {
    console.log(
      "[dry-run] Envs presentes e válidas. Nada foi chamado na Asaas " +
        "(defina CONFIRMAR_MIGRACAO_ASAAS=1 para executar de verdade).",
    );
    return;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: planos, error } = await supabase
    .from("platform_billing_plans")
    .select("slug,name,price_cents,asaas_payment_link_id")
    .in("slug", SLUGS);
  if (error) throw new Error(`falha ao ler platform_billing_plans: ${error.message}`);
  if (!planos || planos.length !== 3) {
    throw new Error(`esperava 3 planos (standard/pro/enterprise), achei ${planos?.length ?? 0}`);
  }

  console.log("== 1) Cadastrando webhook na conta nova ==");
  const webhook = await asaasFetch<{ id: string }>(ASAAS_API_KEY_NOVA, "/webhooks", {
    method: "POST",
    body: JSON.stringify({
      name: "Pagamentos X-GO (subconta exclusiva)",
      url: WEBHOOK_URL,
      enabled: true,
      interrupted: false,
      authToken: ASAAS_WEBHOOK_TOKEN_NOVO,
      sendType: "SEQUENTIALLY",
      events: [
        "PAYMENT_CREATED",
        "PAYMENT_CONFIRMED",
        "PAYMENT_RECEIVED",
        "PAYMENT_OVERDUE",
        "PAYMENT_REFUNDED",
        "PAYMENT_DELETED",
        "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
      ],
    }),
  });
  console.log(`webhook_id_novo=${webhook.id} url=${WEBHOOK_URL}`);

  console.log("\n== 2) Recriando os 3 links de plano na conta nova ==");
  const resultados: { slug: PlanoSlug; old_id: string | null; new_id: string; new_url: string }[] =
    [];
  for (const slug of SLUGS) {
    const plano = (planos as PlanoAtual[]).find((p) => p.slug === slug);
    if (!plano) throw new Error(`plano ${slug} não encontrado em platform_billing_plans`);
    // Sempre POST (nunca PUT): o ID antigo pertence à conta compartilhada e
    // não existe na conta nova.
    const link = await asaasFetch<PaymentLinkResponse>(ASAAS_API_KEY_NOVA, "/paymentLinks", {
      method: "POST",
      body: JSON.stringify(paymentLinkPayload(plano.name, plano.price_cents)),
    });
    resultados.push({
      slug,
      old_id: plano.asaas_payment_link_id,
      new_id: link.id,
      new_url: link.url,
    });
    console.log(
      `slug=${slug} nome="${plano.name}" preco_cents=${plano.price_cents} ` +
        `id_antigo=${plano.asaas_payment_link_id ?? "(nenhum)"} id_novo=${link.id} url_nova=${link.url}`,
    );
  }

  console.log("\n== 3) Cole isto na migration de UPDATE (supabase/migrations/) ==\n");
  for (const r of resultados) {
    console.log(
      `update public.platform_billing_plans set asaas_payment_link_id = '${r.new_id}', ` +
        `checkout_url = '${r.new_url}', synced_at = now(), sync_error = null ` +
        `where slug = '${r.slug}';`,
    );
  }
  console.log(
    "\nDepois de aplicar essa migration (e o apêndice correspondente no baseline.sql), " +
      "publique a landing novamente em Configurações › Landing page para que " +
      "`platform_branding.landing_page.plans[].payment_link_id` também reflita os IDs novos.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
