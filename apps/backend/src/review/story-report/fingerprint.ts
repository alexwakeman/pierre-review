import { createHash } from 'node:crypto';
import type { StoryReportWindowChoice } from '@pierre-review/shared';
import type { StoryInternals } from '../../db/stories.js';

// THE STORY REPORT'S CURRENCY — a stored report is 'stale' when this differs from today's. Pure.
//
// sha256 over a canonical JSON of: a FORMAT TAG (`STORY_REPORT_FORMAT` — bumped when what the agent
// is given or asked for changes, so older reports read stale), the window choice, the picked stories sorted by ident, and for
// each its latest ticket review id (or null) and its PRs sorted by id as [id, state, mergedAt ISO].
// ⚠ NOTHING DERIVED FROM `now`: a dormant workspace's report stays current. With a trailing window the
// picks move as it slides, which is the honest stale signal (the report covers other stories now).

/** v2: the four story issues (per-pick issues, whole-window issue rates, an issue per point).
 *  v3: the lean report. v4: the THREE specific story issues (rubric 2: reasons, blockers, spec gaps).
 *  v5: Story health's measures for the rates (criteria that can't be checked; linked blockers only).
 *  v6: briefer (one-sentence point details, one example ticket per point) and the real-blocker rule
 *  (inputs named in the text are no longer dependencies). */
export const STORY_REPORT_FORMAT = 'story-report-v6';

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
    format: STORY_REPORT_FORMAT,
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
