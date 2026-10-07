import { and, eq } from 'drizzle-orm';
import { linearSiteRoot } from '@pierre-review/shared';
import type { TrackerContext } from '../context.js';
import { normalizePrefixKey } from '../detect.js';
import { JiraFetchError } from '../jira/fetch.js';
import type { LinkerPr, TrackerCall, TrackerLinker } from '../types.js';
import { linearGraphql } from './client.js';

// LINEAR — THE LINKER: which Linear issues each pull request is ATTACHED to, read from Linear and
// stored on the PR (`pull_requests.linear_links` + `linear_links_root` + `linear_links_checked_at`,
// migration 0090 / pg 0077).
//
// Linear's GitHub integration attaches a PR to every issue it names — a branch like
// `alex/eng-123-fix`, "ENG-123" in the title, a magic word ("Fixes ENG-123") in the BODY, or a link
// made by hand in Linear. `attachmentsForURL(url: <the PR's GitHub URL>)` returns exactly those, so
// this is the best source there is: it sees the PR body, which lean storage never keeps.
//
// ⚠ AN ADDITION, NOT THE WHOLE ANSWER (`required: false`). A workspace without the integration, a
// PR never read, or a read that failed all fall back to key detection on the title and branch
// (../detect.ts) — the adapter's `detect` is links ∪ detection. So a NULL here never hides a ticket.
//
// ⚠ THE LINKS BELONG TO ONE LINEAR WORKSPACE. Each read stores the workspace root it was made
// against; a PR whose root is not the workspace's current one is "never read" (a new key for another
// Linear workspace, or a moved URL) — detection ignores the stale links and this reads them again.
// Issues Linear returns from any other workspace are dropped.
//
// ⚠ COST — ZERO FOR EVERY OTHER WORKSPACE, AND BOUNDED HERE. Only PRs in a workspace whose tracker is
// Linear with a usable key reach this. ONE request carries up to `LINEAR_LINK_BATCH` aliased
// `attachmentsForURL(first: 10)` fields (≈ 22 complexity points each, ≈ 550 per request against
// Linear's 10,000-point ceiling); at most `LINEAR_LINK_MAX` PRs per pass. A PR is due when never read
// (on this root), when GitHub's `updatedAt` moved past the last read, or every `LINEAR_LINK_TTL_MS`
// while open (a link made in Linear does not move the PR). A merged PR is read once.
//
// ⚠ A COLUMN IS CLEARED ONLY ON A POSITIVE STATEMENT: an alias Linear did not answer is left as it was.

export const LINEAR_LINK_BATCH = 25;
export const LINEAR_LINK_MAX = 200;
export const LINEAR_LINK_TTL_MS = 30 * 60_000;
/** Issues kept per PR, in Linear's order. */
export const LINEAR_LINK_CAP = 10;

/** The aliased query for N PR URLs: `a0: attachmentsForURL(url: $u0, first: 10) { … }`. */
export function linearLinksQuery(n: number): string {
  const vars = Array.from({ length: n }, (_, i) => `$u${i}: String!`).join(', ');
  const fields = Array.from(
    { length: n },
    (_, i) => `  a${i}: attachmentsForURL(url: $u${i}, first: ${LINEAR_LINK_CAP}) { nodes { issue { identifier url } } }`,
  ).join('\n');
  return `query LimnLinearPrLinks(${vars}) {\n${fields}\n}`;
}

type Conn = { nodes?: Array<{ issue?: { identifier?: string | null; url?: string | null } | null } | null> | null } | null;

/** One alias's answer → the stored keys (this workspace's issues only, deduped, in Linear's order);
 *  null when it is not a positive statement. */
export function linearKeysOf(conn: Conn | undefined, root: string): string[] | null {
  if (conn == null || !Array.isArray(conn.nodes)) return null;
  const out: string[] = [];
  for (const n of conn.nodes) {
    const key = normalizePrefixKey(n?.issue?.identifier ?? '');
    if (key == null || linearSiteRoot(n?.issue?.url) !== root || out.includes(key)) continue;
    out.push(key);
    if (out.length >= LINEAR_LINK_CAP) break;
  }
  return out;
}

const time = (d: Date | null | undefined): number | null => (d != null ? new Date(d).getTime() : null);

function isDue(pr: LinkerPr, now: number, call: TrackerCall): boolean {
  if (pr.prUrl == null || pr.prUrl === '') return false;
  const checked = time(pr.linearLinksCheckedAt);
  if (checked == null || pr.linearLinksRoot !== call.apiRoot) return true;
  if (pr.updatedAt != null && new Date(pr.updatedAt).getTime() > checked) return true;
  return pr.state === 'open' && now - checked >= LINEAR_LINK_TTL_MS;
}

async function refresh(
  ctx: TrackerContext,
  accountId: number,
  prs: readonly LinkerPr[],
  opts: { now: number; call: TrackerCall },
): Promise<{ read: number; skipped: number; stop?: { code: string; status: number | null } }> {
  const { call } = opts;
  const rank = (p: LinkerPr): number =>
    time(p.linearLinksCheckedAt) == null || p.linearLinksRoot !== call.apiRoot ? 0 : p.state === 'open' ? 1 : 2;
  const due = prs
    .filter((p) => isDue(p, opts.now, call))
    .sort((a, b) => rank(a) - rank(b) || (time(a.linearLinksCheckedAt) ?? 0) - (time(b.linearLinksCheckedAt) ?? 0) || a.id - b.id)
    .slice(0, LINEAR_LINK_MAX);
  if (due.length === 0) return { read: 0, skipped: 0 };
  const pr = ctx.schema.pullRequests;
  let read = 0;
  for (let i = 0; i < due.length; i += LINEAR_LINK_BATCH) {
    const batch = due.slice(i, i + LINEAR_LINK_BATCH);
    const variables = Object.fromEntries(batch.map((p, j) => [`u${j}`, p.prUrl!]));
    let data: Record<string, Conn> | null;
    try {
      ({ data } = await linearGraphql<Record<string, Conn>>(call, linearLinksQuery(batch.length), variables, () => opts.now));
    } catch (err) {
      // A refused key / a rate limit / Linear unreachable: stop this pass; the rest stay due. The
      // worker backs the workspace off on a refusal or a limit. Never thrown.
      const code = err instanceof JiraFetchError ? err.code : 'unknown';
      const status = err instanceof JiraFetchError ? err.status : null;
      ctx.log.warn({ accountId, code, route: 'tracker-linear-links' }, 'Linear issue links not read (retried later)');
      return { read, skipped: due.length - read, stop: { code, status } };
    }
    const at = new Date(opts.now);
    for (let j = 0; j < batch.length; j += 1) {
      const p = batch[j]!;
      const keys = linearKeysOf(data?.[`a${j}`], call.apiRoot);
      if (keys == null) continue; // not a positive statement: leave the row alone
      await ctx.db
        .update(pr)
        .set({ linearLinks: keys, linearLinksRoot: call.apiRoot, linearLinksCheckedAt: at })
        .where(and(eq(pr.accountId, accountId), eq(pr.id, p.id)))
        .execute();
      read += 1;
    }
  }
  return { read, skipped: due.length - read };
}

export const linearLinker: TrackerLinker = { required: false, refresh, isDue };
