/**
 * Compatibilidade com o limite de funções do plano Hobby da Vercel.
 * Mantém as URLs públicas (/api/auth/*, /api/assets/* e /api/admin/*), mas
 * distribui estas rotas por uma única função serverless.
 */
const handlers = {
  'auth/change-password': require('../server/auth/change-password'),
  'auth/config': require('../server/auth/config'),
  'auth/request-password-reset': require('../server/auth/request-password-reset'),
  'auth/session': require('../server/auth/session'),
  'assets/upload': require('../server/assets/upload'),
  'assets/read': require('../server/assets/read'),
  'assets/delete': require('../server/assets/delete'),
  'admin/provision': require('../server/admin/provision'),
  'admin/directory': require('../server/admin/directory'),
};

function routeFromRequest(req) {
  if (Array.isArray(req.query?.route)) return req.query.route.join('/');
  if (typeof req.query?.route === 'string') return req.query.route;
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  return pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
}

module.exports = async function routeHandler(req, res) {
  const route = routeFromRequest(req);
  const handler = handlers[route];
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Rota não encontrada.' }));
  }
  return handler(req, res);
};
