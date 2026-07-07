// Stripe billing seam ("carve the path"): a checkout redirect + the webhook that
// flips `accounts.plan`. Deliberately dependency-free — signature verification is
// hand-rolled with node:crypto (no stripe SDK), and the whole feature is inert
// until STRIPE_PAYMENT_LINK_URL / STRIPE_WEBHOOK_SECRET are set (the webhook
// replies 501 unconfigured). Registered unconditionally in app.ts, both modes.
//
// Entitlement flows from `accounts.plan`: /api/me intersects the capability
// singleton with the plan (pro/contract.ts entitledProCapabilities) and the cloud
// auth gate 402s free-plan /api/pro/* requests (api/plugins/auth.ts). Local
// accounts are always fully entitled — this file never affects local behavior.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import {
  getAccountById,
  getAccountByStripeCustomerId,
  setAccountPlan,
  type AccountPlan,
} from '../../auth/account.js';

// Stripe's default signature tolerance: reject events older/newer than 5 minutes
// (replay protection).
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Verify a Stripe webhook signature (the `stripe-signature` header) without the
 * stripe SDK. Header format: `t=<unix-seconds>,v1=<hex>[,v1=<hex>…]` (multiple
 * v1 entries appear during secret rotation). The signed payload is
 * `<t>.<rawBody>`; the signature is HMAC-SHA256(secret) over it, hex-encoded.
 * Compared timing-safely against every v1; the timestamp must be within
 * STRIPE_SIGNATURE_TOLERANCE_SEC of `nowMs`.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  let ts: number | null = null;
  const v1s: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!value) continue;
    if (key === 't') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) ts = n;
    } else if (key === 'v1') {
      v1s.push(value);
    }
  }
  if (ts == null || v1s.length === 0) return false;
  if (Math.abs(nowMs / 1000 - ts) > STRIPE_SIGNATURE_TOLERANCE_SEC) return false;
  const expected = createHmac('sha256', secret)
    .update(`${ts}.`)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  return v1s.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf-8');
    return (
      sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)
    );
  });
}

// What a verified Stripe event means for `accounts.plan` — factored pure so the
// mapping is unit-testable without a DB or a Fastify instance.
export type StripeEventAction =
  | { kind: 'ignore' }
  | {
      // checkout.session.completed: the buyer just paid. `accountId` comes from
      // client_reference_id (appended by GET /api/billing/checkout); the customer
      // id is captured so later subscription webhooks can resolve the account.
      kind: 'checkout_completed';
      accountId: number | null;
      stripeCustomerId: string | null;
    }
  | {
      // customer.subscription.updated/deleted: the subscription's current status
      // decides the plan. Declined/failed payments surface here as past_due /
      // canceled / unpaid — that's how access is revoked.
      kind: 'subscription_status';
      customerId: string | null;
      plan: AccountPlan;
    };

// Stripe `customer` fields are a string id or an expanded object with `.id`.
function customerIdOf(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string'
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

/** Map a parsed Stripe event to the plan action it implies. Pure. */
export function stripeEventAction(event: unknown): StripeEventAction {
  if (event == null || typeof event !== 'object') return { kind: 'ignore' };
  const { type, data } = event as { type?: unknown; data?: { object?: unknown } };
  if (typeof type !== 'string') return { kind: 'ignore' };
  const obj = (data?.object ?? null) as Record<string, unknown> | null;
  if (obj == null || typeof obj !== 'object') return { kind: 'ignore' };

  if (
    type === 'checkout.session.completed' ||
    type === 'checkout.session.async_payment_succeeded'
  ) {
    // Delayed-notification methods (SEPA, ACH…) fire `completed` with
    // payment_status 'unpaid' and confirm later via async_payment_succeeded —
    // only grant once the money actually landed. `no_payment_required` covers
    // trials.
    const paid =
      obj['payment_status'] === 'paid' ||
      obj['payment_status'] === 'no_payment_required';
    if (!paid) return { kind: 'ignore' };
    const ref = obj['client_reference_id'];
    const accountId =
      typeof ref === 'string' && /^\d+$/.test(ref)
        ? Number.parseInt(ref, 10)
        : typeof ref === 'number' && Number.isInteger(ref)
          ? ref
          : null;
    return {
      kind: 'checkout_completed',
      accountId,
      stripeCustomerId: customerIdOf(obj['customer']),
    };
  }

  if (
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  ) {
    const status = obj['status'];
    const active =
      type !== 'customer.subscription.deleted' &&
      (status === 'active' || status === 'trialing');
    return {
      kind: 'subscription_status',
      customerId: customerIdOf(obj['customer']),
      plan: active ? 'pro' : 'free',
    };
  }

  return { kind: 'ignore' };
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // Redirect the signed-in user to the Stripe Payment Link, tagging the checkout
  // with their account id (client_reference_id rides the Payment Link URL and
  // comes back on checkout.session.completed). Exempted from the cloud auth gate
  // (it's a plain browser navigation from the public pricing page), so it must
  // handle anonymous visitors itself: bounce them to sign-in rather than a 401.
  app.get('/api/billing/checkout', async (req, reply) => {
    if (!config.stripePaymentLinkUrl) {
      return reply.redirect('/pricing?checkout=unavailable', 302);
    }
    if (!req.account) {
      return reply.redirect('/api/auth/login', 302);
    }
    const url = new URL(config.stripePaymentLinkUrl);
    url.searchParams.set('client_reference_id', String(req.account.id));
    return reply.redirect(url.toString(), 302);
  });

  // The webhook needs the RAW request body (the signature signs the exact bytes).
  // Fastify content-type parsers are ENCAPSULATED, so registering the buffer
  // parser inside this nested plugin scope affects ONLY the routes declared here
  // — the rest of the API keeps normal JSON parsing (proven by billing.test.ts).
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );

    // Stripe posts unauthenticated (exempted from the auth gate); authenticity
    // comes from the signature. Never 500 on an unknown account — Stripe retries
    // on non-2xx, and an unknown account is a data mismatch, not a server fault.
    scope.post('/api/billing/webhook', async (req, reply) => {
      if (!config.stripeWebhookSecret) {
        return reply.code(501).send({ error: 'billing not configured' });
      }
      const raw = req.body;
      if (!Buffer.isBuffer(raw)) {
        return reply.code(400).send({ error: 'expected a JSON body' });
      }
      const sig = req.headers['stripe-signature'];
      if (
        typeof sig !== 'string' ||
        !verifyStripeSignature(raw, sig, config.stripeWebhookSecret)
      ) {
        return reply.code(400).send({ error: 'invalid signature' });
      }

      let event: unknown;
      try {
        event = JSON.parse(raw.toString('utf-8'));
      } catch {
        return reply.code(400).send({ error: 'invalid JSON' });
      }

      const action = stripeEventAction(event);
      if (action.kind === 'checkout_completed') {
        const account =
          action.accountId != null ? await getAccountById(action.accountId) : null;
        if (account) {
          // client_reference_id is attacker-influencable (it rides the public
          // Payment Link URL), so never let a new checkout re-bind an account
          // that already has a DIFFERENT Stripe customer — that would orphan
          // the original subscription's webhooks.
          const rebind =
            account.stripeCustomerId != null &&
            action.stripeCustomerId != null &&
            account.stripeCustomerId !== action.stripeCustomerId;
          await setAccountPlan(
            account.id,
            'pro',
            rebind ? undefined : action.stripeCustomerId,
          );
          if (rebind) {
            req.log.warn(
              {
                accountId: account.id,
                existingCustomerId: account.stripeCustomerId,
                newCustomerId: action.stripeCustomerId,
              },
              'stripe checkout for an account already bound to a different customer — kept the existing binding',
            );
          }
          req.log.info(
            { accountId: account.id },
            'stripe checkout completed — plan set to pro',
          );
        } else {
          req.log.warn(
            { clientReferenceId: action.accountId },
            'stripe checkout completed for unknown account — ignored',
          );
        }
      } else if (action.kind === 'subscription_status') {
        const account = action.customerId
          ? await getAccountByStripeCustomerId(action.customerId)
          : null;
        if (account) {
          await setAccountPlan(account.id, action.plan);
          req.log.info(
            { accountId: account.id, plan: action.plan },
            'stripe subscription status — plan updated',
          );
        } else {
          req.log.warn(
            { customerId: action.customerId },
            'stripe subscription event for unknown customer — ignored',
          );
        }
      }
      return { received: true };
    });
  });
}
