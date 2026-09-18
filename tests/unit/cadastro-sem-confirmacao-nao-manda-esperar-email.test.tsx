import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignupForm } from "@/components/auth/SignupForm";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const signUp = vi.fn();
vi.mock("@/app/actions/auth/signUp", () => ({ signUp: (...a: unknown[]) => signUp(...a) }));

const convite = { token: "tok-123", email: "convidado@plata.test" };

async function preencherEEnviar() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^Senha$/i), "SenhaForte!2026");
  await user.type(screen.getByLabelText(/Confirmar senha/i), "SenhaForte!2026");
  await user.click(screen.getByRole("button", { name: /criar conta/i }));
}

describe("cadastro somente por convite", () => {
  beforeEach(() => {
    replace.mockClear();
    signUp.mockReset();
  });

  it("cria a sessão e segue para o aceite do mesmo convite", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    render(<SignupForm convite={convite} />);
    await preencherEEnviar();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/team/accept-invite/tok-123"),
    );
    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: convite.email }),
      convite.token,
    );
  });

  it("mantém o e-mail do convite travado", () => {
    render(<SignupForm convite={convite} />);
    const email = screen.getByLabelText(/^Email$/i);
    expect(email.getAttribute("readonly")).not.toBeNull();
    expect((email as HTMLInputElement).value).toBe(convite.email);
  });

  it("leva conta existente ao login preservando o mesmo convite", async () => {
    signUp.mockResolvedValue({ ok: false, error: "account_exists" });
    render(<SignupForm convite={convite} />);
    await preencherEEnviar();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent(`/team/accept-invite/${convite.token}`)}`,
      ),
    );
  });
});
