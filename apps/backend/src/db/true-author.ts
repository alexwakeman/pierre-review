// THE PERSON BEHIND A ROW (docs/CLAUDE-REVIEW.md § Limn's actions are bots). A row Limn wrote is stored
// under the poster's `limn:<login>` bot in `author_id` (or `merged_by_id`), with the person beside it
// in a `limn_*` column. ⚠ Every "is this my own post / review / commit / PR" check reads THESE, never
// `author_id`. DB-free on purpose (SQL builders only): modules a test imports without a database can
// use it.
import { sql, type SQL } from 'drizzle-orm';
import type { schema } from './client.js';

type S = typeof schema;
type AuthoredTable = S['reviewComments'] | S['prComments'] | S['reviews'] | S['commits'] | S['pullRequests'];

/** The poster of a Limn row (a finding, a reply, a review, a commit, a PR Limn opened), else its author. */
export function trueAuthorId(t: AuthoredTable): SQL<number | null> {
  // By column, not by object identity: a table handed in through a context is the same shape.
  if ('limnPushedByUserId' in t) return sql<number | null>`coalesce(${t.limnPushedByUserId}, ${t.authorId})`;
  if ('limnOpenedForUserId' in t) return sql<number | null>`coalesce(${t.limnOpenedForUserId}, ${t.authorId})`;
  return sql<number | null>`coalesce(${t.limnPostedByUserId}, ${t.authorId})`;
}

/** The person a PR was merged by or FOR: the reader whose merge Limn landed, else the merger. */
export function trueMergerId(t: S['pullRequests']): SQL<number | null> {
  return sql<number | null>`coalesce(${t.limnMergedForUserId}, ${t.mergedById})`;
}

/** WHOSE PR THIS IS, for "Your PRs" (docs/BACKEND.md § My Turn): the person Limn opened it for
 *  (Implement, AI Fix on a new branch, the conflict resolver), else its author. ⚠ Ownership only:
 *  nothing Limn DOES on the PR counts as that person acting. Pure. */
export function prOwnerId(p: { authorId: number | null; limnOpenedForUserId?: number | null }): number | null {
  return p.limnOpenedForUserId ?? p.authorId;
}
