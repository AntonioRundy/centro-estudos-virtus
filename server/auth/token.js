const {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVER_KEY, VIRTUAL_EMAIL_DOMAIN,
  HttpError, json, responseError, serviceHeaders,
} = require('../../api/_lib');

function payload(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Pedido de autenticação inválido.'); }
  }
  return req.body || {};
}

function validUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return /^[a-z0-9._-]{3,60}$/.test(username) ? username : '';
}

async function requestToken(requestBody, grantType = 'password') {
  const upstream = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  return { upstream, data: await upstream.json().catch(() => ({})) };
}

// Algumas contas foram criadas antes da adopção do endereço virtual. O browser
// continua a enviar apenas o username, mas o servidor pode localizar o UUID do
// perfil e fazer uma única tentativa segura com o e-mail Auth já associado.
// Isto não enumera contas nem expõe o e-mail antigo ao navegador.
async function legacyAuthEmail(username) {
  if (!username || !SUPABASE_SERVER_KEY) return null;
  const query = new URLSearchParams({ select: 'id', username: `eq.${username}`, limit: '1' });
  const profileResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${query}`, { headers: serviceHeaders() });
  if (!profileResponse.ok) return null;
  const profile = (await profileResponse.json())[0];
  if (!profile?.id) return null;
  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(profile.id)}`, { headers: serviceHeaders() });
  if (!authResponse.ok) return null;
  const authUser = await authResponse.json().catch(() => ({}));
  const email = String(authUser.email || authUser.user?.email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { id: profile.id, email } : null;
}

// A normalização acontece apenas depois de uma autenticação bem-sucedida com
// as credenciais da própria conta. UUID, profile, role e RLS permanecem
// intocados; nas entradas seguintes, a via normal pelo e-mail virtual basta.
async function normalizeLegacyEmail(userId, targetEmail) {
  if (!userId || !targetEmail || !SUPABASE_SERVER_KEY) return;
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT', headers: serviceHeaders(), body: JSON.stringify({ email: targetEmail, email_confirm: true }),
  }).catch(() => {});
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
    let username = '';
    if (grantType === 'password') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      username = validUsername(body.identity);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) throw new HttpError(400, 'Introduza o nome de utilizador e a palavra-passe.');
      requestBody = { email, password };
    } else {
      const refresh_token = String(body.refresh_token || '');
      if (!refresh_token) throw new HttpError(400, 'A sessão expirou. Entre novamente.');
      requestBody = { refresh_token };
    }
    let { upstream, data } = await requestToken(requestBody, grantType);
    if (!upstream.ok && grantType === 'password' && username) {
      const virtualEmail = `${username}@${VIRTUAL_EMAIL_DOMAIN}`;
      // Só há fallback quando o pedido inicial corresponde ao domínio virtual
      // esperado para o username. Um e-mail digitado explicitamente nunca é
      // substituído pelo servidor.
      if (requestBody.email === virtualEmail) {
        const legacy = await legacyAuthEmail(username);
        if (legacy && legacy.email !== virtualEmail) {
          ({ upstream, data } = await requestToken({ email: legacy.email, password: requestBody.password }, grantType));
          if (upstream.ok) await normalizeLegacyEmail(legacy.id, virtualEmail);
        }
      }
    }
    if (!upstream.ok) {
      throw new HttpError(upstream.status === 429 ? 429 : 401,
        grantType === 'password' ? 'Nome de utilizador ou palavra-passe inválidos.' : 'A sessão expirou. Entre novamente.');
    }
    return json(res, 200, data);
  } catch (error) { return responseError(res, error); }
};
