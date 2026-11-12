// THE REVIEW LOOP — THE STATE MACHINE (docs/STORY-BUILD.md § The review loop). "After the build: review and
// fix, then open the pull request" (`story_builds.auto_push`; `loop_rounds` = N, default 3):
//
//   built ──maybeStartLoop──► [CLAIM loop_claimed_at] ──► pushing (round 0: each target's branch, no PR)
//   pushing ──► reviewing k (each target's code review — the workspace's AI review providers, a pair runs
//                AT ONCE — and ONE story check across every target)
//   reviewing ──nothing open, or k = N + 1 (the closing review)──► opening ──► done
//   reviewing ──open, k ≤ N──► fixing k (a host-started build turn: REVIEW.md, every item answered)
//   fixing ──turn ended──► pushing k (a fast-forward commit per changed target) ──► reviewing k + 1
//   any ──a refusal / failure──► paused (one line; Continue goes back to `loop_resume`)
//   any ──Stop──► stopped (the work and the branches stay)      a restart ──► paused (interrupted)
//
// RULES:
//   • every GitHub write is a `story_build_loop_pushes` row CLAIMED (inserted) BEFORE the write, never
//     retried by itself — a new attempt is the reader's Continue (which first ADOPTS a write a restart cut
//     off after it landed: the live branch / the open PR);
//   • every AUTOMATIC model run asks the ONE spend gate first (review/budget-gate.ts); a refusal before the
//     round started pauses ('budget'); the step a reader's Continue resumes is the READER'S and skips it;
//   • nothing is posted to GitHub but the branch commits and, at the end, the PR (ready for review, the
//     reader's own); nothing is written to the tracker;
//   • the session is HELD (no idle close) from the start claim until the PRs open or the loop pauses;
//   • never throws to the session.
import {
  clampLoopRounds,
  STORY_BUILD_LOOP_PAUSE_LINE,
  type AiProviderId,
  type ClaudeReviewPairConsolidation,
  type ClaudeReviewTicket,
  type StoryBuild,
  type StoryBuildLoop,
  type StoryBuildLoopPause,
  type StoryBuildLoopState,
} from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import { REVIEW_REFS_FILE, REVIEW_RESPONSE_CHECKER, REVIEW_RESPONSE_FILE, reviewResponseCheckerSource } from '../../../sandbox/workspace/review-response.js';
import { HEAD_MOVED_LOOP_LINE } from '../../git-ops.js';
import { getStoryBuildRow, listStoryBuildRepoRows, updateStoryBuildRepo, type StoryBuildRow } from '../persist.js';
import { listPlannedPrRows, updateStoryBuildPr } from '../plan-persist.js';
import { renameRefusal, repoFacts } from '../push.js';
import { LOOP_REVIEW_FEATURE, type LoopHalfResult } from './branch-review.js';
import {
  claimLoopPush,
  claimLoopStart,
  dropUnsucceededReviews,
  failLoopPush,
  finishLoopPush,
  insertLoopFindings,
  insertLoopReview,
  latestPush,
  listLoopAcResponses,
  listLoopFindings,
  listLoopPushes,
  listLoopReviews,
  listLoopStoryChecks,
  setLoop,
  updateLoopFinding,
  updateLoopReview,
  updateLoopTarget,
  upsertLoopAcResponse,
  upsertLoopStoryCheck,
  type LoopClaim,
  type LoopPushRow,
  type LoopResume,
  type LoopStep,
} from './persist.js';
import { prOpenFacts } from './pr-facts.js';
import { buildLoopFixInstruction, buildLoopFixSeed, type LoopSeedCriterion, type LoopSeedFinding } from './seed.js';
import { defaultLoopSeams, type LoopSeams } from './seams.js';
import { LOOP_CHECK_FEATURE } from './story-check.js';
import { isLive, loopTargets, reviewBaseOf, type LoopTarget } from './targets.js';
import { loopBodySummaryOf, notCheckedFindingsOf, openCriteriaOf, openFindingsOf, priorForTarget, roundOpen, runWireOf, toStoryBuildLoop } from './wire.js';
import { markLoopReviewOnPr } from './review-on-pr.js';
import { loopBodySection } from './pr-body.js';

export const LOOP_FIX_FEATURE = 'story_loop_fix';

let seams: LoopSeams = defaultLoopSeams();

/** Test seam: replace any of the seams (null ⇒ the real ones). */
export function setStoryLoopSeamsForTests(s: Partial<LoopSeams> | null): void {
  const d = defaultLoopSeams();
  seams = s == null ? d : { ...d, ...s, session: { ...d.session, ...(s.session ?? {}) } };
}

/** Builds whose loop is working in this process (a push, a review, an open). Set SYNCHRONOUSLY. */
const running = new Map<number, { abort: AbortController; step: StoryBuildLoopState }>();

export function isStoryLoopBusy(buildId: number): boolean {
  return running.has(buildId);
}

/** The session refuses a reader's message while the loop pushes or reviews (a fix turn is itself busy). */
export function storyLoopBusyReason(buildId: number): string | null {
  return running.has(buildId) ? 'Wait for the review round to finish, or press Stop.' : null;
}

/** Discard waits while the loop pushes or opens a PR. */
export function storyLoopDiscardRefusal(buildId: number): string | null {
  const r = running.get(buildId);
  return r && (r.step === 'pushing' || r.step === 'opening') ? 'Wait for the push to finish.' : null;
}

// ⚠ NOT under `refs/pierre/story-loop/<buildId>` (the review's and the story check's checkout ref): git
// cannot hold a ref and refs below it of the same name, so the two namespaces stay apart.
const destRef = (buildId: number, t: Pick<LoopTarget, 'kind' | 'id'>): string => `refs/pierre/story-loop-push/${buildId}/${t.kind}-${t.id}`;

// ---- the wire -----------------------------------------------------------------------------------------------

/** The loop as the build's wire carries it (null when the option was never on and the loop never ran). */
export async function storyLoopWire(ctx: AgentContext, accountId: number, row: StoryBuildRow): Promise<StoryBuildLoop | null> {
  if (!row.autoPush && row.loopState == null) return null;
  const [targets, pushes, reviews, findings, checks, acResponses, providers, repos, prs] = await Promise.all([
    loopTargets(ctx, accountId, row.id),
    listLoopPushes(ctx, accountId, row.id),
    listLoopReviews(ctx, accountId, row.id),
    listLoopFindings(ctx, accountId, row.id),
    listLoopStoryChecks(ctx, accountId, row.id),
    listLoopAcResponses(ctx, accountId, row.id),
    seams.providers(ctx, accountId, row.workspaceId).catch(() => [] as AiProviderId[]),
    listStoryBuildRepoRows(ctx, accountId, row.id),
    listPlannedPrRows(ctx, accountId, row.id),
  ]);
  const anyPushed = repos.some((r) => r.status === 'pushed' && r.loopEnded == null) || prs.some((p) => p.status === 'pushed' && p.loopEnded == null);
  return toStoryBuildLoop({
    build: {
      id: row.id,
      ident: row.ident,
      ticketKey: row.ticketKey,
      ticketTitle: row.ticketTitle ?? null,
      workspaceId: row.workspaceId,
      autoPush: row.autoPush === true,
      loopRounds: row.loopRounds,
      loopState: (row.loopState as StoryBuildLoopState | null) ?? null,
      loopRound: row.loopRound,
      loopPause: (row.loopPause as StoryBuildLoopPause | null) ?? null,
      loopError: row.loopError ?? null,
      loopClaimedAt: row.loopClaimedAt ?? null,
    },
    targets,
    pushes,
    reviews,
    findings,
    checks,
    acResponses,
    providers,
    anyPushed,
    running: running.has(row.id),
  });
}

async function emitLoop(ctx: AgentContext, accountId: number, buildId: number): Promise<void> {
  const row = await getStoryBuildRow(ctx, accountId, buildId).catch(() => null);
  if (!row) return;
  const loop = await storyLoopWire(ctx, accountId, row).catch(() => null);
  if (loop) seams.session.emit(buildId, { type: 'loop', loop });
}

/** The reader pressed Stop (the row says so): no step may write over it. */
async function stoppedNow(ctx: AgentContext, accountId: number, buildId: number): Promise<boolean> {
  const row = await getStoryBuildRow(ctx, accountId, buildId).catch(() => null);
  return row?.loopState === 'stopped';
}

async function setState(ctx: AgentContext, accountId: number, buildId: number, state: StoryBuildLoopState, round: number, extra: { loopFinishedAt?: Date } = {}): Promise<void> {
  const r = running.get(buildId);
  if (r) r.step = state;
  if (await stoppedNow(ctx, accountId, buildId)) return;
  if (state === 'done' || state === 'failed') seams.session.release(buildId);
  await setLoop(ctx, accountId, buildId, { loopState: state, loopRound: round, loopPause: null, loopError: null, loopResume: null, ...extra });
  await emitLoop(ctx, accountId, buildId);
}

/** PAUSE (one plain line; Continue goes back to `resume`). The session is released (an idle close is fine). */
async function pause(ctx: AgentContext, accountId: number, buildId: number, why: StoryBuildLoopPause, resume: LoopResume, detail: string | null = null): Promise<'paused'> {
  if (await stoppedNow(ctx, accountId, buildId)) return 'paused';
  const line = detail ? `${STORY_BUILD_LOOP_PAUSE_LINE[why].replace(/ Press Continue.*$/, '')} ${detail} Press Continue to go on.`.replace(/\.\s+([A-Z])/, '. $1') : STORY_BUILD_LOOP_PAUSE_LINE[why];
  await setLoop(ctx, accountId, buildId, { loopState: 'paused', loopPause: why, loopError: line, loopResume: resume });
  seams.session.release(buildId);
  seams.session.notice(buildId, line);
  ctx.log.info(`story build ${buildId}: review loop paused (${why})`);
  await emitLoop(ctx, accountId, buildId);
  return 'paused';
}

/** Run `advance` off the caller's tick, with the in-process marker set SYNCHRONOUSLY. false ⇒ already running. */
function kick(ctx: AgentContext, accountId: number, buildId: number, byReader: boolean): boolean {
  if (running.has(buildId)) return false;
  const abort = new AbortController();
  running.set(buildId, { abort, step: 'waiting' });
  void (async () => {
    try {
      await advance(ctx, accountId, buildId, abort, byReader);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`story build ${buildId}: review loop step failed: ${message}`);
      const row = await getStoryBuildRow(ctx, accountId, buildId).catch(() => null);
      const resume = ((row?.loopState as LoopResume | null) ?? 'reviewing') as LoopResume;
      if (row && row.loopState !== 'stopped' && row.loopState !== 'paused') await pause(ctx, accountId, buildId, 'review_failed', resume, null).catch(() => {});
    } finally {
      running.delete(buildId);
      await emitLoop(ctx, accountId, buildId).catch(() => {});
    }
  })();
  return true;
}

/** Test seam: wait until no loop works in this process. */
export async function _storyLoopsIdleForTest(timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (running.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
}

// ---- the entry points --------------------------------------------------------------------------------------

/**
 * After a build turn that ended well: start the loop when the option is on and it never started (THE CLAIM).
 * An old row whose automatic push was already claimed keeps its recorded outcome. Never throws.
 */
export async function maybeStartLoop(ctx: AgentContext, input: { accountId: number; buildId: number }): Promise<'started' | 'skipped'> {
  const { accountId, buildId } = input;
  try {
    if (running.has(buildId)) return 'skipped';
    const b = await getStoryBuildRow(ctx, accountId, buildId);
    if (!b || !b.autoPush || b.loopClaimedAt != null || b.autoPushClaimedAt != null || b.status !== 'ready') return 'skipped';
    const targets = (await loopTargets(ctx, accountId, buildId)).filter(isLive);
    if (targets.length === 0) return 'skipped';
    if (running.has(buildId)) return 'skipped';
    if (!(await claimLoopStart(ctx, accountId, buildId, seams.now()))) return 'skipped';
    seams.session.hold(buildId);
    seams.session.notice(buildId, 'Limn pushes the branch, then reviews it.');
    kick(ctx, accountId, buildId, false);
    return 'started';
  } catch (err) {
    ctx.log.warn(`story build ${buildId}: review loop did not start: ${err instanceof Error ? err.message : String(err)}`);
    return 'skipped';
  }
}

export type ContinueResult =
  | { status: 'continued' }
  | { status: 'not_found' }
  | { status: 'not_paused'; message: string }
  | { status: 'refused'; message: string };

/** The reader's Continue: one new attempt of the step the loop paused at (never refused by the spend gate). */
export async function continueLoop(
  ctx: AgentContext,
  accountId: number,
  buildId: number,
  o: { branch?: { kind: 'repo' | 'pr'; id: number; name: string } } = {},
): Promise<ContinueResult> {
  const b = await getStoryBuildRow(ctx, accountId, buildId);
  if (!b) return { status: 'not_found' };
  if (running.has(buildId)) return { status: 'not_paused', message: 'The review loop is running.' };
  if (b.loopState !== 'paused') return { status: 'not_paused', message: 'The review loop is not paused.' };
  if (o.branch) {
    const refused = await renameRefusal(o.branch.name);
    if (refused) return { status: 'refused', message: refused };
    const t = (await loopTargets(ctx, accountId, buildId)).find((x) => x.kind === o.branch!.kind && x.id === o.branch!.id);
    if (!t) return { status: 'not_found' };
    if (t.loopBranch) return { status: 'refused', message: 'This branch is already on GitHub.' };
    await updateLoopTarget(ctx, accountId, t.kind, t.id, { branch: o.branch.name.trim(), pushError: null, pushErrorCode: null });
  }
  const resume = (b.loopResume as LoopResume | null) ?? 'reviewing';
  if (running.has(buildId)) return { status: 'not_paused', message: 'The review loop is running.' };
  await setLoop(ctx, accountId, buildId, { loopState: resume, loopPause: null, loopError: null, loopResume: null });
  if (resume !== 'opening') seams.session.hold(buildId);
  kick(ctx, accountId, buildId, true);
  return { status: 'continued' };
}

/** "Stop review loop": at the next checkpoint (reviews aborted, a fix turn interrupted). The work and the branches stay. */
export async function stopLoop(ctx: AgentContext, accountId: number, buildId: number): Promise<'stopped' | 'not_found' | 'not_running' | 'busy'> {
  const b = await getStoryBuildRow(ctx, accountId, buildId);
  if (!b) return 'not_found';
  // A push or a PR open is one GitHub write per target, claimed: it finishes (as Discard waits for it).
  if (storyLoopDiscardRefusal(buildId)) return 'busy';
  const st = b.loopState as StoryBuildLoopState | null;
  if (st == null || st === 'done' || st === 'stopped' || st === 'failed') return 'not_running';
  await setLoop(ctx, accountId, buildId, { loopState: 'stopped', loopPause: null, loopResume: null, loopError: 'You stopped the review loop. The branch and the work are kept: push from Limn to open the pull request.', loopFinishedAt: seams.now() });
  running.get(buildId)?.abort.abort();
  if (st === 'fixing') await seams.session.interrupt(ctx, accountId, buildId);
  seams.session.release(buildId);
  await emitLoop(ctx, accountId, buildId);
  return 'stopped';
}

/** Discard: stop a loop that is not mid-push (the caller checked `storyLoopDiscardRefusal`). */
export async function stopLoopForDiscard(ctx: AgentContext, accountId: number, buildId: number): Promise<void> {
  await stopLoop(ctx, accountId, buildId);
}

/** The tab's switch and rounds (`POST …/loop/settings`): refused once the loop started or anything pushed. */
export async function setLoopSettings(
  ctx: AgentContext,
  accountId: number,
  buildId: number,
  o: { on?: boolean; rounds?: number },
): Promise<{ status: 'ok' } | { status: 'not_found' } | { status: 'started' }> {
  const b = await getStoryBuildRow(ctx, accountId, buildId);
  if (!b) return { status: 'not_found' };
  if (b.status === 'discarded' || b.loopClaimedAt != null || b.autoPushClaimedAt != null) return { status: 'started' };
  const repos = await listStoryBuildRepoRows(ctx, accountId, buildId);
  const prs = await listPlannedPrRows(ctx, accountId, buildId);
  if (repos.some((r) => r.status === 'pushed') || prs.some((p) => p.status === 'pushed')) return { status: 'started' };
  const t = (ctx.schema as unknown as { storyBuilds: never }).storyBuilds;
  const { and, eq, isNull } = await import('drizzle-orm');
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const bt = t as any;
  const rows = (await ctx.db
    .update(bt)
    .set({ ...(o.on !== undefined ? { autoPush: o.on } : {}), ...(o.rounds !== undefined ? { loopRounds: clampLoopRounds(o.rounds) } : {}) })
    .where(and(eq(bt.id, buildId), eq(bt.accountId, accountId), isNull(bt.loopClaimedAt), isNull(bt.autoPushClaimedAt)))
    .returning({ id: bt.id })
    .execute()) as Array<{ id: number }>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (rows.length === 0) return { status: 'started' };
  await emitLoop(ctx, accountId, buildId);
  return { status: 'ok' };
}

// ---- the state machine ---------------------------------------------------------------------------------------

async function advance(ctx: AgentContext, accountId: number, buildId: number, abort: AbortController, firstByReader: boolean): Promise<void> {
  let byReader = firstByReader;
  for (let guard = 0; guard < 40; guard++) {
    if (abort.signal.aborted) return;
    const b = await getStoryBuildRow(ctx, accountId, buildId);
    if (!b) return;
    const k = b.loopRound;
    const st = b.loopState as StoryBuildLoopState | null;
    const r = running.get(buildId);
    if (r && st) r.step = st;
    if (st === 'pushing') {
      const got = k === 0 ? await stepInitialPush(ctx, accountId, b) : await stepFixPush(ctx, accountId, b, k);
      if (got === 'paused' || abort.signal.aborted) return;
      await setState(ctx, accountId, buildId, 'reviewing', k + 1);
    } else if (st === 'reviewing') {
      const got = await stepReview(ctx, accountId, b, k, abort, byReader);
      if (got === 'paused' || got === 'stopped' || abort.signal.aborted) return;
      await setState(ctx, accountId, buildId, got === 'open' ? 'opening' : 'fixing', k);
    } else if (st === 'fixing') {
      await stepStartFix(ctx, accountId, b, k, abort, byReader);
      return;
    } else if (st === 'opening') {
      await stepOpen(ctx, accountId, b, k);
      return;
    } else {
      return;
    }
    byReader = false;
  }
}

/** Push failure → the pause word and line. */
function pushPauseOf(code: string): StoryBuildLoopPause {
  return code === 'BRANCH_EXISTS' ? 'branch_exists' : 'push_failed';
}

const errCode = (err: unknown): string => ((err as { code?: string })?.code ?? 'failed');
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Protected names of a target's push: the default branch, its base, and the build's other branches. */
async function protectFor(ctx: AgentContext, accountId: number, t: LoopTarget, all: readonly LoopTarget[]): Promise<string[]> {
  const facts = await repoFacts(ctx, accountId, t.repoId).catch(() => null);
  const others = all.filter((x) => x.repoId === t.repoId && !(x.kind === t.kind && x.id === t.id)).flatMap((x) => [x.loopBranch ?? '', x.plannedBranch]);
  return [...new Set([facts?.defaultBranch, t.baseRef, ...others].filter((n): n is string => Boolean(n)))];
}

/**
 * A write a RESTART cut off (claimed, no answer): did it land? The reader's Continue is consent for ONE look
 * (the live branch); 'landed' adopts it, 'not_landed' allows a new attempt, 'moved' ends the target.
 */
async function interruptedOutcome(accountId: number, t: LoopTarget, row: LoopPushRow): Promise<{ kind: 'landed'; sha: string; tree: string } | { kind: 'not_landed' } | { kind: 'moved' }> {
  const live = await seams.liveBranchSha(accountId, t.owner, t.name, row.branch);
  if (row.step === 'branch') {
    if (live == null) return { kind: 'not_landed' };
    const f = await seams.commitFacts(accountId, t.owner, t.name, row.branch, live);
    if ((row.expectTree == null || f.tree === row.expectTree) && (row.parentSha == null || f.parents[0] === row.parentSha)) return { kind: 'landed', sha: live, tree: f.tree };
    return { kind: 'moved' };
  }
  if (live == null) return { kind: 'moved' };
  if (live === row.parentSha) return { kind: 'not_landed' };
  const f = await seams.commitFacts(accountId, t.owner, t.name, row.branch, live);
  if (f.tree === row.expectTree && f.parents[0] === row.parentSha) return { kind: 'landed', sha: live, tree: f.tree };
  return { kind: 'moved' };
}

async function treeOf(accountId: number, t: LoopTarget, all: readonly LoopTarget[]): Promise<string> {
  if (t.kind === 'pr') {
    if (!t.treeSha) throw Object.assign(new Error(`Limn has no verified copy of ${t.key ?? 'this pull request'}.`), { code: 'NOT_READY' });
    return t.treeSha;
  }
  void all;
  return seams.treeOfPatch(accountId, t.owner, t.name, t.baseRef, t.baseSha, t.patch ?? '');
}

/** ROUND 0: every target's branch, in plan order (a stacked PR on the previous one's branch). */
async function stepInitialPush(ctx: AgentContext, accountId: number, b: StoryBuildRow): Promise<'ok' | 'paused'> {
  const all = await loopTargets(ctx, accountId, b.id);
  const pushes = await listLoopPushes(ctx, accountId, b.id);
  for (const t0 of all) {
    if (await stoppedNow(ctx, accountId, b.id)) return 'paused';
    const t = (await loopTargets(ctx, accountId, b.id)).find((x) => x.kind === t0.kind && x.id === t0.id) ?? t0;
    if (!isLive(t) || (t.loopBranch && t.loopPushedSha)) continue;
    const last = latestPush(pushes, 0, 'branch', t.kind, t.id);
    if (last && last.doneAt == null && last.error == null) continue; // claimed by a run that is still going
    if (last?.errorCode === 'INTERRUPTED') {
      const o = await interruptedOutcome(accountId, t, last).catch(() => ({ kind: 'not_landed' as const }));
      if (o.kind === 'landed') {
        await finishLoopPush(ctx, accountId, last.id, { pushedSha: o.sha, doneAt: seams.now() });
        await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopBranch: last.branch, loopPushedSha: o.sha, loopPushedTree: o.tree, loopPushedAt: seams.now(), pushError: null, pushErrorCode: null });
        continue;
      }
      if (o.kind === 'moved') {
        return pause(ctx, accountId, b.id, 'branch_exists', 'pushing', `A branch named ${last.branch} already exists on ${t.fullName}. Pick another name.`);
      }
    }
    if (!(await seams.canPush(ctx, accountId, t.repoId).catch(() => false))) {
      await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: 'You cannot push to this repository.', pushErrorCode: 'NO_PUSH_PERMISSION' });
      return pause(ctx, accountId, b.id, 'push_failed', 'pushing', `You cannot push to ${t.fullName}.`);
    }
    const branch = t.plannedBranch.trim();
    if (!branch || !t.patch) return pause(ctx, accountId, b.id, 'push_failed', 'pushing', `${t.fullName} has nothing to push.`);
    // The base: the repository's, or (a stacked PR) the previous PR's pushed branch.
    let baseRef = t.baseRef;
    let baseSha = t.baseSha;
    const fresh = await loopTargets(ctx, accountId, b.id);
    if (t.prevId != null) {
      const prev = fresh.find((x) => x.kind === 'pr' && x.id === t.prevId);
      if (!prev?.loopBranch || !prev.loopPushedSha) return pause(ctx, accountId, b.id, 'push_failed', 'pushing', `Push ${prev?.key ?? 'the pull request before it'} first.`);
      baseRef = prev.loopBranch;
      baseSha = prev.loopPushedSha;
    }
    let expectTree: string | null = t.treeSha;
    if (t.kind === 'repo') expectTree = await treeOf(accountId, t, fresh).catch(() => null);
    const protect = await protectFor(ctx, accountId, t, fresh);
    const claimId = await claimLoopPush(ctx, accountId, {
      buildId: b.id,
      round: 0,
      step: 'branch',
      targetKind: t.kind,
      targetId: t.id,
      attempt: (last?.attempt ?? 0) + 1,
      branch,
      parentSha: baseSha,
      expectTree,
      now: seams.now(),
    });
    if (claimId == null) continue;
    const r = running.get(b.id);
    if (r) r.step = 'pushing';
    try {
      const got = await seams.pushNewBranch({
        accountId,
        owner: t.owner,
        name: t.name,
        baseSha,
        baseRef,
        patch: t.patch,
        commitMessage: (t.commitMessage ?? '').trim() || `${b.ticketKey}: ${t.title ?? b.ticketTitle ?? 'the build'}`,
        branch,
        protect,
        ...(expectTree ? { expectTree } : {}),
      });
      await finishLoopPush(ctx, accountId, claimId, { pushedSha: got.commitSha, doneAt: seams.now() });
      await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopBranch: branch, loopPushedSha: got.commitSha, loopPushedTree: got.treeSha, loopPushedAt: seams.now(), pushError: null, pushErrorCode: null });
    } catch (err) {
      const code = errCode(err);
      const message = code === 'BRANCH_EXISTS' ? `A branch named ${branch} already exists on ${t.fullName}. Pick another branch name.` : errMsg(err);
      await failLoopPush(ctx, accountId, claimId, message, code);
      await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: message, pushErrorCode: code });
      return pause(ctx, accountId, b.id, pushPauseOf(code), 'pushing', code === 'BRANCH_EXISTS' ? `A branch named ${branch} already exists on ${t.fullName}. Pick another name.` : null);
    }
  }
  seams.session.notice(b.id, 'Limn pushed the branch. The review starts now.');
  return 'ok';
}

/** The story check's ticket: the build's frozen story (never a tracker read). */
function ticketOf(b: StoryBuildRow): ClaudeReviewTicket {
  const seed = b.seedJson;
  const criteria = (seed?.criteria ?? b.criteriaJson ?? []).map((c) => c.text);
  return {
    title: seed?.story.title ?? b.ticketTitle ?? null,
    description: seed?.story.text ?? null,
    acceptanceCriteria: criteria.length > 0 ? criteria.map((c, n) => `${n + 1}. ${c}`).join('\n') : null,
    key: b.ticketKey,
    url: seed?.story.url ?? null,
  };
}

const PAIR_ROLE = (n: number, total: number): 'first' | 'second' | null => (total < 2 ? null : n === 0 ? 'first' : 'second');

/** REVIEW k: the code review of every target that needs one, and the round's story check. */
async function stepReview(
  ctx: AgentContext,
  accountId: number,
  b: StoryBuildRow,
  k: number,
  abort: AbortController,
  byReader: boolean,
): Promise<'open' | 'fix' | 'paused' | 'stopped'> {
  const targets = (await loopTargets(ctx, accountId, b.id)).filter((t) => isLive(t) && t.loopPushedSha);
  if (targets.length === 0) {
    await setState(ctx, accountId, b.id, 'done', k, { loopFinishedAt: seams.now() });
    return 'stopped';
  }
  const providers = await seams.providers(ctx, accountId, b.workspaceId);
  if (providers.length === 0) return pause(ctx, accountId, b.id, 'review_failed', 'reviewing', 'No AI provider is signed in to review.');
  await dropUnsucceededReviews(ctx, accountId, b.id, k);
  const reviews = await listLoopReviews(ctx, accountId, b.id);
  const findings = await listLoopFindings(ctx, accountId, b.id);
  const checks = await listLoopStoryChecks(ctx, accountId, b.id);
  const acs = await listLoopAcResponses(ctx, accountId, b.id);

  // WHICH TARGETS: round 1 all; later, a target whose head moved, or that had something open or answered.
  const needs = targets.filter((t) => {
    if (k === 1) return true;
    const done = reviews.filter((r) => r.targetKind === t.kind && r.targetId === t.id && r.status === 'succeeded' && r.round < k);
    if (done.length === 0) return true;
    const lastRound = Math.max(...done.map((r) => r.round));
    const last = done.filter((r) => r.round === lastRound);
    if (last[0]!.headSha !== t.loopPushedSha) return true;
    // Something open, answered or left 'not_checked' (carried) is judged again.
    return priorForTarget(reviews, findings, t.kind, t.id, k, providers[0]!) != null;
  });
  const plan = needs.flatMap((t) =>
    providers
      .filter((p) => !reviews.some((r) => r.round === k && r.targetKind === t.kind && r.targetId === t.id && r.provider === p && r.status === 'succeeded'))
      .map((p) => ({ t, p })),
  );
  const prevCheck = [...checks].filter((c) => c.round < k && c.status === 'succeeded').sort((a, z) => z.round - a.round)[0] ?? null;
  const thisCheck = checks.find((c) => c.round === k && c.status === 'succeeded') ?? null;
  const storyProvider = seams.storyProvider();

  // THE GATE, before anything of the round starts (a reader's Continue skips it).
  if (!byReader) {
    const firstCode = plan[0];
    if (firstCode && !(await seams.automaticAllowed(ctx, accountId, LOOP_REVIEW_FEATURE, firstCode.p))) return pause(ctx, accountId, b.id, 'budget', 'reviewing');
    if (!thisCheck && !(await seams.automaticAllowed(ctx, accountId, LOOP_CHECK_FEATURE, storyProvider))) return pause(ctx, accountId, b.id, 'budget', 'reviewing');
  }
  const run = running.get(b.id);
  if (run) run.step = 'reviewing';

  // THE STORY CHECK runs beside the code reviews.
  const claims: LoopClaim[] = acs
    .filter((r) => r.round === k - 1 && r.response !== 'not_reported' && r.response !== 'fixed' && (r.text ?? '').trim() !== '')
    .map((r) => ({ ref: r.ref, kind: r.response === 'not_applicable' ? ('not_applicable' as const) : ('answer' as const), text: r.text! }));
  const members = targets.map((t, n) => ({
    ref: `PR${n + 1}`,
    targetKind: t.kind,
    targetId: t.id,
    repoId: t.repoId,
    repo: t.fullName,
    branch: t.loopBranch!,
    headSha: t.loopPushedSha!,
  }));
  const checkP = thisCheck
    ? Promise.resolve(true)
    : (async (): Promise<boolean> => {
        const res = await seams.runStoryCheck(ctx, {
          accountId,
          workspaceId: b.workspaceId,
          buildId: b.id,
          ident: b.ident,
          ticket: ticketOf(b),
          targets: targets.map((t, n) => ({ member: members[n]!, owner: t.owner, name: t.name, baseSha: reviewBaseOf(t, targets), title: t.title ?? t.contains })),
          prior: prevCheck?.assessment
            ? {
                assessment: prevCheck.assessment,
                changedTargetIds: targets.filter((t) => (prevCheck.members ?? []).find((m) => m.targetKind === t.kind && m.targetId === t.id)?.headSha !== t.loopPushedSha).map((t) => t.id),
              }
            : null,
          claims,
          provider: storyProvider,
          abort,
        });
        await upsertLoopStoryCheck(ctx, accountId, {
          buildId: b.id,
          round: k,
          status: res.status,
          provider: storyProvider,
          model: res.model,
          assessment: res.assessment,
          members,
          claims,
          claimVerdicts: res.claimVerdicts,
          failureReason: res.failureReason,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          numTurns: res.numTurns,
          completedAt: seams.now(),
        });
        return res.status === 'succeeded';
      })();

  // THE CODE REVIEWS: target by target; a pair's halves AT ONCE (blind), consolidated at the end. Every
  // automatic run asks the gate before it starts (the first was asked above); a refusal now skips that run.
  let reviewFailed: string | null = null;
  let budgetSkipped = false;
  let asked = 0;
  for (const t of needs) {
    if (abort.signal.aborted) break;
    const mine = plan.filter((x) => x.t === t);
    const gates = await Promise.all(mine.map(async ({ p }) => byReader || asked++ === 0 || (await seams.automaticAllowed(ctx, accountId, LOOP_REVIEW_FEATURE, p))));
    const halves = await Promise.all(
      mine.map(async ({ p }, n) => {
        const allowed = gates[n]!;
        const id = await insertLoopReview(ctx, accountId, {
          buildId: b.id,
          round: k,
          targetKind: t.kind,
          targetId: t.id,
          repoId: t.repoId,
          branch: t.loopBranch!,
          baseSha: reviewBaseOf(t, targets),
          headSha: t.loopPushedSha!,
          provider: p,
          model: null,
          pairRole: PAIR_ROLE(n, providers.length),
          status: allowed ? 'running' : 'skipped',
        });
        if (!allowed) {
          await updateLoopReview(ctx, accountId, id, { failureReason: 'The AI spend limit is reached.', completedAt: seams.now() });
          return { id, p, res: null as LoopHalfResult | null };
        }
        const res = await seams.runHalf(ctx, {
          accountId,
          workspaceId: b.workspaceId,
          buildId: b.id,
          round: k,
          owner: t.owner,
          name: t.name,
          fullName: t.fullName,
          repoId: t.repoId,
          branch: t.loopBranch!,
          title: `${b.ticketKey}: ${t.title ?? b.ticketTitle ?? ''}`.trim(),
          body: [t.contains ?? t.summary ?? '', b.seedJson?.story.title ? `Ticket: ${b.ticketKey} — ${b.seedJson.story.title}` : `Ticket: ${b.ticketKey}`].filter(Boolean).join('\n\n'),
          baseRef: t.baseRef,
          baseSha: reviewBaseOf(t, targets),
          headSha: t.loopPushedSha!,
          provider: p,
          prior: priorForTarget(reviews, findings, t.kind, t.id, k, p),
          abort,
          byReader,
        });
        await updateLoopReview(ctx, accountId, id, {
          status: res.status,
          provider: res.ranOn.provider,
          model: res.ranOn.model,
          effort: res.ranOn.effort,
          reviewMode: res.reviewMode,
          summary: res.summary,
          verdict: res.verdict,
          followUp: res.followUp,
          failureReason: res.failureReason,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          numTurns: res.numTurns,
          completedAt: seams.now(),
        });
        if (res.status === 'succeeded') {
          await insertLoopFindings(
            ctx,
            accountId,
            res.findings.map((f) => ({
              reviewId: id,
              buildId: b.id,
              round: k,
              severity: f.severity,
              path: f.path,
              line: f.line,
              side: f.side,
              title: f.title,
              body: f.body,
              suggestion: f.suggestion,
              diffHunk: f.diffHunk,
              anchored: f.anchored,
              fileInDiff: f.fileInDiff,
              priorFindingId: f.priorFindingId,
              lens: f.lens ?? null,
            })),
          );
        }
        return { id, p, res };
      }),
    );
    if (abort.signal.aborted) break;
    const ok = halves.filter((h) => h.res?.status === 'succeeded');
    const already = reviews.filter((r) => r.round === k && r.targetKind === t.kind && r.targetId === t.id && r.status === 'succeeded');
    if (ok.length === 0 && already.length === 0) {
      if (halves.every((h) => h.res == null)) budgetSkipped = true;
      else reviewFailed = halves.find((h) => h.res?.failureReason)?.res?.failureReason ?? 'The review did not finish.';
      continue;
    }
    // A PAIR whose two halves succeeded: ONE consolidated review (duplicates merged, one verdict).
    const runsNow = (await listLoopReviews(ctx, accountId, b.id)).filter((r) => r.round === k && r.targetKind === t.kind && r.targetId === t.id && r.status === 'succeeded');
    // Skipped when this round's pair was already merged (a Continue that re-ran nothing for this target).
    const merged = runsNow.some((r) => r.pairConsolidation != null);
    if (runsNow.length === 2 && mine.length > 0 && !merged) {
      const fs = await listLoopFindings(ctx, accountId, b.id);
      const [x, y] = [runsNow.find((r) => r.pairRole !== 'second') ?? runsNow[0]!, runsNow.find((r) => r.pairRole === 'second') ?? runsNow[1]!];
      const c = await seams.consolidate(ctx, accountId, runWireOf(x, fs), runWireOf(y, fs)).catch(() => null);
      if (c) {
        for (const [dropped, keep] of Object.entries(c.mergedFrom)) await updateLoopFinding(ctx, accountId, Number(dropped), { mergedInto: keep });
        const record: ClaudeReviewPairConsolidation = { how: c.how, summary: c.summary, verdict: c.verdict, sourceOf: c.sourceOf, mergedFrom: c.mergedFrom, failedHalf: null, at: seams.now().toISOString() };
        await updateLoopReview(ctx, accountId, x.id, { pairConsolidation: record });
      }
    }
  }
  const checkOk = await checkP.catch(() => false);
  if (abort.signal.aborted) return 'stopped';
  if (budgetSkipped) return pause(ctx, accountId, b.id, 'budget', 'reviewing');
  if (reviewFailed) return pause(ctx, accountId, b.id, 'review_failed', 'reviewing', null);
  if (!checkOk) return pause(ctx, accountId, b.id, 'review_failed', 'reviewing', null);

  const checksNow = await listLoopStoryChecks(ctx, accountId, b.id);
  const open = roundOpen(k, await listLoopReviews(ctx, accountId, b.id), await listLoopFindings(ctx, accountId, b.id), checksNow.find((c) => c.round === k) ?? null, checksNow);
  const total = open.findings + open.criteria;
  seams.session.notice(b.id, total === 0 ? `Review round ${k}: nothing is open.` : `Review round ${k}: ${open.findings} ${open.findings === 1 ? 'finding' : 'findings'} and ${open.criteria} ${open.criteria === 1 ? 'criterion' : 'criteria'} to answer.`);
  return total === 0 || k >= b.loopRounds + 1 ? 'open' : 'fix';
}

/** FIX k: write REVIEW.md, then start the host's build turn. The turn's end continues (`afterLoopFixTurn`). */
async function stepStartFix(ctx: AgentContext, accountId: number, b: StoryBuildRow, k: number, abort: AbortController, byReader: boolean): Promise<void> {
  // The session: a reader's Continue starts it again when it closed; the loop itself never does.
  if (!seams.session.live(b.id)) {
    if (!byReader) {
      await pause(ctx, accountId, b.id, 'session_closed', 'fixing');
      return;
    }
    const why = await seams.session.resume(ctx, accountId, b.id);
    if (why) {
      await pause(ctx, accountId, b.id, 'session_closed', 'fixing', why);
      return;
    }
    seams.session.hold(b.id);
  }
  const provider = seams.session.provider(b.id) ?? seams.storyProvider();
  if (!byReader && !(await seams.automaticAllowed(ctx, accountId, LOOP_FIX_FEATURE, provider))) {
    await pause(ctx, accountId, b.id, 'budget', 'fixing');
    return;
  }
  // Wait for the session to be ready (booting after a resume) and the build slot to be free.
  const until = seams.now().getTime() + seams.waitMs;
  while (!seams.session.ready(b.id)) {
    if (abort.signal.aborted) return;
    if (!seams.session.live(b.id)) {
      await pause(ctx, accountId, b.id, 'session_closed', 'fixing');
      return;
    }
    if (Date.now() > until) {
      await pause(ctx, accountId, b.id, 'build_busy', 'fixing');
      return;
    }
    await new Promise((r) => setTimeout(r, seams.pollMs));
  }
  const root = seams.session.root(b.id);
  if (!root) {
    await pause(ctx, accountId, b.id, 'session_closed', 'fixing');
    return;
  }
  // THE SEED: this round's open findings and criteria.
  const [targets, reviews, findings, checks] = await Promise.all([
    loopTargets(ctx, accountId, b.id),
    listLoopReviews(ctx, accountId, b.id),
    listLoopFindings(ctx, accountId, b.id),
    listLoopStoryChecks(ctx, accountId, b.id),
  ]);
  const runs = reviews.filter((r) => r.round === k && r.status === 'succeeded');
  const runById = new Map(runs.map((r) => [r.id, r]));
  const carried = notCheckedFindingsOf(reviews, findings, k);
  const carriedIds = new Set(carried.map((f) => f.id));
  const open = [...openFindingsOf(findings, new Set(runById.keys())), ...carried];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const anyRun = new Map(reviews.map((r) => [r.id, r]));
  const seedFindings: LoopSeedFinding[] = open.filter((f) => anyRun.has(f.reviewId)).map((f) => {
    const run = anyRun.get(f.reviewId)!;
    const t = targets.find((x) => x.kind === run.targetKind && x.id === run.targetId);
    const item = f.priorFindingId != null ? runs.flatMap((r) => r.followUp?.items ?? []).find((it) => it.priorFindingId === f.priorFindingId) : undefined;
    const earlier = f.priorFindingId != null ? byId.get(f.priorFindingId) : undefined;
    return {
      findingId: f.id,
      target: t ? (t.key ? `${t.fullName} · ${t.key} (${t.title ?? ''})` : t.fullName) : `#${run.repoId}`,
      severity: f.severity,
      path: f.path,
      line: f.line,
      title: f.title,
      body: f.body,
      suggestion: f.suggestion,
      earlier: carriedIds.has(f.id)
        ? { reviewer: null, agentAnswer: f.responseText ?? null }
        : f.priorFindingId != null
          ? { reviewer: item ? [item.explanation, item.response].filter(Boolean).join(' ') || null : null, agentAnswer: earlier?.responseText ?? null }
          : null,
    };
  });
  const check = checks.find((c) => c.round === k) ?? null;
  const rejected = new Map((check?.claimVerdicts ?? []).filter((v) => v.verdict === 'rejected').map((v) => [v.ref.toUpperCase(), v.why]));
  const seedCriteria: LoopSeedCriterion[] = openCriteriaOf(check, checks).map((c) => ({ ...c, rejectedClaim: rejected.get(c.ref.toUpperCase()) ?? null }));
  const seed = buildLoopFixSeed({ round: k, rounds: b.loopRounds, findings: seedFindings, criteria: seedCriteria, root });
  for (const [ref, stands] of seed.refs) if (stands.kind === 'finding') await updateLoopFinding(ctx, accountId, stands.findingId, { ref });
  // The shown criteria wait as "not answered" until the answers come back.
  for (const ref of seed.shown.filter((r) => /^(AC|M)\d+$/.test(r))) await upsertLoopAcResponse(ctx, accountId, { buildId: b.id, round: k, ref, response: 'not_reported', text: null });
  const r0 = root.replace(/\/$/, '');
  await seams.session.removeResponse(b.id);
  const wrote = await seams.session.copyIn(b.id, [
    { path: `${r0}/REVIEW.md`, content: seed.text },
    { path: `${r0}/${REVIEW_REFS_FILE}`, content: `${JSON.stringify({ shown: seed.shown })}\n` },
    { path: REVIEW_RESPONSE_CHECKER, content: reviewResponseCheckerSource({ reportFile: `${r0}/${REVIEW_RESPONSE_FILE}`, refsFile: `${r0}/${REVIEW_REFS_FILE}` }), mode: 0o755 },
  ]);
  if (!wrote) {
    await pause(ctx, accountId, b.id, 'session_closed', 'fixing');
    return;
  }
  const text = buildLoopFixInstruction({ round: k, rounds: b.loopRounds, root, stacked: targets.some((t) => t.kind === 'pr' && t.prevId != null) });
  // THE CLAIM of the build slot, retried while another session builds (up to the wait).
  for (;;) {
    if (abort.signal.aborted) return;
    const got = seams.session.startFixTurn(b.id, text);
    if (got === 'started') {
      seams.session.notice(b.id, `The agent is answering review round ${k}.`);
      return;
    }
    if (got === 'not_live') {
      await pause(ctx, accountId, b.id, 'session_closed', 'fixing');
      return;
    }
    if (Date.now() > until) {
      await pause(ctx, accountId, b.id, 'build_busy', 'fixing');
      return;
    }
    await new Promise((r) => setTimeout(r, seams.pollMs));
  }
}

/**
 * THE END OF A LOOP FIX TURN (the subject's `afterBuildTurnEnded`; the work was already extracted): store the
 * agent's answers, then push the fixes and review again. A stopped or failed turn pauses. Never throws.
 */
export async function afterLoopFixTurn(
  ctx: AgentContext,
  input: { accountId: number; buildId: number },
  e: { outcome: string | null; stored: boolean; saved: boolean },
): Promise<void> {
  const { accountId, buildId } = input;
  try {
    const b = await getStoryBuildRow(ctx, accountId, buildId);
    if (!b || b.loopState !== 'fixing') return;
    const k = b.loopRound;
    if (e.outcome !== 'completed' && e.outcome !== 'max_turns') {
      if (!seams.session.live(buildId)) await pause(ctx, accountId, buildId, 'session_closed', 'fixing');
      else await pause(ctx, accountId, buildId, e.outcome === 'interrupted' ? 'fix_stopped' : 'fix_failed', 'fixing');
      return;
    }
    // The turn's work was not stored (the session was closing, or storing failed): pushing now would push
    // the OLD work and turn every "fixed" into "no code change". Pause; Continue runs the fix pass again.
    if (!e.stored) {
      await pause(ctx, accountId, buildId, seams.session.live(buildId) ? 'fix_failed' : 'session_closed', 'fixing');
      return;
    }
    const all = await listLoopFindings(ctx, accountId, buildId);
    const carriedIds = new Set(notCheckedFindingsOf(await listLoopReviews(ctx, accountId, buildId), all, k).map((f) => f.id));
    const findings = all.filter((f) => f.ref != null && (f.round === k || carriedIds.has(f.id)));
    const acs = (await listLoopAcResponses(ctx, accountId, buildId)).filter((r) => r.round === k);
    const shown = [...findings.map((f) => f.ref!), ...acs.map((r) => r.ref)];
    const got = await seams.session.readResponse(buildId, shown);
    const items = got.kind === 'ok' ? (got.check.payload?.items ?? []) : [];
    if (got.kind !== 'ok') seams.session.notice(buildId, got.kind === 'missing' ? 'The agent wrote no answers, so every item reads "not answered".' : `${got.reason} Every item reads "not answered".`);
    const byRef = new Map(items.map((it) => [it.ref, it]));
    for (const f of findings) {
      const it = byRef.get(f.ref!);
      const action = it ? (it.action === 'not_applicable' ? 'answered' : it.action) : 'not_reported';
      await updateLoopFinding(ctx, accountId, f.id, { response: action, responseText: it?.reply ?? null, responseRound: k });
    }
    for (const r of acs) {
      const it = byRef.get(r.ref);
      await upsertLoopAcResponse(ctx, accountId, { buildId, round: k, ref: r.ref, response: it ? it.action : 'not_reported', text: it?.reply ?? null });
    }
    await setLoop(ctx, accountId, buildId, { loopState: 'pushing', loopRound: k });
    seams.session.hold(buildId);
    // The step that started the turn may still be winding down in this process: let it end first.
    for (let i = 0; i < 400 && running.has(buildId); i++) await new Promise((r) => setTimeout(r, 25));
    kick(ctx, accountId, buildId, false);
  } catch (err) {
    ctx.log.warn(`story build ${buildId}: after the loop's fix turn: ${errMsg(err)}`);
    await pause(ctx, accountId, buildId, 'fix_failed', 'fixing').catch(() => {});
  }
}

/** PUSH k: one fast-forward commit per target whose tree changed (a stacked PR also when the one before it moved). */
async function stepFixPush(ctx: AgentContext, accountId: number, b: StoryBuildRow, k: number): Promise<'ok' | 'paused'> {
  const all = await loopTargets(ctx, accountId, b.id);
  const pushes = await listLoopPushes(ctx, accountId, b.id);
  const moved = new Map<string, string>();
  const unchanged = new Set<string>();
  const tk = (t: Pick<LoopTarget, 'kind' | 'id'>): string => `${t.kind}:${t.id}`;
  for (const t of all) {
    if (!isLive(t) || !t.loopBranch || !t.loopPushedSha) continue;
    const prevMoved = t.prevId != null ? moved.get(`pr:${t.prevId}`) : undefined;
    const last = latestPush(pushes, k, 'fix', t.kind, t.id);
    if (last?.doneAt != null) {
      if (last.pushedSha && last.pushedSha !== last.parentSha) moved.set(tk(t), last.pushedSha);
      continue;
    }
    if (last && last.error == null) continue;
    if (last?.errorCode === 'INTERRUPTED') {
      const o = await interruptedOutcome(accountId, t, last).catch(() => ({ kind: 'not_landed' as const }));
      if (o.kind === 'landed') {
        await finishLoopPush(ctx, accountId, last.id, { pushedSha: o.sha, doneAt: seams.now() });
        await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopPushedSha: o.sha, loopPushedTree: o.tree, loopPushedAt: seams.now() });
        moved.set(tk(t), o.sha);
        continue;
      }
      if (o.kind === 'moved') {
        await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopEnded: 'stopped', pushError: HEAD_MOVED_LOOP_LINE(t.loopBranch), pushErrorCode: 'HEAD_MOVED' });
        seams.session.notice(b.id, HEAD_MOVED_LOOP_LINE(t.loopBranch));
        continue;
      }
    }
    let tree: string;
    try {
      tree = await treeOf(accountId, t, all);
    } catch (err) {
      await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: errMsg(err), pushErrorCode: errCode(err) });
      return pause(ctx, accountId, b.id, 'push_failed', 'pushing', null);
    }
    if (tree === t.loopPushedTree && !prevMoved) {
      unchanged.add(tk(t));
      continue;
    }
    const fixedLines = (await listLoopFindings(ctx, accountId, b.id))
      .filter((f) => f.responseRound === k && f.response === 'fixed' && (f.responseText ?? '').trim() !== '')
      .slice(0, 5)
      .map((f) => `- ${(f.responseText ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
    const { defangGithubText } = await import('../push.js');
    const message = defangGithubText([`Address review round ${k}`, ...(fixedLines.length > 0 ? ['', ...fixedLines] : [])].join('\n'), { mentions: false });
    const claimId = await claimLoopPush(ctx, accountId, {
      buildId: b.id,
      round: k,
      step: 'fix',
      targetKind: t.kind,
      targetId: t.id,
      attempt: (last?.attempt ?? 0) + 1,
      branch: t.loopBranch,
      parentSha: t.loopPushedSha,
      expectTree: tree,
      now: seams.now(),
    });
    if (claimId == null) continue;
    try {
      const got = await seams.pushFastForward({
        accountId,
        owner: t.owner,
        name: t.name,
        branch: t.loopBranch,
        pushedSha: t.loopPushedSha,
        tree,
        extraParents: prevMoved ? [prevMoved] : [],
        message,
        protect: await protectFor(ctx, accountId, t, all),
        destRef: destRef(b.id, t),
      });
      await finishLoopPush(ctx, accountId, claimId, { pushedSha: got.commitSha, doneAt: seams.now() });
      if (got.pushed) {
        await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopPushedSha: got.commitSha, loopPushedTree: tree, loopPushedAt: seams.now(), pushError: null, pushErrorCode: null });
        moved.set(tk(t), got.commitSha);
      } else unchanged.add(tk(t));
    } catch (err) {
      const code = errCode(err);
      await failLoopPush(ctx, accountId, claimId, errMsg(err), code);
      if (code === 'HEAD_MOVED') {
        await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopEnded: 'stopped', pushError: errMsg(err), pushErrorCode: code });
        seams.session.notice(b.id, errMsg(err));
        continue;
      }
      await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: errMsg(err), pushErrorCode: code });
      return pause(ctx, accountId, b.id, 'push_failed', 'pushing', null);
    }
  }
  // A "fixed" on a target whose code did not change is an answer (the code is authoritative).
  const reviews = await listLoopReviews(ctx, accountId, b.id);
  const targetOfRun = new Map(reviews.map((r) => [r.id, `${r.targetKind}:${r.targetId}`]));
  for (const f of (await listLoopFindings(ctx, accountId, b.id)).filter((x) => x.responseRound === k && x.response === 'fixed')) {
    if (unchanged.has(targetOfRun.get(f.reviewId) ?? '')) {
      await updateLoopFinding(ctx, accountId, f.id, { response: 'answered', responseText: `(no code change) ${f.responseText ?? ''}`.trim() });
    }
  }
  if (moved.size > 0) seams.session.notice(b.id, `Limn pushed the fixes of round ${k}.`);
  return 'ok';
}

/** OPEN: every target's PR, in plan order, ready for review, as the reader's. Then done. */
async function stepOpen(ctx: AgentContext, accountId: number, b: StoryBuildRow, k: number): Promise<void> {
  const r = running.get(b.id);
  if (r) r.step = 'opening';
  const pushes = await listLoopPushes(ctx, accountId, b.id);
  const providers = await seams.providers(ctx, accountId, b.workspaceId).catch(() => [] as AiProviderId[]);
  let opened = 0;
  for (const t0 of await loopTargets(ctx, accountId, b.id)) {
    const all = await loopTargets(ctx, accountId, b.id);
    const t = all.find((x) => x.kind === t0.kind && x.id === t0.id)!;
    if (!isLive(t) || !t.loopBranch || !t.loopPushedSha) continue;
    // A GUARD: the work moved after the closing review (a reader's message) ⇒ one more fast-forward push.
    const tree = await treeOf(accountId, t, all).catch(() => t.loopPushedTree);
    if (tree && tree !== t.loopPushedTree) {
      const last = latestPush(pushes, k, 'fix', t.kind, t.id);
      const claimId = await claimLoopPush(ctx, accountId, { buildId: b.id, round: k, step: 'fix', targetKind: t.kind, targetId: t.id, attempt: (last?.attempt ?? 0) + 1, branch: t.loopBranch, parentSha: t.loopPushedSha, expectTree: tree, now: seams.now() });
      if (claimId != null) {
        try {
          const got = await seams.pushFastForward({ accountId, owner: t.owner, name: t.name, branch: t.loopBranch, pushedSha: t.loopPushedSha, tree, message: 'Latest changes', protect: await protectFor(ctx, accountId, t, all), destRef: destRef(b.id, t) });
          await finishLoopPush(ctx, accountId, claimId, { pushedSha: got.commitSha, doneAt: seams.now() });
          if (got.pushed) await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopPushedSha: got.commitSha, loopPushedTree: tree, loopPushedAt: seams.now() });
          t.loopPushedSha = got.commitSha;
        } catch (err) {
          await failLoopPush(ctx, accountId, claimId, errMsg(err), errCode(err));
          await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: errMsg(err), pushErrorCode: errCode(err) });
          await pause(ctx, accountId, b.id, 'push_failed', 'opening');
          return;
        }
      }
    }
    const last = latestPush(pushes, 0, 'open', t.kind, t.id);
    if (last && last.doneAt == null && last.error == null) continue;
    let adopt: { prNumber: number; prUrl: string } | null = null;
    if (last?.doneAt != null && last.prNumber != null) adopt = { prNumber: last.prNumber, prUrl: last.prUrl ?? '' };
    else if (last?.errorCode === 'INTERRUPTED' || last?.errorCode === 'PR_NOT_OPENED') adopt = await seams.openPrOfBranch(accountId, t.owner, t.name, t.loopBranch).catch(() => null);
    const facts = await prOpenFacts(ctx, accountId, b, t, all, loopBodySection(loopBodySummaryOf({
      reviews: await listLoopReviews(ctx, accountId, b.id),
      findings: await listLoopFindings(ctx, accountId, b.id),
      checks: await listLoopStoryChecks(ctx, accountId, b.id),
      acResponses: await listLoopAcResponses(ctx, accountId, b.id),
      finalRound: k,
      providers,
    }, t)));
    if (!facts.ok) {
      await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: facts.message, pushErrorCode: facts.code });
      await pause(ctx, accountId, b.id, 'push_failed', 'opening', facts.message);
      return;
    }
    let pr = adopt;
    let claimId: number | null = last?.id ?? null;
    if (!pr) {
      claimId = await claimLoopPush(ctx, accountId, { buildId: b.id, round: 0, step: 'open', targetKind: t.kind, targetId: t.id, attempt: (last?.attempt ?? 0) + 1, branch: t.loopBranch, parentSha: t.loopPushedSha, now: seams.now() });
      if (claimId == null) continue;
      try {
        const headSha = t.loopPushedSha;
        pr = await seams.openPr({
          accountId,
          owner: t.owner,
          name: t.name,
          branch: t.loopBranch,
          prBase: facts.prBase,
          title: facts.title,
          body: facts.body,
          draft: false,
          afterSync: async (n) => {
            await seams.afterPrSync(ctx, { accountId, repoId: t.repoId, prNumber: n, ident: b.ident });
            const reviews = (await listLoopReviews(ctx, accountId, b.id)).filter((x) => x.targetKind === t.kind && x.targetId === t.id && x.headSha === headSha && x.status === 'succeeded');
            const lastRound = reviews.length > 0 ? Math.max(...reviews.map((x) => x.round)) : 0;
            await markLoopReviewOnPr(ctx, { accountId, repoId: t.repoId, prNumber: n, headSha, runs: reviews.filter((x) => x.round === lastRound), findings: await listLoopFindings(ctx, accountId, b.id) });
          },
        });
      } catch (err) {
        await failLoopPush(ctx, accountId, claimId, errMsg(err), errCode(err) === 'failed' ? 'PR_NOT_OPENED' : errCode(err));
        const message = `The branch ${t.loopBranch} is on GitHub, but the pull request did not open (${errMsg(err)}).`;
        await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: message, pushErrorCode: 'PR_NOT_OPENED' });
        await pause(ctx, accountId, b.id, 'push_failed', 'opening', null);
        return;
      }
    }
    if (claimId != null) await finishLoopPush(ctx, accountId, claimId, { prNumber: pr.prNumber, prUrl: pr.prUrl, doneAt: seams.now() });
    await recordOpened(ctx, accountId, t, pr, facts);
    opened += 1;
  }
  await setState(ctx, accountId, b.id, 'done', k, { loopFinishedAt: seams.now() });
  seams.session.release(b.id);
  if (opened > 0) seams.session.notice(b.id, opened === 1 ? 'Limn opened the pull request.' : `Limn opened ${opened} pull requests.`);
}

/** The PR is open: the target is pushed like a normal push (the session's marks read it), and ended. */
async function recordOpened(ctx: AgentContext, accountId: number, t: LoopTarget, pr: { prNumber: number; prUrl: string }, facts: { title: string; body: string }): Promise<void> {
  const now = seams.now();
  const set = {
    status: 'pushed',
    branch: t.loopBranch!,
    pushedBranch: t.loopBranch,
    pushedPrNumber: pr.prNumber,
    pushedPrUrl: pr.prUrl,
    pushedCommitSha: t.loopPushedSha,
    pushedAt: now,
    prTitle: facts.title,
    prBody: facts.body,
    pushError: null,
    pushErrorCode: null,
    loopEnded: 'pr_opened' as const,
  };
  await updateLoopTarget(ctx, accountId, t.kind, t.id, set);
  if (t.kind === 'pr' && t.repoRow) {
    const prs = (await listPlannedPrRows(ctx, accountId, t.prRow!.buildId)).filter((p) => p.repoId === t.repoId && p.status !== 'empty');
    if (prs.every((p) => p.status === 'pushed')) {
      await updateStoryBuildRepo(ctx, accountId, t.repoRow.id, { status: 'pushed', pushedBranch: t.loopBranch, pushedPrNumber: pr.prNumber, pushedPrUrl: pr.prUrl, pushedCommitSha: t.loopPushedSha, pushedAt: now, pushError: null });
    }
  }
}

// ---- a manual Push of a loop target -----------------------------------------------------------------------------

/**
 * The reader's Push on a target the loop already pushed (its branch is on GitHub): the latest work as one more
 * fast-forward commit when it moved, then the PR (ready unless `draft`). Ends the loop for that target; when
 * every target ended, the loop is done. Refused while the loop works.
 */
export async function loopManualPush(
  ctx: AgentContext,
  accountId: number,
  buildId: number,
  kind: 'repo' | 'pr',
  id: number,
  draft: boolean,
): Promise<{ outcome: 'pushed' | 'failed' | 'skipped'; code: string | null; error: string | null; prNumber: number | null; prUrl: string | null }> {
  if (running.has(buildId)) return { outcome: 'skipped', code: 'PUSH_IN_PROGRESS', error: 'Wait for the review round to finish, or press Stop.', prNumber: null, prUrl: null };
  const b = await getStoryBuildRow(ctx, accountId, buildId);
  if (!b) return { outcome: 'failed', code: 'NotFound', error: 'Not found.', prNumber: null, prUrl: null };
  if (b.loopState === 'fixing') return { outcome: 'skipped', code: 'PUSH_IN_PROGRESS', error: 'Wait for the review round to finish, or press Stop.', prNumber: null, prUrl: null };
  const abort = new AbortController();
  running.set(buildId, { abort, step: 'opening' });
  try {
    const all = await loopTargets(ctx, accountId, buildId);
    const t = all.find((x) => x.kind === kind && x.id === id);
    if (!t || !t.loopBranch || !t.loopPushedSha) return { outcome: 'failed', code: 'NOT_READY', error: 'This branch is not on GitHub yet.', prNumber: null, prUrl: null };
    if (t.prevId != null) {
      const prev = all.find((x) => x.kind === 'pr' && x.id === t.prevId);
      if (prev && prev.pushedPrNumber == null) return { outcome: 'failed', code: 'STACK_PREVIOUS_NOT_PUSHED', error: `Push ${prev.key ?? 'the pull request before it'} first.`, prNumber: null, prUrl: null };
    }
    const pushes = await listLoopPushes(ctx, accountId, buildId);
    const tree = await treeOf(accountId, t, all).catch(() => t.loopPushedTree);
    if (tree && tree !== t.loopPushedTree) {
      const last = latestPush(pushes, b.loopRound, 'fix', t.kind, t.id);
      const claimId = await claimLoopPush(ctx, accountId, { buildId, round: b.loopRound, step: 'fix', targetKind: t.kind, targetId: t.id, attempt: (last?.attempt ?? 0) + 1, branch: t.loopBranch, parentSha: t.loopPushedSha, expectTree: tree, now: seams.now() });
      if (claimId != null) {
        try {
          const got = await seams.pushFastForward({ accountId, owner: t.owner, name: t.name, branch: t.loopBranch, pushedSha: t.loopPushedSha, tree, message: 'Latest changes', protect: await protectFor(ctx, accountId, t, all), destRef: destRef(buildId, t) });
          await finishLoopPush(ctx, accountId, claimId, { pushedSha: got.commitSha, doneAt: seams.now() });
          if (got.pushed) await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopPushedSha: got.commitSha, loopPushedTree: tree, loopPushedAt: seams.now() });
          t.loopPushedSha = got.commitSha;
        } catch (err) {
          await failLoopPush(ctx, accountId, claimId, errMsg(err), errCode(err));
          await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: errMsg(err), pushErrorCode: errCode(err) });
          return { outcome: 'failed', code: errCode(err), error: errMsg(err), prNumber: null, prUrl: null };
        }
      }
    }
    const facts = await prOpenFacts(ctx, accountId, b, t, all, null);
    if (!facts.ok) return { outcome: 'failed', code: facts.code, error: facts.message, prNumber: null, prUrl: null };
    const last = latestPush(pushes, 0, 'open', t.kind, t.id);
    const claimId = await claimLoopPush(ctx, accountId, { buildId, round: 0, step: 'open', targetKind: t.kind, targetId: t.id, attempt: (last?.attempt ?? 0) + 1, branch: t.loopBranch, parentSha: t.loopPushedSha, now: seams.now() });
    if (claimId == null) return { outcome: 'skipped', code: 'PUSH_IN_PROGRESS', error: 'This pull request is being opened.', prNumber: null, prUrl: null };
    let pr: { prNumber: number; prUrl: string };
    try {
      pr = await seams.openPr({
        accountId,
        owner: t.owner,
        name: t.name,
        branch: t.loopBranch,
        prBase: facts.prBase,
        title: facts.title,
        body: facts.body,
        draft,
        afterSync: (n) => seams.afterPrSync(ctx, { accountId, repoId: t.repoId, prNumber: n, ident: b.ident }),
      });
    } catch (err) {
      await failLoopPush(ctx, accountId, claimId, errMsg(err), 'PR_NOT_OPENED');
      const message = `The branch ${t.loopBranch} is on GitHub, but the pull request did not open (${errMsg(err)}). Open it on GitHub.`;
      await updateLoopTarget(ctx, accountId, t.kind, t.id, { pushError: message, pushErrorCode: 'PR_NOT_OPENED' });
      return { outcome: 'failed', code: 'PR_NOT_OPENED', error: message, prNumber: null, prUrl: null };
    }
    await finishLoopPush(ctx, accountId, claimId, { prNumber: pr.prNumber, prUrl: pr.prUrl, doneAt: seams.now() });
    await recordOpened(ctx, accountId, t, pr, facts);
    await updateLoopTarget(ctx, accountId, t.kind, t.id, { loopEnded: 'manual_push' });
    const left = (await loopTargets(ctx, accountId, buildId)).filter(isLive);
    if (left.length === 0 && b.loopState !== 'done' && b.loopState !== 'stopped') {
      await setLoop(ctx, accountId, buildId, { loopState: 'done', loopPause: null, loopError: null, loopResume: null, loopFinishedAt: seams.now() });
      seams.session.release(buildId);
    }
    return { outcome: 'pushed', code: null, error: null, prNumber: pr.prNumber, prUrl: pr.prUrl };
  } finally {
    running.delete(buildId);
    await emitLoop(ctx, accountId, buildId).catch(() => {});
  }
}

/** The target of a build's repository row or planned PR, when the loop pushed its branch (else null). */
export async function loopTargetOf(ctx: AgentContext, accountId: number, buildId: number, kind: 'repo' | 'pr', id: number): Promise<LoopTarget | null> {
  const t = (await loopTargets(ctx, accountId, buildId)).find((x) => x.kind === kind && x.id === id);
  return t && t.loopBranch ? t : null;
}

// ---- restart ---------------------------------------------------------------------------------------------------

export const LOOP_INTERRUPTED_PUSH = 'Limn stopped before this push finished.';

/**
 * BOOT: every loop a restart cut off (pushing / reviewing / fixing / opening, not running here) is PAUSED with one
 * line and Continue; a claimed write with no answer is marked INTERRUPTED (Continue looks whether it landed);
 * a review or story check that was running is cancelled. NEVER pushes or reviews. Every account's rows.
 */
export async function reconcileStoryLoopsOnStartup(ctx: AgentContext): Promise<number> {
  const { inArray, and, eq, isNull } = await import('drizzle-orm');
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const s = ctx.schema as any;
  const rows = (await ctx.db
    .select({ id: s.storyBuilds.id, accountId: s.storyBuilds.accountId, loopState: s.storyBuilds.loopState, loopRound: s.storyBuilds.loopRound })
    .from(s.storyBuilds)
    .where(inArray(s.storyBuilds.loopState, ['waiting', 'pushing', 'reviewing', 'fixing', 'opening']))
    .execute()) as Array<{ id: number; accountId: number; loopState: StoryBuildLoopState; loopRound: number }>;
  let n = 0;
  for (const r of rows) {
    if (running.has(r.id)) continue;
    await ctx.db
      .update(s.storyBuildLoopPushes)
      .set({ error: LOOP_INTERRUPTED_PUSH, errorCode: 'INTERRUPTED' })
      .where(and(eq(s.storyBuildLoopPushes.buildId, r.id), eq(s.storyBuildLoopPushes.accountId, r.accountId), isNull(s.storyBuildLoopPushes.doneAt), isNull(s.storyBuildLoopPushes.error)))
      .execute();
    await ctx.db
      .update(s.storyBuildReviews)
      .set({ status: 'cancelled', failureReason: 'Limn restarted.' })
      .where(and(eq(s.storyBuildReviews.buildId, r.id), eq(s.storyBuildReviews.accountId, r.accountId), inArray(s.storyBuildReviews.status, ['queued', 'running'])))
      .execute();
    await ctx.db
      .update(s.storyBuildStoryChecks)
      .set({ status: 'cancelled', failureReason: 'Limn restarted.' })
      .where(and(eq(s.storyBuildStoryChecks.buildId, r.id), eq(s.storyBuildStoryChecks.accountId, r.accountId), inArray(s.storyBuildStoryChecks.status, ['queued', 'running'])))
      .execute();
    const resume: LoopResume = r.loopState === 'waiting' ? 'pushing' : (r.loopState as LoopResume);
    await setLoop(ctx, r.accountId, r.id, {
      loopState: 'paused',
      loopPause: 'interrupted',
      loopResume: resume,
      loopError: `Limn restarted during review round ${Math.max(1, r.loopRound)}. Press Continue to go on.`,
    });
    n += 1;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (n > 0) ctx.log.info(`paused ${n} story-build review loop(s) cut off by a restart`);
  return n;
}

/** The step names (tests). */
export type { LoopStep };
/** Re-exported so the build's wire mapper reads one module. */
export type { StoryBuild };
