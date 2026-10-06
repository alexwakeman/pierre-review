import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLAUDE_REVIEW_MODEL,
  parseTicketIdent,
  type ClaudeReviewModel,
  type ClaudeReviewTicket,
  type TicketPrCardBody,
  type TicketReviewProgress,
  type TicketReviewStatus,
  type TicketReviewStreamEvent,
  type TicketReviewTrigger,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { cleanupCloneCache, prepDefaultBranchCheckouts } from '../clone-manager.js';
import {
  AGENTIC_AI_ENABLED,
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewLaneWaiting,
  reviewSlotFree,
} from '../claude-review/manager.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import {
  partitionMembers,
  placePrepassFailures,
  readCardsAt,
  saveCards,
  validateRunCards,
  type StoredCardRow,
} from './cards.js';
import { fingerprint, staleReasons } from './fingerprint.js';
import { TICKET_CARD_MODEL, prepassCost, runCardPrepass, type PrepassResult } from './prepass.js';
import {
  getTicketReviewById,
  getTicketReviewRow,
  getTicketStateInputs,
  insertQueuedTicketReview,
  markTicketReviewCancelled,
  markTicketReviewFailed,
  markTicketReviewRefused,
  markTicketReviewRunning,
  reconcileOrphanedTicketReviews,
  saveTicketReviewSuccess,
  setTicketMemberCheckouts,
} from './persist.js';
import {
  fetchMemberDiffs,
  type MemberDiff,
  loadLegacyStoryFindings,
  memberRepos,
  prepareMemberWorktrees,
  resolveTicketInputs,
} from './prepare.js';
import {
  TICKET_REVIEW_SYSTEM_PROMPT,
  buildTicketReviewPrompt,
  capMemberDiffs,
  membersIndex,
  ticketReviewUntrustedTexts,
  type PromptDefaultBranch,
  type PromptMember,
  type PromptPrior,
} from './prompts.js';
import { reconcileTicketReview, type TicketReport } from './reconcile.js';

// THE TICKET REVIEW QUEUE — one run per TICKET (never per PR), beside the PR review's own queue
// (claude-review/manager.ts) and SEPARATE from it: its own rows, its own claim, its own lane, so a
// PR review and a ticket review can run on the same PR at once.
//
//   CLAIM    `${accountId}:${ident}` — at most one queued-or-running run per ticket, claimed
//            SYNCHRONOUSLY before the first await, so two clicks (or a click and the sweeper) can
//            never start the same ticket twice.
//   LANE     one FIFO. A manual item goes ahead of every automatic one; at most TICKET_AUTO_MAX
//            automatic items wait (the sweeper re-derives the rest next tick), at most
//            TICKET_MANUAL_MAX manual ones. Unlike the PR review's auto lane, an automatic item
//            writes its row when it is QUEUED, so the per-workspace daily cap (a row count) sees
//            it at once.
//   SLOTS    the ONE shared REVIEW_CONCURRENCY (`reviewSlotFree`): PR reviews and ticket reviews
//            together. A ticket item starts only when no PR-review CLICK is waiting; an automatic
//            ticket item only when the PR-review lanes are empty. Each side pumps the other when a
//            run ends.
//
// THE PIPELINE (`runPipeline`): resolve the story and members (prepare.ts; refusals are stored,
// never sampled) → write the members and fingerprint (running) → partition the members (cards.ts):
// a member with a CONTRIBUTION CARD at its current head is read as the card, at most
// TICKET_REVIEW_MAX_DIFFS of the rest as diffs, and any beyond that get a card from the per-PR
// PRE-PASS first (prepass.ts; its cost joins the run's) → in parallel: those diffs (+ the pre-pass),
// a read-only worktree per OPEN member and ONE default-branch checkout per repo with a MERGED member
// → the prompt (nonce-fenced) in a scratch working directory holding MEMBERS.md → the agent
// (agent.ts: Read/Glob/Grep behind the path guard, every checkout a root) → the run's cards for its
// diff members (validated, stored) → the server reconcile (reconcile.ts) → persist. The `finally`
// removes every checkout and the scratch directory, then runs a deferred clone-cache eviction.
//
// In-memory state is a process singleton; the boot reconcile fails any run a restart orphaned.

const TICKET_AUTO_MAX = 20;
const TICKET_MANUAL_MAX = 50;

export interface TicketJob {
  ctx: AgentContext;
  accountId: number;
  workspaceId: number;
  ident: string;
  runId: number;
  originPrId: number | null;
  trigger: TicketReviewTrigger;
  // A pasted story's text (the run's snapshot); null for a Jira ticket (read at prepare time).
  manualTicket: ClaudeReviewTicket | null;
  model: ClaudeReviewModel;
  // Spent before the agent's own run (the card pre-pass), so every terminal write — including the
  // launch catch's — carries it into the run's cost.
  spentUsd: number;
}

// `${accountId}:${ident}` → the run id holding it (-1 while its row is being written).
const claimed = new Map<string, number>();
const lane: TicketJob[] = [];
const running = new Map<number, TicketJob>();
const progressByRun = new Map<number, TicketReviewProgress>();
const controllers = new Map<number, AbortController>();
const streamSubs = new Map<number, Set<(e: TicketReviewStreamEvent) => void>>();

const keyOf = (accountId: number, ident: string): string => `${accountId}:${ident}`;
const isAuto = (j: TicketJob): boolean => j.trigger !== 'manual';

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

function emit(runId: number, e: TicketReviewStreamEvent): void {
  const subs = streamSubs.get(runId);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb(e);
    } catch {
      /* a broken subscriber must never break the run */
    }
  }
}

export function subscribeTicketReviewStream(
  runId: number,
  cb: (e: TicketReviewStreamEvent) => void,
): () => void {
  let set = streamSubs.get(runId);
  if (!set) {
    set = new Set();
    streamSubs.set(runId, set);
  }
  set.add(cb);
  return () => {
    const cur = streamSubs.get(runId);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) streamSubs.delete(runId);
  };
}

export interface StartTicketArgs {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  manualTicket: ClaudeReviewTicket | null;
  originPrId: number | null;
  trigger: TicketReviewTrigger;
}

export type StartTicketResult =
  | { outcome: 'queued'; runId: number }
  | { outcome: 'already_running'; runId: number | null }
  | { outcome: 'busy' }
  | { outcome: 'disabled' };

/**
 * Queue one ticket's run (the route's and the sweeper's one door). The claim is taken before any
 * await; the row is written next; the run starts when a shared slot is free.
 */
export async function startTicketReview(ctx: AgentContext, a: StartTicketArgs): Promise<StartTicketResult> {
  if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
  const key = keyOf(a.accountId, a.ident);
  const held = claimed.get(key);
  if (held != null) return { outcome: 'already_running', runId: held > 0 ? held : null };
  const auto = a.trigger !== 'manual';
  const waiting = lane.filter((j) => isAuto(j) === auto).length;
  if (waiting >= (auto ? TICKET_AUTO_MAX : TICKET_MANUAL_MAX)) return { outcome: 'busy' };
  claimed.set(key, -1); // reserve synchronously before any await

  let runId: number;
  try {
    const parsed = parseTicketIdent(a.ident);
    runId = await insertQueuedTicketReview(ctx, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      ident: a.ident,
      ticketKey: a.ticketKey ?? (parsed?.kind === 'jira' ? parsed.key : null),
      ticketTitle: a.ticketTitle,
      ticket: a.manualTicket,
      originPrId: a.originPrId,
      trigger: a.trigger,
      model: DEFAULT_CLAUDE_REVIEW_MODEL,
    });
  } catch (err) {
    claimed.delete(key);
    throw err;
  }
  claimed.set(key, runId);
  const job: TicketJob = {
    ctx,
    accountId: a.accountId,
    workspaceId: a.workspaceId,
    ident: a.ident,
    runId,
    originPrId: a.originPrId,
    trigger: a.trigger,
    manualTicket: a.manualTicket,
    model: DEFAULT_CLAUDE_REVIEW_MODEL,
    spentUsd: 0,
  };
  // A manual item goes ahead of every automatic one; FIFO within each.
  const firstAuto = lane.findIndex(isAuto);
  if (!auto && firstAuto >= 0) lane.splice(firstAuto, 0, job);
  else lane.push(job);
  pump();
  return { outcome: 'queued', runId };
}

/** How many more automatic items the lane takes right now (the sweeper stops at 0). */
export function ticketAutoLaneRoom(): number {
  return Math.max(0, TICKET_AUTO_MAX - lane.filter(isAuto).length);
}

/** Is a run of this ticket queued or running in this process? */
export function ticketReviewHeld(accountId: number, ident: string): boolean {
  return claimed.has(keyOf(accountId, ident));
}

// Fill free shared slots. A ticket item yields to a waiting PR-review click; an automatic ticket
// item yields to anything waiting in the PR-review lanes.
function pump(): void {
  for (;;) {
    if (lane.length === 0 || !reviewSlotFree()) return;
    const waiting = reviewLaneWaiting();
    if (waiting.manual) return;
    const idx = lane.findIndex((j) => !isAuto(j));
    if (idx >= 0) {
      launch(lane.splice(idx, 1)[0]!);
      continue;
    }
    if (waiting.auto) return;
    launch(lane.shift()!);
  }
}

function launch(job: TicketJob): void {
  const { ctx, runId } = job;
  running.set(runId, job);
  const controller = new AbortController();
  controllers.set(runId, controller);
  const progress = (p: TicketReviewProgress): void => {
    progressByRun.set(runId, p);
    emit(runId, { type: 'progress', status: 'running', ticketReviewId: runId, progress: p });
  };
  progress({ phase: 'preparing' });

  void runPipeline(job, controller, progress)
    .then(() => {
      // AUTO-POSTING: an AUTOMATIC run that succeeded may post its story gaps on their owner PRs
      // (./auto-post.ts decides, reads the run's status itself, never throws, never retries).
      if (!isAuto(job)) return;
      void import('./auto-post.js')
        .then((m) => m.maybeAutoPostTicketReview(ctx, { accountId: job.accountId, runId }))
        .catch((err) =>
          ctx.log.warn(`auto post ticket review ${runId}: ${err instanceof Error ? err.message : String(err)}`),
        );
    })
    .catch(async (err) => {
      ctx.log.error(
        { err },
        `ticket review ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // A throw (network, git, database) says nothing about the inputs: retryable.
      await markTicketReviewFailed(
        ctx,
        job.accountId,
        runId,
        err instanceof Error ? err.message : String(err),
        job.spentUsd > 0 ? { costUsd: job.spentUsd } : {},
        { retryable: true },
      ).catch(() => {});
    })
    .finally(() => {
      running.delete(runId);
      controllers.delete(runId);
      progressByRun.delete(runId);
      claimed.delete(keyOf(job.accountId, job.ident));
      void getTicketReviewById(ctx, job.accountId, runId)
        .then((r) =>
          emit(runId, {
            type: 'done',
            status: r?.status ?? 'failed',
            ticketReviewId: runId,
            memberPrIds: [...new Set([...(r?.members.map((m) => m.prId) ?? []), ...(job.originPrId != null ? [job.originPrId] : [])])],
          }),
        )
        .catch(() =>
          emit(runId, {
            type: 'done',
            status: 'failed',
            ticketReviewId: runId,
            memberPrIds: job.originPrId != null ? [job.originPrId] : [],
          }),
        );
      pump();
      pumpReviewLane();
    });
}

async function runPipeline(
  job: TicketJob,
  controller: AbortController,
  progress: (p: TicketReviewProgress) => void,
): Promise<void> {
  const { ctx, accountId, runId } = job;

  // ---- who is on the ticket, and what it says (refusals are stored, never sampled) ----
  const inputs = await resolveTicketInputs(ctx, accountId, job.ident, {
    originPrId: job.originPrId,
    manualTicket: job.manualTicket,
  });
  if (!inputs.ok) {
    await markTicketReviewRefused(ctx, accountId, runId, { reason: inputs.reason, prCount: inputs.prCount });
    return;
  }
  const { ticket, ticketHash: hash, members } = inputs;
  const fp = fingerprint(hash, members);
  const repos = await memberRepos(ctx, accountId, members);
  await markTicketReviewRunning(ctx, accountId, runId, {
    ticket,
    ticketHash: hash,
    fingerprint: fp,
    prCount: members.length,
    members: members.map((m) => ({ ...m, checkedOut: false })),
  });

  const located = members
    .map((m) => ({ ...m, ...(repos.get(m.prId) ?? { owner: '', name: '', defaultBranch: null }) }))
    .filter((m) => m.owner !== '');
  const locatedById = new Map(located.map((m) => [m.prId, m]));
  const repoName = (prId: number): string => {
    const r = repos.get(prId);
    return r ? `${r.owner}/${r.name}` : 'unknown';
  };
  let cleanupWorktrees: (() => Promise<void>) | null = null;
  let cleanupDefaults: (() => Promise<void>) | null = null;
  let scratch: string | null = null;
  // Everything spent before the agent's own run (the card pre-pass) — added to the run's cost.
  const spent = (): number | null => (job.spentUsd > 0 ? job.spentUsd : null);
  try {
    // ---- how each member is read: as its stored card, as a diff, or via the pre-pass ----
    const stored = await readCardsAt(
      ctx,
      accountId,
      members.map((m) => ({ prId: m.prId, headSha: m.headSha })),
    ).catch(() => new Map<number, StoredCardRow>());
    const plan = partitionMembers(members, new Set(stored.keys()));
    const needDiff = [...plan.diffs, ...plan.prepass]
      .map((id) => locatedById.get(id))
      .filter((m): m is (typeof located)[number] => m != null);
    if (plan.prepass.length > 0) {
      progress({
        phase: 'preparing',
        message: `Describing ${plan.prepass.length} PR${plan.prepass.length === 1 ? '' : 's'} first`,
      });
    }
    const diffsThenCards = (async () => {
      const diffs = await fetchMemberDiffs(needDiff);
      const results =
        plan.prepass.length === 0
          ? []
          : await runCardPrepass({
              inputs: plan.prepass.map((id) => {
                const m = members.find((x) => x.prId === id)!;
                return {
                  prId: id,
                  repo: repoName(id),
                  number: m.number,
                  title: m.title,
                  diff: diffs.get(id)?.diff ?? null,
                  noiseFiles: diffs.get(id)?.noiseFiles ?? [],
                };
              }),
              ticket,
              pickNonce: pickReviewNonce,
              signal: controller.signal,
              applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
            });
      return { diffs, results };
    })();

    // ---- in parallel: diffs (+ pre-pass), checkouts, and the context ----
    // An OPEN member gets its own read-only worktree (whether shown as a card or a diff — the agent
    // may verify a card); a MERGED member is read through ONE default-branch checkout per repo.
    const [{ diffs, results }, worktrees, defaults, legacy, prior] = await Promise.all([
      // Caught like the reads below: a rejection would skip the cleanup assignments and leak.
      diffsThenCards.catch(() => ({ diffs: new Map<number, MemberDiff>(), results: [] as PrepassResult[] })),
      prepareMemberWorktrees(located.filter((m) => m.state === 'open')),
      prepDefaultBranchCheckouts(
        located
          .filter((m) => m.state === 'merged')
          .map((m) => ({ owner: m.owner, name: m.name, branch: m.defaultBranch })),
      ),
      loadLegacyStoryFindings(ctx, accountId, members.map((m) => m.prId), ticket).catch(() => []),
      // Caught, like the legacy read: a rejection here would skip the assignment below and leak the
      // worktrees the parallel branch prepared.
      getTicketStateInputs(ctx, accountId, [job.ident])
        .then((m) => m.get(job.ident)?.latest ?? null)
        .catch(() => null),
    ]);
    cleanupWorktrees = worktrees.cleanup;
    cleanupDefaults = defaults.cleanup;
    job.spentUsd += prepassCost(results);

    const headOf = new Map(members.map((m) => [m.prId, m.headSha]));
    const prepassCards = new Map<number, TicketPrCardBody>();
    for (const r of results) if (r.card != null) prepassCards.set(r.prId, r.card);
    for (const r of results) {
      if (r.card == null) ctx.log.warn(`ticket review ${runId}: no card for PR ${r.prId} (${r.failure ?? 'unknown'})`);
    }
    await saveCards(
      ctx,
      accountId,
      results
        .filter((r) => r.card != null)
        .map((r) => ({
          prId: r.prId,
          headSha: headOf.get(r.prId) ?? '',
          card: r.card!,
          changedFiles: diffs.get(r.prId)?.changedFiles ?? [],
          source: 'prepass' as const,
          model: r.model ?? TICKET_CARD_MODEL,
          costUsd: r.costUsd,
        })),
    ).catch((err) => ctx.log.warn({ err }, `ticket review ${runId}: could not store pre-pass cards`));
    const { fallbackDiffs, unread } = placePrepassFailures(plan.prepass, new Set(prepassCards.keys()));
    const diffSet = new Set([...plan.diffs, ...fallbackDiffs]);
    const unreadSet = new Set(unread);
    const cardOf = (prId: number): { body: TicketPrCardBody; changedFiles: string[] } | null => {
      const s1 = stored.get(prId);
      if (s1 != null) return { body: s1.card, changedFiles: s1.card.changedFiles };
      const p1 = prepassCards.get(prId);
      return p1 != null ? { body: p1, changedFiles: diffs.get(prId)?.changedFiles ?? [] } : null;
    };

    const defaultByRepo = new Map(defaults.checkouts.map((c) => [`${c.owner}/${c.name}`.toLowerCase(), c]));
    const defaultCheckoutOf = (prId: number) => {
      const m = locatedById.get(prId);
      return m != null && m.state === 'merged' ? (defaultByRepo.get(`${m.owner}/${m.name}`.toLowerCase()) ?? null) : null;
    };
    const checkedOut = new Map(
      members.map((m) => [
        m.prId,
        m.state === 'merged' ? defaultCheckoutOf(m.prId)?.path != null : worktrees.byPr.get(m.prId)?.path != null,
      ]),
    );
    await setTicketMemberCheckouts(ctx, accountId, runId, checkedOut);
    if (![...checkedOut.values()].some(Boolean)) {
      await markTicketReviewRefused(ctx, accountId, runId, {
        reason: 'peer_unreadable',
        prCount: members.length,
        ticketHash: hash,
        fingerprint: fp,
        costUsd: spent(),
      });
      return;
    }
    if (controller.signal.aborted) {
      await markTicketReviewCancelled(ctx, accountId, runId, { costUsd: spent() });
      return;
    }

    // ---- the prompt ----
    const diffMembers = members.filter((m) => diffSet.has(m.prId));
    const capped = capMemberDiffs(diffMembers.map((m) => diffs.get(m.prId)?.diff ?? null));
    const cappedOf = new Map(diffMembers.map((m, i) => [m.prId, capped[i]!]));
    const promptMembers: PromptMember[] = members.map((m, i) => {
      const card = diffSet.has(m.prId) || unreadSet.has(m.prId) ? null : cardOf(m.prId);
      const given: 'card' | 'diff' | 'unread' = diffSet.has(m.prId) ? 'diff' : card != null ? 'card' : 'unread';
      const c = cappedOf.get(m.prId);
      return {
        ref: `PR${i + 1}`,
        prId: m.prId,
        repo: repoName(m.prId),
        number: m.number,
        title: m.title,
        state: m.state,
        headSha: m.headSha,
        checkedOut: checkedOut.get(m.prId) === true,
        worktreePath: m.state === 'open' ? (worktrees.byPr.get(m.prId)?.path ?? null) : null,
        defaultBranchPath: defaultCheckoutOf(m.prId)?.path ?? null,
        given,
        card: card?.body ?? null,
        changedFiles: given === 'card' ? card!.changedFiles : (diffs.get(m.prId)?.changedFiles ?? []),
        diff: given === 'diff' ? (c?.diff ?? null) : null,
        noiseFiles: given === 'diff' ? (diffs.get(m.prId)?.noiseFiles ?? []) : [],
        omittedFiles: given === 'diff' ? (c?.omittedFiles ?? []) : [],
      };
    });
    const defaultBranches: PromptDefaultBranch[] = defaults.checkouts
      .filter((c) => c.path != null)
      .map((c) => ({ repo: `${c.owner}/${c.name}`, branch: c.branch, sha: c.sha, path: c.path! }));
    const promptPrior: PromptPrior | null =
      prior?.assessment != null
        ? (() => {
            const moved = staleReasons(prior, { ticketHash: hash, members });
            return {
              assessment: prior.assessment,
              changedPrIds: moved.changedPrIds,
              storyEdited: moved.reasons.includes('story_edited'),
            };
          })()
        : null;
    const nonce = pickReviewNonce(ticketReviewUntrustedTexts(ticket, promptMembers, promptPrior, legacy));
    const prompt = buildTicketReviewPrompt({
      ticket,
      members: promptMembers,
      prior: promptPrior,
      legacy,
      nonce,
      defaultBranches,
    });
    scratch = mkdtempSync(join(tmpdir(), 'pierre-ticket-review-'));
    writeFileSync(join(scratch, 'MEMBERS.md'), membersIndex(promptMembers), 'utf8');

    // ---- the run ----
    progress({ phase: 'reviewing' });
    const { runTicketReviewAgent } = await import('./agent.js');
    const res = await runTicketReviewAgent({
      model: job.model,
      cwd: scratch,
      // Every checkout is a root of the path guard; nothing else on disk can be read.
      worktrees: [
        ...promptMembers.map((m) => m.worktreePath).filter((p): p is string => p != null),
        ...defaultBranches.map((b) => b.path),
      ],
      systemPrompt: TICKET_REVIEW_SYSTEM_PROMPT,
      prompt,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: controller,
      onProgress: (p) => progress({ phase: 'reviewing', recentActivity: p.recentActivity, usage: p.usage }),
    });

    progress({ phase: 'saving' });
    const agentCost = res.costUsd ?? 0;
    const total = agentCost + job.spentUsd;
    const telemetry = {
      costUsd: res.costUsd == null && job.spentUsd <= 0 ? null : total,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      numTurns: res.numTurns,
    };
    if (res.aborted) {
      await markTicketReviewCancelled(ctx, accountId, runId, telemetry);
      return;
    }
    if (!res.submitted) {
      await markTicketReviewFailed(ctx, accountId, runId, res.failureReason ?? 'ticket review failed', telemetry);
      return;
    }
    // The run's cards: one per member it was SHOWN AS A DIFF (an unread diff shows nothing to
    // describe), validated against exactly those refs.
    const runCards = validateRunCards(
      (res.payload as { cards?: unknown } | null)?.cards,
      promptMembers.filter((m) => m.given === 'diff' && m.diff != null && m.diff !== ''),
      new Map(promptMembers.map((m) => [m.ref, `${m.repo.split('/').pop() ?? m.repo}#${m.number}`])),
    );
    await saveCards(
      ctx,
      accountId,
      [...runCards].map(([prId, card]) => ({
        prId,
        headSha: headOf.get(prId) ?? '',
        card,
        changedFiles: diffs.get(prId)?.changedFiles ?? [],
        source: 'story_check' as const,
        model: job.model,
        costUsd: null,
      })),
    ).catch((err) => ctx.log.warn({ err }, `ticket review ${runId}: could not store its cards`));
    const { assessment, items } = reconcileTicketReview(
      ticket,
      promptMembers.map((m) => ({
        ref: m.ref,
        prId: m.prId,
        repoId: members.find((x) => x.prId === m.prId)!.repoId,
        repo: m.repo,
        number: m.number,
        checkedOut: m.checkedOut,
      })),
      res.payload as TicketReport | null,
    );
    await saveTicketReviewSuccess(ctx, accountId, runId, {
      alignment: assessment.alignment,
      summary: assessment.summary,
      assessment,
      ...telemetry,
      items,
    });
  } finally {
    await cleanupWorktrees?.().catch(() => {});
    await cleanupDefaults?.().catch(() => {});
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
    if (located.length > 0) {
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory cleanup — never surface */
        }
      });
    }
  }
}

/**
 * One run's live status for the stream's snapshot. In-memory first (account-checked: the maps are
 * process-global), else the stored row; null when the run is not this account's.
 */
export async function getTicketRunStatus(
  ctx: AgentContext,
  accountId: number,
  runId: number,
): Promise<{ status: TicketReviewStatus; progress: TicketReviewProgress | null } | null> {
  const live = running.get(runId);
  if (live && live.accountId === accountId) {
    return { status: 'running', progress: progressByRun.get(runId) ?? null };
  }
  if (lane.some((j) => j.runId === runId && j.accountId === accountId)) {
    return { status: 'queued', progress: { phase: 'queued' } };
  }
  const row = await getTicketReviewRow(ctx, accountId, runId);
  if (!row) return null;
  return { status: row.status, progress: null };
}

/** Cancel a queued or running run of this account. Returns false when there is none. */
export function requestTicketReviewCancel(accountId: number, runId: number): boolean {
  const live = running.get(runId);
  if (live && live.accountId === accountId) {
    controllers.get(runId)?.abort();
    return true;
  }
  const idx = lane.findIndex((j) => j.runId === runId && j.accountId === accountId);
  if (idx < 0) return false;
  const job = lane.splice(idx, 1)[0]!;
  claimed.delete(keyOf(job.accountId, job.ident));
  void markTicketReviewCancelled(job.ctx, job.accountId, job.runId).catch(() => {});
  return true;
}

export async function reconcileTicketReviewsOnStartup(ctx: AgentContext): Promise<void> {
  const n = await reconcileOrphanedTicketReviews(ctx);
  if (n > 0) ctx.log.info(`reconciled ${n} orphaned ticket review(s) -> failed`);
}

/** Test seam: the lane's contents, in launch order. */
export function _ticketLaneForTest(): Array<{ accountId: number; ident: string; trigger: TicketReviewTrigger }> {
  return lane.map((j) => ({ accountId: j.accountId, ident: j.ident, trigger: j.trigger }));
}
