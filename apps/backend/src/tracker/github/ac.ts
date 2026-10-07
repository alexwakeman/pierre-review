import { acSourceFieldId, extractAcceptanceCriteria, type AcResult, type AcSource } from '../ac.js';

// GITHUB ISSUES — WHERE AN ISSUE KEEPS ITS ACCEPTANCE CRITERIA. The rule is the shared one (../ac.ts:
// sub-issues → a task list → an "Acceptance criteria" section → none); this file only says how a
// GitHub sub-issue is cited (`#12`) and when it is done (CLOSED).

export interface GithubSubIssue {
  number: number;
  title: string;
  state: string; // 'OPEN' | 'CLOSED'
}

export type GithubAcSource = AcSource;
export type GithubAcResult = AcResult;

/** The candidate id the stored row names its criteria field by (never a Jira field id). */
export const githubAcFieldId = (source: GithubAcSource): string => acSourceFieldId('github', source);

/** The criteria of one issue and the description left once they are taken out of it. */
export function extractGithubAcceptanceCriteria(
  body: string | null | undefined,
  subIssues: readonly GithubSubIssue[] = [],
  subIssuesTotal: number = subIssues.length,
): GithubAcResult {
  return extractAcceptanceCriteria(
    body,
    subIssues.map((s) => ({ ref: `#${s.number}`, title: s.title, done: s.state.toUpperCase() === 'CLOSED' })),
    subIssuesTotal,
  );
}
