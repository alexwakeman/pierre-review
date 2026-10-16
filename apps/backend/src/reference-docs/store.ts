import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
  ReferenceDoc,
  ReferenceDocCitation,
  ReferenceDocSectionEntry,
  ReferenceDocSourceKind,
  ReferenceDocStatus,
  ReferenceDocsChatMessage,
  ReferenceDocsConversationSummary,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import type { IndexEntry } from './render.js';

// THE REFERENCE DOCS' ROWS (migration 0116 / pg 0103; docs/REFERENCE-DOCS.md § Storage). Every read
// and write carries the ACCOUNT predicate; a document id from a request resolves only within it
// (→ null → 404). The workspace id is the second key: a list or the index never mixes two workspaces.

const docs = () => schema.referenceDocs;
const msgs = () => schema.referenceDocChatMessages;

export type DocRow = typeof schema.referenceDocs.$inferSelect;
export type ChatRow = typeof schema.referenceDocChatMessages.$inferSelect;

export const BUILDING_STATUSES: readonly ReferenceDocStatus[] = ['queued', 'converting', 'sectioning', 'indexing'];
export const isBuilding = (s: string): boolean => (BUILDING_STATUSES as readonly string[]).includes(s);

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : null);

export function toReferenceDoc(r: DocRow): ReferenceDoc {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    slug: r.slug,
    title: r.title,
    sourceKind: r.sourceKind as ReferenceDocSourceKind,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl ?? null,
    byteSize: r.byteSize,
    status: r.status as ReferenceDocStatus,
    progress: Math.max(0, Math.min(100, r.progress)),
    stage: r.stage ?? null,
    error: r.error ?? null,
    available: r.builtAt != null,
    sectionCount: r.sectionCount,
    summary: r.summary ?? null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    pageCount: r.pageCount ?? null,
    costUsd: r.costUsd ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    builtAt: iso(r.builtAt),
  };
}

export async function workspaceOwned(accountId: number, workspaceId: number): Promise<boolean> {
  const w = schema.workspaces;
  const rows = await db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute();
  return rows.length > 0;
}

export async function listDocRows(accountId: number, workspaceId: number): Promise<DocRow[]> {
  const t = docs();
  return db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .orderBy(asc(t.title), asc(t.id))
    .execute();
}

export async function getDocRow(accountId: number, id: number): Promise<DocRow | null> {
  const t = docs();
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.accountId, accountId)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

export async function getDocBySlug(accountId: number, workspaceId: number, slug: string): Promise<DocRow | null> {
  const t = docs();
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.slug, slug)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

export async function takenSlugs(accountId: number, workspaceId: number): Promise<Set<string>> {
  const t = docs();
  const rows = await db
    .select({ slug: t.slug })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute();
  return new Set(rows.map((r) => r.slug));
}

export interface NewDoc {
  accountId: number;
  workspaceId: number;
  slug: string;
  title: string;
  sourceKind: ReferenceDocSourceKind;
  sourceName: string;
  sourceUrl: string | null;
  byteSize: number;
  pageCount: number | null;
}

/** Insert a queued document. The composite FK refuses a workspace of another account. */
export async function insertDocRow(d: NewDoc): Promise<DocRow> {
  const now = new Date();
  const [row] = await db
    .insert(docs())
    .values({
      accountId: d.accountId,
      workspaceId: d.workspaceId,
      slug: d.slug,
      title: d.title,
      sourceKind: d.sourceKind,
      sourceName: d.sourceName,
      sourceUrl: d.sourceUrl,
      byteSize: d.byteSize,
      pageCount: d.pageCount,
      status: 'queued',
      progress: 0,
      stage: 'Waiting to start',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .execute();
  return row!;
}

export interface ProgressPatch {
  status?: ReferenceDocStatus;
  progress?: number;
  stage?: string | null;
  error?: string | null;
  byteSize?: number;
  pageCount?: number | null;
  buildStartedAt?: Date | null;
  sourceName?: string;
  sourceUrl?: string | null;
}

export async function patchDoc(accountId: number, id: number, patch: ProgressPatch): Promise<boolean> {
  const t = docs();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  if (typeof set.progress === 'number') set.progress = Math.max(0, Math.min(100, Math.round(set.progress as number)));
  const rows = await db
    .update(t)
    .set(set)
    .where(and(eq(t.id, id), eq(t.accountId, accountId)))
    .returning({ id: t.id })
    .execute();
  return rows.length > 0;
}

/** Requeue a document for a rebuild — only when no build of it is running (compare-and-set). */
export async function requeueDoc(accountId: number, id: number): Promise<boolean> {
  const t = docs();
  const rows = await db
    .update(t)
    .set({ status: 'queued', progress: 0, stage: 'Waiting to start', error: null, updatedAt: new Date() })
    .where(and(eq(t.id, id), eq(t.accountId, accountId), inArray(t.status, ['ready', 'failed'])))
    .returning({ id: t.id })
    .execute();
  return rows.length > 0;
}

export interface Telemetry {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns?: number | null;
}

const telemetrySet = (t: Telemetry): Record<string, unknown> => ({
  ...(t.costUsd !== undefined ? { costUsd: t.costUsd } : {}),
  ...(t.inputTokens !== undefined ? { inputTokens: t.inputTokens } : {}),
  ...(t.outputTokens !== undefined ? { outputTokens: t.outputTokens } : {}),
  ...(t.numTurns !== undefined ? { numTurns: t.numTurns } : {}),
});

export async function markDocFailed(accountId: number, id: number, error: string, t: Telemetry = {}): Promise<void> {
  const tb = docs();
  await db
    .update(tb)
    .set({ status: 'failed', progress: 0, stage: null, error: error.slice(0, 600), updatedAt: new Date(), ...telemetrySet(t) })
    .where(and(eq(tb.id, id), eq(tb.accountId, accountId)))
    .execute();
}

export interface BuiltDoc {
  title: string;
  summary: string;
  topics: string[];
  sections: ReferenceDocSectionEntry[];
}

export async function saveDocBuilt(accountId: number, id: number, b: BuiltDoc, t: Telemetry): Promise<void> {
  const tb = docs();
  const now = new Date();
  await db
    .update(tb)
    .set({
      status: 'ready',
      progress: 100,
      stage: null,
      error: null,
      title: b.title,
      summary: b.summary,
      topics: b.topics,
      sections: b.sections,
      sectionCount: b.sections.length,
      builtAt: now,
      updatedAt: now,
      ...telemetrySet(t),
    })
    .where(and(eq(tb.id, id), eq(tb.accountId, accountId)))
    .execute();
}

export async function deleteDocRow(accountId: number, id: number): Promise<DocRow | null> {
  const t = docs();
  const rows = await db
    .delete(t)
    .where(and(eq(t.id, id), eq(t.accountId, accountId)))
    .returning()
    .execute();
  return rows[0] ?? null;
}

/** INDEX.md's input: every document of the workspace with a built version on disk. */
export async function indexEntries(accountId: number, workspaceId: number): Promise<IndexEntry[]> {
  const t = docs();
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), isNotNull(t.builtAt)))
    .execute();
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    summary: r.summary ?? null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    sourceName: r.sourceName,
    sectionCount: r.sectionCount,
  }));
}

export async function countBuiltDocs(accountId: number, workspaceId: number): Promise<number> {
  const t = docs();
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), isNotNull(t.builtAt)))
    .execute();
  return Number(rows[0]?.n ?? 0);
}

/** A restart cut these builds off: fail them (Rebuild starts again; a built version stays readable). */
export async function reconcileInterruptedBuilds(): Promise<Array<{ id: number; accountId: number }>> {
  const t = docs();
  return db
    .update(t)
    .set({ status: 'failed', progress: 0, stage: null, error: 'Interrupted by a restart. Press Rebuild.', updatedAt: new Date() })
    .where(inArray(t.status, [...BUILDING_STATUSES]))
    .returning({ id: t.id, accountId: t.accountId })
    .execute();
}

/** Every (account, workspace) holding a document — the disk janitor's allow-list. */
export async function workspacesWithDocs(): Promise<Array<{ accountId: number; workspaceId: number; slug: string }>> {
  const t = docs();
  return db.select({ accountId: t.accountId, workspaceId: t.workspaceId, slug: t.slug }).from(t).execute();
}

// ---- the per-workspace setting (workspaces.docs_in_review) ----

/** May Claude Review read this workspace's library? Only a stored `true` is on. */
export async function readDocsInReview(accountId: number, workspaceId: number): Promise<boolean> {
  const w = schema.workspaces;
  const rows = await db
    .select({ on: w.docsInReview })
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute();
  return rows[0]?.on === true;
}

/** The ONE writer. False ⇒ the workspace is not this account's. */
export async function writeDocsInReview(accountId: number, workspaceId: number, on: boolean): Promise<boolean> {
  const w = schema.workspaces;
  const rows = await db
    .update(w)
    .set({ docsInReview: on })
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .returning({ id: w.id })
    .execute();
  return rows.length > 0;
}

// ---- the chat ----

export function toChatMessage(r: ChatRow): ReferenceDocsChatMessage {
  return {
    id: r.id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    text: r.content,
    citations: Array.isArray(r.citations) ? r.citations : [],
    createdAt: iso(r.createdAt)!,
    costUsd: r.costUsd ?? null,
  };
}

export async function conversationRows(accountId: number, workspaceId: number, conversationId: string): Promise<ChatRow[]> {
  const t = msgs();
  return db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.conversationId, conversationId)))
    .orderBy(asc(t.id))
    .execute();
}

export async function insertChatTurn(
  accountId: number,
  workspaceId: number,
  conversationId: string,
  question: string,
  answer: { text: string; citations: ReferenceDocCitation[] } & Telemetry,
): Promise<{ question: ChatRow; answer: ChatRow }> {
  const t = msgs();
  const now = Date.now();
  const [q] = await db
    .insert(t)
    .values({ accountId, workspaceId, conversationId, role: 'user', content: question, citations: [], createdAt: new Date(now) })
    .returning()
    .execute();
  const [a] = await db
    .insert(t)
    .values({
      accountId,
      workspaceId,
      conversationId,
      role: 'assistant',
      content: answer.text,
      citations: answer.citations,
      costUsd: answer.costUsd ?? null,
      inputTokens: answer.inputTokens ?? null,
      outputTokens: answer.outputTokens ?? null,
      createdAt: new Date(now + 1),
    })
    .returning()
    .execute();
  return { question: q!, answer: a! };
}

export async function listConversations(accountId: number, workspaceId: number, limit = 50): Promise<ReferenceDocsConversationSummary[]> {
  const t = msgs();
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .orderBy(desc(t.id))
    .limit(2_000)
    .execute();
  const byId = new Map<string, { first: ChatRow | null; count: number; updatedAt: Date }>();
  for (const r of rows) {
    const c = byId.get(r.conversationId) ?? { first: null, count: 0, updatedAt: r.createdAt };
    c.count += 1;
    if (r.role === 'user') c.first = r; // rows arrive newest first, so the last user row seen is the first question
    if (r.createdAt > c.updatedAt) c.updatedAt = r.createdAt;
    byId.set(r.conversationId, c);
  }
  return [...byId.entries()]
    .map(([conversationId, c]) => ({
      conversationId,
      title: (c.first?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      messageCount: c.count,
      updatedAt: c.updatedAt.toISOString(),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function deleteConversation(accountId: number, workspaceId: number, conversationId: string): Promise<number> {
  const t = msgs();
  const rows = await db
    .delete(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.conversationId, conversationId)))
    .returning({ id: t.id })
    .execute();
  return rows.length;
}
