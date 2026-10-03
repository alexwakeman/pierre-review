import type { ClaudeReviewTicket } from '@pierre-review/shared';

// OPTIONAL PRO ENRICHMENTS FOR THE FREE AGENTIC FEATURES. Claude Review and AI Fix are core; one
// of their inputs comes from a Pro surface that stayed in the plugin:
//
//   resolveReviewTicket — the Jira fill. Free Claude Review checks a PR against a story the reader
//     PASTES; with the plugin's Jira tracker configured, an AUTO review (no browser to paste into)
//     asks this for the PR's detected tickets. Absent ⇒ the auto run goes out with no story,
//     exactly as on a workspace with no tracker.
//
// The plugin registers them through the OPTIONAL `ProContext.registerAgenticProviders` member
// (bind.ts). Best-effort: a throw is treated as "nothing available". (AI Fix's old
// `readCiAnalysisSeed` provider went with its `ci_analysis` seed; a plugin that still registers it
// is ignored.)
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
