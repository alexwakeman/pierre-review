// The public contact form: GET /api/contact/ticket + POST /api/contact, delivered to
// a Slack incoming webhook. Ported from the old backend route
// (apps/backend/src/api/routes/contact.ts) when the hosted app went away; the env var
// names, the spam layers and the wire shapes are unchanged.
//
// WHY SLACK AND NOT EMAIL. A contact form's job is to make sure a message ARRIVES.
// Email is the medium with the worst odds of that: it bounces, it lands in spam, and
// it needs SPF/DKIM/DMARC on the domain plus a transactional provider before the first
// message even has a chance. A webhook POST either returns 2xx or throws, and the
// failure is visible in this process's logs at the moment it happens.
//
// NO DEPENDENCIES. Node's global fetch is the whole client.
//
// ---- Deciding a submission is genuine ----
//
// Three layers, none of which needs a third party, a script tag or a CSP change:
//
//   1. A HONEYPOT field. `website` is rendered, labelled and reachable in the DOM, and
//      hidden from sighted users by CSS + aria-hidden + tabindex=-1. A person never
//      fills it; a form-filling bot fills every input it finds. A filled honeypot is
//      answered with 200 and DROPPED — never a 400, because an error tells whoever is
//      running the bot exactly which field gave them away.
//
//   2. A SIGNED TICKET with a minimum fill time. GET /api/contact/ticket returns
//      `<issuedAtMs>.<hmac>`; the POST verifies the signature and requires the age to
//      sit between MIN_FILL_MS and MAX_TICKET_MS. The timestamp is signed by this
//      server, so a bot cannot forge an age, and to get a valid one it has to make a
//      second request and then WAIT. Stateless on purpose — no store, no replay table.
//      A ticket is therefore reusable within its window, which the rate limit bounds.
//
//   3. A RATE LIMIT, keyed by IP (rate-limit.ts). Five an hour, shared by the mint and
//      the submit: a bot must fetch a ticket before it can post one.
//
// A determined human will still get a message through, which is correct — the target
// is automated submission volume, not a wall.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// The ticket
// ---------------------------------------------------------------------------

/** A person needs longer than this to write a message. Below it, it was not typed. */
export const MIN_FILL_MS = 3_000;
/** Past this the ticket is stale — a page left open, or one harvested days ago. */
export const MAX_TICKET_MS = 6 * 60 * 60 * 1000;

/**
 * The ticket signer. `secret` is CONTACT_TICKET_SECRET;
 * without one a per-process random key is used, so a restart invalidates outstanding
 * tickets — one visitor asked to reload, which beats a key readable from the source.
 *
 * Derived rather than used directly so this never shares key material with anything
 * else signed by the same secret.
 */
export class TicketSigner {
  private readonly key: Buffer;

  constructor(secret: string | null | undefined) {
    this.key = createHmac('sha256', secret ? secret : randomBytes(32))
      .update('pierre:contact-ticket:v1')
      .digest();
  }

  private sign(issuedAtMs: number): string {
    return createHmac('sha256', this.key).update(String(issuedAtMs)).digest('hex');
  }

  /** Mint a ticket for a form that is being opened now. */
  issue(nowMs: number = Date.now()): string {
    return `${nowMs}.${this.sign(nowMs)}`;
  }

  /**
   * Check a ticket's signature and age. Pure apart from the key — `nowMs` is injected
   * so the windows can be tested without waiting for them.
   */
  verify(raw: unknown, nowMs: number = Date.now()): TicketVerdict {
    if (typeof raw !== 'string') return 'malformed';
    const dot = raw.indexOf('.');
    if (dot <= 0) return 'malformed';
    const issuedAt = Number.parseInt(raw.slice(0, dot), 10);
    const mac = raw.slice(dot + 1);
    if (!Number.isFinite(issuedAt) || mac === '') return 'malformed';

    // Constant-time, and length-checked first: timingSafeEqual THROWS on a length
    // mismatch rather than returning false, so an attacker-supplied short mac would be
    // a 500 instead of a 400.
    const expected = Buffer.from(this.sign(issuedAt), 'utf-8');
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
}

export type TicketVerdict = 'ok' | 'malformed' | 'bad_signature' | 'too_fast' | 'expired';

// ---------------------------------------------------------------------------
// The webhook URL
// ---------------------------------------------------------------------------

const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

/**
 * Validate and normalise a Slack incoming-webhook URL.
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

/**
 * What the form offers, and what each one means when it lands in Slack. Must match
 * TOPICS in apps/landing/src/components/ContactForm.tsx.
 */
export const CONTACT_TOPICS: Record<string, string> = {
  licence: 'Licence for a bigger team',
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
 */
export function buildContactMessage(s: ContactSubmission): Record<string, unknown> {
  const topic = (Object.hasOwn(CONTACT_TOPICS, s.topic) ? CONTACT_TOPICS[s.topic] : undefined) ?? 'Something else';
  // Angle brackets around the address would only be escaped back into literal ones, so
  // the notification line uses parentheses and reads the same in every client.
  const summary = `${topic} — ${s.name} (${s.email})`;
  return {
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

/** POST the message. Throws on a non-2xx so the caller can log it and 502. */
export async function postContactToSlack(
  webhookUrl: string,
  message: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const safe = normalizeContactWebhookUrl(webhookUrl);
  if (!safe) throw new Error('CONTACT_SLACK_WEBHOOK_URL is not a Slack webhook URL');
  const res = await fetchImpl(safe, {
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
    // failed request into a read primitive. The status is enough to diagnose.
    throw new Error(`Slack webhook responded ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Validating the body
// ---------------------------------------------------------------------------

export interface ContactBody {
  name: string;
  email: string;
  topic?: string;
  message: string;
  ticket: string;
  /** The honeypot. */
  website?: string;
}

// A deliberately loose pattern. Legal addresses that a strict regex rejects are common;
// the address is only ever a reply-to a human reads, so a wrong one costs a reply.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The same limits the old JSON schema enforced, as plain checks. Unknown properties
 * are ignored (the old route stripped them). Returns the cleaned body, or a sentence
 * the form can show — written for the person filling it in, not as a schema path.
 */
export function validateContactBody(raw: unknown): { ok: true; body: ContactBody } | { ok: false; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'That form did not arrive in one piece. Reload the page and try again.' };
  }
  const b = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof b[k] === 'string' ? (b[k] as string) : undefined);

  const name = str('name');
  const email = str('email');
  const message = str('message');
  const ticket = str('ticket');
  const topic = b['topic'];
  const website = b['website'];

  if (name === undefined || name.length < 1 || name.length > 120) {
    return { ok: false, message: 'Add your name (up to 120 characters).' };
  }
  if (email === undefined || email.length < 3 || email.length > 254 || !EMAIL.test(email)) {
    return { ok: false, message: 'Enter an email address we can reply to.' };
  }
  if (message === undefined || message.length < 1 || message.length > 2500) {
    return { ok: false, message: 'Write a message of up to 2,500 characters.' };
  }
  if (ticket === undefined || ticket.length < 1 || ticket.length > 200) {
    return { ok: false, message: 'We could not verify that form. Reload the page and try again.' };
  }
  if (topic !== undefined && (typeof topic !== 'string' || !Object.hasOwn(CONTACT_TOPICS, topic))) {
    return { ok: false, message: 'Pick what the message is about.' };
  }
  if (website !== undefined && (typeof website !== 'string' || website.length > 200)) {
    return { ok: false, message: 'That form did not arrive in one piece. Reload the page and try again.' };
  }
  return {
    ok: true,
    body: {
      name,
      email,
      message,
      ticket,
      ...(typeof topic === 'string' ? { topic } : {}),
      ...(typeof website === 'string' ? { website } : {}),
    },
  };
}
