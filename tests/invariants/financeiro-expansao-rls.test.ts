import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { lastLine, sql } from "./gov-helpers";

const orgA = randomUUID(), orgB = randomUUID();
const manager = randomUUID(), viewer = randomUUID();
const agentA = randomUUID(), agentB = randomUUID();
const entryA = randomUUID(), entryB = randomUUID();
const accountA = randomUUID(), accountB = randomUUID();
const proposalA = randomUUID(), proposalB = randomUUID();
const batchA = randomUUID(), batchB = randomUUID();
const hash = "a".repeat(64);
const tables = ["finance_categories", "finance_cost_centers", "finance_accounts",
  "finance_agent_permissions", "finance_proposals", "finance_documents", "finance_chart_accounts",
  "finance_import_batches", "finance_import_movements", "finance_fiscal_requests"] as const;

function asUser(user: string, command: string): string {
  return sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
    ${command}`);
}

beforeAll(() => {
  sql(`insert into auth.users (id,email) values ('${manager}','fin-exp-manager-${manager}@test.invalid'),
      ('${viewer}','fin-exp-viewer-${viewer}@test.invalid');
    insert into organizations (id,slug,legal_name,display_name) values
      ('${orgA}','${orgA}','Finance Exp A','Finance Exp A'),('${orgB}','${orgB}','Finance Exp B','Finance Exp B');
    insert into user_organizations (user_id,organization_id,role,accepted_at) values
      ('${manager}','${orgA}','manager',now()),('${viewer}','${orgA}','viewer',now());
    insert into ai_agents (id,organization_id,name,system_prompt) values
      ('${agentA}','${orgA}','Finance A','Ajude.'),('${agentB}','${orgB}','Finance B','Ajude.');
    insert into finance_entries (id,organization_id,direction,description,amount_cents,due_date) values
      ('${entryA}','${orgA}','receivable','Receita A',10000,current_date),
      ('${entryB}','${orgB}','receivable','Receita B',10000,current_date);
    insert into finance_categories (organization_id,name,direction) values ('${orgA}','Venda A','receivable'),('${orgB}','Venda B','receivable');
    insert into finance_cost_centers (organization_id,name) values ('${orgA}','Centro A'),('${orgB}','Centro B');
    insert into finance_accounts (id,organization_id,name,kind) values ('${accountA}','${orgA}','Banco A','bank'),('${accountB}','${orgB}','Banco B','bank');
    insert into finance_agent_permissions (organization_id,agent_id,operation,mode) values ('${orgA}','${agentA}','entry','propose'),('${orgB}','${agentB}','entry','propose');
    insert into finance_proposals (id,organization_id,agent_id,operation,description,amount_cents,direction,due_date,source_request_id,request_fingerprint)
      values ('${proposalA}','${orgA}','${agentA}','entry','Proposta A',10000,'receivable',current_date,'req-a','${hash}'),
      ('${proposalB}','${orgB}','${agentB}','entry','Proposta B',10000,'receivable',current_date,'req-b','${hash}');
    insert into finance_documents (organization_id,entry_id,storage_path,file_name,mime_type,size_bytes,sha256)
      values ('${orgA}','${entryA}','${orgA}/a','a.pdf','application/pdf',10,'${hash}'),
      ('${orgB}','${entryB}','${orgB}/b','b.pdf','application/pdf',10,'${hash}');
    insert into finance_chart_accounts (organization_id,code,name,direction) values ('${orgA}','1.1','Receita A','receivable'),('${orgB}','1.1','Receita B','receivable');
    insert into finance_import_batches (id,organization_id,account_id,file_sha256,file_name,format)
      values ('${batchA}','${orgA}','${accountA}','${hash}','a.ofx','ofx'),
      ('${batchB}','${orgB}','${accountB}','${hash}','b.ofx','ofx');
    insert into finance_import_movements (organization_id,batch_id,account_id,external_id,occurred_on,description,amount_cents,direction)
      values ('${orgA}','${batchA}','${accountA}','mov-a',current_date,'Movimento A',10000,'receivable'),
      ('${orgB}','${batchB}','${accountB}','mov-b',current_date,'Movimento B',10000,'receivable');
    insert into finance_fiscal_requests (organization_id,entry_id,municipality_code,document_kind,idempotency_key,request_fingerprint,approved_by_user_id,approved_at)
      values ('${orgA}','${entryA}','3550308','nfse','fiscal-a-1','${hash}','${manager}',now()),
      ('${orgB}','${entryB}','3304557','nfse','fiscal-b-1','${hash}',null,now());`);
});

describe("financeiro expandido — RLS", () => {
  it.each(tables)("manager lê %s somente da organização ativa", table => {
    expect(Number(lastLine(asUser(manager, `select count(*) from ${table};`)))).toBe(1);
    expect(Number(lastLine(asUser(manager, `select count(*) from ${table} where organization_id='${orgB}';`)))).toBe(0);
  });
  it.each(tables)("viewer não lê %s", table => {
    expect(Number(lastLine(asUser(viewer, `select count(*) from ${table};`)))).toBe(0);
  });
  it("JWT autenticado não escreve diretamente em cadastros", () => {
    expect(() => asUser(manager, `insert into finance_cost_centers (organization_id,name) values ('${orgA}','Negado');`)).toThrow();
  });
});
