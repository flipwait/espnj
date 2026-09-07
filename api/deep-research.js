module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }
  body = body || {};
  const apiKey = process.env.OPENAI_API_KEY || body.apiKey || '';
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: 'Add OPENAI_API_KEY on Vercel or paste key in Settings',
    });
  }

  const ctx = body.context || {};
  const model = body.model || 'gpt-4o';

  const system = `You are an elite professional sports bettor and trading analyst writing for another sharp bettor.
Tone: concise, specific, skeptical, no hype, no generic filler ("both teams want to win").
Never invent precise stats you do not know — label unknowns as UNKNOWN and explain what would change the bet.
Structure with short headers. End with a clear TAKE / PASS / WAIT and why.
Focus on: edge quality, price vs fair, matchup/form, rest if relevant, lineup risk, liquidity/fill, and what would kill the bet.`;

  const user = `Write a deep research note on this Polymarket US market.

MARKET / CARD DATA:
${JSON.stringify(ctx, null, 2)}

Required sections:
1) Market snapshot — price, implied %, model fair/net EV if present, rank
2) Teams & setup — home/away, sport, live or pregame, score/period if live
3) Form & matchup — use any L10/H2H/scoring in context; if missing say what to check
4) Lineups / availability — starters, injuries, projected roles; mark UNKNOWN if not in data and list what to verify
5) Hidden risks — 2–4 non-obvious ways this bet fails (price trap, live state, bullpen, public side, etc.)
6) What would make this Elite vs Pass
7) Verdict — TAKE / PASS / WAIT with one-sentence thesis

Keep under ~450 words. Professional desk note, not a blog.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 1100,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: (data.error && data.error.message) || 'OpenAI error',
      });
    }
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return res.status(200).json({ ok: true, content: content || '', model });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
