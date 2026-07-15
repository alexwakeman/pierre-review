// GitHub webhook route tests on a THROWAWAY sqlite DB (the billing.test.ts pattern):
// env is set BEFORE importing config/client (they read env + open the connection at
// module load), so every host module arrives via dynamic import in beforeAll.
//
// Covers: the hand-rolled HMAC verifier, the pure event→(repo, PR numbers) extraction,
// the webhook end-to-end (a real Fastify instance routes a signed event to the matching
// watched repos and reports how many targeted syncs it queued), and — load-bearing —
// that the raw-body content-type parser is ENCAPSULATED to the webhook scope.
//
// WEBHOOK_DEBOUNCE_MS is set very high so enqueuePrSync's timers never fire during the
// suite (no real GitHub fetch); afterAll clears them.
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-webhooks-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.GITHUB_APP_WEBHOOK_SECRET = 'whsec_gh_test';
process.env.WEBHOOK_DEBOUNCE_MS = '600000';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let resetTargetedSyncState: () => void;
let verifyGithubSignature: (
  rawBody: Buffer | string,
  header: string,
  secret: string,
) => boolean;
let extractPrTargets: (eventType: string, payload: unknown) => any;

const SECRET = 'whsec_gh_test';

// GitHub signs the raw body: `sha256=` + HMAC-SHA256(secret, body) hex.
function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

async function postWebhook(
  event: string,
  body: string,
  sigHeader?: string,
): Promise<any> {
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      ...(sigHeader ? { 'x-hub-signature-256': sigHeader } : {}),
    },
    body,
  });
}

// Signs + posts a well-formed event in one go.
async function deliver(event: string, payload: unknown): Promise<any> {
  const body = JSON.stringify(payload);
  return postWebhook(event, body, sign(body));
}

// A repository payload block for the seeded watched repo (acme/api).
const acmeRepo = { repository: { name: 'api', owner: { login: 'acme' } } };

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();

  const webhooks = await import('./webhooks.js');
  ({ verifyGithubSignature, extractPrTargets } = webhooks);
  ({ __resetTargetedSyncState: resetTargetedSyncState } = await import(
    '../../sync/sync-one-pr.js'
  ));

  // Seed a watched repo owned by the migration-seeded local account (id 1).
  await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_acme_api' })
    .execute();

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  // A SIBLING route in the parent scope proves the webhook raw-body parser is
  // encapsulated and normal JSON parsing survives everywhere else.
  app.post('/api/echo', async (req: any) => ({
    isBuffer: Buffer.isBuffer(req.body),
    value: req.body,
  }));
  await app.register(webhooks.webhookRoutes);
  await app.ready();
});

afterAll(async () => {
  resetTargetedSyncState?.();
  await app?.close();
  await closeDb?.();
});

describe('verifyGithubSignature', () => {
  const body = '{"action":"opened"}';

  it('accepts a correctly signed payload', () => {
    expect(verifyGithubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a wrong secret / tampered body / bad hex', () => {
    expect(verifyGithubSignature(body, sign(body), 'other')).toBe(false);
    expect(verifyGithubSignature('{"action":"closed"}', sign(body), SECRET)).toBe(false);
    expect(verifyGithubSignature(body, `sha256=${'0'.repeat(64)}`, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix / empty', () => {
    const raw = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyGithubSignature(body, raw, SECRET)).toBe(false);
    expect(verifyGithubSignature(body, '', SECRET)).toBe(false);
  });
});

describe('extractPrTargets (pure event → repo + PR numbers)', () => {
  it('pull_request / review / review_comment / review_thread → the PR number', () => {
    for (const event of [
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'pull_request_review_thread',
    ]) {
      expect(extractPrTargets(event, { ...acmeRepo, pull_request: { number: 7 } })).toEqual(
        { owner: 'acme', name: 'api', prNumbers: [7] },
      );
    }
  });

  it('issue_comment on a PR → the number; on a plain issue → null', () => {
    expect(
      extractPrTargets('issue_comment', {
        ...acmeRepo,
        issue: { number: 9, pull_request: { url: 'x' } },
      }),
    ).toEqual({ owner: 'acme', name: 'api', prNumbers: [9] });
    expect(
      extractPrTargets('issue_comment', { ...acmeRepo, issue: { number: 9 } }),
    ).toBeNull();
  });

  it('check_run / check_suite → each associated PR number (deduped)', () => {
    expect(
      extractPrTargets('check_run', {
        ...acmeRepo,
        check_run: { pull_requests: [{ number: 3 }, { number: 4 }, { number: 3 }] },
      }),
    ).toEqual({ owner: 'acme', name: 'api', prNumbers: [3, 4] });
    expect(
      extractPrTargets('check_suite', {
        ...acmeRepo,
        check_suite: { pull_requests: [{ number: 5 }] },
      }),
    ).toEqual({ owner: 'acme', name: 'api', prNumbers: [5] });
  });

  it('push / ping / unknown events and missing repository → null', () => {
    expect(extractPrTargets('push', { ...acmeRepo, ref: 'refs/heads/main' })).toBeNull();
    expect(extractPrTargets('ping', { ...acmeRepo, zen: 'hi' })).toBeNull();
    expect(extractPrTargets('star', acmeRepo)).toBeNull();
    expect(extractPrTargets('pull_request', { pull_request: { number: 7 } })).toBeNull();
    expect(extractPrTargets('check_run', { ...acmeRepo, check_run: { pull_requests: [] } })).toBeNull();
  });
});

describe('POST /api/webhooks/github (end-to-end on a throwaway DB)', () => {
  it('rejects a missing / bad signature with 401', async () => {
    const body = JSON.stringify({ ...acmeRepo, pull_request: { number: 7 } });
    expect((await postWebhook('pull_request', body)).statusCode).toBe(401);
    expect(
      (await postWebhook('pull_request', body, `sha256=${'0'.repeat(64)}`)).statusCode,
    ).toBe(401);
  });

  it('acks a ping without queuing anything', async () => {
    const res = await deliver('ping', { ...acmeRepo, zen: 'Design for failure.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, queued: 0 });
  });

  it('queues a targeted sync for a watched repo', async () => {
    const res = await deliver('pull_request', {
      ...acmeRepo,
      action: 'synchronize',
      pull_request: { number: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, queued: 1 });
  });

  it('queues nothing for an UNwatched repo', async () => {
    const res = await deliver('pull_request', {
      repository: { name: 'unwatched', owner: { login: 'someone' } },
      pull_request: { number: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, queued: 0 });
  });

  it('a check_suite with two PRs queues one sync per PR (× watchers)', async () => {
    const res = await deliver('check_suite', {
      ...acmeRepo,
      check_suite: { pull_requests: [{ number: 7 }, { number: 8 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, queued: 2 });
  });

  it('acks an unhandled event type without queuing', async () => {
    const res = await deliver('star', acmeRepo);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, queued: 0 });
  });
});

describe('raw-body parser encapsulation', () => {
  it('a sibling route still gets normally-parsed JSON (parser is scoped to the webhook)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isBuffer: false, value: { hello: 'world' } });
  });
});
