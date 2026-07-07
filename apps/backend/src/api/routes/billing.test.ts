// Billing route tests on a THROWAWAY sqlite DB (the retention.test.ts pattern):
// env is set BEFORE importing config/client (they read env + open the connection
// at module load), so every host module arrives via dynamic import in beforeAll.
//
// Covers: the hand-rolled Stripe signature verifier (valid / bad / stale), the
// pure event→plan mapping, the webhook end-to-end (plan flips on a real Fastify
// instance), the checkout redirect, and — load-bearing — that the raw-body
// content-type parser is ENCAPSULATED to the billing scope (a sibling JSON route
// still gets a parsed object).
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-billing-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.STRIPE_PAYMENT_LINK_URL = 'https://buy.stripe.com/test_abc123';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let eq: any;
let closeDb: (() => Promise<void>) | undefined;
let verifyStripeSignature: (
  rawBody: Buffer | string,
  header: string,
  secret: string,
  nowMs?: number,
) => boolean;
let stripeEventAction: (event: unknown) => any;

const SECRET = 'whsec_test_secret';

function sign(body: string, ts = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

async function accountRow(id: number): Promise<any> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id))
    .execute();
  return rows[0] ?? null;
}

async function postWebhook(body: string, sigHeader?: string): Promise<any> {
  return app.inject({
    method: 'POST',
    url: '/api/billing/webhook',
    headers: {
      'content-type': 'application/json',
      ...(sigHeader ? { 'stripe-signature': sigHeader } : {}),
    },
    body,
  });
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ eq } = await import('drizzle-orm'));
  await runMigrations();

  const billing = await import('./billing.js');
  ({ verifyStripeSignature, stripeEventAction } = billing);

  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  // Fake account context (the real app attaches request.account via the auth
  // plugin) so the checkout redirect can embed the account id.
  app.decorateRequest('account', null);
  app.addHook('onRequest', async (req: any) => {
    req.account = { id: 1, isLocal: true, plan: 'free' };
  });
  // A SIBLING route in the parent scope: proves the billing raw-body parser is
  // encapsulated and normal JSON parsing survives everywhere else.
  app.post('/api/echo', async (req: any) => ({
    bodyType: typeof req.body,
    isBuffer: Buffer.isBuffer(req.body),
    value: req.body,
  }));
  await app.register(billing.billingRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
});

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1"}';

  it('accepts a correctly signed payload', () => {
    expect(verifyStripeSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('accepts when ANY v1 entry matches (secret rotation)', () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(
      verifyStripeSignature(body, `t=${ts},v1=${'0'.repeat(64)},v1=${good}`, SECRET),
    ).toBe(true);
  });

  it('rejects a bad signature / wrong secret / tampered body', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(body, `t=${ts},v1=${'0'.repeat(64)}`, SECRET)).toBe(
      false,
    );
    expect(verifyStripeSignature(body, sign(body), 'whsec_other')).toBe(false);
    expect(verifyStripeSignature('{"id":"evt_2"}', sign(body), SECRET)).toBe(false);
  });

  it('rejects a stale timestamp (> 300s skew, replay protection)', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 301;
    expect(verifyStripeSignature(body, sign(body, staleTs), SECRET)).toBe(false);
    // Same header is fine when "now" is within tolerance of it.
    expect(
      verifyStripeSignature(body, sign(body, staleTs), SECRET, staleTs * 1000),
    ).toBe(true);
  });

  it('rejects malformed headers', () => {
    expect(verifyStripeSignature(body, '', SECRET)).toBe(false);
    expect(verifyStripeSignature(body, 'v1=abc', SECRET)).toBe(false);
    expect(verifyStripeSignature(body, 't=123', SECRET)).toBe(false);
  });
});

describe('stripeEventAction (pure event→plan mapping)', () => {
  it('checkout.session.completed (paid) → pro, with account + customer ids', () => {
    expect(
      stripeEventAction({
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: '42',
            customer: 'cus_9',
            payment_status: 'paid',
          },
        },
      }),
    ).toEqual({ kind: 'checkout_completed', accountId: 42, stripeCustomerId: 'cus_9' });
  });

  it('an UNPAID checkout.session.completed is ignored (delayed payment methods)', () => {
    expect(
      stripeEventAction({
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: '42',
            customer: 'cus_9',
            payment_status: 'unpaid',
          },
        },
      }),
    ).toEqual({ kind: 'ignore' });
  });

  it('checkout.session.async_payment_succeeded grants once the money lands', () => {
    expect(
      stripeEventAction({
        type: 'checkout.session.async_payment_succeeded',
        data: {
          object: {
            client_reference_id: '42',
            customer: 'cus_9',
            payment_status: 'paid',
          },
        },
      }),
    ).toEqual({ kind: 'checkout_completed', accountId: 42, stripeCustomerId: 'cus_9' });
  });

  it('subscription active/trialing → pro; past_due/canceled/unpaid → free', () => {
    const sub = (status: string) =>
      stripeEventAction({
        type: 'customer.subscription.updated',
        data: { object: { customer: 'cus_9', status } },
      });
    expect(sub('active').plan).toBe('pro');
    expect(sub('trialing').plan).toBe('pro');
    for (const s of ['past_due', 'canceled', 'unpaid', 'incomplete_expired']) {
      expect(sub(s).plan).toBe('free');
    }
  });

  it('subscription.deleted → free even if status still reads active', () => {
    expect(
      stripeEventAction({
        type: 'customer.subscription.deleted',
        data: { object: { customer: 'cus_9', status: 'active' } },
      }),
    ).toEqual({ kind: 'subscription_status', customerId: 'cus_9', plan: 'free' });
  });

  it('unknown / malformed events are ignored', () => {
    expect(stripeEventAction({ type: 'invoice.paid', data: { object: {} } })).toEqual({
      kind: 'ignore',
    });
    expect(stripeEventAction(null)).toEqual({ kind: 'ignore' });
    expect(stripeEventAction({ type: 'checkout.session.completed' })).toEqual({
      kind: 'ignore',
    });
  });
});

describe('POST /api/billing/webhook (end-to-end on a throwaway DB)', () => {
  it('rejects a missing/bad signature with 400', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed' });
    expect((await postWebhook(body)).statusCode).toBe(400);
    expect(
      (await postWebhook(body, `t=${Math.floor(Date.now() / 1000)},v1=bad`)).statusCode,
    ).toBe(400);
  });

  it('checkout.session.completed flips the account to pro + stores the customer id', async () => {
    // Account id 1 is seeded by migration 0008 with plan 'free' (column default).
    expect((await accountRow(1)).plan).toBe('free');
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: '1',
          customer: 'cus_test_1',
          payment_status: 'paid',
        },
      },
    });
    const res = await postWebhook(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    const row = await accountRow(1);
    expect(row.plan).toBe('pro');
    expect(row.stripeCustomerId).toBe('cus_test_1');
  });

  it('a non-active subscription status revokes access (plan → free)', async () => {
    const body = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: { customer: 'cus_test_1', status: 'past_due' } },
    });
    expect((await postWebhook(body, sign(body))).statusCode).toBe(200);
    expect((await accountRow(1)).plan).toBe('free');
  });

  it('an active subscription status restores access (plan → pro)', async () => {
    const body = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: { customer: 'cus_test_1', status: 'active' } },
    });
    expect((await postWebhook(body, sign(body))).statusCode).toBe(200);
    expect((await accountRow(1)).plan).toBe('pro');
  });

  it('subscription.deleted downgrades to free', async () => {
    const body = JSON.stringify({
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_test_1', status: 'active' } },
    });
    expect((await postWebhook(body, sign(body))).statusCode).toBe(200);
    expect((await accountRow(1)).plan).toBe('free');
  });

  it('a checkout for an account already bound to a DIFFERENT customer keeps the existing binding', async () => {
    // Account 1 is bound to cus_test_1 by the earlier checkout test. A forged
    // checkout carrying someone else's customer id must not re-bind it.
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: '1',
          customer: 'cus_attacker',
          payment_status: 'paid',
        },
      },
    });
    expect((await postWebhook(body, sign(body))).statusCode).toBe(200);
    const row = await accountRow(1);
    expect(row.plan).toBe('pro');
    expect(row.stripeCustomerId).toBe('cus_test_1');
  });

  it('unknown event types and unknown accounts are 200-acked (Stripe retries non-2xx)', async () => {
    const unknownType = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
    expect((await postWebhook(unknownType, sign(unknownType))).statusCode).toBe(200);
    const unknownAccount = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: '999999',
          customer: 'cus_x',
          payment_status: 'paid',
        },
      },
    });
    expect((await postWebhook(unknownAccount, sign(unknownAccount))).statusCode).toBe(
      200,
    );
    const unknownCustomer = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: { customer: 'cus_never_seen', status: 'active' } },
    });
    expect((await postWebhook(unknownCustomer, sign(unknownCustomer))).statusCode).toBe(
      200,
    );
  });
});

describe('raw-body parser encapsulation + checkout redirect', () => {
  it('a sibling route still gets normally-parsed JSON (parser is scoped to billing)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      bodyType: 'object',
      isBuffer: false,
      value: { hello: 'world' },
    });
  });

  it('GET /api/billing/checkout 302s to the Payment Link with client_reference_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/billing/checkout' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      'https://buy.stripe.com/test_abc123?client_reference_id=1',
    );
  });
});
