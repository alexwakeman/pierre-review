# Plan: OpenCode as a third AI provider, through a generic agent-CLI seam

Status: SCOPE ONLY (2026-11-24). Nothing is built. Phase 0 (the spike) decides the details; its
findings will overrule this plan the way [CODEX-SPIKE.md](CODEX-SPIKE.md) overruled
[CODEX-PLAN.md](CODEX-PLAN.md).

**Scope rule 1: LOCAL AGENT CLIs ONLY.** Ensemble drives an agent program on the reader's computer, as
it does Claude Code and Codex. Ensemble never runs its own agent loop against a model API. Open-weight
models and OpenRouter come in through OpenCode, never through a direct API call from Ensemble.

**Scope rule 2: OPENCODE ONLY, FOR NOW.** The seam is built so that a later CLI (Gemini CLI, Copilot
CLI, Grok Build, …) is a new PROFILE, not a new provider. But this plan ships ONE profile, OpenCode, and
nothing in it may depend on a second CLI existing. Other CLIs are § 11 (out of scope).

## 1. Why OpenCode

Today every AI feature needs a Claude or a ChatGPT account. OpenCode opens the app to:

- **open-weight models** on OpenRouter (and any other model OpenRouter lists), on the reader's own
  OpenRouter key;
- **local models** (Ollama, LM Studio) with no account at all. Nothing leaves the machine. This fits
  "runs only on your machine" better than anything else Ensemble offers.

OpenCode is open source, takes models as `provider/model` (`openrouter/<model>`, `ollama/<model>`), and
can be driven three ways: the Agent Client Protocol (`opencode acp`), a one-shot JSON stream
(`opencode run --format json`), and its own HTTP server (`opencode serve`).

## 2. The shape: a factory seam, one profile

Two layers, kept apart so the second CLI costs a profile and nothing more.

| Layer | What it is | Built now |
|---|---|---|
| **The agent-CLI provider** (`ai/providers/agent-cli.ts`) | ONE `AgentProvider` that runs ANY agent CLI through a TRANSPORT and a PROFILE. It owns everything that is the same for every CLI: the MCP servers, the permission rule, the result tool, the neutral run stream, the ledger row, process control. | Yes |
| **The transport** (`ai/agent-cli/transport/`) | How Ensemble talks to the CLI. **ACP is the default** (the protocol other CLIs speak too). OpenCode's own `serve` API is the alternative the spike compares. | ACP; `serve` only if the spike picks it |
| **The profile** (`ai/agent-cli/profiles/opencode.ts`) | Everything ACP does not cover, for ONE CLI: install, home, lockdown, sign-in, models, usage, session files, sandbox credentials (§ 5). | OpenCode only |

`createAgentCliProvider(profile)` is the factory. The registry (§ 6) holds the result beside
`claudeProvider` and `codexProvider`. Claude and Codex keep their own providers
(`ai/providers/claude.ts`, `ai/providers/codex.ts`) unchanged — hardened and tuned, untouched by this
work.

⚠ **The transport is the spike's first question.** ACP keeps the seam generic. `opencode serve`
may report more (per-message tokens and cost, a permission event stream, sessions). If `serve` gives
facts ACP cannot, the profile may use it — but the TRANSPORT interface stays the same, so a later ACP-only
CLI still fits.

**Rejected: Codex pointed at OpenRouter** (`model_providers`, or `codex --oss` for local models). It
reuses Ensemble's hardened Codex harness, but Codex is tuned for GPT models, needs the Responses API (it
dropped `wire_api = "chat"` in February 2026) and labels every non-OpenAI model "Unknown model". Phase 0
runs it once as a comparison only.

## 3. Host runs (`AgentProvider.runAgent` / `complete`)

The review, CI review, ticket review, Check threads, diagrams, sprint paths, story docs, the docs build
and chat, the review chat, and one-shot completions.

- Ensemble starts OpenCode in its OWN home (§ 5), with the run's `cwd`.
- The session gets Ensemble's MCP servers:
  - the **workspace read tools** — the SAME server Codex reads through today (`read_file`,
    `list_files`, `search`), behind `review/path-guard.ts`;
  - the **result tools** (`submit_review`, `submit_fix`, …), built from the SAME zod shapes
    (`ai/result-schemas.ts`). The answer is zod-parsed; a shape issue earns ONE retry, as on Codex.
- **Permissions are the allow-list.** Every built-in tool call OpenCode wants reaches Ensemble as a
  permission request (ACP `session/request_permission`). Ensemble answers from ONE rule: Ensemble's own
  MCP tools allowed (path-checked), everything else denied. This fails CLOSED by design — unlike Codex,
  where an untrusted hook is skipped SILENTLY and `verifyHookTrusted` has to prove it runs.
- ⚠ **THE THING THE SPIKE MUST PROVE**: OpenCode's built-in tools (bash, edit, write, webfetch, its own
  read/grep/glob) either ASK through the transport or are switched OFF in OpenCode's config (its
  `permission` / `tools` settings). One third-party adapter reports that `opencode run` auto-approves
  every permission — so `run` is NOT a safe transport unless the config denies the tools outright. A
  built-in tool that acts without asking bypasses the path guard. If this cannot be proven, OpenCode does
  not ship.
- Progress maps onto the NEUTRAL RUN STREAM (`spec.onProgress`: `step`, `outcome`). Runners read
  nothing else, so no runner changes.
- Prompts: tool references rendered per provider by `ai/prompt-tools.ts` (a third rendering target);
  whole-sentence swaps like `review/codex-wording.ts`. ⚠ Claude's prompts stay byte-identical
  (`prompt-golden.json`). The writing rules (`ai/writing-rules.ts`) are appended at the door, as today.
- `describeImage` and `openSession` (the story chat's warm session) are OPTIONAL — absent until the
  spike proves them for OpenCode.

## 4. Sandbox sessions (Implement, AI Fix — `sandbox/drivers/`)

- OpenCode runs INSIDE the container through `runtime.exec`, as Claude and Codex do. A new driver,
  `sandbox/drivers/agent-cli.ts`, uses the SAME transport and profile and maps events onto the ONE
  normalised event, `SandboxAgentEvent` (`text`, `tool_call`, `tool_result`, `turn_end`, `error`). The
  build tab changes nothing.
- **Chat vs build is a permission policy Ensemble answers per turn**: chat denies writes and shell,
  build allows them. Every request outside the policy is refused (the Codex rule: nothing refreshes a
  credential inside the sandbox).
- The driver takes the run choice from `resolveSandboxAgentChoice` and picks nothing itself
  (`provider-seam.test.ts` § the sandbox agents gains the new driver).
- The sandbox image gains a pinned OpenCode (`apps/backend/sandbox-image/Dockerfile`).
- **Credentials.** The rule is unchanged: the real secret lives only in the proxy's memory; the
  sandbox holds a placeholder.
  - **OpenRouter**: a bearer key. The proxy injects `Authorization` for `openrouter.ai` over the
    placeholder. Simpler than Codex's fake JWTs.
  - **Local Ollama / LM Studio**: no credential. The proxy needs a route from the sandbox to the host's
    model port — a new allow-list entry kind (ONE host-local port, never the whole host). Threat-model
    it in docs/SANDBOX.md before it ships.

## 5. The OpenCode profile (what the transport does not give)

Expect a CODEX-SPIKE-sized set of measurements.

- **Isolation.** Its own home, `~/.ensemble/opencode` (config, data, cache, state — OpenCode follows
  the XDG directories, so each is pointed there). ⚠ The reader's own `~/.config/opencode` and
  `~/.local/share/opencode` are NEVER read or written — the `~/.codex` rule. A project's own
  `opencode.json` / `AGENTS.md` in a reviewed repo is UNTRUSTED input: turned off for host runs, as
  Codex's `project_doc_max_bytes=0`.
- **Lockdown.** Auto-update, sharing, telemetry, plugins and any remote features off; MEASURED, not
  assumed (Codex's lockdown did not stop all traffic until review round 4). One list, like
  `LOCKED_SETTINGS`.
- **Environment.** An ALLOW-list environment for every process it starts (`codexBaseEnv`'s rule).
- **Session files.** Where it writes history; deleted when a run settles, swept, erased with the
  account (`ai/codex/rollouts.ts`, `ai/codex/threads.ts`).
- **Process control.** Its own process group; every stop signals the group; an Ensemble killed by a
  signal kills it first.
- **Models.** Two sources, picked in Settings → AI:
  - OpenRouter: the reader's choice of model per depth role (`deep` / `standard` / `fast`);
  - local: the models Ollama / LM Studio report, mapped the same way.
  Only TESTED models are offered by default (§ 7).
- **The local notice** (decided 2026-11-24). Every local model carries ONE short notice where it is
  picked and on a run it labels: local models are smaller and less reliable than hosted ones, and
  reviews and fixes may miss things or fail. Plain English, behind an ⓘ where it needs more than one
  sentence (the product-voice rule). The notice does not replace the "tested" marker (§ 7): a local
  model is marked tested only when its OWN quantised weights passed the eval on Modal (§ 9).
- ⚠ **NO CLAUDE THROUGH OPENCODE.** The profile hides every Anthropic model, whether OpenCode would
  reach it directly (its "Anthropic (API key)" provider) or through OpenRouter (`openrouter/anthropic/*`).
  The picker points the reader to Ensemble's own Claude provider, which already runs on an API key FIRST
  BY DEFAULT (`resolveAiCredential`) and keeps what OpenCode would lose: the tuned prompts and goldens,
  the review specialists, effort and thinking, the rate-limit readings, the warm story-chat session and
  image description. One model, one route — so a "Claude Opus" label, its cost and its ledger row are
  never ambiguous. The refusal is checked at RUN time too (`resolveManualRunChoice`), not only hidden in
  the menu. A Claude Pro/Max login is never possible anyway: OpenCode removed it in v1.3.0 (March 2026)
  at Anthropic's legal request, and the lockdown turns off the community plugins that restore it.
- **The developer override.** `ENSEMBLE_OPENCODE_ALLOW_ANTHROPIC=true` lifts that exclusion, for testing
  the harness on a Claude API key (§ 9, Phase 0). It is an environment variable ONLY — never a Settings
  control, never on `/api/me`, never in user docs. Like every user-set `ENSEMBLE_X`, it is read through
  `env-name.ts` `readEnv` and listed in `USER_ENV_NAMES`. A run under it is labelled what it is
  ("OpenCode · Claude Haiku 5.5"), never as a run of Ensemble's Claude provider.
- **Usage and cost.**
  - OpenRouter: tokens, and US$ if OpenCode (or its `serve` API) reports it. Otherwise US$ is UNKNOWN —
    ⚠ never zero, and never priced from a table Ensemble keeps by hand.
  - Local: tokens, US$ 0. This is a real zero: nothing was billed.
  - ⚠ The spend budget's automatic-run gate (`review/budget-gate.ts`) must say what an AUTOMATIC run does
    when US$ is unknown (owner decision § 10).
- **Install.** A pinned version, installed at boot into the runtime directory when picked in Settings →
  AI (docs/PACKAGING.md); `absent` when not picked, whatever is on disk. No SDK in the npm manifest.
- **Sign-in.** OpenRouter: the key goes into OpenCode's own auth store in Ensemble's home
  (`ensemble ai login opencode` and Settings) — Ensemble keeps no key of its own. Local: no sign-in; a
  check that the model server answers.

## 6. The seam refactor (Phase 1)

`'claude' | 'codex'` is hard-wired across about 100 backend and 14 frontend files. It becomes a
**registry of provider records**. Each record holds:

- the run kinds it can run (replaces `CODEX_AGENT_KINDS`, `codexRunnable`);
- its billing kind: US$, share of a subscription, unknown;
- capabilities: vision, warm sessions, sandbox support;
- its model roles (replaces `CLAUDE_MODEL_FOR_ROLE` / `CODEX_MODEL_FOR_ROLE` as the only two).

What changes with it:

- `AiProviderId`, `AiBudgetProvider`, `AiProviderSetting` (packages/shared) — one list.
- `requestModelOf` — maps a stored model to the SAME ROLE on the provider about to run, not always back
  to Claude.
- `aiRunLabel`, `aiProviderName`, `aiModelChoiceLabel` — one spelling per provider, still ONE function
  ("OpenCode · Qwen3 Coder (OpenRouter)", "OpenCode · Llama (local)").
- `/api/me` `ai.providers` — one entry per registered provider.
- Run profiles (`ai/run-profile.ts`) — per vendor, for N vendors.
- The pair review (`reviewPairProviders`) — stays Claude + Codex unless decided otherwise (§ 10).
- `pickAutoProvider` — `auto` with more than two candidates.
- The model pickers (`lib/modelPick.ts`, `ModelPicker.tsx`).
- Reports → AI usage, `runCostText`, `usageCostText` — the "unknown" billing kind and the local zero.

⚠ Phase 1 adds NO provider and changes NO behaviour: every prompt golden and every test stays as it is.
⚠ The registry is N-shaped, but no code may assume a CLI beyond OpenCode.

## 7. The quality risk

Open-weight models will vary widely. Many will fail the result-tool contract or write weak reviews.
Before any of them reaches a menu:

- **An eval harness**: fixture PRs with known findings (and known non-findings), scored per model —
  finding recall, false findings, result-contract failures, turns, tokens.
- **A "tested" marker** in the picker for models that pass.
- **Capability gates per kind**: e.g. deep review and AI Fix only on tested models with enough context
  and reliable tool calls.

## 8. Security

docs/SECURITY.md gains a section in the same commit as OpenCode ships.

- Anything an agent reads from a PR stays UNTRUSTED.
- The path guard is the allow-list answer to permission requests, plus Ensemble's MCP tools.
- **OpenRouter sends the code to a third-party inference host** that OpenRouter picks. Default to
  OpenRouter's zero-data-retention routing and say which host ran (owner decision § 10). A local model
  sends nothing.
- A new route that spends money or quota needs a rate-limit tier (`tierFor`).

## 9. Phases

0. **The spike** (`docs/AGENT-CLI-SPIKE.md`). OpenCode only. Measure:
   - ACP vs `serve` vs `run --format json` — which transport gives permissions, usage and a result tool;
   - the permission flow: do built-in tools ask, and can they be denied or switched off?
   - MCP passthrough (the workspace server and a result tool);
   - isolation: the XDG home, no read of the reader's config, project config ignored;
   - idle network traffic with the lockdown;
   - usage reporting on OpenRouter and on Ollama;
   - session files written, and how to delete them;
   - sandbox: the OpenRouter key injected through the proxy; a route to a host-local Ollama.
   - Comparison: one Codex → OpenRouter run on the same fixture.

   **Test credentials — two, IN ORDER, each for what only it can show:**

   | Step | Credential | Model | Tests |
   |---|---|---|---|
   | 1. Harness first | The owner's Anthropic API key (under the developer override, § 5) | Claude Haiku | the HARNESS: transport, permission flow, MCP passthrough, isolation, lockdown traffic, session files, process control, the run-stream mapping. Claude is the most forgiving tool-caller, so a failure here is a harness failure, not a model one. ⚠ It cannot show how open-weight models behave — a harness that passes on Claude can still fail on them. |
   | 2. Then the real test | OpenRouter credits, bought from OpenRouter directly once step 1 passes (a credit limit set on the key) | the open-weight models Ensemble would list | tool-call reliability, the result-tool contract, retries and loops; OpenRouter's usage and US$ through OpenCode; zero-data-retention routing; the sandbox proxy injecting a key for `openrouter.ai`; the eval runs (§ 7) |

   OpenCode's own model gateway is NOT used: billing stays on OpenRouter, the route readers will take.

   ⚠ **NO LOCAL MODEL ON THE OWNER'S MACHINE** (it cannot run one). The local route is tested on
   **Modal** instead (the GPU cloud the ML model build used), in two parts:
   - **Quality, on the REAL quantised weights.** A Modal GPU container runs Ollama with the SAME model
     tags (the same quantisation) a reader would pull, as an HTTPS endpoint. The owner's OpenCode, in
     Ensemble's home, points its Ollama provider at that endpoint, and the eval harness (§ 7) runs
     against it. This is the real local model, only on another computer — unlike an OpenRouter run of
     the same weights, which is usually not quantised.
     - ⚠ The endpoint is PRIVATE: Modal's proxy authentication (a token on every request), never an
       open URL — an open Ollama endpoint is a free GPU for anyone who finds it. The token goes in the
       spike's OpenCode config only, never in the repo.
     - ⚠ Scale to zero when idle, and a timeout on the container: a GPU left running costs money by
       the second.
     - ⚠ The GPU must be one a reader might own (e.g. 24 GB of memory), or the test flatters the model:
       a bigger GPU allows a bigger quantisation or context than the reader gets.
   - **Plumbing, on `localhost` for real.** The endpoint above is remote, so it does NOT prove the local
     plumbing. That needs Ollama, OpenCode and Ensemble on ONE Linux machine: the provider config, the
     model list, the "server answers" check, US$ 0 on the ledger. A tiny model on CPU is enough, because
     only the plumbing is under test. Run it in a Modal container, a cloud container or CI.
   - ⚠ **The sandbox-to-host route is NOT tested on Modal**: an Implement or AI Fix session needs Docker
     (or Podman) on the machine, and a Modal container cannot run one. Test that route on a Linux
     machine with Docker (CI, or a cloud VM), again with a tiny model.

1. **The seam refactor** (§ 6). No new provider.
2. **The agent-CLI provider + OpenCode profile on host runs** (OpenRouter + Ollama / LM Studio), with
   the eval harness (§ 7).
3. **OpenCode in the sandbox** (§ 4).

Each phase updates the user docs (`/docs`), `CHANGELOG.md` Unreleased, Settings → AI copy and the
landing mocks that show provider choice, in the same commit.

## 10. Owner decisions

1. **Unknown US$.** What an automatic run does when OpenRouter's cost is unknown: refuse, allow with a
   per-workspace opt-in, or count runs instead.
2. **Untested models.** Shown in the picker (labelled), or hidden?
3. **The pair review.** Stays Claude + Codex, or may OpenCode be one half?
4. **OpenRouter routing.** Zero-data-retention only by default?
5. **`auto`.** Does `auto` ever pick OpenCode, or only Claude / Codex?
6. **Sandbox-to-host route.** Is a route from the sandbox to a host-local model port acceptable?
7. **OpenAI models on an OpenAI API key.** Ensemble's Codex provider REFUSES an OpenAI API key until it
   can price one (`CODEX_PRICES_PER_MTOK`; docs/CODEX-PLAN.md). OpenCode could run OpenAI models on that
   key (directly, or `openrouter/openai/*`), and so would be the only way in for an OpenAI API-key user —
   but it would get round a refusal that was made on purpose. Hide OpenAI models as Anthropic's are
   hidden (§ 5), or allow them, labelled as OpenCode runs, with US$ unknown unless OpenCode reports it?
8. ~~The local route without a local test.~~ **DECIDED 2026-11-24: keep local models.** They ship with a
   notice (§ 5 "The local notice"); quality is tested on Modal (§ 9, Phase 0).

## 11. Out of scope (later profiles)

Gemini CLI (`gemini --acp`), GitHub Copilot CLI (`copilot --acp`, preview) and Grok Build
(`grok agent stdio`, beta) all speak ACP, so each would be a new profile on this seam. Each brings its own
open questions (vendor terms for a third-party driver, OAuth credential injection in the sandbox, usage
reporting). None of them is planned here.

## Sources (2026-11-24)

- OpenCode: [ACP](https://opencode.ai/docs/cli/acp/), [CLI](https://opencode.ai/docs/cli), [v1.3.0 changelog](https://opencode.ai/changelog/v1.3.0.md),
  [providers](https://opencode.ai/docs/providers),
  [Ollama integration](https://docs.ollama.com/integrations/opencode)
- Codex + OpenRouter (the comparison): [OpenRouter guide](https://openrouter.ai/docs/guides/coding-agents/codex-cli)
