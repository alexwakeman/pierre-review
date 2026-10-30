import { and, eq } from 'drizzle-orm';
import {
  PRODUCT_NAME,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketRow,
  type StoryBuildRepoPushResult,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { applyAndPushBranch } from '../git-ops.js';
import { getViewerCanPush } from '../ai-fix/pr-context.js';
import { dropSessionBaseRefs } from './base-refs.js';
import { releaseStoryBuildWorktree } from './build.js';
import {
  getStoryBuildRepoRow,
  getStoryBuildRow,
  listStoryBuildRepoRows,
  storyBuildRepoNames,
  updateStoryBuildRepo,
  type StoryBuildRepoRow,
  type StoryBuildRow,
} from './persist.js';
import type { PushRepoArgs, PushRepoFn } from './seams.js';

// PUSH ONE REPOSITORY — WORK PACKAGE 2 (docs/STORY-BUILD.md § Push). Only ever on the reader's press
// (routes-build.ts: Push, Push all). Stateless like AI Fix's push: a FRESH worktree at the stored base,
// the stored patch applied, ONE commit, a NEW branch (never forced; `BRANCH_EXISTS` refused with a
// sentence; the default branch and a stacked PR's head are protected), then a NEW pull request —
// a DRAFT unless the reader asked otherwise (owner decision 2):
//
//   title   `${KEY}: ${title}` — what Jira, Linear and Notion detection read, so the PR joins the ticket
//   base    the default branch, or — stacked on the reader's own open ticket PR (owner decision 1) — that
//           PR's head branch (refused when that PR is no longer open)
//   body    the summary, the criteria this repository covers, the ticket link (http(s) only), the
//           sibling PRs this session already pushed, "Closes <issue>" on a single-repository GitHub
//           Issues build, and "Built with Limn from <KEY>"
//
// After the PR syncs, a `detected_from='manual'` tracker link row is written for the ticket
// (tracker/manual-links.ts), so every tracker links the PR — GitHub Issues included. The kept build
// worktree is released once the push lands. Each repository succeeds or fails on its own; the outcome is
// stored on its row (`pushed_*` or `push_error`).

const TITLE_MAX = 256;
const BODY_MAX = 60_000;
/** Repository rows with a push in flight in this process: a second press answers `PUSH_IN_PROGRESS`. */
const pushing = new Set<number>();

/** A push of this repository row is in flight (Retry waits for it: a pass would replace the tree it pushes). */
export function isStoryBuildRepoPushing(repoRowId: number): boolean {
  return pushing.has(repoRowId);
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

function httpUrl(url: string | null | undefined): string | null {
  return url != null && /^https?:\/\/[^\s<>()]+$/i.test(url) ? url : null;
}

/**
 * MODEL- AND TICKET-WRITTEN TEXT IS QUOTED, NEVER OBEYED, on GitHub too: in a PR body or a commit
 * message, `Fixes owner/repo#12` closes that issue on merge and `@someone` notifies them. A zero-width
 * space breaks both without changing what a person reads. The one closing line this push means to
 * write (a single-repository GitHub Issues build) is added by the code AFTER this runs.
 */
export function defangGithubText(text: string, opts: { mentions?: boolean } = {}): string {
  // Only a keyword FOLLOWED BY AN ISSUE REFERENCE is touched, so `fix: …` and "fixes the bug" stay as written.
  const closing = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?=\s*:?\s*(?:(?:[\w.-]+\/[\w.-]+)?#\d|https?:\/\/))/gi;
  const out = text.replace(closing, (k) => `${k.slice(0, 1)}\u200b${k.slice(1)}`);
  return opts.mentions === false ? out : out.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@\u200b');
}

/** The new PR's title: `KEY: title` (the detection key first). */
export function storyBuildPrTitle(ticketKey: string, title: string | null, commitMessage: string | null): string {
  const t = (title ?? '').trim() || (commitMessage ?? '').split('\n')[0]!.trim() || 'Implement the story';
  return clip(`${ticketKey}: ${t.replace(/\s+/g, ' ')}`, TITLE_MAX);
}

export interface PrBodyInput {
  summary: string | null;
  ticketKey: string;
  ticketTitle: string | null;
  ticketUrl: string | null;
  /** `AC2: text` lines this repository covers. */
  covers: Array<{ ref: string; text: string }>;
  /** PRs already pushed in this session (owner/name#n + URL). */
  siblings: Array<{ fullName: string; number: number; url: string | null }>;
  stackedOnPrNumber: number | null;
  /** "Closes owner/repo#n" — a single-repository GitHub Issues build only. */
  closes: string | null;
}

/** The new PR's body. People who never saw Limn read it on GitHub: plain, short, the product named once. */
export function storyBuildPrBody(b: PrBodyInput): string {
  const lines: string[] = [];
  if (b.summary) lines.push(defangGithubText(b.summary.trim()), '');
  const url = httpUrl(b.ticketUrl);
  const story = defangGithubText(`${b.ticketKey}${b.ticketTitle ? `: ${b.ticketTitle.trim()}` : ''}`).replace(/[[\]]/g, '');
  lines.push(`**Story:** ${url ? `[${story}](${url})` : story}`);
  if (b.covers.length > 0) {
    lines.push('', '**Covers:**');
    for (const c of b.covers) lines.push(`- ${c.ref}: ${defangGithubText(c.text.replace(/\s+/g, ' ').trim())}`);
  }
  if (b.stackedOnPrNumber != null) lines.push('', `Stacked on #${b.stackedOnPrNumber}.`);
  if (b.siblings.length > 0) {
    lines.push('', '**Other pull requests for this story:**');
    for (const s of b.siblings) {
      const ref = `${s.fullName}#${s.number}`;
      const link = httpUrl(s.url);
      lines.push(`- ${link ? `[${ref}](${link})` : ref}`);
    }
  }
  if (b.closes) lines.push('', `Closes ${b.closes}`);
  lines.push('', '---', `Built with ${PRODUCT_NAME} from ${b.ticketKey}.`);
  return clip(lines.join('\n'), BODY_MAX);
}

const result = (
  repoId: number,
  outcome: StoryBuildRepoPushResult['outcome'],
  code: string | null,
  error: string | null,
  pr: { number: number; url: string } | null = null,
): StoryBuildRepoPushResult => ({ repoId, outcome, prNumber: pr?.number ?? null, prUrl: pr?.url ?? null, code, error });

interface RepoFacts {
  defaultBranch: string | null;
}

async function repoFacts(ctx: AgentContext, accountId: number, repoId: number): Promise<RepoFacts | null> {
  const r = ctx.schema.repos;
  const rows = (await ctx.db
    .select({ defaultBranch: r.defaultBranch })
    .from(r)
    .where(and(eq(r.id, repoId), eq(r.accountId, accountId)))
    .limit(1)
    .execute()) as RepoFacts[];
  return rows[0] ?? null;
}

/** The PR this repository stacks on, scoped to (account, repo); null when it is not there. */
async function stackedPr(
  ctx: AgentContext,
  accountId: number,
  repoId: number,
  prId: number,
): Promise<{ number: number; state: string; headRefName: string | null } | null> {
  const p = ctx.schema.pullRequests;
  const rows = (await ctx.db
    .select({ number: p.number, state: p.state, headRefName: p.headRefName })
    .from(p)
    .where(and(eq(p.id, prId), eq(p.accountId, accountId), eq(p.repoId, repoId)))
    .limit(1)
    .execute()) as Array<{ number: number; state: string; headRefName: string | null }>;
  return rows[0] ?? null;
}

/** The criteria this repository covers, as `ref: text` (the plan's planned rows for it + its steps' refs). */
function coveredBy(build: StoryBuildRow, repo: StoryBuildRepoRow): Array<{ ref: string; text: string }> {
  const plan = build.planJson;
  const planRepo = plan?.repos.find((r) => r.repoId === repo.repoId) ?? plan?.repos.find((r) => r.ref === repo.ref);
  if (!plan || !planRepo) return [];
  const delivered = new Set((repo.changeReportJson?.changes ?? []).flatMap((c) => c.refs));
  const planned = new Set([
    ...plan.criteria.filter((c) => c.how === 'planned' && c.repo === planRepo.ref).map((c) => c.ref),
    ...planRepo.steps.flatMap((s) => s.refs),
  ]);
  // What the build REPORTS it delivered, when it reported; else what the plan put here.
  const refs = delivered.size > 0 ? [...planned].filter((r) => delivered.has(r)) : [...planned];
  const text = new Map<string, string>([
    ...(build.coverageJson?.criteria ?? []).map((c) => [c.ref, c.text] as const),
    ...(build.coverageJson?.missing ?? []).map((m) => [m.ref, m.text] as const),
  ]);
  return refs.filter((r) => text.has(r)).map((r) => ({ ref: r, text: clip(text.get(r)!, 300) }));
}

/** The issue a single-repository GitHub Issues build closes, or null. */
function closesFor(build: StoryBuildRow, includedRepos: number): string | null {
  if (includedRepos !== 1) return null;
  const parsed = parseTicketIdent(build.ident);
  if (!isTrackerIdent(parsed) || parsed.provider !== 'github') return null;
  return trackerTicketRow(parsed).issueKey;
}

/**
 * After the new PR synced: link it to the ticket by hand (`detected_from='manual'`), so a tracker whose
 * detection does not read the title (GitHub Issues) links it too. Best-effort, never throws.
 */
async function linkTicket(ctx: AgentContext, accountId: number, repoId: number, prNumber: number, ident: string): Promise<void> {
  try {
    const parsed = parseTicketIdent(ident);
    if (!isTrackerIdent(parsed)) return;
    const p = ctx.schema.pullRequests;
    const rows = (await ctx.db
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.accountId, accountId), eq(p.repoId, repoId), eq(p.number, prNumber)))
      .limit(1)
      .execute()) as Array<{ id: number }>;
    const prId = rows[0]?.id;
    if (prId == null) return;
    // LAZY: tracker/runtime.ts opens the database at import (CLAUDE.md § the agentic features).
    const [{ resolveTicketRefs }, { trackerContext }] = await Promise.all([
      import('../../tracker/manual-links.js'),
      import('../../tracker/runtime.js'),
    ]);
    await resolveTicketRefs(trackerContext(), accountId, prId, { refs: [trackerTicketRow(parsed).issueKey], link: true });
  } catch (err) {
    ctx.log.warn({ err }, 'story build: ticket link after push failed');
  }
}

export const pushRepo: PushRepoFn = async (ctx, a: PushRepoArgs) => {
  const build = await getStoryBuildRow(ctx, a.accountId, a.buildId);
  if (!build) return result(a.repoId, 'failed', 'NotFound', 'Build not found.');
  const repo = await getStoryBuildRepoRow(ctx, a.accountId, a.buildId, a.repoId);
  if (!repo) return result(a.repoId, 'failed', 'NotFound', 'This repository is not part of the build.');
  if (repo.status === 'pushed') {
    const pr = repo.pushedPrNumber != null ? { number: repo.pushedPrNumber, url: repo.pushedPrUrl ?? '' } : null;
    return result(a.repoId, 'skipped', 'ALREADY_PUSHED', null, pr);
  }
  if (!repo.include) return result(a.repoId, 'skipped', 'NOT_INCLUDED', null);
  if (build.status !== 'ready') {
    const why = build.status === 'building' ? 'Wait for the build to finish.' : 'This build has nothing to push.';
    return result(a.repoId, 'failed', build.status === 'building' ? 'BUSY' : 'NOT_READY', why);
  }
  if (repo.status !== 'ready' || !repo.patch) return result(a.repoId, 'failed', 'NOT_READY', 'This repository has nothing to push.');
  if (pushing.has(repo.id)) return result(a.repoId, 'skipped', 'PUSH_IN_PROGRESS', 'This repository is being pushed.');
  pushing.add(repo.id);
  try {
    return await pushClaimed(ctx, a, build, repo);
  } finally {
    pushing.delete(repo.id);
  }
};

async function pushClaimed(ctx: AgentContext, a: PushRepoArgs, build: StoryBuildRow, repo: StoryBuildRepoRow): Promise<StoryBuildRepoPushResult> {
  const recordError = async (code: string, message: string): Promise<StoryBuildRepoPushResult> => {
    await updateStoryBuildRepo(ctx, a.accountId, repo.id, { pushError: message }).catch(() => {});
    return result(a.repoId, 'failed', code, message);
  };

  if (!(await getViewerCanPush(ctx, a.accountId, repo.repoId))) {
    return recordError('NO_PUSH_PERMISSION', 'You cannot push to this repository.');
  }
  const branch = (repo.branch ?? '').trim();
  if (!branch) return recordError('BRANCH_REQUIRED', 'Name the branch to push.');

  const names = await storyBuildRepoNames(ctx, a.accountId, [repo.repoId]);
  const fullName = names.get(repo.repoId) ?? build.candidatesJson?.find((c) => c.repoId === repo.repoId)?.fullName ?? null;
  const [owner, name] = (fullName ?? '').split('/');
  if (!fullName || !owner || !name) return recordError('NotFound', 'This repository is not known here any more.');
  const facts = await repoFacts(ctx, a.accountId, repo.repoId);

  // THE BASE the new PR targets: the default branch, or the reader's own open PR this build stacks on.
  let prBase = repo.baseRef;
  let stackedNumber: number | null = null;
  if (repo.stackedOnPrId != null) {
    const pr = await stackedPr(ctx, a.accountId, repo.repoId, repo.stackedOnPrId);
    if (!pr || pr.state !== 'open') {
      return recordError(
        'STACK_CLOSED',
        `${pr ? `Pull request #${pr.number}` : 'The pull request'}, which this build stacks on, is no longer open. Build this repository again to start from the default branch.`,
      );
    }
    // ⚠ NEVER A FORK'S BRANCH: a PR opened from a fork has its head branch on the fork only, so a new PR
    // here could not target it. The plan falls back to the default branch for one (candidates.ts); this
    // re-reads GitHub at the press, since the PR's head repository is not synced.
    let fork: boolean;
    try {
      fork = (await ctx.github.fetchPrHeadInfo(a.accountId, owner, name, pr.number)).isFork;
    } catch {
      return recordError('STACK_UNKNOWN', `Couldn't check pull request #${pr.number} on GitHub. Try again.`);
    }
    if (fork) {
      return recordError(
        'STACK_FORK',
        `Pull request #${pr.number}, which this build stacks on, is from a fork, so a new pull request cannot target its branch. Discard this build and start again to build from the default branch.`,
      );
    }
    stackedNumber = pr.number;
    prBase = pr.headRefName ?? repo.baseRef;
  }
  const protect = [...new Set([facts?.defaultBranch, repo.baseRef, prBase].filter((n): n is string => Boolean(n)))];

  // The body links the PRs this session already pushed (Push all runs in plan order).
  const rows = await listStoryBuildRepoRows(ctx, a.accountId, build.id);
  const siblingNames = await storyBuildRepoNames(ctx, a.accountId, rows.map((r) => r.repoId));
  const siblings = rows
    .filter((r) => r.id !== repo.id && r.status === 'pushed' && r.pushedPrNumber != null)
    .map((r) => ({ fullName: siblingNames.get(r.repoId) ?? `#${r.repoId}`, number: r.pushedPrNumber!, url: r.pushedPrUrl ?? null }));
  const title = storyBuildPrTitle(build.ticketKey, build.ticketTitle ?? build.seedJson?.story.title ?? null, repo.commitMessage ?? null);
  const body = storyBuildPrBody({
    summary: repo.summary ?? null,
    ticketKey: build.ticketKey,
    ticketTitle: build.ticketTitle ?? build.seedJson?.story.title ?? null,
    ticketUrl: build.seedJson?.story.url ?? null,
    covers: coveredBy(build, repo),
    siblings,
    stackedOnPrNumber: stackedNumber,
    closes: closesFor(build, rows.filter((r) => r.include).length),
  });
  const commitMessage = defangGithubText((repo.commitMessage ?? '').trim() || title, { mentions: false });

  try {
    const pushed = await applyAndPushBranch({
      accountId: a.accountId,
      owner,
      name,
      baseSha: repo.baseSha,
      baseRef: repo.baseRef,
      patch: repo.patch!,
      commitMessage,
      branch,
      prBase,
      title,
      body,
      draft: a.draft,
      protect,
      afterSync: (prNumber) => linkTicket(ctx, a.accountId, repo.repoId, prNumber, build.ident),
    });
    // ── The PR exists: record it, release the kept worktree. Nothing below may fail the push. ──
    await updateStoryBuildRepo(ctx, a.accountId, repo.id, {
      status: 'pushed',
      pushedBranch: pushed.pushedBranch,
      pushedPrNumber: pushed.prNumber,
      pushedPrUrl: pushed.prUrl,
      pushedCommitSha: pushed.commitSha,
      pushedAt: new Date(),
      prTitle: title,
      prBody: body,
      pushError: null,
    }).catch((err: unknown) => ctx.log.warn({ err }, 'story build: recording a push failed'));
    void releaseStoryBuildWorktree(fullName, repo.worktreePath);
    // Every included repository pushed: the session's pinned base commits are needed no more.
    const after = await listStoryBuildRepoRows(ctx, a.accountId, build.id).catch(() => null);
    if (after != null && after.filter((r) => r.include).every((r) => r.id === repo.id || r.status === 'pushed')) {
      void dropSessionBaseRefs([...(build.candidatesJson ?? []).map((c) => c.fullName), fullName], build.id);
    }
    return result(a.repoId, 'pushed', null, null, { number: pushed.prNumber, url: pushed.prUrl });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'failed';
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'BRANCH_EXISTS') {
      return recordError(code, `A branch named ${branch} already exists on ${fullName}. Pick another branch name.`);
    }
    if (code === 'PR_NOT_OPENED') {
      await updateStoryBuildRepo(ctx, a.accountId, repo.id, {
        pushedBranch: branch,
        pushedCommitSha: (err as { commitSha?: string }).commitSha ?? null,
        pushError: message,
      }).catch(() => {});
      return result(a.repoId, 'failed', code, message);
    }
    if (code === 'PUSH_DENIED' || code === 'APPLY_FAILED') return recordError(code, message);
    ctx.log.warn({ err }, 'story build push failed');
    return recordError('failed', message);
  }
}

/**
 * PUSH ALL: every included, unpushed, ready repository IN PLAN ORDER, one after another (a later body
 * links the earlier PRs). Each succeeds or fails on its own; the results come back in plan order.
 */
export async function pushAllRepos(
  ctx: AgentContext,
  a: { accountId: number; buildId: number; draft: boolean; push?: PushRepoFn },
): Promise<StoryBuildRepoPushResult[] | null> {
  const build = await getStoryBuildRow(ctx, a.accountId, a.buildId);
  if (!build) return null;
  const push = a.push ?? pushRepo;
  const rows = await listStoryBuildRepoRows(ctx, a.accountId, a.buildId);
  const out: StoryBuildRepoPushResult[] = [];
  for (const r of rows) {
    if (!r.include || r.status !== 'ready') continue;
    out.push(await push(ctx, { accountId: a.accountId, buildId: a.buildId, repoId: r.repoId, draft: a.draft }));
  }
  return out;
}
