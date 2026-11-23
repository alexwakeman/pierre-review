import {
  ADOPTION_COMMENTARY_SLIDES,
  ADOPTION_COMPARISON_LABEL,
  ADOPTION_REPORT_FLOORS,
  ADOPTION_SLIDE_TITLE,
  ADOPTION_WITHHELD_TEXT,
  AI_CODING_VENDORS,
  AI_CODING_VENDOR_LABEL,
  AI_CODING_VENDOR_MAKER,
  AI_SIGNAL_SOURCE_LABEL,
  commentaryFigures,
  fallbackCommentary,
  fillCommentary,
  formatAdoptionChange,
  formatAdoptionFigure,
  reportingWindowPhrase,
  reportingWindowTitle,
  validateCommentary,
  type AdoptionCommentaryResponse,
  type AdoptionCommentarySlide,
  type AdoptionComparison,
  type AdoptionComparisonKey,
  type AdoptionFigure,
  type AdoptionFigureFormatter,
  type AdoptionSlideId,
  type AdoptionSpan,
  type AiAdoptionReport,
  type AiCodingVendor,
  type AvailableAdoptionFigure,
} from '@pierre-review/shared';
import { usageCostText } from '../../../lib/aiBudget.js';
import { adoptionChart, courtBars, legendRow, pairedPctBars, peopleShareChart, type Box } from './deckCharts.js';
import { COURT_COLOR, DECK_INK, DECK_MARK } from './deckColors.js';

// THE DECK MODEL (Reports → Download report; docs/AI-ADOPTION-REPORT.md § The UI). Pure: the report,
// the commentary and the reader's options in, pages of POSITIONED PRIMITIVES out, on a 960 × 540 pt
// canvas (16:9, origin top-left, y down). No pdf-lib here: the renderer (renderDeckPdf.ts) only draws
// what this file placed, so every rule below is testable without a PDF.
//
// ⚠ ONE IDEA PER PAGE: a kicker (the slide's name), a big headline, a chart or a table, and two to
//   four sentences of commentary beside it.
// ⚠ UNKNOWN IS NEVER ZERO: a withheld figure is "—" with its reason (ADOPTION_WITHHELD_TEXT).
// ⚠ EVERY NUMBER IS CODE'S: figures through the injected formatter; AI commentary is a validated
//   template filled from the same figure table (commentaryFromResponse).
// ⚠ NOBODY IS NAMED: "How widely AI is used" counts people (overall, per tool, per period), never
//   who. A count of 1 or 2 people arrives withheld 'few_people' and prints "Fewer than 3".
// ⚠ NEVER US$ ON A SUBSCRIPTION: AI spend is worded through `usageCostText` ('week_pct' ⇒ "% of a
//   week"); only seat prices, which the reader entered in US$, say US$.

export const DECK_W = 960;
export const DECK_H = 540;

export type DeckWeight = 'regular' | 'semibold';

export type DeckPrimitive =
  | { kind: 'text'; x: number; y: number; text: string; size: number; weight: DeckWeight; color: string; align: 'left' | 'right' | 'center' }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; strokeWidth?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number; dash?: number[] }
  | { kind: 'path'; d: string; stroke?: string; fill?: string; width?: number; dash?: number[] }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string };

export interface DeckPage {
  slide: AdoptionSlideId;
  primitives: DeckPrimitive[];
}

export interface Deck {
  /** The PDF's title metadata: "AI adoption report — <workspace>". Never a person's name. */
  title: string;
  pages: DeckPage[];
  /** Commentary slides whose text AI wrote (validated), of `commentarySlides`. */
  aiWritten: number;
  commentarySlides: number;
}

/** What the renderer's fonts can measure and draw. Injected, so the model stays pure. */
export interface DeckTextMetrics {
  width(text: string, size: number, weight: DeckWeight): number;
  /** Every character of `text` has a glyph in both fonts. */
  canDraw(text: string): boolean;
}

export interface SlideCommentary {
  text: string;
  source: 'ai' | 'template';
}

export type DeckCommentary = Partial<Record<AdoptionCommentarySlide, SlideCommentary>>;

export interface DeckOptions {
  preparedFor: string | null;
  /** When the PDF is made (the title slide's date). */
  generatedOn: Date;
}

// ── Figures in words ────────────────────────────────────────────────────────────────────────────

/**
 * The deck's figure formatter: AI spend ('usd', 'week_pct') through the app's ONE summed-cost wording
 * (`usageCostText`), everything else the shared default. ⚠ 'week_pct' is never US$.
 */
export const deckFigureFormatter: AdoptionFigureFormatter = (f) => {
  if (f.unit === 'usd' || f.unit === 'week_pct') return usageCostText(f.value, f.unit) ?? formatAdoptionFigure(f);
  return formatAdoptionFigure(f);
};

/**
 * One slide's commentary from the route's answer: an 'ai' template is RE-VALIDATED here against the
 * SPA's own figure table (belt and braces), then filled by code. Anything else (null: AI unticked, the
 * call failed; 'fallback'; a template that fails the gate) ⇒ the template wording from the same figures.
 */
export function commentaryFromResponse(
  r: AiAdoptionReport,
  slide: AdoptionCommentarySlide,
  res: AdoptionCommentaryResponse | null,
  fmt: AdoptionFigureFormatter = deckFigureFormatter,
): SlideCommentary {
  const figures = commentaryFigures(r, slide, fmt);
  if (res != null && res.source === 'ai' && res.slide === slide) {
    const v = validateCommentary(res.template, figures);
    if (v.ok) return { text: fillCommentary(v.template, figures), source: 'ai' };
  }
  return { text: fillCommentary(fallbackCommentary(r, slide, fmt), figures), source: 'template' };
}

// ── Layout constants ────────────────────────────────────────────────────────────────────────────

const M = 48;
const KICKER_Y = 60;
const HEADLINE_Y = 98;
const BODY_TOP = 140;
const BODY_BOTTOM = 482;
const LEFT: Box = { x: M, y: BODY_TOP, w: 560, h: BODY_BOTTOM - BODY_TOP };
const RIGHT_X = 644;
const RIGHT_W = DECK_W - M - RIGHT_X;
const FULL_W = DECK_W - 2 * M;
const AI_LABEL = 'Written by AI from the figures on this page.';

const dateFmt = (iso: string | Date): string =>
  (typeof iso === 'string' ? new Date(iso) : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** A half-open span in words: "3 Nov 2026 to 16 Nov 2026 (14 days)". */
function spanWords(s: AdoptionSpan): string {
  const last = new Date(Math.max(Date.parse(s.from), Date.parse(s.to) - 1));
  return `${dateFmt(s.from)} to ${dateFmt(last)} (${s.days.toLocaleString('en-GB')} days)`;
}

// ── The page builder ───────────────────────────────────────────────────────────────────────────

interface Cell {
  text: string;
  /** A withheld cell's reason: drawn after "—" when it fits, else as a footnote. */
  note?: string;
  tone?: 'ink' | 'mute';
  weight?: DeckWeight;
}

interface Col {
  header: string;
  width: number;
  align: 'left' | 'right';
}

class PageBuilder {
  readonly primitives: DeckPrimitive[] = [];
  readonly footnotes = new Set<string>();

  constructor(
    readonly slide: AdoptionSlideId,
    private readonly m: DeckTextMetrics,
  ) {}

  /** Characters the fonts cannot draw are dropped (a workspace or bot name with an emoji). */
  printable(s: string): string {
    if (this.m.canDraw(s)) return s;
    return [...s].filter((ch) => this.m.canDraw(ch)).join('');
  }

  text(x: number, y: number, s: string, size: number, o: { weight?: DeckWeight; color?: string; align?: 'left' | 'right' | 'center' } = {}): void {
    const t = this.printable(s);
    if (t === '') return;
    this.primitives.push({ kind: 'text', x, y, text: t, size, weight: o.weight ?? 'regular', color: o.color ?? DECK_INK.ink, align: o.align ?? 'left' });
  }

  width(s: string, size: number, weight: DeckWeight = 'regular'): number {
    return this.m.width(this.printable(s), size, weight);
  }

  /** Greedy word wrap; a word longer than the line is broken by characters. */
  wrap(s: string, maxW: number, size: number, weight: DeckWeight = 'regular'): string[] {
    const words = this.printable(s).split(/\s+/).filter((w) => w !== '');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line === '' ? word : `${line} ${word}`;
      if (this.m.width(next, size, weight) <= maxW) {
        line = next;
        continue;
      }
      if (line !== '') lines.push(line);
      if (this.m.width(word, size, weight) <= maxW) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        if (chunk !== '' && this.m.width(chunk + ch, size, weight) > maxW) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += ch;
      }
      line = chunk;
    }
    if (line !== '') lines.push(line);
    return lines;
  }

  /** One line cut to fit with an ellipsis. */
  fit(s: string, maxW: number, size: number, weight: DeckWeight = 'regular'): string {
    const t = this.printable(s);
    if (this.m.width(t, size, weight) <= maxW) return t;
    let out = t;
    while (out.length > 1 && this.m.width(`${out}…`, size, weight) > maxW) out = out.slice(0, -1);
    return `${out.trimEnd()}…`;
  }

  /** A wrapped paragraph; returns the y under it. Stops (and returns null) past `bottom`. */
  paragraph(x: number, y: number, s: string, maxW: number, size: number, o: { weight?: DeckWeight; color?: string; lead?: number; bottom?: number } = {}): number {
    const lead = o.lead ?? Math.round(size * 1.45);
    let cy = y;
    for (const line of this.wrap(s, maxW, size, o.weight)) {
      if (o.bottom != null && cy > o.bottom) break;
      this.text(x, cy, line, size, { weight: o.weight, color: o.color });
      cy += lead;
    }
    return cy;
  }

  header(kicker: string, headline: string): void {
    this.text(M, KICKER_Y, kicker, 13, { weight: 'semibold', color: DECK_INK.accent });
    this.text(M, HEADLINE_Y, this.fit(headline, FULL_W, 28, 'semibold'), 28, { weight: 'semibold' });
  }

  /** The commentary column: the text, then the AI label when AI wrote it. */
  commentary(c: SlideCommentary, box: Box = { x: RIGHT_X, y: BODY_TOP + 6, w: RIGHT_W, h: BODY_BOTTOM - BODY_TOP }): number {
    this.primitives.push({ kind: 'rect', x: box.x - 14, y: box.y - 12, w: 2, h: Math.min(box.h, 200), fill: DECK_MARK.rule });
    let y = this.paragraph(box.x, box.y + 4, c.text, box.w, 13, { lead: 19, bottom: box.y + box.h - 20 });
    if (c.source === 'ai') {
      y += 2;
      y = this.paragraph(box.x, y, AI_LABEL, box.w, 11, { color: DECK_INK.soft, lead: 15 });
    }
    return y;
  }

  /** A note under the commentary (detection coverage, sources). */
  note(y: number, s: string, maxW = RIGHT_W, x = RIGHT_X): number {
    return this.paragraph(x, y, s, maxW, 11, { color: DECK_INK.mute, lead: 15 });
  }

  /** A text table; returns the y under its last row. */
  table(x: number, y: number, cols: readonly Col[], rows: readonly Cell[][], o: { rowH?: number; size?: number } = {}): number {
    const size = o.size ?? 12;
    const rowH = o.rowH ?? 21;
    const pad = 6;
    const headerLines = cols.map((c) => this.wrap(c.header, c.width - pad, 11, 'semibold').slice(0, 3));
    const headerH = Math.max(1, ...headerLines.map((l) => l.length)) * 13;
    let cx = x;
    cols.forEach((c, i) => {
      const lines = headerLines[i]!;
      const top = y + headerH - lines.length * 13 + 9;
      lines.forEach((line, k) => {
        const tx = c.align === 'right' ? cx + c.width - pad : cx;
        this.text(tx, top + k * 13, line, 11, { weight: 'semibold', color: DECK_INK.mute, align: c.align });
      });
      cx += c.width;
    });
    const total = cols.reduce((a, c) => a + c.width, 0);
    let cy = y + headerH + 5;
    this.primitives.push({ kind: 'line', x1: x, y1: cy, x2: x + total, y2: cy, color: DECK_MARK.rule, width: 1 });
    for (const row of rows) {
      cx = x;
      const rowTop = cy;
      cols.forEach((c, i) => {
        const cell = row[i] ?? { text: '' };
        this.cell(cx, rowTop, rowH, c, cell, size, pad);
        cx += c.width;
      });
      cy += rowH;
      this.primitives.push({ kind: 'line', x1: x, y1: cy, x2: x + total, y2: cy, color: DECK_MARK.grid, width: 0.75 });
    }
    return cy;
  }

  private cell(x: number, rowTop: number, rowH: number, c: Col, cell: Cell, size: number, pad: number): void {
    const color = cell.tone === 'mute' ? DECK_INK.mute : DECK_INK.ink;
    const room = c.width - pad;
    // Vertically centred: one line, or (a tall row, a long label) two.
    const base = rowTop + rowH / 2 + size * 0.36;
    const lead = size + 2;
    const maxLines = Math.max(1, Math.floor((rowH - 4) / (size + 1)));
    if (cell.note == null && maxLines > 1 && c.align === 'left' && this.width(cell.text, size, cell.weight) > room) {
      const lines = this.wrap(cell.text, room, size, cell.weight);
      if (lines.length <= maxLines) {
        const first = rowTop + rowH / 2 - ((lines.length - 1) * lead) / 2 + size * 0.36;
        lines.forEach((line, k) => this.text(x, first + k * lead, line, size, { color, weight: cell.weight }));
        return;
      }
    }
    if (cell.note != null) {
      const full = `${cell.text} ${cell.note}`;
      if (this.width(full, 11) <= room) {
        // "—" in ink, the reason after it in the label colour, as one right- or left-aligned run.
        const dashW = this.width(`${cell.text} `, 11);
        const start = c.align === 'right' ? x + c.width - pad - this.width(full, 11) : x;
        this.text(start, base, cell.text, 11, { color: DECK_INK.ink });
        this.text(start + dashW, base, cell.note, 11, { color: DECK_INK.mute });
        return;
      }
      this.footnotes.add(cell.note);
    }
    const t = this.fit(cell.text, room, size, cell.weight);
    this.text(c.align === 'right' ? x + c.width - pad : x, base, t, size, { color, weight: cell.weight, align: c.align });
  }

  /** "— means: …" under the body, for withheld cells too narrow to carry their reason. */
  flushFootnotes(y = BODY_BOTTOM + 4): void {
    if (this.footnotes.size === 0) return;
    // Mid-sentence, so each reason starts in lower case: "— means: no price entered; too few to show."
    const reasons = [...this.footnotes].map((n) => (/^[A-Z][a-z]/.test(n) ? n.charAt(0).toLowerCase() + n.slice(1) : n));
    this.text(M, y, this.fit(`— means: ${reasons.join('; ')}.`, FULL_W, 11), 11, { color: DECK_INK.mute });
  }
}

// ── Cells ──────────────────────────────────────────────────────────────────────────────────────

function figureCell(f: AdoptionFigure, fmt: AdoptionFigureFormatter): Cell {
  if (f.available) return { text: fmt(f) };
  // "Fewer than 3" says itself; every other reason is "—" with a footnote.
  if (f.reason === 'few_people') return { text: ADOPTION_WITHHELD_TEXT.few_people, tone: 'mute' };
  return { text: '—', note: ADOPTION_WITHHELD_TEXT[f.reason] };
}

/** The change column: a significant change in words; otherwise both figures stand, "No clear change". */
function changeCell(c: AdoptionComparison): Cell {
  const words = formatAdoptionChange(c);
  if (words == null) return { text: '—', tone: 'mute' };
  if (!c.significant) return { text: 'No clear change', tone: 'mute' };
  return { text: words };
}

/** A count; null (the fold could not run) is "—", never 0. */
const countCell = (n: number | null): Cell => ({ text: n == null ? '—' : Math.round(n).toLocaleString('en-GB') });
const countText = (n: number | null): string => (n == null ? '—' : n.toLocaleString('en-GB'));

function comparisonRows(cs: readonly AdoptionComparison[], fmt: AdoptionFigureFormatter, sample = false): Cell[][] {
  return cs.map((c) => [
    { text: ADOPTION_COMPARISON_LABEL[c.key] },
    figureCell(c.before, fmt),
    figureCell(c.after, fmt),
    changeCell(c),
    ...(sample ? [countCell(c.after.sampleSize)] : []),
  ]);
}

const pick = (cs: readonly AdoptionComparison[], k: AdoptionComparisonKey): AdoptionComparison | undefined => cs.find((c) => c.key === k);
const avail = (f: AdoptionFigure | undefined): f is AvailableAdoptionFigure => f != null && f.available;

// ── The deck ───────────────────────────────────────────────────────────────────────────────────

/**
 * The whole deck. `commentary` holds each commentary slide's resolved text; a missing slide uses the
 * template wording. Pure: the same inputs give the same pages.
 */
export function buildDeck(
  r: AiAdoptionReport,
  commentary: DeckCommentary,
  options: DeckOptions,
  metrics: DeckTextMetrics,
  fmt: AdoptionFigureFormatter = deckFigureFormatter,
): Deck {
  const pages: PageBuilder[] = [];
  const page = (slide: AdoptionSlideId): PageBuilder => {
    const p = new PageBuilder(slide, metrics);
    pages.push(p);
    return p;
  };
  const say = (slide: AdoptionCommentarySlide): SlideCommentary => commentary[slide] ?? commentaryFromResponse(r, slide, null, fmt);
  const phrase = reportingWindowPhrase(r.window);
  const workspace = r.workspaceName.trim() === '' ? 'Workspace' : r.workspaceName;

  // 1 · Title ──────────────────────────────────────────────────────────────────────────────────
  {
    const p = page('title');
    p.primitives.push({ kind: 'rect', x: 0, y: 0, w: 14, h: DECK_H, fill: DECK_MARK.brand });
    p.text(80, 150, ADOPTION_SLIDE_TITLE.title, 44, { weight: 'semibold' });
    p.text(80, 196, p.fit(workspace, DECK_W - 160, 24, 'semibold'), 24, { weight: 'semibold', color: DECK_INK.mute });
    p.text(80, 256, reportingWindowTitle(r.window), 18, { weight: 'semibold' });
    p.text(80, 282, `This period: ${spanWords(r.after)}`, 14, { color: DECK_INK.mute });
    p.text(80, 304, `Compared with: ${spanWords(r.before)}`, 14, { color: DECK_INK.mute });
    let y = 356;
    const prepared = options.preparedFor?.trim() ?? '';
    if (prepared !== '') {
      p.text(80, y, p.fit(`Prepared for ${prepared}`, DECK_W - 160, 16), 16);
      y += 26;
    }
    p.text(80, y, `Generated ${dateFmt(options.generatedOn)}`, 14, { color: DECK_INK.mute });
    p.text(80, y + 22, `${r.repos.measured} of ${r.repos.total} repos measured`, 14, { color: DECK_INK.mute });
    p.text(80, 490, 'Made with Ensemble', 13, { weight: 'semibold', color: DECK_INK.soft });
  }

  // 2 · Summary ────────────────────────────────────────────────────────────────────────────────
  {
    const p = page('summary');
    p.header(ADOPTION_SLIDE_TITLE.summary, `What changed ${phrase}`);
    const hs = r.summary.headlines;
    if (hs.length === 0) {
      p.paragraph(LEFT.x, LEFT.y + 20, 'There is not enough data in this period for a summary.', LEFT.w, 14, { color: DECK_INK.mute });
    } else {
      p.table(
        LEFT.x,
        LEFT.y,
        [
          { header: 'Measure', width: 204, align: 'left' },
          { header: 'Before', width: 82, align: 'right' },
          { header: 'This period', width: 82, align: 'right' },
          { header: 'Change', width: 128, align: 'right' },
          { header: 'Sample', width: 64, align: 'right' },
        ],
        comparisonRows(hs, fmt, true),
        { rowH: 34, size: 13 },
      );
    }
    p.commentary(say('summary'));
    p.flushFootnotes();
  }

  // 3 · AI adoption ────────────────────────────────────────────────────────────────────────────
  {
    const a = r.adoption;
    const p = page('adoption');
    p.header(ADOPTION_SLIDE_TITLE.adoption, avail(a.aiShare.after) ? `AI was involved in ${fmt(a.aiShare.after)} of merged PRs` : 'AI adoption');
    // The chart's lines: up to four vendors seen this period, most PRs first (vendors, not people).
    const lined = a.vendors
      .filter((v) => avail(v.after) && v.after.value > 0)
      .sort((x, y) => (avail(y.after) ? y.after.value : 0) - (avail(x.after) ? x.after.value : 0) || AI_CODING_VENDORS.indexOf(x.vendor) - AI_CODING_VENDORS.indexOf(y.vendor))
      .slice(0, 4)
      .map((v) => v.vendor);
    // Per-vendor table (PRs before and this period, this period's share): most PRs this period first,
    // so the tool the commentary names is never the one cut off. The chart gives up height (down to
    // 128pt) so up to six tool rows fit under it.
    const vendorRows = [...a.vendors]
      .sort(
        (x, y) =>
          (avail(y.after) ? y.after.value : -1) - (avail(x.after) ? x.after.value : -1) ||
          (avail(y.before) ? y.before.value : -1) - (avail(x.before) ? x.before.value : -1) ||
          AI_CODING_VENDORS.indexOf(x.vendor) - AI_CODING_VENDORS.indexOf(y.vendor),
      )
      .map((v) => [{ text: AI_CODING_VENDOR_LABEL[v.vendor] }, figureCell(v.before, fmt), figureCell(v.after, fmt), figureCell(v.afterShare, fmt)]);
    const VENDOR_ROW_H = 18;
    const layout = (h: number) => {
      const chart = adoptionChart({ x: LEFT.x, y: LEFT.y, w: LEFT.w, h }, a.periods, lined, r.markers, fmt);
      const legend = legendRow(LEFT.x + 36, LEFT.y + h + 18, LEFT.w - 36, chart.legend, (s) => metrics.width(p.printable(s), 11, 'regular'));
      const named = chart.markersShown.slice(0, 2).map((m) => `${m.summary} (${dateFmt(m.at)})`);
      const more = chart.markersShown.length - named.length;
      const markerText = chart.markersShown.length > 0 ? `Dashed lines: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}.` : null;
      const markerLines = markerText == null ? 0 : p.wrap(markerText, LEFT.w - 36, 11).length;
      const tableY = legend.bottom + 4 + (markerText == null ? 0 : 8 + markerLines * 14);
      const room = Math.max(0, Math.floor((BODY_BOTTOM - (tableY + 8) - 18) / VENDOR_ROW_H));
      return { chart, legend, markerText, room };
    };
    const wanted = Math.min(vendorRows.length, 6);
    let lay = layout(200);
    if (lay.room < wanted) lay = layout(Math.max(128, 200 - (wanted - lay.room) * VENDOR_ROW_H));
    p.primitives.push(...lay.chart.primitives, ...lay.legend.primitives);
    let y = lay.legend.bottom + 4;
    if (lay.markerText != null) y = p.paragraph(LEFT.x + 36, y + 8, lay.markerText, LEFT.w - 36, 11, { color: DECK_INK.mute, lead: 14 });
    const rows = vendorRows;
    const room = Math.max(0, Math.floor((BODY_BOTTOM - (y + 8) - 18) / VENDOR_ROW_H));
    if (rows.length > 0 && room > 0) {
      // "And N more tools." needs a line of its own.
      const shown = rows.length <= room ? rows : rows.slice(0, Math.max(1, room - 1));
      const bottom = p.table(
        LEFT.x,
        y + 4,
        [
          { header: 'Tool', width: 200, align: 'left' },
          { header: 'PRs before', width: 110, align: 'right' },
          { header: 'PRs this period', width: 120, align: 'right' },
          { header: 'Share this period', width: 130, align: 'right' },
        ],
        shown,
        { rowH: VENDOR_ROW_H, size: 11 },
      );
      if (shown.length < rows.length) p.text(LEFT.x, bottom + 12, `And ${rows.length - shown.length} more tools.`, 11, { color: DECK_INK.mute });
    }
    let ny = p.commentary(say('adoption')) + 10;
    const d = r.detection;
    ny = p.note(
      ny,
      d.scannedPct == null
        ? 'No merged PRs to scan for AI markers yet.'
        : `Scanned for AI markers: ${Math.round(d.scannedPct)}% of ${d.totalPrs.toLocaleString('en-GB')} merged PRs.${d.complete ? '' : ' AI figures are held back until at least 90% are scanned.'}`,
    );
    const seen = a.sources.filter((s) => s.prs > 0).map((s) => `${AI_SIGNAL_SOURCE_LABEL[s.source]} ${s.prs.toLocaleString('en-GB')}`);
    if (seen.length > 0) ny = p.note(ny + 4, `Where AI use was seen (PRs): ${seen.join(', ')}.`);
    if (a.otherAutomationPrs > 0) p.note(ny + 4, `${a.otherAutomationPrs.toLocaleString('en-GB')} PRs by dependency, release and housekeeping bots are left out.`);
    p.flushFootnotes();
  }

  // 4 · How widely AI is used ─────────────────────────────────────────────────────────────────
  {
    const s = r.people;
    const p = page('people');
    const total = s.peopleWithMergedPrs.toLocaleString('en-GB');
    const u = s.peopleUsingAi.after;
    const headline = avail(u)
      ? `${fmt(u)} of ${total} people merged a PR with AI involved`
      : !u.available && u.reason === 'few_people'
        ? `Fewer than 3 of ${total} people merged a PR with AI involved`
        : ADOPTION_SLIDE_TITLE.people;
    p.header(ADOPTION_SLIDE_TITLE.people, headline);
    // The chart: per period, the share of people who merged a PR with AI involved.
    const CHART_H = 190;
    p.primitives.push(...peopleShareChart({ x: LEFT.x, y: LEFT.y, w: LEFT.w, h: CHART_H }, s.periods, fmt));
    let y = LEFT.y + CHART_H + 6;
    y = p.paragraph(LEFT.x + 36, y, 'Bars: the share of people who merged a PR in the period with AI involved.', LEFT.w - 36, 11, { color: DECK_INK.mute, lead: 14 });
    if (s.withheld != null) {
      p.paragraph(LEFT.x, y + 16, `Per tool: — ${ADOPTION_WITHHELD_TEXT[s.withheld]}. It appears once enough merged PRs have been scanned for AI markers.`, LEFT.w, 12, { color: DECK_INK.mute });
    } else if (s.vendors.length > 0) {
      // Most people first; a withheld count sorts as the smallest.
      const n = (f: AdoptionFigure): number => (f.available ? f.value : f.reason === 'few_people' ? 0.5 : -1);
      const rows: Cell[][] = [...s.vendors]
        .sort((a, b) => n(b.people) - n(a.people) || AI_CODING_VENDORS.indexOf(a.vendor) - AI_CODING_VENDORS.indexOf(b.vendor))
        .map((v) => [{ text: AI_CODING_VENDOR_LABEL[v.vendor] }, figureCell(v.people, fmt), figureCell(v.prShare, fmt)]);
      const ROW_H = 18;
      const room = Math.max(1, Math.floor((BODY_BOTTOM - (y + 12) - 18) / ROW_H));
      const shown = rows.length <= room ? rows : rows.slice(0, Math.max(1, room - 1));
      const bottom = p.table(
        LEFT.x,
        y + 8,
        [
          { header: 'Tool', width: 220, align: 'left' },
          { header: 'People this period', width: 160, align: 'right' },
          { header: 'Share of merged PRs', width: 180, align: 'right' },
        ],
        shown,
        { rowH: ROW_H, size: 11 },
      );
      if (shown.length < rows.length) p.text(LEFT.x, bottom + 12, `And ${rows.length - shown.length} more tools.`, 11, { color: DECK_INK.mute });
    }
    let ny = p.commentary(say('people')) + 10;
    ny = p.note(ny, 'Counts people, never who: the report names nobody. A person counts once, however many PRs they merged.');
    ny = p.note(ny + 4, 'A count of 1 or 2 people shows as "Fewer than 3", so it cannot point at anyone.');
    if (s.agentPrs != null) p.note(ny + 4, `${s.agentPrs.mergedPrs.toLocaleString('en-GB')} PRs were opened by an AI coding agent with no person named; they count towards the tools' PR shares only.`);
    p.flushFootnotes();
  }

  // 5 · Delivery flow ──────────────────────────────────────────────────────────────────────────
  {
    const s = r.delivery;
    const p = page('delivery');
    p.header(ADOPTION_SLIDE_TITLE.delivery, 'Delivery flow, this period against the one before');
    const cols: Col[] = [
      { header: 'Measure', width: 236, align: 'left' },
      { header: 'Before', width: 104, align: 'right' },
      { header: 'This period', width: 104, align: 'right' },
      { header: 'Change', width: 116, align: 'right' },
    ];
    let y = p.table(LEFT.x, LEFT.y, cols, comparisonRows(s.comparisons, fmt), { rowH: 20 });
    if (s.aiVsOther != null) {
      const { ai, other } = s.aiVsOther;
      p.text(LEFT.x, y + 24, 'This period: PRs with AI involved and the rest. A comparison, not a cause.', 12, { weight: 'semibold' });
      y = p.table(
        LEFT.x,
        y + 32,
        [
          { header: 'Measure', width: 236, align: 'left' },
          { header: `With AI (${ai.prs.toLocaleString('en-GB')} PRs)`, width: 162, align: 'right' },
          { header: `Other (${other.prs.toLocaleString('en-GB')} PRs)`, width: 162, align: 'right' },
        ],
        [
          [{ text: 'Median lead time' }, figureCell(ai.leadTimeHours, fmt), figureCell(other.leadTimeHours, fmt)],
          [{ text: 'Median PR size' }, figureCell(ai.prSizeLines, fmt), figureCell(other.prSizeLines, fmt)],
          [{ text: 'CI passing at merge' }, figureCell(ai.ciPassPct, fmt), figureCell(other.ciPassPct, fmt)],
          [{ text: 'Approved by a person' }, figureCell(ai.humanReviewCoveragePct, fmt), figureCell(other.humanReviewCoveragePct, fmt)],
        ],
        { rowH: 20 },
      );
    } else {
      p.paragraph(LEFT.x, y + 24, 'PRs with AI involved are not compared with the rest until enough PRs are scanned for AI markers.', LEFT.w, 12, { color: DECK_INK.mute });
    }
    p.commentary(say('delivery'));
    p.flushFootnotes();
  }

  // 6 · Where the time goes ────────────────────────────────────────────────────────────────────
  {
    const s = r.courts;
    const p = page('courts');
    p.header(ADOPTION_SLIDE_TITLE.courts, 'Where open PRs waited');
    const rev = pick(s.comparisons, 'court_reviewer');
    const aut = pick(s.comparisons, 'court_author');
    const lan = pick(s.comparisons, 'court_landing');
    if (rev != null && aut != null && lan != null) {
      p.primitives.push(
        ...courtBars(
          { x: LEFT.x, y: LEFT.y + 4, w: LEFT.w, h: 130 },
          [
            { label: 'Before', shares: [rev.before, aut.before, lan.before] },
            { label: 'This period', shares: [rev.after, aut.after, lan.after] },
          ],
          fmt,
        ),
      );
      const legend = legendRow(
        LEFT.x + 92,
        LEFT.y + 140,
        LEFT.w - 92,
        [
          { label: 'Waiting on reviewers', color: COURT_COLOR.reviewer, shape: 'bar' },
          { label: 'Waiting on authors', color: COURT_COLOR.author, shape: 'bar' },
          { label: 'Waiting to land', color: COURT_COLOR.landing, shape: 'bar' },
        ],
        (t) => metrics.width(t, 11, 'regular'),
      );
      p.primitives.push(...legend.primitives);
    }
    let y = p.table(
      LEFT.x,
      LEFT.y + 168,
      [
        { header: 'Share of open time', width: 236, align: 'left' },
        { header: 'Before', width: 104, align: 'right' },
        { header: 'This period', width: 104, align: 'right' },
        { header: 'Change', width: 116, align: 'right' },
      ],
      comparisonRows(s.comparisons, fmt),
      { rowH: 20 },
    );
    y = p.paragraph(
      LEFT.x,
      y + 20,
      `PRs measured: ${countText(s.measuredPrs.before)} before, ${countText(s.measuredPrs.after)} this period. Merged PRs a person worked on; PRs written by bots are left out.${
        s.measuredPrs.before == null || s.measuredPrs.after == null ? ' — = could not be measured.' : ''
      }`,
      LEFT.w,
      11,
      { color: DECK_INK.mute, lead: 15 },
    );
    for (const refusal of s.refusals.slice(0, 3)) y = p.paragraph(LEFT.x, y + 2, refusal, LEFT.w, 11, { color: DECK_INK.mute, lead: 15, bottom: BODY_BOTTOM });
    p.commentary(say('courts'));
    p.flushFootnotes();
  }

  // 7 · AI review ──────────────────────────────────────────────────────────────────────────────
  {
    const s = r.reviewBots;
    const p = page('review_bots');
    p.header(ADOPTION_SLIDE_TITLE.review_bots, 'What review bots contributed');
    const seat = (usd: number | null): Cell => (usd == null ? { text: '—', note: ADOPTION_WITHHELD_TEXT.no_price } : figureCell({ available: true, value: usd, unit: 'usd', sampleSize: 1 }, fmt));
    const rows: Cell[][] = s.bots.map((b) => [
      { text: b.label },
      figureCell(b.commentsPerPr, fmt),
      figureCell(b.actedOnPctBefore, fmt),
      figureCell(b.actedOnPct, fmt),
      seat(b.seatPriceMonthlyUsd),
      figureCell(b.costPerActedOnUsd, fmt),
    ]);
    if (s.ensemble != null) {
      const e = s.ensemble;
      rows.push([
        { text: "Ensemble's own findings", weight: 'semibold' },
        figureCell(e.commentsPerPr, fmt),
        figureCell(s.ensembleActedOn.before, fmt),
        figureCell(s.ensembleActedOn.after, fmt),
        { text: '' },
        { text: '' },
      ]);
    }
    let y = LEFT.y;
    if (rows.length === 0) {
      y = p.paragraph(LEFT.x, LEFT.y + 20, 'No review bot commented on PRs merged in this period.', LEFT.w, 14, { color: DECK_INK.mute });
    } else {
      y = p.table(
        LEFT.x,
        LEFT.y,
        [
          { header: 'Review bot', width: 160, align: 'left' },
          { header: 'Comments per PR', width: 76, align: 'right' },
          { header: 'Acted on, before', width: 80, align: 'right' },
          { header: 'Acted on, this period', width: 84, align: 'right' },
          { header: 'Seat price a month, as entered', width: 84, align: 'right' },
          { header: 'Per thread acted on', width: 76, align: 'right' },
        ],
        rows,
        { rowH: 22 },
      );
    }
    p.paragraph(
      LEFT.x,
      y + 20,
      `Comments per PR is over ${s.mergedPrs.toLocaleString('en-GB')} merged PRs. A thread is acted on when it was resolved, likely addressed by a later commit, or a person replied. A share needs at least ${ADOPTION_REPORT_FLOORS.botActedOnThreads} threads.`,
      LEFT.w,
      11,
      { color: DECK_INK.mute, lead: 15 },
    );
    p.commentary(say('review_bots'));
    p.flushFootnotes();
  }

  // 8 · Guardrails ─────────────────────────────────────────────────────────────────────────────
  {
    const s = r.guardrails;
    const p = page('guardrails');
    const cov = pick(s.comparisons, 'human_review_coverage');
    p.header(ADOPTION_SLIDE_TITLE.guardrails, avail(cov?.after) ? `A person approved ${fmt(cov.after)} of merged PRs` : ADOPTION_SLIDE_TITLE.guardrails);
    const rows = s.comparisons.map((c) => {
      const change = formatAdoptionChange(c);
      return { label: ADOPTION_COMPARISON_LABEL[c.key], before: c.before, after: c.after, change: change == null ? null : c.significant ? change : 'No clear change' };
    });
    p.primitives.push(...pairedPctBars({ x: LEFT.x, y: LEFT.y, w: LEFT.w, h: Math.min(320, rows.length * 80) }, rows, fmt));
    const legend = legendRow(
      LEFT.x,
      LEFT.y + Math.min(320, rows.length * 80) + 12,
      LEFT.w,
      [
        { label: 'Before', color: DECK_MARK.before, shape: 'bar' },
        { label: 'This period', color: DECK_MARK.after, shape: 'bar' },
      ],
      (t) => metrics.width(t, 11, 'regular'),
    );
    p.primitives.push(...legend.primitives);
    p.commentary(say('guardrails'));
    p.flushFootnotes();
  }

  // 9 · Cost ───────────────────────────────────────────────────────────────────────────────────
  {
    const s = r.cost;
    const p = page('cost');
    const perPr = pick(s.comparisons, 'ai_cost_per_pr');
    p.header(
      ADOPTION_SLIDE_TITLE.cost,
      !s.aiEnabled ? 'AI is off on this install' : avail(perPr?.after) ? `Ensemble's AI spend: ${fmt(perPr.after)} per merged PR` : ADOPTION_SLIDE_TITLE.cost,
    );
    let y = LEFT.y;
    if (!s.aiEnabled) {
      y = p.paragraph(LEFT.x, y + 14, 'AI is off on this install, so no AI spend is shown.', LEFT.w, 14, { color: DECK_INK.mute });
    } else {
      const rows: Cell[][] = comparisonRows(s.comparisons, fmt).map((row) => row.slice(0, 3));
      rows.push([{ text: 'Ensemble AI runs' }, countCell(s.runs.before), countCell(s.runs.after)]);
      if (s.costUnit == null) rows.push([{ text: 'Tokens' }, countCell(s.tokens.before), countCell(s.tokens.after)]);
      y = p.table(
        LEFT.x,
        y,
        [
          { header: 'Measure', width: 260, align: 'left' },
          { header: 'Before', width: 140, align: 'right' },
          { header: 'This period', width: 160, align: 'right' },
        ],
        rows,
        { rowH: 22 },
      );
      const unitLine =
        s.costUnit === 'week_pct'
          ? "On a subscription, spend is a share of a week's allowance, not money."
          : s.costUnit === 'usd'
            ? 'On an API key, spend is in US dollars as recorded.'
            : 'No cost is known for these runs, so only tokens are shown.';
      y = p.paragraph(LEFT.x, y + 18, unitLine, LEFT.w, 11, { color: DECK_INK.mute, lead: 15 });
      if (s.runs.before == null || s.runs.after == null) {
        y = p.paragraph(LEFT.x, y + 2, 'The AI usage records could not be read for a period shown as —.', LEFT.w, 11, { color: DECK_INK.mute, lead: 15 });
      }
      if (s.machineWideRuns != null && s.machineWideRuns > 0) y = p.paragraph(LEFT.x, y + 2, `${s.machineWideRuns.toLocaleString('en-GB')} runs tied to no repo are left out.`, LEFT.w, 11, { color: DECK_INK.mute, lead: 15 });
    }
    if (s.seats.length > 0) {
      const usd = (v: number): Cell => figureCell({ available: true, value: v, unit: 'usd', sampleSize: 1 }, fmt);
      const rows: Cell[][] = s.seats.map((seat) => [{ text: seat.label }, usd(seat.monthlyUsd)]);
      if (s.seatsMonthlyUsd != null) rows.push([{ text: 'All review bot seats', weight: 'semibold' }, usd(s.seatsMonthlyUsd)]);
      const room = Math.max(1, Math.floor((BODY_BOTTOM - (y + 34)) / 20));
      p.table(
        LEFT.x,
        y + 20,
        [
          { header: 'Review bot seats', width: 300, align: 'left' },
          { header: 'Per month, as entered', width: 160, align: 'right' },
        ],
        rows.slice(0, room),
        { rowH: 20 },
      );
    } else {
      p.paragraph(LEFT.x, y + 20, 'No review bot seat prices entered.', LEFT.w, 11, { color: DECK_INK.mute });
    }
    p.commentary(say('cost'));
    p.flushFootnotes();
  }

  // 10 · Method and limits (continues when long) ──────────────────────────────────────────────
  const aiSlides = Object.values(commentary).filter((c) => c?.source === 'ai').length;
  {
    const d = r.detection;
    const f = ADOPTION_REPORT_FLOORS;
    const blocks: ({ head: string; text?: undefined } | { head?: undefined; text: string })[] = [
      { head: 'What each figure counts' },
      { text: `Merged PRs: pull requests merged in the period, written by a person or by an AI coding agent. PRs by dependency, release and housekeeping bots are left out.` },
      { text: "AI involved: a commit, the PR's title, description, branch or author carries a marker an AI coding tool writes (a bot account, an agent's email, a co-author line, \"Generated with …\"), or Ensemble's AI Fix or Implement story pushed to it." },
      { text: 'Lead time is opened to merged. First human review is opened to the first review by a person. Approved by a person: an approval from a person, not a bot and not Ensemble, before the merge.' },
      { text: 'Where the time goes: each open hour of a merged PR is waiting on its reviewers, its author, or to land.' },
      { head: 'Limits' },
      { text: 'Declared AI use only. Work done with AI that leaves no marker counts as human, so these figures are an undercount.' },
      { text: 'Only the last 100 commits of each PR are read.' },
      { text: 'Before and after is a comparison, not proof of cause.' },
      {
        text: `A figure below its minimum sample is withheld and shown as "—": a share needs ${f.sharePrs} PRs, a change in a share needs ${f.shareChangePts} points, AI figures need ${f.detectionScannedPct}% of PRs scanned, and a review bot's acted-on share needs ${f.botActedOnThreads} threads.`,
      },
      {
        text:
          d.scannedPct == null
            ? 'No merged PRs have been scanned for AI markers yet.'
            : `Scanned for AI markers: ${Math.round(d.scannedPct)}% of ${d.totalPrs.toLocaleString('en-GB')} merged PRs.${d.coversFrom != null ? ` The scan of older PRs reaches back to ${dateFmt(d.coversFrom)}.` : ''}`,
      },
      { text: r.settingHistoryFrom != null ? `Setting changes are recorded from ${dateFmt(r.settingHistoryFrom)}.` : 'No setting changes are recorded.' },
      { text: `${r.repos.measured} of ${r.repos.total} repos measured: those tracked since the start of the earlier period.` },
      {
        text:
          aiSlides > 0
            ? `AI wrote the commentary on ${aiSlides} of ${ADOPTION_COMMENTARY_SLIDES.length} slides, from the figures on each page; it is labelled. Code fills in every number in it.`
            : 'The commentary is standard wording built from the figures on each page.',
      },
      { text: 'Made on this computer. Nothing leaves it unless you send this file.' },
    ];
    let p = page('method');
    p.header(ADOPTION_SLIDE_TITLE.method, 'How these figures are made');
    // The vendor table on the right, on the first page.
    p.text(RIGHT_X - 20, BODY_TOP + 4, 'AI coding tools recognised', 12, { weight: 'semibold' });
    p.table(
      RIGHT_X - 20,
      BODY_TOP + 12,
      [
        { header: 'Tool', width: 100, align: 'left' },
        { header: 'Maker', width: RIGHT_W + 20 - 100, align: 'left' },
      ],
      AI_CODING_VENDORS.map((v) => [{ text: AI_CODING_VENDOR_LABEL[v] }, { text: AI_CODING_VENDOR_MAKER[v], tone: 'mute' as const }]),
      { rowH: 20, size: 11 },
    );
    const colW = LEFT.w - 20;
    let y = BODY_TOP + 4;
    for (const b of blocks) {
      const size = b.head != null ? 13 : 12;
      const weight: DeckWeight = b.head != null ? 'semibold' : 'regular';
      const lines = p.wrap(b.head ?? b.text ?? '', colW, size, weight);
      const need = lines.length * 16 + (b.head != null ? 8 : 4);
      if (y + need > BODY_BOTTOM + 8) {
        p = page('method');
        p.header(ADOPTION_SLIDE_TITLE.method, `${ADOPTION_SLIDE_TITLE.method} (continued)`);
        y = BODY_TOP + 4;
      }
      if (b.head != null) y += y > BODY_TOP + 4 ? 6 : 0;
      for (const line of lines) {
        p.text(LEFT.x, y, line, size, { weight, color: b.head != null ? DECK_INK.ink : DECK_INK.mute });
        y += 16;
      }
      y += b.head != null ? 2 : 4;
    }
  }

  // Footers: the workspace, the deck's name, the page number.
  const total = pages.length;
  pages.forEach((p, i) => {
    if (p.slide === 'title') return;
    p.primitives.push({ kind: 'line', x1: M, y1: 500, x2: DECK_W - M, y2: 500, color: DECK_MARK.grid, width: 0.75 });
    p.text(M, 520, p.fit(`${workspace} · AI adoption report · ${reportingWindowTitle(r.window)}`, FULL_W - 80, 11), 11, { color: DECK_INK.soft });
    p.text(DECK_W - M, 520, `${i + 1} / ${total}`, 11, { color: DECK_INK.soft, align: 'right' });
  });

  return {
    title: `AI adoption report — ${workspace}`,
    pages: pages.map((p) => ({ slide: p.slide, primitives: p.primitives })),
    aiWritten: aiSlides,
    commentarySlides: ADOPTION_COMMENTARY_SLIDES.length,
  };
}

/** `ensemble-ai-adoption-<workspace-slug>-<YYYY-MM-DD>.pdf` (local date). */
export function reportFileName(workspaceName: string, on: Date): string {
  const slug =
    workspaceName
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'workspace';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `ensemble-ai-adoption-${slug}-${on.getFullYear()}-${p2(on.getMonth() + 1)}-${p2(on.getDate())}.pdf`;
}
