import { useMemo, useState } from 'react';
import { TICKET_ALIGNMENT_LABEL, type StoryRow } from '@pierre-review/shared';
import { useStories } from '../../hooks/useStories.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { PALETTE } from '../charts/common.js';
import { RepoRows } from '../charts/RepoRows.js';
import { ScatterChart } from '../charts/ScatterChart.js';
import { ChevronIcon, ExternalLinkIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { reportingWindowCaption, reportingWindowPhrase, windowDates } from './reportingWindowText.js';
import {
  buildSizeModel,
  buildTimeRows,
  formatWorkingTime,
  indexStories,
  reviewShortfallParts,
  rowsFor,
  storyMetaParts,
} from './storiesModel.js';

// Reports → "Stories" — how well the team's TICKETS were written.
//
//   • The two charts and every story, over the workspace's REPORTING WINDOW (GET /api/stories,
//     core), named by its own caption. (The agentic story report that used
//     to head this tab was removed 2026-10-18.)
//
// ⚠ THE WINDOW AND THE LISTS ARE THE SERVER'S. The response echoes the window (named through the
// shared reporting-window spelling) and orders `shortfall` / `unchecked` itself; nothing here
// re-ranks them.
// ⚠ EVERY EXPLANATION SITS BEHIND AN ⓘ — the page carries facts and labels, no caption paragraphs.
// ⚠ UNKNOWN IS NEVER ZERO: an unsized story is listed under the size chart, never plotted at 0.
// ⚠ A TICKET'S NAME IS THE LINK TO ITS STORY TAB (`useOpenStory` — the dedicated tab, never This
// Sprint's tray): in the "Time and pull requests" rows, in every "All n stories" row and in the
// lists under the size chart. No separate button. The small arrow beside a row's name opens the
// ticket in the tracker.

const MUTED = 'text-ui-mute';
const CARD = 'rounded-ui p-3 bg-ui-surface';

function StoriesInfo(): JSX.Element {
  return (
    <>
      <p>
        Every ticket with at least one pull request merged in this window. A ticket is linked to its
        pull requests by your issue tracker.
      </p>
      <p>
        <strong>Fell short</strong> lists tickets whose latest ticket review found criteria not met,
        partly met or missing. <strong>Not reviewed</strong> lists tickets with no ticket review.
      </p>
    </>
  );
}

function TimeChartInfo(): JSX.Element {
  return (
    <>
      <p>
        Working time runs from the first pull request opened to the last one merged, counted in this
        workspace&rsquo;s working hours. Pull requests counts every pull request on the ticket, open,
        merged or closed. Each column has its own scale.
      </p>
      <p>Select a ticket to open its story and pull requests in a tab.</p>
    </>
  );
}

/** A ticket's name — key and title, in full — as the link to its story tab (story + pull requests). */
function StoryLink({
  story,
  className = '',
}: {
  story: Pick<StoryRow, 'ident' | 'key' | 'title'>;
  className?: string;
}): JSX.Element {
  const openStory = useOpenStory();
  const title = (story.title ?? '').trim();
  return (
    <button
      type="button"
      onClick={() => openStory({ ident: story.ident, key: story.key, title: story.title })}
      title={`Open the ${story.key} story`}
      className={`break-words text-left hover:underline ${className}`}
    >
      <span className="font-medium text-ui-accent">{story.key}</span>
      {title !== '' && <span className="text-ui-ink"> {title}</span>}
    </button>
  );
}

function SizeChartInfo(): JSX.Element {
  return (
    <>
      <p>
        One mark per ticket: lines changed across its merged pull requests against how many
        acceptance criteria it has. Lines changed is on a log scale.
      </p>
      <p>
        The criteria count comes from the latest ticket review when there is one, else from the
        ticket&rsquo;s criteria field, else from bullets under an &ldquo;Acceptance criteria&rdquo;
        heading in the description.
      </p>
      <p>A ticket with a pull request of unknown size is listed under the chart, not drawn.</p>
    </>
  );
}

export function StoriesView(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isLoading, isError } = useStories(workspaceId);

  return (
    <div data-testid="stories-view" className="space-y-4">
      <StoriesBlock data={data} isLoading={isLoading} isError={isError} />
    </div>
  );
}

function StoriesBlock({
  data,
  isLoading,
  isError,
}: {
  data: ReturnType<typeof useStories>['data'];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const byIdent = useMemo(() => indexStories(data?.stories ?? []), [data]);
  const w = data?.window ?? null;

  const header = (
    <div className="flex flex-wrap items-baseline gap-2">
      <h3 className="flex items-center gap-1 text-body font-semibold text-ui-ink">
        {w != null ? `Stories — ${reportingWindowCaption(w)}` : 'Stories'}
        <InfoButton title="Stories">
          <StoriesInfo />
        </InfoButton>
      </h3>
      {w != null && data != null && data.trackerOn && (
        <span className={`text-meta ${MUTED}`}>
          {windowDates(w)} · {data.stories.length} {data.stories.length === 1 ? 'ticket' : 'tickets'}
        </span>
      )}
    </div>
  );

  if (isError) {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-body text-ui-danger">Could not load stories.</p>
      </div>
    );
  }
  if (isLoading || data == null) {
    return (
      <div className="space-y-3">
        {header}
        <p className={`text-body ${MUTED}`}>Loading…</p>
      </div>
    );
  }
  if (!data.trackerOn) {
    return (
      <div className="space-y-3">
        {header}
        <p className={`text-body ${MUTED}`}>
          Stories needs an issue tracker. Add one in Settings → Workspace → Issue tracker.
        </p>
      </div>
    );
  }
  if (data.stories.length === 0) {
    return (
      <div className="space-y-3">
        {header}
        <p className={`text-body ${MUTED}`}>
          No tickets with a pull request merged {w != null ? reportingWindowPhrase(w) : 'in this window'}.
        </p>
      </div>
    );
  }

  const shortfall = rowsFor(data.shortfall, byIdent);
  const unchecked = rowsFor(data.unchecked, byIdent);
  const listed = new Set([...data.shortfall, ...data.unchecked]);
  const met = data.stories.filter((s) => !listed.has(s.ident));

  return (
    <div className="space-y-4">
      {header}
      {data.truncated && (
        <p className="text-meta text-ui-warn">
          Showing the latest {data.stories.length} tickets in this window; earlier ones are not listed.
        </p>
      )}

      <TimeChart stories={data.stories} workingDayHours={data.workingDayHours} />
      <SizeChart stories={data.stories} shortfall={data.shortfall} />

      <div data-testid="stories-all">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-meta font-semibold text-ui-ink hover:underline"
        >
          <ChevronIcon dir={open ? 'down' : 'right'} size={10} />
          All {data.stories.length} {data.stories.length === 1 ? 'story' : 'stories'}
        </button>
        {/* The split, readable before opening: how many fell short and how many have no review. */}
        <span className={`ml-2 text-meta ${MUTED}`}>
          {shortfall.length} fell short · {unchecked.length} not reviewed
        </span>
        {open && (
          <div className="mt-2 space-y-4">
            <StoryList
              title="Fell short"
              testId="stories-shortfall"
              rows={shortfall}
              emptyLabel="No reviewed ticket fell short in this window."
              workingDayHours={data.workingDayHours}
            />
            <StoryList
              title="Not reviewed"
              testId="stories-unchecked"
              rows={unchecked}
              emptyLabel="Every ticket in this window has a ticket review."
              workingDayHours={data.workingDayHours}
            />
            {met.length > 0 && (
              <StoryList
                title="Reviewed, no gaps"
                testId="stories-met"
                rows={met}
                emptyLabel=""
                workingDayHours={data.workingDayHours}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Lists ────────────────────────────────────────────────────────────────────────────────────

function StoryList({
  title,
  testId,
  rows,
  emptyLabel,
  workingDayHours,
}: {
  title: string;
  testId: string;
  rows: StoryRow[];
  emptyLabel: string;
  workingDayHours: number;
}): JSX.Element {
  return (
    <section data-testid={testId} className="space-y-2">
      <h4 className="text-meta font-semibold text-ui-ink">
        {title} <span className={`font-normal tabular-nums ${MUTED}`}>{rows.length}</span>
      </h4>
      {rows.length === 0 ? (
        <p className={`text-meta ${MUTED}`}>{emptyLabel}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <StoryItem key={s.ident} story={s} workingDayHours={workingDayHours} />
          ))}
        </ul>
      )}
    </section>
  );
}

function StoryItem({ story, workingDayHours }: { story: StoryRow; workingDayHours: number }): JSX.Element {
  const href = safeExternalUrl(story.url);
  const shortParts = reviewShortfallParts(story);
  return (
    <li className={CARD} data-testid="story-row">
      <div className="flex items-start gap-1.5 text-body">
        <StoryLink story={story} />
        {href != null && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${story.key} in the tracker`}
            title="Open in the tracker"
            className={`mt-0.5 shrink-0 hover:text-ui-ink ${MUTED}`}
          >
            <ExternalLinkIcon size={12} />
          </a>
        )}
      </div>
      <div className={`mt-0.5 text-meta ${MUTED}`}>{storyMetaParts(story, workingDayHours).join(' · ')}</div>
      {story.review != null && (
        <div className="mt-0.5 text-meta text-ui-ink">
          {TICKET_ALIGNMENT_LABEL[story.review.alignment]}
          {shortParts.length > 0 && ` · ${shortParts.join(' · ')}`}
        </div>
      )}
    </li>
  );
}

// ── Charts ───────────────────────────────────────────────────────────────────────────────────

function TimeChart({ stories, workingDayHours }: { stories: StoryRow[]; workingDayHours: number }): JSX.Element {
  const m = buildTimeRows(stories);
  const byIdent = indexStories(stories);
  return (
    <section data-testid="stories-time-chart" className={CARD}>
      <h4 className="mb-2 flex items-center gap-1 text-meta font-semibold text-ui-ink">
        Time and pull requests
        <InfoButton title="Time and pull requests">
          <TimeChartInfo />
        </InfoButton>
      </h4>
      <RepoRows
        labels={m.labels}
        nameHeader="Ticket"
        nameWidthPct={36}
        labelFor={(i) => {
          const s = byIdent.get(m.idents[i] ?? '');
          return s == null ? (
            <span className="break-words text-ui-ink">{m.labels[i]}</span>
          ) : (
            <StoryLink story={s} />
          );
        }}
        columns={[
          {
            key: 'hours',
            header: 'Working time',
            segments: [{ key: 'hours', label: 'Working time', color: PALETTE.blue }],
            values: m.hours.map((h) => [h]),
            unknownLabel: 'not measured',
            format: (n) => formatWorkingTime(n, workingDayHours),
            axisFormat: (n) => formatWorkingTime(n, workingDayHours).replace(' working days', ' d').replace(' working day', ' d'),
            valueMode: 'total',
            valueSide: 'before',
            barWidthPct: 18,
            valueWidthPct: 14,
          },
          {
            key: 'prs',
            header: 'Pull requests',
            segments: [{ key: 'prs', label: 'Pull requests', color: PALETTE.teal }],
            values: m.prs.map((n) => [n]),
            unknownLabel: 'not measured',
            format: (n) => String(Math.round(n)),
            valueMode: 'total',
            valueSide: 'before',
            barWidthPct: 18,
            valueWidthPct: 14,
          },
        ]}
      />
      {m.more > 0 && <p className={`mt-1 text-meta ${MUTED}`}>{m.more} more not shown.</p>}
    </section>
  );
}

function SizeChart({ stories, shortfall }: { stories: StoryRow[]; shortfall: string[] }): JSX.Element {
  const m = buildSizeModel(stories, shortfall);
  const hasFlagged = m.points.some((p) => p.flagged);
  return (
    <section data-testid="stories-size-chart" className={CARD}>
      <h4 className="mb-2 flex items-center gap-1 text-meta font-semibold text-ui-ink">
        Size and criteria
        <InfoButton title="Size and criteria">
          <SizeChartInfo />
        </InfoButton>
      </h4>
      {m.points.length === 0 ? (
        <p className={`text-meta ${MUTED}`}>No ticket has both a known size and a criteria count.</p>
      ) : (
        <ScatterChart
          points={m.points}
          xLabel="lines changed"
          yLabel="criteria"
          yScale="linear"
          height={180}
          dotColor={PALETTE.blue}
          flaggedColor={PALETTE.amber}
          legend={[
            { label: 'Ticket', color: PALETTE.blue },
            ...(hasFlagged ? [{ label: 'Fell short', color: PALETTE.amber, shape: 'hollow-square' as const }] : []),
          ]}
        />
      )}
      {m.unsized.length > 0 && (
        <UnplottedList title="Size unknown" rows={m.unsized} detail={(s) => `${s.unsizedPrs} ${s.unsizedPrs === 1 ? 'pull request' : 'pull requests'} of unknown size`} />
      )}
      {m.noCriteria.length > 0 && <UnplottedList title="No criteria found" rows={m.noCriteria} />}
    </section>
  );
}

function UnplottedList({
  title,
  rows,
  detail,
}: {
  title: string;
  rows: StoryRow[];
  detail?: (s: StoryRow) => string;
}): JSX.Element {
  return (
    <div className="mt-2 text-meta">
      <div className="font-semibold text-ui-ink">
        {title} <span className={`font-normal ${MUTED}`}>{rows.length}</span>
      </div>
      <ul className="mt-0.5 space-y-0.5 text-ui-ink">
        {rows.map((s) => (
          <li key={s.ident} className="break-words">
            <StoryLink story={s} />
            {detail != null && <span className={MUTED}> · {detail(s)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
