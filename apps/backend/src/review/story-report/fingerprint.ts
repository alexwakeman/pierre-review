import { createHash } from 'node:crypto';
import type { StoryReportWindowChoice } from '@pierre-review/shared';
import type { StoryInternals } from '../../db/stories.js';

// THE STORY REPORT'S CURRENCY — a stored report is 'stale' when this differs from today's. Pure.
//
// sha256 over a canonical JSON of: the window choice, the picked stories sorted by ident, and for
// each its latest ticket review id (or null) and its PRs sorted by id as [id, state, mergedAt ISO].
// ⚠ NOTHING DERIVED FROM `now`: a dormant workspace's report stays current. With a trailing window the
// picks move as it slides, which is the honest stale signal (the report covers other stories now).

export interface FingerprintPick {
  ident: string;
  reviewId: number | null;
  prs: Array<{ id: number; state: string; mergedAt: Date | null }>;
}

export function fingerprintPickOf(s: StoryInternals): FingerprintPick {
  return {
    ident: s.row.ident,
    reviewId: s.review?.id ?? null,
    prs: [...s.prs.values()].map((p) => ({ id: p.id, state: p.state, mergedAt: p.mergedAt })),
  };
}

export function storyReportFingerprint(choice: StoryReportWindowChoice, picks: readonly FingerprintPick[]): string {
  const canonical = {
    window: choice,
    picks: [...picks]
      .sort((a, b) => (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0))
      .map((p) => [
        p.ident,
        p.reviewId,
        [...p.prs]
          .sort((a, b) => a.id - b.id)
          .map((pr) => [pr.id, pr.state, pr.mergedAt != null && pr.state === 'merged' ? pr.mergedAt.toISOString() : null]),
      ]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
