// THE REVIEW LOOP'S ROUND RULE (PURE; docs/STORY-BUILD.md § The review loop → Where the pieces live). What
// is OPEN after one review round, the next round's follow-up input, and the STOP RULE — subject-independent:
// the rows are STRUCTURAL (any loop's runs, findings and story checks that carry these fields), so the Build
// loop (coding/story-build/loop/, the `story_build_*` tables) and a later loop over another subject share
// ONE fold. Nothing here reads a table, a build or a session.
import type {
  AiProviderId,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFollowUpStatus,
  ClaudeReviewFollowUpRecord,
  StoryBuildLoopClaimVerdict,
  StoryBuildLoopResponse,
  TicketAssessment,
} from '@pierre-review/shared';
import type { PriorFindingForFollowUp, PriorReviewForFollowUp } from '../../review/claude-review/follow-up.js';
import { responseLine } from './seed.js';

/** One review run of a round (one provider half on one target). */
export interface LoopRunLike {
  id: number;
  round: number;
  /** The subject's target ('repo' | 'pr' in Build); a loop with one target uses one constant pair. */
  targetKind: string;
  targetId: number;
  status: string;
  pairRole: 'first' | 'second' | null;
  followUp: ClaudeReviewFollowUpRecord | null;
  headSha: string;
  provider: string | null;
}

/** One finding of a run. */
export interface LoopFindingLike {
  id: number;
  reviewId: number;
  severity: ClaudeFindingSeverity;
  mergedInto: number | null;
}

/** A finding with what the next round's follow-up needs (the code and the agent's answer). */
export interface LoopPriorFindingLike extends LoopFindingLike {
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  title: string;
  body: string;
  suggestion: string | null;
  diffHunk: string | null;
  anchored: boolean;
  fileInDiff: boolean;
  response: StoryBuildLoopResponse | null;
  responseText: string | null;
  createdAt: Date | number | null;
}

/** One story check of a round. */
export interface LoopCheckLike {
  round: number;
  status: string;
  assessment: TicketAssessment | null;
  claimVerdicts: StoryBuildLoopClaimVerdict[] | null;
}

export type OpenCriterion = { ref: string; status: 'not_met' | 'partly_met' | 'unclear' | 'missing'; text: string; explanation: string | null };

export interface RoundOpen {
  findings: number;
  followUps: number;
  criteria: number;
}

const OPEN_FOLLOW_UP: ReadonlySet<ClaudeFollowUpStatus> = new Set(['not_addressed', 'partly_addressed', 'reply_disputed']);
const OPEN_CRITERION = new Set(['not_met', 'partly_met', 'unclear']);

const iso = (d: Date | number | null | undefined): string | null =>
  d == null ? null : (d instanceof Date ? d : new Date(typeof d === 'number' && d < 1e12 ? d * 1000 : d)).toISOString();

const providerOf = (p: string | null): AiProviderId => (p === 'codex' ? 'codex' : 'claude');

/** A run's consolidated, non-praise findings (merged-away duplicates left out). */
export function openFindingsOf<F extends LoopFindingLike>(findings: readonly F[], runIds: ReadonlySet<number>): F[] {
  return findings.filter((f) => runIds.has(f.reviewId) && f.mergedInto == null && f.severity !== 'praise');
}

/**
 * THE SETTLED "NOT APPLICABLE" VERDICTS as of one story check: this check's own verdicts, plus every
 * "accepted" an EARLIER succeeded check gave that no later check (up to this one) rejected. An accepted
 * criterion leaves the fix seed, so the agent never claims it again and the next check gets no claim for
 * it: without the carry it would read open again on the next round. Newest verdict per ref wins.
 */
export function effectiveClaimVerdicts(check: LoopCheckLike | null, checks: readonly LoopCheckLike[] = []): StoryBuildLoopClaimVerdict[] {
  if (!check) return [];
  const byRef = new Map<string, StoryBuildLoopClaimVerdict>();
  const earlier = checks.filter((c) => c.status === 'succeeded' && c.round < check.round).sort((a, z) => a.round - z.round);
  for (const c of earlier) for (const v of c.claimVerdicts ?? []) byRef.set(v.ref.toUpperCase(), v);
  for (const v of check.claimVerdicts ?? []) byRef.set(v.ref.toUpperCase(), v);
  const own = new Set((check.claimVerdicts ?? []).map((v) => v.ref.toUpperCase()));
  // Carried: only an earlier ACCEPTED one (an earlier rejection is this round's business, not a verdict now).
  return [...byRef.entries()].filter(([ref, v]) => own.has(ref) || v.verdict === 'accepted').map(([, v]) => v);
}

/** The criteria refs whose "not applicable" note the story checks ACCEPTED, as of this check (carried forward). */
export const acceptedNa = (check: LoopCheckLike | null, checks: readonly LoopCheckLike[] = []): Set<string> =>
  new Set(effectiveClaimVerdicts(check, checks).filter((v) => v.verdict === 'accepted').map((v) => v.ref.toUpperCase()));

/** The open criteria of a story check (accepted "not applicable" notes, this round's or earlier, settle one). */
export function openCriteriaOf(check: LoopCheckLike | null, checks: readonly LoopCheckLike[] = []): OpenCriterion[] {
  const a = check?.status === 'succeeded' ? check.assessment : null;
  if (!a) return [];
  const na = acceptedNa(check, checks);
  return [
    ...a.criteria
      .filter((c) => OPEN_CRITERION.has(c.status) && !na.has(c.ref.toUpperCase()))
      .map((c) => ({ ref: c.ref, status: c.status as 'not_met' | 'partly_met' | 'unclear', text: c.text, explanation: c.explanation })),
    ...a.missing.filter((m) => !na.has(m.ref.toUpperCase())).map((m) => ({ ref: m.ref, status: 'missing' as const, text: m.title, explanation: m.explanation })),
  ];
}

/**
 * The earlier findings one round's review left 'not_checked' (the reviewer said nothing on them, or they were
 * over the prompt cap): CARRIED, as in the PR flow (persist.ts `loadPriorReviewForFollowUp`) — they stay open,
 * are seeded to the fix pass and judged again next round. A finding another run of the round judged is not one.
 */
export function notCheckedIdsOf(reviews: readonly LoopRunLike[], round: number, target?: { kind: string; id: number }): Set<number> {
  const runs = reviews.filter((r) => r.round === round && r.status === 'succeeded' && (!target || (r.targetKind === target.kind && r.targetId === target.id)));
  const unchecked = new Set<number>();
  const judged = new Set<number>();
  for (const r of runs) {
    for (const it of r.followUp?.items ?? []) {
      if (it.priorFindingId == null) continue;
      (it.status === 'not_checked' ? unchecked : judged).add(it.priorFindingId);
    }
  }
  return new Set([...unchecked].filter((id) => !judged.has(id)));
}

/** The carried 'not_checked' findings of a round (open, non-praise, not merged away). */
export function notCheckedFindingsOf<F extends LoopFindingLike>(
  reviews: readonly LoopRunLike[],
  findings: readonly F[],
  round: number,
  target?: { kind: string; id: number },
): F[] {
  const ids = notCheckedIdsOf(reviews, round, target);
  return findings.filter((f) => ids.has(f.id) && f.mergedInto == null && f.severity !== 'praise');
}

/** What is open after one round's review (B0 "open"). `findings` counts the carried 'not_checked' ones too. */
export function roundOpen(
  round: number,
  reviews: readonly LoopRunLike[],
  findings: readonly LoopFindingLike[],
  check: LoopCheckLike | null,
  checks: readonly LoopCheckLike[] = [],
): RoundOpen {
  const runs = reviews.filter((r) => r.round === round && r.status === 'succeeded');
  const ids = new Set(runs.map((r) => r.id));
  const followUps = runs
    .filter((r) => r.pairRole !== 'second')
    .reduce((n, r) => n + (r.followUp?.items ?? []).filter((it) => OPEN_FOLLOW_UP.has(it.status)).length, 0);
  return {
    findings: openFindingsOf(findings, ids).length + notCheckedFindingsOf(reviews, findings, round).length,
    followUps,
    criteria: openCriteriaOf(check, checks).length,
  };
}

/**
 * THE STOP RULE, after review round `round` of a loop with `rounds` fix passes: nothing open (findings +
 * criteria; follow-ups are already counted as the findings they re-raise), or this was the closing review
 * (round N + 1) ⇒ 'open' (the loop ends); otherwise ⇒ 'fix' (one more fix pass).
 */
export function nextAfterReview(open: Pick<RoundOpen, 'findings' | 'criteria'>, round: number, rounds: number): 'open' | 'fix' {
  const total = open.findings + open.criteria;
  return total === 0 || round >= rounds + 1 ? 'open' : 'fix';
}

/**
 * THE NEXT ROUND'S FOLLOW-UP INPUT for one target: the last round it was reviewed in, its consolidated
 * non-praise findings, each with the fix agent's answer as a "reply" (`responseLine`). `posted: true` so
 * the prompt never says "Not posted to GitHub yet" (nothing of the loop is posted). A finding raised by the
 * OTHER provider than `forProvider` carries `raisedBy` (judged, never disputed — as in the PR pair).
 */
export function priorForTarget(
  reviews: readonly LoopRunLike[],
  findings: readonly LoopPriorFindingLike[],
  kind: string,
  id: number,
  beforeRound: number,
  forProvider: AiProviderId,
): PriorReviewForFollowUp | null {
  const done = reviews.filter((r) => r.targetKind === kind && r.targetId === id && r.status === 'succeeded' && r.round < beforeRound);
  if (done.length === 0) return null;
  const last = Math.max(...done.map((r) => r.round));
  const runs = done.filter((r) => r.round === last);
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const allRuns = new Map(reviews.map((r) => [r.id, r]));
  const lead = runs.find((r) => r.pairRole !== 'second') ?? runs[0]!;
  const own = openFindingsOf(findings, new Set(byRun.keys())).map((f) => ({ f, carried: false }));
  const carried = notCheckedFindingsOf(reviews, findings, last, { kind, id }).map((f) => ({ f, carried: true }));
  const list: PriorFindingForFollowUp[] = [...own, ...carried].filter(({ f }) => allRuns.has(f.reviewId)).map(({ f, carried: isCarried }) => {
    const run = allRuns.get(f.reviewId)!;
    const raised = providerOf(run.provider);
    const answered = f.response != null && f.response !== 'not_reported';
    return {
      id: f.id,
      headSha: run.headSha,
      path: f.path,
      line: f.line,
      side: f.side,
      severity: f.severity,
      title: f.title,
      body: f.body,
      suggestion: f.suggestion,
      diffHunk: f.diffHunk,
      anchored: f.anchored,
      fileInDiff: f.fileInDiff,
      posted: true,
      carried: isCarried,
      ...(answered
        ? { thread: { threadId: 0, threadFindingId: f.id, replies: [{ author: 'build agent', body: responseLine(f.response!, f.responseText), at: iso(f.createdAt) ?? new Date(0).toISOString() }], pushedBack: false } }
        : {}),
      ...(raised !== forProvider ? { raisedBy: raised } : {}),
    };
  });
  if (list.length === 0) return null;
  return { reviewId: lead.id, headSha: lead.headSha, findings: list };
}
