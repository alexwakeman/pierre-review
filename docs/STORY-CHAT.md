# Story chat — "Ask about this story"

Quick, READ-ONLY questions about ONE story: how to prove it is done once its pull requests are merged
(manual test steps), what is still missing, how it fits with the rest of the system, what is risky.
The agent gets the same context a build gets, read-only: the ticket, EVERY PR's whole diff and checked-out
code, the story's newest Implement story build's stored work, EVERY workspace repository at its default branch, the reader's Claude project memories,
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
                       │ worktrees of the PR heads (clone-manager, ledgered as kind 'chat')
                       │ every workspace repo at its default branch: the SHARED trees (trees.ts;
                       │   at most 20 repos, the rest named)
                       │ each PR's unified diff (GitHub REST) → <tmp>/<owner>__<name>-<n>.diff, AND
                       │   as per-file parts <tmp>/diffs/<owner>__<name>-<n>/INDEX.md (diff-files.ts)
                       │ the newest build's stored patches → <tmp>/build/<i>-<owner>__<name>/INDEX.md
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
- **One live chat per (account, workspace, ticket)**, at most `ENSEMBLE_STORY_CHAT_MAX_LIVE` (default 3);
  the least recently used idle one is closed to make room. A chat answering is never reaped or evicted.
- **Warm start.** The agent process is up before the question (measured: ~1 s to the first words warm,
  ~4 s more cold). Preparing makes no model call.
- **The checkouts** are EVERY PR of the story (open first, then the newest merged), from Ensemble's clone
  cache. `STORY_CHAT_MAX_CHECKOUTS` (30) is a safety bound, not a budget: any past it are NAMED in the seed
  (never dropped silently; the cap used to be 6, and the agent then said it had not read a PR at all). The cache is BLOBLESS, so a checkout's history is partial: each PR's change is GitHub's
  own diff, written into the chat's temp folder (`/tmp/limn-q-<install hash>-XXXXXX`) and named in the
  seed. A crash leaves the worktrees to the worktree sweep (`review/worktree-gc.ts`) and the temp
  folders to the boot sweep (`sweepAtBoot`), which also marks cut-off turns failed.
- **The ready-made questions** (`STORY_CHAT_PRESETS`): How to test, Integration, Risks, Criteria check. "How to
  test" is also asked BY ENSEMBLE after a build (docs/STORY-BUILD.md § How to test after a build).
- **No read limit.** The seed tells the agent to read each diff's INDEX, then every part the question needs, and
  for a whole-story question (test steps, risks, integration, criteria) EVERY part of EVERY PR and of the build's
  work, before answering — "never answer from part of a diff". `STORY_CHAT_TURNS_PER_QUESTION` is 150 (parallel
  reads share a step). The old "answer within about 20 reads" line is gone: it made the agent stop part-way.
- **Saved chats.** `story_chats` + `story_chat_turns` (migration 0192). Ensemble's OWN record — never an
  import of the reader's Claude or Codex sessions (`persistSession: false`). Continuing a saved chat on
  a fresh agent puts its earlier turns in the system prompt (`seed.ts` `earlierText`, newest kept).
- **Per-turn cost** is the session's running total minus the previous total; Claude's is recorded
  here (`recordAiUsage`, feature `story_chat`, group "chat"); Codex records its own.

## The diffs (`story-chat/diff-files.ts`)

Owner report (2026-11-16): "I did not read the full #620 diff (it was truncated at ~1200 of 1879 lines) or the
#482 diff at all". The agent's Read returns a bounded slice of a file (~2000 lines, fewer when lines are long, and
cuts a line at 2000 characters), so ONE diff file per PR was read in part. Now each diff is ALSO a folder:

- `INDEX.md`: the PR, its file and part counts, and one line per changed file — status (changed, added,
  deleted, renamed from …, or GitHub's "no diff (binary or too large): read the file in the checkout"), its
  churn and its part files.
- One file per changed file, in PARTS of at most `DIFF_PART_LINES` (600) lines and `DIFF_PART_CHARS` (40k)
  characters — one Read returns a part whole — broken at a hunk (`@@`) when one is near (past 70%). A line
  longer than `DIFF_LINE_MAX` (1500) is wrapped onto lines starting `↪ `; the INDEX says so.
- Pure (`splitDiff`, `partsOf`, `planDiffFolder`) + one writer; `diff-files.test.ts` pins the bounds and that
  the parts are the whole file. The one-file `.diff` stays for Grep. `DIFF_MAX_CHARS` is a 20 MB safety cut.

## The build's work (`story-chat/build-work.ts`)

The story's NEWEST Implement story build (a workspace session, not discarded) keeps its work as patches
(`story_build_repos.patch`, or `story_build_prs.patch` per planned PR). Work not pushed is in no pull request,
so it is written as diff folders (as above) under `<tmp>/build/` and listed in the seed under "# The Implement
story build", each with where it is ("not pushed", "pushed to the branch X, with no pull request yet", "pushed as
PR #n"). DB only.

## Shared trees

`story-chat/trees.ts`. Every chat reads each workspace repository at its default branch from ONE shared,
read-only folder per (repository, commit): `<dataDir>/chat-trees/<owner>__<name>/<sha>/`, the files only
(no `.git`), complete when it holds `.limn-tree-complete`. Sharing is safe because the chat cannot write
(no shell, no write tool, every root read-only to the path guard).

- **Acquire** (prepare): the tree of the commit sync last saw (`repos.defaultBranchHeadSha`) — no git work
  and no network; else the newest tree there is, with a rebuild behind it when sync knows a newer commit;
  else (the first chat on the repository) it is built now. Measured: prepare with warm trees ~0.8 s, of
  which the PR worktree is most; a cold first chat ~8 s per repository.
- **Build**: a worktree of the branch tip through the clone cache (batched blob fetch), its files COPIED
  into `<sha>.part-…`, then renamed. A tree never depends on the clone cache, whose LRU may evict a clone.
  One build per repository at a time.
- **Refresh**: the default-branch snapshot (`sync/branch-status.ts`, after its transaction, lazy, never
  awaited) calls `noteDefaultBranchHead`: a repository that already has a tree gets the new commit's tree
  built in the background. A repository no chat has read is never cloned for this.
- **Prune**: a tree goes when a newer one is complete and no live chat holds it (in-memory holds, released
  when a chat closes). At boot (`sweepAtBoot`): unfinished trees, all but the newest per repository, and
  repositories Ensemble no longer has.
- **Disk**: one copy of each repository's files per repository a chat has read, kept between chats.

## Routes

`story-chat/routes.ts` (registered by `registerAgenticRoutes`; rate tiers in `tierFor`):
`GET /api/story-chats?workspace=&ident=`, `GET /api/story-chats/:id`, `POST /api/story-chats/prepare`
(sync), `POST /api/story-chats/ask` (ai + ai_hourly), `POST /api/story-chats/:id/stop`,
`POST /api/story-chats/close`, `DELETE /api/story-chats/:id`. A chat id resolves only within
(account, workspace, ticket).

## Not done yet

- "Pin to story": an answer kept as a note that later builds and Fill gaps read.
