// A TEAMMATE'S VERDICT — the pure pick-up fold (db/teammate-verdict-pickup.ts; docs/TEAM-REVIEW.md § 4).
//
//   pnpm --filter @pierre-review/backend test teammate-verdict-pickup
import { describe, expect, it } from 'vitest';
import { verdictPickupCandidates, type VerdictPickupRow } from './teammate-verdict-pickup.js';

const READER = 1;
const ALEX = 2; // a teammate, the author of the PRs below
const ROBIN = 3; // another teammate
const FLOOR = 1_000_000;

const pr = (id: number, ownerId: number | null = ALEX, headSha = `h${id}`) => ({ id, ownerId, headSha });
const tm = (prId: number, headSha: string, by: number, postedAtMs: number, ov: 'APPROVE' | null = null): VerdictPickupRow => ({
  prId,
  headSha,
  kind: 'teammate',
  status: 'succeeded',
  createdAtMs: postedAtMs,
  finishedAtMs: postedAtMs,
  sourceUserId: by,
  postedAtMs,
  ownPrVerdict: ov,
});
const own = (prId: number, headSha: string, status = 'succeeded', at = FLOOR + 10): VerdictPickupRow => ({
  prId,
  headSha,
  kind: 'own',
  status,
  createdAtMs: at,
  finishedAtMs: at + 5,
  sourceUserId: null,
  postedAtMs: null,
});
const run = (prs: ReturnType<typeof pr>[], rows: VerdictPickupRow[], readerUserId: number | null = READER) =>
  verdictPickupCandidates({ prs, rows, readerUserId, floorMs: FLOOR });

describe('verdictPickupCandidates', () => {
  it("picks up the author's own Limn review at the head, its held APPROVE first", () => {
    const out = run(
      [pr(10), pr(11), pr(12)],
      [tm(10, 'h10', ALEX, FLOOR + 50), tm(11, 'h11', ALEX, FLOOR + 90, 'APPROVE'), tm(12, 'h12', ALEX, FLOOR + 20)],
    );
    expect(out.map((c) => [c.prId, c.reason, c.authorVerdict])).toEqual([
      [11, 'author_review', 'APPROVE'],
      // then the longest wait first
      [12, 'author_review', null],
      [10, 'author_review', null],
    ]);
    expect(out[0]).toMatchObject({ authorUserId: ALEX, waitingSinceMs: FLOOR + 90, lastRunAtMs: null });
  });

  it("never offers the reader's own PR, and nothing at all without a known reader", () => {
    expect(run([pr(10, READER)], [tm(10, 'h10', ROBIN, FLOOR + 50)])).toEqual([]);
    expect(run([pr(10)], [tm(10, 'h10', ALEX, FLOOR + 50, 'APPROVE')], null)).toEqual([]);
    expect(run([pr(10, null)], [tm(10, 'h10', ALEX, FLOOR + 50)])).toEqual([]);
  });

  it("a non-author teammate's Limn review at the head is a verdict: nothing owed", () => {
    expect(run([pr(10)], [tm(10, 'h10', ALEX, FLOOR + 50, 'APPROVE'), tm(10, 'h10', ROBIN, FLOOR + 60)])).toEqual([]);
  });

  it("any run of the reader's at the head settles it (a failed one is the retry path's); a run in flight holds it", () => {
    expect(run([pr(10)], [tm(10, 'h10', ALEX, FLOOR + 50), own(10, 'h10', 'failed')])).toEqual([]);
    expect(run([pr(10)], [tm(10, 'h10', ALEX, FLOOR + 50), own(10, 'old', 'running')])).toEqual([]);
  });

  it("the reader's earlier review at an older head does not stop an author's review at the head", () => {
    const out = run([pr(10)], [own(10, 'old', 'succeeded', FLOOR + 5), tm(10, 'h10', ALEX, FLOOR + 50, 'APPROVE')]);
    expect(out).toEqual([
      expect.objectContaining({ prId: 10, reason: 'author_review', lastRunAtMs: FLOOR + 10 }),
    ]);
  });

  it('a head moved past teammates’ reviews only is owed a verdict; the reader’s own history is not this list', () => {
    expect(run([pr(10)], [tm(10, 'old', ROBIN, FLOOR + 50)])).toEqual([
      expect.objectContaining({ prId: 10, reason: 'moved', authorVerdict: null, waitingSinceMs: FLOOR + 50 }),
    ]);
    expect(run([pr(10)], [tm(10, 'old', ROBIN, FLOOR + 50), own(10, 'older')])).toEqual([]);
  });

  it('reviews posted before the workspace switched auto review on never count', () => {
    expect(run([pr(10), pr(11)], [tm(10, 'h10', ALEX, FLOOR - 1, 'APPROVE'), tm(11, 'old', ROBIN, FLOOR - 1)])).toEqual([]);
  });

  it('author reviews come before moved heads, however long a moved head waited', () => {
    const out = run([pr(10), pr(11)], [tm(10, 'old', ROBIN, FLOOR + 1), tm(11, 'h11', ALEX, FLOOR + 99)]);
    expect(out.map((c) => c.prId)).toEqual([11, 10]);
  });
});
