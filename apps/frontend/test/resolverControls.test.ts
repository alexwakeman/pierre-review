import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ── THE RESOLVER'S CONTROLS, PINNED FROM SOURCE ──────────────────────────────────────────────
//
// ⚠ HAND-RUN, like every test under `apps/frontend/test`:
//     ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
//
// "Take this side" used to exist TWICE on every region: a named button at the head of the strip,
// and a hover-revealed `aria-hidden` arrow in each gutter that duplicated it for mouse speed. The
// strip has given the verb up, so the arrow is now the only pointer route to it — and a control
// that is the only route has obligations a decorative twin never had. Every one of those
// obligations is a single attribute somebody could drop without breaking a render, a type or a
// fold, which is why they are assertions rather than comments.
//
// ⚠ THIS IS A SOURCE SCAN, NOT A RENDER. `apps/frontend` has no DOM test setup (see
// `resolverTokens.test.ts`, which measures `index.css` the same way). A scan cannot prove the
// arrow is clickable; it can prove the four attributes that make it reachable are still written
// down, which is the regression that would otherwise ship silently.

const read = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');

const SLOT_ROW = read('../src/components/conflicts/SlotRow.tsx');
const SLOT_STRIP = read('../src/components/conflicts/SlotStrip.tsx');
const PANES = read('../src/components/conflicts/ResolverPanes.tsx');
const COPY = read('../src/components/conflicts/copy.ts');

/** The gutter arrow's `<button>`, from `SlotRow`'s `gutter` helper. */
function gutterButton(): string {
  const at = SLOT_ROW.indexOf('const gutter =');
  expect(at, 'SlotRow must still build its gutter in one place').toBeGreaterThan(-1);
  const open = SLOT_ROW.indexOf('<button', at);
  const close = SLOT_ROW.indexOf('</button>', open);
  expect(open, 'the gutter must still render a real <button>').toBeGreaterThan(-1);
  return SLOT_ROW.slice(open, close);
}

/**
 * The JSX condition guarding the arrow — `const gutter =` up to the `<button` it returns.
 *
 * ⚠ DELIBERATELY NOT `gutterButton()` AND NOT THE WHOLE FILE. The gate lives OUTSIDE the element,
 * so the element scan cannot see it; and the comment block above the gate explains the rule in
 * prose that names the same helpers. This slice is still prose-bearing, so every assertion over it
 * matches the CALL (`sideOutcome(slot, side)`), never the bare identifier — see `gutterClasses`.
 */
function gutterGate(): string {
  const at = SLOT_ROW.indexOf('const gutter =');
  expect(at, 'SlotRow must still build its gutter in one place').toBeGreaterThan(-1);
  const open = SLOT_ROW.indexOf('<button', at);
  expect(open, 'the gutter must still render a real <button>').toBeGreaterThan(-1);
  return SLOT_ROW.slice(at, open);
}

/**
 * The arrow's class string ALONE.
 *
 * ⚠ THE ATTRIBUTES ARE INTERLEAVED WITH COMMENTS EXPLAINING THEM, AND A SCAN CANNOT TELL THE TWO
 * APART. A first cut of the "never decorative" assertion below matched the word in the comment
 * that says it must never be decorative, and passed a genuinely decorative button. The same shape
 * failed `textContrast.test.ts` on a comment quoting a utility name. Anything asserting about what
 * the button LOOKS like reads this, not the whole element.
 */
function gutterClasses(): string {
  const m = /className="([^"]*)"/.exec(gutterButton());
  expect(m, 'the gutter arrow must carry a plain className string').not.toBeNull();
  return m![1]!;
}

describe('the gutter arrow is a real control', () => {
  it('is not hidden from assistive technology', () => {
    // ⚠ IT CARRIED `aria-hidden` ON PURPOSE while the strip announced the same verb. With the
    // strip's copy gone, `aria-hidden` here would delete "take this side" from the accessibility
    // tree entirely — the verb would exist for a pointer and for the `←`/`→` keys and for nobody
    // else.
    expect(gutterButton(), 'the gutter arrow must not be aria-hidden').not.toMatch(/aria-hidden/);
  });

  it('carries a real accessible name that says WHICH change it belongs to', () => {
    // The arrows sit in their own grid cells, two columns away from the strip's `role="group"`,
    // so the group's "Conflict 2 of 5 in src/…" does not reach them. `gutterLabel` glues the two
    // together; without it a screen reader meets several hundred buttons all called "Take your
    // version" with nothing saying which region is which.
    expect(gutterButton()).toMatch(/aria-label=\{gutterLabel\(/);
    expect(COPY, 'gutterLabel folds in the ONE position spelling').toMatch(
      /gutterLabel[\s\S]{0,600}regionGroupLabel\(/,
    );
  });

  it('disappears once this side’s lines are in the result — INCLUDING via a both-order', () => {
    // ⚠ AN ARROW IS AN OFFER TO ADD SOMETHING. On a side already in the result it offers a no-op
    // and re-sends a decision that is already stored, so it goes. The question is "are THIS SIDE'S
    // lines in the result?", never "is this button's own decision the current one?" —
    // `both_ours_first`, `both_theirs_first`, the wand's merge and an accepted suggestion all put
    // BOTH sides in, and the narrower reading (`slot.kind === 'left'`) would leave a live "add"
    // arrow on a side that had plainly landed.
    expect(gutterGate(), 'the arrow must be gated on the side’s outcome').toMatch(
      /sideOutcome\(slot, side\) !== 'contributed'/,
    );
  });

  it('carries no aria-pressed, because presence IS the state', () => {
    // ⚠ IT USED TO, READING `sideOutcome(slot, side) === 'contributed'` — which is now precisely
    // the condition under which the button does not render. Left in place it could only ever have
    // announced "not pressed", on every arrow, forever. A dead ARIA attribute is worse than none:
    // it reads as a considered claim. The strip's state word still says the state in words.
    expect(gutterButton(), 'a pressed state that can never be true is noise').not.toMatch(
      /aria-pressed/,
    );
  });

  it('comes back when the decision is cleared, with no re-reveal machinery', () => {
    // ⚠ THE ARROW IS DERIVED FROM `slot`, NOT TOGGLED. Undo and Ignore both clear or change the
    // stored decision, `slotFor` re-reads it and the gate re-evaluates — so "and it re-reveals the
    // arrows" needs no state, no effect and no animation. Anything here that remembered whether an
    // arrow had been hidden would be a second source of truth for a fact the store already holds.
    expect(gutterGate(), 'the gate reads the slot directly').toMatch(/sideOutcome\(slot, side\)/);
    expect(SLOT_ROW, 'no local state may shadow the stored decision').not.toMatch(
      /useState[^\n]*(hidden|revealed|arrow)/i,
    );
    // The way back out has to exist on the strip, since both arrows can be gone at once.
    expect(SLOT_STRIP, 'the strip keeps Undo').toMatch(/'undo'/);
    expect(SLOT_STRIP, 'the strip keeps Ignore').toMatch(/'ignore'/);
  });

  it('announces the decision it just took', () => {
    // ⚠ EVERY BUTTON ON THIS SCREEN GOES THROUGH ONE `onDecide` AND IT USED TO WRITE NOTHING.
    // `decideActive` (the `←`/`→` path) sets the live region; the row's callback did not — so
    // pressing Space on an icon-only arrow changed the wash and the strip's word, neither of which
    // a screen reader receives, and said nothing at all. The two paths must both speak.
    expect(PANES, 'the row’s onDecide writes the live region too').toMatch(
      /onDecide=\{\(d\) =>[\s\S]{0,900}setAnnouncement\(/,
    );
  });

  it('is in the ROVING tab order, not out of it and not unconditionally in it', () => {
    // ⚠ BOTH FAILURE MODES ARE REAL AND BOTH ARE ONE CHARACTER AWAY. `tabIndex={-1}` (what the
    // decorative twin carried) leaves the arrows unreachable by keyboard now that the strip's
    // copies are gone. `tabIndex={0}` puts EVERY region's two arrows in the tab order — four
    // hundred regions is eight hundred extra stops before the toolbar, which is the exact thing
    // `SlotStrip`'s `const tab = active ? 0 : -1` exists to prevent. The arrows must read the
    // same `active` prop the strip does.
    expect(gutterButton(), 'the gutter arrow must share the strip’s roving scheme').toMatch(
      /tabIndex=\{active \? 0 : -1\}/,
    );
    expect(SLOT_STRIP, 'the strip’s half of the same scheme').toMatch(
      /const tab = active \? 0 : -1/,
    );
  });

  it('is always drawn, never revealed by a pointer', () => {
    const cls = gutterClasses();
    expect(cls, 'no opacity fade').not.toMatch(/opacity-0/);
    expect(cls, 'no hover-gated visibility').not.toMatch(/group-hover|group-focus/);
    // The `group` class existed for `group-hover:opacity-100` and nothing else.
    expect(SLOT_ROW, 'a group hook that styles nothing is worse than none').not.toMatch(
      /className="group /,
    );
  });

  it('renders exactly where the wash does, through the ONE predicate', () => {
    // ⚠ NOT a second `region.allowed.includes('ours')` written out here. `sideOffered` is the one
    // spelling of the test, and `panePaint` calls it too — so a pane can never be painted as a
    // choice it offers no arrow for, or offer an arrow it is not painted for.
    expect(SLOT_ROW).toMatch(/sideOffered\(region, side\)/);
    expect(SLOT_ROW, 'no second copy of the allowed test in the row').not.toMatch(
      /region\.allowed\.includes/,
    );
  });

  it('is legible at rest, without taking the decorative opt-out', () => {
    // ⚠ C6: DIM, NOT INVISIBLE, AND NOT EXEMPT. `textContrast.test.ts` measures only the MUTED
    // PAIRING idiom (a 300-or-lighter shade set with a 600-or-darker one), which this is not, so
    // it would pass this button without looking at it. Measured here instead, because "it must
    // clear contrast at rest" is the whole of C6 and an arrow nobody can see is the defect the
    // hover reveal already was.
    const cls = gutterClasses();
    expect(cls, 'resting light shade').toMatch(/(?:^|\s)text-gray-500(?:\s|$)/);
    expect(cls, 'resting dark shade').toMatch(/(?:^|\s)dark:text-gray-400(?:\s|$)/);
    expect(cls, 'never decorative — it is the only route to the verb').not.toMatch(
      /decorative-mark/,
    );
    // gray-500 on white, gray-400 on gray-950. WCAG 1.4.11 asks 3:1 of a non-text control; against
    // the BARE PAGE both clear AA's 4.5 as well.
    expect(ratio('#6b7280', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#9ca3af', '#030712')).toBeGreaterThanOrEqual(4.5);
    // ⚠ AND THE PAGE IS NOT THE ONLY GROUND IT SITS ON. Once a side is taken, `RegionRibbons`
    // paints `.mr-fill-applied` across the whole 1.75rem gutter track — which IS this button's
    // cell — so late in a resolve the majority of arrows are on a green tint, not on white. 4.5
    // does not survive that and does not need to (1.4.11's floor for a non-text control is 3:1),
    // but the floor has to be measured against the ground the control actually has, or an alpha
    // bump on the ribbon takes the arrow under it with both suites green. `resolverTokens.test.ts`
    // floors the ribbon's alpha and never caps it, which is exactly the gap.
    for (const [name, fg, bg] of [
      ['light', '#6b7280', '#ffffff'],
      ['dark', '#9ca3af', '#030712'],
    ] as const) {
      const tinted = over(appliedInk(name), ribbonAlpha(), hexToRgb(bg));
      expect(ratio(fg, rgbToHex(tinted)), `${name} arrow over the ribbon`).toBeGreaterThanOrEqual(3);
    }
    // And it brightens on BOTH pointer and keyboard. A hover-only brightening leaves the focused
    // arrow looking exactly like the two hundred resting ones around it.
    expect(cls).toMatch(/hover:text-gray-900/);
    expect(cls).toMatch(/focus-visible:/);
  });

  it('has a focus ring a keyboard reader can actually see', () => {
    // ⚠ `toMatch(/focus-visible:/)` ALONE CANNOT FAIL ON AN INVISIBLE INDICATOR — it passes on any
    // `focus-visible:` utility at all, including one that paints nothing. The shipped ring is the
    // only thing marking which of several hundred arrows the reader is standing on, so it is named
    // AND measured. Light mode shipped on sky-400, which is 2.1:1 on white — below 1.4.11's 3:1,
    // i.e. a focus indicator that is not an indicator. It is sky-600 there now, and the lighter
    // shade is kept for the dark page where it is the legible one.
    const cls = gutterClasses();
    expect(cls, 'a named ring, not a bare focus-visible:').toMatch(
      /focus-visible:ring-1(?:\s|$)/,
    );
    expect(cls).toMatch(/focus-visible:ring-sky-600/);
    expect(cls).toMatch(/dark:focus-visible:ring-sky-400/);
    expect(ratio('#0284c7', '#ffffff'), 'light ring on the page').toBeGreaterThanOrEqual(3);
    expect(ratio('#38bdf8', '#030712'), 'dark ring on the page').toBeGreaterThanOrEqual(3);
  });

  it('never points at a pane the wash left invisible', () => {
    // ⚠ PAINT SITS ON THE CONTENT BOX, AND A SIDE WHOSE ANSWER IS "DELETE THESE LINES" HAS NO
    // CONTENT. `region.ours === []` makes that box 0px high, so the wash paints nothing however it
    // is classed — while `sideOffered` is true and the arrow renders over it. That was invisible
    // until a pane's paint came to MEAN "there is something here to take": a delete/modify conflict
    // then shows a bare left pane beside a red right one and reads as one-sided while it is
    // contested. `CodeCell` gives a painted zero-row cell one line of height instead — the same
    // concession `RegionRibbons`' `MIN_EDGE` makes for a side that contributed a decision and no
    // lines.
    const CELL = read('../src/components/conflicts/CodeCell.tsx');
    expect(CELL, 'a painted cell with no rows still has a box').toMatch(
      /rows\.length === 0 && paint != null && paint !== ''/,
    );
    expect(CELL).toMatch(/emptyButPainted \? 'h-\[18px\]' : ''/);
  });

  it('changes no box, so the three panes still line up', () => {
    // ⚠ ONE SCROLLER, ONE GRID, FIVE TRACKS. The gutter track is `1.75rem` in the grid template
    // and the arrow was ALREADY occupying its cell (`opacity-0` hides paint, not layout), so
    // making it visible moved nothing. What WOULD move something is a focus treatment that is laid
    // out: an `outline` is not, and Tailwind's `ring` is a box-shadow, but a `border-*` or a
    // `p-*` bump on focus would change the cell and drift the panes apart.
    const cls = gutterClasses();
    expect(cls, 'no focus-time padding change').not.toMatch(/focus(-visible)?:p-/);
    expect(cls, 'no focus-time border — that one IS laid out').not.toMatch(
      /focus(-visible)?:border-\d/,
    );
    expect(PANES, 'the gutter tracks are still 1.75rem').toMatch(
      /minmax\(0,1fr\) 1\.75rem minmax\(0,1fr\) 1\.75rem minmax\(0,1fr\)/,
    );
  });
});

describe('the strip keeps every verb that is not about one side', () => {
  it('offers the two side takes ONLY when there is no gutter to put them in', () => {
    // ⚠ BELOW `NARROW_PX` THE GUTTER CELLS ARE NOT EMITTED AT ALL. Removing the strip's copies
    // unconditionally would leave a stacked reader with no pointer route to "take this side" —
    // `←`/`→` only, on a layout that appears when the window is small, which is where a pointer is
    // most likely to be all somebody has.
    expect(SLOT_STRIP).toMatch(/sideTakes &&\s*\n?\s*allows\('ours'\)/);
    expect(SLOT_STRIP).toMatch(/sideTakes &&\s*\n?\s*allows\('theirs'\)/);
    expect(SLOT_ROW, 'and stacked is the only layout that asks for them').toMatch(
      /sideTakes=\{narrow\}/,
    );
  });

  it('still carries the state word, which is now the only thing separating two states', () => {
    // ⚠ `ignored` AND `unapplied` RENDER BYTE-IDENTICAL CENTRE TEXT and paint nothing on either
    // side. The centre's 2px rule still differs by ink, and this word still differs outright —
    // there is nothing else left, so it may not follow the side verbs off the strip.
    expect(SLOT_STRIP).toMatch(/stateWord\(region, slot\)/);
  });

  it('keeps both orders, the swap, ignore and undo', () => {
    for (const key of ["'both'", "'swap'", "'ignore'", "'undo'"]) {
      expect(SLOT_STRIP, `the strip still offers ${key}`).toMatch(key);
    }
  });
});

describe('the keys that decide a side', () => {
  it('still reach the decision directly, not through anything that was removed', () => {
    // `←`/`→` call `decideActive`, which writes the store. They never went near the strip's
    // buttons, so C2 could not have broken them — asserted so that a future tidy-up of the gutter
    // cannot quietly make them the only route, or take them away as "duplicates" of the arrows.
    expect(PANES).toMatch(/case 'ArrowLeft':[\s\S]{0,120}decideActive\('ours'\)/);
    expect(PANES).toMatch(/case 'ArrowRight':[\s\S]{0,120}decideActive\('theirs'\)/);
  });

  it('does not swallow Enter from the control the reader is standing on', () => {
    // ⚠ A `<button>` FIRES ITS CLICK ON ENTER **DOWN**, so the container's `case 'Enter':
    // e.preventDefault(); onLand();` cancelled the press of whatever was focused. That was
    // harmless while every focusable thing in here was a strip button nobody tabbed to; it became a
    // live defect when the gutter arrow got a tab stop and became the only pointer route to "take
    // this side" — Tab, Enter, and the reader is on the commit step with no side taken and nothing
    // saying so, while Space works. `Enter` still lands the commit from the scroller itself.
    expect(PANES, 'Enter is exempt on a real control').toMatch(
      /e\.key === 'Enter'[\s\S]{0,200}closest\('button, a\[href\], \[role="button"\]'\)/,
    );
  });

  it('reveals the affirmative take, never "Ignore"', () => {
    // ⚠ THE REVEAL USED TO FOCUS `el.querySelector('button')` INSIDE `[data-mr-region]` — the
    // STRIP. That was "Take your version" while the strip led with it; with the side verbs moved to
    // the gutter, the strip's first button on every one-sided change is "Ignore this change and
    // keep the ancestor". Walking a file with `n` parked focus on Ignore, one reflex Space from
    // discarding a change — and nothing about the move said so, because no test named which control
    // the reveal lands on.
    expect(gutterButton(), 'the arrow has to be addressable').toMatch(/data-mr-take=\{/);
    expect(PANES, 'left before right, falling back to the strip').toMatch(
      /data-mr-take="\$\{activeIndex\}:\$\{activeRegionId\}:left"[\s\S]{0,400}data-mr-take="\$\{activeIndex\}:\$\{activeRegionId\}:right"/,
    );
    expect(PANES).toMatch(/\(take \?\? el\.querySelector<HTMLElement>\('button'\)\)\?\.focus\(\)/);
  });
});

// ── THE GROUND THE ARROW ACTUALLY SITS ON ────────────────────────────────────────────────────
//
// The gutter track is also the ribbon's x-span, so a decided region's arrow is on a green tint
// rather than on the page. These four helpers composite that tint from `index.css` itself — the
// same rule `resolverTokens.test.ts` follows, and for the same reason: measure what the page
// paints, not what somebody remembered writing.

const CSS = read('../src/index.css');
type RGB = [number, number, number];

/** `--mr-applied`'s channels, from the theme block that actually declares them. */
function appliedInk(theme: 'light' | 'dark'): RGB {
  const selector = theme === 'light' ? ':root' : '\\.dark';
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of CSS.matchAll(re)) {
    const hit = /--mr-applied\s*:\s*([^;]+);/.exec(m[1]!);
    if (hit != null) return hit[1]!.trim().split(/\s+/).map(Number) as RGB;
  }
  throw new Error(`no ${theme} --mr-applied in index.css`);
}

/** The alpha the ribbon paints at, off its own rule. ⚠ ONE RULE — every ribbon is applied green. */
function ribbonAlpha(): number {
  const m = /\.mr-fill-applied\s*\{[^}]*fill:\s*rgb\(var\(--mr-applied\)\s*\/\s*([\d.]+)\)/.exec(CSS);
  if (m == null) throw new Error('no .mr-fill-applied rule in index.css');
  return Number(m[1]);
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}
function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as RGB;
}

/** WCAG 2.x relative contrast. Same four lines as `resolverTokens.test.ts` and
 *  `textContrast.test.ts`; restated rather than imported, because importing a test from a test
 *  couples two hand-run suites. */
function ratio(fg: string, bg: string): number {
  const lum = (hex: string): number => {
    const h = hex.replace('#', '');
    const ch = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
