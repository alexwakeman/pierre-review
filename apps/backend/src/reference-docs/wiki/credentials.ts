import { and, eq } from 'drizzle-orm';
import { NOTION_TOKEN_RE, type WikiCredentialsSettings, type WikiProviderId } from '@pierre-review/shared';
import { decryptToken, encryptToken, sealingAvailable } from '../../auth/crypto.js';
import { db, schema } from '../../db/client.js';
import { openTrackerToken, storeTrackerToken, type HostSeal } from '../../tracker/secret.js';
import type { WikiCredential, WikiPageRef } from './source.js';

// A WIKI'S CREDENTIAL (docs/REFERENCE-DOCS.md § Wiki sources → Credentials). ONE resolution:
//
//   1. the workspace's own wiki credential (`workspace_wiki_credentials`) when its site's host is the
//      page's host;
//   2. else the workspace's JIRA credential, when Jira is its tracker, the Jira site's host is the
//      page's host (Confluence Cloud and Jira Cloud share `<x>.atlassian.net` and one API token), and
//      an email and a token are saved;
//   3. else none — the import / refresh says "Add a Confluence API token in Settings".
//
// NOTION has ONE rung: the workspace's own Notion row (provider 'notion', token only — api.notion.com is
// the only host, so there is no site to match). The integration must be SHARED with the pages in Notion.
//
// ⚠ THE TOKEN IS WRITE-ONLY AND SEALED exactly like a tracker token (tracker/secret.ts: `sealed:v1:`
// when the process holds an ENCRYPTION_KEY, else `plain:` — the trust of the machine's own `gh` token).
// Nothing here returns it: the settings answer carries `hasToken`. A token belongs to ONE site: a
// changed site URL drops the saved token unless a new one comes with it. ⚠ NEVER LOG either form.

export function hostSeal(): HostSeal {
  return sealingAvailable() ? { sealSecret: encryptToken, openSecret: decryptToken } : {};
}

interface Row {
  siteUrl: string | null;
  authEmail: string | null;
  authToken: string | null;
}

async function readRow(accountId: number, workspaceId: number, provider: WikiProviderId): Promise<Row | null> {
  const t = schema.workspaceWikiCredentials;
  const rows = await db
    .select({ siteUrl: t.siteUrl, authEmail: t.authEmail, authToken: t.authToken })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.provider, provider)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

/** The host of an https site address, lower-cased, or null. */
export function siteHost(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A site address cut back to `https://<host>`, or null when it is not one. */
export function normalizeSiteUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || !u.hostname.includes('.')) return null;
    return `https://${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** The workspace's Jira site (host) and its stored credential, when Jira is the tracker. */
async function jiraRow(accountId: number, workspaceId: number): Promise<{ host: string; email: string | null; token: string | null } | null> {
  const t = schema.workspaceTrackers;
  const rows = await db
    .select({ provider: t.provider, baseUrl: t.baseUrl, authEmail: t.authEmail, authToken: t.authToken })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  const r = rows[0];
  if (!r || r.provider !== 'jira') return null;
  const host = siteHost(r.baseUrl);
  return host ? { host, email: r.authEmail ?? null, token: r.authToken ?? null } : null;
}

export async function readWikiCredentialsSettings(accountId: number, workspaceId: number): Promise<WikiCredentialsSettings> {
  const [row, jira, notion] = await Promise.all([
    readRow(accountId, workspaceId, 'confluence'),
    jiraRow(accountId, workspaceId),
    readRow(accountId, workspaceId, 'notion'),
  ]);
  return {
    workspaceId,
    confluence: {
      siteUrl: row?.siteUrl ?? null,
      email: row?.authEmail ?? null,
      // ⚠ presence only — never the token.
      hasToken: row?.authToken != null && row.authToken !== '',
      jiraSite: jira && (jira.email ?? '').trim() !== '' && jira.token ? jira.host : null,
    },
    // ⚠ presence only — never the token.
    notion: { hasToken: notion?.authToken != null && notion.authToken !== '' },
  };
}

export interface WikiCredentialPatch {
  siteUrl?: string | null;
  email?: string | null;
  token?: string | null;
}

/** A Notion patch's problem, in a sentence, or null (the token's SHAPE: a stray paste never becomes it). */
export function notionCredentialPatchError(p: { token?: string | null }): string | null {
  if (p.token != null && p.token.trim() !== '' && !NOTION_TOKEN_RE.test(p.token.trim())) {
    return 'That is not a Notion integration token. It starts with ntn_ (or secret_ for an older one).';
  }
  return null;
}

/** A patch's problem, in a sentence, or null. */
export function wikiCredentialPatchError(p: WikiCredentialPatch): string | null {
  if (p.siteUrl != null && p.siteUrl.trim() !== '' && normalizeSiteUrl(p.siteUrl) == null) {
    return 'The Confluence site must be an https address, e.g. https://acme.atlassian.net.';
  }
  if (p.email != null && p.email.trim() !== '' && !/^[^\s@]+@[^\s@]+$/.test(p.email.trim())) return 'That is not an email address.';
  if (p.token != null && p.token.length > 4096) return 'That token is too long.';
  return null;
}

/** The ONE writer. A partial patch; a changed site drops a token not sent with it. */
export async function writeWikiCredentials(
  accountId: number,
  workspaceId: number,
  provider: WikiProviderId,
  patch: WikiCredentialPatch,
  seal: HostSeal = hostSeal(),
): Promise<void> {
  const prev = await readRow(accountId, workspaceId, provider);
  const next: Row = { siteUrl: prev?.siteUrl ?? null, authEmail: prev?.authEmail ?? null, authToken: prev?.authToken ?? null };
  if (patch.siteUrl !== undefined) {
    const site = patch.siteUrl == null || patch.siteUrl.trim() === '' ? null : normalizeSiteUrl(patch.siteUrl);
    if (site !== next.siteUrl && patch.token === undefined) next.authToken = null;
    next.siteUrl = site;
  }
  if (patch.email !== undefined) next.authEmail = patch.email == null || patch.email.trim() === '' ? null : patch.email.trim().slice(0, 320);
  if (patch.token !== undefined) next.authToken = patch.token == null || patch.token.trim() === '' ? null : storeTrackerToken(seal, patch.token.trim());
  const t = schema.workspaceWikiCredentials;
  await db
    .insert(t)
    .values({ accountId, workspaceId, provider, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId, t.provider], set: { ...next, updatedAt: new Date() } })
    .execute();
}

export type ResolvedCredential =
  | { state: 'ok'; credential: WikiCredential; from: 'wiki' | 'jira' }
  | { state: 'none' }
  | { state: 'unreadable' };

/** The credential for a page in this workspace (the ladder in the header). Never logs. */
export async function resolveWikiCredential(
  accountId: number,
  workspaceId: number,
  ref: Pick<WikiPageRef, 'provider' | 'host'>,
  seal: HostSeal = hostSeal(),
): Promise<ResolvedCredential> {
  const host = ref.host.toLowerCase();
  const own = await readRow(accountId, workspaceId, ref.provider);
  // Notion: one token per workspace, for its one API host.
  if (ref.provider === 'notion') {
    if (!own?.authToken) return { state: 'none' };
    const opened = openTrackerToken(seal, own.authToken);
    if (opened.state === 'ok') return { state: 'ok', credential: { email: null, token: opened.token }, from: 'wiki' };
    return opened.state === 'unreadable' ? { state: 'unreadable' } : { state: 'none' };
  }
  if (own && siteHost(own.siteUrl) === host && own.authToken) {
    const opened = openTrackerToken(seal, own.authToken);
    if (opened.state === 'ok') return { state: 'ok', credential: { email: own.authEmail, token: opened.token }, from: 'wiki' };
    if (opened.state === 'unreadable') return { state: 'unreadable' };
  }
  if (ref.provider === 'confluence') {
    const jira = await jiraRow(accountId, workspaceId);
    if (jira && jira.host === host && (jira.email ?? '').trim() !== '' && jira.token) {
      const opened = openTrackerToken(seal, jira.token);
      if (opened.state === 'ok') return { state: 'ok', credential: { email: jira.email, token: opened.token }, from: 'jira' };
      if (opened.state === 'unreadable') return { state: 'unreadable' };
    }
  }
  return { state: 'none' };
}
