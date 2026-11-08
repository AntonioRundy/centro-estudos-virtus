const { SUPABASE_URL, SUPABASE_ANON_KEY, authenticate, serviceHeaders, json, responseError } = require('../_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  try {
    const { token, user, profile } = await authenticate(req);
    const newPassword = String(req.body?.password || '');
    if (newPassword.length < 10) return json(res, 400, { error: 'Escolha uma senha com pelo menos 10 caracteres.' });
    const change = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword }),
    });
    if (!change.ok) return json(res, 400, { error: 'Não foi possível atualizar a senha. Escolha outra senha e tente novamente.' });
    const update = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      headers: serviceHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ must_change_password: false }),
    });
    if (!update.ok) return json(res, 503, { error: 'A senha foi atualizada, mas não foi possível concluir a configuração da conta. Entre novamente.' });
    return json(res, 200, { ok: true });
  } catch (error) {
    return responseError(res, error);
  }
};
