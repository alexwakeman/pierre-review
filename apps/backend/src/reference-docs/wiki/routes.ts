import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  REFERENCE_DOC_WIKI_ALL_DEPTH,
  REFERENCE_DOC_WIKI_MAX_DEPTH,
  REFERENCE_DOC_WIKI_MAX_PAGES,
  WIKI_PROVIDER_NAMES,
  normalizeRepoFolder,
  parseGithubRepoName,
  type AddReferenceDocGithubBody,
  type AddReferenceDocWikiBody,
  type GithubDocsPreflightBody,
  type GithubDocsPreflightResponse,
  type WikiPreflightBody,
  type WikiPreflightResponse,
  type ReferenceDocMutationResponse,
  type WikiCredentialsCheckBody,
  type WikiCredentialsCheckResponse,
  type WikiCredentialsSettings,
  type WikiCredentialsUpdate,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { AGENTIC_AI_ENABLED } from '../../review/claude-review/manager.js';
import { enqueueBuild } from '../manager.js';
import { getDocRow, isBuilding, listDocRows, requeueDoc, toReferenceDoc, wikiStateOf, workspaceOwned, type DocRow, type NewDoc } from '../store.js';
import {
  normalizeSiteUrl,
  notionCredentialPatchError,
  readWikiCredentialsSettings,
  resolveWikiCredential,
  siteHost,
  wikiCredentialPatchError,
  writeWikiCredentials,
} from './credentials.js';
import './register.js';
import { NOTION_SITE } from './notion.js';
import { docFolders, githubDocsSource } from './github.js';
import { WikiSourceError, resolveWikiRoot, resolveWikiUrl, wikiErrorMessage, wikiSourceFor, type WikiPageRef, type WikiRoot, type WikiSource } from './source.js';

// THE WIKI ROUTES (docs/API.md § Reference docs → Wiki sources). Registered by
// `registerReferenceDocsRoutes`, so present exactly where the library is (agentic, local).
//
//   POST /api/docs/wiki                                 { workspaceId?, url, childDepth? }; queues ONE
//                                                       build that reads the wiki   → search + ai + ai_hourly
//   POST /api/docs/wiki/preflight                       { workspaceId?, url } the add-documents wizard's
//                                                       count: the root, its scope, pages it would add
//                                                                                    → search + read
//   POST /api/docs/github/preflight                     { workspaceId?, repo } the repository's folders
//                                                       holding text documents, counted → search + read
//   POST /api/docs/github                               { workspaceId?, repo, path? } queues ONE build
//                                                       of a folder's documents  → search + ai + ai_hourly
//   POST /api/docs/:id/refresh                          checks the wiki; rebuilds only what changed
//                                                                                    → search + ai + ai_hourly
//   GET  /api/workspaces/:id/wiki-credentials           the settings, never a token    → read
//   PUT  /api/workspaces/:id/wiki-credentials           a partial patch, Confluence and/or Notion (DB only) → read
//   POST /api/workspaces/:id/wiki-credentials/check     { provider? } one read with the saved token → search + read
//
// TENANCY as the library's: a document id in a PATH resolves within the account (→ 404); a workspace id
// in a PATH must be the account's (→ 404); a body's `workspaceId` falls back to the Default.

type ErrorBody = { error: string; message: string };

export interface WikiRouteHelpers {
  fail(reply: FastifyReply, status: number, error: string, message: string): ErrorBody;
  featureOff(reply: FastifyReply): ErrorBody;
  workspaceOf(accountId: number, raw: unknown): Promise<number>;
  preflight(ctx: AgentContext, accountId: number, reply: FastifyReply): Promise<ErrorBody | null>;
  insertWithSlug(base: Omit<NewDoc, 'slug'>): Promise<DocRow>;
  maxDocs: number;
}

/** The wizard's reads stop here (a Notion tree is read at three requests a second). */
const PREFLIGHT_TIMEOUT_MS = 90_000;

/** An AbortSignal that fires on the timeout or when the reader goes away (the REPLY socket). */
function requestSignal(reply: FastifyReply): { signal: AbortSignal; done(): void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PREFLIGHT_TIMEOUT_MS);
  const onClose = (): void => {
    if (!reply.raw.writableEnded) ac.abort();
  };
  reply.raw.on('close', onClose);
  return {
    signal: ac.signal,
    done: () => {
      clearTimeout(t);
      reply.raw.off('close', onClose);
    },
  };
}

/** A document of this library that already reads the same root (same wiki, site and root page). */
function sameRoot(rows: readonly DocRow[], ref: WikiPageRef): { id: number; title: string } | null {
  for (const r of rows) {
    const w = wikiStateOf(r.wiki);
    if (!w || w.provider !== ref.provider || w.rootPageId !== ref.pageId) continue;
    if (ref.provider === 'github') {
      const a = w.scope?.kind === 'repo' ? w.scope : null;
      const b = ref.scope?.kind === 'repo' ? ref.scope : null;
      if (!a || !b || `${a.owner}/${a.repo}`.toLowerCase() !== `${b.owner}/${b.repo}`.toLowerCase()) continue;
    } else if (w.origin !== ref.origin) continue;
    return { id: r.id, title: r.title };
  }
  return null;
}

/** The wiki state a scoped (wizard) import stores: every level below the root, and what it covers. */
function scopedState(root: WikiRoot, rootUrl: string): NonNullable<NewDoc['wiki']> {
  return {
    provider: root.ref.provider,
    origin: root.ref.origin,
    rootPageId: root.ref.pageId,
    rootUrl,
    depth: REFERENCE_DOC_WIKI_ALL_DEPTH,
    pageCount: null,
    pagesLeftOut: 0,
    lastCheckedAt: null,
    lastListedAt: null,
    lastChangedAt: null,
    unreachableSince: null,
    unreachableReason: null,
    retryAfter: null,
    scope: root.scope,
    rootTitle: root.title,
  };
}

const githubSource = (): ReturnType<typeof githubDocsSource> => (wikiSourceFor('github') ?? githubDocsSource()) as ReturnType<typeof githubDocsSource>;

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
};

export function registerWikiDocRoutes(app: FastifyInstance, ctx: AgentContext, h: WikiRouteHelpers): void {
  app.post(
    '/api/docs/wiki',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          additionalProperties: false,
          properties: {
            workspaceId: { type: 'integer', minimum: 1 },
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            childDepth: { type: 'integer', minimum: 0, maximum: REFERENCE_DOC_WIKI_MAX_DEPTH },
            tree: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply): Promise<ReferenceDocMutationResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const b = req.body as AddReferenceDocWikiBody;
      const resolved = resolveWikiUrl(b.url);
      if (!resolved) {
        return h.fail(reply, 400, 'NotAWikiPage', 'That is not a Confluence or Notion page address. Open the page and copy the address from the browser.');
      }
      const { ref, source } = resolved;
      const name = WIKI_PROVIDER_NAMES[ref.provider];
      // A space address names no page: only the wizard's subtree import (which finds its home) reads it.
      if (ref.pageId === '' && b.tree !== true) {
        return h.fail(reply, 400, 'NotAWikiPage', 'That address is a whole space. Open a page and copy its address, or add the space from the + button.');
      }
      const workspaceId = await h.workspaceOf(accountId, b.workspaceId);
      if ((await listDocRows(accountId, workspaceId)).length >= h.maxDocs) {
        return h.fail(reply, 409, 'LibraryFull', `A workspace holds at most ${h.maxDocs} documents. Remove one first.`);
      }
      // No request to the wiki here (the build reads it); only whether there is a credential to read with.
      const cred = await resolveWikiCredential(accountId, workspaceId, ref);
      if (cred.state === 'none') {
        return h.fail(
          reply,
          400,
          'NoWikiCredential',
          ref.provider === 'notion'
            ? 'Add a Notion token in Settings → Docs, then add the page again.'
            : `Add a ${name} API token in Settings → Docs, then add the page again.`,
        );
      }
      if (cred.state === 'unreadable') return h.fail(reply, 400, 'NoWikiCredential', `Save the ${name} token again in Settings.`);
      const pre = await h.preflight(ctx, accountId, reply);
      if (pre) return pre;
      const url = b.url.trim();
      if (b.tree === true) {
        // THE WIZARD'S SUBTREE: the root (a space's home page) and its scope are read now, so the row
        // stores exactly what every Rebuild and refresh reads again.
        const req2 = requestSignal(reply);
        let root: WikiRoot;
        try {
          root = await resolveWikiRoot(source, ref, { credential: cred.credential, signal: req2.signal });
        } catch (err) {
          return h.fail(reply, 400, 'WikiUnreachable', wikiErrorMessage(name, err));
        } finally {
          req2.done();
        }
        const row = await h.insertWithSlug({
          accountId,
          workspaceId,
          title: root.title,
          sourceKind: 'wiki',
          sourceName: url,
          sourceUrl: url,
          byteSize: 0,
          pageCount: null,
          wiki: scopedState(root, url),
        });
        enqueueBuild(ctx, accountId, workspaceId, row.id, { full: true });
        reply.status(202);
        return { doc: toReferenceDoc(row) };
      }
      const depth = Math.max(0, Math.min(REFERENCE_DOC_WIKI_MAX_DEPTH, b.childDepth ?? 0));
      const row = await h.insertWithSlug({
        accountId,
        workspaceId,
        title: `${name} page ${ref.pageId}`,
        sourceKind: 'wiki',
        sourceName: url,
        sourceUrl: url,
        byteSize: 0,
        pageCount: null,
        wiki: {
          provider: ref.provider,
          origin: ref.origin,
          rootPageId: ref.pageId,
          rootUrl: url,
          depth,
          pageCount: null,
          pagesLeftOut: 0,
          lastCheckedAt: null,
          lastListedAt: null,
          lastChangedAt: null,
          unreachableSince: null,
          unreachableReason: null,
          retryAfter: null,
        },
      });
      enqueueBuild(ctx, accountId, workspaceId, row.id, { full: true });
      reply.status(202);
      return { doc: toReferenceDoc(row) };
    },
  );

  // ---- the add-documents wizard: count before adding ----
  app.post(
    '/api/docs/wiki/preflight',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          additionalProperties: false,
          properties: { workspaceId: { type: 'integer', minimum: 1 }, url: { type: 'string', minLength: 1, maxLength: 2048 } },
        },
      },
    },
    async (req, reply): Promise<WikiPreflightResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const b = req.body as WikiPreflightBody;
      const resolved = resolveWikiUrl(b.url);
      if (!resolved) {
        return h.fail(reply, 400, 'NotAWikiPage', 'That is not a Confluence or Notion address. Open the page and copy the address from the browser.');
      }
      const workspaceId = await h.workspaceOf(accountId, b.workspaceId);
      const name = WIKI_PROVIDER_NAMES[resolved.ref.provider];
      const cred = await resolveWikiCredential(accountId, workspaceId, resolved.ref);
      if (cred.state !== 'ok') {
        return h.fail(reply, 400, 'NoWikiCredential', resolved.ref.provider === 'notion' ? 'Add a Notion token first.' : `Add a ${name} API token first.`);
      }
      return countTree(reply, resolved.source, resolved.ref, cred.credential, cred.from, name, accountId, workspaceId);
    },
  );

  async function countTree(
    reply: FastifyReply,
    source: WikiSource,
    ref: WikiPageRef,
    credential: { email: string | null; token: string },
    from: 'wiki' | 'jira' | 'gh',
    name: string,
    accountId: number,
    workspaceId: number,
  ): Promise<WikiPreflightResponse | ErrorBody> {
    const r = requestSignal(reply);
    try {
      const root = await resolveWikiRoot(source, ref, { credential, signal: r.signal });
      const { pages, more } = await source.listDescendants(root.ref, root.ref.pageId, REFERENCE_DOC_WIKI_ALL_DEPTH, REFERENCE_DOC_WIKI_MAX_PAGES - 1, {
        credential,
        signal: r.signal,
      });
      return {
        provider: ref.provider,
        rootTitle: root.title,
        scope: root.scope,
        pageCount: 1 + pages.length,
        more,
        credentialFrom: from,
        existing: sameRoot(await listDocRows(accountId, workspaceId), root.ref),
      };
    } catch (err) {
      if (r.signal.aborted) return h.fail(reply, 504, 'Timeout', `${name} took too long to list the pages. Try a smaller section.`);
      return h.fail(reply, 400, 'WikiUnreachable', wikiErrorMessage(name, err));
    } finally {
      r.done();
    }
  }

  // ---- a GitHub repository's documents ----
  const repoBody = {
    type: 'object',
    required: ['repo'],
    additionalProperties: false,
    properties: {
      workspaceId: { type: 'integer', minimum: 1 },
      repo: { type: 'string', minLength: 3, maxLength: 200 },
      path: { type: 'string', maxLength: 300 },
    },
  };

  app.post('/api/docs/github/preflight', { schema: { body: repoBody } }, async (req, reply): Promise<GithubDocsPreflightResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const b = req.body as GithubDocsPreflightBody;
    const name = parseGithubRepoName(b.repo);
    if (!name) return h.fail(reply, 400, 'BadRepo', 'Write the repository as owner/name.');
    const workspaceId = await h.workspaceOf(accountId, b.workspaceId);
    const cred = await resolveWikiCredential(accountId, workspaceId, { provider: 'github', host: 'github.com' });
    if (cred.state !== 'ok') return h.fail(reply, 400, 'NoGithubAuth', wikiErrorMessage('GitHub', new WikiSourceError('no_credential')));
    const r = requestSignal(reply);
    try {
      const gh = githubSource();
      const call = { credential: cred.credential, signal: r.signal };
      const branch = await gh.defaultBranch(name.owner, name.repo, call);
      const tree = await gh.listTree(name.owner, name.repo, branch, call);
      return { owner: name.owner, repo: name.repo, branch, folders: docFolders(tree), truncated: tree.truncated };
    } catch (err) {
      return h.fail(reply, 400, 'GithubUnreachable', wikiErrorMessage('GitHub', err));
    } finally {
      r.done();
    }
  });

  app.post('/api/docs/github', { schema: { body: repoBody } }, async (req, reply): Promise<ReferenceDocMutationResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const b = req.body as AddReferenceDocGithubBody;
    const name = parseGithubRepoName(b.repo);
    if (!name) return h.fail(reply, 400, 'BadRepo', 'Write the repository as owner/name.');
    const path = normalizeRepoFolder(b.path);
    if (path == null) return h.fail(reply, 400, 'BadFolder', 'That is not a folder path in the repository.');
    const workspaceId = await h.workspaceOf(accountId, b.workspaceId);
    if ((await listDocRows(accountId, workspaceId)).length >= h.maxDocs) {
      return h.fail(reply, 409, 'LibraryFull', `A workspace holds at most ${h.maxDocs} documents. Remove one first.`);
    }
    const cred = await resolveWikiCredential(accountId, workspaceId, { provider: 'github', host: 'github.com' });
    if (cred.state !== 'ok') return h.fail(reply, 400, 'NoGithubAuth', wikiErrorMessage('GitHub', new WikiSourceError('no_credential')));
    const pre = await h.preflight(ctx, accountId, reply);
    if (pre) return pre;
    const r = requestSignal(reply);
    let root: WikiRoot;
    try {
      const gh = githubSource();
      const call = { credential: cred.credential, signal: r.signal };
      const branch = await gh.defaultBranch(name.owner, name.repo, call);
      const ref: WikiPageRef = {
        provider: 'github',
        origin: 'https://github.com',
        host: 'github.com',
        pageId: '',
        scope: { kind: 'repo', owner: name.owner, repo: name.repo, path, branch },
      };
      root = await resolveWikiRoot(gh, ref, call);
    } catch (err) {
      return h.fail(reply, 400, 'GithubUnreachable', wikiErrorMessage('GitHub', err));
    } finally {
      r.done();
    }
    const url = githubSource().pageUrl(root.ref, root.ref.pageId);
    const row = await h.insertWithSlug({
      accountId,
      workspaceId,
      title: root.title,
      sourceKind: 'wiki',
      sourceName: `${name.owner}/${name.repo}${path ? `/${path}` : ''}`,
      sourceUrl: url,
      byteSize: 0,
      pageCount: null,
      wiki: scopedState(root, url),
    });
    enqueueBuild(ctx, accountId, workspaceId, row.id, { full: true });
    reply.status(202);
    return { doc: toReferenceDoc(row) };
  });

  app.post('/api/docs/:id/refresh', { schema: idParam }, async (req, reply): Promise<ReferenceDocMutationResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const { id } = req.params as { id: number };
    const row = await getDocRow(accountId, id);
    if (!row) return h.fail(reply, 404, 'NotFound', `Document ${id} not found`);
    if (row.sourceKind !== 'wiki') return h.fail(reply, 400, 'NotAWikiDocument', 'Only wiki documents refresh. Press Rebuild.');
    if (isBuilding(row.status)) return h.fail(reply, 409, 'Building', 'This document is already being built.');
    const pre = await h.preflight(ctx, accountId, reply);
    if (pre) return pre;
    if (!(await requeueDoc(accountId, id))) return h.fail(reply, 409, 'Building', 'This document is already being built.');
    // A reader's click: not automatic (no budget gate), and only the changed pages are read again.
    enqueueBuild(ctx, accountId, row.workspaceId, id, { full: false, automatic: false });
    reply.status(202);
    return { doc: toReferenceDoc((await getDocRow(accountId, id))!) };
  });

  // ---- credentials (Settings → Docs → Confluence / Notion) ----
  app.get('/api/workspaces/:id/wiki-credentials', { schema: idParam }, async (req, reply): Promise<WikiCredentialsSettings | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const { id } = req.params as { id: number };
    if (!(await workspaceOwned(accountId, id))) return h.fail(reply, 404, 'NotFound', `Workspace ${id} not found`);
    return readWikiCredentialsSettings(accountId, id);
  });

  app.put(
    '/api/workspaces/:id/wiki-credentials',
    {
      schema: {
        ...idParam,
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            confluence: {
              type: 'object',
              additionalProperties: false,
              properties: {
                siteUrl: { type: ['string', 'null'], maxLength: 512 },
                email: { type: ['string', 'null'], maxLength: 320 },
                token: { type: ['string', 'null'], maxLength: 4096 },
              },
            },
            notion: {
              type: 'object',
              additionalProperties: false,
              properties: { token: { type: ['string', 'null'], maxLength: 4096 } },
            },
          },
        },
      },
    },
    async (req, reply): Promise<WikiCredentialsSettings | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const { id } = req.params as { id: number };
      if (!(await workspaceOwned(accountId, id))) return h.fail(reply, 404, 'NotFound', `Workspace ${id} not found`);
      const body = req.body as WikiCredentialsUpdate;
      const problem = (body.confluence ? wikiCredentialPatchError(body.confluence) : null) ?? (body.notion ? notionCredentialPatchError(body.notion) : null);
      if (problem) return h.fail(reply, 400, 'BadCredential', problem);
      if (body.confluence) await writeWikiCredentials(accountId, id, 'confluence', body.confluence);
      // Notion has no site and no email: only its token.
      if (body.notion && body.notion.token !== undefined) await writeWikiCredentials(accountId, id, 'notion', { token: body.notion.token });
      return readWikiCredentialsSettings(accountId, id);
    },
  );

  app.post(
    '/api/workspaces/:id/wiki-credentials/check',
    // The body is optional (`{ provider }`; none ⇒ Confluence), so it is read by hand, not by schema.
    { schema: idParam },
    async (req, reply): Promise<WikiCredentialsCheckResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return h.featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const { id } = req.params as { id: number };
      if (!(await workspaceOwned(accountId, id))) return h.fail(reply, 404, 'NotFound', `Workspace ${id} not found`);
      const asked = req.body != null && typeof req.body === 'object' ? (req.body as WikiCredentialsCheckBody).provider : undefined;
      if (asked === 'notion') {
        const cred = await resolveWikiCredential(accountId, id, NOTION_SITE);
        if (cred.state !== 'ok') return { ok: false, message: wikiErrorMessage('Notion', new WikiSourceError('no_credential')) };
        try {
          await wikiSourceFor('notion')!.checkAccess(NOTION_SITE, { credential: cred.credential });
          return { ok: true, message: 'Connected to Notion.' };
        } catch (err) {
          return { ok: false, message: wikiErrorMessage('Notion', err) };
        }
      }
      const settings = await readWikiCredentialsSettings(accountId, id);
      const origin = normalizeSiteUrl(settings.confluence.siteUrl) ?? (settings.confluence.jiraSite ? `https://${settings.confluence.jiraSite}` : null);
      const host = siteHost(origin);
      if (!origin || !host) return { ok: false, message: 'Save the Confluence site address first.' };
      const site = { provider: 'confluence' as const, origin, host };
      const cred = await resolveWikiCredential(accountId, id, site);
      if (cred.state !== 'ok') return { ok: false, message: wikiErrorMessage('Confluence', new WikiSourceError('no_credential')) };
      try {
        await wikiSourceFor('confluence')!.checkAccess(site, { credential: cred.credential });
        return { ok: true, message: cred.from === 'jira' ? `Connected to ${host} with the Jira token.` : `Connected to ${host}.` };
      } catch (err) {
        return { ok: false, message: wikiErrorMessage('Confluence', err) };
      }
    },
  );
}
