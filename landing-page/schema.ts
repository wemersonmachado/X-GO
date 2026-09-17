import { z } from "zod";

const text = z.string().trim().min(1).max(400);
const destination = z.string().trim().max(1000).refine((value) => {
  if (/[\u0000-\u0020\\]/.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}, "Use um caminho interno ou endereço HTTPS.");
const card = z.object({ title: text, description: text }).strict();
const checkout = z.union([z.literal(""), destination]);
const planLimits = z.object({ users: z.number().int().min(1).max(10000), whatsapp: z.number().int().min(1).max(10000), active_agents: z.number().int().min(1).max(10000), monthly_conversations: z.number().int().min(1).max(10_000_000), mcp: z.boolean() }).strict();
const addon = z.object({ slug: z.enum(["extra_user", "extra_whatsapp", "extra_active_agent", "extra_conversations_1000"]), name: text, resource: z.enum(["users", "whatsapp", "active_agents", "monthly_conversations"]), units: z.number().int().min(1).max(1_000_000), price_cents: z.number().int().min(100).max(10_000_000), active: z.boolean() }).strict();
const creditPack = z.object({ slug: z.enum(["ai_credits_5000", "ai_credits_10000", "ai_credits_25000"]), name: text, units: z.number().int().min(1000).max(1_000_000), price_cents: z.number().int().min(100).max(10_000_000), active: z.boolean() }).strict();
const billingPolicy = z.object({
  annual_discount_percent: z.number().int().min(0).max(40),
  trial_days: z.number().int().min(0).max(30),
  usage_alert_percent: z.number().int().min(50).max(99),
  hard_limit_percent: z.number().int().min(100).max(200),
  overage_unit_price_cents: z.number().int().min(0).max(100_000),
  outcome_billing_enabled: z.boolean(),
  outcome_price_cents: z.number().int().min(0).max(10_000_000),
  meta_fees_notice: text,
}).strict();
export const landingSchema = z.object({
  theme: z.enum(["dark", "light"]),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  eyebrow: text,
  title: text,
  subtitle: text,
  cta_label: text,
  cta_url: destination,
  pain_title: text,
  pain_description: text,
  benefits_title: text,
  benefits: z.array(card).min(3).max(9),
  steps_title: text,
  steps: z.array(card).min(3).max(6),
  pricing_title: text,
  pricing_note: text,
  plans: z.array(z.object({ slug: z.enum(["standard", "pro", "enterprise"]), name: text, price_cents: z.number().int().min(100).max(10_000_000), payment_link_id: z.string().trim().max(120), checkout_url: checkout, checkout_enabled: z.boolean().default(true), description: text, features: z.array(text).min(1).max(8), limits: planLimits }).strict()).length(3),
  addons: z.array(addon).length(4),
  credit_packs: z.array(creditPack).length(3),
  billing: billingPolicy,
  faq: z.array(z.object({ question: text, answer: text }).strict()).min(1).max(10),
  closing_title: text,
  closing_description: text,
}).strict();
export type LandingConfig = z.infer<typeof landingSchema>;
export const DEFAULT_LANDING: LandingConfig = {
  theme: "dark", accent: "#8674ff", eyebrow: "ATENDIMENTO + IA + CRM, NO MESMO LUGAR",
  title: "Cada conversa pode ser o começo de uma venda.",
  subtitle: "Dê à sua equipe agentes de IA que conhecem seu negócio. Organize o WhatsApp, acompanhe oportunidades e mantenha pessoas no controle do atendimento.",
  cta_label: "Escolher meu plano", cta_url: "/#planos",
  pain_title: "Seu atendimento cresceu. A organização precisa acompanhar.",
  pain_description: "Mensagens espalhadas, respostas repetidas e oportunidades sem próximo passo consomem o tempo da equipe. Reúna a conversa, o contexto e a ação em um único fluxo.",
  benefits_title: "Menos tarefas repetidas. Mais espaço para atender bem.",
  benefits: [
    { title: "Uma caixa de entrada para a equipe", description: "Distribua conversas, veja responsáveis e acompanhe o histórico sem perder o contexto do cliente." },
    { title: "Agentes com a voz do seu negócio", description: "Defina instruções, materiais e ferramentas. Teste o comportamento antes de liberar o atendimento." },
    { title: "Oportunidades com próximo passo", description: "Organize contatos, etapas do funil, tarefas e agendamentos junto da conversa." },
    { title: "Pessoas no controle", description: "Encaminhe situações para um atendente e acompanhe as ações da IA com histórico e permissões." },
    { title: "Liberdade para escolher sua IA", description: "Conecte provedores compatíveis ou integre seu agente externo pelas ferramentas do CRM." },
    { title: "Cada empresa no seu espaço", description: "Personalize a marca, a equipe e as áreas visíveis de cada organização, com acessos separados." },
  ],
  steps_title: "Do seu negócio ao primeiro atendimento.",
  steps: [
    { title: "Personalize seu espaço", description: "Receba o convite, entre na organização e configure nome, identidade visual e equipe." },
    { title: "Conecte o atendimento", description: "Vincule o WhatsApp e escolha o provedor de IA que fará parte da operação." },
    { title: "Prepare seu agente", description: "Defina a função, adicione conhecimento e selecione o que ele pode fazer. O rascunho guarda seu progresso." },
    { title: "Teste, publique e acompanhe", description: "Confira as respostas, libere o agente e acompanhe conversas, encaminhamentos e consumo." },
  ],
  pricing_title: "Encontre o formato da sua operação.",
  pricing_note: "Escolha o plano ideal e conclua a contratação no ambiente seguro de pagamentos.",
  plans: [
    { slug: "standard", name: "Standard", price_cents: 19700, payment_link_id: "", checkout_url: "", checkout_enabled: true, description: "Para organizar os primeiros atendimentos.", features: ["Caixa de entrada compartilhada", "Contatos e funil de vendas", "Histórico centralizado da equipe", "MCP e configuração inicial de agente", "Visão de oportunidades e próximos passos", "Base para crescer no seu ritmo"], limits: { users: 3, whatsapp: 1, active_agents: 3, monthly_conversations: 3000, mcp: true } },
    { slug: "pro", name: "Pro", price_cents: 49700, payment_link_id: "", checkout_url: "", checkout_enabled: true, description: "Para uma operação com mais fluxos e automação.", features: ["Todos os recursos do Standard", "Agentes e base de conhecimento", "Fluxos e acompanhamento de consumo", "Mais capacidade para equipe e canais", "Contexto compartilhado entre atendimentos", "Estrutura para operações em expansão"], limits: { users: 10, whatsapp: 3, active_agents: 10, monthly_conversations: 15000, mcp: true } },
    { slug: "enterprise", name: "Enterprise", price_cents: 99700, payment_link_id: "", checkout_url: "", checkout_enabled: false, description: "Implantação e mensalidade desenhadas para a sua operação.", features: ["Todos os recursos do Pro", "Integrações externas por MCP", "Suporte prioritário e personalização", "Escopo alinhado ao seu volume operacional", "Capacidade dimensionada para sua equipe", "Implantação acompanhada conforme o projeto"], limits: { users: 20, whatsapp: 20, active_agents: 25, monthly_conversations: 50000, mcp: true } },
  ],
  addons: [
    { slug: "extra_user", name: "Usuário adicional", resource: "users", units: 1, price_cents: 2999, active: true },
    { slug: "extra_whatsapp", name: "WhatsApp adicional", resource: "whatsapp", units: 1, price_cents: 5900, active: true },
    { slug: "extra_active_agent", name: "Agente ativo adicional", resource: "active_agents", units: 1, price_cents: 2900, active: true },
    { slug: "extra_conversations_1000", name: "Mais 1.000 respostas de IA", resource: "monthly_conversations", units: 1000, price_cents: 1999, active: true },
  ],
  credit_packs: [
    { slug: "ai_credits_5000", name: "5.000 créditos de IA", units: 5000, price_cents: 9995, active: true },
    { slug: "ai_credits_10000", name: "10.000 créditos de IA", units: 10000, price_cents: 19990, active: true },
    { slug: "ai_credits_25000", name: "25.000 créditos de IA", units: 25000, price_cents: 49975, active: true },
  ],
  billing: {
    annual_discount_percent: 0,
    trial_days: 0,
    usage_alert_percent: 80,
    hard_limit_percent: 100,
    overage_unit_price_cents: 0,
    outcome_billing_enabled: false,
    outcome_price_cents: 0,
    meta_fees_notice: "As tarifas oficiais da Meta para mensagens do WhatsApp são cobradas separadamente da assinatura da plataforma.",
  },
  faq: [
    { question: "Preciso trocar a minha equipe por IA?", answer: "Não. Agentes e pessoas trabalham juntos. Você define a atuação da IA e quando encaminhar a conversa para um atendente." },
    { question: "Posso usar um agente que já tenho?", answer: "A plataforma expõe ferramentas via MCP para integrações externas. A conexão exige um cliente compatível e configuração das permissões da organização." },
    { question: "Como contrato um plano?", answer: "Compare os recursos, escolha Standard, Pro ou Enterprise e conclua o pagamento no checkout seguro. A ativação é confirmada após o processamento do pagamento." },
  ],
  closing_title: "Seu próximo atendimento pode começar melhor.",
  closing_description: "Conheça a operação, escolha seu formato e prepare seu time para transformar conversas em próximos passos.",
};
