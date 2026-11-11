-- HOMOLOGAÇÃO APENAS — executar DEPOIS de 001_accounts_assignments.sql.
-- Devolve resultados em vez de alterar perfis ou entregas.

select
  (select count(*) from private.homologation_profile_snapshot) as perfis_antes,
  (select count(*) from public.profiles) as perfis_depois,
  (select count(*)
     from private.homologation_profile_snapshot before
     join public.profiles after on after.id = before.id
    where after.username = before.username) as ids_e_utilizadores_preservados,
  (select count(*) from public.profiles where role = 'teacher_admin') as papeis_legados_restantes,
  (select count(*) from public.profiles where role = 'admin_teacher') as professores_administradores,
  (select count(*) from public.profiles where role = 'student') as alunos,
  (select count(*) from public.student_enrollments where active) as matriculas_activas;

-- Estes alunos estão correctamente inscritos, mas ainda precisam que um
-- Professor Administrador lhes associe professor(es) e disciplina(s).
select p.id, p.full_name, p.username
from public.profiles p
left join public.teacher_student_subject_assignments a
  on a.student_id = p.id
 and a.starts_on <= current_date
 and (a.ends_on is null or a.ends_on >= current_date)
where p.role = 'student'
  and exists (
    select 1 from public.student_enrollments e
    where e.student_id = p.id and e.active
  )
  and a.id is null
order by p.full_name;

-- Professores sem alunos atribuídos: não conseguem consultar dados pedagógicos
-- até receberem pelo menos uma atribuição.
select p.id, p.full_name, p.username
from public.profiles p
left join public.teacher_student_subject_assignments a
  on a.teacher_id = p.id
 and a.starts_on <= current_date
 and (a.ends_on is null or a.ends_on >= current_date)
where p.role = 'teacher'
  and a.id is null
order by p.full_name;
