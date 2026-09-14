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
const schema = z.object({ id: z.uuid(), revision: z.number().int().positive(),
  chart_account_id: z.uuid().nullable(), competence_date: z.iso.date().nullable(),
  account_id: z.uuid().nullable() }).strict();

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_entries", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Classificação financeira inválida.", 422, { requestId });
  const { data, error } = await db().rpc("fn_finance_classify_entry", {
    p_org: auth.org.orgId, p_id: parsed.data.id, p_revision: parsed.data.revision,
    p_actor: auth.user.id, p_chart_account: parsed.data.chart_account_id,
    p_competence_date: parsed.data.competence_date, p_account: parsed.data.account_id,
  });
  if (error?.code === "P0002") return fail("not_found", "Lançamento não encontrado.", 404, { requestId });
  if (error?.code === "40001") return fail("conflict", "Lançamento alterado. Atualize a tela.", 409, { requestId });
  if (error?.code === "23514") return fail("conflict", "Lançamento cancelado ou conciliado não permite trocar a conta financeira.", 409, { requestId });
  if (error?.code === "23503") return fail("validation_failed", "Conta financeira ou gerencial incompatível ou inativa.", 422, { requestId });
  if (error || !data) return fail("internal_error", "Falha ao classificar lançamento.", 500, { requestId });
  await audit({ action: "finance.entry_classified", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_entries", resourceId: data.id, requestId,
    metadata: { chart_account_id: data.chart_account_id, competence_date: data.competence_date,
      account_id: data.account_id } });
  return ok({ entry: data }, { requestId });
}
