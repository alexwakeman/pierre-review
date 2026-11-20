// THE "AI IS NOT SET UP" ERROR, on its own (re-exported by ai/runtime.ts, which is where callers import
// it from). It lives apart so a module that must SUBCLASS it at load time (ai/codex/home.ts
// `CodexNotInstalledError`) does not depend on the whole runtime module — which many tests replace
// with a partial mock.

export const AI_RUNTIME_MISSING_MESSAGE =
  'AI is not set up yet. Switch it on in Settings → Features, or run: ensemble ai install';

/** Thrown by a loader when no source carries the package. Its message is safe to show. */
export class AiRuntimeMissingError extends Error {
  readonly code = 'AI_RUNTIME_MISSING';
  constructor(readonly pkg: string) {
    super(AI_RUNTIME_MISSING_MESSAGE);
    this.name = 'AiRuntimeMissingError';
  }
}

/** Claude's line while the reader has not picked it (or removed it) in Settings → AI. */
export const CLAUDE_NOT_DOWNLOADED_MESSAGE =
  'Claude is not downloaded. Download it in Settings → AI, or run: ensemble ai install claude';

/** Codex's line while the reader has not picked it (or removed it) in Settings → AI. */
export const CODEX_NOT_DOWNLOADED_MESSAGE =
  'Codex is not downloaded. Download it in Settings → AI, or run: ensemble ai install codex';
