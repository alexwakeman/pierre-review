// THE AI FIX REPORT (fix-report.ts). Pinned:
//   1. ONE validator: the shape (the `submit_fix` contract), then the content (refs shown, paths changed,
//      every shown item cited, every changed file listed) — shape problems drop the report, content
//      problems only name what the normaliser drops;
//   2. the checker script the agent runs, with `node`, on a real git repository: OK, or one line per
//      problem, exit 0 / 1 — the SAME validator text;
//   3. the host's read over the fake runtime: missing, not JSON, too big, ok.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFakeRuntime } from '../runtime/fake.js';
import { FIX_REPORT_CHECKER, FIX_REPORT_MAX_BYTES, fixReportCheckerSource, readFixReport, validateFixReport } from './fix-report.js';
import { SANDBOX_HOME } from './seed.js';

const good = {
  summary: 'Fixed it.',
  commitMessage: 'fix: it',
  changes: [{ path: 'src/a.ts', summary: 'Changed a.', refs: ['F1'] }],
  unaddressed: [{ ref: 'T1', reason: 'Wrong.' }],
};

describe('validateFixReport', () => {
  it('a good report has no problem', () => {
    expect(validateFixReport(good, ['F1', 'T1'], ['src/a.ts'])).toEqual({ report: good, shapeProblems: [], contentProblems: [] });
    // A plain fix: no refs at all; `./` and the lists' absence are fine.
    expect(validateFixReport({ summary: 's', commitMessage: 'c', changes: [{ path: './x.md', summary: 'x' }] }, [], ['x.md']).contentProblems).toEqual([]);
  });

  it('a wrong SHAPE drops the report', () => {
    for (const raw of [null, [], 'x', { commitMessage: 'c' }, { summary: 's', commitMessage: '' }, { ...good, changes: {} }, { ...good, changes: [{ path: 'a' }] }, { ...good, unaddressed: [{ ref: 'F1' }] }, { ...good, changes: [{ path: 'a', summary: 's', refs: [1] }] }]) {
      const r = validateFixReport(raw, ['F1'], ['src/a.ts']);
      expect(r.report).toBeNull();
      expect(r.shapeProblems.length).toBeGreaterThan(0);
    }
  });

  it('content problems are named and the report kept: an unknown ref, a file not changed, an item not cited, a changed file not listed', () => {
    const r = validateFixReport(
      { summary: 's', commitMessage: 'c', changes: [{ path: 'src/ghost.ts', summary: 'x', refs: ['F9'] }], unaddressed: [{ ref: 'Z1', reason: 'r' }] },
      ['F1'],
      ['src/a.ts'],
    );
    expect(r.report).not.toBeNull();
    expect(r.contentProblems).toEqual([
      '"changes"[0].path "src/ghost.ts" is not a file you changed (paths are relative to the repository root).',
      '"changes"[0] cites "F9", which is not an item in FIX.md.',
      '"unaddressed"[0].ref "Z1" is not an item in FIX.md.',
      'F1 is in neither "changes" nor "unaddressed".',
      'You changed src/a.ts but "changes" has no entry for it.',
    ]);
  });

  it('the checker lives in the agent’s home', () => {
    expect(FIX_REPORT_CHECKER.startsWith(`${SANDBOX_HOME}/`)).toBe(true);
  });
});

describe('the checker script (node, a real git repository)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limn-fix-report-'));
  const repo = join(dir, 'repo');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'src/a.ts'), 'x\n');
  writeFileSync(join(repo, 'keep.ts'), 'k\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  git('update-ref', 'refs/limn/base', 'HEAD');
  // One committed change, one untracked file.
  writeFileSync(join(repo, 'src/a.ts'), 'y\n');
  git('commit', '--quiet', '-am', 'fix');
  writeFileSync(join(repo, 'src/new.ts'), 'n\n');

  const report = join(dir, 'fix-report.json');
  const refs = join(dir, 'fix-refs.json');
  const script = join(dir, 'check.cjs');
  writeFileSync(refs, JSON.stringify({ repo, shown: ['F1', 'T1'] }));
  writeFileSync(script, fixReportCheckerSource({ reportFile: report, refsFile: refs, repoPath: repo }));
  const run = () => spawnSync(process.execPath, [script], { encoding: 'utf8' });

  it('no report: one line, exit 1', () => {
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe(`No report: write ${report} first.`);
  });

  it('not JSON, then problems, then OK', () => {
    writeFileSync(report, '{ nope');
    expect(run().stdout).toMatch(/^The report is not valid JSON/);
    writeFileSync(report, JSON.stringify({ ...good, changes: [{ path: 'src/a.ts', summary: 'a', refs: ['F1'] }] }));
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stdout.trim().split('\n')).toEqual(['Fix these problems, then run this check again:', '- You changed src/new.ts but "changes" has no entry for it.']);
    writeFileSync(report, JSON.stringify({ ...good, changes: [{ path: 'src/a.ts', summary: 'a', refs: ['F1'] }, { path: 'src/new.ts', summary: 'n', refs: [] }] }));
    const ok = run();
    expect([ok.status, ok.stdout.trim()]).toEqual([0, 'OK']);
  });
});

describe('readFixReport (the host, over the fake runtime)', () => {
  const rt = createFakeRuntime();
  let answer: { code: number; stdout?: string } = { code: 4 };
  rt.onExec((argv) => argv[0] === 'sh' && /head -c/.test(argv[2] ?? ''), async (c) => {
    if (answer.stdout) c.stdout(answer.stdout);
    return answer.code;
  });

  it('missing, not JSON, too big, ok', async () => {
    expect(await readFixReport(rt, 'box', '/workspace', ['F1'], ['a.ts'])).toEqual({ kind: 'missing' });
    answer = { code: 0, stdout: 'nope' };
    expect(await readFixReport(rt, 'box', '/workspace', ['F1'], ['a.ts'])).toEqual({ kind: 'unreadable', reason: 'The report is not valid JSON.' });
    answer = { code: 0, stdout: 'x'.repeat(FIX_REPORT_MAX_BYTES + 1) };
    expect((await readFixReport(rt, 'box', '/workspace', ['F1'], ['a.ts'])).kind).toBe('unreadable');
    answer = { code: 0, stdout: JSON.stringify({ summary: 's', commitMessage: 'c', changes: [{ path: 'a.ts', summary: 'x', refs: ['F1'] }] }) };
    const r = await readFixReport(rt, 'box', '/workspace', ['F1'], ['a.ts']);
    expect(r).toMatchObject({ kind: 'ok', check: { shapeProblems: [], contentProblems: [] } });
    // It read the report at the layout root, as the agent.
    const call = rt.calls.filter((c) => c.method === 'exec').at(-1)!;
    expect((call.args[1] as string[])[4]).toBe('/workspace/.limn/fix-report.json');
  });
});
