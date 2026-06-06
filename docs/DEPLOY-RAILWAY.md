# Deploying pierre-review to Railway (cloud, multi-tenant)

This deploys the **public, multi-tenant** build: a dark landing page at `/`,
GitHub-App sign-in, per-user accounts, and Postgres. Local mode (SQLite +
`gh auth token` + `npx pierre-review`) is unaffected and needs none of this.

> Prerequisite: create the GitHub App first — see
> [GITHUB-APP-SETUP.md](./GITHUB-APP-SETUP.md).

---

## Architecture on Railway

A single Railway **service** (the app, from this repo's `Dockerfile`) + the
**Railway Postgres plugin**. The one Fastify process serves both the JSON API
(`/api/*`), the landing page (`/`), and the timeline SPA (`/app`). It binds
`0.0.0.0:$PORT` (Railway injects `PORT`). Migrations run automatically at boot
(the Postgres migrator).

```
 Browser ─▶ Railway service (Dockerfile)
              ├─ /            landing page (public)
              ├─ /app         timeline SPA (behind GitHub sign-in)
              ├─ /api/auth/*  OAuth login/callback/logout
              └─ /api/*       JSON API (session-gated)
                     │
                     ▼
              Railway Postgres plugin  ($DATABASE_URL)
```

---

## Step 1 — Create the project + Postgres

1. In Railway, **New Project → Deploy from GitHub repo** and pick this repo.
   (Or `railway init` with the CLI.)
2. **Add a plugin → PostgreSQL.** Railway provisions it and exposes a
   `DATABASE_URL` reference variable.
3. In the **app service → Variables**, add a reference so the app sees it:
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.

## Step 2 — Set environment variables

On the **app service → Variables**:

| Var | Value | Notes |
|---|---|---|
| `DEPLOYMENT_MODE` | `cloud` | the master switch (Postgres + landing + OAuth) |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | from the Postgres plugin |
| `APP_BASE_URL` | `https://pierre-review.com` | no trailing slash; the canonical origin — OAuth redirect, CORS, and the session cookie all derive from it |
| `GITHUB_APP_CLIENT_ID` | from the GitHub App | |
| `GITHUB_APP_CLIENT_SECRET` | from the GitHub App | |
| `GITHUB_APP_SLUG` | the app slug | for the install link |
| `SESSION_SECRET` | `openssl rand -hex 32` | seals the session cookie |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | **must be 64 hex chars (32 bytes)** — AES-256-GCM key for stored tokens |
| `PORT` | (Railway sets this) | the app reads it; `HOST` defaults to `0.0.0.0` in cloud |

Generate the two secrets locally:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY  (exactly 64 hex chars)
```

> The app **fails loud at startup** if any required cloud var is missing or if
> `ENCRYPTION_KEY` isn't 32 bytes (see `assertCloudConfig` in `config.ts`).

## Step 3 — Build & deploy

This repo ships a root **`Dockerfile`** and **`railway.json`**. Railway will:

1. Build the image (installs deps, builds the SPA with `base:'/app/'`, the
   landing page, and the backend, then assembles `public/` + `public-landing/`
   next to `dist/`).
2. Start the server with `DEPLOYMENT_MODE=cloud`.
3. Health-check `GET /api/health` (configured in `railway.json`).

Migrations (the Postgres baseline in `dist/db/migrations-pg`) run at boot.

### Watch Paths (skip doc-only deploys)

By default every push to `main` redeploys. To skip pushes that touch **only** docs/
CI/markdown, set **service → Settings → Build → Watch Paths**. They're gitignore-
style globs (one per line, anchored at the repo root `/`); a push deploys only if a
changed file matches, and `!` negations only work **after** a positive include.

The image is built from the whole repo (`Dockerfile` does `COPY . .`), so "code" is
everything except docs/CI/markdown — use the denylist form:

```
/**
!/docs/**
!**/*.md
!/.github/**
!/.claude/**
!/docker-compose.yml
```

Note that `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
`Dockerfile`, and `railway.json` **are** build inputs — changes there correctly
redeploy. Watch Paths gate **GitHub auto-deploys only**; a manual **Redeploy** always
works, so a skipped commit is never stuck. (Stricter alternative: an allowlist of
`/apps/**`, `/packages/**`, and those root build files.)

## Step 4 — Custom domain (`pierre-review.com`)

`pierre-review.com` was registered **through Railway**, so Railway manages its DNS
automatically — there's no external registrar or manual `CNAME` step.

1. **Attach it to the service.** Railway **service → Settings → Networking →
   Domains → Custom Domain** → add **`pierre-review.com`**. Because the domain is
   Railway-managed, Railway creates the DNS records and provisions TLS for you —
   wait for the certificate to go green.
   - Optional but recommended: also add **`www.pierre-review.com`** and redirect it
     to the apex, so both resolve and everyone lands on the canonical origin.
2. **Set `APP_BASE_URL=https://pierre-review.com`** (no trailing slash) on the app
   service. This is the canonical origin: the OAuth `redirect_uri`, the CORS
   allow-list (`origin: [APP_BASE_URL]`), and the sealed session cookie are all
   derived from it — so it must match the domain users actually land on. Use the
   **apex**, and redirect `www` → apex (step 1) so the OAuth round-trip and cookie
   stay on one host.
3. **Point the GitHub App at it.** In the App's settings, set the **Callback URL**
   to **`https://pierre-review.com/api/auth/callback`** and the **Homepage URL** to
   `https://pierre-review.com`. The callback must match `APP_BASE_URL` exactly, or
   the OAuth exchange fails.
4. **Redeploy** so the new `APP_BASE_URL` takes effect.

## Step 5 — First sign-in

1. Visit `https://pierre-review.com/` → the landing page → **Sign in with GitHub**.
2. Authorize the App; you're redirected to `/app`.
3. Add any **public** repo from the picker and watch the first sync run — no
   installation needed (sign-in alone grants read access to public repos).
4. To watch **private** repos, install the App where they live
   (`https://github.com/apps/<slug>/installations/new`, "All repositories" or a
   selection); for orgs you don't own, GitHub's "Request" flow notifies an owner.
   See [GITHUB-APP-SETUP.md §5](./GITHUB-APP-SETUP.md).

> **Other users get a 404 on github.com when signing in (but you don't)?** The
> GitHub App is still **private** ("Only on this account"), so only the owner can
> authorize it — everyone else 404s on the authorize page. Make the App public:
> **GitHub App → Advanced → Danger zone → Make public**. This is the most common
> cloud-deploy snag — see [GITHUB-APP-SETUP.md §3](./GITHUB-APP-SETUP.md).

---

## Operational notes

- **No SQLite→Postgres data migration.** Cloud starts empty; synced data is
  regenerable by re-syncing (the project's own philosophy). The `commitFiles`
  cache rebuilds on demand.
- **Scheduled sync** runs every 5 minutes per account (`SYNC_CRON`), the same as
  local. One bad token doesn't abort the loop.
- **Claude Review is force-disabled in cloud** regardless of `ENABLE_CLAUDE_REVIEW`
  (it needs a local `gh` + writable clone dir). Its routes 404 and the tab hides.
- **Rotating secrets:** rotating `SESSION_SECRET` invalidates all sessions
  (everyone re-signs-in). Do **not** rotate `ENCRYPTION_KEY` without re-encrypting
  stored tokens — a new key can't decrypt old tokens (users would need to re-auth).
- **Migrations on redeploy** are idempotent; the migrator only applies new ones.

See [LOCAL-CLOUD-TESTING.md](./LOCAL-CLOUD-TESTING.md) to exercise this whole
flow on your laptop before deploying.
