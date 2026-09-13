// The public contact form: POST /api/contact, delivered to a Slack incoming webhook.
//
// WHY SLACK AND NOT EMAIL. A contact form's job is to make sure a message ARRIVES.
// Email is the medium with the worst odds of that: it bounces, it lands in spam, and
// it needs SPF/DKIM/DMARC on the domain plus a transactional provider before the first
// message even has a chance. A webhook POST either returns 2xx or throws, and the
// failure is visible in this process's logs at the moment it happens. There is also
// precedent and a working shape already in the repo — the Pro plugin's per-workspace
// digest delivery (packages/pro/src/slack/) — though core cannot import from the
// plugin, so the URL validation below is a deliberate small copy rather than a shared
// helper. Email can be added later as a SECOND sink; it should never be the only one.
//
// ⚠ NO NEW DEPENDENCY, AND THAT IS A CONSTRAINT RATHER THAN A PREFERENCE.
// scripts/build-release.mjs generates release/package.json from a CURATED dependency
// list, so an SDK here ships to every `npx pierre-review` install for the sake of a
// hosted-only marketing page. Node ≥20's global fetch is the whole client.
//
// ---- Deciding a submission is genuine ----
//
// Three layers, none of which needs a third party, a script tag or a CSP change (the
// landing's CSP is `default-src 'self'` with `frame-src` absent entirely — a Turnstile
// or reCAPTCHA widget would need `script-src` AND `frame-src` widened, plus a line in
// the privacy policy, which is a decision worth taking deliberately rather than as a
// side effect of shipping a form):
//
//   1. A HONEYPOT field. `website` is rendered, labelled and reachable in the DOM, and
//      hidden from sighted users by CSS + aria-hidden + tabindex=-1. A person never
//      fills it; a form-filling bot fills every input it finds. A filled honeypot is
//      answered with 200 and DROPPED — never a 400, because an error tells whoever is
//      running the bot exactly which field gave them away.
//
//   2. A SIGNED TICKET with a minimum fill time. GET /api/contact/ticket returns
//      `<issuedAtMs>.<hmac>`; the POST verifies the signature and requires the age to
//      sit between MIN_FILL_MS and MAX_TICKET_MS. This is the layer that a client-sent
//      "elapsed" number cannot be: the timestamp is signed by this server, so a bot
//      cannot forge an age, and to get a valid one it has to make a second request and
//      then WAIT. Stateless on purpose — no store, no replay table. A ticket is
//      therefore reusable within its window, which the rate limit below bounds.
//
//   3. A RATE LIMIT. The `contact` tier in api/plugins/rate-limit.ts, keyed by IP
//      because this route is deliberately anonymous. Five an hour.
//
// A determined human will still get a message through, which is correct — the target
// is automated submission volume, not a wall.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';

// ---------------------------------------------------------------------------
// The ticket
// ---------------------------------------------------------------------------

/** A person needs longer than this to write a message. Below it, it was not typed. */
export const MIN_FILL_MS = 3_000;
/** Past this the ticket is stale — a page left open, or one harvested days ago. */
export const MAX_TICKET_MS = 6 * 60 * 60 * 1000;

// The signing key. SESSION_SECRET where there is one (cloud, where this form actually
// runs), otherwise a per-process random — which means a restart invalidates every
// outstanding ticket. That is acceptable and better than a constant: the failure mode
// is one visitor being asked to reload, and the alternative is a key an attacker can
// read out of the source.
//
// Derived rather than used directly so this never shares key material with the session
// cookie: the same secret signing two different things is how one forgery becomes two.
const TICKET_KEY = createHmac('sha256', config.sessionSecret || randomBytes(32))
  .update('pierre:contact-ticket:v1')
  .digest();

function sign(issuedAtMs: number): string {
  return createHmac('sha256', TICKET_KEY).update(String(issuedAtMs)).digest('hex');
}

/** Mint a ticket for a form that is being opened now. */
export function issueTicket(nowMs: number = Date.now()): string {
  return `${nowMs}.${sign(nowMs)}`;
}

export type TicketVerdict = 'ok' | 'malformed' | 'bad_signature' | 'too_fast' | 'expired';

/**
 * Check a ticket's signature and age. Pure — `nowMs` is injected so the windows can be
 * tested without waiting for them.
 */
export function verifyTicket(raw: unknown, nowMs: number = Date.now()): TicketVerdict {
  if (typeof raw !== 'string') return 'malformed';
  const dot = raw.indexOf('.');
  if (dot <= 0) return 'malformed';
  const issuedAt = Number.parseInt(raw.slice(0, dot), 10);
  const mac = raw.slice(dot + 1);
  if (!Number.isFinite(issuedAt) || mac === '') return 'malformed';

  // Constant-time, and length-checked first: timingSafeEqual THROWS on a length
  // mismatch rather than returning false, so an attacker-supplied short mac would be a
  // 500 instead of a 400.
  const expected = Buffer.from(sign(issuedAt), 'utf-8');
  const got = Buffer.from(mac, 'utf-8');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return 'bad_signature';
  }

  const age = nowMs - issuedAt;
  // A negative age means a clock moved, not an attack — it is signed, so it can only
  // have been minted here. Treated as "too fast", which is the safe side.
  if (age < MIN_FILL_MS) return 'too_fast';
  if (age > MAX_TICKET_MS) return 'expired';
  return 'ok';
}

// ---------------------------------------------------------------------------
// The webhook URL
// ---------------------------------------------------------------------------

const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

/**
 * Validate and normalise a Slack incoming-webhook URL.
 *
 * A near-copy of the Pro plugin's `normalizeSlackWebhookUrl` — core cannot import from
 * `packages/pro` (it is a private submodule loaded by path, absent in OSS builds), so
 * this is duplicated deliberately rather than shared. Keep the two in step.
 *
 * The value arrives from the environment, so the threat is a misconfiguration or a
 * compromised variable turning this process into an SSRF proxy, not a user submission.
 * Validating at the SINK makes the guarantee structural.
 */
export function normalizeContactWebhookUrl(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  // https only: the secret is in the path, so http would leak it on the wire, and the
  // scheme check also rules out file:/gopher:/ftp: redirect tricks.
  if (url.protocol !== 'https:') return null;
  // Exact host. NOT endsWith('slack.com'), which accepts hooks.slack.com.evil.example.
  if (url.hostname.toLowerCase() !== SLACK_WEBHOOK_HOST) return null;
  // A real webhook is /services/<team>/<bot>/<token>.
  if (!url.pathname.startsWith('/services/')) return null;
  // Query and fragment are dropped — nothing legitimate uses them, and they are a
  // place to hide a redirect target.
  return `https://${SLACK_WEBHOOK_HOST}${url.pathname}`;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

export interface ContactSubmission {
  name: string;
  email: string;
  topic: string;
  message: string;
}

/** What the form offers, and what each one means when it lands in Slack. */
export const CONTACT_TOPICS: Record<string, string> = {
  pro_trial: 'Free Pro month',
  question: 'Question about the product',
  problem: 'Something is broken',
  other: 'Something else',
};

/**
 * Slack's own escaping rules: `&`, `<` and `>` are the only three characters that are
 * special in message text, and they must be escaped BEFORE the markup is assembled.
 * Applied to every visitor-supplied string so a submission cannot forge a link, a
 * channel reference or an @-mention in the notification it produces.
 */
function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the Block Kit payload. Pure, so the test asserts the shape and the escaping
 * without a network.
 *
 * The message is ONE block per fact plus the body, because a contact form's whole
 * value is that the reply address is readable at a glance on a phone.
 */
export function buildContactMessage(s: ContactSubmission): Record<string, unknown> {
  // `?? 'Something else'` rather than `?? CONTACT_TOPICS['other']`: under
  // noUncheckedIndexedAccess the second lookup is `string | undefined` too, so it
  // would not narrow. The literal is the same string the 'other' key holds.
  const topic = CONTACT_TOPICS[s.topic] ?? 'Something else';
  // Angle brackets around the address would only be escaped back into literal ones, so
  // the notification line uses parentheses and reads the same in every client.
  const summary = `${topic} — ${s.name} (${s.email})`;
  return {
    // `text` is the notification line and the fallback for any client that cannot
    // render blocks. Escaped like everything else.
    text: slackEscape(summary),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${slackEscape(topic)}*` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*From*\n${slackEscape(s.name)}` },
          { type: 'mrkdwn', text: `*Reply to*\n${slackEscape(s.email)}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: slackEscape(s.message) },
      },
    ],
  };
}

/** POST the message. Throws on a non-2xx so the route can log it and 502. */
export async function postContactToSlack(
  webhookUrl: string,
  message: Record<string, unknown>,
): Promise<void> {
  const safe = normalizeContactWebhookUrl(webhookUrl);
  if (!safe) throw new Error('CONTACT_SLACK_WEBHOOK_URL is not a Slack webhook URL');
  const res = await fetch(safe, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
    // Never follow a redirect: a 30x is the standard way past a host allowlist that
    // was only applied to the first URL.
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // The response BODY is deliberately not surfaced — including it would turn a
    // failed request into a read primitive (point the webhook at something internal
    // and the error tells you what it said). The status is enough to diagnose.
    throw new Error(`Slack webhook responded ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

// Length caps are on the SCHEMA, so an oversized body is rejected by Fastify before any
// of this file runs. Sized for a real message rather than for an essay: Slack truncates
// a section block past 3000 characters anyway, and a 4000-character contact-form
// message is not a contact-form message.
const BODY_SCHEMA = {
  type: 'object',
  required: ['name', 'email', 'message', 'ticket'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    // A deliberately loose pattern. Email addresses that are legal and that a strict
    // regex rejects are common; the address is only ever used as a reply-to that a
    // human reads, never as a delivery target, so a wrong one costs a reply and
    // nothing else.
    email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    topic: { type: 'string', enum: Object.keys(CONTACT_TOPICS) },
    message: { type: 'string', minLength: 1, maxLength: 2500 },
    ticket: { type: 'string', minLength: 1, maxLength: 200 },
    // The honeypot, and IT MUST BE DECLARED HERE OR THE WHOLE LAYER IS INERT. Fastify
    // configures ajv with `removeAdditional: true`, so an undeclared property is
    // SILENTLY STRIPPED from req.body before the handler runs — the request still 200s,
    // the check below still sees `undefined`, and every bot passes. Verified by injection,
    // not assumed: an unknown field posted to this route returns 200 with the field gone.
    website: { type: 'string', maxLength: 200 },
  },
} as const;

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  const configured = normalizeContactWebhookUrl(config.contactSlackWebhookUrl) != null;

  // Mint a ticket. Also the form's readiness probe: with no webhook configured it 503s
  // here, so the page can say so BEFORE someone writes two hundred words into a form
  // that has nowhere to send them.
  app.get('/api/contact/ticket', async (_req, reply) => {
    if (!configured) {
      return reply.code(503).send({ error: 'contact_unavailable' });
    }
    // A ticket is a signed timestamp and nothing else — it identifies no one and
    // carries no state — but it must not be cached by anything in front of this
    // server, or every visitor shares one issue time.
    reply.header('cache-control', 'no-store');
    return { ticket: issueTicket() };
  });

  app.post('/api/contact', { schema: { body: BODY_SCHEMA } }, async (req, reply) => {
    if (!configured) {
      return reply.code(503).send({
        error: 'contact_unavailable',
        message: 'The contact form is not available right now.',
      });
    }

    const body = req.body as {
      name: string;
      email: string;
      topic?: string;
      message: string;
      ticket: string;
      website?: string;
    };

    // Layer 1. Answered with the SUCCESS shape on purpose: a bot that is told it failed
    // learns which field to leave alone next time, and a person can never reach this.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      req.log.info({ ip: req.ip }, 'contact form: honeypot filled, dropped');
      return { ok: true };
    }

    // Layer 2.
    const verdict = verifyTicket(body.ticket);
    if (verdict !== 'ok') {
      req.log.warn({ ip: req.ip, verdict }, 'contact form: ticket rejected');
      // Two answers, because they mean different things to a person. An expired ticket
      // is a page that sat open and the fix is to reload; anything else is either a bot
      // or a genuinely broken client, and the message says what to do without saying
      // which check failed.
      return reply.code(400).send({
        error: verdict === 'expired' ? 'ticket_expired' : 'ticket_invalid',
        message:
          verdict === 'expired'
            ? 'This form has been open for a while. Reload the page and send it again.'
            : 'We could not verify that form. Reload the page and try again.',
      });
    }

    try {
      await postContactToSlack(
        config.contactSlackWebhookUrl,
        buildContactMessage({
          name: body.name.trim(),
          email: body.email.trim(),
          topic: body.topic ?? 'other',
          message: body.message.trim(),
        }),
      );
    } catch (err) {
      // The submitter's words only exist in the request they just made, so a failure
      // here loses them. Log enough to reconstruct the message by hand, and tell the
      // visitor plainly that it did not send rather than showing a success screen over
      // a dropped message.
      // ⚠ `from:`, NEVER `name:`. Pino treats `name` as the LOGGER's name, so a `name`
      // key here is swallowed into the log prefix — the line came out as
      // `ERROR (Sam Okafor/19949)` with the submitter's name where the process name
      // belongs and no `name` field in the body at all. Observed, not theorised.
      req.log.error(
        { err, from: body.name, email: body.email, topic: body.topic, message: body.message },
        'contact form: delivery FAILED — the message is in this log line and nowhere else',
      );
      return reply.code(502).send({
        error: 'delivery_failed',
        message: 'That did not send. Please try again in a minute.',
      });
    }

    req.log.info({ topic: body.topic }, 'contact form: delivered');
    return { ok: true };
  });
}
