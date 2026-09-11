// THE CLOUD POSTURE: the merge-conflict resolver's six routes DO NOT EXIST when
// `DEPLOYMENT_MODE=cloud`.
//
// Its own file because `config` is read at import time (the landing-routes.test.ts pattern) —
// one module registry is one deployment mode. The LOCAL half of the same claim lives in
// `conflicts.test.ts` (`the family is registered in local mode`); without it, "they 404 in cloud"
// would be satisfied just as well by a typo in every path.
//
// ⚠ THE GATE IS REGISTRATION, NOT A HANDLER. There is no `CONFLICT_RESOLVER_ENABLED` and there
// must not be one: a per-handler env check LOOKS like a gate while being one Railway variable
// away from not being one. There is no clone directory and no git guarantee in the cloud image.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-conflicts-cloud-test.sqlite';
process.env.DEPLOYMENT_MODE = 'cloud';
process.env.DISABLE_SCHEDULER = 'true';
process.env.SESSION_SECRET = 'a'.repeat(48);
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.APP_BASE_URL = 'https://app.example.com';
process.env.DATABASE_URL = 'postgres://pierre:pierre@127.0.0.1:5432/pierre_never_connected';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;

const PATHS: Array<[string, string]> = [
  ['POST', '/api/prs/:id/conflicts'],
  ['GET', '/api/prs/:id/conflicts'],
  ['GET', '/api/prs/:id/conflicts/stream'],
  ['GET', '/api/prs/:id/conflicts/files/:fileIndex'],
  ['POST', '/api/prs/:id/conflicts/commit'],
  ['DELETE', '/api/prs/:id/conflicts'],
];

beforeAll(async () => {
  const { buildApp } = await import('../../app.js');
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the resolver in cloud', () => {
  it('registers none of the six paths', () => {
    for (const [method, url] of PATHS) {
      expect({ method, url, registered: app.hasRoute({ method, url }) }).toEqual({
        method,
        url,
        registered: false,
      });
    }
  });

  it('keeps the PR family it sits inside — the mode gate is this feature’s alone', () => {
    // If this went false the test above would pass for the wrong reason: a broken app.ts rather
    // than a deliberately unregistered route family.
    expect(app.hasRoute({ method: 'GET', url: '/api/prs/:id' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/prs/:id/merge' })).toBe(true);
  });

  it('answers a conflicts URL exactly as it answers a typo’d one', async () => {
    const real = await app.inject({ method: 'GET', url: '/api/prs/1/conflicts?session=x' });
    const typo = await app.inject({ method: 'GET', url: '/api/prs/1/no-such-thing' });
    expect(real.statusCode).toBe(typo.statusCode);
    expect(real.json()).toEqual(typo.json());
  });
});
