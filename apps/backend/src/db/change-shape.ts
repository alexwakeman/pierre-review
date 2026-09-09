import type { ChangeShape } from '@pierre-review/shared';
import { isNonCodeFile } from './code-loc.js';

// ============================================================================
// CHANGE SHAPE — is this pull request's code churn actually CODE?
// ============================================================================
//
// Blast radius asks how far a change can REACH, and answers it from the file paths. That is the
// right question and the wrong half of the evidence in one specific case: a change to the
// COMMENTS inside a high-consequence file. A real one —
//
//     golang/go#80721 "crypto/hpke: document sequence counter size"
//     src/crypto/hpke/hpke.go, +4 −2, every changed line a `//` doc comment
//
// — landed as HIGH, because `crypto/` is one of the contract surfaces. The path is right about
// the file and wrong about the change. This module reads the PATCH and says which.
//
// ---- WHAT IT ANSWERS, AND WHAT IT DELIBERATELY DOES NOT --------------------
//
//   'comments'   — every changed line in every code file is a comment or blank.
//   'formatting' — the added and removed lines are the SAME lines modulo whitespace.
//   'code'       — something else changed. The overwhelming majority.
//   null         — we could not tell, and that is a first-class answer (see below).
//
// ⚠ IMPORTS WERE CONSIDERED AND DELIBERATELY LEFT OUT. Reordering imports is trivial; ADDING one
// means the file now uses something it did not, which is a real change with real reach. The two
// are one line apart in a diff and telling them apart needs more than a line matcher, so the
// honest move is to not claim either. If it is ever added it belongs beside `deps` — carried for
// narration, never as a reason to lower a level.
//
// ---- THE CONSERVATIVE RULE, WHICH IS THE WHOLE DESIGN ----------------------
//
// ⚠ EVERY UNCERTAINTY RESOLVES TO "NOT TRIVIAL". An unknown file extension, a patch GitHub did
// not give us, a block comment we cannot bound — all of them return `code` or `null`, never
// `comments`. That asymmetry is deliberate and it is the only thing that makes this safe to wire
// into a level: the failure mode of a wrong `code` is a pull request that stays HIGH and gets
// read carefully, and the failure mode of a wrong `comments` is a maintainer waving through a
// change to a crypto file. Those are not equally bad.

/** Single-line comment markers by file extension. An extension absent from this map is a
 *  language we do not claim to understand, and its file makes the whole answer `code`. */
const LINE_COMMENT: Record<string, readonly string[]> = {
  // C-family and friends
  ts: ['//'], tsx: ['//'], js: ['//'], jsx: ['//'], mjs: ['//'], cjs: ['//'], mts: ['//'], cts: ['//'],
  go: ['//'], java: ['//'], c: ['//'], h: ['//'], cc: ['//'], cpp: ['//'], hpp: ['//'], cxx: ['//'],
  cs: ['//'], rs: ['//'], swift: ['//'], kt: ['//'], kts: ['//'], scala: ['//'], dart: ['//'],
  php: ['//', '#'], m: ['//'], mm: ['//'], zig: ['//'], v: ['//'], groovy: ['//'],
  // Hash-comment languages
  py: ['#'], rb: ['#'], sh: ['#'], bash: ['#'], zsh: ['#'], pl: ['#'], pm: ['#'], r: ['#'],
  ex: ['#'], exs: ['#'], nim: ['#'], cr: ['#'], tcl: ['#'],
  // Dash-comment languages
  sql: ['--'], lua: ['--'], hs: ['--'], elm: ['--'], ada: ['--'],
  // Others
  erl: ['%'], hrl: ['%'], tex: ['%'], clj: [';'], cljs: [';'], el: [';'], lisp: [';'], scm: [';'],
  vim: ['"'], ini: [';', '#'], jl: ['#'],
};

/** Block comment delimiters by extension. Absent = the language has none we track, and a file
 *  whose changed lines are not all single-line comments is simply `code`. */
const BLOCK_COMMENT: Record<string, readonly (readonly [string, string])[]> = {
  ts: [['/*', '*/']], tsx: [['/*', '*/']], js: [['/*', '*/']], jsx: [['/*', '*/']],
  mjs: [['/*', '*/']], cjs: [['/*', '*/']], mts: [['/*', '*/']], cts: [['/*', '*/']],
  go: [['/*', '*/']], java: [['/*', '*/']], c: [['/*', '*/']], h: [['/*', '*/']],
  cc: [['/*', '*/']], cpp: [['/*', '*/']], hpp: [['/*', '*/']], cxx: [['/*', '*/']],
  cs: [['/*', '*/']], rs: [['/*', '*/']], swift: [['/*', '*/']], kt: [['/*', '*/']],
  kts: [['/*', '*/']], scala: [['/*', '*/']], dart: [['/*', '*/']], php: [['/*', '*/']],
  m: [['/*', '*/']], mm: [['/*', '*/']], groovy: [['/*', '*/']], sql: [['/*', '*/']],
  // ⚠ Python's triple-quoted strings are STRINGS, not comments — but a changed docstring is the
  // exact case this module exists for, and a bare triple-quoted expression statement has no other
  // use. Tracked as a block, and the conservative rule covers the misreads: a multi-line string
  // assigned to a variable would be misclassified as a comment, so a changed one reports
  // `comments` when it is really data. That is the one known false-trivial, it is bounded to
  // Python, and it still cannot take a level below MEDIUM.
  py: [['"""', '"""'], ["'''", "'''"]],
  lua: [['--[[', ']]']],
};

function extensionOf(path: string): string {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1);
}

/** The +/− and context lines of one unified-diff hunk body, marker stripped. */
interface HunkLine {
  /** '+' added, '-' removed, ' ' context. */
  marker: '+' | '-' | ' ';
  text: string;
}

/** Split a REST `patch` into hunks, each a list of marked lines. Header lines (`@@`, `\ No
 *  newline at end of file`) are dropped. */
function hunksOf(patch: string): HunkLine[][] {
  const out: HunkLine[][] = [];
  let cur: HunkLine[] | null = null;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      cur = [];
      out.push(cur);
      continue;
    }
    if (cur == null) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const marker = raw[0];
    if (marker === '+' || marker === '-' || marker === ' ') {
      cur.push({ marker, text: raw.slice(1) });
    } else if (raw === '') {
      // An empty line in a patch is a context line whose content is empty.
      cur.push({ marker: ' ', text: '' });
    }
  }
  return out;
}

/**
 * Are every one of this hunk's CHANGED lines a comment or blank?
 *
 * Block state is tracked across the whole hunk INCLUDING context lines, because those are what
 * tell us whether we are inside a comment when a changed line arrives.
 *
 * ⚠ A HUNK CAN BEGIN INSIDE A BLOCK COMMENT and the patch does not say so. That is detectable:
 * if the first delimiter we meet is a CLOSE, we started inside one. Anything we still cannot
 * bound returns false.
 */
function hunkIsCommentOnly(lines: HunkLine[], singles: readonly string[], blocks: readonly (readonly [string, string])[]): boolean {
  // Pre-scan for the "started inside a block" case.
  let inBlock: readonly [string, string] | null = null;
  if (blocks.length > 0) {
    outer: for (const l of lines) {
      const t = l.text;
      for (const b of blocks) {
        const openAt = t.indexOf(b[0]);
        const closeAt = t.indexOf(b[1]);
        if (openAt !== -1 && (closeAt === -1 || closeAt > openAt)) break outer; // opened first
        if (closeAt !== -1) {
          inBlock = b; // a close with no open before it — the hunk began inside this block
          break outer;
        }
      }
    }
  }

  for (const l of lines) {
    const trimmed = l.text.trim();
    const changed = l.marker !== ' ';
    let isCommentLine = inBlock != null;

    if (inBlock != null) {
      // Inside a block: it stays a comment line, and may close here.
      if (trimmed.includes(inBlock[1])) {
        const after = trimmed.slice(trimmed.indexOf(inBlock[1]) + inBlock[1].length).trim();
        inBlock = null;
        // Code after the closing delimiter on the same line means this is not purely a comment.
        if (after !== '' && changed) return false;
      }
    } else if (trimmed === '') {
      isCommentLine = true;
    } else if (singles.some((s) => trimmed.startsWith(s))) {
      isCommentLine = true;
    } else {
      // Does a block open here, with nothing but whitespace before it?
      const opener = blocks.find((b) => trimmed.startsWith(b[0]));
      if (opener) {
        isCommentLine = true;
        const rest = trimmed.slice(opener[0].length);
        const closeAt = rest.indexOf(opener[1]);
        if (closeAt === -1) {
          inBlock = opener;
        } else {
          // Opened and closed on one line; anything after it is code.
          const after = rest.slice(closeAt + opener[1].length).trim();
          if (after !== '' && changed) return false;
        }
      }
    }

    if (changed && !isCommentLine) return false;
  }
  // ⚠ An unterminated block at the end of the hunk means we never saw it close. The lines we
  // accepted were inside it, which is fine — the state simply does not carry to the next hunk,
  // and each hunk re-derives its own.
  return true;
}

/** Whitespace-insensitive key for the formatting comparison. */
const wsKey = (s: string): string => s.replace(/\s+/g, '');

/**
 * Classify one pull request's code churn from its per-file patches.
 *
 * `files` is the REST `/pulls/:n/files` shape. A file with no `patch` (GitHub omits it for
 * binaries and for very large diffs) makes the answer `null` — we did not see the change, so we
 * do not get to describe it.
 *
 * ⚠ NON-CODE FILES ARE EXCLUDED, not judged. Documentation and config have their own place in
 * the blast fold (`nonCodeFiles`); a README beside a comment-only Go change must not make the
 * answer `code`. If NO code file remains there is nothing for this module to say — the existing
 * `codeFiles === 0` rules already handle that pull request — so it returns null.
 */
export function classifyChangeShape(
  files: readonly { path: string; patch?: string | null }[],
): ChangeShape | null {
  const code = files.filter((f) => typeof f?.path === 'string' && !isNonCodeFile(f.path));
  if (code.length === 0) return null;

  let allComments = true;
  const addedKeys: string[] = [];
  const removedKeys: string[] = [];

  for (const f of code) {
    const patch = f.patch;
    // ⚠ NO PATCH, NO CLAIM. GitHub omits it for binaries and oversized diffs.
    if (typeof patch !== 'string' || patch === '') return null;

    const ext = extensionOf(f.path);
    const singles = LINE_COMMENT[ext];
    const blocks = BLOCK_COMMENT[ext] ?? [];
    const hunks = hunksOf(patch);
    if (hunks.length === 0) return null;

    for (const h of hunks) {
      for (const l of h) {
        if (l.marker === '+') addedKeys.push(wsKey(l.text));
        else if (l.marker === '-') removedKeys.push(wsKey(l.text));
      }
      // An unknown language can still be `formatting` (that comparison needs no syntax), but it
      // can never be `comments`.
      if (allComments) {
        if (singles == null) allComments = false;
        else if (!hunkIsCommentOnly(h, singles, blocks)) allComments = false;
      }
    }
  }

  if (allComments) return 'comments';

  // FORMATTING — the same lines came back, differing only in whitespace. Compared as sorted
  // multisets so a reorder within the hunk still counts, and requiring a non-empty change so a
  // patch with no +/- lines at all does not read as a formatting change.
  if (addedKeys.length > 0 || removedKeys.length > 0) {
    const a = [...addedKeys].filter((s) => s !== '').sort();
    const b = [...removedKeys].filter((s) => s !== '').sort();
    if (a.length === b.length && a.every((v, i) => v === b[i])) return 'formatting';
  }

  return 'code';
}
