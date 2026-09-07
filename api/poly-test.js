const { authHeaders } = require('../lib/polyAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const keyId = process.env.POLYMARKET_KEY_ID || (req.body && req.body.keyId) || req.query.keyId || '';
  const secret = process.env.POLYMARKET_SECRET_KEY || (req.body && req.body.secret) || req.query.secret || '';

  if (!keyId || !secret) {
    return res.status(400).json({
      ok: false,
      error: 'Missing keys. Set POLYMARKET_KEY_ID + POLYMARKET_SECRET_KEY on Vercel, or pass keyId & secret for a one-off test.',
    });
  }

  const headers = authHeaders(keyId, secret, 'GET', '/v1/ws/markets');
  if (headers.error) {
    return res.status(400).json({
      ok: false,
      error: 'Could not sign with this secret. Check format (base64 seed from Polymarket developer portal).',
      detail: headers.error,
    });
  }

  return res.status(200).json({
    ok: true,
    message: 'Keys sign correctly. Smart$/LM use public books + snapshots on Vercel; add a worker later for full TRADE clusters.',
    headersPresent: ['X-PM-Access-Key', 'X-PM-Timestamp', 'X-PM-Signature'],
    next: 'Add keys to Vercel env. Hit /api/cron/snapshot to build LM history. Cards use store automatically.',
  });
};
