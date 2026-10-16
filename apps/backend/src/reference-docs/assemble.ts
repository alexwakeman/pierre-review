import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReferenceDocSectionEntry } from '@pierre-review/shared';
import { renderContents, renderSection, sectionFileNames } from './render.js';
import { splitWrittenSection, type DraftSection } from './split.js';

// ASSEMBLING A BUILT DOCUMENT (pure apart from the files it writes; no DB) — the indexing stage of
// manager.ts: the drafts become `sections/NN-name.md` (each with its header) and CONTENTS.md.

export const trimTitle = (t: string): string => t.replace(/\s+/g, ' ').trim().slice(0, 160);

/** The PDF build's recorded files → drafts, with trails from the recorded depths. Exported for tests. */
export function draftsFromWritten(
  order: readonly string[],
  recorded: ReadonlyMap<string, { title: string | null; summary: string; depth: number }>,
  readFile: (file: string) => string,
): Array<DraftSection & { summary: string }> {
  const stack: Array<{ depth: number; title: string }> = [];
  const out: Array<DraftSection & { summary: string }> = [];
  for (const file of order) {
    const rec = recorded.get(file);
    const title = trimTitle(rec?.title ?? file.replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-/g, ' ')) || 'Section';
    const want = rec?.depth ?? 1;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= want) stack.pop();
    const trail = stack.map((s) => s.title);
    const depth = Math.min(want, trail.length + 1);
    stack.push({ depth, title });
    let text = '';
    try {
      text = readFile(file);
    } catch {
      text = '';
    }
    for (const part of splitWrittenSection(title, depth, trail, text)) {
      if (part.body === '' && part.subheadings.length === 0) continue;
      out.push({ ...part, summary: rec?.summary ?? '' });
    }
  }
  return out;
}

/** Render one document folder (CONTENTS.md + sections/) from drafts. Returns its section entries. */
export function renderDocFolder(
  outDir: string,
  doc: { slug: string; title: string; summary: string; sourceLabel: string },
  drafts: ReadonlyArray<DraftSection & { summary: string }>,
): ReferenceDocSectionEntry[] {
  const names = sectionFileNames(drafts.map((d) => d.title));
  mkdirSync(join(outDir, 'sections'), { recursive: true });
  const entries: ReferenceDocSectionEntry[] = drafts.map((d, i) => ({
    path: `${doc.slug}/sections/${names[i]}`,
    title: d.title,
    summary: d.summary,
    depth: d.depth,
    trail: d.trail,
    headings: d.subheadings,
    words: d.words,
  }));
  drafts.forEach((d, i) => {
    writeFileSync(
      join(outDir, 'sections', names[i]!),
      renderSection({
        docTitle: doc.title,
        index: i,
        total: drafts.length,
        section: d,
        prevFile: i > 0 ? names[i - 1]! : null,
        nextFile: i < drafts.length - 1 ? names[i + 1]! : null,
      }),
    );
  });
  writeFileSync(join(outDir, 'CONTENTS.md'), renderContents({ docTitle: doc.title, summary: doc.summary, sourceLabel: doc.sourceLabel, entries }));
  return entries;
}

