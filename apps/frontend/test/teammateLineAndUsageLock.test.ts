// The AI Review tab's teammate line (docs/CLAUDE-REVIEW.md § Team claims → The teammate's line on the
// tab) and the Run area's usage-limit line (§ Claude + Codex → Usage limits).
import { describe, expect, it } from 'vitest';
import { teammateReviewLine } from '../src/lib/claudeAutoReview.js';
import { usageLockLine, usageLockLines } from '../src/lib/usageLockout.js';

describe('teammateReviewLine', () => {
  const robin = { login: 'robin-dunn', name: 'Robin Dunn', provider: 'claude' as const };
  it('names the teammate, the commit and the provider, with the detail of their own line', () => {
    expect(teammateReviewLine({ ...robin, kind: 'reviewed', description: 'robin-dunn reviewed · no comments' })).toBe(
      'Robin Dunn reviewed this commit with Claude · no comments',
    );
    expect(teammateReviewLine({ ...robin, kind: 'reviewed', description: 'robin-dunn reviewed · 4 comments' })).toBe(
      'Robin Dunn reviewed this commit with Claude · 4 comments',
    );
    expect(teammateReviewLine({ ...robin, kind: 'reviewed', description: 'robin-dunn reviewed · kept in Limn' })).toBe(
      'Robin Dunn reviewed this commit with Claude · not posted on GitHub',
    );
  });
  it('while they review', () => {
    expect(teammateReviewLine({ ...robin, kind: 'reviewing', description: 'robin-dunn is reviewing with Claude' })).toBe(
      'Robin Dunn is reviewing this commit with Claude',
    );
  });
  it('no name known ⇒ @login; no detail ⇒ none; Codex named', () => {
    expect(teammateReviewLine({ login: 'bob', name: null, provider: 'codex', kind: 'reviewed', description: null })).toBe(
      '@bob reviewed this commit with Codex',
    );
  });
});

describe('usageLockLine', () => {
  const now = new Date(2026, 10, 2, 20, 10, 0).getTime();
  it('one plain line until the reset, then nothing', () => {
    const until = new Date(2026, 10, 2, 20, 54, 0);
    const time = until.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(usageLockLine('codex', until.toISOString(), now)).toBe(`Codex is over its usage limit until ${time}.`);
    expect(usageLockLine('codex', until.toISOString(), until.getTime())).toBeNull();
    expect(usageLockLine('codex', null, now)).toBeNull();
  });
  it('another day names the day', () => {
    const until = new Date(2026, 10, 3, 9, 0, 0);
    expect(usageLockLine('codex', until.toISOString(), now)).toMatch(/^Codex is over its usage limit until \S+ .+\.$/);
  });
  it('reads /api/me for each provider asked about', () => {
    const me = {
      ai: { providers: { claude: { usageLockedUntil: null }, codex: { usageLockedUntil: new Date(now + 3_600_000).toISOString() } } },
    } as never;
    expect(usageLockLines(me, ['claude', 'codex'], now)).toHaveLength(1);
    expect(usageLockLines(me, ['claude'], now)).toEqual([]);
    expect(usageLockLines(undefined, ['codex'], now)).toEqual([]);
  });
});
