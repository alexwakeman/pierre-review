import type {
  ConflictDecision,
  ConflictFileEntry,
  ConflictLine,
  ConflictRegion,
  ConflictRegionDecision,
  ConflictWandReason,
} from '@pierre-review/shared';
import { foldFile, type ResolvedDecision } from '@pierre-review/shared';
import { regionKey } from '../store/conflictResolver.js';

// ── THE RESOLVER'S PURE HALF ─────────────────────────────────────────────────────────────────
//
// Everything the three panes compute and nothing they render. Kept out of the components so the
// wand's arithmetic, the counters and the commit serialisation can be tested without a DOM —
// they are the parts that decide what lands in somebody's repository.
//
// ⚠ THE CENTRE PANE FOLDS THROUGH THE SHARED `foldFile`, NOT A SECOND IMPLEMENTATION. There is
// exactly one fold in this product (`packages/shared/src/conflict-fold.ts`) and the land route
// commits through it, so "what you saw is what lands" is structural. A local `centreLines` that
// merely agreed with it today is how the two come apart later.

// ── THE STATE A COLOUR ENCODES ───────────────────────────────────────────────────────────────
//
// ⚠ `ignored` AND `unapplied` PRODUCE THE SAME CENTRE TEXT AND ARE DIFFERENT STATES. Both show
// the ancestor's lines. `unapplied` counts against the reader — it is a region nobody has
// answered — while `ignored` is an answer: keep the ancestor. On the wire `ignored` serialises as
// `'base'` and `unapplied` serialises as NOTHING, which is exactly what the commit route's
// `IncompleteDecisions` catches. Collapsing the two would make the counter lie and would let a
// region nobody chose reach a commit.
export type SlotDecision =
  | { kind: 'unapplied' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'both-lr' }
  | { kind: 'both-rl' }
  | { kind: 'ignored' }
  | { kind: 'wand'; lines: string[] }
  | { kind: 'ai'; suggestionId: string; lines: string[] }
  /** The reader typed this region's result themselves. The lines are the SERVER's copy, echoed
   *  back when it stored them, so the pane renders exactly what the commit will splice. */
  | { kind: 'edit'; editId: string; lines: string[] };

/** The four semantic colours. One role per state; `index.css` owns the values. */
export type SlotRole = 'change' | 'conflict' | 'applied' | 'ignored' | null;

/** `SlotDecision.kind` → the wire enum. `unapplied` has no member, by design. */
const WIRE_BY_KIND: Record<Exclude<SlotDecision['kind'], 'unapplied'>, ConflictDecision> = {
  left: 'ours',
  right: 'theirs',
  'both-lr': 'both_ours_first',
  'both-rl': 'both_theirs_first',
  ignored: 'base',
  wand: 'disjoint_merge',
  ai: 'suggestion',
  edit: 'edited',
};

/** The wire enum → `SlotDecision.kind`, for reading the store back. The three payload-bearing
 *  members need their lines attaching by the caller, which is why this is not the whole job. */
const KIND_BY_WIRE: Record<ConflictDecision, Exclude<SlotDecision['kind'], 'unapplied'>> = {
  ours: 'left',
  theirs: 'right',
  both_ours_first: 'both-lr',
  both_theirs_first: 'both-rl',
  base: 'ignored',
  disjoint_merge: 'wand',
  suggestion: 'ai',
  edited: 'edit',
};

export function wireDecisionFor(slot: SlotDecision): ConflictDecision | null {
  return slot.kind === 'unapplied' ? null : WIRE_BY_KIND[slot.kind];
}

/**
 * Where the two handle-addressed decisions' handles and lines live.
 *
 * ⚠ ONE PARAMETER OBJECT RATHER THAN FOUR POSITIONAL ARGUMENTS, and every field optional: a
 * caller that holds none of it (every test of the deterministic members, for one) passes `{}`.
 * The store holds the HANDLES; the LINES come from the hooks' module maps, which is the split
 * `store/conflictResolver.ts`'s header insists on.
 */
export interface HeldRegionText {
  /** `${fileIndex}:${regionId}` → an accepted Pro suggestion's handle. */
  suggestionIds?: Readonly<Record<string, string>> | undefined;
  /** `suggestionId` → its lines. */
  suggestionLines?: Readonly<Record<string, string[]>> | undefined;
  /** `${fileIndex}:${regionId}` → a saved manual edit's handle. */
  editIds?: Readonly<Record<string, string>> | undefined;
  /** `editId` → its lines, as the SERVER split them. */
  editLines?: Readonly<Record<string, string[]>> | undefined;
}

/**
 * Read one region's state out of the stored decisions.
 *
 * ⚠ A HANDLE WITHOUT ITS LINES DEGRADES TO `unapplied`, FOR BOTH MEMBERS. The store deliberately
 * holds neither the suggestion's text nor the reader's own, so a decision whose lines are not to
 * hand is one this pane cannot honestly draw — and drawing the ancestor instead, while the
 * counter says decided and the commit still carries the handle, is the what-you-saw-is-not-what-
 * lands failure this whole screen exists to prevent. Degrading is visible: the region reads
 * "Needs a decision" and the reader is asked again.
 */
export function slotFor(
  region: ConflictRegion,
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
  held: HeldRegionText,
): SlotDecision {
  const rk = regionKey(fileIndex, region.id);
  const wire = decisions[rk];
  if (wire == null) return { kind: 'unapplied' };
  const kind = KIND_BY_WIRE[wire];
  if (kind === 'wand') {
    // ⚠ THE SERVER'S BYTES, NEVER A LOCAL RECOMPUTATION. `region.mergedLines` is the array
    // `land.ts` splices; the SPA used to run its own word merge here and the two were not the
    // same algorithm (see the ⚠ on `ConflictRegion.mergedLines`). A null degrades to undecided
    // rather than rendering the ancestor while the commit lands a merge.
    const lines = region.mergedLines;
    return lines == null ? { kind: 'unapplied' } : { kind: 'wand', lines };
  }
  if (kind === 'ai') {
    const id = held.suggestionIds?.[rk];
    const lines = id != null ? held.suggestionLines?.[id] : undefined;
    if (id == null || lines == null) return { kind: 'unapplied' };
    return { kind: 'ai', suggestionId: id, lines };
  }
  if (kind === 'edit') {
    const id = held.editIds?.[rk];
    const lines = id != null ? held.editLines?.[id] : undefined;
    if (id == null || lines == null) return { kind: 'unapplied' };
    return { kind: 'edit', editId: id, lines };
  }
  return { kind };
}

/**
 * The region's STATE, in one of the four colours. `unchanged` wears none.
 *
 * ⚠ THIS IS THE STATE ROLE AND IT IS NOT THE PANE'S PAINT. It drives the strip's ink and the
 * centre cell's 2px rule — the two encodings that must keep working for every state, including the
 * undecided one where the centre now carries no wash at all. What a given PANE paints is
 * `panePaint` below, and the two still disagree: this role is a fact about the REGION and exists
 * for every state, while a pane's paint also depends on whether that pane is offering anything and
 * whether its lines were taken.
 */
export function slotRole(region: ConflictRegion, slot: SlotDecision): SlotRole {
  if (region.kind === 'unchanged') return null;
  if (slot.kind === 'unapplied') return region.kind === 'conflict' ? 'conflict' : 'change';
  if (slot.kind === 'ignored') return 'ignored';
  return 'applied';
}

// ── WHAT EACH PANE PAINTS ────────────────────────────────────────────────────────────────────
//
// ⚠ PAINT ON A SIDE MEANS "THERE IS A DECISION TO TAKE HERE", AND NOTHING ELSE.
//
//   A SIDE is painted ONLY while it is offering the reader something — `region.allowed` names the
//   decision that pane's button would send (`'ours'` on the left, `'theirs'` on the right), and a
//   pane whose decision is not in that list is offering nothing. Per kind: `unchanged` paints
//   neither, `ours_only` the left, `theirs_only` the right, `both_same` THE LEFT ONLY, and a
//   `conflict` both.
//
//   ⚠ `both_same` IS THE ONE THAT LOOKS LIKE AN EXCEPTION AND IS NOT. Both branches made the same
//   edit, so the model offers `['ours', 'base']` and there is nothing on the right to bring in.
//   The right pane's identical copy therefore sits there as ordinary unpainted text. This replaces
//   an earlier rule that painted every non-`unchanged` region on BOTH sides, which put a blue wash
//   over main's "nothing here" filler hatch and invited a click that no control existed for.
//
//   ⚠ THE GUTTER ARROW USES THE SAME TEST — `sideOffered` below is the one spelling of it, so a
//   painted side and an available arrow cannot come apart.
//
//   ⚠ `.mr-filler`'s 45° hatch IS NOT PAINT AND STAYS. It says "this side has no lines here",
//   which is a different fact from "there is something here to take", and with the wash gone from
//   an unofferable side it carries that fact alone.
//
//   THE HUE ON A SIDE IS THE CONFLICT TYPE ONLY WHILE THE REGION IS UNDECIDED. Once the reader has
//   answered, a side that went into the result turns GREEN — the same `applied` green as the
//   centre, because it is now a piece of the result rather than one of two offers. A side the
//   decision turned down loses its paint entirely.
//
//   ⚠ THIS REVERSES AN EARLIER RULE, DELIBERATELY. A side used to keep its conflict type for the
//   life of the region ("a side is a piece of somebody's branch; a decision does not change what it
//   is") and a turned-down side dropped to a 1px outline in the same hue. On screen that left a red
//   block feeding a green block with a red ribbon between them, all three describing one accepted
//   change. The outline family is deleted (see `copy.ts` and `index.css`): rejected and ignored now
//   paint nothing, and `.mr-filler` plus the strip's word carry what is left.
//
//   The CENTRE is UNCHANGED: nothing while the region is undecided, then applied or ignored.
//   ⚠ AN UNDECIDED CENTRE HAS NO WASH AT ALL. Nothing is put into the result before the reader
//   presses something, so the result pane must not open wearing colour for changes nobody has
//   accepted. Its remaining two encodings are the 2px rule (still in the state's ink, so `ignored`
//   and `unapplied` still read apart) and the strip's word.

export type SlotPane = 'left' | 'centre' | 'right';

/** The two hues a SIDE can wear while the region is UNDECIDED. Both are conflict types; neither is
 *  a state. After a decision a side is green or it is bare. */
export type SideRole = 'change' | 'conflict';

/** One pane's paint for one region: a role, or nothing at all.
 *  ⚠ A ROLE, NOT AN OBJECT WITH A `filled` FLAG. The flag existed for the outline a turned-down
 *  side wore; nothing is outlined any more, so the second arm would be a shape no caller can
 *  produce. */
export type PanePaint = Exclude<SlotRole, null>;

/** The decision each side's own button sends. */
const SIDE_DECISION: Record<'left' | 'right', ConflictDecision> = {
  left: 'ours',
  right: 'theirs',
};

/**
 * Is there anything on this side to bring in?
 *
 * ⚠ THE TEST IS `region.allowed`, WHICH THE SERVER ALREADY DECIDED (`allowedDecisions` in
 * `conflict/model.ts`). A second rule keyed on `region.kind` would be a copy of that switch living
 * one repository away from it, free to disagree. Both the wash and the gutter arrow go through
 * here, so a pane can never be painted as a choice it cannot offer.
 */
export function sideOffered(region: ConflictRegion, pane: 'left' | 'right'): boolean {
  return region.allowed.includes(SIDE_DECISION[pane]);
}

/**
 * What became of one side's lines.
 *
 * ⚠ THREE OUTCOMES, NOT A BOOLEAN. Its predecessor answered "may this side keep its wash?" and
 * returned TRUE for both sides of an UNDECIDED region — two different facts ("nobody has answered"
 * and "this side is in the result") behind one `true`, which `ribbonSides` then had to unpick with
 * a guard of its own. The three states now paint three different things: the conflict type, the
 * applied green, and nothing.
 */
export type SideOutcome = 'undecided' | 'contributed' | 'rejected';

export function sideOutcome(slot: SlotDecision, pane: 'left' | 'right'): SideOutcome {
  switch (slot.kind) {
    case 'unapplied':
      return 'undecided';
    // Keeping the ancestor takes NEITHER side.
    case 'ignored':
      return 'rejected';
    // ⚠ NEITHER DOES THE READER'S OWN TEXT, AND THAT IS THE DECISION RATHER THAN A CONSEQUENCE
    // OF ONE. An edit usually starts from whatever the centre was showing, so a side often did
    // contribute most of the characters — but nothing here knows how much, and a correspondence
    // we cannot state is one we must not draw. So both sides go bare and the region draws no
    // ribbon; what the centre holds came from the reader, and the strip's word is where that is
    // said. The alternative — painting the side the edit was seeded from — would claim a
    // provenance for text somebody may have replaced entirely.
    case 'edit':
      return 'rejected';
    case 'left':
      return pane === 'left' ? 'contributed' : 'rejected';
    case 'right':
      return pane === 'right' ? 'contributed' : 'rejected';
    // Both taken in some order, the wand's word merge, an accepted suggestion: content from both
    // sides reached the result.
    case 'both-lr':
    case 'both-rl':
    case 'wand':
    case 'ai':
      return 'contributed';
  }
}

export function panePaint(
  region: ConflictRegion,
  slot: SlotDecision,
  pane: SlotPane,
): PanePaint | null {
  if (region.kind === 'unchanged') return null;
  if (pane === 'centre') {
    if (slot.kind === 'unapplied') return null;
    // An edited centre wears the APPLIED green like any other answered region: something is in
    // the result and the reader put it there. What tells it apart from a taken side is the two
    // bare side panes beside it, the missing ribbon, and the strip's word.
    return slot.kind === 'ignored' ? 'ignored' : 'applied';
  }
  if (!sideOffered(region, pane)) return null;
  switch (sideOutcome(slot, pane)) {
    case 'contributed':
      return 'applied';
    case 'rejected':
      return null;
    case 'undecided': {
      const undecided: SideRole = region.kind === 'conflict' ? 'conflict' : 'change';
      return undecided;
    }
  }
}

// ── WHICH SIDES THE RIBBON JOINS ─────────────────────────────────────────────────────────────

/** The two panes a ribbon can start from. The centre is always its other end. */
export type RibbonSide = 'left' | 'right';

const NO_SIDES: readonly RibbonSide[] = Object.freeze([]);
const LEFT_ONLY: readonly RibbonSide[] = Object.freeze(['left'] as const);
const RIGHT_ONLY: readonly RibbonSide[] = Object.freeze(['right'] as const);
const BOTH_SIDES: readonly RibbonSide[] = Object.freeze(['left', 'right'] as const);

/**
 * Which sides actually PUT CONTENT INTO THE RESULT for this region — the only thing a ribbon is
 * allowed to claim.
 *
 * ⚠ IT IS `sideOutcome(...) === 'contributed'` AND THE SAME `sideOffered` GATE `panePaint` OPENS
 * WITH. It used to need a guard of its own because its helper returned `true` for both sides of an
 * undecided region; with three honest outcomes the ribbon rule and the paint rule read the same
 * answer, so a ribbon leaving a side the wash says was turned down is not expressible.
 *
 * ⚠ THE `sideOffered` HALF IS NOT REDUNDANT TODAY AND MUST STAY. `sideOutcome` answers
 * `'contributed'` for BOTH sides of a both-order, a wand merge and an accepted suggestion without
 * asking whether each side is offered at all — so the pair agrees only because
 * `allowedDecisions` happens never to offer a both-order on a kind that withholds a side. Give
 * `both_same` a `both_ours_first` tomorrow and, without this, a ribbon would be drawn out of an
 * UNPAINTED right pane. Reachability is not an invariant; the shared gate is.
 *
 * ⚠ `ignored` AND `unapplied` BOTH DRAW NOTHING, and they stay different states for the reason
 * `SlotDecision`'s header gives (`ignored` serialises as `'base'`, `unapplied` as nothing). Neither
 * put a side's lines in the result, so neither has a linkage to draw; the counter still needs them
 * apart.
 *
 * ⚠ AND NEITHER DOES `edit`, WHICH IS THE ONE STATE WHERE THE CENTRE IS GREEN AND NO RIBBON
 * LEAVES IT. That asymmetry is deliberate and is the picture: a ribbon says "these lines came
 * from there", and the reader's own text came from neither pane. `sideOutcome` answers
 * `'rejected'` on both sides for exactly this, so the wash and the ribbon still read one answer.
 */
export function ribbonSides(region: ConflictRegion, slot: SlotDecision): readonly RibbonSide[] {
  if (region.kind === 'unchanged') return NO_SIDES;
  const left = sideOffered(region, 'left') && sideOutcome(slot, 'left') === 'contributed';
  const right = sideOffered(region, 'right') && sideOutcome(slot, 'right') === 'contributed';
  if (left && right) return BOTH_SIDES;
  if (left) return LEFT_ONLY;
  if (right) return RIGHT_ONLY;
  return NO_SIDES;
}

// ── `ribbonHue` — RETIRED, AND WHY ITS ARGUMENT NO LONGER HOLDS ──────────────────────────────
//
// A ribbon used to wear the REGION'S TYPE on the reasoning that "a ribbon exists only because a
// decision was taken, so keying it on the state would make every ribbon `applied` and the hue would
// carry nothing". That is still true — and it is now the correct outcome rather than the objection.
// A ribbon joins an ACCEPTED side to the result it produced, and an accepted side is green (see
// `panePaint`), so a type-hued band between two green blocks was the one discontinuity in the row.
// Every ribbon is green, `copy.ts`'s `FILL_CLASS` is a single class rather than a lookup, and the
// hue carries nothing because the two blocks it joins already carry everything.

// ⚠ NOTHING ELSE MAY REINTRODUCE A PER-REGION RIBBON COLOUR. The linkage is readable because it is
// continuous with what it joins; a second hue in the gutter is a fifth encoding of a state three
// already carry.

// ── THE CENTRE TEXT ──────────────────────────────────────────────────────────────────────────

const LINE_TEXT = (l: ConflictLine): string => l.text;

/** The three slot kinds that carry their own lines → the wire member the fold expects. */
const PAYLOAD_DECISION: Record<
  'wand' | 'ai' | 'edit',
  'disjoint_merge' | 'suggestion' | 'edited'
> = { wand: 'disjoint_merge', ai: 'suggestion', edit: 'edited' };

/**
 * What the centre pane shows for ONE region.
 *
 * ⚠ IT CALLS THE SHARED FOLD, ONE REGION AT A TIME. Folding the whole file and then cutting it
 * back into regions would need a second mapping that the fold does not publish; folding a
 * one-region file gives the same bytes with no second rule. The terminators passed in are a
 * placeholder because a per-region call reads `lines` only — the file's real terminator is the
 * LAST region's business and the land route's, not a cell's.
 */
export function centreLines(region: ConflictRegion, slot: SlotDecision): string[] {
  if (region.kind === 'unchanged' || slot.kind === 'unapplied') return region.base.map(LINE_TEXT);
  const wire = wireDecisionFor(slot);
  if (wire == null) return region.base.map(LINE_TEXT);
  const resolved: ResolvedDecision =
    slot.kind === 'wand' || slot.kind === 'ai' || slot.kind === 'edit'
      ? {
          // The three payload-bearing members, each rendering the lines the CALLER handed in —
          // the server's stored word merge, the server's stored suggestion, the server's stored
          // copy of what the reader typed. Nothing here is recomputed.
          decision: PAYLOAD_DECISION[slot.kind],
          lines: slot.lines,
          // A per-region call reads `lines` only; the file's real terminator is the LAST
          // region's business and the land route's, not a cell's.
          endsWithNewline: true,
        }
      : { decision: wire as Exclude<ConflictDecision, 'disjoint_merge' | 'suggestion' | 'edited'> };
  const result = foldFile(
    {
      regions: [
        {
          id: region.id,
          kind: region.kind,
          base: region.base.map(LINE_TEXT),
          ours: region.ours.map(LINE_TEXT),
          theirs: region.theirs.map(LINE_TEXT),
        },
      ],
      terminators: { base: true, ours: true, theirs: true },
    },
    new Map([[region.id, resolved]]),
  );
  // A refusal here means the decision is not one this kind allows — the UI only ever offers
  // `region.allowed`, so this is the belt to that braces. Showing the ancestor is the honest
  // fallback: it is what an undecided region shows, and it claims nothing.
  return result.ok ? result.lines : region.base.map(LINE_TEXT);
}

// ── THE WAND ─────────────────────────────────────────────────────────────────────────────────

export interface WandMove {
  fileIndex: number;
  regionId: number;
  decision: ConflictDecision;
  reason: ConflictWandReason;
}

export interface WandPlan {
  moves: WandMove[];
  /** Regions where only one side changed anything (including `both_same`). */
  changesApplied: number;
  /** Contested regions the wand merged because the two edits are provably word-disjoint. */
  conflictsResolved: number;
  /** Contested regions still undecided after this run. */
  conflictsLeft: number;
  /** Whether anything in this file was already decided before the run — the difference between
   *  "the wand could do nothing here" and "the wand could do nothing MORE here". */
  alreadyDecided: number;
}

/**
 * What the wand would do to ONE file, right now.
 *
 * ⚠ IT NEVER PICKS A SIDE ON A CONTESTED REGION, AND THAT IS THE WHOLE PROMISE. The only
 * contested regions it touches are the ones the server proved word-disjoint — two edits that do
 * not overlap, merged mechanically. If this ever grows a "take the longer one" or "prefer ours"
 * branch, the sentence it prints stops being true, and `mergeResolver.test.ts` is the assertion
 * that breaks.
 *
 * ⚠ A DECISION THE READER ALREADY MADE IS NEVER OVERWRITTEN. The wand is an accelerator, not a
 * reset; running it twice must not repeat the first run's numbers either, which falls out of the
 * same rule.
 */
export function wandPlan(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
): WandPlan {
  const moves: WandMove[] = [];
  let changesApplied = 0;
  let conflictsResolved = 0;
  let conflictsLeft = 0;
  let alreadyDecided = 0;

  for (const region of regions) {
    if (region.kind === 'unchanged') continue;
    const decided = decisions[regionKey(fileIndex, region.id)] != null;
    if (decided) {
      alreadyDecided += 1;
      continue;
    }
    const wand = region.wand;
    if (wand == null) {
      if (region.kind === 'conflict') conflictsLeft += 1;
      continue;
    }
    if (region.kind === 'conflict') {
      // The defensive half of the promise above: a contested region is only ever merged, never
      // decided in somebody's favour, whatever the server sent.
      if (wand.reason !== 'disjoint_words' || wand.decision !== 'disjoint_merge') {
        conflictsLeft += 1;
        continue;
      }
      conflictsResolved += 1;
    } else {
      changesApplied += 1;
    }
    moves.push({ fileIndex, regionId: region.id, decision: wand.decision, reason: wand.reason });
  }

  return { moves, changesApplied, conflictsResolved, conflictsLeft, alreadyDecided };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What the wand just did, in its own words. ABOUT THIS RUN ONLY — running it a second time on a
 * file it already settled must not repeat the first run's numbers, which is why the counts come
 * off the plan rather than off the file.
 *
 * A clause with a zero count is DROPPED rather than printed as "0 changes applied": a zero in a
 * sentence reads as a failure, and the tail already says what is left.
 */
export function wandSentence(plan: WandPlan): string {
  const clauses: string[] = [];
  if (plan.changesApplied > 0) clauses.push(`${plural(plan.changesApplied, 'change', 'changes')} applied`);
  if (plan.conflictsResolved > 0) {
    clauses.push(`${plural(plan.conflictsResolved, 'conflict', 'conflicts')} resolved`);
  }
  // ⚠ THIS SENTENCE IS ABOUT ONE FILE AND MUST SAY SO. The wand runs per FILE and counts CONTESTED
  // regions; the header counts every DECIDABLE region across the whole pull request — so a bare
  // "Nothing left to decide." sat beside a countdown at a different grain and the two flatly
  // contradicted each other on screen. Two numbers at two grains, neither naming its own
  // population.
  if (clauses.length > 0) {
    if (plan.conflictsLeft > 0) return `${clauses.join(', ')}, ${plan.conflictsLeft} left.`;
    return `${clauses.join(', ')}. Nothing left to decide in this file.`;
  }
  if (plan.conflictsLeft === 0) return 'Nothing left to decide in this file.';
  // Nothing was applied. Whether the honest sentence is "every one of these needs you" or "these
  // are what is left" depends on whether the reader had already answered some of them.
  if (plan.alreadyDecided === 0) return 'Every change here needs a decision.';
  return `${plural(plan.conflictsLeft, 'conflict', 'conflicts')} left to decide.`;
}

// ── THE WHOLE-FILE TAKES ─────────────────────────────────────────────────────────────────────
//
// "Take your file" / "Take main's file": make the result one branch's version of the WHOLE file,
// in one press and one undo step.
//
// ⚠ THIS IS NOT THE WAND, AND IT DOES NOT BEND THE WAND'S PROMISE. The wand never picks a side
// because it acts on the reader's behalf; this is the reader picking one, for a whole file, on a
// button carrying the branch's name. Nothing runs it but that press — it is not an auto-apply.
//
// ⚠ "YOUR FILE" IS NOT `'ours'` ON EVERY REGION. `region.allowed` offers a side only where that
// side has something to bring in, so:
//   • a region only the OTHER branch changed is, on this side, still the ANCESTOR → `'base'`;
//   • `both_same` (the identical edit on both branches) offers `['ours', 'base']` and nothing on the
//     right, so "main's file" takes `'ours'` — the one member carrying main's text too. Falling
//     through to `'base'` there would silently drop an edit main ALSO made, and the result would
//     be neither branch's file. `mergeResolver.test.ts` folds every kind through `centreLines` to
//     pin that the result IS the side's text, not just that some decision was written.
//
// ⚠ IT OVERWRITES WHAT THE READER ALREADY DECIDED IN THIS FILE, a hand-typed edit or an accepted
// suggestion included. It is a whole-file answer; the undo stack takes the whole press back.

export type WholeFileSide = 'ours' | 'theirs';

/** The one decision that makes this region read as `side`'s version of it. Null for `unchanged`
 *  (nothing to decide) and for a region offering no route to it, which the model never builds. */
export function wholeFileDecisionFor(
  region: ConflictRegion,
  side: WholeFileSide,
): ConflictDecision | null {
  if (region.kind === 'unchanged') return null;
  if (region.allowed.includes(side)) return side;
  // Both branches made the same edit: `ours` IS the other side's text. See the ⚠ above.
  if (region.kind === 'both_same' && region.allowed.includes('ours')) return 'ours';
  // Only the other branch changed this, so this side's version is the ancestor.
  if (region.allowed.includes('base')) return 'base';
  return null;
}

export interface WholeFilePlan {
  /** Only the regions whose decision CHANGES — an empty list means the file already reads as
   *  that side's version, and the button has nothing to do. */
  moves: Array<{ fileIndex: number; regionId: number; decision: ConflictDecision }>;
}

export function wholeFilePlan(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
  side: WholeFileSide,
): WholeFilePlan {
  const moves: WholeFilePlan['moves'] = [];
  for (const region of regions) {
    const decision = wholeFileDecisionFor(region, side);
    if (decision == null) continue;
    if (decisions[regionKey(fileIndex, region.id)] === decision) continue;
    moves.push({ fileIndex, regionId: region.id, decision });
  }
  return { moves };
}

// ── COUNTERS ─────────────────────────────────────────────────────────────────────────────────

export interface FileTally {
  /** Regions that take a decision — every kind except `unchanged`. */
  decidable: number;
  decided: number;
  conflicts: number;
  conflictsDecided: number;
}

export function tallyFile(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
): FileTally {
  let decidable = 0;
  let decided = 0;
  let conflicts = 0;
  let conflictsDecided = 0;
  for (const region of regions) {
    if (region.kind === 'unchanged') continue;
    decidable += 1;
    const isDecided = decisions[regionKey(fileIndex, region.id)] != null;
    if (isDecided) decided += 1;
    if (region.kind === 'conflict') {
      conflicts += 1;
      if (isDecided) conflictsDecided += 1;
    }
  }
  return { decidable, decided, conflicts, conflictsDecided };
}

// ── `conflictsDecidedAcross` — RETIRED ───────────────────────────────────────────────────────
//
// It counted CONTESTED regions only, which was the honest pairing while one-sided changes were
// auto-applied and nobody was being asked about them. Now every decidable region is the reader's
// to answer and the commit is blocked until they all are, so a header reading "3 of 3 conflicts
// decided" over a blocked commit is the two-surfaces-disagree defect this file keeps warning
// about. ONE number lives in the overlay now and it is `CommitPlan.decidedTotal` /
// `decidableTotal` — the gate's own population, folded once in `lib/conflictCommit.ts`.

// ── THE FILE MENU'S ROW STATE ────────────────────────────────────────────────────────────────

export type FileRowState = 'unsupported' | 'resolved' | 'partial' | 'conflicts';

/** The fallback under an unresolvable file when the SERVER sent no noun phrase of its own.
 *  ⚠ ONE DECLARATION. It was spelled three times — here, in `lib/conflictCommit.ts` and in
 *  `components/conflicts/copy.ts` — which is three chances for one sentence to drift into two.
 *  It lives in `lib/` rather than `copy.ts` because the two folds that need it are libraries and
 *  a library may not import from `components/`. */
export const CANT_RESOLVE_HERE = 'Can’t be resolved here';

/** How many regions in a file still take a decision. ⚠ ONE DECLARATION, for the same reason as
 *  `CANT_RESOLVE_HERE` above: the file menu's rows and the landing step's "Still to decide" list
 *  say the same thing about the same file, and two spellings is one phrase drifting into two.
 *  `copy.ts` re-exports it. */
export const toDecide = (n: number): string => `${n} to decide`;

/** A supported file with no region anybody can answer. It neither ships nor blocks. */
export const NOTHING_TO_DECIDE = 'Nothing to decide';

/**
 * One row's state and the words on it.
 *
 * ⚠ THERE IS NO "NEEDS A HAND" STATE. A file the model cannot represent is simply unsupported,
 * with the server's own noun phrase beside it; inventing a fourth, softer state for the same fact
 * gives the reader two things to learn where there is one.
 */
export function fileRowState(
  entry: ConflictFileEntry,
  tally: FileTally | null,
): { state: FileRowState; label: string } {
  if (entry.unsupported != null) {
    return { state: 'unsupported', label: entry.unsupportedLabel ?? CANT_RESOLVE_HERE };
  }
  // ⚠ AN UNOPENED ROW COUNTS `decidableCount`, NOT `conflictCount`. A file with no contested
  // regions and four one-sided changes used to read "Not opened yet" with no number at all, while
  // blocking the commit on four decisions nobody had made.
  if (tally == null) {
    if (entry.decidableCount === 0) return { state: 'conflicts', label: NOTHING_TO_DECIDE };
    return { state: 'conflicts', label: toDecide(entry.decidableCount) };
  }
  // ⚠ `decidable === 0` IS NOT "Resolved", and `>=` alone would say it was. `commitPlan`'s
  // classifier requires `decidable > 0` before a file goes on the wire, so a bare `0 >= 0` here
  // would tick a file off in the menu that the landing step then lists under "Still conflicted"
  // — two surfaces disagreeing about one file.
  if (tally.decidable === 0) return { state: 'conflicts', label: NOTHING_TO_DECIDE };
  if (tally.decided >= tally.decidable) return { state: 'resolved', label: 'Resolved' };
  if (tally.decided > 0) {
    return { state: 'partial', label: `${tally.decided} of ${tally.decidable} decided` };
  }
  // ⚠ THE SAME POPULATION AS THE ROW ABOVE IT. This used to count CONTESTED regions ("2
  // conflicts") beside a file holding three decisions, which understated what the commit gate
  // would hold out for.
  return { state: 'conflicts', label: toDecide(tally.decidable) };
}

// ── THE COMMIT WIRE ──────────────────────────────────────────────────────────────────────────

/**
 * One file's decisions in the shape `POST …/conflicts/commit` takes.
 *
 * ⚠ AN UNDECIDED REGION IS OMITTED, NEVER DEFAULTED. The server answers `IncompleteDecisions` and
 * names the region; that is the point. A client that helpfully filled the gap with `'base'` would
 * be committing a line of code nobody chose, and it would do it silently.
 */
export function serializeFileDecisions(
  regions: readonly ConflictRegion[],
  fileIndex: number,
  decisions: Readonly<Record<string, ConflictDecision>>,
  suggestionIds: Readonly<Record<string, string>>,
  editIds: Readonly<Record<string, string>> = {},
): ConflictRegionDecision[] {
  const out: ConflictRegionDecision[] = [];
  for (const region of regions) {
    if (region.kind === 'unchanged') continue;
    const rk = regionKey(fileIndex, region.id);
    const decision = decisions[rk];
    if (decision == null) continue;
    // ⚠ A HANDLE-BEARING DECISION WITH NO HANDLE IS DROPPED, NOT SENT BARE. The server would
    // answer `UnknownSuggestion` / `UnknownEdit` and refuse the WHOLE commit; omitting it makes
    // the same region `IncompleteDecisions` instead, which names the file and sends the reader
    // somewhere they can act. Neither is reachable while the store keeps the two in step — this
    // is the belt to that braces.
    const suggestionId = decision === 'suggestion' ? suggestionIds[rk] : undefined;
    if (decision === 'suggestion' && suggestionId == null) continue;
    const editId = decision === 'edited' ? editIds[rk] : undefined;
    if (decision === 'edited' && editId == null) continue;
    if (suggestionId != null) out.push({ id: region.id, decision, suggestionId });
    else if (editId != null) out.push({ id: region.id, decision, editId });
    else out.push({ id: region.id, decision });
  }
  return out;
}

// ── THE AUTO-APPLY PASS — DELETED, AND IT MUST NOT COME BACK ─────────────────────────────────
//
// `autoApplyMoves` used to write every one-sided region's own side into the store the moment a
// file's regions arrived, so the centre pane opened already green. NOTHING IS APPLIED BEFORE THE
// READER PRESSES SOMETHING now: the session opens with `autoApply: false`, every region starts at
// `base`, and the centre pane carries no wash until a decision puts something in it.
//
// ⚠ THE SERVER KNOB STAYS. `ConflictOpenBody.autoApply` and `defaultDecisionFor` are untouched —
// what changed is which value the SPA sends, not what the protocol can express.

// ── THE DETERMINISTIC WORD MERGE — DELETED, AND IT MUST NOT COME BACK ────────────────────────
//
// The wand's word-level merge for a contested region used to be recomputed here (tokenise into
// word / whitespace / single-character runs, Myers-diff each side against the ancestor, chunk the
// two diffs, concatenate) on the strength of a wire comment saying the payload was unnecessary
// because "the server recomputes it from the same word diff".
//
// ⚠ THE SERVER RECOMPUTES NOTHING. It stores what it computed at model build and `land.ts`
// splices that array. Two implementations of one fold is exactly the defect
// `packages/shared/src/conflict-fold.ts` exists to prevent, and cross-checking the pair over
// 4,000 generated three-way regions found the client dropped every pure INSERTION — the centre
// pane rendered the ANCESTOR for a region the commit landed MERGED, with the header counting it
// as resolved. The lines now ride the wire on `ConflictRegion.mergedLines` and `slotFor` reads
// them; nothing in the SPA may compute merged bytes again.
