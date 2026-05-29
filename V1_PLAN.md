# gh-team-monitor — v1 plan

A local-only single-page dashboard for tracking team GitHub activity across
multiple repos. Horizontal timeline per repo, member sub-lanes, drill-down into
PRs and review threads (including reading threads in-app).

**Out of scope for v1:** Jira integration, hosting, anything multi-user,
replying to comments from inside the app.

## Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Monorepo | pnpm workspaces | |
| Language | TypeScript everywhere | |
| Backend | Fastify | Typed routes, schema validation |
| ORM | Drizzle | TS-first schema, real migrations |
| DB | SQLite via `better-sqlite3` | Single user, local |
| GitHub client | `@octokit/graphql` | One query per repo per sync |
| Auth | `gh auth token` shelled at startup | Free SSO handling |
| Scheduler | `node-cron` | Periodic incremental sync |
| Frontend | React + Vite | |
| Server state | TanStack Query | |
| UI state | Zustand | Filters, selection |
| Styling | Tailwind | |
| Timeline | `vis-timeline/standalone` | Swim lanes, range + point items |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` | Comment bodies |
| Diff view | Custom component over GraphQL `diffHunk` | |

## Build order

1. **Phase 1 — Skeleton.** pnpm monorepo, Fastify health route, Vite+React+
   Tailwind shell with `/api` proxy, Drizzle init + first migration, CLAUDE.md.
2. **Phase 2 — Sync engine.** `getGithubToken()`, octokit client, full schema,
   `sync-repo.ts` upserts via one-off script, per-commit changed-files REST
   cache, `derive-thread-state.ts` with fixture tests.
3. **Phase 3 — API + scheduler.** repos CRUD, background sync + status,
   users + bot detection, lean `/api/timeline`, full `/api/prs/:id`,
   `/api/threads/:id`, node-cron incremental loop.
4. **Phase 4 — Frontend timeline.** 3-band layout, TanStack Query, Zustand
   filter store with URL sync, FilterBar, vis-timeline with repo lanes +
   member sub-lanes.
5. **Phase 5 — PR detail + thread reading.** PrDetail (Threads/Activity tabs),
   ThreadList, ThreadView with DiffHunk + CommentList, markdown comments,
   marker click opens a thread directly.
6. **Phase 6 — Polish.** Empty-state stats, sync-now button, stalled badge,
   keyboard shortcuts, dark mode, loading/error states.

## Derived thread state

```
resolved          thread.isResolved == true
likely_addressed  a commit touched thread.path after the last comment
replied_unresolved  someone other than the original commenter replied
untouched         none of the above
```

`likely_addressed` is a heuristic; the UI communicates the uncertainty. Keep it
honest with fixture tests built from real annotated threads.

## API routes

```
GET    /api/repos
POST   /api/repos                  { owner, name }
DELETE /api/repos/:id
POST   /api/repos/:id/sync         202, background
GET    /api/repos/:id/sync-status
GET    /api/users
PATCH  /api/users/:id              { isBot }
GET    /api/timeline?from&to&repoIds&userIds&types&excludeBots
GET    /api/prs/:id
GET    /api/threads/:id
```

## Open questions

- Per-commit changed files: REST gives one call per SHA, cached forever. If
  backfill is painful, fall back to `pulls/{n}/files` aggregate.
- Webhooks out of scope for v1; `smee.io` is a later upgrade path.
- Org SSO: if `gh auth token` lacks SAML SSO authorisation, GraphQL 401s —
  surface "run `gh auth refresh -h github.com -s read:org`".
- Bot detection: `[bot]` suffix + known names (dependabot, renovate,
  github-actions); manual override via `PATCH /api/users/:id`.

## Deviations from the original plan (as built)

- `events` table gained a `dedupe_key` (unique) so event upserts are idempotent.
- `users` gained `is_bot_overridden` so auto bot-detection never clobbers a
  manual toggle.
