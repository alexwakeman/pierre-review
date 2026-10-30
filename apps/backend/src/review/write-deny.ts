import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isWithin, realPathFor, resolveReal } from './path-guard.js';

// THE BUILD'S WRITE DENY-LIST (docs/STORY-BUILD.md § Phases and agents; docs/SECURITY.md). A story build
// is a WRITE agent driven by UNTRUSTED text — the ticket, its comments, other people's PR cards, the
// docs — so beside the path guard (which keeps every write inside the worktree) a second rule keeps it
// out of the files that RUN CODE or decide what runs: CI and automation config, git's own files, hook
// managers, package-manager config and lockfiles, and the coding-agent settings a person's own tools read.
// A change there would land in a pull request that runs it (a workflow) or on the next install / commit /
// agent session of whoever checks the branch out.
//
// ONE pure rule, used by BOTH providers: the Claude PreToolUse hook (ai/providers/claude.ts, when the run
// sets `protectWrites`) and Codex's guard process (ai/codex/hook-rule.ts, `GuardRoots.protect`). Node
// built-ins and path-guard.ts only, because the Codex hook process imports it.
//
// A path is judged RELATIVE TO THE WRITE ROOT it falls in, twice — as named and with symlinks followed —
// so a link inside the repository can neither hide a protected file nor make one look harmless.

/** A directory anywhere in the path that is protected as a whole. */
const PROTECTED_DIRS: ReadonlySet<string> = new Set([
  '.github',
  '.gitlab',
  '.circleci',
  '.buildkite',
  '.husky',
  '.yarn',
  '.devcontainer',
  '.claude',
  '.codex',
  '.cursor',
]);

/** A file name (any directory) that is protected. */
const PROTECTED_FILES: ReadonlySet<string> = new Set([
  // package-manager config and hooks
  '.npmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  '.envrc',
  // lockfiles
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'composer.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'go.sum',
  'Podfile.lock',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
  'packages.lock.json',
  'gradle.lockfile',
  // CI and hook config
  '.gitlab-ci.yml',
  '.travis.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'appveyor.yml',
  '.appveyor.yml',
  '.drone.yml',
  'Jenkinsfile',
  'cloudbuild.yaml',
  'cloudbuild.yml',
  '.pre-commit-config.yaml',
  '.pre-commit-hooks.yaml',
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
  '.lintstagedrc',
  'lint-staged.config.js',
  '.huskyrc',
  // the agent instructions a person's own tools read
  'CLAUDE.md',
  'AGENTS.md',
]);

/** Why `relPath` (relative to the repository root, `/`-separated or the OS separator) is off-limits, or null. */
export function protectedWriteReason(relPath: string): string | null {
  const parts = relPath.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  for (const dir of parts.slice(0, -1)) {
    if (PROTECTED_DIRS.has(dir.toLowerCase()) || dir.toLowerCase().startsWith('.git')) {
      return `${relPath} is inside ${dir}/, which a build may not change.`;
    }
  }
  const file = parts[parts.length - 1]!;
  const lower = file.toLowerCase();
  if (PROTECTED_DIRS.has(lower)) return `${relPath} is ${file}, which a build may not change.`;
  // `.git` itself, `.gitignore`, `.gitattributes`, `.gitmodules`, `.git-blame-ignore-revs` …
  if (lower.startsWith('.git')) return `${relPath} is git's own configuration, which a build may not change.`;
  if (lower.startsWith('.yarnrc')) return `${relPath} is package-manager configuration, which a build may not change.`;
  if (PROTECTED_FILES.has(file) || PROTECTED_FILES.has(lower)) {
    return `${relPath} is a lockfile, CI or tool configuration file, which a build may not change.`;
  }
  return null;
}

/**
 * Judge one path a write call names. `raw` is resolved against `from` (the call's cwd); each write root
 * that holds it decides by the path RELATIVE to that root, both as named and with symlinks followed.
 * A path outside every write root is not this rule's business (the path guard refuses it): null.
 */
export function protectedWriteFor(raw: string, from: string, writeRoots: readonly string[]): string | null {
  if (raw === '' || raw.includes('\u0000')) return null;
  const named = resolve(from, raw);
  const real = realPathFor(raw, from);
  for (const root of writeRoots) {
    if (!isAbsolute(root)) continue;
    const rootNamed = resolve(root);
    const rootReal = resolveReal(rootNamed);
    for (const [r, p] of [
      [rootNamed, named],
      [rootReal, real],
    ] as const) {
      if (p == null || !isWithin(r, p)) continue;
      const rel = relative(r, p);
      const why = protectedWriteReason(rel === '' ? '.' : rel.split(sep).join('/'));
      if (why) return why;
    }
  }
  return null;
}

/** The write tools whose `file_path` / `notebook_path` names the file (Claude's). */
const CLAUDE_WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export type ProtectedWriteDecision =
  | { continue: true }
  | { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } };

/** The Claude PreToolUse decision for one call (every other tool passes; the path guard judges it). */
export function judgeProtectedWrite(writeRoots: readonly string[], cwd: string, toolName: string, toolInput: unknown): ProtectedWriteDecision {
  if (!CLAUDE_WRITE_TOOLS.has(toolName)) return { continue: true };
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  for (const key of ['file_path', 'notebook_path'] as const) {
    const v = input[key];
    if (typeof v !== 'string' || v === '') continue;
    const why = protectedWriteFor(v, cwd, writeRoots);
    if (why) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${why} Leave it as it is and say so in your report.`,
        },
      };
    }
  }
  return { continue: true };
}

/** The rule as one Claude SDK PreToolUse matcher entry. */
export function protectedWriteHook(writeRoots: readonly string[], cwd: string): {
  hooks: Array<(input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) => Promise<ProtectedWriteDecision>>;
} {
  return {
    hooks: [
      async (input) =>
        input.hook_event_name === 'PreToolUse' ? judgeProtectedWrite(writeRoots, cwd, input.tool_name ?? '', input.tool_input) : { continue: true },
    ],
  };
}
