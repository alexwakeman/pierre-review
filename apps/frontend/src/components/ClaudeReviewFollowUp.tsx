// The Claude Review tab's follow-up and user-story pieces, kept out of the 2,000-line tab:
//
//   ClaudeReviewTicketPanel     — the "User story or task (optional)" input, COLLAPSED by default.
//   ClaudeReviewTicketResults   — how the run measured up against that user story.
//   ClaudeReviewFollowUpSection — what became of the previous review's comments.
//
// Rules for all three:
//  - Every string from Claude or from the pasted user story renders as PLAIN TEXT: no Markdown,
//    and no href built from it. A code anchor is a <button> into the Changes tab when the file is
//    in the PR, otherwise plain mono text.
//  - Statuses and counts come from the server's reconcile step, which never invents "addressed".
//    The sentences are templated in `@pierre-review/shared` (code-derived); Claude's explanations
//    are shown separately and labelled as Claude's.
//  - Chips are 11px or larger, sentences 12px or larger, no uppercase-with-tracking labels, and
//    every muted colour is paired for both themes (`textContrast.test.ts`).
import { useId, useMemo, useState } from 'react';
import {
  FOLLOW_UP_STATUS_LABEL,
  TICKET_ALIGNMENT_LABEL,
  TICKET_CRITERION_STATUS_LABEL,
  ticketCriteriaSentence,
} from '@pierre-review/shared';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFollowUpItem,
  ClaudeReviewFollowUp,
  ClaudeReviewTicket,
  ClaudeReviewTicketCheck,
  ClaudeReviewTicketField,
  ClaudeTicketAssessment,
  ClaudeTicketCriterionResult,
  ClaudeTicketGap,
} from '@pierre-review/shared';
import {
  EMPTY_TICKET_DRAFT,
  FOLLOW_UP_STATUS_CLASS,
  SEVERITY_CLASS,
  TICKET_ALIGNMENT_CLASS,
  TICKET_CRITERION_STATUS_CLASS,
  anchorLabel,
  fieldCounter,
  followUpAnchor,
  notCheckedReason,
  partitionFollowUp,
  ticketDraftHasContent,
  ticketPanelHint,
  type TicketDraft,
} from '../lib/claudeReviewFollowUp.js';
import { ChevronIcon } from './Icons.js';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

const SEVERITY_WORD: Record<ClaudeFindingSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
  praise: 'Praise',
};

const CHIP = 'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium';
const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const INPUT =
  'mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900';

// A path (and line) that jumps into the Changes tab when the file is in the PR, else plain text.
// A BUTTON, never an <a href="#…">: a hash navigation would write to the URL useUrlState owns.
function CodeAnchorRef({
  path,
  line,
  side,
  inChangeset,
  onOpenInChanges,
}: {
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  inChangeset: boolean;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const label = anchorLabel(path, line);
  if (inChangeset && onOpenInChanges != null) {
    return (
      <button
        type="button"
        onClick={() => onOpenInChanges(path, line, side)}
        className="break-all text-left font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
      >
        {label}
      </button>
    );
  }
  return <span className={`break-all font-mono text-xs ${MUTED}`}>{label}</span>;
}

// ---- (a) the input panel ----

function TicketField({
  id,
  label,
  field,
  value,
  error,
  helper,
  children,
}: {
  id: string;
  label: string;
  field: ClaudeReviewTicketField;
  value: string;
  error: string | null;
  helper?: string | null;
  children: JSX.Element;
}): JSX.Element {
  const counter = fieldCounter(field, value);
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-gray-700 dark:text-gray-200">
        {label}
      </label>
      {children}
      {(helper != null || counter != null) && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
          {helper != null && <span className={MUTED}>{helper}</span>}
          {counter != null && (
            <span className={counter.over ? ERROR_TEXT : MUTED}>{counter.text}</span>
          )}
        </div>
      )}
      {error != null && (
        <p id={`${id}-error`} className={`mt-0.5 text-xs ${ERROR_TEXT}`}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The optional user story or task. COLLAPSED by default; when it holds something, the header says
 * so (" · 3 acceptance criteria", " · added", or " · needs a fix") so a closed panel never hides
 * what the next run will send. NO `maxLength` on any input — it would silently cut a paste; the
 * counter and the check's message say what is over instead.
 */
export function ClaudeReviewTicketPanel({
  value,
  onChange,
  check,
}: {
  value: TicketDraft;
  onChange: (next: TicketDraft) => void;
  check: ClaudeReviewTicketCheck;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const hint = ticketPanelHint(value, check);
  const errorFor = (f: ClaudeReviewTicketField): string | null =>
    !check.ok && check.field === f ? check.message : null;
  const set = (field: ClaudeReviewTicketField, v: string): void =>
    onChange({ ...value, [field]: v });
  const ids = {
    body: `${baseId}-body`,
    title: `${baseId}-title`,
    description: `${baseId}-description`,
    acceptanceCriteria: `${baseId}-criteria`,
  };
  const describedBy = (f: ClaudeReviewTicketField): string | undefined =>
    errorFor(f) != null ? `${ids[f]}-error` : undefined;

  return (
    <div className="mt-2 rounded border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={ids.body}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-gray-700 dark:text-gray-200"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} className="shrink-0" />
        <span>User story or task (optional)</span>
        {hint !== '' && (
          <span className={`font-normal ${check.ok ? MUTED : ERROR_TEXT}`}>{hint}</span>
        )}
      </button>
      {open && (
        <div
          id={ids.body}
          className="space-y-2 border-t border-gray-200 px-2 py-2 dark:border-gray-800"
        >
          <p className={`text-xs ${MUTED}`}>
            Paste the user story or task. Claude checks the change against it and lists what is
            missing or was not asked for.
          </p>
          <TicketField
            id={ids.title}
            label="Title"
            field="title"
            value={value.title}
            error={errorFor('title')}
          >
            <input
              id={ids.title}
              type="text"
              value={value.title}
              onChange={(e) => set('title', e.target.value)}
              aria-invalid={errorFor('title') != null}
              aria-describedby={describedBy('title')}
              className={INPUT}
            />
          </TicketField>
          <TicketField
            id={ids.description}
            label="Description"
            field="description"
            value={value.description}
            error={errorFor('description')}
          >
            <textarea
              id={ids.description}
              rows={4}
              value={value.description}
              onChange={(e) => set('description', e.target.value)}
              aria-invalid={errorFor('description') != null}
              aria-describedby={describedBy('description')}
              className={INPUT}
            />
          </TicketField>
          <TicketField
            id={ids.acceptanceCriteria}
            label="Acceptance criteria"
            field="acceptanceCriteria"
            value={value.acceptanceCriteria}
            error={errorFor('acceptanceCriteria')}
            helper="Any format. Claude works out the individual criteria."
          >
            <textarea
              id={ids.acceptanceCriteria}
              rows={5}
              value={value.acceptanceCriteria}
              onChange={(e) => set('acceptanceCriteria', e.target.value)}
              placeholder={
                'Paste them as they are in the ticket, for example:\nGiven a signed-out user\nWhen they ask to reset their password\nThen a reset link is emailed and expires after one hour'
              }
              aria-invalid={errorFor('acceptanceCriteria') != null}
              aria-describedby={describedBy('acceptanceCriteria')}
              className={INPUT}
            />
          </TicketField>
          {ticketDraftHasContent(value) && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_TICKET_DRAFT)}
              className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- (b) the results against the user story ----

function CriterionRow({
  c,
  changedPaths,
  onOpenInChanges,
}: {
  c: ClaudeTicketCriterionResult;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const border =
    c.status === 'not_met'
      ? 'border-red-300 dark:border-red-700/60'
      : c.status === 'partly_met'
        ? 'border-orange-300 dark:border-orange-700/60'
        : 'border-gray-200 dark:border-gray-800';
  return (
    <li className={`rounded border px-2 py-1.5 ${border}`}>
      <div className="flex items-start gap-2">
        <span className={`shrink-0 font-mono text-xs ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-gray-800 dark:text-gray-200">
          {c.text}
        </span>
        <span className={`${CHIP} ${TICKET_CRITERION_STATUS_CLASS[c.status]}`}>
          {TICKET_CRITERION_STATUS_LABEL[c.status]}
        </span>
      </div>
      {c.explanation != null && c.explanation !== '' && (
        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
          <span className="font-medium">Claude: </span>
          {c.explanation}
        </p>
      )}
      {c.path != null && c.path !== '' && (
        <div className="mt-0.5">
          <CodeAnchorRef
            path={c.path}
            line={c.line}
            side="RIGHT"
            inChangeset={changedPaths.has(c.path)}
            onOpenInChanges={onOpenInChanges}
          />
        </div>
      )}
    </li>
  );
}

function GapList({
  heading,
  gaps,
  border,
  changedPaths,
  onOpenInChanges,
}: {
  heading: string;
  gaps: ClaudeTicketGap[];
  border: string;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  if (gaps.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">
        {heading} ({gaps.length})
      </div>
      <ul className="mt-1 space-y-1">
        {gaps.map((g, i) => (
          <li key={i} className={`rounded border px-2 py-1.5 text-xs ${border}`}>
            <div className="whitespace-pre-wrap break-words font-medium text-gray-800 dark:text-gray-200">
              {g.title}
            </div>
            {g.explanation != null && g.explanation !== '' && (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
                {g.explanation}
              </p>
            )}
            {g.path != null && g.path !== '' && (
              <div className="mt-0.5">
                <CodeAnchorRef
                  path={g.path}
                  line={g.line}
                  side="RIGHT"
                  inChangeset={changedPaths.has(g.path)}
                  onOpenInChanges={onOpenInChanges}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ClaudeReviewTicketResults({
  ticket,
  assessment,
  changedPaths,
  onOpenInChanges,
}: {
  ticket: ClaudeReviewTicket;
  assessment: ClaudeTicketAssessment | null;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const sentence = ticketCriteriaSentence(assessment);
  return (
    <section
      aria-label="User story or task"
      className="rounded border border-gray-200 px-3 py-2 dark:border-gray-800"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">User story or task</span>
        {assessment != null && (
          <span className={`${CHIP} ${TICKET_ALIGNMENT_CLASS[assessment.alignment]}`}>
            {TICKET_ALIGNMENT_LABEL[assessment.alignment]}
          </span>
        )}
        {sentence != null && (
          <span className="text-xs text-gray-700 dark:text-gray-300">{sentence}</span>
        )}
      </div>
      {ticket.title != null && ticket.title !== '' && (
        <div className="mt-1 whitespace-pre-wrap break-words text-sm font-medium">
          {ticket.title}
        </div>
      )}
      {assessment == null ? (
        <p className={`mt-1 text-xs ${MUTED}`}>Not checked in this run.</p>
      ) : (
        <>
          {assessment.summary != null && assessment.summary !== '' && (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
              <span className="font-medium">Claude: </span>
              {assessment.summary}
            </p>
          )}
          {assessment.criteria.length > 0 && (
            <ol className="mt-2 space-y-1.5">
              {assessment.criteria.map((c) => (
                <CriterionRow
                  key={c.ref}
                  c={c}
                  changedPaths={changedPaths}
                  onOpenInChanges={onOpenInChanges}
                />
              ))}
            </ol>
          )}
          <GapList
            heading="Asked for but not done"
            gaps={assessment.missing}
            border="border-red-300 dark:border-red-700/60"
            changedPaths={changedPaths}
            onOpenInChanges={onOpenInChanges}
          />
          <GapList
            heading="Added but not asked for"
            gaps={assessment.notRequested}
            border="border-amber-300 dark:border-amber-700/60"
            changedPaths={changedPaths}
            onOpenInChanges={onOpenInChanges}
          />
        </>
      )}
    </section>
  );
}

// ---- (c) the previous review ----

function FollowUpRow({
  item,
  muted,
  findingsById,
  headMoved,
  changedPaths,
  onOpenInChanges,
}: {
  item: ClaudeFollowUpItem;
  muted: boolean;
  findingsById: ReadonlyMap<number, ClaudeFinding>;
  headMoved: boolean;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const anchor = followUpAnchor(item, findingsById, headMoved, changedPaths);
  const border =
    item.status === 'not_addressed' || item.status === 'partly_addressed'
      ? 'border-amber-300 dark:border-amber-700/60'
      : 'border-gray-200 dark:border-gray-800';
  const reraised =
    item.reraisedFindingId != null && findingsById.has(item.reraisedFindingId)
      ? item.reraisedFindingId
      : null;
  return (
    <li className={`rounded border px-3 py-2 text-sm ${border}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${CHIP} ${FOLLOW_UP_STATUS_CLASS[item.status]}`}>
          {FOLLOW_UP_STATUS_LABEL[item.status]}
        </span>
        <span className={`${CHIP} ${SEVERITY_CLASS[item.severity]}`}>
          {SEVERITY_WORD[item.severity]}
        </span>
        <span
          className={`min-w-0 break-words ${muted ? 'text-gray-600 dark:text-gray-400' : 'font-medium'}`}
        >
          {item.title}
        </span>
        {item.carried && <span className={`text-xs ${MUTED}`}>from an earlier review</span>}
      </div>
      <div className="mt-0.5">
        <CodeAnchorRef
          path={anchor.path}
          line={anchor.line}
          side={anchor.side}
          inChangeset={anchor.inChangeset}
          onOpenInChanges={onOpenInChanges}
        />
      </div>
      {item.explanation != null && item.explanation !== '' ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
          <span className="font-medium">Claude: </span>
          {item.explanation}
        </p>
      ) : item.status === 'not_checked' ? (
        <p className={`mt-1 text-xs ${MUTED}`}>{notCheckedReason(item)}</p>
      ) : null}
      {reraised != null && (
        <button
          type="button"
          onClick={() =>
            document
              .getElementById(`claude-finding-${reraised}`)
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
          className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          Raised again below
          <ChevronIcon dir="down" size={11} />
        </button>
      )}
    </li>
  );
}

/**
 * What became of the previous review's comments. Still-open ones first and prominent (not
 * addressed, then partly addressed, then not checked); addressed and no-longer-applies ones sit
 * in a disclosure, collapsed by default.
 */
export function ClaudeReviewFollowUpSection({
  followUp,
  findings,
  changedPaths,
  onOpenInChanges,
}: {
  followUp: ClaudeReviewFollowUp;
  // This run's findings, to resolve each re-raised comment's CURRENT anchor.
  findings: readonly ClaudeFinding[];
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  const [closedOpen, setClosedOpen] = useState(false);
  const findingsById = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings]);
  const { open, closed } = useMemo(() => partitionFollowUp(followUp.items), [followUp.items]);
  if (followUp.items.length === 0) return null;
  const rowProps = {
    findingsById,
    headMoved: followUp.headMoved,
    changedPaths,
    onOpenInChanges,
  };
  return (
    <section aria-label="Previous review" className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Previous review</span>
        <span className={`font-mono text-xs ${MUTED}`} title={followUp.priorHeadSha}>
          {followUp.priorHeadSha.slice(0, 7)}
        </span>
        {!followUp.headMoved && (
          <span className={`text-xs ${MUTED}`}>No new commits since that review.</span>
        )}
      </div>
      {open.length > 0 && (
        <ul className="space-y-1.5">
          {open.map((it) => (
            <FollowUpRow key={it.priorFindingId} item={it} muted={false} {...rowProps} />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setClosedOpen((o) => !o)}
            aria-expanded={closedOpen}
            className={`inline-flex items-center gap-1 text-xs ${MUTED} hover:text-gray-700 dark:hover:text-gray-200`}
          >
            <ChevronIcon dir={closedOpen ? 'down' : 'right'} size={11} />
            Addressed or no longer applies ({closed.length})
          </button>
          {closedOpen && (
            <ul className="mt-1.5 space-y-1.5">
              {closed.map((it) => (
                <FollowUpRow key={it.priorFindingId} item={it} muted {...rowProps} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
