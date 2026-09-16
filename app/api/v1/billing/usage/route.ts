import { fail, ok } from "@/lib/api/wrappers";
import { getEntitlementUsage } from "@/lib/billing/entitlements";
import { requireRole } from "@/lib/auth/require-role";

export async function GET() {
  const auth = await requireRole("admin", { resource: "organizations" });
  if (!auth.ok) return fail("forbidden", "Você precisa administrar esta organização.", 403);
  const usage = await getEntitlementUsage(auth.org.orgId);
  if (!usage) return fail("upstream_unavailable", "Não foi possível consultar o plano agora.", 503);
  return ok(usage);
}
