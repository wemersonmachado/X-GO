import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { Card } from "@/components/ui/card";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { getEntitlementUsage } from "@/lib/billing/entitlements";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * A tela de dinheiro entregava o nosso contato ao cliente do revendedor, e ela
 * tem porta de 1ª classe no menu. Mesmo tratamento da tela de conta suspensa:
 * o endereço é o de quem opera a instalação (`SUPPORT_EMAIL`) e, sem ele
 * configurado, nenhum endereço aparece.
 */
export default async function BillingPage() {
  // spec 13 §4: billing é admin-only (viewer/agent/manager = none).
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const suporte = emailDeSuporte();
  const idioma = user.idioma;
  const { data: subscriptionData } = await createAdminClient()
    .from("organization_subscriptions" as never)
    .select("plan_slug,status,value_cents,current_period_end" as never)
    .eq("organization_id" as never, activeOrg.orgId)
    .maybeSingle();
  const subscription = subscriptionData as unknown as { plan_slug: string; status: string; value_cents: number; current_period_end: string | null } | null;
  const [entitlements, addonsResult] = await Promise.all([
    getEntitlementUsage(activeOrg.orgId),
    createAdminClient().from("platform_billing_addons" as never).select("slug,name,resource,units,price_cents,active" as never).eq("active" as never, true).order("price_cents" as never),
  ]);
  const addons = (addonsResult.data ?? []) as unknown as Array<{ slug: string; name: string; resource: string; units: number; price_cents: number; active: boolean }>;
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Plano e cobrança", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Planos, faturas e cobrança.", idioma)}
        </p>
      </header>
      <Card className="max-w-xl p-6">
        <h2 className="text-sm font-semibold">{subscription ? traduzir("Assinatura atual", idioma) : traduzir("Nenhuma assinatura vinculada", idioma)}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {subscription ? <>{subscription.plan_slug.toUpperCase()} · {new Intl.NumberFormat(tagDeIdioma(idioma),{style:"currency",currency:"BRL"}).format(subscription.value_cents/100)} · {subscription.status}</> : <>{traduzir("Esta organização não possui uma assinatura Stripe vinculada. Para uma nova contratação, escolha um plano na página inicial; o pagamento cria uma nova organização com acesso por e-mail.", idioma)}</>} {" "}
          {suporte ? (
            <>
              {traduzir("Para questões de pagamento, contate", idioma)}{" "}
              <a className="underline" href={`mailto:${suporte}`}>
                {suporte}
              </a>
              .
            </>
          ) : (
            <>{traduzir("Para questões de pagamento, fale com quem administra este sistema.", idioma)}</>
          )}
        </p>
      </Card>
      {entitlements && <Card className="max-w-3xl p-6"><h2 className="text-sm font-semibold">{traduzir("Capacidade do plano", idioma)}</h2><p className="mt-2 text-sm text-muted-foreground">{traduzir("Conversas contam quando a IA começa a atender; mensagens humanas e recebidas não são bloqueadas.", idioma)}</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{([['users','Usuários'],['whatsapp','WhatsApps'],['active_agents','Agentes ativos'],['monthly_conversations','Conversas automatizadas neste mês']] as const).map(([key,label]) => <div className="rounded-md border p-3" key={key}><p className="text-xs text-muted-foreground">{traduzir(label, idioma)}</p><p className="font-semibold">{entitlements.usage[key]} / {entitlements.limits[key]}</p></div>)}</div></Card>}
      <Card className="max-w-3xl p-6"><h2 className="text-sm font-semibold">{traduzir("Adicionar capacidade", idioma)}</h2><p className="mt-2 text-sm text-muted-foreground">{traduzir("A compra abre o checkout seguro da Stripe. A capacidade é liberada automaticamente após a confirmação do pagamento.", idioma)}</p><div className="mt-4 grid gap-3 md:grid-cols-2">{addons.map((addon) => <form className="rounded-md border p-4" action={`/checkout/addon/${addon.slug}`} method="post" key={addon.slug}><input type="hidden" name="intent_key" value={randomUUID()} /><h3 className="font-medium">{traduzir(addon.name, idioma)}</h3><p className="text-sm text-muted-foreground">+{addon.units} {traduzir(addon.resource, idioma)} · {new Intl.NumberFormat(tagDeIdioma(idioma),{style:"currency",currency:"BRL"}).format(addon.price_cents/100)}/mês</p><label className="mt-3 block text-sm">{traduzir("Quantidade", idioma)}<input className="ml-2 w-16 rounded border p-1" name="quantity" type="number" min="1" max="100" defaultValue="1" /></label><button className="mt-3 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" type="submit">{traduzir("Contratar adicional", idioma)}</button></form>)}</div></Card>
    </div>
  );
}
