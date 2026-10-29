import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REFERENCE_DOC_FIGURE_MAX_BYTES,
  REFERENCE_DOC_FIGURE_MAX_PER_DOC,
  REFERENCE_DOC_FIGURE_MIN_BYTES,
  REFERENCE_DOC_FIGURE_MIN_PIXELS,
  REFERENCE_DOC_FIGURE_PREFIX,
  type ReferenceDocFigures,
} from '@pierre-review/shared';

// FIGURES AS TEXT (docs/REFERENCE-DOCS.md § Figures). A library is text, so every image and diagram a
// source holds becomes words, in this order of preference:
//
//   1. ITS OWN SOURCE, no model: a Mermaid / PlantUML block stays a fenced block (it IS the diagram); a
//      draw.io or Gliffy diagram whose file can be read becomes a deterministic outline (diagram-outline.ts).
//   2. A DESCRIPTION by Claude's vision (one call per image), when Claude can run here.
//   3. Its NAME (`[Image: alt]`, `[Diagram: name]`) — icons, unsupported formats, past the cap, on Codex
//      (whose image input stays locked off) or with no Claude sign-in.
//
// HOW (two steps, so a description never needs the image's address again):
//
//   • AT INGEST (the converters and the wiki adapters): an image's bytes go to a FigureSink, which keeps
//     them in the document's `sources/<slug>/figures/<sha256>` and answers a MARKER that stands where the
//     image was: `[[limn-figure:<sha256>:<fallback>]]`. Tiny images (icons), non-raster formats and
//     oversized files answer null — the caller writes the fallback. A Notion file address expires in an
//     hour, so its bytes are read during the build that saw it, and only then.
//   • BEFORE THE SPLIT (`resolveFigures`, manager.ts): each marker becomes `[Figure (described by AI): …]`
//     from the description cache (keyed by the image hash, account-scoped — figure-cache.ts) or a new
//     vision call, or its fallback. A marker whose bytes this document does not hold resolves to its
//     fallback (a document's text cannot reach another document's description). At most
//     REFERENCE_DOC_FIGURE_MAX_PER_DOC distinct images are described per document.
//
// ⚠ An image is a STRANGER'S INPUT to the vision call (figure-describer.ts: describe only, follow
// nothing written in it). Its description is the MODEL'S words, labelled as such, and is never quote
// grounding (shared `withoutFigureDescriptions`).
// ⚠ A BACKGROUND refresh's description is an AUTOMATIC run: `allowNew` asks the budget gate first, and
// over budget the markers stay (counted `pending`) — the next refresh tries again.

export const FIGURE_MARKER_RE = /\[\[limn-figure:([0-9a-f]{64}):([^[\]\n|]{0,200})\]\]/g;
/** A generated description's longest text, in characters. */
export const FIGURE_DESCRIPTION_MAX_CHARS = 1200;
/** The cached answer for an image that carries no information (a logo, a decoration). */
export const DECORATIVE = 'DECORATIVE';
/** Images one build may download (a Notion page of screenshots, a web page of thumbnails). */
export const FIGURE_MAX_FETCHES_PER_BUILD = 60;

const HASH = /^[0-9a-f]{64}$/;

/** Fallback words safe inside a marker and a table cell: no brackets, pipes or line breaks. */
export function cleanFigureName(raw: string): string {
  return raw
    .replace(/[[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** `[Image: name]` / `[Diagram: name]` — what an image keeps when it is not described. */
export function figureFallbackText(fallback: string): string {
  const f = cleanFigureName(fallback);
  // An image with no alt text and no file name kept nothing before it was a figure: it keeps nothing.
  return f && f.toLowerCase() !== 'image' ? `[${f}]` : '';
}

export function figureMarker(hash: string, fallback: string): string {
  return `[[limn-figure:${hash}:${cleanFigureName(fallback)}]]`;
}

// ---- what an image is ----

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
}

/** The raster formats the vision call reads, with their pixel size from the header. Null otherwise. */
export function imageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buf.subarray(12, 16).toString('latin1');
    if (kind === 'VP8 ') return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { mime: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk the JPEG segments to the first frame header (bounded: each step moves forward).
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** Why an image is not worth a description, or null when it is. */
export function figureSkipReason(buf: Buffer, info: ImageInfo | null): 'format' | 'icon' | 'too_large' | null {
  if (!info) return 'format';
  if (buf.length > REFERENCE_DOC_FIGURE_MAX_BYTES) return 'too_large';
  if (buf.length < REFERENCE_DOC_FIGURE_MIN_BYTES || info.width < REFERENCE_DOC_FIGURE_MIN_PIXELS || info.height < REFERENCE_DOC_FIGURE_MIN_PIXELS) {
    return 'icon';
  }
  return null;
}

// ---- the sink (ingest) ----

/** Where converters and adapters put an image's bytes. */
export interface FigureSink {
  /** Keep an image; the MARKER to write where it was, or null (icon, format, size) — write the fallback. */
  add(bytes: Buffer, fallback: string): string | null;
  /** May this build download one more image? */
  canFetch(): boolean;
  /** Count a download (whatever came of it). */
  noteFetch(): void;
  /** The most bytes one download may read. */
  readonly maxBytes: number;
}

/** A document's figure folder: `sources/<slug>/figures/`. */
export function figuresDirOf(sourcesDir: string): string {
  return join(sourcesDir, 'figures');
}

/** A sink over a folder. Images are written once per hash (a repeated image is ONE figure). */
export function folderFigureSink(dir: string, maxFetches = FIGURE_MAX_FETCHES_PER_BUILD): FigureSink {
  let fetches = 0;
  return {
    maxBytes: REFERENCE_DOC_FIGURE_MAX_BYTES,
    canFetch: () => fetches < maxFetches,
    noteFetch: () => {
      fetches += 1;
    },
    add(bytes, fallback) {
      if (figureSkipReason(bytes, imageInfo(bytes)) != null) return null;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const file = join(dir, hash);
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, file);
      }
      return figureMarker(hash, fallback);
    },
  };
}

/** The stored bytes of one figure of this document, or null. */
export function readFigure(dir: string, hash: string): Buffer | null {
  if (!HASH.test(hash)) return null;
  try {
    return readFileSync(join(dir, hash));
  } catch {
    return null;
  }
}

/** After a successful build: drop the figure files the document no longer shows. */
export function pruneFigures(dir: string, markdown: string): void {
  if (!existsSync(dir)) return;
  const keep = new Set([...markdown.matchAll(FIGURE_MARKER_RE)].map((m) => m[1]!));
  for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f), { force: true });
}

/** The hashes a markdown text's markers name, in order, once each. */
export function figureHashes(markdown: string): string[] {
  const seen = new Set<string>();
  for (const m of markdown.matchAll(FIGURE_MARKER_RE)) seen.add(m[1]!);
  return [...seen];
}

// ---- resolving markers (before the split) ----

export interface DescribedFigure {
  /** The model's words, or DECORATIVE. */
  text: string;
}

export interface FigureResolveDeps {
  /** The image's bytes, when THIS document holds them. */
  read(hash: string): Buffer | null;
  /** Cached descriptions for these hashes (account-scoped). */
  cached(hashes: string[]): Promise<Map<string, string>>;
  /** Describe one image (a vision call), or null when no describer can run here. */
  describe: ((img: { bytes: Buffer; mime: ImageInfo['mime']; name: string }) => Promise<DescribedFigure>) | null;
  /** The one sentence for the build info when `describe` is null. */
  unavailableNote: string | null;
  /** Asked ONCE, before the first NEW description (the automatic budget gate). False ⇒ pending. */
  allowNew(): Promise<boolean>;
  /** Keep a new description (the cache). Failures are the caller's to swallow. */
  save(hash: string, text: string): Promise<void>;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

export interface FigureResolveResult {
  markdown: string;
  figures: ReferenceDocFigures | null;
  /** New vision calls made. */
  newDescriptions: number;
}

/** A model's answer → one line safe in the library: no brackets, pipes or line breaks; clipped. */
export function cleanDescription(raw: string): string {
  const t = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= FIGURE_DESCRIPTION_MAX_CHARS ? t : `${t.slice(0, FIGURE_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

/** `[Figure (described by AI): name — words]`. */
export function describedFigureText(fallback: string, description: string): string {
  const bare = cleanFigureName(fallback.replace(/^(?:Image|Diagram):\s*/i, ''));
  const name = bare.toLowerCase() === 'image' ? '' : bare;
  return `${REFERENCE_DOC_FIGURE_PREFIX}${name ? `${name} — ` : ''}${cleanDescription(description)}]`;
}

const isDecorative = (t: string): boolean => t.trim().replace(/[.!]$/, '').toUpperCase() === DECORATIVE;

/** Count the figures already text: fenced Mermaid / PlantUML blocks and diagram outlines. */
function countOutlined(markdown: string): number {
  let n = 0;
  for (const m of markdown.matchAll(/^(?:```|~~~)\s*(mermaid|plantuml|puml)\b/gim)) if (m) n += 1;
  for (const m of markdown.matchAll(/^\[Diagram outline\b/gm)) if (m) n += 1;
  return n;
}

/** Placeholders a converter wrote with no marker (no sink here, an icon, an unreadable diagram). */
function countNamed(markdown: string): number {
  let n = 0;
  for (const m of markdown.matchAll(/\[(?:Image|Diagram): [^\]\n]{0,200}\]/g)) if (m) n += 1;
  return n;
}

/**
 * Every marker → its description, or its fallback (header). Never throws on a describer failure: the
 * rest of the images wait for the next build (`pending`).
 */
export async function resolveFigures(markdown: string, deps: FigureResolveDeps): Promise<FigureResolveResult> {
  const hashes = figureHashes(markdown);
  const outlined = countOutlined(markdown);
  const named = countNamed(markdown);
  if (hashes.length === 0) {
    const any = outlined + named > 0;
    return {
      markdown,
      newDescriptions: 0,
      figures: any ? { described: 0, outlined, kept: named, pending: 0, note: named > 0 && deps.describe == null ? deps.unavailableNote : null } : null,
    };
  }
  const held = hashes.filter((h) => deps.read(h) != null);
  const cache = held.length > 0 ? await deps.cached(held) : new Map<string, string>();
  const text = new Map<string, string | null>(); // hash → description; null = keep the fallback
  const pendingSet = new Set<string>();
  const todo: string[] = [];
  let slots = REFERENCE_DOC_FIGURE_MAX_PER_DOC;
  const heldSet = new Set(held);
  for (const h of hashes) {
    if (!heldSet.has(h) || slots <= 0) {
      text.set(h, null);
      continue;
    }
    const c = cache.get(h);
    if (c != null) {
      text.set(h, isDecorative(c) ? null : c);
      slots -= 1;
    } else if (deps.describe) {
      todo.push(h);
      slots -= 1;
    } else text.set(h, null);
  }
  let made = 0;
  if (todo.length > 0 && deps.describe) {
    const firstName = new Map<string, string>();
    for (const m of markdown.matchAll(FIGURE_MARKER_RE)) if (!firstName.has(m[1]!)) firstName.set(m[1]!, m[2]!);
    if (!(await deps.allowNew())) for (const h of todo) pendingSet.add(h);
    else {
      for (let i = 0; i < todo.length; i++) {
        const h = todo[i]!;
        if (deps.signal?.aborted) {
          for (const r of todo.slice(i)) pendingSet.add(r);
          break;
        }
        const bytes = deps.read(h)!;
        const info = imageInfo(bytes);
        if (!info) {
          text.set(h, null);
          continue;
        }
        deps.onProgress?.(i + 1, todo.length);
        try {
          const out = await deps.describe({ bytes, mime: info.mime, name: (firstName.get(h) ?? '').replace(/^(?:Image|Diagram):\s*/i, '') });
          const answer = isDecorative(out.text) ? DECORATIVE : cleanDescription(out.text);
          made += 1;
          await deps.save(h, answer).catch(() => {});
          text.set(h, answer === DECORATIVE || answer === '' ? null : answer);
        } catch {
          // A failed call (no runtime, a network error): this image and the rest wait for the next build.
          for (const r of todo.slice(i)) pendingSet.add(r);
          break;
        }
      }
    }
  }
  let described = 0;
  let kept = 0;
  const seen = new Set<string>();
  const out = markdown.replace(FIGURE_MARKER_RE, (_m, h: string, fallback: string) => {
    const first = !seen.has(h);
    seen.add(h);
    const t = text.get(h);
    if (t) {
      if (first) described += 1;
      return describedFigureText(fallback, t);
    }
    if (first && !pendingSet.has(h)) kept += 1;
    return figureFallbackText(fallback);
  });
  const pending = pendingSet.size;
  const note = deps.describe == null && (hashes.length > 0 || named > 0) ? deps.unavailableNote : null;
  return { markdown: out, newDescriptions: made, figures: { described, outlined, kept: kept + named, pending, note } };
}

/** The stored `figures_json` → the wire shape (defensive: a stranger's edit of the DB is not trusted). */
export function figuresOf(raw: unknown): ReferenceDocFigures | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Partial<ReferenceDocFigures>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    described: n(o.described),
    outlined: n(o.outlined),
    kept: n(o.kept),
    pending: n(o.pending),
    note: typeof o.note === 'string' && o.note !== '' ? o.note.slice(0, 300) : null,
  };
}
