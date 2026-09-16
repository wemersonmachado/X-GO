import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type BillingResource = "users" | "whatsapp" | "active_agents" | "monthly_conversations";

export interface Entitlements {
  plan_slug: "standard" | "pro" | "enterprise";
  limits: Record<BillingResource, number> & { mcp: boolean };
}

export interface EntitlementUsage extends Entitlements {
  usage: Record<BillingResource, number>;
}

function numberAt(value: unknown, key: BillingResource): number {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : 0;
  const number = Number(raw ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export async function getEntitlementUsage(orgId: string): Promise<EntitlementUsage | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_plan_entitlements" as never, { p_org: orgId } as never);
  if (error || !data || typeof data !== "object") return null;
  const raw = data as { plan_slug?: unknown; limits?: unknown };
  const plan = raw.plan_slug;
  if (plan !== "standard" && plan !== "pro" && plan !== "enterprise") return null;
  const limits = {
    users: numberAt(raw.limits, "users"),
    whatsapp: numberAt(raw.limits, "whatsapp"),
    active_agents: numberAt(raw.limits, "active_agents"),
    monthly_conversations: numberAt(raw.limits, "monthly_conversations"),
    mcp: Boolean(raw.limits && typeof raw.limits === "object" && (raw.limits as Record<string, unknown>).mcp),
  };
  const usageResult = await admin.rpc("fn_plan_usage" as never, { p_org: orgId } as never);
  if (usageResult.error || !usageResult.data || typeof usageResult.data !== "object") return null;
  const usageData = usageResult.data;
  return { plan_slug: plan, limits, usage: {
    users: numberAt(usageData, "users"),
    whatsapp: numberAt(usageData, "whatsapp"),
    active_agents: numberAt(usageData, "active_agents"),
    monthly_conversations: numberAt(usageData, "monthly_conversations"),
  } };
}
