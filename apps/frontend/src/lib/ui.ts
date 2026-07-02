import type {
  CheckRunState,
  CiStatus,
  DerivedState,
  EventType,
  Mergeable,
  MergeStateStatus,
  MyTurnReason,
  PrState,
  ReasonTag,
  ThreadStateCounts,
  User,
} from '@pierre-review/shared';

export interface StateMeta {
  label: string;
  color: string;
  description: string;
}

export const DERIVED_STATE_META: Record<DerivedState, StateMeta> = {
  untouched: {
    label: 'Untouched',
    color: '#ef4444',
    description: 'No reply, and no follow-up commit touched the file.',
  },
  replied_unresolved: {
    label: 'Replied',
    color: '#f59e0b',
    description:
      'Someone replied, but the thread is unresolved and no later commit touched the file.',
  },
  likely_addressed: {
    label: 'Likely addressed',
    color: '#3b82f6',
    description:
      'A commit touched this file after the last comment. Heuristic — it may be a false positive.',
  },
  resolved: {
    label: 'Resolved',
    color: '#22c55e',
    description: 'Marked resolved on GitHub.',
  },
};

export const PR_STATE_META: Record<PrState, { label: string; color: string }> = {
  open: { label: 'Open', color: '#3b82f6' },
  merged: { label: 'Merged', color: '#22c55e' },
  closed: { label: 'Closed', color: '#9ca3af' },
};

export const EVENT_META: Record<
  EventType,
  { label: string; color: string; shape: 'dot' | 'diamond' | 'triangle' | 'square' }
> = {
  pr_opened: { label: 'PR opened', color: '#3b82f6', shape: 'dot' },
  pr_merged: { label: 'PR merged', color: '#8957e5', shape: 'dot' },
  pr_closed: { label: 'PR closed', color: '#9ca3af', shape: 'dot' },
  pr_reopened: { label: 'PR reopened', color: '#3b82f6', shape: 'dot' },
  pr_ready_for_review: { label: 'Ready for review', color: '#3b82f6', shape: 'dot' },
  review_submitted: { label: 'Review', color: '#22c55e', shape: 'triangle' },
  review_comment: { label: 'Review comment', color: '#f59e0b', shape: 'dot' },
  pr_comment: { label: 'PR comment', color: '#a78bfa', shape: 'square' },
  commit_pushed: { label: 'Commit', color: '#6b7280', shape: 'diamond' },
};

// Reason tags: short label + colour + whether it's a "you" reason (gets the
// pulsing ring + my-turn grouping).
export const REASON_META: Record<
  ReasonTag,
  { label: string; color: string; myTurn: boolean }
> = {
  awaiting_your_review: { label: 'Awaiting your review', color: '#3b82f6', myTurn: true },
  your_pr_new_comments: { label: 'Your PR · new comments', color: '#22c55e', myTurn: true },
  ci_failing: { label: 'CI failing', color: '#ef4444', myTurn: false },
  merge_conflicts: { label: 'Merge conflicts', color: '#f97316', myTurn: false },
  approved_ready: { label: 'Approved · ready to merge', color: '#22c55e', myTurn: false },
  stalled: { label: 'Stalled', color: '#eab308', myTurn: false },
  untouched_threads: { label: 'Untouched threads', color: '#f59e0b', myTurn: false },
  in_progress: { label: 'In progress', color: '#9ca3af', myTurn: false },
};

// Why a feed item is "FYI" (was "My Turn") — the reason pill on the card. `label` is the
// short pill text, `title` the hover explanation. See MyTurnReason (most-relevant first).
export const FYI_REASON_META: Record<MyTurnReason, { label: string; title: string }> = {
  requested: {
    label: 'Review requested',
    title: 'A review was requested from you on this PR',
  },
  authored: { label: 'You authored', title: 'You opened this PR' },
  merged: { label: 'You merged', title: 'You merged this PR' },
  reviewed: { label: 'You reviewed', title: 'You previously reviewed this PR' },
  commented: { label: 'You commented', title: 'You previously commented on this PR' },
};

// The reason tags that make a PR "need attention" — mirrors the backend's
// ACTIVITY_ATTENTION_REASONS (db/queries.ts) so the per-PR ⚠ badge and the repo-level
// attentionCount agree exactly.
const ATTENTION_REASONS = new Set<ReasonTag>([
  'awaiting_your_review',
  'your_pr_new_comments',
  'ci_failing',
  'merge_conflicts',
  'untouched_threads',
]);

// Whether an open PR needs attention (your turn · stalled · untouched threads / CI /
// conflicts). Keep in lockstep with getActivity's attentionCount predicate.
export function prNeedsAttention(pr: {
  isStalled: boolean;
  threadCounts: ThreadStateCounts;
  reasonTag: ReasonTag;
}): boolean {
  return pr.isStalled || pr.threadCounts.untouched > 0 || ATTENTION_REASONS.has(pr.reasonTag);
}

// CI rollup → dot colour + label. `null` when there are no checks at all.
export const CI_META: Record<
  CiStatus,
  { label: string; color: string } | null
> = {
  success: { label: 'CI passing', color: '#22c55e' },
  failure: { label: 'CI failing', color: '#ef4444' },
  error: { label: 'CI error', color: '#ef4444' },
  pending: { label: 'CI running', color: '#eab308' },
  expected: { label: 'CI expected', color: '#9ca3af' },
  unknown: null,
};

// Per-check display: icon glyph + colour + short label.
export const CHECK_STATE_META: Record<
  CheckRunState,
  { label: string; color: string; icon: string }
> = {
  success: { label: 'passed', color: '#22c55e', icon: '✓' },
  failure: { label: 'failed', color: '#ef4444', icon: '✕' },
  pending: { label: 'running', color: '#eab308', icon: '•' },
  neutral: { label: 'neutral', color: '#9ca3af', icon: '–' },
  skipped: { label: 'skipped', color: '#9ca3af', icon: '⤼' },
  error: { label: 'error', color: '#ef4444', icon: '!' },
  unknown: { label: 'unknown', color: '#9ca3af', icon: '?' },
};

// Only surface mergeability when it's a problem.
export function mergeWarning(
  mergeable: Mergeable,
  mss: MergeStateStatus,
): string | null {
  if (mergeable === 'conflicting' || mss === 'dirty') return 'conflicts';
  if (mss === 'behind') return 'behind';
  if (mss === 'unstable') return 'unstable';
  return null;
}

export function userLabel(user: User | undefined, fallbackId: number | null): string {
  if (user) return user.displayName || user.githubLogin;
  return fallbackId == null ? 'unknown' : `user ${fallbackId}`;
}

/** GitHub profile URL for a login (e.g. `octocat` → https://github.com/octocat). */
export function profileUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

// Prefill for "replying" to a comment: GitHub issue comments are flat (no native
// reply threading), so a reply is a new comment that quotes the original as a `> `
// blockquote and @mentions its author. The user edits from there. Empty bodies
// (e.g. lean mode before hydration) just yield the bare mention.
export function buildQuotedReply(body: string | null, authorLogin: string | null): string {
  const mention = authorLogin ? `@${authorLogin} ` : '';
  const trimmed = (body ?? '').trim();
  if (trimmed === '') return mention;
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quoted}\n\n${mention}`;
}

export function indexUsers(users: User[] | undefined): Map<number, User> {
  const map = new Map<number, User>();
  for (const u of users ?? []) map.set(u.id, u);
  return map;
}

// Single source of truth for a plain calendar date. Locale-aware: the runtime
// locale decides field order + separators, so en-GB renders "02/05/2026" (dd/mm/
// yyyy) and en-US "05/02/2026" (mm/dd/yyyy). 2-digit day/month + 4-digit year give
// an unambiguous, stable-width date. Every date the app shows goes through here (or
// dateTime), so the format stays consistent everywhere.
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (abs < min) return 'just now';
  if (abs < hr) return fmt(Math.round(diff / min), 'min');
  if (abs < day) return fmt(Math.round(diff / hr), 'hour');
  if (abs < 30 * day) return fmt(Math.round(diff / day), 'day');
  return formatDate(iso);
}

// Absolute date *with* time of day, e.g. "02/05/2026, 09:04" — used where the exact
// moment matters (the activity feed) rather than a fuzzy "4 days ago". The date part
// matches formatDate (locale-aware dd/mm/yyyy ordering) for consistency.
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "Watched repo" eye glyph: a repo whose new open PRs by others flow into your My
// Turn inbox (the per-repo Watch toggle). Shown next to the repo name wherever it
// appears so the inbox source is recognisable at a glance. This HTML-string form is
// for the vis-timeline repo-header label (a string; the vis sanitizer is disabled);
// the React <WatchedBadge> mirrors it for the JSX sites — keep the SVG in sync.
export const WATCHED_TITLE = 'Watched — new PRs here flow into your My Turn inbox';

export function watchedGlyphHtml(): string {
  return (
    `<span class="tl-repo-watch" title="${escapeHtml(WATCHED_TITLE)}" aria-label="Watched repo">` +
    `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">` +
    `<path d="M8 4C4.6 4 1.9 6.2 1 8c.9 1.8 3.6 4 7 4s6.1-2.2 7-4c-.9-1.8-3.6-4-7-4Z" fill="none" stroke="currentColor" stroke-width="1.2"/>` +
    `<circle cx="8" cy="8" r="1.9" fill="currentColor"/>` +
    `</svg></span>`
  );
}
