// The platform migration runner commits each file WITH its pro_migrations row, so a file that fails
// part-way leaves nothing behind and the next boot can apply it cleanly.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationFiles } from '../migration-files.js';

describe('applyMigrationFiles', () => {
  let dir: string;
  let client: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'limn-platform-mig-'));
    client = new Database(':memory:');
  });
  afterEach(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tables = () =>
    (client.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]).map((r) => r.name);
  const applied = () =>
    (client.prepare('SELECT name FROM pro_migrations ORDER BY name').all() as { name: string }[]).map(
      (r) => r.name,
    );

  it('a file that fails part-way leaves neither its DDL nor its bookkeeping row, and re-runs cleanly', () => {
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE t_ok (id integer);');
    writeFileSync(
      join(dir, '0002_half.sql'),
      'CREATE TABLE t_first (id integer);\nCREATE TABLE t_second (id integer REFERENCES;',
    );

    expect(() => applyMigrationFiles(client, dir)).toThrow(/pro migration '0002_half.sql' failed/);
    expect(tables()).not.toContain('t_first');
    expect(applied()).toEqual(['0001_ok.sql']);

    // The next boot, with the file fixed, applies it — no "table t_first already exists".
    writeFileSync(
      join(dir, '0002_half.sql'),
      'CREATE TABLE t_first (id integer);\nCREATE TABLE t_second (id integer);',
    );
    applyMigrationFiles(client, dir);
    expect(tables()).toEqual(expect.arrayContaining(['t_ok', 't_first', 't_second']));
    expect(applied()).toEqual(['0001_ok.sql', '0002_half.sql']);
  });

  it('each file runs once by name', () => {
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id integer);');
    applyMigrationFiles(client, dir);
    applyMigrationFiles(client, dir); // would throw "table a already exists" if re-run
    expect(applied()).toEqual(['0001_a.sql']);
  });
});
