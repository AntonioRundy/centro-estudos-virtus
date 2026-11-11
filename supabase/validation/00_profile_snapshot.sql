-- HOMOLOGAÇÃO APENAS — executar ANTES de 001_accounts_assignments.sql.
-- Guarda a identidade actual dos perfis para comprovar que a migração não
-- altera UUID, utilizador ou papel de uma conta existente.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.homologation_profile_snapshot (
  id uuid primary key,
  username text not null,
  role text not null,
  captured_at timestamptz not null default now()
);
truncate private.homologation_profile_snapshot;
insert into private.homologation_profile_snapshot (id, username, role)
select id, username, role from public.profiles;
commit;
