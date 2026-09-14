import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { alterarSituacaoSchema, criarLancamentoSchema, filtrosFinanceirosSchema } from "@/lib/financeiro/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS = "id,direction,status,description,amount_cents,currency,due_date,notes,source,settled_amount_cents,settled_at,revision,created_at,category_id,cost_center_id,account_id,chart_account_id,competence_date";
const db = () => createAdminClient() as unknown as SupabaseClient;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_entries", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = filtrosFinanceirosSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail("validation_failed", "Filtro financeiro inválido.", 422, { requestId });

  // O resumo da tela usa o conjunto inteiro. Buscar só a primeira página
  // mostraria um saldo incorreto sem avisar quando a organização passar de 500 contas.
  const entries: unknown[] = [];
  let offset = 0;
  while (true) {
    let query = db().from("finance_entries").select(COLUNAS, { count: "exact" })
      .eq("organization_id", auth.org.orgId)
      .order("due_date", { ascending: true }).order("id", { ascending: true });
    if (parsed.data.direction) query = query.eq("direction", parsed.data.direction);
    if (parsed.data.status) query = query.eq("status", parsed.data.status);
    const { data, error, count } = await query.range(offset, offset + 499);
    if (error || count === null || (!data?.length && offset < count)) {
      return fail("internal_error", "Falha ao consultar lançamentos.", 500, { requestId });
    }
    entries.push(...(data ?? []));
    offset += data?.length ?? 0;
    if (offset >= count) break;
  }
  return ok({ entries }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_entries", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = criarLancamentoSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", parsed.error.issues[0]?.message ?? "Lançamento inválido.", 422, { requestId });

  // IDs opcionais também pertencem à organização ativa; categoria segue a direção.
  for (const [table, id] of [
    ["finance_categories", parsed.data.category_id],
    ["finance_cost_centers", parsed.data.cost_center_id],
    ["finance_accounts", parsed.data.account_id],
    ["finance_chart_accounts", parsed.data.chart_account_id],
  ] as const) {
    if (!id) continue;
    const result = await db().from(table).select("*")
      .eq("organization_id", auth.org.orgId).eq("id", id).maybeSingle();
    if (result.error) return fail("internal_error", "Falha ao validar cadastro financeiro.", 500, { requestId });
    if (!result.data?.active || ((table === "finance_categories" || table === "finance_chart_accounts") && result.data.direction !== parsed.data.direction)) {
      return fail("validation_failed", "Cadastro financeiro inválido ou inativo.", 422, { requestId });
    }
  }

  const { data, error } = await db().from("finance_entries").insert({
    ...parsed.data, notes: parsed.data.notes || null, source: "manual", status: "open",
    organization_id: auth.org.orgId, created_by_user_id: auth.user.id,
  }).select(COLUNAS).single();
  if (error) return fail("internal_error", "Falha ao criar lançamento.", 500, { requestId });
  await audit({ action: "finance.entry_created", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_entries", resourceId: data.id, requestId,
    metadata: { direction: data.direction, amount_cents: data.amount_cents, currency: data.currency, due_date: data.due_date } });
  return ok({ entry: data }, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_entries", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = alterarSituacaoSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", parsed.error.issues[0]?.message ?? "Confirmação inválida.", 422, { requestId });

  const atual = await db().from("finance_entries").select("id,status,amount_cents,revision")
    .eq("id", parsed.data.id).eq("organization_id", auth.org.orgId).maybeSingle();
  if (atual.error) return fail("internal_error", "Falha ao consultar lançamento.", 500, { requestId });
  if (!atual.data) return fail("not_found", "Lançamento não encontrado.", 404, { requestId });
  if (Number(atual.data.revision) !== parsed.data.revision) return fail("conflict", "O lançamento mudou. Atualize a tela antes de confirmar.", 409, { requestId });

  const action = parsed.data.action;
  if (action === "settle" && atual.data.status !== "open") return fail("conflict", "Somente lançamento em aberto pode ser baixado.", 409, { requestId });
  if (action === "cancel" && atual.data.status !== "open") return fail("conflict", "Somente lançamento em aberto pode ser cancelado.", 409, { requestId });
  if (action === "reopen" && atual.data.status !== "cancelled") return fail("conflict", "Somente lançamento cancelado pode ser reaberto.", 409, { requestId });

  const { data, error } = await db().rpc("fn_finance_transition_entry", {
    p_org: auth.org.orgId, p_id: parsed.data.id, p_action: action,
    p_revision: parsed.data.revision, p_actor: auth.user.id,
    p_settled_amount: parsed.data.settled_amount_cents ?? null,
  });
  if (error?.code === "23514") return fail("conflict", "Lançamento conciliado exige o mesmo valor e não pode ser cancelado.", 409, { requestId });
  if (error?.code === "40001") return fail("conflict", "O lançamento mudou. Atualize a tela antes de confirmar.", 409, { requestId });
  if (error) return fail("internal_error", "Falha ao alterar lançamento.", 500, { requestId });
  if (!data) return fail("conflict", "O lançamento mudou. Atualize a tela antes de confirmar.", 409, { requestId });
  const auditAction = action === "settle" ? "finance.entry_settled" : action === "cancel" ? "finance.entry_cancelled" : "finance.entry_reopened";
  await audit({ action: auditAction, actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_entries", resourceId: data.id, requestId,
    metadata: { previous_status: atual.data.status, status: data.status, revision: data.revision } });
  return ok({ entry: data }, { requestId });
}
