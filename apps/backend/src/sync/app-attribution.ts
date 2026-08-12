// WS1f — opt-in app-attribution enrich (CORE, deterministic, NO AI).
//
// INERT BY DEFAULT. This is NOT wired into the sync loop — it costs one extra REST call
// per PR, and the app's one-GraphQL-query-per-PR sync is a core virtue. It is invoked
// ONLY when an account explicitly turns on "deep in-house detection"
// (Pro settings `bots.deepDetect`); the caller (a sync hook or the detected-reviewers
// route) passes the flag through to the classifier.
//
// `performed_via_github_app` is the deterministic "posted via a GitHub App" signal. It
// is REST-only, lives on issue/conversation comments + timeline events (not on review
// or inline-comment objects), and is null for PATs/OAuth — so it unmasks the
// user-to-server "looks human" App-backed automation case, but not a bare-PAT agent.
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { ghRestGetFor } from '../github/client.js';
import { db, schema } from '../db/client.js';

interface IssueComment {
  user?: { login?: string | null } | null;
  performed_via_github_app?: { id?: number; slug?: string } | null;
}

export interface AppAttribution {
  // ANY conversation comment on the PR was posted via a GitHub App — the coarse PR-level
  // signal the classifier promotes an otherwise human-looking App-backed reviewer on.
  viaApp: boolean;
  // Per-author App slugs observed on this PR — the fact this probe used to receive and
  // DISCARD. The advisor's discovery tier splits App-authored from Actions-authored
  // comments on the persisted `users.app_slug`.
  slugByLogin: Record<string, string>;
}

// Probe a PR's conversation comments for App attribution and PERSIST every observed
// (login → app slug) pair onto the global `users.app_slug` column. Never throws: a
// failed/absent call returns the empty attribution so the enrich can't break a sync.
export async function fetchAppAttribution(
  token: string,
  owner: string,
  name: string,
  prNumber: number,
): Promise<AppAttribution> {
  try {
    const comments = await ghRestGetFor<IssueComment[]>(
      token,
      `/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`,
    );
    if (!Array.isArray(comments)) return { viaApp: false, slugByLogin: {} };
    const slugByLogin: Record<string, string> = {};
    let viaApp = false;
    for (const c of comments) {
      if (c?.performed_via_github_app == null) continue;
      viaApp = true;
      const login = c.user?.login;
      const slug = c.performed_via_github_app.slug;
      if (login && slug) slugByLogin[login] = slug;
    }
    await persistAppSlugs(slugByLogin);
    return { viaApp, slugByLogin };
  } catch {
    return { viaApp: false, slugByLogin: {} };
  }
}

// Stamp observed App slugs onto `users.app_slug` (global table — the App identity is a fact
// about the actor, not a tenant). FILL-OR-UPDATE only: a null is filled, a DIFFERENT slug is
// updated (apps do get renamed), but a later app-less comment never clears an observed slug —
// most of a bot's comments carry no attribution object at all. Best-effort: a write failure
// must not turn a successful probe into an error.
export async function persistAppSlugs(slugByLogin: Record<string, string>): Promise<void> {
  const { users } = schema;
  for (const [login, slug] of Object.entries(slugByLogin)) {
    try {
      await db
        .update(users)
        .set({ appSlug: slug })
        .where(
          and(
            eq(users.githubLogin, login),
            or(isNull(users.appSlug), ne(users.appSlug, slug)),
          ),
        )
        .execute();
    } catch {
      /* best-effort — the probe's boolean is still good */
    }
  }
}
