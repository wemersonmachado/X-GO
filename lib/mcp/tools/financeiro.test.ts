import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "../types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
import { audit } from "@/lib/audit";
import { crmProposeFinancialAction } from "./financeiro";

const input = { operation: "payment" as const, description: "Pagar fornecedor", amount_cents: 10_000 };

function context(permission: { mode: "propose"; max_amount_cents: number | null } | null,
  actor: McpContext["actor"] = { type: "ai_agent", id: "run", role: "agent", agent_id: "11111111-1111-4111-8111-111111111111" },
  insertError: { code: string } | null = null): McpContext {
  const permissionQuery = { select: () => permissionQuery, eq: () => permissionQuery,
    maybeSingle: async () => ({ data: permission, error: null }) };
  const proposalQuery = { insert: () => proposalQuery, select: () => proposalQuery, eq: () => proposalQuery,
    single: async () => insertError ? ({ data: null, error: insertError }) : ({ data: { id: "proposal-1", status: "pending" }, error: null }) };
  return { organizationId: "22222222-2222-4222-8222-222222222222", role: "agent", actor,
    apiTokenId: "33333333-3333-4333-8333-333333333333", requestId: "44444444-4444-4444-8444-444444444444",
    supabase: { from: (table: string) => table === "finance_agent_permissions" ? permissionQuery : proposalQuery } as never };
}

describe("crm_propose_financial_action", () => {
  beforeEach(() => vi.clearAllMocks());
  it("recusa chamada sem identidade confiável do agente", async () => {
    const result = await crmProposeFinancialAction.handler(input, context(null, { type: "user", id: "user", role: "admin" }));
    expect(result).toEqual({ accepted: false, reason: "agent_identity_required" });
  });
  it("recusa operação sem delegação e acima do limite", async () => {
    expect(await crmProposeFinancialAction.handler(input, context(null))).toEqual({ accepted: false, reason: "delegation_disabled" });
    expect(await crmProposeFinancialAction.handler(input, context({ mode: "propose", max_amount_cents: 9_999 })))
      .toEqual({ accepted: false, reason: "amount_exceeds_limit" });
  });
  it("cria proposta pendente e audita sem executar valor", async () => {
    const result = await crmProposeFinancialAction.handler(input, context({ mode: "propose", max_amount_cents: 10_000 }));
    expect(result).toMatchObject({ accepted: true, proposal_id: "proposal-1", status: "pending" });
    expect(audit).toHaveBeenCalledOnce();
  });
});
