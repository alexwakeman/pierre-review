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
import { ghRestGetFor } from '../github/client.js';

interface IssueComment {
  user?: { login?: string | null } | null;
  performed_via_github_app?: { id?: number; slug?: string } | null;
}

// True when ANY conversation comment on the PR was posted via a GitHub App. A coarse
// PR-level signal (the classifier already has the per-author fingerprint/typename) —
// enough to promote an otherwise human-looking App-backed reviewer. Never throws:
// a failed/absent call returns false so the enrich can't break a sync.
export async function fetchAppAttribution(
  token: string,
  owner: string,
  name: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const comments = await ghRestGetFor<IssueComment[]>(
      token,
      `/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`,
    );
    if (!Array.isArray(comments)) return false;
    return comments.some((c) => c?.performed_via_github_app != null);
  } catch {
    return false;
  }
}
