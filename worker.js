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
  return { ok: res.ok, status: res.status };
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

// ─── SCHEDULED REMINDER ──────────────────────────────────────────────────────
async function handleScheduled(env) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);
  const etHour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const etWeekday = parts.find((p) => p.type === 'weekday').value; // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const reminderTime = etHour === 16 && (etWeekday === 'Sat' || etWeekday === 'Sun');

  // Heartbeat row so we can see the cron firing in Supabase even when no push is sent
  const heartbeat = {
    et_hour: etHour,
    et_weekday: etWeekday,
    fired_action: reminderTime ? 'send' : 'skip',
    sent_count: 0,
    cleaned_count: 0,
  };

  if (!reminderTime) {
    await sbInsert(env, 'sdl_push_heartbeats', heartbeat).catch(() => {});
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
            errors.push(`${sub.player_name}/${endpointKind}: ${r.status}`);
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
