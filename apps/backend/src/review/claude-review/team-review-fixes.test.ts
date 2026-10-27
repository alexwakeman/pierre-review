// Review fixes on the team-review batch (claims, pairs, replies) — the pure halves:
//   • a Claude + Codex pair covers own-finding replies only as far as its EARLIER-reaching half
//     (db/queries.ts `pairOwnCoveredMs`, auto.ts `commentBurstRoute`), and a finding's judged-through
//     base is the half whose chain listed it (replies-pass.ts `judgedThroughFor`);
//   • a replies pass that left threads out over the cap does not cover their replies
//     (replies-check.ts `passCoverageMs`);
//   • a rate-limit 403 on a status call is not "no write access" (team-claim.ts).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Never the reader's database: db/queries.ts opens the client at import.
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), 'limn-team-review-fixes-')), 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

const at = (ms: number): Date => new Date(ms);

describe('a pair covers own-finding replies only as far as its earlier-reaching half', () => {
  it('pairOwnCoveredMs', async () => {
    const { pairOwnCoveredMs } = await import('../../db/queries.js');
    // An ordinary run: its comments_through, else its start.
    expect(pairOwnCoveredMs([{ createdAt: at(10), commentsThrough: null }])).toBe(10);
    expect(pairOwnCoveredMs([{ createdAt: at(10), commentsThrough: at(30) }])).toBe(30);
    // A pair: Claude half reached 12, the Codex half 50 ⇒ 12 (the Codex half never judged Claude's threads).
    expect(
      pairOwnCoveredMs([
        { createdAt: at(10), commentsThrough: at(12), pairId: 1 },
        { createdAt: at(40), commentsThrough: at(50), pairId: 1 },
      ]),
    ).toBe(12);
    // A later ordinary run still covers everything it saw.
    expect(
      pairOwnCoveredMs([
        { createdAt: at(10), commentsThrough: at(12), pairId: 1 },
        { createdAt: at(40), commentsThrough: at(50), pairId: 1 },
        { createdAt: at(60), commentsThrough: null, pairId: null },
      ]),
    ).toBe(60);
  });

  it('commentBurstRoute: an own reply past the pair’s first half routes a replies pass', async () => {
    const { commentBurstRoute } = await import('./auto.js');
    const base = { commentsAtMs: 20, reviewCoveredMs: 50, newestOwnThreadCommentAtMs: 20, checkCoveredMs: null };
    expect(commentBurstRoute(base)).toBe('covered');
    expect(commentBurstRoute({ ...base, ownReviewCoveredMs: 12 })).toBe('replies');
    expect(commentBurstRoute({ ...base, ownReviewCoveredMs: 12, repliesCoveredMs: 20 })).toBe('covered');
  });

  it('judgedThroughFor: each finding’s base is the run whose chain listed it', async () => {
    const { judgedThroughFor } = await import('./replies-pass.js');
    const full = { createdAtMs: 40, commentsThroughMs: 50 };
    const plain = judgedThroughFor(full, []);
    expect(plain(1)).toBe(50);
    const paired = judgedThroughFor(full, [], new Map([[1, { createdAtMs: 10, commentsThroughMs: null }]]));
    expect(paired(1)).toBe(10); // a Claude finding: the Claude half's reach
    expect(paired(2)).toBe(50); // a finding the map does not list: the full row's
    // A later pass that JUDGED finding 1 still moves it on.
    const withPass = judgedThroughFor(
      full,
      [{ createdAtMs: 70, commentsThroughMs: null, items: [{ priorFindingId: 1, status: 'reply_accepted' }] }],
      new Map([[1, { createdAtMs: 10, commentsThroughMs: null }]]),
    );
    expect(withPass(1)).toBe(70);
  });
});

describe('a replies pass never covers replies it left out', () => {
  it('passCoverageMs', async () => {
    const { passCoverageMs } = await import('./replies-check.js');
    // Nothing left out: the newest judged reply, or the burst it was started for.
    expect(passCoverageMs(100, 120, [])).toBe(120);
    expect(passCoverageMs(100, null, [])).toBe(100);
    // Left out over the cap (replies at 90 and 130): held just below the oldest of them.
    expect(passCoverageMs(100, 130, [90, 130])).toBe(89);
    expect(passCoverageMs(100, 130, [150])).toBe(130);
  });
});

describe('team claims: a rate limit is not "no write access"', () => {
  it('isNoAccessError / claimErrorKind', async () => {
    const { isNoAccessError, claimErrorKind } = await import('./team-claim.js');
    const { isLimited } = await import('../../github/rate-budget.js');
    const forbidden = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    const limited = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      response: { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } },
    });
    const secondary = Object.assign(new Error('You have exceeded a secondary rate limit'), {
      status: 403,
      response: { status: 403, headers: { 'retry-after': '60' } },
    });
    expect(isNoAccessError(forbidden)).toBe(true);
    expect(isNoAccessError(Object.assign(new Error('nope'), { status: 404 }))).toBe(true);
    expect(isNoAccessError(limited)).toBe(false);
    expect(isNoAccessError(secondary)).toBe(false);
    expect(claimErrorKind(forbidden, 91)).toBe('no_access');
    expect(isLimited(92)).toBe(false);
    expect(claimErrorKind(secondary, 92)).toBe('rate_limited');
    // …and the account's rate budget learns of it.
    expect(isLimited(92)).toBe(true);
    expect(claimErrorKind(new Error('socket hang up'), 93)).toBe('error');
  });
});
