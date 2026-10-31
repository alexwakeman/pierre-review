import type { ActivityRepo, NewSinceLastViewed, RepoBranchStatus, TimelinePr } from './types.js';

// THE REPO STATUS FOLD — what the two dots on a sidebar repo row mean, and the lines of the status
// panel at the top of that repo's view. ONE fold, read by both, so the dot and the panel can never
// disagree about why a repo is red or blue (docs/FRONTEND.md § The repo status panel).
//
//   RED  — something in the repo needs someone to act:
//          a review requested from you · the default branch failing CI ·
//          open PRs failing CI · open PRs with merge conflicts (drafts not counted for the last two).
//   BLUE — new since you last opened them: comments, reviews or commits by someone else on open PRs
//          you have opened before. It clears per PR when you open that PR (`pr_views`), or for the
//          whole repo with "Mark all seen". Opening the repo view does NOT clear it.
//
// Pure, no AI, no fetch: it reads the `/api/activity` repo entry and the `/api/branch-status` row
// the sidebar already holds. ⚠ The default branch line is a READOUT (docs/MERGE-CI-TRUNK.md: trunk
// status feeds no counts, badges or My Turn) — it adds to the red dot, which already showed it, and
// to nothing else.

export type RepoStatusTone = 'attention' | 'new';

export type RepoStatusKind = 'review_requested' | 'trunk_failing' | 'ci_failing' | 'conflicts' | 'new_activity';

export interface RepoStatusPr {
  prId: number;
  number: number;
  title: string;
  /** new_activity only: what is new on this PR ("2 comments, 1 commit"). */
  detail: string | null;
  /** new_activity only: when you last opened this PR (ISO), null when unknown. */
  since: string | null;
}

export interface RepoStatusLine {
  kind: RepoStatusKind;
  tone: RepoStatusTone;
  /** The whole fact, in plain English ("2 pull requests are failing CI"). */
  text: string;
  /** The PRs behind it, where to act. Empty for the default-branch line. */
  prs: RepoStatusPr[];
}

export interface RepoStatusSummary {
  /** Red lines first (in a fixed order), then the blue line. Empty when nothing needs a look. */
  lines: RepoStatusLine[];
  /** The red dot. */
  attention: boolean;
  /** The blue dot. */
  hasNew: boolean;
  /** One sentence for the red dot's name / tooltip, null when not red. */
  attentionWords: string | null;
  /** One sentence for the blue dot's name / tooltip, null when not blue. */
  newWords: string | null;
}

/** Something by someone else is new on this PR since you last opened it. */
export function hasNewSinceLastViewed(n: NewSinceLastViewed | null | undefined): boolean {
  return n != null && n.comments + n.reviews + n.commits > 0;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 comments, 1 review and 2 commits" — zero parts left out; '' when all are zero. */
export function newActivityWords(n: NewSinceLastViewed): string {
  const parts: string[] = [];
  if (n.comments > 0) parts.push(count(n.comments, 'comment', 'comments'));
  if (n.reviews > 0) parts.push(count(n.reviews, 'review', 'reviews'));
  if (n.commits > 0) parts.push(count(n.commits, 'commit', 'commits'));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function prRef(pr: TimelinePr, extra?: { detail: string | null; since: string | null }): RepoStatusPr {
  return {
    prId: pr.id,
    number: pr.number,
    title: pr.title,
    detail: extra?.detail ?? null,
    since: extra?.since ?? null,
  };
}

const PRS = (n: number): string => count(n, 'pull request', 'pull requests');
const IS = (n: number): string => (n === 1 ? 'is' : 'are');
const HAS = (n: number): string => (n === 1 ? 'has' : 'have');

export function repoStatusSummary(
  repo: Pick<ActivityRepo, 'prs'> & { unreadPrs?: ActivityRepo['unreadPrs'] },
  branch: Pick<RepoBranchStatus, 'branchName' | 'ciStatus'> | null,
): RepoStatusSummary {
  const open = repo.prs.filter((p) => p.state === 'open');
  const ready = open.filter((p) => !p.isDraft);
  const lines: RepoStatusLine[] = [];

  const review = ready.filter((p) => p.reviewRequestedFromMe);
  if (review.length > 0) {
    lines.push({
      kind: 'review_requested',
      tone: 'attention',
      text: `${PRS(review.length)} ${IS(review.length)} waiting for your review`,
      prs: review.map((p) => prRef(p)),
    });
  }

  if (branch?.branchName != null && (branch.ciStatus === 'failure' || branch.ciStatus === 'error')) {
    lines.push({ kind: 'trunk_failing', tone: 'attention', text: `${branch.branchName} is failing CI`, prs: [] });
  }

  const ci = ready.filter((p) => p.ciStatus === 'failure' || p.ciStatus === 'error');
  if (ci.length > 0) {
    lines.push({
      kind: 'ci_failing',
      tone: 'attention',
      text: `${PRS(ci.length)} ${IS(ci.length)} failing CI`,
      prs: ci.map((p) => prRef(p)),
    });
  }

  const conflicts = ready.filter((p) => p.mergeable === 'conflicting' || p.mergeStateStatus === 'dirty');
  if (conflicts.length > 0) {
    lines.push({
      kind: 'conflicts',
      tone: 'attention',
      text: `${PRS(conflicts.length)} ${HAS(conflicts.length)} merge conflicts`,
      prs: conflicts.map((p) => prRef(p)),
    });
  }

  const sinceByPr = new Map((repo.unreadPrs ?? []).map((u) => [u.prId, u.lastViewedAt]));
  const fresh = open
    .filter((p) => hasNewSinceLastViewed(p.newSinceLastViewed))
    .map((p) => ({ p, n: p.newSinceLastViewed as NewSinceLastViewed }))
    .sort((a, b) => b.n.comments + b.n.reviews + b.n.commits - (a.n.comments + a.n.reviews + a.n.commits));
  let newWords: string | null = null;
  if (fresh.length > 0) {
    const total: NewSinceLastViewed = { comments: 0, reviews: 0, commits: 0 };
    for (const { n } of fresh) {
      total.comments += n.comments;
      total.reviews += n.reviews;
      total.commits += n.commits;
    }
    const text = `${newActivityWords(total)} on ${PRS(fresh.length)} since you last opened ${fresh.length === 1 ? 'it' : 'them'}`;
    newWords = `New: ${text}`;
    lines.push({
      kind: 'new_activity',
      tone: 'new',
      text: text.charAt(0).toUpperCase() + text.slice(1),
      prs: fresh.map(({ p, n }) => prRef(p, { detail: newActivityWords(n), since: sinceByPr.get(p.id) ?? null })),
    });
  }

  const red = lines.filter((l) => l.tone === 'attention');
  return {
    lines,
    attention: red.length > 0,
    hasNew: fresh.length > 0,
    attentionWords: red.length > 0 ? `Needs attention: ${red.map((l) => l.text).join('; ')}` : null,
    newWords,
  };
}
