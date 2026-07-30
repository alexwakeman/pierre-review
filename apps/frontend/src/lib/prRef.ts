// Display-only commit-headline cleanup for the trunk strip. Lives in its own module (rather than
// inside BranchStatusPanel.tsx) so it can be exercised as a pure function — see
// apps/frontend/test/prRef.test.ts.

// GitHub's GraphQL `messageHeadline` is ITSELF truncated — roughly 70 characters, terminated with
// a literal U+2026 HORIZONTAL ELLIPSIS. That is the one character we look for; GitHub does not use
// three dots, and a headline that genuinely ends '...' must be left alone.
const ELLIPSIS = '…';

// A squash-merge headline already ENDS with "(#1234)", so printing the chip next to it would show
// the same number twice inside a row that must stay one line. Display-only (the stored headline is
// untouched), and a trailing ref naming a DIFFERENT number — a revert quoting another PR — is
// deliberately left alone.
//
// The ref is also the FIRST thing GitHub's own truncation eats, because it sits at the very end of
// the subject: a long headline arrives as '… on `CalculatedClip` removal (#2…', where
// `endsWith(' (#25207)')` is false. Trimming only the complete form left the row printing the chip
// #25207 immediately followed by a dangling '(#2…' — the same number twice, the second one
// unreadable, which is precisely what this function exists to prevent. ~3% of one real account's
// 302 stored trunk commits hit that case, so it is the common shape, not a corner.
//
// The truncated form is therefore trimmed too, under a deliberately narrow rule: strip the
// ellipsis, and the remainder must end with ' (#' plus a NON-EMPTY prefix of our own PR number and
// nothing else. Requiring at least one matching digit is what stops this from eating an unrelated
// parenthetical that merely happened to be cut at ' (' (e.g. 'Add support (…') — such a
// fragment carries no duplicated number, so it is left visible as the truncation hint it is.
//
// No replacement ellipsis is added: when GitHub cut into the trailing ref, everything it dropped
// was the ref, so the text preceding it is the COMPLETE subject.
//
// Residual (shared with the complete-suffix branch above, and accepted): a headline whose trailing
// ref quotes a different PR whose digits happen to prefix ours — '(#123…' under prNumber 1234
// — is trimmed as if it were ours. It costs a truncated fragment, never a wrong number: the chip
// renders its own value and says so in its title.
export function trimTrailingPrRef(headline: string, prNumber: number | null): string {
  if (prNumber == null) return headline;
  const suffix = ` (#${prNumber})`;
  if (headline.endsWith(suffix)) return headline.slice(0, -suffix.length);
  if (!headline.endsWith(ELLIPSIS)) return headline;

  const body = headline.slice(0, -ELLIPSIS.length);
  const open = ' (#';
  const at = body.lastIndexOf(open);
  if (at < 0) return headline;
  // Runs to the end of `body` by construction, so this is the WHOLE tail after ' (#'.
  const digits = body.slice(at + open.length);
  // `startsWith` on the all-digit `String(prNumber)` also proves `digits` is digits-only, so a
  // fragment like ' (#see' can never match.
  if (digits.length === 0 || !String(prNumber).startsWith(digits)) return headline;
  return body.slice(0, at);
}
