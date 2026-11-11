const {
  SUPABASE_URL, authenticate, serviceHeaders, HttpError, json, responseError, isAdminTeacher,
} = require('../_lib');

function cleanSubjectName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) throw new HttpError(400, 'Indique uma disciplina entre 2 e 120 caracteres.');
  return name;
}

async function requireAdmin(req) {
  const { profile } = await authenticate(req);
  if (!isAdminTeacher(profile)) throw new HttpError(403, 'Apenas Professores Administradores podem gerir o directório.');
}

module.exports = async function handler(req, res) {
  try {
    await requireAdmin(req);
    if (req.method === 'GET') {
      const [profilesResponse, subjectsResponse] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,full_name,username,role,is_active&role=in.(admin_teacher,teacher,student)&order=full_name.asc`, { headers: serviceHeaders() }),
        fetch(`${SUPABASE_URL}/rest/v1/subjects?select=id,name,active&order=name.asc`, { headers: serviceHeaders() }),
      ]);
      if (!profilesResponse.ok || !subjectsResponse.ok) throw new HttpError(503, 'Não foi possível carregar o directório. Execute primeiro a migração de contas.');
      const [profiles, subjects] = await Promise.all([profilesResponse.json(), subjectsResponse.json()]);
      return json(res, 200, { profiles, subjects });
    }
    if (req.method === 'POST') {
      const name = cleanSubjectName(req.body?.name);
      const response = await fetch(`${SUPABASE_URL}/rest/v1/subjects`, {
        method: 'POST', headers: serviceHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ name }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new HttpError(response.status === 409 ? 409 : 400, data.message || 'Não foi possível criar a disciplina.');
      return json(res, 201, { subject: data[0] });
    }
    return json(res, 405, { error: 'Método não permitido.' });
  } catch (error) {
    return responseError(res, error);
  }
};
