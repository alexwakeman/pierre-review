import type { ConflictRegionEditRefusal, ConflictSuggestionRefusal } from '@pierre-review/shared';
import { hasConflictMarkers } from '../coding/merge.js';

/**
 * THE TWO TEXT INGRESSES' VALIDATORS. The Pro per-hunk suggestion's, and the CORE manual
 * edit's — in one file because they are the same job (nothing untrusted becomes a blob until
 * something here has vouched for it) and because they must not drift into two vocabularies for
 * one fact. They are DIFFERENT functions, though, and the bottom of this file says why.
 *
 * THE PRO PER-HUNK SUGGESTION'S VALIDATORS — and they live in CORE, deliberately.
 *
 * ⚠ WHY THEY ARE NOT IN THE PLUGIN. `packages/pro/test/` does not run in CI and is not
 * typechecked (`pnpm test` is recursive vitest and the plugin's tsconfig includes only `src`).
 * These functions are the only thing standing between attacker-authored conflict text and a
 * blob in somebody's repository, and they have to agree byte-for-byte with the model the host
 * built. In core they run on every `pnpm test`, against the same `ConflictModelRegion` the land
 * path folds.
 *
 * ⚠ EVERY CHECK REFUSES. There is no "accept with a warning" path and there must not be one: a
 * suggestion that fails any check never reaches the centre pane, so the reader never sees text
 * we could not vouch for sitting where their code will be. `cannot_reconcile` — the model saying
 * the two sides genuinely contest — is a DESIGNED outcome on the same footing, not a failure.
 *
 * ⚠ THE RAW MODEL TEXT NEVER LEAVES THIS FILE'S CALLER. On a refusal the route sends the code
 * and OUR sentence; echoing the answer back would hand an injection payload a rendering surface
 * in the one screen whose whole job is to show text the reader is about to commit.
 */

/* ═════════════════════════════════ the fences ═════════════════════════════════ */

/**
 * The six fenced regions of the prompt. Five are input the model READS; `RESOLVED` is the one it
 * WRITES, and the only one this file extracts.
 *
 * ⚠ ONE PRODUCER, IN CORE, REACHED BY THE PLUGIN THROUGH THE SEAM (`ConflictSeam.fences`). The
 * prompt's fences and the validator's extraction are the same strings by construction — a second
 * spelling in the plugin would make every answer refuse `unparseable` against a host whose
 * markers had moved, which is loud but pointless. Nothing here is a secret: the NONCE is what
 * makes a fence unforgeable, not the word.
 */
export const CONFLICT_FENCE_REGIONS = [
  'BASE',
  'OURS',
  'THEIRS',
  'CONTEXT BEFORE',
  'CONTEXT AFTER',
  'RESOLVED',
] as const;

export type ConflictFenceRegion = (typeof CONFLICT_FENCE_REGIONS)[number];

export interface ConflictFence {
  begin: string;
  end: string;
}

export type ConflictFences = Record<ConflictFenceRegion, ConflictFence>;

/**
 * The marker pair for every fenced region, at one per-request nonce.
 *
 * ⚠ THE NONCE IS THE WHOLE MECHANISM. A conflict hunk is attacker-authored on any pull request,
 * so a line inside one reading `---END OURS---` would close a fixed fence and let the rest of
 * that side be read as instructions. With a fresh 16-hex nonce in every marker, such a line is
 * data: it closes nothing, and the caller re-rolls the nonce on the ~2⁻⁶⁴ chance the untrusted
 * text contains it (see `nonceCollides`).
 */
export function conflictFences(nonce: string): ConflictFences {
  const out = {} as ConflictFences;
  for (const region of CONFLICT_FENCE_REGIONS) {
    out[region] = {
      begin: `---BEGIN ${region} ${nonce}---`,
      end: `---END ${region} ${nonce}---`,
    };
  }
  return out;
}

/** True when the nonce appears anywhere in the untrusted material, so the caller must re-roll it
 *  before building a prompt. Checked against everything that gets fenced, not just the sides. */
export function nonceCollides(hunk: ConflictHunkContext, nonce: string): boolean {
  const needle = nonce.toLowerCase();
  for (const side of [
    hunk.base,
    hunk.ours,
    hunk.theirs,
    hunk.contextBefore,
    hunk.contextAfter,
    [hunk.path, hunk.headRef, hunk.baseRef],
  ]) {
    for (const line of side) if (line.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/* ═════════════════════════════════ the hunk ═════════════════════════════════ */

/** How the plugin addresses one region. Every field is an index, an id or a hash — no source
 *  code travels in the request body, and no region is client-forgeable: the host reads the
 *  bytes out of its OWN session. */
export interface ConflictHunkRef {
  prId: number;
  sessionId: string;
  fileIndex: number;
  regionId: number;
  /** The region's `fingerprint` — the CONTENT pin beside the id's ADDRESS. */
  fingerprint: string;
}

/** One region, as the plugin sees it. Everything here came out of the host's session; nothing
 *  came off the wire. */
export interface ConflictHunkContext {
  /** For the plugin's per-account memo key and its usage-ledger row. */
  repoId: number;
  path: string;
  headRef: string;
  baseRef: string;
  base: string[];
  ours: string[];
  theirs: string[];
  /** Up to `HUNK_CONTEXT_LINES` lines either side, from the ADJACENT regions' ancestor text.
   *  Read-only in the prompt, and byte-identical to what check 6 compares against — clipping
   *  happens here, before the prompt is built, so the two cannot disagree. */
  contextBefore: string[];
  contextAfter: string[];
  /** The terminator a suggestion inherits, per fold rule 4: the OURS side's. */
  endsWithNewline: boolean;
}

/** Why the host would not hand over a hunk. Ordered as the seam checks them: ownership →
 *  session/pins → file/region → text-ness → size → fingerprint. */
export type ConflictHunkLoadError =
  /** Not this account's pull request, or the reader cannot push to it. 404, no existence oracle. */
  | 'not_found'
  | 'session_expired'
  | 'unknown_region'
  /** The region is not contested — there is nothing for a model to reconcile. */
  | 'not_conflict'
  | 'not_text'
  /** Over `config.conflictSuggestMaxChars`. REFUSED, never truncated: a truncated region spliced
   *  back deletes code the model never saw. */
  | 'too_large'
  /** The fingerprint does not match the id — the bytes moved under the address. */
  | 'moved';

export type ConflictSuggestionCheck =
  | { ok: true; lines: string[]; keptCommonLines: number }
  | { ok: false; refusal: ConflictSuggestionRefusal };

/** Context lines either side of the hunk, and the per-line clip. Both are prompt budget, and
 *  clipping CONTEXT is safe in a way clipping the region is not: context is never spliced back. */
export const HUNK_CONTEXT_LINES = 8;
export const HUNK_CONTEXT_LINE_CHARS = 200;

/** The characters `config.conflictSuggestMaxChars` is measured against: the three SIDES only.
 *  Context is bounded by construction, so it cannot be the thing that pushes a small hunk over. */
export function hunkRegionChars(base: string[], ours: string[], theirs: string[]): number {
  let n = 0;
  for (const side of [base, ours, theirs]) for (const line of side) n += line.length + 1;
  return n;
}

/* ═════════════════════════════════ validation ═════════════════════════════════ */

/** A lone half of a surrogate pair — legal in a JS string, not encodable as UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** Check 7's filter: a line substantial enough that losing it is a real loss. Punctuation-only
 *  lines are excluded HERE and deliberately included in check 8 — a dropped `}` is exactly the
 *  failure worth refusing on when the line was one side's own contribution. */
function significant(line: string): boolean {
  const t = line.trim();
  return t.length >= 3 && ALPHANUMERIC.test(t);
}

function countBy(lines: readonly string[], keep: (l: string) => boolean): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of lines) {
    if (!keep(line)) continue;
    const k = line.trim();
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Trailing BLANK lines only — never leading ones, and never whitespace inside a line. A model
 *  that indents its answer is right to; a model that pads it with newlines is just verbose. */
function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(0, end);
}

/** The last `n` non-blank lines of `lines`, trimmed. */
function tailSignificant(lines: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
    const t = (lines[i] ?? '').trim();
    if (t !== '') out.unshift(t);
  }
  return out;
}

/** The first `n` non-blank lines of `lines`, trimmed. */
function headSignificant(lines: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < n; i += 1) {
    const t = (lines[i] ?? '').trim();
    if (t !== '') out.push(t);
  }
  return out;
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length > 0 && a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * THE VALIDATOR. Pure — no I/O, no git, no clock. First failure wins, and every failure refuses.
 *
 * The order is load-bearing and pinned by a test: an answer that both kept a conflict marker and
 * ran long reports `markers`, because the marker is the fact worth telling the reader about.
 *
 *  1. Shape                — one `RESOLVED` fence, each marker alone on its line, in order.
 *  2. Designed refusal     — `CANNOT RECONCILE` alone in the block.
 *  3. Text-ness            — no NUL, no lone surrogate, no BOM.
 *  4. Leakage              — no nonce, no `---BEGIN `/`---END ` at a line start.
 *  5. Markers              — no surviving conflict marker.
 *  6. Context not repeated — it must not re-emit the lines it sits between.
 *  7. Common lines kept    — what BOTH sides already had must survive.
 *  8. Side lines kept      — what EITHER side added must survive.
 *  9. Length               — bounded in lines AND bytes.
 * 10. Not empty            — when either side had content.
 */
export function validateConflictSuggestion(
  hunk: ConflictHunkContext,
  nonce: string,
  rawModelText: string,
): ConflictSuggestionCheck {
  // Normalise once: CRLF → LF so a Windows-flavoured answer behaves as its LF twin, and one
  // leading BOM stripped (a transport artefact). Any OTHER BOM is a check-3 refusal.
  const text = rawModelText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fence = conflictFences(nonce).RESOLVED;
  const all = text.split('\n');

  // ---- 1. Shape --------------------------------------------------------------------------
  const begins: number[] = [];
  const ends: number[] = [];
  all.forEach((line, i) => {
    const t = line.trim();
    if (t === fence.begin) begins.push(i);
    if (t === fence.end) ends.push(i);
  });
  const begin = begins[0];
  const end = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined) {
    return { ok: false, refusal: 'unparseable' };
  }
  if (end <= begin) return { ok: false, refusal: 'unparseable' };

  const region = trimTrailingBlank(all.slice(begin + 1, end));
  const body = region.join('\n');

  // ---- 2. The designed refusal -----------------------------------------------------------
  // Its own outcome, ABOVE every content check: a model that correctly says the two sides
  // genuinely contest must not then be told its answer was unparseable or empty.
  if (body.trim() === 'CANNOT RECONCILE') return { ok: false, refusal: 'cannot_reconcile' };

  // ---- 3. Text-ness ----------------------------------------------------------------------
  if (body.includes('\0') || body.includes('\uFEFF') || LONE_SURROGATE.test(body)) {
    return { ok: false, refusal: 'not_text' };
  }

  // ---- 4. Leakage ------------------------------------------------------------------------
  // The nonce inside the block means the model echoed our scaffolding; a `---BEGIN `/`---END `
  // line start means it invented a fence of its own. Both are the same fact — the answer is not
  // the shape we asked for — so they share `unparseable` and share one sentence on screen.
  if (body.toLowerCase().includes(nonce.toLowerCase())) {
    return { ok: false, refusal: 'unparseable' };
  }
  if (region.some((l) => l.startsWith('---BEGIN ') || l.startsWith('---END '))) {
    return { ok: false, refusal: 'unparseable' };
  }

  // ---- 5. Conflict markers ---------------------------------------------------------------
  // ⚠ IMPORTED, NOT RE-SPELT. `coding/merge.ts`'s matcher deliberately EXCLUDES a bare
  // `=======` — real files contain rows of equals signs — and relies on the unambiguous
  // open/close markers. A local copy here would drift from the one the merge path trusts.
  if (hasConflictMarkers(body)) return { ok: false, refusal: 'markers' };

  // ---- 6. The context is not repeated ----------------------------------------------------
  // ⚠ NARROW ON PURPOSE, AND NOT A WHOLE-FILE COMPARISON. The context bytes are byte-identical
  // BY CONSTRUCTION — the model is never given the chance to write them, because only the
  // region between the two fences is ever read back. This check exists solely to catch an
  // answer that smuggles them back INSIDE the region, which would duplicate the surrounding
  // lines when the fold splices it. Do not "harden" it into a diff of the whole file.
  const edge = (n: number): number => Math.max(1, Math.min(3, n));
  if (hunk.contextBefore.length > 0 && region.length > 0) {
    const n = edge(Math.min(hunk.contextBefore.length, region.length));
    if (sameLines(headSignificant(region, n), tailSignificant(hunk.contextBefore, n))) {
      return { ok: false, refusal: 'context_duplicated' };
    }
  }
  if (hunk.contextAfter.length > 0 && region.length > 0) {
    const n = edge(Math.min(hunk.contextAfter.length, region.length));
    if (sameLines(tailSignificant(region, n), headSignificant(hunk.contextAfter, n))) {
      return { ok: false, refusal: 'context_duplicated' };
    }
  }

  // ---- 7. Lines BOTH versions kept ------------------------------------------------------
  // The multiset intersection of the two sides' significant lines: text neither side touched
  // and both therefore still want. Compared TRIMMED, so a whitespace-only reindent on an agreed
  // line is not a loss.
  const outCounts = countBy(region, () => true);
  const oursSig = countBy(hunk.ours, significant);
  const theirsSig = countBy(hunk.theirs, significant);
  let keptCommonLines = 0;
  for (const [line, n] of oursSig) {
    const need = Math.min(n, theirsSig.get(line) ?? 0);
    if (need === 0) continue;
    if ((outCounts.get(line) ?? 0) < need) return { ok: false, refusal: 'dropped_common_lines' };
    keptCommonLines += need;
  }

  // ---- 8. Lines EITHER side added -------------------------------------------------------
  // ⚠ THE CHECK THAT MAKES 7 WORTH HAVING. Check 7 only protects text both versions already
  // agreed on, so a model that emits THEIRS alone — deleting the pull request's entire
  // contribution — sails through it. Here a line one side has and the ancestor does not must
  // survive, unless the OTHER side deliberately deleted it (which is what "also in base" means
  // once its own side's excess is accounted for).
  //
  // ⚠ NO ≥3-CHAR FILTER HERE, unlike check 7. A dropped `}` from one side's addition is exactly
  // the failure worth refusing on.
  const nonBlank = (l: string): boolean => l.trim() !== '';
  const baseAll = countBy(hunk.base, nonBlank);
  const oursAll = countBy(hunk.ours, nonBlank);
  const theirsAll = countBy(hunk.theirs, nonBlank);
  const required = new Map<string, number>();
  for (const counts of [oursAll, theirsAll]) {
    for (const [line, n] of counts) {
      // What THIS side has beyond the ancestor. Two sides adding the same line require it
      // ONCE, not twice — hence `max`, not a sum.
      const excess = n - (baseAll.get(line) ?? 0);
      if (excess <= 0) continue;
      required.set(line, Math.max(required.get(line) ?? 0, excess));
    }
  }
  for (const [line, need] of required) {
    if ((outCounts.get(line) ?? 0) < need) return { ok: false, refusal: 'dropped_side_lines' };
  }

  // ---- 9. Length -------------------------------------------------------------------------
  const maxSideLines = Math.max(hunk.base.length, hunk.ours.length, hunk.theirs.length);
  const sideBytes =
    Buffer.byteLength(hunk.ours.join('\n'), 'utf8') +
    Buffer.byteLength(hunk.theirs.join('\n'), 'utf8');
  if (region.length > maxSideLines * 3 + 10) return { ok: false, refusal: 'too_long' };
  if (Buffer.byteLength(body, 'utf8') > sideBytes * 2 + 512) {
    return { ok: false, refusal: 'too_long' };
  }

  // ---- 10. Not empty ---------------------------------------------------------------------
  // Reached only when checks 7 and 8 found nothing to require, which is the case where both
  // sides are pure deletions of ancestor text — and even then an answer of nothing is a claim
  // the reader should make themselves, not one to accept silently from a model.
  if (region.length === 0 && (hunk.ours.length > 0 || hunk.theirs.length > 0)) {
    return { ok: false, refusal: 'empty' };
  }

  return { ok: true, lines: region, keptCommonLines };
}

/* ═══════════════════════ the reader's own text (CORE, free, both modes) ═══════════════════════ */

export type ConflictEditCheck =
  | { ok: true; lines: string[] }
  | { ok: false; refusal: Extract<ConflictRegionEditRefusal, 'not_text' | 'markers' | 'too_long'> };

/**
 * The two invisible properties of the region's OWN bytes that a textarea cannot carry, and which
 * the stored edit therefore has to inherit from it rather than from what came back over the wire.
 *
 * ⚠ NEITHER IS A PREFERENCE OR A GUESS. Both are read off the region's own line texts by
 * `editShapeFor`, and both are imposed only when the region's evidence is UNANIMOUS — a mixed
 * region is left exactly as the reader typed it, because there is no convention there to keep.
 */
export interface ConflictEditShape {
  /** Every line of this region ends `\r`, so the file is CRLF and the edit must be too. */
  crlf: boolean;
  /** This region starts the file and the file starts with a UTF-8 BOM. */
  leadingBom: boolean;
}

export const NO_EDIT_SHAPE: ConflictEditShape = { crlf: false, leadingBom: false };

/**
 * What an edit to this region has to inherit from it.
 *
 * ⚠ A TEXTAREA DESTROYS BOTH FACTS AND SAYS NOTHING. The browser's API value normalises every
 * CRLF to a bare LF before React ever sees a keystroke (HTML's "normalize newlines"), so one
 * character typed into a Windows-authored file used to rewrite the WHOLE hunk's line endings —
 * a diff of every line, and a genuinely wrong file in any repo carrying `* text eol=crlf`. A BOM
 * survives the round trip but is zero-width, so `validateConflictEdit`'s blanket U+FEFF refusal
 * made the first region of every BOM file permanently uneditable, with a sentence
 * ("Retype the odd one out") naming a character nobody can see.
 *
 * @param sides the region's own `base`, `ours` and `theirs` line texts, terminators attached.
 * @param isFirstRegion is this the file's FIRST region? Only there can a BOM be legitimate.
 */
export function editShapeFor(
  sides: ReadonlyArray<readonly string[]>,
  isFirstRegion: boolean,
): ConflictEditShape {
  const lines = sides.flat();
  return {
    // ⚠ UNANIMOUS, NOT A MAJORITY. A CRLF file's final line carries no `\r` when the file has no
    // trailing newline, so that region reads as mixed and is left alone — which is correct: there
    // is nothing there to re-impose without inventing a byte.
    crlf: lines.length > 0 && lines.every((l) => l.endsWith('\r')),
    leadingBom: isFirstRegion && sides.some((side) => side[0]?.startsWith('﻿') === true),
  };
}

/**
 * THE MANUAL EDIT'S VALIDATOR — three checks, and the list of what it deliberately does NOT
 * check is the more important half.
 *
 *  1. Text-ness  — no NUL, no lone surrogate, no BOM.
 *  2. Markers    — no surviving conflict marker.
 *  3. Length     — bounded by `config.conflictSuggestMaxChars`, ONE budget for both ingresses.
 *
 * ⚠ 1 IS NOT A FORMALITY HERE. `land.ts` does `Buffer.from(foldToText(...), 'utf8')`, and its
 * byte-for-byte round-trip claim rests on every side having decoded STRICTLY as UTF-8 at model
 * build — which is why `not_text` is a file-level REFUSAL there rather than a lossy decode.
 * Typed text does not inherit that provenance: a lone surrogate reaches `Buffer.from` and is
 * silently substituted with U+FFFD, so the bytes committed would not be the bytes anybody saw.
 *
 * ⚠ THE U+FEFF HALF OF 1 IS NOT BLANKET, AND THE EXCEPTION IS THE FILE'S OWN BOM. `model.ts`
 * decodes with `ignoreBOM: true` deliberately, so a BOM file's first line really does begin
 * U+FEFF and the textarea really is seeded with it. Refusing that made the first region of every
 * Visual-Studio-authored file permanently uneditable — and the only escape, retyping the hunk
 * from scratch, silently stripped the BOM that the decoder exists to preserve. So when
 * `shape.leadingBom` says this region owns the file's BOM, one LEADING U+FEFF is taken off before
 * the scan and put back on the first stored line. Anywhere else it is still `not_text`, and
 * `validateConflictSuggestion` — whose input is MODEL output, where a BOM is junk — is untouched.
 *
 * ⚠ AND THE LINE ENDING IS RE-IMPOSED, BECAUSE THE BROWSER ALREADY DESTROYED IT. See
 * `editShapeFor`: a textarea hands back LF for every CRLF it was given, so without this one
 * keystroke in a CRLF file rewrites the whole hunk's endings. Imposing costs nothing when the
 * region is LF (`shape.crlf` false ⇒ this is a no-op) and is the only way the stored lines can
 * agree with their own neighbours.
 *
 * ⚠ 2 IS NOT COVERED BY ANYTHING ELSE. The land path's full-resolution guard only proves each
 * conflicted path was OVERWRITTEN (merge-tree's tree stores marker content at those paths); it
 * never inspects the bytes. A typed `<<<<<<<` would commit with nothing refusing it.
 *
 * ⚠ AND CHECKS 6, 7 AND 8 OF THE SUGGESTION VALIDATOR ARE DELIBERATELY ABSENT — context not
 * repeated, common lines kept, side lines kept. Those three exist because a MODEL silently drops
 * lines it was not asked to drop, and the reader has no way to know it happened. A PERSON
 * deleting a line is not a failure mode, it is the feature: the whole reason this route exists
 * is the trailing comma, the duplicated import, the brace that belongs to neither side. Porting
 * them over would refuse exactly the edits somebody opened the textarea to make.
 *
 * The order is text-ness → markers → length, matching the suggestion validator's: the marker is
 * the fact worth telling somebody about, and "this is also too long" can wait. The scans cannot
 * run away on a huge body because the route's ajv schema bounds `text` structurally first.
 */
export function validateConflictEdit(
  text: string,
  maxChars: number,
  shape: ConflictEditShape = NO_EDIT_SHAPE,
): ConflictEditCheck {
  // The file's own BOM, off the front before the scan and back on after it. Only ever ONE, only
  // ever leading, and only when this region is where the file's BOM lives.
  const bom = shape.leadingBom && text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  if (body.includes('\0') || body.includes('\uFEFF') || LONE_SURROGATE.test(body)) {
    return { ok: false, refusal: 'not_text' };
  }
  if (hasConflictMarkers(body)) return { ok: false, refusal: 'markers' };
  if (body.length > maxChars) return { ok: false, refusal: 'too_long' };
  const lines = splitEditLines(body).map((l) =>
    shape.crlf && !l.endsWith('\r') ? `${l}\r` : l,
  );
  // \u26A0 RE-ATTACHED TO THE FIRST LINE, NOT TO THE TEXT. The reader may have deleted it \u2014 it is
  // zero-width, so they cannot have done so deliberately \u2014 and the file's decoder is documented
  // to keep it. An edit that leaves the region EMPTY has no first line, and in that case the BOM
  // goes with the lines the reader deleted, which is the one place they really did choose.
  if (shape.leadingBom && lines[0] != null && !lines[0].startsWith('\uFEFF')) {
    lines[0] = `\uFEFF${lines[0]}`;
  }
  return { ok: true, lines };
}

/**
 * The reader's text as fold lines.
 *
 * ⚠ AN EMPTY TEXTAREA IS ZERO LINES, NOT ONE BLANK ONE. `''.split('\n')` is `['']`, which folds
 * to a region containing one empty line — not what somebody who selected everything and pressed
 * delete asked for. Deleting a whole hunk has to be reachable; it is half of why this exists.
 *
 * ⚠ A TRAILING NEWLINE IS A REAL TRAILING BLANK LINE, and stays one. The suggestion validator
 * trims trailing blanks because a verbose model pads its answer; a person who left a blank line
 * at the end of the box can see it there and meant it.
 */
function splitEditLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}
