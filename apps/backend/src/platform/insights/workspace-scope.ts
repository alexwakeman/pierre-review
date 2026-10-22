import { and, eq } from 'drizzle-orm';
import type { ProContext } from '../contract.js';

// Plugin-side WORKSPACE scope resolution — the successor to the old five-branch `resolveScope`.
//
// WHY THIS MODULE STILL EXISTS AFTER THE SCOPE COLLAPSED TO ONE INTEGER. The wire parameter is
// now just `?workspace=<id>`, so there is nothing left to *canonicalise* — `normalizeScope`,
// `teamSetIds` and `resolveScope`'s five branches are DELETED. But the plugin still has to turn
// that id into a concrete repo-id set to feed `ctx.queries.*`, and it imports no host internals,
// so `ctx.schema.workspaceRepos` is the only way it can. That, plus the persisted cache-key
// vocabulary, is all that is left: three small functions.

// Parse the wire `?workspace=` value → a positive integer, or null. No sentinels, no sets, no
// canonical string form: there is exactly one shape.
//
// The caller resolves the null: `parseWorkspaceId(q.workspace) ?? await
// ctx.queries.defaultWorkspaceId(accountId)`. A POSITIVE integer that the account does not own
// is not rejected here (this function does no I/O) — it degrades safely instead:
// `resolveWorkspaceRepoIds` is account-scoped and returns [], and every host getter re-checks
// `accountId`, so a foreign id yields an empty answer rather than another tenant's data.
//
// `number` is accepted alongside `string` purely because an ajv route schema declaring the query
// param as an integer hands the handler a number; widening the input can never break a caller
// that passes the wire string.
export function parseWorkspaceId(raw: string | number | undefined | null): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  const s = raw.trim();
  const n = Number.parseInt(s, 10);
  return Number.isInteger(n) && n > 0 && String(n) === s ? n : null;
}

// The cache key persisted in the six plugin tables' `scope_key` column (the column NAME is
// unchanged; only its value vocabulary is).
//
// ⚠ THE `ws:` PREFIX IS LOAD-BEARING, not decoration. A bare number would alias a legacy `'3'`
// (team 3) onto workspace 3, whose repo set differs — and a stale cached AI report would then be
// served for the wrong repos. Plugin migration 0020 clears the report tables and re-keys the
// user-authored ones; this prefix is what makes that safe even on a partially-replayed database.
export function scopeKeyFor(workspaceId: number): string {
  return `ws:${workspaceId}`;
}

// The repo ids of ONE workspace, ALWAYS account-scoped via `workspace_repos.accountId`. A foreign
// or unknown workspace matches no row and returns [] — never null, never another account's repos.
//
// ⚠ IT USED TO INTERSECT WITH `repos.inboxWatch = true`, AND THAT INTERSECTION IS GONE — the
// column is DROPPED (core migration 0046 / pg 0033). It was a plugin-only rule that kept the AI
// corpus to a "watched" subset back when a repo could be added-but-not-watched; the workspace is
// now the ONE scope, so a workspace's membership IS its corpus and this function agrees with core's
// `resolveWorkspaceScope` rather than quietly narrowing under it.
//
// ⚠ THAT MAKES THIS FUNCTION A SPEND SURFACE. Every repo in the workspace now reaches the sprint
// report, the grounded chat, preset prompts and both Themes surfaces. The lever that bounds the
// corpus is workspace MEMBERSHIP — a user who does not want a repo summarised moves it out of the
// workspace. Do not reintroduce a second visibility axis here to shrink it.
//
// The result stays a legitimate `BotScopeWire.repoIds`: it is exactly the workspace's membership,
// which satisfies the `repoIds ⊆ workspace membership` invariant that shape requires.
//
// Portable async only (`await q.execute()`); `ctx.db` is node-postgres-typed, so no
// `.get()/.all()/.run()`.
export async function resolveWorkspaceRepoIds(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<number[]> {
  const workspaceReposT = ctx.schema.workspaceRepos;
  const reposT = ctx.schema.repos;
  const rows = (await ctx.db
    .select({ repoId: workspaceReposT.repoId })
    .from(workspaceReposT)
    .innerJoin(reposT, eq(reposT.id, workspaceReposT.repoId))
    .where(
      and(
        eq(workspaceReposT.accountId, accountId),
        eq(workspaceReposT.workspaceId, workspaceId),
        // Belt-and-braces: the membership row's own accountId already scopes this, but the join
        // makes the repo side explicit so a future re-key of workspace_repos cannot quietly widen
        // the read. (The join also survives as the liveness check the dropped watch predicate used
        // to imply: a membership row pointing at a deleted repo contributes nothing.)
        eq(reposT.accountId, accountId),
      ),
    )
    .execute()) as Array<{ repoId: number }>;
  return Array.from(new Set(rows.map((r) => r.repoId)));
}
