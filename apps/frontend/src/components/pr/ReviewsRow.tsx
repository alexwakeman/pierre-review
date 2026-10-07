import type {
  AutomatedReviewerKind,
  PrDetail as PrDetailT,
  ReviewProvenance,
  User,
} from '@pierre-review/shared';
import { automatedReviewerMeta, dateTime, REVIEW_STATE_META, vendorInk } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { BotIcon } from '../Icons.js';

/**
 * THE REVIEWS ROW — everyone who reviewed the PR and where they stand, plus the "only bots
 * reviewed" coverage chip. Shared by the Overview tab (ChecksTab) and the top of the Claude Review
 * tab, so the two say the same thing about the same PR. Each caller supplies its own row chrome
 * (label column, card); this renders the chips only.
 */

// WS2 provenance badge — a small bot tag next to a reviewer whose review is classified automated
// (compute-on-read via ReviewDetail.automatedKind on the PR-detail payload). For the Pierre kind we
// additionally surface how the posted review was authored: "· verbatim" (ai_verbatim, Claude's
// summary posted as-is) vs "· curated" (a human materially edited it). The kind is in hand, so we
// look it up via automatedReviewerMeta (which covers vendors + in_house + pierre — botVendorMeta
// only maps a login→ReviewBotKind).
function AutomatedReviewerBadge({
  kind,
  provenance,
}: {
  kind: AutomatedReviewerKind;
  provenance: ReviewProvenance | null;
}): JSX.Element {
  const meta = automatedReviewerMeta(kind);
  const prov =
    kind === 'pierre' && provenance
      ? provenance === 'ai_verbatim'
        ? ' · verbatim'
        : ' · curated'
      : '';
  return (
    <span
      data-testid="reviewer-provenance"
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
      style={{ ...vendorInk(meta.color), background: `${meta.color}1a` }}
      title={`Automated reviewer — ${meta.label}${prov}`}
    >
      <BotIcon size={10} />
      {meta.label}
      {prov}
    </span>
  );
}

export interface ReviewFacts {
  /** Reviewers whose GitHub account is gone: counted by the server, unnameable here. */
  unnamedReviewers: number;
  automatedByAuthor: Map<number, { kind: AutomatedReviewerKind; provenance: ReviewProvenance | null }>;
  onlyBotsReviewed: boolean;
}

/**
 * The per-author fold behind the row.
 *
 * ⚠ THE SERVER DECIDES THE STANDING. `pr.reviewStandings` is `computeReviewStandingsByPr`, the
 * same fold the Pending card's reviewer chips and the approval COUNT come from (a reviewer's
 * latest VERDICT if they ever filed one, else their latest dismissal, else their latest comment).
 * A client fold reading `pr.reviews` straight through demoted an approver who later left a bare
 * comment to `commented` — 59 disagreeing pairs on real data. There is no client rule left here.
 *
 * WS2 automated-reviewer provenance, folded per author. A ReviewDetail carries an `automatedKind`
 * when its author is classified automated, and 'pierre' (with `provenance`) on a review POSTED via
 * Pierre — that review is authored by a human token, so the SAME author can have both a plain human
 * review and a Pierre-stamped one. Track per author their automated marker (latest wins) AND
 * whether they ALSO filed a genuine human review. "Only bots reviewed" then means every reviewer is
 * automated-only.
 */
export function reviewFacts(pr: PrDetailT): ReviewFacts {
  const reviewerIds = pr.reviewStandings.map((r) => r.userId);
  const automatedByAuthor: ReviewFacts['automatedByAuthor'] = new Map();
  const humanReviewAuthors = new Set<number>();
  for (const r of pr.reviews) {
    if (r.authorId == null || r.state === 'pending') continue;
    if (r.automatedKind != null) {
      automatedByAuthor.set(r.authorId, { kind: r.automatedKind, provenance: r.provenance ?? null });
    } else {
      humanReviewAuthors.add(r.authorId);
    }
  }
  return {
    unnamedReviewers: pr.reviewerCount - pr.reviewStandings.length,
    automatedByAuthor,
    onlyBotsReviewed:
      reviewerIds.length > 0 &&
      reviewerIds.every((uid) => automatedByAuthor.has(uid) && !humanReviewAuthors.has(uid)),
  };
}

/** Whether the row has anything to show. */
export function reviewsRowVisible(pr: PrDetailT): boolean {
  return pr.reviewStandings.length > 0 || pr.reviewerCount - pr.reviewStandings.length > 0;
}

/**
 * The chips. UNCAPPED — the pane has the room the card does not, so there is no "+N" here and the
 * only gap between the chips and `reviewerCount` is the reviewers GitHub can no longer name.
 */
export function ReviewsChips({
  pr,
  usersById,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
}): JSX.Element {
  const { unnamedReviewers, automatedByAuthor, onlyBotsReviewed } = reviewFacts(pr);
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {pr.reviewStandings.map((r) => {
        const u = usersById.get(r.userId);
        // ⚠ ONE table, shared with the Pending board's chips (lib/ui.ts). `icon` is a COMPONENT
        // reference, not an element.
        const meta = REVIEW_STATE_META[r.standing];
        const auto = automatedByAuthor.get(r.userId);
        return (
          <span
            key={r.userId}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${meta.cls}`}
            title={`${meta.title} · ${dateTime(r.standingAt)}`}
          >
            {meta.icon && <meta.icon size={12} />}
            <Avatar user={u} size={14} />
            <UserName user={u} fallbackId={r.userId} repoId={pr.repoId} />
            {auto && <AutomatedReviewerBadge kind={auto.kind} provenance={auto.provenance} />}
          </span>
        );
      })}
      {/* Counted by the server, unnameable here: GitHub gave the review no account. Stating it is
          cheaper than a row that quietly says fewer people looked than did. */}
      {unnamedReviewers > 0 && (
        <span
          className="inline-flex items-center rounded bg-gray-500/10 px-1.5 py-0.5 text-gray-500 dark:text-gray-400"
          title="GitHub no longer has an account for these reviews, so they cannot be named here."
        >
          {unnamedReviewers === 1
            ? '1 review from a deleted account'
            : `${unnamedReviewers} reviews from deleted accounts`}
        </span>
      )}
      {onlyBotsReviewed && (
        <span
          data-testid="only-bots-reviewed"
          className="inline-flex items-center gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300"
          title="Every review on this PR came from an automated reviewer — no human has reviewed it yet."
        >
          <BotIcon size={12} />
          only bots reviewed
        </span>
      )}
    </div>
  );
}
