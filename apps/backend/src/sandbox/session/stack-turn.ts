// AFTER A BUILD TURN OF AN APPROVED PLAN (docs/STORY-BUILD.md § Plan first → Stacks). The story subject
// (manager.ts) calls this instead of the one-patch-per-repository extraction once the reader approved a plan:
//
//   1. the build report (.limn/build-report.json) is read and checked with THE validator (a self-report:
//      it gives each PR its summary and checks, never a gate);
//   2. per repository with planned PRs, in plan order: the stack leaves the sandbox as ONE bundle
//      (stack.ts) and is VERIFIED on the host in Limn's clone cache for that repository only
//      (coding/story-build/stack-verify.ts); each PR row gets the host's patch, tip, tree and status;
//      the repository row gets the WHOLE change (base..last good tip), so the per-repository diff, Resume
//      and the sprint marks keep working; a pushed PR is never rewritten;
//   3. a repository with changes but no planned PR is LEFT OUT, named in one notice (as AI Fix does);
//   4. the planned PRs go out on the stream (`prs`).
//
// Up to TWO automatic continuation turns follow a turn that hit the turn cap with work unfinished; each is
// an AUTOMATIC model run and asks the ONE budget gate first (refused ⇒ no turn, one notice).
import type { StoryBuildPr } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { listPlanRows, listPlannedPrRows, toPlanRevision, toStoryBuildPr, updateStoryBuildPr, type StoryBuildPrRow } from '../../coding/story-build/plan-persist.js';
import { listStoryBuildRepoRows, storyBuildRepoNames, updateStoryBuildRepo } from '../../coding/story-build/persist.js';
import type { StackPlannedPr, StackVerdict, VerifyStackInput } from '../../coding/story-build/stack-verify.js';
import type { SandboxRuntime } from '../runtime/types.js';
import { readBuildReport, type BuildContextFile, type BuildReportPayload } from '../workspace/build-report.js';
import { extractRepoPatch } from './patches.js';
import { extractStack, restoreStackPr, type StackExtract } from './stack.js';
import type { SessionStateJson } from './state.js';

export const CONTINUE_LINE = 'Go on with the build from where you stopped. Follow PLAN.md, and finish with the build report.';
export const CONTINUATIONS_MAX = 2;

export interface StackLive {
  readonly accountId: number;
  readonly container: string | null;
  readonly layoutRoot: string | null;
  readonly lastAgentText: string;
  readonly state: SessionStateJson;
  readonly runtime: SandboxRuntime;
}

export interface StackMachine {
  notice(text: string): void;
  emitPrs(prs: StoryBuildPr[]): void;
  scheduleSave(): void;
}

export interface StackSeams {
  verify(accountId: number, fullName: string, input: Omit<VerifyStackInput, 'gitDir' | 'token'>): Promise<StackVerdict>;
  extract(runtime: SandboxRuntime, container: string, repoPath: string, branches: readonly string[]): Promise<StackExtract>;
}

export const defaultStackSeams: StackSeams = {
  async verify(accountId, fullName, input) {
    const { verifyStackInCloneCache } = await import('../../coding/story-build/stack-verify.js');
    return verifyStackInCloneCache(accountId, fullName, input);
  },
  extract: (runtime, container, repoPath, branches) => extractStack(runtime, container, repoPath, branches),
};

let seams: StackSeams = defaultStackSeams;
/** Test seam (null restores the real ones). */
export function setStackSeamsForTests(s: Partial<StackSeams> | null): void {
  seams = s == null ? defaultStackSeams : { ...defaultStackSeams, ...s };
}

type Ctx = Pick<AgentContext, 'db' | 'schema'> & Partial<Pick<AgentContext, 'runTransaction' | 'log'>>;

/** The planned PRs of a build, grouped per repository in stack order (and the global order kept). */
export function groupByRepo(rows: readonly StoryBuildPrRow[]): Map<number, StoryBuildPrRow[]> {
  const out = new Map<number, StoryBuildPrRow[]>();
  for (const r of [...rows].sort((a, b) => a.position - b.position)) {
    const list = out.get(r.repoId) ?? [];
    list.push(r);
    out.set(r.repoId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.stackIndex - b.stackIndex);
  return out;
}

/** The build report's context: the planned PR keys and the approved plan's criteria. */
export async function buildContextOf(ctx: Ctx, accountId: number, buildId: number, approvedPlanId: number | null): Promise<BuildContextFile> {
  const prs = await listPlannedPrRows(ctx, accountId, buildId);
  const plan = approvedPlanId != null ? (await listPlanRows(ctx, accountId, buildId)).find((r) => r.id === approvedPlanId) : null;
  return { prs: prs.map((p) => p.prKey), criteria: plan ? toPlanRevision(plan).criteria.map((c) => c.ref) : [] };
}

export interface StackTurnResult {
  /** The work is not finished by the agent's own account (or there is no report): a continuation may help. */
  unfinished: boolean;
}

/** Steps 1–4 (see the header). Never throws for one repository: its PRs say why. */
export async function extractApprovedStack(
  ctx: Ctx,
  o: { buildId: number; approvedPlanId: number | null; patchMaxBytes: number; now: () => number },
  l: StackLive,
  m: StackMachine,
): Promise<StackTurnResult> {
  const accountId = l.accountId;
  const prRows = await listPlannedPrRows(ctx, accountId, o.buildId);
  const repoRows = await listStoryBuildRepoRows(ctx, accountId, o.buildId);
  const names = await storyBuildRepoNames(ctx, accountId, [...new Set([...repoRows.map((r) => r.repoId), ...prRows.map((r) => r.repoId)])]);
  const nameOf = (repoId: number): string => names.get(repoId) ?? `#${repoId}`;
  if (!l.container || !l.layoutRoot) return { unfinished: false };

  // 1. The build report (a self-report).
  const context = await buildContextOf(ctx, accountId, o.buildId, o.approvedPlanId);
  const read = await readBuildReport(l.runtime, l.container, l.layoutRoot, context);
  let report: BuildReportPayload | null = null;
  if (read.kind === 'ok' && read.check.report) report = read.check.report;
  else if (read.kind === 'ok') m.notice(`The build report did not pass Limn's checks (${read.check.problems[0] ?? 'its shape'}), so each pull request shows the agent's last words.`);
  else if (read.kind === 'unreadable') m.notice(read.reason);
  const reported = new Map((report?.prs ?? []).map((p) => [p.id, p]));
  const fallbackSummary = l.lastAgentText.trim() ? l.lastAgentText.trim().slice(0, 2_000) : null;

  // 2. Each repository's stack.
  const byRepo = groupByRepo(prRows);
  const stored: string[] = [];
  for (const [repoId, prs] of byRepo) {
    const repoRow = repoRows.find((r) => r.repoId === repoId);
    const fullName = nameOf(repoId);
    if (prs.every((p) => p.status === 'pushed')) continue;
    if (!repoRow?.sandboxPath) {
      for (const p of prs) if (p.status !== 'pushed') await updateStoryBuildPr(ctx, accountId, p.id, { status: 'failed', error: `${fullName} is not in the sandbox.` });
      m.notice(`${fullName} is not in the sandbox, so its pull requests have nothing.`);
      continue;
    }
    const planned: StackPlannedPr[] = prs.map((p) => ({ k: p.stackIndex, prRowId: p.id, key: p.prKey, branch: p.branch }));
    let verdict: StackVerdict;
    try {
      const extract = await seams.extract(l.runtime, l.container, repoRow.sandboxPath, prs.map((p) => p.branch));
      for (const d of extract.dirty) {
        m.notice(
          d.k === 0
            ? `${fullName}: changes not committed on ${d.branch} are not part of any planned pull request and are left out.`
            : `${fullName}: changes not committed on ${d.branch} are left out. Commit them on that branch.`,
        );
      }
      verdict = await seams.verify(accountId, fullName, { buildId: o.buildId, baseSha: repoRow.baseSha, planned, extract, maxPatchBytes: o.patchMaxBytes });
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : 'The commits could not be read from the sandbox.';
      verdict = { prs: planned.map((p) => ({ prRowId: p.prRowId, k: p.k, status: 'failed', tipSha: null, treeSha: null, patch: null, patchSha: null, stat: null, filesChanged: [], commitMessage: null, error: why })), whole: null };
    }
    const parts: string[] = [];
    // ⚠ A PUSHED PR IS NEVER REWRITTEN, and the PRs above it must build on what was PUSHED: when its branch
    // changed in the sandbox afterwards (another tree), every later PR's patch would be against a tree
    // GitHub does not have, and its push could only fail (TREE_MISMATCH). Refuse them here, saying why.
    let pushedMoved: string | null = null;
    for (const v of [...verdict.prs].sort((x, y) => x.k - y.k)) {
      const row = prs.find((p) => p.id === v.prRowId);
      if (!row) continue;
      if (row.status === 'pushed') {
        if (pushedMoved == null && row.treeSha != null && v.treeSha !== row.treeSha) pushedMoved = row.prKey;
        continue;
      }
      if (pushedMoved != null) {
        const error = `${pushedMoved} is pushed already, but its branch ${prs.find((p) => p.prKey === pushedMoved)?.branch ?? ''} changed in the sandbox afterwards. Put that branch back as it was pushed, then build ${row.prKey} on it.`;
        await updateStoryBuildPr(ctx, accountId, row.id, { status: 'failed', patch: null, patchSha: null, tipSha: null, treeSha: null, error, updatedAt: new Date(o.now()) });
        m.notice(`${fullName} ${row.prKey}: ${error}`);
        continue;
      }
      const said = reported.get(row.prKey);
      await updateStoryBuildPr(ctx, accountId, row.id, {
        status: v.status,
        tipSha: v.tipSha,
        treeSha: v.treeSha,
        patch: v.patch,
        patchSha: v.patchSha,
        statJson: v.stat,
        filesChangedJson: v.filesChanged,
        commitMessage: v.commitMessage,
        summary: said?.summary ?? fallbackSummary,
        checksJson: said ? { status: said.status, checks: said.checks.map((c) => ({ command: c.command, result: c.result, note: c.note ?? null })) } : null,
        error: v.error,
        updatedAt: new Date(o.now()),
      });
      if (v.status === 'ready') parts.push(`${row.prKey} (${v.stat?.files ?? 0} ${v.stat?.files === 1 ? 'file' : 'files'})`);
      else if (v.status === 'failed') m.notice(`${fullName} ${row.prKey}: ${v.error ?? 'Limn could not use it.'}`);
    }
    if (parts.length > 0) stored.push(`${fullName} ${parts.join(', ')}`);
    if (repoRow.status !== 'pushed') {
      const w = verdict.whole;
      await updateStoryBuildRepo(ctx, accountId, repoRow.id, w && w.patch !== ''
        ? { status: 'ready', patch: w.patch, patchSha: w.patchSha, statJson: w.stat, filesChangedJson: w.filesChanged, commitMessage: w.commitMessage, summary: fallbackSummary, error: null, completedAt: new Date(o.now()) }
        : { status: verdict.prs.some((p) => p.status === 'failed') ? 'failed' : 'skipped', patch: null, patchSha: null, error: null });
    }
  }

  // 3. Work outside the plan is left out (named once).
  const leftOut: NonNullable<SessionStateJson['leftOut']> = [];
  for (const r of repoRows) {
    if (byRepo.has(r.repoId) || !r.sandboxPath || r.status === 'pushed') continue;
    const got = await extractRepoPatch(l.runtime, l.container, r.sandboxPath, { maxBytes: o.patchMaxBytes }).catch(() => null);
    if (got == null || got.patch === '') continue;
    leftOut.push({ repoId: r.repoId, fullName: nameOf(r.repoId), files: got.filesChanged.slice(0, 50) });
    if (r.patch != null || r.status === 'ready') await updateStoryBuildRepo(ctx, accountId, r.id, { status: 'skipped', patch: null, patchSha: null });
    const n = got.filesChanged.length;
    m.notice(`${nameOf(r.repoId)}: ${n} changed ${n === 1 ? 'file is' : 'files are'} not part of any planned pull request and ${n === 1 ? 'is' : 'are'} left out.`);
  }
  l.state.leftOut = leftOut;

  m.notice(stored.length > 0 ? `Changes stored: ${stored.join('; ')}.` : 'The build changed no files in the planned pull requests.');
  m.scheduleSave();
  const after = await listPlannedPrRows(ctx, accountId, o.buildId);
  m.emitPrs(after.map((r) => toStoryBuildPr(r, nameOf(r.repoId))));
  const unfinished = report == null || report.prs.some((p) => p.status !== 'done') || after.some((p) => p.status === 'planned' || p.status === 'failed');
  return { unfinished };
}

/** Resume of an approved plan: each repository's stored PR patches back, one commit per PR on its branch. */
export async function restoreApprovedStack(
  ctx: Ctx,
  o: { buildId: number; ticketKey: string },
  l: StackLive,
  mirror: { repos: ReadonlyArray<{ repoId: number; path: string }> },
): Promise<number> {
  if (!l.container) return 0;
  const byRepo = groupByRepo(await listPlannedPrRows(ctx, l.accountId, o.buildId));
  let n = 0;
  let repos = 0;
  for (const [repoId, prs] of byRepo) {
    const at = mirror.repos.find((r) => r.repoId === repoId);
    if (!at || !prs.some((p) => (p.patch ?? '') !== '')) continue;
    repos += 1;
    for (const p of prs) {
      await restoreStackPr(l.runtime, l.container, at.path, {
        branch: p.branch,
        patch: p.patch ?? '',
        message: p.commitMessage?.trim() || `${o.ticketKey}: ${p.title}`,
        first: p.stackIndex === 1,
        n: (n += 1),
      });
    }
  }
  return repos;
}

