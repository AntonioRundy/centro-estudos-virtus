-- Centro de Estudos Virtus — complemento ao módulo 006
-- Ano escolar do aluno e armazenamento privado dos materiais de preparação.
-- Execute depois de 006_patio_telemetry.sql.

begin;

alter table public.profiles
  add column if not exists school_year text;

alter table public.student_enrollments
  add column if not exists school_year text;

alter table public.profiles
  drop constraint if exists profiles_school_year_length_check;
alter table public.profiles
  add constraint profiles_school_year_length_check
  check (school_year is null or char_length(trim(school_year)) between 3 and 40);

alter table public.student_enrollments
  drop constraint if exists student_enrollments_school_year_length_check;
alter table public.student_enrollments
  add constraint student_enrollments_school_year_length_check
  check (school_year is null or char_length(trim(school_year)) between 3 and 40);

-- Materiais são privados. O browser recebe apenas URLs assinadas criadas após
-- a autorização via RLS; não existe URL pública de ficheiro.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study_materials',
  'study_materials',
  false,
  52428800,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- O caminho é materials/<id-do-docente>/<id-do-material>/<ficheiro>.
-- A primeira pasta torna a autoria verificável sem confiar no cliente.
create or replace function private.can_read_study_material_storage(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, private, storage
as $$
  select exists (
    select 1
    from public.study_materials material
    where material.storage_path = p_path
      and private.can_read_study_material(material.id)
  )
$$;

revoke all on function private.can_read_study_material_storage(text) from public, anon;
grant execute on function private.can_read_study_material_storage(text) to authenticated;

drop policy if exists study_materials_storage_read_scoped on storage.objects;
create policy study_materials_storage_read_scoped
on storage.objects for select to authenticated
using (
  bucket_id = 'study_materials'
  and private.can_read_study_material_storage(name)
);

drop policy if exists study_materials_storage_teacher_insert on storage.objects;
create policy study_materials_storage_teacher_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'study_materials'
  and private.current_profile_role() in ('teacher', 'admin_teacher')
  and (storage.foldername(name))[1] = 'materials'
  and (storage.foldername(name))[2] = auth.uid()::text
);

drop policy if exists study_materials_storage_teacher_update on storage.objects;
create policy study_materials_storage_teacher_update
on storage.objects for update to authenticated
using (
  bucket_id = 'study_materials'
  and private.current_profile_role() in ('teacher', 'admin_teacher')
  and (storage.foldername(name))[1] = 'materials'
  and (storage.foldername(name))[2] = auth.uid()::text
)
with check (
  bucket_id = 'study_materials'
  and (storage.foldername(name))[1] = 'materials'
  and (storage.foldername(name))[2] = auth.uid()::text
);

drop policy if exists study_materials_storage_teacher_delete on storage.objects;
create policy study_materials_storage_teacher_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'study_materials'
  and private.current_profile_role() in ('teacher', 'admin_teacher')
  and (storage.foldername(name))[1] = 'materials'
  and (storage.foldername(name))[2] = auth.uid()::text
);

commit;
