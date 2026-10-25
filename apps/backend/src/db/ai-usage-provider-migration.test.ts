// MIGRATION 0127 (ai_usage.provider + ai_usage.share_pct; ai/provider.ts, docs/CODEX-PLAN.md § 8.1),
// on throwaway SQLite files with drizzle's own migrator — the same one boot runs:
//   1. FRESH: the whole chain gives `provider` TEXT NOT NULL DEFAULT 'claude' and a nullable REAL
//      `share_pct`; a row written without either is Claude's, with no share; tokens stay nullable;
//   2. UPGRADED: a database migrated to 0126 with ledger rows in it, then migrated to the end, keeps
//      every row and stamps each one 'claude' with no share;
//   3. the journal registers 0127 (an unregistered file would SILENTLY skip).
//
//   pnpm --filter @pierre-review/backend test ai-usage-provider-migration
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));
const TAG = '0127_ai_usage_provider';
const scratch = mkdtempSync(join(tmpdir(), 'limn-mig-0127-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}
const journal = (): Journal => JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as Journal;

/** A copy of the migrations folder holding only the entries before `tag`. */
function foldersBefore(tag: string): string {
  const dir = join(scratch, `before-${tag}`);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const j = journal();
  const cut = j.entries.findIndex((e) => e.tag === tag);
  const kept = j.entries.slice(0, cut);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...j, entries: kept }));
  for (const e of kept) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

function open(name: string): { sqlite: Database.Database; run: (folder: string) => void } {
  const sqlite = new Database(join(scratch, name));
  const db = drizzle(sqlite);
  return { sqlite, run: (folder) => migrate(db, { migrationsFolder: folder }) };
}

type Col = { name: string; type: string; notnull: number; dflt_value: string | null };
const columns = (sqlite: Database.Database): Record<string, Col> =>
  Object.fromEntries((sqlite.prepare('PRAGMA table_info(ai_usage)').all() as Col[]).map((c) => [c.name, c]));

const insertAccount = (sqlite: Database.Database): void => {
  sqlite.prepare("INSERT OR IGNORE INTO accounts (id, github_user_id, github_login) VALUES (1, 'U1', 'me')").run();
};
const insertUsage = (sqlite: Database.Database, usd: number, tokens: number | null): void => {
  sqlite
    .prepare(
      "INSERT INTO ai_usage (account_id, seam, feature, model, cost_usd, input_tokens, output_tokens) VALUES (1, 'agent', 'claude_review', 'claude-opus-5-5', ?, ?, ?)",
    )
    .run(usd, tokens, tokens);
};

describe('migration 0127: ai_usage.provider + share_pct', () => {
  it('is registered in the journal, after 0126', () => {
    const tags = journal().entries.map((e) => e.tag);
    expect(tags).toContain(TAG);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0126_workspace_auto_diagrams') + 1);
    expect(readdirSync(MIGRATIONS)).toContain(`${TAG}.sql`);
  });

  it('a FRESH database: provider NOT NULL default claude, share_pct nullable, tokens nullable', () => {
    const { sqlite, run } = open('fresh.sqlite');
    run(MIGRATIONS);
    const cols = columns(sqlite);
    expect(cols.provider).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'claude'" });
    expect(cols.share_pct).toMatchObject({ type: 'REAL', notnull: 0, dflt_value: null });
    expect(cols.input_tokens?.notnull).toBe(0);
    expect(cols.output_tokens?.notnull).toBe(0);
    insertAccount(sqlite);
    insertUsage(sqlite, 0.5, null);
    expect(sqlite.prepare('SELECT provider, share_pct, input_tokens FROM ai_usage').all()).toEqual([
      { provider: 'claude', share_pct: null, input_tokens: null },
    ]);
    sqlite
      .prepare(
        "INSERT INTO ai_usage (account_id, seam, feature, model, cost_usd, provider, share_pct) VALUES (1, 'agent', 'ai_fix', 'm', 0, 'codex', 1.5)",
      )
      .run();
    expect(sqlite.prepare("SELECT provider, share_pct FROM ai_usage WHERE provider = 'codex'").get()).toEqual({
      provider: 'codex',
      share_pct: 1.5,
    });
    expect(() => sqlite.prepare("INSERT INTO ai_usage (account_id, seam, feature, model, cost_usd, provider) VALUES (1, 'agent', 'x', 'm', 1, NULL)").run()).toThrow(
      /NOT NULL/,
    );
    sqlite.close();
  });

  it('an UPGRADED database keeps its rows and stamps each one claude', () => {
    const { sqlite, run } = open('upgraded.sqlite');
    run(foldersBefore(TAG));
    expect(columns(sqlite).provider).toBeUndefined();
    insertAccount(sqlite);
    insertUsage(sqlite, 1.25, 100);
    insertUsage(sqlite, 2.5, null);
    run(MIGRATIONS);
    expect(sqlite.prepare('SELECT cost_usd, input_tokens, provider, share_pct FROM ai_usage ORDER BY id').all()).toEqual([
      { cost_usd: 1.25, input_tokens: 100, provider: 'claude', share_pct: null },
      { cost_usd: 2.5, input_tokens: null, provider: 'claude', share_pct: null },
    ]);
    sqlite.close();
  });
});
