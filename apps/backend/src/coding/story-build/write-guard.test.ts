// THE BUILD'S WRITE DENY-LIST (review/write-deny.ts), on BOTH providers: the Claude PreToolUse judge and
// Codex's guard rule (ai/codex/hook-rule.ts with `protect`). A story build is a write agent driven by
// untrusted text, so it may not touch CI / git / hook / package-manager config, lockfiles or the agent
// settings a person's own tools read — named directly, through a relative path, or through a symlink.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decideCodexToolCall, decodeGuardRoots, encodeGuardRoots } from '../../ai/codex/hook-rule.js';
import { judgeProtectedWrite, protectedWriteReason } from '../../review/write-deny.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'limn-write-guard-')));
const wt = join(root, 'wt');
mkdirSync(join(wt, 'src'), { recursive: true });
mkdirSync(join(wt, 'ci'), { recursive: true });
writeFileSync(join(wt, 'src', 'app.ts'), 'export {}\n');
// A link that HIDES a protected folder behind a harmless name, and one that makes a harmless folder
// look protected.
mkdirSync(join(wt, '.github', 'workflows'), { recursive: true });
symlinkSync(join(wt, '.github'), join(wt, 'docs-ci'));
symlinkSync(join(wt, 'ci'), join(wt, '.circleci'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const denied = (d: ReturnType<typeof judgeProtectedWrite>): boolean => 'hookSpecificOutput' in d;

describe('protectedWriteReason', () => {
  it.each([
    '.github/workflows/ci.yml',
    'packages/web/.github/dependabot.yml',
    '.git/config',
    '.gitignore',
    '.gitattributes',
    '.gitmodules',
    '.husky/pre-commit',
    '.npmrc',
    'packages/a/.npmrc',
    '.yarnrc.yml',
    '.yarn/plugins/x.cjs',
    '.pnpmfile.cjs',
    'package-lock.json',
    'apps/web/pnpm-lock.yaml',
    'yarn.lock',
    'Cargo.lock',
    'go.sum',
    '.gitlab-ci.yml',
    '.circleci/config.yml',
    'Jenkinsfile',
    '.pre-commit-config.yaml',
    '.claude/settings.json',
    'CLAUDE.md',
    'AGENTS.md',
    '.envrc',
  ])('denies %s', (p) => {
    expect(protectedWriteReason(p)).toMatch(/may not change/);
  });

  it.each(['src/app.ts', 'package.json', 'docs/github.md', 'src/gitops.ts', 'README.md', 'tsconfig.json', 'src/.prettierrc'])(
    'allows %s',
    (p) => {
      expect(protectedWriteReason(p)).toBeNull();
    },
  );
});

describe('the Claude hook (judgeProtectedWrite)', () => {
  it('denies a protected write by relative and absolute path, for every write tool', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(denied(judgeProtectedWrite([wt], wt, tool, { file_path: '.github/workflows/x.yml' }))).toBe(true);
      expect(denied(judgeProtectedWrite([wt], wt, tool, { file_path: join(wt, 'pnpm-lock.yaml') }))).toBe(true);
    }
    expect(denied(judgeProtectedWrite([wt], wt, 'NotebookEdit', { notebook_path: '.husky/n.ipynb' }))).toBe(true);
  });

  it('allows an ordinary write and never judges a read', () => {
    expect(judgeProtectedWrite([wt], wt, 'Edit', { file_path: 'src/app.ts' })).toEqual({ continue: true });
    expect(judgeProtectedWrite([wt], wt, 'Read', { file_path: '.github/workflows/x.yml' })).toEqual({ continue: true });
  });

  it('follows symlinks both ways', () => {
    // docs-ci → .github: the REAL path is protected.
    expect(denied(judgeProtectedWrite([wt], wt, 'Write', { file_path: 'docs-ci/workflows/evil.yml' }))).toBe(true);
    // .circleci → ci: the NAMED path is protected.
    expect(denied(judgeProtectedWrite([wt], wt, 'Write', { file_path: '.circleci/config.yml' }))).toBe(true);
  });

  it('leaves a path outside the write roots to the path guard', () => {
    expect(judgeProtectedWrite([wt], wt, 'Write', { file_path: join(root, 'elsewhere', '.npmrc') })).toEqual({ continue: true });
  });

  it('tells the agent what to do instead', () => {
    const d = judgeProtectedWrite([wt], wt, 'Edit', { file_path: '.github/workflows/x.yml' });
    expect(JSON.stringify(d)).toContain('Leave it as it is');
  });
});

describe('the Codex guard (decideCodexToolCall with protect)', () => {
  const roots = { read: [wt], write: [wt], protect: true };

  it('denies a protected apply_patch and a protected Write', () => {
    const patch = '*** Begin Patch\n*** Add File: .github/workflows/evil.yml\n+on: push\n*** End Patch';
    expect(decideCodexToolCall('apply_patch', { input: patch }, roots, wt)).toMatchObject({ allow: false });
    expect(decideCodexToolCall('Write', { file_path: 'yarn.lock' }, roots, wt)).toMatchObject({ allow: false });
    // One protected path among several refuses the whole patch.
    const mixed = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-x\n+y\n*** Update File: .npmrc\n@@\n-a\n+b\n*** End Patch';
    expect(decideCodexToolCall('apply_patch', { input: mixed }, roots, wt)).toMatchObject({ allow: false });
  });

  it('denies through a symlink', () => {
    const patch = '*** Begin Patch\n*** Add File: docs-ci/workflows/evil.yml\n+x\n*** End Patch';
    expect(decideCodexToolCall('apply_patch', { input: patch }, roots, wt)).toMatchObject({ allow: false });
  });

  it('allows an ordinary edit', () => {
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-x\n+y\n*** End Patch';
    expect(decideCodexToolCall('apply_patch', { input: patch }, roots, wt)).toEqual({ allow: true });
  });

  it('changes nothing for a run without protect (AI Fix)', () => {
    expect(decideCodexToolCall('Write', { file_path: 'yarn.lock' }, { read: [wt], write: [wt] }, wt)).toEqual({ allow: true });
  });

  it('carries protect through the hook environment', () => {
    expect(decodeGuardRoots(encodeGuardRoots(roots))).toEqual(roots);
    expect(decodeGuardRoots(encodeGuardRoots({ read: [wt], write: [wt] }))).toEqual({ read: [wt], write: [wt] });
  });
});
