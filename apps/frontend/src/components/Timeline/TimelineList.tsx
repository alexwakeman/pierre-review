import { useEffect, useMemo, useRef } from 'react';
import type { TimelinePr, User } from '@pierre-review/shared';
import { useRepos, useTimeline, useUsers } from '../../hooks/useTimeline.js';
import { indexUsers, userLabel } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { useTimelineLayout } from '../../store/timelineLayout.js';
import { CloseIcon, MergeIcon, PullRequestIcon, RequestChangesIcon, TimerIcon, TimelineIcon, WarningIcon, CheckCircleIcon } from '../Icons.js';
import { List, ListGroup, Row, RowLead, RowMeta, RowTitle, rowDomId } from '../ui/List.js';
import { StatusIcon, type StatusTone } from '../ui/StatusIcon.js';
import { timelineListModel } from './listModel.js';

// THE TIMELINE ON A PHONE, AS A LIST (the redesign; docs/redesign/DESIGN.md § 6 — "a usable phone
// layout or a clear list fallback, without losing data"). A time-axis canvas at 390px is mostly label
// gutter, so a phone opens the Timeline as ONE LINE PER PULL REQUEST the board would draw a bar for
// (`timelineListModel` — the board's own payload and its two client-side narrowings, Members and
// Threads), grouped by repository, most recently active first: state · #number title · author ·
// events in the window · last activity. Tapping a row SELECTS the PR exactly as a bar click does
// (`selectPr` → `?pr=`), which opens its detail — full screen on a phone (App.tsx).
//
// Nothing is lost: the BOARD is one tap away (the FilterBar's Board / List switch, ⌘K "Timeline: show
// the board"; store/timelineLayout.ts), and the markers' detail (each event) is in the PR's own
// Activity. j/k still move the selection (the app's global keys), and the list follows it.
//
// Reads ONLY the cached board query (`useTimeline()` — the same key the mounted board holds), so it
// adds no request of its own.

const LIST_ID = 'timeline-list';

/** "now", "5m", "3h", "2d", "4w" — the row's age column (the full time is the row's title). */
function shortAge(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  const min = 60_000;
  if (d < min) return 'now';
  if (d < 60 * min) return `${Math.round(d / min)}m`;
  if (d < 24 * 60 * min) return `${Math.round(d / (60 * min))}h`;
  if (d < 14 * 24 * 60 * min) return `${Math.round(d / (24 * 60 * min))}d`;
  return `${Math.round(d / (7 * 24 * 60 * min))}w`;
}

/** A PR's one status, by the colour rule: red only when something BLOCKS, green only when it can land. */
function prStatus(pr: TimelinePr): { tone: StatusTone; icon: JSX.Element; label: string } {
  if (pr.state === 'merged') return { tone: 'quiet', icon: <MergeIcon size={13} />, label: 'Merged' };
  if (pr.state === 'closed') return { tone: 'quiet', icon: <CloseIcon size={13} />, label: 'Closed' };
  if (pr.ciStatus === 'failure' || pr.ciStatus === 'error') return { tone: 'blocked', icon: <WarningIcon size={13} />, label: 'CI failing' };
  if (pr.mergeable === 'conflicting') return { tone: 'blocked', icon: <WarningIcon size={13} />, label: 'Conflicts' };
  if (pr.isChangesRequested) return { tone: 'blocked', icon: <RequestChangesIcon size={13} />, label: 'Changes requested' };
  if (pr.isDraft) return { tone: 'quiet', icon: <PullRequestIcon size={13} />, label: 'Draft' };
  if (pr.isStalled) return { tone: 'neutral', icon: <TimerIcon size={13} />, label: 'Stalled' };
  if (pr.isApproved) return { tone: 'ready', icon: <CheckCircleIcon size={13} />, label: 'Approved' };
  return { tone: 'neutral', icon: <PullRequestIcon size={13} />, label: 'Open' };
}

export function TimelineList(): JSX.Element {
  const { data, isLoading, error } = useTimeline();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  const userIds = useFilters((s) => s.userIds);
  const derivedStates = useFilters((s) => s.derivedStates);
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const selectPr = useFilters((s) => s.selectPr);
  const setLayout = useTimelineLayout((s) => s.setPhone);
  const listRef = useRef<HTMLUListElement>(null);

  const usersById = useMemo(() => indexUsers(users), [users]);
  const reposById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r])), [repos]);
  const groups = useMemo(
    () =>
      data == null
        ? []
        : timelineListModel({ prs: data.prs, events: data.events, repos: reposById, userIds, derivedStates, selectedPrId }),
    [data, reposById, userIds, derivedStates, selectedPrId],
  );
  // One flat index across the groups (the list's rows are numbered in reading order).
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const selectedIndex = selectedPrId == null ? null : flat.findIndex((r) => r.pr.id === selectedPrId);
  const sel = selectedIndex != null && selectedIndex >= 0 ? selectedIndex : null;

  // j/k (the app's global keys) move the selection: keep the selected row on screen.
  useEffect(() => {
    if (sel == null) return;
    document.getElementById(rowDomId(LIST_ID, sel))?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const now = Date.now();
  let index = 0;

  return (
    <div data-testid="timeline-list" className="absolute inset-0 z-10 overflow-y-auto bg-ui-bg px-2 pb-6">
      {error != null ? (
        <p className="px-3 py-6 text-body text-ui-danger">Could not load the timeline.</p>
      ) : isLoading || data == null ? (
        <div aria-hidden className="space-y-1 px-1 pt-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-row-touch animate-pulse rounded-ui bg-ui-surface motion-reduce:animate-none" />
          ))}
        </div>
      ) : (
        <List
          id={LIST_ID}
          label="Pull requests on the timeline"
          selected={sel}
          listRef={listRef}
          empty={groups.length > 0 ? undefined : (
            <span className="block text-body text-ui-mute">
              No activity in this window. Add a repo or widen the date range.
            </span>
          )}
        >
          {groups.map((g) => (
            <ListGroup key={g.repoId} label={g.name} hint={<span className="tabular-nums">{g.rows.length}</span>}>
              {g.rows.map((r) => {
                const i = index++;
                const st = prStatus(r.pr);
                const author: User | undefined = r.pr.authorId != null ? usersById.get(r.pr.authorId) : undefined;
                const who = userLabel(author, r.pr.authorId);
                const when = new Date(r.lastAt).toLocaleString();
                return (
                  <Row
                    key={r.pr.id}
                    listId={LIST_ID}
                    index={i}
                    selected={sel === i}
                    onSelect={() => selectPr(r.pr.id)}
                    title={`#${r.pr.number} ${r.pr.title} — ${st.label}, by ${who}, ${r.events} ${r.events === 1 ? 'event' : 'events'} in this window, last ${when}`}
                  >
                    <RowLead>
                      <StatusIcon tone={st.tone} icon={st.icon} label={st.label} iconOnly />
                    </RowLead>
                    <RowTitle sub={st.tone === 'quiet' || st.label === 'Stalled' ? st.label : undefined}>
                      <span className="tabular-nums text-ui-faint">#{r.pr.number}</span> {r.pr.title}
                    </RowTitle>
                    <RowMeta hideBelow="sm" width={110}>
                      {who}
                    </RowMeta>
                    <RowMeta hideBelow="sm" width={64} className="text-right">
                      {r.events} {r.events === 1 ? 'event' : 'events'}
                    </RowMeta>
                    <RowMeta width={32} className="text-right">
                      {shortAge(r.lastAt, now)}
                    </RowMeta>
                  </Row>
                );
              })}
            </ListGroup>
          ))}
        </List>
      )}
      <p className="flex items-center gap-1.5 px-3 pt-4 text-meta text-ui-faint">
        <TimelineIcon size={12} />
        Each row is a bar on the board.
        <button type="button" onClick={() => setLayout('board')} className="rounded-ui px-1 font-medium text-ui-mute underline-offset-2 hover:text-ui-ink hover:underline touch:min-h-10">
          Show the board
        </button>
      </p>
    </div>
  );
}
