-- Centro de Estudos Virtus — módulo 3
-- Radar Virtus: presença em tempo real e persistência de actividade.
--
-- Depende de 001_accounts_assignments.sql. Cada linha representa uma sessão
-- de navegador, e não apenas um aluno: assim, um separador inactivo não
-- substitui uma sessão activa do mesmo aluno.

begin;

create table if not exists public.activity_heartbeats (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null,
  subject_id uuid references public.subjects(id) on delete set null,
  status text not null default 'online'
    check (status in ('online', 'working', 'away')),
  current_activity text not null default ''
    check (char_length(current_activity) <= 500),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  client_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, session_id)
);

create index if not exists activity_heartbeats_student_seen_idx
  on public.activity_heartbeats (student_id, last_seen_at desc);
create index if not exists activity_heartbeats_seen_idx
  on public.activity_heartbeats (last_seen_at desc);
create index if not exists activity_heartbeats_subject_seen_idx
  on public.activity_heartbeats (subject_id, last_seen_at desc)
  where subject_id is not null;

-- Impede que uma chamada tente usar uma conta de professor/Secretaria como
-- se fosse um aluno activo no Radar.
create or replace function private.validate_activity_heartbeat_student()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if (select role from public.profiles where id = new.student_id) <> 'student' then
    raise exception 'RADAR_HEARTBEAT_STUDENT_ROLE_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists activity_heartbeat_student_role on public.activity_heartbeats;
create trigger activity_heartbeat_student_role
before insert or update of student_id on public.activity_heartbeats
for each row execute function private.validate_activity_heartbeat_student();

-- Um professor normal só pode observar alunos que lhe estão atribuídos hoje.
-- Professor Administrador e Secretaria podem observar todo o centro.
create or replace function private.can_read_radar_student(p_student_id uuid)
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
        and assignment.starts_on <= current_date
        and (assignment.ends_on is null or assignment.ends_on >= current_date)
    )
$$;

revoke all on function private.validate_activity_heartbeat_student() from public, anon;
revoke all on function private.can_read_radar_student(uuid) from public, anon;
grant execute on function private.can_read_radar_student(uuid) to authenticated;

alter table public.activity_heartbeats enable row level security;

drop policy if exists activity_heartbeats_read_scoped on public.activity_heartbeats;
create policy activity_heartbeats_read_scoped on public.activity_heartbeats
for select to authenticated using (
  private.can_read_radar_student(student_id)
);

drop policy if exists activity_heartbeats_student_insert_own on public.activity_heartbeats;
create policy activity_heartbeats_student_insert_own on public.activity_heartbeats
for insert to authenticated with check (
  auth.uid() = student_id
  and private.current_profile_role() = 'student'
);

drop policy if exists activity_heartbeats_student_update_own on public.activity_heartbeats;
create policy activity_heartbeats_student_update_own on public.activity_heartbeats
for update to authenticated using (
  auth.uid() = student_id
  and private.current_profile_role() = 'student'
) with check (
  auth.uid() = student_id
  and private.current_profile_role() = 'student'
);

drop policy if exists activity_heartbeats_student_delete_own on public.activity_heartbeats;
create policy activity_heartbeats_student_delete_own on public.activity_heartbeats
for delete to authenticated using (
  auth.uid() = student_id
  and private.current_profile_role() = 'student'
);

grant select, insert, update, delete on public.activity_heartbeats to authenticated;

-- O Radar usa presença em canais privados por aluno. A lista visual é sempre
-- obtida da tabela acima (que tem RLS por linha); Presence apenas acelera a
-- actualização. Isto evita que um professor receba no websocket os dados de
-- alunos fora das suas atribuições.
drop policy if exists radar_presence_student_track on realtime.messages;
create policy radar_presence_student_track on realtime.messages
for insert to authenticated with check (
  extension = 'presence'
  and private.current_profile_role() = 'student'
  and realtime.topic() = ('radar_virtus:' || auth.uid()::text)
);

drop policy if exists radar_presence_read_scoped on realtime.messages;
create policy radar_presence_read_scoped on realtime.messages
for select to authenticated using (
  extension = 'presence'
  and realtime.topic() like 'radar_virtus:%'
  and (
    private.current_profile_role() in ('admin_teacher', 'secretary')
    or realtime.topic() = ('radar_virtus:' || auth.uid()::text)
    or exists (
      select 1
      from public.teacher_student_subject_assignments assignment
      where assignment.teacher_id = auth.uid()
        and realtime.topic() = ('radar_virtus:' || assignment.student_id::text)
        and assignment.starts_on <= current_date
        and (assignment.ends_on is null or assignment.ends_on >= current_date)
    )
  )
);

-- A inscrição na publicação permite que a gestão receba alterações de linhas
-- que já passaram pelo filtro RLS. O bloco é seguro para nova execução.
do $$
begin
  if not exists (
    select 1
    from pg_publication_rel publication_relation
    join pg_publication publication on publication.oid = publication_relation.prpubid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid = 'public.activity_heartbeats'::regclass
  ) then
    alter publication supabase_realtime add table public.activity_heartbeats;
  end if;
end;
$$;

-- Consolida as sessões vivas em uma linha por aluno. Se existir uma sessão
-- activa e outra marcada como ausente, a activa prevalece; se todas estiverem
-- ausentes, mostra a ausência mais recente. A view respeita a RLS da tabela.
create or replace view public.current_student_activity
with (security_invoker = true)
as
  select distinct on (heartbeat.student_id)
    heartbeat.student_id,
    heartbeat.session_id,
    heartbeat.subject_id,
    heartbeat.status,
    heartbeat.current_activity,
    heartbeat.started_at,
    heartbeat.last_seen_at
  from public.activity_heartbeats heartbeat
  where heartbeat.last_seen_at >= now() - interval '90 seconds'
  order by heartbeat.student_id,
    case heartbeat.status when 'working' then 0 when 'online' then 1 else 2 end,
    heartbeat.last_seen_at desc;

grant select on public.current_student_activity to authenticated;

commit;
