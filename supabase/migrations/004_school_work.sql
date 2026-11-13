-- Centro de Estudos Virtus — módulo 4
-- Trabalhos escolares externos e agenda de avaliações dos alunos.
--
-- Depende de 001_accounts_assignments.sql. Os anexos vivem exclusivamente
-- no bucket privado school_tasks; a tabela conserva só os seus metadados e
-- o caminho do objecto. Esta migração não concede escrita pedagógica a
-- professores, Secretaria ou administração: essas acções serão mediadas
-- por rotas Vercel autenticadas quando forem necessárias.

begin;

create table if not exists public.school_work_items (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 2 and 180),
  student_notes text not null default '' check (char_length(student_notes) <= 4000),
  attachment_path text unique,
  attachment_name text check (attachment_name is null or char_length(trim(attachment_name)) between 1 and 255),
  attachment_mime text check (attachment_mime is null or attachment_mime in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'
  )),
  attachment_size_bytes bigint check (attachment_size_bytes is null or attachment_size_bytes between 1 and 52428800),
  status text not null default 'submitted' check (status in ('submitted', 'in_review', 'completed')),
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (attachment_path is null and attachment_name is null and attachment_mime is null and attachment_size_bytes is null)
    or
    (attachment_path is not null and attachment_name is not null and attachment_mime is not null and attachment_size_bytes is not null)
  )
);

create index if not exists school_work_items_student_submitted_idx
  on public.school_work_items (student_id, submitted_at desc);
create index if not exists school_work_items_subject_student_idx
  on public.school_work_items (subject_id, student_id, submitted_at desc);
create index if not exists school_work_items_open_idx
  on public.school_work_items (status, submitted_at desc)
  where status in ('submitted', 'in_review');

create table if not exists public.school_assessment_events (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  event_type text not null check (event_type in ('worksheet', 'test', 'global_exam')),
  title text not null check (char_length(trim(title)) between 2 and 180),
  scheduled_at timestamptz not null,
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists school_assessment_events_student_schedule_idx
  on public.school_assessment_events (student_id, scheduled_at asc);
create index if not exists school_assessment_events_subject_student_schedule_idx
  on public.school_assessment_events (subject_id, student_id, scheduled_at asc);

-- Validação adicional para impedir que um professor, Secretaria ou uma conta
-- sem papel de aluno seja usada como proprietário de trabalho ou avaliação.
create or replace function private.validate_school_work_student()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if (select role from public.profiles where id = new.student_id) <> 'student' then
    raise exception 'SCHOOL_WORK_STUDENT_ROLE_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists school_work_items_student_role on public.school_work_items;
create trigger school_work_items_student_role
before insert or update of student_id on public.school_work_items
for each row execute function private.validate_school_work_student();

drop trigger if exists school_assessment_events_student_role on public.school_assessment_events;
create trigger school_assessment_events_student_role
before insert or update of student_id on public.school_assessment_events
for each row execute function private.validate_school_work_student();

create or replace function private.touch_school_work_updated_at()
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

drop trigger if exists school_work_items_touch_updated_at on public.school_work_items;
create trigger school_work_items_touch_updated_at
before update on public.school_work_items
for each row execute function private.touch_school_work_updated_at();

drop trigger if exists school_assessment_events_touch_updated_at on public.school_assessment_events;
create trigger school_assessment_events_touch_updated_at
before update on public.school_assessment_events
for each row execute function private.touch_school_work_updated_at();

-- A relação professor–aluno–disciplina é a fonte de autorização. O aluno vê
-- sempre os seus próprios dados; Secretaria e Professor Admin apenas lêem;
-- professor normal lê somente alunos com atribuição activa para a disciplina.
create or replace function private.can_read_school_work_student(
  p_student_id uuid,
  p_subject_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    auth.uid() = p_student_id
    or private.current_profile_role() in ('admin_teacher', 'secretary')
    or exists (
      select 1
      from public.teacher_student_subject_assignments assignment
      where assignment.teacher_id = auth.uid()
        and assignment.student_id = p_student_id
        and assignment.subject_id = p_subject_id
        and assignment.starts_on <= current_date
        and (assignment.ends_on is null or assignment.ends_on >= current_date)
    )
$$;

create or replace function private.student_has_active_subject(p_subject_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    private.current_profile_role() = 'student'
    and exists (
      select 1
      from public.teacher_student_subject_assignments assignment
      where assignment.student_id = auth.uid()
        and assignment.subject_id = p_subject_id
        and assignment.starts_on <= current_date
        and (assignment.ends_on is null or assignment.ends_on >= current_date)
    )
$$;

create or replace function private.is_own_school_task_path(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select p_path is null or p_path like ('school-work/' || auth.uid()::text || '/%')
$$;

revoke all on function private.validate_school_work_student() from public, anon;
revoke all on function private.touch_school_work_updated_at() from public, anon;
revoke all on function private.can_read_school_work_student(uuid, uuid) from public, anon;
revoke all on function private.student_has_active_subject(uuid) from public, anon;
revoke all on function private.is_own_school_task_path(text) from public, anon;
grant execute on function private.can_read_school_work_student(uuid, uuid) to authenticated;
grant execute on function private.student_has_active_subject(uuid) to authenticated;
grant execute on function private.is_own_school_task_path(text) to authenticated;

alter table public.school_work_items enable row level security;
alter table public.school_assessment_events enable row level security;

drop policy if exists school_work_items_read_scoped on public.school_work_items;
create policy school_work_items_read_scoped on public.school_work_items
for select to authenticated using (
  private.can_read_school_work_student(student_id, subject_id)
);

drop policy if exists school_work_items_student_insert_own on public.school_work_items;
create policy school_work_items_student_insert_own on public.school_work_items
for insert to authenticated with check (
  student_id = auth.uid()
  and private.student_has_active_subject(subject_id)
  and private.is_own_school_task_path(attachment_path)
  and status = 'submitted'
);

drop policy if exists school_work_items_student_update_own on public.school_work_items;
create policy school_work_items_student_update_own on public.school_work_items
for update to authenticated using (
  student_id = auth.uid()
  and private.current_profile_role() = 'student'
  and status = 'submitted'
) with check (
  student_id = auth.uid()
  and private.student_has_active_subject(subject_id)
  and private.is_own_school_task_path(attachment_path)
  and status = 'submitted'
);

drop policy if exists school_work_items_student_delete_own on public.school_work_items;
create policy school_work_items_student_delete_own on public.school_work_items
for delete to authenticated using (
  student_id = auth.uid()
  and private.current_profile_role() = 'student'
  and status = 'submitted'
);

drop policy if exists school_assessment_events_read_scoped on public.school_assessment_events;
create policy school_assessment_events_read_scoped on public.school_assessment_events
for select to authenticated using (
  private.can_read_school_work_student(student_id, subject_id)
);

drop policy if exists school_assessment_events_student_insert_own on public.school_assessment_events;
create policy school_assessment_events_student_insert_own on public.school_assessment_events
for insert to authenticated with check (
  student_id = auth.uid()
  and private.student_has_active_subject(subject_id)
);

drop policy if exists school_assessment_events_student_update_own on public.school_assessment_events;
create policy school_assessment_events_student_update_own on public.school_assessment_events
for update to authenticated using (
  student_id = auth.uid()
  and private.current_profile_role() = 'student'
) with check (
  student_id = auth.uid()
  and private.student_has_active_subject(subject_id)
);

drop policy if exists school_assessment_events_student_delete_own on public.school_assessment_events;
create policy school_assessment_events_student_delete_own on public.school_assessment_events
for delete to authenticated using (
  student_id = auth.uid()
  and private.current_profile_role() = 'student'
);

grant select, insert, update, delete on public.school_work_items, public.school_assessment_events to authenticated;

-- Bucket privado para enunciados de trabalhos externos. A aplicação deve usar
-- sempre o caminho school-work/<uuid-do-aluno>/<uuid-do-trabalho>/<ficheiro>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'school_tasks',
  'school_tasks',
  false,
  52428800,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.can_read_school_task_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    p_object_name like ('school-work/' || auth.uid()::text || '/%')
    or private.current_profile_role() in ('admin_teacher', 'secretary')
    or exists (
      select 1
      from public.school_work_items item
      where item.attachment_path = p_object_name
        and private.can_read_school_work_student(item.student_id, item.subject_id)
    )
$$;

revoke all on function private.can_read_school_task_object(text) from public, anon;
grant execute on function private.can_read_school_task_object(text) to authenticated;

drop policy if exists school_tasks_read_scoped on storage.objects;
create policy school_tasks_read_scoped on storage.objects
for select to authenticated using (
  bucket_id = 'school_tasks'
  and private.can_read_school_task_object(name)
);

drop policy if exists school_tasks_student_upload_own on storage.objects;
create policy school_tasks_student_upload_own on storage.objects
for insert to authenticated with check (
  bucket_id = 'school_tasks'
  and private.current_profile_role() = 'student'
  and (storage.foldername(name))[1] = 'school-work'
  and (storage.foldername(name))[2] = auth.uid()::text
);

drop policy if exists school_tasks_student_update_own on storage.objects;
create policy school_tasks_student_update_own on storage.objects
for update to authenticated using (
  bucket_id = 'school_tasks'
  and private.current_profile_role() = 'student'
  and (storage.foldername(name))[1] = 'school-work'
  and (storage.foldername(name))[2] = auth.uid()::text
) with check (
  bucket_id = 'school_tasks'
  and private.current_profile_role() = 'student'
  and (storage.foldername(name))[1] = 'school-work'
  and (storage.foldername(name))[2] = auth.uid()::text
);

drop policy if exists school_tasks_student_delete_own on storage.objects;
create policy school_tasks_student_delete_own on storage.objects
for delete to authenticated using (
  bucket_id = 'school_tasks'
  and private.current_profile_role() = 'student'
  and (storage.foldername(name))[1] = 'school-work'
  and (storage.foldername(name))[2] = auth.uid()::text
);

commit;
