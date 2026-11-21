import { parseTicketIdent, type TrackerProvider } from '@pierre-review/shared';
import { fetchPage, nodePageTransport, type PageTransport } from '../reference-docs/url-fetch.js';
import { jiraAttachmentsOf, type ArtifactFetch, type TicketAttachment } from './artifacts.js';
import { prepareTrackerCall } from './calls.js';
import { githubAccessFor, type TrackerContext } from './context.js';
import { jiraAuthHeader } from './jira/client.js';
import { checkJiraUrl, guardedLookup, jiraGetJson, JiraFetchError, nodeTransport } from './jira/fetch.js';
import { readWorkspaceTrackerRow, trackerAccessOf } from './settings.js';
import type { TrackerCall } from './types.js';

// THE HOST'S READ OF A TICKET'S ATTACHMENTS, for `ensemble-ticket` (docs/SANDBOX.md § The ticket relay).
// Read when a SESSION the reader started asks — never when anything is viewed — with the workspace's own
// tracker credential, which never leaves the host. READ ONLY: nothing here writes to a tracker.
//
// Jira: `issue/<KEY>?fields=attachment`, then each attachment's `content` address — ⚠ only on the SAME
// site as the workspace's tracker (the address is the tracker's JSON, so it is checked before the
// credential is sent), never following a redirect WITH the credential. Jira Cloud answers a download with
// a redirect to Atlassian's media service, whose address carries its own signature: that ONE hop is read
// WITHOUT the credential, public addresses only (the `confluenceGetBytes` rule).
//
// Other providers have no attachments read yet: their manifest is the links in the ticket's text.

/** One attachment, at most (a design export or a screen recording can be large; past it `get` says so). */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_TIMEOUT_MS = 30_000;

export class ArtifactReadError extends Error {
  constructor(
    /** A plain sentence the agent may see. Never anything the tracker sent back. */
    public readonly sentence: string,
  ) {
    super(sentence);
    this.name = 'ArtifactReadError';
  }
}

export interface TicketArtifactAccess {
  provider: TrackerProvider;
  /** The tracker's host, for the session's Network panel. */
  host: string;
  attachments(): Promise<TicketAttachment[]>;
  download(fetch: ArtifactFetch, maxBytes?: number): Promise<Buffer>;
}

export interface TicketArtifactDeps {
  pageTransport?: PageTransport;
}

function sentenceFor(err: unknown): string {
  if (err instanceof ArtifactReadError) return err.sentence;
  if (err instanceof JiraFetchError) {
    switch (err.code) {
      case 'unauthorized':
      case 'forbidden':
        return 'The tracker refused the workspace’s token for this file.';
      case 'not_found':
        return 'The tracker says the file is not there any more.';
      case 'too_large':
        return `The file is larger than ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB, so it was not copied.`;
      case 'timeout':
        return 'The tracker did not answer in time.';
      case 'blocked':
      case 'bad_url':
        return 'The file’s address is not one Ensemble reads.';
      default:
        return 'The tracker could not be read just now.';
    }
  }
  return 'The tracker could not be read just now.';
}

/** The plain sentence for any failure of this module. */
export const artifactErrorSentence = sentenceFor;

/** Is `raw` on the tracker's own site (same origin, under the site root's path)? */
export function onTrackerSite(raw: string, apiRoot: string): boolean {
  try {
    const u = new URL(raw);
    const root = new URL(apiRoot);
    if (u.origin !== root.origin) return false;
    const prefix = root.pathname.replace(/\/+$/, '');
    return prefix === '' || u.pathname === prefix || u.pathname.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

/** Jira: the ticket's attachments. */
export async function jiraTicketAttachments(call: TrackerCall, key: string): Promise<TicketAttachment[]> {
  const raw = await jiraGetJson(
    `${call.apiRoot}/rest/api/2/issue/${encodeURIComponent(key)}?fields=attachment`,
    { authorization: jiraAuthHeader(call.credentials) },
    call.policy,
    call.transport,
  );
  return jiraAttachmentsOf(raw).map((a) =>
    // ⚠ The content address must be on the tracker's own site, or it is listed but never read.
    a.fetch.kind === 'jira_attachment' && !onTrackerSite(a.fetch.contentUrl, call.apiRoot) ? { ...a, fetch: { kind: 'none' } as const } : a,
  );
}

/** Jira: one attachment's bytes. */
export async function downloadJiraAttachment(
  call: TrackerCall,
  contentUrl: string,
  maxBytes: number,
  deps: TicketArtifactDeps = {},
): Promise<Buffer> {
  if (!onTrackerSite(contentUrl, call.apiRoot)) throw new ArtifactReadError('The file’s address is not on the tracker’s site, so Ensemble did not read it.');
  const url = checkJiraUrl(contentUrl, call.policy);
  const transport = call.transport ?? nodeTransport;
  const viaRedirect = async (location: string): Promise<Buffer> => {
    // The ONE hop, WITHOUT the credential (a signed media address), public addresses only on cloud.
    const page = await fetchPage(new URL(location, url).href, deps.pageTransport ?? nodePageTransport, { privateNetwork: !call.policy.cloud }, maxBytes).catch(() => {
      throw new ArtifactReadError('The file could not be downloaded from the tracker’s file service.');
    });
    return page.body;
  };
  try {
    const res = await transport(
      url,
      { accept: '*/*', 'user-agent': 'Ensemble', authorization: jiraAuthHeader(call.credentials) },
      { lookup: call.policy.cloud ? guardedLookup() : undefined, timeoutMs: ATTACHMENT_TIMEOUT_MS, maxBytes },
    );
    if (res.status >= 300 && res.status < 400 && res.headers?.location) return await viaRedirect(res.headers.location);
    if (res.status === 401 || res.status === 403) throw new JiraFetchError(res.status === 401 ? 'unauthorized' : 'forbidden', res.status);
    if (res.status === 404) throw new JiraFetchError('not_found', 404);
    if (res.status < 200 || res.status >= 300) throw new JiraFetchError('http', res.status);
    return res.bytes ?? Buffer.from(res.body, 'utf8');
  } catch (err) {
    if (err instanceof JiraFetchError && err.code === 'redirect' && err.location) return viaRedirect(err.location);
    throw err;
  }
}

/**
 * The workspace's access to ONE ticket's attachments. Throws ArtifactReadError when the workspace's
 * tracker cannot be read, or the ticket is not on it.
 */
export async function ticketArtifactAccess(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  ident: string,
  deps: TicketArtifactDeps = {},
): Promise<TicketArtifactAccess> {
  const parsed = parseTicketIdent(ident);
  if (parsed == null) throw new ArtifactReadError('This session’s ticket is not a tracker ticket.');
  const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
  const prepared = prepareTrackerCall(access, { github: githubAccessFor(ctx, accountId) });
  if (!prepared.ok) throw new ArtifactReadError(prepared.message);
  const call = prepared.call;
  if (call.provider !== parsed.provider || call.apiRoot !== parsed.apiRoot) {
    throw new ArtifactReadError('The ticket is on another tracker than the one this workspace reads now.');
  }
  let host = '';
  try {
    host = new URL(call.apiRoot).hostname;
  } catch {
    host = call.provider;
  }
  return {
    provider: call.provider,
    host,
    async attachments() {
      if (call.provider !== 'jira') return [];
      return jiraTicketAttachments(call, parsed.key);
    },
    async download(fetch, maxBytes = ATTACHMENT_MAX_BYTES) {
      if (fetch.kind !== 'jira_attachment' || call.provider !== 'jira') throw new ArtifactReadError('Ensemble cannot read this file. Open its link instead.');
      return downloadJiraAttachment(call, fetch.contentUrl, maxBytes, deps);
    },
  };
}
