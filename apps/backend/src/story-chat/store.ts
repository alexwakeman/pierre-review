// STORY CHAT — THE STORED CHATS (migration 0192; docs/STORY-CHAT.md § Saved chats). Every read and
// write is scoped by accountId; a chat id from a request resolves only within (account, workspace, ident).
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { StoryChatSummary, StoryChatTurn, StoryChatTurnStatus } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';

const c = schema.storyChats;
const t = schema.storyChatTurns;

export const STORY_CHAT_TITLE_MAX = 80;
export const STORY_CHAT_LIST_MAX = 30;

export function chatTitleOf(question: string): string {
  const one = question.replace(/\s+/g, ' ').trim();
  return one.length > STORY_CHAT_TITLE_MAX ? `${one.slice(0, STORY_CHAT_TITLE_MAX - 1).trimEnd()}…` : one;
}

const iso = (d: Date | null): string | null => (d == null ? null : d.toISOString());

export async function createChat(accountId: number, workspaceId: number, ident: string, question: string): Promise<number> {
  const [row] = await db
    .insert(c)
    .values({ accountId, workspaceId, ticketIdent: ident, title: chatTitleOf(question) })
    .returning({ id: c.id })
    .execute();
  return row!.id;
}

/** The chat when it is this account's, in this workspace, about this ticket; else null. */
export async function findChat(accountId: number, workspaceId: number, ident: string, chatId: number): Promise<{ id: number } | null> {
  const [row] = await db
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.id, chatId), eq(c.accountId, accountId), eq(c.workspaceId, workspaceId), eq(c.ticketIdent, ident)))
    .execute();
  return row ?? null;
}

/** The chat by id, this account's only. */
export async function chatById(accountId: number, chatId: number): Promise<StoryChatSummary | null> {
  const [row] = await db.select().from(c).where(and(eq(c.id, chatId), eq(c.accountId, accountId))).execute();
  if (!row) return null;
  const [n] = await db.select({ n: count() }).from(t).where(and(eq(t.chatId, chatId), eq(t.accountId, accountId))).execute();
  return summaryOf(row, n?.n ?? 0);
}

function summaryOf(row: typeof c.$inferSelect, turnCount: number): StoryChatSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ident: row.ticketIdent,
    title: row.title,
    turnCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The story's chats, newest first. */
export async function listChats(accountId: number, workspaceId: number, ident: string): Promise<StoryChatSummary[]> {
  const rows = await db
    .select()
    .from(c)
    .where(and(eq(c.accountId, accountId), eq(c.workspaceId, workspaceId), eq(c.ticketIdent, ident)))
    .orderBy(desc(c.updatedAt), desc(c.id))
    .limit(STORY_CHAT_LIST_MAX)
    .execute();
  if (rows.length === 0) return [];
  const counts = await db
    .select({ chatId: t.chatId, n: count() })
    .from(t)
    .where(and(eq(t.accountId, accountId), inArray(t.chatId, rows.map((r) => r.id))))
    .groupBy(t.chatId)
    .execute();
  const byChat = new Map(counts.map((x) => [x.chatId, x.n]));
  return rows.map((r) => summaryOf(r, byChat.get(r.id) ?? 0));
}

export async function listTurns(accountId: number, chatId: number): Promise<StoryChatTurn[]> {
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.chatId, chatId)))
    .orderBy(asc(t.id))
    .execute();
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    answer: r.answer,
    status: r.status as StoryChatTurnStatus,
    error: r.error,
    provider: r.provider,
    model: r.model,
    costUsd: r.costUsd,
    createdAt: r.createdAt.toISOString(),
    finishedAt: iso(r.finishedAt),
  }));
}

export async function startTurn(
  accountId: number,
  chatId: number,
  a: { question: string; provider: string; model: string },
): Promise<number> {
  const [row] = await db
    .insert(t)
    .values({ accountId, chatId, question: a.question, status: 'running', provider: a.provider, model: a.model })
    .returning({ id: t.id })
    .execute();
  await db.update(c).set({ updatedAt: new Date() }).where(and(eq(c.id, chatId), eq(c.accountId, accountId))).execute();
  return row!.id;
}

export async function finishTurn(
  accountId: number,
  turnId: number,
  a: { status: Exclude<StoryChatTurnStatus, 'running'>; answer: string | null; error: string | null; costUsd: number | null; inputTokens: number | null; outputTokens: number | null },
): Promise<void> {
  await db
    .update(t)
    .set({ ...a, finishedAt: new Date() })
    .where(and(eq(t.id, turnId), eq(t.accountId, accountId)))
    .execute();
}

/** A restart cut these turns off: they say so instead of running forever. */
export async function settleRunningTurns(): Promise<number> {
  const rows = await db
    .update(t)
    .set({ status: 'failed', error: 'Limn restarted before this answer finished.', finishedAt: new Date() })
    .where(eq(t.status, 'running'))
    .returning({ id: t.id })
    .execute();
  return rows.length;
}

export async function deleteChat(accountId: number, chatId: number): Promise<boolean> {
  await db.delete(t).where(and(eq(t.chatId, chatId), eq(t.accountId, accountId))).execute();
  const rows = await db.delete(c).where(and(eq(c.id, chatId), eq(c.accountId, accountId))).returning({ id: c.id }).execute();
  return rows.length > 0;
}
