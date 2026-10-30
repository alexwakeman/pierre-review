import { and, eq, inArray } from 'drizzle-orm';
import { STORY_BUILD_OPEN_STATUSES, type SprintNodeBuild, type StoryBuildRepoStatus, type StoryBuildStatus } from '@pierre-review/shared';

// THIS SPRINT → the card's BUILD MARK ("Implement story", docs/STORY-BUILD.md § Sprint card). One BATCHED
// read on the graph GET (and the change-token GET, which shares the fold): the latest OPEN session per
// sprint ticket, with its repository counts — two queries whatever the sprint's size, DB only, never a
// model / tracker / GitHub call. Coarse on purpose: it rides `changeToken`, so a running build moves the
// token only when its status or counts move.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY (the pure fold below is unit-tested without one).

const CHUNK = 400;

export interface SessionRow {
  id: number;
  ident: string;
  status: StoryBuildStatus;
}

export interface SessionRepoRow {
  buildId: number;
  include: boolean;
  status: StoryBuildRepoStatus;
}

/** The fold: the newest open session per ident (highest id), with its included repositories counted. Pure. */
export function foldSprintBuilds(sessions: readonly SessionRow[], repos: readonly SessionRepoRow[]): Map<string, SprintNodeBuild> {
  const latest = new Map<string, SessionRow>();
  for (const s of sessions) {
    if (!STORY_BUILD_OPEN_STATUSES.includes(s.status)) continue;
    const prev = latest.get(s.ident);
    if (prev == null || s.id > prev.id) latest.set(s.ident, s);
  }
  const counts = new Map<number, { ready: number; pushed: number }>();
  for (const r of repos) {
    if (!r.include) continue;
    const c = counts.get(r.buildId) ?? { ready: 0, pushed: 0 };
    if (r.status === 'ready') c.ready += 1;
    else if (r.status === 'pushed') c.pushed += 1;
    counts.set(r.buildId, c);
  }
  const out = new Map<string, SprintNodeBuild>();
  for (const [ident, s] of latest) {
    const c = counts.get(s.id) ?? { ready: 0, pushed: 0 };
    out.set(ident, { id: s.id, status: s.status, readyRepos: c.ready, pushedRepos: c.pushed });
  }
  return out;
}

/** The sprint tickets' build marks, by ident. Callers pass AI-on only (AI off ⇒ the field is null). */
export async function sprintBuildsFor(accountId: number, workspaceId: number, idents: readonly string[]): Promise<Map<string, SprintNodeBuild>> {
  if (idents.length === 0) return new Map();
  const { db, schema } = await import('./client.js');
  const b = schema.storyBuilds;
  const r = schema.storyBuildRepos;
  const sessions: SessionRow[] = [];
  const unique = [...new Set(idents)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await db
      .select({ id: b.id, ident: b.ident, status: b.status })
      .from(b)
      .where(
        and(
          eq(b.accountId, accountId),
          eq(b.workspaceId, workspaceId),
          inArray(b.ident, unique.slice(i, i + CHUNK)),
          inArray(b.status, [...STORY_BUILD_OPEN_STATUSES]),
        ),
      )
      .execute();
    for (const x of rows) sessions.push({ id: x.id, ident: x.ident, status: x.status as StoryBuildStatus });
  }
  if (sessions.length === 0) return new Map();
  const ids = [...new Set(sessions.map((s) => s.id))];
  const repos: SessionRepoRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({ buildId: r.buildId, include: r.include, status: r.status })
      .from(r)
      .where(and(eq(r.accountId, accountId), inArray(r.buildId, ids.slice(i, i + CHUNK))))
      .execute();
    for (const x of rows) repos.push({ buildId: x.buildId, include: x.include, status: x.status as StoryBuildRepoStatus });
  }
  return foldSprintBuilds(sessions, repos);
}
