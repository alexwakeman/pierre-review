// `MlSeverityBadge` — the ONE place a severity pill is drawn (CommentBlock covers all eight
// ThreadCard mount sites, plus PrDetail's conversation list and ThreadCard's own rollup header).
//
// WHAT THIS FILE IS FOR. The pill now carries three facts beyond the severity word, and each one
// is a claim that can be made dishonestly:
//
//   1. the VENDOR'S OWN badge, shown only when it contradicts ours. It is a display of what the
//      bot claimed, never a correction: on a held-out adjudicated sample our severities score
//      0.700 exact / 0.303 ordinal MAE against the vendor badge's 0.474 / 0.697. Rendering it on
//      agreement would be noise; rendering it against a ROLLUP would silently mix two raters.
//   2. `severityProb < 0.25`, which is an IDENTITY — a four-class argmax is never below 1/4, so
//      such a label is one the model did not pick and calibration overrode. Distinct state.
//   3. ordinary low confidence, a weaker version of the same statement, not a different one.
//
// …and one thing that must NOT change: a label with no vendor claim and ordinary confidence is
// the overwhelmingly common case, and it sits in dense comment header rows. Its markup is frozen
// below against the pre-change output, byte for byte, so nothing here can cost that path a
// reflow.
//
// No JSX: this directory is plain `.ts` (see vitest.config.ts), so the component is instantiated
// with `createElement` and rendered to static markup.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MlLabel } from '@pierre-review/shared';
import { MlSeverityBadge } from '../src/components/MlSeverityBadge.js';

const label = (over: Partial<MlLabel> = {}): MlLabel => ({
  targetKind: 'review_comment',
  targetId: 1,
  severity: 'minor',
  severityOrd: 1,
  severityProb: 0.62,
  vendorSeverity: null,
  vendorSeverityConfidence: null,
  categories: ['correctness_bug', 'testing'],
  isSummary: false,
  backend: 'severity:modernbert-onnx,category:modernbert-onnx',
  modelVersion: 'severity-v2',
  createdAt: '2026-08-05T00:00:00.000Z',
  ...over,
});

const render = (l: MlLabel | undefined, compact?: boolean): string =>
  renderToStaticMarkup(createElement(MlSeverityBadge, { label: l, compact }));

/** The `title=` attribute, unescaped enough to assert prose against. */
const tooltip = (html: string): string => {
  const m = /title="([^"]*)"/.exec(html);
  return (m?.[1] ?? '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
};

describe('MlSeverityBadge — the vendor\'s own claim', () => {
  it('renders nothing extra when the vendor declared nothing', () => {
    // The common case by a distance: most comments carry no badge, and an older severity-api
    // omits the fields entirely. Both arrive here as null and both mean "no vendor claim".
    const html = render(label({ vendorSeverity: null }));
    expect(html).not.toContain('bot said');
    expect(tooltip(html)).not.toContain('badged');
  });

  it('stays silent when the vendor agrees with us', () => {
    // Two pills saying the same thing is noise. Agreement is not a fact worth pixels.
    const html = render(label({ severity: 'major', vendorSeverity: 'major' }));
    expect(html).not.toContain('bot said');
    expect(tooltip(html)).not.toContain('badged');
  });

  it('shows what the bot called it when the two disagree', () => {
    const html = render(
      label({ severity: 'minor', vendorSeverity: 'critical', vendorSeverityConfidence: 'high' }),
    );
    expect(html).toContain('bot said');
    expect(html).toContain('Critical');
    // Ours is still the pill; theirs is bare tinted text. The form difference is the hierarchy.
    expect(html).toContain('Minor');
    expect(tooltip(html)).toContain('The bot badged this Critical itself.');
    // The one clause on why ours is the one to trust — never a hedge, never an invitation to
    // resolve the disagreement.
    expect(tooltip(html)).toContain('Ours is the more accurate rating');
  });

  it('qualifies a shaky marker read, and only a shaky one', () => {
    // `vendorSeverityConfidence` is the parser's confidence that it READ a real declared badge —
    // metadata about the vendor's claim, never about ours. Saying so keeps us from misquoting a
    // bot on a guess; saying it every time would be noise.
    const shaky = tooltip(
      render(label({ vendorSeverity: 'major', vendorSeverityConfidence: 'low' })),
    );
    expect(shaky).toContain('a low-confidence read of its own markup');
    const firm = tooltip(
      render(label({ vendorSeverity: 'major', vendorSeverityConfidence: 'high' })),
    );
    expect(firm).toContain('The bot badged this Major itself.');
    expect(firm).not.toContain('read of its own markup');
  });

  it('never shows a vendor claim in compact mode', () => {
    // Compact is ThreadCard's header, which shows the thread's WORST non-summary severity — a
    // rollup across comments. Putting one comment's vendor badge next to it would present a
    // second rater's verdict as if it commented on our aggregate.
    const html = render(label({ severity: 'minor', vendorSeverity: 'critical' }), true);
    expect(html).not.toContain('bot said');
    expect(tooltip(html)).not.toContain('badged');
  });
});

describe('MlSeverityBadge — confidence is two separate facts', () => {
  // ── (a) the calibration override: an identity, not a threshold ──────────────────────────
  it('marks a label the model did not pick as its own state', () => {
    const html = render(label({ severityProb: 0.18 }));
    // Hollow dot, drawn as an inset ring so the pill's geometry does not move.
    expect(html).toContain('box-shadow:inset 0 0 0 1px');
    expect(html).not.toContain('<span class="inline-block h-1.5 w-1.5 rounded-full" style="background-color');
    const t = tooltip(html);
    expect(t).toContain('The model did not pick this label');
    expect(t).toContain('a four-class score is never under 25%');
    expect(t).toContain('18%');
    // NOT the low-confidence sentence: it is a different statement, and the distinction is the
    // whole point of having two states.
    expect(t).not.toContain('materially less reliable');
  });

  it('says nothing about an argmax the model never computed', () => {
    // On a marker-fallback deployment `severityProb` is not a softmax, so the ≥ 1/4 floor does
    // not hold and "the model did not pick this" would be a fabricated claim.
    const html = render(
      label({ severityProb: 0.18, backend: 'severity:marker,category:marker' }),
    );
    expect(html).not.toContain('box-shadow');
    expect(tooltip(html)).not.toContain('The model did not pick this label');
    expect(tooltip(html)).toContain('Heuristic fallback');
  });

  // ── (b) ordinary low confidence: the same statement, weaker ─────────────────────────────
  it('de-emphasises a low-confidence pill without changing its shape', () => {
    const html = render(label({ severityProb: 0.41 }));
    expect(html).toContain('opacity-70');
    // Still a solid dot — this label IS the model's own pick, just not a confident one.
    expect(html).toContain('background-color:#0284c7"></span>');
    expect(html).not.toContain('box-shadow');
    expect(tooltip(html)).toContain('under 50% confidence, where this label is materially less reliable');
  });

  it('leaves a confident pill at full strength', () => {
    const html = render(label({ severityProb: 0.5 }));
    expect(html).not.toContain('opacity-70');
    expect(tooltip(html)).not.toContain('materially less reliable');
  });

  it('dims the override state too — it is below both lines', () => {
    // 0.18 < 0.25 < 0.5, so the weaker state is also the fainter one. The RING is what makes it
    // distinct; the dimming is just the ordinary consequence of a low number.
    const html = render(label({ severityProb: 0.18 }));
    expect(html).toContain('opacity-70');
  });
});

describe('MlSeverityBadge — the common path must not move', () => {
  // Frozen against the pre-change output, captured before any of this landed. This pill sits in
  // comment header rows next to a state badge, a confidence badge and a relative timestamp; a
  // stray wrapper or a changed class here is a reflow on every bot comment in the app, for the
  // ~85% of labels that have neither a vendor claim nor a sub-0.5 score.
  const FROZEN =
    '<span class="inline-flex items-center gap-1" title="Minor: A small but genuine issue.\n' +
    'Confidence 62%. Category: Correctness, Testing.">' +
    '<span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold" ' +
    'style="background-color:#0284c71a;--ink-light:#027ab8;--ink-dark:#0284c7">' +
    '<span class="inline-block h-1.5 w-1.5 rounded-full" style="background-color:#0284c7"></span>Minor</span>' +
    '<span class="rounded bg-gray-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ' +
    'text-gray-500 dark:bg-gray-800 dark:text-gray-400">Correctness · Testing</span></span>';

  // ⚠ THE FROZEN OUTPUT MOVED ONCE, DELIBERATELY: `color:#0284c7` became
  // `--ink-light:#027ab8;--ink-dark:#0284c7`. A reader reported a vendor chip as unreadable in
  // dark mode, and the cause was general — a raw brand hex used as text colour on two opposite
  // grounds. 40 of 83 vendor colours failed AA on dark, 43 on light, and no single colour can
  // clear AA on both (the luminance windows do not overlap — vendorInk.test.ts proves it by
  // sweep). So the colour is now two variants picked in CSS per theme.
  //
  // Note what did NOT change: the DARK variant is the original #0284c7, because it already
  // passed. Only the light one is adjusted, and only in lightness. That is the shape of every
  // colour here — a brand that was already legible is left exactly alone.
  const FROZEN_COMPACT =
    '<span class="inline-flex items-center gap-1" title="Minor: A small but genuine issue.\n' +
    'Confidence 62%. Category: Correctness, Testing.">' +
    '<span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold" ' +
    'style="background-color:#0284c71a;--ink-light:#027ab8;--ink-dark:#0284c7">' +
    '<span class="inline-block h-1.5 w-1.5 rounded-full" style="background-color:#0284c7"></span>Minor</span></span>';

  it('renders byte-identically to the pre-change output', () => {
    expect(render(label())).toBe(FROZEN);
    expect(render(label(), true)).toBe(FROZEN_COMPACT);
  });

  it('is unchanged by a vendor claim that agrees', () => {
    // Agreement takes the same path as no claim at all — not merely a hidden element, the same
    // bytes.
    expect(render(label({ severity: 'minor', vendorSeverity: 'minor' }))).toBe(FROZEN);
  });

  it('still renders nothing without a label', () => {
    // The load-bearing rule on this surface: no label, no box, no request.
    expect(render(undefined)).toBe('');
  });
});
