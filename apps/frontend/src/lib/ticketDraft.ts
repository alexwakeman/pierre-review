import type { SprintFinding, SprintTicketRow } from '@pierre-review/shared';
import { normaliseHighlightText } from './storyHighlights.js';
import { wordDiff } from './wordDiff.js';

// THE TICKET DRAFT (Reports → This sprint, the opened card). The reader edits a COPY of the ticket's
// text — the description, and the criteria field when the ticket keeps its criteria in one — by
// replacing a finding's quote with Claude's suggestion, by applying a proposed field, or by typing.
// Nothing reaches the tracker until "Update in <tracker>" and the dialog's Confirm. Pure; unit-tested
// in test/ticketDraft.test.ts.
//
//   • `findQuoteInMarkdown` matches a quote against the RAW Markdown whitespace-normalised (curly
//     quotes read as straight — the server's `verifyStoryQuote` normalisation), case-sensitive first,
//     and maps the hit back to raw offsets, so a replace rewrites exactly that occurrence.
//   • `revisionMarkdown` wraps every word the draft added (a word diff against the original) in two
//     private-use sentinels; `rehypeRevisions` turns them into `<ins class="story-rev">` after the
//     sanitizer. A sentinel never stands before a line's Markdown syntax (list marker, heading, quote,
//     table pipe), and lines whose syntax it would break (fences, rules, link definitions) carry none.
//   • The draft survives a reload in localStorage per (workspace, ticket) — an unsent-draft
//     convenience only; every access is guarded and the card works without it.

export type DraftField = 'description' | 'criteria';

export interface DraftTexts {
  description: string;
  /** null when the ticket has no criteria field of its own. */
  criteria: string | null;
}

export interface TicketDraft {
  /** The `replaceBases` hashes the draft was built on — each field's write sends its own. */
  bases: { description: string; criteria: string | null };
  /** The ticket's text when the draft started: what the revision highlights and the dialog's diff
   *  compare against. */
  base: DraftTexts;
  text: DraftTexts;
  /** Findings whose suggestion was applied. */
  replaced: string[];
}

/** The ticket's own text: where every draft starts. */
export function draftOriginal(t: Pick<SprintTicketRow, 'description' | 'acceptanceCriteria' | 'replaceBases'>): DraftTexts {
  return { description: t.description, criteria: t.replaceBases.acceptanceCriteria != null ? t.acceptanceCriteria : null };
}

export function freshDraft(t: Pick<SprintTicketRow, 'description' | 'acceptanceCriteria' | 'replaceBases'>): TicketDraft {
  return {
    bases: { description: t.replaceBases.description.hash, criteria: t.replaceBases.acceptanceCriteria?.hash ?? null },
    base: draftOriginal(t),
    text: draftOriginal(t),
    replaced: [],
  };
}

/** The fields the draft changed, in write order. */
export function changedFields(original: DraftTexts, draft: DraftTexts): DraftField[] {
  const out: DraftField[] = [];
  if (draft.description !== original.description) out.push('description');
  if (draft.criteria != null && original.criteria != null && draft.criteria !== original.criteria) out.push('criteria');
  return out;
}

/** Whether the draft holds no edit at all. */
export function draftPristine(d: TicketDraft): boolean {
  return changedFields(d.base, d.text).length === 0 && d.replaced.length === 0;
}

/** Whether the ticket's stored text moved under the draft (a base hash differs). */
export function draftBaseMoved(d: TicketDraft, t: Pick<SprintTicketRow, 'replaceBases'>): boolean {
  return d.bases.description !== t.replaceBases.description.hash || d.bases.criteria !== (t.replaceBases.acceptanceCriteria?.hash ?? null);
}

/**
 * The draft after the ticket's stored text moved: each MOVED field restarts from the new text when it
 * holds nothing worth keeping — unedited, now equal to the ticket, or written from this card over that
 * very base (`writtenAt`: field → the base hash it was written over). An edited field stays as it is
 * (the card then says the ticket changed). The same object back when nothing restarted.
 */
export function rebaseDraft(
  d: TicketDraft,
  t: Pick<SprintTicketRow, 'description' | 'acceptanceCriteria' | 'replaceBases'>,
  writtenAt: Partial<Record<DraftField, string>> = {},
): TicketDraft {
  const now = freshDraft(t);
  let out = d;
  for (const f of ['description', 'criteria'] as const) {
    const was = d.bases[f];
    const is = now.bases[f];
    if (was === is) continue;
    const restart =
      was == null || is == null || d.text[f] === d.base[f] || d.text[f] === now.text[f] || writtenAt[f] === was;
    if (!restart) continue;
    out = {
      ...out,
      bases: { ...out.bases, [f]: is },
      base: { ...out.base, [f]: now.base[f] },
      text: { ...out.text, [f]: now.text[f] },
    };
  }
  if (out !== d && changedFields(out.base, out.text).length === 0) out = { ...out, replaced: [] };
  return out;
}

/** Whether a field may be edited here: present, and not cut on the wire. */
export function fieldEditable(t: Pick<SprintTicketRow, 'replaceBases'>, field: DraftField): boolean {
  const b = field === 'description' ? t.replaceBases.description : t.replaceBases.acceptanceCriteria;
  return b != null && !b.truncated;
}

/** The draft field a finding's quote lives in; null for the title, an unanchored finding, or
 *  criteria shown apart from a field this card can edit. */
export function findingDraftField(
  f: Pick<SprintFinding, 'quote' | 'where'>,
  t: Pick<SprintTicketRow, 'replaceBases'>,
  criteriaShownApart: boolean,
): DraftField | null {
  if (f.quote == null || f.quote.trim() === '') return null;
  if (f.where === 'title') return null;
  if (f.where === 'criteria') {
    if (t.replaceBases.acceptanceCriteria != null) return 'criteria';
    return criteriaShownApart ? null : 'description';
  }
  return 'description';
}

// ── Finding a quote in raw Markdown ──────────────────────────────────────────────────────────────

const QUOTE_CHARS: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"' };

/** The raw text whitespace-collapsed (curly quotes straight), with each normalised char's raw offset. */
function normaliseWithMap(raw: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (/\s/.test(ch)) {
      if (text !== '' && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      text += ' ';
      map.push(pendingSpace);
      pendingSpace = -1;
    }
    text += QUOTE_CHARS[ch] ?? ch;
    map.push(i);
  }
  return { text, map };
}

/** The raw [start, end) of the first occurrence of `quote` in `raw`, whitespace-normalised; null when
 *  it is not there. Case-sensitive first, then case-insensitive. */
export function findQuoteInMarkdown(raw: string, quote: string): { start: number; end: number } | null {
  const q = normaliseHighlightText(quote);
  if (q === '') return null;
  const { text, map } = normaliseWithMap(raw);
  let at = text.indexOf(q);
  if (at < 0) {
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    // Lower-casing must not change lengths, or the offsets would drift.
    if (lower.length === text.length && ql.length === q.length) at = lower.indexOf(ql);
  }
  if (at < 0) return null;
  return { start: map[at]!, end: map[at + q.length - 1]! + 1 };
}

/** `raw` with the first occurrence of `quote` replaced by `replacement`; null when the quote is not there. */
export function replaceQuoteInMarkdown(raw: string, quote: string, replacement: string): string | null {
  const hit = findQuoteInMarkdown(raw, quote);
  if (hit == null) return null;
  return raw.slice(0, hit.start) + replacement + raw.slice(hit.end);
}

// ── Apply all suggestions ────────────────────────────────────────────────────────────────────────

/** A finding's suggestion, as "Apply all" sees it: the draft field its quote lives in (null = none). */
export interface ApplyAllFinding {
  id: string;
  field: DraftField | null;
  quote: string | null;
  suggestion: string | null;
}

/** A whole-field proposal (a proposed description, proposed criteria): the field it rewrites and the
 *  new text, built from the draft as it stands at that point of the fold. */
export interface ApplyAllProposal {
  field: DraftField;
  build: (texts: DraftTexts) => string;
}

export interface ApplyAllResult {
  /** The draft after the fold; the SAME object when nothing applied. */
  draft: TicketDraft;
  /** Changes made: proposals applied + suggestions replaced. */
  applied: number;
  /** Findings whose suggestion was replaced in. */
  findingIds: string[];
}

/**
 * "Apply all suggestions" as ONE fold over the draft (one undo step in the hook). Pure.
 *
 *   1. WHOLE-FIELD PROPOSALS FIRST, in the order given (description, then criteria — so criteria that
 *      live in the description are swapped into the proposed description, not the old one). A field a
 *      proposal rewrote is DONE: the proposal is Claude's whole rewrite of it, so no quote-replace runs
 *      in it afterwards (a quote would match the old wording or nothing).
 *   2. Then each finding's suggestion, by the same rule as a single Replace: the quote must still be in
 *      the field's current draft text (`replaceQuoteInMarkdown`), else it is skipped. Findings already
 *      replaced are skipped.
 *
 * Only `editable` fields are touched. Nothing here reaches the tracker.
 */
export function applyAllSuggestions(
  d: TicketDraft,
  findings: readonly ApplyAllFinding[],
  proposals: readonly ApplyAllProposal[],
  editable: (field: DraftField) => boolean,
): ApplyAllResult {
  let texts: DraftTexts = { ...d.text };
  const rewritten = new Set<DraftField>();
  let applied = 0;
  for (const p of proposals) {
    const before = texts[p.field];
    if (before == null || !editable(p.field)) continue;
    const next = p.build(texts);
    rewritten.add(p.field);
    if (next === before || next.trim() === '') continue;
    texts = { ...texts, [p.field]: next };
    applied += 1;
  }
  const findingIds: string[] = [];
  for (const f of findings) {
    if (f.field == null || rewritten.has(f.field) || !editable(f.field) || d.replaced.includes(f.id)) continue;
    if (f.quote == null || f.quote.trim() === '' || f.suggestion == null || f.suggestion.trim() === '') continue;
    const before = texts[f.field];
    if (before == null) continue;
    const after = replaceQuoteInMarkdown(before, f.quote, f.suggestion);
    if (after == null) continue;
    texts = { ...texts, [f.field]: after };
    findingIds.push(f.id);
    applied += 1;
  }
  if (applied === 0) return { draft: d, applied: 0, findingIds: [] };
  return { draft: { ...d, text: texts, replaced: [...d.replaced, ...findingIds] }, applied, findingIds };
}

// ── Revision highlights ──────────────────────────────────────────────────────────────────────────

export const REV_OPEN = '';
export const REV_CLOSE = '';
const SENTINELS = /[]/g;

/** Line-leading Markdown syntax a sentinel must stay after. */
const LEAD_SYNTAX = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|#{1,6}[ \t]+|>[ \t]?|\|[ \t]*)*(?:\[[ xX]\][ \t]+)?/;
/** Lines no sentinel may enter: fences, rules / setext underlines / table delimiters, link definitions. */
const NO_MARK_LINE = /^[ \t]*(?:```|~~~|[-=*_|:\t ]+$|\[[^\]]+\]:)/;

/** One line's piece of an added run, wrapped: after any line-leading syntax, around its words only.
 *  `line` is the whole draft line the piece sits on. */
function markPiece(piece: string, lineStart: boolean, line: string): string {
  if (NO_MARK_LINE.test(line)) return piece;
  const lead = lineStart ? (piece.match(LEAD_SYNTAX)?.[0] ?? '') : '';
  const m = piece.slice(lead.length).match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (m == null || m[2] === '') return piece;
  return `${lead}${m[1]}${REV_OPEN}${m[2]}${REV_CLOSE}${m[3]}`;
}

/**
 * The draft's Markdown with every word it added (against `original`) wrapped in sentinels. Unchanged
 * when nothing was added, or when the diff does not rebuild the draft exactly (then no highlights).
 */
export function revisionMarkdown(original: string, draft: string): string {
  if (original === draft) return draft;
  const parts = wordDiff(original, draft);
  if (!parts.some((p) => p.kind === 'added')) return draft;
  const lead = draft.match(/^\s*/)?.[0] ?? '';
  let rebuilt = lead;
  for (const p of parts) if (p.kind !== 'removed') rebuilt += p.text;
  if (rebuilt !== draft) return draft;
  let out = lead;
  let pos = lead.length;
  for (const p of parts) {
    if (p.kind === 'removed') continue;
    if (p.kind === 'same') {
      out += p.text;
      pos += p.text.length;
      continue;
    }
    p.text.split('\n').forEach((piece, i) => {
      if (i > 0) out += '\n';
      const from = draft.lastIndexOf('\n', pos - 1) + 1;
      const nl = draft.indexOf('\n', pos);
      out += markPiece(piece, from === pos, draft.slice(from, nl < 0 ? draft.length : nl));
      pos += piece.length + 1;
    });
    pos -= 1; // the split added one separator too many
  }
  return out;
}

interface HNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const NO_INS_PARENT = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr']);

function revWalk(node: HNode, state: { open: boolean }): void {
  const children = node.children;
  if (children == null) return;
  const next: HNode[] = [];
  let changed = false;
  for (const c of children) {
    if (c.type === 'element') {
      const props = c.properties;
      if (props != null) {
        for (const [k, v] of Object.entries(props)) if (typeof v === 'string' && /[]/.test(v)) props[k] = v.replace(SENTINELS, '');
      }
      revWalk(c, state);
      next.push(c);
      continue;
    }
    if (c.type !== 'text' || c.value == null) {
      next.push(c);
      continue;
    }
    const v = c.value;
    if (!/[]/.test(v) && !state.open) {
      next.push(c);
      continue;
    }
    changed = true;
    let buf = '';
    const flush = (): void => {
      if (buf === '') return;
      if (state.open && buf.trim() !== '' && !NO_INS_PARENT.has(node.tagName ?? '')) {
        next.push({ type: 'element', tagName: 'ins', properties: { className: ['story-rev'] }, children: [{ type: 'text', value: buf }] });
      } else {
        next.push({ type: 'text', value: buf });
      }
      buf = '';
    };
    for (const ch of v) {
      if (ch === REV_OPEN || ch === REV_CLOSE) {
        flush();
        state.open = ch === REV_OPEN;
        continue;
      }
      buf += ch;
    }
    flush();
  }
  if (changed) node.children = next;
}

/** Rehype plugin: sentinel-wrapped text → `<ins class="story-rev">`; stray sentinels are removed. */
export function rehypeRevisions(): (tree: HNode) => void {
  return (tree) => revWalk(tree, { open: false });
}

// ── The unsent draft in localStorage ──────────────────────────────────────────────────────────────

export function draftStorageKey(workspaceId: number, ident: string): string {
  return `limn.sprintDraft.v1:${workspaceId}:${ident}`;
}

function isDraft(x: unknown): x is TicketDraft {
  if (typeof x !== 'object' || x == null) return false;
  const d = x as Record<string, unknown>;
  const bases = d.bases as Record<string, unknown> | undefined;
  const text = d.text as Record<string, unknown> | undefined;
  const base = d.base as Record<string, unknown> | undefined;
  return (
    base != null &&
    typeof base.description === 'string' &&
    (base.criteria === null || typeof base.criteria === 'string') &&
    bases != null &&
    typeof bases.description === 'string' &&
    (bases.criteria === null || typeof bases.criteria === 'string') &&
    text != null &&
    typeof text.description === 'string' &&
    (text.criteria === null || typeof text.criteria === 'string') &&
    Array.isArray(d.replaced) &&
    d.replaced.every((r) => typeof r === 'string')
  );
}

export function loadStoredDraft(key: string): TicketDraft | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeDraft(key: string, d: TicketDraft | null): void {
  try {
    if (d == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(d));
  } catch {
    // Private window, blocked storage, quota: the draft lives in memory only.
  }
}
