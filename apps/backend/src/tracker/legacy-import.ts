import { db, isPg } from '../db/client.js';

// THE ONE-TIME MOVE OF THE PLUGIN-ERA TRACKER DATA INTO CORE (apiVersion 23).
//
// Until apiVersion 23 the tracker lived in the private plugin: the per-workspace settings and the
// Jira token on `pro_workspace_settings` (plugin 0031 + 0035), the stored tickets in
// `pro_pr_jira_tickets` (plugin 0038 + 0039). Core cannot reach those in a MIGRATION — on a fresh or
// plugin-less install the tables do not exist, and SQLite has no conditional DDL/DML to test for
// one — so the move happens HERE, at boot, after the plugin has bound (its own migrations have run):
//
//   1. each source table and column is tested for existence first (an install that never had the
//      plugin, or had an older one, simply has less to move);
//   2. the rows are copied into `workspace_trackers` / `tracker_tickets` with ON CONFLICT DO NOTHING
//      — a value already in core (saved since) always wins;
//   3. and IN THE SAME TRANSACTION the source is CLEARED: the tracker columns on
//      `pro_workspace_settings` are NULLed (the sprint cadence and every other setting on that row
//      are untouched) and the ticket rows are deleted.
//
// Step 3 is what makes it a MOVE and what makes it safe to run on every boot without a marker: a
// second boot finds nothing to copy, a token is never left at rest in two places, and a value a
// person later CLEARS in core can never be resurrected from the old copy. The token moves in its
// STORED form (`sealed:v1:…` / `plain:…`, tracker/secret.ts reads both), so nobody re-enters it.
//
// `pro_jira_ac_fields` needs no move: core ADOPTED it in place (migration 0088 / pg 0075).
//
// ⚠ RAW DRIVER, LIKE pro/migrate.ts: the source tables are not in core's drizzle schema (and must not
// be — that would make core declare plugin tables). This is the only place outside the plugin
// migrator that touches them, and only to move rows out.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

interface Tx {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
}

const client = (): any => (db as unknown as { $client: any }).$client;

async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isPg) {
    const conn = await client().connect();
    const tx: Tx = {
      all: async (q, p = []) => (await conn.query(q, p)).rows as Row[],
      run: async (q, p = []) => (await conn.query(q, p)).rowCount ?? 0,
    };
    try {
      await conn.query('BEGIN');
      const out = await fn(tx);
      await conn.query('COMMIT');
      return out;
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  const sqlite = client();
  // better-sqlite3 is synchronous; every awaited call below resolves without yielding to other I/O.
  const toSqlite = (q: string): string => q.replace(/\$\d+/g, '?');
  const tx: Tx = {
    all: async (q, p = []) => sqlite.prepare(toSqlite(q)).all(...p) as Row[],
    run: async (q, p = []) => sqlite.prepare(toSqlite(q)).run(...p).changes as number,
  };
  sqlite.exec('BEGIN');
  try {
    const out = await fn(tx);
    sqlite.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

async function columnsOf(tx: Tx, table: string): Promise<Set<string>> {
  if (isPg) {
    const rows = await tx.all(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
      [table],
    );
    return new Set(rows.map((r) => String(r.column_name)));
  }
  const exists = await tx.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1", [table]);
  if (exists.length === 0) return new Set();
  const rows = await tx.all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => String(r.name)));
}

const SETTING_COLS = [
  ['issue_provider', 'provider'],
  ['issue_base_url', 'base_url'],
  ['issue_project_keys', 'project_keys'],
  ['issue_match_scope', 'match_scope'],
  ['jira_email', 'auth_email'],
  ['jira_token', 'auth_token'],
] as const;

// Every `tracker_tickets` column the plugin table had (all but `provider`, which is 'jira').
const TICKET_COLS = [
  'account_id',
  'workspace_id',
  'pr_id',
  'issue_key',
  'detected_from',
  'detect_order',
  'api_root',
  'url',
  'state',
  'error_code',
  'title',
  'description',
  'acceptance_criteria',
  'ac_field_id',
  'ac_field_name',
  'ac_field_source',
  'issue_type_id',
  'issue_type_name',
  'status_name',
  'status_category',
  'assignee_name',
  'assignee_account_id',
  'assignee_avatar_url',
  'candidates_json',
  'omitted_candidates',
  'fetched_at',
  'checked_at',
  'next_check_at',
  'changed_at',
] as const;

export async function moveLegacyTrackerData(): Promise<{ trackers: number; tickets: number }> {
  return withTx(async (tx) => {
    let trackers = 0;
    let tickets = 0;

    // ---- 1. the per-workspace tracker settings + token ----
    const wsCols = await columnsOf(tx, 'pro_workspace_settings');
    const present = SETTING_COLS.filter(([from]) => wsCols.has(from));
    if (present.length > 0) {
      const anySet = present.map(([from]) => `s.${from} IS NOT NULL`).join(' OR ');
      // JOIN workspaces: only a workspace that still exists for this account (the composite FK on
      // workspace_trackers would refuse anything else, and must not abort the move).
      const rows = await tx.all(
        `SELECT s.account_id, s.workspace_id, ${present.map(([from]) => `s.${from}`).join(', ')}
           FROM pro_workspace_settings s
           JOIN workspaces w ON w.id = s.workspace_id AND w.account_id = s.account_id
          WHERE ${anySet}`,
      );
      for (const r of rows) {
        const cols = ['account_id', 'workspace_id', ...present.map(([, to]) => to)];
        const vals = [r.account_id, r.workspace_id, ...present.map(([from]) => r[from] ?? null)];
        const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
        trackers += await tx.run(
          `INSERT INTO workspace_trackers (${cols.join(', ')}) VALUES (${ph})
           ON CONFLICT (account_id, workspace_id) DO NOTHING`,
          vals,
        );
      }
      if (rows.length > 0) {
        await tx.run(
          `UPDATE pro_workspace_settings SET ${present.map(([from]) => `${from} = NULL`).join(', ')} WHERE ${anySet.replace(/s\./g, '')}`,
        );
      }
    }

    // ---- 2. the stored tickets ----
    const tCols = await columnsOf(tx, 'pro_pr_jira_tickets');
    if (tCols.size > 0) {
      const cols = TICKET_COLS.filter((c) => tCols.has(c));
      const n = await tx.all('SELECT count(*) AS n FROM pro_pr_jira_tickets');
      if (Number(n[0]?.n ?? 0) > 0) {
        tickets = await tx.run(
          `INSERT INTO tracker_tickets (provider, ${cols.join(', ')})
           SELECT 'jira', ${cols.join(', ')} FROM pro_pr_jira_tickets WHERE true
           ON CONFLICT (account_id, pr_id, issue_key) DO NOTHING`,
        );
        await tx.run('DELETE FROM pro_pr_jira_tickets');
      }
    }

    return { trackers, tickets };
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
