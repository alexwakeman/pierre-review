// "COPY ALL" ON THE CLAUDE REVIEW TAB'S FINDINGS SECTION: every finding the reader has not set
// aside, as ONE markdown string to paste into their own coding agent.
//
// Pure, so the rules are testable without a DOM:
//   - IGNORED findings are left out, by the SAME rule the card fades them with (`isIgnoredFinding`):
//     `included === false` counts only on the editable run and only while unposted — an older run,
//     or a posted finding, shows no Ignore state, so it must not silently vanish from the copy.
//   - PRAISE is left out (the tab already hides it; this guards a caller that forgot).
//   - THE READER'S REWORD WINS over Claude's body. Unlike the per-card Copy (Claude's original, by
//     design), this copy is a hand-off of what the reader decided to say.
//   - Blocks are separated by a line holding only `---`.
import type { ClaudeFinding } from '@pierre-review/shared';

type CopyableFinding = Pick<
  ClaudeFinding,
  'severity' | 'title' | 'path' | 'line' | 'body' | 'editedBody' | 'suggestion' | 'included' | 'postedAt'
>;

/** The card's own Ignore rule: only the editable run, only an unposted finding, can be ignored. */
export function isIgnoredFinding(f: Pick<ClaudeFinding, 'included' | 'postedAt'>, editable: boolean): boolean {
  return editable && f.postedAt == null && !f.included;
}

/** The findings "Copy all" carries: not praise, not ignored. Order is the caller's (on-screen). */
export function copyableFindings<T extends CopyableFinding>(findings: readonly T[], editable: boolean): T[] {
  return findings.filter((f) => f.severity !== 'praise' && !isIgnoredFinding(f, editable));
}

const SEVERITY_WORD: Record<ClaudeFinding['severity'], string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
  praise: 'Praise',
};

/** One finding as a markdown block: heading, location, body (reword wins), suggestion fence. */
export function findingMarkdownBlock(f: CopyableFinding): string {
  const parts: string[] = [`### ${SEVERITY_WORD[f.severity]}: ${f.title}`];
  // No file at all = a finding about the whole change (posts as a PR comment).
  if (f.path === '') parts.push('Whole PR');
  else parts.push(`\`${f.line != null ? `${f.path}:${f.line}` : f.path}\``);
  const body = f.editedBody != null && f.editedBody.trim() !== '' ? f.editedBody : f.body;
  if (body.trim() !== '') parts.push(body.trim());
  if (f.suggestion != null && f.suggestion.trim() !== '') {
    parts.push(`\`\`\`suggestion\n${f.suggestion}\n\`\`\``);
  }
  return parts.join('\n\n');
}

/** Every copyable finding, separated by `---` lines. Empty string when there are none. */
export function findingsMarkdown(findings: readonly CopyableFinding[], editable: boolean): string {
  return copyableFindings(findings, editable).map(findingMarkdownBlock).join('\n\n---\n\n');
}
