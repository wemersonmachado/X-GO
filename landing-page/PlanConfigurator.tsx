"use client";

import { useState } from "react";

import styles from "./landing.module.css";

type Addon = { slug: string; name: string; units: number; price_cents: number; active: boolean };
type Plan = { slug: string; name: string; price_cents: number; checkout_enabled: boolean };

const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);

/** A interface só escolhe quantidades. Catálogo, preço e total são recalculados
 * no servidor antes de criar a sessão Stripe. */
export function PlanConfigurator({ plan, addons }: { plan: Plan; addons: Addon[] }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [intentKey] = useState(() => crypto.randomUUID());
  const total = plan.price_cents + addons.reduce((sum, addon) => sum + (quantities[addon.slug] ?? 0) * addon.price_cents, 0);
  const selected = addons.filter((addon) => (quantities[addon.slug] ?? 0) > 0);

  if (!plan.checkout_enabled) return <a className={styles.primary} href="/login?next=/app/settings/billing">Solicitar proposta Enterprise ↗</a>;

  return <form action={`/checkout/${plan.slug}`} method="post" className={styles.planConfigurator}>
    <input name="intent_key" type="hidden" value={intentKey} />
    <div className={styles.expansion}>
      <p>EXPANSÃO DO PLANO</p>
      {addons.filter((addon) => addon.active).map((addon) => {
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
    <div className={styles.planTotal}><span>TOTAL MENSAL</span><strong>{money(total)}<small>/mês</small></strong></div>
    {selected.length > 0 && <p className={styles.addedBenefits}>Inclui: {selected.map((addon) => `+${quantities[addon.slug]} ${addon.name.toLowerCase()}`).join(" · ")}</p>}
    <button className={styles.primary} type="submit">Contratar {plan.name} ↗</button>
  </form>;
}
