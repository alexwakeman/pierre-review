// The contact form's pure halves: the signed fill-time ticket, the webhook-URL
// validation, the Slack payload builder and the body checks. Ported with the route
// from apps/backend.
//
// These are the places a mistake is SILENT. A broken ticket check still returns 200
// to every submission; a loose URL check still delivers to whatever it was pointed
// at; an unescaped payload still posts. None of them fails visibly in a browser,
// which is why they are tested here rather than left to the route's happy path.
import { describe, expect, it } from 'vitest';
import {
  MAX_TICKET_MS,
  MIN_FILL_MS,
  TicketSigner,
  buildContactMessage,
  normalizeContactWebhookUrl,
  validateContactBody,
} from './contact.js';

const signer = new TicketSigner('test-secret');

describe('the fill-time ticket', () => {
  it('accepts one minted long enough ago to have been typed into', () => {
    const t0 = 1_000_000_000_000;
    expect(signer.verify(signer.issue(t0), t0 + MIN_FILL_MS + 1)).toBe('ok');
  });

  // The layer's whole point: a form submitted the instant it loaded was not filled in
  // by a person. The timestamp is signed HERE, so the age is not the submitter's to choose.
  it('rejects a submission that arrives faster than a person can type', () => {
    const t0 = 1_000_000_000_000;
    expect(signer.verify(signer.issue(t0), t0)).toBe('too_fast');
    expect(signer.verify(signer.issue(t0), t0 + MIN_FILL_MS - 1)).toBe('too_fast');
  });

  it('expires a ticket harvested from a page left open for hours', () => {
    const t0 = 1_000_000_000_000;
    expect(signer.verify(signer.issue(t0), t0 + MAX_TICKET_MS + 1)).toBe('expired');
  });

  it('rejects a forged or edited timestamp', () => {
    const t0 = 1_000_000_000_000;
    const real = signer.issue(t0);
    const mac = real.slice(real.indexOf('.') + 1);
    // Backdating the issue time to clear the minimum fill window, keeping the signature.
    expect(signer.verify(`${t0 - 60_000}.${mac}`, t0)).toBe('bad_signature');
  });

  it('rejects a ticket signed with another key', () => {
    const t0 = 1_000_000_000_000;
    const other = new TicketSigner('another-secret');
    expect(signer.verify(other.issue(t0), t0 + MIN_FILL_MS + 1)).toBe('bad_signature');
  });

  // timingSafeEqual THROWS on a length mismatch rather than returning false, so a
  // short signature must be length-checked first or this is a 500 instead of a 400.
  it('rejects a short signature without throwing', () => {
    const t0 = 1_000_000_000_000;
    expect(signer.verify(`${t0}.aa`, t0 + MIN_FILL_MS + 1)).toBe('bad_signature');
  });

  it('rejects anything that is not <millis>.<hex>', () => {
    expect(signer.verify(undefined)).toBe('malformed');
    expect(signer.verify(12345 as unknown)).toBe('malformed');
    expect(signer.verify('')).toBe('malformed');
    expect(signer.verify('no-dot')).toBe('malformed');
    expect(signer.verify('.abc')).toBe('malformed');
    expect(signer.verify('123.')).toBe('malformed');
  });
});

describe('the webhook URL', () => {
  it('accepts a real Slack incoming webhook and drops its query string', () => {
    expect(
      normalizeContactWebhookUrl('https://hooks.slack.com/services/T1/B2/xyz?redirect=evil'),
    ).toBe('https://hooks.slack.com/services/T1/B2/xyz');
  });

  // The classic way this check gets written wrong is `endsWith('slack.com')`.
  it('rejects a lookalike host', () => {
    expect(normalizeContactWebhookUrl('https://hooks.slack.com.evil.example/services/a/b/c')).toBe(
      null,
    );
    expect(normalizeContactWebhookUrl('https://evil.example/services/a/b/c')).toBe(null);
  });

  it('rejects a non-https scheme — the token is in the path', () => {
    expect(normalizeContactWebhookUrl('http://hooks.slack.com/services/a/b/c')).toBe(null);
  });

  it('rejects another endpoint on the same host', () => {
    expect(normalizeContactWebhookUrl('https://hooks.slack.com/api/chat.postMessage')).toBe(null);
  });

  it('treats empty and unparseable as unconfigured rather than throwing', () => {
    expect(normalizeContactWebhookUrl('')).toBe(null);
    expect(normalizeContactWebhookUrl('   ')).toBe(null);
    expect(normalizeContactWebhookUrl('not a url')).toBe(null);
  });
});

describe('the Slack payload', () => {
  it('carries the reply address where it can be read at a glance', () => {
    const msg = buildContactMessage({
      name: 'Sam Okafor',
      email: 'sam@example.com',
      topic: 'licence',
      message: 'We are twelve people across six repos. What does a licence cost?',
    });
    expect(msg['text']).toBe('Licence for a bigger team — Sam Okafor (sam@example.com)');
    expect(JSON.stringify(msg)).toContain('sam@example.com');
  });

  // `&`, `<` and `>` are the only three characters special in Slack message text, and
  // every one of these strings came from a stranger. Left unescaped, a submission can
  // forge a link or an @-mention in the notification it produces.
  it('escapes every visitor-supplied string', () => {
    const msg = buildContactMessage({
      name: '<!channel>',
      email: 'a&b@example.com',
      topic: 'other',
      message: '<https://evil.example|click me> & <!here>',
    });
    const json = JSON.stringify(msg);
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<!here>');
    expect(json).not.toContain('<https://evil.example');
    expect(json).toContain('&lt;!channel&gt;');
    expect(json).toContain('a&amp;b@example.com');
  });

  it('falls back to a known topic label rather than printing an unknown key', () => {
    for (const topic of ['not-a-topic', 'toString', '__proto__']) {
      const msg = buildContactMessage({ name: 'A', email: 'a@example.com', topic, message: 'hello' });
      expect(msg['text']).toBe('Something else — A (a@example.com)');
    }
  });
});

describe('the body checks', () => {
  const good = { name: 'A', email: 'a@example.com', message: 'hi', ticket: 't.x' };

  it('accepts a well-formed body and keeps the honeypot field', () => {
    const r = validateContactBody({ ...good, topic: 'question', website: '', extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.website).toBe('');
      expect(r.body.topic).toBe('question');
      expect('extra' in r.body).toBe(false);
    }
  });

  it('refuses an unknown topic, including inherited object keys', () => {
    expect(validateContactBody({ ...good, topic: 'pro_trial' }).ok).toBe(false);
    expect(validateContactBody({ ...good, topic: 'toString' }).ok).toBe(false);
  });

  it('refuses a missing or malformed field', () => {
    expect(validateContactBody({ ...good, email: 'nope' }).ok).toBe(false);
    expect(validateContactBody({ ...good, name: '' }).ok).toBe(false);
    expect(validateContactBody({ ...good, message: 'x'.repeat(2501) }).ok).toBe(false);
    expect(validateContactBody({ ...good, ticket: undefined }).ok).toBe(false);
    expect(validateContactBody({ ...good, website: 5 }).ok).toBe(false);
    expect(validateContactBody([]).ok).toBe(false);
    expect(validateContactBody(null).ok).toBe(false);
  });
});
