// TEAM CLAIMS on the SPA (docs/CLAUDE-REVIEW.md § Team claims): the AI Review tab's words, and
// Limn's own status lines LISTED in the checks but never COUNTED as CI.
import { describe, expect, it } from 'vitest';
import { teamClaimRecordLine, teamClaimSkipLine } from '../src/lib/claudeAutoReview.js';
import { checksSummaryCounts } from '../src/components/ChecksTab.js';

describe('team claim words', () => {
  it('says who holds the commit', () => {
    expect(teamClaimSkipLine({ kind: 'reviewing', login: 'bob' })).toBe('Auto review skipped: being reviewed by @bob');
    expect(teamClaimSkipLine({ kind: 'reviewed', login: 'bob' })).toBe('Auto review skipped: already reviewed by @bob');
    expect(teamClaimSkipLine(null)).toBeNull();
  });
  it('says what the run did on GitHub', () => {
    const base = { context: 'limn/review-claude', at: '2026-10-27T00:00:00Z' };
    expect(teamClaimRecordLine({ ...base, state: 'marked', lastLine: 'reviewed' })).toBe('Marked on GitHub');
    expect(teamClaimRecordLine({ ...base, state: 'marked', lastLine: 'cleared' })).toBe('Marked on GitHub, then cleared');
    expect(teamClaimRecordLine({ ...base, state: 'unmarked', reason: 'no_access', lastLine: null })).toBe(
      'Not marked on GitHub: no write access',
    );
    expect(teamClaimRecordLine({ ...base, state: 'unmarked', reason: 'error', lastLine: null })).toBe('Not marked on GitHub');
    expect(teamClaimRecordLine(null)).toBeNull();
  });
});

describe('checksSummaryCounts', () => {
  it('never counts a Limn line', () => {
    expect(
      checksSummaryCounts([
        { state: 'success' },
        { state: 'pending', limnOwned: true },
        { state: 'failure', limnOwned: true },
      ]),
    ).toEqual({ passed: 1, failing: 0, running: 0, total: 1 });
  });
});
