// THE AI REVIEW TAB'S RUN HISTORY — the pure half (docs/CLAUDE-REVIEW.md § The review tab's history).
// Every run on the PR is listed, whatever provider, model or head ran it, newest first (the server's
// `listClaudeReviewHistory` is uncapped). Which run the pane SHOWS is the reader's: it never changes on
// its own when a run starts or finishes, a provider is switched or the model menu changes — with ONE
// exception, a run the reader just started (a MANUAL run that became the latest while the pane was
// open), which becomes the shown run so its progress and result are what the pane is about.
import type { ClaudeReviewStatus, ClaudeReviewSummary, ClaudeReviewTrigger } from '@pierre-review/shared';
import { aiRunLabel, PAIR_RUN_LABEL } from '@pierre-review/shared';
import { AUTO_REVIEW_LABEL as AUTO_WORD } from '../components/Activity/pendingLabels.js';
import { REPLIES_CHECK_LABEL as REPLIES_WORD } from './repliesCheck.js';

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

// ---- THE HISTORY SELECT (docs/FRONTEND.md § The AI Review tab's history) ----
//
// ONE OPTION PER REVIEW, newest first, every review listed (all providers, all heads): a CLAUDE + CODEX
// PAIR is ONE option ("Claude + Codex · abc1234 · <when>") addressed by its LATEST half's id (the id
// the server's consolidated view answers with); a replies pass is "Replies checked · …"; an ordinary
// run is its run label (`aiRunLabel`).

/** One option of the history select. `runIds`: the stored runs it stands for (a pair: both halves). */
export interface ReviewHistoryOption {
  id: number;
  label: string;
  runIds: number[];
}

const shortHead = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '—');

/** A pair's halves as one status: in flight while either is; else succeeded when either did. */
function pairStatus(halves: readonly Pick<ClaudeReviewSummary, 'status'>[]): ClaudeReviewStatus {
  if (halves.some((h) => inFlight(h.status))) return halves.every((h) => h.status === 'queued') ? 'queued' : 'running';
  if (halves.some((h) => h.status === 'succeeded')) return 'succeeded';
  return halves[0]?.status ?? 'failed';
}

/**
 * The history select's options, newest first. `latestId` marks the latest review "(latest)"; `when`
 * formats a time (`reviewRunWhen`).
 */
export function reviewHistoryOptions(
  history: readonly ClaudeReviewSummary[],
  latestId: number | null,
  when: (iso: string) => string,
): ReviewHistoryOption[] {
  const out: ReviewHistoryOption[] = [];
  const pairs = new Map<number, ClaudeReviewSummary[]>();
  for (const h of history) {
    if (h.pair == null) continue;
    const list = pairs.get(h.pair.pairId) ?? [];
    list.push(h);
    pairs.set(h.pair.pairId, list);
  }
  const done = new Set<number>();
  for (const h of history) {
    if (h.pair != null) {
      if (done.has(h.pair.pairId)) continue;
      done.add(h.pair.pairId);
      // History is newest first: the first half seen is the latest, the option's id.
      const halves = pairs.get(h.pair.pairId) ?? [h];
      const latest = halves[0]!;
      const status = pairStatus(halves);
      const parts = [PAIR_RUN_LABEL, shortHead(latest.headSha), when(latest.finishedAt ?? latest.createdAt)];
      if (status !== 'succeeded') parts.push(reviewStatusWord(status));
      if (latest.trigger === 'auto') parts.push(AUTO_WORD);
      const ids = halves.map((x) => x.id);
      out.push({ id: latest.id, runIds: ids, label: parts.join(' · ') + (latestId != null && ids.includes(latestId) ? ' (latest)' : '') });
      continue;
    }
    const what =
      h.kind === 'replies' ? REPLIES_WORD : h.reviewMode === 'skip' ? 'Skipped (nothing to review)' : aiRunLabel(h.provider, h.model, h.effort);
    const parts = [what, shortHead(h.headSha), when(h.finishedAt ?? h.createdAt)];
    if (h.status !== 'succeeded') parts.push(reviewStatusWord(h.status));
    if (h.trigger === 'auto') parts.push(AUTO_WORD);
    out.push({ id: h.id, runIds: [h.id], label: parts.join(' · ') + (h.id === latestId ? ' (latest)' : '') });
  }
  return out;
}

/** The option standing for a run id (a pair's either half ⇒ the pair's option), or the id itself. */
export function historyOptionIdFor(options: readonly ReviewHistoryOption[], id: number | null): number | null {
  if (id == null) return null;
  return options.find((o) => o.runIds.includes(id))?.id ?? id;
}
