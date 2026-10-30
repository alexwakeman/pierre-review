// THE SANDBOXED CHECKS RUNNER — shared types (docs/SECURITY.md § Sandboxed checks; docs/CLAUDE-REVIEW.md
// § AI Fix "Run tests"). Types only, and ⚠ NODE BUILT-INS AND RELATIVE FILES ONLY in this folder's
// runtime half (spawn.ts, sandbox.ts, env.ts, spec.ts): Codex's workspace MCP server imports it, and
// scripts/build-release.mjs asserts that server imports nothing else.

/** What a check is for. 'hook' is the repository's pre-commit hook: Limn runs it, the agent never. */
export type CheckKind = 'test' | 'lint' | 'typecheck' | 'check' | 'hook';

/** Which toolchain a check belongs to (its dependency step and its cache variables). */
export type CheckEcosystem = 'node' | 'python' | 'rust' | 'go' | 'gradle' | 'maven' | 'make' | 'git';

export type NodePackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/**
 * One check a repository DECLARES, derived from its own files (discover.ts) — never free text from a
 * model or a reader. `argv` is what Limn spawns (no shell); `refused` says why it may not run at all.
 */
export interface CheckDef {
  /** The name the agent passes to run_check and the reader ticks (e.g. `test`, `lint:types`). */
  name: string;
  kind: CheckKind;
  ecosystem: CheckEcosystem;
  /** The program and its arguments. Never joined into a shell string. */
  argv: string[];
  /** Where it was declared, in plain words: `package.json script "test"`. */
  source: string;
  /** Ticked by default (test, lint and typecheck when present; the commit hook). */
  defaultOn: boolean;
  /** It needs Docker services (a compose file, testcontainers, a script naming docker). */
  needsDocker: boolean;
  /** Why it may not run (the deny scan, an unsupported hook), or null. */
  refused: string | null;
}

/** One dependency step Limn runs before the checks (the only step with network). */
export interface PrepareStep {
  ecosystem: CheckEcosystem;
  argv: string[];
  /** Why it was skipped instead (e.g. Yarn runs a copy of itself from the repository). */
  refused: string | null;
}

/** The repository's commit hook, when it has one Limn can run. */
export interface HookDef {
  kind: 'husky' | 'lefthook' | 'simple-git-hooks';
  /** The hook script Limn installs as `pre-commit` in a throwaway hooks folder (repo-authored shell). */
  script: string;
  source: string;
}

/** Everything one repository declares (discover.ts `discoverChecks`). */
export interface CheckPlan {
  checks: CheckDef[];
  prepare: PrepareStep[];
  hook: HookDef | null;
  /** The Node package manager the lockfile names, when the repository is a Node project. */
  packageManager: NodePackageManager | null;
}

/** How one check run ended. */
export type CheckRunStatus = 'passed' | 'failed' | 'timed_out' | 'skipped' | 'error';

export interface CheckRunResult {
  name: string;
  kind: CheckKind;
  /** The argv, joined for display only. */
  command: string;
  status: CheckRunStatus;
  exitCode: number | null;
  durationMs: number;
  /** stdout + stderr, ANSI stripped, capped (head + tail). */
  output: string;
  truncated: boolean;
  /** One plain line when it did not run (Docker off, no sandbox) or why it errored. */
  note: string | null;
}

/** Which OS sandbox wraps a check: macOS Seatbelt, Linux bubblewrap, or none (refused unless allowed). */
export type SandboxKind = 'seatbelt' | 'bwrap' | 'none';
