// PUSH AUTOMATICALLY — after an AUTO fix SUCCEEDS, push it onto the PR's existing branch when the
// workspace switched "Push automatically" on (`workspaces.auto_fix_settings.autoPush`, default OFF;
// Settings → Auto review). CORE, free, local-only, like the rest of AI Fix.
//
// THE GATE, every part re-read at push time (the first that fails decides):
//   1. the fix is an AUTO fix, SUCCEEDED, with a non-empty patch, never pushed;
//   2. the workspace holding the PR's repo still has auto AI Fix ON and `autoPush` ON;
//   3. the PR's author IS the account's own GitHub user (`prAuthorIsAccount`) — never anyone else's;
//   4. then `pushFix` with target 'existing' — the Push button's own path: write access re-checked,
//      the branch's head must still be the fix's base (HEAD_MOVED otherwise), NEVER forced, and the
//      PR settled after the write.
// A gate that says no does nothing and records nothing (the fix waits for a person's Push). A push
// that FAILS is recorded on the row (`markFixPushFailed` → the AI Fix tab says so) and is NEVER
// retried — the reader can still press Push.
// ⚠ Never throws: a push failing must never touch the fix or the review.
import type { AgentContext } from '../../review/agent-context.js';
import { readWorkspaceAutoFixSettingsForPr } from '../../review/claude-review/auto-settings.js';
import { getFixById, markFixPushFailed } from './persist.js';
import { pushFix, type PushFixOutcome } from './push.js';

export type AutoPushDecision =
  | { status: 'pushed'; branch: string }
  | { status: 'failed'; message: string }
  | { status: 'skipped'; reason: 'not_auto' | 'not_pushable' | 'off' | 'not_own' };

export interface AutoPushDeps {
  pushFix: (ctx: AgentContext, input: Parameters<typeof pushFix>[1]) => Promise<PushFixOutcome>;
  prAuthorIsAccount: (ctx: AgentContext, accountId: number, prId: number) => Promise<boolean>;
}

const defaultDeps: AutoPushDeps = {
  pushFix,
  // Lazy: auto-fix.ts imports the manager, which calls this module — no import-time cycle.
  prAuthorIsAccount: async (ctx, accountId, prId) =>
    (await import('./auto-fix.js')).prAuthorIsAccount(ctx, accountId, prId),
};

export async function maybeAutoPushFix(
  ctx: AgentContext,
  input: { accountId: number; fixId: number },
  deps: AutoPushDeps = defaultDeps,
): Promise<AutoPushDecision> {
  const { accountId, fixId } = input;
  try {
    const row = await getFixById(ctx, accountId, fixId);
    if (!row || row.trigger !== 'auto') return { status: 'skipped', reason: 'not_auto' };
    if (row.status !== 'succeeded' || !(row.patch ?? '').trim() || row.pushedAt != null)
      return { status: 'skipped', reason: 'not_pushable' };
    const ws = await readWorkspaceAutoFixSettingsForPr(ctx, accountId, row.prId);
    if (!ws?.enabled || !ws.settings.autoPush) return { status: 'skipped', reason: 'off' };
    if (!(await deps.prAuthorIsAccount(ctx, accountId, row.prId))) return { status: 'skipped', reason: 'not_own' };

    const out = await deps.pushFix(ctx, { accountId, fixId, target: 'existing' });
    if (out.ok) {
      ctx.log.info(`auto push: fix ${fixId} pushed to ${out.result.pushedBranch}`);
      return { status: 'pushed', branch: out.result.pushedBranch };
    }
    const message = autoPushMessage(out);
    await markFixPushFailed(ctx, fixId, message).catch(() => {});
    ctx.log.info(`auto push: fix ${fixId} not pushed: ${out.code}`);
    return { status: 'failed', message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFixPushFailed(ctx, fixId, message).catch(() => {});
    ctx.log.warn(`auto push: fix ${fixId} failed: ${message}`);
    return { status: 'failed', message };
  }
}

/** The one sentence the AI Fix tab shows after "Automatic push failed:". */
function autoPushMessage(out: Extract<PushFixOutcome, { ok: false }>): string {
  switch (out.code) {
    case 'HEAD_MOVED':
      return 'the branch moved since the fix was made.';
    case 'no_write':
      return 'you cannot push to this repository.';
    case 'head_unavailable':
      return 'the PR branch could not be read.';
    case 'PUSH_DENIED':
      return 'GitHub refused the push.';
    case 'APPLY_FAILED':
      return 'the fix no longer applies to the branch.';
    default:
      return out.message || 'unknown error.';
  }
}
