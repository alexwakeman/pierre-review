// "SOMEONE ELSE" — the people the PR pane's picker offers to ask for a review
// (GET /api/prs/:id/askable-people; docs/API.md, docs/TEAM-REVIEW.md § Asking anyone in the workspace).
//
// DB ONLY. The pool is everyone who AUTHORED or MERGED a PR in the scoped workspace's repos (its
// watched members, through `resolveWorkspaceScope`), plus the PR's own repo. Nothing here asks GitHub
// whether a person can be asked: GitHub decides on the write, and the request route turns its refusal
// into a per-person 422.
//
// Ranking (best first):
//   1. merged a PR in THIS repo,
//   2. merged a PR anywhere in the workspace,
//   3. authored or merged a PR in the last 90 days,
//   4. everyone else;
// then the most recent activity, then the login.
//
// Left out: the reader, the PR's author (GitHub refuses a self-request), automation
// (`globalAutomationUserIds`, never `hiddenBotUserIds`) and anyone already requested on this PR.
// ⚠ Limn's own rows count for the PERSON behind them (`trueAuthorId` / `trueMergerId`).
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AskablePeopleResponse, AskablePerson } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { globalAutomationUserIds } from './automation-ids.js';
import { mapUser, resolveWorkspaceScope } from './queries.js';
import { trueAuthorId, trueMergerId, prOwnerId } from './true-author.js';
import { getAccountUserId } from '../auth/account.js';

const { pullRequests, repos, reviewRequests, users } = schema;

/** "Recent activity" for the third rank. */
export const ASKABLE_RECENT_DAYS = 90;
/** A ceiling on the answer: the picker filters as the reader types, so a long tail is never read. */
export const ASKABLE_PEOPLE_MAX = 500;

/** One person's facts before ranking. `lastActiveMs` = their newest authored or merged PR here. */
export interface AskableFacts {
  mergedHere: boolean;
  mergedInWorkspace: boolean;
  lastActiveMs: number;
}

/** Lower is better. Pure. */
export function askableTier(f: AskableFacts, nowMs: number): number {
  if (f.mergedHere) return 0;
  if (f.mergedInWorkspace) return 1;
  if (f.lastActiveMs >= nowMs - ASKABLE_RECENT_DAYS * 24 * 60 * 60 * 1000) return 2;
  return 3;
}

/** The order the picker shows: tier, then newest activity, then login. Pure. */
export function compareAskable(
  a: AskableFacts & { login: string },
  b: AskableFacts & { login: string },
  nowMs: number,
): number {
  return (
    askableTier(a, nowMs) - askableTier(b, nowMs) ||
    b.lastActiveMs - a.lastActiveMs ||
    a.login.localeCompare(b.login)
  );
}

// A timestamp column read through max(): drizzle hands back the raw stored value (unix seconds).
const toMs = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n * 1000 : 0;
};

/** null when the PR is not this account's (→ 404). `rawWorkspace` is the wire `?workspace=`. */
export async function getAskablePeople(
  prId: number,
  accountId: number,
  rawWorkspace: string | number | undefined | null,
  nowMs: number = Date.now(),
): Promise<AskablePeopleResponse | null> {
  const pr = (
    await db
      .select({
        repoId: pullRequests.repoId,
        authorId: pullRequests.authorId,
        limnOpenedForUserId: pullRequests.limnOpenedForUserId,
      })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(eq(pullRequests.id, prId), eq(repos.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (pr == null) return null;

  const scope = await resolveWorkspaceScope(accountId, rawWorkspace);
  const repoIds = [...new Set([...scope.repoIds, pr.repoId])];
  const inScope = and(eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, repoIds));

  const author = trueAuthorId(pullRequests);
  const merger = trueMergerId(pullRequests);
  const [authored, merged, asked, automation, viewerId] = await Promise.all([
    db
      .select({ userId: author, last: sql<number>`max(${pullRequests.openedAt})` })
      .from(pullRequests)
      .where(inScope)
      .groupBy(author)
      .execute(),
    db
      .select({
        userId: merger,
        here: sql<number>`max(case when ${pullRequests.repoId} = ${pr.repoId} then 1 else 0 end)`,
        last: sql<number>`max(${pullRequests.mergedAt})`,
      })
      .from(pullRequests)
      .where(and(inScope, eq(pullRequests.state, 'merged')))
      .groupBy(merger)
      .execute(),
    db
      .select({ userId: reviewRequests.userId })
      .from(reviewRequests)
      .where(eq(reviewRequests.prId, prId))
      .execute(),
    globalAutomationUserIds(),
    getAccountUserId(accountId),
  ]);

  const facts = new Map<number, AskableFacts>();
  const factsOf = (id: number): AskableFacts => {
    let f = facts.get(id);
    if (f == null) {
      f = { mergedHere: false, mergedInWorkspace: false, lastActiveMs: 0 };
      facts.set(id, f);
    }
    return f;
  };
  for (const r of authored) {
    if (r.userId == null) continue;
    const f = factsOf(r.userId);
    f.lastActiveMs = Math.max(f.lastActiveMs, toMs(r.last));
  }
  for (const r of merged) {
    if (r.userId == null) continue;
    const f = factsOf(r.userId);
    f.mergedInWorkspace = true;
    if (Number(r.here) === 1) f.mergedHere = true;
    f.lastActiveMs = Math.max(f.lastActiveMs, toMs(r.last));
  }

  const excluded = new Set<number>(automation);
  for (const id of [viewerId, pr.authorId, prOwnerId(pr)]) if (id != null) excluded.add(id);
  for (const r of asked) if (r.userId != null) excluded.add(r.userId);
  const ids = [...facts.keys()].filter((id) => !excluded.has(id));
  if (ids.length === 0) return { workspaceId: scope.workspaceId, people: [] };

  const rows = await db.select().from(users).where(inArray(users.id, ids)).execute();
  const people: AskablePerson[] = rows
    .map((u) => ({ u: mapUser(u), f: facts.get(u.id)! }))
    .filter(({ u }) => !u.isBot)
    .sort((a, b) =>
      compareAskable({ ...a.f, login: a.u.githubLogin }, { ...b.f, login: b.u.githubLogin }, nowMs),
    )
    .slice(0, ASKABLE_PEOPLE_MAX)
    .map(({ u, f }) => ({ ...u, isMaintainer: f.mergedHere, mergedInWorkspace: f.mergedInWorkspace }));
  return { workspaceId: scope.workspaceId, people };
}
