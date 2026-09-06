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

## Draft suggestion tabs

The draft pane's chip grid has five tabs (`seedTab`, rendered in
`renderDraftPane`). Four are computed client-side from `LEAGUE_HISTORY` —
every week's `rosters`/`prices_open`/`prices_close`, fetched **once** at app
load inside `seedPlayerColorOrder` (which already made that call for player
colours, so this added no round trip; `prices_daily` is deliberately not
selected as it dwarfs the rest).

| Tab | Source | Ranked by |
|---|---|---|
| Your bench | your own past picks | times drafted, then recency |
| The field | everyone else's picks | distinct owners, then total |
| Follow | static `FOLLOW_PORTFOLIOS` | as listed |
| Themes | static `THEMES` | as listed |
| Earnings | `/api/earnings` (lazy) | date, then symbol |
| Winners | open→close per week | best average week |
| Random | static `SEED_POOL` | shuffled |

*Follow* and *Themes* both use a second-level `follow-pill` row, shared via
`subPicker(tab)` / `activeSubItem(tab)` — add a third basket tab by extending
`subPicker` rather than by copying the render branch. The blurb line becomes
the selected basket's tagline.

Both lists are **hand-maintained and approximate**, and that's deliberate. For
Follow, 13F filings are quarterly and land ~45 days after quarter close, so
even an API-driven version would be months stale — all the wiring, none of the
freshness. For Themes there's no clean data source at all short of a paid
classification feed. Refresh either list by hand when it starts feeling dated.
The persona (or the vibe) is the feature, not the precision.

Why these: across 21 weeks ~4 of every 10 picks are a name that player has
drafted before, but only ~1.7 carry over from the immediately previous week —
people rotate a personal bench rather than re-running a roster. So *Your
bench* is ranked by frequency, and a "repeat last week" button was
deliberately **not** built. First-time players have an empty bench, so
`_seedTabInit` opens them on *The field* once, then respects their choice.

- **Earnings is intentionally unfiltered** — it's a prompt for ideas, not a
  portfolio suggestion, so slim or obscure weeks are fine. The worker only
  dedupes (Finnhub returns one row per fiscal period, so a symbol can appear
  twice for one date — keep the row with real estimates) and drops symbols
  outside `^[A-Z0-9.\-]{1,10}$` before they become DOM labels.
- `bmo`/`amc` is shown as "open"/"close". It matters: an `amc` print on the
  week's last day settles *after* the 4 PM close snapshot, so it cannot move
  that week's score.
- **Chips use `data-seed-ticker` + a delegated listener**, never an inline
  `onclick`. The old markup interpolated the ticker straight into the handler,
  which was safe for a hardcoded pool but is an injection hole once symbols
  arrive from Finnhub's calendar.
- Pools are historical, so they can surface a name that has since delisted or
  fallen under $1. `addPick`'s guard rejects those on tap with an explanation
  rather than the pools pre-screening (which would cost a quote per chip).

## My Stats tab

A per-player report card (`renderStats`), computed entirely from
`LEAGUE_HISTORY` — **no network calls of its own**. `weekPortfolios(w)` reduces
one closed week to per-player portfolio maths; `computePlayerStats(player)`
aggregates across weeks. Incomplete rosters (`length !== MAX_PICKS`) and weeks
that never closed are skipped so they can't skew averages.

The two metrics that carry the value:

- **Edge vs the field** — your weighted weekly return minus the mean of every
  player's that week. The field is the right benchmark because it removes the
  week's market direction: −2% when everyone lost 4% was a good week, and a raw
  return can't show that.
- **Conviction edge** — weighted return minus the equal-weight return of the
  *same ten names*. Isolates whether position sizing added or destroyed value,
  independent of stock selection.

Other sections: hit rate, green weeks, beat-the-field record, sector table
(min 4 picks, so one lucky pick can't masquerade as a sector edge), best/worst
individual picks, and repeat tickers split into "keeps working" / "keeps not
working" (drafted 3+ times, signed average). The offenders table is the most
behaviour-changing number on the page — Justin has drafted FLNC nine times at
a −7.6% average.

The footer states the sample size and that a five-day horizon is mostly market
movement. Keep it: players asked for this to inform real investing, hit rates
sit at 38–53% (near coin-flip), and a 2-week player shows a flattering alpha
off almost no data.

**Gotcha:** `showWeekResultsPopup` has a *local* `const fmt`, not a global.
Stats uses its own top-level `fmtMoney` — calling `fmt` from `renderStats`
throws at runtime and silently blanks the tab, which a syntax check won't
catch.

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
- **Sat 4 PM ET**, **Sun 4 PM ET**, and **4 PM ET on lock eve** if that isn't
  Sunday: reminder push to players who haven't submitted yet. `isLastCall`
  (the "4 hours to lock" wording) is tied to lock eve, not to Sunday — on a
  holiday-Monday week the Sunday reminder is ~28 hours out.
- **8 PM ET on lock eve** (Sunday normally, Monday on a holiday-Monday week):
  draft-lock summary broadcast (`handleDraftLockSummary`) — AI-generated
  themes/consensus across the now-locked rosters. It derives the week as
  `mondayOfWeek(addDaysET(etDate, 1))`, **not** `etDate + 1`: on a Monday-night
  lock, tomorrow is Tuesday but `week_start` is the Monday just gone.
- **Last trading day 4 PM ET** (usually Fri, Thu on holiday-Friday weeks):
  close-of-week broadcast — worker snapshots `prices_close` from Finnhub,
  calls Anthropic for a recap + one-line headline (both cached on `sdl_weeks`),
  then broadcasts a push with the headline.
- Heartbeat row written to `sdl_push_heartbeats` once per day at 16 ET only
  (not every hour) — one missing row = cron is broken.

## Market-holiday handling

`MARKET_HOLIDAYS` is duplicated in both `worker.js` and `public/index.html`
(keep them in sync; extend per year). Effects:

- **Draft lock** (`public/index.html` `getLockTime` → `firstTradingDay`, and
  `worker.js` `isLockEve`): 8 PM ET the evening **before the first trading
  day** — Sunday normally, Monday on a holiday-Monday week. Locking Sunday on
  those weeks froze picks ~37 hours before the cost basis was taken, costing
  players a day of thinking time while the market was shut. Every lock is now
  ~13.6h ahead of the 9:35 open snapshot regardless of holidays. Client and
  worker derive this independently, so **keep them in sync**.
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
