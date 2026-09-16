import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_LANDING, landingSchema } from "./schema";
export const readLanding = cache(async () => {
  try {
  const { data, error } = await createAdminClient().from("platform_branding").select("landing_page").eq("id", 1).maybeSingle();
  if (error) return DEFAULT_LANDING;
  const stored = (data as unknown as { landing_page?: unknown } | null)?.landing_page;
  // Compatibilidade de publicação: a landing anterior não tinha `limits`.
  // Preservamos todo texto/tema já publicado e só preenchemos a cota canônica.
  const normalized = stored && typeof stored === "object" && Array.isArray((stored as { plans?: unknown }).plans)
    ? { ...(stored as Record<string, unknown>), plans: ((stored as { plans: unknown[] }).plans).map((plan, index) => plan && typeof plan === "object" ? { ...(plan as Record<string, unknown>), limits: (plan as { limits?: unknown }).limits ?? DEFAULT_LANDING.plans[index]?.limits } : plan), addons: (stored as { addons?: unknown }).addons ?? DEFAULT_LANDING.addons }
    : stored;
  const parsed = landingSchema.safeParse(normalized);
  return parsed.success ? parsed.data : DEFAULT_LANDING;
  } catch { return DEFAULT_LANDING; }
});
