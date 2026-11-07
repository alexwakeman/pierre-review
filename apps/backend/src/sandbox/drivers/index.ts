// THE AGENT OF A WORKSPACE SESSION (docs/SANDBOX.md § Agent drivers): the run choice resolved ONCE, then
// the provider's driver. The session manager (WP7) calls only these two.
//
// EVERY MODEL CALL STILL GOES THROUGH THE PROVIDER CHOICE: the request's `{provider, model}` is validated
// by ai/run-choice.ts (`resolveManualRunChoice`, kind `story_build`) before it reaches here; a stored
// model (a re-booted session) is mapped back through `requestModelOf`; each provider resolves the DEPTH
// to its own model (`getProvider(p).resolveModel`), and the effort is THE Settings level
// (`agenticRunEffort`, a worktree run: the agent has the whole workspace).
import type { AiProviderId } from '@pierre-review/shared';
import { agenticRunEffort } from '../../ai/effort.js';
import { claudeModelChoice, getProvider, requestModelOf } from '../../ai/provider.js';
import { startClaudeDriver } from './claude.js';
import { startCodexDriver } from './codex.js';
import type { SandboxAgentChoice, SandboxAgentDriver, SandboxAgentStartOptions } from './types.js';

/**
 * What a session runs on. `model` is the run choice's model (a Claude id naming the DEPTH, as
 * `resolveManualRunChoice` answers it) or a stored one (either provider's id). Read once, at the
 * session's start; the session stores what it returns.
 */
export function resolveSandboxAgentChoice(
  choice: { provider: AiProviderId; model: string },
  env: NodeJS.ProcessEnv = process.env,
): SandboxAgentChoice {
  const model = claudeModelChoice(requestModelOf(choice.model));
  // Claude keeps the exact id; Codex resolves a Claude id by its role (ai/providers/codex.ts).
  const resolved = getProvider(choice.provider).resolveModel(model);
  return { provider: choice.provider, model: resolved, effort: agenticRunEffort(choice.provider, model, 'worktree', env) };
}

/** Start the session's agent on its provider. */
export function startSandboxAgent(o: SandboxAgentStartOptions): Promise<SandboxAgentDriver> {
  return o.choice.provider === 'codex' ? startCodexDriver(o) : startClaudeDriver(o);
}

export type * from './types.js';
export { SandboxAgentBusyError, SandboxAgentExitedError } from './types.js';
