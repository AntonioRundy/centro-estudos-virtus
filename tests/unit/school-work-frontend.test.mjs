import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/004_school_work.sql'), 'utf8');

test('a submissão do aluno usa o caminho privado exigido pelo bucket school_tasks', () => {
  assert.match(page, /school-work\/'\+authProfile\.id\+'\/'\+id\+'\/'\+schoolSafeFileName/);
  assert.match(page, /storage\.from\('school_tasks'\)\.upload/);
  assert.match(page, /file\.size>50\*1024\*1024/);
  assert.match(page, /application\/pdf/);
  assert.match(sql, /school_tasks_student_upload_own/i);
});

test('a agenda envia apenas os tipos de evento validados pela base', () => {
  assert.match(page, /option value="worksheet">Ficha/);
  assert.match(page, /option value="test">Teste/);
  assert.match(page, /option value="global_exam">Prova Global/);
  assert.match(page, /schoolAssessmentTypeLabel/);
  assert.match(sql, /event_type in \('worksheet', 'test', 'global_exam'\)/i);
});

test('a equipa descarrega anexos privados através de URL assinada e mantém o RLS como fonte de autorização', () => {
  assert.match(page, /createSignedUrl\(item\.attachment_path,120/);
  assert.match(page, /O acesso aos registos e anexos é limitado pelas permissões da sua conta/);
  assert.match(sql, /school_work_items_read_scoped/i);
  assert.match(sql, /school_tasks_read_scoped/i);
});
