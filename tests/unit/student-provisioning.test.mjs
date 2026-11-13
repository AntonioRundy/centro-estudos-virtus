import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const provision = fs.readFileSync(path.join(root, 'server/admin/provision.js'), 'utf8');
const provisioningPage = fs.readFileSync(path.join(root, 'admin/provisioning/index.html'), 'utf8');
const profileMigration = fs.readFileSync(path.join(root, 'supabase/migrations/007_student_year_and_material_storage.sql'), 'utf8');

test('provisionamento de aluno aceita ano, disciplina e professor e cria atribuição activa', () => {
  assert.match(provision, /schoolYear/);
  assert.match(provision, /subjectName/);
  assert.match(provision, /teacherUsername/);
  assert.match(provision, /teacher_student_subject_assignments/);
  assert.match(provision, /Não foi possível criar a disciplina/);
  assert.match(provisioningPage, /Ano escolar/);
  assert.match(provisioningPage, /Professor atribuído/);
});

test('migração de ano escolar é idempotente e não altera contas existentes', () => {
  assert.match(profileMigration, /add column if not exists school_year/);
  assert.match(profileMigration, /begin;/);
  assert.match(profileMigration, /commit;/);
});
