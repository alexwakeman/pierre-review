// THE SANDBOXED CHECKS RUNNER — the public API (docs/SECURITY.md § Sandboxed checks). AI Fix uses it
// for "Run tests" (coding/agent.ts); a story build will reuse it unchanged. See session.ts for the flow.
export { CHECK_MANIFEST_FILES, discoverChecks, type RepoFiles } from './discover.js';
export { denyReason } from './deny-scan.js';
export { detectSandbox } from './sandbox.js';
export { checkResultText, runCheckDescription, runCheckInputSchema, type CheckSpec, type FrozenCheck } from './spec.js';
export {
  CheckSession,
  DEFAULT_CHECK_TIMEOUT_MS,
  openCheckSession,
  type OpenCheckSessionOptions,
  type OpenCheckSessionResult,
} from './session.js';
export type { CheckDef, CheckKind, CheckPlan, CheckRunResult, CheckRunStatus, HookDef, SandboxKind } from './types.js';
