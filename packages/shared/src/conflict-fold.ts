import type { ConflictFileTerminators, ConflictRegionKind } from './conflicts.js';

/**
 * THE fold. Pure, no I/O, no git. The centre pane renders through it and the land route
 * commits through it, so "what you saw is what lands" is structural rather than a promise.
 *
 * ⚠ CONFLICT_MODEL_VERSION IS FOLDED INTO THE MODEL HASH. Any change to this function's
 * output for a given input is a fold change and MUST bump it in the same commit — the same
 * discipline as PERIOD_METRICS_SCHEMA_VERSION. The failure is silent: a stale session lands
 * bytes the user did not choose.
 *
 * THE RULES, which are decisions and not options:
 *
 *  1. `unchanged` regions emit `base` and take no decision.
 *  2. Every OTHER region must carry a decision — including `ours_only`, `theirs_only` and
 *     `both_same`. The reader can apply and un-apply those, so a missing decision is
 *     `undecided_region`, never a silent default. A silently defaulted region is a line of
 *     code nobody chose.
 *  3. `'base'` on a one-sided region means "don't apply that change"; on a contested region
 *     it means "keep the ancestor". Identical bytes, ONE enum member — the UI derives the
 *     LABEL from `region.kind`. A second member for identical output invites a fold that
 *     diverges from itself.
 *  4. THE FILE TERMINATOR belongs to the LAST region's chosen SOURCE: `base`/`ours`/`theirs`
 *     take that side's; `both_ours_first` takes `theirs`; `both_theirs_first` takes `ours`;
 *     `disjoint_merge` and `suggestion` carry their own `endsWithNewline`. Guessing it at
 *     file level appends a newline nobody chose, and it shows up in the PR diff as
 *     "\ No newline at end of file" vanishing on a line the reader never touched.
 *  5. `'disjoint_merge'` carries no payload on the wire; the CALLER resolves it to lines
 *     before calling here — the SPA by recomputing `region.wand`, the server from the
 *     model's stored merge. Both come from the same word diff.
 */
export const CONFLICT_MODEL_VERSION = 1;

/** A decision with everything the fold needs. The two payload-bearing members are resolved
 *  by the caller, because their lines live somewhere this pure function cannot reach. */
export type ResolvedDecision =
  | {
      decision:
        | 'base'
        | 'ours'
        | 'theirs'
        | 'both_ours_first'
        | 'both_theirs_first';
    }
  | {
      decision: 'disjoint_merge' | 'suggestion';
      lines: string[];
      endsWithNewline: boolean;
    };

export interface FoldRegionInput {
  id: number;
  kind: ConflictRegionKind;
  base: string[];
  ours: string[];
  theirs: string[];
}

export interface FoldFileInput {
  regions: FoldRegionInput[];
  terminators: ConflictFileTerminators;
}

export type FoldRefusal =
  | 'undecided_region'
  | 'unknown_region'
  | 'disallowed_decision';

export type FoldResult =
  | { ok: true; lines: string[]; finalNewline: boolean }
  | { ok: false; reason: FoldRefusal; regionId: number | null };

/** Which side's terminator a decision inherits, or null when the decision carries its own. */
function terminatorSideFor(
  decision: ResolvedDecision['decision'],
): keyof ConflictFileTerminators | null {
  switch (decision) {
    case 'base':
      return 'base';
    case 'ours':
      return 'ours';
    case 'theirs':
      return 'theirs';
    // A both-ordering ends with the side written SECOND, so that side's terminator governs.
    case 'both_ours_first':
      return 'theirs';
    case 'both_theirs_first':
      return 'ours';
    default:
      return null;
  }
}

/** True when this decision may be applied to a region of this kind. `unchanged` takes no
 *  decision at all, so it is not listed here — rule 1 handles it before we get this far. */
function isAllowed(kind: ConflictRegionKind, decision: ResolvedDecision['decision']): boolean {
  switch (kind) {
    case 'unchanged':
      return decision === 'base';
    case 'ours_only':
      return decision === 'ours' || decision === 'base';
    case 'theirs_only':
      return decision === 'theirs' || decision === 'base';
    case 'both_same':
      return decision === 'ours' || decision === 'base';
    case 'conflict':
      return true;
  }
}

export function foldFile(
  file: FoldFileInput,
  decisions: ReadonlyMap<number, ResolvedDecision>,
): FoldResult {
  const out: string[] = [];
  // Rule 4: seeded from `base` so a file of nothing but `unchanged` regions — and an empty
  // file, which has no regions at all — still gets the ancestor's terminator rather than a
  // fabricated one.
  let finalNewline = file.terminators.base;

  const seen = new Set<number>();

  for (const region of file.regions) {
    if (region.kind === 'unchanged') {
      // Rule 1. A decision here is harmless but meaningless; the bytes are the same either
      // way, and refusing one would make an over-eager client unable to commit.
      out.push(...region.base);
      finalNewline = file.terminators.base;
      continue;
    }

    const chosen = decisions.get(region.id);
    if (!chosen) return { ok: false, reason: 'undecided_region', regionId: region.id }; // rule 2
    seen.add(region.id);

    if (!isAllowed(region.kind, chosen.decision)) {
      return { ok: false, reason: 'disallowed_decision', regionId: region.id };
    }

    switch (chosen.decision) {
      case 'base':
        out.push(...region.base);
        break;
      case 'ours':
        out.push(...region.ours);
        break;
      case 'theirs':
        out.push(...region.theirs);
        break;
      case 'both_ours_first':
        out.push(...region.ours, ...region.theirs);
        break;
      case 'both_theirs_first':
        out.push(...region.theirs, ...region.ours);
        break;
      case 'disjoint_merge':
      case 'suggestion':
        out.push(...chosen.lines);
        break;
    }

    const side = terminatorSideFor(chosen.decision);
    finalNewline =
      side === null
        ? // rule 4: the payload-bearing members carry their own
          (chosen as Extract<ResolvedDecision, { lines: string[] }>).endsWithNewline
        : file.terminators[side];
  }

  // A decision addressing a region this file does not have means the client is folding a
  // DIFFERENT model than the server holds. Refusing is the whole point of the model hash;
  // this is the second line of that defence, and it names the offending id.
  for (const id of decisions.keys()) {
    if (!seen.has(id) && !file.regions.some((r) => r.id === id)) {
      return { ok: false, reason: 'unknown_region', regionId: id };
    }
  }

  return { ok: true, lines: out, finalNewline };
}

/** `lines.join('\n') + (finalNewline ? '\n' : '')`. The server does
 *  `Buffer.from(foldToText(r), 'utf8')`; every file reaching here decoded STRICTLY as UTF-8
 *  at model build, so this round-trips byte-for-byte. */
export function foldToText(r: Extract<FoldResult, { ok: true }>): string {
  return r.lines.join('\n') + (r.finalNewline ? '\n' : '');
}
