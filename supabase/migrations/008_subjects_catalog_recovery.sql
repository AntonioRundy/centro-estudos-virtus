-- Centro de Estudos Virtus — recuperação do catálogo de disciplinas.
-- Seguro para executar mais de uma vez.

begin;

create schema if not exists private;

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Também corrige instalações onde uma versão incompleta da tabela existia.
alter table public.subjects
  add column if not exists active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists subjects_active_name_idx
  on public.subjects (name)
  where active = true;

create or replace function private.can_manage_subjects()
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('admin_teacher', 'teacher_admin', 'teacher', 'secretary')
  );
$$;

create or replace function private.touch_subject_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subjects_set_updated_at on public.subjects;
create trigger subjects_set_updated_at
before update on public.subjects
for each row execute function private.touch_subject_updated_at();

alter table public.subjects enable row level security;

drop policy if exists subjects_read_active on public.subjects;
drop policy if exists subjects_catalog_read on public.subjects;
create policy subjects_catalog_read
on public.subjects
for select
to authenticated
using (active = true or private.can_manage_subjects());

drop policy if exists subjects_admin_manage on public.subjects;
drop policy if exists subjects_catalog_insert on public.subjects;
create policy subjects_catalog_insert
on public.subjects
for insert
to authenticated
with check (private.can_manage_subjects());

drop policy if exists subjects_catalog_update on public.subjects;
create policy subjects_catalog_update
on public.subjects
for update
to authenticated
using (private.can_manage_subjects())
with check (private.can_manage_subjects());

-- A remoção física fica limitada à coordenação; disciplinas antigas podem ser
-- apenas marcadas como inativas por professores ou secretária.
drop policy if exists subjects_catalog_delete on public.subjects;
create policy subjects_catalog_delete
on public.subjects
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('admin_teacher', 'teacher_admin', 'secretary')
  )
);

grant usage on schema private to authenticated;
grant execute on function private.can_manage_subjects() to authenticated;
grant select, insert, update, delete on public.subjects to authenticated;

-- Catálogo inicial necessário às contas já provisionadas.
insert into public.subjects (name, active)
values ('Matemática', true)
on conflict (name) do update
set active = true,
    updated_at = now();

commit;
