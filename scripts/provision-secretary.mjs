/**
 * Cria a primeira conta de Secretaria do Centro Virtus de forma idempotente.
 *
 * Uso local, nunca no browser:
 *   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=sb_secret_... node scripts/provision-secretary.mjs
 *
 * A chave de serviço não é incluída no ficheiro, nem deve ser guardada no Git.
 */
const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '');
const domain = String(process.env.VIRTUAL_EMAIL_DOMAIN || 'users.centro-virtus.vercel.app').trim().toLowerCase();

const username = 'secretaria.virtus';
const email = `${username}@${domain}`;
const password = '123456';

if (!url || !serviceKey) {
  throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY apenas no ambiente local seguro.');
}

const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
if (/^eyJ[A-Za-z0-9_-]+\./.test(serviceKey)) headers.Authorization = `Bearer ${serviceKey}`;

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.msg || `Supabase devolveu HTTP ${response.status}.`);
  return data;
}

const existing = await request(`/rest/v1/profiles?select=id,username&username=eq.${encodeURIComponent(username)}&limit=1`);
if (existing.length) {
  console.log(`A conta ${username} já existe; não foi alterada.`);
  process.exit(0);
}

const user = await request('/auth/v1/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: 'secretary' },
    user_metadata: { username, full_name: 'Secretaria Virtus' },
  }),
});

try {
  await request('/rest/v1/profiles', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: user.id,
      username,
      full_name: 'Secretaria Virtus',
      role: 'secretary',
      is_superadmin: false,
      must_change_password: true,
    }),
  });
} catch (error) {
  await request(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' }).catch(() => {});
  throw error;
}

console.log(JSON.stringify({ username, email, temporaryPassword: password, mustChangePassword: true }, null, 2));
