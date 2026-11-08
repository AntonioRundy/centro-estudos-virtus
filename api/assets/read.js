const { HttpError, authenticate, getStoredState, studentState, json, responseError } = require('../_lib');
const { storagePath, createReadUrl } = require('../_storage');

function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
    const { profile } = await authenticate(req);
    const assetId = String(req.query?.assetId || '');
    if (!isUuid(assetId)) throw new HttpError(400, 'O identificador do ficheiro não é válido.');
    const stored = await getStoredState();
    const state = profile.role === 'teacher' ? stored.state : studentState(stored.state, profile);
    if (!state) throw new HttpError(404, 'O ficheiro não está disponível.');
    const lesson = (state.lessons || []).find(item => item.assetId === assetId && item.cloudStored === true);
    const submission = (state.taskSubmissions || []).find(item => item.assetId === assetId && item.cloudStored === true);
    const prompt = [...(state.quizzes || []), ...(state.tasks || [])].find(item => item.attachment?.assetId === assetId && item.attachment.cloudStored === true);
    const record = lesson || submission || prompt?.attachment;
    if (!record) throw new HttpError(404, 'O ficheiro não está disponível para esta conta.');
    const download = req.query?.download === '1';
    const fileName = String(req.query?.name || record.name || record.fileName || 'ficheiro').slice(0, 180);
    const namespace = lesson ? 'materials' : submission ? 'submissions' : 'prompts';
    const url = await createReadUrl(storagePath(namespace, assetId), { download, fileName });
    return json(res, 200, { url, expiresIn: 900 });
  } catch (error) {
    return responseError(res, error);
  }
};
