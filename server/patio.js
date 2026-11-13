const { SUPABASE_URL, requireConfiguration, serviceHeaders, authenticate, HttpError, json, responseError } = require('../api/_lib');
const { canonicalRole } = require('../lib/roles');

function query(params) {
  return new URLSearchParams(params).toString();
}

async function serviceGet(path, params) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${query(params)}`, { headers: serviceHeaders() });
  if (!response.ok) throw new HttpError(503, 'Não foi possível consultar os contactos autorizados do Pátio.');
  return response.json();
}

module.exports = async function patio(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
  try {
    requireConfiguration({ server: true });
    const { profile } = await authenticate(req);
    const role = canonicalRole(profile.role);
    const today = new Date().toISOString().slice(0, 10);
    const assignments = await serviceGet('teacher_student_subject_assignments', {
      select: 'teacher_id,student_id,subject_id',
      ...(role === 'student' ? { student_id: `eq.${profile.id}` } : role === 'teacher' ? { teacher_id: `eq.${profile.id}` } : {}),
      starts_on: `lte.${today}`,
      or: `(ends_on.is.null,ends_on.gte.${today})`,
    });
    let ids;
    if (role === 'student') ids = [...new Set(assignments.map(item => item.teacher_id))];
    else if (role === 'teacher') ids = [...new Set(assignments.map(item => item.student_id))];
    else ids = (await serviceGet('profiles', { select: 'id', is_active: 'eq.true' })).map(item => item.id);
    if (!ids.length) return json(res, 200, { people: [], assignments });
    let people;
    try {
      people = await serviceGet('profiles', {
        select: 'id,full_name,username,role,school_year',
        id: `in.(${ids.join(',')})`,
        is_active: 'eq.true',
        order: 'full_name.asc',
      });
    } catch {
      // Mantém a API disponível enquanto a publicação do código antecede a
      // migração 007 que acrescenta school_year ao perfil.
      people = await serviceGet('profiles', {
        select: 'id,full_name,username,role',
        id: `in.(${ids.join(',')})`,
        is_active: 'eq.true',
        order: 'full_name.asc',
      });
    }
    return json(res, 200, { people, assignments });
  } catch (error) {
    return responseError(res, error);
  }
};
