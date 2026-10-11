import {
  SPRINT_PROVIDER_LABEL,
  SPRINT_TICKETS_MAX,
  sprintSourceTitle,
  type SprintSource,
  type SprintStoriesResponse,
} from '@pierre-review/shared';
import { useState } from 'react';
import { useSprintRefresh, useSprintRefreshing, useSprintStories } from '../../hooks/useSprintStories.js';
import { formatDate } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { GearIcon, RefreshIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { changedCheckCount, sprintSections, statusOrderSourceLabel } from './sprintModel.js';
import { SprintChecksPanel } from './SprintChecksPanel.js';
import { SprintTicketCard } from './SprintTicketCard.js';

// Reports → "This sprint" — the tracker's CURRENT sprint, one card per open ticket.
//
//   • THE LIST is read by the tracker worker (GET /api/sprint-stories reads stored rows; opening the
//     tab is what lets the worker read this workspace's sprint at all). "Refresh" asks for a read now.
//   • SECTIONS follow the workspace's status layout (`statusLayout`): Not started, then "Writing code"
//     (one section per status before the code-delivered status), then "Code delivered" (one per status
//     from it on). Done is counted, never listed. Settings → Statuses changes the order and the split.
//   • A CARD carries at most two issue chips (Unclear when done, Blocked — `STORY_CHIP_ISSUE_IDS`) and
//     expands to: the detail per issue (which criteria and why, what it waits on and who owns it), the
//     Spec gaps section (never a chip), candidate repos, "Check against code" (agentic, local-only) and the update panel.
//   • NOTHING IS WRITTEN TO A TRACKER without the per-ticket confirm dialog (SprintUpdatePanel).
//
// ⚠ THE ORDER IS THE SERVER'S — stage, status section, then most issues first (chips only). Never by assignee,
// and there is no team or person score here.
// ⚠ EVERY EXPLANATION SITS BEHIND AN ⓘ — the page carries facts and labels.
// ⚠ GENERATED TEXT IS SELECTABLE and every generated block has a Copy button (lib/copy.ts).

const MUTED = 'text-gray-500 dark:text-gray-400';

function sourceInfo(s: SprintSource | null): string {
  if (s == null) return 'The list appears after the first read of your tracker.';
  switch (s.kind) {
    case 'sprint':
      return 'Tickets in the open Jira sprint for the projects this workspace’s tickets belong to.';
    case 'cycle':
      return 'Issues in the active Linear cycle of the teams this workspace’s tickets belong to.';
    case 'milestone':
      return `Open issues in the GitHub milestone due soonest${s.dueOn != null ? ` (due ${formatDate(s.dueOn)})` : ''}${
        s.repos.length > 0 ? `, across ${s.repos.join(', ')}` : ''
      }.`;
    case 'status_fallback':
      return `${
        s.reason === 'none_active'
          ? `No ${SPRINT_PROVIDER_LABEL[s.provider]} sprint is active right now`
          : `${SPRINT_PROVIDER_LABEL[s.provider]} has no sprint here to read`
      }, so this lists To do and In progress tickets updated between ${formatDate(s.from)} and ${formatDate(s.to)}.`;
  }
}

function SprintInfo({ data }: { data: SprintStoriesResponse }): JSX.Element {
  const layout = data.statusLayout;
  return (
    <>
      <p>{sourceInfo(data.source)}</p>
      <p>The list is read again every 20 minutes while this tab is in use. Refresh reads it now.</p>
      <p>Each ticket shows up to two issues:</p>
      <ul className="list-disc space-y-0.5 pl-5">
        <li>
          <strong>Unclear when done</strong>: no acceptance criteria, or criteria a tester couldn&rsquo;t check, each with
          the reason.
        </li>
        <li>
          <strong>Blocked</strong>: unfinished work it waits on: tickets linked in your tracker, and work the ticket names.
        </li>
      </ul>
      <p>
        Opening a ticket also lists its <strong>spec gaps</strong>: details a developer would have to ask about.
      </p>
      <p>
        &ldquo;No criteria&rdquo; and tracker links are found in code. The rest come from Claude reading the ticket, once it
        has read the current text.
      </p>
      <p>
        &ldquo;Check against code&rdquo; has Claude read the repos you chose for a ticket. Its sentence for an issue
        replaces ours and is marked Claude, until the ticket or the code changes.
      </p>
      {layout != null && (
        <p>
          Sections follow {statusOrderSourceLabel(layout.orderSource, { inSentence: true })}
          {layout.deliveredFrom != null ? `; code counts as delivered from ${layout.deliveredFrom}` : ''}. Done tickets are
          counted, not listed.
        </p>
      )}
      <p>Settings chooses which issues this workspace raises, and the order of statuses.</p>
      <p>Nothing is written to your tracker until you confirm the exact text on one ticket.</p>
    </>
  );
}

export function SprintView(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isLoading, isError } = useSprintStories(workspaceId);
  const refresh = useSprintRefresh(workspaceId);
  const refreshing = useSprintRefreshing(workspaceId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (isError) {
    return <p className="text-sm text-rose-700 dark:text-rose-400">Could not load this sprint.</p>;
  }
  if (isLoading || data == null) {
    return <p className={`text-xs ${MUTED}`}>Loading…</p>;
  }
  if (!data.trackerOn) {
    return (
      <div data-testid="sprint-view" className={`rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm dark:border-gray-700 ${MUTED}`}>
        No issue tracker is connected to this workspace.
      </div>
    );
  }

  const groups = sprintSections(data.tickets, data.statusLayout);
  const reading = data.read.readAt == null && data.read.error == null;
  const facts: string[] = [];
  if (!reading) {
    facts.push(`${data.tickets.length} open ${data.tickets.length === 1 ? 'ticket' : 'tickets'}`);
    facts.push(`${data.doneCount} done`);
  }
  const changed = changedCheckCount(data.checks);
  if (changed > 0) facts.push(`${changed} ${changed === 1 ? 'check' : 'checks'} changed`);

  return (
    <div data-testid="sprint-view" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-800 dark:text-gray-100">
          {data.source != null ? sprintSourceTitle(data.source) : 'This sprint'}
          <InfoButton title="This sprint">
            <SprintInfo data={data} />
          </InfoButton>
        </h3>
        {facts.length > 0 && <span className={`text-xs ${MUTED}`}>{facts.join(' · ')}</span>}
        {reading && <span className={`text-xs ${MUTED}`}>Reading…</span>}
        <button
          type="button"
          onClick={() => setSettingsOpen((o) => !o)}
          aria-expanded={settingsOpen}
          className="ml-auto inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
        >
          <GearIcon size={12} />
          Settings
        </button>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refreshing}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
        >
          <RefreshIcon size={12} className={refreshing ? 'animate-spin' : undefined} />
          Refresh
        </button>
      </div>

      {settingsOpen && (
        <SprintChecksPanel
          workspaceId={data.workspaceId}
          checks={data.checks}
          issueTypes={data.issueTypes}
          layout={data.statusLayout}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {data.read.error != null && <p className="text-xs text-rose-700 dark:text-rose-400">{data.read.error}</p>}
      {refresh.isError && (
        <p className="text-xs text-rose-700 dark:text-rose-400">{refresh.error.message}</p>
      )}
      {data.read.truncated && (
        <p className={`text-xs ${MUTED}`}>Showing the first {SPRINT_TICKETS_MAX} tickets.</p>
      )}

      {!reading && groups.length === 0 && (
        <p className={`text-sm ${MUTED}`}>No open tickets in this sprint.</p>
      )}

      {groups.map((g) => (
        <section key={g.stage} className="space-y-3" data-testid={`sprint-group-${g.stage}`}>
          <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {g.heading}{' '}
            <span className={`font-normal ${MUTED}`}>· {g.sections.reduce((n, sec) => n + sec.tickets.length, 0)}</span>
          </h4>
          {g.sections.map((sec) => (
            <div key={sec.status ?? '-'} className="space-y-2" data-testid="sprint-section">
              {g.stage !== 'not_started' && (
                <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                  {sec.status ?? 'No status'} <span className={`font-normal ${MUTED}`}>· {sec.tickets.length}</span>
                </h5>
              )}
              <ul className="space-y-2">
                {sec.tickets.map((t) => (
                  <li key={t.ident}>
                    <SprintTicketCard
                      ticket={t}
                      workspaceId={data.workspaceId}
                      aiEnabled={data.aiEnabled}
                      repos={data.repos}
                      checks={data.checks}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
