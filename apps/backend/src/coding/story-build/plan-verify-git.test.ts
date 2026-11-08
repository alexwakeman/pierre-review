// The plan evidence blob reader (plan-blobs.ts) on a real scratch git repository at a pinned sha (no network).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBlobAt } from './plan-blobs.js';

describe('readBlobAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limn-plan-blob-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();

  it('reads a file at the pinned commit, not the working tree; refuses what is not a blob', async () => {
    git('init', '-q');
    writeFileSync(join(dir, 'a.ts'), 'export const MAX_ROWS = 1000;\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.ts'), 'export const MAX_ROWS = 5000;\n');
    git('commit', '-qam', 'later');
    expect((await readBlobAt(dir, base, 'a.ts'))?.toString('utf8')).toBe('export const MAX_ROWS = 1000;\n');
    expect(await readBlobAt(dir, base, 'missing.ts')).toBeNull();
    expect(await readBlobAt(dir, base, '')).toBeNull();
    expect(await readBlobAt(dir, 'HEAD', 'a.ts')).toBeNull();
    expect(await readBlobAt(dir, base, '--output=/tmp/x')).toBeNull();
  });
});
