import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AI_MODEL_FOR_ROLE,
  STORY_BUILD_LEDGER_FEATURES,
  STORY_BUILD_MIN_BUDGET_LEFT_USD,
  aiRunProvider,
  type AiFixChangeReport,
  type StoryBuildPlanRepo,
} from '@pierre-review/shared';
import { agenticRunEffort } from '../../ai/effort.js';
import { claudeModelChoice, getProvider, requestModelOf, type AgentProviderId } from '../../ai/provider.js';
import { followUpProvider, preflightFor } from '../../ai/run-choice.js';
import { getAccessToken } from '../../auth/account.js';
import { prepBranchWorktree, removeWorktreeLocked, scrubGitError } from '../../review/clone-manager.js';
import { withWorktreeOwner } from '../../review/worktree-owner.js';
import { protectedWriteReason } from '../../review/write-deny.js';
import type { AgentContext } from '../../review/agent-context.js';
import { buildInWorktree, type BuildInWorktreeResult } from '../agent.js';
import { normalizeChangeReport } from '../ai-fix/review-seed.js';
import { partialSpendOf } from '../partial-spend.js';
import {
  buildStoryBuildSystemPrompt,
  buildStoryBuildUserPrompt,
  buildStoryHookRepairPrompt,
  storyBuildUntrustedTexts,
  type EarlierRepoBrief,
} from './build-prompts.js';
import { storyBuildLimits } from './limits.js';
import type { BuildRepoFn, RepoBuildArgs, RepoBuildResult } from './seams.js';

// ONE REPOSITORY'S BUILD — WORK PACKAGE 2 (docs/STORY-BUILD.md § The builder). The session manager (WP1)
// calls this through seams.ts `storyBuildDeps().buildRepo`, one repository at a time, in plan order. It:
//
//   1. picks what runs: the SESSION's provider when it can still run `story_build` (else the default —
//      `followUpProvider`), the session's model (`requestModelOf`; deep when none is stored), the effort
//      from Settings → AI → Effort (`agenticRunEffort`, read once here);
//   2. makes a FRESH write worktree at the repository's base commit (`prepBranchWorktree`), ledgered
//      `story_build` with runId = the repository row's id. An earlier pass's tree is released first;
//   3. runs the shared worktree build (coding/agent.ts `buildInWorktree`): "Run tests" when the reader
//      ticked checks (tests that cannot start NEVER fail the repository: `checks.note` says why), the
//      `story_build` agent with NO SHELL, the pre-commit hook with ≤ MAX_HOOK_REPAIRS repair passes;
//      the earlier repositories' worktrees (and the reference library) are READ-ONLY roots; the write
//      deny-list (review/write-deny.ts) is on, on both providers;
//   4. validates the `submit_build` report against the refs it was shown and the captured diff
//      (`normalizeChangeReport`) and caps the patch (STORY_BUILD_PATCH_MAX_BYTES).
//
// The worktree is KEPT on success (a later repository reads it; push releases it) and released on
// failure or cancel. The patch is the durable result: a swept tree loses nothing. ⚠ THIS FUNCTION WRITES
// THE PASS'S SPEND LEDGER ROW (`story_build`) — the provider's own on Codex, `ctx.recordAiUsage` on
// Claude — so the manager must write none for it.

/**
 * The build agent's WRITE tool surface: read, edit, report. NO SHELL — the reasons are the comment above
 * FIX_TOOLS in coding/agent.ts, and they are stronger here: the brief is a stranger's ticket. Pinned by
 * no-shell.test.ts (with the prompt's words).
 */
export const STORY_BUILD_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'mcp__build__submit_build'];
/** With "Run tests": the one checks tool, which takes a check NAME (coding/checks/), never a command. */
export const STORY_BUILD_TOOLS_WITH_CHECKS = [...STORY_BUILD_TOOLS, 'mcp__checks__run_check'];
/** Denied OUTRIGHT, never by command pattern. */
export const STORY_BUILD_DISALLOWED_TOOLS = ['Bash', 'NotebookEdit'];

/** The namespaced ref a build's base is fetched into (never FETCH_HEAD; the clone is shared). */
export const STORY_BUILD_BASE_REF = 'refs/pierre/story-build-base';

const EMPTY: Omit<RepoBuildResult, 'ok' | 'error'> = {
  worktreePath: null,
  patch: null,
  filesChanged: [],
  summary: null,
  commitMessage: null,
  changeReport: null,
  checks: null,
  provider: null,
  model: null,
  effort: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  numTurns: null,
};

/** Release a kept build worktree (Retry, push, discard). Never throws; a path that is not a clone's per-run tree is ignored. */
export async function releaseStoryBuildWorktree(fullName: string, worktreePath: string | null | undefined): Promise<void> {
  if (!worktreePath) return;
  const [owner, name] = fullName.split('/');
  // `<clone>/.worktrees/<entry>` — the only shape addWorktree makes.
  if (!owner || !name || !/[\\/]\.worktrees[\\/][^\\/]+$/.test(worktreePath)) return;
  await removeWorktreeLocked(owner, name, dirname(dirname(worktreePath)), worktreePath).catch(() => {});
}

/** The refs THIS repository's build is asked about: its steps' refs and the criteria planned for it. */
export function refsForRepo(plan: { criteria: Array<{ ref: string; how: string; repo: string | null }> }, repo: StoryBuildPlanRepo): string[] {
  const out: string[] = [];
  const add = (r: string): void => {
    if (r && !out.includes(r)) out.push(r);
  };
  for (const s of repo.steps) for (const r of s.refs) add(r);
  for (const c of plan.criteria) if (c.how === 'planned' && c.repo === repo.ref) add(c.ref);
  return out;
}

/** A plan / criterion ref as the plan pass writes it (`AC2`, `M1`, `R1`). */
export const STORY_BUILD_REF_SHAPE = /^[A-Za-z]{1,8}\d{1,4}$/;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** What the session's model and provider are for this pass. */
export function storyBuildRunChoice(ctx: Pick<AgentContext, 'llm'>, build: { provider: string | null; model: string | null }): { provider: AgentProviderId; model: string } {
  const stored = build.model ?? null;
  const provider = followUpProvider(aiRunProvider(build.provider, stored), 'story_build', preflightFor(ctx));
  // Owner decision 7: deep by default. A stored Codex id maps back to the Claude id a request names.
  const model = stored ? requestModelOf(stored) : AI_MODEL_FOR_ROLE.claude.deep;
  return { provider, model };
}

export const buildRepo: BuildRepoFn = async (ctx, a) => {
  const fail = (error: string, extra: Partial<RepoBuildResult> = {}): RepoBuildResult => ({ ...EMPTY, ...extra, ok: false, error });
  const [owner, name] = a.fullName.split('/');
  if (!owner || !name) return fail('This repository is not known here any more.');

  // THE BRIEF: the plan revision the reader ACCEPTED, and this repository's part of it.
  const plan = a.build.planJson;
  if (plan == null || a.build.acceptedRevision == null || plan.revision !== a.build.acceptedRevision) {
    return fail('The plan changed after it was accepted. Accept it again to build.');
  }
  const planRepo = plan.repos.find((r) => r.repoId === a.repo.repoId) ?? plan.repos.find((r) => r.ref === a.repo.ref);
  if (planRepo == null) return fail('This repository is not in the accepted plan.');

  // The refs are quoted OUTSIDE the fences (YOUR REFS, the report labels), and they came from a model
  // pass over the story: only the plain `AC2` / `M1` / `R1` shape is sent.
  const badRef = [planRepo.ref, ...plan.repos.map((r) => r.ref), ...refsForRepo(plan, planRepo)].find((r) => !STORY_BUILD_REF_SHAPE.test(r));
  if (badRef != null) return fail('The accepted plan is not in a shape that can be built. Plan it again.');

  const limits = storyBuildLimits();
  const budgetUsd = Math.min(a.budgetLeftUsd, limits.repoBudgetUsd);
  if (!(budgetUsd >= STORY_BUILD_MIN_BUDGET_LEFT_USD)) return fail('The session budget is spent.');

  const { provider, model } = storyBuildRunChoice(ctx, a.build);
  const choice = claudeModelChoice(model);
  const effort = agenticRunEffort(provider, choice, 'worktree');
  const labelled = { provider, model: getProvider(provider).resolveModel(choice), effort };

  // THE PROMPTS (nonce-fenced; the docs blocks arrive fenced with the same nonce).
  const earlier: EarlierRepoBrief[] = a.earlier.map((e) => {
    const report = e.repo.changeReportJson as AiFixChangeReport | null | undefined;
    return {
      ref: e.repo.ref,
      fullName: e.fullName,
      worktreePath: e.worktreePath && existsSync(e.worktreePath) ? e.worktreePath : null,
      summary: e.repo.summary ?? null,
      changes: (report?.changes ?? []).map((c) => ({ path: c.path, summary: c.summary })),
    };
  });
  const order = plan.repos.findIndex((r) => r.ref === planRepo.ref);
  const later = plan.repos
    .slice(order + 1)
    .map((r) => ({ ref: r.ref, fullName: a.build.candidatesJson?.find((c) => c.ref === r.ref)?.fullName ?? r.ref }));
  const refs = refsForRepo(plan, planRepo);
  const promptInput = {
    fullName: a.fullName,
    repo: planRepo,
    baseRef: a.repo.baseRef,
    baseSha: a.repo.baseSha,
    stackedOnPrNumber: a.build.candidatesJson?.find((c) => c.repoId === a.repo.repoId)?.stackedOnPrNumber ?? null,
    seed: a.build.seedJson,
    ticketKey: a.build.ticketKey,
    ticketTitle: a.build.ticketTitle ?? null,
    coverage: a.build.coverageJson ?? null,
    plan,
    refs,
    docs: a.docs,
    earlier,
    later,
  };
  // The manager picked ONE nonce for the pass (the docs blocks carry it). A collision with any fenced
  // text would let that text close its own fence: refuse rather than send it.
  const lowered = a.nonce.toLowerCase();
  if (!a.nonce || storyBuildUntrustedTexts(promptInput).some((t) => t.toLowerCase().includes(lowered))) {
    return fail('The story could not be quoted safely for this run. Retry the build.');
  }

  let library: { dir: string } | null = null;
  try {
    library = await (await import('../../reference-docs/context.js')).reviewDocsFor(a.accountId, a.build.workspaceId);
  } catch {
    library = null;
  }
  const libraryText = library ? (await import('../../reference-docs/prompts.js')).docsNavigationPrompt(library.dir, provider) : null;

  const checks = (a.repo.checksWantedJson ?? []).filter((n): n is string => typeof n === 'string' && n !== '');
  const systemPrompt = buildStoryBuildSystemPrompt(provider, { checks: checks.length > 0 });
  const prompt = buildStoryBuildUserPrompt({ ...promptInput, library: libraryText, nonce: a.nonce, provider });
  const commitDefault = clip(`${a.build.ticketKey}: ${a.build.ticketTitle ?? 'implement the story'}`, 72);

  // THE WORKTREE: fresh at the base commit, every pass (an earlier pass's tree is released first).
  await releaseStoryBuildWorktree(a.fullName, a.repo.worktreePath);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (a.signal.aborted) controller.abort();
  else a.signal.addEventListener('abort', onAbort, { once: true });
  const cancelled = (extra: Partial<RepoBuildResult> = {}): RepoBuildResult => ({ ...EMPTY, ...labelled, ...extra, ok: false, cancelled: true, error: null });

  let worktreePath: string | null = null;
  let keep = false;
  // Spend the provider did not record itself (Claude), written once.
  const record = async (costUsd: number | null, tokens: { inputTokens: number; outputTokens: number } | null, usageRecorded: boolean): Promise<void> => {
    if (usageRecorded || costUsd == null || !(costUsd > 0)) return;
    await ctx
      .recordAiUsage({
        accountId: a.accountId,
        seam: 'agent',
        feature: STORY_BUILD_LEDGER_FEATURES.build,
        model: labelled.model,
        costUsd,
        inputTokens: tokens?.inputTokens ?? null,
        outputTokens: tokens?.outputTokens ?? null,
        repoId: a.repo.repoId,
        provider,
      })
      .catch(() => {});
  };

  try {
    a.onProgress({ phase: 'preparing', repoId: a.repo.repoId });
    let made: { repoCloneDir: string; worktreePath: string };
    try {
      const token = await getAccessToken(a.accountId);
      made = await withWorktreeOwner({ kind: 'story_build', accountId: a.accountId, ticket: a.build.ident, runId: a.repo.id }, () =>
        prepBranchWorktree(owner, name, { remoteRef: `refs/heads/${a.repo.baseRef}`, destRef: STORY_BUILD_BASE_REF, sha: a.repo.baseSha }, token),
      );
    } catch (err) {
      if (controller.signal.aborted) return cancelled();
      return fail(`Could not check out ${a.fullName} at ${a.repo.baseRef}: ${scrubGitError(err)}`, labelled);
    }
    worktreePath = made.worktreePath;
    if (controller.signal.aborted) return cancelled();

    const readOnlyRoots = [...earlier.map((e) => e.worktreePath).filter((p): p is string => p != null), ...(library ? [library.dir] : [])];
    let built: BuildInWorktreeResult;
    try {
      built = await buildInWorktree({
        accountId: a.accountId,
        kind: 'story_build',
        worktreePath,
        repoCloneDir: made.repoCloneDir,
        baseSha: a.repo.baseSha,
        model,
        systemPrompt,
        prompt,
        maxTurns: limits.buildMaxTurns,
        maxBudgetUsd: budgetUsd,
        abortController: controller,
        onProgress: (p) =>
          a.onProgress({
            phase: p.phase === 'working' ? 'building' : p.phase,
            repoId: a.repo.repoId,
            ...(p.message ? { message: p.message } : {}),
            ...(p.recentActivity ? { recentActivity: p.recentActivity } : {}),
            ...(p.usage ? { usage: p.usage } : {}),
          }),
        toolsFor: (checkTool) => ({
          allowedTools: checkTool ? STORY_BUILD_TOOLS_WITH_CHECKS : STORY_BUILD_TOOLS,
          disallowedTools: STORY_BUILD_DISALLOWED_TOOLS,
        }),
        resultTool: {
          server: 'build',
          name: 'submit_build',
          description: 'Report what you built in this repository. Call this EXACTLY once, at the very end, after editing files.',
          ack: 'Build recorded.',
        },
        usageRecord: { accountId: a.accountId, seam: 'agent', feature: STORY_BUILD_LEDGER_FEATURES.build, repoId: a.repo.repoId },
        checks,
        defaultCommitMessage: commitDefault,
        hookRepairPrompt: (output, nonce) => buildStoryHookRepairPrompt({ output, nonce, provider }),
        provider,
        effort,
        readOnlyRoots,
        protectWrites: true,
      });
    } catch (err) {
      const spent = partialSpendOf(err);
      await record(spent?.costUsd ?? null, spent?.usage ?? null, spent?.usageRecorded === true);
      if (controller.signal.aborted) return cancelled({ costUsd: spent?.costUsd ?? null });
      return fail(`The build stopped: ${scrubGitError(err)}`, { ...labelled, costUsd: spent?.costUsd ?? null });
    }

    await record(built.costUsd, built.usage, built.usageRecorded);
    if (built.aborted) return cancelled({ costUsd: built.costUsd });
    const spend = {
      costUsd: built.costUsd,
      inputTokens: built.usage.inputTokens,
      outputTokens: built.usage.outputTokens,
      numTurns: built.numTurns,
    };
    const summary = built.captured?.summary?.trim() || null;

    if (built.patch.length === 0 || built.filesChanged.length === 0) {
      return fail(summary ? `Nothing was changed in ${a.fullName}. ${clip(summary, 600)}` : `Nothing was changed in ${a.fullName}.`, {
        ...labelled,
        ...spend,
        checks: built.checks,
      });
    }
    // THE DENY-LIST, ONCE MORE ON THE RESULT: the hooks judge each write call, but a check or the
    // pre-commit hook (the repository's own code) also runs in this tree. A change to a protected file
    // never reaches a pull request, whoever made it.
    const protectedHit = built.filesChanged.map((f) => protectedWriteReason(f)).find((w): w is string => w != null);
    if (protectedHit) {
      return fail(`The change touched a file a build may not change, so it was not kept. ${protectedHit}`, {
        ...labelled,
        ...spend,
        checks: built.checks,
      });
    }
    if (built.patch.length > limits.patchMaxBytes) {
      return fail(`The change is too large to keep (${mb(built.patch.length)}; the limit is ${mb(limits.patchMaxBytes)}).`, {
        ...labelled,
        ...spend,
        checks: built.checks,
      });
    }

    keep = true;
    return {
      ok: true,
      error: null,
      worktreePath,
      patch: built.patch,
      filesChanged: built.filesChanged,
      summary: summary ? clip(summary, 2_000) : `Changed ${built.filesChanged.length} file${built.filesChanged.length === 1 ? '' : 's'}.`,
      commitMessage: clip(built.captured?.commitMessage?.trim() || commitDefault, 2_000),
      changeReport: normalizeChangeReport(built.captured ?? undefined, refs, built.filesChanged),
      checks: built.checks,
      ...labelled,
      ...spend,
    };
  } finally {
    a.signal.removeEventListener('abort', onAbort);
    if (!keep && worktreePath) await releaseStoryBuildWorktree(a.fullName, worktreePath);
  }
};
