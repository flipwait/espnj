/**
 * BetBetter Evaluate — 3 card models + gates
 * 1 Real EV (fair vs price, net EV)
 * 2 Matchup (H2H + L10 H/A + scoring) — neutral when data missing
 * 3 Liq / Fill quality
 * LM = badge/veto only · Smart$ = button only
 */

function clamp(x, a = 0.01, b = 0.99) {
  return Math.max(a, Math.min(b, x));
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function calcEV(fair01, price01) {
  if (fair01 == null || price01 == null || price01 <= 0) return null;
  return Math.round((fair01 - price01) * 1000) / 10;
}
function scoreFromEdge(edgePp) {
  const e = Number(edgePp) || 0;
  const t = 1 / (1 + Math.exp(-(e - 1.5) / 3.2));
  return Math.round(clamp01(t) * 100);
}

/**
 * matchup optional: {
 *   homeL10: { w, l, rf, ra },
 *   awayL10: { w, l, rf, ra },
 *   h2h: { homeWins, awayWins, avgTotal, n },
 *   supportSide: 'home'|'away'|'over'|'under'|null
 * }
 */
function matchupScore(matchup, pickSide, marketType) {
  if (!matchup || (!matchup.homeL10 && !matchup.awayL10 && !matchup.h2h)) {
    return {
      name: 'Matchup',
      score: 50,
      label: 'No form data — higher EV required',
      confidence: 'low',
      detail: null,
      supportsPick: null,
    };
  }
  let pts = 50;
  const lines = [];
  const home = matchup.homeL10;
  const away = matchup.awayL10;
  const h2h = matchup.h2h;

  if (home && home.w != null) {
    const g = (home.w || 0) + (home.l || 0) || 1;
    const wr = home.w / g;
    pts += (wr - 0.5) * 40;
    lines.push(
      'Home L10 ' +
        home.w +
        '-' +
        home.l +
        (home.rf != null ? ' · ' + home.rf + ' RF / ' + (home.ra != null ? home.ra : '?') + ' RA' : '')
    );
  }
  if (away && away.w != null) {
    const g = (away.w || 0) + (away.l || 0) || 1;
    const wr = away.w / g;
    // strong away form raises away; weak away raises home lean
    pts -= (wr - 0.5) * 40;
    lines.push(
      'Away L10 ' +
        away.w +
        '-' +
        away.l +
        (away.rf != null ? ' · ' + away.rf + ' RF / ' + (away.ra != null ? away.ra : '?') + ' RA' : '')
    );
  }
  if (h2h && h2h.n >= 3) {
    const hw = h2h.homeWins || 0;
    const aw = h2h.awayWins || 0;
    const tot = hw + aw || 1;
    pts += (hw / tot - 0.5) * 25;
    lines.push('H2H ' + hw + '-' + aw + ' (n=' + h2h.n + ')' + (h2h.avgTotal != null ? ' · avg tot ' + h2h.avgTotal : ''));
  } else if (h2h) {
    lines.push('H2H sample thin');
  }

  pts = Math.round(clamp01(pts / 100) * 100);
  // Map support: high pts leans home for ML; for totals use matchup.totalLean
  let supportsPick = null;
  if (pickSide) {
    const leanHome = pts >= 58;
    const leanAway = pts <= 42;
    const ps = String(pickSide).toLowerCase();
    if (leanHome && (ps.includes('home') || matchup.homeName && ps.includes(String(matchup.homeName).toLowerCase().slice(0, 5))))
      supportsPick = true;
    else if (leanAway && (ps.includes('away') || matchup.awayName && ps.includes(String(matchup.awayName).toLowerCase().slice(0, 5))))
      supportsPick = true;
    else if (pts >= 45 && pts <= 55) supportsPick = null;
    else supportsPick = false;
  }

  return {
    name: 'Matchup',
    score: pts,
    label: pts >= 62 ? 'Supports home lean' : pts <= 38 ? 'Supports away lean' : 'Mixed / neutral',
    confidence: home && away ? 'medium' : 'low',
    detail: lines.join(' · ') || null,
    supportsPick,
    raw: matchup,
  };
}

function buildFair(price01, matchupModel, marketType) {
  // Anchor to market; nudge only when matchup has real data
  let fair = price01;
  if (matchupModel.confidence === 'low' || matchupModel.score === 50) {
    return clamp(fair); // no fake nudge
  }
  // score 50 = neutral; 70 = lean home/yes side slightly
  const tilt = (matchupModel.score - 50) / 50; // -1..1
  const maxNudge = 0.06; // max 6pp from form
  fair = clamp(price01 + tilt * maxNudge * 0.5);
  return fair;
}

function evaluateMarket(norm) {
  let rawP = Number(norm.yesPrice);
  if (rawP > 1 && rawP <= 100) rawP = rawP / 100;
  const p = clamp(rawP || 0.5);
  const vol = Number(norm.volume || 0);
  const liq = Number(norm.liquidity || 0);
  const vol24 = Number(norm.volume24hr || vol || 0);
  const id = norm.id || norm.question || 'x';
  const priorP = norm.priorPrice != null ? clamp(Number(norm.priorPrice)) : null;
  const marketType = norm.marketType || 'moneyline';

  const matchupModel = matchupScore(norm.matchup, norm.pickHint || null, marketType);

  // Fair: market-anchored; only move with real matchup data
  const fairYes = buildFair(p, matchupModel, marketType);

  let side = 'YES';
  let sidePrice = p;
  let sideFair = fairYes;
  if (fairYes < p) {
    side = 'NO';
    sidePrice = clamp(1 - p);
    sideFair = 1 - fairYes;
  }
  // Prefer explicit model pick from sides if provided later
  if (norm.forcedSide === 'NO') {
    side = 'NO';
    sidePrice = clamp(1 - p);
    sideFair = 1 - fairYes;
  } else if (norm.forcedSide === 'YES') {
    side = 'YES';
    sidePrice = p;
    sideFair = fairYes;
  }

  const edgePp = Math.round((sideFair - sidePrice) * 1000) / 10;
  const feeBuffer = 1.0; // pp
  const grossEv = calcEV(sideFair, sidePrice);
  const netEvPct = grossEv != null ? Math.round((grossEv - feeBuffer) * 10) / 10 : null;

  // Noise floor: sub-2pp before fee is not edge
  const realEdge = edgePp != null && Math.abs(edgePp) >= 2;

  const evModel = {
    name: 'Real EV',
    grossEvPct: grossEv,
    netEvPct,
    fairPct: Math.round(sideFair * 1000) / 10,
    marketPct: Math.round(sidePrice * 1000) / 10,
    edgePp,
    feeBufferPp: feeBuffer,
    score: !realEdge ? Math.min(48, scoreFromEdge(netEvPct || 0)) : scoreFromEdge(netEvPct != null ? netEvPct : 0),
    note:
      matchupModel.confidence === 'low'
        ? 'Fair≈market (no form) — require higher net EV'
        : 'Fair blend: market + matchup',
  };

  // Liq / Fill
  let liqPts = 0;
  if (liq >= 25000) liqPts += 40;
  else if (liq >= 10000) liqPts += 30;
  else if (liq >= 3000) liqPts += 20;
  else if (liq >= 800) liqPts += 10;
  else liqPts += 4;

  let volPts = 0;
  if (vol24 >= 40000) volPts += 30;
  else if (vol24 >= 10000) volPts += 22;
  else if (vol24 >= 3000) volPts += 14;
  else if (vol24 >= 500) volPts += 8;
  else volPts += 3;

  let qual = 20;
  if (liq < 800 && Math.abs(sidePrice - 0.5) > 0.3) qual -= 12;
  if (vol24 > 0 && liq > 2000) qual += 10;
  qual = Math.max(0, Math.min(30, qual));

  const liqVolScore = Math.round(clamp01((liqPts + volPts + qual) / 100) * 100);
  const fillOk = liqVolScore >= 40 && liq >= 800;
  const liqVolModel = {
    name: 'Liq / Fill',
    liquidity: liq,
    volume24: vol24,
    volume: vol,
    score: liqVolScore,
    fillOk,
    label: !fillOk ? 'Thin — hard to fill' : liqVolScore >= 70 ? 'Tradeable' : 'OK size',
  };

  // LM badge only
  let lmBadge = { movePp: null, label: 'LM: n/a', againstPick: false };
  if (priorP != null) {
    const rawMove = Math.round((p - priorP) * 1000) / 10;
    const movePp = side === 'YES' ? rawMove : -rawMove;
    let label = 'LM: flat';
    if (Math.abs(movePp) < 0.5) label = 'LM: flat';
    else if (movePp >= 1) label = 'LM: toward +' + movePp + 'pp';
    else label = 'LM: against ' + movePp + 'pp';
    lmBadge = { movePp, label, againstPick: movePp <= -2, priorPrice: priorP, currentPrice: p };
  }

  // Composite score (no Smart$, no LM in blend)
  let betScore = Math.round(evModel.score * 0.5 + matchupModel.score * 0.25 + liqVolModel.score * 0.25);

  // Higher bar when no form data
  const minGood = matchupModel.confidence === 'low' ? 3.5 : 2.5;
  const minElite = matchupModel.confidence === 'low' ? 5.5 : 4.0;

  let rank = 'Pass';
  const net = netEvPct != null ? netEvPct : -99;
  const matchupBlocks = matchupModel.supportsPick === false;
  const lmBlocks = lmBadge.againstPick;

  if (!fillOk || !realEdge || matchupBlocks || lmBlocks) {
    rank = 'Pass';
    if (matchupBlocks) betScore = Math.min(betScore, 52);
    if (lmBlocks) betScore = Math.min(betScore, 55);
    if (!fillOk) betScore = Math.min(betScore, 50);
  } else if (net >= minElite && betScore >= 72 && (matchupModel.supportsPick !== false)) {
    rank = 'Elite';
  } else if (net >= minGood && betScore >= 58) {
    rank = 'Good';
  } else {
    rank = 'Pass';
  }

  // Cap score if Pass
  if (rank === 'Pass') betScore = Math.min(betScore, 57);

  const confidence = Math.round(
    clamp01(
      0.25 +
        (matchupModel.confidence === 'medium' ? 0.2 : 0.05) +
        (fillOk ? 0.15 : 0) +
        (realEdge ? 0.15 : 0) +
        (liq > 5000 ? 0.1 : 0) +
        Math.min(0.15, Math.abs(edgePp) / 20)
    ) * 100
  );

  return {
    side,
    fairProbability: evModel.fairPct,
    marketPriceCents: evModel.marketPct,
    netEdge: netEvPct,
    grossEdge: grossEv,
    ev: netEvPct,
    confidence,
    rank,
    betScore,
    lmBadge,
    evaluate: {
      realEv: evModel,
      matchup: matchupModel,
      liqVol: liqVolModel,
    },
  };
}

function buildSignal(norm) {
  const ev = evaluateMarket(norm);
  return { ...norm, ...ev, polyUrl: norm.url, taggedAt: new Date().toISOString() };
}
function scoreMarket(norm) {
  return evaluateMarket(norm);
}

module.exports = { evaluateMarket, buildSignal, scoreMarket, calcEV, clamp, matchupScore };
