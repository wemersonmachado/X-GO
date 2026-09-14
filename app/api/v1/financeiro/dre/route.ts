import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { calcularDre, type ContaDre, type EntradaDre } from "@/lib/financeiro/dre";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const db = () => createAdminClient() as unknown as SupabaseClient;
const querySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "finance_entries", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail("validation_failed", "Informe mês no formato AAAA-MM.", 422, { requestId });
  const from = `${parsed.data.month}-01`;
  const [year, month] = parsed.data.month.split("-").map(Number);
  const toExclusive = new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 10);
  const chart = await db().from("finance_chart_accounts").select("id,code,name,direction")
    .eq("organization_id", auth.org.orgId).limit(1000);
  if (chart.error) return fail("internal_error", "Falha ao consultar plano de contas.", 500, { requestId });
  const entries: EntradaDre[] = [];
  let offset = 0;
  while (true) {
    const page = await db().from("finance_entries")
      .select("direction,status,amount_cents,chart_account_id,competence_date", { count: "exact" })
      .eq("organization_id", auth.org.orgId).neq("status", "cancelled")
      .gte("competence_date", from).lt("competence_date", toExclusive)
      .order("id").range(offset, offset + 499);
    if (page.error || page.count === null) return fail("internal_error", "Falha ao calcular DRE.", 500, { requestId });
    entries.push(...((page.data ?? []) as EntradaDre[]));
    offset += page.data?.length ?? 0;
    if (offset >= page.count) break;
    if (!page.data?.length) return fail("internal_error", "Paginação incompleta da DRE.", 500, { requestId });
  }
  const report = calcularDre(entries, (chart.data ?? []) as ContaDre[], from, toExclusive);
  const missing = await db().from("finance_entries").select("id", { count: "exact", head: true })
    .eq("organization_id", auth.org.orgId).neq("status", "cancelled").is("competence_date", null);
  if (missing.error) return fail("internal_error", "Falha ao contar lançamentos sem competência.", 500, { requestId });
  return ok({ month: parsed.data.month, basis: "competence_including_open", ...report,
    unclassified_count: missing.count ?? 0, accounting_statement: false }, { requestId });
}
