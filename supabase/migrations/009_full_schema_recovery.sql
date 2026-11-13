-- Centro de Estudos Virtus — recuperação integral e idempotente do esquema
-- Execute UMA VEZ no SQL Editor do projecto Supabase ligado ao Vercel
-- oficial: centro-estudosvirtus.vercel.app (não usar o projecto Vercel removido).
-- Seguro para tabelas já existentes: não apaga utilizadores, perfis, dados ou ficheiros.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'A tabela public.profiles não existe. Execute primeiro a migração/base de autenticação.';
  end if;
end $$;

-- Contrato mínimo de perfil lido pelas rotas de autenticação e pelo painel.
-- As contas existentes mantêm o mesmo UUID; apenas são completadas colunas
-- ausentes. A palavra-passe nunca existe nem é alterada nesta tabela.
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists is_active boolean not null default true;
alter table public.profiles add column if not exists is_superadmin boolean not null default false;
alter table public.profiles add column if not exists must_change_password boolean not null default false;
alter table public.profiles add column if not exists school_year text;

update public.profiles p
set username = coalesce(nullif(trim(p.username), ''), lower(split_part(u.email, '@', 1)))
from auth.users u
where u.id = p.id and coalesce(nullif(trim(p.username), ''), '') = '';
update public.profiles
set full_name = coalesce(nullif(trim(full_name), ''), username, 'Utilizador'),
    role = coalesce(nullif(trim(role), ''), 'student'),
    is_active = coalesce(is_active, true),
    is_superadmin = coalesce(is_superadmin, false),
    must_change_password = coalesce(must_change_password, false);
create unique index if not exists profiles_username_ci_unique
  on public.profiles (lower(username)) where username is not null;

-- Normalização de papéis. "secretary" é o único papel da Secretaria no
-- frontend; "admin_secretary" não existe na aplicação. A operação preserva
-- todos os UUIDs e nunca cria nem remove contas do Auth.
do $$
declare
  role_constraint text;
begin
  select conname into role_constraint
  from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%role%'
  limit 1;

  if role_constraint is not null then
    execute format('alter table public.profiles drop constraint %I', role_constraint);
  end if;

  update public.profiles
     set role = 'admin_teacher'
   where role = 'teacher_admin';

  update public.profiles
     set role = 'secretary'
   where lower(username) = 'secretaria.virtus';

  alter table public.profiles
    add constraint profiles_role_check
    check (role in ('admin_teacher', 'teacher_admin', 'teacher', 'secretary', 'student'));
end $$;

-- Funções de autorização partilhadas. A coluna role já existe em profiles.
create or replace function private.current_profile_role()
returns text language sql stable security definer set search_path = public, private as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function private.is_management()
returns boolean language sql stable security definer set search_path = public, private as $$
  select private.current_profile_role() in ('admin_teacher', 'teacher_admin', 'secretary')
$$;

create or replace function private.is_teacher_account()
returns boolean language sql stable security definer set search_path = public, private as $$
  select private.current_profile_role() in ('admin_teacher', 'teacher_admin', 'teacher')
$$;

create or replace function private.is_admin_teacher()
returns boolean language sql stable security definer set search_path = public, private as $$
  select private.current_profile_role() in ('admin_teacher', 'teacher_admin')
$$;

revoke all on function private.is_admin_teacher() from public, anon;
grant execute on function private.is_admin_teacher() to authenticated;

-- A aplicação ainda conserva um estado transicional (questionários e ativos
-- legados) neste registo único. Só a API com chave de serviço o usa.
create table if not exists public.course_state (
  id boolean primary key default true check (id),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.course_state(id, state) values (true, '{}'::jsonb)
on conflict (id) do nothing;
alter table public.course_state enable row level security;

create or replace function public.save_course_state(
  p_state jsonb,
  p_expected_updated_at timestamptz default null
) returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_updated_at timestamptz;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'INVALID_STATE' using errcode = '22023';
  end if;
  update public.course_state
     set state = p_state,
         updated_at = now(),
         updated_by = auth.uid()
   where id = true
     and (p_expected_updated_at is null or updated_at = p_expected_updated_at)
  returning updated_at into v_updated_at;
  if v_updated_at is null then
    raise exception 'STATE_CONFLICT' using errcode = '40001';
  end if;
  return v_updated_at;
end;
$$;
revoke all on function public.save_course_state(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.save_course_state(jsonb, timestamptz) to service_role;


create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) between 2 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.student_enrollments (
  student_id uuid primary key references public.profiles(id) on delete cascade,
  school_year text,
  active boolean not null default true,
  enrolled_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= enrolled_at)
);
alter table public.student_enrollments add column if not exists school_year text;

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
create index if not exists assignment_teacher_active_idx on public.teacher_student_subject_assignments (teacher_id, student_id, subject_id) where ends_on is null;
create index if not exists assignment_student_active_idx on public.teacher_student_subject_assignments (student_id, subject_id, teacher_id) where ends_on is null;

create or replace function private.student_has_active_subject(p_subject_id uuid)
returns boolean language sql stable security definer set search_path = public, private as $$
  select private.current_profile_role() = 'student' and exists (
    select 1 from public.teacher_student_subject_assignments a
    where a.student_id = auth.uid() and a.subject_id = p_subject_id
      and a.starts_on <= current_date and (a.ends_on is null or a.ends_on >= current_date)
  )
$$;

create or replace function private.can_read_student_subject(p_student_id uuid, p_subject_id uuid)
returns boolean language sql stable security definer set search_path = public, private as $$
  select auth.uid() = p_student_id
    or private.is_management()
    or exists (
      select 1 from public.teacher_student_subject_assignments a
      where a.teacher_id = auth.uid() and a.student_id = p_student_id and a.subject_id = p_subject_id
        and a.starts_on <= current_date and (a.ends_on is null or a.ends_on >= current_date)
    )
$$;

revoke all on function private.current_profile_role() from public, anon;
revoke all on function private.is_management() from public, anon;
revoke all on function private.is_teacher_account() from public, anon;
revoke all on function private.student_has_active_subject(uuid) from public, anon;
revoke all on function private.can_read_student_subject(uuid, uuid) from public, anon;
grant execute on function private.current_profile_role(), private.is_management(), private.is_teacher_account(), private.student_has_active_subject(uuid), private.can_read_student_subject(uuid, uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.student_enrollments enable row level security;
alter table public.teacher_student_subject_assignments enable row level security;
drop policy if exists subjects_read_active on public.subjects;
create policy subjects_read_active on public.subjects for select to authenticated using (active or private.is_management());
drop policy if exists subjects_manage_staff on public.subjects;
create policy subjects_manage_staff on public.subjects for all to authenticated using (private.is_management()) with check (private.is_management());
drop policy if exists profiles_read_scoped on public.profiles;
create policy profiles_read_scoped on public.profiles for select to authenticated using (
  id = auth.uid() or private.is_management() or exists (
    select 1 from public.teacher_student_subject_assignments a
    where a.teacher_id = auth.uid()
      and a.student_id = profiles.id
      and a.starts_on <= current_date
      and (a.ends_on is null or a.ends_on >= current_date)
  )
);
drop policy if exists enrollments_read_scoped on public.student_enrollments;
create policy enrollments_read_scoped on public.student_enrollments for select to authenticated using (
  student_id = auth.uid() or private.is_management() or exists (
    select 1 from public.teacher_student_subject_assignments a where a.teacher_id=auth.uid() and a.student_id=student_enrollments.student_id and a.starts_on<=current_date and (a.ends_on is null or a.ends_on>=current_date)
  )
);
drop policy if exists enrollments_manage_management on public.student_enrollments;
create policy enrollments_manage_management on public.student_enrollments for all to authenticated using (private.is_management()) with check (private.is_management());
drop policy if exists assignments_read_scoped on public.teacher_student_subject_assignments;
create policy assignments_read_scoped on public.teacher_student_subject_assignments for select to authenticated using (teacher_id=auth.uid() or student_id=auth.uid() or private.is_management());
drop policy if exists assignments_manage_management on public.teacher_student_subject_assignments;
create policy assignments_manage_management on public.teacher_student_subject_assignments for all to authenticated using (private.is_management()) with check (private.is_management());
grant select on public.profiles, public.subjects, public.student_enrollments, public.teacher_student_subject_assignments to authenticated;
grant insert, update, delete on public.subjects, public.student_enrollments, public.teacher_student_subject_assignments to authenticated;

-- Relatórios semanais.
create table if not exists public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  week_start date not null,
  week_end date not null,
  recommendations text not null default '',
  zero_lessons_reason text,
  status text not null default 'draft' check (status in ('draft','sent')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (teacher_id, student_id, subject_id, week_start),
  check (week_end >= week_start),
  check (extract(isodow from week_start) = 1),
  check ((status='draft' and sent_at is null) or (status='sent' and sent_at is not null))
);
create table if not exists public.weekly_report_lessons (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.weekly_reports(id) on delete cascade,
  lesson_date date not null,
  duration_minutes integer not null check (duration_minutes between 1 and 720),
  topics text not null check (char_length(trim(topics)) between 2 and 2000),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.weekly_reports enable row level security;
alter table public.weekly_report_lessons enable row level security;
drop policy if exists weekly_reports_read_scoped on public.weekly_reports;
create policy weekly_reports_read_scoped on public.weekly_reports for select to authenticated using (
  teacher_id=auth.uid() or private.is_management() or private.can_read_student_subject(student_id,subject_id)
);
drop policy if exists weekly_reports_write_teacher on public.weekly_reports;
create policy weekly_reports_write_teacher on public.weekly_reports for all to authenticated
using (teacher_id=auth.uid() and private.is_teacher_account())
with check (
  teacher_id=auth.uid() and private.is_teacher_account() and exists (
    select 1 from public.teacher_student_subject_assignments a
    where a.teacher_id=auth.uid() and a.student_id=weekly_reports.student_id and a.subject_id=weekly_reports.subject_id
      and a.starts_on<=current_date and (a.ends_on is null or a.ends_on>=current_date)
  )
);
drop policy if exists weekly_report_lessons_read_scoped on public.weekly_report_lessons;
create policy weekly_report_lessons_read_scoped on public.weekly_report_lessons for select to authenticated using (exists (select 1 from public.weekly_reports r where r.id=report_id and (r.teacher_id=auth.uid() or private.is_management() or private.can_read_student_subject(r.student_id,r.subject_id))));
drop policy if exists weekly_report_lessons_write_teacher on public.weekly_report_lessons;
create policy weekly_report_lessons_write_teacher on public.weekly_report_lessons for all to authenticated using (exists (select 1 from public.weekly_reports r where r.id=report_id and r.teacher_id=auth.uid() and private.is_teacher_account())) with check (exists (select 1 from public.weekly_reports r where r.id=report_id and r.teacher_id=auth.uid() and private.is_teacher_account()));
grant select,insert,update,delete on public.weekly_reports,public.weekly_report_lessons to authenticated;

-- Radar Virtus. Uma sessão por dispositivo; a view consolida a mais recente por aluno.
create table if not exists public.activity_heartbeats (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null,
  subject_id uuid references public.subjects(id) on delete set null,
  status text not null default 'online' check (status in ('online','working','away')),
  current_activity text not null default '',
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (student_id, session_id)
);
create index if not exists activity_heartbeats_seen_idx on public.activity_heartbeats(last_seen_at desc);
create or replace view public.current_student_activity with (security_invoker=true) as
  select student_id, session_id, subject_id, status, current_activity, started_at, last_seen_at
  from (select h.*, row_number() over (partition by h.student_id order by h.last_seen_at desc) as rn from public.activity_heartbeats h where h.last_seen_at > now() - interval '90 seconds') ranked
  where rn=1;
alter table public.activity_heartbeats enable row level security;
drop policy if exists activity_heartbeats_read_scoped on public.activity_heartbeats;
create policy activity_heartbeats_read_scoped on public.activity_heartbeats for select to authenticated using (student_id=auth.uid() or private.is_management() or private.can_read_student_subject(student_id,subject_id));
drop policy if exists activity_heartbeats_student_write_own on public.activity_heartbeats;
create policy activity_heartbeats_student_write_own on public.activity_heartbeats for all to authenticated using (student_id=auth.uid() and private.current_profile_role()='student') with check (student_id=auth.uid() and private.current_profile_role()='student');
grant select,insert,update,delete on public.activity_heartbeats to authenticated;

-- Trabalhos escolares e agenda.
create table if not exists public.school_work_items (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references public.profiles(id) on delete cascade, subject_id uuid not null references public.subjects(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 2 and 180), student_notes text not null default '' check (char_length(student_notes)<=4000),
  attachment_path text unique, attachment_name text, attachment_mime text, attachment_size_bytes bigint,
  status text not null default 'submitted' check(status in ('submitted','in_review','completed')), submitted_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (attachment_size_bytes is null or attachment_size_bytes between 1 and 52428800)
);
create table if not exists public.school_assessment_events (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references public.profiles(id) on delete cascade, subject_id uuid not null references public.subjects(id) on delete restrict,
  event_type text not null check(event_type in ('worksheet','test','global_exam')), title text not null check(char_length(trim(title)) between 2 and 180), scheduled_at timestamptz not null, notes text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.school_work_items enable row level security;
alter table public.school_assessment_events enable row level security;
drop policy if exists school_work_items_scoped on public.school_work_items;
create policy school_work_items_scoped on public.school_work_items for select to authenticated using (private.can_read_student_subject(student_id,subject_id));
drop policy if exists school_work_items_student_write on public.school_work_items;
create policy school_work_items_student_write on public.school_work_items for insert to authenticated with check(student_id=auth.uid() and private.student_has_active_subject(subject_id));
drop policy if exists school_assessment_events_scoped on public.school_assessment_events;
create policy school_assessment_events_scoped on public.school_assessment_events for select to authenticated using (private.can_read_student_subject(student_id,subject_id));
drop policy if exists school_assessment_events_student_write on public.school_assessment_events;
create policy school_assessment_events_student_write on public.school_assessment_events for all to authenticated using(student_id=auth.uid()) with check(student_id=auth.uid() and private.student_has_active_subject(subject_id));
grant select,insert,update,delete on public.school_work_items,public.school_assessment_events to authenticated;

-- Avaliações/TPCs internos e resultados.
create table if not exists public.center_tasks (
  id uuid primary key default gen_random_uuid(), teacher_id uuid not null references public.profiles(id) on delete restrict, subject_id uuid not null references public.subjects(id) on delete restrict,
  title text not null check(char_length(trim(title)) between 2 and 180), description text not null default '', task_type text not null check(task_type in ('pdf','quiz')), file_url text unique, due_date timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.task_assignments (
  task_id uuid not null references public.center_tasks(id) on delete cascade, student_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'assigned' check(status in ('assigned','submitted','graded')), assigned_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key(task_id,student_id)
);
create table if not exists public.task_submissions (
  id uuid primary key default gen_random_uuid(), task_id uuid not null references public.center_tasks(id) on delete cascade, student_id uuid not null references public.profiles(id) on delete cascade,
  content_text text not null default '', attachment_url text unique, attachment_name text, attachment_mime text, attachment_size_bytes bigint,
  grade numeric(5,2) check(grade is null or grade between 0 and 20), graded_by uuid references public.profiles(id) on delete set null, graded_at timestamptz,
  submitted_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(task_id,student_id),
  check (nullif(trim(content_text),'') is not null or attachment_url is not null), check(attachment_size_bytes is null or attachment_size_bytes between 1 and 52428800)
);
create table if not exists public.school_grades (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references public.profiles(id) on delete cascade, subject_id uuid not null references public.subjects(id) on delete restrict,
  assessment_type text not null check(assessment_type in ('worksheet','test','global_exam')), scale smallint not null check(scale in (5,10,20)), grade_value numeric(5,2) not null check(grade_value between 0 and scale), date_recorded date not null default current_date, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.center_tasks enable row level security; alter table public.task_assignments enable row level security; alter table public.task_submissions enable row level security; alter table public.school_grades enable row level security;
drop policy if exists center_tasks_read_scoped on public.center_tasks;
create policy center_tasks_read_scoped on public.center_tasks for select to authenticated using (teacher_id=auth.uid() or private.is_management() or exists(select 1 from public.task_assignments a where a.task_id=center_tasks.id and a.student_id=auth.uid()));
drop policy if exists center_tasks_teacher_write on public.center_tasks;
create policy center_tasks_teacher_write on public.center_tasks for all to authenticated using(teacher_id=auth.uid() and private.is_teacher_account()) with check(teacher_id=auth.uid() and private.is_teacher_account());
drop policy if exists task_assignments_read_scoped on public.task_assignments;
create policy task_assignments_read_scoped on public.task_assignments for select to authenticated using(student_id=auth.uid() or private.is_management() or exists(select 1 from public.center_tasks t where t.id=task_id and t.teacher_id=auth.uid()));
drop policy if exists task_assignments_teacher_write on public.task_assignments;
create policy task_assignments_teacher_write on public.task_assignments for all to authenticated
using(exists(select 1 from public.center_tasks t where t.id=task_id and t.teacher_id=auth.uid()))
with check(exists(
  select 1 from public.center_tasks t
  join public.teacher_student_subject_assignments a
    on a.teacher_id=t.teacher_id and a.student_id=task_assignments.student_id and a.subject_id=t.subject_id
  where t.id=task_id and t.teacher_id=auth.uid()
    and a.starts_on<=current_date and (a.ends_on is null or a.ends_on>=current_date)
));
drop policy if exists task_submissions_read_scoped on public.task_submissions;
create policy task_submissions_read_scoped on public.task_submissions for select to authenticated using(student_id=auth.uid() or private.is_management() or exists(select 1 from public.center_tasks t where t.id=task_id and t.teacher_id=auth.uid()));
drop policy if exists task_submissions_student_write on public.task_submissions;
create policy task_submissions_student_write on public.task_submissions for insert to authenticated with check(student_id=auth.uid() and exists(select 1 from public.task_assignments a where a.task_id=task_id and a.student_id=auth.uid()));
drop policy if exists task_submissions_teacher_grade on public.task_submissions;
create policy task_submissions_teacher_grade on public.task_submissions for update to authenticated using(exists(select 1 from public.center_tasks t where t.id=task_id and t.teacher_id=auth.uid())) with check(exists(select 1 from public.center_tasks t where t.id=task_id and t.teacher_id=auth.uid()));
drop policy if exists school_grades_read_scoped on public.school_grades;
create policy school_grades_read_scoped on public.school_grades for select to authenticated using(private.can_read_student_subject(student_id,subject_id));
drop policy if exists school_grades_student_write on public.school_grades;
create policy school_grades_student_write on public.school_grades for all to authenticated using(student_id=auth.uid()) with check(student_id=auth.uid() and private.student_has_active_subject(subject_id));
grant select,insert,update,delete on public.center_tasks,public.task_assignments,public.task_submissions,public.school_grades to authenticated;

-- Preparação para Exames, Pátio e telemetria.
create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(), teacher_id uuid not null references public.profiles(id) on delete restrict, subject_id uuid references public.subjects(id) on delete set null,
  title text not null check(char_length(trim(title)) between 2 and 180), description text not null default '' check(char_length(description)<=8000), material_type text not null check(material_type in ('video','image','document','link')),
  source_url text, storage_path text, is_published boolean not null default false, published_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(nullif(trim(coalesce(source_url,'')),'') is not null or nullif(trim(coalesce(storage_path,'')),'') is not null), check(not is_published or published_at is not null)
);
create table if not exists public.material_views (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references public.profiles(id) on delete cascade, material_id uuid not null references public.study_materials(id) on delete cascade,
  viewed_at timestamptz, downloaded_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(student_id,material_id), check(viewed_at is not null or downloaded_at is not null)
);
create table if not exists public.patio_messages (
  id uuid primary key default gen_random_uuid(), sender_id uuid not null references public.profiles(id) on delete restrict, receiver_id uuid references public.profiles(id) on delete restrict,
  content text not null check(char_length(trim(content)) between 1 and 4000), created_at timestamptz not null default now(), check(receiver_id is null or receiver_id<>sender_id)
);
create or replace function private.can_read_study_material(p_material_id uuid)
returns boolean language sql stable security definer set search_path = public, private as $$
 select exists(select 1 from public.study_materials m where m.id=p_material_id and (m.teacher_id=auth.uid() or private.is_management() or (private.current_profile_role()='student' and m.is_published and (m.subject_id is null or private.student_has_active_subject(m.subject_id)))))
$$;
create or replace function private.can_read_patio_message(p_sender uuid,p_receiver uuid)
returns boolean language sql stable security definer set search_path = public, private as $$
 select p_receiver is null or auth.uid() in (p_sender,p_receiver) or private.is_management() or exists(select 1 from public.teacher_student_subject_assignments a where a.teacher_id=auth.uid() and a.student_id in(p_sender,p_receiver) and a.starts_on<=current_date and (a.ends_on is null or a.ends_on>=current_date))
$$;
create or replace function private.can_send_patio_message(p_receiver uuid)
returns boolean language sql stable security definer set search_path = public, private as $$
  select p_receiver is null
    or private.is_management()
    or (private.current_profile_role() in ('teacher','admin_teacher','teacher_admin') and exists(
      select 1 from public.teacher_student_subject_assignments a
      where a.teacher_id=auth.uid() and a.student_id=p_receiver
        and a.starts_on<=current_date and (a.ends_on is null or a.ends_on>=current_date)
    ))
    or (private.current_profile_role()='student' and exists(
      select 1 from public.teacher_student_subject_assignments a
      where a.student_id=auth.uid() and a.teacher_id=p_receiver
        and a.starts_on<=current_date and (a.ends_on is null or a.ends_on>=current_date)
    ))
$$;
revoke all on function private.can_read_study_material(uuid), private.can_read_patio_message(uuid,uuid), private.can_send_patio_message(uuid) from public,anon;
grant execute on function private.can_read_study_material(uuid), private.can_read_patio_message(uuid,uuid), private.can_send_patio_message(uuid) to authenticated;
alter table public.study_materials enable row level security; alter table public.material_views enable row level security; alter table public.patio_messages enable row level security;
drop policy if exists study_materials_read_scoped on public.study_materials;
create policy study_materials_read_scoped on public.study_materials for select to authenticated using(private.can_read_study_material(id));
drop policy if exists study_materials_teacher_write on public.study_materials;
create policy study_materials_teacher_write on public.study_materials for all to authenticated using(teacher_id=auth.uid() and private.is_teacher_account()) with check(teacher_id=auth.uid() and private.is_teacher_account());
drop policy if exists material_views_read_scoped on public.material_views;
create policy material_views_read_scoped on public.material_views for select to authenticated using(student_id=auth.uid() or private.is_management() or exists(select 1 from public.study_materials m where m.id=material_id and m.teacher_id=auth.uid()));
drop policy if exists material_views_student_write on public.material_views;
create policy material_views_student_write on public.material_views for all to authenticated using(student_id=auth.uid()) with check(student_id=auth.uid() and private.can_read_study_material(material_id));
drop policy if exists patio_messages_read_scoped on public.patio_messages;
create policy patio_messages_read_scoped on public.patio_messages for select to authenticated using(private.can_read_patio_message(sender_id,receiver_id));
drop policy if exists patio_messages_send_own on public.patio_messages;
create policy patio_messages_send_own on public.patio_messages for insert to authenticated with check(sender_id=auth.uid() and private.can_send_patio_message(receiver_id));
grant select,insert,update,delete on public.study_materials,public.material_views,public.patio_messages to authenticated;
grant select on public.current_student_activity to authenticated;

-- Buckets privados requeridos pelos módulos já publicados.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('school_tasks','school_tasks',false,52428800,array['application/pdf','image/jpeg','image/png','image/webp','image/gif','image/heic']::text[]),
 ('center_task_files','center_task_files',false,52428800,array['application/pdf','image/jpeg','image/png','image/webp']::text[]),
 ('center_task_submissions','center_task_submissions',false,52428800,array['application/pdf','image/jpeg','image/png','image/webp']::text[]),
 ('study_materials','study_materials',false,52428800,array['application/pdf','image/jpeg','image/png','image/webp','video/mp4','video/webm','application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- A Secretaria e o Professor-Administrador podem gerir os registos do Centro.
-- Um professor normal continua limitado às relações professor–aluno activas.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'subjects','student_enrollments','teacher_student_subject_assignments',
    'weekly_reports','weekly_report_lessons','activity_heartbeats',
    'school_work_items','school_assessment_events','center_tasks',
    'task_assignments','task_submissions','school_grades','study_materials',
    'material_views','patio_messages'
  ] loop
    execute format('drop policy if exists management_full_access on public.%I', target_table);
    execute format(
      'create policy management_full_access on public.%I for all to authenticated using (private.is_management()) with check (private.is_management())',
      target_table
    );
  end loop;
end $$;

-- Storage privado. Os caminhos são validados antes da gravação do registo
-- da tabela, pelo que as políticas de INSERT verificam dono + prefixo; as
-- políticas de leitura verificam depois a relação com o registo da aplicação.
create or replace function private.can_read_school_task_object(p_path text)
returns boolean language sql stable security definer set search_path = public, private as $$
  select private.is_management() or exists (
    select 1 from public.school_work_items w
    where w.attachment_path = p_path
      and private.can_read_student_subject(w.student_id, w.subject_id)
  )
$$;

create or replace function private.can_read_center_task_file(p_path text)
returns boolean language sql stable security definer set search_path = public, private as $$
  select private.is_management() or exists (
    select 1 from public.center_tasks t
    where t.file_url = p_path
      and (t.teacher_id = auth.uid() or exists (
        select 1 from public.task_assignments a
        where a.task_id = t.id and a.student_id = auth.uid()
      ))
  )
$$;

create or replace function private.can_read_center_submission_file(p_path text)
returns boolean language sql stable security definer set search_path = public, private as $$
  select private.is_management() or exists (
    select 1 from public.task_submissions s
    join public.center_tasks t on t.id = s.task_id
    where s.attachment_url = p_path
      and (s.student_id = auth.uid() or t.teacher_id = auth.uid())
  )
$$;

create or replace function private.can_read_study_material_storage(p_path text)
returns boolean language sql stable security definer set search_path = public, private as $$
  select exists (
    select 1 from public.study_materials m
    where m.storage_path = p_path and private.can_read_study_material(m.id)
  )
$$;

revoke all on function private.can_read_school_task_object(text), private.can_read_center_task_file(text), private.can_read_center_submission_file(text), private.can_read_study_material_storage(text) from public, anon;
grant execute on function private.can_read_school_task_object(text), private.can_read_center_task_file(text), private.can_read_center_submission_file(text), private.can_read_study_material_storage(text) to authenticated;

drop policy if exists centro_virtus_storage_management on storage.objects;
create policy centro_virtus_storage_management on storage.objects for all to authenticated
using (bucket_id in ('school_tasks','center_task_files','center_task_submissions','study_materials') and private.is_management())
with check (bucket_id in ('school_tasks','center_task_files','center_task_submissions','study_materials') and private.is_management());

drop policy if exists school_tasks_read_scoped on storage.objects;
create policy school_tasks_read_scoped on storage.objects for select to authenticated
using (bucket_id = 'school_tasks' and private.can_read_school_task_object(name));
drop policy if exists school_tasks_student_upload_own on storage.objects;
create policy school_tasks_student_upload_own on storage.objects for insert to authenticated
with check (bucket_id = 'school_tasks' and private.current_profile_role() = 'student' and (storage.foldername(name))[1] = 'school-work' and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists school_tasks_student_update_own on storage.objects;
create policy school_tasks_student_update_own on storage.objects for update to authenticated
using (bucket_id = 'school_tasks' and private.current_profile_role() = 'student' and (storage.foldername(name))[1] = 'school-work' and (storage.foldername(name))[2] = auth.uid()::text)
with check (bucket_id = 'school_tasks' and private.current_profile_role() = 'student' and (storage.foldername(name))[1] = 'school-work' and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists school_tasks_student_delete_own on storage.objects;
create policy school_tasks_student_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'school_tasks' and private.current_profile_role() = 'student' and (storage.foldername(name))[1] = 'school-work' and (storage.foldername(name))[2] = auth.uid()::text);

drop policy if exists center_task_files_read_scoped on storage.objects;
create policy center_task_files_read_scoped on storage.objects for select to authenticated
using (bucket_id = 'center_task_files' and private.can_read_center_task_file(name));
drop policy if exists center_task_files_teacher_upload_own on storage.objects;
create policy center_task_files_teacher_upload_own on storage.objects for insert to authenticated
with check (bucket_id = 'center_task_files' and private.is_teacher_account() and (storage.foldername(name))[1] = 'teacher-tasks' and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists center_task_files_teacher_delete_own on storage.objects;
create policy center_task_files_teacher_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'center_task_files' and private.is_teacher_account() and (storage.foldername(name))[1] = 'teacher-tasks' and (storage.foldername(name))[2] = auth.uid()::text);

drop policy if exists center_task_submissions_read_scoped on storage.objects;
create policy center_task_submissions_read_scoped on storage.objects for select to authenticated
using (bucket_id = 'center_task_submissions' and private.can_read_center_submission_file(name));
drop policy if exists center_task_submissions_student_upload_own on storage.objects;
create policy center_task_submissions_student_upload_own on storage.objects for insert to authenticated
with check (bucket_id = 'center_task_submissions' and private.current_profile_role() = 'student' and (storage.foldername(name))[1] = 'submissions' and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists center_task_submissions_student_delete_own on storage.objects;
create policy center_task_submissions_student_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'center_task_submissions' and private.current_profile_role() = 'student' and (storage.foldername(name))[1] = 'submissions' and (storage.foldername(name))[2] = auth.uid()::text);

drop policy if exists study_materials_storage_read_scoped on storage.objects;
create policy study_materials_storage_read_scoped on storage.objects for select to authenticated
using (bucket_id = 'study_materials' and private.can_read_study_material_storage(name));
drop policy if exists study_materials_storage_teacher_insert on storage.objects;
create policy study_materials_storage_teacher_insert on storage.objects for insert to authenticated
with check (bucket_id = 'study_materials' and private.is_teacher_account() and (storage.foldername(name))[1] = 'materials' and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists study_materials_storage_teacher_delete on storage.objects;
create policy study_materials_storage_teacher_delete on storage.objects for delete to authenticated
using (bucket_id = 'study_materials' and private.is_teacher_account() and (storage.foldername(name))[1] = 'materials' and (storage.foldername(name))[2] = auth.uid()::text);

insert into public.subjects(name,active) values ('Matemática',true) on conflict(name) do update set active=true;

do $$
begin
  if not exists (select 1 from pg_publication_rel r join pg_publication p on p.oid=r.prpubid where p.pubname='supabase_realtime' and r.prrelid='public.activity_heartbeats'::regclass) then
    alter publication supabase_realtime add table public.activity_heartbeats;
  end if;
  if not exists (select 1 from pg_publication_rel r join pg_publication p on p.oid=r.prpubid where p.pubname='supabase_realtime' and r.prrelid='public.patio_messages'::regclass) then
    alter publication supabase_realtime add table public.patio_messages;
  end if;
end $$;

commit;

-- Verificação: missing_tables deve devolver 0; todas as relações devem
-- devolver exists = true e a Secretaria deve devolver o papel secretary.
-- Se o perfil faltar, crie a conta pelo painel de provisionamento/API segura
-- (nunca directamente em auth.users).
with expected(relation) as (
  select unnest(array['course_state','subjects','student_enrollments','teacher_student_subject_assignments','weekly_reports','weekly_report_lessons','activity_heartbeats','school_work_items','school_assessment_events','center_tasks','task_assignments','task_submissions','school_grades','study_materials','material_views','patio_messages'])
)
select count(*) filter (where to_regclass('public.' || relation) is null) as missing_tables,
       coalesce(array_agg(relation order by relation) filter (where to_regclass('public.' || relation) is null), '{}'::text[]) as missing_relation_names
from expected;

select relation, to_regclass('public.' || relation) is not null as exists
from unnest(array['course_state','subjects','student_enrollments','teacher_student_subject_assignments','weekly_reports','weekly_report_lessons','activity_heartbeats','school_work_items','school_assessment_events','center_tasks','task_assignments','task_submissions','school_grades','study_materials','material_views','patio_messages']) as relation
order by relation;

select to_regclass('public.current_student_activity') is not null as current_student_activity_view_exists;

select username, full_name, role, must_change_password,
       case when role = 'secretary' then 'OK' else 'REVER' end as validacao_secretaria
from public.profiles
where lower(username) = 'secretaria.virtus';
