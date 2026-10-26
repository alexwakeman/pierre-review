import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  SPRINT_BRIEF_MODEL,
  SPRINT_CODE_JUDGE_VERSION,
  type SprintCodeJudgement,
  type TrackerProvider,
} from '@pierre-review/shared';
import { sprintCriteriaOf } from './sprint-briefs.js';

// THIS SPRINT → "NEEDS CODE" — THE STORE HALF (docs/CLAUDE-REVIEW.md § Sprint code judgements). ONE
// builder of what the judgement is SENT (`sprintCodeJudgeInput`) and therefore of which stored judgement
// is CURRENT: a row counts only while its `text_hash` equals today's hash of today's text AND its
// `judge_version` is SPRINT_CODE_JUDGE_VERSION. The pass (review/sprint-code/) writes; the graph
// (db/sprint-graph.ts) reads.
//
// The hash covers the title, issue type, the clipped description and the criteria — never a status,
// an assignee or a link — so a ticket moving bucket or changing hands costs no new call.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY inside the readers (a pure test never opens it).

export const SPRINT_CODE_DESCRIPTION_MAX_CHARS = 1500;
export const SPRINT_CODE_CRITERIA_MAX = 12;
export const SPRINT_CODE_CRITERION_MAX_CHARS = 200;
const COLOR_RE = /\{color[^}]*\}/g;

export interface SprintCodeJudgeInput {
  title: string;
  issueType: string | null;
  description: string;
  criteria: string[];
  /** sha256 hex of exactly what is sent. */
  textHash: string;
}

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let cut = max;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
};

/** The judgement's input for a stored sprint ticket. Pure. */
export function sprintCodeJudgeInput(
  ticket: { title: string | null; description: string | null; acceptanceCriteria: string | null; issueTypeName: string | null },
  provider: TrackerProvider | string,
): SprintCodeJudgeInput {
  const title = (ticket.title ?? '').trim();
  const rawDescription = (ticket.description ?? '').replace(COLOR_RE, '');
  const criteria = sprintCriteriaOf({ description: rawDescription, acceptanceCriteria: ticket.acceptanceCriteria ?? '' }, provider)
    .items.slice(0, SPRINT_CODE_CRITERIA_MAX)
    .map((c) => clip(c, SPRINT_CODE_CRITERION_MAX_CHARS));
  const description = clip(rawDescription, SPRINT_CODE_DESCRIPTION_MAX_CHARS);
  const issueType = ticket.issueTypeName != null && ticket.issueTypeName.trim() !== '' ? ticket.issueTypeName.trim() : null;
  const textHash = createHash('sha256').update(JSON.stringify({ title, issueType, description, criteria })).digest('hex');
  return { title, issueType, description, criteria, textHash };
}

export interface SprintCodeJudgementRow {
  ident: string;
  textHash: string;
  judgeVersion: number;
  needsCode: boolean;
  reason: string | null;
}

/** Is this stored judgement current for today's input? Pure. */
export function isCodeJudgementCurrent(
  row: Pick<SprintCodeJudgementRow, 'textHash' | 'judgeVersion'> | null | undefined,
  input: Pick<SprintCodeJudgeInput, 'textHash'>,
): boolean {
  return row != null && row.judgeVersion === SPRINT_CODE_JUDGE_VERSION && row.textHash === input.textHash;
}

/** A current row → the wire judgement. Pure. */
export function codeJudgementOf(row: Pick<SprintCodeJudgementRow, 'needsCode' | 'reason'>): SprintCodeJudgement {
  return { state: row.needsCode ? 'code' : 'no_code', reason: row.reason != null && row.reason.trim() !== '' ? row.reason : null };
}

/** The stored rows (any currency) for these idents, this account + workspace only. */
export async function storedSprintCodeJudgements(
  accountId: number,
  workspaceId: number,
  idents: readonly string[],
): Promise<Map<string, SprintCodeJudgementRow>> {
  const out = new Map<string, SprintCodeJudgementRow>();
  const list = [...new Set(idents)];
  if (list.length === 0) return out;
  const { db, schema } = await import('./client.js');
  const t = schema.sprintCodeJudgements;
  for (let i = 0; i < list.length; i += 400) {
    const rows = await db
      .select({ ident: t.ident, textHash: t.textHash, judgeVersion: t.judgeVersion, needsCode: t.needsCode, reason: t.reason })
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), inArray(t.ident, list.slice(i, i + 400))))
      .execute();
    for (const r of rows) out.set(r.ident, r as SprintCodeJudgementRow);
  }
  return out;
}

/** The CURRENT judgements of these tickets, by ident. */
export async function currentSprintCodeJudgements(
  accountId: number,
  workspaceId: number,
  tickets: ReadonlyArray<{ ident: string; input: Pick<SprintCodeJudgeInput, 'textHash'> }>,
): Promise<Map<string, SprintCodeJudgement>> {
  const stored = await storedSprintCodeJudgements(
    accountId,
    workspaceId,
    tickets.map((t) => t.ident),
  );
  const out = new Map<string, SprintCodeJudgement>();
  for (const t of tickets) {
    const row = stored.get(t.ident);
    if (isCodeJudgementCurrent(row, t.input)) out.set(t.ident, codeJudgementOf(row!));
  }
  return out;
}

export interface StoredSprintCodeJudgement {
  needsCode: boolean;
  reason: string | null;
  /** This ticket's share of the call's cost and tokens (one call judges several tickets). */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** The model that RAN and its provider. Absent ⇒ the Claude constant. */
  model?: string;
  provider?: 'claude' | 'codex';
}

/** Upsert ONE judgement (replaces the ticket's previous one). */
export async function storeSprintCodeJudgement(
  accountId: number,
  workspaceId: number,
  ident: string,
  textHash: string,
  j: StoredSprintCodeJudgement,
  now: Date = new Date(),
): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintCodeJudgements;
  const values = {
    textHash,
    judgeVersion: SPRINT_CODE_JUDGE_VERSION,
    needsCode: j.needsCode,
    reason: j.reason,
    model: j.model ?? SPRINT_BRIEF_MODEL,
    provider: j.provider ?? null,
    costUsd: j.costUsd,
    inputTokens: j.inputTokens,
    outputTokens: j.outputTokens,
    createdAt: now,
  };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ident, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId, t.ident], set: values })
    .execute();
}
