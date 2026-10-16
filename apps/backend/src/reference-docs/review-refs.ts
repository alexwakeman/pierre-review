import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { z as Zod } from 'zod';
import {
  REVIEW_DOC_ABOUT_MAX_CHARS,
  REVIEW_DOC_FINDING_CITATIONS_MAX,
  REVIEW_DOC_NOTE_MAX_CHARS,
  REVIEW_DOC_QUOTE_MAX_CHARS,
  REVIEW_DOC_QUOTE_MIN_CHARS,
  REVIEW_DOC_REFERENCES_MAX,
  type ReferenceDocCitation,
  type ReferenceDocSectionEntry,
  type ReviewDocReference,
  type ReviewDocVerdict,
} from '@pierre-review/shared';
import { parseLibraryPath } from './paths.js';
import { docsNavigationPrompt } from './prompts.js';
import { fileAnchors, SECTION_HEADER_MARK } from './render.js';

// THE LIBRARY IN REVIEWS (docs/REFERENCE-DOCS.md § Use in reviews) — the shared half every review
// that may read the workspace's reference library uses: Claude Review (claude-review/), the ticket
// review (ticket-review/) and This Sprint's "Check against code" (sprint-assess/).
//
//   • THE GATE is `docsContextFor(…).usable` (context.ts): the workspace's `docsInReview` switch, a
//     built document, and agentic AI on here. Off ⇒ the caller passes no `docs` and its prompts, tool
//     list and tool schema are BYTE-FOR-BYTE what they were before this feature (tested).
//   • ON ⇒ the library folder is a READ-ONLY root of the run's path guard (path-guard.ts: Read, Glob,
//     Grep, LS only — never a write) and an `additionalDirectories` entry; the system prompt gains
//     `docsReviewPromptBlock`; the submit tool gains `docReferences` (and, for the PR review, a
//     finding's `docRefs`).
//   • EVERY REFERENCE IS CHECKED HERE before it is stored (`validateDocReferences`): the link must
//     parse under the library's strict grammar, name a SECTION file of a BUILT document of THIS
//     workspace and exist; the quote must appear in that section (whitespace, markdown emphasis and
//     typographic quotes folded; "…" may skip words). Anything else is DROPPED and counted, never
//     shown. An anchor that names no heading of the section is dropped (the link is kept).
//
// ⚠ Pure apart from the `LibrarySnapshot` the caller hands in (loadLibrarySnapshot in context.ts reads
// the rows and files), so the validator is tested without a database.

type ZodNs = typeof Zod;

// ---- the tool fields ----

/** The `docReferences` field of a review's submit tool. Only added when the library is in use. */
export function buildDocReferencesField(z: ZodNs) {
  return z
    .array(
      z.object({
        link: z
          .string()
          .describe(
            "The section's link, relative to the library, with the heading's anchor when you can: 'billing-handbook/sections/04-refunds.md#partial-refunds'.",
          ),
        quote: z
          .string()
          .max(REVIEW_DOC_QUOTE_MAX_CHARS)
          .describe(
            `Words copied EXACTLY from that section, at most ${REVIEW_DOC_QUOTE_MAX_CHARS} characters. Use … to skip words inside the quote.`,
          ),
        verdict: z
          .enum(['supports', 'contradicts', 'context'])
          .describe(
            "'supports': the story or code does what the passage says. 'contradicts': the story or code goes against it. 'context': it explains, but neither supports nor contradicts.",
          ),
        note: z.string().max(REVIEW_DOC_NOTE_MAX_CHARS).describe('One sentence: what the passage means for this change or story.'),
        about: z
          .string()
          .max(REVIEW_DOC_ABOUT_MAX_CHARS)
          .nullable()
          .optional()
          .describe("What it bears on, when that helps: a criterion ref ('AC2'), a finding's title, or a file."),
      }),
    )
    .max(REVIEW_DOC_REFERENCES_MAX)
    .optional()
    .describe(
      `The reference-library passages you relied on, at most ${REVIEW_DOC_REFERENCES_MAX}, contradictions first. Leave it out when nothing in the library bears on this.`,
    );
}

/** A PR-review finding's `docRefs`: the section links it rests on. Only added when the library is in use. */
export function buildDocCitationsField(z: ZodNs) {
  return z
    .array(z.string())
    .max(REVIEW_DOC_FINDING_CITATIONS_MAX)
    .optional()
    .describe('Only when this finding rests on the reference library: the section links it rests on.');
}

// ---- the prompt block ----

export type DocsReviewKind = 'pr' | 'pr_diff_only' | 'ticket' | 'sprint';

const REPORTING = `- Report each passage you relied on in \`docReferences\`: the section link; a quote copied EXACTLY from the section (at most ${REVIEW_DOC_QUOTE_MAX_CHARS} characters; use … to skip words inside it); the verdict; and a one-sentence note. Contradictions first.
- The server checks every reference: one whose link is not a section of the library, or whose quote is not in that section, is thrown away. Copy the words; do not paraphrase inside the quote.
- Leave \`docReferences\` out when nothing in the library bears on this.`;

/**
 * The system-prompt block for a review that reads the library: the shared navigation rules
 * (`docsNavigationPrompt`), then what THIS kind of run does with it and how to report it.
 */
export function docsReviewPromptBlock(dir: string, kind: DocsReviewKind): string {
  const nav = docsNavigationPrompt(dir);
  if (kind === 'pr' || kind === 'pr_diff_only') {
    return `${nav}

# Checking the change against the library
${kind === 'pr_diff_only' ? '- This review has no checkout of the repository: Read, Glob and Grep reach the library only. Use them for nothing else.\n' : ''}- Look up what the library says about the behaviour, rules and requirements this change touches, and about the story when the title or description names one. Read only those sections.
- Where a finding rests on the library, put its section links in that finding's \`docRefs\` and say in the body what the document requires.
${REPORTING}`;
  }
  const subject = kind === 'ticket' ? 'the code in the pull requests' : 'the code on the default branch';
  return `${nav}

# Checking the story against the library
For this ticket:
- Find the passages that bear on the story: the rules, definitions and requirements it relies on. Read only those sections.
- Flag every CONTRADICTION: where the story's text, its acceptance criteria or ${subject} goes against the library. Use the verdict 'contradicts' and say which side in the note.
- Where the library supports the story or the code, say so: the verdict 'supports', with the passage.
- When a criterion's verdict rests on the library, say so in its explanation and put the criterion in \`about\` ('AC2').
${REPORTING}`;
}

// ---- validation ----

/** What the validator needs to know about the workspace's library. */
export interface LibrarySnapshot {
  /** The library folder as the run was told it (absolute). */
  dir: string;
  /** Built documents only. */
  docs: ReadonlyArray<{ slug: string; title: string; sections: readonly ReferenceDocSectionEntry[] | null }>;
  /** A library file's text by library-relative path, or null (must stay inside the library). */
  read(path: string): string | null;
}

/** Fold the text a quote is compared on: emphasis, escapes, link targets, typography, whitespace. */
export function foldForQuote(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/^\s*(?:[>|]|[-+]\s|\d+[.)]\s)+/gm, ' ')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The section's own text: the server-written header (mark, title, trail, nav) left off. */
export function sectionBodyOf(text: string): string {
  const lines = text.split('\n');
  if (!lines[0]?.startsWith(SECTION_HEADER_MARK.slice(0, -' -->'.length))) return text;
  let i = 1;
  if (lines[i]?.startsWith('# ')) i += 1;
  // The header's blank line, crumbs, nav and blank line — at most four lines, never into the body.
  for (let k = 0; k < 4 && i < lines.length && (lines[i] === '' || lines[i]!.startsWith('> ')); k += 1) i += 1;
  return lines.slice(i).join('\n');
}

/** Does `quote` appear in `body`? "…" / "..." in the quote skips words (the pieces must be in order). */
export function quoteAppearsIn(body: string, quote: string): boolean {
  const hay = foldForQuote(body);
  const pieces = quote
    .split(/…|\.{3,}/)
    .map(foldForQuote)
    .filter((p) => p !== '');
  if (pieces.length === 0) return false;
  let from = 0;
  for (const p of pieces) {
    const at = hay.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

const letters = (s: string): number => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

const clip = (raw: unknown, max: number): string => {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * A link as the model wrote it → library-relative (`slug/sections/NN-name.md#anchor`), or null. A
 * markdown link `[x](y)` gives its target; an ABSOLUTE path is accepted only inside the library.
 */
export function libraryRelativeLink(raw: unknown, dir: string): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  const md = /^!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)$/.exec(t);
  if (md) t = md[1]!;
  t = t.replace(/^<|>$/g, '');
  if (t === '' || t.includes('\u0000') || t.includes('\\')) return null;
  const hash = t.indexOf('#');
  const bare = hash >= 0 ? t.slice(0, hash) : t;
  const anchor = hash >= 0 ? t.slice(hash) : '';
  if (isAbsolute(bare)) {
    for (const root of [dir, realOr(dir)]) {
      const rel = relative(root, bare);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return `${rel.split(sep).join('/')}${anchor}`;
    }
    return null;
  }
  return `${bare.startsWith('./') ? bare.slice(2) : bare}${anchor}`;
}

/** One link → a citation of a built section of this library, or null. */
export function citationOf(raw: unknown, lib: LibrarySnapshot): { citation: ReferenceDocCitation; text: string } | null {
  const rel = libraryRelativeLink(raw, lib.dir);
  if (rel == null) return null;
  const parsed = parseLibraryPath(rel);
  if (parsed == null || parsed.path.kind !== 'section') return null;
  const path = parsed.path;
  const doc = lib.docs.find((d) => d.slug === path.slug);
  if (doc == null) return null;
  const text = lib.read(path.path);
  if (text == null) return null;
  const anchor = parsed.anchor != null && fileAnchors(text).has(parsed.anchor) ? parsed.anchor : null;
  const section = (doc.sections ?? []).find((s) => s.path === path.path);
  return {
    citation: {
      path: path.path,
      anchor,
      docSlug: doc.slug,
      docTitle: doc.title,
      sectionTitle: section?.title ?? null,
    },
    text,
  };
}

export interface DocReferencesResult {
  references: ReviewDocReference[];
  /** Entries refused: a bad link, a quote not in its section, a malformed entry, or over the cap. */
  dropped: number;
}

const VERDICTS: readonly string[] = ['supports', 'contradicts', 'context'];
const ORDER: Record<ReviewDocVerdict, number> = { contradicts: 0, supports: 1, context: 2 };

/** The model's `docReferences` → the checked list to store (contradictions first, then as given). */
export function validateDocReferences(raw: unknown, lib: LibrarySnapshot): DocReferencesResult {
  const list = Array.isArray(raw) ? raw : [];
  const out: ReviewDocReference[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const r of list) {
    if (r == null || typeof r !== 'object' || Array.isArray(r)) {
      dropped += 1;
      continue;
    }
    const e = r as Record<string, unknown>;
    const quote = typeof e.quote === 'string' ? e.quote.replace(/\s+/g, ' ').trim() : '';
    if (
      typeof e.verdict !== 'string' ||
      !VERDICTS.includes(e.verdict) ||
      quote.length > REVIEW_DOC_QUOTE_MAX_CHARS ||
      letters(quote) < REVIEW_DOC_QUOTE_MIN_CHARS
    ) {
      dropped += 1;
      continue;
    }
    const hit = citationOf(e.link, lib);
    if (hit == null || !quoteAppearsIn(sectionBodyOf(hit.text), quote)) {
      dropped += 1;
      continue;
    }
    const key = `${hit.citation.path}#${hit.citation.anchor ?? ''}|${foldForQuote(quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= REVIEW_DOC_REFERENCES_MAX) {
      dropped += 1;
      continue;
    }
    out.push({
      ...hit.citation,
      quote,
      verdict: e.verdict as ReviewDocVerdict,
      note: clip(e.note, REVIEW_DOC_NOTE_MAX_CHARS),
      about: clip(e.about, REVIEW_DOC_ABOUT_MAX_CHARS) || null,
    });
  }
  const indexed = out.map((ref, i) => ({ ref, i }));
  indexed.sort((a, b) => ORDER[a.ref.verdict] - ORDER[b.ref.verdict] || a.i - b.i);
  return { references: indexed.map((x) => x.ref), dropped };
}

/** A finding's `docRefs` → checked citations (links only; no quote). */
export function validateDocCitations(raw: unknown, lib: LibrarySnapshot): ReferenceDocCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: ReferenceDocCitation[] = [];
  const seen = new Set<string>();
  for (const link of raw) {
    const hit = citationOf(link, lib);
    if (hit == null) continue;
    const key = `${hit.citation.path}#${hit.citation.anchor ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit.citation);
    if (out.length >= REVIEW_DOC_FINDING_CITATIONS_MAX) break;
  }
  return out;
}
