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
- Cron: hourly via `[triggers] crons = ["0 * * * *"]` in `wrangler.toml`.
  Handler is gated by ET-local time inside the worker.

## Worker secrets currently expected

| Secret | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `/api/recap`, Friday auto-recap |
| `SB_URL`, `SB_KEY` | All Supabase reads/writes from worker |
| `FH_KEY` | `snapshotClosePrices` Finnhub quotes |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push |
| `PUSH_ADMIN_KEY` | `/api/push`, `/api/friday-close`, `/api/vapid-selftest` |

## Push schedule

- **Sat 4 PM ET** and **Sun 4 PM ET**: reminder push to players who haven't
  submitted yet for the upcoming draft week.
- **Fri 4 PM ET**: close-of-week broadcast — worker snapshots `prices_close`
  from Finnhub, calls Anthropic for a recap + one-line headline (both cached
  on `sdl_weeks`), then broadcasts a push with the headline.
- Heartbeat row written to `sdl_push_heartbeats` once per day at 16 ET only
  (not every hour) — one missing row = cron is broken.

## Git workflow

Direct push to `main` (deploys via GitHub Actions). Feature branch
`claude/setup-cloudflare-worker-XGbPH` is mirrored for history.
