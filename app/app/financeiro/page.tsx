import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { FinanceiroClient } from "./_components/FinanceiroClient";

export const dynamic = "force-dynamic";

export default async function FinanceiroPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if ((!user.is_platform_admin || user.support) && ROLE_RANK[org.role] < ROLE_RANK.manager) redirect("/403");
  const podeAprovar = (user.is_platform_admin && !user.support) || ROLE_RANK[org.role] >= ROLE_RANK.admin;
  return <FinanceiroClient podeAprovar={podeAprovar} />;
}
