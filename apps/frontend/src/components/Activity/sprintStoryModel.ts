import {
  SPRINT_SIGNAL_LABEL,
  sprintDayOf,
  sprintStoryFailureText,
  type SprintDates,
  type SprintSignal,
  type SprintSignalKind,
  type SprintStory,
  type SprintStoryStatus,
  type SprintStoryline,
  type SprintStorylineKind,
} from '@pierre-review/shared';

// THE SPRINT STORY STRIP'S FOLD (SprintStoryStrip.tsx; test/sprintStoryModel.test.ts). What the strip
// draws is decided here, once, from `SprintGraphResponse.storyStatus` (the server's ONE fold):
//   • 'off'     — AI is off: the strip renders nothing (no upsell, no placeholder).
//   • 'story'   — a story to show. `note` is the one quiet line beside it when it is not current:
//                 'updating' (being written now / next in line), or the failure sentence. A STALE story
//                 always beats a blank strip.
//   • 'message' — no story yet: one short line ('writing' while the pass runs — the canvas bar runs
//                 with it — else when it will be written, or why it could not be).
//   • 'none'    — nothing to show (too few tickets, no tracker, no credential).
// The CARDS are a second, independent input: the code's own cards (`SprintGraphResponse.signals`, free,
// shown with AI off too) around the model's storylines (`stripCards`, the ONE order).

export type SprintStoryNote = { kind: 'updating' } | { kind: 'failed'; text: string } | null;

export type SprintStoryView =
  | { kind: 'off' }
  | { kind: 'none' }
  | { kind: 'story'; story: SprintStory; note: SprintStoryNote }
  | { kind: 'message'; writing: boolean; text: string };

/** The failure line: the reason, then when it is tried again. */
export function storyFailureLine(status: SprintStoryStatus): string {
  const why = status.failure != null ? ` ${sprintStoryFailureText(status.failure)}` : '';
  return `Couldn’t write the sprint story.${why} Limn tries again when the sprint changes.`;
}

export function sprintStoryView(p: { aiEnabled: boolean; story: SprintStory | null; status: SprintStoryStatus }): SprintStoryView {
  if (!p.aiEnabled) return { kind: 'off' };
  const s = p.status;
  // A v4 story may carry no storyline (nothing at risk, no open chain): its headline + focus still stand.
  if (p.story != null && p.story.headline.trim() !== '') {
    let note: SprintStoryNote = null;
    if (s.stale && (s.state === 'writing' || s.state === 'queued')) note = { kind: 'updating' };
    else if (s.state === 'failed') note = { kind: 'failed', text: storyFailureLine(s) };
    return { kind: 'story', story: p.story, note };
  }
  switch (s.state) {
    case 'writing':
      return { kind: 'message', writing: true, text: 'Writing the sprint story…' };
    case 'queued':
      return { kind: 'message', writing: false, text: 'The sprint story is written after the ticket summaries.' };
    case 'waiting':
      return { kind: 'message', writing: false, text: 'The sprint story is written after the next sprint read.' };
    case 'failed':
      return { kind: 'message', writing: false, text: storyFailureLine(s) };
    default:
      return { kind: 'none' };
  }
}

/** The story pass is running now — the canvas bar's "Writing the sprint story". */
export function storyWriting(aiEnabled: boolean, status: SprintStoryStatus | null | undefined): boolean {
  return aiEnabled && status?.state === 'writing';
}

/** The kind label printed on each storyline card (and the mark's meaning). */
export const STORYLINE_KIND_LABEL: Record<SprintStorylineKind, string> = {
  chain: 'Dependency path',
  risk: 'At risk',
};

/** One card on the strip: a model storyline or a code card. `key` is stable across refetches. */
export interface SprintStripCard {
  key: string;
  kind: SprintStorylineKind | SprintSignalKind;
  /** Who wrote it: 'claude' (a storyline) or 'limn' (a code card). */
  by: 'claude' | 'limn';
  label: string;
  title: string;
  sentence: string;
  idents: string[];
}

/**
 * The strip's cards in their ONE order: since you last looked, pace, then Claude's storylines (as it
 * ordered them), then out of step and blocked outside the sprint — so the risk-like cards sit together.
 * Pure.
 */
export function stripCards(storylines: readonly SprintStoryline[], signals: readonly SprintSignal[]): SprintStripCard[] {
  const code = (k: SprintSignalKind): SprintStripCard[] =>
    signals
      .filter((s) => s.kind === k)
      .map((s) => ({ key: `signal:${s.kind}`, kind: s.kind, by: 'limn', label: SPRINT_SIGNAL_LABEL[s.kind], title: s.title, sentence: s.sentence, idents: [...s.idents] }));
  return [
    ...code('since_last'),
    ...code('pace'),
    ...storylines.map(
      (l, i): SprintStripCard => ({ key: `story:${i}:${l.title}`, kind: l.kind, by: 'claude', label: STORYLINE_KIND_LABEL[l.kind], title: l.title, sentence: l.sentence, idents: [...l.idents] }),
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
export function storylineFocus(selected: string | null, key: string, idents: readonly string[]): { selected: string | null; idents: string[] } {
  return selected === key ? { selected: null, idents: [] } : { selected: key, idents: [...idents] };
}

// ── The header's sprint dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * The header's dates line, e.g. "14 Oct – 27 Oct · day 1 of 14" (dates short, in the reader's locale;
 * the day count is shared `sprintDayOf`, the same count the story's facts use). An end ON a midnight is
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
