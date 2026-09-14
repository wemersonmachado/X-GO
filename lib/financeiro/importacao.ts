import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/contacts/csv";

export type MovimentoImportado = { external_id: string; occurred_on: string; description: string;
  amount_cents: number; direction: "receivable" | "payable" };

const MAX_ROWS = 500;
function dataIso(raw: string): string {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    const [d, m, y] = value.split("/"); return dataIso(`${y}-${m}-${d}`);
  }
  throw new Error("Data do extrato inválida.");
}

function centavos(raw: string): number {
  let input = raw.trim().replace(/\s/g, "");
  if (!input || !/^-?[\d.,]+$/.test(input)) throw new Error("Valor do extrato inválido.");
  const negative = input.startsWith("-"); if (negative) input = input.slice(1);
  const lastComma = input.lastIndexOf(","); const lastDot = input.lastIndexOf(".");
  const decimal = Math.max(lastComma, lastDot);
  const fraction = decimal >= 0 ? input.slice(decimal + 1) : "";
  if (decimal >= 0 && fraction.length !== 2) throw new Error("Valor deve ter duas casas decimais.");
  const integer = (decimal >= 0 ? input.slice(0, decimal) : input).replace(/[.,]/g, "");
  if (!/^\d+$/.test(integer) || (fraction && !/^\d{2}$/.test(fraction))) throw new Error("Valor do extrato inválido.");
  const value = Number(integer) * 100 + Number(fraction || "0");
  if (!Number.isSafeInteger(value) || value <= 0 || value > 999_999_999_999) throw new Error("Valor do extrato fora do limite.");
  return negative ? -value : value;
}

function finalize(rows: Array<Omit<MovimentoImportado, "direction" | "amount_cents"> & { signed: number }>): MovimentoImportado[] {
  if (!rows.length || rows.length > MAX_ROWS) throw new Error("O extrato deve ter de 1 a 500 movimentações.");
  const seen = new Set<string>();
  return rows.map(row => {
    if (!row.external_id || row.external_id.length > 120 || !row.description || row.description.length > 200 || seen.has(row.external_id))
      throw new Error("Extrato com ID duplicado ou descrição inválida.");
    seen.add(row.external_id);
    return { external_id: row.external_id, occurred_on: dataIso(row.occurred_on),
      description: row.description, amount_cents: Math.abs(row.signed), direction: row.signed > 0 ? "receivable" : "payable" };
  });
}

export function parseFinanceCsv(raw: string): MovimentoImportado[] {
  const rows = parseCsv(raw);
  const header = rows.shift()?.map(cell => cell.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  if (!header || !["id", "data", "descricao", "valor"].every(name => header.includes(name)))
    throw new Error("CSV precisa das colunas id, data, descricao e valor.");
  const pos = (name: string) => header.indexOf(name);
  return finalize(rows.map(row => ({ external_id: row[pos("id")]?.trim() ?? "",
    occurred_on: row[pos("data")] ?? "", description: row[pos("descricao")]?.trim() ?? "",
    signed: centavos(row[pos("valor")] ?? "") })));
}

function ofxField(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}

export function parseFinanceOfx(raw: string): MovimentoImportado[] {
  const currencies = [...raw.matchAll(/<CURDEF>([^<\r\n]+)/gi)].map(match => match[1]?.trim().toUpperCase());
  if (!currencies.length || currencies.some(currency => currency !== "BRL"))
    throw new Error("O OFX precisa declarar moeda BRL.");
  const accounts = [...raw.matchAll(/<(?:BANKACCTFROM|CCACCTFROM)>([\s\S]*?)(?:<\/(?:BANKACCTFROM|CCACCTFROM)>|(?=<(?:BANKACCTFROM|CCACCTFROM)>)|$)/gi)]
    .map(match => match[1] ?? "");
  if (accounts.length !== 1) throw new Error("O OFX precisa conter exatamente uma conta.");
  const blocks = [...raw.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi)].map(match => match[1] ?? "");
  return finalize(blocks.map(block => {
    const date = ofxField(block, "DTPOSTED").slice(0, 8);
    if (!/^\d{8}$/.test(date)) throw new Error("Data OFX inválida.");
    const amount = ofxField(block, "TRNAMT").replace(".", ",");
    return { external_id: ofxField(block, "FITID"),
      occurred_on: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      description: ofxField(block, "MEMO") || ofxField(block, "NAME"), signed: centavos(amount) };
  }));
}

export function hashExtrato(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
