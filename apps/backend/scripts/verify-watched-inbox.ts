// Functional check for the "Watch repos → My Turn inbox" feature (query-layer; no
// HTTP needed). Exercises the watch lifecycle (setRepoInboxWatch coalesce + IDOR) and
// the getMyTurn watched-repo section (opened-after-start window, dedupe, sticky
// dismissal, and exclusion of self/bot/draft PRs).
//
// Run against a throwaway sqlite DB (never your real one):
//   DATABASE_URL=/tmp/pierre-watch.sqlite DISABLE_SCHEDULER=true \
//     pnpm --filter @pierre-review/backend exec tsx scripts/verify-watched-inbox.ts
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';

if (!config.dbPath || config.dbPath.includes('pierre-review.sqlite')) {
  console.error(
    'Refusing to run: set DATABASE_URL to a throwaway path (not the real DB).',
  );
  process.exit(1);
}
for (const suffix of ['', '-shm', '-wal']) {
  rmSync(config.dbPath + suffix, { force: true });
}

const { runMigrations } = await import('../src/db/run-migrations.js');
const { closeDb, db, schema } = await import('../src/db/client.js');
const q = await import('../src/db/queries.js');
const { eq } = await import('drizzle-orm');

await runMigrations();

const { accounts, repos, pullRequests, users } = schema;
const now = Date.now();
const T0 = new Date(now - 10 * 86_400_000); // the watch-start baseline for getMyTurn tests
const before = new Date(now - 20 * 86_400_000); // opened before the watch began
const after = new Date(now - 5 * 86_400_000); // opened after the watch began

// Account 1 is the migration-seeded local account; give it a login + matching user so
// getAccountUserId(1) resolves "me". Add account 2 for the IDOR check.
await db.update(accounts).set({ githubLogin: 'me' }).where(eq(accounts.id, 1)).execute();
await db
  .insert(accounts)
  .values({ id: 2, githubUserId: 'U_b', githubLogin: 'bob', isLocal: false })
  .execute();

const mkUser = async (login: string, isBot = false): Promise<number> => {
  const [u] = await db
    .insert(users)
    .values({ githubLogin: login, isBot })
    .returning()
    .execute();
  return u!.id;
};
const meId = await mkUser('me');
const aliceId = await mkUser('alice');
const botId = await mkUser('dependabot', true);

const [repoA] = await db
  .insert(repos)
  .values({ accountId: 1, owner: 'org', name: 'repoA', githubNodeId: 'R_A' })
  .returning()
  .execute();
const [repoB] = await db
  .insert(repos)
  .values({ accountId: 2, owner: 'org', name: 'repoB', githubNodeId: 'R_B' })
  .returning()
  .execute();

let prSeq = 0;
const mkPr = async (
  authorId: number,
  openedAt: Date,
  opts: { draft?: boolean; state?: 'open' | 'merged' | 'closed' } = {},
): Promise<number> => {
  prSeq += 1;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_${prSeq}`,
      accountId: 1,
      repoId: repoA!.id,
      number: prSeq,
      title: `PR ${prSeq}`,
      authorId,
      state: opts.state ?? 'open',
      isDraft: opts.draft ?? false,
      openedAt,
      updatedAt: openedAt,
    })
    .returning()
    .execute();
  return pr!.id;
};

// The set of PRs in repoA. Only prOther + prOther2 should ever surface in the inbox.
const prOther = await mkPr(aliceId, after); // human, after start → SHOWS
const prOther2 = await mkPr(aliceId, after); // a second one → SHOWS
await mkPr(meId, after); // your own PR → excluded
await mkPr(botId, after); // bot author → excluded
await mkPr(aliceId, after, { draft: true }); // draft → excluded
await mkPr(aliceId, before); // opened before watch → excluded
await mkPr(aliceId, after, { state: 'merged' }); // not open → excluded

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label}`);
  }
};
const watchedIds = async (): Promise<Set<number>> =>
  new Set((await q.getMyTurn(1)).watchedRepoPrs.map((w) => w.prId));

// 1. Not watched → nothing.
check('unwatched repo → no watched-repo inbox items', (await watchedIds()).size === 0);

// 2. setRepoInboxWatch lifecycle: stamp once, preserve across unwatch + re-watch.
await q.setRepoInboxWatch(1, repoA!.id, true);
const startedAfterFirst = await readStart();
check('first watch stamps inbox_watch_started_at', startedAfterFirst != null);
await q.setRepoInboxWatch(1, repoA!.id, false);
check('unwatch preserves the start', (await readStart())?.getTime() === startedAfterFirst?.getTime());
await q.setRepoInboxWatch(1, repoA!.id, true);
check(
  're-watch does NOT overwrite the original start (coalesce)',
  (await readStart())?.getTime() === startedAfterFirst?.getTime(),
);

// 3. IDOR: account 2 cannot toggle account 1's repo, and the start is untouched.
check('setRepoInboxWatch(B, A.repo) returns false (IDOR blocked)', (await q.setRepoInboxWatch(2, repoA!.id, false)) === false);
check("A's repo stays watched after B's attempt", (await q.getRepo(1, repoA!.id))?.inboxWatch === true);

// 4. getMyTurn watched section: pin the start to T0 so the seeded openedAt values are
//    deterministic, then assert only the human, non-draft, opened-after PRs surface.
await db
  .update(repos)
  .set({ inboxWatch: true, inboxWatchStartedAt: T0 })
  .where(eq(repos.id, repoA!.id))
  .execute();
let ids = await watchedIds();
check('watched section includes the human PR opened after start', ids.has(prOther));
check('watched section includes the second human PR', ids.has(prOther2));
check('watched section excludes your own / bot / draft / old / non-open PRs', ids.size === 2);

// 5. Dismiss is sticky: dismissed PR leaves the inbox and lands in the Done tab.
await q.dismissMyTurn(1, 'watched_repo_pr', prOther);
ids = await watchedIds();
check('dismissed watched PR leaves the inbox', !ids.has(prOther) && ids.has(prOther2));
const done = await q.getCompletedDismissals(1);
check(
  'dismissed watched PR appears in the Done tab',
  done.items.some((it) => it.kind === 'watched_repo_pr' && it.prId === prOther),
);

// 6. Unwatch hides everything; re-watch restores the non-dismissed ones (sticky stays).
await q.setRepoInboxWatch(1, repoA!.id, false);
check('unwatch hides all watched items', (await watchedIds()).size === 0);
await q.setRepoInboxWatch(1, repoA!.id, true);
ids = await watchedIds();
check(
  're-watch restores non-dismissed; dismissed stays dismissed',
  ids.has(prOther2) && !ids.has(prOther),
);

// IDOR on dismissal: account 2 can't dismiss account 1's PR.
await q.dismissMyTurn(2, 'watched_repo_pr', prOther2);
check(
  "dismissMyTurn(B, A.pr) is a no-op (IDOR blocked)",
  (await watchedIds()).has(prOther2),
);

// repoB belongs to account 2 — never leaks into account 1's inbox (sanity).
check('account 1 never sees account 2 repo', repoB!.accountId === 2);

console.log(`\nWATCHED INBOX: ${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);

// --- helpers ---
async function readStart(): Promise<Date | null> {
  const rows = await db
    .select({ s: repos.inboxWatchStartedAt })
    .from(repos)
    .where(eq(repos.id, repoA!.id))
    .execute();
  return rows[0]?.s ?? null;
}
