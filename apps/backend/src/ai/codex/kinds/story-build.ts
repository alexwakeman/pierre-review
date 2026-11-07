// THE CODEX KINDS OF "IMPLEMENT STORY" (docs/SANDBOX.md § Agent drivers): `story_plan` (a chat turn of a
// workspace session) and `story_build` (a build turn). Both run the Codex CLI INSIDE the session's sandbox
// (sandbox/drivers/codex.ts, `codex app-server`), never through `ai/provider.ts` `runAgent`: the sandbox
// is the confinement there, and the agent has a shell (the documented exception, docs/SANDBOX.md).
//
// They stay listed so `codexRunnable()` (which requires EVERY agent kind in `CODEX_AGENT_KINDS`) holds,
// and so the run choice (`resolveManualRunChoice(…, 'story_build')`) offers Codex for a session.
import type { AiAgentKind } from '@pierre-review/shared';

export const CODEX_STORY_BUILD_KINDS: readonly AiAgentKind[] = ['story_plan', 'story_build'];
