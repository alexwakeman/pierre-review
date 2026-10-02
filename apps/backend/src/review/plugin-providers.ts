import type { ClaudeReviewTicket } from '@pierre-review/shared';

// OPTIONAL PRO ENRICHMENTS FOR THE FREE AGENTIC FEATURES. Claude Review and AI Fix are core; two
// of their inputs come from Pro surfaces that stayed in the plugin:
//
//   resolveReviewTicket — the Jira fill. Free Claude Review checks a PR against a story the reader
//     PASTES; with the plugin's Jira tracker configured, an AUTO review (no browser to paste into)
//     asks this for the PR's detected tickets. Absent ⇒ the auto run goes out with no story,
//     exactly as on a workspace with no tracker.
//   readCiAnalysisSeed — AI Fix's `ci_analysis` seed. The CI-failure analysis is a Pro Haiku card
//     whose rows live in the plugin's `ai_pr_analyses`; core cannot name that table. Absent, or no
//     stored analysis ⇒ the seed is refused as `missing` ("Analyze the CI failure first"), never
//     run as an unseeded fix wearing the label.
//
// The plugin registers them through the OPTIONAL `ProContext.registerAgenticProviders` member
// (bind.ts). Both are best-effort: a throw is treated as "nothing available".
export interface AgenticProviders {
  resolveReviewTicket?(
    accountId: number,
    prId: number,
  ): Promise<{
    // The first detected ticket (an older plugin answers only this).
    ticket: ClaudeReviewTicket | null;
    key: string | null;
    // EVERY detected ticket that could be read, in detection order (core keeps at most
    // CLAUDE_REVIEW_MAX_TICKETS). Absent ⇒ read `ticket` as a one-element list.
    tickets?: ClaudeReviewTicket[];
  }>;
  // The stored diagnosis's text ALREADY STRIPPED of its confidence footer, the head it diagnosed,
  // and when it was written. null = none stored.
  readCiAnalysisSeed?(
    accountId: number,
    prId: number,
  ): Promise<{ text: string; headSha: string | null; createdAt: Date | number | null } | null>;
}

let providers: AgenticProviders = {};

export function registerAgenticProviders(p: AgenticProviders): void {
  providers = { ...providers, ...p };
}

export function getAgenticProviders(): AgenticProviders {
  return providers;
}

/** Test hook. */
export function _resetAgenticProvidersForTest(): void {
  providers = {};
}
