import { and, eq, inArray } from 'drizzle-orm';
import {
  TICKET_PR_CARD_CHANGES,
  TICKET_PR_CARD_INTERFACE_KINDS,
  TICKET_REVIEW_MAX_DIFFS,
  type StoredTicketPrCard,
  type TicketPrCard,
  type TicketPrCardBody,
  type TicketPrCardChange,
  type TicketPrCardCriterion,
  type TicketPrCardInterface,
  type TicketPrCardInterfaceKind,
  type TicketPrCardSource,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// CONTRIBUTION CARDS — what ONE pull request's head does, written once and reused by every later
// ticket review of a ticket it is on (`ticket_review_pr_cards`, schema.sqlite.ts § contribution
// cards). A card is a model's DESCRIPTION of untrusted input (the PR's diff), never a verdict: the
// ticket review still judges every criterion afresh and is told to verify a card when in doubt.
//
//   CURRENCY   a card describes exactly one head. It is current while that head is the PR's synced
//              head: a merged PR's head never moves (its card holds for good), an open PR's card
//              lapses on the next push. `''` (no synced head) never matches.
//   PARTITION  per run (`partitionMembers`): a member with a current card is read AS THE CARD; of
//              the rest, the TICKET_REVIEW_MAX_DIFFS most recently updated are read AS DIFFS (the run
//              writes their cards); any beyond that go to the PRE-PASS (prepass.ts) first. A pre-pass
//              failure falls back to a diff while TICKET_REVIEW_MAX_FALLBACK_DIFFS allows, else the
//              member is read as nothing and NAMED unread in the prompt — never silently dropped.
//   VALIDATION every model-written card is re-checked here (`normaliseCard`): enums, clipped strings,
//              capped lists, a non-empty summary. The run's `cards` are kept only for members it was
//              actually shown as diffs (`validateRunCards`), first per member wins.
//
// ⚠ Card availability NEVER enters the ticket fingerprint (fingerprint.ts): whether a member was
// read as a card or a diff says nothing about whether the ticket's PRs moved.

/** Members read as diffs beyond TICKET_REVIEW_MAX_DIFFS when their pre-pass card failed. */
export const TICKET_REVIEW_MAX_FALLBACK_DIFFS = 2;

export const CARD_SUMMARY_CHARS = 1_200;
export const CARD_NAME_CHARS = 200;
export const CARD_NOTE_CHARS = 300;
export const CARD_TEXT_CHARS = 400;
export const CARD_PATH_CHARS = 300;
export const CARD_INTERFACES_MAX = 40;
export const CARD_CRITERIA_MAX = 20;
export const CARD_LOOSE_ENDS_MAX = 15;
export const CARD_FILES_PER_CRITERION = 10;
/** The changed files stored with a card (the prompt lists at most TICKET_REVIEW_FILES_LISTED). */
export const CARD_CHANGED_FILES_MAX = 300;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// The summary keeps its line breaks (a few sentences may be a short list).
const prose = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t === '') return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * A model-written card, re-checked: null when it has no summary (a card that says nothing is not
 * a card). Unknown interface kinds read as 'other'; an unknown change drops the row.
 */
export function normaliseCard(raw: unknown): TicketPrCardBody | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const summary = prose(r.summary, CARD_SUMMARY_CHARS);
  if (summary == null) return null;
  const interfaces: TicketPrCardInterface[] = [];
  for (const x of arr(r.interfaces)) {
    if (interfaces.length >= CARD_INTERFACES_MAX) break;
    const o = (x ?? {}) as Record<string, unknown>;
    const name = str(o.name, CARD_NAME_CHARS);
    const change = typeof o.change === 'string' && (TICKET_PR_CARD_CHANGES as readonly string[]).includes(o.change)
      ? (o.change as TicketPrCardChange)
      : null;
    if (name == null || change == null) continue;
    const kind = typeof o.kind === 'string' && (TICKET_PR_CARD_INTERFACE_KINDS as readonly string[]).includes(o.kind)
      ? (o.kind as TicketPrCardInterfaceKind)
      : 'other';
    interfaces.push({ kind, name, change, note: str(o.note, CARD_NOTE_CHARS) });
  }
  const criteria: TicketPrCardCriterion[] = [];
  for (const x of arr(r.criteria)) {
    if (criteria.length >= CARD_CRITERIA_MAX) break;
    const o = (x ?? {}) as Record<string, unknown>;
    const criterion = str(o.criterion, CARD_TEXT_CHARS);
    const how = str(o.how, CARD_TEXT_CHARS);
    if (criterion == null || how == null) continue;
    const files = arr(o.files)
      .map((f) => str(f, CARD_PATH_CHARS))
      .filter((f): f is string => f != null)
      .slice(0, CARD_FILES_PER_CRITERION);
    criteria.push({ criterion, how, files });
  }
  const looseEnds = arr(r.looseEnds)
    .map((l) => str(l, CARD_TEXT_CHARS))
    .filter((l): l is string => l != null)
    .slice(0, CARD_LOOSE_ENDS_MAX);
  return { summary, interfaces, criteria, looseEnds };
}

/**
 * The run's `cards`, kept only for members it was SHOWN AS DIFFS (by ref). Unknown refs, refs of
 * members shown as cards, and repeats (the first wins) are dropped; so is a card with no summary.
 */
export function validateRunCards(
  raw: unknown,
  diffMembers: ReadonlyArray<{ ref: string; prId: number }>,
  refLabels: ReadonlyMap<string, string> = new Map(),
): Map<number, TicketPrCardBody> {
  const byRef = new Map(diffMembers.map((m) => [m.ref, m.prId]));
  const out = new Map<number, TicketPrCardBody>();
  for (const x of arr(raw)) {
    const ref = typeof (x as { pr?: unknown } | null)?.pr === 'string' ? (x as { pr: string }).pr.trim() : '';
    const prId = byRef.get(ref);
    if (prId == null || out.has(prId)) continue;
    const card = normaliseCard(x);
    if (card != null) out.set(prId, relabelRefs(card, refLabels));
  }
  return out;
}

/**
 * A card outlives the run that wrote it, and a run's refs ('PR3') mean nothing in the next run, so
 * every ref the run handed out is rewritten to its 'repo#number' label. Unknown refs stay as written.
 */
export function relabelRefs(card: TicketPrCardBody, labels: ReadonlyMap<string, string>): TicketPrCardBody {
  if (labels.size === 0) return card;
  const fix = (t: string): string => t.replace(/\bPR(\d+)\b/g, (m) => labels.get(m) ?? m);
  return {
    summary: fix(card.summary),
    interfaces: card.interfaces.map((i) => ({ ...i, name: fix(i.name), note: i.note != null ? fix(i.note) : null })),
    criteria: card.criteria.map((c) => ({ ...c, criterion: fix(c.criterion), how: fix(c.how) })),
    looseEnds: card.looseEnds.map(fix),
  };
}

/** Is a card (made at `card.headSha`) current for a member at `headSha`? */
export function cardIsCurrent(card: { headSha: string }, member: { headSha: string }): boolean {
  return member.headSha !== '' && card.headSha === member.headSha;
}

export interface PartitionMember {
  prId: number;
  updatedAt: Date | null;
}

export interface MemberPartition {
  // Read as their stored card.
  cards: number[];
  // Read as diffs (the run writes their cards), most recently updated first.
  diffs: number[];
  // No card and over the diff cap: the pre-pass writes their cards first.
  prepass: number[];
}

/**
 * Who is read how. Deterministic: members without a current card are ordered most recently updated
 * first (a missing time last), ties by prId; the first `maxDiffs` are diffs, the rest pre-pass.
 * `cards` keeps the input order. Pure.
 */
export function partitionMembers(
  members: readonly PartitionMember[],
  hasCurrentCard: ReadonlySet<number>,
  maxDiffs: number = TICKET_REVIEW_MAX_DIFFS,
): MemberPartition {
  const lacking = members.filter((m) => !hasCurrentCard.has(m.prId));
  const t =(d: Date | null): number => (d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : -Infinity);
  lacking.sort((a, b) => t(b.updatedAt) - t(a.updatedAt) || a.prId - b.prId);
  const cap = Math.max(0, maxDiffs);
  return {
    cards: members.filter((m) => hasCurrentCard.has(m.prId)).map((m) => m.prId),
    diffs: lacking.slice(0, cap).map((m) => m.prId),
    prepass: lacking.slice(cap).map((m) => m.prId),
  };
}

/**
 * After the pre-pass: each member that got no card falls back to a diff while
 * `maxFallback` slots remain (in pre-pass order), else it is unread. Pure.
 */
export function placePrepassFailures(
  prepass: readonly number[],
  carded: ReadonlySet<number>,
  maxFallback: number = TICKET_REVIEW_MAX_FALLBACK_DIFFS,
): { fallbackDiffs: number[]; unread: number[] } {
  const fallbackDiffs: number[] = [];
  const unread: number[] = [];
  for (const id of prepass) {
    if (carded.has(id)) continue;
    if (fallbackDiffs.length < Math.max(0, maxFallback)) fallbackDiffs.push(id);
    else unread.push(id);
  }
  return { fallbackDiffs, unread };
}

/** A stored card rendered as prompt text (it is fenced by the caller). */
export function cardText(card: TicketPrCardBody): string {
  const lines: string[] = [card.summary];
  if (card.interfaces.length > 0) {
    lines.push('', 'Interfaces:');
    for (const i of card.interfaces) {
      lines.push(`- ${i.change} ${i.kind} ${i.name}${i.note ? ` — ${i.note}` : ''}`);
    }
  }
  if (card.criteria.length > 0) {
    lines.push('', 'Criteria it moves forward:');
    for (const c of card.criteria) {
      lines.push(`- ${c.criterion}: ${c.how}${c.files.length > 0 ? ` (${c.files.join(', ')})` : ''}`);
    }
  }
  if (card.looseEnds.length > 0) {
    lines.push('', 'Loose ends:');
    for (const l of card.looseEnds) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}

// ---- storage ----

export interface StoredCardRow {
  prId: number;
  headSha: string;
  card: StoredTicketPrCard;
  source: TicketPrCardSource;
  model: string;
  costUsd: number | null;
  createdAt: Date;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const cardsTable = (ctx: AgentContext): any => (ctx.schema as any).ticketReviewPrCards;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A stored row's card, re-checked on read (a hand-edited or older row can never reach the wire raw). */
function readCard(raw: unknown): StoredTicketPrCard | null {
  const body = normaliseCard(raw);
  if (body == null) return null;
  const files = arr((raw as { changedFiles?: unknown } | null)?.changedFiles)
    .filter((f): f is string => typeof f === 'string' && f !== '')
    .slice(0, CARD_CHANGED_FILES_MAX);
  return { ...body, changedFiles: files };
}

/**
 * The cards at exactly these (PR, head) pairs, this account only, keyed by prId. A pair with an
 * empty head is skipped (never current).
 */
export async function readCardsAt(
  ctx: AgentContext,
  accountId: number,
  pairs: ReadonlyArray<{ prId: number; headSha: string }>,
): Promise<Map<number, StoredCardRow>> {
  const out = new Map<number, StoredCardRow>();
  const want = new Map(pairs.filter((p) => p.headSha !== '').map((p) => [p.prId, p.headSha]));
  if (want.size === 0) return out;
  const t = cardsTable(ctx);
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), inArray(t.prId, [...want.keys()]), inArray(t.headSha, [...new Set(want.values())])))
    .execute()) as Array<StoredCardRow & { card: unknown }>;
  for (const r of rows) {
    if (want.get(r.prId) !== r.headSha) continue;
    const card = readCard(r.card);
    if (card == null) continue;
    out.set(r.prId, { ...r, card, createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as never) });
  }
  return out;
}

export interface CardWrite {
  prId: number;
  headSha: string;
  card: TicketPrCardBody;
  changedFiles: readonly string[];
  source: TicketPrCardSource;
  model: string;
  costUsd: number | null;
}

/**
 * Store cards, one per (account, PR, head): a re-write of the same head REPLACES the card (the
 * newest reading wins). A write with no head is skipped — it could never be current.
 */
export async function saveCards(ctx: AgentContext, accountId: number, writes: readonly CardWrite[]): Promise<void> {
  const t = cardsTable(ctx);
  for (const w of writes) {
    if (w.headSha === '') continue;
    const card: StoredTicketPrCard = { ...w.card, changedFiles: w.changedFiles.slice(0, CARD_CHANGED_FILES_MAX) };
    await ctx.db
      .insert(t)
      .values({
        accountId,
        prId: w.prId,
        headSha: w.headSha,
        card,
        source: w.source,
        model: w.model,
        costUsd: w.costUsd,
      })
      .onConflictDoUpdate({
        target: [t.accountId, t.prId, t.headSha],
        set: { card, source: w.source, model: w.model, costUsd: w.costUsd, createdAt: new Date() },
      })
      .execute();
  }
}

/** A stored row on the wire. */
export function toWireCard(r: StoredCardRow): TicketPrCard {
  return {
    headSha: r.headSha,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    summary: r.card.summary,
    interfaces: r.card.interfaces,
    criteria: r.card.criteria,
    looseEnds: r.card.looseEnds,
  };
}
