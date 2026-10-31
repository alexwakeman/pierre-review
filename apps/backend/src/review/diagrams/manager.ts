import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SEQUENCE_DIAGRAM_STORY_MAX_PRS,
  parseTicketIdent,
  type ClaudeReviewModel,
  type SequenceDiagramKind,
  type SequenceDiagramMember,
  type SequenceDiagramPhase,
  type SequenceDiagramProgress,
  type SequenceDiagramTrigger,
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
import { readLiveMembers, type LiveMember } from '../ticket-review/fingerprint.js';
import {
  fetchMemberDiffs,
  jiraMemberIds,
  jiraStoryFor,
  memberRepos,
  prepareMemberWorktrees,
} from '../ticket-review/prepare.js';
import { storyDiagramFingerprint } from './fingerprint.js';
import { diagramPrecheck } from './precheck.js';
import { toDiagramMembers } from './trigger.js';
import {
  getDiagramPrContext,
  markDiagramCancelled,
  markDiagramFailed,
  markDiagramRanOn,
  markDiagramRefused,
  markDiagramRunning,
  reconcileOrphanedDiagrams,
  recordDiagramUsage,
  saveDiagramSuccess,
  insertQueuedDiagram,
  type Telemetry,
} from './persist.js';
import {
  prDiagramSystemPrompt,
  storyDiagramSystemPrompt,
  buildPrDiagramPrompt,
  buildStoryDiagramPrompt,
  diagramUntrustedTexts,
  type DiagramPromptPr,
} from './prompts.js';
import { acceptedAsPayload, validateDesign, type DesignContext } from './validate.js';
import { withWorktreeOwner } from '../worktree-owner.js';

// THE SEQUENCE-DIAGRAM QUEUE — a SEPARATE agentic process beside the PR review's queue
// (claude-review/manager.ts), the ticket review's and the CI review's: its own rows, its own claim,
// its own lane, so a review, a story check, a CI check and a diagram can run on the same PR at once.
//
//   MODEL    Sonnet 5, always (DIAGRAM_MODEL). Nothing on the wire picks it.
//   CLAIM    `${accountId}:${kind}:${subject}` — at most one queued-or-running diagram per subject,
//            claimed SYNCHRONOUSLY before the first await.
//   LANE     one FIFO. A Redraw click ('manual') goes ahead of every review-started item; at most
//            REVIEW_MAX review-started items wait (the rest are simply not drawn — the next review
//            tries again), at most MANUAL_MAX clicks.
//   SLOTS    the ONE shared REVIEW_CONCURRENCY (`reviewSlotFree`) as a registered PEER. A diagram
//            starts only when no PR-review CLICK is waiting; a review-started diagram only when the
//            PR-review auto lane is empty too. Each side pumps the others when a run ends.
//
// THE PIPELINE (`runPipeline`), per kind:
//   pr     the synced head (moved since queued ⇒ refused head_moved) → the diff → THE PRE-CHECK
//          (precheck.ts, free: no code ⇒ no_code; tests only, copy only or too small ⇒ tests_only /
//          copy_only / too_small, skipped on a reader's own Draw) → a read-only worktree at the head →
//          the prompt → the agent.
//   story  the ticket's live open + merged members (< 2 ⇒ too_few_prs; > the cap ⇒ too_many_prs;
//          a changed member set ⇒ head_moved) → every member's diff (the pre-check over them all) → a
//          worktree per OPEN member + ONE default-branch checkout per repository for the MERGED ones
//          (the ticket review's approach) → the prompt (+ the stored ticket text) → the agent.
// Every answer is a DATA-FLOW SEQUENCE validated (validate.ts `validateDesign`, against the run's PR
// refs and changed files) inside the tool and again before it is stored — or the model's DECLINE (no
// data moves through the change), stored as refused `no_flow` with its reason. The `finally` removes every checkout
// and the scratch directory, then runs a deferred clone-cache eviction.
//
// ⚠ NEVER BLOCKS OR FAILS A REVIEW: the review's manager reaches this module only through a
// fire-and-forget `import()` AFTER its run is saved (trigger.ts).

export const DIAGRAM_MODEL: ClaudeReviewModel = 'claude-sonnet-5';
const REVIEW_MAX = 20;
const MANUAL_MAX = 20;

export interface DiagramJob {
  ctx: AgentContext;
  accountId: number;
  kind: SequenceDiagramKind;
  subject: string;
  diagramId: number;
  trigger: SequenceDiagramTrigger;
  fingerprint: string;
  // 'pr' jobs: the PR and the head queued.
  prId: number | null;
  headSha: string | null;
}

const claimed = new Map<string, number>(); // claim key → diagram id (-1 while its row is written)
const lane: DiagramJob[] = [];
const running = new Map<number, DiagramJob>();
const controllers = new Map<number, AbortController>();
// WHERE EACH QUEUED OR RUNNING DRAWING IS (diagram id → progress), read by the GET routes
// (`diagramProgress`) so the SPA's bar survives a reload. In memory only: a restart fails the run
// (`reconcileOrphanedDiagrams`), so nothing stale outlives it. Set on queue, moved by the pipeline,
// deleted when the run ends. Both providers report steps through the same `onProgress`.
const progress = new Map<number, SequenceDiagramProgress>();

function setPhase(diagramId: number, phase: SequenceDiagramPhase, steps?: number): void {
  if (!running.has(diagramId) && !lane.some((j) => j.diagramId === diagramId)) return;
  const prev = progress.get(diagramId);
  progress.set(diagramId, { phase, steps: steps ?? prev?.steps ?? 0 });
}

/** A queued or running drawing's progress in this process, or null. */
export function diagramProgress(diagramId: number): SequenceDiagramProgress | null {
  return progress.get(diagramId) ?? null;
}

const keyOf = (accountId: number, kind: SequenceDiagramKind, subject: string): string =>
  `${accountId}:${kind}:${subject}`;
const isManual = (j: DiagramJob): boolean => j.trigger === 'manual';

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

export interface StartDiagramArgs {
  accountId: number;
  kind: SequenceDiagramKind;
  subject: string;
  prId: number | null;
  ticketKey: string | null;
  fingerprint: string;
  headSha: string | null;
  members: SequenceDiagramMember[] | null;
  trigger: SequenceDiagramTrigger;
}

export type StartDiagramResult =
  | { outcome: 'queued'; diagramId: number }
  | { outcome: 'already_running'; diagramId: number | null }
  | { outcome: 'busy' }
  | { outcome: 'disabled' };

/** Queue one diagram (the trigger's and the Redraw routes' one door). */
export async function startDiagram(ctx: AgentContext, a: StartDiagramArgs): Promise<StartDiagramResult> {
  if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
  const key = keyOf(a.accountId, a.kind, a.subject);
  const held = claimed.get(key);
  if (held != null) return { outcome: 'already_running', diagramId: held > 0 ? held : null };
  const manual = a.trigger === 'manual';
  const waiting = lane.filter((j) => isManual(j) === manual).length;
  if (waiting >= (manual ? MANUAL_MAX : REVIEW_MAX)) return { outcome: 'busy' };
  claimed.set(key, -1); // reserve synchronously before any await

  let diagramId: number;
  try {
    diagramId = await insertQueuedDiagram(ctx, { ...a, model: DIAGRAM_MODEL });
  } catch (err) {
    claimed.delete(key);
    throw err;
  }
  claimed.set(key, diagramId);
  const job: DiagramJob = {
    ctx,
    accountId: a.accountId,
    kind: a.kind,
    subject: a.subject,
    diagramId,
    trigger: a.trigger,
    fingerprint: a.fingerprint,
    prId: a.prId,
    headSha: a.headSha,
  };
  const firstReview = lane.findIndex((j) => !isManual(j));
  if (manual && firstReview >= 0) lane.splice(firstReview, 0, job);
  else lane.push(job);
  progress.set(diagramId, { phase: 'waiting', steps: 0 });
  pump();
  return { outcome: 'queued', diagramId };
}

/** Is a diagram of this subject queued or running in this process? */
export function diagramHeld(accountId: number, kind: SequenceDiagramKind, subject: string): boolean {
  return claimed.has(keyOf(accountId, kind, subject));
}

function pump(): void {
  for (;;) {
    if (lane.length === 0 || !reviewSlotFree()) return;
    const waiting = reviewLaneWaiting();
    if (waiting.manual) return;
    const idx = lane.findIndex(isManual);
    if (idx >= 0) {
      launch(lane.splice(idx, 1)[0]!);
      continue;
    }
    if (waiting.auto) return;
    launch(lane.shift()!);
  }
}

function launch(job: DiagramJob): void {
  const { ctx, diagramId } = job;
  running.set(diagramId, job);
  setPhase(diagramId, 'preparing');
  const controller = new AbortController();
  controllers.set(diagramId, controller);
  void runPipeline(job, controller)
    .catch(async (err) => {
      ctx.log.warn(`sequence diagram ${diagramId} failed: ${err instanceof Error ? err.message : String(err)}`);
      await markDiagramFailed(ctx, job.accountId, diagramId, err instanceof Error ? err.message : String(err)).catch(
        () => {},
      );
    })
    .finally(() => {
      running.delete(diagramId);
      controllers.delete(diagramId);
      progress.delete(diagramId);
      claimed.delete(keyOf(job.accountId, job.kind, job.subject));
      pump();
      pumpReviewLane();
    });
}

async function finishWithAgent(
  job: DiagramJob,
  controller: AbortController,
  args: { roots: string[]; systemPrompt: string; prompt: string; prId: number | null; design: DesignContext },
): Promise<void> {
  const { ctx, accountId, diagramId } = job;
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'pierre-diagram-'));
    const { runDiagramAgent } = await import('./agent.js');
    const res = await runDiagramAgent({
      model: DIAGRAM_MODEL,
      cwd: scratch,
      roots: args.roots,
      systemPrompt: args.systemPrompt,
      prompt: args.prompt,
      design: args.design,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: controller,
      // The bar's phase: reading while the agent works, checking once it has sent a design.
      onProgress: (p) => setPhase(diagramId, p.submitted ? 'checking' : 'reading', p.steps),
      // Codex records its own ledger row from this (its model, US$ 0 on a ChatGPT login, its tokens).
      usageRecord: { accountId, seam: 'agent', feature: 'sequence_diagram', prId: args.prId },
    });
    setPhase(diagramId, 'saving');
    // What ran (provider + model id), whatever the outcome.
    await markDiagramRanOn(ctx, accountId, diagramId, { provider: res.provider, model: res.model });
    const telemetry: Telemetry = {
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      numTurns: res.numTurns,
    };
    // A Codex run's row is already written (by its provider, as Codex): never a second, Claude-named one.
    if (res.provider !== 'codex') await recordDiagramUsage(ctx, { accountId, model: DIAGRAM_MODEL, prId: args.prId }, telemetry);
    if (res.aborted) {
      await markDiagramCancelled(ctx, accountId, diagramId, telemetry);
      return;
    }
    // ⚠ Validated AGAIN here: the tool's acceptance is not the storage gate.
    const v = res.diagram != null ? validateDesign(acceptedAsPayload(res.diagram), args.design) : null;
    if (res.diagram == null || v == null || !v.ok) {
      await markDiagramFailed(
        ctx,
        accountId,
        diagramId,
        res.failureReason ?? 'No usable diagram.',
        telemetry,
        res.lastRefusal != null || (v != null && !v.ok) ? 'invalid_diagram' : null,
      );
      return;
    }
    // The model said no data moves through the change: a refusal with its reason (billed — it ran).
    if (v.value.flow == null) {
      await markDiagramRefused(ctx, accountId, diagramId, 'no_flow', telemetry, v.value.declined);
      return;
    }
    await saveDiagramSuccess(
      ctx,
      accountId,
      diagramId,
      { title: v.value.title, caption: v.value.caption, design: v.value.flow },
      telemetry,
    );
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
  }
}

/** What a run's answer is validated against: its PR refs, in order, and their changed files. */
export function designContextFor(kind: 'pr' | 'story', prs: readonly DiagramPromptPr[]): DesignContext {
  return { kind, prs: prs.map((p) => ({ ref: p.ref, changedFiles: p.changedFiles })) };
}

async function runPipeline(job: DiagramJob, controller: AbortController): Promise<void> {
  if (job.kind === 'pr') await runPrPipeline(job, controller);
  else await runStoryPipeline(job, controller);
  setImmediate(() => {
    try {
      cleanupCloneCache();
    } catch {
      /* advisory cleanup — never surface */
    }
  });
}

async function runPrPipeline(job: DiagramJob, controller: AbortController): Promise<void> {
  const { ctx, accountId, diagramId } = job;
  const prId = job.prId!;
  const pr = await getDiagramPrContext(ctx, accountId, prId);
  if (!pr || !pr.headSha) {
    await markDiagramFailed(ctx, accountId, diagramId, 'The pull request or its head commit is not known.');
    return;
  }
  // The head moved while this waited: the row's fingerprint names the OLD head.
  if (pr.headSha !== job.headSha) {
    await markDiagramRefused(ctx, accountId, diagramId, 'head_moved');
    return;
  }
  await markDiagramRunning(ctx, accountId, diagramId, { headSha: pr.headSha });
  const member = { prId, owner: pr.owner, name: pr.name, number: pr.number, headSha: pr.headSha };
  const diff = (await fetchMemberDiffs([member])).get(prId);
  if (!diff || diff.diff == null) {
    await markDiagramRefused(ctx, accountId, diagramId, 'unreadable');
    return;
  }
  // THE PRE-CHECK: no model and no checkout when the change has no data path to draw.
  const pre = diagramPrecheck(diff, { manual: job.trigger === 'manual' });
  if (pre != null) {
    await markDiagramRefused(ctx, accountId, diagramId, pre);
    return;
  }
  if (controller.signal.aborted) {
    await markDiagramCancelled(ctx, accountId, diagramId);
    return;
  }
  const worktrees = await withWorktreeOwner({ kind: 'diagram', accountId, prId }, () => prepareMemberWorktrees([member]));
  try {
    const path = worktrees.byPr.get(prId)?.path ?? null;
    if (!path) {
      await markDiagramRefused(ctx, accountId, diagramId, 'unreadable');
      return;
    }
    const promptPr: DiagramPromptPr = {
      ref: 'PR1',
      repoFullName: `${pr.owner}/${pr.name}`,
      number: pr.number,
      title: pr.title,
      state: pr.state === 'merged' ? 'merged' : 'open',
      headSha: pr.headSha,
      checkoutPath: path,
      changedFiles: diff.changedFiles,
      diff: diff.diff,
    };
    const nonce = pickReviewNonce(diagramUntrustedTexts([promptPr], null));
    await finishWithAgent(job, controller, {
      roots: [path],
      systemPrompt: prDiagramSystemPrompt(),
      prompt: buildPrDiagramPrompt({ pr: promptPr, nonce }),
      prId,
      design: designContextFor('pr', [promptPr]),
    });
  } finally {
    await worktrees.cleanup().catch(() => {});
  }
}

/** The live open + merged members of a tracker ticket (this account), with their repos. */
export async function liveStoryMembers(
  ctx: AgentContext,
  accountId: number,
  ident: string,
): Promise<Array<LiveMember & { owner: string; name: string; defaultBranch: string | null }>> {
  const parsed = parseTicketIdent(ident);
  if (parsed == null || parsed.kind === 'manual') return [];
  const members = await readLiveMembers(ctx, accountId, await jiraMemberIds(accountId, ident));
  const repos = await memberRepos(ctx, accountId, members);
  return members.flatMap((m) => {
    const r = repos.get(m.prId);
    return r ? [{ ...m, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch }] : [];
  });
}

async function runStoryPipeline(job: DiagramJob, controller: AbortController): Promise<void> {
  const { ctx, accountId, diagramId } = job;
  const ident = job.subject;
  const members = await liveStoryMembers(ctx, accountId, ident);
  if (members.length < 2) {
    await markDiagramRefused(ctx, accountId, diagramId, 'too_few_prs');
    return;
  }
  if (members.length > SEQUENCE_DIAGRAM_STORY_MAX_PRS) {
    await markDiagramRefused(ctx, accountId, diagramId, 'too_many_prs');
    return;
  }
  if (storyDiagramFingerprint(ident, members) !== job.fingerprint) {
    await markDiagramRefused(ctx, accountId, diagramId, 'head_moved');
    return;
  }
  await markDiagramRunning(ctx, accountId, diagramId, { members: toDiagramMembers(members) });

  const diffs = await fetchMemberDiffs(members);
  const readable = [...diffs.values()].filter((d) => d.diff != null);
  if (readable.length === 0) {
    await markDiagramRefused(ctx, accountId, diagramId, 'unreadable');
    return;
  }
  // THE PRE-CHECK over every member at once: the story has a data path if any member does.
  const pre = diagramPrecheck(
    { changedFiles: readable.flatMap((d) => d.changedFiles), diff: readable.map((d) => d.diff).join('\n') },
    { manual: job.trigger === 'manual' },
  );
  if (pre != null) {
    await markDiagramRefused(ctx, accountId, diagramId, pre);
    return;
  }
  if (controller.signal.aborted) {
    await markDiagramCancelled(ctx, accountId, diagramId);
    return;
  }
  const [worktrees, defaults, ticket] = await Promise.all([
    withWorktreeOwner({ kind: 'diagram', accountId, ticket: ident }, () => prepareMemberWorktrees(members.filter((m) => m.state === 'open'))),
    withWorktreeOwner({ kind: 'diagram', accountId, ticket: ident }, () => prepDefaultBranchCheckouts(
      members.filter((m) => m.state === 'merged').map((m) => ({ owner: m.owner, name: m.name, branch: m.defaultBranch })),
    )),
    jiraStoryFor(accountId, ident).catch(() => null),
  ]);
  try {
    const defaultByRepo = new Map(defaults.checkouts.map((c) => [`${c.owner}/${c.name}`.toLowerCase(), c.path]));
    const prs: DiagramPromptPr[] = members.map((m, i) => ({
      ref: `PR${i + 1}`,
      repoFullName: `${m.owner}/${m.name}`,
      number: m.number,
      title: m.title,
      state: m.state,
      headSha: m.headSha,
      checkoutPath:
        m.state === 'open'
          ? (worktrees.byPr.get(m.prId)?.path ?? null)
          : (defaultByRepo.get(`${m.owner}/${m.name}`.toLowerCase()) ?? null),
      changedFiles: diffs.get(m.prId)?.changedFiles ?? [],
      diff: diffs.get(m.prId)?.diff ?? null,
    }));
    const roots = [...new Set(prs.map((p) => p.checkoutPath).filter((p): p is string => p != null))];
    if (roots.length === 0) {
      await markDiagramRefused(ctx, accountId, diagramId, 'unreadable');
      return;
    }
    const promptTicket =
      ticket != null ? { key: ticket.key ?? null, title: ticket.title ?? null, description: ticket.description ?? null } : null;
    const nonce = pickReviewNonce(diagramUntrustedTexts(prs, promptTicket));
    await finishWithAgent(job, controller, {
      roots,
      systemPrompt: storyDiagramSystemPrompt(),
      prompt: buildStoryDiagramPrompt({ ticket: promptTicket, prs, nonce }),
      prId: null,
      design: designContextFor('story', prs),
    });
  } finally {
    await worktrees.cleanup().catch(() => {});
    await defaults.cleanup().catch(() => {});
  }
}

export async function reconcileDiagramsOnStartup(ctx: AgentContext): Promise<void> {
  const n = await reconcileOrphanedDiagrams(ctx);
  if (n > 0) ctx.log.info(`reconciled ${n} orphaned sequence diagram(s) -> failed`);
}

/** Test seam: the lane's contents, in launch order. */
export function _diagramLaneForTest(): Array<{ kind: SequenceDiagramKind; subject: string; trigger: SequenceDiagramTrigger }> {
  return lane.map((j) => ({ kind: j.kind, subject: j.subject, trigger: j.trigger }));
}
