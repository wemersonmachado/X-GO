import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/settings/api-tokens/[id] — apaga definitivamente um token já revogado.
 *
 * A revogação continua sendo uma etapa obrigatória e auditada. Isso evita que
 * um clique de exclusão transforme um bearer ainda válido em incidente sem a
 * separação explícita entre "parar acesso" e "limpar o cadastro".
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("admin", { requestId, resource: "api_tokens" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: token, error: fetchErr } = await supabase
    .from("api_tokens")
    .select("id, name, prefix, revoked_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", "Erro ao consultar token.", 500, { requestId });
  if (!token) return fail("not_found", t("Token não encontrado."), 404, { requestId });
  if (!token.revoked_at) {
    return fail(
      "token_active",
      t("Revogue o token antes de excluí-lo definitivamente."),
      409,
      { requestId },
    );
  }

  const { error: deleteErr } = await supabase
    .from("api_tokens")
    .delete()
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (deleteErr) return fail("internal_error", "Erro ao excluir token.", 500, { requestId });

  await audit({
    action: "token.deleted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "api_token",
    resourceId: id,
    requestId,
    metadata: { name: token.name, prefix: token.prefix, permanent: true },
  });

  return ok({ id, deleted: true }, { requestId });
}
