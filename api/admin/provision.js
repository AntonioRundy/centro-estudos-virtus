const {
  SUPABASE_URL, requireConfiguration, serviceHeaders, authenticate, HttpError, json, responseError,
} = require('../_lib');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Pedido inválido.'); }
  }
  return req.body || {};
}
function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '.');
}
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = require('crypto').randomBytes(15);
  return Array.from(bytes, value => alphabet.charAt(value % alphabet.length)).join('');
}
function validateAccount(raw) {
  const username = normalizeUsername(raw.username);
  const fullName = String(raw.fullName || raw.full_name || '').trim().replace(/\s+/g, ' ');
  const role = String(raw.role || 'student').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(username)) throw new HttpError(400, 'O nome de utilizador deve ter entre 3 e 60 caracteres: letras minúsculas, números, ponto, hífen ou _.');
  if (fullName.length < 3 || fullName.length > 160) throw new HttpError(400, 'Indique o nome completo da conta.');
  if (!['student', 'teacher'].includes(role)) throw new HttpError(400, 'O perfil deve ser aluno ou docente.');
  return { username, fullName, role };
}
async function findExistingProfile(username) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}`, { headers: serviceHeaders() });
  if (!response.ok) throw new HttpError(503, 'Não foi possível validar os nomes de utilizador.');
  return (await response.json())[0] || null;
}
async function createAccount(account) {
  const password = temporaryPassword();
  const email = `${account.username}@users.sala-virtus.vercel.app`;
  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username: account.username, full_name: account.fullName } }),
  });
  if (!authResponse.ok) {
    const detail = await authResponse.json().catch(() => ({}));
    throw new HttpError(409, detail.msg || detail.message || `Não foi possível criar ${account.username}.`);
  }
  const user = await authResponse.json();
  const profileResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST',
    headers: serviceHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ id: user.id, username: account.username, full_name: account.fullName, role: account.role, must_change_password: true }),
  });
  if (!profileResponse.ok) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
    const detail = await profileResponse.json().catch(() => ({}));
    throw new HttpError(503, detail.message || `A conta ${account.username} não foi concluída.`);
  }
  return { username: account.username, fullName: account.fullName, role: account.role, temporaryPassword: password };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  try {
    requireConfiguration({ server: true });
    const { profile } = await authenticate(req);
    if (profile.is_superadmin !== true) throw new HttpError(403, 'Apenas administradores autorizados podem provisionar contas.');
    const body = readBody(req);
    const incoming = Array.isArray(body.accounts) ? body.accounts : [body.account || body];
    if (!incoming.length || incoming.length > 100) throw new HttpError(400, 'Envie entre 1 e 100 contas por operação.');
    const accounts = incoming.map(validateAccount);
    const duplicates = accounts.filter((account, index) => accounts.findIndex(item => item.username === account.username) !== index);
    if (duplicates.length) throw new HttpError(400, 'O ficheiro contém nomes de utilizador repetidos.');
    const created = [], failed = [];
    for (const account of accounts) {
      try {
        if (await findExistingProfile(account.username)) throw new HttpError(409, 'Nome de utilizador já existe.');
        created.push(await createAccount(account));
      } catch (error) {
        failed.push({ username: account.username, error: error.message || 'Falha ao criar a conta.' });
      }
    }
    return json(res, failed.length ? 207 : 201, { created, failed });
  } catch (error) {
    return responseError(res, error);
  }
};
