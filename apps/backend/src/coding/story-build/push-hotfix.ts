import {
  hotfixBranchState,
  hotfixPairLine,
  hotfixPortBodyLine,
  hotfixPushTargets,
  type StoryBuildHotfixBranch,
  type StoryBuildRepoPushResult,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { sessionBranch } from '../../sandbox/workspace/seed.js';
import { dropSessionBaseRefs } from './base-refs.js';
import {
  getStoryBuildRepoRow,
  getStoryBuildRow,
  listStoryBuildRepoRows,
  storyBuildRepoNames,
  storyBuildRepoPort,
  updateStoryBuildRepo,
  type StoryBuildRepoRow,
  type StoryBuildRow,
} from './persist.js';
import { closesFor, coveredBy, defangGithubText, linkTicket, repoFacts, storyBuildPrBody, storyBuildPrTitle } from './push.js';
import type { PushRepoArgs } from './seams.js';

// PUSH ONE REPOSITORY OF A HOTFIX BUILD (docs/STORY-BUILD.md § Hotfix builds; docs/RELEASES.md § Hotfix). The
// reader's press. Every write is the READER'S (origin 'reader': no ledger, no trailer), exactly as Push:
//
//   1. `hotfix/<latest release tag>` — read live; made at the release commit when missing (a NEW ref, never
//      moved). When it has MOVED past the release commit, PR 1 still targets it, and the open PRs already on
//      it are recorded for the tab.
//   2. PR 1  `<KEY>` → `hotfix/<tag>`: the RELEASE FIX (the row's patch, on the release commit).
//   3. PR 2  `<KEY>-main` → the default branch: the MAIN FIX (`main_patch`, on the default branch's base).
//   4. PR 1's body edited ONCE to link PR 2 (PR 2's body links PR 1 from the start).
//
// Both titled `<KEY>: <title>`, draft by default (the toggle), `BRANCH_EXISTS` refused, push permission
// re-checked. A second press pushes only what is left; once both PRs are open nothing more is written.
// PR 2 opens only when the main fix changed something: a port report of `not_needed` with an unchanged main
// checkout opens PR 1 alone. Both bodies carry the port report's one line (shared `hotfixPortBodyLine`) —
// never when the patches contradict the claim (the tab shows that flag; Push stays the reader's call).

const pushing = new Set<number>();

/** A hotfix push of this repository row is in flight. */
export function isHotfixRepoPushing(repoRowId: number): boolean {
  return pushing.has(repoRowId);
}

/** The GitHub and git steps (tests swap them). */
export interface HotfixPushDeps {
  canPush(ctx: AgentContext, accountId: number, repoId: number): Promise<boolean>;
  token(accountId: number): Promise<string>;
  /** The live tip of a branch, or null when it is not there. */
  branchSha(token: string, owner: string, name: string, branch: string): Promise<string | null>;
  createBranch(token: string, a: { owner: string; name: string; branch: string; sha: string }): Promise<{ outcome: 'created' } | { outcome: 'exists' }>;
  openPrsOnBase(token: string, owner: string, name: string, branch: string): Promise<Array<{ number: number; title: string; url: string | null }>>;
  pushAndOpen(a: {
    accountId: number;
    owner: string;
    name: string;
    baseSha: string;
    baseRef: string;
    patch: string;
    commitMessage: string;
    branch: string;
    prBase: string;
    title: string;
    body: string;
    draft: boolean;
    protect: string[];
    afterSync?: (prNumber: number) => Promise<void>;
  }): Promise<{ pushedBranch: string; commitSha: string; prNumber: number; prUrl: string }>;
  updateBody(token: string, owner: string, name: string, number: number, body: string): Promise<{ ok: boolean; message?: string }>;
  now(): Date;
}

export const defaultHotfixPushDeps: HotfixPushDeps = {
  async canPush(ctx, accountId, repoId) {
    const { getViewerCanPush } = await import('../ai-fix/pr-context.js');
    return getViewerCanPush(ctx, accountId, repoId);
  },
  async token(accountId) {
    const { getAccessToken } = await import('../../auth/account.js');
    return getAccessToken(accountId);
  },
  async branchSha(token, owner, name, branch) {
    const { fetchBranchHeadSha } = await import('../../github/mutations.js');
    return fetchBranchHeadSha(token, owner, name, branch);
  },
  async createBranch(token, a) {
    const { createHotfixBranch } = await import('../../github/mutations.js');
    return createHotfixBranch(token, a, 'reader');
  },
  async openPrsOnBase(token, owner, name, branch) {
    const { fetchOpenPrsOnBase } = await import('../../github/mutations.js');
    return fetchOpenPrsOnBase(token, owner, name, branch);
  },
  async pushAndOpen(a) {
    const { applyAndPushBranch } = await import('../git-ops.js');
    return applyAndPushBranch(a);
  },
  async updateBody(token, owner, name, number, body) {
    const { updatePullRequestBody } = await import('../../github/mutations.js');
    const r = await updatePullRequestBody(token, owner, name, number, body, 'reader');
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  },
  now: () => new Date(),
};

let deps: HotfixPushDeps = defaultHotfixPushDeps;
/** Test seam (null restores the real steps). */
export function setHotfixPushDepsForTests(d: Partial<HotfixPushDeps> | null): void {
  deps = d == null ? defaultHotfixPushDeps : { ...defaultHotfixPushDeps, ...d };
}

const result = (
  repoId: number,
  outcome: StoryBuildRepoPushResult['outcome'],
  code: string | null,
  error: string | null,
  pr: { number: number; url: string } | null = null,
): StoryBuildRepoPushResult => ({ repoId, outcome, prNumber: pr?.number ?? null, prUrl: pr?.url ?? null, code, error });

/** The body of one of the pair (pure apart from the shared builders): the usual body, then the pair line. */
export function hotfixPrBody(
  build: StoryBuildRow,
  repo: StoryBuildRepoRow,
  o: {
    self: 'release' | 'main';
    tagName: string;
    defaultBranch: string;
    other: { number: number; url: string | null } | null;
    /** The pair has a second PR (false: only one of the two fixes changed anything). */
    paired: boolean;
    includedRepos: number;
  },
): string {
  const base = storyBuildPrBody({
    summary: repo.summary ?? null,
    ticketKey: build.ticketKey,
    ticketTitle: build.ticketTitle ?? build.seedJson?.story.title ?? null,
    ticketUrl: build.seedJson?.story.url ?? null,
    covers: coveredBy(build, repo),
    siblings: [],
    stackedOnPrNumber: null,
    // A hotfix is closed by the default-branch PR only (the release PR merges into a side branch).
    closes: o.self === 'main' ? closesFor(build, o.includedRepos) : null,
  });
  const where = o.self === 'release' ? `**Release:** this fixes ${o.tagName}.` : `**Release:** this ports the fix for ${o.tagName} to ${o.defaultBranch}.`;
  // THE PORT REPORT's one line (the agent's claim; null when there is none or the patches contradict it).
  // Untrusted model text: defanged like every other text sent to GitHub.
  const port = storyBuildRepoPort(repo);
  const portLine = hotfixPortBodyLine(port);
  const adapted = port.flag == null && port.claim?.outcome === 'adapted';
  return [
    base,
    '',
    where,
    ...(portLine != null ? [defangGithubText(portLine)] : []),
    ...(o.paired ? [hotfixPairLine(o.self, { tagName: o.tagName, defaultBranch: o.defaultBranch, other: o.other, adapted })] : []),
  ].join('\n');
}

export async function pushHotfixRepo(ctx: AgentContext, a: PushRepoArgs): Promise<StoryBuildRepoPushResult> {
  if (a.branch !== undefined) return result(a.repoId, 'failed', 'PUSH_DENIED', 'A hotfix build pushes the ticket-key branches. Discard it and start again to use another name.');
  const build = await getStoryBuildRow(ctx, a.accountId, a.buildId);
  if (!build) return result(a.repoId, 'failed', 'NotFound', 'Build not found.');
  const repo = await getStoryBuildRepoRow(ctx, a.accountId, a.buildId, a.repoId);
  if (!repo) return result(a.repoId, 'failed', 'NotFound', 'This repository is not part of the build.');
  if (repo.status === 'pushed') {
    const pr = repo.pushedPrNumber != null ? { number: repo.pushedPrNumber, url: repo.pushedPrUrl ?? '' } : null;
    return result(a.repoId, 'skipped', 'ALREADY_PUSHED', null, pr);
  }
  if (repo.readOnly) return result(a.repoId, 'skipped', 'READ_ONLY', 'This repository has no release here, so it is read only in this hotfix build.');
  if (!repo.include) return result(a.repoId, 'skipped', 'NOT_INCLUDED', null);
  if (build.status !== 'ready') {
    const why = build.status === 'building' ? 'Wait for the build to finish.' : 'This build has nothing to push.';
    return result(a.repoId, 'failed', build.status === 'building' ? 'BUSY' : 'NOT_READY', why);
  }
  if (repo.status !== 'ready' || repo.hotfixTag == null) return result(a.repoId, 'failed', 'NOT_READY', 'This repository has nothing to push.');
  if (pushing.has(repo.id)) return result(a.repoId, 'skipped', 'PUSH_IN_PROGRESS', 'This repository is being pushed.');
  pushing.add(repo.id);
  try {
    return await pushClaimed(ctx, a, build, repo);
  } finally {
    pushing.delete(repo.id);
  }
}

async function pushClaimed(ctx: AgentContext, a: PushRepoArgs, build: StoryBuildRow, repo: StoryBuildRepoRow): Promise<StoryBuildRepoPushResult> {
  const tagName = repo.hotfixTag!;
  const releaseSha = repo.baseSha;
  const fail = async (code: string, message: string, main = false): Promise<StoryBuildRepoPushResult> => {
    await updateStoryBuildRepo(ctx, a.accountId, repo.id, main ? { mainPushError: message, mainPushErrorCode: code } : { pushError: message, pushErrorCode: code }).catch(() => {});
    return result(a.repoId, 'failed', code, message);
  };
  if (!(await deps.canPush(ctx, a.accountId, repo.repoId))) return fail('NO_PUSH_PERMISSION', 'You cannot push to this repository.');

  const names = await storyBuildRepoNames(ctx, a.accountId, [repo.repoId]);
  const fullName = names.get(repo.repoId) ?? null;
  const [owner, name] = (fullName ?? '').split('/');
  if (!fullName || !owner || !name) return fail('NotFound', 'This repository is not known here any more.');
  const facts = await repoFacts(ctx, a.accountId, repo.repoId);
  const defaultBranch = facts?.defaultBranch ?? (repo.mainBaseRef && repo.mainBaseRef !== 'HEAD' ? repo.mainBaseRef : null);
  if (!defaultBranch) return fail('NOT_READY', 'The default branch of this repository is not known yet. Try again after the next sync.');
  const branch = (repo.branch ?? '').trim() || sessionBranch(build.ticketKey);
  const targets = hotfixPushTargets({ branch, tagName, defaultBranch });
  const protect = [...new Set([defaultBranch, targets.release.base, tagName])];
  const title = storyBuildPrTitle(build.ticketKey, build.ticketTitle ?? build.seedJson?.story.title ?? null, repo.commitMessage ?? repo.mainCommitMessage ?? null);
  const included = (await listStoryBuildRepoRows(ctx, a.accountId, build.id)).filter((r) => r.include && !r.readOnly).length;
  const token = await deps.token(a.accountId);
  const afterSync = (prNumber: number): Promise<void> => linkTicket(ctx, a.accountId, repo.repoId, prNumber, build.ident);

  let releasePr = repo.pushedPrNumber != null ? { number: repo.pushedPrNumber, url: repo.pushedPrUrl ?? null } : null;
  let mainPr = repo.mainPushedPrNumber != null ? { number: repo.mainPushedPrNumber, url: repo.mainPushedPrUrl ?? null } : null;
  // Both already open at the press: PR 1's body was linked then (or that one edit failed: never retried).
  let releaseBodyLinked = releasePr != null && mainPr != null;
  const releaseWanted = repo.patch != null && repo.patch !== '';
  const mainWanted = (repo.mainStatus === 'ready' || repo.mainStatus === 'pushed') && repo.mainPatch != null && repo.mainPatch !== '';
  const paired = releaseWanted && mainWanted;

  // ── 1 + 2: the hotfix branch, then PR 1 (the release fix). ──
  if (releaseWanted && releasePr == null) {
    let live: string | null;
    try {
      live = await deps.branchSha(token, owner, name, targets.release.base);
    } catch {
      live = null;
    }
    let created = false;
    if (hotfixBranchState(live, releaseSha) === 'missing') {
      try {
        const r = await deps.createBranch(token, { owner, name, branch: targets.release.base, sha: releaseSha });
        created = r.outcome === 'created';
        live = created ? releaseSha : await deps.branchSha(token, owner, name, targets.release.base).catch(() => null);
      } catch (err) {
        return fail('BRANCH_NOT_CREATED', `GitHub did not make ${targets.release.base} on ${fullName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (live == null) return fail('BRANCH_NOT_CREATED', `${targets.release.base} could not be read on ${fullName}. Try again.`);
    }
    const moved = hotfixBranchState(live, releaseSha) === 'moved';
    // The branch was already there (an earlier hotfix off this release): name the PRs open on it,
    // whether or not it has moved — an open, unmerged PR 1 leaves it at the release commit.
    const prs = !created ? await deps.openPrsOnBase(token, owner, name, targets.release.base).catch(() => []) : [];
    const record: StoryBuildHotfixBranch = { name: targets.release.base, releaseSha, created, movedToSha: moved ? live : null, prs, at: deps.now().toISOString() };
    await updateStoryBuildRepo(ctx, a.accountId, repo.id, { hotfixBranchJson: record });

    const body = hotfixPrBody(build, repo, { self: 'release', tagName, defaultBranch, other: mainPr, paired, includedRepos: included });
    try {
      const pushed = await deps.pushAndOpen({
        accountId: a.accountId,
        owner,
        name,
        baseSha: releaseSha,
        baseRef: targets.release.base,
        patch: repo.patch!,
        commitMessage: defangGithubText((repo.commitMessage ?? '').trim() || title, { mentions: false }),
        branch: targets.release.head,
        prBase: targets.release.base,
        title,
        body,
        draft: a.draft,
        protect: [...protect, targets.main.head],
        afterSync,
      });
      releasePr = { number: pushed.prNumber, url: pushed.prUrl };
      releaseBodyLinked = mainPr != null;
      await updateStoryBuildRepo(ctx, a.accountId, repo.id, {
        branch,
        pushedBranch: pushed.pushedBranch,
        pushedPrNumber: pushed.prNumber,
        pushedPrUrl: pushed.prUrl,
        pushedCommitSha: pushed.commitSha,
        pushedAt: deps.now(),
        prTitle: title,
        prBody: body,
        pushError: null,
        pushErrorCode: null,
      });
    } catch (err) {
      return pushFailed(ctx, a, repo, err, targets.release.head, fullName, false);
    }
  }

  // ── 3: PR 2 (the main fix). ──
  if (mainWanted && mainPr == null) {
    const body = hotfixPrBody(build, repo, { self: 'main', tagName, defaultBranch, other: releasePr, paired, includedRepos: included });
    try {
      const pushed = await deps.pushAndOpen({
        accountId: a.accountId,
        owner,
        name,
        baseSha: repo.mainBaseSha ?? '',
        baseRef: defaultBranch,
        patch: repo.mainPatch!,
        commitMessage: defangGithubText((repo.mainCommitMessage ?? repo.commitMessage ?? '').trim() || title, { mentions: false }),
        branch: targets.main.head,
        prBase: targets.main.base,
        title,
        body,
        draft: a.draft,
        protect: [...protect, targets.release.head],
        afterSync,
      });
      mainPr = { number: pushed.prNumber, url: pushed.prUrl };
      await updateStoryBuildRepo(ctx, a.accountId, repo.id, {
        mainStatus: 'pushed',
        mainPushedBranch: pushed.pushedBranch,
        mainPushedPrNumber: pushed.prNumber,
        mainPushedPrUrl: pushed.prUrl,
        mainPushedCommitSha: pushed.commitSha,
        mainPushedAt: deps.now(),
        mainPushError: null,
        mainPushErrorCode: null,
      });
    } catch (err) {
      return pushFailed(ctx, a, repo, err, targets.main.head, fullName, true);
    }
  }

  // ── 4: PR 1's body links PR 2, once. A failure is a line, never retried. ──
  if (releasePr != null && mainPr != null && !releaseBodyLinked) {
    const body = hotfixPrBody(build, repo, { self: 'release', tagName, defaultBranch, other: mainPr, paired, includedRepos: included });
    const r = await deps.updateBody(token, owner, name, releasePr.number, body).catch((err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
    if (r.ok) await updateStoryBuildRepo(ctx, a.accountId, repo.id, { prBody: body }).catch(() => {});
    else ctx.log.warn(`story build ${build.id}: linking the hotfix pair failed: ${r.message ?? ''}`);
  }

  const done = (!releaseWanted || releasePr != null) && (!mainWanted || mainPr != null);
  if (done) {
    await updateStoryBuildRepo(ctx, a.accountId, repo.id, { status: 'pushed' }).catch(() => {});
    // Nothing left to push: the session's pinned base commits (release AND main) are needed no more.
    const after = await listStoryBuildRepoRows(ctx, a.accountId, build.id).catch(() => null);
    if (after != null && after.every((r) => !r.include || r.status !== 'ready')) {
      const all = await storyBuildRepoNames(ctx, a.accountId, after.map((r) => r.repoId)).catch(() => new Map<number, string>());
      void dropSessionBaseRefs([...all.values(), fullName], build.id);
    }
  }
  const shown = releasePr ?? mainPr;
  return result(a.repoId, 'pushed', null, null, shown ? { number: shown.number, url: shown.url ?? '' } : null);
}

async function pushFailed(
  ctx: AgentContext,
  a: PushRepoArgs,
  repo: StoryBuildRepoRow,
  err: unknown,
  branch: string,
  fullName: string,
  main: boolean,
): Promise<StoryBuildRepoPushResult> {
  const code = (err as { code?: string })?.code ?? 'failed';
  const message =
    code === 'BRANCH_EXISTS'
      ? `A branch named ${branch} already exists on ${fullName}. Delete it on GitHub or discard this build.`
      : err instanceof Error
        ? err.message
        : String(err);
  if (code !== 'BRANCH_EXISTS' && code !== 'PR_NOT_OPENED' && code !== 'PUSH_DENIED' && code !== 'APPLY_FAILED') ctx.log.warn({ err }, 'story build hotfix push failed');
  await updateStoryBuildRepo(
    ctx,
    a.accountId,
    repo.id,
    main
      ? { mainPushError: message, mainPushErrorCode: code, ...(code === 'PR_NOT_OPENED' ? { mainPushedBranch: branch, mainPushedCommitSha: (err as { commitSha?: string }).commitSha ?? null } : {}) }
      : { pushError: message, pushErrorCode: code, ...(code === 'PR_NOT_OPENED' ? { pushedBranch: branch, pushedCommitSha: (err as { commitSha?: string }).commitSha ?? null } : {}) },
  ).catch(() => {});
  return result(a.repoId, 'failed', code, message);
}
