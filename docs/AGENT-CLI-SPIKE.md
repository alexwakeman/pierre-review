# Spike: OpenCode over ACP (Phase 0 of AGENT-CLI-PLAN.md)

Status: IN PROGRESS (2026-11-24). Part A (no model needed) is DONE. Part B (a model turn) is BLOCKED on
a credential (§ Blocked). Plan: [AGENT-CLI-PLAN.md](AGENT-CLI-PLAN.md). Scripts:
[scripts/spikes/opencode/](../scripts/spikes/opencode/README.md) — re-runnable anywhere with Node 22.

Measured on **OpenCode 1.19.6** (npm `opencode-ai`, published 2026-11-17), Linux x64, in a Claude Code
cloud container. Every finding is from a run, not from docs, unless it says so.

## Plan changes (these overrule AGENT-CLI-PLAN.md)

1. ⚠ **A REVIEWED REPOSITORY CAN RUN CODE IN OPENCODE AND WIDEN ITS PERMISSIONS** unless project config
   is switched off. With OpenCode's defaults, a fixture repository carrying `.opencode/plugins/evil.js`
   ran that file as soon as OpenCode started — on `opencode debug config`, before any session or model.
   The same repository's `opencode.json` (`"permission": {"*": "allow"}`, `"instructions":
   ["AGENTS.md"]`) OVERRODE Ensemble's global config, and its `.opencode/agent/planted.md` loaded as an
   agent. **`OPENCODE_DISABLE_PROJECT_CONFIG=1` stops all three** (measured: plugin not run, agent not
   found, Ensemble's permission and instructions kept). It is MANDATORY on every OpenCode process
   Ensemble starts, host and sandbox alike — the plan's § 5 "Isolation" must name it.
2. ⚠ **OPENCODE ALLOWS EVERY TOOL BY DEFAULT.** The built-in `build` agent's ruleset starts
   `{"*": "allow"}` (bash included); only `doom_loop`, `external_directory` and `*.env` reads ask. So a
   permission request reaches Ensemble only when Ensemble's config says so. Ensemble's global config sets
   `"permission": {"*": "ask"}`; the rules are LAST-MATCH-WINS, and with project config off that rule is
   the last one (measured with `opencode debug agent build`). Whether every built-in tool then really asks
   over ACP is Part B's first question.
3. **OpenCode ships a KEYLESS built-in provider** (`opencode`, `apiKey: "public"`,
   `https://opencode.ai/inference/openai/v1`): free models, no sign-in, code sent to OpenCode's servers.
   Ensemble's config must pin `enabled_providers` to the one provider the run uses.
4. **First start runs an npm install**: `@opencode-ai/plugin` at OpenCode's own version (1.19.6) into
   `<XDG_CONFIG_HOME>/opencode/node_modules`, from `registry.npmjs.org` (15 connections), EVEN with
   `OPENCODE_PURE=1` and default plugins off. Once present it is not fetched again. Ensemble's install step
   (Settings → AI, docs/PACKAGING.md) must pre-provision it, so a RUN never reaches npm.
5. **The model catalog needs no network.** With `OPENCODE_DISABLE_MODELS_FETCH=1` and an empty cache,
   OpenCode still lists 20 Anthropic models from a catalog built into the binary. Without the flag it
   fetches `models.opencode.ai` (a 6.9 MB `models.json` in the cache). `OPENCODE_MODELS_PATH` exists for a
   catalog Ensemble pins (not yet tried).
6. **The SDK is not needed.** `@agentclientprotocol/sdk` 2.x changed its API (`ClientApp`, no
   `ClientSideConnection`); the spike speaks raw JSON-RPC over ndjson instead — four methods
   (`initialize`, `session/new`, `session/prompt`, and answering `session/request_permission`). Ensemble's
   transport can do the same, with no SDK in the manifest.

## Part A — no model (DONE)

| Check | Result |
|---|---|
| Isolation (XDG) | With `HOME` and the four `XDG_*` variables pointed at Ensemble's home, every file OpenCode wrote was inside it: `opencode.log` and `opencode.db` (+ `-wal`, `-shm`; the session history) under `data/opencode`, the model cache and `bin/` under `cache/opencode`, the plugin package under `config/opencode`. Outside it: only an EMPTY `/tmp/opencode` (its temp dir). |
| The reader's config | Not read: OpenCode's paths (`opencode debug paths`) all resolve under Ensemble's home. Also set: `OPENCODE_DISABLE_CLAUDE_CODE` (OpenCode otherwise reads Claude Code's files — `CLAUDE.md`, `~/.claude/skills`), `OPENCODE_DISABLE_EXTERNAL_SKILLS` (`~/.claude/skills`, `~/.agents/skills`). |
| Project config | Plan change 1. |
| Default permissions | Plan change 2. |
| Keyless provider | Plan change 3. |
| ACP handshake | `opencode acp --cwd <dir>` answers `initialize` in ~0.9 s: protocol 1; `loadSession`, `session` close/fork/list/resume; MCP over http and sse (stdio servers work too, below); prompt images and embedded context; one auth method, "Login with opencode". |
| MCP passthrough | A stdio MCP server named in `session/new` `mcpServers` was STARTED by OpenCode (its log: `started`). Whether the model sees and calls its tools: Part B. |
| `session/new` | Returns the session id and two config options: `model` (current value from Ensemble's config; its option list is EMPTY with no credential) and `mode` (`build`, `plan`). It also sends `available_commands_update` (OpenCode's built-in `customize-opencode` skill). |
| Network, idle | Through a logging proxy, 20–30 s idle after the handshake: **locked** (the lockdown env below) — no connection at all once the plugin package is in place; **open** (OpenCode's defaults) — `models.opencode.ai` (the catalog) and `registry.npmjs.org`. |
| Session files | Saved, resumable sessions (`opencode.db`). Deleting a settled run's session (OpenCode's `session` commands or the ACP `session/close`) is Part B. |

**The lockdown environment** (every OpenCode process; the run's environment is an ALLOW-list —
`PATH`, `HOME`, the four `XDG_*`, the proxy and CA variables, and the ONE provider key):

```
OPENCODE_DISABLE_PROJECT_CONFIG=1   OPENCODE_DISABLE_CLAUDE_CODE=1   OPENCODE_DISABLE_EXTERNAL_SKILLS=1
OPENCODE_DISABLE_DEFAULT_PLUGINS=1  OPENCODE_DISABLE_AUTOUPDATE=1    OPENCODE_DISABLE_LSP_DOWNLOAD=1
OPENCODE_DISABLE_MODELS_FETCH=1     OPENCODE_PURE=1
```

**Ensemble's global config** (`<home>/config/opencode/opencode.json`; `setup.sh` writes it): the model,
`enabled_providers` = its provider only, `autoupdate: false`, `share: "disabled"`, `snapshot: false`,
`lsp: false`, `formatter: false`, `plugin: []`, `instructions: []`, `permission: {"*": "ask"}`.
⚠ The published schema (`https://opencode.ai/config.json`) marks several of these keys DEPRECATED in favour
of newer ones (`permissions` rulesets, `policies`, `update`, `snapshots`, `plugins`); 1.19.6's
`opencode debug config` dropped `update`, `websearch` and `warming` from the resolved config. Part B checks
which spelling 1.19.6 actually enforces before Ensemble relies on any of them.

## Part B — a model turn (BLOCKED)

**Blocked on a credential.** The plan's step 1 uses the owner's Anthropic API key (Claude Haiku). In a
Claude Code cloud environment that key cannot go through the network proxy (no secret can be saved for
Anthropic's own hosts); it can go only in an environment VARIABLE, which everyone using the environment and
any command in its sessions can read. The owner decides; a new session picks it up. On the owner's own
Mac the key works as an ordinary variable for `run.sh`.

To run, in this order (`run.sh <prompt> [policy] [locked|open]`):

1. `review` — the model reads through `workspace_read_file` / `workspace_list_files` and answers through
   `workspace_submit_review`; the answer reaches `result.json`. Does each MCP call arrive as a permission
   request, and under what title / `toolCall` shape (the `ensemble` policy matches on the tool name)?
2. `bash` — does the built-in bash ASK (and stop on a refusal), or run? ⚠ The make-or-break check.
3. `outside` — the built-in read of a file outside the project: asks (`external_directory`) or refused?
   And the MCP `read_file` of `../outside/secret.env`: refused by the path guard?
4. `inject` — does the fixture's `AGENTS.md` reach the model with project config OFF? (OpenCode loads
   `AGENTS.md` as a rule file by default; `OPENCODE_DISABLE_PROJECT_CONFIG` may not cover it.)
5. Usage: tokens and US$ in the ACP stream (`usage_update` / the prompt result), or only in `opencode.db`
   / `opencode stats`?
6. Session files: delete a settled session; what remains in `opencode.db`.
7. Each of 1–4 again with `open` — the defaults — to record what the lockdown changes.
8. Network during a turn (`SPIKE_LOG_PROXY=1`): only `api.anthropic.com`?

Not in this spike yet: the `serve` transport (compare after Part B), the sandbox (needs Docker; the
owner's Mac), OpenRouter (step 2 of the plan's test credentials).
