const { HttpError, authenticate, getStoredState, json, responseError } = require('../_lib');
const { storagePath, removeObject } = require('../_storage');

module.exports = async function handler(req, res) {
  let stage = 'validar o pedido';
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
    stage = 'validar a sessão';
    const { profile } = await authenticate(req);
    if (!['teacher', 'teacher_admin'].includes(profile.role)) throw new HttpError(403, 'Só o professor pode remover ficheiros partilhados.');
    stage = 'consultar os dados da turma';
    const ids = [...new Set((Array.isArray(req.body?.assetIds) ? req.body.assetIds : []).filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id))))].slice(0, 200);
    const { state } = await getStoredState();
    if (!state || !ids.length) return json(res, 200, { ok: true, removed: 0 });
    const known = new Set([
      ...(state.lessons || []).filter(item => item.cloudStored === true).map(item => item.assetId),
      ...(state.taskSubmissions || []).filter(item => item.cloudStored === true).map(item => item.assetId),
      ...(state.quizzes || []).map(item => item.attachment).filter(item => item?.cloudStored === true).map(item => item.assetId),
      ...(state.tasks || []).map(item => item.attachment).filter(item => item?.cloudStored === true).map(item => item.assetId),
    ]);
    const paths = ids.filter(id => known.has(id)).map(id => {
      const lesson = (state.lessons || []).some(item => item.assetId === id && item.cloudStored === true);
      const submission = (state.taskSubmissions || []).some(item => item.assetId === id && item.cloudStored === true);
      return storagePath(lesson ? 'materials' : submission ? 'submissions' : 'prompts', id);
    });
    stage = 'remover os ficheiros do armazenamento';
    for (const path of paths) await removeObject(path);
    return json(res, 200, { ok: true, removed: paths.length });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      const reference = require('crypto').randomUUID().slice(0, 8);
      console.error('[assets/delete:' + reference + '] Falha ao ' + stage + '.', error);
      return json(res, 500, { error: 'Falha técnica ao ' + stage + '. Referência ' + reference + '.' });
    }
    return responseError(res, error);
  }
};
