// POST /api/prs/resolve over the REAL core client and a real Fastify. What this pins:
//   1. "owner/name#N" and a bare, unambiguous "name#N" resolve to the account's PR id.
//   2. A bare name two repos share, an unknown repo and an unsynced number answer null.
//   3. ⚠ Another account's PR is null too — the same answer as "never synced".
//   4. A malformed or over-cap list 400s rather than truncating.
//
//   pnpm --filter @pierre-review/backend test pr-refs
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PR_REF_RESOLVE_MAX, type ResolvePrRefsResponse } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-pr-refs-route.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => Promise<void> | void) | undefined;
let app: FastifyInstance;
const ids: Record<string, number> = {};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  const db: any = client.db;
  const schema: any = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  await db
    .insert(schema.accounts)
    .values([
      { id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true },
      { id: 2, githubUserId: 'U_other', githubLogin: 'other', isLocal: false },
    ])
    .onConflictDoNothing()
    .execute();
  const repos: Array<[number, string, string]> = [
    [1, 'acme', 'bng-library'],
    [1, 'acme', 'api'],
    [1, 'beta', 'api'],
    [2, 'secret', 'vault'],
  ];
  for (const [accountId, owner, name] of repos) {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId, owner, name, githubNodeId: `R_${owner}_${name}` })
      .returning()
      .execute();
    const [p] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_${owner}_${name}`,
        accountId,
        repoId: r.id,
        number: 66,
        title: `${name} fix`,
        state: 'merged',
        isDraft: false,
        headSha: 'h',
        openedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .execute();
    ids[`${owner}/${name}`] = p.id;
  }
  const { default: Fastify } = await import('fastify');
  const { prRefRoutes } = await import('./pr-refs.js');
  app = Fastify({ logger: false });
  await app.register(prRefRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const resolve = (refs: unknown) => app.inject({ method: 'POST', url: '/api/prs/resolve', payload: { refs } });

describe('POST /api/prs/resolve', () => {
  it('resolves full and unambiguous bare names, and nothing else', async () => {
    const res = await resolve([
      { repo: 'acme/bng-library', number: 66 },
      { repo: 'BNG-LIBRARY', number: 66 },
      { repo: 'api', number: 66 },
      { repo: 'beta/api', number: 66 },
      { repo: 'acme/api', number: 999 },
      { repo: 'nope', number: 66 },
      { repo: 'secret/vault', number: 66 },
      { repo: 'vault', number: 66 },
    ]);
    expect(res.statusCode).toBe(200);
    const out = (res.json() as ResolvePrRefsResponse).refs;
    expect(out.map((r) => r.prId)).toEqual([
      ids['acme/bng-library'],
      ids['acme/bng-library'],
      null, // two of the account's repos are called "api"
      ids['beta/api'],
      null,
      null,
      null, // another account's PR
      null,
    ]);
    expect(out[0]).toMatchObject({ repo: 'acme/bng-library', number: 66, repoFullName: 'acme/bng-library', title: 'bng-library fix' });
    expect(out[1]!.repo).toBe('BNG-LIBRARY');
  });

  it('400s a malformed or over-cap list', async () => {
    expect((await resolve('x')).statusCode).toBe(400);
    expect((await resolve([{ repo: '', number: 1 }])).statusCode).toBe(400);
    expect((await resolve([{ repo: 'a', number: 1.5 }])).statusCode).toBe(400);
    // Past Postgres int4: refused at validation, never a 500 from the database.
    expect((await resolve([{ repo: 'api', number: 3_000_000_000 }])).statusCode).toBe(400);
    const many = Array.from({ length: PR_REF_RESOLVE_MAX + 1 }, (_, i) => ({ repo: 'api', number: i + 1 }));
    expect((await resolve(many)).statusCode).toBe(400);
    expect((await resolve([])).json()).toEqual({ refs: [] });
  });
});
