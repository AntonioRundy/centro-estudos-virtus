const { SUPABASE_URL, SUPABASE_ANON_KEY, HttpError, json, responseError } = require('../../api/_lib');

function payload(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Pedido de autenticação inválido.'); }
  }
  return req.body || {};
}

// Faz a troca de credenciais no mesmo domínio da aplicação. Isto evita que o
// browser dependa de CORS ou DNS de terceiros durante o início de sessão.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new HttpError(503, 'A autenticação ainda não foi ligada ao projecto.');
    const body = payload(req);
    const grantType = body.grant_type === 'refresh_token' ? 'refresh_token' : 'password';
    let requestBody;
    if (grantType === 'password') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) throw new HttpError(400, 'Introduza o nome de utilizador e a palavra-passe.');
      requestBody = { email, password };
    } else {
      const refresh_token = String(body.refresh_token || '');
      if (!refresh_token) throw new HttpError(400, 'A sessão expirou. Entre novamente.');
      requestBody = { refresh_token };
    }
    const upstream = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      throw new HttpError(upstream.status === 429 ? 429 : 401,
        grantType === 'password' ? 'Nome de utilizador ou palavra-passe inválidos.' : 'A sessão expirou. Entre novamente.');
    }
    return json(res, 200, data);
  } catch (error) { return responseError(res, error); }
};
