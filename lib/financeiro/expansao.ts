import { z } from "zod";

export const OPERACOES_FINANCEIRAS = ["entry", "payment", "refund", "discount", "transfer", "commitment"] as const;
export const MODOS_DELEGACAO = ["propose"] as const;
export const TIPOS_CATALOGO = ["category", "cost_center", "account"] as const;

export type OperacaoFinanceira = (typeof OPERACOES_FINANCEIRAS)[number];
export type ModoDelegacao = (typeof MODOS_DELEGACAO)[number];

export const criarCatalogoSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("category"), name: z.string().trim().min(2).max(100), direction: z.enum(["receivable", "payable"]) }).strict(),
  z.object({ type: z.literal("cost_center"), name: z.string().trim().min(2).max(100) }).strict(),
  z.object({ type: z.literal("account"), name: z.string().trim().min(2).max(100), kind: z.enum(["cash", "bank", "other"]), currency: z.literal("BRL").default("BRL") }).strict(),
]);

export const atualizarCatalogoSchema = z.object({
  type: z.enum(TIPOS_CATALOGO), id: z.uuid(), name: z.string().trim().min(2).max(100).optional(), active: z.boolean().optional(),
}).strict().refine(value => value.name !== undefined || value.active !== undefined, "Informe o que alterar.");

export const permissaoAgenteSchema = z.object({
  agent_id: z.uuid(), operation: z.enum(OPERACOES_FINANCEIRAS),
  mode: z.enum(MODOS_DELEGACAO).nullable(),
  max_amount_cents: z.number().int().positive().max(999_999_999_999).nullable().optional(),
}).strict();

export const criarPropostaSchema = z.object({
  operation: z.enum(OPERACOES_FINANCEIRAS),
  description: z.string().trim().min(2).max(200),
  amount_cents: z.number().int().positive().max(999_999_999_999),
  currency: z.literal("BRL").default("BRL"),
  direction: z.enum(["receivable", "payable"]).optional(),
  due_date: z.iso.date().optional(),
  evidence_note: z.string().trim().max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.operation === "entry" && (!value.direction || !value.due_date)) {
    ctx.addIssue({ code: "custom", message: "Um lançamento proposto precisa de tipo e vencimento." });
  }
});

export const decidirPropostaSchema = z.object({
  id: z.uuid(), action: z.enum(["approve", "reject"]), revision: z.number().int().positive(), confirmation: z.literal(true),
}).strict();

export function podePropor(mode: ModoDelegacao | null, amount: number, limit: number | null): boolean {
  return mode !== null && (limit === null || amount <= limit);
}
