import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/002_weekly_reports.sql'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'server/weekly-reports.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('relatórios semanais guardam a semana, disciplina, professor e aluno de forma separada', () => {
  assert.match(sql, /create table if not exists public\.weekly_reports/i);
  assert.match(sql, /teacher_id uuid not null references public\.profiles/i);
  assert.match(sql, /student_id uuid not null references public\.profiles/i);
  assert.match(sql, /subject_id uuid not null references public\.subjects/i);
  assert.match(sql, /unique \(teacher_id, student_id, subject_id, week_start\)/i);
  assert.match(sql, /extract\(isodow from week_start\) = 1/i);
});

test('cada aula de relatório é validada na base e os relatórios enviados ficam imutáveis para o professor', () => {
  assert.match(sql, /create table if not exists public\.weekly_report_lessons/i);
  assert.match(sql, /duration_minutes integer not null check \(duration_minutes between 1 and 600\)/i);
  assert.match(sql, /char_length\(trim\(topics\)\) between 2 and 3000/i);
  assert.match(sql, /weekly_reports_teacher_update_draft/i);
  assert.match(sql, /auth\.uid\(\) = teacher_id\s+and status = 'draft'/i);
  assert.match(sql, /report\.status = 'draft'/i);
});

test('a API só aceita atribuições activas do professor autenticado', () => {
  assert.match(handler, /const assignments = await teacherAssignments\(profile\)/);
  assert.match(handler, /assignments\.find\(item => item\.id === assignmentId\)/);
  assert.match(handler, /Esta atribuição não pertence ao professor autenticado/i);
  assert.match(handler, /if \(matching\[0\]\?\.status === 'sent'\)/);
});

test('a interface inclui rascunho, envio à Secretaria e PDF A4 local', () => {
  assert.match(page, /Guardar rascunho/);
  assert.match(page, /Enviar para Secretaria/);
  assert.match(page, /Gerar \/ guardar PDF/);
  assert.match(page, /assets\/vendor\/html2pdf\.bundle\.min\.js/);
  assert.match(page, /format:'a4'/);
  assert.match(page, /window\.html2pdf/);
  assert.match(page, /print-weekly-report/);
});
