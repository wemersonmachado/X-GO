import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanCta } from "./PlanCta";

describe("CTA de contratação", () => {
  it.each(["Standard", "Pro", "Enterprise"])("leva %s ao checkout configurado", name => {
    const html = renderToStaticMarkup(<PlanCta name={name} destination="/#planos" />);
    expect(html).toContain(`Contratar ${name}`);
    expect(html).toContain('action="/#planos"');
    expect(html).toContain('method="post"');
    expect(html).toMatch(/name="intent_key"[^>]+value="[0-9a-f-]{36}"/);
    expect(html).not.toContain("WhatsApp");
  });
  it("explica quando o checkout ainda não foi sincronizado", () => {
    const html = renderToStaticMarkup(<PlanCta name="Standard" destination="" />);
    expect(html).toContain("Checkout temporariamente indisponível.");
    expect(html).toContain("Nenhuma cobrança foi realizada.");
    expect(html).not.toContain("href=");
  });
  it("aceita o destino de contratação configurado pelo administrador", () => {
    const html = renderToStaticMarkup(<PlanCta name="Pro" destination="/checkout" />);
    expect(html).toContain('action="/checkout"');
    expect(html).toContain("Contratar Pro");
    expect(html).not.toContain("<details");
  });
});
