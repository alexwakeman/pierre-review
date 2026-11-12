import { useEffect } from 'react';
import type { AiFixStatus } from '@pierre-review/shared';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import {
  aiFixSessionMutationKey,
  aiFixStartMutationKey,
  prefetchAiFixTab,
  useAiFixStream,
} from '../hooks/useAiFix.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useFilters, type AiFixRunEntry } from '../store/filters.js';
import { PHASE_LABEL, fixProgressPct, fixWaitingLine } from '../lib/aiFixProgress.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { HeaderToast, ToastList, ToastRow } from './HeaderToasts.js';
import { WrenchIcon } from './Icons.js';

// Where an agentic AI-Fix run is watched from once the reader has left the pane that started
// it — a paid agent run must never be running with no visible sign of it.
//
// A card in the ONE toast cluster (HeaderToasts.tsx) — never its own `fixed` element.
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
  // A plan pass ended: the plan waits for the reader in the AI Fix tab.
  'planned',
] as const);

function doneLine(status: AiFixStatus | 'idle'): string | null {
  switch (status) {
    case 'succeeded':
      return 'Fix ready';
    case 'failed':
      return 'The fix did not finish';
    case 'cancelled':
      return 'Cancelled';
    case 'idle':
      return 'The fix did not start';
    case 'planned':
      return 'Plan ready';
    default:
      return null;
  }
}

export function AiFixBanner(): JSX.Element | null {
  const enabled = useAiCapabilities().enabled;
  const runs = useFilters((s) => s.aiFixRuns);
  const dismissRun = useFilters((s) => s.dismissAiFixRun);

  // Oldest first: a run that has been going longest is the one whose finish is imminent, so it
  // is the one that keeps its stream when more than MAX_LIVE_STREAMS are open.
  const rows = Object.values(runs).sort((a, b) => a.startedAt - b.startedAt);
  // A finished fix's details are loaded as soon as the toast knows it is ready — here, not only in
  // the row, because the rows are mounted only while the cluster's panel is open.
  const qc = useQueryClient();
  const readyKey = enabled
    ? rows.filter((r) => r.status === 'succeeded' || r.status === 'planned').map((r) => r.prId).join(',')
    : '';
  useEffect(() => {
    for (const id of readyKey.split(',')) if (id !== '') prefetchAiFixTab(qc, Number(id));
  }, [readyKey, qc]);
  if (!enabled || rows.length === 0) return null;

  const running = rows.filter((r) => !TERMINAL.has(r.status));
  // ⚠ THE CAP COUNTS RUNNING ROWS, NOT LIST POSITION. A finished row holds no stream but keeps
  // its place until dismissed, so four undismissed results would otherwise starve the fifth —
  // a live run left with no stream and no way to clear the finished rows in front of it.
  const streaming = new Set(running.slice(0, MAX_LIVE_STREAMS).map((r) => r.prId));

  const finished = rows.length - running.length;
  return (
    <HeaderToast
      testId="ai-fix-toast"
      tone="ai"
      label="AI fixes"
      icon={<WrenchIcon size={13} className={running.length > 0 ? 'animate-pulse' : undefined} />}
      summary={
        running.length > 0
          ? `${running.length} running${finished > 0 ? `, ${finished} finished` : ''}`
          : `${finished} finished`
      }
      // Dismiss only once every run is over — a card you can clear mid-run is a card that loses
      // the only handle on a paid agent turn (the same rule the per-row "dismiss" keeps).
      onDismiss={
        running.length === 0 ? () => rows.forEach((r) => dismissRun(r.prId)) : undefined
      }
      dismissLabel="Dismiss AI fix results"
      count={running.length > 0 ? running.length : rows.length}
      alert={rows.some((r) => r.status === 'failed')}
    >
      <ToastList>
        {rows.map((r) => (
          <AiFixBannerRow key={r.prId} run={r} live={streaming.has(r.prId)} />
        ))}
      </ToastList>
    </HeaderToast>
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
  // The same holds for Start fix after Plan first, which notes this row before its POST under the SESSION
  // key: until approve answers, the row still reads 'planned', a terminal status here.
  const starting =
    useIsMutating({ mutationKey: aiFixStartMutationKey(run.prId) }) +
      useIsMutating({ mutationKey: aiFixSessionMutationKey(run.prId) }) >
    0;
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

  // A finished fix's details are loaded as soon as the row says so (and again on hover / press), so
  // opening it shows the result at once (`prefetchAiFixTab`).
  const qc = useQueryClient();
  const warm = (): void => prefetchAiFixTab(qc, run.prId);
  useEffect(() => {
    if (run.status === 'succeeded' || run.status === 'planned') prefetchAiFixTab(qc, run.prId);
  }, [run.status, run.prId, qc]);

  return (
    <ToastRow>
      <button
        type="button"
        onPointerEnter={warm}
        onFocus={warm}
        onPointerDown={warm}
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
        className="hit block w-full text-left"
        title="Open the AI Fix tab for this pull request"
      >
        <div className="flex items-center gap-1.5">
          {run.status === 'succeeded' ? (
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-ui-success" />
          ) : done ? (
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-ui-faint" />
          ) : (
            <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-ui-line border-t-ui-line" />
          )}
          <span className="truncate font-medium text-ui-ink hover:underline">
            {run.repoFullName} #{run.prNumber}
          </span>
        </div>
        <div className="mt-0.5 truncate text-ui-mute">
          {run.prTitle}
        </div>
      </button>
      {finished != null ? (
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-ui-mute">{finished}</span>
          {/* Dismiss only once the run is over — a row you can clear mid-run is a row that
              loses the only handle on a paid agent turn. */}
          <button
            type="button"
            onClick={() => dismiss(run.prId)}
            aria-label={`Dismiss the AI fix for ${run.repoFullName} #${run.prNumber}`}
            className="hit text-meta text-ui-mute hover:text-ui-ink"
          >
            Dismiss
          </button>
        </div>
      ) : starting ? (
        <div className="mt-1 text-meta text-ui-mute">Starting…</div>
      ) : status?.waiting != null ? (
        // THE FIX START QUEUE: every sandbox is busy; this fix starts by itself when one frees.
        <div data-testid="ai-fix-toast-waiting" className="mt-1 text-meta text-ui-mute">
          {fixWaitingLine(status.waiting)}
        </div>
      ) : live ? (
        <div className="mt-1">
          <RegenProgressBar
            active
            label="Running AI fix"
            value={fixProgressPct(status)}
            timeConstantSec={40}
          />
          <div className="mt-1 text-meta text-ui-mute">
            {PHASE_LABEL[status?.progress?.phase ?? ''] ?? 'Working…'}
          </div>
        </div>
      ) : (
        // ⚠ PAST THE STREAM CAP, AND IT MAY NOT SAY "Queued". The run is going; it is the
        // WATCHING that is capped, and naming the run's state after our own connection budget
        // is a false claim about a paid agent turn the reader started. No bar either — a bar
        // that never moves is worse than no bar.
        <div className="mt-1 text-meta text-ui-mute">
          Running. Progress not shown.
        </div>
      )}
    </ToastRow>
  );
}
