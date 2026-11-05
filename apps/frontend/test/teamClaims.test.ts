// TEAM CLAIMS on the SPA (docs/CLAUDE-REVIEW.md § Team claims): the AI Review tab's words, and
// Limn's own status lines LISTED in the checks but never COUNTED as CI.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { teamClaimRecordLine, teamClaimSkipLine, teammateReviewLine } from '../src/lib/claudeAutoReview.js';
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
    expect(teamClaimRecordLine({ ...base, state: 'marked', lastLine: 'unfinished' })).toBe('Marked on GitHub, then released');
    expect(teamClaimRecordLine({ ...base, state: 'marked', lastLine: 'superseded' })).toBe('Marked on GitHub; a teammate’s line is newer');
    expect(teamClaimRecordLine({ ...base, state: 'unmarked', reason: 'no_access', lastLine: null })).toBe(
      'Not marked on GitHub: no write access',
    );
    expect(teamClaimRecordLine({ ...base, state: 'unmarked', reason: 'error', lastLine: null })).toBe('Not marked on GitHub');
    expect(teamClaimRecordLine(null)).toBeNull();
  });
});

describe("a teammate's reviewed line on the tab", () => {
  it('carries the verdict from their line; an old "kept in Limn" reads "not posted on GitHub"', () => {
    const t = { kind: 'reviewed' as const, login: 'robin', provider: 'claude' as const };
    expect(teammateReviewLine({ ...t, description: 'robin reviewed · approved' })).toBe('@robin reviewed this commit with Claude · approved');
    expect(teammateReviewLine({ ...t, description: 'robin reviewed · approved · 2 comments' })).toBe(
      '@robin reviewed this commit with Claude · approved · 2 comments',
    );
    expect(teammateReviewLine({ ...t, description: 'robin reviewed · kept in Limn' })).toBe(
      '@robin reviewed this commit with Claude · not posted on GitHub',
    );
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

describe('a teammate reviewing NOW stands out', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
  it('every live "is reviewing" / "Being reviewed by" surface carries the pulsing icon, and "reviewed" does not', () => {
    const icons = read('../src/components/Icons.tsx');
    expect(icons).toMatch(/export function ReviewingNowIcon[\s\S]*motion-safe:animate-pulse/);
    for (const f of ['../src/components/TeamClaimLine.tsx', '../src/components/Activity/OpenPrsAiReview.tsx', '../src/components/Activity/ClaudeReviewCell.tsx']) {
      const s = read(f);
      const at = s.indexOf('<ReviewingNowIcon');
      expect([f, at > 0]).toEqual([f, true]);
    }
    const cell = read('../src/components/Activity/ClaudeReviewCell.tsx');
    expect(cell).toMatch(/Reviewed by @\{teamClaimSkip\.login\}<\/span>/);
  });
});
