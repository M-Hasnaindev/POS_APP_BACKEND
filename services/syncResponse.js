const { promisify } = require('util');
const gzip = promisify(require('zlib').gzip);

// A 5,000-row master page can exceed the serverless response limit as plain
// JSON. Native fetch transparently decodes gzip; preserve every row/column.
async function sendSyncJson(req, res, payload) {
  if (/\bgzip\b/i.test(String(req.headers?.['accept-encoding'] || ''))) {
    const bytes = await gzip(Buffer.from(JSON.stringify(payload)));
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    return res.send(bytes);
  }
  return res.json(payload);
}
module.exports = { sendSyncJson };
