// THE STALENESS FOLD (sibling-stale.ts), pure: a finished, unpushed fix read its ticket's other PRs at some state;
// it is STALE when one of them moved on — its head moved, the fix of it that was laid on top was discarded or
// changed, or a newer fix of it was built. A push of the very fix it read is NOT a change.
//
//   pnpm --filter @pierre-review/backend test ai-fix/sibling-stale
import { describe, expect, it } from 'vitest';
import { overlayUnpushed, overlayUnpushedHoldLine, patchHash, readSiblingState, siblingStaleLine, siblingStaleness, type FixSiblingState, type SiblingNow } from './sibling-stale.js';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const PUSHED = '3'.repeat(40);
const read = (o: Partial<FixSiblingState> = {}): FixSiblingState => ({ prId: 7, number: 12, repoId: 2, headSha: H1, overlayFixId: null, overlayPatchHash: null, at: 1_000, ...o });
const now = (o: Partial<SiblingNow> = {}): Map<number, SiblingNow> => new Map([[7, { headSha: H1, overlay: null, built: [], ...o }]]);

describe('siblingStaleness', () => {
  it('the head alone: fresh while the head is the one read; stale when it moved; an unknown head is never "moved"', () => {
    expect(siblingStaleness([read()], now())).toBeNull();
    expect(siblingStaleness([read()], now({ headSha: H2 }))).toEqual({ prNumber: 12 });
    expect(siblingStaleness([read()], now({ headSha: null }))).toBeNull();
    expect(siblingStaleLine(12)).toBe('#12 changed after this fix was built.');
  });

  it('an overlay: stale when the overlaid fix is discarded, gone, or its patch changed; its OWN push is not a change', () => {
    const h = patchHash('diff a');
    const o = read({ overlayFixId: 40, overlayPatchHash: h });
    const live = { discarded: false, pushed: false, pushedCommitSha: null, patchHash: h };
    expect(siblingStaleness([o], now({ overlay: live, built: [{ fixId: 40, finishedAtMs: 900 }] }))).toBeNull();
    expect(siblingStaleness([o], now({ overlay: { ...live, discarded: true } }))).toEqual({ prNumber: 12 });
    expect(siblingStaleness([o], now({ overlay: null }))).toEqual({ prNumber: 12 });
    expect(siblingStaleness([o], now({ overlay: { ...live, patchHash: patchHash('diff b') } }))).toEqual({ prNumber: 12 });
    // Pushed: the head moved to THAT push ⇒ the same code; moved anywhere else ⇒ stale.
    const pushed = { ...live, pushed: true, pushedCommitSha: PUSHED };
    expect(siblingStaleness([o], now({ headSha: PUSHED, overlay: pushed }))).toBeNull();
    expect(siblingStaleness([o], now({ headSha: H2, overlay: pushed }))).toEqual({ prNumber: 12 });
  });

  it('a newer built fix of the sibling (not among those built when this fix read it) makes it stale; the overlaid one does not', () => {
    const seen = read({ builtFixIds: [39] });
    expect(siblingStaleness([seen], now({ built: [{ fixId: 39, finishedAtMs: 9_000 }] }))).toBeNull();
    expect(siblingStaleness([seen], now({ built: [{ fixId: 41, finishedAtMs: 500 }] }))).toEqual({ prNumber: 12 });
    // An entry without the list: by time.
    expect(siblingStaleness([read()], now({ built: [{ fixId: 41, finishedAtMs: 2_000 }] }))).toEqual({ prNumber: 12 });
    expect(siblingStaleness([read()], now({ built: [{ fixId: 41, finishedAtMs: 500 }] }))).toBeNull();
    const o = read({ overlayFixId: 41, overlayPatchHash: 'x' });
    expect(siblingStaleness([o], now({ overlay: { discarded: false, pushed: false, pushedCommitSha: null, patchHash: 'x' }, built: [{ fixId: 41, finishedAtMs: 2_000 }] }))).toBeNull();
  });

  it('① a newer built fix of the sibling that was built ON TOP OF this fix (it overlays this fix) does not make it stale', () => {
    const seen = read({ builtFixIds: [] });
    expect(siblingStaleness([seen], now({ built: [{ fixId: 41, finishedAtMs: 2_000, buildsOn: [77] }] }), 77)).toBeNull();
    // Built on ANOTHER fix (or on nothing): it still counts.
    expect(siblingStaleness([seen], now({ built: [{ fixId: 41, finishedAtMs: 2_000, buildsOn: [76] }] }), 77)).toEqual({ prNumber: 12 });
    expect(siblingStaleness([seen], now({ built: [{ fixId: 41, finishedAtMs: 2_000 }] }), 77)).toEqual({ prNumber: 12 });
    // The head moved still counts, whatever the sibling's fix builds on.
    expect(siblingStaleness([seen], now({ headSha: H2, built: [{ fixId: 41, finishedAtMs: 2_000, buildsOn: [77] }] }), 77)).toEqual({ prNumber: 12 });
  });

  it('② built on an UNPUSHED sibling fix: named until that fix is pushed; a discarded one is stale instead; none ⇒ null', () => {
    const o = read({ overlayFixId: 40, overlayPatchHash: 'x' });
    const live = { discarded: false, pushed: false, pushedCommitSha: null, patchHash: 'x' };
    expect(overlayUnpushed([o], now({ overlay: live }))).toEqual({ prNumber: 12 });
    expect(overlayUnpushedHoldLine(12)).toBe("Not pushed: it builds on #12's AI Fix, which is not pushed yet.");
    expect(overlayUnpushed([o], now({ overlay: { ...live, pushed: true, pushedCommitSha: PUSHED }, headSha: PUSHED }))).toBeNull();
    expect(overlayUnpushed([o], now({ overlay: { ...live, discarded: true } }))).toBeNull();
    expect(siblingStaleness([o], now({ overlay: { ...live, discarded: true } }))).toEqual({ prNumber: 12 });
    expect(overlayUnpushed([read()], now())).toBeNull();
  });

  it('the first sibling that changed is named; a sibling with no facts is skipped', () => {
    const two = [read(), read({ prId: 8, number: 13 })];
    const m = new Map<number, SiblingNow>([[8, { headSha: H2, overlay: null, built: [] }]]);
    expect(siblingStaleness(two, m)).toEqual({ prNumber: 13 });
  });

  it('readSiblingState drops what is malformed', () => {
    expect(readSiblingState(null)).toEqual([]);
    expect(readSiblingState([{ prId: 1 }, 'x', read()])).toEqual([read()]);
  });
});
