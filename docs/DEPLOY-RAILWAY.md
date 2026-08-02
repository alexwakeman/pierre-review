# Deploying pierre-review to Railway (cloud, multi-tenant)

This deploys the **public, multi-tenant** build: a dark landing page at `/`,
GitHub-App sign-in, per-user accounts, and Postgres. Local mode (SQLite +
`gh auth token` + `npx pierre-review`) is unaffected and needs none of this.

> Prerequisite: set up sign-in (a GitHub OAuth App and/or GitHub App) first — see
> [GITHUB-AUTH-SETUP.md](./GITHUB-AUTH-SETUP.md).

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
| `GITHUB_OAUTH_CLIENT_ID` | from the OAuth App | **OAuth App** (public repos, no install) — set both to enable it |
| `GITHUB_OAUTH_CLIENT_SECRET` | from the OAuth App | |
| `GITHUB_OAUTH_SCOPE` | *(optional)* `public_repo read:org` | scopes requested at sign-in; default targets public repos |
| `GITHUB_APP_CLIENT_ID` | from the GitHub App | **GitHub App** (adds private org repos via install) — set all three to enable it |
| `GITHUB_APP_CLIENT_SECRET` | from the GitHub App | |
| `GITHUB_APP_SLUG` | the GitHub App slug | for the private-repo install link on the sign-in gate |
| `SESSION_SECRET` | `openssl rand -hex 32` | seals the session cookie |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | **must be 64 hex chars (32 bytes)** — AES-256-GCM key for stored tokens |
| `PORT` | (Railway sets this) | the app reads it; `HOST` defaults to `0.0.0.0` in cloud |
| `VITE_GA_ID` | `G-XXXXXXXXXX` (optional) | **BUILD-TIME** GA4 Measurement ID. Vite inlines it into the landing + SPA bundles at build, so it must reach the Docker build — the `Dockerfile` declares `ARG VITE_GA_ID`, and Railway passes the service variable to it. Empty/unset → analytics stays off. **Changing it requires a rebuild**, not just a restart. |
| `SEVERITY_API_URL` | `http://severity-api.railway.internal:8080` (optional) | **The whole gate** for ML severity/category enrichment of bot comments (free tier — see [ML-SEVERITY.md](ML-SEVERITY.md)). Unset ⇒ the feature is inert: no worker, `/api/me` reports `mlSeverity:false`, the SPA issues no ML queries. Points at the **`severity-api`** service from the sibling `pierre-ml` repo, which must live in the **same Railway project + environment** (private DNS is per-environment) and must **NOT** have a public domain — it is unauthenticated by design. Prefer a Railway reference variable over a hardcoded host. `ML_SEVERITY_DISABLED=true` is the kill switch; `ML_ENRICHMENT_CRON` / `ML_TICK_BUDGET_MS` / `ML_BATCH_MAX_CHARS` / `ML_CONCURRENCY` tune the worker (defaults are sized for the deploy's 2 uvicorn workers) |

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

> **Build-time vs runtime variables.** Most cloud vars above are read by the running
> server, so editing them + restarting is enough. `VITE_GA_ID` is the exception: it's
> baked into the static JS by Vite **during the image build**. Setting it (or changing
> it) only takes effect after Railway **rebuilds the image** — a plain restart reuses
> the old bundle. If GA's "Test installation" says no tag was detected, the build ran
> without the variable: confirm `VITE_GA_ID` is set on the service and trigger a fresh
> deploy/rebuild (a no-cache build if Railway cached the old `pnpm package` layer).

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
3. **Point your app(s) at it.** In each app you configured (OAuth App and/or GitHub App),
   set the **callback URL** to **`https://pierre-review.com/api/auth/callback`** and the
   **Homepage URL** to `https://pierre-review.com`. The callback must match `APP_BASE_URL`
   exactly, or the exchange fails.
4. **Redeploy** so the new `APP_BASE_URL` takes effect.

## Step 5 — First sign-in

1. Visit `https://pierre-review.com/` → the landing page → **Sign in with GitHub**. The
   sign-in gate offers whichever methods you configured (OAuth App / GitHub App).
2. Authorize; you're redirected to `/app`.
3. Add any **public** repo from the picker and watch the first sync run — public repos
   (PRs, reviews, comments, **and CI checks**) work with **no install** on either method.

> **Watching private repos?** Sign in with the **GitHub App** and **install** it on the org
> that owns them (`github.com/apps/<GITHUB_APP_SLUG>/installations/new`; an org owner may need
> to approve). Alternatively the OAuth App can reach private repos with
> `GITHUB_OAUTH_SCOPE=repo read:org`, but a private repo in an org with OAuth App restrictions
> still needs a one-time org-owner approval. See [GITHUB-AUTH-SETUP.md](./GITHUB-AUTH-SETUP.md).

---

## Optional — the paid Pro tier (summary AI)

The base cloud deploy above ships the **free** tier (timeline + activity feed including My Turn /
"FYI" participation, no AI). To offer **paid Pro** — the **summary-AI** features (per-repo Haiku
digests, the sprint report, Workspace Insights, Jira/Linear issue links, Slack digest) at **$15/mo**, metered
by a **2,500-credit monthly allowance** — you deploy a **private image** that bundles the
`@pierre/pro` plugin. The expensive **agentic** AI (Claude Review / AI Fix) stays **off** in
cloud; the meter still tracks it for a future tier.

Everything is opt-in behind env flags, so the default Dockerfile build stays OSS-only.

### 1 — Build & push the private image (GitHub Actions → GHCR)

The public Dockerfile takes `--build-arg WITH_PRO=true`, which compiles the private
`packages/pro` submodule into the image and adds `@anthropic-ai/sdk` (the only extra runtime
dep the summary seam needs). The `.github/workflows/deploy-cloud.yml` workflow does this and
pushes to **private GHCR** — nothing about Pro appears in the logs.

Add these **repo secrets** (Settings → Secrets → Actions):

| Secret | What |
|---|---|
| `PRO_DEPLOY_KEY` | an **SSH read-only deploy key** on `alexwakeman/pierre-pro` — lets the workflow fetch the private submodule. Generate with `ssh-keygen -t ed25519`, add the **public** half as a deploy key on the pro repo, paste the **private** half here. |
| `RAILWAY_TOKEN` | *(optional)* a Railway token so the workflow redeploys after pushing the image; else enable Railway's own "redeploy on image change". |
| `RAILWAY_SERVICE` | *(optional)* the Railway service name — set it when `RAILWAY_TOKEN` is a **project** token, so `railway redeploy` targets the right service. |
| `VITE_GA_ID` | *(optional)* build-time GA id, same as the base deploy — **required here for GA on the app**, since the image is prebuilt (a Railway runtime var won't reach it). |

The workflow runs **automatically on every push to `main`** (doc/CI-only pushes and the release
bump commit are skipped) **and** on manual dispatch (**Actions → Deploy cloud image → Run
workflow** — use this for the first run to confirm the secrets). It publishes
`ghcr.io/<owner>/pierre-review-cloud:latest` (+ a `:<sha>` tag), then redeploys Railway.

### 2 — Point Railway at the image

In the app service settings, change the **source** from the Dockerfile build to
**deploy from the GHCR image** `ghcr.io/<owner>/pierre-review-cloud:latest`, and add a
**GHCR pull credential** (a PAT with `read:packages`, since the package is private).

### 3 — Set the Pro variables

On top of the base cloud vars, add:

| Var | Value | Notes |
|---|---|---|
| `PRO_CLOUD_ENABLED` | `true` | flips `config.proEnabled` on in cloud (the master gate). Without it, the plugin never loads. |
| `PRO_DIGEST_ENABLED` | `true` | turns on the digest + sprint-report generation (the `activityDigest` capability). |
| `SUMMARY_ANTHROPIC_API_KEY` | `sk-ant-…` | **required.** The metered Anthropic key the summary seam spends against — there is no ambient Claude session in cloud, so **the app fails loud at boot without it** (`assertCloudConfig`). |
| `STRIPE_PAYMENT_LINK_URL` | your Payment Link | the "Get Pro" checkout (see [BILLING-STRIPE.md](./BILLING-STRIPE.md)). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | verifies the webhook that flips `accounts.plan` to `pro`. |

**Leave `PRO_ADVANCED_AI_ENABLED` UNSET** — that keeps the agentic tier (Claude Review /
AI Fix) off in cloud.

`PRO_PLUGIN_PATH` is baked into the image (`/app/pro/dist/index.js`) — you don't set it.

### 4 — Entitlement & the credit meter

- **Who gets Pro:** per-account. A cloud account sees Pro only when its `accounts.plan` is
  `pro` (set by the Stripe webhook on checkout); free accounts get `402` on every `/api/pro/*`
  route and the plain free UI. Until the onboarding flow lands, flip your first testers by
  hand: `UPDATE accounts SET plan = 'pro' WHERE github_login = '…';`.
- **The allowance:** each paid account gets **2,500 credits/month** (≈ $2.00 of Haiku spend;
  `$1 = 1,250 credits`). Usage is summed from the `ai_usage` ledger since the UTC month start,
  so it **resets automatically** on the 1st. The **Track usage** panel shows a used/2,500 bar;
  once spent, digest + sprint **Generate/Regenerate** disable with an "out of AI credits"
  message and cached summaries still render. Override per account with
  `accounts.ai_credit_allowance` (null = the 2,500 default).
- The **default `WITH_PRO=false` image is byte-identical** to today's OSS build, so a plain
  Railway-builds-the-Dockerfile deploy still works free-tier-only.

---

## Operational notes

- **No SQLite→Postgres data migration.** Cloud starts empty; synced data is
  regenerable by re-syncing (the project's own philosophy). The `commitFiles`
  cache rebuilds on demand.
- **Lean storage keeps Postgres small.** By default (`PERSIST_BODIES` unset) the
  bulky user-authored text — comment/review/PR bodies, diff hunks, commit messages,
  the per-job `checkRuns` JSON — is **not** stored in Postgres; it's hydrated from
  GitHub on demand when a PR is opened (using the account's OAuth token) and cached
  in the user's browser. This is the dominant per-tenant cost (it's duplicated per
  account), so dropping it shrinks the database substantially. Set
  `PERSIST_BODIES=true` only if you want that text stored server-side.
- **Scheduled sync** runs every 5 minutes per account (`SYNC_CRON`), the same as
  local. One bad token doesn't abort the loop.
- **The agentic AI tier (Claude Review / AI Fix) stays off in cloud** by leaving
  `PRO_ADVANCED_AI_ENABLED` unset (the retired `ENABLE_CLAUDE_REVIEW` flag no longer
  applies; `PRO_CLAUDE_REVIEW_ENABLED` remains only as a back-compat alias). It needs a
  local `gh` + a writable clone dir, so its routes 404 and the tab hides in cloud.
- **Rotating secrets:** rotating `SESSION_SECRET` invalidates all sessions
  (everyone re-signs-in). Do **not** rotate `ENCRYPTION_KEY` without re-encrypting
  stored tokens — a new key can't decrypt old tokens (users would need to re-auth).
- **Migrations on redeploy** are idempotent; the migrator only applies new ones.
- **Chrome "Dangerous site" warning on sign-in** (seen most on work/org-managed
  profiles, while personal profiles work fine): this is Google Safe Browsing
  reacting to a new low-reputation domain, not your server. See
  [DOMAIN-REPUTATION.md](./DOMAIN-REPUTATION.md) to diagnose and clear it.

See [LOCAL-CLOUD-TESTING.md](./LOCAL-CLOUD-TESTING.md) to exercise this whole
flow on your laptop before deploying.
