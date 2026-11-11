const crypto = require('crypto');
const { SUPABASE_URL, requireConfiguration, serviceHeaders, authenticate, HttpError, json, responseError } = require('../_lib');
const { isProvisioningRole } = require('../../lib/roles');

const VIRTUAL_EMAIL_DOMAIN = 'users.centro-estudosvirtus.vercel.app';
const INITIAL_PASSWORD = '123456';

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Pedido inválido.'); }
  }
  return req.body || {};
}
function usernamePart(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}
function validateAccount(raw) {
  const fullName = String(raw.fullName || raw.full_name || '').trim().replace(/\s+/g, ' ');
  const role = String(raw.role || 'student').toLowerCase();
  if (fullName.length < 3 || fullName.length > 160) throw new HttpError(400, 'Indique o nome completo da conta.');
  if (!isProvisioningRole(role)) throw new HttpError(400, 'Escolha Aluno, Professor, Professor Administrador ou Secretária.');
  const words = fullName.split(' ').map(usernamePart).filter(Boolean);
  const base = [words[0], words.at(-1)].filter(Boolean).join('.').slice(0, 54);
  if (base.length < 3) throw new HttpError(400, 'Não foi possível gerar o nome de utilizador a partir do nome indicado.');
  return { base, fullName, role };
}
async function profileCount() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id`, { headers: { ...serviceHeaders(), Prefer: 'count=exact' } });
  if (!response.ok) throw new HttpError(503, 'Não foi possível validar as contas existentes.');
  return Number(String(response.headers.get('content-range') || '').split('/').pop()) || 0;
}
async function uniqueUsername(base) {
  for (let number = 1; number < 1000; number += 1) {
    const username = number === 1 ? base : `${base}.${number}`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}&limit=1`, { headers: serviceHeaders() });
    if (!response.ok) throw new HttpError(503, 'Não foi possível gerar o nome de utilizador.');
    if (!(await response.json()).length) return username;
  }
  throw new HttpError(409, 'Não foi possível gerar um nome de utilizador disponível.');
}
async function authorize(req, requestedRole) {
  const bootstrapToken = String(process.env.CENTRO_BOOTSTRAP_TOKEN || '');
  if (await profileCount() === 0) {
    const supplied = String(req.headers['x-centro-bootstrap-token'] || '');
    const validToken = bootstrapToken && supplied.length === bootstrapToken.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(bootstrapToken));
    if (requestedRole !== 'admin_teacher' || !validToken) throw new HttpError(403, 'A primeira conta deve ser Professor Administrador e requer a chave de instalação.');
    return;
  }
  const { profile } = await authenticate(req);
  if (!['admin_teacher', 'teacher_admin'].includes(profile.role)) throw new HttpError(403, 'Apenas Professores Administradores podem criar contas.');
}
async function createAccount(account) {
  const username = await uniqueUsername(account.base);
  const email = `${username}@${VIRTUAL_EMAIL_DOMAIN}`;
  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: serviceHeaders(),
    body: JSON.stringify({ email, password: INITIAL_PASSWORD, email_confirm: true,
      app_metadata: { role: account.role }, user_metadata: { username, full_name: account.fullName } }),
  });
  if (!authResponse.ok) {
    const detail = await authResponse.json().catch(() => ({}));
    throw new HttpError(409, detail.msg || detail.message || 'Não foi possível criar a conta.');
  }
  const user = await authResponse.json();
  let profileResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST', headers: serviceHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ id: user.id, username, full_name: account.fullName, role: account.role,
      is_superadmin: account.role === 'admin_teacher', must_change_password: true }),
  });
  // Permite publicar primeiro o código sem interromper uma base antiga. Após a
  // migração 001, este desvio deixa de ser usado e todos os perfis são canónicos.
  if (!profileResponse.ok && account.role === 'admin_teacher') {
    const legacyResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST', headers: serviceHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ id: user.id, username, full_name: account.fullName, role: 'teacher_admin',
        is_superadmin: true, must_change_password: true }),
    });
    if (legacyResponse.ok) profileResponse = legacyResponse;
  }
  if (!profileResponse.ok) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
    const detail = await profileResponse.json().catch(() => ({}));
    throw new HttpError(503, detail.message || 'A conta não foi concluída.');
  }
  if (account.role === 'student') {
    const enrollmentResponse = await fetch(`${SUPABASE_URL}/rest/v1/student_enrollments`, {
      method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ student_id: user.id }),
    });
    if (!enrollmentResponse.ok) {
      // Sem matrícula activa, a conta do aluno não deve ficar parcialmente criada.
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
      throw new HttpError(503, 'A conta foi revertida porque não foi possível criar a matrícula do aluno. Execute a migração de contas e tente novamente.');
    }
  }
  return { username, email, fullName: account.fullName, role: account.role, temporaryPassword: INITIAL_PASSWORD };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  try {
    requireConfiguration({ server: true });
    const account = validateAccount(readBody(req));
    await authorize(req, account.role);
    return json(res, 201, { account: await createAccount(account) });
  } catch (error) { return responseError(res, error); }
};
