// THE AI REVIEW TAB'S TYPE SCALE, spelled once. Every section of the tab (the review, CI
// failures, Previous review, Review threads, Findings, Story check, Review chat) and the story
// view's ticket review draw their items with these, and the reference is the FINDINGS row. The
// redesign (docs/redesign/DESIGN.md) holds them to the four sizes and the --ui-* roles:
//
//   section       ReviewSection — quiet in the AI tabs (a 15px title, no box)
//   item row      REVIEW_ITEM_CARD — one surface-toned row, no border (tone separates it), 13px base
//   item title    REVIEW_ITEM_TITLE — 13px medium, ink
//   prose         REVIEW_PROSE — the model's (or a reviewer's) words: 13px / 1.5, ink, the same as
//                 `.md-body`, so plain-text and markdown prose read alike
//   meta          REVIEW_META — 12px mute: who, where, when, counts
//   chip          REVIEW_CHIP — 12px medium, the caller adds the tone
//   code anchor   REVIEW_ANCHOR (a link into the Changes tab) / REVIEW_ANCHOR_MUTED (plain)
//   sub-heading   REVIEW_SUBHEAD — 12px medium mute, a group inside one section ("Not done (2)")
//
// ⚠ Nothing under 11px (test/designTokens.test.ts); muted pairings are measured by
// test/textContrast.test.ts and the --ui-* inks by designTokens.test.ts.
export const REVIEW_ITEM_CARD = 'rounded-ui bg-ui-surface px-3 py-2.5 text-body text-ui-ink';
// THE ITEM GROUP: a section's list of items (Findings, Previous review, Review threads) reads as ONE
// raised block on the page ground, its items split by a 1px GAP that lets the ground show through —
// a hairline made of spacing, not a border. Inside it every item takes the `raise` tone (square
// corners; the group carries the one radius), and the controls and chips that sit on `raise` step
// up one tone (raise → hover, hover → sel) so they keep their ground. No new colour: the existing
// tone ladder, one step up. Both themes.
export const REVIEW_ITEM_GROUP =
  'flex flex-col gap-px overflow-hidden rounded-ui ' +
  '[&>li]:rounded-none [&>li]:bg-ui-raise ' +
  '[&_.bg-ui-raise]:bg-ui-hover [&_.bg-ui-raise:hover]:bg-ui-sel';
export const REVIEW_ITEM_TITLE = 'font-medium text-ui-ink';
export const REVIEW_PROSE = 'whitespace-pre-wrap break-words text-body leading-normal';
export const REVIEW_META = 'text-meta text-ui-mute';
export const REVIEW_CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-ui px-1.5 py-0.5 text-meta font-medium';
export const REVIEW_ANCHOR = 'break-all text-left font-mono text-meta text-ui-ink hover:underline text-link-phone';
export const REVIEW_ANCHOR_MUTED = 'break-all font-mono text-meta text-ui-mute';
export const REVIEW_SUBHEAD = 'text-meta font-medium text-ui-mute';
