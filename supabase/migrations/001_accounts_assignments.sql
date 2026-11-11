-- Centro de Estudos Virtus — módulo 1
-- Contas, inscrições e atribuições professor–aluno–disciplina.
--
-- Execute primeiro em homologação. Esta migração não apaga course_state nem
-- ficheiros existentes; o estado histórico será migrado por módulo.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- A conta continua a ter exactamente o mesmo UUID, username e credenciais.
-- A restrição é removida antes da conversão para não provocar erro 23514.
alter table public.profiles
  drop constraint if exists profiles_role_check;

update public.profiles
set role = 'admin_teacher'
where role = 'teacher_admin';

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin_teacher', 'teacher', 'secretary', 'student'));

alter table public.profiles
  add column if not exists is_active boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

-- Apenas arquivo técnico: nunca é exposto por PostgREST nem por políticas RLS.
create table if not exists private.legacy_course_state_archive (
  id uuid primary key default gen_random_uuid(),
  source_revision timestamptz,
  state jsonb not null,
  archived_at timestamptz not null default now(),
  archived_by uuid references public.profiles(id)
);
revoke all on table private.legacy_course_state_archive from public, anon, authenticated;

insert into private.legacy_course_state_archive (source_revision, state)
select updated_at, state
from public.course_state
where id = true
  and not exists (select 1 from private.legacy_course_state_archive);

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name)
);

create table if not exists public.student_enrollments (
  student_id uuid primary key references public.profiles(id) on delete restrict,
  active boolean not null default true,
  enrolled_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= enrolled_at)
);

-- Todos os alunos já existentes ficam inscritos sem alterar UUID, username,
-- credenciais ou histórico. Apenas associações pedagógicas exigem confirmação
-- humana porque course_state não traz disciplina e professor por aluno.
insert into public.student_enrollments (student_id, active)
select id, true
from public.profiles
where role = 'student'
on conflict (student_id) do nothing;

create table if not exists public.teacher_student_subject_assignments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  is_primary boolean not null default false,
  starts_on date not null default current_date,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  unique (teacher_id, student_id, subject_id, starts_on)
);

create index if not exists assignment_teacher_active_idx
  on public.teacher_student_subject_assignments (teacher_id, student_id, subject_id)
  where ends_on is null;

create index if not exists assignment_student_active_idx
  on public.teacher_student_subject_assignments (student_id, subject_id, teacher_id)
  where ends_on is null;

create unique index if not exists assignment_one_open_primary_idx
  on public.teacher_student_subject_assignments (student_id, subject_id)
  where is_primary = true and ends_on is null;

-- Impede ligações inválidas, mesmo quando uma chamada tenta forjar IDs.
create or replace function private.validate_assignment_roles()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  teacher_role text;
  student_role text;
begin
  select role into teacher_role from public.profiles where id = new.teacher_id;
  select role into student_role from public.profiles where id = new.student_id;
  if teacher_role not in ('admin_teacher', 'teacher') then
    raise exception 'ASSIGNMENT_TEACHER_ROLE_INVALID' using errcode = '23514';
  end if;
  if student_role <> 'student' then
    raise exception 'ASSIGNMENT_STUDENT_ROLE_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists teacher_student_subject_assignment_roles on public.teacher_student_subject_assignments;
create trigger teacher_student_subject_assignment_roles
before insert or update of teacher_id, student_id
on public.teacher_student_subject_assignments
for each row execute function private.validate_assignment_roles();

create or replace function private.validate_enrollment_role()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if (select role from public.profiles where id = new.student_id) <> 'student' then
    raise exception 'ENROLLMENT_STUDENT_ROLE_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists student_enrollment_role on public.student_enrollments;
create trigger student_enrollment_role
before insert or update of student_id
on public.student_enrollments
for each row execute function private.validate_enrollment_role();

create or replace function private.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public, private
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function private.is_admin_teacher()
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select private.current_profile_role() = 'admin_teacher'
$$;

create or replace function private.has_active_assignment(p_student_id uuid, p_subject_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.teacher_student_subject_assignments a
    where a.teacher_id = auth.uid()
      and a.student_id = p_student_id
      and a.subject_id = p_subject_id
      and a.starts_on <= current_date
      and (a.ends_on is null or a.ends_on >= current_date)
  )
$$;

revoke all on function private.current_profile_role() from public, anon;
revoke all on function private.is_admin_teacher() from public, anon;
revoke all on function private.has_active_assignment(uuid, uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_profile_role() to authenticated;
grant execute on function private.is_admin_teacher() to authenticated;
grant execute on function private.has_active_assignment(uuid, uuid) to authenticated;

-- Profiles remain minimised: browser clients see only their own profile.
alter table public.profiles enable row level security;
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
for select to authenticated using (id = auth.uid());

alter table public.subjects enable row level security;
drop policy if exists subjects_read_active on public.subjects;
create policy subjects_read_active on public.subjects
for select to authenticated using (active = true or private.is_admin_teacher());
drop policy if exists subjects_admin_manage on public.subjects;
create policy subjects_admin_manage on public.subjects
for all to authenticated using (private.is_admin_teacher()) with check (private.is_admin_teacher());

alter table public.student_enrollments enable row level security;
drop policy if exists enrollments_read_scoped on public.student_enrollments;
create policy enrollments_read_scoped on public.student_enrollments
for select to authenticated using (
  student_id = auth.uid()
  or private.is_admin_teacher()
  or exists (
    select 1 from public.teacher_student_subject_assignments a
    where a.teacher_id = auth.uid() and a.student_id = student_enrollments.student_id
      and a.starts_on <= current_date and (a.ends_on is null or a.ends_on >= current_date)
  )
);
drop policy if exists enrollments_admin_manage on public.student_enrollments;
create policy enrollments_admin_manage on public.student_enrollments
for all to authenticated using (private.is_admin_teacher()) with check (private.is_admin_teacher());

alter table public.teacher_student_subject_assignments enable row level security;
drop policy if exists assignments_read_scoped on public.teacher_student_subject_assignments;
create policy assignments_read_scoped on public.teacher_student_subject_assignments
for select to authenticated using (
  teacher_id = auth.uid() or student_id = auth.uid() or private.is_admin_teacher()
);
drop policy if exists assignments_admin_manage on public.teacher_student_subject_assignments;
create policy assignments_admin_manage on public.teacher_student_subject_assignments
for all to authenticated using (private.is_admin_teacher()) with check (private.is_admin_teacher());

-- A concessão de leitura não substitui RLS: cada linha continua limitada pelas
-- políticas acima. Escritas continuam reservadas às rotas Vercel autenticadas.
grant select on table public.profiles, public.subjects, public.student_enrollments,
  public.teacher_student_subject_assignments to authenticated;

commit;
