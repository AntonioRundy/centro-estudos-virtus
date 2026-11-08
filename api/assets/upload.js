const { randomUUID } = require('crypto');
const { SUPABASE_ANON_KEY, HttpError, authenticate, getStoredState, json } = require('../_lib');
const { storagePath, createUploadUrl } = require('../_storage');
const MIME_BY_EXTENSION = {
  '.pdf': ['application/pdf'], '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'],
  '.mp4': ['video/mp4'], '.webm': ['video/webm'], '.mov': ['video/quicktime'],
};
const LESSON_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
function validateFileType(kind, fileName, mime) {
  const extension = String(fileName).toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  const allowed = kind === 'lesson' ? LESSON_EXTENSIONS : DOCUMENT_EXTENSIONS;
  if (!allowed.has(extension)) throw new HttpError(415, kind === 'lesson' ? 'Formato não permitido para material de aula.' : 'O anexo deve ser um ficheiro PDF ou Word.');
  const actualMime = String(mime || '').toLowerCase().split(';')[0].trim();
  if (actualMime && actualMime !== 'application/octet-stream' && !MIME_BY_EXTENSION[extension]?.includes(actualMime)) {
    throw new HttpError(415, 'O formato do ficheiro não corresponde à extensão.');
  }
}


module.exports = async function handler(req, res) {
  let stage = 'validar a sessão';
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
    const { profile } = await authenticate(req);
    stage = 'validar o pedido';
    const { kind, taskId, moduleId, activityId, fileName, mime, size } = req.body || {};
    const fileSize = Number(size);
    if (!fileName || String(fileName).length > 180 || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > 50 * 1024 * 1024) {
      throw new HttpError(400, 'Escolha um ficheiro válido com até 50 MB.');
    }
    validateFileType(kind, fileName, mime);
    stage = 'ler os dados da turma';
    const { state } = await getStoredState();
    if (!state) throw new HttpError(409, 'A sala ainda não está preparada.');
    if (kind === 'lesson') {
      if (!['teacher', 'teacher_admin'].includes(profile.role)) throw new HttpError(403, 'Só o professor pode publicar materiais de aula.');
      if (!(state.modules || []).some(module => module.id === moduleId)) throw new HttpError(400, 'Selecione um módulo válido.');
    } else if (kind === 'task') {
      if (profile.role !== 'student') throw new HttpError(403, 'As entregas são feitas através de uma conta de aluno.');
      const student = (state.students || []).find(item => item.id === profile.id || String(item.name || '').normalize('NFC').trim().toLocaleLowerCase('pt-PT') === String(profile.full_name || '').normalize('NFC').trim().toLocaleLowerCase('pt-PT'));
      if (!student) throw new HttpError(403, 'A conta ainda não está ligada a um aluno matriculado.');
      const task = (state.tasks || []).find(item => item.id === taskId && item.published && (!item.dueDate || item.dueDate >= new Date().toISOString().slice(0, 10)));
      if (!task) throw new HttpError(404, 'Esta tarefa não está disponível para entrega.');
      const team = state.groupAllocations?.[student.id] || '';
      if (task.type === 'group') {
        if (!team) throw new HttpError(409, 'Ainda não foi atribuído a um grupo.');
        const allowedGroups = Array.isArray(task.assignedGroups) ? task.assignedGroups : ['A', 'B', 'C'];
        if (!allowedGroups.includes(team)) throw new HttpError(403, 'Este trabalho não foi atribuído ao seu grupo.');
      } else {
        const allowedStudents = Array.isArray(task.assignedStudents) ? task.assignedStudents : (state.students || []).map(item => item.id);
        if (!allowedStudents.includes(student.id) && !allowedStudents.includes(profile.id)) throw new HttpError(403, 'Este trabalho não foi atribuído à sua conta.');
      }
      const existing = (state.taskSubmissions || []).find(item => item.taskId === task.id && (task.type === 'group' ? item.team === team : item.studentId === student.id));
      if (task.type === 'group' && !team) throw new HttpError(409, 'Ainda não foi atribuído a um grupo.');
      if (existing?.cloudStored) throw new HttpError(409, 'Já existe uma entrega nesta tarefa.');
    } else if (kind === 'prompt') {
      if (!['teacher', 'teacher_admin'].includes(profile.role)) throw new HttpError(403, 'Só o professor pode anexar enunciados.');
      const activityExists = [...(state.quizzes || []), ...(state.tasks || [])].some(item => item.id === activityId);
      if (!activityExists) throw new HttpError(404, 'A atividade que vai receber o anexo não está disponível.');
    } else {
      throw new HttpError(400, 'Tipo de ficheiro não reconhecido.');
    }
    const assetId = randomUUID();
    const namespace = kind === 'lesson' ? 'materials' : kind === 'task' ? 'submissions' : 'prompts';
    const path = storagePath(namespace, assetId);
    stage = 'preparar o armazenamento';
    const uploadUrl = await createUploadUrl(path);
    return json(res, 200, {
      assetId,
      uploadUrl,
      uploadKey: SUPABASE_ANON_KEY,
      maxBytes: 50 * 1024 * 1024,
      mime: String(mime || '').slice(0, 120),
    });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status || 500, { error: error.message });
    const reference = randomUUID().slice(0, 8);
    console.error(`[assets/upload:${reference}] Falha ao ${stage}.`, error);
    return json(res, 500, { error: `Falha técnica ao ${stage}. Referência ${reference}.` });
  }
};

