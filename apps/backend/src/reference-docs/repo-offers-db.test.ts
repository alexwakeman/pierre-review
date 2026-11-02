// DOCS OFFERED FROM THE REPOSITORIES — on a THROWAWAY sqlite DB (docs/REFERENCE-DOCS.md § Docs offered).
//
//   • a scan records the qualifying folders as OFFERS and builds NOTHING (no document row);
//   • a repository is looked at once, then again only after the rescan interval;
//   • "Not now" hides the workspace's card for DOCS_OFFER_SNOOZE_DAYS, then the folders not added are
//     offered again; the wizard's list (`listRepoFolders`) holds them all along;
//   • a folder already in the library is not offered, and drops off the list when added meanwhile; once
//     its document is removed, the wizard lists it again (never the card);
//   • an offer is claimed once (a double press adds one document) and a failed add puts it back;
//   • the wizard's check reuses a stored scan and looks at ≤ DOCS_FROM_REPOS_SCAN_MAX repositories;
//   • a repository whose files can't be read records why, is not read again for a day, is listed by the
//     wizard and the repo page from that stored failure, and a later success clears it;
//   • tenancy: another account's offer is never listed, declined, claimed or read.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCS_FROM_REPOS_SCAN_MAX, DOCS_OFFER_BYTES_PER_WORD, DOCS_OFFER_RESCAN_DAYS, DOCS_OFFER_SNOOZE_DAYS } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-repo-offers-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let eq: any;
let scan: typeof import('./repo-offers.js')['scanRepoForDocOffers'];
let check: typeof import('./repo-offers.js')['checkWorkspaceRepoFolders'];
let store: typeof import('./repo-offers-store.js');

const DAY = 86_400_000;
/** Past any "Not now" made during the run. */
const LATER = new Date(Date.now() + (DOCS_OFFER_SNOOZE_DAYS + 1) * DAY);
let shaN = 0;
const sha = (): string => (shaN++).toString(16).padStart(40, '0');
const file = (path: string, words = 800) => ({ path, type: 'blob' as const, sha: sha(), size: words * DOCS_OFFER_BYTES_PER_WORD });

/** A fake GitHub: one tree per repository, counting reads. */
function fakeSource(trees: Record<string, ReturnType<typeof file>[]>) {
  const reads = { branch: 0, tree: 0 };
  return {
    reads,
    source: {
      defaultBranch: async () => {
        reads.branch += 1;
        return 'main';
      },
      listTree: async (owner: string, repo: string) => {
        reads.tree += 1;
        return { entries: trees[`${owner}/${repo}`] ?? [], truncated: false };
      },
    },
  };
}

let ws = 0;
let wsOther = 0;
let repoApi = 0;
let repoWeb = 0;
let repoB = 0;
let wsB = 0;

async function insertRepo(accountId: number, name: string, defaultBranch: string | null = 'main'): Promise<number> {
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId, owner: 'acme', name, githubNodeId: `R_offer_${accountId}_${name}`, defaultBranch })
    .returning()
    .execute();
  return r.id;
}

const docsCount = async (): Promise<number> => (await db.select().from(schema.referenceDocs).execute()).length;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('../db/queries.js');
  ({ eq } = await import('drizzle-orm'));
  ({ scanRepoForDocOffers: scan, checkWorkspaceRepoFolders: check } = await import('./repo-offers.js'));
  store = await import('./repo-offers-store.js');

  ws = (await q.createWorkspace(1, 'Docs')).id;
  wsOther = (await q.createWorkspace(1, 'Other')).id;
  repoApi = await insertRepo(1, 'api');
  repoWeb = await insertRepo(1, 'web', null);
  await q.assignReposToWorkspace(ws, 1, [repoApi, repoWeb]);

  await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_offer_b', githubLogin: 'bob', isLocal: false }).execute();
  wsB = (await q.createWorkspace(2, 'B')).id;
  repoB = await insertRepo(2, 'secret');
  await q.assignReposToWorkspace(wsB, 2, [repoB]);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const API_TREE = [
  file('README.md'),
  file('docs/a.md'),
  file('docs/b.md'),
  file('docs/c.md'),
  file('handbook/one.md'),
  file('handbook/two.md'),
  file('handbook/three.md'),
  file('src/index.ts'),
];

describe('scanRepoForDocOffers', () => {
  it('records the qualifying folders as offers and builds nothing', async () => {
    const gh = fakeSource({ 'acme/api': API_TREE });
    expect(await scan(1, repoApi, { source: gh.source, token: 't' })).toBe('scanned');
    // The stored default branch is used: one read, the tree.
    expect(gh.reads).toEqual({ branch: 0, tree: 1 });
    const offers = await store.listOpenOffers(1, ws);
    expect(offers.map((o) => `${o.repoFullName}/${o.path}`)).toEqual(['acme/api/docs', 'acme/api/handbook']);
    expect(offers[0]).toMatchObject({ docs: 3, words: 2400, tooLarge: false });
    // ⚠ No build before the reader's yes: not a single document row.
    expect(await docsCount()).toBe(0);
    // Pending and the Docs page read the same block.
    expect((await store.docsOffersFor(1, ws))?.offers).toHaveLength(2);
    expect(await store.docsOffersFor(1, wsOther)).toBeNull();
  });

  it('reads the default branch when the sync has not stored it', async () => {
    const gh = fakeSource({ 'acme/web': [file('wiki/x.md'), file('wiki/y.md')] });
    expect(await scan(1, repoWeb, { source: gh.source, token: 't' })).toBe('scanned');
    expect(gh.reads).toEqual({ branch: 1, tree: 1 });
    // Two documents: nothing qualifies, nothing offered from this repository.
    expect((await store.listOpenOffers(1, ws)).some((o) => o.repoId === repoWeb)).toBe(false);
  });

  it('looks at a repository again only after the rescan interval', async () => {
    const gh = fakeSource({ 'acme/api': API_TREE });
    expect(await scan(1, repoApi, { source: gh.source, token: 't' })).toBe('not_due');
    expect(gh.reads.tree).toBe(0);
    const later = Date.now() + DOCS_OFFER_RESCAN_DAYS * DAY + 1000;
    expect(await scan(1, repoApi, { source: gh.source, token: 't', now: () => later })).toBe('scanned');
  });

  it('"Not now" hides the card for DOCS_OFFER_SNOOZE_DAYS, then offers the folders not added again', async () => {
    const [docs] = (await store.listOpenOffers(1, ws)).filter((o) => o.path === 'docs');
    expect(await store.declineOffers(1, ws, [docs!.id])).toBe(1);
    // The card is hidden as a whole — 'handbook' included — and a scan does not bring it back.
    expect(await store.listOpenOffers(1, ws)).toEqual([]);
    expect(await store.docsOffersFor(1, ws)).toBeNull();
    await scan(1, repoApi, { source: fakeSource({ 'acme/api': [...API_TREE, file('adr/1.md'), file('adr/2.md'), file('adr/3.md')] }).source, token: 't', force: true });
    expect(await store.listOpenOffers(1, ws)).toEqual([]);
    const until = await store.offersSnoozedUntil(1, ws);
    expect(Math.round((until!.getTime() - Date.now()) / DAY)).toBe(DOCS_OFFER_SNOOZE_DAYS);
    expect(await store.listOpenOffers(1, ws, new Date(until!.getTime() - 1000))).toEqual([]);
    // Afterwards, every folder still not added is offered again — the declined one too.
    expect((await store.listOpenOffers(1, ws, LATER)).map((o) => o.path)).toEqual(['adr', 'docs', 'handbook']);
    // The wizard lists them all along.
    expect((await store.listRepoFolders(1, ws)).map((o) => o.path)).toEqual(['adr', 'docs', 'handbook']);
  });

  it('drops a folder the library already holds, at once and on the next scan', async () => {
    await db
      .insert(schema.referenceDocs)
      .values({
        accountId: 1,
        workspaceId: ws,
        slug: 'handbook',
        title: 'api/handbook',
        sourceKind: 'wiki',
        sourceName: 'acme/api/handbook',
        status: 'queued',
        wiki: { provider: 'github', origin: 'https://github.com', rootPageId: 'g', scope: { kind: 'repo', owner: 'acme', repo: 'api', path: 'handbook', branch: 'main' } },
      })
      .execute();
    expect((await store.listOpenOffers(1, ws, LATER)).map((o) => o.path)).toEqual(['adr', 'docs']);
    expect((await store.listRepoFolders(1, ws)).map((o) => o.path)).toEqual(['adr', 'docs']);
    await scan(1, repoApi, { source: fakeSource({ 'acme/api': API_TREE }).source, token: 't', force: true });
    const rows = await db.select().from(schema.referenceDocRepoOffers).where(eq(schema.referenceDocRepoOffers.repoId, repoApi)).execute();
    // 'handbook' (now in the library) is recorded as added; 'adr' (gone from the tree) is removed; the
    // declined 'docs' stays declined.
    expect(rows.map((r: any) => `${r.path}:${r.state}`).sort()).toEqual(['docs:declined', 'handbook:added']);
  });

  it('claims an offer once, and a failed add puts it back', async () => {
    await scan(1, repoApi, { source: fakeSource({ 'acme/api': [...API_TREE, file('adr/1.md'), file('adr/2.md'), file('adr/3.md')] }).source, token: 't', force: true });
    const adr = (await store.listOpenOffers(1, ws, LATER)).find((o) => o.path === 'adr');
    expect(adr).toBeDefined();
    expect(await store.claimOffer(1, ws, adr!.id)).toBe(true);
    expect(await store.claimOffer(1, ws, adr!.id)).toBe(false);
    expect((await store.listOpenOffers(1, ws, LATER)).map((o) => o.path)).toEqual(['docs']);
    await store.releaseOffer(1, adr!.id);
    expect((await store.listOpenOffers(1, ws, LATER)).map((o) => o.path)).toEqual(['adr', 'docs']);
    // Added for real: stays added, with its document.
    expect(await store.claimOffer(1, ws, adr!.id)).toBe(true);
    await store.setOfferDoc(1, adr!.id, 42);
    await store.releaseOffer(1, adr!.id);
    expect((await store.listOpenOffers(1, ws, LATER)).map((o) => o.path)).toEqual(['docs']);
    // A declined folder can be claimed (the card after its snooze, or the wizard at any time).
    const docs = (await store.listRepoFolders(1, ws)).find((o) => o.path === 'docs');
    expect(await store.claimOffer(1, ws, docs!.id)).toBe(true);
    await store.releaseOffer(1, docs!.id, { state: 'declined', decidedAt: new Date() });
    expect((await db.select().from(schema.referenceDocRepoOffers).where(eq(schema.referenceDocRepoOffers.id, docs!.id)).execute())[0].state).toBe('declined');
    // Still nothing built by the offer machinery itself.
    expect(await docsCount()).toBe(1);
  });

  it('a folder whose document was removed is listed by the wizard again (never the card), and only the wizard re-claims it', async () => {
    await db.delete(schema.referenceDocs).where(eq(schema.referenceDocs.slug, 'handbook')).execute();
    const handbook = (await store.listRepoFolders(1, ws)).find((o) => o.path === 'handbook');
    expect(handbook).toBeDefined();
    expect((await store.listOpenOffers(1, ws, LATER)).some((o) => o.path === 'handbook')).toBe(false);
    expect(await store.claimOffer(1, ws, handbook!.id)).toBe(false);
    expect(await store.claimOffer(1, ws, handbook!.id, new Date(), { reclaimAdded: true })).toBe(true);
  });

  it('never claims a too-large folder', async () => {
    const many = Array.from({ length: 120 }, (_, i) => file(`docs-big/documentation/p${i}.md`, 50));
    const gh = fakeSource({ 'acme/web': many });
    await scan(1, repoWeb, { source: gh.source, token: 't', force: true });
    const big = (await store.listRepoFolders(1, ws)).find((o) => o.repoId === repoWeb);
    expect(big).toMatchObject({ path: 'docs-big/documentation', tooLarge: true });
    expect(await store.claimOffer(1, ws, big!.id)).toBe(false);
    expect(await store.claimOffer(1, ws, big!.id, new Date(), { reclaimAdded: true })).toBe(false);
  });
});

describe('checkWorkspaceRepoFolders (the wizard)', () => {
  it('reuses a stored scan, looks at ≤ DOCS_FROM_REPOS_SCAN_MAX repositories per check, and counts the rest', async () => {
    const wsMany = (await q.createWorkspace(1, 'Many')).id;
    const ids: number[] = [];
    for (let i = 0; i < DOCS_FROM_REPOS_SCAN_MAX + 2; i++) ids.push(await insertRepo(1, `many-${String(i).padStart(2, '0')}`));
    await q.assignReposToWorkspace(wsMany, 1, ids);
    const gh = fakeSource({ 'acme/many-00': API_TREE });
    const first = await check(1, wsMany, { source: gh.source, token: 't' });
    expect(gh.reads.tree).toBe(DOCS_FROM_REPOS_SCAN_MAX);
    expect(first.notLookedAt).toBe(2);
    expect(first.folders.map((f) => `${f.repoFullName} › ${f.path}`)).toEqual(['acme/many-00 › docs', 'acme/many-00 › handbook']);
    const second = await check(1, wsMany, { source: gh.source, token: 't' });
    expect(gh.reads.tree).toBe(DOCS_FROM_REPOS_SCAN_MAX + 2);
    expect(second.notLookedAt).toBe(0);
    // Every repository looked at recently: answered from the stored scans, no GitHub read at all.
    await check(1, wsMany, { source: gh.source, token: 't' });
    expect(gh.reads.tree).toBe(DOCS_FROM_REPOS_SCAN_MAX + 2);
    // A "Not now" on the card never hides a folder from the wizard.
    await store.declineOffers(1, wsMany, [first.folders[0]!.id]);
    expect((await check(1, wsMany, { source: gh.source, token: 't' })).folders).toHaveLength(2);
    expect(await store.listOpenOffers(1, wsMany)).toEqual([]);
  });
});

describe('a repository whose files can’t be read', () => {
  const HOUR = 3_600_000;
  /** A fake GitHub whose tree read fails with this error (counting reads). */
  const failing = (err: unknown) => {
    const reads = { tree: 0 };
    return {
      reads,
      source: {
        defaultBranch: async () => 'main',
        listTree: async () => {
          reads.tree += 1;
          throw err;
        },
      },
    };
  };
  const repoRow = async (id: number) =>
    (await db.select().from(schema.repos).where(eq(schema.repos.id, id)).execute())[0];

  it('records why, backs off DOCS_OFFER_FAILURE_RETRY_HOURS, then looks at most daily; a success clears it', async () => {
    const { WikiSourceError } = await import('./wiki/source.js');
    const id = await insertRepo(1, 'locked');
    await q.assignReposToWorkspace(ws, 1, [id]);
    const t0 = Date.now();
    const gh = failing(new WikiSourceError('forbidden', 403));
    expect(await scan(1, id, { source: gh.source, token: 't', now: () => t0 })).toBe('unreachable');
    const row = await repoRow(id);
    expect(row.docsOfferFailure).toBe('no_access');
    expect(row.docsOfferFailedAt.getTime()).toBe(Math.floor(t0 / 1000) * 1000);
    expect(row.docsOfferScannedAt).toBeNull();
    // Every later walk asks again — and does NOT read GitHub inside the back-off (forced or not).
    expect(await scan(1, id, { source: gh.source, token: 't', now: () => t0 + HOUR })).toBe('backed_off');
    expect(await scan(1, id, { source: gh.source, token: 't', now: () => t0 + 23 * HOUR, force: true })).toBe('backed_off');
    expect(gh.reads.tree).toBe(1);
    // After 24 hours: one look; it fails again, and the next is a day after THAT failure.
    expect(await scan(1, id, { source: gh.source, token: 't', now: () => t0 + 25 * HOUR })).toBe('unreachable');
    expect(await scan(1, id, { source: gh.source, token: 't', now: () => t0 + 40 * HOUR })).toBe('backed_off');
    expect(gh.reads.tree).toBe(2);
    // The repository page reads the stored reason (GET /api/activity, no fetch of its own).
    const act = await q.getActivity(1, { workspaceId: ws, repoIds: [id, repoApi] });
    expect(act.repos.find((r: { repoId: number }) => r.repoId === id)?.docsUnreadable).toBe('no_access');
    expect(act.repos.find((r: { repoId: number }) => r.repoId === repoApi)?.docsUnreadable).toBeNull();
    // A later look that succeeds clears it.
    const ok = fakeSource({ 'acme/locked': API_TREE });
    expect(await scan(1, id, { source: ok.source, token: 't', now: () => t0 + 50 * HOUR })).toBe('scanned');
    const after = await repoRow(id);
    expect(after.docsOfferFailedAt).toBeNull();
    expect(after.docsOfferFailure).toBeNull();
    expect(after.docsOfferScannedAt).not.toBeNull();
    await q.deleteRepo(id, 1);
  });

  it('names the reason: no access, empty, not found; anything else is GitHub not answering', async () => {
    const { WikiSourceError } = await import('./wiki/source.js');
    const { unreadableReasonOf } = await import('./repo-offers.js');
    expect(unreadableReasonOf(new WikiSourceError('unauthorized', 401))).toBe('no_access');
    expect(unreadableReasonOf(new WikiSourceError('forbidden', 403))).toBe('no_access');
    expect(unreadableReasonOf(new WikiSourceError('not_found', 404))).toBe('not_found');
    expect(unreadableReasonOf(new WikiSourceError('http', 409))).toBe('empty');
    expect(unreadableReasonOf(new WikiSourceError('http', 502))).toBe('unavailable');
    expect(unreadableReasonOf(new WikiSourceError('rate_limited', 403))).toBe('unavailable');
    expect(unreadableReasonOf(new Error('boom'))).toBe('unavailable');
  });

  it('the wizard lists it from the stored failure and does not read GitHub during the back-off', async () => {
    const { WikiSourceError } = await import('./wiki/source.js');
    const wsEmpty = (await q.createWorkspace(1, 'Empty')).id;
    const id = await insertRepo(1, 'blank');
    await q.assignReposToWorkspace(wsEmpty, 1, [id]);
    const gh = failing(new WikiSourceError('http', 409));
    const first = await check(1, wsEmpty, { source: gh.source, token: 't' });
    expect(first.notLookedAt).toBe(0);
    expect(first.unreadable).toEqual([
      expect.objectContaining({ repoId: id, repoFullName: 'acme/blank', reason: 'empty' }),
    ]);
    const second = await check(1, wsEmpty, { source: gh.source, token: 't' });
    expect(gh.reads.tree).toBe(1);
    expect(second.unreadable.map((u: { reason: string }) => u.reason)).toEqual(['empty']);
    // Another workspace's list never names it.
    expect((await check(1, wsOther, { source: gh.source, token: 't' })).unreadable).toEqual([]);
  });
});

describe('tenancy', () => {
  it("another account's offer is never listed, declined, claimed or read", async () => {
    await scan(2, repoB, { source: fakeSource({ 'acme/secret': API_TREE }).source, token: 't' });
    const mine = await store.listOpenOffers(2, wsB);
    expect(mine.length).toBe(2);
    const id = mine[0]!.id;
    expect((await store.listOpenOffers(1, wsB)).some((o) => o.repoId === repoB)).toBe(false);
    expect(await store.getOffer(1, ws, id)).toBeNull();
    expect(await store.getOffer(1, wsB, id)).toBeNull();
    expect(await store.declineOffers(1, wsB, [id])).toBe(0);
    expect(await store.claimOffer(1, wsB, id)).toBe(false);
    expect((await store.listOpenOffers(2, wsB)).map((o) => o.id)).toContain(id);
    // A scan of B's repository under A's account finds no repository.
    expect(await scan(1, repoB, { source: fakeSource({}).source, token: 't', force: true })).toBe('no_repo');
  });

  it("a repository's offers go with the repository", async () => {
    expect(await q.deleteRepo(repoB, 2)).toBe(true);
    expect(await store.listOpenOffers(2, wsB)).toEqual([]);
    const left = await db.select().from(schema.referenceDocRepoOffers).where(eq(schema.referenceDocRepoOffers.accountId, 2)).execute();
    expect(left).toEqual([]);
  });
});
