// The three read tools behind Limn's workspace MCP server (docs/CODEX-PLAN.md § 3.3): `read_file`,
// `list_files` and `search`. With Codex's shell OFF these are the agent's ONLY way to read code, so
// this module IS the path guard for reads, enforced in code:
//
// • Every path the model names is placed by `realPathFor` (review/path-guard.ts — the SAME rule the
//   Claude PreToolUse hook uses): `~` expanded, `..` folded, symlinks followed. It is served only
//   when the REAL path is inside a read root (`isWithin`), so a relative `../x`, an absolute path
//   and a symlink pointing out of the worktree are all refused (CODEX-SPIKE.md § 2's three cases).
//   Relative paths are read against the FIRST root (the run's working directory).
// • Walks never descend a symlinked directory, and a symlinked file is listed or searched only
//   when its target is inside a root.
// • Untrusted patterns run on the linear-time matcher (`linear-regex.ts`), never `new RegExp`.
// • Everything is capped and the cap is STATED in the answer: file size, lines per read, output
//   bytes, files walked, bytes searched, matcher work. Binary files are named, never dumped.
//
// Node built-ins only (plus two pure modules): this runs inside the MCP server's own process, which
// Codex starts, and must load in a release install that carries no AI package.
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { isWithin, realPathFor, resolveReal } from '../../review/path-guard.js';
import { compileGlob, compileLinearRegex, PatternError, workBudget, type LinearMatcher, type WorkBudget } from './linear-regex.js';

export const MAX_READ_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_CHARS = 256 * 1024;
export const DEFAULT_READ_LINES = 2000;
export const MAX_LINE_CHARS = 2000;
export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 2000;
export const MAX_WALK_ENTRIES = 50_000;
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 500;
export const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
export const MAX_MATCH_LINE_CHARS = 20_000;
export const SEARCH_WORK_STEPS = 50_000_000;
const SHOWN_MATCH_CHARS = 300;
const BINARY_SNIFF_BYTES = 8000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** A refusal or a bad argument: its message is the sentence the model reads (MCP `isError`). */
export class ToolRefusal extends Error {}

export interface WorkspaceTools {
  /** The resolved read roots (real paths), the working directory first. */
  roots: readonly string[];
  call(name: string, args: unknown): string;
}

export const WORKSPACE_TOOL_DEFS = [
  {
    name: 'read_file',
    description:
      'Read a text file in the workspace, with line numbers. A relative path is read from the workspace root. Reads up to 2000 lines; pass offset (the first line, 1-based) and limit to read a long file in parts.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace root (or absolute inside it).' },
        offset: { type: 'integer', minimum: 1, description: 'First line to read, 1-based. Default 1.' },
        limit: { type: 'integer', minimum: 1, maximum: DEFAULT_READ_LINES, description: 'Lines to read. Default and maximum 2000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List files in the workspace, optionally under a directory and filtered by a glob ("*.ts", "src/**/*.test.ts", "{a,b}/*"). A glob with no "/" matches file names anywhere. .git and node_modules are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list. Default: the whole workspace.' },
        pattern: { type: 'string', description: 'Glob filter, relative to path.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, description: 'Most files to return. Default 500.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Search workspace files line by line for a regular expression (or literal text with literal=true). Returns path:line: text. Supports classes, groups, alternation and repeats; not back-references or look-around.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (or literal text when literal is true).' },
        path: { type: 'string', description: 'File or directory to search. Default: the whole workspace.' },
        glob: { type: 'string', description: 'Only search files matching this glob ("*.ts").' },
        literal: { type: 'boolean', description: 'Treat pattern as plain text. Default false.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive. Default false.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, description: 'Most matching lines to return. Default 100.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
] as const;

function argsObject(args: unknown): Record<string, unknown> {
  if (args == null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolRefusal('The arguments must be an object.');
  return args as Record<string, unknown>;
}

function optString(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolRefusal(`"${key}" must be a string.`);
  return v;
}

function optInt(a: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = a[key];
  if (v == null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new ToolRefusal(`"${key}" must be a whole number of at least ${min}.`);
  return Math.min(v, max);
}

function optBool(a: Record<string, unknown>, key: string): boolean {
  const v = a[key];
  if (v == null) return false;
  if (typeof v !== 'boolean') throw new ToolRefusal(`"${key}" must be true or false.`);
  return v;
}

function isBinary(buf: Buffer, length: number): boolean {
  const n = Math.min(length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) if (lines[i]!.endsWith('\r')) lines[i] = lines[i]!.slice(0, -1);
  return lines;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a whole regular file of at most `max` bytes; null when it is larger. */
function readCapped(real: string, max: number): Buffer | null {
  const fd = openSync(real, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > max) return null;
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === size ? buf : buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

interface WalkedFile {
  real: string;
  /** The path as walked (a symlink keeps its own name) — what the answer shows. */
  shown: string;
  /** Relative to the walk's base, `/`-separated (what a glob matches). */
  rel: string;
}

/** Create the tools for `readRoots` (resolved here; the first is where relative paths start). */
export function createWorkspaceTools(readRoots: readonly string[]): WorkspaceTools {
  const roots: string[] = [];
  for (const r of readRoots) {
    if (typeof r !== 'string' || r === '' || !isAbsolute(r)) throw new Error(`read root must be an absolute path: ${String(r)}`);
    const real = resolveReal(r);
    if (!roots.includes(real)) roots.push(real);
  }
  if (roots.length === 0) throw new Error('the workspace MCP server needs at least one read root');
  const base = roots[0]!;

  const inside = (real: string) => roots.some((r) => isWithin(r, real));

  /** Place a model-named path; refuse it unless its REAL path is inside a read root. */
  const place = (raw: string): string => {
    const real = realPathFor(raw, base);
    if (real == null || !inside(real)) {
      throw new ToolRefusal(`Refused: ${raw} is outside the workspace. Only files under the workspace can be read.`);
    }
    return real;
  };

  /** How a real path is shown: relative to the first root, else absolute (another root). */
  const display = (real: string): string => {
    if (isWithin(base, real)) {
      const rel = relative(base, real);
      return rel === '' ? '.' : rel.split(sep).join('/');
    }
    return real;
  };

  function* walk(dir: string, budget: { entries: number; truncated: boolean }): Generator<WalkedFile> {
    const stack: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: '' }];
    while (stack.length > 0) {
      const { abs, rel } = stack.pop()!;
      let names: string[];
      try {
        names = readdirSync(abs);
      } catch {
        continue;
      }
      names.sort();
      const dirs: Array<{ abs: string; rel: string }> = [];
      for (const name of names) {
        if (--budget.entries < 0) {
          budget.truncated = true;
          return;
        }
        const childAbs = join(abs, name);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        let st;
        try {
          st = lstatSync(childAbs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) dirs.push({ abs: childAbs, rel: childRel });
        } else if (st.isFile()) {
          yield { real: childAbs, shown: childAbs, rel: childRel };
        } else if (st.isSymbolicLink()) {
          // Never descend a linked directory; a linked FILE counts only when it lands inside a root.
          const target = resolveReal(childAbs);
          if (!inside(target)) continue;
          try {
            if (statSync(target).isFile()) yield { real: target, shown: childAbs, rel: childRel };
          } catch {
            /* dangling */
          }
        }
      }
      for (let k = dirs.length - 1; k >= 0; k--) stack.push(dirs[k]!);
    }
  }

  /** The files under `path` (a file or a directory; default every root), filtered by `glob`. */
  function* filesUnder(
    path: string | undefined,
    glob: LinearMatcher | null,
    globHasSlash: boolean,
    budget: { entries: number; truncated: boolean },
    work: WorkBudget,
  ): Generator<WalkedFile> {
    const starts = path === undefined ? roots : [place(path)];
    for (const start of starts) {
      let st;
      try {
        st = statSync(start);
      } catch {
        throw new ToolRefusal(`No such file or directory: ${path ?? display(start)}.`);
      }
      if (st.isFile()) {
        yield { real: start, shown: start, rel: basename(start) };
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const f of walk(start, budget)) {
        if (glob && !glob.test(globHasSlash ? f.rel : basename(f.rel), work)) continue;
        yield f;
      }
    }
  }

  const compileGlobArg = (glob: string | undefined): LinearMatcher | null => {
    if (glob === undefined) return null;
    try {
      return compileGlob(glob);
    } catch (e) {
      if (e instanceof PatternError) throw new ToolRefusal(`Bad glob: ${e.message}`);
      throw e;
    }
  };

  function readFile(a: Record<string, unknown>): string {
    const raw = optString(a, 'path');
    if (raw === undefined) throw new ToolRefusal('"path" is required.');
    const offset = optInt(a, 'offset', 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = optInt(a, 'limit', DEFAULT_READ_LINES, 1, DEFAULT_READ_LINES);
    const real = place(raw);
    let st;
    try {
      st = statSync(real);
    } catch {
      throw new ToolRefusal(`No such file: ${raw}.`);
    }
    if (st.isDirectory()) throw new ToolRefusal(`${raw} is a directory. Use list_files to see what is in it.`);
    if (!st.isFile()) throw new ToolRefusal(`${raw} is not a regular file.`);
    if (st.size > MAX_READ_BYTES) {
      throw new ToolRefusal(`${raw} is ${megabytes(st.size)}, more than read_file's ${megabytes(MAX_READ_BYTES)} limit. Use search to find lines in a smaller file, or skip it.`);
    }
    const buf = readCapped(real, MAX_READ_BYTES);
    if (buf == null) throw new ToolRefusal(`${raw} grew past read_file's ${megabytes(MAX_READ_BYTES)} limit.`);
    if (isBinary(buf, buf.length)) return `${display(real)} is a binary file (${buf.length} bytes). Its contents are not shown.`;
    const lines = splitLines(buf.toString('utf8'));
    if (lines.length === 0) return `${display(real)} is empty.`;
    if (offset > lines.length) throw new ToolRefusal(`${raw} has ${lines.length} lines; offset ${offset} is past the end.`);
    const from = offset - 1;
    const to = Math.min(lines.length, from + limit);
    const out: string[] = [];
    let chars = 0;
    let last = from;
    for (let i = from; i < to; i++) {
      let line = lines[i]!;
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)} … (line cut at ${MAX_LINE_CHARS} characters)`;
      const row = `${i + 1}\t${line}`;
      if (chars + row.length + 1 > MAX_OUTPUT_CHARS && out.length > 0) break;
      out.push(row);
      chars += row.length + 1;
      last = i + 1;
    }
    if (from === 0 && last === lines.length) return out.join('\n');
    const more = last < lines.length ? ` Pass offset=${last + 1} to read on.` : '';
    return `${out.join('\n')}\n(lines ${from + 1}–${last} of ${lines.length}.${more})`;
  }

  function listFiles(a: Record<string, unknown>): string {
    const path = optString(a, 'path');
    const pattern = optString(a, 'pattern');
    const limit = optInt(a, 'limit', DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const glob = compileGlobArg(pattern);
    const budget = { entries: MAX_WALK_ENTRIES, truncated: false };
    const work = workBudget(SEARCH_WORK_STEPS);
    const out: string[] = [];
    let more = false;
    for (const f of filesUnder(path, glob, pattern?.includes('/') ?? false, budget, work)) {
      if (out.length >= limit) {
        more = true;
        break;
      }
      out.push(display(f.shown));
    }
    const notes: string[] = [];
    if (more) notes.push(`(first ${limit} files shown; narrow with path or pattern to see the rest.)`);
    if (budget.truncated) notes.push(`(stopped after ${MAX_WALK_ENTRIES} entries; narrow with path.)`);
    if (work.exhausted) notes.push('(the glob was too costly to finish; use a simpler one.)');
    if (out.length === 0) return ['(no files match)', ...notes].join('\n');
    return [...out, ...notes].join('\n');
  }

  function search(a: Record<string, unknown>): string {
    const pattern = optString(a, 'pattern');
    if (pattern === undefined) throw new ToolRefusal('"pattern" is required.');
    const path = optString(a, 'path');
    const globArg = optString(a, 'glob');
    const literal = optBool(a, 'literal');
    const ignoreCase = optBool(a, 'ignore_case');
    const limit = optInt(a, 'limit', DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const glob = compileGlobArg(globArg);
    const work = workBudget(SEARCH_WORK_STEPS);
    let test: (line: string) => boolean;
    if (literal) {
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      test = (line) => {
        work.left -= line.length;
        if (work.left < 0) work.exhausted = true;
        return (ignoreCase ? line.toLowerCase() : line).includes(needle);
      };
    } else {
      let m: LinearMatcher;
      try {
        m = compileLinearRegex(pattern, { ignoreCase });
      } catch (e) {
        if (e instanceof PatternError) throw new ToolRefusal(`Bad pattern: ${e.message} Or pass literal=true.`);
        throw e;
      }
      test = (line) => m.test(line, work);
    }
    const budget = { entries: MAX_WALK_ENTRIES, truncated: false };
    const out: string[] = [];
    let scanned = 0;
    let tooBig = 0;
    let more = false;
    let bytesCapped = false;
    let chars = 0;
    outer: for (const f of filesUnder(path, glob, globArg?.includes('/') ?? false, budget, work)) {
      if (work.exhausted) break;
      let buf: Buffer | null;
      try {
        buf = readCapped(f.real, MAX_READ_BYTES);
      } catch {
        continue;
      }
      if (buf == null) {
        tooBig++;
        continue;
      }
      if (scanned + buf.length > MAX_SEARCH_BYTES) {
        bytesCapped = true;
        break;
      }
      scanned += buf.length;
      if (isBinary(buf, buf.length)) continue;
      const lines = splitLines(buf.toString('utf8'));
      for (let i = 0; i < lines.length; i++) {
        const full = lines[i]!;
        const line = full.length > MAX_MATCH_LINE_CHARS ? full.slice(0, MAX_MATCH_LINE_CHARS) : full;
        if (!test(line)) {
          if (work.exhausted) break outer;
          continue;
        }
        if (out.length >= limit) {
          more = true;
          break outer;
        }
        const shown = full.length > SHOWN_MATCH_CHARS ? `${full.slice(0, SHOWN_MATCH_CHARS)} …` : full;
        const row = `${display(f.shown)}:${i + 1}: ${shown}`;
        if (chars + row.length + 1 > MAX_OUTPUT_CHARS) {
          more = true;
          break outer;
        }
        out.push(row);
        chars += row.length + 1;
      }
    }
    const notes: string[] = [];
    if (more) notes.push(`(first ${out.length} matches shown; narrow with path or glob to see the rest.)`);
    if (work.exhausted) notes.push('(stopped early: the search was too costly. Use a simpler pattern, a path or a glob.)');
    if (bytesCapped) notes.push(`(stopped after ${megabytes(MAX_SEARCH_BYTES)} of files; narrow with path or glob.)`);
    if (budget.truncated) notes.push(`(stopped after ${MAX_WALK_ENTRIES} entries; narrow with path.)`);
    if (tooBig > 0) notes.push(`(${tooBig} file(s) over ${megabytes(MAX_READ_BYTES)} were not searched.)`);
    if (out.length === 0) return ['(no matches)', ...notes].join('\n');
    return [...out, ...notes].join('\n');
  }

  return {
    roots,
    call(name, args) {
      const a = argsObject(args);
      switch (name) {
        case 'read_file':
          return readFile(a);
        case 'list_files':
          return listFiles(a);
        case 'search':
          return search(a);
        default:
          throw new ToolRefusal(`Unknown tool: ${name}.`);
      }
    },
  };
}
