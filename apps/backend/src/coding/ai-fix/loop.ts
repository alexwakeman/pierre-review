// AI FIX'S OWN REVIEW LOOP — THE DRIVER (docs/CLAUDE-REVIEW.md § AI Fix → The review loop; shared
// ai-fix-loop.ts). After a fix turn that ended well with work to push — manual, auto, dependency automation's,
// Plan first's Start fix, a reader's follow-up — Ensemble reviews the fix's OWN work before anything is pushed:
//
//   turn ends ──startFixLoop──► reviewing k (a LOCAL commit of the work in Ensemble's clone cache, pinned
//              [CLAIM]            under refs/pierre/local/ai-fix-loop/<fixId>/r<k> and NEVER pushed: the
//                                 workspace's review providers — a Claude + Codex pair is ONE pass, its
//                                 halves AT ONCE — plus a story check when the fix carries the PR's ticket
//                                 criteria)
//   reviewing ──nothing open / the closing review (step N + 1) / only "cannot meet" criteria──► done
//   reviewing ──open, step ≤ N──► fixing k (a host-started fix turn: REVIEW.md, every item answered)
//   fixing ──turn ended, work stored──► reviewing k + 1
//   any ──a spend-gate refusal / failure / Stop / restart──► stopped (one line: shared AI_FIX_LOOP_STOP_LINE)
//
// THEN the fix session's own end (sandbox/session/fix.ts `afterFixLoopEnded`): an unattended fix closes and the
// existing push rules decide (Push automatically, the Dependencies policy); a manual one asks Push when done.
// Every rule is re-read at push time, UNCHANGED. After a push, the CLOSING review becomes the PR's AI review at
// the PUSHED head (`importLoopReviewAfterPush`, markLoopReviewOnPr) — not posted — so auto review skips that
// head and no auto fix chains from it.
//
// RULES:
//   • NOTHING reaches GitHub here: no push, no comment, no status line. The sandbox holds no credential.
//   • Every AUTOMATIC step (an unattended fix's) asks the ONE spend gate first (review/budget-gate.ts) under
//     its own feature id; a refusal STOPS the loop (never queued, never retried). A manual fix's rounds are
//     part of the reader's click (as Build treats a reader's Continue).
//   • Reviews read the REVIEW profile (Settings → AI → Review, through the ONE pair resolver); fix turns run
//     in the fix's own session on the FIX profile's choice. Each run stores and is ledgered under ITS provider.
//   • The session is HELD (no idle close) while the loop works; a reader's message waits (busyReason).
//   • The local refs are HELD while the loop reads them, and kept after a restart only for a fix that can
//     still be resumed (the keeper below); discard and push drop them.
//   • Never throws to the session.
import { createHash } from 'node:crypto';
import {
  AI_FIX_LOOP_STOP_LINE,
  type AiFixLoop,
  type AiFixLoopStop,
  type AiProviderId,
  type ClaudeReview,
  type ClaudeReviewTicket,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { BranchHeadSource } from '../../review/clone-manager.js';
import type { ReadReviewResponseResult } from '../../sandbox/workspace/review-response.js';
import { fixRowHasWork, readMergeState, type FixMergeState } from '../../sandbox/session/fix-merge.js';
import { REVIEW_REFS_FILE, REVIEW_RESPONSE_CHECKER, REVIEW_RESPONSE_FILE, reviewResponseCheckerSource } from '../review-loop/response.js';
import { buildAiFixLoopFixInstruction, buildLoopFixSeed, type LoopSeedCriterion, type LoopSeedFinding } from '../review-loop/seed.js';
import {
  cannotMeetOf,
  nextAfterReview,
  notCheckedFindingsOf,
  onlyCannotMeetLeft,
  openCriteriaOf,
  openFindingsOf,
  priorForTarget,
  roundOpen,
} from '../review-loop/rounds.js';
import { pairConsolidationRecord, pairRoleOf, type BranchPairConsolidation, type BranchReviewHalfInput, type BranchReviewHalfResult } from '../review-loop/branch-review.js';
import type { BranchStoryCheckInput, BranchStoryCheckResult, StoryCheckClaim } from '../review-loop/story-check.js';
import { getFixById, updateFixSession, type AiFixRow } from './persist.js';
import {
  FIX_TARGET,
  claimFixLoopStart,
  dropUnsucceededFixLoopReviews,
  insertFixLoopFindings,
  insertFixLoopReview,
  listFixLoopAcResponses,
  listFixLoopFindings,
  listFixLoopReviews,
  listFixLoopStoryChecks,
  setFixLoop,
  updateFixLoopFinding,
  updateFixLoopReview,
  upsertFixLoopAcResponse,
  upsertFixLoopStoryCheck,
  type FixLoopFindingRow,
  type FixLoopReviewRow,
} from './loop-persist.js';
import { toAiFixLoop } from './loop-wire.js';
import { mergePrPrior, prFollowUpForImport, prPriorFindingIdOf, prPriorReviewOf } from './loop-pr-prior.js';
import type { PriorReviewForFollowUp } from '../../review/claude-review/follow-up.js';
import { fixLoopRounds } from '../../ai/run-profile.js';
import { holdLocalRefs } from '../../review/local-refs.js';

/** The spend ledger's features and the gate's questions. */
export const FIX_LOOP_REVIEW_FEATURE = 'ai_fix_loop_review';
export const FIX_LOOP_CHECK_FEATURE = 'ai_fix_loop_check';
export const FIX_LOOP_FIX_FEATURE = 'ai_fix_loop_fix';
/** The local refs' owner kind (review/local-refs.ts). */
export const FIX_LOOP_REF_KIND = 'ai-fix-loop';

/** What the fix session keeps about its PR (sandbox/session/fix.ts `FixFacts`), as the loop reads it. */
export interface FixLoopFacts {
  prId: number;
  prRepoId: number;
  number: number;
  fullName: string;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
}

export type FixHostTurn = 'started' | 'not_live' | 'busy' | 'build_busy';

export interface FixLoopSeams {
  now(): Date;
  /** How long a fix turn waits for the session / the build slot, and how often it looks. */
  waitMs: number;
  pollMs: number;
  /** N (Settings → AI → AI Fix → Review rounds). */
  rounds(): number;
  /** Who reviews (the ONE pair resolver: Settings → AI → Review, the workspace's "both / one"). */
  providers(ctx: AgentContext, accountId: number, workspaceId: number): Promise<AiProviderId[]>;
  storyProvider(): Promise<AiProviderId>;
  automaticAllowed(ctx: AgentContext, accountId: number, feature: string, provider: AiProviderId): Promise<boolean>;
  runHalf(ctx: AgentContext, i: BranchReviewHalfInput): Promise<BranchReviewHalfResult>;
  runStoryCheck(ctx: AgentContext, i: BranchStoryCheckInput): Promise<BranchStoryCheckResult>;
  consolidate(ctx: AgentContext, accountId: number, a: ClaudeReview, b: ClaudeReview): Promise<BranchPairConsolidation>;
  /** The round's LOCAL commit of the fix's work now (never pushed), and the key of that work. */
  commitRound(a: { accountId: number; fixId: number; round: number; owner: string; name: string; facts: FixLoopFacts; patch: string; merge: FixMergeState | null }): Promise<{ head: Extract<BranchHeadSource, { localRef: string }>; workKey: string }>;
  /** The commit the rounds review against: the PR base branch's tip (pinned), or a merge's base commit. */
  baseSha(a: { accountId: number; fixId: number; owner: string; name: string; facts: FixLoopFacts; merge: FixMergeState | null }): Promise<string>;
  /** The PR's ticket, ONLY when its criteria are in the fix (included S-items); null ⇒ code review only. */
  ticket(ctx: AgentContext, accountId: number, row: AiFixRow): Promise<{ ident: string; ticket: ClaudeReviewTicket } | null>;
  /** Hold the owner's local refs while the loop reads them. Returns the release. */
  holdRefs(fixId: number): () => void;
  /** The PR's still-open earlier findings for one review half (loop-pr-prior.ts); null ⇒ none. */
  prPrior(ctx: AgentContext, a: { accountId: number; prId: number; provider: AiProviderId; inPair: boolean }): Promise<PriorReviewForFollowUp | null>;
  session: {
    hold(fixId: number): void;
    release(fixId: number): void;
    ready(fixId: number): boolean;
    live(fixId: number): boolean;
    provider(fixId: number): AiProviderId | null;
    startFixTurn(fixId: number, text: string): FixHostTurn;
    /** The layout root and the PR repository's path in the sandbox, or null when not live. */
    paths(fixId: number): { root: string; repoPath: string } | null;
    copyIn(fixId: number, files: Array<{ path: string; content: string; mode?: number }>): Promise<boolean>;
    readResponse(fixId: number, shown: readonly string[]): Promise<ReadReviewResponseResult>;
    removeResponse(fixId: number): Promise<void>;
    interrupt(fixId: number): Promise<void>;
    notice(fixId: number, text: string): void;
    /** The AI Fix tab's frames (the fix stream / the session stream). */
    changed(ctx: AgentContext, accountId: number, fixId: number): void;
    /** THE END: the fix session's own close / Push when done (fix.ts `afterFixLoopEnded`). */
    ended(ctx: AgentContext, accountId: number, fixId: number, stop: AiFixLoopStop): Promise<void>;
  };
}

const fixSession = () => import('../../sandbox/session/fix.js');
const mgr = () => import('../../sandbox/session/manager.js');

/** The real seams (imported LAZILY: the session imports this module). */
export function defaultFixLoopSeams(): FixLoopSeams {
  let m: Awaited<ReturnType<typeof mgr>> | null = null;
  let fx: Awaited<ReturnType<typeof fixSession>> | null = null;
  void mgr().then((x) => (m = x)).catch(() => {});
  void fixSession().then((x) => (fx = x)).catch(() => {});
  const key = (fixId: number) => `fix:${fixId}` as const;
  const io = (fixId: number) => fx?.liveFixIo(fixId) ?? null;
  return {
    now: () => new Date(),
    waitMs: 10 * 60_000,
    pollMs: 20_000,
    // Settings → AI → AI Fix → Review rounds (run-profile.ts holds it in memory; no DB import).
    rounds: () => fixLoopRounds(),
    providers: async (ctx, accountId, workspaceId) => (await import('../review-loop/branch-review.js')).branchReviewProviders(ctx, accountId, workspaceId),
    storyProvider: async () => (await import('../review-loop/branch-review.js')).storyCheckProvider(),
    async automaticAllowed(ctx, accountId, feature, provider) {
      const { automaticRunAllowed } = await import('../../review/budget-gate.js');
      return automaticRunAllowed(ctx, accountId, feature, provider);
    },
    runHalf: async (ctx, i) => (await import('../review-loop/branch-review.js')).runBranchReviewHalf(ctx, i),
    runStoryCheck: async (ctx, i) => (await import('../review-loop/story-check.js')).runBranchStoryCheck(ctx, i),
    consolidate: async (ctx, accountId, a, b) => (await import('../review-loop/branch-review.js')).consolidateBranchPair(ctx, accountId, a, b),
    async commitRound(a) {
      const { localRefName } = await import('../../review/local-refs.js');
      const refKey = { kind: FIX_LOOP_REF_KIND, id: a.fixId, name: `r${a.round}` };
      if (a.merge != null) {
        // THE MERGE ITEM: the round reviews the CHECKED merge result (the merge commit and the fix on top),
        // already in the clone cache under the fix's merge ref — pinned again under the loop's own ref.
        const sha = a.merge.resultSha;
        if (a.merge.status !== 'valid' || sha == null) throw new Error('The merge is not checked.');
        const cm = await import('../../review/clone-manager.js');
        const { pinLocalRefLocked } = await import('../../review/local-refs.js');
        const dir = cm.repoCloneDir(a.owner, a.name);
        await cm.withRepoLock(`${a.owner}/${a.name}`, () => pinLocalRefLocked(dir, refKey, sha));
        return { head: { localRef: localRefName(refKey), sha }, workKey: fixWorkKey({ patch: a.patch, merge: a.merge }) };
      }
      const { commitPatchToLocalRef } = await import('../git-ops.js');
      const got = await commitPatchToLocalRef({
        accountId: a.accountId,
        owner: a.owner,
        name: a.name,
        baseRef: a.facts.headRef,
        baseSha: a.facts.headSha,
        patch: a.patch,
        message: `AI fix: review round ${a.round}`,
        key: refKey,
      });
      return { head: { localRef: got.ref, sha: got.commitSha }, workKey: fixWorkKey({ patch: a.patch, merge: null }) };
    },
    async baseSha(a) {
      if (a.merge != null) return a.merge.baseSha;
      const cm = await import('../../review/clone-manager.js');
      const { localRefName } = await import('../../review/local-refs.js');
      const { getAccessToken } = await import('../../auth/account.js');
      const token = await getAccessToken(a.accountId);
      const got = await cm.resolveBranchCommit(
        a.owner,
        a.name,
        { remoteRef: `refs/heads/${a.facts.baseRef}`, destRef: 'refs/pierre/sandbox-base', sha: null, pinRef: localRefName({ kind: FIX_LOOP_REF_KIND, id: a.fixId, name: 'base' }) },
        token,
      );
      return got.sha;
    },
    ticket: async (ctx, accountId, row) => fixLoopTicket(ctx, accountId, row),
    holdRefs: (fixId) => holdLocalRefs(FIX_LOOP_REF_KIND, fixId),
    prPrior: async (ctx, a) => (await import('./loop-pr-prior.js')).loadPrPriorForFixLoop(ctx, a),
    session: {
      hold: (id) => void mgr().then((x) => x.holdSession(key(id), 'AI Fix review loop')),
      release: (id) => void mgr().then((x) => x.releaseSession(key(id))),
      ready: (id) => m?.hostTurnReady(key(id)) ?? false,
      live: (id) => io(id) != null,
      provider: (id) => io(id)?.provider ?? null,
      startFixTurn: (id, text) => (m ? m.startHostBuildTurn(key(id), text) : 'not_live'),
      paths: (id) => {
        const x = io(id);
        return x && x.repoPath ? { root: x.root, repoPath: x.repoPath } : null;
      },
      async copyIn(id, files) {
        await fixSession().then((x) => (fx = x));
        const x = io(id);
        if (!x) return false;
        await x.copyIn(files);
        return true;
      },
      async readResponse(id, shown) {
        await fixSession().then((x) => (fx = x));
        const x = io(id);
        if (!x) return { kind: 'unreadable', reason: 'The session closed before the answers could be read.' };
        const { readReviewResponse } = await import('../../sandbox/workspace/review-response.js');
        return readReviewResponse(x.runtime, x.container, x.root, shown);
      },
      async removeResponse(id) {
        const x = io(id);
        if (!x) return;
        const { removeReviewResponse } = await import('../../sandbox/workspace/review-response.js');
        await removeReviewResponse(x.runtime, x.container, x.root);
      },
      async interrupt(id) {
        await (await fixSession()).interruptFixTurn(id).catch(() => {});
      },
      notice: (id, text) => fx?.noticeFix(id, text),
      changed: (ctx, accountId, id) => void fixSession().then((x) => x.fixLoopChanged(ctx, accountId, id)).catch(() => {}),
      ended: async (ctx, accountId, id, stop) => (await fixSession()).afterFixLoopEnded(ctx, accountId, id, stop),
    },
  };
}

let seams: FixLoopSeams = defaultFixLoopSeams();

/** Test seam: replace any of the seams (null ⇒ the real ones). */
export function setFixLoopSeamsForTests(s: Partial<FixLoopSeams> | null): void {
  const d = defaultFixLoopSeams();
  seams = s == null ? d : { ...d, ...s, session: { ...d.session, ...(s.session ?? {}) } };
}

// ---- in-process state ------------------------------------------------------------------------------------

interface Active {
  abort: AbortController;
  /** A reader's click started this run (a manual fix): the spend gate is not asked. */
  byReader: boolean;
  /** `advance` is working now (a review round, or the start of a fix turn). */
  advancing: boolean;
  releaseRefs: () => void;
}

/** Fixes whose loop works in this process (a review, a fix turn, or between them). Set SYNCHRONOUSLY. */
const active = new Map<number, Active>();
/** A fix turn ended and its loop is about to start (the turn's end saves 'built'; this keeps it 'running'). */
const pending = new Set<number>();

/** The loop of this fix works (or is about to start): the row reads 'running', Push and messages wait. */
export function fixLoopActive(fixId: number): boolean {
  return active.has(fixId) || pending.has(fixId);
}

/** A REVIEW (not a fix turn) runs now: the session refuses a reader's message. */
export function fixLoopBusyReason(fixId: number): string | null {
  return fixLoopActive(fixId) ? 'Wait for the review round to finish, or press Stop.' : null;
}

/** The turn's end will start the loop (fix.ts `afterBuildTurn`, before the phase is saved). */
export function markFixLoopPending(fixId: number): void {
  pending.add(fixId);
}

export function clearFixLoopPending(fixId: number): void {
  pending.delete(fixId);
}

/** Test seam: wait until no loop works in this process. */
export async function _fixLoopsIdleForTest(timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ([...active.values()].some((a) => a.advancing) && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
}

export function _resetFixLoopsForTest(): void {
  for (const a of active.values()) {
    a.abort.abort();
    a.releaseRefs();
  }
  active.clear();
  pending.clear();
}

/** What the fix's push sends: the patch (hashed), or the CHECKED merge result. */
export function fixWorkKey(w: { patch: string | null; merge: Pick<FixMergeState, 'status' | 'resultSha'> | null }): string {
  if (w.merge != null && w.merge.status === 'valid' && w.merge.resultSha) return `merge:${w.merge.resultSha}`;
  return `patch:${createHash('sha256').update(w.patch ?? '', 'utf8').digest('hex')}`;
}

const factsOf = (row: AiFixRow): FixLoopFacts | null => {
  const f = (row.sessionJson as { fix?: FixLoopFacts } | null | undefined)?.fix;
  return f && typeof f.fullName === 'string' && typeof f.headSha === 'string' ? f : null;
};

const splitName = (fullName: string): { owner: string; name: string } => ({ owner: fullName.split('/')[0]!, name: fullName.split('/').slice(1).join('/') });
const errMsg = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0]! : String(err));

// ---- the wire -------------------------------------------------------------------------------------------------

/** `AiFix.loop` of one row (null when the loop never ran). */
export async function fixLoopWire(ctx: AgentContext, accountId: number, row: AiFixRow & { loopState?: string | null }): Promise<AiFixLoop | null> {
  const r = row as AiFixRow & { loopState?: string | null; loopRound?: number; loopFirstRound?: number; loopRounds?: number | null; loopStop?: string | null; loopReviewId?: number | null };
  if (r.loopState == null) return null;
  const [reviews, findings, checks, acResponses] = await Promise.all([
    listFixLoopReviews(ctx, accountId, row.id),
    listFixLoopFindings(ctx, accountId, row.id),
    listFixLoopStoryChecks(ctx, accountId, row.id),
    listFixLoopAcResponses(ctx, accountId, row.id),
  ]);
  return toAiFixLoop({
    fix: {
      loopState: r.loopState as AiFixLoop['state'],
      loopRound: r.loopRound ?? 0,
      loopFirstRound: r.loopFirstRound ?? 0,
      loopRounds: r.loopRounds ?? null,
      loopStop: (r.loopStop as AiFixLoopStop | null) ?? null,
      loopReviewId: r.loopReviewId ?? null,
    },
    reviews,
    findings,
    checks,
    acResponses,
    running: active.has(row.id),
  });
}

// ---- the entry points ---------------------------------------------------------------------------------------------

/**
 * Can a loop run for this fix at all? At least one review vendor on and signed in (the ONE pair resolver). Asked
 * by the fix session as the turn ends, BEFORE it decides to wait for a loop: with nobody to review, the fix goes
 * on exactly as before the loop, and the row records why it was not reviewed ('no_reviewer'). Never throws.
 */
export async function fixLoopCanRun(ctx: AgentContext, accountId: number, fixId: number, workspaceId: number): Promise<boolean> {
  const providers = await seams.providers(ctx, accountId, workspaceId).catch(() => [] as AiProviderId[]);
  if (providers.length > 0) return true;
  await setFixLoop(ctx, accountId, fixId, { loopState: 'stopped', loopStop: 'no_reviewer', loopFinishedAt: seams.now() }).catch(() => {});
  return false;
}

/**
 * A fix turn ended well with stored work (fix.ts `afterBuildTurnEnded`): start a loop run (THE CLAIM). `byReader`
 * ⇒ a manual fix (its rounds are the reader's click). Returns whether it started; when it did not, the caller's
 * session goes on as it did before the loop (close / Push when done). Never throws.
 */
export async function startFixLoop(ctx: AgentContext, input: { accountId: number; fixId: number; byReader: boolean }): Promise<'started' | 'skipped'> {
  const { accountId, fixId } = input;
  if (active.has(fixId)) return 'skipped';
  const a: Active = { abort: new AbortController(), byReader: input.byReader, advancing: false, releaseRefs: seams.holdRefs(fixId) };
  active.set(fixId, a);
  pending.delete(fixId);
  try {
    const row = await getFixById(ctx, accountId, fixId);
    if (!row || row.pushedAt != null || !fixRowHasWork(row) || factsOf(row) == null) throw new Error('skip');
    const prev = row as AiFixRow & { loopRound?: number };
    const firstRound = (prev.loopRound ?? 0) + 1;
    const rounds = seams.rounds();
    if (!(await claimFixLoopStart(ctx, accountId, fixId, { firstRound, rounds }))) throw new Error('skip');
    await updateFixSession(ctx, accountId, fixId, { status: 'running' });
    seams.session.hold(fixId);
    seams.session.notice(fixId, `Ensemble reviews the fix before anything is pushed (up to ${rounds} ${rounds === 1 ? 'round' : 'rounds'}).`);
    kick(ctx, accountId, fixId);
    return 'started';
  } catch (err) {
    if (!(err instanceof Error && err.message === 'skip')) ctx.log.warn(`ai fix ${fixId}: the review loop did not start: ${errMsg(err)}`);
    a.releaseRefs();
    active.delete(fixId);
    return 'skipped';
  }
}

/** Run `advance` off the caller's tick. */
function kick(ctx: AgentContext, accountId: number, fixId: number): void {
  const a = active.get(fixId);
  if (!a || a.advancing) return;
  a.advancing = true;
  void (async () => {
    try {
      await advance(ctx, accountId, fixId, a);
    } catch (err) {
      ctx.log.warn(`ai fix ${fixId}: review loop step failed: ${errMsg(err)}`);
      if (active.get(fixId) === a) await end(ctx, accountId, fixId, 'review_failed').catch(() => {});
    } finally {
      a.advancing = false;
      seams.session.changed(ctx, accountId, fixId);
    }
  })();
}

/** Stop: at the next checkpoint (reviews aborted, a fix turn interrupted). The work so far is kept. */
export async function stopFixLoop(ctx: AgentContext, accountId: number, fixId: number): Promise<boolean> {
  const a = active.get(fixId);
  if (!a) return false;
  const row = await getFixById(ctx, accountId, fixId).catch(() => null);
  const fixing = (row as { loopState?: string } | null)?.loopState === 'fixing';
  a.abort.abort();
  if (fixing) await seams.session.interrupt(fixId);
  await end(ctx, accountId, fixId, 'stopped');
  return true;
}

/** The fix's session is closing while the loop works (Stop all, a turn past its cap): the loop ends. */
export async function endFixLoopForClose(ctx: AgentContext, accountId: number, fixId: number): Promise<void> {
  pending.delete(fixId);
  if (active.has(fixId)) await end(ctx, accountId, fixId, 'session_closed');
}

/** THE END of a loop run: the row, the hold, the line; then the session's own end (close / Push when done). */
async function end(ctx: AgentContext, accountId: number, fixId: number, stop: AiFixLoopStop): Promise<void> {
  const a = active.get(fixId);
  if (!a) return;
  active.delete(fixId);
  a.abort.abort();
  a.releaseRefs();
  const done = stop === 'clean' || stop === 'rounds' || stop === 'cannot_meet';
  await setFixLoop(ctx, accountId, fixId, { loopState: done ? 'done' : 'stopped', loopStop: stop, loopFinishedAt: seams.now() }).catch(() => {});
  seams.session.release(fixId);
  seams.session.notice(fixId, AI_FIX_LOOP_STOP_LINE[stop]);
  ctx.log.info(`ai fix ${fixId}: review loop ended (${stop})`);
  await seams.session.ended(ctx, accountId, fixId, stop).catch((err: unknown) => ctx.log.warn(`ai fix ${fixId}: after the review loop: ${errMsg(err)}`));
  seams.session.changed(ctx, accountId, fixId);
}

// ---- the state machine ------------------------------------------------------------------------------------------

async function advance(ctx: AgentContext, accountId: number, fixId: number, a: Active): Promise<void> {
  if (a.abort.signal.aborted) return;
  const row = await getFixById(ctx, accountId, fixId);
  const r = row as (AiFixRow & { loopState?: string; loopRound?: number; loopFirstRound?: number; loopRounds?: number | null; loopBaseSha?: string | null }) | null;
  if (!r || r.loopState !== 'reviewing') return;
  const k = r.loopRound ?? 1;
  const got = await stepReview(ctx, accountId, r, k, a);
  if (got !== 'fix' || a.abort.signal.aborted || active.get(fixId) !== a) return;
  await setFixLoop(ctx, accountId, fixId, { loopState: 'fixing' });
  seams.session.changed(ctx, accountId, fixId);
  await stepStartFix(ctx, accountId, fixId, k, a);
}

/** REVIEW k: the code review of the fix's work now (a local commit) and, with the ticket, the story check. */
async function stepReview(
  ctx: AgentContext,
  accountId: number,
  row: AiFixRow & { loopFirstRound?: number; loopRounds?: number | null; loopBaseSha?: string | null },
  k: number,
  a: Active,
): Promise<'fix' | 'ended'> {
  const fixId = row.id;
  const facts = factsOf(row)!;
  const { owner, name } = splitName(facts.fullName);
  const firstRound = row.loopFirstRound ?? k;
  const rounds = row.loopRounds ?? 1;
  const step = k - firstRound + 1;
  if (!fixRowHasWork(row)) {
    await end(ctx, accountId, fixId, 'not_pushable');
    return 'ended';
  }
  const workspaceId = row.workspaceId ?? 0;
  const providers = await seams.providers(ctx, accountId, workspaceId).catch(() => [] as AiProviderId[]);
  if (providers.length === 0) {
    await end(ctx, accountId, fixId, 'no_reviewer');
    return 'ended';
  }
  const ticket = await seams.ticket(ctx, accountId, row).catch(() => null);
  const storyProvider = ticket ? await seams.storyProvider() : null;
  // THE GATE, before anything of the round starts (a manual fix's rounds are the reader's click).
  if (!a.byReader) {
    if (!(await seams.automaticAllowed(ctx, accountId, FIX_LOOP_REVIEW_FEATURE, providers[0]!))) {
      await end(ctx, accountId, fixId, 'budget');
      return 'ended';
    }
    if (storyProvider && !(await seams.automaticAllowed(ctx, accountId, FIX_LOOP_CHECK_FEATURE, storyProvider))) {
      await end(ctx, accountId, fixId, 'budget');
      return 'ended';
    }
  }
  const merge = readMergeState(row.mergeJson ?? null);
  let head: Extract<BranchHeadSource, { localRef: string }>;
  let workKey: string;
  let baseSha: string;
  try {
    ({ head, workKey } = await seams.commitRound({ accountId, fixId, round: k, owner, name, facts, patch: row.patch ?? '', merge }));
    baseSha = row.loopBaseSha ?? (await seams.baseSha({ accountId, fixId, owner, name, facts, merge }));
    if (row.loopBaseSha == null) await setFixLoop(ctx, accountId, fixId, { loopBaseSha: baseSha });
  } catch (err) {
    seams.session.notice(fixId, `Ensemble could not read the fix to review it: ${errMsg(err)}`);
    await end(ctx, accountId, fixId, 'review_failed');
    return 'ended';
  }
  if (a.abort.signal.aborted) return 'ended';
  await dropUnsucceededFixLoopReviews(ctx, accountId, fixId, k);
  const reviews = await listFixLoopReviews(ctx, accountId, fixId);
  const findings = await listFixLoopFindings(ctx, accountId, fixId);
  const checks = await listFixLoopStoryChecks(ctx, accountId, fixId);
  const acs = await listFixLoopAcResponses(ctx, accountId, fixId);
  seams.session.notice(fixId, step > rounds ? 'Ensemble runs the closing review of the fix.' : `Ensemble reviews the fix (round ${step} of ${rounds}).`);

  // THE STORY CHECK beside the code review (only with the ticket's criteria in the fix).
  const prevCheck = [...checks].filter((c) => c.round < k && c.status === 'succeeded').sort((x, z) => z.round - x.round)[0] ?? null;
  const claims: StoryCheckClaim[] = acs
    .filter((r) => r.round === k - 1 && r.response !== 'not_reported' && r.response !== 'fixed' && (r.text ?? '').trim() !== '')
    .map((r) => ({ ref: r.ref, kind: r.response === 'not_applicable' ? ('not_applicable' as const) : ('answer' as const), text: r.text! }));
  const checkP =
    ticket && storyProvider
      ? (async (): Promise<boolean> => {
          await upsertFixLoopStoryCheck(ctx, accountId, { fixId, round: k, status: 'running', provider: storyProvider, model: null, assessment: null, claims, claimVerdicts: null, failureReason: null, costUsd: null, inputTokens: null, outputTokens: null, numTurns: null, completedAt: null });
          const res = await seams.runStoryCheck(ctx, {
            accountId,
            workspaceId,
            ident: ticket.ident,
            ticket: ticket.ticket,
            targets: [{ ref: 'PR1', id: fixId, repoId: facts.prRepoId, repo: facts.fullName, owner, name, branch: facts.headRef, head, baseSha, title: facts.title }],
            prior: prevCheck?.assessment ? { assessment: prevCheck.assessment, changedTargetIds: [fixId] } : null,
            claims,
            provider: storyProvider,
            abort: a.abort,
            feature: FIX_LOOP_CHECK_FEATURE,
          });
          await upsertFixLoopStoryCheck(ctx, accountId, {
            fixId,
            round: k,
            status: res.status,
            provider: storyProvider,
            model: res.model,
            assessment: res.assessment,
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
        })().catch(() => false)
      : Promise.resolve(true);

  // THE CODE REVIEW: a pair's halves AT ONCE (blind), consolidated — ONE pass. Every automatic half asks the gate
  // (the first was asked above); a refusal skips that half.
  const gates = await Promise.all(providers.map(async (p, n) => a.byReader || n === 0 || (await seams.automaticAllowed(ctx, accountId, FIX_LOOP_REVIEW_FEATURE, p))));
  const halves = await Promise.all(
    providers.map(async (p, n) => {
      const allowed = gates[n]!;
      const id = await insertFixLoopReview(ctx, accountId, { fixId, round: k, repoId: facts.prRepoId, baseSha, headSha: head.sha, localRef: head.localRef, workKey, provider: p, pairRole: pairRoleOf(n, providers.length), step, rounds, status: allowed ? 'running' : 'skipped' });
      if (!allowed) {
        await updateFixLoopReview(ctx, accountId, id, { failureReason: 'The AI spend limit is reached.', completedAt: seams.now() });
        return { id, res: null as BranchReviewHalfResult | null };
      }
      const res = await seams.runHalf(ctx, {
        accountId,
        workspaceId,
        repo: { owner, name, fullName: facts.fullName, repoId: facts.prRepoId },
        branch: facts.headRef,
        title: facts.title,
        body: [facts.body ?? '', `This review covers the pull request #${facts.number} with an AI fix applied (not pushed yet).`].filter((x) => x.trim() !== '').join('\n\n'),
        baseRef: facts.baseRef,
        baseSha,
        head,
        provider: p,
        // The loop's own earlier round AND the PR's still-open earlier findings (loop-pr-prior.ts), so the
        // closing round judges what the fix was for and the import can resolve those threads.
        prior: mergePrPrior(
          priorForTarget(reviews, findings, FIX_TARGET.kind, FIX_TARGET.id, k, p),
          await seams.prPrior(ctx, { accountId, prId: facts.prId, provider: p, inPair: providers.length > 1 }),
        ),
        abort: a.abort,
        byReader: a.byReader,
        feature: FIX_LOOP_REVIEW_FEATURE,
      });
      await updateFixLoopReview(ctx, accountId, id, {
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
        await insertFixLoopFindings(
          ctx,
          accountId,
          res.findings.map((f) => ({
            reviewId: id,
            fixId,
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
      return { id, res };
    }),
  );
  const checkOk = await checkP;
  if (a.abort.signal.aborted || active.get(fixId) !== a) return 'ended';
  const ok = halves.filter((h) => h.res?.status === 'succeeded');
  if (ok.length === 0) {
    await end(ctx, accountId, fixId, halves.every((h) => h.res == null) ? 'budget' : 'review_failed');
    return 'ended';
  }
  // A PAIR whose two halves succeeded: ONE consolidated review (duplicates merged, one verdict).
  const runsNow = (await listFixLoopReviews(ctx, accountId, fixId)).filter((r) => r.round === k && r.status === 'succeeded');
  if (runsNow.length === 2 && !runsNow.some((r) => r.pairConsolidation != null)) {
    const fs = await listFixLoopFindings(ctx, accountId, fixId);
    const x = runsNow.find((r) => r.pairRole !== 'second') ?? runsNow[0]!;
    const y = runsNow.find((r) => r.pairRole === 'second') ?? runsNow[1]!;
    const c = await seams.consolidate(ctx, accountId, runWire(x, fs), runWire(y, fs)).catch(() => null);
    if (c) {
      for (const [dropped, keep] of Object.entries(c.mergedFrom)) await updateFixLoopFinding(ctx, accountId, Number(dropped), { mergedInto: keep });
      await updateFixLoopReview(ctx, accountId, x.id, { pairConsolidation: pairConsolidationRecord(c, seams.now()) });
    }
  }
  // A failed story check never counts as "no criteria open" (unknown is never zero): the loop stops, as Build's
  // pauses — the fix so far is kept, the existing push rules still decide.
  if (!checkOk) {
    seams.session.notice(fixId, 'The story check did not finish.');
    await end(ctx, accountId, fixId, 'review_failed');
    return 'ended';
  }

  // WHAT IS OPEN, and THE STOP RULE (the shared core's; a pair is one pass).
  const checksNow = await listFixLoopStoryChecks(ctx, accountId, fixId);
  const checkNow = checksNow.find((c) => c.round === k && c.status === 'succeeded') ?? null;
  const open = roundOpen(k, await listFixLoopReviews(ctx, accountId, fixId), await listFixLoopFindings(ctx, accountId, fixId), checkNow, checksNow);
  const total = open.findings + open.criteria;
  const onlyCannotMeet = k > firstRound && onlyCannotMeetLeft(open, openCriteriaOf(checkNow, checksNow), cannotMeetOf(await listFixLoopAcResponses(ctx, accountId, fixId), k - 1));
  const next = nextAfterReview(open, step, rounds, { onlyCannotMeet });
  seams.session.notice(
    fixId,
    total === 0
      ? `Review round ${step}: nothing is open.`
      : `Review round ${step}: ${open.findings} ${open.findings === 1 ? 'finding' : 'findings'}${open.criteria > 0 ? ` and ${open.criteria} ${open.criteria === 1 ? 'criterion' : 'criteria'}` : ''} open.`,
  );
  if (next === 'open') {
    await end(ctx, accountId, fixId, total === 0 ? 'clean' : onlyCannotMeet ? 'cannot_meet' : 'rounds');
    return 'ended';
  }
  return 'fix';
}

/** FIX k: write REVIEW.md, then start the host's fix turn. The turn's end continues (`afterFixLoopTurn`). */
async function stepStartFix(ctx: AgentContext, accountId: number, fixId: number, k: number, a: Active): Promise<void> {
  if (!seams.session.live(fixId)) return end(ctx, accountId, fixId, 'session_closed');
  const row = await getFixById(ctx, accountId, fixId);
  if (!row) return end(ctx, accountId, fixId, 'session_closed');
  const r = row as AiFixRow & { loopFirstRound?: number; loopRounds?: number | null };
  const step = k - (r.loopFirstRound ?? k) + 1;
  const rounds = r.loopRounds ?? 1;
  const provider = seams.session.provider(fixId) ?? (row.provider === 'codex' ? 'codex' : 'claude');
  if (!a.byReader && !(await seams.automaticAllowed(ctx, accountId, FIX_LOOP_FIX_FEATURE, provider))) return end(ctx, accountId, fixId, 'budget');
  // Wait for the session to be idle (the turn that ended may still be settling) and the build slot to be free.
  const until = seams.now().getTime() + seams.waitMs;
  while (!seams.session.ready(fixId)) {
    if (a.abort.signal.aborted) return;
    if (!seams.session.live(fixId)) return end(ctx, accountId, fixId, 'session_closed');
    if (Date.now() > until) return end(ctx, accountId, fixId, 'fix_failed');
    await new Promise((res) => setTimeout(res, seams.pollMs));
  }
  const paths = seams.session.paths(fixId);
  if (!paths) return end(ctx, accountId, fixId, 'session_closed');
  const [reviews, findings, checks] = await Promise.all([listFixLoopReviews(ctx, accountId, fixId), listFixLoopFindings(ctx, accountId, fixId), listFixLoopStoryChecks(ctx, accountId, fixId)]);
  const facts = factsOf(row)!;
  const runs = reviews.filter((x) => x.round === k && x.status === 'succeeded');
  const carried = notCheckedFindingsOf(reviews, findings, k);
  const carriedIds = new Set(carried.map((f) => f.id));
  const open = [...openFindingsOf(findings, new Set(runs.map((x) => x.id))), ...carried];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const seedFindings: LoopSeedFinding[] = open.map((f) => {
    const item = f.priorFindingId != null ? runs.flatMap((x) => x.followUp?.items ?? []).find((it) => it.priorFindingId === f.priorFindingId) : undefined;
    const earlier = f.priorFindingId != null ? byId.get(f.priorFindingId) : undefined;
    return {
      findingId: f.id,
      target: facts.fullName,
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
  const check = checks.find((c) => c.round === k && c.status === 'succeeded') ?? null;
  const rejected = new Map((check?.claimVerdicts ?? []).filter((v) => v.verdict === 'rejected').map((v) => [v.ref.toUpperCase(), v.why]));
  const seedCriteria: LoopSeedCriterion[] = openCriteriaOf(check, checks).map((c) => ({ ...c, rejectedClaim: rejected.get(c.ref.toUpperCase()) ?? null }));
  const seed = buildLoopFixSeed({ subject: 'fix', round: step, rounds, findings: seedFindings, criteria: seedCriteria, root: paths.root });
  for (const [ref, stands] of seed.refs) if (stands.kind === 'finding') await updateFixLoopFinding(ctx, accountId, stands.findingId, { ref });
  for (const ref of seed.shown.filter((x) => /^(AC|M)\d+$/.test(x))) await upsertFixLoopAcResponse(ctx, accountId, { fixId, round: k, ref, response: 'not_reported', text: null });
  const r0 = paths.root.replace(/\/$/, '');
  await seams.session.removeResponse(fixId);
  const wrote = await seams.session.copyIn(fixId, [
    { path: `${r0}/REVIEW.md`, content: seed.text },
    { path: `${r0}/${REVIEW_REFS_FILE}`, content: `${JSON.stringify({ shown: seed.shown })}\n` },
    { path: REVIEW_RESPONSE_CHECKER, content: reviewResponseCheckerSource({ reportFile: `${r0}/${REVIEW_RESPONSE_FILE}`, refsFile: `${r0}/${REVIEW_REFS_FILE}` }), mode: 0o755 },
  ]);
  if (!wrote) return end(ctx, accountId, fixId, 'session_closed');
  const text = buildAiFixLoopFixInstruction({ round: step, rounds, root: paths.root, repoPath: paths.repoPath });
  for (;;) {
    if (a.abort.signal.aborted) return;
    const got = seams.session.startFixTurn(fixId, text);
    if (got === 'started') {
      seams.session.notice(fixId, `The agent is answering review round ${step}.`);
      return;
    }
    if (got === 'not_live') return end(ctx, accountId, fixId, 'session_closed');
    if (Date.now() > until) return end(ctx, accountId, fixId, 'fix_failed');
    await new Promise((res) => setTimeout(res, seams.pollMs));
  }
}

/**
 * THE END OF A LOOP FIX TURN (fix.ts `afterBuildTurnEnded` of a host turn; the work was already stored): the
 * agent's answers, then the next review. A stopped or failed turn ends the loop. Never throws.
 */
export async function afterFixLoopTurn(ctx: AgentContext, input: { accountId: number; fixId: number }, e: { outcome: string | null; stored: boolean }): Promise<void> {
  const { accountId, fixId } = input;
  const a = active.get(fixId);
  if (!a) return;
  try {
    const row = (await getFixById(ctx, accountId, fixId)) as (AiFixRow & { loopState?: string; loopRound?: number }) | null;
    if (!row || row.loopState !== 'fixing') return;
    const k = row.loopRound ?? 1;
    if (a.abort.signal.aborted) return;
    if (e.outcome !== 'completed' && e.outcome !== 'max_turns') return void (await end(ctx, accountId, fixId, e.outcome === 'interrupted' ? 'stopped' : seams.session.live(fixId) ? 'fix_failed' : 'session_closed'));
    if (!e.stored) return void (await end(ctx, accountId, fixId, seams.session.live(fixId) ? 'fix_failed' : 'session_closed'));
    const all = await listFixLoopFindings(ctx, accountId, fixId);
    const reviews = await listFixLoopReviews(ctx, accountId, fixId);
    const carriedIds = new Set(notCheckedFindingsOf(reviews, all, k).map((f) => f.id));
    const shownFindings = all.filter((f) => f.ref != null && (f.round === k || carriedIds.has(f.id)) && f.responseRound !== k);
    const acs = (await listFixLoopAcResponses(ctx, accountId, fixId)).filter((r) => r.round === k);
    const shown = [...shownFindings.map((f) => f.ref!), ...acs.map((r) => r.ref)];
    const got = await seams.session.readResponse(fixId, shown);
    const items = got.kind === 'ok' ? (got.check.payload?.items ?? []) : [];
    if (got.kind !== 'ok') seams.session.notice(fixId, got.kind === 'missing' ? 'The agent wrote no answers, so every item reads "not answered".' : `${got.reason} Every item reads "not answered".`);
    const byRef = new Map(items.map((it) => [it.ref, it]));
    // A "fixed" whose code did not change is an answer (the code is authoritative).
    const reviewedKey = reviews.find((x) => x.round === k && x.status === 'succeeded')?.workKey ?? null;
    const unchanged = reviewedKey != null && reviewedKey === fixWorkKey({ patch: row.patch, merge: readMergeState(row.mergeJson ?? null) });
    for (const f of shownFindings) {
      const it = byRef.get(f.ref!);
      let action: FixLoopFindingRow['response'] = it ? (it.action === 'not_applicable' || it.action === 'cannot_meet' ? 'answered' : it.action) : 'not_reported';
      let text = it?.reply ?? null;
      if (action === 'fixed' && unchanged) {
        action = 'answered';
        text = `(no code change) ${text ?? ''}`.trim();
      }
      await updateFixLoopFinding(ctx, accountId, f.id, { response: action, responseText: text, responseRound: k });
    }
    for (const r of acs) {
      const it = byRef.get(r.ref);
      await upsertFixLoopAcResponse(ctx, accountId, { fixId, round: k, ref: r.ref, response: it ? it.action : 'not_reported', text: it?.reply ?? null });
    }
    await setFixLoop(ctx, accountId, fixId, { loopState: 'reviewing', loopRound: k + 1 });
    // The step that started the turn may still be winding down: let it end first.
    for (let i = 0; i < 400 && a.advancing; i++) await new Promise((res) => setTimeout(res, 25));
    kick(ctx, accountId, fixId);
  } catch (err) {
    ctx.log.warn(`ai fix ${fixId}: after the loop's fix turn: ${errMsg(err)}`);
    await end(ctx, accountId, fixId, 'fix_failed').catch(() => {});
  }
}

/** A run's ClaudeReview wire (the pair consolidation's input). */
function runWire(r: FixLoopReviewRow, findings: readonly FixLoopFindingRow[]): ClaudeReview {
  return {
    id: r.id,
    prId: 0,
    headSha: r.headSha,
    status: r.status === 'skipped' ? 'cancelled' : (r.status as ClaudeReview['status']),
    model: r.model ?? '',
    provider: r.provider === 'codex' ? 'codex' : 'claude',
    effort: r.effort,
    scope: null,
    reviewMode: (r.reviewMode as ClaudeReview['reviewMode']) ?? null,
    routeReason: null,
    summary: r.summary,
    verdict: (r.verdict as ClaudeReview['verdict']) ?? null,
    userBody: null,
    userVerdict: null,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: r.numTurns,
    diffBytes: null,
    diffCapped: null,
    error: r.failureReason,
    excludedFiles: [],
    postedReviewId: null,
    postedAt: null,
    createdAt: new Date(0).toISOString(),
    finishedAt: null,
    findings: findings
      .filter((f) => f.reviewId === r.id)
      .map((f) => ({
        id: f.id,
        reviewId: f.reviewId,
        path: f.path,
        line: f.line,
        side: f.side,
        diffAnchorId: createHash('sha256').update(f.path, 'utf8').digest('hex'),
        severity: f.severity,
        title: f.title,
        body: f.body,
        editedBody: null,
        suggestion: f.suggestion,
        diffHunk: f.diffHunk,
        anchored: f.anchored,
        fileInDiff: f.fileInDiff,
        included: true,
        postedAt: null,
        githubCommentId: null,
        postedCommentKind: null,
        createdAt: new Date(0).toISOString(),
        priorFindingId: f.priorFindingId,
        lens: (f.lens as never) ?? null,
      })),
    trigger: 'auto',
    ...(r.pairRole ? { pair: { pairId: r.id, role: r.pairRole, otherReviewId: null } } : {}),
  };
}

// ---- the story check's ticket ------------------------------------------------------------------------------

/**
 * The PR's ticket for the story check, ONLY when its criteria are in the fix (an included S-item): the ticket
 * of the first such item's ticket review (`ticketIndex` order = the seed's). null ⇒ the rounds are code review
 * only. Never throws.
 */
export async function fixLoopTicket(ctx: AgentContext, accountId: number, row: AiFixRow): Promise<{ ident: string; ticket: ClaudeReviewTicket } | null> {
  try {
    const { parseReviewItems } = await import('./persist.js');
    const items = (parseReviewItems(row.reviewItems) ?? []).filter((i) => i.kind === 'story' && i.included && i.ticketIndex != null);
    if (items.length === 0) return null;
    const { getOwnedTicketItemsForPr } = await import('../../review/ticket-review/persist.js');
    const owned = await getOwnedTicketItemsForPr(ctx, accountId, row.prId);
    const runs: string[] = [];
    for (const o of owned) if (!runs.includes(`${o.ticketReviewId}:${o.ident}`)) runs.push(`${o.ticketReviewId}:${o.ident}`);
    const ti = Math.min(...items.map((i) => i.ticketIndex!));
    const ident = runs[ti]?.split(':').slice(1).join(':');
    if (!ident) return null;
    const { readSessionTicket } = await import('../../sandbox/workspace/ticket.js');
    const t = await readSessionTicket(ctx, accountId, row.workspaceId ?? 0, ident);
    if (t == null) return null;
    const criteria = t.criteria.map((c) => `${c.n}. ${c.text}`).join('\n');
    return {
      ident,
      ticket: { title: t.title, description: t.description, acceptanceCriteria: criteria !== '' ? criteria : t.acceptanceCriteriaText || null, key: t.key, url: t.url },
    };
  } catch {
    return null;
  }
}

// ---- after the push: the closing review on the PR ------------------------------------------------------------

/**
 * A fix was PUSHED (coding/ai-fix/push.ts): its loop's CLOSING review becomes the PR's AI review at the PUSHED
 * head (markLoopReviewOnPr: `trigger: 'manual'`, NOT posted, its consolidated findings), so auto review skips that
 * head and no auto fix chains from it. Only when the latest round reviewed EXACTLY the work that was pushed (the
 * work key): a fix the loop stopped before reviewing its last turn is reviewed by auto review as usual. The pushed
 * commit's sha differs from the local commit's; the tree is the same, so the lines anchor. Best-effort, never throws.
 */
export async function importLoopReviewAfterPush(
  ctx: AgentContext,
  a: { accountId: number; fixId: number; repoId: number; prNumber: number; pushedSha: string },
): Promise<number | null> {
  try {
    const row = await getFixById(ctx, a.accountId, a.fixId);
    if (!row || (row as { loopState?: string | null }).loopState == null) return null;
    const reviews = (await listFixLoopReviews(ctx, a.accountId, a.fixId)).filter((r) => r.status === 'succeeded');
    if (reviews.length === 0) return null;
    const last = Math.max(...reviews.map((r) => r.round));
    const runs = reviews.filter((r) => r.round === last);
    const key = fixWorkKey({ patch: row.patch, merge: readMergeState(row.mergeJson ?? null) });
    if (!runs.every((r) => r.workKey === key)) return null;
    // A re-raise of a PR finding keeps its link to it; a link to the loop's own earlier round has no PR row.
    const findings = (await listFixLoopFindings(ctx, a.accountId, a.fixId)).map((f) => ({ ...f, priorFindingId: prPriorFindingIdOf(f.priorFindingId) }));
    // THE PR'S EARLIER FINDINGS, as the closing round judged them (loop-pr-prior.ts).
    const prId = row.prId;
    const judgedIds = runs.flatMap((r) => r.followUp?.items ?? []).map((it) => prPriorFindingIdOf(it.priorFindingId)).filter((x): x is number => x != null);
    const prPrior = prId != null ? await prPriorReviewOf(ctx, { accountId: a.accountId, prId, findingIds: judgedIds }) : null;
    const followUp = prFollowUpForImport(runs, prPrior);
    const { markLoopReviewOnPr } = await import('../review-loop/review-on-pr.js');
    const id = await markLoopReviewOnPr(ctx, {
      accountId: a.accountId,
      repoId: a.repoId,
      prNumber: a.prNumber,
      headSha: a.pushedSha,
      // The import is at the PUSHED head: the runs reviewed the same work under the local commit's sha.
      runs: runs.map((r) => ({ ...r, headSha: a.pushedSha })),
      findings,
      line: (round) => `Reviewed in Ensemble's AI fix before it was pushed (round ${round}).`,
      who: `ai fix ${a.fixId}`,
      followUp,
    });
    if (id != null) await setFixLoop(ctx, a.accountId, a.fixId, { loopReviewId: id });
    // Close the PR's threads the closing round found fixed (the reader's own PR: "Resolve my Ensemble threads
    // when addressed"; the row is a manual one, so the workspace's auto path never applies). Never throws.
    if (id != null && followUp != null && prId != null) {
      const { maybeAutoResolveFindings } = await import('../../review/claude-review/auto-resolve.js');
      await maybeAutoResolveFindings(ctx, { accountId: a.accountId, prId, reviewId: id });
    }
    return id;
  } catch (err) {
    ctx.log.warn(`ai fix ${a.fixId}: the loop's review was not added to the PR: ${errMsg(err)}`);
    return null;
  }
}

/** Is this head the push of a fix whose loop's closing review was imported at it? (The auto fix queue.) */
export async function headReviewedByFixLoop(ctx: AgentContext, accountId: number, prId: number, headSha: string): Promise<boolean> {
  const { and, eq, isNotNull } = await import('drizzle-orm');
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const t = (ctx.schema as any).aiFixes;
  const rows = (await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.pushedCommitSha, headSha), isNotNull(t.loopReviewId)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

// ---- restart and the local refs ------------------------------------------------------------------------------------

/**
 * BOOT: every loop a restart cut off (reviewing / fixing, not running here) ENDS as stopped ('interrupted'); its
 * running review / story check rows read cancelled. NEVER reviews or pushes. Every account's rows.
 */
export async function reconcileFixLoopsOnStartup(ctx: AgentContext): Promise<number> {
  const { inArray } = await import('drizzle-orm');
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const t = (ctx.schema as any).aiFixes;
  const rows = (await ctx.db.select({ id: t.id, accountId: t.accountId }).from(t).where(inArray(t.loopState, ['reviewing', 'fixing'])).execute()) as Array<{ id: number; accountId: number }>;
  const { cancelRunningFixLoopRuns } = await import('./loop-persist.js');
  let n = 0;
  for (const r of rows) {
    if (active.has(r.id)) continue;
    await cancelRunningFixLoopRuns(ctx, r.accountId, r.id);
    await setFixLoop(ctx, r.accountId, r.id, { loopState: 'stopped', loopStop: 'interrupted', loopFinishedAt: new Date() });
    n += 1;
  }
  if (n > 0) ctx.log.info(`stopped ${n} AI Fix review loop(s) cut off by a restart`);
  return n;
}

/**
 * THE LOCAL REFS' KEEPER (review/local-refs.ts), registered BEFORE the boot sweep (index.ts): a fix's round
 * commits survive a restart only while the fix can still be resumed — a session row, built, not pushed. Anything
 * else (pushed, discarded, failed, gone) is swept.
 */
export function registerFixLoopRefKeeper(ctx: AgentContext, register: (kind: string, keeper: (ids: readonly number[]) => Promise<ReadonlySet<number>>) => void): void {
  register(FIX_LOOP_REF_KIND, async (ids) => {
    const { and, inArray, isNull, eq } = await import('drizzle-orm');
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const t = (ctx.schema as any).aiFixes;
    if (ids.length === 0) return new Set<number>();
    const rows = (await ctx.db
      .select({ id: t.id })
      .from(t)
      .where(and(inArray(t.id, [...ids]), eq(t.sessionPhase, 'built'), isNull(t.pushedAt)))
      .execute()) as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  });
}

/** DISCARD / PUSH: drop the fix's local refs in the PR repository's clone (never throws). */
export async function dropFixLoopRefs(fullName: string, fixId: number): Promise<void> {
  const { owner, name } = splitName(fullName);
  const { dropLocalRefs } = await import('../../review/local-refs.js');
  await dropLocalRefs(owner, name, FIX_LOOP_REF_KIND, fixId).catch(() => 0);
}
