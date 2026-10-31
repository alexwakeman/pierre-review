import type { RepoStatusTone } from '@pierre-review/shared';
import { cx } from './ui/cx.js';

// THE TWO REPO DOTS, drawn by ONE component so the sidebar row and the status panel at the top of
// the repo view paint the same mark for the same meaning (shared `repoStatusSummary`):
//   red  ('attention') — something here needs someone to act;
//   blue ('new')       — new on PRs you have opened, since you last opened them.
// Decorative: whoever draws it carries the words (an accessible name, or the line beside it).

export const REPO_DOT_CLASS: Record<RepoStatusTone, string> = {
  attention: 'bg-ui-danger',
  new: 'bg-ui-accent',
};

export function RepoStatusDot({
  tone,
  title,
  className,
  testId,
}: {
  tone: RepoStatusTone;
  title?: string;
  className?: string;
  testId?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden
      title={title}
      data-testid={testId}
      data-tone={tone}
      className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', REPO_DOT_CLASS[tone], className)}
    />
  );
}
