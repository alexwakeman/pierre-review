# Story chat — "Ask about this story"

Quick, READ-ONLY questions about ONE story: how to prove it is done once its pull requests are merged
(manual test steps), what is still missing, how it fits with the rest of the system, what is risky.
The agent gets the same context a build gets, read-only: the ticket, each PR's diff and checked-out
code, EVERY workspace repository at its default branch, the reader's Claude project memories,
CLAUDE.md files and skills, the reference library, and — beyond builds — the sprint's other stories.
It runs nothing and changes nothing. Code: `apps/backend/src/story-chat/`, the panel
`apps/frontend/src/components/Ticket/StoryChat.tsx`, the wire `packages/shared/src/story-chat.ts`.

Owner decision (2026-11-13): advice, integration questions and manual testing, NOT running tests — so
the chat is read-only like every other chat, with no shell and no sandbox. The spike that measured a
shell under sandbox-runtime is kept for reference: [QUICK-CHAT-SPIKE.md](QUICK-CHAT-SPIKE.md). Builds
stay in the container sandbox ([SANDBOX.md](SANDBOX.md)).

## The flow

```
story view mounts ─► POST /prepare (keep-alive every 3 min while the panel is open + visible)
                       │ stored ticket (readSessionTicket, NO tracker read) · PR heads from the DB
                       │ worktrees of the PR heads + every workspace repo at its default branch
                       │   (clone-manager, ledgered as kind 'chat'; at most 20 repos, the rest named)
                       │ each PR's unified diff (GitHub REST) → <tmp>/<owner>__<name>-<n>.diff
                       │ context.ts: memories, ~/.claude/CLAUDE.md, the projects folder's CLAUDE.md,
                       │   skills (the workspace's sandbox settings choose, as for builds); every
                       │   memory file also written to <tmp>/memory/
                       │ the reference library (docsContextFor) · the sprint's other stories (DB only)
                       │ Claude: ONE live Agent SDK session (streaming input), no model call yet
                       ▼
"Ask" ─► POST /ask ─► a stored turn ─► the session answers (Codex: one run per question)
                       │ the SPA polls GET /api/story-chats/:id (activity lines, partial text)
                       ▼
idle 10 min ─► the reaper: session closed, worktrees removed, temp folder deleted; turns kept
```

- **The context, and where it comes from** (`story-chat/context.ts`): memories are found exactly as
  builds find them (`resolveWorkspaceLayout`: the reader's clones of the workspace's repositories,
  through their Claude projects; the ticked projects of Settings → Sandbox, default all). They go in
  the system prompt up to its budget and in full under `<tmp>/memory/`. `userClaudeMd` brings
  `~/.claude/CLAUDE.md` and the projects folder's own CLAUDE.md; `userSkills` brings `~/.claude/skills`
  as a read-only folder; the repositories' own `.claude/skills/*/SKILL.md` are listed. The reference
  library is a read-only folder with the reviews' navigation rules. The sprint is one line per story
  (key, title, status, PRs, the brief's one line), at most 80, from the stored sprint graph.
- **Read-only, twice over.** The Claude session's base tool set is Read/Glob/Grep, with Bash and every
  write tool denied (`ai/providers/claude.ts` `SESSION_TOOLS` / `SESSION_DENIED_TOOLS`), and the path
  guard treats every root as read-only. Codex runs under its usual lockdown (no shell) with no write
  roots. `settingSources: []`: the repository's own `.claude` settings are not applied.
- **One live chat per (account, workspace, ticket)**, at most `LIMN_STORY_CHAT_MAX_LIVE` (default 3);
  the least recently used idle one is closed to make room. A chat answering is never reaped or evicted.
- **Warm start.** The agent process is up before the question (measured: ~1 s to the first words warm,
  ~4 s more cold). Preparing makes no model call.
- **The checkouts** are the story's PRs (open first, then the newest merged; at most 6) from Limn's
  clone cache. The cache is BLOBLESS, so a checkout's history is partial: each PR's change is GitHub's
  own diff, written into the chat's temp folder (`/tmp/limn-q-<install hash>-XXXXXX`) and named in the
  seed. A crash leaves the worktrees to the worktree sweep (`review/worktree-gc.ts`) and the temp
  folders to the boot sweep (`sweepAtBoot`), which also marks cut-off turns failed.
- **The ready-made questions** (`STORY_CHAT_PRESETS`): How to test, Integration, Risks, Criteria check.
- **Saved chats.** `story_chats` + `story_chat_turns` (migration 0192). Limn's OWN record — never an
  import of the reader's Claude or Codex sessions (`persistSession: false`). Continuing a saved chat on
  a fresh agent puts its earlier turns in the system prompt (`seed.ts` `earlierText`, newest kept).
- **Per-turn cost** is the session's running total minus the previous total; Claude's is recorded
  here (`recordAiUsage`, feature `story_chat`, group "chat"); Codex records its own.

## Routes

`story-chat/routes.ts` (registered by `registerAgenticRoutes`; rate tiers in `tierFor`):
`GET /api/story-chats?workspace=&ident=`, `GET /api/story-chats/:id`, `POST /api/story-chats/prepare`
(sync), `POST /api/story-chats/ask` (ai + ai_hourly), `POST /api/story-chats/:id/stop`,
`POST /api/story-chats/close`, `DELETE /api/story-chats/:id`. A chat id resolves only within
(account, workspace, ticket).

## Not done yet

- "Pin to story": an answer kept as a note that later builds and Fill gaps read.
