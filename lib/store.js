/** Ephemeral store (warm lambda). Cron + traffic keep it useful; not multi-region durable. */
const g = globalThis;
if (!g.__bbStore) {
  g.__bbStore = {
    prices: {}, // id -> [{t, p}]
    books: {},  // id -> {t, imbalance, bidQty, askQty, lastTradePx}
    meta: { lastSnapshot: null, lastSmart: null },
  };
}
const store = g.__bbStore;

function pushPrice(id, p, max = 48) {
  if (!id || p == null || isNaN(p)) return;
  const px = Number(p);
  if (px <= 0 || px >= 1) return;
  if (!store.prices[id]) store.prices[id] = [];
  store.prices[id].push({ t: Date.now(), p: px });
  if (store.prices[id].length > max) store.prices[id] = store.prices[id].slice(-max);
}

function getPriceHistory(id) {
  return store.prices[id] || [];
}

function getMove(id, windowMs) {
  const h = getPriceHistory(id);
  if (h.length < 2) return null;
  const now = Date.now();
  const current = h[h.length - 1];
  let past = null;
  for (let i = h.length - 2; i >= 0; i--) {
    if (now - h[i].t >= windowMs) {
      past = h[i];
      break;
    }
  }
  if (!past) past = h[0];
  if (!past || !current) return null;
  return {
    movePp: Math.round((current.p - past.p) * 1000) / 10,
    from: past.p,
    to: current.p,
    ageMs: current.t - past.t,
  };
}

function setBook(id, data) {
  store.books[id] = { ...data, t: Date.now() };
}

function getBook(id) {
  return store.books[id] || null;
}

module.exports = { store, pushPrice, getPriceHistory, getMove, setBook, getBook };
