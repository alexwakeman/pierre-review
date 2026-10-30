// ONE RUN'S CHECKS (docs/CLAUDE-REVIEW.md § AI Fix "Run tests"; docs/SECURITY.md § Sandboxed checks)
// — the reusable API the AI Fix build uses today and a story build will use next:
//
//   const opened = await openCheckSession({ worktree, repoCloneDir, wanted: ['test', 'lint'], … });
//   if (!opened.ok) → run without tests, show `opened.note`
//   opened.session.agentTool()     → the `run_check` tool for the agent (both providers)
//   await opened.session.verify()  → Limn's own final run of every chosen check
//   await opened.session.runHook(message, baseSha)  → the commit with the pre-commit hook enabled
//   opened.session.restoreGit()    → before ANY git command of Limn's in the worktree
//   await opened.session.close()
//
// The order inside `openCheckSession`: read the declared checks from the worktree, keep the ones the
// reader ticked (and the allow-list holds), find the sandbox (none ⇒ refuse, unless allowed), ask
// Docker first for checks that need it, install dependencies (the one step with network, no lifecycle
// scripts), then FREEZE the agent's list (spec.ts). Node built-ins and relative files only.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { dockerPreflight } from './docker.js';
import { scrubbedEnv } from './env.js';
import { commitArgv, stageIntoThrowawayRepo, writeHooksDir } from './hooks.js';
import { discoverLocalChecks } from './local.js';
import { darwinUserFolders, detectSandbox, wrapCommand, type SandboxPolicy } from './sandbox.js';
import { CheckToolRunner, runCheckDescription, runFrozenCheck, type CheckSpec, type FrozenCheck } from './spec.js';
import { runProcess } from './spawn.js';
import type { CheckDef, CheckPlan, CheckRunResult, HookDef, SandboxKind } from './types.js';

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_PREPARE_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60_000;
/** Characters of one check's output kept (and handed to the agent). */
export const DEFAULT_OUTPUT_CAP = 24_000;
/** run_check calls one agent run may make. */
export const DEFAULT_MAX_AGENT_CALLS = 12;

/**
 * Untracked output a check commonly leaves behind, kept OUT of the captured patch (the run's excludes
 * file; Limn's git only). Tracked files are never affected. A new file the agent writes under one of
 * these names is excluded too — the reader sees the diff before pushing.
 */
export const CHECK_OUTPUT_PATTERNS: readonly string[] = [
  'node_modules/',
  'coverage/',
  '.nyc_output/',
  'test-results/',
  'playwright-report/',
  'junit*.xml',
  '.pytest_cache/',
  '__pycache__/',
  '*.pyc',
  '.tox/',
  '.nox/',
  '.venv/',
  '.mypy_cache/',
  '.ruff_cache/',
  'target/',
  '.gradle/',
  '.turbo/',
  '.eslintcache',
  '*.tsbuildinfo',
  '.vitest/',
  '.jest-cache/',
];

/** Toolchain homes inside the home folder a check may READ (version managers, compilers). */
const TOOLCHAIN_DIRS = [
  '.nvm',
  '.volta',
  '.fnm',
  '.local/share/fnm',
  '.asdf',
  '.local/share/mise',
  '.local/bin',
  '.rustup',
  '.cargo/bin',
  'go',
  'sdk',
  '.bun',
  '.deno',
  '.sdkman',
  '.pyenv',
  '.rbenv',
  'Library/pnpm',
  '.local/share/pnpm',
];

/** Never readable, even inside a readable folder. */
const HIDDEN_IN_HOME = [
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.m2/settings.xml',
  '.m2/settings-security.xml',
  '.gradle/gradle.properties',
  '.local/share/keyrings',
  '.pyenv/.pyenv-credentials',
  '.docker/config.json',
];

export interface OpenCheckSessionOptions {
  /** The run's worktree: the only folder of the repository a check may write. */
  worktree: string;
  /** The shared clone the worktree belongs to (read only: git objects). */
  repoCloneDir: string;
  /** The check names the reader ticked. Anything not in the repository's allow-list is skipped. */
  wanted: readonly string[];
  /** Where per-run folders go (`<data dir>/check-runs`). */
  runRoot: string;
  /** Limn's private toolchain cache (`<data dir>/check-cache`): writable by the dependency step only. */
  cacheDir: string;
  /** Folders a check may never read, besides the home folder (Limn's data folder). */
  darkRoots: string[];
  /** LIMN_CHECKS_ALLOW_UNSANDBOXED: run with no OS sandbox (warned on the run). */
  allowUnsandboxed: boolean;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  checkTimeoutMs?: number;
  prepareTimeoutMs?: number;
  hookTimeoutMs?: number;
  outputCap?: number;
  maxAgentCalls?: number;
  /** One short status line per step ("Installing dependencies"). */
  onStatus?: (text: string) => void;
  /** For tests: the sandbox to use instead of detecting one. */
  sandboxOverride?: { kind: SandboxKind; reason: string | null };
  /** For tests: the Docker answer instead of asking. */
  dockerOverride?: { running: boolean; note: string | null };
}

export type OpenCheckSessionResult =
  | { ok: true; session: CheckSession }
  | {
      ok: false;
      /** Why no check ran, one sentence. */
      note: string;
      /** The checks that were asked for, each marked skipped. */
      skipped: CheckRunResult[];
    };

function skipped(c: Pick<CheckDef, 'name' | 'kind' | 'argv'>, note: string): CheckRunResult {
  return { name: c.name, kind: c.kind, command: c.argv.join(' '), status: 'skipped', exitCode: null, durationMs: 0, output: '', truncated: false, note };
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Read folders inside the home folder that exist (real paths), plus the PATH entries under it. */
export function readableToolchains(home: string, env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const d of TOOLCHAIN_DIRS) {
    const p = join(home, d);
    if (existsSync(p)) out.add(real(p));
  }
  const realHome = real(home);
  // ⚠ Never a folder DIRECTLY in the home folder: `~/.docker/bin` on PATH must not open `~/.docker`
  // (its config.json may hold registry logins), nor Node at `~/.local/bin/node` all of `~/.local`.
  // A known toolchain home (TOOLCHAIN_DIRS) is already listed above.
  const deepInHome = (p: string): boolean => p.startsWith(`${realHome}/`) && relative(realHome, p).split('/').length >= 2;
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const r = real(dir);
    if (!r.startsWith(`${realHome}/`)) continue;
    out.add(r);
    // A version manager's bin/ links into its lib/ (nvm's node_modules): read the version's folder.
    const parent = dirname(r);
    if (r.endsWith('/bin') && deepInHome(parent)) out.add(parent);
  }
  // The Node running Limn (for a check that runs `node` through a manager shim).
  const nodeHome = dirname(dirname(real(process.execPath)));
  if (deepInHome(nodeHome)) out.add(nodeHome);
  return [...out];
}

export class CheckSession {
  /** The checks the agent may run (frozen; never the hook). */
  readonly agentChecks: FrozenCheck[];
  readonly specFile: string;
  readonly logFile: string;
  readonly excludesFile: string;
  private runner: CheckToolRunner | null = null;
  private closed = false;

  constructor(
    private readonly o: OpenCheckSessionOptions,
    readonly sandbox: SandboxKind,
    readonly plan: CheckPlan,
    /** The chosen, runnable checks (the hook apart). */
    readonly chosen: CheckDef[],
    /** The chosen hook, when the reader ticked it and the repository has one Limn can run. */
    readonly hook: HookDef | null,
    /** Dependency steps and their outcome. */
    readonly prepare: CheckRunResult[],
    /** Checks asked for that will not run, each with its reason. */
    readonly skipped: CheckRunResult[],
    /** Plain notes for the reader (no sandbox, Docker off …). */
    readonly notes: string[],
    private readonly runDir: string,
    private readonly specDir: string,
    private readonly sbxTmp: string,
    private readonly gitFile: { content: string } | null,
    private readonly checkEnv: Record<string, string>,
    private readonly policy: (network: 'localhost' | 'open', extraWritable?: string[], extraReadable?: string[]) => SandboxPolicy,
  ) {
    this.specFile = join(specDir, 'checks.json');
    this.logFile = join(specDir, 'agent-runs.jsonl');
    this.excludesFile = join(specDir, 'exclude');
    const timeoutMs = o.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const outputCap = o.outputCap ?? DEFAULT_OUTPUT_CAP;
    const p = policy('localhost');
    this.agentChecks = chosen.map((c) => {
      const wrapped = wrapCommand(sandbox, p, o.worktree, c.argv);
      return {
        name: c.name,
        kind: c.kind,
        display: c.argv.join(' '),
        command: wrapped.command,
        args: wrapped.args,
        cwd: o.worktree,
        env: this.checkEnv,
        timeoutMs,
        outputCap,
      };
    });
    const spec: CheckSpec = { version: 1, checks: this.agentChecks, maxCalls: o.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS, log: this.logFile };
    writeFileSync(this.specFile, JSON.stringify(spec), { mode: 0o600 });
  }

  /** The frozen list as the agent's tool (in-process: Claude). One per session, so the call cap holds. */
  agentTool(): { names: string[]; description: string; run: (args: unknown) => Promise<{ text: string; isError?: boolean }> } {
    if (!this.runner) {
      const spec: CheckSpec = { version: 1, checks: this.agentChecks, maxCalls: this.o.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS, log: this.logFile };
      this.runner = new CheckToolRunner(spec, this.o.signal);
    }
    const runner = this.runner;
    return { names: runner.names, description: runCheckDescription(runner.names), run: (args) => runner.call(args) };
  }

  /** What the agent ran (both providers log every call to the same file). */
  agentRuns(): Array<{ name: string; status: string; durationMs: number }> {
    try {
      return readFileSync(this.logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { name: string; status: string; durationMs: number })
        .filter((r) => typeof r.name === 'string' && typeof r.status === 'string');
    } catch {
      return [];
    }
  }

  /** Limn's own run of every chosen check, after the agent — the result the reader sees beside Push. */
  async verify(): Promise<CheckRunResult[]> {
    const out: CheckRunResult[] = [];
    for (const c of this.agentChecks) {
      if (this.o.signal.aborted) break;
      this.o.onStatus?.(`Running ${c.name}`);
      const before = await this.untracked();
      out.push(await runFrozenCheck(c, this.o.signal));
      await this.excludeNew(before);
    }
    return out;
  }

  /**
   * The commit, with the repository's pre-commit hook, in the sandbox (hooks.ts). 'skipped' when there
   * is no hook or nothing to commit. Leaves the worktree's own git untouched.
   */
  async runHook(message: string, baseSha: string): Promise<CheckRunResult | null> {
    if (!this.hook) return null;
    const name = 'pre-commit hook';
    const display = `git commit (${this.hook.source})`;
    this.restoreGit();
    const hooksDir = writeHooksDir(this.specDir, this.hook);
    // ⚠ In Limn's own `spec/`, NOT `sbx/`: Limn's git stages into it OUTSIDE the sandbox, and a
    // process a check left behind (a daemon outlives its process group) could otherwise plant a
    // `filter.*.clean` or similar in its config first. It is writable only to the hook's own run.
    const gitDir = join(this.specDir, 'hook-git');
    rmSync(gitDir, { recursive: true, force: true });
    let staged: boolean;
    try {
      staged = await stageIntoThrowawayRepo({
        gitDir,
        worktree: this.o.worktree,
        objectsDir: join(real(this.o.repoCloneDir), '.git', 'objects'),
        baseSha,
        hooksDir,
        excludesFile: this.excludesFile,
        env: this.checkEnv,
      });
    } catch (e) {
      return { name, kind: 'hook', command: display, status: 'error', exitCode: null, durationMs: 0, output: '', truncated: false, note: e instanceof Error ? e.message : String(e) };
    }
    if (!staged) return { name, kind: 'hook', command: display, status: 'skipped', exitCode: null, durationMs: 0, output: '', truncated: false, note: 'No changes to commit.' };
    this.o.onStatus?.('Running the pre-commit hook');
    const wrapped = wrapCommand(this.sandbox, this.policy('localhost', [gitDir], [this.excludesFile]), this.o.worktree, commitArgv(message));
    const binPath = join(this.o.worktree, 'node_modules', '.bin');
    const env = { ...this.checkEnv, GIT_DIR: gitDir, GIT_WORK_TREE: this.o.worktree, PATH: `${binPath}:${this.checkEnv.PATH ?? ''}` };
    const r = await runProcess({
      command: wrapped.command,
      args: wrapped.args,
      cwd: this.o.worktree,
      env,
      timeoutMs: this.o.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      outputCap: this.o.outputCap ?? DEFAULT_OUTPUT_CAP,
      signal: this.o.signal,
    });
    return {
      name,
      kind: 'hook',
      command: display,
      status: r.spawnError || r.aborted ? 'error' : r.timedOut ? 'timed_out' : r.exitCode === 0 ? 'passed' : 'failed',
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      output: r.output,
      truncated: r.truncated,
      note: r.spawnError ? `It could not start: ${r.spawnError}` : null,
    };
  }

  /**
   * Put the worktree's `.git` FILE back exactly as git wrote it. A check (or the agent) could replace
   * it with a pointer to a git folder of its own whose config runs a command — and Limn's own git,
   * outside the sandbox, would run it. Call before every git command of Limn's in the worktree.
   */
  restoreGit(): void {
    if (!this.gitFile) return;
    const path = join(this.o.worktree, '.git');
    let same = false;
    try {
      same = lstatSync(path).isFile() && readFileSync(path, 'utf8') === this.gitFile.content;
    } catch {
      same = false;
    }
    if (same) return;
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, this.gitFile.content);
  }

  private async untracked(): Promise<Set<string>> {
    this.restoreGit();
    const r = await runProcess({
      command: 'git',
      args: ['-c', 'core.fsmonitor=false', '-c', `core.excludesFile=${this.excludesFile}`, 'ls-files', '--others', '--exclude-standard', '--directory', '-z'],
      cwd: this.o.worktree,
      env: { PATH: this.checkEnv.PATH ?? '', HOME: join(this.sbxTmp, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      timeoutMs: 60_000,
      outputCap: 2_000_000,
    });
    return new Set(r.output.split('\0').filter(Boolean));
  }

  /** Every untracked path that appeared since `before` joins the excludes file (a check's output). */
  private async excludeNew(before: Set<string>): Promise<void> {
    const after = await this.untracked();
    const added = [...after].filter((p) => !before.has(p) && !/[\n\r]/.test(p));
    if (added.length === 0) return;
    const escaped = added.map((p) => `/${p.replace(/([\\*?[\]!#])/g, '\\$1')}`);
    writeFileSync(this.excludesFile, `${readFileSync(this.excludesFile, 'utf8')}${escaped.join('\n')}\n`);
  }

  /** Called by openCheckSession: the dependency steps, each recorded. */
  async runPrepare(steps: CheckPlan['prepare']): Promise<void> {
    for (const step of steps) {
      if (this.o.signal.aborted) return;
      const display = step.argv.join(' ');
      if (step.refused) {
        this.prepare.push({ name: 'install', kind: 'check', command: display, status: 'skipped', exitCode: null, durationMs: 0, output: '', truncated: false, note: step.refused });
        continue;
      }
      this.o.onStatus?.('Installing dependencies');
      const before = await this.untracked();
      // pnpm's package store lives in Limn's cache (never the reader's own store).
      const argv = step.argv[0] === 'pnpm' ? [...step.argv, '--store-dir', join(real(this.o.cacheDir), 'pnpm-store')] : step.argv;
      const wrapped = wrapCommand(this.sandbox, this.policy('open', [real(this.o.cacheDir)]), this.o.worktree, argv);
      const r = await runProcess({
        command: wrapped.command,
        args: wrapped.args,
        cwd: this.o.worktree,
        env: this.checkEnv,
        timeoutMs: this.o.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
        outputCap: this.o.outputCap ?? DEFAULT_OUTPUT_CAP,
        signal: this.o.signal,
      });
      await this.excludeNew(before);
      this.prepare.push({
        name: 'install',
        kind: 'check',
        command: display,
        status: r.spawnError || r.aborted ? 'error' : r.timedOut ? 'timed_out' : r.exitCode === 0 ? 'passed' : 'failed',
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        output: r.output,
        truncated: r.truncated,
        note: r.spawnError ? `It could not start: ${r.spawnError}` : null,
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.restoreGit();
    rmSync(this.runDir, { recursive: true, force: true });
  }
}

/** Open a run's checks: discover, choose, sandbox, Docker, install, freeze. */
export async function openCheckSession(o: OpenCheckSessionOptions): Promise<OpenCheckSessionResult> {
  const env = o.env ?? process.env;
  const plan = discoverLocalChecks(o.worktree);
  const wanted = new Set(o.wanted);
  const notes: string[] = [];
  const skippedList: CheckRunResult[] = [];
  const chosen: CheckDef[] = [];
  let hook: HookDef | null = null;
  for (const name of wanted) {
    const def = plan.checks.find((c) => c.name === name);
    if (!def) {
      skippedList.push({ name, kind: 'check', command: '', status: 'skipped', exitCode: null, durationMs: 0, output: '', truncated: false, note: 'This repository does not declare it at this commit.' });
      continue;
    }
    if (def.refused) {
      skippedList.push(skipped(def, def.refused));
      continue;
    }
    if (def.kind === 'hook') hook = plan.hook;
    else chosen.push(def);
  }
  const hookDef = hook ? plan.checks.find((c) => c.kind === 'hook') ?? null : null;
  if (chosen.length === 0 && !hook) {
    return { ok: false, note: skippedList.length > 0 ? 'None of the chosen checks can run here.' : 'No checks were chosen.', skipped: skippedList };
  }

  const sb = o.sandboxOverride ?? detectSandbox();
  if (sb.kind === 'none' && !o.allowUnsandboxed) {
    const all = [...chosen, ...(hookDef ? [hookDef] : [])].map((c) => skipped(c, 'No sandbox.'));
    return { ok: false, note: `Tests did not run: Limn runs them only inside a sandbox. ${sb.reason ?? ''}`.trim(), skipped: [...skippedList, ...all] };
  }
  if (sb.kind === 'none') notes.push('Tests ran WITHOUT a sandbox (LIMN_CHECKS_ALLOW_UNSANDBOXED is on).');

  // Docker FIRST: a check that needs it is skipped in a second when the daemon does not answer.
  const needsDocker = [...chosen, ...(hookDef && hookDef.needsDocker ? [hookDef] : [])].filter((c) => c.needsDocker);
  if (needsDocker.length > 0) {
    const docker = o.dockerOverride ?? (await dockerPreflight({ env, signal: o.signal }));
    if (!docker.running) {
      notes.push(docker.note ?? 'Docker isn’t running, so checks that need it were skipped.');
      for (const c of needsDocker) {
        skippedList.push(skipped(c, 'Needs Docker, which isn’t running.'));
        if (c.kind === 'hook') hook = null;
      }
      for (let i = chosen.length - 1; i >= 0; i--) if (chosen[i]!.needsDocker) chosen.splice(i, 1);
      if (chosen.length === 0 && !hook) return { ok: false, note: notes.join(' '), skipped: skippedList };
    }
  }

  // The run's folders: Limn-only `spec/` (the frozen list, the hook, the excludes file, the throwaway
  // hook repository) and the sandbox's own `sbx/` (HOME, TMPDIR). Under Limn's data folder, which a
  // check can neither read nor write outside `sbx/`.
  mkdirSync(o.runRoot, { recursive: true, mode: 0o700 });
  mkdirSync(o.cacheDir, { recursive: true, mode: 0o700 });
  const runDir = real(await mkdtemp(join(o.runRoot, 'run-')));
  const specDir = join(runDir, 'spec');
  const sbxTmp = join(runDir, 'sbx');
  for (const d of [specDir, sbxTmp, join(sbxTmp, 'home'), join(sbxTmp, 'tmp')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(specDir, 'exclude'), `${CHECK_OUTPUT_PATTERNS.join('\n')}\n`, { mode: 0o600 });

  const worktree = real(o.worktree);
  const gitPath = join(worktree, '.git');
  let gitFile: { content: string } | null = null;
  try {
    if (lstatSync(gitPath).isFile()) gitFile = { content: readFileSync(gitPath, 'utf8') };
  } catch {
    gitFile = null;
  }

  const home = real(homedir());
  const cache = real(o.cacheDir);
  const darwin = darwinUserFolders();
  const readable = [...new Set([worktree, real(o.repoCloneDir), cache, sbxTmp, join(specDir, 'hooks'), ...readableToolchains(home, env)])];
  const hidden = HIDDEN_IN_HOME.map((h) => join(home, h)).filter((p) => existsSync(p)).map(real);
  // Cargo takes a lock in its home even offline: those lock files (only) stay writable for a check.
  const checkWritable: string[] = [];
  if (chosen.some((c) => c.ecosystem === 'rust')) {
    mkdirSync(join(cache, 'cargo'), { recursive: true });
    for (const f of ['.package-cache', '.package-cache-mutate', '.global-cache']) {
      const p = join(cache, 'cargo', f);
      if (!existsSync(p)) writeFileSync(p, '');
      checkWritable.push(p);
    }
  }
  const policy = (network: 'localhost' | 'open', extraWritable: string[] = [], extraReadable: string[] = []): SandboxPolicy => ({
    // The dependency step may fill Limn's cache; a check only reads it (no poisoning a later run).
    writable: [worktree, sbxTmp, ...checkWritable, ...extraWritable],
    protectedPaths: [gitPath],
    darkRoots: [...new Set([home, ...o.darkRoots.map(real)])],
    // A step's extra writable folders are readable to it too (the hook's throwaway git folder).
    readable: [...new Set([...readable, ...extraWritable, ...extraReadable])],
    hiddenPaths: hidden,
    network,
    darwinUserTemp: darwin.temp,
    darwinUserCache: darwin.cache,
  });
  const buildCache = join(sbxTmp, 'build-cache');
  mkdirSync(buildCache, { recursive: true });
  const checkEnv = scrubbedEnv(env, { tmp: sbxTmp, cache, realHome: home }, {
    // Caches a CHECK writes (go build, gradle) live in the run's own folder, not the shared cache.
    GOCACHE: join(buildCache, 'go-build'),
    GRADLE_USER_HOME: join(buildCache, 'gradle'),
    XDG_CACHE_HOME: join(buildCache, 'xdg'),
  });

  const session = new CheckSession(o, sb.kind, plan, chosen, hook, [], skippedList, notes, runDir, specDir, sbxTmp, gitFile, checkEnv, policy);
  try {
    const ecosystems = new Set(chosen.map((c) => c.ecosystem));
    // A Makefile target or a hook usually runs the project's own tools: install for those too.
    const all = ecosystems.has('make') || hook != null;
    await session.runPrepare(plan.prepare.filter((s) => all || ecosystems.has(s.ecosystem)));
    if (session.prepare.some((p) => p.status !== 'passed' && p.status !== 'skipped')) {
      notes.push('Installing dependencies failed, so the checks may fail too.');
    }
  } catch (e) {
    await session.close();
    throw e;
  }
  return { ok: true, session };
}

/** For a caller's log line: the worktree-relative path, or the path. */
export function displayPath(root: string, p: string): string {
  const r = relative(root, p);
  return r && !r.startsWith('..') ? r : p;
}
