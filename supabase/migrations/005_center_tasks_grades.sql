-- Centro de Estudos Virtus — módulos 5 e 6
-- Tarefas internas do Centro, respostas dos alunos e notas escolares.
--
-- Depende de 001_accounts_assignments.sql e 004_school_work.sql.
-- Os campos file_url e attachment_url guardam caminhos de objectos privados,
-- nunca URLs públicas ou URLs assinadas persistentes.

begin;

create table if not exists public.center_tasks (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 2 and 180),
  description text not null default '' check (char_length(description) <= 8000),
  task_type text not null check (task_type in ('pdf', 'quiz')),
  file_url text unique,
  due_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.center_tasks.file_url is
  'Caminho privado em storage.objects no bucket center_task_files; não guardar URL assinada.';

create table if not exists public.task_assignments (
  task_id uuid not null references public.center_tasks(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'assigned'
    check (status in ('assigned', 'submitted', 'graded')),
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (task_id, student_id)
);

create table if not exists public.task_submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.center_tasks(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  content_text text not null default '' check (char_length(content_text) <= 10000),
  attachment_url text unique,
  attachment_name text check (attachment_name is null or char_length(trim(attachment_name)) between 1 and 255),
  attachment_mime text check (attachment_mime is null or attachment_mime in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'
  )),
  attachment_size_bytes bigint check (attachment_size_bytes is null or attachment_size_bytes between 1 and 52428800),
  grade numeric(5,2) check (grade is null or (grade >= 0 and grade <= 20)),
  graded_by uuid references public.profiles(id) on delete set null,
  graded_at timestamptz,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, student_id),
  check (
    nullif(trim(content_text), '') is not null
    or attachment_url is not null
  ),
  check (
    (attachment_url is null and attachment_name is null and attachment_mime is null and attachment_size_bytes is null)
    or
    (attachment_url is not null and attachment_name is not null and attachment_mime is not null and attachment_size_bytes is not null)
  ),
  check (
    (grade is null and graded_by is null and graded_at is null)
    or
    (grade is not null and graded_by is not null and graded_at is not null)
  )
);

comment on column public.task_submissions.attachment_url is
  'Caminho privado em storage.objects no bucket center_task_submissions; não guardar URL assinada.';

create table if not exists public.school_grades (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  assessment_type text not null check (assessment_type in ('worksheet', 'test', 'global_exam')),
  scale smallint not null check (scale in (5, 10, 20)),
  grade_value numeric(5,2) not null check (grade_value >= 0 and grade_value <= scale),
  date_recorded date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists center_tasks_teacher_created_idx
  on public.center_tasks (teacher_id, created_at desc);
create index if not exists center_tasks_subject_due_idx
  on public.center_tasks (subject_id, due_date asc nulls last);
create index if not exists task_assignments_student_status_idx
  on public.task_assignments (student_id, status, assigned_at desc);
create index if not exists task_submissions_task_submitted_idx
  on public.task_submissions (task_id, submitted_at desc);
create index if not exists task_submissions_student_submitted_idx
  on public.task_submissions (student_id, submitted_at desc);
create index if not exists school_grades_student_subject_date_idx
  on public.school_grades (student_id, subject_id, date_recorded desc);

-- Impede que uma conta de professor ou Secretaria seja usada como aluno numa
-- atribuição, resposta ou nota escolar, inclusive por chamadas forjadas.
create or replace function private.validate_center_student_role()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if (select role from public.profiles where id = new.student_id) <> 'student' then
    raise exception 'CENTER_TASK_STUDENT_ROLE_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists task_assignments_student_role on public.task_assignments;
create trigger task_assignments_student_role
before insert or update of student_id on public.task_assignments
for each row execute function private.validate_center_student_role();

drop trigger if exists task_submissions_student_role on public.task_submissions;
create trigger task_submissions_student_role
before insert or update of student_id on public.task_submissions
for each row execute function private.validate_center_student_role();

drop trigger if exists school_grades_student_role on public.school_grades;
create trigger school_grades_student_role
before insert or update of student_id on public.school_grades
for each row execute function private.validate_center_student_role();

create or replace function private.touch_center_tasks_updated_at()
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

drop trigger if exists center_tasks_touch_updated_at on public.center_tasks;
create trigger center_tasks_touch_updated_at
before update on public.center_tasks
for each row execute function private.touch_center_tasks_updated_at();

drop trigger if exists task_assignments_touch_updated_at on public.task_assignments;
create trigger task_assignments_touch_updated_at
before update on public.task_assignments
for each row execute function private.touch_center_tasks_updated_at();

drop trigger if exists task_submissions_touch_updated_at on public.task_submissions;
create trigger task_submissions_touch_updated_at
before update on public.task_submissions
for each row execute function private.touch_center_tasks_updated_at();

drop trigger if exists school_grades_touch_updated_at on public.school_grades;
create trigger school_grades_touch_updated_at
before update on public.school_grades
for each row execute function private.touch_center_tasks_updated_at();

-- Depois de a tarefa ter destinatários, professor e disciplina deixam de ser
-- mutáveis. Isso evita que uma atribuição existente seja reutilizada por
-- engano para outra turma ou disciplina.
create or replace function private.lock_center_task_scope_after_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if (new.teacher_id is distinct from old.teacher_id or new.subject_id is distinct from old.subject_id)
     and exists (select 1 from public.task_assignments where task_id = old.id) then
    raise exception 'CENTER_TASK_SCOPE_LOCKED_AFTER_ASSIGNMENT' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists center_tasks_lock_scope_after_assignment on public.center_tasks;
create trigger center_tasks_lock_scope_after_assignment
before update of teacher_id, subject_id on public.center_tasks
for each row execute function private.lock_center_task_scope_after_assignment();

-- Um docente pode criar e editar apenas as suas tarefas, numa disciplina para
-- a qual já tenha pelo menos uma atribuição pedagógica activa. Professor Admin
-- continua a ser docente; a Secretaria permanece exclusivamente em leitura.
create or replace function private.can_manage_center_task(
  p_teacher_id uuid,
  p_subject_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    auth.uid() = p_teacher_id
    and private.current_profile_role() in ('teacher', 'admin_teacher')
    and exists (
      select 1
      from public.teacher_student_subject_assignments assignment
      where assignment.teacher_id = p_teacher_id
        and assignment.subject_id = p_subject_id
        and assignment.starts_on <= current_date
        and (assignment.ends_on is null or assignment.ends_on >= current_date)
    )
$$;

-- A atribuição de uma tarefa só é válida se o docente proprietário tiver uma
-- relação professor–aluno–disciplina activa para aquele aluno.
create or replace function private.can_assign_center_task(
  p_task_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.center_tasks task
    join public.teacher_student_subject_assignments assignment
      on assignment.teacher_id = task.teacher_id
     and assignment.student_id = p_student_id
     and assignment.subject_id = task.subject_id
    where task.id = p_task_id
      and task.teacher_id = auth.uid()
      and assignment.starts_on <= current_date
      and (assignment.ends_on is null or assignment.ends_on >= current_date)
  )
$$;

create or replace function private.can_read_center_task(
  p_task_id uuid,
  p_student_id uuid
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
      from public.center_tasks task
      join public.teacher_student_subject_assignments assignment
        on assignment.teacher_id = auth.uid()
       and assignment.student_id = p_student_id
       and assignment.subject_id = task.subject_id
      where task.id = p_task_id
        and task.teacher_id = auth.uid()
        and assignment.starts_on <= current_date
        and (assignment.ends_on is null or assignment.ends_on >= current_date)
    )
$$;

create or replace function private.can_grade_center_submission(
  p_task_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    private.current_profile_role() in ('teacher', 'admin_teacher')
    and exists (
      select 1
      from public.center_tasks task
      join public.teacher_student_subject_assignments assignment
        on assignment.teacher_id = auth.uid()
       and assignment.student_id = p_student_id
       and assignment.subject_id = task.subject_id
      where task.id = p_task_id
        and task.teacher_id = auth.uid()
        and assignment.starts_on <= current_date
        and (assignment.ends_on is null or assignment.ends_on >= current_date)
    )
$$;

-- Mesmo uma chamada autenticada de um docente só pode acrescentar a avaliação;
-- não pode reescrever o enunciado da resposta nem trocar o ficheiro do aluno.
create or replace function private.guard_center_submission_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if new.task_id is distinct from old.task_id
     or new.student_id is distinct from old.student_id
     or new.content_text is distinct from old.content_text
     or new.attachment_url is distinct from old.attachment_url
     or new.attachment_name is distinct from old.attachment_name
     or new.attachment_mime is distinct from old.attachment_mime
     or new.attachment_size_bytes is distinct from old.attachment_size_bytes
     or new.submitted_at is distinct from old.submitted_at then
    raise exception 'CENTER_TASK_SUBMISSION_CONTENT_IMMUTABLE' using errcode = '23514';
  end if;

  if new.grade is null or new.graded_by is distinct from auth.uid() or new.graded_at is null then
    raise exception 'CENTER_TASK_GRADE_AUDIT_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists task_submissions_guard_mutation on public.task_submissions;
create trigger task_submissions_guard_mutation
before update on public.task_submissions
for each row execute function private.guard_center_submission_mutation();

-- Mantém o estado da atribuição consistente sem permitir que o aluno declare
-- a própria resposta como corrigida.
create or replace function private.sync_center_task_assignment_status()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  update public.task_assignments
  set status = case when new.grade is null then 'submitted' else 'graded' end,
      updated_at = now()
  where task_id = new.task_id and student_id = new.student_id;
  return new;
end;
$$;

drop trigger if exists task_submissions_sync_assignment on public.task_submissions;
create trigger task_submissions_sync_assignment
after insert or update of grade on public.task_submissions
for each row execute function private.sync_center_task_assignment_status();

revoke all on function private.validate_center_student_role() from public, anon;
revoke all on function private.touch_center_tasks_updated_at() from public, anon;
revoke all on function private.can_manage_center_task(uuid, uuid) from public, anon;
revoke all on function private.can_assign_center_task(uuid, uuid) from public, anon;
revoke all on function private.can_read_center_task(uuid, uuid) from public, anon;
revoke all on function private.can_grade_center_submission(uuid, uuid) from public, anon;
revoke all on function private.lock_center_task_scope_after_assignment() from public, anon;
revoke all on function private.guard_center_submission_mutation() from public, anon;
revoke all on function private.sync_center_task_assignment_status() from public, anon;
grant execute on function private.can_manage_center_task(uuid, uuid) to authenticated;
grant execute on function private.can_assign_center_task(uuid, uuid) to authenticated;
grant execute on function private.can_read_center_task(uuid, uuid) to authenticated;
grant execute on function private.can_grade_center_submission(uuid, uuid) to authenticated;

alter table public.center_tasks enable row level security;
alter table public.task_assignments enable row level security;
alter table public.task_submissions enable row level security;
alter table public.school_grades enable row level security;

drop policy if exists center_tasks_read_scoped on public.center_tasks;
create policy center_tasks_read_scoped on public.center_tasks
for select to authenticated using (
  teacher_id = auth.uid()
  or private.current_profile_role() in ('admin_teacher', 'secretary')
  or exists (
    select 1
    from public.task_assignments assignment
    where assignment.task_id = center_tasks.id
      and assignment.student_id = auth.uid()
  )
);

drop policy if exists center_tasks_teacher_insert_own on public.center_tasks;
create policy center_tasks_teacher_insert_own on public.center_tasks
for insert to authenticated with check (
  private.can_manage_center_task(teacher_id, subject_id)
);

drop policy if exists center_tasks_teacher_update_own on public.center_tasks;
create policy center_tasks_teacher_update_own on public.center_tasks
for update to authenticated using (
  teacher_id = auth.uid()
  and private.can_manage_center_task(teacher_id, subject_id)
) with check (
  private.can_manage_center_task(teacher_id, subject_id)
);

drop policy if exists center_tasks_teacher_delete_own on public.center_tasks;
create policy center_tasks_teacher_delete_own on public.center_tasks
for delete to authenticated using (
  teacher_id = auth.uid()
  and private.can_manage_center_task(teacher_id, subject_id)
);

drop policy if exists task_assignments_read_scoped on public.task_assignments;
create policy task_assignments_read_scoped on public.task_assignments
for select to authenticated using (
  student_id = auth.uid()
  or private.current_profile_role() in ('admin_teacher', 'secretary')
  or exists (
    select 1 from public.center_tasks task
    where task.id = task_assignments.task_id and task.teacher_id = auth.uid()
  )
);

drop policy if exists task_assignments_teacher_insert_scoped on public.task_assignments;
create policy task_assignments_teacher_insert_scoped on public.task_assignments
for insert to authenticated with check (
  private.can_assign_center_task(task_id, student_id)
);

drop policy if exists task_assignments_teacher_update_scoped on public.task_assignments;
create policy task_assignments_teacher_update_scoped on public.task_assignments
for update to authenticated using (
  private.can_assign_center_task(task_id, student_id)
) with check (
  private.can_assign_center_task(task_id, student_id)
);

drop policy if exists task_assignments_teacher_delete_scoped on public.task_assignments;
create policy task_assignments_teacher_delete_scoped on public.task_assignments
for delete to authenticated using (
  private.can_assign_center_task(task_id, student_id)
);

drop policy if exists task_submissions_read_scoped on public.task_submissions;
create policy task_submissions_read_scoped on public.task_submissions
for select to authenticated using (
  private.can_read_center_task(task_id, student_id)
);

drop policy if exists task_submissions_student_insert_own on public.task_submissions;
create policy task_submissions_student_insert_own on public.task_submissions
for insert to authenticated with check (
  student_id = auth.uid()
  and private.current_profile_role() = 'student'
  and exists (
    select 1 from public.task_assignments assignment
    where assignment.task_id = task_submissions.task_id
      and assignment.student_id = auth.uid()
  )
  and grade is null
  and graded_by is null
  and graded_at is null
  and (attachment_url is null or attachment_url like ('submissions/' || auth.uid()::text || '/' || task_id::text || '/%'))
);

drop policy if exists task_submissions_teacher_grade_scoped on public.task_submissions;
create policy task_submissions_teacher_grade_scoped on public.task_submissions
for update to authenticated using (
  private.can_grade_center_submission(task_id, student_id)
) with check (
  private.can_grade_center_submission(task_id, student_id)
  and grade is not null
  and graded_by = auth.uid()
  and graded_at is not null
);

drop policy if exists school_grades_read_scoped on public.school_grades;
create policy school_grades_read_scoped on public.school_grades
for select to authenticated using (
  student_id = auth.uid()
  or private.current_profile_role() in ('admin_teacher', 'secretary')
  or private.has_active_assignment(student_id, subject_id)
);

drop policy if exists school_grades_student_insert_own on public.school_grades;
create policy school_grades_student_insert_own on public.school_grades
for insert to authenticated with check (
  student_id = auth.uid()
  and private.current_profile_role() = 'student'
  and private.student_has_active_subject(subject_id)
);

grant select, insert, update, delete on public.center_tasks, public.task_assignments to authenticated;
grant select, insert, update on public.task_submissions to authenticated;
grant select, insert on public.school_grades to authenticated;

-- Buckets privados para fichas publicadas e para fotografias/PDFs de respostas.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('center_task_files', 'center_task_files', false, 52428800,
    array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']::text[]),
  ('center_task_submissions', 'center_task_submissions', false, 52428800,
    array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']::text[])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.can_read_center_task_file(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    p_object_name like ('teacher-tasks/' || auth.uid()::text || '/%')
    or private.current_profile_role() in ('admin_teacher', 'secretary')
    or exists (
      select 1
      from public.center_tasks task
      join public.task_assignments assignment on assignment.task_id = task.id
      where task.file_url = p_object_name
        and assignment.student_id = auth.uid()
    )
$$;

create or replace function private.can_read_center_submission_file(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    p_object_name like ('submissions/' || auth.uid()::text || '/%')
    or private.current_profile_role() in ('admin_teacher', 'secretary')
    or exists (
      select 1
      from public.task_submissions submission
      where submission.attachment_url = p_object_name
        and private.can_grade_center_submission(submission.task_id, submission.student_id)
    )
$$;

revoke all on function private.can_read_center_task_file(text) from public, anon;
revoke all on function private.can_read_center_submission_file(text) from public, anon;
grant execute on function private.can_read_center_task_file(text) to authenticated;
grant execute on function private.can_read_center_submission_file(text) to authenticated;

drop policy if exists center_task_files_read_scoped on storage.objects;
create policy center_task_files_read_scoped on storage.objects
for select to authenticated using (
  bucket_id = 'center_task_files'
  and private.can_read_center_task_file(name)
);

drop policy if exists center_task_files_teacher_upload_own on storage.objects;
create policy center_task_files_teacher_upload_own on storage.objects
for insert to authenticated with check (
  bucket_id = 'center_task_files'
  and private.current_profile_role() in ('teacher', 'admin_teacher')
  and (storage.foldername(name))[1] = 'teacher-tasks'
  and (storage.foldername(name))[2] = auth.uid()::text
);

drop policy if exists center_task_files_teacher_delete_own on storage.objects;
create policy center_task_files_teacher_delete_own on storage.objects
for delete to authenticated using (
  bucket_id = 'center_task_files'
  and private.current_profile_role() in ('teacher', 'admin_teacher')
  and (storage.foldername(name))[1] = 'teacher-tasks'
  and (storage.foldername(name))[2] = auth.uid()::text
);

drop policy if exists center_task_submissions_read_scoped on storage.objects;
create policy center_task_submissions_read_scoped on storage.objects
for select to authenticated using (
  bucket_id = 'center_task_submissions'
  and private.can_read_center_submission_file(name)
);

drop policy if exists center_task_submissions_student_upload_own on storage.objects;
create policy center_task_submissions_student_upload_own on storage.objects
for insert to authenticated with check (
  bucket_id = 'center_task_submissions'
  and private.current_profile_role() = 'student'
  and (storage.foldername(name))[1] = 'submissions'
  and (storage.foldername(name))[2] = auth.uid()::text
);

drop policy if exists center_task_submissions_student_delete_own on storage.objects;
create policy center_task_submissions_student_delete_own on storage.objects
for delete to authenticated using (
  bucket_id = 'center_task_submissions'
  and private.current_profile_role() = 'student'
  and (storage.foldername(name))[1] = 'submissions'
  and (storage.foldername(name))[2] = auth.uid()::text
);

commit;
