-- HOMOLOGAÇÃO APENAS.
-- Executar depois de criar os dados fictícios pós-migração e, novamente,
-- depois da reversão e depois da reaplicação de 001.
-- Não altera dados; serve para comparar as três fases.

select
  count(*) filter (where role = 'admin_teacher') as administradores_canonicos,
  count(*) filter (where role = 'teacher_admin') as administradores_legados,
  count(*) filter (where role = 'secretary') as secretarias,
  count(*) filter (where role = 'student') as alunos
from public.profiles;

select
  count(*) as atribuicoes,
  count(*) filter (where ends_on is null) as atribuicoes_activas,
  count(distinct teacher_id) as professores_com_atribuicao,
  count(distinct student_id) as alunos_atribuidos
from public.teacher_student_subject_assignments;

-- A Secretária criada durante a transição deve continuar nesta lista mesmo
-- quando o release legado estiver activo. O release antigo não a deve usar.
select id, username, full_name, role
from public.profiles
where role = 'secretary'
order by created_at;

-- As atribuições devem manter os mesmos IDs e referências após rollback de
-- papéis, pois 03_revert_roles_for_legacy_release.sql não toca nestas tabelas.
select a.id, teacher.username as professor, student.username as aluno, subject.name as disciplina,
       a.is_primary, a.starts_on, a.ends_on
from public.teacher_student_subject_assignments a
join public.profiles teacher on teacher.id = a.teacher_id
join public.profiles student on student.id = a.student_id
join public.subjects subject on subject.id = a.subject_id
order by teacher.username, student.username, subject.name;
