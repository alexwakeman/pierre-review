import type { SuggestedReposResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

/**
 * Where a first-run (zero-repo) account lands, decided ONCE per page load by `useWorkspaceShell`.
 *
 * - `'none'`: the account has repos — no first-run landing at all.
 * - `'wait'`: something is still loading (`repos`, or the suggestions for an empty account).
 *   `undefined` is "still loading", never "empty"; open nothing yet.
 * - `'onboarding'`: we found repos the reader works on — the `FirstRunOnboarding` panel shows
 *   them, so the manager stays shut.
 * - `'manager'`: nothing found (or the lookup failed) — open "Manage repos & workspaces".
 */
export type FirstRunLanding = 'none' | 'wait' | 'onboarding' | 'manager';

export function firstRunLanding(
  repos: readonly unknown[] | undefined,
  suggestions: { results: readonly unknown[] } | undefined,
  suggestionsFailed: boolean,
): FirstRunLanding {
  if (repos == null) return 'wait';
  if (repos.length > 0) return 'none';
  if (suggestionsFailed) return 'manager';
  if (suggestions == null) return 'wait';
  return suggestions.results.length > 0 ? 'onboarding' : 'manager';
}

/**
 * The ONE `['repo-suggested']` query, shared by `FirstRunOnboarding` (which lists the results) and
 * `useWorkspaceShell` (which decides the landing from them) so it is one fetch.
 */
export const suggestedReposQuery = {
  queryKey: ['repo-suggested'] as const,
  queryFn: (): Promise<SuggestedReposResponse> => api.suggestedRepos(),
  staleTime: 5 * 60_000,
};
