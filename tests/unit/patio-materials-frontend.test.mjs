import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const patio = fs.readFileSync(path.join(root, 'server/patio.js'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/006_patio_telemetry.sql'), 'utf8');
const storageSql = fs.readFileSync(path.join(root, 'supabase/migrations/007_student_year_and_material_storage.sql'), 'utf8');

test('O Pátio possui chat geral, privado, moderação e subscrição Realtime', () => {
  assert.match(page, /Chat geral/);
  assert.match(page, /Mensagens privadas/);
  assert.match(page, /God Eye/);
  assert.match(page, /channel\('centro-patio:'/);
  assert.match(page, /from\('patio_messages'\)\.insert/);
  assert.match(sql, /patio_messages_read_scoped/i);
});

test('materiais de preparação usam URL assinada e registam telemetria do aluno', () => {
  assert.match(page, /createSignedUrl\(material\.storage_path,120/);
  assert.match(page, /from\('material_views'\)\.insert/);
  assert.match(page, /downloaded_at/);
  assert.match(sql, /material_views_student_insert/i);
  assert.match(storageSql, /study_materials_storage_read_scoped/i);
});

test('directório do Pátio limita os contactos às atribuições pedagógicas', () => {
  assert.match(patio, /role === 'student'/);
  assert.match(patio, /role === 'teacher'/);
  assert.match(patio, /teacher_student_subject_assignments/);
  assert.match(patio, /school_year/);
});
