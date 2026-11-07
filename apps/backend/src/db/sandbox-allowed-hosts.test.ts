// SANDBOX "ALWAYS ALLOW" HOSTS on a THROWAWAY sqlite DB (migration 0173). Pins: the rule is stored
// NORMALISED (two spellings, one row); per workspace with no inheritance; another account's workspace
// is refused; a refused rule is never stored; erasure and export reach the table.
//
// DATABASE_URL is set BEFORE the client is imported (it opens the connection at module load), and
// every import is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/limn-sandbox-hosts-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let hosts: typeof import('./sandbox-allowed-hosts.js');
let wsA = 0;
let wsB = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  hosts = await import('./sandbox-allowed-hosts.js');
  const [a] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Sandbox A' }).returning().execute();
  const [b] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Sandbox B' }).returning().execute();
  wsA = a.id;
  wsB = b.id;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('sandbox allowed hosts', () => {
  it('stores the normalised rule once, per workspace', async () => {
    expect(await hosts.addSandboxAllowedHost(1, wsA, 'Registry.Example.COM.')).toEqual({ ok: true, rule: 'registry.example.com', added: true });
    expect(await hosts.addSandboxAllowedHost(1, wsA, 'registry.example.com')).toEqual({ ok: true, rule: 'registry.example.com', added: false });
    expect(await hosts.addSandboxAllowedHost(1, wsA, '*.bücher.example:8443')).toMatchObject({ ok: true, rule: '*.xn--bcher-kva.example:8443' });
    expect(await hosts.listSandboxAllowedHosts(1, wsA)).toEqual(['*.xn--bcher-kva.example:8443', 'registry.example.com']);
    // No inheritance: workspace B sees nothing.
    expect(await hosts.listSandboxAllowedHosts(1, wsB)).toEqual([]);
  });

  it('refuses a rule the reader may not add, and stores nothing', async () => {
    for (const bad of ['*', '*.com', 'localhost', '127.0.0.1', '169.254.169.254', 'not a host']) {
      const r = await hosts.addSandboxAllowedHost(1, wsB, bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(await hosts.listSandboxAllowedHosts(1, wsB)).toEqual([]);
  });

  it("refuses another account's workspace", async () => {
    expect(await hosts.addSandboxAllowedHost(2, wsA, 'example.org')).toEqual({ ok: false, reason: 'No such workspace.' });
    expect(await hosts.listSandboxAllowedHosts(2, wsA)).toEqual([]);
  });

  it('removes by any accepted spelling', async () => {
    expect(await hosts.removeSandboxAllowedHost(1, wsA, 'REGISTRY.example.com')).toBe(true);
    expect(await hosts.removeSandboxAllowedHost(1, wsA, 'registry.example.com')).toBe(false);
  });

  it('is on the erasure checklist and in the export', async () => {
    const { accountScopedTables } = await import('./erase-account.js');
    expect(accountScopedTables().map((t) => t.name)).toContain('sandboxAllowedHosts');
    const { exportAccountData } = await import('./export-account.js');
    const out: any = await exportAccountData(1);
    expect(out.sandboxAllowedHosts).toEqual([expect.objectContaining({ workspaceId: wsA, rule: '*.xn--bcher-kva.example:8443' })]);
  });
});
