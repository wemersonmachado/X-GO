"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { resumirFinanceiro } from "@/lib/financeiro/resumo";
import type { DirecaoFinanceira, LancamentoFinanceiro, SituacaoFinanceira } from "@/lib/financeiro/tipos";
import { formatCentsBRL, parseReaisToCents } from "@/lib/money";
import { ArrowsClockwise, Plus, Receipt } from "@/lib/ui/icons";

const BASE = "/api/v1/financeiro/lancamentos";
async function ler<T>(res: Response): Promise<T> {
  const corpo = await res.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!res.ok || !corpo?.data) throw new Error(corpo?.error?.message ?? "Não foi possível concluir a operação.");
  return corpo.data;
}

export function FinanceiroClient({ podeAprovar }: { podeAprovar: boolean }) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const [items, setItems] = useState<LancamentoFinanceiro[]>([]);
  const [carregando, setCarregando] = useState(true), [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [direction, setDirection] = useState<DirecaoFinanceira>("receivable");
  const [description, setDescription] = useState(""), [amount, setAmount] = useState(""), [dueDate, setDueDate] = useState(""), [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"all" | SituacaoFinanceira>("open");
  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    // O resumo precisa do conjunto inteiro. O filtro é uma projeção local da
    // lista; aplicá-lo na consulta faria os cartões mudarem de total ao trocar aba.
    try { const data = await ler<{ entries: LancamentoFinanceiro[] }>(await fetch(BASE, { cache: "no-store" })); setItems(data.entries); }
    catch (e) { setErro(e instanceof Error ? e.message : "Falha ao carregar."); } finally { setCarregando(false); }
  }, []);
  useEffect(() => {
    // Agenda depois do commit: evita a atualização síncrona em cascata que o
    // React 19 sinaliza quando o carregamento nasce dentro do próprio effect.
    const timer = window.setTimeout(() => void carregar(), 0);
    return () => window.clearTimeout(timer);
  }, [carregar]);
  const hoje = format(new Date(), "yyyy-MM-dd");
  const resumo = useMemo(() => resumirFinanceiro(items, hoje), [items, hoje]);
  const exibidos = status === "all" ? items : items.filter((item) => item.status === status);

  async function criar(event: FormEvent) {
    event.preventDefault(); setErro(null); const cents = parseReaisToCents(amount);
    if (!cents) { setErro(t("Informe um valor maior que zero.")); return; }
    setSalvando(true);
    try {
      await ler(await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ direction, description, amount_cents: cents, currency: "BRL", due_date: dueDate, notes: notes || null }) }));
      setDescription(""); setAmount(""); setDueDate(""); setNotes(""); await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : "Falha ao criar lançamento."); } finally { setSalvando(false); }
  }
  async function mudar(item: LancamentoFinanceiro, action: "settle" | "cancel" | "reopen") {
    const frase = action === "settle" ? t("Confirmar a baixa? Isso declara que o valor foi realizado.") : action === "cancel" ? t("Cancelar sem apagar a trilha?") : t("Reabrir este lançamento?");
    if (!window.confirm(frase)) return;
    setSalvando(true); setErro(null);
    try { await ler(await fetch(BASE, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, action, revision: item.revision, confirmation: true }) })); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Falha ao alterar lançamento."); } finally { setSalvando(false); }
  }

  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
    <header><div className="flex items-center gap-2"><Receipt size={26} aria-hidden /><h1 className="text-2xl font-semibold">{t("Financeiro")}</h1></div><p className="mt-1 text-sm text-muted-foreground">{t("Contas a pagar e receber, vencimentos e fluxo de caixa. O sistema registra; não movimenta dinheiro.")}</p></header>
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label={t("Resumo financeiro")}>
      {[[t("A receber"), resumo.receberAbertoCents, "text-emerald-700"], [t("A pagar"), resumo.pagarAbertoCents, "text-red-700"], [t("Saldo previsto"), resumo.saldoPrevistoCents, ""], [t("Saldo realizado"), resumo.saldoRealizadoCents, ""]].map(([label, value, cor]) => <article key={String(label)} className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className={`mt-1 text-lg font-semibold ${cor}`}>{formatCentsBRL(Number(value))}</p></article>)}
      <article className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">{t("Vencidos")}</p><p className="mt-1 text-lg font-semibold text-amber-700">{resumo.vencidos}</p></article>
    </section>
    <section className="rounded-xl border bg-card p-4 sm:p-5"><h2 className="font-semibold">{t("Novo lançamento")}</h2>
      <form onSubmit={criar} className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-5">
        <label className="text-sm">{t("Tipo")}<select value={direction} onChange={(e) => setDirection(e.target.value as DirecaoFinanceira)} className="mt-1 h-10 w-full rounded-sm border bg-background px-3"><option value="receivable">{t("Conta a receber")}</option><option value="payable">{t("Conta a pagar")}</option></select></label>
        <label className="text-sm lg:col-span-2">{t("Descrição")}<Input className="mt-1" value={description} onChange={(e) => setDescription(e.target.value)} minLength={2} maxLength={200} required /></label>
        <label className="text-sm">{t("Valor (R$)")}<Input className="mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" required /></label>
        <label className="text-sm">{t("Vencimento")}<Input className="mt-1" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></label>
        <label className="text-sm md:col-span-2 lg:col-span-4">{t("Observações (opcional)")}<Textarea className="mt-1 min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></label>
        <div className="flex items-end"><Button type="submit" disabled={salvando} className="w-full gap-2"><Plus size={16} />{t("Registrar")}</Button></div>
      </form>
    </section>
    {erro && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{erro}</p>}
    <section className="rounded-xl border bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><h2 className="font-semibold">{t("Lançamentos")}</h2><div className="flex gap-2"><select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="open">{t("Em aberto")}</option><option value="settled">{t("Baixados")}</option><option value="cancelled">{t("Cancelados")}</option><option value="all">{t("Todos")}</option></select><Button type="button" variant="outline" size="sm" aria-label={t("Atualizar")} onClick={() => void carregar()} disabled={carregando}><ArrowsClockwise size={15} className={carregando ? "animate-spin" : ""} /></Button></div></div>
      {carregando ? <p className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</p> : exibidos.length === 0 ? <p className="p-6 text-sm text-muted-foreground">{t("Nenhum lançamento neste filtro.")}</p> : <div className="divide-y">{exibidos.map((item) => <article key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-xs ${item.direction === "receivable" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>{item.direction === "receivable" ? t("Receber") : t("Pagar")}</span><strong>{item.description}</strong></div><p className="mt-1 text-sm text-muted-foreground">{t("Vence em")} {new Date(`${item.due_date}T12:00:00`).toLocaleDateString(tagDeIdioma)} · {item.source === "agent_proposal" ? t("proposto por agente") : t("registro manual")}</p></div><div className="flex flex-wrap items-center gap-2 sm:justify-end"><strong>{formatCentsBRL(item.amount_cents)}</strong><span className="rounded-full border px-2 py-0.5 text-xs">{item.status === "open" ? t("Em aberto") : item.status === "settled" ? t("Baixado") : t("Cancelado")}</span>{podeAprovar && item.status === "open" && <><Button size="sm" onClick={() => void mudar(item, "settle")} disabled={salvando}>{t("Confirmar baixa")}</Button><Button size="sm" variant="outline" onClick={() => void mudar(item, "cancel")} disabled={salvando}>{t("Cancelar")}</Button></>}{podeAprovar && item.status === "cancelled" && <Button size="sm" variant="outline" onClick={() => void mudar(item, "reopen")} disabled={salvando}>{t("Reabrir")}</Button>}</div></article>)}</div>}
    </section>
    <aside className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"><strong>{t("Confirmação humana obrigatória.")}</strong> {t("Pagamentos, reembolsos, descontos, transferências e compromissos financeiros não são executados pelo agente. A fila de propostas do agente entra na próxima fase.")}</aside>
  </main>;
}
