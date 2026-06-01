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
