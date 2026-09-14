import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { decidirPropostaSchema } from "@/lib/financeiro/expansao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const db = () => createAdminClient() as unknown as SupabaseClient;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_proposals", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const columns = "id,agent_id,operation,status,description,amount_cents,currency,direction,due_date,evidence_note,revision,resulting_entry_id,created_at,approved_at";
  const pending: unknown[] = [];
  let offset = 0;
  while (true) {
    const page = await db().from("finance_proposals").select(columns, { count: "exact" })
      .eq("organization_id", auth.org.orgId).eq("status", "pending")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 499);
    if (page.error || page.count === null || (!page.data?.length && offset < page.count))
      return fail("internal_error", "Falha ao consultar propostas financeiras.", 500, { requestId });
    pending.push(...(page.data ?? [])); offset += page.data?.length ?? 0;
    if (offset >= page.count) break;
  }
  const recent = await db().from("finance_proposals").select(columns)
    .eq("organization_id", auth.org.orgId).neq("status", "pending")
    .order("created_at", { ascending: false }).limit(100);
  if (recent.error) return fail("internal_error", "Falha ao consultar propostas financeiras.", 500, { requestId });
  return ok({ proposals: [...pending, ...(recent.data ?? [])], pending_count: pending.length }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_proposals", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = decidirPropostaSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Decisão financeira inválida.", 422, { requestId });
  const { data, error } = await db().rpc("fn_finance_decide_proposal", {
    p_org: auth.org.orgId, p_id: parsed.data.id, p_action: parsed.data.action,
    p_revision: parsed.data.revision, p_actor: auth.user.id,
  });
  if (error?.code === "P0002") return fail("not_found", "Proposta não encontrada.", 404, { requestId });
  if (error?.code === "40001") return fail("conflict", "A proposta mudou. Atualize a tela.", 409, { requestId });
  if (error?.code === "42501") return fail("forbidden", "A delegação do agente foi revogada ou o limite mudou.", 403, { requestId });
  if (error || !data) return fail("internal_error", "Falha ao decidir proposta financeira.", 500, { requestId });
  await audit({ action: parsed.data.action === "approve" ? "finance.proposal_approved" : "finance.proposal_rejected",
    actorUserId: auth.user.id, organizationId: auth.org.orgId, resourceType: "finance_proposals",
    resourceId: parsed.data.id, requestId, metadata: { operation: data.operation, revision: data.revision } });
  return ok({ proposal: data }, { requestId });
}
