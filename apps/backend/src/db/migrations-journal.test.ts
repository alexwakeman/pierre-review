// The hand-maintained migration journal (db/migrations/meta/_journal.json, docs/MIGRATIONS.md).
// Drizzle's SQLite migrator applies an entry only when the last applied entry's `created_at` is
// LOWER than the entry's `when`. An entry whose `when` is lower than an earlier entry's is
// therefore SILENTLY skipped on every database that already ran that earlier entry (0162 was, with
// a `when` below 0160 and 0161). This pins:
//   1. `idx` runs 0..n-1 in order;
//   2. `when` rises STRICTLY with idx;
//   3. every .sql file is journalled, and every entry has its file.
//
//   pnpm --filter @pierre-review/backend test migrations-journal
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
type Entry = { idx: number; when: number; tag: string };
const entries = (JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: Entry[] })
  .entries;

describe('the migration journal', () => {
  it('numbers its entries 0..n-1 in order', () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  });

  it('gives every entry a `when` later than the entry before it', () => {
    const outOfOrder = entries.flatMap((e, i) => {
      const prev = entries[i - 1];
      return prev && e.when <= prev.when ? [`${e.tag} (${e.when}) <= ${prev.tag} (${prev.when})`] : [];
    });
    expect(outOfOrder).toEqual([]);
  });

  it('journals every .sql file and has a file for every entry', () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, -4))
      .sort();
    expect(entries.map((e) => e.tag).sort()).toEqual(files);
  });
});
