# pierre-review

A single-page dashboard for tracking team GitHub activity across multiple repos.
Horizontal timeline per repo, member sub-lanes, drill-down into PRs and review
threads — including reading review threads in-app.

Runs two ways from one codebase (the `DEPLOYMENT_MODE` env var selects):

- **Local** (default): zero-config, SQLite, authenticates via your `gh` CLI.
  `npx pierre-review` opens straight to the timeline — no landing page, no
  accounts. This is the unchanged original experience.
- **Cloud** (multi-tenant): a public dark landing page, GitHub-App sign-in,
  per-user encrypted accounts, and Postgres. Self-host on Railway. See
  [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md).

## Prerequisites

- Node ≥ 20 (developed on 24)
- pnpm ≥ 9
- GitHub CLI (`gh`) authenticated: `gh auth login`. For org repos behind SSO you
  may need `gh auth refresh -h github.com -s read:org`. *(Local mode only — cloud
  mode uses GitHub-App OAuth instead.)*

## Quick start (local)

```bash
pnpm install
cp .env.example .env        # optional; sensible defaults otherwise
pnpm db:migrate             # create the SQLite schema
pnpm dev                    # backend :4000 + frontend :5173
```

Open http://localhost:5173. Add repos from the UI (owner/name); the first sync
backfills the last 90 days, then incremental sync runs every 5 minutes.

### One-off sync without the server

```bash
pnpm sync:once owner/repo
pnpm db:studio              # inspect the data
```

## Cloud mode (multi-tenant)

The cloud deployment is Postgres-backed with GitHub-App sign-in. Local mode is
untouched. To run the full deployed experience on your laptop:

```bash
docker compose up -d db                 # local Postgres (see docker-compose.yml)
cp .env.cloud.example .env              # fill in GITHUB_APP_*, secrets, DATABASE_URL
DEPLOYMENT_MODE=cloud pnpm dev          # landing at /, app at /app, OAuth gate
```

Docs:

- [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md) — deploy to Railway step by step.
- [docs/GITHUB-APP-SETUP.md](docs/GITHUB-APP-SETUP.md) — create the GitHub App.
- [docs/LOCAL-CLOUD-TESTING.md](docs/LOCAL-CLOUD-TESTING.md) — test cloud locally.

Verify cross-account isolation (query-layer IDOR check):

```bash
pnpm --filter @pierre-review/backend verify:isolation
```

## Layout

- `apps/backend` — Fastify API, Drizzle + SQLite/Postgres, GitHub sync engine
- `apps/frontend` — React + Vite + Tailwind + vis-timeline dashboard (served at `/app`)
- `apps/landing` — public marketing landing page (cloud mode, served at `/`)
- `packages/shared` — API types shared by both sides

See `CLAUDE.md` for the architecture, conventions, and the local/cloud split.
