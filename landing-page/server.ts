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
    ? { ...(stored as Record<string, unknown>), plans: ((stored as { plans: unknown[] }).plans).map((plan, index) => {
      if (!plan || typeof plan !== "object") return plan;
      const limits = { ...(DEFAULT_LANDING.plans[index]?.limits ?? {}), ...((plan as { limits?: Record<string, unknown> }).limits ?? {}) };
      // Corrige apenas os valores publicados que eram o padrão antigo, sem
      // sobrescrever uma escolha explícita feita pelo administrador.
      if (index === 0 && limits.whatsapp === 3) limits.whatsapp = 1;
      if (index === 1 && limits.whatsapp === 10) limits.whatsapp = 3;
      const features = Array.isArray((plan as { features?: unknown }).features) && (plan as { features: unknown[] }).features.length >= 6
        ? (plan as { features: unknown[] }).features
        : DEFAULT_LANDING.plans[index]?.features;
      return { ...(plan as Record<string, unknown>), limits, features, checkout_enabled: (plan as { checkout_enabled?: unknown }).checkout_enabled ?? DEFAULT_LANDING.plans[index]?.checkout_enabled };
    }), addons: (stored as { addons?: unknown }).addons ?? DEFAULT_LANDING.addons }
    : stored;
  const parsed = landingSchema.safeParse(normalized);
  return parsed.success ? parsed.data : DEFAULT_LANDING;
  } catch { return DEFAULT_LANDING; }
});
