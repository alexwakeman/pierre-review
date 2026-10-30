// THE TEST TIME BUDGET — a vitest reporter (docs/TESTING.md § The time budget).
//
// `pnpm test` stays quick only while every file in it is quick. This reporter measures each test
// and each file of the projects it watches (the backend's `fast` project; every frontend test) and
// names the ones over budget, with the command that moves a file into the `slow` project.
//
//   • A TEST is over when its own time (beforeEach/afterEach included) passes `testMs`.
//   • A FILE is over when its RUN time passes `fileMs`: beforeAll + every test + afterAll. The time
//     to import the file's modules ("collect") is left out on purpose — it is shared, cached work
//     whose cost depends on what else the worker loaded first, so it would flag files at random.
//
// Modes (LIMN_TEST_BUDGET): `warn` (the default) prints and passes; `enforce` FAILS the run;
// `off` measures nothing. CI enforces on pull requests, and only on the test files the PR adds or
// changes (LIMN_TEST_BUDGET_BASE=origin/<base>): a new or edited test pays the budget, and a timing
// wobble in a file nobody touched never fails somebody else's PR (it is still printed).
//
// A justified exception goes in `allowlist.json` beside this file: a RAISED budget for one file,
// with the reason — never an unlimited one, so an exempt file still cannot quietly get slower.
//
// ⚠ Timings depend on the machine's load, so the budgets SCALE with it: the run samples the 1-minute
// load average per core and multiplies every budget by that (never below ×1, never above ×8). A
// dedicated CI runner sits near ×1; a laptop shared with other builds was measured at ×4.7, where
// every DB suite ran 3–5× its idle time. LIMN_TEST_BUDGET_LOAD_SCALING=off turns it off.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { relative, resolve } from 'node:path';
import type { File, Reporter, Task, Vitest } from 'vitest';

export interface TestBudgetOptions {
  /** The directory paths are reported relative to (and the allowlist keys are relative to). */
  root: string;
  /** Only files in these vitest projects are measured; omit to measure every file. */
  projects?: string[];
  /** Budget per test, in ms (LIMN_TEST_BUDGET_TEST_MS overrides). */
  testMs?: number;
  /** Budget per file's run time, in ms (LIMN_TEST_BUDGET_FILE_MS overrides). */
  fileMs?: number;
  /** The allowlist JSON (see allowlist.json); a missing file is an empty list. */
  allowlistPath?: string;
  /** What to do about a file over budget: one line per step, `{file}` is replaced by its path. */
  advice?: string[];
  /** A short name for the suite in the report ("backend fast project"). */
  label?: string;
}

interface AllowEntry {
  testMs?: number;
  fileMs?: number;
  reason: string;
}

interface Violation {
  file: string;
  fileMs: number;
  fileBudgetMs: number;
  overFile: boolean;
  tests: Array<{ name: string; ms: number }>;
  testBudgetMs: number;
  allowlisted: boolean;
  enforced: boolean;
}

export const DEFAULT_TEST_MS = 2_000;
export const DEFAULT_FILE_MS = 5_000;

type Mode = 'warn' | 'enforce' | 'off';

function modeFromEnv(): Mode {
  const raw = (process.env.LIMN_TEST_BUDGET ?? 'warn').trim().toLowerCase();
  return raw === 'enforce' || raw === 'off' ? raw : 'warn';
}

function msFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readAllowlist(path: string | undefined): Record<string, AllowEntry> {
  if (!path || !existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { files?: Record<string, AllowEntry> };
  return parsed.files ?? {};
}

/** The repo-relative files changed since `base` (merge-base semantics), plus uncommitted ones. */
function changedFiles(base: string, cwd: string): Set<string> | null {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
    const run = (args: string[]): string[] =>
      execFileSync('git', args, { cwd: top, encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => resolve(top, p));
    return new Set([
      ...run(['diff', '--name-only', `${base}...HEAD`]),
      ...run(['diff', '--name-only', 'HEAD']),
      ...run(['ls-files', '--others', '--exclude-standard']),
    ]);
  } catch {
    return null;
  }
}

function testsOf(task: Task, prefix: string[], out: Array<{ name: string; ms: number }>): void {
  if (task.type === 'suite') {
    const next = task.name ? [...prefix, task.name] : prefix;
    for (const child of task.tasks) testsOf(child, next, out);
    return;
  }
  const ms = task.result?.duration;
  if (task.mode === 'skip' || task.mode === 'todo' || ms == null) return;
  out.push({ name: [...prefix, task.name].join(' > '), ms });
}

const seconds = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export default class TestBudgetReporter implements Reporter {
  private ctx: Vitest | undefined;
  private readonly opts: TestBudgetOptions;
  private readonly loadSamples: number[] = [];
  private lastSampleAt = 0;

  constructor(opts: TestBudgetOptions) {
    this.opts = opts;
  }

  onInit(ctx: Vitest): void {
    this.ctx = ctx;
    this.sampleLoad(true);
  }

  // At most once a second, as results stream in: the run's load, not just its last minute.
  onTaskUpdate(): void {
    this.sampleLoad(false);
  }

  private sampleLoad(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastSampleAt < 1000) return;
    this.lastSampleAt = now;
    this.loadSamples.push((loadavg()[0] ?? 0) / Math.max(1, cpus().length));
  }

  /** The budget multiplier for this run's load: mean load per core, clamped to [1, 8]. */
  private loadFactor(): number {
    if ((process.env.LIMN_TEST_BUDGET_LOAD_SCALING ?? '').trim().toLowerCase() === 'off') return 1;
    this.sampleLoad(true);
    const mean = this.loadSamples.reduce((a, b) => a + b, 0) / this.loadSamples.length;
    return Math.min(8, Math.max(1, mean));
  }

  onFinished(files: File[] = []): void {
    const mode = modeFromEnv();
    if (mode === 'off') return;
    const factor = this.loadFactor();
    const testMs = msFromEnv('LIMN_TEST_BUDGET_TEST_MS', this.opts.testMs ?? DEFAULT_TEST_MS) * factor;
    const fileMs = msFromEnv('LIMN_TEST_BUDGET_FILE_MS', this.opts.fileMs ?? DEFAULT_FILE_MS) * factor;
    const allow = readAllowlist(this.opts.allowlistPath);
    const base = process.env.LIMN_TEST_BUDGET_BASE?.trim();
    const changed = mode === 'enforce' && base ? changedFiles(base, this.opts.root) : null;
    const log = (line = ''): void => {
      if (this.ctx) this.ctx.logger.log(line);
      else console.log(line);
    };

    const violations: Violation[] = [];
    const measured = new Set<string>();
    for (const file of files) {
      if (this.opts.projects && !this.opts.projects.includes(file.projectName ?? '')) continue;
      const rel = relative(this.opts.root, file.filepath);
      measured.add(rel);
      const entry = allow[rel];
      const fileBudgetMs = entry?.fileMs != null ? entry.fileMs * factor : fileMs;
      const testBudgetMs = entry?.testMs != null ? entry.testMs * factor : testMs;
      const tests: Array<{ name: string; ms: number }> = [];
      for (const t of file.tasks) testsOf(t, [], tests);
      const fileRun = file.result?.duration ?? 0;
      const slowTests = tests.filter((t) => t.ms > testBudgetMs).sort((a, b) => b.ms - a.ms);
      const overFile = fileRun > fileBudgetMs;
      if (!overFile && slowTests.length === 0) continue;
      violations.push({
        file: rel,
        fileMs: fileRun,
        fileBudgetMs,
        overFile,
        tests: slowTests,
        testBudgetMs,
        allowlisted: entry != null,
        // Enforced: every violation, unless a base narrows it to the files this change touched.
        enforced: mode === 'enforce' && (changed == null || changed.has(file.filepath)),
      });
    }

    const report = process.env.LIMN_TEST_BUDGET_REPORT;
    if (report) writeFileSync(report, JSON.stringify({ factor, testMs, fileMs, violations }, null, 2));

    // An allowlist entry whose file now fits the DEFAULT budget can go (said, never enforced).
    const stale = Object.keys(allow).filter(
      (f) => measured.has(f) && !violations.some((v) => v.file === f && v.allowlisted),
    );
    const staleFits = stale.filter((f) => {
      const file = files.find((x) => relative(this.opts.root, x.filepath) === f);
      if (!file) return false;
      const tests: Array<{ name: string; ms: number }> = [];
      for (const t of file.tasks) testsOf(t, [], tests);
      return (file.result?.duration ?? 0) <= fileMs && tests.every((t) => t.ms <= testMs);
    });

    if (violations.length === 0 && staleFits.length === 0) return;
    const label = this.opts.label ?? 'tests';
    const [l1] = loadavg();
    const load = `load average ${l1?.toFixed(1) ?? '?'} on ${cpus().length} cores${factor > 1 ? `, budgets ×${factor.toFixed(1)} for it` : ''}`;
    log();
    if (violations.length > 0) {
      log(`⚠ Test time budget (${label}): ${violations.length} file(s) over — a test over ${seconds(testMs)}, a file over ${seconds(fileMs)} (${load})`);
      for (const v of violations.sort((a, b) => b.fileMs - a.fileMs)) {
        const tag = v.enforced ? ' [FAILS THIS RUN]' : v.allowlisted ? ' [over its allowlisted budget]' : '';
        log(`  ${v.file} — ran ${seconds(v.fileMs)}${v.overFile ? ` (budget ${seconds(v.fileBudgetMs)})` : ''}${tag}`);
        for (const t of v.tests.slice(0, 5)) log(`      ${seconds(t.ms).padStart(6)}  ${t.name}`);
        if (v.tests.length > 5) log(`      … and ${v.tests.length - 5} more over ${seconds(v.testBudgetMs)}`);
        for (const line of this.opts.advice ?? []) log(`    ${line.replaceAll('{file}', v.file)}`);
      }
      if (this.opts.allowlistPath) {
        log(`  A justified exception: a raised budget, with the reason, in ${relative(process.cwd(), this.opts.allowlistPath)}.`);
      }
      if (mode !== 'enforce') log('  Timings move with the machine’s load: re-run the one file before moving it.');
    }
    if (staleFits.length > 0) {
      log(`Test time budget: these allowlist entries now fit the default budget and can be removed: ${staleFits.join(', ')}`);
    }
    if (violations.some((v) => v.enforced)) {
      log('✗ Test time budget exceeded (LIMN_TEST_BUDGET=enforce). Move the file(s) above, make them faster, or allowlist them with a reason.');
      process.exitCode = 1;
    }
  }
}
