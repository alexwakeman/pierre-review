// Chronology's working-hours render model: the calendar line, the budget scale, the scatter's
// axis and the triangle's geometry. Pure — no renderer.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/chronologyModel.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  resolveFlowSettings,
  type FlowBudgetRow,
  type FlowCoverage,
  type FlowPrRow,
  type FlowRefusal,
  type FlowRequestStats,
  type FlowResponse,
  type RepoCourtProfile,
} from '@pierre-review/shared';
import { buildBottlenecksModel, exclusionLineFor } from '../src/components/Activity/bottlenecksModel.js';
import {
  budgetAriaLabel,
  budgetClip,
  budgetPopoverRows,
  budgetScale,
  calendarLine,
  dotRadius,
  effectiveChronologyWindow,
  formatWorkHours,
  lookedBeforeAskedLine,
  neverWentBack,
  prFiguresOf,
  requestCoverageLine,
  scatterTicks,
  scatterYRange,
  slowestPrs,
  slowestTenthShare,
  trianglePoint,
  workingDaysText,
} from '../src/components/Activity/chronologyModel.js';

function row(over: Partial<FlowPrRow>): FlowPrRow {
  return {
    prId: 1,
    repoFullName: 'acme/api',
    prNumber: 1,
    prTitle: 'x',
    githubUrl: 'https://github.com/acme/api/pull/1',
    openedAt: '2026-09-01T09:00:00.000Z',
    mergedAt: '2026-09-01T12:00:00.000Z',
    openedWeekday: 2,
    leadHours: 3,
    leadWorkHours: 3,
    workHours: { reviewer: 2, author: 0, landing: 1 },
    firstLookWorkHours: 2,
    rounds: 0,
    lines: 40,
    files: 2,
    reachAreas: [],
    ciRedHours: 0,
    ticketKey: null,
    selfMerged: false,
    dominant: 'reviewer',
    ...over,
  };
}

describe('the calendar in words', () => {
  it('reads a run of days as a range, including one that wraps the week', () => {
    expect(workingDaysText([1, 2, 3, 4, 5])).toBe('Monday to Friday');
    expect(workingDaysText([7, 1, 2, 3, 4])).toBe('Sunday to Thursday');
    expect(workingDaysText([1, 2, 3, 4, 5, 6, 7])).toBe('every day');
  });

  it('lists days with a gap in them rather than inventing a range', () => {
    expect(workingDaysText([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(workingDaysText([2])).toBe('Tuesdays');
  });

  it('states zone, days and hours in one line', () => {
    expect(calendarLine(resolveFlowSettings({ timeZone: 'Europe/London' }, 'UTC'))).toBe(
      'Working hours: Monday to Friday, 09:00–18:00, Europe/London.',
    );
  });
});

describe('figures', () => {
  it('never spells working time in days — a "d" reads as calendar days', () => {
    expect(formatWorkHours(0.4)).toBe('24m');
    expect(formatWorkHours(6.25)).toBe('6.3h');
    expect(formatWorkHours(47)).toBe('47h');
    expect(formatWorkHours(130)).toBe('130h');
  });

  it('reads an unknown window as the default', () => {
    expect(effectiveChronologyWindow(60)).toBe(60);
    expect(effectiveChronologyWindow(45)).toBe(30);
    expect(effectiveChronologyWindow(null)).toBe(30);
  });
});

describe('the budget chart shares one scale', () => {
  const b = (good: number, ok: number): FlowBudgetRow => ({
    measure: 'lead',
    good,
    ok,
    prs: 10,
    p50: 1,
    p75: 2,
    p90: 3,
    verdict: 'good',
    sentence: '',
  });
  it('is wide enough for every acceptable mark, with room past it', () => {
    const { max, ticks } = budgetScale([b(4, 8), b(1, 4), b(8, 16)], 9);
    expect(max).toBe(24);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(24);
  });

  it('grows with a looser budget rather than clipping its mark', () => {
    expect(budgetScale([b(20, 40)], 9).max).toBeGreaterThanOrEqual(60);
  });
});

describe('the scatter', () => {
  it('puts the ceiling above the slowest pull request, on a tick', () => {
    const { max } = scatterYRange([row({ leadWorkHours: 130 })]);
    expect(max).toBe(160);
    expect(scatterTicks(max).map((t) => t.label)).toContain('160h');
  });

  it('draws an unknown size as the smallest dot, never as a big one', () => {
    expect(dotRadius(null)).toBe(3);
    expect(dotRadius(10_000)).toBe(10);
  });

  it('lists the slowest in working hours, and what share they hold', () => {
    const prs = Array.from({ length: 20 }, (_, i) => row({ prId: i + 1, leadWorkHours: i + 1 }));
    expect(slowestPrs(prs, 3).map((p) => p.prId)).toEqual([20, 19, 18]);
    const t = slowestTenthShare(prs);
    expect(t.count).toBe(2);
    expect(t.share).toBeCloseTo((20 + 19) / 210, 9);
  });
});

describe('the triangle', () => {
  it('places a pull request by its shares, and leaves off one with no working time', () => {
    expect(trianglePoint({ reviewer: 3, author: 0, landing: 1 })).toEqual({
      reviewer: 0.75,
      author: 0,
      landing: 0.25,
    });
    expect(trianglePoint({ reviewer: 0, author: 0, landing: 0.01 })).toBeNull();
  });

  it('counts those that never went back to their author — the right-hand edge', () => {
    expect(neverWentBack([row({ rounds: 0 }), row({ rounds: 2 }), row({ rounds: 0 })])).toBe(2);
  });
});

// ── The budget rows' popovers ───────────────────────────────────────────────────────────────────

function budget(over: Partial<FlowBudgetRow>): FlowBudgetRow {
  return {
    measure: 'firstLook',
    good: 4,
    ok: 8,
    prs: 68,
    p50: 3.6,
    p75: 6.42,
    p90: 15,
    verdict: 'ok',
    sentence: 'Three in four pull requests had a first look within 6.4 working hours — over the 4-hour budget, inside the 8-hour limit.',
    ...over,
  };
}

describe('a bar past the scale says so', () => {
  it('marks the bar itself when three in four ran past the axis', () => {
    expect(budgetClip(budget({ p75: 30, p90: 40 }), 24)).toBe('bar');
  });

  it('marks only the tail when nine in ten did', () => {
    expect(budgetClip(budget({ p75: 20, p90: 30 }), 24)).toBe('tail');
  });

  it('marks nothing when every figure is inside, or there is nothing to draw', () => {
    expect(budgetClip(budget({ p75: 6, p90: 15 }), 24)).toBe('none');
    expect(budgetClip(budget({ prs: 0, p75: 0, p90: 0 }), 24)).toBe('none');
    // An edge exactly AT the scale is drawn to it, not past it.
    expect(budgetClip(budget({ p75: 24, p90: 24 }), 24)).toBe('none');
  });
});

describe('the popover prints figures, and the server’s reason only when there is no verdict', () => {
  it('lists a judged row’s figures and no sentence — the chip and the bars already say it', () => {
    expect(budgetPopoverRows(budget({}))).toEqual({
      note: null,
      figures: [
        ['Pull requests', '68'],
        ['Median', '3.6h'],
        ['Three in four within', '6.4h'],
        ['Nine in ten within', '15h'],
        ['Budget', '4h'],
        ['Acceptable up to', '8h'],
      ],
    });
  });

  it('carries the server’s reason for a row too thin to judge', () => {
    const thin = budget({
      prs: 3,
      verdict: null,
      sentence: 'Only 3 pull requests to measure — too few to hold against the budget.',
    });
    const out = budgetPopoverRows(thin);
    expect(out.note).toBe(thin.sentence);
    expect(out.figures.map(([k]) => k)).toContain('Median');
  });

  it('prints only the budget for a row with nothing in it', () => {
    const empty = budget({ prs: 0, p50: 0, p75: 0, p90: 0, verdict: null, sentence: 'No pull request went back to its author.' });
    expect(budgetPopoverRows(empty)).toEqual({
      note: 'No pull request went back to its author.',
      figures: [
        ['Budget', '4h'],
        ['Acceptable up to', '8h'],
      ],
    });
  });
});

describe('the chart’s accessible name carries every figure', () => {
  it('reads a judged row in one sentence', () => {
    expect(budgetAriaLabel(budget({}))).toBe(
      'First look: Acceptable. 68 pull requests; median 3.6h, three in four within 6.4h, nine in ten within 15h. Budget 4h, acceptable up to 8h.',
    );
  });

  it('says a thin row is too few to judge, and still gives its figures', () => {
    expect(budgetAriaLabel(budget({ prs: 3, verdict: null, p50: 1, p75: 2, p90: 3 }))).toBe(
      'First look: Too few to judge. 3 pull requests; median 1h, three in four within 2h, nine in ten within 3h. Budget 4h, acceptable up to 8h.',
    );
  });

  it('says an empty row has no pull requests, and gives no percentiles it does not have', () => {
    expect(budgetAriaLabel(budget({ measure: 'reply', good: 8, ok: 16, prs: 0, verdict: null }))).toBe(
      'Reply to review: No pull requests. Budget 8h, acceptable up to 16h.',
    );
  });
});

// ── Headline figures over every measured pull request ───────────────────────────────────────────

function resp(over: Partial<FlowResponse>): FlowResponse {
  return {
    workspaceId: 1,
    windowDays: 30,
    measuredPrs: 3,
    courts: [],
    medianLeadHours: 0,
    p75LeadHours: 0,
    headline: null,
    repos: [],
    directives: [],
    unreviewed: [],
    refusals: [],
    coverage: {
      reposInWorkspace: 1,
      reposWithData: 1,
      prsScanned: 3,
      truncated: false,
      excludedNoHumanTouch: 0,
      excludedBotAuthored: 0,
    },
    settings: resolveFlowSettings({ timeZone: 'Europe/London' }, 'UTC'),
    ...over,
  };
}

describe('the scatter’s and triangle’s figures', () => {
  const prs = [
    row({ prId: 1, leadWorkHours: 20, rounds: 0 }),
    row({ prId: 2, leadWorkHours: 5, rounds: 1 }),
    row({ prId: 3, leadWorkHours: 2, rounds: 0 }),
  ];

  it('uses the server’s figures whenever it sent them, even over a complete list', () => {
    const server = { overWorkingDay: 40, slowestTenthCount: 9, slowestTenthShare: 0.5, neverWentBack: 12 };
    expect(prFiguresOf(resp({ prs, prsCapped: false, prFigures: server }))).toBe(server);
  });

  it('recounts a complete list from an older server', () => {
    // A working day on the London default is 9 hours: only the 20-hour one is over it.
    expect(prFiguresOf(resp({ prs, prsCapped: false }))).toEqual({
      overWorkingDay: 1,
      slowestTenthCount: 1,
      slowestTenthShare: 20 / 27,
      neverWentBack: 2,
    });
  });

  it('prints nothing rather than a figure counted over a sample', () => {
    expect(prFiguresOf(resp({ prs, prsCapped: true }))).toBeNull();
  });
});

// ── The one-line disclosures ──────────────────────────────────────────────────────────────────

function requests(over: Partial<FlowRequestStats>): FlowRequestStats {
  return { known: 52, measured: 52, lookedBeforeAsked: 0, rows: [], sentence: '', ...over };
}

describe('asking for a review: what is not known yet, and what was left out', () => {
  it('says how much of the request history is in, only while some of it is not', () => {
    expect(requestCoverageLine(requests({}))).toBeNull();
    expect(requestCoverageLine(requests({ known: 40 }))).toBe(
      'Who was asked is known for 40 of 52 pull requests so far.',
    );
  });

  it('counts the pull requests somebody looked at before anyone was asked', () => {
    expect(lookedBeforeAskedLine(requests({}))).toBeNull();
    expect(lookedBeforeAskedLine(requests({ lookedBeforeAsked: 3 }))).toBe(
      '3 had a first look before anyone was asked and are left out of the request figures.',
    );
  });
});

describe('what was set aside', () => {
  const coverage = (over: Partial<FlowCoverage>): FlowCoverage => ({
    reposInWorkspace: 8,
    reposWithData: 7,
    prsScanned: 334,
    truncated: false,
    excludedNoHumanTouch: 0,
    excludedBotAuthored: 0,
    ...over,
  });

  it('names both exclusions in one short line', () => {
    expect(exclusionLineFor(coverage({ excludedBotAuthored: 113, excludedNoHumanTouch: 20 }))).toBe(
      'Set aside: 113 opened by automation, and 20 no person reviewed or commented on.',
    );
  });

  it('says nothing when nothing was set aside', () => {
    expect(exclusionLineFor(coverage({}))).toBeNull();
  });
});

// ── By repository, in clock hours ─────────────────────────────────────────────────────────────

function repo(over: Partial<RepoCourtProfile>): RepoCourtProfile {
  return {
    repoId: 1,
    repoFullName: 'acme/api',
    prs: 20,
    courts: [],
    medianLeadHours: 2,
    p75LeadHours: 4,
    dominant: null,
    narrative: null,
    evidence: [],
    ...over,
  };
}

describe('by repository', () => {
  const noneStandsOut: FlowRefusal = {
    kind: 'courts',
    reason: 'Measured 2 repositories in the last 30 days. None stands out.',
    basis: 'measured_clean',
  };
  const allReviewed: FlowRefusal = {
    kind: 'unreviewed',
    reason: 'Every pull request merged in the last 30 days had a human review or comment on it.',
    basis: 'measured_clean',
  };

  it('does not print "None stands out" beside the list that says it', () => {
    const m = buildBottlenecksModel(
      resp({ repos: [repo({ repoId: 1 }), repo({ repoId: 2 })], refusals: [noneStandsOut, allReviewed] }),
    );
    expect(m?.quiet).toHaveLength(2);
    expect(m?.refusals).toEqual([allReviewed]);
  });

  it('keeps a repository refusal that nothing else on the page states', () => {
    const tooFew: FlowRefusal = {
      kind: 'courts',
      reason: 'No repository reached 12 merged pull requests with a human review in the last 30 days.',
      basis: 'insufficient_data',
    };
    expect(buildBottlenecksModel(resp({ refusals: [tooFew] }))?.refusals).toEqual([tooFew]);
    expect(buildBottlenecksModel(resp({ refusals: [noneStandsOut] }))?.refusals).toEqual([noneStandsOut]);
  });

  it('gives each court its one line for the page and its paragraph for the modal', () => {
    const m = buildBottlenecksModel(
      resp({
        repos: [repo({ dominant: 'author' })],
        directives: [{ court: 'author', repos: 1, directive: 'The paragraph.', summary: 'The line.' }],
      }),
    );
    expect(m?.sections).toMatchObject([
      { court: 'author', label: 'Waiting for the author', summary: 'The line.', directive: 'The paragraph.' },
    ]);
  });
});

// ── The "i" modal, from the keyboard ──────────────────────────────────────────────────────────
//
// Structural, because nothing under test/ renders: these are the two things a keyboard reader
// loses without, and neither shows up with a mouse.

describe('the "i" modal from the keyboard', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/components/InfoModal.tsx', import.meta.url)),
    'utf8',
  );

  it('opens with focus on the body, the one part that scrolls', () => {
    // Arrow keys, Page Down and End scroll only the focused element, so focus anywhere else
    // leaves every line below the fold out of reach.
    const body = src.slice(src.indexOf('ref={bodyRef}'), src.indexOf('{children}'));
    expect(body, 'the body lost its ref').not.toBe('');
    expect(body).toContain('tabIndex={0}');
    expect(body).toContain('overflow-auto');
    expect(src).toContain('initialFocus={bodyRef}');
  });

  it('closes a pinned chart popover as it opens', () => {
    // Otherwise the popover's Escape listener, added first, takes the first Escape. The slot is
    // shared with the Pending "i" popovers (lib/activePopover.ts, test/activePopover.test.ts).
    expect(src).toMatch(/useEffect\(\(\) => \{\s*closeActivePopover\(\);\s*\}, \[\]\)/);
  });
});
