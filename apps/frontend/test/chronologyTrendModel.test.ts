// Chronology "Over time" render model: the running gain, marker clustering and the lens figures.
// Pure — no renderer.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/chronologyTrendModel.test.ts
import { describe, expect, it } from 'vitest';
import type { FlowTrendEvent, FlowTrendEventKind, FlowTrendWeek } from '@pierre-review/shared';
import {
  lensSignificance,
  clusterEvents,
  EVENT_KIND_LABEL,
  EVENT_KIND_ORDER,
  EVENT_KIND_WHY,
  EVENT_POPOVER_LINES,
  eventDay,
  eventPopoverModel,
  weekLabel,
  lensChange,
  lensValue,
  runningGain,
  signedHours,
  usableWeek,
} from '../src/components/Activity/chronologyTrendModel.js';

function week(i: number, median: number | null, prs = 10, partial = false): FlowTrendWeek {
  const n = median == null ? 0 : prs;
  return {
    weekStart: `2026-01-${String(i + 1).padStart(2, '0')}`,
    from: '',
    to: '',
    partial,
    measuredPrs: n,
    thin: n < 5,
    reposWithData: 1,
    reposInWorkspace: 1,
    courtsWork: [],
    medianLeadWorkHours: median,
    budgets: [],
  };
}

describe('runningGain', () => {
  it('defaults to the median of the first eight usable weeks and counts from the ninth', () => {
    const weeks = [
      ...Array.from({ length: 8 }, (_, i) => week(i, 10 + (i % 2) * 2)), // 10,12,… → median 11
      week(8, 8, 10), // saves 3 × 10 = 30
      week(9, 12, 5), // loses 1 × 5 = −5
    ];
    const g = runningGain(weeks)!;
    expect(g.start).toBe(8);
    expect(g.baseline).toBe(11);
    expect(g.baselineWeeks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(g.weekly.slice(8)).toEqual([30, -5]);
    expect(g.cumulative.slice(8)).toEqual([30, 25]);
    expect(g.cumulative.slice(0, 8).every((v) => v == null)).toBe(true);
  });

  it('leaves thin and partial weeks out of the baseline and the sum, carrying the total', () => {
    const weeks = [
      week(0, 10),
      week(1, 100, 2), // thin: not in the baseline
      ...Array.from({ length: 7 }, (_, i) => week(i + 2, 10)),
      week(9, 6, 3), // thin: not counted
      week(10, 6, 10, true), // the unfinished current week
    ];
    const g = runningGain(weeks)!;
    expect(g.baselineWeeks).toEqual([0, 2, 3, 4, 5, 6, 7, 8]);
    expect(g.baseline).toBe(10);
    expect(g.start).toBe(9);
    expect(g.weekly.slice(9)).toEqual([null, null]);
    expect(g.cumulative.slice(9)).toEqual([0, 0]);
  });

  it('refuses with fewer than eight usable weeks', () => {
    const weeks = Array.from({ length: 12 }, (_, i) => week(i, 10, i % 2 === 0 ? 10 : 2));
    expect(runningGain(weeks)).toBeNull();
  });

  it('usableWeek is the server rule: not thin, not partial, has a median', () => {
    expect(usableWeek(week(0, 5))).toBe(true);
    expect(usableWeek(week(0, 5, 4))).toBe(false);
    expect(usableWeek(week(0, 5, 10, true))).toBe(false);
    expect(usableWeek(week(0, null))).toBe(false);
  });
});

describe('clusterEvents', () => {
  const ev = (id: string, kind: FlowTrendEventKind, w: number): FlowTrendEvent => ({
    id,
    kind,
    at: `2026-01-0${w + 1}T00:00:00Z`,
    week: w,
    label: id,
  });
  const all = new Set(EVENT_KIND_ORDER);

  it('stacks the events of one week into one marker, recorded kinds before shifts', () => {
    const c = clusterEvents([ev('s', 'shift', 2), ev('b', 'bot', 2), ev('p', 'contributor', 5)], all);
    expect(c.map((x) => [x.week, x.events.map((e) => e.id), x.lead, x.shiftsOnly])).toEqual([
      [2, ['b', 's'], 'bot', false],
      [5, ['p'], 'contributor', false],
    ]);
  });

  it('a week of shifts alone is dashed; hidden kinds drop out', () => {
    const c = clusterEvents([ev('s', 'shift', 1), ev('b', 'bot', 1)], new Set<FlowTrendEventKind>(['shift']));
    expect(c).toHaveLength(1);
    expect(c[0]!.shiftsOnly).toBe(true);
  });
});

describe('lens figures', () => {
  it('prints shares as percent and points, hours as hours', () => {
    expect(lensValue('reviewerShare', 0.426)).toBe('43%');
    expect(lensChange('reviewerShare', 0.42, 0.3)).toBe('−12 points');
    expect(lensValue('lead', 6.24)).toBe('6.2 h');
    expect(lensChange('lead', 8, 5.5)).toBe('−2.5 h');
    expect(lensChange('lead', 5, 5.01)).toBe('No change');
    expect(lensValue('lead', null)).toBe('–');
  });
  it('signs a gain with a real minus', () => {
    expect(signedHours(120.4)).toBe('+120 h');
    expect(signedHours(-35)).toBe('−35 h');
    expect(signedHours(0.2)).toBe('0 h');
  });
});

describe('lensSignificance', () => {
  it('calls only a shift, lower is better, and says nothing otherwise', () => {
    expect(lensSignificance({ verdict: 'shift', before: 10, after: 6 })).toBe('better');
    expect(lensSignificance({ verdict: 'shift', before: 0.09, after: 0.32 })).toBe('worse');
    expect(lensSignificance({ verdict: 'normal', before: 10, after: 2 })).toBeNull();
    expect(lensSignificance({ verdict: 'too_few', before: 10, after: 2 })).toBeNull();
    expect(lensSignificance({ verdict: 'shift', before: null, after: 2 })).toBeNull();
    expect(lensSignificance({ verdict: 'shift', before: 3, after: 3 })).toBeNull();
  });
});

describe('hours saved in US$', () => {
  it('prices whole hours at the rate, sign-free', async () => {
    const { hoursCostUsd, usd } = await import('../src/components/Activity/chronologyTrendModel.js');
    expect(hoursCostUsd(120.4, 95)).toBe(11_400);
    expect(hoursCostUsd(-120, 95)).toBe(11_400);
    expect(hoursCostUsd(120, null)).toBeNull();
    expect(hoursCostUsd(120, 0)).toBeNull();
    expect(usd(11_400)).toBe('$11,400');
    expect(usd(87.5)).toBe('$87.50');
  });
});

describe('eventPopoverModel', () => {
  const e = (
    id: string,
    kind: FlowTrendEventKind,
    w: number,
    extra: Partial<FlowTrendEvent> = {},
  ): FlowTrendEvent => ({ id, kind, at: '2026-01-14T10:00:00.000Z', week: w, label: `${id} label`, ...extra });
  // Ten usable weeks of 10 h (the baseline is the first eight), then a faster week, a thin one and
  // the unfinished current week.
  const weeks = [
    ...Array.from({ length: 10 }, (_, i) => week(i, 10)),
    week(10, 4, 12), // saves 6 × 12 = 72
    week(11, 9, 3), // thin
    week(12, 2, 8, true), // this week, so far
  ];
  const gain = runningGain(weeks);

  it('groups the week by kind in marker order, dates recorded events, never a shift', () => {
    const m = eventPopoverModel(
      [e('s', 'shift', 10), e('c', 'contributor', 10), e('r', 'repo', 10), e('x', 'bot', 3)],
      10,
      weeks,
      gain,
    );
    expect(m.title).toBe(`Week of ${weekLabel(weeks[10]!.weekStart)}`);
    expect(m.groups.map((g) => g.kind)).toEqual(['repo', 'contributor', 'shift']);
    expect(m.groups[0]!.heading).toBe(EVENT_KIND_LABEL.repo);
    // One event, or several on one day: the day is printed once, by the heading.
    expect(m.groups[0]!.date).toBe(eventDay('2026-01-14T10:00:00.000Z'));
    expect(m.groups[0]!.items[0]).toEqual({ id: 'r', text: 'r label', date: null });
    expect(m.groups[2]!.date).toBeNull();
    expect(m.groups[2]!.items[0]!.date).toBeNull();
  });

  it('dates each event when a group spans several days', () => {
    const m = eventPopoverModel(
      [e('a', 'bot', 10), e('b', 'bot', 10, { at: '2026-01-16T10:00:00.000Z' })],
      10,
      weeks,
      gain,
    );
    expect(m.groups[0]!.date).toBeNull();
    expect(m.groups[0]!.items.map((i) => i.date)).toEqual([
      eventDay('2026-01-14T10:00:00.000Z'),
      eventDay('2026-01-16T10:00:00.000Z'),
    ]);
    expect(m.groups.every((g) => g.why === EVENT_KIND_WHY[g.kind])).toBe(true);
  });

  it('names events through the caller and counts what does not fit', () => {
    const many = Array.from({ length: EVENT_POPOVER_LINES + 3 }, (_, i) => e(`p${i}`, 'contributor', 10));
    const m = eventPopoverModel(many, 10, weeks, gain, (x) => `@${x.id}`);
    expect(m.groups[0]!.items).toHaveLength(EVENT_POPOVER_LINES);
    expect(m.groups[0]!.items[0]!.text).toBe('@p0');
    expect(m.groups[0]!.more).toBe(3);
  });

  it('a working-hours change says it changes how waits are counted; other settings do not', () => {
    const flow = eventPopoverModel([e('f', 'setting', 10, { settingKind: 'flow_settings' })], 10, weeks, gain);
    expect(flow.groups[0]!.why).toMatch(/how every wait is counted/);
    const mixed = eventPopoverModel(
      [e('f', 'setting', 10, { settingKind: 'flow_settings' }), e('a', 'setting', 10, { settingKind: 'auto_review' })],
      10,
      weeks,
      gain,
    );
    expect(mixed.groups[0]!.why).toBe(EVENT_KIND_WHY.setting);
  });

  it('places the week on the hours-saved chart from the figures', () => {
    expect(eventPopoverModel([], 10, weeks, gain).facts).toEqual([
      '12 pull requests merged',
      'Half merged within 4 h (working hours), against 10 h at the baseline',
      'That week +72 h; running total +72 h',
    ]);
    expect(eventPopoverModel([], 2, weeks, gain).facts).toEqual([
      '10 pull requests merged',
      'Half merged within 10 h (working hours)',
      'One of the weeks the baseline is taken from',
    ]);
    expect(eventPopoverModel([], 11, weeks, gain).facts).toEqual([
      '3 pull requests merged',
      'Not counted: fewer than 5 pull requests',
    ]);
    expect(eventPopoverModel([], 12, weeks, gain).facts).toEqual([
      '8 pull requests merged so far',
      'Not counted until the week ends',
    ]);
    // Too little history for a baseline: the week's own figures only.
    expect(eventPopoverModel([], 2, weeks.slice(0, 5), runningGain(weeks.slice(0, 5))).facts).toEqual([
      '10 pull requests merged',
      'Half merged within 10 h (working hours)',
    ]);
  });
});
