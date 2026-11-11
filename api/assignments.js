const {
  SUPABASE_URL, authenticate, serviceHeaders, HttpError, json, responseError,
} = require('./_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAdmin(profile) {
  return profile?.role === 'admin_teacher';
}

function validId(value) {
  return UUID.test(String(value || ''));
}

async function fetchAssignments(filter = '') {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/teacher_student_subject_assignments?select=id,teacher_id,student_id,subject_id,is_primary,starts_on,ends_on,created_at&order=starts_on.desc${filter}`,
    { headers: serviceHeaders() },
  );
  if (!response.ok) throw new HttpError(503, 'Não foi possível consultar as atribuições. Execute primeiro a migração do Centro Virtus.');
  return response.json();
}

async function assignmentForId(id) {
  const rows = await fetchAssignments(`&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0] || null;
}

module.exports = async function handler(req, res) {
  try {
    const { profile } = await authenticate(req);

    if (req.method === 'GET') {
      if (profile.role === 'secretary') return json(res, 200, { assignments: [] });
      const filter = isAdmin(profile)
        ? ''
        : profile.role === 'teacher'
          ? `&teacher_id=eq.${encodeURIComponent(profile.id)}`
          : `&student_id=eq.${encodeURIComponent(profile.id)}`;
      return json(res, 200, { assignments: await fetchAssignments(filter) });
    }

    if (!isAdmin(profile)) throw new HttpError(403, 'Apenas o Professor Administrador pode gerir atribuições.');

    if (req.method === 'POST') {
      const { teacherId, studentId, subjectId, startsOn, endsOn, isPrimary = false } = req.body || {};
      if (![teacherId, studentId, subjectId].every(validId)) throw new HttpError(400, 'Professor, aluno e disciplina são obrigatórios.');
      if (startsOn && !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) throw new HttpError(400, 'A data inicial não é válida.');
      if (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) throw new HttpError(400, 'A data final não é válida.');
      const response = await fetch(`${SUPABASE_URL}/rest/v1/teacher_student_subject_assignments`, {
        method: 'POST',
        headers: serviceHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({
          teacher_id: teacherId, student_id: studentId, subject_id: subjectId,
          starts_on: startsOn || new Date().toISOString().slice(0, 10),
          ends_on: endsOn || null, is_primary: isPrimary === true,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new HttpError(400, data.message || 'Não foi possível criar a atribuição.');
      return json(res, 201, { assignment: data[0] });
    }

    if (req.method === 'PATCH') {
      const { id, endsOn, isPrimary } = req.body || {};
      if (!validId(id)) throw new HttpError(400, 'A atribuição indicada não é válida.');
      if (!await assignmentForId(id)) throw new HttpError(404, 'A atribuição não existe.');
      const payload = {};
      if (endsOn !== undefined) {
        if (endsOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) throw new HttpError(400, 'A data final não é válida.');
        payload.ends_on = endsOn;
      }
      if (isPrimary !== undefined) payload.is_primary = isPrimary === true;
      if (!Object.keys(payload).length) throw new HttpError(400, 'Indique pelo menos uma alteração.');
      const response = await fetch(`${SUPABASE_URL}/rest/v1/teacher_student_subject_assignments?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: serviceHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new HttpError(400, data.message || 'Não foi possível atualizar a atribuição.');
      return json(res, 200, { assignment: data[0] });
    }

    return json(res, 405, { error: 'Método não permitido.' });
  } catch (error) {
    return responseError(res, error);
  }
};
