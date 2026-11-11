const { SUPABASE_URL, SUPABASE_ANON_KEY, VIRTUAL_EMAIL_DOMAIN, json } = require('../../api/_lib');

module.exports = function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json(res, 503, { error: 'A autenticação ainda não foi ligada ao projecto.' });
  return json(res, 200, { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, virtualEmailDomain: VIRTUAL_EMAIL_DOMAIN });
};
