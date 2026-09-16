import type { ConflictCommitPhase, ConflictRegion } from '@pierre-review/shared';
import type { SlotDecision, SlotRole } from '../../lib/mergeResolver.js';

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
    case 'unapplied':
      return region.kind === 'conflict' ? 'Needs a decision' : 'Not applied';
    case 'ignored':
      return 'Ignored';
    case 'wand':
      return 'Merged';
    case 'ai':
      return 'Suggested';
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
});

/** The toolbar. */
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
/** ⚠ RE-EXPORTED, NOT RE-SPELLED — it is declared in `lib/mergeResolver.ts`, where the two
 *  folds that fall back to it live. */
export { CANT_RESOLVE_HERE } from '../../lib/mergeResolver.js';

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

/** The status line. */
export const conflictsDecided = (decided: number, total: number): string =>
  total === 0 ? 'Nothing contested in this pull request.' : `${decided} of ${total} conflicts decided`;

// ── THE LANDING STEP ─────────────────────────────────────────────────────────────────────────
//
// A second view inside the SAME overlay, not a nested modal — `Back` returns to the panes with
// every decision intact. Three questions in order: what is going in, how it lands, where it goes.

export const LANDING_BACK = 'Back to the panes';
export const CONTINUE_TO_COMMIT = 'Continue';

export const WHAT_GOES_IN = 'What is being committed';
export const filesResolved = (resolved: number, total: number): string =>
  `${resolved} of ${total} file${total === 1 ? '' : 's'} resolved`;
export const STILL_CONFLICTED = 'Still conflicted:';
export const STAYS_CONFLICTED =
  'This pull request stays conflicted until these are resolved too.';
export const NOTHING_DECIDED_YET = 'Decide a whole file before committing.';

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

/** Stated BEFORE the button, never after the push. It is true because the commit disarms the
 *  intent explicitly — the sentence and the behaviour ship together. */
export const AUTO_MERGE_ARMED =
  'Merge when ready is armed on this pull request. Pushing this commit disarms it — arm it again afterwards.';

/** ⚠ THE CLIENT MAKES NO OTHER COMPARISON. `usePrLiveRefresh` already re-reads the PR while the
 *  pane is open, and the pinned head is on the session; a second answer to "has this moved?" is
 *  how two surfaces come to disagree. */
export const HEAD_MOVED =
  'This pull request moved on GitHub while you were here. Committing will be refused — close this and start again.';

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

/**
 * The SAME contract, one cause over: the server took the commit and answered 202, and then this
 * browser lost the session — the stream was cut and the manifest poll came back "no longer open".
 * The push may well have landed on GitHub; we simply cannot see the answer from here.
 *
 * ⚠ IT MUST NOT SAY IT FAILED AND MUST NOT OFFER A RETRY. A retry is a SECOND PUSH. The only
 * honest thing left to do is name where the answer is, which is the pull request itself.
 */
export const COMMIT_UNCONFIRMED =
  'Your resolution was sent. Check the pull request on GitHub — it’ll show up here shortly.';

export const NOTHING_PUSHED = 'Nothing was pushed.';
export const START_AGAIN = 'Start again';
export const CLOSE_RESOLVER = 'Close';
export const OPEN_COMPARE = 'Open the compare view';

// ── LEAVING ──────────────────────────────────────────────────────────────────────────────────

/** Permanent, in the footer. The retained-decision design is what makes an accidental Escape
 *  survivable, so this replaces the old "nothing here is saved" line rather than sitting beside
 *  it. */
export const DECISIONS_KEPT = 'Your decisions are kept until you reload.';

export const closeConfirmQuestion = (decided: number, total: number): string =>
  `${decided} of ${total} conflicts resolved, nothing pushed. Your choices are kept until you reload.`;
export const KEEP_WORKING = 'Keep working';
export const CLOSE_ANYWAY = 'Close';

/**
 * ⚠ A COUNT, NOT A FRACTION, AND THAT IS DELIBERATE. `ClosedResolver.decidedCount` is every region
 * the reader answered INCLUDING the auto-applied one-sided changes nobody was asked about, while
 * the header's denominator is CONTESTED regions only — pairing the two prints "31 of 8". The
 * overlay can say "6 of 9 conflicts" because it still has the loaded files to fold; the toast
 * outlives them, so it says the one number it actually holds.
 */
export const closedToast = (decided: number): string =>
  `Conflict resolver closed — ${decided} decision${decided === 1 ? '' : 's'} kept, nothing pushed.`;
export const REOPEN = 'Reopen';

/** Said once, when a reopen lands on a model built against different shas: the decisions are not
 *  migrated onto a merge the reader never saw. */
export const BRANCH_MOVED_RESTART = 'The branch moved since you started. Starting again.';
