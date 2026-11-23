import type {
  AdoptionFigure,
  AdoptionPeoplePeriod,
  AdoptionPeriod,
  AdoptionSettingMarker,
  AiCodingVendor,
  AvailableAdoptionFigure,
} from '@pierre-review/shared';
import { ADOPTION_WITHHELD_TEXT, AI_CODING_VENDOR_LABEL } from '@pierre-review/shared';
import { niceMax } from '../../charts/common.js';
import { COURT_COLOR, DECK_INK, DECK_MARK, VENDOR_COLOR } from './deckColors.js';
import type { DeckPrimitive } from './deckModel.js';

// THE DECK'S CHART GEOMETRY (Reports → Download report). Pure: figures in, positioned primitives out,
// on the deck's 960 × 540 pt canvas (origin top-left, y down). The renderer draws them as vector
// shapes and real text, never an image.
//
// ⚠ Every chart carries value labels in ink and a legend: some fills sit under 3:1 on white.
// ⚠ A withheld figure is drawn "—" with its reason, never as a zero-height bar.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LegendEntry {
  label: string;
  color: string;
  shape: 'bar' | 'line' | 'dash';
}

const LABEL = 11;

function text(x: number, y: number, s: string, o: Partial<Extract<DeckPrimitive, { kind: 'text' }>> = {}): DeckPrimitive {
  return { kind: 'text', x, y, text: s, size: o.size ?? LABEL, weight: o.weight ?? 'regular', color: o.color ?? DECK_INK.mute, align: o.align ?? 'left' };
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The x of a moment on a run of equal slots (each period one slot), or null when outside. */
export function markerX(at: string, periods: readonly AdoptionPeriod[], x0: number, slotW: number): number | null {
  const t = Date.parse(at);
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    const from = Date.parse(p.from);
    const to = Date.parse(p.to);
    if (t >= from && t < to) return x0 + slotW * (i + (to > from ? (t - from) / (to - from) : 0));
  }
  return null;
}

/** The share of a period's merged PRs that involved one vendor, when the period's share is shown. */
export function vendorShare(p: AdoptionPeriod, v: AiCodingVendor): number | null {
  if (!p.share.available || p.mergedPrs <= 0) return null;
  return ((p.byVendor[v] ?? 0) / p.mergedPrs) * 100;
}

/**
 * Slide 3: one bar per period for the share of merged PRs with any AI involved (value label above;
 * "—" for a withheld period), a line per vendor, and a dashed line at each setting change.
 */
export function adoptionChart(
  box: Box,
  periods: readonly AdoptionPeriod[],
  vendors: readonly AiCodingVendor[],
  markers: readonly AdoptionSettingMarker[],
  fmt: (f: AvailableAdoptionFigure) => string,
): { primitives: DeckPrimitive[]; legend: LegendEntry[]; markersShown: AdoptionSettingMarker[] } {
  const out: DeckPrimitive[] = [];
  const axisW = 36;
  const top = box.y + 16;
  const bottom = box.y + box.h - 30;
  const plotH = bottom - top;
  const x0 = box.x + axisW;
  const plotW = box.w - axisW;
  const n = Math.max(1, periods.length);
  const slotW = plotW / n;
  let peak = 0;
  for (const p of periods) {
    if (p.share.available) peak = Math.max(peak, p.share.value);
    for (const v of vendors) peak = Math.max(peak, vendorShare(p, v) ?? 0);
  }
  const yMax = Math.min(100, Math.max(10, niceMax(peak)));
  const yOf = (v: number): number => bottom - (Math.max(0, Math.min(v, yMax)) / yMax) * plotH;

  for (const tick of [0, yMax / 2, yMax]) {
    const y = yOf(tick);
    out.push({ kind: 'line', x1: x0, y1: y, x2: box.x + box.w, y2: y, color: tick === 0 ? DECK_MARK.rule : DECK_MARK.grid, width: tick === 0 ? 1 : 0.75 });
    out.push(text(x0 - 6, y + 4, `${Math.round(tick)}%`, { align: 'right' }));
  }

  const barW = Math.min(30, slotW * 0.5);
  const every = n > 8 ? 2 : 1;
  periods.forEach((p, i) => {
    const cx = x0 + slotW * (i + 0.5);
    if (p.share.available) {
      const y = yOf(p.share.value);
      out.push({ kind: 'rect', x: cx - barW / 2, y, w: barW, h: Math.max(0.5, bottom - y), fill: DECK_MARK.allAi });
      out.push(text(cx, y - 4, fmt(p.share), { align: 'center', color: DECK_INK.ink }));
    } else {
      out.push(text(cx, bottom - 4, '—', { align: 'center', color: DECK_INK.mute, size: 12 }));
    }
    if (i % every === 0 || i === n - 1) {
      out.push(text(cx, bottom + 14, shortDate(p.from), { align: 'center' }));
      if (p.partial) out.push(text(cx, bottom + 26, 'so far', { align: 'center' }));
    }
  });

  for (const v of vendors) {
    let d = '';
    let pen = false;
    periods.forEach((p, i) => {
      const s = vendorShare(p, v);
      if (s == null) {
        pen = false;
        return;
      }
      const x = x0 + slotW * (i + 0.5);
      const y = yOf(s);
      d += `${pen ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)} `;
      pen = true;
      out.push({ kind: 'circle', cx: x, cy: y, r: 2.5, fill: VENDOR_COLOR[v] });
    });
    if (d !== '') out.push({ kind: 'path', d: d.trim(), stroke: VENDOR_COLOR[v], width: 2 });
  }

  const shown: AdoptionSettingMarker[] = [];
  for (const m of markers) {
    const x = markerX(m.at, periods, x0, slotW);
    if (x == null) continue;
    shown.push(m);
    out.push({ kind: 'line', x1: x, y1: top - 6, x2: x, y2: bottom, color: DECK_MARK.marker, width: 1, dash: [3, 3] });
  }

  const legend: LegendEntry[] = [
    { label: 'Any AI tool', color: DECK_MARK.allAi, shape: 'bar' },
    ...vendors.map((v) => ({ label: AI_CODING_VENDOR_LABEL[v], color: VENDOR_COLOR[v], shape: 'line' as const })),
  ];
  if (shown.length > 0) legend.push({ label: 'A setting changed', color: DECK_MARK.marker, shape: 'dash' });
  return { primitives: out, legend, markersShown: shown };
}

/**
 * Slide 4: one bar per period for the share of people who merged a PR with AI involved. A withheld
 * period ("fewer than 3" people, or not scanned yet) is drawn "—", never a zero-height bar.
 */
export function peopleShareChart(box: Box, periods: readonly AdoptionPeoplePeriod[], fmt: (f: AvailableAdoptionFigure) => string): DeckPrimitive[] {
  const out: DeckPrimitive[] = [];
  const axisW = 36;
  const top = box.y + 16;
  const bottom = box.y + box.h - 30;
  const plotH = bottom - top;
  const x0 = box.x + axisW;
  const n = Math.max(1, periods.length);
  const slotW = (box.w - axisW) / n;
  const yOf = (v: number): number => bottom - (Math.max(0, Math.min(v, 100)) / 100) * plotH;
  for (const tick of [0, 50, 100]) {
    const y = yOf(tick);
    out.push({ kind: 'line', x1: x0, y1: y, x2: box.x + box.w, y2: y, color: tick === 0 ? DECK_MARK.rule : DECK_MARK.grid, width: tick === 0 ? 1 : 0.75 });
    out.push(text(x0 - 6, y + 4, `${tick}%`, { align: 'right' }));
  }
  const barW = Math.min(30, slotW * 0.5);
  const every = n > 8 ? 2 : 1;
  periods.forEach((p, i) => {
    const cx = x0 + slotW * (i + 0.5);
    if (p.share.available) {
      const y = yOf(p.share.value);
      out.push({ kind: 'rect', x: cx - barW / 2, y, w: barW, h: Math.max(0.5, bottom - y), fill: DECK_MARK.allAi });
      out.push(text(cx, y - 4, fmt(p.share), { align: 'center', color: DECK_INK.ink }));
    } else {
      out.push(text(cx, bottom - 4, '—', { align: 'center', color: DECK_INK.mute, size: 12 }));
    }
    if (i % every === 0 || i === n - 1) {
      out.push(text(cx, bottom + 14, shortDate(p.from), { align: 'center' }));
      if (p.partial) out.push(text(cx, bottom + 26, 'so far', { align: 'center' }));
    }
  });
  return out;
}

/** A legend laid out left to right, wrapping inside `w`. Returns the primitives and the bottom y. */
export function legendRow(
  x: number,
  y: number,
  w: number,
  entries: readonly LegendEntry[],
  width: (s: string) => number,
): { primitives: DeckPrimitive[]; bottom: number } {
  const out: DeckPrimitive[] = [];
  let cx = x;
  let cy = y;
  for (const e of entries) {
    const need = 18 + width(e.label) + 16;
    if (cx > x && cx + need > x + w) {
      cx = x;
      cy += 16;
    }
    if (e.shape === 'bar') out.push({ kind: 'rect', x: cx, y: cy - 8, w: 12, h: 9, fill: e.color });
    else out.push({ kind: 'line', x1: cx, y1: cy - 4, x2: cx + 12, y2: cy - 4, color: e.color, width: 2, dash: e.shape === 'dash' ? [3, 2] : undefined });
    out.push(text(cx + 18, cy, e.label, { color: DECK_INK.ink }));
    cx += need;
  }
  return { primitives: out, bottom: cy + 6 };
}

/** One labelled pair of horizontal bars (before, this period) on a 0–100 scale. */
export function pairedPctBars(
  box: Box,
  rows: readonly { label: string; before: AdoptionFigure; after: AdoptionFigure; change: string | null }[],
  fmt: (f: AvailableAdoptionFigure) => string,
): DeckPrimitive[] {
  const out: DeckPrimitive[] = [];
  const rowH = box.h / Math.max(1, rows.length);
  const labelW = 92;
  const barMax = box.w - labelW - 70;
  rows.forEach((r, i) => {
    const y = box.y + i * rowH;
    out.push(text(box.x, y + 13, r.label, { size: 12, weight: 'semibold', color: DECK_INK.ink }));
    if (r.change != null) out.push(text(box.x + box.w, y + 13, r.change, { size: 12, align: 'right', color: DECK_INK.ink }));
    (
      [
        ['Before', r.before, DECK_MARK.before],
        ['This period', r.after, DECK_MARK.after],
      ] as const
    ).forEach(([side, f, color], k) => {
      const by = y + 22 + k * 17;
      out.push(text(box.x, by + 10, side));
      if (f.available) {
        const w = Math.max(1, (Math.max(0, Math.min(100, f.value)) / 100) * barMax);
        out.push({ kind: 'rect', x: box.x + labelW, y: by, w: barMax, h: 12, fill: DECK_MARK.band });
        out.push({ kind: 'rect', x: box.x + labelW, y: by, w, h: 12, fill: color });
        out.push(text(box.x + labelW + barMax + 6, by + 10, fmt(f), { color: DECK_INK.ink }));
      } else {
        out.push(text(box.x + labelW, by + 10, `— ${ADOPTION_WITHHELD_TEXT[f.reason]}`, { color: DECK_INK.mute }));
      }
    });
  });
  return out;
}

/** Slide 6: one stacked bar per side, split reviewer / author / landing, labels under each segment. */
export function courtBars(
  box: Box,
  sides: readonly { label: string; shares: readonly [AdoptionFigure, AdoptionFigure, AdoptionFigure] }[],
  fmt: (f: AvailableAdoptionFigure) => string,
): DeckPrimitive[] {
  const out: DeckPrimitive[] = [];
  const labelW = 92;
  const barW = box.w - labelW;
  const colors = [COURT_COLOR.reviewer, COURT_COLOR.author, COURT_COLOR.landing];
  sides.forEach((s, i) => {
    const y = box.y + i * 62;
    out.push(text(box.x, y + 17, s.label, { size: 12, weight: 'semibold', color: DECK_INK.ink }));
    const missing = s.shares.find((f): f is Extract<AdoptionFigure, { available: false }> => !f.available);
    if (missing != null) {
      out.push(text(box.x + labelW, y + 17, `— ${ADOPTION_WITHHELD_TEXT[missing.reason]}`, { size: 12 }));
      return;
    }
    const vals = s.shares.map((f) => (f.available ? Math.max(0, f.value) : 0));
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    let cx = box.x + labelW;
    vals.forEach((v, k) => {
      const w = (v / sum) * barW;
      if (w > 0) out.push({ kind: 'rect', x: cx, y, w, h: 24, fill: colors[k]! });
      const f = s.shares[k]!;
      if (f.available && w >= 34) out.push(text(cx + w / 2, y + 40, fmt(f), { align: 'center', color: DECK_INK.ink }));
      cx += w;
    });
  });
  return out;
}
