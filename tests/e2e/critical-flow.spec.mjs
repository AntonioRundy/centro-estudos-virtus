import { test, expect } from '@playwright/test';
import { weightedAssessmentAverage } from '../../lib/assessment.mjs';

/**
 * Requires E2E_BASE_URL to point at a disposable Vercel/Supabase test deployment.
 * The test account and quiz are intentionally supplied through environment variables:
 * E2E_STUDENT_USERNAME, E2E_STUDENT_PASSWORD, E2E_TEACHER_USERNAME, E2E_TEACHER_PASSWORD.
 */
const configured = Boolean(process.env.E2E_BASE_URL && process.env.E2E_STUDENT_USERNAME && process.env.E2E_STUDENT_PASSWORD && process.env.E2E_TEACHER_USERNAME && process.env.E2E_TEACHER_PASSWORD);

test.describe('caminho crítico da Sala Virtus', () => {
  test.skip(!configured, 'Defina E2E_BASE_URL e as quatro credenciais descartáveis para executar contra Supabase de testes.');

  test('aluno submete prova e docente lança pauta ponderada', async ({ browser }) => {
    const student = await browser.newPage();
    await student.goto('/');
    await student.getByLabel('Nome de utilizador').fill(process.env.E2E_STUDENT_USERNAME);
    await student.getByLabel('Palavra-passe').fill(process.env.E2E_STUDENT_PASSWORD);
    await student.getByRole('button', { name: 'Entrar' }).click();
    await expect(student.getByRole('heading', { name: /Área de Acesso do Aluno/i })).toBeVisible();
    await student.getByRole('button', { name: 'Questionários (TPC)' }).click();
    await student.getByRole('button', { name: 'Responder' }).first().click();
    // The seeded QA quiz must have at least one answerable question and the detector test flag enabled.
    await student.getByRole('button', { name: /Submeter respostas/i }).click();
    await expect(student.getByText(/submetido|concluído/i)).toBeVisible();

    const teacher = await browser.newPage();
    await teacher.goto('/');
    await teacher.getByLabel('Nome de utilizador').fill(process.env.E2E_TEACHER_USERNAME);
    await teacher.getByLabel('Palavra-passe').fill(process.env.E2E_TEACHER_PASSWORD);
    await teacher.getByRole('button', { name: 'Entrar' }).click();
    await teacher.getByRole('button', { name: 'Resultados' }).click();
    await teacher.getByRole('button', { name: /Pauta provisória/i }).click();
    const row = teacher.locator('tr').filter({ hasText: process.env.E2E_STUDENT_NAME || '' }).first();
    await row.locator('[data-field="quizScoreOverride"]').fill('10');
    await row.locator('[data-field="secondWrittenScore"]').fill('12');
    await row.locator('[data-field="writtenScore"]').fill('14');
    await row.locator('[data-field="practicalScoreOverride"]').fill('18');
    await row.locator('[data-field="otherScoreOverride"]').fill('16');
    await teacher.getByRole('button', { name: /Gravar alterações/i }).click();

    expect(weightedAssessmentAverage({ quiz:10, second:12, written:14, practical:18, other:16 })).toBe(14.5);
    await expect(row).toContainText(/14[,\.]5/);
  });
});
