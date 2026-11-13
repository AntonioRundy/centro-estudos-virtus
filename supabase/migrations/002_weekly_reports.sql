-- Centro de Estudos Virtus — módulo 2
-- Relatórios semanais e aulas incluídas em cada relatório.
--
-- Esta migração depende de 001_accounts_assignments.sql. Execute primeiro em
-- homologação. Não altera course_state, contas existentes ou ficheiros.

begin;

create table if not exists public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  week_start date not null,
  week_end date generated always as (week_start + 6) stored,
  recommendations text not null default '',
  zero_lessons_reason text not null default '',
  status text not null default 'draft' check (status in ('draft', 'sent')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_reports_week_start_monday check (extract(isodow from week_start) = 1),
  constraint weekly_reports_sent_at_consistent check (
    (status = 'draft' and sent_at is null) or (status = 'sent' and sent_at is not null)
  ),
  unique (teacher_id, student_id, subject_id, week_start)
);

create table if not exists public.weekly_report_lessons (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.weekly_reports(id) on delete cascade,
  lesson_date date not null,
  duration_minutes integer not null check (duration_minutes between 1 and 600),
  topics text not null check (char_length(trim(topics)) between 2 and 3000),
  sort_order smallint not null default 0 check (sort_order between 0 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_id, sort_order)
);

create index if not exists weekly_reports_teacher_week_idx
  on public.weekly_reports (teacher_id, week_start desc);
create index if not exists weekly_reports_student_week_idx
  on public.weekly_reports (student_id, week_start desc);
create index if not exists weekly_reports_secretary_sent_idx
  on public.weekly_reports (sent_at desc)
  where status = 'sent';
create index if not exists weekly_report_lessons_report_idx
  on public.weekly_report_lessons (report_id, sort_order);

create or replace function private.can_manage_weekly_report(
  p_teacher_id uuid,
  p_student_id uuid,
  p_subject_id uuid,
  p_week_start date
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.teacher_student_subject_assignments assignment
    where assignment.teacher_id = p_teacher_id
      and assignment.student_id = p_student_id
      and assignment.subject_id = p_subject_id
      and assignment.starts_on <= (p_week_start + 6)
      and (assignment.ends_on is null or assignment.ends_on >= p_week_start)
  )
$$;

create or replace function private.weekly_report_accessible(
  p_teacher_id uuid,
  p_student_id uuid,
  p_subject_id uuid,
  p_week_start date
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select (
    auth.uid() = p_teacher_id
    and private.can_manage_weekly_report(p_teacher_id, p_student_id, p_subject_id, p_week_start)
  )
  or private.current_profile_role() = 'secretary'
$$;

revoke all on function private.can_manage_weekly_report(uuid, uuid, uuid, date) from public, anon;
revoke all on function private.weekly_report_accessible(uuid, uuid, uuid, date) from public, anon;
grant execute on function private.can_manage_weekly_report(uuid, uuid, uuid, date) to authenticated;
grant execute on function private.weekly_report_accessible(uuid, uuid, uuid, date) to authenticated;

alter table public.weekly_reports enable row level security;
alter table public.weekly_report_lessons enable row level security;

drop policy if exists weekly_reports_teacher_read_own on public.weekly_reports;
create policy weekly_reports_teacher_read_own on public.weekly_reports
for select to authenticated using (
  private.weekly_report_accessible(teacher_id, student_id, subject_id, week_start)
  and (status = 'sent' or auth.uid() = teacher_id)
);

drop policy if exists weekly_reports_teacher_insert_own on public.weekly_reports;
create policy weekly_reports_teacher_insert_own on public.weekly_reports
for insert to authenticated with check (
  auth.uid() = teacher_id
  and private.can_manage_weekly_report(teacher_id, student_id, subject_id, week_start)
);

drop policy if exists weekly_reports_teacher_update_draft on public.weekly_reports;
create policy weekly_reports_teacher_update_draft on public.weekly_reports
for update to authenticated using (
  auth.uid() = teacher_id
  and status = 'draft'
  and private.can_manage_weekly_report(teacher_id, student_id, subject_id, week_start)
) with check (
  auth.uid() = teacher_id
  and private.can_manage_weekly_report(teacher_id, student_id, subject_id, week_start)
);

drop policy if exists weekly_report_lessons_read_scoped on public.weekly_report_lessons;
create policy weekly_report_lessons_read_scoped on public.weekly_report_lessons
for select to authenticated using (
  exists (
    select 1 from public.weekly_reports report
    where report.id = weekly_report_lessons.report_id
      and private.weekly_report_accessible(report.teacher_id, report.student_id, report.subject_id, report.week_start)
      and (report.status = 'sent' or auth.uid() = report.teacher_id)
  )
);

drop policy if exists weekly_report_lessons_write_owner on public.weekly_report_lessons;
create policy weekly_report_lessons_write_owner on public.weekly_report_lessons
for all to authenticated using (
  exists (
    select 1 from public.weekly_reports report
    where report.id = weekly_report_lessons.report_id
      and report.teacher_id = auth.uid()
      and report.status = 'draft'
      and private.can_manage_weekly_report(report.teacher_id, report.student_id, report.subject_id, report.week_start)
  )
) with check (
  exists (
    select 1 from public.weekly_reports report
    where report.id = weekly_report_lessons.report_id
      and report.teacher_id = auth.uid()
      and report.status = 'draft'
      and private.can_manage_weekly_report(report.teacher_id, report.student_id, report.subject_id, report.week_start)
  )
);

grant select, insert, update on public.weekly_reports to authenticated;
grant select, insert, update, delete on public.weekly_report_lessons to authenticated;

commit;
