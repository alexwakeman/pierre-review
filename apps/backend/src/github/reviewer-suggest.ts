import type { ReviewerSuggestion, User } from '@pierre-review/shared';
import { getAccessToken } from '../auth/account.js';
import { isLikelyBot } from '../sync/bot-detection.js';
import { getCodeownersMatch, type CodeownersMatch } from './codeowners.js';
import { suggestTeamsFromHistory } from './team-reviewers.js';

// Shared reviewer-suggestion enrichment — the ONE place CODEOWNERS ownership (users + @org/team)
// and inferred team history are layered on top of a base set of (already bot-filtered) history
// USER suggestions. Used by BOTH the PR-detail "Suggested reviewers" row (api/routes/prs.ts) and
// the Insights `reviewer_routing` card (db/queries.ts getTeamInsights), so the two surfaces can
// never diverge — bots are structurally impossible (the base already dropped them via
// getReviewerLogins) and teams are first-class in both.
//
// Precedence: declared CODEOWNERS owners, then CODEOWNERS teams, then inferred (history) team(s),
// then the base history-user picks; dedup users by login and teams by slug; cap 5.
//
// Best-effort: any network failure (no CODEOWNERS, org SSO wall, a repo that doesn't use team
// requests) degrades cleanly to just the base user suggestions. `resolveUsers` is injected so this
// stays free of any db/queries import (no circular dependency); callers pass getUsersByLogins.
export async function enrichReviewerSuggestions(opts: {
  accountId: number;
  owner: string;
  name: string;
  authorLogin: string | null; // dropped from CODEOWNERS user suggestions (no self-review)
  paths: string[];
  userSuggestions: ReviewerSuggestion[]; // base history (user) picks — already bot-filtered
  knownUserIds: Set<number>; // ids the caller already has (so extraUsers only carries NEW ones)
  resolveUsers: (logins: string[]) => Promise<User[]>;
}): Promise<{ suggestions: ReviewerSuggestion[]; extraUsers: User[] }> {
  const { accountId, owner, name, authorLogin, paths, userSuggestions, knownUserIds, resolveUsers } =
    opts;
  const extraUsers: User[] = [];
  let merged: ReviewerSuggestion[] = userSuggestions;
  try {
    const token = await getAccessToken(accountId);
    const emptyMatch: CodeownersMatch = { logins: [], teams: [] };
    const [match, historyTeams] = await Promise.all([
      paths.length > 0
        ? getCodeownersMatch(token, owner, name, accountId, paths)
        : Promise.resolve(emptyMatch),
      suggestTeamsFromHistory(token, owner, name, accountId),
    ]);

    // Resolve @user owners to synced users (avatar/link); unsynced owners show login-only.
    // Exclude the PR author (GitHub rejects self-review requests).
    const uniqueLogins = [...new Set(match.logins)].filter((l) => l !== authorLogin);
    const resolved = await resolveUsers(uniqueLogins);
    const byLogin = new Map(resolved.map((u) => [u.githubLogin, u]));

    // NEVER suggest a bot, even one declared in CODEOWNERS. The history base is already
    // bot-filtered (getReviewerLogins); CODEOWNERS @user handles are raw and unfiltered, so a
    // CODEOWNERS-listed bot would otherwise slip through here. Drop synced bots (users.isBot) and
    // best-effort drop unsynced bot-ish logins ([bot] suffix / known vendor / known bot).
    const ownerLogins = uniqueLogins.filter((login) => {
      const u = byLogin.get(login);
      return u ? !u.isBot : !isLikelyBot(login);
    });

    const codeownerUsers: ReviewerSuggestion[] = ownerLogins.map((login) => ({
      kind: 'user',
      login,
      userId: byLogin.get(login)?.id ?? null,
      teamSlug: null,
      teamName: null,
      reason: 'owns this path (CODEOWNERS)',
      source: 'codeowners',
    }));
    const codeownerTeams: ReviewerSuggestion[] = match.teams.map((t) => ({
      kind: 'team',
      login: null,
      userId: null,
      teamSlug: t.slug,
      teamName: t.name,
      reason: 'owns this path (CODEOWNERS)',
      source: 'codeowners',
    }));
    const historyTeamSuggestions: ReviewerSuggestion[] = historyTeams.map((t) => ({
      kind: 'team',
      login: null,
      userId: null,
      teamSlug: t.slug,
      teamName: t.name,
      reason: `usually requested here (${t.count} recent PR${t.count === 1 ? '' : 's'})`,
      source: 'history',
    }));

    // Merge = precedence: CODEOWNERS users, CODEOWNERS teams (declared), inferred teams, then
    // the base history-user suggestions. Dedup users by login and teams by slug (so a team that's
    // both a CODEOWNER and historically requested shows once, as the CODEOWNER).
    const seenLogins = new Set<string>();
    const seenTeams = new Set<string>();
    merged = [];
    for (const s of [
      ...codeownerUsers,
      ...codeownerTeams,
      ...historyTeamSuggestions,
      ...userSuggestions,
    ]) {
      if (s.kind === 'team') {
        if (s.teamSlug && !seenTeams.has(s.teamSlug)) {
          seenTeams.add(s.teamSlug);
          merged.push(s);
        }
      } else if (s.login && !seenLogins.has(s.login)) {
        seenLogins.add(s.login);
        merged.push(s);
      }
    }
    // The newly-resolved codeowner users the caller didn't already carry.
    for (const u of resolved) if (!knownUserIds.has(u.id)) extraUsers.push(u);
  } catch {
    /* best-effort: fall back to the base history-user suggestions */
  }
  return { suggestions: merged.slice(0, 5), extraUsers };
}
