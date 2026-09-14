import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { loginComoAdmin } from "./helpers/login-admin";

const credsPath = path.join(process.cwd(), ".e2e-creds.json");
const evidencia = path.join(process.cwd(), ".superpowers", "evidence", "financeiro");
const marcador = `Financeiro E2E ${Date.now()}`;
const marcadorAvancado = `Financeiro avançado ${Date.now()}`;
const adminDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let creds: { password: string; org_id: string; users: Record<string, { email: string }> };

async function login(page: Page) {
  if (!fs.existsSync(credsPath)) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  creds = (await loginComoAdmin(page, creds)) as typeof creds;
}

test.describe("Financeiro — registro e aprovação humana", () => {
  test.afterAll(async () => {
    if (!creds) return;
    const entries = await adminDb.from("finance_entries").select("id").eq("organization_id", creds.org_id)
      .in("description", [marcador, marcadorAvancado]);
    const ids = (entries.data ?? []).map(item => item.id);
    if (ids.length) await adminDb.from("finance_fiscal_requests").delete().eq("organization_id", creds.org_id).in("entry_id", ids);
    await adminDb.from("finance_entries").delete().eq("organization_id", creds.org_id).in("description", [marcador, marcadorAvancado]);
    await adminDb.from("finance_categories").delete().eq("organization_id", creds.org_id).eq("name", marcadorAvancado);
    await adminDb.from("finance_accounts").delete().eq("organization_id", creds.org_id).eq("name", marcadorAvancado);
    await adminDb.from("finance_chart_accounts").delete().eq("organization_id", creds.org_id).eq("name", marcadorAvancado);
  });

  test("admin registra conta e confirma a baixa pela interface", async ({ page }) => {
    test.setTimeout(150_000); await login(page); fs.mkdirSync(evidencia, { recursive: true });
    await page.getByRole("link", { name: /ver tudo em crm/i }).click();
    await page.getByRole("link", { name: "Financeiro" }).click();
    await expect(page.getByRole("heading", { name: "Financeiro", level: 1 })).toBeVisible();
    const novo = page.getByRole("region", { name: "Novo lançamento" });
    const lancamentos = page.getByRole("region", { name: "Lançamentos" });
    await novo.getByLabel("Descrição").fill(marcador);
    await novo.getByLabel("Valor (R$)").fill("249,90");
    await novo.getByLabel("Vencimento").fill("2026-09-30");
    await novo.getByRole("button", { name: "Registrar", exact: true }).click();
    await expect(lancamentos.getByText(marcador, { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidencia, "lancamento-em-aberto.png"), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await lancamentos.getByRole("button", { name: "Confirmar baixa" }).click();
    await page.getByLabel("Filtrar lançamentos").selectOption("settled");
    await expect(lancamentos.getByText(marcador, { exact: true })).toBeVisible();
    await expect(lancamentos.getByText("Baixado", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidencia, "lancamento-baixado.png"), fullPage: true });
  });

  test("admin classifica por competência, vê DRE e registra pedido fiscal bloqueado", async ({ page }) => {
    test.setTimeout(180_000); await login(page); fs.mkdirSync(evidencia, { recursive: true });
    await page.goto("/app/financeiro");

    const cadastros = page.getByRole("region", { name: "Cadastros financeiros" });
    await cadastros.getByLabel("Cadastro").selectOption("category");
    await cadastros.getByLabel("Tipo").selectOption("receivable");
    await cadastros.getByLabel("Nome").fill(marcadorAvancado);
    await cadastros.getByRole("button", { name: "Adicionar" }).click();
    await expect(cadastros.getByText(marcadorAvancado)).toBeVisible();
    await cadastros.getByLabel("Cadastro").selectOption("account");
    await cadastros.getByLabel("Nome").fill(marcadorAvancado);
    await cadastros.getByRole("button", { name: "Adicionar" }).click();

    const novo = page.getByRole("region", { name: "Novo lançamento" });
    await novo.getByLabel("Descrição").fill(marcadorAvancado);
    await novo.getByLabel("Valor (R$)").fill("500,00");
    await novo.getByLabel("Vencimento").fill("2026-09-30");
    await novo.getByLabel("Competência").fill("2026-09-15");
    await novo.getByLabel("Categoria").selectOption({ label: marcadorAvancado });
    await novo.getByLabel("Conta financeira").selectOption({ label: marcadorAvancado });
    await novo.getByRole("button", { name: "Registrar" }).click();
    await expect(page.getByText(marcadorAvancado).first()).toBeVisible();

    const dre = page.getByRole("region", { name: "Plano de contas e DRE gerencial" });
    await dre.getByLabel("Código").fill("9.99");
    await dre.getByLabel("Nome").fill(marcadorAvancado);
    await dre.getByRole("button", { name: "Criar conta gerencial" }).click();
    const entrySelect = dre.getByLabel("Classificar lançamento");
    const entryValue = await entrySelect.locator("option").filter({ hasText: marcadorAvancado }).getAttribute("value");
    expect(entryValue).toBeTruthy();
    await entrySelect.selectOption(entryValue!);
    await dre.getByLabel("Competência").fill("2026-09-15");
    const chartSelect = dre.getByLabel("Conta gerencial");
    const chartValue = await chartSelect.locator("option").filter({ hasText: marcadorAvancado }).getAttribute("value");
    expect(chartValue).toBeTruthy();
    await chartSelect.selectOption(chartValue!);
    await dre.getByLabel("Conta financeira").selectOption({ label: marcadorAvancado });
    await dre.getByRole("button", { name: "Salvar classificação" }).click();
    await dre.getByLabel("Mês da DRE").fill("2026-09");
    await dre.getByRole("button", { name: "Ver DRE" }).click();
    await expect(dre.getByText(/Resultado:.*R\$\s*500,00/)).toBeVisible();

    const fiscal = page.getByRole("region", { name: "Fila fiscal do Brasil" });
    const fiscalSelect = fiscal.getByLabel("Receita");
    const fiscalEntryValue = await fiscalSelect.locator("option").filter({ hasText: marcadorAvancado }).getAttribute("value");
    expect(fiscalEntryValue).toBeTruthy();
    await fiscalSelect.selectOption(fiscalEntryValue!);
    await fiscal.getByLabel("Município IBGE").fill("3550308");
    page.once("dialog", dialog => dialog.accept());
    await fiscal.getByRole("button", { name: "Registrar solicitação" }).click();
    await expect(fiscal.getByText(/NFSE · município 3550308 · awaiting_provider/i)).toBeVisible();
    await page.screenshot({ path: path.join(evidencia, "financeiro-fases-2-a-5.png"), fullPage: true });
  });
});
