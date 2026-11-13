-- Centro de Estudos Virtus — operações da secretaria e simplificação de perfis
--
-- Pré-requisito: executar APÓS 009_full_schema_recovery.sql.
-- Esta migração é idempotente. Não armazena palavras-passe em texto simples:
-- a senha temporária só é conhecida no momento do provisionamento pela API
-- administrativa e é obrigatoriamente trocada no primeiro acesso.

begin;

create extension if not exists pgcrypto;
create schema if not exists private;

-- Falhar cedo em vez de criar uma arquitectura paralela sem perfis.
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'A tabela public.profiles não existe. Execute primeiro 009_full_schema_recovery.sql.';
  end if;
end $$;

-- Funções de autorização utilizadas pelas políticas abaixo. A instalação é
-- repetível e aceita o papel histórico teacher_admin durante uma transição.
create or replace function private.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public, private
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function private.is_management()
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce(private.current_profile_role() in ('admin_teacher','teacher_admin','secretary'), false)
$$;

create or replace function private.is_teacher_account()
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce(private.current_profile_role() in ('admin_teacher','teacher_admin','teacher'), false)
$$;

create or replace function private.is_admin_teacher()
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce(private.current_profile_role() in ('admin_teacher','teacher_admin'), false)
$$;

create or replace function private.teacher_has_active_assignment(p_student_id uuid, p_subject_id uuid)
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

revoke all on function private.current_profile_role() from public;
revoke all on function private.is_management() from public;
revoke all on function private.is_teacher_account() from public;
revoke all on function private.is_admin_teacher() from public;
revoke all on function private.teacher_has_active_assignment(uuid, uuid) from public;
grant execute on function private.current_profile_role(), private.is_management(), private.is_teacher_account(), private.is_admin_teacher(), private.teacher_has_active_assignment(uuid, uuid) to authenticated;

-- Disciplinas: garante a estrutura usada por todas as listas e formulários.
create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subjects_name_not_blank check (length(btrim(name)) > 0)
);
alter table public.subjects add column if not exists code text;
alter table public.subjects add column if not exists active boolean not null default true;
alter table public.subjects add column if not exists created_at timestamptz not null default now();
alter table public.subjects add column if not exists updated_at timestamptz not null default now();
create unique index if not exists subjects_name_ci_uidx on public.subjects (lower(name));

-- Dados de matrícula necessários para inscrições, horários e a visão global
-- das turmas. school_year continua compatível com os registos existentes.
alter table public.student_enrollments add column if not exists class_name text;
alter table public.student_enrollments add column if not exists guardian_email text;
alter table public.student_enrollments add column if not exists updated_at timestamptz not null default now();
create index if not exists student_enrollments_class_name_idx on public.student_enrollments (class_name) where class_name is not null;

-- Materiais de preparação. Esta definição conserva os campos usados pela UI e
-- acrescenta metadados úteis à secretaria, sem sobrescrever anexos existentes.
create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  subject_id uuid references public.subjects(id) on delete set null,
  title text not null,
  description text not null default '',
  material_type text not null default 'document' check (material_type in ('video','image','document','link')),
  source_url text,
  storage_path text,
  is_published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_materials_title_not_blank check (length(btrim(title)) > 0),
  constraint study_materials_source_present check (nullif(btrim(coalesce(source_url,'')), '') is not null or nullif(btrim(coalesce(storage_path,'')), '') is not null)
);
alter table public.study_materials add column if not exists description text;
alter table public.study_materials add column if not exists material_type text not null default 'document';
alter table public.study_materials add column if not exists source_url text;
alter table public.study_materials add column if not exists storage_path text;
alter table public.study_materials add column if not exists is_published boolean not null default false;
alter table public.study_materials add column if not exists published_at timestamptz;
alter table public.study_materials add column if not exists updated_at timestamptz not null default now();

-- Horários criados pela secretaria para cada aluno/disciplina. O array usa
-- 0=domingo .. 6=sábado; a aplicação apresenta os nomes dos dias em português.
create table if not exists public.schedules (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  days_of_week smallint[] not null,
  start_time time not null,
  end_time time,
  notes text,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedules_days_not_empty check (cardinality(days_of_week) between 1 and 7),
  constraint schedules_days_valid check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  constraint schedules_time_valid check (end_time is null or end_time > start_time)
);
create index if not exists schedules_student_active_idx on public.schedules (student_id, active, start_time);
create index if not exists schedules_subject_active_idx on public.schedules (subject_id, active);

-- Relatórios semanais simplificados para a comunicação professor -> secretaria.
-- weekly_reports histórico não é removido nem alterado.
create table if not exists public.teacher_reports (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  week_start date not null,
  week_end date not null,
  lessons_count smallint not null default 0 check (lessons_count >= 0),
  topics_covered text,
  performance_summary text,
  difficulties text,
  recommendations text,
  zero_lessons_reason text,
  status text not null default 'draft' check (status in ('draft','sent','read','archived')),
  submitted_at timestamptz,
  read_at timestamptz,
  read_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teacher_reports_week_valid check (week_end >= week_start),
  constraint teacher_reports_zero_lessons_reason check (
    -- A draft can be started before the lesson count is known. Once sent,
    -- a report with no lessons must state the reason.
    status = 'draft'
    or lessons_count > 0
    or nullif(btrim(coalesce(zero_lessons_reason,'')), '') is not null
  )
);
create unique index if not exists teacher_reports_teacher_student_subject_week_uidx on public.teacher_reports (teacher_id, student_id, subject_id, week_start);
create index if not exists teacher_reports_secretary_queue_idx on public.teacher_reports (status, submitted_at desc);

-- Avisos institucionais para docentes e professores administradores.
create table if not exists public.notices (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete restrict,
  title text not null,
  body text not null,
  audience text not null default 'teachers' check (audience in ('teachers','admin_teachers','all_staff')),
  is_published boolean not null default true,
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notices_title_not_blank check (length(btrim(title)) > 0),
  constraint notices_body_not_blank check (length(btrim(body)) > 0),
  constraint notices_expiry_valid check (expires_at is null or published_at is null or expires_at > published_at)
);
create index if not exists notices_published_idx on public.notices (is_published, published_at desc);

-- Registo de provisionamento/validação. Nunca guardar a palavra-passe real:
-- o painel mostra o estado da senha temporária, e a API devolve-a uma única vez
-- apenas à secretária que criou a conta.
create table if not exists public.onboarding_credentials (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null unique references public.profiles(id) on delete cascade,
  username text not null,
  virtual_email text not null,
  guardian_email text,
  credential_status text not null default 'created' check (credential_status in ('created','delivered','validated','password_changed','disabled')),
  temporary_password_issued_at timestamptz not null default now(),
  temporary_password_last4 text,
  delivered_at timestamptz,
  delivered_by uuid references public.profiles(id) on delete set null,
  validated_at timestamptz,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_credentials_username_not_blank check (length(btrim(username)) > 0),
  constraint onboarding_credentials_email_valid check (position('@' in virtual_email) > 1)
);
create unique index if not exists onboarding_credentials_username_ci_uidx on public.onboarding_credentials (lower(username));
create unique index if not exists onboarding_credentials_virtual_email_ci_uidx on public.onboarding_credentials (lower(virtual_email));

-- Função única para timestamps das novas entidades.
create or replace function private.touch_centro_operation_updated_at()
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
revoke all on function private.touch_centro_operation_updated_at() from public;

do $$
declare t text;
begin
  foreach t in array array['subjects','study_materials','student_enrollments','schedules','teacher_reports','notices','onboarding_credentials'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at_010', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.touch_centro_operation_updated_at()', t || '_touch_updated_at_010', t);
  end loop;
end $$;

-- A visão alimenta “Turmas inscritas” sem expor alunos fora do âmbito RLS.
create or replace view public.enrolled_class_overview
with (security_invoker = true)
as
select
  a.teacher_id,
  teacher.full_name as teacher_name,
  coalesce(nullif(btrim(e.class_name),''), nullif(btrim(e.school_year),''), 'Sem turma') as class_name,
  count(distinct a.student_id)::integer as student_count
from public.teacher_student_subject_assignments a
join public.profiles teacher on teacher.id = a.teacher_id
join public.student_enrollments e on e.student_id = a.student_id
where a.starts_on <= current_date
  and (a.ends_on is null or a.ends_on >= current_date)
group by a.teacher_id, teacher.full_name, coalesce(nullif(btrim(e.class_name),''), nullif(btrim(e.school_year),''), 'Sem turma');
grant select on public.enrolled_class_overview to authenticated;

-- RLS: disciplinas e materiais. Management inclui secretary, admin_teacher e o
-- papel de transição teacher_admin. Professores só escrevem os seus materiais.
alter table public.subjects enable row level security;
drop policy if exists subjects_read_authenticated_010 on public.subjects;
create policy subjects_read_authenticated_010 on public.subjects for select to authenticated using (active or private.is_management() or private.is_teacher_account());
drop policy if exists subjects_management_write_010 on public.subjects;
create policy subjects_management_write_010 on public.subjects for all to authenticated using (private.is_management()) with check (private.is_management());

alter table public.study_materials enable row level security;
drop policy if exists study_materials_management_all_010 on public.study_materials;
create policy study_materials_management_all_010 on public.study_materials for all to authenticated using (private.is_management()) with check (private.is_management());

-- Horários: aluno lê os seus; professor lê apenas a disciplina/aluno atribuídos;
-- secretaria/administração têm CRUD completo.
alter table public.schedules enable row level security;
drop policy if exists schedules_management_all_010 on public.schedules;
create policy schedules_management_all_010 on public.schedules for all to authenticated using (private.is_management()) with check (private.is_management());
drop policy if exists schedules_student_read_010 on public.schedules;
create policy schedules_student_read_010 on public.schedules for select to authenticated using (student_id = auth.uid());
drop policy if exists schedules_teacher_read_010 on public.schedules;
create policy schedules_teacher_read_010 on public.schedules for select to authenticated using (private.is_teacher_account() and private.teacher_has_active_assignment(student_id, subject_id));

-- Relatórios: o professor só escreve para alunos/disciplina que lhe pertencem.
alter table public.teacher_reports enable row level security;
drop policy if exists teacher_reports_management_all_010 on public.teacher_reports;
create policy teacher_reports_management_all_010 on public.teacher_reports for all to authenticated using (private.is_management()) with check (private.is_management());
drop policy if exists teacher_reports_teacher_read_own_010 on public.teacher_reports;
create policy teacher_reports_teacher_read_own_010 on public.teacher_reports for select to authenticated using (teacher_id = auth.uid());
drop policy if exists teacher_reports_teacher_insert_010 on public.teacher_reports;
create policy teacher_reports_teacher_insert_010 on public.teacher_reports for insert to authenticated with check (
  private.is_teacher_account() and teacher_id = auth.uid() and private.teacher_has_active_assignment(student_id, subject_id)
);
drop policy if exists teacher_reports_teacher_update_own_010 on public.teacher_reports;
create policy teacher_reports_teacher_update_own_010 on public.teacher_reports for update to authenticated using (teacher_id = auth.uid() and private.is_teacher_account()) with check (
  teacher_id = auth.uid() and private.is_teacher_account() and private.teacher_has_active_assignment(student_id, subject_id)
);

-- Avisos: secretaria/administração escreve; docentes leem apenas avisos publicados
-- destinados à sua função.
alter table public.notices enable row level security;
drop policy if exists notices_management_all_010 on public.notices;
create policy notices_management_all_010 on public.notices for all to authenticated using (private.is_management()) with check (private.is_management());
drop policy if exists notices_teacher_read_010 on public.notices;
create policy notices_teacher_read_010 on public.notices for select to authenticated using (
  is_published
  and (expires_at is null or expires_at > now())
  and private.is_teacher_account()
  and (audience in ('teachers','all_staff') or (audience = 'admin_teachers' and private.is_admin_teacher()))
);

-- Credenciais de inscrição: exclusivamente gestão. Não existe select para aluno
-- e não existe campo com senha em texto simples.
alter table public.onboarding_credentials enable row level security;
drop policy if exists onboarding_credentials_management_all_010 on public.onboarding_credentials;
create policy onboarding_credentials_management_all_010 on public.onboarding_credentials for all to authenticated using (private.is_management()) with check (private.is_management());

grant select, insert, update, delete on public.subjects, public.study_materials, public.schedules, public.teacher_reports, public.notices, public.onboarding_credentials to authenticated;

-- Confirma a conta de secretaria. O nome de papel canónico é secretary.
update public.profiles
   set role = 'secretary',
       is_active = true
 where lower(username) = 'secretaria.virtus'
   and role is distinct from 'secretary';

commit;

-- Verificação pós-migração (resultado esperado: todas as linhas = true).
select relation, to_regclass('public.' || relation) is not null as exists
from unnest(array[
  'subjects','study_materials','schedules','teacher_reports','notices',
  'onboarding_credentials','student_enrollments','teacher_student_subject_assignments'
]) as relation
order by relation;

select username, full_name, role, is_active,
       case when role = 'secretary' then 'OK' else 'REVER' end as secretaria_status
from public.profiles
where lower(username) = 'secretaria.virtus';
