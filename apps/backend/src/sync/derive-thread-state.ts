import type { AddressedConfidence, DerivedState } from '@pierre-review/shared';
import { reviewBotKind } from './bot-detection.js';
import { matchBotResolutionMarker } from './bot-resolution-markers.js';

export type { DerivedState };

export interface ThreadComment {
  author: { login: string } | null;
  createdAt: string; // ISO-8601
  // Comment body — used ONLY for bot resolution-marker detection. Optional so callers that
  // don't need marker detection (or run lean without bodies) can omit it.
  body?: string | null;
}

export interface ThreadInput {
  isResolved: boolean;
  path: string;
  comments: ThreadComment[];
  // GitHub's own "the anchored lines no longer exist at head" flag — the sharpest deterministic
  // "the code at this location changed" signal. Defaults false when a caller omits it.
  isOutdated?: boolean;
  // GitHub login of whoever resolved the thread (from `resolvedBy`), null/undefined when
  // unresolved — lets us grade a bot self-resolve as high confidence.
  resolvedByLogin?: string | null;
}

export interface CommitInput {
  oid: string;
  committedDate: string; // ISO-8601
}

// The full derived classification: the 4-state enum (unchanged contract) plus an ADDITIVE
// deterministic addressed-confidence grade + a compact machine reason tag explaining it.
export interface ThreadStateResult {
  state: DerivedState;
  addressedConfidence: AddressedConfidence;
  addressedReason: string | null;
}

// Did the originating review bot post a resolution marker in a LATER comment? Returns the
// bot's vendor kind (for the reason tag) or null. Only bot-authored later comments are considered.
function detectBotMarker(thread: ThreadInput): string | null {
  for (let i = 1; i < thread.comments.length; i++) {
    const c = thread.comments[i];
    const login = c?.author?.login;
    if (!login || !c) continue;
    const kind = reviewBotKind(login);
    if (!kind) continue;
    if (c.body && matchBotResolutionMarker(kind, c.body)) return kind;
  }
  return null;
}

/**
 * Classify a review thread into one of four states AND grade how confident we are it was
 * addressed. The state enum is the load-bearing contract (eligibility keys elsewhere); the
 * confidence + reason are additive and advisory.
 *
 * State rule (keeps the 4 values; `likely_addressed` now also fires on `isOutdated` or a bot
 * resolution-marker):
 * - `resolved`           — GitHub marked the thread resolved.
 * - `likely_addressed`   — a later commit touched the file, OR GitHub marked it outdated, OR the
 *                          originating bot posted a resolution marker. Heuristic (false positives
 *                          from unrelated edits/rebases) — the confidence grade + UI say so.
 * - `replied_unresolved` — someone other than the original commenter replied, no follow-up.
 * - `untouched`          — none of the above.
 *
 * Confidence grade (advisory): both outdated+commit or a bot marker/self-resolve → `high`; a
 * single change signal → `medium`; a bare reply → `low`; nothing → `none`.
 *
 * @param prCommitsByDate  PR commits sorted ascending by committedDate.
 * @param commitFilesBySha SHA -> changed file paths.
 */
export function deriveThreadState(
  thread: ThreadInput,
  prCommitsByDate: CommitInput[],
  commitFilesBySha: Map<string, string[]>,
): ThreadStateResult {
  const isOutdated = thread.isOutdated ?? false;
  const firstAuthor = thread.comments[0]?.author?.login ?? null;
  const originatingBotKind = firstAuthor ? reviewBotKind(firstAuthor) : null;

  // Did the originating review bot resolve its OWN thread?
  const resolverKind = reviewBotKind(thread.resolvedByLogin);
  const selfResolvedByBot =
    thread.resolvedByLogin != null &&
    resolverKind != null &&
    (originatingBotKind == null ||
      resolverKind === originatingBotKind ||
      thread.resolvedByLogin === firstAuthor);

  if (thread.isResolved) {
    return {
      state: 'resolved',
      addressedConfidence: 'high',
      addressedReason: selfResolvedByBot ? 'self-resolved' : 'resolved',
    };
  }

  // A thread with no comments can't be classified further.
  const lastComment = thread.comments.at(-1);
  if (!lastComment) {
    return { state: 'untouched', addressedConfidence: 'none', addressedReason: null };
  }

  const latestCommentAt = Date.parse(lastComment.createdAt);
  const hasSubsequentCommitToFile = prCommitsByDate.some((c) => {
    if (Date.parse(c.committedDate) <= latestCommentAt) return false;
    return (commitFilesBySha.get(c.oid) ?? []).includes(thread.path);
  });

  const botMarkerKind = detectBotMarker(thread);

  if (hasSubsequentCommitToFile || isOutdated || botMarkerKind != null) {
    // Precedence: a bot's own resolution marker is the strongest single signal; then
    // outdated+commit corroboration; then either change signal alone (medium — an outdated
    // flag can come from a rebase / unrelated nearby edit, so it isn't `high` by itself).
    let addressedConfidence: AddressedConfidence;
    let addressedReason: string;
    if (botMarkerKind != null) {
      addressedConfidence = 'high';
      addressedReason = `bot-marker:${botMarkerKind}`;
    } else if (isOutdated && hasSubsequentCommitToFile) {
      addressedConfidence = 'high';
      addressedReason = 'outdated+commit';
    } else if (hasSubsequentCommitToFile) {
      addressedConfidence = 'medium';
      addressedReason = 'commit';
    } else {
      addressedConfidence = 'medium';
      addressedReason = 'outdated';
    }
    return { state: 'likely_addressed', addressedConfidence, addressedReason };
  }

  const hasReply = thread.comments.some(
    (c) => c.author?.login && c.author.login !== firstAuthor,
  );
  if (hasReply) {
    return { state: 'replied_unresolved', addressedConfidence: 'low', addressedReason: 'replied' };
  }

  return { state: 'untouched', addressedConfidence: 'none', addressedReason: null };
}
