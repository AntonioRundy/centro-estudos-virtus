const {
  HttpError, authenticate, getStoredState, getRoster, saveStoredState,
  studentState, quizAvailableToStudent, json, responseError,
} = require('./_lib');

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function validAnswers(quiz, answers, allowUnanswered = false) {
  const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  if (!Array.isArray(answers) || answers.length !== questions.length || !questions.length) return false;
  return answers.every((answer, index) => {
    const question = questions[index] || {};
    const options = Array.isArray(question.options) ? question.options : [];
    if (question.type === 'open') return typeof answer === 'string' && answer.length <= 5000 && (allowUnanswered || answer.trim().length > 0);
    if (question.type === 'multiple') return Array.isArray(answer) && (allowUnanswered || answer.length > 0) && new Set(answer).size === answer.length && answer.every(n => Number.isInteger(n) && n >= 0 && n < options.length);
    if (question.type === 'match') return Array.isArray(answer) && answer.length === (Array.isArray(question.labels) ? question.labels.length : 0) && new Set(answer.filter(Number.isInteger)).size === answer.filter(Number.isInteger).length && answer.every(n => (allowUnanswered && n === null) || (Number.isInteger(n) && n >= 0 && n < options.length));
    return question.type === 'single' && ((allowUnanswered && answer === null) || (Number.isInteger(answer) && answer >= 0 && answer < options.length));
  });
}
function sanitizeIntegrity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safeNumber = (item, min, max) => item === null || item === undefined || item === '' ? null : Number.isFinite(Number(item)) ? Math.max(min, Math.min(max, Number(item))) : null;
  const count = item => safeNumber(item, 0, 100000) ?? 0;
  const events = (Array.isArray(value.events) ? value.events : []).slice(-120).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.type !== 'string') return [];
    const timestamp = Date.parse(item.timestamp);
    if (!Number.isFinite(timestamp)) return [];
    return [{ type: item.type.slice(0, 48), label: String(item.label || '').slice(0, 180), timestamp: new Date(timestamp).toISOString(), points: safeNumber(item.points, 0, 10) ?? 0 }];
  });
  const photos = (Array.isArray(value.photos) ? value.photos : []).slice(0, 8).flatMap(photo => {
    const dataUrl = String(photo?.dataUrl || ''), capturedAt = Date.parse(photo?.capturedAt);
    if (!/^data:image\/(jpeg|jpg);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) || dataUrl.length > 450000 || !Number.isFinite(capturedAt)) return [];
    return [{ dataUrl, capturedAt: new Date(capturedAt).toISOString() }];
  });
  const inputStats = value.stats && typeof value.stats === 'object' ? value.stats : {};
  const noiseIndex = safeNumber(value.noiseIndex ?? inputStats.noiseIndex, 0, 100);
  const noiseSeconds = safeNumber(value.noiseSeconds ?? inputStats.noiseSeconds, 0, 86400) ?? 0;
  const start = Date.parse(value.startedAt), end = Date.parse(value.endedAt);
  const headPoseDeviations = count(inputStats.headPoseDeviations ?? value.headPoseEvents);
  const gazeDeviations = count(inputStats.gazeDeviations ?? value.gazeDeviationEvents);
  const visualGestures = count(inputStats.visualGestures ?? (headPoseDeviations + gazeDeviations));
  const calibrationCorners = Array.isArray(value.calibrationCorners)
    ? [...new Set(value.calibrationCorners.filter(corner => ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(corner)))]
    : [];
  const basicMonitoringFallback = value.basic_monitoring_fallback === true;
  return {
    startedAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
    endedAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
    durationSeconds: safeNumber(value.durationSeconds, 0, 86400),
    cameraStatus: String(value.cameraStatus || 'Não registada').slice(0, 80),
    microphoneStatus: String(value.microphoneStatus || 'Não registado').slice(0, 80),
    fullscreenStatus: String(value.fullscreenStatus || 'Não registado').slice(0, 80),
    audioPolicy: basicMonitoringFallback
      ? 'Monitoria básica: apenas vídeo; áudio e análise biométrica desativados.'
      : 'Intensidade RMS por segundo; áudio bruto não gravado nem guardado.',
    basic_monitoring_fallback: basicMonitoringFallback,
    noiseIndex, noiseSeconds,
    stats: {
      noiseIndex, noiseSeconds,
      multipleFaces: count(inputStats.multipleFaces),
      visualGestures, headPoseDeviations, gazeDeviations,
    },
    faceDetectionAvailable: value.faceDetectionAvailable === true,
    poseDetectionAvailable: value.poseDetectionAvailable === true,
    gazeTrackingAvailable: value.gazeTrackingAvailable === true,
    calibrationCorners,
    integrityIndex: safeNumber(value.integrityIndex, 0, 100),
    events, photos,
    evidenceStatus: 'Sinais do navegador não verificados independentemente; requerem revisão docente.',
  };
}

async function acceptStudentChanges(incoming, current, profile) {
  if (!current) throw new HttpError(409, 'O professor ainda não preparou a sala.');
  const studentId = profile.id;
  const rosterStudent = (current.students || []).find(item =>
    item.id === studentId ||
    String(item.name || '').normalize('NFC').trim().toLocaleLowerCase('pt-PT') === String(profile.full_name || '').normalize('NFC').trim().toLocaleLowerCase('pt-PT')
  );
  if (!rosterStudent) throw new HttpError(403, 'A conta ainda não está ligada a um aluno matriculado.');
  const sourceStudentId = rosterStudent.id;
  const group = current.groupAllocations?.[sourceStudentId] || current.groupAllocations?.[studentId] || '';
  const quizzes = current.quizzes || [];
  const tasks = current.tasks || [];
  const accepted = structuredClone(current);
  accepted.submissions ||= [];
  accepted.quizAttempts ||= [];
  accepted.taskSubmissions ||= [];
  accepted.notifications ||= [];
  const addTeacherNotification = (kind, title, message, targetId) => {
    accepted.notifications.unshift({
      id: require('node:crypto').randomUUID(), audience: 'teachers', kind, title, message,
      targetId: targetId || '', createdAt: new Date().toISOString(), readBy: [],
    });
    accepted.notifications = accepted.notifications.slice(0, 100);
  };

  for (const item of Array.isArray(incoming?.submissions) ? incoming.submissions : []) {
    if (!item || item.studentId !== studentId || !isUuid(item.id) ||
        accepted.submissions.some(old => old.id === item.id || (old.studentId === studentId && old.quizId === item.quizId))) continue;
    const quiz = quizzes.find(candidate => candidate.id === item.quizId &&
      quizAvailableToStudent(candidate, group, [sourceStudentId, studentId]) &&
      (!candidate.dueDate || candidate.dueDate >= new Date().toISOString().slice(0, 10)));
    if (!quiz) continue;
    const now = Date.now();
    let attempt = null, allowUnanswered = false;
    if (Number.isInteger(Number(quiz.durationMinutes)) && Number(quiz.durationMinutes) > 0) {
      attempt = accepted.quizAttempts.find(candidate => candidate.id === item.attemptId &&
        candidate.studentId === studentId && candidate.quizId === quiz.id && candidate.status === 'in_progress');
      if (!attempt) continue;
      const deadline = Date.parse(attempt.deadlineAt);
      if (!Number.isFinite(deadline) || now > deadline + 90000) continue;
      allowUnanswered = now >= deadline - 3000 && item.autoSubmitted === true;
      if (item.autoSubmitted === true && !allowUnanswered) continue;
    }
    if (!validAnswers(quiz, item.answers, allowUnanswered)) continue;
    if (attempt) attempt.status = allowUnanswered ? 'expired_submitted' : 'submitted';
    accepted.submissions.push({
      id: item.id, studentId, quizId: quiz.id, answers: item.answers,
      attemptId: attempt?.id || null, autoSubmitted: !!allowUnanswered,
      integrity: sanitizeIntegrity(item.integrity),
      manualStatus: 'pending', submittedAt: new Date().toISOString(),
    });
    addTeacherNotification('submission', 'Nova resposta a questionário',
      `${rosterStudent.name || profile.full_name} submeteu ${String(quiz.title || 'um questionário').slice(0, 120)}.`, quiz.id);
  }

  for (const item of Array.isArray(incoming?.taskSubmissions) ? incoming.taskSubmissions : []) {
    if (!item || !isUuid(item.id) || !isUuid(item.assetId)) continue;
    const task = tasks.find(candidate => candidate.id === item.taskId && candidate.published &&
      (!candidate.dueDate || candidate.dueDate >= new Date().toISOString().slice(0, 10)));
    if (!task) continue;
    const size = Number(item.size);
    if (!Number.isFinite(size) || size <= 0 || size > 50 * 1024 * 1024) continue;
    const assignedGroups = Array.isArray(task.assignedGroups) ? task.assignedGroups : ['A', 'B', 'C'];
    const assignedStudents = Array.isArray(task.assignedStudents)
      ? task.assignedStudents
      : (current.students || []).map(student => student.id);
    if (task.type === 'group') {
      if (!group || !assignedGroups.includes(group) || item.team !== group) continue;
      const existing = accepted.taskSubmissions.find(old => old.taskId === task.id && old.team === group);
      if (existing) {
        if (existing.assetId) continue;
        Object.assign(existing, {
          fileName: String(item.fileName || '').slice(0, 180), mime: String(item.mime || '').slice(0, 120),
          size, submittedAt: new Date().toISOString(), assetId: item.assetId, cloudStored: true,
        });
      } else {
        accepted.taskSubmissions.push({
          id: item.id, taskId: task.id, team: group, fileName: String(item.fileName || '').slice(0, 180),
          mime: String(item.mime || '').slice(0, 120), size, submittedAt: new Date().toISOString(),
          score: null, assetId: item.assetId, cloudStored: true,
        });
      }
      addTeacherNotification('submission', 'Nova entrega de trabalho',
        `O Grupo ${group} acabou de submeter «${String(task.title || 'um trabalho').slice(0, 120)}».`, task.id);
    } else {
      if (!assignedStudents.includes(sourceStudentId) && !assignedStudents.includes(studentId)) continue;
      const existing = accepted.taskSubmissions.find(old => old.taskId === task.id &&
        (old.studentId === studentId || old.studentId === sourceStudentId));
      if (existing) {
        if (existing.assetId) continue;
        Object.assign(existing, {
          studentId, fileName: String(item.fileName || '').slice(0, 180), mime: String(item.mime || '').slice(0, 120),
          size, submittedAt: new Date().toISOString(), assetId: item.assetId, cloudStored: true,
        });
      } else {
        accepted.taskSubmissions.push({
          id: item.id, taskId: task.id, studentId, fileName: String(item.fileName || '').slice(0, 180),
          mime: String(item.mime || '').slice(0, 120), size, submittedAt: new Date().toISOString(),
          score: null, assetId: item.assetId, cloudStored: true,
        });
      }
      addTeacherNotification('submission', 'Nova entrega de trabalho',
        `${rosterStudent.name || profile.full_name} submeteu ${String(task.title || 'um trabalho').slice(0, 120)}.`, task.id);
    }
  }

  const incomingNotices = Array.isArray(incoming?.notifications) ? incoming.notifications : [];
  for (const notice of incomingNotices) {
    const currentNotice = accepted.notifications.find(item => item.id === notice?.id && item.audience === 'students');
    if (!currentNotice || (Array.isArray(currentNotice.recipientIds) &&
        !currentNotice.recipientIds.includes(studentId) && !currentNotice.recipientIds.includes(sourceStudentId))) continue;
    if (Array.isArray(notice.readBy) && (notice.readBy.includes(studentId) || notice.readBy.includes(sourceStudentId))) {
      currentNotice.readBy ||= [];
      if (!currentNotice.readBy.includes(studentId)) currentNotice.readBy.push(studentId);
    }
  }
  return accepted;
}

module.exports = async function handler(req, res) {
  try {
    const { profile } = await authenticate(req);
    if (req.method === 'GET') {
      const stored = await getStoredState();
      if (['teacher', 'teacher_admin'].includes(profile.role)) {
        const roster = (await getRoster()).map(item => ({ id: item.id, name: item.full_name, email: '', className: 'Centro Virtus', createdAt: item.created_at }));
        return json(res, 200, { state: stored.state, revision: stored.revision, roster });
      }
      return json(res, 200, { state: studentState(stored.state, profile), revision: stored.revision });
    }
    if (req.method !== 'PUT') return json(res, 405, { error: 'Método não permitido.' });
    const size = Number(req.headers['content-length'] || 0);
    if (size > 4_000_000) throw new HttpError(413, 'O registo excede o tamanho permitido.');
    const incoming = req.body?.state;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new HttpError(400, 'O formato dos dados não é válido.');
    const stored = await getStoredState();
    const next = ['teacher', 'teacher_admin'].includes(profile.role) ? incoming : await acceptStudentChanges(incoming, stored.state, profile);
    const saved = await saveStoredState(next, req.body?.expectedRevision);
    return json(res, 200, { ok: true, revision: saved.revision });
  } catch (error) {
    return responseError(res, error);
  }
};
