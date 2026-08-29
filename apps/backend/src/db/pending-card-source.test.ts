// WHO OPENED IT, and MAY I MERGE IT — the two facts every Pending card now carries about its PR,
// on a THROWAWAY sqlite DB (the ci-failing-cards.test.ts pattern).
//
// WHAT THIS PINS, and why each is a fixture rather than a comment:
//
//   1. ⚠ THE RESOLUTION ORDER IS NOT THE LOGIN. `authorIsBot` is the SAME union the SPA's "hide
//      bots" lens hides by (`hiddenBotUserIds`): `users.isBot` ∪ this WORKSPACE's automated
//      reviewers, with a MANUAL "this is a human" judgement winning in BOTH directions. Writing
//      `reviewBotKind(login)` here instead would type-check, pass a naive fixture, and put a
//      vendor chip on an actor the Timeline beside it calls a person — the "stored role/kind
//      beats the login seed" rule losing to a convenience.
//   2. ⚠ `authorIsBot: true` WITH `authorBotKind: null` IS A REAL, COMMON STATE — an unbranded CI
//      service account. The client renders it as a generic "Bot"; the server must not invent a
//      brand for it, and must not drop the flag for want of one.
//   3. ⚠ IDENTITY IS PER WORKSPACE. The same login may be automated in one workspace and a person
//      in another. A judgement that leaked across workspaces would be a stored fact read at the
//      wrong grain — the defect the whole `workspace_reviewers` table exists to prevent.
//   4. `viewerCanPush` IS `repos.viewerPermission ∈ WRITE_PERMISSIONS`, NOT the maintainer proxy.
//      `viewerMaintainedRepoIds` also counts "has landed a PR on the default branch", which is
//      deliberately behavioural (My Turn's relevance gate) and would show merge buttons to
//      someone GitHub will refuse.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, InsightPrRef, MergeReadyCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-pending-source-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let scope: any;
let otherScope: any;

const DAY = 24 * 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;

const VIEWER_LOGIN = 'viewer-me';

const prIdByKey = new Map<string, number>();
let writableRepoId = 0;
let readOnlyRepoId = 0;
let otherWorkspaceId = 0;

/** Every `merge` card the board would paint, keyed by the fixture PR's name. */
async function mergeCards(s: any = scope): Promise<Map<string, MergeReadyCard>> {
  const insights = await q.getWorkspaceInsights(1, undefined, s);
  const byId = new Map<string, MergeReadyCard>();
  for (const c of insights.cards as InsightCard[]) {
    if (c.kind !== 'merge') continue;
    byId.set(c.id, c);
  }
  const out = new Map<string, MergeReadyCard>();
  for (const [key, prId] of prIdByKey) {
    const card = byId.get(`wp:merge:${prId}`);
    if (card) out.set(key, card);
  }
  return out;
}

/** The source pair, as the pair — asserting them together is the point (a kind without the flag
 *  is exactly the state that would paint a vendor chip over a colleague's name). */
function source(pr: InsightPrRef): [boolean, string | null] {
  return [pr.authorIsBot, pr.authorBotKind];
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');

  const { accounts, events, repos, pullRequests, users, workspaceReviewers } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId return
  // null — every `relevance: 'direct'` fold would then match nobody.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  const viewerId = await insertUser(VIEWER_LOGIN);
  // A plain colleague — the negative control the whole chip exists to leave alone.
  const humanId = await insertUser('alice-dev');
  // `users.isBot` and NOTHING else: no vendor login, no workspace row. The unbranded CI service
  // account — a bot we recognise whose vendor we do not.
  const unbrandedId = await insertUser('acme-ci-runner', true);
  // A KNOWN AI-review vendor login. `hiddenBotUserIds` seeds it from the login table even though
  // `users.isBot` is false here (a row synced before the login joined the known set), and
  // `classificationKindForUser` gives it its brand.
  const vendorId = await insertUser('coderabbitai[bot]', false);
  // ⚠ The same vendor login, MARKED HUMAN by a person in this workspace. It must come back a
  // person — in BOTH halves, flag and kind.
  const vouchedId = await insertUser('greptile-apps[bot]', true);
  // ⚠ An ordinary-looking login a person marked AUTOMATED in this workspace. No vocabulary claims
  // it; only the stored row does.
  const inHouseId = await insertUser('acme-refactor-agent');

  const insertRepo = async (key: string, viewerPermission: string): Promise<number> => {
    const [repo] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: key,
        githubNodeId: `R_src_${key}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        viewerPermission,
        createdAt: new Date(REPO_ADDED),
      })
      .returning()
      .execute();
    return repo.id;
  };
  writableRepoId = await insertRepo('writable', 'WRITE');
  // ⚠ READ, and the viewer HAS merged into its default branch below — so `viewerMaintainedRepoIds`
  // would call this repo theirs. `viewerCanPush` must not.
  readOnlyRepoId = await insertRepo('read-only', 'READ');
  const otherRepoId = await insertRepo('elsewhere', 'WRITE');

  let n = 1;
  let ev = 1;
  const insertPr = async (
    repoId: number,
    key: string,
    authorId: number,
    values: Record<string, unknown> = {},
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_src_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId,
        openedAt: new Date(REPO_ADDED + DAY),
        updatedAt: new Date(now - DAY),
        lastCommitAt: new Date(now - DAY),
        // Every fixture PR is a `merge` card: clean + non-conflicting is the whole of
        // READY_MERGE_STATES' happy path, so the source pair is what varies, not the kind.
        mergeStateStatus: 'clean',
        mergeable: 'mergeable',
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
    // getWorkspaceInsights' open-PR population requires a real ACTIVITY EVENT inside the 90-day
    // ultra-stale window — `pullRequests.updatedAt` is deliberately not trusted there. An open PR
    // with no event is invisible to the whole function.
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId: pr.id,
        actorId: authorId,
        type: 'commit_pushed',
        occurredAt: new Date(now - DAY),
        dedupeKey: `ev_src_${ev++}`,
      })
      .execute();
    return pr.id;
  };

  await insertPr(writableRepoId, 'by-human', humanId);
  await insertPr(writableRepoId, 'by-unbranded', unbrandedId);
  await insertPr(writableRepoId, 'by-vendor', vendorId);
  await insertPr(writableRepoId, 'by-vouched-human', vouchedId);
  await insertPr(writableRepoId, 'by-in-house', inHouseId);
  // The push gate's negative: same author, a repo the viewer only READS.
  await insertPr(readOnlyRepoId, 'in-read-only', humanId, { authorId: humanId });
  // …and the merge history that makes `viewerMaintainedRepoIds` claim that repo, so a gate
  // spelled with the maintainer union would pass this fixture.
  await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_src_readonly_landed',
      accountId: 1,
      repoId: readOnlyRepoId,
      number: n++,
      title: 'landed by the viewer',
      state: 'merged',
      isDraft: false,
      authorId: humanId,
      mergedById: viewerId,
      baseRefName: 'main',
      openedAt: new Date(REPO_ADDED + DAY),
      updatedAt: new Date(now - 5 * DAY),
      mergedAt: new Date(now - 5 * DAY),
    })
    .execute();
  // The per-workspace control: the SAME vouched login authoring a PR in another workspace, where
  // nobody has vouched for it.
  await insertPr(otherRepoId, 'elsewhere-by-vouched', vouchedId);

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into Default.
  // (Assignment is a MOVE, so 'elsewhere' leaves Default.)
  const other = await q.createWorkspace(1, 'Elsewhere');
  otherWorkspaceId = other.id;
  await q.assignReposToWorkspace(other.id, 1, [otherRepoId]);
  scope = await q.resolveWorkspaceScope(1, null);
  otherScope = await q.resolveWorkspaceScope(1, otherWorkspaceId);

  // The two MANUAL judgements, in the DEFAULT workspace only. `source: 'manual'` is what makes
  // them un-re-derivable; `automated: false` + manual IS the "this is a human" vouch.
  const defaultWorkspaceId = scope.workspaceId;
  await db
    .insert(workspaceReviewers)
    .values([
      {
        accountId: 1,
        workspaceId: defaultWorkspaceId,
        authorUserId: vouchedId,
        automated: false,
        role: 'review',
        confidence: 'high',
        source: 'manual',
        identitySource: 'manual',
      },
      {
        accountId: 1,
        workspaceId: defaultWorkspaceId,
        authorUserId: inHouseId,
        automated: true,
        role: 'review',
        confidence: 'high',
        source: 'manual',
        kind: 'in_house',
        identitySource: 'manual',
      },
    ])
    .execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the PR source on an attention card', () => {
  it('leaves a person alone — no flag, no kind', async () => {
    const cards = await mergeCards();
    expect(source(cards.get('by-human')!)).toEqual([false, null]);
  });

  it('⚠ flags an unbranded bot with a NULL kind rather than dropping either half', async () => {
    // `users.isBot` alone, no vendor login, no workspace row. The client renders the generic
    // "Bot"; inventing `in_house` here would be a brand claim from nothing.
    const cards = await mergeCards();
    expect(source(cards.get('by-unbranded')!)).toEqual([true, null]);
  });

  it('names the vendor when the login is a known review bot', async () => {
    // Note `users.isBot` is FALSE on this row — the login seed is what catches it, which is the
    // half a fold spelled `users.isBot` alone would miss.
    const cards = await mergeCards();
    expect(source(cards.get('by-vendor')!)).toEqual([true, 'coderabbit']);
  });

  it('⚠ a manual "this is a human" beats BOTH the vendor login and users.isBot', async () => {
    // The direction that matters most: this login is in the review-bot table AND flagged
    // `users.isBot`, and a person in this workspace has said otherwise. Any classifier that
    // consulted the login would paint a Greptile chip on a colleague.
    const cards = await mergeCards();
    expect(source(cards.get('by-vouched-human')!)).toEqual([false, null]);
  });

  it('⚠ …and a manual "this is automation" wins the other direction', async () => {
    // No vocabulary claims `acme-refactor-agent` and `users.isBot` is false; only the stored row
    // says so, and the stored row is the answer.
    const cards = await mergeCards();
    expect(source(cards.get('by-in-house')!)).toEqual([true, 'in_house']);
  });

  it('⚠ the judgement does NOT leak across workspaces', async () => {
    // The same login, one workspace over, where nobody vouched for it: back to what the login and
    // the global flag say. A cached or account-wide resolution would return the vouch here.
    const cards = await mergeCards(otherScope);
    expect(source(cards.get('elsewhere-by-vouched')!)).toEqual([true, 'greptile']);
  });
});

describe('viewerCanPush on the forward cards', () => {
  it('is true on a repo the viewer has WRITE on', async () => {
    const cards = await mergeCards();
    expect(cards.get('by-human')!.viewerCanPush).toBe(true);
  });

  it('⚠ is FALSE on a READ repo the viewer has nonetheless merged into', async () => {
    // `viewerMaintainedRepoIds` calls this repo theirs (they landed a PR on its default branch) —
    // that union is My Turn's relevance gate and is deliberately behavioural. Reusing it here
    // would render merge controls GitHub will refuse.
    const cards = await mergeCards();
    expect(cards.get('in-read-only')!.viewerCanPush).toBe(false);
    // The card itself still ships: the board shows the PR, it just offers no button.
    expect(cards.get('in-read-only')!.kind).toBe('merge');
  });
});
