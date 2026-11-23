import { describe, expect, it } from 'vitest';
import {
  adoptionFigure,
  commentaryFigures,
  fallbackCommentary,
  fillCommentary,
  type AdoptionCommentaryResponse,
} from '@pierre-review/shared';
import {
  buildDeck,
  commentaryFromResponse,
  deckFigureFormatter,
  reportFileName,
  type Deck,
  type DeckPage,
  type DeckTextMetrics,
} from '../src/components/Activity/report/deckModel.js';
import { deckContrast, DECK_INK, VENDOR_COLOR } from '../src/components/Activity/report/deckColors.js';
import { doneLine } from '../src/components/Activity/report/buildReport.js';
import { cmp, makeReport } from './adoptionReportFixture.js';

// REPORTS → DOWNLOAD REPORT, the deck model (docs/AI-ADOPTION-REPORT.md § The UI). Pure: no PDF here.

/** A fixed-width stand-in for the fonts: Latin and punctuation draw, CJK does not. */
const METRICS: DeckTextMetrics = {
  width: (t, size, w) => [...t].length * size * (w === 'semibold' ? 0.56 : 0.52),
  canDraw: (t) => [...t].every((ch) => ch.codePointAt(0)! < 0x2e80),
};
const ON = new Date('2026-11-23T10:00:00Z');
const OPTS = { preparedFor: null, generatedOn: ON };

const texts = (p: DeckPage): string[] => p.primitives.flatMap((x) => (x.kind === 'text' ? [x.text] : []));
const allText = (d: Deck): string => d.pages.flatMap(texts).join('\n');
const pagesOf = (d: Deck, slide: DeckPage['slide']): DeckPage[] => d.pages.filter((p) => p.slide === slide);

describe('the deck', () => {
  it('has the ten slides in order, every page inside the 960 × 540 canvas', () => {
    const d = buildDeck(makeReport(), {}, OPTS, METRICS);
    const order = [...new Set(d.pages.map((p) => p.slide))];
    expect(order).toEqual(['title', 'summary', 'adoption', 'people', 'delivery', 'courts', 'review_bots', 'guardrails', 'cost', 'method']);
    for (const p of d.pages) {
      for (const x of p.primitives) {
        if (x.kind === 'text') {
          expect(x.x, x.text).toBeGreaterThanOrEqual(0);
          expect(x.x, x.text).toBeLessThanOrEqual(960);
          expect(x.y, x.text).toBeGreaterThan(0);
          expect(x.y, x.text).toBeLessThanOrEqual(540);
        }
      }
    }
    expect(d.title).toBe('AI adoption report — Acme Platform');
  });

  it('the adoption slide lists every tool seen (up to six), most PRs this period first', () => {
    const base = makeReport();
    const v = (vendor: 'claude' | 'codex' | 'copilot' | 'cursor', before: number, after: number) => ({
      vendor,
      before: adoptionFigure(before, 'count', 40),
      after: adoptionFigure(after, 'count', 44),
      afterShare: adoptionFigure(Math.round((after / 44) * 100), 'pct', 44),
    });
    const r = makeReport({
      // Seven markers: the "Dashed lines" note takes two lines, as on a busy workspace.
      markers: Array.from({ length: 7 }, (_, i) => ({ at: new Date(Date.parse(base.after.from) - (i + 2) * 86_400_000).toISOString(), kind: 'auto_review' as const, summary: `A long setting name that changed number ${'x'.repeat(i)}` })),
      adoption: { ...base.adoption, vendors: [v('claude', 1, 1), v('codex', 1, 1), v('copilot', 0, 1), v('cursor', 3, 2)] },
    });
    const page = pagesOf(buildDeck(r, {}, OPTS, METRICS), 'adoption')[0]!;
    const t = texts(page);
    expect(t.some((x) => /more tools/.test(x))).toBe(false);
    const order = ['Cursor', 'Claude', 'Codex', 'GitHub Copilot'].map((name) => page.primitives.find((x) => x.kind === 'text' && x.text === name && x.size === 11));
    for (const o of order) expect(o).toBeDefined();
    const ys = order.map((o) => (o != null && o.kind === 'text' ? o.y : 0));
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    // Every row sits above the body's bottom (the page footer is below it).
    for (const y of ys) expect(y).toBeLessThanOrEqual(482);
  });

  it('every text colour clears 4.5:1 on the white ground', () => {
    for (const c of Object.values(DECK_INK)) expect(deckContrast(c), c).toBeGreaterThanOrEqual(4.5);
    const d = buildDeck(makeReport(), {}, { ...OPTS, preparedFor: 'The board' }, METRICS);
    const colours = new Set(d.pages.flatMap((p) => p.primitives.flatMap((x) => (x.kind === 'text' ? [x.color] : []))));
    for (const c of colours) expect(deckContrast(c), c).toBeGreaterThanOrEqual(4.5);
    // Vendor colours are marks only: no text is drawn in one.
    for (const c of Object.values(VENDOR_COLOR)) if (deckContrast(c) < 4.5) expect(colours.has(c), c).toBe(false);
  });

  it('text sizes respect the floors: 11pt for a label, 12pt or more for commentary', () => {
    const d = buildDeck(makeReport(), {}, OPTS, METRICS);
    for (const p of d.pages) for (const x of p.primitives) if (x.kind === 'text') expect(x.size, x.text).toBeGreaterThanOrEqual(11);
  });

  it('a withheld figure is drawn "—" with its reason, never as 0', () => {
    const r = makeReport();
    const d = buildDeck(r, {}, OPTS, METRICS);
    const delivery = texts(pagesOf(d, 'delivery')[0]!);
    // reviewer_concentration's "before" and the other side's approval share are withheld (low_sample).
    expect(delivery).toContain('—');
    expect(delivery.join(' ')).toMatch(/Too few to show/);
    expect(delivery).not.toContain('0%');
    // The first trend period is withheld (detection incomplete): a "—" on the chart, no bar label.
    const adoption = texts(pagesOf(d, 'adoption')[0]!);
    expect(adoption).toContain('—');
    // The per-tool people table is withheld while detection is incomplete.
    const held = buildDeck(makeReport({ people: { ...r.people, vendors: [], withheld: 'detection_incomplete' } }), {}, OPTS, METRICS);
    const people = texts(pagesOf(held, 'people')[0]!).join(' ');
    expect(people).toMatch(/— Still scanning for AI use/);
  });

  it('an unknown count (a fold that failed) is drawn "—" with a note, never as 0', () => {
    const r = makeReport();
    r.courts.measuredPrs = { before: null, after: null };
    r.cost.runs = { before: null, after: 31 };
    r.cost.tokens = { before: null, after: null };
    r.cost.machineWideRuns = null;
    const d = buildDeck(r, {}, OPTS, METRICS);
    const courts = pagesOf(d, 'courts').flatMap(texts).join(' ');
    expect(courts).toContain('PRs measured: — before, — this period.');
    expect(courts).toContain('could not be measured');
    expect(courts).not.toMatch(/PRs measured: 0/);
    const cost = pagesOf(d, 'cost').flatMap(texts).join(' ');
    expect(cost).toContain('The AI usage records could not be read');
    expect(cost).not.toMatch(/runs tied to no repo/);
  });

  it('never words AI spend in US$ on a subscription (week_pct)', () => {
    const r = makeReport();
    const d = buildDeck(r, {}, OPTS, METRICS);
    const cost = texts(pagesOf(d, 'cost')[0]!).join(' ');
    expect(cost).not.toMatch(/US\$|\$/);
    expect(cost).toMatch(/% of a week/);
    // With no seat price anywhere, nothing in the whole deck is in US$.
    const noSeats = makeReport({
      reviewBots: { ...r.reviewBots, bots: r.reviewBots.bots.map((b) => ({ ...b, seatPriceMonthlyUsd: null, costPerActedOnUsd: { available: false, unit: 'usd', sampleSize: 0, reason: 'no_price' } })) },
    });
    expect(allText(buildDeck(noSeats, {}, OPTS, METRICS))).not.toMatch(/US\$/);
    // An API key: spend is US$; tokens only when there is no cost unit.
    const usd = buildDeck(makeReport({ cost: { ...r.cost, costUnit: 'usd', comparisons: [cmp('ai_cost_total', 'usd', 3, 4.5), cmp('ai_cost_per_pr', 'usd', 0.08, 0.1)] } }), {}, OPTS, METRICS);
    expect(texts(pagesOf(usd, 'cost')[0]!).join(' ')).toMatch(/US\$4\.50/);
    expect(texts(pagesOf(usd, 'cost')[0]!)).not.toContain('Tokens');
    const tokens = buildDeck(makeReport({ cost: { ...r.cost, costUnit: null } }), {}, OPTS, METRICS);
    expect(texts(pagesOf(tokens, 'cost')[0]!)).toContain('Tokens');
    // AI off: says so.
    const off = buildDeck(makeReport({ cost: { ...r.cost, aiEnabled: false } }), {}, OPTS, METRICS);
    expect(texts(pagesOf(off, 'cost')[0]!).join(' ')).toMatch(/AI is off/);
  });

  it('"How widely AI is used" is one page of counts: headline, per period, per tool', () => {
    const d = buildDeck(makeReport(), {}, OPTS, METRICS);
    const pages = pagesOf(d, 'people');
    expect(pages.length).toBe(1);
    const t = texts(pages[0]!);
    expect(t).toContain('How widely AI is used');
    expect(t).toContain('10 of 15 people merged a PR with AI involved');
    // Per period: the share of people, the withheld first period drawn "—".
    expect(t).toContain('67%');
    expect(t).toContain('—');
    // Per tool, most people first; a count of 1 or 2 says "Fewer than 3", never the number.
    const tools = ['Claude', 'GitHub Copilot', 'Ensemble'].map((n) => pages[0]!.primitives.find((x) => x.kind === 'text' && x.text === n && x.size === 11));
    for (const o of tools) expect(o).toBeDefined();
    const ys = tools.map((o) => (o != null && o.kind === 'text' ? o.y : 0));
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(t).toContain('Fewer than 3');
    expect(t.join(' ')).toContain('the report names nobody');
  });

  it('a headline of 1 or 2 people says "Fewer than 3", never the number', () => {
    const r = makeReport();
    const few = { available: false as const, unit: 'count' as const, sampleSize: 15, reason: 'few_people' as const };
    r.people.peopleUsingAi = { ...r.people.peopleUsingAi, after: few, significant: false };
    const t = texts(pagesOf(buildDeck(r, {}, OPTS, METRICS), 'people')[0]!);
    expect(t).toContain('Fewer than 3 of 15 people merged a PR with AI involved');
  });

  it('uses the template commentary when AI is off (no AI label)', () => {
    const r = makeReport();
    const d = buildDeck(r, {}, OPTS, METRICS);
    const summary = texts(pagesOf(d, 'summary')[0]!).join(' ');
    const want = fillCommentary(fallbackCommentary(r, 'summary', deckFigureFormatter), commentaryFigures(r, 'summary', deckFigureFormatter));
    // The first words of the template sentence are on the page (wrapped over lines).
    expect(summary.replace(/\s+/g, ' ')).toContain(want.split(' ').slice(0, 5).join(' '));
    expect(allText(d)).not.toMatch(/Written by AI/);
    expect(d.aiWritten).toBe(0);
    expect(d.commentarySlides).toBe(8);
  });

  it('fills a valid AI template from code, and labels it', () => {
    const r = makeReport();
    const res: AdoptionCommentaryResponse = {
      slide: 'adoption',
      source: 'ai',
      template: 'AI tools were involved in {{ai_share.after}} of merged PRs {{period.after}}, {{ai_share.change}}.',
      provider: 'claude',
      model: 'claude-haiku-5-5',
      costUsd: 0.01,
    };
    const c = commentaryFromResponse(r, 'adoption', res);
    expect(c).toEqual({ source: 'ai', text: 'AI tools were involved in 34% of merged PRs in the last 14 days, up 14 points.' });
    const d = buildDeck(r, { adoption: c }, OPTS, METRICS);
    expect(texts(pagesOf(d, 'adoption')[0]!).join(' ')).toMatch(/Written by AI from the figures on this page/);
    expect(d.aiWritten).toBe(1);
  });

  it('a rejected AI template falls back to the template wording', () => {
    const r = makeReport();
    const base = { slide: 'adoption' as const, source: 'ai' as const, provider: 'claude' as const, model: 'm', costUsd: null };
    const want = fillCommentary(fallbackCommentary(r, 'adoption', deckFigureFormatter), commentaryFigures(r, 'adoption', deckFigureFormatter));
    for (const template of [
      'Adoption rose by 14 points to {{ai_share.after}}.', // a raw digit
      'Adoption reached {{ai_share.after}}, up by ٣ points.', // a Unicode numeral
      'Adoption reached {{nope.after}}.', // an unknown key
      'Auto review caused adoption to reach {{ai_share.after}}.', // a causal claim
    ]) {
      expect(commentaryFromResponse(r, 'adoption', { ...base, template })).toEqual({ source: 'template', text: want });
    }
    // A 'fallback' answer, an answer for another slide and no answer all use the template too.
    expect(commentaryFromResponse(r, 'adoption', { slide: 'adoption', source: 'fallback', reason: 'failed' }).source).toBe('template');
    expect(commentaryFromResponse(r, 'adoption', { ...base, slide: 'cost', template: 'Spend was {{ai_cost_total.after}}.' }).source).toBe('template');
    expect(commentaryFromResponse(r, 'adoption', null).source).toBe('template');
  });

  it('the title slide: workspace, window, both spans, Prepared for, the date, Made with Ensemble', () => {
    const d = buildDeck(makeReport(), {}, { ...OPTS, preparedFor: '  Northwind board  ' }, METRICS);
    const t = texts(pagesOf(d, 'title')[0]!);
    expect(t).toContain('AI adoption report');
    expect(t).toContain('Acme Platform');
    expect(t).toContain('Last 14 days');
    expect(t.some((s) => s.startsWith('This period: 9 Nov 2026 to 22 Nov 2026'))).toBe(true);
    expect(t.some((s) => s.startsWith('Compared with: 26 Oct 2026'))).toBe(true);
    expect(t).toContain('Prepared for Northwind board');
    expect(t).toContain('Generated 23 Nov 2026');
    expect(t).toContain('Made with Ensemble');
  });

  it('the summary carries each headline\'s sample size, and a non-significant change is not a move', () => {
    const d = buildDeck(makeReport(), {}, OPTS, METRICS);
    const t = texts(pagesOf(d, 'summary')[0]!);
    expect(t).toContain('Sample');
    expect(t).toContain('40');
    expect(t).toContain('up 14 points');
    expect(t).toContain('No clear change');
  });

  it('draws a dashed line for a setting change on the adoption trend, with a legend entry', () => {
    const d = buildDeck(makeReport(), {}, OPTS, METRICS);
    const p = pagesOf(d, 'adoption')[0]!;
    expect(p.primitives.some((x) => x.kind === 'line' && x.dash != null && x.x1 === x.x2)).toBe(true);
    expect(texts(p)).toContain('A setting changed');
    expect(texts(p).join(' ')).toMatch(/Auto review switched on/);
  });

  it('drops characters the fonts cannot draw from other text', () => {
    const d = buildDeck(makeReport({ workspaceName: 'Acme 李 Platform' }), {}, OPTS, METRICS);
    expect(allText(d)).not.toContain('李');
  });
});

describe('the file and the done line', () => {
  it('names the file ensemble-ai-adoption-<workspace>-<YYYY-MM-DD>.pdf', () => {
    expect(reportFileName('Acme Platform', new Date(2026, 10, 3))).toBe('ensemble-ai-adoption-acme-platform-2026-11-03.pdf');
    expect(reportFileName('Équipe Zoë!', new Date(2026, 0, 9))).toBe('ensemble-ai-adoption-equipe-zoe-2026-01-09.pdf');
    expect(reportFileName('李雷', new Date(2026, 0, 9))).toBe('ensemble-ai-adoption-workspace-2026-01-09.pdf');
  });

  it('says what happened in one line; with AI not asked for, nothing about AI', () => {
    const f = 'x.pdf';
    expect(doneLine({ aiRequested: false, aiWritten: 0, commentarySlides: 8, filename: f })).toBe('Saved x.pdf.');
    expect(doneLine({ aiRequested: true, aiWritten: 6, commentarySlides: 8, filename: f })).toBe('Saved. AI wrote 6 of 8 commentaries; 2 use the standard wording.');
    expect(doneLine({ aiRequested: true, aiWritten: 8, commentarySlides: 8, filename: f })).toBe('Saved. AI wrote all 8 commentaries.');
    expect(doneLine({ aiRequested: true, aiWritten: 0, commentarySlides: 8, filename: f })).toMatch(/none/);
  });

  it('the formatter words week_pct as a share of a week and other units by the shared default', () => {
    expect(deckFigureFormatter(adoptionFigure(3.2, 'week_pct', 1))).toBe('3.2% of a week');
    expect(deckFigureFormatter(adoptionFigure(4.1, 'usd', 1))).toBe('US$4.10');
    expect(deckFigureFormatter(adoptionFigure(34, 'pct', 1))).toBe('34%');
  });
});
