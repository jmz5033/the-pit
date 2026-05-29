// ─── MARKET HOLIDAYS ─────────────────────────────────────────────────────────
// US market (NYSE/Nasdaq) full-day closures. Keep in sync with the same set in
// public/index.html. Used to defer the weekly close to the last actual trading
// day so a holiday Friday (Juneteenth, Christmas, Good Friday, July 3) doesn't
// snapshot stale prices.
const MARKET_HOLIDAYS = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31',
  '2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
]);

// Monday (YYYY-MM-DD) of the Mon–Fri week containing the given ET date.
function mondayOfWeek(etDateStr) {
  const d = new Date(etDateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

// First trading day (YYYY-MM-DD) of the week containing the given ET date —
// usually Monday, Tuesday on holiday-Monday weeks.
function firstTradingDayOfWeek(etDateStr) {
  const probe = new Date(mondayOfWeek(etDateStr) + 'T12:00:00Z');
  for (let i = 0; i < 5; i++) {
    const ds = probe.toISOString().slice(0, 10);
    const pdow = probe.getUTCDay();
    if (pdow !== 0 && pdow !== 6 && !MARKET_HOLIDAYS.has(ds)) return ds;
    probe.setUTCDate(probe.getUTCDate() + 1);
  }
  return mondayOfWeek(etDateStr);
}

// Given the ET date of any weekday, return the YYYY-MM-DD of the last trading
// day (Mon–Fri, skipping holidays) of that Mon–Fri week.
function lastTradingDayOfWeek(etDateStr) {
  const d = new Date(etDateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const offsetToFriday = 5 - (dow === 0 ? 7 : dow);
  const probe = new Date(d);
  probe.setUTCDate(d.getUTCDate() + offsetToFriday); // this week's Friday
  for (let i = 0; i < 5; i++) {
    const ds = probe.toISOString().slice(0, 10);
    const pdow = probe.getUTCDay();
    if (pdow !== 0 && pdow !== 6 && !MARKET_HOLIDAYS.has(ds)) return ds;
    probe.setUTCDate(probe.getUTCDate() - 1);
  }
  return probe.toISOString().slice(0, 10);
}

// ─── ANTHROPIC RECAP ────────────────────────────────────────────────────────
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

function isSameOrigin(request, url) {
  return request.headers.get('origin') === url.origin;
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

// ─── BASE64URL HELPERS ──────────────────────────────────────────────────────
function uint8ToBase64Url(arr) {
  const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlToUint8(s) {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

// ─── VAPID JWT (ES256) ──────────────────────────────────────────────────────
function normalizeVapidPublicKey(b64url) {
  if (!b64url) return '';
  let raw;
  try { raw = base64UrlToUint8(b64url); } catch { return b64url; }
  if (raw.length === 65 && raw[0] === 0x04) return b64url;
  if (raw.length === 64) {
    const full = new Uint8Array(65);
    full[0] = 0x04;
    full.set(raw, 1);
    return uint8ToBase64Url(full);
  }
  return b64url;
}

async function importVapidPrivateKey(publicKeyB64Url, privateKeyB64Url) {
  let pub = base64UrlToUint8(publicKeyB64Url);
  // Accept either 65-byte uncompressed (0x04 || x || y) or 64-byte raw (x || y)
  if (pub.length === 64) {
    const tmp = new Uint8Array(65);
    tmp[0] = 0x04;
    tmp.set(pub, 1);
    pub = tmp;
  }
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('Invalid VAPID public key (need uncompressed P-256)');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: uint8ToBase64Url(pub.slice(1, 33)),
    y: uint8ToBase64Url(pub.slice(33, 65)),
    d: privateKeyB64Url,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function signVapidJwt(env, audOrigin) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error('VAPID env not configured');
  }
  const header = { alg: 'ES256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12h validity
  const payload = { aud: audOrigin, exp, sub: env.VAPID_SUBJECT };
  const headerB64 = uint8ToBase64Url(enc.encode(JSON.stringify(header)));
  const payloadB64 = uint8ToBase64Url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));
  return `${signingInput}.${uint8ToBase64Url(new Uint8Array(sig))}`;
}

// ─── WEB PUSH PAYLOAD ENCRYPTION (RFC 8291 aes128gcm) ───────────────────────
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const t = new Uint8Array(info.length + 1);
  t.set(info, 0);
  t[info.length] = 0x01;
  const out = new Uint8Array(await crypto.subtle.sign('HMAC', key, t));
  return out.slice(0, length);
}

async function encryptPushPayload(payload, p256dhB64Url, authB64Url) {
  const ua_public = base64UrlToUint8(p256dhB64Url);     // 65 bytes uncompressed
  const auth = base64UrlToUint8(authB64Url);            // 16 bytes
  if (ua_public.length !== 65 || ua_public[0] !== 0x04) throw new Error('Bad p256dh');

  // Generate ephemeral ECDH keypair
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const as_public = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // ECDH shared secret
  const subPub = await crypto.subtle.importKey('raw', ua_public, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: subPub }, ephemeral.privateKey, 256));

  // PRK_key = HKDF-Extract(salt=auth, IKM=ecdh)
  const prkKey = await hkdfExtract(auth, ecdh);

  // key_info = "WebPush: info\0" || ua_public || as_public
  const label = enc.encode('WebPush: info\0');
  const keyInfo = new Uint8Array(label.length + 65 + 65);
  keyInfo.set(label, 0);
  keyInfo.set(ua_public, label.length);
  keyInfo.set(as_public, label.length + 65);

  // IKM = HKDF-Expand(PRK_key, key_info, 32)
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // salt = random 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK = HKDF-Extract(salt, IKM)
  const prk = await hkdfExtract(salt, ikm);

  // CEK / NONCE
  const cek = await hkdfExpand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, enc.encode('Content-Encoding: nonce\0'), 12);

  // Record: payload || 0x02 (final padding delimiter, no padding bytes)
  const payloadBytes = typeof payload === 'string' ? enc.encode(payload) : payload;
  const record = new Uint8Array(payloadBytes.length + 1);
  record.set(payloadBytes, 0);
  record[payloadBytes.length] = 0x02;

  // AES-128-GCM encrypt
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, record));

  // Header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(65 = as_public)
  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer, 16, 4).setUint32(0, recordSize, false);
  header[20] = 65;
  header.set(as_public, 21);

  const out = new Uint8Array(header.length + ct.length);
  out.set(header, 0);
  out.set(ct, header.length);
  return out;
}

async function sendPush(subscription, payloadStr, env) {
  const endpoint = new URL(subscription.endpoint);
  const jwt = await signVapidJwt(env, endpoint.origin);
  const body = await encryptPushPayload(payloadStr, subscription.p256dh, subscription.auth);
  const publicKey = normalizeVapidPublicKey(env.VAPID_PUBLIC_KEY);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${publicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '43200',
    },
    body,
  });
  let detail = '';
  if (!res.ok) {
    try { detail = (await res.text()).slice(0, 200); } catch {}
  }
  return { ok: res.ok, status: res.status, detail };
}

// ─── SUPABASE HELPERS ────────────────────────────────────────────────────────
function sbHeaders(env, extra = {}) {
  return {
    'apikey': env.SB_KEY,
    'Authorization': `Bearer ${env.SB_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sbGet(env, path) {
  const res = await fetch(`${env.SB_URL}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!res.ok) return null;
  return res.json();
}

async function sbInsert(env, table, row, extraPrefer = '') {
  const prefer = ['return=minimal', extraPrefer].filter(Boolean).join(',');
  return fetch(`${env.SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: prefer }),
    body: JSON.stringify(row),
  });
}

async function sbDelete(env, path) {
  return fetch(`${env.SB_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: sbHeaders(env),
  });
}

async function sbPatch(env, path, row) {
  return fetch(`${env.SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
}

// ─── FRIDAY CLOSE: SNAPSHOT + RECAP + PUSH ────────────────────────────────────
function computeScores(rosters, open, live) {
  const scores = {};
  for (const [player, picks] of Object.entries(rosters || {})) {
    if (!picks || picks.length !== MAX_PICKS) { scores[player] = null; continue; }
    let total = 0;
    for (const p of picks) {
      const op = open[p.ticker], lv = live[p.ticker];
      if (op && lv && op > 0) total += (lv - op) * (p.allocation / op);
    }
    scores[player] = total;
  }
  return scores;
}

async function snapshotClosePrices(env, week) {
  if (!env.FH_KEY) throw new Error('FH_KEY not configured');
  const tickers = new Set();
  for (const arr of Object.values(week.rosters || {})) {
    for (const p of (arr || [])) tickers.add(p.ticker);
  }
  const prices = {};
  // Sequential to stay polite to Finnhub's free-tier rate limit
  for (const t of tickers) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${env.FH_KEY}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (d && typeof d.c === 'number' && d.c > 0) prices[t] = d.c;
    } catch {}
  }
  // Fallback: for any ticker Finnhub didn't return a fresh close for, use the
  // last-known live price so the position still contributes to P&L instead of
  // silently zeroing out (which can flip standings — e.g. Seab's RXT -$7,875
  // turning into $0 because Finnhub's quote endpoint missed it at 16:00 ET).
  const liveBackup = week.prices_live || {};
  for (const t of tickers) {
    if (!(t in prices) && typeof liveBackup[t] === 'number' && liveBackup[t] > 0) {
      prices[t] = liveBackup[t];
    }
  }
  return prices;
}

// Persona + angle rotation for the weekly recap. Hashed deterministically off
// week_start so regenerating the same week always lands on the same style, but
// week-to-week the voice and framing rotate so the recap never reads the same.
// Persona affects both the headline and the recap body (consistent voice);
// angle reframes just the recap body.
const RECAP_PERSONAS = [
  'an energetic sports-radio host who loves catchphrases and runs hot',
  'a Bloomberg-terminal finance bro who casually drops jargon and sector calls',
  'an adrenaline-fueled race-car pit commentator giving lap-by-lap urgency',
  'a locker-room smack-talker giving friend-to-friend roast energy',
  'a doom-and-gloom market bear who treats every win as a temporary blip',
  'a hype-machine VC pitch deck where every trend is the next paradigm shift',
  'a deadpan dry-humor narrator in the style of a Wes Anderson voiceover',
  'an old-timey 1920s newsreel announcer with formal antique phrasing',
];

const RECAP_ANGLES = [
  "lead with the winner's single biggest stock gain and build the recap around it",
  "lead with the loser's single worst stock blowup and build the recap around it",
  "frame as a comeback story for whoever was behind mid-week and ended up high",
  "frame as a collapse for whoever led mid-week and faded by Friday",
  "focus on a sector that ruled or wrecked the week and which players rode it",
  "compare the field to a vivid metaphor (race, fight, weather pattern, heist)",
];

function pickStyleForWeek(weekStart) {
  let hash = 0;
  for (let i = 0; i < weekStart.length; i++) hash = (hash * 31 + weekStart.charCodeAt(i)) >>> 0;
  return {
    persona: RECAP_PERSONAS[hash % RECAP_PERSONAS.length],
    angle: RECAP_ANGLES[Math.floor(hash / RECAP_PERSONAS.length) % RECAP_ANGLES.length],
  };
}

async function generateRecapAndHeadline(env, week, scores) {
  const sorted = Object.entries(scores).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) throw new Error('no scored players');
  const rosters = week.rosters || {};
  const open = week.prices_open || {};
  const close = week.prices_close || {};
  const daily = week.prices_daily || {};

  const playerSummaries = sorted.map(([player, totalPnl]) => {
    const picks = rosters[player] || [];
    const tickerPnls = picks.map((pick) => {
      const op = open[pick.ticker], cl = close[pick.ticker];
      const pct = (op && cl && op > 0) ? ((cl - op) / op * 100) : null;
      return { ticker: pick.ticker, pct };
    }).sort((a, b) => (b.pct === null ? -Infinity : b.pct) - (a.pct === null ? -Infinity : a.pct));
    return { player, totalPnl, picks: tickerPnls };
  });

  const dates = Object.keys(daily).sort();
  const dailyArc = dates.map((date) => {
    return sorted.map(([player]) => {
      const picks = rosters[player] || [];
      let dayPnl = 0;
      for (const pick of picks) {
        const op = open[pick.ticker];
        const dp = daily[date]?.[pick.ticker];
        if (op && dp) dayPnl += (dp - op) * (pick.allocation / op);
      }
      return { player, pnl: Math.round(dayPnl) };
    });
  });

  const winner = sorted[0][0];
  const loser = sorted[sorted.length - 1][0];

  const userPrompt = `Week: ${week.week_start}
Winner: ${winner}
Last place: ${loser}

Player results:
${playerSummaries.map((ps) => `${ps.player}: ${fmt(ps.totalPnl)}
  Top picks: ${ps.picks.slice(0,3).map(p => `${p.ticker} (${p.pct!==null?(p.pct>=0?'+':'')+p.pct.toFixed(1)+'%':'?'})`).join(', ')}
  Worst picks: ${ps.picks.slice(-2).map(p => `${p.ticker} (${p.pct!==null?(p.pct>=0?'+':'')+p.pct.toFixed(1)+'%':'?'})`).join(', ')}`).join('\n\n')}

Daily P&L arc:
${dailyArc.map((dayArr, i) => `${dates[i]}: ${dayArr.map(d => `${d.player} ${fmt(d.pnl)}`).join(' vs ')}`).join('\n')}

Write the recap now.`;

  const { persona, angle } = pickStyleForWeek(week.week_start);
  const systemPrompt = `You are ${persona}, writing a weekly recap for a stock-picking game called "The Pit". Players compete each week picking 10 stocks with a $100k virtual budget. Stay fully in this voice for both lines below — vocabulary, rhythm, and attitude.

Output EXACTLY this format, no extra text:

HEADLINE: <one punchy line, max 90 characters, calling out the winner and good-naturedly roasting last place, in your voice>
RECAP: <3-4 sentence vivid recap using stock names and numbers, in your voice. Framing: ${angle}. No bullet points, no HTML, no markdown.>`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ALLOWED_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Anthropic ${response.status}: ${data?.error?.message || 'upstream error'}`);
  }
  const text = data?.content?.find?.((c) => c.type === 'text')?.text || '';
  const headlineMatch = text.match(/HEADLINE:\s*(.+?)(?:\n|$)/i);
  const recapMatch = text.match(/RECAP:\s*([\s\S]+)/i);
  return {
    headline: (headlineMatch ? headlineMatch[1] : '').trim().slice(0, 160),
    recap: (recapMatch ? recapMatch[1] : text).trim(),
  };
}

async function handleFridayClose(env) {
  // Find the live or already-closed week whose week_end is today/recent —
  // the most recent non-draft row.
  const weeks = await sbGet(env, 'sdl_weeks?status=neq.draft&order=week_start.desc&limit=1');
  if (!weeks || !weeks.length) {
    return { skipped: 'no-week', sent: 0, cleaned: 0 };
  }
  const week = weeks[0];

  // 1. Snapshot close prices if we haven't already
  let closePrices = week.prices_close || {};
  let mustPatchClose = false;
  if (Object.keys(closePrices).length === 0) {
    try {
      closePrices = await snapshotClosePrices(env, week);
      mustPatchClose = true;
    } catch {}
  }
  if (mustPatchClose && Object.keys(closePrices).length) {
    await sbPatch(env, `sdl_weeks?id=eq.${week.id}`, { prices_close: closePrices, status: 'closed' }).catch(() => {});
    week.prices_close = closePrices;
    week.status = 'closed';
  }

  // 2. Generate recap + headline if not already cached
  const scores = computeScores(week.rosters || {}, week.prices_open || {}, closePrices);
  let headline = week.recap_headline || '';
  let recapText = week.recap || '';
  if (!recapText || !headline) {
    try {
      const out = await generateRecapAndHeadline(env, week, scores);
      headline = out.headline || headline;
      recapText = out.recap || recapText;
      await sbPatch(env, `sdl_weeks?id=eq.${week.id}`, { recap: recapText, recap_headline: headline }).catch(() => {});
    } catch {
      // No recap — still send the push with a templated body
    }
  }

  // 3. Compose and broadcast push
  const sorted = Object.entries(scores).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0];
  const loser = sorted[sorted.length - 1];

  const titleText = '🏁 The Pit — week wrapped';
  const bodyText = headline
    ? `${headline} · Next draft is open`
    : winner
      ? `🏆 ${winner[0]} ${fmt(winner[1])}${loser && loser !== winner ? ` · 💀 ${loser[0]} ${fmt(loser[1])}` : ''} · Next draft is open`
      : `Recap and next draft are ready in the app.`;

  const subs = await sbGet(env, 'sdl_push_subscriptions?select=*');
  let sent = 0, cleaned = 0;
  const errors = [];
  for (const sub of (subs || [])) {
    const payload = JSON.stringify({
      title: titleText,
      body: bodyText,
      tag: `pit-friday-${week.week_start}`,
      url: '/',
    });
    try {
      const r = await sendPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, env);
      if (r.ok) sent++;
      else if (r.status === 404 || r.status === 410) {
        await sbDelete(env, `sdl_push_subscriptions?id=eq.${sub.id}`).catch(() => {});
        cleaned++;
      } else {
        errors.push(`${sub.player_name}: ${r.status}`);
      }
    } catch (e) {
      errors.push(`${sub.player_name}: ${e.message || e}`);
    }
  }
  return { sent, cleaned, errors };
}

// ─── WEEK KICKOFF (market open) ───────────────────────────────────────────────
async function generateShortPushBody(env, { persona, context, max }) {
  // Single Anthropic call to produce a 1-2 sentence push body in the given
  // persona. Returns null on any failure so callers can fall back to a static
  // line instead of dropping the push.
  if (!env.ANTHROPIC_API_KEY) return null;
  const system = `You are ${persona}, writing a single short push notification body for a stock-picking game called "The Pit" (players pick 10 stocks with a $100k virtual budget).

Output ONLY the body text — 1 to 2 sentences, max ${max} characters, fully in your voice. No quotes around it, no labels, no "BODY:" prefix, no markdown.`;
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
        max_tokens: 150,
        system,
        messages: [{ role: 'user', content: context }],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = (data?.content?.find?.((c) => c.type === 'text')?.text || '').trim();
    if (!text) return null;
    return text.slice(0, max + 20);
  } catch { return null; }
}

async function handleWeekKickoff(env, etDate) {
  // The active week is the one whose week_start is this week's Monday.
  const monday = mondayOfWeek(etDate);
  const weeks = await sbGet(env, `sdl_weeks?week_start=eq.${monday}&select=*`);
  if (!weeks || !weeks.length) return { sent: 0, cleaned: 0, note: 'no week' };
  const week = weeks[0];
  const rosters = week.rosters || {};
  const players = Object.keys(rosters).filter((p) => (rosters[p] || []).length >= MAX_PICKS);
  if (!players.length) return { sent: 0, cleaned: 0, note: 'no rosters' };

  const { persona } = pickStyleForWeek(week.week_start);
  const aiBody = await generateShortPushBody(env, {
    persona,
    context: `Markets just opened for the trading week of ${week.week_start}. ${players.length} portfolios are now live. Scores are zero. Write a single hype push body kicking off the week.`,
    max: 140,
  });
  const title = '🔔 Opening bell!';
  const body = aiBody || (players.length === 1
    ? `Markets are open — your picks are live. Good luck this week. 📈`
    : `Markets are open — ${players.length} portfolios are live. May the best picks win. 📈`);

  return broadcastPush(env, { title, body, tag: `pit-kickoff-${monday}` });
}

async function handleWeekFinalDayKickoff(env, etDate) {
  // Active week (its Monday is this week's Monday). Skip if the week has no
  // submitted rosters.
  const monday = mondayOfWeek(etDate);
  const weeks = await sbGet(env, `sdl_weeks?week_start=eq.${monday}&select=*`);
  if (!weeks || !weeks.length) return { sent: 0, cleaned: 0, note: 'no week' };
  const week = weeks[0];
  const players = Object.keys(week.rosters || {}).filter((p) => (week.rosters[p] || []).length >= MAX_PICKS);
  if (!players.length) return { sent: 0, cleaned: 0, note: 'no rosters' };

  // Mid-week standings from the latest live prices so the persona can
  // reference who's leading / trailing into the final day.
  const scores = computeScores(week.rosters || {}, week.prices_open || {}, week.prices_live || {});
  const sorted = Object.entries(scores).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]);
  const standingsLine = sorted.length
    ? sorted.map(([p, v]) => `${p} ${fmt(v)}`).join(', ')
    : '(no live scores yet)';

  const { persona, angle } = pickStyleForWeek(week.week_start);
  const aiBody = await generateShortPushBody(env, {
    persona,
    context: `It is the morning of the LAST trading day of the week for "The Pit". Markets open now and close at 4 PM ET. Use one of these framings if natural: ${angle}.

Mid-week standings: ${standingsLine}

Write a single push body that builds final-day drama. Reference the standings briefly only if it fits your voice.`,
    max: 140,
  });
  const title = '🔔 Final bell day!';
  const body = aiBody || 'Last day of the market week. Who will shine, who will stumble?';
  return broadcastPush(env, { title, body, tag: `pit-finalday-${monday}` });
}

async function broadcastPush(env, { title, body, tag }) {
  const subs = await sbGet(env, 'sdl_push_subscriptions?select=*');
  let sent = 0, cleaned = 0;
  for (const sub of (subs || [])) {
    const payload = JSON.stringify({ title, body, tag, url: '/' });
    try {
      const r = await sendPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, env);
      if (r.ok) sent++;
      else if (r.status === 404 || r.status === 410) {
        await sbDelete(env, `sdl_push_subscriptions?id=eq.${sub.id}`).catch(() => {});
        cleaned++;
      }
    } catch {}
  }
  return { sent, cleaned };
}

// ─── SCHEDULED REMINDER ──────────────────────────────────────────────────────
async function handleScheduled(env) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const etHour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const etMinute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  const etWeekday = parts.find((p) => p.type === 'weekday').value; // Mon..Sun
  const etDate = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
  const isTradingDay = etWeekday !== 'Sat' && etWeekday !== 'Sun' && !MARKET_HOLIDAYS.has(etDate);
  const firstDay = isTradingDay ? firstTradingDayOfWeek(etDate) : null;
  const lastDay  = isTradingDay ? lastTradingDayOfWeek(etDate)  : null;

  // Kickoff: 9:30 AM ET on the week's first trading day (Mon, or Tue on a
  // holiday-Monday week). The :30 cron schedule makes this tick possible.
  const kickoffTime = etHour === 9 && etMinute === 30 && isTradingDay && etDate === firstDay;
  // Final-day kickoff: 9:30 AM ET on the week's last trading day (Fri, or Thu
  // on a holiday-Friday week). Skipped on weeks where first === last so we
  // don't double-fire on the same morning.
  const finalDayKickoffTime = etHour === 9 && etMinute === 30 && isTradingDay && etDate === lastDay && firstDay !== lastDay;
  // Reminders: 4 PM ET Sat/Sun. Close: 4 PM ET on the week's last trading day.
  const reminderTime = etHour === 16 && etMinute === 0 && (etWeekday === 'Sat' || etWeekday === 'Sun');
  const closeTime = etHour === 16 && etMinute === 0 && isTradingDay && etDate === lastDay;

  if (kickoffTime) {
    try { await handleWeekKickoff(env, etDate); } catch {}
    return;
  }

  if (finalDayKickoffTime) {
    try { await handleWeekFinalDayKickoff(env, etDate); } catch {}
    return;
  }

  // Heartbeat only at 4:00 PM ET — one row per day so a missing entry is a
  // real signal that the cron stopped.
  const shouldHeartbeat = etHour === 16 && etMinute === 0;
  const heartbeat = {
    et_hour: etHour,
    et_weekday: etWeekday,
    fired_action: closeTime ? 'week-close' : reminderTime ? 'send' : 'idle',
    sent_count: 0,
    cleaned_count: 0,
  };

  if (closeTime) {
    let summary = { sent: 0, cleaned: 0 };
    try { summary = await handleFridayClose(env); } catch {}
    await sbInsert(env, 'sdl_push_heartbeats', { ...heartbeat, sent_count: summary.sent || 0, cleaned_count: summary.cleaned || 0 }).catch(() => {});
    return;
  }

  if (!reminderTime) {
    if (shouldHeartbeat) await sbInsert(env, 'sdl_push_heartbeats', heartbeat).catch(() => {});
    return;
  }

  // Find the active draft week (not yet locked / open prices not snapshotted)
  const weeks = await sbGet(env, 'sdl_weeks?status=eq.draft&order=week_start.desc&limit=1');
  if (!weeks || !weeks.length) {
    await sbInsert(env, 'sdl_push_heartbeats', { ...heartbeat, fired_action: 'no-draft-week' }).catch(() => {});
    return;
  }
  const week = weeks[0];
  const rosters = week.rosters || {};

  const subs = await sbGet(env, 'sdl_push_subscriptions?select=*');
  if (!subs || !subs.length) {
    await sbInsert(env, 'sdl_push_heartbeats', { ...heartbeat, fired_action: 'no-subscribers' }).catch(() => {});
    return;
  }

  let sent = 0, cleaned = 0;
  const isLastCall = etWeekday === 'Sun';
  const titleBase = isLastCall ? '⏰ The Pit — 4 hours to lock' : '📝 The Pit — make your picks';

  for (const sub of subs) {
    const player = sub.player_name;
    const picks = rosters[player] || [];
    if (picks.length >= MAX_PICKS) continue; // already submitted

    const payload = JSON.stringify({
      title: titleBase,
      body: isLastCall
        ? `${player}, picks lock at 8 PM ET. Get yours in.`
        : `${player}, draft is open for the week of ${week.week_start}.`,
      tag: `pit-${week.week_start}-${etWeekday}`,
      url: '/',
    });

    try {
      const res = await sendPush({
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
      }, payload, env);
      if (res.ok) {
        sent++;
      } else if (res.status === 404 || res.status === 410) {
        await sbDelete(env, `sdl_push_subscriptions?id=eq.${sub.id}`).catch(() => {});
        cleaned++;
      }
    } catch {
      // swallow — bad subs get pruned via 404/410 in a later run
    }
  }

  await sbInsert(env, 'sdl_push_heartbeats', { ...heartbeat, sent_count: sent, cleaned_count: cleaned }).catch(() => {});
}

// ─── FETCH ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/vapid-public' && request.method === 'GET') {
      return json({ key: normalizeVapidPublicKey(env.VAPID_PUBLIC_KEY) });
    }

    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      if (!isSameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const player_name = cleanStr(body.player, 30);
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      const p256dh = typeof body.p256dh === 'string' ? body.p256dh : '';
      const auth = typeof body.auth === 'string' ? body.auth : '';
      if (!player_name || !endpoint || !p256dh || !auth) return json({ error: 'missing fields' }, 400);
      if (!/^https:\/\//.test(endpoint)) return json({ error: 'bad endpoint' }, 400);
      if (!env.SB_URL || !env.SB_KEY) return json({ error: 'supabase env not configured' }, 500);
      // Upsert by endpoint — resolution=merge-duplicates relies on the unique
      // index on endpoint we added in the migration
      const res = await sbInsert(env, 'sdl_push_subscriptions',
        { player_name, endpoint, p256dh, auth },
        'resolution=merge-duplicates'
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return json({ error: `supabase ${res.status}: ${detail}` }, 500);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/api/vapid-selftest' && request.method === 'GET') {
      // Sign a known message with the configured VAPID keypair, then verify
      // it against the *public* half. If the keys aren't a matched pair, the
      // verify fails and we know to rotate.
      if (request.headers.get('x-admin-key') !== env.PUSH_ADMIN_KEY || !env.PUSH_ADMIN_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      try {
        const pubB64 = normalizeVapidPublicKey(env.VAPID_PUBLIC_KEY);
        const pubRaw = base64UrlToUint8(pubB64);
        const pubJwk = {
          kty: 'EC', crv: 'P-256',
          x: uint8ToBase64Url(pubRaw.slice(1, 33)),
          y: uint8ToBase64Url(pubRaw.slice(33, 65)),
          ext: true,
        };
        const privKey = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
        const pubKey = await crypto.subtle.importKey('jwk', pubJwk,
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const msg = enc.encode('vapid-selftest');
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, msg);
        const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sig, msg);
        return json({
          publicKeyLen: pubRaw.length,
          publicKeyStartsWith04: pubRaw[0] === 0x04,
          privateKeyB64UrlLen: (env.VAPID_PRIVATE_KEY || '').length,
          keypairMatches: verified,
          vapidSubject: env.VAPID_SUBJECT || null,
        });
      } catch (e) {
        return json({ error: `selftest failed: ${e.message || e}` }, 500);
      }
    }

    if (url.pathname === '/api/fh-check' && request.method === 'GET') {
      // Admin-only: confirm FH_KEY env var actually authenticates with
      // Finnhub. Returns the AAPL quote payload (or upstream status) so we
      // can verify the worker can fetch quotes before relying on it at
      // Friday 4 PM ET.
      if (request.headers.get('x-admin-key') !== env.PUSH_ADMIN_KEY || !env.PUSH_ADMIN_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      if (!env.FH_KEY) return json({ error: 'FH_KEY not set' }, 500);
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${env.FH_KEY}`);
        const body = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        return json({ status: r.status, ok: r.ok, body: parsed || body.slice(0, 200), fhKeyLen: env.FH_KEY.length });
      } catch (e) {
        return json({ error: e.message || String(e) }, 500);
      }
    }

    if (url.pathname === '/api/friday-close' && request.method === 'POST') {
      // Admin-only: run the Friday close flow on demand (snapshot close prices,
      // auto-generate recap + headline, broadcast push). Useful for testing.
      if (request.headers.get('x-admin-key') !== env.PUSH_ADMIN_KEY || !env.PUSH_ADMIN_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      try {
        const summary = await handleFridayClose(env);
        return json(summary);
      } catch (e) {
        return json({ error: e.message || String(e) }, 500);
      }
    }

    if (url.pathname === '/api/kickoff' && request.method === 'POST') {
      // Admin-only: fire the week-open kickoff push on demand for testing.
      if (request.headers.get('x-admin-key') !== env.PUSH_ADMIN_KEY || !env.PUSH_ADMIN_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      try {
        const summary = await handleWeekKickoff(env, etDate);
        return json(summary);
      } catch (e) {
        return json({ error: e.message || String(e) }, 500);
      }
    }

    if (url.pathname === '/api/final-day-kickoff' && request.method === 'POST') {
      // Admin-only: fire the final-trading-day morning push on demand.
      if (request.headers.get('x-admin-key') !== env.PUSH_ADMIN_KEY || !env.PUSH_ADMIN_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      try {
        const summary = await handleWeekFinalDayKickoff(env, etDate);
        return json(summary);
      } catch (e) {
        return json({ error: e.message || String(e) }, 500);
      }
    }

    if (url.pathname === '/api/push' && request.method === 'POST') {
      // Admin-only manual push (broadcast or per-player). Useful for sanity-
      // checking delivery without waiting for the cron, and for sending
      // ad-hoc notifications outside the reminder schedule.
      if (request.headers.get('x-admin-key') !== env.PUSH_ADMIN_KEY || !env.PUSH_ADMIN_KEY) {
        return json({ error: 'forbidden' }, 403);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const title = typeof body.title === 'string' && body.title ? body.title.slice(0, 80) : 'The Pit';
      const text = typeof body.body === 'string' ? body.body.slice(0, 200) : '';
      const targetUrl = typeof body.url === 'string' && body.url.startsWith('/') ? body.url : '/';
      const player = typeof body.player === 'string' ? body.player : null;
      const path = player
        ? `sdl_push_subscriptions?player_name=eq.${encodeURIComponent(player)}&select=*`
        : `sdl_push_subscriptions?select=*`;
      const subs = await sbGet(env, path);
      if (!subs || !subs.length) return json({ sent: 0, cleaned: 0, note: 'no subscriptions' });
      let sent = 0, cleaned = 0;
      const errors = [];
      for (const sub of subs) {
        const payload = JSON.stringify({ title, body: text, tag: `pit-manual-${Date.now()}`, url: targetUrl });
        const endpointKind = sub.endpoint.includes('apple.com') ? 'apns'
          : sub.endpoint.includes('fcm.googleapis') || sub.endpoint.includes('android.googleapis') ? 'fcm'
          : sub.endpoint.includes('mozilla') ? 'moz'
          : 'other';
        try {
          const r = await sendPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, env);
          if (r.ok) sent++;
          else if (r.status === 404 || r.status === 410) {
            await sbDelete(env, `sdl_push_subscriptions?id=eq.${sub.id}`).catch(() => {});
            cleaned++;
          } else {
            errors.push(`${sub.player_name}/${endpointKind}: ${r.status} ${r.detail || ''}`.trim());
          }
        } catch (e) {
          errors.push(`${sub.player_name}/${endpointKind}: ${e.message || e}`);
        }
      }
      return json({ sent, cleaned, errors });
    }

    if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
      if (!isSameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      if (typeof body.endpoint !== 'string') return json({ error: 'missing endpoint' }, 400);
      await sbDelete(env, `sdl_push_subscriptions?endpoint=eq.${encodeURIComponent(body.endpoint)}`);
      return json({ ok: true });
    }

    if (url.pathname === '/api/recap' && request.method === 'POST') {
      if (!isSameOrigin(request, url)) return json({ error: 'forbidden' }, 403);

      let raw;
      try { raw = await request.text(); } catch { return json({ error: 'invalid body' }, 400); }
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413);

      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }

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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
