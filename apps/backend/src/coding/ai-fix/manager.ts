import { and, desc, eq } from 'drizzle-orm';
import { CI_ANALYSIS_CONTRACT_EPOCH_MS, isThreadToFix } from '@pierre-review/shared';
import type {
  AiFixCommentTargetRef,
  AiFixProgress,
  AiFixSeed,
  AiFixStatus,
  AiFixStatusResponse,
  AiFixStreamEvent,
} from '@pierre-review/shared';
import type { CodingProgress } from '../../pro/contract.js';
import type { AgentContext } from '../../review/agent-context.js';
import { getFixPrContext } from './pr-context.js';
import { getAgenticProviders } from '../../review/plugin-providers.js';
import { getClaudeReviewById } from '../../review/claude-review/persist.js';
import { pickReviewNonce } from '../../review/claude-review/prompts.js';
import { threadFixSeedBlock } from '../../review/claude-review/threads.js';
import {
  buildCommentSeedText,
  resolveCommentTargets,
  type ResolvedCommentTarget,
} from './comment-seed.js';
import {
  buildFixCommentsSystemPrompt,
  buildFixSystemPrompt,
  buildFixUserPrompt,
  type FixSeed,
} from './prompts.js';
import {
  insertQueuedFix,
  markFixCancelled,
  markFixFailed,
  markFixRunning,
  reconcileOrphanedFixes,
  saveFixSuccess,
} from './persist.js';

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
  | { status: 'credits_exhausted' }
  | { status: 'no_head' }
  // seed === 'comments' with nothing resolvable: every id the client sent is gone, forged, or
  // belongs to another PR. A refusal, not an empty run — a fixer with no task would burn a paid
  // agent turn and report on nothing.
  | { status: 'no_targets' }
  // seed === 'ci_analysis' with no usable diagnosis: either none is stored ('missing'), or the
  // stored one was written against an earlier head ('stale'). Seeding the agent with a diagnosis
  // of code that is gone spends a paid agent turn on the wrong commit. The SPA refuses this in
  // words too; this is the independent server half, because a POST is a POST.
  | { status: 'stale_seed'; reason: 'stale' | 'missing' };

export interface StartFixInput {
  accountId: number;
  prId: number;
  model: string;
  seed: AiFixSeed;
  sourceReviewId?: number | null;
  seedText?: string;
  // seed === 'comments': the comments the user dragged into the basket, as (kind, id) pairs.
  // Resolved server-side against THIS PR (see comment-seed.ts) — never trusted beyond that.
  commentTargets?: AiFixCommentTargetRef[];
}

export async function startFix(
  ctx: AgentContext,
  input: StartFixInput,
): Promise<StartFixResult> {
  const { accountId, prId } = input;

  const auth = ctx.llm.detectAuth();
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };

  // Hard agentic cap: refuse a run once the account's monthly agent credit allowance is spent
  // (metered per calendar month; local accounts are unmetered → never blocked).
  if ((await ctx.aiCredits.check(accountId)).agentBlocked) return { status: 'credits_exhausted' };

  if (claimed.has(prId)) return { status: 'already_running' };
  if (pending.length >= MAX_QUEUED) return { status: 'busy' };

  const pr = await getFixPrContext(ctx, accountId, prId);
  if (!pr) return { status: 'not_found' };

  // Reserve the PR synchronously BEFORE any await downstream so two concurrent starts
  // can't both pass the guard.
  claimed.add(prId);
  try {
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

    // The comments seed resolves its basket BEFORE anything is inserted: a run whose every id is
    // gone, forged, or from another PR has no task, and starting it would spend a paid agent turn
    // to report on nothing. ⚠ This is a NEW BAIL PATH BELOW `claimed.add(prId)`, so it releases
    // the claim — a leak here wedges this PR's fixer for the process's lifetime.
    //
    // ⚠ It also does NOT consult `input.seedText`, and that is structural rather than tidy:
    // `resolveSeedText`'s first line returns any client-supplied text verbatim, so routing this
    // seed through it would prompt the agent with whatever the client sent INSTEAD of the resolved,
    // capped, server-owned seed — the exact injection this resolver exists to prevent.
    //
    // ⚠ The rendered prompt (comment bodies AND anchor hunks) is FROZEN HERE, at launch, and the
    // run may not start until later — a single global slot is shared by every fix job in the
    // process. That is intended: the report must describe the text the agent was actually
    // given. Do NOT add a refresh fetch to the run path to "keep it current"; it would spend GitHub
    // quota per job and make the stored prompt a lie.
    let commentTargets: ResolvedCommentTarget[] | undefined;
    let droppedRefs: string[] = [];
    let seedText: string;
    if (input.seed === 'comments') {
      commentTargets = await resolveCommentTargets(ctx, {
        accountId,
        prId,
        owner: pr.owner,
        name: pr.name,
        prNumber: pr.number,
        refs: input.commentTargets ?? [],
      });
      if (commentTargets.length === 0) {
        claimed.delete(prId);
        return { status: 'no_targets' };
      }
      const built = buildCommentSeedText(commentTargets);
      seedText = built.text;
      // Carried to save time so a target cut for prompt budget reports "you were never shown this"
      // rather than "the fixer said nothing about this" — our decision, not the agent's failure.
      droppedRefs = built.droppedRefs;
    } else {
      const resolved = await resolveSeedText(ctx, input, pr.prId, accountId, baseSha);
      // ⚠ ANOTHER BAIL PATH BELOW `claimed.add(prId)` — release the claim, or this PR's fixer
      // wedges for the process's lifetime (same rule as the no_targets bail above).
      if (!resolved.ok) {
        claimed.delete(prId);
        return { status: 'stale_seed', reason: resolved.reason };
      }
      seedText = resolved.text;
    }
    const seed: FixSeed = { kind: input.seed, text: seedText };
    const systemPrompt =
      input.seed === 'comments' ? buildFixCommentsSystemPrompt() : buildFixSystemPrompt();
    const prompt = buildFixUserPrompt({ pr, diff, seed });

    const fixId = await insertQueuedFix(ctx, {
      accountId,
      repoId: pr.repoId,
      prId,
      baseSha,
      model: input.model,
      seed: input.seed,
      sourceReviewId: input.sourceReviewId ?? null,
      prompt,
      commentTargets: commentTargets?.map((t) => t.wire) ?? null,
    });
    fixIdByPr.set(prId, fixId);

    const job: FixJob = {
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
      commentTargets,
      droppedRefs,
    };

    const immediate = enqueue(prId, () => launchFix(ctx, job));
    if (!immediate) {
      emitFixStream(prId, {
        type: 'progress',
        status: 'queued',
        fixId,
        progress: { phase: 'fetching_diff' },
      });
    }
    return { status: 'queued', fixId };
  } catch (err) {
    claimed.delete(prId);
    fixIdByPr.delete(prId);
    ctx.log.warn({ err }, 'ai-fix startFix failed');
    return { status: 'not_found' };
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
  // Carried through the job so the agent's ref-keyed self-report can be mapped back at save time.
  // Kept in memory (not re-read from the row) because the PROMPT-only halves — the full body and
  // the anchor hunk — are deliberately never persisted; the mapping only needs `wire`, and this
  // keeps one source of truth for the ref labels.
  commentTargets?: ResolvedCommentTarget[];
  /** Refs the seed builder cut for prompt budget — see the note at the save call. */
  droppedRefs?: readonly string[];
}

type SeedTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'stale' | 'missing' };

/**
 * Is a stored CI diagnosis usable as a fix seed against `liveHeadSha`? Exported for its test —
 * the decision, not the query, is the part that has to be right. See resolveSeedText.
 */
export function ciSeedDecision(
  // `summary` is the diagnosis text ALREADY STRIPPED of its confidence footer (the Pro provider
  // strips it; plugin-providers.ts).
  row: { summary: string; headSha: string | null; createdAt?: Date | number | null } | undefined | null,
  liveHeadSha: string,
): SeedTextResult {
  if (!row?.summary) return { ok: false, reason: 'missing' };
  if (row.headSha != null && row.headSha !== liveHeadSha)
    return { ok: false, reason: 'stale' };
  // ⚠ AND A ROW WRITTEN UNDER THE OLD CAPABILITY CONTRACT IS STALE TOO. The stored analysis
  // describes what this fixer can do, the payload hash does not include the prompt, and the
  // prompt's claims changed: pre-epoch rows tell the agent to "run the repository's linter/build
  // to validate the fix locally" and to "commit and push", against a run whose tool list denies
  // Bash outright. Seeding one spends turns and budget reaching for a shell that is not there.
  // The card reads the SAME constant for its "out of date" chip — see
  // `CI_ANALYSIS_CONTRACT_EPOCH_MS`.
  if (predatesCiContract(row.createdAt)) return { ok: false, reason: 'stale' };
  return { ok: true, text: row.summary };
}

/** ⚠ AN ABSENT TIMESTAMP IS NOT A CLAIM, exactly as a null `headSha` is not. */
function predatesCiContract(createdAt: Date | number | null | undefined): boolean {
  if (createdAt == null) return false;
  const at = createdAt instanceof Date ? createdAt.getTime() : Number(createdAt);
  return Number.isFinite(at) && at < CI_ANALYSIS_CONTRACT_EPOCH_MS;
}

// ⚠ THE CI SEED IS PINNED TO THE HEAD IT DIAGNOSED. The stored analysis names a commit; a push
// (or a click racing one) makes it a description of code that is gone, and an agent seeded with
// it fixes the wrong thing at full price. `headSha` is compared against the LIVE head startFix
// already fetched, and a MISSING row is refused the same way — an empty seed is a plain run
// wearing the ci_analysis label, which is not what the caller asked for.
//
// A stored row with a NULL headSha predates the column and cannot be disproved, so it passes —
// the same reading the card's "out of date" chip takes.
async function resolveSeedText(
  ctx: AgentContext,
  input: StartFixInput,
  prId: number,
  accountId: number,
  liveHeadSha: string,
): Promise<SeedTextResult> {
  if (input.seed === 'review') {
    // "Fix from review" = ONE comprehensive fix: the review's own findings (the client's text) plus
    // the other reviewers' threads the review judged right and not yet dealt with (server-built
    // from the STORED run, fenced — the comment text is other people's).
    const threads = await reviewThreadSeed(ctx, input.sourceReviewId ?? null, prId, accountId, input.seedText ?? '');
    return { ok: true, text: [input.seedText ?? '', threads].filter((t) => t.trim()).join('\n\n') };
  }
  if (input.seedText) return { ok: true, text: input.seedText };
  if (input.seed === 'ci_analysis') {
    // ⚠ THE CI DIAGNOSIS IS A PRO CARD, so it comes through the OPTIONAL plugin provider
    // (review/plugin-providers.ts) — core cannot name the plugin's `ai_pr_analyses`. No plugin, or
    // no stored analysis, is `missing`: the seed is refused, never run unseeded under its label.
    const read = getAgenticProviders().readCiAnalysisSeed;
    const row = read ? await read(accountId, prId).catch(() => null) : null;
    return ciSeedDecision(row ? { summary: row.text, headSha: row.headSha, createdAt: row.createdAt } : null, liveHeadSha);
  }
  return { ok: true, text: '' };
}

/**
 * The thread half of a review seed: the named review's thread assessments that still need a fix
 * (`isThreadToFix`: judged valid or partly valid, and not or only partly addressed). '' when the id
 * is absent, not this account's, not THIS PR's review, or has none. Never throws.
 */
export async function reviewThreadSeed(
  ctx: AgentContext,
  reviewId: number | null,
  prId: number,
  accountId: number,
  clientText: string,
): Promise<string> {
  if (reviewId == null) return '';
  try {
    const review = await getClaudeReviewById(ctx, reviewId, accountId);
    if (!review || review.prId !== prId) return '';
    const items = (review.threadAssessments ?? []).filter(isThreadToFix);
    if (items.length === 0) return '';
    const nonce = pickReviewNonce([
      clientText,
      ...items.flatMap((t) => [t.path, t.excerpt, t.explanation ?? '', t.authorLogin ?? '']),
    ]);
    return threadFixSeedBlock(items, nonce, isThreadToFix);
  } catch {
    return '';
  }
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
      await saveFixSuccess(ctx, job.fixId, result, job.commentTargets, job.droppedRefs);
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
    if (running.has(prId)) {
      return {
        status: 'running',
        fixId: row.id,
        progress: progressByFix.get(row.id) ?? { phase: 'cloning' },
      };
    }
    if (claimed.has(prId)) {
      return { status: 'queued', fixId: row.id, progress: { phase: 'fetching_diff' } };
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
