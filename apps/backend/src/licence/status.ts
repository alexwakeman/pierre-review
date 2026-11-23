// THE LICENCE STATUS ON THIS MACHINE (docs/LICENSING.md): the stored key checked offline, how many
// people the account's repositories show posting through Ensemble, and whether to show the reminder.
//
// ⚠ A REMINDER, NEVER A BLOCK. The count is a floor and a guess (see `countEnsembleUsers`), so it
// may only ever show a notice the reader can quiet; no feature reads it.
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import {
  LICENCE_EVALUATION_DAYS,
  LICENCE_FREE_USERS,
  LICENCE_SNOOZE_DAYS,
  LICENCE_USAGE_WINDOW_DAYS,
  type LicenceKeyProblem,
  type LicenceStatusResponse,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { checkLicenceKey } from './key.js';

const DAY = 24 * 60 * 60 * 1000;

interface AccountLicenceRow {
  login: string;
  key: string | null;
  evaluationEndsAt: Date | null;
  snoozedUntil: Date | null;
}

async function accountRow(accountId: number): Promise<AccountLicenceRow | null> {
  const a = schema.accounts;
  const row = (
    await db
      .select({
        login: a.githubLogin,
        key: a.licenceKey,
        evaluationEndsAt: a.licenceEvaluationEndsAt,
        snoozedUntil: a.licenceReminderSnoozedUntil,
      })
      .from(a)
      .where(eq(a.id, accountId))
      .limit(1)
      .execute()
  )[0];
  return row ?? null;
}

/**
 * How many people post through Ensemble in the account's repositories: per GitHub owner (an
 * organisation, or a person's own account), the distinct people behind Ensemble-posted review
 * comments, PR comments and reviews (`limn_posted_by_user_id`) in the last
 * LICENCE_USAGE_WINDOW_DAYS days, plus the reader. Returns the owner where the most are seen.
 *
 * A FLOOR AND A GUESS: someone who only reads in Ensemble posts nothing and is not seen, and on a
 * public repository an outside contributor who runs Ensemble is counted with the owner.
 */
export async function countEnsembleUsers(
  accountId: number,
  readerLogin: string,
  nowMs: number,
): Promise<{ count: number; owner: string | null }> {
  const since = new Date(nowMs - LICENCE_USAGE_WINDOW_DAYS * DAY);
  const { reviewComments: rc, prComments: pc, reviews: rv, pullRequests: pr, repos, users } = schema;
  const byOwner = new Map<string, Set<number>>();
  const readerIds = new Set(
    (
      await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.githubLogin}) = lower(${readerLogin})`)
        .execute()
    ).map((r) => r.id),
  );
  const add = (rows: { owner: string; poster: number | null }[]): void => {
    for (const r of rows) {
      if (r.poster == null || readerIds.has(r.poster)) continue;
      const key = r.owner.toLowerCase();
      let set = byOwner.get(key);
      if (!set) byOwner.set(key, (set = new Set()));
      set.add(r.poster);
    }
  };
  const scope = and(eq(repos.accountId, accountId), eq(pr.accountId, accountId));
  add(
    await db
      .selectDistinct({ owner: repos.owner, poster: rc.limnPostedByUserId })
      .from(rc)
      .innerJoin(pr, eq(rc.prId, pr.id))
      .innerJoin(repos, eq(pr.repoId, repos.id))
      .where(and(scope, isNotNull(rc.limnPostedByUserId), gte(rc.createdAt, since)))
      .execute(),
  );
  add(
    await db
      .selectDistinct({ owner: repos.owner, poster: pc.limnPostedByUserId })
      .from(pc)
      .innerJoin(pr, eq(pc.prId, pr.id))
      .innerJoin(repos, eq(pr.repoId, repos.id))
      .where(and(scope, isNotNull(pc.limnPostedByUserId), gte(pc.createdAt, since)))
      .execute(),
  );
  add(
    await db
      .selectDistinct({ owner: repos.owner, poster: rv.limnPostedByUserId })
      .from(rv)
      .innerJoin(pr, eq(rv.prId, pr.id))
      .innerJoin(repos, eq(pr.repoId, repos.id))
      .where(and(scope, isNotNull(rv.limnPostedByUserId), gte(rv.submittedAt, since)))
      .execute(),
  );
  let best: { count: number; owner: string | null } = { count: 1, owner: null };
  // Sorted, so a tie names the same owner every time.
  for (const owner of [...byOwner.keys()].sort()) {
    const count = byOwner.get(owner)!.size + 1;
    if (count > best.count) best = { count, owner };
  }
  return best;
}

/** The pure decision: given the facts, should the reminder show, and why. */
export function decideReminder(input: {
  users: number;
  licence: LicenceStatusResponse['licence'];
  evaluationEndsAtMs: number | null;
  snoozedUntilMs: number | null;
  nowMs: number;
}): LicenceStatusResponse['reminder'] {
  const { users, licence, evaluationEndsAtMs, snoozedUntilMs, nowMs } = input;
  const evaluationEndsAt = evaluationEndsAtMs != null ? new Date(evaluationEndsAtMs).toISOString() : null;
  const canEvaluate = evaluationEndsAtMs == null;
  let reason: LicenceStatusResponse['reminder']['reason'] = null;
  if (licence?.ok === true) {
    if (users > licence.seats) reason = 'over_licence_seats';
  } else if (users > LICENCE_FREE_USERS) {
    reason = 'over_free_limit';
  }
  const quiet =
    (evaluationEndsAtMs != null && nowMs < evaluationEndsAtMs) || (snoozedUntilMs != null && nowMs < snoozedUntilMs);
  return { show: reason != null && !quiet, reason, evaluationEndsAt, canEvaluate };
}

export async function getLicenceStatus(accountId: number, nowMs = Date.now()): Promise<LicenceStatusResponse> {
  const row = await accountRow(accountId);
  let licence: LicenceStatusResponse['licence'] = null;
  if (row?.key) {
    const c = checkLicenceKey(row.key, nowMs);
    licence = c.ok
      ? { ok: true, org: c.payload.org, seats: c.payload.seats, expires: c.payload.exp, source: c.payload.src }
      : { ok: false, problem: c.problem };
  }
  const users = row ? await countEnsembleUsers(accountId, row.login, nowMs) : { count: 1, owner: null };
  return {
    freeUsers: LICENCE_FREE_USERS,
    licence,
    users,
    reminder: decideReminder({
      users: users.count,
      licence,
      evaluationEndsAtMs: row?.evaluationEndsAt?.getTime() ?? null,
      snoozedUntilMs: row?.snoozedUntil?.getTime() ?? null,
      nowMs,
    }),
  };
}

/** Store a key, but only one that checks out now; returns the problem otherwise. */
export async function saveLicenceKey(
  accountId: number,
  text: string,
  nowMs = Date.now(),
): Promise<{ ok: true } | { ok: false; problem: LicenceKeyProblem }> {
  const c = checkLicenceKey(text, nowMs);
  if (!c.ok) return { ok: false, problem: c.problem };
  await db
    .update(schema.accounts)
    .set({ licenceKey: text.replace(/\s+/g, '') })
    .where(eq(schema.accounts.id, accountId))
    .execute();
  return { ok: true };
}

export async function removeLicenceKey(accountId: number): Promise<void> {
  await db.update(schema.accounts).set({ licenceKey: null }).where(eq(schema.accounts.id, accountId)).execute();
}

/** Start the ONE evaluation (a no-op once started). */
export async function startLicenceEvaluation(accountId: number, nowMs = Date.now()): Promise<void> {
  const row = await accountRow(accountId);
  if (!row || row.evaluationEndsAt != null) return;
  await db
    .update(schema.accounts)
    .set({ licenceEvaluationEndsAt: new Date(nowMs + LICENCE_EVALUATION_DAYS * DAY) })
    .where(eq(schema.accounts.id, accountId))
    .execute();
}

/** "Remind me later". */
export async function snoozeLicenceReminder(accountId: number, nowMs = Date.now()): Promise<void> {
  await db
    .update(schema.accounts)
    .set({ licenceReminderSnoozedUntil: new Date(nowMs + LICENCE_SNOOZE_DAYS * DAY) })
    .where(eq(schema.accounts.id, accountId))
    .execute();
}
