const service = require('../services/localAiService');
const handle = fn => async (req, res) => {
  try { return res.json({ success: true, result: await fn(req.body || {}) }); }
  catch (error) {
    console.warn('[Local AI]', error.code || error.name, error.message);
    return res.status(error.code === 'OLLAMA_TIMEOUT' ? 503 : 422).json({ success: false, message: error.publicMessage || error.message || 'Local AI planning unavailable' });
  }
};
exports.plan = handle(service.planLocalAnalysis);
exports.explain = handle(service.explainLocalAnalysis);
exports.reports = (_req, res) => res.json({ success: true, reports: service.localCatalog() });
