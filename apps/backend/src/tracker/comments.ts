import { createHash } from 'node:crypto';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import {
  TICKET_COMMENTS_KEPT,
  TICKET_COMMENT_BODY_MAX,
  type TicketComment,
  type TrackerProvider,
} from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import type { FetchedTicketComment } from './types.js';
import { clipTicketField } from './clip.js';

// TICKET COMMENTS — the store (docs/TRACKERS.md § Ticket comments; table `tracker_ticket_comments`,
// migration 0141). Keyed per TICKET — (account, provider, api_root, issue_key) — never per PR.
//
// THE HOOK FOR AN ADAPTER: a reader returns `FetchedTicket.comments` (./types.ts
// `FetchedTicketComment[]`, bodies already MARKDOWN, `isBot` set by the adapter's own rule) in the same
// issue read; the worker calls `writeTicketComments` once per ticket per read. Nothing else in this
// file knows a provider. `undefined` (the answer did not carry comments) writes nothing.
//
//   writeTicketComments   keep the newest TICKET_COMMENTS_KEPT: upsert them, delete the ticket's others.
//   readTicketComments    one ticket's rows, OLDEST first (bots included — callers filter).
//   peopleComments        the rows a person reads and a model is given: bots out.
//   commentsSeenOf        what a ticket review stores about the comments it was given.
//   pruneOrphanComments   comments of tickets no PR row names any more (the worker's key prune).
//
// ⚠ A FAILED READ NEVER DELETES (CLAUDE.md: clear a column only on a positive statement). Only a read
// whose answer carried the comments — `[]` included — replaces what is stored.

export interface TicketIdentity {
  provider: TrackerProvider | string;
  apiRoot: string;
  issueKey: string;
}

export interface StoredTicketComment {
  commentId: string;
  authorName: string;
  authorId: string | null;
  isBot: boolean;
  body: string;
  createdAt: Date;
  updatedAt: Date | null;
}

const ms = (d: Date | number | null | undefined): number => (d == null ? 0 : d instanceof Date ? d.getTime() : Number(d));

/** The newest `TICKET_COMMENTS_KEPT` of a read, deduplicated by id, each body clipped. Pure. */
export function keptComments(comments: readonly FetchedTicketComment[]): FetchedTicketComment[] {
  const byId = new Map<string, FetchedTicketComment>();
  for (const c of comments) {
    const id = (c.id ?? '').trim();
    if (id === '' || !(c.createdAt instanceof Date) || Number.isNaN(c.createdAt.getTime())) continue;
    byId.set(id, { ...c, id: id.slice(0, 200) });
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, TICKET_COMMENTS_KEPT)
    .map((c) => ({
      ...c,
      authorName: clipTicketField(c.authorName ?? '', 200),
      authorId: c.authorId != null ? c.authorId.slice(0, 200) : null,
      body: clipTicketField(c.body ?? '', TICKET_COMMENT_BODY_MAX),
    }));
}

/**
 * Replace one ticket's stored comments with the newest of this read. Upserts on the composite
 * target, then deletes the ticket's rows not kept (older ones, or ones the tracker no longer has).
 * `comments === undefined` → nothing (the read did not carry them).
 */
export async function writeTicketComments(
  ctx: TrackerContext,
  accountId: number,
  ticket: TicketIdentity,
  comments: readonly FetchedTicketComment[] | undefined,
  now: Date,
): Promise<void> {
  if (comments === undefined) return;
  const t = ctx.schema.trackerTicketComments;
  const kept = keptComments(comments);
  for (const c of kept) {
    const values = {
      authorName: c.authorName,
      authorId: c.authorId,
      isBot: c.isBot,
      body: c.body,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      fetchedAt: now,
    };
    await ctx.db
      .insert(t)
      .values({
        accountId,
        provider: ticket.provider,
        apiRoot: ticket.apiRoot,
        issueKey: ticket.issueKey,
        commentId: c.id,
        ...values,
      })
      .onConflictDoUpdate({
        target: [t.accountId, t.provider, t.apiRoot, t.issueKey, t.commentId],
        set: { ...values },
      })
      .execute();
  }
  const ids = kept.map((c) => c.id);
  const where = [
    eq(t.accountId, accountId),
    eq(t.provider, ticket.provider),
    eq(t.apiRoot, ticket.apiRoot),
    eq(t.issueKey, ticket.issueKey),
  ];
  if (ids.length > 0) where.push(notInArray(t.commentId, ids));
  await ctx.db.delete(t).where(and(...where)).execute();
}

/** One ticket's stored comments, OLDEST first, this account only. Bots included. */
export async function readTicketComments(
  ctx: TrackerContext,
  accountId: number,
  ticket: TicketIdentity,
): Promise<StoredTicketComment[]> {
  const t = ctx.schema.trackerTicketComments;
  const rows = (await ctx.db
    .select({
      commentId: t.commentId,
      authorName: t.authorName,
      authorId: t.authorId,
      isBot: t.isBot,
      body: t.body,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.provider, ticket.provider),
        eq(t.apiRoot, ticket.apiRoot),
        eq(t.issueKey, ticket.issueKey),
      ),
    )
    .orderBy(asc(t.createdAt), asc(t.commentId))
    .execute()) as Array<StoredTicketComment & { createdAt: Date | number; updatedAt: Date | number | null }>;
  return rows.map((r) => ({
    ...r,
    isBot: Boolean(r.isBot),
    createdAt: new Date(ms(r.createdAt)),
    updatedAt: r.updatedAt == null ? null : new Date(ms(r.updatedAt)),
  }));
}

/** The comments a person reads and a model is given — every automation's left out. Order kept. */
export function peopleComments<T extends { isBot: boolean }>(rows: readonly T[]): T[] {
  return rows.filter((r) => !r.isBot);
}

/** A stored comment on the wire. */
export function toWireComment(c: StoredTicketComment): TicketComment {
  return {
    id: c.commentId,
    author: c.authorName,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt != null ? c.updatedAt.toISOString() : null,
    body: c.body,
  };
}

/** What a ticket review stores about the comments it was given: ids, count and a hash over
 *  id + edit time + body. ⚠ Never part of the run's fingerprint. Pure. */
export function commentsSeenOf(
  comments: ReadonlyArray<{ id: string; updatedAt: string | null; body: string }>,
): { ids: string[]; count: number; hash: string } {
  const ids = comments.map((c) => c.id);
  const hash = createHash('sha256')
    .update(comments.map((c) => `${c.id}\u0000${c.updatedAt ?? ''}\u0000${c.body}`).join('\u0001'), 'utf8')
    .digest('hex');
  return { ids, count: ids.length, hash };
}

/** How many of `current` a run that saw `seen` did not see (0 when it predates comment reading). */
export function newCommentsSince(
  seen: { ids: readonly string[] } | null | undefined,
  current: ReadonlyArray<{ id: string }>,
): number {
  if (seen == null || !Array.isArray(seen.ids)) return 0;
  const had = new Set(seen.ids);
  return current.filter((c) => !had.has(c.id)).length;
}

/**
 * Delete the comments of these tickets when NO `tracker_tickets` row of this account names them any
 * more (the worker pruned the last PR's key). A ticket still named by any PR keeps its comments.
 */
export async function pruneOrphanComments(
  ctx: TrackerContext,
  accountId: number,
  tickets: readonly TicketIdentity[],
): Promise<void> {
  if (tickets.length === 0) return;
  const tt = ctx.schema.trackerTickets;
  const t = ctx.schema.trackerTicketComments;
  const seen = new Set<string>();
  for (const k of tickets) {
    const id = `${k.provider}|${k.apiRoot}|${k.issueKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const still = (await ctx.db
      .select({ id: tt.id })
      .from(tt)
      .where(
        and(eq(tt.accountId, accountId), eq(tt.provider, k.provider), eq(tt.apiRoot, k.apiRoot), eq(tt.issueKey, k.issueKey)),
      )
      .limit(1)
      .execute()) as Array<{ id: number }>;
    if (still.length > 0) continue;
    await ctx.db
      .delete(t)
      .where(and(eq(t.accountId, accountId), eq(t.provider, k.provider), eq(t.apiRoot, k.apiRoot), eq(t.issueKey, k.issueKey)))
      .execute();
  }
}
