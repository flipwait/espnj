const crypto = require('crypto');

/**
 * Sign Polymarket US request.
 * Secret: base64 seed (32 bytes) or hex — from developer portal.
 * Headers: X-PM-Access-Key, X-PM-Timestamp, X-PM-Signature
 */
function normalizeSecret(secretKey) {
  if (!secretKey) return null;
  const s = String(secretKey).trim();
  let buf;
  try {
    if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 64) buf = Buffer.from(s.slice(0, 64), 'hex');
    else buf = Buffer.from(s, 'base64');
  } catch (e) {
    return null;
  }
  // Ed25519 seed is 32 bytes; some exports are 64 (seed+pub)
  if (buf.length >= 64) buf = buf.slice(0, 32);
  if (buf.length !== 32) return null;
  return buf;
}

function signRequest(secretKey, method, path, timestampMs) {
  const seed = normalizeSecret(secretKey);
  if (!seed) return null;
  const ts = String(timestampMs || Date.now());
  const message = ts + String(method || 'GET').toUpperCase() + path;
  try {
    // PKCS8 DER prefix for Ed25519 private key
    const derPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const key = crypto.createPrivateKey({
      key: Buffer.concat([derPrefix, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const sig = crypto.sign(null, Buffer.from(message, 'utf8'), key);
    return { timestamp: ts, signature: sig.toString('base64') };
  } catch (e) {
    return { error: e.message };
  }
}

function authHeaders(keyId, secretKey, method, path) {
  const signed = signRequest(secretKey, method, path);
  if (!signed || signed.error) return { error: (signed && signed.error) || 'bad secret' };
  return {
    'X-PM-Access-Key': keyId,
    'X-PM-Timestamp': signed.timestamp,
    'X-PM-Signature': signed.signature,
    Accept: 'application/json',
  };
}

module.exports = { signRequest, authHeaders, normalizeSecret };
