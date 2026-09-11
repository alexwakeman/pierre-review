import hljs from 'highlight.js';

// ── SYNTAX HIGHLIGHTING, ONE CELL AT A TIME ──────────────────────────────────────────────────
//
// The resolver paints three code panes whose rows must line up, so it needs highlighted text
// SPLIT BY LINE. There is exactly one honest way to get that.
//
// ⚠ HIGHLIGHT THE WHOLE CELL, THEN CUT. Highlighting line by line loses the lexer's state at
// every newline, and the result is not "slightly worse" — it is wrong in a way that reads as a
// rendering bug: every block comment, every template literal and every multi-line string is
// coloured as ordinary code from its second line on. So `hljs.highlight` sees the whole cell and
// `splitHighlighted` walks the emitted HTML keeping an open-tag stack, closing the open spans at
// each newline and re-opening them on the next line.
//
// ⚠ THREE GATES, AND A `null` MEANS "RENDER IT PLAIN". `null` is not a failure to report; the
// caller escapes the text itself and the reader sees uncoloured code, which is what every other
// diff in this app already shows. The gates:
//
//   1. A language RESOLVED FROM THE EXTENSION. Never `highlightAuto` — it guesses, and a wrong
//      guess on a 3-line hunk colours a conflict as something it is not, which is a claim about
//      the code rather than a decoration.
//   2. Under `MAX_HIGHLIGHT_LINES`. A 4,000-line unchanged region is not worth a lexer pass, and
//      the reader has folded it anyway.
//   3. `hljs.highlight` did not throw. `ignoreIllegals` already suppresses the common case; the
//      try/catch is for the rest.
//
// ⚠ ONLY hljs OUTPUT REACHES `dangerouslySetInnerHTML`. The escaping is highlight.js's own, and
// the fallback path (this function returning null) escapes through React's normal text rendering.
// Nothing else may be passed through this file.

/** Gate 2. Above this a cell renders plain — see the header. */
export const MAX_HIGHLIGHT_LINES = 400;

/**
 * Extension → highlight.js language name. Deliberately a short, explicit table rather than
 * `hljs.getLanguage(ext)`: that call succeeds for aliases nobody meant (`.ts` is TypeScript, but
 * `.m` is Objective-C, MATLAB or Mercury depending on who you ask), and a wrong lexer is worse
 * than none. An unlisted extension returns null and the cell renders plain.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
};

/** The language for a repo-relative path, or null when we would be guessing. */
export function languageForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

/**
 * Cut highlight.js's HTML at every newline, keeping the span stack balanced.
 *
 * highlight.js emits nothing but `<span class="…">` opens, `</span>` closes and escaped text, so
 * the stack is a depth counter with the opening tags remembered: at a newline we close what is
 * open, end the line, and start the next line by re-opening the same tags in the same order.
 * Exported for the test, which is the only place the balance can actually be checked.
 */
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = '';
  let i = 0;
  while (i < html.length) {
    const next = html.slice(i).search(/[<\n]/);
    if (next === -1) {
      line += html.slice(i);
      break;
    }
    line += html.slice(i, i + next);
    i += next;
    if (html[i] === '\n') {
      for (let k = open.length - 1; k >= 0; k -= 1) line += '</span>';
      out.push(line);
      line = open.join('');
      i += 1;
      continue;
    }
    const close = html.indexOf('>', i);
    if (close === -1) {
      // Unterminated tag: hand back what we have rather than dropping the tail. Not reachable
      // from hljs output; cheaper than pretending it cannot happen.
      line += html.slice(i);
      break;
    }
    const tag = html.slice(i, close + 1);
    if (tag.startsWith('</')) open.pop();
    else if (!tag.endsWith('/>')) open.push(tag);
    line += tag;
    i = close + 1;
  }
  for (let k = open.length - 1; k >= 0; k -= 1) line += '</span>';
  out.push(line);
  return out;
}

/**
 * One highlighted HTML string per input line, or null when any gate says render it plain.
 * The returned array is ALWAYS the same length as `lines` — a caller zips the two.
 */
export function highlightLines(lines: string[], language: string | null): string[] | null {
  if (language == null) return null;
  if (lines.length === 0 || lines.length > MAX_HIGHLIGHT_LINES) return null;
  if (hljs.getLanguage(language) == null) return null;
  let html: string;
  try {
    html = hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  const split = splitHighlighted(html);
  // A length mismatch means the lexer swallowed or invented a newline. Zipping them anyway would
  // shift the colouring by a line for the rest of the cell, so refuse and render plain.
  if (split.length !== lines.length) return null;
  return split;
}
