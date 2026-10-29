import { REFERENCE_DOC_MAX_BYTES, type ReferenceDocSourceKind } from '@pierre-review/shared';
import {
  AiRuntimeMissingError,
  loadMammoth,
  loadTurndown,
  loadTurndownGfm,
  type TurndownService,
} from '../ai/runtime.js';
import { dataUriBytes } from './figure-fetch.js';
import type { FigureSink } from './figures.js';
import { cleanHeadingTitle, normalizeMarkdown, parseBlocks } from './split.js';

// WHAT A FILE IS, AND ITS MARKDOWN (docs/REFERENCE-DOCS.md § Ingest).
//
// The KIND is decided from the BYTES, never from the file name or the browser's MIME type alone: a
// renamed binary is not a text file. The name only tells markdown from plain text from HTML once the
// bytes are known to be text.
//
//   pdf        `%PDF-` near the start. NOT converted here: Claude reads it natively in the build.
//   docx       a zip carrying `word/document.xml` → mammoth (Word → HTML) → turndown (→ markdown).
//   html       text that is a web page (by name, or by its doctype / <html>) → turndown.
//   markdown   text named .md / .markdown / .mdx → as is.
//   text       any other UTF-8 (or UTF-16 with a BOM) text → as is.
//
// mammoth and turndown are NOT npm dependencies of the published package: they ride the AI runtime
// download (ai/runtime.ts), so a converter that is missing says "Set up AI again" and nothing else.

export type SniffResult =
  | { ok: true; kind: Exclude<ReferenceDocSourceKind, 'url' | 'wiki'>; ext: string }
  | { ok: false; message: string };

export const UNSUPPORTED_MESSAGE =
  'This file type is not supported. Upload a PDF, a Word .docx file, a text or markdown file, or a web page.';

const extOf = (name: string): string => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
};

const startsWithBytes = (buf: Buffer, bytes: number[]): boolean => bytes.every((b, i) => buf[i] === b);

/** Decode text, or null when the bytes are not text (NULs, invalid UTF-8). */
export function decodeText(buf: Buffer): string | null {
  if (startsWithBytes(buf, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (startsWithBytes(buf, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

const looksLikeHtml = (text: string): boolean => /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>])/i.test(text.slice(0, 4096));

/** Decide the kind of an uploaded file from its bytes (and, for text, its name). */
export function sniffUpload(buf: Buffer, filename: string): SniffResult {
  if (buf.length === 0) return { ok: false, message: 'The file is empty.' };
  if (buf.length > REFERENCE_DOC_MAX_BYTES) {
    return { ok: false, message: `The file is too large. The limit is ${REFERENCE_DOC_MAX_BYTES / (1024 * 1024)} MB.` };
  }
  const ext = extOf(filename);
  if (buf.subarray(0, 1024).includes(Buffer.from('%PDF-', 'latin1'))) return { ok: true, kind: 'pdf', ext: 'pdf' };
  if (startsWithBytes(buf, [0x50, 0x4b, 0x03, 0x04])) {
    // A zip. Word's main part is named in the local file headers, uncompressed.
    if (buf.includes(Buffer.from('word/document.xml', 'latin1'))) return { ok: true, kind: 'docx', ext: 'docx' };
    return { ok: false, message: 'Only Word .docx files are read from zip archives.' };
  }
  if (startsWithBytes(buf, [0xd0, 0xcf, 0x11, 0xe0])) {
    return { ok: false, message: 'Old Word .doc files are not read. Save it as .docx and upload that.' };
  }
  if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') {
    return { ok: false, message: 'Rich text (.rtf) files are not read. Save it as .docx or PDF and upload that.' };
  }
  const text = decodeText(buf);
  if (text == null) return { ok: false, message: UNSUPPORTED_MESSAGE };
  if (['md', 'markdown', 'mdx'].includes(ext)) return { ok: true, kind: 'markdown', ext: 'md' };
  if (['html', 'htm', 'xhtml'].includes(ext) || looksLikeHtml(text)) return { ok: true, kind: 'html', ext: 'html' };
  return { ok: true, kind: 'text', ext: 'txt' };
}

/** A web page's body → the same kinds (a URL may serve a PDF, plain text or markdown too). */
export function sniffFetched(buf: Buffer, contentType: string, url: string): SniffResult {
  const ct = contentType.toLowerCase();
  if (ct.includes('application/pdf')) return sniffUpload(buf, 'page.pdf');
  if (ct.includes('markdown')) return sniffUpload(buf, 'page.md');
  if (ct.includes('text/plain')) {
    const name = /\.(md|markdown)$/i.test(new URL(url).pathname) ? 'page.md' : 'page.txt';
    return sniffUpload(buf, name);
  }
  if (ct.includes('html') || ct === '') return sniffUpload(buf, 'page.html');
  return { ok: false, message: 'That address does not serve a web page, a PDF or text.' };
}

/** A PDF's page count, read from its page tree when the file exposes it. Null when it cannot tell. */
export function pdfPageCount(buf: Buffer): number | null {
  const s = buf.toString('latin1');
  let pages = 0;
  for (const _ of s.matchAll(/\/Type\s*\/Page(?![a-zA-Z])/g)) pages += 1;
  if (pages > 0) return pages;
  let max = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)|\/Count\s+(\d+)[\s\S]{0,400}?\/Type\s*\/Pages/g)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}

export class ConverterMissingError extends Error {
  constructor() {
    super('Reading Word files and web pages needs the latest AI download. Press "Set up AI" again, then rebuild.');
    this.name = 'ConverterMissingError';
  }
}

const SAFE_HREF = /^(?:https?:|mailto:|#)/i;

/** What an HTML conversion may do with its images (docs/REFERENCE-DOCS.md § Figures). */
export interface HtmlFigureOptions {
  /** Keep images as figures (their bytes stored, a marker in the text). Absent ⇒ alt text only. */
  figures?: FigureSink;
  /** Bytes already downloaded for a page's images, by absolute address. */
  images?: ReadonlyMap<string, Buffer>;
  /** The page's own address, to resolve a relative `src`. */
  baseUrl?: string;
}

const fileNameOf = (src: string): string => {
  if (/^data:/i.test(src)) return '';
  const last = src.split(/[?#]/)[0]!.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last).slice(0, 120);
  } catch {
    return last.slice(0, 120);
  }
};

async function turndownService(fig: HtmlFigureOptions = {}): Promise<TurndownService> {
  let Turndown;
  let gfm;
  try {
    [Turndown, gfm] = await Promise.all([loadTurndown(), loadTurndownGfm()]);
  } catch (err) {
    if (err instanceof AiRuntimeMissingError) throw new ConverterMissingError();
    throw err;
  }
  const t = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '_' });
  t.use(gfm.gfm);
  t.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'nav', 'footer', 'form', 'button', 'svg', 'canvas', 'template']);
  // Images become their alt text: a library is text, and a `data:` image from a Word file can be
  // megabytes of base64 an agent would otherwise have to read past. With a figure sink, an image whose
  // bytes are at hand (inline, or downloaded for the page) becomes a FIGURE marker instead — described
  // by AI before the split, or its name again (figures.ts).
  t.addRule('limnImages', {
    filter: 'img',
    replacement: (_content: string, node: { getAttribute(n: string): string | null }) => {
      const alt = (node.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
      if (fig.figures) {
        const src = (node.getAttribute('src') ?? '').trim();
        let bytes = dataUriBytes(src);
        if (!bytes && fig.images && src) {
          try {
            bytes = fig.images.get(new URL(src, fig.baseUrl).href) ?? null;
          } catch {
            bytes = null;
          }
        }
        const name = alt || fileNameOf(src);
        const marker = bytes ? fig.figures.add(bytes, name ? `Image: ${name}` : 'Image') : null;
        if (marker) return marker;
      }
      return alt ? `[Image: ${alt}]` : '';
    },
  });
  // Only ordinary links survive; anything else (javascript:, data:, a relative path into a site the
  // library does not hold) keeps its text and loses its target.
  t.addRule('limnLinks', {
    filter: (node: { nodeName: string; getAttribute(n: string): string | null }) =>
      node.nodeName === 'A' && !SAFE_HREF.test((node.getAttribute('href') ?? '').trim()),
    replacement: (content: string) => content,
  });
  return t;
}

/** The text of the first top-level heading, as a title. */
function firstHeading(markdown: string): string | null {
  for (const b of parseBlocks(markdown.slice(0, 50_000))) {
    if (b.kind === 'heading' && b.level <= 2) return b.title;
  }
  return null;
}

function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 100_000));
  if (!m) return null;
  const t = cleanHeadingTitle(m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'));
  return t || null;
}

/** HTML → markdown (turndown + GitHub tables), narrowed to the page's <main> / <article> when it has one. */
export async function htmlToMarkdown(html: string, fig: HtmlFigureOptions = {}): Promise<string> {
  const t = await turndownService(fig);
  // A page's main content, when it marks it: the nav, sidebars and cookie banners around it are noise.
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0];
  return normalizeMarkdown(t.turndown(main ?? html)).trim();
}

export interface Converted {
  markdown: string;
  /** A title the document gives itself, when it has one. */
  title: string | null;
}

/** A non-PDF source → markdown. Throws ConverterMissingError when a converter is not installed. */
export async function convertToMarkdown(
  kind: Exclude<ReferenceDocSourceKind, 'pdf' | 'url' | 'wiki'>,
  buf: Buffer,
  fig: HtmlFigureOptions = {},
): Promise<Converted> {
  switch (kind) {
    case 'text':
    case 'markdown': {
      const markdown = normalizeMarkdown(decodeText(buf) ?? '').trim();
      return { markdown, title: firstHeading(markdown) };
    }
    case 'html': {
      const html = decodeText(buf) ?? '';
      const markdown = await htmlToMarkdown(html, fig);
      return { markdown, title: htmlTitle(html) ?? firstHeading(markdown) };
    }
    case 'docx': {
      let mammoth;
      try {
        mammoth = await loadMammoth();
      } catch (err) {
        if (err instanceof AiRuntimeMissingError) throw new ConverterMissingError();
        throw err;
      }
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      const markdown = await htmlToMarkdown(value, fig);
      return { markdown, title: firstHeading(markdown) };
    }
  }
}
