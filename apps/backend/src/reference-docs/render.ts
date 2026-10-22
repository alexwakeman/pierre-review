import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReferenceDocSectionEntry } from '@pierre-review/shared';
import { SECTION_FILE, slugify } from './paths.js';
import { HARD_CAP_CHARS, HARD_CAP_WORDS, countWords, headingAnchor, parseBlocks, type DraftSection } from './split.js';

// THE THREE LEVELS, WRITTEN BY THE SERVER (docs/REFERENCE-DOCS.md § The three levels). Every file a
// link can point at is rendered here from data the server holds, so a link always resolves:
//
//   INDEX.md          renderIndex     — from the stored rows of every built document (never a model)
//   <slug>/CONTENTS.md renderContents — from the section list the build produced
//   sections/*.md     renderSection   — a small header (document, trail, previous / contents / next)
//                                       above the text
//
// `validateDocFolder` re-reads a rendered folder and refuses it unless every CONTENTS link (and
// anchor) resolves, every section is under the cap, and nothing else is in the folder.

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Text safe inside a markdown link label. */
const label = (s: string): string => oneLine(s).replace(/([\\[\]])/g, '\\$1');
/**
 * Free text (a model-written summary, a topic, a source label) on one line, with every character
 * that could start a link escaped — so `See [RFC](https://…)` in a summary is text, never a link
 * the folder check would chase.
 */
const inlineText = (s: string): string => oneLine(s).replace(/([\\[\]()])/g, '\\$1');

/** `NN-<name>.md` for each section, NN zero-padded to the count's width (at least 2). */
export function sectionFileNames(titles: readonly string[]): string[] {
  const width = Math.max(2, String(titles.length).length);
  return titles.map((t, i) => `${String(i + 1).padStart(width, '0')}-${slugify(t, 40) || 'section'}.md`);
}

export interface SectionRender {
  docTitle: string;
  index: number; // 0-based
  total: number;
  section: Pick<DraftSection, 'title' | 'trail' | 'body'>;
  prevFile: string | null;
  nextFile: string | null;
}

export const SECTION_HEADER_MARK = '<!-- limn reference section -->';

export function renderSection(r: SectionRender): string {
  const crumbs = [`**[${label(r.docTitle)}](../CONTENTS.md)**`, ...r.section.trail.map(inlineText)].join(' › ');
  const nav = [
    r.prevFile ? `[Previous](${r.prevFile})` : null,
    '[Contents](../CONTENTS.md)',
    r.nextFile ? `[Next](${r.nextFile})` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    `${SECTION_HEADER_MARK.replace('section', `section ${r.index + 1} of ${r.total}`)}`,
    `# ${inlineText(r.section.title)}`,
    '',
    `> ${crumbs}`,
    `> ${nav}`,
    '',
    r.section.body.trim(),
    '',
  ].join('\n');
}

export interface ContentsRender {
  docTitle: string;
  summary: string | null;
  sourceLabel: string;
  entries: readonly ReferenceDocSectionEntry[];
}

/**
 * CONTENTS.md: the document's tree. One bullet per section file (linked, with its one-line summary)
 * nested by depth, a nested bullet per heading merged into it (linked by anchor), and a plain bullet
 * for a heading that has no text of its own (its title survives only in the trails below it).
 */
export function renderContents(r: ContentsRender): string {
  const lines: string[] = [`# ${inlineText(r.docTitle)}`, ''];
  if (r.summary) lines.push(inlineText(r.summary), '');
  lines.push(`Source: ${inlineText(r.sourceLabel)} · ${r.entries.length} section${r.entries.length === 1 ? '' : 's'}`, '');
  lines.push('## Contents', '');
  const indent = (depth: number): string => '  '.repeat(Math.max(0, depth - 1));
  let prevTrail: string[] = [];
  const emitted = new Set<string>();
  for (const e of r.entries) {
    const rel = e.path.replace(/^[^/]+\//, ''); // `<slug>/sections/x.md` → `sections/x.md`
    // Headings above this one that are not themselves sections: emit them once, as plain bullets.
    e.trail.forEach((t, i) => {
      const key = e.trail.slice(0, i + 1).join('\u0000');
      if (prevTrail[i] === t && prevTrail.slice(0, i + 1).join('\u0000') === key) return;
      if (emitted.has(key)) return;
      emitted.add(key);
      lines.push(`${indent(i + 1)}- **${label(t)}**`);
    });
    emitted.add([...e.trail, e.title].join('\u0000'));
    const depth = Math.min(e.depth, e.trail.length + 1);
    const summary = inlineText(e.summary);
    lines.push(`${indent(depth)}- [${label(e.title)}](${rel})${summary ? ` — ${summary}` : ''}`);
    for (const h of e.headings) {
      lines.push(`${indent(depth + Math.max(1, h.depth - e.depth))}- [${label(h.title)}](${rel}#${h.anchor})`);
    }
    prevTrail = e.trail;
  }
  lines.push('');
  return lines.join('\n');
}

export interface IndexEntry {
  slug: string;
  title: string;
  summary: string | null;
  topics: readonly string[];
  sourceName: string;
  sectionCount: number;
}

/** INDEX.md: the master contents — one entry per built document, in title order. Deterministic. */
export function renderIndex(entries: readonly IndexEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.slug.localeCompare(b.slug),
  );
  const lines = ['# Reference library', ''];
  if (sorted.length === 0) {
    lines.push('No documents yet.', '');
    return lines.join('\n');
  }
  lines.push(
    `${sorted.length} document${sorted.length === 1 ? '' : 's'}. Open a document's contents first, then read only the sections you need.`,
    '',
  );
  for (const e of sorted) {
    lines.push(`## [${label(e.title)}](${e.slug}/CONTENTS.md)`, '');
    if (e.summary) lines.push(inlineText(e.summary), '');
    const meta = [
      e.topics.length > 0 ? `Topics: ${e.topics.map(inlineText).join(', ')}` : null,
      `Source: ${inlineText(e.sourceName)}`,
      `${e.sectionCount} section${e.sectionCount === 1 ? '' : 's'}`,
    ].filter(Boolean);
    lines.push(meta.join(' · '), '');
  }
  return lines.join('\n');
}

// ---- validation ----

/** Every link target in a markdown text (`[x](target)`), in order. An escaped `\[` opens nothing. */
export function markdownLinkTargets(md: string): string[] {
  return markdownLinks(md).map((l) => l.target);
}

/** Every `[text](target)` link with where it sits: [start, end) of the whole link. */
export function markdownLinks(md: string): Array<{ target: string; start: number; end: number }> {
  const out: Array<{ target: string; start: number; end: number }> = [];
  const re = /(?<!\\)\[(?:\\.|[^\]\\])*\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) != null) out.push({ target: m[1]!, start: m.index, end: m.index + m[0].length });
  return out;
}

/** The anchors a section file's headings answer to, numbered for duplicates like GitHub's. */
export function fileAnchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const b of parseBlocks(text)) {
    if (b.kind !== 'heading') continue;
    const base = headingAnchor(b.title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/**
 * The header `renderSection` wrote (marker, title, blank, trail line, nav line), or null when the file
 * does not start with one.
 */
export function sectionHeader(text: string): string | null {
  const lines = text.split('\n');
  if (!lines[0]?.startsWith('<!-- limn reference section ')) return null;
  return lines.slice(0, 5).join('\n');
}

// A section file may carry this much beyond its body (the header: title, trail, links).
const HEADER_WORDS_ALLOWANCE = 120;
const HEADER_CHARS_ALLOWANCE = 2_000;

export function validateDocFolder(dir: string): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const contentsPath = join(dir, 'CONTENTS.md');
  if (!existsSync(contentsPath)) return { ok: false, problems: ['CONTENTS.md is missing.'] };
  for (const name of readdirSync(dir)) {
    if (name === 'CONTENTS.md') continue;
    if (name === 'sections' && statSync(join(dir, name)).isDirectory()) continue;
    problems.push(`Unexpected file in the document folder: ${name}`);
  }
  const sectionsDir = join(dir, 'sections');
  const files = existsSync(sectionsDir) ? readdirSync(sectionsDir) : [];
  const anchors = new Map<string, Set<string>>();
  for (const f of files) {
    const p = join(sectionsDir, f);
    if (!SECTION_FILE.test(f) || !statSync(p).isFile()) {
      problems.push(`Unexpected file in sections/: ${f}`);
      continue;
    }
    const text = readFileSync(p, 'utf8');
    if (countWords(text) > HARD_CAP_WORDS + HEADER_WORDS_ALLOWANCE || text.length > HARD_CAP_CHARS + HEADER_CHARS_ALLOWANCE) {
      problems.push(`sections/${f} is over the size cap.`);
    }
    anchors.set(f, fileAnchors(text));
    // The header's own links (document / previous / contents / next) must resolve. ONLY the header:
    // the document's text keeps its own links as written, and a numbered doc's `[Deploy](05-deploy.md)`
    // naming a file we never made is the author's link, not a broken build.
    const header = sectionHeader(text);
    if (header == null) {
      problems.push(`sections/${f} has no section header.`);
      continue;
    }
    for (const t of markdownLinkTargets(header)) {
      if (t === '../CONTENTS.md') continue;
      if (!SECTION_FILE.test(t) || !files.includes(t)) problems.push(`sections/${f} links to a missing section: ${t}`);
    }
  }
  const contents = readFileSync(contentsPath, 'utf8');
  const linked = new Set<string>();
  for (const t of markdownLinkTargets(contents)) {
    const [bare, anchor] = t.split('#') as [string, string | undefined];
    const m = /^sections\/([^/]+)$/.exec(bare);
    if (!m || !anchors.has(m[1]!)) {
      problems.push(`CONTENTS.md links to a file that does not exist: ${t}`);
      continue;
    }
    linked.add(m[1]!);
    if (anchor != null && !anchors.get(m[1]!)!.has(anchor)) {
      problems.push(`CONTENTS.md links to a heading that does not exist: ${t}`);
    }
  }
  for (const f of anchors.keys()) if (!linked.has(f)) problems.push(`sections/${f} is not in CONTENTS.md.`);
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
