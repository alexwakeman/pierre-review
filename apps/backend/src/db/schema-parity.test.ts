import { describe, expect, it } from 'vitest';
import { getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { PgTable } from 'drizzle-orm/pg-core';
import * as sqliteSchema from './schema.sqlite.js';
import * as pgSchema from './schema.pg.js';

// The dual-dialect design casts the active driver + schema to the Postgres
// types in client.ts. That cast is only SOUND if the two schema modules are
// structurally identical — same tables, same columns (name, nullability) — so
// the row shapes the query layer infers match at runtime on either driver. This
// test is the structural guard the plan calls for ("a structural-assignability
// assert guards drift").

function sqliteTables(): Record<string, SQLiteTable> {
  const out: Record<string, SQLiteTable> = {};
  for (const [k, v] of Object.entries(sqliteSchema)) {
    if (is(v, SQLiteTable)) out[k] = v;
  }
  return out;
}

function pgTables(): Record<string, PgTable> {
  const out: Record<string, PgTable> = {};
  for (const [k, v] of Object.entries(pgSchema)) {
    if (is(v, PgTable)) out[k] = v;
  }
  return out;
}

describe('schema parity (sqlite <-> pg)', () => {
  const sq = sqliteTables();
  const pg = pgTables();

  it('exports the same set of tables', () => {
    expect(Object.keys(sq).sort()).toEqual(Object.keys(pg).sort());
  });

  for (const key of Object.keys(sqliteTables())) {
    it(`table "${key}" has matching name + columns`, () => {
      const sCfg = sqliteTableConfig(sq[key]!);
      const pCfg = pgTableConfig(pg[key]!);

      // Same SQL table name.
      expect(pCfg.name).toBe(sCfg.name);

      // Same column SQL names.
      const sCols = sCfg.columns.map((c) => c.name).sort();
      const pCols = pCfg.columns.map((c) => c.name).sort();
      expect(pCols).toEqual(sCols);

      // Same nullability per column.
      const sNull = Object.fromEntries(
        sCfg.columns.map((c) => [c.name, c.notNull]),
      );
      const pNull = Object.fromEntries(
        pCfg.columns.map((c) => [c.name, c.notNull]),
      );
      expect(pNull).toEqual(sNull);
    });
  }
});
