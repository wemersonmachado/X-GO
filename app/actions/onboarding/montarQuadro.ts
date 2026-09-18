"use server";

/**
 * O PASSO "ONDE ELE ORGANIZA": pedir o quadro à IA e gravá-lo.
 *
 * Duas metades, e a separação é deliberada: `dadosDoPasso` só LÊ (chama a IA no
 * render e devolve a proposta para a tela mostrar) e `aplicarQuadro` só ESCREVE
 * (grava o que a pessoa aprovou). Fazer as duas num clique economizaria uma tela
 * e trocaria o quadro do dono por um texto que ele nunca viu.
 */
import { redirect } from "next/navigation";
import { generateText } from "ai";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildModel, chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { loadCredential } from "@/lib/ai/credentials";
import { slugDeNome } from "@/lib/leads/stage-editing";
import {
  etapasParaGravar,
  normalizarProposta,
  validarProposta,
  type PropostaDeFunil,
} from "@/lib/onboarding/proposta-de-funil";
import {
  escolherPacotePorTexto,
  sugerirFunil,
  type Sugestao,
} from "@/lib/onboarding/sugerir-funil";
import {
  requireOnboardingCtx,
  patchOnboardingState,
  loadOnboardingState,
  OnboardingError,
} from "./_shared";

/** O funil que o gatilho semeou — o que a pessoa tem antes deste passo. */
export interface QuadroAtual {
  pipelineId: string;
  nome: string;
  slug: string;
  position: number;
  colunas: string[];
}

/**
 * A versão publicada do funcionário criado no passo anterior.
 *
 * A sugestão sai DAQUI e não de uma configuração própria: é a chave que a pessoa
 * acabou de confirmar, e uma sugestão que funcionasse com outro modelo esconderia
 * justamente o defeito que ela precisa descobrir agora.
 */
async function cerebroDoFuncionario(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<{ provider: string; model: string; apiKey: string } | { erro: string }> {
  const { data: agente } = await admin
    .from("ai_agents")
    .select("published_version_id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();

  const versionId = agente?.published_version_id as string | null | undefined;
  if (!versionId) {
    // Quem pulou o passo de treinar, ou ficou com o agente em rascunho por não
    // ter número, chega aqui sem cérebro. Não é erro: é o quadro pronto.
    return { erro: "seu funcionário ainda não está no ar" };
  }

  const { data: versao } = await admin
    .from("ai_agent_versions")
    .select("provider, model, credential_id")
    .eq("id", versionId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!versao) return { erro: "não achei a configuração do seu funcionário" };

  const provider = String(versao.provider ?? "");
  const model = String(versao.model ?? "");
  if (!provider || !model) return { erro: "seu funcionário está sem modelo definido" };

  // Mesma ordem do turno de produção e do ensaio: a credencial cadastrada vence,
  // e na falta dela vale a chave que veio na instalação.
  const credentialId = versao.credential_id as string | null;
  if (credentialId) {
    try {
      const cred = await loadCredential(credentialId, orgId);
      return { provider, model, apiKey: cred.apiKey };
    } catch {
      return { erro: "não consegui usar a chave cadastrada" };
    }
  }

  const daInstalacao = chaveDePlataforma(provider);
  if (!daInstalacao) return { erro: `esta instalação não tem chave de ${provider}` };
  return { provider, model, apiKey: daInstalacao };
}

async function carregarQuadroAtual(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<QuadroAtual | null> {
  const { data: funil } = await admin
    .from("crm_pipelines")
    .select("id, name, slug, position")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();
  if (!funil) return null;

  const { data: etapas } = await admin
    .from("crm_stages")
    .select("name, position")
    .eq("pipeline_id", funil.id)
    .eq("is_archived", false)
    .order("position");

  return {
    pipelineId: funil.id as string,
    nome: String(funil.name ?? ""),
    slug: String(funil.slug ?? ""),
    position: Number(funil.position ?? 1000),
    colunas: (etapas ?? []).map((e) => String(e.name ?? "")),
  };
}

export interface DadosDoPasso {
  atual: QuadroAtual | null;
  sugestao: Sugestao;
}

/**
 * O que a tela precisa para se desenhar: o quadro que existe hoje e a proposta.
 *
 * Roda no SERVIDOR, no render da página — não num clique. A pessoa chega no
 * passo com a proposta pronta na tela; pedir que ela clique em "gerar sugestão"
 * primeiro seria cobrar um passo a mais para chegar ao mesmo lugar.
 */
export async function dadosDoPasso(orgId: string, negocio: string): Promise<DadosDoPasso> {
  const admin = createAdminClient();
  const atual = await carregarQuadroAtual(admin, orgId);

  let oQueFaz = "";
  try {
    const { state } = await loadOnboardingState(orgId);
    oQueFaz = state.welcome?.o_que_faz ?? "";
  } catch {
    oQueFaz = "";
  }

  const ctx = { nome: negocio, oQueFaz };
  const cerebro = await cerebroDoFuncionario(admin, orgId);

  if ("erro" in cerebro) {
    return {
      atual,
      sugestao: {
        origem: "pacote",
        pacote: escolherPacotePorTexto(`${negocio} ${oQueFaz}`),
        porque: cerebro.erro,
      },
    };
  }

  const sugestao = await sugerirFunil(ctx, async ({ system, prompt }) => {
    const r = await generateText({
      model: buildModel(cerebro.provider, cerebro.apiKey, cerebro.model),
      system,
      prompt,
      // Teto baixo de propósito: são sete linhas de JSON. Um modelo que resolva
      // discursar bate no teto em vez de queimar o crédito de quem acabou de
      // colar a chave.
      maxOutputTokens: 900,
    });
    return r.text;
  });

  return { atual, sugestao };
}

export type ResultadoDoQuadro =
  | { ok: true }
  | {
      ok: false;
      /**
       * Em português e já explicado — as recusas da função do banco são estados
       * NORMAIS do produto (funil com negócio, etapa usada por webhook), não
       * erros, e a pessoa precisa entender o que fazer.
       */
      erro: string;
    };

/**
 * Grava o quadro que a pessoa aprovou na tela.
 *
 * A proposta viaja da tela de volta para cá porque ela é EDITÁVEL: o que se
 * grava é o que a pessoa está vendo, não o que a IA propôs. Regerar aqui
 * entregaria um quadro diferente do aprovado — e num modelo com temperatura,
 * diferente a cada clique.
 */
export async function aplicarQuadro(formData: FormData): Promise<ResultadoDoQuadro> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError)
      return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
    throw err;
  }

  let bruta: unknown;
  try {
    bruta = JSON.parse(String(formData.get("quadro") ?? "null"));
  } catch {
    return { ok: false, erro: "Não consegui ler o quadro. Recarregue a página e tente de novo." };
  }

  // Revalida do lado de cá: o que chega de um formulário é entrada externa,
  // mesmo tendo saído daqui há dois minutos.
  const proposta: PropostaDeFunil = normalizarProposta(
    (bruta ?? {}) as { nome?: unknown; etapas?: unknown },
  );
  const veredito = validarProposta(proposta);
  if (!veredito.ok) return { ok: false, erro: veredito.erros.join(" ") };

  const admin = createAdminClient();
  const atual = await carregarQuadroAtual(admin, ctx.orgId);
  if (!atual) return { ok: false, erro: "Não encontrei o quadro desta empresa." };

  // O slug do funil não pode colidir com o de outro funil da organização
  // (`uniq_crm_pipelines_org_slug`). O do próprio funil sai da lista: renomear
  // "Pedidos" para "Pedidos" não pode virar "pedidos_2".
  const { data: outros } = await admin
    .from("crm_pipelines")
    .select("slug")
    .eq("organization_id", ctx.orgId)
    .neq("id", atual.pipelineId);
  const slug = slugDeNome(
    proposta.nome,
    (outros ?? []).map((p) => String(p.slug ?? "")),
    "funil",
  );

  const { data: resposta, error } = await admin.rpc("fn_aplicar_quadro_do_onboarding", {
    p_organization_id: ctx.orgId,
    p_pipeline_id: atual.pipelineId,
    p_nome: proposta.nome,
    p_slug: slug,
    p_etapas: etapasParaGravar(proposta, slugDeNome).map((e) => ({
      nome: e.nome,
      slug: e.slug,
      position: e.position,
      is_won: e.is_won,
      is_lost: e.is_lost,
      agent_stage_hint: e.agent_stage_hint,
    })),
  });

  if (error) return { ok: false, erro: `Não consegui salvar o quadro: ${error.message}` };

  const r = (resposta ?? {}) as { ok?: boolean; motivo?: string; quantos?: number };
  if (!r.ok) {
    // Clientes e fontes de webhook tornam a substituição destrutiva. Em vez de
    // deixar o wizard terminar num beco, nasce um novo quadro padrão: os
    // clientes antigos e a integração continuam no quadro anterior, enquanto
    // os próximos atendimentos passam a entrar no modelo escolhido.
    if (r.motivo === "funil_com_negocios" || r.motivo === "etapa_em_uso_por_webhook") {
      const criado = await criarQuadroPreservandoAtual({
        admin,
        orgId: ctx.orgId,
        atual,
        proposta,
        slug: slugDeNome(
          proposta.nome,
          [...(outros ?? []).map((p) => String(p.slug ?? "")), atual.slug],
          "funil",
        ),
      });
      if (!criado.ok) return criado;
      return finalizarQuadro({
        ctx,
        pipelineId: criado.pipelineId,
        origem: String(formData.get("origem") ?? "pacote") === "ia" ? "ia" : "pacote",
        etapas: proposta.etapas.length,
        nome: proposta.nome,
        preservouQuadroAnterior: true,
      });
    }
    return { ok: false, erro: explicarRecusa(r.motivo, r.quantos) };
  }

  return finalizarQuadro({
    ctx,
    pipelineId: atual.pipelineId,
    origem: String(formData.get("origem") ?? "pacote") === "ia" ? "ia" : "pacote",
    etapas: proposta.etapas.length,
    nome: proposta.nome,
    preservouQuadroAnterior: false,
  });
}

async function criarQuadroPreservandoAtual(args: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  atual: QuadroAtual;
  proposta: PropostaDeFunil;
  slug: string;
}): Promise<{ ok: true; pipelineId: string } | { ok: false; erro: string }> {
  const { admin, orgId, atual, proposta, slug } = args;
  const { data: novo, error: novoErro } = await admin
    .from("crm_pipelines")
    .insert({
      organization_id: orgId,
      name: proposta.nome,
      slug,
      position: atual.position + 1,
      is_default: false,
    })
    .select("id")
    .single();
  if (novoErro || !novo)
    return {
      ok: false,
      erro: "Não consegui criar o novo quadro. Seus clientes não foram alterados.",
    };

  const pipelineId = novo.id as string;
  const { error: etapasErro } = await admin.from("crm_stages").insert(
    etapasParaGravar(proposta, slugDeNome).map((etapa) => ({
      organization_id: orgId,
      pipeline_id: pipelineId,
      name: etapa.nome,
      slug: etapa.slug,
      position: etapa.position,
      is_won: etapa.is_won,
      is_lost: etapa.is_lost,
      agent_stage_hint: etapa.agent_stage_hint,
    })),
  );
  if (etapasErro) {
    await admin.from("crm_pipelines").delete().eq("id", pipelineId).eq("organization_id", orgId);
    return {
      ok: false,
      erro: "Não consegui montar as colunas do novo quadro. Seus clientes não foram alterados.",
    };
  }

  // O índice de padrão é imediato: libera o antigo, depois ocupa o lugar. Se
  // a segunda escrita falhar, restaura o antigo e remove o quadro recém-criado.
  const { error: liberarErro } = await admin
    .from("crm_pipelines")
    .update({ is_default: false })
    .eq("id", atual.pipelineId)
    .eq("organization_id", orgId);
  if (!liberarErro) {
    const { error: elegerErro } = await admin
      .from("crm_pipelines")
      .update({ is_default: true })
      .eq("id", pipelineId)
      .eq("organization_id", orgId);
    if (!elegerErro) return { ok: true, pipelineId };
    await admin
      .from("crm_pipelines")
      .update({ is_default: true })
      .eq("id", atual.pipelineId)
      .eq("organization_id", orgId);
  }
  await admin.from("crm_pipelines").delete().eq("id", pipelineId).eq("organization_id", orgId);
  return {
    ok: false,
    erro: "Não consegui definir o novo quadro como padrão. Seus clientes não foram alterados.",
  };
}

async function finalizarQuadro(args: {
  ctx: Awaited<ReturnType<typeof requireOnboardingCtx>>;
  pipelineId: string;
  origem: "ia" | "pacote";
  etapas: number;
  nome: string;
  preservouQuadroAnterior: boolean;
}): Promise<ResultadoDoQuadro> {
  const { ctx, pipelineId, origem, etapas, nome, preservouQuadroAnterior } = args;
  try {
    await patchOnboardingState(ctx.orgId, {
      funil: {
        pipeline_id: pipelineId,
        origem,
        etapas,
        preservou_quadro_anterior: preservouQuadroAnterior,
      },
    });
  } catch (err) {
    if (err instanceof OnboardingError)
      return {
        ok: false,
        erro: "Salvei o quadro, mas não consegui registrar o passo. Tente continuar de novo.",
      };
    throw err;
  }

  await audit({
    action: "onboarding.quadro_montado",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "crm_pipeline",
    resourceId: pipelineId,
    metadata: { origem, etapas, nome, preservou_quadro_anterior: preservouQuadroAnterior },
  });

  redirect("/onboarding");
}

/** As recusas da função do banco, ditas para quem não sabe o que é uma FK. */
function explicarRecusa(motivo: string | undefined, quantos: number | undefined): string {
  switch (motivo) {
    case "funil_com_negocios":
      return (
        `Este quadro já tem ${quantos ?? "alguns"} cliente(s) dentro, então trocar as colunas agora ` +
        `deixaria eles sem lugar. Você pode ajustar as colunas depois, em Configurações › Funis.`
      );
    case "etapa_em_uso_por_webhook":
      return (
        "Uma das colunas atuais está sendo usada por uma integração que traz clientes de fora. " +
        "Trocar o quadro desligaria essa integração, então preferi não mexer — ajuste em Configurações › Funis."
      );
    case "funil_nao_encontrado":
      return "Não encontrei o quadro desta empresa. Recarregue a página.";
    default:
      return "Não consegui montar o quadro agora. Você pode fazer isso depois em Configurações › Funis.";
  }
}

export async function pularQuadro(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, { funil: { skipped: true } });
  // Pular também é decisão, e é a que deixa o quadro de e-commerce de pé numa
  // clínica: sem registro, ninguém consegue explicar depois por que aquele
  // tenant tem "Carrinho abandonado" no quadro.
  await audit({
    action: "onboarding.quadro_pulado",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "organization",
    resourceId: ctx.orgId,
  });
  redirect("/onboarding");
}
