const crypto = require('crypto');
const { SUPABASE_URL, VIRTUAL_EMAIL_DOMAIN, requireConfiguration, serviceHeaders, authenticate, HttpError, json, responseError } = require('../../api/_lib');
const { isProvisioningRole } = require('../../lib/roles');

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
  const requestedUsername = usernamePart(raw.username || raw.userName || '');
  const base = (requestedUsername || [words[0], words.at(-1)].filter(Boolean).join('.')).slice(0, 54);
  if (base.length < 3) throw new HttpError(400, 'Não foi possível gerar o nome de utilizador a partir do nome indicado.');
  const schoolYear = String(raw.schoolYear || raw.school_year || '').trim().replace(/\s+/g, ' ');
  const className = String(raw.className || raw.class_name || schoolYear || '').trim().replace(/\s+/g, ' ');
  const guardianEmail = String(raw.guardianEmail || raw.guardian_email || '').trim().toLowerCase();
  const subjectName = String(raw.subjectName || raw.subject_name || '').trim().replace(/\s+/g, ' ');
  const teacherUsername = String(raw.teacherUsername || raw.teacher_username || '').trim().toLowerCase();
  const temporaryPassword = String(raw.temporaryPassword || raw.temporary_password || INITIAL_PASSWORD);
  if (schoolYear && (schoolYear.length < 3 || schoolYear.length > 40)) throw new HttpError(400, 'Indique um ano escolar válido.');
  if (teacherUsername && !subjectName) throw new HttpError(400, 'Indique a disciplina para associar um professor.');
  if (guardianEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail)) throw new HttpError(400, 'Indique um e-mail válido para o encarregado de educação.');
  if (temporaryPassword.length < 6 || temporaryPassword.length > 128) throw new HttpError(400, 'A palavra-passe temporária deve ter entre 6 e 128 caracteres.');
  if (role !== 'student' && (schoolYear || subjectName || teacherUsername)) {
    throw new HttpError(400, 'Ano escolar e atribuição pedagógica aplicam-se apenas a contas de aluno.');
  }
  return { base, requestedUsername: requestedUsername || null, fullName, role, schoolYear: schoolYear || null, className: className || null, guardianEmail: guardianEmail || null, subjectName: subjectName || null, teacherUsername: teacherUsername || null, temporaryPassword };
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
async function requestedUsernameOrFail(username) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}&limit=1`, { headers: serviceHeaders() });
  if (!response.ok) throw new HttpError(503, 'Não foi possível validar o nome de utilizador.');
  if ((await response.json()).length) throw new HttpError(409, `O nome de utilizador «${username}» já está em uso.`);
  return username;
}
async function authorize(req, requestedRole) {
  const bootstrapToken = String(process.env.CENTRO_BOOTSTRAP_TOKEN || '');
  if (await profileCount() === 0) {
    const supplied = String(req.headers['x-centro-bootstrap-token'] || '');
    const validToken = bootstrapToken && supplied.length === bootstrapToken.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(bootstrapToken));
    if (requestedRole !== 'admin_teacher' || !validToken) throw new HttpError(403, 'A primeira conta deve ser Professor Administrador e requer a chave de instalação.');
    return null;
  }
  const { profile } = await authenticate(req);
  const isAdmin = ['admin_teacher', 'teacher_admin'].includes(profile.role);
  if (isAdmin) return profile;
  if (profile.role === 'secretary' && requestedRole === 'student') return profile;
  throw new HttpError(403, 'Esta conta não tem autorização para criar este perfil.');
}
async function resolveAssignmentTargets(account) {
  if (!account.subjectName) return null;
  const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(account.subjectName);
  const subjectQuery = new URLSearchParams({
    select: 'id,name',
    [subjectId ? 'id' : 'name']: subjectId ? `eq.${account.subjectName}` : `ilike.${account.subjectName}`,
    active: 'eq.true', limit: '2',
  });
  const subjectResponse = await fetch(`${SUPABASE_URL}/rest/v1/subjects?${subjectQuery}`, { headers: serviceHeaders() });
  if (!subjectResponse.ok) throw new HttpError(503, 'Não foi possível localizar a disciplina indicada.');
  const subjects = await subjectResponse.json();
  let subject = subjectId ? subjects[0] : subjects.find(item => String(item.name || '').trim().toLocaleLowerCase('pt-PT') === account.subjectName.toLocaleLowerCase('pt-PT'));
  // A matrícula não deve obrigar a Administração a abrir primeiro outro ecrã
  // apenas para cadastrar uma disciplina. A criação é feita pela rota segura,
  // nunca pelo browser com uma chave de serviço.
  if (!subject && !subjectId) {
    const createSubject = await fetch(`${SUPABASE_URL}/rest/v1/subjects`, {
      method: 'POST',
      headers: serviceHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ name: account.subjectName, active: true }),
    });
    if (createSubject.ok) subject = (await createSubject.json())[0];
    if (!subject) {
      const retry = await fetch(`${SUPABASE_URL}/rest/v1/subjects?${subjectQuery}`, { headers: serviceHeaders() });
      if (retry.ok) subject = (await retry.json()).find(item => String(item.name || '').trim().toLocaleLowerCase('pt-PT') === account.subjectName.toLocaleLowerCase('pt-PT'));
    }
    if (!subject) throw new HttpError(503, `Não foi possível criar a disciplina «${account.subjectName}».`);
  }
  if (!subject) throw new HttpError(400, 'A disciplina selecionada já não está disponível. Atualize a página e escolha outra disciplina.');

  if (!account.teacherUsername) return { subject, teacher: null };
  const teacherQuery = new URLSearchParams({ select: 'id,username,role', username: `eq.${account.teacherUsername}`, limit: '1' });
  const teacherResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${teacherQuery}`, { headers: serviceHeaders() });
  if (!teacherResponse.ok) throw new HttpError(503, 'Não foi possível localizar o professor indicado.');
  const teacher = (await teacherResponse.json())[0];
  if (!teacher || !['teacher', 'admin_teacher', 'teacher_admin'].includes(teacher.role)) {
    throw new HttpError(400, `O utilizador «${account.teacherUsername}» não é um professor ativo.`);
  }
  return { subject, teacher };
}
async function removePartialAccount(userId) {
  await fetch(`${SUPABASE_URL}/rest/v1/onboarding_credentials?student_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
  await fetch(`${SUPABASE_URL}/rest/v1/teacher_student_subject_assignments?student_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
  await fetch(`${SUPABASE_URL}/rest/v1/student_enrollments?student_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
}
async function createAccount(account, createdBy = null) {
  const assignmentTargets = await resolveAssignmentTargets(account);
  const username = account.requestedUsername ? await requestedUsernameOrFail(account.base) : await uniqueUsername(account.base);
  const email = `${username}@${VIRTUAL_EMAIL_DOMAIN}`;
  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: serviceHeaders(),
    body: JSON.stringify({ email, password: account.temporaryPassword, email_confirm: true,
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
      school_year: account.schoolYear, is_superadmin: account.role === 'admin_teacher', must_change_password: true }),
  });
  // Permite que a API seja publicada antes da migração 007 sem bloquear a
  // criação de contas; após 007, o ano escolar fica persistido no perfil.
  if (!profileResponse.ok && account.schoolYear) {
    profileResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST', headers: serviceHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ id: user.id, username, full_name: account.fullName, role: account.role,
        is_superadmin: account.role === 'admin_teacher', must_change_password: true }),
    });
  }
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
    await removePartialAccount(user.id);
    const detail = await profileResponse.json().catch(() => ({}));
    throw new HttpError(503, detail.message || 'A conta não foi concluída.');
  }
  if (account.role === 'student') {
    let enrollmentResponse = await fetch(`${SUPABASE_URL}/rest/v1/student_enrollments`, {
      method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ student_id: user.id, school_year: account.schoolYear, class_name: account.className, guardian_email: account.guardianEmail }),
    });
    if (!enrollmentResponse.ok && account.schoolYear) enrollmentResponse = await fetch(`${SUPABASE_URL}/rest/v1/student_enrollments`, {
      method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ student_id: user.id }),
    });
    if (!enrollmentResponse.ok) {
      // Sem matrícula activa, a conta do aluno não deve ficar parcialmente criada.
      await removePartialAccount(user.id);
      throw new HttpError(503, 'A conta foi revertida porque não foi possível criar a matrícula do aluno. Execute a migração de contas e tente novamente.');
    }
    if (assignmentTargets?.teacher) {
      const assignmentResponse = await fetch(`${SUPABASE_URL}/rest/v1/teacher_student_subject_assignments`, {
        method: 'POST', headers: serviceHeaders(),
        body: JSON.stringify({ teacher_id: assignmentTargets.teacher.id, student_id: user.id, subject_id: assignmentTargets.subject.id, is_primary: true }),
      });
      if (!assignmentResponse.ok) {
        await removePartialAccount(user.id);
        throw new HttpError(503, 'A conta foi revertida porque não foi possível concluir a atribuição ao professor e à disciplina.');
      }
    }
    const onboardingResponse = await fetch(`${SUPABASE_URL}/rest/v1/onboarding_credentials`, {
      method: 'POST', headers: serviceHeaders(), body: JSON.stringify({
        student_id: user.id, username, virtual_email: email, guardian_email: account.guardianEmail,
        temporary_password_last4: account.temporaryPassword.slice(-4), credential_status: 'created', created_by: createdBy?.id || null,
      }),
    });
    if (!onboardingResponse.ok) {
      await removePartialAccount(user.id);
      throw new HttpError(503, 'A conta foi revertida porque não foi possível registar as credenciais de matrícula.');
    }
  }
  return { username, email, fullName: account.fullName, role: account.role, schoolYear: account.schoolYear, className: account.className, subject: assignmentTargets?.subject.name || null, teacherUsername: assignmentTargets?.teacher?.username || null, temporaryPassword: account.temporaryPassword };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  try {
    requireConfiguration({ server: true });
    const account = validateAccount(readBody(req));
    const createdBy = await authorize(req, account.role);
    return json(res, 201, { account: await createAccount(account, createdBy) });
  } catch (error) { return responseError(res, error); }
};
