export const ASSESSMENT_WEIGHTS = Object.freeze({
  quiz: 0.175,
  second: 0.175,
  written: 0.175,
  practical: 0.30,
  other: 0.175,
});

export function validMark(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 20 ? score : null;
}

export function weightedAssessmentAverage(grades) {
  const parts = Object.entries(ASSESSMENT_WEIGHTS)
    .map(([key, weight]) => ({ score: validMark(grades[key]), weight }))
    .filter(({ score }) => score !== null);
  if (!parts.length) return null;
  const weight = parts.reduce((sum, part) => sum + part.weight, 0);
  return Math.round((parts.reduce((sum, part) => sum + part.score * part.weight, 0) / weight) * 100) / 100;
}

