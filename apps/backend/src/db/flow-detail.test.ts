// Chronology's per-PR layer: budgets, the fast-vs-slow contrast, the landing tail and reviewer
// concentration. Pure — facts and a calendar in, the wire fields out.
import { describe, expect, it } from 'vitest';
import { FLOW_RULES, resolveFlowSettings, type PrCourt } from '@pierre-review/shared';
import { buildWorkingCalendar } from './working-hours.js';
import {
  __flowDetailTesting,
  buildFlowDetail,
  fmtWork,
  ticketKeyOf,
  type CourtSpell,
  type FlowPrFacts,
} from './flow-detail.js';

const H = 3_600_000;
const T0 = Date.parse('2026-06-01T00:00:00Z');
// Every hour is a working hour, so the arithmetic in these tests is clock arithmetic.
const ALWAYS = resolveFlowSettings(
  { timeZone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440 },
  'UTC',
);
const cal = buildWorkingCalendar(ALWAYS, T0 - 400 * 24 * H, T0 + 400 * 24 * H);

let nextId = 1;
/** A PR from a list of [court, hours] stretches, starting at `startH` hours after T0. */
function pr(stretches: [PrCourt, number][], extra: Partial<FlowPrFacts> = {}, startH = 0): FlowPrFacts {
  const id = nextId++;
  const openedMs = T0 + startH * H;
  let at = openedMs;
  const spells: CourtSpell[] = [];
  let rounds = 0;
  let firstLookMs: number | null = null;
  let approvedAtMs: number | null = null;
  for (const [court, h] of stretches) {
    if (spells.length > 0 && court !== 'reviewer' && firstLookMs == null) firstLookMs = at;
    if (court === 'author') rounds += 1;
    if (court === 'landing' && approvedAtMs == null) approvedAtMs = at;
    spells.push({ court, fromMs: at, toMs: at + h * H });
    at += h * H;
  }
  return {
    prId: id,
    repoId: 1,
    repoFullName: 'acme/api',
    number: id,
    title: `PR ${id}`,
    githubUrl: `https://github.com/acme/api/pull/${id}`,
    openedMs,
    mergedMs: at,
    spells,
    rounds,
    firstLookMs,
    approvedAtMs,
    firstReviewerId: 100,
    lines: 50,
    files: 2,
    reachAreas: [],
    ciRedHours: 0,
    ticketKey: null,
    selfMerged: false,
    requestKind: null,
    firstRequestMs: null,
    ...extra,
  };
}

const detail = (facts: FlowPrFacts[], settings = ALWAYS) =>
  buildFlowDetail(facts, cal, settings, 12);

describe('budgets', () => {
  it('judges where three in four landed, against good and acceptable', () => {
    // First looks of 1, 2, 3 and 6 hours: p75 = 3 → inside the 4-hour budget.
    const facts = [1, 2, 3, 6, 2].map((h) => pr([['reviewer', h], ['landing', 0.5]]));
    const row = detail(facts).budgets.find((b) => b.measure === 'firstLook')!;
    expect(row.prs).toBe(5);
    expect(row.p75).toBe(3);
    expect(row.verdict).toBe('good');
    expect(row.sentence).toBe(
      'Three in four pull requests had a first look within 3 working hours — inside the 4-hour budget.',
    );
  });

  it('is "ok" between the two marks and "slow" past the second', () => {
    const ok = [5, 6, 7, 7, 7].map((h) => pr([['reviewer', h], ['landing', 0.5]]));
    expect(detail(ok).budgets.find((b) => b.measure === 'firstLook')!.verdict).toBe('ok');
    const slow = [9, 10, 11, 12, 13].map((h) => pr([['reviewer', h], ['landing', 0.5]]));
    const row = detail(slow).budgets.find((b) => b.measure === 'firstLook')!;
    expect(row.verdict).toBe('slow');
    expect(row.sentence).toContain('past the 8-hour limit');
  });

  it('reads the workspace budget, not the product default', () => {
    const custom = resolveFlowSettings(
      { ...ALWAYS, timeZone: 'UTC', budgets: { firstLook: { good: 12, ok: 24 } } },
      'UTC',
    );
    const slowByDefault = [9, 10, 11, 12, 13].map((h) => pr([['reviewer', h], ['landing', 0.5]]));
    const row = detail(slowByDefault, custom).budgets.find((b) => b.measure === 'firstLook')!;
    expect(row.good).toBe(12);
    expect(row.verdict).toBe('good');
  });

  it('refuses a verdict on too few pull requests rather than calling four of them a trend', () => {
    const facts = [1, 2, 3, 4].map((h) => pr([['reviewer', h], ['landing', 1]]));
    const row = detail(facts).budgets.find((b) => b.measure === 'firstLook')!;
    expect(row.verdict).toBeNull();
    expect(row.sentence).toMatch(/too few/);
  });

  it('measures replies only over pull requests that went back, using each one’s slowest reply', () => {
    const facts = [
      ...[1, 2, 3, 4, 5].map((h) => pr([['reviewer', 1], ['author', h], ['reviewer', 1], ['author', 0.5], ['landing', 1]])),
      pr([['reviewer', 1], ['landing', 1]]), // never went back — not in the reply population
    ];
    const row = detail(facts).budgets.find((b) => b.measure === 'reply')!;
    expect(row.prs).toBe(5);
    expect(row.p75).toBe(4);
  });

  it('measures "approved to merged" only over pull requests that were approved', () => {
    const facts = [
      ...[0.5, 1, 1, 2, 3].map((h) => pr([['reviewer', 1], ['landing', h]])),
      pr([['reviewer', 1], ['author', 2]]), // merged without an approval
    ];
    const row = detail(facts).budgets.find((b) => b.measure === 'land')!;
    expect(row.prs).toBe(5);
    expect(row.p75).toBe(2);
  });

  it('says a budget figure in hours, even past two working days, so it compares with the budget', () => {
    const facts = [60, 70, 80, 90, 100].map((h) => pr([['reviewer', h], ['landing', 1]]));
    const row = detail(facts).budgets.find((b) => b.measure === 'lead')!;
    expect(row.sentence).toMatch(/within 91 working hours/);
    expect(row.sentence).not.toMatch(/working days/);
  });
});

describe('working hours, not clock hours', () => {
  it('splits the headline by working hours in the workspace calendar', () => {
    const london = resolveFlowSettings({ timeZone: 'Europe/London' }, 'UTC');
    const lcal = buildWorkingCalendar(london, T0 - 30 * 24 * H, T0 + 30 * 24 * H);
    // Opened Friday 5 June 2026 at 16:00 BST, first look Monday 10:00 BST, merged at 11:00.
    const opened = Date.parse('2026-06-05T15:00:00Z');
    const look = Date.parse('2026-06-08T09:00:00Z');
    const merged = Date.parse('2026-06-08T10:00:00Z');
    const f = pr([], {
      openedMs: opened,
      mergedMs: merged,
      spells: [
        { court: 'reviewer', fromMs: opened, toMs: look },
        { court: 'landing', fromMs: look, toMs: merged },
      ],
      firstLookMs: look,
      approvedAtMs: look,
    });
    const out = buildFlowDetail([f], lcal, london, 12);
    const row = out.prs[0]!;
    expect(row.leadHours).toBe(67);
    expect(row.leadWorkHours).toBe(4);
    expect(row.firstLookWorkHours).toBe(3);
    expect(row.openedWeekday).toBe(5);
  });
});

describe('the fast-versus-slow contrast', () => {
  it('refuses below eight pull requests a quarter', () => {
    const facts = Array.from({ length: 31 }, (_, i) => pr([['reviewer', i + 1], ['landing', 1]]));
    expect(detail(facts).contrast).toBeNull();
  });

  it('says what separates the slowest quarter, and only what does', () => {
    const fast = Array.from({ length: 10 }, () => pr([['reviewer', 0.5], ['landing', 1]], { lines: 40, files: 2 }));
    const middle = Array.from({ length: 20 }, () => pr([['reviewer', 3], ['landing', 1]], { lines: 100, files: 3 }));
    const slow = Array.from({ length: 10 }, () =>
      pr([['reviewer', 20], ['author', 5], ['landing', 1]], { lines: 900, files: 3 }),
    );
    const c = detail([...fast, ...middle, ...slow]).contrast!;
    expect(c.quartilePrs).toBe(10);
    const byKey = Object.fromEntries(c.rows.map((r) => [r.signal, r]));
    expect(byKey.firstLook!.verdict).toBe('separates');
    expect(byKey.lines!.verdict).toBe('separates');
    // 2 vs 3 files is under the two-file floor — a difference too small to name.
    expect(byKey.files!.verdict).toBe('none');
    expect(byKey.wentBack!.verdict).toBe('separates');
    expect(byKey.reach!.verdict).toBe('none');
    expect(c.sentence).toBe(
      'Against the fastest quarter, the slowest quarter had a longer wait for a first look, more lines changed and more trips back to the author.',
    );
  });

  it('folds lines and files into one phrase when both separate', () => {
    const fast = Array.from({ length: 10 }, () => pr([['reviewer', 0.5], ['landing', 0.2]], { lines: 40, files: 2 }));
    const slow = Array.from({ length: 30 }, () => pr([['reviewer', 20], ['landing', 0.2]], { lines: 900, files: 12 }));
    expect(detail([...fast, ...slow]).contrast!.sentence).toContain('more lines and files changed');
  });

  it('says so plainly when nothing separates them', () => {
    const facts = Array.from({ length: 40 }, (_, i) => pr([['reviewer', 1 + (i % 3) * 0.1], ['landing', 0.2]]));
    expect(detail(facts).contrast!.sentence).toBe(
      'Nothing measured here separates the slowest quarter from the fastest.',
    );
  });

  it('needs a real difference, not just a ratio over a near-zero base', () => {
    const { verdictOf } = __flowDetailTesting;
    expect(verdictOf(0.01, 0.1, 0.5)).toBe('none'); // ten times, but six minutes
    expect(verdictOf(0, 1, 0.5)).toBe('separates');
    expect(verdictOf(2, 3, 0.5)).toBe('weak');
    expect(verdictOf(2, 2.4, 0.5)).toBe('none');
  });
});

describe('the landing tail', () => {
  it('lists pull requests approved for more than a working day, with their share of the wait', () => {
    const facts = [
      pr([['reviewer', 1], ['landing', 30]], { selfMerged: true }),
      pr([['reviewer', 1], ['landing', 50]]),
      ...Array.from({ length: 8 }, () => pr([['reviewer', 1], ['landing', 1]])),
    ];
    const tail = detail(facts).landingTail!;
    // A working day on a 24-hour calendar is 24 hours.
    expect(tail.thresholdWorkHours).toBe(24);
    expect(tail.prsOver).toBe(2);
    expect(tail.rows.map((r) => r.landWorkHours)).toEqual([50, 30]);
    expect(tail.shareOfLanding).toBe(0.91);
    expect(tail.selfMergedOver).toBe(1);
    expect(tail.sentence).toBe(
      '2 pull requests sat approved for more than a working day, holding 91% of all the time spent approved and waiting to merge. 1 of them was merged by its own author.',
    );
  });

  it('offers a ticket sibling only when it merged in another repository while this one waited', () => {
    const held = pr([['reviewer', 1], ['landing', 40]], { ticketKey: 'BMD-1' });
    const during = pr([['reviewer', 2], ['landing', 10]], { ticketKey: 'BMD-1', repoId: 2, repoFullName: 'acme/web' });
    const before = pr([['reviewer', 0.2], ['landing', 0.1]], { ticketKey: 'BMD-1', repoId: 3, repoFullName: 'acme/ops' }, -100);
    const sameRepo = pr([['reviewer', 2], ['landing', 10]], { ticketKey: 'BMD-1' });
    const tail = detail([held, during, before, sameRepo]).landingTail!;
    const row = tail.rows.find((r) => r.prId === held.prId)!;
    expect(row.siblings.map((s) => s.prId)).toEqual([during.prId]);
    // The page prints this count as a figure; it must agree with the sentence beside it.
    expect(tail.siblingsOver).toBe(1);
    expect(tail.sentence).toMatch(/1 shares a ticket with a pull request in another repository that merged while it waited\./);
  });

  it('is null when nothing was approved, and says so when nothing waited long', () => {
    expect(detail([pr([['reviewer', 1], ['author', 1]])]).landingTail).toBeNull();
    expect(detail([pr([['reviewer', 1], ['landing', 1]])]).landingTail!.sentence).toBe(
      'No pull request sat approved for more than a working day.',
    );
  });
});

describe('reviewer concentration names no one', () => {
  const repoOf = (reviewers: number[], look: (who: number) => number) =>
    reviewers.map((who) => pr([['reviewer', look(who)], ['landing', 1]], { firstReviewerId: who }));

  it('reports the busiest first reviewer as a share, and whether they are slower', () => {
    const facts = repoOf([7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 9, 9], (who) => (who === 7 ? 6 : 2));
    const [row] = detail(facts).concentration;
    expect(row).toMatchObject({ prs: 12, firstReviewers: 3, topShare: 0.67, slower: true });
    expect(row!.topFirstLookWorkHours).toBe(6);
    expect(row!.othersFirstLookWorkHours).toBe(2);
  });

  it('never puts a person id on the wire', () => {
    const facts = repoOf([424242, 424242, 424242, 424242, 424242, 424242, 424242, 515151, 515151, 515151, 515151, 515151], () => 2);
    const json = JSON.stringify(detail(facts));
    expect(json).not.toContain('424242');
    expect(json).not.toContain('515151');
    expect(json).not.toContain('firstReviewerId');
  });

  it('leaves out a repository below the floor', () => {
    const facts = repoOf([7, 7, 8], () => 2);
    expect(detail(facts).concentration).toEqual([]);
  });
});

describe('the per-PR rows', () => {
  it('names the court a PR spent most working time in', () => {
    const out = detail([pr([['reviewer', 1], ['author', 5], ['landing', 1]])]);
    expect(out.prs[0]!.dominant).toBe('author');
    expect(out.prs[0]!.rounds).toBe(1);
  });

  it('keeps every slow PR when it has to cap, and says it capped', () => {
    const { FLOW_PR_ROWS_CAP, FLOW_PR_ROWS_SLOW_KEEP } = __flowDetailTesting;
    const facts = Array.from({ length: FLOW_PR_ROWS_CAP + 500 }, (_, i) => pr([['reviewer', i + 1]]));
    const out = detail(facts);
    expect(out.prsCapped).toBe(true);
    expect(out.prs).toHaveLength(FLOW_PR_ROWS_CAP);
    const slowest = [...facts].sort((a, b) => b.mergedMs - b.openedMs - (a.mergedMs - a.openedMs)).slice(0, FLOW_PR_ROWS_SLOW_KEEP);
    const shown = new Set(out.prs.map((r) => r.prId));
    expect(slowest.every((f) => shown.has(f.prId))).toBe(true);
    // ⚠ The headline figures are over EVERY measured PR, never the capped sample: the sample keeps
    // all the slow ones, so a count over it inflates exactly when it capped.
    const leads = facts.map((f) => (f.mergedMs - f.openedMs) / H);
    expect(out.prFigures.overWorkingDay).toBe(leads.filter((h) => h > 24).length);
    expect(out.prFigures.overWorkingDay).not.toBe(out.prs.filter((r) => r.leadWorkHours > 24).length);
    expect(out.prFigures.neverWentBack).toBe(facts.length);
    expect(out.prFigures.slowestTenthCount).toBe(Math.ceil(facts.length / 10));
  });

  it('computes the per-PR figures over every measured pull request', () => {
    const facts = Array.from({ length: 20 }, (_, i) => pr([['reviewer', i + 1]]));
    const f = detail(facts).prFigures;
    expect(f.slowestTenthCount).toBe(2);
    expect(f.slowestTenthShare).toBeCloseTo((20 + 19) / 210, 9);
    expect(f.overWorkingDay).toBe(0);
    expect(f.neverWentBack).toBe(20);

    const withLong = [...facts, pr([['reviewer', 2], ['author', 28]])];
    const g = detail(withLong).prFigures;
    expect(g.overWorkingDay).toBe(1);
    expect(g.neverWentBack).toBe(20);
  });

  it('is all zeros when nothing was measured', () => {
    expect(detail([]).prFigures).toEqual({
      overWorkingDay: 0,
      slowestTenthCount: 0,
      slowestTenthShare: 0,
      neverWentBack: 0,
    });
  });
});

describe('the rules the page quotes', () => {
  it('folds with the rules the page quotes', () => {
    // ⚠ Chronology's "i" modals print FLOW_RULES; the fold must be reading the same numbers.
    const t = __flowDetailTesting;
    expect(t.FLOW_BUDGET_MIN_PRS).toBe(FLOW_RULES.budgetMinPrs);
    expect(t.FLOW_CONTRAST_MIN_QUARTILE).toBe(FLOW_RULES.contrastMinQuartile);
    expect(t.FLOW_CUT_MIN_PRS).toBe(FLOW_RULES.cutMinPrs);
    expect(t.FLOW_LANDING_ROWS_CAP).toBe(FLOW_RULES.landingRows);
    expect(t.FLOW_CONCENTRATION_MIN_SIDE).toBe(FLOW_RULES.concentrationMinSide);
    expect(t.FLOW_CONCENTRATION_SLOWER_RATIO).toBe(FLOW_RULES.slowerRatio);
    expect(t.FLOW_CONCENTRATION_SLOWER_MIN_HOURS).toBe(FLOW_RULES.slowerMinHours);
    expect(t.FLOW_SEPARATES_RATIO).toBe(FLOW_RULES.separatesRatio);
    expect(t.FLOW_WEAK_RATIO).toBe(FLOW_RULES.weakRatio);
  });

  it('refuses a budget verdict exactly below the quoted floor', () => {
    // Behavioural, so a local literal that happened to equal the rule today still fails the day
    // the rule moves: one PR under the floor has no verdict, the floor itself has one.
    const n = FLOW_RULES.budgetMinPrs;
    const at = (k: number) =>
      detail(Array.from({ length: k }, () => pr([['reviewer', 1], ['landing', 1]]))).budgets.find(
        (b) => b.measure === 'firstLook',
      )!.verdict;
    expect(at(n - 1)).toBeNull();
    expect(at(n)).not.toBeNull();
  });
});

describe('ticket keys', () => {
  it('reads an upper-case key from the title, then any case from the branch', () => {
    expect(ticketKeyOf('BMD-984 Offer the report as a download', null)).toBe('BMD-984');
    expect(ticketKeyOf('Offer the report as a download', 'feature/bmd-984-download')).toBe('BMD-984');
    expect(ticketKeyOf('fix: BMD-919/BMD-921 target shows NaN', null)).toBe('BMD-919');
  });

  it('ignores look-alikes', () => {
    expect(ticketKeyOf('Switch to UTF-8 and SHA-256', 'upgrade-node-20')).toBeNull();
    expect(ticketKeyOf('Pin to GPT-4 for summaries', null)).toBeNull();
    expect(ticketKeyOf('bmd-12 lower-case in a title is not a key', null)).toBeNull();
  });
});

describe('durations in prose', () => {
  it('reads minutes, then working hours, then working days', () => {
    expect(fmtWork(0.25, 9)).toBe('15 minutes');
    expect(fmtWork(6, 9)).toBe('6 working hours');
    expect(fmtWork(12.4, 9)).toBe('12 working hours');
    expect(fmtWork(20, 9)).toBe('2.2 working days');
    expect(fmtWork(20, 0)).toBe('20 working hours');
  });
});

describe('asking for a review', () => {
  it('compares a named person with a team, from the request to the first look', () => {
    // Opened at 0; asked at 1h; first look at 2h (person) or 5h (team).
    const asked = (kind: 'person' | 'team', lookH: number): FlowPrFacts =>
      pr([['reviewer', lookH], ['landing', 1]], {
        requestKind: kind,
        firstRequestMs: T0 + 1 * H,
        firstLookMs: T0 + lookH * H,
      });
    const facts = [
      ...Array.from({ length: 5 }, () => asked('person', 2)),
      ...Array.from({ length: 5 }, () => asked('team', 5)),
      ...Array.from({ length: 5 }, () => pr([['reviewer', 3], ['landing', 1]], { requestKind: 'none' })),
    ];
    const r = detail(facts).requests!;
    const by = Object.fromEntries(r.rows.map((x) => [x.kind, x]));
    expect(by.person!.medianRequestToLookWorkHours).toBe(1);
    expect(by.team!.medianRequestToLookWorkHours).toBe(4);
    expect(by.none!.medianRequestToLookWorkHours).toBeNull();
    expect(by.none!.medianFirstLookWorkHours).toBe(3);
    expect(r.sentence).toContain('Asking a named person got a first look a median 1 working hour after the request; asking a team, 4 working hours.');
    expect(r.sentence).toContain('5 pull requests were never assigned a reviewer');
  });

  it('keeps "not known" apart from "nobody", and says how much is known', () => {
    const facts = [
      pr([['reviewer', 1], ['landing', 1]], { requestKind: 'none' }),
      pr([['reviewer', 1], ['landing', 1]], { requestKind: null }),
    ];
    const r = detail(facts).requests!;
    expect(r.known).toBe(1);
    expect(r.measured).toBe(2);
    expect(r.rows.find((x) => x.kind === 'none')!.prs).toBe(1);
    expect(r.sentence).toMatch(/^Request history is in for 1 of 2 pull requests so far/);
  });

  it('is null when no pull request has its history yet', () => {
    expect(detail([pr([['reviewer', 1]])]).requests).toBeNull();
  });

  it('leaves out a first look that came before anyone was asked', () => {
    const f = pr([['reviewer', 2], ['landing', 1]], {
      requestKind: 'person',
      firstRequestMs: T0 + 3 * H,
      firstLookMs: T0 + 2 * H,
    });
    const r = detail([f]).requests!;
    expect(r.lookedBeforeAsked).toBe(1);
    expect(detail([f]).prs[0]!.requestToLookWorkHours).toBeNull();
  });
});
