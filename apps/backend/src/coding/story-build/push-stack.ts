// PUSH A PLANNED STACK (docs/STORY-BUILD.md § Plan first → Pushing a stack). On the reader's press, or once
// by the host after the build when the reader ticked the automatic push (auto-push.ts). A
// build with an approved plan has one `story_build_prs` row per planned PR; each is pushed as ONE commit by
// the reader (`applyAndPushBranch`, the one-PR push's own steps) on a NEW branch, with ONE addition: the
// commit's tree must equal the host-verified tip's tree (`expectTree`, else TREE_MISMATCH before any push).
//
//   base, PR 1 of a repository   today's rules: the build's base, or the reader's own open ticket PR
//                                (its head branch; refused when closed or from a fork — push.ts firstPrBase)
//   base, PR k ≥ 2               the previous PR's pushed branch at its pushed commit (an EMPTY PR is
//                                skipped over: its tree is the one before it)
//   dependencies                 the previous PR in the repository pushed and still open; a PR in another
//                                repository named in `dependsOn` pushed first
//   title                        `KEY (n/m): title` for a stack, `KEY: <ticket title>` for a one-PR plan
//   body                         the summary, the story, the Part list, the criteria it covers, the
//                                reader's decisions; "Closes" on the LAST PR of a single-repository GitHub
//                                Issues build only
//
// PUSH ALL: every ready, unpushed PR in PLAN ORDER. A failure stops ITS repository (later PRs skipped,
// STACK_BELOW_FAILED) and every PR depending on it (DEPENDS_ON_NOT_PUSHED); other repositories go on.
// Earlier PRs' bodies are NOT edited afterwards (no extra GitHub write): a later body links the earlier
// ones; an earlier body names the later ones by title.
import { and, eq } from 'drizzle-orm';
import type { BuildPlanRevision, StoryBuildPrPushResult, StoryBuildRepoPushResult } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { applyAndPushBranch } from '../git-ops.js';
import { getViewerCanPush } from '../ai-fix/pr-context.js';
import { dropSessionBaseRefs } from './base-refs.js';
import { getStoryBuildRow, listStoryBuildRepoRows, storyBuildRepoNames, updateStoryBuildRepo, type StoryBuildRow } from './persist.js';
import { getStoryBuildPrRow, listPlanRows, listPlannedPrRows, publicDecisions, toPlanRevision, updateStoryBuildPr, type StoryBuildPrRow } from './plan-persist.js';
import {
  closesFor,
  defangGithubText,
  firstPrBase,
  linkTicket,
  repoFacts,
  storyBuildPrBody,
  storyBuildPrTitle,
  renameRefusal,
  storyBuildStackTitle,
} from './push.js';

/** PR rows with a push in flight in this process, and builds with a Push all in flight. */
const pushingPr = new Set<number>();
const pushingStack = new Set<number>();

/** A planned PR of this build is being pushed (Discard waits). */
export function isStoryBuildStackPushing(buildId: number, prIds: readonly number[] = []): boolean {
  return pushingStack.has(buildId) || prIds.some((id) => pushingPr.has(id));
}

const res = (
  pr: Pick<StoryBuildPrRow, 'id' | 'prKey' | 'repoId'>,
  outcome: StoryBuildPrPushResult['outcome'],
  code: string | null,
  error: string | null,
  opened: { number: number; url: string } | null = null,
): StoryBuildPrPushResult => ({ prId: pr.id, key: pr.prKey, repoId: pr.repoId, outcome, prNumber: opened?.number ?? null, prUrl: opened?.url ?? null, code, error });

/** The approved plan's revision (for Covers and Decisions), or null. */
async function approvedRevision(ctx: AgentContext, accountId: number, build: StoryBuildRow): Promise<{ rev: BuildPlanRevision; decisions: Record<string, { decision: string }> } | null> {
  if (build.approvedPlanId == null) return null;
  const row = (await listPlanRows(ctx, accountId, build.id)).find((r) => r.id === build.approvedPlanId);
  return row ? { rev: toPlanRevision(row), decisions: publicDecisions(row.decisionsJson) } : null;
}

/** The PR this one stacks on in its repository: the nearest earlier PR with changes (an empty PR is skipped). */
export function previousInRepo(rows: readonly StoryBuildPrRow[], pr: StoryBuildPrRow): StoryBuildPrRow | null {
  const earlier = rows.filter((r) => r.repoId === pr.repoId && r.stackIndex < pr.stackIndex && r.status !== 'empty').sort((a, b) => b.stackIndex - a.stackIndex);
  return earlier[0] ?? null;
}

/** A synced PR's state, scoped to (account, repo); null when it has not synced yet. */
async function prState(ctx: AgentContext, accountId: number, repoId: number, number: number): Promise<string | null> {
  const p = ctx.schema.pullRequests;
  const rows = (await ctx.db
    .select({ state: p.state })
    .from(p)
    .where(and(eq(p.accountId, accountId), eq(p.repoId, repoId), eq(p.number, number)))
    .limit(1)
    .execute()) as Array<{ state: string }>;
  return rows[0]?.state ?? null;
}

/** The decisions on the story that touch this PR (all of those touching no planned PR go everywhere). */
export function decisionsFor(
  rev: BuildPlanRevision,
  decisions: Readonly<Record<string, { decision: string }>>,
  prCriteria: readonly string[],
): Array<{ kind: 'kept' | 'changed'; text: string }> {
  const planned = new Set(rev.stack.flatMap((p) => p.criteria));
  const mine = new Set(prCriteria);
  const out: Array<{ kind: 'kept' | 'changed'; text: string }> = [];
  for (const c of rev.contentions) {
    const d = decisions[c.id]?.decision;
    if (d !== 'agree' && d !== 'keep_story') continue;
    const touches = c.about.some((a) => mine.has(a));
    const nowhere = !c.about.some((a) => planned.has(a));
    if (!touches && !nowhere) continue;
    out.push(d === 'keep_story' ? { kind: 'kept', text: c.problem } : { kind: 'changed', text: c.proposal });
  }
  return out;
}

export interface PushPlannedPrArgs {
  accountId: number;
  buildId: number;
  prId: number;
  draft: boolean;
  /** A NEW branch name for this PR (the reader's rename after `BRANCH_EXISTS`); absent ⇒ the row's.
   *  Checked by `assertPushTarget` (the build's other planned branches are protected); stored once it lands. */
  branch?: string;
}

/** Push ONE planned PR (see the header). The outcome is recorded on its row; also returned. */
export async function pushPlannedPr(ctx: AgentContext, a: PushPlannedPrArgs): Promise<StoryBuildPrPushResult> {
  const build = await getStoryBuildRow(ctx, a.accountId, a.buildId);
  const pr = build ? await getStoryBuildPrRow(ctx, a.accountId, a.buildId, a.prId) : null;
  if (!build || !pr) return { prId: a.prId, key: '', repoId: 0, outcome: 'failed', prNumber: null, prUrl: null, code: 'NotFound', error: 'Not found.' };
  // A rename is judged by git's rules before any GitHub lookup; a refusal is not recorded (push.ts).
  const refused = await renameRefusal(a.branch);
  if (refused != null) return res(pr, 'failed', 'PUSH_DENIED', refused);
  if (pr.status === 'pushed') {
    return res(pr, 'skipped', 'ALREADY_PUSHED', null, pr.pushedPrNumber != null ? { number: pr.pushedPrNumber, url: pr.pushedPrUrl ?? '' } : null);
  }
  if (build.status !== 'ready') {
    const busy = build.status === 'building';
    return res(pr, 'failed', busy ? 'BUSY' : 'NOT_READY', busy ? 'Wait for the build to finish.' : 'This build has nothing to push.');
  }
  if (pr.status !== 'ready' || !pr.patch) return res(pr, 'failed', 'NOT_READY', pr.status === 'empty' ? `${pr.prKey} has no changes.` : `${pr.prKey} has nothing to push.`);
  // The host-verified tree is what makes the push of a stacked PR checkable (expectTree): none ⇒ no push.
  if (!pr.treeSha || !/^[0-9a-f]{40}$/.test(pr.treeSha)) return res(pr, 'failed', 'NOT_READY', `Limn has no verified copy of ${pr.prKey}. Send the agent a message to build it again.`);
  if (pushingPr.has(pr.id)) return res(pr, 'skipped', 'PUSH_IN_PROGRESS', 'This pull request is being pushed.');
  pushingPr.add(pr.id);
  try {
    return await pushClaimed(ctx, a, build, pr);
  } finally {
    pushingPr.delete(pr.id);
  }
}

async function pushClaimed(ctx: AgentContext, a: PushPlannedPrArgs, build: StoryBuildRow, pr: StoryBuildPrRow): Promise<StoryBuildPrPushResult> {
  const recordError = async (code: string, message: string): Promise<StoryBuildPrPushResult> => {
    // A failed RENAME keeps the stored code: the row's own branch still exists, so the field stays.
    const keepCode = a.branch !== undefined && code !== 'BRANCH_EXISTS';
    await updateStoryBuildPr(ctx, a.accountId, pr.id, { pushError: message, ...(keepCode ? {} : { pushErrorCode: code }) }).catch(() => {});
    return res(pr, 'failed', code, message);
  };
  const rows = await listPlannedPrRows(ctx, a.accountId, build.id);
  const names = await storyBuildRepoNames(ctx, a.accountId, [...new Set(rows.map((r) => r.repoId))]);
  const nameOf = (repoId: number): string => names.get(repoId) ?? `#${repoId}`;
  const fullName = names.get(pr.repoId) ?? null;
  const [owner, name] = (fullName ?? '').split('/');
  if (!fullName || !owner || !name) return recordError('NotFound', 'This repository is not known here any more.');

  // DEPENDENCIES: the previous PR in the repository, then any other repository's PR this one depends on.
  const prev = previousInRepo(rows, pr);
  if (prev) {
    if (prev.status !== 'pushed' || prev.pushedPrNumber == null) {
      if (prev.pushedBranch && prev.pushedPrNumber == null) {
        return recordError('STACK_PREVIOUS_NOT_PUSHED', `Open the pull request for ${prev.pushedBranch} on GitHub first.`);
      }
      return recordError('STACK_PREVIOUS_NOT_PUSHED', `Push ${prev.prKey} (${prev.title}) first.`);
    }
    const state = await prState(ctx, a.accountId, prev.repoId, prev.pushedPrNumber);
    if (state != null && state !== 'open') {
      return recordError(
        'STACK_PREVIOUS_CLOSED',
        `Pull request #${prev.pushedPrNumber} (${prev.prKey}) is ${state === 'merged' ? 'merged' : 'closed'}, so this one cannot build on it. Discard this build and start again to build on what is there now.`,
      );
    }
  }
  for (const key of pr.dependsOnJson ?? []) {
    const dep = rows.find((r) => r.prKey === key);
    if (!dep || dep.repoId === pr.repoId) continue;
    if (dep.status !== 'pushed' || dep.pushedPrNumber == null) {
      return recordError('DEPENDS_ON_NOT_PUSHED', `Push ${nameOf(dep.repoId)}'s ${dep.prKey} (${dep.title}) first.`);
    }
  }

  if (!(await getViewerCanPush(ctx, a.accountId, pr.repoId))) return recordError('NO_PUSH_PERMISSION', 'You cannot push to this repository.');
  const repoRows = await listStoryBuildRepoRows(ctx, a.accountId, build.id);
  const repo = repoRows.find((r) => r.repoId === pr.repoId);
  if (!repo) return recordError('NotFound', 'This repository is not part of the build.');

  // THE BASE: PR 1 keeps today's rules; PR k ≥ 2 targets the previous PR's pushed branch.
  let baseRef: string;
  let baseSha: string;
  let prBase: string;
  let stackedNumber: number | null = null;
  if (prev) {
    baseRef = prev.pushedBranch ?? prev.branch;
    baseSha = prev.pushedCommitSha ?? '';
    prBase = baseRef;
    if (!/^[0-9a-f]{40}$/.test(baseSha)) return recordError('STACK_PREVIOUS_NOT_PUSHED', `Limn does not know the commit ${prev.prKey} was pushed as. Push it again from Limn.`);
  } else {
    const first = await firstPrBase(ctx, a.accountId, repo, owner, name);
    if (!first.ok) return recordError(first.code, first.message);
    baseRef = repo.baseRef;
    baseSha = repo.baseSha;
    prBase = first.prBase;
    stackedNumber = first.stackedNumber;
  }
  const facts = await repoFacts(ctx, a.accountId, pr.repoId);
  const ownBranches = rows.filter((r) => r.repoId === pr.repoId && r.id !== pr.id).flatMap((r) => [r.branch, r.pushedBranch ?? '']);
  // THE BRANCH: the reader's rename for this push (after BRANCH_EXISTS), else the planned one.
  const branch = (a.branch ?? pr.branch ?? '').trim();
  if (!branch) return recordError('BRANCH_REQUIRED', 'Name the branch to push.');
  const protect = [...new Set([facts?.defaultBranch, repo.baseRef, prBase, ...ownBranches].filter((n): n is string => Boolean(n)))];

  // THE TITLE AND THE BODY.
  const approved = await approvedRevision(ctx, a.accountId, build);
  // An EMPTY planned PR opens nothing: the numbering and the Part list count the PRs that do.
  const parts = rows.filter((r) => r.status !== 'empty');
  const total = parts.length;
  const position = parts.findIndex((r) => r.id === pr.id) + 1;
  const ticketTitle = build.ticketTitle ?? build.seedJson?.story.title ?? null;
  const title = total > 1 ? storyBuildStackTitle(build.ticketKey, position, total, pr.title) : storyBuildPrTitle(build.ticketKey, ticketTitle, pr.commitMessage ?? null);
  const criteriaText = new Map((approved?.rev.criteria ?? []).map((c) => [c.ref, c.text || c.how]));
  const covers = (pr.criteriaJson ?? []).map((ref) => ({ ref, text: criteriaText.get(ref) ?? '' })).filter((c) => c.text !== '');
  const lastOfAll = parts.at(-1)?.id === pr.id;
  const body = storyBuildPrBody({
    summary: pr.summary ?? null,
    ticketKey: build.ticketKey,
    ticketTitle,
    ticketUrl: build.seedJson?.story.url ?? null,
    covers,
    siblings: [],
    stackedOnPrNumber: stackedNumber,
    closes: lastOfAll ? closesFor(build, new Set(rows.map((r) => r.repoId)).size) : null,
    stack: {
      position,
      total,
      parts: parts.map((r) => ({ fullName: nameOf(r.repoId), title: r.title, number: r.pushedPrNumber ?? null, url: r.pushedPrUrl ?? null, self: r.id === pr.id })),
      buildsOnNumber: prev?.pushedPrNumber ?? null,
    },
    decisions: approved ? decisionsFor(approved.rev, approved.decisions, pr.criteriaJson ?? []) : [],
  });
  const commitMessage = defangGithubText((pr.commitMessage ?? '').trim() || title, { mentions: false });

  try {
    const pushed = await applyAndPushBranch({
      accountId: a.accountId,
      owner,
      name,
      baseSha,
      baseRef,
      patch: pr.patch!,
      commitMessage,
      branch,
      prBase,
      title,
      body,
      draft: a.draft,
      protect,
      ...(pr.treeSha ? { expectTree: pr.treeSha } : {}),
      afterSync: (prNumber) => linkTicket(ctx, a.accountId, pr.repoId, prNumber, build.ident),
    });
    // ── The PR exists: record it. Nothing below may fail the push. ──
    await updateStoryBuildPr(ctx, a.accountId, pr.id, {
      status: 'pushed',
      branch,
      pushedBranch: pushed.pushedBranch,
      pushedPrNumber: pushed.prNumber,
      pushedPrUrl: pushed.prUrl,
      pushedCommitSha: pushed.commitSha,
      pushedAt: new Date(),
      prTitle: title,
      prBody: body,
      pushError: null,
      pushErrorCode: null,
    }).catch((err: unknown) => ctx.log.warn({ err }, 'story build: recording a stacked push failed'));
    await afterPushed(ctx, a.accountId, build, pr, pushed, fullName).catch((err: unknown) => ctx.log.warn({ err }, 'story build: after a stacked push'));
    return res(pr, 'pushed', null, null, { number: pushed.prNumber, url: pushed.prUrl });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'failed';
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'BRANCH_EXISTS') return recordError(code, `A branch named ${branch} already exists on ${fullName}. Pick another branch name.`);
    if (code === 'PR_NOT_OPENED') {
      await updateStoryBuildPr(ctx, a.accountId, pr.id, { branch, pushedBranch: branch, pushedCommitSha: (err as { commitSha?: string }).commitSha ?? null, pushError: message, pushErrorCode: code }).catch(() => {});
      return res(pr, 'failed', code, message);
    }
    if (code === 'PUSH_DENIED' || code === 'APPLY_FAILED' || code === 'TREE_MISMATCH') return recordError(code, message);
    ctx.log.warn({ err }, 'story build stacked push failed');
    return recordError('failed', message);
  }
}

/** A repository whose every planned PR with changes is pushed: its repository row is `pushed` too (the
 *  marks and the session's `pushed` phase read it); every PR pushed: the session's refs go. */
async function afterPushed(
  ctx: AgentContext,
  accountId: number,
  build: StoryBuildRow,
  pr: StoryBuildPrRow,
  pushed: { prNumber: number; prUrl: string; pushedBranch: string; commitSha: string },
  fullName: string,
): Promise<void> {
  const rows = await listPlannedPrRows(ctx, accountId, build.id);
  const withChanges = (repoId?: number) => rows.filter((r) => r.status !== 'empty' && (repoId == null || r.repoId === repoId));
  const repoRows = await listStoryBuildRepoRows(ctx, accountId, build.id);
  const repo = repoRows.find((r) => r.repoId === pr.repoId);
  if (repo && withChanges(pr.repoId).every((r) => r.status === 'pushed')) {
    await updateStoryBuildRepo(ctx, accountId, repo.id, {
      status: 'pushed',
      pushedBranch: pushed.pushedBranch,
      pushedPrNumber: pushed.prNumber,
      pushedPrUrl: pushed.prUrl,
      pushedCommitSha: pushed.commitSha,
      pushedAt: new Date(),
      pushError: null,
    });
  }
  if (withChanges().every((r) => r.status === 'pushed')) {
    const names = await storyBuildRepoNames(ctx, accountId, repoRows.map((r) => r.repoId));
    void dropSessionBaseRefs([...names.values(), fullName], build.id);
  }
}

/** Push every ready, unpushed PR of the build (or of one repository) in PLAN ORDER (see the header). */
export async function pushPlannedStack(
  ctx: AgentContext,
  a: {
    accountId: number;
    buildId: number;
    draft: boolean;
    repoId?: number;
    push?: (ctx: AgentContext, a: PushPlannedPrArgs) => Promise<StoryBuildPrPushResult>;
  },
): Promise<StoryBuildPrPushResult[] | null> {
  const build = await getStoryBuildRow(ctx, a.accountId, a.buildId);
  if (!build) return null;
  if (pushingStack.has(build.id)) return [];
  pushingStack.add(build.id);
  const push = a.push ?? pushPlannedPr;
  try {
    const rows = (await listPlannedPrRows(ctx, a.accountId, a.buildId)).filter((r) => a.repoId == null || r.repoId === a.repoId);
    const out: StoryBuildPrPushResult[] = [];
    const stoppedRepos = new Set<number>();
    const notPushed = new Set<string>();
    for (const r of rows) {
      if (r.status === 'pushed') {
        out.push(res(r, 'skipped', 'ALREADY_PUSHED', null, r.pushedPrNumber != null ? { number: r.pushedPrNumber, url: r.pushedPrUrl ?? '' } : null));
        continue;
      }
      if (r.status === 'empty') continue;
      if (stoppedRepos.has(r.repoId)) {
        notPushed.add(r.prKey);
        out.push(res(r, 'skipped', 'STACK_BELOW_FAILED', 'A pull request before this one in its repository was not pushed.'));
        continue;
      }
      const blocked = (r.dependsOnJson ?? []).find((k) => notPushed.has(k));
      if (blocked) {
        notPushed.add(r.prKey);
        stoppedRepos.add(r.repoId);
        out.push(res(r, 'skipped', 'DEPENDS_ON_NOT_PUSHED', `${blocked}, which this pull request depends on, was not pushed.`));
        continue;
      }
      if (r.status !== 'ready') {
        notPushed.add(r.prKey);
        stoppedRepos.add(r.repoId);
        out.push(res(r, 'failed', 'NOT_READY', r.error ?? `${r.prKey} has nothing to push.`));
        continue;
      }
      const got = await push(ctx, { accountId: a.accountId, buildId: a.buildId, prId: r.id, draft: a.draft });
      out.push(got);
      if (got.outcome !== 'pushed') {
        notPushed.add(r.prKey);
        stoppedRepos.add(r.repoId);
      }
    }
    return out;
  } finally {
    pushingStack.delete(build.id);
  }
}

/** The per-repository summary of a stacked press (the response's `results`, for older readers). */
export function repoResultsOf(prs: readonly StoryBuildPrPushResult[]): StoryBuildRepoPushResult[] {
  const byRepo = new Map<number, StoryBuildPrPushResult[]>();
  for (const p of prs) byRepo.set(p.repoId, [...(byRepo.get(p.repoId) ?? []), p]);
  return [...byRepo.entries()].map(([repoId, list]) => {
    const bad = list.find((p) => p.outcome === 'failed') ?? null;
    const last = [...list].reverse().find((p) => p.outcome === 'pushed') ?? list[list.length - 1]!;
    const pick = bad ?? last;
    return { repoId, outcome: pick.outcome, prNumber: pick.prNumber, prUrl: pick.prUrl, code: pick.code, error: pick.error };
  });
}

/** A build pushes as a stack once its plan is approved (it has planned PR rows). */
export async function isPlannedBuild(ctx: AgentContext, accountId: number, buildId: number): Promise<boolean> {
  return (await listPlannedPrRows(ctx, accountId, buildId)).length > 0;
}
