const { fetchAllSportsEvents, LEAGUES } = require('../lib/polymarket');
const { buildSignal } = require('../lib/score');
const { buildLiveAnalysis } = require('../lib/live');
const { pushPrice, getMove, getBook, setBook } = require('../lib/store');
let matchupForEvent = async () => null;
try {
  matchupForEvent = require('../lib/espn').matchupForEvent;
} catch (e) {
  console.error('espn module optional', e.message);
}

async function fetchBookForSlug(slug) {
  if (!slug) return null;
  try {
    const r = await fetch(
      'https://gateway.polymarket.us/v1/markets/' + encodeURIComponent(slug) + '/book',
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const md = data.marketData || data;
    const bids = md.bids || [];
    const offers = md.offers || [];
    const bidQty = bids.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const askQty = offers.reduce((a, b) => a + parseFloat(b.qty || 0), 0);
    const imbalance =
      bidQty + askQty > 0 ? Math.round(((bidQty - askQty) / (bidQty + askQty)) * 1000) / 10 : 0;
    return { imbalance, bidQty, askQty };
  } catch (e) {
    return null;
  }
}



function priceToDecimal(p) {
  if (p == null || p <= 0) return '—';
  return (1 / p).toFixed(2) + 'x';
}

function priceToAmerican(p) {
  if (p == null || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return Math.round((-100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

function formatCents(p) {
  if (p == null || isNaN(p)) return '—';
  const cents = Math.round(Number(p) * 1000) / 10;
  const am = priceToAmerican(Number(p));
  const amStr = am == null ? '' : ' (' + (am > 0 ? '+' : '') + am + ')';
  return cents + '¢' + amStr;
}

function classifyMarket(m) {
  const t = (m.sportsMarketType || m.marketType || '').toLowerCase();
  const q = (m.question || '').toLowerCase();
  if (/nrfi|no run first|no runs first/.test(q) || (t.includes('first') && /no run/.test(q))) return 'nrfi';
  if (/yrfi|yes run first|run first inning/.test(q) && !/no run/.test(q)) return 'yrfi';
  if (/first.?5|f5|five innings|5 innings/.test(t + ' ' + q)) return 'f5';
  if (t.includes('spread') || /spread|cover|run line/.test(q)) return 'spread';
  if (t.includes('total') || /\bover\b|\bunder\b|o\/u|more than|less than|total runs|total points/.test(q)) return 'total';
  if (t.includes('moneyline') || t.includes('winner') || /who will win|moneyline/.test(q)) return 'moneyline';
  if (t.includes('prop') || /inning|strikeout|hits|bases|period/.test(q)) return 'prop';
  return 'prop';
}

function scoreOne(m, ev, matchup) {
  if (m.yesPrice == null) return null;
  const id = String(m.id || m.question || ev.id);
  pushPrice(id, m.yesPrice);
  const mv = getMove(id, 15 * 60 * 1000);
  let prior = null;
  if (mv && mv.from != null) prior = mv.from;
  const book = getBook(id);
  return buildSignal({
    id,
    question: m.question || ev.title,
    yesPrice: m.yesPrice,
    noPrice: m.noPrice,
    volume: m.volume || 0,
    liquidity: m.liquidity || 0,
    volume24hr: m.volume || 0,
    url: m.url || ev.url,
    priorPrice: prior,
    bookImbalance: book ? book.imbalance : null,
    matchup: matchup || null,
    marketType: classifyMarket(m),
  });
}

function sidesFromMarket(m, evTitle, type) {
  const p = m.yesPrice != null ? Number(m.yesPrice) : null;
  const no = m.noPrice != null ? Number(m.noPrice) : p != null ? 1 - p : null;
  const parts = (evTitle || '').split(/\s+vs\.?\s+/i);
  const pack = (name, price) => ({
    name,
    price,
    pct: price != null ? Math.round(price * 1000) / 10 : null,
    decimal: priceToDecimal(price),
    american: priceToAmerican(price),
    display: formatCents(price),
  });

  if (type === 'total') {
    const line = (m.question || '').match(/more than\s*([\d.]+)/i) || (m.question || '').match(/([\d.]+)\s*(?:runs|points|goals)/i);
    const lineStr = line ? line[1] : '';
    return [pack(lineStr ? 'Over ' + lineStr : 'Over', p), pack(lineStr ? 'Under ' + lineStr : 'Under', no)];
  }
  if ((type === 'moneyline' || type === 'f5') && parts.length === 2) {
    return [pack(parts[0].trim(), p), pack(parts[1].trim(), no)];
  }
  if (type === 'nrfi' || type === 'yrfi') {
    return [pack('Yes (run scores)', p), pack('No (NRFI)', no)];
  }
  // generic
  if (parts.length === 2 && (type === 'moneyline' || !type)) {
    return [pack(parts[0].trim(), p), pack(parts[1].trim(), no)];
  }
  return [pack('Yes', p), pack('No', no)];
}

function matchesType(type, marketType) {
  if (marketType === 'all') return true;
  if (marketType === 'prop') return ['prop', 'f5', 'nrfi', 'yrfi'].includes(type);
  if (marketType === 'nrfi') return type === 'nrfi' || type === 'yrfi';
  return type === marketType;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const mode = (req.query.mode || 'all').toLowerCase();
    const league = (req.query.league || '').toLowerCase();
    const marketType = (req.query.marketType || 'all').toLowerCase();
    const minEdge = parseFloat(req.query.minEdge || '0');
    const minLiq = parseFloat(req.query.minLiq || '0');
    const rankFilter = (req.query.rank || '').toLowerCase();
    const minScore = parseFloat(req.query.minScore || '0');

    let events = await fetchAllSportsEvents({ limitPerLeague: 22 });
    if (mode === 'live') events = events.filter((e) => e.live && !e.ended);
    if (mode === 'upcoming') events = events.filter((e) => !e.live && !e.ended);
    if (league) events = events.filter((e) => e.league === league);

    events.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return new Date(a.startTime || 0) - new Date(b.startTime || 0);
    });

    
    // Warm order books for Smart$ (limit to avoid rate limits)
    try {
      const warmList = [];
      for (const ev of events) {
        for (const m of ev.markets || []) {
          if (m.yesPrice == null) continue;
          const slug = m.slug || m.marketSlug || (m.url && String(m.url).split('/').pop());
          if (!slug) continue;
          warmList.push({ id: String(m.id || m.question || ev.id), slug: String(slug) });
          if (warmList.length >= 8) break;
        }
        if (warmList.length >= 8) break;
      }
      await Promise.all(
        warmList.map(async (w) => {
          const b = await fetchBookForSlug(w.slug);
          if (b) setBook(w.id, { ...b, slug: w.slug });
        })
      );
    } catch (e) {}


    // ESPN matchups for unique events (limit to keep Vercel time safe)
    const matchupCache = {};
    try {
      const seen = new Set();
      const jobs = [];
      for (const ev of events) {
        const title = ev.title || ev.name || '';
        const lg = (ev.league || league || 'mlb').toLowerCase();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        if (jobs.length >= 6) break;
        jobs.push(
          matchupForEvent(lg, title)
            .then((m) => {
              if (m && !m.error) matchupCache[title] = m;
            })
            .catch(() => {})
        );
      }
      await Promise.all(jobs);
    } catch (e) {}

const flattenTypes = ['total', 'spread', 'prop', 'f5', 'nrfi', 'yrfi'];

    // Flat market cards (each Polymarket market = one card)
    if (flattenTypes.includes(marketType)) {
      const flat = [];
      for (const ev of events) {
        for (const m of ev.markets || []) {
          const type = classifyMarket(m);
          if (!matchesType(type, marketType)) continue;
          if (m.yesPrice == null) continue;
          const sc = scoreOne(m, ev, matchupCache[ev.title || ev.name || ''] || null);
          const sides = sidesFromMarket(m, ev.title, type);
          const pickSide = sc && sc.side === 'NO' ? sides[1] : sides[0];
          flat.push({
            id: m.id || ev.id + '-' + type,
            title: m.question || ev.title,
            eventTitle: ev.title,
            league: ev.league,
            live: !!ev.live,
            ended: !!ev.ended,
            period: ev.period || '',
            score: ev.score || null,
            startTime: ev.startTime,
            marketCount: 1,
            marketType: type,
            url: m.url || ev.url,
            sides,
            modelPick: pickSide ? pickSide.name : sc ? sc.side : null,
            rank: sc ? sc.rank : 'Pass',
            netEdge: sc ? sc.netEdge : 0,
            ev: sc ? sc.ev : null,
            betScore: sc ? sc.betScore : 0,
            confidence: sc ? sc.confidence : 0,
            fairProbability: sc ? sc.fairProbability : null,
            marketPriceCents: sc ? sc.marketPriceCents : null,
            impliedPct: sc ? sc.marketPriceCents : Math.round(m.yesPrice * 1000) / 10,
            modelFairPct: sc ? sc.fairProbability : null,
            priceDisplay: formatCents(m.yesPrice),
            evaluate: sc ? sc.evaluate : null,
            lmBadge: sc ? sc.lmBadge : null,
            liquidity: m.liquidity || 0,
            props: [],
            bestProp: null,
            scanType: marketType,
            isFlatMarket: true,
          });
          flat[flat.length - 1].liveAnalysis = buildLiveAnalysis(flat[flat.length - 1]);
        }
      }
      flat.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        return (b.betScore || 0) - (a.betScore || 0);
      });
      flat.forEach((g) => { g.liveAnalysis = buildLiveAnalysis(g); });
      let out = flat;
      if (minEdge > 0) out = out.filter((g) => Math.abs(g.netEdge || 0) >= minEdge);
      if (minScore > 0) out = out.filter((g) => (g.betScore || 0) >= minScore);
      if (minLiq > 0) out = out.filter((g) => (g.liquidity || 0) >= minLiq);
      if (rankFilter === 'elite') out = out.filter((g) => g.rank === 'Elite');
      if (rankFilter === 'good') out = out.filter((g) => g.rank === 'Good' || g.rank === 'Elite');

      return res.status(200).json({
        ok: true,
        source: 'gateway.polymarket.us',
        leagues: LEAGUES,
        marketType,
        flat: true,
        updatedAt: new Date().toISOString(),
        summary: {
          total: out.length,
          live: out.filter((g) => g.live).length,
          upcoming: out.filter((g) => !g.live && !g.ended).length,
          elite: out.filter((g) => g.rank === 'Elite').length,
          good: out.filter((g) => g.rank === 'Good').length,
        },
        games: out,
      });
    }

    // Game-level cards (moneyline / all)
    const games = events.map((ev) => {
      const markets = ev.markets || [];
      const typed = markets.map((m) => ({ m, type: classifyMarket(m) }));
      let focus = typed;
      if (marketType === 'moneyline') focus = typed.filter((x) => x.type === 'moneyline');

      const primary = (focus.find((x) => x.type === 'moneyline') || focus[0] || typed[0] || {}).m || null;
      const primaryType = primary ? classifyMarket(primary) : 'moneyline';
      const sides = primary ? sidesFromMarket(primary, ev.title, primaryType) : [];
      const mlScore = primary ? scoreOne(primary, ev, matchupCache[ev.title || ev.name || ""] || null) : null;
      let modelPick = null;
      if (mlScore && sides.length >= 2) {
        modelPick = mlScore.side === 'NO' ? sides[1].name : sides[0].name;
      }

      const propList = typed
        .filter((x) => x.m !== primary && x.m.yesPrice != null)
        .map(({ m, type }) => {
          const sc = scoreOne(m, ev, matchupCache[ev.title || ev.name || ''] || null);
          const ps = sidesFromMarket(m, ev.title, type);
          const pick = sc && sc.side === 'NO' ? (ps[1] && ps[1].name) : (ps[0] && ps[0].name);
          return {
            id: m.id,
            question: m.question,
            type,
            rank: sc ? sc.rank : 'Pass',
            netEdge: sc ? sc.netEdge : 0,
            ev: sc ? sc.ev : null,
            betScore: sc ? sc.betScore : 0,
            modelPick: pick,
            impliedPct: sc ? sc.marketPriceCents : null,
            modelFairPct: sc ? sc.fairProbability : null,
            priceDisplay: formatCents(m.yesPrice),
            url: m.url,
          };
        })
        .sort((a, b) => (b.betScore || 0) - (a.betScore || 0));

      const bestProp = propList.find((p) => p.rank === 'Elite' || p.rank === 'Good') || propList[0] || null;

      return {
        id: ev.id,
        title: ev.title,
        league: ev.league,
        live: !!ev.live,
        ended: !!ev.ended,
        period: ev.period || '',
        score: ev.score || null,
        startTime: ev.startTime,
        marketCount: markets.length,
        url: ev.url,
        sides,
        modelPick,
        rank: mlScore ? mlScore.rank : 'Pass',
        netEdge: mlScore ? mlScore.netEdge : 0,
        ev: mlScore ? mlScore.ev : null,
        betScore: mlScore ? mlScore.betScore : 0,
        confidence: mlScore ? mlScore.confidence : 0,
        fairProbability: mlScore ? mlScore.fairProbability : null,
        marketPriceCents: mlScore ? mlScore.marketPriceCents : null,
        impliedPct: mlScore ? mlScore.marketPriceCents : null,
        modelFairPct: mlScore ? mlScore.fairProbability : null,
        priceDisplay: primary ? formatCents(primary.yesPrice) : null,
        evaluate: mlScore ? mlScore.evaluate : null,
        lmBadge: mlScore ? mlScore.lmBadge : null,
        liquidity: primary ? primary.liquidity || 0 : 0,
        bestProp,
        props: propList.filter((p) => p.rank === 'Elite' || p.rank === 'Good').slice(0, 10),
        propsAll: propList,
        scanType: marketType,
        isFlatMarket: false,
      };
    });

    games.forEach((g) => { g.liveAnalysis = buildLiveAnalysis(g); });
    let filtered = games;
    if (minEdge > 0) {
      filtered = filtered.filter(
        (g) => Math.abs(g.netEdge || 0) >= minEdge || (g.props || []).some((p) => Math.abs(p.netEdge || 0) >= minEdge)
      );
    }
    if (minLiq > 0) filtered = filtered.filter((g) => (g.liquidity || 0) >= minLiq || g.marketCount > 3);
    if (minScore > 0) filtered = filtered.filter((g) => (g.betScore || 0) >= minScore);
    if (rankFilter === 'elite') {
      filtered = filtered.filter((g) => g.rank === 'Elite' || (g.props || []).some((p) => p.rank === 'Elite'));
    }
    if (rankFilter === 'good') {
      filtered = filtered.filter(
        (g) => g.rank === 'Good' || g.rank === 'Elite' || (g.props || []).some((p) => p.rank === 'Good' || p.rank === 'Elite')
      );
    }

    return res.status(200).json({
      ok: true,
      source: 'gateway.polymarket.us',
      leagues: LEAGUES,
      marketType,
      updatedAt: new Date().toISOString(),
      summary: {
        total: filtered.length,
        live: filtered.filter((g) => g.live).length,
        upcoming: filtered.filter((g) => !g.live && !g.ended).length,
        elite: filtered.filter((g) => g.rank === 'Elite').length,
        good: filtered.filter((g) => g.rank === 'Good').length,
      },
      games: filtered,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
