// STORY CHAT on Codex (docs/STORY-CHAT.md). Codex runs it READ-ONLY, one `codex exec` per turn under the
// SAME lockdown as every Codex run (ai/codex/config.ts: no shell, files through Limn's workspace MCP
// server), with the earlier turns in the prompt. The shell-in-a-process-sandbox lane is Claude's (its
// SDK runs `srt`); Codex's own sandbox is not used. Runner: story-chat/live.ts `askReadOnly`.
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_STORY_CHAT_KINDS: readonly AiAgentKind[] = ['story_chat'];
