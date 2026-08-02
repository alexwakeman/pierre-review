# Claude Review (agentic PR review)

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Claude Review (agentic PR review)

A **Claude Review** tab runs the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`)
against the selected PR, returns **structured JSON findings** (persisted per head SHA,
history kept), lets the user author their own review + tick which findings to post, then
posts **one** GitHub review (inline + body + verdict).

- **Opt-in, off by default, LOCAL-ONLY.** Gated behind `ENABLE_CLAUDE_REVIEW=true`
  (`config.claudeReviewEnabled`) — it spends real money per run. **Force-disabled in cloud**
  (`!isCloud && …`): the routes aren't even registered (`app.ts`), so the gh-CLI/clone-manager
  dep stays unreachable on Railway. When off, the frontend hides the tab (via `/api/me`).
- **Auth resolves from the ambient env** (`ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN`
  → a logged-in Claude session); `review/auth.ts` detects it best-effort (the first real
  SDK auth error is the authoritative gate). A **user-supplied key** (pasted in the tab,
  `PUT /api/claude-review/key`, stored local-only via `review/local-settings.ts`) wins:
  `agent.ts` overrides `process.env.ANTHROPIC_API_KEY` for the run (restored in `finally`,
  gated on `reviewConcurrency===1` to avoid an env race).
- **`src/review/`** mirrors the sync machinery: `review-manager.ts` (in-memory job
  manager, one review/PR, `config.reviewConcurrency` gate, startup reconcile of orphaned
  `running` rows), `agent.ts` (the SDK run: an in-process MCP `submit_review` tool —
  `schema.ts` — captures structured output; read-only tools, `cwd` = a worktree,
  `bypassPermissions`, `settingSources:[]`, `maxTurns`/`maxBudgetUsd` caps,
  `AbortController` cancel), `clone-manager.ts` (partial clones under `config.cloneDir`,
  ephemeral per-run worktrees, LRU cleanup), `prompt.ts` (inline prompt + `NOISE_GLOBS`
  diff stripping), `post-review.ts` (line-anchoring + the single review POST), `persist.ts`.
- **Deterministic routing** (`review/routing.ts`, tested): BEFORE the agent runs, a pure
  diff-metrics gate (`config.reviewRouting`) picks a `reviewMode` — `skip` / `diff_only`
  (tool-less, no clone) / `worktree` (full clone as context) — stored on `reviewMode` +
  `routeReason` (migration 0013). Conservative: `diff_only` only within every size/spread
  ceiling AND touching no exported contract (`API_PATH_PATTERNS`/`EXPORT_MARKERS`); ambiguity
  → `worktree`. User can force a mode per run.
- **Line-anchoring is the load-bearing bug risk** (`buildAnchorIndex` in
  `post-review.ts`): a ticked finding posts inline on its `(path, line, side)` when that
  lands on an addable diff line; otherwise it **re-anchors to the file's first changed
  line** (so an off-by-a-line finding still posts inline) and only truly unplaceable
  ones fall back to the review body. Posting pins `commit_id` to the head SHA, 409s if
  it moved.
- **Frontend:** `ClaudeReviewTab.tsx` + `useClaudeReview.ts` (polls `…/status` while
  running). Claude's output is **read-only** (Copy buttons); a separate "Your review"
  textarea + verdict is what posts. Re-reviewing the same head SHA **warns but is allowed**.
- **Packaging (NO AI in npm):** the AI SDKs (`@anthropic-ai/claude-agent-sdk`,
  `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod` — used only by the AI tools'
  submit-review schemas) are **NOT** curated runtime deps in `build-release.mjs`; a guardrail
  assert fails the build if any leak into `release/package.json`. Every module that pulls one
  is reached **only** through a dynamic `await import()` — from the private `@pierre/pro`
  plugin's seams (`review/agent`, `coding/agent`, `coding/merge`, `review/prepare`,
  `review/post-seam`) or lazily inside `review/llm.ts` — so the SDKs load **only when the
  plugin is present** (author/dev checkout), **never from npm** and **never in cloud** (`bind.ts`
  returns before any AI import when `!config.proEnabled`). The compiled-but-inert AI `.js`
  files still ship as dead code (harmless — nothing loads them). The inline prompt + `import
  type`-only shared usage keep the no-`.ts`-leak / no-shared-runtime guards passing.


