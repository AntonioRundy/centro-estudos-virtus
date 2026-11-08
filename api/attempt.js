const { randomInt, randomUUID } = require('node:crypto');
const { HttpError, authenticate, getStoredState, saveStoredState, quizAvailableToStudent, json, responseError } = require('./_lib');

function shuffledIndexes(length) {
  const indexes = Array.from({ length }, (_, index) => index);
  for (let i = indexes.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  return indexes;
}

module.exports = async function handler(req, res) {
  try {
    const { profile } = await authenticate(req);
    if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
    if (profile.role !== 'student') throw new HttpError(403, 'Apenas alunos podem iniciar uma prova.');
    const quizId = String(req.body?.quizId || '');
    if (!/^[0-9a-f-]{36}$/i.test(quizId)) throw new HttpError(400, 'O questionário indicado não é válido.');

    const stored = await getStoredState();
    if (!stored.state) throw new HttpError(409, 'O professor ainda não preparou a sala.');
    const state = structuredClone(stored.state);
    const normalizedName = value => String(value || '').normalize('NFC').trim().toLocaleLowerCase('pt-PT');
    const student = (state.students || []).find(item => item.id === profile.id || normalizedName(item.name) === normalizedName(profile.full_name));
    if (!student) throw new HttpError(403, 'A conta ainda não está ligada a um aluno matriculado.');
    const studentId = profile.id;
    const group = state.groupAllocations?.[student.id] || state.groupAllocations?.[studentId] || '';
    const quiz = (state.quizzes || []).find(item => item.id === quizId &&
      quizAvailableToStudent(item, group, [student.id, studentId]));
    if (!quiz || (quiz.dueDate && quiz.dueDate < new Date().toISOString().slice(0, 10))) {
      throw new HttpError(404, 'Este questionário não está disponível.');
    }
    const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
    if (!questions.length) throw new HttpError(409, 'Este questionário ainda não tem perguntas.');

    state.quizAttempts ||= [];
    const previous = state.quizAttempts.find(item => (item.studentId === studentId || item.studentId === student.id) && item.quizId === quiz.id);
    if (previous) {
      if (previous.status !== 'in_progress') throw new HttpError(409, 'Esta tentativa já foi submetida e não pode ser reiniciada.');
      if (previous.studentId !== studentId) {
        previous.studentId = studentId;
        const migrated = await saveStoredState(state, stored.revision);
        return json(res, 200, { attempt: previous, revision: migrated.revision });
      }
      return json(res, 200, { attempt: previous, revision: stored.revision });
    }

    const startedAt = new Date();
    const minutes = Number(quiz.durationMinutes);
    const durationMinutes = Number.isInteger(minutes) && minutes > 0 ? Math.min(360, minutes) : null;
    const attempt = {
      id: randomUUID(),
      studentId,
      quizId: quiz.id,
      status: 'in_progress',
      startedAt: startedAt.toISOString(),
      deadlineAt: durationMinutes ? new Date(startedAt.getTime() + durationMinutes * 60000).toISOString() : null,
      durationMinutes,
      questionOrder: quiz.shuffleQuestions ? shuffledIndexes(questions.length) : questions.map((_, index) => index),
    };
    state.quizAttempts.push(attempt);
    const saved = await saveStoredState(state, stored.revision);
    return json(res, 200, { attempt, revision: saved.revision });
  } catch (error) {
    return responseError(res, error);
  }
};

