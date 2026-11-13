/**
 * Normaliza o e-mail virtual da conta administrativa existente, sem alterar
 * o UUID, o perfil, o papel ou as permissões associadas.
 *
 * Uso (PowerShell, apenas numa máquina segura):
 *   $env:SUPABASE_URL = 'https://<project-ref>.supabase.co'
 *   $env:SUPABASE_SERVICE_ROLE_KEY = '<service-role-secret>'
 *   node scripts/update-admin-email.mjs
 */
const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '');
const username = 'antonio.fernando';
const domain = String(process.env.VIRTUAL_EMAIL_DOMAIN || 'users.centro-virtus.vercel.app').trim().toLowerCase();
const targetEmail = `${username}@${domain}`;

if (!url || !serviceKey) {
  throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente local seguro.');
}

const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
if (/^eyJ[A-Za-z0-9_-]+\./.test(serviceKey)) headers.Authorization = `Bearer ${serviceKey}`;

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.msg || data.error_description || `Supabase devolveu HTTP ${response.status}.`);
  return data;
}

// O perfil é a fonte de verdade para localizar a conta; não é atualizado por este script.
const profiles = await request(`/rest/v1/profiles?select=id,username,role&username=eq.${encodeURIComponent(username)}&limit=1`);
if (!Array.isArray(profiles) || profiles.length !== 1) {
  throw new Error(`Não foi encontrado um perfil único para ${username}. Nenhuma alteração foi efetuada.`);
}

const profile = profiles[0];
if (profile.role !== 'admin_teacher') {
  console.warn(`Aviso: o perfil tem o papel ${String(profile.role || 'ausente')}. O script não irá modificar esse papel.`);
}

const authUser = await request(`/auth/v1/admin/users/${encodeURIComponent(profile.id)}`);
const currentEmail = String(authUser.email || authUser.user?.email || '').trim().toLowerCase();

if (currentEmail === targetEmail) {
  console.log(JSON.stringify({
    updated: false,
    username,
    email: targetEmail,
    profileId: profile.id,
    role: profile.role,
    message: 'O e-mail virtual já estava configurado; o perfil não foi alterado.',
  }, null, 2));
  process.exit(0);
}

await request(`/auth/v1/admin/users/${encodeURIComponent(profile.id)}`, {
  method: 'PUT',
  body: JSON.stringify({ email: targetEmail, email_confirm: true }),
});

console.log(JSON.stringify({
  updated: true,
  username,
  email: targetEmail,
  profileId: profile.id,
  role: profile.role,
  message: 'E-mail do Supabase Auth atualizado. UUID, perfil e permissões foram preservados.',
}, null, 2));
