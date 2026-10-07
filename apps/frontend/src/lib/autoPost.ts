// AUTO-POSTING ON SCREEN — the words the Claude Review tab and Story check use for what
// auto-posting did (docs/CLAUDE-REVIEW.md § Auto-posting). Pure, so the copy is pinned by
// test/autoPost.test.ts.
import type {
  AutoPostSkipReason,
  AutoPostStatus,
  ClaudeAutoVerdictRecord,
  FindingAutoResolveRecord,
} from '@pierre-review/shared';
import { relativeTime } from './ui.js';

/** A posted finding's / item's chip: "Posted", or "Posted automatically · 3 mins ago". */
export function postedChipLabel(p: { postedAt: string | null; postedAuto?: boolean }): string {
  return p.postedAuto === true && p.postedAt != null
    ? `Posted automatically · ${relativeTime(p.postedAt)}`
    : 'Posted';
}

/**
 * The one line a FAILED or PARTIAL auto post earns (the Post button stays beside it), else null.
 * A skip says nothing: nothing was meant to be posted.
 */
export function autoPostFailureLine(
  a: { status: AutoPostStatus; error: string | null } | null | undefined,
): string | null {
  if (a == null) return null;
  const why = a.error != null && a.error.trim() !== '' ? a.error.trim() : 'GitHub did not accept it.';
  if (a.status === 'failed') return `Couldn’t post automatically: ${why}`;
  if (a.status === 'partial') return `Couldn’t post all of it automatically: ${why}`;
  return null;
}

/**
 * The one line a SKIP earns when it still tells the reader something: 'already_posted' (there was
 * something to post, and an earlier post already put all of it on GitHub). Every other skip says
 * nothing.
 */
export function autoPostSkipLine(
  a: { status: AutoPostStatus; reason: AutoPostSkipReason | null; alreadyPostedCount?: number } | null | undefined,
): string | null {
  if (a == null || a.status !== 'skipped' || a.reason !== 'already_posted') return null;
  const n = a.alreadyPostedCount ?? 0;
  if (n <= 0) return 'Not posted automatically: it is already on GitHub.';
  return n === 1
    ? 'Not posted automatically: its one comment is already on GitHub.'
    : `Not posted automatically: all ${n} comments are already on GitHub.`;
}

/** What the automatic verdict did, when it wanted more than a comment; else null. */
export function autoVerdictLine(
  a: { status: AutoPostStatus; verdict?: ClaudeAutoVerdictRecord | null } | null | undefined,
): string | null {
  const v = a?.verdict;
  if (a == null || v == null || v.wanted === 'COMMENT') return null;
  if (v.heldReason == null) {
    if (a.status !== 'posted' && a.status !== 'partial') return null;
    return v.submitted === 'APPROVE' ? 'Approved automatically.' : 'Requested changes automatically.';
  }
  const verb = v.wanted === 'APPROVE' ? 'Not approved' : 'Changes not requested';
  switch (v.heldReason) {
    case 'own_pr':
      return `${verb}: this is your own PR.`;
    case 'prior_review':
      return `${verb}: your last review on GitHub still stands.`;
    case 'reviews_unreadable':
      return `${verb}: couldn’t read your earlier reviews on GitHub.`;
    case 'refused':
      return a.status === 'posted' || a.status === 'partial'
        ? `${verb}: GitHub refused it, so the comments were posted on their own.`
        : `${verb}: GitHub refused it.`;
    default:
      return null;
  }
}

/** A finding's auto-resolve, in words: resolved, or why not. null when it was never tried. */
export function autoResolveLabel(r: FindingAutoResolveRecord | null | undefined): string | null {
  if (r == null) return null;
  if (r.status === 'resolved') return 'Resolved automatically';
  if (r.status === 'resolving') return 'Resolving automatically';
  const why = r.error != null && r.error.trim() !== '' ? r.error.trim() : 'GitHub did not accept it.';
  return `Couldn’t resolve automatically: ${why}`;
}
