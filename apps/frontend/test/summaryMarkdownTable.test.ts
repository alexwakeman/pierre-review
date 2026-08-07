// parseBlocks' GFM pipe-table support (the Retro's Item/Category/PRs/Note table, or any table
// a chat answer emits). The contract under test:
//
//   • a run of `|` lines whose SECOND line is the `---` separator row becomes ONE `mdtable`
//     block — including rows that cite owner/name#N (checked BEFORE the refs branch, so a
//     table row can never be swallowed into a PrTable group);
//   • a MALFORMED table (no separator, or a separator whose cell count disagrees with the
//     header — the GFM validity rule) DEGRADES to the ordinary per-line branches. Degrading,
//     never crashing, is the landmine: the model authors these lines.
//
// No JSX: this directory is plain `.ts` (see vitest.config.ts). Run from the workspace that
// HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { DigestPrRef } from '@pierre-review/shared';
import { buildPrRefIndex } from '../src/components/Activity/prRefLinks.js';
import { parseBlocks, type Block } from '../src/components/Activity/prRefTable.js';

function ref(repoFullName: string, prNumber: number): DigestPrRef {
  return {
    prNumber,
    prId: prNumber, // any non-null id — parseBlocks only routes on resolvability
    repoId: 1,
    repoFullName,
    title: `PR ${prNumber}`,
    authorLogin: 'someone',
    authorId: 7,
    state: 'open',
    ciStatus: 'success',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    openedAt: null,
  };
}

const index = buildPrRefIndex([ref('acme/api', 12), ref('acme/web', 34)]);

const kinds = (blocks: Block[]): string[] => blocks.map((b) => b.kind);

describe('parseBlocks — GFM pipe tables', () => {
  it('parses a well-formed table into one mdtable block with trimmed cells', () => {
    const md = [
      'Sprint went fine overall.',
      '| Item | Category | PRs | Note |',
      '| --- | :---: | --- | ---: |',
      '| Auth rework | shipped | acme/api#12 | landed early |',
      '|CI flake fix|CI|acme/web#34|quarantined|',
      'And a closing thought.',
    ].join('\n');
    const blocks = parseBlocks(md, index);
    expect(kinds(blocks)).toEqual(['headline', 'mdtable', 'prose']);
    const table = blocks[1]!.table!;
    expect(table.header).toEqual(['Item', 'Category', 'PRs', 'Note']);
    expect(table.rows).toEqual([
      ['Auth rework', 'shipped', 'acme/api#12', 'landed early'],
      ['CI flake fix', 'CI', 'acme/web#34', 'quarantined'],
    ]);
  });

  it('keeps PR-citing rows in the mdtable — never swallowed into a PrTable group', () => {
    const md = [
      'Headline.',
      '| Item | PRs |',
      '| --- | --- |',
      '| Auth | acme/api#12 |',
    ].join('\n');
    const blocks = parseBlocks(md, index);
    expect(kinds(blocks)).toEqual(['headline', 'mdtable']);
    expect(blocks.some((b) => b.kind === 'prtable')).toBe(false);
  });

  it('degrades a run with NO separator row to plain lines (refs still coalesce)', () => {
    const md = [
      'Headline.',
      '| Item | PRs |',
      '| Auth | acme/api#12 |',
    ].join('\n');
    const blocks = parseBlocks(md, index);
    // No mdtable; the ref-bearing pipe line becomes an ordinary PrTable group and the
    // ref-less one prose — degraded, not crashed.
    expect(blocks.some((b) => b.kind === 'mdtable')).toBe(false);
    expect(kinds(blocks)).toContain('prtable');
  });

  it('degrades on a header/separator cell-count mismatch (the GFM validity rule)', () => {
    const md = [
      'Headline.',
      '| Item | Category | Note |',
      '| --- | --- |',
      '| Auth | shipped | fine |',
    ].join('\n');
    const blocks = parseBlocks(md, index);
    expect(blocks.some((b) => b.kind === 'mdtable')).toBe(false);
  });

  it('stops consuming at the first non-pipe line and parses a second table separately', () => {
    const md = [
      'Headline.',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      'Between the tables.',
      '| C | D |',
      '| --- | --- |',
      '| 3 | 4 |',
    ].join('\n');
    const blocks = parseBlocks(md, index);
    expect(kinds(blocks)).toEqual(['headline', 'mdtable', 'prose', 'mdtable']);
    expect(blocks[1]!.table!.header).toEqual(['A', 'B']);
    expect(blocks[3]!.table!.header).toEqual(['C', 'D']);
  });

  it('preserves ragged data rows as-is (the renderer pads/truncates to the header)', () => {
    const md = [
      'Headline.',
      '| A | B |',
      '| --- | --- |',
      '| only-one |',
      '| 1 | 2 | 3 |',
    ].join('\n');
    const blocks = parseBlocks(md, index);
    expect(blocks[1]!.table!.rows).toEqual([['only-one'], ['1', '2', '3']]);
  });

  it('never lets a table claim the headline: the first line stays the headline', () => {
    const md = [
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const blocks = parseBlocks(md, index);
    // The header row is consumed as the unconditional headline; the leftover separator/data
    // lines degrade to prose — ugly but stable, and the prompt always leads with narrative.
    expect(blocks[0]!.kind).toBe('headline');
    expect(blocks.some((b) => b.kind === 'mdtable')).toBe(false);
  });
});
