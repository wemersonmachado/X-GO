-- 0243 — Cadastros financeiros e delegação por proposta, sem execução automática.
-- A pessoa escolhe o escopo por agente; ausência de permissão significa desabilitado.

create unique index if not exists finance_ai_agents_org_id_idx on public.ai_agents (organization_id, id);

create table if not exists public.finance_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 100),
  direction text not null check (direction in ('receivable', 'payable')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index if not exists finance_categories_org_direction_name_idx
  on public.finance_categories (organization_id, direction, lower(name));

create table if not exists public.finance_cost_centers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index if not exists finance_cost_centers_org_name_idx
  on public.finance_cost_centers (organization_id, lower(name));

create table if not exists public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 100),
  kind text not null check (kind in ('cash', 'bank', 'other')),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index if not exists finance_accounts_org_name_idx
  on public.finance_accounts (organization_id, lower(name));

alter table public.finance_entries
  add column if not exists category_id uuid,
  add column if not exists cost_center_id uuid,
  add column if not exists account_id uuid,
  add column if not exists competence_date date;

create table if not exists public.finance_agent_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null,
  operation text not null check (operation in ('entry', 'payment', 'refund', 'discount', 'transfer', 'commitment')),
  mode text not null check (mode = 'propose'),
  max_amount_cents bigint check (max_amount_cents is null or max_amount_cents > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, agent_id, operation),
  foreign key (organization_id, agent_id) references public.ai_agents(organization_id, id) on delete cascade
);

create table if not exists public.finance_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null,
  operation text not null check (operation in ('entry', 'payment', 'refund', 'discount', 'transfer', 'commitment')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'executed', 'failed')),
  description text not null check (length(btrim(description)) between 2 and 200),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 999999999999),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  direction text check (direction in ('receivable', 'payable')),
  due_date date,
  evidence_note text check (evidence_note is null or length(evidence_note) <= 1000),
  source_request_id text not null check (length(source_request_id) between 1 and 100),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  approved_by_user_id uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  resulting_entry_id uuid references public.finance_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, agent_id) references public.ai_agents(organization_id, id) on delete cascade,
  constraint finance_proposals_entry_fields check (
    operation <> 'entry' or (direction is not null and due_date is not null)
  ),
  constraint finance_proposals_approval_consistent check (
    (status in ('pending', 'rejected') and approved_by_user_id is null and approved_at is null)
    or (status in ('approved', 'executed', 'failed') and approved_at is not null)
  )
);
create index if not exists finance_proposals_org_status_idx
  on public.finance_proposals (organization_id, status, created_at desc);
create unique index if not exists finance_proposals_retry_idx
  on public.finance_proposals (organization_id, agent_id, source_request_id, request_fingerprint);

create table if not exists public.finance_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entry_id uuid,
  proposal_id uuid,
  storage_path text not null,
  file_name text not null check (length(btrim(file_name)) between 1 and 200),
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, storage_path),
  foreign key (organization_id, proposal_id) references public.finance_proposals(organization_id, id) on delete cascade,
  constraint finance_documents_single_owner check ((entry_id is not null) <> (proposal_id is not null))
);

create unique index if not exists finance_entries_org_id_idx on public.finance_entries (organization_id, id);

do $finance_fks$
begin
  if not exists (select 1 from pg_constraint where conname = 'finance_entries_category_org_fk') then
    alter table public.finance_entries add constraint finance_entries_category_org_fk
      foreign key (organization_id, category_id) references public.finance_categories(organization_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finance_entries_cost_center_org_fk') then
    alter table public.finance_entries add constraint finance_entries_cost_center_org_fk
      foreign key (organization_id, cost_center_id) references public.finance_cost_centers(organization_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finance_entries_account_org_fk') then
    alter table public.finance_entries add constraint finance_entries_account_org_fk
      foreign key (organization_id, account_id) references public.finance_accounts(organization_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finance_documents_entry_org_fk') then
    alter table public.finance_documents add constraint finance_documents_entry_org_fk
      foreign key (organization_id, entry_id) references public.finance_entries(organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'finance_proposals_result_org_fk') then
    alter table public.finance_proposals add constraint finance_proposals_result_org_fk
      foreign key (organization_id, resulting_entry_id) references public.finance_entries(organization_id, id) on delete set null (resulting_entry_id);
  end if;
end $finance_fks$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-documents', 'finance-documents', false, 10485760,
  array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
-- Sem policy em storage.objects: upload e download passam por API autenticada e service_role.

do $finance_security$
declare table_name text;
begin
  foreach table_name in array array[
    'finance_categories', 'finance_cost_centers', 'finance_accounts',
    'finance_agent_permissions', 'finance_proposals', 'finance_documents'
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
end $finance_security$;

drop trigger if exists trg_finance_agent_permissions_updated_at on public.finance_agent_permissions;
create trigger trg_finance_agent_permissions_updated_at before update on public.finance_agent_permissions
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_finance_proposals_updated_at on public.finance_proposals;
create trigger trg_finance_proposals_updated_at before update on public.finance_proposals
  for each row execute function public.fn_set_updated_at();

comment on table public.finance_agent_permissions is
  'A ausência de permissão proíbe a proposta. O único modo disponível exige aprovação humana.';
comment on table public.finance_proposals is
  'Pedidos do agente são propostas sem efeito externo; executor de conector exige aprovação e recibo.';

create or replace function public.fn_finance_decide_proposal(
  p_org uuid, p_id uuid, p_action text, p_revision bigint, p_actor uuid
) returns public.finance_proposals language plpgsql security invoker set search_path = '' as $decide$
declare
  proposal public.finance_proposals%rowtype;
  entry_id uuid;
begin
  if p_action not in ('approve', 'reject') or p_actor is null then
    raise exception 'invalid_finance_decision' using errcode = '22023';
  end if;
  select * into proposal from public.finance_proposals
    where organization_id = p_org and id = p_id for update;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0002'; end if;
  if proposal.status <> 'pending' or proposal.revision <> p_revision then
    raise exception 'proposal_conflict' using errcode = '40001';
  end if;
  if p_action = 'approve' then
    if not exists (
      select 1 from public.finance_agent_permissions permission
       where permission.organization_id = p_org and permission.agent_id = proposal.agent_id
         and permission.operation = proposal.operation
         and (permission.max_amount_cents is null or proposal.amount_cents <= permission.max_amount_cents)
    ) then raise exception 'agent_permission_revoked' using errcode = '42501'; end if;
    if proposal.operation = 'entry' then
      insert into public.finance_entries (
        organization_id, direction, description, amount_cents, currency, due_date,
        notes, source, created_by_user_id
      ) values (
        p_org, proposal.direction, proposal.description, proposal.amount_cents,
        proposal.currency, proposal.due_date, proposal.evidence_note, 'agent_proposal', p_actor
      ) returning id into entry_id;
    end if;
    update public.finance_proposals set status = 'approved', approved_by_user_id = p_actor,
      approved_at = now(), resulting_entry_id = entry_id, revision = revision + 1
      where organization_id = p_org and id = p_id returning * into proposal;
  else
    update public.finance_proposals set status = 'rejected', revision = revision + 1
      where organization_id = p_org and id = p_id returning * into proposal;
  end if;
  return proposal;
end $decide$;
revoke execute on function public.fn_finance_decide_proposal(uuid, uuid, text, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_finance_decide_proposal(uuid, uuid, text, bigint, uuid)
  to service_role;
notify pgrst, 'reload schema';
