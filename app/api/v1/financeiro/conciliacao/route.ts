import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const db = () => createAdminClient() as unknown as SupabaseClient;
const schema = z.object({ movement_id: z.uuid(), action: z.enum(["match", "ignore"]),
  entry_id: z.uuid().nullable(), revision: z.number().int().positive(), confirmation: z.literal(true) }).strict();

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_import_movements", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || (parsed.data.action === "match") !== (parsed.data.entry_id !== null))
    return fail("validation_failed", "Decisão de conciliação inválida.", 422, { requestId });
  const { data, error } = await db().rpc("fn_finance_reconcile_movement", {
    p_org: auth.org.orgId, p_movement: parsed.data.movement_id, p_entry: parsed.data.entry_id,
    p_action: parsed.data.action, p_revision: parsed.data.revision, p_actor: auth.user.id,
  });
  if (error?.code === "P0002") return fail("not_found", "Movimento não encontrado.", 404, { requestId });
  if (error?.code === "40001" || error?.code === "23505")
    return fail("conflict", "Movimento ou lançamento já conciliado. Atualize a tela.", 409, { requestId });
  if (error?.code === "22023") return fail("validation_failed", "Lançamento incompatível: confira valor, tipo e estado.", 422, { requestId });
  if (error || !data) return fail("internal_error", "Falha ao conciliar movimentação.", 500, { requestId });
  await audit({ action: "finance.transaction_reconciled", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_import_movements", resourceId: parsed.data.movement_id, requestId,
    metadata: { action: parsed.data.action, entry_id: parsed.data.entry_id } });
  return ok({ movement: data }, { requestId });
}
