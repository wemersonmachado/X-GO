import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { permissaoAgenteSchema } from "@/lib/financeiro/expansao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const db = () => createAdminClient() as unknown as SupabaseClient;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_agent_permissions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { data, error } = await db().from("finance_agent_permissions")
    .select("id,agent_id,operation,mode,max_amount_cents")
    .eq("organization_id", auth.org.orgId).order("agent_id").order("operation");
  if (error) return fail("internal_error", "Falha ao consultar permissões financeiras.", 500, { requestId });
  return ok({ permissions: data }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_agent_permissions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = permissaoAgenteSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Permissão financeira inválida.", 422, { requestId });
  const input = parsed.data, orgId = auth.org.orgId;
  const agent = await db().from("ai_agents").select("id,archived_at")
    .eq("organization_id", orgId).eq("id", input.agent_id).maybeSingle();
  if (agent.error) return fail("internal_error", "Falha ao consultar agente.", 500, { requestId });
  if (!agent.data || agent.data.archived_at) return fail("not_found", "Agente não encontrado.", 404, { requestId });
  if (input.mode === null) {
    const { error } = await db().from("finance_agent_permissions").delete()
      .eq("organization_id", orgId).eq("agent_id", input.agent_id).eq("operation", input.operation);
    if (error) return fail("internal_error", "Falha ao desabilitar delegação.", 500, { requestId });
  } else {
    const { error } = await db().from("finance_agent_permissions").upsert({
      organization_id: orgId, agent_id: input.agent_id, operation: input.operation,
      mode: input.mode, max_amount_cents: input.max_amount_cents ?? null,
    }, { onConflict: "organization_id,agent_id,operation" });
    if (error) return fail("internal_error", "Falha ao salvar delegação.", 500, { requestId });
  }
  await audit({ action: "finance.agent_permission_changed", actorUserId: auth.user.id,
    organizationId: orgId, resourceType: "finance_agent_permissions", requestId,
    metadata: { agent_id: input.agent_id, operation: input.operation, mode: input.mode } });
  return ok({ agent_id: input.agent_id, operation: input.operation, mode: input.mode }, { requestId });
}
