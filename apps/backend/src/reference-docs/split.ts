import {
  REFERENCE_DOC_SECTION_HARD_CAP_CHARS,
  REFERENCE_DOC_SECTION_HARD_CAP_WORDS,
  REFERENCE_DOC_SECTION_TARGET_MAX_WORDS,
  REFERENCE_DOC_SECTION_TARGET_MIN_WORDS,
} from '@pierre-review/shared';

// THE SECTION SPLITTER — deterministic, no model (docs/REFERENCE-DOCS.md § Sections).
//
// A document's markdown is split ALONG ITS OWN STRUCTURE (its headings) into sections an agent can
// read one at a time without overloading its context:
//
//   1. PARSE into blocks — headings (ATX and setext), fenced code, tables, paragraphs. A fence or a
//      table is ATOMIC: nothing inside one is ever read as a heading, and no split falls inside one
//      while another place to split exists.
//   2. CHUNK at every heading. Each chunk knows its TRAIL (the headings above it), so its depth is
//      structural (how many headings enclose it), never the raw `#` count.
//   3. MERGE a chunk still under the target minimum with the chunk after it, when that chunk is its
//      sibling or inside it and the two together stay under the target maximum. The merged heading
//      stays in the text (and in CONTENTS.md, as an anchor link), so nothing is lost from the tree.
//   4. SPLIT a chunk over the HARD CAP into parts at block boundaries. A single block over the cap
//      (a giant table, a long code listing, a wall of text) is cut by rows or lines — a table repeats
//      its header row and a code part re-opens its fence — so the cap really is hard.
//
// The same step 4 runs on the sections Claude writes from a PDF (`splitWrittenSection`), so every
// section on disk obeys one cap whichever way it was made.

export const MIN_WORDS = REFERENCE_DOC_SECTION_TARGET_MIN_WORDS;
export const MAX_WORDS = REFERENCE_DOC_SECTION_TARGET_MAX_WORDS;
export const HARD_CAP_WORDS = REFERENCE_DOC_SECTION_HARD_CAP_WORDS;
export const HARD_CAP_CHARS = REFERENCE_DOC_SECTION_HARD_CAP_CHARS;
// Parts are packed to this many characters (the hard cap leaves room for a section's header).
const PACK_CHARS = 12_000;
/** A document past either limit is refused rather than split into an unreadable tree. */
export const MAX_DOC_WORDS = 200_000;
export const MAX_SECTIONS = 600;

export type Block =
  | { kind: 'heading'; level: number; title: string }
  | { kind: 'code'; open: string; close: string; lines: string[] }
  | { kind: 'table'; lines: string[] }
  | { kind: 'para'; lines: string[] };

/** A heading merged into a section: it stays in the text and becomes an anchor in CONTENTS.md. */
export interface SubHeading {
  title: string;
  depth: number;
  anchor: string;
}

export interface DraftSection {
  title: string;
  depth: number;
  /** The titles of the headings above this one, outermost first. */
  trail: string[];
  /** The markdown body, WITHOUT the section's own heading. */
  body: string;
  words: number;
  chars: number;
  subheadings: SubHeading[];
}

// ---- text helpers ----

/** CRLF → LF, no BOM, no NULs or other control characters (tab and newline survive). */
export function normalizeMarkdown(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

export function countWords(text: string): number {
  let n = 0;
  for (const w of text.split(/\s+/)) if (w !== '') n += 1;
  return n;
}

/** A GitHub-style heading anchor (lower case, punctuation dropped, spaces → hyphens). */
export function headingAnchor(title: string): string {
  const a = title
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  // Only ASCII-safe anchors are linkable (parseLibraryPath's grammar); others fall back to a hash.
  if (/^[a-z0-9_-]{1,120}$/.test(a)) return a;
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `h-${h.toString(36)}`;
}

/** Clean a heading's text: inline markup and trailing `#`s off, one line, ≤ 160 characters. */
export function cleanHeadingTitle(raw: string): string {
  const t = raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t;
}

// ---- 1. blocks ----

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
const TABLE_LINE = /^\s*\|/;

export function parseBlocks(markdown: string): Block[] {
  const lines = normalizeMarkdown(markdown).split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'para', lines: para });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      flush();
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[2]!.startsWith('`') && fence[3]!.includes('`'))) {
      flush();
      const marker = fence[2]!;
      const body: string[] = [];
      let close = marker;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (m && m[1]![0] === marker[0] && m[1]!.length >= marker.length) {
          close = m[1]!;
          break;
        }
        body.push(l);
      }
      blocks.push({ kind: 'code', open: line.trimEnd(), close, lines: body });
      i = j; // the closing fence (or the end)
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      flush();
      const title = cleanHeadingTitle((atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''));
      if (title !== '') blocks.push({ kind: 'heading', level: atx[1]!.length, title });
      continue;
    }
    if (para.length === 1 && (SETEXT_1.test(line) || SETEXT_2.test(line))) {
      const title = cleanHeadingTitle(para[0]!);
      para = [];
      if (title !== '') blocks.push({ kind: 'heading', level: SETEXT_1.test(line) ? 1 : 2, title });
      continue;
    }
    if (TABLE_LINE.test(line) && para.length === 0) {
      const rows: string[] = [];
      let j = i;
      for (; j < lines.length && TABLE_LINE.test(lines[j]!); j++) rows.push(lines[j]!);
      blocks.push({ kind: 'table', lines: rows });
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export function blockText(b: Block): string {
  switch (b.kind) {
    case 'heading':
      return `${'#'.repeat(b.level)} ${b.title}`;
    case 'code':
      return [b.open, ...b.lines, b.close].join('\n');
    case 'table':
    case 'para':
      return b.lines.join('\n');
  }
}

// ---- 2-4. sections ----

type Item = { kind: 'block'; block: Block } | { kind: 'sub'; title: string; depth: number };

interface Chunk {
  title: string;
  depth: number;
  trail: string[];
  items: Item[];
}

const itemText = (it: Item, baseDepth: number): string =>
  it.kind === 'block'
    ? blockText(it.block)
    : `${'#'.repeat(Math.min(6, 2 + Math.max(0, it.depth - baseDepth - 1)))} ${it.title}`;
const itemWords = (it: Item): number => countWords(it.kind === 'block' ? blockText(it.block) : it.title);
const itemChars = (it: Item, baseDepth: number): number => itemText(it, baseDepth).length + 2;
const chunkWords = (c: Chunk): number => c.items.reduce((n, it) => n + itemWords(it), 0);
const chunkChars = (c: Chunk): number => c.items.reduce((n, it) => n + itemChars(it, c.depth), 0);
const startsWith = (a: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= a.length && prefix.every((p, i) => a[i] === p);

/** Cut one over-long line (minified text, one huge paragraph) by words, then by characters. */
function cutLine(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let words = 0;
  for (const tok of raw.split(/(\s+)/)) {
    if (tok === '') continue;
    const space = /^\s+$/.test(tok);
    if (cur !== '' && ((!space && words + 1 > MAX_WORDS) || cur.length + tok.length > PACK_CHARS)) {
      out.push(cur);
      cur = '';
      words = 0;
      if (space) continue;
    }
    let t = tok;
    // A single "word" longer than the character target (no spaces at all).
    while (t.length > PACK_CHARS) {
      if (cur !== '') {
        out.push(cur);
        cur = '';
        words = 0;
      }
      out.push(t.slice(0, PACK_CHARS));
      t = t.slice(PACK_CHARS);
    }
    cur += t;
    if (!space && t !== '') words += 1;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/** Pack lines into runs under the target; `keep` (a table's header) opens every run. */
function packLines(lines: readonly string[], keep: readonly string[] = []): string[][] {
  const keepWords = countWords(keep.join('\n'));
  const keepChars = keep.join('\n').length;
  const out: string[][] = [];
  let cur: string[] = [];
  let words = 0;
  let chars = 0;
  const open = (): void => {
    cur = [...keep];
    words = keepWords;
    chars = keepChars;
  };
  open();
  for (const raw of lines) {
    const pieces = countWords(raw) > MAX_WORDS || raw.length > PACK_CHARS ? cutLine(raw) : [raw];
    for (const p of pieces) {
      const w = countWords(p);
      const ch = p.length + 1;
      if (cur.length > keep.length && (words + w > MAX_WORDS || chars + ch > PACK_CHARS)) {
        out.push(cur);
        open();
      }
      cur.push(p);
      words += w;
      chars += ch;
    }
  }
  if (cur.length > keep.length) out.push(cur);
  return out;
}

/** Cut one block that is over the target into pieces under it (a fence re-opens per piece). */
function cutBlock(b: Block): Block[] {
  switch (b.kind) {
    case 'code':
      return packLines(b.lines).map((lines) => ({ ...b, lines }));
    case 'table': {
      const sep = b.lines[1] != null && /^\s*\|?\s*:?-{2,}/.test(b.lines[1]) ? 2 : 0;
      return packLines(b.lines.slice(sep), b.lines.slice(0, sep)).map((lines) => ({ kind: 'table' as const, lines }));
    }
    case 'para':
      return packLines(b.lines).map((lines) => ({ kind: 'para' as const, lines }));
    case 'heading':
      return [b];
  }
}

function overCap(words: number, chars: number): boolean {
  return words > HARD_CAP_WORDS || chars > HARD_CAP_CHARS;
}

/** Step 4: a chunk over the hard cap → parts packed to the target. Under it → the chunk itself. */
function splitChunk(c: Chunk): Chunk[] {
  if (!overCap(chunkWords(c), chunkChars(c))) return [c];
  const items: Item[] = [];
  for (const it of c.items) {
    if (it.kind === 'block' && (itemWords(it) > MAX_WORDS || itemChars(it, c.depth) > PACK_CHARS)) {
      for (const piece of cutBlock(it.block)) items.push({ kind: 'block', block: piece });
    } else {
      items.push(it);
    }
  }
  const parts: Item[][] = [];
  let cur: Item[] = [];
  let words = 0;
  let chars = 0;
  for (const it of items) {
    const w = itemWords(it);
    const ch = itemChars(it, c.depth);
    if (cur.length > 0 && (words + w > MAX_WORDS || chars + ch > PACK_CHARS)) {
      parts.push(cur);
      cur = [];
      words = 0;
      chars = 0;
    }
    cur.push(it);
    words += w;
    chars += ch;
  }
  if (cur.length > 0) parts.push(cur);
  if (parts.length <= 1) return [{ ...c, items }];
  return parts.map((p, i) => ({
    ...c,
    title: `${c.title} (part ${i + 1} of ${parts.length})`,
    items: p,
  }));
}

function toDraft(c: Chunk): DraftSection {
  const seen = new Map<string, number>();
  const anchorFor = (title: string): string => {
    const base = headingAnchor(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  anchorFor(c.title); // the section's own H1 takes the first anchor of its name
  const body = c.items.map((it) => itemText(it, c.depth)).join('\n\n').trim();
  const subheadings: SubHeading[] = [];
  for (const it of c.items) {
    if (it.kind === 'sub') subheadings.push({ title: it.title, depth: it.depth, anchor: anchorFor(it.title) });
  }
  return { title: c.title, depth: c.depth, trail: c.trail, body, words: countWords(body), chars: body.length, subheadings };
}

export class DocumentTooLongError extends Error {
  constructor(readonly words: number, readonly sections: number) {
    super(
      sections > MAX_SECTIONS
        ? `This document is too long: it would make ${sections} sections and the limit is ${MAX_SECTIONS}.`
        : `This document is too long: about ${Math.round(words / 1000)}k words, and the limit is ${MAX_DOC_WORDS / 1000}k.`,
    );
    this.name = 'DocumentTooLongError';
  }
}

/**
 * Split a document's markdown into sections (steps 1-4). `fallbackTitle` names the text before the
 * first heading. Throws DocumentTooLongError past MAX_DOC_WORDS or MAX_SECTIONS.
 */
export function splitMarkdown(markdown: string, fallbackTitle: string): DraftSection[] {
  const blocks = parseBlocks(markdown);
  const total = blocks.reduce((n, b) => n + countWords(blockText(b)), 0);
  if (total > MAX_DOC_WORDS) throw new DocumentTooLongError(total, 0);

  // 2. chunk at every heading, with a structural trail.
  const chunks: Chunk[] = [{ title: fallbackTitle, depth: 1, trail: [], items: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= b.level) stack.pop();
      const trail = stack.map((s) => s.title);
      chunks.push({ title: b.title, depth: Math.min(6, trail.length + 1), trail, items: [] });
      stack.push({ level: b.level, title: b.title });
    } else {
      chunks[chunks.length - 1]!.items.push({ kind: 'block', block: b });
    }
  }
  if (chunks[0]!.items.length === 0) chunks.shift();

  // 3. merge a short chunk with the next one, inside its own scope.
  const merged: Chunk[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (
      prev != null &&
      chunkWords(prev) < MIN_WORDS &&
      chunkWords(prev) + chunkWords(c) + countWords(c.title) <= MAX_WORDS &&
      chunkChars(prev) + chunkChars(c) <= PACK_CHARS &&
      c.depth >= prev.depth &&
      startsWith(c.trail, prev.trail)
    ) {
      prev.items.push({ kind: 'sub', title: c.title, depth: c.depth }, ...c.items);
      continue;
    }
    merged.push({ ...c, items: [...c.items] });
  }

  // 4. split anything over the hard cap; drop chunks with no text at all (a heading straight
  //    followed by another — its title survives in the trail of what is under it).
  const out: DraftSection[] = [];
  for (const c of merged) {
    for (const part of splitChunk(c)) {
      const d = toDraft(part);
      if (d.body === '' && d.subheadings.length === 0) continue;
      out.push(d);
    }
  }
  if (out.length > MAX_SECTIONS) throw new DocumentTooLongError(total, out.length);
  return out;
}

/**
 * Step 4 alone, over ONE section Claude wrote (a PDF build): returns the section itself when it is
 * under the hard cap, else its parts. A leading H1 repeating the section's title is dropped (the
 * server writes the heading itself).
 */
export function splitWrittenSection(
  title: string,
  depth: number,
  trail: string[],
  text: string,
): DraftSection[] {
  let blocks = parseBlocks(text);
  const first = blocks[0];
  if (first?.kind === 'heading' && first.title.toLowerCase() === cleanHeadingTitle(title).toLowerCase()) {
    blocks = blocks.slice(1);
  }
  // Claude's own headings inside the section become anchors in CONTENTS.md, one level below it.
  const items: Item[] = blocks.map((b) =>
    b.kind === 'heading' ? { kind: 'sub', title: b.title, depth: Math.min(6, depth + 1) } : { kind: 'block', block: b },
  );
  return splitChunk({ title, depth, trail, items }).map(toDraft);
}
