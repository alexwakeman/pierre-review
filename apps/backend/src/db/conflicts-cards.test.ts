// The `conflicts` attention cards — open PRs GitHub CANNOT merge because the head conflicts with
// the base — on a THROWAWAY sqlite DB (the ci-failing-cards.test.ts pattern).
//
// WHAT THIS PINS, and why each one is worth a fixture rather than a comment:
//
//   1. ⚠ WRITE ACCESS IS THE POPULATION. Measured on the reporting account: 474 open non-draft
//      PRs conflict and 470 of them are in repos the viewer only READS. The gate is
//      `writableRepoIds` (WRITE/MAINTAIN/ADMIN), and without it the 15-row cap fills with
//      strangers' stale branches while the viewer's own conflicting PR is capped out silently.
//   2. ⚠ THE MUTATION TEST FOR THAT GATE: a READ repo the viewer has MERGED INTO emits NOTHING.
//      `viewerMaintainedRepoIds` is a UNION of the permission set and "has landed a PR on the
//      default branch"; swapping one for the other type-checks perfectly, and without this repo
//      in the fixture the whole suite would still pass with the wrong set in place.
//   3. ⚠ THE PREDICATE IS AN `||` OVER TWO NULLABLE COLUMNS. `merge_state_status = 'dirty'` and
//      `mergeable = 'conflicting'` agree on all 474 real rows, so a fixture built from real-shaped
//      data passes with an `&&` in place. Only rows that set exactly ONE of the two catch it —
//      and NULL in either column means NOT OBSERVED, never "merges fine".
//   4. CONFLICTS OUTRANK 'behind'. GitHub's own `canUpdateBranch` is "behind AND NOT conflicting",
//      so an Update-branch card on a conflicting PR offers a button GitHub refuses — and two cards
//      for one PR besides.
//   5. THE CARD HAS NO CLOCK AND NO BUTTON. `detail` is code-written and TIME-FREE ("Conflicts
//      with main"), degrading to "the base branch" rather than inventing one when `baseRefName`
//      was never synced.
//   6. THE CAP IS RELEVANCE-FIRST. It is applied before anything else sees these rows, so age
//      alone as the sort would let fifteen strangers' branches bury the viewer's own PR.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConflictsCard, InsightCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-conflicts-cards-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let scope: any;
let capScope: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write.
const now = Math.floor(Date.now() / 1000) * 1000;

// The per-kind cap in getWorkspaceInsights. Not exported (nothing outside that file reads it), so
// it is spelled here — a change to the constant is meant to fail this file loudly.
const INSIGHT_CARD_CAP = 15;
const CAP_PRS = 20;

const VIEWER_LOGIN = 'viewer-me';

const repoIdByKey = new Map<string, number>();
const prIdByKey = new Map<string, number>();
let viewerId = 0;
let aliceId = 0;
let bobId = 0;

const pr = (key: string): number => prIdByKey.get(key)!;

/** Every conflicts card the board would paint right now, in the given workspace scope. */
async function conflictCards(s: any = scope): Promise<ConflictsCard[]> {
  const insights = await q.getWorkspaceInsights(1, undefined, s);
  return (insights.cards as InsightCard[]).filter(
    (c): c is ConflictsCard => c.kind === 'conflicts',
  );
}

/** Every card of every kind, so the negative controls can say "no card of ANY kind names this PR"
 *  rather than only "no conflicts card". */
async function allCards(s: any = scope): Promise<InsightCard[]> {
  const insights = await q.getWorkspaceInsights(1, undefined, s);
  return insights.cards as InsightCard[];
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

  const { accounts, events, repos, pullRequests, reviews, users } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId return
  // null — every `relevance: 'direct'` assertion would then collapse to 'maintained' and the
  // severity split would be vacuous.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  aliceId = await insertUser('alice-dev');
  bobId = await insertUser('bob-dev');

  const insertRepo = async (key: string, values: Record<string, unknown>): Promise<number> => {
    const [row] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: key,
        githubNodeId: `R_cf_${key}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        // ⚠ `createdAt: now` puts every seeded PR BEFORE the repo's My Turn "New PRs" cutoff (the
        // documented per-repo rule), so no incidental `my_turn` card crowds the board.
        createdAt: new Date(now),
        ...values,
      })
      .returning()
      .execute();
    repoIdByKey.set(key, row.id);
    return row.id;
  };

  let n = 1;
  let ev = 1;
  const insertPr = async (
    repoId: number,
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_cf_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId: aliceId,
        baseRefName: 'main',
        // ⚠ TWO HOURS OLD. INSIGHT_ROUTING_MIN_AGE_HOURS is 4, so no fixture PR is ever a
        // `reviewer_routing` orphan — which is what keeps getWorkspaceInsights off the CODEOWNERS
        // network path from a unit test.
        openedAt: new Date(now - 2 * HOUR),
        updatedAt: new Date(now - HOUR),
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, row.id);
    return row.id;
  };
  // getWorkspaceInsights' open-PR population requires a real ACTIVITY EVENT inside the 90-day
  // ultra-stale window — `pullRequests.updatedAt` is deliberately not trusted there. An open PR
  // with no event is invisible to the whole fold, this block included.
  const touch = async (repoId: number, prId: number): Promise<void> => {
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId,
        actorId: aliceId,
        type: 'commit_pushed',
        occurredAt: new Date(now - HOUR),
        dedupeKey: `cf_ev_${ev++}`,
      })
      .execute();
  };
  const conflictingPr = async (
    repoId: number,
    key: string,
    values: Record<string, unknown> = {},
  ): Promise<number> => {
    const id = await insertPr(repoId, key, {
      mergeStateStatus: 'dirty',
      mergeable: 'conflicting',
      ...values,
    });
    await touch(repoId, id);
    return id;
  };

  // ── the three WRITE-ish permissions, one repo each ────────────────────────────────────────
  // ⚠ MAINTAIN and ADMIN are here to pin the SET (`WRITE_PERMISSIONS`), not a `=== 'WRITE'` test.
  const write = await insertRepo('write', { viewerPermission: 'WRITE' });
  const maintain = await insertRepo('maintain', { viewerPermission: 'MAINTAIN' });
  const admin = await insertRepo('admin', { viewerPermission: 'ADMIN' });

  // Somebody else's conflicting PR in a repo the viewer can push to: real, but not their turn.
  await conflictingPr(write, 'w-theirs');
  // The viewer's OWN conflicting PR — their code, their rebase.
  await conflictingPr(write, 'w-mine', { authorId: viewerId });
  // ⚠ ONE COLUMN EACH, and this pair is the whole reason the predicate is an `||` in JS rather
  // than an `&&`, or SQL. On real data the two columns never disagree, so nothing else notices.
  // `w-mergeable-only` ALSO carries a NULL baseRefName, which is the other degradation this file
  // pins: a row synced before the column existed says "the base branch", never "null".
  await conflictingPr(write, 'w-mergeable-only', {
    mergeStateStatus: null,
    mergeable: 'conflicting',
    baseRefName: null,
  });
  await conflictingPr(write, 'w-dirty-only', { mergeStateStatus: 'dirty', mergeable: null });
  // BEHIND *and* conflicting — the precedence guard. GitHub refuses an update-branch on this PR.
  await conflictingPr(write, 'w-behind', { mergeStateStatus: 'behind', mergeable: 'conflicting' });
  // NEGATIVE: a conflicting DRAFT. 72 exist on real data and none of them is anybody's turn.
  await conflictingPr(write, 'w-draft', { isDraft: true });
  // NEGATIVE CONTROLS: a PR GitHub will take, and one protection is blocking. Neither conflicts.
  await conflictingPr(write, 'w-clean', { mergeStateStatus: 'clean', mergeable: 'mergeable' });
  await conflictingPr(write, 'w-blocked', { mergeStateStatus: 'blocked', mergeable: 'mergeable' });
  // The review that proves the card carries the standings fold like every other PR-bearing kind.
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_cf_theirs',
      prId: pr('w-theirs'),
      authorId: bobId,
      state: 'changes_requested',
      submittedAt: new Date(now - HOUR),
    })
    .execute();

  await conflictingPr(maintain, 'm-conflicting');
  await conflictingPr(admin, 'a-conflicting');

  // ── repo 'readonly': the plain negative. The viewer READS it and nothing more ──────────────
  const readonly = await insertRepo('readonly', { viewerPermission: 'READ' });
  await conflictingPr(readonly, 'r-conflicting');

  // ── repo 'merged-read': ⚠ THE MUTATION TEST. READ permission, but the viewer has LANDED a PR
  //    on its default branch — so it IS in `viewerMaintainedRepoIds` and is NOT in
  //    `writableRepoIds`. Swap one set for the other and only this repo notices.
  const mergedRead = await insertRepo('merged-read', { viewerPermission: 'READ' });
  await insertPr(mergedRead, 'mr-landed', {
    state: 'merged',
    mergedById: viewerId,
    mergedAt: new Date(now - 3 * DAY),
  });
  await conflictingPr(mergedRead, 'mr-conflicting');

  // ── the CAP workspace: 20 conflicting PRs in one writable repo ────────────────────────────
  // Its own workspace because 20 rows in Default would crowd every assertion above, and because
  // the cap has to be measured against a population that genuinely exceeds it.
  const capRepo = await insertRepo('cap', { viewerPermission: 'WRITE' });
  for (let i = 0; i < CAP_PRS; i++) {
    // ⚠ THE VIEWER'S OWN PR IS THE OLDEST. Sorting by age alone would cap it out; only the
    // relevance-first sort keeps it. Every other row is newer AND somebody else's.
    const mine = i === 0;
    await conflictingPr(capRepo, `cap${i}`, {
      authorId: mine ? viewerId : aliceId,
      lastCommitAt: new Date(now - (mine ? CAP_PRS + 1 : CAP_PRS - i) * HOUR),
    });
  }

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and every count is 0 and the fixture asserts nothing.
  // (Assignment is a MOVE: `cap` LEAVES Default.)
  const capWs = await q.createWorkspace(1, 'Cap');
  await q.assignReposToWorkspace(capWs.id, 1, [capRepo]);
  scope = await q.resolveWorkspaceScope(1, null);
  capScope = await q.resolveWorkspaceScope(1, capWs.id);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the fixture really is split the way the assertions assume', () => {
  it('keeps the cap repo out of Default', () => {
    expect([...scope.repoIds].sort()).toEqual(
      [
        repoIdByKey.get('write'),
        repoIdByKey.get('maintain'),
        repoIdByKey.get('admin'),
        repoIdByKey.get('readonly'),
        repoIdByKey.get('merged-read'),
      ].sort(),
    );
    expect(capScope.repoIds).toEqual([repoIdByKey.get('cap')]);
  });
});

describe('conflicts cards', () => {
  it('emits exactly the conflicting PRs in repos the viewer can push to', async () => {
    const cards = await conflictCards();
    expect(cards.map((c) => c.id).sort()).toEqual(
      [
        `conflicts:${pr('w-theirs')}`,
        `conflicts:${pr('w-mine')}`,
        `conflicts:${pr('w-mergeable-only')}`,
        `conflicts:${pr('w-dirty-only')}`,
        `conflicts:${pr('w-behind')}`,
        `conflicts:${pr('m-conflicting')}`,
        `conflicts:${pr('a-conflicting')}`,
      ].sort(),
    );
    for (const c of cards) expect(c.kind).toBe('conflicts');
  });

  it('MAINTAIN and ADMIN both emit — the gate is the SET, not `=== "WRITE"`', async () => {
    const repoIds = new Set((await conflictCards()).map((c) => c.repoId));
    expect(repoIds.has(repoIdByKey.get('maintain')!)).toBe(true);
    expect(repoIds.has(repoIdByKey.get('admin')!)).toBe(true);
  });

  it('⚠ says NOTHING about a conflicting PR in a repo the viewer only reads', async () => {
    // The gate the whole feature rests on: 470 of 474 real conflicting PRs are exactly this row.
    const cards = await allCards();
    expect(cards.some((c) => 'prId' in c && c.prId === pr('r-conflicting'))).toBe(false);
  });

  it('⚠ says NOTHING in a READ repo the viewer has MERGED into either', async () => {
    // THE MUTATION TEST. `viewerMaintainedRepoIds` = WRITE_PERMISSIONS ∪ "has landed a PR on the
    // default branch". This repo is in the second half and not the first, so it is the only
    // fixture that can tell the two sets apart — delete it and swapping them passes the suite.
    // The proof that it really is "maintained" is the merge below, not a claim.
    const maintained = await q.viewerMaintainedRepoIds(1, viewerId);
    expect(maintained.has(repoIdByKey.get('merged-read')!)).toBe(true);

    const cards = await allCards();
    expect(cards.some((c) => 'prId' in c && c.prId === pr('mr-conflicting'))).toBe(false);
  });

  it('⚠ emits on EITHER column alone — NULL is "not observed", never "merges fine"', async () => {
    // The `||`. These two rows are the only thing standing between the fold and an `&&`, because
    // `merge_state_status = 'dirty'` and `mergeable = 'conflicting'` agree on every real row.
    const byId = new Map((await conflictCards()).map((c) => [c.prId, c]));
    const mergeableOnly = byId.get(pr('w-mergeable-only'));
    expect(mergeableOnly?.mergeStateStatus).toBeNull();
    expect(mergeableOnly?.mergeable).toBe('conflicting');
    const dirtyOnly = byId.get(pr('w-dirty-only'));
    expect(dirtyOnly?.mergeStateStatus).toBe('dirty');
    expect(dirtyOnly?.mergeable).toBeNull();
  });

  it('⚠ takes precedence over `behind`: one card for the PR, and no update_branch', async () => {
    // GitHub's `canUpdateBranch` is "behind AND NOT conflicting", so an Update-branch card here
    // would offer a button GitHub refuses — and the PR would be on the board twice.
    const cards = await allCards();
    const forPr = cards.filter((c) => 'prId' in c && c.prId === pr('w-behind'));
    expect(forPr.map((c) => c.kind)).toEqual(['conflicts']);
  });

  it('leaves a conflicting DRAFT alone', async () => {
    const cards = await allCards();
    expect(cards.some((c) => 'prId' in c && c.prId === pr('w-draft'))).toBe(false);
  });

  it('the negative controls: a clean PR is a merge card, a blocked one is neither', async () => {
    const cards = await allCards();
    const kindsFor = (key: string): string[] =>
      cards.filter((c) => 'prId' in c && c.prId === pr(key)).map((c) => c.kind);
    expect(kindsFor('w-clean')).toEqual(['merge']);
    expect(kindsFor('w-blocked')).toEqual([]);
  });

  it('splits severity on AUTHORSHIP, and never claims `none`', async () => {
    const byId = new Map((await conflictCards()).map((c) => [c.prId, c]));
    // Your code, your rebase.
    expect(byId.get(pr('w-mine'))?.relevance).toBe('direct');
    expect(byId.get(pr('w-mine'))?.severity).toBe('high');
    // Somebody else's, in a repo you can push to: real, but not your turn.
    expect(byId.get(pr('w-theirs'))?.relevance).toBe('maintained');
    expect(byId.get(pr('w-theirs'))?.severity).toBe('warn');
    // ⚠ `writableRepoIds ⊆ viewerMaintainedRepoIds` by construction, so 'none' is unreachable
    // here — a card carrying it would mean the two sets had come apart.
    expect((await conflictCards()).every((c) => c.relevance !== 'none')).toBe(true);
  });

  it('names the base branch, and degrades rather than inventing one', async () => {
    const byId = new Map((await conflictCards()).map((c) => [c.prId, c]));
    expect(byId.get(pr('w-theirs'))?.detail).toBe('Conflicts with main');
    // A row synced before `base_ref_name` existed. "Conflicts with null" is the failure this
    // fallback exists for.
    expect(byId.get(pr('w-mergeable-only'))?.detail).toBe('Conflicts with the base branch');
  });

  it('carries the full PR reference, including the review standing', async () => {
    const card = (await conflictCards()).find((c) => c.prId === pr('w-theirs'))!;
    expect(card.openedAt).toBe(new Date(now - 2 * HOUR).toISOString());
    expect(card.repoFullName).toBe('acme/write');
    expect(card.authorId).toBe(aliceId);
    expect(card.authorIsBot).toBe(false);
    expect(card.githubUrl).toContain('/pull/');
    // Folded from the ONE standings map every PR-bearing kind reads — not a second query that
    // could answer "nobody has reviewed this" on a PR somebody is blocking.
    expect(card.reviewerCount).toBe(1);
    expect(card.reviewChangesRequested).toBe(true);
    expect(card.reviewers.map((r) => [r.userId, r.standing])).toEqual([
      [bobId, 'changes_requested'],
    ]);
    // ⚠ NO BUTTON AND NO CLOCK. Both absences are decisions (see the type's doc block); a card
    // that grew either would be claiming something the data does not hold.
    expect(card).not.toHaveProperty('viewerCanPush');
    expect(card).not.toHaveProperty('lastCommitAt');
  });

  it('caps at 15, relevance-first — the viewer’s own PR is never the one dropped', async () => {
    const cards = await conflictCards(capScope);
    expect(cards).toHaveLength(INSIGHT_CARD_CAP);
    // It is the OLDEST of the twenty. Age alone as the sort would have capped it out.
    expect(cards.some((c) => c.prId === pr('cap0'))).toBe(true);
    expect(cards.find((c) => c.prId === pr('cap0'))?.relevance).toBe('direct');
    // ⚠ THE CAP IS SILENT — no `conflictsTotal` on the response, because the strip counts what is
    // WAITING ON YOU and a stranger's stuck branch is not that. An added total would have to
    // travel on DailyBriefCounts and drag this kind into the brief's allow-list.
    const insights = await q.getWorkspaceInsights(1, undefined, capScope);
    expect(insights).not.toHaveProperty('conflictsTotal');
  });
});
