// ONE RUN'S CHECKS, end to end on a real git worktree: the no-sandbox refusal, the Docker skip, the
// commit hook in a throwaway repository, the `.git` restore — and, on macOS, the Seatbelt boundary
// itself (a hostile test cannot write home, read ~/.ssh, rewrite .git or see a token).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCheckSession, type OpenCheckSessionOptions } from './session.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function fixture(filesIn: Record<string, string>): { root: string; clone: string; worktree: string; sha: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'limn-checks-')));
  const clone = join(root, 'clone');
  mkdirSync(clone);
  git(clone, 'init', '-q');
  for (const [p, text] of Object.entries(filesIn)) {
    mkdirSync(join(clone, p, '..'), { recursive: true });
    writeFileSync(join(clone, p), text);
  }
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'init');
  const sha = git(clone, 'rev-parse', 'HEAD');
  const worktree = join(root, 'wt');
  git(clone, 'worktree', 'add', '-q', '--detach', worktree, sha);
  return { root, clone, worktree, sha };
}

function opts(f: ReturnType<typeof fixture>, over: Partial<OpenCheckSessionOptions>): OpenCheckSessionOptions {
  return {
    worktree: f.worktree,
    repoCloneDir: f.clone,
    wanted: ['test'],
    runRoot: join(f.root, 'runs'),
    cacheDir: join(f.root, 'cache'),
    darkRoots: [],
    allowUnsandboxed: false,
    signal: new AbortController().signal,
    ...over,
  };
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 't', version: '1.0.0', scripts });
const lock = '{"lockfileVersion":3,"name":"t","requires":true,"packages":{"":{"name":"t","version":"1.0.0"}}}';

describe('openCheckSession', () => {
  it('REFUSES with a plain sentence when there is no sandbox (unless allowed)', async () => {
    const f = fixture({ 'package.json': pkg({ test: 'node -e 0' }) });
    const r = await openCheckSession(opts(f, { sandboxOverride: { kind: 'none', reason: 'Install bubblewrap (bwrap) to run tests in a sandbox.' } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.note).toMatch(/only inside a sandbox/);
    expect(r.skipped.map((s) => [s.name, s.status])).toEqual([['test', 'skipped']]);
  });

  it('skips a name the repository does not declare, and a refused script', async () => {
    const f = fixture({ 'package.json': pkg({ test: 'docker compose up -d && node -e 0' }) });
    const r = await openCheckSession(opts(f, { wanted: ['test', 'deploy'], sandboxOverride: { kind: 'none', reason: null }, allowUnsandboxed: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skipped.map((s) => s.note)).toEqual(['It starts or builds containers.', 'This repository does not declare it at this commit.']);
  });

  it('asks Docker FIRST and skips what needs it, keeping the rest', async () => {
    const f = fixture({ 'package.json': pkg({ test: 'node -e 0', lint: 'node -e 0' }), 'package-lock.json': lock, 'compose.yaml': 'services: {}' });
    const r = await openCheckSession(
      opts(f, { wanted: ['test', 'lint'], sandboxOverride: { kind: 'none', reason: null }, allowUnsandboxed: true, dockerOverride: { running: false, note: 'Docker isn’t running, so checks that need it were skipped.' } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.skipped.map((s) => s.name)).toEqual(['test']);
    expect(r.session.agentChecks.map((c) => c.name)).toEqual(['lint']);
    expect(r.session.notes.join(' ')).toMatch(/Docker isn’t running/);
    await r.session.close();
  });

  it('runs the commit hook in a THROWAWAY repository: the clone and HEAD never move', async () => {
    const f = fixture({
      'package.json': pkg({}),
      '.husky/pre-commit': '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\ngit diff --cached --name-only\necho fixed >> touched.txt\n',
      'touched.txt': 'a\n',
    });
    writeFileSync(join(f.worktree, 'new.txt'), 'x\n');
    const refsBefore = git(f.clone, 'for-each-ref');
    const r = await openCheckSession(opts(f, { wanted: ['pre-commit hook'], sandboxOverride: { kind: 'none', reason: null }, allowUnsandboxed: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hook = await r.session.runHook('fix: x', f.sha);
    expect(hook?.status).toBe('passed');
    expect(hook?.output).toContain('new.txt');
    expect(readFileSync(join(f.worktree, 'touched.txt'), 'utf8')).toBe('a\nfixed\n'); // the hook's fix-up stays
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.sha);
    expect(git(f.clone, 'for-each-ref')).toBe(refsBefore);
    await r.session.close();
  });

  it('a failing hook reports its output; nothing staged is "skipped"', async () => {
    const f = fixture({ 'package.json': pkg({}), '.husky/pre-commit': 'echo "lint failed: x.ts" >&2\nexit 1\n' });
    const r = await openCheckSession(opts(f, { wanted: ['pre-commit hook'], sandboxOverride: { kind: 'none', reason: null }, allowUnsandboxed: true }));
    if (!r.ok) throw new Error(r.note);
    expect((await r.session.runHook('x', f.sha))?.status).toBe('skipped');
    writeFileSync(join(f.worktree, 'x.ts'), 'x');
    const hook = await r.session.runHook('x', f.sha);
    expect(hook?.status).toBe('failed');
    expect(hook?.output).toContain('lint failed: x.ts');
    await r.session.close();
  });

  it('restoreGit puts back a .git file a check replaced', async () => {
    const f = fixture({ 'package.json': pkg({ test: 'node -e 0' }), 'package-lock.json': lock });
    const original = readFileSync(join(f.worktree, '.git'), 'utf8');
    const r = await openCheckSession(opts(f, { sandboxOverride: { kind: 'none', reason: null }, allowUnsandboxed: true }));
    if (!r.ok) throw new Error(r.note);
    writeFileSync(join(f.worktree, '.git'), 'gitdir: /tmp/evil\n');
    r.session.restoreGit();
    expect(readFileSync(join(f.worktree, '.git'), 'utf8')).toBe(original);
    await r.session.close();
  });
});

describe.skipIf(process.platform !== 'darwin')('the Seatbelt boundary (macOS)', () => {
  it('a hostile test cannot write home, read ~/.ssh, rewrite .git, see a token or reach the internet', async () => {
    const probe = `
      const fs = require('fs'); const bad = [];
      const home = ${JSON.stringify(homedir())};
      try { fs.writeFileSync(home + '/limn-escape-probe', 'x'); bad.push('wrote home'); } catch {}
      try { fs.readdirSync(home + '/Documents'); bad.push('listed home'); } catch {}
      try { fs.writeFileSync('.git', 'gitdir: /tmp/evil'); bad.push('wrote .git'); } catch {}
      if (Object.keys(process.env).some((k) => /TOKEN|ANTHROPIC|OPENAI/.test(k))) bad.push('saw a token');
      require('net').connect(443, '1.1.1.1').on('connect', () => { bad.push('internet'); done(); }).on('error', done);
      function done() { console.log('BAD=' + bad.join(',')); process.exit(bad.length ? 1 : 0); }
    `;
    const f = fixture({ 'package.json': pkg({ test: 'node probe.js' }), 'package-lock.json': lock, 'probe.js': probe });
    const r = await openCheckSession(opts(f, { env: { ...process.env, GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk' } }));
    if (!r.ok) throw new Error(r.note);
    expect(r.session.sandbox).toBe('seatbelt');
    const tool = r.session.agentTool();
    const reply = await tool.run({ name: 'test' });
    expect(reply.text).toMatch(/BAD=$/m);
    expect(reply.text).toMatch(/^test passed/);
    expect(existsSync(join(homedir(), 'limn-escape-probe'))).toBe(false);
    const verified = await r.session.verify();
    expect(verified.map((v) => v.status)).toEqual(['passed']);
    expect(r.session.agentRuns()).toEqual([{ name: 'test', status: 'passed', durationMs: expect.any(Number) }]);
    await r.session.close();
  }, 120_000);
});
