import {
  criterionTextOnly,
  storyBuildIsGap,
  type StoryBuildCoverage,
  type StoryDocsCriterion,
  type TicketAssessment,
  type TicketReviewStatus,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { StoryBuildTicketPr } from './inputs.js';

// THE GAP FOLD ("Implement story", docs/STORY-BUILD.md § The gap fold): what the ticket's EXISTING pull
// requests already deliver, frozen at assess time (`story_builds.coverage_json`).
//
//   no ticket PR            every criterion is a gap                                  state 'none'
//   a CURRENT ticket check  its verdicts: `met` is done (with the PRs that deliver it), anything else
//                           — partly_met / not_met / unclear / not_checked — is a gap, and every
//                           `missing` item (M1…) is a gap too                         state 'checked'
//   no check, or STALE      the assess phase starts ONE manual ticket check (a person pressed the
//                           button, so it sits outside the ticket check's daily cap) and WAITS for it
//                           (phase checking_coverage), then folds it                 state 'checked'
//     · it fails / times out  every criterion a gap, said in one line                 state 'failed'
//     · it cannot start       the last check's verdicts, said in one line             state 'stale'
//
// Owner decision 4 shows the button only for a ticket with NO PR, so the wait is rare; it stays here
// because it is cheap (owner decision 5). The fold itself (`foldCoverage`) is PURE.

export const COVERAGE_CHECK_FAILED = "Couldn't check the existing PRs: building every criterion.";
export const COVERAGE_CHECK_STALE = 'The ticket check is out of date: building from the last one.';
/** How long the assess phase waits for the ticket check it started. */
export const COVERAGE_WAIT_MS = 15 * 60_000;
const POLL_MS = 2_000;

export interface CoverageCheck {
  id: number;
  assessment: TicketAssessment | null;
  completedAt: Date | null;
}

/** The fold (pure). `criteria` is the story's own list (inputs), used when no check is folded. */
export function foldCoverage(a: {
  criteria: readonly StoryDocsCriterion[];
  check: CoverageCheck | null;
  state: StoryBuildCoverage['state'];
  prs: readonly StoryBuildTicketPr[];
  note: string | null;
}): StoryBuildCoverage {
  const existingPrs = a.prs.map((p) => ({ prId: p.prId, repoId: p.repoId, number: p.number, state: p.state, headSha: p.headSha || null }));
  const assessment = a.state === 'checked' || a.state === 'stale' ? (a.check?.assessment ?? null) : null;
  if (assessment != null) {
    return {
      state: a.state,
      ticketReviewId: a.check!.id,
      checkedAt: a.check!.completedAt ? a.check!.completedAt.toISOString() : null,
      criteria: assessment.criteria.map((c) => ({
        ref: c.ref,
        text: criterionTextOnly(c.text, c.ref),
        verdict: c.status,
        coveredByPrIds: c.status === 'met' ? [...new Set(c.deliveredBy)] : [],
      })),
      missing: assessment.missing.map((m) => ({ ref: m.ref, text: m.title })),
      existingPrs,
      note: a.note,
    };
  }
  return {
    state: a.state === 'checked' || a.state === 'stale' ? 'none' : a.state,
    ticketReviewId: null,
    checkedAt: null,
    criteria: a.criteria.map((c) => ({ ref: `AC${c.n}`, text: c.text, verdict: 'not_checked', coveredByPrIds: [] })),
    missing: [],
    existingPrs,
    note: a.note,
  };
}

/** The refs the plan must account for: the gap criteria, then the missing items. */
export function gapRefsOf(c: StoryBuildCoverage | null): string[] {
  if (c == null) return [];
  return [...c.criteria.filter(storyBuildIsGap).map((x) => x.ref), ...c.missing.map((m) => m.ref)];
}

// ---- the assess phase (DB + the ticket check's own manager) -----------------------------------------

export type CoverageMember = { prId: number; headSha: string; state: 'open' | 'merged' };
export type CoverageLive = { ticketHash: string; members: CoverageMember[] } | null;

export interface CoverageState {
  latest: (CoverageCheck & { fingerprint: string | null; ticketHash: string | null; alignment: unknown; members: CoverageMember[] }) | null;
  runningRunId: number | null;
}

export interface CoverageSeams {
  checkState(ctx: AgentContext, accountId: number, ident: string): Promise<CoverageState>;
  /** The story's hash as the ticket check computes it (null ⇒ unknown: the latest check reads current). */
  liveTicketHash(accountId: number, ident: string): Promise<string | null>;
  /** Is the latest check current for these live inputs? */
  isCurrent(ident: string, state: CoverageState, live: CoverageLive): Promise<boolean>;
  startCheck(
    ctx: AgentContext,
    a: { accountId: number; workspaceId: number; ident: string; ticketKey: string; ticketTitle: string | null },
  ): Promise<{ outcome: 'queued' | 'already_running'; runId: number | null } | { outcome: 'busy' | 'disabled' }>;
  runStatus(ctx: AgentContext, accountId: number, runId: number): Promise<TicketReviewStatus | null>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', done);
      resolve();
    }, ms);
    const done = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
  });

export const defaultCoverageSeams: CoverageSeams = {
  async checkState(ctx, accountId, ident) {
    const { getTicketStateInputs } = await import('../../review/ticket-review/persist.js');
    const got = (await getTicketStateInputs(ctx, accountId, [ident])).get(ident);
    if (got == null) return { latest: null, runningRunId: null };
    return {
      latest:
        got.latest == null
          ? null
          : {
              id: got.latest.id,
              assessment: got.latest.assessment,
              completedAt: got.latest.completedAt,
              fingerprint: got.latest.fingerprint,
              ticketHash: got.latest.ticketHash,
              alignment: got.latest.alignment,
              members: got.latest.members,
            },
      runningRunId: got.runningRunId,
    };
  },
  async liveTicketHash(accountId, ident) {
    const [{ jiraStoryFor }, { ticketHash }] = await Promise.all([
      import('../../review/ticket-review/prepare.js'),
      import('../../review/ticket-review/fingerprint.js'),
    ]);
    const t = await jiraStoryFor(accountId, ident);
    return t == null ? null : ticketHash(t);
  },
  async isCurrent(ident, state, live) {
    // The ticket check's own currency rule (fingerprint.ts `deriveTicketReviewState`).
    const { deriveTicketReviewState } = await import('../../review/ticket-review/fingerprint.js');
    return (
      deriveTicketReviewState({
        ident,
        latest: state.latest == null ? null : { ...state.latest, alignment: state.latest.alignment as never },
        runningRunId: null,
        live,
      }).status === 'current'
    );
  },
  async startCheck(ctx, a) {
    const { startTicketReview } = await import('../../review/ticket-review/manager.js');
    const r = await startTicketReview(ctx, { ...a, manualTicket: null, originPrId: null, trigger: 'manual' });
    return r;
  },
  async runStatus(ctx, accountId, runId) {
    const { getTicketReviewRow } = await import('../../review/ticket-review/persist.js');
    const row = (await getTicketReviewRow(ctx, accountId, runId)) as { status: TicketReviewStatus } | null;
    return row?.status ?? null;
  },
  sleep,
};

export interface AssessCoverageArgs {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticketKey: string;
  ticketTitle: string | null;
  criteria: readonly StoryDocsCriterion[];
  prs: readonly StoryBuildTicketPr[];
  signal: AbortSignal;
  timeoutMs?: number;
}

/** The assess phase's coverage (see the header). Throws only on a cancel (`signal`). */
export async function assessCoverage(
  ctx: AgentContext,
  a: AssessCoverageArgs,
  seams: CoverageSeams = defaultCoverageSeams,
): Promise<StoryBuildCoverage> {
  const fold = (state: StoryBuildCoverage['state'], check: CoverageCheck | null, note: string | null): StoryBuildCoverage =>
    foldCoverage({ criteria: a.criteria, check, state, prs: a.prs, note });
  if (a.prs.length === 0) return fold('none', null, null);

  const before = await seams.checkState(ctx, a.accountId, a.ident);
  const hash = await seams.liveTicketHash(a.accountId, a.ident).catch(() => null);
  const live: CoverageLive = hash == null ? null : { ticketHash: hash, members: a.prs.map((p) => ({ prId: p.prId, headSha: p.headSha, state: p.state })) };
  if (before.runningRunId == null && before.latest != null && (await seams.isCurrent(a.ident, before, live))) {
    return fold('checked', before.latest, null);
  }

  // A check is needed: join the one running, else start one.
  let runId = before.runningRunId;
  if (runId == null) {
    const started = await seams.startCheck(ctx, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      ident: a.ident,
      ticketKey: a.ticketKey,
      ticketTitle: a.ticketTitle,
    });
    if (!('runId' in started)) {
      return before.latest != null ? fold('stale', before.latest, COVERAGE_CHECK_STALE) : fold('failed', null, COVERAGE_CHECK_FAILED);
    }
    runId = started.runId;
  }
  const until = Date.now() + (a.timeoutMs ?? COVERAGE_WAIT_MS);
  for (;;) {
    if (a.signal.aborted) throw new Error('cancelled');
    if (runId == null) runId = (await seams.checkState(ctx, a.accountId, a.ident)).runningRunId;
    const status = runId == null ? null : await seams.runStatus(ctx, a.accountId, runId);
    if (status === 'succeeded') {
      const after = await seams.checkState(ctx, a.accountId, a.ident);
      return after.latest != null ? fold('checked', after.latest, null) : fold('failed', null, COVERAGE_CHECK_FAILED);
    }
    if (status === 'failed' || status === 'cancelled' || (runId != null && status == null)) return fold('failed', null, COVERAGE_CHECK_FAILED);
    if (Date.now() >= until) return fold('failed', null, COVERAGE_CHECK_FAILED);
    await seams.sleep(POLL_MS, a.signal);
  }
}
