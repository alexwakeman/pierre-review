import { GITHUB_TRACKER_ROOT, canonicalTicketKey, isGithubIssueKey, parseGithubIssueKey } from '@pierre-review/shared';
import type { DetectedTicket, TrackerAdapter } from '../types.js';
import { githubLinker, LINK_ISSUE_CAP } from './links.js';
import { fetchGithubIssue, githubErrorMessage } from './reader.js';

// GITHUB ISSUES — the second reading adapter (docs/TRACKERS.md § GitHub Issues).
//
//   IDENTITY    every row lives on ONE site, `https://github.com`; the KEY is `owner/repo#12`
//               (lower-cased), because one PR may close issues in several repositories. The ident
//               names the repository in its root: `github:https://github.com/owner/repo#12`
//               (shared `trackerTicketIdent`).
//   LINKING     EXACT — the issues the PR CLOSES (`closingIssuesReferences`), read by ./links.ts and
//               stored on the PR. Not the title, not the branch, never a bare "#12".
//   FETCH       ./reader.ts — one GraphQL call per issue with the account's own token.
//   CREDENTIAL  'none': nothing to save. The account's GitHub sign-in reads it.
export const githubAdapter: TrackerAdapter = {
  provider: 'github',
  label: 'GitHub',
  fixedBaseUrl: GITHUB_TRACKER_ROOT,
  siteRoot: () => GITHUB_TRACKER_ROOT,
  isKey: isGithubIssueKey,
  normalizeKey: (raw) => {
    const k = canonicalTicketKey(raw);
    return k != null && isGithubIssueKey(k) ? k : null;
  },
  browseUrl: (_base, key) => {
    const p = parseGithubIssueKey(key);
    return p != null ? `${GITHUB_TRACKER_ROOT}/${p.owner}/${p.repo}/issues/${p.number}` : GITHUB_TRACKER_ROOT;
  },
  detect: (_cfg, pr) => {
    const out: DetectedTicket[] = [];
    for (const raw of pr.closingIssues ?? []) {
      const key = canonicalTicketKey(raw);
      if (key == null || !isGithubIssueKey(key) || out.some((d) => d.key === key)) continue;
      out.push({ key, from: 'link', order: out.length });
      if (out.length >= LINK_ISSUE_CAP) break;
    }
    return out;
  },
  reader: {
    credential: 'none',
    fetchTicket: (call, key) => fetchGithubIssue(call, key),
    errorMessage: (err) => githubErrorMessage(err),
  },
  linker: githubLinker,
};
