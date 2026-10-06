// ONE PR'S SHARE OF A TICKET REVIEW — the pure half of the PR pane's slim Story check
// (TicketCoverage.tsx) and of the "See the whole story in Open PRs" jump (the Open PRs ticket
// stack's Story check panel, Activity/StackStoryCheck.tsx).
//
// A ticket review judges the ticket across EVERY PR that names it. The PR pane shows only the part
// that is this PR's: the criteria it delivers, and the unmet criteria / missing items that belong in
// it — each with its Post button. The whole story lives once, in the Open PRs stack.
//
// Ownership of an unmet item, in order: the item's `ownerPrId`, else the criterion's
// `expectedIn.prId`, else `expectedIn.repoId` against this PR's repo. An item that names NO owner is
// this PR's too: its Post already lands on the PR being viewed (`postTargetOf`), and leaving it out
// would leave it postable nowhere (the stack view has no Post buttons).
import type {
  TicketAssessment,
  TicketCriterion,
  TicketPrCard,
  TicketNotRequestedItem,
  TicketReviewItem,
  TicketReviewMember,
} from '@pierre-review/shared';
import { stackIdFor } from './openPrsStacks.js';

export interface PrTicketShare {
  /** Criteria this PR delivers, or unmet ones that belong in it — in Claude's order. */
  criteria: TicketCriterion[];
  /** Missing items ('M1'…) that belong in this PR. */
  missing: TicketReviewItem[];
  /** Things this PR does that the ticket did not ask for. */
  notRequested: TicketNotRequestedItem[];
  /** Criteria met by other PRs (and not by this one). */
  metElsewhere: number;
  /** Unmet criteria and missing items that belong in another PR or repo. */
  todoElsewhere: number;
}

type Owner = 'this' | 'other' | 'none';

function ownerOf(
  ownerPrId: number | null | undefined,
  expectedIn: TicketCriterion['expectedIn'] | undefined,
  prId: number,
  repoId: number,
): Owner {
  const pid = ownerPrId ?? expectedIn?.prId ?? null;
  if (pid != null) return pid === prId ? 'this' : 'other';
  const rid = expectedIn?.repoId ?? null;
  if (rid != null) return rid === repoId ? 'this' : 'other';
  return 'none';
}

/** Split one run into this PR's share and a count of the rest. */
export function prTicketShare(
  assessment: Pick<TicketAssessment, 'criteria' | 'missing' | 'notRequested'>,
  items: readonly TicketReviewItem[],
  pr: { id: number; repoId: number },
): PrTicketShare {
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const missingByRef = new Map(assessment.missing.map((m) => [m.ref, m]));
  const criteria: TicketCriterion[] = [];
  let metElsewhere = 0;
  let todoElsewhere = 0;
  for (const c of assessment.criteria) {
    if (c.deliveredBy.includes(pr.id)) {
      criteria.push(c);
      continue;
    }
    if (c.status === 'met') {
      metElsewhere += 1;
      continue;
    }
    const owner = ownerOf(byRef.get(c.ref)?.ownerPrId, c.expectedIn, pr.id, pr.repoId);
    if (owner === 'other') todoElsewhere += 1;
    else criteria.push(c);
  }
  const missing: TicketReviewItem[] = [];
  for (const i of items) {
    if (i.status !== 'missing') continue;
    const owner = ownerOf(i.ownerPrId, missingByRef.get(i.ref)?.expectedIn, pr.id, pr.repoId);
    if (owner === 'other') todoElsewhere += 1;
    else missing.push(i);
  }
  const notRequested = assessment.notRequested.filter((g) => g.prId === pr.id);
  return { criteria, missing, notRequested, metElsewhere, todoElsewhere };
}

/**
 * THIS PR's contribution card ("What this PR adds"), at its current head — null when it has none or
 * is not a member of the run. Never a placeholder.
 */
export function prCardOf(members: readonly Pick<TicketReviewMember, 'prId' | 'card'>[], prId: number): TicketPrCard | null {
  return members.find((m) => m.prId === prId)?.card ?? null;
}

/** "3 more criteria are met by other PRs. 1 more is still to do in another PR." — null when none. */
export function shareRestLine(share: Pick<PrTicketShare, 'metElsewhere' | 'todoElsewhere'>): string | null {
  const parts: string[] = [];
  const m = share.metElsewhere;
  const t = share.todoElsewhere;
  if (m > 0) parts.push(m === 1 ? '1 more criterion is met by another PR.' : `${m} more criteria are met by other PRs.`);
  if (t > 0) parts.push(t === 1 ? '1 more is still to do in another PR.' : `${t} more are still to do in other PRs.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Does the PR pane show the SLIM block (this PR's share + a link to Open PRs)? Only where the Open
 * PRs stack exists to hold the whole story: a tracker ticket (never a pasted `manual:` story), the
 * tracker on (stacks need Pro `issueLinks`), a key to find the stack by, and an open PR on it.
 */
export function slimStoryCheck(o: {
  ident: string;
  ticketKey: string | null;
  issueLinks: boolean;
  prOpen: boolean;
  members: readonly Pick<TicketReviewMember, 'state'>[];
}): boolean {
  if (!o.issueLinks || o.ident.startsWith('manual:')) return false;
  if (o.ticketKey == null || o.ticketKey.trim() === '') return false;
  return o.prOpen || o.members.some((m) => m.state === 'open');
}

// ---- the jump to Open PRs ----

/** A request to scroll to a ticket's stack and open its Story check panel. */
export interface StoryTarget {
  stackId: string;
  /** When it was asked for (ms). An answer that never comes must not jump on a later visit. */
  at: number;
}

/** A target older than this is dropped unanswered (the stack is in another Workspace, say). */
export const STORY_TARGET_TTL_MS = 30_000;

/** The stack id a ticket key lands on — the same fold `stackOpenPrs` uses (`ticket:<KEY>`). */
export function storyTargetFor(ticketKey: string, now: number): StoryTarget {
  return { stackId: stackIdFor(ticketKey.trim().toUpperCase()), at: now };
}

export function storyTargetExpired(target: StoryTarget, now: number): boolean {
  return now - target.at > STORY_TARGET_TTL_MS;
}

/** The stack on the page the target names (case-insensitive), or null — not here yet, or expired. */
export function resolveStoryTarget(
  target: StoryTarget | null,
  stackIds: readonly string[],
  now: number,
): string | null {
  if (target == null || storyTargetExpired(target, now)) return null;
  const want = target.stackId.toUpperCase();
  return stackIds.find((id) => id.toUpperCase() === want) ?? null;
}
