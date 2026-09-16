"use client";

import { useState } from "react";

import styles from "./landing.module.css";

type Addon = { slug: string; name: string; resource: keyof PlanLimits; units: number; price_cents: number; active: boolean };
type PlanLimits = { users: number; whatsapp: number; active_agents: number; monthly_conversations: number };
type Plan = { slug: string; name: string; price_cents: number; checkout_enabled: boolean; limits: PlanLimits };

const LIMITS: Array<{ key: keyof PlanLimits; label: string }> = [
  { key: "users", label: "usuários" },
  { key: "whatsapp", label: "WhatsApps" },
  { key: "active_agents", label: "agentes ativos" },
  { key: "monthly_conversations", label: "respostas de IA/mês" },
];

const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);

/** A interface só escolhe quantidades. Catálogo, preço e total são recalculados
 * no servidor antes de criar a sessão Stripe. */
export function PlanConfigurator({ plan, addons }: { plan: Plan; addons: Addon[] }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [intentKey] = useState(() => crypto.randomUUID());
  const activeAddons = addons.filter((addon) => addon.active);
  const total = plan.price_cents + activeAddons.reduce((sum, addon) => sum + (quantities[addon.slug] ?? 0) * addon.price_cents, 0);
  const selected = activeAddons.filter((addon) => (quantities[addon.slug] ?? 0) > 0);
  const limits = activeAddons.reduce<PlanLimits>((current, addon) => ({
    ...current,
    [addon.resource]: current[addon.resource] + addon.units * (quantities[addon.slug] ?? 0),
  }), { ...plan.limits });

  if (!plan.checkout_enabled) return <>
    <div className={styles.planSnapshot}>
      <p className={styles.investmentLabel}>INVESTIMENTO PERSONALIZADO</p>
      <strong className={styles.price}>Sob proposta</strong>
      <p className={styles.snapshotLead}>Um desenho de operação conforme o seu volume, equipe e integrações.</p>
      <ul className={styles.limitSummary}>{LIMITS.map(({ key, label }) => <li key={key}><strong>{new Intl.NumberFormat("pt-BR").format(limits[key])}</strong> {label}</li>)}</ul>
    </div>
    <a className={styles.primary} href="/login?next=/app/settings/billing">Solicitar proposta Enterprise ↗</a>
  </>;

  return <form action={`/checkout/${plan.slug}`} method="post" className={styles.planConfigurator}>
    <input name="intent_key" type="hidden" value={intentKey} />
    <div className={styles.planSnapshot} aria-live="polite">
      <p className={styles.investmentLabel}>{selected.length ? "SUA OPERAÇÃO SELECIONADA" : "INVESTIMENTO MENSAL"}</p>
      <strong className={styles.price}>{money(total)}<small>/mês</small></strong>
      <p className={styles.snapshotLead}>{selected.length ? "Seu plano já inclui os recursos adicionais escolhidos abaixo." : "Comece com esta estrutura e amplie somente quando precisar."}</p>
      <ul className={styles.limitSummary}>{LIMITS.map(({ key, label }) => <li key={key}><strong>{new Intl.NumberFormat("pt-BR").format(limits[key])}</strong> {label}</li>)}</ul>
    </div>
    <div className={styles.expansion}>
      <p>EXPANSÃO DO PLANO</p>
      {activeAddons.map((addon) => {
        const quantity = quantities[addon.slug] ?? 0;
        return <div className={styles.addonRow} key={addon.slug}>
          <span><strong>{addon.name}</strong><small>+{new Intl.NumberFormat("pt-BR").format(addon.units)} · {money(addon.price_cents)}/mês</small></span>
          <button type="button" aria-label={`Remover ${addon.name}`} disabled={quantity === 0} onClick={() => setQuantities((value) => ({ ...value, [addon.slug]: Math.max(0, quantity - 1) }))}>−</button>
          <b>{quantity}</b>
          <button type="button" aria-label={`Adicionar ${addon.name}`} onClick={() => setQuantities((value) => ({ ...value, [addon.slug]: Math.min(100, quantity + 1) }))}>+</button>
          <input name={`addon_${addon.slug}`} type="hidden" value={quantity} />
        </div>;
      })}
    </div>
    <div className={styles.planTotal}><span>TOTAL MENSAL NO CHECKOUT</span><strong>{money(total)}<small>/mês</small></strong></div>
    {selected.length > 0 && <p className={styles.addedBenefits}>Inclui: {selected.map((addon) => `+${quantities[addon.slug] * addon.units} ${addon.name.toLowerCase()}`).join(" · ")}</p>}
    <button className={styles.primary} type="submit">Contratar {plan.name} ↗</button>
  </form>;
}
