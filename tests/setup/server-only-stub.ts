// Substitui "server-only" nos testes. O pacote real lança incondicionalmente
// fora do bundler do Next (que intercepta o import e o transforma em no-op só
// em Server Component); no Vite puro do vitest ele sempre estoura. Sem este
// alias, todo módulo com `import "server-only"` — asaas.ts, paid-access.ts,
// stripe.ts — nunca poderia ser importado diretamente por um teste.
export {};
