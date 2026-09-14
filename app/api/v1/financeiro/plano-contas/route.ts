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
const fields = z.object({ code: z.string().regex(/^\d+(\.\d+)*$/).max(30), name: z.string().trim().min(2).max(100),
  direction: z.enum(["receivable", "payable"]) }).strict();
const update = z.object({ id: z.uuid(), name: z.string().trim().min(2).max(100).optional(),
  active: z.boolean().optional() }).strict().refine(value => value.name !== undefined || value.active !== undefined);

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_chart_accounts", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { data, error } = await db().from("finance_chart_accounts").select("id,code,name,direction,active")
    .eq("organization_id", auth.org.orgId).order("code").limit(1000);
  if (error) return fail("internal_error", "Falha ao consultar plano de contas.", 500, { requestId });
  return ok({ accounts: data }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_chart_accounts", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = fields.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Conta gerencial inválida.", 422, { requestId });
  const { data, error } = await db().from("finance_chart_accounts").insert({ ...parsed.data,
    organization_id: auth.org.orgId }).select("id,code,name,direction,active").single();
  if (error?.code === "23505") return fail("conflict", "Código já cadastrado.", 409, { requestId });
  if (error || !data) return fail("internal_error", "Falha ao criar conta gerencial.", 500, { requestId });
  await audit({ action: "finance.chart_account_created", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_chart_accounts", resourceId: data.id, requestId });
  return ok({ account: data }, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_chart_accounts", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = update.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Alteração gerencial inválida.", 422, { requestId });
  const { id, ...changes } = parsed.data;
  const { data, error } = await db().from("finance_chart_accounts").update(changes)
    .eq("organization_id", auth.org.orgId).eq("id", id).select("id,code,name,direction,active").maybeSingle();
  if (error) return fail("internal_error", "Falha ao alterar conta gerencial.", 500, { requestId });
  if (!data) return fail("not_found", "Conta gerencial não encontrada.", 404, { requestId });
  await audit({ action: "finance.chart_account_updated", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_chart_accounts", resourceId: id, requestId });
  return ok({ account: data }, { requestId });
}
