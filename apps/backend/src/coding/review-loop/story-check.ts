// A BRANCH STORY CHECK (SHARED; docs/CLAUDE-REVIEW.md § The ticket review → in the review loop). The ticket
// review's own pieces, pointed at BRANCHES: every target checked out read-only at its head
// (`prepHeadWorktree` — a remote branch, or a LOCAL PINNED REF in the clone cache, never fetched), its diff
// from the clone cache (`localBranchDiff`, noise-stripped, shared budget `capMemberDiffs`), the SAME prompt
// (`buildTicketReviewPrompt`; a member's `label` reads "branch PAY-142" in place of "#n"), the SAME agent
// run (`runTicketReviewAgent`) and the SAME server reconcile (`reconcileTicketReview`). Plus the fix
// agent's notes on the criteria (`claims`): its "not applicable" notes are judged in `notApplicable`
// (loop-scoped; no shared criterion status). And the SAME code outside the ticket (review/ticket-review/
// outside.ts `readOutsideForStoryCheck`: the input's workspace's other repositories at their default
// branch and open same-branch PRs not linked to the ticket, same switch, same caps), labelled apart.
// SUBJECT-INDEPENDENT: targets, a ticket, claims and one provider in; an assessment out. The provider is
// the caller's (a loop passes `storyCheckProvider()`, as the ticket review's) — never a pair. Nothing is
// stored in ticket_reviews, no card is saved, nothing is posted. Never throws.
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
import type { AgentContext } from '../../review/agent-context.js';
import type { BranchHeadSource } from '../../review/clone-manager.js';

/** The fix agent's note on one criterion: "not applicable" (judged) or an answer (context for the check). */
export interface StoryCheckClaim {
  ref: string;
  kind: 'not_applicable' | 'answer';
  text: string;
}

export interface BranchStoryCheckTarget {
  /** The member's ref in the prompt ('PR1'…). */
  ref: string;
  /** The member id the assessment speaks of (its `prId` slot; ids are the caller's). */
  id: number;
  repoId: number;
  /** owner/name. */
  repo: string;
  owner: string;
  name: string;
  /** The branch name the prompt shows ("branch X"). */
  branch: string;
  /** Where its head commit comes from. */
  head: BranchHeadSource;
  /** The diff base (the repository base, or the PR before it). */
  baseSha: string;
  title: string | null;
}

export interface BranchStoryCheckInput {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticket: ClaudeReviewTicket;
  targets: readonly BranchStoryCheckTarget[];
  /** The previous round's assessment (members' prId = target id) and the targets whose head moved. */
  prior: { assessment: TicketAssessment; changedTargetIds: number[] } | null;
  claims: readonly StoryCheckClaim[];
  provider: AiProviderId;
  abort: AbortController;
  /** The spend ledger's feature (e.g. 'story_loop_check'). */
  feature: string;
  /**
   * The ticket's OWN PRs (stored members, open or merged): never "outside the ticket" — their repositories
   * are not read as "no PR on this ticket" and they are never "same branch, not linked". Absent ⇒ read from
   * the stored ticket members (DB only, `ticketPrsOf`).
   */
  ticketPrs?: ReadonlyArray<{ prId: number; repoId: number }>;
}

/** The ticket's own PRs (stored members, open or merged; this account's). Never throws: [] on failure. */
export async function ticketPrsOf(ctx: AgentContext, accountId: number, ident: string): Promise<Array<{ prId: number; repoId: number }>> {
  try {
    const [{ jiraMemberIds }, { readLiveMembers }] = await Promise.all([
      import('../../review/ticket-review/prepare.js'),
      import('../../review/ticket-review/fingerprint.js'),
    ]);
    return (await readLiveMembers(ctx, accountId, await jiraMemberIds(accountId, ident))).map((m) => ({ prId: m.prId, repoId: m.repoId }));
  } catch {
    return [];
  }
}

export interface BranchStoryCheckResult {
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
export function claimVerdictsOf(raw: unknown, claims: readonly StoryCheckClaim[]): StoryBuildLoopClaimVerdict[] {
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

/** Run one story check (see the header). */
export async function runBranchStoryCheck(ctx: AgentContext, i: BranchStoryCheckInput): Promise<BranchStoryCheckResult> {
  const base: BranchStoryCheckResult = {
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
  const [cm, { stripNoiseFromDiff }, { isNoiseFile }, prompts, { reconcileTicketReview }, { withWorktreeOwner }, { ticketCommentsFor }, { promptTools }, { pickReviewNonce }, outsideMod] =
    await Promise.all([
      import('../../review/clone-manager.js'),
      import('../../review/post-review.js'),
      import('../../review/prepare.js'),
      import('../../review/ticket-review/prompts.js'),
      import('../../review/ticket-review/reconcile.js'),
      import('../../review/worktree-owner.js'),
      import('../../review/ticket-review/prepare.js'),
      import('../../ai/prompt-tools.js'),
      import('../../review/claude-review/prompts.js'),
      import('../../review/ticket-review/outside.js'),
    ]);
  let outside = outsideMod.noOutside();
  let outsideRead: Promise<typeof outside> | null = null;
  const checkouts: Array<{ owner: string; name: string; repoCloneDir: string; worktreePath: string }> = [];
  let scratch: string | null = null;
  try {
    // Code outside the ticket (context only; the input's workspace), read ALONGSIDE the targets' checkouts.
    // The members it plans around are the targets AND the ticket's own PRs (never "outside"); only the
    // targets' branches look for unlinked same-branch PRs. The run's abort stops its waiting. Never throws.
    outsideRead = (async () => {
      const ticketPrs = i.ticketPrs ?? (await ticketPrsOf(ctx, i.accountId, i.ident));
      return withWorktreeOwner({ kind: 'ticket_review', accountId: i.accountId, ticket: i.ident }, () =>
        outsideMod.readOutsideForStoryCheck(
          ctx,
          i.accountId,
          i.workspaceId,
          [
            ...i.targets.map((t) => ({ prId: null, repoId: t.repoId, open: true, branch: t.branch, ref: t.ref })),
            ...ticketPrs.map((p) => ({ prId: p.prId, repoId: p.repoId, open: false, ref: '' })),
          ],
          i.abort.signal,
        ),
      );
    })().catch(() => outsideMod.noOutside());
    // Each target, read-only at the round's head, and its diff.
    const read = await withWorktreeOwner({ kind: 'ticket_review', accountId: i.accountId, ticket: i.ident }, async () =>
      Promise.all(
        i.targets.map(async (t) => {
          let path: string | null = null;
          let diff: string | null = null;
          let noise: string[] = [];
          let changed: string[] = [];
          try {
            const w = await cm.prepHeadWorktree(t.owner, t.name, t.head);
            checkouts.push({ owner: t.owner, name: t.name, repoCloneDir: w.repoCloneDir, worktreePath: w.worktreePath });
            path = w.worktreePath;
          } catch {
            path = null;
          }
          try {
            const raw = await cm.localBranchDiff(t.owner, t.name, t.baseSha, t.head);
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
    // Held before any return below, so its cleanup always runs.
    outside = await outsideRead;
    if (!read.some((r) => r.path != null)) return { ...base, failureReason: 'No branch could be checked out.' };
    if (i.abort.signal.aborted) return { ...base, status: 'cancelled' };
    const capped = prompts.capMemberDiffs(read.map((r) => r.diff));
    const members = read.map((r, n) => ({
      ref: r.t.ref,
      prId: r.t.id,
      repo: r.t.repo,
      number: 0,
      label: `branch ${r.t.branch}`,
      title: r.t.title,
      state: 'open' as const,
      headSha: r.t.head.sha,
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
    const prompt = prompts.buildTicketReviewPrompt({ ticket: i.ticket, members, prior, legacy: [], nonce, defaultBranches: [], comments, claims: i.claims, outside: outside.block }, words);
    scratch = mkdtempSync(join(tmpdir(), 'pierre-story-loop-'));
    writeFileSync(join(scratch, 'MEMBERS.md'), prompts.membersIndex(members, outside.block), 'utf8');
    const [{ runTicketReviewAgent }, { REVIEW_APPLY_AUTH_ENV }] = await Promise.all([
      import('../../review/ticket-review/agent.js'),
      import('../../review/claude-review/manager.js'),
    ]);
    const res = await runTicketReviewAgent({
      // The vendor's Settings → AI → Review model (ai/run-profile.ts), like every review kind.
      model: (await import('../../ai/run-profile.js')).reviewRunModel(i.provider),
      cwd: scratch,
      worktrees: [...members.map((m) => m.worktreePath).filter((p): p is string => p != null), ...outside.roots],
      systemPrompt: prompts.ticketReviewSystemPrompt(null, words),
      prompt,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: i.abort,
      provider: i.provider,
      usageRecord: { accountId: i.accountId, seam: 'agent', feature: i.feature, prId: null },
      notApplicable: i.claims.some((c) => c.kind === 'not_applicable'),
      onProgress: () => {},
    });
    const telemetry = { model: res.model ?? null, costUsd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, numTurns: res.numTurns };
    if (!res.ledgerByProvider && res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({ accountId: i.accountId, seam: 'agent', feature: i.feature, model: res.model ?? DEFAULT_CLAUDE_REVIEW_MODEL, costUsd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, prId: null, provider: i.provider })
        .catch(() => {});
    }
    if (res.aborted) return { ...base, ...telemetry, status: 'cancelled' };
    if (!res.submitted) return { ...base, ...telemetry, failureReason: res.failureReason ?? 'The story check did not finish.' };
    const { assessment } = reconcileTicketReview(
      i.ticket,
      members.map((m) => ({ ref: m.ref, prId: m.prId, repoId: i.targets.find((t) => t.id === m.prId)!.repoId, repo: m.repo, number: 0, checkedOut: m.checkedOut })),
      res.payload as Parameters<typeof reconcileTicketReview>[2],
      prompts.ticketCommentsBlock(comments, TICKET_COMMENTS_PROMPT_CHARS, { refs: true }).shownRefs,
      outside.context,
    );
    return { ...base, ...telemetry, status: 'succeeded', assessment, claimVerdicts: claimVerdictsOf((res.payload as { notApplicable?: unknown } | null)?.notApplicable, i.claims) };
  } catch (err) {
    if (i.abort.signal.aborted) return { ...base, status: 'cancelled' };
    return { ...base, failureReason: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const c of checkouts) await cm.removeWorktreeLocked(c.owner, c.name, c.repoCloneDir, c.worktreePath).catch(() => {});
    // The outside read, finished or not (a throw above may have left it running): its checkouts go too.
    const o = outsideRead != null ? await outsideRead.catch(() => outside) : outside;
    await o.cleanup().catch(() => {});
    // A deferred clone-cache eviction, as the ticket review's own pipeline does.
    setImmediate(() => {
      try {
        cm.cleanupCloneCache();
      } catch {
        /* advisory cleanup — never surface */
      }
    });
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup */
      }
    }
  }
}
