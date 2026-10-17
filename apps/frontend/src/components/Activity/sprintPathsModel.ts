import {
  SPRINT_PATH_RISK_LABEL,
  SPRINT_SIGNAL_LABEL,
  sprintDayOf,
  sprintPathsFailureText,
  type SprintDates,
  type SprintPathRisk,
  type SprintPaths,
  type SprintPathsStatus,
  type SprintSignal,
  type SprintSignalKind,
} from '@pierre-review/shared';

// THE CRITICAL-PATHS STRIP'S FOLD (SprintPathsStrip.tsx; test/sprintPathsModel.test.ts). What the strip
// draws is decided here, once, from `SprintGraphResponse.pathsStatus` (the server's ONE fold):
//   • 'off'     — AI is off: Claude's half renders nothing (no upsell, no placeholder).
//   • 'paths'   — paths to show. `note` is the one quiet line beside them when they are not current:
//                 'updating' (being written now / next in line), or the failure sentence. STALE paths
//                 always beat a blank strip.
//   • 'message' — no paths yet: one short line ('writing' while the builder runs — the canvas bar runs
//                 with it — else when they will be written, or why they could not be).
//   • 'none'    — nothing to show (too few tickets, no tracker, no credential).
// The CARDS are a second, independent input: the code's own cards (`SprintGraphResponse.signals`, free,
// shown with AI off too) around the builder's paths and call-outs (`stripCards`, the ONE order).

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
      return { kind: 'message', writing: true, text: 'Finding the critical paths…' };
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

/** The builder is running now — the canvas bar's "Finding the critical paths". */
export function pathsWriting(aiEnabled: boolean, status: SprintPathsStatus | null | undefined): boolean {
  return aiEnabled && status?.state === 'writing';
}

/** One card on the strip: a critical path, a call-out or a code card. `key` is stable across refetches. */
export interface SprintStripCard {
  key: string;
  kind: 'path' | 'callout' | SprintSignalKind;
  /** Who wrote it: 'claude' (a path or call-out) or 'limn' (a code card). */
  by: 'claude' | 'limn';
  /** The card's visible label: its kind ("High risk", "Call-out", "Pace"…). */
  label: string;
  title: string;
  /** null = no sentence (a call-out). */
  sentence: string | null;
  /** Paths only: the ticket keys in order. */
  tickets: string[];
  risk: SprintPathRisk | null;
  idents: string[];
}

/**
 * The strip's cards in their ONE order: since you last looked, pace, then Claude's critical paths
 * (riskiest first) and call-outs, then out of step and blocked outside the sprint. Pure.
 */
export function stripCards(paths: SprintPaths | null, signals: readonly SprintSignal[]): SprintStripCard[] {
  const code = (k: SprintSignalKind): SprintStripCard[] =>
    signals
      .filter((s) => s.kind === k)
      .map((s) => ({ key: `signal:${s.kind}`, kind: s.kind, by: 'limn', label: SPRINT_SIGNAL_LABEL[s.kind], title: s.title, sentence: s.sentence, tickets: [], risk: null, idents: [...s.idents] }));
  return [
    ...code('since_last'),
    ...code('pace'),
    ...(paths?.paths ?? []).map(
      (p, i): SprintStripCard => ({
        key: `path:${i}:${p.title}`,
        kind: 'path',
        by: 'claude',
        label: SPRINT_PATH_RISK_LABEL[p.risk],
        title: p.title,
        sentence: p.advice,
        tickets: [...p.tickets],
        risk: p.risk,
        idents: [...p.idents],
      }),
    ),
    ...(paths?.callouts ?? []).map(
      (c, i): SprintStripCard => ({
        key: `callout:${i}:${c.title}`,
        kind: 'callout',
        by: 'claude',
        label: 'Call-out',
        title: c.title,
        sentence: null,
        tickets: [...c.tickets],
        risk: null,
        idents: [...c.idents],
      }),
    ),
    ...code('out_of_step'),
    ...code('blocked_outside'),
  ];
}

/** What identifies the card set for the selection: keys + idents (never a title — "Since 31 minutes
 *  ago" moves every minute and must not drop the reader's pick). */
export function stripCardsSig(cards: readonly SprintStripCard[]): string {
  return cards.map((c) => `${c.key}\u0000${c.idents.join(',')}`).join('\u0001');
}

/** A card's click: the idents to focus, or [] to clear when it is the one already focused. */
export function cardFocus(selected: string | null, key: string, idents: readonly string[]): { selected: string | null; idents: string[] } {
  return selected === key ? { selected: null, idents: [] } : { selected: key, idents: [...idents] };
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
