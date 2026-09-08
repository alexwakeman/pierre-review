// WHO REVIEWED IT, AND WHERE THEY STAND — the reviewer half of the approval fold, on a THROWAWAY
// sqlite DB (the triage-merge-verdict.test.ts pattern).
//
// `computeReviewStandingsByPr` keeps the per-reviewer detail its predecessor computed and threw
// away, and `computeApprovalInfoByPr` is now a projection of it. That refactor is only safe if two
// things hold, and both are fixtures here rather than comments:
//
//   1. ⚠ THE COUNTS DO NOT MOVE. `approvals` is hashed into stored Pro work plans
//      (db/work-plan.ts → payloadHashFor). A count that shifts by one flips every stored plan on
//      an affected workspace permanently `stale` and re-bills it, with nothing on screen saying
//      why. So the first block below re-implements the OLD rule verbatim and asserts the new fold
//      agrees with it on every fixture PR — an equivalence test, not a spot check.
//   2. ⚠ THE TWO HALVES CANNOT DISAGREE. The chips ("alice · approved") and the number beside
//      them ("approved by 2") are one array folded twice, never two scans. A cap or a
//      bot-collapse applied inside the fold would move the count silently; both belong to the
//      caller, and the fold returns the FULL list to make that the only option.
//
// The rule itself is three tiers: latest VERDICT (approved / changes_requested) if the reviewer
// ever filed one, else latest dismissal, else latest comment. Tier beats clock, which is what
// makes it a strict superset of the old rule — and is also where it deliberately parts company
// with ChecksTab's "latest non-pending wins" (59 disagreeing reviewer-PR pairs on this repo's real
// open PRs) and with a dismissed approval (2 pairs). Both are pinned below.
//
//   cd apps/backend && ./node_modules/.bin/vitest run src/db/triage-reviewers.test.ts
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-triage-reviewers-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let computeReviewStandingsByPr: any;
let computeApprovalInfoByPr: any;
let approvalInfoFromStandings: any;

const DAY = 24 * 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write and a "later" review could land on the same tick as its predecessor.
const now = Math.floor(Date.now() / 1000) * 1000;

const prIdByKey = new Map<string, number>();
const userIdByLogin = new Map<string, number>();

/** One review, written as it reads: who, what, and how many days ago. */
type Spec = [login: string | null, state: string, daysAgo: number];

/** Every fixture PR, as its reviews. The key names the shape being pinned, not the data. */
const FIXTURES: Record<string, Spec[]> = {
  // Two people approve. The plain case the equivalence test needs a positive control for.
  'two-approvals': [
    ['alice', 'approved', 3],
    ['bob', 'approved', 2],
  ],
  // One block outranks any number of approvals — `approved` is false, `approvals` is still 1.
  'block-wins': [
    ['alice', 'approved', 3],
    ['bob', 'changes_requested', 2],
  ],
  // The same reviewer twice: only the later verdict stands, and they are ONE chip, not two.
  'author-changed-their-mind': [
    ['alice', 'changes_requested', 4],
    ['alice', 'approved', 1],
  ],
  // …and the other direction, so the test cannot pass by always preferring `approved`.
  'author-withdrew-approval': [
    ['alice', 'approved', 4],
    ['alice', 'changes_requested', 1],
  ],
  // Nobody filed a verdict. The reviewer the old fold dropped entirely; she must appear.
  'comments-only': [
    ['carol', 'commented', 3],
    ['carol', 'commented', 1],
  ],
  // ⚠ THE 59. A verdict followed by a bare comment: tier beats clock, so the standing stays
  // `approved`. ChecksTab's "latest non-pending wins" reads this as `commented` and loses the
  // approval — 59 reviewer-PR pairs on this repo's live open PRs.
  'approval-then-comment': [
    ['alice', 'approved', 4],
    ['alice', 'commented', 1],
  ],
  // A dismissal with no verdict behind it: a real standing, and it counts for nothing.
  'dismissed-only': [['dave', 'dismissed', 2]],
  // ⚠ THE KNOWN DIVERGENCE, PINNED AS-IS. A revoked approval (GitHub files a fresh review node
  // whose state is DISMISSED) still reads `approved`, because demoting it would also drop the
  // approval and move the hashed count. 2 such pairs exist in this repo's real data, 1 on an open
  // PR. Changing this is a decision with a re-billing cost, not a patch — see the tier table in
  // triage.ts.
  'approval-then-dismissal': [
    ['alice', 'approved', 4],
    ['alice', 'dismissed', 1],
  ],
  // A dismissal then a drive-by comment: `dismissed` outranks `commented`, so a reviewer who was
  // dismissed does not read as though they had merely chatted.
  'dismissal-then-comment': [
    ['dave', 'dismissed', 4],
    ['dave', 'commented', 1],
  ],
  // ⚠ A draft review that was never submitted is not a review. Naming the reviewer here would
  // put someone on the card who has not spoken.
  'pending-only': [['erin', 'pending', 2]],
  // ⚠ A deleted GitHub account. Unnameable, and the OLD fold counted it (its key was the string
  // `${prId}:null`), so it is still counted and still one slot — zero such rows exist today,
  // which is exactly why dropping them would look safe.
  ghost: [
    [null, 'approved', 3],
    ['alice', 'approved', 2],
  ],
  // A busy PR, for ordering and `total`.
  crowded: [
    ['alice', 'approved', 5],
    ['bob', 'changes_requested', 4],
    ['carol', 'commented', 3],
    ['dave', 'dismissed', 2],
  ],
};

const prId = (key: string): number => prIdByKey.get(key)!;
const uid = (login: string): number => userIdByLogin.get(login)!;

/** The standings of one fixture PR as `login → standing`, so an assertion reads as the card. */
async function standingsOf(key: string): Promise<Record<string, string>> {
  const map = await computeReviewStandingsByPr([prId(key)]);
  const s = map.get(prId(key));
  if (!s) return {};
  const loginById = new Map([...userIdByLogin].map(([l, id]) => [id, l]));
  const out: Record<string, string> = {};
  for (const r of s.reviewers) out[r.userId == null ? '(ghost)' : loginById.get(r.userId)!] = r.standing;
  return out;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ({ computeReviewStandingsByPr, computeApprovalInfoByPr, approvalInfoFromStandings } =
    await import('./triage.js'));

  const { repos, pullRequests, users, reviews } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_reviewers' })
    .returning()
    .execute();

  for (const login of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    userIdByLogin.set(login, u.id);
  }

  let n = 1;
  let rv = 1;
  for (const [key, specs] of Object.entries(FIXTURES)) {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_rv_${key}`,
        accountId: 1,
        repoId: repo.id,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - 10 * DAY),
        updatedAt: new Date(now - DAY),
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
    for (const [login, state, daysAgo] of specs) {
      await db
        .insert(reviews)
        .values({
          githubNodeId: `RV_${rv++}`,
          prId: pr.id,
          authorId: login == null ? null : uid(login),
          state,
          body: null,
          submittedAt: new Date(now - daysAgo * DAY),
        })
        .execute();
    }
  }
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the approval counts do not move', () => {
  it('⚠ agrees with the OLD rule on every fixture PR', async () => {
    // The predecessor, transcribed verbatim from the fold this replaced: the latest row per
    // (pr, author) whose state is `approved` or `changes_requested`, every other row skipped.
    // If this ever disagrees, stored work-plan payload hashes have moved.
    const { reviews } = schema;
    const { inArray } = await import('drizzle-orm');
    const ids = [...prIdByKey.values()];
    const rows = await db
      .select({
        prId: reviews.prId,
        authorId: reviews.authorId,
        state: reviews.state,
        submittedAt: reviews.submittedAt,
      })
      .from(reviews)
      .where(inArray(reviews.prId, ids))
      .execute();

    const latest = new Map<string, { prId: number; state: string; at: Date }>();
    for (const r of rows) {
      if (r.state !== 'approved' && r.state !== 'changes_requested') continue;
      const key = `${r.prId}:${r.authorId}`;
      const prev = latest.get(key);
      if (!prev || r.submittedAt.getTime() > prev.at.getTime()) {
        latest.set(key, { prId: r.prId, state: r.state, at: r.submittedAt });
      }
    }
    const old = new Map<number, unknown>();
    const byPr = new Map<number, { approvals: number; blocks: number; latestApprovalAt: Date | null }>();
    for (const v of latest.values()) {
      const e = byPr.get(v.prId) ?? { approvals: 0, blocks: 0, latestApprovalAt: null };
      if (v.state === 'approved') {
        e.approvals += 1;
        if (!e.latestApprovalAt || v.at.getTime() > e.latestApprovalAt.getTime()) e.latestApprovalAt = v.at;
      } else e.blocks += 1;
      byPr.set(v.prId, e);
    }
    for (const [id, e] of byPr) {
      old.set(id, {
        approved: e.approvals > 0 && e.blocks === 0,
        changesRequested: e.blocks > 0,
        approvals: e.approvals,
        latestApprovalAt: e.latestApprovalAt,
      });
    }

    const fresh = await computeApprovalInfoByPr(ids);
    // ⚠ The EMISSION SET too, not just the values: the old fold produced no entry at all for a PR
    // whose only reviews were comments, and every caller reads `.get(id)?.x ?? default`.
    expect([...fresh.keys()].sort()).toEqual([...old.keys()].sort());
    for (const id of old.keys()) expect(fresh.get(id)).toEqual(old.get(id));
  });

  it('a commenter-only reviewer is named but changes no count', async () => {
    // She appears on the card…
    expect(await standingsOf('comments-only')).toEqual({ carol: 'commented' });
    // …and the PR still has no approval standing at all — not a zeroed entry, no entry.
    const fresh = await computeApprovalInfoByPr([prId('comments-only')]);
    expect(fresh.has(prId('comments-only'))).toBe(false);
  });

  it('the counts are folded from the reviewer list, not computed beside it', async () => {
    // The guarantee that the chips and the number cannot disagree: one array, folded once.
    const ids = [...prIdByKey.values()];
    const standings = await computeReviewStandingsByPr(ids);
    const fresh = await computeApprovalInfoByPr(ids);
    for (const [id, s] of standings) {
      const derived = approvalInfoFromStandings(s);
      const named = s.reviewers.filter((r: any) => r.standing === 'approved').length;
      expect(derived.approvals).toBe(named);
      if (fresh.has(id)) expect(fresh.get(id)).toEqual(derived);
    }
  });
});

describe('a reviewer stands where their latest verdict left them', () => {
  it('counts each reviewer once, however many reviews they filed', async () => {
    expect(await standingsOf('author-changed-their-mind')).toEqual({ alice: 'approved' });
    const info = (await computeApprovalInfoByPr([prId('author-changed-their-mind')])).get(
      prId('author-changed-their-mind'),
    );
    expect(info.approvals).toBe(1);
    expect(info.approved).toBe(true);
  });

  it('…and the later verdict is the one that stands, in both directions', async () => {
    expect(await standingsOf('author-withdrew-approval')).toEqual({ alice: 'changes_requested' });
    const info = (await computeApprovalInfoByPr([prId('author-withdrew-approval')])).get(
      prId('author-withdrew-approval'),
    );
    expect(info.approvals).toBe(0);
    expect(info.changesRequested).toBe(true);
  });

  it('one blocking reviewer outranks an approval without erasing it', async () => {
    expect(await standingsOf('block-wins')).toEqual({ alice: 'approved', bob: 'changes_requested' });
    const info = (await computeApprovalInfoByPr([prId('block-wins')])).get(prId('block-wins'));
    expect(info).toMatchObject({ approved: false, changesRequested: true, approvals: 1 });
  });

  it('⚠ a later bare comment does NOT withdraw a verdict', async () => {
    // Where this fold and ChecksTab part company — 59 reviewer-PR pairs on live open PRs. Reading
    // the comment as the standing would drop a real approval off the card and out of the count.
    expect(await standingsOf('approval-then-comment')).toEqual({ alice: 'approved' });
    expect(
      (await computeApprovalInfoByPr([prId('approval-then-comment')])).get(prId('approval-then-comment'))
        .approvals,
    ).toBe(1);
  });
});

describe('a dismissal is a standing, and it is not an approval', () => {
  it('is named on the card and counts for nothing', async () => {
    expect(await standingsOf('dismissed-only')).toEqual({ dave: 'dismissed' });
    expect((await computeApprovalInfoByPr([prId('dismissed-only')])).has(prId('dismissed-only'))).toBe(
      false,
    );
  });

  it('outranks a later comment', async () => {
    expect(await standingsOf('dismissal-then-comment')).toEqual({ dave: 'dismissed' });
  });

  it('⚠ but a dismissed APPROVAL still reads approved — the known divergence, pinned', async () => {
    // Honest would be `dismissed`. Honest would also drop the approval and move a hashed count on
    // 1 live open PR (sourcery-ai) plus 1 merged one. Flip the tier of `dismissed` to 0 in
    // triage.ts to change it, knowing every stored plan on an affected workspace re-bills.
    expect(await standingsOf('approval-then-dismissal')).toEqual({ alice: 'approved' });
    expect(
      (await computeApprovalInfoByPr([prId('approval-then-dismissal')])).get(
        prId('approval-then-dismissal'),
      ).approvals,
    ).toBe(1);
  });
});

describe('what the fold refuses to name, and what it hands the caller', () => {
  it('says nothing about a reviewer whose only review was never submitted', async () => {
    const map = await computeReviewStandingsByPr([prId('pending-only')]);
    expect(map.has(prId('pending-only'))).toBe(false);
  });

  it('⚠ counts a deleted account it cannot name', async () => {
    // One unnameable slot, still counted — the old key collapsed every null author on a PR into
    // one entry and let its verdict count. The caller drops it from the chips; the number stays
    // honest.
    expect(await standingsOf('ghost')).toEqual({ '(ghost)': 'approved', alice: 'approved' });
    expect((await computeApprovalInfoByPr([prId('ghost')])).get(prId('ghost')).approvals).toBe(2);
  });

  it('returns the FULL list newest-first with its own total, and caps nothing', async () => {
    // Capping and bot-collapsing are the caller's; a cap here would move the count.
    const s = (await computeReviewStandingsByPr([prId('crowded')])).get(prId('crowded'));
    expect(s.total).toBe(4);
    expect(s.reviewers.length).toBe(s.total);
    expect(s.reviewers.map((r: any) => r.userId)).toEqual([uid('dave'), uid('carol'), uid('bob'), uid('alice')]);
    // ⚠ Ids only. Nothing here resolves bot-ness: there is ONE resolution in this app (a manual
    // workspace judgement, then users.isBot, then the login seed) and the payload builder reuses
    // it. A second classifier that could disagree with the Timeline is the defect.
    expect(Object.keys(s.reviewers[0])).toEqual(['userId', 'standing', 'standingAt']);
  });

  it('dates each standing by the review that set it, not by later chatter', async () => {
    const s = (await computeReviewStandingsByPr([prId('approval-then-comment')])).get(
      prId('approval-then-comment'),
    );
    // The approval is four days old. Stamping it with the one-day-old comment would print
    // "approved · 1d ago" over a four-day-old approval.
    expect(s.reviewers[0].standingAt.getTime()).toBe(now - 4 * DAY);
  });

  it('is empty and cheap on an empty id list', async () => {
    expect((await computeReviewStandingsByPr([])).size).toBe(0);
  });
});
