import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspaceTools, MAX_READ_BYTES, ToolRefusal, type WorkspaceTools } from './workspace-files.js';

// The spike's fixture, plus the escapes it proved (CODEX-SPIKE.md § 2): a worktree `root`, a sibling
// `outside/secret.env`, a symlinked FILE and a symlinked DIRECTORY pointing out of the root.
let dir: string;
let root: string;
let other: string;
let tools: WorkspaceTools;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'limn-wsfiles-')));
  root = join(dir, 'root');
  other = join(dir, 'library');
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(dir, 'outside'));
  mkdirSync(other);
  writeFileSync(join(dir, 'outside', 'secret.env'), 'MAGIC_SECRET=4217\n');
  writeFileSync(join(root, 'README.md'), '# Fixture\nhello world\n');
  writeFileSync(join(root, 'src', 'math.ts'), 'export function div(a: number, b: number) {\n  return a / b;\n}\n');
  writeFileSync(join(root, 'src', 'deep', 'greet.test.ts'), 'it("greets", () => {});\r\n// TODO: more\r\n');
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'TODO hidden\n');
  writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  writeFileSync(join(root, 'long.txt'), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n'));
  writeFileSync(join(root, 'wide.txt'), `${'x'.repeat(5000)}\n`);
  writeFileSync(join(root, 'empty.txt'), '');
  writeFileSync(join(other, 'guide.md'), 'TODO in the library\n');
  symlinkSync(join(dir, 'outside', 'secret.env'), join(root, 'link-out.env'));
  symlinkSync(join(dir, 'outside'), join(root, 'link-dir'));
  symlinkSync(join(root, 'README.md'), join(root, 'link-in.md'));
  tools = createWorkspaceTools([root, other]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const refused = (name: string, args: unknown) => {
  try {
    tools.call(name, args);
  } catch (e) {
    expect(e).toBeInstanceOf(ToolRefusal);
    return (e as Error).message;
  }
  throw new Error(`${name} ${JSON.stringify(args)} was not refused`);
};

describe('read_file', () => {
  it('reads a file with line numbers', () => {
    expect(tools.call('read_file', { path: 'src/math.ts' })).toBe(
      '1\texport function div(a: number, b: number) {\n2\t  return a / b;\n3\t}',
    );
    expect(tools.call('read_file', { path: join(root, 'README.md') })).toBe('1\t# Fixture\n2\thello world');
    expect(tools.call('read_file', { path: 'src/deep/greet.test.ts' })).toBe('1\tit("greets", () => {});\n2\t// TODO: more');
  });

  it('refuses the three escapes, and NUL', () => {
    expect(refused('read_file', { path: '../outside/secret.env' })).toMatch(/outside the workspace/);
    expect(refused('read_file', { path: join(dir, 'outside', 'secret.env') })).toMatch(/outside the workspace/);
    expect(refused('read_file', { path: 'link-out.env' })).toMatch(/outside the workspace/);
    expect(refused('read_file', { path: 'link-dir/secret.env' })).toMatch(/outside the workspace/);
    expect(refused('read_file', { path: 'src/../../outside/secret.env' })).toMatch(/outside the workspace/);
    expect(refused('read_file', { path: '~/.ssh/id_rsa' })).toMatch(/outside the workspace/);
    expect(refused('read_file', { path: '/etc/passwd' })).toMatch(/outside the workspace/);
    expect(refused('read_file', { path: 'README.md\u0000' })).toMatch(/outside the workspace/);
  });

  it('follows a symlink that stays inside', () => {
    expect(tools.call('read_file', { path: 'link-in.md' })).toContain('hello world');
  });

  it('reads a second root by absolute path', () => {
    expect(tools.call('read_file', { path: join(other, 'guide.md') })).toBe('1\tTODO in the library');
  });

  it('pages with offset and limit, and says so', () => {
    const first = tools.call('read_file', { path: 'long.txt' });
    expect(first.split('\n')).toHaveLength(2001);
    expect(first).toMatch(/\(lines 1–2000 of 2500\. Pass offset=2001 to read on\.\)$/);
    expect(tools.call('read_file', { path: 'long.txt', offset: 2499, limit: 5 })).toBe('2499\tline 2499\n2500\tline 2500\n(lines 2499–2500 of 2500.)');
    expect(refused('read_file', { path: 'long.txt', offset: 9999 })).toMatch(/2500 lines/);
    expect(refused('read_file', { path: 'long.txt', offset: 0 })).toMatch(/at least 1/);
    expect(refused('read_file', { path: 'long.txt', limit: 'x' })).toMatch(/whole number/);
  });

  it('cuts very long lines, names binary files, reports empty ones', () => {
    expect(tools.call('read_file', { path: 'wide.txt' })).toMatch(/line cut at 2000 characters\)$/);
    expect(tools.call('read_file', { path: 'image.png' })).toBe('image.png is a binary file (8 bytes). Its contents are not shown.');
    expect(tools.call('read_file', { path: 'empty.txt' })).toBe('empty.txt is empty.');
  });

  it('refuses a huge file, a directory, a missing file, a missing path', () => {
    const huge = join(root, 'huge.log');
    writeFileSync(huge, Buffer.alloc(MAX_READ_BYTES + 1, 0x61));
    try {
      expect(refused('read_file', { path: 'huge.log' })).toMatch(/more than read_file's 8\.0 MB limit/);
      expect(tools.call('search', { pattern: 'zzz', path: 'huge.log' })).toMatch(/1 file\(s\) over 8\.0 MB were not searched/);
    } finally {
      rmSync(huge);
    }
    expect(refused('read_file', { path: 'src' })).toMatch(/is a directory/);
    expect(refused('read_file', { path: 'nope.txt' })).toMatch(/No such file/);
    expect(refused('read_file', {})).toMatch(/"path" is required/);
    expect(refused('read_file', [])).toMatch(/must be an object/);
  });
});

describe('list_files', () => {
  it('lists every root, skipping node_modules and symlinked directories', () => {
    const out = tools.call('list_files', {}).split('\n');
    expect(out).toContain('src/math.ts');
    expect(out).toContain('link-in.md');
    expect(out).toContain(join(other, 'guide.md'));
    expect(out.some((l) => l.includes('node_modules'))).toBe(false);
    expect(out.some((l) => l.includes('secret'))).toBe(false);
    expect(out).not.toContain('link-out.env'); // a link to a file outside is not listed
  });

  it('filters by glob (basename without a slash, path with one)', () => {
    expect(tools.call('list_files', { pattern: '*.ts' }).split('\n').sort()).toEqual(['src/deep/greet.test.ts', 'src/math.ts']);
    expect(tools.call('list_files', { path: 'src', pattern: '*.ts' }).split('\n').sort()).toEqual(['src/deep/greet.test.ts', 'src/math.ts']);
    expect(tools.call('list_files', { path: 'src', pattern: 'deep/*' })).toBe('src/deep/greet.test.ts');
    expect(tools.call('list_files', { pattern: '*.nope' })).toBe('(no files match)');
    expect(refused('list_files', { pattern: '{a' })).toMatch(/Bad glob/);
  });

  it('refuses a directory outside, by every route', () => {
    expect(refused('list_files', { path: '..' })).toMatch(/outside the workspace/);
    expect(refused('list_files', { path: 'link-dir' })).toMatch(/outside the workspace/);
    expect(refused('list_files', { path: '/' })).toMatch(/outside the workspace/);
  });

  it('states its cap', () => {
    const out = tools.call('list_files', { limit: 2 }).split('\n');
    expect(out).toHaveLength(3);
    expect(out[2]).toMatch(/first 2 files shown/);
  });
});

describe('search', () => {
  it('finds lines by regex and by literal, never outside', () => {
    expect(tools.call('search', { pattern: 'TODO' }).split('\n').sort()).toEqual(
      [`${join(other, 'guide.md')}:1: TODO in the library`, 'src/deep/greet.test.ts:2: // TODO: more'].sort(),
    );
    expect(tools.call('search', { pattern: 'MAGIC_SECRET' })).toBe('(no matches)');
    expect(tools.call('search', { pattern: 'a / b', literal: true })).toBe('src/math.ts:2:   return a / b;');
    expect(tools.call('search', { pattern: 'DIV\\(', ignore_case: true })).toBe('src/math.ts:1: export function div(a: number, b: number) {');
    expect(tools.call('search', { pattern: 'TODO', glob: '*.ts' })).toBe('src/deep/greet.test.ts:2: // TODO: more');
    expect(tools.call('search', { pattern: 'hello', path: 'README.md' })).toBe('README.md:2: hello world');
    expect(refused('search', { pattern: 'x', path: '../outside' })).toMatch(/outside the workspace/);
    expect(refused('search', { pattern: 'x', path: 'link-out.env' })).toMatch(/outside the workspace/);
  });

  it('skips binary files and refuses a bad pattern in a sentence', () => {
    expect(tools.call('search', { pattern: 'PNG' })).toBe('(no matches)');
    expect(refused('search', { pattern: '(a)\\1' })).toMatch(/Back-references.*literal=true/);
    expect(refused('search', {})).toMatch(/"pattern" is required/);
  });

  it('stays fast on a catastrophic pattern over a long line', () => {
    const f = join(root, 'aaa.txt');
    writeFileSync(f, `${'a'.repeat(19_000)}b\n`);
    try {
      const started = Date.now();
      tools.call('search', { pattern: '(a+)+$', path: 'aaa.txt' });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(f);
    }
  });

  it('states its limit', () => {
    const out = tools.call('search', { pattern: 'line', path: 'long.txt', limit: 3 }).split('\n');
    expect(out).toEqual(['long.txt:1: line 1', 'long.txt:2: line 2', 'long.txt:3: line 3', '(first 3 matches shown; narrow with path or glob to see the rest.)']);
  });
});

describe('createWorkspaceTools', () => {
  it('needs absolute roots', () => {
    expect(() => createWorkspaceTools([])).toThrow(/at least one/);
    expect(() => createWorkspaceTools(['relative'])).toThrow(/absolute/);
  });
  it('refuses an unknown tool', () => {
    expect(refused('write_file', {})).toMatch(/Unknown tool/);
  });
});
