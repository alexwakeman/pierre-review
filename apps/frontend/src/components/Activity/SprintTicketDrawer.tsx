import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  SPRINT_REPOS_PER_TICKET_MAX,
  SPRINT_STAGE_LABEL,
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
import { CloseIcon, ExternalLinkIcon, TicketIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { TicketPrsSections } from '../Ticket/TicketPrsSections.js';
import { CARD_CHIP, CARD_NEUTRAL_CHIP } from './PrCardShell.js';
import { SprintAssessment, type SprintAssessTicket } from './SprintAssessment.js';
import { SprintCodeCheck } from './SprintCodeCheck.js';
import { StackStoryCheck } from './StackStoryCheck.js';
import { groupReferences } from './sprintGraphModel.js';
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
//   • the references it names or links (in the graph → this drawer moves to it; else its ticket tab);
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

function AssigneeAvatar({ name, url }: { name: string; url: string | null }): JSX.Element {
  const safe = safeExternalUrl(url);
  if (safe != null) {
    return <img src={safe} alt="" width={20} height={20} referrerPolicy="no-referrer" className="h-5 w-5 shrink-0 rounded-full" />;
  }
  return (
    <span
      aria-hidden
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-100"
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

      {data.references.length > 0 && <References refs={data.references} onOpenTicket={onOpenTicket} />}

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
  const openTicketTab = useOpenTicketTab();
  const groups = groupReferences(refs);
  return (
    <section aria-label="Other tickets" className="space-y-1.5" data-testid="sprint-drawer-refs">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Other tickets</h3>
      <dl className="space-y-1.5">
        {groups.map((g) => (
          <div key={g.relation} className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <dt className={`w-24 shrink-0 pt-0.5 text-xs ${MUTED}`}>{g.label}</dt>
            <dd className="min-w-0 flex-1 space-y-1">
              {g.refs.map((r) => (
                <div key={r.ident} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => (r.inGraph ? onOpenTicket(r.ident) : openTicketTab({ ident: r.ident, key: r.key, title: r.title }))}
                    className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-left text-[11px] hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:border-gray-500 ${
                      r.done === true
                        ? 'border-gray-200 text-gray-500 dark:border-gray-800 dark:text-gray-400'
                        : 'border-gray-300 text-gray-800 dark:border-gray-700 dark:text-gray-100'
                    }`}
                  >
                    <span className={`shrink-0 whitespace-nowrap font-mono font-semibold ${r.done === true ? 'line-through' : ''}`}>{r.key}</span>
                    {r.title != null && r.title !== '' && <span className="min-w-0 truncate">{r.title}</span>}
                    {r.status != null && <span className="shrink-0 text-gray-500 dark:text-gray-400">· {r.status}</span>}
                    {r.assignee !== undefined && (
                      <span className="shrink-0 whitespace-nowrap text-gray-500 dark:text-gray-400">
                        · {r.assignee?.name ?? 'Unassigned'}
                      </span>
                    )}
                  </button>
                  {r.quote != null && r.quote !== '' && <p className={`mt-0.5 text-xs italic ${MUTED}`}>“{r.quote}”</p>}
                </div>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
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
