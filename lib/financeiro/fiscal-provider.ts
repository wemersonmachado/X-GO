/** Contrato para um provedor fiscal do Brasil. Nenhuma implementação é registrada sem escolha do operador. */
export type FiscalRequest = {
  id: string;
  organization_id: string;
  entry_id: string;
  country: "BR";
  municipality_code: string;
  document_kind: "nfse" | "nfe";
  idempotency_key: string;
};

export type FiscalReceipt = {
  provider_key: string;
  provider_receipt: string;
  status: "submitted" | "issued" | "rejected";
};

export interface FiscalProvider {
  readonly key: string;
  supports(request: FiscalRequest): Promise<boolean>;
  submit(request: FiscalRequest): Promise<FiscalReceipt>;
  getReceipt(request: FiscalRequest): Promise<FiscalReceipt>;
}

export function resolveFiscalProvider(): FiscalProvider | null {
  // O provedor, município e credenciais ainda não foram escolhidos.
  return null;
}
