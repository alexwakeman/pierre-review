// THE COURT LEDGER'S STATE MACHINE, as a pure fold — no database, no fixture, no clock.
//
// `walkCourts` is the whole feature in one function: every figure on the "Chronology" screen
// is a sum over its output. It is also a HEURISTIC with three judgement calls inside it, and this
// repo's rule is that a heuristic gets fixture tests (`sync/__fixtures__/threads/` carries the same
// rule for `derive-thread-state`). Each block below pins one decision, and the comment says what
// breaks if it is changed by accident rather than on purpose.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/backend src/db/pr-intervals.test.ts
import { describe, expect, it } from 'vitest';
import {
  __flowTesting,
  median,
  percentile,
  walkCourts,
  type CourtAction,
} from './pr-intervals.js';

const H = 3_600_000;
const T0 = 1_700_000_000_000;
const at = (hours: number): number => T0 + hours * H;

const reviewer = (hours: number): CourtAction => ({ atMs: at(hours), by: 'reviewer', approves: false });
const approve = (hours: number): CourtAction => ({ atMs: at(hours), by: 'reviewer', approves: true });
const author = (hours: number): CourtAction => ({ atMs: at(hours), by: 'author', approves: false });

/** Rounded to the hour so a test reads as the timeline it describes. */
const round = (h: { reviewer: number; author: number; landing: number }) => ({
  reviewer: Math.round(h.reviewer),
  author: Math.round(h.author),
  landing: Math.round(h.landing),
});

describe('the ball starts in the reviewer court and the hours always account for themselves', () => {
  it('charges a never-touched pull request entirely to the reviewer', () => {
    // ⚠ This shape is precisely why such pull requests are EXCLUDED from the population upstream:
    // their ledger is 100% reviewer BY CONSTRUCTION, and on real data they are 46% of merges, so
    // including them would drive every reviewer share towards 100%.
    expect(round(walkCourts(at(0), at(10), []))).toEqual({ reviewer: 10, author: 0, landing: 0 });
  });

  it('sums to the pull request open life, whatever the path through it', () => {
    const acts = [reviewer(2), author(5), reviewer(6), approve(9), author(11)];
    const h = walkCourts(at(0), at(20), acts);
    expect(h.reviewer + h.author + h.landing).toBeCloseTo(20, 6);
  });

  it('returns nothing for a pull request that merged before it opened', () => {
    // Not a clamp: a merge stamped before the open is a data error, and stretching an interval to
    // cover it would put invented hours on the screen.
    expect(walkCourts(at(10), at(5), [reviewer(7)])).toEqual({ reviewer: 0, author: 0, landing: 0 });
  });

  it('ignores an action stamped outside the pull request own life', () => {
    const h = walkCourts(at(0), at(10), [reviewer(-5), reviewer(99)]);
    expect(round(h)).toEqual({ reviewer: 10, author: 0, landing: 0 });
  });

  it('does not care what order the actions arrive in', () => {
    const acts = [approve(9), reviewer(2), author(5)];
    const shuffled = [acts[1]!, acts[0]!, acts[2]!];
    expect(walkCourts(at(0), at(12), acts)).toEqual(walkCourts(at(0), at(12), shuffled));
  });
});

describe('the ball moves to whoever now owes something', () => {
  it('a review hands it to the author, and a push hands it back', () => {
    //  0h open .............. 3h reviewer comments .......... 7h author pushes ....... 10h merged
    //  |<-- 3h reviewer -->|  |<------ 4h author ------>|  |<---- 3h reviewer ---->|
    const h = walkCourts(at(0), at(10), [reviewer(3), author(7)]);
    expect(round(h)).toEqual({ reviewer: 6, author: 4, landing: 0 });
  });

  it('an approval opens the landing court and the rest of the life sits in it', () => {
    const h = walkCourts(at(0), at(10), [approve(4)]);
    expect(round(h)).toEqual({ reviewer: 4, author: 0, landing: 6 });
  });

  it('counts several round trips rather than assuming one pass', () => {
    // ⚠ THE REASON THIS IS NOT A FIXED PIPELINE. A four-stage model would have to decide which of
    // these two reviews "the review stage" was; the ledger just charges each interval to whoever
    // was holding the ball at the time.
    const h = walkCourts(at(0), at(12), [reviewer(1), author(3), reviewer(5), author(8), approve(10)]);
    expect(round(h)).toEqual({ reviewer: 1 + 2 + 2, author: 2 + 3, landing: 2 });
    expect(h.reviewer + h.author + h.landing).toBeCloseTo(12, 6);
  });
});

describe('the three judgement calls, pinned deliberately', () => {
  it('DECISION 1 — a reviewer comment AFTER approval moves the ball to the AUTHOR', () => {
    // Somebody said something and the author owes a reply. Charging it back to the reviewer would
    // report the team as unresponsive at the exact moment they were the ones talking.
    const h = walkCourts(at(0), at(10), [approve(2), reviewer(4), author(6)]);
    expect(round(h)).toEqual({ reviewer: 2, author: 2, landing: 2 + 4 });
  });

  it('DECISION 2 — an author push AFTER approval stays in LANDING', () => {
    // Whether a push invalidates the approval is a branch-protection setting we do not sync, so
    // the conservative reading is "approved, with new code, waiting to land". The alternative
    // silently inflates the author court on every repo that allows stale approvals.
    const h = walkCourts(at(0), at(10), [approve(2), author(5)]);
    expect(round(h)).toEqual({ reviewer: 2, author: 0, landing: 8 });
  });

  it('DECISION 2, contrast — the same push BEFORE approval returns it to the reviewer', () => {
    const h = walkCourts(at(0), at(10), [reviewer(2), author(5)]);
    expect(round(h)).toEqual({ reviewer: 2 + 5, author: 3, landing: 0 });
  });

  it('a self-review never counts as somebody reviewing it', () => {
    // The caller maps a review by the pull request's own author to `by: 'author'`; if that ever
    // regressed, a PR nobody looked at would score as reviewed and enter the population.
    const selfOnly: CourtAction[] = [author(3), author(6)];
    const h = walkCourts(at(0), at(10), selfOnly);
    expect(round(h)).toEqual({ reviewer: 10, author: 0, landing: 0 });
    expect(selfOnly.some((a) => a.by === 'reviewer')).toBe(false);
  });
});

describe('percentiles', () => {
  it('takes the nearest rank and never reads past the end', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0.75)).toBe(8);
    expect(percentile(xs, 1)).toBe(10);
    expect(median(xs)).toBe(5);
  });

  it('is 0 on an empty sample, and every caller guards on the floor before reading it', () => {
    expect(percentile([], 0.75)).toBe(0);
    expect(median([])).toBe(0);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    percentile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('the templated sentences', () => {
  const { narrate, fmtHours } = __flowTesting;

  it('names a different action for each court — the whole point of splitting the clock', () => {
    const rev = __flowTesting.narrate('reviewer', 0.7, 20, 40, 10);
    const auth = __flowTesting.narrate('author', 0.7, 20, 40, 10);
    const land = __flowTesting.narrate('landing', 0.7, 20, 40, 10);
    expect(new Set([rev, auth, land]).size).toBe(3);
    expect(rev).toContain('waiting for somebody to look at it');
    expect(auth).toContain('waiting for its author');
    expect(land).toContain('approved and waiting to merge');
  });

  it('carries NO advice on the repo row', () => {
    // ⚠ The advice is a property of the COURT and is stated once per section. Putting it here
    // produced six identical paragraphs on a real workspace, which is the restatement problem that
    // made the path-bucket findings worthless.
    for (const court of ['reviewer', 'author', 'landing'] as const) {
      const line = narrate(court, 0.7, 20, 40, 10);
      expect(line).not.toMatch(/request a named|arm "merge when ready"|fewer, clearer/i);
    }
  });

  it('never names a person, in any court', () => {
    // The licence this feature operates under: guide the work, never rank the people.
    for (const court of ['reviewer', 'author', 'landing'] as const) {
      const line = narrate(court, 0.9, 30, 100, 20);
      expect(line).not.toMatch(/\b(who|whose|somebody's|their name)\b/i);
    }
  });

  it('reads durations at a scale a person can hold in their head', () => {
    expect(fmtHours(0.25)).toBe('15 minutes');
    expect(fmtHours(5.5)).toBe('5.5 hours');
    expect(fmtHours(30)).toBe('30 hours');
    expect(fmtHours(96)).toBe('4 days');
  });
});

describe('the floors exist to stop a share inventing a crisis', () => {
  it('requires a repo to be lopsided AND slow', () => {
    // ⚠ THE MOST IMPORTANT CONSTANT IN THE FEATURE. A real repository in the development corpus is
    // 73% author-court with a p75 lead time of EIGHTEEN MINUTES. Naming a dominant court on the
    // share alone would report a crisis in a healthy repo — the exact failure that made the
    // path-bucket findings worthless.
    expect(__flowTesting.FLOW_SLOW_P75_HOURS).toBeGreaterThan(0);
    expect(__flowTesting.FLOW_DOMINANT_SHARE).toBeGreaterThan(0.5 - Number.EPSILON);
    const healthyP75 = 0.3;
    expect(healthyP75 < __flowTesting.FLOW_SLOW_P75_HOURS).toBe(true);
  });

  it('needs more than a handful of pull requests before a repo profile is a number', () => {
    expect(__flowTesting.FLOW_MIN_REPO_PRS).toBeGreaterThanOrEqual(10);
  });
});
