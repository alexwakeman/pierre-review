import { describe, expect, it } from 'vitest';
import type { PageTransport } from '../reference-docs/url-fetch.js';
import { JiraFetchError, type JiraTransport } from './jira/fetch.js';
import { ArtifactReadError, artifactErrorSentence, downloadJiraAttachment, jiraTicketAttachments, onTrackerSite } from './ticket-artifacts.js';
import type { TrackerCall } from './types.js';

const ROOT = 'https://acme.atlassian.net';

function callWith(transport: JiraTransport, apiRoot = ROOT): TrackerCall {
  return { provider: 'jira', apiRoot, credentials: { email: 'a@acme.test', token: 'SECRET' }, policy: { cloud: true }, transport };
}

describe('onTrackerSite', () => {
  it('same origin, under the site root', () => {
    expect(onTrackerSite(`${ROOT}/rest/api/2/attachment/content/1`, ROOT)).toBe(true);
    expect(onTrackerSite('https://evil.test/rest/api/2/attachment/content/1', ROOT)).toBe(false);
    expect(onTrackerSite('https://acme.atlassian.net.evil.test/x', ROOT)).toBe(false);
    expect(onTrackerSite('http://acme.atlassian.net/x', ROOT)).toBe(false);
    expect(onTrackerSite('https://jira.acme.test/jira/secure/attachment/1/a.png', 'https://jira.acme.test/jira')).toBe(true);
    expect(onTrackerSite('https://jira.acme.test/other/1', 'https://jira.acme.test/jira')).toBe(false);
    expect(onTrackerSite('not a url', ROOT)).toBe(false);
  });
});

describe('jiraTicketAttachments', () => {
  it('reads fields=attachment with the credential; an off-site content address is listed but never fetchable', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const transport: JiraTransport = async (url, headers) => {
      seen.push({ url: url.href, auth: headers.authorization });
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          fields: {
            attachment: [
              { id: '1', filename: 'mock.png', content: `${ROOT}/rest/api/2/attachment/content/1` },
              { id: '2', filename: 'trap.png', content: 'https://evil.test/steal' },
            ],
          },
        }),
      };
    };
    const list = await jiraTicketAttachments(callWith(transport), 'ACME-1');
    expect(seen[0]!.url).toBe(`${ROOT}/rest/api/2/issue/ACME-1?fields=attachment`);
    expect(seen[0]!.auth).toMatch(/^Basic /);
    expect(list.map((a) => a.fetch.kind)).toEqual(['jira_attachment', 'none']);
  });
});

describe('downloadJiraAttachment', () => {
  it('refuses an off-site address before any request', async () => {
    let calls = 0;
    const transport: JiraTransport = async () => {
      calls += 1;
      return { status: 200, contentType: 'image/png', body: '' };
    };
    await expect(downloadJiraAttachment(callWith(transport), 'https://evil.test/a.png', 1000)).rejects.toBeInstanceOf(ArtifactReadError);
    expect(calls).toBe(0);
  });

  it('sends the credential to the site only; the media redirect is read WITHOUT it', async () => {
    const jira: JiraTransport = async (_url, headers) => {
      expect(headers.authorization).toMatch(/^Basic /);
      throw new JiraFetchError('redirect', 302, 'https://api.media.atlassian.com/file/abc/binary?token=signed');
    };
    const pages: string[] = [];
    const page: PageTransport = async (url) => {
      pages.push(url.href);
      return { status: 200, contentType: 'image/png', location: null, body: Buffer.from('PNGBYTES') };
    };
    const bytes = await downloadJiraAttachment(callWith(jira), `${ROOT}/rest/api/2/attachment/content/1`, 1000, { pageTransport: page });
    expect(bytes.toString()).toBe('PNGBYTES');
    expect(pages).toEqual(['https://api.media.atlassian.com/file/abc/binary?token=signed']);
  });

  it('a direct answer is the bytes; a 403 is a sentence', async () => {
    const ok: JiraTransport = async () => ({ status: 200, contentType: 'image/png', body: 'x', bytes: Buffer.from([1, 2, 3]) });
    expect([...(await downloadJiraAttachment(callWith(ok), `${ROOT}/rest/api/2/attachment/content/1`, 1000))]).toEqual([1, 2, 3]);
    const no: JiraTransport = async () => ({ status: 403, contentType: 'text/plain', body: 'nope' });
    const err = await downloadJiraAttachment(callWith(no), `${ROOT}/rest/api/2/attachment/content/1`, 1000).catch((e: unknown) => e);
    expect(artifactErrorSentence(err)).toBe('The tracker refused the workspace’s token for this file.');
  });

  it('the sentences never carry what the tracker sent', () => {
    expect(artifactErrorSentence(new Error('<html>secret page</html>'))).toBe('The tracker could not be read just now.');
    expect(artifactErrorSentence(new JiraFetchError('too_large'))).toMatch(/larger than 20 MB/);
  });
});
