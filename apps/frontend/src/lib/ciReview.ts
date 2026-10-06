// THE CI REVIEW's pure half — the "CI check" section of the Claude Review tab
// (components/CiCheckSection.tsx) and the CI pill on the Open PRs and Pending cards.
//
// The CI review is its OWN Claude run (docs/CLAUDE-REVIEW.md § CI review), beside the code review:
// one run per (PR, head commit, failing-check set). Every figure here is read off the server's
// state or items, which never invent a cause; nothing here decides whether a run is current.
import {
  CI_REVIEW_STATES_MAX,
  type CiReviewCounts,
  type CiReviewProgress,
  type CiReviewRefusal,
  type CiReviewState,
  type CiStatus,
  type ClaudeCiFailure,
} from '@pierre-review/shared';
import { CLEAN_CLASS, OUTDATED_CLASS } from './claudeReviewFollowUp.js';

/** The batched states request's id list: unique, sorted (a stable query key), capped at the route's
 *  limit (rows past it get no reading). */
export function ciStatesRequestIds(prIds: readonly number[]): number[] {
  return [...new Set(prIds)].sort((a, b) => a - b).slice(0, CI_REVIEW_STATES_MAX);
}

/** Does any listed PR have a CI review in flight? The states query polls only while one does. */
export function anyCiRunning(states: readonly CiReviewState[] | undefined): boolean {
  return (states ?? []).some((s) => s.status === 'running');
}

// ---- the card pill ----

/** "2 CI failures explained" / "3 CI failures, 1 explained". null with nothing failing. */
export function ciCountsLabel(counts: Pick<CiReviewCounts, 'failing' | 'explained'> | null | undefined): string | null {
  if (counts == null || counts.failing <= 0) return null;
  const noun = `CI failure${counts.failing === 1 ? '' : 's'}`;
  if (counts.explained >= counts.failing) return `${counts.failing} ${noun} explained`;
  return `${counts.failing} ${noun}, ${counts.explained === 0 ? 'none' : counts.explained} explained`;
}

export interface CiCardPill {
  label: string;
  running: boolean;
}

/**
 * The CI pill on an Open PRs / Pending card, from the ONE batched states answer. Only a CURRENT run
 * (same head, same failing checks) or one in flight says anything: a stale diagnosis describes CI
 * the PR no longer has.
 */
export function ciCardPill(state: CiReviewState | undefined): CiCardPill | null {
  if (state == null) return null;
  if (state.status === 'running') return { label: 'Checking CI…', running: true };
  if (state.status !== 'current') return null;
  const label = ciCountsLabel(state.counts);
  return label == null ? null : { label, running: false };
}

// ---- the section ----

export type CiCurrencyTone = 'current' | 'stale' | 'running';

export interface CiCurrency {
  tone: CiCurrencyTone;
  label: string;
  title: string;
}

/** The section header's pill: is the shown run still true of the PR's CI? null with no run. */
export function ciCurrency(state: Pick<CiReviewState, 'status' | 'staleBecause' | 'headSha'>): CiCurrency | null {
  switch (state.status) {
    case 'none':
      return null;
    case 'running':
      return { tone: 'running', label: 'Checking…', title: 'A CI check is running.' };
    case 'current':
      return {
        tone: 'current',
        label: 'On latest commit',
        title: 'The same checks are failing on the same commit.',
      };
    case 'stale':
      switch (state.staleBecause) {
        case 'pushed':
          return { tone: 'stale', label: 'Pushed since', title: 'The PR has new commits since this check.' };
        case 'checks_changed':
          return {
            tone: 'stale',
            label: 'Other checks failing now',
            title: 'A different set of checks is failing on this commit.',
          };
        case 'now_passing':
          return { tone: 'stale', label: 'Passing now', title: 'Nothing is failing on this commit any more.' };
        default:
          return { tone: 'stale', label: 'Changed since', title: 'The PR’s CI changed since this check.' };
      }
  }
}

export const CI_CURRENCY_CLASS: Record<CiCurrencyTone, string> = {
  current: CLEAN_CLASS,
  stale: OUTDATED_CLASS,
  running: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

/** Why the server did not run Claude. One sentence each. */
export function ciRefusalSentence(r: CiReviewRefusal): string {
  switch (r) {
    case 'no_failures':
      return 'Nothing is failing on this commit.';
    case 'no_logs':
      return 'The failing checks do not run on GitHub Actions, so there are no logs to read.';
    case 'logs_unavailable':
      return 'The failing jobs’ logs could not be read.';
    case 'checks_unreadable':
      return 'The checks on this commit could not be read from GitHub.';
    case 'head_unreadable':
      return 'This commit could not be checked out.';
  }
}

export const CI_PHASE_LABEL: Record<CiReviewProgress['phase'], string> = {
  queued: 'Waiting to start',
  reading_logs: 'Reading the logs',
  reviewing: 'Reading the code',
  saving: 'Saving',
};

/** A determinate 0–100 reading for the progress bar; null = indeterminate. */
export function ciProgressPct(p: CiReviewProgress | null | undefined): number | null {
  if (p == null) return null;
  switch (p.phase) {
    case 'queued':
      return 5;
    case 'reading_logs':
      return 20;
    case 'reviewing':
      return Math.min(90, 40 + (p.recentActivity?.length ?? 0) * 3);
    case 'saving':
      return 95;
  }
}

/**
 * ONLY THE PR'S CURRENT HEAD. A CI diagnosis of an earlier commit describes CI the PR no longer has:
 * once the head is green it is noise, and while the head is red it is the wrong commit's story. So a
 * run (a CI review, or an older code review's stored CI diagnosis) shows only when it read the PR's
 * current head. An unknown head (`prHeadSha` null) hides nothing — there is nothing to compare.
 */
export function ciRunAtCurrentHead(
  runHeadSha: string | null | undefined,
  prHeadSha: string | null | undefined,
): boolean {
  if (prHeadSha == null || prHeadSha === '') return true;
  return runHeadSha === prHeadSha;
}

/**
 * What the section shows:
 *   ci      — a CI review at the current head (its latest succeeded run, a refusal, a failure, or a
 *             run in flight)
 *   legacy  — no such CI review, but an older CODE review of the current head diagnosed CI: history
 *   offer   — nothing yet, and CI is failing on the PR: just the Check CI button
 *   hidden  — nothing to say (nothing at the current head, CI not failing)
 * The caller filters to the current head first (`ciRunAtCurrentHead`).
 */
export type CiSectionShow = 'ci' | 'legacy' | 'offer' | 'hidden';

export function ciSectionShow(input: {
  // Something at the current head to show: a succeeded run, a refusal or a failed run.
  hasCurrentRun: boolean;
  running: boolean;
  legacyFailures: readonly ClaudeCiFailure[] | null | undefined;
  prCiStatus: CiStatus | null | undefined;
}): CiSectionShow {
  const { hasCurrentRun, running, legacyFailures, prCiStatus } = input;
  if (hasCurrentRun || running) return 'ci';
  if (legacyFailures != null && legacyFailures.length > 0) return 'legacy';
  if (prCiStatus === 'failure') return 'offer';
  return 'hidden';
}

/** The button's word: "Check CI" before any succeeded run, "Re-check" after. */
export function ciCheckButtonLabel(hasResult: boolean, starting: boolean): string {
  if (starting) return 'Starting…';
  return hasResult ? 'Re-check' : 'Check CI';
}
