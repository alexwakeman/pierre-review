# Security & privacy posture

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Security & privacy posture (read before touching app.ts, CORS, or any AI route)

Hardened for public release (2026-07-26). Two new **zero-dependency** core plugins own it —
deliberately hand-rolled rather than `@fastify/helmet`/`@fastify/rate-limit`, because a new
runtime dep must also be threaded through the curated release manifest + the pinned lockfile,
and helmet's default CSP is wrong for this app three ways over.

**`api/plugins/security.ts`** — registered FIRST in `app.ts` so headers ride on every response
(redirects, 404s, static assets):
- **CSP per surface**: `/api` → `default-src 'none'`; everything else → the SPA policy (the
  backend serves no landing). `style-src 'unsafe-inline'` is unavoidable and accepted (React style attrs +
  vis-timeline positions items by mutating `element.style`); **`script-src` stays strict** — no
  `'unsafe-inline'`, no `'unsafe-eval'` (verified: no `eval`/`new Function` in vis-timeline /
  vis-data / vis-util). `img-src https:` is REQUIRED — comment bodies are third-party markdown
  embedding arbitrary hosts. No third-party origin is in it at all — the SPA loads no analytics.
- nosniff, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Referrer-Policy:
  strict-origin-when-cross-origin` (app URLs carry repo/PR ids), `Permissions-Policy`, COOP;
  `/api` also gets `Cross-Origin-Resource-Policy: same-origin` + `Cache-Control: no-store`.
  No HSTS: the server is plain http on loopback.
- **`corsOriginDelegate` — CORS is an ALLOWLIST.** It was
  `origin: true` (reflect ANY origin) *and* has no auth (every request resolves to account 1),
  so **any page the developer had open could read their whole synced GitHub dataset
  cross-origin and drive their write actions**. That was the audit's one CRITICAL. Local now
  allows any **loopback** origin on any port (dev 5173/5174, demo 5273, the packaged CLI's own
  port). `ALLOWED_ORIGINS` adds more.
- **`registerCrossOriginGuard` — NOT redundant with CORS.** CORS only decides whether the
  attacker's page may READ the response; a simple cross-origin POST is still delivered and still
  executes. Rejects state-changing `/api` calls whose `Sec-Fetch-Site: cross-site` (falling back
  to `Origin`); header-less clients (curl/CLI) pass, since CSRF needs a browser.
- **`registerHostGuard`** (loopback binds only) — 421s a non-loopback `Host`, the
  DNS-rebinding case that survives every origin check. `ALLOWED_HOSTS` opts a named host back in.

**The public contact form lives in `apps/site`, not here** (moved 2026-10-22 with the landing;
`apps/site/src/contact.ts`, `rate-limit.ts`, `security.ts`, documented in `apps/site/README.md`).
It is the ONE anonymous, human-facing write surface the project runs, and kept its layers on the
move: a honeypot field (answered 200 and dropped — an error tells the bot's author which field
gave them away), a server-SIGNED minimum fill time (`GET /api/contact/ticket` mints
`<issuedAtMs>.<hmac>`, the POST needs an age in [3s, 6h]; a client-sent "elapsed" field would be
the submitter's to choose), 5 per HOUR per IP shared by the mint and the submit, no third-party
widget (so no CSP widening), a Slack-webhook sink whose URL is re-validated, every visitor
string Slack-escaped, and nothing stored (a FAILED delivery is logged in full, the one place a
message persists). ⚠ **The site's rate limit reads `X-Forwarded-For` from the RIGHT**,
`TRUST_PROXY_HOPS` entries in — the leftmost entry is client-written. The site also owns the
public posture the backend no longer has: per-surface CSP (landing, demo, API), HSTS
(`HSTS_MAX_AGE`) and the www → apex 301 (`SITE_URL`).

**`api/plugins/rate-limit.ts`** — fixed-window buckets keyed by **accountId** (the single local
account; the key still bounds a runaway loop in the SPA or a script). Registered AFTER
`registerAccountContext`. Tiers: `ai` 20/min **+ `ai_hourly` 120/h**, `pr_detail` 60/min,
`github_write` 60/min, `sync` 20/min, `search` 60/min, `read` 600/min. **Landmine: Claude
Review kept its historical paths** (`/api/prs/:id/claude-review*`, `/api/claude-reviews/*`,
`/api/claude-findings/*`), so `tierFor` matches those EXPLICITLY — a path-prefix test
would leave the most expensive routes on the 600/min read tier. `RATE_LIMIT_DISABLED=true` is the
escape hatch; `RATE_LIMIT_<TIER>` tunes a bucket. The `pr_detail` matcher covers `GET
/api/prs/:id` **plus `/merge-options`, `/files`, `/checks/:jobId/logs` and `/suggested-reviewers`**
— it was anchored to the bare id "because the sub-routes are DB-only reads", which was true when
written and quietly stopped being true, leaving the most GitHub-expensive GETs in the family on the
blanket bucket. **That mistake was then made twice**: the first fix asserted, in `tierFor`'s own
comment AND in a test, that `suggested-reviewers` "really is DB-only" — but
`enrichReviewerSuggestions` takes an access token (`github/reviewer-suggest.ts:35`), reads CODEOWNERS
over REST (`github/codeowners.ts`) and infers review teams over GraphQL (`github/team-reviewers.ts`).
Per-`(account, repo)` TTL caches make repeats free, but a cache-cold loop spends quota. **When in
doubt, follow the token** — and note that the passing test was pinning the wrong answer, so a test
agreeing with the code is only evidence of intent when the code is right. Genuinely DB-only and
correctly on `read`: `/bot-behaviour`, `/bot-dedup`, `/mention-candidates`, the retrieval-only
`/claude-review`, the cached `GET …/annotations`, `GET /api/auto-merge` and `GET /api/branch-status`.

**Fastify factory hardening** (`app.ts`): `trustProxy: false` (it would let a client choose its
own rate-limit key), `bodyLimit` 256 KiB (one route raises it: the 25 MB reference-docs upload), `requestTimeout` 60s,
`routerOptions.maxParamLength` 200 (top-level is FSTDEP022-deprecated), and a pino **`redact`**
list — an `err` from a failed HTTP call carries the outgoing `Authorization: token gho_…` /
`x-api-key: sk-ant-…` headers and pino serializes errors deeply.

**Other fixes worth knowing:**
- **`error-handler.ts`**: every status passes `err.message` through — the operator IS the
  caller, on their own machine, and should not have to read the terminal to debug their own
  instance.
- **`db/queries.ts` `listUsers(accountId)`** — `users` stays GLOBAL storage but the LISTING is
  account-scoped via 6 correlated subqueries (event actors, PR authors/mergers, requested
  reviewers, review + comment authors). **`PATCH /api/users/:id` + `setUserBot` were DELETED** — a global,
  ownership-free write of the sticky `isBotOverridden` flag, with no frontend caller; bot
  classification is the account-scoped `PATCH /api/bot-reviewers/:userId`.
- **`getTimeline`**: window CLAMPED to `config.retentionDays` in the route + hard row caps
  (`TIMELINE_PR_ROW_CAP` 5k / `TIMELINE_EVENT_ROW_CAP` 20k, newest-first) returning
  `truncated?: true`. `?from=1970&to=2100` used to materialise the whole retained dataset.
- **`github/codeowners.ts` ReDoS**: each `**/` compiled to its own nullable `(?:.*/)?`, so
  `('**/' × 14) + 'zzz.txt'` in a repo-supplied CODEOWNERS froze the single-threaded server. Runs of `**/` are now COLLAPSED (semantically identical) + caps on file size,
  rule count, pattern length and paths matched.
- **`github/auth.ts`**: `gh auth token` is CACHED (5-min TTL + in-flight coalescing) and has an
  async form. `getAccessToken` used the SYNC one on every request — 50–300ms of blocked event
  loop plus a forked process per request.
- **`sync/hydrate-detail.ts`**: 60s cache + in-flight map. Lean storage hydrates detail on
  demand, so every `GET /api/prs/:id` ran `PR_DETAIL_QUERY` against GitHub — a loop over ids
  drained the account's 5k points/hour.
  **A write that must be visible IMMEDIATELY has to bust that cache** —
  `invalidatePrHydration(accountId, owner, name, number)`. Deleting the cache entry alone is NOT
  enough: a fetch started *before* the write is still in the in-flight map, and the next reader
  would join it and be served pre-write text. So the invalidator also bumps a per-key **epoch**,
  and `fetchGhPrText` refuses both to cache a result whose epoch moved and to share an in-flight
  fetch that began in an older epoch.
- **`sync-manager.ts`**: per-repo manual-sync cooldown (`manualSyncCooldownMs`, 5 min forced-full
  / 30s manual) → 429 + `Retry-After` from the route, plus per-account SERIALIZATION of all
  API-triggered walks (`enqueueSyncForRepo` — later repos wait with an honest `queued` progress
  row; it replaced the old process-wide `apiSyncSlotsExhausted()` cap and its 429; see
  [docs/SYNC.md](SYNC.md) for the queue's contract).
- **`review/agent.ts`**: **`Bash` REMOVED from `WORKTREE_TOOLS` and denied outright.** A review
  reads attacker-authored text (title/description/diff/comments); with `bypassPermissions` + a
  shell that is RCE on the developer's machine via a stranger's PR. The old
  `Bash(rm *)`-style blocklist was never a boundary. Both review prompts + the AI-Fix prompt
  gained explicit **untrusted-input / prompt-injection** instructions.
- **`coding/agent.ts`**: **the AI-Fix agent followed**, and both agentic runs are now shell-free
  (AI Fix's agentic conflict resolver, which never had a shell, was removed with its
  trunk-reconciliation path). `FIX_TOOLS` lost `Bash`; `DISALLOWED_TOOLS` is
  `['Bash','NotebookEdit']`. Same input shape as a review, and WIDER on the `'comments'` seed,
  whose whole payload is comment bodies. The five `Bash(rm *)`/`Bash(git …)` prefixes it replaced
  were the same non-boundary. ⚠ The `Bash(git commit *)`/`Bash(git push *)` pair also encoded
  "the host owns the commit" — still true, and now enforced harder, but say so in prose because
  the grep no longer finds it. The fixer's build/test capability went with the shell; "Run tests"
  (2026-10-30, below) brought testing back WITHOUT it. When no check ran the SPA still says "Not
  built or tested here." beside the diff — it promises no CI (see [PLATFORM.md](PLATFORM.md) § The
  fix agent has no shell).

### Sandboxed checks — AI Fix "Run tests" (`coding/checks/`, 2026-10-30)

The fixer may run the project's OWN tests, lint and type checks. The agent still has **no shell**:
it gets ONE tool, `run_check(name)` (Claude `mcp__checks__run_check`, in-process; Codex
`mcp__workspace__run_check`, Limn's workspace MCP server), and a NAME is all it can send. Limn
decides everything else, and runs every step in an OS sandbox. A reusable module (a story build will
use it): `openCheckSession` → `agentTool()` / `verify()` / `runHook()` / `restoreGit()` / `close()`.

- **THE ALLOW-LIST IS DERIVED, NEVER TYPED** (`discover.ts`): package.json scripts named `test`,
  `test:*`, `lint`, `lint:*`, `typecheck`, `check`… (never `*:watch`, `*:fix`, `dev`, `start`…) run
  through the package manager the LOCKFILE names (corepack's `packageManager` first); Makefile
  `test`/`lint`/`check`/`typecheck` targets; pytest / tox / nox; `cargo test --offline`; `go test
  ./...` + `go vet ./...`; `gradle test --offline`; `mvn -o test`. Each is a fixed argv. The picker
  reads the same function over the PR head's manifest files (one GraphQL request,
  `github/repo-files.ts`); the run discovers AGAIN on its own worktree, and a name the head no longer
  declares is skipped. Manifest files are read only as REGULAR files (a symlinked `Makefile` or
  `.husky` is ignored).
- **THE DENY SCAN** (`deny-scan.ts`) refuses — listed with the reason, never runnable — a script
  whose text, AND every script it calls (`npm run x`, `run-s lint:*`, npm's `pre`/`post`), every
  Makefile prerequisite / sub-make / variable, and a hook's lint-staged commands, builds or starts
  containers (`docker build|run|compose up`…), pipes a download into a shell, uses sudo, deletes
  outside the tree (`rm -rf /|~|$VAR|..`), publishes, pushes or edits git config, talks to GitHub
  (`gh`), ssh/scp, touches keychains or launch agents, writes home dotfiles, or `eval`s a variable. A
  Makefile with `include` is refused (unreadable first). It is a CONSERVATIVE SECOND line: a script
  that only TALKS to a service on localhost is fine; a monorepo's per-package scripts are not read —
  the sandbox is the boundary.
- **ARGV ONLY** (`spawn.ts`): `spawn(command, args, {shell:false, detached:true})`, its own process
  group (a timeout or cancel kills the whole tree), a timeout (`AI_FIX_CHECK_TIMEOUT_MS`, 10 min;
  install 15, hook 5), output ANSI-stripped and CAPPED (24k chars, head + tail, the cut named).
- **THE SCRUBBED ENVIRONMENT** (`env.ts`) is an ALLOW-LIST (PATH, locale, TERM, a few toolchain
  homes) + `NEVER_PASSED` belt and braces: no GH/ANTHROPIC/OPENAI/CLAUDE/AWS token, no
  `SSH_AUTH_SOCK`, no `DOCKER_*`, no `LIMN_*`. HOME and TMPDIR move into the run's folder; npm reads
  no real `~/.npmrc`; git runs with no system/global config; caches point at Limn's PRIVATE cache
  (`<data dir>/check-cache`), never the reader's own.
- **THE SANDBOX** (`sandbox.ts`) — macOS `sandbox-exec` with a generated Seatbelt profile (paths
  only as `-D` PARAMETERS, never spliced into the text), Linux `bwrap`. Writes: the worktree, the
  run's `sbx/` folder (and, for the install step only, the private cache; for Cargo only its lock
  files); the worktree's `.git` FILE is read-only. Reads: everything outside the home folder and
  Limn's data folder; inside them only the worktree, the clone, the caches and the toolchain homes
  (`~/.nvm`, `~/.rustup`, PATH entries…; ⚠ never a folder DIRECTLY in the home folder through PATH —
  `~/.docker/bin` opens that bin, not `~/.docker`); `~/.cargo/credentials*`, `~/.m2/settings*.xml`,
  `~/.gradle/gradle.properties`, `~/.docker/config.json` stay dark. Network: a CHECK gets loopback only (macOS: `localhost`
  in and out, so a test reaches a database the reader started; Linux `--unshare-net`: its OWN
  loopback, so host services are NOT reachable); the INSTALL step gets the network but runs no
  repository code (`--ignore-scripts`, `--ignore-pnpmfile`, yarn `--mode=skip-build`; a Yarn
  `yarnPath`/plugins or Yarn 1 `.yarnrc` `yarn-path`, a `packageManager` that is a LINK (corepack
  would fetch it), or Maven build extensions (`.mvn/extensions.xml` or `<extensions>` in the POM) gets
  NO install; Gradle never — its build scripts are code). Unix sockets only inside the run's folder (never the Docker socket); the macOS
  keychain daemon is denied. **No sandbox ⇒ refused** with one plain sentence; only
  `LIMN_CHECKS_ALLOW_UNSANDBOXED=true` runs them bare, and the run says so.
- **DOCKER FIRST** (`docker.ts`): a check that needs Docker (compose file, testcontainers, a script
  naming docker) runs only after `docker info` answers (Limn's fixed argv, outside the sandbox);
  otherwise it is skipped with one line and the rest run. A check never gets the Docker socket, so a
  testcontainers suite cannot start containers — services must already run on localhost.
- **THE FROZEN LIST** (`spec.ts`): before the agent starts, every check's wrapped argv, cwd, env,
  timeout and cap are written to a spec file in the run's Limn-only `spec/` folder (under the data
  folder: a check can neither read nor write it). Codex's MCP server reads it ONCE at start-up; the
  path-guard hook allows `mcp__workspace__run_check` only when the run's guard roots carry
  `checks: true`. An unknown name is refused; 12 calls per run.
- **THE COMMIT HOOK** (`hooks.ts`): husky / lefthook / simple-git-hooks run INSIDE the sandbox, in a
  THROWAWAY git folder (`spec/hook-git`, objects borrowed from the clone through `alternates`, HEAD at
  the base commit) — the shared clone's config, refs and objects (which every later run and every
  push reads) are never writable. ⚠ That folder lives in Limn-only `spec/`, never the checks'
  writable `sbx/`: Limn stages into it with its OWN git, outside the sandbox, and a process a check
  left behind (a daemon escapes the process-group kill) must not get to plant a `filter.*` command
  in its config first. Only the hook's own sandboxed run may write it. The pre-commit framework is refused (it installs over the
  network). Push still commits the stored patch with `--no-verify`: the hook already ran.
- ⚠ **`restoreGit()` BEFORE EVERY GIT COMMAND OF LIMN'S IN THE WORKTREE.** A check (or the agent's
  Write) could point the worktree's `.git` file at a folder whose config sets `core.fsmonitor` — and
  Limn's own git, outside the sandbox, would run it. The sandbox makes `.git` read-only AND Limn puts
  it back byte for byte before `ls-files` / `add -A`; its own git also passes `core.fsmonitor=false`.
- Output a check leaves untracked (node_modules, coverage, target/…) stays OUT of the patch: a
  per-run `core.excludesFile` (known output names + every path that appeared during Limn's own
  install / final run). Tracked files are never excluded; the reader sees the diff before Push.

**The local clone cache (`~/.limn/clones`) — five fixes, and the standing invariant.**
The AI-Fix agent, Claude Review and now the merge-conflict resolver all work inside this cache, so
it went from a corner to a hot path and was hardened before the resolver was allowed to multiply the
clone count. **The invariant: a GitHub token never reaches disk.**

- ⚠ **TOKENS ARE NEVER WRITTEN TO `origin`** (`review/clone-hygiene.ts`). `ensureClone` used to
  clone a tokenized URL and strip it in a `.catch(() => {})`; the reuse path returned before any
  check. **Measured: 4 of 7 clones on the dev machine carried a live `gho_` token in
  `remote.origin.url`, mode 0644.** The clone now uses the PLAIN URL with a process-scoped
  `-c url.<tokenized>.insteadOf=https://github.com/`. ⚠ **POSITION IS LOAD-BEARING**: `-c` BEFORE
  the subcommand is process-scoped (passed to children via `GIT_CONFIG_PARAMETERS`, never written
  into the new repo); `git clone -c …` AFTER the subcommand is `--config` and WOULD persist it.
  `clone-manager.test.ts` asserts the flag's index is less than `argv.indexOf('clone')`, which is
  the assertion that catches someone moving it.
- **A startup repair, because clones that already carry one exist.** `assertCleanOrigin` runs on
  BOTH the fresh and the reuse path and is FAIL-CLOSED: repair, re-check, and DELETE the clone if
  the token cannot be removed — it is a rebuildable cache. ⚠ Deleting a clone does not reach the
  backups the token is already in, so the boot log says so and names `gh auth refresh`. Permissions
  are tightened to `0700` on `config.cloneDir` and its parent and `0600` on `.git/config`
  (`mkdirSync`'s `mode` applies only on create), each `chmodSync` swallowed individually.
- **`assertPushTarget` (`coding/git.ts`) validates every push target.** ⚠ **The authority is
  `git check-ref-format refs/heads/<b>`, not a regex** — plus explicit clauses for a leading `-`,
  a leading/trailing `/`, `//` and `RESERVED_REF_NAMES` (check-ref-format accepts `-evil` and
  `HEAD`), and a **case-insensitive** `protect` comparison. `pushRef` takes a `PushTarget` options
  object whose `protect` is REQUIRED, never optional, so a new call site must type `[]`
  deliberately; `pushForceWithLease` MOVED here from `merge.ts` — it is the dangerous half and it
  used to bypass everything. The refusal fires BEFORE any push is spawned. Two callers remain, both
  leasing on a PINNED sha (`coding/merge.ts` `updatePrBranchFromTrunk` on the head it cloned, and the
  conflict resolver's rebase land on the session's `expectedHeadSha`); AI Fix's `pushResolved`,
  which leased on the CURRENT remote head and so could overwrite commits pushed after the fix was
  generated, was removed with its rebase path. ⚠ `pushRef` is called with real head refs —
  `feature/#123`, `user's-branch`, `a+b`, `ünicode/x` are all valid GitHub branches — so its guard
  is `git check-ref-format`, never a tidy regex.
- **A bounded startup sweep + an age-paired LRU** (`sweepCloneCache`, awaited in `index.ts` between
  the event cleanup and `ensureLocalAccount` — the credential repair must finish before
  `bindPlatform` can start a fix that reuses a clone). Per clone: clean origin → tighten perms →
  `git worktree prune` → remove `.worktrees/` entries that are neither live nor within
  `worktreeTtlMs` → prune again → delete every `refs/pierre/conflict/*` (no job survives a restart,
  so at boot they are orphans by definition). ⚠ **BOUNDED**: `Promise.race` against
  `cloneSweepMaxMs`, log and continue — a sweep that cannot finish must not be the reason the
  server never listens. `hasActiveWorktrees` became `hasFreshWorktrees(repoDir, now)`, **identity
  first** (`liveWorktrees.has`) then mtime within the TTL, so a stale `.worktrees` entry no longer
  exempts a repo from eviction forever. Worktree paths gained `-<pid>-<seq>` and the
  `existsSync → removeWorktree` pre-clear was DELETED: it was the line that destroyed a concurrent
  run's tree.
- (`coding/safe-path.ts` — `assertSafeTargetPath` / `resolveContainedTargetPath`, the write-path
  guards for the Bot Tuning Advisor's config-PR primitive — went with the Advisor, 2026-10-26.
  Nothing else wrote repo files by path. A new feature that writes a repo-relative path into a
  worktree must bring back BOTH guards: the lexical one, and the post-checkout containment check
  that REFUSES an in-tree symlink — a committed symlink is a real directory entry, so
  `link/evil.txt` is traversal-free text that writes wherever `link` points.)

- **Account-keyed in-memory state**: `getReviewStatus`, `listActiveReviews(accountId)`,
  `requestReviewCancel(prId, accountId)` and `getFixStatus` key on prId in PROCESS-GLOBAL maps and
  verify the entry's own `accountId`, and the claude-review SSE stream checks PR ownership BEFORE
  `reply.hijack()` (the ai-fix pattern). There is one account now; the checks stay because the
  ownership rule is the query layer's everywhere else and `verify:isolation` still asserts it.
- **Slack webhook SSRF (`platform/slack/`)**: `normalizeSlackWebhookUrl` is an ALLOWLIST
  (`https://hooks.slack.com/services/…` only, exact host — not `endsWith`), enforced at BOTH the
  storage and the `fetch` sink, `redirect: 'error'`, and the response body no longer comes back
  in the error (it was a read primitive against whatever network the server sits on).
  ⚠ **There are now N webhooks per account**, one per configured workspace
  (`workspace_slack_targets`, platform migration 0030) — so the storage-side half runs in `slack/targets.ts`'s
  `writeTarget`, and **any further write path must route through the same normaliser**: a write
  that skips it bypasses the control at storage time, leaving only the sink check standing.
  A bad URL refuses the write outright and changes NOTHING — not even the fields beside it, since
  the URL is validated before the upsert is built — and each of the six classic bypasses is pinned
  in `platform/test/slack-targets.test.ts`.
  ⚠ **The write path is now SINGLE-WORKSPACE** (`PUT /api/pro/slack/target?workspace=<id>`; the
  plural `/targets` and its whole-selection body are DELETED). The workspace id therefore arrives
  in a QUERY resolved by `resolveRequestWorkspaceId` rather than in a request BODY as a list — one
  fewer place a client-supplied id reaches a write — with the named composite FK
  `workspace_slack_targets_workspace_account_fk` still the structural backstop beneath it.
- **Slack digest text is escaped and verbatim.** `&`, `<` and `>` are escaped in model
  output, PR titles and the workspace name (all attacker- or user-influenced), so none of them can
  forge a link or write `<!channel>`. Every mrkdwn object is `verbatim: true`, so Slack does not
  auto-link bare URLs or parse `@here`/`@channel`/`#channel` in that text. Every `href` in the
  message is one that `slack/links.ts` built from `appWebUrl` plus integer ids; model-emitted URLs
  never survive as links.
- **The Slack webhook URL is stored PLAINTEXT** (platform migration 0030's header carries the
  argument). It is write-only capability to one channel the owner chose, granting no read of
  Slack — different in KIND from a tracker token, which reads the team's whole tracker. Sealing
  was rejected because `ENCRYPTION_KEY` is optional, so a sealed column would hold two storage
  formats for one field, and a key rotation would silently break every delivery. The mitigations
  are enforced in code and must stay: **never returned by any route** (`configured` only),
  **never logged** (the cron and the test route log account + workspace ids), and every write
  through the allowlist.
- **The per-workspace tracker token (`workspace_trackers.auth_token` — it was
  `pro_workspace_settings.jira_token`, platform migration 0035, and was MOVED in its stored form) IS
  SEALED when it can be, unlike the Slack webhook** — different in KIND: it READS the team's whole tracker.
  Core seals it itself (`tracker/secret.ts` over `auth/crypto.ts` AES-256-GCM, wired in
  `tracker/runtime.ts`), whenever `ENCRYPTION_KEY` is a valid 32-byte key (only if the operator set
  one). Stored as `sealed:v1:<iv:tag:ct>`, or
  `plain:<token>` on a local install with no key (the same trust as that machine's `gh` token and
  SQLite file). This ACCEPTS the two-format cost the webhook note rejected, because a read
  credential is worth it and the prefix makes both forms readable: a `sealed:` value the host cannot
  open (key removed or rotated) reads as UNREADABLE, is never sent, and the SPA says "save it again". **Never returned by any route** (`hasToken` only), **never
  logged** (the tracker routes and worker log account, workspace and an error CODE — not the error
  object), and **not in the account export** (`db/export-account.ts` exports the tracker row with
  the token reduced to `hasToken`; pinned in `db/erase-account.test.ts`). Changing the tracker's
  base URL to another SITE REMOVES the saved token, so it cannot be redirected to a new site.
- **The Linear personal API key** (CORE, phase 3 — docs/TRACKERS.md § Linear) lives in the SAME
  slot under the SAME rules: sealed, write-only (`hasToken`), never logged, never exported, removed
  by `clearToken`. Its "site" is the Linear WORKSPACE, not the host: every Linear workspace is on
  linear.app, so moving the URL from `linear.app/acme` to `linear.app/other` removes it. There is
  **no SSRF surface**: the workspace URL is an identity, never fetched, and every call goes to the
  FIXED `https://api.linear.app/graphql` — still through the tracker transport (no redirects, so the
  key is never forwarded; 10 s timeout; 5 MB cap). The key is sent
  as `Authorization: <key>` (never `Bearer`). The PUT refuses a value not shaped like a personal key
  (`lin_api_…`), so a GitHub or Jira token pasted into the wrong box is never stored or sent to
  Linear. A key belonging to another Linear workspace than the saved URL is refused on read
  (`bad_url`, workspace backoff) rather than storing that workspace's tickets under this one's
  idents. Linear's rate limits are pre-empted from its `x-ratelimit-*` headers per key (in memory)
  and a `RATELIMITED` answer is a quiet 5-minute workspace backoff. The connection check
  (`GET …/tracker/linear-check`) is on `search` in `tierFor`. A personal key reads everything
  that user can see in Linear — the same scope a Jira API token has.
- **Notion (`tracker/notion/`)** — ONE fixed host, `https://api.notion.com/v1`, through the same
  transport (no redirects, 10 s, 5 MB); the database URL in Settings is an identity, never fetched.
  The internal integration token rides the same sealed write-only slot, sent as `Bearer`; the PUT
  refuses a value not shaped `ntn_…` / `secret_…`. It reads only what the workspace's owner SHARED
  with the integration. READ-ONLY: every call is a GET or a database query; Limn never writes to
  Notion. Calls with one token are spaced ≈ 3 a second and a 429's `Retry-After` is honoured without
  calling (in memory). The mapping read (`GET …/tracker/notion-schema`) is on `search` in `tierFor`.
  Page text, comments and property values are UNTRUSTED like every ticket's: rich-text links are kept
  only when https.
- **Jira SSRF (`tracker/jira/fetch.ts`) — the base URL is customer-typed, so every Jira call is a
  server-side request to a place they chose.** ONE helper, `jiraGetJson`, makes every call: GET
  only (the ONE exception is `jiraPostJson`, the Jira status transition the reader picks —
  docs/TRACKERS.md § The status change — under every rule below), 10s timeout, 5 MB body cap, JSON only, and **NO REDIRECTS** — any 3xx is an error, so the
  Authorization header is never forwarded to a host nobody chose. http and LAN hosts are
  allowed (on-prem Jira; the operator is the only caller). The STRICT policy (`{ cloud: true }`
  — https only, and the address guard `guardedLookup`: loopback, RFC1918, CGNAT, link-local incl.
  169.254.169.254, unique-local, multicast, reserved, unspecified and v4-mapped/NAT64 forms, an IP
  literal up front and a NAME **at connect time through the socket's own `lookup`**, so there is no
  second resolution for DNS rebinding to exploit) is what SonarCloud's fixed host is called with. A failure answers `502` with a sentence we wrote — never Jira's body. The ticket route
  additionally refuses any key the PR's own detection did not find, so the saved token cannot be
  used as a general Jira reader. Pinned in `apps/backend/src/tracker/jira/fetch.test.ts` (real
  sockets) and `tracker/routes.test.ts`. Rate tiers: every route that can reach the customer's Jira
  (the ticket GET/refresh/ac-field, the connection check, the tracker PUT and `POST
  /api/ticket-links`, whose kicks spend it) is on `search`, by exact path in `tierFor`.
- **Reference-docs Notion pages (`reference-docs/wiki/notion.ts`) — ONE fixed host.** Every request goes to
  `api.notion.com` only (asserted after the URL check) through the tracker's guarded transport: https,
  public addresses at connect time, NO redirects, 15 s, 8 MB, JSON only, `Bearer` + a PINNED
  `Notion-Version`. One lane per token, shared with the Notion tracker (≈ 3 requests a second), and a bounded 429 wait. The token is
  shape-checked (`NOTION_TOKEN_RE`), SEALED and write-only (`workspace_wiki_credentials`, provider
  `notion`); the export carries `hasToken` only. Everything Notion answers is a stranger's: block text is
  escaped so it cannot become markdown syntax or a figure marker; only http(s)/mailto targets link.
  Tiers: as Confluence's routes (the same routes).
- **Figure images (`reference-docs/figure-fetch.ts`, `figures.ts`, `figure-describer.ts`; § Figures in
  REFERENCE-DOCS.md).** An image download carries NO credential (a Notion file address and Atlassian's
  media address are signed in their own query; an external image is a stranger's) and goes through
  `fetchPage` — PUBLIC addresses only for a wiki's files, the page's own policy for a web page's images —
  under a 5 MB cap and ≤ 60 downloads a build. Confluence's attachment download is the one request with
  the credential; its redirect to the media service is followed ONCE, WITHOUT it. Only PNG / JPEG / GIF /
  WebP headers are kept (`imageInfo`). ⚠ The image is UNTRUSTED INPUT to a Claude vision call: a strict
  system prompt (describe, never act on text in the image), tool-less, one turn, connectors isolated; the
  answer is cleaned to one bracket-free line and labelled `[Figure (described by AI): …]`, and is NEVER
  quote grounding (`withoutFigureDescriptions`). Codex never sees an image (`LOCKED_SETTINGS` unchanged).
  An automatic description asks the spend budget first. The description cache is keyed by (account,
  image hash) and read only for images the document holds.
- **Reference-docs Confluence pages (`reference-docs/wiki/confluence.ts`) — a site the reader typed,
  read with a saved token.** Every request goes through the tracker's transport under the STRICT policy
  (`{ cloud: true }`: https only, public addresses only, judged at connect time), no redirects (the
  Basic credential is never forwarded), 15 s, 8 MB, JSON only; a listing's `next` link is followed only
  on the same site and API path. The token is SEALED and write-only (`workspace_wiki_credentials`, like a
  tracker token); a page on the workspace's Jira host reuses the Jira credential, never another host's.
  Errors are codes turned into our own sentences. Tiers: `POST /api/docs/wiki` and `/api/docs/:id/refresh`
  are `search` + `ai` + `ai_hourly`, the connection check `search` + `read`
  ([REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Wiki sources).
- **Reference-docs web pages (`reference-docs/url-fetch.ts`) — a page address the
  reader typed, fetched by the docs build.** http/https only, no credentials in the URL,
  **never loopback, link-local, multicast, reserved or `localhost`** (Limn's own unauthenticated
  API), while private networks and intranet names ARE allowed (`privateNetwork: true` — the reader's
  company wiki is the point); an IP literal up front, a name at connect time through the tracker's
  `guardedLookup` with the policy's predicate, redirects followed ONLY on the same host (≤ 3, never https → http, each
  re-vetted), 20s per exchange, 25 MB while reading. Pinned in `url-fetch.test.ts`. A "Follow links"
  crawl (`crawl.ts`) sends EVERY hop, robots.txt included, through the same `fetchPage`, and adds a
  same-host rule (exact host + port), ≤ 25 pages, 2 MB per linked page and a visited set; anchors and
  page text reach the link-ranking model only inside a nonce fence (REFERENCE-DOCS.md § Following links). The upload route
  is the ONE route that raises `bodyLimit` (25 MB + 1 KiB, an `application/octet-stream` buffer
  parser); the file's kind is sniffed from its bytes. The docs agents deny Bash, run under the path
  guard, and the PDF build's Write/Edit are confined to `staging/sections/*.md` by a second hook
  ([REFERENCE-DOCS.md](REFERENCE-DOCS.md)).
- **`resolution-check` fan-out (platform)**: `MAX_TARGETS_PER_BATCH` 50 + per-account in-flight set
  + 30s interval + abort wiring on the JSON twin. One billed LLM call per thread, uncapped, on an
  app built for bot-flooded PRs. (The route itself was REMOVED 2026-10-18.)
- **SQLite file perms** 0600 + dir 0700 (incl. the `-wal`/`-shm` siblings).
- **CI** runs a **blocking** `pnpm audit --audit-level high --prod`; all 8 highs that existed
  were cleared (see Dependency posture). The site image's `Dockerfile` runs as `USER node`.
- **`.gitignore`** is `.env*` + `!*.example` — it was `.env` + `.env.local` only.

**Privacy.** Limn phones nothing home: no analytics in the SPA (GA and its cookie banner live
only on the website, `apps/landing`, consent-gated), and **the brand font is SELF-HOSTED**
(`src/fonts/*.woff2`, relative `url()` so Vite base-prefixes it to `/app/`) — the Google Fonts
`<link>` leaked every viewer's IP to Google and forced an inline `onload` handler that would
have needed `script-src 'unsafe-inline'`. `GET /api/me/export` (`db/export-account.ts` —
explicit column lists; no secret is ever in the output) is the portability half; erasure is
deleting the local database file. `db/erase-account.ts` (`eraseAccountData`, `deleteRepo` per
repo, then the enumerated account-level tables, then the platform's `registerAccountErasure`
handler, `eraseProByAccountId`) has no route any more but stays the checklist the retention and
delete paths are measured against.
**Landmine: `accountScopedTables()` in `erase-account.ts` is a CHECKLIST the test iterates** — a
new `accountId`-bearing table that isn't added there fails `erase-account.test.ts` rather than
silently surviving a deletion the user was told was complete. (It caught `teamRepos` once already.)
The Workspace refactor took **FOUR** entries out (`repoReviewers`, `accountReviewers`, `teams`,
`teamRepos`) and put **THREE** in (`workspaces`, `workspaceRepos`, `workspaceReviewers`) — the net
drop of one is correct and intended (two bot tables collapsed into one), and it is spelled out here
because an off-by-one in a checklist is exactly how a table gets missed. ⚠ **`workspaceRepos`
carries its own `accountId`, not only `workspaceId`/`repoId`**, so it belongs on the list in its own
right rather than as a cascade dependent. `eraseAccountData` deletes child-before-parent
(`workspaceReviewers` → `workspaceRepos` → `workspaces`) inside one transaction: SQLite enforces FKs
only under `foreign_keys=ON`, so relying on the cascades alone would depend on a pragma. `export-account.ts` was a
RENAME, not an addition — both bot collections became the single `workspaceReviewers`, and `teams`
became `workspaces` with each row carrying its `repoIds`.

**Dependency posture (2026-07-26).** The dev tree went from `8 high / 10 moderate / 1 low` to
`1 moderate / 1 low`, and **the PUBLISHED npm package audits clean — 0 vulnerabilities**. CI now
BLOCKS on high. (The two are different trees: root `pnpm.overrides` do NOT travel with the
published manifest, so the release was audited separately as an `npx` user would receive it.) Two of the fixes were live vulnerabilities in
code this app actually runs, so they are worth knowing:
- **`@fastify/static` 9.1.3 → ^10.1.2** — route-guard bypass via path traversal + a
  non-canonical-path authorization bypass. This app serves TWO static roots. v10 needed no code
  change; verified against the packaged release (SPA index, deep links, hashed assets, the
  self-hosted font, `/` → 302, JSON 404 on unknown `/api`, and five traversal payloads — no leak).
- **`drizzle-orm` 0.38.4 → ^0.45.2** — SQL injection via improperly escaped SQL identifiers, in
  the whole query layer. Also bumped `drizzle-kit` → ^0.31.10, and `fastify` → ^5.10.0.
  
- Transitives no direct bump reaches are pinned in root `pnpm.overrides`: `fast-uri` ^3.1.4,
  `find-my-way` ^9.7.0, `hono` ^4.12.32, `@hono/node-server` ^2.0.12, `shell-quote` ^1.9.0
  (arrived with drizzle 0.45's `gel`), and `brace-expansion@>=3.0.0 <5.0.7` → ^5.0.8 — note the
  **scoped selector**: a blanket pin would drag 1.x/2.x consumers onto a different major.
- **`node-cron` 3.0.3 → ^4.6.0** cleared the last advisory from the published package (v3
  pinned a vulnerable `uuid`). `@types/node-cron` was DROPPED — v4 ships its own typings and the
  DefinitelyTyped stub is for v3. Only four API surfaces are used (`schedule`, `validate`,
  `ScheduledTask`, `task.stop()`) and all survive; verified at runtime that `schedule()` still
  AUTO-STARTS without an explicit `.start()` (the sync loop depends on it) and that `stop()`
  halts it.
- **Knowingly left below the gate in the DEV tree only**, neither shipped nor reachable: `uuid`
  (moderate — via `vis-data`, and the bug needs v3/v5/v6 with a `buf` argument; vis-data calls v4
  with none) and `body-parser` (low — inside express inside the MCP SDK, an AI dep that ships in
  no release artifact).
- Fastify 5.10 deprecated the top-level `disableRequestLogging` (FSTDEP023); it moved to
  `logController: new LogController({...})`. Same class of fix as `routerOptions.maxParamLength`
  — a boot-time deprecation warning is noise in the terminal of every packaged-CLI user.

**Tests:** `api/plugins/security.test.ts` (15), `api/plugins/rate-limit.test.ts` (15),
`db/erase-account.test.ts` (8), a codeowners ReDoS regression, and
`platform/test/slack-webhook-url.test.ts`.

**One suite exists that CI does not run — a known gap, needing a devDependency + script
decision (it would touch the root lockfile). The platform's tests (`apps/backend/src/platform/test/`)
used to be the second; folded into the backend, they now run with `pnpm test`, including the
cross-account isolation suite.**
- `apps/frontend/test/` — **9 files / 127 tests**, same arrangement (`apps/frontend/vitest.config.ts`,
  `include` pinned to `test/**` so vitest can't collect the Playwright `e2e/*.spec.ts` and fail).
  Kept OUTSIDE `src/` so `pnpm typecheck` never tries to resolve the uninstalled vitest types.
  Where the pure logic extracted from components is pinned: **`workspaceScope.test.ts`** (persistence of `workspaceId` — that all
  five legacy `teamScope` shapes are DISCARDED not coerced, that it is absent from
  `pickFilterBarState` so "Clear filters" can't teleport you into Default, and that the wire emits
  `?workspace=` always-once-resolved and `repoIds` **including when empty**),
  `botReviewerQueryKey.test.ts` (the three-segment key, and that a `repoIds`-narrowed listing never
  shares a slot with the workspace-wide one `useBotColors` reads), `botReviewers.test.ts`,
  `botCost.test.ts`, `resolvableBotThreads.test.ts` and `checksRow.test.ts`; `prRef.test.ts`
  predates them all. (`teamScope.test.ts` was DELETED with the canonicalisers it pinned.)
  **`workspaceOpenPrsScope.test.ts`** pins the Timeline-only-picker rule from the client side:
  of the three open-PR search builders, only `buildOpenPrsSearch` honours `filters.repoIds`
  (Timeline); `workspaceOpenPrsSearch` and `scopedOpenPrsSearch` (the drill-down's builder,
  which takes an EXPLICIT repo list and stays byte-identical to `workspaceOpenPrsSearch` when
  unscoped) both ignore it (Activity). Both failure modes are silent: pick up `repoIds` on the Activity side and a list
  comes back short, scoped by a control that is not on screen; let the two strings diverge in the
  common case and they stop sharing a React Query cache entry (the key IS the string), so the same
  list is fetched twice forever with both copies rendering correctly.
  ⚠ **Known hole, flagged in that file's own header:** the legacy `?team=` URL rule lives in
  `readWorkspaceFromUrl`/`readFromUrl` in `hooks/useUrlState.ts`, neither of which is exported, so
  re-implementing it in the test would pin a copy rather than the code — it is unit-tested nowhere.

The backend suite itself is **55 files / 534 tests** and DOES run in CI. Dropping the "watched"
concept added **`db/my-turn-new-prs.test.ts`**, which pins My Turn's clock: an open, non-draft PR by
a non-bot human other than you enters the "New PRs" section iff `openedAt >= repos.createdAt` FOR
ITS OWN REPO. It seeds two repos added eight days apart and — the case a lax fixture misses — a PR
in the later repo that clears the EARLIER repo's cutoff, so a single global cutoff fails it. Three
mutations were run against `getAddedRepoActionablePrIds` to prove the assertions bite: dropping the
comparison (caught by the before-cutoff PR), replacing the per-repo lookup with a global minimum
(caught by that cross-repo PR), and `>=` → `>` (caught by the exactly-at-cutoff PR). The
you-authored-it / bot-authored / draft exclusions are seeded as controls in the same loop. The
Workspace refactor renamed
`db/team-comparison.test.ts` → `db/workspace-comparison.test.ts` (dropping the `TeamScope`
wire-form cases — there are no wire forms — and keeping the two-way account scoping with a seeded
second account so the negative check isn't vacuous) and rewrote `db/bot-reviewer-grains.test.ts` →
**`db/workspace-reviewer.test.ts`**, which pins the same six directions in PAIRS now that there is
no table boundary to do it: a judgement patch leaves identity + price byte-identical and vice versa,
a cost write leaves everything else alone, a full `classifyReviewer` pass honours each provenance
flag independently, the identity RESET actually re-derives (`kind` non-null again), and **a
`setReviewerCost` in workspace A leaves that actor's rows in B and C byte-identical** — including a
row already holding a *different* price and a row whose price is still NULL. The three team-keyed
bot suites (`bot-cost-per-team`, `bot-vendor-prs-team`, `detected-reviewers-scope`) were deleted
with the grain they tested. `vitest.config.ts` raises `hookTimeout` to 30s because a dozen suites
migrate a throwaway SQLite DB in `beforeAll` and lost the 10s default under parallel load — failures
that look exactly like real regressions (a different subset each run, always in a hook, never an
assertion).


