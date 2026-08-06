// The batching logic behind ML enrichment (docs/ML-SEVERITY.md § batching).
//
// This is the part worth pinning because it is where the feature's whole load-time argument
// lives: inference cost tracks TOTAL TEXT and a batch pads to its longest member, so the packer
// budgets characters rather than items. A regression here is invisible — everything still gets
// labelled, just several times slower — which is exactly the kind of thing a test has to catch.
import { describe, expect, it } from 'vitest';
import { packBatches, truncateOnCodePoint } from './ml-enrichment.js';
import { SeverityApiError, severityApiAnswered } from '../ml/severity-client.js';
import type { MlCandidate } from '../db/ml-labels.js';

let nextId = 1;
function candidate(len: number): MlCandidate {
  const id = nextId++;
  return {
    targetKind: 'review_comment',
    targetId: id,
    prId: 1,
    repoId: 1,
    authorUserId: 1,
    body: 'x'.repeat(len),
    diffHunk: null,
    path: null,
    targetCreatedAt: new Date(0),
  };
}

describe('packBatches', () => {
  it('closes a batch on the CHARACTER budget, not just the item count', () => {
    // 10 items of 100 chars with a 250-char budget → pairs, never one batch of 10. The packer
    // closes a batch BEFORE the item that would exceed the budget, so 3×100 never happens.
    const batches = packBatches(
      Array.from({ length: 10 }, () => candidate(100)),
      128,
      250,
    );
    expect(batches.map((b) => b.length)).toEqual([2, 2, 2, 2, 2]);
    for (const b of batches) {
      expect(b.reduce((n, c) => n + c.body.length, 0)).toBeLessThanOrEqual(250);
    }
  });

  it('closes a batch on the item cap when the text budget is generous', () => {
    const batches = packBatches(
      Array.from({ length: 10 }, () => candidate(10)),
      4,
      1_000_000,
    );
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
  });

  it('gives an over-budget item its OWN batch rather than dropping it', () => {
    // A single 5000-char walkthrough cannot fit a 1000-char budget. Dropping it would leave a
    // target that is re-selected as a candidate on every tick, forever.
    const batches = packBatches([candidate(100), candidate(5000), candidate(100)], 128, 1000);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(batches.flat()).toHaveLength(3);
  });

  it('never loses or duplicates an item', () => {
    const items = [10, 4000, 30, 900, 5, 2200, 7, 60].map(candidate);
    const flat = packBatches(items, 3, 1000).flat();
    expect(flat).toHaveLength(items.length);
    expect(new Set(flat.map((c) => c.targetId)).size).toBe(items.length);
  });

  it('returns no batches for no candidates', () => {
    expect(packBatches([], 128, 24_000)).toEqual([]);
  });

  it('keeps a length-sorted pool internally uniform — the point of the whole exercise', () => {
    // The worker sorts by body length before packing. With that ordering, no batch mixes a tiny
    // comment with a huge one, so padding waste stays near zero. Without the sort, the same
    // items produce batches whose longest member dwarfs its siblings.
    const lengths = [5, 5000, 8, 4800, 12, 5200, 15, 4900];
    const sorted = [...lengths].sort((a, b) => a - b).map(candidate);
    const batches = packBatches(sorted, 128, 6000);
    for (const b of batches) {
      const min = Math.min(...b.map((c) => c.body.length));
      const max = Math.max(...b.map((c) => c.body.length));
      // Within a batch, the longest is never an order of magnitude past the shortest.
      expect(max).toBeLessThanOrEqual(Math.max(min * 10, 6000));
    }
    // And the tiny comments end up together rather than one-per-batch behind a walkthrough.
    expect(batches[0]!.length).toBeGreaterThan(1);
  });
});

// The worker turns a batch failure into `serviceHealthy`, which /api/ml-status reports and the
// sync UI uses to decide whether to show a scoring phase at all. So "the service rejected this
// batch" and "the service is not there" have to stay distinguishable: conflating them made a
// healthy severity-api read as down the moment one comment 500'd (four in this repo's own dev
// database reliably do), which would hide a scoring pass that was in fact about to run fine on
// the rest of the corpus.
describe('severityApiAnswered — reachability vs a rejected batch', () => {
  it('treats any HTTP answer, including a 500, as proof the service is up', () => {
    expect(severityApiAnswered(new SeverityApiError('severity-api 500: boom', 500))).toBe(true);
    expect(severityApiAnswered(new SeverityApiError('severity-api 422: too big', 422))).toBe(
      true,
    );
  });

  it('treats a transport failure as unreachable', () => {
    expect(
      severityApiAnswered(new SeverityApiError('severity-api unreachable: ECONNREFUSED', null)),
    ).toBe(false);
  });

  it('treats anything that is not a SeverityApiError as unreachable', () => {
    // Conservative on purpose: an unrecognised failure must not be able to assert health.
    expect(severityApiAnswered(new Error('something else'))).toBe(false);
    expect(severityApiAnswered('nope')).toBe(false);
  });
});


// The client-side trim, and the one thing it must never do.
//
// `String.prototype.slice` counts UTF-16 code units, so cutting at 6000 can land between the
// halves of an astral character and leave a lone surrogate — the one thing UTF-8 cannot encode.
// `JSON.stringify` emits it as a bare \ud83d escape, so it travels fine and detonates at the far
// end: the severity-api's tokenizer 500'd the WHOLE batch, and because the candidate query is
// "rows with no label yet", the same comment returned every tick forever. This is exactly how one
// real comment pinned a workspace's backlog — its 6000th code unit landed inside a 💡.
describe('truncateOnCodePoint', () => {
  const EMOJI = '\u{1F4A1}'; // 💡 — two UTF-16 code units, "💡"

  it('never leaves a lone surrogate, whichever half the cut lands on', () => {
    // "ab💡" — cutting at 3 would keep 'a','b' and the HIGH half only.
    const text = `ab${EMOJI}`;
    expect(text.length).toBe(4);
    expect(truncateOnCodePoint(text, 3)).toBe('ab');
    // Cutting at 4 keeps the complete pair.
    expect(truncateOnCodePoint(text, 4)).toBe(text);
    // Every prefix length is encodable — the property that actually matters.
    for (let n = 0; n <= text.length + 2; n += 1) {
      expect(hasLoneSurrogate(truncateOnCodePoint(text, n))).toBe(false);
    }
  });

  it('reproduces the real failure at the real budget', () => {
    // The shape of pr_comment 151836: long enough to trim, with an emoji straddling char 6000.
    const body = `${'x'.repeat(5999)}${EMOJI}${'y'.repeat(500)}`;
    expect(body.charCodeAt(5999)).toBeGreaterThanOrEqual(0xd800); // high half sits AT the cut
    const sent = truncateOnCodePoint(body, 6000);
    expect(sent.length).toBe(5999);
    expect(hasLoneSurrogate(sent)).toBe(false);
    // The old behaviour, kept as the contrast that makes this test mean something.
    expect(hasLoneSurrogate(body.slice(0, 6000))).toBe(true);
  });

  it('leaves anything under the cap completely alone', () => {
    for (const text of ['', 'plain ascii', `emoji ${EMOJI} inside`, '日本語 café']) {
      expect(truncateOnCodePoint(text, 6000)).toBe(text);
    }
  });

  it('drops at most one code unit — the trim must stay a trim', () => {
    const text = `${'a'.repeat(100)}${EMOJI}${'b'.repeat(100)}`;
    for (let n = 1; n <= text.length; n += 1) {
      const out = truncateOnCodePoint(text, n);
      expect(out.length).toBeGreaterThanOrEqual(n - 1);
      expect(out.length).toBeLessThanOrEqual(n);
      expect(text.startsWith(out)).toBe(true); // always a prefix, never re-encoded
    }
  });

  it('handles a zero/negative budget without throwing', () => {
    expect(truncateOnCodePoint(`${EMOJI}abc`, 0)).toBe('');
    expect(truncateOnCodePoint(`${EMOJI}abc`, -5)).toBe('');
  });
});

/** True when the string cannot be encoded as UTF-8 — i.e. it holds an unpaired surrogate. */
function hasLoneSurrogate(text: string): boolean {
  return Buffer.from(text, 'utf8').toString('utf8') !== text;
}
