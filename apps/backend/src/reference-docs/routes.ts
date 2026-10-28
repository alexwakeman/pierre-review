import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  REFERENCE_DOCS_CHAT_MAX_QUESTION_CHARS,
  REFERENCE_DOC_CRAWL_MAX_DEPTH,
  REFERENCE_DOC_CRAWL_MAX_PAGES,
  REFERENCE_DOC_MAX_BYTES,
  type AddReferenceDocUrlBody,
  type ReferenceDocMutationResponse,
  type ReferenceDocSectionResponse,
  type ReferenceDocTreeResponse,
  type ReferenceDocsChatBody,
  type ReferenceDocsChatResponse,
  type ReferenceDocsConversationResponse,
  type ReferenceDocsConversationsResponse,
  type ReferenceDocsResponse,
  type ReferenceDocsSettings,
  type SetReferenceDocsSettingsBody,
} from '@pierre-review/shared';
import { resolveWorkspaceScope } from '../db/queries.js';
import type { AgentContext } from '../review/agent-context.js';
import { AGENTIC_AI_ENABLED } from '../review/claude-review/manager.js';
import { CONVERSATION_ID, DocsChatError, askDocs } from './chat.js';
import { pdfPageCount, sniffUpload } from './convert.js';
import { readIndex, readLibraryFile, removeDocFiles, saveSource, writeIndex } from './library.js';
import { loadDocsOwner } from './owner.js';
import { cancelBuild, enqueueBuild, subscribeDocBuild } from './manager.js';
import { parseLibraryPath, uniqueDocSlug } from './paths.js';
import {
  conversationRows,
  deleteConversation,
  deleteDocRow,
  getDocBySlug,
  getDocRow,
  insertDocRow,
  isBuilding,
  listConversations,
  listDocRows,
  readDocsInReview,
  requeueDoc,
  takenSlugs,
  toChatMessage,
  toReferenceDoc,
  workspaceOwned,
  writeDocsInReview,
  type NewDoc,
} from './store.js';
import { UrlFetchError, checkPageUrl } from './url-fetch.js';
import { deleteWikiPages } from './wiki/pages.js';
import { noteDocsUsed } from './wiki/refresh.js';
import { registerWikiDocRoutes } from './wiki/routes.js';
import { config } from '../config.js';
import { providerName } from '../ai/prompt-tools.js';

// THE REFERENCE DOCS API (CORE, free, LOCAL ONLY — docs/API.md § Reference docs). Registered by
// `registerAgenticRoutes` (review/agentic.ts), so absent in cloud and under LIMN_AI_DISABLED; the
// AGENTIC_AI_ENABLED checks are the second guard.
//
//   GET    /api/docs?workspace=                       the library: docs + status/progress     → read
//   POST   /api/docs/upload?workspace=                raw file body; starts a build            → ai + ai_hourly
//   POST   /api/docs/url                              { workspaceId?, url }; starts a build    → ai + ai_hourly
//   POST   /api/docs/:id/rebuild                      builds again from the stored source      → ai + ai_hourly
//   POST   /api/docs/:id/cancel                       stops a queued / running build           → read
//   DELETE /api/docs/:id                              removes the files + row, rewrites INDEX  → read
//   GET    /api/docs/:id/stream                       SSE progress while a build runs          → read
//   GET    /api/docs/tree?workspace=&doc=             INDEX.md (+ one doc's CONTENTS.md)       → read
//   GET    /api/docs/section?workspace=&path=         one library file, path-validated         → read
//   POST   /api/docs/chat                             one Sonnet answer                        → ai + ai_hourly
//   GET    /api/docs/chats?workspace=                 conversations                            → read
//   GET    /api/docs/chats/:conversationId?workspace= one conversation                         → read
//   DELETE /api/docs/chats/:conversationId?workspace= delete it                                → read
//   GET    /api/workspaces/:id/docs-settings          { docsInReview }                         → read
//   PUT    /api/workspaces/:id/docs-settings          { docsInReview }                         → read
//   + the wiki routes (wiki/routes.ts): POST /api/docs/wiki, POST /api/docs/:id/refresh, and
//     GET / PUT / POST …/check /api/workspaces/:id/wiki-credentials
//
// TENANCY: `?workspace=` (and a body's `workspaceId`) resolves through `resolveWorkspaceScope` —
// absent, unknown or another account's ⇒ this account's DEFAULT workspace, never a 404. A document id
// in a PATH resolves only within the account (→ 404). The settings route's workspace id is a PATH id
// (→ 404). The rows' composite FK refuses a cross-account workspace in the database.

/** At most this many documents per workspace. */
export const MAX_DOCS_PER_WORKSPACE = 200;
/** The raw upload body limit (the file cap plus slack for nothing else — the body IS the file). */
const UPLOAD_BODY_LIMIT = REFERENCE_DOC_MAX_BYTES + 1024;

type ErrorBody = { error: string; message: string };

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
};
const wsQuery = {
  querystring: { type: 'object', properties: { workspace: { type: 'string', maxLength: 20 } } },
};

function featureOff(reply: FastifyReply): ErrorBody {
  reply.status(404);
  return { error: 'NotFound', message: 'The reference library runs on your machine: npx limn-review' };
}

const fail = (reply: FastifyReply, status: number, error: string, message: string): ErrorBody => {
  reply.status(status);
  return { error, message };
};

async function workspaceOf(accountId: number, raw: unknown): Promise<number> {
  const v = typeof raw === 'number' || typeof raw === 'string' ? raw : null;
  return (await resolveWorkspaceScope(accountId, v)).workspaceId;
}

async function preflight(ctx: AgentContext, accountId: number, reply: FastifyReply): Promise<ErrorBody | null> {
  const auth = ctx.llm.detectAuth('docs_build');
  if (auth.status === 'none') return fail(reply, 400, 'NoClaudeAuth', auth.message ?? `No ${providerName()} credential found.`);
  return null;
}

/** The uploaded file's name from `x-limn-filename` (URI-encoded): a base name, printable, ≤ 200. */
export function uploadFileName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  name = name
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (name === '' || name === '.' || name === '..') return null;
  return name.slice(0, 200);
}

const titleFromName = (name: string): string =>
  name.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Document';

const titleFromUrl = (u: URL): string => {
  let path = u.pathname;
  try {
    path = decodeURIComponent(path); // a malformed escape (`%zz`) keeps the raw path
  } catch {
    /* keep raw */
  }
  path = path.replace(/\/+$/, '');
  const last = path.split('/').pop() ?? '';
  return (last ? `${u.hostname} – ${last.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[-_]+/g, ' ')}` : u.hostname).slice(0, 160);
};

/** Insert a row with a slug unique in the workspace (one retry for a concurrent add of the same name). */
async function insertWithSlug(base: Omit<NewDoc, 'slug'>): Promise<Awaited<ReturnType<typeof insertDocRow>>> {
  for (let attempt = 0; ; attempt++) {
    const slug = uniqueDocSlug(base.title, await takenSlugs(base.accountId, base.workspaceId));
    try {
      return await insertDocRow({ ...base, slug });
    } catch (err) {
      if (attempt >= 1 || (await getDocBySlug(base.accountId, base.workspaceId, slug)) == null) throw err;
    }
  }
}

export function registerReferenceDocsRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // The upload is the file's bytes, nothing else (no multipart dependency). Global, but no other route
  // takes this content type, and every route's own bodyLimit (256 KiB by default) still applies.
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }

  // Wiki sources (Confluence): add a page tree, refresh it, the workspace's wiki credential.
  registerWikiDocRoutes(app, ctx, { fail, featureOff, workspaceOf, preflight, insertWithSlug, maxDocs: MAX_DOCS_PER_WORKSPACE });

  app.get('/api/docs', { schema: wsQuery }, async (req, reply): Promise<ReferenceDocsResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const workspaceId = await workspaceOf(accountId, (req.query as { workspace?: string }).workspace);
    noteDocsUsed(accountId, workspaceId);
    const [rows, docsInReview] = await Promise.all([listDocRows(accountId, workspaceId), readDocsInReview(accountId, workspaceId)]);
    return { workspaceId, docs: rows.map(toReferenceDoc), docsInReview, maxBytes: REFERENCE_DOC_MAX_BYTES };
  });

  // ---- adding ----
  app.post(
    '/api/docs/upload',
    { schema: wsQuery, bodyLimit: UPLOAD_BODY_LIMIT },
    async (req, reply): Promise<ReferenceDocMutationResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        return fail(reply, 415, 'BadBody', 'Send the file as the request body, with Content-Type application/octet-stream.');
      }
      const name = uploadFileName(req.headers['x-limn-filename']);
      if (!name) return fail(reply, 400, 'NoFileName', 'Name the file in the X-Limn-Filename header.');
      const sniff = sniffUpload(body, name);
      if (!sniff.ok) return fail(reply, body.length > REFERENCE_DOC_MAX_BYTES ? 413 : 415, 'Unsupported', sniff.message);
      const pageCount = sniff.kind === 'pdf' ? pdfPageCount(body) : null;
      if (pageCount != null && pageCount > config.docsPdfMaxPages) {
        return fail(reply, 413, 'TooLong', `This PDF has ${pageCount} pages. The limit is ${config.docsPdfMaxPages}.`);
      }
      const workspaceId = await workspaceOf(accountId, (req.query as { workspace?: string }).workspace);
      if ((await listDocRows(accountId, workspaceId)).length >= MAX_DOCS_PER_WORKSPACE) {
        return fail(reply, 409, 'LibraryFull', `A workspace holds at most ${MAX_DOCS_PER_WORKSPACE} documents. Remove one first.`);
      }
      const pre = await preflight(ctx, accountId, reply);
      if (pre) return pre;
      const row = await insertWithSlug({
        accountId,
        workspaceId,
        title: titleFromName(name),
        sourceKind: sniff.kind,
        sourceName: name,
        sourceUrl: null,
        byteSize: body.length,
        pageCount,
      });
      // The `.owner` marker goes in with the first file (owner.ts): know this database's id first.
      await loadDocsOwner().catch(() => null);
      try {
        saveSource(accountId, workspaceId, row.slug, body, sniff.ext);
      } catch (err) {
        // A row with no stored source could never build: take it back out.
        await deleteDocRow(accountId, row.id).catch(() => null);
        ctx.log.warn(`reference doc upload: could not store the file: ${err instanceof Error ? err.message : String(err)}`);
        return fail(reply, 500, 'StoreFailed', 'The file could not be saved on this machine.');
      }
      enqueueBuild(ctx, accountId, workspaceId, row.id);
      reply.status(202);
      return { doc: toReferenceDoc(row) };
    },
  );

  app.post(
    '/api/docs/url',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          additionalProperties: false,
          properties: {
            workspaceId: { type: 'integer', minimum: 1 },
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            // "Follow links" (docs/REFERENCE-DOCS.md § Following links). Absent = this page only.
            crawl: {
              type: 'object',
              additionalProperties: false,
              required: ['depth'],
              properties: { depth: { type: 'integer', minimum: 1, maximum: REFERENCE_DOC_CRAWL_MAX_DEPTH } },
            },
          },
        },
      },
    },
    async (req, reply): Promise<ReferenceDocMutationResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const b = req.body as AddReferenceDocUrlBody;
      let url: URL;
      try {
        url = checkPageUrl(b.url);
      } catch (err) {
        return fail(reply, 400, 'BadUrl', err instanceof UrlFetchError ? err.message : 'That is not a web address.');
      }
      const workspaceId = await workspaceOf(accountId, b.workspaceId);
      if ((await listDocRows(accountId, workspaceId)).length >= MAX_DOCS_PER_WORKSPACE) {
        return fail(reply, 409, 'LibraryFull', `A workspace holds at most ${MAX_DOCS_PER_WORKSPACE} documents. Remove one first.`);
      }
      const pre = await preflight(ctx, accountId, reply);
      if (pre) return pre;
      // The page is fetched by the BUILD (its "converting" stage), so this answers at once.
      const row = await insertWithSlug({
        accountId,
        workspaceId,
        title: titleFromUrl(url),
        sourceKind: 'url',
        sourceName: url.href,
        sourceUrl: url.href,
        byteSize: 0,
        pageCount: null,
        crawl: b.crawl ? { depth: b.crawl.depth, maxPages: REFERENCE_DOC_CRAWL_MAX_PAGES, pages: null, skipped: null } : null,
      });
      enqueueBuild(ctx, accountId, workspaceId, row.id);
      reply.status(202);
      return { doc: toReferenceDoc(row) };
    },
  );

  // ---- one document ----
  app.post('/api/docs/:id/rebuild', { schema: idParam }, async (req, reply): Promise<ReferenceDocMutationResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const { id } = req.params as { id: number };
    const row = await getDocRow(accountId, id);
    if (!row) return fail(reply, 404, 'NotFound', `Document ${id} not found`);
    if (isBuilding(row.status)) return fail(reply, 409, 'Building', 'This document is already being built.');
    const pre = await preflight(ctx, accountId, reply);
    if (pre) return pre;
    if (!(await requeueDoc(accountId, id))) return fail(reply, 409, 'Building', 'This document is already being built.');
    // Rebuild = from scratch: a wiki document reads every page again and summarises afresh.
    enqueueBuild(ctx, accountId, row.workspaceId, id, { full: true });
    reply.status(202);
    return { doc: toReferenceDoc((await getDocRow(accountId, id))!) };
  });

  app.post('/api/docs/:id/cancel', { schema: idParam }, async (req, reply): Promise<ReferenceDocMutationResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const { id } = req.params as { id: number };
    const row = await getDocRow(accountId, id);
    if (!row) return fail(reply, 404, 'NotFound', `Document ${id} not found`);
    await cancelBuild(accountId, id);
    return { doc: toReferenceDoc((await getDocRow(accountId, id)) ?? row) };
  });

  app.delete('/api/docs/:id', { schema: idParam }, async (req, reply): Promise<{ deleted: true; id: number } | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const { id } = req.params as { id: number };
    const row = await getDocRow(accountId, id);
    if (!row) return fail(reply, 404, 'NotFound', `Document ${id} not found`);
    await cancelBuild(accountId, id);
    // A wiki document's page rows (the composite FK cascades too; explicit anyway).
    await deleteWikiPages(accountId, id);
    const gone = await deleteDocRow(accountId, id);
    if (!gone) return fail(reply, 404, 'NotFound', `Document ${id} not found`);
    removeDocFiles(accountId, gone.workspaceId, gone.slug);
    await writeIndex(accountId, gone.workspaceId);
    return { deleted: true, id };
  });

  // ---- live progress (SSE, a GET: `req.raw.on('close')` is the right signal here) ----
  app.get('/api/docs/:id/stream', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    // OWNERSHIP BEFORE hijack: the subscription keys on the document id alone.
    const row = AGENTIC_AI_ENABLED ? await getDocRow(accountId, id) : null;
    if (!row) return reply.code(404).send({ error: 'NotFound', message: `Document ${id} not found` });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data: unknown): void => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!raw.writableEnded) raw.end();
    };
    unsubscribe = subscribeDocBuild(id, (e) => {
      send(e);
      if (e.type === 'done') cleanup();
    });
    req.raw.on('close', cleanup);
    const snap = (await getDocRow(accountId, id)) ?? row;
    send({ type: 'snapshot', docId: id, status: snap.status, progress: snap.progress, stage: snap.stage ?? null });
    if (!isBuilding(snap.status)) {
      send({ type: 'done', docId: id, status: snap.status, error: snap.error ?? null });
      cleanup();
    }
  });

  // ---- reading the tree ----
  app.get(
    '/api/docs/tree',
    { schema: { querystring: { type: 'object', properties: { workspace: { type: 'string', maxLength: 20 }, doc: { type: 'integer', minimum: 1 } } } } },
    async (req, reply): Promise<ReferenceDocTreeResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const q = req.query as { workspace?: string; doc?: number };
      const workspaceId = await workspaceOf(accountId, q.workspace);
      noteDocsUsed(accountId, workspaceId);
      const index = await readIndex(accountId, workspaceId);
      if (q.doc == null) return { workspaceId, index, doc: null, contents: null, sections: [] };
      const row = await getDocRow(accountId, q.doc);
      if (!row || row.workspaceId !== workspaceId) return fail(reply, 404, 'NotFound', `Document ${q.doc} not found`);
      const contents =
        row.builtAt != null ? readLibraryFile(accountId, workspaceId, { kind: 'contents', path: `${row.slug}/CONTENTS.md`, slug: row.slug }) : null;
      return { workspaceId, index, doc: toReferenceDoc(row), contents, sections: row.builtAt != null ? (row.sections ?? []) : [] };
    },
  );

  app.get(
    '/api/docs/section',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['path'],
          properties: { workspace: { type: 'string', maxLength: 20 }, path: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req, reply): Promise<ReferenceDocSectionResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const q = req.query as { workspace?: string; path: string };
      const parsed = parseLibraryPath(q.path);
      if (!parsed) return fail(reply, 400, 'BadPath', 'Not a library path.');
      const workspaceId = await workspaceOf(accountId, q.workspace);
      const lp = parsed.path;
      if (lp.kind === 'index') {
        const markdown = await readIndex(accountId, workspaceId);
        return { workspaceId, path: lp.path, docId: null, docSlug: null, docTitle: null, title: 'Reference library', markdown, prev: null, next: null };
      }
      const row = await getDocBySlug(accountId, workspaceId, lp.slug);
      if (!row || row.builtAt == null) return fail(reply, 404, 'NotFound', 'No such document in this workspace.');
      const markdown = readLibraryFile(accountId, workspaceId, lp);
      if (markdown == null) return fail(reply, 404, 'NotFound', 'No such section.');
      const sections = row.sections ?? [];
      const at = lp.kind === 'section' ? sections.findIndex((s) => s.path === lp.path) : -1;
      return {
        workspaceId,
        path: lp.path,
        docId: row.id,
        docSlug: row.slug,
        docTitle: row.title,
        title: at >= 0 ? sections[at]!.title : row.title,
        markdown,
        prev: at > 0 ? sections[at - 1]!.path : null,
        next: at >= 0 && at < sections.length - 1 ? sections[at + 1]!.path : null,
      };
    },
  );

  // ---- the chat ----
  app.post(
    '/api/docs/chat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          additionalProperties: false,
          properties: {
            workspaceId: { type: 'integer', minimum: 1 },
            conversationId: { type: ['string', 'null'], maxLength: 64 },
            question: { type: 'string', minLength: 1, maxLength: REFERENCE_DOCS_CHAT_MAX_QUESTION_CHARS },
          },
        },
      },
    },
    async (req, reply): Promise<ReferenceDocsChatResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const b = req.body as ReferenceDocsChatBody;
      const question = b.question.trim();
      if (question === '') return fail(reply, 400, 'EmptyQuestion', 'Ask a question.');
      const workspaceId = await workspaceOf(accountId, b.workspaceId);
      noteDocsUsed(accountId, workspaceId);
      // ⚠ A POST's REQUEST `close` fires once the body is read — watch the REPLY socket instead.
      const gone = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) gone.abort();
      };
      reply.raw.on('close', onClose);
      try {
        return await askDocs(ctx, { accountId, workspaceId, conversationId: b.conversationId ?? null, question, signal: gone.signal });
      } catch (err) {
        if (err instanceof DocsChatError) return fail(reply, err.status, err.code, err.message);
        throw err;
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  app.get('/api/docs/chats', { schema: wsQuery }, async (req, reply): Promise<ReferenceDocsConversationsResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const workspaceId = await workspaceOf(accountId, (req.query as { workspace?: string }).workspace);
    return { workspaceId, conversations: await listConversations(accountId, workspaceId) };
  });

  const convParams = {
    params: { type: 'object', required: ['conversationId'], properties: { conversationId: { type: 'string', maxLength: 64 } } },
    querystring: wsQuery.querystring,
  };
  const conversationOf = async (req: FastifyRequest): Promise<{ accountId: number; workspaceId: number; conversationId: string | null }> => {
    const accountId = ctx.accountIdOf(req);
    const { conversationId } = req.params as { conversationId: string };
    const workspaceId = await workspaceOf(accountId, (req.query as { workspace?: string }).workspace);
    return { accountId, workspaceId, conversationId: CONVERSATION_ID.test(conversationId) ? conversationId : null };
  };

  app.get('/api/docs/chats/:conversationId', { schema: convParams }, async (req, reply): Promise<ReferenceDocsConversationResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const c = await conversationOf(req);
    if (!c.conversationId) return fail(reply, 400, 'BadConversation', 'Not a conversation id.');
    const rows = await conversationRows(c.accountId, c.workspaceId, c.conversationId);
    if (rows.length === 0) return fail(reply, 404, 'NotFound', 'No such conversation.');
    return { workspaceId: c.workspaceId, conversationId: c.conversationId, messages: rows.map(toChatMessage) };
  });

  app.delete('/api/docs/chats/:conversationId', { schema: convParams }, async (req, reply): Promise<{ deleted: number } | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const c = await conversationOf(req);
    if (!c.conversationId) return fail(reply, 400, 'BadConversation', 'Not a conversation id.');
    const deleted = await deleteConversation(c.accountId, c.workspaceId, c.conversationId);
    if (deleted === 0) return fail(reply, 404, 'NotFound', 'No such conversation.');
    return { deleted };
  });

  // ---- the per-workspace setting ----
  app.get('/api/workspaces/:id/docs-settings', { schema: idParam }, async (req, reply): Promise<ReferenceDocsSettings | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const accountId = ctx.accountIdOf(req);
    const { id } = req.params as { id: number };
    if (!(await workspaceOwned(accountId, id))) return fail(reply, 404, 'NotFound', `Workspace ${id} not found`);
    return { workspaceId: id, docsInReview: await readDocsInReview(accountId, id) };
  });

  app.put(
    '/api/workspaces/:id/docs-settings',
    {
      schema: {
        ...idParam,
        body: { type: 'object', required: ['docsInReview'], additionalProperties: false, properties: { docsInReview: { type: 'boolean' } } },
      },
    },
    async (req, reply): Promise<ReferenceDocsSettings | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const accountId = ctx.accountIdOf(req);
      const { id } = req.params as { id: number };
      const { docsInReview } = req.body as SetReferenceDocsSettingsBody;
      if (!(await writeDocsInReview(accountId, id, docsInReview))) return fail(reply, 404, 'NotFound', `Workspace ${id} not found`);
      return { workspaceId: id, docsInReview };
    },
  );
}
