import { describe, expect, it, vi } from "vitest";

import { removerContaSemAcesso } from "./remover-conta-orfa";

function cliente({ acessoAtivo = false, platformAdmin = false, deleteFails = false } = {}) {
  const deletar = vi.fn(async () => ({ error: deleteFails ? { message: "falhou" } : null }));
  const linha = (data: unknown) => {
    const b = {
      select: () => b,
      eq: () => b,
      is: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data, error: null }),
    };
    return b;
  };
  return {
    from: (table: string) => linha(table === "user_organizations" ? (acessoAtivo ? { id: "m" } : null) : (platformAdmin ? { user_id: "u" } : null)),
    auth: { admin: { deleteUser: deletar } },
    deletar,
  };
}

describe("removerContaSemAcesso", () => {
  it("remove somente a conta sem acesso e sem administração de plataforma", async () => {
    const c = cliente();
    await expect(removerContaSemAcesso(c as never, "u")).resolves.toBe("removida");
    expect(c.deletar).toHaveBeenCalledWith("u");
  });

  it.each([
    ["ainda tem outra organização", cliente({ acessoAtivo: true })],
    ["é ou foi superadministrador", cliente({ platformAdmin: true })],
    ["é a identidade protegida da operação", cliente()],
  ])("preserva quando %s", async (_caso, c) => {
    const protegidos = _caso === "é a identidade protegida da operação" ? new Set(["u"]) : new Set<string>();
    await expect(removerContaSemAcesso(c as never, "u", protegidos)).resolves.toBe("preservada");
    expect(c.deletar).not.toHaveBeenCalled();
  });
});
