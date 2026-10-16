import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_WRITE_CHARS, docsToolPolicy, judgeWrite, lastPageRead } from './agent.js';

describe('the reference-docs agents’ tools', () => {
  it('no run has a shell, and only the PDF build can write', () => {
    for (const run of ['sections', 'pdf', 'chat'] as const) {
      const p = docsToolPolicy(run);
      expect(p.allowedTools).not.toContain('Bash');
      expect(p.builtinTools).not.toContain('Bash');
      expect(p.disallowedTools).toContain('Bash');
      expect(p.disallowedTools).toContain('WebFetch');
    }
    expect(docsToolPolicy('pdf').allowedTools).toEqual(expect.arrayContaining(['Write', 'Edit']));
    for (const run of ['sections', 'chat'] as const) {
      expect(docsToolPolicy(run).allowedTools).not.toContain('Write');
      expect(docsToolPolicy(run).disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'MultiEdit']));
    }
    expect(docsToolPolicy('chat').allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });
});

describe('the PDF build’s write guard', () => {
  let root: string;
  let sections: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'limn-docs-guard-'));
    sections = join(root, 'sections');
    mkdirSync(sections);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const denied = (d: unknown): boolean => JSON.stringify(d).includes('"deny"');

  it('allows a markdown file directly inside sections/', () => {
    expect(judgeWrite(sections, root, 'Write', { file_path: 'sections/001-intro.md', content: 'x' })).toEqual({ continue: true });
    expect(judgeWrite(sections, root, 'Edit', { file_path: join(sections, '002-b.md') })).toEqual({ continue: true });
  });

  it.each([
    ['source.pdf'],
    ['sections/../escape.md'],
    ['sections/sub/001.md'],
    ['sections/001.txt'],
    ['/etc/passwd'],
    ['~/.ssh/authorized_keys'],
    ['sections/.hidden.md'],
  ])('refuses %s', (file_path) => {
    expect(denied(judgeWrite(sections, root, 'Write', { file_path, content: 'x' }))).toBe(true);
  });

  it('refuses a symlinked way out and an over-long file', () => {
    const outside = mkdtempSync(join(tmpdir(), 'limn-docs-outside-'));
    try {
      symlinkSync(outside, join(sections, 'link'));
      expect(denied(judgeWrite(sections, root, 'Write', { file_path: 'sections/link/x.md', content: 'x' }))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(denied(judgeWrite(sections, root, 'Write', { file_path: 'sections/001.md', content: 'x'.repeat(MAX_WRITE_CHARS + 1) }))).toBe(true);
  });

  it('leaves the read tools to the path guard', () => {
    expect(judgeWrite(sections, root, 'Read', { file_path: '/etc/passwd' })).toEqual({ continue: true });
  });

  it('reads the last PDF page a Read reached', () => {
    expect(lastPageRead('21-40')).toBe(40);
    expect(lastPageRead('7')).toBe(7);
    expect(lastPageRead(undefined)).toBeNull();
  });
});
