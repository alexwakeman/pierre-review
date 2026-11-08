import type { AiReviewCard } from '@pierre-review/shared';
import { isNewAiReview } from './aiReviewsSeen.js';

// PENDING → "AI REVIEWS": THE SEEN BLOCKS (docs/FRONTEND.md § The AI reviews list). Pure, for
// test/aiReviewsLedger.test.ts; the store is store/aiReviewsSeen.ts, the writer hooks/useAiReviewsSeen.ts.
//
// The server keeps ONE stamp per workspace (the newest review the reader has seen), so it can say
// "New" but not WHEN an older row was seen. This browser keeps a small LEDGER for that: per review
// id, the moment of the VISIT that first showed it as New, and its PR. The list is then drawn as
//   1. New — rows still New against the stamp the visit started with (as before);
//   2. one block per visit, newest first: "Seen today 14:32" / "Seen yesterday 09:10" /
//      "Seen Tue 4 Nov 16:17" — rows that arrived by poll during a visit join that visit;
//   3. the rest, with NO heading: rows seen before the ledger existed, in another browser, or never
//      recorded. Each block keeps the server's order.
// It is per browser and best-effort: an empty or broken ledger only means everything lands in (3).
// ⚠ Nothing here removes a row, scores one or changes the badge; the list stays a STABLE reference.

export const AI_REVIEWS_LEDGER_KEY = 'pierre:aiReviewsSeen:v1';
/** Entries older than this are dropped on write. */
export const AI_REVIEWS_LEDGER_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** At most this many entries are kept (the oldest go first); about 12 KB. */
export const AI_REVIEWS_LEDGER_MAX_ENTRIES = 600;

/** `seen[reviewId] = [seenAtMs, prId]`. */
export interface AiReviewsLedger {
  v: 1;
  seen: Record<string, [number, number]>;
}

export const emptyLedger = (): AiReviewsLedger => ({ v: 1, seen: {} });

/** Reads a stored ledger. Anything malformed is dropped: a bad entry, or the whole thing. */
export function parseLedger(raw: string | null | undefined): AiReviewsLedger {
  if (raw == null || raw === '') return emptyLedger();
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj == null || typeof obj !== 'object') return emptyLedger();
    const o = obj as { v?: unknown; seen?: unknown };
    if (o.v !== 1 || o.seen == null || typeof o.seen !== 'object') return emptyLedger();
    const seen: Record<string, [number, number]> = {};
    for (const [k, val] of Object.entries(o.seen as Record<string, unknown>)) {
      if (!/^\d+$/.test(k) || !Array.isArray(val) || val.length !== 2) continue;
      const [at, pr] = val as unknown[];
      if (typeof at !== 'number' || !Number.isFinite(at) || typeof pr !== 'number' || !Number.isInteger(pr)) continue;
      seen[k] = [at, pr];
    }
    return { v: 1, seen };
  } catch {
    return emptyLedger();
  }
}

/** Keeps ONE entry per PR (the newest review id: a re-review replaces its PR's older entry). */
function onePerPr(seen: Record<string, [number, number]>): Record<string, [number, number]> {
  const byPr = new Map<number, string>();
  for (const [k, [, pr]] of Object.entries(seen)) {
    const prev = byPr.get(pr);
    if (prev == null || Number(k) > Number(prev)) byPr.set(pr, k);
  }
  const out: Record<string, [number, number]> = {};
  for (const k of byPr.values()) out[k] = seen[k]!;
  return out;
}

/** Drops entries older than 60 days, then keeps the newest 600 by seen time. */
export function pruneLedger(ledger: AiReviewsLedger, nowMs: number): AiReviewsLedger {
  const kept = Object.entries(ledger.seen).filter(([, [at]]) => nowMs - at <= AI_REVIEWS_LEDGER_MAX_AGE_MS);
  kept.sort((a, b) => b[1][0] - a[1][0] || Number(b[0]) - Number(a[0]));
  return { v: 1, seen: Object.fromEntries(kept.slice(0, AI_REVIEWS_LEDGER_MAX_ENTRIES)) };
}

/**
 * Two copies of the ledger (this tab's and another tab's write) as one: the EARLIEST seen time
 * wins per review, so two tabs never split one visit; then one entry per PR.
 */
export function mergeLedgers(a: AiReviewsLedger, b: AiReviewsLedger): AiReviewsLedger {
  const seen: Record<string, [number, number]> = { ...a.seen };
  for (const [k, v] of Object.entries(b.seen)) {
    const cur = seen[k];
    if (cur == null || v[0] < cur[0]) seen[k] = v;
  }
  return { v: 1, seen: onePerPr(seen) };
}

/**
 * The ledger after a visit that started at `visitStartMs` showed `rows` as New. A review already
 * in the ledger keeps its first time; a new review replaces its PR's older entry. Returns the SAME
 * object when nothing changes, so a caller can skip the write.
 */
export function recordSeen(
  ledger: AiReviewsLedger,
  rows: readonly Pick<AiReviewCard, 'reviewId' | 'prId'>[],
  visitStartMs: number,
  nowMs: number,
): AiReviewsLedger {
  const add = rows.filter((r) => ledger.seen[String(r.reviewId)] == null);
  if (add.length === 0) return ledger;
  const fresh: AiReviewsLedger = { v: 1, seen: {} };
  for (const r of add) fresh.seen[String(r.reviewId)] = [visitStartMs, r.prId];
  return pruneLedger(mergeLedgers(ledger, fresh), nowMs);
}

/** The rows this visit should record: New against the visit's stamp, not yet in the ledger.
 *  A workspace never looked at (`baseline` null) records nothing — every row is New there, and one
 *  100-row "Seen" block would say nothing. */
export function rowsToRecord<C extends Pick<AiReviewCard, 'reviewId' | 'prId' | 'at'>>(
  rows: readonly C[],
  ledger: AiReviewsLedger,
  baseline: number | null,
): C[] {
  if (baseline == null) return [];
  return rows.filter((r) => isNewAiReview(r, baseline) && ledger.seen[String(r.reviewId)] == null);
}

/** "Seen today 14:32" / "Seen yesterday 09:10" / "Seen Tue 4 Nov 16:17" (+ the year when not this
 *  year), in the reader's local time. */
export function seenBlockLabel(seenAtMs: number, nowMs: number): string {
  const d = new Date(seenAtMs);
  const now = new Date(nowMs);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Seen today ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Seen yesterday ${time}`;
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `Seen ${weekday} ${d.getDate()} ${month}${year} ${time}`;
}

export type AiReviewBlock<C> =
  | { kind: 'new'; key: 'new'; rows: C[] }
  | { kind: 'seen'; key: string; seenAtMs: number; label: string; rows: C[] }
  | { kind: 'rest'; key: 'rest'; rows: C[] };

/**
 * The list as blocks, each in the order given (the server's). A row is New when it is newer than
 * the visit's stamp, unless this browser saw it in an EARLIER visit (another tab's, say). Empty
 * blocks are left out.
 */
export function groupAiReviews<C extends Pick<AiReviewCard, 'reviewId' | 'at'>>(
  rows: readonly C[],
  ledger: AiReviewsLedger,
  baseline: number | null,
  visitStartMs: number | null,
  nowMs: number,
): AiReviewBlock<C>[] {
  const fresh: C[] = [];
  const rest: C[] = [];
  const bySeen = new Map<number, C[]>();
  for (const r of rows) {
    const entry = ledger.seen[String(r.reviewId)];
    const seenEarlier = entry != null && (visitStartMs == null || entry[0] < visitStartMs);
    if (isNewAiReview(r, baseline) && !seenEarlier) fresh.push(r);
    else if (entry != null) {
      const list = bySeen.get(entry[0]);
      if (list) list.push(r);
      else bySeen.set(entry[0], [r]);
    } else rest.push(r);
  }
  const out: AiReviewBlock<C>[] = [];
  if (fresh.length > 0) out.push({ kind: 'new', key: 'new', rows: fresh });
  for (const at of [...bySeen.keys()].sort((a, b) => b - a)) {
    out.push({ kind: 'seen', key: `seen:${at}`, seenAtMs: at, label: seenBlockLabel(at, nowMs), rows: bySeen.get(at)! });
  }
  if (rest.length > 0) out.push({ kind: 'rest', key: 'rest', rows: rest });
  return out;
}
