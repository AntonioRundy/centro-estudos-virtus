import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('Centro Tasks usa tabelas e buckets privados da migração 005', () => {
  for (const value of ['center_tasks', 'task_assignments', 'task_submissions', 'school_grades', "center_task_files", "center_task_submissions"]) {
    assert.match(html, new RegExp(value));
  }
  assert.match(html, /teacher-tasks\/'\+authProfile\.id\+'\/'\+id/);
  assert.match(html, /submissions\/'\+authProfile\.id\+'\/'\+task\.id/);
  assert.match(html, /createSignedUrl\(path,120/);
});

test('a submissão não tenta actualizar task_assignments como aluno', () => {
  const section = html.slice(html.indexOf('async function submitCenterTaskResponse'), html.indexOf('async function saveCenterTaskGrade'));
  assert.match(section, /from\('task_submissions'\)\.insert/);
  assert.doesNotMatch(section, /from\('task_assignments'\)\.update/);
});

test('o Virtus Detector é iniciado ao resolver uma tarefa sem bloquear por dispositivo', () => {
  assert.match(html, /function openCenterTaskDetector/);
  assert.match(html, /function beginCenterTaskDetector/);
  assert.match(html, /basic_monitoring_fallback/);
  assert.match(html, /Monitoria básica ativa sem câmara\/microfone/);
  assert.match(html, /data-action="open-center-task"/);
});

test('a validação de notas escolares respeita a escala', () => {
  const section = html.slice(html.indexOf('async function submitCenterGrade'), html.indexOf('async function openCenterStorage'));
  assert.match(section, /gradeValue<0\|\|gradeValue>scale/);
  assert.match(section, /assessment_type:assessmentType/);
});
