# Plan: more agent CLIs (opencode, Gemini CLI, Copilot CLI, Grok Build)

Status: SCOPE ONLY (2026-11-23). Nothing is built. Phase 0 (the spikes) decides the details; its
findings will overrule this plan the way [CODEX-SPIKE.md](CODEX-SPIKE.md) overruled
[CODEX-PLAN.md](CODEX-PLAN.md).

**Scope rule: LOCAL AGENT CLIs ONLY.** Ensemble drives an agent program on the reader's computer, as it
does Claude Code and Codex. Ensemble does NOT run its own agent loop against a model API. Open-weight
models and OpenRouter come in through a CLI that supports them (opencode), never through a direct API
call from Ensemble.

## 1. Why

Today every AI feature needs a Claude or a ChatGPT account. More CLIs open the app to:

- teams that already pay for **GitHub Copilot** seats (Claude, GPT and Gemini models, no new vendor);
- **Gemini** users (Google login, Gemini API key or Vertex);
- **Grok** users (SuperGrok / X Premium+);
- **open-weight models**: any model on OpenRouter, or a LOCAL model (Ollama, LM Studio) with no
  account at all. A local model fits "runs only on your machine" better than anything else.

## 2. The finding that shapes the plan

Every target CLI speaks the **Agent Client Protocol (ACP)**: JSON-RPC over stdio, the agent as server,
the tool that drives it as client.

| CLI | ACP | Headless alternative | Model access | Notes |
|---|---|---|---|---|
| **opencode** | `opencode acp` | `opencode run --format json` | OpenRouter key; Ollama / LM Studio (no account) | The open-weight harness. Models as `provider/model`. |
| **Gemini CLI** | `gemini --acp` (older builds: `--experimental-acp`) | `-p --output-format stream-json` | Google login, Gemini API key, Vertex | Hooks on by default since v0.26. |
| **GitHub Copilot CLI** | `copilot --acp` (public preview) | `-p` | the reader's Copilot seat (premium requests) | A separate Copilot SDK also exists (JSON-RPC to the CLI). |
| **Grok Build** | `grok agent stdio` | `grok -p --output-format json\|streaming-json` | SuperGrok / X Premium+ | Beta. `--no-auto-update` for headless and ACP runs. |

**THE DECISION: ONE ACP PROVIDER, ONE PROFILE PER CLI.** One ACP client serves all four (and any later
ACP agent). Each CLI adds a thin PROFILE for what ACP does not cover (§ 5). Claude and Codex keep their
own providers (`ai/providers/claude.ts`, `ai/providers/codex.ts`) unchanged — they are hardened and
tuned, and nothing here touches them.

**Rejected as the main open-weight path: Codex pointed at OpenRouter** (`model_providers`, or
`codex --oss` for local models). It would reuse Ensemble's hardened Codex harness, but Codex is tuned for
GPT models, needs the Responses API (it dropped `wire_api = "chat"` in February 2026) and labels every
non-OpenAI model "Unknown model". Keep it as a cheap Phase 0 comparison only.

## 3. Host runs (`AgentProvider.runAgent` / `complete`)

The review, CI review, ticket review, Check threads, diagrams, sprint paths, story docs, the docs build
and chat, the review chat, and one-shot completions.

- Ensemble starts the CLI in ACP mode, in its OWN home (§ 5), with the run's `cwd`.
- `session/new` passes Ensemble's MCP servers:
  - the **workspace read tools** — the SAME server Codex reads through today (`read_file`,
    `list_files`, `search`), behind `review/path-guard.ts`;
  - the **result tools** (`submit_review`, `submit_fix`, …), built from the SAME zod shapes
    (`ai/result-schemas.ts`). The answer is zod-parsed; a shape issue earns ONE retry, as on Codex.
- **Permissions are the allow-list.** Every built-in tool call the agent wants arrives as
  `session/request_permission`. Ensemble answers from ONE rule: Ensemble's own MCP tools allowed
  (path-checked), everything else denied. This fails CLOSED by design — unlike Codex, where an
  untrusted hook is skipped SILENTLY and `verifyHookTrusted` has to prove it runs.
- ⚠ **THE THING EVERY SPIKE MUST PROVE**: each CLI's built-in tools (shell, web fetch, its own file
  reads) either ASK through ACP or can be switched OFF outright (Gemini's tool exclusion settings,
  Copilot's `--deny-tool`, opencode's permission config, Grok's equivalent). A built-in tool that acts
  without asking bypasses the path guard. A CLI that cannot prove this does not ship.
- Progress maps onto the NEUTRAL RUN STREAM (`spec.onProgress`: `step`, `outcome`). Runners read
  nothing else, so no runner changes.
- Prompts: tool references are rendered per provider by `ai/prompt-tools.ts` (a third rendering
  target); whole-sentence swaps like `review/codex-wording.ts`. ⚠ Claude's prompts stay byte-identical
  (`prompt-golden.json`). The writing rules (`ai/writing-rules.ts`) are appended at the door, as today.
- `describeImage` and `openSession` (the story chat's warm session) are OPTIONAL capabilities — absent
  until a profile proves them.

## 4. Sandbox sessions (Implement, AI Fix — `sandbox/drivers/`)

- The CLI runs INSIDE the container through `runtime.exec`, as Claude and Codex do. ACP events map
  onto the ONE normalised event, `SandboxAgentEvent` (`text`, `tool_call`, `tool_result`, `turn_end`,
  `error`). The build tab changes nothing.
- **Chat vs build is a permission policy Ensemble answers per turn**: chat denies writes and shell,
  build allows them. Cleaner than Claude's `set_permission_mode` or Codex's per-turn sandbox policy.
  Every server-to-client request outside the policy is refused (the Codex rule: nothing refreshes a
  credential inside the sandbox).
- The driver takes the run choice from `resolveSandboxAgentChoice` and picks nothing itself
  (`provider-seam.test.ts` § the sandbox agents gains the new driver).
- **CREDENTIAL INJECTION IS PER CLI, AND THE HARDEST PART.** The rule is unchanged: the real secret
  lives only in the proxy's memory; the sandbox holds a placeholder.
  - opencode + OpenRouter: a bearer key. The proxy injects `Authorization` for `openrouter.ai`.
    Simpler than Codex's fake JWTs.
  - opencode + local Ollama / LM Studio: no credential. The proxy needs a route from the sandbox to
    the host's model port (a new allow-list entry kind: a host-local port, never the whole host).
  - Copilot and Gemini OAuth logins: UNKNOWN until spiked — token shape, refresh, and whether a
    refresh can be blocked inside the sandbox.
  - Grok Build: UNKNOWN until spiked.
- A CLI whose credential cannot be injected safely ships for **host runs only** (owner decision § 10).

## 5. The per-CLI profile (what ACP does not give)

Each profile answers the same questions. Expect a CODEX-SPIKE-sized set of measurements per CLI.

- **Isolation.** Its own home under `~/.ensemble/<cli>`. ⚠ The reader's own config (`~/.gemini`,
  `~/.copilot`, `~/.config/opencode`, `~/.grok`) is NEVER read or written — the `~/.codex` rule.
  Auto-update, telemetry, plugins, extensions, memories and remote features off; measured, not assumed
  (Codex's lockdown did not stop all traffic until round 4).
- **Environment.** An ALLOW-list environment for every process it starts (`codexBaseEnv`'s rule).
- **Session files.** Where it writes history; deleted when a run settles, swept, erased with the
  account (`ai/codex/rollouts.ts`, `ai/codex/threads.ts`).
- **Process control.** Its own process group; every stop signals the group; an Ensemble killed by a
  signal kills it first.
- **Models.** The list it offers, mapped to the depth roles (`deep` / `standard` / `fast`), and which
  are offered in the menus.
- **Usage and cost.** ACP does not standardise either. Each profile reports what its CLI exposes:
  - opencode + OpenRouter: tokens, likely US$;
  - opencode + local: tokens, US$ 0 (a real zero: nothing was billed);
  - Copilot: premium requests at best;
  - Gemini login, Grok subscription: probably UNKNOWN.
  ⚠ Unknown is never zero. ⚠ The spend budget's automatic-run gate (`review/budget-gate.ts`) must say
  what an AUTOMATIC run does when usage is unknown (owner decision § 10).
- **Install.** A pinned version, installed at boot into the runtime directory when picked in Settings →
  AI (docs/PACKAGING.md); `absent` when not picked, whatever is on disk. No SDK in the npm manifest.
- **Sign-in.** Through the CLI's own login, into Ensemble's home for it (`ensemble ai login <cli>` and
  Settings), as for Codex. Ensemble stores no key itself.

## 6. The refactor that comes first (Phase 1)

`'claude' | 'codex'` is hard-wired across about 100 backend and 14 frontend files. It becomes a
**registry of provider records**. Each record holds:

- the run kinds it can run (replaces `CODEX_AGENT_KINDS`, `codexRunnable`);
- its billing kind: US$, share of a subscription, premium requests, unknown;
- capabilities: vision, warm sessions, sandbox support;
- its model roles (replaces `CLAUDE_MODEL_FOR_ROLE` / `CODEX_MODEL_FOR_ROLE` as the only two).

What changes with it:

- `AiProviderId`, `AiBudgetProvider`, `AiProviderSetting` (packages/shared) — open unions or a list.
- `requestModelOf` — maps a stored model to the SAME ROLE on the provider about to run, not always back
  to Claude.
- `aiRunLabel`, `aiProviderName`, `aiModelChoiceLabel` — one spelling per provider, still ONE function.
- `/api/me` `ai.providers` — one entry per registered provider.
- Run profiles (`ai/run-profile.ts`) — per vendor, for N vendors.
- The pair review (`reviewPairProviders`) — "any two picked providers", or stays Claude + Codex
  (owner decision § 10).
- `pickAutoProvider` — the `auto` rule with more than two candidates.
- The model pickers (`lib/modelPick.ts`, `ModelPicker.tsx`).
- Reports → AI usage, `runCostText`, `usageCostText` — the new billing kinds.

⚠ Phase 1 adds NO provider and changes NO behaviour: every prompt golden and every test stays as it is.

## 7. The quality risk

Open-weight models through opencode will vary widely. Many will fail the result-tool contract or write
weak reviews. Needed before any of them reaches a menu:

- **An eval harness**: fixture PRs with known findings (and known non-findings), scored per CLI and
  model — finding recall, false findings, result-contract failures, turns, tokens.
- **A "tested" marker** in the picker for models that pass.
- **Capability gates per kind**: e.g. deep review and AI Fix only on tested models with enough context
  and reliable tool calls.

## 8. Security

docs/SECURITY.md gains a section in the same commit as the first CLI.

- Anything an agent reads from a PR stays UNTRUSTED.
- The path guard is the allow-list answer to `session/request_permission` plus Ensemble's MCP tools.
- **Data leaves the machine to the CLI's model host.** For opencode + OpenRouter, that is a third-party
  inference provider OpenRouter routes to. Default to OpenRouter's zero-data-retention routing and
  say which host ran (owner decision § 10). A local model sends nothing.
- A new route that spends money or quota needs a rate-limit tier (`tierFor`).

## 9. Phases

0. **Spikes.** ONE ACP client, pointed at all four CLIs. Per CLI, measure: the lockdown, the
   permission flow (do built-in tools ask?), MCP passthrough, the result tool, usage reporting,
   session files, idle network traffic, and sandbox credential injection. Also run Codex → OpenRouter
   as a comparison. Write the results to `docs/AGENT-CLI-SPIKE.md`.
1. **The registry refactor** (§ 6). No new provider.
2. **opencode on host runs** (OpenRouter + Ollama / LM Studio), with the eval harness (§ 7). The
   open-weight and local-first headline.
3. **Copilot CLI on host runs.** Probably the biggest market unlock (teams with Copilot seats).
4. **Gemini CLI, then Grok Build** on host runs. Grok Build is still beta.
5. **Sandbox support per CLI** (§ 4), each once its credential injection is proven.

Each phase updates the user docs (`/docs`), `CHANGELOG.md` Unreleased, Settings → AI copy and the
landing mocks that show provider choice, in the same commit.

## 10. Owner decisions

1. **Terms.** Each vendor's terms on a third-party app driving its CLI and login — the same kind of
   question as the Anthropic-terms rule in CLAUDE.md. Hits Copilot, Gemini's Google login and Grok's
   subscription most.
2. **Host-only CLIs.** Does a CLI that cannot run in the sandbox ship for host runs only?
3. **Unknown usage.** What an automatic run does when the provider's usage is unknown: refuse, allow
   with a per-workspace opt-in, or count runs instead.
4. **Untested models.** Shown in the picker (labelled), or hidden?
5. **The pair review.** Any two picked providers, or Claude + Codex only?
6. **OpenRouter routing.** Zero-data-retention only by default?
7. **`auto`.** Does `auto` ever pick one of the new CLIs, or only Claude / Codex?

## Sources (2026-11-23)

- opencode: [ACP](https://opencode.ai/docs/cli/acp/), [CLI](https://opencode.ai/docs/cli),
  [Ollama integration](https://docs.ollama.com/integrations/opencode)
- Gemini CLI: [ACP mode](https://geminicli.com/docs/cli/acp-mode/),
  [headless](https://geminicli.com/docs/cli/headless/),
  [hooks](https://developers.googleblog.com/en/tailor-gemini-cli-to-your-workflow-with-hooks/)
- Copilot CLI: [ACP preview](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/),
  [ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- Grok Build: [headless scripting](https://docs.x.ai/build/cli/headless-scripting),
  [product page](https://x.ai/cli)
- Codex + OpenRouter: [OpenRouter guide](https://openrouter.ai/docs/guides/coding-agents/codex-cli)
