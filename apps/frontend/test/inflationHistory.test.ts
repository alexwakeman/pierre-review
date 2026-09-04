// The pure fold behind the ROI panel's enlarged severity-inflation card — the readable twin of
// the Inflation column's 52×14px sparkline.
//
// What these pin: the three absences a bot can have are THREE DIFFERENT CLAIMS and never one
// (no in-window labels ⇒ absent and unnamed; badged nothing ⇒ omitted and NAMED; badged but never
// disagreed ⇒ named as a measurement), the axis is the union of the bots' own buckets capped at
// 12, and a bucket a bot does not carry is a GAP rather than a zero.
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotInflationWeekPoint, BotVendorInflation } from '@pierre-review/shared';
import {
  inflationHistory,
  type InflationHistoryRow,
} from '../src/components/Activity/InflationHistoryChart.js';

const WEEK_MS = 7 * 86_400_000;
const BASE = Date.UTC(2026, 5, 1); // a Monday-ish anchor; only its arithmetic matters here

const week = (i: number, over: number, under: number): BotInflationWeekPoint => ({
  weekStartMs: BASE + i * WEEK_MS,
  overCall: over,
  underCall: under,
});

const iso = (i: number): string => new Date(BASE + i * WEEK_MS).toISOString();

const row = (key: string, label: string, mlInflation?: BotVendorInflation): InflationHistoryRow => ({
  key,
  label,
  ...(mlInflation ? { mlInflation } : {}),
});

describe('inflationHistory — the enlarged Inflation sparkline', () => {
  it('builds one panel per badged bot, both directions, over the union axis', () => {
    const rabbit = row('u11', 'CodeRabbit', {
      badged: 758,
      overCall: 243,
      underCall: 79,
      weekly: [week(0, 3, 1), week(1, 5, 0), week(2, 2, 4)],
    });
    const deep = row('u12', 'DeepSource', {
      badged: 1278,
      overCall: 218,
      underCall: 0,
      weekly: [week(0, 1, 0), week(1, 1, 0), week(2, 1, 0)],
    });
    const h = inflationHistory([rabbit, deep]);
    expect(h.labels).toEqual([iso(0), iso(1), iso(2)]);
    // Busiest disagreement history first — CodeRabbit's 15 beats DeepSource's 3.
    expect(h.panels.map((p) => p.label)).toEqual(['CodeRabbit', 'DeepSource']);
    const [cr] = h.panels;
    expect(cr!.over).toEqual([3, 5, 2]);
    expect(cr!.under).toEqual([1, 0, 4]);
    expect(cr!.overTotal).toBe(10);
    expect(cr!.underTotal).toBe(5);
    expect(h.unbadged).toEqual([]);
    expect(h.quiet).toEqual([]);
  });

  // ⚠ THE DIRECTIONS ARE NOT INTERCHANGEABLE. Transposing them turns "the bot inflates" into "we
  // do" while every number on screen stays plausible — the same failure `inflationSummary`'s
  // verbatim-direction test guards one grain over.
  it('keeps over and under on their own series', () => {
    const h = inflationHistory([
      row('u1', 'Only over', { badged: 10, overCall: 4, underCall: 0, weekly: [week(0, 4, 0)] }),
      row('u2', 'Only under', { badged: 10, overCall: 0, underCall: 4, weekly: [week(0, 0, 4)] }),
    ]);
    const byLabel = new Map(h.panels.map((p) => [p.label, p]));
    expect(byLabel.get('Only over')!.over).toEqual([4]);
    expect(byLabel.get('Only over')!.under).toEqual([0]);
    expect(byLabel.get('Only under')!.over).toEqual([0]);
    expect(byLabel.get('Only under')!.under).toEqual([4]);
  });

  // ⚠ THE HONESTY RULE, one grain over from `inflationSummary.unbadged`. A bot that badges nothing
  // has no over-calls because it makes no calls; a flat zero line reads "never inflates", which is
  // the opposite of "we cannot tell". No badge is silence, not agreement.
  it('OMITS a bot that badges nothing, and NAMES it', () => {
    const h = inflationHistory([
      row('u11', 'CodeRabbit', {
        badged: 758,
        overCall: 243,
        underCall: 79,
        weekly: [week(0, 3, 1)],
      }),
      row('u13', 'SonarQube', { badged: 0, overCall: 0, underCall: 0 }),
    ]);
    expect(h.panels.map((p) => p.label)).toEqual(['CodeRabbit']);
    expect(h.unbadged).toEqual(['SonarQube']);
    expect(h.quiet).toEqual([]);
  });

  // A badged bot whose twelve buckets are all zero loses the `weekly` key server-side. That zero
  // IS a measurement ("it made calls and we agreed with every one"), which is exactly what keeps
  // it out of `unbadged` — two different sentences, never one list.
  it('names a badged-but-never-disagreeing bot SEPARATELY from an unbadged one', () => {
    const h = inflationHistory([
      row('u12', 'DeepSource', { badged: 1278, overCall: 0, underCall: 0 }),
      row('u13', 'SonarQube', { badged: 0, overCall: 0, underCall: 0 }),
    ]);
    expect(h.panels).toEqual([]);
    expect(h.quiet).toEqual(['DeepSource']);
    expect(h.unbadged).toEqual(['SonarQube']);
  });

  // No `mlInflation` at all means the bot had no in-window labels — it is absent from this block's
  // story rather than silent within it, so naming it would invent an exclusion that was never made.
  it('says nothing at all about a bot with no ML claim', () => {
    const h = inflationHistory([row('u14', 'Renovate')]);
    expect(h.panels).toEqual([]);
    expect(h.unbadged).toEqual([]);
    expect(h.quiet).toEqual([]);
    expect(h.labels).toEqual([]);
  });

  // A bucket a bot does not carry is a GAP (null), never a 0: the line breaks rather than claiming
  // a week of perfect agreement the server never measured. A zero the bot DOES carry stays a zero.
  it('reads a missing bucket as a gap and a present zero as a zero', () => {
    const h = inflationHistory([
      row('u1', 'Wide', {
        badged: 5,
        overCall: 1,
        underCall: 0,
        weekly: [week(0, 1, 0), week(1, 0, 0)],
      }),
      row('u2', 'Narrow', { badged: 5, overCall: 2, underCall: 0, weekly: [week(1, 2, 0)] }),
    ]);
    expect(h.labels).toEqual([iso(0), iso(1)]);
    const narrow = h.panels.find((p) => p.label === 'Narrow')!;
    expect(narrow.over).toEqual([null, 2]);
    const wide = h.panels.find((p) => p.label === 'Wide')!;
    expect(wide.over).toEqual([1, 0]);
  });

  // The server publishes exactly 12 buckets; the axis is capped at the same span so a longer
  // series (or a union across two anchors) can never quietly stretch the chart's stated window.
  it('caps the axis at the last 12 weeks', () => {
    const weekly = Array.from({ length: 15 }, (_, i) => week(i, i, 0));
    const h = inflationHistory([row('u1', 'Long', { badged: 99, overCall: 105, underCall: 0, weekly })]);
    expect(h.labels).toHaveLength(12);
    expect(h.labels[0]).toBe(iso(3));
    expect(h.labels[11]).toBe(iso(14));
    expect(h.panels[0]!.over).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // The panel's own totals are over its OWN buckets, not the drawn axis — the card prints them
    // as the 84-day figures they are.
    expect(h.panels[0]!.overTotal).toBe(105);
  });
});
