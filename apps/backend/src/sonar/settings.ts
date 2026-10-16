import { and, asc, eq } from 'drizzle-orm';
import {
  SONAR_KEY_PATTERN,
  defaultSonarProjectKey,
  type WorkspaceSonarRepo,
  type WorkspaceSonarSettings,
  type WorkspaceSonarUpdate,
} from '@pierre-review/shared';
import { decryptToken, encryptToken, sealingAvailable } from '../auth/crypto.js';
import { openTrackerToken, storeTrackerToken, type HostSeal, type OpenedToken } from '../tracker/secret.js';

// THE WORKSPACE'S SONARCLOUD SETTINGS (`workspace_sonar`, migration 0114 / pg 0101). ONE row per
// workspace; a missing row reads as "not set up".
//
// ⚠ THE TOKEN IS WRITE-ONLY AND SEALED. It is stored through tracker/secret.ts (`sealed:v1:` when
// the process holds an ENCRYPTION_KEY — always in cloud — else `plain:`, the same trust as the
// machine's `gh` token), and NOTHING here returns it: the settings answer carries `hasToken` only.
// The one reader of the opened value is `readSonarAccess`, whose callers send it to SonarCloud and
// nowhere else.
//
// Every function takes the db + schema it should use (`SonarDb`), never imports the client: a
// review-side test passes its own scratch database (CLAUDE.md, "test imports leak into real DB").

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SonarDb {
  db: any;
  schema: Record<string, any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The process's sealing functions (core AES-256-GCM when a key exists). */
export function hostSeal(): HostSeal {
  return sealingAvailable() ? { sealSecret: encryptToken, openSecret: decryptToken } : {};
}

const KEY_RE = new RegExp(SONAR_KEY_PATTERN);

interface Row {
  organization: string | null;
  authToken: string | null;
  projectKeys: Record<string, string> | null;
}

async function readRow(c: SonarDb, accountId: number, workspaceId: number): Promise<Row | null> {
  const t = c.schema.workspaceSonar;
  const rows = (await c.db
    .select({ organization: t.organization, authToken: t.authToken, projectKeys: t.projectKeys })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute()) as Row[];
  return rows[0] ?? null;
}

/** The workspace's repos, by name — the settings list and the project-key defaults. */
async function workspaceRepos(
  c: SonarDb,
  accountId: number,
  workspaceId: number,
): Promise<Array<{ repoId: number; owner: string; name: string }>> {
  const { workspaceRepos: wr, repos: r } = c.schema;
  return (await c.db
    .select({ repoId: r.id, owner: r.owner, name: r.name })
    .from(wr)
    .innerJoin(r, and(eq(r.id, wr.repoId), eq(r.accountId, accountId)))
    .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
    .orderBy(asc(r.owner), asc(r.name))
    .execute()) as Array<{ repoId: number; owner: string; name: string }>;
}

function repoEntry(
  repo: { repoId: number; owner: string; name: string },
  overrides: Record<string, string> | null,
): WorkspaceSonarRepo {
  const defaultKey = defaultSonarProjectKey(repo.owner, repo.name);
  const saved = overrides?.[String(repo.repoId)];
  const overridden = typeof saved === 'string' && saved !== '' && saved !== defaultKey;
  return {
    repoId: repo.repoId,
    fullName: `${repo.owner}/${repo.name}`,
    projectKey: overridden ? saved : defaultKey,
    defaultKey,
    overridden,
  };
}

/** The settings as the screen shows them. The caller has checked the workspace is the account's. */
export async function readWorkspaceSonar(
  c: SonarDb,
  accountId: number,
  workspaceId: number,
  seal: HostSeal = hostSeal(),
): Promise<WorkspaceSonarSettings> {
  const [row, repos] = await Promise.all([
    readRow(c, accountId, workspaceId),
    workspaceRepos(c, accountId, workspaceId),
  ]);
  const opened = openTrackerToken(seal, row?.authToken);
  return {
    workspaceId,
    organization: row?.organization ?? null,
    hasToken: opened.state !== 'none',
    tokenUnreadable: opened.state === 'unreadable',
    repos: repos.map((r) => repoEntry(r, row?.projectKeys ?? null)),
  };
}

/** Why a patch is refused, as a sentence; null when it is fine. */
export function sonarPatchError(
  patch: WorkspaceSonarUpdate,
  repoIds: ReadonlySet<number>,
): string | null {
  if (patch.organization != null && patch.organization !== '' && !KEY_RE.test(patch.organization.trim())) {
    return 'That is not a SonarCloud organization key.';
  }
  if (patch.token != null && patch.clearToken === true) return 'Save a token or remove it, not both.';
  for (const [id, key] of Object.entries(patch.projectKeys ?? {})) {
    const n = Number(id);
    if (!Number.isInteger(n) || !repoIds.has(n)) return 'A project key names a repository outside this workspace.';
    if (key != null && key !== '' && !KEY_RE.test(key.trim())) return 'That is not a SonarCloud project key.';
  }
  return null;
}

export type SonarWriteResult = { ok: true; settings: WorkspaceSonarSettings } | { ok: false; message: string };

/** Apply a partial patch. The caller has checked the workspace is the account's. */
export async function writeWorkspaceSonar(
  c: SonarDb,
  accountId: number,
  workspaceId: number,
  patch: WorkspaceSonarUpdate,
  seal: HostSeal = hostSeal(),
): Promise<SonarWriteResult> {
  const repos = await workspaceRepos(c, accountId, workspaceId);
  const refused = sonarPatchError(patch, new Set(repos.map((r) => r.repoId)));
  if (refused != null) return { ok: false, message: refused };
  const row = await readRow(c, accountId, workspaceId);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ('organization' in patch) {
    const o = patch.organization?.trim() ?? '';
    set.organization = o === '' ? null : o;
  }
  if (patch.clearToken === true) set.authToken = null;
  else if (typeof patch.token === 'string' && patch.token.trim() !== '') {
    set.authToken = storeTrackerToken(seal, patch.token.trim());
  }
  if (patch.projectKeys != null) {
    const byName = new Map(repos.map((r) => [r.repoId, defaultSonarProjectKey(r.owner, r.name)]));
    // Keep only overrides for repos still in the workspace; a key equal to the default is no override.
    const next: Record<string, string> = {};
    for (const [id, key] of Object.entries(row?.projectKeys ?? {})) {
      if (byName.has(Number(id))) next[id] = key;
    }
    for (const [id, key] of Object.entries(patch.projectKeys)) {
      const k = key?.trim() ?? '';
      if (k === '' || k === byName.get(Number(id))) delete next[id];
      else next[id] = k;
    }
    set.projectKeys = Object.keys(next).length > 0 ? next : null;
  }
  const t = c.schema.workspaceSonar;
  await c.db
    .insert(t)
    .values({
      accountId,
      workspaceId,
      organization: (set.organization as string | null | undefined) ?? null,
      authToken: (set.authToken as string | null | undefined) ?? null,
      projectKeys: (set.projectKeys as Record<string, string> | null | undefined) ?? null,
    })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set })
    .execute();
  return { ok: true, settings: await readWorkspaceSonar(c, accountId, workspaceId, seal) };
}

/** What a SonarCloud call for one PR needs, resolved from the PR's workspace. Server-side only. */
export interface SonarAccess {
  workspaceId: number;
  organization: string | null;
  token: OpenedToken;
  projectKey: string;
  // For the PR's own repository.
  owner: string;
  name: string;
  prNumber: number;
}

/**
 * The SonarCloud access for the workspace holding this PR's repo. null when the PR is not the
 * account's or its repo has no workspace. ⚠ Carries the OPENED token: never return it from a route.
 */
export async function readSonarAccessForPr(
  c: SonarDb,
  accountId: number,
  prId: number,
  seal: HostSeal = hostSeal(),
): Promise<SonarAccess | null> {
  const { workspaceRepos: wr, pullRequests: prs, repos: r } = c.schema;
  const rows = (await c.db
    .select({ workspaceId: wr.workspaceId, repoId: r.id, owner: r.owner, name: r.name, prNumber: prs.number })
    .from(prs)
    .innerJoin(r, and(eq(r.id, prs.repoId), eq(r.accountId, accountId)))
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number; repoId: number; owner: string; name: string; prNumber: number }>;
  const hit = rows[0];
  if (!hit) return null;
  const row = await readRow(c, accountId, hit.workspaceId);
  const entry = repoEntry({ repoId: hit.repoId, owner: hit.owner, name: hit.name }, row?.projectKeys ?? null);
  return {
    workspaceId: hit.workspaceId,
    organization: row?.organization ?? null,
    token: openTrackerToken(seal, row?.authToken),
    projectKey: entry.projectKey,
    owner: hit.owner,
    name: hit.name,
    prNumber: hit.prNumber,
  };
}

/** Has the workspace an organization AND a token saved (readable or not)? */
export function sonarConfigured(a: Pick<SonarAccess, 'organization' | 'token'> | null): boolean {
  return a != null && a.organization != null && a.token.state !== 'none';
}

/** The workspace's saved token, opened — for the connection check. Server-side only. */
export async function readWorkspaceSonarToken(
  c: SonarDb,
  accountId: number,
  workspaceId: number,
  seal: HostSeal = hostSeal(),
): Promise<{ organization: string | null; token: OpenedToken }> {
  const row = await readRow(c, accountId, workspaceId);
  return { organization: row?.organization ?? null, token: openTrackerToken(seal, row?.authToken) };
}
