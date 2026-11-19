import { and, eq, inArray } from 'drizzle-orm';
import {
  STORY_CHECK_OUTSIDE_REPOS_MAX,
  STORY_CHECK_UNLINKED_PRS_MAX,
  type TicketOutsideContext,
  type TicketOutsideSource,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { prepDefaultBranchCheckouts, prepPeerWorktrees } from '../clone-manager.js';
import { sameBranchPr } from '../claude-review/related-repos.js';
import type { PromptOutside, PromptOutsideBlock } from './prompts.js';

// CODE OUTSIDE THE TICKET (docs/CLAUDE-REVIEW.md § Ticket review → Outside the ticket). A story check reads
// the ticket's PRs; with the workspace's "Story checks read every repository" switch on (NULL = on,
// `workspaces.story_check_all_repos`) it ALSO reads, read-only:
//
//   repos         the workspace's OTHER repositories (no PR on the ticket) at their DEFAULT BRANCH, a fresh
//                 tip from Ensemble's clone cache (the same read as a merged member's default branch):
//                 repositories declared related to any member's repository first, then the rest by
//                 owner/name; at most STORY_CHECK_OUTSIDE_REPOS_MAX (repositories read as members do not
//                 count); the rest are NAMED (`leftOut`), never read.
//   unlinked PRs  OPEN PRs in a repository related to a member's, on that member's BRANCH NAME, that are
//                 not on the ticket — the PR review's rule 1 (`sameBranchPr`) — at their head; at most
//                 STORY_CHECK_UNLINKED_PRS_MAX.
//
// ⚠ ONE WORKSPACE: the run's own (`ticket_reviews.workspace_id`, the branch check's `workspaceId`); never
// another. ⚠ CONTEXT, NOT INPUTS: none of it enters the fingerprint (fingerprint.ts), so a push to some
// default branch never re-runs a check; a verdict leaning on it can be slightly out of date until the next
// run. ⚠ A source that cannot be checked out is NAMED (`read: false`) and skipped — it never fails the run:
// each has a time limit (OUTSIDE_CHECKOUT_TIMEOUT_MS), the run's abort stops the waiting, and a failure is
// remembered for OUTSIDE_FAILURE_BACKOFF_MS so no run retries it meanwhile. ⚠ Never a fork's PR, never a
// branch name equal to a default branch (`branchNameMatchable`).
// Every checkout is a path-guard root of the run and removed with it (`cleanup`).

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** How many default-branch checkouts are prepared at once (a run may ask for up to 12). */
export const OUTSIDE_CHECKOUT_CONCURRENCY = 4;

/**
 * THE OUTSIDE REPOSITORIES, in read order (the AI Fix scope's ordering idea — sandbox/session/fix.ts
 * `fixRepoSet`): declared-related repositories first (in the workspace's name order), then every other
 * workspace repository by owner/name; member repositories never; at most `max`, the rest NAMED. Pure.
 */
export function outsideRepoSet(a: {
  memberRepoIds: readonly number[];
  workspaceRepos: ReadonlyArray<{ repoId: number; fullName: string }>;
  declaredRepoIds: readonly number[];
  max?: number;
}): { ids: number[]; leftOut: string[] } {
  const members = new Set(a.memberRepoIds);
  const byName = [...a.workspaceRepos]
    .filter((r) => !members.has(r.repoId))
    .sort((x, y) => x.fullName.toLowerCase().localeCompare(y.fullName.toLowerCase()) || x.repoId - y.repoId);
  const declared = new Set(a.declaredRepoIds);
  const ordered = [...byName.filter((r) => declared.has(r.repoId)), ...byName.filter((r) => !declared.has(r.repoId))];
  const max = Math.max(0, a.max ?? STORY_CHECK_OUTSIDE_REPOS_MAX);
  return { ids: ordered.slice(0, max).map((r) => r.repoId), leftOut: ordered.slice(max).map((r) => r.fullName) };
}

/**
 * May a branch NAME tie two PRs together? Not when it is either repository's DEFAULT branch (every
 * repository has a `main`; a PR from it says nothing about the ticket). Pure. No other generic names are
 * guessed.
 */
export function branchNameMatchable(branch: string | null | undefined, defaultBranches: ReadonlyArray<string | null | undefined>): boolean {
  const b = branch?.trim();
  if (!b) return false;
  return !defaultBranches.some((d) => d != null && d.trim() !== '' && d.trim() === b);
}

/** "Story checks read every repository" for this workspace: ON unless a stored false (and false for a
 *  workspace that is not this account's). Never throws (a read error reads off: members only). */
export async function storyCheckAllReposOn(ctx: AgentContext, accountId: number, workspaceId: number): Promise<boolean> {
  try {
    const w = s(ctx).workspaces;
    const rows = (await ctx.db
      .select({ on: w.storyCheckAllRepos })
      .from(w)
      .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ on: boolean | null }>;
    return rows.length > 0 && rows[0]!.on !== false;
  } catch {
    return false;
  }
}

/** One member as the outside plan needs it. `branch` undefined + `prId` ⇒ read from `pull_requests`. */
export interface OutsideMember {
  prId: number | null;
  repoId: number;
  open: boolean;
  branch?: string | null;
  // The member's prompt ref ('PR1'), for "same branch as PR1".
  ref: string;
}

export interface OutsideRepo {
  repoId: number;
  owner: string;
  name: string;
  defaultBranch: string | null;
}

export interface UnlinkedPr {
  prId: number;
  repoId: number;
  owner: string;
  name: string;
  number: number;
  headSha: string;
  // The member ref whose branch name it shares.
  sameBranchAs: string;
}

export interface OutsidePlan {
  repos: OutsideRepo[];
  unlinked: UnlinkedPr[];
  leftOut: string[];
}

export const EMPTY_OUTSIDE_PLAN: OutsidePlan = { repos: [], unlinked: [], leftOut: [] };

/**
 * What to read beyond the members (DB only; see the header). Account- and workspace-scoped. Never throws:
 * a failure costs the outside context only.
 */
export async function planOutside(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  members: readonly OutsideMember[],
  opts: { maxRepos?: number; maxUnlinked?: number } = {},
): Promise<OutsidePlan> {
  try {
    const { repos, workspaceRepos: wr, repoRelations: rel, pullRequests: prs } = s(ctx);
    const home = (await ctx.db
      .select({ repoId: repos.id, owner: repos.owner, name: repos.name, defaultBranch: repos.defaultBranch, defaultBranchName: repos.defaultBranchName })
      .from(wr)
      .innerJoin(repos, and(eq(repos.id, wr.repoId), eq(repos.accountId, wr.accountId)))
      .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
      .execute()) as Array<{ repoId: number; owner: string; name: string; defaultBranch: string | null; defaultBranchName: string | null }>;
    const inWs = new Map(home.map((r) => [r.repoId, r]));
    const memberRepoIds = [...new Set(members.map((m) => m.repoId))];
    const relRows = memberRepoIds.length === 0
      ? []
      : ((await ctx.db
          .select({ repoId: rel.repoId, relatedRepoId: rel.relatedRepoId })
          .from(rel)
          .where(and(eq(rel.accountId, accountId), eq(rel.workspaceId, workspaceId), inArray(rel.repoId, memberRepoIds)))
          .execute()) as Array<{ repoId: number; relatedRepoId: number }>);
    // Related = a member of THIS workspace now (a stale relation is never read).
    const relatedOf = new Map<number, number[]>();
    for (const r of relRows) {
      if (!inWs.has(r.relatedRepoId) || r.relatedRepoId === r.repoId) continue;
      relatedOf.set(r.repoId, [...(relatedOf.get(r.repoId) ?? []), r.relatedRepoId]);
    }
    const pick = outsideRepoSet({
      memberRepoIds,
      workspaceRepos: home.map((r) => ({ repoId: r.repoId, fullName: `${r.owner}/${r.name}` })),
      declaredRepoIds: [...new Set(relRows.map((r) => r.relatedRepoId))],
      max: opts.maxRepos ?? STORY_CHECK_OUTSIDE_REPOS_MAX,
    });
    const outRepos: OutsideRepo[] = pick.ids.map((id) => {
      const r = inWs.get(id)!;
      return { repoId: id, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch || r.defaultBranchName || null };
    });

    // ---- unlinked same-branch PRs ----
    const unlinked: UnlinkedPr[] = [];
    const maxUnlinked = Math.max(0, opts.maxUnlinked ?? STORY_CHECK_UNLINKED_PRS_MAX);
    const open = members.filter((m) => m.open && (relatedOf.get(m.repoId)?.length ?? 0) > 0);
    if (open.length > 0 && maxUnlinked > 0) {
      const need = open.filter((m) => m.branch === undefined && m.prId != null).map((m) => m.prId!);
      const branchOf = new Map<number, string | null>();
      if (need.length > 0) {
        const rows = (await ctx.db
          .select({ id: prs.id, headRefName: prs.headRefName })
          .from(prs)
          .where(and(eq(prs.accountId, accountId), inArray(prs.id, need)))
          .execute()) as Array<{ id: number; headRefName: string | null }>;
        for (const r of rows) branchOf.set(r.id, r.headRefName);
      }
      const relatedIds = [...new Set(open.flatMap((m) => relatedOf.get(m.repoId) ?? []))];
      const memberPrIds = new Set(members.map((m) => m.prId).filter((id): id is number => id != null));
      // A BRANCH member (the review loop's target, no PR id): a PR on that very branch in that repository
      // is the member itself, never an unlinked PR.
      const memberBranches = new Set(members.filter((m) => m.prId == null && m.branch).map((m) => `${m.repoId}:${m.branch}`));
      const candidates = (await ctx.db
        .select({ prId: prs.id, repoId: prs.repoId, number: prs.number, headRefName: prs.headRefName, headSha: prs.headSha, fork: prs.isCrossRepository })
        .from(prs)
        .where(and(eq(prs.accountId, accountId), inArray(prs.repoId, relatedIds), eq(prs.state, 'open')))
        .execute()) as Array<{ prId: number; repoId: number; number: number; headRefName: string | null; headSha: string | null; fork: boolean | null }>;
      // Each member repository's default branch (it may sit outside this workspace): a member ON its
      // default branch shares a name with every repository's main, which says nothing about the ticket.
      const memberDefaults = new Map(
        ((await ctx.db
          .select({ id: repos.id, defaultBranch: repos.defaultBranch, defaultBranchName: repos.defaultBranchName })
          .from(repos)
          .where(and(eq(repos.accountId, accountId), inArray(repos.id, [...new Set(open.map((m) => m.repoId))])))
          .execute()) as Array<{ id: number; defaultBranch: string | null; defaultBranchName: string | null }>).map((r) => [r.id, r.defaultBranch || r.defaultBranchName || null]),
      );
      const seen = new Set<number>();
      for (const m of open) {
        const branch = (m.branch !== undefined ? m.branch : m.prId != null ? branchOf.get(m.prId) : null)?.trim() || null;
        if (!branch || !branchNameMatchable(branch, [memberDefaults.get(m.repoId) ?? null])) continue;
        const related = [...(relatedOf.get(m.repoId) ?? [])].sort((a, b) =>
          `${inWs.get(a)!.owner}/${inWs.get(a)!.name}`.toLowerCase().localeCompare(`${inWs.get(b)!.owner}/${inWs.get(b)!.name}`.toLowerCase()),
        );
        for (const repoId of related) {
          if (unlinked.length >= maxUnlinked) break;
          const hit = sameBranchPr(
            candidates.filter(
              (c) =>
                c.repoId === repoId &&
                // ⚠ A FORK's branch name is chosen in someone else's repository: never "the same branch".
                c.fork !== true &&
                // …and a PR from the related repository's own default branch is never "the same branch".
                branchNameMatchable(branch, [inWs.get(repoId)?.defaultBranch || inWs.get(repoId)?.defaultBranchName || null]) &&
                !memberPrIds.has(c.prId) &&
                !memberBranches.has(`${c.repoId}:${c.headRefName}`) &&
                !seen.has(c.prId) &&
                (c.headSha ?? '') !== '',
            ),
            branch,
          );
          if (!hit) continue;
          seen.add(hit.prId);
          const r = inWs.get(repoId)!;
          unlinked.push({ prId: hit.prId, repoId, owner: r.owner, name: r.name, number: hit.number, headSha: hit.headSha!, sameBranchAs: m.ref });
        }
      }
    }
    return { repos: outRepos, unlinked, leftOut: pick.leftOut };
  } catch (err) {
    ctx.log.warn(`story check: code outside the ticket not read: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_OUTSIDE_PLAN;
  }
}

/**
 * ONE SOURCE'S TIME LIMIT: a checkout (clone, fetch, worktree) that has not finished in this long is named
 * "not read" and the run goes on without it. Generous enough for a first clone of a large repository,
 * short enough that one inaccessible repository cannot stall a story check.
 */
export const OUTSIDE_CHECKOUT_TIMEOUT_MS = 120_000;
/** A source that failed (an error or the time limit) is not tried again by any run for this long. */
export const OUTSIDE_FAILURE_BACKOFF_MS = 10 * 60_000;

// `owner/name` (lower case) → retry not before (ms). In memory: a restart forgets it, which is fine.
const failedUntil = new Map<string, number>();

/** Test seam: forget every remembered failure. */
export function _resetOutsideBackoffForTest(): void {
  failedUntil.clear();
}

export interface PrepareOutsideDeps {
  prepDefaults?: typeof prepDefaultBranchCheckouts;
  prepPeers?: typeof prepPeerWorktrees;
  timeoutMs?: number;
  backoffMs?: number;
  now?: () => number;
  // The switch as the caller already read it (so the fingerprint and the read agree); absent ⇒ read it.
  switchOn?: boolean;
}

type Got = { path: string | null; sha: string | null; branch: string | null; failed: boolean };

/**
 * One checkout with a time limit and the run's abort signal. Whatever happens, a checkout that finishes
 * AFTER the run stopped waiting is removed at once (its cleanup), so nothing is left behind.
 */
async function bounded(
  key: string,
  start: () => Promise<{ got: Got; cleanup: () => Promise<void> }>,
  o: { signal?: AbortSignal; timeoutMs: number; backoffMs: number; now: () => number; cleanups: Array<() => Promise<void>> },
): Promise<Got> {
  const none: Got = { path: null, sha: null, branch: null, failed: true };
  const until = failedUntil.get(key);
  if (until != null && until > o.now()) return none;
  if (o.signal?.aborted) return { ...none, failed: false };
  let gaveUp = false;
  const work = start().then(
    (r) => {
      if (gaveUp) void r.cleanup().catch(() => {});
      else o.cleanups.push(r.cleanup);
      return r.got;
    },
    (): Got => none,
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const stop = new Promise<'timeout' | 'aborted'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), o.timeoutMs);
    onAbort = () => resolve('aborted');
    o.signal?.addEventListener('abort', onAbort, { once: true });
  });
  const res = await Promise.race([work, stop]);
  if (timer) clearTimeout(timer);
  if (onAbort) o.signal?.removeEventListener('abort', onAbort);
  if (res === 'timeout' || res === 'aborted') {
    gaveUp = true;
    if (res === 'timeout') failedUntil.set(key, o.now() + o.backoffMs);
    return { ...none, failed: res === 'timeout' };
  }
  if (res.failed || res.path == null) failedUntil.set(key, o.now() + o.backoffMs);
  else failedUntil.delete(key);
  return res;
}

/** Run `fn` over `items`, at most `n` at a time, keeping the order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export interface PreparedOutside {
  // For the prompt (refs 'X1'…: repositories first, then the unlinked PRs).
  block: PromptOutsideBlock;
  // Stored on the run (`TicketAssessment.outside`).
  context: TicketOutsideContext;
  // Every checkout path (path-guard roots).
  roots: string[];
  cleanup: () => Promise<void>;
}

/**
 * Check the plan out read-only from Ensemble's clone cache: each repository at its default branch's fresh
 * tip, each unlinked PR at its head — OUTSIDE_CHECKOUT_CONCURRENCY at a time, each within
 * OUTSIDE_CHECKOUT_TIMEOUT_MS, and none once `signal` aborts (a cancel stops the waiting). A source that
 * cannot be prepared (an error, the time limit, or a failure in the last OUTSIDE_FAILURE_BACKOFF_MS) stays
 * NAMED with `read: false`. Never throws.
 */
export async function prepareOutside(plan: OutsidePlan, deps: PrepareOutsideDeps = {}, signal?: AbortSignal): Promise<PreparedOutside> {
  const prepDefaults = deps.prepDefaults ?? prepDefaultBranchCheckouts;
  const prepPeers = deps.prepPeers ?? prepPeerWorktrees;
  const cleanups: Array<() => Promise<void>> = [];
  const o = {
    ...(signal ? { signal } : {}),
    timeoutMs: deps.timeoutMs ?? OUTSIDE_CHECKOUT_TIMEOUT_MS,
    backoffMs: deps.backoffMs ?? OUTSIDE_FAILURE_BACKOFF_MS,
    now: deps.now ?? Date.now,
    cleanups,
  };
  type Job = { kind: 'repo'; r: OutsideRepo } | { kind: 'pr'; u: UnlinkedPr };
  const jobs: Job[] = [...plan.repos.map((r) => ({ kind: 'repo' as const, r })), ...plan.unlinked.map((u) => ({ kind: 'pr' as const, u }))];
  const got = await pool(jobs, OUTSIDE_CHECKOUT_CONCURRENCY, (j) =>
    j.kind === 'repo'
      ? bounded(`${j.r.owner}/${j.r.name}`.toLowerCase(), async () => {
          const res = await prepDefaults([{ owner: j.r.owner, name: j.r.name, branch: j.r.defaultBranch }]);
          const c = res.checkouts[0];
          return { got: { path: c?.path ?? null, sha: c?.sha ?? null, branch: c?.branch ?? j.r.defaultBranch, failed: c?.path == null }, cleanup: res.cleanup };
        }, o)
      : bounded(`${j.u.owner}/${j.u.name}`.toLowerCase(), async () => {
          const res = await prepPeers([{ owner: j.u.owner, name: j.u.name, number: j.u.number, headSha: j.u.headSha }]);
          const c = res.peers[0];
          return { got: { path: c?.path ?? null, sha: j.u.headSha, branch: null, failed: c?.path == null }, cleanup: res.cleanup };
        }, o),
  );
  const sources: PromptOutside[] = [];
  const stored: TicketOutsideSource[] = [];
  jobs.forEach((j, i) => {
    const g = got[i]!;
    const ref = `X${sources.length + 1}`;
    if (j.kind === 'repo') {
      const r = j.r;
      sources.push({ ref, kind: 'repo', repoId: r.repoId, repo: `${r.owner}/${r.name}`, prId: null, number: null, branch: g.branch ?? r.defaultBranch, sha: g.path != null ? g.sha : null, path: g.path, sameBranchAs: null });
      stored.push({ ref, kind: 'repo', repoId: r.repoId, repo: `${r.owner}/${r.name}`, prId: null, number: null, sha: g.path != null ? g.sha : null, read: g.path != null });
    } else {
      const u = j.u;
      sources.push({ ref, kind: 'unlinked_pr', repoId: u.repoId, repo: `${u.owner}/${u.name}`, prId: u.prId, number: u.number, branch: null, sha: u.headSha, path: g.path, sameBranchAs: u.sameBranchAs });
      stored.push({ ref, kind: 'unlinked_pr', repoId: u.repoId, repo: `${u.owner}/${u.name}`, prId: u.prId, number: u.number, sha: u.headSha, read: g.path != null });
    }
  });
  let cleaned = false;
  return {
    block: { sources, leftOut: [...plan.leftOut] },
    context: { sources: stored, leftOut: [...plan.leftOut] },
    roots: sources.map((x) => x.path).filter((p): p is string => p != null),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await Promise.all(cleanups.map((c) => c().catch(() => {})));
    },
  };
}

/** Nothing outside the ticket (the switch off, or nothing to read). */
export function noOutside(): PreparedOutside {
  return { block: { sources: [], leftOut: [] }, context: { sources: [], leftOut: [] }, roots: [], cleanup: async () => {} };
}

/** Is there anything to say about outside code (a source, or a named left-out repository)? */
export function hasOutside(o: Pick<TicketOutsideContext, 'sources' | 'leftOut'>): boolean {
  return o.sources.length > 0 || o.leftOut.length > 0;
}

/**
 * THE ONE DOOR for both story checks (the ticket review and the review loop's branch check): the switch,
 * the plan, the checkouts. The switch off ⇒ nothing (members only). Never throws.
 */
export async function readOutsideForStoryCheck(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  members: readonly OutsideMember[],
  signal?: AbortSignal,
  deps: PrepareOutsideDeps = {},
): Promise<PreparedOutside> {
  const on = deps.switchOn ?? (await storyCheckAllReposOn(ctx, accountId, workspaceId));
  if (!on) return noOutside();
  const plan = await planOutside(ctx, accountId, workspaceId, members);
  if (plan.repos.length === 0 && plan.unlinked.length === 0 && plan.leftOut.length === 0) return noOutside();
  return prepareOutside(plan, deps, signal);
}
