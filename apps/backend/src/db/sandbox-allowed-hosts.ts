// SANDBOX "ALWAYS ALLOW" HOSTS (docs/SANDBOX.md § The allow-list; table `sandbox_allowed_hosts`,
// migration 0173). Per WORKSPACE, nothing inherited. Every write takes the rule through
// `validateReaderRule` (the proxy's own parser), so what is stored is what the proxy matches.
import { and, asc, eq } from 'drizzle-orm';
import { validateReaderRule } from '../sandbox/proxy/allow-list.js';
import { db, schema } from './client.js';

const { sandboxAllowedHosts, workspaces } = schema;

export async function listSandboxAllowedHosts(accountId: number, workspaceId: number): Promise<string[]> {
  const rows = await db
    .select({ rule: sandboxAllowedHosts.rule })
    .from(sandboxAllowedHosts)
    .where(and(eq(sandboxAllowedHosts.accountId, accountId), eq(sandboxAllowedHosts.workspaceId, workspaceId)))
    .orderBy(asc(sandboxAllowedHosts.rule))
    .execute();
  return rows.map((r) => r.rule);
}

export type AddAllowedHostResult = { ok: true; rule: string; added: boolean } | { ok: false; reason: string };

/** Add one rule. `added: false` when it was already there. Refuses a workspace the account does not own. */
export async function addSandboxAllowedHost(accountId: number, workspaceId: number, text: string): Promise<AddAllowedHostResult> {
  const v = validateReaderRule(text);
  if (!v.ok) return v;
  const owned = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .execute();
  if (owned.length === 0) return { ok: false, reason: 'No such workspace.' };
  const inserted = await db
    .insert(sandboxAllowedHosts)
    .values({ accountId, workspaceId, rule: v.rule })
    .onConflictDoNothing({ target: [sandboxAllowedHosts.accountId, sandboxAllowedHosts.workspaceId, sandboxAllowedHosts.rule] })
    .returning({ id: sandboxAllowedHosts.id })
    .execute();
  return { ok: true, rule: v.rule, added: inserted.length > 0 };
}

/** Remove one rule (given in any spelling the parser accepts). True when a row went. */
export async function removeSandboxAllowedHost(accountId: number, workspaceId: number, text: string): Promise<boolean> {
  const v = validateReaderRule(text);
  const rule = v.ok ? v.rule : text.trim().toLowerCase();
  const gone = await db
    .delete(sandboxAllowedHosts)
    .where(and(eq(sandboxAllowedHosts.accountId, accountId), eq(sandboxAllowedHosts.workspaceId, workspaceId), eq(sandboxAllowedHosts.rule, rule)))
    .returning({ id: sandboxAllowedHosts.id })
    .execute();
  return gone.length > 0;
}
