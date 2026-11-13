# Story chat — "Ask about this story"

Quick questions about ONE story, answered by an agent that reads the story's pull requests and, on
Claude, RUNS commands in them inside a process sandbox. The design and its measurements come from
the spike: [QUICK-CHAT-SPIKE.md](QUICK-CHAT-SPIKE.md). Code: `apps/backend/src/story-chat/`, the
panel `apps/frontend/src/components/Ticket/StoryChat.tsx`, the wire `packages/shared/src/story-chat.ts`.

Owner decisions (2026-11-13): a process sandbox on the host kernel is acceptable for chats; chats may
run code; Windows is not a priority; scratch is removed after 10 minutes without use. Builds stay in
the container sandbox ([SANDBOX.md](SANDBOX.md)).

## The flow

```
story view mounts ─► POST /prepare (keep-alive every 3 min while the panel is open + visible)
                       │ stored ticket (readSessionTicket, NO tracker read) · PR heads from the DB
                       │ worktrees of the PR heads (clone-manager, ledgered as kind 'chat')
                       │ each PR's unified diff (GitHub REST) → <tmp>/<owner>__<name>-<n>.diff
                       │ the reader's node_modules linked in, READ-ONLY
                       │ the reader's memory + CLAUDE.md (the workspace's sandbox settings)
                       │ Claude: ONE live Agent SDK session (streaming input), no model call yet
                       ▼
"Ask" ─► POST /ask ─► a stored turn ─► the session answers (or Codex: one read-only run)
                       │ the SPA polls GET /api/story-chats/:id (activity lines, partial text)
                       ▼
idle 10 min ─► the reaper: session closed, worktrees removed, temp folder deleted; turns kept
```

- **One live chat per (account, workspace, ticket)**, at most `LIMN_STORY_CHAT_MAX_LIVE` (default 3);
  the least recently used idle one is closed to make room. A chat answering is never reaped or evicted.
- **Warm start.** The agent process is up before the question (measured: ~1 s to the first words
  warm vs ~4 s more cold). Preparing makes no model call.
- **Saved chats.** `story_chats` + `story_chat_turns` (migration 0192). Limn's OWN record — never an
  import of the reader's Claude or Codex sessions (`persistSession: false`). Continuing a saved chat on
  a fresh agent puts its earlier turns in the system prompt (`seed.ts` `earlierText`, newest kept).
- **Per-turn cost** is the session's running total minus the previous total; Claude's is recorded
  here (`recordAiUsage`, feature `story_chat`, group "chat"); Codex records its own.

## The sandbox (Claude)

The Agent SDK's `sandbox` option runs Anthropic's sandbox-runtime (`srt`) around every Bash command:
Seatbelt on macOS, bubblewrap + seccomp on Linux. `ai/providers/claude.ts` `openSession` sets it FAIL
CLOSED (`failIfUnavailable`, `allowUnsandboxedCommands: false`). The policy (`story-chat/policy.ts`):

| | |
|---|---|
| Reads | everything except the home folder; back inside it only the worktrees, the clone's git folder, the borrowed node_modules, the chat's temp folder and CA files the environment names |
| Writes | the worktrees, each worktree's own git folder (index), the chat's temp folder. Never the clone's shared git folder (hooks, config), never the borrowed node_modules |
| Network | the build sandbox's default registries plus the workspace's "Always allow" hosts, through srt's proxy |
| Environment | an ALLOW-LIST (`agentEnv`): srt passes the agent's environment to every command. The model credential stays with the agent process and is DENIED to commands (`credentials.envVars`) |
| Temp folder | `/tmp/limn-q-<install hash>-XXXXXX`: srt keeps Unix sockets under TMPDIR, and a socket path is ≤ ~108 bytes |

The file tools (Read/Edit/Write) are bounded by the PATH GUARD as in every run: the worktrees and the
temp folder. `settingSources: []`: the repository's own `.claude` settings are not applied.

**Where commands are off** (`sandboxSupport`): Windows; Linux without `bwrap`/`socat` or with user
namespaces blocked (Ubuntu 24.04's AppArmor rule); Codex (its lockdown has no shell). The agent then
reads only, and the panel and the seed say why.

⚠ **Network from a command needs a recent Claude Code.** The SDK's bundled Claude Code 2.1.295 (SDK
0.3.295) started srt's proxy bridge but nothing listened inside the sandbox on Linux; Claude Code
2.1.323 worked (measured 2026-11-13). Until the SDK pin moves, set `LIMN_CLAUDE_PATH` to a newer
`claude` for registry access. Reading, writing and running tests are unaffected.

## The checkouts

Worktrees of the story's PRs (open first, then the newest merged; at most 6) from Limn's clone cache.
The cache is BLOBLESS and the sandbox has no GitHub, so `git show` of the PR cannot fetch what it lacks:
each PR's unified diff is written into the temp folder on the host and named in the seed. A crash
leaves the worktrees to the worktree sweep (`review/worktree-gc.ts`, the process is gone) and the temp
folders to the boot sweep (`sweepAtBoot`), which also marks cut-off turns failed.

## Routes

`story-chat/routes.ts` (registered by `registerAgenticRoutes`; rate tiers in `tierFor`):
`GET /api/story-chats?workspace=&ident=`, `GET /api/story-chats/:id`, `POST /api/story-chats/prepare`
(sync), `POST /api/story-chats/ask` (ai + ai_hourly), `POST /api/story-chats/:id/stop`,
`POST /api/story-chats/close`, `DELETE /api/story-chats/:id`. A chat id resolves only within
(account, workspace, ticket).

## Not done yet

- "Pin to story": an answer kept as a note that later builds and Fill gaps read.
- Running Codex with a shell (its own sandbox off, commands wrapped by the srt library).
- A memory/CPU ceiling for commands (srt has none; a runaway test is bounded by Stop and the reaper).
- macOS measured by hand (the spike's manual steps).
