// THE "AI IS NOT SET UP" ERROR, on its own (re-exported by ai/runtime.ts, which is where callers import
// it from). It lives apart so a module that must SUBCLASS it at load time (ai/codex/home.ts
// `CodexNotInstalledError`) does not depend on the whole runtime module — which many tests replace
// with a partial mock.

export const AI_RUNTIME_MISSING_MESSAGE =
  'AI is not set up yet. Press "Set up AI" in Limn, or run: limn ai install';

/** Thrown by a loader when no source carries the package. Its message is safe to show. */
export class AiRuntimeMissingError extends Error {
  readonly code = 'AI_RUNTIME_MISSING';
  constructor(readonly pkg: string) {
    super(AI_RUNTIME_MISSING_MESSAGE);
    this.name = 'AiRuntimeMissingError';
  }
}
