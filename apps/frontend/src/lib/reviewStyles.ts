// THE CLAUDE REVIEW TAB'S TYPE SCALE, spelled once. Every section of the tab (Claude's review, CI
// failures, Previous review, Review threads, Findings, Story check, Review chat) draws its items
// with these, and the reference is the FINDINGS card. The user asked for one style after Story
// check set its prose at 12px grey while Findings set Claude's words at the markdown body's 13px.
//
//   section       ReviewSection (title 14px semibold, count pills 11px)
//   item card     REVIEW_ITEM_CARD — a light border, 14px base
//   item title    REVIEW_ITEM_TITLE — 14px semibold, page colour
//   prose         REVIEW_PROSE — Claude's (or a reviewer's) words: 13px / 1.5, page colour, the
//                 same as `.md-body`, so plain-text and markdown prose read alike
//   meta          REVIEW_META — 12px muted: who, where, when, counts
//   chip          REVIEW_CHIP — 11px medium, the caller adds the tone
//   code anchor   REVIEW_ANCHOR (a link into the Changes tab) / REVIEW_ANCHOR_MUTED (plain)
//   sub-heading   REVIEW_SUBHEAD — 12px semibold, a group inside one section ("Not done (2)")
//
// ⚠ 11px is the floor for a label and 12px for a sentence (CLAUDE.md, Product voice); muted
// pairings are measured by test/textContrast.test.ts.
export const REVIEW_ITEM_CARD = 'rounded border border-gray-100 px-3 py-2 text-sm dark:border-gray-800';
export const REVIEW_ITEM_TITLE = 'font-semibold';
export const REVIEW_PROSE = 'whitespace-pre-wrap break-words text-[13px] leading-normal';
export const REVIEW_META = 'text-xs text-gray-500 dark:text-gray-400';
export const REVIEW_CHIP = 'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium';
export const REVIEW_ANCHOR = 'break-all text-left font-mono text-xs text-blue-600 hover:underline dark:text-blue-400';
export const REVIEW_ANCHOR_MUTED = 'break-all font-mono text-xs text-gray-500 dark:text-gray-400';
export const REVIEW_SUBHEAD = 'text-xs font-semibold text-gray-700 dark:text-gray-200';
