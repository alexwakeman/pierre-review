import type { DerivedState } from '@gh-team-monitor/shared';

export type { DerivedState };

export interface ThreadComment {
  author: { login: string } | null;
  createdAt: string; // ISO-8601
}

export interface ThreadInput {
  isResolved: boolean;
  path: string;
  comments: ThreadComment[];
}

export interface CommitInput {
  oid: string;
  committedDate: string; // ISO-8601
}

/**
 * Classify a review thread into one of four states. The signal that makes this
 * tool useful beyond GitHub's own UI.
 *
 * - `resolved`           — GitHub marked the thread resolved.
 * - `likely_addressed`   — a commit touched the thread's file *after* the last
 *                          comment. Heuristic: false positives when a file is
 *                          touched for unrelated reasons, false negatives when
 *                          feedback was addressed by deleting/renaming a file.
 * - `replied_unresolved` — someone other than the original commenter replied,
 *                          but no subsequent commit touched the file.
 * - `untouched`          — none of the above.
 *
 * @param prCommitsByDate  PR commits sorted ascending by committedDate.
 * @param commitFilesBySha SHA -> changed file paths.
 */
export function deriveThreadState(
  thread: ThreadInput,
  prCommitsByDate: CommitInput[],
  commitFilesBySha: Map<string, string[]>,
): DerivedState {
  if (thread.isResolved) return 'resolved';

  // A thread with no comments can't be classified further.
  const lastComment = thread.comments.at(-1);
  if (!lastComment) return 'untouched';

  const latestCommentAt = Date.parse(lastComment.createdAt);

  const hasSubsequentCommitToFile = prCommitsByDate.some((c) => {
    if (Date.parse(c.committedDate) <= latestCommentAt) return false;
    return (commitFilesBySha.get(c.oid) ?? []).includes(thread.path);
  });
  if (hasSubsequentCommitToFile) return 'likely_addressed';

  const firstAuthor = thread.comments[0]?.author?.login;
  const hasReply = thread.comments.some(
    (c) => c.author?.login && c.author.login !== firstAuthor,
  );
  if (hasReply) return 'replied_unresolved';

  return 'untouched';
}
