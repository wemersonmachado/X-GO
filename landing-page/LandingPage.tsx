import Link from "next/link";
import type { CSSProperties } from "react";

import { melhorFrenteSobre } from "@/lib/branding/contraste";
import { marcaDaSaida } from "@/lib/branding/saida";

import styles from "./landing.module.css";
import { PlanConfigurator } from "./PlanConfigurator";
import { readLanding } from "./server";

const CAPABILITY_ICONS = ["↗", "✳", "◇", "◎", "⌘", "◈"];

const OPERATION_LAYERS = [
  { label: "Atendimento unificado", description: "Conversas, responsáveis e histórico ficam visíveis para toda a equipe.", icon: "01" },
  { label: "IA com conhecimento", description: "O agente consulta materiais do negócio e atua dentro das regras definidas.", icon: "02" },
  { label: "CRM no mesmo fluxo", description: "Contatos, oportunidades e próximos passos acompanham cada conversa.", icon: "03" },
  { label: "Gestão com clareza", description: "Acompanhe encaminhamentos, consumo e atividades sem perder o contexto.", icon: "04" },
];

export async function LandingPage() {
  const [config, brand] = await Promise.all([readLanding(), marcaDaSaida(null)]);

  return (
    <main
      className={styles.page}
      data-theme={config.theme}
      style={{
        "--landing-accent": config.accent,
        "--landing-accent-fg": melhorFrenteSobre(config.accent),
      } as CSSProperties}
    >
      <a className={styles.skip} href="#conteudo">Pular para o conteúdo</a>

      <nav className={styles.nav} aria-label="Navegação principal">
        <Link href="/" prefetch={false} className={styles.brand}>
          <span className={styles.mark}>✳</span>{brand.nome}
        </Link>
        <div className={styles.navLinks}>
          <a href="#recursos">Recursos</a><a href="#como-funciona">Como funciona</a><a href="#planos">Planos</a>
        </div>
        <div className={styles.navActions}>
          <a className={styles.navPlan} href="#planos">Ver planos</a>
          <a className={styles.login} href="/login">Entrar <span aria-hidden>↗</span></a>
        </div>
      </nav>

      <section id="conteudo" className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span />{config.eyebrow}</p>
          <h1>{config.title}</h1>
          <p className={styles.lead}>{config.subtitle}</p>
          <div className={styles.actions}>
            <a className={styles.primary} href={config.cta_url}>{config.cta_label} <span aria-hidden>↗</span></a>
            <a className={styles.secondary} href="#como-funciona">Veja como funciona <span aria-hidden>↓</span></a>
          </div>
          <div className={styles.heroProof} aria-label="Características principais">
            <span><i /> WhatsApp organizado</span><span><i /> IA com contexto</span><span><i /> Pessoas no controle</span>
          </div>
        </div>

        <div className={styles.scene} aria-label="Demonstração ilustrativa de um atendimento conectado ao CRM">
          <div className={styles.sceneGlow} aria-hidden />
          <div className={styles.gridPlane} aria-hidden />
          <div className={styles.orbit} aria-hidden />
          <div className={styles.orbit2} aria-hidden />
          <div className={`${styles.node} ${styles.nodeWhatsapp}`} aria-hidden><span>W</span><small>Conversa</small></div>
          <div className={`${styles.node} ${styles.nodeAi}`} aria-hidden><span>✦</span><small>Agente</small></div>
          <div className={`${styles.node} ${styles.nodeCrm}`} aria-hidden><span>◇</span><small>CRM</small></div>
          <div className={`${styles.flowBeam} ${styles.beamOne}`} aria-hidden />
          <div className={`${styles.flowBeam} ${styles.beamTwo}`} aria-hidden />

          <div className={styles.chat}>
            <div className={styles.chatHeader}>
              <span className={styles.avatar}>✳</span>
              <div><strong>Assistente da sua empresa</strong><small>Uma conversa. Todo o contexto.</small></div>
              <span className={styles.dot} aria-label="Disponível" />
            </div>
            <div className={styles.bubble}>Olá! Gostaria de saber mais sobre os serviços.</div>
            <div className={styles.thinking}><span /><span /><span /> Consultando conhecimento</div>
            <div className={styles.reply}>Olá! Posso ajudar. O que você precisa resolver hoje?</div>
            <div className={styles.event}><span>✓</span> Contato organizado no CRM</div>
            <div className={styles.event}><span>✓</span> Próximo passo definido</div>
            <div className={styles.chatInput}>Sua equipe acompanha por aqui <span>↗</span></div>
          </div>

          <div className={styles.floating}><span>✦</span><div><strong>Contexto conectado</strong><small>Conversa + conhecimento + ação</small></div></div>
          <div className={styles.floatingMetric}><span className={styles.metricPulse} /><div><strong>Próximo passo</strong><small>Follow-up organizado</small></div></div>
          <p className={styles.demo}>Demonstração ilustrativa do fluxo</p>
        </div>
      </section>

      <div className={styles.strip} aria-label="Recursos conectados">
        <span>WHATSAPP</span><i>+</i><span>AGENTES DE IA</span><i>+</i><span>CRM</span><i>+</i><span>SUA EQUIPE</span>
      </div>

      <section className={styles.pain}>
        <p className={styles.eyebrow}>O TEMPO DA SUA EQUIPE IMPORTA</p><h2>{config.pain_title}</h2><p>{config.pain_description}</p>
      </section>

      <section className={styles.operation} aria-labelledby="operation-title">
        <div className={styles.operationCopy}>
          <p className={styles.eyebrow}>UMA OPERAÇÃO QUE SE CONECTA</p>
          <h2 id="operation-title">Da primeira mensagem ao próximo passo, tudo continua no mesmo contexto.</h2>
          <p>O atendimento entra, a IA ajuda, o CRM registra e sua equipe decide. Menos troca de ferramentas e mais clareza sobre o que precisa acontecer agora.</p>
          <div className={styles.operationLayers}>
            {OPERATION_LAYERS.map((item) => (
              <article key={item.icon}><span>{item.icon}</span><div><h3>{item.label}</h3><p>{item.description}</p></div></article>
            ))}
          </div>
        </div>

        <div className={styles.workspace} aria-label="Painel ilustrativo de atendimento e oportunidades">
          <div className={styles.workspaceTop}>
            <div className={styles.windowDots}><i /><i /><i /></div><span>Operação em tempo real</span><strong><i /> Online</strong>
          </div>
          <div className={styles.workspaceBody}>
            <aside className={styles.workspaceNav} aria-hidden>
              <span className={styles.workspaceLogo}>✳</span><i data-active="true" /><i /><i /><i /><i />
            </aside>
            <div className={styles.workspaceMain}>
              <div className={styles.workspaceHeading}>
                <div><small>VISÃO DA OPERAÇÃO</small><strong>Conversas e oportunidades</strong></div><span>Hoje ▾</span>
              </div>
              <div className={styles.pipeline}>
                <div className={styles.pipelineColumn}>
                  <header><span>Novos contatos</span><b>3</b></header>
                  <div className={styles.leadCard}><i className={styles.leadAvatar}>AM</i><div><strong>André Martins</strong><small>Chegou pelo WhatsApp</small></div><em>agora</em></div>
                  <div className={styles.leadCard}><i className={styles.leadAvatar}>LC</i><div><strong>Larissa Costa</strong><small>Interesse identificado</small></div><em>4 min</em></div>
                </div>
                <div className={styles.pipelineColumn}>
                  <header><span>Em atendimento</span><b>2</b></header>
                  <div className={`${styles.leadCard} ${styles.leadCardActive}`}><i className={styles.leadAvatar}>RB</i><div><strong>Rafael Braga</strong><small>IA preparando resposta</small></div><em><span /> ativo</em></div>
                  <div className={styles.aiNote}><span>✦</span><p><strong>Contexto encontrado</strong>3 materiais relacionados</p></div>
                </div>
                <div className={styles.pipelineColumn}>
                  <header><span>Próximos passos</span><b>2</b></header>
                  <div className={styles.leadCard}><i className={styles.leadAvatar}>MS</i><div><strong>Marina Souza</strong><small>Reunião agendada</small></div><em>14:30</em></div>
                  <div className={styles.nextAction}><span>✓</span><p><strong>Follow-up preparado</strong>Responsável avisado</p></div>
                </div>
              </div>
              <div className={styles.workspaceSignal}><span /><p><strong>Fluxo conectado</strong>WhatsApp → Agente → CRM → Equipe</p><b>sem perder contexto</b></div>
            </div>
          </div>
        </div>
      </section>

      <section id="recursos" className={styles.section}>
        <p className={styles.eyebrow}>DA CONVERSA À AÇÃO</p><h2>{config.benefits_title}</h2>
        <div className={styles.grid}>
          {config.benefits.map((benefit, index) => (
            <article className={styles.card} key={index} style={{ "--card-index": index } as CSSProperties}>
              <span className={styles.cardNumber}>0{index + 1}</span><span className={styles.cardIcon} aria-hidden>{CAPABILITY_ICONS[index % CAPABILITY_ICONS.length]}</span>
              <h3>{benefit.title}</h3><p>{benefit.description}</p><span className={styles.cardLink} aria-hidden>Explorar recurso <i>↗</i></span>
            </article>
          ))}
        </div>
      </section>

      <section id="como-funciona" className={`${styles.section} ${styles.howSection}`}>
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>CLAREZA EM CADA ETAPA</p><h2>{config.steps_title}</h2></div><p>Uma implantação guiada, com cada etapa visível para sua equipe.</p>
        </div>
        <ol className={styles.steps}>
          {config.steps.map((step, index) => (
            <li key={index} style={{ "--step-index": index } as CSSProperties}><span>0{index + 1}</span><i aria-hidden /><h3>{step.title}</h3><p>{step.description}</p></li>
          ))}
        </ol>
      </section>

      <section id="planos" className={styles.section}>
        <p className={styles.eyebrow}>CRESÇA NO SEU RITMO</p><h2>{config.pricing_title}</h2><p className={styles.priceNote}>{config.pricing_note}</p>
        <div className={styles.prices}>
          {config.plans.map((plan, index) => (
            <article id={`plano-${plan.slug}`} className={styles.plan} data-featured={index === 1} key={plan.slug}>
              {index === 1 && <span className={styles.popular}>MAIS ESCOLHIDO</span>}
              <p className={styles.planLabel}>{index === 1 ? "MAIS POSSIBILIDADES" : "SEU PRÓXIMO PASSO"}</p>
              <h3>{plan.name}</h3><p>{plan.description}</p>
              <ul>{plan.features.map((feature, i) => <li key={i}><span>✓</span>{feature}</li>)}</ul>
              <PlanConfigurator plan={plan} addons={config.addons} billing={config.billing} nextPlan={index < config.plans.length - 1 ? config.plans[index + 1] : null} />
            </article>
          ))}
        </div>
      </section>

      <section className={styles.faq}>
        <p className={styles.eyebrow}>RESPOSTAS DIRETAS</p><h2>Antes de começar.</h2>
        {config.faq.map((item, index) => <details key={index}><summary>{item.question}<span aria-hidden>+</span></summary><p>{item.answer}</p></details>)}
      </section>

      <section id="proximo-passo" className={styles.closing}>
        <div className={styles.closingOrb} aria-hidden />
        <p className={styles.eyebrow}>CONSTRUA SUA PRÓXIMA ETAPA</p><h2>{config.closing_title}</h2><p>{config.closing_description}</p>
        <a className={styles.primary} href="#planos">Escolher meu plano <span aria-hidden>↗</span></a>
        <p className={styles.fine}>Já possui acesso? <a href="/login">Entre na sua organização →</a></p>
      </section>

      <footer className={styles.footer}>
        <Link className={styles.brand} href="/" prefetch={false}>{brand.nome}</Link><p>Conversas com contexto. Operações com direção.</p>
        <div><a href="/legal/privacy">Privacidade</a><a href="/legal/terms">Termos</a><a href="/login">Acessar plataforma</a></div>
      </footer>
    </main>
  );
}
