// "HOW THE CODE MEETS EACH CRITERION" — the criteria map in the story view's Ticket section
// (docs/FRONTEND.md § The story view → The criteria map). Drawn from the ticket review ALREADY LOADED
// (no request of its own, no model call): shared `criteriaMap` joins the story check's criteria (and
// their status) with each member's contribution card at its CURRENT commit. ONE list: each criterion
// with the pull requests a card says move it forward, each PR marked merged or open, the card's "how" on
// ONE line (truncated at every width); a click opens the full "how" and the files. No lines, no graph.
//
// Rules:
//  - UNKNOWN IS NEVER ZERO: a criterion no card claims says so in its box (dashed border); a PR with no
//    description at its current commit (never written, or pushed since) is named under the list, and so
//    are card lines that name no criterion of this check.
//  - The cards are model-written and the status is the story check's: said ONCE, behind the ⓘ.
//  - Every model string renders as PLAIN TEXT (`PrRefText`, inside the section's ReviewPrRefsProvider).
import { useId, useMemo, useState } from 'react';
import {
  TICKET_CRITERION_STATUS_LABEL,
  criteriaMap,
  criteriaMapOffered,
  criterionTextOnly,
  type ClaudeTicketCriterionStatus,
  type CriteriaMapLink,
  type CriteriaMapPr,
  type CriteriaMapRow,
  type TicketReview,
  type TicketReviewMember,
} from '@pierre-review/shared';
import { TICKET_CRITERION_STATUS_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { memberLabel } from '../../lib/ticketReview.js';
import { REVIEW_CHIP } from '../../lib/reviewStyles.js';
import { ChevronIcon, MergeIcon, PullRequestIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { PrRefText } from '../ReviewPrRefs.js';
import { useStorySectionLook } from '../Ticket/StoryLayout.js';
import { useOpenMemberFile } from '../ClaudeReviewDiagrams.js';

const MUTED = 'text-ui-mute';

function statusChip(status: string): { label: string; cls: string } {
  const s = status as ClaudeTicketCriterionStatus;
  return {
    label: TICKET_CRITERION_STATUS_LABEL[s] ?? TICKET_CRITERION_STATUS_LABEL.unclear,
    cls: TICKET_CRITERION_STATUS_CLASS[s] ?? TICKET_CRITERION_STATUS_CLASS.unclear,
  };
}

export function CriteriaMapSection({ review }: { review: TicketReview }): JSX.Element | null {
  const map = useMemo(() => criteriaMap(review.assessment?.criteria ?? [], review.members), [review]);
  const look = useStorySectionLook();
  const headingId = useId();
  if (!criteriaMapOffered(map)) return null;
  const noCards = map.withoutCard === map.prs.length;
  return (
    <section
      aria-labelledby={headingId}
      className={`scroll-mt-4 space-y-2 focus:outline-none ${look?.section ?? ''}`}
      data-testid="criteria-map"
      data-story-section="criteria-map"
    >
      <div className="flex items-center gap-1.5">
        <h4 id={headingId} className={look?.heading ?? 'text-meta font-semibold text-ui-ink'}>
          How the code meets each criterion
        </h4>
        <InfoButton title="How the code meets each criterion">
          <p>
            Under each criterion: the pull requests whose description says they move it forward, merged or open. Select
            one to read how in full and see its files.
          </p>
          <p>
            AI writes each description from the pull request’s changes at its current commit, so check it before relying
            on it. The status is the story check’s.
          </p>
          <p>A pull request pushed since its description has none until the next check.</p>
        </InfoButton>
      </div>
      {noCards ? (
        <p className={`text-meta ${MUTED}`}>No pull request has a description at its current commit yet.</p>
      ) : (
        <MapBody rows={map.rows} prs={map.prs} members={review.members} />
      )}
    </section>
  );
}

function MapBody({
  rows,
  prs,
  members,
}: {
  rows: CriteriaMapRow[];
  prs: CriteriaMapPr[];
  members: readonly TicketReviewMember[];
}): JSX.Element {
  const byId = useMemo(() => new Map(members.map((m) => [m.prId, m])), [members]);
  const stateOf = useMemo(() => new Map(prs.map((p) => [p.prId, p.state])), [prs]);
  const label = (prId: number): string => {
    const m = byId.get(prId);
    return m != null ? memberLabel(m) : `#${prId}`;
  };
  // Named under the list: a PR with no current description, and card lines that match no criterion.
  const others = prs.filter((p) => !p.hasCard || p.unmatched.length > 0);
  return (
    <div className="space-y-3">
      <ol className="min-w-0 space-y-2" aria-label="Criteria">
        {rows.map((r) => (
          <CriterionBox
            key={r.ref}
            row={r}
            label={label}
            merged={(id) => (stateOf.get(id) ?? byId.get(id)?.state) === 'merged'}
            member={(id) => byId.get(id)}
          />
        ))}
      </ol>
      {others.length > 0 && (
        <ul className="min-w-0 space-y-1" aria-label="Other pull requests">
          {others.map((p) => (
            <OtherPr key={p.prId} pr={p} label={label(p.prId)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CriterionBox({
  row,
  label,
  merged,
  member,
}: {
  row: CriteriaMapRow;
  label: (prId: number) => string;
  merged: (prId: number) => boolean;
  member: (prId: number) => TicketReviewMember | undefined;
}): JSX.Element {
  const chip = statusChip(row.status);
  const unclaimed = row.links.length === 0;
  return (
    <li
      data-map-criterion={row.ref}
      className={`min-w-0 rounded-ui border bg-ui-surface px-2 py-1.5 text-body ${unclaimed ? 'border-dashed border-ui-line' : 'border-ui-line'}`}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <span className={`${REVIEW_CHIP} ${chip.cls}`}>{chip.label}</span>
        <span className="flex min-w-0 flex-1 basis-48 items-start gap-1.5">
          <span className={`shrink-0 font-mono text-meta leading-5 ${MUTED}`}>{row.ref}</span>
          <span className="min-w-0 break-words leading-5 text-ui-ink">{criterionTextOnly(row.text, row.ref)}</span>
        </span>
      </div>
      {unclaimed ? (
        <p className={`mt-1 text-meta ${MUTED}`} data-testid="criteria-map-unclaimed">
          No pull request claims this.
        </p>
      ) : (
        <ul className="mt-1 min-w-0 space-y-0.5" aria-label={`Pull requests for ${row.ref}`}>
          {row.links.map((l) => (
            <LinkRow key={l.prId} link={l} label={label(l.prId)} merged={merged(l.prId)} member={member(l.prId)} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Merged or open, as an icon with its word (the word drops on a phone; the icon keeps its name). */
function PrStateMark({ merged }: { merged: boolean }): JSX.Element {
  const word = merged ? 'Merged' : 'Open';
  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-meta leading-5 ${merged ? 'text-ui-ink' : MUTED}`}
      title={word}
      data-pr-state={merged ? 'merged' : 'open'}
    >
      {merged ? <MergeIcon size={12} /> : <PullRequestIcon size={12} />}
      <span className="sr-only sm:not-sr-only">{word}</span>
    </span>
  );
}

function LinkRow({
  link,
  label,
  merged,
  member,
}: {
  link: CriteriaMapLink;
  label: string;
  merged: boolean;
  member: TicketReviewMember | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const openMember = useOpenMemberFile();
  const nFiles = link.files.length;
  const canOpen = link.how !== '' || nFiles > 0;
  const line = (
    <>
      <PrStateMark merged={merged} />
      <span className="shrink-0 font-mono text-meta leading-5 text-ui-ink">{label}</span>
      {/* ONE line at every width: the flex row never wraps; the words truncate. */}
      <span className="min-w-0 flex-1 truncate text-meta leading-5 text-ui-ink" data-testid="criteria-map-how">
        {/* Open: the full how sits below, so the row drops its one-line copy. */}
        {link.how === '' ? <span className={MUTED}>No words on how.</span> : open ? null : <PrRefText text={link.how} />}
      </span>
      {nFiles > 0 && <span className={`shrink-0 text-meta leading-5 ${MUTED}`}>{nFiles === 1 ? '1 file' : `${nFiles} files`}</span>}
    </>
  );
  return (
    <li data-map-link={link.prId} className="min-w-0 rounded-ui">
      {canOpen ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((v) => !v)}
          className="hit flex w-full min-w-0 items-center gap-1.5 rounded-ui px-1 py-0.5 text-left hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:min-h-10"
        >
          <ChevronIcon dir={open ? 'down' : 'right'} size={12} className={`shrink-0 ${MUTED}`} />
          {line}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 pl-[1.375rem]">{line}</div>
      )}
      {open && canOpen && (
        <div id={detailId} className="mb-1 ml-6 space-y-1" data-testid="criteria-map-detail">
          {link.how !== '' && (
            <p className="break-words text-meta leading-5 text-ui-ink">
              <PrRefText text={link.how} />
            </p>
          )}
          {nFiles > 0 && (
            <ul className="space-y-0.5" aria-label={`Files in ${label}`}>
              {link.files.map((f) => (
                <li key={f} className="min-w-0">
                  {member != null ? (
                    <button
                      type="button"
                      className="hit max-w-full text-left font-mono text-meta text-ui-ink underline decoration-dotted underline-offset-2 [overflow-wrap:anywhere] hover:text-ui-accent"
                      title={`Open ${f} in ${label}'s Changes tab`}
                      onClick={() =>
                        openMember(
                          { prId: member.prId, repo: member.repo, number: member.number, title: member.title ?? '', state: member.state, headSha: member.headSha },
                          f,
                          true,
                        )
                      }
                    >
                      {f}
                    </button>
                  ) : (
                    <span className="font-mono text-meta text-ui-ink [overflow-wrap:anywhere]">{f}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** A PR the list can't place: no description at its current commit, or lines naming no criterion. */
function OtherPr({ pr, label }: { pr: CriteriaMapPr; label: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <li data-map-pr={pr.prId} className="min-w-0 px-1 text-meta">
      <div className="flex min-w-0 items-center gap-1.5">
        <PrStateMark merged={pr.state === 'merged'} />
        <span className="shrink-0 font-mono leading-5 text-ui-ink">{label}</span>
        {!pr.hasCard && <span className={`min-w-0 truncate leading-5 ${MUTED}`}>No description at its current commit.</span>}
      </div>
      {pr.unmatched.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
            className={`hit mt-0.5 flex items-center gap-1 ${MUTED} hover:text-ui-ink touch:min-h-10`}
          >
            <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
            {`Not matched to a criterion (${pr.unmatched.length})`}
          </button>
          {open && (
            <ul id={listId} className="mt-0.5 list-disc space-y-1 pl-5 text-ui-ink">
              {pr.unmatched.map((u, i) => (
                <li key={i} className="break-words">
                  <PrRefText text={u.how !== '' ? `${u.criterion}: ${u.how}` : u.criterion} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}
