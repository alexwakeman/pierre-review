import { and, eq } from 'drizzle-orm';
import type { AgentContext } from '../../review/agent-context.js';
import { qualityCheckBot } from '../../sync/bot-detection.js';
import type { SeedThread } from './review-seed.js';

// THE PR'S OPEN THREADS, AS THE FIX SEED'S "untouched" AND "style bot" SECTIONS NEED THEM.
//
// Rides the SAME loader the review run reads (`ctx.queries.loadReviewThreads` →
// db/review-threads-for-review.ts): unresolved threads only, threads rooted on Limn's own posted
// findings left out, Limn's own comments left out. Absent on the context ⇒ no threads.
//
// ⚠ A STYLE BOT IS DECIDED BY THE PR'S WORKSPACE, STORED ROLE FIRST. A `workspace_reviewers` row for
// the root author decides — `automated && role === 'quality_check'` (a manual "this is a human" row
// is not automated, so it is never a style bot). With no row, the login seed decides
// (`qualityCheckBot`). The same order every reviewer-role read uses: the stored role beats the seed.
// Never throws: a failed read costs the two thread sections only, never the fix.

const normLogin = (l: string): string => l.toLowerCase().replace(/\[bot\]$/, '');

/** Lower-cased logins (no `[bot]`) → is this actor a style bot in the PR's workspace (stored rows only). */
async function storedStyleRoles(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<Map<string, boolean>> {
  const { pullRequests: prs, workspaceRepos: wr, workspaceReviewers: wrv, users } = ctx.schema;
  const ws = (
    (await ctx.db
      .select({ workspaceId: wr.workspaceId })
      .from(prs)
      .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ workspaceId: number }>
  )[0];
  const out = new Map<string, boolean>();
  if (!ws) return out;
  const rows = (await ctx.db
    .select({ login: users.githubLogin, automated: wrv.automated, role: wrv.role })
    .from(wrv)
    .innerJoin(users, eq(users.id, wrv.authorUserId))
    .where(and(eq(wrv.accountId, accountId), eq(wrv.workspaceId, ws.workspaceId)))
    .execute()) as Array<{ login: string | null; automated: boolean; role: string | null }>;
  for (const r of rows) {
    if (!r.login) continue;
    const key = normLogin(r.login);
    const style = r.automated === true && r.role === 'quality_check';
    // `dependabot` and `dependabot[bot]` can be two user rows: either one calling it a style bot wins.
    out.set(key, (out.get(key) ?? false) || style);
  }
  return out;
}

export async function loadSeedThreads(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<SeedThread[]> {
  const load = ctx.queries?.loadReviewThreads;
  if (!load) return [];
  try {
    const [{ threads }, stored] = await Promise.all([
      load(accountId, prId),
      storedStyleRoles(ctx, accountId, prId),
    ]);
    return threads.map((t) => {
      const root = t.comments[0];
      const login = root?.authorLogin ?? null;
      const key = login ? normLogin(login) : null;
      const rootIsStyleBot = key == null ? false : stored.has(key) ? stored.get(key)! : qualityCheckBot(login);
      return {
        threadId: t.threadId,
        path: t.path,
        line: t.line,
        derivedState: t.derivedState,
        rootAuthorLogin: login,
        rootAuthorIsBot: root?.authorIsBot ?? false,
        rootIsStyleBot,
        comments: t.comments.map((c) => ({ authorLogin: c.authorLogin, body: c.body })),
      };
    });
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: loading the PR threads failed');
    return [];
  }
}
