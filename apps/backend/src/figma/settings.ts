import { and, eq } from 'drizzle-orm';
import type { WorkspaceFigmaSettings, WorkspaceFigmaUpdate } from '@pierre-review/shared';
import { hostSeal, type SonarDb } from '../sonar/settings.js';
import { openTrackerToken, storeTrackerToken, type HostSeal, type OpenedToken } from '../tracker/secret.js';

// THE WORKSPACE'S FIGMA TOKEN (`workspace_figma`, migration 0213). ONE row per workspace; no row = none.
//
// ⚠ THE TOKEN IS WRITE-ONLY AND SEALED (tracker/secret.ts forms, as SonarCloud's): nothing here returns it;
// the settings answer carries `hasToken` only. The one reader of the opened value is
// `readWorkspaceFigmaToken`, whose callers send it to api.figma.com and nowhere else.
// Every function takes the db + schema (`SonarDb`): a test passes its own scratch database.

export type FigmaDb = SonarDb;

async function readRow(c: FigmaDb, accountId: number, workspaceId: number): Promise<{ authToken: string | null } | null> {
  const t = c.schema.workspaceFigma;
  const rows = (await c.db
    .select({ authToken: t.authToken })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute()) as Array<{ authToken: string | null }>;
  return rows[0] ?? null;
}

/** The setting as the screen shows it. The caller has checked the workspace is the account's. */
export async function readWorkspaceFigma(c: FigmaDb, accountId: number, workspaceId: number, seal: HostSeal = hostSeal()): Promise<WorkspaceFigmaSettings> {
  const opened = openTrackerToken(seal, (await readRow(c, accountId, workspaceId))?.authToken);
  return { workspaceId, hasToken: opened.state !== 'none', tokenUnreadable: opened.state === 'unreadable' };
}

export type FigmaWriteResult = { ok: true; settings: WorkspaceFigmaSettings } | { ok: false; message: string };

/** Save or remove the token. The caller has checked the workspace is the account's. */
export async function writeWorkspaceFigma(c: FigmaDb, accountId: number, workspaceId: number, patch: WorkspaceFigmaUpdate, seal: HostSeal = hostSeal()): Promise<FigmaWriteResult> {
  if (patch.token != null && patch.clearToken === true) return { ok: false, message: 'Save a token or remove it, not both.' };
  const token = typeof patch.token === 'string' ? patch.token.trim() : '';
  if (patch.clearToken !== true && token === '') return { ok: false, message: 'Paste a Figma personal access token.' };
  const authToken = patch.clearToken === true ? null : storeTrackerToken(seal, token);
  const t = c.schema.workspaceFigma;
  await c.db
    .insert(t)
    .values({ accountId, workspaceId, authToken })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: { authToken, updatedAt: new Date() } })
    .execute();
  return { ok: true, settings: await readWorkspaceFigma(c, accountId, workspaceId, seal) };
}

/** ⚠ The OPENED token: never return it from a route, never log it. */
export async function readWorkspaceFigmaToken(c: FigmaDb, accountId: number, workspaceId: number, seal: HostSeal = hostSeal()): Promise<OpenedToken> {
  return openTrackerToken(seal, (await readRow(c, accountId, workspaceId))?.authToken);
}
