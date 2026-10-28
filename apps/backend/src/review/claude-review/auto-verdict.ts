// THE VERDICT RULE an automatic post (and a Claude + Codex pair's one review) uses. Pure, and in its own
// module so the pair's consolidated view (./pair-view.ts) can compute the pair's verdict without
// importing the auto-post I/O. auto-post.ts re-exports `autoVerdictFor` under its old name.
import type { AutoVerdictEvent, ClaudeFinding, ClaudeReview } from '@pierre-review/shared';
import { isReaderIgnoredFinding } from './finding-facts.js';

/**
 * The verdict an auto post wants — Claude's, made STRICTER. Counts the run's non-story findings
 * a reader did not ignore (whatever the kind toggles say): any blocker ⇒ REQUEST_CHANGES; APPROVE only when
 * Claude approved and there is no warning either; everything else ⇒ COMMENT.
 */
export function autoVerdictFor(
  claudeVerdict: ClaudeReview['verdict'],
  findings: readonly (Pick<ClaudeFinding, 'severity' | 'included' | 'story'> &
    Partial<Pick<ClaudeFinding, 'postedAt' | 'priorFindingId'>>)[],
): AutoVerdictEvent {
  // ⚠ Everything except a READER'S ignore counts — a re-raise the server left out because its
  // comment is already on this commit is still an open issue (`isReaderIgnoredFinding`).
  const counted = findings.filter((f) => f.story == null && !isReaderIgnoredFinding(f));
  if (counted.some((f) => f.severity === 'blocker')) return 'REQUEST_CHANGES';
  if (claudeVerdict === 'APPROVE' && !counted.some((f) => f.severity === 'warning')) return 'APPROVE';
  return 'COMMENT';
}
