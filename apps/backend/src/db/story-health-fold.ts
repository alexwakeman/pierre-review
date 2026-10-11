import type { KnownTicket, StoryCriterionLabel, StoryLevelLabels, TicketLinkBlocker } from '@pierre-review/shared';

// REPORTS → STORIES — the label run's PURE population rules (story-health-fold.test.ts). The Story
// health chart fold that lived here is RETIRED (2026-10-11); db/story-health.ts reads the inputs.
//
//   • A story's WEEK is the week its ticket was CREATED (`createdMs`), else — no created date — the week
//     its first pull request was opened.
//   • THE LABEL RUN takes the stories in the span that are labellable and carry no CURRENT label,
//     newest first (`storiesToLabel`).

/** One story as the fold needs it. */
export interface StoryHealthStoryInput {
  ident: string;
  /** The ticket's own created instant (freshest stored row with one); null = not known. */
  createdMs: number | null;
  firstOpenedMs: number;
  /** Last merge, when the story is in the DELIVERY population (merged in the span); null = refinement only. */
  lastMergedMs: number | null;
  /** Σ additions + deletions over merged members; null = unknown size. */
  linesChanged: number | null;
  workingHours: number;
  prsTotal: number;
  /** The latest succeeded ticket review's counts, when it judged at least one criterion. */
  review: { met: number; total: number } | null;
  /** A stored ticket row with text was read. False = its text is unknown: every refinement series
   *  leaves it out (never "no criteria"). */
  ticketKnown: boolean;
  /** Has criteria text the labeller can be sent (`storyLabelInput` non-null). */
  labellable: boolean;
  /** Today's numbered criteria (the ONE extractor); 0 = none. Meaningful only when `ticketKnown`. */
  criteriaCount: number;
  /** The CURRENT label (this rubric, this text hash), or null. */
  label: { criteria: StoryCriterionLabel[]; story: StoryLevelLabels } | null;
  /** Hover: the ticket key and title (absent → the story is listed by ident). */
  key?: string;
  title?: string | null;
  /** The freshest stored row's tracker links (`blocked_by_json`); null/absent = not read. */
  links?: readonly TicketLinkBlocker[] | null;
  /** Stored tickets a label's named keys point at (shared across stories). */
  knownTickets?: ReadonlyMap<string, KnownTicket> | null;
}

export interface StoryHealthWeekBound {
  /** Local Monday `YYYY-MM-DD`. */
  key: string;
  startMs: number;
  endMs: number;
}

/** The week index holding `ms`, or -1. */
function weekOf(weeks: readonly StoryHealthWeekBound[], ms: number): number {
  for (let i = 0; i < weeks.length; i += 1) if (ms >= weeks[i]!.startMs && ms < weeks[i]!.endMs) return i;
  return -1;
}

/** Which refinement week a story belongs to, and whether that came from the fallback. */
export function refinementWeekOf(
  s: Pick<StoryHealthStoryInput, 'createdMs' | 'firstOpenedMs'>,
  weeks: readonly StoryHealthWeekBound[],
): { week: number; fallback: boolean } {
  if (s.createdMs != null) return { week: weekOf(weeks, s.createdMs), fallback: false };
  return { week: weekOf(weeks, s.firstOpenedMs), fallback: true };
}

/** The stories the label run would label: refinement-bucketed in the span, labellable, no current
 *  label — newest first (created, else first opened). The run takes the first STORY_LABEL_RUN_CAP. */
export function storiesToLabel<T extends StoryHealthStoryInput>(stories: readonly T[], weeks: readonly StoryHealthWeekBound[]): T[] {
  return stories
    .filter((s) => s.labellable && s.label == null && refinementWeekOf(s, weeks).week >= 0)
    .sort((a, b) => (b.createdMs ?? b.firstOpenedMs) - (a.createdMs ?? a.firstOpenedMs) || a.ident.localeCompare(b.ident));
}
