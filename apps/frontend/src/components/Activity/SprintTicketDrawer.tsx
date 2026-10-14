import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  SPRINT_REPOS_PER_TICKET_MAX,
  SPRINT_STAGE_LABEL,
  type SprintReferenceRelation,
  type SprintRepoRef,
  type SprintTicketDetailResponse,
  type SprintTicketReference,
  type TimelinePr,
} from '@pierre-review/shared';
import { useSprintReposSaving, useSprintSetRepos, useSprintTicket } from '../../hooks/useSprintStories.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useTicketReviewStates } from '../../hooks/useTicketReview.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import type { CardTicket } from '../../lib/cardTickets.js';
import { initialsOf } from '../../lib/openPrsStacks.js';
import { useOpenTicketTab } from '../../lib/ticketTab.js';
import { indexUsers, safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { ChevronIcon, CloseIcon, ExternalLinkIcon, TicketIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { TicketPrsSections } from '../Ticket/TicketPrsSections.js';
import { CARD_CHIP, CARD_NEUTRAL_CHIP } from './PrCardShell.js';
import { SprintAssessment, type SprintAssessTicket } from './SprintAssessment.js';
import { SprintCodeCheck } from './SprintCodeCheck.js';
import { StackStoryCheck } from './StackStoryCheck.js';
import { drawerReferenceGroups, referenceQuote, referenceWhy } from './sprintReferences.js';
import { repoPickerOptions } from './sprintModel.js';

// THIS SPRINT'S DRAWER — one ticket of the sprint graph, opened from its node (or from a reference /
// a ticket key in an answer). It slides in from the right OVER the graph, NON-MODAL: no scrim and no
// focus trap, so the graph beside it stays live (pan, zoom, click another ticket to switch) and zooms
// its ticket into the strip beside the drawer. Escape or the close button closes it; focus returns to
// the node.
//
// It is built from the Open PRs pieces, so a ticket reads the same here as in its stack:
//   • the header: key, title, status pill, assignee, epic, the tracker link and "Open ticket tab";
//   • the STORY CHECK block: the brief's summary and its criteria, numbered (the Story check's criteria
//     look) — "Worked out from the description" when the ticket has none of its own — and, where the
//     ticket has a ticket review, the Open PRs `StackStoryCheck` (per-criterion delivery);
//   • the OTHER TICKETS it names or links, right after the story check (dependencies matter): one card
//     each — key + title (in the graph → this drawer moves to it; else its ticket tab), status, an
//     assignee pill, then the brief's one-sentence REASON for the tie and, smaller, the ticket's own
//     words when they add to it (sprintReferences.ts);
//   • EVERY pull request as the Open PRs cards (`TicketPrsSections`, the ticket tab's fold);
//   • sprint tickets only: the repos and "Check against code" (plan / verify).
//
// Nothing fetches until the drawer is open (`useSprintTicket` only runs for an open ident).

const MUTED = 'text-gray-500 dark:text-gray-400';
/** Criteria listed before "Show all" (real stories itemise up to ~35). */
const CRITERIA_SHOWN = 10;

const STATUS_PILL: Record<'new' | 'indeterminate' | 'done', string> = {
  new: 'bg-gray-500/10 text-gray-700 dark:text-gray-300',
  indeterminate: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  done: 'bg-green-500/15 text-green-700 dark:text-green-400',
};

export function SprintTicketDrawer({
  workspaceId,
  ident,
  repos,
  onClose,
  onOpenTicket,
}: {
  workspaceId: number;
  ident: string;
  /** The workspace's repos (the picker's options). */
  repos: SprintRepoRef[];
  onClose: () => void;
  /** Move the drawer to another node of the graph. */
  onOpenTicket: (ident: string) => void;
}): JSX.Element {
  const { data, isLoading, isError } = useSprintTicket(workspaceId, ident);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  // Focus the close button on open (and when the drawer moves to another ticket).
  useEffect(() => {
    closeRef.current?.focus();
  }, [ident]);

  // NON-MODAL: the graph beside the drawer stays live (pan, zoom, click another ticket to switch), so
  // there is no scrim and no focus trap. Escape closes it from anywhere on the page — unless something
  // else (a menu, the graph) already handled that key.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // PORTALED to <body>: rendered in place it inherited its parent's `space-y-*` top margin, a strip of
  // page showing above the drawer. The scrim is light — the graph beside the drawer stays readable.
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-50" data-testid="sprint-drawer">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        className="sprint-drawer-in pointer-events-auto absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-gray-950"
      >
        <div className="flex items-start gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <div className="min-w-0 flex-1">
            <DrawerHeader data={data ?? null} ident={ident} titleId={titleId} />
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {isError ? (
            <p className="text-sm text-rose-700 dark:text-rose-400">Could not load this ticket.</p>
          ) : isLoading || data == null ? (
            <p className={`text-sm ${MUTED}`}>Loading…</p>
          ) : !data.found || data.ticket == null ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">This ticket is no longer in the sprint graph.</p>
          ) : (
            <DrawerBody key={data.ident} data={data} workspaceId={workspaceId} repos={repos} onOpenTicket={onOpenTicket} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DrawerHeader({
  data,
  ident,
  titleId,
}: {
  data: SprintTicketDetailResponse | null;
  ident: string;
  titleId: string;
}): JSX.Element {
  const openTicketTab = useOpenTicketTab();
  const t = data?.ticket ?? null;
  const key = t?.key ?? ident.slice(ident.lastIndexOf('#') + 1);
  const href = safeExternalUrl(t?.url ?? null);
  const cat = t?.status?.category ?? null;
  return (
    <div className="space-y-1.5">
      <h2 id={titleId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[13px] font-semibold text-gray-700 dark:text-gray-200">
          <TicketIcon size={13} className="shrink-0" />
          {key}
          <span className="sr-only">:</span>
        </span>
        {t != null && t.title !== '' && (
          <span className="min-w-0 break-words text-base font-semibold leading-snug text-gray-900 dark:text-gray-50">{t.title}</span>
        )}
      </h2>
      {t != null && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
          {t.status != null && cat != null && <span className={`${CARD_CHIP} border-transparent ${STATUS_PILL[cat]}`}>{t.status.name}</span>}
          {t.status != null && cat == null && <span className={CARD_NEUTRAL_CHIP}>{t.status.name}</span>}
          {t.stage != null && t.stage !== 'done' && t.status?.name !== SPRINT_STAGE_LABEL[t.stage] && (
            <span className={MUTED}>{SPRINT_STAGE_LABEL[t.stage]}</span>
          )}
          {t.ghost && <span className={CARD_NEUTRAL_CHIP}>Outside the sprint</span>}
          {t.issueType != null && <span className={`text-[11px] ${MUTED}`}>{t.issueType}</span>}
          {t.assignee != null ? (
            <span className="inline-flex items-center gap-1.5">
              <AssigneeAvatar name={t.assignee.name} url={t.assignee.avatarUrl} />
              <span>{t.assignee.name}</span>
            </span>
          ) : (
            <span className={MUTED}>Unassigned</span>
          )}
          {t.epic != null && (
            <span>
              Epic <span className="font-mono">{t.epic.key}</span>
              {t.epic.title != null && ` · ${t.epic.title}`}
            </span>
          )}
        </div>
      )}
      {t != null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {href != null && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sky-700 hover:underline dark:text-sky-300"
            >
              Open in tracker
              <ExternalLinkIcon size={11} aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            onClick={() => openTicketTab({ ident: t.ident, key: t.key, title: t.title !== '' ? t.title : null })}
            className="text-sky-700 hover:underline dark:text-sky-300"
          >
            Open ticket tab
          </button>
        </div>
      )}
    </div>
  );
}

function AssigneeAvatar({ name, url, small = false }: { name: string; url: string | null; small?: boolean }): JSX.Element {
  const safe = safeExternalUrl(url);
  const box = small ? 'h-4 w-4' : 'h-5 w-5';
  if (safe != null) {
    const px = small ? 16 : 20;
    return <img src={safe} alt="" width={px} height={px} referrerPolicy="no-referrer" className={`${box} shrink-0 rounded-full`} />;
  }
  return (
    <span
      aria-hidden
      className={`decorative-mark inline-flex ${box} shrink-0 items-center justify-center rounded-full bg-gray-200 ${small ? 'text-[9px]' : 'text-[10px]'} font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-100`}
    >
      {initialsOf(name)}
    </span>
  );
}

function DrawerBody({
  data,
  workspaceId,
  repos,
  onOpenTicket,
}: {
  data: SprintTicketDetailResponse;
  workspaceId: number;
  repos: SprintRepoRef[];
  onOpenTicket: (ident: string) => void;
}): JSX.Element {
  const t = data.ticket as NonNullable<SprintTicketDetailResponse['ticket']>;
  const ai = useAiCapabilities();
  const [allCriteria, setAllCriteria] = useState(false);
  const { data: users } = useUsers();
  const { data: repoList } = useRepos();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(() => new Map((repoList ?? []).map((r) => [r.id, r.fullName])), [repoList]);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openPr = (pr: TimelinePr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    openPrDetailTab(
      {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        repoFullName: repoNameById.get(pr.repoId) ?? '',
        authorLogin: u?.githubLogin ?? null,
        authorDisplayName: u?.displayName ?? null,
        authorAvatarUrl: u?.avatarUrl ?? null,
      },
      { fromActivity: true },
    );
  };

  const open = data.prs.open;
  const merged = data.prs.merged;
  const closed = data.prs.closed;
  const anyPr = open[0] ?? merged[0] ?? closed[0] ?? null;

  // The ticket review (per-criterion delivery): ONE states read for this ticket, only where agentic AI
  // runs and the ticket has a PR (a review needs one).
  const reviewOn = ai.enabled && anyPr != null;
  const { data: states } = useTicketReviewStates([t.ident], reviewOn);
  const reviewState = states?.states.find((s) => s.ident === t.ident);
  const cardTicket = useMemo<CardTicket>(
    () => ({ key: t.key, title: t.title !== '' ? t.title : null, url: t.url, ident: t.ident, provider: t.provider }),
    [t.key, t.title, t.url, t.ident, t.provider],
  );

  const assessTicket: SprintAssessTicket | null =
    data.repos != null
      ? {
          ident: t.ident,
          stage: t.stage,
          assessment: data.assessment,
          repos: { accepted: data.repos.accepted },
          criteria: data.brief?.criteria.map((c) => c.text) ?? [],
        }
      : null;

  return (
    <>
      <section aria-label="Story check" className="space-y-2" data-testid="sprint-drawer-brief">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          Story check
          <InfoButton title="Story check">
            <p>
              Claude Haiku reads the ticket and writes a short summary and its acceptance criteria, one sentence each. When
              the ticket lists no criteria of its own, they are worked out from the description.
            </p>
            <p>It reads the ticket again whenever its text changes.</p>
            <p>
              Where Claude has reviewed the ticket&rsquo;s pull requests together, the delivery check below says which
              criteria they meet.
            </p>
          </InfoButton>
        </h3>
        {data.briefState === 'current' && data.brief != null ? (
          <>
            {data.brief.summary !== '' && <p className="text-sm text-gray-800 dark:text-gray-100">{data.brief.summary}</p>}
            {data.brief.criteria.length > 0 ? (
              <>
                {data.brief.criteriaDerived && <p className={`text-xs ${MUTED}`}>Worked out from the description</p>}
                <ol className="space-y-1" aria-label="Acceptance criteria">
                  {(allCriteria ? data.brief.criteria : data.brief.criteria.slice(0, CRITERIA_SHOWN)).map((c) => (
                    <li key={c.n} className="flex items-baseline gap-2 px-1 text-[13px] text-gray-800 dark:text-gray-100">
                      <span className={`w-5 shrink-0 text-right font-mono text-xs ${MUTED}`}>{c.n}</span>
                      <span className="min-w-0 break-words">{c.text}</span>
                    </li>
                  ))}
                </ol>
                {data.brief.criteria.length > CRITERIA_SHOWN && (
                  <button
                    type="button"
                    aria-expanded={allCriteria}
                    onClick={() => setAllCriteria((v) => !v)}
                    className="px-1 text-xs text-sky-700 hover:underline dark:text-sky-300"
                  >
                    {allCriteria ? 'Show fewer' : `Show all ${data.brief.criteria.length} criteria`}
                  </button>
                )}
              </>
            ) : (
              <p className={`text-xs ${MUTED}`}>No acceptance criteria.</p>
            )}
          </>
        ) : data.briefState === 'pending' ? (
          <p className={`text-xs ${MUTED}`}>Reading this ticket…</p>
        ) : (
          <p className={`text-xs ${MUTED}`}>No summary here.</p>
        )}
        {reviewState?.latestRunId != null && anyPr != null && (
          <div className="-mx-3">
            <StackStoryCheck stackId={`sprint:${t.ident}`} ticket={cardTicket} state={reviewState} storyPrId={anyPr.id} />
          </div>
        )}
      </section>

      {/* Keyed per ticket: every ticket opens with the shut groups shut (nothing is remembered). */}
      {data.references.length > 0 && <References key={t.ident} refs={data.references} onOpenTicket={onOpenTicket} />}

      <section aria-label="Pull requests" className="space-y-3" data-testid="sprint-drawer-prs">
        {open.length + merged.length + closed.length === 0 ? (
          <>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Pull requests</h3>
            <p className={`text-xs ${MUTED}`}>
              {data.prs.outsideWorkspace > 0
                ? `None in this workspace. ${data.prs.outsideWorkspace} in other workspaces.`
                : 'No pull requests yet.'}
            </p>
          </>
        ) : (
          <TicketPrsSections open={open} merged={merged} closed={closed} onOpenPr={openPr} />
        )}
      </section>

      {data.repos != null && assessTicket != null && (
        <section aria-label="Check against code" className="space-y-2 border-t border-gray-200 pt-4 dark:border-gray-800">
          <ReposBlock ident={t.ident} workspaceId={workspaceId} repos={repos} ticketRepos={data.repos} />
          {(data.aiEnabled || data.assessment != null) && (
            <SprintAssessment ticket={assessTicket} workspaceId={workspaceId} aiEnabled={data.aiEnabled} />
          )}
          <SprintCodeCheck ticket={assessTicket} />
        </section>
      )}
    </>
  );
}

function References({
  refs,
  onOpenTicket,
}: {
  refs: readonly SprintTicketReference[];
  onOpenTicket: (ident: string) => void;
}): JSX.Element {
  const groups = drawerReferenceGroups(refs);
  return (
    <section aria-label="Other tickets" className="space-y-3" data-testid="sprint-drawer-refs">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
        Other tickets
        <span className={`text-xs font-normal ${MUTED}`}>{refs.length}</span>
        <InfoButton title="Other tickets">
          <p>Tickets this one names in its text, and the links set in the tracker.</p>
          <p>
            Each sentence is Claude Haiku&rsquo;s reading of why the two are tied, from this ticket&rsquo;s text and the
            other ticket&rsquo;s title. Where the text gives no reason, none is shown. The words in quotes are copied from
            the ticket.
          </p>
          <p>Blocked by and Related come from the tracker&rsquo;s links. The other groups come from the ticket text.</p>
        </InfoButton>
      </h3>
      {groups.map((g) =>
        COLLAPSED_REFERENCE_GROUPS.has(g.relation) ? (
          <CollapsedReferenceGroup key={g.relation} label={g.label} relation={g.relation}>
            {g.refs.map((r) => (
              <ReferenceCard key={r.ident} r={r} onOpenTicket={onOpenTicket} />
            ))}
          </CollapsedReferenceGroup>
        ) : (
          <div key={g.relation} className="space-y-1.5" data-testid={`sprint-drawer-refs-${g.relation}`}>
            <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              {g.label}
              <span className={`ml-1.5 font-normal ${MUTED}`}>{g.refs.length}</span>
            </h4>
            <ul className="space-y-1.5">
              {g.refs.map((r) => (
                <ReferenceCard key={r.ident} r={r} onOpenTicket={onOpenTicket} />
              ))}
            </ul>
          </div>
        ),
      )}
    </section>
  );
}

/** The loose ties start SHUT: "Out of scope" and "Builds on" are history and asides, not what the ticket
 *  waits on. Every other group is open. Nothing is remembered — each ticket opens this way. */
const COLLAPSED_REFERENCE_GROUPS: ReadonlySet<SprintReferenceRelation> = new Set<SprintReferenceRelation>(['out_of_scope', 'builds_on']);

function CollapsedReferenceGroup({
  label,
  relation,
  children,
}: {
  label: string;
  relation: SprintReferenceRelation;
  children: JSX.Element[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="space-y-1.5" data-testid={`sprint-drawer-refs-${relation}`}>
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <ChevronIcon dir={open ? 'down' : 'right'} size={12} aria-hidden="true" />
          {label}
          <span className={`ml-0.5 font-normal ${MUTED}`}>{children.length}</span>
        </button>
      </h4>
      <ul id={listId} hidden={!open} className="space-y-1.5">
        {open ? children : null}
      </ul>
    </div>
  );
}

function ReferenceCard({ r, onOpenTicket }: { r: SprintTicketReference; onOpenTicket: (ident: string) => void }): JSX.Element {
  const openTicketTab = useOpenTicketTab();
  const why = referenceWhy(r);
  const quote = referenceQuote(r);
  const done = r.done === true;
  return (
    <li
      className={`rounded-md border px-2.5 py-2 ${
        done ? 'border-gray-200 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-900/40' : 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-900'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => (r.inGraph ? onOpenTicket(r.ident) : openTicketTab({ ident: r.ident, key: r.key, title: r.title }))}
          className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 rounded text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <span
            className={`shrink-0 whitespace-nowrap font-mono text-xs font-semibold ${
              done ? 'text-gray-600 line-through dark:text-gray-400' : 'text-gray-800 dark:text-gray-100'
            }`}
          >
            {r.key}
          </span>
          {r.title != null && r.title !== '' && (
            <span className={`min-w-0 break-words text-[13px] ${done ? 'text-gray-600 dark:text-gray-400' : 'text-gray-900 dark:text-gray-50'}`}>
              {r.title}
            </span>
          )}
        </button>
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
          {r.status != null && (
            <span className={done ? `${CARD_CHIP} border-transparent ${STATUS_PILL.done}` : CARD_NEUTRAL_CHIP}>{r.status}</span>
          )}
          {r.assignee !== undefined &&
            (r.assignee != null ? (
              <span className={`${CARD_NEUTRAL_CHIP} pl-0.5`} data-testid="sprint-ref-assignee">
                <AssigneeAvatar name={r.assignee.name} url={r.assignee.avatarUrl} small />
                {r.assignee.name}
              </span>
            ) : (
              <span className={CARD_NEUTRAL_CHIP} data-testid="sprint-ref-assignee">
                Unassigned
              </span>
            ))}
        </span>
      </div>
      {why != null && <p className="mt-1 text-[13px] leading-snug text-gray-800 dark:text-gray-100">{why}</p>}
      {quote != null && <p className={`mt-0.5 text-xs italic ${MUTED}`}>&ldquo;{quote}&rdquo;</p>}
    </li>
  );
}

/** The repos "Check against code" reads: accepted chips + ONE "Add a repo…" picker, suggested ones tagged. */
function ReposBlock({
  ident,
  workspaceId,
  repos,
  ticketRepos,
}: {
  ident: string;
  workspaceId: number;
  repos: SprintRepoRef[];
  ticketRepos: NonNullable<SprintTicketDetailResponse['repos']>;
}): JSX.Element {
  const save = useSprintSetRepos(workspaceId, ident);
  const saving = useSprintReposSaving(ident);
  const accepted = ticketRepos.accepted;
  const acceptedIds = accepted.map((r) => r.repoId);
  const full = accepted.length >= SPRINT_REPOS_PER_TICKET_MAX;
  const set = (ids: number[]): void => save.mutate(ids);
  const options = repoPickerOptions(repos, accepted, ticketRepos.suggested);

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Repos</h4>
        {accepted.map((r) => (
          <span
            key={r.repoId}
            className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
          >
            {r.fullName}
            <button
              type="button"
              disabled={saving}
              onClick={() => set(acceptedIds.filter((id) => id !== r.repoId))}
              aria-label={`Remove ${r.fullName}`}
              className="hover:text-sky-950 disabled:opacity-50 dark:hover:text-white"
            >
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
        {!full && options.length > 0 && (
          <select
            value=""
            disabled={saving}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (Number.isInteger(id) && id > 0) set([...acceptedIds, id]);
            }}
            aria-label="Add a repo"
            className="max-w-full rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          >
            <option value="">Add a repo…</option>
            {options.map((o) => (
              <option key={o.repoId} value={o.repoId}>
                {o.text}
              </option>
            ))}
          </select>
        )}
      </div>
      {full && <p className={`text-xs ${MUTED}`}>Up to {SPRINT_REPOS_PER_TICKET_MAX} repos per ticket.</p>}
      {save.isError && <p className="text-xs text-rose-700 dark:text-rose-400">{save.error.message}</p>}
    </div>
  );
}
