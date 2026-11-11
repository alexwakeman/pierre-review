// PUSH AUTOMATICALLY — "Push and open the pull request when the build finishes" (docs/STORY-BUILD.md
// § Push automatically). The reader's OPT-IN on Implement and Fill gaps (`story_builds.auto_push`, OFF by
// default; ticked in the Start panel, changeable in the tab until the build pushed). THE TICK IS THE
// CONSENT: with it on, the HOST runs the Push button's own path once, after a build turn that ended well.
//
// THE GATE, every part re-read at push time (the first that fails decides; a "no" records nothing):
//   1. the option is ON and the automatic push was never claimed (`auto_push_claimed_at` NULL);
//   2. the build is `ready` (the session settled in `built`) and something is ready to push — a person's
//      Push before this leaves nothing, so a person's action wins;
//   3. THE CLAIM: compare-and-set `auto_push_claimed_at` (WHERE auto_push = 1, status 'ready', it is NULL) BEFORE any
//      GitHub write. Never cleared: ONCE per build, never retried (a later build turn, a resume or a
//      restart never pushes again);
//   4. then `pushAllRepos` — or `pushPlannedStack` for a plan-first build with planned PRs — with
//      `draft: false` (auto review SKIPS drafts; the point is that the reader's auto review picks the PR up —
//      it is the READER'S PR, never their `limn:` bot's). The reader's own GitHub login, like the button (git-ops `getAccessToken`).
// A concurrent manual press is safe: the push paths' own guards (ALREADY_PUSHED, PUSH_IN_PROGRESS, the
// stack's in-flight set) answer `skipped`, which is not a failure; when NOTHING was pushed that way the build
// records AUTO_PUSH_TAKEN_OVER, so the tab never says "Pushing…" for ever. A claim a restart cut off is
// recorded at boot (`reconcileStoryAutoPushOnStartup`, never a push). A FAILURE is RECORDED — the item's own
// `push_error` + `push_error_code` (BRANCH_EXISTS ⇒ the tab offers a new name) and one sentence on the
// build (`auto_push_error`) — and NEVER retried; the reader can still press Push.
// ⚠ Never throws: a push failing must never touch the session.
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { StoryBuildRepoPushResult } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { getStoryBuildRow, listStoryBuildRepoRows, updateStoryBuild } from './persist.js';
import { listPlannedPrRows } from './plan-persist.js';
import { pushAllRepos } from './push.js';
import { isPlannedBuild, pushPlannedStack } from './push-stack.js';

type Ctx = Pick<AgentContext, 'db' | 'schema'>;
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const B = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).storyBuilds;

export type StoryAutoPushDecision =
  | { status: 'pushed'; opened: number }
  | { status: 'failed'; message: string }
  | { status: 'skipped'; reason: 'off' | 'claimed' | 'not_ready' | 'nothing' };

/** One pushed or failed item, whichever path pushed it. */
type Outcome = Pick<StoryBuildRepoPushResult, 'outcome' | 'code' | 'error'>;

export interface StoryAutoPushDeps {
  isPlannedBuild: (ctx: AgentContext, accountId: number, buildId: number) => Promise<boolean>;
  pushAll: (ctx: AgentContext, accountId: number, buildId: number) => Promise<Outcome[] | null>;
  pushStack: (ctx: AgentContext, accountId: number, buildId: number) => Promise<Outcome[] | null>;
}

const defaultDeps: StoryAutoPushDeps = {
  isPlannedBuild,
  pushAll: (ctx, accountId, buildId) => pushAllRepos(ctx, { accountId, buildId, draft: false }),
  pushStack: (ctx, accountId, buildId) => pushPlannedStack(ctx, { accountId, buildId, draft: false }),
};

/** Builds with an automatic push in flight in this process (the session refuses a message; Discard waits). */
const autoPushing = new Set<number>();

export function isStoryBuildAutoPushing(buildId: number): boolean {
  return autoPushing.has(buildId);
}

/** THE CLAIM (compare-and-set, before any GitHub write). True when this caller won it. */
export async function claimStoryBuildAutoPush(ctx: Ctx, accountId: number, buildId: number, now = new Date()): Promise<boolean> {
  const b = B(ctx);
  const rows = (await ctx.db
    .update(b)
    .set({ autoPushClaimedAt: now, autoPushError: null })
    .where(and(eq(b.id, buildId), eq(b.accountId, accountId), eq(b.autoPush, true), isNull(b.autoPushClaimedAt), eq(b.status, 'ready')))
    .returning({ id: b.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

export type SetAutoPushResult = { status: 'ok'; autoPush: boolean } | { status: 'not_found' } | { status: 'pushed' };

/**
 * The tab's switch (`POST …/auto-push`). Refused once anything of the build was pushed or the automatic
 * push was claimed (compare-and-set on `auto_push_claimed_at IS NULL`, so it never races the claim).
 */
export async function setStoryBuildAutoPush(ctx: Ctx, accountId: number, buildId: number, on: boolean): Promise<SetAutoPushResult> {
  const build = await getStoryBuildRow(ctx, accountId, buildId);
  if (!build) return { status: 'not_found' };
  if (build.status === 'discarded' || build.autoPushClaimedAt != null) return { status: 'pushed' };
  const repos = await listStoryBuildRepoRows(ctx, accountId, buildId);
  const prs = await listPlannedPrRows(ctx, accountId, buildId);
  if (repos.some((r) => r.status === 'pushed') || prs.some((p) => p.status === 'pushed')) return { status: 'pushed' };
  const b = B(ctx);
  const rows = (await ctx.db
    .update(b)
    .set({ autoPush: on })
    .where(and(eq(b.id, buildId), eq(b.accountId, accountId), isNull(b.autoPushClaimedAt)))
    .returning({ id: b.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0 ? { status: 'ok', autoPush: on } : { status: 'pushed' };
}

/** Something is ready to push: a planned PR (plan first) or an included repository, with a patch. */
async function hasWorkToPush(ctx: Ctx, accountId: number, buildId: number, planned: boolean): Promise<boolean> {
  if (planned) return (await listPlannedPrRows(ctx, accountId, buildId)).some((p) => p.status === 'ready' && Boolean(p.patch));
  return (await listStoryBuildRepoRows(ctx, accountId, buildId)).some((r) => r.include && r.status === 'ready' && Boolean(r.patch));
}

/** The one sentence the tab shows after "Automatic push failed:". */
export function autoPushFailureLine(failed: readonly Outcome[], attempted: number): string {
  const first = failed[0]?.error?.trim() || 'GitHub refused the push.';
  if (failed.length <= 1) return first;
  return `${failed.length} of ${attempted} were not pushed. ${first}`;
}

/** The sentence when the automatic push pushed nothing because the reader's own press held every item. */
export const AUTO_PUSH_TAKEN_OVER = 'Your own push was already running.';
/** The sentence the boot reconcile records for a claim a restart cut off before it answered. */
export const AUTO_PUSH_INTERRUPTED = 'Limn stopped before the push finished. Press Push.';

/** Run the automatic push for one build when the gate says so (see the header). Never throws. */
export async function maybeAutoPushBuild(
  ctx: AgentContext,
  input: { accountId: number; buildId: number },
  deps: StoryAutoPushDeps = defaultDeps,
): Promise<StoryAutoPushDecision> {
  const { accountId, buildId } = input;
  // HELD FROM THE FIRST TICK (before any await): a reader's message in the gate's reads would start a build
  // turn and spend the one claim on a BUSY refusal; the session's busyReason reads this set.
  if (autoPushing.has(buildId)) return { status: 'skipped', reason: 'claimed' };
  autoPushing.add(buildId);
  let claimed = false;
  try {
    const build = await getStoryBuildRow(ctx, accountId, buildId);
    if (!build || !build.autoPush) return { status: 'skipped', reason: 'off' };
    if (build.autoPushClaimedAt != null) return { status: 'skipped', reason: 'claimed' };
    if (build.status !== 'ready') return { status: 'skipped', reason: 'not_ready' };
    const planned = await deps.isPlannedBuild(ctx, accountId, buildId);
    if (!(await hasWorkToPush(ctx, accountId, buildId, planned))) return { status: 'skipped', reason: 'nothing' };
    // THE CLAIM — it also re-checks the option and the build's state in the same statement.
    if (!(await claimStoryBuildAutoPush(ctx, accountId, buildId))) {
      const again = await getStoryBuildRow(ctx, accountId, buildId);
      return { status: 'skipped', reason: !again?.autoPush ? 'off' : again.autoPushClaimedAt != null ? 'claimed' : 'not_ready' };
    }
    claimed = true;
    const results = (planned ? await deps.pushStack(ctx, accountId, buildId) : await deps.pushAll(ctx, accountId, buildId)) ?? [];
    // `skipped` (ALREADY_PUSHED, PUSH_IN_PROGRESS: a person's press; a stack item below a failure) is no
    // failure of its own; each failed item already carries its own `push_error` + code.
    const failed = results.filter((r) => r.outcome === 'failed');
    const opened = results.filter((r) => r.outcome === 'pushed').length;
    if (failed.length > 0) {
      const message = autoPushFailureLine(failed, failed.length + opened);
      await updateStoryBuild(ctx, accountId, buildId, { autoPushError: message }).catch(() => {});
      ctx.log.info(`story build ${buildId}: automatic push: ${failed.length} not pushed (${failed.map((f) => f.code ?? 'failed').join(', ')})`);
      return { status: 'failed', message };
    }
    if (opened === 0) {
      // The reader's own press held every item: say so, so the tab leaves "Pushing…" (their press shows
      // its own result on each item).
      await updateStoryBuild(ctx, accountId, buildId, { autoPushError: AUTO_PUSH_TAKEN_OVER }).catch(() => {});
      ctx.log.info(`story build ${buildId}: automatic push: nothing pushed (the reader's push held it)`);
      return { status: 'failed', message: AUTO_PUSH_TAKEN_OVER };
    }
    ctx.log.info(`story build ${buildId}: automatic push opened ${opened}`);
    return { status: 'pushed', opened };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Recorded only once claimed: before the claim nothing was written, and the reader's Push still works.
    if (claimed) await updateStoryBuild(ctx, accountId, buildId, { autoPushError: message }).catch(() => {});
    ctx.log.warn(`story build ${buildId}: automatic push failed: ${message}`);
    return claimed ? { status: 'failed', message } : { status: 'skipped', reason: 'not_ready' };
  } finally {
    autoPushing.delete(buildId);
  }
}

/**
 * BOOT: a claim with no answer (no failure recorded, nothing pushed) was cut off by a restart. Record that,
 * so the tab says it and the reader presses Push. NEVER pushes. Every account's rows; returns how many.
 */
export async function reconcileStoryAutoPushOnStartup(ctx: Ctx & Pick<AgentContext, 'log'>): Promise<number> {
  const b = B(ctx);
  const rows = (await ctx.db
    .select({ id: b.id, accountId: b.accountId })
    .from(b)
    .where(and(isNotNull(b.autoPushClaimedAt), isNull(b.autoPushError)))
    .execute()) as Array<{ id: number; accountId: number }>;
  let marked = 0;
  for (const r of rows) {
    if (autoPushing.has(r.id)) continue;
    const repos = await listStoryBuildRepoRows(ctx, r.accountId, r.id);
    const prs = await listPlannedPrRows(ctx, r.accountId, r.id);
    if (repos.some((x) => x.status === 'pushed') || prs.some((x) => x.status === 'pushed')) continue;
    await updateStoryBuild(ctx, r.accountId, r.id, { autoPushError: AUTO_PUSH_INTERRUPTED });
    marked += 1;
  }
  if (marked > 0) ctx.log.info(`marked ${marked} automatic story-build push(es) cut off by a restart`);
  return marked;
}
