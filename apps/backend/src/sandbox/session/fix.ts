// AI FIX ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions). The fix SUBJECT of the one session
// machine (manager.ts): an `ai_fixes` row (its status DERIVED from the phase, shared `aiFixStatusForPhase`),
// the PR's task, and the PR repository's patch only.
//
//   manual       booting ─► building ─► built ⇄ building      (Start runs the fix at once; follow-ups are
//                                                               more build turns in the SAME session)
//   Plan first   booting ─► chatting ─► ready ⇄ chatting ─(Start fix)─► building ─► built …
//   unattended   booting ─► building ─► [review loop] ─► closed: built   (an auto fix, dependency automation's fix)
//
// THE REVIEW LOOP (coding/ai-fix/loop.ts; docs/CLAUDE-REVIEW.md § AI Fix → The review loop): every fix turn that
// ends well with work to push — the first, Start fix's, a reader's follow-up — is followed by Ensemble's own
// review of the fix (a LOCAL commit, never pushed) and, while anything is open and rounds are left, by host
// fix turns seeded with REVIEW.md. The session is held meanwhile and the row reads 'running'. Only when the loop
// ends does a fix close (unattended) or ask Push when done (manual): ONE FIX LOOP, then the push rules.
//   Push (coding/ai-fix/push.ts) ends a live session as `pushed`; Discard as `discarded` (status cancelled).
//
// SCOPE (owner decision D3; narrowed 2026-11-10): the PR's repository, plus the workspace repositories of
// the other pull requests of its ticket, mirrored at the reader's paths, memories as in Implement; the PR's
// repository is checked out at the PR's HEAD SHA, fetched through the base repository's
// `refs/pull/<n>/head` (a fork's head included); a repository holding an open pull request of the same ticket
// (a SIBLING, `siblingHeads`) is at that PR's head — with that sibling's built, unpushed AI Fix laid on top as
// ONE local commit (THE OVERLAY, `siblingOverlayPlan`; its base when the head has not moved since); every other
// repository is on its default branch. Edits outside the PR's repository are shown ("left out") and never stored
// as a patch. What each sibling was read at is stored for the STALE flag (coding/ai-fix/sibling-stale.ts).
// ONE TICKET AT A TIME (coding/ai-fix/ticket-line.ts): the session releases the per-ticket line the moment it
// stops running (`onPhase`), and on its close.
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
import { clearPushPending, isFixPushing, notePushPending } from '../../coding/ai-fix/push-guard.js';
import { getFixById, updateFixSession, type AiFixRow } from '../../coding/ai-fix/persist.js';
import type { FixAgentReport } from '../../platform/contract.js';
import type { SandboxAgentChoice } from '../drivers/index.js';
import { fixSessionBranch, readSessionTicket, type FixSeedInput, type RepoBaseRequest, type SessionTicket } from '../workspace/index.js';
import { diffPaths, type DocsPick, type FixDocsSubject } from '../workspace/docs-choose.js';
import { SANDBOX_DOCS_DIR } from '../workspace/docs.js';
import { readFixReport, removeFixReport } from '../workspace/fix-report.js';
import {
  afterFixLoopTurn,
  clearFixLoopPending,
  dropFixLoopRefs,
  endFixLoopForClose,
  fixLoopCanRun,
  fixLoopActive,
  fixLoopBusyReason,
  markFixLoopPending,
  startFixLoop,
  stopFixLoop,
} from '../../coding/ai-fix/loop.js';
import { AI_FIX_REPOS_MAX, type AiFixLoopStop } from '@pierre-review/shared';
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
import { bindTicketLineFix, releaseTicketLine } from '../../coding/ai-fix/ticket-line.js';
import { patchHash, readSiblingState, type FixSiblingState } from '../../coding/ai-fix/sibling-stale.js';
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
  /**
   * The repositories of the OTHER pull requests of this PR's tickets (open or merged): loaded right after the
   * PR's own (docs/SANDBOX.md § AI Fix sessions → Scope). Never fatal: [].
   */
  /**
   * The reader-declared RELATED REPOS of the PR's repository in this workspace (db/related-repos.ts), for the
   * load order of a wide fix (docs/SANDBOX.md § AI Fix sessions → Scope). Never fatal: [].
   */
  relatedRepoIds(ctx: AgentContext, accountId: number, prId: number): Promise<number[]>;
  /**
   * The OPEN pull requests of this PR's tickets other than this one (its SIBLINGS), newest update first. Each one's
   * repository is loaded at that PR's head, read only (`siblingHeads`). Never fatal: [].
   */
  siblingOpenPrs(ctx: AgentContext, accountId: number, prId: number): Promise<SiblingPr[]>;
  /**
   * THE PER-TICKET LINE's lookup (coding/ai-fix/ticket-line.ts): every OTHER pull request of this PR's tickets
   * (≤ 3 tickets, open or not), the same lookup as `siblingOpenPrs`. Never fatal: [].
   */
  ticketSiblingPrIds(ctx: AgentContext, accountId: number, prId: number): Promise<number[]>;
  /**
   * THE SIBLING OVERLAY's candidate (docs/SANDBOX.md § AI Fix sessions → Scope): the sibling PR's latest fix that
   * is built, not pushed, not discarded and has a patch (null when there is none), and the ids of every such fix
   * (what the STALE flag compares against later). Never fatal: none.
   */
  siblingBuiltFix(ctx: AgentContext, accountId: number, prId: number): Promise<{ latest: SiblingBuiltFix | null; builtIds: number[] }>;
  /** The sibling PR's head on GitHub NOW (the overlay applies only on the head its fix was built on). */
  siblingLiveHead(ctx: AgentContext, accountId: number, pr: { owner: string; name: string; number: number }): Promise<string | null>;
  /**
   * The overlay commit: the sibling fix's patch on the sibling's head, ONE local commit in Ensemble's clone cache
   * (never the reader's clone, never pushed), pinned under `refs/pierre/local/ai-fix-overlay/<siblingFixId>/…`.
   */
  overlayCommit(a: { accountId: number; owner: string; name: string; number: number; headRef: string; headSha: string; patch: string; siblingFixId: number; forFixId: number }): Promise<{ localRef: string; sha: string }>;
  declaredRelatedRepoIds(accountId: number, workspaceId: number, repoId: number): Promise<number[]>;
  /** The workspace's member repositories now (External included), for Resume. Never fatal: []. */
  memberRepoIds(accountId: number, workspaceId: number): Promise<number[]>;
  /** `owner/name` of each repository (the "rest by name" order and the "Not loaded" note). */
  repoNames(ctx: AgentContext, accountId: number, repoIds: readonly number[]): Promise<Array<{ repoId: number; fullName: string }>>;
  /** The workspace has built reference documents (and agentic features are on). Never fatal: false. */
  docsAvailable(accountId: number, workspaceId: number): Promise<boolean>;
  /**
   * THE PR-SHAPED DOCS CHOOSER (docs-choose.ts `chooseFixDocs`): DB and disk only, never a model call.
   * `withTicket: false` (an UNATTENDED fix) skips the ticket's own choice: its Check against docs result (per-criterion
   * verdicts) would reach the agent through DOCS.md, the drift the no-TICKET.md rule keeps out.
   */
  chooseDocs(ctx: AgentContext, accountId: number, workspaceId: number, pr: Omit<FixDocsSubject, 'ticketIdent'> & { prId: number; withTicket: boolean }): Promise<DocsPick>;
  /** The merge: the base tip (pinned; `baseSha` on Resume) and the merge base, from Limn's clone cache. */
  mergePlan(a: MergeRepoInput & { baseSha?: string | null }): Promise<MergePlan>;
  /** The host's check of the agent's commits (coding/ai-fix/merge-verify.ts), in Limn's clone cache. */
  verifyMerge(a: MergeRepoInput & { accountId?: number; baseSha: string; bundle: Buffer; conflictedFiles: readonly string[] }): Promise<MergeVerdict>;
}

const defaultFixDeps: FixSessionDeps = {
  async declaredRelatedRepoIds(accountId, workspaceId, repoId) {
    try {
      const { getRelatedRepoPairs } = await import('../../db/related-repos.js');
      const pairs = (await getRelatedRepoPairs(accountId, workspaceId)) ?? [];
      return pairs.flatMap((p) => (p.repoId === repoId ? [p.relatedRepoId] : p.relatedRepoId === repoId ? [p.repoId] : []));
    } catch {
      return [];
    }
  },
  async memberRepoIds(accountId, workspaceId) {
    const q = await import('../../db/queries.js');
    // `members: 'all'`, as the start reads them (coding/ai-fix/manager.ts).
    return (await q.resolveWorkspaceScope(accountId, workspaceId, null, { members: 'all' })).repoIds;
  },
  async repoNames(ctx, accountId, repoIds) {
    if (repoIds.length === 0) return [];
    const { and, eq, inArray } = await import('drizzle-orm');
    const r = ctx.schema.repos;
    const rows = (await ctx.db
      .select({ repoId: r.id, owner: r.owner, name: r.name })
      .from(r)
      .where(and(eq(r.accountId, accountId), inArray(r.id, [...new Set(repoIds)])))
      .execute()) as Array<{ repoId: number; owner: string; name: string }>;
    return rows.map((x) => ({ repoId: x.repoId, fullName: `${x.owner}/${x.name}` }));
  },
  async docsAvailable(accountId, workspaceId) {
    const { sessionDocsAvailable } = await import('./manager.js');
    return config.aiEnabled && (await sessionDocsAvailable(accountId, workspaceId).catch(() => false));
  },
  async chooseDocs(ctx, accountId, workspaceId, pr) {
    const { chooseFixDocs } = await import('../workspace/docs-choose.js');
    let ticketIdent: string | null = null;
    if (pr.withTicket) {
      try {
        const { getTicketSource } = await import('../../tracker/ticket-source.js');
        ticketIdent = (await getTicketSource().ticketsForPr(accountId, pr.prId))[0]?.ident ?? null;
      } catch {
        ticketIdent = null;
      }
    }
    return chooseFixDocs(ctx, accountId, workspaceId, { ticketIdent, title: pr.title, body: pr.body, paths: pr.paths });
  },
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
      return { ok: false, reason: 'Ensemble could not read its own copy of the repository to check the merge.' };
    }
  },
  async relatedRepoIds(ctx, accountId, prId) {
    try {
      const { getTicketSource } = await import('../../tracker/ticket-source.js');
      const { defaultStoryBuildInputSeams } = await import('../../coding/story-build/inputs.js');
      const tickets = await getTicketSource().ticketsForPr(accountId, prId);
      const out = new Set<number>();
      for (const t of tickets.slice(0, 3)) {
        const ids = await defaultStoryBuildInputSeams.ticketPrIds(ctx, accountId, t.ident).catch(() => []);
        for (const pr of await defaultStoryBuildInputSeams.ticketPrs(ctx, accountId, ids).catch(() => [])) out.add(pr.repoId);
      }
      return [...out];
    } catch {
      return [];
    }
  },
  async ticketSiblingPrIds(ctx, accountId, prId) {
    return ticketPrIdsOf(ctx, accountId, prId);
  },
  async siblingBuiltFix(ctx, accountId, prId) {
    const { and, desc, eq, isNull, isNotNull } = await import('drizzle-orm');
    const t = ctx.schema.aiFixes;
    const rows = (await ctx.db
      .select({ id: t.id, baseSha: t.baseSha, patch: t.patch, mergeJson: t.mergeJson })
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.status, 'succeeded'), eq(t.sessionPhase, 'built'), isNull(t.pushedAt), isNotNull(t.patch)))
      .orderBy(desc(t.id))
      .limit(50)
      .execute()) as Array<{ id: number; baseSha: string; patch: string | null; mergeJson: unknown }>;
    const r = rows[0];
    const latest = r && r.patch ? { fixId: r.id, baseSha: r.baseSha, patch: r.patch, merge: r.mergeJson != null } : null;
    return { latest, builtIds: rows.map((x) => x.id) };
  },
  async siblingLiveHead(ctx, accountId, pr) {
    return (await ctx.github.fetchPrHeadInfo(accountId, pr.owner, pr.name, pr.number)).headSha || null;
  },
  async overlayCommit(a) {
    const cm = await import('../../review/clone-manager.js');
    const { getAccessToken } = await import('../../auth/account.js');
    const token = await getAccessToken(a.accountId);
    // The sibling's head into Ensemble's clone cache (through the base repository's pull ref), then the patch.
    await cm.resolveBranchCommit(a.owner, a.name, { remoteRef: `refs/pull/${a.number}/head`, destRef: 'refs/pierre/sandbox-base', sha: a.headSha }, token);
    const { commitPatchToLocalRef } = await import('../../coding/git-ops.js');
    const got = await commitPatchToLocalRef({
      accountId: a.accountId,
      owner: a.owner,
      name: a.name,
      baseRef: a.headRef,
      baseSha: a.headSha,
      patch: a.patch,
      message: `AI fix of #${a.number}, not pushed`,
      key: { kind: SIBLING_OVERLAY_REF_KIND, id: a.siblingFixId, name: `for-${a.forFixId}` },
    });
    return { localRef: got.ref, sha: got.commitSha };
  },
  async siblingOpenPrs(ctx, accountId, prId) {
    try {
      const { and, eq, inArray, ne } = await import('drizzle-orm');
      const ids = new Set(await ticketPrIdsOf(ctx, accountId, prId));
      if (ids.size === 0) return [];
      const pr = ctx.schema.pullRequests;
      const rows = (await ctx.db
        .select({ prId: pr.id, repoId: pr.repoId, number: pr.number, headRefName: pr.headRefName, updatedAt: pr.updatedAt })
        .from(pr)
        .where(and(eq(pr.accountId, accountId), inArray(pr.id, [...ids]), eq(pr.state, 'open'), ne(pr.id, prId)))
        .execute()) as Array<{ prId: number; repoId: number; number: number; headRefName: string | null; updatedAt: Date }>;
      return rows
        .map((r) => ({ prId: r.prId, repoId: r.repoId, number: r.number, headRefName: r.headRefName, updatedAtMs: r.updatedAt.getTime() }))
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.number - a.number);
    } catch {
      return [];
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

/** Every OTHER pull request of this PR's tickets (≤ 3 tickets; open or not). Never throws: []. */
async function ticketPrIdsOf(ctx: AgentContext, accountId: number, prId: number): Promise<number[]> {
  try {
    const { getTicketSource } = await import('../../tracker/ticket-source.js');
    const { defaultStoryBuildInputSeams } = await import('../../coding/story-build/inputs.js');
    const tickets = await getTicketSource().ticketsForPr(accountId, prId);
    const ids = new Set<number>();
    for (const t of tickets.slice(0, 3)) {
      for (const id of await defaultStoryBuildInputSeams.ticketPrIds(ctx, accountId, t.ident).catch(() => [])) ids.add(id);
    }
    ids.delete(prId);
    return [...ids];
  } catch {
    return [];
  }
}

let fixDeps: FixSessionDeps = defaultFixDeps;

/** THE PER-TICKET LINE's lookup (coding/ai-fix/manager.ts): the other PRs of this PR's tickets. Never throws. */
export function ticketSiblingPrIds(ctx: AgentContext, accountId: number, prId: number): Promise<number[]> {
  return fixDeps.ticketSiblingPrIds(ctx, accountId, prId).catch(() => []);
}

/** THE SCOPE's repository set (the session's `repoIds`; the per-ticket line asks the same before the start). */
async function fixLoadedRepoSet(
  ctx: AgentContext,
  accountId: number,
  a: { prId: number; prRepoId: number; workspaceId: number | null; memberRepoIds: readonly number[]; wide: boolean },
): Promise<{ ids: number[]; notLoaded: string[] }> {
  const ticketRepoIds = await fixDeps.relatedRepoIds(ctx, accountId, a.prId).catch(() => []);
  if (!a.wide) return fixRepoSet({ prRepoId: a.prRepoId, members: a.memberRepoIds.map((repoId) => ({ repoId, fullName: '' })), ticketRepoIds, declaredRepoIds: [], wide: false });
  const declaredRepoIds = a.workspaceId == null ? [] : await fixDeps.declaredRelatedRepoIds(accountId, a.workspaceId, a.prRepoId).catch(() => []);
  const named = await fixDeps.repoNames(ctx, accountId, a.memberRepoIds).catch(() => []);
  return fixRepoSet({ prRepoId: a.prRepoId, members: named, ticketRepoIds, declaredRepoIds, wide: true });
}

/**
 * THE PER-TICKET LINE's "reads" (coding/ai-fix/ticket-line.ts): the open PRs of this PR's ticket the fix would READ
 * AT THEIR HEAD — in ANOTHER repository the fix loads (`fixLoadedRepoSet`, the workspace's Settings → Sandbox), the
 * one `siblingHeads` checks out there. A same-repository sibling, or one outside the loaded set, is not read at its
 * head and never blocks. `loadedRepoIds` given (a live session's repositories) ⇒ that set. Never throws: [].
 */
export async function lineReadsFor(
  ctx: AgentContext,
  accountId: number,
  a: { prId: number; prRepoId: number; workspaceId: number; memberRepoIds?: readonly number[]; loadedRepoIds?: readonly number[] },
): Promise<number[]> {
  try {
    const prs = await fixDeps.siblingOpenPrs(ctx, accountId, a.prId).catch(() => [] as SiblingPr[]);
    if (prs.length === 0) return [];
    let loaded = a.loadedRepoIds;
    if (loaded == null) {
      const settings = await sessionDeps().settings(accountId, a.workspaceId).catch(() => null);
      loaded = (await fixLoadedRepoSet(ctx, accountId, { prId: a.prId, prRepoId: a.prRepoId, workspaceId: a.workspaceId, memberRepoIds: a.memberRepoIds ?? [], wide: settings?.fixAllRepos ?? true })).ids;
    }
    const sib = siblingHeads({ prRepoId: a.prRepoId, loadedRepoIds: loaded, prs, repoNames: new Map() });
    return [...sib.heads.values()].map((p) => p.prId);
  } catch {
    return [];
  }
}

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

// ---- the scope -------------------------------------------------------------------------------------------

/**
 * AN AI FIX'S REPOSITORIES, in load order (docs/SANDBOX.md § AI Fix sessions → Scope). Pure.
 *   narrow (`wide: false`): the PR's repository, then its ticket's other repositories in the workspace. No cap.
 *   wide: the PR's repository, its ticket's repositories, the reader's related repositories (db/related-repos.ts),
 *         then every other member by `owner/name`; at most `max` (AI_FIX_REPOS_MAX), the rest NAMED in `notLoaded`.
 * Only workspace members are loaded (the PR's own repository always).
 */
export function fixRepoSet(a: {
  prRepoId: number;
  members: ReadonlyArray<{ repoId: number; fullName: string }>;
  ticketRepoIds: readonly number[];
  declaredRepoIds: readonly number[];
  wide: boolean;
  max?: number;
}): { ids: number[]; notLoaded: string[] } {
  const members = new Map(a.members.map((m) => [m.repoId, m.fullName]));
  const inWs = (id: number): boolean => members.has(id);
  const narrow = [a.prRepoId, ...a.ticketRepoIds.filter(inWs)];
  if (!a.wide) return { ids: [...new Set(narrow)], notLoaded: [] };
  const rest = [...a.members]
    .sort((x, y) => x.fullName.toLowerCase().localeCompare(y.fullName.toLowerCase()) || x.repoId - y.repoId)
    .map((m) => m.repoId);
  const ordered = [...new Set([...narrow, ...a.declaredRepoIds.filter(inWs), ...rest])];
  const max = Math.max(1, a.max ?? AI_FIX_REPOS_MAX);
  return { ids: ordered.slice(0, max), notLoaded: ordered.slice(max).map((id) => members.get(id) ?? `repository ${id}`) };
}

/** The ONE boot note for the repositories past the cap: named, never dropped silently. */
export function notLoadedNote(fullNames: readonly string[], max: number = AI_FIX_REPOS_MAX): string {
  return `${NOT_LOADED_PREFIX}${max} repositories. Not loaded: ${fullNames.join(', ')}.`;
}
const NOT_LOADED_PREFIX = 'AI Fix loads at most ';

/** A note `notLoadedNote` wrote (a Resume drops the earlier boot's before it writes its own). Pure. */
export function isNotLoadedNote(note: string): boolean {
  return note.startsWith(NOT_LOADED_PREFIX);
}

// ---- sibling pull requests -------------------------------------------------------------------------------

/** An open pull request of the same ticket as the fixed PR, in this workspace (`siblingOpenPrs`). */
export interface SiblingPr {
  prId: number;
  repoId: number;
  number: number;
  headRefName: string | null;
  updatedAtMs: number;
}

const SIBLING_NOTE_PREFIX = 'Pull requests of the same ticket: ';

/**
 * WHICH SIBLING PR EACH REPOSITORY SHOWS (docs/SANDBOX.md § AI Fix sessions → Scope). Pure. A loaded repository
 * other than the PR's own that has an open sibling is checked out at that sibling's head (read only), so the
 * agent reads the ticket's other unmerged changes, not the default branch. Several open siblings in one
 * repository: the most recently updated one (`prs` comes newest first); the others are named. A sibling in the
 * PR's OWN repository cannot be checked out (the PR's head is), so it is named. `repoNames` maps repoId →
 * owner/name for the note.
 */
export function siblingHeads(a: {
  prRepoId: number;
  loadedRepoIds: readonly number[];
  prs: readonly SiblingPr[];
  repoNames: ReadonlyMap<number, string>;
}): { heads: Map<number, SiblingPr>; note: string | null } {
  const loaded = new Set(a.loadedRepoIds);
  const heads = new Map<number, SiblingPr>();
  const unshown: string[] = [];
  for (const p of a.prs) {
    const name = a.repoNames.get(p.repoId) ?? 'another repository';
    if (p.repoId === a.prRepoId) unshown.push(`#${p.number} in ${name} (this PR's repository)`);
    else if (!loaded.has(p.repoId)) continue;
    else if (heads.has(p.repoId)) unshown.push(`#${p.number} in ${name} (#${heads.get(p.repoId)!.number} is loaded)`);
    else heads.set(p.repoId, p);
  }
  return { heads, note: unshown.length > 0 ? `${SIBLING_NOTE_PREFIX}not checked out: ${unshown.join(', ')}.` : null };
}

/** A note `siblingHeads` (or the overlay) wrote (a Resume drops the earlier boot's). Pure. */
export function isSiblingNote(note: string): boolean {
  return note.startsWith(SIBLING_NOTE_PREFIX);
}

/** A sibling PR's built, unpushed AI Fix (`siblingBuiltFix`): the OVERLAY candidate. */
export interface SiblingBuiltFix {
  fixId: number;
  /** The sibling's head the fix was built on (`ai_fixes.base_sha`). */
  baseSha: string;
  patch: string;
  /** The fix resolved merge conflicts: its patch sits on a merge, so it is not applied as an overlay. */
  merge: boolean;
}

/** The local-ref kind of the overlay commits (review/local-refs.ts): `ai-fix-overlay/<siblingFixId>/for-<fixId>`. */
export const SIBLING_OVERLAY_REF_KIND = 'ai-fix-overlay';

/**
 * WHETHER A SIBLING'S BUILT FIX IS LAID ON ITS HEAD (docs/SANDBOX.md § AI Fix sessions → Scope, "The overlay").
 * Pure. Applied only when the sibling's head now is the head its fix was built on; a fix that resolved merge
 * conflicts is never applied (its patch sits on a merge). The skip says why, in the ONE sibling note's words.
 */
export function siblingOverlayPlan(a: { number: number; fix: SiblingBuiltFix | null; liveHead: string | null; pushedSha?: string | null }): { apply: true } | { apply: false; note: string | null } {
  if (a.fix == null) return { apply: false, note: null };
  if (a.fix.merge) return { apply: false, note: `#${a.number}'s AI Fix is not applied: it resolves merge conflicts.` };
  if (a.liveHead == null) return { apply: false, note: `#${a.number}'s AI Fix is not applied: its head could not be read.` };
  // Pushed meanwhile: the head IS that fix, so its code is in what this fix reads.
  if (a.pushedSha != null && a.liveHead === a.pushedSha) return { apply: false, note: `#${a.number}'s AI Fix is pushed: its code is in #${a.number}'s head.` };
  if (a.liveHead !== a.fix.baseSha) return { apply: false, note: `#${a.number}'s AI Fix is not applied: #${a.number} changed after it was built.` };
  return { apply: true };
}

/** The one boot note of the overlay skips (prefixed like the sibling note, so a Resume drops it too). Pure. */
export function siblingOverlayNote(skips: readonly string[]): string | null {
  return skips.length > 0 ? `${SIBLING_NOTE_PREFIX}${skips.join(' ')}` : null;
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

/**
 * The end of a fix's review loop, with THE PER-TICKET LINE released afterwards however it went (a read that
 * throws included): the loop ended, so the fix stopped running — unless another loop run is active.
 */
export async function withTicketLineReleased(prId: number, fixId: number, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    if (!fixLoopActive(fixId)) releaseTicketLine(prId, { fixId });
  }
}

/** fixId → its live subject's "the review loop ended" step (coding/ai-fix/loop.ts calls `afterFixLoopEnded`). */
const loopEnders = new Map<number, (stop: AiFixLoopStop | null) => Promise<void>>();

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
  /** Dependency automation's fix: today's narrow set (the PR's repository and its ticket's), no reference docs. */
  narrow?: boolean;
  /** The start's hold of THE PER-TICKET LINE (coding/ai-fix/ticket-line.ts): bound to the fix id here; the session
   *  releases it when it stops running. null/absent ⇒ none (a narrow fix). */
  ticketLineToken?: number | null;
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
  /** Dependency automation's fix: the narrow repository set and no reference docs, on Resume too. Absent ⇒ false. */
  narrow?: boolean;
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
    ...(a.narrow ? { narrow: true } : {}),
  };
  bindFixClaim(a.pr.prId, a.fixId);
  if (a.ticketLineToken != null) bindTicketLineFix(a.pr.prId, a.ticketLineToken, a.fixId);
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
  // The turn that just ended will be followed by the review loop (`afterBuildTurn` → `afterBuildTurnEnded`).
  let loopNext = false;
  // The merge (fix-merge.ts), once `bases` resolved it; written to `ai_fixes.merge_json` as it changes.
  let merge: FixMergeState | null = null;
  // THE SIBLINGS this boot reads (repoId → what `bases` chose), stored on the row after the mirror (`afterMirror`).
  let siblingRead = new Map<number, Omit<FixSiblingState, 'headSha' | 'at'> & { headSha: string | null }>();
  // What this boot read of them (`afterMirror`), written with the next stored patch (`storeFixTurn`).
  let bootSiblings: BootSiblings | null = null;
  const saveMerge = (extra: { mergeBundle?: string | null } = {}): Promise<void> =>
    updateFixSession(ctx, accountId, fixId, { mergeJson: merge as unknown as Record<string, unknown>, ...extra });
  const stateOf = (l: SubjectLive): FixState => (l as Live).state as FixState;
  const row = (): Promise<AiFixRow | null> => getFixById(ctx, accountId, fixId);

  const subject: SessionSubject = {
    kind: 'fix',
    rowId: fixId,
    idPrefix: 'fx',
    unattended,
    bootStep: 'task',
    usage: { repoId: facts.prRepoId, prId: facts.prId, features: { chat: 'ai_fix_plan', build: 'ai_fix' } },
    maxTurns: config.aiFixMaxTurns,
    // An unattended run has nobody to press Stop: Claude's own US$ cap bounds its one build turn (its
    // process ends with the session). A manual session is the reader's to stop; Codex has no such flag.
    ...(unattended ? { maxBudgetUsd: config.aiFixBudgetUsd } : {}),
    async save(l, p) {
      if (p.phase === 'discarded') pushedAt = (await row())?.pushedAt ?? pushedAt;
      await updateFixSession(ctx, accountId, fixId, {
        ...(p.phase ? { sessionPhase: p.phase, status: statusNow(p.phase) } : {}),
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
      // THE REFERENCE DOCUMENTS (docs/SANDBOX.md § AI Fix sessions → What the agent finds): when the workspace has
      // a built library, decided at every boot (Resume too). Dependency automation's fix stays without them.
      state.withDocs = facts.narrow === true ? false : await fixDeps.docsAvailable(accountId, l.workspaceId).catch(() => false);
      if (!state.withDocs) state.docs = null;
      return `#${facts.number} at ${facts.headSha.slice(0, 7)}`;
    },
    async repoIds(memberRepoIds, o) {
      // THE SCOPE (docs/SANDBOX.md § AI Fix sessions → Scope), recomputed at every boot (Resume too): the PR's
      // repository, its ticket's other repositories, and — with Settings → Sandbox → "AI Fix reads every
      // repository" on (the default) — the reader's related repositories and then the rest by name, at most
      // AI_FIX_REPOS_MAX. Every repository but the PR's is read only (`bases`). Dependency automation: narrow.
      // ONE copy of the "Not loaded" note, the current one: a Resume recomputes the set, so an earlier boot's
      // note is dropped first (never stacked, never left stale when the set narrowed).
      if (o) stateOf(o.l).notes = stateOf(o.l).notes.filter((n) => !isNotLoadedNote(n));
      const set = await fixLoadedRepoSet(ctx, accountId, {
        prId: facts.prId,
        prRepoId: facts.prRepoId,
        workspaceId: o?.l.workspaceId ?? null,
        memberRepoIds,
        wide: facts.narrow !== true && (o?.settings.fixAllRepos ?? true),
      });
      if (set.notLoaded.length > 0 && o) stateOf(o.l).notes.push(notLoadedNote(set.notLoaded));
      return set.ids;
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
      // SIBLING PRs (open PRs of the same ticket) are read at THEIR head, not the default branch. Dependency
      // automation's narrow fix keeps the default branches.
      const siblings = facts.narrow === true ? [] : await fixDeps.siblingOpenPrs(ctx, accountId, facts.prId).catch(() => []);
      const sib = siblingHeads({
        prRepoId: facts.prRepoId,
        loadedRepoIds: repos.map((r) => r.repoId),
        prs: siblings,
        repoNames: new Map(repos.map((r) => [r.repoId, `${r.owner}/${r.name}`])),
      });
      const st = stateOf(l);
      st.notes = st.notes.filter((n) => !isSiblingNote(n));
      if (sib.note) st.notes.push(sib.note);
      siblingRead = new Map();
      const overlaySkips: string[] = [];
      for (const r of repos) {
        const pinRef = aiFixBaseRef(fixId, r.repoId);
        if (r.repoId === facts.prRepoId) {
          bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: facts.headRef, baseSha: facts.headSha, remoteRef: `refs/pull/${facts.number}/head`, pinRef });
          labels.set(r.repoId, { label: `PR #${facts.number}'s head, ${facts.headRef},`, note: 'This is the repository AI Fix pushes.' });
        } else if (sib.heads.has(r.repoId)) {
          const p = sib.heads.get(r.repoId)!;
          const readOnly = 'Read only: another pull request of the same ticket, not merged yet. Edits here are left out.';
          // THE OVERLAY (docs/SANDBOX.md § AI Fix sessions → Scope): the sibling's built, unpushed AI Fix laid on its
          // head, when that head has not moved since — ONE local commit in Ensemble's clone cache, the sibling
          // repository's BASE (so the left-out extraction never counts it as this agent's edit).
          const builtNow = await fixDeps.siblingBuiltFix(ctx, accountId, p.prId).catch(() => ({ latest: null, builtIds: [] as number[] }));
          const built = builtNow.latest;
          const live = built != null && !built.merge ? await fixDeps.siblingLiveHead(ctx, accountId, { owner: r.owner, name: r.name, number: p.number }).catch(() => null) : null;
          // The head moved: was it the push of that very fix (pushed since the read above)?
          const pushedSha = built != null && live != null && live !== built.baseSha ? ((await getFixById(ctx, accountId, built.fixId).catch(() => null))?.pushedCommitSha ?? null) : null;
          const plan = siblingOverlayPlan({ number: p.number, fix: built, liveHead: live, pushedSha });
          let overlay: { localRef: string; sha: string } | null = null;
          if (plan.apply && built) {
            overlay = await fixDeps
              .overlayCommit({ accountId, owner: r.owner, name: r.name, number: p.number, headRef: p.headRefName ?? 'HEAD', headSha: built.baseSha, patch: built.patch, siblingFixId: built.fixId, forFixId: fixId })
              .catch(() => null);
            if (overlay == null) overlaySkips.push(`#${p.number}'s AI Fix is not applied: it could not be laid on its head.`);
          } else if (!plan.apply && plan.note) overlaySkips.push(plan.note);
          if (overlay && built) {
            bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: p.headRefName ?? 'HEAD', baseSha: overlay.sha, localRef: overlay.localRef, pinRef });
            labels.set(r.repoId, { label: `PR #${p.number}'s head plus its AI Fix not pushed yet,`, note: readOnly });
            siblingRead.set(r.repoId, { prId: p.prId, number: p.number, repoId: r.repoId, headSha: built.baseSha, overlayFixId: built.fixId, overlayPatchHash: patchHash(built.patch), builtFixIds: builtNow.builtIds });
          } else {
            // The sibling's CURRENT head (the one just read, else the ref's tip), through the base repository's pull ref.
            bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: p.headRefName ?? 'HEAD', baseSha: live, remoteRef: `refs/pull/${p.number}/head`, pinRef });
            labels.set(r.repoId, { label: `PR #${p.number}'s head${p.headRefName ? `, ${p.headRefName},` : ''}`, note: readOnly });
            siblingRead.set(r.repoId, { prId: p.prId, number: p.number, repoId: r.repoId, headSha: live, overlayFixId: null, overlayPatchHash: null, builtFixIds: builtNow.builtIds });
          }
        } else {
          bases.set(r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: 'HEAD', baseSha: null, pinRef });
          labels.set(r.repoId, { label: r.defaultBranch ?? 'the default branch', note: 'Read only: edits here are left out.' });
        }
      }
      const skipNote = siblingOverlayNote(overlaySkips);
      if (skipNote) st.notes.push(skipNote);
      return { bases, labels };
    },
    async prepareDocs(l0) {
      const l = l0 as Live;
      const pick = await fixDeps
        // An unattended fix gets no ticket-derived documents either (no TICKET.md, no ticket's Check against docs).
        .chooseDocs(ctx, accountId, l.workspaceId, { prId: facts.prId, title: facts.title, body: facts.body, paths: diffPaths(o.diff), withTicket: !unattended })
        .catch((err: unknown) => ({ ok: false as const, reason: scrub(err) }));
      if (!pick.ok || !l.container || !l.layoutRoot) {
        l.state.docs = null;
        return { dir: null, detail: pick.ok ? null : pick.reason };
      }
      const { planDocsCopy, copyDocsIn } = await import('../workspace/docs.js');
      const copy = planDocsCopy(pick.lib, pick.index, pick.choice);
      try {
        await copyDocsIn(l.runtime, l.container, copy);
        await l.runtime.copyIn(l.container, [{ path: `${l.layoutRoot.replace(/\/$/, '')}/DOCS.md`, content: copy.docsMd }]);
      } catch (err) {
        // Optional context: the fix goes on without the documents (one line), never fails for them.
        l.state.docs = null;
        return { dir: null, detail: `The reference documents could not be copied in: ${scrub(err)}` };
      }
      l.state.docs = { source: pick.choice.source, libraryHash: pick.libraryHash, sections: copy.sections };
      return { dir: SANDBOX_DOCS_DIR, detail: `${copy.sections.length} ${copy.sections.length === 1 ? 'section' : 'sections'}` };
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
      // WHAT THIS BOOT READ OF ITS SIBLINGS (coding/ai-fix/sibling-stale.ts): the head each one was at (the
      // overlay's base, else the commit cloned) and the overlaid fix. Kept in memory: it is STORED only when a build
      // turn stores the patch built against it (`storeFixTurn`) — a Resume with no new turn never clears staleness.
      const read: FixSiblingState[] = [];
      const failedPrIds: number[] = [];
      for (const [repoId, x] of siblingRead) {
        const cloned = mirror.repos.find((m) => m.repoId === repoId);
        if (!cloned) {
          failedPrIds.push(x.prId);
          continue;
        }
        read.push({ ...x, headSha: x.headSha ?? cloned.sha, at: Date.now() });
      }
      bootSiblings = { read, failedPrIds };
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
    // A message would start a turn that rewrites the work while a push or the review loop reads it.
    busyReason: () => (isFixPushing(fixId) ? 'Wait for the push to finish.' : fixLoopBusyReason(fixId)),
    async beforeBuildTurn(l) {
      if (l.container && l.layoutRoot) await removeFixReport((l as Live).runtime, l.container, l.layoutRoot);
    },
    async afterBuildTurn(l0) {
      const l = l0 as Live;
      if (merge) await storeMergeTurn(l);
      else await storeFixTurn(ctx, l, { fixId, accountId, facts, prRepoPath, siblings: bootSiblings });
      // A LOOP FIX TURN: the loop goes on in `afterBuildTurnEnded` (the answers, the next review).
      if (l.loopTurn === true) return 'keep';
      // THE REVIEW LOOP comes next when the turn ended well with work to push: the session stays, the row keeps
      // reading 'running' (`statusNow`) from this tick, and the close / Push when done wait for the loop's end.
      if (l.lastOutcome === 'completed' || l.lastOutcome === 'max_turns') {
        const r = await row();
        if (r != null && r.pushedAt == null && fixRowHasWork(r) && (await fixLoopCanRun(ctx, accountId, fixId, l.workspaceId))) {
          markFixLoopPending(fixId);
          loopNext = true;
          return 'keep';
        }
      }
      return finishTurn(l, { closeBy: 'turn' });
    },
    afterBuildTurnEnded(l0, e) {
      const l = l0 as Live;
      if (l.loopTurn === true) {
        l.loopTurn = false;
        void afterFixLoopTurn(ctx, { accountId, fixId }, e).catch(() => {});
        return;
      }
      if (!loopNext) return;
      loopNext = false;
      void (async () => {
        const got = l.closing ? 'skipped' : await startFixLoop(ctx, { accountId, fixId, byReader: !unattended }).catch(() => 'skipped' as const);
        if (got === 'started') return;
        // No loop after all (nothing to review, the claim taken): the session goes on as before the loop.
        clearFixLoopPending(fixId);
        await afterLoop(null);
      })();
    },
    onPhase(l, phase) {
      const status = statusNow(phase);
      // THE PER-TICKET LINE (coding/ai-fix/ticket-line.ts): released the moment this fix stops running (built with
      // its review loop ended, a Plan first's plan turn starting, or closed); the next fix of the ticket may start.
      if (status !== 'running') releaseTicketLine(facts.prId, { fixId });
      if (status === 'running') emitFixStream(facts.prId, { type: 'progress', status, fixId, progress: progressOf(l as Live, phase) });
      else emitFixStream(facts.prId, { type: 'done', status, fixId });
    },
    async onClosed(l, phase) {
      // A close while the review loop works (Stop all, a turn past its cap): the loop ends first, so the row's
      // status is derived from the phase again before the push rules below read it.
      if (fixLoopActive(fixId)) {
        clearFixLoopPending(fixId);
        await endFixLoopForClose(ctx, accountId, fixId).catch(() => {});
        await updateFixSession(ctx, accountId, fixId, { status: aiFixStatusForPhase(phase, { pushed: pushedAt != null }) }).catch(() => {});
      }
      await onClosedInner(l, phase);
    },
  };

  /** The row's status: DERIVED from the phase, except 'running' while the review loop works on a built session. */
  function statusNow(phase: SandboxSessionPhase): ReturnType<typeof aiFixStatusForPhase> {
    if (phase === 'built' && fixLoopActive(fixId)) return 'running';
    return aiFixStatusForPhase(phase, { pushed: pushedAt != null });
  }

  /**
   * AFTER A FIX TURN'S WORK (and its review loop, when one ran): an unattended fix closes (its close pushes by the
   * existing rules); a manual one asks Push when done. 'turn': called from `afterBuildTurn` (the machine closes on
   * 'close'); 'loop': the loop ended (this closes the live session itself).
   */
  async function finishTurn(l: Live, o: { closeBy: 'turn' | 'loop' }): Promise<'keep' | 'close'> {
    if (unattended) {
      // PUSH AUTOMATICALLY: when the close will push, the AI Fix tab says "Pushing…" from now until the push
      // settles (push-guard.ts `notePushPending`; `onClosed` clears it). Gate parts 1–3, read-only.
      if (facts.trigger === 'auto') {
        const { autoPushSkip } = await import('../../coding/ai-fix/auto-push.js');
        const skip = await autoPushSkip(ctx, accountId, fixId, undefined, { closing: true }).catch(() => 'failed');
        if (skip == null) notePushPending(fixId);
      }
      if (o.closeBy === 'loop') await closeSession(l, { phase: 'built', error: null });
      return 'close';
    }
    // PUSH WHEN DONE (coding/ai-fix/auto-push.ts): a clean manual fix on the reader's own PR closes, and its
    // close pushes. Otherwise the session stays open and says, in one line, why it did not push.
    const { pushWhenDoneReady } = await import('../../coding/ai-fix/auto-push.js');
    const ready = await pushWhenDoneReady(ctx, accountId, fixId).catch(() => ({ push: false as const, line: null }));
    if (ready.push) {
      notePushPending(fixId);
      if (o.closeBy === 'loop') await closeSession(l, { phase: 'built', error: null });
      return 'close';
    }
    if (ready.line != null) notice(l, ready.line);
    return 'keep';
  }

  /** THE LOOP ENDED (or never started): status from the phase again, the tab told, then `finishTurn`. */
  async function afterLoop(stop: AiFixLoopStop | null): Promise<void> {
    await withTicketLineReleased(facts.prId, fixId, async () => {
      const l = liveSession(fixKey(fixId));
      const r = await row();
      if (r?.sessionPhase) await updateFixSession(ctx, accountId, fixId, { status: aiFixStatusForPhase(r.sessionPhase as SandboxSessionPhase, { pushed: r.pushedAt != null }) });
      if (!l || l.closing) return;
      subject.onPhase?.(l, l.phase);
      // The reader pressed Stop: nothing is closed or pushed by itself (an unattended fix's Stop discards it).
      if (stop === 'stopped') return;
      await finishTurn(l, { closeBy: 'loop' });
    });
  }
  loopEnders.set(fixId, afterLoop);

  async function onClosedInner(l: SubjectLive, phase: SandboxSessionPhase): Promise<void> {
    loopEnders.delete(fixId);
    releaseTicketLine(facts.prId, { fixId });
    releaseFixPr(facts.prId, fixId);
    const state = stateOf(l);
    if (phase === 'discarded' || phase === 'failed' || phase === 'pushed') {
      await dropAiFixBaseRefs(state.repos.map((r) => r.fullName), fixId).catch(() => {});
      // The review loop's local commits (refs/pierre/local/ai-fix-loop/<fixId>/…) go with the fix, and the overlay
      // commits other fixes laid this fix on (refs/pierre/local/ai-fix-overlay/<fixId>/…).
      await dropFixLoopRefs(facts.fullName, fixId).catch(() => {});
      await dropSiblingOverlayRefs(facts.fullName, fixId);
      // The merge's commits are kept only while the fix can still be pushed.
      if (merge) await updateFixSession(ctx, accountId, fixId, { mergeBundle: null }).catch(() => {});
    }
    // An AUTO fix that finished may be pushed automatically (auto-push.ts decides: the workspace's
    // "Push automatically", own PR only, never forced). Off the session: a push is not a turn.
    // ⚠ ONLY the unattended run's own close: a RESUMED auto fix is the reader's session (Resume sets
    // `unattended: false`), so its close never pushes, and an automatic push that failed once is
    // never retried by a later close.
    // THE AUTO FIX QUEUE decides the PR's next fix once this one is done — after its automatic push,
    // when there is one, so the next fix is read at the head that push leaves.
    const queueNext = (): void => {
      void import('../../coding/ai-fix/auto-fix-queue.js')
        .then((m) => m.evaluateAutoFix(ctx, { accountId, prId: facts.prId, cause: 'fix_closed' }))
        .catch(() => {});
    };
    // THE PUSH SETTLED (pushed, failed or skipped): the AI Fix tab stops saying "Pushing…". The SPA learns it
    // from its poll while `AiFix.pushing` — never a second `done` on the fix stream: that stream closed on the
    // close's own `done`, and a late `done` would end (and mark finished) the stream of a NEWER fix on this PR.
    const settled = (): void => {
      clearPushPending(fixId);
      queueNext();
    };
    try {
      // PUSH WHEN DONE: a MANUAL fix the reader asked to push once it is done (the close above was its own:
      // `afterBuildTurn` closed a clean fix). Every rule is read again at push time.
      if (phase === 'built' && !unattended && facts.trigger !== 'auto') {
        const r = await row();
        if (r?.pushWhenDone === true && r.status === 'succeeded' && fixRowHasWork(r)) {
          const { maybePushWhenDone } = await import('../../coding/ai-fix/auto-push.js');
          void maybePushWhenDone(ctx, { accountId, fixId }).catch(() => {}).finally(settled);
          return;
        }
      }
      if (phase === 'built' && unattended && facts.trigger === 'auto') {
        const r = await row();
        if (r?.status === 'succeeded' && fixRowHasWork(r)) {
          const { maybeAutoPushFix } = await import('../../coding/ai-fix/auto-push.js');
          void maybeAutoPushFix(ctx, { accountId, fixId }).catch(() => {}).finally(settled);
          return;
        }
      }
    } catch {
      /* a failed read pushes nothing; the pending mark is cleared below */
    }
    clearPushPending(fixId);
    queueNext();
  }

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
        } catch (err) {
          throw new SessionFail(`Ensemble could not bring ${m.baseRef} into the sandbox: ${scrub(err)}`);
        } finally {
          await source.cleanup().catch(() => {});
        }
      }
      // Resume with stored commits: `restore` puts them back; the merge is not started again.
      const r = l.resume ? await row() : null;
      if (r?.mergeBundle) return;
      m.conflictedFiles = await startMergeInSandbox(l.runtime, l.container, repoPath, m.baseRef);
    } catch (err) {
      if (err instanceof SessionFail) throw err;
      throw new SessionFail(`The merge of ${m.baseRef} could not be started: ${scrub(err)}`);
    }
    await saveMerge();
    const n = m.conflictedFiles.length;
    notice(
      l,
      n === 0
        ? `Ensemble started the merge of ${m.baseRef} (${m.baseSha.slice(0, 7)}). Git found no conflicts; the agent still makes the merge commit.`
        : `Ensemble started the merge of ${m.baseRef} (${m.baseSha.slice(0, 7)}): ${n === 1 ? 'one file is' : `${n} files are`} in conflict (${m.conflictedFiles.slice(0, 8).join(', ')}${n > 8 ? ', …' : ''}).`,
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
      else if (ex.bundleTooLarge) m.reason = 'The merge is larger than Ensemble keeps (4 MB).';
      else if (ex.bundle == null) m.reason = 'Ensemble could not read the merge out of the sandbox.';
      else {
        const pr = facts.fullName.split('/');
        const v = await fixDeps.verifyMerge({ fixId, accountId, owner: pr[0]!, name: pr.slice(1).join('/'), prNumber: facts.number, headSha: m.headSha, baseRef: m.baseRef, baseSha: m.baseSha, bundle: ex.bundle, conflictedFiles: m.conflictedFiles });
        if (!v.ok) m.reason = v.reason;
        else if (v.mergeSha !== ex.mergeSha || v.resultSha !== ex.outSha) m.reason = 'The commits Ensemble checked are not the ones in the sandbox.';
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
              ? `${v.view.resolutionDiff.slice(0, RESOLUTION_DIFF_MAX_CHARS)}\n… (cut: the resolution is longer than Ensemble shows)\n`
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
        ? `Ensemble checked the merge commit: ${m.baseRef} is merged${m.conflictedFiles.length > 0 ? ` and ${m.conflictedFiles.length === 1 ? 'the conflict is' : `the ${m.conflictedFiles.length} conflicts are`} resolved` : ''}.`
        : `Nothing will be pushed: ${m.reason}`,
    );
    await storeFixTurn(ctx, l, { fixId, accountId, facts, prRepoPath, siblings: bootSiblings }, { patch, files, gitMessage, error, merge: m });
  }

  return subject;
}

/** The shown AiFix progress of a live session (the AiFixBanner's words). */
function progressOf(l: Live, phase: SandboxSessionPhase): AiFixProgress {
  if (phase === 'booting') return { phase: 'cloning' };
  // A built session whose review loop works (coding/ai-fix/loop.ts): the AiFix wire's `loop` says which round.
  if (phase === 'built') return { phase: 'fixing', message: 'Ensemble is reviewing the fix.' };
  const recent = l.state.conversation
    .filter((c) => c.kind === 'tool')
    .slice(-PROGRESS_TOOLS)
    .map((c) => (c.kind === 'tool' ? c.summary : ''));
  return { phase: phase === 'chatting' ? 'planning' : 'fixing', ...(recent.length > 0 ? { recentActivity: recent } : {}) };
}

/** After a build turn: the PR repository's patch + the report, normalised; every other edit left out. */
/** What a boot read of the ticket's other PRs (`afterMirror`); the PRs whose repository failed to mirror apart. */
interface BootSiblings {
  read: FixSiblingState[];
  failedPrIds: number[];
}

/**
 * THE SIBLING STATE a stored patch was built against (`ai_fixes.sibling_state_json`). Pure. This boot's reads; a
 * sibling whose repository failed to mirror keeps its earlier entry (never cleared by a failure). null ⇒ write
 * nothing (no sibling read at all: the stored state stays as it is).
 */
export function siblingStateToStore(boot: BootSiblings | null, stored: readonly FixSiblingState[]): FixSiblingState[] | null {
  if (boot == null) return null;
  const kept = stored.filter((e) => boot.failedPrIds.includes(e.prId));
  const out = [...boot.read, ...kept];
  return out.length > 0 ? out : null;
}

async function storeFixTurn(
  ctx: AgentContext,
  l: Live,
  o: { fixId: number; accountId: number; facts: FixFacts; prRepoPath: string | null; siblings: BootSiblings | null },
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
    if (n > 0) notice(l, `The report has ${n === 1 ? 'a problem' : `${n} problems`}, so Ensemble left those parts out: ${read.check.contentProblems[0]}`);
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
      unaddressed: [{ ref: MERGE_ITEM_REF, reason: `Ensemble: ${pre.merge.reason ?? 'the merge is not ready.'}` }, ...changeReport.unaddressed.filter((u) => u.ref !== MERGE_ITEM_REF)],
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
  // The patch just stored was built against what this boot read of the siblings: store it with it.
  if (o.siblings != null) {
    const prev = readSiblingState((await getFixById(ctx, o.accountId, o.fixId).catch(() => null))?.siblingStateJson ?? null);
    const next = siblingStateToStore(o.siblings, prev);
    if (next != null) await updateFixSession(ctx, o.accountId, o.fixId, { siblingStateJson: next }).catch(() => {});
  }

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
  // THE REVIEW LOOP stops first (its review aborted, its fix turn interrupted); the work so far is kept.
  const loopStopped = fixLoopActive(fixId) ? await stopFixLoop(ctx, accountId, fixId).catch(() => false) : false;
  if (l.driver == null || st.unattended) {
    await l.driver?.interrupt().catch(() => {});
    void closeSession(l, { phase: 'discarded', error: null });
    return true;
  }
  if (loopStopped) return true;
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
  const facts = (state as FixState).fix;
  if (facts) {
    await dropFixLoopRefs(facts.fullName, fixId).catch(() => {});
    await dropSiblingOverlayRefs(facts.fullName, fixId);
  }
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
    const facts = (state as FixState).fix;
    if (facts) {
      await dropFixLoopRefs(facts.fullName, fixId).catch(() => {});
      await dropSiblingOverlayRefs(facts.fullName, fixId);
    }
  }
}

/** The overlay commits other fixes laid this (sibling) fix on: dropped when it is pushed or discarded. Never throws. */
async function dropSiblingOverlayRefs(fullName: string, fixId: number): Promise<void> {
  const [owner, ...rest] = fullName.split('/');
  if (!owner || rest.length === 0) return;
  const { dropLocalRefs } = await import('../../review/local-refs.js');
  await dropLocalRefs(owner, rest.join('/'), SIBLING_OVERLAY_REF_KIND, fixId).catch(() => {});
}

/**
 * THE OVERLAY REFS' KEEPER (review/local-refs.ts; registered at boot by the AI Fix manager): a sibling fix's overlay
 * commits are kept while that fix is built and unpushed (another fix may lay it again). A fix that read one pins
 * its own base under its `refs/pierre/ai-fix/<fixId>/…` ref, so its sandbox base outlives this ref.
 */
export function registerSiblingOverlayRefKeeper(ctx: AgentContext, register: (kind: string, keeper: (ids: readonly number[]) => Promise<ReadonlySet<number>>) => void): void {
  register(SIBLING_OVERLAY_REF_KIND, async (ids) => {
    if (ids.length === 0) return new Set();
    const { and, inArray, isNull } = await import('drizzle-orm');
    const t = ctx.schema.aiFixes;
    const rows = (await ctx.db
      .select({ id: t.id, sessionPhase: t.sessionPhase })
      .from(t)
      .where(and(inArray(t.id, [...ids]), isNull(t.pushedAt)))
      .execute()) as Array<{ id: number; sessionPhase: string | null }>;
    return new Set(rows.filter((r) => r.sessionPhase === 'built').map((r) => r.id));
  });
}

/**
 * What the per-ticket line needs of a LIVE fix session (Plan first's Start fix takes the line again): its PR, the
 * repositories it loaded, and whether it is dependency automation's narrow fix. null when it is not live.
 */
export function fixLineFacts(fixId: number, accountId: number): { prId: number; prRepoId: number; number: number; workspaceId: number; loadedRepoIds: number[]; narrow: boolean } | null {
  const l = liveSession(fixKey(fixId));
  if (!l || l.accountId !== accountId || l.closing) return null;
  const st = l.state as FixState;
  if (!st.fix) return null;
  return { prId: st.fix.prId, prRepoId: st.fix.prRepoId, number: st.fix.number, workspaceId: l.workspaceId, loadedRepoIds: st.repos.map((r) => r.repoId), narrow: st.fix.narrow === true };
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
    // THE SCOPE IS RECOMPUTED AT BOOT (docs/SANDBOX.md § AI Fix sessions → Scope): the workspace's members now.
    const members = await fixDeps.memberRepoIds(accountId, r.workspaceId ?? 0).catch(() => [] as number[]);
    out = await resumeLive(() => {
      const subject = fixSubject(ctx, { fixId, accountId, facts, task: { kind: facts.taskKind, text: r.prompt ?? '' }, diff: capped.text, unattended: false, planFirst: false });
      return newLive(ctx, subject, { accountId, workspaceId: r.workspaceId ?? 0, choice, state, resume: true });
    }, members);
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
  const status = l.phase === 'built' && fixLoopActive(fixId) ? 'running' : aiFixStatusForPhase(l.phase, { pushed: false });
  return { status, progress: status === 'running' ? progressOf(l, l.phase) : null };
}

// ---- the review loop's hooks into a live fix session (coding/ai-fix/loop.ts) --------------------------------

/** The loop ended: the subject's own end (status from the phase, then close / Push when done). Never throws. */
export async function afterFixLoopEnded(ctx: AgentContext, accountId: number, fixId: number, stop: AiFixLoopStop): Promise<void> {
  const ender = loopEnders.get(fixId);
  if (ender) return ender(stop).catch(() => {});
  // No live subject: the row's status is derived from its phase again.
  const r = await getFixById(ctx, accountId, fixId).catch(() => null);
  if (r?.sessionPhase) await updateFixSession(ctx, accountId, fixId, { status: aiFixStatusForPhase(r.sessionPhase as SandboxSessionPhase, { pushed: r.pushedAt != null }) }).catch(() => {});
}

/** What the loop reads and writes in a live fix session (null when it is not live). */
export function liveFixIo(fixId: number): {
  root: string;
  repoPath: string | null;
  provider: import('@pierre-review/shared').AiProviderId;
  copyIn(files: Array<{ path: string; content: string; mode?: number }>): Promise<void>;
  runtime: Live['runtime'];
  container: string;
} | null {
  const l = liveSession(fixKey(fixId));
  if (!l || l.closing || !l.container || !l.layoutRoot) return null;
  const container = l.container;
  const st = l.state as FixState;
  const repoPath = st.repos.find((r) => r.repoId === st.fix?.prRepoId)?.path ?? null;
  return { root: l.layoutRoot, repoPath, provider: l.choice.provider, copyIn: (files) => l.runtime.copyIn(container, files), runtime: l.runtime, container };
}

/** One conversation line on a live fix session (a no-op when closed). */
export function noticeFix(fixId: number, text: string): void {
  const l = liveSession(fixKey(fixId));
  if (l && !l.closing) notice(l, text);
}

/** Stop a running turn of the fix's session (the loop's Stop during its fix turn). */
export async function interruptFixTurn(fixId: number): Promise<void> {
  const l = liveSession(fixKey(fixId));
  if (l && !l.closing) await l.driver?.interrupt().catch(() => {});
}

/** The loop moved: the AI Fix tab hears it (the fix stream's progress while it works, its `done` after). */
export function fixLoopChanged(_ctx: AgentContext, _accountId: number, fixId: number): void {
  const l = liveSession(fixKey(fixId));
  if (!l || l.closing) return;
  l.subject.onPhase?.(l, l.phase);
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
