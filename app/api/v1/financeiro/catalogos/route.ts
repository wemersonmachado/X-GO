import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { atualizarCatalogoSchema, criarCatalogoSchema } from "@/lib/financeiro/expansao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TABLES = { category: "finance_categories", cost_center: "finance_cost_centers", account: "finance_accounts" } as const;
const db = () => createAdminClient() as unknown as SupabaseClient;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_catalogs", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const orgId = auth.org.orgId;
  const [categories, costCenters, accounts] = await Promise.all([
    db().from(TABLES.category).select("id,name,direction,active").eq("organization_id", orgId).order("name"),
    db().from(TABLES.cost_center).select("id,name,active").eq("organization_id", orgId).order("name"),
    db().from(TABLES.account).select("id,name,kind,currency,active").eq("organization_id", orgId).order("name"),
  ]);
  if (categories.error || costCenters.error || accounts.error) return fail("internal_error", "Falha ao consultar cadastros financeiros.", 500, { requestId });
  return ok({ categories: categories.data, cost_centers: costCenters.data, accounts: accounts.data }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_catalogs", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = criarCatalogoSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Cadastro financeiro inválido.", 422, { requestId });
  const { type, ...fields } = parsed.data;
  const { data, error } = await db().from(TABLES[type]).insert({ organization_id: auth.org.orgId, ...fields }).select().single();
  if (error?.code === "23505") return fail("conflict", "Já existe um cadastro com esse nome.", 409, { requestId });
  if (error || !data) return fail("internal_error", "Falha ao criar cadastro financeiro.", 500, { requestId });
  await audit({ action: "finance.catalog_created", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: TABLES[type], resourceId: data.id, requestId, metadata: { type } });
  return ok({ item: data }, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_catalogs", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = atualizarCatalogoSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Alteração financeira inválida.", 422, { requestId });
  const { type, id, ...fields } = parsed.data;
  const { data, error } = await db().from(TABLES[type]).update(fields).eq("organization_id", auth.org.orgId).eq("id", id).select().maybeSingle();
  if (error?.code === "23505") return fail("conflict", "Já existe um cadastro com esse nome.", 409, { requestId });
  if (error) return fail("internal_error", "Falha ao alterar cadastro financeiro.", 500, { requestId });
  if (!data) return fail("not_found", "Cadastro não encontrado.", 404, { requestId });
  await audit({ action: "finance.catalog_updated", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: TABLES[type], resourceId: id, requestId, metadata: { type, fields: Object.keys(fields) } });
  return ok({ item: data }, { requestId });
}
