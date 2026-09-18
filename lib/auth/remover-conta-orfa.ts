import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Remove uma identidade do Auth somente quando ela realmente ficou sem acesso.
 *
 * A exclusão de uma organização já apaga os dados tenant-aware por cascade, mas
 * `auth.users` vive fora desse cascade. Sem esta etapa, o e-mail fica preso em
 * uma conta sem organização e o próximo convite o manda, incorretamente, para
 * criar conta de novo. Nunca removemos alguém que ainda tenha outra empresa ou
 * qualquer histórico de administração da plataforma.
 */
export async function removerContaSemAcesso(
  admin: SupabaseClient,
  userId: string,
  protegidos: ReadonlySet<string> = new Set(),
): Promise<"removida" | "preservada" | "falhou"> {
  if (protegidos.has(userId)) return "preservada";

  const [membership, platformAdmin] = await Promise.all([
    admin
      .from("user_organizations")
      .select("id")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle(),
    // Conservador de propósito: uma identidade que já foi admin de plataforma
    // não entra na limpeza automática, mesmo se a concessão estiver revogada.
    admin.from("platform_admins").select("user_id").eq("user_id", userId).limit(1).maybeSingle(),
  ]);

  if (membership.error || platformAdmin.error || membership.data || platformAdmin.data) {
    return "preservada";
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  return error ? "falhou" : "removida";
}
