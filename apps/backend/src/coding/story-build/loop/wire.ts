// THE REVIEW LOOP'S FOLDS (PURE): the stored rows → the wire (`StoryBuildLoop`) and the PR body's summary.
// "What is open" after a round and the next round's follow-up input are the SHARED round rule
// (coding/review-loop/rounds.ts), read here over the Build loop's rows. Ids on the wire are BUILD-LOCAL.
import { createHash } from 'node:crypto';
import {
  STORY_BUILD_LOOP_PAUSE_LINE,
  loopNextLine,
  type AiProviderId,
  type ClaudeFinding,
  type ClaudeFollowUpItem,
  type ClaudeReview,
  type StoryBuildLoop,
  type StoryBuildLoopFinding,
  type StoryBuildLoopRound,
  type StoryBuildLoopTarget,
  type StoryBuildLoopTargetReview,
  type StoryBuildLoopState,
  type StoryBuildLoopPause,
  type TicketAssessment,
  type TicketReview,
} from '@pierre-review/shared';
import type { LoopAcResponseRow, LoopFindingRow, LoopPushRow, LoopReviewRow, LoopStoryCheckRow } from './persist.js';
import type { LoopTarget } from './targets.js';
import { acceptedNa, effectiveClaimVerdicts, notCheckedFindingsOf, openCriteriaOf, openFindingsOf, roundOpen } from '../../review-loop/rounds.js';
import type { LoopBodySummary } from './pr-body.js';

const iso = (d: Date | number | null | undefined): string | null =>
  d == null ? null : (d instanceof Date ? d : new Date(typeof d === 'number' && d < 1e12 ? d * 1000 : d)).toISOString();

const anchor = (path: string): string => createHash('sha256').update(path, 'utf8').digest('hex');

const providerOf = (p: string | null): AiProviderId => (p === 'codex' ? 'codex' : 'claude');

/** The runs of one round for one target, newest attempt only (a re-run replaced failed rows). */
export function runsOf(reviews: readonly LoopReviewRow[], round: number, kind: string, id: number): LoopReviewRow[] {
  return reviews
    .filter((r) => r.round === round && r.targetKind === kind && r.targetId === id)
    .sort((a, b) => (a.pairRole === 'second' ? 1 : 0) - (b.pairRole === 'second' ? 1 : 0) || a.id - b.id);
}

// ---- the wire -------------------------------------------------------------------------------------------

function findingWire(f: LoopFindingRow, run: LoopReviewRow, source: StoryBuildLoopFinding['raisedBy']): StoryBuildLoopFinding {
  const base: ClaudeFinding = {
    id: f.id,
    reviewId: f.reviewId,
    path: f.path,
    line: f.line,
    side: f.side,
    diffAnchorId: anchor(f.path),
    severity: f.severity,
    title: f.title,
    body: f.body,
    editedBody: null,
    suggestion: f.suggestion,
    diffHunk: f.diffHunk,
    anchored: f.anchored,
    fileInDiff: f.fileInDiff,
    included: true,
    postedAt: null,
    githubCommentId: null,
    postedCommentKind: null,
    createdAt: iso(f.createdAt) ?? new Date(0).toISOString(),
    priorFindingId: f.priorFindingId,
    lens: (f.lens as ClaudeFinding['lens']) ?? null,
  };
  return {
    ...base,
    targetKind: run.targetKind,
    targetId: run.targetId,
    round: f.round,
    raisedBy: source,
    response: f.response != null ? { action: f.response, text: f.responseText, round: f.responseRound ?? f.round } : null,
  };
}

export function runWireOf(r: LoopReviewRow, findings: readonly LoopFindingRow[]): ClaudeReview {
  const mine = findings.filter((f) => f.reviewId === r.id);
  return {
    id: r.id,
    prId: 0,
    headSha: r.headSha,
    status: r.status === 'skipped' ? 'cancelled' : (r.status as ClaudeReview['status']),
    model: r.model ?? '',
    provider: providerOf(r.provider),
    effort: r.effort,
    scope: null,
    reviewMode: (r.reviewMode as ClaudeReview['reviewMode']) ?? null,
    routeReason: null,
    summary: r.summary,
    verdict: (r.verdict as ClaudeReview['verdict']) ?? null,
    userBody: null,
    userVerdict: null,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: r.numTurns,
    diffBytes: null,
    diffCapped: null,
    error: r.failureReason,
    excludedFiles: [],
    postedReviewId: null,
    postedAt: null,
    createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
    finishedAt: iso(r.completedAt),
    findings: mine.map((f) => findingWire(f, r, providerOf(r.provider))),
    trigger: 'auto',
    ...(r.pairRole ? { pair: { pairId: r.id, role: r.pairRole, otherReviewId: null } } : {}),
  };
}

function followUpWire(r: LoopReviewRow | undefined, findings: readonly LoopFindingRow[]): ClaudeFollowUpItem[] {
  const items = r?.followUp?.items ?? [];
  return items.map((it) => ({
    ...it,
    reraisedFindingId: findings.find((f) => f.reviewId === r!.id && f.priorFindingId === it.priorFindingId)?.id ?? null,
  }));
}

function targetReview(round: number, t: Pick<LoopTarget, 'kind' | 'id'>, reviews: readonly LoopReviewRow[], findings: readonly LoopFindingRow[]): StoryBuildLoopTargetReview | null {
  const runs = runsOf(reviews, round, t.kind, t.id);
  if (runs.length === 0) return null;
  const ok = runs.filter((r) => r.status === 'succeeded');
  const lead = ok.find((r) => r.pairRole !== 'second') ?? ok[0] ?? runs[0]!;
  const consolidation = lead.pairConsolidation;
  const ids = new Set(ok.map((r) => r.id));
  const byId = new Map(runs.map((r) => [r.id, r]));
  const kept = openFindingsOf(findings, ids).concat(findings.filter((f) => ids.has(f.reviewId) && f.mergedInto == null && f.severity === 'praise'));
  const sev: Record<string, number> = { blocker: 0, warning: 1, question: 2, nit: 3, praise: 4 };
  return {
    targetKind: t.kind,
    targetId: t.id,
    headSha: lead.headSha,
    baseSha: lead.baseSha,
    runs: runs.map((r) => runWireOf(r, findings)),
    verdict: (consolidation?.verdict ?? (lead.verdict as ClaudeReview['verdict'])) ?? null,
    summary: consolidation?.summary ?? lead.summary,
    findings: kept
      .map((f) => {
        const run = byId.get(f.reviewId)!;
        const src = consolidation?.sourceOf?.[String(f.id)];
        return findingWire(f, run, src === 'both' ? 'both' : src ? src : providerOf(run.provider));
      })
      .sort((a, b) => (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9)),
    followUp: followUpWire(lead.status === 'succeeded' ? lead : undefined, findings),
  };
}

function storyCheckWire(c: LoopStoryCheckRow, build: { id: number; ident: string; ticketKey: string; ticketTitle: string | null; workspaceId: number }): TicketReview {
  const assessment: TicketAssessment | null = c.assessment;
  return {
    id: c.id,
    ident: build.ident,
    ticketKey: build.ticketKey,
    ticketTitle: build.ticketTitle,
    ticket: null,
    workspaceId: build.workspaceId,
    originPrId: null,
    trigger: 'auto',
    status: c.status === 'skipped' ? 'cancelled' : (c.status as TicketReview['status']),
    model: c.model ?? '',
    provider: providerOf(c.provider),
    costUsd: c.costUsd,
    error: c.failureReason,
    refused: null,
    createdAt: iso(c.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(c.createdAt),
    completedAt: iso(c.completedAt),
    alignment: assessment?.alignment ?? null,
    summary: assessment?.summary ?? null,
    assessment,
    members: (c.members ?? []).map((m) => ({
      prId: m.targetId,
      repoId: m.repoId,
      repo: m.repo,
      number: 0,
      title: null,
      headSha: m.headSha,
      state: 'open' as const,
      checkedOut: true,
      label: `branch ${m.branch}`,
    })),
    items: [],
  };
}

export interface LoopWireInput {
  build: {
    id: number;
    ident: string;
    ticketKey: string;
    ticketTitle: string | null;
    workspaceId: number;
    autoPush: boolean;
    loopRounds: number;
    loopState: StoryBuildLoopState | null;
    loopRound: number;
    loopPause: StoryBuildLoopPause | null;
    loopError: string | null;
    loopClaimedAt: Date | null;
  };
  targets: readonly LoopTarget[];
  pushes: readonly LoopPushRow[];
  reviews: readonly LoopReviewRow[];
  findings: readonly LoopFindingRow[];
  checks: readonly LoopStoryCheckRow[];
  acResponses: readonly LoopAcResponseRow[];
  /** Who reviews the code next (the workspace's setting). */
  providers: readonly AiProviderId[];
  /** Something of the build was pushed by hand (the switch can no longer change). */
  anyPushed: boolean;
  /** The loop is running in this process now. */
  running: boolean;
}

/** THE wire mapper. */
export function toStoryBuildLoop(i: LoopWireInput): StoryBuildLoop {
  const b = i.build;
  const targets: StoryBuildLoopTarget[] = i.targets.map((t) => {
    const open = [...i.pushes].reverse().find((p) => p.targetKind === t.kind && p.targetId === t.id && p.step === 'open' && p.prNumber != null);
    return {
      kind: t.kind,
      id: t.id,
      repoId: t.repoId,
      fullName: t.fullName,
      key: t.key,
      title: t.title,
      branch: t.loopBranch,
      pushedSha: t.loopPushedSha,
      pushedAt: iso(t.loopPushedAt),
      ended: t.loopEnded,
      prNumber: t.pushedPrNumber ?? open?.prNumber ?? null,
      prUrl: t.pushedPrUrl ?? open?.prUrl ?? null,
      pushError: t.pushError,
      pushErrorCode: t.pushErrorCode,
    };
  });
  const rounds = [...new Set([...i.reviews.map((r) => r.round), ...i.checks.map((c) => c.round)])].sort((a, z) => a - z);
  const history: StoryBuildLoopRound[] = rounds.map((round) => {
    const check = i.checks.find((c) => c.round === round) ?? null;
    const open = roundOpen(round, i.reviews, i.findings, check, i.checks);
    const fixPushes = i.pushes.filter((p) => p.step === 'fix' && p.round === round);
    const fixRan = fixPushes.length > 0 || i.acResponses.some((r) => r.round === round) || i.findings.some((f) => f.responseRound === round);
    const fixState: NonNullable<StoryBuildLoopRound['fix']>['state'] =
      b.loopState === 'fixing' && b.loopRound === round ? 'running' : fixRan ? 'done' : b.loopState === 'paused' && b.loopRound === round && (b.loopPause === 'fix_stopped' || b.loopPause === 'fix_failed') ? (b.loopPause === 'fix_stopped' ? 'stopped' : 'failed') : 'none';
    return {
      round,
      closing: round > b.loopRounds,
      reviews: i.targets.map((t) => targetReview(round, t, i.reviews, i.findings)).filter((x): x is StoryBuildLoopTargetReview => x != null),
      storyCheck: check ? storyCheckWire(check, b) : null,
      claimVerdicts: effectiveClaimVerdicts(check, i.checks),
      acResponses: i.acResponses.filter((r) => r.round === round).map((r) => ({ ref: r.ref, response: r.response, text: r.text })),
      open,
      fix:
        fixState === 'none' && fixPushes.length === 0
          ? null
          : {
              state: fixState,
              pushed: fixPushes.map((p) => ({ targetKind: p.targetKind, targetId: p.targetId, sha: p.pushedSha, error: p.error })),
            },
    };
  });
  const latest = history.at(-1) ?? null;
  const state = b.loopState;
  const loopCore = { on: b.autoPush, state, round: b.loopRound, rounds: b.loopRounds, pause: b.loopPause, targets };
  const terminal = state === 'done' || state === 'stopped' || state === 'failed';
  return {
    ...loopCore,
    editable: b.loopClaimedAt == null && !i.anyPushed,
    pauseLine: state === 'paused' ? (b.loopError ?? (b.loopPause ? STORY_BUILD_LOOP_PAUSE_LINE[b.loopPause] : null)) : state === 'stopped' || state === 'failed' ? b.loopError : null,
    canContinue: state === 'paused' && !i.running,
    error: b.loopError,
    history,
    next: terminal ? null : loopNextLine(loopCore, i.providers, latest ? { findings: latest.open.findings, criteria: latest.open.criteria } : null),
  };
}

// ---- the PR body's summary ------------------------------------------------------------------------------

/** The `## Review in Limn` numbers for one target (or every target when `kind` is null). */
export function loopBodySummaryOf(
  i: Pick<LoopWireInput, 'reviews' | 'findings' | 'checks' | 'acResponses'> & { finalRound: number; providers: AiProviderId[] },
  target: Pick<LoopTarget, 'kind' | 'id'> | null,
): LoopBodySummary {
  const mine = i.reviews.filter((r) => r.status === 'succeeded' && (target == null || (r.targetKind === target.kind && r.targetId === target.id)));
  const reviews = new Set(mine.map((r) => r.round)).size;
  const ids = new Set(mine.map((r) => r.id));
  const all = openFindingsOf(i.findings, ids);
  const lastRound = mine.length > 0 ? Math.max(...mine.map((r) => r.round)) : 0;
  const lastIds = new Set(mine.filter((r) => r.round === lastRound).map((r) => r.id));
  const stillOpen = [...openFindingsOf(i.findings, lastIds), ...notCheckedFindingsOf(mine, i.findings, lastRound)].map((f) => ({ severity: f.severity, path: f.path, title: f.title }));
  const accepted = mine
    .flatMap((r) => r.followUp?.items ?? [])
    .filter((it) => it.status === 'reply_accepted').length;
  const check = [...i.checks].filter((c) => c.status === 'succeeded').sort((a, z) => z.round - a.round)[0] ?? null;
  const na = acceptedNa(check, i.checks);
  const criteria = check?.assessment
    ? {
        met: check.assessment.criteria.filter((c) => (c.status === 'met' || c.status === 'met_outside_code') && !na.has(c.ref.toUpperCase())).length,
        notApplicable: effectiveClaimVerdicts(check, i.checks).filter((v) => v.verdict === 'accepted').map((v) => ({ ref: v.ref, why: v.why })),
        notMet: openCriteriaOf(check, i.checks).length,
      }
    : null;
  return {
    reviews,
    providers: i.providers,
    fixed: all.filter((f) => f.response === 'fixed').length,
    answered: all.filter((f) => f.response === 'answered').length,
    pushedBackAccepted: accepted,
    stillOpen,
    criteria,
  };
}
