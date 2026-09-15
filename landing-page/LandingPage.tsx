import Link from "next/link";
import type { CSSProperties } from "react";
import { marcaDaSaida } from "@/lib/branding/saida";
import { melhorFrenteSobre } from "@/lib/branding/contraste";
import { readLanding } from "./server";
import styles from "./landing.module.css";
import { PlanCta } from "./PlanCta";

export async function LandingPage() {
  const [config, brand] = await Promise.all([readLanding(), marcaDaSaida(null)]);
  return (
    <main className={styles.page} data-theme={config.theme} style={{ "--landing-accent": config.accent, "--landing-accent-fg": melhorFrenteSobre(config.accent) } as CSSProperties}>
      <a className={styles.skip} href="#conteudo">Pular para o conteúdo</a>
      <nav className={styles.nav} aria-label="Navegação principal">
        <Link href="/" prefetch={false} className={styles.brand}><span className={styles.mark}>✳</span>{brand.nome}</Link>
        <div className={styles.navLinks}><a href="#recursos">Recursos</a><a href="#como-funciona">Como funciona</a><a href="#planos">Planos</a></div>
        <a className={styles.login} href="/login">Entrar <span aria-hidden>↗</span></a>
      </nav>
      <section id="conteudo" className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span />{config.eyebrow}</p>
          <h1>{config.title}</h1><p className={styles.lead}>{config.subtitle}</p>
          <div className={styles.actions}><a className={styles.primary} href={config.cta_url}>{config.cta_label} <span aria-hidden>↗</span></a><a className={styles.secondary} href="#como-funciona">Veja como funciona <span aria-hidden>↓</span></a></div>
          <p className={styles.fine}>IA com contexto · Equipe no controle · Acesso por convite</p>
        </div>
        <div className={styles.scene} aria-label="Demonstração ilustrativa de um atendimento com IA">
          <div className={styles.orbit} /><div className={styles.orbit2} />
          <div className={styles.chat}>
            <div className={styles.chatHeader}><span className={styles.avatar}>✳</span><div><strong>Assistente da sua empresa</strong><small>Uma conversa. Todo o contexto.</small></div><span className={styles.dot} /></div>
            <div className={styles.bubble}>Olá! Gostaria de saber mais sobre os serviços.</div>
            <div className={styles.reply}>Olá! Posso ajudar. O que você precisa resolver hoje?</div>
            <div className={styles.event}><span>✓</span> Contato organizado no CRM</div>
            <div className={styles.event}><span>✓</span> Próximo passo definido</div>
            <div className={styles.chatInput}>Sua equipe acompanha por aqui <span>↗</span></div>
          </div>
          <div className={styles.floating}><span>✦</span><div><strong>Contexto conectado</strong><small>Conversa + conhecimento + ação</small></div></div>
          <p className={styles.demo}>Demonstração ilustrativa do fluxo</p>
        </div>
      </section>
      <div className={styles.strip}><span>WHATSAPP</span><i>+</i><span>AGENTES DE IA</span><i>+</i><span>CRM</span><i>+</i><span>SUA EQUIPE</span></div>
      <section className={styles.pain}><p className={styles.eyebrow}>O TEMPO DA SUA EQUIPE IMPORTA</p><h2>{config.pain_title}</h2><p>{config.pain_description}</p></section>
      <section id="recursos" className={styles.section}><p className={styles.eyebrow}>DA CONVERSA À AÇÃO</p><h2>{config.benefits_title}</h2><div className={styles.grid}>{config.benefits.map((benefit, index) => <article className={styles.card} key={index}><span className={styles.cardIcon} aria-hidden>{["↗", "✳", "▦", "◎", "⌘", "◇"][index % 6]}</span><h3>{benefit.title}</h3><p>{benefit.description}</p></article>)}</div></section>
      <section id="como-funciona" className={styles.section}><p className={styles.eyebrow}>CLAREZA EM CADA ETAPA</p><h2>{config.steps_title}</h2><ol className={styles.steps}>{config.steps.map((step, index) => <li key={index}><span>0{index + 1}</span><h3>{step.title}</h3><p>{step.description}</p></li>)}</ol></section>
      <section id="planos" className={styles.section}><p className={styles.eyebrow}>CRESÇA NO SEU RITMO</p><h2>{config.pricing_title}</h2><p className={styles.priceNote}>{config.pricing_note}</p><div className={styles.prices}>{config.plans.map((plan, index) => <article className={styles.plan} data-featured={index === 1} key={plan.slug}><p className={styles.planLabel}>{index === 1 ? "MAIS POSSIBILIDADES" : "SEU PRÓXIMO PASSO"}</p><h3>{plan.name}</h3><p>{plan.description}</p><strong className={styles.price}>{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(plan.price_cents / 100)}/mês</strong><small>Cobrança mensal recorrente</small><ul>{plan.features.map((feature, i) => <li key={i}><span>✓</span>{feature}</li>)}</ul><PlanCta name={plan.name} destination={`/checkout/${plan.slug}`} /></article>)}</div></section>
      <section className={styles.faq}><h2>Antes de começar.</h2>{config.faq.map((item, index) => <details key={index}><summary>{item.question}<span aria-hidden>+</span></summary><p>{item.answer}</p></details>)}</section>
      <section id="proximo-passo" className={styles.closing}><p className={styles.eyebrow}>CONSTRUA SUA PRÓXIMA ETAPA</p><h2>{config.closing_title}</h2><p>{config.closing_description}</p><a className={styles.primary} href="#planos">Escolher meu plano ↗</a><p className={styles.fine}>Já possui acesso? <a href="/login">Entre na sua organização →</a></p></section>
      <footer className={styles.footer}><Link className={styles.brand} href="/" prefetch={false}>{brand.nome}</Link><p>Conversas com contexto. Operações com direção.</p><div><a href="/legal/privacy">Privacidade</a><a href="/legal/terms">Termos</a><a href="/login">Acessar plataforma</a></div></footer>
    </main>
  );
}
