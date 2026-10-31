# The static demo runtime

The website hosts a frontend-only demo of Limn at `/demo/`. It is the real SPA, built from a
different entry, with every `/api/*` request answered in the browser from a **recording** of
sample (Acme) data. Nothing is sent anywhere; a reload starts from the recording again.

```sh
pnpm --filter @pierre-review/frontend build:demo   # → apps/frontend/dist-demo/, base /demo/
pnpm --filter @pierre-review/frontend dev:demo     # the same, on the Vite dev server
pnpm --filter @pierre-review/site dev              # serves dist-demo at /demo/ (DEMO_DIR)
```

## How it is wired

- `vite build --mode demo` (vite.config.ts `limnDemo()`) sets `base: '/demo/'`, writes to
  `dist-demo/`, defines `import.meta.env.VITE_LIMN_DEMO = '1'`, and rewrites `index.html` to load
  `src/demo/entry.ts` instead of `src/main.tsx`. A normal `vite build` contains none of this
  folder — its output is byte-for-byte the same as before the demo existed.
- `entry.ts` loads the recording, wraps `window.fetch` (`install.ts`), clears the persisted query
  cache, mounts the notice bar (`banner.ts`, `demo.css`) and then imports `../main.tsx`.
- `virtual:limn-demo-recording` resolves to `data/recording.json` when that file exists, else to
  `data/sample-recording.json`.
- The SPA's own URLs follow `import.meta.env.BASE_URL`, so routing works under `/demo/`.
- No inline script, no `eval`: the site's demo CSP holds.
- `window.__limnDemo.log` lists every request the demo answered and which stage answered it
  (`runs`, `route`, `recording:exact`, `recording:path`, `fallback`, `missing`) — the quickest
  way to see what a recording lacks.

## The recording format

`src/demo/recording.ts` has the TypeScript type (`DemoRecording`). The recorder must write
exactly this:

```json
{
  "version": 1,
  "capturedAt": "2026-10-20T09:00:00.000Z",
  "entries": [
    { "method": "GET", "path": "/api/open-prs?workspace=1", "status": 200, "body": { "prs": [] } },
    {
      "method": "GET",
      "path": "/api/prs/12/claude-review/stream",
      "status": 200,
      "stream": [
        { "event": "message", "data": { "type": "snapshot", "status": "succeeded", "reviewId": 4, "progress": null }, "delayMs": 0 },
        { "event": "message", "data": { "type": "done", "status": "succeeded", "reviewId": 4 }, "delayMs": 50 }
      ]
    }
  ]
}
```

- `path` is the pathname plus the query string with its parameters **sorted** by name.
  Time-window parameters (`from`, `to`, `since`, `until`, `before`, `after`, `start`, `end`,
  `asOf`, `now`, `fromMs`, `toMs`, `_`) and any value that is an ISO date or a 12–13 digit epoch
  in milliseconds are dropped before matching, on both sides, so the recorder may leave them in.
- `body` is the JSON response. `stream` replaces it for a `text/event-stream` response: one
  object per `data:` frame, `delayMs` after the previous frame.
- A 4xx/5xx may be recorded; it is replayed as is.

### Matching, in order

1. A run started in the demo (`runs.ts`) answers its own start, reads and stream.
2. Hand-written routes (`routes.ts`): `/api/me`, the "nothing changed" answers, the batched read
   POSTs and every write.
3. The recording: exact method + normalised path, then the same method + pathname with the query
   ignored EXCEPT its identity parameters (`IDENTITY_PARAMS` in `recording.ts`: `workspace`,
   `authorUserIds`, `botUserId`, `disagree`, `userIds`, `prIds`, `repoId`, `ident`, `key`, …).
   Among the entries that agree on all of them the first recorded wins; with none, the lookup
   misses and the next stage answers. `workspace` follows the server's rule: absent or unknown is
   the default workspace (from the recorded `GET /api/workspaces`), so one recorded workspace is
   never answered with another's data.
4. `GET_FALLBACKS` in `routes.ts`: small, fully known shapes for per-PR reads (thread-check status,
   suggested reviewers, ML labels, SonarCloud, …).
5. Otherwise a GET answers `404 { "error": "NotInDemo", "message": "Not available in the demo." }`,
   a DELETE answers 204, and any other write answers 409 with the same body. An unrecorded
   `…/stream` GET is an empty stream that closes at once.

A paged list (`{ items, total }`) is served with `total` cut to what the recording holds, so the
SPA never asks for a page that is not there. A cursor-paged list (`{ items, nextCursor }`) keeps
its `nextCursor` only when the page it names was recorded under that exact query, and a `cursor`
request the recording does not hold answers no items and no further cursor.

### Batched read POSTs

`/api/claude-review/states`, `/api/claude-review/thread-judgements`, `/api/ci-reviews/states`,
`/api/ticket-reviews/states`, `/api/ticket-links`, `/api/reactions/lookup` and `/api/prs/resolve`
take a list of ids in the body. Record **one** POST entry per path whose response covers every id
the demo shows (entries for the same path are concatenated); each request is answered with just
its own rows, in its own order.

## Time rebase

On load, `delta = Date.now() − Date.parse(capturedAt)`. Every recorded body is shifted once, on
first use, and cached:

- every string that is a full ISO-8601 timestamp (date **and** time, with `Z` or an offset) moves
  by `delta`;
- every number under a key ending in `At` or `Ms` that lies within ±3 years of `capturedAt` is
  read as epoch milliseconds and moves by `delta`.

Calendar values move by whole calendar units, so they stay calendar values, keep their weekday
and agree with each other:

- a timestamp on an exact hour (zero minutes, seconds and milliseconds) is a calendar boundary —
  a period's start, a sprint's dates, a week bucket, at UTC midnight or at a local midnight such
  as `T23:00Z` — and moves by `days`, the delta rounded to whole WEEKS, so a Monday week is still
  a Monday week; recorded event times are almost never on the hour;
- a date without a time (`2026-10-20`) and a sprint period key (`sprint-2026-10-06`) move by the
  same `days`;
- a month period key (`month-2026-09`) moves by `months`, the calendar months between
  `capturedAt` and now, so the month in progress at capture is the month in progress now; an object
  carrying a month `periodKey` gets its `periodStart`, `periodEnd` and `cadenceDays` rewritten to
  the shifted month, and an in-progress month's `elapsedDays` is recomputed from its shifted
  start. The month's metric values are still the capture's.

Event times move by the exact delta while calendar values move by whole weeks, so a calendar
value can sit up to three and a half days away from the events around it.

Durations (`waitMs: 5400000`) are nowhere near an epoch, so they stay. The SPA sends period keys
back in request paths (`/api/pro/insights/reports/sprint-…`): `DemoServer.handle` moves every key
and date in a request's PATH back by the same amounts (`Rebaser.unshiftPath`) before matching.
Date-like QUERY values need nothing, because matching drops them.

## Writes

`routes.ts` simulates every write the SPA makes and keeps the effect in memory (`overlay.ts`):
a merge marks the PR merged and drops it from Open PRs (a second merge answers 409
`NotMergeable`), a resolved thread reads resolved, a reply or comment appears, approve / request
changes / withdraw change the reader's standing, auto-merge arm and disarm show in the armed list,
workspace edits and every settings PUT are read back, and a pushed AI Fix reads pushed.
The Pending reads (`/api/attention`, `/api/my-turn`, `/api/daily-brief`, `/api/pro/work-plan`)
drop every card of a PR merged or closed here and every My Turn entry dismissed here (listed
under "Dismissed" until it is brought back), take the removed cards off each tab's, kind's and
lens's count, and carry the overlay's PR fields (merge state, queue) on the cards that stay.
Questions (the review chat, the docs chat, This Sprint's "Ask") answer with one plain line saying
the active provider is not connected in the demo. Repository adds, syncs and other writes it
cannot fake answer "Not available in the demo." in the SPA's error shape.

**The AI provider (Settings → AI) is simulated, never recorded** (`provider.ts`). The reader is
signed in to both providers (Claude Code; Codex with ChatGPT Plus) and the choice starts at Auto,
which is Claude. `PUT /api/ai/provider` and the Codex sign-in routes keep their effect in memory;
`/api/me`'s `ai` block, `/api/ai/budget` (`aiBudget.ts`: Claude's windows, or Codex's own windows
with Limn's token-weighted share, percentages only) and every run started afterwards follow it — a
replayed run is labelled with the provider that was active when it started and that provider's model
of the template's depth, never the template's own label. The stored runs keep theirs: the seeder
writes a mix (`seed-demo-agentic.ts`), and #105 holds a Claude Opus review and a Codex GPT-6.1 Sol
review of the same head.

**The in-app conflict resolver is not in the demo.** The demo's `/api/me` answers
`conflictResolver: false`, so no surface offers "Resolve conflicts"; a conflicts card still shows
the conflict.

### Agentic runs

Claude Review, AI Fix (and Plan first), the ticket review, the CI review, Check threads and the
story's docs check: a start copies a **finished run of the same kind from the recording** (this
PR's or ticket's own if there is one, else any), gives it a new id and plays it out over a few
seconds — `queued`, `running` with a simulated progress stream (snapshot, progress frames,
`done`), then the recorded result re-keyed to this PR. **The recording must therefore contain at
least one finished run per kind**: a `GET /api/prs/:id/claude-review` with a succeeded `review`,
`GET /api/pro/prs/:id/ai-fix` with a succeeded `fix`, `GET /api/prs/:id/ticket-reviews` with a
succeeded ticket `review`, `GET /api/prs/:id/ci-review`, `GET /api/prs/:id/claude-review/thread-check`
and `GET /api/docs/story-alignment?ident=…` with a succeeded run. Without one, that start answers
"Not available in the demo." (Check threads has a built-in fallback.)

## The real recording

`data/recording.json` is made by the recorder from the fictional Acme data the demo seeder writes:

```sh
pnpm demo:record          # seed a scratch DB, boot an isolated stack, walk the SPA, write the file
pnpm demo:record --changed   # …or re-record only the steps a change touches, merged in (docs/DEMO.md § 2)
pnpm --filter @pierre-review/frontend build:demo
pnpm demo:verify          # serve dist-demo at /demo/ and open every view (--later=40: 40 days on)
```

- `apps/backend/scripts/seed-demo.ts` and its siblings write the data: `seed-demo-tracker.ts` (a
  fictional Jira site read through the real tracker worker, This Sprint's briefs, themes and paths),
  `seed-demo-agentic.ts` (finished Claude Reviews, Check threads, a CI review, AI Fix and a plan,
  ticket reviews, designs, the reference library and a docs check — each stored by the product's
  own pipeline with a written answer at its model seam) and `seed-demo-platform.ts` (settings
  through the real routes, merge state, and the written summaries through a fake Anthropic endpoint
  in the seed process). No model is called.
- `scripts/record-demo.mjs` boots the backend with no credential that works (a fake token and
  `ANTHROPIC_BASE_URL` on a closed loopback port) and never presses a Run, Post, Merge or Save
  button. `scripts/record-demo-steps.mjs` is the walk. The few reads that are live GitHub calls in
  the product (the Changes tab's files, a job log, the merge control's options, reactions) are
  answered in the browser by `scripts/lib/demo-github.mjs` from the same fictional code
  (`scripts/lib/demo-diffs.mjs`).
- Every GET is kept once per normalised path, owned by the FIRST step (in declared order) that
  recorded it, and entries are sorted by (owner step, path) — so the default workspace's answers come
  first and the file does not depend on how many pages recorded it. The batched read POSTs are merged
  into one entry per path; finished runs' `…/stream` endpoints are read from the backend as frame
  lists. `data/recording-steps.json` (never shipped) lists which steps recorded each answer, for
  incremental re-records.

## The sample recording

`data/sample-recording.json` is generated from the typed e2e fixtures (`e2e/mock-api.ts`) plus one
hand-written finished Claude review:

```sh
./apps/backend/node_modules/.bin/tsx apps/frontend/src/demo/tools/make-sample.ts
```

It boots to Activity → Open PRs (five PRs in `acme/web`), opens any of them, and replays a
Claude review. The real recording, `data/recording.json`, replaces it when present.
