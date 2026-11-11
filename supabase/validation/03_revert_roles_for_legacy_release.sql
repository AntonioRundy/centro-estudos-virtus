-- HOMOLOGAÇÃO/EMERGÊNCIA APENAS.
-- Usar somente depois de testar o código anterior com a base migrada e confirmar
-- que é necessário voltar temporariamente ao release legado.
-- Esta operação mantém UUIDs, Auth, course_state, matrículas e atribuições.

begin;

alter table public.profiles
  drop constraint if exists profiles_role_check;

update public.profiles
set role = 'teacher_admin'
where role = 'admin_teacher';

-- A Secretária é preservada na base, mas a versão legada não oferece uma área
-- própria para ela. Não disponibilizar esta conta até regressar à versão-ponte.
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('teacher_admin', 'teacher', 'secretary', 'student'));

commit;

select id, username, role
from public.profiles
where role = 'teacher_admin'
order by username;
