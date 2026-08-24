# The Pit — project notes

## Cloudflare plan

The Cloudflare Workers **Paid plan** is active on this account (covers The Pit
plus any other workers on the same account, e.g. Zeh Household Assistant).
Practical implications when writing worker code:

- Subrequest budget per invocation: **1000** (Free was 50). The Friday
  `handleFridayClose` flow does ~52 Finnhub quote calls + recap + push fan-out
  and runs comfortably under this.
- CPU time per request: **30s** (Free was 10ms). Long-running flows (Claude
  agentic loops, batch operations) are now viable.
- **Durable Objects**, **Queues**, additional cron schedules, R2 are available.

## Stack snapshot

- Worker entry: `worker.js` (Cloudflare Worker, deployed via GitHub Actions →
  `npx wrangler deploy`).
- Static client: `public/index.html` (single file) + `public/sw.js`
  (service worker for web push).
- Database: Supabase project `bykjhwmmfsyqscefehvo` ("The Pit").
- Cron: `[triggers] crons = ["0 * * * *", "30 * * * *"]` in `wrangler.toml`
  (fires :00 and :30 every hour). Handler gates by ET-local hour AND minute
  inside the worker — the :30 tick exists to hit the 9:30 AM ET market open.
  All 4 PM ET logic is guarded with `etMinute === 0` so it doesn't double-fire
  at 16:30.

## Quotes: worker-proxied, Finnhub → Yahoo fallback

All price fetching goes through **`/api/quotes?symbols=A,B,C`** on the worker.
The client no longer calls Finnhub directly for prices.

- **Why proxied**: the client used to fetch Finnhub per-ticker from every
  browser. ~35 tickers × N users refreshing blew past Finnhub's free-tier
  60/min limit at market open, and `getQuotesBatch` swallows errors — so live
  prices silently froze for the rest of the day. The worker caches each ticker
  at the Cloudflare edge for **60s**, so N users share one upstream call.
- **Never cache `c:0`.** Finnhub returns `c:0` for a ticker that hasn't printed
  yet at 9:30. Caching that defeats `snapshotPrices('open')`'s 3-attempt retry
  loop and freezes the ticker at "no open" all week.
- **Yahoo fallback**: Finnhub's free tier doesn't cover every US listing —
  NAVI, BWXT and SEB are all legitimately NYSE/NASDAQ-traded but return empty
  or zero every time. `fetchQuote(env, symbol)` tries Finnhub, then falls
  through to Yahoo's `v8/finance/chart` endpoint, normalizing to Finnhub's
  `{c,o,h,l,pc}` shape. Yahoo 403s without a `User-Agent` header. Responses
  carry `_src: 'finnhub'|'yahoo'` for debugging.
- **Never widen `l`/`h` to fit `o`.** The client carries the day range purely
  to range-check the open (`index.html:1394`), so widening it to bracket a
  suspect open silently disables the stale-open guard — a previous-session
  open then sails straight through. Yahoo's `range=1d` sometimes returns the
  *previous* session's daily bar, so this is a live failure mode, not a
  theoretical one. If the open isn't inside today's range, refetch the
  1-minute series; if that fails too, emit **no** open rather than a wrong
  cost basis.
- **Finnhub circuit breaker**: the free tier is 60 req/min and one refresh
  covers ~66 tickers, so under real usage nearly every call returns 429 and
  falls through to Yahoo anyway — burning a subrequest and a round-trip per
  ticker. On seeing a 429, `markFinnhubRateLimited()` records it at the edge
  for **5 min** and `fetchQuote` skips straight to Yahoo until it lapses.
  Pass a shared `newQuoteBatchState()` when fetching more than one symbol so
  one 429 spares the rest of the batch. The Cache API is per-colo, so each
  location learns independently. `/api/fh-check` reports `finnhubBreakerOpen`
  but its raw `finnhub` probe deliberately bypasses the breaker.
- `fetchQuote` is used by **both** `/api/quotes` and `snapshotClosePrices`,
  so the Friday close gets the same coverage as live prices.
- `/api/open-sweep` also routes through `fetchQuote` and accepts
  `?symbols=A,B` to repair specific tickers without walking the whole roster
  (it sleeps 1.1s per ticker for Finnhub's rate limit).
- The draft dropdown's `isQuotable` check also routes through `/api/quotes` —
  checking Finnhub directly would hide exactly the tickers that then register
  no P&L all week.

## Draftability guard

`isQuotable` is enforced inside **`addPick`**, not at the call sites. Every
entry path (dropdown selection, typed ticker via `addBySearch`, seed
suggestion via `addFromSeed`) funnels through it, so a new caller can't
bypass the rule. `addPick` is `async` and returns `true` only if the pick was
added — callers must `await` it.

The rule is `c >= MIN_PICK_PRICE` ($1.00) **and** not an OTC/pink venue
(`_exch` from Yahoo's `fullExchangeName`). A bare `c > 0` existence test is
not sufficient: SECI (Sector 10, Inc.) trades OTC at ~$0.0001 with a ~$30
market cap and returns a perfectly valid non-zero quote, so it passed the
old check and then contributed nothing all week. At that price an allocation
buys tens of millions of shares and one $0.0001 tick swings P&L 100%.
- **`/api/fh-check?symbols=A,B,C`** is an open (no-auth) diagnostic that
  bypasses the cache and returns Finnhub's raw response, Yahoo's raw response,
  and the `resolved` quote for each symbol. No auth because it must work from
  a pasted address-bar URL (which sends no `Origin`/`Referer`), and it only
  returns public quote data.

## Worker secrets currently expected

| Secret | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `/api/recap`, Friday auto-recap |
| `SB_URL`, `SB_KEY` | All Supabase reads/writes from worker |
| `FH_KEY` | `snapshotClosePrices` Finnhub quotes |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push |
| `PUSH_ADMIN_KEY` | `/api/push`, `/api/friday-close`, `/api/vapid-selftest` |

## Push schedule

- **First trading day 9:30 AM ET** (Mon, or Tue on a holiday-Monday week):
  "Opening bell" kickoff broadcast to all subscribers (`handleWeekKickoff`).
- **Last trading day 9:30 AM ET** (Fri, or Thu on a holiday-Friday week):
  "Final bell day" broadcast (`handleWeekFinalDayKickoff`). Skipped on weeks
  where first === last so it doesn't double-fire alongside the opening kickoff.
- **Sat 4 PM ET** and **Sun 4 PM ET**: reminder push to players who haven't
  submitted yet for the upcoming draft week.
- **Sun 8 PM ET**: draft-lock summary broadcast (`handleDraftLockSummary`) —
  AI-generated themes/consensus across the now-locked rosters for the
  upcoming week.
- **Last trading day 4 PM ET** (usually Fri, Thu on holiday-Friday weeks):
  close-of-week broadcast — worker snapshots `prices_close` from Finnhub,
  calls Anthropic for a recap + one-line headline (both cached on `sdl_weeks`),
  then broadcasts a push with the headline.
- Heartbeat row written to `sdl_push_heartbeats` once per day at 16 ET only
  (not every hour) — one missing row = cron is broken.

## Market-holiday handling

`MARKET_HOLIDAYS` is duplicated in both `worker.js` and `public/index.html`
(keep them in sync; extend per year). Effects:

- **Open snapshot** (`public/index.html` `getOpenSnapshotTime` →
  `firstTradingDay`): bases each week's cost basis on the first actual trading
  day at 9:30 ET, so a holiday Monday (e.g. Memorial Day) snapshots Tuesday.
- **Close** (`worker.js` `handleScheduled` → `lastTradingDayOfWeek`): fires the
  close-of-week flow at 4 PM ET on the week's last trading day, so a holiday
  Friday (Juneteenth, Christmas, Good Friday, July 3) closes Thursday instead
  of snapshotting stale prices on a closed Friday.
- Defensive fallback: `snapshotClosePrices` fills any ticker Finnhub doesn't
  return with the last-known `prices_live` value (avoids a missing close quote
  silently zeroing a position's P&L and flipping standings).

## Git workflow

Direct push to `main` (deploys via GitHub Actions). Feature branch
`claude/setup-cloudflare-worker-XGbPH` is mirrored for history.
