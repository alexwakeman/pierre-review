import type { AiCodingVendor } from '@pierre-review/shared';
import { contrastRatio, readableInk } from '../../../lib/ui.js';

// THE DECK'S COLOURS (Reports → Download report). The PDF has a FIXED WHITE GROUND whatever the app's
// colour scheme: it is printed, pasted into slides and forwarded, never themed. So every colour here is
// a fixed hex, and every colour that draws TEXT clears 4.5:1 on white (deckModel.test.ts measures it).
//
// Chart fills are marks, not text: some sit under 3:1 (teal, amber), so every chart also carries value
// labels and a legend in ink.

export const DECK_GROUND = '#ffffff';

/** Text colours. Each ≥ 4.5:1 on DECK_GROUND. */
export const DECK_INK = {
  /** Headlines, body text, figures. */
  ink: '#111827',
  /** Labels, table headers, secondary words. */
  mute: '#4b5563',
  /** Footers and notes (still ≥ 4.5:1). */
  soft: '#5f6672',
  /** The kicker above a headline. */
  accent: '#1d4ed8',
} as const;

/** Non-text marks: rules, gridlines, swatches. */
export const DECK_MARK = {
  rule: '#d1d5db',
  grid: '#e5e7eb',
  band: '#f3f4f6',
  /** The "before" side of a paired bar. */
  before: '#9ca3af',
  /** The "this period" side of a paired bar. */
  after: '#3381e0',
  /** The share of merged PRs with any AI involved (the adoption bars). */
  allAi: '#64748b',
  /** A dated setting change (dashed). */
  marker: '#4b5563',
  /** The title slide's side bar. */
  brand: '#d97757',
} as const;

/** Where an open hour waited (slide 6). */
export const COURT_COLOR = {
  reviewer: '#7a6ae0',
  author: '#c48200',
  landing: '#1aa676',
} as const;

/**
 * THE ONE VENDOR COLOUR MAP of the deck. Where an id overlaps the app's review-bot map
 * (lib/ui.ts BOT_VENDOR_META: codex, copilot, cursor, devin) the hex is the same; Ensemble is its own
 * orange (`pierre`, #d97757). Claude is a darker amber-brown so it never reads as Ensemble.
 */
export const VENDOR_COLOR: Readonly<Record<AiCodingVendor, string>> = {
  claude: '#b45309',
  codex: '#10a37f',
  copilot: '#8957e5',
  cursor: '#334155',
  devin: '#0891b2',
  google: '#2563eb',
  amazon: '#ca8a04',
  windsurf: '#db2777',
  aider: '#65a30d',
  factory: '#be123c',
  amp: '#4338ca',
  ensemble: '#d97757',
};

/** A colour safe to draw TEXT in on the deck's white ground (darkened until it clears 4.5:1). */
export function deckTextColor(hex: string): string {
  return readableInk(hex, DECK_GROUND);
}

/** The measured contrast of a text colour on the deck's ground. */
export function deckContrast(hex: string): number {
  return contrastRatio(hex, DECK_GROUND);
}

/** `#rrggbb` → 0..1 channels (the PDF renderer's colour). */
export function hexChannels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
