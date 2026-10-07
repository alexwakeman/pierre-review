// SETTLED BY A REPLY — an earlier Claude Review finding a later review SETTLED because it ACCEPTED a
// person's reply on its GitHub thread (follow-up status 'reply_accepted', `acceptKind` 'not_valid'
// or 'deferred'). The pure half: which findings count, which new findings repeat one, and which
// findings the RETIRED rule below left out of the chain. The DB loader is persist.ts
// `loadSettledByReplyFindings`.
//
// What happens to a settled finding: it leaves the follow-up (never sent as a P item, never stored
// on the follow-up record, never in the pane's open "Previous review" list — the read path lists it
// in the closed group instead, `ClaudeReview.settledEarlier`), the prompt lists it in a fenced
// block the model is told not to raise again, and a new finding that repeats it
// (`isReraiseOfSettled`: same path, similar title) is dropped in code.
// ⚠ A NEW reply or new commits do NOT unsettle it (kept simple: the author was told it was
// accepted, and re-opening it would contradict the acknowledgement on GitHub).
//
// ⚠ RETIRED (2026-10): "resolved on GitHub + someone else replied + code unchanged ⇒ settled on
// sight, before Claude sees it". Resolving is a click, so a resolved thread with a reply now goes
// through the SAME reply judgement as an open one (follow-up.ts `isResolvedWithReplies`): accepted ⇒
// settled through this file from then on; disputed ⇒ open (raised again, counted in the auto verdict,
// an AI Fix item), with no automatic pushback on the resolved thread. A thread resolved with NO
// reply is still followed up on the code, as before.
// BACKWARD COMPATIBILITY: a finding the retired rule settled in an earlier run left the follow-up
// chain without ever being judged, so the chain alone would never bring it back.
// `unjudgedReplyCandidateIds` finds those (posted, never closed by a follow-up status, not continued
// by a later posted re-raise, not already in this run's follow-up); the manager keeps the ones whose
// thread is resolved with a reply and sends them as CARRIED items, so they are judged once, on the
// next run, like any other.

/** A finding settled by an accepted reply, with the reply (shown to the model as data). */
export interface SettledFinding {
  id: number;
  path: string;
  title: string;
  replyAuthor: string;
  reply: string;
  // How it was accepted.
  acceptKind?: 'not_valid' | 'deferred' | null;
  // For the read path (`ClaudeReview.settledEarlier`): the finding's anchor and severity, and the
  // review whose follow-up accepted the reply. Absent on items stored before the fields existed.
  line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  severity?: 'blocker' | 'warning' | 'question' | 'nit' | 'praise';
  acceptedInReviewId?: number;
}

/** An earlier run's follow-up item, as `acceptedReplyFindings` reads it. */
export interface AcceptedItemLike {
  priorFindingId: number;
  status: string;
  path: string;
  title: string;
  acceptKind?: 'not_valid' | 'deferred' | null;
  reply?: { author: string; excerpt: string } | null;
  line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  severity?: 'blocker' | 'warning' | 'question' | 'nit' | 'praise';
  // The review whose follow-up this item is (set by the loader).
  reviewId?: number;
}

/**
 * The findings an earlier review ACCEPTED a person's reply on (`reply_accepted`). Only for findings
 * in `eligibleIds` (this PR's own, posted). The FIRST acceptance wins (items oldest run first).
 */
export function acceptedReplyFindings(
  items: readonly AcceptedItemLike[],
  eligibleIds: ReadonlySet<number>,
): SettledFinding[] {
  const out: SettledFinding[] = [];
  const seen = new Set<number>();
  for (const it of items) {
    if (it.status !== 'reply_accepted' || !eligibleIds.has(it.priorFindingId) || seen.has(it.priorFindingId)) continue;
    seen.add(it.priorFindingId);
    out.push({
      id: it.priorFindingId,
      path: it.path,
      title: it.title,
      replyAuthor: it.reply?.author ?? 'unknown',
      reply: it.reply?.excerpt ?? '',
      acceptKind: it.acceptKind ?? null,
      ...(it.line !== undefined ? { line: it.line } : {}),
      ...(it.side ? { side: it.side } : {}),
      ...(it.severity ? { severity: it.severity } : {}),
      ...(it.reviewId != null ? { acceptedInReviewId: it.reviewId } : {}),
    });
  }
  return out;
}

// ---- findings the retired rule left out of the chain (backward compatibility) ----

// A follow-up status after which a finding legitimately leaves the chain.
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['addressed', 'no_longer_applies', 'reply_accepted']);

/** At most this many are re-judged per run (oldest first); the rest wait for a later run. */
export const UNJUDGED_REPLY_MAX = 20;

/**
 * Earlier findings that dropped out of the follow-up chain WITHOUT a closing status — what the
 * retired "resolved after a reply ⇒ settled" rule did. A candidate is:
 *   - eligible (posted, not praise, not a legacy story finding — the caller decides);
 *   - not in `exclude` (this run's follow-up already holds it, or it is settled);
 *   - not re-raised by a later ELIGIBLE finding (the chain continues through that one);
 *   - its NEWEST follow-up item (any earlier run) is not a closing status.
 * The caller keeps only those whose thread is resolved with a person's reply. Oldest first, capped.
 */
export function unjudgedReplyCandidateIds(
  earlier: ReadonlyArray<{ id: number; priorFindingId: number | null; eligible: boolean }>,
  // Every earlier run's follow-up items, OLDEST RUN FIRST.
  itemsOldestFirst: ReadonlyArray<{ priorFindingId: number; status: string }>,
  exclude: ReadonlySet<number>,
  max: number = UNJUDGED_REPLY_MAX,
): number[] {
  const latest = new Map<number, string>();
  for (const it of itemsOldestFirst) latest.set(it.priorFindingId, it.status);
  const reraised = new Set<number>();
  for (const f of earlier) if (f.eligible && f.priorFindingId != null) reraised.add(f.priorFindingId);
  return earlier
    .filter((f) => f.eligible && !exclude.has(f.id) && !reraised.has(f.id))
    .filter((f) => {
      const st = latest.get(f.id);
      return st == null || !CLOSED_STATUSES.has(st);
    })
    .map((f) => f.id)
    .sort((a, b) => a - b)
    .slice(0, max);
}

// ---- the re-raise match ----

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'is', 'and', 'or', 'with', 'be', 'it']);

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 0 && !STOP.has(w));
}

/** Word-set overlap (Jaccard) at or above which two titles on the same path are "the same point". */
export const SETTLED_TITLE_SIMILARITY = 0.6;

/**
 * Two titles say the same thing: equal once folded (case, quotes, punctuation, filler words), or
 * their word sets overlap at least SETTLED_TITLE_SIMILARITY.
 */
export function similarTitles(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  if (wa.join(' ') === wb.join(' ')) return true;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let both = 0;
  for (const w of sa) if (sb.has(w)) both += 1;
  return both / (sa.size + sb.size - both) >= SETTLED_TITLE_SIMILARITY;
}

/** The settled finding a new finding repeats (same path, similar title), or null. */
export function isReraiseOfSettled(
  f: { path: string; title: string },
  settled: readonly Pick<SettledFinding, 'id' | 'path' | 'title'>[],
): Pick<SettledFinding, 'id' | 'path' | 'title'> | null {
  return settled.find((s) => s.path === f.path && similarTitles(s.title, f.title)) ?? null;
}

/**
 * Drop every new finding that repeats a settled one. A finding LINKED to a still-open earlier one
 * (`priorFindingId` set) is the follow-up's re-raise of THAT finding and is kept.
 */
export function dropSettledReraises<F extends { path: string; title: string; priorFindingId?: number | null }>(
  findings: readonly F[],
  settled: readonly Pick<SettledFinding, 'id' | 'path' | 'title'>[],
): { kept: F[]; dropped: F[] } {
  const kept: F[] = [];
  const dropped: F[] = [];
  if (settled.length === 0) return { kept: [...findings], dropped };
  for (const f of findings) {
    if (f.priorFindingId == null && isReraiseOfSettled(f, settled)) dropped.push(f);
    else kept.push(f);
  }
  return { kept, dropped };
}
