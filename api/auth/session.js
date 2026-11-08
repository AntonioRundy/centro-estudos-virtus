const { authenticate, json, responseError } = require('../_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
  try {
    const { profile } = await authenticate(req);
    return json(res, 200, profile);
  } catch (error) {
    return responseError(res, error);
  }
};

