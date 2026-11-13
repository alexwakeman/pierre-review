# srt quick-chat spike

Spike scripts only; not part of the build. Results, findings and the manual test steps:
[docs/QUICK-CHAT-SPIKE.md](../../../docs/QUICK-CHAT-SPIKE.md).

- `spike.mjs`: `srt` library, the boundary probes, timings and the 10-minute reaper (`--reap-only`).
- `chat.mjs`: Claude Code with its own `srt` sandbox, in a story's scratch worktree, two turns (the second resumed).
- `warm.mjs`: a pre-started agent process; time from question to first answer.
