import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { decodificarCsv } from "@/lib/contacts/csv";
import { hashExtrato, parseFinanceCsv, parseFinanceOfx } from "@/lib/financeiro/importacao";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const db = () => createAdminClient() as unknown as SupabaseClient;
const MAX_BYTES = 2 * 1024 * 1024;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_import_batches", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const batchId = req.nextUrl.searchParams.get("batch_id");
  if (batchId && !z.uuid().safeParse(batchId).success) return fail("validation_failed", "ID de extrato inválido.", 422, { requestId });
  const batches = await db().from("finance_import_batches")
    .select("id,account_id,file_name,format,created_at").eq("organization_id", auth.org.orgId)
    .order("created_at", { ascending: false }).limit(50);
  if (batches.error) return fail("internal_error", "Falha ao consultar extratos.", 500, { requestId });
  if (!batchId) return ok({ batches: batches.data }, { requestId });
  if (!batches.data?.some(item => item.id === batchId)) {
    const single = await db().from("finance_import_batches").select("id")
      .eq("organization_id", auth.org.orgId).eq("id", batchId).maybeSingle();
    if (single.error) return fail("internal_error", "Falha ao consultar extrato.", 500, { requestId });
    if (!single.data) return fail("not_found", "Extrato não encontrado.", 404, { requestId });
  }
  const movements = await db().from("finance_import_movements")
    .select("id,external_id,occurred_on,description,amount_cents,direction,status,matched_entry_id,revision")
    .eq("organization_id", auth.org.orgId).eq("batch_id", batchId).order("occurred_on").limit(500);
  if (movements.error) return fail("internal_error", "Falha ao consultar movimentações.", 500, { requestId });
  return ok({ batches: batches.data, movements: movements.data }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_import_batches", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file"); const accountId = form?.get("account_id");
  if (!(file instanceof File) || typeof accountId !== "string" || !z.uuid().safeParse(accountId).success)
    return fail("validation_failed", "Informe arquivo e conta financeira.", 422, { requestId });
  const format = file.name.toLowerCase().endsWith(".ofx") ? "ofx" : file.name.toLowerCase().endsWith(".csv") ? "csv" : null;
  if (!format || file.size < 1 || file.size > MAX_BYTES || file.name.length > 200)
    return fail("validation_failed", "Envie CSV ou OFX de até 2 MB.", 422, { requestId });
  const account = await db().from("finance_accounts").select("id,active,currency")
    .eq("organization_id", auth.org.orgId).eq("id", accountId).maybeSingle();
  if (account.error) return fail("internal_error", "Falha ao validar conta.", 500, { requestId });
  if (!account.data?.active || account.data.currency !== "BRL")
    return fail("validation_failed", "Conta financeira inativa ou moeda não suportada.", 422, { requestId });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = decodificarCsv(bytes);
  if ("erro" in decoded) return fail("validation_failed", decoded.erro, 422, { requestId });
  let movements;
  try { movements = format === "csv" ? parseFinanceCsv(decoded.texto) : parseFinanceOfx(decoded.texto); }
  catch (error) { return fail("validation_failed", error instanceof Error ? error.message : "Extrato inválido.", 422, { requestId }); }
  const hash = hashExtrato(bytes);
  const imported = await db().rpc("fn_finance_import_statement", { p_org: auth.org.orgId,
    p_account: accountId, p_hash: hash, p_file_name: file.name, p_format: format,
    p_actor: auth.user.id, p_movements: movements });
  const result = Array.isArray(imported.data) ? imported.data[0] : imported.data;
  if (imported.error?.code === "23505") return fail("conflict", "O mesmo ID bancário apareceu com dados diferentes.", 409, { requestId });
  if (imported.error || !result?.batch_id) return fail("internal_error", "Falha ao importar extrato.", 500, { requestId });
  if (result.duplicate) return ok({ batch_id: result.batch_id, duplicate: true, count: 0 }, { requestId });
  await audit({ action: "finance.import_created", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_import_batches", resourceId: result.batch_id, requestId,
    metadata: { format, count: Number(result.imported_count) } });
  return ok({ batch_id: result.batch_id, duplicate: false, count: Number(result.imported_count) }, { requestId, status: 201 });
}
