// THE CLOUD POSTURE: the merge-conflict resolver's six routes EXIST when `DEPLOYMENT_MODE=cloud`,
// and every one of them is behind the cloud auth gate and the same per-tenant ownership check the
// local build uses.
//
// ⚠ THIS FILE USED TO ASSERT THE OPPOSITE — that all six 404 in cloud. It was INVERTED rather than
// deleted, because it is the tenancy proof for this family and the feature shipping in cloud is
// exactly when that proof has to get stronger. What it pins now:
//
//   1. ALL SIX PATHS ARE REGISTERED. The gate was registration itself, so its removal is a fact
//      about the route table and nothing else.
//   2. THE CLOUD AUTH GATE IS IN FRONT OF EVERY ONE. Unauthenticated, all six answer 401 — nobody
//      without a session can reach a clone, a fetch or a push. `/api/health` answering 200 in the
//      same run is the control: the gate refuses these six, not everything.
//   3. ANOTHER TENANT'S PR IS A 404 ON ALL SIX. Not 403, not an empty session: a 404, so the family
//      is not an existence oracle.
//   4. NO PUSH RIGHTS IS A 403 ON ALL SIX. The resolver ends in a push; a reader who cannot push
//      must not be able to start one, or to read a repository's source through the file route.
//
// Its own file because `config` is read at import time (the landing-routes.test.ts pattern) — one
// module registry is one deployment mode.
//
// ⚠ 3 AND 4 RUN ON A BARE FASTIFY, NOT `buildApp()`. Cloud means Postgres, and there is no
// Postgres here; a sealed session cookie would also have to be minted to get past the gate proved
// in 2. So the ownership LOOKUP is stubbed and what these two assert is the thing the routes
// themselves own: that every one of the six calls it, passes the CALLER'S account id, and refuses
// exactly as the table says. That the lookup itself is account-scoped is proved by
// `conflicts.test.ts` on a real sqlite DB and by `verify:isolation` — this file must not restate
// it, and must not pretend to.
import { rmSync } from 'node:fs';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-conflicts-cloud-test.sqlite';
process.env.DEPLOYMENT_MODE = 'cloud';
process.env.DISABLE_SCHEDULER = 'true';
process.env.SESSION_SECRET = 'a'.repeat(48);
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.APP_BASE_URL = 'https://app.example.com';
process.env.DATABASE_URL = 'postgres://pierre:pierre@127.0.0.1:5432/pierre_never_connected';

// The one DB call the six routes make. Spread the real module: every other route file in the app
// imports from here, and `WRITE_PERMISSIONS` — which `requireWritablePr` reads — must stay real or
// the 403 assertion becomes a test of the stub.
const getPrWriteContext =
  vi.fn<(prId: number, accountId: number) => Promise<Record<string, unknown> | null>>();
vi.mock('../../db/queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPrWriteContext: (prId: number, accountId: number) => getPrWriteContext(prId, accountId),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let bare: any;

/** The account the bare app presents. Mutated per test; there is one request at a time. */
let callerAccountId = 7;

const OWNER_ACCOUNT = 7;
const OTHER_ACCOUNT = 99;
const PR_ID = 41;

/** A well-formed commit body. It has to satisfy the route's JSON schema or validation refuses
 *  before the handler runs — and it is the handler's refusal this file is about. */
const COMMIT_BODY = {
  sessionId: 'session-under-test',
  expectedHeadSha: 'aaaa',
  expectedBaseSha: 'bbbb',
  modelHash: 'cccc',
  strategy: 'merge',
  target: { kind: 'pr_branch' },
  files: [],
};

/** The six, as `app.inject` arguments. One list, used by every sweep below. */
function requests(prId: number): Array<{ label: string; args: Record<string, unknown> }> {
  const session = 'session-under-test';
  const q = `?session=${session}`;
  return [
    { label: 'open', args: { method: 'POST', url: `/api/prs/${prId}/conflicts`, payload: {} } },
    { label: 'manifest', args: { method: 'GET', url: `/api/prs/${prId}/conflicts${q}` } },
    { label: 'stream', args: { method: 'GET', url: `/api/prs/${prId}/conflicts/stream${q}` } },
    { label: 'file', args: { method: 'GET', url: `/api/prs/${prId}/conflicts/files/0${q}` } },
    {
      label: 'commit',
      args: { method: 'POST', url: `/api/prs/${prId}/conflicts/commit`, payload: COMMIT_BODY },
    },
    { label: 'close', args: { method: 'DELETE', url: `/api/prs/${prId}/conflicts${q}` } },
  ];
}

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

  const { conflictRoutes } = await import('./conflicts.js');
  bare = Fastify();
  bare.decorateRequest('account', null);
  bare.addHook('onRequest', async (req: any) => {
    // Everything `accountIdOf` reads. Standing in for a signed-in cloud session, which needs a
    // sealed cookie and a Postgres row — both proved elsewhere, neither available here.
    req.account = { id: callerAccountId, isLocal: false };
  });
  await bare.register(conflictRoutes);
  await bare.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await bare?.close();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  callerAccountId = OWNER_ACCOUNT;
  getPrWriteContext.mockReset();
});

describe('the resolver in cloud', () => {
  it('puts its clones on the EPHEMERAL filesystem, not $HOME', async () => {
    const { config } = await import('../../config.js');
    // ⚠ THE CONTAINER RUNS AS AN UNPRIVILEGED USER AND ITS DISK DOES NOT SURVIVE A DEPLOY. That
    // is the decision, not a limitation — see docs/DEPLOY-RAILWAY.md for why there is no Railway
    // volume. TWO levels, because `tightenCloneRoot()` chmods the parent too and `/tmp` is not
    // ours to chmod.
    expect(config.cloneDir).toBe('/tmp/pierre-review/clones');
    // 1 GiB against a measured 111 MB worst case per clone: room for roughly nine of the worst,
    // on a disk shared with everything else the process writes.
    expect(config.cloneCacheMaxBytes).toBe(1024 * 1024 * 1024);
  });

  it('registers all six paths', () => {
    for (const [method, url] of PATHS) {
      expect({ method, url, registered: app.hasRoute({ method, url }) }).toEqual({
        method,
        url,
        registered: true,
      });
    }
  });

  it('keeps the PR family it sits inside — this is a route table, not a special case', () => {
    expect(app.hasRoute({ method: 'GET', url: '/api/prs/:id' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/prs/:id/merge' })).toBe(true);
  });

  it('puts the cloud auth gate in front of every one of them', async () => {
    for (const { label, args } of requests(PR_ID)) {
      const res = await app.inject(args);
      expect({ label, status: res.statusCode }).toEqual({ label, status: 401 });
    }
    // The control: the gate refuses these six, not every route in the app. Without this the
    // assertion above would pass just as well on a build that 401s everything.
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('answers 404 on all six for a pull request that is not the caller’s', async () => {
    // Exactly what the real lookup does: scoped by account, so another tenant's id resolves to
    // nothing. NOT 403 — a 403 would confirm the pull request exists.
    getPrWriteContext.mockImplementation(async (prId, accountId) =>
      accountId === OWNER_ACCOUNT && prId === PR_ID
        ? { prId, owner: 'acme', name: 'web', number: 1, viewerPermission: 'WRITE' }
        : null,
    );
    callerAccountId = OTHER_ACCOUNT;

    for (const { label, args } of requests(PR_ID)) {
      const res = await bare.inject(args);
      expect({ label, status: res.statusCode, error: res.json().error }).toEqual({
        label,
        status: 404,
        error: 'NotFound',
      });
    }
    // Every route passed the CALLER'S id, not the owner's. A route that looked a PR up
    // unscoped would answer 404 here too, for the wrong reason.
    for (const call of getPrWriteContext.mock.calls) {
      expect(call[1]).toBe(OTHER_ACCOUNT);
    }
    expect(getPrWriteContext).toHaveBeenCalledTimes(6);
  });

  it('answers 403 on all six without push rights', async () => {
    getPrWriteContext.mockImplementation(async (prId) => ({
      prId,
      owner: 'acme',
      name: 'web',
      number: 1,
      // Read access to the repository, which is not permission to push a resolved commit to it.
      viewerPermission: 'READ',
    }));

    for (const { label, args } of requests(PR_ID)) {
      const res = await bare.inject(args);
      expect({ label, status: res.statusCode, error: res.json().error }).toEqual({
        label,
        status: 403,
        error: 'NotPermitted',
      });
    }
  });
});
