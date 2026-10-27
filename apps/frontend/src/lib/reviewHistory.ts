// THE AI REVIEW TAB'S RUN HISTORY — the pure half (docs/CLAUDE-REVIEW.md § The review tab's history).
// Every run on the PR is listed, whatever provider, model or head ran it, newest first (the server's
// `listClaudeReviewHistory` is uncapped). Which run the pane SHOWS is the reader's: it never changes on
// its own when a run starts or finishes, a provider is switched or the model menu changes — with ONE
// exception, a run the reader just started (a MANUAL run that became the latest while the pane was
// open), which becomes the shown run so its progress and result are what the pane is about.
import type { ClaudeReviewStatus, ClaudeReviewSummary, ClaudeReviewTrigger } from '@pierre-review/shared';

/** The latest run, as the selection rule reads it. */
export interface LatestRun {
  id: number;
  status: ClaudeReviewStatus;
  trigger?: ClaudeReviewTrigger;
}

const inFlight = (s: ClaudeReviewStatus): boolean => s === 'queued' || s === 'running';

/**
 * The run to show next.
 *   • `shown`: the run shown now (null before the first read).
 *   • `previousLatestId`: the latest run's id at the last read (null before the first read).
 * Rules, in order:
 *   1. a NEW latest run that a person started (trigger not 'auto') since the last read ⇒ show it;
 *   2. a shown run still listed ⇒ keep it (a new AUTO run, a run finishing, a provider switch: nothing moves);
 *   3. nothing shown yet ⇒ the latest run, unless it is an AUTO run still in flight — then the newest
 *      FINISHED run, so an auto run starting never blanks the pane — else the latest.
 */
export function nextShownReviewId(args: {
  shown: number | null;
  latest: LatestRun | null;
  previousLatestId: number | null;
  history: readonly Pick<ClaudeReviewSummary, 'id' | 'status'>[];
}): number | null {
  const { shown, latest, previousLatestId, history } = args;
  if (latest == null) return shown;
  const isNewLatest = previousLatestId != null && latest.id !== previousLatestId;
  if (isNewLatest && latest.trigger !== 'auto') return latest.id;
  const listed = (id: number): boolean => id === latest.id || history.some((h) => h.id === id);
  if (shown != null && listed(shown)) return shown;
  if (latest.trigger === 'auto' && inFlight(latest.status)) {
    const finished = history.find((h) => h.id !== latest.id && !inFlight(h.status));
    if (finished) return finished.id;
  }
  return latest.id;
}

const STATUS_WORD: Record<ClaudeReviewStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** A run's status in one word. */
export function reviewStatusWord(s: ClaudeReviewStatus): string {
  return STATUS_WORD[s] ?? s;
}

/** "3 findings" / "1 finding" / "No findings" — for a finished run with a count; null otherwise. */
export function findingCountText(h: Pick<ClaudeReviewSummary, 'status' | 'findingCount'>): string | null {
  if (h.status !== 'succeeded' || h.findingCount == null) return null;
  if (h.findingCount === 0) return 'No findings';
  return `${h.findingCount} finding${h.findingCount === 1 ? '' : 's'}`;
}

// ---- CLAUDE + CODEX PAIRS (docs/CLAUDE-REVIEW.md § Claude + Codex) ----

/** One entry of the history list: a run on its own, or a pair's two halves under one header. */
export type ReviewHistoryEntry<H> =
  | { kind: 'run'; run: H }
  | { kind: 'pair'; pairId: number; first: H | null; second: H | null };

/**
 * Group the history (newest first) so a pair's two runs sit together, first half then second, at the
 * place of its newest half. Every run is still listed exactly once.
 */
export function groupReviewHistory<H extends Pick<ClaudeReviewSummary, 'id' | 'pair'>>(
  history: readonly H[],
): ReviewHistoryEntry<H>[] {
  const out: ReviewHistoryEntry<H>[] = [];
  const pairs = new Map<number, Extract<ReviewHistoryEntry<H>, { kind: 'pair' }>>();
  for (const h of history) {
    const p = h.pair;
    if (p == null) {
      out.push({ kind: 'run', run: h });
      continue;
    }
    let entry = pairs.get(p.pairId);
    if (!entry) {
      entry = { kind: 'pair', pairId: p.pairId, first: null, second: null };
      pairs.set(p.pairId, entry);
      out.push(entry);
    }
    if (p.role === 'first') entry.first = h;
    else entry.second = h;
  }
  return out;
}

/**
 * "Post both" is offered on a pair's second half when both halves finished: the shown (latest) run is
 * the second, and its first half succeeded too.
 */
export function canPostBoth(
  review: Pick<ClaudeReviewSummary, 'status' | 'pair'> | null | undefined,
  history: readonly Pick<ClaudeReviewSummary, 'id' | 'status'>[],
): boolean {
  const p = review?.pair;
  if (review == null || p == null || p.role !== 'second' || review.status !== 'succeeded' || p.otherReviewId == null) {
    return false;
  }
  return history.some((h) => h.id === p.otherReviewId && h.status === 'succeeded');
}
