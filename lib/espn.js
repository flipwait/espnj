/**
 * ESPN public site API — form helpers (no key)
 * L10 home / L10 away / simple H2H from schedules
 */

const SPORT_PATH = {
  mlb: 'baseball/mlb',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  nfl: 'football/nfl',
  cfb: 'football/college-football',
  cbb: 'basketball/mens-college-basketball',
  nhl: 'hockey/nhl',
};

const teamCache = globalThis.__espnTeams || (globalThis.__espnTeams = {});
const schedCache = globalThis.__espnSched || (globalThis.__espnSched = {});

function pathFor(league) {
  return SPORT_PATH[String(league || '').toLowerCase()] || null;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('ESPN ' + r.status);
  return r.json();
}

async function listTeams(league) {
  const key = String(league || '').toLowerCase();
  if (teamCache[key] && Date.now() - teamCache[key].t < 6 * 3600 * 1000) return teamCache[key].teams;
  const sp = pathFor(key);
  if (!sp) return [];
  const d = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams?limit=400');
  const leaguesArr = (((d.sports || [])[0] || {}).leagues) || [];
  const teams = (leaguesArr[0] && leaguesArr[0].teams) || [];
  const out = teams.map((x) => x.team || x).filter(Boolean);
  teamCache[key] = { t: Date.now(), teams: out };
  return out;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|at|vs|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamMatch(team, query) {
  const q = norm(query);
  if (!q || !team) return false;
  const names = [team.displayName, team.shortDisplayName, team.name, team.nickname, team.abbreviation, team.location]
    .map(norm)
    .filter(Boolean);
  return names.some((n) => n === q || n.includes(q) || q.includes(n));
}

async function findTeam(league, nameHint) {
  const teams = await listTeams(league);
  const hit = teams.find((t) => teamMatch(t, nameHint));
  return hit || null;
}

function parseEventResult(ev, teamId) {
  const c = (ev.competitions || [])[0] || {};
  const comps = c.competitors || [];
  if (comps.length < 2) return null;
  const me = comps.find((x) => String(x.team && x.team.id) === String(teamId));
  const opp = comps.find((x) => String(x.team && x.team.id) !== String(teamId));
  if (!me) return null;
  const status = (c.status && c.status.type && c.status.type.completed) || (ev.status && ev.status.type && ev.status.type.completed);
  // also accept when scores present and not future
  function scoreNum(sc) {
    if (sc == null || sc === '') return null;
    if (typeof sc === 'object') {
      if (sc.value != null) return Number(sc.value);
      if (sc.displayValue != null) return Number(sc.displayValue);
      return null;
    }
    return Number(sc);
  }
  const ms = scoreNum(me.score);
  const os = opp ? scoreNum(opp.score) : null;
  if (ms == null || os == null || isNaN(ms) || isNaN(os)) return null;
  const homeAway = me.homeAway || 'home';
  const won = me.winner === true || ms > os;
  return {
    id: ev.id,
    date: ev.date,
    homeAway,
    for: ms,
    against: os,
    won,
    oppId: opp && opp.team && opp.team.id,
    oppName: opp && opp.team && (opp.team.shortDisplayName || opp.team.displayName),
  };
}

async function teamSchedule(league, teamId) {
  const key = league + ':' + teamId;
  if (schedCache[key] && Date.now() - schedCache[key].t < 30 * 60 * 1000) return schedCache[key].events;
  const sp = pathFor(league);
  if (!sp || !teamId) return [];
  const d = await fetchJson(
    'https://site.api.espn.com/apis/site/v2/sports/' + sp + '/teams/' + encodeURIComponent(teamId) + '/schedule'
  );
  const events = d.events || [];
  schedCache[key] = { t: Date.now(), events };
  return events;
}

function last10Split(results) {
  const completed = results.filter(Boolean);
  const home = completed.filter((r) => r.homeAway === 'home').slice(-10);
  const away = completed.filter((r) => r.homeAway === 'away').slice(-10);
  function pack(arr) {
    if (!arr.length) return null;
    const w = arr.filter((x) => x.won).length;
    const l = arr.length - w;
    const rf = Math.round((arr.reduce((s, x) => s + x.for, 0) / arr.length) * 10) / 10;
    const ra = Math.round((arr.reduce((s, x) => s + x.against, 0) / arr.length) * 10) / 10;
    return { w, l, rf, ra, n: arr.length };
  }
  return { homeL10: pack(home), awayL10: pack(away), all: completed.slice(-20) };
}

function h2hFromResults(homeResults, awayTeamId) {
  const vs = (homeResults || []).filter((r) => String(r.oppId) === String(awayTeamId)).slice(-10);
  if (!vs.length) return null;
  const homeWins = vs.filter((r) => r.won).length;
  const awayWins = vs.length - homeWins;
  const avgTotal =
    Math.round((vs.reduce((s, r) => s + r.for + r.against, 0) / vs.length) * 10) / 10;
  return { homeWins, awayWins, n: vs.length, avgTotal };
}

/**
 * Build matchup object for score.js from event title "A vs B" or "A at B"
 */
async function matchupForEvent(league, eventTitle) {
  const sp = pathFor(league);
  if (!sp || !eventTitle) return null;
  let homeHint = null;
  let awayHint = null;
  const at = String(eventTitle).split(/\s+at\s+/i);
  const vs = String(eventTitle).split(/\s+vs\.?\s+/i);
  if (at.length === 2) {
    awayHint = at[0].trim();
    homeHint = at[1].trim();
  } else if (vs.length === 2) {
    homeHint = vs[0].trim();
    awayHint = vs[1].trim();
  } else return null;

  try {
    const [homeTeam, awayTeam] = await Promise.all([
      findTeam(league, homeHint),
      findTeam(league, awayHint),
    ]);
    if (!homeTeam || !awayTeam) {
      return {
        homeName: homeHint,
        awayName: awayHint,
        note: 'ESPN team id not matched',
      };
    }
    const [homeEv, awayEv] = await Promise.all([
      teamSchedule(league, homeTeam.id),
      teamSchedule(league, awayTeam.id),
    ]);
    const homeRes = homeEv.map((e) => parseEventResult(e, homeTeam.id)).filter(Boolean);
    const awayRes = awayEv.map((e) => parseEventResult(e, awayTeam.id)).filter(Boolean);
    const homeSplit = last10Split(homeRes);
    const awaySplit = last10Split(awayRes);
    const h2h = h2hFromResults(homeRes, awayTeam.id);

    return {
      homeName: homeTeam.displayName || homeHint,
      awayName: awayTeam.displayName || awayHint,
      homeL10: homeSplit.homeL10,
      awayL10: awaySplit.awayL10,
      // for matchup score: home team's home form + away team's away form
      h2h,
      source: 'espn',
    };
  } catch (e) {
    return { error: e.message, homeName: homeHint, awayName: awayHint };
  }
}

module.exports = {
  matchupForEvent,
  findTeam,
  listTeams,
  pathFor,
  SPORT_PATH,
};
