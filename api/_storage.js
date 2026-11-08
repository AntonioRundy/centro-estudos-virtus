const { SUPABASE_URL, HttpError, serviceHeaders } = require('./_lib');

const BUCKET = 'sala-virtus-private';

function storagePath(kind, assetId) {
  if (!['materials', 'submissions', 'prompts'].includes(kind) || !/^[0-9a-f-]{36}$/i.test(String(assetId || ''))) {
    throw new HttpError(400, 'O identificador do ficheiro não é válido.');
  }
  return `${kind}/${assetId}`;
}

function encodedPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}


async function readResponse(response) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  return { data, text };
}

function responseDetail(data) {
  const value = data?.message || data?.error_description || data?.error || data?.msg || '';
  return String(value).replace(/\s+/g, ' ').slice(0, 140);
}

async function ensureBucket() {
  const create = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 52428800 }),
  });
  if (create.ok) return;
  const { data } = await readResponse(create);
  const detail = responseDetail(data);
  const duplicate = create.status === 409 || /already exists|already_exist|duplicate/i.test(detail);
  if (!duplicate) {
    throw new HttpError(503, `Não foi possível preparar o armazenamento privado (HTTP ${create.status}${detail ? `: ${detail}` : ''}).`);
  }
  const current = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers: serviceHeaders() });
  if (!current.ok) {
    const { data } = await readResponse(current);
    const detail = responseDetail(data);
    throw new HttpError(503, `Não foi possível confirmar o bucket privado (HTTP ${current.status}${detail ? `: ${detail}` : ''}).`);
  }
  const { data: bucket } = await readResponse(current);
  if (bucket.public === false) return;
  const update = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, {
    method: 'PUT', headers: serviceHeaders(),
    body: JSON.stringify({ public: false, file_size_limit: 52428800 }),
  });
  if (!update.ok) {
    const { data } = await readResponse(update);
    const detail = responseDetail(data);
    throw new HttpError(503, `Não foi possível manter o bucket privado (HTTP ${update.status}${detail ? `: ${detail}` : ''}).`);
  }
}

function absoluteSignedUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith('/storage/v1/')) return `${SUPABASE_URL}${value}`;
  if (value.startsWith('/')) return `${SUPABASE_URL}/storage/v1${value}`;
  return `${SUPABASE_URL}/storage/v1/${value}`;
}

async function createUploadUrl(path) {
  await ensureBucket();
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${encodedPath(path)}`, {
    method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ upsert: false }),
  });
  const { data } = await readResponse(response);
  if (!response.ok) {
    const detail = responseDetail(data);
    throw new HttpError(503, `Não foi possível iniciar o envio (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`);
  }
  const url = absoluteSignedUrl(data.url || data.signedURL || data.signedUrl || (data.token ? `/object/upload/sign/${BUCKET}/${encodedPath(path)}?token=${encodeURIComponent(data.token)}` : ''));
  if (!url) throw new HttpError(503, 'O armazenamento não devolveu uma ligação de envio válida.');
  return url;
}

async function createReadUrl(path, { download = false, fileName = '' } = {}) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${encodedPath(path)}`, {
    method: 'POST', headers: serviceHeaders(),
    body: JSON.stringify({ expiresIn: 900, ...(download ? { download: String(fileName || 'ficheiro').slice(0, 180) } : {}) }),
  });
  const { data } = await readResponse(response);
  if (!response.ok) throw new HttpError(404, 'O ficheiro não está disponível no armazenamento.');
  const url = absoluteSignedUrl(data.signedURL || data.signedUrl || data.url);
  if (!url) throw new HttpError(503, 'O armazenamento não devolveu uma ligação de leitura válida.');
  return url;
}

async function removeObject(path) {
  const headers = serviceHeaders();
  delete headers['Content-Type'];
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodedPath(path)}`, {
    method: 'DELETE', headers,
  });
  if (response.ok || response.status === 404) return;
  const { data } = await readResponse(response);
  if (response.ok || response.status === 404) return;
  const detail = responseDetail(data);
  throw new HttpError(503, "Não foi possível remover o ficheiro do armazenamento (HTTP " + response.status + (detail ? ": " + detail : "") + ").");
}

module.exports = { BUCKET, storagePath, createUploadUrl, createReadUrl, removeObject };

