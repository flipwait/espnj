const { getBook, setBook, getMove, pushPrice } = require('../lib/store');
const { authHeaders } = require('../lib/polyAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const slug = req.query.slug;
  const id = req.query.id || slug;
  const workerUrl = (process.env.SMART_WORKER_URL || '').replace(/\/$/, '');
  const workerSecret = process.env.WORKER_SECRET || '';

  if (!slug && req.query.status === '1') {
    return res.status(200).json({
      ok: true,
      keysConfigured: !!(process.env.POLYMARKET_KEY_ID && process.env.POLYMARKET_SECRET_KEY),
      workerConfigured: !!workerUrl,
      note: workerUrl
        ? 'Worker URL set — Smart$ button uses tape when slug provided'
        : 'No SMART_WORKER_URL — book-only Smart$. Deploy betbetter-worker and set env.',
    });
  }

  if (!slug) {
    return res.status(400).json({ ok: false, error: 'slug required (market slug)' });
  }

  // 1) Prefer worker tape
  let tape = null;
  if (workerUrl) {
    try {
      const u =
        workerUrl +
        '/aggregate?slug=' +
        encodeURIComponent(slug) +
        '&windowMs=' +
        encodeURIComponent(String(15 * 60 * 1000));
      const r = await fetch(u, {
        headers: workerSecret ? { 'X-Worker-Secret': workerSecret } : {},
      });
      if (r.ok) tape = await r.json();
    } catch (e) {
      tape = { ok: false, error: e.message };
    }
  }

  // 2) Always also fetch public book
  try {
    const r = await fetch(
      'https://gateway.polymarket.us/v1/markets/' + encodeURIComponent(slug) + '/book',
      { headers: { Accept: 'application/json' } }
    );
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: data.message || 'book failed',
        tape,
      });
    }
    const md = data.marketData || data;
    const bids = md.bids || [];
    const offers = md.offers || [];
    const bidQty = bids.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const askQty = offers.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const imbalance =
      bidQty + askQty > 0 ? Math.round(((bidQty - askQty) / (bidQty + askQty)) * 1000) / 10 : 0;
    let lastPx = null;
    if (md.stats && md.stats.lastTradePx) {
      const v = md.stats.lastTradePx.value != null ? md.stats.lastTradePx.value : md.stats.lastTradePx;
      lastPx = typeof v === 'object' ? Number(v.value) : Number(v);
      if (lastPx > 1) lastPx = lastPx / 100;
    }
    if (lastPx) pushPrice(id || slug, lastPx);
    setBook(id || slug, { imbalance, bidQty, askQty, lastTradePx: lastPx, slug });

    const lm15 = getMove(id || slug, 15 * 60 * 1000);
    const lean = imbalance > 5 ? 'bid' : imbalance < -5 ? 'ask' : 'mixed';
    let strength = 0;
    if (Math.abs(imbalance) >= 25) strength += 2;
    else if (Math.abs(imbalance) >= 10) strength += 1;
    if (bidQty + askQty > 5000) strength += 1;
    if (tape && tape.hasTape) {
      strength = Math.max(strength, tape.strength || 0);
    }
    strength = Math.min(5, strength);

    const tags = [
      lean !== 'mixed' ? lean + '-heavy book' : 'balanced book',
      Math.abs(imbalance) >= 20 ? 'book pressure' : null,
    ];
    if (tape && tape.tags) tags.push(...tape.tags);

    return res.status(200).json({
      ok: true,
      slug,
      imbalancePct: imbalance,
      bidQty,
      askQty,
      lean: (tape && tape.lean) || lean,
      strength,
      score: Math.round(15 + (strength / 5) * 70),
      tags: tags.filter(Boolean),
      lm: { m15: lm15 },
      tape: tape,
      source: tape && tape.hasTape ? 'worker+book' : 'book',
      note:
        tape && tape.hasTape
          ? 'Tape + book'
          : workerUrl
            ? 'Worker online but no trades yet for this slug — wait or check subscription'
            : 'Book only — set SMART_WORKER_URL for clusters',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, tape });
  }
};
