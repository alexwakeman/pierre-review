// RELATED REPOS (docs/CLAUDE-REVIEW.md § Related repos), on a THROWAWAY sqlite DB over the real
// migrations. What this pins:
//   1. THE SETTING: a relation is SYMMETRIC (stored both ways, listed once), confined to the workspace's
//      membership, cleared by a move out of the workspace and by deleting the repo; the routes 404 on
//      another account's workspace or a repo outside it; the composite FKs refuse a cross-account row.
//   2. THE MATCHING RULES, IN ORDER, per related repo: (1) an open PR on the same head branch, else (2)
//      an open PR carrying the same ticket key (case-insensitive), else (3) a same-named branch with no
//      PR, else (4) the default branch. Closed PRs and other accounts' PRs never match.
//   3. THE PEERS: related changes lead, then ticket peers, then default-branch references, one cap; a
//      related repo with a ticket peer already is skipped; a deep run stores what it read and the
//      review serves it as `alsoRead`.
//
//   pnpm --filter @pierre-review/backend test related-repos
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW, type ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';
import { _overrideTicketSourceForTest, _resetTicketSourceForTest } from '../../tracker/ticket-source.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-related-repos-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

const BRANCH = 'bmd-1048-created-area-edit';
const HEAD = 'a'.repeat(40);
const DIFF = 'diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -0,0 +1,1 @@\n+a\n';

let db: any;
let schema: any;
let client: any;
let q: any;
let rr: typeof import('../../db/related-repos.js');
let picker: typeof import('./related-repos.js');
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let ctx: AgentContext;
let app: FastifyInstance;
let ws = 0;
let otherWs = 0;
let foreignWs = 0;
const id: Record<string, number> = {};
let reviewedPr = 0;
// Rule 3's GitHub read: the branches that exist, per repo name.
const branches: Record<string, string[]> = {};
const branchLookups: string[] = [];
let lastArgs: RunReviewArgs | null = null;
let checkedOut: string[] = [];

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  await runMigrations();
  q = await import('../../db/queries.js');
  rr = await import('../../db/related-repos.js');
  picker = await import('./related-repos.js');
  manager = await import('./manager.js');
  persist = await import('./persist.js');

  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'U_rr_b', githubLogin: 'rr-b', isLocal: false })
    .onConflictDoNothing()
    .execute();

  const repo = async (accountId: number, name: string, defaultBranch: string | null = 'main'): Promise<number> =>
    (
      await db
        .insert(schema.repos)
        .values({ accountId, owner: 'acme', name, githubNodeId: `R_${accountId}_${name}`, defaultBranch })
        .returning()
        .execute()
    )[0].id as number;
  for (const n of ['web', 'api', 'docs', 'infra', 'sdk', 'lonely']) id[n] = await repo(1, n, n === 'sdk' ? null : 'main');
  id.foreign = await repo(2, 'api');

  ws = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);
  await q.ensureRepoMemberships(1);
  await q.ensureRepoMemberships(2);
  otherWs = (await q.createWorkspace(1, 'Other')).id;

  const pr = async (
    accountId: number,
    repoId: number,
    number: number,
    over: { title?: string; headRefName?: string | null; state?: string; headSha?: string | null } = {},
  ): Promise<number> =>
    (
      await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_${accountId}_${repoId}_${number}`,
          accountId,
          repoId,
          number,
          title: over.title ?? `PR ${number}`,
          state: over.state ?? 'open',
          isDraft: false,
          openedAt: new Date(),
          updatedAt: new Date(),
          headSha: over.headSha === undefined ? 'b'.repeat(40) : over.headSha,
          headRefName: over.headRefName === undefined ? `branch-${number}` : over.headRefName,
          files: [{ path: `src/f${number}.ts`, additions: 1, deletions: 0 }],
        })
        .returning()
        .execute()
    )[0].id as number;

  reviewedPr = await pr(1, id.web!, 418, { title: 'BMD-1048: Edit Created area habitat details', headRefName: BRANCH, headSha: HEAD });
  // api: rule 1 (same branch) beats a same-ticket PR and a CLOSED same-branch PR.
  await pr(1, id.api!, 20, { title: 'BMD-1048 api bits', headRefName: 'other-branch' });
  id.apiSameBranch = await pr(1, id.api!, 21, { title: 'Backend for created areas', headRefName: BRANCH });
  await pr(1, id.api!, 22, { headRefName: BRANCH, state: 'closed' });
  // docs: rule 2 — a lower-case key in the branch only (case-insensitive).
  await pr(1, id.docs!, 30, { title: 'Docs for created areas', headRefName: 'feature/bmd-1048-docs' });
  await pr(1, id.docs!, 31, { title: 'BMD-9 unrelated' });
  // infra: no PR; rule 3 — the branch exists. sdk: nothing; rule 4 (default branch unknown → null).
  branches.infra = [BRANCH];
  branches.sdk = [];
  // Another account's same-branch PR in ITS repo named acme/api — never read.
  await pr(2, id.foreign, 40, { headRefName: BRANCH });

  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF,
        promptDiff: DIFF,
        changedFiles: ['src/api.ts'],
        excludedFiles: [],
        omittedFiles: [],
        fileMetrics: [{ path: 'src/api.ts', additions: 1, deletions: 0, isNew: false, apiTouch: true }],
        diffBytes: DIFF.length,
        diffCapped: false,
      }),
      runReview: async (args: RunReviewArgs) => {
        lastArgs = args;
        return {
          submitted: true,
          scope: 'worktree',
          summary: 'ok',
          verdict: 'COMMENT',
          findings: [],
          costUsd: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          numTurns: 1,
          aborted: false,
          peersCheckedOut: checkedOut,
        } as RunReviewResult;
      },
    },
    github: {
      fetchCompareDiff: async () => ({ ok: false }),
      fetchBranchHeadSha: async (_acct: number, a: { owner: string; name: string; branch: string }) => {
        branchLookups.push(`${a.name}@${a.branch}`);
        return (branches[a.name] ?? []).includes(a.branch) ? 'c'.repeat(40) : null;
      },
    },
    queries: {},
  } as any as AgentContext;

  const { workspaceRoutes } = await import('../../api/routes/workspaces.js');
  const { registerAccountContext } = await import('../../api/plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(workspaceRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await client?.closeDb();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

afterEach(() => {
  _resetTicketSourceForTest();
  branchLookups.length = 0;
});

const rows = async (): Promise<Array<[number, number]>> =>
  (
    await db
      .select({ a: schema.repoRelations.repoId, b: schema.repoRelations.relatedRepoId })
      .from(schema.repoRelations)
      .execute()
  ).map((r: any) => [r.a, r.b]);

describe('the setting', () => {
  it('is symmetric: stored both ways, listed once; another account’s repo and the repo itself are ignored', async () => {
    expect(await rr.getRelatedRepoPairs(1, ws)).toEqual([]);
    expect(await rr.setRelatedRepos(1, ws, id.web!, [id.api!, id.web!, id.foreign!])).toBe(true);
    expect((await rows()).sort()).toEqual([[id.web, id.api], [id.api, id.web]].sort());
    expect(await rr.getRelatedRepoPairs(1, ws)).toEqual([{ repoId: Math.min(id.web!, id.api!), relatedRepoId: Math.max(id.web!, id.api!) }]);
    // Clearing from the OTHER side clears both rows.
    expect(await rr.setRelatedRepos(1, ws, id.api!, [])).toBe(true);
    expect(await rows()).toEqual([]);
  });

  it('the routes: GET lists pairs, PUT replaces one repo’s; another account’s workspace or a repo outside it is a 404', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ws}/related-repos/${id.web}`,
      payload: { relatedRepoIds: [id.api, id.docs] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().pairs).toHaveLength(2);
    const get = await app.inject({ method: 'GET', url: `/api/workspaces/${ws}/related-repos` });
    expect(get.json()).toEqual({ workspaceId: ws, pairs: put.json().pairs });
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${foreignWs}/related-repos` })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'PUT', url: `/api/workspaces/${foreignWs}/related-repos/${id.foreign}`, payload: { relatedRepoIds: [] } }))
        .statusCode,
    ).toBe(404);
    // A repo of THIS account that is not in the workspace.
    expect(
      (await app.inject({ method: 'PUT', url: `/api/workspaces/${otherWs}/related-repos/${id.web}`, payload: { relatedRepoIds: [] } }))
        .statusCode,
    ).toBe(404);
  });

  it('a move out of the workspace drops the repo’s relations, both ways', async () => {
    await rr.setRelatedRepos(1, ws, id.web!, [id.api!, id.lonely!]);
    await q.assignReposToWorkspace(otherWs, 1, [id.lonely]);
    expect((await rows()).some(([a, b]) => a === id.lonely || b === id.lonely)).toBe(false);
    expect((await rows()).some(([a, b]) => a === id.web && b === id.api)).toBe(true);
    // Re-homing to Default from the PATCH drop path does the same.
    await rr.setRelatedRepos(1, otherWs, id.lonely!, []);
    await q.rehomeReposToDefault(1, [id.lonely]);
    await q.assignReposToWorkspace(ws, 1, [id.lonely]);
    expect((await rows()).some(([a, b]) => a === id.lonely || b === id.lonely)).toBe(false);
  });

  it('deleting a repo drops its relations', async () => {
    const extra = (
      await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'gone', githubNodeId: 'R_gone' }).returning().execute()
    )[0].id as number;
    await q.assignReposToWorkspace(ws, 1, [extra]);
    await rr.setRelatedRepos(1, ws, id.web!, [id.api!, extra]);
    expect(await q.deleteRepo(extra, 1)).toBe(true);
    expect((await rows()).some(([a, b]) => a === extra || b === extra)).toBe(false);
  });

  it('⚠ the composite FKs refuse a row naming another account’s repo or workspace', async () => {
    for (const values of [
      { accountId: 1, workspaceId: ws, repoId: id.web, relatedRepoId: id.foreign },
      { accountId: 1, workspaceId: foreignWs, repoId: id.web, relatedRepoId: id.api },
    ]) {
      let refused = false;
      try {
        await db.insert(schema.repoRelations).values(values).execute();
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }
  });
});

describe('the matching rules, in order', () => {
  beforeAll(async () => {
    await rr.setRelatedRepos(1, ws, id.web!, [id.api!, id.docs!, id.infra!, id.sdk!]);
  });

  it('1 same branch, 2 same ticket, 3 branch with no PR, 4 default branch', async () => {
    const peers = await picker.relatedRepoPeersFor(ctx, 1, reviewedPr);
    expect(peers.map((p) => [p.name, p.match, p.branch, p.pr?.number ?? null, p.ticketKeys])).toEqual([
      // The shared key is still named (the branch carries it), though rule 1 matched first.
      ['api', 'same_branch', BRANCH, 21, ['BMD-1048']],
      ['docs', 'same_ticket', 'feature/bmd-1048-docs', 30, ['BMD-1048']],
      ['infra', 'branch', BRANCH, null, []],
      ['sdk', 'default_branch', null, null, []],
    ]);
    // Rule 3's GitHub read happens only where rules 1 and 2 found nothing.
    expect(branchLookups.sort()).toEqual([`infra@${BRANCH}`, `sdk@${BRANCH}`]);
  });

  it('symmetric at review time: a PR in the other repo finds this one', async () => {
    const backendPr = id.apiSameBranch!;
    const peers = await picker.relatedRepoPeersFor(ctx, 1, backendPr);
    expect(peers.find((p) => p.name === 'web')).toMatchObject({ match: 'same_branch', pr: { number: 418 } });
  });

  it('a repo with no relation, or one moved away, yields nothing; a failure costs the peers only', async () => {
    const lonelyPr = (
      await db
        .insert(schema.pullRequests)
        .values({ githubNodeId: 'PR_lonely', accountId: 1, repoId: id.lonely, number: 1, title: 't', state: 'open', isDraft: false, openedAt: new Date(), updatedAt: new Date(), headSha: HEAD })
        .returning()
        .execute()
    )[0].id as number;
    expect(await picker.relatedRepoPeersFor(ctx, 1, lonelyPr)).toEqual([]);
    // Another account cannot read this PR's relations.
    expect(await picker.relatedRepoPeersFor(ctx, 2, reviewedPr)).toEqual([]);
    expect(await picker.relatedRepoPeersFor({ ...ctx, schema: {} } as any, 1, reviewedPr)).toEqual([]);
  });

  it('ticket keys are read case-insensitively from the title and the branch', () => {
    expect(picker.ticketKeysOf('Edit area', 'bmd-1048-created-area-edit')).toEqual(['BMD-1048']);
    expect(picker.ticketKeysOf('BMD-1048: Edit', null)).toEqual(['BMD-1048']);
  });
});

describe('the peers of a deep review', () => {
  it('related changes lead, ticket peers next, default-branch references last, one cap; refs in that order', async () => {
    const peers = await manager.reviewPeersFor({ ctx, accountId: 1, prId: reviewedPr });
    expect(peers).toHaveLength(Math.min(4, TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW));
    expect(peers.map((p) => [p.ref, p.repoFullName, p.kind, p.source])).toEqual([
      ['X1', 'acme/api', 'pr', 'related_repo'],
      ['X2', 'acme/docs', 'pr', 'related_repo'],
      ['X3', 'acme/infra', 'branch', 'related_repo'],
      ['X4', 'acme/sdk', 'default_branch', 'related_repo'],
    ]);
  });

  it('a related repo that already has a ticket peer is skipped (that PR is its companion change)', async () => {
    const ticketPeerId = (
      await db.select().from(schema.pullRequests).execute()
    ).find((r: any) => r.repoId === id.docs && r.number === 31).id as number;
    _overrideTicketSourceForTest({
      ticketsForPr: async () => [
        { ident: 'jira:x#BMD-9', ticket: { title: 't', description: null, acceptanceCriteria: null, key: 'BMD-9' }, ticketHash: 'h' },
      ],
      ticketMembers: async () => [{ prId: ticketPeerId, workspaceId: ws }],
    });
    const peers = await manager.reviewPeersFor({ ctx, accountId: 1, prId: reviewedPr });
    expect(peers.map((p) => [p.ref, p.repoFullName, p.number, p.source ?? 'ticket'])).toEqual([
      ['X1', 'acme/api', 21, 'related_repo'],
      ['X2', 'acme/infra', null, 'related_repo'],
      ['X3', 'acme/docs', 31, 'ticket'],
      ['X4', 'acme/sdk', null, 'related_repo'],
    ]);
  });

  it('a deep run is handed every kind, and stores what it read: the review serves it as alsoRead', async () => {
    checkedOut = ['X1', 'X3'];
    const started = await manager.startReview(ctx, 1, reviewedPr, 'claude-opus-5-5');
    if (!started.ok) throw new Error(started.reason);
    let r: ClaudeReview | null = null;
    for (let i = 0; i < 200; i++) {
      r = await persist.getClaudeReviewById(ctx, started.reviewId, 1);
      if (r && r.status !== 'queued' && r.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(r?.status).toBe('succeeded');
    expect(lastArgs?.mode).toBe('worktree');
    expect(lastArgs?.peers).toEqual([
      { ref: 'X1', owner: 'acme', name: 'api', prNumber: 21, headSha: 'b'.repeat(40) },
      { ref: 'X2', owner: 'acme', name: 'docs', prNumber: 30, headSha: 'b'.repeat(40) },
      { ref: 'X3', owner: 'acme', name: 'infra', kind: 'branch', branch: BRANCH },
      { ref: 'X4', owner: 'acme', name: 'sdk', kind: 'default_branch', branch: null },
    ]);
    expect(lastArgs?.prompt).toContain('## Related code in other repositories');
    expect(lastArgs?.prompt).toContain('### X3: acme/infra · Companion branch (no pull request)');
    expect(r?.alsoRead).toEqual([
      { repoFullName: 'acme/api', kind: 'pr', source: 'related_repo', number: 21, branch: BRANCH },
      { repoFullName: 'acme/infra', kind: 'branch', source: 'related_repo', number: null, branch: BRANCH },
    ]);
    await new Promise((res) => setTimeout(res, 30));
  });
});
