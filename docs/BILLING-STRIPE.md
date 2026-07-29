# Stripe billing (Payment Link + webhook)

How to wire a real Stripe account to the billing seam. The integration is
deliberately minimal — **no stripe SDK dependency**: a hosted Payment Link for
checkout and one webhook endpoint whose signature is verified with `node:crypto`.
Everything is inert until the two env vars below are set (the webhook replies
`501` unconfigured), and **local mode is unaffected** — a local account is always
fully entitled regardless of plan.

> **⚠️ Only set `STRIPE_PAYMENT_LINK_URL` on a cloud deployment that actually ships
> Pro.** Pro is now cloud-enablable —
> `config.proEnabled = PRO_DISABLED!=='true' && (!isCloud || PRO_CLOUD_ENABLED==='true')` —
> so a cloud image built `--with-pro` and run with `PRO_CLOUD_ENABLED=true` loads
> `@pierre/pro` and serves the SUMMARY tier (`/api/pro/*` routes + capabilities). The
> hazard is a MISMATCH: if the payment link is live on a deployment that does NOT include
> Pro (a plain OSS image, or `PRO_CLOUD_ENABLED` unset), the billing seam still takes
> payment and flips `accounts.plan='pro'`, but `/api/me` intersects the plan with the
> (empty) loaded capabilities — so a paying customer receives **zero Pro features**. Only
> turn the pricing CTA on once the deployed image ships Pro AND `PRO_CLOUD_ENABLED=true`;
> until then leave the env var unset and the CTA degrades to
> `/pricing?checkout=unavailable`.

## How it works

```
 user clicks Upgrade
   └─► GET /api/billing/checkout            (anonymous → 302 /api/auth/login;
         signed-in → 302 Payment Link with ?client_reference_id=<accountId>)
   └─► Stripe-hosted checkout page          (card entry, SCA, tax — all Stripe's)
   └─► POST /api/billing/webhook            (signature-verified, unauthenticated)
         checkout.session.completed         → accounts.plan='pro' when
           payment_status is paid, stores customer id (unpaid async methods wait
           for checkout.session.async_payment_succeeded)
         customer.subscription.updated      → active|trialing → 'pro', else 'free'
         customer.subscription.deleted      → 'free'
```

Entitlement is enforced at two points, both keyed off `accounts.plan`:

- `/api/me` returns `pro: entitledProCapabilities(account)` — the full capability
  set when `account.isLocal || plan !== 'free'`, else all-false (the SPA already
  renders that shape as the plain OSS experience; no component changes needed).
- The cloud auth gate 402s (`{error:'pro required'}`) any `/api/pro/*` request
  from a signed-in free-plan account (`api/plugins/auth.ts`).

## Setup

1. **Create the product + Payment Link** (Stripe Dashboard → Product catalog):
   - Product "Limn Pro", recurring price **$15/month**.
   - Create a **Payment Link** for that price. No special configuration is needed
     for `client_reference_id` — Payment Links accept it as a URL query parameter
     (`?client_reference_id=…`), which is exactly what `GET /api/billing/checkout`
     appends; Stripe echoes it back on `checkout.session.completed`.
2. **Set the env vars** (Railway variables / `.env`):
   - `STRIPE_PAYMENT_LINK_URL` — the Payment Link URL (`https://buy.stripe.com/…`).
   - `STRIPE_WEBHOOK_SECRET` — the endpoint's signing secret (`whsec_…`), from
     step 3. Neither is required by `assertCloudConfig` — billing is optional.
3. **Add the webhook endpoint** (Dashboard → Developers → Webhooks):
   - URL: `https://<your-domain>/api/billing/webhook`
   - Events: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`, `customer.subscription.updated`,
     `customer.subscription.deleted`. (Other event types are 200-acked and
     ignored, so over-subscribing is harmless.)
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

## Testing locally (stripe CLI)

```sh
stripe listen --forward-to localhost:4000/api/billing/webhook
# prints a whsec_… secret — export it before starting the backend:
STRIPE_WEBHOOK_SECRET=whsec_… pnpm dev:backend

stripe trigger checkout.session.completed
```

For an end-to-end run, hit `GET /api/billing/checkout` signed in, pay with the
test card `4242 4242 4242 4242`, and watch `accounts.plan` flip to `pro`
(`client_reference_id` in the forwarded event is your account id).

## How declined payments downgrade

Access is revoked by **subscription status**, not by invoice events: when a
renewal charge is declined, Stripe moves the subscription to `past_due` (then
`canceled`/`unpaid` per your dunning settings), each transition firing
`customer.subscription.updated`. Any status other than `active`/`trialing` sets
`plan='free'`; if the customer later fixes their card, the `active` transition
sets it back to `pro` automatically. `customer.subscription.deleted`
(cancellation) also downgrades immediately.

Notes:

- The webhook **never 500s on an unknown account/customer** — it logs and
  200-acks, because Stripe retries non-2xx responses for days.
- Re-login can't reset a paid plan: the OAuth upsert
  (`upsertCloudAccount`) deliberately excludes `plan`/`stripe_customer_id` from
  its conflict-update set.
- Signature verification is timing-safe HMAC-SHA256 over `<t>.<rawBody>` with a
  5-minute timestamp tolerance (replay protection); the webhook route uses a
  scoped raw-body parser so the rest of the API keeps normal JSON parsing.

## Future direction

The flat $15/mo plan gates the cheap tier (digests, Insights). (My Turn / "FYI" feed
participation is CORE / free on every tier — not part of the paid plan.) The expensive
**advanced-AI features** (AI Analysis, AI Fix, Claude Review — today one
all-or-nothing `PRO_ADVANCED_AI_ENABLED` flag) are the natural candidates for
**metered billing**: the `ai_usage` ledger already records per-account credit
spend server-side, so a usage-based Stripe subscription item (reported via
`usage_records`) can be layered on without new bookkeeping.
