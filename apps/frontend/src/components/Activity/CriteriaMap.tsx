// "HOW THE CODE MEETS EACH CRITERION" — the criteria map in the story view's Ticket section
// (docs/FRONTEND.md § The story view → The criteria map). Drawn from the ticket review ALREADY LOADED
// (no request of its own, no model call): shared `criteriaMap` joins the story check's criteria (and
// their status) with each member's contribution card at its CURRENT commit. Criteria on the left, the
// pull requests on the right, one line per (criterion, PR) a card says it moves forward; the card's
// "how" sits on the line's start, its files open on a click.
//
// Rules:
//  - UNKNOWN IS NEVER ZERO: a criterion no card claims says so in its box (dashed border); a PR with no
//    description at its current commit (never written, or pushed since) says so (dashed border) and
//    carries no line. A card line that names no criterion of this check stays on its PR.
//  - The cards are model-written and the status is the story check's: said ONCE, behind the ⓘ.
//  - Every model string renders as PLAIN TEXT (`PrRefText`, inside the section's ReviewPrRefsProvider).
//  - Two columns from CRITERIA_MAP_TWO_COLUMN_MIN_PX of its OWN width (a ResizeObserver, never the
//    window: the sprint tray is narrow on a wide screen); under it, one stacked list (each link names
//    its PR in words) with no lines. The lines are `aria-hidden`; the words carry everything.
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { CRITERIA_MAP_TWO_COLUMN_MIN_PX, entryY, linkPath, orderMapPrs } from '../../lib/criteriaMapLayout.js';
import { memberLabel } from '../../lib/ticketReview.js';
import { REVIEW_CHIP } from '../../lib/reviewStyles.js';
import { ChevronIcon, MergeIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { PrRefText } from '../ReviewPrRefs.js';
import { useStorySectionLook } from '../Ticket/StoryLayout.js';
import { useOpenMemberFile } from '../ClaudeReviewDiagrams.js';

const MUTED = 'text-ui-mute';

type Hot = { prId: number } | { key: string } | null;

const linkKey = (ref: string, prId: number): string => `${ref}:${prId}`;

function statusChip(status: string): { label: string; cls: string } {
  const s = status as ClaudeTicketCriterionStatus;
  return {
    label: TICKET_CRITERION_STATUS_LABEL[s] ?? TICKET_CRITERION_STATUS_LABEL.unclear,
    cls: TICKET_CRITERION_STATUS_CLASS[s] ?? TICKET_CRITERION_STATUS_CLASS.unclear,
  };
}

export function CriteriaMapSection({ review }: { review: TicketReview }): JSX.Element | null {
  const map = useMemo(() => criteriaMap(review.assessment?.criteria ?? [], review.members), [review]);
  const prs = useMemo(() => orderMapPrs(map), [map]);
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
            Each line joins a criterion to a pull request whose description says it moves that criterion forward: how,
            and in which files.
          </p>
          <p>
            AI writes each description from the pull request’s changes at its current commit, so check it before relying
            on it. The status is the story check’s.
          </p>
          <p>A criterion with no line has no pull request claiming it. A pull request pushed since its description has none until the next check.</p>
        </InfoButton>
      </div>
      {noCards ? (
        <p className={`text-meta ${MUTED}`}>No pull request has a description at its current commit yet.</p>
      ) : (
        <MapBody rows={map.rows} prs={prs} members={review.members} />
      )}
    </section>
  );
}

interface Line {
  key: string;
  prId: number;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [hot, setHot] = useState<Hot>(null);
  const byId = useMemo(() => new Map(members.map((m) => [m.prId, m])), [members]);
  const label = useCallback((prId: number) => {
    const m = byId.get(prId);
    return m != null ? memberLabel(m) : `#${prId}`;
  }, [byId]);

  // Measure: the layout from OUR width, then the lines from the boxes' places.
  const measure = useCallback(() => {
    const el = box.current;
    if (el == null) return;
    const w = el.getBoundingClientRect().width;
    const isWide = w >= CRITERIA_MAP_TWO_COLUMN_MIN_PX;
    setWide(isWide);
    if (!isWide) {
      setLines([]);
      return;
    }
    const origin = el.getBoundingClientRect();
    const prBoxes = new Map<number, DOMRect>();
    el.querySelectorAll<HTMLElement>('[data-map-pr]').forEach((n) => prBoxes.set(Number(n.dataset.mapPr), n.getBoundingClientRect()));
    const ports = [...el.querySelectorAll<HTMLElement>('[data-map-link]')];
    const perPr = new Map<number, HTMLElement[]>();
    for (const p of ports) {
      const id = Number(p.dataset.mapLinkPr);
      perPr.set(id, [...(perPr.get(id) ?? []), p]);
    }
    const out: Line[] = [];
    for (const [prId, list] of perPr) {
      const target = prBoxes.get(prId);
      if (target == null) continue;
      list.forEach((p, k) => {
        const r = p.getBoundingClientRect();
        const crit = p.closest<HTMLElement>('[data-map-criterion]')?.getBoundingClientRect() ?? r;
        const x1 = crit.right - origin.left;
        const y1 = r.top + Math.min(r.height, 20) / 2 - origin.top;
        const x2 = target.left - origin.left;
        const y2 = entryY(target.top - origin.top, target.height, k, list.length);
        out.push({ key: p.dataset.mapLink!, prId, d: linkPath(x1, y1, x2, y2), x1, y1, x2, y2 });
      });
    }
    setLines(out);
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = box.current;
    if (el == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, rows, prs]);

  const isHot = (key: string, prId: number): boolean =>
    hot != null && ('prId' in hot ? hot.prId === prId : hot.key === key);

  return (
    <div
      ref={box}
      className={wide ? 'relative grid grid-cols-[minmax(0,1fr)_3.5rem_minmax(9.5rem,15rem)] items-start' : 'relative space-y-4'}
      data-layout={wide ? 'columns' : 'stacked'}
    >
      <ol className="min-w-0 space-y-2" aria-label="Criteria">
        {rows.map((r) => (
          <CriterionBox
            key={r.ref}
            row={r}
            label={label}
            member={(id) => byId.get(id)}
            onHot={setHot}
            hotKey={(key, prId) => isHot(key, prId)}
          />
        ))}
      </ol>
      {wide && <div aria-hidden />}
      <div className="min-w-0 space-y-1.5">
        {!wide && <h5 className="text-meta font-semibold text-ui-ink">Pull requests</h5>}
        <ul className={wide ? 'space-y-6' : 'space-y-1.5'} aria-label="Pull requests">
          {prs.map((p) => (
            <PrBox key={p.prId} pr={p} label={label(p.prId)} hot={hot != null && 'prId' in hot && hot.prId === p.prId} onHot={setHot} />
          ))}
        </ul>
      </div>
      {wide && lines.length > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden data-testid="criteria-map-lines">
          {lines.map((l) => {
            const on = isHot(l.key, l.prId);
            const dim = hot != null && !on;
            return (
              <g key={l.key} className={on ? 'text-ui-accent' : 'text-ui-mute'} opacity={dim ? 0.35 : 1}>
                <path d={l.d} fill="none" stroke="currentColor" strokeWidth={on ? 2 : 1.25} />
                <circle cx={l.x1} cy={l.y1} r={2.5} fill="currentColor" />
                <circle cx={l.x2} cy={l.y2} r={2.5} fill="currentColor" />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function CriterionBox({
  row,
  label,
  member,
  onHot,
  hotKey,
}: {
  row: CriteriaMapRow;
  label: (prId: number) => string;
  member: (prId: number) => TicketReviewMember | undefined;
  onHot: (h: Hot) => void;
  hotKey: (key: string, prId: number) => boolean;
}): JSX.Element {
  const chip = statusChip(row.status);
  const unclaimed = row.links.length === 0;
  return (
    <li
      data-map-criterion={row.ref}
      className={`rounded-ui border bg-ui-surface px-2 py-1.5 text-body ${unclaimed ? 'border-dashed border-ui-line' : 'border-ui-line'}`}
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
        <ul className="mt-1 space-y-0.5" aria-label={`Pull requests for ${row.ref}`}>
          {row.links.map((l) => (
            <LinkRow
              key={l.prId}
              link={l}
              linkId={linkKey(row.ref, l.prId)}
              label={label(l.prId)}
              member={member(l.prId)}
              hot={hotKey(linkKey(row.ref, l.prId), l.prId)}
              onHot={onHot}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function LinkRow({
  link,
  linkId,
  label,
  member,
  hot,
  onHot,
}: {
  link: CriteriaMapLink;
  linkId: string;
  label: string;
  member: TicketReviewMember | undefined;
  hot: boolean;
  onHot: (h: Hot) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const filesId = useId();
  const openMember = useOpenMemberFile();
  const hasFiles = link.files.length > 0;
  const enter = () => onHot({ key: linkId });
  const leave = () => onHot(null);
  const words = (
    <>
      <span className={`shrink-0 font-mono text-meta leading-5 ${hot ? 'text-ui-accent' : 'text-ui-ink'}`}>{label}</span>
      <span className="min-w-0 flex-1 break-words text-meta leading-5 text-ui-ink">
        {link.how !== '' ? <PrRefText text={link.how} /> : <span className={MUTED}>No words on how.</span>}
      </span>
    </>
  );
  return (
    <li
      data-map-link={linkId}
      data-map-link-pr={link.prId}
      onMouseEnter={enter}
      onMouseLeave={leave}
      className="rounded-ui"
    >
      {hasFiles ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={filesId}
          onClick={() => setOpen((v) => !v)}
          onFocus={enter}
          onBlur={leave}
          className="hit flex w-full min-w-0 items-start gap-1.5 rounded-ui px-1 py-0.5 text-left hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:min-h-10"
        >
          <ChevronIcon dir={open ? 'down' : 'right'} size={12} className={`mt-1 shrink-0 ${MUTED}`} />
          {words}
          <span className={`shrink-0 text-meta leading-5 ${MUTED}`}>
            {link.files.length === 1 ? '1 file' : `${link.files.length} files`}
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 items-start gap-1.5 px-1 py-0.5 pl-[1.375rem]">{words}</div>
      )}
      {open && hasFiles && (
        <ul id={filesId} className="mb-1 ml-6 space-y-0.5" aria-label={`Files in ${label}`}>
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
    </li>
  );
}

function PrBox({ pr, label, hot, onHot }: { pr: CriteriaMapPr; label: string; hot: boolean; onHot: (h: Hot) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  // Every PR here is on the same ticket: a title that opens with a ticket key drops it.
  const title = pr.title != null ? pr.title.replace(/^\[?[A-Z][A-Z0-9]+-\d+\]?[\s:–—-]*/, '') || pr.title : null;
  return (
    <li
      data-map-pr={pr.prId}
      onMouseEnter={() => pr.hasCard && onHot({ prId: pr.prId })}
      onMouseLeave={() => onHot(null)}
      className={`rounded-ui border bg-ui-surface px-2 py-1.5 ${pr.hasCard ? (hot ? 'border-ui-accent' : 'border-ui-line') : 'border-dashed border-ui-line'}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {pr.state === 'merged' && (
          <span className={MUTED} title="Merged">
            <MergeIcon size={12} />
            <span className="sr-only">Merged</span>
          </span>
        )}
        <span className="shrink-0 font-mono text-meta text-ui-ink">{label}</span>
        {pr.hasCard && (
          <span className={`ml-auto shrink-0 text-meta ${MUTED}`}>{pr.linkCount === 1 ? '1 criterion' : `${pr.linkCount} criteria`}</span>
        )}
      </div>
      {title != null && (
        <p className="truncate text-meta text-ui-ink" title={pr.title ?? undefined}>
          {title}
        </p>
      )}
      {!pr.hasCard && <p className={`text-meta ${MUTED}`}>No description at its current commit.</p>}
      {pr.unmatched.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
            className={`hit mt-0.5 flex items-center gap-1 text-meta ${MUTED} hover:text-ui-ink touch:min-h-10`}
          >
            <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
            {`Not matched to a criterion (${pr.unmatched.length})`}
          </button>
          {open && (
            <ul id={listId} className="mt-0.5 list-disc space-y-1 pl-5 text-meta text-ui-ink">
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
