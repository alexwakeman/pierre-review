// THE REVIEW LOOP'S STORY CHECK OF ONE ROUND (docs/CLAUDE-REVIEW.md § The ticket review → in the review
// loop). The ticket review's own pieces, pointed at BRANCHES: every target checked out read-only at the
// round's head (`prepBranchWorktree`), its diff from the clone cache (`localBranchDiff`, noise-stripped,
// shared budget `capMemberDiffs`), the SAME prompt (`buildTicketReviewPrompt`; a member's `label` reads
// "branch PAY-142" in place of "#n"), the SAME agent run (`runTicketReviewAgent`) and the SAME server
// reconcile (`reconcileTicketReview`). Plus the build agent's notes on the criteria (`claims`): its "not
// applicable" notes are judged in `notApplicable` (build-scoped; no shared criterion status).
// The provider is the default one (`activeProviderId`), as the ticket review's — never a pair.
// Nothing is stored in ticket_reviews, no card is saved, nothing is posted. Never throws.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLAUDE_REVIEW_MODEL,
  TICKET_COMMENTS_PROMPT_CHARS,
  type AiProviderId,
  type ClaudeReviewTicket,
  type StoryBuildLoopClaimVerdict,
  type TicketAssessment,
} from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import type { LoopClaim, LoopStoryCheckMember } from './persist.js';

export interface LoopCheckTarget {
  member: LoopStoryCheckMember;
  owner: string;
  name: string;
  /** The diff base (the repository base, or the PR before it). */
  baseSha: string;
  title: string | null;
}

export interface LoopStoryCheckInput {
  accountId: number;
  workspaceId: number;
  buildId: number;
  ident: string;
  ticket: ClaudeReviewTicket;
  targets: readonly LoopCheckTarget[];
  /** The previous round's assessment (members' prId = target id) and the targets whose head moved. */
  prior: { assessment: TicketAssessment; changedTargetIds: number[] } | null;
  claims: readonly LoopClaim[];
  provider: AiProviderId;
  abort: AbortController;
}

export interface LoopStoryCheckResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  failureReason: string | null;
  assessment: TicketAssessment | null;
  claimVerdicts: StoryBuildLoopClaimVerdict[];
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** The checker's verdicts on the agent's "not applicable" notes, only for refs it was shown. Pure. */
export function claimVerdictsOf(raw: unknown, claims: readonly LoopClaim[]): StoryBuildLoopClaimVerdict[] {
  const asked = new Set(claims.filter((c) => c.kind === 'not_applicable').map((c) => c.ref.toUpperCase()));
  if (!Array.isArray(raw)) return [];
  const out: StoryBuildLoopClaimVerdict[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (r == null || typeof r !== 'object') continue;
    const ref = typeof (r as { ref?: unknown }).ref === 'string' ? (r as { ref: string }).ref.trim().toUpperCase() : '';
    const verdict = (r as { verdict?: unknown }).verdict;
    const why = typeof (r as { why?: unknown }).why === 'string' ? (r as { why: string }).why.trim().slice(0, 600) : '';
    if (!asked.has(ref) || seen.has(ref) || (verdict !== 'accepted' && verdict !== 'rejected')) continue;
    seen.add(ref);
    out.push({ ref, verdict, why });
  }
  return out;
}

export const LOOP_CHECK_FEATURE = 'story_loop_check';

/** Run the round's story check (see the header). */
export async function runLoopStoryCheck(ctx: AgentContext, i: LoopStoryCheckInput): Promise<LoopStoryCheckResult> {
  const base: LoopStoryCheckResult = {
    status: 'failed',
    failureReason: null,
    assessment: null,
    claimVerdicts: [],
    model: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
  };
  const [cm, { stripNoiseFromDiff }, { isNoiseFile }, prompts, { reconcileTicketReview }, { withWorktreeOwner }, { ticketCommentsFor }, { promptTools }, { pickReviewNonce }] =
    await Promise.all([
      import('../../../review/clone-manager.js'),
      import('../../../review/post-review.js'),
      import('../../../review/prepare.js'),
      import('../../../review/ticket-review/prompts.js'),
      import('../../../review/ticket-review/reconcile.js'),
      import('../../../review/worktree-owner.js'),
      import('../../../review/ticket-review/prepare.js'),
      import('../../../ai/prompt-tools.js'),
      import('../../../review/claude-review/prompts.js'),
    ]);
  const checkouts: Array<{ owner: string; name: string; repoCloneDir: string; worktreePath: string }> = [];
  let scratch: string | null = null;
  try {
    // Each target, read-only at the round's head, and its diff.
    const read = await withWorktreeOwner({ kind: 'ticket_review', accountId: i.accountId, ticket: i.ident }, async () =>
      Promise.all(
        i.targets.map(async (t) => {
          let path: string | null = null;
          let diff: string | null = null;
          let noise: string[] = [];
          let changed: string[] = [];
          try {
            const w = await cm.prepBranchWorktree(t.owner, t.name, { remoteRef: `refs/heads/${t.member.branch}`, destRef: `refs/pierre/story-loop/${i.buildId}`, sha: t.member.headSha });
            checkouts.push({ owner: t.owner, name: t.name, repoCloneDir: w.repoCloneDir, worktreePath: w.worktreePath });
            path = w.worktreePath;
          } catch {
            path = null;
          }
          try {
            const raw = await cm.localBranchDiff(t.owner, t.name, t.baseSha, t.member.headSha);
            const stripped = stripNoiseFromDiff(raw, isNoiseFile);
            diff = stripped.diff;
            noise = stripped.excluded;
            changed = [...stripped.diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!);
          } catch {
            diff = null;
          }
          return { t, path, diff, noise, changed };
        }),
      ),
    );
    if (!read.some((r) => r.path != null)) return { ...base, failureReason: 'No branch could be checked out.' };
    if (i.abort.signal.aborted) return { ...base, status: 'cancelled' };
    const capped = prompts.capMemberDiffs(read.map((r) => r.diff));
    const members = read.map((r, n) => ({
      ref: r.t.member.ref,
      prId: r.t.member.targetId,
      repo: r.t.member.repo,
      number: 0,
      label: `branch ${r.t.member.branch}`,
      title: r.t.title,
      state: 'open' as const,
      headSha: r.t.member.headSha,
      checkedOut: r.path != null,
      worktreePath: r.path,
      given: 'diff' as const,
      card: null,
      changedFiles: r.changed,
      diff: capped[n]!.diff,
      noiseFiles: r.noise,
      omittedFiles: capped[n]!.omittedFiles,
    }));
    const comments = await ticketCommentsFor(i.accountId, i.ident).catch(() => []);
    const prior = i.prior ? { assessment: i.prior.assessment, changedPrIds: i.prior.changedTargetIds, storyEdited: false } : null;
    const words = promptTools(i.provider);
    const nonce = pickReviewNonce([...prompts.ticketReviewUntrustedTexts(i.ticket, members, prior, [], comments), ...i.claims.map((c) => c.text)]);
    const prompt = prompts.buildTicketReviewPrompt({ ticket: i.ticket, members, prior, legacy: [], nonce, defaultBranches: [], comments, claims: i.claims }, words);
    scratch = mkdtempSync(join(tmpdir(), 'pierre-story-loop-'));
    writeFileSync(join(scratch, 'MEMBERS.md'), prompts.membersIndex(members), 'utf8');
    const [{ runTicketReviewAgent }, { REVIEW_APPLY_AUTH_ENV }] = await Promise.all([
      import('../../../review/ticket-review/agent.js'),
      import('../../../review/claude-review/manager.js'),
    ]);
    const res = await runTicketReviewAgent({
      model: DEFAULT_CLAUDE_REVIEW_MODEL,
      cwd: scratch,
      worktrees: members.map((m) => m.worktreePath).filter((p): p is string => p != null),
      systemPrompt: prompts.ticketReviewSystemPrompt(null, words),
      prompt,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: i.abort,
      provider: i.provider,
      usageRecord: { accountId: i.accountId, seam: 'agent', feature: LOOP_CHECK_FEATURE, prId: null },
      notApplicable: i.claims.some((c) => c.kind === 'not_applicable'),
      onProgress: () => {},
    });
    const telemetry = { model: res.model ?? null, costUsd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, numTurns: res.numTurns };
    if (!res.ledgerByProvider && res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({ accountId: i.accountId, seam: 'agent', feature: LOOP_CHECK_FEATURE, model: res.model ?? DEFAULT_CLAUDE_REVIEW_MODEL, costUsd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, prId: null, provider: i.provider })
        .catch(() => {});
    }
    if (res.aborted) return { ...base, ...telemetry, status: 'cancelled' };
    if (!res.submitted) return { ...base, ...telemetry, failureReason: res.failureReason ?? 'The story check did not finish.' };
    const { assessment } = reconcileTicketReview(
      i.ticket,
      members.map((m) => ({ ref: m.ref, prId: m.prId, repoId: i.targets.find((t) => t.member.targetId === m.prId)!.member.repoId, repo: m.repo, number: 0, checkedOut: m.checkedOut })),
      res.payload as Parameters<typeof reconcileTicketReview>[2],
      prompts.ticketCommentsBlock(comments, TICKET_COMMENTS_PROMPT_CHARS, { refs: true }).shownRefs,
    );
    return { ...base, ...telemetry, status: 'succeeded', assessment, claimVerdicts: claimVerdictsOf((res.payload as { notApplicable?: unknown } | null)?.notApplicable, i.claims) };
  } catch (err) {
    if (i.abort.signal.aborted) return { ...base, status: 'cancelled' };
    return { ...base, failureReason: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const c of checkouts) await cm.removeWorktreeLocked(c.owner, c.name, c.repoCloneDir, c.worktreePath).catch(() => {});
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup */
      }
    }
  }
}
