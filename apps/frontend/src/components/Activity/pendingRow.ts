import type { InsightCard, InsightPrRef, MyTurnDismissTarget } from '@pierre-review/shared';
import {
  authorName,
  pendingCardPrLabel,
  pendingHeading,
  repoShortName,
  type HeadingContext,
} from '../../lib/pendingHeadings.js';
import { cardKindLabel, myTurnReasonLabel } from './pendingLabels.js';
import type { StatusTone } from '../ui/StatusIcon.js';

// ONE PENDING ITEM AS ONE LINE (docs/redesign/DESIGN.md § Lists and rows). Pure, for the test.
//
// The row says WHAT it is (a few words), WHICH pull request (title + repo#N), how big, who opened
// it and how long it has waited. Everything else the card used to print lives in the side panel,
// which renders the full card (`PendingCard`, variant 'panel') — so nothing the card said is lost,
// only moved one click (or one Enter) away.
//
// THE COLOUR RULE: the row's lead mark is red when the item BLOCKS (a failing build, a merge
// conflict, a security alert), green when it can LAND, amber when the server ranked it urgent
// (`severity: 'high'`) and nothing else applies, grey otherwise. The words always say the same.

export type PendingRowTone = Extract<StatusTone, 'blocked' | 'ready' | 'neutral'> | 'urgent';

export interface PendingRowSummary {
  tone: PendingRowTone;
  /** "Review requested", "Merge conflicts", "Ready to merge" — a few words, never a sentence. */
  reason: string;
  /** The PR's title, or (a repository or a person) the card's own heading. */
  title: string;
  /** "api#12" (owner dropped when the board shares it), or the repo for a branch card. */
  ref: string | null;
  /** "+40 −8", or null when the card is not about one PR. */
  size: string | null;
  /** Who opened the PR (a person's name or the tool's brand), or null. */
  author: string | null;
  /** The instant the age measures: the heading's own clock, else when the PR was opened. */
  at: string | null;
  /** `at` is the PR's opening (the heading has no clock of its own) — the tooltip says so. */
  atIsOpened: boolean;
}

/** Does this card block a merge or a build? */
export function pendingRowBlocks(card: InsightCard): boolean {
  switch (card.kind) {
    case 'conflicts':
    case 'ci_failing':
      return true;
    case 'security':
      // A fix PR is the CURE; an alert on a PR is the block.
      return card.fix == null || card.depState === 'ci_red' || card.depState === 'conflicts';
    case 'dependency_bump':
      return card.depState === 'ci_red' || card.depState === 'conflicts';
    case 'my_turn':
      return card.reason === 'own_ci_red' || card.reason === 'own_conflicts' || card.reason === 'trunk_red';
    default:
      return false;
  }
}

/** Can this card's PR land now, on its own synced word? (The merge row still decides the button.) */
export function pendingRowReady(card: InsightCard): boolean {
  switch (card.kind) {
    case 'merge':
      return true;
    case 'dependency_bump':
      return card.depState === 'ready';
    case 'security':
      return card.dependencyUpdate === true && card.depState === 'ready';
    case 'my_turn':
      return (
        card.reason === 'pr_approved' ||
        (card.reason === 'own_ready' && card.own?.kind === 'ready' && card.own.forward === 'merge')
      );
    default:
      return false;
  }
}

export function pendingRowTone(card: InsightCard): PendingRowTone {
  if (pendingRowBlocks(card)) return 'blocked';
  if (pendingRowReady(card)) return 'ready';
  return card.severity === 'high' ? 'urgent' : 'neutral';
}

/** The tone's ink. Red and green by meaning; amber only for "urgent"; grey otherwise. */
export const PENDING_ROW_TONE_CLASS: Record<PendingRowTone, string> = {
  blocked: 'text-ui-danger',
  ready: 'text-ui-success',
  urgent: 'text-ui-warn',
  neutral: 'text-ui-faint',
};

/** What the tone means, in words (the lead mark's accessible name and tooltip). */
export const PENDING_ROW_TONE_WORD: Record<PendingRowTone, string> = {
  blocked: 'Blocks',
  ready: 'Can land',
  urgent: 'Urgent',
  neutral: '',
};

function isPrCard(card: InsightCard): card is InsightCard & InsightPrRef {
  return 'inMergeQueue' in card && 'prTitle' in card && 'additions' in card;
}

export function pendingRowSummary(card: InsightCard, ctx: HeadingContext): PendingRowSummary {
  const heading = pendingHeading(card, ctx);
  const reason = card.kind === 'my_turn' ? myTurnReasonLabel(card) : cardKindLabel(card);
  const pr = pendingCardPrLabel(card, ctx.sharedOwner);
  const prCard = isPrCard(card) ? card : null;
  const branchRef =
    pr == null && 'repoFullName' in card && typeof card.repoFullName === 'string'
      ? repoShortName(card.repoFullName, ctx.sharedOwner)
      : null;
  return {
    tone: pendingRowTone(card),
    reason,
    title: pr?.title ?? heading.lead,
    ref: pr?.ref ?? branchRef,
    size: prCard != null ? `+${prCard.additions} −${prCard.deletions}` : null,
    author: prCard != null ? authorName(prCard, ctx.nameOf) : null,
    at: heading.at ?? prCard?.openedAt ?? null,
    atIsOpened: heading.at == null && prCard?.openedAt != null,
  };
}

/** When every row in the list shares one reason, the column says nothing the tab doesn't. */
export function reasonColumnShown(reasons: readonly string[]): boolean {
  return new Set(reasons).size > 1;
}

// ── row actions (the keys) ────────────────────────────────────────────────────────────────────

/** What `e` takes off My turn — the server's per-subject dismissal. Null off My turn. */
export function dismissTargetOf(card: InsightCard): { target: MyTurnDismissTarget; label: string } | null {
  if (card.kind !== 'my_turn') return null;
  if (card.reason === 'trunk_red') return { target: { kind: 'repo', id: card.repoId }, label: card.repoFullName };
  return { target: { kind: 'pr', id: card.prId }, label: `${card.repoFullName} #${card.prNumber}` };
}

/**
 * MAY `a` APPROVE FROM THE LIST? Only on a review asked OF THE READER (My turn's review request, new
 * commits since their review, a new PR in a repo they watch) — the ball rule takes that card off the
 * board once they review, so the row leaving is the truth. Never on the reader's own PR (GitHub
 * refuses), never on a card about a repository or a person. Everywhere else approving is a PR-page
 * decision.
 */
export function approveOffered(card: InsightCard, viewerId: number | null | undefined): boolean {
  if (card.kind !== 'my_turn') return false;
  if (card.reason !== 'review_request' && card.reason !== 'pushed_since' && card.reason !== 'watched_repo_pr') {
    return false;
  }
  if (viewerId != null && card.authorId === viewerId) return false;
  return true;
}

/** The PR's GitHub page for `o` (a branch card's commit page). Never rendered raw — callers pass it
 *  through `safeExternalUrl`. */
export function githubUrlOf(card: InsightCard): string | null {
  return 'githubUrl' in card && typeof card.githubUrl === 'string' ? card.githubUrl : null;
}
