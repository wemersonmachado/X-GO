import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/ai/credentials/:id (admin)
 *
 * Bloqueia se a credential é referenciada por uma `ai_agent_versions` que é a
 * `published_version_id` de algum agent não-arquivado da org.
 * Caso contrário, desvincula drafts/histórico e deleta. A versão preserva
 * provider/model/prompt; somente o segredo que a executaria deixa de existir.
 * A FK ON DELETE RESTRICT continua sendo a última linha de defesa contra corrida.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { contarUsoPublicado, type VersaoVinculada } from "@/lib/ai/credenciais/uso";
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

  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  const { data: cred, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select("id, organization_id, provider, label, api_key_last4")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", "Erro ao consultar credential.", 500, { requestId });
  }
  if (!cred || cred.organization_id !== activeOrg.orgId) {
    return fail("not_found", t("Credential não encontrada."), 404, { requestId });
  }

  // Está referenciada por alguma versão que é published_version_id de agent ativo?
  const { data: linked, error: linkErr } = await admin
    .from("ai_agent_versions")
    .select(
      "id, credential_id, ai_agents!ai_agent_versions_agent_id_fkey!inner(archived_at, published_version_id)",
    )
    .eq("credential_id", id)
    .eq("organization_id", activeOrg.orgId);

  if (linkErr) {
    return fail("internal_error", "Erro ao verificar uso da credential.", 500, { requestId });
  }

  const inUse = (contarUsoPublicado((linked ?? []) as unknown as VersaoVinculada[])[id] ?? 0) > 0;

  if (inUse) {
    return fail(
      "credential_in_use",
      t("Credential é usada por uma versão publicada de agent. Despublique antes de deletar."),
      409,
      { requestId },
    );
  }

  // A FK é RESTRICT de propósito: uma credencial não pode sumir enquanto uma
  // versão publicada e viva a utiliza. Depois da guarda acima, porém, as únicas
  // referências restantes são drafts, versões substituídas ou agentes
  // arquivados. Manter o id nelas tornava o botão "Excluir" impossível mesmo
  // quando a tela mostrava "Em uso por 0". O histórico funcional permanece;
  // apenas a referência ao segredo removido é limpa.
  const linkedIds = (linked ?? []).map((row) => row.id);
  if (linkedIds.length > 0) {
    const { error: unlinkErr } = await admin
      .from("ai_agent_versions")
      .update({ credential_id: null })
      .eq("organization_id", activeOrg.orgId)
      .eq("credential_id", id)
      .in("id", linkedIds);
    if (unlinkErr) {
      return fail("internal_error", "Erro ao desvincular credential.", 500, { requestId });
    }
  }

  const { error: delErr } = await admin
    .from("ai_provider_credentials")
    .delete()
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (delErr) {
    if (delErr.code === "23503") {
      return fail(
        "credential_in_use",
        t("A credencial passou a ser usada por uma versão publicada. Atualize e tente novamente."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao deletar credential.", 500, { requestId });
  }

  await audit({
    action: "ai.credential_deleted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: id,
    requestId,
    metadata: { provider: cred.provider, label: cred.label, last4: cred.api_key_last4 },
  });

  return ok({ id, deleted: true }, { requestId });
}
