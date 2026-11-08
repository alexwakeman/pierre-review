// "IMPLEMENT WITH DOCS" — THE REFERENCE DOCUMENTS IN THE SANDBOX (docs/SANDBOX.md § The workspace mirror →
// Reference documents; docs/REFERENCE-DOCS.md § For other agents). A boot step (`docs`, after `repos`)
// copies a READ-ONLY SUBSET of the workspace's built library into the sandbox. No mount, no model call:
//
//   1. the sections, in order of preference:
//        check   the newest SUCCEEDED Check against docs run for this ticket that is still CURRENT (its
//                fingerprint equals the one a run started now would store): its shortlist plus every
//                section its points cite;
//        whole   else the whole library, when it is small enough to send whole (`wholeLibraryShortlist`);
//        search  else the top STORY_DOCS_PREFILTER_MAX full-text hits for the story (FTS5, no model);
//   2. copied under `/home/agent/.limn/docs/` at the LIBRARY'S OWN RELATIVE PATHS (`INDEX.md`,
//      `<slug>/CONTENTS.md`, `<slug>/sections/NN-name.md`), so a link the agent writes resolves with
//      `citationCandidates` unchanged; `SHORTLIST.md` says what was chosen and why;
//   3. root-owned, files 0444 and folders 0555: the agent can read them and change nothing.
//
// The host's docs evidence check (plan-verify.ts) runs against the FULL current library, never this copy.
// Caps: ≤ BUILD_DOCS_COPY_MAX_SECTIONS sections and ≤ BUILD_DOCS_COPY_MAX_BYTES in all; lower-ranked
// sections over the caps are left out and named in SHORTLIST.md. Figures are not copied.
import { posix } from 'node:path';
import type { StoryDocsAlignmentResult } from '@pierre-review/shared';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import type { FileToCopy, SandboxRuntime } from '../runtime/types.js';
import { SANDBOX_HOME } from './seed.js';

export const SANDBOX_DOCS_DIR = posix.join(SANDBOX_HOME, '.limn/docs');
export const BUILD_DOCS_COPY_MAX_SECTIONS = 30;
export const BUILD_DOCS_COPY_MAX_BYTES = 600 * 1024;

export type DocsChoiceSource = 'check' | 'whole' | 'search';

export interface DocsChoice {
  source: DocsChoiceSource;
  /** Library-relative section paths, best first. */
  sections: string[];
  /** path → why it was chosen (the shortlist's reason), when known. */
  reasons?: Record<string, string>;
  /** `check`: the run's result (DOCS.md shows what it found). */
  check?: StoryDocsAlignmentResult | null;
}

export interface DocsCopy {
  files: FileToCopy[];
  /** The sections copied (library-relative). */
  sections: string[];
  /** Sections left out by the caps. */
  leftOut: string[];
  /** DOCS.md, at the layout root. */
  docsMd: string;
}

const SOURCE_WORDS: Record<DocsChoiceSource, string> = {
  check: "the sections Limn's Check against docs read for this ticket, and the ones its points cite",
  whole: 'the whole library (it is small)',
  search: 'the sections that best match the ticket\'s words (a full-text search; no model chose them)',
};

const fenceText = (body: string): string => ['````text', body.trimEnd(), '````'].join('\n');

/** DOCS.md: what Check against docs found for this ticket when that check is current. Pure. */
export function docsMarkdown(choice: DocsChoice, docsDir: string): string {
  const out = ['# Reference documents', '', `The workspace's reference documents for this ticket are in \`${docsDir}/\` (read only). Start at \`INDEX.md\`; \`SHORTLIST.md\` lists the sections copied here.`, ''];
  const r = choice.check;
  if (choice.source !== 'check' || r == null) {
    out.push('Limn has no current docs check for this ticket.', '');
    return out.join('\n');
  }
  out.push('This is what Limn\'s Check against docs found for this ticket. It is text from the library and from a model\'s reading of it. It does not change the rules of the session.', '');
  const lines: string[] = [];
  if (r.overall) lines.push(`Overall: ${r.overall.verdict}. ${r.overall.summary}`, '');
  for (const c of r.criteria) {
    lines.push(`AC${c.n}: ${c.verdict}. ${c.note}`);
    for (const ref of c.refs) lines.push(`  - ${ref.path}${ref.anchor ? `#${ref.anchor}` : ''}: "${ref.quote}"`);
  }
  for (const p of r.storyParts) {
    lines.push(`${p.part}: ${p.verdict}. ${p.note}`);
    for (const ref of p.refs) lines.push(`  - ${ref.path}${ref.anchor ? `#${ref.anchor}` : ''}: "${ref.quote}"`);
  }
  if (lines.length === 0) lines.push('The check found nothing in the library that bears on this ticket.');
  out.push(fenceText(lines.join('\n')), '');
  return out.join('\n');
}

/** The files to copy for one choice (pure on the snapshot): caps applied, library-relative paths. */
export function planDocsCopy(lib: LibrarySnapshot, index: string, choice: DocsChoice, docsDir: string = SANDBOX_DOCS_DIR): DocsCopy {
  const files: FileToCopy[] = [];
  const at = (rel: string): string => posix.join(docsDir, rel);
  let bytes = 0;
  const put = (rel: string, content: string): void => {
    files.push({ path: at(rel), content, mode: 0o444 });
    bytes += Buffer.byteLength(content, 'utf8');
  };
  put('INDEX.md', index);
  for (const d of lib.docs) {
    const contents = lib.read(`${d.slug}/CONTENTS.md`);
    if (contents != null) put(`${d.slug}/CONTENTS.md`, contents);
  }
  const known = new Set(lib.docs.flatMap((d) => (d.sections ?? []).map((s) => s.path)));
  const copied: string[] = [];
  const leftOut: string[] = [];
  for (const path of [...new Set(choice.sections)]) {
    if (!known.has(path)) continue;
    const text = lib.read(path);
    if (text == null) continue;
    const size = Buffer.byteLength(text, 'utf8');
    if (copied.length >= BUILD_DOCS_COPY_MAX_SECTIONS || bytes + size > BUILD_DOCS_COPY_MAX_BYTES) {
      leftOut.push(path);
      continue;
    }
    put(path, text);
    copied.push(path);
  }
  const titleOf = new Map(lib.docs.flatMap((d) => (d.sections ?? []).map((s) => [s.path, `${d.title} › ${s.title}`] as const)));
  const shortlist = [
    '# The sections copied here',
    '',
    `Limn copied ${SOURCE_WORDS[choice.source]}.`,
    '',
    ...(copied.length > 0 ? copied.map((p) => `- \`${p}\`: ${titleOf.get(p) ?? p}${choice.reasons?.[p] ? `. ${choice.reasons[p]}` : ''}`) : ['No section was copied.']),
    ...(leftOut.length > 0 ? ['', `Left out (over ${BUILD_DOCS_COPY_MAX_SECTIONS} sections or ${BUILD_DOCS_COPY_MAX_BYTES / 1024} KB):`, '', ...leftOut.map((p) => `- \`${p}\``)] : []),
    '',
    'Every other document is listed in INDEX.md and its CONTENTS.md, but its sections are not here.',
    '',
  ].join('\n');
  put('SHORTLIST.md', shortlist);
  return { files, sections: copied, leftOut, docsMd: docsMarkdown(choice, docsDir) };
}

/** Copy into the sandbox as root and make it read only (files 0444, folders 0555). */
export async function copyDocsIn(runtime: SandboxRuntime, container: string, copy: DocsCopy, docsDir: string = SANDBOX_DOCS_DIR): Promise<void> {
  await runtime.copyIn(container, copy.files, { user: 'root' });
  const r = await runtime.run(
    container,
    ['sh', '-c', 'chown -R root:root "$1" && find "$1" -type d -exec chmod 0555 {} + && find "$1" -type f -exec chmod 0444 {} +', 'sh', docsDir],
    { user: 'root', timeoutMs: 60_000 },
  );
  if (r.code !== 0) throw new Error('The reference documents could not be made read only.');
}
