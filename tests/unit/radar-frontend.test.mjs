import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'server/radar.js'), 'utf8');

test('o aluno mantém presença persistida a cada 60 segundos e atualiza-a ao trocar de separador', () => {
  assert.match(page, /setInterval\(sendRadarHeartbeat,60000\)/);
  assert.match(page, /document\.addEventListener\('visibilitychange'.*sendRadarHeartbeat/);
  assert.match(page, /status:radarStatus\(\),subjectId:radarSubjectId\(\),currentActivity:radarActivity\(\)/);
  assert.match(page, /radarConfig\?\.presenceTopic/);
});

test('a gestão recebe mudanças em tempo real e conserva consulta periódica como contingência', () => {
  assert.match(page, /postgres_changes'.*activity_heartbeats/);
  assert.match(page, /setInterval\(\(\)=>\{if\(view==='radar'&&mode!=='student'\)loadRadar\(true\)\},25000\)/);
  assert.match(handler, /current_student_activity/);
  assert.match(page, /Nenhum aluno activo neste momento/);
});

test('a API ignora identificadores de aluno enviados pelo navegador e aplica o escopo no servidor', () => {
  assert.match(handler, /student_id: profile\.id/);
  assert.match(handler, /getActiveTeacherAssignments\(profile\.id\)/);
  assert.match(handler, /profile\.role === 'secretary' \|\| isAdminTeacher\(profile\)/);
  assert.match(handler, /current_student_activity/);
});
