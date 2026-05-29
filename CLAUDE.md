# gh-team-monitor

Local-only single-page dashboard for tracking team GitHub activity across
multiple repos. Built for sprint situational-awareness — who's doing what,
which PRs are stalled, which review threads are sitting untouched.

## Stack

- pnpm workspaces, TypeScript everywhere (ESM)
- Backend: Fastify + Drizzle + SQLite (better-sqlite3)
- Frontend: React + Vite + Tailwind + vis-timeline
- GitHub: @octokit/graphql with token from `gh auth token`

## Commands

From the root:

- `pnpm install` — install all workspaces
- `pnpm dev` — runs backend (4000) and frontend (5173) concurrently
- `pnpm dev:backend` / `pnpm dev:frontend` — one side only
- `pnpm db:generate` — generate a migration from schema changes
- `pnpm db:migrate` — apply drizzle migrations
- `pnpm db:studio` — open drizzle-studio
- `pnpm sync:once owner/repo` — one-off sync of a single repo (no server)
- `pnpm typecheck` — tsc --noEmit across all packages
- `pnpm test` — vitest

## Key concepts

**Derived thread state** is the heart of this app. See
`apps/backend/src/sync/derive-thread-state.ts`. Four states:
`resolved` / `replied_unresolved` / `likely_addressed` / `untouched`.
`likely_addressed` is a heuristic — UI communicates the uncertainty.

**Sync** runs incrementally every 5 minutes via node-cron, but is idempotent —
all entities use GitHub node IDs as natural keys, and events carry a
`dedupe_key`. Backfill is the same code path with no `since` filter and a
configurable depth cap (default 90 days).

**Auth** is one-shot at startup — shell out to `gh auth token`. Fail loudly if
gh isn't authenticated.

## Conventions

- ESM throughout. Backend uses NodeNext resolution: relative imports need
  explicit `.js` extensions. Frontend uses Bundler resolution (no extensions).
- Schema changes: edit `apps/backend/src/db/schema.ts`, then `pnpm db:generate`
  and commit the migration with the schema change.
- Shared types live in `packages/shared/src/types.ts`. Don't import backend
  code from the frontend or vice versa — only `@gh-team-monitor/shared`.
- The `/api/timeline` endpoint is hot — keep it lean. No comment bodies, no
  diff hunks. Fetch detail on demand via `/api/prs/:id`.
- Heuristics get fixture tests. Add a sample to
  `apps/backend/src/sync/__fixtures__/threads/` before changing the
  derivation logic.

## Build order

See `V1_PLAN.md` for the full plan and phase breakdown. Phase numbers in commit
messages are helpful (`feat(p3): add timeline endpoint`).
