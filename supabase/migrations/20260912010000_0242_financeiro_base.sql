-- 0242 — FinanceIRO operacional, separado do Billing da instalação.
-- Registra obrigações e recebíveis; nunca executa pagamento, estorno ou transferência.
create table if not exists public.finance_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  direction text not null check (direction in ('receivable', 'payable')),
  status text not null default 'open' check (status in ('open', 'settled', 'cancelled')),
  description text not null check (length(btrim(description)) between 2 and 200),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 999999999999),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  due_date date not null,
  notes text check (notes is null or length(notes) <= 1000),
  source text not null default 'manual' check (source in ('manual', 'agent_proposal', 'import', 'integration')),
  settled_amount_cents bigint check (settled_amount_cents is null or settled_amount_cents > 0),
  settled_at timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  approved_by_user_id uuid references auth.users(id) on delete set null,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_entries_estado_coerente check (
    (status = 'settled' and settled_amount_cents is not null and settled_at is not null and approved_by_user_id is not null)
    or (status in ('open', 'cancelled') and settled_amount_cents is null and settled_at is null and approved_by_user_id is null)
  )
);

create index if not exists finance_entries_org_status_due_idx
  on public.finance_entries (organization_id, status, due_date);
create index if not exists finance_entries_org_settled_idx
  on public.finance_entries (organization_id, settled_at) where status = 'settled';

alter table public.finance_entries enable row level security;

drop policy if exists finance_entries_select on public.finance_entries;
create policy finance_entries_select on public.finance_entries for select to authenticated using (
  public.fn_is_platform_admin()
  or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))
);

drop policy if exists finance_entries_insert on public.finance_entries;
create policy finance_entries_insert on public.finance_entries for insert to authenticated with check (
  public.fn_is_platform_admin()
  or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))
);

drop policy if exists finance_entries_support_insert on public.finance_entries;
create policy finance_entries_support_insert on public.finance_entries as restrictive for insert to authenticated
  with check (public.fn_support_write_allowed(organization_id));

drop policy if exists finance_entries_update on public.finance_entries;
create policy finance_entries_update on public.finance_entries for update to authenticated using (
  public.fn_is_platform_admin()
  or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'admin'))
) with check (
  public.fn_is_platform_admin()
  or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'admin'))
);

revoke all on public.finance_entries from anon;
revoke all on public.finance_entries from authenticated;
-- Toda mutação atravessa a API server-side: criação valida campos explícitos;
-- transições exigem admin, MFA, confirmação e revisão. JWT só recebe leitura.
grant select on public.finance_entries to authenticated;
grant all on public.finance_entries to service_role;

drop trigger if exists trg_finance_entries_updated_at on public.finance_entries;
create trigger trg_finance_entries_updated_at before update on public.finance_entries
  for each row execute function public.fn_set_updated_at();

comment on table public.finance_entries is
  'Contas a pagar e receber do negócio. Registro operacional; não autoriza nem executa movimentação financeira.';
comment on column public.finance_entries.approved_by_user_id is
  'Pessoa administradora que confirmou a baixa. Agentes podem propor lançamentos, nunca aprovar movimentações.';

notify pgrst, 'reload schema';
