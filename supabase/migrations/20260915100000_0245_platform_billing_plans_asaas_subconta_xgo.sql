-- RASCUNHO — NÃO APLICAR AINDA.
--
-- Repointe de platform_billing_plans para os links criados na subconta/conta
-- Asaas EXCLUSIVA do X-GO (hoje X-GO e Paint Inspector Pro compartilham a
-- mesma conta Asaas — ver docs/runbooks/asaas.md, seção "Migração para
-- subconta Asaas exclusiva (X-GO)").
--
-- Os valores <PREENCHER_...> abaixo só existem depois que:
--   1. o dono do produto criar a subconta/conta Asaas nova no painel (passo
--      manual, não automatizável — ver runbook);
--   2. `scripts/migrar-asaas-xgo-subconta.ts` rodar com a API key e o
--      webhook token dessa conta nova e IMPRIMIR os IDs reais dos 3 links.
--
-- Cole os IDs impressos pelo script no lugar dos placeholders, apague o
-- bloco de guarda (`do $$ ... end $$;`) e só então:
--   a) renomeie o timestamp deste arquivo para o próximo sequencial LIVRE em
--      `supabase/migrations/` no momento da aplicação (outra sessão pode ter
--      ocupado 0245 nesse meio-tempo — confira com `ls supabase/migrations`);
--   b) registre a linha correspondente em `supabase/migrations/MANIFEST.md`
--      (tabela "Applied") — só depois de aplicar, nunca antes;
--   c) reflita este UPDATE no apêndice idempotente de `supabase/baseline.sql`
--      (ver doutrina de migrations no CLAUDE.md) — sem isso, clones self-host
--      recém-instalados não recebem os IDs novos;
--   d) republique a landing (Configurações › Landing page › Salvar e
--      publicar) para que `platform_branding.landing_page.plans[]` também
--      reflita os novos payment_link_id/checkout_url.
--
-- Guarda: se este arquivo for aplicado por engano ANTES do passo 2, a
-- transação inteira falha em vez de gravar placeholder como se fosse um ID
-- real do Asaas.
do $$
begin
  if exists (
    select 1 from (values
      ('PREENCHER_APOS_MIGRACAO_asaas_link_id_standard'),
      ('PREENCHER_APOS_MIGRACAO_asaas_link_id_pro'),
      ('PREENCHER_APOS_MIGRACAO_asaas_link_id_enterprise')
    ) as placeholder(v)
    where placeholder.v in (
      'PREENCHER_APOS_MIGRACAO_asaas_link_id_standard',
      'PREENCHER_APOS_MIGRACAO_asaas_link_id_pro',
      'PREENCHER_APOS_MIGRACAO_asaas_link_id_enterprise'
    )
  ) then
    raise exception
      'Migration 0245 é rascunho: substitua os placeholders pelos IDs reais retornados por scripts/migrar-asaas-xgo-subconta.ts antes de aplicar.';
  end if;
end $$;

update public.platform_billing_plans
   set asaas_payment_link_id = 'PREENCHER_APOS_MIGRACAO_asaas_link_id_standard',
       checkout_url = 'PREENCHER_APOS_MIGRACAO_asaas_checkout_url_standard',
       synced_at = now(),
       sync_error = null
 where slug = 'standard';

update public.platform_billing_plans
   set asaas_payment_link_id = 'PREENCHER_APOS_MIGRACAO_asaas_link_id_pro',
       checkout_url = 'PREENCHER_APOS_MIGRACAO_asaas_checkout_url_pro',
       synced_at = now(),
       sync_error = null
 where slug = 'pro';

update public.platform_billing_plans
   set asaas_payment_link_id = 'PREENCHER_APOS_MIGRACAO_asaas_link_id_enterprise',
       checkout_url = 'PREENCHER_APOS_MIGRACAO_asaas_checkout_url_enterprise',
       synced_at = now(),
       sync_error = null
 where slug = 'enterprise';

notify pgrst, 'reload schema';
