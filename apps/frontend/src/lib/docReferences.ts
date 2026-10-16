import { parseLibraryPath, type LibraryLocation } from './referenceDocs.js';

// REFERENCE-LIBRARY LINKS FROM A REVIEW (docs/REFERENCE-DOCS.md § Use in reviews). The pure half: no
// React, no store, so the unit test imports it directly.
//
// A reference (or a finding's citation) opens its section in Activity → Docs. In-app, a click seats
// the section in the docs store and switches the rail; the href is a real DEEP LINK so a middle-click,
// a copied link or a new tab lands on the same section:
//
//   /app/?workspace=<id>&activityRepo=docs&doc=<slug>&section=<NN-name.md>[&anchor=<anchor>]
//
// ⚠ `doc` + `section` are held to the SAME strict grammar as every other library path
// (`parseLibraryPath`), so a crafted link opens nothing it could not open by clicking.

export interface DocsLinkTarget {
  /** Library-relative: `<slug>/sections/NN-name.md` (or a CONTENTS.md / INDEX.md). */
  path: string;
  anchor: string | null;
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
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}?${p.toString()}`;
}

/**
 * A deep link's target, from a query string, or null. `doc` alone opens that document's contents;
 * `doc` + `section` opens the section. Anything that fails the library grammar is null.
 */
export function parseDocsDeepLink(search: string): LibraryLocation | null {
  const p = new URLSearchParams(search);
  if (p.get('activityRepo') !== 'docs') return null;
  const doc = p.get('doc');
  if (doc == null || doc === '') return null;
  const section = p.get('section');
  const anchor = p.get('anchor');
  const path = section != null && section !== '' ? `${doc}/sections/${section}` : `${doc}/CONTENTS.md`;
  return parseLibraryPath(anchor != null && anchor !== '' ? `${path}#${anchor}` : path);
}
