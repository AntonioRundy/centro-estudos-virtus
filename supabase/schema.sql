-- Sala Virtus: contas fechadas e estado partilhado da turma.
-- Executar no SQL Editor do projecto Supabase antes de provisionar as contas.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  full_name text not null,
  role text not null check (role in ('teacher', 'student')),
  must_change_password boolean not null default false,
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists is_superadmin boolean not null default false;

-- Bootstrap is deliberate: grant this flag only in the Supabase SQL Editor to a trusted account.
-- update public.profiles set is_superadmin = true where username = 'administrador.virtus';

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;
grant all on table public.profiles to service_role;

create table if not exists public.course_state (
  id boolean primary key default true check (id),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.course_state enable row level security;
revoke all on table public.course_state from anon, authenticated;
grant all on table public.course_state to service_role;

drop function if exists public.save_course_state(jsonb);
drop function if exists public.save_course_state(jsonb, timestamptz);

create function public.save_course_state(p_state jsonb, p_expected_updated_at timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_updated_at timestamptz;
  next_updated_at timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(20261023, 1);
  select updated_at into current_updated_at
  from public.course_state
  where id = true
  for update;

  if found then
    if p_expected_updated_at is distinct from current_updated_at then
      raise exception using errcode = '40001', message = 'STATE_CONFLICT';
    end if;
    update public.course_state
    set state = p_state, updated_at = next_updated_at
    where id = true;
  else
    if p_expected_updated_at is not null then
      raise exception using errcode = '40001', message = 'STATE_CONFLICT';
    end if;
    insert into public.course_state (id, state, updated_at)
    values (true, p_state, next_updated_at);
  end if;

  return next_updated_at;
end;
$$;

revoke all on function public.save_course_state(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.save_course_state(jsonb, timestamptz) to service_role;
