// A TEAMMATE'S LINE THIS LIMN STOOD DOWN FOR (`team_claim_seen`, migration 0159; docs/CLAUDE-REVIEW.md
// § Team claims → The teammate's line on the tab). The skip memory (team-claim.ts) is in process and
// per PR; this is the durable copy the AI Review tab reads, so "Robin Dunn reviewed this commit with
// Claude · no comments" survives a reload and a restart. One row per (account, PR, head, provider),
// overwritten by the newest read. DB only — no GitHub call.
import type { AiProviderId, ClaudeTeamClaimSkip } from '@pierre-review/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';

const DESCRIPTION_MAX = 140;

/** Record (or overwrite) the teammate line this machine skipped for. */
export async function recordTeammateLine(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  skip: ClaudeTeamClaimSkip,
): Promise<void> {
  const t = ctx.schema.teamClaimSeen;
  if (!t) return; // a test's narrow schema
  const atMs = Date.parse(skip.at);
  const values = {
    kind: skip.kind,
    login: skip.login,
    description: skip.description != null ? skip.description.slice(0, DESCRIPTION_MAX) : null,
    lineAt: new Date(Number.isFinite(atMs) ? atMs : Date.now()),
    updatedAt: new Date(),
  };
  await ctx.db
    .insert(t)
    .values({ accountId, prId, headSha: skip.headSha, provider: skip.provider, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.prId, t.headSha, t.provider], set: values })
    .execute();
}

/** Forget the line (a Clear made it stale). */
export async function forgetTeammateLine(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
  provider: AiProviderId,
): Promise<void> {
  const t = ctx.schema.teamClaimSeen;
  if (!t) return;
  await ctx.db
    .delete(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.headSha, headSha), eq(t.provider, provider)))
    .execute();
}

/**
 * The lines at the PR's head, Claude's first, each with the teammate's display name when the synced
 * users table knows their login. Account-scoped.
 */
export async function teammateLinesAtHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string | null,
): Promise<ClaudeTeamClaimSkip[]> {
  const t = ctx.schema.teamClaimSeen;
  if (!t || !headSha) return [];
  const rows = (await ctx.db
    .select({ provider: t.provider, kind: t.kind, login: t.login, description: t.description, lineAt: t.lineAt })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId), eq(t.headSha, headSha)))
    .execute()) as Array<{ provider: string; kind: string; login: string; description: string | null; lineAt: Date }>;
  if (rows.length === 0) return [];
  const names = await displayNames(ctx, rows.map((r) => r.login));
  return rows
    .filter((r) => (r.provider === 'claude' || r.provider === 'codex') && (r.kind === 'reviewed' || r.kind === 'reviewing'))
    .sort((a, b) => (a.provider === b.provider ? 0 : a.provider === 'claude' ? -1 : 1))
    .map((r) => ({
      provider: r.provider as AiProviderId,
      kind: r.kind as 'reviewed' | 'reviewing',
      login: r.login,
      headSha,
      at: r.lineAt.toISOString(),
      description: r.description,
      name: names.get(r.login.toLowerCase()) ?? null,
    }));
}

async function displayNames(ctx: AgentContext, logins: string[]): Promise<Map<string, string>> {
  const u = ctx.schema.users;
  const out = new Map<string, string>();
  if (!u || logins.length === 0) return out;
  const rows = (await ctx.db
    .select({ login: u.githubLogin, name: u.displayName })
    .from(u)
    .where(inArray(u.githubLogin, [...new Set(logins)]))
    .execute()) as Array<{ login: string; name: string | null }>;
  for (const r of rows) if (r.name && r.name.trim() !== '') out.set(r.login.toLowerCase(), r.name.trim());
  return out;
}
