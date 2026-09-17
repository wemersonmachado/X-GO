"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({ limit_action: z.enum(["block", "credits", "overage"]) });

export async function saveBillingPreference(form: FormData) {
  const auth = await requireRole("admin", { resource: "billing_preferences" });
  if (!auth.ok) return;
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return;
  await createAdminClient().from("organization_billing_preferences" as never).upsert({
    organization_id: auth.org.orgId, limit_action: parsed.data.limit_action,
    updated_by: auth.user.id, updated_at: new Date().toISOString(),
  } as never, { onConflict: "organization_id" } as never);
  await audit({ action: "billing.preference_updated", actorUserId: auth.user.id, organizationId: auth.org.orgId, resourceType: "organization_billing_preferences", metadata: { limit_action: parsed.data.limit_action } });
  revalidatePath("/app/settings/billing");
}
