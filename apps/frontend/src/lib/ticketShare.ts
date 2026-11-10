// ONE PR'S SHARE OF A TICKET REVIEW — the pure half of the PR pane's slim Story check
// (TicketCoverage.tsx), whose "See the whole ticket" opens the ticket's STORY VIEW tab
// (Activity/TicketStorySection.tsx holds the whole story there).
//
// A ticket review judges the ticket across EVERY PR that names it. The PR pane shows only the part
// that is this PR's: the criteria it delivers, and the unmet criteria / missing items that belong in
// it — under ONE "Post N gaps to this PR" button. The whole story lives once, in the story view: the
// counts of the rest and every PR's contribution card ("What this PR adds") are shown there only.
//
// Ownership of an unmet item, in order: the item's `ownerPrId`, else the criterion's
// `expectedIn.prId`, else `expectedIn.repoId` against this PR's repo. An item that names NO owner is
// this PR's too: its post already lands on the PR being viewed (`postTargetOf`), and leaving it out
// would leave it postable nowhere (the stack view has no Post buttons).
import { criterionDone } from '@pierre-review/shared';
import type {
  ReviewDocReference,
  TicketAssessment,
  TicketCriterion,
  TicketNotRequestedItem,
  TicketReviewItem,
  TicketReviewMember,
} from '@pierre-review/shared';

export interface PrTicketShare {
  /** Criteria this PR delivers, or unmet ones that belong in it — in Claude's order. */
  criteria: TicketCriterion[];
  /** Missing items ('M1'…) that belong in this PR. */
  missing: TicketReviewItem[];
  /** Things this PR does that the ticket did not ask for. */
  notRequested: TicketNotRequestedItem[];
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

/** This PR's share of one run (the rest is the story view's). */
export function prTicketShare(
  assessment: Pick<TicketAssessment, 'criteria' | 'missing' | 'notRequested'>,
  items: readonly TicketReviewItem[],
  pr: { id: number; repoId: number },
): PrTicketShare {
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const missingByRef = new Map(assessment.missing.map((m) => [m.ref, m]));
  const criteria: TicketCriterion[] = [];
  for (const c of assessment.criteria) {
    if (c.deliveredBy.includes(pr.id)) {
      criteria.push(c);
      continue;
    }
    // Done elsewhere (another PR, or outside code changes): the story view's, not this PR's.
    if (criterionDone(c.status)) continue;
    const owner = ownerOf(byRef.get(c.ref)?.ownerPrId, c.expectedIn, pr.id, pr.repoId);
    if (owner !== 'other') criteria.push(c);
  }
  const missing: TicketReviewItem[] = [];
  for (const i of items) {
    if (i.status !== 'missing') continue;
    const owner = ownerOf(i.ownerPrId, missingByRef.get(i.ref)?.expectedIn, pr.id, pr.repoId);
    if (owner !== 'other') missing.push(i);
  }
  const notRequested = assessment.notRequested.filter((g) => g.prId === pr.id);
  return { criteria, missing, notRequested };
}

/**
 * The library references that belong in THIS PR's share: those whose `about` names one of the share's
 * criteria or missing items ('AC2', 'M1', as a whole word, any case). A reference about another PR's
 * criterion, or about nothing in particular, is the whole story's — listed once, in Open PRs.
 */
export function shareDocReferences(
  references: readonly ReviewDocReference[] | null | undefined,
  share: Pick<PrTicketShare, 'criteria' | 'missing'>,
): ReviewDocReference[] {
  if (references == null || references.length === 0) return [];
  const refs = new Set([...share.criteria.map((c) => c.ref), ...share.missing.map((m) => m.ref)].map((r) => r.toLowerCase()));
  if (refs.size === 0) return [];
  return references.filter((r) =>
    (r.about ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((w) => w !== '' && refs.has(w)),
  );
}

/**
 * Does the PR pane show the SLIM block (this PR's share + a link to the story view)? Only where the
 * story view holds the whole story: a tracker ticket, the tracker on
 * for the PR's workspace (`PrDetail.tickets != null`), a key to name the tab by, and an open PR on it.
 */
export function slimStoryCheck(o: {
  ticketKey: string | null;
  trackerOn: boolean;
  prOpen: boolean;
  members: readonly Pick<TicketReviewMember, 'state'>[];
}): boolean {
  if (!o.trackerOn) return false;
  if (o.ticketKey == null || o.ticketKey.trim() === '') return false;
  return o.prOpen || o.members.some((m) => m.state === 'open');
}
