/**
 * Assinaturas e recibos de checkout jamais são lidos pelo browser. Mesmo com
 * RLS, um grant herdado permitiria acrescentar uma policy permissiva depois;
 * por isso a prova mede ausência de privilégio e `permission denied`.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = [
  "organization_subscriptions",
  "platform_checkout_access",
  "platform_checkout_intents",
  "platform_subscription_payments",
] as const;

function privileges(role: string, table: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = '${table}' and grantee = '${role}';
  `).trim();
}

function hasPrivilege(role: string, table: string, privilege: string): boolean {
  return (
    sql(`select has_table_privilege('${role}', 'public.${table}', '${privilege}');`).trim() === "t"
  );
}

function denied(role: string, table: string): string | null {
  try {
    sql(`set role ${role}; select * from public.${table}; reset role;`);
    return null;
  } catch (error) {
    return motivoDoErro(error);
  }
}

describe.each(TABELAS)("dados de pagamento server-only: %s", (table) => {
  it("existe no baseline e tem RLS", () => {
    expect(
      sql(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass;`),
    ).toBe("t");
  });

  it("anon e authenticated não recebem privilégio", () => {
    expect(privileges("anon", table)).toBe("NENHUM");
    expect(privileges("authenticated", table)).toBe("NENHUM");
  });

  it("anon e authenticated não herdam SELECT, INSERT, UPDATE ou DELETE", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(
          hasPrivilege(role, table, privilege),
          `${role} herdou ${privilege} em ${table}`,
        ).toBe(false);
      }
    }
  });

  it("anon e authenticated recebem permission denied ao ler", () => {
    expect(denied("anon", table)).toContain("permission denied");
    expect(denied("authenticated", table)).toContain("permission denied");
  });

  it("service_role mantém a capacidade de processar o webhook", () => {
    const granted = privileges("service_role", table);
    expect(granted).toContain("SELECT");
    expect(granted).toContain("INSERT");
    expect(granted).toContain("UPDATE");
  });
});
