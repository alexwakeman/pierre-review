import { and, desc, eq, gt } from 'drizzle-orm';
import type {
  AiFixPickerPreview,
  AiFixReviewItem,
  AiFixSeed,
  AiFixStatus,
  AiFixStatusResponse,
  AiFixTrigger,
  AutoFixInclude,
  ClaudeReview,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { getFixMergeOffer, getFixPrContext } from './pr-context.js';
import { MERGE_ITEM_REF } from '../../sandbox/session/fix-merge.js';
import { getClaudeReviewById, getReviewView } from '../../review/claude-review/persist.js';
import { currentThreadAssessmentsForPrs } from '../../review/claude-review/thread-judgements.js';
import { pickReviewNonce } from '../../review/claude-review/prompts.js';
import {
  buildPickerPreview,
  buildReviewSeed,
  type ReviewSeed,
  type SeedSelection,
  type SeedTicketItem,
} from './review-seed.js';
import { loadSeedThreads } from './thread-candidates.js';
import { getOwnedTicketItemsForPr } from '../../review/ticket-review/persist.js';
import { getFixableCiItemsForPr } from '../../review/ci-review/persist.js';
import { getSonarIssuesForPrHead } from '../../sonar/store.js';
import { freshenSonarForPrHead } from '../../sonar/snapshot.js';
import { getFixById, insertQueuedFix, markFixRanOn, reconcileOrphanedFixes, updateFixSession } from './persist.js';
import { activeProviderId } from '../../ai/provider-setting.js';
import type { AgentProviderId } from '../../ai/provider.js';
import { preflightFor } from '../../ai/run-choice.js';
import { automaticRunAllowed } from '../../review/budget-gate.js';
import { resolveSandboxAgentChoice } from '../../sandbox/drivers/index.js';
import { liveSession, NO_RUNTIME_LINE, sessionDeps, type SessionActionResult } from '../../sandbox/session/manager.js';
import {
  capFixDiff,
  claimFixPr,
  discardFixSession,
  fixHoldsPr,
  fixIdHoldingPr,
  fixKey,
  fixLiveProgress,
  reconcileFixSessionsOnStartup,
  rekeyFixSlot,
  releaseFixPr,
  releaseFixSlot,
  reserveFixSlot,
  sendFixMessage,
  startFixBuild,
  startFixSession,
  stopFixSession,
  type FixDiscardResult,
} from '../../sandbox/session/fix.js';
import type { SessionKey } from '../../sandbox/session/subject.js';

export { subscribeFixStream } from './stream.js';

// AI FIX (CORE, free, local-only). EVERY run — manual, "Plan first", the unattended AUTO FIX and dependency
// automation's "fix with AI" — is a sandboxed WORKSPACE SESSION on Claude Code or Codex
// (sandbox/session/fix.ts; docs/SANDBOX.md § AI Fix sessions). This module keeps the names its callers
// import and does what runs BEFORE any sandbox work: the provider pre-flight, the seed (a review with
// nothing to fix spends no GitHub call and boots nothing), the one-fix-per-PR claim, the runtime check,
// the session cap and the build slot, the live head, then the row.
//
// ⚠ NEVER QUEUED: a start that finds no runtime, no free session or the build slot taken answers at once
//   (`no_runtime` / `too_many` / `build_busy`); the caller records it. The next click / auto review / deps
//   tick decides again.
// ⚠ ONE FIX PER PR, claimed SYNCHRONOUSLY in the tick of its check; every bail path releases it.

/** The stored review a seed names, checked to be THIS PR's succeeded run. null otherwise. */
async function loadSourceReview(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  reviewId: number | null | undefined,
): Promise<ClaudeReview | null> {
  if (reviewId == null) return null;
  // A Claude + Codex pair seeds from its ONE consolidated review (both halves' findings, merged-away
  // duplicates never read — pair-view.ts), never from one half.
  const view = await getReviewView(ctx, reviewId, accountId);
  if (!view || view.prId !== prId || view.status !== 'succeeded') return null;
  // A pair with a failed half: what the other half's cover pass found still open counts too.
  const review = await withCoverFollowUp(ctx, accountId, prId, view).catch((err: unknown) => {
    ctx.log.warn({ err }, 'ai-fix: reading the pair\'s cover pass failed');
    return view;
  });
  // A later Check threads run judged threads since this review: when this IS the latest review,
  // its thread items come from THE ONE FOLD (the newer judgement per thread). Fails soft.
  try {
    const current = (await currentThreadAssessmentsForPrs(ctx, accountId, [prId])).get(prId);
    if (current && current.reviewId === review.id && current.checkId != null) {
      return { ...review, threadAssessments: current.assessments };
    }
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: folding the thread checks failed');
  }
  return review;
}

/**
 * EVERY LIMN FINDING COUNTS. A Claude + Codex pair whose one half failed (or never started) is followed by
 * the other half's COVER PASS (replies-check.ts `runCoverCheck`: a `kind = 'replies'` row, `followUp.cover`
 * set) that judges the failed half's earlier open findings — the pair's own follow-up never holds them.
 * Its items join the review's follow-up, so "Earlier findings not fixed yet" carries them like any other
 * (an item the pair already judged keeps the pair's word). Only a SUCCEEDED cover at the review's head,
 * newer than the pair and older than the PR's next full review. A pair whose two halves both succeeded,
 * or a single run, is returned as it is.
 */
export async function withCoverFollowUp(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  review: ClaudeReview,
): Promise<ClaudeReview> {
  const halves = review.pair?.halves ?? [];
  if (review.pair == null || (halves.length === 2 && halves.every((h) => h.status === 'succeeded'))) return review;
  const cr = ctx.schema.claudeReviews;
  const later = (await ctx.db
    .select({ id: cr.id, kind: cr.kind, status: cr.status, headSha: cr.headSha })
    .from(cr)
    .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), gt(cr.id, review.id)))
    .orderBy(cr.id)
    .execute()) as Array<{ id: number; kind: string | null; status: string; headSha: string }>;
  const nextFull = later.find((r) => r.kind == null)?.id ?? Infinity;
  const candidates = later
    .filter((r) => r.kind === 'replies' && r.status === 'succeeded' && r.headSha === review.headSha && r.id < nextFull)
    .reverse();
  for (const c of candidates) {
    const cover = await getClaudeReviewById(ctx, c.id, accountId);
    const fu = cover?.followUp;
    if (!fu?.cover) continue;
    const own = review.followUp?.items ?? [];
    const seen = new Set(own.map((i) => i.priorFindingId));
    const added = fu.items.filter((i) => !seen.has(i.priorFindingId));
    if (added.length === 0) return review;
    return { ...review, followUp: review.followUp ? { ...review.followUp, items: [...own, ...added] } : { ...fu, items: added } };
  }
  return review;
}

/** How long opening / starting a fix waits for a SonarCloud read of the current head. */
const SONAR_FRESHEN_WAIT_MS = 8_000;

/** Everything a seed is built from besides the review. Each read fails soft (costs its items only). */
async function loadSeedInputs(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  withTicketItems: boolean,
) {
  const [ticketItems, ciItems, threads, sonarIssues, merge] = await Promise.all([
    withTicketItems
      ? getOwnedTicketItemsForPr(ctx, accountId, prId).catch((err: unknown): SeedTicketItem[] => {
          ctx.log.warn({ err }, 'ai-fix: loading ticket items failed');
          return [];
        })
      : Promise.resolve<SeedTicketItem[]>([]),
    // The CI review's fixable items at the PR's CURRENT head (manual and auto fixes alike).
    getFixableCiItemsForPr(ctx, accountId, prId).catch((err: unknown) => {
      ctx.log.warn({ err }, 'ai-fix: loading CI review items failed');
      return [];
    }),
    // The PR's open threads (untouched + style-bot sections). Never throws.
    loadSeedThreads(ctx, accountId, prId),
    // SonarCloud's items from the snapshot AT THE PR'S CURRENT HEAD — read first when that head has
    // no good read yet (bounded wait; a reuse otherwise; docs/SONARCLOUD.md § AI Fix).
    freshenSonarForPrHead(ctx, accountId, prId, SONAR_FRESHEN_WAIT_MS, {
      log: { warn: (m) => ctx.log.warn(m) },
    }).then(() => getSonarIssuesForPrHead(ctx, accountId, prId)).catch((err: unknown) => {
      ctx.log.warn({ err }, 'ai-fix: loading SonarCloud issues failed');
      return [];
    }),
    // The MERGE item, when the PR conflicts with its base (manual and auto alike: the selection decides;
    // an auto fix picks it only with the workspace's `AutoFixInclude.conflicts` on, OFF by default).
    loadMergeOffer(ctx, accountId, prId),
  ]);
  return { ticketItems, ciItems, threads, sonarIssues, merge };
}

/** The merge item's gate (pr-context.ts `getFixMergeOffer`). Fails soft: no item. */
function loadMergeOffer(ctx: AgentContext, accountId: number, prId: number): Promise<{ baseRef: string } | null> {
  return getFixMergeOffer(ctx, accountId, prId).catch((err: unknown) => {
    ctx.log.warn({ err }, 'ai-fix: reading the merge state failed');
    return null;
  });
}

/**
 * Load the review a 'review' seed names and render its items. null when the review is missing,
 * not this account's, not THIS PR's, or did not succeed. Never throws.
 *
 * `withTicketItems` adds the TICKET review's items this PR owns (review-seed.ts header) — set by a
 * MANUAL fix only. ⚠ An auto fix never sets it: fixing a ticket's gap is a person's call.
 * `selection` picks the items (the reader's keys, an auto fix's sections); absent ⇒ the defaults.
 */
export async function loadReviewSeed(
  ctx: AgentContext,
  input: {
    accountId: number;
    prId: number;
    reviewId: number | null | undefined;
    withTicketItems?: boolean;
    selection?: SeedSelection;
  },
): Promise<{ review: ClaudeReview; seed: ReviewSeed } | null> {
  try {
    const review = await loadSourceReview(ctx, input.accountId, input.prId, input.reviewId);
    if (!review) return null;
    const inputs = await loadSeedInputs(ctx, input.accountId, input.prId, input.withTicketItems === true);
    return {
      review,
      seed: buildReviewSeed(review, { nonce: pickReviewNonce, ...inputs, selection: input.selection }),
    };
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: loading the review seed failed');
    return null;
  }
}

/**
 * THE CI-ONLY SEED (a MANUAL fix with no AI review — "Fix with AI" beside a finished CI check): the
 * CI review's fixable items at the PR's current head, nothing else (review-seed.ts
 * `collectSeedCandidates` with a null review). Never throws; an empty seed is the caller's
 * `nothing_to_fix`.
 */
export async function loadCiOnlySeed(
  ctx: AgentContext,
  input: { accountId: number; prId: number; selection?: SeedSelection },
): Promise<ReviewSeed> {
  try {
    const [ciItems, merge] = await Promise.all([
      getFixableCiItemsForPr(ctx, input.accountId, input.prId),
      loadMergeOffer(ctx, input.accountId, input.prId),
    ]);
    return buildReviewSeed(null, { nonce: pickReviewNonce, ciItems, merge, selection: input.selection });
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: loading the CI-only seed failed');
    return { items: [], sentRefs: [], text: '' };
  }
}

/**
 * The fix picker's preview for a MANUAL fix (ticket items included, like the manual start). null
 * when the review is not this PR's succeeded run. `reviewId === null` ⇒ the CI-ONLY preview (the CI
 * check's fixable items alone; `sourceReviewId: null`). Never throws.
 */
export async function loadFixPreview(
  ctx: AgentContext,
  input: { accountId: number; prId: number; reviewId: number | null },
): Promise<AiFixPickerPreview | null> {
  try {
    if (input.reviewId == null) {
      const [ciItems, merge] = await Promise.all([
        getFixableCiItemsForPr(ctx, input.accountId, input.prId),
        loadMergeOffer(ctx, input.accountId, input.prId),
      ]);
      return buildPickerPreview(null, { ciItems, merge });
    }
    const review = await loadSourceReview(ctx, input.accountId, input.prId, input.reviewId);
    if (!review) return null;
    const inputs = await loadSeedInputs(ctx, input.accountId, input.prId, true);
    return buildPickerPreview(review, inputs);
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: building the fix preview failed');
    return null;
  }
}

/**
 * Start a fix seeded from a Claude review — the ONE entry the auto-review agent calls (it passes
 * `trigger: 'auto'`); the manual "Fix from review" route goes through the same path. Nothing is pushed
 * until a person presses Push — unless the fix is AUTO and its workspace switched "Push automatically" on
 * (auto-push.ts).
 */
export function startReviewFix(
  ctx: AgentContext,
  input: {
    accountId: number;
    prId: number;
    reviewId: number;
    model: string;
    trigger: AiFixTrigger;
    // An auto fix's sections (Settings → Auto review → Always include). Absent ⇒ the defaults.
    include?: AutoFixInclude;
  },
): Promise<StartFixResult> {
  return startFix(ctx, {
    accountId: input.accountId,
    prId: input.prId,
    model: input.model,
    seed: 'review',
    sourceReviewId: input.reviewId,
    trigger: input.trigger,
    selection: input.include ? { kind: 'sections', include: input.include } : undefined,
  });
}

export type StartFixResult =
  | { status: 'queued'; fixId: number }
  | { status: 'already_running' }
  | { status: 'not_found' }
  | { status: 'no_auth'; message?: string }
  | { status: 'no_head' }
  // seed === 'review': the named review is missing, another PR's / account's, or not succeeded.
  | { status: 'review_unavailable' }
  // seed === 'review': the review has nothing to fix. A refusal, not an empty run.
  | { status: 'nothing_to_fix' }
  // seed === 'plain' with a blank instruction.
  | { status: 'no_instruction' }
  // THE SANDBOX: no container runtime on this computer; every session slot taken; another session's
  // build turn runs (a fix builds at once). Never queued.
  | { status: 'no_runtime'; message: string }
  | { status: 'too_many'; message: string }
  | { status: 'build_busy' }
  // An UNATTENDED start over the AI spend budget (`automaticRunAllowed`, asked once more here so no
  // automatic caller can skip it). A reader's click never gets it.
  | { status: 'over_budget' };

export interface StartFixInput {
  accountId: number;
  prId: number;
  model: string;
  seed: AiFixSeed;
  // seed === 'review': the Claude review to fix from. The seed is built from the STORED run.
  // null/absent ⇒ THE CI-ONLY SEED (the CI review's fixable items at the current head, nothing else).
  sourceReviewId?: number | null;
  // seed === 'plain': the reader's instruction.
  instruction?: string;
  // Who started it. Omitted ⇒ 'manual'. 'auto' ⇒ an UNATTENDED session (it closes after its turn).
  trigger?: AiFixTrigger;
  // seed === 'review': which items. Absent ⇒ the section defaults (every section but style bots).
  selection?: SeedSelection;
  // THE PER-RUN CHOICE (a manual start's picker, validated by the route). Absent ⇒ the default
  // provider (Settings → AI) — always so for an automatic fix.
  provider?: AgentProviderId;
  // REMOVED ("Run tests": tests now run inside the sandbox). Accepted from an older caller and ignored.
  checks?: string[];
  // seed === 'plain' (dependency automation's conflict path): ALSO merge the PR's base and resolve the
  // conflicts first — the MERGE item (sandbox/session/fix-merge.ts). A review seed carries it as a picker
  // item instead ('conflict:merge'). On THE CI-ONLY SEED (dependency automation's COMBINED run: the PR
  // conflicts and its CI fails) it is a requirement: the seed must hold the MERGE item (`getFixMergeOffer`
  // agrees), or the start is `nothing_to_fix`.
  resolveConflicts?: boolean;
  // THE CI-ONLY SEED only (dependency automation's combined run): Limn's OWN lines, set above the seed's
  // items (`dependencyMergeAndCiPreamble`). Never PR text: it sits outside every fence.
  preamble?: string;
}

export function startFix(ctx: AgentContext, input: StartFixInput): Promise<StartFixResult> {
  return startRun(ctx, input, 'fix');
}

/**
 * PLAN FIRST (manual fixes only — the auto path never calls this): the same seed, claim and guards as
 * `startFix`, but the session opens in CHAT with one "make a plan" turn and waits for Start fix
 * (`approvePlan`). docs/SANDBOX.md § AI Fix sessions.
 */
export function startPlan(ctx: AgentContext, input: StartFixInput): Promise<StartFixResult> {
  return startRun(ctx, { ...input, trigger: 'manual' }, 'plan');
}

async function startRun(ctx: AgentContext, input: StartFixInput, mode: 'fix' | 'plan'): Promise<StartFixResult> {
  const { accountId, prId } = input;
  const trigger: AiFixTrigger = input.trigger ?? 'manual';
  const unattended = trigger === 'auto';

  // THE PROVIDER IS PICKED ONCE, HERE: the request's per-run choice, else the default.
  const provider: AgentProviderId = input.provider ?? activeProviderId();
  const auth = preflightFor(ctx)(provider, mode);
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };

  const instruction = (input.instruction ?? '').trim();
  if (input.seed === 'plain' && instruction === '') return { status: 'no_instruction' };

  // THE ONE BUDGET GATE, for every AUTOMATIC run: the callers ask first; asked again here so no future
  // caller can start an unattended fix past it. Before the claim, so nothing needs releasing.
  const dependencyRun = input.seed === 'plain' || input.preamble != null;
  if (unattended && !(await automaticRunAllowed(ctx, accountId, dependencyRun ? 'dependency CI fix' : 'auto fix'))) return { status: 'over_budget' };

  // ⚠ THE CLAIM, in the same tick as its check and BEFORE any await. EVERY bail path below releases it
  // (and the reserved slot), or this PR's fixer wedges for the process's lifetime.
  if (!claimFixPr(prId)) return { status: 'already_running' };
  let slot: SessionKey | null = null;
  // The row, once written: a throw before its session registers must not leave it `running` for ever.
  let insertedId: number | null = null;
  const bail = <T extends StartFixResult>(r: T): T => {
    if (slot) releaseFixSlot(slot);
    releaseFixPr(prId);
    return r;
  };
  try {
    const pr = await getFixPrContext(ctx, accountId, prId);
    if (!pr) return bail({ status: 'not_found' });

    // The seed is resolved BEFORE GitHub is asked anything and before the sandbox: a review with nothing
    // to fix spends no GitHub call and boots nothing. FROZEN here: the items stored are the items fixed.
    let reviewItems: AiFixReviewItem[] | null = null;
    let sentRefs: string[] = [];
    let task: { kind: 'review' | 'plain'; text: string };
    if (input.seed === 'review' && input.sourceReviewId == null) {
      const ciSeed = await loadCiOnlySeed(ctx, { accountId, prId, selection: input.selection });
      if (ciSeed.sentRefs.length === 0) return bail({ status: 'nothing_to_fix' });
      // The combined run asked for the merge: no MERGE item (the PR no longer conflicts, or it joined a merge
      // queue) ⇒ nothing started; the caller's next tick decides on fresh facts.
      if (input.resolveConflicts === true && !ciSeed.sentRefs.includes(MERGE_ITEM_REF)) return bail({ status: 'nothing_to_fix' });
      reviewItems = ciSeed.items;
      sentRefs = ciSeed.sentRefs;
      const preamble = (input.preamble ?? '').trim();
      task = { kind: 'review', text: preamble ? `${preamble}\n\n${ciSeed.text}` : ciSeed.text };
    } else if (input.seed === 'review') {
      const loaded = await loadReviewSeed(ctx, {
        accountId,
        prId,
        reviewId: input.sourceReviewId,
        withTicketItems: trigger === 'manual',
        selection: input.selection,
      });
      if (!loaded) return bail({ status: 'review_unavailable' });
      if (loaded.seed.sentRefs.length === 0) return bail({ status: 'nothing_to_fix' });
      reviewItems = loaded.seed.items;
      sentRefs = loaded.seed.sentRefs;
      task = { kind: 'review', text: loaded.seed.text };
    } else {
      task = { kind: 'plain', text: instruction };
      if (input.resolveConflicts === true) {
        reviewItems = [{ ref: MERGE_ITEM_REF, kind: 'merge_conflicts', title: 'Resolve the merge conflicts', path: null, line: null, findingId: null, threadId: null, ticketIndex: null, included: true }];
        sentRefs = [MERGE_ITEM_REF];
      }
    }
    // THE MERGE goes into the session only when it was SHOWN to the agent (picked, or asked for).
    const wantsMerge = (reviewItems ?? []).some((i) => i.kind === 'merge_conflicts' && i.included);

    // THE SANDBOX: a runtime, a free session, and (a fix builds at once) the ONE build slot — reserved in
    // the tick of the check and held through the boot (its first turn starts the moment the agent is ready).
    const detected = await sessionDeps().runtime().detect();
    if (!detected.available) return bail({ status: 'no_runtime', message: detected.problem ?? NO_RUNTIME_LINE });
    const placeholder: SessionKey = `fix:${-prId}`;
    const reserved = reserveFixSlot(placeholder, mode === 'fix');
    if (!reserved.ok) return bail(reserved.reason === 'too_many' ? { status: 'too_many', message: reserved.message } : { status: 'build_busy' });
    slot = placeholder;

    const head = await ctx.github.fetchPrHeadInfo(accountId, pr.owner, pr.name, pr.number);
    if (!head.headSha) return bail({ status: 'no_head' });
    const rawDiff = await ctx.github.fetchPrDiff(accountId, pr.owner, pr.name, pr.number).catch(() => '');
    const diff = capFixDiff(rawDiff);

    // The whole workspace of the PR's repository (its Settings → Sandbox, its members).
    const q = await import('../../db/queries.js');
    const repoScope = await q.workspaceScopeForRepo(accountId, pr.repoId);
    if (!repoScope) return bail({ status: 'not_found' });
    const scope = await q.resolveWorkspaceScope(accountId, repoScope.workspaceId);

    const choice = resolveSandboxAgentChoice({ provider, model: input.model });
    const nonce = pickReviewNonce([task.text, pr.title, pr.body ?? '', rawDiff]);
    const fixId = await insertQueuedFix(ctx, {
      accountId,
      repoId: pr.repoId,
      prId,
      baseSha: head.headSha,
      model: input.model,
      seed: input.seed,
      sourceReviewId: input.seed === 'review' ? (input.sourceReviewId ?? null) : null,
      // The task text (FIX.md's "What to fix"), frozen: history and Resume read it.
      prompt: task.text,
      trigger,
      reviewItems,
      provider,
      session: { workspaceId: scope.workspaceId, unattended, effort: choice.effort },
    });
    insertedId = fixId;
    await markFixRanOn(ctx, fixId, { provider: choice.provider, model: choice.model, effort: choice.effort });
    rekeyFixSlot(placeholder, fixKey(fixId));
    slot = fixKey(fixId);
    startFixSession(ctx, {
      fixId,
      accountId,
      workspaceId: scope.workspaceId,
      memberRepoIds: scope.repoIds,
      pr: {
        prId,
        repoId: pr.repoId,
        number: pr.number,
        owner: pr.owner,
        name: pr.name,
        title: pr.title,
        body: pr.body,
        headRef: head.headRef,
        baseRef: head.baseRef || pr.baseRefName || pr.defaultBranch || 'main',
        headSha: head.headSha,
      },
      merge: wantsMerge ? { baseRef: head.baseRef || pr.baseRefName || pr.defaultBranch || 'main' } : null,
      choice,
      planFirst: mode === 'plan',
      unattended,
      trigger,
      task,
      shownRefs: sentRefs,
      diff,
      nonce,
    });
    return { status: 'queued', fixId };
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix start failed');
    // A registered session owns its claim and slot from here (its close releases them).
    if (insertedId != null && liveSession(fixKey(insertedId)) != null) return { status: 'queued', fixId: insertedId };
    if (insertedId != null) {
      const failedId = insertedId;
      await updateFixSession(ctx, accountId, failedId, {
        sessionPhase: 'failed',
        status: 'failed',
        error: 'The fix could not start.',
        finishedAt: new Date(),
      }).catch((e: unknown) => ctx.log.warn({ err: e }, 'ai-fix: recording a failed start failed'));
    }
    return bail({ status: 'not_found' });
  }
}

// ---- the session's actions (the routes) ------------------------------------------------------------------

export type FixActionResult = SessionActionResult;

/** One more turn in the SAME session (chat before Start fix; a build turn after). */
export function sendFixSessionMessage(ctx: AgentContext, input: { accountId: number; fixId: number; text: string }): Promise<FixActionResult> {
  return sendFixMessage(ctx, input.accountId, input.fixId, input.text);
}

/** Kept name (an older SPA bundle's plan chat): the same as `sendFixSessionMessage`. */
export const sendPlanMessage = sendFixSessionMessage;

/**
 * "Start fix" (Plan first): the SAME session switches to build mode and fixes, following the plan it
 * agreed with the reader. A plan of the removed shell-less flow cannot be built any more.
 */
export async function approvePlan(ctx: AgentContext, input: { accountId: number; fixId: number; text?: string | null }): Promise<FixActionResult> {
  const row = await getFixById(ctx, input.accountId, input.fixId);
  if (!row) return { status: 'not_found' };
  if (row.sessionPhase == null) {
    return { status: 'not_ready', message: 'This plan was made before AI Fix moved into the sandbox. Discard it and start a new fix.' };
  }
  return startFixBuild(ctx, input.accountId, input.fixId, input.text ?? null);
}

/** Discard (and the old "Discard plan"): the session closes; nothing is pushed. */
export function discardFix(ctx: AgentContext, input: { accountId: number; fixId: number }): Promise<FixDiscardResult> {
  return discardFixSession(ctx, input.accountId, input.fixId);
}

/** Kept name: the old "Discard plan". */
export async function discardPlan(ctx: AgentContext, input: { accountId: number; fixId: number }): Promise<'discarded' | 'not_found' | 'not_ready'> {
  return (await discardFix(ctx, input)).status;
}

/** Stop (`POST …/ai-fix/cancel`): fix.ts `stopFixSession`. true ⇒ something was stopped. */
export function requestFixCancel(ctx: AgentContext, accountId: number, prId: number): Promise<boolean> {
  return stopFixSession(ctx, accountId, prId);
}

/** A fix session holds the PR (starting, booting, or open — a Plan first waiting for Start fix too). */
export function isFixRunning(prId: number): boolean {
  return fixHoldsPr(prId);
}

export async function getFixStatus(ctx: AgentContext, accountId: number, prId: number): Promise<AiFixStatusResponse> {
  // The DB lookup goes FIRST, and it is what establishes ownership: the in-memory claims are keyed by
  // prId alone, so they are consulted only to upgrade a row this account owns into a live status.
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db
    .select({ id: t.id, status: t.status })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId)))
    .orderBy(desc(t.id))
    .limit(1)
    .execute()) as Array<{ id: number; status: AiFixStatus }>;
  const row = rows[0];
  if (!row) return { status: 'idle', fixId: null, progress: null };
  if (fixIdHoldingPr(prId) === row.id) {
    const now = fixLiveProgress(row.id);
    if (now) return { status: now.status, fixId: row.id, progress: now.progress };
  }
  return { status: row.status, fixId: row.id, progress: null };
}

export async function reconcileFixesOnStartup(ctx: AgentContext): Promise<void> {
  try {
    // ⚠ Sessions FIRST: the legacy reconcile below reads only `session_phase IS NULL` rows.
    const s = await reconcileFixSessionsOnStartup(ctx);
    const n = await reconcileOrphanedFixes(ctx);
    if (n > 0) ctx.log.info({ n, sessions: s }, 'ai-fix: reconciled orphaned runs on startup');
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: startup reconcile failed');
  }
}
