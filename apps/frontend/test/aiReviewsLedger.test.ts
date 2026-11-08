// Pending → "AI reviews": the SEEN BLOCKS (lib/aiReviewsLedger.ts, store/aiReviewsSeen.ts).
//
// WHAT THIS PINS:
//   1. Blocks: New on top, then one block per visit (newest first), then the unlabelled rest; each
//      block keeps the server's order.
//   2. Rows that arrive by poll during a visit join that visit; a new review on a PR already in a
//      seen block goes to New and REPLACES its PR's entry (one entry per PR).
//   3. A never-looked workspace records nothing; no ledger entry ⇒ the unlabelled rest.
//   4. Labels: "Seen today 14:32" / "Seen yesterday 09:10" / "Seen Tue 4 Nov 16:17".
//   5. Pruning (60 days, 600 entries), cross-tab merge (earliest wins), malformed storage.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/aiReviewsLedger.test.ts
import { describe, expect, it } from 'vitest';
import {
  AI_REVIEWS_LEDGER_MAX_ENTRIES,
  emptyLedger,
  groupAiReviews,
  mergeLedgers,
  parseLedger,
  pruneLedger,
  recordSeen,
  rowsToRecord,
  seenBlockLabel,
  type AiReviewsLedger,
} from '../src/lib/aiReviewsLedger.js';

// Local-time dates, so the labels do not depend on the machine's time zone.
const NOW = new Date(2026, 10, 8, 15, 0).getTime(); // Sun 8 Nov 2026 15:00
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime();
const row = (reviewId: number, atMs: number, prId = reviewId + 1000) => ({ reviewId, prId, at: new Date(atMs).toISOString() });
const ids = (rs: readonly { reviewId: number }[]): number[] => rs.map((r) => r.reviewId);

describe('seenBlockLabel', () => {
  it('today, yesterday, then weekday + date', () => {
    expect(seenBlockLabel(at(8, 14, 32), NOW)).toBe('Seen today 14:32');
    expect(seenBlockLabel(at(7, 9, 10), NOW)).toBe('Seen yesterday 09:10');
    expect(seenBlockLabel(at(3, 16, 17), NOW)).toBe('Seen Tue 3 Nov 16:17');
    expect(seenBlockLabel(new Date(2025, 11, 30, 8, 5).getTime(), new Date(2026, 0, 2, 9).getTime())).toBe(
      'Seen Tue 30 Dec 2025 08:05',
    );
  });
});

describe('groupAiReviews', () => {
  it('New on top, then one block per visit newest first, then the rest; server order kept', () => {
    const baseline = at(8, 12);
    const visit = at(8, 14, 32);
    const ledger: AiReviewsLedger = {
      v: 1,
      seen: { '6': [at(7, 9, 10), 1006], '4': [at(8, 10), 1004], '3': [at(7, 9, 10), 1003] },
    };
    // Server order: newest first.
    const rows = [row(9, at(8, 13)), row(8, at(8, 12, 30)), row(6, at(7, 9)), row(5, at(6, 9)), row(4, at(5, 9)), row(3, at(4, 9))];
    const blocks = groupAiReviews(rows, ledger, baseline, visit, NOW);
    expect(blocks.map((b) => b.kind)).toEqual(['new', 'seen', 'seen', 'rest']);
    expect(ids(blocks[0]!.rows)).toEqual([9, 8]);
    expect(blocks[1]).toMatchObject({ label: 'Seen today 10:00' });
    expect(ids(blocks[1]!.rows)).toEqual([4]);
    expect(blocks[2]).toMatchObject({ label: 'Seen yesterday 09:10' });
    expect(ids(blocks[2]!.rows)).toEqual([6, 3]);
    expect(ids(blocks[3]!.rows)).toEqual([5]);
  });

  it('a row recorded THIS visit stays under New for the rest of the visit', () => {
    const baseline = at(8, 12);
    const visit = at(8, 14);
    const ledger = recordSeen(emptyLedger(), [row(9, at(8, 13))], visit, NOW);
    const blocks = groupAiReviews([row(9, at(8, 13))], ledger, baseline, visit, NOW);
    expect(blocks.map((b) => b.kind)).toEqual(['new']);
    // The NEXT visit: the server's stamp has moved past it, so it is that visit's block.
    const next = groupAiReviews([row(9, at(8, 13))], ledger, at(8, 13), at(8, 15), NOW);
    expect(next.map((b) => [b.kind, b.kind === 'seen' ? b.label : null])).toEqual([['seen', 'Seen today 14:00']]);
  });

  it('a row this browser saw in an EARLIER visit is not New again, even if the stamp lags', () => {
    const ledger: AiReviewsLedger = { v: 1, seen: { '9': [at(8, 9), 1009] } };
    const blocks = groupAiReviews([row(9, at(8, 8))], ledger, at(8, 7), at(8, 14), NOW);
    expect(blocks.map((b) => b.kind)).toEqual(['seen']);
  });

  it('no ledger at all lists every non-New row flat, with no heading', () => {
    const blocks = groupAiReviews([row(2, at(8, 9)), row(1, at(8, 8))], emptyLedger(), at(8, 10), at(8, 14), NOW);
    expect(blocks).toEqual([{ kind: 'rest', key: 'rest', rows: [row(2, at(8, 9)), row(1, at(8, 8))] }]);
  });

  it('never looked: every row is New and there is nothing else', () => {
    const blocks = groupAiReviews([row(2, at(8, 9)), row(1, at(8, 8))], emptyLedger(), null, at(8, 14), NOW);
    expect(blocks.map((b) => b.kind)).toEqual(['new']);
  });
});

describe('rowsToRecord + recordSeen', () => {
  it('records New rows at the visit start; rows arriving by poll join the same visit', () => {
    const baseline = at(8, 12);
    const visit = at(8, 14, 32);
    let l = emptyLedger();
    const first = [row(9, at(8, 13)), row(2, at(8, 9))];
    l = recordSeen(l, rowsToRecord(first, l, baseline), visit, NOW);
    expect(l.seen).toEqual({ '9': [visit, 1009] });
    // A poll brings review 10 during the same visit.
    const polled = [row(10, at(8, 14, 40)), ...first];
    l = recordSeen(l, rowsToRecord(polled, l, baseline), visit, NOW);
    expect(l.seen).toEqual({ '9': [visit, 1009], '10': [visit, 1010] });
    // Nothing new: the same object comes back (no write).
    expect(recordSeen(l, rowsToRecord(polled, l, baseline), visit, NOW)).toBe(l);
  });

  it('a never-looked workspace records nothing', () => {
    expect(rowsToRecord([row(9, at(8, 13))], emptyLedger(), null)).toEqual([]);
  });

  it('a new review on a PR already in a seen block moves the PR to New and replaces its entry', () => {
    const old: AiReviewsLedger = { v: 1, seen: { '5': [at(7, 9), 77] } };
    // Review 12 is PR 77's re-review; the server lists only the newest per PR.
    const rows = [row(12, at(8, 13), 77)];
    const blocks = groupAiReviews(rows, old, at(8, 12), at(8, 14), NOW);
    expect(blocks.map((b) => b.kind)).toEqual(['new']);
    const l = recordSeen(old, rowsToRecord(rows, old, at(8, 12)), at(8, 14), NOW);
    expect(l.seen).toEqual({ '12': [at(8, 14), 77] });
  });
});

describe('prune, merge, parse', () => {
  it('drops entries older than 60 days and keeps the newest 600', () => {
    const seen: AiReviewsLedger['seen'] = { '1': [NOW - 61 * 86_400_000, 1], '2': [NOW - 59 * 86_400_000, 2] };
    expect(Object.keys(pruneLedger({ v: 1, seen }, NOW).seen)).toEqual(['2']);
    const many: AiReviewsLedger['seen'] = {};
    for (let i = 0; i < 700; i++) many[String(i + 1)] = [NOW - i * 60_000, i + 1];
    const pruned = pruneLedger({ v: 1, seen: many }, NOW).seen;
    expect(Object.keys(pruned)).toHaveLength(AI_REVIEWS_LEDGER_MAX_ENTRIES);
    expect(pruned['1']).toBeDefined();
    expect(pruned['700']).toBeUndefined();
  });

  it('two tabs merge: the earliest seen time wins, one entry per PR', () => {
    const a: AiReviewsLedger = { v: 1, seen: { '9': [at(8, 14), 1009], '5': [at(7, 9), 77] } };
    const b: AiReviewsLedger = { v: 1, seen: { '9': [at(8, 13), 1009], '12': [at(8, 13), 77] } };
    expect(mergeLedgers(a, b).seen).toEqual({ '9': [at(8, 13), 1009], '12': [at(8, 13), 77] });
    expect(mergeLedgers(b, a).seen).toEqual(mergeLedgers(a, b).seen);
  });

  it('malformed storage reads as empty; bad entries are dropped', () => {
    expect(parseLedger(null)).toEqual(emptyLedger());
    expect(parseLedger('{not json')).toEqual(emptyLedger());
    expect(parseLedger('{"v":2,"seen":{}}')).toEqual(emptyLedger());
    expect(parseLedger('[]')).toEqual(emptyLedger());
    expect(parseLedger('{"v":1,"seen":{"3":[5,6],"x":[1,2],"4":["a",1],"5":[1]}}').seen).toEqual({ '3': [5, 6] });
  });
});
