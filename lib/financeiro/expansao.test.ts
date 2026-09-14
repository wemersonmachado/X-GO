import { describe, expect, it } from "vitest";

import {
  atualizarCatalogoSchema,
  criarCatalogoSchema,
  criarPropostaSchema,
  decidirPropostaSchema,
  permissaoAgenteSchema,
  podePropor,
} from "./expansao";

const agentId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";

describe("permissões do agente financeiro", () => {
  it("aceita delegação com limite e rejeita operação, identidade ou valor inválidos", () => {
    expect(permissaoAgenteSchema.safeParse({
      agent_id: agentId, operation: "payment", mode: "propose", max_amount_cents: 50_000,
    }).success).toBe(true);
    expect(permissaoAgenteSchema.safeParse({ agent_id: agentId, operation: "not-a-finance-operation", mode: "propose" }).success).toBe(false);
    expect(permissaoAgenteSchema.safeParse({ agent_id: "agent-1", operation: "payment", mode: "propose" }).success).toBe(false);
    expect(permissaoAgenteSchema.safeParse({ agent_id: agentId, operation: "payment", mode: "propose", max_amount_cents: 0 }).success).toBe(false);
    expect(permissaoAgenteSchema.safeParse({ agent_id: agentId, operation: "payment", mode: "propose", extra: true }).success).toBe(false);
  });

  it("aplica o limite por operação e permite limite ausente", () => {
    expect(podePropor(null, 1_000, null)).toBe(false);
    expect(podePropor("propose", 1_000, null)).toBe(true);
    expect(podePropor("propose", 10_000, 10_000)).toBe(true);
    expect(podePropor("propose", 10_001, 10_000)).toBe(false);
  });
});

describe("schemas da expansão financeira", () => {
  it("mantém catálogos discriminados por tipo e com moeda BRL", () => {
    expect(criarCatalogoSchema.parse({ type: "account", name: "Conta corrente", kind: "bank" })).toEqual({
      type: "account", name: "Conta corrente", kind: "bank", currency: "BRL",
    });
    expect(criarCatalogoSchema.safeParse({ type: "category", name: "Vendas", direction: "receivable", kind: "bank" }).success).toBe(false);
    expect(criarCatalogoSchema.safeParse({ type: "account", name: "A", kind: "bank" }).success).toBe(false);
  });

  it("exige pelo menos uma alteração no catálogo", () => {
    expect(atualizarCatalogoSchema.safeParse({ type: "account", id: itemId }).success).toBe(false);
    expect(atualizarCatalogoSchema.safeParse({ type: "account", id: itemId, active: false }).success).toBe(true);
    expect(atualizarCatalogoSchema.safeParse({ type: "account", id: itemId, name: "Nova conta" }).success).toBe(true);
  });

  it("exige contexto completo para propor lançamento e confirmação literal para decidir", () => {
    expect(criarPropostaSchema.safeParse({ operation: "entry", description: "Venda", amount_cents: 1_000 }).success).toBe(false);
    expect(criarPropostaSchema.safeParse({
      operation: "entry", description: "Venda", amount_cents: 1_000,
      direction: "receivable", due_date: "2026-09-30",
    }).success).toBe(true);
    expect(decidirPropostaSchema.safeParse({ id: itemId, action: "approve", revision: 1, confirmation: true }).success).toBe(true);
    expect(decidirPropostaSchema.safeParse({ id: itemId, action: "approve", revision: 1, confirmation: "true" }).success).toBe(false);
  });
});
