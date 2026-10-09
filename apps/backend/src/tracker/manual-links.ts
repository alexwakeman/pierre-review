import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  TICKET_REFS_MAX,
  TICKET_REF_MAX_CHARS,
  parseTicketRef,
  refDedupeKey,
  trackerTicketIdent,
  type ResolveTicketRefsBody,
  type ResolveTicketRefsResponse,
  type TicketRefResult,
  type TicketRefStatus,
  type TrackerProvider,
} from '@pierre-review/shared';
import { githubAccessFor, type TrackerContext } from './context.js';
import { detectPrTickets } from './enricher.js';
import { adapterFor, ticketUrl } from './registry.js';
import { MSG_NO_READING_TRACKER, prepareTrackerCall } from './calls.js';
import { trackerBaseUrl } from './settings.js';
import { ownedPr } from './stories.js';
import { JiraFetchError, type JiraTransport } from './jira/fetch.js';
import { hasContent, readStoredTickets, upsertTicketRow, type StoredTicketRow } from './store.js';
import { backoffCode, accessFingerprint, syncOnePrNow } from './worker.js';
import type { TrackerCall } from './types.js';

// ── ADDING A TICKET BY HAND (docs/TRACKERS.md § Adding a ticket by hand) ─────────────────────────
//
//   POST /api/prs/:id/tracker-ticket/resolve   { refs: string[], link: boolean }
//
// The Story check's paste box. Each reference (a ticket URL or key, shared `parseTicketRef`) is
// decided against the PR's OWN WORKSPACE tracker — a link for another tracker or another site is
// refused with a sentence, never read with this workspace's token. Then:
//
//   link: false   READ each ticket once (the chips' "found: <title>"), nothing stored.
//   link: true    STORE each one as a `tracker_tickets` row with `detected_from = 'manual'`, read
//                 through the WORKER'S OWN PATH (`syncOnePrNow`, so the criteria field, the error
//                 states and the backoff are the worker's). Detection unions those rows
//                 (`manualKeysOf`), so from then on the ticket is one of the PR's tickets everywhere —
//                 the chips, the Open PRs row, the ticket review's members and its `{prId, ident}`
//                 start — and the worker's prune keeps it. A ticket that cannot be read is NOT kept.
//
// ⚠ THIS WIDENS "NOT A TRACKER PROXY" ON PURPOSE, AND ONLY THIS FAR: the other ticket routes answer
// only for a key detection found on the PR; this one reads a key a PERSON NAMED, on the workspace's
// own site, with the workspace's own credential, at most TICKET_REFS_MAX per request on the `search`
// rate-limit tier (`tierFor`). It never reads another site and never returns the tracker's body.

/** The most tickets one PR may carry by hand. */
export const MANUAL_LINKS_PER_PR = 20;
// A manual row sorts after everything detection found.
const MANUAL_ORDER_BASE = 1000;

/** An http(s) link, or null (the SPA still runs every link through `safeExternalUrl`). */
function safeHttpsUrl(url: string | null): string | null {
  return url != null && /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

const TRACKER_NAME: Record<TrackerProvider, string> = { jira: 'Jira', github: 'GitHub Issues', linear: 'Linear' };

type Decided = { key: string } | { status: TicketRefStatus; message: string };

/** One parsed reference against the workspace's tracker → a key it stores, or a refusal. */
export function decideRef(
  raw: string,
  call: Pick<TrackerCall, 'provider' | 'apiRoot'>,
  prRepo: { owner: string; name: string } | null,
): Decided {
  const provider = call.provider;
  const adapter = adapterFor(provider);
  const here = TRACKER_NAME[provider];
  const p = parseTicketRef(raw);
  const own = (key: string): Decided => {
    const k = adapter.normalizeKey(key);
    return k != null && adapter.isKey(k) ? { key: k } : { status: 'invalid', message: 'Not a ticket link or key.' };
  };
  switch (p.kind) {
    case 'invalid':
      return { status: 'invalid', message: 'Not a ticket link or key.' };
    case 'issue_number':
      if (provider !== 'github') {
        return { status: 'other_tracker', message: `#${p.number} is a GitHub issue. This workspace’s tickets are in ${here}.` };
      }
      if (prRepo == null) return { status: 'invalid', message: 'Paste the issue link or owner/repo#12.' };
      return own(`${prRepo.owner}/${prRepo.name}#${p.number}`);
    case 'key':
      if (p.shape === 'github' && provider !== 'github') {
        return { status: 'other_tracker', message: `${p.key} is a GitHub issue. This workspace’s tickets are in ${here}.` };
      }
      if (p.shape === 'prefix' && provider === 'github') {
        return { status: 'other_tracker', message: `${p.key} is not a GitHub issue. Paste the issue link or owner/repo#12.` };
      }
      return own(p.key);
    case 'url': {
      if (p.provider !== provider) {
        return { status: 'other_tracker', message: `That is a ${TRACKER_NAME[p.provider]} link. This workspace’s tickets are in ${here}.` };
      }
      const sameSite = p.loose
        ? call.apiRoot.toLowerCase() === p.root.toLowerCase() || call.apiRoot.toLowerCase().startsWith(`${p.root.toLowerCase()}/`)
        : call.apiRoot.toLowerCase() === p.root.toLowerCase();
      if (!sameSite) {
        return {
          status: 'other_tracker',
          message:
            provider === 'linear'
              ? 'That link is for another Linear workspace than this one’s.'
              : `That link is for another ${here} site than this workspace’s.`,
        };
      }
      return own(p.key);
    }
  }
}

function errorStatus(code: string): TicketRefStatus {
  return code === 'not_found' ? 'not_found' : code === 'forbidden' || code === 'no_access' ? 'no_access' : 'failed';
}

/** A failure → our own sentence (the adapter's), never anything the tracker sent. */
function failure(provider: TrackerProvider, key: string, code: string, err?: unknown): Pick<TicketRefResult, 'status' | 'message'> {
  const status = errorStatus(code);
  if (status === 'not_found') return { status, message: `${TRACKER_NAME[provider]} has no ${key}, or this workspace cannot see it.` };
  if (status === 'no_access') return { status, message: `This workspace’s ${TRACKER_NAME[provider]} access cannot read ${key}.` };
  const e = err ?? new JiraFetchError(code as ConstructorParameters<typeof JiraFetchError>[0]);
  return { status, message: adapterFor(provider).reader?.errorMessage(e) ?? 'Could not read the ticket just now.' };
}

async function repoOf(
  ctx: TrackerContext,
  accountId: number,
  repoId: number,
): Promise<{ owner: string; name: string } | null> {
  const r = ctx.schema.repos;
  const rows = (await ctx.db
    .select({ owner: r.owner, name: r.name })
    .from(r)
    .where(and(eq(r.accountId, accountId), eq(r.id, repoId)))
    .limit(1)
    .execute()) as Array<{ owner: string; name: string }>;
  return rows[0] ?? null;
}

export type ResolveOutcome =
  | { ok: true; body: ResolveTicketRefsResponse }
  | { ok: false; status: number; error: string; message: string };

/** The route's body, testable without Fastify. Never throws for a tracker failure. */
export async function resolveTicketRefs(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  input: ResolveTicketRefsBody,
  opts: { transport?: JiraTransport; now?: () => number } = {},
): Promise<ResolveOutcome> {
  const now = opts.now ?? Date.now;
  // Deduplicated by spelling (a Set, one key per ref); the cap answers with our own message.
  // ⚠ BOUNDED BEFORE ANY WORK: the loop stops at the first ref past the cap, so a body packed
  // with thousands of strings costs at most TICKET_REFS_MAX + 1 dedupe keys, never a quadratic scan.
  const refs: string[] = [];
  const seenKeys = new Set<string>();
  for (const r of input.refs) {
    const t = r.trim();
    if (t === '') continue;
    const k = refDedupeKey(t);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    refs.push(t);
    if (refs.length > TICKET_REFS_MAX) {
      return { ok: false, status: 400, error: 'TooManyRefs', message: `At most ${TICKET_REFS_MAX} tickets at a time.` };
    }
  }
  if (refs.length === 0) return { ok: false, status: 400, error: 'NoRefs', message: 'Paste a ticket link or key.' };
  const pr = await ownedPr(ctx, accountId, prId);
  if (pr == null) return { ok: false, status: 404, error: 'NotFound', message: `PR ${prId} not found` };
  const found = await detectPrTickets(ctx, accountId, pr);
  if (found == null) return { ok: false, status: 400, error: 'NotJira', message: MSG_NO_READING_TRACKER };
  const prepared = prepareTrackerCall(found.access, {
    cloud: ctx.host.isCloud,
    transport: opts.transport,
    github: githubAccessFor(ctx, accountId),
  });
  if (!prepared.ok) return { ok: false, status: prepared.status, error: prepared.error, message: prepared.message };
  const call = prepared.call;
  const { provider, apiRoot } = call;
  const adapter = adapterFor(provider);
  const base = trackerBaseUrl(found.access.issue);
  const linkOf = (key: string, stored?: string | null): string | null =>
    safeHttpsUrl(stored ?? null) ?? (base != null ? safeHttpsUrl(ticketUrl(provider, base, key)) : null);
  const prRepo = refs.some((r) => /^#\d/.test(r.trim())) ? await repoOf(ctx, accountId, pr.repoId) : null;

  const results: TicketRefResult[] = refs.map((ref) => ({
    ref,
    status: 'invalid',
    key: null,
    ident: null,
    title: null,
    url: null,
    message: null,
  }));
  // key → the indexes of the references naming it (two spellings of one ticket are read once).
  const byKey = new Map<string, number[]>();
  refs.forEach((ref, i) => {
    const d = decideRef(ref, call, prRepo);
    const res = results[i]!;
    if ('key' in d) {
      res.key = d.key;
      res.ident = trackerTicketIdent(provider, apiRoot, d.key);
      byKey.set(d.key, [...(byKey.get(d.key) ?? []), i]);
    } else {
      res.status = d.status;
      res.message = d.message;
    }
  });
  const setAll = (key: string, patch: Partial<TicketRefResult>): void => {
    for (const i of byKey.get(key) ?? []) Object.assign(results[i]!, patch);
  };
  const rowsNow = async (): Promise<StoredTicketRow[]> =>
    (await readStoredTickets(ctx, accountId, [prId])).filter((r) => r.provider === provider && r.apiRoot === apiRoot);

  // Already one of the PR's tickets: answered from its stored row (read once if it has none).
  const already = [...byKey.keys()].filter((k) => found.keys.includes(k));
  if (already.length > 0) {
    let rows = await rowsNow();
    const unread = already.filter((k) => !rows.some((r) => r.issueKey === k && hasContent(r)));
    if (unread.length > 0) {
      await syncOnePrNow(ctx, accountId, prId, unread, { force: false, transport: opts.transport, now: opts.now });
      rows = await rowsNow();
    }
    for (const k of already) {
      const row = rows.find((r) => r.issueKey === k);
      setAll(k, { status: 'already', title: row != null && hasContent(row) ? row.title : null, url: linkOf(k, row?.url) });
    }
  }
  const fresh = [...byKey.keys()].filter((k) => !found.keys.includes(k));
  if (fresh.length === 0) return { ok: true, body: { prId, provider, results } };

  if (!input.link) {
    // PREVIEW: read each ticket once with the workspace's credential; nothing is stored.
    for (const key of fresh) {
      try {
        const issue = await adapter.reader!.fetchTicket(call, key);
        setAll(key, { status: 'found', title: issue.title, url: linkOf(key, issue.url) });
      } catch (err) {
        const code = err instanceof JiraFetchError ? err.code : 'unknown';
        ctx.log.warn({ accountId, workspaceId: found.workspaceId, code, route: 'ticket-resolve' }, 'tracker request failed');
        setAll(key, { ...failure(provider, key, code, err), url: linkOf(key) });
      }
    }
    return { ok: true, body: { prId, provider, results } };
  }

  // LINK: a placeholder 'manual' row per key, then the worker's own read of exactly those keys.
  const existingManual = (await rowsNow()).filter((r) => r.detectedFrom === 'manual').length;
  const room = Math.max(0, MANUAL_LINKS_PER_PR - existingManual);
  const toLink = fresh.slice(0, room);
  for (const key of fresh.slice(room)) {
    setAll(key, { status: 'failed', message: `A pull request can have ${MANUAL_LINKS_PER_PR} tickets added by hand.` });
  }
  if (toLink.length === 0) return { ok: true, body: { prId, provider, results } };
  const at = new Date(now());
  for (const [i, key] of toLink.entries()) {
    await upsertTicketRow(ctx, accountId, prId, key, {
      workspaceId: found.workspaceId,
      provider,
      detectedFrom: 'manual',
      detectOrder: MANUAL_ORDER_BASE + existingManual + i,
      apiRoot,
      url: base != null ? ticketUrl(provider, base, key) : '',
      state: 'failed',
      errorCode: null,
      title: null,
      description: null,
      acceptanceCriteria: null,
      acFieldId: null,
      acFieldName: null,
      acFieldSource: null,
      issueTypeId: null,
      issueTypeName: null,
      statusName: null,
      statusCategory: null,
      assigneeName: null,
      assigneeAccountId: null,
      assigneeAvatarUrl: null,
      candidatesJson: null,
      omittedCandidates: 0,
      fetchedAt: null,
      checkedAt: at,
      // Due now: the read below takes it.
      nextCheckAt: new Date(0),
    });
  }
  await syncOnePrNow(ctx, accountId, prId, toLink, { force: true, transport: opts.transport, now: opts.now });
  const rows = await rowsNow();
  const t = ctx.schema.trackerTickets;
  for (const key of toLink) {
    const row = rows.find((r) => r.issueKey === key);
    if (row != null && row.state === 'ok' && hasContent(row)) {
      setAll(key, { status: 'linked', title: row.title, url: linkOf(key, row.url) });
      continue;
    }
    // Not readable: the link is not kept (a pasted typo must not become one of the PR's tickets).
    const code = row?.errorCode ?? backoffCode(accountId, found.workspaceId, accessFingerprint(call), now()) ?? 'network';
    if (row != null) {
      await ctx.db
        .delete(t)
        .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.id, row.id), eq(t.detectedFrom, 'manual')))
        .execute();
    }
    setAll(key, { ...failure(provider, key, code), url: linkOf(key) });
  }
  return { ok: true, body: { prId, provider, results } };
}

/**
 * Remove a ticket a person ADDED BY HAND from one PR. Deletes ONLY this account's `'manual'` rows for
 * (prId, key) — a detected ticket is not removable (detection would name it again on the next read),
 * so the PR pane offers this only on `TicketRef.manual`. DB-only, no tracker call.
 */
export async function removeManualTicket(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  rawKey: string,
): Promise<{ ok: true; removed: number } | { ok: false; status: number; error: string; message: string }> {
  const pr = await ownedPr(ctx, accountId, prId);
  if (pr == null) return { ok: false, status: 404, error: 'NotFound', message: `PR ${prId} not found` };
  const raw = rawKey.trim();
  if (raw === '') return { ok: false, status: 400, error: 'NoKey', message: 'Name the ticket to remove.' };
  // Every provider's spelling of the key (Jira/Linear upper-case, GitHub Issues lower-case).
  const keys = [...new Set([raw, raw.toUpperCase(), raw.toLowerCase()])];
  const t = ctx.schema.trackerTickets;
  let removed = 0;
  for (const key of keys) {
    removed += (
      await ctx.db
        .delete(t)
        .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.issueKey, key), eq(t.detectedFrom, 'manual')))
        .returning({ id: t.id })
        .execute()
    ).length;
  }
  return { ok: true, removed };
}

export function registerManualTicketLinkRoute(
  app: FastifyInstance,
  ctx: TrackerContext,
  opts: { transport?: JiraTransport } = {},
): void {
  app.post<{ Params: { id: number }; Body: ResolveTicketRefsBody }>(
    '/api/prs/:id/tracker-ticket/resolve',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        body: {
          type: 'object',
          required: ['refs', 'link'],
          additionalProperties: false,
          properties: {
            // A loose bound (5x the cap) so a packed body is refused by the schema; a count between
            // the cap and this bound answers with our own message (resolveTicketRefs).
            refs: { type: 'array', maxItems: TICKET_REFS_MAX * 5, items: { type: 'string', maxLength: TICKET_REF_MAX_CHARS } },
            link: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply): Promise<ResolveTicketRefsResponse | FastifyReply> => {
      const out = await resolveTicketRefs(ctx, ctx.accountIdOf(req), req.params.id, req.body, opts);
      if (!out.ok) return reply.code(out.status).send({ error: out.error, message: out.message });
      return out.body;
    },
  );

  // Remove a hand-added ticket (`TicketRef.manual`). The key rides the query string: a GitHub
  // Issues key (`owner/repo#12`) carries a `/` and a `#`.
  app.delete<{ Params: { id: number }; Querystring: { key: string } }>(
    '/api/prs/:id/tracker-ticket/manual',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        querystring: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', minLength: 1, maxLength: TICKET_REF_MAX_CHARS } },
        },
      },
    },
    async (req, reply): Promise<{ removed: number } | FastifyReply> => {
      const out = await removeManualTicket(ctx, ctx.accountIdOf(req), req.params.id, req.query.key);
      if (!out.ok) return reply.code(out.status).send({ error: out.error, message: out.message });
      return { removed: out.removed };
    },
  );
}
