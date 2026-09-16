import { randomUUID } from "node:crypto";

import styles from "./landing.module.css";

/** Sem checkout configurado, não simula compra nem coleta dados pessoais. */
export function PlanCta({ name, destination }: { name: string; destination: string }) {
  if (destination) {
    return (
      <form action={destination} method="post">
        <input name="intent_key" type="hidden" value={randomUUID()} />
        <button className={styles.primary} type="submit">Contratar {name} ↗</button>
      </form>
    );
  }
  return <details className={styles.planCta}>
    <summary className={styles.primary}>Contratar {name} <span aria-hidden>↗</span></summary>
    <p><strong>Checkout temporariamente indisponível.</strong> A publicação deste plano ainda precisa sincronizar com o provedor de pagamentos. Nenhuma cobrança foi realizada.</p>
  </details>;
}
