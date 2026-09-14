import { describe, expect, it } from "vitest";

import { hashExtrato, parseFinanceCsv, parseFinanceOfx } from "./importacao";

describe("importação de extratos", () => {
  it("parseia CSV pt-BR com delimitador do Excel, datas e valores assinados", () => {
    const csv = [
      "ID;Data;Descrição;Valor",
      'mov-001;14/09/2026;"Recebimento; pedido 42";1.234,56',
      "mov-002;2026-09-15;Tarifa bancária;-20,00",
    ].join("\r\n");

    expect(parseFinanceCsv(csv)).toEqual([
      {
        external_id: "mov-001",
        occurred_on: "2026-09-14",
        description: "Recebimento; pedido 42",
        amount_cents: 123_456,
        direction: "receivable",
      },
      {
        external_id: "mov-002",
        occurred_on: "2026-09-15",
        description: "Tarifa bancária",
        amount_cents: 2_000,
        direction: "payable",
      },
    ]);
  });

  it("parseia OFX e usa MEMO, com NAME como fallback", () => {
    const ofx = [
      "<OFX><CURDEF>BRL</CURDEF><BANKACCTFROM><BANKID>001</BANKID><ACCTID>123</ACCTID></BANKACCTFROM><BANKTRANLIST>",
      "<STMTTRN><FITID>fit-001</FITID><DTPOSTED>20260914083000[-3:BRT]</DTPOSTED><TRNAMT>100.50</TRNAMT><MEMO>Pix recebido</MEMO></STMTTRN>",
      "<STMTTRN><FITID>fit-002</FITID><DTPOSTED>20260915</DTPOSTED><TRNAMT>-25.00</TRNAMT><NAME>Compra no cartão</NAME></STMTTRN>",
      "</BANKTRANLIST></OFX>",
    ].join("");

    expect(parseFinanceOfx(ofx)).toEqual([
      {
        external_id: "fit-001",
        occurred_on: "2026-09-14",
        description: "Pix recebido",
        amount_cents: 10_050,
        direction: "receivable",
      },
      {
        external_id: "fit-002",
        occurred_on: "2026-09-15",
        description: "Compra no cartão",
        amount_cents: 2_500,
        direction: "payable",
      },
    ]);
  });

  it("recusa cabeçalho incompleto, IDs duplicados e dados inválidos", () => {
    expect(() => parseFinanceCsv("id,data,descricao\n1,2026-09-14,Venda")).toThrow(
      "CSV precisa das colunas id, data, descricao e valor",
    );
    expect(() => parseFinanceCsv([
      "id,data,descricao,valor",
      "same,2026-09-14,Venda,10.00",
      "same,2026-09-15,Outra venda,20.00",
    ].join("\n"))).toThrow("ID duplicado");
    expect(() => parseFinanceCsv("id,data,descricao,valor\n1,31/02/2026,Venda,10.00")).toThrow("Data do extrato");
    expect(() => parseFinanceCsv("id,data,descricao,valor\n1,2026-09-14,Venda,0.00")).toThrow("fora do limite");
  });

  it("gera hash SHA-256 estável para a mesma carga e diferente para outra", () => {
    const bytes = new TextEncoder().encode("id,data,descricao,valor\n1,2026-09-14,Venda,10.00");

    expect(hashExtrato(bytes)).toBe(hashExtrato(new Uint8Array(bytes)));
    expect(hashExtrato(bytes)).not.toBe(hashExtrato(new TextEncoder().encode("outro arquivo")));
    expect(hashExtrato(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });
});
