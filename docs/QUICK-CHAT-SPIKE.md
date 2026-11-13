# Spike: quick story chats under sandbox-runtime (`srt`)

Status: **spike, 2026-11-13. Not built: the story chat ([STORY-CHAT.md](STORY-CHAT.md)) shipped READ-ONLY (owner decision: advice and manual testing, not running tests), so it needs no sandbox.** Kept for a later shell lane. Scripts: `scripts/spikes/srt/`. Also measured since: the Agent SDK's bundled Claude Code 2.1.295 started srt's network bridge but nothing listened inside the sandbox on Linux; 2.1.323 worked.

## The question

Can a story chat ("what's the test strategy for these PRs?") be fast and always available,
with the workspace repos, the story and the reader's memory loaded, and with the agent able to
RUN code? Builds stay in the Docker sandbox ([SANDBOX.md](SANDBOX.md)). Owner decisions taken
before the spike:

- A process sandbox on the host kernel is acceptable for chats. It is weaker than a container
  and much faster.
- Chats may run code. They write only to a per-chat scratch worktree and its temp folder.
- Windows is not a priority.
- Scratch is cleaned up: a chat idle for 10 minutes is reaped.

## What was run

Everything ran on Linux: a Firecracker VM with kernel 6.18, running as root, using
`srt` 0.0.83, bubblewrap 0.9.0, socat and Claude Code 2.1.323. The example repo is this repo.
The example story is "LIMN-42", the Jira end-to-end comment change at `c7f6268`.

1. `spike.mjs` drives the `srt` library directly. It opens a chat, probes the boundary, times
   the commands and checks the reaper.
2. `chat.mjs` runs Claude Code on the host, with Bash sandboxed by Claude Code's built-in `srt`
   sandbox. It sets up a scratch worktree at the PR head and a seed holding the ticket, the
   acceptance criteria and the diff stat. It sends two turns, the second resumed from the
   saved session.
3. `warm.mjs` keeps one `claude` process running (stream-json input) and asks it questions
   once it is warm.

## Results

### Timings

| Step | Time |
|---|---|
| Open a chat: `git worktree add` + link `node_modules` | 0.5–1.4 s |
| `srt` initialise (proxies up) | 25–130 ms, once per process |
| Wrap + run a command (`true`), median of 10 | **28–33 ms** |
| `git status` + `git log` in the sandbox | 47–165 ms |
| `rg` over the repo in the sandbox | 36–45 ms |
| vitest, 2 files (6 tests), sandboxed vs host | 5.3–6.4 s vs 5.9 s: **no measurable overhead** |
| Reap one idle chat | ~50 ms |
| **Cold `claude -p`**: spawn to init / first tool / first text | 3.9 s / 5.7 s / 9–39 s* |
| Resumed turn (cold process, `--resume`): first text | 12–17 s* |
| **Warm `claude` process**: question to first text, no tool | **1.1 s** |
| Warm process: a code question that needs one tool, to first text / answer | 3.3 s / 4.6 s |

\* First text comes after the agent's own tool calls (reading the diff, running tests). That is
the model working, not overhead.

**Conclusion.** The sandbox costs about 30 ms per command. Starting the CLI costs about 4 s,
and that is the only start cost worth removing. A pre-started agent process per open story
answers in about a second.

### The boundary

Each probe was run twice: by the library and by the agent itself.

| Probe | Result |
|---|---|
| Read `~/.ssh/<key>` | denied (the home folder is masked) |
| Read `~/.claude` | denied |
| Write to the warm checkout | denied, "Read-only file system" |
| Write to the scratch worktree and the chat's `TMPDIR` | allowed |
| `https://example.com` | blocked, with a violation event ("deny network-outbound example.com:443") |
| `https://registry.npmjs.org` (allowed) | 200 |
| `169.254.169.254` (metadata) | blocked |
| `GH_TOKEN` / `GITHUB_TOKEN` / `AWS_*` in the environment | none visible, once the environment was allow-listed (see finding 1) |
| `sandbox.failIfUnavailable` when `srt` could not start | **failed closed**: every Bash call was refused, and the agent said so |

### The agent did useful work

Turn 1 ("test strategy for this story's PR"):
- The agent read the diff and ran the 13 end-to-end tests in the sandbox. All passed.
- It listed the gaps against the acceptance criteria. The real summary call and the spend gate
  have no test, and the summary's escaping is not tested.
- It wrote a throwaway test in the scratch worktree, deleted it, and found a real bug: the
  `BARE_REF` pattern in `end-to-end.ts` removes ordinary words. "Q3" and "P1" disappear from a
  summary. Cost: about US$0.50–0.72 per turn on this model.

## Findings that change the design

1. **`srt` passes the host environment through.** Without an allow-list, `GH_TOKEN`,
   `GITHUB_TOKEN` and AWS keys were visible inside the sandbox. Limn must spawn the agent, and
   so every sandboxed command, with an ALLOW-LISTED environment. Keep PATH, HOME, locale and CA
   variables, plus the provider's sign-in variables. Never the reader's whole shell.
2. **Unix socket path limit.** On Linux, `srt` keeps its proxy bridge sockets under `TMPDIR`. A
   long `TMPDIR` (over about 108 bytes) makes start-up fail with "Failed to create bridge
   sockets". Chat roots must be SHORT, for example `~/.limn/q/<6-char id>`, and on Linux
   preferably under `/tmp` or `$XDG_RUNTIME_DIR`.
3. **`NO_PROXY` leaks into `srt`'s own proxy.** When the host's `NO_PROXY` names a host,
   `srt`'s upstream goes direct for that host, and inside the sandbox curl bypasses the proxy and
   times out. Clear `NO_PROXY`/`no_proxy` for the process that runs `srt`. Pass a corporate
   proxy as `network.parentProxy`.
4. **CA files under the home folder must be allowed explicitly.** Reads deny `$HOME`, so a CA
   bundle stored there makes curl and npm fail with error 77. Read `NODE_EXTRA_CA_CERTS` and
   `SSL_CERT_FILE` at start and add those paths to `allowRead`.
5. **Linked `node_modules` are read-only, and tools write caches into them.** vitest failed
   with EROFS writing `node_modules/.vite/vitest/results.json`. Either point caches at the
   chat's `TMPDIR` (`--cache=false`, `VITE_CACHE_DIR`, `JEST_CACHE_DIR`…), or make the
   worktree's `node_modules` a writable copy-on-write overlay. Seeding the agent with "how to
   run tests here" was enough for the spike.
6. **The reaper must sweep git's worktree list, not only its own folder.** A crashed open left
   a worktree that git still listed after its folder had gone. `spike.mjs --reap-only` now
   removes any worktree under the chat root that has no activity stamp.
7. **The repo's own `.claude/settings.local.json` is picked up** through the worktree (it was
   ignored as untrusted). Limn must decide whether a chat honours the repo's project settings.
   It should load CLAUDE.md (the project memory), but never the permission allow-lists.

## Proposed design (for discussion)

```
Story view ──"Ask"──► quick-chat manager (backend)
                         │ 1. open: worktree per repo at the PR head (or default branch),
                         │    node_modules linked, short root ~/.limn/q/<id>
                         │ 2. seed: the SAME fold as builds (sandbox/workspace/seed.ts):
                         │    ticket, PRs + diffs, CI, story-check verdicts, memories
                         │ 3. agent: one warm `claude` (stream-json) / `codex app-server`,
                         │    allow-listed env, Bash under srt, write = worktree + TMPDIR only
                         │ 4. stream turns to the SPA; store each turn in the DB
                         ▼
                   story_chats (account, workspace, ticket ident) → turns, provider, cost
```

- **Pre-warming.** Opening a story view prepares the chat: the worktree is opened and the agent
  process is started, at most N at a time. "Ask" then answers in about a second. This could also
  be done on hover, or for the stories in This Sprint.
- **Saved chats.** Turns are stored in Limn's DB against the ticket. Reopening resumes the
  provider's own session: Claude `--resume`, which was tested here, or a Codex thread. The
  sessions live in a Limn-owned config folder, so this is Limn's history and never an import of
  the reader's. "Pin to story" turns an answer into a note that later builds and Fill gaps read.
- **Cleanup: the 10-minute rule.**
  - Every turn and every keep-alive from an open story view touches `.limn-last-active`.
  - A sweep runs every minute. It kills the agent process and removes the chat's worktrees and
    `TMPDIR` once the stamp is more than 10 minutes old.
  - The same sweep runs at boot, alongside today's clone-cache and worktree sweeps, and also
    removes orphaned worktrees (finding 6).
  - The DB transcript is kept, so a reaped chat costs about 4 s to reopen: a cold CLI start plus
    `--resume`.
- **Builds are unchanged.** "Build from this" opens the normal Docker session, seeded with the
  pinned notes. The quick lane never pushes and holds no GitHub credential.

## Open items before building it

- Repeat the spike on **macOS**, where `srt` uses Seatbelt and has no socket-path issue (manual
  steps below).
- **Codex**: run `codex app-server` with its own sandbox off and wrap its commands with the
  `srt` library, as `spike.mjs` does. Not tried yet.
- **Ubuntu 24.04 desktop**: unprivileged user namespaces are restricted by AppArmor, so check
  what `srt` reports and the fix to give the reader.
- **The `node_modules` cache strategy** (finding 5): writable overlay or redirected caches.
- **A memory/CPU ceiling.** `srt` has none; a runaway test is bounded only by the 10-minute reap.
  Consider `ulimit` or `systemd-run --user --scope -p MemoryMax=` on Linux.

## Manual test steps

Prerequisites:
- macOS: nothing extra.
- Linux: `bubblewrap`, `socat` and `ripgrep`, plus working user namespaces. Check with
  `bwrap --ro-bind / / true`.
- Both: Claude Code signed in, and this repo with `pnpm install` done.

1. Install the spike's one dependency:
   ```bash
   cd scripts/spikes/srt && npm install && cd ../../..
   ```
2. Plant a fake secret to probe for:
   ```bash
   mkdir -p ~/.ssh && echo FAKE > ~/.ssh/spike_fake_key
   ```
3. Run the boundary and timing spike from the repo root:
   ```bash
   env -u NO_PROXY -u no_proxy node scripts/spikes/srt/spike.mjs
   ```
   Expected:
   - every "want:" line matches;
   - `wrap + run` is under about 100 ms;
   - the vitest line reads "2 passed";
   - the reaper line reads `removed=1 exists=false`.

   If a CA bundle lives under your home folder, add `SPIKE_EXTRA_READ=/path/to/ca/dir` to the
   command.
4. Run the agent chat on the example story:
   ```bash
   node scripts/spikes/srt/chat.mjs
   ```
   Check the following:
   - **turn 1:** the agent runs the end-to-end tests in the sandbox, they pass, and it lists the
     test gaps;
   - **turn 2 (resumed):** the key read fails, the write to the repo fails ("Read-only file
     system" on Linux, "Operation not permitted" on macOS), example.com is refused, and the
     token count is 0;
   - the last line reads `probe file exists on host? false`.

   To ask your own question, set `SPIKE_Q1="…"`. For another story, set `SPIKE_HEAD` and
   `SPIKE_BASE`.
5. Time a warm agent. Use the chat folder from step 4, which is the newest under
   `/tmp/lq-srt/chats`:
   ```bash
   node scripts/spikes/srt/warm.mjs
   ```
   Expected: `q1.firstText` is about 1–2 s.
6. Check the cleanup:
   ```bash
   SPIKE_TTL_MS=0 node scripts/spikes/srt/spike.mjs --reap-only
   ```
   Then confirm both of these:
   - `git worktree list` shows only your checkout;
   - `/tmp/lq-srt/chats` is empty.
7. Remove the fake key:
   ```bash
   rm ~/.ssh/spike_fake_key
   ```
