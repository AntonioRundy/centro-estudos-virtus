/**
 * Repara as credenciais iniciais das primeiras contas do Centro Virtus.
 *
 * O script é idempotente: não cria perfis, não muda UUIDs, papéis, matrículas
 * nem atribuições. Apenas confirma o endereço virtual, repõe a palavra-passe
 * temporária e volta a exigir a sua troca no primeiro acesso.
 *
 * Uso seguro (as variáveis são lidas do ambiente, nunca do código):
 *   node scripts/reset-initial-center-accounts.mjs
 */
const url = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '');
const anonKey = String(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '');
const virtualDomain = String(process.env.VIRTUAL_EMAIL_DOMAIN || 'users.centro-virtus.vercel.app').trim().toLowerCase().replace(/^@+/, '');
const temporaryPassword = '123456';
const usernames = ['secretaria.virtus', 'allan.rafael', 'angel.rafael'];

if (!url || !serviceKey || !anonKey) {
  throw new Error('Defina SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e SUPABASE_ANON_KEY num ambiente seguro.');
}

const serviceHeaders = { apikey: serviceKey, 'Content-Type': 'application/json' };
if (/^eyJ[A-Za-z0-9_-]+\./.test(serviceKey)) serviceHeaders.Authorization = `Bearer ${serviceKey}`;

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { ...serviceHeaders, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.msg || data.error_description || `HTTP ${response.status}`);
  return data;
}

async function resetAccount(username) {
  const params = new URLSearchParams({ select: 'id,username,role', username: `eq.${username}`, limit: '1' });
  const profiles = await request(`/rest/v1/profiles?${params}`);
  const profile = profiles[0];
  if (!profile?.id) throw new Error('Perfil não encontrado.');

  const email = `${username}@${virtualDomain}`;
  // Não envia role nem metadados: Auth e profile mantêm exactamente as
  // permissões já estabelecidas para cada pessoa.
  await request(`/auth/v1/admin/users/${encodeURIComponent(profile.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ email, password: temporaryPassword, email_confirm: true }),
  });
  await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(profile.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ must_change_password: true }),
  });

  // Prova final: executa o mesmo fluxo de autenticação usado pelo portal e
  // confirma que a sessão obtida pertence ao UUID do perfil existente.
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: temporaryPassword }),
  });
  const session = await login.json().catch(() => ({}));
  if (!login.ok || String(session.user?.id || '') !== String(profile.id)) {
    throw new Error('A verificação final de login não confirmou o UUID do perfil.');
  }
  return { username, role: profile.role, profileId: profile.id, loginVerified: true, passwordChangeRequired: true };
}

const results = [];
for (const username of usernames) {
  try {
    results.push({ ok: true, ...(await resetAccount(username)) });
  } catch (error) {
    results.push({ ok: false, username, error: error.message || 'Erro desconhecido.' });
  }
}

console.log(JSON.stringify({
  repaired: results.filter(item => item.ok).map(({ profileId, ...item }) => item),
  failed: results.filter(item => !item.ok),
  message: 'Nenhum papel, atribuição, matrícula ou UUID foi modificado.',
}, null, 2));

if (results.some(item => !item.ok)) process.exitCode = 1;
