import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const BUCKET = "finance-documents";
const MAX_SIZE = 10 * 1024 * 1024;
const idSchema = z.uuid();
const db = () => createAdminClient() as unknown as SupabaseClient;

function detectedMime(bytes: Uint8Array): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  return null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_documents", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const id = req.nextUrl.searchParams.get("id");
  if (id && !idSchema.safeParse(id).success) return fail("validation_failed", "ID inválido.", 422, { requestId });
  const query = db().from("finance_documents").select("id,entry_id,proposal_id,file_name,mime_type,size_bytes,sha256,created_at")
    .eq("organization_id", auth.org.orgId).order("created_at", { ascending: false });
  if (!id) {
    const owner = req.nextUrl.searchParams.get("entry_id") ?? req.nextUrl.searchParams.get("proposal_id");
    if (!owner || !idSchema.safeParse(owner).success) return fail("validation_failed", "Informe um lançamento ou proposta.", 422, { requestId });
    const field = req.nextUrl.searchParams.has("entry_id") ? "entry_id" : "proposal_id";
    const { data, error } = await query.eq(field, owner).limit(100);
    if (error) return fail("internal_error", "Falha ao listar anexos.", 500, { requestId });
    return ok({ documents: data }, { requestId });
  }
  const { data: document, error } = await db().from("finance_documents").select("id,storage_path")
    .eq("organization_id", auth.org.orgId).eq("id", id).maybeSingle();
  if (error) return fail("internal_error", "Falha ao consultar anexo.", 500, { requestId });
  if (!document) return fail("not_found", "Anexo não encontrado.", 404, { requestId });
  const signed = await createAdminClient().storage.from(BUCKET).createSignedUrl(document.storage_path, 60);
  if (signed.error || !signed.data?.signedUrl) return fail("internal_error", "Falha ao abrir anexo.", 500, { requestId });
  return ok({ url: signed.data.signedUrl, expires_in_seconds: 60 }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_documents", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const form = await req.formData().catch(() => null);
  if (!form) return fail("invalid_request", "Envio inválido.", 400, { requestId });
  const file = form.get("file");
  const entryId = form.get("entry_id"); const proposalId = form.get("proposal_id");
  if (!(file instanceof File) || (entryId === null) === (proposalId === null))
    return fail("validation_failed", "Envie um arquivo para um lançamento ou uma proposta.", 422, { requestId });
  const ownerType = entryId !== null ? "entry_id" : "proposal_id";
  const ownerId = entryId !== null ? entryId : proposalId;
  if (typeof ownerId !== "string" || !idSchema.safeParse(ownerId).success || file.size < 1 || file.size > MAX_SIZE || file.name.length > 200)
    return fail("validation_failed", "Arquivo ou vínculo inválido (limite de 10 MB).", 422, { requestId });
  const ownerTable = ownerType === "entry_id" ? "finance_entries" : "finance_proposals";
  const owner = await db().from(ownerTable).select("id").eq("organization_id", auth.org.orgId).eq("id", ownerId).maybeSingle();
  if (owner.error) return fail("internal_error", "Falha ao validar vínculo.", 500, { requestId });
  if (!owner.data) return fail("not_found", "Vínculo não encontrado.", 404, { requestId });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectedMime(bytes);
  if (!mime || (file.type && file.type !== mime)) return fail("unsupported_media_type", "Envie PDF, PNG ou JPEG válido.", 415, { requestId });
  const path = `${auth.org.orgId}/${randomUUID()}`;
  const storage = createAdminClient().storage.from(BUCKET);
  const uploaded = await storage.upload(path, bytes, { contentType: mime, upsert: false });
  if (uploaded.error) return fail("internal_error", "Falha ao guardar anexo.", 500, { requestId });
  const { data, error } = await db().from("finance_documents").insert({ organization_id: auth.org.orgId,
    [ownerType]: ownerId, storage_path: path, file_name: file.name, mime_type: mime, size_bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), created_by_user_id: auth.user.id,
  }).select("id,file_name,mime_type,size_bytes,created_at").single();
  if (error || !data) { await storage.remove([path]); return fail("internal_error", "Falha ao registrar anexo.", 500, { requestId }); }
  await audit({ action: "finance.document_uploaded", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_documents", resourceId: data.id, requestId, metadata: { owner_type: ownerType, owner_id: ownerId } });
  return ok({ document: data }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("admin", { requestId, resource: "finance_documents", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = z.object({ id: z.uuid(), confirmation: z.literal(true) }).strict().safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", "Confirme a exclusão do anexo.", 422, { requestId });
  const { data: document, error } = await db().from("finance_documents").select("id,storage_path")
    .eq("organization_id", auth.org.orgId).eq("id", parsed.data.id).maybeSingle();
  if (error) return fail("internal_error", "Falha ao consultar anexo.", 500, { requestId });
  if (!document) return fail("not_found", "Anexo não encontrado.", 404, { requestId });
  const removed = await createAdminClient().storage.from(BUCKET).remove([document.storage_path]);
  if (removed.error) return fail("internal_error", "Falha ao remover arquivo.", 500, { requestId });
  const deleted = await db().from("finance_documents").delete().eq("organization_id", auth.org.orgId).eq("id", parsed.data.id);
  if (deleted.error) return fail("internal_error", "Falha ao remover registro do anexo.", 500, { requestId });
  await audit({ action: "finance.document_removed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "finance_documents", resourceId: parsed.data.id, requestId });
  return ok({ deleted: true }, { requestId });
}
