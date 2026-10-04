import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DispatchDecision } from './claude-review/specialists.js';

// THE PATH GUARD — a PreToolUse hook that keeps an agent's file tools inside an allow-list of
// directories: the run's cwd plus every worktree it was handed (`additionalDirectories`).
//
// WHY A HOOK. Review runs use `permissionMode: 'bypassPermissions'`, under which nothing confines
// an ABSOLUTE path: `Read /Users/me/.ssh/id_rsa` or `Grep path=/` simply runs. With one worktree on
// disk that was a theoretical gap; a ticket review checks out up to eight repositories (and a deep
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

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
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
}

/**
 * A guard allowing `cwd` and `extraRoots` (e.g. member worktrees). Roots are resolved once, at
 * creation; create the guard after the directories exist.
 */
export function createPathGuard(cwd: string, extraRoots: readonly string[] = []): PathGuard {
  const base = resolve(cwd);
  const roots = [base, ...extraRoots.map((r) => resolve(base, expandHome(r)))].map(resolveReal);
  const deny = (reason: string): DispatchDecision => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  const allowed = (raw: string, from: string): boolean => {
    if (raw.includes('\u0000')) return false;
    const abs = resolve(from, expandHome(raw));
    const real = resolveReal(abs);
    return roots.some((r) => isWithin(r, real));
  };
  const outside = (raw: string): DispatchDecision =>
    deny(`${raw} is outside the checked-out repositories. Only files under them can be read.`);

  return {
    decide(toolName, toolInput) {
      const input =
        toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
      for (const key of PATH_KEYS) {
        const v = input[key];
        if (v == null || v === '') continue;
        if (typeof v !== 'string') return deny(`The ${key} argument must be a path.`);
        if (!allowed(v, base)) return outside(v);
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
        if (!allowed(prefix, from)) return outside(input.pattern);
      }
      return { continue: true };
    },
    roots: () => [...roots],
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
