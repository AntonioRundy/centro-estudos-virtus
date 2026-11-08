import test from 'node:test';
import assert from 'node:assert/strict';
import { weightedAssessmentAverage } from '../../lib/assessment.mjs';

test('calcula média na escala 0–20 com prática a 30%', () => {
  const average = weightedAssessmentAverage({ quiz: 10, second: 12, written: 14, practical: 18, other: 16 });
  assert.equal(average, 14.5);
});

test('normaliza apenas os pesos das componentes registadas', () => {
  const average = weightedAssessmentAverage({ quiz: 10, second: 20, written: null, practical: null, other: null });
  assert.equal(average, 15);
});

test('rejeita automaticamente valores fora da escala 0–20', () => {
  assert.equal(weightedAssessmentAverage({ quiz: 21 }), null);
});
