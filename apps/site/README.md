# @pierre-review/site

The one small Node service behind pierre-review.com. Plain `node:http`, no runtime
dependencies. Limn itself is local-only (`npx limn-review`), so this serves the website and
nothing else:

| Path | What |
|---|---|
| `/` and every landing route | the prerendered landing (`apps/landing/dist`); unknown paths get `404.html` with a 404 |
| `/demo/` | the static demo build (an SPA: paths without a file extension fall back to its `index.html`). With no build present, a short "coming soon" page. `/demo` → 301 `/demo/` |
| `/api/health` | `{ "ok": true }` — Railway's health check |
| `GET /api/contact/ticket` · `POST /api/contact` | the contact form, delivered to a Slack incoming webhook |

## The contact form

Ported from the old backend route with the same env var names and wire shapes. Three spam
layers, no third party: a honeypot field (answered 200 and dropped), a server-signed
minimum fill time (`GET /api/contact/ticket` mints `<ms>.<hmac>`; the POST needs it to be
3 s to 6 h old), and a rate limit of 5 an hour per IP shared by the mint and the submit.
With no webhook configured the ticket route 503s, so the form says it is unavailable
before anyone writes a message. A failed delivery is logged in full (the message exists
nowhere else) and answered 502.

⚠ **The rate limit reads `X-Forwarded-For` from the RIGHT**, `TRUST_PROXY_HOPS` entries in.
The leftmost entry is written by the client, so trusting it lets a bot rotate past the limit.
The image sets `TRUST_PROXY_HOPS=1` for Railway's edge; locally it is 0 and the header is
ignored.

## Headers

`src/security.ts`: a strict CSP per surface (landing, demo, API), HSTS (`HSTS_MAX_AGE`), the
www → apex 301 (`SITE_URL`), nosniff, frame denial, a referrer policy, a permissions policy
and COOP. Hashed assets under `/assets/` and `/demo/assets/` are cached for a year; HTML is
`no-cache`; text is sent brotli/gzip; byte ranges are honoured so the walkthrough video can
seek.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4300 | listen port (Railway injects it) |
| `HOST` | 0.0.0.0 | bind address |
| `LANDING_DIR` | `../landing/dist` | the built landing |
| `DEMO_DIR` | `../frontend/dist-demo` | the built demo |
| `CONTACT_SLACK_WEBHOOK_URL` | — | where contact messages go; unset = form unavailable |
| `CONTACT_TICKET_SECRET` | `SESSION_SECRET`, else random | signs the fill-time ticket |
| `SITE_URL` | `APP_BASE_URL`, else none | canonical origin for the www redirect |
| `HSTS_MAX_AGE` | 31536000 | seconds; 0 disables |
| `TRUST_PROXY_HOPS` | 0 | proxies that append to `X-Forwarded-For` |

## Commands

```sh
pnpm --filter @pierre-review/landing build   # the pages it serves
pnpm --filter @pierre-review/site dev        # tsx watch, on :4300
pnpm --filter @pierre-review/site test       # vitest
pnpm --filter @pierre-review/site build      # → dist/, run with `node dist/server.js`
```

Deployed by `.github/workflows/deploy-site.yml` from the root `Dockerfile`.
