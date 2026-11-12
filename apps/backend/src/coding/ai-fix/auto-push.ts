// PUSH AUTOMATICALLY — after an AUTO fix SUCCEEDS, push it onto the PR's existing branch when the
// workspace switched "Push automatically" on (`workspaces.auto_fix_settings.autoPush`, default OFF;
// Settings → Auto review). CORE, free, local-only, like the rest of AI Fix.
//
// THE GATE, every part re-read at push time (the first that fails decides):
//   1. the fix is an AUTO fix, SUCCEEDED, with work to push (a non-empty patch, or — with the merge item —
//      a merge Limn checked as VALID: `fixRowHasWork`), never pushed;
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
import { fixRowHasWork } from '../../sandbox/session/fix-merge.js';

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
    if (row.status !== 'succeeded' || !fixRowHasWork(row) || row.pushedAt != null)
      return { status: 'skipped', reason: 'not_pushable' };
    const ws = await readWorkspaceAutoFixSettingsForPr(ctx, accountId, row.prId);
    if (!ws?.enabled || !ws.settings.autoPush) return { status: 'skipped', reason: 'off' };
    if (!(await deps.prAuthorIsAccount(ctx, accountId, row.prId))) return { status: 'skipped', reason: 'not_own' };

    const out = await deps.pushFix(ctx, { accountId, fixId, target: 'existing', origin: 'auto' });
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

// ── PUSH WHEN DONE (a MANUAL fix; docs/CLAUDE-REVIEW.md § AI Fix "Push when done") ───────────────────────────
// The reader ticked "Push when done" at start (ON by default in the SPA). After a build turn the fix session
// asks `pushWhenDoneReady`: when it says push, the session closes (`built`) and its close pushes through the
// Push button's own path (`maybePushWhenDone` → `pushFix` 'existing', never forced, HEAD_MOVED refused, write
// access re-checked). A push ends a fix session anyway, so nothing a reader could still do is lost.
// ⚠ IT HOLDS — the session stays open and says why, in ONE line — when the agent's report is missing, says an
// item is not fixed, or does not cover every item; and on a PR that is not the reader's own (a teammate's branch
// is pushed only on a press). Nothing to push ⇒ nothing said.

export type PushWhenDoneHold = 'off' | 'no_work' | 'pushed' | 'no_report' | 'unaddressed' | 'not_reported' | 'not_own';

function parseChangeReport(raw: string | null): { unaddressed?: unknown[]; notReported?: unknown[] } | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v != null && typeof v === 'object' ? (v as { unaddressed?: unknown[]; notReported?: unknown[] }) : null;
  } catch {
    return null;
  }
}

/** Why a finished manual fix is NOT pushed by itself; null = push it. Pure (auto-push.test.ts). */
export function pushWhenDoneHold(
  row: { trigger: string | null; pushWhenDone?: boolean | null; pushedAt: unknown; changeReport: string | null },
  o: { hasWork: boolean; own: boolean },
): { hold: PushWhenDoneHold; count?: number } | null {
  if ((row.trigger ?? 'manual') !== 'manual' || row.pushWhenDone !== true) return { hold: 'off' };
  if (row.pushedAt != null) return { hold: 'pushed' };
  if (!o.hasWork) return { hold: 'no_work' };
  const report = parseChangeReport(row.changeReport);
  if (report == null) return { hold: 'no_report' };
  const unaddressed = Array.isArray(report.unaddressed) ? report.unaddressed.length : 0;
  if (unaddressed > 0) return { hold: 'unaddressed', count: unaddressed };
  if (Array.isArray(report.notReported) && report.notReported.length > 0) return { hold: 'not_reported', count: report.notReported.length };
  if (!o.own) return { hold: 'not_own' };
  return null;
}

/** The session's one line for a hold; null when there is nothing to say (off, already pushed, nothing to push). */
export function pushWhenDoneHoldLine(h: { hold: PushWhenDoneHold; count?: number } | null): string | null {
  if (h == null) return null;
  const n = h.count ?? 0;
  switch (h.hold) {
    case 'unaddressed':
      return `Not pushed: the agent says ${n === 1 ? '1 item is' : `${n} items are`} not fixed. Ask for more, or press Push.`;
    case 'not_reported':
      return `Not pushed: the agent's report does not cover ${n === 1 ? '1 item' : `${n} items`}. Ask for more, or press Push.`;
    case 'no_report':
      return 'Not pushed: the agent did not hand in a valid report. Check the changes, then press Push.';
    case 'not_own':
      return 'Not pushed: this is not your pull request. Press Push to push to its branch.';
    default:
      return null;
  }
}

/** After a manual build turn: push it (close the session), or the line to show while it waits. */
export async function pushWhenDoneReady(
  ctx: AgentContext,
  accountId: number,
  fixId: number,
  deps: Pick<AutoPushDeps, 'prAuthorIsAccount'> = defaultDeps,
): Promise<{ push: true } | { push: false; line: string | null }> {
  const row = await getFixById(ctx, accountId, fixId);
  if (!row || row.pushWhenDone !== true) return { push: false, line: null };
  const own = await deps.prAuthorIsAccount(ctx, accountId, row.prId).catch(() => false);
  const hold = pushWhenDoneHold(row, { hasWork: fixRowHasWork(row), own });
  return hold == null ? { push: true } : { push: false, line: pushWhenDoneHoldLine(hold) };
}

/**
 * The close of a manual fix with "Push when done": every rule re-read at push time (the row closed `built`,
 * succeeded), then the Push button's path. A failure is recorded on the row ("Automatic push failed: …",
 * shown in the AI Fix tab) and never retried — the reader can still press Push.
 */
export async function maybePushWhenDone(
  ctx: AgentContext,
  input: { accountId: number; fixId: number },
  deps: AutoPushDeps = defaultDeps,
): Promise<AutoPushDecision> {
  const { accountId, fixId } = input;
  try {
    const row = await getFixById(ctx, accountId, fixId);
    if (!row || row.status !== 'succeeded') return { status: 'skipped', reason: 'not_pushable' };
    const own = await deps.prAuthorIsAccount(ctx, accountId, row.prId);
    const hold = pushWhenDoneHold(row, { hasWork: fixRowHasWork(row), own });
    if (hold != null) return { status: 'skipped', reason: hold.hold === 'not_own' ? 'not_own' : hold.hold === 'off' ? 'off' : 'not_pushable' };
    const out = await deps.pushFix(ctx, { accountId, fixId, target: 'existing', origin: 'reader_pressed' });
    if (out.ok) {
      ctx.log.info(`push when done: fix ${fixId} pushed to ${out.result.pushedBranch}`);
      return { status: 'pushed', branch: out.result.pushedBranch };
    }
    const message = autoPushMessage(out);
    await markFixPushFailed(ctx, fixId, message).catch(() => {});
    return { status: 'failed', message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFixPushFailed(ctx, fixId, message).catch(() => {});
    ctx.log.warn(`push when done: fix ${fixId} failed: ${message}`);
    return { status: 'failed', message };
  }
}
