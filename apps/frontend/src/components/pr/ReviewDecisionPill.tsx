import type {
  PrDetail as PrDetailT,
  PrReviewDecision,
  PrReviewerRef,
  User,
} from '@pierre-review/shared';
import { dateTime, REVIEW_STATE_META, relativeTime, userLabel } from '../../lib/ui.js';
import type { IconComponent } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { ClickPopover } from '../InfoModal.js';
import { cx, FOCUS_RING } from '../ui/index.js';
import { AutomatedReviewerBadge, reviewFacts } from './ReviewsRow.js';

// THE PR HEADER'S REVIEW PILL — the first entry of the header's third line.
//
// ⚠ TWO CLAIMS, DRAWN APART. The first pill is GITHUB's `reviewDecision` (does review still block
// the merge?). The reviewer chip after it is OUR fold, `reviewStandings` (the server's
// `computeReviewStandingsByPr`, the same one the Pending card and the Overview's Reviews row read),
// in that reviewer's own standing style. They disagree on real data (a dismissed approval), so they
// are never merged into one sentence. The face is never AI review's verdict.
//
// ⚠ `reviewDecision: null` means "this repo requires no review" (or not synced yet) — it never
// reads as "nobody looked". Who looked is the chips.
//
// Nothing fetches: every field is on the PR detail payload.

type DecisionKey = PrReviewDecision | 'none';

interface DecisionFaceMeta {
  label: string;
  icon: IconComponent | null;
  cls: string;
}

/** GitHub's decision, in the review table's own style. `review_required` and "none" have no
 *  standing of their own, so they take the quiet `pending` look. */
const DECISION_FACE: Record<DecisionKey, DecisionFaceMeta> = {
  approved: { label: 'Approved', icon: REVIEW_STATE_META.approved.icon, cls: REVIEW_STATE_META.approved.cls },
  changes_requested: {
    label: 'Changes requested',
    icon: REVIEW_STATE_META.changes_requested.icon,
    cls: REVIEW_STATE_META.changes_requested.cls,
  },
  review_required: { label: 'Review required', icon: null, cls: REVIEW_STATE_META.pending.cls },
  none: { label: 'No review required', icon: null, cls: REVIEW_STATE_META.pending.cls },
};

export interface ReviewDecisionFace {
  /** GitHub's decision; null = no review required (or not synced). */
  decision: PrReviewDecision | null;
  label: string;
  /** The one reviewer shown on the pill: the newest whose standing matches the decision, else the
   *  newest. Null when nobody has reviewed. */
  lead: PrReviewerRef | null;
  /** Reviewers not shown on the pill (named or not). */
  more: number;
}

type FaceFields = Pick<PrDetailT, 'reviewDecision' | 'reviewStandings' | 'reviewerCount' | 'requestedReviewers'>;

/** What the pill shows, or null when there is nothing to say: no decision, no reviewer, nobody
 *  asked. Pure — pinned in test/prReviewDecisionPill.test.ts. */
export function reviewDecisionFace(pr: FaceFields): ReviewDecisionFace | null {
  const decision = pr.reviewDecision ?? null;
  const standings = pr.reviewStandings;
  const unnamed = Math.max(0, pr.reviewerCount - standings.length);
  if (decision == null && standings.length === 0 && unnamed === 0 && pr.requestedReviewers.length === 0) {
    return null;
  }
  // `reviewStandings` is newest first.
  const lead =
    (decision === 'approved' || decision === 'changes_requested'
      ? standings.find((r) => r.standing === decision)
      : undefined) ??
    standings[0] ??
    null;
  return {
    decision,
    label: DECISION_FACE[decision ?? 'none'].label,
    lead,
    more: standings.length - (lead != null ? 1 : 0) + unnamed,
  };
}

const PILL = 'inline-flex items-center gap-1 rounded-ui px-1.5 py-0.5';

export function ReviewDecisionPill({
  pr,
  usersById,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
}): JSX.Element | null {
  const face = reviewDecisionFace(pr);
  if (face == null) return null;
  const decisionMeta = DECISION_FACE[face.decision ?? 'none'];
  const lead = face.lead;
  const leadUser = lead != null ? usersById.get(lead.userId) : undefined;
  const leadMeta = lead != null ? REVIEW_STATE_META[lead.standing] : null;
  const { automatedByAuthor, unnamedReviewers } = reviewFacts(pr);
  const triggerLabel = [
    `GitHub: ${face.label}`,
    lead != null && leadMeta != null ? `${userLabel(leadUser, lead.userId)} ${leadMeta.label.toLowerCase()}` : null,
    face.more > 0 ? `${face.more} more` : null,
    'show all reviews',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <ClickPopover
      title="Reviews"
      triggerLabel={triggerLabel}
      isolate
      testId="pr-header-review"
      triggerClassName={(open) =>
        cx(
          'inline-flex shrink-0 items-center gap-1 rounded-ui text-meta touch:min-h-10',
          open ? 'opacity-90' : 'hover:opacity-80',
          FOCUS_RING,
        )
      }
      trigger={
        <>
          <span className={cx(PILL, 'font-medium', decisionMeta.cls)} title={`GitHub's review decision: ${face.label}`}>
            {decisionMeta.icon && <decisionMeta.icon size={12} />}
            {face.label}
          </span>
          {lead != null && leadMeta != null && (
            // The name is plain text here: the whole pill is one button, and a UserName inside it
            // would nest a second control. The popover carries the linked names.
            <span className={cx(PILL, leadMeta.cls)} title={`${leadMeta.title} · ${dateTime(lead.standingAt)}`}>
              {leadMeta.icon && <leadMeta.icon size={12} />}
              <Avatar user={leadUser} size={14} />
              <span className="max-w-[10rem] truncate">{userLabel(leadUser, lead.userId)}</span>
            </span>
          )}
          {face.more > 0 && <span className="tabular-nums text-ui-mute">+{face.more}</span>}
        </>
      }
    >
      <p className="m-0">
        GitHub: <span className="font-medium text-ui-ink">{face.label}</span>
      </p>
      {pr.reviewStandings.length > 0 && (
        <ul className="m-0 list-none space-y-1.5 p-0" data-testid="pr-header-review-list">
          {pr.reviewStandings.map((r) => {
            const u = usersById.get(r.userId);
            const meta = REVIEW_STATE_META[r.standing];
            const auto = automatedByAuthor.get(r.userId);
            return (
              <li key={r.userId} className="flex flex-wrap items-center gap-1.5">
                <span className={cx(PILL, meta.cls)} title={meta.title}>
                  {meta.icon && <meta.icon size={12} />}
                  <Avatar user={u} size={14} />
                  <UserName user={u} fallbackId={r.userId} repoId={pr.repoId} />
                </span>
                {auto && <AutomatedReviewerBadge kind={auto.kind} provenance={auto.provenance} />}
                <span className="text-ui-mute" title={dateTime(r.standingAt)}>
                  {relativeTime(r.standingAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {unnamedReviewers > 0 && (
        <p className="m-0">
          {unnamedReviewers === 1 ? '1 review from a deleted account' : `${unnamedReviewers} reviews from deleted accounts`}
        </p>
      )}
      {pr.requestedReviewers.length > 0 && (
        <div>
          <p className="m-0 mb-1">Waiting on</p>
          <div className="flex flex-wrap gap-1.5">
            {pr.requestedReviewers.map((r, i) => (
              <span key={i} className={cx(PILL, REVIEW_STATE_META.pending.cls)} title={REVIEW_STATE_META.pending.title}>
                {r.teamName ? (
                  `@${r.teamName}`
                ) : (
                  <>
                    <Avatar user={r.userId != null ? usersById.get(r.userId) : undefined} size={14} />
                    <UserName
                      user={r.userId != null ? usersById.get(r.userId) : undefined}
                      fallbackId={r.userId}
                      repoId={pr.repoId}
                    />
                  </>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </ClickPopover>
  );
}
