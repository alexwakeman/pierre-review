// PLUGIN MIGRATION 0037 — the auto-review switch moves to core `workspaces`.
//
// Claude Review moved to core (apiVersion 22) and its per-workspace auto-review switch moved from
// `pro_workspace_settings.auto_review_enabled[_at]` (plugin 0036) to core
// `workspaces.auto_review_enabled[_at]` (core 0074). This file pins the ONE-TIME copy:
//
//   1. an ON switch is copied with its floor, onto the SAME (account, workspace) only;
//   2. an off switch, or one with no floor, copies nothing (no floor = no safe "which PRs are new");
//   3. ⚠ A CORE VALUE ALREADY SET WINS — the copy never overwrites what the new route wrote.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/auto-review-to-core
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8');

const T1 = 1_790_000_000; // seconds, as SQLite stores both columns
const T2 = 1_790_100_000;

function fresh(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(
    // The two core columns exist before any plugin migration runs (core 0074 runs first).
    'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
      'is_default integer NOT NULL DEFAULT 0, auto_review_enabled integer, auto_review_enabled_at integer);' +
      'CREATE TABLE pro_workspace_settings (id integer PRIMARY KEY AUTOINCREMENT, ' +
      'account_id integer NOT NULL, workspace_id integer NOT NULL, ' +
      'auto_review_enabled integer, auto_review_enabled_at integer);',
  );
  sqlite.exec(
    "INSERT INTO workspaces (id, account_id, name) VALUES (1,1,'A on'),(2,1,'A off'),(3,1,'A no floor'),(4,1,'A core set'),(90,2,'B');",
  );
  sqlite.exec(
    'INSERT INTO pro_workspace_settings (account_id, workspace_id, auto_review_enabled, auto_review_enabled_at) VALUES ' +
      `(1,1,1,${T1}),(1,2,0,NULL),(1,3,1,NULL),(1,4,1,${T1}),` +
      // A row naming workspace 90 under the WRONG account (1, not 2) must not copy.
      `(1,90,1,${T1});`,
  );
  // Workspace 4 was already switched OFF through the new core route.
  sqlite.exec('UPDATE workspaces SET auto_review_enabled = 0, auto_review_enabled_at = NULL WHERE id = 4;');
  return sqlite;
}

const read = (sqlite: Database.Database) =>
  Object.fromEntries(
    (
      sqlite
        .prepare('SELECT id, auto_review_enabled AS e, auto_review_enabled_at AS at FROM workspaces ORDER BY id')
        .all() as Array<{ id: number; e: number | null; at: number | null }>
    ).map((r) => [r.id, [r.e, r.at]]),
  );

describe('plugin 0037 — auto review to core', () => {
  it('copies an ON switch with its floor, and nothing else', () => {
    const sqlite = fresh();
    sqlite.exec(migration('0037_auto_review_to_core.sql'));
    expect(read(sqlite)).toEqual({
      1: [1, T1],
      2: [null, null],
      3: [null, null],
      // ⚠ the core value wins
      4: [0, null],
      // the (account 1, workspace 90) settings row does not belong to workspace 90's account
      90: [null, null],
    });
  });

  it('is a no-op on a second run (the switch-on moment never moves)', () => {
    const sqlite = fresh();
    sqlite.exec(migration('0037_auto_review_to_core.sql'));
    sqlite.exec(`UPDATE pro_workspace_settings SET auto_review_enabled_at = ${T2} WHERE workspace_id = 1;`);
    sqlite.exec(migration('0037_auto_review_to_core.sql'));
    expect(read(sqlite)[1]).toEqual([1, T1]);
  });
});
