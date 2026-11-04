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
});

describe('the settings', () => {
  const src = readFileSync(new URL('../src/components/settings/AutoReviewSection.tsx', import.meta.url), 'utf8');
  it('offers both opt-ins, saved with the auto-post settings, explained behind an ⓘ', () => {
    expect(src).toContain('Teammates’ Limn may lift my Limn’s block once every point is addressed');
    expect(src).toContain('Lift a teammate’s Limn block when everything is addressed');
    expect(src).toContain('teamLiftConsent: liftConsent');
    expect(src).toContain('liftTeammateBlocks: liftTeammates');
    expect(src).toContain('<InfoButton title="Teammates’ Limn blocks">');
  });
});
