// The Claude Review tab's follow-up and user-story pieces, kept out of the 2,000-line tab:
//
//   ClaudeReviewTicketPanel     — the story input of the Story check section (TicketCoverage.tsx):
//                                 pasted stories + the Jira picker, one tab per story.
//   ClaudeReviewTicketResults   — HISTORY: how an older PR review measured up against ONE user
//                                 story (read-only; its unmet items are findings). Shown INSIDE the
//                                 Story check section (TicketCoverage.tsx), and only for a story no
//                                 ticket review covers. New PR reviews carry no story.
//   ClaudeReviewFollowUpSection — what became of the previous review's comments.
//
// Rules for all three:
//  - Every string from Claude or from a pasted user story renders as PLAIN TEXT: no Markdown,
//    and no href built from it — except a story's SUMMARY (markdown, so its bullets read as a list,
//    through the sanitizing <Markdown>), and PR references ("api#12"), which become in-app buttons
//    via <PrRefText> (ReviewPrRefs.tsx) when they name a known PR. A story READ FROM JIRA is the one exception, and it renders in
//    ClaudeReviewTickets.tsx (JiraStoryView), never here. A code anchor is a <button> into the Changes tab when the file is
//    in the PR, otherwise plain mono text.
//  - Statuses and counts come from the server's reconcile step, which never invents "addressed".
//    The sentences are templated in `@pierre-review/shared` (code-derived); Claude's explanations
//    are shown separately, unlabelled (everything here is Claude's).
//  - Chips are 11px or larger, sentences 12px or larger, no uppercase-with-tracking labels, and
//    every muted colour is paired for both themes (`textContrast.test.ts`).
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
  browserAcMemory,
  fillableJiraTickets,
  unfillableJiraTickets,
  jiraFillNote,
  jiraSiteOf,
  legacyAcFieldToMigrate,
} from '../lib/jiraTicket.js';
import {
  acFieldText,
  addStoryTab,
  autoPullKeys,
  clampTab,
  createStoryPullMemory,
  jiraKeysToPull,
  jiraStoryFromDetails,
  mergePulledStories,
  pullJiraTickets,
  pullNote,
  pulledAcField,
  removeStoryTab,
  storiesOnClose,
  storiesOnOpen,
  storyTabLabel,
} from '../lib/storyTabs.js';
import {
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
import { CheckIcon, ChevronIcon, CloseIcon, PlusIcon, RefreshIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';
import { JiraStoryView } from './ClaudeReviewTickets.js';
import { ReviewSection } from './ReviewSection.js';
import { PrRefText } from './ReviewPrRefs.js';
import { Markdown } from './Markdown.js';
import { REVIEW_CHIP, REVIEW_ITEM_CARD, REVIEW_ITEM_TITLE, REVIEW_PROSE, REVIEW_SUBHEAD } from '../lib/reviewStyles.js';

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

const CHIP = REVIEW_CHIP;
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

/** One typed or pasted story: three editable fields (its tab carries the name and the remove). */
function ManualStoryFields({
  value,
  onChange,
  errorFor,
}: {
  value: TicketDraft;
  onChange: (next: TicketDraft) => void;
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
    <div className="space-y-2">
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

// A ticket this session fetched, kept for its candidates so the field picker needs no refetch to
// open.
export interface FetchedJira {
  details: JiraTicketDetails;
  site: string | null;
  chosen: string;
}

/** The label a story goes by in a run's results: its Jira key, else "Story N". */
export function storyLabel(d: { key?: string | null }, index: number): string {
  return d.key != null && d.key !== '' ? d.key : `Story ${index + 1}`;
}

// The automatic pull's session memory (per PR): which detected-key set it already acted on, and
// which keys the reader removed — so it runs once and never re-adds a removed story.
const storyPullMemory = createStoryPullMemory();
// A pulled ticket is the STORED row the plugin's worker wrote when the PR was received — reading it
// makes no Jira call. It is reused from the query cache for this long (a remount, a tab switch,
// "Pull all" after "Clear all"); Refresh and a field change read Jira again, server-side.
const JIRA_TICKET_STALE_MS = 60_000;

const TAB_ICON_BTN =
  'rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100';
const PRIMARY_BTN =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-300 dark:hover:bg-blue-900/30';
const LINK_BTN = 'text-xs text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300';
const SPINNER =
  'inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-gray-600 dark:border-t-blue-400';

/**
 * The optional user stories — up to CLAUDE_REVIEW_MAX_TICKETS, ONE TAB EACH (`lib/storyTabs.ts`).
 * A tab pulled from Jira is READ-ONLY (markdown, ClaudeReviewTickets.tsx) with the field its
 * criteria came from and Refresh; a typed one is three editable fields. Jira tickets detected on the
 * PR are pulled AUTOMATICALLY once per PR per detected-key set (never re-adding one the reader
 * removed); "Pull all from Jira" is the manual action. The Story check section passes
 * `autoPullReady={false}`: the detected tickets are its blocks already, so it pulls only on request.
 * CLOSED it is a plain "+ Add story" link (no disclosure box), which reveals the tabs with a blank
 * story ready; Close hides them again and drops blank tabs. Either way the row says what Check
 * sends ("2 stories" / "needs a fix"). NO `maxLength` on any input — it would silently cut a paste.
 */
export function ClaudeReviewTicketPanel({
  value,
  onChange,
  check,
  prId,
  tickets,
  prWorkspaceName,
  autoPullReady,
}: {
  value: TicketDraft[];
  onChange: (next: TicketDraft[]) => void;
  check: ClaudeReviewTicketsCheck;
  prId: number;
  tickets: readonly TicketRef[] | null | undefined;
  // The workspace that OWNS this PR's repo — the one whose Jira token is used. null = unknown.
  prWorkspaceName?: string | null;
  // The stored run has loaded, so the list is settled: the automatic pull waits for it, or the
  // prefill from the latest run would land on top of (or under) what it pulled.
  autoPullReady: boolean;
}): JSX.Element {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const tabsId = useId();
  const [selectedRaw, setSelected] = useState(0);
  const selected = clampTab(selectedRaw, value.length);
  const [fetched, setFetchedState] = useState<Record<string, FetchedJira>>({});
  const fetchedRef = useRef(fetched);
  const setFetched = (next: Record<string, FetchedJira>): void => {
    fetchedRef.current = next;
    setFetchedState(next);
  };
  const [pulling, setPulling] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [fieldEditing, setFieldEditing] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The list as it is when an answer lands, not when a button was pressed.
  const latest = useRef(value);
  latest.current = value;
  // An answer that lands after the panel unmounted (the reader opened another PR) is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fillable = useMemo(() => fillableJiraTickets(tickets), [tickets]);
  const unfillable = unfillableJiraTickets(tickets);
  const busy = pulling.length > 0;
  const hint = ticketsPanelHint(value, check);
  const full = value.length >= CLAUDE_REVIEW_MAX_TICKETS;
  const pullable = jiraKeysToPull(fillable, value).keys;

  const refFor = (key: string): TicketRef | null => fillable.find((t) => t.key === key) ?? null;
  // The ONE way the panel reads a STORED ticket: through the query cache, so a remount or "Pull
  // all" after "Clear all" reuses the answer.
  const ticketKey = (key: string) => ['jira-ticket', prId, key] as const;
  const fetchTicket = (key: string): Promise<JiraTicketDetails> =>
    qc.fetchQuery({
      queryKey: ticketKey(key),
      queryFn: () => api.jiraTicket(prId, key),
      staleTime: JIRA_TICKET_STALE_MS,
    });
  // A stored ticket, with an old per-browser criteria-field choice moved to the server ONCE.
  const readStored = async (key: string, url: string): Promise<JiraTicketDetails> => {
    const details = await fetchTicket(key);
    const legacy = legacyAcFieldToMigrate(browserAcMemory(), url, details);
    if (legacy == null) return details;
    try {
      const moved = await api.setJiraAcField(prId, key, legacy);
      qc.setQueryData(ticketKey(key), moved);
      return moved;
    } catch {
      return details;
    }
  };

  const pull = async (keys: string[], auto: boolean): Promise<void> => {
    if (keys.length === 0) return;
    setPulling(keys);
    setNote(null);
    const res = await pullJiraTickets(keys, (k) => readStored(k, refFor(k)?.url ?? ''));
    if (!alive.current) {
      // Dropped: let the next mount of this PR try again.
      if (auto) storyPullMemory.clearAutoPull(prId);
      return;
    }
    const stories: TicketDraft[] = [];
    const nextFetched = { ...fetchedRef.current };
    for (const { key, details } of res.ok) {
      const ref = refFor(key);
      if (ref == null) continue;
      const site = jiraSiteOf(ref.url);
      const chosen = pulledAcField(details);
      stories.push(jiraStoryFromDetails(ref, details, chosen));
      nextFetched[key] = { details, site, chosen };
    }
    const merged = mergePulledStories(latest.current, stories);
    if (merged.added.length + merged.refreshed.length > 0) onChange(merged.drafts);
    if (merged.selected != null) setSelected(merged.selected);
    setFetched(nextFetched);
    setNote(pullNote(res.failed, merged.overCap));
    setPulling([]);
  };

  // Rebuild ONE ticket's tab from what `load` answers (a server-side re-read, or a field change),
  // with the field the server picked — or `override` ('' = "None of these", this tab only).
  const refetchOne = async (
    key: string,
    load: () => Promise<JiraTicketDetails>,
    override?: string,
  ): Promise<JiraTicketDetails | null> => {
    const ref = refFor(key);
    if (ref == null) return null;
    setPulling([key]);
    setNote(null);
    try {
      const details = await load();
      qc.setQueryData(ticketKey(key), details);
      if (!alive.current) return details;
      const site = jiraSiteOf(ref.url);
      const chosen = override ?? pulledAcField(details);
      const story = jiraStoryFromDetails(ref, details, chosen);
      const cur = latest.current;
      const at = cur.findIndex((d) => isJiraDraft(d) && d.key === key);
      if (at >= 0) onChange(cur.map((d, j) => (j === at ? story : d)));
      setFetched({ ...fetchedRef.current, [key]: { details, site, chosen } });
      return details;
    } catch (e) {
      if (alive.current) setNote(pullNote([{ key, message: e instanceof Error ? e.message : String(e) }], []));
      return null;
    } finally {
      if (alive.current) setPulling([]);
    }
  };

  // The OTHER tabs of the same issue type: the field choice is per issue type, so their criteria
  // moved too. Re-read their stored rows (no Jira call) and rebuild them.
  const refreshSameType = async (key: string, issueTypeId: string | null | undefined): Promise<void> => {
    if (issueTypeId == null) return;
    const others = latest.current.filter(
      (d) => isJiraDraft(d) && d.key != null && d.key !== key && d.issueTypeId === issueTypeId,
    );
    for (const d of others) {
      const k = d.key as string;
      const ref = refFor(k);
      if (ref == null) continue;
      try {
        await qc.invalidateQueries({ queryKey: ticketKey(k) });
        const details = await fetchTicket(k);
        if (!alive.current) return;
        const story = jiraStoryFromDetails(ref, details, pulledAcField(details));
        const cur = latest.current;
        const at = cur.findIndex((x) => isJiraDraft(x) && x.key === k);
        if (at >= 0) onChange(cur.map((x, j) => (j === at ? story : x)));
        setFetched({ ...fetchedRef.current, [k]: { details, site: jiraSiteOf(ref.url), chosen: pulledAcField(details) } });
      } catch {
        /* that tab keeps what it had; its own Refresh is there */
      }
    }
  };

  // Refresh: Jira is read again NOW, server-side (the worker's path), and the stored row answered.
  const refresh = (d: TicketDraft): void => {
    const key = d.key;
    if (key == null) return;
    void refetchOne(key, () => api.refreshJiraTicket(prId, key));
  };
  // A field picked by hand: saved for this ticket's ISSUE TYPE in the PR's workspace, so the worker,
  // the auto review and every other ticket of the type use it. "None of these" ('') is this tab only.
  const changeField = (key: string, id: string): void => {
    setFieldEditing(null);
    if (id === '') {
      const cached = fetchedRef.current[key]?.details;
      if (cached != null) void refetchOne(key, async () => cached, '');
      return;
    }
    void refetchOne(key, () => api.setJiraAcField(prId, key, id)).then((details) =>
      refreshSameType(key, details?.issueType?.id),
    );
  };
  // Back to the default: the workspace's choice for the issue type is cleared; the name match decides.
  const resetField = (d: TicketDraft): void => {
    const key = d.key;
    if (key == null) return;
    setFieldEditing(null);
    void refetchOne(key, () => api.setJiraAcField(prId, key, null)).then((details) =>
      refreshSameType(key, details?.issueType?.id),
    );
  };
  // "Change": open the picker, reading the ticket's fields first when this session has not.
  const openFieldPicker = async (d: TicketDraft): Promise<void> => {
    const key = d.key;
    if (key == null) return;
    if (fieldEditing === key) {
      setFieldEditing(null);
      return;
    }
    setFieldEditing(key);
    if (fetchedRef.current[key] != null) return;
    const ref = refFor(key);
    if (ref == null) return;
    try {
      const details = await fetchTicket(key);
      if (!alive.current) return;
      setFetched({
        ...fetchedRef.current,
        [key]: { details, site: jiraSiteOf(ref.url), chosen: d.acField?.id ?? '' },
      });
    } catch (e) {
      if (alive.current) {
        setFieldEditing(null);
        setNote(pullNote([{ key, message: e instanceof Error ? e.message : String(e) }], []));
      }
    }
  };

  // A removed Jira story: never auto-pulled again this session. (The criteria-field choice is the
  // workspace's, per issue type — removing one story does not clear it; "Reset to default" does.)
  const forgetJira = (ds: readonly TicketDraft[]): void => {
    const keys = ds.filter(isJiraDraft).map((d) => d.key).filter((k): k is string => k != null);
    if (keys.length === 0) return;
    storyPullMemory.noteRemoved(prId, keys);
    const next = { ...fetchedRef.current };
    for (const k of keys) delete next[k];
    setFetched(next);
    if (fieldEditing != null && keys.includes(fieldEditing)) setFieldEditing(null);
  };
  const removeAt = (i: number): void => {
    const d = latest.current[i];
    if (d == null) return;
    forgetJira([d]);
    const r = removeStoryTab(latest.current, i, selected);
    onChange(r.drafts);
    setSelected(r.selected);
    // Keep the keyboard on the strip: the tab that took this one's place.
    requestAnimationFrame(() => tabRefs.current[r.selected]?.focus());
  };
  const clearAll = (): void => {
    const n = latest.current.length;
    if (n === 0) return;
    if (!window.confirm(`Remove ${n === 1 ? 'the story' : `all ${n} stories`} from this review?`)) return;
    forgetJira(latest.current);
    onChange([]);
    setSelected(0);
    setNote(null);
  };
  const addStory = (): void => {
    const r = addStoryTab(latest.current);
    if (r == null) return;
    onChange(r.drafts);
    setSelected(r.selected);
    setOpen(true);
  };
  const pullKeys = (keys: string[]): void => {
    storyPullMemory.unremove(prId, keys);
    setOpen(true);
    void pull(keys, false);
  };
  const replaceAt = (i: number, d: TicketDraft): void =>
    onChange(latest.current.map((x, j) => (j === i ? d : x)));
  const errorAt =
    (i: number) =>
    (f: ClaudeReviewTicketField): string | null =>
      !check.ok && check.index === i && check.field === f ? check.message : null;

  // THE AUTOMATIC PULL: once the stored run has loaded, pull every detected ticket not yet a tab
  // and not removed by the reader — once per PR per detected-key set (`storyPullMemory`), with no
  // retry: a failure is one line, and "Pull all" is there.
  useEffect(() => {
    if (!autoPullReady || pulling.length > 0) return;
    const detected = fillable.map((t) => t.key);
    if (!storyPullMemory.shouldAutoPull(prId, detected)) return;
    const keys = autoPullKeys(storyPullMemory, prId, fillable, latest.current);
    storyPullMemory.noteAutoPull(prId, detected);
    if (keys.length === 0) return;
    setOpen(true);
    void pull(keys, true);
    // `pull` reads everything else through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPullReady, prId, fillable]);

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const n = value.length;
    let to: number | null = null;
    if (e.key === 'ArrowRight') to = (i + 1) % n;
    else if (e.key === 'ArrowLeft') to = (i - 1 + n) % n;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    else if (e.key === 'Delete') {
      e.preventDefault();
      removeAt(i);
      return;
    }
    if (to == null) return;
    e.preventDefault();
    setSelected(to);
    tabRefs.current[to]?.focus();
  };

  const current = value[selected];
  const pullLabel = pullable.length === 1 ? `Pull ${pullable[0]} from Jira` : `Pull all from Jira (${pullable.length})`;

  // "+ Add story": reveal the tabs, with a blank story when there is none yet.
  const reveal = (): void => {
    const next = storiesOnOpen(latest.current);
    if (next !== latest.current) {
      onChange(next);
      setSelected(next.length - 1);
    }
    setOpen(true);
  };
  // Close: hide the tabs; blank typed tabs go, stories with content stay for next time.
  const close = (): void => {
    const next = storiesOnClose(latest.current);
    if (next !== latest.current) {
      onChange(next);
      setSelected(clampTab(selected, next.length));
    }
    setFieldEditing(null);
    setOpen(false);
  };
  const hintText = hint.replace(/^ · /, '');
  const pullButton =
    pullable.length > 0 && !busy ? (
      <button type="button" onClick={() => pullKeys(pullable)} className={PRIMARY_BTN}>
        {pullLabel}
      </button>
    ) : null;
  const info = (
    <InfoButton title="Add a story">
      <p>
        Paste a story to check this pull request against it, or pull a Jira ticket named on the pull
        request to read its story and pick the field its criteria come from. Up to{' '}
        {CLAUDE_REVIEW_MAX_TICKETS} at a time.
      </p>
      <p className="mt-2">A pulled ticket is shown as Limn last read it from Jira. Refresh reads it again.</p>
    </InfoButton>
  );

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={reveal}
          className={`inline-flex items-center gap-1 ${LINK_BTN}`}
        >
          <PlusIcon size={11} />
          Add story
        </button>
        {hintText !== '' && <span className={`text-xs ${check.ok ? MUTED : ERROR_TEXT}`}>{hintText}</span>}
        {busy && <span className={`text-xs ${MUTED}`}>Pulling from Jira…</span>}
        {pullButton}
        {info}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded border border-gray-200 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">Stories to check</span>
        {hintText !== '' && <span className={`text-xs ${check.ok ? MUTED : ERROR_TEXT}`}>{hintText}</span>}
        {pullButton}
        {info}
        <button
          type="button"
          onClick={close}
          className={`ml-auto inline-flex items-center gap-1 text-xs ${MUTED} hover:text-gray-800 hover:underline dark:hover:text-gray-100`}
        >
          <CloseIcon size={10} />
          Close
        </button>
      </div>
      {open && (
        <div className="border-t border-gray-200 px-2 pb-2 pt-1.5 dark:border-gray-800">
          {pullable.length > 1 && !busy && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1">
              <span className={`text-xs ${MUTED}`}>Or pull one:</span>
              {pullable.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => pullKeys([k])}
                  aria-label={`Pull ${k} from Jira`}
                  className={`${BTN} font-mono`}
                >
                  {k}
                </button>
              ))}
            </div>
          )}
          {fillable.length === 0 && unfillable.length > 0 && (
            <p className={`mb-1.5 text-xs ${MUTED}`}>
              To pull {unfillable.map((t) => t.key).join(', ')}, add a Jira API token in Settings for the{' '}
              {prWorkspaceName != null ? `${prWorkspaceName} workspace` : 'workspace this repository is in'}.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-x-1 gap-y-1 border-b border-gray-200 dark:border-gray-800">
            <div role="tablist" aria-label="User stories" className="flex min-w-0 flex-wrap items-end gap-1">
              {value.map((d, i) => {
                const label = storyTabLabel(value, i);
                const active = i === selected;
                const bad = !check.ok && check.index === i;
                const jira = isJiraDraft(d) && d.key != null;
                return (
                  <div
                    key={jira ? `jira-${d.key}` : `typed-${i}`}
                    role="presentation"
                    className={`-mb-px flex items-center rounded-t border ${
                      active
                        ? 'border-gray-200 border-b-white bg-white dark:border-gray-800 dark:border-b-gray-950 dark:bg-gray-950'
                        : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-900'
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={`${tabsId}-tab-${i}`}
                      ref={(el) => {
                        tabRefs.current[i] = el;
                      }}
                      aria-selected={active}
                      aria-controls={`${tabsId}-panel`}
                      tabIndex={active ? 0 : -1}
                      onClick={() => setSelected(i)}
                      onKeyDown={(e) => onTabKeyDown(e, i)}
                      className={`py-1 pl-2 pr-1 text-xs font-medium ${jira ? 'font-mono' : ''} ${
                        bad ? ERROR_TEXT : active ? 'text-gray-900 dark:text-gray-100' : MUTED
                      }`}
                    >
                      {label}
                      {bad && <span className="sr-only"> (needs a fix)</span>}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAt(i)}
                      aria-label={`Remove ${label}`}
                      title={`Remove ${label}`}
                      tabIndex={active ? 0 : -1}
                      className={`mr-1 ${TAB_ICON_BTN}`}
                    >
                      <CloseIcon size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
            {busy && (
              <span role="status" className={`flex items-center gap-1.5 px-2 py-1 text-xs ${MUTED}`}>
                <span className={SPINNER} aria-hidden="true" />
                Pulling {pulling.join(', ')}…
              </span>
            )}
            {!full && (
              <button
                type="button"
                onClick={addStory}
                className="flex items-center gap-1 px-2 py-1 text-xs text-blue-700 hover:underline dark:text-blue-300"
              >
                <PlusIcon size={11} />
                Add story
              </button>
            )}
            {value.length > 1 && (
              <button type="button" onClick={clearAll} className={`ml-auto px-1 py-1 text-xs ${MUTED} hover:underline`}>
                Clear all
              </button>
            )}
          </div>
          {note != null && <p className={`mt-1.5 text-xs ${ERROR_TEXT}`}>{note}</p>}
          {!check.ok && check.index !== selected && (
            <p className={`mt-1.5 text-xs ${ERROR_TEXT}`}>{check.message}</p>
          )}
          {current != null && (
            <div
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-tab-${selected}`}
              tabIndex={0}
              className="pt-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {isJiraDraft(current) ? (
                <JiraStoryView
                  draft={current}
                  actions={
                    current.key != null && refFor(current.key) != null ? (
                      <button type="button" onClick={() => refresh(current)} disabled={busy} className={`${BTN} inline-flex items-center gap-1`}>
                        <RefreshIcon size={11} className={busy && pulling.includes(current.key) ? 'animate-spin' : undefined} />
                        Refresh
                      </button>
                    ) : undefined
                  }
                  fieldControl={
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className={MUTED}>Criteria from:</span>
                        <span className="font-medium text-gray-800 dark:text-gray-200">{acFieldText(current)}</span>
                        {current.key != null && refFor(current.key) != null && (
                          <button
                            type="button"
                            onClick={() => void openFieldPicker(current)}
                            disabled={busy}
                            aria-expanded={fieldEditing === current.key}
                            className={LINK_BTN}
                          >
                            Change
                          </button>
                        )}
                      </div>
                      {fieldEditing != null && fieldEditing === current.key && (
                        fetched[current.key] != null ? (
                          <div className="rounded border border-gray-200 p-2 dark:border-gray-800">
                            <AcFieldPicker
                              fetched={fetched[current.key]!}
                              onChoose={(id) => changeField(current.key as string, id)}
                            />
                            <button type="button" onClick={() => resetField(current)} disabled={busy} className={`mt-1.5 ${BTN}`}>
                              Reset to default
                            </button>
                          </div>
                        ) : (
                          <p className={`text-xs ${MUTED}`}>Reading {current.key}…</p>
                        )
                      )}
                    </div>
                  }
                />
              ) : (
                <ManualStoryFields
                  key={`typed-${selected}`}
                  value={current}
                  onChange={(next) => replaceAt(selected, next)}
                  errorFor={errorAt(selected)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Take the criteria from" — every custom text field on the fetched ticket. `allowNone` offers
 * "None of these" (the story panel's one-tab override); the Story check's disclosure saves the
 * workspace's choice, so it does not.
 */
export function AcFieldPicker({
  fetched,
  onChoose,
  allowNone = true,
  disabled = false,
}: {
  fetched: FetchedJira;
  onChoose: (id: string) => void;
  allowNone?: boolean;
  disabled?: boolean;
}): JSX.Element | null {
  const selectId = useId();
  const { details, chosen } = fetched;
  const note = jiraFillNote(details, chosen);
  if (details.candidates.length === 0) {
    return note != null ? <p className={`text-xs ${MUTED}`}>{note}</p> : null;
  }
  return (
    <div>
      <label htmlFor={selectId} className="text-xs font-medium text-gray-700 dark:text-gray-200">
        Take the criteria from
        {details.issueType != null && (
          <span className={`font-normal ${MUTED}`}> ({details.issueType.name})</span>
        )}
      </label>
      <select
        id={selectId}
        value={chosen}
        disabled={disabled}
        onChange={(e) => onChoose(e.target.value)}
        className={INPUT}
      >
        {(allowNone || chosen === '') && <option value="">None of these</option>}
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
      <li className="flex items-baseline gap-2 px-1 text-[13px]">
        <span className="shrink-0 self-center text-green-700 dark:text-green-400" aria-label="Met">
          <CheckIcon size={12} />
        </span>
        <span className={`shrink-0 font-mono text-xs ${MUTED}`}>{c.ref}</span>
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
    <li className={REVIEW_ITEM_CARD}>
      <div className="flex items-start gap-2">
        <span className={`${CHIP} ${TICKET_CRITERION_STATUS_CLASS[c.status]}`}>
          {TICKET_CRITERION_STATUS_LABEL[c.status]}
        </span>
        <span className={`shrink-0 font-mono text-xs leading-5 ${MUTED}`}>{c.ref}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold">{c.text}</span>
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
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={c.explanation} />
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
    <li className={REVIEW_ITEM_CARD}>
      <div className={`whitespace-pre-wrap break-words ${REVIEW_ITEM_TITLE}`}>
        <PrRefText text={g.title} />
      </div>
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
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={g.explanation} />
        </p>
      )}
    </li>
  );
}

// A sub-group heading inside one story ("Not done (1)").
function StoryGroupHeading({ children }: { children: string }): JSX.Element {
  return <h5 className={REVIEW_SUBHEAD}>{children}</h5>;
}

/**
 * How the run measured up against ONE user story, inside the Story check section. ⚠ LIKE FOR
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
  aside,
  below,
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
  // Story check: the muted provenance label + Check, at the end of the header row.
  aside?: ReactNode;
  // Story check: the "Story" disclosure, under the header.
  below?: ReactNode;
}): JSX.Element {
  const { ticket, assessment } = entry;
  const sentence = ticketCriteriaSentence(assessment);
  const cardFor = (id: number | null): ClaudeFinding | null => (id != null ? (findingsById.get(id) ?? null) : null);
  const rowProps = { changedPaths, onOpenInChanges };
  return (
    <div aria-label={`Story ${label ?? ticket.title ?? ''}`} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {label != null && (
            <span
              className={`text-sm font-semibold text-gray-900 dark:text-gray-100 ${ticket.key != null ? 'font-mono' : ''}`}
            >
              {label}
            </span>
          )}
          {ticket.title != null && ticket.title !== '' && (
            <span className="min-w-0 break-words text-sm font-semibold text-gray-900 dark:text-gray-100">
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
        {aside}
      </div>
      {below}
      {assessment == null ? (
        <p className={`text-xs ${MUTED}`}>Not checked in this run.</p>
      ) : (
        <>
          {assessment.summary != null && assessment.summary !== '' && (
            <Markdown prRefs>{assessment.summary}</Markdown>
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
              <ul className="space-y-1.5">
                {assessment.notRequested.map((g, i) => (
                  <li key={i} className={REVIEW_ITEM_CARD}>
                    <span className={`break-words ${REVIEW_ITEM_TITLE}`}>
                      <PrRefText text={g.title} />
                    </span>
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
                      <p className={`mt-1 ${REVIEW_PROSE}`}>
                        <PrRefText text={g.explanation} />
                      </p>
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
      : 'border-gray-100 dark:border-gray-800';
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
          className={`min-w-0 break-words ${muted ? 'text-gray-600 dark:text-gray-400' : REVIEW_ITEM_TITLE}`}
        >
          <PrRefText text={item.title} />
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
        <p className={`mt-1 ${REVIEW_PROSE}`}>
          <PrRefText text={item.explanation} />
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
