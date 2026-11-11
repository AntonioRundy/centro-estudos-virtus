import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const provision = fs.readFileSync(path.join(root, 'api/admin/provision.js'), 'utf8');
const directory = fs.readFileSync(path.join(root, 'api/admin/directory.js'), 'utf8');
const stateApi = fs.readFileSync(path.join(root, 'api/state.js'), 'utf8');
const helpers = fs.readFileSync(path.join(root, 'api/_lib.js'), 'utf8');
const assetRead = fs.readFileSync(path.join(root, 'api/assets/read.js'), 'utf8');
const assetUpload = fs.readFileSync(path.join(root, 'api/assets/upload.js'), 'utf8');

test('cria uma matrícula activa ao criar a conta de aluno', () => {
  assert.match(provision, /account\.role === 'student'/);
  assert.match(provision, /student_enrollments/);
  assert.match(provision, /A conta foi revertida porque não foi possível criar a matrícula/);
});

test('Professor Administrador é autorizado pelo papel e não por uma flag adicional', () => {
  const authorizationBlock = provision.slice(provision.indexOf('async function authorize'), provision.indexOf('async function createAccount'));
  assert.match(authorizationBlock, /admin_teacher/);
  assert.doesNotMatch(authorizationBlock, /is_superadmin/);
});

test('directório não expõe contas fora dos papéis pedagógicos', () => {
  assert.match(directory, /role=in\.\(admin_teacher,teacher,student\)/);
  assert.match(directory, /isAdminTeacher/);
});

test('Professor normal recebe apenas o estado filtrado pelas atribuições activas', () => {
  assert.match(stateApi, /getActiveTeacherAssignments\(profile\.id\)/);
  assert.match(stateApi, /teacherState\(stored\.state, assignments\)/);
  assert.match(helpers, /allowedStudentIds/);
  assert.match(helpers, /task\?\.type !== 'group'/);
});

test('versão-ponte reconhece administrador legado até a migração ser aplicada', () => {
  assert.match(helpers, /canonicalRole\(profile\?\.role\) === 'admin_teacher'/);
  assert.match(helpers, /if \(response\.status === 404/);
  assert.match(stateApi, /if \(assignments === null\)/);
});

test('gravações de Professor são fundidas apenas dentro do seu âmbito', () => {
  assert.match(stateApi, /async function acceptTeacherChanges/);
  assert.match(stateApi, /Dados de outros alunos nunca são aceites/);
  assert.match(stateApi, /mergeOwnedById/);
  assert.match(stateApi, /isAdminTeacher\(profile\) \? incoming/);
});

test('ficheiros de tarefas verificam o âmbito do professor antes do acesso ou upload', () => {
  assert.match(assetRead, /getActiveTeacherAssignments\(profile\.id\)/);
  assert.match(assetRead, /teacherState\(stored\.state/);
  assert.match(assetUpload, /activityIsWithinTeacherScope/);
  assert.match(assetUpload, /A atividade não está atribuída apenas aos seus alunos/);
});
