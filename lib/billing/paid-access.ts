import "server-only";

import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { marcaDaSaida } from "@/lib/branding/saida";
import { buildPaidAccessEmail } from "@/lib/email/templates/paid-access";
import { sendEmail } from "@/lib/email/resend";
import { env } from "@/lib/env";
import { INTERFACE_COMPLETA } from "@/lib/navigation/interface";
import { createAdminClient } from "@/lib/supabase/admin";

export interface PaidAccessReceipt {
  organization_id: string;
  organization_name: string;
  plan_name: string;
  invite_id: string;
  issued_at: number;
  email_sent_at: string | null;
  created: boolean;
}

export async function sendPaidAccess(input: {
  receipt: PaidAccessReceipt;
  email: string;
  requestId: string;
}): Promise<{ sent: boolean; accessUrl: string }> {
  const { receipt } = input;
  const iat = receipt.issued_at;
  const exp = iat + INVITE_TTL_SECONDS;
  const token = signInviteToken({
    invite_id: receipt.invite_id,
    email: input.email,
    organization_id: receipt.organization_id,
    role: "admin",
    exp,
    iat,
    interface_settings: INTERFACE_COMPLETA,
  });
  const accessUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;
  if (receipt.email_sent_at) return { sent: true, accessUrl };

  const marca = await marcaDaSaida(receipt.organization_id);
  const message = buildPaidAccessEmail({
    accessUrl,
    organizationName: receipt.organization_name,
    planName: receipt.plan_name,
    expiresAt: new Date(exp * 1000),
    marca,
  });
  const delivery = await sendEmail({
    to: input.email,
    ...message,
    fromName: marca.nome,
    idempotencyKey: `paid-access-${receipt.invite_id}`,
    tags: [
      { name: "kind", value: "paid_access" },
      { name: "org", value: receipt.organization_id },
    ],
  });
  if (!delivery.ok) return { sent: false, accessUrl };

  await audit({
    action: "member.invited",
    organizationId: receipt.organization_id,
    resourceType: "membership",
    resourceId: receipt.invite_id,
    requestId: input.requestId || randomUUID(),
    bypassedRls: true,
    metadata: { role: "admin", source: "confirmed_payment", email_dispatched: true },
  });
  // O marcador só avança depois do audit. Se o audit falhar, a Stripe retenta;
  // a mesma chave idempotente impede uma segunda mensagem no Resend.
  const { error: receiptError } = await createAdminClient()
    .from("platform_checkout_access" as never)
    .update({
      email_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never)
    .eq("organization_id" as never, receipt.organization_id);
  if (receiptError) return { sent: false, accessUrl };
  return { sent: true, accessUrl };
}
