// AI FIX'S REVIEW LOOP — THE WIRE (PURE): the stored rows → `AiFix.loop` (shared ai-fix-loop.ts). What is open
// after a round is the SHARED round rule (coding/review-loop/rounds.ts) over the fix's rows. Ids are FIX-LOCAL.
import {
  AI_FIX_LOOP_STOP_LINE,
  type AiFixLoop,
  type AiFixLoopCriterion,
  type AiFixLoopFinding,
  type AiFixLoopRound,
  type AiFixLoopRunStatus,
  type AiFixLoopState,
  type AiFixLoopStop,
  type AiProviderId,
  type ClaudeReview,
} from '@pierre-review/shared';
import { notCheckedFindingsOf, openCriteriaOf, openFindingsOf, roundOpen } from '../review-loop/rounds.js';
import type { FixLoopAcResponseRow, FixLoopFindingRow, FixLoopReviewRow, FixLoopStoryCheckRow } from './loop-persist.js';

const providerOf = (p: string | null): AiProviderId => (p === 'codex' ? 'codex' : 'claude');
const runStatus = (s: string): AiFixLoopRunStatus =>
  s === 'succeeded' || s === 'failed' || s === 'skipped' || s === 'cancelled' ? s : 'running';
const SEV: Record<string, number> = { blocker: 0, warning: 1, question: 2, nit: 3, praise: 4 };

export interface FixLoopWireInput {
  fix: {
    loopState: AiFixLoopState | null;
    loopRound: number;
    loopFirstRound: number;
    loopRounds: number | null;
    loopStop: AiFixLoopStop | null;
    loopReviewId: number | null;
  };
  reviews: readonly FixLoopReviewRow[];
  findings: readonly FixLoopFindingRow[];
  checks: readonly FixLoopStoryCheckRow[];
  acResponses: readonly FixLoopAcResponseRow[];
  /** The loop works in this process now. */
  running: boolean;
}

/** The round's place in its loop run, as stored on its review rows at the run's start (a reader's follow-up runs
 *  are contiguous, so it is not derivable from the round numbers). A round with no stored step (no review row) is
 *  placed after the latest stored one before it, or from the current run's first round. */
function placeOf(
  round: number,
  stored: ReadonlyMap<number, { step: number; rounds: number }>,
  current: { firstRound: number; rounds: number },
): { step: number; rounds: number } {
  const own = stored.get(round);
  if (own) return own;
  if (round >= current.firstRound) return { step: round - current.firstRound + 1, rounds: current.rounds };
  const prev = [...stored.entries()].filter(([n]) => n < round).sort((a, z) => z[0] - a[0])[0];
  return prev ? { step: prev[1].step + (round - prev[0]), rounds: prev[1].rounds } : { step: round, rounds: current.rounds };
}

/** THE wire mapper. null when the loop never ran. */
export function toAiFixLoop(i: FixLoopWireInput): AiFixLoop | null {
  const f = i.fix;
  if (f.loopState == null) return null;
  const rounds = f.loopRounds ?? 1;
  const roundNos = [...new Set([...i.reviews.map((r) => r.round), ...i.checks.map((c) => c.round)])].sort((a, z) => a - z);
  const stored = new Map<number, { step: number; rounds: number }>();
  for (const r of i.reviews) if (r.step != null && r.rounds != null && !stored.has(r.round)) stored.set(r.round, { step: r.step, rounds: r.rounds });
  const current = { firstRound: f.loopFirstRound, rounds };
  const history: AiFixLoopRound[] = roundNos.map((round) => {
    const runs = i.reviews.filter((r) => r.round === round).sort((a, z) => (a.pairRole === 'second' ? 1 : 0) - (z.pairRole === 'second' ? 1 : 0) || a.id - z.id);
    const ok = runs.filter((r) => r.status === 'succeeded');
    const lead = ok.find((r) => r.pairRole !== 'second') ?? ok[0] ?? runs[0] ?? null;
    const ids = new Set(ok.map((r) => r.id));
    const check = i.checks.find((c) => c.round === round) ?? null;
    const open = roundOpen(round, i.reviews, i.findings, check, i.checks);
    const carried = notCheckedFindingsOf(i.reviews, i.findings, round);
    const kept = [...openFindingsOf(i.findings, ids), ...carried];
    const byId = new Map(i.reviews.map((r) => [r.id, r]));
    const sourceOf = lead?.pairConsolidation?.sourceOf ?? {};
    const findings: AiFixLoopFinding[] = kept
      .map((x) => {
        const run = byId.get(x.reviewId);
        const src = sourceOf[String(x.id)];
        return {
          id: x.id,
          round: x.round,
          severity: x.severity,
          path: x.path,
          line: x.line,
          title: x.title,
          body: x.body,
          raisedBy: src === 'both' ? ('both' as const) : src ? src : run ? providerOf(run.provider) : null,
          response: x.response != null && x.responseRound === round ? { action: x.response, text: x.responseText, round } : null,
        };
      })
      .sort((a, z) => (SEV[a.severity] ?? 9) - (SEV[z.severity] ?? 9));
    const answers = i.acResponses.filter((r) => r.round === round);
    const criteria: AiFixLoopCriterion[] = openCriteriaOf(check, i.checks).map((c) => {
      const a = answers.find((r) => r.ref.toUpperCase() === c.ref.toUpperCase());
      return { ref: c.ref, status: c.status, text: c.text, explanation: c.explanation, response: a ? { action: a.response, text: a.text } : null };
    });
    const answeredFindings = findings.filter((x) => x.response != null);
    const count = (act: string) => answeredFindings.filter((x) => x.response!.action === act).length + answers.filter((a) => a.response === act).length;
    const { step, rounds: runRounds } = placeOf(round, stored, current);
    const fixRan = answers.length > 0 || i.findings.some((x) => x.responseRound === round);
    const fix: AiFixLoopRound['fix'] =
      f.loopState === 'fixing' && f.loopRound === round
        ? 'running'
        : fixRan
          ? 'done'
          : f.loopRound === round && f.loopState === 'stopped' && (f.loopStop === 'fix_failed' || f.loopStop === 'stopped') && lead?.status === 'succeeded' && open.findings + open.criteria > 0
            ? f.loopStop === 'stopped'
              ? 'stopped'
              : 'failed'
            : 'none';
    return {
      round,
      step,
      closing: step > runRounds,
      headSha: lead?.headSha ?? null,
      review: lead ? runStatus(lead.status) : null,
      providers: [...new Set(runs.map((r) => providerOf(r.provider)))],
      verdict: ((lead?.pairConsolidation?.verdict ?? lead?.verdict) as ClaudeReview['verdict']) ?? null,
      summary: lead?.pairConsolidation?.summary ?? lead?.summary ?? null,
      storyCheck: check ? runStatus(check.status) : null,
      open: { findings: open.findings, criteria: open.criteria },
      counts: { found: open.findings + open.criteria, fixed: count('fixed'), answered: count('answered'), pushedBack: count('pushed_back'), cannotMeet: count('cannot_meet') },
      findings,
      criteria,
      fix,
    };
  });
  // THE CRITERIA THE AGENT SAYS CANNOT BE DONE, as of the latest round: still open, latest answer cannot_meet.
  const last = history.at(-1) ?? null;
  const cannotMeet: AiFixLoop['cannotMeet'] = [];
  if (last) {
    for (const c of last.criteria) {
      const latest = i.acResponses.filter((a) => a.ref.toUpperCase() === c.ref.toUpperCase() && a.response !== 'not_reported').sort((a, z) => z.round - a.round)[0];
      const why = (latest?.text ?? '').trim();
      if (latest?.response === 'cannot_meet' && why !== '') cannotMeet.push({ ref: c.ref, text: c.text, reason: why });
    }
  }
  const working = f.loopState === 'reviewing' || f.loopState === 'fixing';
  return {
    state: f.loopState,
    round: f.loopRound,
    firstRound: f.loopFirstRound,
    rounds,
    stop: working ? null : f.loopStop,
    stopLine: !working && f.loopStop ? AI_FIX_LOOP_STOP_LINE[f.loopStop] : null,
    running: i.running,
    history,
    cannotMeet,
    importedReviewId: f.loopReviewId,
  };
}
