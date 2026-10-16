import type { ReferenceDocCitation, ReferenceDocSectionEntry, ReferenceDocStatus } from '@pierre-review/shared';

// THE DOCS RAIL LINE'S PURE HALF (Activity → Docs; docs/REFERENCE-DOCS.md § The SPA). No React, no
// fetch, so the unit test imports it directly.
//
// ⚠ ONE LINK RESOLVER for every markdown the pane draws: INDEX.md, a CONTENTS.md, a section, and the
// chat's answers. Every library file is written by the SERVER with RELATIVE links (`<slug>/CONTENTS.md`
// from INDEX, `sections/NN-name.md#anchor` from CONTENTS, `02-next.md` / `../CONTENTS.md` from a
// section), and the chat cites `<slug>/sections/NN-name.md#anchor` from the library root. So a link is
// resolved against the file it sits in, then held to the SAME strict grammar the server's
// `parseLibraryPath` uses — anything that fails it is not an in-app link (and not a fetch either).

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECTION_FILE = /^[0-9]{2,4}-[a-z0-9-]{0,48}\.md$/;
const ANCHOR = /^[a-z0-9_-]{1,120}$/i;

export type LibraryFileKind = 'index' | 'contents' | 'section';

export interface LibraryLocation {
  /** Library-relative, exactly as GET /api/docs/section takes it. */
  path: string;
  kind: LibraryFileKind;
  /** The document's slug; null for INDEX.md. */
  slug: string | null;
  anchor: string | null;
}

/** The master contents' path — what the viewer opens when nothing else is open. */
export const LIBRARY_INDEX_PATH = 'INDEX.md';

/**
 * The client's copy of the server's strict grammar: `INDEX.md`, `<slug>/CONTENTS.md` or
 * `<slug>/sections/NN-name.md`, with an optional plain `#anchor`. Null for anything else.
 */
export function parseLibraryPath(raw: string): LibraryLocation | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  const hash = raw.indexOf('#');
  const bare = hash >= 0 ? raw.slice(0, hash) : raw;
  const anchorRaw = hash >= 0 ? raw.slice(hash + 1) : null;
  const anchor = anchorRaw != null && ANCHOR.test(anchorRaw) ? anchorRaw : null;
  const clean = bare.startsWith('./') ? bare.slice(2) : bare;
  if (clean === LIBRARY_INDEX_PATH) return { path: LIBRARY_INDEX_PATH, kind: 'index', slug: null, anchor };
  const parts = clean.split('/');
  if (parts.length === 2 && SLUG.test(parts[0]!) && parts[1] === 'CONTENTS.md') {
    return { path: clean, kind: 'contents', slug: parts[0]!, anchor };
  }
  if (parts.length === 3 && SLUG.test(parts[0]!) && parts[1] === 'sections' && SECTION_FILE.test(parts[2]!)) {
    return { path: clean, kind: 'section', slug: parts[0]!, anchor };
  }
  return null;
}

export type ResolvedDocLink =
  | { kind: 'library'; location: LibraryLocation }
  /** `#anchor` alone: a heading in the file on screen. */
  | { kind: 'anchor'; anchor: string }
  /** An absolute URL. The caller still passes it through `safeExternalUrl`. */
  | { kind: 'external'; href: string }
  /** Not a link the pane can follow — render the text only. */
  | { kind: 'none' };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a link found in the library file at `fromPath` (use `LIBRARY_INDEX_PATH` for text that
 * speaks from the library root, like a chat answer).
 */
export function resolveDocLink(fromPath: string, rawHref: string | null | undefined): ResolvedDocLink {
  if (rawHref == null) return { kind: 'none' };
  const href = rawHref.trim().replace(/^<|>$/g, '');
  if (href === '') return { kind: 'none' };
  if (href.startsWith('#')) {
    const a = href.slice(1);
    return ANCHOR.test(a) ? { kind: 'anchor', anchor: a } : { kind: 'none' };
  }
  if (SCHEME.test(href)) return { kind: 'external', href };
  // Root-relative, protocol-relative, backslashes, percent-encoding, query strings: never library paths.
  if (href.startsWith('/') || href.includes('\\') || href.includes('%') || href.includes('?')) return { kind: 'none' };
  const hash = href.indexOf('#');
  const bare = hash >= 0 ? href.slice(0, hash) : href;
  const anchorPart = hash >= 0 ? href.slice(hash) : '';
  const base = fromPath.split('/').slice(0, -1);
  const out = [...base];
  for (const seg of bare.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return { kind: 'none' }; // above the library root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const location = parseLibraryPath(`${out.join('/')}${anchorPart}`);
  return location ? { kind: 'library', location } : { kind: 'none' };
}

/** The server's heading anchor (split.ts `headingAnchor`), so `#anchor` links land on the heading. */
export function headingAnchor(title: string): string {
  const a = title
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  if (/^[a-z0-9_-]{1,120}$/.test(a)) return a;
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `h-${h.toString(36)}`;
}

/** Anchors for a file's headings in order, numbered for duplicates the way the server numbers them. */
export function headingAnchors(titles: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((t) => {
    const base = headingAnchor(t);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  });
}

// ---- one document's contents tree ----

export type DocTreeRow =
  /** A heading with no text of its own: its title, not a link. */
  | { kind: 'group'; key: string; title: string; depth: number }
  | { kind: 'section'; key: string; title: string; depth: number; path: string; summary: string }
  /** A heading merged into a section: a link to that section at its anchor. */
  | { kind: 'heading'; key: string; title: string; depth: number; path: string; anchor: string };

/**
 * The rows of a document's tree, in reading order — the same shape the server writes into
 * CONTENTS.md (`render.ts` `renderContents`): a plain row for each heading that only encloses others
 * (once), a row per section file nested by depth, and a row per heading merged into a section.
 */
export function docTreeRows(sections: readonly ReferenceDocSectionEntry[]): DocTreeRow[] {
  const rows: DocTreeRow[] = [];
  const emitted = new Set<string>();
  for (const e of sections) {
    e.trail.forEach((t, i) => {
      const key = e.trail.slice(0, i + 1).join('\u0000');
      if (emitted.has(key)) return;
      emitted.add(key);
      rows.push({ kind: 'group', key: `g:${key}`, title: t, depth: i + 1 });
    });
    emitted.add([...e.trail, e.title].join('\u0000'));
    const depth = Math.max(1, Math.min(e.depth, e.trail.length + 1));
    rows.push({ kind: 'section', key: `s:${e.path}`, title: e.title, depth, path: e.path, summary: e.summary.trim() });
    for (const h of e.headings) {
      rows.push({
        kind: 'heading',
        key: `h:${e.path}#${h.anchor}`,
        title: h.title,
        depth: depth + Math.max(1, h.depth - e.depth),
        path: e.path,
        anchor: h.anchor,
      });
    }
  }
  return rows;
}

/** A chat citation's words: the document, then the section when there is one. */
export function citationLabel(c: ReferenceDocCitation): string {
  return c.sectionTitle != null && c.sectionTitle !== '' ? `${c.docTitle} › ${c.sectionTitle}` : c.docTitle;
}

// ---- building ----

export function isDocBuilding(status: ReferenceDocStatus): boolean {
  return status === 'queued' || status === 'converting' || status === 'sectioning' || status === 'indexing';
}

/**
 * ⚠ THE HARD CAP ON CONCURRENT BUILD STREAMS. Each stream holds an HTTP/1.1 connection open (the
 * browser allows ~6 per origin), and the pane's uploads, list poll, tree/section reads and chat all
 * queue behind them. The server builds ONE document per account at a time, so a QUEUED row is never
 * streamed — the list poll covers it.
 */
export const MAX_DOC_STREAMS = 2;

/**
 * Which documents get a live stream: those the server is actually working on (building, not
 * `queued`), minus any whose stream already failed or ended without `done` (`trouble` — the fast
 * poll covers those), at most `MAX_DOC_STREAMS`.
 */
export function docsToStream(
  docs: ReadonlyArray<{ id: number; status: ReferenceDocStatus }>,
  trouble: ReadonlySet<number>,
): number[] {
  return docs
    .filter((d) => isDocBuilding(d.status) && d.status !== 'queued' && !trouble.has(d.id))
    .slice(0, MAX_DOC_STREAMS)
    .map((d) => d.id);
}

/**
 * The library list's poll interval: never when nothing builds; 3s while a building document has no
 * healthy stream (it failed, or ended without `done`); 5s while a building document is not streamed
 * at all (queued, or past the cap) so its start is noticed; else a 15s safety net.
 */
export function docsListPollMs(
  docs: ReadonlyArray<{ id: number; status: ReferenceDocStatus }>,
  trouble: ReadonlySet<number>,
): number | false {
  const building = docs.filter((d) => isDocBuilding(d.status));
  if (building.length === 0) return false;
  if (building.some((d) => trouble.has(d.id))) return 3_000;
  const streamed = new Set(docsToStream(docs, trouble));
  if (building.some((d) => !streamed.has(d.id))) return 5_000;
  return 15_000;
}

/** The progress bar's words for a build's stage. */
export function docStageLabel(status: ReferenceDocStatus): string {
  switch (status) {
    case 'queued':
      return 'Waiting to start';
    case 'converting':
      return 'Converting';
    case 'sectioning':
      return 'Splitting into sections';
    case 'indexing':
      return 'Indexing';
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Failed';
  }
}

/** What the file picker offers. The server decides the kind from the bytes; this only saves a trip. */
export const DOC_UPLOAD_ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.html,.htm';

/**
 * Null when the file may be sent, else the sentence to show beside its name. Only the refusals the
 * client can be sure of: the server reads the BYTES (any text file is accepted whatever its name), so
 * an unfamiliar extension is left to it.
 */
export function uploadRefusal(name: string, size: number, maxBytes: number): string | null {
  const ext = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'doc' || ext === 'rtf') return 'Save it as .docx first.';
  if (size === 0) return 'The file is empty.';
  if (size > maxBytes) return `The file is over ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  return null;
}

// ---- heading anchors in the viewer (a rehype plugin, run AFTER the sanitizer) ----
//
// The sanitizer prefixes every `id` with `user-content-`, and a document's own HTML could carry
// ids of its own, so the viewer never scrolls by `id`: each heading gets `data-doc-anchor` with
// the server's anchor for its text, and the viewer looks that attribute up in its own box.

interface HNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const HEADING = /^h[1-6]$/;

function textOf(n: HNode): string {
  if (n.type === 'text') return n.value ?? '';
  return (n.children ?? []).map(textOf).join('');
}

/** Mark every heading in a rendered tree with its anchor. Exported for the test. */
export function markHeadingAnchors(tree: HNode): void {
  const headings: HNode[] = [];
  const walk = (n: HNode): void => {
    if (n.type === 'element' && n.tagName != null && HEADING.test(n.tagName)) headings.push(n);
    else for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  const anchors = headingAnchors(headings.map((h) => textOf(h).replace(/\s+/g, ' ').trim()));
  headings.forEach((h, i) => {
    h.properties = { ...(h.properties ?? {}), dataDocAnchor: anchors[i] };
  });
}

export function rehypeDocHeadingAnchors(): (tree: HNode) => void {
  return (tree) => markHeadingAnchors(tree);
}
