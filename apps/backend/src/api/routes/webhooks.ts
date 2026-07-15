// GitHub App webhook receiver — real-time sync Phase 1 (see docs/REALTIME-SYNC.md).
//
// A GitHub App has ONE webhook URL that receives events for every installation, so this
// single route serves every tenant. On a PR-affecting event it resolves which watched
// repos the change touches and fires a debounced, targeted single-PR sync (Phase 0's
// enqueuePrSync) — near-real-time freshness at ~1 GraphQL point per change, no window
// re-walk. It is ADDITIVE: the periodic poll (SYNC.md) stays as the backstop for dropped
// deliveries and for accounts signed in via the OAuth App (no App install → no webhooks).
//
// Structure mirrors the Stripe webhook (api/routes/billing.ts): authenticity is the
// signature, not a session (so the route is exempted from the cloud auth gate); the raw
// body is read via an ENCAPSULATED content-type parser so the rest of the API keeps
// normal JSON parsing. Registered in both modes; inert until GITHUB_APP_WEBHOOK_SECRET is
// set (replies 501 unconfigured).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/client.js';
import { enqueuePrSync } from '../../sync/sync-one-pr.js';
import type { Logger } from '../../sync/sync-repo.js';

const { repos } = schema;

/**
 * Verify a GitHub webhook signature (the `X-Hub-Signature-256` header) without a
 * dependency. Format: `sha256=<hex>`, where the hex is HMAC-SHA256(secret) over the raw
 * request bytes. Compared timing-safely. Pure so it's unit-testable without Fastify.
 */
export function verifyGithubSignature(
  rawBody: Buffer | string,
  header: string,
  secret: string,
): boolean {
  const prefix = 'sha256=';
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(provided, 'utf-8');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  return (
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf)
  );
}

// The repo + PR numbers a webhook event targets. Null when the event carries no PR to
// sync (a ping, a push, a plain-issue comment, an unhandled event type, or a payload
// missing its repository).
export interface WebhookPrTarget {
  owner: string;
  name: string;
  prNumbers: number[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

// A positive integer `number` field off an object (a PR reference), else null.
function prNumberOf(v: unknown): number | null {
  const n = asRecord(v)?.['number'];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Map a GitHub webhook (event type + payload) to the repo + PR numbers it should refresh.
 * Pure — no DB, no Fastify — so the per-event extraction is unit-testable. Every handled
 * event carries `repository.owner.login` + `repository.name`; the PR number(s) live in a
 * per-event slot. Returns null when there's nothing to sync.
 */
export function extractPrTargets(
  eventType: string,
  payload: unknown,
): WebhookPrTarget | null {
  const p = asRecord(payload);
  if (!p) return null;
  const repo = asRecord(p['repository']);
  const owner = asRecord(repo?.['owner'])?.['login'];
  const name = repo?.['name'];
  if (typeof owner !== 'string' || typeof name !== 'string') return null;

  const numbers = new Set<number>();
  const addNum = (v: unknown): void => {
    const n = prNumberOf(v);
    if (n != null) numbers.add(n);
  };
  const addArray = (v: unknown): void => {
    if (Array.isArray(v)) for (const e of v) addNum(e);
  };

  switch (eventType) {
    // All the PR-scoped events carry the PR directly.
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
    case 'pull_request_review_thread':
      addNum(p['pull_request']);
      break;
    // issue_comment also fires on plain issues; only PRs carry `issue.pull_request`.
    case 'issue_comment': {
      const issue = asRecord(p['issue']);
      if (issue && issue['pull_request'] != null) addNum(issue);
      break;
    }
    // CI events carry the associated PRs (same-repo only) — this is how a check
    // finishing (which never bumps a PR's updatedAt) drives a refresh.
    case 'check_run':
      addArray(asRecord(p['check_run'])?.['pull_requests']);
      break;
    case 'check_suite':
      addArray(asRecord(p['check_suite'])?.['pull_requests']);
      break;
    // ping / push / installation / anything else → no targeted PR (a push to a PR's head
    // arrives separately as pull_request `synchronize`, which the case above handles).
    default:
      return null;
  }

  if (numbers.size === 0) return null;
  return { owner, name, prNumbers: [...numbers] };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // A STABLE logger for the detached (debounced) syncs — the request-scoped req.log is
  // gone by the time enqueuePrSync's timer fires. Mirrors scheduler.ts's adapter.
  const log: Logger = {
    info: (m, ...a) => app.log.info(a.length ? { a } : {}, m),
    warn: (m, ...a) => app.log.warn(a.length ? { a } : {}, m),
    error: (m, ...a) => app.log.error(a.length ? { a } : {}, m),
  };

  // The signature signs the exact bytes, so this route needs the RAW body. Fastify's
  // content-type parsers are ENCAPSULATED, so registering the buffer parser in this
  // nested scope affects ONLY /api/webhooks/github — the rest of the API keeps normal
  // JSON parsing (proven by webhooks.test.ts's sibling-route case).
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );

    // GitHub posts unauthenticated (exempted from the auth gate); authenticity is the
    // signature. Never 500 on a data mismatch — GitHub retries non-2xx.
    scope.post('/api/webhooks/github', async (req, reply) => {
      if (!config.githubAppWebhookSecret) {
        return reply.code(501).send({ error: 'github webhooks not configured' });
      }
      const raw = req.body;
      if (!Buffer.isBuffer(raw)) {
        return reply.code(400).send({ error: 'expected a JSON body' });
      }
      const sig = req.headers['x-hub-signature-256'];
      if (
        typeof sig !== 'string' ||
        !verifyGithubSignature(raw, sig, config.githubAppWebhookSecret)
      ) {
        return reply.code(401).send({ error: 'invalid signature' });
      }
      const eventType = req.headers['x-github-event'];
      if (typeof eventType !== 'string') {
        return reply.code(400).send({ error: 'missing X-GitHub-Event' });
      }
      // GitHub pings a newly-configured webhook once — ack it.
      if (eventType === 'ping') return { received: true, queued: 0 };

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf-8'));
      } catch {
        return reply.code(400).send({ error: 'invalid JSON' });
      }

      const target = extractPrTargets(eventType, payload);
      if (!target) return { received: true, queued: 0 };

      // Route by (owner, name) across ALL accounts watching this repo. `repos` is keyed
      // (accountId, owner, name), so one webhook fans out to every tenant's copy — each
      // synced with ITS OWN token inside syncOnePr (isolation is structural). No
      // installation→account table is needed.
      const rows = await db
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.owner, target.owner), eq(repos.name, target.name)))
        .execute();

      let queued = 0;
      for (const row of rows) {
        for (const prNumber of target.prNumbers) {
          // Debounced + coalesced + reservation-guarded: a burst for one PR collapses to
          // a single targeted sync (Phase 0). Fire-and-forget; syncOnePr swallows errors.
          enqueuePrSync(row.id, prNumber, log);
          queued += 1;
        }
      }
      if (queued > 0) {
        req.log.info(
          {
            repo: `${target.owner}/${target.name}`,
            event: eventType,
            prs: target.prNumbers,
            watchers: rows.length,
          },
          'github webhook → queued targeted sync',
        );
      }
      return { received: true, queued };
    });
  });
}
