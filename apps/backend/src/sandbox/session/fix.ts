// AI FIX ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions). The fix SUBJECT of the one session
// machine (manager.ts): an `ai_fixes` row (its status DERIVED from the phase, shared `aiFixStatusForPhase`),
// the PR's task, and the PR repository's patch only.
//
//   manual       booting ─► building ─► built ⇄ building      (Start runs the fix at once; follow-ups are
//                                                               more build turns in the SAME session)
//   Plan first   booting ─► chatting ─► ready ⇄ chatting ─(Start fix)─► building ─► built …
//   unattended   booting ─► building ─► closed: built           (an auto fix, dependency automation's fix)
//   Push (coding/ai-fix/push.ts) ends a live session as `pushed`; Discard as `discarded` (status cancelled).
//
// SCOPE (owner decision D3): the WHOLE workspace is mirrored at the reader's paths, memories as in
// Implement; the PR's repository is checked out at the PR's HEAD SHA, fetched through the base repository's
// `refs/pull/<n>/head` (a fork's head included); every other repository is on its default branch, and its
// edits are shown ("left out") and never stored as a patch.
//
// THE REPORT is a validated JSON file (workspace/fix-report.ts): the host reads it after every build turn,
// checks it with the same validator the in-sandbox checker runs, and normalises it against the extracted
// diff (review-seed.ts `normalizeChangeReport`) — the patch stays authoritative.
//
// THE MERGE (sandbox/session/fix-merge.ts; docs/SANDBOX.md § AI Fix sessions, "The merge"): a fix with the
// "Resolve merge conflicts" item resolves the base tip and the merge base on the host (`bases`), brings both
// commits into the PR repository and starts the merge before the agent starts (`afterMirror`), and after
// every build turn reads the agent's commits out as a bundle, which the host checks (`storeFixTurn`). Only a
// VALID merge is pushable; the row's `patch` is then the fix on top of the merge.
//
// ⚠ ONE FIX PER PR, claimed SYNCHRONOUSLY (`claimFixPr`) in the tick of the start's checks and released
//   on every bail path and on the close; `isFixRunning(prId)` reads it.
// ⚠ Nothing here pushes; the push is coding/ai-fix/push.ts (button-gated, or the existing automatic rules).
import {
  aiFixStatusForPhase,
  type AiFixLeftOutRepo,
  type AiFixProgress,
  type AiFixReviewItem,
  type AiFixTrigger,
  type SandboxSessionPhase,
  type StoryBuildSession,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { config } from '../../config.js';
import { aiFixBaseRef, dropAiFixBaseRefs } from '../../coding/story-build/base-refs.js';
import { normalizeChangeReport } from '../../coding/ai-fix/review-seed.js';
import { emitFixStream } from '../../coding/ai-fix/stream.js';
import { capDiff } from '../../coding/ai-fix/cap-diff.js';
import { isFixPushing } from '../../coding/ai-fix/push-guard.js';
import { getFixById, updateFixSession, type AiFixRow } from '../../coding/ai-fix/persist.js';
import type { FixAgentReport } from '../../platform/contract.js';
import type { SandboxAgentChoice } from '../drivers/index.js';
import { fixSessionBranch, readSessionTicket, type FixSeedInput, type RepoBaseRequest, type SessionTicket } from '../workspace/index.js';
import { readFixReport, removeFixReport } from '../workspace/fix-report.js';
import { defaultMirrorSeams } from '../workspace/mirror.js';
import {
  extractMergeTurn,
  fetchCommitIntoSandbox,
  fixRowHasWork,
  MERGE_BASE_REF,
  MERGE_ITEM_REF,
  MERGE_TARGET_REF,
  readMergeState,
  RESOLUTION_DIFF_MAX_CHARS,
  restoreMergeBundle,
  START_MERGE_FILE,
  startMergeInSandbox,
  type FixMergeState,
} from './fix-merge.js';
import type { MergePlan } from '../../coding/ai-fix/merge-host.js';
import type { MergeVerdict } from '../../coding/ai-fix/merge-verify.js';
import {
  addItem,
  closeSession,
  interruptLive,
  allowLiveHost,
  buildSession,
  liveFactsOf,
  liveSession,
  messageSession,
  newLive,
  notice,
  registerLive,
  releaseSessionSlot,
  reserveSessionSlot,
  restartState,
  resumeLive,
  scrub,
  sessionDeps,
  sessionSlotFree,
  NO_RUNTIME_LINE,
  SessionFail,
  subscribeLive,
  criteriaLines,
  openPointLines,
  type Listener,
  type Live,
  type ReserveResult,
  type ResumeResult,
  type SessionActionResult,
} from './manager.js';
import { extractRepoPatch, PatchTooLargeError, restoreRepoPatch } from './patches.js';
import { emptySessionState, readSessionState, toStoryBuildSession, type SessionStateJson } from './state.js';
import type { SessionKey, SessionSubject, SubjectLive } from './subject.js';

// ---- words --------------------------------------------------------------------------------------------

export const FIX_READER_START = 'Start fix';
export const FIX_READER_PLAN = 'Plan first';
export const PLAN_FIRST_TURN = 'Read FIX.md. Say how you will fix each item, and which items you will not fix and why. Do not change any file yet.';

/** The instruction of a build turn (the task and rules are in the seed; this starts the work). */
export function fixInstruction(o: { repoPath: string; afterPlan?: boolean; followUp?: string | null; extra?: string | null }): string {
  if (o.followUp != null) {
    return [
      'The reader adds:',
      o.followUp,
      '',
      `Change files only in \`${o.repoPath}\`. Run the repository's own checks again.`,
      'Then write the report again so it covers the whole change so far, and run the checker until it prints OK.',
    ].join('\n');
  }
  const lines = [
    `Start the fix now. Fix the items in FIX.md in \`${o.repoPath}\`.`,
    "Run the repository's own checks (typecheck, lint, tests) for the code you change.",
    'Then write the report as FIX.md says, and run the checker until it prints OK.',
  ];
  if (o.afterPlan) lines.unshift('The reader pressed Start fix. Follow the plan you agreed with the reader.');
  if (o.extra) lines.push('', 'The reader adds:', o.extra);
  return lines.join('\n');
}

// ---- seams ----------------------------------------------------------------------------------------------

export interface MergeRepoInput {
  fixId: number;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
}

export interface FixSessionDeps {
  /** The PR's ticket, for context (a manual fix only). Never fatal: null. */
  contextTicket(ctx: AgentContext, accountId: number, workspaceId: number, prId: number): Promise<SessionTicket | null>;
  /** The merge: the base tip (pinned; `baseSha` on Resume) and the merge base, from Limn's clone cache. */
  mergePlan(a: MergeRepoInput & { baseSha?: string | null }): Promise<MergePlan>;
  /** The host's check of the agent's commits (coding/ai-fix/merge-verify.ts), in Limn's clone cache. */
  verifyMerge(a: MergeRepoInput & { accountId?: number; baseSha: string; bundle: Buffer; conflictedFiles: readonly string[] }): Promise<MergeVerdict>;
}

const defaultFixDeps: FixSessionDeps = {
  async mergePlan(a) {
    const { resolveMergePlan } = await import('../../coding/ai-fix/merge-host.js');
    return resolveMergePlan(a);
  },
  async verifyMerge(a) {
    const { withMergeRepo, aiFixMergeRef } = await import('../../coding/ai-fix/merge-host.js');
    const { verifyMergeBundle } = await import('../../coding/ai-fix/merge-verify.js');
    try {
      // The token reaches only the lazy blob fetch of the host's diffs (merge-verify.ts `hostMergeView`).
      const token = a.accountId != null ? await (await import('../../auth/account.js')).getAccessToken(a.accountId).catch(() => null) : null;
      return await withMergeRepo({ ...a }, (gitDir) =>
        verifyMergeBundle({ gitDir, bundle: a.bundle, headSha: a.headSha, baseSha: a.baseSha, baseRef: a.baseRef, conflictedFiles: a.conflictedFiles, resultRef: aiFixMergeRef(a.fixId, 'result'), token }),
      );
    } catch {
      return { ok: false, reason: 'Limn could not read its own copy of the repository to check the merge.' };
    }
  },
  async contextTicket(ctx, accountId, workspaceId, prId) {
    try {
      const { getTicketSource } = await import('../../tracker/ticket-source.js');
      const tickets = await getTicketSource().ticketsForPr(accountId, prId);
      const first = tickets[0];
      if (!first) return null;
      return await readSessionTicket(ctx, accountId, workspaceId, first.ident);
    } catch {
      return null;
    }
  },
};

let fixDeps: FixSessionDeps = defaultFixDeps;

export function setFixSessionDepsForTests(d: Partial<FixSessionDeps> | null): void {
  fixDeps = d == null ? defaultFixDeps : { ...defaultFixDeps, ...d };
}

// ---- PR.diff ---------------------------------------------------------------------------------------------

/** PR.diff's budget: the agent has the whole repository at the head; the diff orients it. */
export const FIX_DIFF_MAX_CHARS = 1_000_000;

/** GitHub's PR diff → PR.diff: noise files (lockfiles, generated output) out, capped, the cut files named. */
export function capFixDiff(diff: string): { text: string; note: string | null } {
  const c = capDiff(diff, FIX_DIFF_MAX_CHARS);
  const notes: string[] = [];
  if (c.excludedFiles.length > 0) notes.push(c.excludedFiles.length === 1 ? 'One generated or lock file is left out of it.' : `${c.excludedFiles.length} generated or lock files are left out of it.`);
  if (c.omittedFiles.length > 0) notes.push(`It is cut: ${c.omittedFiles.length} files are not in it (${c.omittedFiles.slice(0, 20).join(', ')}${c.omittedFiles.length > 20 ? ', …' : ''}).`);
  if (diff.trim() === '') notes.push('GitHub did not give the diff: read the change with git in the repository.');
  return { text: c.diff === '' ? '' : `${c.diff}\n`, note: notes.length > 0 ? notes.join(' ') : null };
}

// ---- one fix per PR -------------------------------------------------------------------------------------

/** prId → the fix id holding it (booting through closed). */
const fixClaims = new Map<number, number | null>();

/** Take the PR, SYNCHRONOUSLY. false ⇒ a fix holds it. */
export function claimFixPr(prId: number): boolean {
  if (fixClaims.has(prId)) return false;
  fixClaims.set(prId, null);
  return true;
}

export function bindFixClaim(prId: number, fixId: number): void {
  fixClaims.set(prId, fixId);
}

export function releaseFixPr(prId: number, fixId?: number): void {
  const held = fixClaims.get(prId);
  if (held === undefined) return;
  if (fixId != null && held != null && held !== fixId) return;
  fixClaims.delete(prId);
}

/** A fix session holds the PR (starting, booting, or open): `isFixRunning`. */
export function fixHoldsPr(prId: number): boolean {
  return fixClaims.has(prId);
}

export function fixIdHoldingPr(prId: number): number | null {
  return fixClaims.get(prId) ?? null;
}

export const fixKey = (fixId: number): SessionKey => `fix:${fixId}`;

export function reserveFixSlot(fixKeyId: SessionKey, build: boolean): ReserveResult {
  return reserveSessionSlot(fixKeyId, { build });
}

export { releaseSessionSlot as releaseFixSlot, rekeySessionSlot as rekeyFixSlot } from './manager.js';

// ---- the unattended pre-check -------------------------------------------------------------------------------

export type FixSandboxReadiness =
  | { ok: true }
  | { ok: false; reason: 'no_runtime'; message: string }
  | { ok: false; reason: 'busy'; message: string };

/** How long one runtime detection answers the pre-check (it runs three CLI commands). */
const READINESS_TTL_MS = 30_000;
let detected: { runtime: unknown; at: number; available: boolean; problem: string | null } | null = null;

/**
 * Could an UNATTENDED fix start now? A container runtime, a free session and the free build slot. Asked by
 * the auto fix and dependency automation BEFORE their seed / claim, so a computer with no runtime records
 * one skip and a busy one writes nothing. ⚠ Never reserves anything: the start's own checks stay the
 * authority. The runtime's answer is reused for READINESS_TTL_MS (per runtime object). Never throws.
 */
export async function fixSandboxReadiness(): Promise<FixSandboxReadiness> {
  const deps = sessionDeps();
  const now = deps.now();
  try {
    const rt = deps.runtime();
    if (!detected || detected.runtime !== rt || now - detected.at >= READINESS_TTL_MS || now < detected.at) {
      const d = await rt.detect();
      detected = { runtime: rt, at: now, available: d.available, problem: d.problem ?? null };
    }
  } catch (err) {
    detected = null;
    return { ok: false, reason: 'no_runtime', message: err instanceof Error ? err.message.split('\n')[0]! : NO_RUNTIME_LINE };
  }
  if (!detected.available) return { ok: false, reason: 'no_runtime', message: detected.problem ?? NO_RUNTIME_LINE };
  const free = sessionSlotFree({ build: true });
  if (!free.ok) return { ok: false, reason: 'busy', message: free.reason === 'too_many' ? free.message : 'Another sandbox session is building.' };
  return { ok: true };
}

/** Test hook: forget the cached runtime answer. */
export function _resetFixReadinessForTest(): void {
  detected = null;
}

// ---- start ----------------------------------------------------------------------------------------------

export interface FixSessionStart {
  fixId: number;
  accountId: number;
  workspaceId: number;
  memberRepoIds: readonly number[];
  pr: {
    prId: number;
    repoId: number;
    number: number;
    owner: string;
    name: string;
    title: string;
    body: string | null;
    headRef: string;
    baseRef: string;
    headSha: string;
  };
  choice: SandboxAgentChoice;
  planFirst: boolean;
  unattended: boolean;
  trigger: AiFixTrigger;
  task: { kind: 'review' | 'plain'; text: string };
  shownRefs: string[];
  diff: { text: string; note: string | null };
  nonce: string;
  /** The "Resolve merge conflicts" item: merge this base branch first. null ⇒ no merge. */
  merge?: { baseRef: string } | null;
}

/** What the state keeps about the fix, so Resume and the wire need no GitHub call. */
interface FixFacts {
  prId: number;
  prRepoId: number;
  number: number;
  fullName: string;
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  trigger: AiFixTrigger;
  taskKind: 'review' | 'plain';
  shownRefs: string[];
  nonce: string;
  diffNote: string | null;
  /** The merge item's base branch (the commits are in `ai_fixes.merge_json`). Absent ⇒ no merge. */
  mergeBaseRef?: string | null;
}

type FixState = SessionStateJson & { fix?: FixFacts };

/**
 * Register the session and boot it (the caller holds the PR claim and the reserved slot, and wrote the
 * row with `insertQueuedFix({ session })`). Same tick: the stream never misses the start.
 */
export function startFixSession(ctx: AgentContext, a: FixSessionStart): void {
  const state = emptySessionState(a.planFirst ? 'fix_plan' : 'fix') as FixState;
  state.subject = 'fix';
  state.unattended = a.unattended;
  state.leftOut = [];
  state.fix = {
    prId: a.pr.prId,
    prRepoId: a.pr.repoId,
    number: a.pr.number,
    fullName: `${a.pr.owner}/${a.pr.name}`,
    title: a.pr.title,
    body: a.pr.body,
    headRef: a.pr.headRef,
    baseRef: a.pr.baseRef,
    headSha: a.pr.headSha,
    trigger: a.trigger,
    taskKind: a.task.kind,
    shownRefs: a.shownRefs,
    nonce: a.nonce,
    diffNote: a.diff.note,
    ...(a.merge ? { mergeBaseRef: a.merge.baseRef } : {}),
  };
  bindFixClaim(a.pr.prId, a.fixId);
  const subject = fixSubject(ctx, { fixId: a.fixId, accountId: a.accountId, facts: state.fix, task: a.task, diff: a.diff.text, unattended: a.unattended, planFirst: a.planFirst });
  const l = newLive(ctx, subject, { accountId: a.accountId, workspaceId: a.workspaceId, choice: a.choice, state, resume: false });
  registerLive(l, a.memberRepoIds);
}

// ---- the subject ------------------------------------------------------------------------------------------

const PROGRESS_TOOLS = 5;

function fixSubject(
  ctx: AgentContext,
  o: { fixId: number; accountId: number; facts: FixFacts; task: { kind: 'review' | 'plain'; text: string }; diff: string; unattended: boolean; planFirst: boolean },
): SessionSubject {
  const { fixId, accountId, facts } = o;
  const unattended = o.unattended;
  let prRepoPath: string | null = null;
  let contextTicket: SessionTicket | null = null;
  let pushedAt: Date | number | null = null;
  // The merge (fix-merge.ts), once `bases` resolved it; written to `ai_fixes.merge_json` as it changes.
  let merge: FixMergeState | null = null;
  const saveMerge = (extra: { mergeBundle?: string | null } = {}): Promise<void> =>
    updateFixSession(ctx, accountId, fixId, { mergeJson: merge as unknown as Record<string, unknown>, ...extra });
  const stateOf = (l: SubjectLive): FixState => (l as Live).state as FixState;
  const row = (): Promise<AiFixRow | null> => getFixById(ctx, accountId, fixId);

  const subject: SessionSubject = {
    kind: 'fix',
    rowId: fixId,
    idPrefix: 'fx',
    bootStep: 'task',
    usage: { repoId: facts.prRepoId, prId: facts.prId, features: { chat: 'ai_fix_plan', build: 'ai_fix' } },
    maxTurns: config.aiFixMaxTurns,
    // An unattended run has nobody to press Stop: Claude's own US$ cap bounds its one build turn (its
    // process ends with the session). A manual session is the reader's to stop; Codex has no such flag.
    ...(unattended ? { maxBudgetUsd: config.aiFixBudgetUsd } : {}),
    async save(l, p) {
      if (p.phase === 'discarded') pushedAt = (await row())?.pushedAt ?? pushedAt;
      await updateFixSession(ctx, accountId, fixId, {
        ...(p.phase ? { sessionPhase: p.phase, status: aiFixStatusForPhase(p.phase, { pushed: pushedAt != null }) } : {}),
        ...(p.sessionJson ? { sessionJson: stateOf(l) as unknown as Record<string, unknown> } : {}),
        ...(p.error !== undefined ? { error: p.error } : {}),
        ...(p.sandboxRef !== undefined ? { sandboxRef: p.sandboxRef } : {}),
        ...(p.agentRef !== undefined ? { agentRef: p.agentRef } : {}),
        ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
        ...(p.completedAt !== undefined ? { finishedAt: p.completedAt } : {}),
        ...(p.lastActiveAt !== undefined ? { lastActiveAt: p.lastActiveAt } : {}),
      });
    },
    async addSpend(_l, mode, usage) {
      const r = await row();
      if (r == null) return;
      const cost = usage?.costUsd ?? null;
      await updateFixSession(ctx, accountId, fixId, {
        ...(cost != null && mode === 'chat' ? { planCostUsd: (r.planCostUsd ?? 0) + cost } : {}),
        ...(cost != null && mode === 'build' ? { costUsd: (r.costUsd ?? 0) + cost } : {}),
        inputTokens: (r.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
        outputTokens: (r.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
        numTurns: (r.numTurns ?? 0) + 1,
      });
    },
    async hasStoredWork() {
      const r = await row();
      return r != null && fixRowHasWork(r) && r.pushedAt == null;
    },
    async readSubject(l) {
      const state = stateOf(l);
      // The ticket, for context only, on a MANUAL fix (an unattended agent must not drift into it).
      contextTicket = unattended ? null : await fixDeps.contextTicket(ctx, accountId, l.workspaceId, facts.prId).catch(() => null);
      state.criteria = contextTicket ? criteriaLines(contextTicket) : [];
      state.openPoints = contextTicket ? openPointLines(contextTicket) : [];
      return `#${facts.number} at ${facts.headSha.slice(0, 7)}`;
    },
    async repoIds(memberRepoIds) {
      return [...new Set([...memberRepoIds, facts.prRepoId])];
    },
    async bases(l, repos) {
      if (facts.mergeBaseRef) {
        // THE MERGE'S COMMITS, on the host: the base tip (Resume keeps the one picked at the start) and the
        // merge base. Before the mirror, so FIX.md can name them.
        const pr = repos.find((r) => r.repoId === facts.prRepoId);
        if (!pr) throw new SessionFail(`${facts.fullName} is not in this workspace.`);
        const kept = l.resume ? readMergeState((await row())?.mergeJson ?? null) : null;
        let plan: MergePlan;
        try {
          plan = await fixDeps.mergePlan({ fixId, owner: pr.owner, name: pr.name, prNumber: facts.number, headSha: facts.headSha, baseRef: facts.mergeBaseRef, baseSha: kept?.baseSha ?? null });
        } catch (err) {
          throw new SessionFail(err instanceof Error ? err.message.split('\n')[0]! : `${facts.mergeBaseRef} could not be read.`);
        }
        merge = kept && kept.baseSha === plan.baseSha
          ? { ...kept, mergeBaseSha: plan.mergeBaseSha }
          : { baseRef: facts.mergeBaseRef, baseSha: plan.baseSha, mergeBaseSha: plan.mergeBaseSha, headSha: facts.headSha, conflictedFiles: [], status: 'pending', reason: null, mergeSha: null, resultSha: null, resolutionDiff: null, resolutionFiles: [] };
        await saveMerge();
      }
      const bases = new Map<number, RepoBaseRequest>();
      const labels = new Map<number, { label: string; note: string | null }>();
      for (const r of repos) {
        const pinRef = aiFixBaseRef(fixId, r.repoId);
        if (r.repoId === facts.prRepoId) {
          bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: facts.headRef, baseSha: facts.headSha, remoteRef: `refs/pull/${facts.number}/head`, pinRef });
          labels.set(r.repoId, { label: `PR #${facts.number}'s head, ${facts.headRef},`, note: 'This is the repository AI Fix pushes.' });
        } else {
          bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: 'HEAD', baseSha: null, pinRef });
          labels.set(r.repoId, { label: r.defaultBranch ?? 'the default branch', note: 'Read only: edits here are left out.' });
        }
      }
      return { bases, labels };
    },
    branch: () => fixSessionBranch(facts.number),
    seed(layout) {
      const at = layout.repos.find((r) => r.repoId === facts.prRepoId);
      if (!at) throw new SessionFail(`${facts.fullName} is not in this workspace's layout.`);
      const fix: FixSeedInput = {
        pr: { number: facts.number, title: facts.title, body: facts.body, headRef: facts.headRef, baseRef: facts.baseRef, repoFullName: facts.fullName, repoPath: at.path, headSha: facts.headSha },
        task: o.task,
        shownRefs: facts.shownRefs,
        diff: { text: o.diff, note: facts.diffNote },
        planFirst: o.planFirst,
        unattended,
        nonce: facts.nonce,
        contextTicket,
        merge: merge ? { baseRef: merge.baseRef, baseSha: merge.baseSha, mergeBaseSha: merge.mergeBaseSha, startScript: START_MERGE_FILE } : null,
      };
      return { fix };
    },
    async afterMirror(l, mirror, bases) {
      const at = mirror.repos.find((r) => r.repoId === facts.prRepoId);
      if (!at) {
        const why = mirror.failed.find((f) => f.repoId === facts.prRepoId)?.reason ?? 'it could not be cloned';
        throw new SessionFail(`The pull request's repository could not be cloned: ${why}`);
      }
      prRepoPath = at.path;
      if (merge && l.container) await prepareMerge(l as Live, at.path, bases.get(facts.prRepoId));
    },
    async restore(l, mirror) {
      const r = await row();
      const at = mirror.repos.find((m) => m.repoId === facts.prRepoId);
      if (merge && r?.mergeBundle && at && l.container) {
        // A merge's commits come back as commits (never as a patch over the merge).
        await restoreMergeBundle((l as Live).runtime, l.container, at.path, Buffer.from(r.mergeBundle, 'base64'));
        return 1;
      }
      if (!r?.patch || !at || !l.container) return 0;
      await restoreRepoPatch((l as Live).runtime, l.container, at.path, r.patch, r.commitMessage?.trim() || 'AI fix: the work so far', 1);
      return 1;
    },
    startMode: (l) => (l.resume || stateOf(l).action === 'fix' ? 'build' : 'chat'),
    firstTurn(l) {
      const path = prRepoPath ?? facts.fullName;
      if (stateOf(l).action === 'fix_plan') return { build: false, readerText: FIX_READER_PLAN, text: async () => PLAN_FIRST_TURN };
      return { build: true, readerText: FIX_READER_START, text: async () => fixInstruction({ repoPath: path }) };
    },
    async buildInstruction(l, extra) {
      stateOf(l).action = 'fix';
      return fixInstruction({ repoPath: prRepoPath ?? facts.fullName, afterPlan: true, extra });
    },
    followUpText: (_l, text) => fixInstruction({ repoPath: prRepoPath ?? facts.fullName, followUp: text }),
    busyReason: () => (isFixPushing(fixId) ? 'Wait for the push to finish.' : null),
    async beforeBuildTurn(l) {
      if (l.container && l.layoutRoot) await removeFixReport((l as Live).runtime, l.container, l.layoutRoot);
    },
    async afterBuildTurn(l0) {
      const l = l0 as Live;
      if (merge) await storeMergeTurn(l);
      else await storeFixTurn(ctx, l, { fixId, accountId, facts, prRepoPath });
      return unattended ? 'close' : 'keep';
    },
    onPhase(l, phase) {
      const status = aiFixStatusForPhase(phase, { pushed: pushedAt != null });
      if (status === 'running') emitFixStream(facts.prId, { type: 'progress', status, fixId, progress: progressOf(l as Live, phase) });
      else emitFixStream(facts.prId, { type: 'done', status, fixId });
    },
    async onClosed(l, phase) {
      releaseFixPr(facts.prId, fixId);
      const state = stateOf(l);
      if (phase === 'discarded' || phase === 'failed' || phase === 'pushed') {
        await dropAiFixBaseRefs(state.repos.map((r) => r.fullName), fixId).catch(() => {});
        // The merge's commits are kept only while the fix can still be pushed.
        if (merge) await updateFixSession(ctx, accountId, fixId, { mergeBundle: null }).catch(() => {});
      }
      // An AUTO fix that finished may be pushed automatically (auto-push.ts decides: the workspace's
      // "Push automatically", own PR only, never forced). Off the session: a push is not a turn.
      // ⚠ ONLY the unattended run's own close: a RESUMED auto fix is the reader's session (Resume sets
      // `unattended: false`), so its close never pushes, and an automatic push that failed once is
      // never retried by a later close.
      if (phase === 'built' && unattended && facts.trigger === 'auto') {
        const r = await row();
        if (r?.status === 'succeeded' && fixRowHasWork(r)) {
          const { maybeAutoPushFix } = await import('../../coding/ai-fix/auto-push.js');
          void maybeAutoPushFix(ctx, { accountId, fixId }).catch(() => {});
        }
      }
    },
  };

  /** After the mirror: the base tip and the merge base into the PR repository, then Limn starts the merge. */
  async function prepareMerge(l: Live, repoPath: string, req: RepoBaseRequest | undefined): Promise<void> {
    const m = merge!;
    if (!req || !l.container) throw new SessionFail('The pull request\'s repository is not ready for the merge.');
    const seams = sessionDeps().mirrorSeams ?? defaultMirrorSeams;
    const { aiFixMergeRef } = await import('../../coding/ai-fix/merge-host.js');
    const want: Array<{ ref: string; sha: string; pin: 'base' | 'merge-base' }> = [
      { ref: MERGE_TARGET_REF, sha: m.baseSha, pin: 'base' },
      { ref: MERGE_BASE_REF, sha: m.mergeBaseSha, pin: 'merge-base' },
    ];
    try {
      for (const w of want) {
        const source = await seams.prepare({ repoId: req.repoId, owner: req.owner, name: req.name, baseRef: m.baseRef, baseSha: w.sha, remoteRef: `refs/heads/${m.baseRef}`, pinRef: aiFixMergeRef(fixId, w.pin) });
        try {
          await fetchCommitIntoSandbox(l.runtime, l.container, repoPath, w.ref, source, (d) => seams.tarGitDir(d));
        } finally {
          await source.cleanup().catch(() => {});
        }
      }
      // Resume with stored commits: `restore` puts them back; the merge is not started again.
      const r = l.resume ? await row() : null;
      if (r?.mergeBundle) return;
      m.conflictedFiles = await startMergeInSandbox(l.runtime, l.container, repoPath, m.baseRef);
    } catch (err) {
      throw new SessionFail(`The merge of ${m.baseRef} could not be started: ${scrub(err)}`);
    }
    await saveMerge();
    const n = m.conflictedFiles.length;
    notice(
      l,
      n === 0
        ? `Limn started the merge of ${m.baseRef} (${m.baseSha.slice(0, 7)}). Git found no conflicts; the agent still makes the merge commit.`
        : `Limn started the merge of ${m.baseRef} (${m.baseSha.slice(0, 7)}): ${n === 1 ? 'one file is' : `${n} files are`} in conflict (${m.conflictedFiles.slice(0, 8).join(', ')}${n > 8 ? ', …' : ''}).`,
    );
  }

  /** After a build turn of a fix with the merge: the commits out, the host's check, the fix on top, the report. */
  async function storeMergeTurn(l: Live): Promise<void> {
    const m = merge!;
    if (!l.container || !prRepoPath || !l.layoutRoot) return;
    let patch = '';
    let files: string[] = [];
    let gitMessage: string | null = null;
    let error: string | null = null;
    let bundle: string | null = null;
    try {
      const ex = await extractMergeTurn(l.runtime, l.container, prRepoPath, { maxPatchBytes: config.aiFixPatchMaxBytes });
      patch = ex.fix.patch;
      files = ex.fix.filesChanged;
      gitMessage = ex.fix.commitMessage;
      m.mergeSha = null;
      m.resultSha = null;
      m.resolutionDiff = ex.resolutionDiff;
      m.resolutionFiles = ex.resolutionFiles;
      if (ex.merging) m.reason = 'The merge is not finished: the agent did not commit it.';
      else if (ex.mergeSha == null) m.reason = 'The agent made no merge commit.';
      else if (ex.bundleTooLarge) m.reason = 'The merge is larger than Limn keeps (4 MB).';
      else if (ex.bundle == null) m.reason = 'Limn could not read the merge out of the sandbox.';
      else {
        const pr = facts.fullName.split('/');
        const v = await fixDeps.verifyMerge({ fixId, accountId, owner: pr[0]!, name: pr.slice(1).join('/'), prNumber: facts.number, headSha: m.headSha, baseRef: m.baseRef, baseSha: m.baseSha, bundle: ex.bundle, conflictedFiles: m.conflictedFiles });
        if (!v.ok) m.reason = v.reason;
        else if (v.mergeSha !== ex.mergeSha || v.resultSha !== ex.outSha) m.reason = 'The commits Limn checked are not the ones in the sandbox.';
        else if (Buffer.byteLength(v.view.fixPatch, 'utf8') > config.aiFixPatchMaxBytes) m.reason = new PatchTooLargeError(Buffer.byteLength(v.view.fixPatch, 'utf8'), config.aiFixPatchMaxBytes).message;
        else {
          m.reason = null;
          m.mergeSha = v.mergeSha;
          m.resultSha = v.resultSha;
          // ⚠ WHAT THE READER REVIEWS IS THE HOST'S (merge-verify.ts `HostMergeView`), from the verified
          // commits Push sends — never the sandbox's own diffs, which the agent's machine wrote.
          patch = v.view.fixPatch;
          files = v.view.fixFiles;
          m.conflictedFiles = v.view.conflictedFiles;
          m.resolutionFiles = v.view.resolutionFiles;
          m.resolutionDiff =
            v.view.resolutionDiff.length > RESOLUTION_DIFF_MAX_CHARS
              ? `${v.view.resolutionDiff.slice(0, RESOLUTION_DIFF_MAX_CHARS)}\n… (cut: the resolution is longer than Limn shows)\n`
              : v.view.resolutionDiff;
          bundle = ex.bundle.toString('base64');
        }
      }
      m.status = m.reason == null ? 'valid' : ex.mergeSha == null && !ex.merging ? 'missing' : 'invalid';
    } catch (err) {
      error = err instanceof PatchTooLargeError ? err.message : scrub(err);
      m.status = 'invalid';
      m.reason = error;
      notice(l, `${facts.fullName}: ${error}`);
    }
    await saveMerge({ mergeBundle: bundle });
    notice(
      l,
      m.status === 'valid'
        ? `Limn checked the merge commit: ${m.baseRef} is merged${m.conflictedFiles.length > 0 ? ` and ${m.conflictedFiles.length === 1 ? 'the conflict is' : `the ${m.conflictedFiles.length} conflicts are`} resolved` : ''}.`
        : `Nothing will be pushed: ${m.reason}`,
    );
    await storeFixTurn(ctx, l, { fixId, accountId, facts, prRepoPath }, { patch, files, gitMessage, error, merge: m });
  }

  return subject;
}

/** The shown AiFix progress of a live session (the AiFixBanner's words). */
function progressOf(l: Live, phase: SandboxSessionPhase): AiFixProgress {
  if (phase === 'booting') return { phase: 'cloning' };
  const recent = l.state.conversation
    .filter((c) => c.kind === 'tool')
    .slice(-PROGRESS_TOOLS)
    .map((c) => (c.kind === 'tool' ? c.summary : ''));
  return { phase: phase === 'chatting' ? 'planning' : 'fixing', ...(recent.length > 0 ? { recentActivity: recent } : {}) };
}

/** After a build turn: the PR repository's patch + the report, normalised; every other edit left out. */
async function storeFixTurn(
  ctx: AgentContext,
  l: Live,
  o: { fixId: number; accountId: number; facts: FixFacts; prRepoPath: string | null },
  // A fix with the merge: the fix ON TOP of the merge, already read out (storeMergeTurn).
  pre?: { patch: string; files: string[]; gitMessage: string | null; error: string | null; merge: FixMergeState },
): Promise<void> {
  if (!l.container || !o.prRepoPath || !l.layoutRoot) return;
  const state = l.state as FixState;
  let patch = pre?.patch ?? '';
  let files: string[] = pre?.files ?? [];
  let gitMessage: string | null = pre?.gitMessage ?? null;
  let error: string | null = pre?.error ?? null;
  if (pre == null) {
    try {
      const got = await extractRepoPatch(l.runtime, l.container, o.prRepoPath, { maxBytes: config.aiFixPatchMaxBytes });
      patch = got.patch;
      files = got.filesChanged;
      gitMessage = got.commitMessage;
    } catch (err) {
      error = err instanceof PatchTooLargeError ? err.message : scrub(err);
      notice(l, `${o.facts.fullName}: ${error}`);
    }
  }

  let report: FixAgentReport & { summary?: string; commitMessage?: string } | undefined;
  // The report may cite the files the MERGE resolved: they are in the merge commit, not in the fix's patch.
  const reportFiles = pre ? [...new Set([...files, ...pre.merge.resolutionFiles, ...pre.merge.conflictedFiles])] : files;
  const read = await readFixReport(l.runtime, l.container, l.layoutRoot, o.facts.shownRefs, reportFiles);
  if (read.kind === 'ok' && read.check.report) {
    report = read.check.report;
    const n = read.check.contentProblems.length;
    if (n > 0) notice(l, `The report has ${n === 1 ? 'a problem' : `${n} problems`}, so Limn left those parts out: ${read.check.contentProblems[0]}`);
  } else if (read.kind === 'ok') {
    notice(l, `The agent did not hand in a valid report: ${read.check.shapeProblems[0] ?? 'its shape is wrong'}`);
  } else if (read.kind === 'missing') {
    notice(l, 'The agent did not hand in a report, so no item reads as addressed.');
  } else {
    notice(l, `The agent did not hand in a valid report: ${read.reason}`);
  }
  let changeReport = normalizeChangeReport(report, o.facts.shownRefs, reportFiles);
  // LIMN'S CHECK WINS over the agent's word: a merge that is not valid is MERGE "not addressed", with why.
  if (pre && pre.merge.status !== 'valid') {
    changeReport = {
      changes: changeReport.changes.map((c) => ({ ...c, refs: c.refs.filter((r) => r !== MERGE_ITEM_REF) })),
      unaddressed: [{ ref: MERGE_ITEM_REF, reason: `Limn: ${pre.merge.reason ?? 'the merge is not ready.'}` }, ...changeReport.unaddressed.filter((u) => u.ref !== MERGE_ITEM_REF)],
      notReported: changeReport.notReported.filter((r) => r !== MERGE_ITEM_REF),
    };
  }
  const lastText = l.lastAgentText.trim().slice(0, 4_000);
  const summary = report?.summary?.trim() || lastText || (files.length > 0 ? `Applied changes to ${files.length} file(s).` : 'The agent made no changes.');
  await updateFixSession(ctx, o.accountId, o.fixId, {
    summary,
    commitMessage: report?.commitMessage?.trim() || gitMessage || 'AI fix',
    patch: patch === '' ? null : patch,
    filesChanged: JSON.stringify(files),
    changeReport: JSON.stringify(changeReport),
    error,
    finishedAt: new Date(),
  });

  // Every OTHER mirrored repository: the files it changed, shown and never stored as a patch.
  const leftOut: AiFixLeftOutRepo[] = [];
  for (const r of state.repos) {
    if (r.repoId === o.facts.prRepoId) continue;
    try {
      const got = await extractRepoPatch(l.runtime, l.container, r.path, { maxBytes: Number.POSITIVE_INFINITY });
      if (got.filesChanged.length > 0) leftOut.push({ repoId: r.repoId, fullName: r.fullName, files: got.filesChanged.slice(0, 200) });
    } catch {
      /* a repository that cannot be read has nothing to show */
    }
  }
  state.leftOut = leftOut;
  for (const x of leftOut) {
    notice(l, `Changes in ${x.fullName} (${x.files.length} ${x.files.length === 1 ? 'file' : 'files'}) are left out. AI Fix pushes only ${o.facts.fullName}.`);
  }
  if (error == null) {
    const onTop = pre ? ' on top of the merge' : '';
    notice(l, files.length > 0 ? `Changes stored${onTop}: ${o.facts.fullName} (${files.length} ${files.length === 1 ? 'file' : 'files'}).` : `The fix changed no files${onTop} in ${o.facts.fullName}.`);
  }
}

// ---- actions (the routes call these; each reads the row, account-scoped, FIRST) ---------------------------

const rowIsSession = (ctx: AgentContext, accountId: number, fixId: number) => async (): Promise<boolean> => {
  const r = await getFixById(ctx, accountId, fixId);
  return r != null && r.sessionPhase != null;
};

/** One reader message (chat before Start fix, a build turn after). */
export function sendFixMessage(ctx: AgentContext, accountId: number, fixId: number, text: string): Promise<SessionActionResult> {
  return messageSession(fixKey(fixId), accountId, text, rowIsSession(ctx, accountId, fixId));
}

/** Start fix (Plan first). */
export async function startFixBuild(ctx: AgentContext, accountId: number, fixId: number, extra: string | null): Promise<SessionActionResult> {
  const l = liveSession(fixKey(fixId));
  if (l && l.accountId === accountId && l.driver?.mode() === 'build') return { status: 'not_ready', message: 'The fix has started. Send the agent a message instead.' };
  return buildSession(fixKey(fixId), accountId, extra, rowIsSession(ctx, accountId, fixId), FIX_READER_START);
}

export function allowFixHost(ctx: AgentContext, accountId: number, fixId: number, rule: string, scope: 'session' | 'workspace') {
  return allowLiveHost(fixKey(fixId), accountId, rule, scope, rowIsSession(ctx, accountId, fixId));
}

/**
 * Stop (`POST …/ai-fix/cancel`). A MANUAL session: the turn stops, the session stays (its changes so far
 * are extracted). An UNATTENDED one: stopped AND closed as discarded — status `cancelled`, so a person's
 * cancel wins over dependency automation's push. A session still booting is closed (nothing to keep).
 */
export async function stopFixSession(ctx: AgentContext, accountId: number, prId: number): Promise<boolean> {
  const fixId = fixIdHoldingPr(prId);
  if (fixId == null) return false;
  const l = liveSession(fixKey(fixId));
  if (!l || l.accountId !== accountId || l.closing) return false;
  const st = l.state as FixState;
  if (l.driver == null || st.unattended) {
    await l.driver?.interrupt().catch(() => {});
    void closeSession(l, { phase: 'discarded', error: null });
    return true;
  }
  const r = await interruptLive(fixKey(fixId), accountId, rowIsSession(ctx, accountId, fixId));
  return r.status === 'stopping';
}

export type FixDiscardResult = { status: 'discarded' } | { status: 'not_ready' } | { status: 'not_found' };

/** Discard: close the session (any phase, except while a push runs); nothing is pushed. */
export async function discardFixSession(ctx: AgentContext, accountId: number, fixId: number): Promise<FixDiscardResult> {
  const r = await getFixById(ctx, accountId, fixId);
  if (r == null) return { status: 'not_found' };
  if (isFixPushing(fixId)) return { status: 'not_ready' };
  if (r.sessionPhase == null) {
    // A plan of the removed shell-less flow, still waiting: it ends as it always did.
    if (r.status !== 'planned') return { status: 'not_ready' };
    const { markPlanDiscarded } = await import('../../coding/ai-fix/persist.js');
    return (await markPlanDiscarded(ctx, accountId, fixId)) ? { status: 'discarded' } : { status: 'not_ready' };
  }
  const l = liveSession(fixKey(fixId));
  if (l && l.accountId === accountId) {
    await closeSession(l, { phase: 'discarded', error: null });
    return { status: 'discarded' };
  }
  if (r.sessionPhase !== 'discarded') {
    await updateFixSession(ctx, accountId, fixId, {
      sessionPhase: 'discarded',
      status: aiFixStatusForPhase('discarded', { pushed: r.pushedAt != null }),
      sandboxRef: null,
      finishedAt: new Date(),
      ...(r.mergeBundle ? { mergeBundle: null } : {}),
    });
  }
  const state = readSessionState(r.sessionJson);
  await dropAiFixBaseRefs(state.repos.map((x) => x.fullName), fixId).catch(() => {});
  return { status: 'discarded' };
}

/** A push landed (push.ts): the live session ends as `pushed`; a closed one is recorded so. */
export async function closeFixAfterPush(ctx: AgentContext, accountId: number, fixId: number): Promise<void> {
  const l = liveSession(fixKey(fixId));
  if (l && l.accountId === accountId) {
    if (!l.closing) {
      addItem(l, { kind: 'notice', text: 'Pushed. The session is closed.' });
      await closeSession(l, { phase: 'pushed', error: null });
    } else await l.closed?.catch(() => {});
  }
  const r = await getFixById(ctx, accountId, fixId);
  if (r?.mergeBundle) await updateFixSession(ctx, accountId, fixId, { mergeBundle: null });
  if (r?.sessionPhase != null && r.sessionPhase !== 'pushed') {
    await updateFixSession(ctx, accountId, fixId, { sessionPhase: 'pushed', status: 'succeeded', sandboxRef: null });
    const state = readSessionState(r.sessionJson);
    await dropAiFixBaseRefs(state.repos.map((x) => x.fullName), fixId).catch(() => {});
  }
}

/** A turn runs in the fix's live session now (push.ts refuses to push meanwhile). */
export function fixTurnRunning(fixId: number): boolean {
  const l = liveSession(fixKey(fixId));
  return l != null && (l.turn || l.driver?.busy() === true || l.driver == null) && !l.closing;
}

/**
 * Resume: a closed, unpushed `built` row with a patch boots again at its base with the patch put back.
 * The reader took over: it is a manual session from now on, and its first turn is the reader's message.
 */
export async function resumeFixSession(ctx: AgentContext, accountId: number, fixId: number, choice: SandboxAgentChoice): Promise<ResumeResult> {
  const r = await getFixById(ctx, accountId, fixId);
  if (r == null || r.sessionPhase == null) return { status: 'not_found' };
  if (liveSession(fixKey(fixId))) return { status: 'not_ready', message: 'This session is running.' };
  if (isFixPushing(fixId)) return { status: 'not_ready', message: 'Wait for the push to finish.' };
  if (r.sessionPhase !== 'built' || !fixRowHasWork(r) || r.pushedAt != null) {
    return { status: 'not_resumable', message: 'Only a fix with stored changes that is not pushed can be resumed. Start a new fix instead.' };
  }
  const state = readSessionState(r.sessionJson) as FixState;
  const facts = state.fix;
  if (!facts) return { status: 'not_resumable', message: 'This fix cannot be resumed. Start a new fix instead.' };
  if (!claimFixPr(r.prId)) return { status: 'not_ready', message: 'Another fix is running on this pull request.' };
  bindFixClaim(r.prId, fixId);
  let out: ResumeResult | null;
  try {
    const diff = await ctx.github.fetchPrDiff(accountId, facts.fullName.split('/')[0]!, facts.fullName.split('/').slice(1).join('/'), facts.number).catch(() => '');
    const capped = capFixDiff(diff);
    state.boot = [];
    state.services = null;
    state.unattended = false;
    state.action = 'fix';
    out = await resumeLive(() => {
      const subject = fixSubject(ctx, { fixId, accountId, facts, task: { kind: facts.taskKind, text: r.prompt ?? '' }, diff: capped.text, unattended: false, planFirst: false });
      return newLive(ctx, subject, { accountId, workspaceId: r.workspaceId ?? 0, choice, state, resume: true });
    });
  } catch (err) {
    // ⚠ Every bail path gives the PR back, or this PR's fixer wedges for the process's lifetime.
    if (!liveSession(fixKey(fixId))) releaseFixPr(r.prId, fixId);
    throw err;
  }
  if (out != null) {
    releaseFixPr(r.prId, fixId);
    return out;
  }
  await updateFixSession(ctx, accountId, fixId, { unattended: false });
  return { status: 'queued', id: fixId };
}

// ---- the wire and the stream ------------------------------------------------------------------------------

export interface FixSessionWire {
  session: StoryBuildSession | null;
  leftOut: AiFixLeftOutRepo[];
}

/** `AiFix.session` + `leftOut` of one row (null session on a row of the removed fixer). */
export function fixSessionWire(r: AiFixRow): FixSessionWire {
  if (r.sessionPhase == null) return { session: null, leftOut: [] };
  const l = liveSession(fixKey(r.id));
  const state = (l ? l.state : readSessionState(r.sessionJson)) as FixState;
  const session = toStoryBuildSession(
    {
      sessionPhase: l ? l.phase : r.sessionPhase,
      runtime: r.runtime ?? null,
      provider: r.provider ?? null,
      model: r.model,
      effort: r.effort ?? null,
      planCostUsd: r.planCostUsd ?? null,
      buildCostUsd: r.costUsd ?? null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      numTurns: r.numTurns,
    },
    state,
    l ? liveFactsOf(l) : null,
    fixRowHasWork(r) && r.pushedAt == null,
  );
  return { session, leftOut: state.leftOut ?? [] };
}

export function subscribeFixSession(fixId: number, accountId: number, fn: Listener): (() => void) | null {
  return subscribeLive(fixKey(fixId), accountId, fn);
}

/** The live status + progress of a fix (getFixStatus), or null when its session is not live. */
export function fixLiveProgress(fixId: number): { status: ReturnType<typeof aiFixStatusForPhase>; progress: AiFixProgress | null } | null {
  const l = liveSession(fixKey(fixId));
  if (!l || l.closing) return null;
  const status = aiFixStatusForPhase(l.phase, { pushed: false });
  return { status, progress: status === 'running' ? progressOf(l, l.phase) : null };
}

// ---- restart ------------------------------------------------------------------------------------------------

const LIVE_FIX_PHASES = ['booting', 'ready', 'chatting', 'building', 'built'] as const;

/**
 * A restart cut every fix session off: a live one is `built` when it stored a patch (pushable,
 * resumable) and `failed` without; status derived. Every account's rows; only rows in live phases move.
 */
export async function reconcileFixSessionsOnStartup(ctx: AgentContext): Promise<number> {
  const { inArray } = await import('drizzle-orm');
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db.select().from(t).where(inArray(t.sessionPhase, [...LIVE_FIX_PHASES])).execute()) as AiFixRow[];
  let moved = 0;
  for (const r of rows) {
    if (liveSession(fixKey(r.id))) continue;
    if (r.sandboxRef == null && r.sessionPhase === 'built') continue;
    const kept = fixRowHasWork(r);
    const phase: SandboxSessionPhase = kept ? 'built' : 'failed';
    const { state, error } = restartState(r.sessionJson, kept);
    await updateFixSession(ctx, r.accountId, r.id, {
      sessionPhase: phase,
      status: aiFixStatusForPhase(phase, { pushed: r.pushedAt != null }),
      sandboxRef: null,
      error,
      sessionJson: state as unknown as Record<string, unknown>,
      ...(phase === 'failed' ? { finishedAt: new Date() } : {}),
    });
    moved += 1;
  }
  if (moved > 0) ctx.log.info(`reconciled ${moved} AI Fix session(s) cut off by a restart`);
  return moved;
}

/** The shown refs of a stored run (the items it was shown). */
export function shownRefsOfItems(items: readonly AiFixReviewItem[] | null): string[] {
  return (items ?? []).filter((i) => i.included).map((i) => i.ref);
}
