import { describe, expect, it } from 'vitest';
import {
  getTableConfig as sqliteTableConfig,
  integer as sqliteInteger,
  sqliteTable,
} from 'drizzle-orm/sqlite-core';
import {
  doublePrecision,
  getTableConfig as pgTableConfig,
  integer as pgInteger,
  pgTable,
} from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { PgTable } from 'drizzle-orm/pg-core';
import * as sqliteSchema from './schema.sqlite.js';
import * as pgSchema from './schema.pg.js';

// The dual-dialect design casts the active driver + schema to the Postgres
// types in client.ts. That cast is only SOUND if the two schema modules are
// structurally identical — same tables, same columns (name, nullability, TYPE) —
// so the row shapes the query layer infers match at runtime on either driver.
// This test is the structural guard the plan calls for ("a structural-assignability
// assert guards drift").

// A dialect-NEUTRAL description of a column's type, so the two schemas can be compared without
// pretending `integer` and `timestamptz` are the same word.
//
// drizzle's `dataType` is the JS-level type it decodes to, which already unifies the interesting
// pairs: sqlite `integer({mode:'timestamp'})` ↔ pg `timestamptz` are both 'date';
// `integer({mode:'boolean'})` ↔ `boolean` are both 'boolean'; `text({mode:'json'})` ↔ `jsonb` are
// both 'json'. What it does NOT distinguish is the one that matters for money: an INTEGER column
// and a REAL/double column are both 'number'. Cost is stored as integer CENTS in both dialects
// precisely because a float64 cannot hold $0.10 + $0.20, so an integer-vs-real drift has to fail
// here — before it silently reaches a live Postgres.
function canonicalType(col: { dataType: string; getSQLType(): string }): string {
  if (col.dataType !== 'number') return col.dataType;
  const sql = col.getSQLType().toLowerCase();
  if (/^(integer|int|int2|int4|int8|smallint|bigint|serial|bigserial|smallserial)\b/.test(sql))
    return 'number:int';
  if (/^(real|double|float|numeric|decimal)/.test(sql)) return 'number:float';
  // Anything unrecognised keeps its raw SQL type, so a novel numeric type still has to MATCH
  // across the dialects rather than being waved through as a generic 'number'.
  return `number:${sql}`;
}

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

      // Same TYPE per column. Names + nullability alone let integer-vs-real (or text-vs-json)
      // drift straight through — see canonicalType.
      const sTypes = Object.fromEntries(sCfg.columns.map((c) => [c.name, canonicalType(c)]));
      const pTypes = Object.fromEntries(pCfg.columns.map((c) => [c.name, canonicalType(c)]));
      expect(pTypes).toEqual(sTypes);
    });
  }
});

// MUTATION TEST OF THE GUARD ITSELF. A parity assertion that cannot fail is worse than none: it
// reads as coverage while permitting the exact drift it names. These two throwaway tables mutate
// one side the way a careless `numeric`/`real` twin for `cost_monthly_cents` would, and prove
// canonicalType actually notices — and that it is not simply returning a different string for
// every column (which would make the matching case fail instead).
describe('canonicalType (the parity guard is not vacuous)', () => {
  const sqliteMoney = sqliteTable('parity_probe', {
    cents: sqliteInteger('cost_monthly_cents'),
  });
  const pgMoneyOk = pgTable('parity_probe', { cents: pgInteger('cost_monthly_cents') });
  const pgMoneyDrifted = pgTable('parity_probe_drift', {
    cents: doublePrecision('cost_monthly_cents'),
  });

  const sCol = sqliteTableConfig(sqliteMoney).columns[0]!;
  const okCol = pgTableConfig(pgMoneyOk).columns[0]!;
  const driftCol = pgTableConfig(pgMoneyDrifted).columns[0]!;

  it('matches integer↔integer across the dialects (the shipped shape)', () => {
    expect(canonicalType(okCol)).toBe(canonicalType(sCol));
    expect(canonicalType(sCol)).toBe('number:int');
  });

  it('FAILS integer↔double precision — the drift the name/nullability checks miss', () => {
    // Both are notNull:false and both are called `cost_monthly_cents`, so the two original
    // assertions in this file pass on this pair. Only the type check separates them.
    expect(sCol.name).toBe(driftCol.name);
    expect(sCol.notNull).toBe(driftCol.notNull);
    expect(canonicalType(driftCol)).not.toBe(canonicalType(sCol));
    expect(canonicalType(driftCol)).toBe('number:float');
  });
});
