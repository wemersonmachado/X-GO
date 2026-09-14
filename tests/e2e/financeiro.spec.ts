import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { loginComoAdmin } from "./helpers/login-admin";

const credsPath = path.join(process.cwd(), ".e2e-creds.json");
const evidencia = path.join(process.cwd(), ".superpowers", "evidence", "financeiro");
const marcador = `Financeiro E2E ${Date.now()}`;
const adminDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let creds: { password: string; org_id: string; users: Record<string, { email: string }> };

async function login(page: Page) {
  if (!fs.existsSync(credsPath)) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  creds = (await loginComoAdmin(page, creds)) as typeof creds;
}

test.describe("Financeiro — registro e aprovação humana", () => {
  test.afterAll(async () => { if (creds) await adminDb.from("finance_entries").delete().eq("organization_id", creds.org_id).eq("description", marcador); });

  test("admin registra conta e confirma a baixa pela interface", async ({ page }) => {
    test.setTimeout(150_000); await login(page); fs.mkdirSync(evidencia, { recursive: true });
    await page.getByRole("link", { name: /ver tudo em crm/i }).click();
    await page.getByRole("link", { name: "Financeiro" }).click();
    await expect(page.getByRole("heading", { name: "Financeiro", level: 1 })).toBeVisible();
    await page.getByLabel("Descrição").fill(marcador);
    await page.getByLabel("Valor (R$)").fill("249,90");
    await page.getByLabel("Vencimento").fill("2026-09-30");
    await page.getByRole("button", { name: "Registrar" }).click();
    await expect(page.getByText(marcador)).toBeVisible();
    await page.screenshot({ path: path.join(evidencia, "lancamento-em-aberto.png"), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Confirmar baixa" }).click();
    await page.getByRole("combobox").last().selectOption("settled");
    await expect(page.getByText(marcador)).toBeVisible();
    await expect(page.getByText("Baixado", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidencia, "lancamento-baixado.png"), fullPage: true });
  });
});
