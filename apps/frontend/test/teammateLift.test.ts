// LIFTING A TEAMMATE'S LIMN BLOCK in the AI Review tab (docs/CLAUDE-REVIEW.md § Lifting a teammate's
// block): one plain line per teammate block the run lifted, or GitHub's words when it refused; and the
// two opt-ins in Settings → Auto review, with their ⓘ.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { teammateLiftLines } from '../src/lib/autoPost.js';

describe('teammateLiftLines', () => {
  it('says nothing when the run lifted no teammate block', () => {
    expect(teammateLiftLines(null)).toEqual([]);
    expect(teammateLiftLines({})).toEqual([]);
  });

  it('names the teammate: dismissed, or why not in GitHub’s words', () => {
    expect(
      teammateLiftLines({
        liftedTeammateBlocks: [
          { teammateReviewId: 1, login: 'robin-dunn', status: 'dismissed', error: null },
          { teammateReviewId: 2, login: 'sam', status: 'failed', error: 'Must have admin rights to Repository.' },
          { teammateReviewId: 3, login: 'kim', status: 'failed', error: null },
        ],
      }),
    ).toEqual([
      { text: 'Dismissed robin-dunn’s request for changes: every point is addressed.', failed: false },
      { text: 'Couldn’t dismiss sam’s request for changes: Must have admin rights to Repository.', failed: true },
      { text: 'Couldn’t dismiss kim’s request for changes: GitHub did not accept it.', failed: true },
    ]);
  });

  it('says when the teammate’s Limn was away', () => {
    expect(
      teammateLiftLines({ liftedTeammateBlocks: [{ teammateReviewId: 1, login: 'robin', status: 'dismissed', error: null, why: 'away' }] }),
    ).toEqual([{ text: 'Dismissed robin’s request for changes: every point is addressed and robin’s Limn is away.', failed: false }]);
  });
});

describe('the settings', () => {
  const src = readFileSync(new URL('../src/components/settings/AutoReviewSection.tsx', import.meta.url), 'utf8');
  it('offers both opt-ins, saved with the auto-post settings, explained behind an ⓘ', () => {
    // Each label says what is dismissed, by whom and when; never "block" (read as an approval).
    expect(src).toContain('Let a teammate’s Limn dismiss my Limn’s “changes requested” once every point is fixed');
    expect(src).toContain('Dismiss a teammate’s Limn “changes requested” once every point is fixed');
    expect(src).toContain('Neither box dismisses or adds an approval.');
    expect(src).not.toContain('Limn block');
    expect(src).toContain('teamLiftConsent: liftConsent');
    expect(src).toContain('liftTeammateBlocks: liftTeammates');
    expect(src).toContain('<InfoButton title="Teammates’ Limn “changes requested”">');
    // The away path is explained in the same ⓘ.
    expect(src).toContain('Without either box, when the teammate’s Limn is away');
  });
});
