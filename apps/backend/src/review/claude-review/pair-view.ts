// CLAUDE + CODEX AS ONE REVIEW — the pure half of the pair's CONSOLIDATED VIEW (docs/CLAUDE-REVIEW.md
// § Claude + Codex → One review). A pair is two stored runs; every surface that shows or acts on "the
// review" reads it as ONE: one summary, one verdict, one findings list where each finding names who
// raised it (`ClaudeFinding.source`), one line for a half that did not finish.
//
// The consolidation itself (the quick pass, its fallback, the write) is ./pair-consolidate.ts; this
// module only folds the two stored halves and the stored record (`claude_reviews.pair_consolidation`,
// migration 0137) into the wire shape. Pure, except the in-memory "merging now" set below.
import {
  aiRunProvider,
  aiProviderName,
  type ClaudeFinding,
  type ClaudeFindingSource,
  type ClaudeFollowUpItem,
  type ClaudeReview,
  type ClaudeReviewFollowUp,
  type ClaudeReviewPairConsolidation,
  type ClaudeReviewPairFailedHalf,
  type ClaudeReviewPairHalf,
  type ClaudeReviewVerdict,
  type ClaudeSettledFinding,
} from '@pierre-review/shared';
import { autoVerdictFor, DEFAULT_VERDICT_RULES, pairVerdict, type VerdictRules } from './auto-verdict.js';

// ---- "not ended yet" (this process only) ----

// Pairs (by `pair_id`) that have not ENDED in this process: between the halves (the first ended, the
// second's row is being written) and while the consolidation runs. The pair still reads as running,
// so the tab never flashes the first half as the finished review, shows "Merging the two reviews…",
// and nothing acts on a half-merged review. A restart empties it — a pair interrupted mid-merge reads
// as the two halves joined in code.
const busyPairs = new Set<number>();

export function markPairBusy(pairId: number, on: boolean): void {
  if (on) busyPairs.add(pairId);
  else busyPairs.delete(pairId);
}

export function isPairBusy(pairId: number): boolean {
  return busyPairs.has(pairId);
}

// ---- small pure rules ----

/** The provider that ran a half, as a finding source. */
export function sourceOfRun(run: Pick<ClaudeReview, 'provider' | 'model'>): Exclude<ClaudeFindingSource, 'both'> {
  return aiRunProvider(run.provider, run.model);
}

/**
 * THE PAIR'S VERDICT, IN CODE: the auto-post rule (`autoVerdictFor`) over the CONSOLIDATED findings,
 * with both halves' own verdicts folded by the workspace's rules (`pairVerdict`: strict = APPROVE
 * only when both approved; relaxed = one approved and neither asked for changes; `approveLeftovers`
 * for what may stay open). The model never decides it.
 */
export function pairCodeVerdict(
  a: ClaudeReview['verdict'],
  b: ClaudeReview['verdict'],
  findings: Parameters<typeof autoVerdictFor>[1],
  rules: VerdictRules = DEFAULT_VERDICT_RULES,
): ClaudeReviewVerdict {
  return autoVerdictFor(pairVerdict(a, b, rules.pairStrictness), findings, rules.approveLeftovers);
}

/** The fallback summary: each half's summary, named, in one block ("Claude: … / Codex: …"). */
export function joinedPairSummary(halves: ReadonlyArray<Pick<ClaudeReview, 'provider' | 'model' | 'summary'>>): string | null {
  const parts = halves
    .map((h) => ({ by: aiProviderName(sourceOfRun(h)), text: (h.summary ?? '').trim() }))
    .filter((p) => p.text !== '')
    .map((p) => `**${p.by}:** ${p.text}`);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** A failed half's reason in a few plain words (its stored error's first sentence, capped). */
export function shortFailReason(status: ClaudeReview['status'] | 'not_started', error: string | null | undefined): string {
  if (status === 'cancelled') return 'it was stopped';
  const first = (error ?? '').trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? '';
  if (first === '') return status === 'not_started' ? "it didn't start" : 'it failed';
  const clipped = first.length > 140 ? `${first.slice(0, 139)}…` : first;
  return clipped.replace(/[.]$/, '');
}

/**
 * THE CODE CONSOLIDATION, with no model: the fallback when the quick pass fails, times out, is over
 * its input cap or answers something invalid — and the whole consolidation when only one half
 * finished. Both halves: every finding stays (the second half's repeats of the first were already
 * dropped when it ran, `dropPairRepeats`), the summaries joined, the code verdict. One half: that
 * half's findings, summary and verdict, and the other named as not finished.
 */
export function codeConsolidation(
  halves: ReadonlyArray<ClaudeReview>,
  failedHalf: ClaudeReviewPairFailedHalf | null,
  at: string,
  rules: VerdictRules = DEFAULT_VERDICT_RULES,
): ClaudeReviewPairConsolidation {
  const ok = halves.filter((h) => h.status === 'succeeded');
  const sourceOf: Record<string, ClaudeFindingSource> = {};
  for (const h of ok) for (const f of h.findings) sourceOf[String(f.id)] = sourceOfRun(h);
  if (ok.length === 1) {
    const only = ok[0]!;
    return { how: 'single', summary: only.summary, verdict: only.verdict, sourceOf, mergedFrom: {}, failedHalf, at };
  }
  const [a, b] = ok;
  return {
    how: 'code',
    summary: joinedPairSummary(ok),
    verdict: a && b ? pairCodeVerdict(a.verdict, b.verdict, ok.flatMap((h) => h.findings), rules) : null,
    sourceOf,
    mergedFrom: {},
    failedHalf: null,
    at,
  };
}

/** A half as the consolidated view lists it. */
export function pairHalfOf(r: ClaudeReview): ClaudeReviewPairHalf {
  return {
    reviewId: r.id,
    provider: sourceOfRun(r),
    model: r.model,
    effort: r.effort ?? null,
    status: r.status,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  };
}

/** A stored consolidation record, read defensively (null for anything malformed). */
export function pairConsolidationOf(v: unknown): ClaudeReviewPairConsolidation | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Partial<ClaudeReviewPairConsolidation>;
  if (r.how !== 'pass' && r.how !== 'code' && r.how !== 'single') return null;
  const fh = r.failedHalf as Partial<ClaudeReviewPairFailedHalf> | null | undefined;
  return {
    how: r.how,
    summary: typeof r.summary === 'string' ? r.summary : null,
    verdict: r.verdict === 'APPROVE' || r.verdict === 'REQUEST_CHANGES' || r.verdict === 'COMMENT' ? r.verdict : null,
    sourceOf: r.sourceOf != null && typeof r.sourceOf === 'object' ? (r.sourceOf as Record<string, ClaudeFindingSource>) : {},
    mergedFrom: r.mergedFrom != null && typeof r.mergedFrom === 'object' ? (r.mergedFrom as Record<string, number>) : {},
    failedHalf:
      fh != null && (fh.provider === 'claude' || fh.provider === 'codex') && typeof fh.reason === 'string'
        ? { provider: fh.provider, reason: fh.reason }
        : null,
    at: typeof r.at === 'string' ? r.at : '',
  };
}

const inFlight = (s: ClaudeReview['status']): boolean => s === 'queued' || s === 'running';

// Both halves' follow-ups as one: the latest half's record, every item once (by earlier finding).
function mergedFollowUp(halves: readonly ClaudeReview[]): ClaudeReviewFollowUp | null {
  const withFu = halves.filter((h) => h.followUp != null);
  if (withFu.length === 0) return null;
  const base = withFu[withFu.length - 1]!.followUp!;
  const items: ClaudeFollowUpItem[] = [];
  const seen = new Set<number>();
  for (const h of withFu) {
    for (const it of h.followUp!.items) {
      if (seen.has(it.priorFindingId)) continue;
      seen.add(it.priorFindingId);
      items.push(it);
    }
  }
  const leftOutSeen = new Set<number>();
  const leftOut = withFu.flatMap((h) => h.followUp!.leftOut ?? []).filter((l) => {
    if (leftOutSeen.has(l.priorFindingId) || seen.has(l.priorFindingId)) return false;
    leftOutSeen.add(l.priorFindingId);
    return true;
  });
  return { ...base, items, ...(leftOut.length > 0 ? { leftOut } : {}) };
}

/** The auto-post record a pair shows: the owning half's (latest first), else any half's. */
export function autoPostOfPair(halves: readonly ClaudeReview[]): ClaudeReview['autoPost'] {
  const rev = [...halves].reverse();
  return (
    rev.find((h) => h.autoPost != null && h.autoPost.viaPairReviewId == null)?.autoPost ??
    rev.find((h) => h.autoPost != null)?.autoPost ??
    null
  );
}

/**
 * THE CONSOLIDATED VIEW of a pair: ONE `ClaudeReview` from its two stored halves (either may be
 * absent — a second that never started) and the stored record (null on a pair still running, or one
 * from before migration 0137 ⇒ joined in code). The view's `id` is the pair's LATEST half (the
 * second when it started), so drafting, posting and the history select all address one id.
 *   • status: running while either half is queued/running or the pair is merging; else succeeded
 *     when either half succeeded; else the latest half's (failed / cancelled).
 *   • findings: both succeeded halves', merged-away duplicates already left out by the read, each
 *     with its `source`.
 *   • summary + verdict: the record's; the follow-up: both halves' items, once each.
 *   • thread judgements, CI and stories: the latest SUCCEEDED half's (both judged the same threads).
 */
export function buildPairView(
  first: ClaudeReview | null,
  second: ClaudeReview | null,
  stored: ClaudeReviewPairConsolidation | null,
  merging: boolean,
): ClaudeReview | null {
  const halves = [first, second].filter((h): h is ClaudeReview => h != null);
  const latest = halves[halves.length - 1];
  if (!latest) return null;
  const pairId = first?.id ?? latest.pair?.pairId ?? latest.id;
  const ok = halves.filter((h) => h.status === 'succeeded');
  const running = merging || halves.some((h) => inFlight(h.status));
  const status: ClaudeReview['status'] = running
    ? halves.every((h) => h.status === 'queued')
      ? 'queued'
      : 'running'
    : ok.length > 0
      ? 'succeeded'
      : latest.status;
  // The record — or, until it exists, the same fold in code.
  const record =
    stored ??
    (ok.length > 0 && !running
      ? codeConsolidation(
          halves,
          ok.length === 1 && halves.length === 2
            ? (() => {
                const bad = halves.find((h) => h.status !== 'succeeded')!;
                return { provider: sourceOfRun(bad), reason: shortFailReason(bad.status, bad.error) };
              })()
            : null,
          '',
        )
      : null);
  const main = ok[ok.length - 1] ?? latest;
  const findings: ClaudeFinding[] = status === 'succeeded'
    ? ok.flatMap((h) =>
        h.findings.map((f) => ({ ...f, source: record?.sourceOf[String(f.id)] ?? sourceOfRun(h) })),
      )
    : [];
  const settledSeen = new Set<number>();
  const settledEarlier: ClaudeSettledFinding[] = [];
  for (const h of ok) {
    for (const s of h.settledEarlier ?? []) {
      if (settledSeen.has(s.priorFindingId)) continue;
      settledSeen.add(s.priorFindingId);
      settledEarlier.push(s);
    }
  }
  const sum = (pick: (h: ClaudeReview) => number | null): number | null => {
    const vals = halves.map(pick).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const docRefs = ok.flatMap((h) => h.docReferences ?? []);
  return {
    ...main,
    id: latest.id,
    status,
    error: status === 'succeeded' ? null : latest.error,
    createdAt: (first ?? latest).createdAt,
    finishedAt: running ? null : latest.finishedAt ?? main.finishedAt,
    summary: status === 'succeeded' ? (record?.summary ?? main.summary) : null,
    verdict: status === 'succeeded' ? (record?.verdict ?? main.verdict) : null,
    // The draft and the post are the latest half's (the pair's one id).
    userBody: latest.userBody,
    userVerdict: latest.userVerdict,
    postedReviewId: latest.postedReviewId ?? first?.postedReviewId ?? null,
    postedAt: latest.postedAt ?? first?.postedAt ?? null,
    // The pair's auto-post record: the half that OWNS it (no `viaPairReviewId`) — the second after a
    // combined post, the first when the second did not finish — else whichever half carries one.
    autoPost: autoPostOfPair(halves),
    costUsd: sum((h) => h.costUsd),
    inputTokens: sum((h) => h.inputTokens),
    outputTokens: sum((h) => h.outputTokens),
    cacheReadTokens: sum((h) => h.cacheReadTokens),
    cacheCreationTokens: sum((h) => h.cacheCreationTokens),
    numTurns: sum((h) => h.numTurns),
    findings,
    followUp: status === 'succeeded' ? mergedFollowUp(ok) : null,
    ...(settledEarlier.length > 0 || main.settledEarlier != null ? { settledEarlier } : {}),
    docReferences: docRefs.length > 0 ? docRefs : (main.docReferences ?? null),
    pair: {
      pairId,
      role: latest === second ? 'second' : 'first',
      otherReviewId: latest === second ? (first?.id ?? null) : (second?.id ?? null),
      ...(second?.pair?.dropped != null ? { dropped: second.pair.dropped } : {}),
      verdict: status === 'succeeded' ? (record?.verdict ?? null) : null,
      halves: halves.map(pairHalfOf),
      failedHalf: status === 'succeeded' ? (record?.failedHalf ?? null) : null,
      how: status === 'succeeded' ? (record?.how ?? null) : null,
    },
  };
}
