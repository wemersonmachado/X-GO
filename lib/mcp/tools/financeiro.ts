import { createHash } from "node:crypto";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { criarPropostaSchema, OPERACOES_FINANCEIRAS, podePropor } from "@/lib/financeiro/expansao";
import type { McpToolDefinition } from "@/lib/mcp/types";

const inputSchema = {
  operation: z.enum(OPERACOES_FINANCEIRAS),
  description: z.string(),
  amount_cents: z.number(),
  direction: z.enum(["receivable", "payable"]).optional(),
  due_date: z.string().optional(),
  evidence_note: z.string().optional(),
};

export const crmProposeFinancialAction: McpToolDefinition<typeof inputSchema> = {
  name: "crm_propose_financial_action",
  description: "Propõe um lançamento, pagamento, reembolso, desconto, transferência ou compromisso financeiro. A proposta fica pendente; nunca movimenta dinheiro nem promete execução ao cliente. Use somente fatos documentados e informe valor em centavos. Uma pessoa administradora decidirá.",
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  inputSchema,
  async handler(input, ctx) {
    // O modelo e o token MCP externo não escolhem o próprio agent_id.
    const agentId = ctx.actor.type === "ai_agent" ? ctx.actor.agent_id : undefined;
    if (!agentId) return { accepted: false, reason: "agent_identity_required" };
    const parsed = criarPropostaSchema.safeParse(input);
    if (!parsed.success) return { accepted: false, reason: "invalid_proposal" };
    const orgId = ctx.organizationId;
    const permission = await ctx.supabase.from("finance_agent_permissions")
      .select("mode,max_amount_cents").eq("organization_id", orgId)
      .eq("agent_id", agentId).eq("operation", parsed.data.operation).maybeSingle();
    if (permission.error) return { accepted: false, reason: "permission_unavailable" };
    const mode = permission.data?.mode ?? null;
    const limit = permission.data?.max_amount_cents === null || permission.data?.max_amount_cents === undefined
      ? null : Number(permission.data.max_amount_cents);
    if (!podePropor(mode, parsed.data.amount_cents, limit)) {
      return { accepted: false, reason: permission.data ? "amount_exceeds_limit" : "delegation_disabled" };
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
    const payload = { ...parsed.data, organization_id: orgId, agent_id: agentId,
      source_request_id: ctx.requestId, request_fingerprint: fingerprint, status: "pending" };
    const created = await ctx.supabase.from("finance_proposals").insert(payload).select("id,status").single();
    let proposal = created.data;
    if (created.error?.code === "23505") {
      const existing = await ctx.supabase.from("finance_proposals").select("id,status")
        .eq("organization_id", orgId).eq("agent_id", agentId)
        .eq("source_request_id", ctx.requestId).eq("request_fingerprint", fingerprint).single();
      if (existing.error) return { accepted: false, reason: "proposal_unavailable" };
      proposal = existing.data;
    } else if (created.error) {
      return { accepted: false, reason: "proposal_unavailable" };
    } else {
      await audit({ action: "finance.proposal_created", actorApiTokenId: ctx.apiTokenId,
        organizationId: orgId, resourceType: "finance_proposals", resourceId: proposal!.id,
        requestId: ctx.requestId, metadata: { operation: parsed.data.operation, agent_id: agentId } });
    }
    return { accepted: true, proposal_id: proposal!.id, status: proposal!.status,
      message: "Proposta registrada para decisão humana. Nenhum valor foi movimentado." };
  },
};
