import { describe, expect, it } from 'vitest';
import { URL_FETCH_MAX_REDIRECTS, UrlFetchError, checkPageUrl, fetchPage, type PageResponse, type PageTransport } from './url-fetch.js';

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof UrlFetchError ? e.code : 'other';
  }
};
const codeAsync = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof UrlFetchError ? e.code : 'other';
  }
};

describe('checkPageUrl — before any socket opens', () => {
  it.each([
    ['file:///etc/passwd', 'bad_url'],
    ['ftp://example.com/x', 'bad_url'],
    ['javascript:alert(1)', 'bad_url'],
    ['https://user:pw@example.com/', 'bad_url'],
    ['not a url', 'bad_url'],
    ['http://127.0.0.1/', 'blocked'],
    ['http://10.1.2.3/', 'blocked'],
    ['http://169.254.169.254/latest/meta-data', 'blocked'],
    ['http://[::1]/', 'blocked'],
    ['http://[::ffff:192.168.0.1]/', 'blocked'],
    ['http://2130706433/', 'blocked'],
    ['http://localhost:4000/api/me', 'blocked'],
    ['http://printer.local/', 'blocked'],
    ['http://intranet/', 'blocked'],
  ])('%s → %s', (raw, want) => {
    expect(code(() => checkPageUrl(raw))).toBe(want);
  });

  it('allows an ordinary public page and drops its fragment', () => {
    expect(checkPageUrl('https://example.com/docs#intro').href).toBe('https://example.com/docs');
  });
});

describe('fetchPage — redirects, statuses and the guarded lookup', () => {
  const page = (body = 'ok'): PageResponse => ({ status: 200, contentType: 'text/html', location: null, body: Buffer.from(body) });
  const redirect = (location: string): PageResponse => ({ status: 302, contentType: '', location, body: Buffer.alloc(0) });

  it('follows a redirect on the same host and uses the guarded lookup for every hop', async () => {
    const seen: string[] = [];
    const t: PageTransport = async (url, opts) => {
      expect(typeof opts.lookup).toBe('function');
      seen.push(url.href);
      return url.pathname === '/old' ? redirect('/new') : page('hello');
    };
    const out = await fetchPage('https://example.com/old', t);
    expect(out.url).toBe('https://example.com/new');
    expect(out.body.toString()).toBe('hello');
    expect(seen).toEqual(['https://example.com/old', 'https://example.com/new']);
  });

  it('refuses a redirect to another host, to a private address, or downgrading to http', async () => {
    expect(await codeAsync(fetchPage('https://example.com/a', async () => redirect('https://evil.example.net/')))).toBe('redirect_off_host');
    expect(await codeAsync(fetchPage('https://example.com/a', async () => redirect('http://127.0.0.1/')))).toBe('blocked');
    expect(await codeAsync(fetchPage('https://example.com/a', async () => redirect('http://example.com/b')))).toBe('redirect_off_host');
  });

  it('stops after too many redirects', async () => {
    let n = 0;
    const t: PageTransport = async () => redirect(`/hop${n++}`);
    expect(await codeAsync(fetchPage('https://example.com/a', t))).toBe('too_many_redirects');
    expect(n).toBe(URL_FETCH_MAX_REDIRECTS + 1);
  });

  it('an error status is an error, never a page', async () => {
    expect(await codeAsync(fetchPage('https://example.com/a', async () => ({ ...page(), status: 404 })))).toBe('http');
  });
});
