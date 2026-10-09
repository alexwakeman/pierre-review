import type { ConflictAiChoice, ConflictAiConfidence, ConflictDecision } from '@pierre-review/shared';
import { CONFLICT_AI_DECISIONS } from '@pierre-review/shared';
import { config } from '../../config.js';
import { allowedDecisions } from '../../conflict/model.js';
import { storeEdit, type ConflictSessionRecord } from '../../conflict/session.js';
import { editShapeFor, validateConflictEdit } from '../../conflict/suggestion.js';

/**
 * THE GATE BETWEEN CLAUDE'S ANSWER AND THE RESOLVER — every choice the agent submits passes
 * through here or it does not exist.
 *
 * ⚠ THE AGENT NAMES REGIONS, NEVER BYTES OUTSIDE THEM. A choice is `(file index, region id,
 * fingerprint, decision)`; the fingerprint is the CONTENT pin beside the id's ADDRESS, exactly as
 * on `POST …/conflicts/edit`. A choice for a region the run was not SHOWN (`offered`) is refused
 * too: a region cut by the prompt budget is left for the reader, not guessed at blind.
 *
 * ⚠ AN `'edited'` CHOICE GOES THROUGH THE READER'S OWN VALIDATOR — `validateConflictEdit` with the
 * region's inherited shape (`editShapeFor`), then `storeEdit` mints the handle. The SAME rules a
 * hand-typed edit meets: text-ness, no surviving conflict marker, `conflictSuggestMaxChars`, and
 * the session's typed-text budget. Model output does not get a softer door than a person does.
 *
 * ⚠ `'suggestion'` IS NEVER CLAUDE'S. That member addresses the Pro per-hunk store; an agent
 * choice is either an enum member the region ALLOWS (`region.allowed`) or `'edited'`.
 */

/** What the agent sends for one region. Loosely typed: it came off a tool call. */
export interface AiChoiceInput {
  file: number;
  region: number;
  fingerprint: string;
  decision: string;
  /** Required iff `decision === 'edited'`: the region's result, one entry per line, no
   *  terminators. */
  lines?: string[] | null;
  rationale?: string | null;
  confidence?: string | null;
}

export type AiChoiceRefusal =
  | 'unknown_region'
  | 'not_decidable'
  | 'not_offered'
  | 'moved'
  | 'not_allowed'
  | 'no_lines'
  | 'not_text'
  | 'markers'
  | 'too_long'
  | 'too_many_edits';

/** What the agent is told about a refusal, so it can fix the choice and submit it again. */
export const AI_CHOICE_REFUSAL_TEXT: Record<AiChoiceRefusal, string> = {
  unknown_region: 'no such file/region in this session',
  not_decidable: 'that region is unchanged context and takes no decision',
  not_offered: 'that region was not shown to you; leave it for the person',
  moved: 'fingerprint does not match the region; copy it exactly',
  not_allowed: 'that decision is not offered for this region',
  no_lines: "an 'edited' decision needs `lines`",
  not_text: 'the lines contain characters that cannot be saved to a file',
  markers: 'the lines still contain conflict markers',
  too_long: `an edited region can be at most ${config.conflictSuggestMaxChars} characters`,
  too_many_edits: 'too much edited text in this session; prefer taking a side',
};

export interface AiChoiceRejection {
  file: number;
  region: number;
  refusal: AiChoiceRefusal;
}

const RATIONALE_MAX = 280;

/** One line, trimmed and clipped. Model prose is rendered as plain text, never markup. */
export function clipRationale(raw: string | null | undefined): string {
  const one = (raw ?? '').replace(/\s+/g, ' ').trim();
  return one.length > RATIONALE_MAX ? `${one.slice(0, RATIONALE_MAX - 1)}…` : one;
}

function confidenceOf(raw: string | null | undefined): ConflictAiConfidence {
  return raw === 'high' || raw === 'low' ? raw : 'medium';
}

/** `${file}:${region}` — the resolver's own region key. */
export const choiceKey = (file: number, region: number): string => `${file}:${region}`;

/**
 * Validate a batch of choices against the session and fold the accepted ones into `accepted`
 * (keyed `${file}:${region}`, a later choice for the same region REPLACING an earlier one — the
 * agent may resubmit after a refusal).
 *
 * ⚠ MUTATES THE SESSION only through `storeEdit`, and only for a choice that passed every check:
 * a refusal mints nothing. A replaced edit's handle is never evicted (`storeEdit`'s rule).
 */
export function acceptAiChoices(
  rec: ConflictSessionRecord,
  items: readonly AiChoiceInput[],
  offered: ReadonlySet<string>,
  accepted: Map<string, ConflictAiChoice>,
): AiChoiceRejection[] {
  const model = rec.model;
  const rejected: AiChoiceRejection[] = [];
  const refuse = (it: AiChoiceInput, refusal: AiChoiceRefusal): void => {
    rejected.push({ file: Number(it.file), region: Number(it.region), refusal });
  };
  if (!model) {
    for (const it of items) refuse(it, 'unknown_region');
    return rejected;
  }

  for (const it of items) {
    const file = model.files.find((f) => f.index === it.file) ?? null;
    const region = file?.regions.find((r) => r.id === it.region) ?? null;
    if (!file || !region || file.unsupported !== null) {
      refuse(it, 'unknown_region');
      continue;
    }
    if (region.kind === 'unchanged') {
      refuse(it, 'not_decidable');
      continue;
    }
    const key = choiceKey(file.index, region.id);
    if (!offered.has(key)) {
      refuse(it, 'not_offered');
      continue;
    }
    if (region.fingerprint !== it.fingerprint) {
      refuse(it, 'moved');
      continue;
    }
    const decision = it.decision as ConflictDecision;
    if (!CONFLICT_AI_DECISIONS.includes(decision)) {
      refuse(it, 'not_allowed');
      continue;
    }
    const rationale = clipRationale(it.rationale);
    const confidence = confidenceOf(it.confidence);

    if (decision !== 'edited') {
      // ⚠ THE MODEL'S OWN `allowed`, never a looser list: `disjoint_merge` exists only where the
      // wand proved the two edits disjoint, and a one-sided region offers its side and `base`.
      if (!allowedDecisions(region).includes(decision)) {
        refuse(it, 'not_allowed');
        continue;
      }
      accepted.set(key, {
        fileIndex: file.index,
        regionId: region.id,
        decision,
        editId: null,
        lines: null,
        rationale,
        confidence,
      });
      continue;
    }

    if (!Array.isArray(it.lines) || it.lines.some((l) => typeof l !== 'string')) {
      refuse(it, 'no_lines');
      continue;
    }
    // A model may echo a `\r` it saw; the region's own ending is re-imposed by the shape.
    const cleaned = it.lines.map((l) => l.replace(/\r$/, ''));
    const text = cleaned.join('\n');
    const shape = editShapeFor(
      [region.base, region.ours, region.theirs],
      file.regions[0]?.id === region.id,
    );
    const checked = validateConflictEdit(text, config.conflictSuggestMaxChars, shape);
    if (!checked.ok) {
      refuse(it, checked.refusal);
      continue;
    }
    // ⚠ ONE BLANK LINE IS NOT ZERO LINES. The text round trip cannot tell `['']` from `[]` (the
    // edit route reads an empty box as "delete the hunk"), but Claude submits an ARRAY, so a single
    // empty string is one blank line — given the region's own ending and BOM like any other line.
    if (cleaned.length === 1 && cleaned[0] === '' && checked.lines.length === 0) {
      checked.lines.push(`${shape.leadingBom ? '\uFEFF' : ''}${shape.crlf ? '\r' : ''}`);
    }
    const editId = storeEdit(rec, {
      fileIndex: file.index,
      regionId: region.id,
      lines: checked.lines,
      // Fold rule 4, as the edit route sets it: the OURS side's terminator.
      endsWithNewline: file.terminators.ours,
    });
    if (editId == null) {
      refuse(it, 'too_many_edits');
      continue;
    }
    accepted.set(key, {
      fileIndex: file.index,
      regionId: region.id,
      decision: 'edited',
      editId,
      lines: checked.lines,
      rationale,
      confidence,
    });
  }
  return rejected;
}
