// THE AI ADOPTION REPORT'S SHARED CONTRACT (packages/shared/src/ai-adoption-report.ts;
// docs/AI-ADOPTION-REPORT.md § The commentary and its grounding). Pure: no DB, no model.
//
// What this pins:
//   1. THE GROUNDING GATE (`validateCommentary`): any numeral (ASCII and Unicode: '٣' '³' 'Ⅻ'), an
//      unknown or unusable key, a `.change` of a non-significant comparison, a malformed brace,
//      markup or a link, '@', a causal claim, too few or too many sentences, more than 600 characters
//      refuse the WHOLE text; one pair of wrapping quotes and whitespace are the only repairs.
//   2. `fillCommentary` substitutes code's words for every placeholder.
//   3. `fallbackCommentary` for every slide, with every figure withheld and with every figure shown:
//      never "undefined" / "NaN" / a raw brace, never a withheld figure, always 1–4 sentences.
//   4. `formatAdoptionFigure`: never US$ for a share of a week; never "100%" for a share short of all.
import { describe, expect, it } from 'vitest';
import {
  ADOPTION_COMMENTARY_SLIDES,
  AI_ADOPTION_REPORT_SCHEMA_VERSION,
  adoptionFigure,
  commentaryFigures,
  fallbackCommentary,
  fillCommentary,
  formatAdoptionChange,
  formatAdoptionFigure,
  validateCommentary,
  withheldFigure,
  type AdoptionComparison,
  type AdoptionComparisonKey,
  type AdoptionReportUnit,
  type AiAdoptionReport,
  type CommentaryFigure,
} from '@pierre-review/shared';

const iso = (t: number): string => new Date(t).toISOString();
const DAY = 86_400_000;
const T = Date.parse('2026-11-20T00:00:00Z');

function makeReport(shown: boolean): AiAdoptionReport {
  const f = (v: number, unit: AdoptionReportUnit, n = 40) => (shown ? adoptionFigure(v, unit, n) : withheldFigure(unit, 'low_sample', 2));
  const cmp = (key: AdoptionComparisonKey, unit: AdoptionReportUnit, b: number, a: number, significant = true): AdoptionComparison => ({
    key,
    before: f(b, unit),
    after: f(a, unit),
    direction: 'up_good',
    significant: shown && significant,
  });
  const share = cmp('ai_share', 'pct', 20, 45);
  return {
    schemaVersion: AI_ADOPTION_REPORT_SCHEMA_VERSION,
    workspaceId: 1,
    workspaceName: 'Acme',
    generatedAt: iso(T),
    window: { mode: 'rolling_14', from: iso(T - 14 * DAY), to: iso(T), end: iso(T), days: 14, elapsedDays: 14 },
    after: { from: iso(T - 14 * DAY), to: iso(T), days: 14 },
    before: { from: iso(T - 28 * DAY), to: iso(T - 14 * DAY), days: 14 },
    repos: { measured: 2, total: 2 },
    detection: { scannedPrs: 40, totalPrs: 40, scannedPct: shown ? 100 : null, complete: shown, detectorVersion: 1, coversFrom: null },
    markers: [],
    settingHistoryFrom: null,
    summary: { headlines: shown ? [share, cmp('lead_time', 'hours', 30, 20)] : [share], significantCount: shown ? 2 : 0 },
    adoption: {
      periods: [],
      aiShare: share,
      vendors: [
        { vendor: 'claude', before: f(4, 'count'), after: f(12, 'count'), afterShare: f(30, 'pct') },
        { vendor: 'copilot', before: f(2, 'count'), after: f(6, 'count'), afterShare: f(15, 'pct') },
      ],
      sources: [{ source: 'commit_trailer', prs: shown ? 10 : 0 }],
      otherAutomationPrs: 3,
    },
    people: {
      peopleUsingAi: cmp('people_using_ai', 'count', 3, 6),
      peopleShare: f(66.67, 'pct'),
      peopleWithMergedPrs: shown ? 9 : 0,
      vendors: shown
        ? [
            { vendor: 'claude', people: f(5, 'count'), prShare: f(30, 'pct') },
            { vendor: 'copilot', people: f(3, 'count'), prShare: f(15, 'pct') },
          ]
        : [],
      periods: [],
      agentPrs: shown ? { mergedPrs: 2, byVendor: { copilot: 2 } } : null,
      withheld: shown ? null : 'detection_incomplete',
    },
    delivery: {
      comparisons: [
        cmp('merged_prs', 'count', 30, 40),
        cmp('lead_time', 'hours', 30, 20),
        cmp('first_review', 'hours', 5, 3, false),
        cmp('pr_size', 'lines', 200, 150),
        cmp('ci_pass', 'pct', 90, 99.7),
      ],
      aiVsOther: shown
        ? {
            ai: { prs: 18, leadTimeHours: f(18, 'hours'), prSizeLines: f(120, 'lines'), ciPassPct: f(95, 'pct'), humanReviewCoveragePct: f(88, 'pct') },
            other: { prs: 22, leadTimeHours: f(22, 'hours'), prSizeLines: f(170, 'lines'), ciPassPct: f(92, 'pct'), humanReviewCoveragePct: f(90, 'pct') },
          }
        : null,
    },
    courts: {
      comparisons: [cmp('court_reviewer', 'pct', 50, 40), cmp('court_author', 'pct', 30, 35), cmp('court_landing', 'pct', 20, 25)],
      measuredPrs: { before: shown ? 30 : 0, after: shown ? 40 : 0 },
      refusals: [],
    },
    reviewBots: {
      bots: [
        {
          key: 'u1',
          label: 'CodeRabbit',
          kind: 'coderabbit',
          threads: 40,
          comments: 60,
          commentsPerPr: f(1.5, 'ratio'),
          actedOnPct: f(55, 'pct'),
          actedOnPctBefore: f(50, 'pct'),
          seatPriceMonthlyUsd: shown ? 24 : null,
          costPerActedOnUsd: shown ? adoptionFigure(1.2, 'usd', 22) : withheldFigure('usd', 'no_price'),
        },
      ],
      ensemble: null,
      ensembleActedOn: cmp('ensemble_acted_on', 'pct', 60, 70),
      mergedPrs: 40,
    },
    guardrails: {
      comparisons: [cmp('ci_pass', 'pct', 90, 99.7), cmp('human_review_coverage', 'pct', 85, 88), cmp('ai_human_review_coverage', 'pct', 80, 86)],
    },
    cost: {
      costUnit: shown ? 'week_pct' : null,
      aiEnabled: shown,
      comparisons: shown
        ? [cmp('ai_cost_total', 'week_pct', 4, 6, false), cmp('ai_cost_per_pr', 'week_pct', 0.13, 0.15, false)]
        : [
            { key: 'ai_cost_total', before: withheldFigure('usd', 'ai_off'), after: withheldFigure('usd', 'ai_off'), direction: 'neutral', significant: false },
            { key: 'ai_cost_per_pr', before: withheldFigure('usd', 'ai_off'), after: withheldFigure('usd', 'ai_off'), direction: 'neutral', significant: false },
          ],
      runs: { before: 10, after: shown ? 1 : 0 },
      tokens: { before: 1000, after: 2000 },
      machineWideRuns: 0,
      seats: shown ? [{ label: 'CodeRabbit', monthlyUsd: 24 }] : [],
      seatsMonthlyUsd: shown ? 24 : null,
    },
  };
}

const TABLE: CommentaryFigure[] = [
  { key: 'period.after', label: 'period', text: 'in the last 14 days', usable: true },
  { key: 'ai_share.after', label: 'share', text: '45%', usable: true },
  { key: 'ai_share.before', label: 'share before', text: '20%', usable: true },
  { key: 'ai_share.change', label: 'change', text: 'up 25 points', usable: true },
  { key: 'lead_time.change', label: 'lead change (significant: no)', text: 'down 3%', usable: false },
  { key: 'first_review.after', label: 'withheld', text: null, usable: false },
  // Before and after shown, change not significant: the two figures may sit side by side, never "rose".
  { key: 'ci_pass.before', label: 'ci before', text: '91%', usable: true },
  { key: 'ci_pass.after', label: 'ci after', text: '93%', usable: true },
  { key: 'ci_pass.change', label: 'ci change (significant: no)', text: 'up 2 points', usable: false },
];

const ok = (text: string) => validateCommentary(text, TABLE);
const refused = (text: string) => {
  const v = ok(text);
  expect(v.ok, text).toBe(false);
  return v.ok ? [] : v.problems;
};

describe('validateCommentary — the grounding gate', () => {
  it('accepts grounded text and returns it as the template', () => {
    const t = 'AI was involved in {{ai_share.after}} of merged PRs {{period.after}}, against {{ai_share.before}} before ({{ai_share.change}}).';
    expect(ok(t)).toEqual({ ok: true, template: t });
  });

  it('refuses any numeral, Unicode ones too', () => {
    for (const d of ['3', '٣', '³', 'Ⅻ', '５', '½']) {
      expect(refused(`AI use reached {{ai_share.after}} over ${d} sprints.`).join(' ')).toMatch(/digit or numeral/);
    }
  });

  it('refuses number words and multiplying words, case-blind, as whole words', () => {
    const words = [
      'zero', 'one', 'two', 'Three', 'seven', 'twelve', 'twenty', 'thirty', 'ninety', 'hundred', 'thousands', 'million',
      'a dozen', 'half', 'halved', 'a third', 'a quarter', 'double', 'doubled', 'doubling', 'triple', 'tripled', 'twice',
      'thrice', 'percent', 'per cent', 'tenfold', 'fold', '×',
    ];
    for (const w of words) {
      expect(refused(`AI was involved in {{ai_share.after}} of PRs, ${w} the share before.`).join(' '), w).toMatch(/quantity in words/);
    }
    for (const t of [
      'AI was involved in {{ai_share.after}} of PRs, double the share before.',
      'Teams merged three times as many PRs with AI, {{ai_share.after}} in all.',
      'Half of the team used AI, {{ai_share.after}} of PRs.',
      'Reviews ran twice as fast while AI reached {{ai_share.after}}.',
      'AI reached {{ai_share.after}}%.',
    ]) {
      expect(refused(t).join(' '), t).toMatch(/quantity in words/);
    }
    // Whole words only: "someone", "often", "scaffold", "tone", "attention" are not numbers.
    expect(ok('Someone often reviews the scaffold in a calm tone; AI reached {{ai_share.after}}.').ok).toBe(true);
  });

  it('refuses a move word beside a change that is not clear, sentence by sentence', () => {
    for (const w of ['rose', 'fell', 'grew', 'dropped', 'jumped', 'climbed', 'declined', 'increased', 'decreased', 'surged', 'halved', 'improved', 'a sharp rise']) {
      const t = `CI passing at merge ${w} to {{ci_pass.after}} from {{ci_pass.before}}.`;
      expect(refused(t).join(' '), w).toMatch(/not clear is described as a move|quantity in words/);
    }
    expect(refused('CI passing was {{ci_pass.after}}, a sharp rise from {{ci_pass.before}}.').join(' ')).toMatch(/described as a move/);
    // Side by side is fine.
    expect(ok('CI passing at merge was {{ci_pass.after}} {{period.after}}, against {{ci_pass.before}} before.').ok).toBe(true);
    // A significant change may be narrated, even when another sentence shows a non-significant one.
    expect(ok('AI use rose to {{ai_share.after}} ({{ai_share.change}}). CI passing was {{ci_pass.after}}, against {{ci_pass.before}} before.').ok).toBe(true);
    expect(refused('AI use rose to {{ai_share.after}}. CI passing rose to {{ci_pass.after}} from {{ci_pass.before}}.').join(' ')).toMatch(/described as a move/);
  });

  it('refuses an unknown key, an unusable key and a non-significant change', () => {
    expect(refused('It was {{lead_time.after}}.').join(' ')).toMatch(/not a figure on this slide/);
    expect(refused('Review took {{first_review.after}}.').join(' ')).toMatch(/no figure to show/);
    expect(refused('Lead time moved {{lead_time.change}} while AI reached {{ai_share.after}}.').join(' ')).toMatch(/no figure to show/);
    expect(refused('It was {{ AI_SHARE.after }}.').join(' ')).toMatch(/not a figure/);
  });

  it('refuses malformed braces and text with no placeholder', () => {
    expect(refused('AI reached {{ai_share.after} of PRs.').join(' ')).toMatch(/malformed/);
    expect(refused('AI reached {{{ai_share.after}}} of PRs.').join(' ')).toMatch(/malformed/);
    expect(refused('AI reached {ai_share.after} of PRs.').join(' ')).toMatch(/malformed|at least one/);
    expect(refused('AI use went up a lot.').join(' ')).toMatch(/at least one figure/);
  });

  it('refuses markup, links and handles', () => {
    for (const t of ['**AI** reached {{ai_share.after}}.', 'AI reached {{ai_share.after}}, see https://example.com.', 'AI reached {{ai_share.after}} <b>now</b>.', 'See [the chart] for {{ai_share.after}}.', 'Ask @alice about {{ai_share.after}}.', 'AI reached {{ai_share.after}} at www.example.com.']) {
      expect(ok(t).ok, t).toBe(false);
    }
  });

  it('refuses a causal claim', () => {
    for (const w of ['caused', 'because of', 'due to', 'thanks to', 'led to', 'resulted in', 'driven by', 'proves']) {
      expect(refused(`Lead time fell ${w} AI, now {{ai_share.after}}.`).join(' ')).toMatch(/cause/);
    }
    // "approved" and "improve" are not "prove".
    expect(ok('People approved most PRs and AI reached {{ai_share.after}}, which may improve flow.').ok).toBe(true);
  });

  it('allows one to four sentences, at most 600 characters', () => {
    const s = 'AI reached {{ai_share.after}}.';
    expect(ok([s, s, s, s].join(' ')).ok).toBe(true);
    expect(refused([s, s, s, s, s].join(' ')).join(' ')).toMatch(/sentences/);
    expect(refused(`AI reached {{ai_share.after}} ${'and more '.repeat(70)}.`).join(' ')).toMatch(/characters/);
  });

  it('strips one pair of wrapping quotes and folds whitespace, nothing more', () => {
    expect(ok('"AI reached\n\n {{ai_share.after}}."')).toEqual({ ok: true, template: 'AI reached {{ai_share.after}}.' });
    expect(ok('“AI reached {{ai_share.after}}.”')).toEqual({ ok: true, template: 'AI reached {{ai_share.after}}.' });
    expect(ok('   ').ok).toBe(false);
  });
});

describe('fillCommentary', () => {
  it("substitutes code's words for every placeholder", () => {
    expect(fillCommentary('AI reached {{ai_share.after}} {{ period.after }} ({{ai_share.change}}).', TABLE)).toBe('AI reached 45% in the last 14 days (up 25 points).');
    expect(fillCommentary('Unknown {{nope.after}}.', TABLE)).toBe('Unknown —.');
  });
});

describe('fallbackCommentary — every slide', () => {
  for (const shown of [true, false]) {
    for (const slide of ADOPTION_COMMENTARY_SLIDES) {
      it(`${slide}, figures ${shown ? 'shown' : 'withheld'}: grounded, filled, never a withheld figure`, () => {
        const r = makeReport(shown);
        const table = commentaryFigures(r, slide);
        const template = fallbackCommentary(r, slide);
        const filled = fillCommentary(template, table);
        expect(filled).not.toMatch(/undefined|NaN|null|\{|\}|—/);
        const usable = new Set(table.filter((f) => f.usable).map((f) => f.key));
        for (const m of template.matchAll(/\{\{([^{}]+)\}\}/g)) expect(usable.has(m[1]!.trim()), `${slide}: ${m[1]}`).toBe(true);
        const sentences = filled.split(/[.!?](?:\s|$)/).filter((x) => x.trim() !== '').length;
        expect(sentences).toBeGreaterThanOrEqual(1);
        expect(sentences).toBeLessThanOrEqual(4);
        // The template passes the same gate the model's text must pass (or is the fixed "nothing to say").
        const v = validateCommentary(template, table);
        if (!v.ok) expect(template).toBe('There is not enough data in this period to say more.');
        if (!shown) expect(filled).not.toMatch(/\d+%|US\$/);
      });
    }
  }

  it('never writes a dangling "Before" or "That is" sentence', () => {
    const r = makeReport(true);
    expect(fillCommentary(fallbackCommentary(r, 'people'), commentaryFigures(r, 'people'))).toBe(
      '6 of 9 people merged a PR with AI involved in the last 14 days, against 3 before. Claude was the most widely used tool, by 5 people. PRs opened by an AI coding agent with no person named: 2.',
    );
    const cost = fillCommentary(fallbackCommentary(r, 'cost'), commentaryFigures(r, 'cost'));
    expect(cost).not.toMatch(/That is|1 runs/);
    expect(cost).toContain('Ensemble AI runs in the last 14 days: 1, costing 6% of a week in all.');
  });

  it('an unknown count (a fold that failed) is never offered to the model or the template as 0', () => {
    const r = makeReport(true);
    r.courts.measuredPrs = { before: null, after: null };
    r.cost.runs = { before: null, after: null };
    const courts = commentaryFigures(r, 'courts');
    for (const k of ['courts.measured.before', 'courts.measured.after']) {
      expect(courts.find((f) => f.key === k)).toMatchObject({ text: null, usable: false });
    }
    expect(commentaryFigures(r, 'cost').find((f) => f.key === 'cost.runs.after')).toMatchObject({ text: null, usable: false });
    for (const slide of ['courts', 'cost'] as const) {
      const filled = fillCommentary(fallbackCommentary(r, slide), commentaryFigures(r, slide));
      expect(filled, slide).not.toMatch(/(?<![\d.])0(?![\d.])|—/);
    }
  });

  it('names the tool most people used, by how many; never on a tie', () => {
    const r = makeReport(true);
    expect(fillCommentary(fallbackCommentary(r, 'people'), commentaryFigures(r, 'people'))).toContain('was the most widely used tool, by 5 people.');
    r.people.vendors[1]!.people = { available: true, value: 5, unit: 'count', sampleSize: 9 };
    expect(fallbackCommentary(r, 'people')).not.toContain('most widely used');
  });

  it('a count of 1 or 2 people never reaches the commentary', () => {
    const r = makeReport(true);
    const few = { available: false as const, unit: 'count' as const, sampleSize: 9, reason: 'few_people' as const };
    r.people.peopleUsingAi = { ...r.people.peopleUsingAi, after: few, before: few, significant: false };
    r.people.peopleShare = { ...few, unit: 'pct' };
    r.people.vendors[0]!.people = few;
    r.people.vendors[1]!.people = few;
    const figs = commentaryFigures(r, 'people');
    for (const k of ['people_using_ai.after', 'people_using_ai.before', 'people.share', 'vendor.claude.people', 'vendor.copilot.people']) {
      expect(figs.find((x) => x.key === k), k).toMatchObject({ text: null, usable: false });
    }
    const filled = fillCommentary(fallbackCommentary(r, 'people'), figs);
    expect(filled).not.toMatch(/people merged a PR with AI|most widely used/);
  });
});

describe('formatAdoptionFigure', () => {
  it('never writes US$ for a share of a week', () => {
    for (const v of [0, 0.05, 0.4, 6, 12.5, 250]) {
      const t = formatAdoptionFigure({ available: true, value: v, unit: 'week_pct', sampleSize: 1 });
      expect(t).not.toMatch(/US\$|\$/);
      expect(t).toMatch(/of a week$/);
    }
    expect(formatAdoptionFigure({ available: true, value: 12.345, unit: 'usd', sampleSize: 1 })).toBe('US$12.35');
    expect(formatAdoptionFigure({ available: true, value: 0.004, unit: 'usd', sampleSize: 1 })).toBe('under US$0.01');
  });

  it('never rounds a share to none or all when it is neither', () => {
    const pct = (v: number) => formatAdoptionFigure({ available: true, value: v, unit: 'pct', sampleSize: 1 });
    expect(pct(0.4)).toBe('under 1%');
    expect(pct(99.7)).toBe('over 99%');
    expect(pct(100)).toBe('100%');
    expect(pct(0)).toBe('0%');
    expect(pct(45.5)).toBe('46%');
  });

  it('words hours, lines and changes', () => {
    const h = (v: number) => formatAdoptionFigure({ available: true, value: v, unit: 'hours', sampleSize: 1 });
    expect(h(0.5)).toBe('30 minutes');
    expect(h(1)).toBe('1 hour');
    expect(h(20)).toBe('20 hours');
    expect(h(72)).toBe('3 days');
    expect(formatAdoptionFigure({ available: true, value: 1, unit: 'lines', sampleSize: 1 })).toBe('1 line');
    const c = (b: number, a: number, unit: AdoptionReportUnit): AdoptionComparison => ({ key: 'lead_time', before: adoptionFigure(b, unit, 9), after: adoptionFigure(a, unit, 9), direction: 'down_good', significant: true });
    expect(formatAdoptionChange(c(20, 45, 'pct'))).toBe('up 25 points');
    expect(formatAdoptionChange(c(30, 20, 'hours'))).toBe('down 33%');
    expect(formatAdoptionChange(c(0, 4, 'count'))).toBe('up from none');
    expect(formatAdoptionChange({ ...c(1, 2, 'pct'), before: withheldFigure('pct', 'low_sample') })).toBeNull();
  });
});
