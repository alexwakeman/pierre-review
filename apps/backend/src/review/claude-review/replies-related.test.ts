// THE REPLIES PASS READS RELATED CODE — the related repos' peers a full review reads, and the pull
// requests a reply LINKS to (docs/CLAUDE-REVIEW.md § The replies pass). What is pinned:
//
//   1. THE SCANNER (untrusted text): a GitHub URL, owner/name#N, name#N and #N; deduplicated, at most
//      LINKS_PER_REPLY; never glued to a word, a path, an HTML entity or a heading.
//   2. ONLY THE PR'S OWN REPO OR A RELATED ONE, only a STORED PR, never the PR itself, at most
//      REPLIES_LINKED_PR_MAX per pass; an open PR is checked out at its HEAD, a merged one as the
//      DEFAULT BRANCH; a closed one is ignored.
//   3. THE PASS: the related peers (`reviewPeersFor`) and the linked PRs are checked out and handed to
//      the agent as read-only roots, on Claude and on Codex; the prompt maps each thread to its linked
//      checkout; every checkout is cleaned up on success AND on failure.
//   4. THE 188673 CASE: a frontend warning answered "fixed in the backend PR"; the agent can now see
//      the backend code, accepts, and the auto pass APPROVES.
//
//   pnpm --filter @pierre-review/backend test replies-related
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';
import type { ReviewRunPeer } from '../../platform/contract.js';
import type { LinkedPr } from './replies-linked-prs.js';
// ⚠ Every VALUE import of the code under test is dynamic (beforeAll), AFTER DATABASE_URL is set: a
// static import is hoisted above it, and anything that reaches db/client.js would open the run's
// shared default DB instead of this file's own.

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-replies-related.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

// ---- the fake agent ----
const agentCalls: any[] = [];
let script: (args: any) => any = () => ({ replies: [] });
vi.mock('./replies-check-agent.js', () => ({
  runRepliesCheckAgent: async (args: any) => {
    agentCalls.push(args);
    return {
      submitted: true,
      ranOn: { provider: args.provider, model: args.provider === 'codex' ? 'gpt-6.1-terra' : 'claude-sonnet-5', effort: 'medium' },
      replies: script(args).replies,
      aborted: false,
      costUsd: null,
      inputTokens: 10,
      outputTokens: 5,
      numTurns: 1,
    };
  },
}));
vi.mock('../ticket-review/prepare.js', async (orig) => ({
  ...(await orig<typeof import('../ticket-review/prepare.js')>()),
  prepareMemberWorktrees: async () => {
    throw new Error('no clone in tests');
  },
}));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));

// ---- the fake checkouts: a real temp dir per ref; the backend's default branch carries the fix ----
const checkoutCalls: ReviewRunPeer[][] = [];
const cleanups = vi.fn();
const made: string[] = [];
vi.mock('../peer-checkouts.js', () => ({
  checkOutPeers: async (peers: ReviewRunPeer[], list: Array<() => Promise<void>>) => {
    checkoutCalls.push(peers);
    const paths = new Map<string, string>();
    const dirs: string[] = [];
    for (const p of peers) {
      const dir = mkdtempSync(join(tmpdir(), `limn-rr-${p.ref}-`));
      if (p.name === 'bng-metric-backend' && p.kind === 'default_branch') {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'resolveSource.ts'), 'export function resolveSource() { /* re-syncs from parentFeatureId */ }\n');
      }
      dirs.push(dir);
      made.push(dir);
      paths.set(p.ref, dir);
    }
    list.push(async () => {
      cleanups(peers.map((p) => p.ref));
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });
    return paths;
  },
}));

const HEAD = 'a'.repeat(40);
const PATH = 'src/features.ts';
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
const HOUR = 3600_000;
const LATER = Date.now() + HOUR;
const MARK = '\n\n<!-- pierre:claude-review-finding v=1 -->';
const FIXED = 'Confirmed, and fixed in DEFRA/bng-metric-backend#556. For a template upload, `resolveSource` now re-syncs each row from its parent.';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let persist: typeof import('./persist.js');
let rc: typeof import('./replies-check.js');
let manager: typeof import('./manager.js');
let settings: typeof import('./auto-settings.js');
let linkedMod: typeof import('./replies-linked-prs.js');
let extractPrLinks: typeof import('./replies-linked-prs.js').extractPrLinks;
let linkedRunPeer: typeof import('./replies-linked-prs.js').linkedRunPeer;
let repoOfLink: typeof import('./replies-linked-prs.js').repoOfLink;
let LINKS_PER_REPLY = 0;
let REPLIES_LINKED_PR_MAX = 0;
let buildRepliesPrompt: typeof import('./replies-check-prompt.js').buildRepliesPrompt;
let repliesSystemPrompt: typeof import('./replies-check-prompt.js').repliesSystemPrompt;
let planRepliesPass: typeof import('./replies-pass.js').planRepliesPass;
let wsId = 0;
const repo: Record<string, number> = {};
const users: Record<string, number> = {};
let node = 1;
let prSeq = 1000;

const postReview = vi.fn();
const postDeps = () => ({
  livePr: async () => ({ headSha: HEAD, state: 'open' as const, draft: false, merged: false }),
  settle: async () => ({ visible: true }),
  isAutomation: async () => false,
  accountUserId: async () => users.me!,
  accountLogin: async () => 'me',
  liveReviews: async () => [],
  dismissReview: async () => ({ ok: true as const }),
  impactLevel: async () => 'low' as const,
});
const resolveDeps = {
  reply: async () => ({ commentId: 'C1' }),
  resolve: async () => {},
  stamp: async () => {},
  notePrChanged: async () => {},
};

async function makePr(
  repoId: number,
  over: { number?: number; state?: 'open' | 'merged' | 'closed'; headSha?: string | null; title?: string } = {},
): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${prSeq}`,
      accountId: 1,
      repoId,
      number: over.number ?? prSeq,
      title: over.title ?? `pr ${prSeq}`,
      state: over.state ?? 'open',
      isDraft: false,
      openedAt: new Date(),
      updatedAt: new Date(),
      headSha: over.headSha === undefined ? HEAD : over.headSha,
      headRefName: `branch-${prSeq}`,
      authorId: users.robin,
    })
    .returning()
    .execute();
  return p.id;
}

/** A succeeded full review with one posted warning per row, each with its thread + replies. */
async function reviewed(
  pr: number,
  rows: Array<{ title: string; replies: string[] }>,
  opts: { provider?: 'claude' | 'codex'; trigger?: 'auto' | 'manual' } = {},
): Promise<Map<string, number>> {
  const reviewId = await persist.insertQueuedReview(ctx, pr, HEAD, 'claude-opus-5-5', 1, [], opts.trigger ?? 'auto', opts.provider ?? 'claude', false, null);
  await persist.saveReviewSuccess(ctx, reviewId, {
    scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
    numTurns: 1, excludedFiles: [],
    findings: rows.map((r, i) => ({
      path: PATH, line: 2 + i, side: 'RIGHT' as const, severity: 'warning' as const, title: r.title, body: `${r.title}.`,
      suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
    })),
  });
  const ids = new Map<string, number>((await persist.getClaudeReviewById(ctx, reviewId, 1))!.findings.map((f) => [f.title, f.id] as const));
  for (const r of rows) {
    const id = ids.get(r.title)!;
    await persist.markFindingPosted(ctx, id, String(5000 + id));
    const [t] = await db
      .insert(schema.reviewThreads)
      .values({ githubNodeId: `RT_${node++}`, prId: pr, path: PATH, line: 2, isResolved: false, derivedState: 'replied_unresolved', createdAt: new Date(Date.now() - HOUR) })
      .returning()
      .execute();
    const comments = [
      { authorId: users.me!, at: Date.now() - HOUR, body: `${r.title}.${MARK}`, databaseId: String(5000 + id) },
      ...r.replies.map((body, j) => ({ authorId: users.robin!, at: LATER + j * 1000, body, databaseId: null })),
    ];
    for (const c of comments) {
      await db
        .insert(schema.reviewComments)
        .values({ githubNodeId: `RC_${node++}`, threadId: t.id, prId: pr, authorId: c.authorId, body: c.body, databaseId: c.databaseId, createdAt: new Date(c.at) })
        .execute();
    }
  }
  return ids;
}

async function settleFor(prId: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!rc.repliesCheckHeld(1, prId) && !manager.reviewHeldForPr(prId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('replies check did not finish');
}

const passRows = async (prId: number) =>
  (await persist.listClaudeReviewHistory(ctx, prId, 1)).filter((h) => h.kind === 'replies');

/** Does any root the agent was given hold this file? (The fake agent's "Read".) */
const canSee = (call: any, rel: string): boolean => (call.worktrees as string[]).some((w) => existsSync(join(w, rel)));

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  for (const login of ['me', 'robin']) {
    const [u] = await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}` }).returning().execute();
    users[login] = u.id;
  }
  for (const name of ['bng-metric-frontend', 'bng-metric-backend', 'unrelated']) {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'DEFRA', name, githubNodeId: `R_${name}`, defaultBranch: 'main' })
      .returning()
      .execute();
    repo[name] = r.id;
  }
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  const rr = await import('../../db/related-repos.js');
  expect(await rr.setRelatedRepos(1, wsId, repo['bng-metric-frontend']!, [repo['bng-metric-backend']!])).toBe(true);
  const { _overrideTicketSourceForTest } = await import('../../tracker/ticket-source.js');
  _overrideTicketSourceForTest({ ticketsForPr: async () => [], ticketMembers: async () => [] });
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: {
      postReview,
      prepareReview: async () => ({
        strippedDiff: DIFF, promptDiff: DIFF, changedFiles: [PATH], excludedFiles: [], omittedFiles: [],
        fileMetrics: [{ path: PATH, additions: 4, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length, diffCapped: false,
      }),
      runReview: async () => ({ submitted: true, scope: 'diff_only', summary: 'ok', verdict: 'COMMENT', findings: [], costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1 }),
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  persist = await import('./persist.js');
  manager = await import('./manager.js');
  rc = await import('./replies-check.js');
  settings = await import('./auto-settings.js');
  linkedMod = await import('./replies-linked-prs.js');
  ({ extractPrLinks, linkedRunPeer, repoOfLink, LINKS_PER_REPLY, REPLIES_LINKED_PR_MAX } = linkedMod);
  ({ buildRepliesPrompt, repliesSystemPrompt } = await import('./replies-check-prompt.js'));
  ({ planRepliesPass } = await import('./replies-pass.js'));
  rc._setRepliesAutoDepsForTest({ post: postDeps() as any, resolve: resolveDeps });
});

afterAll(async () => {
  rc?._setRepliesAutoDepsForTest(null);
  const { _resetTicketSourceForTest } = await import('../../tracker/ticket-source.js');
  _resetTicketSourceForTest();
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  agentCalls.length = 0;
  checkoutCalls.length = 0;
  cleanups.mockReset();
  postReview.mockReset();
  postReview.mockImplementation(async () => ({ postedReviewId: '7001', inlineFindingIds: [], prComments: [], commentCount: 0, prCommentCount: 0 }));
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: false } as any });
});

describe('the link scanner (untrusted text)', () => {
  it('reads a URL, owner/name#N, name#N and #N, in order, deduplicated', () => {
    expect(
      extractPrLinks(
        'See https://github.com/DEFRA/bng-metric-backend/pull/556 and DEFRA/bng-metric-backend#557, (bng-metric-backend#558) and #12. Again #12.',
      ),
    ).toEqual([
      { owner: 'DEFRA', name: 'bng-metric-backend', number: 556 },
      { owner: 'DEFRA', name: 'bng-metric-backend', number: 557 },
      { owner: null, name: 'bng-metric-backend', number: 558 },
      { owner: null, name: null, number: 12 },
    ]);
  });

  it('ignores what only looks like a link: a heading, an entity, a fragment, a word, an issue URL', () => {
    expect(
      extractPrLinks('## 1 heading, &#123; entity, https://x.test/a#12 fragment, abc#x, C#7 is not, ##9, https://github.com/o/r/issues/4'),
    ).toEqual([{ owner: null, name: 'C', number: 7 }]);
    // `C#7` reads as a repo named C — harmless: it resolves only to an allowed repo of that name.
  });

  it('is bounded: at most LINKS_PER_REPLY links, and a huge reply is read only so far', () => {
    const many = Array.from({ length: 40 }, (_, i) => `#${i + 1}`).join(' ');
    expect(extractPrLinks(many)).toHaveLength(LINKS_PER_REPLY);
    const t0 = Date.now();
    expect(extractPrLinks(`${'a/'.repeat(200_000)}#5`)).toEqual([]);
    expect(extractPrLinks('a'.repeat(500_000))).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a link names the PR’s own repo or a related one, never anything else', () => {
    const self = { repoId: 1, owner: 'DEFRA', name: 'bng-metric-frontend', defaultBranch: 'main' };
    const related = [{ repoId: 2, owner: 'DEFRA', name: 'bng-metric-backend', defaultBranch: 'main' }];
    expect(repoOfLink({ owner: null, name: null, number: 3 }, self, related)).toBe(self);
    expect(repoOfLink({ owner: 'defra', name: 'BNG-METRIC-BACKEND', number: 3 }, self, related)).toBe(related[0]);
    expect(repoOfLink({ owner: null, name: 'bng-metric-backend', number: 3 }, self, related)).toBe(related[0]);
    expect(repoOfLink({ owner: 'evil', name: 'bng-metric-backend', number: 3 }, self, related)).toBeNull();
    expect(repoOfLink({ owner: 'DEFRA', name: 'unrelated', number: 3 }, self, related)).toBeNull();
  });

  it('open → a worktree at its HEAD; merged → the default branch', () => {
    const base: LinkedPr = {
      ref: 'L1', prId: 9, repoId: 2, owner: 'DEFRA', name: 'bng-metric-backend', repoFullName: 'DEFRA/bng-metric-backend',
      number: 556, title: 't', state: 'open', headSha: 'f'.repeat(40), defaultBranch: 'main', findingIds: [1],
    };
    expect(linkedRunPeer(base)).toEqual({ ref: 'L1', owner: 'DEFRA', name: 'bng-metric-backend', prNumber: 556, headSha: 'f'.repeat(40) });
    expect(linkedRunPeer({ ...base, state: 'merged', headSha: null })).toEqual({
      ref: 'L1', owner: 'DEFRA', name: 'bng-metric-backend', kind: 'default_branch', branch: 'main',
    });
  });
});

describe('which linked PRs a pass checks out', () => {
  it('only stored PRs in the own or a related repo, never itself, never a closed one, at most two', async () => {
    const fe = await makePr(repo['bng-metric-frontend']!, { number: 428 });
    await makePr(repo['bng-metric-backend']!, { number: 600, state: 'open', headSha: 'c'.repeat(40), title: 'Backend 600' });
    await makePr(repo['bng-metric-backend']!, { number: 601, state: 'merged', title: 'Backend 601' });
    await makePr(repo['bng-metric-backend']!, { number: 602, state: 'open' });
    await makePr(repo['bng-metric-backend']!, { number: 603, state: 'closed' });
    await makePr(repo.unrelated!, { number: 5 });
    await makePr(repo['bng-metric-frontend']!, { number: 429, state: 'merged' });
    const f = (id: number, body: string): any => ({ id, thread: { replies: [{ author: 'robin', body, at: new Date(LATER).toISOString() }] } });
    const linked = await linkedMod.linkedPrsFor(ctx, 1, fe, [
      // Unrelated repo, a closed PR, an unknown PR and the PR itself: ignored.
      f(1, 'See DEFRA/unrelated#5, bng-metric-backend#603, DEFRA/bng-metric-backend#999 and #428.'),
      f(2, 'Fixed in DEFRA/bng-metric-backend#600 and https://github.com/DEFRA/bng-metric-backend/pull/601, also #429.'),
      f(3, 'And bng-metric-backend#602 and DEFRA/bng-metric-backend#600.'),
    ]);
    expect(linked.length).toBe(REPLIES_LINKED_PR_MAX);
    expect(linked.map((l) => [l.ref, l.repoFullName, l.number, l.state, l.findingIds])).toEqual([
      ['L1', 'DEFRA/bng-metric-backend', 600, 'open', [2, 3]],
      ['L2', 'DEFRA/bng-metric-backend', 601, 'merged', [2]],
    ]);
    expect(linked[0]!.headSha).toBe('c'.repeat(40));
    expect(linked[1]!.headSha).toBeNull();
    // A reply with no link reads nothing more; a broken ctx costs the links only.
    expect(await linkedMod.linkedPrsFor(ctx, 1, fe, [f(4, 'Thanks!')])).toEqual([]);
    expect(await linkedMod.linkedPrsFor({ ...ctx, schema: {} } as any, 1, fe, [f(2, '#429')])).toEqual([]);
  });
});

describe('the prompt maps each thread to its linked checkout', () => {
  it('names the linked PR on the thread, lists it, and gives its path; both providers', () => {
    const finding: any = {
      id: 7, path: PATH, line: 2, severity: 'warning', title: 'Edits do not reach children', body: 'b', diffHunk: null,
      thread: { replies: [{ author: 'robin', body: FIXED, at: new Date(LATER).toISOString() }], pushedBack: false, isResolved: false },
    };
    const linked: LinkedPr[] = [{
      ref: 'L1', prId: 9, repoId: 2, owner: 'DEFRA', name: 'bng-metric-backend', repoFullName: 'DEFRA/bng-metric-backend',
      number: 556, title: 'Template rows re-sync', state: 'merged', headSha: null, defaultBranch: 'main', findingIds: [7],
    }];
    const peers: any[] = [{
      ref: 'X1', repoFullName: 'DEFRA/bng-metric-backend', kind: 'default_branch', source: 'related_repo', match: null,
      branch: 'main', number: null, title: '', state: null, ticketKeys: [], files: [],
    }];
    for (const provider of ['claude', 'codex'] as const) {
      const prompt = buildRepliesPrompt({
        repoFullName: 'DEFRA/bng-metric-frontend', number: 428, title: 'Frontend', headSha: HEAD, worktreePath: null,
        plan: planRepliesPass([finding], HEAD), nonce: 'n0nce', provider, peers, linked,
        checkouts: [{ ref: 'X1', path: '/tmp/x1' }, { ref: 'L1', path: '/tmp/l1' }],
      });
      expect(prompt).toMatch(/---BEGIN THREAD T1 n0nce---[\s\S]*Pull requests these replies link to: L1 \(DEFRA\/bng-metric-backend#556\)[\s\S]*---END THREAD T1 n0nce---/);
      expect(prompt).toContain('### L1: DEFRA/bng-metric-backend#556 (merged)');
      expect(prompt).toContain('---BEGIN LINKED PR L1 n0nce---\nTitle: Template rows re-sync\n---END LINKED PR L1 n0nce---');
      expect(prompt).toContain('### X1: DEFRA/bng-metric-backend · Reference: default branch');
      expect(prompt).toContain('- X1: /tmp/x1');
      expect(prompt).toContain('- L1: /tmp/l1');
      expect(prompt).toContain('check that in the checkout listed for it before you accept');
      expect(repliesSystemPrompt(provider)).toContain('Related checkouts');
    }
    // No related code ⇒ none of it is said.
    const bare = buildRepliesPrompt({
      repoFullName: 'DEFRA/bng-metric-frontend', number: 428, title: 'Frontend', headSha: HEAD, worktreePath: null,
      plan: planRepliesPass([finding], HEAD), nonce: 'n0nce', provider: 'claude',
    });
    expect(bare).not.toContain('Related checkouts');
    expect(bare).not.toContain('link to');
  });
});

describe('the pass reads the related code', () => {
  it('⚠ THE 188673 CASE: the backend fix is visible, the warning is accepted, and the auto pass APPROVES', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: true, scope: 'all', autoVerdict: true } as any });
    const fe = await makePr(repo['bng-metric-frontend']!, { number: 4280 });
    await makePr(repo['bng-metric-backend']!, { number: 556, state: 'merged', title: 'Template rows re-sync from their parent' });
    await reviewed(fe, [{ title: 'Edits do not reach template children', replies: [FIXED] }], { provider: 'codex' });
    // The fake agent "reads" the backend: it accepts only when resolveSource.ts is under a root.
    script = (call: any) =>
      canSee(call, 'src/resolveSource.ts')
        ? { replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Confirmed in the backend: resolveSource re-syncs from the parent.' }] }
        : { replies: [{ ref: 'T1', status: 'not_checked', explanation: 'The backend code is not here.' }] };
    expect((await rc.startRepliesCheck(ctx, { accountId: 1, prId: fe, trigger: 'auto' })).outcome).toBe('queued');
    await settleFor(fe);
    expect(agentCalls).toHaveLength(1);
    const call = agentCalls[0];
    // On Codex (the thread's owner), with the related repo's default branch AND the linked PR.
    expect(call.provider).toBe('codex');
    expect(checkoutCalls).toEqual([
      [{ ref: 'X1', owner: 'DEFRA', name: 'bng-metric-backend', kind: 'default_branch', branch: 'main' }],
      [{ ref: 'L1', owner: 'DEFRA', name: 'bng-metric-backend', kind: 'default_branch', branch: 'main' }],
    ]);
    expect(call.worktrees).toHaveLength(2);
    expect(call.prompt).toContain('Pull requests these replies link to: L1 (DEFRA/bng-metric-backend#556)');
    expect(call.prompt).toContain(`- L1: ${call.worktrees[1]}`);
    expect(call.prompt).toContain(`- X1: ${call.worktrees[0]}`);
    const pass = (await persist.getClaudeReviewById(ctx, (await passRows(fe))[0]!.id, 1))!;
    expect(pass.followUp!.items[0]).toMatchObject({ status: 'reply_accepted', acceptKind: 'not_valid' });
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    // Every checkout was removed after the pass.
    expect(cleanups).toHaveBeenCalledTimes(2);
    for (const w of call.worktrees) expect(existsSync(w)).toBe(false);
  });

  it('on Claude: an OPEN linked PR is checked out at its head; the related peers are passed as roots', async () => {
    const fe = await makePr(repo['bng-metric-frontend']!, { number: 4281 });
    await makePr(repo['bng-metric-backend']!, { number: 700, state: 'open', headSha: 'd'.repeat(40) });
    await reviewed(fe, [{ title: 'Missing guard', replies: ['Will land in DEFRA/bng-metric-backend#700.'] }], { provider: 'claude', trigger: 'manual' });
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'deferred', reply: 'OK, #700 adds it.' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: fe, trigger: 'manual' });
    await settleFor(fe);
    expect(agentCalls.map((c) => c.provider)).toEqual(['claude']);
    expect(checkoutCalls[1]).toEqual([{ ref: 'L1', owner: 'DEFRA', name: 'bng-metric-backend', prNumber: 700, headSha: 'd'.repeat(40) }]);
    expect(agentCalls[0].worktrees).toHaveLength(2);
    expect(cleanups).toHaveBeenCalledTimes(2);
  });

  it('a pass with no link still reads the related repo; a failed run still cleans up', async () => {
    const fe = await makePr(repo['bng-metric-frontend']!, { number: 4282 });
    await reviewed(fe, [{ title: 'Racy write', replies: ['This is intentional.'] }], { provider: 'claude', trigger: 'manual' });
    script = () => {
      throw new Error('agent blew up');
    };
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: fe, trigger: 'manual' });
    await settleFor(fe);
    expect(checkoutCalls).toEqual([[{ ref: 'X1', owner: 'DEFRA', name: 'bng-metric-backend', kind: 'default_branch', branch: 'main' }]]);
    expect(agentCalls[0].worktrees).toHaveLength(1);
    expect(agentCalls[0].prompt).not.toContain('link to');
    expect(cleanups).toHaveBeenCalledTimes(1);
  });

  it('a repo with no relations: no peers, no checkout', async () => {
    const lonely = await makePr(repo.unrelated!, { number: 4283 });
    await reviewed(lonely, [{ title: 'Off by one', replies: ['Fixed in DEFRA/bng-metric-backend#556.'] }], { provider: 'claude', trigger: 'manual' });
    script = () => ({ replies: [{ ref: 'T1', status: 'not_checked', explanation: 'x' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: lonely, trigger: 'manual' });
    await settleFor(lonely);
    // The backend is not related to `unrelated`: its PR is never checked out.
    expect(checkoutCalls).toEqual([]);
    expect(agentCalls[0].worktrees).toEqual([]);
  });
});
