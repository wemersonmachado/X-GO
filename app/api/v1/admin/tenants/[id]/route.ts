import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import { removerContaSemAcesso } from "@/lib/auth/remover-conta-orfa";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/tenants/[id]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Load the organization (service-role bypasses RLS — intentional cross-tenant)
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select(
      `
      id,
      slug,
      display_name,
      legal_name,
      cnpj,
      status,
      onboarded_at,
      suspended_at,
      created_at,
      settings
    `,
    )
    .eq("id", id)
    .single();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  // Run counts in parallel — service role, all cross-tenant reads are intentional
  const [
    usersRes,
    conversationsRes,
    messagesRes,
    leadsRes,
    ordersRes,
    lgpdRes,
    aiRes,
    wahaRes,
    integrationRes,
  ] = await Promise.all([
    admin
      .from("user_organizations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("crm_leads")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("lgpd_requests")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      // `pending` não existe em `lgpd_requests_status_check`
      // (received/processing/completed/failed/expired), então este contador era
      // sempre 0 e a tela jurava que o tenant não devia nada à LGPD. Aqui
      // pendente = TUDO que ainda não fechou, sem recorte de prazo. O KPI de
      // plataforma (`app/api/v1/admin/dashboard/kpis/route.ts`) parte do mesmo
      // "não fechado" mas soma só o que vence nos próximos 5 dias — os dois
      // números divergem de propósito: este é o total do tenant, aquele é a
      // fila de SLA da plataforma.
      .not("status", "in", "(completed,failed)"),
    // `llm_calls` e não `ai_invocations`: a migration 0130 deixou a segunda sem
    // nenhum escritor (`lib/ai/log-invocation.ts` passou a gravar na primeira).
    // Lendo a tabela morta, este contador viraria ZERO em 30 dias para todo
    // tenant — com o dinheiro saindo. É o mesmo sintoma que a 0130 veio matar.
    admin
      .from("llm_calls")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      .gte(
        "created_at",
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    admin
      .from("channel_sessions")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("tenant_integrations")
      // `connected_at` não existe: a linha passa a existir quando a integração
      // é conectada, então `created_at` é essa mesma data com o nome real.
      .select("id, provider, status, created_at")
      .eq("organization_id", id)
      .eq("provider", "nuvemshop")
      .limit(1),
  ]);

  const counts = {
    user_count: usersRes.count ?? 0,
    conversations_count: conversationsRes.count ?? 0,
    messages_count: messagesRes.count ?? 0,
    leads_count: leadsRes.count ?? 0,
    orders_count: ordersRes.count ?? 0,
    lgpd_requests_pending: lgpdRes.count ?? 0,
    ai_invocations_30d: aiRes.count ?? 0,
    waha_sessions_count: wahaRes.count ?? 0,
  };

  const nuvemshopIntegration =
    integrationRes.data && integrationRes.data.length > 0
      ? integrationRes.data[0]
      : null;

  const integrations = {
    nuvemshop_status: nuvemshopIntegration?.status ?? null,
    // Nome de SAÍDA preservado: é o que TenantOverview já lê. Só a coluna de
    // origem estava errada.
    nuvemshop_connected_at: nuvemshopIntegration?.created_at ?? null,
  };

  // Audit lightweight — fire-and-forget
  void audit({
    action: "platform_admin.tenant_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "organization",
    resourceId: id,
    requestId,
    metadata: { tenant_slug: org.slug },
  });

  return ok({ organization: org, counts, integrations }, { requestId });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/tenants/[id] — exclusão DEFINITIVA de um tenant
// ---------------------------------------------------------------------------
/**
 * Apaga a organização e, por `on delete cascade`, TUDO que pertence a ela:
 * 112 tabelas, entre elas `contacts`, `conversations`, `messages`, `crm_leads`,
 * `channel_sessions` e `user_organizations`. Não há lixeira e não há desfazer.
 *
 * ## Por que existe
 *
 * Antes disto, o ciclo de vida de um tenant terminava em `suspended` e a linha
 * ficava no banco para sempre. Quem administra a instalação não tinha como
 * remover um tenant de teste, um cliente que saiu, ou uma organização criada por
 * engano — e o painel não dizia que não tinha: a pessoa procurava o botão, não
 * achava, e concluía que tinha procurado errado.
 *
 * ## As duas travas, e por que são duas
 *
 * 1. **A organização precisa estar SUSPENSA.** Excluir é o segundo passo de um
 *    ciclo de dois — suspender é reversível e visível para o cliente, excluir
 *    não é nenhum dos dois. A trava também garante que ninguém apaga um tenant
 *    que está atendendo: para chegar aqui, o atendimento já parou.
 * 2. **O `slug` tem de ser digitado.** `confirm_slug` precisa bater exatamente
 *    com o da organização. Um clique errado numa lista não apaga nada; só apaga
 *    quem escreveu o nome do que está apagando.
 *
 * As duas juntas cobrem os dois erros diferentes: a trava 1 pega "eu não sabia
 * que isso apagava de verdade", a trava 2 pega "eu cliquei na linha errada".
 *
 * ## A auditoria SOBREVIVE — e isso é do schema
 *
 * `api_audit_log.organization_id` é `ON DELETE SET NULL` (não cascade), então a
 * linha desta exclusão continua existindo depois que a organização deixa de
 * existir. É por isso que `metadata` carrega `tenant_id` e `tenant_slug`
 * DUPLICADOS: quando o FK vira `NULL`, o metadata é a única coisa que ainda
 * responde QUAL organização foi apagada. Sem essa duplicação a exclusão viraria
 * uma linha de auditoria que não diz o que apagou.
 *
 * A auditoria é gravada **antes** do `delete`, e com `await` em vez do
 * `fire-and-forget` do resto do arquivo: se a auditoria falhar, a exclusão não
 * acontece. Aqui a ordem inversa (apagar e depois tentar registrar) deixaria o
 * pior desfecho possível — dado destruído sem rastro de quem o destruiu.
 */
const deleteBodySchema = z.object({
  confirm_slug: z.string().min(1, "Confirmação obrigatória"),
});

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supportDenied = await requireSupportWrite(id);
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  if (adminCtx.platformAdmin.scope !== "full") {
    return fail("forbidden", "Seu acesso não permite excluir organizações", 403, { requestId });
  }

  let body: z.infer<typeof deleteBodySchema>;
  try {
    body = deleteBodySchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug, display_name, status")
    .eq("id", id)
    .maybeSingle();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  if (org.status !== "suspended") {
    return fail(
      "state_conflict",
      "Suspenda a organização antes de excluí-la. Excluir é definitivo e não tem desfazer.",
      409,
      { requestId },
    );
  }

  if (body.confirm_slug !== org.slug) {
    return fail(
      "validation_failed",
      "A confirmação não bate com o identificador da organização.",
      400,
      { requestId },
    );
  }

  // Contagem ANTES de apagar — depois do `delete` não há a quem perguntar, e
  // "quantas conversas foram destruídas" é a pergunta que alguém vai fazer.
  const [usersRes, conversationsRes, messagesRes, contactsRes, leadsRes, memberIdsRes] =
    await Promise.all([
      admin.from("user_organizations").select("*", { count: "exact", head: true }).eq("organization_id", id),
      admin.from("conversations").select("*", { count: "exact", head: true }).eq("organization_id", id),
      admin.from("messages").select("*", { count: "exact", head: true }).eq("organization_id", id),
      admin.from("contacts").select("*", { count: "exact", head: true }).eq("organization_id", id),
      admin.from("crm_leads").select("*", { count: "exact", head: true }).eq("organization_id", id),
      admin.from("user_organizations").select("user_id").eq("organization_id", id),
    ]);

  const destruido = {
    users: usersRes.count ?? 0,
    conversations: conversationsRes.count ?? 0,
    messages: messagesRes.count ?? 0,
    contacts: contactsRes.count ?? 0,
    leads: leadsRes.count ?? 0,
  };

  // `await`, e não fire-and-forget: sem rastro, não se apaga.
  await audit({
    action: "tenant.deleted",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "organization",
    resourceId: id,
    requestId,
    metadata: {
      // Duplicados de propósito: o FK vira NULL quando a organização some.
      tenant_id: id,
      tenant_slug: org.slug,
      tenant_display_name: org.display_name,
      suspended_before_delete: true,
      destruido,
    },
  });

  const { error: deleteError } = await admin.from("organizations").delete().eq("id", id);

  if (deleteError) {
    return fail("internal_error", "Failed to delete tenant", 500, { requestId });
  }

  // A FK da membership é cascade, mas Auth é um schema separado: removemos a
  // identidade apenas se ela não sobrou em outra organização. O ator da
  // exclusão é protegido explicitamente, além da cerca para platform_admins.
  const candidatos = [...new Set((memberIdsRes.data ?? []).map((row) => row.user_id))];
  const limpeza = await Promise.all(
    candidatos.map((userId) =>
      removerContaSemAcesso(admin, userId, new Set([adminCtx.user.id])),
    ),
  );
  const contasRemovidas = limpeza.filter((resultado) => resultado === "removida").length;

  return ok(
    { id, deleted: true, destruido, auth_accounts_removed: contasRemovidas },
    { requestId },
  );
}
