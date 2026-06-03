# pierre-review

A local-only single-page dashboard for tracking team GitHub activity across
multiple repos. Horizontal timeline per repo, member sub-lanes, drill-down into
PRs and review threads — including reading review threads in-app.

## Prerequisites

- Node ≥ 20 (developed on 24)
- pnpm ≥ 9
- GitHub CLI (`gh`) authenticated: `gh auth login`. For org repos behind SSO you
  may need `gh auth refresh -h github.com -s read:org`.

## Quick start

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

## Layout

- `apps/backend` — Fastify API, Drizzle/SQLite, GitHub sync engine
- `apps/frontend` — React + Vite + Tailwind + vis-timeline dashboard
- `packages/shared` — API types shared by both sides

See `CLAUDE.md` for conventions and `V1_PLAN.md` for the full design.
