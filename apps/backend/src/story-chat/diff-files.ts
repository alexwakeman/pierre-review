// STORY CHAT — EACH DIFF AS FILES THE AGENT CAN READ WHOLE (docs/STORY-CHAT.md § The diffs).
//
// A PR's unified diff used to be ONE file. The agent's Read tool returns a bounded slice of a file (about
// 2000 lines, fewer when the lines are long), so a big PR was read in part and the answer said so ("I did
// not read the full diff"). Here each diff becomes a FOLDER: an INDEX (one line per changed file: status,
// churn, its part files) and the diff of each file in parts small enough that ONE Read returns a part
// whole. A line longer than Read shows is wrapped onto continuation lines marked `LONG_LINE_MARK`.
// Pure (`splitDiff`, `planDiffFolder`) + one writer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Most lines in one part (Read returns ~2000; a part stays far below, with room for its header). */
export const DIFF_PART_LINES = 600;
/** Most characters in one part (Read's output budget, with room to spare). */
export const DIFF_PART_CHARS = 40_000;
/** A diff line longer than this is wrapped (Read cuts a line at 2000 characters). */
export const DIFF_LINE_MAX = 1_500;
export const LONG_LINE_MARK = '↪ ';

export interface DiffFile {
  /** The new path (the old one for a deletion). */
  path: string;
  /** Set on a rename. */
  oldPath: string | null;
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'not shown';
  additions: number;
  deletions: number;
  /** The file's diff lines, from its `diff --git` line on. */
  lines: string[];
}

/** Split a unified diff into its files. Pure. Text before the first `diff --git` is dropped. */
export function splitDiff(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let inHunk = false;
  for (const line of text.split('\n')) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (head) {
      const a = head[1]!;
      const b = head[2]!;
      cur = { path: b, oldPath: a !== b ? a : null, status: a !== b ? 'renamed' : 'modified', additions: 0, deletions: 0, lines: [line] };
      out.push(cur);
      inHunk = false;
      continue;
    }
    if (cur == null) continue;
    cur.lines.push(line);
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('(diff not shown')) cur.status = 'not shown';
      if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('+')) cur.additions += 1;
    else if (line.startsWith('-')) cur.deletions += 1;
  }
  // A deletion's `b/` path is still the old path; GitHub's synthetic headers carry the churn in words.
  for (const f of out) {
    if (f.status === 'not shown') {
      const m = /\+(\d+)\/-(\d+)/.exec(f.lines.find((l) => l.startsWith('(diff not shown')) ?? '');
      if (m) {
        f.additions = Number(m[1]);
        f.deletions = Number(m[2]);
      }
    }
  }
  return out;
}

/** Wrap a line longer than `max` onto continuation lines. Pure. */
export function wrapLong(line: string, max = DIFF_LINE_MAX): string[] {
  if (line.length <= max) return [line];
  const out = [line.slice(0, max)];
  for (let i = max; i < line.length; i += max) out.push(`${LONG_LINE_MARK}${line.slice(i, i + max)}`);
  return out;
}

/** A file's lines in parts: each within the line and character limits, broken at a hunk (`@@`) when one
 *  is near. Pure. Never an empty part. */
export function partsOf(lines: readonly string[], maxLines = DIFF_PART_LINES, maxChars = DIFF_PART_CHARS): string[][] {
  const wrapped = lines.flatMap((l) => wrapLong(l));
  const parts: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const line of wrapped) {
    const full = cur.length >= maxLines || chars + line.length + 1 > maxChars;
    // Past ~70% of a part, a new hunk starts a new part, so a hunk is rarely split.
    const nearFull = line.startsWith('@@') && (cur.length >= maxLines * 0.7 || chars >= maxChars * 0.7);
    if (cur.length > 0 && (full || nearFull)) {
      parts.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(line);
    chars += line.length + 1;
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/** A path as one safe file name. Pure. */
export function safeName(path: string): string {
  const s = path.replace(/[\\/]/g, '__').replace(/[^A-Za-z0-9._-]/g, '_');
  return s.length <= 120 ? s : `${s.slice(0, 60)}_${s.slice(-59)}`;
}

const STATUS_WORD: Record<DiffFile['status'], string> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'changed',
  'not shown': 'no diff from GitHub (binary or too large): read the file in the checkout',
};

export interface PlannedDiffFolder {
  /** File name → content, the INDEX first. */
  files: Array<{ name: string; text: string }>;
  fileCount: number;
  partCount: number;
}

/** The folder's files for one diff. `title` heads the INDEX (e.g. `acme/api#12 "Refunds"`). Pure. */
export function planDiffFolder(title: string, text: string): PlannedDiffFolder {
  const files = splitDiff(text);
  const out: Array<{ name: string; text: string }> = [];
  const index: string[] = [];
  let partCount = 0;
  let adds = 0;
  let dels = 0;
  files.forEach((f, i) => {
    adds += f.additions;
    dels += f.deletions;
    const base = `${String(i + 1).padStart(3, '0')}-${safeName(f.path)}`;
    const parts = partsOf(f.lines);
    const names: string[] = [];
    parts.forEach((p, j) => {
      const name = parts.length === 1 ? `${base}.diff` : `${base}.part${j + 1}.diff`;
      const header = parts.length === 1 ? `# ${f.path}: the whole diff of this file` : `# ${f.path}: part ${j + 1} of ${parts.length} of this file's diff`;
      out.push({ name, text: `${header}\n${p.join('\n')}\n` });
      names.push(name);
    });
    partCount += parts.length;
    const what = f.oldPath ? `${STATUS_WORD[f.status]} from ${f.oldPath}` : STATUS_WORD[f.status];
    index.push(`- ${f.path} (${what}, +${f.additions} −${f.deletions}): ${names.join(', ')}`);
  });
  const head = [
    `# ${title}: its whole diff, one file per changed file`,
    `${files.length} ${files.length === 1 ? 'file' : 'files'}, +${adds} −${dels}, in ${partCount} ${partCount === 1 ? 'part' : 'parts'}. Each part is small enough to read whole in ONE Read; the parts of a file together are its whole change. Nothing is cut.`,
    `A line longer than ${DIFF_LINE_MAX} characters goes on in the next line, which starts with "${LONG_LINE_MARK.trim()}".`,
    '',
  ];
  if (files.length === 0) head.push('(This diff is empty.)');
  out.unshift({ name: 'INDEX.md', text: `${[...head, ...index].join('\n')}\n` });
  return { files: out, fileCount: files.length, partCount };
}

/** Write one diff's folder (made fresh) and return its INDEX path. */
export function writeDiffFolder(dir: string, title: string, text: string): { index: string; fileCount: number; partCount: number } {
  const plan = planDiffFolder(title, text);
  mkdirSync(dir, { recursive: true });
  for (const f of plan.files) writeFileSync(join(dir, f.name), f.text);
  return { index: join(dir, 'INDEX.md'), fileCount: plan.fileCount, partCount: plan.partCount };
}
