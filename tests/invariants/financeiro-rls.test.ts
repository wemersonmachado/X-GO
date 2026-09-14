import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { lastLine, sql } from "./gov-helpers";

const orgA = randomUUID(), orgB = randomUUID();
const manager = randomUUID(), admin = randomUUID(), viewer = randomUUID();
const entrada = randomUUID();

function como(userId: string, comando: string): string {
  return sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${comando}`);
}

beforeAll(() => {
  sql(`insert into auth.users (id,email) values
    ('${manager}','fin-manager@test.invalid'),('${admin}','fin-admin@test.invalid'),('${viewer}','fin-viewer@test.invalid');
    insert into organizations (id,slug,legal_name,display_name) values
    ('${orgA}','${orgA}','Finance A','Finance A'),('${orgB}','${orgB}','Finance B','Finance B');
    insert into user_organizations (user_id,organization_id,role,accepted_at) values
    ('${manager}','${orgA}','manager',now()),('${admin}','${orgA}','admin',now()),('${viewer}','${orgA}','viewer',now());
    insert into finance_entries (id,organization_id,direction,description,amount_cents,due_date,created_by_user_id)
    values ('${entrada}','${orgA}','receivable','Recebível A',10000,current_date,'${manager}'),
           ('${randomUUID()}','${orgB}','payable','Conta B',5000,current_date,null);`);
});

describe("financeiro — RLS e aprovação humana", () => {
  it("manager lê somente a própria organização; criação direta é fechada", () => {
    expect(Number(lastLine(como(manager, "select count(*) from finance_entries;")))).toBe(1);
    expect(Number(lastLine(como(manager, `select count(*) from finance_entries where organization_id = '${orgB}';`)))).toBe(0);
    expect(() => como(manager, `insert into finance_entries (organization_id,direction,description,amount_cents,due_date,created_by_user_id)
      values ('${orgA}','payable','Despesa manual',1200,current_date,'${manager}');`)).toThrow();
  });
  it("viewer não lê nem cria registros financeiros", () => {
    expect(Number(lastLine(como(viewer, "select count(*) from finance_entries;")))).toBe(0);
    expect(() => como(viewer, `insert into finance_entries (organization_id,direction,description,amount_cents,due_date)
      values ('${orgA}','payable','Negado',100,current_date);`)).toThrow();
  });
  it("JWT humano não baixa direto nem mesmo como admin", () => {
    expect(() => como(manager, `update finance_entries set status='settled',settled_amount_cents=10000,
      settled_at=now(),approved_by_user_id='${manager}' where id='${entrada}';`)).toThrow();
    expect(() => como(admin, `update finance_entries set status='settled',settled_amount_cents=10000,
      settled_at=now(),approved_by_user_id='${admin}',revision=2 where id='${entrada}';`)).toThrow();
    sql(`update finance_entries set status='settled',settled_amount_cents=10000,
      settled_at=now(),approved_by_user_id='${admin}',revision=2 where id='${entrada}';`);
    expect(lastLine(como(admin, `select status from finance_entries where id='${entrada}';`))).toBe("settled");
  });
  it("ninguém autenticado recebe DELETE", () => {
    expect(() => como(admin, `delete from finance_entries where id='${entrada}';`)).toThrow();
  });
});
