// THE COURT LEDGER'S STATE MACHINE, as a pure fold — no database, no fixture, no clock.
//
// `walkCourts` is the whole feature in one function: every figure on the "Chronology" screen
// is a sum over its output. It is also a HEURISTIC with three judgement calls inside it, and this
// repo's rule is that a heuristic gets fixture tests (`sync/__fixtures__/threads/` carries the same
// rule for `derive-thread-state`). Each block below pins one decision, and the comment says what
// breaks if it is changed by accident rather than on purpose.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/backend src/db/pr-intervals.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PrCourt } from '@pierre-review/shared';
import {
  __flowTesting,
  median,
  percentile,
  walkCourts,
  type CourtAction,
  type CourtHours,
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
    //
    // These assertions pin that the floors EXIST. What they are SET TO is pinned exactly in the
    // calibration block at the bottom of this file, against a replay over 66,088 public pull
    // requests — that is the block a careless retune has to get past.
    expect(__flowTesting.FLOW_SLOW_P75_HOURS).toBeGreaterThan(0);
    expect(__flowTesting.FLOW_DOMINANT_SHARE).toBeGreaterThan(0.5 - Number.EPSILON);
    const healthyP75 = 0.3;
    expect(healthyP75 < __flowTesting.FLOW_SLOW_P75_HOURS).toBe(true);
  });

  it('needs more than a handful of pull requests before a repo profile is a number', () => {
    expect(__flowTesting.FLOW_MIN_REPO_PRS).toBeGreaterThanOrEqual(10);
  });
});

// ── THE CALIBRATION, REPLAYED OVER A POPULATION THE PRODUCT HAS NEVER SEEN ─────────────────────
//
// ⚠ WHAT IS MEASURED AND WHAT IS TRANSCRIBED, KEPT APART ON PURPOSE. This block downloads nothing,
// opens no fixture and touches no network. The figures below are the RESULT of a one-off replay,
// carried here as the EVIDENCE for the constants the assertions pin — they are LITERALS, and an
// assertion between two literals cannot fail because the code changed. TWO tests in the block
// read the fold. `folds walkCourts over a stated population…` runs it over a population written
// out in full and requires the result to land on the replay's split — that one is the block's
// teeth. `would drive the reviewer share past 80%…` reads it for the never-touched shape its
// blend rests on, so a change to the starting court reddens it too. (Do not demote that line to a
// literal while tidying: it is the only check here that the never-touched ledger is still 100%
// reviewer, which is the assumption the 0.543-weighted blend below is built on.)
// The rest pin EXPORTED CONSTANTS (which do fail on a retune) or
// guard the transcription of this comment, and each says in its own words which of the three it
// is — a test that reads as coverage and provides none is worse than no test, and this block
// shipped one. Move a constant without re-running the replay and every number in this comment
// silently becomes a lie, which is the whole reason the pins below are exact.
//
// `walkCourts` — this file's own fold, unmodified — was replayed over 66,088 merged public pull
// requests across 30,084 repositories from the GH Archive. Four things held.
//
//   1. THE CONJUNCTION EARNS ITS KEEP. Of 509 repositories over the 12-PR floor, 433 were LOPSIDED
//      (a court at or past 50%) but only 339 were ALSO SLOW (p75 lead >= 8h). The AND rescued 94
//      repositories — 22% of the lopsided ones — from a bottleneck call they had not earned. Three
//      of them, spanning two different courts:
//
//        MetaMask/eth-phishing-detect   88.1% reviewer   p75 0.0h
//        Homebrew/homebrew-cask         84.2%            p75 0.9h
//        microsoft/winget-pkgs          76.4% author     p75 4.9h
//
//      Every one clears the share floor comfortably; every one clears a pull request in under five
//      hours. A share-only rule would have told three of the most functional repositories on GitHub
//      that they have a review bottleneck.
//
//   2. THE SPLIT REPRODUCES. 63.4 / 19.8 / 16.8 (reviewer/author/landing) against the product's
//      live 60 / 16 / 24 — the same dominant court, every share within eight points, on two
//      populations with nothing in common. The widest gap is the landing court, which is the one
//      most sensitive to a repository's merge protection and auto-merge habits.
//      ⚠ NEITHER POPULATION IS REACHABLE FROM A UNIT TEST — one is 66,088 archived pull requests,
//      the other a live database — so this claim is EVIDENCE and the suite cannot re-derive it.
//      What the suite does hold the fold to is the stated population below, which `walkCourts`
//      must still map inside that same eight-point band of BOTH of these.
//
//   3. BOTH EXCLUSIONS REPRODUCE, and neither is an edge case anywhere. Bot-authored merges were
//      35.4% of the public corpus against the product's 43%; never-human-touched, 54.3% against
//      46%. Dropping either exclusion as "a simplification" moves every share on the screen.
//
//   4. ASSOCIATION MOVES DURATION, NOT COMPOSITION. Splitting the same corpus by whether the author
//      was an insider or an outsider moved the reviewer share 63.8% -> 63.2%, six tenths of a
//      point, while median lead time moved 5.6h -> 14.6h, a factor of 2.6.
//      ⚠ THE CONSEQUENCE, WRITTEN DOWN BEFORE ANYONE NEEDS IT: if Chronology ever grows a benchmark
//      band, SHARES NEED NO ASSOCIATION CONTROL AND DURATIONS REQUIRE ONE. "Your reviewer share
//      against the median repository" is sound as it stands; "your lead time against the median
//      repository" compares a team against a population with a different mix of drive-by
//      contributors, and is a wrong answer with a confidence interval printed on it.
describe('the calibration, replayed over 66,088 public pull requests', () => {
  const { FLOW_DOMINANT_SHARE, FLOW_MIN_REPO_PRS, FLOW_SLOW_P75_HOURS } = __flowTesting;

  /**
   * The rule that decides whether a repository gets a court named, rebuilt from the exported
   * constants — `getFlowCourts` needs a database, so the one expression in it that matters here
   * cannot be called. ⚠ Rebuilt, therefore capable of drifting from the real one: the structural
   * test below is what stops that, and it is not optional decoration.
   */
  const namesACourt = (topShare: number, p75Hours: number): boolean =>
    topShare >= FLOW_DOMINANT_SHARE && p75Hours >= FLOW_SLOW_P75_HOURS;

  /** The replay's repository counts, in one place so prose and assertions cannot drift apart. */
  const REPLAY = { reposOverFloor: 509, lopsided: 433, alsoSlow: 339 };

  /**
   * Lopsided, and fast — the repositories the AND rescued, with the replay's own figures. Each is a
   * live counter-example to a share-only rule, which is why they are named rather than summarised.
   */
  const RESCUED = [
    { repo: 'MetaMask/eth-phishing-detect', court: 'reviewer', topShare: 0.881, p75Hours: 0 },
    // The replay's row for this one recorded the share and the p75 but not which court held it.
    // The rescue does not depend on knowing: the rule reads only the TOP share, whichever it is.
    { repo: 'Homebrew/homebrew-cask', court: null, topShare: 0.842, p75Hours: 0.9 },
    { repo: 'microsoft/winget-pkgs', court: 'author', topShare: 0.764, p75Hours: 4.9 },
  ] as const;

  it('names no court in three real repositories that are lopsided but fast', () => {
    for (const r of RESCUED) {
      // Non-vacuity, and it is the whole load of the case: a row demonstrates a RESCUE only if the
      // share half of the rule genuinely passes. One that failed both halves would prove nothing
      // about the conjunction and would keep passing after the AND was removed.
      expect(r.topShare >= FLOW_DOMINANT_SHARE, `${r.repo} is not lopsided`).toBe(true);
      expect(namesACourt(r.topShare, r.p75Hours), `${r.repo} would be flagged`).toBe(false);
    }
    // ⚠ The rescue is not an artefact of one court's behaviour — these span at least two.
    expect(new Set(RESCUED.map((r) => r.court).filter((c) => c != null)).size).toBeGreaterThan(1);
  });

  it('pins the three constants the replay was measured at', () => {
    // EXACT, deliberately. The claim is not that these are the optimal values — it is that every
    // figure in the comment above was measured AT them. Retuning one is allowed; retuning one
    // without re-running the replay and rewriting that comment is how a calibration becomes
    // folklore, and this is the only place in the repository that would notice.
    expect(FLOW_MIN_REPO_PRS).toBe(12); // -> "509 repositories over the floor"
    expect(FLOW_DOMINANT_SHARE).toBe(0.5); // -> "433 of them lopsided"
    expect(FLOW_SLOW_P75_HOURS).toBe(8); // -> "339 of those also slow", so 94 rescued

    // A transcription guard on the counts themselves: the conjunction can only ever select a SUBSET
    // of the lopsided set, which is a subset of the repositories over the floor. A future re-run
    // landing numbers that violate this nesting was mis-copied, not measured.
    expect(REPLAY.alsoSlow).toBeLessThanOrEqual(REPLAY.lopsided);
    expect(REPLAY.lopsided).toBeLessThanOrEqual(REPLAY.reposOverFloor);
  });

  it('really is an AND in the engine, not two rules with an OR between them', () => {
    // STRUCTURAL, for the same reason `erase-account.test.ts` looks at its own delete ORDER: the
    // guarantee cannot be reached behaviourally. `getFlowCourts` needs a database, so the single
    // expression that names a court is untestable from here, and `namesACourt` above is a REBUILD
    // that would go on passing happily after somebody loosened the real one to an OR. This is the
    // assertion that would not — and without it every case in this block is testing a copy.
    const src = readFileSync(new URL('./pr-intervals.ts', import.meta.url), 'utf8');
    const start = src.indexOf('const dominant: PrCourt | null =');
    expect(start, 'the dominant-court expression moved or was renamed').toBeGreaterThan(-1);
    const end = src.indexOf(';', start);
    expect(end, 'the dominant-court expression has no terminator').toBeGreaterThan(start);
    const expr = src.slice(start, end);

    // Both halves, both comparisons the same way round. `>=` is pinned with the name because a
    // flipped comparator reads as a threshold change and behaves as an inversion.
    expect(expr).toMatch(/>=\s*FLOW_DOMINANT_SHARE/);
    expect(expr).toMatch(/>=\s*FLOW_SLOW_P75_HOURS/);
    expect(expr).toContain('&&');
    // ⚠ THE ONE THAT MATTERS. An OR here re-admits every repository the conjunction rescued —
    // 94 of them in the replay, including three that merge in under an hour.
    expect(expr).not.toContain('||');
  });

  const COURTS = ['reviewer', 'author', 'landing'] as const;
  const top = (s: Record<PrCourt, number>): PrCourt =>
    COURTS.reduce((best, c) => (s[c] > s[best] ? c : best));

  /**
   * The two measured splits from paragraph 2. ⚠ BOTH ARE LITERALS: one is a replay over 66,088
   * archived pull requests, the other a live database, and this file can reach neither. They are
   * the EXPECTATION the derived population below is held to, never a thing the suite re-derives.
   */
  const REPLAY_SPLIT = { reviewer: 0.634, author: 0.198, landing: 0.168 };
  const LIVE_SPLIT = { reviewer: 0.6, author: 0.16, landing: 0.24 };

  // ── The stated population: the one thing in this block that is COMPUTED ────────────────────
  //
  // Four pull-request shapes, each written as the timeline it is with the hours the ledger charges
  // worked out beside it, folded by `walkCourts` itself.
  //
  // ⚠ THE MIX WAS CHOSEN so that the fold AS WRITTEN lands on the replay's split. It is not a
  // sample of the corpus, it is not evidence FOR the replay, and it could not be: no unit test can
  // reach either real population. What it is, is the mechanism that stops paragraph 2 rotting —
  // the recorded figure becomes a LIVE EXPECTATION, so changing a decision inside the fold moves
  // this population off it and turns the paragraph red instead of quietly making it false. That is
  // the whole difference from what stood here before, which compared the two literals to each
  // other and stayed green through a mutation of Decision 1.
  //
  //   A  the round trip (×14)
  //      0h open · 24h reviewer comments · 32h author answers · 40h approved · 44h merged
  //      → reviewer 24 + 8 = 32 · author 8 · landing 4
  //   B  approved and parked (×2)
  //      0h open · 4h approved · 28h merged
  //      → reviewer 4 · author 0 · landing 24
  //   C  the long answer (×1)
  //      0h open · 6h reviewer comments · 54h author answers · 56h approved · 58h merged
  //      → reviewer 6 + 2 = 8 · author 48 · landing 2
  //   D  approved, then a fixup push (×1) — the ONLY shape here that reaches DECISION 2
  //      0h open · 8h approved · 20h author pushes · 32h merged
  //      → reviewer 8 · author 0 · landing 12 + 12 = 24
  const POPULATION = [
    { count: 14, mergedH: 44, acts: [reviewer(24), author(32), approve(40)] },
    { count: 2, mergedH: 28, acts: [approve(4)] },
    { count: 1, mergedH: 58, acts: [reviewer(6), author(54), approve(56)] },
    { count: 1, mergedH: 32, acts: [approve(8), author(20)] },
  ] as const;

  /**
   * Hours summed across pull requests FIRST, divided ONCE at the end — the aggregation `sharesOf`
   * and the workspace roll-up in `getFlowCourts` perform, and NOT a mean of per-pull-request
   * percentages, which would weight a two-hour pull request the same as a two-week one and give a
   * split no screen shows. ⚠ A REBUILD, like `namesACourt` above: `sharesOf` is module-private. It
   * is the SHAPE of the sum that has to match, not the function identity.
   */
  const foldPopulation = (): CourtHours => {
    const total: CourtHours = { reviewer: 0, author: 0, landing: 0 };
    for (const s of POPULATION) {
      const h = walkCourts(at(0), at(s.mergedH), [...s.acts]);
      for (const c of COURTS) total[c] += h[c] * s.count;
    }
    return total;
  };

  it('folds walkCourts over a stated population and lands where the replay landed', () => {
    const hours = foldPopulation();

    // EXACT, and worked out shape by shape in the comment above so a reader can check it without
    // running anything. ⚠ THIS IS THE ASSERTION THAT BITES: both decisions that live INSIDE the
    // fold are reachable from this population — Decision 1 through A and C, Decision 2 through D —
    // so moving either moves one of these three numbers and the calibration prose above stops
    // being green. (Decision 3 is not in here and could not be: it is an EXCLUSION performed by
    // `getFlowCourts`, not a branch of `walkCourts`, so it is pinned by the never-touched test
    // below and by the disjointness test at the end of this block.)
    expect(hours).toEqual({ reviewer: 472, author: 160, landing: 130 });

    // 14×44 + 2×28 + 58 + 32. The hours account for themselves here exactly as they must on the
    // screen: nothing is charged to a court that was not open, and nothing goes uncharged.
    const total = hours.reviewer + hours.author + hours.landing;
    expect(total).toBe(762);

    const derived = {
      reviewer: hours.reviewer / total,
      author: hours.author / total,
      landing: hours.landing / total,
    };

    // Inside the SAME eight-point band paragraph 2 claims for the two real populations — of BOTH
    // of them, from one fixture. Deliberately not tighter: a tighter band would be false precision
    // against figures measured once each.
    //
    // ⚠ WHAT THIS LOOP CATCHES IS NOT WHAT THE LINE ABOVE CATCHES, and saying so is the point of
    // this comment. `derived` is a pure function of the hours already pinned exactly, so no change
    // to the FOLD can fail here without failing there first — this loop is not a second guard on
    // `walkCourts`. Its inputs that can still move are `REPLAY_SPLIT` and `LIVE_SPLIT`: it is the
    // line that goes red when somebody RE-RUNS the replay, or re-reads the product's own split,
    // and writes figures into this block that the fold no longer produces. That is the moment
    // paragraph 2 stops describing this code, and it is the failure the whole block exists for.
    for (const court of COURTS) {
      expect(
        Math.abs(derived[court] - REPLAY_SPLIT[court]),
        `${court} against the replay`,
      ).toBeLessThanOrEqual(0.08);
      expect(
        Math.abs(derived[court] - LIVE_SPLIT[court]),
        `${court} against the product`,
      ).toBeLessThanOrEqual(0.08);
    }

    // Third input, third failure: a retune of the share floor past the population the calibration
    // was measured on. (`top(derived) === 'reviewer'` is deliberately NOT asserted here — with the
    // hours pinned exactly it is arithmetic, not a test, and this block has already shipped one
    // assertion that could not fail.)
    expect(derived.reviewer).toBeGreaterThanOrEqual(FLOW_DOMINANT_SHARE);
  });

  it('records the two measured splits, and guards their TRANSCRIPTION only', () => {
    // ⚠ AN HONESTY NOTE, because the test that stood here read as verification and was not one.
    // Every figure below is a LITERAL. 63.4/19.8/16.8 came from a replay this file cannot re-run
    // and 60/16/24 from a live database it cannot reach, so NOTHING in this test can fail because
    // the fold changed — the derived test above is the only one that does that, and it is where a
    // reader should look for the fold's teeth. What these lines catch is a figure mis-typed into
    // the paragraph above (shares that do not sum to one, a dominant court that disagrees with the
    // prose, a gap the prose calls eight points and is not) — the same job as the REPLAY nesting
    // guard two tests up, and stated as such rather than dressed as coverage.
    for (const s of [REPLAY_SPLIT, LIVE_SPLIT]) {
      expect(s.reviewer + s.author + s.landing).toBeCloseTo(1, 6);
    }
    // The reproduction claim is the DOMINANT COURT, not the decimals. The shares were never
    // expected to be identical and reading them as if they were is the coverage-bias mistake.
    expect(top(REPLAY_SPLIT)).toBe('reviewer');
    expect(top(LIVE_SPLIT)).toBe(top(REPLAY_SPLIT));

    // The widest recorded gap is landing (16.8 against 24) — the court most sensitive to merge
    // protection and auto-merge habits, and the one a public corpus has least of. It is a
    // difference in the populations, not a defect in the fold.
    for (const court of COURTS) {
      expect(Math.abs(REPLAY_SPLIT[court] - LIVE_SPLIT[court]), court).toBeLessThanOrEqual(0.08);
    }

    // ⚠ The two lines in this test that CAN fail on a code change, and the reason it is not simply
    // deleted: both populations must stay on the same side of the share floor. Raise
    // FLOW_DOMINANT_SHARE past either and the product's own workspace stops reading as lopsided,
    // at which point the paragraph above is describing a rule the code no longer applies.
    expect(REPLAY_SPLIT.reviewer).toBeGreaterThanOrEqual(FLOW_DOMINANT_SHARE);
    expect(LIVE_SPLIT.reviewer).toBeGreaterThanOrEqual(FLOW_DOMINANT_SHARE);
  });

  it('would drive the reviewer share past 80% if the never-touched exclusion were dropped', () => {
    // Decision 3 is pinned behaviourally at the top of this file. What the replay adds is its SIZE:
    // 54.3% of public merges are that shape (46% on the product's live data), so the exclusion is
    // not an edge case anybody may drop while tidying.
    //
    // ⚠ The blend below weights by COUNT, which assumes the two populations have comparable lead
    // times. That assumption is exactly why this is an illustration of MAGNITUDE and not a measured
    // figure — it is on no screen, and must not be put on one.
    const shares = (h: CourtHours): Record<PrCourt, number> => {
      const t = h.reviewer + h.author + h.landing;
      return { reviewer: h.reviewer / t, author: h.author / t, landing: h.landing / t };
    };
    // Taken FROM the fold rather than asserted about it — if this ever stopped being 100% reviewer,
    // the blend below would stop meaning anything and this line is where it would show.
    const untouched = shares(walkCourts(at(0), at(100), []));
    expect(untouched).toEqual({ reviewer: 1, author: 0, landing: 0 });

    const NEVER_TOUCHED_RATE = 0.543;
    // The human-touched population's own split — `REPLAY_SPLIT`, not a second copy of the same
    // three decimals: one place, so the prose and every assertion over it cannot drift apart.
    const mix = (court: PrCourt): number =>
      NEVER_TOUCHED_RATE * untouched[court] + (1 - NEVER_TOUCHED_RATE) * REPLAY_SPLIT[court];
    const blended = { reviewer: mix('reviewer'), author: mix('author'), landing: mix('landing') };

    expect(blended.reviewer + blended.author + blended.landing).toBeCloseTo(1, 6);
    expect(blended.reviewer).toBeGreaterThan(0.8);
    // The author court more than halves. "Every share moves" is the claim, not just the reviewer's.
    expect(blended.author).toBeLessThan(REPLAY_SPLIT.author / 2);
  });

  it('counts the two exclusions disjointly, so the rates on screen can be read side by side', () => {
    // 35.4% bot-authored and 54.3% never-human-touched are rendered next to each other by
    // `exclusionLineFor` — "Set aside: N opened by automation, and M that no person ever reviewed
    // or commented on." — and a reader adds them up. That only means anything if a pull request
    // lands in exactly ONE bucket, and it does, because the bot check `continue`s before the
    // human-touch check is ever reached. Structural, because both counters live inside a
    // database-bound loop.
    //
    // ⚠ THE TWO ASSERTIONS BELOW GUARD TWO DIFFERENT DEFECTS, and it is worth being exact about
    // which is which, because the obvious reading has them the wrong way round:
    //
    //   • ORDER (`botBucket` before `touchBucket`). Reorder the two guards — a plausible tidy,
    //     since `humanReviewed` is cheaper than the `botAuthors` set lookup — and NOTHING is
    //     double-counted: each block keeps its own `continue`, so a bot-authored pull request with
    //     no human action is counted exactly ONCE, in the WRONG bucket. `excludedNoHumanTouch`
    //     absorbs every bot merge, and `excludedBotAuthored` is left holding only those bot pull
    //     requests a human happened to review — so the "opened by automation" clause DISAPPEARS
    //     from the line entirely whenever none did, and the 43%-of-merges bot exclusion goes
    //     invisible and is misreported as a governance finding about people. It does not stop at
    //     the counts: those pull requests also enter `unreviewedByRepo`, whose denominator
    //     `mergedByRepo` still skips bot authors, so the unreviewed-merge share is a numerator
    //     over a total that excludes it and can print above 100%.
    //   • THE `continue` ITSELF. Delete it and the same pull request falls through into the
    //     never-touched check as well, incrementing BOTH counters — that is the double count, in
    //     two figures printed a line apart, and it is this second assertion that catches it.
    const src = readFileSync(new URL('./pr-intervals.ts', import.meta.url), 'utf8');
    const botBucket = src.indexOf('excludedBotAuthored += 1');
    const touchBucket = src.indexOf('excludedNoHumanTouch += 1');
    expect(botBucket, 'the bot-authored exclusion moved or was renamed').toBeGreaterThan(-1);
    expect(touchBucket, 'the never-touched exclusion moved or was renamed').toBeGreaterThan(-1);
    expect(botBucket).toBeLessThan(touchBucket);
    expect(src.slice(botBucket, touchBucket)).toContain('continue;');
  });

  it('lets association move the duration but never the court call', () => {
    const INSIDER_SHARE = 0.638;
    const OUTSIDER_SHARE = 0.632;
    // ⚠ No association effect this small may be allowed to decide whether a court gets named, and
    // the only way it ever could is a dominant-share threshold set BETWEEN the two. At every
    // duration the verdict has to come out the same for both.
    for (const p75 of [0, 4, FLOW_SLOW_P75_HOURS, 24, 1000]) {
      expect(namesACourt(INSIDER_SHARE, p75), `p75 ${p75}h`).toBe(namesACourt(OUTSIDER_SHARE, p75));
    }

    // The durations, by contrast, straddle the slow floor. ⚠ These are MEDIANS read against a p75
    // threshold, so this is the magnitude landing on the file's own scale rather than a verdict
    // either group would receive — and that is precisely the asymmetry: the same split that cannot
    // move a share past a threshold moves a duration clean across one.
    const INSIDER_MEDIAN_H = 5.6;
    const OUTSIDER_MEDIAN_H = 14.6;
    expect(INSIDER_MEDIAN_H).toBeLessThan(FLOW_SLOW_P75_HOURS);
    expect(OUTSIDER_MEDIAN_H).toBeGreaterThanOrEqual(FLOW_SLOW_P75_HOURS);
    expect(OUTSIDER_MEDIAN_H / INSIDER_MEDIAN_H).toBeGreaterThan(2.5);
  });
});
