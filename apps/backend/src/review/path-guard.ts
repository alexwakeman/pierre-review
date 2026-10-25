import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DispatchDecision } from './claude-review/specialists.js';

// THE PATH GUARD — a PreToolUse hook that keeps an agent's file tools inside an allow-list of
// directories: the run's cwd plus every worktree it was handed (`additionalDirectories`).
//
// WHY A HOOK. Review runs use `permissionMode: 'bypassPermissions'`, under which nothing confines
// an ABSOLUTE path: `Read /Users/me/.ssh/id_rsa` or `Grep path=/` simply runs. With one worktree on
// disk that was a theoretical gap; a ticket review checks out up to thirty PRs across several repositories (and a deep
// PR review its peers), and the prompt it reads is attacker-authored. A PreToolUse deny holds under
// bypassPermissions (the specialist cap relies on the same property).
//
// WHAT IS CHECKED, for EVERY tool call (not only Read/Glob/Grep — a future file tool is covered):
//   `file_path`, `path`, `notebook_path`   resolved against cwd, then symlinks followed
//   Glob's `pattern`                        its literal prefix (up to the first glob character),
//                                           resolved against the call's `path` (else cwd)
// A Glob pattern with a `..` segment is denied outright: a wildcard before it makes the prefix
// meaningless. Grep's `pattern` is a regular expression, not a path, and is never read as one;
// its `glob` filter only narrows files under `path`, which is checked.
//
// RESOLUTION. `~` is the home directory; `..` is folded; symlinks are followed on the DEEPEST
// EXISTING ancestor (a path that does not exist yet still resolves through a symlinked parent), so a
// link inside a worktree pointing outside it is denied. Roots are resolved the same way (on macOS
// /tmp is /private/tmp). Anything that cannot be resolved is denied.
//
// READ-ONLY ROOTS (`opts.readOnlyRoots`): a folder the run may READ but never write — the workspace's
// reference library (docs/REFERENCE-DOCS.md § Use in reviews). A path inside one passes ONLY for the
// read tools (Read, Glob, Grep, LS); any other tool naming it is denied, whatever else the run's
// allow-list says. A path inside an ordinary root is decided as before.

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
/** The tools that may name a path inside a read-only root. */
export const READ_ONLY_ROOT_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS']);
const GLOB_CHARS = /[*?[\]{}]/;

/** Follow symlinks on the deepest existing ancestor of `abs`, re-appending the missing tail. */
export function resolveReal(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail.push(basename(head));
      head = parent;
    }
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * THE ONE RESOLUTION RULE: `raw` (a path an agent named) resolved against `from` — `~` expanded,
 * `..` folded, symlinks followed on the deepest existing ancestor. Null for a path carrying a NUL
 * byte (never a real file name; refused). The Claude hook above and Codex's workspace MCP server +
 * PreToolUse hook (`ai/codex/`) all place a path through this, then test it with `isWithin`.
 */
export function realPathFor(raw: string, from: string): string | null {
  if (raw.includes('\u0000')) return null;
  return resolveReal(resolve(from, expandHome(raw)));
}

/** True when `p` is `root` or inside it (both already absolute and real). */
export function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface PathGuard {
  /** Decide one tool call, in the SDK's PreToolUse hook-output shape. */
  decide(toolName: string, toolInput: unknown): DispatchDecision;
  /** The resolved allow-list (for tests and logs). */
  roots(): string[];
  /** The resolved read-only roots (for tests and logs). */
  readOnlyRoots(): string[];
}

/**
 * A guard allowing `cwd` and `extraRoots` (e.g. member worktrees). Roots are resolved once, at
 * creation; create the guard after the directories exist.
 */
export function createPathGuard(
  cwd: string,
  extraRoots: readonly string[] = [],
  opts: { readOnlyRoots?: readonly string[] } = {},
): PathGuard {
  const base = resolve(cwd);
  const roots = [base, ...extraRoots.map((r) => resolve(base, expandHome(r)))].map(resolveReal);
  const readOnly = (opts.readOnlyRoots ?? []).map((r) => resolveReal(resolve(base, expandHome(r))));
  const deny = (reason: string): DispatchDecision => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  // 'rw' = inside an ordinary root; 'ro' = inside a read-only root only; null = outside every root.
  const placed = (raw: string, from: string): 'rw' | 'ro' | null => {
    const real = realPathFor(raw, from);
    if (real == null) return null;
    if (roots.some((r) => isWithin(r, real))) return 'rw';
    if (readOnly.some((r) => isWithin(r, real))) return 'ro';
    return null;
  };
  const outside = (raw: string): DispatchDecision =>
    deny(`${raw} is outside the checked-out repositories. Only files under them can be read.`);
  const readOnlyDenied = (raw: string): DispatchDecision =>
    deny(`${raw} is in the reference library, which can only be read (Read, Glob, Grep).`);
  const check = (toolName: string, raw: string, from: string): DispatchDecision | null => {
    const where = placed(raw, from);
    if (where === 'rw') return null;
    if (where === 'ro') return READ_ONLY_ROOT_TOOLS.has(toolName) ? null : readOnlyDenied(raw);
    return outside(raw);
  };

  return {
    decide(toolName, toolInput) {
      const input =
        toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
      for (const key of PATH_KEYS) {
        const v = input[key];
        if (v == null || v === '') continue;
        if (typeof v !== 'string') return deny(`The ${key} argument must be a path.`);
        const refused = check(toolName, v, base);
        if (refused) return refused;
      }
      if (toolName === 'Glob' && typeof input.pattern === 'string') {
        const pattern = expandHome(input.pattern);
        if (pattern.split(/[\\/]/).includes('..')) {
          return deny('Glob patterns may not contain "..". Search from a directory instead.');
        }
        const from = typeof input.path === 'string' && input.path !== '' ? resolve(base, expandHome(input.path)) : base;
        const segments = pattern.split('/');
        const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
        const literal = (firstGlob === -1 ? segments : segments.slice(0, firstGlob)).join('/');
        const prefix = literal === '' ? (isAbsolute(pattern) ? '/' : '.') : literal;
        const where = placed(prefix, from);
        if (where == null) return outside(input.pattern);
        if (where === 'ro' && !READ_ONLY_ROOT_TOOLS.has(toolName)) return readOnlyDenied(input.pattern);
      }
      return { continue: true };
    },
    roots: () => [...roots],
    readOnlyRoots: () => [...readOnly],
  };
}

/** The guard as one SDK PreToolUse matcher entry: `hooks: { PreToolUse: [pathGuardHook(g)] }`. */
export function pathGuardHook(guard: PathGuard): {
  hooks: Array<(input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) => Promise<DispatchDecision>>;
} {
  return {
    hooks: [
      async (input) =>
        input.hook_event_name === 'PreToolUse'
          ? guard.decide(input.tool_name ?? '', input.tool_input)
          : { continue: true },
    ],
  };
}
