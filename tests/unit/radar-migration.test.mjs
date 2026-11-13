import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/003_radar_heartbeats.sql'), 'utf8');

test('o Radar guarda uma sessão por aluno em vez de um único estado global', () => {
  assert.match(sql, /create table if not exists public\.activity_heartbeats/i);
  assert.match(sql, /student_id uuid not null references public\.profiles/i);
  assert.match(sql, /session_id uuid not null/i);
  assert.match(sql, /unique \(student_id, session_id\)/i);
  assert.match(sql, /status in \('online', 'working', 'away'\)/i);
});

test('o Radar limita leitura aos alunos atribuídos e permite à Secretaria e Administração visão global', () => {
  assert.match(sql, /create or replace function private\.can_read_radar_student/i);
  assert.match(sql, /private\.current_profile_role\(\) in \('admin_teacher', 'secretary'\)/i);
  assert.match(sql, /assignment\.teacher_id = auth\.uid\(\)/i);
  assert.match(sql, /activity_heartbeats_read_scoped/i);
});

test('Presence usa canais privados por aluno e a actividade persistida respeita RLS', () => {
  assert.match(sql, /realtime\.topic\(\) = \('radar_virtus:' \|\| auth\.uid\(\)::text\)/i);
  assert.match(sql, /radar_presence_read_scoped/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.activity_heartbeats/i);
  assert.match(sql, /with \(security_invoker = true\)/i);
  assert.match(sql, /create or replace view public\.current_student_activity/i);
});
