import { useEffect } from 'react';
import type { AiFixStatus } from '@pierre-review/shared';
import { useIsMutating } from '@tanstack/react-query';
import { aiFixStartMutationKey, useAiFixStream } from '../hooks/useAiFix.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useFilters, type AiFixRunEntry } from '../store/filters.js';
import { PHASE_LABEL, fixProgressPct } from '../lib/aiFixProgress.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';

// Where an agentic AI-Fix run is watched from once the reader has left the pane that started
// it. It is the missing half of the CI-analysis card's "Fix it" shortcut: before this, a fix
// started from the Overview tab produced a paid agent run and no visible sign of it, which is
// why that mount used to hide the button.
//
// A plain card for App.tsx's ONE bottom-right column — never its own `fixed bottom-4 right-4`.
//
// ⚠ NO CHIME AND NO BROWSER NOTIFICATION, deliberately, and unlike ClaudeReviewBanner. A CI fix
// is started from a pane the reader is looking at, seconds earlier, by their own click; the
// run is minutes long, not tens of minutes, and the row is already on screen. An OS-level
// interruption for something you just asked for and can already see is noise.
//
// ⚠ SEEDED ONLY BY A START THIS SESSION PERFORMED (see AiFixRunEntry). There is no
// account-scoped active-fixes route and we are not adding one, so a reload drops the row while
// the run carries on — the AI Fix tab is where a run is recovered.

// Each row holds its own SSE connection, so the count is capped. Four is the number of
// simultaneous fixes a person plausibly watches; beyond it the rows still exist and still
// resolve when clicked, they just say so in words with no bar rather than each holding a socket.
const MAX_LIVE_STREAMS = 4;

// A row in one of these states has stopped, keeps its place until dismissed, and holds no
// stream. ⚠ `idle` is in here: the server reports it when the PR has no fix run at all, which
// after the start POST has settled means the start did not take (a 409, a 402, a network
// error). Leaving it out left such a row spinning forever with no stream behind it and no way
// to clear it.
const TERMINAL: ReadonlySet<AiFixStatus | 'idle'> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'idle',
] as const);

function doneLine(status: AiFixStatus | 'idle'): string | null {
  switch (status) {
    case 'succeeded':
      return 'Fix ready — click to view';
    case 'failed':
      return 'The fix did not finish';
    case 'cancelled':
      return 'Cancelled';
    case 'idle':
      return 'The fix did not start';
    default:
      return null;
  }
}

export function AiFixBanner(): JSX.Element | null {
  const enabled = useProCapabilities().aiFix;
  const runs = useFilters((s) => s.aiFixRuns);

  // Oldest first: a run that has been going longest is the one whose finish is imminent, so it
  // is the one that keeps its stream when more than MAX_LIVE_STREAMS are open.
  const rows = Object.values(runs).sort((a, b) => a.startedAt - b.startedAt);
  if (!enabled || rows.length === 0) return null;

  const running = rows.filter((r) => !TERMINAL.has(r.status));
  // ⚠ THE CAP COUNTS RUNNING ROWS, NOT LIST POSITION. A finished row holds no stream but keeps
  // its place until dismissed, so four undismissed results would otherwise starve the fifth —
  // a live run left with no stream and no way to clear the finished rows in front of it.
  const streaming = new Set(running.slice(0, MAX_LIVE_STREAMS).map((r) => r.prId));

  return (
    <div className="pointer-events-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
        <span className="text-xs font-semibold">
          AI fixes
          {running.length > 0 && (
            <span className="ml-1 font-normal text-gray-400">
              · {running.length} running
            </span>
          )}
        </span>
      </div>
      <ul className="max-h-64 divide-y divide-gray-100 overflow-auto dark:divide-gray-800">
        {rows.map((r) => (
          <AiFixBannerRow key={r.prId} run={r} live={streaming.has(r.prId)} />
        ))}
      </ul>
    </div>
  );
}

function AiFixBannerRow({
  run,
  live,
}: {
  run: AiFixRunEntry;
  live: boolean;
}): JSX.Element {
  const openAiFix = useFilters((s) => s.openAiFix);
  const setStatus = useFilters((s) => s.setAiFixRunStatus);
  const dismiss = useFilters((s) => s.dismissAiFixRun);

  const done = TERMINAL.has(run.status);
  // ⚠ NOT WHILE THE START POST IS STILL IN FLIGHT. The row is registered BEFORE the POST (so it
  // survives the reader navigating away in the same breath), and the fix row does not exist
  // until the POST returns — a stream opened in that gap gets an `idle` snapshot and closes,
  // which reads as "the fix did not start" about a fix that is about to.
  const starting = useIsMutating({ mutationKey: aiFixStartMutationKey(run.prId) }) > 0;
  // The AI Fix tab may be streaming the same PR at the same time. That is fine — the manager
  // fans out to every subscriber — and de-duplicating the two subscriptions is out of scope;
  // the 4-stream cap is what bounds the connection count.
  const { status } = useAiFixStream(run.prId, live && !done && !starting);

  // The stream is the only thing that ever moves a row off 'queued'. Written in an EFFECT, not
  // in render: a store write during render is a write to a component other than this one, and
  // `setAiFixRunStatus` is a no-op on an unchanged status so the effect settles immediately.
  const streamStatus = status?.status ?? null;
  useEffect(() => {
    if (streamStatus != null) setStatus(run.prId, streamStatus);
  }, [streamStatus, run.prId, setStatus]);

  const finished = doneLine(run.status);

  return (
    <li className="px-3 py-2 text-xs">
      <button
        type="button"
        onClick={() =>
          openAiFix({
            id: run.prId,
            number: run.prNumber,
            title: run.prTitle,
            repoFullName: run.repoFullName,
            authorLogin: null,
            authorDisplayName: null,
            authorAvatarUrl: null,
          })
        }
        className="block w-full text-left"
        title="Open the AI Fix tab for this pull request"
      >
        <div className="flex items-center gap-1.5">
          {run.status === 'succeeded' ? (
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500" />
          ) : done ? (
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-gray-400" />
          ) : (
            <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
          )}
          <span className="truncate font-medium text-blue-600 hover:underline dark:text-blue-400">
            {run.repoFullName} #{run.prNumber}
          </span>
        </div>
        <div className="mt-0.5 truncate text-gray-500 dark:text-gray-400">
          {run.prTitle}
        </div>
      </button>
      {finished != null ? (
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-gray-500 dark:text-gray-400">{finished}</span>
          {/* Dismiss only once the run is over — a row you can clear mid-run is a row that
              loses the only handle on a paid agent turn. */}
          <button
            type="button"
            onClick={() => dismiss(run.prId)}
            className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            dismiss
          </button>
        </div>
      ) : starting ? (
        <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Starting…</div>
      ) : live ? (
        <div className="mt-1">
          <RegenProgressBar
            active
            label="Running AI fix"
            value={fixProgressPct(status)}
            timeConstantSec={40}
          />
          <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            {PHASE_LABEL[status?.progress?.phase ?? ''] ?? 'Working…'}
          </div>
        </div>
      ) : (
        // ⚠ PAST THE STREAM CAP, AND IT MAY NOT SAY "Queued". The run is going; it is the
        // WATCHING that is capped, and naming the run's state after our own connection budget
        // is a false claim about a paid agent turn the reader started. No bar either — a bar
        // that never moves is worse than no bar.
        <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          Running. Progress not shown.
        </div>
      )}
    </li>
  );
}
