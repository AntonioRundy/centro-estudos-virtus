const crypto = require('crypto');
const { SUPABASE_URL, HttpError, requireConfiguration, serviceHeaders, json, responseError } = require('../_lib');

const ADMIN_RECOVERY_EMAIL = String(process.env.VIRTUS_RECOVERY_EMAIL || 'rundyelidio@gmail.com').trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const MAIL_FROM = String(process.env.VIRTUS_MAIL_FROM || '').trim();
const attempts = new Map();

function identifier(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.includes('@') ? raw.split('@')[0] : raw;
}

function allowReset(key) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < 60 * 60 * 1000);
  if (recent.length >= 3) return false;
  recent.push(now);
  attempts.set(key, recent);
  return true;
}

function temporaryPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

async function sendRecoveryEmail({ username, fullName, password }) {
  if (!RESEND_API_KEY || !MAIL_FROM || !ADMIN_RECOVERY_EMAIL) {
    throw new Error('O envio de recuperação ainda não está configurado.');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [ADMIN_RECOVERY_EMAIL],
      subject: `Recuperação de acesso — ${fullName || username}`,
      text: [
        'Foi gerada uma nova palavra-passe temporária para a Sala de Aula Virtus.',
        `Utilizador: ${username}`,
        `Palavra-passe temporária: ${password}`,
        '',
        'Peça ao utilizador para entrar e definir imediatamente uma palavra-passe pessoal.',
      ].join('\n'),
    }),
  });
  if (!response.ok) throw new Error('O serviço de e-mail recusou o envio.');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  try {
    requireConfiguration({ server: true });
    if (!RESEND_API_KEY || !MAIL_FROM || !ADMIN_RECOVERY_EMAIL) {
      throw new HttpError(503, 'A recuperação por e-mail ainda não está configurada. Contacte o coordenador da plataforma.');
    }
    const username = identifier(req.body?.identity);
    if (!/^[a-z0-9._-]{3,60}$/.test(username)) return json(res, 400, { error: 'Introduza um nome de utilizador ou e-mail válido.' });
    if (!allowReset(username)) return json(res, 429, { error: 'Foram feitos vários pedidos. Aguarde uma hora e tente novamente.' });

    const profileResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=id,username,full_name&username=eq.${encodeURIComponent(username)}&limit=1`,
      { headers: serviceHeaders() },
    );
    if (!profileResponse.ok) throw new Error('Não foi possível localizar a conta.');
    const [profile] = await profileResponse.json();
    // Deliberately do not reveal whether an arbitrary account exists.
    if (!profile) return json(res, 200, { ok: true });

    const password = temporaryPassword();
    const updateAuth = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(profile.id)}`, {
      method: 'PUT', headers: serviceHeaders(), body: JSON.stringify({ password }),
    });
    if (!updateAuth.ok) throw new Error('Não foi possível criar uma senha temporária.');
    const updateProfile = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(profile.id)}`, {
      method: 'PATCH', headers: serviceHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ must_change_password: true }),
    });
    if (!updateProfile.ok) throw new Error('A conta foi reposta, mas não foi possível exigir a nova senha.');
    try {
      await sendRecoveryEmail({ username: profile.username, fullName: profile.full_name, password });
    } catch {
      throw new HttpError(503, 'A palavra-passe temporária foi criada, mas o e-mail não foi enviado. Contacte o coordenador para uma nova recuperação.');
    }
    return json(res, 200, { ok: true });
  } catch (error) {
    return responseError(res, error);
  }
};

