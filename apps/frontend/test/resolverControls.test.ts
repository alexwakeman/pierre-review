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
// `codeTokens.test.ts`, which measures `index.css` the same way). A scan cannot prove the
// arrow is clickable; it can prove the four attributes that make it reachable are still written
// down, which is the regression that would otherwise ship silently.

const read = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');

const SLOT_ROW = read('../src/components/conflicts/SlotRow.tsx');
const SLOT_STRIP = read('../src/components/conflicts/SlotStrip.tsx');
const PANES = read('../src/components/conflicts/ResolverPanes.tsx');
const COPY = read('../src/components/conflicts/copy.ts');
const TOOLBAR = read('../src/components/conflicts/ResolverToolbar.tsx');
const LANDING = read('../src/components/conflicts/LandingStep.tsx');
const OVERLAY = read('../src/components/conflicts/ConflictResolverOverlay.tsx');
const OUTSTANDING = read('../src/components/conflicts/OutstandingPopover.tsx');

/**
 * A file with its COMMENTS REMOVED.
 *
 * ⚠ EVERY ABSENCE ASSERTION IN THIS FILE NEEDS THIS, and two of them proved it by failing on the
 * prose that explains the very rule they check — a header saying in words that something must not
 * be a `contenteditable` makes a scan of the raw file report the opposite of the truth. It is the
 * same trap `gutterClasses` documents, and the one `textContrast.test.ts` hit on a backticked
 * utility name.
 *
 * Line comments and block comments only — no string-literal awareness, which these files do not
 * need and which a regex cannot honestly claim.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

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
    // bump on the ribbon takes the arrow under it with both suites green. `codeTokens.test.ts`
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

  it('⚠ NEVER STEALS A KEY FROM THE TEXT BOX, AND THE GUARD RUNS FIRST', () => {
    // `RegionEditPanel`'s textarea sits INSIDE the scroller that owns `onKeyDown`, so every
    // keystroke in it bubbles to the single-key verbs. Typing `b` would take both sides of the
    // region being edited, `x` would ignore it, `u` would clear it and Enter would leave for the
    // commit step — all with the caret sitting in the text those keys were changing.
    //
    // Two assertions, because one would not catch the real regression: the guard has to EXIST,
    // and it has to come BEFORE the verbs. A field guard moved below `case 'b'` for tidiness is
    // no guard at all, and nothing about the move would look wrong.
    const body = PANES.slice(PANES.indexOf('const onKeyDown ='));
    const guard = body.search(/closest\('input, textarea, select, \[contenteditable="true"\]'\)/);
    expect(guard, 'the field guard must still be written down').toBeGreaterThan(-1);
    for (const verb of ["case 'b':", "case 'x':", "case 'u':", "case 'Enter':", "case 'ArrowLeft':"]) {
      expect(body.indexOf(verb), verb).toBeGreaterThan(guard);
    }
    // ...and it RETURNS rather than falling through to them.
    expect(
      body.slice(guard, guard + 200),
      'the guard returns; a guard that only sets a flag is not one',
    ).toMatch(/!= null\) return;/);
  });
});

// ── THE ONE TEXT BOX ─────────────────────────────────────────────────────────────────────────
//
// Editing the centre pane is the one place this screen accepts typed file content. Three of its
// properties are single attributes somebody could drop without breaking a render, a type or a
// fold — which is what makes them assertions rather than comments.

describe('editing a region by hand', () => {
  const PANEL_SRC = read('../src/components/conflicts/RegionEditPanel.tsx');
  // ⚠ COMMENTS OUT — the panel's header says in words that this must not be a `contenteditable`
  // and must not sit inside `data-mr-cell`, so a scan of the raw file finds both strings and
  // reports the opposite of the truth. See `stripComments` at the top of this file.
  const PANEL = stripComments(PANEL_SRC);

  it('is a plain textarea, never a contenteditable', () => {
    // ⚠ `hljsLines.ts` IS EXPLICIT that only hljs output may reach `dangerouslySetInnerHTML`. An
    // editable element whose innerHTML is generated markup is how that rule gets broken by
    // accident, and a caret over highlighted spans is how it gets broken on purpose.
    expect(PANEL).toContain('<textarea');
    expect(PANEL).not.toMatch(/contentEditable/i);
    expect(PANEL, 'no highlighting under the caret').not.toContain('dangerouslySetInnerHTML');
    expect(PANEL, 'and no highlighter imported at all').not.toContain('hljsLines');
  });

  it('⚠ HANDS FOCUS BACK ON THE "FOCUS IS ABOUT TO BE DESTROYED" TEST, NOT "IT ALREADY FELL"', () => {
    // Save unmounts the panel, so without a restore focus lands on `document.body` — OUTSIDE
    // `#root`, where React's listener lives — and every single-key verb in the panes (`n`/`p`/
    // `w`/`u`/Enter) silently stops working after any edit. Nothing fails, nothing is announced.
    //
    // ⚠ THE FIRST FIX FOR THIS DID NOT WORK, AND READ AS THOUGH IT DID. It bailed on
    // `now !== document.body`, which is the opposite of the case that happens: when the cleanup
    // runs the caret is STILL IN THE TEXTAREA — React has not detached it yet — so the guard
    // decided the reader had moved on, stood aside, and focus fell to body a tick later with
    // nothing left to catch it. Confirmed in a browser: the Edit button was genuinely focused
    // before opening and focus still ended on `body`. The question is whether focus is inside
    // the box that is disappearing, so the panel's own element has to be in the test.
    expect(PANEL, 'the panel root is measurable').toMatch(/ref=\{panelRef\}/);
    expect(PANEL, 'focus is restored to wherever it came from').toMatch(
      /cameFrom\?\.isConnected === true\) cameFrom\.focus\(\)/,
    );
    expect(PANEL, 'and "losing it" includes focus still inside the panel').toMatch(
      /panel\?\.contains\(now\) === true/,
    );
    // The bare-body-only form is the defect, not a simplification of it.
    expect(PANEL, 'never the body-only guard again').not.toMatch(
      /if \(now != null && now !== document\.body\) return;/,
    );
  });

  it('mounts OUTSIDE the box the ribbon overlay measures', () => {
    // `data-mr-cell` is on `CodeCell`'s content-sized inner box. The editor is a sibling under
    // the same grid cell — put it inside that box and every ribbon in the file points at a
    // rectangle the size of a textarea.
    const ROW = read('../src/components/conflicts/SlotRow.tsx');
    expect(PANEL, 'the panel never renders a cell anchor').not.toContain('data-mr-cell');
    expect(ROW, 'the editor follows the CodeCell, it does not go inside it').toMatch(
      /<CodeCell rows=\{middle\}[^/]*\/>\s*\{pending\}\s*\{editor\}/,
    );
  });

  it('opens seeded with the region’s CURRENT result, and does not re-sync while typing', () => {
    // ⚠ A `useEffect` MIRRORING `seed` INTO STATE WOULD OVERWRITE WHAT THE READER HAD TYPED the
    // instant anything upstream re-rendered. Every route back into the box is a fresh mount, so
    // the seed prop is the only sync it needs.
    const ROW = read('../src/components/conflicts/SlotRow.tsx');
    expect(ROW).toContain("seed={editDraft ?? centre.join('\\n')}");
    expect(PANEL).toContain('useState(seed)');
    expect(PANEL, 'nothing may write the draft back from the prop').not.toMatch(
      /useEffect\([^)]*setText/,
    );
  });

  it('⚠ REMEMBERS THE DRAFT ACROSS A FILE SWITCH, which unmounts the panel while it is open', () => {
    // `edits.states` is keyed by region and survives a file switch — nothing closes an editor when
    // the reader looks at another file — but only the ACTIVE file's rows render, so the panel
    // unmounted and its `text` state died with it. The box came back open, in place, with the seed
    // in it and the reader's sentence gone: no message, no confirm, nothing on screen changed.
    const HOOK = stripComments(read('../src/components/conflicts/useRegionEdit.ts'));
    // A REF, not state: a keystroke may not re-render the file's other regions.
    expect(HOOK).toMatch(/const drafts = useRef<Record<string, string>>\(\{\}\);/);
    expect(HOOK, 'the draft is keyed by region, like every other per-region fact').toMatch(
      /drafts\.current\[regionKey\(fileIndex, regionId\)\]/,
    );
    expect(HOOK, 'and closing the box ends the draft').toMatch(/delete drafts\.current\[key\]/);
    expect(stripComments(PANEL), 'every keystroke is mirrored out').toMatch(/onDraft\(e\.target\.value\)/);
    expect(PANES).toMatch(/editDraft=\{edits\.draftFor\(activeFile\.index, region\.id\)\}/);
  });

  it('⚠ KEYS EACH ROW BY FILE, or one file’s typed text lands under another’s fingerprint', () => {
    // Region ids restart at 1 in every file and the grid is the SAME element across a file
    // switch, so `key={region.id}` reconciled file A's row 3 with file B's row 3 instead of
    // remounting it — and `RegionEditPanel` sits at a fixed child slot inside, so file B's draft
    // came back in file A's box, one press from the commit. The unchanged-lines fold leaked the
    // same way.
    expect(PANES).toMatch(/key=\{`\$\{activeFile\.index\}:\$\{region\.id\}`\}/);
  });

  it('⚠ DROPS A SAVE WHOSE REGION THE READER HAS SINCE DECIDED ANOTHER WAY', () => {
    // Press Save, then the gutter arrow on the same region: `apply` ran `edits.close` (which
    // clears the in-flight key) and stored `'ours'`, and the late answer then overwrote it with
    // `'edited'` — undoing the side the reader had just taken, and filing an undo entry from a
    // `decisions` snapshot that predated it, so Ctrl+Z cleared the region instead of restoring it.
    // `settle` and `useHunkSuggestion` both ask this question; the success path did not.
    const HOOK = stripComments(read('../src/components/conflicts/useRegionEdit.ts'));
    const save = HOOK.slice(HOOK.indexOf('const save = useCallback('));
    const answered = save.indexOf('api.editConflictRegion');
    const stored = save.indexOf('EDITS_BY_SESSION.set');
    expect(answered).toBeGreaterThan(-1);
    expect(stored).toBeGreaterThan(answered);
    expect(
      save.slice(answered, stored),
      'the guard runs between the answer and the store write',
    ).toMatch(/if \(!saving\.current\.has\(key\)\) return null;/);
  });

  it('⚠ KEEPS THE CARET, AND HANDS FOCUS BACK when the box closes', () => {
    // A browser BLURS a disabled element, so `disabled={busy}` took the caret away on Save — and
    // on a REFUSAL the box stays open with the server's sentence and the reader's text, which is
    // exactly when they need it. On success the panel unmounts outright and focus fell to
    // `document.body`, which is outside `#root`: every single-key verb in the panes stopped
    // working and Escape started offering to close the whole resolver.
    const src = stripComments(PANEL);
    const at = src.indexOf('<textarea');
    expect(at, 'the box is still a textarea').toBeGreaterThan(-1);
    const field = src.slice(at, src.indexOf('/>', at));
    expect(field).toContain('readOnly={busy}');
    expect(field, 'never disabled — a disabled field is a blurred field').not.toMatch(/disabled=/);
    expect(src).toMatch(/document\.activeElement[\s\S]{0,300}cameFrom\.focus\(\)/);
  });

  it('sends the region’s FINGERPRINT, not just its id', () => {
    // Without the content pin, text written against one version of a region could be redeemed,
    // after a rebuild, against a region that kept its id and changed its bytes.
    expect(PANES).toMatch(/edits\s*\.save\(\{[\s\S]{0,400}fingerprint: region\.fingerprint/);
  });
});

// ── THE WAY OUT OF THE PANES ─────────────────────────────────────────────────────────────────
//
// The toolbar's button said "Continue" and was deliberately never disabled, because pressing it was
// the only route to the list that explained why the commit was blocked. It says "Commit and push"
// now and is shut by `commitBlockedReason` — so the list had to move within reach of the panes, and
// the keyboard door had to get the same lock. Each assertion below is one attribute or one call
// somebody could drop without breaking a render, a type or a fold.

describe('the toolbar’s commit button', () => {
  /** The button's JSX — from the `onLand != null &&` arm to the label it renders. */
  function commitButton(): string {
    const at = TOOLBAR.indexOf('{onLand != null && (');
    expect(at, 'the toolbar still renders its way out behind an onLand guard').toBeGreaterThan(-1);
    const close = TOOLBAR.indexOf('</button>', at);
    return TOOLBAR.slice(at, close);
  }

  it('says the same words as the landing step’s button, from the same constant', () => {
    // ⚠ TWO BUTTONS, ONE VISIBLE LABEL, ON PURPOSE — one is the entry to the press, the other is
    // the press. A second spelling ("Commit & push", "Commit and Push") is how one product grows
    // two verbs for one action.
    expect(commitButton()).toContain('{COMMIT_AND_PUSH}');
    expect(LANDING).toContain('COMMIT_AND_PUSH');
    expect(stripComments(COPY), 'the retired label is gone, not renamed in place').not.toContain(
      'CONTINUE_TO_COMMIT',
    );
    expect(stripComments(TOOLBAR)).not.toContain('CONTINUE_TO_COMMIT');
  });

  it('is told apart from the landing step’s by its accessible NAME, not by its label', () => {
    // A screen reader meeting "Commit and push, button" twice in one dialog has nothing to say
    // which one pushes. Both names open with the visible words, which is WCAG 2.5.3.
    expect(commitButton()).toMatch(/aria-label=\{COMMIT_ENTRY_NAME\}/);
    expect(LANDING).toMatch(/aria-label=\{commitPressName\(/);
    expect(COPY).toMatch(/COMMIT_ENTRY_NAME = `\$\{COMMIT_AND_PUSH\}/);
    expect(COPY).toMatch(/commitPressName = \(verb: string\): string => `\$\{verb\}/);
  });

  it('is disabled by the ONE fold and by nothing of its own', () => {
    expect(commitButton(), 'the gate is the fold’s answer').toMatch(
      /disabled=\{blockedReason != null\}/,
    );
    // ⚠ NO SECOND PREDICATE. `canCommit` and `outstanding.length` are the fold's business; a
    // toolbar that re-derived either could disagree with the sentence it is printing.
    const code = stripComments(TOOLBAR);
    expect(code, 'no local re-derivation of the gate').not.toMatch(/canCommit|outstanding\.length/);
  });

  it('carries the reason as its title AND as its accessible description', () => {
    // ⚠ A DISABLED CONTROL WHOSE REASON LIVES NOWHERE is the defect the landing step's own blocked
    // paragraph exists to prevent. The toolbar is one line, so the sentence rides the tooltip, the
    // description and the counter's popover — never nothing.
    const btn = commitButton();
    expect(btn).toMatch(/title=\{blockedReason \?\? COMMIT_ENTRY_TITLE\}/);
    expect(btn).toMatch(/aria-describedby=\{blockedReason != null \? BLOCKED_REASON_ID/);
    expect(stripComments(TOOLBAR), 'and the description has an element to point at').toMatch(
      /id=\{BLOCKED_REASON_ID\}[\s\S]{0,120}\{blockedReason\}/,
    );
  });

  it('reads the reason from the same fold the landing step does', () => {
    // ONE SENTENCE, ONE PLACE. The shell folds it for the panes; the landing step folds it for
    // itself; neither composes words of its own.
    expect(OVERLAY).toMatch(/landBlockedReason=\{commitBlockedReason\(plan, headMoved\)\}/);
    expect(LANDING).toMatch(/const blockedReason = commitBlockedReason\(plan, headMoved\)/);
    expect(stripComments(LANDING), 'the landing step composes no branch of its own').not.toMatch(
      /NOTHING_TO_COMMIT\s*$/m,
    );
  });

  it('⚠ `Enter` ON THE PANES IS THE SAME DOOR AND HAS THE SAME LOCK', () => {
    // Two doors with different locks is a pattern this codebase keeps naming. Enter used to call
    // `onLand()` unconditionally, so the moment the button was gated it became the bypass.
    const body = PANES.slice(PANES.indexOf("case 'Enter':"));
    const gate = body.indexOf('landBlockedReason != null');
    const land = body.indexOf('onLand()');
    expect(gate, 'Enter reads the same reason the button does').toBeGreaterThan(-1);
    expect(land, 'and still lands the commit when nothing blocks').toBeGreaterThan(gate);
    // It SAYS why, rather than swallowing the keypress in silence — the button's description is
    // not available to somebody who just pressed a key.
    expect(body.slice(gate, land)).toMatch(/setAnnouncement\(landBlockedReason\)/);
  });
});

describe('the "Next" button and the list behind the counter', () => {
  it('walks OUTSTANDING files, never the manifest', () => {
    // ⚠ THE CHEVRONS ARE THE MANIFEST WALK AND THEY STAY. Plain sequential paging is a different
    // job; this one goes where the work is, off the same plan the gate reads.
    expect(PANES).toMatch(/nextOutstandingFile\(plan\.outstanding, activeIndex\)/);
    expect(stripComments(TOOLBAR), 'the chevrons keep stepFile').toMatch(/onStepFile\(1\)/);
  });

  it('is absent when there is nowhere to jump, never disabled', () => {
    expect(stripComments(TOOLBAR)).toMatch(/\{nextOutstanding != null && \(/);
    const at = TOOLBAR.indexOf('{nextOutstanding != null && (');
    const btn = TOOLBAR.slice(at, TOOLBAR.indexOf('</button>', at));
    expect(btn, 'a jump that is offered is a jump that works').not.toMatch(/disabled/);
  });

  it('says "Next" and announces which "Next" it is', () => {
    // ⚠ THE DUPLICATE-VERB PROBLEM, the one the gutter arrows already cost us: the chevron beside
    // it announced as "Next file". The chevrons were re-worded rather than this button being given
    // a quieter name — the reader asked for the word "Next".
    const at = TOOLBAR.indexOf('{nextOutstanding != null && (');
    const btn = TOOLBAR.slice(at, TOOLBAR.indexOf('</button>', at));
    expect(btn).toContain('{NEXT_OUTSTANDING}');
    expect(btn).toMatch(/aria-label=\{NEXT_OUTSTANDING_LABEL\}/);
    expect(COPY).toMatch(/NEXT_OUTSTANDING = 'Next'/);
    expect(COPY).toMatch(/NEXT_OUTSTANDING_LABEL = 'Next file that needs decisions'/);
    expect(COPY, 'the chevrons no longer answer to the same words').toMatch(
      /FILE_NEXT = 'Next file in the list'/,
    );
    expect(stripComments(TOOLBAR)).toMatch(/aria-label=\{FILE_NEXT\}/);
  });

  it('puts the file count beside the all-files count, off the ONE plan', () => {
    // ⚠ BOTH COUNTS COME FROM THE SHELL'S `CommitPlan`: the file's row and the total. A per-file
    // number folded anywhere else is how two figures about one file come apart.
    expect(PANES).toMatch(/const activeRow = plan\.rows\.find\(/);
    expect(PANES).toMatch(/fileDecided=\{activeRow\?\.decided \?\? null\}/);
    expect(PANES).toMatch(/fileDecidable=\{activeRow\?\.decidable \?\? null\}/);
    expect(stripComments(TOOLBAR)).toMatch(/fileChangesLeft\(fileDecidable - fileDecided, fileDecidable\)/);
    expect(OUTSTANDING).toMatch(/allChangesLeft\(total - decided, total\)/);
    // And the file menu's trigger no longer prints the same fact a second time.
    const FILE_MENU = read('../src/components/conflicts/FileMenu.tsx');
    const trigger = FILE_MENU.slice(
      FILE_MENU.indexOf('<button'),
      FILE_MENU.indexOf('</button>', FILE_MENU.indexOf('<button')),
    );
    expect(stripComments(trigger)).not.toMatch(/label/);
  });

  it('takes a whole file from ONE side in one press, with no key bound to it', () => {
    expect(stripComments(TOOLBAR)).toMatch(/onClick=\{\(\) => onTakeFile\('ours'\)\}/);
    expect(stripComments(TOOLBAR)).toMatch(/onClick=\{\(\) => onTakeFile\('theirs'\)\}/);
    // One `apply`, so one undo entry — the wand's rule.
    const take = PANES.slice(PANES.indexOf('const takeWholeFile = useCallback('));
    const body = take.slice(0, take.indexOf('[activeFile, decisions, apply'));
    expect(body.match(/apply\(/g)?.length).toBe(1);
    // ⚠ NO KEY. A reflex keystroke that rewrites a whole file is not a shortcut.
    const keys = PANES.slice(PANES.indexOf('const onKeyDown = useCallback('));
    expect(stripComments(keys.slice(0, keys.indexOf('[decideActive')))).not.toContain('takeWholeFile');
    // The grain is in the name, so the file take never announces like a gutter arrow.
    expect(COPY).toMatch(/TAKE_FILE_OURS = 'Take your file'/);
    expect(COPY).toMatch(/takeFileTheirs = \(baseRef: string\): string => `Take \$\{baseRef\}’s file`/);
  });

  it('keeps the outstanding list reachable from the panes', () => {
    // ⚠ THE REASON THE BUTTON COULD BE GATED AT ALL. "Still to decide" used to be rendered only on
    // the landing step, which is why the old button was deliberately never disabled. It is a press
    // off the counter now, with the same per-file rows and the same jump.
    expect(stripComments(TOOLBAR)).toContain('<OutstandingPopover');
    expect(OUTSTANDING).toMatch(/aria-label=\{jumpToFileLabel\(row\.path, row\.remaining\)\}/);
    expect(OUTSTANDING).toMatch(/\{toDecide\(row\.remaining\)\}/);
    expect(OUTSTANDING, 'and the same sentence the button wears').toMatch(
      /\{blockedReason \?\? ALL_DECIDED\}/,
    );
    // The landing step still renders its own copy — it also names what the commit will NOT carry.
    expect(LANDING).toMatch(/plan\.outstanding\.map\(/);
    expect(LANDING).toContain('cantFinishHere');
  });

  it('jumps through the one mechanism that waits for a file to arrive', () => {
    // ⚠ NOT STRAIGHT TO A REGION. A file's regions may not be fetched yet, and landing on region 1
    // of a file whose first four are decided is the defect `pendingJump`'s second half exists to
    // prevent. Both the popover's rows and "Next" go through it.
    const jump = PANES.slice(PANES.indexOf('const goToFile = useCallback('));
    expect(jump.slice(0, jump.indexOf('[activeIndex, files'))).toMatch(/pendingJump\.current = index;/);
    expect(PANES).toMatch(/onJumpToFile=\{goToFile\}/);
    expect(PANES).toMatch(/if \(nextOutstanding != null\) goToFile\(nextOutstanding\)/);
    // ⚠ AND THE ONE CASE `pendingJump` CANNOT SERVE: its second half is keyed on `activeIndex`
    // changing, so a row naming the file already on screen would land on region 1 rather than on
    // the first unanswered one. The popover lists that file; "Next" never does.
    expect(jump.slice(0, jump.indexOf('pendingJump.current'))).toMatch(
      /if \(index === activeIndex\)[\s\S]{0,400}r\.kind !== 'unchanged' && decisions\[regionKey\(index, r\.id\)\] == null/,
    );
  });
});

describe('who owns Escape inside the resolver', () => {
  const LAYER = read('../src/components/conflicts/popoverLayer.ts');
  const POPOVERS = [
    'BasePopover.tsx',
    'FileMenu.tsx',
    'OutstandingPopover.tsx',
  ] as const;

  it('⚠ THE SHELL ASKS INSTEAD OF RACING, because registration order is not a mechanism', () => {
    // Same-target, same-phase listeners fire in the order they were ADDED, and the shell's
    // handler is added on MOUNT — before any popover exists. So its `stopImmediatePropagation`
    // ran first and no popover's listener ever did: Escape on the file menu, the compare-base
    // popup or the counter's list closed the WHOLE RESOLVER, and with `decidedCount === 0` there
    // was not even a reopen toast. It also killed floating-ui's own `useDismiss`, which listens
    // on `document` and never received the event.
    const overlay = stripComments(OVERLAY);
    const at = overlay.indexOf("if (e.key !== 'Escape') return;");
    expect(at, 'the shell still owns one window-level Escape handler').toBeGreaterThan(-1);
    const handler = overlay.slice(at, overlay.indexOf('};', at));
    const asks = handler.indexOf('resolverPopoverOpen()');
    const stops = handler.indexOf('stopImmediatePropagation');
    expect(asks, 'the shell consults the popover layer').toBeGreaterThan(-1);
    expect(stops, 'and only then takes the key').toBeGreaterThan(asks);
    expect(handler.slice(asks, stops)).toContain('return;');
  });

  it('⚠ EVERY POPOVER GOES THROUGH THE SHARED HOOK, and none hand-rolls its own listener', () => {
    // `FileMenu` had NO handler at all and relied on floating-ui — which is why its Escape closed
    // the resolver. The other two had one that could never run. One owner, counted, so the shell
    // knows to stand aside.
    for (const file of POPOVERS) {
      const src = stripComments(read(`../src/components/conflicts/${file}`));
      expect(src, `${file} takes Escape from popoverLayer`).toContain('useResolverPopoverEscape(');
      expect(src, `${file} must not add its own keydown listener`).not.toContain(
        "addEventListener('keydown'",
      );
    }
  });

  it('counts and listens in ONE effect, so a counted layer always has a handler', () => {
    const effect = LAYER.slice(LAYER.indexOf('export function useResolverPopoverEscape'));
    expect(effect).toMatch(/openLayers \+= 1;[\s\S]{0,600}addEventListener\('keydown', onKey, true\)/);
    expect(effect).toMatch(/openLayers -= 1;[\s\S]{0,200}removeEventListener\('keydown', onKey, true\)/);
    expect(effect, 'and it still stops the app-wide Escape the shell used to stop').toContain(
      'e.stopImmediatePropagation();',
    );
  });

  it('⚠ MOVES FOCUS INTO THE OUTSTANDING LIST, which the portal puts last in the tab order', () => {
    // `FloatingPortal` appends to `document.body`, AFTER the whole `#root` subtree, and nothing
    // here renders floating-ui's tab-order guards — so tabbing from the trigger walked every
    // "Show N unchanged lines" fold in the visible file first. These rows are the ONE keyboard
    // route to the outstanding files now that the button beside them is disabled.
    const src = stripComments(OUTSTANDING);
    expect(src).toMatch(/panelRef\.current[\s\S]{0,120}querySelector<HTMLElement>\('button'\)/);
    expect(src, 'and back to the trigger on close').toMatch(/triggerRef\.current[\s\S]{0,80}\.focus\(\)/);
  });
});

describe('a pull request with nothing resolvable', () => {
  it('⚠ SAYS SO IN THE PANES, not only in a tooltip behind a disabled button', () => {
    // A binary-only conflict yields a `ready` session with no resolvable file: "Next" is absent,
    // the commit button is shut, and every other sentence on screen reads as "there are no
    // conflicts" while the pull request is still conflicted. The sentence that says otherwise
    // used to be reachable only by pressing the button this change disabled.
    // ⚠ THE JSX BRANCH, not the `language` fold twenty lines up that reads the same words.
    const at = PANES.indexOf('{activeEntry == null ? (');
    expect(at, 'the empty-panes branch is still one ternary').toBeGreaterThan(-1);
    const head = PANES.slice(at, PANES.indexOf('fileErrors[activeIndex] != null', at));
    expect(head, 'the refusal, not a bare "nothing here"').toContain('landBlockedReason ??');
    expect(head, 'and the files that keep it conflicted').toContain('plan.notCarried');
    expect(head).toContain('STILL_CONFLICTED');
    expect(head).toContain('STAYS_CONFLICTED');
  });
});

// ── THE GROUND THE ARROW ACTUALLY SITS ON ────────────────────────────────────────────────────
//
// The gutter track is also the ribbon's x-span, so a decided region's arrow is on a green tint
// rather than on the page. These four helpers composite that tint from `index.css` itself — the
// same rule `codeTokens.test.ts` follows, and for the same reason: measure what the page
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

/** WCAG 2.x relative contrast. Same four lines as `codeTokens.test.ts` and
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
