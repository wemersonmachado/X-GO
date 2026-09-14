import { z } from "zod";

import { DIRECOES_FINANCEIRAS, SITUACOES_FINANCEIRAS } from "./tipos";

export const criarLancamentoSchema = z.object({
  direction: z.enum(DIRECOES_FINANCEIRAS),
  description: z.string().trim().min(2).max(200),
  amount_cents: z.number().int().positive().max(999_999_999_999),
  currency: z.literal("BRL").default("BRL"),
  due_date: z.iso.date(),
  notes: z.string().trim().max(1000).nullish(),
}).strict();

export const alterarSituacaoSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["settle", "cancel", "reopen"]),
  revision: z.number().int().positive(),
  confirmation: z.literal(true),
  settled_amount_cents: z.number().int().positive().max(999_999_999_999).optional(),
}).strict().superRefine((valor, ctx) => {
  if (valor.action !== "settle" && valor.settled_amount_cents !== undefined) {
    ctx.addIssue({ code: "custom", path: ["settled_amount_cents"], message: "Valor baixado só é aceito na baixa." });
  }
});

export const filtrosFinanceirosSchema = z.object({
  direction: z.enum(DIRECOES_FINANCEIRAS).optional(),
  status: z.enum(SITUACOES_FINANCEIRAS).optional(),
});
