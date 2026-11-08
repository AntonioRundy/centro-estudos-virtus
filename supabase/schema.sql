-- Centro de Estudos e Explicações Virtus: contas e estado do centro.
-- Executar no SQL Editor do projecto Supabase Centro Virtus antes do primeiro acesso.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  full_name text not null,
  role text not null check (role in ('teacher_admin', 'teacher', 'student')),
  must_change_password boolean not null default false,
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists is_superadmin boolean not null default false;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('teacher_admin', 'teacher', 'student'));

-- teacher_admin is the only role with administrative powers.  The first account
-- is created through the one-time bootstrap route; subsequent accounts are
-- created through /admin/provisioning by a signed-in teacher_admin.

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
