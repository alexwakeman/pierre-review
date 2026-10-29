import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  REFERENCE_DOC_WIKI_MAX_DEPTH,
  WIKI_PROVIDER_NAMES,
  type AddReferenceDocWikiBody,
  type ReferenceDocMutationResponse,
  type WikiCredentialsCheckBody,
  type WikiCredentialsCheckResponse,
  type WikiCredentialsSettings,
  type WikiCredentialsUpdate,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { AGENTIC_AI_ENABLED } from '../../review/claude-review/manager.js';
import { enqueueBuild } from '../manager.js';
import { getDocRow, isBuilding, listDocRows, requeueDoc, toReferenceDoc, workspaceOwned, type DocRow, type NewDoc } from '../store.js';
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
import { WikiSourceError, resolveWikiUrl, wikiErrorMessage, wikiSourceFor } from './source.js';

// THE WIKI ROUTES (docs/API.md § Reference docs → Wiki sources). Registered by
// `registerReferenceDocsRoutes`, so present exactly where the library is (agentic, local).
//
//   POST /api/docs/wiki                                 { workspaceId?, url, childDepth? }; queues ONE
//                                                       build that reads the wiki   → search + ai + ai_hourly
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
      const { ref } = resolved;
      const name = WIKI_PROVIDER_NAMES[ref.provider];
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
            ? 'Add a Notion token in Settings → Workspace → Reference docs, then add the page again.'
            : `Add a ${name} API token in Settings → Workspace → Reference docs, then add the page again.`,
        );
      }
      if (cred.state === 'unreadable') return h.fail(reply, 400, 'NoWikiCredential', `Save the ${name} token again in Settings.`);
      const pre = await h.preflight(ctx, accountId, reply);
      if (pre) return pre;
      const depth = Math.max(0, Math.min(REFERENCE_DOC_WIKI_MAX_DEPTH, b.childDepth ?? 0));
      const url = b.url.trim();
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

  // ---- credentials (Settings → Workspace → Reference docs) ----
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
