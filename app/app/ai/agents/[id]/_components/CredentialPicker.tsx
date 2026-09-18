"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Trash } from "@/lib/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { AddCredentialDialog } from "../../../credentials/_components/AddCredentialDialog";
import {
  type CredentialRow,
  type Provider,
  credentialStatus,
} from "@/hooks/ai/useCredentials";

interface Props {
  provider: Provider;
  credentials: CredentialRow[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  id?: string;
  /** A instalação tem chave deste provedor no `.env`? */
  instalacaoTemChave?: boolean;
  onCredentialsChange?: (credentials: CredentialRow[]) => void;
}

export const STATUS_LABEL: Record<ReturnType<typeof credentialStatus>, string> = {
  validated: "validada",
  validating: "validando",
  unvalidated: "não validada",
  invalid: "inválida",
  inactive: "inativa",
};

/**
 * O valor que representa "a chave que veio na instalação".
 *
 * Um `<SelectItem>` não aceita valor vazio, e o vazio já significa "não
 * escolhida" no formulário — daí o token. Ele NÃO chega ao servidor: o
 * formulário o traduz em `credential_id: null`, que é o contrato da versão.
 */
export const CHAVE_DA_INSTALACAO = "__instalacao__";

export function CredentialPicker({
  provider,
  credentials,
  value,
  onChange,
  disabled,
  id,
  instalacaoTemChave = false,
  onCredentialsChange,
}: Props) {
  const t = useT();
  const filtered = credentials.filter((c) => c.provider === provider);
  // Sem nenhuma das duas origens não há o que escolher — e é aí que o atalho
  // para cadastrar precisa aparecer.
  const semOpcao = filtered.length === 0 && !instalacaoTemChave;
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const toDelete = filtered.find((c) => c.id === deleteId) ?? null;

  function removeCredential() {
    if (!toDelete) return;
    startTransition(async () => {
      try {
        await apiClient.delete(`/api/v1/ai/credentials/${toDelete.id}`);
        onCredentialsChange?.(credentials.filter((credential) => credential.id !== toDelete.id));
        if (value === toDelete.id) onChange("");
        setDeleteId(null);
        toast.success(t("Credencial removida."));
      } catch (err) {
        showApiError(err);
      }
    });
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Chave de acesso")}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={t("Escolha uma chave")} />
        </SelectTrigger>
        <SelectContent>
          {/*
            A chave do `.env` é o caso MAIS COMUM do produto — quem instala pelo
            kit cola a chave no terminal e nunca abre a tela de Credenciais. O
            runtime sempre soube usá-la; só esta tela não deixava escolhê-la, e o
            resultado era um editor onde o dono não conseguia salvar nada.
          */}
          {instalacaoTemChave ? (
            <SelectItem value={CHAVE_DA_INSTALACAO}>
              {t("A chave desta instalação")} ({provider})
            </SelectItem>
          ) : null}
          {filtered.map((c) => {
            const st = credentialStatus(c);
            return (
              <SelectItem key={c.id} value={c.id}>
                {c.label} · …{c.api_key_last4 ?? "????"} · {t(STATUS_LABEL[st])}
              </SelectItem>
            );
          })}
          {semOpcao ? (
            <SelectItem value="__none__" disabled>
              {t("Nenhuma credencial")} {provider} {t("cadastrada")}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {semOpcao ? (
        <p className="text-xs text-muted-foreground">
          <Link
            href="/app/ai/credentials"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Cadastrar credencial")} {provider}
          </Link>{" "}
          {t("na aba Credenciais.")}
        </p>
      ) : null}
      {!disabled ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs">
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => setAddOpen(true)}>
            {t("Cadastrar nova chave")}
          </Button>
          {filtered.length > 0 ? (
            <span className="text-muted-foreground">{t("Remova chaves antigas abaixo.")}</span>
          ) : null}
        </div>
      ) : null}
      {filtered.length > 0 && !disabled ? (
        <ul className="space-y-1 rounded-md border p-2 text-xs" aria-label={t("Chaves deste provedor")}>
          {filtered.map((credential) => (
            <li key={credential.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{credential.label} · …{credential.api_key_last4 ?? "????"}</span>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`${t("Excluir credencial")} ${credential.label}`} onClick={() => setDeleteId(credential.id)}>
                <Trash size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <AddCredentialDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        initialProvider={provider}
        onCreated={(credential) => {
          onCredentialsChange?.([...credentials, credential]);
          onChange(credential.id);
        }}
      />
      <AlertDialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remover credencial selecionada?")}</AlertDialogTitle>
            <AlertDialogDescription>{t("Agentes publicados que usam esta chave não podem removê-la. O sistema confirmará isso antes de excluir.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={removeCredential} disabled={pending}>{t("Remover")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function findCredential(credentials: CredentialRow[], id: string): CredentialRow | null {
  return credentials.find((c) => c.id === id) ?? null;
}
