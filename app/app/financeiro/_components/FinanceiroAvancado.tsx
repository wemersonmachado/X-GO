"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { formatCentsBRL, parseReaisToCents } from "@/lib/money";
import { OPERACOES_FINANCEIRAS, type OperacaoFinanceira } from "@/lib/financeiro/expansao";

type Catalog = { id: string; name: string; active: boolean; direction?: string; kind?: string };
type Agent = { id: string; name: string; kind: string; archived_at: string | null };
type Permission = { agent_id: string; operation: OperacaoFinanceira; mode: "propose"; max_amount_cents: number | null };
type Proposal = { id: string; agent_id: string; operation: OperacaoFinanceira; status: string; description: string;
  amount_cents: number; currency: string; direction: "receivable" | "payable" | null; due_date: string | null;
  revision: number; evidence_note: string | null; created_at: string };
type CatalogData = { categories: Catalog[]; cost_centers: Catalog[]; accounts: Catalog[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? "Falha ao consultar o financeiro.");
  return body.data;
}

const operationLabels: Record<OperacaoFinanceira, string> = {
  entry: "Lançamento", payment: "Pagamento", refund: "Reembolso",
  discount: "Desconto", transfer: "Transferência", commitment: "Compromisso financeiro",
};

export function FinanceiroAvancado({ podeAprovar }: { podeAprovar: boolean }) {
  const t = useT();
  const [catalogs, setCatalogs] = useState<CatalogData>({ categories: [], cost_centers: [], accounts: [] });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogType, setCatalogType] = useState<"category" | "cost_center" | "account">("category");
  const [catalogName, setCatalogName] = useState("");
  const [direction, setDirection] = useState<"receivable" | "payable">("payable");
  const [accountKind, setAccountKind] = useState<"cash" | "bank" | "other">("bank");
  const [agentId, setAgentId] = useState("");
  const [operation, setOperation] = useState<OperacaoFinanceira>("entry");
  const [maxAmount, setMaxAmount] = useState("");

  const load = useCallback(async () => {
    try {
      const [c, p, a, agentRows] = await Promise.all([
        api<CatalogData>("/api/v1/financeiro/catalogos"),
        api<{ proposals: Proposal[] }>("/api/v1/financeiro/propostas"),
        api<{ permissions: Permission[] }>("/api/v1/financeiro/permissoes"),
        api<Agent[]>("/api/v1/ai/agents"),
      ]);
      setCatalogs(c); setProposals(p.proposals); setPermissions(a.permissions);
      setAgents(agentRows.filter(item => !item.archived_at));
      setAgentId(current => current || agentRows.find(item => !item.archived_at)?.id || "");
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao consultar o financeiro."); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function createCatalog(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    const payload = catalogType === "category" ? { type: catalogType, name: catalogName, direction }
      : catalogType === "account" ? { type: catalogType, name: catalogName, kind: accountKind, currency: "BRL" }
      : { type: catalogType, name: catalogName };
    try {
      await api("/api/v1/financeiro/catalogos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setCatalogName(""); await load(); window.dispatchEvent(new Event("finance-catalogs-changed"));
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar cadastro."); }
    finally { setBusy(false); }
  }

  async function changeCatalog(type: "category" | "cost_center" | "account", item: Catalog) {
    setBusy(true); setError(null);
    try {
      await api("/api/v1/financeiro/catalogos", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, id: item.id, active: !item.active }) });
      await load(); window.dispatchEvent(new Event("finance-catalogs-changed"));
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao alterar cadastro."); }
    finally { setBusy(false); }
  }

  async function savePermission(mode: "propose" | null) {
    if (!agentId) return;
    const cents = maxAmount.trim() ? parseReaisToCents(maxAmount) : null;
    if (maxAmount.trim() && !cents) { setError(t("Informe um limite maior que zero.")); return; }
    setBusy(true); setError(null);
    try {
      await api("/api/v1/financeiro/permissoes", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, operation, mode, max_amount_cents: mode ? cents : null }) });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar delegação."); }
    finally { setBusy(false); }
  }

  async function decide(item: Proposal, action: "approve" | "reject") {
    const text = action === "approve"
      ? t("Aprovar esta proposta? Nenhum pagamento ou transferência será executado por esta aprovação.")
      : t("Rejeitar esta proposta?");
    if (!window.confirm(text)) return;
    setBusy(true); setError(null);
    try {
      await api("/api/v1/financeiro/propostas", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action, revision: item.revision, confirmation: true }) });
      await load();
      if (item.operation === "entry" && action === "approve") window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao decidir proposta."); }
    finally { setBusy(false); }
  }

  const lists: Array<{ type: "category" | "cost_center" | "account"; label: string; items: Catalog[] }> = [
    { type: "category", label: t("Categorias"), items: catalogs.categories },
    { type: "cost_center", label: t("Centros de custo"), items: catalogs.cost_centers },
    { type: "account", label: t("Contas financeiras"), items: catalogs.accounts },
  ];
  const selectedPermission = permissions.find(item => item.agent_id === agentId && item.operation === operation);

  return <div className="flex flex-col gap-6">
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-label={t("Cadastros financeiros")}>
      <h2 className="font-semibold">{t("Cadastros financeiros")}</h2>
      {podeAprovar && <form onSubmit={createCatalog} className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-sm">{t("Cadastro")}<select aria-label={t("Cadastro")} className="mt-1 h-10 w-full rounded-sm border bg-background px-3" value={catalogType} onChange={e => setCatalogType(e.target.value as typeof catalogType)}>
          <option value="category">{t("Categoria")}</option><option value="cost_center">{t("Centro de custo")}</option><option value="account">{t("Conta financeira")}</option>
        </select></label>
        <label className="text-sm">{t("Nome")}<Input className="mt-1" value={catalogName} onChange={e => setCatalogName(e.target.value)} minLength={2} maxLength={100} required /></label>
        {catalogType === "category" && <label className="text-sm">{t("Tipo")}<select className="mt-1 h-10 w-full rounded-sm border bg-background px-3" value={direction} onChange={e => setDirection(e.target.value as typeof direction)}><option value="payable">{t("Despesa")}</option><option value="receivable">{t("Receita")}</option></select></label>}
        {catalogType === "account" && <label className="text-sm">{t("Tipo de conta")}<select className="mt-1 h-10 w-full rounded-sm border bg-background px-3" value={accountKind} onChange={e => setAccountKind(e.target.value as typeof accountKind)}><option value="bank">{t("Banco")}</option><option value="cash">{t("Caixa")}</option><option value="other">{t("Outra")}</option></select></label>}
        <div className="flex items-end"><Button className="w-full" disabled={busy} type="submit">{t("Adicionar")}</Button></div>
      </form>}
      <div className="mt-5 grid gap-4 md:grid-cols-3">{lists.map(list => <div key={list.type}><h3 className="text-sm font-semibold">{list.label}</h3><ul className="mt-2 space-y-2 text-sm">{list.items.map(item => <li key={item.id} className="flex items-center justify-between gap-2 rounded-md border p-2"><span>{item.name}{!item.active && <span className="ml-1 text-muted-foreground">({t("inativo")})</span>}</span>{podeAprovar && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void changeCatalog(list.type, item)}>{item.active ? t("Desativar") : t("Ativar")}</Button>}</li>)}{list.items.length === 0 && <li className="text-muted-foreground">{t("Nenhum cadastro ainda.")}</li>}</ul></div>)}</div>
    </section>
    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-label={t("Delegação ao agente")}>
      <h2 className="font-semibold">{t("Delegação ao agente")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("Cada operação começa desabilitada. O agente só prepara propostas; uma pessoa administradora decide.")}</p>
      {podeAprovar && <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-sm">{t("Agente")}<select aria-label={t("Agente")} className="mt-1 h-10 w-full rounded-sm border bg-background px-3" value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">{t("Selecione")}</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="text-sm">{t("Operação")}<select aria-label={t("Operação")} className="mt-1 h-10 w-full rounded-sm border bg-background px-3" value={operation} onChange={e => setOperation(e.target.value as OperacaoFinanceira)}>{OPERACOES_FINANCEIRAS.map(op => <option key={op} value={op}>{t(operationLabels[op])}</option>)}</select></label>
        <label className="text-sm">{t("Limite por proposta (R$)")}<Input className="mt-1" inputMode="decimal" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} placeholder={t("Sem limite definido")} /></label>
        <div className="flex items-end gap-2"><Button type="button" disabled={busy || !agentId} onClick={() => void savePermission("propose")}>{t("Permitir propostas")}</Button><Button type="button" variant="outline" disabled={busy || !agentId || !selectedPermission} onClick={() => void savePermission(null)}>{t("Desativar")}</Button></div>
      </div>}
      <p className="mt-3 text-sm">{t("Permissão atual")}: {selectedPermission ? `${t("Propor")} · ${selectedPermission.max_amount_cents === null ? t("Sem limite definido") : formatCentsBRL(selectedPermission.max_amount_cents)}` : t("Desabilitada")}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t("Ative também a ferramenta financeira no perfil do agente.")} <Link className="underline" href="/app/ai/agents">{t("Abrir agentes")}</Link></p>
    </section>
    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-label={t("Propostas financeiras")}>
      <h2 className="font-semibold">{t("Propostas financeiras")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("Aprovar um pagamento, reembolso, desconto, transferência ou compromisso não executa a operação externa.")}</p>
      <ul className="mt-4 space-y-3">{proposals.map(item => <li key={item.id} className="rounded-md border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{t(operationLabels[item.operation])}: {item.description}</strong><span>{formatCentsBRL(item.amount_cents)} · {t(item.status === "pending" ? "Pendente" : item.status === "approved" ? "Aprovada" : item.status === "rejected" ? "Rejeitada" : "Concluída")}</span></div>{item.operation === "entry" && item.direction && item.due_date && <p className="mt-1 text-muted-foreground">{item.direction === "receivable" ? t("Receber") : t("Pagar")} · {t("Vencimento")}: {item.due_date}</p>}{item.evidence_note && <p className="mt-1 text-muted-foreground">{item.evidence_note}</p>}{podeAprovar && item.status === "pending" && <div className="mt-3 flex gap-2"><Button type="button" size="sm" disabled={busy} onClick={() => void decide(item, "approve")}>{t("Aprovar")}</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide(item, "reject")}>{t("Rejeitar")}</Button></div>}</li>)}{proposals.length === 0 && <li className="text-sm text-muted-foreground">{t("Nenhuma proposta financeira pendente.")}</li>}</ul>
    </section>
  </div>;
}
