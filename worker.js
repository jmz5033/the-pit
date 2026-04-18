const ALLOWED_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 300;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PLAYERS = 10;
const MAX_PICKS = 10;
const MAX_DAYS = 14;

const SYSTEM_PROMPT = `You are a sports commentator writing a short, punchy weekly recap for a stock-picking game called "The Pit". Two friends compete each week picking 10 stocks with a $100k virtual budget. Write 3-4 sentences max. Be vivid, use the actual stock names and numbers, capture the drama and momentum swings. Sound like you're recapping a game, not writing a finance report. Use casual language. Don't use bullet points. Output plain text only — no HTML tags, no markdown.`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[^\w\s\-.,+%()$'&]/g, '').slice(0, max);
}

function cleanNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt(n) {
  return (n >= 0 ? '+$' : '-$') + Math.abs(Math.round(n)).toLocaleString('en-US');
}

function buildPrompt(body) {
  if (!body || typeof body !== 'object') return null;
  const weekStart = cleanStr(body.weekStart, 12);
  const winner = cleanStr(body.winner, 20);
  if (!weekStart) return null;

  const summaries = Array.isArray(body.playerSummaries)
    ? body.playerSummaries.slice(0, MAX_PLAYERS).map((ps) => {
        const player = cleanStr(ps?.player, 20);
        const totalPnl = cleanNum(ps?.totalPnl);
        const picks = Array.isArray(ps?.picks) ? ps.picks.slice(0, MAX_PICKS) : [];
        const fmtPick = (p) => {
          const ticker = cleanStr(p?.ticker, 10);
          const pct = typeof p?.pct === 'number' && Number.isFinite(p.pct) ? p.pct : null;
          const pctStr = pct !== null ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : '?';
          return `${ticker} (${pctStr})`;
        };
        const top = picks.slice(0, 3).map(fmtPick).join(', ');
        const bot = picks.slice(-2).map(fmtPick).join(', ');
        return `${player}: ${fmt(totalPnl)}\n  Top picks: ${top}\n  Worst picks: ${bot}`;
      }).join('\n\n')
    : '';

  const dates = Array.isArray(body.dates) ? body.dates.slice(0, MAX_DAYS).map((d) => cleanStr(d, 12)) : [];
  const arc = Array.isArray(body.dailyArc)
    ? body.dailyArc.slice(0, MAX_DAYS).map((dayArr, i) => {
        const items = Array.isArray(dayArr)
          ? dayArr.slice(0, MAX_PLAYERS).map((d) => `${cleanStr(d?.player, 20)} ${fmt(cleanNum(d?.pnl))}`).join(' vs ')
          : '';
        return `${dates[i] || ''}: ${items}`;
      }).join('\n')
    : '';

  return `Week: ${weekStart}
Winner: ${winner}

Player results:
${summaries}

Daily P&L arc (who was leading each day):
${arc}

Write the recap now:`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/recap' && request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin !== url.origin) {
        return json({ error: 'forbidden' }, 403);
      }

      let raw;
      try {
        raw = await request.text();
      } catch {
        return json({ error: 'invalid body' }, 400);
      }
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413);

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: 'invalid json' }, 400);
      }

      const prompt = buildPrompt(body);
      if (!prompt) return json({ error: 'invalid payload' }, 400);

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: ALLOWED_MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          const upstream = data?.error?.message || data?.error?.type || `status ${response.status}`;
          return json({ error: `upstream: ${upstream}` }, 502);
        }
        const text = data?.content?.find?.((c) => c.type === 'text')?.text || '';
        return json({ text });
      } catch (e) {
        return json({ error: `fetch failed: ${e.message}` }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
