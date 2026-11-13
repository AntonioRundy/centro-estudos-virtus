import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const handler = fs.readFileSync(path.join(root, 'server/auth/token.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('o login e a renovação de sessão passam pela mesma origem da aplicação', () => {
  assert.match(handler, /auth\/v1\/token\?grant_type=\$\{grantType\}/);
  assert.match(page, /fetch\('\/api\/auth\/token'/);
  assert.doesNotMatch(page, /fetch\(`\$\{authConfig\.url\}\/auth\/v1\/token\?grant_type=password`/);
});

test('a rota não devolve detalhes sensíveis de falhas do provedor de autenticação', () => {
  assert.match(handler, /Nome de utilizador ou palavra-passe inválidos/);
  assert.doesNotMatch(handler, /return json\(res, 401, data\)/);
});

test('o domínio virtual de novas contas e o domínio usado no login são o mesmo', () => {
  const provisioning = fs.readFileSync(path.join(root, 'server/admin/provision.js'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'server/auth/config.js'), 'utf8');
  const helpers = fs.readFileSync(path.join(root, 'api/_lib.js'), 'utf8');
  assert.match(helpers, /VIRTUAL_EMAIL_DOMAIN/);
  assert.match(provisioning, /VIRTUAL_EMAIL_DOMAIN/);
  assert.match(config, /virtualEmailDomain: VIRTUAL_EMAIL_DOMAIN/);
  assert.match(page, /authConfig\?\.virtualEmailDomain/);
});

test('o username é convertido para o e-mail virtual antes de pedir o token', () => {
  assert.match(page, /function usernameEmail\(username\)/);
  assert.match(page, /return value\.includes\('@'\)\?value:usernameEmail\(value\)/);
  assert.match(page, /body:JSON\.stringify\(\{email:loginEmail\(identity\),identity,password\}\)/);
  assert.match(page, /users\.centro-virtus\.vercel\.app/);
});

test('contas legadas são autenticadas e normalizadas no servidor sem expor e-mails antigos', () => {
  assert.match(handler, /async function legacyAuthEmail\(username\)/);
  assert.match(handler, /auth\/v1\/admin\/users\/\$\{encodeURIComponent\(profile\.id\)\}/);
  assert.match(handler, /async function normalizeLegacyEmail\(userId, targetEmail\)/);
  assert.match(handler, /requestBody\.email === virtualEmail/);
  assert.match(handler, /await normalizeLegacyEmail\(legacy\.id, virtualEmail\)/);
  assert.doesNotMatch(page, /legacyAuthEmail|normalizeLegacyEmail/);
});

test('a primeira sessão é criada antes de obrigar a troca da palavra-passe', () => {
  const login = page.indexOf('saveAuthSession(data)');
  const profile = page.indexOf("authProfile=await apiRequest('/api/auth/session')", login);
  const gate = page.indexOf('if(authProfile.must_change_password){renderPasswordChange();return}', profile);
  assert.ok(login >= 0 && profile > login && gate > profile);
  assert.match(page, /body:JSON\.stringify\(\{password\}\)/);
  assert.match(fs.readFileSync(path.join(root, 'server/auth/change-password.js'), 'utf8'), /must_change_password: false/);
});

test('o perfil é sempre consultado pelo UUID devolvido pelo Supabase Auth', () => {
  const auth = fs.readFileSync(path.join(root, 'api/_lib.js'), 'utf8');
  const provision = fs.readFileSync(path.join(root, 'server/admin/provision.js'), 'utf8');
  assert.match(auth, /profiles\?select=.*&id=eq\.\$\{encodeURIComponent\(user\.id\)\}/s);
  assert.match(provision, /id: user\.id, username, full_name: account\.fullName/);
});

test('o utilitário de Secretaria cria Auth e profile com o mesmo UUID e exige troca de senha', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/provision-secretary.mjs'), 'utf8');
  assert.match(script, /const username = 'secretaria\.virtus'/);
  assert.match(script, /auth\/v1\/admin\/users/);
  assert.match(script, /id: user\.id/);
  assert.match(script, /role: 'secretary'/);
  assert.match(script, /must_change_password: true/);
});

test('a recuperação das primeiras contas repõe a credencial sem alterar papéis ou UUIDs', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/reset-initial-center-accounts.mjs'), 'utf8');
  assert.match(script, /secretaria\.virtus', 'allan\.rafael', 'angel\.rafael/);
  assert.match(script, /password: temporaryPassword/);
  assert.match(script, /email_confirm: true/);
  assert.match(script, /must_change_password: true/);
  assert.match(script, /String\(session\.user\?\.id \|\| ''\) !== String\(profile\.id\)/);
  assert.doesNotMatch(script, /app_metadata|user_metadata/);
  assert.doesNotMatch(script, /JSON\.stringify\(\{ email, password: temporaryPassword, email_confirm: true,\s*role:/s);
});

test('o acesso do Centro usa a identidade própria e a textura geométrica local', () => {
  assert.match(page, /assets\/centro-login-geometry\.png/);
  assert.match(page, /filter:invert\(1\) opacity\(\.15\)/);
  assert.match(page, /Entrar no Virtus/);
  assert.match(page, /Centro de Estudos e Explicações Virtus/);
  assert.doesNotMatch(page.match(/function renderAuthScreen[\s\S]*?function renderPasswordChange/)?.[0] || '', /Universidade Agostinho Neto|Departamento de Geofísica|Diagrafias/);
});

test('as rotas universitárias antigas não voltam a expor páginas no Centro Virtus', () => {
  const renderView = page.match(/function renderView\(\)[\s\S]*?function mondayForWeek/)?.[0] || '';
  assert.match(renderView, /case'quizzes':case'tasks':return renderCenterTasks\(\)/);
  assert.match(renderView, /case'results':case'gradebook':case'correction':case'integrityReport':return renderCenterResults\(\)/);
});
