import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { LocalUser } from '@gh-team-monitor/shared';
import { db, schema } from '../db/client.js';

const { localUser, users } = schema;

const STALE_MS = 24 * 60 * 60 * 1000; // re-fetch once a day

interface GhUser {
  login: string;
  node_id: string;
  avatar_url: string | null;
}

function fetchFromGh(): GhUser | null {
  try {
    const out = execFileSync('gh', ['api', 'user'], { encoding: 'utf-8' });
    const parsed = JSON.parse(out) as Partial<GhUser>;
    if (!parsed.login || !parsed.node_id) return null;
    return {
      login: parsed.login,
      node_id: parsed.node_id,
      avatar_url: parsed.avatar_url ?? null,
    };
  } catch {
    // gh missing / not authed / offline — non-fatal; my-turn just stays empty.
    return null;
  }
}

/**
 * Ensure the locally-authenticated GitHub user is cached. Refetches via
 * `gh api user` on first run and once per day; otherwise returns the cached
 * row. Never throws — failure leaves "you" unknown and triage degrades
 * gracefully to empty.
 */
export function ensureLocalUser(): LocalUser | null {
  const existing = db.select().from(localUser).where(eq(localUser.id, 1)).get();
  const fresh =
    existing && Date.now() - existing.cachedAt.getTime() < STALE_MS;
  if (existing && fresh) {
    return {
      login: existing.githubLogin,
      githubId: existing.githubId,
      avatarUrl: existing.avatarUrl,
    };
  }

  const gh = fetchFromGh();
  if (!gh) {
    // Fall back to a stale cached value if we have one.
    return existing
      ? {
          login: existing.githubLogin,
          githubId: existing.githubId,
          avatarUrl: existing.avatarUrl,
        }
      : null;
  }

  db.insert(localUser)
    .values({
      id: 1,
      githubLogin: gh.login,
      githubId: gh.node_id,
      avatarUrl: gh.avatar_url,
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: localUser.id,
      set: {
        githubLogin: gh.login,
        githubId: gh.node_id,
        avatarUrl: gh.avatar_url,
        cachedAt: new Date(),
      },
    })
    .run();

  return { login: gh.login, githubId: gh.node_id, avatarUrl: gh.avatar_url };
}

/** Cached local user without triggering a network fetch. */
export function getLocalUser(): LocalUser | null {
  const row = db.select().from(localUser).where(eq(localUser.id, 1)).get();
  return row
    ? { login: row.githubLogin, githubId: row.githubId, avatarUrl: row.avatarUrl }
    : null;
}

/**
 * Resolve the local user to a row in `users` (by login) if they've appeared in
 * any synced repo. Returns null when "you" haven't authored/acted anywhere yet.
 */
export function getLocalUserId(): number | null {
  const local = getLocalUser();
  if (!local) return null;
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubLogin, local.login))
    .get();
  return row?.id ?? null;
}
