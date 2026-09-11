import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MergeTreeParseError, parseMergeTree, stripMangledSuffix } from './parse.js';

// GOLDEN BYTES, NO GIT. The three `.bin` files are real `git merge-tree --write-tree -z`
// stdout, captured from throwaway repositories by `__fixtures__/merge-tree/generate.sh`; the
// `.json` beside each one carries the two committishes that produced it, because the
// collision mangling embeds them. Re-run the script (passing the fixture directory) if git
// ever changes the format — and read the diff, because a format change is the news.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'merge-tree');

function fixture(name: string): { bytes: Buffer; ours: string; theirs: string } {
  const bytes = readFileSync(join(FIXTURES, `${name}.bin`));
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    ours: string;
    theirs: string;
  };
  return { bytes, ours: meta.ours, theirs: meta.theirs };
}

describe('parseMergeTree', () => {
  it('parses a clean merge: a tree oid, no stage section at all', () => {
    const { bytes } = fixture('clean');
    // The whole output is the oid plus its NUL. Section 2 never begins, so a parser that
    // insists on the empty terminator record refuses every clean merge.
    expect(bytes.length).toBe(41);
    const out = parseMergeTree(bytes);
    expect(out.treeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(out.stages).toEqual([]);
    expect(out.messages).toEqual([]);
  });

  it('parses every stage record and every message record of a mixed conflict', () => {
    const { bytes } = fixture('all-kinds');
    const out = parseMergeTree(bytes);
    expect(out.stages).toHaveLength(16);
    expect(out.messages).toHaveLength(11);
    expect(out.stages.every((s) => /^[0-9a-f]{40}$/.test(s.oid))).toBe(true);
    expect(new Set(out.stages.map((s) => s.stage))).toEqual(new Set([1, 2, 3]));
  });

  it('keeps the mangled `<path>~<sha>` stage path exactly as git wrote it', () => {
    const { bytes, theirs } = fixture('all-kinds');
    const out = parseMergeTree(bytes);
    const mangled = out.stages.filter((s) => s.path === `fdir.txt~${theirs}`);
    expect(mangled).toHaveLength(2);
  });

  it('carries all three paths of a rename/rename record', () => {
    const { bytes } = fixture('all-kinds');
    const rr = parseMergeTree(bytes).messages.find(
      (m) => m.type === 'CONFLICT (rename/rename)',
    );
    expect(rr?.paths).toEqual(['ren.txt', 'ren-ours.txt', 'ren-theirs.txt']);
  });

  it('emits BOTH `CONFLICT (binary)` and `CONFLICT (contents)` for one binary path', () => {
    // ⚠ THE TRAP. A first-match classifier reads the second of these and calls a binary file
    // text, and a text classification is an offer to rewrite the file as UTF-8.
    const { bytes } = fixture('all-kinds');
    const types = parseMergeTree(bytes)
      .messages.filter((m) => m.paths.includes('bin.dat'))
      .map((m) => m.type);
    expect(types).toContain('CONFLICT (binary)');
    expect(types).toContain('CONFLICT (contents)');
  });

  it('reads a message whose body contains newlines by field count, not by line', () => {
    const { bytes } = fixture('all-kinds');
    const md = parseMergeTree(bytes).messages.find(
      (m) => m.type === 'CONFLICT (modify/delete)' && m.paths[0] === 'del.txt',
    );
    expect(md?.message.endsWith('\n')).toBe(true);
    expect(md?.paths).toHaveLength(1);
  });

  it('reports a submodule as mode 160000 plus both message types', () => {
    const { bytes } = fixture('submodule');
    const out = parseMergeTree(bytes);
    const gitlinks = out.stages.filter((s) => s.path === 'sub');
    expect(gitlinks).toHaveLength(3);
    expect(gitlinks.every((s) => s.mode === '160000')).toBe(true);
    const types = out.messages.filter((m) => m.paths.includes('sub')).map((m) => m.type);
    expect(types).toContain('CONFLICT (submodule not initialized)');
    expect(types).toContain('CONFLICT (contents)');
  });

  it('throws a typed error rather than returning half a model', () => {
    const NUL = String.fromCharCode(0);
    const oid = 'a'.repeat(40);
    expect(() => parseMergeTree(Buffer.alloc(0))).toThrow(MergeTreeParseError);
    expect(() => parseMergeTree(Buffer.from(`not-an-oid${NUL}`))).toThrow(MergeTreeParseError);
    // A stage section that never terminates.
    expect(() =>
      parseMergeTree(Buffer.from(`${oid}${NUL}100644 ${oid} 2\tf.txt${NUL}`)),
    ).toThrow(MergeTreeParseError);
    // A message record whose path count promises records that are not there.
    expect(() => parseMergeTree(Buffer.from(`${oid}${NUL}${NUL}2${NUL}one-path${NUL}`))).toThrow(
      MergeTreeParseError,
    );
    // A stage record that is not `<mode> <oid> <stage>TAB<path>`.
    expect(() => parseMergeTree(Buffer.from(`${oid}${NUL}garbage${NUL}${NUL}`))).toThrow(
      MergeTreeParseError,
    );
  });
});

describe('stripMangledSuffix', () => {
  const ours = 'b'.repeat(40);
  const theirs = 'c'.repeat(40);

  it('strips the suffix git added', () => {
    expect(stripMangledSuffix(`fdir.txt~${theirs}`, [ours, theirs])).toBe('fdir.txt');
  });

  it('leaves a real filename containing `~` alone', () => {
    // `we~ird.txt` is a legal path and is in the fixture. Stripping `~.*` would rename it on
    // screen and then fail to match it back to its stage entries.
    expect(stripMangledSuffix('we~ird.txt', [ours, theirs])).toBe('we~ird.txt');
    expect(stripMangledSuffix('~leading', [ours, theirs])).toBe('~leading');
    expect(stripMangledSuffix('a~b', [ours, theirs])).toBe('a~b');
  });

  it('accepts an abbreviated sha, but only of a sha we handed git', () => {
    expect(stripMangledSuffix(`f.txt~${theirs.slice(0, 7)}`, [ours, theirs])).toBe('f.txt');
    expect(stripMangledSuffix('f.txt~deadbee', [ours, theirs])).toBe('f.txt~deadbee');
  });
});
