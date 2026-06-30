import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, isPg } from '../db/client.js';

// Plugin migration runner (core-owned). The optional @pierre/pro plugin ships its
// OWN dual-dialect *.sql migrations and calls ctx.registerMigrations(sqliteFolder,
// pgFolder); core executes them here against the live connection.
//
// ⚠ THIS IS THE ONLY PLACE the raw DB driver / non-portable terminals are used,
// and it is strictly DDL + bookkeeping (CREATE TABLE / INSERT into pro_migrations)
// — never a data query. Everything else in the codebase MUST go through the
// portable async drizzle surface (.execute()/.returning().execute()).

export async function runPluginMigrations(
  sqliteFolder: string,
  pgFolder: string,
): Promise<void> {
  const folder = isPg ? pgFolder : sqliteFolder;

  // The raw driver behind drizzle: a node-postgres Pool (pg) or a better-sqlite3
  // Database (sqlite). drizzle exposes it as `$client`.
  const client = (db as unknown as { $client: any }).$client;

  // Run a raw SQL string (possibly several statements). pg's Pool.query and
  // better-sqlite3's Database.exec both accept multiple semicolon-separated
  // statements in a single call.
  const execRaw = async (sqlText: string): Promise<void> => {
    if (isPg) await client.query(sqlText);
    else client.exec(sqlText);
  };

  // Bookkeeping table — which plugin migrations have been applied.
  await execRaw(
    'CREATE TABLE IF NOT EXISTS pro_migrations (name text PRIMARY KEY, applied_at ' +
      (isPg ? 'timestamptz' : 'integer') +
      ' NOT NULL)',
  );

  const files = readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const name of files) {
    try {
      let applied: boolean;
      if (isPg) {
        const r = await client.query(
          'SELECT 1 FROM pro_migrations WHERE name=$1',
          [name],
        );
        applied = r.rowCount > 0;
      } else {
        const row = client
          .prepare('SELECT 1 FROM pro_migrations WHERE name=?')
          .get(name);
        applied = !!row;
      }
      if (applied) continue;

      const text = readFileSync(join(folder, name), 'utf8');
      await execRaw(text);

      if (isPg) {
        await client.query(
          'INSERT INTO pro_migrations(name,applied_at) VALUES($1,$2)',
          [name, new Date()],
        );
      } else {
        client
          .prepare('INSERT INTO pro_migrations(name,applied_at) VALUES(?,?)')
          .run(name, Date.now());
      }
    } catch (err) {
      throw new Error(
        `pro migration '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
