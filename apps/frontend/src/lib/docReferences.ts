import { REVIEW_DOC_QUOTE_MAX_CHARS, type ReferenceDocCitation } from '@pierre-review/shared';
import { parseLibraryPath, type LibraryLocation } from './referenceDocs.js';

// REFERENCE-LIBRARY LINKS FROM A REVIEW (docs/REFERENCE-DOCS.md § Use in reviews). The pure half: no
// React, no store, so the unit test imports it directly.
//
// A reference (or a finding's citation) opens its section in Activity → Docs. In-app, a click seats
// the section in the docs store and switches the rail; the href is a real DEEP LINK so a middle-click,
// a copied link or a new tab lands on the same section:
//
//   /app/?workspace=<id>&activityRepo=docs&doc=<slug>&section=<NN-name.md>[&anchor=<anchor>][&quote=<words>]
//
// `quote` is the server-checked passage the viewer highlights. It is PLAIN TEXT (never rendered as
// markup — the viewer only searches for it), capped on parse, and one-shot like the rest.
//
// ⚠ `doc` + `section` are held to the SAME strict grammar as every other library path
// (`parseLibraryPath`), so a crafted link opens nothing it could not open by clicking.

export interface DocsLinkTarget {
  /** Library-relative: `<slug>/sections/NN-name.md` (or a CONTENTS.md / INDEX.md). */
  path: string;
  anchor: string | null;
  /** The checked words to highlight, when the link has them. */
  quote?: string | null;
}

/** A deep link's target: the file, and the words to highlight (null = none). */
export type DocsDeepLink = LibraryLocation & { quote: string | null };

/** A quote longer than a stored quote can be is not one of ours: it is cut, never trusted further. */
const QUOTE_PARAM_MAX = REVIEW_DOC_QUOTE_MAX_CHARS;

function cleanQuote(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === '') return null;
  return t.length <= QUOTE_PARAM_MAX ? t : t.slice(0, QUOTE_PARAM_MAX);
}

/** The deep link for one library file. `base` is the SPA's base path (`/app/`). */
export function docsDeepLink(base: string, workspaceId: number | null, t: DocsLinkTarget): string {
  const p = new URLSearchParams();
  if (workspaceId != null) p.set('workspace', String(workspaceId));
  p.set('activityRepo', 'docs');
  const loc = parseLibraryPath(t.path);
  if (loc != null && loc.slug != null) {
    p.set('doc', loc.slug);
    if (loc.kind === 'section') p.set('section', t.path.split('/').pop()!);
  }
  if (t.anchor != null && t.anchor !== '') p.set('anchor', t.anchor);
  const quote = cleanQuote(t.quote);
  if (quote != null) p.set('quote', quote);
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}?${p.toString()}`;
}

/**
 * A deep link's target, from a query string, or null. `doc` alone opens that document's contents;
 * `doc` + `section` opens the section. Anything that fails the library grammar is null.
 */
export function parseDocsDeepLink(search: string): DocsDeepLink | null {
  const p = new URLSearchParams(search);
  if (p.get('activityRepo') !== 'docs') return null;
  const doc = p.get('doc');
  if (doc == null || doc === '') return null;
  const section = p.get('section');
  const anchor = p.get('anchor');
  const path = section != null && section !== '' ? `${doc}/sections/${section}` : `${doc}/CONTENTS.md`;
  const loc = parseLibraryPath(anchor != null && anchor !== '' ? `${path}#${anchor}` : path);
  return loc != null ? { ...loc, quote: cleanQuote(p.get('quote')) } : null;
}

/**
 * A finding's citation carries no quote of its own. It BORROWS the quote of the same run's reference
 * to the same section (and the same anchor, when both name one) — but only when EXACTLY ONE reference
 * matches (or several that quote the same words): two passages would mean guessing which passage the finding rested on. Else null.
 */
export function borrowedQuote(
  citation: Pick<ReferenceDocCitation, 'path' | 'anchor'>,
  references: ReadonlyArray<Pick<ReferenceDocCitation, 'path' | 'anchor'> & { quote: string }> | null | undefined,
): string | null {
  if (references == null) return null;
  const matches = references.filter(
    (r) => r.path === citation.path && (citation.anchor == null || r.anchor == null || r.anchor === citation.anchor),
  );
  // The same passage cited twice is still one passage.
  const quotes = new Set(matches.map((r) => r.quote.trim()).filter((q) => q !== ''));
  return quotes.size === 1 ? [...quotes][0]! : null;
}
