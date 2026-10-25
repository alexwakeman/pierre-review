# Plan: Codex (OpenAI) as a second AI provider

Status: PLAN, not built. **Phase 0 (the spike) ran 2026-10-25 — read [CODEX-SPIKE.md](CODEX-SPIKE.md) first: its "Plan changes" section SUPERSEDES the matching parts of §§ 2, 3, 6, 7 and 8 below** (strict-config, the extra locked keys, the `/tmp` write leak, silent untrusted hooks, MCP approval mode, CLI not SDK, app-server rate limits in whole percent, models).

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
