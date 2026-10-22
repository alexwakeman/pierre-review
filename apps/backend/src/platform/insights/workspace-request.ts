import { and, eq } from 'drizzle-orm';
import type { BotScopeWire, ProContext } from '../contract.js';
import { parseWorkspaceId, resolveWorkspaceRepoIds } from './workspace-scope.js';

// Turning ONE wire parameter into the ONE scope every Pro insights surface runs on.
//
// A workspace is the only scope this app has, so a request carries a plain integer — `?workspace=`
// on a GET, the same integer as a string on `SprintChatBody.scope` / `CreatePinnedPromptBody.scope`.
// There is no sentinel vocabulary left ('all' / 'none' / 'teams' / 'teams:<ids>' are gone with the
// TeamScope union), no canonicalisation and no parser chain: `parseWorkspaceId` or nothing.
//
// ── THE DEFAULTING RULE (host §5.1, reproduced here because the plugin cannot call the host's
//    resolveWorkspaceScope) ─────────────────────────────────────────────────────────────────────
// Absent / unparseable / unknown / ANOTHER TENANT'S id all resolve to the account's DEFAULT
// workspace. NOT a 404: every id produces the same response shape so this is not an existence
// oracle, the resolved id is always one the caller owns so nothing can leak, and a stale bookmark
// degrades to something renderable instead of a blank card.
//
// ⚠ THE OWNERSHIP SELECT IS NOT OPTIONAL, and "resolveWorkspaceRepoIds returns [] for a foreign id
// anyway" is not a substitute. Without it a foreign id would (a) render every AI surface as an
// empty "nothing to report" rather than the Default workspace's real report, and (b) travel INTO
// `BotScopeWire.workspaceId`, where the host resolves the bot judgement — a workspace this account
// does not own has no `workspace_reviewers` rows, so every automated reviewer would silently read
// as a human. Both are wrong answers dressed as empty ones.
async function ownedWorkspaceId(
  ctx: ProContext,
  accountId: number,
  raw: string | number | undefined | null,
): Promise<number | null> {
  const id = parseWorkspaceId(raw);
  if (id == null) return null;
  const wsT = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({ id: wsT.id })
    .from(wsT)
    .where(and(eq(wsT.id, id), eq(wsT.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

// The wire value → a workspace id this account definitely owns.
export async function resolveRequestWorkspaceId(
  ctx: ProContext,
  accountId: number,
  raw: string | number | undefined | null,
): Promise<number> {
  const owned = await ownedWorkspaceId(ctx, accountId, raw);
  return owned ?? (await ctx.queries.defaultWorkspaceId(accountId));
}

// A KNOWN-GOOD workspace id → the full scope. Used by the two entry points that already hold a
// resolved id: the cron paths (which take the account's Default) and the sprint-report refresh.
//
// ⚠ THIS IS THE ONE SANCTIONED PLACE THE PLUGIN ASSEMBLES A `BotScopeWire`. The contract forbids
// hand-assembling one from a repo list gathered elsewhere, because the guarantee that matters is
// `repoIds ⊆ that workspace's membership` — and `resolveWorkspaceRepoIds` reads exactly
// `workspace_repos` for exactly this workspace. (It used to intersect that with
// `repos.inboxWatch = true`; that column is DROPPED, so the workspace's membership IS the AI
// corpus and workspace membership is the only lever that bounds what gets summarised — and billed
// for.) Never build the pair from a repo id set that came from a query param, a card, or another
// workspace's listing.
export async function workspaceScope(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<BotScopeWire> {
  return { workspaceId, repoIds: await resolveWorkspaceRepoIds(ctx, accountId, workspaceId) };
}

// The common case: a request's raw parameter → the scope its handler runs on.
//
// `repoIds: []` is an ORDINARY state, not an edge case — an empty workspace. Every builder below
// treats it as "nothing to answer from" and returns null, which is what the old
// `repoIds && repoIds.length === 0` guard did; the `null`-means-the-watched-set branch it sat
// beside is gone with the watch concept itself.
export async function resolveRequestScope(
  ctx: ProContext,
  accountId: number,
  raw: string | number | undefined | null,
): Promise<BotScopeWire> {
  return workspaceScope(ctx, accountId, await resolveRequestWorkspaceId(ctx, accountId, raw));
}
