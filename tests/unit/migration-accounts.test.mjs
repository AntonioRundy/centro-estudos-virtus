import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/001_accounts_assignments.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase/validation/03_revert_roles_for_legacy_release.sql'), 'utf8');

test('remove a restrição de papéis antes da conversão do perfil legado', () => {
  const drop = sql.indexOf('drop constraint if exists profiles_role_check');
  const update = sql.indexOf("set role = 'admin_teacher'");
  const add = sql.indexOf('add constraint profiles_role_check');
  assert.ok(drop >= 0 && update > drop && add > update);
});

test('protege o arquivo legado fora do schema público', () => {
  assert.match(sql, /create table if not exists private\.legacy_course_state_archive/i);
  assert.match(sql, /revoke all on table private\.legacy_course_state_archive from public, anon, authenticated/i);
});

test('impede dois professores principais abertos para o mesmo aluno e disciplina', () => {
  assert.match(sql, /assignment_one_open_primary_idx/i);
  assert.match(sql, /where is_primary = true and ends_on is null/i);
});

test('cria tabelas separadas para matrícula e atribuição, sem reutilizar course_state', () => {
  assert.match(sql, /create table if not exists public\.student_enrollments/i);
  assert.match(sql, /create table if not exists public\.teacher_student_subject_assignments/i);
  assert.match(sql, /validate_assignment_roles/i);
});

test('inscreve alunos existentes sem alterar as suas contas', () => {
  assert.match(sql, /insert into public\.student_enrollments/i);
  assert.match(sql, /from public\.profiles\s+where role = 'student'/i);
  assert.match(sql, /on conflict \(student_id\) do nothing/i);
});

test('reversão de emergência troca apenas o papel administrativo e preserva as novas tabelas', () => {
  assert.match(rollback, /begin;/i);
  assert.match(rollback, /set role = 'teacher_admin'/i);
  assert.match(rollback, /commit;/i);
  assert.doesNotMatch(rollback, /drop table|delete from public\.teacher_student_subject_assignments/i);
});
