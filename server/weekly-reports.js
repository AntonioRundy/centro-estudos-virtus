const {
  SUPABASE_URL, authenticate, serviceHeaders, HttpError, json, responseError,
  isTeachingProfile, getActiveTeacherAssignments,
} = require('../api/_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validId(value) { return UUID.test(String(value || '')); }
function cleanText(value, max, field, { required = false } = {}) {
  const text = String(value || '').trim();
  if (required && !text) throw new HttpError(400, `${field} é obrigatório.`);
  if (text.length > max) throw new HttpError(400, `${field} excede o limite permitido.`);
  return text;
}
function isMonday(value) {
  if (!DATE.test(String(value || ''))) return false;
  const day = new Date(`${value}T12:00:00`).getDay();
  return day === 1;
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
  if (!response.ok) throw new HttpError(response.status === 404 ? 503 : 400, apiError(data, 'Não foi possível concluir a operação de relatórios.'));
  return data;
}

async function namesForReports(reports) {
  if (!reports.length) return {};
  const profileIds = [...new Set(reports.flatMap(report => [report.teacher_id, report.student_id]))];
  const [profiles, subjects] = await Promise.all([
    rest(`profiles?select=id,full_name&id=in.(${profileIds.map(encodeURIComponent).join(',')})`),
    rest(`subjects?select=id,name&id=in.(${reports.map(report => encodeURIComponent(report.subject_id)).filter((id, index, list) => list.indexOf(id) === index).join(',')})`),
  ]);
  const names = {};
  for (const profile of profiles) names[profile.id] = profile.full_name;
  for (const subject of subjects) names[subject.id] = subject.name;
  return names;
}

async function reportsWithLessons(reports) {
  if (!reports.length) return [];
  const ids = reports.map(report => report.id).map(encodeURIComponent).join(',');
  const [lessons, names] = await Promise.all([
    rest(`weekly_report_lessons?select=id,report_id,lesson_date,duration_minutes,topics,sort_order&report_id=in.(${ids})&order=sort_order.asc`),
    namesForReports(reports),
  ]);
  const byReport = new Map();
  for (const lesson of lessons) {
    const items = byReport.get(lesson.report_id) || [];
    items.push(lesson);
    byReport.set(lesson.report_id, items);
  }
  return reports.map(report => ({
    id: report.id,
    teacherId: report.teacher_id,
    studentId: report.student_id,
    subjectId: report.subject_id,
    teacherName: names[report.teacher_id] || 'Professor',
    studentName: names[report.student_id] || 'Aluno',
    subjectName: names[report.subject_id] || 'Disciplina',
    weekStart: report.week_start,
    weekEnd: report.week_end,
    recommendations: report.recommendations || '',
    zeroLessonsReason: report.zero_lessons_reason || '',
    status: report.status,
    sentAt: report.sent_at,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
    lessons: byReport.get(report.id) || [],
  }));
}

async function teacherAssignments(profile) {
  const assignments = await getActiveTeacherAssignments(profile.id);
  if (assignments === null) throw new HttpError(503, 'Execute primeiro a migração 001 de contas e atribuições.');
  const active = assignments.filter(item => !item.ends_on || item.ends_on >= new Date().toISOString().slice(0, 10));
  if (!active.length) throw new HttpError(403, 'Não tem alunos e disciplinas atribuídos para criar relatórios.');
  const studentIds = [...new Set(active.map(item => item.student_id))];
  const subjectIds = [...new Set(active.map(item => item.subject_id))];
  const [students, subjects] = await Promise.all([
    rest(`profiles?select=id,full_name&id=in.(${studentIds.map(encodeURIComponent).join(',')})&order=full_name.asc`),
    rest(`subjects?select=id,name&id=in.(${subjectIds.map(encodeURIComponent).join(',')})&order=name.asc`),
  ]);
  const people = Object.fromEntries(students.map(item => [item.id, item.full_name]));
  const subjectNames = Object.fromEntries(subjects.map(item => [item.id, item.name]));
  return active.map(item => ({
    id: item.id, studentId: item.student_id, subjectId: item.subject_id,
    studentName: people[item.student_id] || 'Aluno', subjectName: subjectNames[item.subject_id] || 'Disciplina',
  }));
}

function parseLessons(value, weekStart) {
  if (!Array.isArray(value) || value.length > 14) throw new HttpError(400, 'Indique entre zero e catorze aulas na semana.');
  const week = Date.parse(`${weekStart}T12:00:00`), end = week + 6 * 86_400_000;
  return value.map((item, index) => {
    const lessonDate = String(item?.date || item?.lessonDate || '');
    const dateMs = Date.parse(`${lessonDate}T12:00:00`);
    const duration = Number(item?.durationMinutes);
    if (!DATE.test(lessonDate) || !Number.isFinite(dateMs) || dateMs < week || dateMs > end) throw new HttpError(400, 'A data de cada aula deve pertencer à semana seleccionada.');
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) throw new HttpError(400, 'A duração de cada aula deve estar entre 1 e 600 minutos.');
    return { lesson_date: lessonDate, duration_minutes: duration, topics: cleanText(item?.topics, 3000, 'Os tópicos da aula', { required: true }), sort_order: index };
  });
}

module.exports = async function handler(req, res) {
  try {
    const { profile } = await authenticate(req);
    if (req.method === 'GET') {
      let reports;
      if (profile.role === 'secretary') {
        reports = await rest('weekly_reports?select=id,teacher_id,student_id,subject_id,week_start,week_end,recommendations,zero_lessons_reason,status,sent_at,created_at,updated_at&status=eq.sent&order=sent_at.desc');
      } else if (isTeachingProfile(profile)) {
        reports = await rest(`weekly_reports?select=id,teacher_id,student_id,subject_id,week_start,week_end,recommendations,zero_lessons_reason,status,sent_at,created_at,updated_at&teacher_id=eq.${encodeURIComponent(profile.id)}&order=week_start.desc`);
      } else {
        throw new HttpError(403, 'Não tem permissão para consultar relatórios semanais.');
      }
      const payload = { reports: await reportsWithLessons(reports) };
      if (isTeachingProfile(profile)) payload.assignments = await teacherAssignments(profile);
      return json(res, 200, payload);
    }

    if (req.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
    if (!isTeachingProfile(profile)) throw new HttpError(403, 'Apenas professores podem criar relatórios semanais.');
    const { assignmentId, weekStart, recommendations, zeroLessonsReason, lessons, status } = req.body || {};
    if (!validId(assignmentId)) throw new HttpError(400, 'Seleccione um aluno e uma disciplina atribuídos.');
    if (!isMonday(weekStart)) throw new HttpError(400, 'Seleccione a segunda-feira da semana de referência.');
    const reportStatus = status === 'sent' ? 'sent' : status === 'draft' ? 'draft' : null;
    if (!reportStatus) throw new HttpError(400, 'O estado do relatório não é válido.');
    const assignments = await teacherAssignments(profile);
    const assignment = assignments.find(item => item.id === assignmentId);
    if (!assignment) throw new HttpError(403, 'Esta atribuição não pertence ao professor autenticado.');
    const safeLessons = parseLessons(lessons, weekStart);
    const safeRecommendations = cleanText(recommendations, 5000, 'As recomendações');
    const safeZeroReason = cleanText(zeroLessonsReason, 1500, 'A justificação');
    if (!safeLessons.length && !safeZeroReason) throw new HttpError(400, 'Indique uma justificação quando a semana não tiver aulas.');

    const matching = await rest(`weekly_reports?select=id,status&teacher_id=eq.${encodeURIComponent(profile.id)}&student_id=eq.${encodeURIComponent(assignment.studentId)}&subject_id=eq.${encodeURIComponent(assignment.subjectId)}&week_start=eq.${encodeURIComponent(weekStart)}&limit=1`);
    if (matching[0]?.status === 'sent') throw new HttpError(409, 'Este relatório já foi enviado à Secretaria e não pode ser alterado.');
    const record = {
      teacher_id: profile.id, student_id: assignment.studentId, subject_id: assignment.subjectId,
      week_start: weekStart, recommendations: safeRecommendations, zero_lessons_reason: safeZeroReason,
      status: reportStatus, sent_at: reportStatus === 'sent' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    let report;
    if (matching[0]) {
      const rows = await rest(`weekly_reports?id=eq.${encodeURIComponent(matching[0].id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(record) });
      report = rows[0];
      await rest(`weekly_report_lessons?report_id=eq.${encodeURIComponent(report.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    } else {
      const rows = await rest('weekly_reports', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(record) });
      report = rows[0];
    }
    if (safeLessons.length) await rest('weekly_report_lessons', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(safeLessons.map(item => ({ ...item, report_id: report.id }))),
    });
    const full = await rest(`weekly_reports?select=id,teacher_id,student_id,subject_id,week_start,week_end,recommendations,zero_lessons_reason,status,sent_at,created_at,updated_at&id=eq.${encodeURIComponent(report.id)}&limit=1`);
    return json(res, matching[0] ? 200 : 201, { report: (await reportsWithLessons(full))[0] });
  } catch (error) {
    return responseError(res, error);
  }
};
