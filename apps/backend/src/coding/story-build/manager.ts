import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import {
  aiRunProvider,
  isStoryBuildRunning,
  STORY_BUILD_LEDGER_FEATURES,
  STORY_BUILD_MIN_BUDGET_LEFT_USD,
  STORY_BUILD_PLAN_MAX_REVISIONS,
  STORY_BUILD_REPO_RUNNING_STATUSES,
  storyBuildDocsEffectiveDecisions,
  type AiProviderId,
  type ClaudeReviewModel,
  type StoryBuildAcceptRepo,
  type StoryBuildCandidate,
  type StoryBuildMessage,
  type StoryBuildPhase,
  type StoryBuildPlan,
  type StoryBuildProgress,
  type StoryBuildRepoStatus,
  type StoryBuildStatus,
} from '@pierre-review/shared';
import { agenticRunEffort } from '../../ai/effort.js';
import { claudeModelChoice, getProvider, requestModelOf, type AgentProviderId } from '../../ai/provider.js';
import { followUpProvider, preflightFor } from '../../ai/run-choice.js';
import { providerName } from '../../ai/prompt-tools.js';
import type { AgentContext } from '../../review/agent-context.js';
import {
  AGENTIC_AI_ENABLED,
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewLaneWaiting,
  reviewSlotFree,
} from '../../review/claude-review/manager.js';
import { pickReviewNonce } from '../../review/claude-review/prompts.js';
import { pickCandidates } from './candidates.js';
import { checkOutCandidates, type CheckOutFn, type PlanCheckouts } from './checkouts.js';
import { assessCoverage, defaultCoverageSeams, gapRefsOf, type CoverageSeams } from './coverage.js';
import { defaultStoryBuildInputSeams, resolveStoryBuildInputs, seedOf, type StoryBuildInputSeams } from './inputs.js';
import { storyBuildLimits } from './limits.js';
import {
  deleteStoryBuildRepoRowsExcept,
  getStoryBuildRow,
  insertStoryBuild,
  listStoryBuildRepoRows,
  storyBuildRepoNames,
  updateStoryBuild,
  updateStoryBuildRepo,
  upsertStoryBuildRepo,
  type StoryBuildRepoRow,
  type StoryBuildRow,
} from './persist.js';
import {
  acceptedDesignOf,
  DESIGN_NOT_DRAWN,
  isValidBranchName,
  normalizeStoryPlan,
  planReplyOf,
  proposedBranch,
  renderStoryPlanText,
  type StoryPlanContext,
} from './plan.js';
import type { RunStoryPlanAgentArgs, RunStoryPlanAgentResult } from './plan-agent.js';
import { buildStoryPlanSystemPrompt, buildStoryPlanUserPrompt, reposMd, storyPlanUntrustedTexts } from './prompts.js';
import { storyBuildDeps, type RepoBuildResult } from './seams.js';

// THE "IMPLEMENT STORY" SESSION MANAGER (docs/STORY-BUILD.md § State machine). WP1 owns it; it reaches the
// per-repository build + push (WP2) and the docs run (WP3) ONLY through seams.ts `storyBuildDeps()`.
//
//   START     `insertStoryBuild` is THE CLAIM (the partial unique index: one OPEN session per ticket —
//             a second click answers the open one). ⚠ THE STREAM GAP: the in-memory LIVE marker is set
//             in the SAME TICK the claim returns `started`, before any other await, and every bail path
//             emits `done` (CLAUDE-REVIEW.md § Plan mode).
//   PLAN LANE  the READ-ONLY passes (assess + plan, chat re-plans, the docs run) share the ONE review
//             slot pool as a registered PEER: a pass starts only when a slot is free and no PR-review
//             CLICK is waiting. One pass per session at a time.
//   ASSESS    reading_story (inputs, the frozen seed) → checking_coverage (the gap fold; may wait on a
//             ticket check) → picking_repos (candidates) → checking_out (read-only, ledgered
//             'story_plan') → planning (the `story_plan` agent) ⇒ plan_ready, or failed.
//   RE-PLAN   a chat message ⇒ planning (a FRESH pass: seed + previous plan + the whole chat + the docs
//             points in force, at the SAME base shas) ⇒ plan_ready; a failed re-plan keeps the plan.
//             ≤ STORY_BUILD_PLAN_MAX_REVISIONS; refused below $0.25 of the plan (or session) budget.
//   ACCEPT    the plan revision must be the latest (409 PlanMoved); the docs decisions in force are
//             FROZEN (`accepted_docs_json`); included repositories go `queued`, the rest `skipped`.
//   BUILD LANE  ONE build at a time per machine (its own lane — never the review slots, never AI Fix's):
//             each session's included repositories IN PLAN ORDER, sequentially, a later one reading the
//             earlier ones' worktrees (WP2 `buildRepo`). ≥ 1 ready ⇒ `ready`; none ⇒ `failed`.
//   CANCEL    aborts the pass in flight (or drops it from its lane). A first plan ⇒ cancelled; a re-plan
//             ⇒ the plan as it was; a build ⇒ the repositories not built yet go `cancelled`.
//   DISCARD   any state with nothing running ⇒ discarded (the ledger then sweeps the kept trees).
//   RESTART   `reconcileStoryBuildsOnStartup`: a pass a restart cut off never stays "running".
//
// SPEND: every pass asks the SESSION budget (STORY_BUILD_SESSION_BUDGET_USD) and its own cap; a pass is
// refused below STORY_BUILD_MIN_BUDGET_LEFT_USD left. Manual runs: no `automaticRunAllowed` gate (the SPA
// asks before the click). The ledger: Claude's rows are written here (or by WP2's runner for a build —
// see `recordBuildUsage`); a Codex run writes its own (`ledgerByProvider`).

export const RESTART_LINE = 'Stopped when Limn restarted.';
export const NO_STORY_LINE = 'There is no story text or criteria to build from.';
export const NO_REPOS_LINE = 'No repository in this workspace to build in.';
export const NO_CHECKOUT_LINE = "Couldn't check out any repository.";
const PLAN_LANE_MAX = 10;
const BUILD_QUEUE_MAX = 10;

// ---- seams ------------------------------------------------------------------------------------------------

export interface StoryBuildManagerSeams {
  inputs?: StoryBuildInputSeams;
  coverage?: CoverageSeams;
  checkOut?: CheckOutFn;
  runPlanAgent?: (args: RunStoryPlanAgentArgs) => Promise<RunStoryPlanAgentResult>;
  /** The docs library a plan may read: its folder when usable, else null. */
  library?: (accountId: number, workspaceId: number) => Promise<string | null>;
}

let seams: StoryBuildManagerSeams = {};
/** Tests only: replace the model, git and DB-side sources (null restores the real ones). */
export function _setStoryBuildSeamsForTest(s: StoryBuildManagerSeams | null): void {
  seams = s ?? {};
}

/** The story a start would build from (the route's NoStory check; the manager's own seams). */
export function storyBuildInputsFor(ctx: AgentContext, accountId: number, workspaceId: number, ident: string) {
  return resolveStoryBuildInputs(ctx, accountId, workspaceId, ident, seams.inputs ?? defaultStoryBuildInputSeams);
}

// ---- live state -------------------------------------------------------------------------------------------

type PassKind = 'assess' | 'replan' | 'docs' | 'build';

interface Live {
  accountId: number;
  kind: PassKind;
  controller: AbortController;
  progress: StoryBuildProgress | null;
  /** In its lane, not started yet. */
  queued: boolean;
  cancelled: boolean;
}

/** A frame of the session's SSE stream: progress, or the end of the pass. */
export type StoryBuildStreamEvent = { type: 'progress'; progress: StoryBuildProgress } | { type: 'done' };

const live = new Map<number, Live>();
const subs = new Map<number, Set<(e: StoryBuildStreamEvent) => void>>();

export function subscribeStoryBuild(buildId: number, fn: (e: StoryBuildStreamEvent) => void): () => void {
  const set = subs.get(buildId) ?? new Set();
  set.add(fn);
  subs.set(buildId, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) subs.delete(buildId);
  };
}

function emit(buildId: number, e: StoryBuildStreamEvent): void {
  for (const fn of [...(subs.get(buildId) ?? [])]) {
    try {
      fn(e);
    } catch {
      /* a subscriber's error never reaches the pass */
    }
  }
}

function progress(buildId: number, p: StoryBuildProgress): void {
  const l = live.get(buildId);
  if (l) l.progress = p;
  emit(buildId, { type: 'progress', progress: p });
}

/** Is a pass of this session queued or running in this process? */
export function isStoryBuildLive(buildId: number): boolean {
  return live.has(buildId);
}

/** The latest progress of the pass in flight, or null. */
export function storyBuildLiveProgress(buildId: number): StoryBuildProgress | null {
  return live.get(buildId)?.progress ?? null;
}

function endPass(buildId: number): void {
  live.delete(buildId);
  emit(buildId, { type: 'done' });
}

// ---- spend ------------------------------------------------------------------------------------------------

const num = (x: number | null | undefined): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** US$ the session has spent: plan passes + docs + every repository. */
export function sessionSpent(row: Pick<StoryBuildRow, 'planCostUsd' | 'docsCostUsd'>, repos: ReadonlyArray<Pick<StoryBuildRepoRow, 'costUsd'>>): number {
  return num(row.planCostUsd) + num(row.docsCostUsd) + repos.reduce((s, r) => s + num(r.costUsd), 0);
}

async function budgets(ctx: AgentContext, row: StoryBuildRow): Promise<{ sessionLeft: number; planLeft: number }> {
  const limits = storyBuildLimits();
  const repos = await listStoryBuildRepoRows(ctx, row.accountId, row.id);
  const sessionLeft = limits.sessionBudgetUsd - sessionSpent(row, repos);
  return { sessionLeft, planLeft: Math.min(sessionLeft, limits.planBudgetUsd - num(row.planCostUsd)) };
}

function storedProvider(row: Pick<StoryBuildRow, 'provider' | 'model'>): AiProviderId {
  return aiRunProvider(row.provider, row.model);
}

/** What a pass runs on: the provider and its model id for the asked Claude model. */
function ranOnModel(provider: AgentProviderId, model: string): string {
  return getProvider(provider).resolveModel(claudeModelChoice(model));
}

// ---- the plan lane (read-only passes; a review-slot peer) -----------------------------------------------

interface PlanJob {
  ctx: AgentContext;
  buildId: number;
  run(controller: AbortController): Promise<void>;
  /** The lane dropped it before it started (a cancel): put the row back as the pass found it. */
  dropped(): Promise<void>;
  /** The pass threw past its own handling: never leave the row "running". */
  crashed(): Promise<void>;
}

const planLane: PlanJob[] = [];
const planRunning = new Set<number>();
registerReviewSlotPeer({ inFlight: () => planRunning.size, pump: () => pumpPlan() });

function pumpPlan(): void {
  while (planLane.length > 0 && reviewSlotFree() && !reviewLaneWaiting().manual) launchPlan(planLane.shift()!);
}

function queuePlanJob(job: PlanJob): void {
  planLane.push(job);
  pumpPlan();
}

function launchPlan(job: PlanJob): void {
  const l = live.get(job.buildId);
  if (l == null) return;
  l.queued = false;
  planRunning.add(job.buildId);
  void job
    .run(l.controller)
    .catch(async (err) => {
      job.ctx.log.warn({ err }, `story build ${job.buildId}: pass failed`);
      await job.crashed().catch(() => {});
    })
    .finally(() => {
      planRunning.delete(job.buildId);
      endPass(job.buildId);
      pumpPlan();
      pumpReviewLane();
    });
}

// ---- start --------------------------------------------------------------------------------------------------

export interface StartStoryBuildArgs {
  accountId: number;
  workspaceId: number;
  /** The workspace's repositories (`resolveWorkspaceScope`): the candidates come from these. */
  memberRepoIds: readonly number[];
  ident: string;
  ticketKey: string;
  ticketTitle: string | null;
  /** The manual run choice (`resolveManualRunChoice(kind 'story_plan')`). */
  provider: AiProviderId;
  model: ClaudeReviewModel;
  wantDiagram: boolean;
  wantDocs: boolean;
}

export type StartStoryBuildResult =
  | { outcome: 'started'; id: number }
  | { outcome: 'already_open'; id: number }
  | { outcome: 'busy' }
  | { outcome: 'disabled' };

export async function startStoryBuild(ctx: AgentContext, a: StartStoryBuildArgs): Promise<StartStoryBuildResult> {
  if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
  if (planLane.length >= PLAN_LANE_MAX) return { outcome: 'busy' };
  const claim = await insertStoryBuild(ctx, {
    accountId: a.accountId,
    workspaceId: a.workspaceId,
    ident: a.ident,
    ticketKey: a.ticketKey,
    ticketTitle: a.ticketTitle,
    wantDiagram: a.wantDiagram,
    wantDocs: a.wantDocs,
    provider: a.provider,
    model: ranOnModel(a.provider, a.model),
  });
  if (claim.outcome === 'already_open') return claim;
  const id = claim.id;
  // ⚠ THE STREAM GAP: the live marker in the SAME tick as the claim, before any other await.
  live.set(id, { accountId: a.accountId, kind: 'assess', controller: new AbortController(), progress: { phase: 'reading_story' }, queued: true, cancelled: false });
  queuePlanJob({
    ctx,
    buildId: id,
    run: (controller) => runAssess(ctx, a, id, controller),
    dropped: async () => {
      await updateStoryBuild(ctx, a.accountId, id, { status: 'cancelled', phase: null, completedAt: new Date() });
    },
    crashed: () => fail(ctx, a.accountId, id, 'The plan failed. Start again.'),
  });
  return { outcome: 'started', id };
}

async function setPhase(ctx: AgentContext, accountId: number, buildId: number, phase: StoryBuildPhase, extra: Partial<StoryBuildRow> = {}): Promise<void> {
  progress(buildId, { phase });
  await updateStoryBuild(ctx, accountId, buildId, { phase, ...extra });
}

async function fail(ctx: AgentContext, accountId: number, buildId: number, error: string, extra: Partial<StoryBuildRow> = {}): Promise<void> {
  await updateStoryBuild(ctx, accountId, buildId, { status: 'failed', phase: null, error, completedAt: new Date(), ...extra });
}

async function runAssess(ctx: AgentContext, a: StartStoryBuildArgs, buildId: number, controller: AbortController): Promise<void> {
  const { accountId, workspaceId } = a;
  const cancelled = (): boolean => controller.signal.aborted;
  const stop = async (): Promise<void> => {
    await updateStoryBuild(ctx, accountId, buildId, { status: 'cancelled', phase: null, completedAt: new Date() });
  };
  try {
    await setPhase(ctx, accountId, buildId, 'reading_story');
    const inputs = await resolveStoryBuildInputs(ctx, accountId, workspaceId, a.ident, seams.inputs ?? defaultStoryBuildInputSeams);
    if (cancelled()) return stop();
    if (inputs == null || inputs.empty) return fail(ctx, accountId, buildId, NO_STORY_LINE);
    const seed = await seedOf(inputs);
    await updateStoryBuild(ctx, accountId, buildId, {
      ticketTitle: inputs.title ?? a.ticketTitle,
      storyHash: inputs.storyHash,
      criteriaSource: inputs.criteriaSource,
      criteriaJson: inputs.criteria,
      seedJson: seed,
    });

    await setPhase(ctx, accountId, buildId, 'checking_coverage');
    let coverage;
    try {
      coverage = await assessCoverage(
        ctx,
        {
          accountId,
          workspaceId,
          ident: a.ident,
          ticketKey: inputs.ticketKey,
          ticketTitle: inputs.title,
          criteria: inputs.criteria,
          prs: inputs.ticketPrs,
          signal: controller.signal,
        },
        seams.coverage ?? defaultCoverageSeams,
      );
    } catch (err) {
      if (cancelled()) return stop();
      throw err;
    }
    if (cancelled()) return stop();
    await updateStoryBuild(ctx, accountId, buildId, { coverageJson: coverage });

    await setPhase(ctx, accountId, buildId, 'picking_repos');
    const picked = await pickCandidates(ctx, {
      accountId,
      workspaceId,
      memberRepoIds: a.memberRepoIds,
      story: { key: seed.story.key, title: seed.story.title, text: seed.story.text },
      prs: inputs.ticketPrs,
    });
    await updateStoryBuild(ctx, accountId, buildId, { planCostUsd: picked.costUsd > 0 ? picked.costUsd : null });
    if (cancelled()) return stop();
    if (picked.candidates.length === 0) return fail(ctx, accountId, buildId, NO_REPOS_LINE);
    await updateStoryBuild(ctx, accountId, buildId, { candidatesJson: picked.candidates });

    const row = await getStoryBuildRow(ctx, accountId, buildId);
    if (row == null) return;
    await runPlanPass(ctx, row, { controller, revision: 1, previous: null, transcript: [], provider: a.provider, model: a.model });
  } catch (err) {
    ctx.log.warn({ err }, `story build ${buildId}: assess failed`);
    if (cancelled()) return stop();
    await fail(ctx, accountId, buildId, 'The plan failed. Start again.').catch(() => {});
  }
}

interface PlanPassOpts {
  controller: AbortController;
  revision: number;
  previous: StoryBuildPlan | null;
  transcript: StoryBuildMessage[];
  provider: AgentProviderId;
  /** The Claude model of the asked depth (`requestModelOf` on a follow-up). */
  model: ClaudeReviewModel;
}

/**
 * ONE plan pass (the first, or a re-plan): check the candidates out at their bases, run `story_plan`,
 * store the plan (or, on a re-plan that fails, keep the previous one). Settles the row's status itself.
 */
async function runPlanPass(ctx: AgentContext, row: StoryBuildRow, o: PlanPassOpts): Promise<void> {
  const { accountId, id: buildId } = row;
  const first = o.previous == null;
  const deps = storyBuildDeps();
  const limits = storyBuildLimits();
  const settleFailure = async (message: string, spent: Partial<StoryBuildRow> = {}): Promise<void> => {
    if (first) await fail(ctx, accountId, buildId, message, spent);
    else await updateStoryBuild(ctx, accountId, buildId, { status: 'plan_ready', phase: null, error: message, ...spent });
  };
  const settleCancel = async (spent: Partial<StoryBuildRow> = {}): Promise<void> => {
    if (first) await updateStoryBuild(ctx, accountId, buildId, { status: 'cancelled', phase: null, completedAt: new Date(), ...spent });
    else await updateStoryBuild(ctx, accountId, buildId, { status: 'plan_ready', phase: null, error: null, ...spent });
  };
  const seed = row.seedJson;
  const coverage = row.coverageJson;
  const candidates = row.candidatesJson ?? [];
  if (seed == null || coverage == null || candidates.length === 0) return settleFailure('The plan failed. Start again.');

  await setPhase(ctx, accountId, buildId, 'checking_out');
  const checkOut = seams.checkOut ?? checkOutCandidates;
  let co: PlanCheckouts;
  try {
    co = await checkOut({ accountId, buildId, ident: row.ident, candidates });
  } catch (err) {
    ctx.log.warn({ err }, `story build ${buildId}: checkout failed`);
    return o.controller.signal.aborted ? settleCancel() : settleFailure(NO_CHECKOUT_LINE);
  }
  let scratch: string | null = null;
  try {
    if (o.controller.signal.aborted) return settleCancel();
    // The first pass fixes each default-branch base at the commit it found; a candidate that could not
    // be checked out has no base and cannot change.
    const based: StoryBuildCandidate[] = co.checkouts.map((c) => ({ ...c.candidate, baseSha: c.candidate.baseSha !== '' ? c.candidate.baseSha : (c.sha ?? '') }));
    if (first) await updateStoryBuild(ctx, accountId, buildId, { candidatesJson: based });
    const rows = co.checkouts.map((c, i) => ({ candidate: based[i]!, path: c.path }));
    const readable = rows.filter((r) => r.path != null && r.candidate.baseSha !== '');
    if (readable.length === 0) return settleFailure(NO_CHECKOUT_LINE);

    scratch = mkdtempSync(join(tmpdir(), 'limn-storyplan-'));
    writeFileSync(join(scratch, 'REPOS.md'), reposMd(rows));
    const library = await (seams.library ?? defaultLibrary)(accountId, row.workspaceId).catch(() => null);
    const context: StoryPlanContext = {
      candidates: readable.map((r) => ({ ref: r.candidate.ref, repoId: r.candidate.repoId })),
      gapRefs: gapRefsOf(coverage),
      wantDiagram: row.wantDiagram,
    };
    const nonce = pickReviewNonce([
      ...storyPlanUntrustedTexts({ seed, coverage, previous: o.previous, transcript: o.transcript, extra: candidates.map((c) => c.fullName) }),
      row.docsJson != null ? JSON.stringify(row.docsJson) : '',
    ]);
    const docs = row.docsJson != null ? deps.docsBlocksFor(row, { nonce, frozen: false }) : null;
    const effort = agenticRunEffort(o.provider, claudeModelChoice(o.model), 'worktree');
    const { planLeft } = await budgets(ctx, row);
    if (planLeft < STORY_BUILD_MIN_BUDGET_LEFT_USD) return settleFailure('The plan budget is spent.');
    await setPhase(ctx, accountId, buildId, 'planning', { provider: o.provider, model: ranOnModel(o.provider, o.model), effort });
    const run = seams.runPlanAgent ?? (await import('./plan-agent.js')).runStoryPlanAgent;
    const res = await run({
      accountId,
      cwd: scratch,
      readRoots: [scratch, ...readable.map((r) => r.path!), ...(library != null ? [library] : [])],
      systemPrompt: buildStoryPlanSystemPrompt(o.provider),
      prompt: buildStoryPlanUserPrompt({ seed, coverage, checkouts: rows, previous: o.previous, transcript: o.transcript, docs, wantDiagram: row.wantDiagram, nonce, provider: o.provider }),
      context,
      model: o.model,
      provider: o.provider,
      effort,
      maxBudgetUsd: planLeft,
      maxTurns: limits.planMaxTurns,
      abortController: o.controller,
      onProgress: (p) => progress(buildId, p),
      usageRecord: { accountId, seam: 'agent', feature: STORY_BUILD_LEDGER_FEATURES.plan },
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
    });
    if (!res.ledgerByProvider && res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'agent',
          feature: STORY_BUILD_LEDGER_FEATURES.plan,
          model: res.model,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens ?? null,
          outputTokens: res.outputTokens ?? null,
        })
        .catch((err) => ctx.log.warn({ err }, 'story build: usage record failed'));
    }
    const fresh = (await getStoryBuildRow(ctx, accountId, buildId)) ?? row;
    const spent: Partial<StoryBuildRow> = {
      planCostUsd: num(fresh.planCostUsd) + num(res.costUsd) || null,
      inputTokens: num(fresh.inputTokens) + num(res.inputTokens) || null,
      outputTokens: num(fresh.outputTokens) + num(res.outputTokens) || null,
      numTurns: res.numTurns ?? fresh.numTurns ?? null,
      model: res.model,
    };
    if (res.aborted || o.controller.signal.aborted) return settleCancel(spent);
    if (res.plan == null) {
      if (res.failureReason) ctx.log.warn(`story build ${buildId}: ${res.failureReason}`);
      return settleFailure(
        first ? `${providerName(o.provider)} did not hand in a plan. Start again.` : `${providerName(o.provider)} did not hand in a new plan; this is the previous one.`,
        spent,
      );
    }
    const plan = normalizeStoryPlan(res.plan, context, o.revision);
    const design = acceptedDesignOf(res.plan, context);
    const reply = o.transcript.some((m) => m.role === 'reader') ? planReplyOf(res.plan) : null;
    const transcript: StoryBuildMessage[] = reply != null ? [...o.transcript, { role: 'claude', text: reply, revision: o.revision, at: new Date().toISOString() }] : o.transcript;
    await syncRepoRows(ctx, fresh, plan, based);
    await updateStoryBuild(ctx, accountId, buildId, {
      ...spent,
      status: 'plan_ready',
      phase: null,
      error: row.wantDiagram && (res.designDropped || design == null) ? DESIGN_NOT_DRAWN : null,
      planJson: plan,
      planRevision: o.revision,
      designJson: row.wantDiagram ? design : null,
      transcriptJson: transcript,
    });
    // "Check against docs" asked for at Start: weigh the first plan (WP3's run, the same lane).
    if (first && row.wantDocs) queueDocsAfterPlan(ctx, accountId, buildId);
  } catch (err) {
    ctx.log.warn({ err }, `story build ${buildId}: plan pass failed`);
    if (o.controller.signal.aborted) return settleCancel();
    await settleFailure(first ? 'The plan failed. Start again.' : 'The re-plan failed; this is the previous plan.').catch(() => {});
  } finally {
    await co.cleanup().catch(() => {});
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
  }
}

async function defaultLibrary(accountId: number, workspaceId: number): Promise<string | null> {
  const { docsContextFor } = await import('../../reference-docs/context.js');
  const c = await docsContextFor(accountId, workspaceId);
  return c.usable ? c.dir : null;
}

/** The plan's repositories as rows (status `planned`, build order, the proposed branch); others deleted. */
async function syncRepoRows(ctx: AgentContext, row: StoryBuildRow, plan: StoryBuildPlan, candidates: readonly StoryBuildCandidate[]): Promise<void> {
  const byRepo = new Map(candidates.map((c) => [c.repoId, c]));
  await deleteStoryBuildRepoRowsExcept(ctx, row.accountId, row.id, plan.repos.map((r) => r.repoId));
  for (const [i, r] of plan.repos.entries()) {
    const c = byRepo.get(r.repoId);
    if (c == null) continue;
    await upsertStoryBuildRepo(ctx, {
      accountId: row.accountId,
      buildId: row.id,
      repoId: r.repoId,
      ref: r.ref,
      buildOrder: i,
      include: true,
      status: 'planned',
      baseRef: c.baseRef,
      baseSha: c.baseSha,
      stackedOnPrId: c.stackedOnPrId,
      branch: proposedBranch(row.ticketKey, r.branchSlug),
    });
  }
}

// ---- chat re-plan -----------------------------------------------------------------------------------------

export type StoryBuildActionResult =
  | { status: 'queued'; id: number }
  | { status: 'not_found' }
  | { status: 'not_ready' }
  | { status: 'busy' }
  | { status: 'no_auth'; message?: string }
  | { status: 'revision_cap' }
  | { status: 'plan_budget_spent' }
  | { status: 'session_budget_spent' }
  | { status: 'plan_moved' }
  | { status: 'bad_request'; message: string };

export async function sendStoryPlanMessage(
  ctx: AgentContext,
  input: { accountId: number; buildId: number; text: string },
): Promise<StoryBuildActionResult> {
  const row = await getStoryBuildRow(ctx, input.accountId, input.buildId);
  if (row == null) return { status: 'not_found' };
  if (row.status !== 'plan_ready' || row.planJson == null || live.has(row.id)) return { status: 'not_ready' };
  if (row.planRevision - 1 >= STORY_BUILD_PLAN_MAX_REVISIONS) return { status: 'revision_cap' };
  const { sessionLeft, planLeft } = await budgets(ctx, row);
  if (sessionLeft < STORY_BUILD_MIN_BUDGET_LEFT_USD) return { status: 'session_budget_spent' };
  if (planLeft < STORY_BUILD_MIN_BUDGET_LEFT_USD) return { status: 'plan_budget_spent' };
  if (planLane.length >= PLAN_LANE_MAX) return { status: 'busy' };
  // Another pass of a plan runs on the session's provider when it is signed in, else the default.
  const provider = followUpProvider(storedProvider(row), 'story_plan', preflightFor(ctx));
  const auth = preflightFor(ctx)(provider, 'story_plan');
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };
  if (live.has(row.id)) return { status: 'not_ready' };
  // ⚠ THE STREAM GAP: the live marker before the next await.
  live.set(row.id, { accountId: input.accountId, kind: 'replan', controller: new AbortController(), progress: { phase: 'planning' }, queued: true, cancelled: false });
  try {
    const message: StoryBuildMessage = { role: 'reader', text: input.text, revision: row.planRevision, at: new Date().toISOString() };
    const transcript = [...(row.transcriptJson ?? []), message];
    await updateStoryBuild(ctx, input.accountId, row.id, { status: 'planning', phase: 'planning', error: null, transcriptJson: transcript });
    const previous = row.planJson;
    queuePlanJob({
      ctx,
      buildId: row.id,
      run: async (controller) => {
        const fresh = await getStoryBuildRow(ctx, input.accountId, row.id);
        if (fresh == null) return;
        await runPlanPass(ctx, fresh, {
          controller,
          revision: row.planRevision + 1,
          previous,
          transcript,
          provider,
          model: requestModelOf(row.model ?? 'claude-opus-5-5') as ClaudeReviewModel,
        });
      },
      dropped: async () => {
        await updateStoryBuild(ctx, input.accountId, row.id, { status: 'plan_ready', phase: null });
      },
      crashed: async () => {
        await updateStoryBuild(ctx, input.accountId, row.id, { status: 'plan_ready', phase: null, error: 'The re-plan failed; this is the previous plan.' });
      },
    });
    return { status: 'queued', id: row.id };
  } catch (err) {
    ctx.log.warn({ err }, 'story build: plan message failed');
    await updateStoryBuild(ctx, input.accountId, row.id, { status: 'plan_ready', phase: null }).catch(() => {});
    endPass(row.id);
    return { status: 'not_found' };
  }
}

// ---- docs (WP3's run, through the seam; the same read-only lane) ----------------------------------------

function queueDocsAfterPlan(ctx: AgentContext, accountId: number, buildId: number): void {
  void startStoryBuildDocs(ctx, { accountId, buildId, force: false, afterPlan: true }).catch((err) =>
    ctx.log.warn({ err }, `story build ${buildId}: docs run not started`),
  );
}

/**
 * Weigh the plan against the workspace docs (WP3 `runBuildDocs`, which writes docs_status / docs_json /
 * docs_cost_usd). For WP3's `POST …/docs` route and for "Check against docs" ticked at Start. A plan must
 * be ready and nothing running. A throw from the run is recorded as `refused` with its sentence.
 */
export async function startStoryBuildDocs(
  ctx: AgentContext,
  input: { accountId: number; buildId: number; force: boolean; afterPlan?: boolean },
): Promise<StoryBuildActionResult> {
  const row = await getStoryBuildRow(ctx, input.accountId, input.buildId);
  if (row == null) return { status: 'not_found' };
  // Right after the first plan the plan pass is still ending (its live marker clears a tick later).
  const busy = live.has(row.id) && !(input.afterPlan && live.get(row.id)?.kind === 'assess');
  if (row.status !== 'plan_ready' || row.planJson == null || busy || row.docsStatus === 'running') return { status: 'not_ready' };
  const { sessionLeft } = await budgets(ctx, row);
  if (sessionLeft < STORY_BUILD_MIN_BUDGET_LEFT_USD) return { status: 'session_budget_spent' };
  if (planLane.length >= PLAN_LANE_MAX) return { status: 'busy' };
  const start = (): void => {
    live.set(row.id, { accountId: input.accountId, kind: 'docs', controller: new AbortController(), progress: { phase: 'docs_shortlisting' }, queued: true, cancelled: false });
    queuePlanJob({
      ctx,
      buildId: row.id,
      run: async (controller) => {
        await updateStoryBuild(ctx, input.accountId, row.id, { docsStatus: 'running', docsError: null, phase: 'docs_shortlisting' });
        try {
          await storyBuildDeps().runBuildDocs(ctx, {
            accountId: input.accountId,
            buildId: row.id,
            force: input.force,
            onProgress: (p) => progress(row.id, p),
            signal: controller.signal,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await updateStoryBuild(ctx, input.accountId, row.id, { docsStatus: 'refused', docsError: message.slice(0, 300) });
        }
        const after = await getStoryBuildRow(ctx, input.accountId, row.id);
        if (after?.docsStatus === 'running') {
          await updateStoryBuild(ctx, input.accountId, row.id, {
            docsStatus: controller.signal.aborted ? 'none' : 'failed',
            docsError: controller.signal.aborted ? null : 'The docs check did not finish.',
          });
        }
        await updateStoryBuild(ctx, input.accountId, row.id, { phase: null });
      },
      dropped: async () => {},
      crashed: async () => {
        await updateStoryBuild(ctx, input.accountId, row.id, { docsStatus: 'failed', docsError: 'The docs check did not finish.', phase: null });
      },
    });
  };
  if (input.afterPlan && live.has(row.id)) {
    // Wait for the plan pass's own `done` before taking the session's one pass.
    const unsub = subscribeStoryBuild(row.id, (e) => {
      if (e.type !== 'done') return;
      unsub();
      setImmediate(() => {
        if (!live.has(row.id)) start();
      });
    });
    return { status: 'queued', id: row.id };
  }
  start();
  return { status: 'queued', id: row.id };
}

// ---- accept + the build lane --------------------------------------------------------------------------

const MAX_CHECKS = 20;
const CHECK_NAME_MAX = 100;

export async function acceptStoryPlan(
  ctx: AgentContext,
  input: { accountId: number; buildId: number; planRevision: number; repos: readonly StoryBuildAcceptRepo[] },
): Promise<StoryBuildActionResult> {
  const row = await getStoryBuildRow(ctx, input.accountId, input.buildId);
  if (row == null) return { status: 'not_found' };
  if (row.status !== 'plan_ready' || row.planJson == null || live.has(row.id)) return { status: 'not_ready' };
  if (input.planRevision !== row.planRevision) return { status: 'plan_moved' };
  const planRepoIds = new Set(row.planJson.repos.map((r) => r.repoId));
  const asked = new Map<number, StoryBuildAcceptRepo>();
  for (const r of input.repos) {
    if (!planRepoIds.has(r.repoId)) return { status: 'bad_request', message: 'A repository is not in the plan. Reload the page.' };
    if (asked.has(r.repoId)) return { status: 'bad_request', message: 'A repository is listed twice.' };
    if (r.include && !isValidBranchName(r.branch)) return { status: 'bad_request', message: `"${r.branch.slice(0, 60)}" is not a branch name git accepts.` };
    if (r.checks.length > MAX_CHECKS || r.checks.some((c) => c.length === 0 || c.length > CHECK_NAME_MAX)) {
      return { status: 'bad_request', message: 'Pick the checks to run again.' };
    }
    asked.set(r.repoId, r);
  }
  const repoRows = await listStoryBuildRepoRows(ctx, input.accountId, row.id);
  const included = repoRows.filter((r) => asked.get(r.repoId)?.include ?? true);
  if (included.length === 0) return { status: 'bad_request', message: 'Include at least one repository.' };
  const { sessionLeft } = await budgets(ctx, row);
  if (sessionLeft < STORY_BUILD_MIN_BUDGET_LEFT_USD) return { status: 'session_budget_spent' };
  if (buildQueue.length >= BUILD_QUEUE_MAX) return { status: 'busy' };
  const provider = followUpProvider(storedProvider(row), 'story_build', preflightFor(ctx));
  const auth = preflightFor(ctx)(provider, 'story_build');
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };
  if (live.has(row.id)) return { status: 'not_ready' };
  // ⚠ THE STREAM GAP: the live marker before the next await.
  live.set(row.id, { accountId: input.accountId, kind: 'build', controller: new AbortController(), progress: { phase: 'preparing' }, queued: true, cancelled: false });
  try {
    for (const r of repoRows) {
      const want = asked.get(r.repoId);
      const include = want?.include ?? true;
      await updateStoryBuildRepo(ctx, input.accountId, r.id, {
        include,
        status: include ? 'queued' : 'skipped',
        ...(want ? { branch: include ? want.branch : r.branch, checksWantedJson: [...new Set(want.checks)] } : {}),
        error: null,
      });
    }
    await updateStoryBuild(ctx, input.accountId, row.id, {
      status: 'building',
      phase: 'preparing',
      error: null,
      acceptedRevision: row.planRevision,
      acceptedDocsJson: storyBuildDocsEffectiveDecisions(row.docsJson ?? null, row.docsDecisionsJson ?? null),
    });
    enqueueBuild(ctx, input.accountId, row.id);
    return { status: 'queued', id: row.id };
  } catch (err) {
    ctx.log.warn({ err }, 'story build: accept failed');
    endPass(row.id);
    return { status: 'not_found' };
  }
}

/**
 * Re-build ONE repository (WP2's `POST …/repos/:repoId/retry`): the session must be settled (nothing
 * running) and the repository included and not pushed. It goes `queued`; the session `building`.
 */
export async function retryStoryBuildRepo(
  ctx: AgentContext,
  input: { accountId: number; buildId: number; repoId: number },
): Promise<StoryBuildActionResult> {
  const row = await getStoryBuildRow(ctx, input.accountId, input.buildId);
  if (row == null) return { status: 'not_found' };
  const repos = await listStoryBuildRepoRows(ctx, input.accountId, row.id);
  const repo = repos.find((r) => r.repoId === input.repoId);
  if (repo == null) return { status: 'not_found' };
  const settled: StoryBuildStatus[] = ['ready', 'failed', 'cancelled'];
  const retryable: StoryBuildRepoStatus[] = ['ready', 'failed', 'cancelled'];
  if (!settled.includes(row.status) || row.acceptedRevision == null || live.has(row.id)) return { status: 'not_ready' };
  if (!repo.include || !retryable.includes(repo.status)) return { status: 'not_ready' };
  const limits = storyBuildLimits();
  if (limits.sessionBudgetUsd - sessionSpent(row, repos) < STORY_BUILD_MIN_BUDGET_LEFT_USD) return { status: 'session_budget_spent' };
  if (buildQueue.length >= BUILD_QUEUE_MAX) return { status: 'busy' };
  const provider = followUpProvider(storedProvider(row), 'story_build', preflightFor(ctx));
  const auth = preflightFor(ctx)(provider, 'story_build');
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };
  if (live.has(row.id)) return { status: 'not_ready' };
  live.set(row.id, { accountId: input.accountId, kind: 'build', controller: new AbortController(), progress: { phase: 'preparing', repoId: repo.repoId }, queued: true, cancelled: false });
  try {
    // A failed / cancelled session is closed: re-opening it may meet a newer open session of the ticket.
    const reopened = await updateStoryBuild(ctx, input.accountId, row.id, { status: 'building', phase: 'preparing', error: null, completedAt: null });
    if (!reopened) throw new Error('not reopened');
    await updateStoryBuildRepo(ctx, input.accountId, repo.id, { status: 'queued', error: null });
    enqueueBuild(ctx, input.accountId, row.id);
    return { status: 'queued', id: row.id };
  } catch {
    endPass(row.id);
    return { status: 'not_ready' };
  }
}

interface BuildJob {
  ctx: AgentContext;
  accountId: number;
  buildId: number;
}

const buildQueue: BuildJob[] = [];
let buildActive: number | null = null;

function enqueueBuild(ctx: AgentContext, accountId: number, buildId: number): void {
  buildQueue.push({ ctx, accountId, buildId });
  pumpBuild();
}

function pumpBuild(): void {
  if (buildActive != null || buildQueue.length === 0) return;
  const job = buildQueue.shift()!;
  const l = live.get(job.buildId);
  if (l == null) return pumpBuild();
  l.queued = false;
  buildActive = job.buildId;
  void runBuilds(job, l.controller)
    .catch(async (err) => {
      job.ctx.log.warn({ err }, `story build ${job.buildId}: build failed`);
      // Never leave a repository or the session "running".
      try {
        for (const r of await listStoryBuildRepoRows(job.ctx, job.accountId, job.buildId)) {
          if (r.include && (r.status === 'queued' || STORY_BUILD_REPO_RUNNING_STATUSES.includes(r.status))) {
            await updateStoryBuildRepo(job.ctx, job.accountId, r.id, { status: 'failed', error: 'The build failed. Retry it.', completedAt: new Date() });
          }
        }
        await settleBuild(job.ctx, job.accountId, job.buildId, false);
      } catch {
        /* the restart reconcile is the last resort */
      }
    })
    .finally(() => {
      buildActive = null;
      endPass(job.buildId);
      pumpBuild();
    });
}

const REPO_STATUS_OF: Partial<Record<StoryBuildPhase, StoryBuildRepoStatus>> = {
  preparing: 'preparing',
  preparing_checks: 'preparing',
  building: 'building',
  running_checks: 'checking',
  capturing: 'checking',
};

async function runBuilds(job: BuildJob, controller: AbortController): Promise<void> {
  const { ctx, accountId, buildId } = job;
  const deps = storyBuildDeps();
  const limits = storyBuildLimits();
  for (;;) {
    const row = await getStoryBuildRow(ctx, accountId, buildId);
    if (row == null) return;
    const repos = await listStoryBuildRepoRows(ctx, accountId, buildId);
    const next = repos.find((r) => r.include && r.status === 'queued');
    if (next == null) break;
    if (controller.signal.aborted) {
      for (const r of repos.filter((x) => x.include && x.status === 'queued')) {
        await updateStoryBuildRepo(ctx, accountId, r.id, { status: 'cancelled', completedAt: new Date() });
      }
      break;
    }
    const left = limits.sessionBudgetUsd - sessionSpent(row, repos);
    if (left < STORY_BUILD_MIN_BUDGET_LEFT_USD) {
      await updateStoryBuildRepo(ctx, accountId, next.id, { status: 'failed', error: 'The session budget is spent.', completedAt: new Date() });
      continue;
    }
    const names = await storyBuildRepoNames(ctx, accountId, repos.map((r) => r.repoId));
    const earlier = repos
      .filter((r) => r.include && r.buildOrder < next.buildOrder && (r.status === 'ready' || r.status === 'pushed'))
      .map((r) => ({ repo: r, fullName: names.get(r.repoId) ?? `#${r.repoId}`, worktreePath: r.worktreePath ?? null }));
    const nonce = pickReviewNonce([
      row.seedJson?.story.text ?? '',
      row.seedJson?.story.title ?? '',
      row.seedJson?.comments ?? '',
      ...(row.seedJson?.cards ?? []).map((c) => c.text),
      row.planJson ? renderStoryPlanText(row.planJson) : '',
      row.docsJson != null ? JSON.stringify(row.docsJson) : '',
      ...earlier.map((e) => JSON.stringify(e.repo.changeReportJson ?? '')),
    ]);
    const docs = deps.docsBlocksFor(row, { nonce, frozen: true });
    let shown: StoryBuildRepoStatus = 'preparing';
    await updateStoryBuildRepo(ctx, accountId, next.id, { status: 'preparing', error: null, startedAt: new Date(), completedAt: null });
    await updateStoryBuild(ctx, accountId, buildId, { phase: 'preparing' });
    progress(buildId, { phase: 'preparing', repoId: next.repoId });
    let res: RepoBuildResult;
    try {
      res = await deps.buildRepo(ctx, {
        accountId,
        build: row,
        repo: { ...next, status: 'preparing' },
        fullName: names.get(next.repoId) ?? `#${next.repoId}`,
        earlier,
        docs,
        nonce,
        budgetLeftUsd: Math.min(left, limits.repoBudgetUsd),
        onProgress: (p) => {
          progress(buildId, { ...p, repoId: next.repoId });
          const st = REPO_STATUS_OF[p.phase];
          if (st != null && st !== shown) {
            shown = st;
            void updateStoryBuildRepo(ctx, accountId, next.id, { status: st }).catch(() => {});
            void updateStoryBuild(ctx, accountId, buildId, { phase: p.phase }).catch(() => {});
          }
        },
        signal: controller.signal,
      });
    } catch (err) {
      ctx.log.warn({ err }, `story build ${buildId}: repository ${next.repoId} failed`);
      res = failedResult(controller.signal.aborted ? null : 'The build failed. Retry it.', controller.signal.aborted);
    }
    await recordBuildUsage(ctx, accountId, next.repoId, res);
    const tooBig = res.patch != null && Buffer.byteLength(res.patch, 'utf8') > limits.patchMaxBytes;
    const status: StoryBuildRepoStatus = res.cancelled || controller.signal.aborted ? 'cancelled' : res.ok && !tooBig ? 'ready' : 'failed';
    await updateStoryBuildRepo(ctx, accountId, next.id, {
      status,
      error: status === 'failed' ? (tooBig ? `The change is too big to keep (over ${Math.round(limits.patchMaxBytes / 1024 / 1024)} MB).` : (res.error ?? 'The build failed. Retry it.')) : null,
      worktreePath: res.worktreePath ?? next.worktreePath ?? null,
      ...(res.patch != null && !tooBig ? { patch: res.patch, filesChangedJson: res.filesChanged } : {}),
      summary: res.summary ?? next.summary ?? null,
      commitMessage: res.commitMessage ?? next.commitMessage ?? null,
      changeReportJson: res.changeReport ?? next.changeReportJson ?? null,
      checksJson: res.checks ?? next.checksJson ?? null,
      provider: res.provider,
      model: res.model,
      effort: res.effort,
      costUsd: num(next.costUsd) + num(res.costUsd) || null,
      inputTokens: num(next.inputTokens) + num(res.inputTokens) || null,
      outputTokens: num(next.outputTokens) + num(res.outputTokens) || null,
      numTurns: res.numTurns,
      completedAt: new Date(),
    });
    if (status === 'cancelled') {
      const rest = (await listStoryBuildRepoRows(ctx, accountId, buildId)).filter((x) => x.include && x.status === 'queued');
      for (const r of rest) await updateStoryBuildRepo(ctx, accountId, r.id, { status: 'cancelled', completedAt: new Date() });
      break;
    }
  }
  await settleBuild(ctx, accountId, buildId, controller.signal.aborted);
}

function failedResult(error: string | null, cancelled: boolean): RepoBuildResult {
  return {
    ok: false,
    cancelled,
    error,
    worktreePath: null,
    patch: null,
    filesChanged: [],
    summary: null,
    commitMessage: null,
    changeReport: null,
    checks: null,
    provider: null,
    model: null,
    effort: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
  };
}

/** The ledger row of one repository's build on CLAUDE (a Codex run wrote its own from `usageRecord`). */
async function recordBuildUsage(ctx: AgentContext, accountId: number, repoId: number, res: RepoBuildResult): Promise<void> {
  if (res.provider === 'codex' || res.costUsd == null || !(res.costUsd > 0)) return;
  await ctx
    .recordAiUsage({
      accountId,
      seam: 'agent',
      feature: STORY_BUILD_LEDGER_FEATURES.build,
      model: res.model ?? 'claude',
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      repoId,
    })
    .catch((err) => ctx.log.warn({ err }, 'story build: usage record failed'));
}

/** Every included repository settled: ≥ 1 ready (or pushed) ⇒ ready; none ⇒ failed, or cancelled. */
async function settleBuild(ctx: AgentContext, accountId: number, buildId: number, cancelled: boolean): Promise<void> {
  const repos = (await listStoryBuildRepoRows(ctx, accountId, buildId)).filter((r) => r.include);
  const built = repos.some((r) => r.status === 'ready' || r.status === 'pushed');
  const status: StoryBuildStatus = built ? 'ready' : cancelled ? 'cancelled' : 'failed';
  await updateStoryBuild(ctx, accountId, buildId, {
    status,
    phase: null,
    error: status === 'failed' ? 'No repository was built.' : null,
    completedAt: new Date(),
  });
}

// ---- cancel / discard --------------------------------------------------------------------------------------

export async function cancelStoryBuild(ctx: AgentContext, accountId: number, buildId: number): Promise<{ status: 'cancelling' | 'idle' } | { status: 'not_found' }> {
  const row = await getStoryBuildRow(ctx, accountId, buildId);
  if (row == null) return { status: 'not_found' };
  const l = live.get(buildId);
  if (l == null) return { status: 'idle' };
  l.cancelled = true;
  l.controller.abort();
  // Not started yet: take it out of its lane and settle the row now.
  const pi = planLane.findIndex((j) => j.buildId === buildId);
  if (pi >= 0) {
    const [job] = planLane.splice(pi, 1);
    await job!.dropped().catch(() => {});
    endPass(buildId);
    return { status: 'cancelling' };
  }
  const bi = buildQueue.findIndex((j) => j.buildId === buildId);
  if (bi >= 0) {
    buildQueue.splice(bi, 1);
    for (const r of (await listStoryBuildRepoRows(ctx, accountId, buildId)).filter((x) => x.include && x.status === 'queued')) {
      await updateStoryBuildRepo(ctx, accountId, r.id, { status: 'cancelled', completedAt: new Date() });
    }
    await settleBuild(ctx, accountId, buildId, true);
    endPass(buildId);
  }
  return { status: 'cancelling' };
}

export async function discardStoryBuild(ctx: AgentContext, accountId: number, buildId: number): Promise<{ status: 'discarded' | 'not_ready' | 'not_found' }> {
  const row = await getStoryBuildRow(ctx, accountId, buildId);
  if (row == null) return { status: 'not_found' };
  if (live.has(buildId) || isStoryBuildRunning(row.status) || row.docsStatus === 'running') return { status: 'not_ready' };
  if (row.status !== 'discarded') {
    await updateStoryBuild(ctx, accountId, buildId, { status: 'discarded', phase: null, completedAt: new Date() });
  }
  return { status: 'discarded' };
}

// ---- restart -----------------------------------------------------------------------------------------------

/**
 * A pass a restart cut off never stays running (boot, before any route serves): assess / plan WITH a
 * plan ⇒ plan_ready, without ⇒ failed; a repository mid-build ⇒ failed (or ready when an earlier pass
 * stored a patch), a queued one ⇒ cancelled, then the session settles like a build; a docs run ⇒ failed.
 * Every account's rows (boot work). Returns how many sessions moved.
 */
export async function reconcileStoryBuildsOnStartup(ctx: AgentContext): Promise<number> {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const b = (ctx.schema as any).storyBuilds;
  const running: StoryBuildStatus[] = ['assessing', 'planning', 'building'];
  const rows = (await ctx.db.select().from(b).where(inArray(b.status, running)).execute()) as StoryBuildRow[];
  const docsRows = (await ctx.db.select().from(b).where(inArray(b.docsStatus, ['running'])).execute()) as StoryBuildRow[];
  let moved = 0;
  for (const row of rows) {
    if (row.status === 'building') {
      for (const r of await listStoryBuildRepoRows(ctx, row.accountId, row.id)) {
        if (STORY_BUILD_REPO_RUNNING_STATUSES.includes(r.status)) {
          const kept = r.patch != null && r.patch.length > 0;
          await updateStoryBuildRepo(ctx, row.accountId, r.id, { status: kept ? 'ready' : 'failed', error: kept ? null : RESTART_LINE, completedAt: new Date() });
        } else if (r.include && r.status === 'queued') {
          await updateStoryBuildRepo(ctx, row.accountId, r.id, { status: 'cancelled', completedAt: new Date() });
        }
      }
      await settleBuild(ctx, row.accountId, row.id, true);
      await updateStoryBuild(ctx, row.accountId, row.id, { error: RESTART_LINE });
    } else if (row.planJson != null) {
      await updateStoryBuild(ctx, row.accountId, row.id, { status: 'plan_ready', phase: null, error: RESTART_LINE });
    } else {
      await fail(ctx, row.accountId, row.id, RESTART_LINE);
    }
    moved += 1;
  }
  for (const row of docsRows) {
    await updateStoryBuild(ctx, row.accountId, row.id, { docsStatus: 'failed', docsError: RESTART_LINE, ...(row.status === 'plan_ready' ? { phase: null } : {}) });
    moved += 1;
  }
  if (moved > 0) ctx.log.info(`reconciled ${moved} story build session(s) cut off by a restart`);
  return moved;
}

/** Test seam: wait until nothing is queued or running. */
export async function _storyBuildIdleForTest(timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((planLane.length > 0 || planRunning.size > 0 || buildQueue.length > 0 || buildActive != null || live.size > 0) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
