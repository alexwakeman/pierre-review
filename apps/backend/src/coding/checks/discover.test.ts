// THE ALLOW-LIST (discover.ts): checks come only from what the repository declares, each a fixed argv.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverChecks, kindOfName, parseMakefile, makeClosureText, scriptClosure, type RepoFiles } from './discover.js';
import { localRepoFiles } from './local.js';

function files(map: Record<string, string>): RepoFiles {
  return { read: (p) => map[p] ?? null };
}

describe('kindOfName', () => {
  it('names the check kinds and refuses watchers, fixers and servers', () => {
    expect(kindOfName('test')).toBe('test');
    expect(kindOfName('test:unit')).toBe('test');
    expect(kindOfName('lint')).toBe('lint');
    expect(kindOfName('typecheck')).toBe('typecheck');
    expect(kindOfName('type-check')).toBe('typecheck');
    expect(kindOfName('check-types')).toBe('typecheck');
    expect(kindOfName('check')).toBe('check');
    for (const n of ['test:watch', 'lint:fix', 'test:ui', 'dev', 'start', 'build', 'release', 'test:update', 'check:write', 'x; rm -rf /']) {
      expect(kindOfName(n)).toBeNull();
    }
  });
});

describe('discoverChecks — Node', () => {
  const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name: 'x', scripts, ...extra });

  it('runs scripts through the package manager the LOCKFILE names, as argv', () => {
    const plan = discoverChecks(files({ 'package.json': pkg({ test: 'vitest run', lint: 'eslint .', build: 'tsc' }), 'pnpm-lock.yaml': '' }));
    expect(plan.packageManager).toBe('pnpm');
    expect(plan.checks.map((c) => [c.name, c.argv])).toEqual([
      ['lint', ['pnpm', 'run', 'lint']],
      ['test', ['pnpm', 'run', 'test']],
    ]);
    expect(plan.prepare[0]!.argv).toEqual(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.confirmModulesPurge=false']);
  });

  it('picks npm, yarn and bun from their lockfiles, and corepack’s field first', () => {
    expect(discoverChecks(files({ 'package.json': pkg({ test: 'x' }), 'package-lock.json': '{}' })).checks[0]!.argv[0]).toBe('npm');
    expect(discoverChecks(files({ 'package.json': pkg({ test: 'x' }), 'yarn.lock': '' })).checks[0]!.argv[0]).toBe('yarn');
    expect(discoverChecks(files({ 'package.json': pkg({ test: 'x' }), 'bun.lockb': '' })).checks[0]!.argv[0]).toBe('bun');
    expect(discoverChecks(files({ 'package.json': pkg({ test: 'x' }, { packageManager: 'pnpm@9.1.0' }), 'yarn.lock': '' })).checks[0]!.argv[0]).toBe('pnpm');
  });

  it('every install skips lifecycle scripts', () => {
    for (const lock of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']) {
      const step = discoverChecks(files({ 'package.json': pkg({ test: 'x' }), [lock]: '' })).prepare[0]!;
      expect(step.argv.some((a) => a === '--ignore-scripts' || a === '--mode=skip-build')).toBe(true);
    }
  });

  it('refuses to install when Yarn would run a copy of itself from the repository', () => {
    const plan = discoverChecks(files({ 'package.json': pkg({ test: 'x' }), 'yarn.lock': '__metadata:\n', '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn.cjs\n' }));
    expect(plan.prepare[0]!.refused).toMatch(/copy of itself/);
  });

  it('defaults test, lint and typecheck on; variants and `check` off', () => {
    const plan = discoverChecks(files({ 'package.json': pkg({ test: 'v', 'test:e2e': 'p', lint: 'e', typecheck: 't', check: 'c' }) }));
    const on = Object.fromEntries(plan.checks.map((c) => [c.name, c.defaultOn]));
    expect(on).toEqual({ check: false, lint: true, test: true, 'test:e2e': false, typecheck: true });
  });

  it('scans the WHOLE chain a script runs, including pre/post and run-s globs', () => {
    const scripts = new Map(Object.entries({ test: 'npm run setup && vitest', setup: 'run-s db:*', 'db:up': 'docker compose up -d', pretest: 'echo hi' }));
    expect(scriptClosure(scripts, 'test').sort()).toEqual(['db:up', 'pretest', 'setup', 'test']);
    const plan = discoverChecks(files({ 'package.json': JSON.stringify({ scripts: Object.fromEntries(scripts) }) }));
    const test = plan.checks.find((c) => c.name === 'test')!;
    expect(test.refused).toMatch(/containers/);
    expect(test.defaultOn).toBe(false);
  });

  it('marks a test as needing Docker when the repository uses compose or testcontainers', () => {
    const plan = discoverChecks(files({ 'package.json': pkg({ test: 'vitest', lint: 'eslint' }), 'compose.yaml': 'services: {}' }));
    expect(plan.checks.find((c) => c.name === 'test')!.needsDocker).toBe(true);
    expect(plan.checks.find((c) => c.name === 'lint')!.needsDocker).toBe(false);
  });

  it('an unparseable package.json declares nothing', () => {
    expect(discoverChecks(files({ 'package.json': '{oops' })).checks).toEqual([]);
  });
});

describe('discoverChecks — Make, Python, Rust, Go, Gradle, Maven', () => {
  it('reads Makefile targets and scans their recipes, prerequisites and variables', () => {
    const mk = 'IMG = app\n.PHONY: test lint\ntest: deps\n\tgo test ./...\nlint:\n\tgolangci-lint run\ndeps:\n\tdocker build -t $(IMG) .\nrelease:\n\tgit push\n';
    const parsed = parseMakefile(mk);
    expect(makeClosureText(parsed, 'test')).toContain('docker build');
    const plan = discoverChecks(files({ Makefile: mk }));
    expect(plan.checks.map((c) => [c.name, c.argv, c.refused != null])).toEqual([
      ['lint', ['make', 'lint'], false],
      ['test', ['make', 'test'], true],
    ]);
  });

  it('refuses a Makefile that includes files it cannot read first', () => {
    const plan = discoverChecks(files({ Makefile: 'include other.mk\ntest:\n\tpytest\n' }));
    expect(plan.checks[0]!.refused).toMatch(/includes/);
  });

  it('pytest, cargo, go, gradle and maven are fixed argv', () => {
    expect(discoverChecks(files({ 'pyproject.toml': '[tool.pytest.ini_options]\n', 'uv.lock': '' })).checks[0]!.argv).toEqual(['uv', 'run', '--frozen', '--no-sync', 'python', '-m', 'pytest']);
    expect(discoverChecks(files({ 'pytest.ini': '' })).checks[0]!.argv).toEqual(['python3', '-m', 'pytest']);
    const rust = discoverChecks(files({ 'Cargo.toml': '[package]', 'Cargo.lock': '' }));
    expect(rust.checks[0]!.argv).toEqual(['cargo', 'test', '--locked', '--offline']);
    expect(rust.prepare[0]!.argv).toEqual(['cargo', 'fetch', '--locked']);
    const go = discoverChecks(files({ 'go.mod': 'module x' }));
    expect(go.checks.map((c) => c.argv)).toEqual([['go', 'test', './...'], ['go', 'vet', './...']]);
    expect(discoverChecks(files({ 'build.gradle': '', gradlew: '#!/bin/sh' })).checks[0]!.argv).toEqual(['./gradlew', 'test', '--offline', '--no-daemon']);
    expect(discoverChecks(files({ 'build.gradle.kts': '' })).prepare).toEqual([]); // build scripts are code
    expect(discoverChecks(files({ 'pom.xml': '<project/>' })).checks[0]!.argv).toEqual(['mvn', '-B', '-o', 'test']);
    expect(discoverChecks(files({ 'pom.xml': '<project/>', '.mvn/extensions.xml': '<x/>' })).prepare[0]!.refused).toMatch(/extensions/);
  });

  it('two ecosystems never collide on a name', () => {
    const plan = discoverChecks(files({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'go.mod': 'module x' }));
    expect(plan.checks.map((c) => c.name).sort()).toEqual(['go test', 'lint', 'test']);
  });
});

describe('discoverChecks — the commit hook', () => {
  it('husky, with lint-staged’s commands scanned too', () => {
    const plan = discoverChecks(
      files({
        '.husky/pre-commit': 'npx lint-staged\n',
        'package.json': JSON.stringify({ scripts: {}, 'lint-staged': { '*.ts': 'eslint --fix' } }),
      }),
    );
    expect(plan.hook?.kind).toBe('husky');
    expect(plan.checks.find((c) => c.kind === 'hook')).toMatchObject({ name: 'pre-commit hook', defaultOn: true, refused: null });
    const bad = discoverChecks(files({ '.husky/pre-commit': 'npx lint-staged\n', 'package.json': JSON.stringify({ 'lint-staged': { '*': 'git push' } }) }));
    expect(bad.hook).toBeNull();
    expect(bad.checks.find((c) => c.kind === 'hook')!.refused).toMatch(/git/);
  });

  it('lefthook and simple-git-hooks', () => {
    expect(discoverChecks(files({ 'lefthook.yml': 'pre-commit:\n  commands:\n    lint:\n      run: eslint\n' })).hook?.kind).toBe('lefthook');
    expect(discoverChecks(files({ 'package.json': JSON.stringify({ 'simple-git-hooks': { 'pre-commit': 'npx lint-staged' } }) })).hook?.kind).toBe('simple-git-hooks');
  });

  it('the pre-commit framework is listed but refused (it installs over the network)', () => {
    const plan = discoverChecks(files({ '.pre-commit-config.yaml': 'repos: []' }));
    expect(plan.hook).toBeNull();
    expect(plan.checks[0]!.refused).toMatch(/network/);
  });
});

describe('localRepoFiles', () => {
  it('reads only the manifest list, only regular files, never through a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'limn-disc-'));
    const outside = mkdtempSync(join(tmpdir(), 'limn-disc-out-'));
    writeFileSync(join(outside, 'secret'), 'test:\n\tcat secret\n');
    symlinkSync(join(outside, 'secret'), join(dir, 'Makefile'));
    mkdirSync(join(outside, 'husky'));
    writeFileSync(join(outside, 'husky', 'pre-commit'), 'echo hi');
    symlinkSync(join(outside, 'husky'), join(dir, '.husky'));
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"x"}}');
    writeFileSync(join(dir, 'README.md'), 'x');
    const f = localRepoFiles(dir);
    expect(f.read('Makefile')).toBeNull();
    expect(f.read('.husky/pre-commit')).toBeNull();
    expect(f.read('README.md')).toBeNull();
    expect(f.read('package.json')).toContain('test');
  });
});
