import { stripeConfigured } from "@/lib/billing/stripe";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type PlanRow = { slug: string; name: string; price_cents: number; active: boolean };
type EventRow = { event_id: string; event_type: string; plan_slug: string | null; value_cents: number | null; status: string | null; created_at: string; provider: string };

export default async function PlatformBillingPage() {
  const idioma = "pt-BR" as const;
  const t = (texto: string) => traduzir(texto, idioma);
  const tag = tagDeIdioma(idioma);
  const moeda = new Intl.NumberFormat(tag, { style: "currency", currency: "BRL" });
  const data = new Intl.DateTimeFormat(tag, { dateStyle: "short", timeStyle: "short" });
  const admin = createAdminClient();
  const plansQuery = await admin.from("platform_billing_plans" as never).select("slug,name,price_cents,active").order("price_cents" as never);
  const eventsQuery = await admin.from("platform_payment_events" as never).select("event_id,event_type,plan_slug,value_cents,status,created_at,provider").order("created_at" as never, { ascending: false }).limit(30);
  const plans = (plansQuery.data ?? []) as unknown as PlanRow[];
  const events = (eventsQuery.data ?? []) as unknown as EventRow[];

  return <div className="space-y-6 p-6">
    <header><h1 className="text-2xl font-semibold">{t("Pagamentos")}</h1><p className="text-sm text-muted-foreground">{t("Checkout dinâmico via Stripe e eventos recebidos.")}</p></header>
    <p className="rounded-md border p-3 text-sm">Stripe: <strong>{stripeConfigured() ? t("configurado") : t("não configurado")}</strong>. {t("Os valores são alterados em Configurações da landing e cobrados no próximo checkout — não há link fixo pra sincronizar.")}</p>
    <section className="grid gap-4 md:grid-cols-3">{plans.map((plan) => <article className="rounded-lg border p-4" key={plan.slug}>
      <h2 className="font-semibold">{plan.name}</h2><p className="text-2xl">{moeda.format(plan.price_cents / 100)}</p>
      <p className="mt-2 text-xs text-muted-foreground">{plan.active ? t("Ativo") : t("Inativo — checkout indisponível")}</p>
    </article>)}</section>
    <section><h2 className="mb-3 font-semibold">{t("Eventos recentes")}</h2><div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-3">{t("Evento")}</th><th className="p-3">{t("Origem")}</th><th className="p-3">{t("Plano")}</th><th className="p-3">{t("Valor")}</th><th className="p-3">{t("Status")}</th><th className="p-3">{t("Recebido")}</th></tr></thead><tbody>{events.map((event) => <tr className="border-b" key={event.event_id}><td className="p-3">{event.event_type}</td><td className="p-3">{event.provider}</td><td className="p-3">{event.plan_slug ?? t("A conciliar")}</td><td className="p-3">{event.value_cents == null ? "—" : moeda.format(event.value_cents / 100)}</td><td className="p-3">{event.status ?? "—"}</td><td className="p-3">{data.format(new Date(event.created_at))}</td></tr>)}</tbody></table>
      {events.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t("Nenhum evento recebido.")}</p>}
    </div></section>
  </div>;
}
