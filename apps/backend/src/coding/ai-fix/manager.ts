import { and, desc, eq } from 'drizzle-orm';
import { AI_FIX_PLAN_MAX_REVISIONS, aiRunProvider } from '@pierre-review/shared';
import type {
  AiFixPlanMessage,
  AiFixPickerPreview,
  AiFixProgress,
  AiFixReviewItem,
  AiFixSeed,
  AiFixStatus,
  AiFixStatusResponse,
  AiFixStreamEvent,
  AiFixTrigger,
  AutoFixInclude,
  ClaudeReview,
} from '@pierre-review/shared';
import type { CodingProgress } from '../../platform/contract.js';
import type { AgentContext } from '../../review/agent-context.js';
import { getFixPrContext } from './pr-context.js';
import { getClaudeReviewById } from '../../review/claude-review/persist.js';
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
import { maybeAutoPushFix } from './auto-push.js';
import { getOwnedTicketItemsForPr } from '../../review/ticket-review/persist.js';
import { getFixableCiItemsForPr } from '../../review/ci-review/persist.js';
import { getSonarIssuesForPrHead } from '../../sonar/store.js';
import { freshenSonarForPrHead } from '../../sonar/snapshot.js';
import { partialSpendOf } from '../partial-spend.js';
import {
  buildFixSystemPrompt,
  buildFixUserPrompt,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  renderPlanText,
  type FixSeed,
} from './prompts.js';
import {
  appendPlanMessage,
  getFixById,
  insertQueuedFix,
  markFixCancelled,
  markFixFailed,
  markFixRanOn,
  markFixRunning,
  markPlanRanOn,
  markPlanApproved,
  markPlanDiscarded,
  markPlanPassEnded,
  parseReviewItems,
  reconcileOrphanedFixes,
  saveFixSuccess,
  savePlanSuccess,
} from './persist.js';
import {
  normalizePlan,
  parsePlan,
  parsePlanSeed,
  parsePlanStatus,
  parseTranscript,
  planReply,
  shownRefsOf,
  type PlanRunProgress,
} from './plan.js';
import { config } from '../../config.js';
import { activeProviderId } from '../../ai/provider-setting.js';
import { agenticRunEffort } from '../../ai/effort.js';
import { claudeModelChoice, getProvider, requestModelOf, type AgentProviderId, type AiRanOn } from '../../ai/provider.js';
import { providerName } from '../../ai/prompt-tools.js';
import { followUpProvider, preflightFor } from '../../ai/run-choice.js';

// In-memory job manager for AI Fix's agentic fixer (CORE, free, local-only — it left the plugin
// with Claude Review; the PR summary and the CI-failure analysis stayed Pro). A SINGLE global slot (concurrency 1) carries every
// fix-generate run in the process, so no two ever run concurrently (a write run is costly,
// and running one at a time means the agent never needs to mutate process.env for auth, so
// it can't race a Claude Review). One job per PR (the `claimed` guard). Pushing a finished
// fix is NOT a job: POST …/push is synchronous and never takes the slot.

const MAX_CONCURRENT = 1;
const MAX_QUEUED = 20;

// ---- the single-slot scheduler ----
const running = new Set<number>(); // prIds with a fix run in flight
const claimed = new Set<number>(); // prIds claimed (queued OR running)
interface PendingJob {
  prId: number;
  run: () => Promise<void>;
}
const pending: PendingJob[] = [];

function enqueue(prId: number, run: () => Promise<void>): boolean {
  if (running.size < MAX_CONCURRENT) {
    void execRun(prId, run);
    return true; // started immediately
  }
  pending.push({ prId, run });
  return false; // queued
}

async function execRun(prId: number, run: () => Promise<void>): Promise<void> {
  running.add(prId);
  try {
    await run();
  } catch {
    /* every job body handles its own errors; this is only a backstop */
  } finally {
    running.delete(prId);
    pump();
  }
}

function pump(): void {
  while (running.size < MAX_CONCURRENT && pending.length > 0) {
    const next = pending.shift();
    if (!next) break;
    void execRun(next.prId, next.run);
  }
}

// ---- fix-generate state ----
const fixIdByPr = new Map<number, number>();
const progressByFix = new Map<number, AiFixProgress>();
const controllers = new Map<number, AbortController>(); // fixId → controller
// PLAN MODE: fixIds whose in-flight job is a PLANNING pass, → whether the row already had a plan
// (a re-plan keeps it when the pass is cancelled or fails; a first pass ends the row).
const planPasses = new Map<number, boolean>();
const fixStreamSubs = new Map<number, Set<(e: AiFixStreamEvent) => void>>();

export function subscribeFixStream(
  prId: number,
  cb: (e: AiFixStreamEvent) => void,
): () => void {
  let set = fixStreamSubs.get(prId);
  if (!set) {
    set = new Set();
    fixStreamSubs.set(prId, set);
  }
  set.add(cb);
  return () => {
    const s = fixStreamSubs.get(prId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) fixStreamSubs.delete(prId);
  };
}

function emitFixStream(prId: number, e: AiFixStreamEvent): void {
  const set = fixStreamSubs.get(prId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(e);
    } catch {
      /* a broken subscriber must not break the run */
    }
  }
}

export type StartFixResult =
  | { status: 'queued'; fixId: number }
  | { status: 'already_running' }
  | { status: 'busy' }
  | { status: 'not_found' }
  | { status: 'no_auth'; message?: string }
  | { status: 'no_head' }
  // seed === 'review': the named review is missing, another PR's / account's, or not succeeded.
  | { status: 'review_unavailable' }
  // seed === 'review': the review has nothing to fix (no non-praise finding, no open earlier
  // finding, no thread needing a fix, no story gap, no fixable CI failure). A refusal, not an
  // empty run — a fixer with no task would burn a paid agent turn and report on nothing.
  | { status: 'nothing_to_fix' }
  // seed === 'plain' with a blank instruction.
  | { status: 'no_instruction' };

export interface StartFixInput {
  accountId: number;
  prId: number;
  model: string;
  seed: AiFixSeed;
  // seed === 'review': the Claude review to fix from. The seed is built from the STORED run.
  sourceReviewId?: number | null;
  // seed === 'plain': the reader's instruction.
  instruction?: string;
  // Who started it. Omitted ⇒ 'manual'.
  trigger?: AiFixTrigger;
  // seed === 'review': which items. Absent ⇒ the section defaults (every section but style bots).
  selection?: SeedSelection;
  // THE PER-RUN CHOICE (a manual start's picker, validated by the route). Absent ⇒ the default
  // provider (Settings → AI) — always so for an automatic fix.
  provider?: AgentProviderId;
}

/** The stored review a seed names, checked to be THIS PR's succeeded run. null otherwise. */
async function loadSourceReview(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  reviewId: number | null | undefined,
): Promise<ClaudeReview | null> {
  if (reviewId == null) return null;
  const review = await getClaudeReviewById(ctx, reviewId, accountId);
  if (!review || review.prId !== prId || review.status !== 'succeeded') return null;
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

/** How long opening / starting a fix waits for a SonarCloud read of the current head. */
const SONAR_FRESHEN_WAIT_MS = 8_000;

/** Everything a seed is built from besides the review. Each read fails soft (costs its items only). */
async function loadSeedInputs(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  withTicketItems: boolean,
) {
  const [ticketItems, ciItems, threads, sonarIssues] = await Promise.all([
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
  ]);
  return { ticketItems, ciItems, threads, sonarIssues };
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
 * The fix picker's preview for a MANUAL fix (ticket items included, like the manual start). null
 * when the review is not this PR's succeeded run. Never throws.
 */
export async function loadFixPreview(
  ctx: AgentContext,
  input: { accountId: number; prId: number; reviewId: number },
): Promise<AiFixPickerPreview | null> {
  try {
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
 * `trigger: 'auto'`); the manual "Fix from review" route goes through the same path. Same queue,
 * slot, worktree and guards as every fix; nothing is pushed until a person presses Push — unless
 * the fix is AUTO and its workspace switched "Push automatically" on (auto-push.ts).
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

export async function startFix(
  ctx: AgentContext,
  input: StartFixInput,
): Promise<StartFixResult> {
  return startRun(ctx, input, 'fix');
}

/**
 * PLAN MODE ("Plan first", MANUAL fixes only — `startReviewFix`, the auto path, never calls this):
 * the same seed, claim, slot and guards as `startFix`, but the run is a READ-ONLY planning pass. The
 * row opens as 'planned' / 'planning' and holds its frozen seed, so every re-plan and the build read
 * exactly the items this pass saw. docs/CLAUDE-REVIEW.md § AI Fix "Plan mode".
 */
export async function startPlan(
  ctx: AgentContext,
  input: StartFixInput,
): Promise<StartFixResult> {
  return startRun(ctx, { ...input, trigger: 'manual' }, 'plan');
}

async function startRun(
  ctx: AgentContext,
  input: StartFixInput,
  mode: 'fix' | 'plan',
): Promise<StartFixResult> {
  const { accountId, prId } = input;

  // THE PROVIDER IS PICKED ONCE, HERE: the request's per-run choice, else the default. The prompt is
  // worded for it (ai/prompt-tools.ts) and the queued run is handed the same one, so a prompt never
  // reaches a provider it was not written for.
  const provider: AgentProviderId = input.provider ?? activeProviderId();
  const auth = preflightFor(ctx)(provider, mode);
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };

  // Hard agentic cap: refuse a run once the account's monthly agent credit allowance is spent
  // (metered per calendar month; local accounts are unmetered → never blocked).

  const instruction = (input.instruction ?? '').trim();
  if (input.seed === 'plain' && instruction === '') return { status: 'no_instruction' };

  if (claimed.has(prId)) return { status: 'already_running' };
  if (pending.length >= MAX_QUEUED) return { status: 'busy' };

  // Reserve the PR SYNCHRONOUSLY, in the same tick as the check above and BEFORE any await, so
  // two concurrent starts (a manual click and `maybeStartAutoFix`) can't both pass the guard.
  // ⚠ EVERY bail path below this line releases the claim, or this PR's fixer wedges for the
  // process's lifetime.
  claimed.add(prId);
  try {
    const pr = await getFixPrContext(ctx, accountId, prId);
    if (!pr) {
      claimed.delete(prId);
      return { status: 'not_found' };
    }

    // The review seed is resolved BEFORE GitHub is asked anything: a review with nothing to fix
    // must not spend two GitHub calls on its way to a refusal.
    //
    // ⚠ The rendered prompt is FROZEN HERE, at launch, and the run may start later (one global
    // slot). That is intended: the stored items must describe what the agent was actually given.
    let reviewItems: AiFixReviewItem[] | null = null;
    let sentRefs: string[] = [];
    let seed: FixSeed;
    if (input.seed === 'review') {
      const loaded = await loadReviewSeed(ctx, {
        accountId,
        prId,
        reviewId: input.sourceReviewId,
        withTicketItems: (input.trigger ?? 'manual') === 'manual',
        selection: input.selection,
      });
      if (!loaded) {
        claimed.delete(prId);
        return { status: 'review_unavailable' };
      }
      if (loaded.seed.sentRefs.length === 0) {
        claimed.delete(prId);
        return { status: 'nothing_to_fix' };
      }
      reviewItems = loaded.seed.items;
      sentRefs = loaded.seed.sentRefs;
      seed = { kind: 'review', text: loaded.seed.text };
    } else {
      seed = { kind: 'plain', text: instruction };
    }

    const headInfo = await ctx.github.fetchPrHeadInfo(
      accountId,
      pr.owner,
      pr.name,
      pr.number,
    );
    const baseSha = headInfo.headSha;
    if (!baseSha) {
      claimed.delete(prId);
      return { status: 'no_head' };
    }

    const diff = await ctx.github
      .fetchPrDiff(accountId, pr.owner, pr.name, pr.number)
      .catch(() => '');

    const trigger: AiFixTrigger = input.trigger ?? 'manual';

    if (mode === 'plan') {
      const systemPrompt = buildPlanSystemPrompt(provider);
      const nonce = pickReviewNonce([seed.text, pr.title, pr.body ?? '']);
      const prompt = buildPlanUserPrompt({ pr, diff, seed, nonce, provider });
      const fixId = await insertQueuedFix(ctx, {
        accountId,
        repoId: pr.repoId,
        prId,
        baseSha,
        model: input.model,
        seed: input.seed,
        sourceReviewId: input.seed === 'review' ? (input.sourceReviewId ?? null) : null,
        // The first pass's prompt; "Approve and build" overwrites it with the BUILD's.
        prompt,
        trigger,
        reviewItems,
        planSeed: seed,
        provider,
      });
      fixIdByPr.set(prId, fixId);
      queuePlanPass(ctx, {
        fixId,
        accountId,
        prId,
        owner: pr.owner,
        name: pr.name,
        prNumber: pr.number,
        baseSha,
        model: input.model,
        systemPrompt,
        prompt,
        shownRefs: sentRefs,
        revision: 1,
        maxBudgetUsd: config.aiFixBudgetUsd,
        hadPlan: false,
        provider,
      });
      return { status: 'queued', fixId };
    }

    const systemPrompt = buildFixSystemPrompt(provider);
    const prompt = buildFixUserPrompt({ pr, diff, seed, provider });

    const fixId = await insertQueuedFix(ctx, {
      accountId,
      repoId: pr.repoId,
      prId,
      baseSha,
      model: input.model,
      seed: input.seed,
      sourceReviewId: input.seed === 'review' ? (input.sourceReviewId ?? null) : null,
      prompt,
      trigger,
      reviewItems,
      provider,
    });
    fixIdByPr.set(prId, fixId);

    queueFixJob(ctx, {
      fixId,
      accountId,
      prId,
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      baseSha,
      model: input.model,
      systemPrompt,
      prompt,
      sentRefs,
      trigger,
      provider,
    });
    return { status: 'queued', fixId };
  } catch (err) {
    claimed.delete(prId);
    fixIdByPr.delete(prId);
    ctx.log.warn({ err }, 'ai-fix startFix failed');
    return { status: 'not_found' };
  }
}

/**
 * A follow-up on an open plan (another pass, the build): the provider the plan was made on (its last
 * pass's, else the row's) when that one is signed in and can run the kind, else the default.
 */
function planFollowUpProvider(
  ctx: AgentContext,
  row: { provider?: string | null; model: string; planProvider?: string | null; planModel?: string | null },
  kind: 'plan' | 'fix',
): AgentProviderId {
  const stored = row.planModel != null || row.planProvider != null
    ? aiRunProvider(row.planProvider, row.planModel)
    : aiRunProvider(row.provider, row.model);
  return followUpProvider(stored, kind, preflightFor(ctx));
}

/** What a job runs on: the provider it was worded for and that provider's id for the asked model. */
function ranOnFor(provider: AgentProviderId, model: string, effort?: string): AiRanOn {
  return { provider, model: getProvider(provider).resolveModel(claudeModelChoice(model)), ...(effort ? { effort } : {}) };
}

function queueFixJob(ctx: AgentContext, job: FixJob): void {
  const immediate = enqueue(job.prId, () => launchFix(ctx, job));
  if (!immediate) {
    emitFixStream(job.prId, {
      type: 'progress',
      status: 'queued',
      fixId: job.fixId,
      progress: { phase: 'fetching_diff' },
    });
  }
}

interface FixJob {
  fixId: number;
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  prNumber: number;
  baseSha: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  // The refs the agent was SHOWN — what its report is validated against at save time.
  sentRefs: readonly string[];
  trigger: AiFixTrigger;
  // The provider the prompt was worded for; the run uses the same one.
  provider: AgentProviderId;
}

async function launchFix(ctx: AgentContext, job: FixJob): Promise<void> {
  const controller = new AbortController();
  controllers.set(job.fixId, controller);

  const seed: AiFixProgress = { phase: 'cloning' };
  progressByFix.set(job.fixId, seed);
  emitFixStream(job.prId, {
    type: 'progress',
    status: 'running',
    fixId: job.fixId,
    progress: seed,
  });

  const onProgress = (p: CodingProgress): void => {
    const prog = p as AiFixProgress;
    progressByFix.set(job.fixId, prog);
    emitFixStream(job.prId, {
      type: 'progress',
      status: 'running',
      fixId: job.fixId,
      progress: prog,
    });
  };

  let finalStatus: AiFixStatus = 'failed';
  try {
    await markFixRunning(ctx, job.fixId);
    // What the build runs on (the provider the prompt was worded for, and its model id).
    // ... and at which effort (Settings → AI → Effort, read once here; the run sends this and the
    // row stores it for the label).
    const effort = agenticRunEffort(job.provider, claudeModelChoice(job.model), 'worktree');
    await markFixRanOn(ctx, job.fixId, ranOnFor(job.provider, job.model, effort));
    const result = await ctx.coding.generateFix({
      accountId: job.accountId,
      owner: job.owner,
      name: job.name,
      prNumber: job.prNumber,
      baseSha: job.baseSha,
      model: job.model,
      systemPrompt: job.systemPrompt,
      prompt: job.prompt,
      abortController: controller,
      onProgress,
      prId: job.prId,
      provider: job.provider,
      effort,
    });

    if (result.aborted || controller.signal.aborted) {
      await markFixCancelled(ctx, job.fixId);
      finalStatus = 'cancelled';
    } else {
      emitFixStream(job.prId, {
        type: 'progress',
        status: 'running',
        fixId: job.fixId,
        progress: { phase: 'persisting' },
      });
      await saveFixSuccess(ctx, job.fixId, result, job.sentRefs);
      finalStatus = 'succeeded';
    }
  } catch (err) {
    if (controller.signal.aborted) {
      await markFixCancelled(ctx, job.fixId).catch(() => {});
      finalStatus = 'cancelled';
    } else {
      const m = err instanceof Error ? err.message : String(err);
      await markFixFailed(ctx, job.fixId, m).catch(() => {});
      finalStatus = 'failed';
      ctx.log.warn({ err }, 'ai-fix run failed');
    }
  } finally {
    claimed.delete(job.prId);
    controllers.delete(job.fixId);
    progressByFix.delete(job.fixId);
    fixIdByPr.delete(job.prId);
    emitFixStream(job.prId, {
      type: 'done',
      status: finalStatus,
      fixId: job.fixId,
    });
  }
  // An AUTO fix that succeeded may be pushed automatically (auto-push.ts decides: the workspace's
  // "Push automatically", own PR only, never forced). Off the slot: a push is not a fix run.
  if (finalStatus === 'succeeded' && job.trigger === 'auto') {
    void maybeAutoPushFix(ctx, { accountId: job.accountId, fixId: job.fixId });
  }
}

// ---- PLAN MODE: planning passes, the steering chat, approve and discard ----
// docs/CLAUDE-REVIEW.md § AI Fix "Plan mode". A planning pass is a job like any fix: the SAME
// one-per-PR claim (taken synchronously), the SAME single global slot, the SAME cancel. Between
// passes the claim is released — a plan waiting for the reader holds nothing.

interface PlanJob {
  fixId: number;
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  prNumber: number;
  baseSha: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  shownRefs: readonly string[];
  // The revision this pass will write.
  revision: number;
  // What is left of the plan's budget (config.aiFixBudgetUsd across ALL its passes).
  maxBudgetUsd: number;
  // The row already holds a plan (this is a re-plan).
  hadPlan: boolean;
  // The provider the prompt was worded for; the pass uses the same one.
  provider: AgentProviderId;
}

function queuePlanPass(ctx: AgentContext, job: PlanJob): void {
  planPasses.set(job.fixId, job.hadPlan);
  const immediate = enqueue(job.prId, () => launchPlanPass(ctx, job));
  if (!immediate) {
    emitFixStream(job.prId, {
      type: 'progress',
      status: 'queued',
      fixId: job.fixId,
      progress: { phase: 'planning' },
    });
  }
}

async function launchPlanPass(ctx: AgentContext, job: PlanJob): Promise<void> {
  const controller = new AbortController();
  controllers.set(job.fixId, controller);
  const first: AiFixProgress = { phase: 'cloning' };
  progressByFix.set(job.fixId, first);
  emitFixStream(job.prId, { type: 'progress', status: 'running', fixId: job.fixId, progress: first });

  const onProgress = (p: PlanRunProgress): void => {
    const prog: AiFixProgress = {
      phase: p.phase === 'cloning' ? 'cloning' : 'planning',
      ...(p.recentActivity ? { recentActivity: p.recentActivity } : {}),
      ...(p.usage ? { usage: p.usage } : {}),
    };
    progressByFix.set(job.fixId, prog);
    emitFixStream(job.prId, { type: 'progress', status: 'running', fixId: job.fixId, progress: prog });
  };

  // What the row reads after the pass: a plan to look at, or a run that ended.
  let finalStatus: AiFixStatus = job.hadPlan ? 'planned' : 'failed';
  try {
    // What this planning pass runs on (the provider the prompt was worded for, and its model id).
    const effort = agenticRunEffort(job.provider, claudeModelChoice(job.model), 'worktree');
    await markPlanRanOn(ctx, job.fixId, ranOnFor(job.provider, job.model, effort));
    const result = await ctx.coding.generatePlan({
      accountId: job.accountId,
      owner: job.owner,
      name: job.name,
      prNumber: job.prNumber,
      baseSha: job.baseSha,
      model: job.model,
      systemPrompt: job.systemPrompt,
      prompt: job.prompt,
      shownRefs: job.shownRefs,
      maxBudgetUsd: job.maxBudgetUsd,
      abortController: controller,
      onProgress,
      prId: job.prId,
      provider: job.provider,
      effort,
    });
    const pass = { costUsd: result.costUsd, usage: result.usage, ...(result.usageRecorded ? { usageRecorded: true } : {}) };
    if (result.aborted || controller.signal.aborted) {
      await markPlanPassEnded(ctx, job.fixId, { kind: 'cancelled' }, pass);
      finalStatus = job.hadPlan ? 'planned' : 'cancelled';
    } else if (!result.plan) {
      await markPlanPassEnded(
        ctx,
        job.fixId,
        { kind: 'failed', message: `${providerName(job.provider)} did not hand in a plan. Try again.` },
        pass,
      );
      finalStatus = job.hadPlan ? 'planned' : 'failed';
    } else {
      const plan = normalizePlan(result.plan, job.shownRefs, job.revision);
      // The reply answers a steering message; the first pass has none to answer.
      const reply = job.hadPlan ? planReply(result.plan) : null;
      await savePlanSuccess(ctx, job.fixId, { plan, reply, ...pass });
      finalStatus = 'planned';
    }
  } catch (err) {
    // A pass that threw still billed for the turns it ran (agent.ts attaches them).
    const spent = partialSpendOf(err);
    if (controller.signal.aborted) {
      await markPlanPassEnded(ctx, job.fixId, { kind: 'cancelled' }, spent).catch(() => {});
      finalStatus = job.hadPlan ? 'planned' : 'cancelled';
    } else {
      const m = err instanceof Error ? err.message : String(err);
      await markPlanPassEnded(ctx, job.fixId, { kind: 'failed', message: m }, spent).catch(() => {});
      finalStatus = job.hadPlan ? 'planned' : 'failed';
      ctx.log.warn({ err }, 'ai-fix plan pass failed');
    }
  } finally {
    claimed.delete(job.prId);
    controllers.delete(job.fixId);
    progressByFix.delete(job.fixId);
    fixIdByPr.delete(job.prId);
    planPasses.delete(job.fixId);
    emitFixStream(job.prId, { type: 'done', status: finalStatus, fixId: job.fixId });
  }
}

export type PlanActionResult =
  | { status: 'queued'; fixId: number }
  | { status: 'not_found' }
  // The row is not an open plan in the state this action needs (already approved, discarded, a
  // pass in flight, never a plan).
  | { status: 'not_ready' }
  | { status: 'already_running' }
  | { status: 'busy' }
  | { status: 'no_auth'; message?: string }
  | { status: 'no_head' }
  | { status: 'revision_cap' }
  | { status: 'budget_spent' };

// Below this much budget left, a re-plan is refused rather than started with too little to finish.
const MIN_PLAN_PASS_BUDGET_USD = 0.25;

/**
 * The reader's steering message: appended to the chat, then a FRESH planning pass with the frozen
 * seed + the previous plan (context only) + the whole chat (the reader's messages fenced as their
 * steering, Claude's replies as context). The plan card shows the new revision when it lands.
 */
export async function sendPlanMessage(
  ctx: AgentContext,
  input: { accountId: number; fixId: number; text: string },
): Promise<PlanActionResult> {
  const row = await getFixById(ctx, input.accountId, input.fixId);
  if (!row) return { status: 'not_found' };
  const plan = parsePlan(row.plan);
  const seed = parsePlanSeed(row.planSeed);
  if (row.status !== 'planned' || parsePlanStatus(row.planStatus) !== 'plan_ready' || !plan || !seed)
    return { status: 'not_ready' };
  const revision = row.planRevision ?? plan.revision;
  if (revision >= AI_FIX_PLAN_MAX_REVISIONS) return { status: 'revision_cap' };
  const left = config.aiFixBudgetUsd - (row.planCostUsd ?? 0);
  if (left < MIN_PLAN_PASS_BUDGET_USD) return { status: 'budget_spent' };

  // Another pass of a plan runs on the PLAN's provider when it is signed in, else the default.
  const provider = planFollowUpProvider(ctx, row, 'plan');
  const auth = preflightFor(ctx)(provider, 'plan');
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };

  const prId = row.prId;
  if (claimed.has(prId)) return { status: 'already_running' };
  if (pending.length >= MAX_QUEUED) return { status: 'busy' };
  // Same tick as the check above (no await between them) — see startRun. The row is known, so it
  // is registered as this PR's live job in the SAME tick: a stream snapshot taken while the awaits
  // below run reads 'queued', not the row's persisted 'planned' (which the stream treats as an
  // ending and closes on).
  claimed.add(prId);
  fixIdByPr.set(prId, row.id);
  planPasses.set(row.id, true);
  // Every bail path: drop the claim and tell any stream that opened in the gap (it read 'queued')
  // that nothing is running — the row is still the plan it was.
  const release = (): void => {
    claimed.delete(prId);
    fixIdByPr.delete(prId);
    planPasses.delete(row.id);
    emitFixStream(prId, { type: 'done', status: 'planned', fixId: row.id });
  };
  let appended = false;
  try {
    const pr = await getFixPrContext(ctx, input.accountId, prId);
    if (!pr) {
      release();
      return { status: 'not_found' };
    }
    const message: AiFixPlanMessage = {
      role: 'reader',
      text: input.text,
      revision,
      at: new Date().toISOString(),
    };
    appended = await appendPlanMessage(ctx, row.id, message);
    if (!appended) {
      release();
      return { status: 'not_ready' };
    }
    const transcript = [...parseTranscript(row.planTranscript), message];
    const diff = await ctx.github.fetchPrDiff(input.accountId, pr.owner, pr.name, pr.number).catch(() => '');
    const nonce = pickReviewNonce([
      seed.text,
      pr.title,
      pr.body ?? '',
      renderPlanText(plan),
      ...transcript.map((m) => m.text),
    ]);
    const prompt = buildPlanUserPrompt({ pr, diff, seed, previous: plan, transcript, nonce, provider });
    queuePlanPass(ctx, {
      fixId: row.id,
      accountId: input.accountId,
      prId,
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      // The pass reads the commit the plan was made at.
      baseSha: row.baseSha,
      // The row stores what RAN (a Codex id on Codex): ask again for the same depth.
      model: requestModelOf(row.model),
      systemPrompt: buildPlanSystemPrompt(provider),
      prompt,
      shownRefs: shownRefsOf(parseReviewItems(row.reviewItems)),
      revision: revision + 1,
      maxBudgetUsd: left,
      hadPlan: true,
      provider,
    });
    return { status: 'queued', fixId: row.id };
  } catch (err) {
    // The message reopened the plan; with no pass behind it, put it back so it is not stuck —
    // BEFORE the release's 'done', so the refetch it triggers reads the plan back.
    if (appended)
      await markPlanPassEnded(ctx, row.id, { kind: 'failed', message: 'the request failed' }).catch(() => {});
    release();
    ctx.log.warn({ err }, 'ai-fix plan message failed');
    return { status: 'not_found' };
  }
}

/**
 * "Approve and build": the SAME row becomes a normal fix run whose prompt carries the approved plan
 * as the agreed brief (prompts.ts `buildFixUserPrompt({ plan })`; WORKTREE_RULES unchanged). Built
 * on the PR's head NOW — the plan was read at the head it was made on, and a head that moved since
 * is what a push to the PR branch checks against.
 */
export async function approvePlan(
  ctx: AgentContext,
  input: { accountId: number; fixId: number },
): Promise<PlanActionResult> {
  const row = await getFixById(ctx, input.accountId, input.fixId);
  if (!row) return { status: 'not_found' };
  const plan = parsePlan(row.plan);
  const seed = parsePlanSeed(row.planSeed);
  if (row.status !== 'planned' || parsePlanStatus(row.planStatus) !== 'plan_ready' || !plan || !seed)
    return { status: 'not_ready' };

  // The build of a plan runs on the PLAN's provider when it is signed in, else the default.
  const provider = planFollowUpProvider(ctx, row, 'fix');
  const auth = preflightFor(ctx)(provider, 'fix');
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };

  const prId = row.prId;
  if (claimed.has(prId)) return { status: 'already_running' };
  if (pending.length >= MAX_QUEUED) return { status: 'busy' };
  // Claimed AND registered in one tick (see sendPlanMessage): the two GitHub calls below take
  // seconds, and a snapshot in that gap must read 'queued', not the row's 'planned'.
  claimed.add(prId);
  fixIdByPr.set(prId, row.id);
  const release = (): void => {
    claimed.delete(prId);
    fixIdByPr.delete(prId);
    emitFixStream(prId, { type: 'done', status: 'planned', fixId: row.id });
  };
  try {
    const pr = await getFixPrContext(ctx, input.accountId, prId);
    if (!pr) {
      release();
      return { status: 'not_found' };
    }
    const headInfo = await ctx.github.fetchPrHeadInfo(input.accountId, pr.owner, pr.name, pr.number);
    const baseSha = headInfo.headSha;
    if (!baseSha) {
      release();
      return { status: 'no_head' };
    }
    const diff = await ctx.github.fetchPrDiff(input.accountId, pr.owner, pr.name, pr.number).catch(() => '');
    const planText = renderPlanText(plan);
    const nonce = pickReviewNonce([seed.text, pr.title, pr.body ?? '', planText]);
    const prompt = buildFixUserPrompt({ pr, diff, seed, plan: { plan, nonce }, provider });
    if (!(await markPlanApproved(ctx, row.id, { prompt, baseSha }))) {
      release();
      return { status: 'not_ready' };
    }
    queueFixJob(ctx, {
      fixId: row.id,
      accountId: input.accountId,
      prId,
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      baseSha,
      // The row stores what RAN (a Codex id on Codex): ask again for the same depth.
      model: requestModelOf(row.model),
      systemPrompt: buildFixSystemPrompt(provider),
      prompt,
      sentRefs: shownRefsOf(parseReviewItems(row.reviewItems)),
      trigger: 'manual',
      provider,
    });
    return { status: 'queued', fixId: row.id };
  } catch (err) {
    release();
    ctx.log.warn({ err }, 'ai-fix plan approve failed');
    return { status: 'not_found' };
  }
}

/** "Discard plan": ends a plan waiting for the reader. A pass in flight is cancelled first (Cancel). */
export async function discardPlan(
  ctx: AgentContext,
  input: { accountId: number; fixId: number },
): Promise<'discarded' | 'not_found' | 'not_ready'> {
  const row = await getFixById(ctx, input.accountId, input.fixId);
  if (!row) return 'not_found';
  if (planPasses.has(row.id)) return 'not_ready';
  return (await markPlanDiscarded(ctx, input.accountId, row.id)) ? 'discarded' : 'not_ready';
}

export function requestFixCancel(ctx: AgentContext, prId: number): boolean {
  const fixId = fixIdByPr.get(prId);
  if (fixId != null && running.has(prId)) {
    controllers.get(fixId)?.abort();
    return true;
  }
  const idx = pending.findIndex((j) => j.prId === prId);
  if (idx >= 0 && fixId != null) {
    pending.splice(idx, 1);
    claimed.delete(prId);
    fixIdByPr.delete(prId);
    const hadPlan = planPasses.get(fixId);
    if (hadPlan !== undefined) {
      // A queued PLANNING pass: a re-plan goes back to its ready plan, a first pass ends the row.
      planPasses.delete(fixId);
      void markPlanPassEnded(ctx, fixId, { kind: 'cancelled' }).catch(() => {});
      emitFixStream(prId, { type: 'done', status: hadPlan ? 'planned' : 'cancelled', fixId });
      return true;
    }
    void markFixCancelled(ctx, fixId).catch(() => {});
    emitFixStream(prId, { type: 'done', status: 'cancelled', fixId });
    return true;
  }
  return false;
}

export function isFixRunning(prId: number): boolean {
  return claimed.has(prId);
}

export async function getFixStatus(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<AiFixStatusResponse> {
  // The DB lookup goes FIRST, and it is what establishes ownership.
  //
  // `running` / `claimed` / `fixIdByPr` are process-global Sets and Maps keyed by prId alone,
  // with no notion of who owns the job. Reading them before this query meant a foreign PR with
  // a job in flight returned that job's fixId and live `progress` to whoever asked — another
  // tenant's phase and activity, from a repository the caller cannot see. Every started fix
  // inserts its row (with accountId) BEFORE it runs, so "no row for this account" is a reliable
  // "not yours", and the in-memory maps are consulted only to upgrade a row we already know
  // belongs to the caller into a live status.
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

  // Live in-memory state, but only for a fix id this account actually owns.
  const liveFixId = fixIdByPr.get(prId) ?? null;
  if (liveFixId === row.id) {
    const planning = planPasses.has(row.id);
    if (running.has(prId)) {
      return {
        status: 'running',
        fixId: row.id,
        progress: progressByFix.get(row.id) ?? { phase: planning ? 'planning' : 'cloning' },
      };
    }
    if (claimed.has(prId)) {
      return { status: 'queued', fixId: row.id, progress: { phase: planning ? 'planning' : 'fetching_diff' } };
    }
  }
  return { status: row.status, fixId: row.id, progress: null };
}

export async function reconcileFixesOnStartup(ctx: AgentContext): Promise<void> {
  try {
    const n = await reconcileOrphanedFixes(ctx);
    if (n > 0) ctx.log.info({ n }, 'ai-fix: reconciled orphaned runs on startup');
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: startup reconcile failed');
  }
}
