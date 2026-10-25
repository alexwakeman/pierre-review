# Plan: Codex (OpenAI) as a second AI provider

Status: PLAN, not built. **Phase 0 (the spike) ran 2026-10-25 — read [CODEX-SPIKE.md](CODEX-SPIKE.md) first: its "Plan changes" section SUPERSEDES the matching parts of §§ 2, 3, 6, 7 and 8 below** (strict-config, the extra locked keys, the `/tmp` write leak, silent untrusted hooks, MCP approval mode, CLI not SDK, app-server rate limits in whole percent, models).

**Phase 1 (the seam) built 2026-10-25** (branch `codex/phase1-seam`): `apps/backend/src/ai/provider.ts`
(the interface, the registry — `LIMN_AI_PROVIDER` = `claude` | `auto`, `codex` answers "not available
yet"), `ai/providers/claude.ts` (today's Agent SDK code moved behind `runAgent` / `complete` /
`detect` and the usage reading; the 12 runners, `cheapComplete` and so `ctx.llm` go through it),
`ai/result-schemas.ts` (§ 3.4: one strict JSON Schema per result, derived from the same zod shape the
Claude tool uses; `strictAnswerToToolArgs` maps a strict answer back to the tool's arguments), and
§ 8.1's ledger column (`ai_usage.provider` + `share_pct`, sqlite `0127`; the budget's folds read the
active provider's rows and reading). Where the spec still carries Claude-only knobs they sit under
`spec.claude` (SDK tool names, extra hooks, specialist agents), and `onMessage` receives Agent SDK
messages: Phase 3 ports each runner off them. Models are ROLES (`deep`/`standard`/`fast`) with the
exact id every call site used passed as an explicit override, so no model moved.

**Phase 2(a) (the runner) built 2026-10-25** (branch `codex/p2-runner`): `ai/codex/config.ts` (the
locked `codex exec` argv; ⚠ `projects` is ONE inline table because Codex splits a `-c` key on every
dot, quoted or not — a worktree path with a dot failed `--strict-config`), `ai/codex/events.ts` (the
JSONL fold: progress, final answer, per-turn usage deltas, stderr-only refusals), `ai/codex/run.ts`
(spawn, stdin prompt, abort/timeout → SIGTERM → SIGKILL; a stopped run has null tokens) and
`ai/providers/codex.ts` (`complete()` runs on Codex under `LIMN_AI_PROVIDER=codex`; `runAgent` answers
"not available yet" for every kind outside `CODEX_AGENT_KINDS`, EMPTY until Phase 3; one validation
retry via `exec resume`; writes read from git; a write run refuses without a trusted hook). API-key
prices are TODO (`CODEX_PRICES_PER_MTOK`, US$ 0 until filled). The pre-flight still keeps Codex from
users.

**Phase 2 integrated 2026-10-25** (branch `codex/p2-integrated`: the three streams merged).
- ONE `CodexHookConfig` (`ai/codex/types.ts`, stream B's shape): `override` goes on the argv VERBATIM
  (`config.ts hookConfig` never re-serialises it — the trust hash and `hooks/list` read that text),
  `trustKey` + `trustedHash` feed `ensureCodexHomeConfig`, `env` (`LIMN_CODEX_GUARD`) is merged LAST
  into the `codex exec` environment.
- EVERY agent run (read-only too) writes the hook's trust entry into Limn's own home, then refuses
  unless `verifyHookTrusted` says Codex will run it and it denies a canary. No `--ignore-user-config`:
  Limn writes that home's whole `config.toml`.
- The child's environment: `codexRunEnv` decides the credential, `codexChildEnv` cuts it to the
  minimum, `hook.env` last. `credentialRoute`/`detect`/`usage` are stream C's (`resolveCodexCredential`,
  `detectCodex`, `codexUsageSource`).
- Availability: `LIMN_AI_PROVIDER=codex` runs `complete()` on Codex; every agent kind answers "not
  available yet" (`CODEX_AGENT_KINDS` empty). `CODEX_RUNNABLE` = every kind ported (false), so `auto`
  never picks Codex, the pre-flight answers 'none' and `/api/me` reports `providers.codex.available:
  false`; `detect()` gives the same answer. A cancelled Codex run's $0 row with NULL tokens is kept.
- Live (`ai/codex/live.test.ts`, Limn's own home ONLY — the per-stream live tests that copied
  `~/.codex/auth.json` were removed): the hash agrees with `hooks/list`, Limn's config passes
  `--strict-config`, `complete()` answers in a schema, and an unchecked read-only run read through the
  MCP server while the trusted hook refused `../outside/secret.env`.

**Phase 2 review fixes 2026-10-25** (branch `codex/p2-fixed`):
- The final answer is zod-PARSED against the result tool's shape before its handler (as Claude's MCP
  layer does); a shape issue is the one retry's reason. Any throw after the first spawn is a run
  FAILURE: usage recorded, writes verified, `CodexRunError.filesChanged` set.
- Reasoning tokens are a SUBSET of output tokens: never added. A cheap completion Codex answered is
  recorded as Codex (its model, its own US$) — `review/cheap-usage.ts`, the platform `LlmClient`.
- The run is its own process group; every stop signals `-pid` (MCP server, hook and tools included).
- Session files ("rollouts") are deleted when a run settles, swept after a day, erased with the account
  (`ai/codex/rollouts.ts`). Codex's own sqlite copy is handled since the second round (below).
- The hook's matcher is `.*` and the rule an ALLOW-list (write tools and `mcp__workspace__*`
  path-checked, `update_plan`; everything else denied). Patch headers count only in header position.
- The share's account tokens carry the SPAN they cover (`AiAccountTokenSpan`) and Limn's ledger is
  counted over the same span; a start sample older than 15 minutes is not exact; no account count is
  an UNKNOWN share (never blocks); a share with no live reset is never over.
- Codex is looked up inside `<runtimeDir>/node_modules` only; a sign-in cancelled while starting
  stays cancelled.

**Phase 2 review fixes, round 2 (2026-10-25)** (branch `codex/p2-fix2`):
- `complete()` runs under the SAME trusted path-guard hook as an agent run, with EMPTY read and write
  roots (every tool but `update_plan` denied), and refuses unless `verifyHookTrusted` proves Codex will
  run it. More locked `-c` keys, each accepted by the 0.164 CLI under `--strict-config` (live test 2b):
  `features.image_generation`, `features.goals`, `features.apps` (connectors, `codex_apps`),
  `features.plugins`, `features.remote_plugin`, `features.tool_suggest`,
  `features.skill_mcp_dependency_install`, `features.memories`, `memories.generate_memories`,
  `memories.use_memories` — all `false`.
- The OPENAI_API_KEY route is REFUSED ("Codex with an OpenAI API key is not available yet — sign in
  with ChatGPT") in `complete()`, `runAgent`, `detect()` and `/api/me` (`auth: 'none'`, not available)
  until `CODEX_PRICES_PER_MTOK` holds real prices: unpriced, it recorded US$ 0 and no US$ cap tripped.
- A Limn killed by SIGINT/SIGHUP/SIGTERM (no 'exit' event) SIGKILLs every live Codex group first, then
  re-raises the signal when nobody else listens for it (`ai/codex/run.ts`).
- Codex 0.164 keeps a second copy of every thread in sqlite in Limn's home. A settled run's thread is
  deleted through Codex's own app-server `thread/delete` (its `threads` row, history rows and rollout),
  and its `logs` rows (which no API reaches) by `thread_id` with better-sqlite3; threads and log rows
  older than a day are swept once per process (`ai/codex/threads.ts`). Erasure deletes the sqlite
  files themselves (`state_`, `thread_history_`, `logs_`, `memories_`, `goals_`, `queue_` + -wal/-shm),
  never auth.json, config.toml or installation_id.
- Every Codex-related process (the app-server, a sign-in, the hook trust probe and canary) gets the
  run's environment ALLOW-LIST (`config.ts codexBaseEnv`), never Limn's whole environment.
- "Set up AI" stages Codex APART from Claude: a Claude-only install keeps (moves) the old Codex and
  never re-downloads it; a failed Codex download is recorded as Codex's failure alone and never fails
  Claude's install.
- The token-weighted share counts Limn's ledger over EXACTLY the account count's span — its start and
  its END (`AiAccountTokenSpan.toMs`: the newest sample, or the last day bucket's end) — and the ledger
  read reaches back to the earliest span start (`ledgerSinceMs`).
- A validation retry whose usage is unknown keeps the first turn's tokens. A missing Codex install is a
  `CodexNotInstalledError`, an `AiRuntimeMissingError`, so a cheap pass stops. A new sign-in never joins
  a start a cancel overtook.

**Phase 2 review fixes, round 3 (2026-10-25)** (branch `codex/p2-fix3`):
- THE WHOLE LOCKDOWN lives in Limn's `config.toml` (one list, `config.ts LOCKED_SETTINGS`, + the new
  `features.daemon_auto_start=false`), so every process in Limn's home inherits it — the app-server
  for cleanup, sweep, readings and sign-in, and the hook trust probe — and the same pairs still ride
  every `codex exec` AND app-server start with `-c` (the trust probe now runs `--strict-config` too).
  Measured on 0.164: a bare app-server fetched the remote plugin catalog (`ps/plugins/list`) and
  synced remote plugins into `plugins/`; with the lockdown, no plugin catalog fetch and no plugin
  sync. ⚠ CORRECTED in round 4: the lockdown did NOT stop all traffic — every app-server still
  refreshed the Codex MODEL LIST online (an authenticated GET to chatgpt.com) and still runs the idle
  remote-control loop.
- ⚠ REMOTE CONTROL CANNOT BE SWITCHED OFF BY CONFIG in 0.164: `features.remote_control` is a REMOVED
  flag, `allow_remote_control` is read only from `/etc/codex/requirements.toml` or a managed profile
  (never `CODEX_HOME`), `remoteControl/disable` changes nothing persisted, and the undocumented
  `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED` did not stop it. Every app-server still logs
  "remote control websocket loop started … initial_desired_state=Unknown" and "starting … connection
  cycle … current_status=Disabled" — but its status stays `disabled`, nothing enrols, and no socket is
  held. Limn keeps app-server starts few instead (below).
- Usage is RECORDED FIRST; a settled run's thread is then queued (`threads.ts`) on a per-home serial
  queue drained in the background: ONE app-server per drain for every pending id (and the sweep, when
  due). A refused `thread/delete` keeps its id and rollout for the next drain (≤ 3 attempts). The
  sweep re-arms every 6 h (a quarter of its one-day age) instead of once per process.
- `auto` counts Codex ready only on a ChatGPT sign-in (`route === 'login'`); `limn ai status` prints the
  API-key refusal sentence. A missing Codex install names `limn ai install codex` in the docs crawl and
  the sprint "Ask" (they printed Claude's remedy).
- Account erasure also removes `plugins/` and `cache/codex_apps_*` (written before the lockdown).

**Phase 2 review fixes, round 4 (2026-10-25)** (branch `codex/p2-fix4`):
- FAIL CLOSED ON THE SIGN-IN KIND. Before the first `account/read` (boot, just after a sign-in or out,
  or while probes fail) the ladder reads `auth.json`'s NON-SECRET `auth_mode` (and only whether its
  key field is filled in): `apikey` (or no mode and a key) is the refused key rung, `chatgpt` with no
  key is the sign-in, anything else is `unconfirmed`. Only a sign-in KNOWN to be ChatGPT runs
  (`codexCredentialRunnable`) — in `complete()`/`runAgent`, `auto`, `detect()`, `/api/me` and `limn ai
  status`. A run on an `unconfirmed` sign-in waits for ONE fresh probe (forced at most every 15 s) and
  refuses ("Limn could not check the Codex sign-in yet — try again in a moment") when it is still not
  known. Before this, a key stored in Limn's home counted as the ChatGPT route and ran at US$ 0.
- `LIMN_AI_USE_API_KEY=true` (shared with Claude) no longer pushes a ChatGPT sign-in onto the refused
  key route: while that route is refused, the Codex ladder consults the sign-in first.
- A run's ROLLOUT FILE goes in the first drain whatever `thread/delete` answers. Measured on 0.164:
  `thread/delete` does not need the file (with the rollout gone it still deleted the `threads` row and
  the history rows), and a thread already gone answers "no rollout found for thread id …", which counts
  as done. Only the id stays pending; an unref'd timer retries after 1, 5 and 15 minutes (4 attempts in
  all, then the day-old sweep). The sweep is armed AT BOOT when `~/.limn/codex` exists.
- NO ONLINE MODEL REFRESH FROM AN APP-SERVER. Measured on 0.164 in Limn's own home (no model run): an
  app-server started with the full lockdown moved `models_cache.json`'s `fetched_at` (19:10 → 19:41) on
  one `account/read`; started with `model_catalog_json` it did not. `features.remote_models` is a
  removed flag. So every app-server Limn starts (probe, cleanup and sweep, sign-in, hook trust probe)
  gets `-c model_catalog_json=<home>/limn-app-server-models.json`, a one-model STUB (hidden, not in
  the API, never run — Codex refuses an empty catalog). It is NOT in `LOCKED_SETTINGS`: a `codex exec`
  run needs the real catalog, so a run still refreshes the model list online, on a run the reader
  started. Live test 2d checks the key under `--strict-config`.
- ⚠ The idle REMOTE-CONTROL LOOP still starts in every app-server (round 3: no config switches it off
  in 0.164). Limn starts as few as it can: one per cleanup drain, the probe at most every 5 minutes,
  and a drain whose app-server is up anyway takes a DUE probe's reads on it (`shareCodexProbe`).

**Phase 2 review fixes, round 5 (2026-10-25)** (branch `codex/p2-fix5`):
- CODEX ITSELF REFUSES A STORED KEY. After the first `account/read` the ladder trusts the cache over
  `auth.json`, so a key stored by hand in Limn's home since the last probe rode the cached "ChatGPT"
  and ran at US$ 0. `forced_login_method = "chatgpt"` is now in `LOCKED_SETTINGS` (config.toml AND
  `-c` on every exec and app-server) while the key route is refused. Measured on 0.164 in scratch
  homes with a DUMMY stored key: without it `codex exec` sent the key (a 401 "Incorrect API key" from
  api.openai.com); with it — in config.toml only, `-c` only, or both — exec stops before any request
  ("ChatGPT login is required, but an API key is currently being used. Logging out.") and ⚠ DELETES
  that auth.json; `CODEX_API_KEY` in the environment is refused the same way; an app-server's
  `account/read` answers `account: null` (signed out). Live: the ChatGPT sign-in in `~/.limn/codex`
  still runs (live test 3, one gpt-6-luna run) and 2b accepts the key under `--strict-config`.
- The run path ALSO compares `auth.json`'s kind with the cache before every run
  (`codexAuthFileAgreesWithCache`): auth.json gone while cached signed in, a known kind different from
  the cached type, or a ChatGPT auth.json while cached signed out ⇒ `recheckCodexAccount` (forget the
  account, one fresh probe, forced at most every 15 s); still disagreeing ⇒ refused as not checked.
- PROBE GENERATIONS. `invalidateCodexState` (sign-in / sign-out) bumps a generation and drops the
  in-flight probe, so the forced probe is never a stale read from a process started before the change
  (via `kickCodexProbe` or `shareCodexProbe`); a probe's result from an older generation is ignored,
  and it clears `inFlight` only while that is still its own promise.

**Phase 3 foundation built 2026-10-25** (branch `codex/p3-foundation`, before the four porting streams):
- THE NEUTRAL RUN STREAM. `spec.onProgress` carries, from BOTH providers, a `step` per model step
  (worded activity lines, the step's text, the run's live de-duplicated tokens) and the run's `outcome`
  (subtype, final text on success, US$, turns, whole-run tokens; also `AgentRunResult.outcome`, which
  replaced the raw `result`). Claude derives them inside `providers/claude.ts` exactly as the runners
  did (the activity labellers MOVED to `providers/claude-activity.ts`; `spec.activity: 'fix'` picks the
  fixer's words; the specialist prefix is kept for the whole run on `kind: 'review'` only). Codex derives
  them from `ai/codex/events.ts` `stepFromEvent` (+ `codexTokensAsAgentTokens`) and emits its outcome
  before it returns or throws. EVERY runner reads only the neutral stream now. The ONE Claude-only
  escape hatch is `spec.claude.onMessage` (raw SDK messages, before their step), used by the docs build
  alone, for the PDF page a Claude `Read` reached.
- THE PRE-FLIGHT IS PER KIND. `detectClaudeAuth(kind?)`, `ctx.llm.detectAuth(kind?)` and
  `agenticRunReady(ctx, kind)`: under Codex a kind in `CODEX_AGENT_KINDS` — or `'complete'`, the
  one-shots — is 'ok' when Codex is installed and signed in with ChatGPT; another kind answers
  `codexKindNotAvailableMessage(kind)`; no kind means "any agent" (not until every kind runs). The
  platform's `ctx.llm` (the one-shot client) defaults to `'complete'`. `/api/me` adds
  `ai.kinds: Record<AiRunKind, AiKindStatus>` (shared `AiAgentKind`/`AiRunKind`, `aiKindsAll`), and every
  `AiRunGate` names its `kind` (`aiAuthFor`/`aiReadyFor` in the SPA). The active provider is ONE question
  (`provider-setting.ts activeProviderId`), asked by the registry and the pre-flight alike.
- `CODEX_AGENT_KINDS` = the union of `ai/codex/kinds/{review,fix,tickets,docs}.ts`, each EMPTY: a stream
  adds its kinds to its own file in the commit that ports them.
- THE PROMPT SEAM: `ai/prompt-tools.ts`. Mark a tool reference `{Read}`/`{Glob}`/`{Grep}`/`{Write}`/
  `{Edit}`/`{MultiEdit}`/`{Bash}`/`{submit_x}` and render it per provider: Claude drops the braces only
  (byte-identical; a test renders every prompt source and prompt-golden.json to itself), Codex gets
  `read_file`/`list_files`/`search`/`apply_patch`/"your final JSON answer"; `submitSentence` swaps a whole
  "call submit_x …" sentence for `CODEX_FINAL_ANSWER_SENTENCE`; `either` for anything else.
- SPECIALISTS ON CODEX (§ 3.5): `ai/codex/specialists.ts runCodexSpecialists` — N read-only Codex runs in
  parallel (one door: the provider's `runAgent`), each its own instructions and strict schema
  (`submit_specialist`), capped at CLAUDE_REVIEW_MAX_SPECIALISTS (catalogue names, each once, the
  dispatch guard's refusal sentence), `allowStart` asked before each start, the batch's US$ split
  evenly and no start once spent; answers in order, a failure never stops the others.

**Phase 3 status (integrated 2026-10-25, branch `codex/p3-integrated`)**: the four stream branches
below are merged. `CODEX_AGENT_KINDS` holds 13 of the 14 agent kinds; ⚠ the ONE missing kind is `plan`
(Plan first — ported in code, passing offline, but its live run on gpt-6-luna at low effort answered
with no steps; stream (b) below). So `codexRunnable()` / `CODEX_RUNNABLE` stay FALSE: `auto` never
picks Codex, `/api/me` reports `providers.codex.available: false` with the "not available" sentence,
and under `LIMN_AI_PROVIDER=codex` the top-level pre-flight (no kind) answers 'none' while each ported
kind's own pre-flight answers 'ok' once signed in. `/api/me` now also carries
`providers.codex.kinds` — Codex's OWN per-run-kind answer whichever provider is active (ported +
signed in ⇒ 'ok'; `plan` ⇒ its "Codex cannot run AI Fix plans … yet" sentence). `provider.test.ts`
pins the missing list to `['plan']`: adding `plan` to `ai/codex/kinds/fix.ts` after a passing live
run flips Codex to runnable with no other change. Claude stays the default under `auto` when both are
signed in (decided, `pickAutoProvider`). Claude's behaviour is unchanged: `prompt-golden.json`,
`no-shell.test.ts` and every Claude agent test pass untouched by the merge.
- One integration fix: stream (d) made `docsNavigationPrompt` render for the ACTIVE provider, but
  `docsReviewPromptBlock`'s two callers re-word the finished block for Codex themselves and match
  Claude's sentences, so the block now always renders Claude's words (`review-refs.ts`); this
  restored `tickets-claude-prompts.json` and changes nothing under Claude.
- Live check 2026-10-25 (`~/.limn/codex`, gpt-6-luna, low effort, 4 model runs, US$ 0 each):
  `/api/me` on a scratch DB with `LIMN_AI_PROVIDER=codex` reported signed in (plus), `available:
  false`, every kind 'ok' except `plan`. Through the provider directly on a scratch git fixture:
  a `review` run (30,090 in / 21,248 cached / 200 out), a `fix` WRITE run that edited only
  `src/math.ts` in the worktree (40,310 / 30,720 / 290), a `ticket_review` run (30,213 / 14,720 /
  216) and one `complete()` (6,646 / 5). Each wrote one Codex ledger row. Note: the provider's
  `filesChanged` are ABSOLUTE paths; the fixer reads its own diff from git, so nothing depends on it.

**Phase 3 stream (a) built 2026-10-25** (branch `codex/p3-review`): `review`, `review_chat` and
`thread_check` are in `ai/codex/kinds/review.ts`.
- ONE provider per run: each runner asks `getActiveProvider()` ONCE (`const provider = …`; the seam
  test accepts that form) and branches on `provider.id === 'codex'`. With Claude active nothing below
  runs: prompts, tools, models, budgets and the auth env are byte-for-byte as before.
- CODEX WORDS WITHOUT TOUCHING CLAUDE'S PROMPTS: `review/codex-wording.ts` swaps known Claude sentences
  in the FINISHED prompt (Codex side written with `{Tool}` refs and rendered by `ai/prompt-tools.ts`).
  `codex-wording.test.ts` renders every variant and fails on a Claude-only word left behind, and on a
  swap whose Claude sentence no prompt carries any more.
- THE DEPTHS: the role from the review's model (Opus → deep, Sonnet → standard), Codex effort = the
  role's on a worktree run and ONE STEP LOWER diff-only (`review/codex-review.ts codexReviewEffort`).
- SPECIALISTS: Limn runs them BEFORE the lead through `runCodexSpecialists` (one door: the active
  provider), picked in CODE (`pickCodexSpecialists`: offered only, accessibility first, design last, at
  most the cap), each `{ report }`; their reports reach the lead FENCED, a skipped/failed one NAMED. An
  AUTOMATIC review asks the spend gate before each (`RunReviewArgs.allowSpecialistStart`).
- USAGE: the runners pass `usageRecord` (new optional `usage` on the args), so Codex writes its own
  ledger row (one per specialist too, `claude_review:<lens>`); the result says `usageRecorded` and the
  manager's cost-gated row is skipped. Codex tokens are never priced as Claude's (US$ from the outcome).
- Live (`review/codex-review-live.test.ts`, 2 runs, gpt-6-luna low): a diff-only review with the real
  prompts passed the strict `submit_review` schema; Check threads read through MCP and judged R1.
- Open: the stored `claude_reviews.model` (and the chat row's) still names the Claude model the run
  was ASKED for; the product copy says "Claude" (Phase 4).

**Phase 3 stream (b) built 2026-10-25** (branch `codex/p3-fix`): AI Fix, Plan first, Resolve with Claude.
- `CODEX_FIX_KINDS` = `fix`, `resolve`. ⚠ NOT `plan` yet: it is ported in code and passes offline, but its
  one live run (gpt-6-luna, low effort) answered with no steps twice and its own check refused it. Add it
  after a live run passes.
- ONE PROVIDER PER JOB: the AI Fix manager and the resolver pick the provider once (`activeProviderId`),
  word the prompt for it and hand the SAME one to the run (`GenerateFixArgs.provider`,
  `GeneratePlanArgs.provider`, `runAgentInWorktree({ provider })`). Prompts take an optional provider
  (`buildFixSystemPrompt(provider)`, …, `buildAiResolvePrompt(model, nonce, provider)`); Claude's text is
  byte-identical (`WORKTREE_RULES` is now `worktreeRules(t)` over `WORKTREE_RULES_REST`).
- ROOTS: the fixer writes its worktree only (`writeRoots = [worktree]`, the Claude path guard's cwd);
  Plan first and the resolver are read-only. The sandbox's only write root is the worktree, `/tmp` and
  `$TMPDIR` excluded.
- A refusal IN A RESULT TOOL is `isError` on Codex only, so it earns the provider's one retry: the plan's
  shown-ref check (every refusal), and the resolver's refused choices (the FIRST answer only — a second
  answer keeps what was accepted, as on Claude). Claude's tool replies are unchanged.
- USAGE: the runs pass `usageRecord` (`ai_fix`, `ai_fix_plan`, `ai_resolve`, with the PR); Codex writes
  its own row, and `usageRecorded` (on the run result, `GenerateFixResult`, `GeneratePlanResult` and the
  partial spend) stops the caller writing a second. A Codex run is never priced with Claude's table
  (US$ 0 on a ChatGPT sign-in, live and final).
- Tests: `coding/codex-fix.test.ts` (offline, real provider + fake `codex` + real git worktree: success,
  shape failure + retry, double failure, cancellation, the plan check retry, the resolver retry);
  `ai-fix/auto-fix.test.ts` (the Codex budget skip); `coding/codex-fix.live.test.ts` (opt-in). Live run
  2026-10-25: the WRITE run passed (the hook let `src/math.ts` through and denied `../outside`, `/tmp`
  and `$TMPDIR`; none of the files exists); the plan run failed as above.

**Phase 3 stream (c) built 2026-10-25** (branch `codex/p3-tickets`): `ticket_review`, `pr_card`,
`ci_review`, `story_docs` are in `ai/codex/kinds/tickets.ts`.
- Each manager resolves the provider ONCE (`activeProviderId()`), words its prompts for it
  (`promptTools(provider)`: `ticketReviewSystemPrompt`/`buildTicketReviewPrompt`, `ticketCardSystemPrompt`/
  `buildPrepassPrompt`, `ciReviewSystemPrompt`/`buildCiReviewPrompt`, `storyDocsSystemPrompt`/
  `buildStoryDocsPrompt` take a trailing `t`) and hands the same id to its runner. The old constants stay
  as the Claude render; every Claude prompt is pinned byte-for-byte against
  `ai/codex/kinds/__fixtures__/tickets-claude-prompts.json`, written from the code BEFORE the port. The
  shared library block (`docsReviewPromptBlock`, review-refs.ts) is NOT edited: the ticket prompt re-words
  it for Codex locally (`codexDocsWording`), and a test asserts no Claude tool name survives.
- `review/run-provider.ts`: the Claude env tweak runs on Claude only; the live status-line US$ is Claude's
  price table on Claude only (0 on Codex); a Codex run is billed by the PROVIDER from `usageRecord`, and the
  managers' own recorders skip it (`ledgerByProvider` on the telemetry). The card and run rows store the
  model the provider actually ran (`res.model`).
- Story docs: the shape judge's refusal is worded per provider; Codex gets ONE retry (Claude: up to 3
  calls), and a run that ends refused twice reports `no usable answer: <last refusal>` as on Claude.
- Not changed: the per-run `budget.usd`/`turns` are Claude-enforced only (a Codex ChatGPT run is US$ 0 and
  has no turn cap; its wall-clock timeout applies); the stored ticket/CI run row's `model` column is still
  the requested Claude id.

**Phase 3 stream (d) built 2026-10-25** (branch `codex/p3-docs`, on the foundation): `diagram`,
`sprint_paths`, `docs_build`, `docs_chat` in `ai/codex/kinds/docs.ts`.
- Each runner asks `getActiveProvider().runAgent` with `codex.resultTool` naming its result tool, so the
  strict schema is the SAME shape's (`submit_design`, `submit_paths`, and for the docs build the new
  `submit_document` = `record_sections` + `finish_document` side by side, in `ai/result-schemas.ts`), and
  the answer reaches the SAME handler: `validateDesign`, the sprint digit gate (`validateSprintPaths`),
  `judgeRecord` + `judgeFinish` are unchanged. A handler's refusal is worded for Codex ("answer again")
  only on Codex (`either`).
- Read roots are exactly the Claude path guard's (diagram: the scratch cwd + the checkouts; paths: an
  empty throwaway cwd; build: the staging folder; chat: the library); no write roots.
- Prompts: `prDiagramSystemPrompt`/`storyDiagramSystemPrompt`/`sprintPathsSystem`/
  `buildSectionsSystemPrompt`/`chatSystemPrompt` (and the shared `docsNavigationPrompt`) take a provider
  (default: the active one); the old constants are the Claude rendering, pinned by hash.
- Usage: each runner passes `usageRecord`; Codex writes its own row (provider `codex`, its model, US$ 0
  on a sign-in, NULL tokens when cancelled) and the manager skips its Claude-named row for a Codex run
  (`provider` on the runner's result).
- ⚠ A PDF docs build REFUSES on Codex (`CODEX_PDF_MESSAGE`): Codex cannot read PDF pages.
- One-shot callers (briefs, themes, labels, sprint Ask, crawl rank, story-docs shortlist, the platform's
  reports, synthesis, annotations, work plan, flow pointers, bot themes, Slack) already recorded
  provider-correct rows through `cheapUsage` / `fromHost`; the sprint Ask now echoes the answering model
  and names Codex in its failure sentences.
- Tests: `ai/codex/kinds/docs.test.ts` (recorded-shape JSONL in `ai/codex/__fixtures__/docs/`: success,
  a schema or validator refusal + the one retry, cancellation, the budget gate) and the opt-in
  `docs.live.test.ts` (2 runs on gpt-6-luna at low, the model overridden in the test only).

Original status: Written 2026-10-23 after checking the current Codex docs and the published
`@openai/codex-sdk` 0.164.0 type definitions. The work is meant to be carried out by subagents
through the Workflow tool, in the phases below, with the user confirming the decisions in § 6 first.

## 1. The short version

Codex can do everything Limn's agents need, and the 2026 releases closed the two gaps that looked
hardest: Codex now has **hooks** (`PreToolUse` can deny a tool call) and **subagents**. The port is
still a real piece of work, because 13 agent call sites and the one-shot `cheapComplete` are written
against the Claude Agent SDK. The plan:

1. Put ONE provider interface in front of every agent run and every one-shot call, with the Claude
   code moved behind it unchanged (no behaviour change, proven by the existing suite).
2. Add a Codex implementation that runs `codex exec --json` in a locked-down configuration.
3. Port the agents onto that interface in parallel, then measure Codex's results on real pull
   requests before it is offered by default anywhere.

## 2. What the Codex docs say (checked 2026-10-23)

| Limn needs | Codex has | What it means here |
|---|---|---|
| Run an agent from Node, stream progress | `@openai/codex-sdk` (wraps the `codex` CLI, JSONL events: `thread.started`, `turn.started/completed/failed`, `item.started/updated/completed`; items `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`) | Maps onto the one `AiStatusLine` and the SSE streams. |
| A structured final answer (our `submit_*` tools) | `outputSchema` per turn (SDK) / `--output-schema` (CLI); the answer arrives as `finalResponse` | Each `submit_*` tool becomes a JSON Schema the final answer must match; Limn validates it and, on failure, sends one more turn on the same thread with the validation error. |
| Read-only review, edit-only fix | `sandbox_mode`: `read-only`, `workspace-write` (+ `sandbox_workspace_write.writable_roots`, `network_access`), OS-level | The fixer gets `workspace-write` scoped to its worktree; everything else is `read-only`. |
| No shell | `features.shell_tool = false`; `approval_policy = "never"` for non-interactive runs | ⚠ Codex normally READS files through the shell. With the shell off, reads must come from somewhere else (see § 3.3). |
| The path guard (`review/path-guard.ts`) | Hooks: `PreToolUse` with a regex `matcher` on `tool_name` (`Bash`, `apply_patch`/`Edit`/`Write`, `mcp__server__tool`); deny by exit code 2, or `hookSpecificOutput.permissionDecision: "deny"` | Usable, but non-managed hooks must be TRUSTED (persisted by hash via `/hooks`) or the run must pass `--dangerously-bypass-hook-trust`. Hooks fire for `apply_patch` and MCP tools but NOT for hosted tools such as web search. |
| Deep review's specialists | Subagents: one TOML file per agent (`name`, `description`, `developer_instructions`, optional `model`, `model_reasoning_effort`), cap `agents.max_concurrent_threads_per_session`; children INHERIT the parent's sandbox and approvals | The docs do not say how subagents behave in `exec`/SDK runs, and the cap is per session, not per review. Limn orchestrates specialists itself instead (§ 3.5). |
| Cost per run | `turn.completed.usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` | Tokens only, never dollars. On a ChatGPT login there is no per-run price at all (§ 3.6). |
| Sign-in | `codex login` (ChatGPT account) or `--with-api-key`; `codex login status` exits 0 when signed in; `forced_login_method = chatgpt \| api` | The credential ladder gets a Codex branch: ChatGPT login, else `OPENAI_API_KEY`. |
| Keep the user's own Codex setup out of Limn's runs | `--ignore-user-config` (auth still read from `CODEX_HOME`), `--ephemeral` (no session files), `history.persistence = "none"`, `projects.<path>.trust_level = "untrusted"` (skips the repo's `.codex/` layer) | ⚠ The same landmine as "the Agent SDK saw claude.ai connectors": without `--ignore-user-config` a user's own MCP servers and hooks would ride into every Limn run. |
| Choose the model per job | `model`, `model_reasoning_effort` (`minimal`…`max`) per thread | One model table per provider, pinned in the spike (Phase 0). |

Not settled by the docs, so Phase 0 checks them on a real install: whether the SDK can pass
`--ignore-user-config` and `--ephemeral` (its options have no free-form CLI flags, so Limn may run
`codex exec --json` directly instead); how to stop a PR's own `AGENTS.md` reaching the prompt (a
pull request is untrusted input: likely `project_doc_max_bytes = 0`); whether a ChatGPT login
stored in the keychain is visible to a run with a private `CODEX_HOME`.

Sources: [Codex hooks](https://learn.chatgpt.com/docs/hooks) ·
[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) ·
[Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) ·
[CLI reference](https://learn.chatgpt.com/docs/cli/reference) ·
[TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) ·
`@openai/codex-sdk` 0.164.0 `dist/index.d.ts`.

## 3. Design

### 3.1 One provider interface

New `apps/backend/src/ai/provider.ts`:

```ts
interface AgentRunSpec {
  kind: AgentKind;                 // 'review' | 'fix' | 'plan' | 'resolve' | 'ticket_review' | …
  model: ModelChoice;              // a role ('deep' | 'standard' | 'fast'), never a vendor id
  prompt: string; system: string;
  cwd: string; readRoots: string[]; writeRoots: string[];   // writeRoots empty ⇒ read-only
  result: { name: string; schema: JsonSchema; validate(x): string | null };  // was submit_*
  budget: { usd?: number; tokens?: number; turns?: number };
  signal: AbortSignal;
  onProgress(e: AgentProgress): void;
}
interface AgentProvider {
  id: 'claude' | 'codex';
  runAgent(spec: AgentRunSpec): Promise<AgentRunResult>;   // result, usage, transcript summary
  complete(req: CompleteRequest): Promise<string>;        // the one-shot path (cheapComplete)
  detect(): Promise<ProviderStatus>;                      // signed in? installed? which rung?
}
```

`ai/credentials.ts` becomes the ONE place that picks the provider and its rung. Every caller
(`review/agent.ts`, `coding/agent.ts`, the 11 others, `review/llm.ts`, the platform's `ctx.llm`)
goes through it. The Claude implementation is today's code moved, not rewritten.

### 3.2 The Codex runner

`apps/backend/src/ai/codex/run.ts` spawns the CLI from the first-use install (§ 3.7) as
`codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check -C <cwd> --output-schema <file>`
plus `-c` overrides: `sandbox_mode`, `sandbox_workspace_write.writable_roots`,
`sandbox_workspace_write.network_access = false`, `approval_policy = "never"`,
`features.shell_tool = false`, `web_search = "disabled"`, `history.persistence = "none"`,
`analytics.enabled = false`, `agents.enabled = false`, `project_doc_max_bytes = 0`, `model`,
`model_reasoning_effort`, and the one MCP server below. It parses the JSONL events into
`AgentProgress`, reads `usage` from `turn.completed`, and validates `finalResponse` against the
result schema. Running the CLI directly (rather than through the SDK) keeps every flag in our
hands; the SDK's `index.d.ts` is the reference for the event types.

### 3.3 Reads without a shell: Limn's own workspace MCP server

With the shell off, Codex needs a way to read code. Limn ships a small stdio MCP server
(`apps/backend/src/ai/codex/workspace-mcp.ts`) with `read_file`, `list_files` (glob) and `search`
(grep). It is started per run with the run's `readRoots` and refuses anything outside them, so it
IS the path guard for reads, enforced in code (the same check `review/path-guard.ts` makes today).
Edits use Codex's own `apply_patch` inside `workspace-write`, bounded by the OS sandbox to the
worktree. A `PreToolUse` hook on `apply_patch` repeats the path check as a second guard, if Phase 0
shows hooks can be enabled per run without the interactive trust step; if not, the sandbox alone
bounds writes, and that is recorded as a decision.

**Built in Phase 2(b)** (branch `codex/p2-mcp-hook`, `apps/backend/src/ai/codex/`):
- `workspace-mcp.ts` (+ entry `workspace-mcp-main.ts`, tools in `workspace-files.ts`): a hand-rolled
  newline JSON-RPC server, NOT the MCP SDK — it is Codex's child process, so it cannot use
  `ai/runtime.ts`'s loader, and node built-ins keep a Codex-only install free of the MCP SDK.
  Every path is placed by `realPathFor` in `review/path-guard.ts` (the Claude hook's rule).
  `search` and globs run on `linear-regex.ts` (a Pike VM, no back-references or look-around),
  and every cap is stated in the answer.
- `hook.ts` (+ entry `path-guard-hook-main.ts`, rule in `hook-rule.ts`): denies writes outside the
  write roots, and every MCP tool that is not `mcp__workspace__*`. It fails closed (exit 2) on any
  error. ⚠ The roots travel in `LIMN_CODEX_GUARD` (`hook.env`, which the runner MUST merge into the
  `codex exec` env), so the command and its trust hash are the same for every run. There is ONE
  trust slot per key, so concurrent runs with different hashes would untrust each other without a
  word. The trust hash is sha256 of sorted-key JSON
  `{"event_name","hooks":[{"async","command","timeout","type"}],"matcher"}`, pinned in `hook.test.ts`
  against `hooks/list`. `verifyHookTrusted` = `hooks/list` says `trusted` with our hash, AND the
  command denies a canary call.
- Live (stream B's own run, since folded into `live.test.ts`; 2 runs on gpt-6-luna): the hook ran for MCP calls and
  `apply_patch` with its env roots, and denied `../outside/secret.env` and `../outside/pwned.txt`.
  Codex 0.164 sends `apply_patch` input as `{"command":"*** Begin Patch…"}`.

### 3.4 Results instead of `submit_*` tools

The 13 result tools (`submit_review`, `submit_fix`, `submit_plan`, `submit_resolution`,
`submit_ticket_review`, `submit_pr_card`, `submit_ci_review`, `submit_threads`, `submit_design`,
`submit_paths`, `submit_alignment`, `submit_explanations`, `record_sections`) each get ONE
shared JSON Schema, generated from the zod shape the Claude tool already uses, so both providers
validate against the same contract. Codex returns it as the final answer; Claude keeps its tool.
⚠ Every server-side check stays where it is (`validateDesign`, the fix's shown-ref check, the docs
quote check, the digit gate): a provider swap must not move a single guard.

### 3.5 Specialists: Limn runs them, not Codex

A deep review consults up to five specialists, and the cap is a rule in code. On Codex, Limn runs
each specialist as its own parallel `codex exec` thread (read-only, its own instructions and
schema), then hands their answers to the main review run. This keeps the cap, the budget and the
cost per specialist in Limn's hands, and does not depend on undocumented subagent behaviour in
`exec`. The Claude path keeps its SDK subagents.

### 3.6 Cost and budget (revised 2026-10-25, see § 8)

- API key (`OPENAI_API_KEY`): Limn turns tokens into US$ with an OpenAI price table (as
  `review/pricing.ts` does for Claude), so `REVIEW_BUDGET_USD`, `recordAiUsage` and the spend
  budget's weekly US$ mode keep working.
- ChatGPT login: the SAME rule as a Claude subscription — Limn's share of the 5-hour and weekly
  limits, default 5%, percentages only. Measured from Codex's OWN rate-limit reading (primary =
  5-hour, secondary = weekly, `used_percent` + reset), not from a guessed dollar allowance (§ 8.1).

### 3.7 Install, sign-in, choice

- `@openai/codex` (the CLI, platform binaries) installs on first use into `~/.limn/ai-runtime`,
  pinned in `limnAiRuntime`, exactly like the Claude SDK; `ai/runtime.ts` stays the only module
  that loads either. "Set up AI" / `limn ai install` gain a provider choice.
- Provider choice: `LIMN_AI_PROVIDER = claude | codex | auto` plus a Settings → AI control.
  `auto` = whichever is signed in, Claude first when both are (a decision for § 6).
- `MeResponse.ai` gains `provider` and per-provider `auth`; `AiRunGate` names the provider in
  its one line. Every user-facing "Claude" that means "the AI" names the provider in use
  (the agentic surfaces, HelpModal, landing).

## 4. Rules that must hold on both providers

- Anything an agent reads from a PR is untrusted input: no shell, no network, no web search, no
  user config, no repo `AGENTS.md`/`.codex/` in the prompt.
- Nothing is posted or pushed until the reader presses the button (the per-workspace auto-post and
  Push automatically switches remain the only exceptions); every auto-post rule is unchanged.
- The fixer builds and tests nothing, and the SPA keeps saying so.
- Every result passes the same server-side validation, whichever provider wrote it.
- Usage is recorded for every run (tokens always; US$ when known).
- `ai/runtime.ts` is the only value-importer of any AI package (the build check gains the Codex
  package names).
- The demo shows the feature (CLAUDE.md § the demo): a Codex-labelled recorded run per kind.

## 5. Execution: phases for workflows

Each phase is one Workflow run (under ten agents), started only after the previous phase is merged
and green. Every implementing agent works in its own worktree (`isolation: 'worktree'`), resets to
the phase's base commit first, never touches the main working tree, and returns branch, head sha,
summary, verification and follow-ups. Every phase ends with an adversarial review in which each
finding is checked by a second agent, then fixed in the same phase.

| Phase | Agents | Scope | Gate to move on |
|---|---|---|---|
| **0. Spike** | 1, NOT in a worktree's code: a scratch dir | On a real `codex` install with the user's sign-in: confirm every § 2 "not settled" item, pin models, measure one read-only review run end to end through the workspace MCP server, try per-run hooks. Writes `docs/CODEX-SPIKE.md`. ⚠ Uses the user's Codex quota; the user starts it. | The user reads the spike and confirms § 6. |
| **1. Seam** | 2 (backend seam, then a reviewer) | `ai/provider.ts`; move the Claude code behind it; all 13 call sites and `cheapComplete` + `ctx.llm` go through it; result schemas shared (§ 3.4). No behaviour change. | Full backend + frontend + e2e suites green; `prompt-golden.json` and `no-shell.test.ts` unchanged. |
| **2. Codex core** | 3 in parallel | (a) runner + JSONL parser + config builder + usage; (b) workspace MCP server + path checks (+ hook if Phase 0 allows); (c) install-on-first-use, credentials ladder, `MeResponse.ai.provider`, build-release checks. | Unit tests for every config flag, path refusal and ladder rung; an opt-in live test (`LIMN_CODEX_LIVE=1`) passes on the user's machine. |
| **3. Port the agents** | 4 in parallel + 1 reviewer | (a) Claude Review + specialists (§ 3.5) + chat + Check threads; (b) AI Fix + Plan first + Resolve with Claude; (c) ticket review + prepass + CI review + story docs; (d) diagrams + sprint paths + docs build/chat + one-shot callers (briefs, themes, reports, impact note, work plan, Slack). | Every kind runs on both providers in tests (recorded Codex event streams as fixtures); validation failures retry once; budgets enforced. |
| **4. Product surface** | 3 in parallel | (a) Settings → AI provider choice, `AiRunGate`, status lines, copy that names the provider; (b) demo: a Codex-labelled recorded run per kind, re-record, `demo:verify`; (c) docs: CLAUDE.md, `docs/CLAUDE-REVIEW.md`, PACKAGING, README, release README. | Typecheck, suites, `demo:verify` (now and +40 days). |
| **5. Evaluation** | 2 | A harness that runs both providers over the same set of real, already-reviewed PRs (the user picks them) and compares findings, blockers, fix success and cost. ⚠ Spends real quota on both; the user starts it. | The user decides, from the numbers, whether Codex is offered, and for which kinds. |
| **6. Launch** | 1 | Landing copy from "Codex coming soon" to supported; release notes. | Push, release, site deploy, live check. |

## 6. Decisions for the user (before Phase 1)

**DECIDED 2026-10-25** (after the spike):
- **Codex sign-in:** Limn's OWN Codex home, `~/.limn/codex` (one extra `codex login`, from Settings
  or `limn ai login codex`). Limn writes its whole `config.toml` there, including the hook trust
  entry; non-ephemeral session files there make validation retries (`exec resume`) possible. The
  user's `~/.codex` is never read or written.
- **ChatGPT share:** TOKEN-WEIGHTED — Limn's tokens in the window ÷ the account's tokens in the
  window (`account/usage/read`) × the window's `usedPercent` (`account/rateLimits/read`). Whole-percent
  readings, so the share is coarse; copy says so behind the ⓘ.
- **Default when both are signed in:** Claude. Codex is chosen in Settings until Phase 5.
- **Scope:** ONE provider for every AI feature in v1.
- Still open: decision 5 (the Phase 5 PRs and quota), asked at Phase 5.

Original questions:

1. When both Claude and Codex are signed in, which does `auto` use? (Suggested: Claude, the one
   the rules were tuned on, until Phase 5 says otherwise.)
2. Should the provider be one choice for everything, or per feature (for example Codex for
   one-shot summaries, Claude for reviews)? (Suggested: one choice in v1.)
3. On a ChatGPT login, is a token ceiling per run an acceptable budget? (§ 3.6)
4. Is it acceptable that, if Phase 0 finds per-run hooks need the interactive trust step, writes
   are bounded by the OS sandbox only, with reads still guarded by Limn's MCP server?
5. Which real pull requests should Phase 5 use, and how much quota may it spend?

## 7. Risks

- **Quality differs.** The auto-post confidence threshold, blocker rules and reply judgements were
  tuned on Claude's behaviour. Phase 5 exists so this is measured, not assumed.
- **Codex moves fast** (0.164 at the time of writing, hooks and subagents new this year). Pin the
  CLI version in `limnAiRuntime` and re-run Phase 0's checks on every bump.
- **Reading through MCP is slower** than Codex's usual shell reads. If it hurts review quality,
  the fallback is the shell in a `read-only` sandbox with a `PreToolUse` hook on `Bash` that only
  allows `cat`/`rg`/`ls` inside the read roots. That weakens "no shell" and needs an explicit
  decision.
- **Two providers double the test surface.** Recorded Codex event streams as fixtures keep the
  suite offline; only the opt-in live tests spend quota.

## 8. Changes since the plan (assessed 2026-10-25)

### 8.1 The spend budget (`ai/budget.ts`, `packages/shared/src/ai-budget.ts`, migration `0125`)

What landed: an optional per-machine budget, off by default. On a Claude subscription Limn may use a
share of the week (1–50%, default 5%) and of each 5-hour session (follows the week unless set); on an
API key, a weekly US$ budget. ONE gate (`allowAutomaticRun` / `review/budget-gate.ts`) is asked
before every AUTOMATIC run; runs the reader starts warn and need a second press. A header item shows
Limn's shares and Claude's own windows. Usage is read by tapping every Agent SDK message
(`ai/runtime.ts` `tapQuery` → `rate_limit_event`) plus a background usage probe.

What it means for Codex:

| Area | Today (Claude only) | Codex change |
|---|---|---|
| The gate | One gate, provider-blind callers | Keep ONE gate; it asks the ACTIVE provider's budget. No caller changes. |
| Subscription share | Limn's recorded US$ ÷ an ESTIMATED weekly/5-hour US$ allowance (`SUBSCRIPTION_ESTIMATES`, third-party figures) | Codex reports tokens, never US$, so the estimate route does not carry over. Better: Codex exposes its own windows — a 5-hour ("primary") and a weekly ("secondary") `used_percent` with reset times. Limn's share = the sum of the `used_percent` RISE across each of Limn's own runs. No estimate table. ⚠ A run while the reader also uses Codex elsewhere over-counts; that errs on the safe side and is acceptable. Fallback only if Phase 0 finds no reading: a ChatGPT-plan estimate table (Plus / Pro / Business), labelled as an estimate like Claude's. |
| Where the reading comes from | SDK message tap + experimental usage probe | Phase 0 must find it: an event in `exec --json`, the `app-server` `account/rateLimits/read` method, or the session log's `rate_limits` block. Then ONE normalised `AiUsageReading` feeds the same observer, whichever provider produced it. |
| API key mode | Weekly US$ | Same, with OpenAI prices. |
| Ledger | `ai_usage.cost_usd` is NOT NULL; no provider column | Migration: add `provider` (default `'claude'`) and a nullable per-run `share_pct` (the rise in the weekly window); a ChatGPT run stores `cost_usd = 0` with its tokens and share. Every fold that sums `cost_usd` filters by provider. |
| Settings + header | "Claude spend", Claude's windows | "AI spend" naming the provider in use; the popover shows Codex's windows when Codex is active. Same 5% default. |
| Demo | Claude budget in the recording | A Codex-labelled budget reading too (CLAUDE.md § the demo). |

Phase placement: the provider-neutral reading and ledger column go in **Phase 1** (seam), the Codex
reading in **Phase 2(c)**, the Settings/header naming in **Phase 4(a)**.

### 8.2 The landing site

It was redesigned (the "pigment board", Getting started and Reporting pages, "Time it saves you",
the budget step). Codex is now "coming soon" in four places: the Gather board's `Codex` tile
(`components/board/Gather.tsx`), `Contact.tsx`, `GettingStarted.tsx` and `HowWeMeasure.tsx`; and
Claude-only budget/cost copy sits in `components/board/Cost.tsx`, `Faq.tsx`, `Check.tsx`, `Act.tsx`,
`SavesTime.tsx`, `lib/routes.ts` (SEO) and `lib/site.ts`. **Phase 6** therefore grows: the Codex
tile becomes live, Getting started gains "Install Codex and sign in" plus the budget step for a
ChatGPT plan, and the FAQ, cost and SEO text name both providers. Until Phase 5 decides, nothing on
the site changes.

### 8.3 This machine

The Codex CLI is not installed (only a lazy-load shell wrapper). `~/.codex/auth.json` holds a ChatGPT
sign-in last refreshed by Codex 0.77 in January, which may have expired; `~/.codex/config.toml`
defines a `railway` MCP server — exactly what `--ignore-user-config` must keep out of Limn's runs.
Phase 0 installs the pinned CLI into a scratch folder (never globally) and, if the sign-in has
lapsed, stops for the user to run `codex login`.
