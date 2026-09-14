-- 0244 — Extratos assistidos, fila fiscal sem provedor e plano de contas gerencial.
create table if not exists public.finance_chart_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check (code ~ '^[0-9]+(\.[0-9]+)*$' and length(code) <= 30),
  name text not null check (length(btrim(name)) between 2 and 100),
  direction text not null check (direction in ('receivable', 'payable')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id), unique (organization_id, code)
);
alter table public.finance_entries add column if not exists chart_account_id uuid;

create table if not exists public.finance_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text not null check (length(btrim(file_name)) between 1 and 200),
  format text not null check (format in ('csv', 'ofx')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, id), unique (organization_id, account_id, file_sha256),
  foreign key (organization_id, account_id) references public.finance_accounts(organization_id, id)
);
create table if not exists public.finance_import_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null,
  account_id uuid not null,
  external_id text not null check (length(external_id) between 1 and 120),
  occurred_on date not null,
  description text not null check (length(btrim(description)) between 1 and 200),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 999999999999),
  direction text not null check (direction in ('receivable', 'payable')),
  status text not null default 'pending' check (status in ('pending', 'matched', 'ignored')),
  matched_entry_id uuid,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  unique (organization_id, id), unique (organization_id, account_id, external_id),
  foreign key (organization_id, batch_id) references public.finance_import_batches(organization_id, id) on delete cascade,
  foreign key (organization_id, account_id) references public.finance_accounts(organization_id, id),
  constraint finance_import_movement_decision check (
    (status = 'pending' and matched_entry_id is null and decided_at is null)
    or (status = 'matched' and matched_entry_id is not null and decided_at is not null)
    or (status = 'ignored' and matched_entry_id is null and decided_at is not null)
  )
);
create unique index if not exists finance_import_match_once_idx
  on public.finance_import_movements (organization_id, matched_entry_id) where matched_entry_id is not null;
create index if not exists finance_import_movements_org_batch_idx
  on public.finance_import_movements (organization_id, batch_id, occurred_on);

create table if not exists public.finance_fiscal_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entry_id uuid not null,
  country text not null default 'BR' check (country = 'BR'),
  municipality_code text not null check (municipality_code ~ '^[0-9]{7}$'),
  document_kind text not null check (document_kind in ('nfse', 'nfe')),
  status text not null default 'awaiting_provider' check (status in ('awaiting_provider', 'queued', 'submitted', 'issued', 'rejected')),
  provider_key text,
  provider_receipt text,
  idempotency_key text not null check (length(idempotency_key) between 8 and 120),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  approved_by_user_id uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id), unique (organization_id, idempotency_key),
  foreign key (organization_id, entry_id) references public.finance_entries(organization_id, id),
  constraint finance_fiscal_receipt_check check (
    (status in ('awaiting_provider', 'queued') and provider_receipt is null)
    or status in ('submitted', 'issued', 'rejected')
  )
);
create index if not exists finance_fiscal_requests_org_status_idx
  on public.finance_fiscal_requests (organization_id, status, created_at);

do $finance_0244_fks$
begin
  if not exists (select 1 from pg_constraint where conname = 'finance_entries_chart_org_fk') then
    alter table public.finance_entries add constraint finance_entries_chart_org_fk
      foreign key (organization_id, chart_account_id) references public.finance_chart_accounts(organization_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finance_import_match_org_fk') then
    alter table public.finance_import_movements add constraint finance_import_match_org_fk
      foreign key (organization_id, matched_entry_id) references public.finance_entries(organization_id, id);
  end if;
end $finance_0244_fks$;

do $finance_0244_security$
declare table_name text;
begin
  foreach table_name in array array[
    'finance_chart_accounts', 'finance_import_batches', 'finance_import_movements', 'finance_fiscal_requests'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_select', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''manager'')))',
      table_name || '_select', table_name
    );
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end $finance_0244_security$;

drop trigger if exists trg_finance_fiscal_requests_updated_at on public.finance_fiscal_requests;
create trigger trg_finance_fiscal_requests_updated_at before update on public.finance_fiscal_requests
  for each row execute function public.fn_set_updated_at();

-- Lote e movimentos nascem na mesma transação. Retry do mesmo arquivo só devolve o lote existente.
create or replace function public.fn_finance_import_statement(
  p_org uuid, p_account uuid, p_hash text, p_file_name text, p_format text,
  p_actor uuid, p_movements jsonb
) returns table (batch_id uuid, duplicate boolean, imported_count integer)
language plpgsql security invoker set search_path = '' as $import$
declare new_batch uuid; inserted_count integer;
begin
  if p_actor is null or jsonb_typeof(p_movements) <> 'array'
    or jsonb_array_length(p_movements) not between 1 and 500 then
    raise exception 'invalid_statement_import' using errcode = '22023';
  end if;
  -- Serializa por conta: a checagem de FITID e o INSERT precisam observar o mesmo estado.
  perform 1 from public.finance_accounts
    where organization_id = p_org and id = p_account and active and currency = 'BRL'
    for update;
  if not found then raise exception 'finance_account_not_found' using errcode = 'P0002'; end if;
  insert into public.finance_import_batches (
    organization_id, account_id, file_sha256, file_name, format, created_by_user_id
  ) values (p_org, p_account, p_hash, p_file_name, p_format, p_actor)
  on conflict (organization_id, account_id, file_sha256) do nothing returning id into new_batch;
  if new_batch is null then
    select id into new_batch from public.finance_import_batches
      where organization_id = p_org and account_id = p_account and file_sha256 = p_hash;
    return query select new_batch, true, 0;
    return;
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_movements) as incoming(
      external_id text, occurred_on date, description text, amount_cents bigint, direction text
    ) join public.finance_import_movements existing
      on existing.organization_id = p_org and existing.account_id = p_account
      and existing.external_id = incoming.external_id
    where (existing.occurred_on, existing.description, existing.amount_cents, existing.direction)
      is distinct from (incoming.occurred_on, incoming.description, incoming.amount_cents, incoming.direction)
  ) then
    raise exception 'statement_external_id_conflict' using errcode = '23505';
  end if;
  insert into public.finance_import_movements (
    organization_id, batch_id, account_id, external_id, occurred_on, description, amount_cents, direction
  ) select p_org, new_batch, p_account, movement.external_id, movement.occurred_on,
      movement.description, movement.amount_cents, movement.direction
    from jsonb_to_recordset(p_movements) as movement(
      external_id text, occurred_on date, description text, amount_cents bigint, direction text
    ) on conflict (organization_id, account_id, external_id) do nothing;
  get diagnostics inserted_count = row_count;
  return query select new_batch, false, inserted_count;
end $import$;
revoke execute on function public.fn_finance_import_statement(uuid, uuid, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_finance_import_statement(uuid, uuid, text, text, text, uuid, jsonb)
  to service_role;

-- A conciliação apenas vincula o movimento ao lançamento: baixa exige a aprovação existente.
create or replace function public.fn_finance_reconcile_movement(
  p_org uuid, p_movement uuid, p_entry uuid, p_action text, p_revision bigint, p_actor uuid
) returns public.finance_import_movements language plpgsql security invoker set search_path = '' as $reconcile$
declare movement public.finance_import_movements%rowtype;
  entry public.finance_entries%rowtype;
  statement_account uuid;
begin
  if p_action not in ('match', 'ignore') or p_actor is null then
    raise exception 'invalid_reconciliation' using errcode = '22023';
  end if;
  select * into movement from public.finance_import_movements
    where organization_id = p_org and id = p_movement for update;
  if not found then raise exception 'movement_not_found' using errcode = 'P0002'; end if;
  if movement.status <> 'pending' or movement.revision <> p_revision then
    raise exception 'movement_conflict' using errcode = '40001';
  end if;
  if p_action = 'match' then
    if p_entry is null then raise exception 'entry_required' using errcode = '22023'; end if;
    select * into entry from public.finance_entries where organization_id = p_org and id = p_entry for update;
    if not found then raise exception 'entry_mismatch' using errcode = '22023'; end if;
    select batch.account_id into statement_account from public.finance_import_batches batch
      where batch.organization_id = p_org and batch.id = movement.batch_id;
    if entry.direction <> movement.direction
      or coalesce(entry.settled_amount_cents, entry.amount_cents) <> movement.amount_cents
      or entry.status = 'cancelled' or entry.account_id is distinct from statement_account then
      raise exception 'entry_mismatch' using errcode = '22023';
    end if;
  elsif p_entry is not null then
    raise exception 'entry_not_allowed' using errcode = '22023';
  end if;
  update public.finance_import_movements set status = case when p_action = 'match' then 'matched' else 'ignored' end,
    matched_entry_id = p_entry, decided_by_user_id = p_actor, decided_at = now(), revision = revision + 1
    where organization_id = p_org and id = p_movement returning * into movement;
  return movement;
end $reconcile$;
revoke execute on function public.fn_finance_reconcile_movement(uuid, uuid, uuid, text, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_finance_reconcile_movement(uuid, uuid, uuid, text, bigint, uuid)
  to service_role;

-- A transição e a trava de conciliação compartilham o mesmo lock do lançamento.
create or replace function public.fn_finance_transition_entry(
  p_org uuid, p_id uuid, p_action text, p_revision bigint, p_actor uuid, p_settled_amount bigint default null
) returns public.finance_entries language plpgsql security invoker set search_path = '' as $transition$
declare entry public.finance_entries%rowtype; movement public.finance_import_movements%rowtype;
begin
  if p_action not in ('settle', 'cancel', 'reopen') or p_actor is null then
    raise exception 'invalid_finance_transition' using errcode = '22023';
  end if;
  select * into entry from public.finance_entries
    where organization_id = p_org and id = p_id for update;
  if not found then raise exception 'entry_not_found' using errcode = 'P0002'; end if;
  if entry.revision <> p_revision then raise exception 'entry_conflict' using errcode = '40001'; end if;
  if (p_action in ('settle', 'cancel') and entry.status <> 'open')
    or (p_action = 'reopen' and entry.status <> 'cancelled') then
    raise exception 'entry_state_conflict' using errcode = '40001';
  end if;
  select * into movement from public.finance_import_movements
    where organization_id = p_org and matched_entry_id = p_id for update;
  if found and p_action = 'cancel' then
    raise exception 'reconciled_entry_cannot_cancel' using errcode = '23514';
  end if;
  if found and p_action = 'settle'
    and coalesce(p_settled_amount, entry.amount_cents) <> movement.amount_cents then
    raise exception 'reconciled_amount_mismatch' using errcode = '23514';
  end if;
  if p_action = 'settle' then
    update public.finance_entries set status = 'settled',
      settled_amount_cents = coalesce(p_settled_amount, amount_cents), settled_at = now(),
      approved_by_user_id = p_actor, revision = revision + 1
      where organization_id = p_org and id = p_id returning * into entry;
  else
    update public.finance_entries set status = case when p_action = 'cancel' then 'cancelled' else 'open' end,
      settled_amount_cents = null, settled_at = null, approved_by_user_id = null, revision = revision + 1
      where organization_id = p_org and id = p_id returning * into entry;
  end if;
  return entry;
end $transition$;
revoke execute on function public.fn_finance_transition_entry(uuid, uuid, text, bigint, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_finance_transition_entry(uuid, uuid, text, bigint, uuid, bigint)
  to service_role;

-- Classificação e conta bancária compartilham a trava usada pela conciliação.
create or replace function public.fn_finance_classify_entry(
  p_org uuid, p_id uuid, p_revision bigint, p_actor uuid,
  p_chart_account uuid, p_competence_date date, p_account uuid
) returns public.finance_entries language plpgsql security invoker set search_path = '' as $classify$
declare entry public.finance_entries%rowtype;
begin
  if p_actor is null then raise exception 'invalid_finance_classification' using errcode = '22023'; end if;
  select * into entry from public.finance_entries
    where organization_id = p_org and id = p_id for update;
  if not found then raise exception 'entry_not_found' using errcode = 'P0002'; end if;
  if entry.revision <> p_revision then raise exception 'entry_conflict' using errcode = '40001'; end if;
  if entry.status = 'cancelled' then raise exception 'cancelled_entry' using errcode = '23514'; end if;
  if p_chart_account is not null and not exists (
    select 1 from public.finance_chart_accounts
      where organization_id = p_org and id = p_chart_account and active and direction = entry.direction
  ) then raise exception 'invalid_chart_account' using errcode = '23503'; end if;
  if p_account is not null and not exists (
    select 1 from public.finance_accounts
      where organization_id = p_org and id = p_account and active and currency = entry.currency
  ) then raise exception 'invalid_finance_account' using errcode = '23503'; end if;
  if p_account is distinct from entry.account_id and exists (
    select 1 from public.finance_import_movements
      where organization_id = p_org and matched_entry_id = p_id and status = 'matched'
  ) then raise exception 'reconciled_account_locked' using errcode = '23514'; end if;
  update public.finance_entries set chart_account_id = p_chart_account,
    competence_date = p_competence_date, account_id = p_account, revision = revision + 1
    where organization_id = p_org and id = p_id returning * into entry;
  return entry;
end $classify$;
revoke execute on function public.fn_finance_classify_entry(uuid, uuid, bigint, uuid, uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_finance_classify_entry(uuid, uuid, bigint, uuid, uuid, date, uuid)
  to service_role;
notify pgrst, 'reload schema';
