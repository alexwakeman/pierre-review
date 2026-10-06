// AUTO-POSTING ON SCREEN — the words the Claude Review tab and Story check use for what
// auto-posting did (docs/CLAUDE-REVIEW.md § Auto-posting). Pure, so the copy is pinned by
// test/autoPost.test.ts.
import type { AutoPostStatus } from '@pierre-review/shared';
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
