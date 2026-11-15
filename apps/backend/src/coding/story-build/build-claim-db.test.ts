// THE BUILD CLAIM ON A REAL LEDGER (story_build_claim_lines over a scratch SQLite), GitHub faked: the ticket
// branch per repository, its commits and their `ensemble/build` lines. Pinned:
//   TAKE       the ledger row BEFORE the placeholder and the line; a placeholder at the default branch plus one
//              empty commit; the pending line; CLAIM-THEN-REREAD — an earlier live claim found after posting
//              wins, ours stands down (a free line, our placeholder deleted); a teammate's LAPSED claim is
//              released once ("Cleared by me: robin's claim expired") and its free placeholder REPLACED by a
//              fast-forward; a real branch is never touched; no login / unreadable ⇒ unmarked.
//   FOLLOW     a push of ours moves the claim to the pushed commit and posts the pending line there.
//   PUSH       `placeholderReplaceable`: ours yes; a free or lapsed placeholder yes; a teammate's live one no;
//              a commit without the trailer no.
//   CLEAR      refused on a teammate's live claim; frees a lapsed one and the reader's own from elsewhere.
//   RECONCILE  renew while the session is live; settle when it closed (paused), was discarded, or pushed
//              ("built … · pull request opened"); a newer line by someone else ⇒ closed, nothing posted; the
//              review loop's lines released once the loop is idle; a Resume claims again.
//   THE LOOP'S REVIEW LINES  pending "is reviewing with Claude", then "reviewed · kept in Ensemble"; a
//              teammate's newer line is never overwritten.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-build-claim-${process.pid}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let C: typeof import('./build-claim.js');
let F: typeof import('./build-claim-flow.js');
let R: typeof import('./build-claim-release.js');
let L: typeof import('./build-claim-ledger.js');
let RL: typeof import('./loop/review-lines.js');
let P: typeof import('./persist.js');
let eq: any;
let wsId = 0;
const A = 1;
const MIN = 60_000;
const IDENT = 'jira:https://acme.atlassian.net#PAY-142';
const KEY = 'PAY-142';

// ---- the fake GitHub ----
interface Commit {
  sha: string;
  message: string;
  tree: string;
  parent: string | null;
}
let now = 10_000_000_000;
let refs: Map<string, string>; // `${repo}:${branch}` → sha
let commits: Map<string, Commit>;
let lines: Array<{ id: number; repo: string; sha: string; context: string; state: string; description: string; createdAtMs: number; login: string }>;
let posted: Array<{ repo: string; sha: string; state: string; description: string; context: string }>;
let deleted: string[];
let nextId = 1;
let me: string | null = 'me';
let readFails = false;
let onFirstPending: (() => void) | null = null;
const canPush = new Set<string>(['api', 'web']);

const fake = {
  async login() {
    return me;
  },
  async listLines(_a: number, _o: string, name: string, sha: string, context: string) {
    return lines.filter((l) => l.repo === name && l.sha === sha && l.context.split('/')[1] === context.split('/')[1]).map((l) => ({ ...l }));
  },
  async postLine(_a: number, _o: string, name: string, sha: string, context: string, post: any) {
    posted.push({ repo: name, sha, state: post.state, description: post.description, context });
    lines.push({ id: nextId++, repo: name, sha, context, state: post.state, description: post.description, createdAtMs: now, login: me ?? 'me' });
    if (post.state === 'pending' && onFirstPending) {
      const f = onFirstPending;
      onFirstPending = null;
      f();
    }
  },
  async readTicketBranch(_a: number, repos: Array<{ owner: string; name: string }>, branch: string) {
    if (readFails) throw new Error('GitHub is down');
    return repos.map((r) => {
      const sha = refs.get(`${r.name}:${branch}`) ?? null;
      const c = sha ? commits.get(sha)! : null;
      return {
        owner: r.owner,
        name: r.name,
        canPush: canPush.has(r.name),
        defaultBranch: { name: 'main', oid: `${r.name}-main`, treeOid: `${r.name}-tree` },
        head: c ? { oid: c.sha, message: c.message, treeOid: c.tree } : null,
      };
    });
  },
  async createPlaceholder(_a: number, _o: string, name: string, branch: string, c: any, replaceOid: string | null) {
    const sha = `ph${nextId++}`;
    commits.set(sha, { sha, message: c.message, tree: c.treeOid, parent: c.parentOid });
    const key = `${name}:${branch}`;
    const live = refs.get(key) ?? null;
    if (replaceOid == null ? live != null : live !== replaceOid) throw Object.assign(new Error('taken'), { code: 'REF_TAKEN' });
    refs.set(key, sha);
    return sha;
  },
  async deletePlaceholder(_a: number, _o: string, name: string, branch: string, sha: string) {
    const key = `${name}:${branch}`;
    if (refs.get(key) !== sha || !C.isPlaceholderMessage(commits.get(sha)?.message)) return false;
    refs.delete(key);
    deleted.push(`${name}@${sha}`);
    return true;
  },
  async commitMessage(_a: number, _o: string, _n: string, sha: string) {
    return commits.get(sha)?.message ?? null;
  },
};
const teammateLine = (repo: string, sha: string, login: string, state: string, description: string, agoMs: number): void => {
  lines.push({ id: nextId++, repo, sha, context: 'ensemble/build', state, description, createdAtMs: now - agoMs, login });
};
const placeholderOf = (repo: string, sha: string, login: string): void => {
  commits.set(sha, { sha, message: C.placeholderMessage(login, KEY), tree: `${repo}-tree`, parent: `${repo}-main` });
  refs.set(`${repo}:${KEY}`, sha);
};
const repos = [
  { owner: 'acme', name: 'api' },
  { owner: 'acme', name: 'web' },
];
const target = (buildId: number) => ({ accountId: A, workspaceId: wsId, ident: IDENT, ticketKey: KEY, repos, buildId });
const log = { info: () => {}, warn: () => {} };
let live = new Set<number>();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: A, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  wsId = await ensureDefaultWorkspace(A);
  ({ eq } = await import('drizzle-orm'));
  C = await import('./build-claim.js');
  F = await import('./build-claim-flow.js');
  R = await import('./build-claim-release.js');
  L = await import('./build-claim-ledger.js');
  RL = await import('./loop/review-lines.js');
  P = await import('./persist.js');
});

afterAll(async () => {
  F.setBuildClaimSeamsForTest(null);
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

let buildSeq = 0;
async function newBuild(): Promise<number> {
  buildSeq += 1;
  const r = await P.insertStoryBuild({ db, schema } as any, {
    accountId: A,
    workspaceId: wsId,
    ident: `${IDENT}-${buildSeq}`,
    ticketKey: KEY,
    ticketTitle: 'Refunds',
    wantDiagram: false,
    wantDocs: false,
    provider: 'claude',
    model: null,
    session: { effort: null, lastActiveAt: new Date() },
  } as any);
  return r.id;
}

beforeEach(async () => {
  refs = new Map();
  commits = new Map();
  lines = [];
  posted = [];
  deleted = [];
  me = 'me';
  readFails = false;
  onFirstPending = null;
  live = new Set();
  await db.delete(schema.storyBuildClaimLines).execute();
  F.setBuildClaimSeamsForTest({ gh: fake as any, nowMs: () => now, liveBuild: (id) => live.has(id) });
  R._resetBuildClaimReleaseForTest();
});

const rows = async () => (await db.select().from(schema.storyBuildClaimLines).execute()) as any[];

describe('take', () => {
  it('writes the ledger, a placeholder at the default branch + one empty commit, and the pending line', async () => {
    const b = await newBuild();
    const r = await F.takeTicketClaim(target(b), log);
    expect(r.kind).toBe('held');
    if (r.kind !== 'held') return;
    expect(r.name).toBe('api'); // the first pushable repository by name
    const c = commits.get(r.sha)!;
    expect(c).toMatchObject({ tree: 'api-tree', parent: 'api-main' });
    expect(C.isPlaceholderMessage(c.message)).toBe(true);
    expect(refs.get(`api:${KEY}`)).toBe(r.sha);
    expect(posted).toEqual([{ repo: 'api', sha: r.sha, state: 'pending', description: 'me is building PAY-142', context: 'ensemble/build' }]);
    const [row] = await rows();
    expect(row).toMatchObject({ kind: 'build', state: 'pending', headSha: r.sha, branch: KEY, buildId: b, owner: 'acme', name: 'api', login: 'me' });
    // A second take for the same session keeps its claim.
    expect((await F.takeTicketClaim(target(b), log)).kind).toBe('held');
    expect(posted.length).toBe(1);
  });

  it('stands down when the re-read finds an EARLIER live claim (a race), and deletes its placeholder', async () => {
    const b = await newBuild();
    // Robin's claim lands on web while ours is being posted, and started a minute earlier.
    onFirstPending = () => {
      placeholderOf('web', 'robin-ph', 'robin');
      teammateLine('web', 'robin-ph', 'robin', 'pending', 'robin is building PAY-142', MIN);
    };
    const r = await F.takeTicketClaim(target(b), log);
    expect(r.kind).toBe('lost');
    expect(r.kind === 'lost' && r.claim.login).toBe('robin');
    expect(posted.map((p) => [p.state, p.description])).toEqual([
      ['pending', 'me is building PAY-142'],
      ['success', 'Cleared by me: robin is building this'],
    ]);
    expect(refs.has(`api:${KEY}`)).toBe(false);
    expect((await rows())[0]).toMatchObject({ state: 'released', lastError: 'stood down' });
  });

  it("refuses a teammate's LIVE claim and touches nothing", async () => {
    const b = await newBuild();
    placeholderOf('web', 'robin-ph', 'robin');
    teammateLine('web', 'robin-ph', 'robin', 'pending', 'robin is building PAY-142', 5 * MIN);
    const r = await F.takeTicketClaim(target(b), log);
    expect(r.kind === 'lost' && r.claim).toMatchObject({ login: 'robin', live: true, mine: false });
    expect(posted).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("releases a teammate's LAPSED claim once and REPLACES its placeholder by a fast-forward", async () => {
    const b = await newBuild();
    canPush.delete('web');
    placeholderOf('api', 'robin-ph', 'robin');
    teammateLine('api', 'robin-ph', 'robin', 'pending', 'robin is building PAY-142', C.BUILD_CLAIM_LEASE_MS + MIN);
    const r = await F.takeTicketClaim(target(b), log);
    canPush.add('web');
    expect(r.kind).toBe('held');
    if (r.kind !== 'held') return;
    expect(posted[0]).toMatchObject({ sha: 'robin-ph', state: 'success', description: "Cleared by me: robin's claim expired" });
    expect(commits.get(r.sha)!.parent).toBe('robin-ph'); // a fast-forward of exactly the head that was read
    expect(refs.get(`api:${KEY}`)).toBe(r.sha);
    const teammate = (await rows()).find((x) => x.whose === 'teammate');
    expect(teammate).toMatchObject({ login: 'robin', state: 'released', headSha: 'robin-ph' });
  });

  it('never touches a real branch: the claim goes to the next repository', async () => {
    const b = await newBuild();
    commits.set('work', { sha: 'work', message: 'PAY-142: refunds', tree: 't', parent: 'api-main' });
    refs.set(`api:${KEY}`, 'work');
    const r = await F.takeTicketClaim(target(b), log);
    expect(r.kind === 'held' && r.name).toBe('web');
    expect(refs.get(`api:${KEY}`)).toBe('work');
  });

  it('goes ahead UNMARKED with no login or an unreadable branch (never blocks on GitHub)', async () => {
    const b = await newBuild();
    me = null;
    expect((await F.takeTicketClaim(target(b), log)).kind).toBe('unmarked');
    me = 'me';
    readFails = true;
    expect((await F.takeTicketClaim(target(b), log)).kind).toBe('unmarked');
    expect(posted).toEqual([]);
  });
});

describe('follow and push', () => {
  it('moves the claim to the commit this machine pushed and posts the pending line there', async () => {
    const b = await newBuild();
    live.add(b);
    const r = await F.takeTicketClaim(target(b), log);
    if (r.kind !== 'held') throw new Error('not held');
    expect(await F.placeholderReplaceable(A, 'acme', 'api', KEY, r.sha)).toBe(true); // ours
    await F.noteTicketBranchMoved({ accountId: A, owner: 'acme', name: 'api', branch: KEY, from: r.sha, to: 'pushed1' });
    expect((await rows())[0]).toMatchObject({ headSha: 'pushed1', state: 'pending' });
    expect(posted.at(-1)).toMatchObject({ sha: 'pushed1', state: 'pending', description: 'me is building PAY-142' });
    // A push that moved some other head changes nothing.
    await F.noteTicketBranchMoved({ accountId: A, owner: 'acme', name: 'api', branch: KEY, from: 'elsewhere', to: 'x' });
    expect((await rows())[0].headSha).toBe('pushed1');
  });

  it("replaces a free or lapsed placeholder, never a teammate's live one or a real commit", async () => {
    placeholderOf('web', 'free-ph', 'robin');
    teammateLine('web', 'free-ph', 'robin', 'success', 'Cleared by robin: build paused · free to claim', MIN);
    expect(await F.placeholderReplaceable(A, 'acme', 'web', KEY, 'free-ph')).toBe(true);
    placeholderOf('web', 'lapsed-ph', 'robin');
    teammateLine('web', 'lapsed-ph', 'robin', 'pending', 'robin is building PAY-142', C.BUILD_CLAIM_LEASE_MS + MIN);
    expect(await F.placeholderReplaceable(A, 'acme', 'web', KEY, 'lapsed-ph')).toBe(true);
    placeholderOf('web', 'live-ph', 'robin');
    teammateLine('web', 'live-ph', 'robin', 'pending', 'robin is building PAY-142', MIN);
    expect(await F.placeholderReplaceable(A, 'acme', 'web', KEY, 'live-ph')).toBe(false);
    commits.set('real', { sha: 'real', message: 'PAY-142: refunds', tree: 't', parent: null });
    expect(await F.placeholderReplaceable(A, 'acme', 'web', KEY, 'real')).toBe(false);
  });
});

describe('clear', () => {
  it("refuses a teammate's live claim; frees a lapsed one and the reader's own from another computer", async () => {
    placeholderOf('web', 'robin-ph', 'robin');
    teammateLine('web', 'robin-ph', 'robin', 'pending', 'robin is building PAY-142', MIN);
    const t = target(0);
    expect(await F.clearTicketClaim(t, log)).toMatchObject({ ok: false, error: 'NotReady' });
    now += C.BUILD_CLAIM_LEASE_MS;
    expect(await F.clearTicketClaim(t, log)).toEqual({ ok: true });
    expect(posted.at(-1)).toMatchObject({ sha: 'robin-ph', state: 'success', description: "Cleared by me: robin's claim expired" });
    expect(await F.ticketClaimForView(t, log)).toBeNull();
    // The reader's own claim from another computer: cleared at once.
    placeholderOf('api', 'mine-ph', 'me');
    teammateLine('api', 'mine-ph', 'me', 'pending', 'me is building PAY-142', MIN);
    F.forgetTicketClaimView(A, wsId, IDENT);
    expect(await F.ticketClaimForView(t, log)).toMatchObject({ login: 'me', mine: true, live: true });
    expect(await F.clearTicketClaim(t, log)).toEqual({ ok: true });
    expect(posted.at(-1)).toMatchObject({ sha: 'mine-ph', description: 'Cleared by me' });
  });
});

describe('the reconciler', () => {
  const pass = (extra: Record<string, unknown> = {}) =>
    R.settleStoryBuildClaims(log, { loopBusy: () => false, liveBuilds: () => [], workspaceRepos: async () => repos, notice: () => {}, ...extra });

  it('renews while the session is live, then settles when it closed (paused) and deletes the placeholder', async () => {
    const b = await newBuild();
    live.add(b);
    const r = await F.takeTicketClaim(target(b), log);
    if (r.kind !== 'held') throw new Error('not held');
    posted = [];
    await pass();
    expect(posted).toEqual([]); // inside BUILD_CLAIM_RENEW_MS
    now += C.BUILD_CLAIM_RENEW_MS;
    await pass();
    expect(posted).toEqual([{ repo: 'api', sha: r.sha, state: 'pending', description: 'me is building PAY-142', context: 'ensemble/build' }]);
    live.delete(b); // the session closed (idle, a restart)
    await db.update(schema.storyBuilds).set({ sessionPhase: 'built', status: 'ready' }).where(eq(schema.storyBuilds.id, b)).execute();
    await pass();
    expect(posted.at(-1)).toMatchObject({ state: 'success', description: 'Cleared by me: build paused · free to claim' });
    expect(deleted).toEqual([`api@${r.sha}`]);
    expect((await rows())[0]).toMatchObject({ state: 'released' });
  });

  it('posts the done line once every repository is pushed (the claim followed the push)', async () => {
    const b = await newBuild();
    live.add(b);
    const r = await F.takeTicketClaim(target(b), log);
    if (r.kind !== 'held') throw new Error('not held');
    commits.set('pushed1', { sha: 'pushed1', message: 'PAY-142: refunds', tree: 't2', parent: 'api-main' });
    refs.set(`api:${KEY}`, 'pushed1');
    await F.noteTicketBranchMoved({ accountId: A, owner: 'acme', name: 'api', branch: KEY, from: r.sha, to: 'pushed1' });
    await db.update(schema.storyBuilds).set({ sessionPhase: 'pushed' }).where(eq(schema.storyBuilds.id, b)).execute();
    await pass();
    expect(posted.at(-1)).toMatchObject({ sha: 'pushed1', state: 'success', description: 'me built PAY-142 · pull request opened' });
    expect(deleted).toEqual([]); // a real commit is never deleted
    expect((await rows())[0]).toMatchObject({ state: 'finished' });
  });

  it("closes a row whose head a teammate already settled, posting nothing", async () => {
    const b = await newBuild();
    const r = await F.takeTicketClaim(target(b), log);
    if (r.kind !== 'held') throw new Error('not held');
    lines.push({ id: nextId++, repo: 'api', sha: r.sha, context: 'ensemble/build', state: 'success', description: "Cleared by robin: me's claim expired", createdAtMs: now + 1, login: 'robin' });
    posted = [];
    await db.update(schema.storyBuilds).set({ sessionPhase: 'discarded', status: 'discarded' }).where(eq(schema.storyBuilds.id, b)).execute();
    await pass();
    expect(posted).toEqual([]);
    expect((await rows())[0]).toMatchObject({ state: 'released', lastError: 'settled' });
  });

  it('a live session with no claim (a Resume) claims once', async () => {
    const b = await newBuild();
    live.add(b);
    await pass({ liveBuilds: () => [{ buildId: b, accountId: A, workspaceId: wsId }] });
    expect(posted.map((p) => p.description)).toEqual(['me is building PAY-142']);
    await pass({ liveBuilds: () => [{ buildId: b, accountId: A, workspaceId: wsId }] });
    expect(posted.length).toBe(1);
  });
});

describe("the review loop's review lines", () => {
  const t = (buildId: number) => ({ accountId: A, buildId, workspaceId: wsId, ident: IDENT, owner: 'acme', name: 'api', branch: KEY, headSha: 'h1', provider: 'claude' as const });

  it('posts the pending line, then "reviewed · kept in Ensemble", on the per-provider context', async () => {
    const b = await newBuild();
    const line = await RL.startLoopReviewLine(t(b), log);
    expect(line?.marked).toBe(true);
    await RL.endLoopReviewLine(line, 'succeeded', log);
    expect(posted).toEqual([
      { repo: 'api', sha: 'h1', state: 'pending', description: 'me is reviewing with Claude', context: 'ensemble/review-claude' },
      { repo: 'api', sha: 'h1', state: 'success', description: 'me reviewed · kept in Ensemble', context: 'ensemble/review-claude' },
    ]);
    expect((await rows())[0]).toMatchObject({ kind: 'review', state: 'finished', provider: 'claude' });
  });

  it("never overwrites a teammate's newer line; a crash's open row is released once the loop is idle", async () => {
    const b = await newBuild();
    const line = await RL.startLoopReviewLine(t(b), log);
    lines.push({ id: nextId++, repo: 'api', sha: 'h1', context: 'ensemble/review-claude', state: 'success', description: 'robin reviewed · 2 comments', createdAtMs: now + 1, login: 'robin' });
    await RL.endLoopReviewLine(line, 'succeeded', log);
    expect(posted.length).toBe(1);
    // A crash: the row stays open until the loop is not working here, then the reconciler releases it.
    const crash = await RL.startLoopReviewLine({ ...t(b), headSha: 'h2' }, log);
    if (crash?.timer) clearInterval(crash.timer);
    await R.settleStoryBuildClaims(log, { loopBusy: () => true, liveBuilds: () => [] });
    expect(posted.at(-1)).toMatchObject({ sha: 'h2', state: 'pending' });
    await R.settleStoryBuildClaims(log, { loopBusy: () => false, liveBuilds: () => [] });
    expect(posted.at(-1)).toMatchObject({ sha: 'h2', state: 'success', description: "Cleared by me: review didn't finish · free to claim" });
  });
});
