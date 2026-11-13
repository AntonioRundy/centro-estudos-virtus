-- Centro de Estudos Virtus — módulos D e E
-- Pátio (chat) e telemetria de materiais de preparação para provas.
--
-- Depende de 001_accounts_assignments.sql e 004_school_work.sql.
-- Execute primeiro em homologação e só depois em produção.
-- Nenhuma mensagem privada ou telemetria fica pública: o RLS é a fonte de
-- autorização tanto para consultas REST como para Postgres Changes.

begin;

-- Catálogo mínimo de materiais. A tabela é criada aqui porque material_views
-- precisa de uma referência relacional, em vez de guardar um ID solto vindo
-- do navegador. O upload privado de novos documentos será tratado pelo módulo
-- de Preparação para Provas; source_url pode apontar para um vídeo ou link.
create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  subject_id uuid references public.subjects(id) on delete set null,
  title text not null check (char_length(trim(title)) between 2 and 180),
  description text not null default '' check (char_length(description) <= 8000),
  material_type text not null check (material_type in ('video', 'image', 'document', 'link')),
  source_url text,
  storage_path text,
  is_published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    nullif(trim(coalesce(source_url, '')), '') is not null
    or nullif(trim(coalesce(storage_path, '')), '') is not null
  ),
  check (not is_published or published_at is not null)
);

create index if not exists study_materials_teacher_created_idx
  on public.study_materials (teacher_id, created_at desc);
create index if not exists study_materials_published_subject_idx
  on public.study_materials (subject_id, published_at desc)
  where is_published = true;

-- Mensagens do Pátio. receiver_id nulo significa publicação global.
-- Não há update/delete para contas da aplicação: as mensagens são imutáveis
-- para preservar o histórico moderável, sem expor a tabela ao público.
create table if not exists public.patio_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete restrict,
  receiver_id uuid references public.profiles(id) on delete restrict,
  content text not null check (char_length(trim(content)) between 1 and 4000),
  created_at timestamptz not null default now(),
  check (receiver_id is null or receiver_id <> sender_id)
);

create index if not exists patio_messages_global_created_idx
  on public.patio_messages (created_at desc)
  where receiver_id is null;
create index if not exists patio_messages_receiver_created_idx
  on public.patio_messages (receiver_id, created_at desc)
  where receiver_id is not null;
create index if not exists patio_messages_sender_created_idx
  on public.patio_messages (sender_id, created_at desc);

-- Uma linha por aluno e material conserva a última leitura e o último
-- descarregamento. Evita telemetria duplicada por recarregamentos da página.
create table if not exists public.material_views (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  material_id uuid not null references public.study_materials(id) on delete cascade,
  viewed_at timestamptz,
  downloaded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, material_id),
  check (viewed_at is not null or downloaded_at is not null)
);

create index if not exists material_views_material_activity_idx
  on public.material_views (material_id, updated_at desc);
create index if not exists material_views_student_activity_idx
  on public.material_views (student_id, updated_at desc);

create or replace function private.touch_patio_telemetry_updated_at()
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

drop trigger if exists study_materials_touch_updated_at on public.study_materials;
create trigger study_materials_touch_updated_at
before update on public.study_materials
for each row execute function private.touch_patio_telemetry_updated_at();

drop trigger if exists material_views_touch_updated_at on public.material_views;
create trigger material_views_touch_updated_at
before update on public.material_views
for each row execute function private.touch_patio_telemetry_updated_at();

-- Evita que uma conta que não é aluno seja usada para forjar telemetria.
create or replace function private.validate_material_view_student()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if (select role from public.profiles where id = new.student_id) <> 'student' then
    raise exception 'MATERIAL_VIEW_STUDENT_ROLE_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists material_views_student_role on public.material_views;
create trigger material_views_student_role
before insert or update of student_id on public.material_views
for each row execute function private.validate_material_view_student();

-- O aluno pode actualizar apenas os próprios carimbos de tempo e nunca trocar
-- material ou aluno. Também não pode apagar um evento já registado.
create or replace function private.guard_material_view_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if new.student_id is distinct from old.student_id
     or new.material_id is distinct from old.material_id then
    raise exception 'MATERIAL_VIEW_SCOPE_IMMUTABLE' using errcode = '23514';
  end if;

  if (old.viewed_at is not null and new.viewed_at is null)
     or (old.downloaded_at is not null and new.downloaded_at is null)
     or (old.viewed_at is not null and new.viewed_at < old.viewed_at)
     or (old.downloaded_at is not null and new.downloaded_at < old.downloaded_at) then
    raise exception 'MATERIAL_VIEW_TIMESTAMP_IMMUTABLE' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists material_views_guard_mutation on public.material_views;
create trigger material_views_guard_mutation
before update on public.material_views
for each row execute function private.guard_material_view_mutation();

create or replace function private.is_active_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1 from public.profiles
    where id = p_profile_id and is_active = true
  )
$$;

-- Um professor administra os próprios materiais; alunos só recebem material
-- publicado e pertinente a uma disciplina em que têm atribuição activa.
-- Materiais sem disciplina são comunicados gerais do Centro.
create or replace function private.can_read_study_material(p_material_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.study_materials material
    where material.id = p_material_id
      and (
        material.teacher_id = auth.uid()
        or private.current_profile_role() in ('admin_teacher', 'secretary')
        or (
          private.current_profile_role() = 'student'
          and material.is_published = true
          and (
            material.subject_id is null
            or private.student_has_active_subject(material.subject_id)
          )
        )
      )
  )
$$;

create or replace function private.can_student_track_material(p_material_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    private.current_profile_role() = 'student'
    and private.is_active_profile(auth.uid())
    and private.can_read_study_material(p_material_id)
$$;

-- A regra do Pátio deixa todos lerem a conversa global e a própria conversa.
-- Docentes normais podem ainda moderar/acompanhar somente as mensagens
-- privadas envolvendo alunos com atribuição activa. Administração e Secretaria
-- têm o God Eye exclusivamente de leitura sobre todo o histórico.
create or replace function private.can_read_patio_message(
  p_sender_id uuid,
  p_receiver_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    p_receiver_id is null
    or auth.uid() = p_sender_id
    or auth.uid() = p_receiver_id
    or private.current_profile_role() in ('admin_teacher', 'secretary')
    or (
      private.current_profile_role() in ('teacher', 'admin_teacher')
      and exists (
        select 1
        from public.teacher_student_subject_assignments assignment
        where assignment.teacher_id = auth.uid()
          and assignment.student_id in (p_sender_id, p_receiver_id)
          and assignment.starts_on <= current_date
          and (assignment.ends_on is null or assignment.ends_on >= current_date)
      )
    )
$$;

-- Regras de envio: global é permitido a qualquer conta activa; no privado,
-- alunos falam com alunos ou com docentes que lhes estão atribuídos, enquanto
-- docentes falam apenas com os seus alunos. Professor Admin pode moderar.
create or replace function private.can_send_patio_private_message(p_receiver_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select
    p_receiver_id is not null
    and p_receiver_id <> auth.uid()
    and private.is_active_profile(auth.uid())
    and private.is_active_profile(p_receiver_id)
    and (
      private.current_profile_role() = 'admin_teacher'
      or (
        private.current_profile_role() = 'teacher'
        and exists (
          select 1
          from public.teacher_student_subject_assignments assignment
          where assignment.teacher_id = auth.uid()
            and assignment.student_id = p_receiver_id
            and assignment.starts_on <= current_date
            and (assignment.ends_on is null or assignment.ends_on >= current_date)
        )
      )
      or (
        private.current_profile_role() = 'student'
        and (
          (select role from public.profiles where id = p_receiver_id) = 'student'
          or exists (
            select 1
            from public.teacher_student_subject_assignments assignment
            where assignment.student_id = auth.uid()
              and assignment.teacher_id = p_receiver_id
              and assignment.starts_on <= current_date
              and (assignment.ends_on is null or assignment.ends_on >= current_date)
          )
        )
      )
    )
$$;

revoke all on function private.touch_patio_telemetry_updated_at() from public, anon;
revoke all on function private.validate_material_view_student() from public, anon;
revoke all on function private.guard_material_view_mutation() from public, anon;
revoke all on function private.is_active_profile(uuid) from public, anon;
revoke all on function private.can_read_study_material(uuid) from public, anon;
revoke all on function private.can_student_track_material(uuid) from public, anon;
revoke all on function private.can_read_patio_message(uuid, uuid) from public, anon;
revoke all on function private.can_send_patio_private_message(uuid) from public, anon;
grant execute on function private.is_active_profile(uuid) to authenticated;
grant execute on function private.can_read_study_material(uuid) to authenticated;
grant execute on function private.can_student_track_material(uuid) to authenticated;
grant execute on function private.can_read_patio_message(uuid, uuid) to authenticated;
grant execute on function private.can_send_patio_private_message(uuid) to authenticated;

alter table public.study_materials enable row level security;
alter table public.patio_messages enable row level security;
alter table public.material_views enable row level security;

drop policy if exists study_materials_read_scoped on public.study_materials;
create policy study_materials_read_scoped on public.study_materials
for select to authenticated using (private.can_read_study_material(id));

drop policy if exists study_materials_teacher_insert_own on public.study_materials;
create policy study_materials_teacher_insert_own on public.study_materials
for insert to authenticated with check (
  teacher_id = auth.uid()
  and private.current_profile_role() in ('teacher', 'admin_teacher')
  and private.is_active_profile(auth.uid())
);

drop policy if exists study_materials_teacher_update_own on public.study_materials;
create policy study_materials_teacher_update_own on public.study_materials
for update to authenticated using (
  teacher_id = auth.uid()
  and private.current_profile_role() in ('teacher', 'admin_teacher')
) with check (
  teacher_id = auth.uid()
  and private.current_profile_role() in ('teacher', 'admin_teacher')
);

drop policy if exists study_materials_teacher_delete_own on public.study_materials;
create policy study_materials_teacher_delete_own on public.study_materials
for delete to authenticated using (
  teacher_id = auth.uid()
  and private.current_profile_role() in ('teacher', 'admin_teacher')
);

drop policy if exists patio_messages_read_scoped on public.patio_messages;
create policy patio_messages_read_scoped on public.patio_messages
for select to authenticated using (
  private.can_read_patio_message(sender_id, receiver_id)
);

drop policy if exists patio_messages_insert_own on public.patio_messages;
create policy patio_messages_insert_own on public.patio_messages
for insert to authenticated with check (
  sender_id = auth.uid()
  and private.is_active_profile(auth.uid())
  and (
    receiver_id is null
    or private.can_send_patio_private_message(receiver_id)
  )
);

drop policy if exists material_views_read_scoped on public.material_views;
create policy material_views_read_scoped on public.material_views
for select to authenticated using (
  student_id = auth.uid()
  or private.current_profile_role() = 'admin_teacher'
  or exists (
    select 1
    from public.study_materials material
    where material.id = material_views.material_id
      and material.teacher_id = auth.uid()
  )
);

drop policy if exists material_views_student_insert_own on public.material_views;
create policy material_views_student_insert_own on public.material_views
for insert to authenticated with check (
  student_id = auth.uid()
  and private.can_student_track_material(material_id)
);

drop policy if exists material_views_student_update_own on public.material_views;
create policy material_views_student_update_own on public.material_views
for update to authenticated using (
  student_id = auth.uid()
  and private.current_profile_role() = 'student'
) with check (
  student_id = auth.uid()
  and private.can_student_track_material(material_id)
);

grant select, insert, update, delete on public.study_materials to authenticated;
grant select, insert on public.patio_messages to authenticated;
grant select, insert, update on public.material_views to authenticated;

-- O cliente do Pátio vai escutar Postgres Changes. A publicação é idempotente;
-- as políticas acima continuam a filtrar cada linha entregue ao utilizador.
do $$
begin
  if not exists (
    select 1
    from pg_publication_rel publication_relation
    join pg_publication publication on publication.oid = publication_relation.prpubid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid = 'public.patio_messages'::regclass
  ) then
    alter publication supabase_realtime add table public.patio_messages;
  end if;
end;
$$;

commit;
