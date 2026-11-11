const { isTeachingRole, canonicalRole } = require('../lib/roles');

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
const SUPABASE_SERVER_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.end(JSON.stringify(payload));
}

function requireConfiguration({ server = false } = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || (server && !SUPABASE_SERVER_KEY)) {
    throw new HttpError(503, 'A ligação segura à base de dados ainda não está configurada.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = {
    apikey: SUPABASE_SERVER_KEY,
    'Content-Type': 'application/json',
    ...extra,
  };
  // Secret API keys (sb_secret_*) are not JWTs; only legacy service_role JWTs belong in Authorization.
  if (/^eyJ[A-Za-z0-9_-]+\./.test(SUPABASE_SERVER_KEY)) headers.Authorization = 'Bearer ' + SUPABASE_SERVER_KEY;
  return headers;
}

function isTeachingProfile(profile) {
  return isTeachingRole(profile?.role);
}

function isAdminTeacher(profile) {
  return canonicalRole(profile?.role) === 'admin_teacher';
}

async function getActiveTeacherAssignments(teacherId) {
  const today = new Date().toISOString().slice(0, 10);
  const query = new URLSearchParams({
    select: 'student_id,subject_id', teacher_id: `eq.${teacherId}`,
    starts_on: `lte.${today}`, or: `(ends_on.is.null,ends_on.gte.${today})`,
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/teacher_student_subject_assignments?${query}`, {
    headers: serviceHeaders(),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    // A versão-ponte pode ser publicada antes da migração. Enquanto a tabela
    // ainda não existir, conserva o comportamento legado; depois da migração,
    // uma lista vazia significa correctamente que não há atribuições.
    if (response.status === 404 && /not found|does not exist|schema cache|PGRST205/i.test(JSON.stringify(detail))) return null;
    throw new HttpError(503, 'Não foi possível validar as atribuições do professor.');
  }
  return response.json();
}

function teacherState(state, assignmentRows) {
  if (!state) return null;
  const allowedStudentIds = new Set((assignmentRows || []).map(item => String(item.student_id)));
  const copy = structuredClone(state);
  const allowed = item => allowedStudentIds.has(String(item?.studentId));
  const allowedStudents = (state.students || []).filter(student => allowedStudentIds.has(String(student.id)));
  const allowedTaskIds = new Set((state.tasks || []).filter(task =>
    task?.type !== 'group' && Array.isArray(task.assignedStudents) && task.assignedStudents.some(id => allowedStudentIds.has(String(id)))
  ).map(task => String(task.id)));
  const allowedQuizIds = new Set((state.quizzes || []).filter(quiz =>
    Array.isArray(quiz.assignedStudents) && quiz.assignedStudents.some(id => allowedStudentIds.has(String(id)))
  ).map(quiz => String(quiz.id)));

  copy.students = allowedStudents;
  // Os materiais de aula antigos não têm autor, aluno nem disciplina. Até à
  // migração do módulo de Preparação para Provas, não são expostos a docentes
  // comuns por uma rota que não consegue provar o respectivo âmbito.
  copy.lessons = [];
  copy.groupAllocations = Object.fromEntries(Object.entries(state.groupAllocations || {})
    .filter(([studentId]) => allowedStudentIds.has(String(studentId))));
  copy.tasks = (state.tasks || []).filter(task => allowedTaskIds.has(String(task.id)));
  copy.quizzes = (state.quizzes || []).filter(quiz => allowedQuizIds.has(String(quiz.id)));
  copy.submissions = (state.submissions || []).filter(allowed);
  copy.quizAttempts = (state.quizAttempts || []).filter(allowed);
  copy.taskSubmissions = (state.taskSubmissions || []).filter(item => allowed(item) && allowedTaskIds.has(String(item.taskId)));
  copy.provisionalGrades = (state.provisionalGrades || []).filter(allowed);
  copy.assessmentGrades = (state.assessmentGrades || []).filter(allowed);
  copy.attendanceSessions = (state.attendanceSessions || []).map(session => {
    const records = Object.fromEntries(Object.entries(session.records || {})
      .filter(([studentId]) => allowedStudentIds.has(String(studentId))));
    const attendance = Object.fromEntries(Object.entries(session.attendance || {})
      .filter(([studentId]) => allowedStudentIds.has(String(studentId))));
    return { ...session, records, attendance };
  });
  copy.notifications = (state.notifications || []).filter(item => item?.audience !== 'teachers' ||
    allowedTaskIds.has(String(item.targetId)) || allowedQuizIds.has(String(item.targetId)));
  return copy;
}

async function authenticate(req) {
  requireConfiguration({ server: true });
  const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Inicie sessão para continuar.');
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new HttpError(401, 'A sessão expirou. Entre novamente.');
  const user = await response.json();
  const profileResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=id,username,full_name,role,must_change_password&id=eq.${encodeURIComponent(user.id)}`,
    { headers: serviceHeaders() },
  );
  if (!profileResponse.ok) throw new HttpError(503, 'Não foi possível validar o perfil da conta.');
  const profiles = await profileResponse.json();
  if (!profiles[0]) throw new HttpError(403, 'Esta conta não está associada à turma.');
  const profile = { ...profiles[0], is_superadmin: false };
  // The administrative flag was introduced after the first production schema.
  // Its absence must not prevent students and teachers from signing in.
  const adminFlagResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=is_superadmin&id=eq.${encodeURIComponent(user.id)}`,
    { headers: serviceHeaders() },
  );
  if (adminFlagResponse.ok) {
    const adminRows = await adminFlagResponse.json();
    profile.is_superadmin = adminRows[0]?.is_superadmin === true;
  }
  return { token, user, profile };
}

async function getStoredState() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/course_state?select=state,updated_at&id=eq.true`, {
    headers: serviceHeaders(),
  });
  if (!response.ok) throw new HttpError(503, 'Não foi possível carregar os dados da turma.');
  const rows = await response.json();
  return { state: rows[0]?.state || null, revision: rows[0]?.updated_at || null };
}

async function saveStoredState(state, expectedRevision) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_course_state`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ p_state: state, p_expected_updated_at: expectedRevision || null }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    if (response.status === 409 || detail.code === '40001' || String(detail.message || '').includes('STATE_CONFLICT')) {
      throw new HttpError(409, 'Outro docente atualizou os dados da turma. Recarregue a página antes de continuar a guardar.');
    }
    const message = String(detail.message || detail.error_description || detail.error || '').replace(/\s+/g, ' ').slice(0, 140);
    throw new HttpError(503, "Não foi possível guardar os dados no servidor (HTTP " + response.status + (message ? ": " + message : "") + ").");
  }
  return { revision: await response.json() };
}

async function getRoster() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,full_name,username,created_at&role=eq.student&order=full_name.asc`, {
    headers: serviceHeaders(),
  });
  if (!response.ok) throw new HttpError(503, 'Não foi possível carregar a lista de alunos.');
  return response.json();
}

function normalizedName(value) {
  return String(value || '').normalize('NFC').trim().toLocaleLowerCase('pt-PT');
}

function quizAvailableToStudent(quiz, group, studentIds, { includeHidden = false } = {}) {
  if (!quiz || quiz.published !== true || (!includeHidden && quiz.visibleToStudents === false)) return false;
  const ids = new Set((studentIds || []).filter(Boolean).map(String));
  if (Array.isArray(quiz.assignedGroups) && !quiz.assignedGroups.includes(group)) return false;
  if (Array.isArray(quiz.assignedStudents) && !quiz.assignedStudents.some(id => ids.has(String(id)))) return false;
  return true;
}

function studentState(state, profile) {
  if (!state) return null;
  const student = (state.students || []).find(item => item.id === profile.id || normalizedName(item.name) === normalizedName(profile.full_name));
  if (!student) throw new HttpError(403, 'A conta ainda não está ligada a um aluno matriculado.');
  const studentId = student.id;
  const group = state.groupAllocations?.[studentId] || '';
  const submissions = (state.submissions || []).filter(item => item.studentId === studentId);
  const taskSubmissions = (state.taskSubmissions || []).filter(item =>
    item.studentId === studentId || (group && item.team === group && (state.tasks || []).some(task => task.id === item.taskId && task.type === 'group'))
  );
  const attendanceSessions = (state.attendanceSessions || []).map(session => {
    const records = session.records && typeof session.records === 'object' ? session.records : {};
    const attendance = session.attendance && typeof session.attendance === 'object' ? session.attendance : {};
    return {
      ...session,
      records: records[studentId] ? { [studentId]: records[studentId] } : {},
      attendance: attendance[studentId] ? { [studentId]: attendance[studentId] } : {},
    };
  });

  // Never disclose quiz questions, task descriptions or attached files that are not available to this student.
  // Minimal availability metadata supports clear empty-state messages without weakening authorization.
  const studentIds = [studentId, profile.id];
  const publishedQuizzes = (state.quizzes || []).filter(item =>
    quizAvailableToStudent(item, group, studentIds, { includeHidden: true })
  );
  const safeQuizzes = publishedQuizzes.filter(item => quizAvailableToStudent(item, group, studentIds)).map(quiz => ({
    ...quiz,
    questions: (quiz.questions || []).map(question => {
      const { correct, correctIndex, answer, answerKey, solution, ...safeQuestion } = question;
      return safeQuestion;
    }),
  }));
  const allTasks = state.tasks || [];
  const unavailableGroupTasks = allTasks
    .filter(item => item.type === 'group' && item.published && !(Array.isArray(item.assignedGroups) ? item.assignedGroups : []).includes(group))
    .map(item => ({ assignedGroups: Array.isArray(item.assignedGroups) ? item.assignedGroups : [] }));
  const visibleTasks = allTasks.filter(item => {
    if (!item.published) return false;
    if (item.type === 'group') return (Array.isArray(item.assignedGroups) ? item.assignedGroups : []).includes(group);
    return (Array.isArray(item.assignedStudents) ? item.assignedStudents : []).includes(studentId);
  });
  return {
    ...state,
    students: [student],
    quizzes: safeQuizzes,
    quizAttempts: (state.quizAttempts || []).filter(item => studentIds.includes(item.studentId)),
    tasks: visibleTasks,
    submissions,
    taskSubmissions,
    provisionalGrades: (state.provisionalGrades || []).filter(item => item.studentId === studentId),
    assessmentGrades: (state.assessmentGrades || []).filter(item => item.studentId === studentId),
    attendanceSessions,
    notifications: (state.notifications || []).filter(item => item.audience === 'students' &&
      (!Array.isArray(item.recipientIds) || item.recipientIds.some(id => studentIds.includes(id))) &&
      (!item.recipientId || studentIds.includes(item.recipientId))).map(({ recipientIds, recipientId, readBy, ...item }) => ({
        ...item, readBy: Array.isArray(readBy) ? readBy.filter(id => studentIds.includes(id)) : [],
      })),
    groupAllocations: group ? { [studentId]: group } : {},
    availability: {
      hiddenQuizCount: publishedQuizzes.filter(item => item.visibleToStudents === false).length,
      unavailableGroupTasks,
    },
  };
}

function responseError(res, error) {
  const status = Number(error?.status) || 500;
  return json(res, status, { error: error instanceof HttpError || status < 500 ? error.message : 'O servidor não conseguiu concluir o pedido.' });
}

module.exports = {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVER_KEY, HttpError,
  json, requireConfiguration, serviceHeaders, authenticate, getStoredState,
  saveStoredState, getRoster, studentState, quizAvailableToStudent, responseError,
  isTeachingProfile, isAdminTeacher, getActiveTeacherAssignments, teacherState,
};
