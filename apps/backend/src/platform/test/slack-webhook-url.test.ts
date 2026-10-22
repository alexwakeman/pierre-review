// SSRF guard on the Slack webhook URL.
//
// This value is user-supplied (`PUT /api/pro/settings`) and is handed to `fetch()` by
// slack/send.ts, which made it a server-side request primitive: point it at
// `http://redis.railway.internal:6379/` or `http://169.254.169.254/` and `POST /api/pro/slack/test`
// would report back the target's status and — before this was fixed — the first 200 bytes of its
// response body. An internal port scanner with partial read, from inside the private network.
//
// The control is an ALLOWLIST at the point of storage, so the "rejects" block below is the
// security surface: every one of those is a real bypass attempt someone would try.
//
// NOTE: `@pierre/pro` has no `test` script or vitest devDependency, so nothing in this directory
// currently runs in CI. Wire one up and these execute as-is.
import { describe, expect, it } from 'vitest';
import { normalizeSlackWebhookUrl } from '../settings/store.js';

describe('normalizeSlackWebhookUrl — accepts real Slack webhooks', () => {
  it('accepts a canonical incoming-webhook URL', () => {
    const url = 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';
    expect(normalizeSlackWebhookUrl(url)).toBe(url);
  });

  it('trims surrounding whitespace (paste artefacts)', () => {
    const url = 'https://hooks.slack.com/services/T1/B1/abc';
    expect(normalizeSlackWebhookUrl(`  ${url}\n`)).toBe(url);
  });

  it('strips query and fragment (nothing legitimate uses them; a redirect could hide there)', () => {
    expect(normalizeSlackWebhookUrl('https://hooks.slack.com/services/T1/B1/abc?x=1#y')).toBe(
      'https://hooks.slack.com/services/T1/B1/abc',
    );
  });

  it('treats empty / null as "clear the setting"', () => {
    expect(normalizeSlackWebhookUrl('')).toBeNull();
    expect(normalizeSlackWebhookUrl('   ')).toBeNull();
    expect(normalizeSlackWebhookUrl(null)).toBeNull();
  });
});

describe('normalizeSlackWebhookUrl — rejects SSRF targets', () => {
  const rejected: [string, string][] = [
    ['loopback', 'http://127.0.0.1:6379/'],
    ['loopback by name', 'http://localhost:4000/api/me'],
    ['cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['private network service', 'http://redis.railway.internal:6379/'],
    ['RFC1918 address', 'http://10.0.0.5/admin'],
    ['plain http Slack (would leak the secret path)', 'http://hooks.slack.com/services/T1/B1/abc'],
    // The classic way this check gets written wrong is `hostname.endsWith('slack.com')`.
    ['suffix-confusion host', 'https://hooks.slack.com.evil.example/services/T1/B1/abc'],
    ['subdomain-confusion host', 'https://evil.example/hooks.slack.com/services/T1/B1/abc'],
    ['userinfo trick', 'https://hooks.slack.com@evil.example/services/T1/B1/abc'],
    ['different Slack host', 'https://slack.com/services/T1/B1/abc'],
    ['right host, wrong path', 'https://hooks.slack.com/api/chat.postMessage'],
    ['file scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://127.0.0.1:6379/_INFO'],
    ['not a URL at all', 'hooks.slack.com/services/T1/B1/abc'],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, () => {
      expect(normalizeSlackWebhookUrl(url)).toBeNull();
    });
  }
});
