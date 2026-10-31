import { FLOW_MIN_CODE_LINES, type SequenceDiagramRefusal } from '@pierre-review/shared';
import { isTestFile } from '../../db/blast-radius.js';
import { isNonCodeFile } from '../../db/code-loc.js';
import { splitDiffByFile } from '../../github/diff-anchor.js';

// "DOES THIS CHANGE DESERVE A DIAGRAM?" — the DETERMINISTIC pre-check, run on the diff the pipeline
// reads anyway, BEFORE any checkout or model (manager.ts). PURE, no I/O, free: a refusal here is a
// server refusal (persist.ts FREE_REFUSALS), so it never uses up the daily cap.
//
//   no_code     no changed file is code (db/code-loc.ts `isNonCodeFile`: docs, config, lockfiles,
//               generated output). Always applies.
//   tests_only  every changed code file is a test (db/blast-radius.ts `isTestFile`).
//   copy_only   every changed code line differs only in its TEXT: string literals, JSX text and lines
//               of prose. The code around the words is the same, line for line.
//   too_small   fewer than FLOW_MIN_CODE_LINES changed code lines (tests, blank lines and comments
//               aside).
// The last three are SOFT: a reader's own Draw / Redraw (`manual`) skips them and lets the model judge
// (it may still decline, with its reason). The classifiers are the existing ones, called side by side,
// never folded into each other (CLAUDE.md § FOUR PATH CLASSIFIERS).

export type PrecheckRefusal = Extract<SequenceDiagramRefusal, 'no_code' | 'tests_only' | 'copy_only' | 'too_small'>;

export interface PrecheckInput {
  changedFiles: readonly string[];
  // The noise-stripped unified diff (a story: every member's, joined). Null = unreadable: only the
  // file-list checks run.
  diff: string | null;
}

const isCode = (p: string): boolean => !isNonCodeFile(p);

// A line that starts with one of these is code, even if it reads like words ("return total").
const KEYWORDS = new Set(
  (
    'return import export const let var if else for while do def class from await yield throw raise pass break ' +
    'continue case default function async new delete typeof not and or with elif try except finally lambda ' +
    'switch fn func pub use mod impl struct enum type interface package public private protected static'
  ).split(' '),
);

/** A comment or blank line: never counted. */
function isCommentOrBlank(t: string): boolean {
  return t === '' || /^(\/\/|\/\*|\*|#(?!include|define|\[)|--|<!--|""")/.test(t);
}

// SQL, a route or a URL path inside a string literal.
const DATA_STRING = /\bselect\s.+\sfrom\s|\binsert\s+into\s|\bupdate\s+\w+\s+set\s|\bdelete\s+from\s|^["']\/|\/api\//i;

/** The line with its WORDS taken out: string contents, JSX text. Prose-only lines read as ''. */
export function codeSkeleton(line: string): string {
  let s = line.trim();
  // Template literals keep their `${…}` holes (an expression change is a code change).
  s = s.replace(/`(?:\\.|[^`\\])*`/g, (m) => '`' + (m.match(/\$\{[^}]*\}/g) ?? []).join('') + '`');
  // A string that is a query or a route is DATA ACCESS, not copy: it stays in the skeleton.
  const words = (q: string) => (m: string) => (DATA_STRING.test(m) ? m : q + q);
  s = s.replace(/"(?:\\.|[^"\\])*"/g, words('"')).replace(/'(?:\\.|[^'\\])*'/g, words("'"));
  // JSX / HTML text between tags.
  s = s.replace(/>[^<>{}]*</g, '><');
  s = s.replace(/\s+/g, ' ').trim();
  // A line of plain words (JSX text on its own line, a markdown-ish string continuation).
  const first = s.split(/[\s(]/)[0] ?? '';
  if (!/[(){}[\]=;<>]/.test(s) && /\s/.test(s) && !KEYWORDS.has(first)) return '';
  return s;
}

interface ChangedLines {
  removed: string[];
  added: string[];
}

function changedLines(diff: string, keep: (path: string) => boolean): ChangedLines {
  const out: ChangedLines = { removed: [], added: [] };
  for (const seg of splitDiffByFile(diff)) {
    if (!keep(seg.path)) continue;
    let inHunk = false;
    for (const line of seg.text.split('\n')) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) out.added.push(line.slice(1));
      else if (line.startsWith('-') && !line.startsWith('---')) out.removed.push(line.slice(1));
    }
  }
  return out;
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map<string, number>();
  for (const x of a) m.set(x, (m.get(x) ?? 0) + 1);
  for (const x of b) {
    const n = m.get(x) ?? 0;
    if (n === 0) return false;
    m.set(x, n - 1);
  }
  return true;
}

/** Why this change gets no diagram, or null (draw it). `manual` skips the soft checks. */
export function diagramPrecheck(input: PrecheckInput, opts: { manual?: boolean } = {}): PrecheckRefusal | null {
  const code = input.changedFiles.filter(isCode);
  if (code.length === 0) return 'no_code';
  if (opts.manual) return null;
  const relevant = code.filter((p) => !isTestFile(p));
  if (relevant.length === 0) return 'tests_only';
  if (input.diff == null) return null;
  const set = new Set(relevant);
  const lines = changedLines(input.diff, (p) => set.has(p));
  const meaningful = [...lines.removed, ...lines.added].map((l) => l.trim()).filter((t) => !isCommentOrBlank(t));
  if (meaningful.length === 0) {
    // Only blank lines or comments changed: nothing moves.
    return lines.removed.length + lines.added.length > 0 ? 'too_small' : null;
  }
  const skel = (xs: string[]): string[] =>
    xs.map((l) => l.trim()).filter((t) => !isCommentOrBlank(t)).map(codeSkeleton).filter((s) => s !== '');
  if (sameMultiset(skel(lines.removed), skel(lines.added))) return 'copy_only';
  if (meaningful.length < FLOW_MIN_CODE_LINES) return 'too_small';
  return null;
}
