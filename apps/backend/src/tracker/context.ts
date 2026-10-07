import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { GithubCallAccess, GithubGqlResult } from './types.js';

// THE TRACKER'S ONE CONTEXT ARGUMENT — the `AgentContext` precedent (review/agent-context.ts). The
// issue tracker moved from the private plugin into CORE at apiVersion 23 (docs/TRACKERS.md); its
// modules kept the plugin's `ctx` parameter shape so the move stayed a move, but every member is
// now built from DIRECT core imports (`buildTrackerContext`, ./runtime.ts) — never `ProContext`.
// Tests hand in a fake one (an in-memory SQLite, a fake seal), exactly like the plugin's tests did.
//
// `schema` is the CORE schema module (the tracker's own tables are `trackerTickets`,
// `jiraAcFields`, `workspaceTrackers`), typed loosely like AgentContext's so a test can pass a
// structural subset.

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TrackerLog {
  warn(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface TrackerContext {
  log: TrackerLog;
  host: {
    isCloud: boolean;
    // SEAL / OPEN a secret at rest (core auth/crypto.ts AES-256-GCM). Present ONLY when the process
    // has a valid ENCRYPTION_KEY — always in cloud, locally only when the operator set one. Absent,
    // the token is stored `plain:` (./secret.ts), the same trust as that machine's `gh` token.
    sealSecret?: (plain: string) => string;
    openSecret?: (sealed: string) => string;
  };
  accountIdOf(req: FastifyRequest): number;
  db: any;
  schema: Record<string, any>;
  isPg: boolean;
  // The account's Default workspace (core `ensureDefaultWorkspace`) — the `?workspace=` fallback.
  defaultWorkspaceId(accountId: number): Promise<number>;
  // GitHub GraphQL as ONE account (the GitHub Issues adapter). The token is resolved per call from
  // the account (`getAccessToken`) — never cached. Absent in a test that does not need it.
  github?: {
    graphql<T>(accountId: number, query: string, variables: Record<string, unknown>): Promise<GithubGqlResult<T>>;
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function parseWorkspaceId(raw: string | number | undefined | null): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The workspace id when it is one of this account's, else null. */
export async function ownedWorkspaceId(
  ctx: TrackerContext,
  accountId: number,
  raw: string | number | undefined | null,
): Promise<number | null> {
  const id = parseWorkspaceId(raw);
  if (id == null) return null;
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.id, id), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

/**
 * `?workspace=` resolution, the rule every scoped route follows: absent / unparseable / unknown /
 * ANOTHER TENANT'S id all degrade to the account's DEFAULT workspace — never a 404, so it is not an
 * existence oracle.
 */
export async function resolveRequestWorkspaceId(
  ctx: TrackerContext,
  accountId: number,
  raw: string | number | undefined | null,
): Promise<number> {
  return (await ownedWorkspaceId(ctx, accountId, raw)) ?? (await ctx.defaultWorkspaceId(accountId));
}

/** Split into chunks of 500 ids so an IN list stays well inside both dialects' limits. */
export async function inChunks<T>(ids: readonly number[], read: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...(await read(ids.slice(i, i + 500))));
  return out;
}

/** The account's GitHub access for a reader call, or undefined when the context has none. */
export function githubAccessFor(ctx: TrackerContext, accountId: number): GithubCallAccess | undefined {
  const gh = ctx.github;
  if (gh == null) return undefined;
  return { accountId, graphql: (query, variables) => gh.graphql(accountId, query, variables) };
}
