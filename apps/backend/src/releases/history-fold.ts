// THE HISTORY PASS'S PURE HALF (docs/RELEASES.md § Implementation → One history pass). No DB, no
// GitHub, no clock. Two jobs:
//
//   1. `walkHistoryPage` — one page of GitHub's `history` (git log order: every reachable commit,
//      newest first) → the FIRST-PARENT commits in it, each with the PRs merged INTO THE DEFAULT
//      BRANCH it came from. The chain is followed by `parents(first: 1)`: a commit is first-parent
//      exactly when it is the commit the walk expects next. It stops at the segment's stop commit (a
//      tip segment meets the walked head), at a commit `pauseAfter` names (the deep segment meets the
//      baseline), or at the root.
//   2. `historyView` — the walked commits (newest first) + the stored tags → each tag's place ON THE
//      DEFAULT BRANCH (true / false / not known yet) and each tag's INCREMENT. A commit belongs to the
//      nearest tag at or above it along the first-parent order: walking newest first, every commit
//      takes the tag group most recently passed (the newest tagged commit at or after it). Commits
//      above the newest tag are in no tag yet. Tags on ONE commit share it: the first in the shared
//      tag order (`compareTagOrder`) takes the increment, the others are empty. An increment is
//      COMPLETE once the walk has passed the next tagged commit below it (or reached the root).
import { compareTagOrder, type TagOrderKey } from '@pierre-review/shared';
import type { GqlHistoryCommit, GqlHistoryPr } from '../github/tag-queries.js';

/** A PR the history read gave for a commit: merged into the default branch of THIS repo. */
export interface HistoryPr {
  number: number;
  title: string;
  url: string;
  headRefName: string | null;
  authorLogin: string | null;
  /** GitHub typed the author a Bot. */
  authorIsBotType: boolean;
  mergedAt: Date | null;
  mergeSha: string | null;
}

export interface WalkedCommit {
  sha: string;
  committedAt: Date | null;
  prs: HistoryPr[];
}

const dateOf = (s: string | null | undefined): Date | null => {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The PRs of one commit that count for a range: merged, into the default branch, of THIS repo (a
 *  fork's PR can appear in the network). The PR whose merge commit IS this commit first. Pure. */
export function historyPrsOf(
  nodes: ReadonlyArray<GqlHistoryPr | null> | null | undefined,
  commitSha: string,
  fullName: string,
  defaultBranch: string,
): HistoryPr[] {
  const out: HistoryPr[] = [];
  for (const p of nodes ?? []) {
    if (p == null || typeof p.number !== 'number' || p.merged !== true) continue;
    if (p.baseRefName !== defaultBranch) continue;
    const repo = p.repository?.nameWithOwner;
    if (repo != null && repo.toLowerCase() !== fullName.toLowerCase()) continue;
    if (out.some((x) => x.number === p.number)) continue;
    const owner = fullName.slice(0, fullName.indexOf('/'));
    const name = fullName.slice(fullName.indexOf('/') + 1);
    out.push({
      number: p.number,
      title: typeof p.title === 'string' && p.title.length > 0 ? p.title.slice(0, 500) : `#${p.number}`,
      url:
        typeof p.url === 'string' && p.url.startsWith('https://')
          ? p.url
          : `https://github.com/${owner}/${name}/pull/${p.number}`,
      headRefName: typeof p.headRefName === 'string' ? p.headRefName.slice(0, 255) : null,
      authorLogin: typeof p.author?.login === 'string' ? p.author.login : null,
      authorIsBotType: p.author?.__typename === 'Bot',
      mergedAt: dateOf(p.mergedAt),
      mergeSha: typeof p.mergeCommit?.oid === 'string' ? p.mergeCommit.oid : null,
    });
  }
  return out.sort((a, b) => Number(b.mergeSha === commitSha) - Number(a.mergeSha === commitSha));
}

export interface WalkPageResult {
  /** First-parent commits taken from this page, newest first. */
  taken: WalkedCommit[];
  /** The next first-parent commit to look for; null = the root was reached. */
  expected: string | null;
  /** The segment's stop commit was met (a tip segment joined the walked chain). Not taken. */
  reachedStop: boolean;
  /** `pauseAfter` named a taken commit: the walk stops after it, part way through the page (the page
   *  is read again from the same cursor when the walk goes on). */
  paused: boolean;
}

/**
 * One history page → its first-parent commits. `expected` is the commit the walk looks for; any other
 * commit (a merged branch's own commits) is passed over. Pure.
 */
export function walkHistoryPage(
  nodes: ReadonlyArray<GqlHistoryCommit | null> | null | undefined,
  a: {
    expected: string | null;
    stopSha?: string | null;
    fullName: string;
    defaultBranch: string;
    pauseAfter?: (sha: string) => boolean;
  },
): WalkPageResult {
  let expected = a.expected;
  const taken: WalkedCommit[] = [];
  for (const node of nodes ?? []) {
    if (expected == null) break;
    const sha = node?.oid;
    if (typeof sha !== 'string' || sha !== expected) continue;
    if (a.stopSha != null && sha === a.stopSha) return { taken, expected, reachedStop: true, paused: false };
    taken.push({
      sha,
      committedAt: dateOf(node!.committedDate),
      prs: historyPrsOf(node!.associatedPullRequests?.nodes, sha, a.fullName, a.defaultBranch),
    });
    const parent = node!.parents?.nodes?.[0]?.oid;
    expected = typeof parent === 'string' ? parent : null;
    if (a.pauseAfter?.(sha) === true) return { taken, expected, reachedStop: false, paused: true };
  }
  return { taken, expected, reachedStop: false, paused: false };
}

// ── The view ────────────────────────────────────────────────────────────────────────────────────

export interface StoredHistoryCommit {
  sha: string;
  seq: number;
  prNumbers: number[];
  committedAt: Date | null;
}

export interface HistoryTag extends TagOrderKey {
  sha: string;
}

export interface HistoryCoverage {
  /** The walk reached the root and every commit down to it is in `commits` (no floor applied). */
  coversAll: boolean;
  /** A tip segment is still walking: commits newer than the walked head are not read yet. */
  tipPending: boolean;
  /** The walked head's commit date (tags dated after it are not known yet while the tip walks). */
  topCommittedAt: Date | null;
}

export interface HistoryIncrement {
  tagName: string;
  sha: string;
  baseTagName: string | null;
  baseSha: string | null;
  prNumbers: number[];
  commitCount: number;
  unmatchedCommits: number;
}

export interface HistoryViewResult {
  /** tag name → on the default branch: true, false, or null (not known yet). */
  onDefaultBranch: Map<string, boolean | null>;
  /** The COMPLETE increments of the tags on the default branch (a missing one is still being read). */
  increments: HistoryIncrement[];
}

/**
 * The walked commits (any order; sorted newest first here) and the tags → each tag's place on the
 * default branch and the complete increments. Pure.
 */
export function historyView(
  commits: readonly StoredHistoryCommit[],
  tags: readonly HistoryTag[],
  coverage: HistoryCoverage,
): HistoryViewResult {
  const ordered = [...commits].sort((x, y) => y.seq - x.seq);
  const walked = new Set(ordered.map((c) => c.sha));
  let oldestAt: number | null = null;
  for (const c of ordered) if (c.committedAt != null) oldestAt = Math.min(oldestAt ?? Infinity, c.committedAt.getTime());

  const onDefaultBranch = new Map<string, boolean | null>();
  for (const t of tags) {
    if (walked.has(t.sha)) {
      onDefaultBranch.set(t.name, true);
      continue;
    }
    const at = t.committedAt?.getTime() ?? null;
    // A tag dated after the walked head may be on the tip still being read.
    const tipMayHold = coverage.tipPending && (at == null || coverage.topCommittedAt == null || at > coverage.topCommittedAt.getTime());
    if (tipMayHold) onDefaultBranch.set(t.name, null);
    else if (coverage.coversAll) onDefaultBranch.set(t.name, false);
    else if (at != null && oldestAt != null && at > oldestAt) onDefaultBranch.set(t.name, false);
    else onDefaultBranch.set(t.name, null);
  }

  // Tag groups: the tagged commits on the default branch, walked newest first.
  const onMain = tags.filter((t) => onDefaultBranch.get(t.name) === true && t.committedAt != null).sort(compareTagOrder);
  const shaTagged = new Set(onMain.map((t) => t.sha));
  const group = new Map<string, { prs: Set<number>; commits: number; unmatched: number; complete: boolean }>();
  let current: string | null = null;
  for (const c of ordered) {
    if (shaTagged.has(c.sha)) {
      // The group above is complete: the walk passed the next tagged commit below it.
      if (current != null) group.get(current)!.complete = true;
      current = c.sha;
      group.set(current, { prs: new Set(), commits: 0, unmatched: 0, complete: false });
    }
    if (current == null) continue;
    const g = group.get(current)!;
    g.commits += 1;
    if (c.prNumbers.length === 0) g.unmatched += 1;
    for (const n of c.prNumbers) g.prs.add(n);
  }
  if (current != null && coverage.coversAll) group.get(current)!.complete = true;

  const increments: HistoryIncrement[] = [];
  const firstOnSha = new Set<string>();
  for (let i = 0; i < onMain.length; i += 1) {
    const t = onMain[i]!;
    const prev = i > 0 ? onMain[i - 1]! : null;
    // A later tag on an already-seen commit adds nothing: its (empty) increment is always complete.
    const first = !firstOnSha.has(t.sha);
    firstOnSha.add(t.sha);
    const g = group.get(t.sha);
    if (first && (g == null || !g.complete)) continue;
    increments.push({
      tagName: t.name,
      sha: t.sha,
      baseTagName: prev?.name ?? null,
      baseSha: prev?.sha ?? null,
      prNumbers: first ? [...g!.prs].sort((a, b) => a - b) : [],
      commitCount: first ? g!.commits : 0,
      unmatchedCommits: first ? g!.unmatched : 0,
    });
  }
  return { onDefaultBranch, increments };
}

// ── Release points (a repository released from merged pull requests) ─────────────────────────────

export interface ReleasePoint {
  /** `#539` (shared `releasePointName`). */
  name: string;
  sha: string;
  prNumber: number;
  /** The commit's date, nudged so the points sort in WALK order (each 1 ms after the one below it when
   *  the dates tie or run backwards: a rebase merge, a clock skew). */
  committedAt: Date | null;
}

/**
 * docs/RELEASES.md § Releasing without version tags: in a repository released from MERGED PULL REQUESTS,
 * every pull request's NEWEST first-parent commit is a release point — a squash or merge commit is the
 * PR's one commit; a rebase merge's earlier commits fall to the point above them. A commit that brings
 * more than one new PR is one point, named by the first. Commits with no PR (direct pushes) belong to the
 * point above them. Newest first. Pure.
 */
export function releasePointsOf(commits: readonly StoredHistoryCommit[]): ReleasePoint[] {
  const ordered = [...commits].sort((x, y) => y.seq - x.seq);
  const seen = new Set<number>();
  const points: ReleasePoint[] = [];
  for (const c of ordered) {
    const fresh = c.prNumbers.filter((n) => !seen.has(n));
    for (const n of c.prNumbers) seen.add(n);
    if (fresh.length === 0) continue;
    points.push({ name: `#${fresh[0]!}`, sha: c.sha, prNumber: fresh[0]!, committedAt: c.committedAt });
  }
  // Oldest first: a date never earlier than (and never equal to) the point below it.
  let prev: number | null = null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i]!;
    const at = p.committedAt?.getTime() ?? null;
    if (at == null) continue;
    const next: number = prev != null && at <= prev ? prev + 1 : at;
    if (next !== at) p.committedAt = new Date(next);
    prev = next;
  }
  return points;
}
