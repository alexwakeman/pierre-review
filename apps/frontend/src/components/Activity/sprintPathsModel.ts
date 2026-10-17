import {
  sprintDayOf,
  sprintPathsFailureText,
  type SprintDates,
  type SprintPaths,
  type SprintPathsStatus,
} from '@pierre-review/shared';

// THE CRITICAL PATH VIEW'S STATE (Activity/SprintBoards.tsx; test/sprintPathsModel.test.ts). What the
// view says about the stored paths is decided here, once, from `SprintGraphResponse.pathsStatus` (the
// server's ONE fold):
//   • 'off'     — AI is off: one plain line saying so; the pace strip and the count table still show.
//   • 'paths'   — paths to show. `note` is the one quiet line beside them when they are not current:
//                 'updating' (being written now / next in line), or the failure sentence. STALE paths
//                 always beat a blank board.
//   • 'message' — no paths yet: one short line ('writing' while the builder runs — the page bar runs
//                 with it — else when they will be written, or why they could not be).
//   • 'none'    — nothing to say (too few tickets, no tracker, no credential).
// Also here: the page's progress bar (`sprintProgress`) and the header's dates line.

export type SprintPathsNote = { kind: 'updating' } | { kind: 'failed'; text: string } | null;

export type SprintPathsView =
  | { kind: 'off' }
  | { kind: 'none' }
  | { kind: 'paths'; paths: SprintPaths; note: SprintPathsNote }
  | { kind: 'message'; writing: boolean; text: string };

/** The failure line: the reason, then when it is tried again. */
export function pathsFailureLine(status: SprintPathsStatus): string {
  const why = status.failure != null ? ` ${sprintPathsFailureText(status.failure)}` : '';
  const when = status.failure === 'daily_cap' ? 'Limn tries again tomorrow.' : 'Limn tries again when the sprint changes.';
  return `Couldn’t find the critical paths.${why} ${when}`;
}

export function sprintPathsView(p: { aiEnabled: boolean; paths: SprintPaths | null; status: SprintPathsStatus }): SprintPathsView {
  if (!p.aiEnabled) return { kind: 'off' };
  const s = p.status;
  // Paths with nothing in them (a calm sprint) still stand: the strip says so.
  if (p.paths != null) {
    let note: SprintPathsNote = null;
    if (s.stale && (s.state === 'writing' || s.state === 'queued')) note = { kind: 'updating' };
    else if (s.state === 'failed') note = { kind: 'failed', text: pathsFailureLine(s) };
    return { kind: 'paths', paths: p.paths, note };
  }
  switch (s.state) {
    case 'writing':
      return { kind: 'message', writing: true, text: 'Working out the critical paths…' };
    case 'queued':
      return { kind: 'message', writing: false, text: 'Critical paths come after the ticket summaries.' };
    case 'waiting':
      return { kind: 'message', writing: false, text: 'Critical paths come after the next sprint read.' };
    case 'failed':
      return { kind: 'message', writing: false, text: pathsFailureLine(s) };
    default:
      return { kind: 'none' };
  }
}

/** The builder is running now — the page bar's "Working out the critical paths". */
export function pathsWriting(aiEnabled: boolean, status: SprintPathsStatus | null | undefined): boolean {
  return aiEnabled && status?.state === 'writing';
}

// ── The page's progress bar ──────────────────────────────────────────────────────────────────────
//
// What the page KNOWS: a sprint read was asked for and has not finished (`read.checkedAt` has not moved
// since Refresh), the first read is running, or the board is refetching — an indeterminate bar, since
// none of those reports progress. Briefs report counts (`briefs.current` / `pending`), so while they
// are being written the bar is DETERMINATE: the share of tickets summarised.

export type SprintProgress = { kind: 'busy'; label: string } | { kind: 'share'; label: string; value: number } | null;

/** The progress bar's state. Pure. */
export function sprintProgress(o: {
  /** Refresh pressed and the read it asked for has not finished. */
  awaitingRead: boolean;
  /** The first sprint read has not finished. */
  firstRead: boolean;
  /** The board is refetching (debounced by the page, so a quick poll does not flash it). */
  fetching: boolean;
  /** Briefs, when AI is on. */
  briefs: { current: number; pending: number } | null;
  /** The sprint builder is running now (`pathsStatus.state === 'writing'`). */
  pathsWriting?: boolean;
}): SprintProgress {
  if (o.awaitingRead || o.firstRead) return { kind: 'busy', label: 'Reading the sprint' };
  if (o.fetching) return { kind: 'busy', label: 'Refreshing the sprint' };
  const b = o.briefs;
  if (b != null && b.pending > 0) {
    const total = b.current + b.pending;
    return { kind: 'share', label: 'Summarising tickets', value: total > 0 ? b.current / total : 0 };
  }
  if (o.pathsWriting === true) return { kind: 'busy', label: 'Working out the critical paths' };
  return null;
}

// ── The header's sprint dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * The header's dates line, e.g. "14 Oct – 27 Oct · day 1 of 14" (dates short, in the reader's locale;
 * the day count is shared `sprintDayOf`, the same count the pace uses). An end ON a midnight is
 * the day before (a cadence window ends where the next sprint starts). Only an end (a GitHub milestone):
 * "due 28 Oct". Before the start: "starts 14 Oct"; past the end: "ended 27 Oct". null when there are no
 * dates. Pure (the locale and time zone are arguments, for its test).
 */
export function sprintDatesLine(
  d: SprintDates | null | undefined,
  nowMs: number,
  locale?: string,
  timeZone?: string,
): string | null {
  if (d == null) return null;
  const startMs = d.startsAt != null ? Date.parse(d.startsAt) : NaN;
  const endMs = d.endsAt != null ? Date.parse(d.endsAt) : NaN;
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(timeZone != null ? { timeZone } : {}) });
  const day = (ms: number): string => fmt.format(new Date(ms));
  // The last day the sprint covers: an end exactly on midnight belongs to the day before.
  const lastDay = (ms: number): string => day(ms - 1);
  const hasStart = Number.isFinite(startMs);
  const hasEnd = Number.isFinite(endMs);
  if (!hasStart && !hasEnd) return null;
  if (!hasStart) return nowMs >= endMs ? `ended ${lastDay(endMs)}` : `due ${lastDay(endMs)}`;
  if (!hasEnd) return nowMs < startMs ? `starts ${day(startMs)}` : `from ${day(startMs)}`;
  const range = `${day(startMs)} – ${lastDay(endMs)}`;
  if (nowMs < startMs) return `${range} · starts in ${Math.ceil((startMs - nowMs) / DAY_MS)} ${Math.ceil((startMs - nowMs) / DAY_MS) === 1 ? 'day' : 'days'}`;
  if (nowMs >= endMs) return `${range} · ended`;
  const t = sprintDayOf(startMs, endMs, nowMs);
  return t == null ? range : `${range} · day ${t.day} of ${t.days}`;
}
