import type { ConflictCommitPhase, ConflictRegion } from '@pierre-review/shared';
import { toDecide } from '../../lib/mergeResolver.js';
import type { PanePaint, SlotDecision, SlotRole } from '../../lib/mergeResolver.js';

// ── THE RESOLVER'S WORDS ─────────────────────────────────────────────────────────────────────
//
// Every string the three panes put on screen, in one file, so the vocabulary can be read as a
// whole rather than discovered one component at a time. Two rules govern all of it:
//
//  • NAME THE THING. "Your version" and "Changes from main", never "left" and "right" — the
//    reader is deciding between two branches, not two columns. The base branch's real name goes
//    into the sentence wherever there is room for it.
//  • STATE THE FACT AND STOP. A region is "Applied" or "Ignored" or it "Needs a decision". No
//    confidence, no explanation of what a three-way merge is, no reassurance.
//
// ⚠ NO GLYPHS. Every mark in here would have to be a character, and a character in a string is
// something `Icons.tsx`'s header spends forty lines explaining is wrong. Arrows and ticks are
// components; these are sentences.

/** The three pane headers. `Result` is deliberately not "Merged" — nothing is merged until the
 *  reader has answered every region, and calling the middle column "Merged" says otherwise. */
export const PANE_OURS = 'Your version';
export const PANE_RESULT = 'Result';
export const paneTheirs = (baseRef: string): string => `Changes from ${baseRef}`;

/** The state word on the strip — the third of the three encodings (wash, rule, word), and the
 *  only one that survives a reader who cannot separate the hues. */
export function stateWord(region: ConflictRegion, slot: SlotDecision): string {
  if (region.kind === 'unchanged') return '';
  switch (slot.kind) {
    // ⚠ ONE WORD FOR BOTH KINDS. "Not applied" used to sit on an undecided one-sided change back
    // when one-sided changes were applied for you, so the phrase named a state somebody had
    // chosen. Nothing is applied before a press now, so it is the OPENING state of every change —
    // and the commit is blocked on it, which "Not applied" does not say.
    case 'unapplied':
      return 'Needs a decision';
    case 'ignored':
      return 'Ignored';
    case 'wand':
      return 'Merged';
    case 'ai':
      return 'Suggested';
    // ⚠ THE ONE PLACE THAT SAYS THE CENTRE IS THE READER'S OWN TEXT. An edited region's centre
    // wears the same applied green as a taken side, and neither side pane is painted — so this
    // word is what separates "you wrote this" from "you took one of these". It is also why the
    // two sides go bare: see `sideOutcome`'s `edit` arm.
    case 'edit':
      return 'Your text';
    case 'both-lr':
    case 'both-rl':
      return 'Both applied';
    default:
      return 'Applied';
  }
}

/** The role's ink class. One lookup, so a component never spells a colour. */
export const INK_CLASS: Record<Exclude<SlotRole, null>, string> = {
  change: 'mr-ink-change',
  conflict: 'mr-ink-conflict',
  applied: 'mr-ink-applied',
  ignored: 'mr-ink-ignored',
};

export const WASH_CLASS: Record<Exclude<SlotRole, null>, string> = {
  change: 'mr-wash-change',
  conflict: 'mr-wash-conflict',
  applied: 'mr-wash-applied',
  ignored: 'mr-wash-ignored',
};

// ── `EDGE_CLASS` — DELETED, AND IT MUST NOT COME BACK ────────────────────────────────────────
//
// A side the reader turned down used to drop to a 1px outline in its own hue, on the argument that
// "this was the other option" and "this pane has nothing here" are different facts. They are — but
// a rejected side now paints NOTHING, `.mr-filler`'s hatch still says which pane has no lines, and
// the strip's word still says what was decided. What the outline added on screen was a red or blue
// rectangle around a block nobody took, beside a green one they did. `.mr-edge-*` is gone from
// `index.css` and `codeTokens.test.ts` asserts no such rule exists.

/** The one place a pane's paint becomes a class. `''` is a real answer, and it covers four cases
 *  now: an `unchanged` region, an undecided RESULT, a side offering nothing (`both_same`'s right,
 *  a one-sided region's silent half) and a side the decision turned down. */
export function paintClass(paint: PanePaint | null): string {
  return paint == null ? '' : WASH_CLASS[paint];
}

/** The ribbon's fill class.
 *
 *  ⚠ A CLASS, NOT AN ATTRIBUTE. `var()` works as a CSS PROPERTY and not inside an SVG presentation
 *  attribute, so `fill="rgb(var(--mr-applied) / 0.22)"` paints nothing at all. The path carries
 *  this class name and `index.css` owns the value, exactly as every other colour here does.
 *
 *  ⚠ ONE CLASS, NOT A LOOKUP. It used to be keyed on the region's TYPE. A ribbon joins an ACCEPTED
 *  side to the result it produced and an accepted side is green, so a type-hued band between two
 *  green blocks was the one discontinuity in the row. See `ribbonSides`' header for the argument
 *  this overrules. */
export const FILL_CLASS = 'mr-fill-applied';

export const RULE_CLASS: Record<Exclude<SlotRole, null>, string> = {
  change: 'mr-rule-change',
  conflict: 'mr-rule-conflict',
  applied: 'mr-rule-applied',
  ignored: 'mr-rule-ignored',
};

/**
 * The group label every strip carries.
 *
 * ⚠ WITHOUT THIS THE RESOLVER ANNOUNCES AS THOUSANDS OF LOOSE BUTTONS. `display: contents` takes
 * the row wrapper out of the accessibility tree, so the grouping and the position have nowhere
 * else to live.
 */
export function regionGroupLabel(
  region: ConflictRegion,
  ordinal: number,
  total: number,
  path: string,
): string {
  const noun = region.kind === 'conflict' ? 'Conflict' : 'Change';
  return `${noun} ${ordinal} of ${total} in ${path}`;
}

/**
 * The two gutter arrows' ACCESSIBLE NAME — the strip's verb plus the position `regionGroupLabel`
 * already spells.
 *
 * ⚠ THE POSITION IS NOT PADDING HERE, IT IS THE ONLY COPY OF IT THESE CONTROLS GET. The strip's
 * `role="group"` announces "Conflict 2 of 5 in src/foo.ts" around everything inside it; the gutter
 * arrows live in their own grid cells, two columns away, so they are outside that group and a name
 * of "Take your version" alone would read as one of several hundred identical buttons with nothing
 * saying which change it belongs to. The visible tooltip stays the short verb — this is the long
 * form, for a reader who cannot see which row the pointer is on.
 */
export const gutterLabel = (
  action: string,
  region: ConflictRegion,
  ordinal: number,
  total: number,
  path: string,
): string => `${action} — ${regionGroupLabel(region, ordinal, total, path)}`;

/** The button labels. Icon-only controls, so these are the accessible names AND the tooltips —
 *  which is why each is a whole instruction rather than a word. */
export const actionLabels = (baseRef: string) => ({
  left: 'Take your version',
  right: `Take the change from ${baseRef}`,
  bothLr: `Take both — yours first, then ${baseRef}`,
  bothRl: `Take both — ${baseRef} first, then yours`,
  swap: 'Swap which side goes first',
  ignore: 'Ignore this change and keep the ancestor',
  undo: 'Undo this decision',
  edit: 'Edit the result for this change',
});

// ── EDITING ONE REGION'S RESULT ──────────────────────────────────────────────────────────────
//
// The resolver's one text box. Everything here is about ONE region, and none of it explains what
// editing is for — the reader opened it because they wanted the trailing comma gone.

/** The strip's button. A verb, and short enough to sit beside six other controls. */
export const EDIT_REGION = 'Edit';
/** The panel's own heading. It names the population — this region's result, not the file. */
export const EDIT_PANEL_TITLE = 'Your text for this change';
export const EDIT_SAVE = 'Save';
export const EDIT_CANCEL = 'Cancel';
export const EDIT_SAVING = 'Saving…';
/** The textarea's accessible name. Icon-free control, so this is also what a screen reader
 *  announces on entry; it names the file, because a resolver may hold forty of them. */
export const editFieldLabel = (path: string, ordinal: number, total: number): string =>
  `Result for change ${ordinal} of ${total} in ${path}`;
/** Under the box, always — the ONE fact about this control that is nowhere else on screen: what
 *  it replaces. ⚠ IT USED TO END "Nothing is committed until you push." That is true and it is
 *  also the shape of the whole overlay — a footer counting decisions, a "Commit and push" that
 *  only opens the review step, then the press itself — so it was reassurance nobody asked for,
 *  which is verbiage however true it is. */
export const EDIT_HINT = 'This replaces the result for this change only.';

/** The toolbar.
 *
 * ⚠ THE TWO FILE CHEVRONS PAGE THE MANIFEST AND SAY SO. They used to announce as "Previous file"
 * and "Next file"; the toolbar now also carries a word-labelled "Next" that goes to the next file
 * still needing decisions, and two controls announcing as "Next …" is the duplicate-verb problem
 * the gutter arrows already cost us. Plain sequential paging is a different job, so it keeps its
 * chevrons and names itself for what it is. */
export const FILE_PREV = 'Previous file in the list';
export const FILE_NEXT = 'Next file in the list';

/** The jump to the next file that still needs decisions. ⚠ THE VISIBLE WORD AND THE ACCESSIBLE
 *  NAME DIFFER ON PURPOSE: "Next" is what the reader asked for and what fits beside six other
 *  controls, and the name says which "next" it is. The name CONTAINS the visible word, which is
 *  WCAG 2.5.3 and not decoration. It is absent — never disabled — once nothing else is
 *  outstanding; see `nextOutstandingFile`. */
export const NEXT_OUTSTANDING = 'Next';
export const NEXT_OUTSTANDING_LABEL = 'Next file that needs decisions';

/** The counter's popover — the outstanding list, reachable from the panes.
 *
 * ⚠ IT EXISTS BECAUSE THE DOOR IS NOW LOCKED. The per-file "Still to decide" rows used to live
 * only on the landing step, and the toolbar button was left enabled precisely so a blocked reader
 * could get to them. The button is gated on the same fold as the commit now, so the list has to be
 * reachable without it — a disabled control whose reason lives nowhere is the defect the landing
 * step's own blocked paragraph exists to prevent. The rows are the same rows, one fold over. */
export const OUTSTANDING_TITLE = 'What is left to decide';
/** The popover with nothing left in it. It says the fact and stops — the button beside it is the
 *  action, and telling the reader to press it is an instruction nobody asked for. */
export const ALL_DECIDED = 'Everything is decided.';

/** The two whole-file takes (`wholeFilePlan`). ⚠ "FILE" IS THE WORD THAT SEPARATES THEM FROM THE
 *  GUTTER ARROWS, which say "Take your version" about ONE change — the same verb at a different
 *  grain, so the grain is in the name. The tooltip states the consequence, because on a region
 *  only the other branch changed, "your file" means leaving that change out. */
export const TAKE_FILE_OURS = 'Take your file';
export const takeFileTheirs = (baseRef: string): string => `Take ${baseRef}’s file`;
export const takeFileOursTitle = (baseRef: string): string =>
  `Make this whole file your version. ${baseRef}’s changes to it are left out.`;
export const takeFileTheirsTitle = (baseRef: string): string =>
  `Make this whole file ${baseRef}’s version. Your changes to it are left out.`;
/** Said once the press lands — the banner and the live region. */
export const FILE_NOW_OURS = 'This file is now your version.';
export const fileNowTheirs = (baseRef: string): string => `This file is now ${baseRef}’s version.`;

/** The two counts beside the outstanding list's trigger: the file on screen, then every file.
 *
 *  ⚠ BOTH ARE THE COMMIT GATE'S POPULATION — every DECIDABLE region, read off the shell's ONE
 *  `CommitPlan` (`rows` for the file, `decidableTotal`/`decidedTotal` for the whole) — so the two
 *  cannot disagree with each other, with the footer's "N of M changes decided", or with the
 *  button they hold shut. They count DOWN because the reader asked what is left; the footer
 *  counts up, and the two always sum to the same denominator. */
export const fileChangesLeft = (remaining: number, decidable: number): string =>
  decidable === 0
    ? 'This file: nothing to decide'
    : remaining === 0
      ? 'This file: all decided'
      : `This file: ${remaining} of ${decidable} changes left`;
export const allChangesLeft = (remaining: number, decidable: number): string =>
  decidable === 0
    ? 'Nothing to decide in this pull request.'
    : remaining === 0
      ? 'All files: all decided'
      : `All files: ${remaining} of ${decidable} changes left`;

export const WAND_BUTTON = 'Take the obvious ones';
export const WAND_BUTTON_TITLE =
  'Apply every change only one side made, and merge the conflicts whose edits don’t overlap. Never picks a side.';
export const COMPARE_BASE = 'Merge base';
export const COMPARE_BASE_HEADER = 'Merge base — the last commit both branches shared.';
export const COMPARE_BASE_EMPTY = 'Pick a change first.';
export const UNDO_LAST = 'Undo';

/** The file menu. */
export const unsupportedHeadline = (n: number): string =>
  `${n} file${n === 1 ? '' : 's'} need resolving on GitHub.`;
export const fileCount = (decided: number, total: number): string => `${decided} of ${total} files`;
/** ⚠ RE-EXPORTED, NOT RE-SPELLED — declared in `lib/mergeResolver.ts`, where the folds that use
 *  them live. A library may not import from `components/`, so the declaration is there and the
 *  vocabulary is readable here. */
export { CANT_RESOLVE_HERE, NOTHING_TO_DECIDE } from '../../lib/mergeResolver.js';
export { toDecide };

/** ⚠ RE-EXPORTED FOR THE SAME REASON, ONE FOLD OVER. These three are the words
 *  `commitBlockedReason` picks between, and that fold is a library — so the strings sit beside it
 *  and are readable here. The toolbar's button, the toolbar's counter popover and the landing
 *  step's button all print whatever it returns; none of them composes a sentence of its own. */
export { HEAD_MOVED, NOTHING_TO_COMMIT, decideTheRest } from '../../lib/conflictCommit.js';

/** The banners above the panes — facts about the model, stated once. */
export const RENAME_DETECTION_OFF =
  'Rename detection is off: this pull request changes too many files. A renamed file shows as a delete and an add.';
export const truncatedNotice = (shown: number, total: number): string =>
  `Showing ${shown} of ${total} conflicting files. The rest need resolving on GitHub.`;
export const NARROW_PANES =
  'The window is too narrow for three columns, so the versions are stacked. Widen it to get them back.';

/** The fold. */
export const showUnchanged = (n: number): string => `Show ${n} unchanged line${n === 1 ? '' : 's'}`;
export const HIDE_UNCHANGED = 'Hide unchanged lines';

/**
 * The status line — the toolbar's and the footer's, which are the SAME number read off the SAME
 * `CommitPlan`.
 *
 * ⚠ ITS POPULATION IS THE COMMIT GATE'S. It used to count contested regions only, which could
 * read "3 of 3 conflicts decided" beside a Commit button held shut by four one-sided changes
 * nobody had answered. Every decidable region is the reader's to answer now, so the counter
 * counts exactly what the gate holds out for.
 */
export const decisionsDecided = (decided: number, total: number): string =>
  total === 0 ? 'Nothing to decide in this pull request.' : `${decided} of ${total} changes decided`;

/** What the overlay says while the model is still being read — the panes' notice AND the footer's
 *  fallback, which is the same moment seen from two places.
 *
 *  ⚠ THE FOOTER MUST NOT SAY "Nothing to decide yet" HERE. `decisionsDecided(0, 0)` already means
 *  "there is nothing in this pull request to decide", and a fallback saying the same thing while
 *  the files are still arriving asserts a fact about the pull request nobody has established — a
 *  second later it flips to "12 of 12 changes decided". */
export const READING_FILES = 'Reading the conflicting files…';

// ── THE LANDING STEP ─────────────────────────────────────────────────────────────────────────
//
// A second view inside the SAME overlay, not a nested modal — `Back` returns to the panes with
// every decision intact. Three questions in order: what is going in, how it lands, where it goes.

export const LANDING_BACK = 'Back to the panes';

// ⚠ `CONTINUE_TO_COMMIT = 'Continue'` IS RETIRED, NOT RENAMED IN PLACE. The toolbar's button says
// `COMMIT_AND_PUSH` now, the same constant the landing step's button renders, so the two say the
// same words in the same case — which is the point: one is the entry to the press, the other is
// the press, and a reader who has decided everything should see the same verb in both places.
// What separates them is the ACCESSIBLE NAME (`COMMIT_ENTRY_NAME` / `commitPressName`), because
// "two buttons called Commit and push" is exactly what a screen reader would otherwise hear.

export const WHAT_GOES_IN = 'What is being committed';
export const filesResolved = (resolved: number, total: number): string =>
  `${resolved} of ${total} file${total === 1 ? '' : 's'} resolved`;
/** ⚠ EVERY FILE THIS COMMIT WILL NOT CARRY AND THE READER CANNOT FINISH. A half-decided file
 *  BLOCKS the commit now instead of being dropped from it, so it is in "Still to decide" above,
 *  not here. What is left is the model's own exclusions: a file it cannot represent, and a
 *  supported file it found nothing decidable in. Both stay conflicted on GitHub, and both have to
 *  be NAMED — a file dropped from a commit with nothing on screen about it is the silent exclusion
 *  the whole gate exists to end. */
export const STILL_CONFLICTED = 'Still conflicted:';
export const STAYS_CONFLICTED =
  'This pull request stays conflicted until these are resolved too.';

/** The blocked half: the files still holding the commit shut, each with a click that goes there.
 *  ⚠ THE SENTENCE CARRIES THE TOTAL AND THE ROWS CARRY THE PER-FILE COUNT, so neither number has
 *  to stand in for the other.
 *  ⚠ THE COLON MATCHES `STILL_CONFLICTED`'s. They are two sibling headings four lines apart in one
 *  section; punctuating one and not the other reads as an oversight. */
export const STILL_TO_DECIDE = 'Still to decide:';
/** ⚠ IT CARRIES BOTH VISIBLE SPANS. The row renders the path AND the per-file remainder, and an
 *  `aria-label` REPLACES the whole subtree — a name of "Go to src/foo.ts" alone leaves a screen
 *  reader with no remainder anywhere on the screen (the sentence above is the cross-file total),
 *  and drops the visible "3 to decide" out of the accessible name, which is WCAG 2.5.3. */
export const jumpToFileLabel = (path: string, remaining: number): string =>
  `Go to ${path}, ${toDecide(remaining)}`;

/**
 * ⚠ THE ONE SENTENCE HERE THAT NEEDS MORE WORDS, NOT FEWER.
 *
 * It is the MEASURED behaviour of a partial commit: a region the reader ignored merges cleanly to
 * the base branch's version, so finishing the merge on GitHub later takes that version without
 * asking anybody. "The shortest honest version wins" is a tie-break between honest options, not a
 * licence to compress a claim past the point where it can be understood.
 */
export const PARTIAL_COMMIT_NOTE =
  'This commit keeps the files you resolved. A conflict you ignored is committed as the base branch’s version, so finishing the merge later takes that version without asking.';

export const HOW_TO_LAND = 'How to land it';
export const STRATEGY_MERGE = 'Merge';
/** ⚠ CONDITIONAL ON `fullyResolvable`. Without the fork the default card promises a merge commit
 *  the common path does not produce. */
export const STRATEGY_MERGE_FULL = 'One merge commit on your branch. Plain push.';
export const STRATEGY_MERGE_PARTIAL =
  'One commit with the files you resolved. Not a merge commit — this pull request stays conflicted.';
export const STRATEGY_REBASE = 'Rebase';
export const strategyRebaseDetail = (baseRef: string): string =>
  `Replays your commit onto ${baseRef}. Force-pushes with --force-with-lease.`;

export const WHERE_TO_PUT_IT = 'Where to put it';
export const pushToBranch = (headRef: string): string => `Push to ${headRef}`;
export const NEW_BRANCH = 'Commit to a new branch';
export const NEW_BRANCH_FIELD = 'Branch name';
export const OPEN_PR_FOR_BRANCH = 'Open a pull request for it';

/** The pins, in the reader's words. Seven characters is what GitHub shows. */
export const pinnedOn = (headSha: string, baseSha: string): string =>
  `Based on ${headSha.slice(0, 7)} and ${baseSha.slice(0, 7)}. If either moves, nothing is pushed.`;

export const COMMIT_AND_PUSH = 'Commit and push';
export const REBASE_AND_FORCE_PUSH = 'Rebase and force-push';

/**
 * The two buttons that share the words "Commit and push", told apart for a reader who cannot see
 * where they are.
 *
 * ⚠ THE VISIBLE LABEL IS THE SAME ON PURPOSE AND THE ACCESSIBLE NAME IS NOT. The toolbar's button
 * opens the review step — what is going in, how it lands, where it goes — and the landing step's
 * button is the press that reaches GitHub. Sighted readers have the whole screen to tell those
 * apart; a screen reader has the name, and "Commit and push, button" twice in one dialog says
 * nothing about which one pushes. Both names OPEN with the visible words (WCAG 2.5.3), so "press
 * Commit and push" still finds either.
 */
export const COMMIT_ENTRY_NAME = `${COMMIT_AND_PUSH} — review what goes in first`;
export const commitPressName = (verb: string): string => `${verb} — pushes to GitHub now`;
/** The toolbar button's tooltip while nothing blocks it. Blocked, it wears the refusal instead —
 *  one sentence, from `commitBlockedReason`, the same one the landing step prints. */
export const COMMIT_ENTRY_TITLE = 'Review what gets committed, then push';

/** Stated BEFORE the button, never after the push. It is true because the commit disarms the
 *  intent explicitly — the sentence and the behaviour ship together. */
export const AUTO_MERGE_ARMED =
  'Merge when ready is armed on this pull request. Pushing this commit disarms it — arm it again afterwards.';

/** Wire vocabulary → one short sentence, the same rule as the prepare phases. */
export const COMMIT_SENTENCE: Record<ConflictCommitPhase, string> = {
  preparing: 'Getting a copy of the repository…',
  fetching: 'Fetching both branches…',
  merging: 'Applying your decisions…',
  committing: 'Making the commit…',
  pushing: 'Pushing…',
  confirming: 'Checking it landed…',
};

// ── AFTER THE COMMIT ─────────────────────────────────────────────────────────────────────────
//
// The overlay does NOT auto-close. This is the only place the per-file refusals are stated, and
// closing over them would leave the reader with a pull request that is still conflicted and
// nothing on screen saying why.

/** `a`, `a and b`, `a, b and c`, then `a, b, c and 4 more`. */
export function listPaths(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0] ?? '';
  const head = paths.slice(0, 3);
  const rest = paths.length - head.length;
  const last = rest > 0 ? `${rest} more` : (head.pop() ?? '');
  return `${head.join(', ')} and ${last}`;
}

export const pushedTo = (branch: string, commitSha: string): string =>
  `Pushed to ${branch} — ${commitSha.slice(0, 7)}.`;
export const resolvedAcross = (conflicts: number, files: number): string =>
  `${conflicts} conflict${conflicts === 1 ? '' : 's'} resolved across ${files} file${files === 1 ? '' : 's'}.`;
export const stillConflictSentence = (paths: readonly string[]): string =>
  `${listPaths(paths)} still conflict${paths.length === 1 ? 's' : ''}; resolve ${paths.length === 1 ? 'it' : 'them'} on GitHub.`;
export const baseAdvancedSentence = (baseRef: string): string =>
  `${baseRef} moved while you were resolving. Those commits are in this merge.`;
export const AUTO_MERGE_DISARMED = 'Merge when ready was disarmed. Arm it again if you still want it.';

/** ⚠ THE COPY CONTRACT, AND IT IS A SAFETY RULE. `visible: false` with a real commit sha means the
 *  push SUCCEEDED and the resync tail merely could not confirm it locally. It must never read as a
 *  failure and must NEVER offer a retry — a retry double-pushes. */
export const NOT_YET_VISIBLE = 'It’ll show up here shortly.';

/** The server no longer has this session and nothing had been pushed yet. Safe to start again —
 *  and this is the only lost-session case where offering that is safe.
 *
 *  ⚠ IT STATES THE FACT AND STOPS; THE BUTTON CARRIES THE ACTION. It used to end "Start again."
 *  beside a control labelled "Try again" — two verbs for one button. The control is now labelled
 *  with `START_AGAIN` and the sentence says only what happened. */
export const SESSION_GONE = 'This session is no longer open.';

/**
 * The commit's outcome after this browser lost the session: the server took it and answered 202,
 * then the stream was cut and the manifest poll came back "no longer open".
 *
 * ⚠ IT MUST NOT SAY IT FAILED AND MUST NOT OFFER A RETRY. A retry is a SECOND PUSH.
 *
 * ⚠ IT MUST NOT PROMISE THE PUSH LANDED EITHER, WHICH IS NOT THE SAME RULE. It used to borrow
 * `NOT_YET_VISIBLE`'s "it'll show up here shortly" — a sentence that is honest ONLY where GitHub
 * has already 201'd and local visibility is the sole doubt. Here the 202 is all we have: the land
 * path may have refused (a head that moved under it), or the process may have died mid-push. So
 * it names where the answer is — the pull request — and asserts nothing about what the answer is.
 */
export const COMMIT_UNCONFIRMED =
  'Your resolution was sent, but this session ended before the result came back. Check the pull request on GitHub.';

export const NOTHING_PUSHED = 'Nothing was pushed.';
export const START_AGAIN = 'Start again';
export const CLOSE_RESOLVER = 'Close';
export const OPEN_COMPARE = 'Open the compare view';

// ── LEAVING ──────────────────────────────────────────────────────────────────────────────────

/** Permanent, in the footer. The retained-decision design is what makes an accidental Escape
 *  survivable, so this replaces the old "nothing here is saved" line rather than sitting beside
 *  it. */
export const DECISIONS_KEPT = 'Your decisions are kept until you reload.';

/** ⚠ THE SAME POPULATION AS THE COUNTER ABOVE IT — every decidable region, off the one
 *  `CommitPlan`. It used to count contested regions, so a reader who had answered fifteen
 *  one-sided changes and no conflicts was asked to confirm under the sentence "0 of 3 conflicts
 *  resolved". */
export const closeConfirmQuestion = (decided: number, total: number): string =>
  `${decided} of ${total} changes decided, nothing pushed. Your choices are kept until you reload.`;
export const KEEP_WORKING = 'Keep working';
export const CLOSE_ANYWAY = 'Close';

/**
 * ⚠ A COUNT, NOT A FRACTION, AND THAT IS DELIBERATE. `ClosedResolver.decidedCount` counts every
 * DECIDABLE region the reader answered, while the store's other number, `conflictCount`, is
 * CONTESTED regions only — pairing those two on this record prints "31 of 8". Nothing seeds a
 * decision any more, so the numerator is honest, but the two fields are still two populations.
 *
 * ⚠ AND THE TOAST CANNOT REBUILD A DENOMINATOR ANYWAY. It outlives the loaded files AND the
 * manifest, so the overlay's "9 of 12 changes decided" is not available to it. It says the one
 * number it actually holds.
 */
export const closedToast = (decided: number): string =>
  `Conflict resolver closed — ${decided} decision${decided === 1 ? '' : 's'} kept, nothing pushed.`;
export const REOPEN = 'Reopen';

/** Said once, when a reopen lands on a model built against different shas: the decisions are not
 *  migrated onto a merge the reader never saw. */
export const BRANCH_MOVED_RESTART = 'The branch moved since you started. Starting again.';
