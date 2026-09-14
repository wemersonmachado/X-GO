import { createHash } from "node:crypto";
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
const schema = z.object({ entry_id: z.uuid(), municipality_code: z.string().regex(/^\d{7}$/),
  document_kind: z.enum(["nfse", "nfe"]), confirmation: z.literal(true) }).strict();

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_fiscal_requests", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { data, error } = await db().from("finance_fiscal_requests")
    .select("id,entry_id,country,municipality_code,document_kind,status,provider_key,provider_receipt,created_at")
    .eq("organization_id", auth.org.orgId).order("created_at", { ascending: false }).limit(100);
  if (error) return fail("internal_error", "Falha ao consultar solicitações fiscais.", 500, { requestId });
  return ok({ requests: data, provider_configured: false }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_fiscal_requests", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key || key.length < 8 || key.length > 120 || !/^[A-Za-z0-9_-]+$/.test(key))
    return fail("validation_failed", "Informe Idempotency-Key no cabeçalho.", 422, { requestId });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Solicitação fiscal inválida.", 422, { requestId });
  const entry = await db().from("finance_entries").select("id,direction,status")
    .eq("organization_id", auth.org.orgId).eq("id", parsed.data.entry_id).maybeSingle();
  if (entry.error) return fail("internal_error", "Falha ao validar lançamento.", 500, { requestId });
  if (!entry.data) return fail("not_found", "Lançamento não encontrado.", 404, { requestId });
  if (entry.data.direction !== "receivable" || entry.data.status === "cancelled")
    return fail("validation_failed", "Somente receita não cancelada pode entrar na fila fiscal.", 422, { requestId });
  const fingerprint = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
  const existing = await db().from("finance_fiscal_requests")
    .select("id,request_fingerprint,status").eq("organization_id", auth.org.orgId).eq("idempotency_key", key).maybeSingle();
  if (existing.error) return fail("internal_error", "Falha ao verificar solicitação.", 500, { requestId });
  if (existing.data) return existing.data.request_fingerprint === fingerprint
    ? ok({ request: { id: existing.data.id, status: existing.data.status }, duplicate: true }, { requestId })
    : fail("conflict", "A chave já foi usada para outra solicitação.", 409, { requestId });
  const { data, error } = await db().from("finance_fiscal_requests").insert({
    organization_id: auth.org.orgId, entry_id: parsed.data.entry_id, country: "BR",
    municipality_code: parsed.data.municipality_code, document_kind: parsed.data.document_kind,
    status: "awaiting_provider", idempotency_key: key, request_fingerprint: fingerprint,
    approved_by_user_id: auth.user.id, approved_at: new Date().toISOString(),
  }).select("id,status,created_at").single();
  if (error?.code === "23505") {
    const concurrent = await db().from("finance_fiscal_requests").select("id,status,request_fingerprint")
      .eq("organization_id", auth.org.orgId).eq("idempotency_key", key).maybeSingle();
    if (concurrent.data?.request_fingerprint === fingerprint)
      return ok({ request: { id: concurrent.data.id, status: concurrent.data.status }, duplicate: true }, { requestId });
    return fail("conflict", "A chave já foi usada para outra solicitação.", 409, { requestId });
  }
  if (error || !data) return fail("internal_error", "Falha ao registrar solicitação fiscal.", 500, { requestId });
  await audit({ action: "finance.fiscal_requested", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_fiscal_requests", resourceId: data.id, requestId,
    metadata: { document_kind: parsed.data.document_kind, municipality_code: parsed.data.municipality_code } });
  return ok({ request: data, duplicate: false, provider_configured: false }, { requestId, status: 201 });
}
