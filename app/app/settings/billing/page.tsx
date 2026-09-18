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
import { saveBillingPreference } from "./actions";

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
  const [entitlements, addonsResult, packsResult, policyResult, preferenceResult, plansResult] = await Promise.all([
    getEntitlementUsage(activeOrg.orgId),
    createAdminClient().from("platform_billing_addons" as never).select("slug,name,resource,units,price_cents,active" as never).eq("active" as never, true).order("price_cents" as never),
    createAdminClient().from("platform_billing_credit_packs" as never).select("slug,name,credits,price_cents,active" as never).eq("active" as never, true).order("credits" as never),
    createAdminClient().from("platform_billing_policy" as never).select("usage_alert_percent,hard_limit_percent,overage_unit_price_cents,meta_fees_notice" as never).eq("id" as never, 1).maybeSingle(),
    createAdminClient().from("organization_billing_preferences" as never).select("limit_action" as never).eq("organization_id" as never, activeOrg.orgId).maybeSingle(),
    createAdminClient().from("platform_billing_plans" as never).select("slug,name,price_cents" as never).eq("active" as never, true).order("price_cents" as never),
  ]);
  const addons = (addonsResult.data ?? []) as unknown as Array<{ slug: string; name: string; resource: string; units: number; price_cents: number; active: boolean }>;
  const packs = (packsResult.data ?? []) as unknown as Array<{ slug: string; name: string; credits: number; price_cents: number; active: boolean }>;
  const policy = policyResult.data as unknown as { usage_alert_percent: number; hard_limit_percent: number; overage_unit_price_cents: number; meta_fees_notice: string } | null;
  const preference = preferenceResult.data as unknown as { limit_action: "block" | "credits" | "overage" } | null;
  const plans = (plansResult.data ?? []) as unknown as Array<{ slug: string; name: string; price_cents: number }>;
  const currentPlanIndex = plans.findIndex((plan) => plan.slug === entitlements?.plan_slug);
  const nextPlan = currentPlanIndex >= 0 ? plans[currentPlanIndex + 1] : null;
  const money = (cents: number) => new Intl.NumberFormat(tagDeIdioma(idioma),{style:"currency",currency:"BRL"}).format(cents/100);
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
      {entitlements && <Card className="max-w-3xl p-6"><h2 className="text-sm font-semibold">{traduzir("Capacidade e consumo", idioma)}</h2><p className="mt-2 text-sm text-muted-foreground">{traduzir("Respostas de IA consomem franquia; mensagens humanas e recebidas não são bloqueadas.", idioma)}</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{([['users',traduzir('Usuários', idioma)],['whatsapp',traduzir('WhatsApps', idioma)],['active_agents',traduzir('Agentes ativos', idioma)],['monthly_conversations',traduzir('Respostas de IA neste mês', idioma)]] as const).map(([key,label]) => { const percent=Math.min(100,Math.round(entitlements.usage[key]*100/Math.max(1,entitlements.limits[key]))); return <div className="rounded-md border p-3" key={key}><p className="text-xs text-muted-foreground">{label}</p><p className="font-semibold">{entitlements.usage[key]} / {entitlements.limits[key]}</p><div className="mt-2 h-2 overflow-hidden rounded-md bg-muted"><div className={percent >= 100 ? "h-full bg-destructive" : percent >= (policy?.usage_alert_percent ?? 80) ? "h-full bg-amber-500" : "h-full bg-primary"} style={{width:`${percent}%`}} /></div>{percent >= (policy?.usage_alert_percent ?? 80) && <p className="mt-1 text-xs text-amber-700">{percent >= 100 ? traduzir("Limite incluído atingido.", idioma) : traduzir("Consumo próximo do limite.", idioma)}</p>}</div>; })}</div><p className="mt-4 text-sm"><strong>{entitlements.prepaid_ai_credits.toLocaleString(tagDeIdioma(idioma))}</strong> {traduzir("créditos pré-pagos disponíveis", idioma)}</p>{nextPlan && <p className="mt-2 rounded-md bg-muted p-3 text-sm">{traduzir("Pode compensar migrar para", idioma)} <strong>{nextPlan.name}</strong> ({money(nextPlan.price_cents)}{traduzir("/mês", idioma)}) {traduzir("antes de acumular adicionais.", idioma)}</p>}</Card>}
      <Card className="max-w-3xl p-6"><h2 className="text-sm font-semibold">{traduzir("Ao atingir a franquia de IA", idioma)}</h2><form action={saveBillingPreference} className="mt-3 flex flex-wrap items-end gap-3"><label className="text-sm">{traduzir("Ação", idioma)}<select className="ml-2 rounded-md border bg-background p-2" name="limit_action" defaultValue={preference?.limit_action ?? "block"}><option value="block">{traduzir("Bloquear novas respostas da IA", idioma)}</option><option value="credits">{traduzir("Consumir créditos pré-pagos", idioma)}</option>{(policy?.overage_unit_price_cents ?? 0)>0 && <option value="overage">{traduzir("Cobrar excedente até o teto", idioma)}</option>}</select></label><button className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" type="submit">{traduzir("Salvar política", idioma)}</button></form>{(policy?.overage_unit_price_cents ?? 0)>0 && <p className="mt-2 text-xs text-muted-foreground">{traduzir("Excedente:", idioma)} {money(policy!.overage_unit_price_cents)}/1.000 · {traduzir("teto", idioma)} {policy!.hard_limit_percent}%.</p>}</Card>
      <Card className="max-w-3xl p-6"><h2 className="text-sm font-semibold">{traduzir("Adicionar capacidade", idioma)}</h2><p className="mt-2 text-sm text-muted-foreground">{traduzir("A compra abre o checkout seguro da Stripe. A capacidade é liberada automaticamente após a confirmação do pagamento.", idioma)}</p><div className="mt-4 grid gap-3 md:grid-cols-2">{addons.map((addon) => <form className="rounded-md border p-4" action={`/checkout/addon/${addon.slug}`} method="post" key={addon.slug}><input type="hidden" name="intent_key" value={randomUUID()} /><h3 className="font-medium">{traduzir(addon.name, idioma)}</h3><p className="text-sm text-muted-foreground">+{addon.units} {traduzir(addon.resource, idioma)} · {new Intl.NumberFormat(tagDeIdioma(idioma),{style:"currency",currency:"BRL"}).format(addon.price_cents/100)}{traduzir("/mês", idioma)}</p><label className="mt-3 block text-sm">{traduzir("Quantidade", idioma)}<input className="ml-2 w-16 rounded-md border p-1" name="quantity" type="number" min="1" max="100" defaultValue="1" /></label><button className="mt-3 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" type="submit">{traduzir("Contratar adicional", idioma)}</button></form>)}</div></Card>
      <Card className="max-w-3xl p-6"><h2 className="text-sm font-semibold">{traduzir("Créditos pré-pagos de IA", idioma)}</h2><p className="mt-2 text-sm text-muted-foreground">{traduzir("Compra única. O saldo entra automaticamente após o pagamento e não altera sua mensalidade.", idioma)}</p><div className="mt-4 grid gap-3 md:grid-cols-3">{packs.map((pack)=><form className="rounded-md border p-4" action={`/checkout/credits/${pack.slug}`} method="post" key={pack.slug}><input type="hidden" name="intent_key" value={randomUUID()} /><h3 className="font-medium">{traduzir(pack.name, idioma)}</h3><p className="text-sm text-muted-foreground">{money(pack.price_cents)}</p><button className="mt-3 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" type="submit">{traduzir("Comprar créditos", idioma)}</button></form>)}</div>{policy?.meta_fees_notice && <p className="mt-4 text-xs text-muted-foreground">{policy.meta_fees_notice}</p>}</Card>
    </div>
  );
}
