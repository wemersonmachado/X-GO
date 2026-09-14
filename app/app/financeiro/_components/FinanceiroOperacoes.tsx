"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import type { LancamentoFinanceiro } from "@/lib/financeiro/tipos";
import { formatCentsBRL } from "@/lib/money";

type Account = { id: string; name: string; active: boolean };
type Chart = { id: string; code: string; name: string; direction: "receivable" | "payable"; active: boolean };
type Batch = { id: string; file_name: string; account_id: string; created_at: string };
type MovementStatus = "pending" | "matched" | "ignored";
type Movement = {
  id: string;
  description: string;
  occurred_on: string;
  direction: "receivable" | "payable";
  amount_cents: number;
  status: MovementStatus;
  revision: number;
  matched_entry_id: string | null;
};
type Fiscal = { id: string; entry_id: string; document_kind: "nfse" | "nfe"; municipality_code: string; status: string };
type FinanceDocument = { id: string; file_name: string; size_bytes: number; created_at: string };
type Dre = {
  revenue_cents: number;
  expense_cents: number;
  result_cents: number;
  unclassified_count: number;
  lines: Array<{ code: string | null; name: string; amount_cents: number; direction: "receivable" | "payable" }>;
};

const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
function localMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? "Falha no financeiro.");
  return body.data;
}

const json = (body: unknown, method: "POST" | "PATCH" | "DELETE") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function FinanceiroOperacoes({ entries, accounts, podeAprovar, onReload }: {
  entries: LancamentoFinanceiro[];
  accounts: Account[];
  podeAprovar: boolean;
  onReload: () => Promise<void>;
}) {
  const t = useT();
  const direcaoLabel: Record<Movement["direction"], string> = { receivable: t("Recebimento"), payable: t("Pagamento") };
  const movimentoLabel: Record<MovementStatus, string> = { pending: t("Pendente"), matched: t("Conciliado"), ignored: t("Ignorado") };
  const importFileRef = useRef<HTMLInputElement>(null);
  const documentFileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState("");
  const [movements, setMovements] = useState<Movement[]>([]);
  const [importAccount, setImportAccount] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [matching, setMatching] = useState<Record<string, string>>({});
  const [chart, setChart] = useState<Chart[]>([]);
  const [chartCode, setChartCode] = useState("");
  const [chartName, setChartName] = useState("");
  const [chartDirection, setChartDirection] = useState<"receivable" | "payable">("receivable");
  const [classEntry, setClassEntry] = useState("");
  const [classAccount, setClassAccount] = useState("");
  const [classBankAccount, setClassBankAccount] = useState("");
  const [classDate, setClassDate] = useState("");
  const [dreMonth, setDreMonth] = useState(localMonth);
  const [dre, setDre] = useState<Dre | null>(null);
  const [fiscal, setFiscal] = useState<Fiscal[]>([]);
  const [fiscalEntry, setFiscalEntry] = useState("");
  const [municipality, setMunicipality] = useState("");
  const [fiscalKind, setFiscalKind] = useState<"nfse" | "nfe">("nfse");
  const [fiscalKey, setFiscalKey] = useState(() => crypto.randomUUID());
  const [documentEntry, setDocumentEntry] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documents, setDocuments] = useState<FinanceDocument[]>([]);

  const refresh = useCallback(async () => {
    const [imported, charted, fiscaled] = await Promise.all([
      call<{ batches: Batch[] }>("/api/v1/financeiro/extratos"),
      call<{ accounts: Chart[] }>("/api/v1/financeiro/plano-contas"),
      call<{ requests: Fiscal[] }>("/api/v1/financeiro/fiscal"),
    ]);
    setBatches(imported.batches);
    setChart(charted.accounts);
    setFiscal(fiscaled.requests);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((cause: unknown) => setError(messageFrom(cause, t("Falha no financeiro."))));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh, t]);

  useEffect(() => {
    if (!batchId) return;
    const controller = new AbortController();
    void call<{ movements: Movement[] }>(`/api/v1/financeiro/extratos?${new URLSearchParams({ batch_id: batchId })}`, { signal: controller.signal })
      .then((data) => setMovements(data.movements))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(messageFrom(cause, t("Falha no financeiro.")));
      });
    return () => controller.abort();
  }, [batchId, t]);

  useEffect(() => {
    if (!documentEntry) return;
    const controller = new AbortController();
    void call<{ documents: FinanceDocument[] }>(`/api/v1/financeiro/documentos?${new URLSearchParams({ entry_id: documentEntry })}`, { signal: controller.signal })
      .then((data) => setDocuments(data.documents))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(messageFrom(cause, t("Falha no financeiro.")));
      });
    return () => controller.abort();
  }, [documentEntry, t]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === classEntry),
    [classEntry, entries],
  );
  const matchingEntries = useMemo(
    () => entries.filter((entry) => entry.status !== "cancelled"),
    [entries],
  );
  const fiscalEntries = useMemo(
    () => entries.filter((entry) => entry.direction === "receivable" && entry.status !== "cancelled"),
    [entries],
  );

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
    } catch (cause) {
      setError(messageFrom(cause, t("Falha no financeiro.")));
    } finally {
      setBusy(false);
    }
  }

  function selectImportFile(file: File | null) {
    if (!file) return setImportFile(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if ((extension !== "csv" && extension !== "ofx") || file.size < 1 || file.size > IMPORT_MAX_BYTES) {
      setImportFile(null);
      if (importFileRef.current) importFileRef.current.value = "";
      setError(t("Envie um arquivo CSV ou OFX de até 2 MB."));
      return;
    }
    setError(null);
    setImportFile(file);
  }

  function selectBatch(id: string) {
    setBatchId(id);
    setMovements([]);
    setMatching({});
  }

  function selectDocumentEntry(id: string) {
    setDocumentEntry(id);
    setDocuments([]);
  }

  function selectDocumentFile(file: File | null) {
    if (!file) return setDocumentFile(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!(["pdf", "png", "jpg", "jpeg"] as string[]).includes(extension ?? "") || file.size < 1 || file.size > DOCUMENT_MAX_BYTES) {
      setDocumentFile(null);
      if (documentFileRef.current) documentFileRef.current.value = "";
      setError(t("Envie PDF, PNG ou JPEG de até 10 MB."));
      return;
    }
    setError(null);
    setDocumentFile(file);
  }

  function uploadImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!importFile || !importAccount) return;
    void run(async () => {
      const form = new FormData();
      form.set("file", importFile);
      form.set("account_id", importAccount);
      const result = await call<{ batch_id: string; duplicate: boolean; count: number }>("/api/v1/financeiro/extratos", { method: "POST", body: form });
      await refresh();
      selectBatch(result.batch_id);
      setImportFile(null);
      if (importFileRef.current) importFileRef.current.value = "";
    }, t("Extrato importado para revisão."));
  }

  function decideMovement(item: Movement, action: "match" | "ignore") {
    const entryId = action === "match" ? matching[item.id] : null;
    if (action === "match" && !entryId) return;
    const prompt = action === "match"
      ? t("Vincular este movimento ao lançamento selecionado? A baixa continua separada.")
      : t("Ignorar este movimento do extrato?");
    if (!window.confirm(prompt)) return;
    void run(async () => {
      await call("/api/v1/financeiro/conciliacao", json({
        movement_id: item.id,
        entry_id: entryId,
        action,
        revision: item.revision,
        confirmation: true,
      }, "PATCH"));
      const data = await call<{ movements: Movement[] }>(`/api/v1/financeiro/extratos?${new URLSearchParams({ batch_id: batchId })}`);
      setMovements(data.movements);
    }, action === "match" ? t("Movimento conciliado. A baixa permanece uma confirmação separada.") : t("Movimento ignorado."));
  }

  function createChart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      await call("/api/v1/financeiro/plano-contas", json({ code: chartCode, name: chartName, direction: chartDirection }, "POST"));
      setChartCode("");
      setChartName("");
      await refresh();
    }, t("Conta gerencial criada."));
  }

  function changeClassEntry(id: string) {
    setClassEntry(id);
    const entry = entries.find((item) => item.id === id);
    setClassDate(entry?.competence_date ?? "");
    setClassAccount(entry?.chart_account_id ?? "");
    setClassBankAccount(entry?.account_id ?? "");
  }

  function classify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEntry) return;
    void run(async () => {
      await call("/api/v1/financeiro/classificacao", json({
        id: selectedEntry.id,
        revision: selectedEntry.revision,
        chart_account_id: classAccount || null,
        competence_date: classDate || null,
        account_id: classBankAccount || null,
      }, "PATCH"));
      await onReload();
      setDre(null);
    }, t("Classificação do lançamento salva."));
  }

  function loadDre() {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(dreMonth)) return setError(t("Informe um mês no formato AAAA-MM."));
    void run(async () => {
      setDre(await call<Dre>(`/api/v1/financeiro/dre?${new URLSearchParams({ month: dreMonth })}`));
    }, t("DRE atualizada."));
  }

  function requestFiscal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm(t("Registrar solicitação fiscal? Sem provedor escolhido, nenhuma nota será enviada."))) return;
    void run(async () => {
      await call("/api/v1/financeiro/fiscal", {
        ...json({ entry_id: fiscalEntry, municipality_code: municipality, document_kind: fiscalKind, confirmation: true }, "POST"),
        headers: { "Content-Type": "application/json", "Idempotency-Key": fiscalKey },
      });
      setFiscalEntry("");
      setMunicipality("");
      setFiscalKey(crypto.randomUUID());
      await refresh();
    }, t("Solicitação fiscal registrada na fila de integração."));
  }

  function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!documentFile || !documentEntry) return;
    void run(async () => {
      const form = new FormData();
      form.set("file", documentFile);
      form.set("entry_id", documentEntry);
      await call("/api/v1/financeiro/documentos", { method: "POST", body: form });
      setDocumentFile(null);
      if (documentFileRef.current) documentFileRef.current.value = "";
      const data = await call<{ documents: FinanceDocument[] }>(`/api/v1/financeiro/documentos?${new URLSearchParams({ entry_id: documentEntry })}`);
      setDocuments(data.documents);
    }, t("Anexo privado enviado."));
  }

  function openDocument(item: FinanceDocument) {
    const documentWindow = window.open("", "_blank");
    void run(async () => {
      try {
        const result = await call<{ url: string }>(`/api/v1/financeiro/documentos?${new URLSearchParams({ id: item.id })}`);
        if (documentWindow) {
          documentWindow.opener = null;
          documentWindow.location.assign(result.url);
        } else {
          window.location.assign(result.url);
        }
      } catch (cause) {
        documentWindow?.close();
        throw cause;
      }
    }, t("Anexo aberto em outra aba."));
  }

  function deleteDocument(item: FinanceDocument) {
    if (!window.confirm(`${t("Excluir o anexo")} “${item.file_name}”? ${t("Esta ação não pode ser desfeita.")}`)) return;
    void run(async () => {
      await call("/api/v1/financeiro/documentos", json({ id: item.id, confirmation: true }, "DELETE"));
      setDocuments((current) => current.filter((document) => document.id !== item.id));
    }, t("Anexo excluído."));
  }

  return <div className="space-y-6" aria-busy={busy}>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">{notice}</p>}

    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="financeiro-extratos">
      <h2 id="financeiro-extratos" className="font-semibold">{t("Importação e conciliação de extratos")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("Envie CSV ou OFX de até 2 MB. Importar não baixa lançamentos; a conciliação também precisa de aceite humano.")}</p>
      <form onSubmit={uploadImport} className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">{t("Conta financeira")}
          <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={importAccount} onChange={(event) => setImportAccount(event.target.value)} required>
            <option value="">{t("Selecione")}</option>
            {accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <label className="text-sm">{t("Arquivo CSV ou OFX")}
          <Input ref={importFileRef} className="mt-1" type="file" accept=".csv,.ofx,text/csv,application/x-ofx" onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} required />
        </label>
        <div className="flex items-end"><Button className="w-full" disabled={busy || !importFile || !importAccount} type="submit">{t("Importar para revisão")}</Button></div>
      </form>
      <label className="mt-5 block text-sm">{t("Extrato importado")}
        <select className="mt-1 block h-10 w-full rounded-md border bg-background px-2" value={batchId} onChange={(event) => selectBatch(event.target.value)}>
          <option value="">{t("Selecione um extrato")}</option>
          {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.file_name} · {batch.created_at.slice(0, 10)}</option>)}
        </select>
      </label>
      {batchId && movements.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t("Nenhuma movimentação encontrada neste extrato.")}</p>}
      <ul className="mt-3 space-y-2" aria-label={t("Movimentações do extrato")}>
        {movements.map((item) => {
          const statementAccount = batches.find((batch) => batch.id === batchId)?.account_id;
          const candidates = matchingEntries.filter((entry) => entry.direction === item.direction
            && (entry.settled_amount_cents ?? entry.amount_cents) === item.amount_cents
            && entry.account_id === statementAccount);
          return <li key={item.id} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <div><strong>{item.description}</strong><p className="mt-1 text-muted-foreground">{item.occurred_on} · {direcaoLabel[item.direction]}</p></div>
              <span>{formatCentsBRL(item.amount_cents)} · {movimentoLabel[item.status]}</span>
            </div>
            {item.status === "pending" && (podeAprovar ? <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="min-w-56 flex-1 text-sm">{t("Lançamento correspondente")}
                <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={matching[item.id] ?? ""} onChange={(event) => setMatching((current) => ({ ...current, [item.id]: event.target.value }))}>
                  <option value="">{t("Selecione um lançamento")}</option>
                  {candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.description} · {entry.due_date}</option>)}
                </select>
              </label>
              <Button type="button" disabled={busy || !matching[item.id]} onClick={() => decideMovement(item, "match")}>{t("Conciliar")}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => decideMovement(item, "ignore")}>{t("Ignorar")}</Button>
            </div> : <p className="mt-3 text-muted-foreground">{t("Aguarda uma pessoa administradora para decidir a conciliação.")}</p>)}
          </li>;
        })}
      </ul>
    </section>

    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="financeiro-dre">
      <h2 id="financeiro-dre" className="font-semibold">{t("Plano de contas e DRE gerencial")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("A DRE usa competência, inclui lançamentos em aberto e exclui os cancelados. Não é demonstrativo contábil.")}</p>
      {podeAprovar && <form onSubmit={createChart} className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-sm">{t("Código")}
          <Input className="mt-1" value={chartCode} onChange={(event) => setChartCode(event.target.value)} placeholder="1.1" pattern="\d+(\.\d+)*" maxLength={30} required />
        </label>
        <label className="text-sm sm:col-span-2">{t("Nome")}
          <Input className="mt-1" value={chartName} onChange={(event) => setChartName(event.target.value)} minLength={2} maxLength={100} required />
        </label>
        <label className="text-sm">{t("Tipo")}
          <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={chartDirection} onChange={(event) => setChartDirection(event.target.value as typeof chartDirection)}>
            <option value="receivable">{t("Receita")}</option><option value="payable">{t("Despesa")}</option>
          </select>
        </label>
        <div className="sm:col-span-4"><Button type="submit" disabled={busy}>{t("Criar conta gerencial")}</Button></div>
      </form>}
      <ul className="mt-4 space-y-1 text-sm" aria-label={t("Plano de contas")}>
        {chart.map((account) => <li key={account.id}>{account.code} · {account.name} · {account.direction === "receivable" ? t("Receita") : t("Despesa")}{!account.active && ` · ${t("Inativa")}`}</li>)}
        {chart.length === 0 && <li className="text-muted-foreground">{t("Nenhuma conta gerencial cadastrada.")}</li>}
      </ul>
      <form onSubmit={classify} className="mt-5 grid gap-3 border-t pt-5 sm:grid-cols-5">
        <label className="text-sm sm:col-span-2">{t("Classificar lançamento")}
          <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={classEntry} onChange={(event) => changeClassEntry(event.target.value)} required>
            <option value="">{t("Selecione")}</option>
            {matchingEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.description} · {formatCentsBRL(entry.amount_cents)}</option>)}
          </select>
        </label>
        <label className="text-sm">{t("Competência")}
          <Input className="mt-1" type="date" value={classDate} onChange={(event) => setClassDate(event.target.value)} required />
        </label>
        <label className="text-sm">{t("Conta gerencial")}
          <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={classAccount} onChange={(event) => setClassAccount(event.target.value)}>
            <option value="">{t("Sem conta")}</option>
            {chart.filter((account) => account.active && account.direction === selectedEntry?.direction).map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          </select>
        </label>
        <label className="text-sm">{t("Conta financeira")}
          <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={classBankAccount} onChange={(event) => setClassBankAccount(event.target.value)}>
            <option value="">{t("Sem conta financeira")}</option>
            {accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <div className="sm:col-span-5"><Button type="submit" disabled={busy || !selectedEntry}>{t("Salvar classificação")}</Button></div>
      </form>
      <div className="mt-5 flex flex-wrap items-end gap-2 border-t pt-5">
        <label className="text-sm">{t("Mês da DRE")}
          <Input className="mt-1" type="month" value={dreMonth} onChange={(event) => setDreMonth(event.target.value)} required />
        </label>
        <Button type="button" variant="outline" disabled={busy} onClick={loadDre}>{t("Ver DRE")}</Button>
      </div>
      {dre && <div className="mt-4 rounded-md border p-3 text-sm" aria-live="polite">
        <p>{t("Receitas")}: {formatCentsBRL(dre.revenue_cents)} · {t("Despesas")}: {formatCentsBRL(dre.expense_cents)} · {t("Resultado")}: <strong>{formatCentsBRL(dre.result_cents)}</strong></p>
        <p className="mt-1 text-muted-foreground">{dre.unclassified_count} {t("lançamento(s) sem competência ficam fora da DRE.")}</p>
        <ul className="mt-3 space-y-1">{dre.lines.map((line) => <li key={`${line.code}-${line.name}`}>{line.code ?? "—"} · {line.name}: {formatCentsBRL(line.amount_cents)}</li>)}</ul>
      </div>}
    </section>

    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="financeiro-fiscal">
      <h2 id="financeiro-fiscal" className="font-semibold">{t("Fila fiscal do Brasil")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("Não há provedor configurado. A solicitação fica aguardando integração e nenhuma nota é emitida.")}</p>
      {podeAprovar && <form onSubmit={requestFiscal} className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">{t("Receita")}
          <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={fiscalEntry} onChange={(event) => setFiscalEntry(event.target.value)} required>
            <option value="">{t("Selecione")}</option>
            {fiscalEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.description} · {formatCentsBRL(entry.amount_cents)}</option>)}
          </select>
        </label>
        <label className="text-sm">{t("Município IBGE")}
          <Input className="mt-1" inputMode="numeric" value={municipality} onChange={(event) => setMunicipality(event.target.value.replace(/\D/g, "").slice(0, 7))} pattern="[0-9]{7}" maxLength={7} required />
        </label>
        <label className="text-sm">{t("Documento")}
          <select className="mt-1 h-10 w-full rounded-md border bg-background px-2" value={fiscalKind} onChange={(event) => setFiscalKind(event.target.value as typeof fiscalKind)}>
            <option value="nfse">NFS-e</option><option value="nfe">NF-e</option>
          </select>
        </label>
        <div className="sm:col-span-3"><Button disabled={busy || !fiscalEntry || municipality.length !== 7} type="submit">{t("Registrar solicitação")}</Button></div>
      </form>}
      <ul className="mt-4 space-y-1 text-sm" aria-label={t("Solicitações fiscais")}>
        {fiscal.map((request) => <li key={request.id}>{request.document_kind.toUpperCase()} · {t("município")} {request.municipality_code} · {request.status}</li>)}
        {fiscal.length === 0 && <li className="text-muted-foreground">{t("Nenhuma solicitação fiscal registrada.")}</li>}
      </ul>
    </section>

    <section className="rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="financeiro-anexos">
      <h2 id="financeiro-anexos" className="font-semibold">{t("Anexos privados")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("PDF, PNG ou JPEG de até 10 MB. Os arquivos ficam vinculados ao lançamento e não são públicos.")}</p>
      <label className="mt-4 block text-sm">{t("Lançamento")}
        <select className="mt-1 block h-10 w-full rounded-md border bg-background px-2" value={documentEntry} onChange={(event) => selectDocumentEntry(event.target.value)}>
          <option value="">{t("Selecione")}</option>
          {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.description} · {formatCentsBRL(entry.amount_cents)}</option>)}
        </select>
      </label>
      <form onSubmit={uploadDocument} className="mt-4 flex flex-wrap items-end gap-2">
        <label className="min-w-56 flex-1 text-sm">{t("PDF ou imagem")}
          <Input ref={documentFileRef} className="mt-1" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(event) => selectDocumentFile(event.target.files?.[0] ?? null)} required />
        </label>
        <Button type="submit" disabled={busy || !documentEntry || !documentFile}>{t("Anexar")}</Button>
      </form>
      {documentEntry && documents.length === 0 && <p className="mt-4 text-sm text-muted-foreground">{t("Nenhum anexo neste lançamento.")}</p>}
      <ul className="mt-4 space-y-2 text-sm" aria-label={t("Anexos do lançamento")}>
        {documents.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
          <span>{item.file_name} · {formatBytes(item.size_bytes)}</span>
          <span className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => openDocument(item)}>{t("Abrir")}</Button>{podeAprovar && <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => deleteDocument(item)}>{t("Excluir")}</Button>}</span>
        </li>)}
      </ul>
    </section>
  </div>;
}
