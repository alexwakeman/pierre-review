import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tarFiles } from './tar.js';

describe('tarFiles', () => {
  it('is a tar the system tar extracts: paths, bytes and modes', () => {
    const long = `/home/agent/${'deep/'.repeat(25)}file.md`;
    const tar = tarFiles(
      [
        { path: '/home/agent/.claude/CLAUDE.md', content: '# hi\n' },
        { path: '/work/run.sh', content: Buffer.from('#!/bin/sh\necho ü\n'), mode: 0o755 },
        { path: long, content: 'x' },
      ],
      1_700_000_000,
    );
    expect(tar.length % 512).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), 'limn-tar-'));
    const file = join(dir, 'a.tar');
    writeFileSync(file, tar);
    const r = spawnSync('tar', ['-x', '-m', '-f', file, '-C', dir], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'home/agent/.claude/CLAUDE.md'), 'utf8')).toBe('# hi\n');
    expect(readFileSync(join(dir, 'work/run.sh'), 'utf8')).toBe('#!/bin/sh\necho ü\n');
    expect(statSync(join(dir, 'work/run.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dir, long.slice(1)), 'utf8')).toBe('x');
  });

  it('refuses relative, parent and folder paths', () => {
    for (const path of ['rel/x', '/a/../etc/passwd', '/dir/']) expect(() => tarFiles([{ path, content: '' }]), path).toThrow();
  });
});
