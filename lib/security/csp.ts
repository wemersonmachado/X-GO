/** CSP de runtime: aceita o Supabase do self-host sem liberar scripts arbitrários. */
export function contentSecurityPolicy(nonce: string, supabaseUrl: string, production: boolean): string {
  const database = new URL(supabaseUrl);
  const websocket = new URL(database.origin);
  websocket.protocol = database.protocol === "https:" ? "wss:" : "ws:";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    // Radix, posicionamento e cores white-label usam style inline, não scripts inline.
    "style-src 'self' 'unsafe-inline'",
    // O Storage é configurável no self-host e o E2E o sobe em HTTP local. A
    // origem explícita mantém a exceção limitada ao Supabase desta instalação;
    // liberar `http:` aceitaria qualquer servidor HTTP da rede.
    `img-src 'self' https: ${database.origin} data: blob:`,
    "media-src 'self' https: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${database.origin} ${websocket.origin} https://*.ingest.sentry.io https://*.ingest.us.sentry.io${production ? "" : " ws: http://localhost:*"}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob: https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
  ].join("; ");
}
