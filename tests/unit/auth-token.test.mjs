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
