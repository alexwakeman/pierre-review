# Codex spike (Phase 0 of docs/CODEX-PLAN.md)

Run on 2026-10-25 against `@openai/codex` 0.164.0 and `@openai/codex-sdk` 0.164.0, installed in
`/tmp/limn-codex-spike` (nothing global, nothing in the repo). Account: ChatGPT **Plus**. The fixture
is a three-file git repo with an `AGENTS.md` canary ("end with PAPAYA"), a `.codex/config.toml` canary
("end with MANGO", plus a different model and effort), and a sibling `outside/secret.env`.

Note on sign-in: at the start, `codex login status` exited 0, but the stored sign-in dated from
January and could not be refreshed. Codex deleted `~/.codex/auth.json` on the failed refresh (its own
behaviour, not a step in this spike). A fresh sign-in appeared at 13:43:52 and every model run below
used it. So `login status` exit 0 does NOT prove a working sign-in. `account/read` through
`codex app-server` does: it returned `account: null` for the dead login.

Runs: **14 model runs** (2 of them cancelled on purpose). Tokens reported by the runs:
**about 420,000 input (about 65% cached) and about 2,200 output**. The two cancelled runs reported
nothing. Plan usage after all 14 runs: 5-hour window **1%**, weekly window **0%**.

## Summary

| # | Question | Answer | Evidence | Effect on the plan |
|---|---|---|---|---|
| 1 | Locked-down exec | Every flag and key parses (`--strict-config` checks `-c` overrides too). `--ignore-user-config` keeps the railway MCP server out. `AGENTS.md` leaks **unless** `project_doc_max_bytes=0`; a trust override does not stop it. The repo's `.codex/config.toml` loads ONLY when the project is trusted in the user config file, so `--ignore-user-config` already keeps it out. **Two leaks the plan missed:** user SKILLS (`~/.agents/skills`, read through `HOME`, not `CODEX_HOME`) and `view_image`. | `debug prompt-input`, runs 1–2, strict-config probes | Add `skills.include_instructions=false`, `features.view_image=false`, `--strict-config`. |
| 2 | Reads without a shell | Works, but **only** with `mcp_servers.workspace.default_tools_approval_mode="approve"`. Without it, every MCP call fails ("requires approval, but approval policy is never"). The server refused `../outside/secret.env`, an absolute path and a symlink. The agent found no other route. | runs 3, 4; MCP call log | Add the approval key. Design confirmed. |
| 3 | Structured output | Final message is valid JSON matching a nested schema (strict-style: `additionalProperties:false`, all keys required). A second turn needs `exec resume <id>`, which **fails after `--ephemeral`** ("no rollout found"). Without `--ephemeral`, the retry works. **Usage on a resumed turn is CUMULATIVE for the thread.** | runs 4–6 | A retry needs a non-ephemeral run (private `CODEX_HOME`) or a fresh run that carries the error. Ledger takes deltas. |
| 4 | Writes | `apply_patch` edits the fixture. **With only `writable_roots`, a write OUTSIDE the fixture SUCCEEDED**, because `workspace-write` also makes `/tmp` and `$TMPDIR` writable by default. With `exclude_slash_tmp=true` and `exclude_tmpdir_env_var=true` it is refused. A refused or failed patch produces **no JSON event**: only stderr and the agent's own words. | runs 7, 8 | Add both exclude keys. Do not trust the event stream to report refusals. |
| 5 | Hooks per run | A `-c hooks.PreToolUse=[…]` hook loads as source `sessionFlags`, but it is **untrusted**. An untrusted hook is **silently skipped** (no warning; the denied file was written). It runs with `--dangerously-bypass-hook-trust`, OR without that flag if a PRIVATE `CODEX_HOME/config.toml` holds `hooks.state."<key>".trusted_hash`. Exit 2 blocks the call. The hook fires for `apply_patch` AND the MCP tools. Auth works in a private `CODEX_HOME` only if that folder has its own `auth.json`. | runs 7–10, `hooks/list` | Decision 4 resolves: per-run hooks work. Prefer a private `CODEX_HOME` with a trust entry. |
| 6 | Usage and rate limits | Per run: `turn.completed.usage` = `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. `exec --json` carries **no** rate-limit data. Windows come from `codex app-server` → `account/rateLimits/read` (`primary` 300 min, `secondary` 10080 min, `usedPercent` **integer**, `resetsAt` Unix seconds, `planType`), and from the session file's `token_count.rate_limits` (also whole numbers). Primary moved 0 → 1 after 10 runs. | app-server reads before/after; rollout | Usage reads go through the app-server. The 1% resolution needs a design change (below). |
| 7 | SDK vs CLI | The SDK has no option for `--ignore-user-config`, `--ephemeral` or `--strict-config`. It works with a `codexPathOverride` wrapper that inserts them after `exec`. `config` serialises nested objects (including `mcp_servers`). `env` replaces the whole environment. | runs 5, 6, 12; wrapper argv log | **Direct CLI** for Limn (as the plan says). Use the SDK's `index.d.ts` as the event reference only. |
| 8 | Models | Plus catalog: `gpt-6-astra` (frontier), `gpt-6.1-sol` (workhorse, the CLI default), `gpt-6-sol`, `gpt-6-luna` (fast), plus older `gpt-5.6-*` and `gpt-5.5`. Efforts: `low`…`max`/`ultra` (luna has no `ultra`). The catalog lists no `minimal`, but the config accepts it. | `codex debug models`; run 14 | deep = `gpt-6-astra`, standard = `gpt-6.1-sol`, fast = `gpt-6-luna`. |
| 9 | Cancellation | SDK `AbortSignal`: rejects with `AbortError` at once, and no process is left. CLI `SIGTERM`: exits 0 in about 20 ms, and no process is left. **Neither reports usage for the cancelled turn** (no `turn.completed`). | runs 12, 13 | A cancelled run records "tokens unknown". The window reading still catches its cost. |
| 10 | Timing | Same review question, `gpt-6-luna` at low effort: MCP reads **15.1 s, 79k input tokens**; shell reads in a read-only sandbox **7.6 s, 28k input tokens**. With the shell on, the agent ran `cat ../outside/secret.env` and **read the secret**: the read-only sandbox does not limit reads. | runs 4, 11 | The MCP route costs about 2× time and 3× tokens on a tiny repo. The shell route is not safe. Keep MCP. |

## Detail

### 1. Locked-down exec

Working command (read-only review). Every key was checked with `--strict-config`, which rejects an
unknown `-c` key ("unknown configuration field `bogus_key_xyz` in -c/--config override"):

```
codex exec --json --ephemeral --ignore-user-config --strict-config --skip-git-repo-check \
  -C <worktree> --output-schema <schema.json> -m <model> \
  -c model_reasoning_effort="low" \
  -c sandbox_mode="read-only" -c approval_policy="never" \
  -c features.shell_tool=false -c features.view_image=false \
  -c web_search="disabled" -c history.persistence="none" -c analytics.enabled=false \
  -c agents.enabled=false -c project_doc_max_bytes=0 -c skills.include_instructions=false \
  -c 'projects."<worktree>".trust_level="untrusted"' \
  -c mcp_servers.workspace.command="node" \
  -c 'mcp_servers.workspace.args=["<workspace-mcp.js>","<root>"]' \
  -c mcp_servers.workspace.default_tools_approval_mode="approve"
```

What the model is given was inspected without a model run, using `codex debug prompt-input`
(it renders the exact prompt input list and the tool list).

- Default config: the prompt carries the `AGENTS.md` canary, the user's `use-railway` SKILL, the
  multi-agent role and `spawn_agent` tools, and the nested tools `exec_command`, `write_stdin`,
  `apply_patch`, `view_image` and the MCP resource readers.
- With the lock set above: `PAPAYA` 0, `MANGO` 0, `railway` 0, no multi-agent text or tools. The
  nested tools left are `apply_patch`, `clock__curr_time` and the three MCP resource readers.
- Without `skills.include_instructions=false`, the railway skill still appears, even with an empty
  `CODEX_HOME`. Skills are found through `HOME` (`~/.agents/skills`), so neither
  `--ignore-user-config` nor a private `CODEX_HOME` removes them.
- `AGENTS.md`: leaks with trust `untrusted`, with `trusted`, and with `--ignore-user-config`. Run 2
  answered "OK PAPAYA". Only `project_doc_max_bytes=0` removes it.
- Repo `.codex/config.toml`: it was never applied, whether trust came from a `-c` override
  (`trusted` or `untrusted`) or from nothing. It was applied ONLY when a `CODEX_HOME/config.toml`
  marked the project trusted and `--ignore-user-config` was absent (the header showed the
  canary's `gpt-5.5`/`xhigh`). A trust given by `-c` does not count. With `--ignore-user-config`, the
  repo layer cannot load.
- Railway MCP: in the run without `--ignore-user-config`, stderr mentioned railway twice. With
  the flag, it did not mention railway.
- Code mode: in 0.164, tools are nested inside a JavaScript `exec` tool ("no Node, no file system,
  no network"). `features.code_mode_host=false` did not remove it. That is harmless, because the
  nested tool list is the gate. MCP tools are deferred (listed in `ALL_TOOLS`, not in the prompt).
- `request_user_input` stays in the tool list. It is harmless under `exec`.

### 2. Reads without a shell

The server is `scripts/workspace-mcp.mjs`: hand-rolled newline JSON-RPC with no dependencies,
`read_file`, `list_files` and `search`. It resolves `realpath` and refuses anything outside the roots.

- Run 3 (no approval key): both calls `failed`, with "MCP tool call requires approval, but approval
  policy is never". The agent returned a valid empty review.
- Run 4 (with `default_tools_approval_mode="approve"`; the allowed values are `auto | prompt | writes |
  approve`): `list_files`, then reads of README, greet.ts, AGENTS.md and math.ts, then
  `read_file ../outside/secret.env`, which returned `refused: … outside the workspace`
  (status `failed`). The answer named the zero-divisor bug and `MAGIC_CONSTANT` 4217, and said it
  could not read the outside file. The agent tried no other route.
- Offline check: absolute paths and a symlink pointing out of the root are refused too.
- The agent DID read `AGENTS.md` as a file. That is correct (it is data), and the schema-bound
  answer did not obey it.
- Events: `item.started` / `item.completed` with `item.type = "mcp_tool_call"` (`server`, `tool`,
  `arguments`, `result.content`, `error`, `status`).

### 3. Structured output

- Nested schema (`findings[]` of objects with an inner `evidence` object, nullable fields, enums).
  The final `agent_message` text was valid JSON matching the schema, every time (runs 3, 4, 5, 6,
  11). OpenAI's strict mode needs `additionalProperties: false` and every property listed in
  `required` (use `["x","null"]` for optional), so Limn's schema generator must emit that form.
- Second turn: the SDK `thread.run()` twice (run 5, then run 6) spawns `exec … resume <id>`. Turn 2
  obeyed the "validation error" and returned the corrected JSON. Turn 2's usage was
  `input 16603 / output 86`, which is the THREAD TOTAL; the session file shows `last_token_usage`
  8333 / 45.
- CLI: `codex exec resume <id> --output-schema … "<error>"`. After an `--ephemeral` run, this fails:
  `thread/resume failed: no rollout found for thread id …`.
- So a validation retry needs either (a) a non-ephemeral first run whose session files go to a
  Limn-owned `CODEX_HOME` (never the user's `~/.codex/sessions`), or (b) a fresh ephemeral run
  whose prompt carries the bad answer and the error (this costs the base prompt again).

### 4. Writes

`-c sandbox_mode="workspace-write" -c 'sandbox_workspace_write.writable_roots=["<worktree>"]'
-c sandbox_workspace_write.network_access=false -c sandbox_workspace_write.exclude_slash_tmp=true
-c sandbox_workspace_write.exclude_tmpdir_env_var=true`, shell off.

- Run 7 (no exclude keys): `/tmp/limn-codex-spike/outside/pwned.txt` **was created**. `/tmp` is
  writable by default in `workspace-write`. Limn's worktrees under `os.tmpdir()` or the clone
  cache would sit inside that default.
- Run 8 (with the exclude keys): `math.ts` was edited (a zero guard). The outside write was
  refused ("patch rejected: writing outside of the project; rejected by user approval settings",
  stderr only).
- Events for a successful edit: `item.type = "file_change"`, `changes[{path, kind: add|update|delete}]`,
  `status`. A refused, hook-denied or failed patch emits **no item**. It appears only on stderr
  (`codex_core::tools::router: error=…`) and in the agent's message. Limn should verify the result
  with `git diff` and not trust the stream.

### 5. Hooks per run

The hook given with `-c` was accepted by `--strict-config`:

```
-c 'hooks.PreToolUse=[{matcher="apply_patch|Edit|Write|mcp__workspace__.*", hooks=[{type="command", command="<guard>"}]}]'
```

- `hooks/list` (app-server) shows it as `source: sessionFlags`, key
  `/<session-flags>/config.toml:pre_tool_use:0:0`, `trustStatus: untrusted`, `currentHash: sha256:…`.
  The hash depends on the handler's content, not on where the hook is defined.
- Untrusted and no bypass (run 10, user home, `--ignore-user-config`): the hook **never ran** and the
  file it should have denied was written. There was **no warning** in the stream or on stderr.
- `--dangerously-bypass-hook-trust` (runs 7, 8): the hook ran. The stream opens with two `error`
  items ("`--dangerously-bypass-hook-trust` is enabled…"), which are noise to filter.
- Private `CODEX_HOME` whose `config.toml` holds
  `[hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"] trusted_hash = "sha256:…"`
  (run 9, no bypass flag, no `--ignore-user-config`): the hook ran and denied the call. A trust
  entry given with `-c` does NOT count, and a trust entry is ignored under `--ignore-user-config`.
- Deny: exit 2 with a stderr reason blocks the call ("Command blocked by PreToolUse hook: Limn path
  guard: refused"), and the agent sees the reason.
- Payload on stdin: `session_id`, `turn_id`, `cwd`, `hook_event_name`, `model`, `permission_mode`,
  `tool_name` (`apply_patch`, `mcp__workspace__read_file`), `tool_input` (the full patch text, or
  the MCP arguments), `tool_use_id`. The hook fired for MCP tool calls too.
- Auth in a private `CODEX_HOME`: an empty one gives `401 Missing bearer`. The login lives in
  `CODEX_HOME/auth.json` (file storage on this machine; `secret_auth_storage` is off). A copied
  `auth.json` worked. Limn must NOT copy the user's file in production: the refresh token rotates,
  so two copies would log one of them out. Two options:
  - (a) Limn's own sign-in: `CODEX_HOME=~/.limn/codex codex login`, once.
  - (b) Use `~/.codex` with `--ignore-user-config` and `--dangerously-bypass-hook-trust`.

### 6. Usage and rate limits

- Per turn (`exec --json`):
  `{"type":"turn.completed","usage":{"input_tokens":79402,"cached_input_tokens":52480,"cache_write_input_tokens":0,"output_tokens":329,"reasoning_output_tokens":0}}`.
  On a resumed thread, these figures are cumulative.
- Rate limits are NOT in the exec stream. They come from:
  - `codex app-server` (stdio JSON-RPC): `initialize` {clientInfo}, then `account/rateLimits/read`, which returns:
    ```
    rateLimits: { limitId:"codex", primary:{usedPercent:int, windowDurationMins:300, resetsAt:<unix s>},
                  secondary:{usedPercent:int, windowDurationMins:10080, resetsAt:<unix s>},
                  credits:{hasCredits, unlimited, balance}, planType:"plus", rateLimitReachedType, spendControlReached }
    rateLimitsByLimitId: { codex: … }, ordinaryUsageAllowed: true
    ```
    `account/rateLimits/updated` is pushed as a notification while the app-server runs.
    `account/usage/read` gives lifetime and daily token counts. `account/read {refreshToken:true}`
    tells a live sign-in from a dead one.
  - Session files (non-ephemeral only): each `token_count` event carries `rate_limits` with
    `used_percent` as a float, but the values seen were whole numbers (`1.0`).
- Before: primary 0%, weekly 0%. After 10 runs (about 380k input tokens, mostly cached): primary
  1%, weekly 0%. After 14 runs: still 1% / 0%.
- **The resolution is one whole percent.** A small run moves nothing. "Limn's share = the sum of the
  rise across each run" would round most runs to 0. The share must be measured over a SPAN instead:
  the rise in `usedPercent` from when Limn's first run of a period started to now, with no one else
  using Codex during that span. Or the share can be token-weighted: Limn's tokens divided by the
  account's total tokens for that window (from `account/usage/read`) and multiplied by the window's
  `usedPercent`. The weekly window is coarser still.

### 7. SDK vs CLI

The SDK spawns `exec --experimental-json` with `--config` overrides, `--model`, `--sandbox`, `--cd`,
`--skip-git-repo-check`, `--output-schema <temp file>`, effort, `web_search`, `approval_policy`,
and `resume <id>`.

- There is no option for `--ephemeral`, `--ignore-user-config`, `--strict-config` or
  `--dangerously-bypass-hook-trust`. A `codexPathOverride` shell wrapper that inserts them after
  `exec` worked.
- `config: {mcp_servers: …}` works (it serialises nested TOML).
- `env` replaces `process.env` entirely, so `PATH`, `HOME` and `CODEX_HOME` must be passed.
- `signal` kills the child.
- Recommendation: **spawn the CLI directly** (one argv builder, every flag visible and unit-tested).
  The SDK adds a wrapper indirection and hides the CLI's stderr, which is the only place refusals
  appear.

### 8. Models

From `codex debug models`, for the Plus account (every model has a 272k context window and a
`fast` tier, "2x speed, increased usage"):

| Model | Description | Efforts |
|---|---|---|
| `gpt-6-astra` | "Frontier intelligence for the most demanding work" | low…ultra |
| `gpt-6.1-sol` | "Latest workhorse"; the CLI default | low…ultra |
| `gpt-6-sol` | previous workhorse | low…ultra |
| `gpt-6-luna` | "Fast and affordable" | low…max |
| older models | `gpt-5.6-sol/terra/luna`, `gpt-5.5` | — |

- `gpt-6-astra` answered on Plus (run 14, 4 s).
- Suggested mapping:
  - **deep** (reviews, fixes, plans, resolver) = `gpt-6-astra` at `high`;
  - **standard** (ticket review, diagrams, docs, CI review) = `gpt-6.1-sol` at `medium`;
  - **fast** (one-shots: briefs, themes, summaries) = `gpt-6-luna` at `low`.
- Do not use the `fast` service tier: it costs more of the plan.
- Quality was not judged. That is Phase 5.

### 9. Cancellation

- SDK `AbortSignal` at 2.5 s: the run rejected at 2.59 s with `AbortError`. Events before that:
  `thread.started`, `turn.started`. No child process was left.
- CLI `SIGTERM` after the first message: exit code 0 in about 20 ms, no process left. Events:
  `thread.started`, `turn.started`, `item.completed:agent_message`.
- Neither path emits `turn.completed`, so **a cancelled turn's tokens are not reported**.

### 10. Timing

| Run | Route | Wall time | Input tokens (cached) | Output tokens | Outside file |
|---|---|---|---|---|---|
| 4 | MCP reads, shell off | 15.1 s | 79,402 (52,480) | 329 | refused |
| 11 | shell on, read-only sandbox | 7.6 s | 28,223 (18,176) | 383 | **read** (`cat ../outside/secret.env` succeeded) |

The base prompt alone is about 8k tokens with a private `CODEX_HOME`, and about 14.5k with the
user's home (skills and other extras).

## Plan changes

**§ 2 ("Not settled")**: replace the paragraph with the settled answers:

- The SDK cannot pass `--ignore-user-config` or `--ephemeral`, so use the CLI directly.
- `project_doc_max_bytes=0` is required to stop `AGENTS.md`. A trust override does not stop it.
- The repo `.codex/` layer loads only for a project trusted in the user config file, so
  `--ignore-user-config` removes it.
- The login is per `CODEX_HOME` (`auth.json` file storage). An empty private home gets 401.
- New rows:
  - user skills come in through `HOME`: `skills.include_instructions=false`;
  - `view_image` reads images: `features.view_image=false`;
  - MCP tools need `default_tools_approval_mode="approve"` under `approval_policy="never"`;
  - `workspace-write` makes `/tmp` and `$TMPDIR` writable unless excluded.

**§ 3.2 (runner)**:

- Add `--strict-config`.
- Add `-c features.view_image=false`, `-c skills.include_instructions=false`,
  `-c mcp_servers.workspace.default_tools_approval_mode="approve"`,
  `-c sandbox_workspace_write.exclude_slash_tmp=true` and
  `-c sandbox_workspace_write.exclude_tmpdir_env_var=true`.
- Refusals are on stderr only, so capture stderr and verify edits with `git diff`.
- Usage on a resumed turn is cumulative, so store deltas.
- Filter the bypass-flag warning `error` items.

**§ 3.3 (MCP + hook)**:

- The hook is feasible per run. Prefer a **Limn-owned `CODEX_HOME`** (`~/.limn/codex`) that holds:
  - its own `codex login`;
  - a `config.toml` with only the `hooks.state` trust entry for the session-flag hook (its hash is
    the handler's content hash, computed at build time or read from `hooks/list`);
  - session files for validation retries.
- This drops `--ignore-user-config`, because the config is Limn's own, and avoids
  `--dangerously-bypass-hook-trust`.
- Fallback: the user's `~/.codex` with `--ignore-user-config --dangerously-bypass-hook-trust`.
- ⚠ An untrusted hook is skipped SILENTLY. The runner must check `hooks/list` (or a canary deny)
  before trusting the guard.

**§ 3.4 (results)**:

- Schemas must be in strict form (`additionalProperties:false`, all keys required, nullable for
  optional).
- A validation retry is `exec resume` in the Limn `CODEX_HOME` (non-ephemeral), or a fresh run
  carrying the error.

**§ 3.6 / § 8.1 (budget)**:

- Read the windows from `codex app-server` `account/rateLimits/read` (primary 300 min, secondary
  10080 min, integer `usedPercent`, `resetsAt` Unix seconds).
- The 1% resolution rules out per-run rise sums. Measure Limn's share over a span, or weight the
  window's `usedPercent` by Limn's share of `account/usage/read` tokens.
- A cancelled run has no token figure, so the ledger stores null tokens for it.
- `account/read {refreshToken:true}` is the sign-in check for `detect()`, not `login status`.

**§ 6 (decisions)**:

- Decision 4 is resolved: per-run hooks work (Limn-owned `CODEX_HOME`, or the bypass flag).
- New decision: should Limn have its OWN Codex sign-in (`~/.limn/codex`, one extra `codex login`),
  or run against the user's `~/.codex` with the bypass flag?
- Decision 3 changes: a ChatGPT budget can only be a percentage of the window, measured in whole
  percent. A per-run token ceiling is not enforceable mid-run, only by cancelling.

**§ 7 (risks)**:

- MCP reads measured at about 2× time and 3× input tokens on a tiny repo.
- The shell fallback is unsafe, because the read-only sandbox lets `cat` read any file (measured).
  Remove the shell fallback from the plan.

**§ 8 (models)**: pin deep = `gpt-6-astra`, standard = `gpt-6.1-sol`, fast = `gpt-6-luna`.
Re-check this on every CLI bump with `codex debug models`.

**§ 5 (Phase 2b)**: add tests for the hook trust check and the `/tmp` exclusion. The `debug
prompt-input` tool gives a free, model-less check that the locked prompt has no `AGENTS.md`, no
skills and no extra tools. Use it in the opt-in live test.
