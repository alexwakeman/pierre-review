// The Claude Review tab's follow-up and user-story pieces, kept out of the 2,000-line tab:
//
//   ClaudeReviewTicketPanel     — the "User stories (optional)" input, COLLAPSED by default.
//   ClaudeReviewTicketResults   — how the run measured up against ONE user story (read-only; its
//                                 unmet items are findings, each row links to its card).
//   ClaudeReviewFollowUpSection — what became of the previous review's comments.
//
// Rules for all three:
//  - Every string from Claude or from a pasted user story renders as PLAIN TEXT: no Markdown,
//    and no href built from it. A story READ FROM JIRA is the one exception, and it renders in
//    ClaudeReviewTickets.tsx (JiraStoryView), never here. A code anchor is a <button> into the Changes tab when the file is
//    in the PR, otherwise plain mono text.
//  - Statuses and counts come from the server's reconcile step, which never invents "addressed".
//    The sentences are templated in `@pierre-review/shared` (code-derived); Claude's explanations
//    are shown separately and labelled as Claude's.
//  - Chips are 11px or larger, sentences 12px or larger, no uppercase-with-tracking labels, and
//    every muted colour is paired for both themes (`textContrast.test.ts`).
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  CLAUDE_REVIEW_MAX_TICKETS,
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
  ClaudeFollowUpStatus,
  ClaudeReviewFollowUp,
  ClaudeReviewTicketEntry,
  ClaudeReviewTicketField,
  ClaudeReviewTicketsCheck,
  ClaudeTicketCriterionResult,
  ClaudeTicketGap,
  JiraTicketDetails,
  TicketRef,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import {
  acCandidateLabel,
  applyAcCandidate,
  browserAcMemory,
  fillDraftFromJira,
  fillableJiraTickets,
  jiraProvenance,
  unfillableJiraTickets,
  jiraFillNote,
  jiraSiteOf,
  readRememberedAcField,
  rememberAcField,
} from '../lib/jiraTicket.js';
import {
  EMPTY_TICKET_DRAFT,
  FOLLOW_UP_STATUS_CLASS,
  SEVERITY_CLASS,
  TICKET_ALIGNMENT_CLASS,
  TICKET_CRITERION_STATUS_CLASS,
  anchorLabel,
  fieldCounter,
  followUpAnchor,
  isJiraDraft,
  notCheckedReason,
  partitionFollowUp,
  storyFindingIdFor,
  storyItemChipLabel,
  ticketsPanelHint,
  type TicketDraft,
} from '../lib/claudeReviewFollowUp.js';
import { CheckIcon, ChevronIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { JiraStoryView } from './ClaudeReviewTickets.js';
import { ReviewSection } from './ReviewSection.js';

type OpenInChanges = (path: string, line: number | null, side: ClaudeFindingSide) => void;

const SEVERITY_WORD: Record<ClaudeFindingSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
  praise: 'Praise',
};

// The Previous review header's pills: still-open statuses first.
const FOLLOW_UP_PILL_ORDER: ClaudeFollowUpStatus[] = [
  'not_addressed',
  'partly_addressed',
  'not_checked',
  'addressed',
  'no_longer_applies',
];

const CHIP = 'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium';
const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';
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
  children,
}: {
  id: string;
  label: string;
  field: ClaudeReviewTicketField;
  value: string;
  error: string | null;
  children: JSX.Element;
}): JSX.Element {
  const counter = fieldCounter(field, value);
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-gray-700 dark:text-gray-200">
        {label}
      </label>
      {children}
      {counter != null && (
        <div className={`mt-0.5 text-xs ${counter.over ? ERROR_TEXT : MUTED}`}>{counter.text}</div>
      )}
      {error != null && (
        <p id={`${id}-error`} className={`mt-0.5 text-xs ${ERROR_TEXT}`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** One typed or pasted story: three editable fields and Remove. */
function ManualStoryFields({
  label,
  value,
  onChange,
  onRemove,
  errorFor,
}: {
  label: string;
  value: TicketDraft;
  onChange: (next: TicketDraft) => void;
  onRemove: () => void;
  errorFor: (f: ClaudeReviewTicketField) => string | null;
}): JSX.Element {
  const baseId = useId();
  const ids = {
    title: `${baseId}-title`,
    description: `${baseId}-description`,
    acceptanceCriteria: `${baseId}-criteria`,
  };
  const set = (field: ClaudeReviewTicketField, v: string): void =>
    onChange({ ...value, [field]: v });
  const describedBy = (f: ClaudeReviewTicketField): string | undefined =>
    errorFor(f) != null ? `${ids[f]}-error` : undefined;
  return (
    <div className="space-y-2 rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-semibold text-gray-700 dark:text-gray-200">{label}</span>
        <button type="button" onClick={onRemove} className={BTN}>
          Remove
        </button>
      </div>
      <TicketField id={ids.title} label="Title" field="title" value={value.title} error={errorFor('title')}>
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
          rows={3}
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
      >
        <textarea
          id={ids.acceptanceCriteria}
          rows={4}
          value={value.acceptanceCriteria}
          onChange={(e) => set('acceptanceCriteria', e.target.value)}
          aria-invalid={errorFor('acceptanceCriteria') != null}
          aria-describedby={describedBy('acceptanceCriteria')}
          className={INPUT}
        />
      </TicketField>
    </div>
  );
}

// A ticket this session fetched, kept for its candidates so the dropdown refills the criteria
// with NO refetch.
interface FetchedJira {
  details: JiraTicketDetails;
  site: string | null;
  chosen: string;
}

/** The label a story goes by: its Jira key, else "Story N". */
export function storyLabel(d: { key?: string | null }, index: number): string {
  return d.key != null && d.key !== '' ? d.key : `Story ${index + 1}`;
}

/**
 * The optional user stories — up to CLAUDE_REVIEW_MAX_TICKETS, each assessed on its own. COLLAPSED
 * by default; the header says when it holds something (" · 2 added" / " · needs a fix"), so a
 * closed panel never hides what Run sends. A story read from Jira is READ-ONLY (markdown); a typed
 * one is three editable fields. NO `maxLength` on any input — it would silently cut a paste.
 */
export function ClaudeReviewTicketPanel({
  value,
  onChange,
  check,
  prId,
  tickets,
  prWorkspaceName,
}: {
  value: TicketDraft[];
  onChange: (next: TicketDraft[]) => void;
  check: ClaudeReviewTicketsCheck;
  prId: number;
  tickets: readonly TicketRef[] | null | undefined;
  // The workspace that OWNS this PR's repo — the one whose Jira token is used. null = unknown.
  prWorkspaceName?: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const [fetched, setFetched] = useState<{ prId: number; byKey: Record<string, FetchedJira> }>({
    prId,
    byKey: {},
  });
  const byKey = fetched.prId === prId ? fetched.byKey : {};
  // The list as it is when an answer lands, not when a button was pressed.
  const latest = useRef(value);
  latest.current = value;
  const hint = ticketsPanelHint(value, check);
  const full = value.length >= CLAUDE_REVIEW_MAX_TICKETS;

  const replaceAt = (i: number, d: TicketDraft): void =>
    onChange(latest.current.map((x, j) => (j === i ? d : x)));
  const removeAt = (i: number): void => onChange(latest.current.filter((_, j) => j !== i));
  const onFilled = (ref: TicketRef, details: JiraTicketDetails, site: string | null, chosen: string, draft: TicketDraft): void => {
    const story: TicketDraft = { ...draft, ...jiraProvenance(ref) };
    const cur = latest.current;
    const at = cur.findIndex((d) => d.key === ref.key);
    if (at >= 0) onChange(cur.map((d, j) => (j === at ? story : d)));
    else onChange([...cur, story]);
    setFetched({ prId, byKey: { ...byKey, [ref.key]: { details, site, chosen } } });
  };
  const chooseAc = (i: number, key: string, id: string): void => {
    const f = byKey[key];
    const d = latest.current[i];
    if (f == null || d == null) return;
    // An EXPLICIT choice is remembered for this issue type on this Jira site (blank forgets).
    rememberAcField(browserAcMemory(), f.site, f.details.issueType?.id, id);
    replaceAt(i, applyAcCandidate(d, f.details.candidates, id));
    setFetched({ prId, byKey: { ...byKey, [key]: { ...f, chosen: id } } });
  };
  const errorAt =
    (i: number) =>
    (f: ClaudeReviewTicketField): string | null =>
      !check.ok && check.index === i && check.field === f ? check.message : null;
  const addedKeys = new Set(value.map((d) => d.key).filter((k): k is string => k != null));

  return (
    <div className="mt-2 rounded border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-gray-700 dark:text-gray-200"
        >
          <ChevronIcon dir={open ? 'down' : 'right'} className="shrink-0" />
          <span>User stories (optional)</span>
          {hint !== '' && (
            <span className={`font-normal ${check.ok ? MUTED : ERROR_TEXT}`}>{hint}</span>
          )}
        </button>
        <InfoButton title="User stories">
          <p>
            Claude checks the change against each story and lists what is missing or was not asked
            for. Each story gets its own result, which you can post to the pull request as a comment.
          </p>
          <p className="mt-2">
            Stories read from Jira are shown as they are in the ticket. Up to{' '}
            {CLAUDE_REVIEW_MAX_TICKETS} per review.
          </p>
        </InfoButton>
      </div>
      {open && (
        <div id={bodyId} className="space-y-2 border-t border-gray-200 px-2 py-2 dark:border-gray-800">
          {value.map((d, i) => {
            if (isJiraDraft(d)) {
              const f = d.key != null ? byKey[d.key] : undefined;
              return (
                <JiraStoryView
                  key={`jira-${d.key ?? i}`}
                  draft={d}
                  onRemove={() => removeAt(i)}
                  acPicker={
                    f != null && d.key != null ? (
                      <AcFieldPicker fetched={f} onChoose={(id) => chooseAc(i, d.key as string, id)} />
                    ) : undefined
                  }
                />
              );
            }
            return (
              <ManualStoryFields
                key={`manual-${i}`}
                label={storyLabel(d, i)}
                value={d}
                onChange={(next) => replaceAt(i, next)}
                onRemove={() => removeAt(i)}
                errorFor={errorAt(i)}
              />
            );
          })}
          {!check.ok && check.index == null && (
            <p className={`text-xs ${ERROR_TEXT}`}>{check.message}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <JiraFillButtons
              prId={prId}
              tickets={tickets}
              addedKeys={addedKeys}
              full={full}
              onFilled={onFilled}
              prWorkspaceName={prWorkspaceName ?? null}
            />
            {!full && (
              <button
                type="button"
                onClick={() => onChange([...latest.current, { ...EMPTY_TICKET_DRAFT }])}
                className={BTN}
              >
                Add a story
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "Acceptance criteria from" — every custom text field on the fetched ticket. */
function AcFieldPicker({
  fetched,
  onChoose,
}: {
  fetched: FetchedJira;
  onChoose: (id: string) => void;
}): JSX.Element | null {
  const selectId = useId();
  const { details, chosen } = fetched;
  const note = jiraFillNote(details, chosen);
  if (details.candidates.length === 0) {
    return note != null ? <p className={`mt-1 text-xs ${MUTED}`}>{note}</p> : null;
  }
  return (
    <div className="mt-1">
      <label htmlFor={selectId} className="text-xs font-medium text-gray-700 dark:text-gray-200">
        Acceptance criteria from
        {details.issueType != null && (
          <span className={`font-normal ${MUTED}`}> ({details.issueType.name})</span>
        )}
      </label>
      <select id={selectId} value={chosen} onChange={(e) => onChoose(e.target.value)} className={INPUT}>
        <option value="">None of these</option>
        {details.candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {acCandidateLabel(c)}
          </option>
        ))}
      </select>
      {details.omittedCandidates > 0 && (
        <p className={`mt-0.5 text-xs ${MUTED}`}>
          {details.omittedCandidates} more {details.omittedCandidates === 1 ? 'field' : 'fields'} with
          text not listed.
        </p>
      )}
      {note != null && <p className={`mt-0.5 text-xs ${MUTED}`}>{note}</p>}
    </div>
  );
}

/**
 * "Add KEY" — one button per Jira ticket DETECTED on this PR whose workspace has a saved token
 * (`TicketRef.canFetchDetails`) and that is not already in the list. CLICK-GATED — nothing is
 * fetched on mount. A fill adds the ticket as a READ-ONLY story (or refreshes it), with the
 * criteria field preselected from the viewer's remembered choice for the issue type, else the
 * best name match, else blank.
 */
function JiraFillButtons({
  prId,
  tickets,
  addedKeys,
  full,
  onFilled,
  prWorkspaceName,
}: {
  prId: number;
  tickets: readonly TicketRef[] | null | undefined;
  addedKeys: ReadonlySet<string>;
  full: boolean;
  onFilled: (
    ref: TicketRef,
    details: JiraTicketDetails,
    site: string | null,
    chosen: string,
    draft: TicketDraft,
  ) => void;
  prWorkspaceName: string | null;
}): JSX.Element | null {
  const fillable = fillableJiraTickets(tickets);
  const unfillable = unfillableJiraTickets(tickets);
  const fill = useMutation<JiraTicketDetails, Error, string>({
    mutationFn: (key) => api.jiraTicket(prId, key),
    onSuccess: (details, key) => {
      const ref = fillable.find((t) => t.key === key);
      if (ref == null) return;
      const site = jiraSiteOf(ref.url);
      const remembered = readRememberedAcField(browserAcMemory(), site, details.issueType?.id);
      // The same fill the Open PRs table's click-to-review runs (`fillDraftFromJira`).
      const { draft, chosen } = fillDraftFromJira(EMPTY_TICKET_DRAFT, details, remembered);
      onFilled(ref, details, site, chosen, draft);
    },
  });
  if (fillable.length === 0) {
    // A ticket WAS detected but its workspace has no token: say where to add one rather than
    // render nothing. (The token belongs to the workspace that owns the PR's repo, which need not
    // be the workspace being viewed.)
    if (unfillable.length === 0) return null;
    return (
      <p className={`w-full text-xs ${MUTED}`}>
        To add {unfillable.map((t) => t.key).join(', ')}, add a Jira API token in Settings for the{' '}
        {prWorkspaceName != null ? `${prWorkspaceName} workspace` : 'workspace this repository is in'}.
      </p>
    );
  }
  return (
    <>
      {fillable.map((t) => {
        const added = addedKeys.has(t.key);
        if (full && !added) return null;
        const busy = fill.isPending && fill.variables === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => fill.mutate(t.key)}
            disabled={fill.isPending}
            className={BTN}
          >
            {busy ? `Reading ${t.key}…` : added ? `Refresh ${t.key}` : `Add ${t.key}`}
          </button>
        );
      })}
      {fill.isError && <p className={`w-full text-xs ${ERROR_TEXT}`}>{fill.error.message}</p>}
    </>
  );
}

// ---- (b) the results against the user story ----

// A criterion row with NO finding card: met, can't tell, not checked — or an unmet one on a run
// stored before story findings existed (the fallback, so an older run still reads sensibly).
function CriterionRow({
  c,
  changedPaths,
  onOpenInChanges,
}: {
  c: ClaudeTicketCriterionResult;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  // MET is one compact line: tick, ref, criterion, where. Nothing to act on, so no card.
  if (c.status === 'met') {
    return (
      <li className="flex items-baseline gap-2 px-1 text-xs">
        <span className="shrink-0 self-center text-green-700 dark:text-green-400" aria-label="Met">
          <CheckIcon size={12} />
        </span>
        <span className={`shrink-0 font-mono ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 break-words text-gray-800 dark:text-gray-200">
          {c.text}
          {c.path != null && c.path !== '' && (
            <>
              <span className={MUTED} aria-hidden="true">
                {' · '}
              </span>
              <CodeAnchorRef
                path={c.path}
                line={c.line}
                side="RIGHT"
                inChangeset={changedPaths.has(c.path)}
                onOpenInChanges={onOpenInChanges}
              />
            </>
          )}
        </span>
      </li>
    );
  }
  return (
    <li className="rounded border border-gray-200 px-3 py-2 dark:border-gray-800">
      <div className="flex items-start gap-2">
        <span className={`${CHIP} ${TICKET_CRITERION_STATUS_CLASS[c.status]}`}>
          {TICKET_CRITERION_STATUS_LABEL[c.status]}
        </span>
        <span className={`shrink-0 font-mono text-xs leading-5 ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium">{c.text}</span>
      </div>
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
      {c.explanation != null && c.explanation !== '' && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
          <span className="font-medium">Claude: </span>
          {c.explanation}
        </p>
      )}
    </li>
  );
}

// A "Not done" item with no finding card (a run stored before story findings) — the fallback.
function MissingRow({
  g,
  changedPaths,
  onOpenInChanges,
}: {
  g: ClaudeTicketGap;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  return (
    <li className="rounded border border-gray-200 px-3 py-2 dark:border-gray-800">
      <div className="whitespace-pre-wrap break-words text-sm font-medium">{g.title}</div>
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
      {g.explanation != null && g.explanation !== '' && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
          {g.explanation}
        </p>
      )}
    </li>
  );
}

// A sub-group heading inside one story ("Not done (1)").
function StoryGroupHeading({ children }: { children: string }): JSX.Element {
  return <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">{children}</h5>;
}

/**
 * How the run measured up against ONE user story, inside the User stories section. ⚠ LIKE FOR
 * LIKE WITH THE FINDINGS LIST: every not met / partly met criterion and every "Not done" item IS a
 * finding, and renders as THAT finding's card (`renderFinding`, the Findings list's own component,
 * with its Post / Reword / Copy / Ignore). The Findings list leaves those out, so each is on screen
 * once. Met criteria are one compact line; "Not asked for" is a compact informational list (adding
 * something is not a defect, so it is never a finding). A run stored before story findings has no
 * card to show, so its unmet items fall back to read-only rows.
 */
export function ClaudeReviewTicketResults({
  entry,
  label,
  findingIds,
  findingsById,
  renderFinding,
  changedPaths,
  onOpenInChanges,
}: {
  entry: ClaudeReviewTicketEntry;
  // "PROJ-12" or "Story 2"; null for a lone story with no key (the section title already says
  // "User story", so the sub-header is just its title).
  label: string | null;
  // `storyFindingIds(review.findings)` — this run's story findings by `${index}:${ref}`.
  findingIds: ReadonlyMap<string, number>;
  findingsById: ReadonlyMap<number, ClaudeFinding>;
  // The Findings list's own card, for one story finding; `chip` names the item ("AC2 · Partly met").
  renderFinding: (f: ClaudeFinding, chip: string) => ReactNode;
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
}): JSX.Element {
  const { ticket, assessment } = entry;
  const sentence = ticketCriteriaSentence(assessment);
  const cardFor = (id: number | null): ClaudeFinding | null => (id != null ? (findingsById.get(id) ?? null) : null);
  const rowProps = { changedPaths, onOpenInChanges };
  return (
    <div aria-label={`User story ${label ?? ticket.title ?? ''}`} className="space-y-3">
      <h4 className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {label != null && (
          <span
            className={`text-sm font-semibold text-gray-900 dark:text-gray-100 ${ticket.key != null ? 'font-mono' : ''}`}
          >
            {label}
          </span>
        )}
        {ticket.title != null && ticket.title !== '' && (
          <span className="min-w-0 break-words text-sm font-medium text-gray-900 dark:text-gray-100">
            {ticket.title}
          </span>
        )}
        {assessment != null && (
          <span className={`${CHIP} ${TICKET_ALIGNMENT_CLASS[assessment.alignment]}`}>
            {TICKET_ALIGNMENT_LABEL[assessment.alignment]}
          </span>
        )}
        {sentence != null && <span className={`text-xs font-normal ${MUTED}`}>{sentence.replace(/\.$/, '')}</span>}
      </h4>
      {assessment == null ? (
        <p className={`text-xs ${MUTED}`}>Not checked in this run.</p>
      ) : (
        <>
          {assessment.summary != null && assessment.summary !== '' && (
            <p className="whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">
              <span className="font-medium">Claude: </span>
              {assessment.summary}
            </p>
          )}
          {assessment.criteria.length > 0 && (
            <ul className="space-y-1.5">
              {assessment.criteria.map((c) => {
                const unmet = c.status === 'not_met' || c.status === 'partly_met';
                const f = unmet ? cardFor(storyFindingIdFor(findingIds, entry.index, { ref: c.ref })) : null;
                return f != null && (c.status === 'not_met' || c.status === 'partly_met') ? (
                  <Fragment key={c.ref}>{renderFinding(f, storyItemChipLabel(c.ref, c.status))}</Fragment>
                ) : (
                  <CriterionRow key={c.ref} c={c} {...rowProps} />
                );
              })}
            </ul>
          )}
          {assessment.missing.length > 0 && (
            <div className="space-y-1.5">
              <StoryGroupHeading>{`Not done (${assessment.missing.length})`}</StoryGroupHeading>
              <ul className="space-y-1.5">
                {assessment.missing.map((g, i) => {
                  const f = cardFor(storyFindingIdFor(findingIds, entry.index, { missingIndex: i }));
                  return f != null ? (
                    <Fragment key={i}>{renderFinding(f, storyItemChipLabel(f.story?.ref ?? '', null))}</Fragment>
                  ) : (
                    <MissingRow key={i} g={g} {...rowProps} />
                  );
                })}
              </ul>
            </div>
          )}
          {assessment.notRequested.length > 0 && (
            <div className="space-y-1">
              <StoryGroupHeading>{`Not asked for (${assessment.notRequested.length})`}</StoryGroupHeading>
              <ul className="space-y-1.5 border-l-2 border-gray-200 pl-3 dark:border-gray-700">
                {assessment.notRequested.map((g, i) => (
                  <li key={i} className="text-xs">
                    <span className="break-words font-medium text-gray-800 dark:text-gray-200">{g.title}</span>
                    {g.path != null && g.path !== '' && (
                      <>
                        <span className={MUTED} aria-hidden="true">
                          {' · '}
                        </span>
                        <CodeAnchorRef
                          path={g.path}
                          line={g.line}
                          side="RIGHT"
                          inChangeset={changedPaths.has(g.path)}
                          onOpenInChanges={onOpenInChanges}
                        />
                      </>
                    )}
                    {g.explanation != null && g.explanation !== '' && (
                      <p className="whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{g.explanation}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
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
    <ReviewSection
      title="Previous review"
      pills={
        <>
          <span className={`font-mono text-xs ${MUTED}`} title={followUp.priorHeadSha}>
            {followUp.priorHeadSha.slice(0, 7)}
          </span>
          {FOLLOW_UP_PILL_ORDER.map((st) => {
            const n = followUp.items.filter((it) => it.status === st).length;
            return n > 0 ? (
              <span key={st} className={`${CHIP} ${FOLLOW_UP_STATUS_CLASS[st]}`}>
                {n} {FOLLOW_UP_STATUS_LABEL[st].toLowerCase()}
              </span>
            ) : null;
          })}
        </>
      }
    >
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
    </ReviewSection>
  );
}
