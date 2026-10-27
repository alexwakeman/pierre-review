// THE SEVERITY LABEL on every comment Limn posts for a finding, and the chip the PR details pane
// draws on Limn's own posted threads and comments (docs/CLAUDE-REVIEW.md § Severity labels).
//
// ONE word per severity (`limnSeverityLabel`), ONE lead-line builder (`limnSeverityLead`), and ONE
// seam that decides which severity a posted finding carries (`severityForPostedFinding`). The
// GitHub comment builders (backend review/post-review.ts) and the pane's chip (via the wire field
// `limnSeverity`, db/limn-finding-severity.ts) both go through that seam, so what GitHub shows and
// what the pane shows can never disagree.
//
// Praise is never posted, so it has no label.
import type { ClaudeFindingSeverity } from './types.js';

/** A severity Limn posts with a label: every finding severity but praise. */
export type LimnSeverity = Exclude<ClaudeFindingSeverity, 'praise'>;

export const LIMN_SEVERITY_WORD: Record<LimnSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
};

export function isLimnSeverity(s: unknown): s is LimnSeverity {
  return s === 'blocker' || s === 'warning' || s === 'nit' || s === 'question';
}

/** The word for a severity ("Warning"), or null for praise / none. */
export function limnSeverityLabel(severity: ClaudeFindingSeverity | null | undefined): string | null {
  return isLimnSeverity(severity) ? LIMN_SEVERITY_WORD[severity] : null;
}

/**
 * THE GRADER SEAM. The severity a POSTED finding carries — on its GitHub comment and on the pane's
 * chip. Today it is the review's own severity. A later bot-comment grader (the ML severity model
 * that already rates other bots' comments) replaces THIS function's body, and nothing else: every
 * comment builder and the chip's wire mapping read the severity only through here.
 */
export function severityForPostedFinding(f: { severity?: ClaudeFindingSeverity | null }): LimnSeverity | null {
  return isLimnSeverity(f.severity) ? f.severity : null;
}

/**
 * The first line of a posted finding comment: the bold severity word, then " · " and each extra
 * part that is set — an optional `tag` (a provider name such as "Codex" on a paired post) and an
 * optional `ref` (a `path:line` reference, already formatted, e.g. "`src/x.ts:42`").
 *   "**Warning**" · "**Warning** · `src/x.ts:42`" · "**Warning** · Codex · `src/x.ts:42`"
 * Null when the severity has no label (praise, or none given) — the caller then keeps its old lead.
 */
export function limnSeverityLead(
  severity: ClaudeFindingSeverity | null | undefined,
  opts?: { tag?: string | null; ref?: string | null },
): string | null {
  const word = limnSeverityLabel(severity);
  if (word == null) return null;
  const parts = [`**${word}**`];
  const tag = opts?.tag?.trim();
  if (tag) parts.push(tag);
  const ref = opts?.ref?.trim();
  if (ref) parts.push(ref);
  return parts.join(' · ');
}

// A lead line as `limnSeverityLead` writes it, at the very start of a body.
const LEAD_RE = /^\*\*(?:Blocker|Warning|Nit|Question)\*\*(?: · [^\n]*)?(?:\n+|$)/;

/**
 * The body without its leading severity line, if it has one. For matchers that compare a posted
 * comment's START with a finding's text (backend finding-thread.ts): a comment posted before the
 * label existed has no lead and is returned unchanged.
 */
export function stripLimnSeverityLead(body: string): string {
  return body.replace(LEAD_RE, '');
}
