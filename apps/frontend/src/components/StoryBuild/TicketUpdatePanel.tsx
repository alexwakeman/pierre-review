import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  TICKET_UPDATE_FIELD_MAX,
  acSectionText,
  compareTicketLayout,
  findAcSection,
  ticketLayoutOf,
  type BuildPlanTicketUpdate,
  type StoryBuild,
  type TicketUpdateCurrent,
} from '@pierre-review/shared';
import { useTicketUpdateCurrent, useUpdateTicket } from '../../hooks/useTicketPrs.js';
import { criteriaBoxLabel, ticketReviewSeed, ticketUpdateBody, ticketUpdateConfirm } from '../../lib/buildPlan.js';
import { REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { sessionErrorText } from '../../lib/sandboxSession.js';
import { changedRanges, lineDiff, lineDiffSummary, normaliseNewlines } from '../../lib/textDiff.js';
import { CopyButton } from '../CopyButton.js';
import { ChevronIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';

// THE TICKET REVIEW (the plan panel, "Implement, plan first"; docs/TRACKERS.md § The ticket update,
// docs/STORY-BUILD.md § Plan first). After planning, the WHOLE ticket — description and acceptance
// criteria — in two boxes, each seeded with the plan's draft, else the ticket's current text
// (`GET /api/ticket-update/current`). Under each box: what changes against the current ticket, and the
// layout check (shared `compareTicketLayout`, the same fold the host stored on the revision — advice,
// never a block). ONE "Update ticket" press (Jira only) sends only the fields that differ; the host
// writes the criteria where the ticket keeps them (their own field, in its format, or the description's
// criteria section). Asked once, never retried. Nothing else writes the ticket.

export function TicketReview({ build, update }: { build: StoryBuild; update: BuildPlanTicketUpdate | null }): JSX.Element | null {
  const current = useTicketUpdateCurrent(build.workspaceId, build.ident);
  if (current.isLoading) {
    return (
      <div data-testid="story-plan-ticket-update" className="text-meta text-ui-mute">
        Loading the ticket…
      </div>
    );
  }
  // No stored copy (or the read failed): the draft alone, editable and copyable, never written.
  return <TicketReviewBody key={current.data != null ? 'held' : 'none'} build={build} update={update} current={current.data ?? null} />;
}

function TicketReviewBody({
  build,
  update,
  current,
}: {
  build: StoryBuild;
  update: BuildPlanTicketUpdate | null;
  current: TicketUpdateCurrent | null;
}): JSX.Element | null {
  const seed = useMemo(() => ticketReviewSeed(update, current), [update, current]);
  const [description, setDescription] = useState(seed.description);
  const [criteria, setCriteria] = useState(seed.criteria);
  // Criteria in the description: the criteria box follows the description box until the reader edits it.
  const [criteriaTouched, setCriteriaTouched] = useState(false);
  const [asking, setAsking] = useState(false);
  const write = useUpdateTicket(build.workspaceId, build.ident);
  const inDescription = current?.acLocation.kind === 'description';
  useEffect(() => {
    if (inDescription && !criteriaTouched && findAcSection(description) != null) setCriteria(acSectionText(description));
  }, [inDescription, criteriaTouched, description]);

  if (update == null && current == null) return null;
  const jira = current?.jira === true;
  const edited = description !== seed.description || criteria !== seed.criteria;
  const body = current != null ? ticketUpdateBody({ description, criteria }, current) : { description: null, acceptanceCriteria: null };
  const nothing = body.description == null && body.acceptanceCriteria == null;
  const tooLong = [description, criteria].some((t) => t.length > TICKET_UPDATE_FIELD_MAX);
  const err = write.error != null ? (sessionErrorText(write.error) ?? 'Could not update the ticket.') : null;
  const layoutDescription = current != null ? compareTicketLayout(ticketLayoutOf(current.description), ticketLayoutOf(description), 'description') : [];
  const layoutCriteria =
    current != null ? compareTicketLayout(ticketLayoutOf(current.acceptanceCriteria), ticketLayoutOf(criteria), 'criteria') : [];
  // An edit after a write makes the ticket differ again: forget the "Updated" line.
  const touched = (): void => {
    if (write.isSuccess || write.isError) write.reset();
  };
  const heading = update == null ? 'The ticket' : `The ticket${edited ? ' (edited)' : ' (draft)'}`;
  return (
    <div data-testid="story-plan-ticket-update" data-editable="true" data-jira={jira ? 'true' : 'false'}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <h4 className={REVIEW_SUBHEAD}>{heading}</h4>
        <InfoButton title="The ticket">
          <p>The plan's changes to the ticket. Edit them, then press Update ticket. Limn writes to Jira only when you press it. Approve reads the ticket again.</p>
          <p className="mt-2">
            Under each box: what changes, and where the text no longer keeps the ticket's layout (its headings, its list style, GIVEN /
            WHEN / THEN). Those notes are advice: you decide.
          </p>
          <p className="mt-2">
            <span className="doc-quote-mark px-0.5">Highlighted</span> words differ from the ticket as it is now.
          </p>
          {current?.acLocation.kind === 'description' && (
            <p className="mt-2">This ticket keeps its acceptance criteria in the description. Limn writes them into that section.</p>
          )}
        </InfoButton>
        {edited && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            data-testid="story-plan-ticket-reset"
            onClick={() => {
              setDescription(seed.description);
              setCriteria(seed.criteria);
              setCriteriaTouched(false);
              write.reset();
            }}
          >
            {update == null ? 'Undo my changes' : 'Back to the draft'}
          </Button>
        )}
      </div>
      {update != null && update.why !== '' && <p className="mb-2 break-words text-body text-ui-ink">{update.why}</p>}
      {update == null && <p className="mb-2 text-meta text-ui-mute">The plan does not change the ticket.</p>}
      <DraftEditor
        label="Description"
        text={description}
        onChange={(v) => {
          setDescription(v);
          touched();
        }}
        testId="story-plan-ticket-description"
        baseline={current?.description ?? null}
      />
      {current != null && <WhatChanges before={current.description} after={description} testId="story-plan-ticket-description-diff" />}
      <LayoutNotes problems={layoutDescription} testId="story-plan-ticket-description-layout" />
      <DraftEditor
        label={criteriaBoxLabel(current?.acLocation ?? null)}
        text={criteria}
        onChange={(v) => {
          setCriteria(v);
          setCriteriaTouched(true);
          touched();
        }}
        testId="story-plan-ticket-criteria"
        baseline={current?.acceptanceCriteria ?? null}
      />
      {current != null && <WhatChanges before={current.acceptanceCriteria} after={criteria} testId="story-plan-ticket-criteria-diff" />}
      <LayoutNotes problems={layoutCriteria} testId="story-plan-ticket-criteria-layout" />
      {!jira ? (
        <p data-testid="story-plan-ticket-not-jira" className="mt-2 text-meta text-ui-mute">
          Updating the ticket works with Jira only. Copy the text instead.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-meta">
          {asking ? (
            <>
              <span className="text-ui-ink">{ticketUpdateConfirm(body)}</span>
              <Button
                size="sm"
                variant="primary"
                data-testid="story-plan-ticket-update-confirm"
                busy={write.isPending}
                busyLabel="Updating…"
                onClick={() => write.mutate(body, { onSettled: () => setAsking(false) })}
              >
                Replace
              </Button>
              <Button size="sm" variant="ghost" disabled={write.isPending} onClick={() => setAsking(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              data-testid="story-plan-ticket-update-button"
              disabled={nothing || tooLong || write.isPending || write.isSuccess}
              onClick={() => setAsking(true)}
            >
              Update ticket
            </Button>
          )}
          {write.isSuccess && (
            <span data-testid="story-plan-ticket-updated" className="text-ui-mute">
              Updated in Jira.{write.data?.criteriaWritten === 'description' ? ' The criteria went into the description.' : ''}
            </span>
          )}
          {nothing && !write.isSuccess && !asking && <span className="text-ui-mute">Nothing changes.</span>}
          {tooLong && <span className="text-ui-warn">Keep each box under {TICKET_UPDATE_FIELD_MAX.toLocaleString('en-GB')} characters.</span>}
          {err != null && <span className="text-ui-danger">{err}</span>}
        </div>
      )}
    </div>
  );
}

/** One collapsible line diff, current → new. */
function WhatChanges({ before, after, testId }: { before: string; after: string; testId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  const summary = lineDiffSummary(diff);
  if (summary == null) {
    return (
      <p data-testid={testId} className="mt-1 text-meta text-ui-mute">
        No change.
      </p>
    );
  }
  return (
    <div data-testid={testId} className="mt-1">
      <button type="button" className="hit flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronIcon dir={open ? 'down' : 'right'} />
        What changes · {summary}
      </button>
      {open && (
        <pre className="mt-1 max-h-72 overflow-auto rounded-ui bg-ui-raise p-2 font-mono text-meta">
          {diff.map((l, i) => (
            <div
              key={i}
              className={cx(
                'whitespace-pre-wrap break-words',
                l.kind === 'add' ? 'text-ui-success' : l.kind === 'del' ? 'text-ui-danger line-through' : 'text-ui-mute',
              )}
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function LayoutNotes({ problems, testId }: { problems: string[]; testId: string }): JSX.Element | null {
  if (problems.length === 0) return null;
  return (
    <ul data-testid={testId} className="mt-1 list-disc space-y-0.5 pl-4 text-meta text-ui-warn">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

/**
 * One ticket box. With a `baseline` (the ticket as it is now), the words that differ from it wear the
 * reference-docs highlight (`.doc-quote-mark`, index.css — the same wash as a docs quote): a mirror
 * BEHIND a transparent-text textarea draws the text and the marks, so the box stays a plain textarea
 * for typing, selection and the clipboard. ⚠ The mirror and the textarea must wrap identically: the
 * SAME padding, font, wrapping and scrollbar gutter (MIRROR_TEXT), and the mirror follows the
 * textarea's scroll. No baseline (no stored copy): a plain box, nothing marked.
 */
const MIRROR_TEXT = 'whitespace-pre-wrap break-words p-2 font-mono text-meta [scrollbar-gutter:stable]';

export function DraftEditor({
  label,
  text,
  onChange,
  testId,
  baseline = null,
}: {
  label: string;
  text: string;
  onChange: (v: string) => void;
  testId: string;
  baseline?: string | null;
}): JSX.Element {
  const id = useId();
  const rows = Math.min(14, Math.max(4, text.split('\n').length + 1));
  const ring =
    'rounded-ui ring-1 ring-inset ring-ui-line focus:outline-none focus:ring-2 focus:ring-ui-accent';
  return (
    <div data-testid={testId} className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-meta font-medium text-ui-ink">
          {label}
        </label>
        <CopyButton text={text} what={label.toLowerCase()} title={`Copy the ${label.toLowerCase()}, exactly as written`} />
      </div>
      {baseline == null ? (
        <textarea
          id={id}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          spellCheck
          className={cx('mt-1 block max-h-[28rem] w-full resize-y bg-ui-raise p-2 font-mono text-meta text-ui-ink', ring)}
        />
      ) : (
        <MarkedTextarea id={id} text={text} baseline={baseline} onChange={onChange} rows={rows} ring={ring} />
      )}
    </div>
  );
}

function MarkedTextarea({
  id,
  text,
  baseline,
  onChange,
  rows,
  ring,
}: {
  id: string;
  text: string;
  baseline: string;
  onChange: (v: string) => void;
  rows: number;
  ring: string;
}): JSX.Element {
  const box = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const shown = normaliseNewlines(text);
  const ranges = useMemo(() => changedRanges(baseline, shown), [baseline, shown]);
  const follow = (): void => {
    if (box.current != null && mirror.current != null) mirror.current.scrollTop = box.current.scrollTop;
  };
  useLayoutEffect(follow, [shown]);
  const parts: JSX.Element[] = [];
  let at = 0;
  ranges.forEach((r, i) => {
    if (r.start > at) parts.push(<span key={`t${i}`}>{shown.slice(at, r.start)}</span>);
    parts.push(
      <mark key={`m${i}`} className="doc-quote-mark">
        {shown.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  });
  if (at < shown.length) parts.push(<span key="tail">{shown.slice(at)}</span>);
  return (
    <div className="relative mt-1 rounded-ui bg-ui-raise" data-changed-words={ranges.length}>
      <div ref={mirror} aria-hidden="true" className={cx('pointer-events-none absolute inset-0 overflow-hidden text-ui-ink', MIRROR_TEXT)}>
        {parts}
        {/* A trailing newline still takes a line in the textarea. */}
        {'\n'}
      </div>
      <textarea
        ref={box}
        id={id}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onScroll={follow}
        rows={rows}
        spellCheck
        className={cx(
          'relative block max-h-[28rem] w-full resize-y bg-transparent text-transparent caret-ui-ink selection:bg-ui-accent/30',
          MIRROR_TEXT,
          ring,
        )}
      />
    </div>
  );
}
