const {
  SUPABASE_URL, SUPABASE_ANON_KEY, authenticate, serviceHeaders, HttpError, json,
  responseError, isTeachingProfile, isAdminTeacher, getActiveTeacherAssignments,
} = require('../api/_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}$/i;
const STATUSES = new Set(['online', 'working', 'away']);

function validId(value) { return UUID.test(String(value || '')); }
function cleanText(value, limit, label) {
  const text = String(value || '').trim();
  if (text.length > limit) throw new HttpError(400, `${label} excede o limite permitido.`);
  return text;
}
function apiError(data, fallback) {
  return String(data?.message || data?.error || data?.hint || fallback).replace(/\s+/g, ' ').slice(0, 180);
}

async function rest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 404 ? 503 : 400, apiError(data, 'Não foi possível actualizar o Radar Virtus.'));
  return data;
}

async function allowedStudentIds(profile) {
  if (profile.role === 'secretary' || isAdminTeacher(profile)) return null;
  if (!isTeachingProfile(profile)) throw new HttpError(403, 'Não tem permissão para consultar o Radar Virtus.');
  const assignments = await getActiveTeacherAssignments(profile.id);
  if (assignments === null) throw new HttpError(503, 'Execute primeiro a migração de contas e atribuições.');
  return [...new Set(assignments.map(item => String(item.student_id)))];
}

async function activityRowsFor(profile) {
  const allowed = await allowedStudentIds(profile);
  if (Array.isArray(allowed) && !allowed.length) return [];
  let query = 'current_student_activity?select=student_id,session_id,subject_id,status,current_activity,started_at,last_seen_at&order=last_seen_at.desc';
  if (Array.isArray(allowed)) query += `&student_id=in.(${allowed.map(encodeURIComponent).join(',')})`;
  const rows = await rest(query);
  if (!rows.length) return [];

  const studentIds = [...new Set(rows.map(item => item.student_id))];
  const subjectIds = [...new Set(rows.map(item => item.subject_id).filter(Boolean))];
  const [students, subjects] = await Promise.all([
    rest(`profiles?select=id,full_name,username&id=in.(${studentIds.map(encodeURIComponent).join(',')})`),
    subjectIds.length ? rest(`subjects?select=id,name&id=in.(${subjectIds.map(encodeURIComponent).join(',')})`) : [],
  ]);
  const people = new Map(students.map(item => [item.id, item]));
  const subjectNames = new Map(subjects.map(item => [item.id, item.name]));
  return rows.map(item => ({
    studentId: item.student_id,
    sessionId: item.session_id,
    studentName: people.get(item.student_id)?.full_name || people.get(item.student_id)?.username || 'Aluno',
    subjectId: item.subject_id || null,
    subjectName: item.subject_id ? (subjectNames.get(item.subject_id) || 'Disciplina') : 'Sem disciplina indicada',
    status: STATUSES.has(item.status) ? item.status : 'online',
    currentActivity: item.current_activity || 'Na plataforma',
    startedAt: item.started_at,
    lastSeenAt: item.last_seen_at,
  }));
}

async function saveHeartbeat(profile, body) {
  if (profile.role !== 'student') throw new HttpError(403, 'Apenas contas de aluno podem emitir presença.');
  const sessionId = String(body?.sessionId || '');
  if (!validId(sessionId)) throw new HttpError(400, 'A sessão do Radar não é válida. Atualize a página e tente novamente.');
  const status = String(body?.status || 'online');
  if (!STATUSES.has(status)) throw new HttpError(400, 'O estado de presença não é válido.');
  const subjectId = body?.subjectId ? String(body.subjectId) : null;
  if (subjectId && !validId(subjectId)) throw new HttpError(400, 'A disciplina indicada não é válida.');
  const now = new Date().toISOString();
  const rows = await rest('activity_heartbeats?on_conflict=student_id,session_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      student_id: profile.id,
      session_id: sessionId,
      subject_id: subjectId,
      status,
      current_activity: cleanText(body?.currentActivity, 500, 'A actividade actual') || 'Na plataforma',
      last_seen_at: now,
      client_updated_at: now,
      updated_at: now,
    }),
  });
  return rows[0] || null;
}

module.exports = async function handler(req, res) {
  try {
    const { profile } = await authenticate(req);
    if (req.method === 'GET') {
      if (profile.role === 'student') {
        return json(res, 200, {
          entries: [],
          realtime: { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, presenceTopic: `radar_virtus:${profile.id}` },
        });
      }
      const entries = await activityRowsFor(profile);
      return json(res, 200, {
        entries,
        realtime: { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY },
      });
    }
    if (req.method === 'POST') {
      const heartbeat = await saveHeartbeat(profile, req.body || {});
      return json(res, 200, { heartbeat });
    }
    if (req.method === 'DELETE') {
      if (profile.role !== 'student') throw new HttpError(403, 'Apenas contas de aluno podem encerrar a própria presença.');
      const sessionId = String(req.query?.sessionId || '');
      if (!validId(sessionId)) throw new HttpError(400, 'A sessão do Radar não é válida.');
      await rest(`activity_heartbeats?student_id=eq.${encodeURIComponent(profile.id)}&session_id=eq.${encodeURIComponent(sessionId)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      return json(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Método não permitido.');
  } catch (error) {
    return responseError(res, error);
  }
};
