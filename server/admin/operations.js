const {
  SUPABASE_URL, authenticate, serviceHeaders, HttpError, json, responseError,
} = require('../../api/_lib');
const { canonicalRole } = require('../../lib/roles');

function body(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Pedido inválido.'); }
  }
  return req.body || {};
}
function management(profile) { return ['admin_teacher', 'secretary'].includes(canonicalRole(profile?.role)); }
function teacher(profile) { return ['admin_teacher', 'teacher'].includes(canonicalRole(profile?.role)); }
async function rest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 403 ? 403 : 503, data.message || data.error || 'Não foi possível concluir a operação.');
  return data;
}
function clean(value, label, min = 1, max = 500) {
  const result = String(value || '').trim().replace(/\s+/g, ' ');
  if (result.length < min || result.length > max) throw new HttpError(400, `${label} inválido.`);
  return result;
}
async function directory() {
  const [profiles, subjects, enrollments, credentials, schedules, reports, notices, assignments] = await Promise.all([
    rest('profiles?select=id,full_name,username,role,school_year,is_active&order=full_name.asc'),
    rest('subjects?select=id,name,active&order=name.asc'),
    rest('student_enrollments?select=student_id,school_year,class_name,guardian_email,active'),
    rest('onboarding_credentials?select=id,student_id,username,virtual_email,guardian_email,credential_status,temporary_password_last4,delivered_at,validated_at,created_at&order=created_at.desc'),
    rest('schedules?select=id,student_id,subject_id,days_of_week,start_time,end_time,notes,active,created_at&order=start_time.asc'),
    rest('teacher_reports?select=*&order=created_at.desc'),
    rest('notices?select=*&order=published_at.desc'),
    rest('teacher_student_subject_assignments?select=id,teacher_id,student_id,subject_id,is_primary,starts_on,ends_on'),
  ]);
  return { profiles, subjects, enrollments, credentials, schedules, reports, notices, assignments };
}
async function teacherDirectory(profile) {
  const assignments = await rest(`teacher_student_subject_assignments?select=id,teacher_id,student_id,subject_id,is_primary,starts_on,ends_on&teacher_id=eq.${encodeURIComponent(profile.id)}`);
  const ids = [...new Set(assignments.map(item => item.student_id).filter(Boolean))];
  const students = ids.length ? await rest(`profiles?select=id,full_name,username,school_year,is_active&id=in.(${ids.map(encodeURIComponent).join(',')})&order=full_name.asc`) : [];
  const subjects = await rest('subjects?select=id,name,active&active=eq.true&order=name.asc');
  return { assignments, students, subjects };
}
async function classes() {
  const [overview, assignments, profiles, enrollments, subjects] = await Promise.all([
    rest('enrolled_class_overview?select=teacher_id,teacher_name,class_name,student_count&order=teacher_name.asc,class_name.asc'),
    rest('teacher_student_subject_assignments?select=teacher_id,student_id,subject_id,is_primary'),
    rest('profiles?select=id,full_name,username,role&order=full_name.asc'),
    rest('student_enrollments?select=student_id,class_name,school_year,active'),
    rest('subjects?select=id,name'),
  ]);
  return { overview, assignments, profiles, enrollments, subjects };
}
function validWeekdays(value) {
  const days = Array.isArray(value) ? value.map(Number) : [];
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new HttpError(400, 'Seleccione ao menos um dia da semana.');
  return [...new Set(days)].sort((a, b) => a - b);
}
async function post(req, profile) {
  const input = body(req);
  if (input.action === 'schedule') {
    if (!management(profile)) throw new HttpError(403, 'Apenas a Secretaria ou a Administração pode gerir horários.');
    const studentId = clean(input.studentId, 'Aluno', 20, 64);
    const subjectId = clean(input.subjectId, 'Disciplina', 20, 64);
    const start = clean(input.startTime, 'Hora de início', 4, 8);
    const end = clean(input.endTime, 'Hora de fim', 4, 8);
    const rows = await rest('schedules', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ student_id: studentId, subject_id: subjectId, days_of_week: validWeekdays(input.daysOfWeek), start_time: start, end_time: end, notes: String(input.notes || '').trim() || null, active: true, created_by: profile.id }) });
    return { schedule: rows[0] };
  }
  if (input.action === 'notice') {
    if (!management(profile)) throw new HttpError(403, 'Apenas a Secretaria ou a Administração pode publicar avisos.');
    const rows = await rest('notices', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ title: clean(input.title, 'Título', 3, 180), body: clean(input.message, 'Mensagem', 3, 5000), audience: input.audience === 'all' ? 'all' : 'teachers', author_id: profile.id, published_at: new Date().toISOString() }) });
    return { notice: rows[0] };
  }
  if (input.action === 'credential-delivered') {
    if (!management(profile)) throw new HttpError(403, 'Apenas a Secretaria ou a Administração pode confirmar credenciais.');
    const id = clean(input.credentialId, 'Credencial', 20, 64);
    const rows = await rest(`onboarding_credentials?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ credential_status: 'delivered', delivered_at: new Date().toISOString(), delivered_by: profile.id }) });
    return { credential: rows[0] };
  }
  if (input.action === 'subject') {
    if (!management(profile)) throw new HttpError(403, 'Apenas a Secretaria ou a Administração pode criar disciplinas.');
    const rows = await rest('subjects', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: clean(input.name, 'Disciplina', 2, 120), active: true }) });
    return { subject: rows[0] };
  }
  throw new HttpError(400, 'Operação desconhecida.');
}

module.exports = async function handler(req, res) {
  try {
    const { profile } = await authenticate(req);
    if (req.method === 'GET') {
      const section = String(req.query?.section || new URL(req.url, 'http://localhost').searchParams.get('section') || '');
      if (section === 'secretary') {
        if (!management(profile)) throw new HttpError(403, 'Acesso reservado à Secretaria e Administração.');
        return json(res, 200, await directory());
      }
      if (section === 'teacher') {
        if (!teacher(profile)) throw new HttpError(403, 'Acesso reservado a docentes.');
        return json(res, 200, await teacherDirectory(profile));
      }
      if (section === 'classes') {
        if (canonicalRole(profile.role) !== 'admin_teacher') throw new HttpError(403, 'Acesso reservado ao Professor Administrador.');
        return json(res, 200, await classes());
      }
      throw new HttpError(400, 'Secção desconhecida.');
    }
    if (req.method === 'POST') return json(res, 201, await post(req, profile));
    return json(res, 405, { error: 'Método não permitido.' });
  } catch (error) { return responseError(res, error); }
};
