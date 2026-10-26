import type { ThreadDetail, User } from '@pierre-review/shared';
import { MlSeverityBadge, worstSeverity } from '../MlSeverityBadge.js';
import { mlLabelKey, useMlLabelIndex, useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { ShowOnTimeline } from '../ShowOnTimeline.js';
import { CommentBlock } from './CommentBlock.js';
import { CodeAnchor } from './CodeAnchor.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { ArrowIcon, ExternalLinkIcon } from '../Icons.js';
import { ResolveThread } from './ResolveThread.js';
import { ReplyComposer } from './ReplyComposer.js';
import { isNewComment } from './NewCommentHighlight.js';
import { ClaudeThreadReason, ThreadStatePill } from './ClaudeThreadBadge.js';

// A single review thread rendered conversation-first: the code it's anchored to
// sits inside the opening comment, replies follow as plain conversation.
export function ThreadCard({
  thread,
  usersById,
  prUrl,
  repoId,
  selected,
  viewedSince,
  highlightCommentId,
  onOpenInPr,
  openInChanges,
}: {
  thread: ThreadDetail;
  usersById: Map<number, User>;
  prUrl: string;
  repoId?: number;
  selected?: boolean;
  viewedSince?: string | null;
  // When set, ONLY this comment is marked "new" (the Activity feed highlights the
  // specific comment a card represents). When null/undefined, fall back to the
  // viewedSince heuristic (the Changes tab's Threads only view).
  highlightCommentId?: number | null;
  // When provided, the whole card HEADER becomes a clickable region that deep-links this thread
  // inside its PR (search results + theme drill-downs) — a large, discoverable target. The
  // header's own controls (Show-on-timeline / addressed / resolve, all <button>s) keep working
  // via a closest() guard. Inert (a plain header) when omitted.
  onOpenInPr?: () => void;
  /**
   * "Show in context" — this thread's code in the Changes tab. Optional because only ONE of
   * ThreadCard's mounts can honour it: the Changes tab's Threads only view (`ThreadList`), which
   * sits in the Changes tab without showing the code. The mount inside FileDiffView (the
   * InlineThread pill's expansion) is already in the code, and the Feed / search / attention /
   * themes mounts have no Changes tab at all — they navigate INTO a PR instead (`onOpenInPr`).
   *
   * `approximate` drives the wording, and the honesty matters: for a thread whose live `line` is
   * gone, the target is reconstructed from the anchor hunk and is the line in the commit the
   * comment was WRITTEN against, so it can land a little off. `line: null` means the file was
   * resolvable but no line was — the jump reveals the file. The caller supplies no handler at all
   * when the file has left the changeset, so the control is absent rather than dead.
   */
  openInChanges?: { run: () => void; approximate: boolean; line: number | null } | null;
}): JSX.Element {
  const anchorHunk = thread.comments[0]?.diffHunk ?? null;
  const lineLabel = thread.line != null ? `line ${thread.line}` : 'file-level';
  // ONE shared per-PR query, whichever of the seven ThreadCard mount sites this is. React Query
  // dedupes it across every card on the same PR, and it is skipped entirely when the deployment
  // has no severity-api (npx), so an OSS install issues nothing.
  const mlEnabled = useMlSeverityEnabled();
  const mlIndex = useMlLabelIndex(thread.prId, mlEnabled);
  // The thread's WORST non-summary severity — triage without expanding the conversation.
  //
  // ⚠ SUPPRESSED ON A ONE-COMMENT THREAD, AND THE KEY IS THE COMMENT COUNT, NOT THE SURFACE. With
  // a single comment `worstSeverity` returns THAT comment's own row, so the header pill and the
  // per-comment badge below it were provably the same label ~30px apart — and the single-comment
  // thread is the commonest shape there is. The per-comment badge is the one kept because it is
  // strictly the richer of the two: it carries the CATEGORY and the vendor's contradicting claim,
  // both of which the compact rollup deliberately drops (MlSeverityBadge's `compact` note).
  //
  // The rollup is NOT dead chrome, so do not remove it outright and do not key the suppression on
  // the SURFACE instead: on a multi-comment thread it is the one place the conversation's WORST
  // severity is stated, and reading it off the per-comment badges means scanning every reply. A
  // long back-and-forth is exactly where a reader triages from the header alone.
  const threadWorst =
    mlIndex && thread.comments.length > 1
      ? worstSeverity(
          thread.comments
            .map((c) => mlIndex.get(mlLabelKey('review_comment', c.id)))
            .filter((l): l is NonNullable<typeof l> => l != null),
        )
      : undefined;

  return (
    <div
      className={`rounded-md border px-2.5 py-2 ${
        selected
          ? 'border-amber-400 bg-amber-400/5'
          : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      <div
        className={`mb-2 flex items-center gap-2 text-[11px] text-gray-400${
          onOpenInPr
            ? ' -mx-1 cursor-pointer rounded px-1 hover:bg-sky-50 dark:hover:bg-sky-950/20'
            : ''
        }`}
        role={onOpenInPr ? 'button' : undefined}
        tabIndex={onOpenInPr ? 0 : undefined}
        title={onOpenInPr ? 'Open this thread in its PR' : undefined}
        onClick={
          onOpenInPr
            ? (e) => {
                // Clicking anywhere on the header opens the thread in its PR — EXCEPT the header's
                // own controls (all <button>s), which keep working via the closest() guard.
                if ((e.target as HTMLElement).closest('a,button,input,textarea,[data-noactivate]'))
                  return;
                onOpenInPr();
              }
            : undefined
        }
        onKeyDown={
          onOpenInPr
            ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenInPr();
                }
              }
            : undefined
        }
      >
        {/* State pill anchored top-LEFT on every thread card — so a resolved (or otherwise-
            stateful) thread is legible at a glance without expanding it, and all thread cards
            read uniformly. The freshest Claude judgement REPLACES the state pill and the confidence
            marker with TWO pills when there is one (lib/claudeThreadMarker.ts). */}
        <ThreadStatePill thread={thread} withConfidence />
        {/* The worst ML severity anywhere in this conversation (summaries excluded). Renders
            nothing when no comment in the thread is labelled — which is also the state of every
            thread on a deployment with no model. */}
        <MlSeverityBadge label={threadWorst} compact />
        <ShowOnTimeline
          prId={thread.prId}
          at={thread.createdAt}
          event={{ type: 'review_comment', refId: thread.id }}
          title="Show this thread on the timeline"
        />
        <span className="decorative-mark text-gray-300 dark:text-gray-600">·</span>
        <span
          className={
            onOpenInPr
              ? 'font-medium text-gray-500 underline decoration-dotted underline-offset-2 dark:text-gray-400'
              : undefined
          }
        >
          {lineLabel}
        </span>
        {thread.isOutdated && <span>· outdated</span>}
        {/* "SHOW IN CONTEXT" — from the Changes tab's Threads only view back to the code: it
            turns that view off, opens the file and scrolls to this thread's pill. A real <button>
            so ThreadCard's header-click guard (`closest('a,button,…')`) swallows it — a
            <span onClick> here would ALSO fire `onOpenInPr` and navigate away. */}
        {openInChanges != null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openInChanges.run();
            }}
            className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/40"
            title={
              openInChanges.line == null
                ? 'Show this file’s code. This thread’s line is no longer in the diff.'
                : openInChanges.approximate
                  ? `Show line ~${openInChanges.line} in the code. The thread is outdated, so the line is worked out from the code it was written on.`
                  : `Show line ${openInChanges.line} in the code`
            }
          >
            <ArrowIcon size={10} className="mr-0.5 inline-block align-[-0.1em]" />
            {openInChanges.line == null
              ? 'Show file'
              : openInChanges.approximate
                ? 'Show in context ~'
                : 'Show in context'}
          </button>
        )}
        <span className="ml-auto flex items-center">
          <ResolveThread
            prId={thread.prId}
            threadId={thread.id}
            isResolved={thread.isResolved}
          />
        </span>
      </div>

      {/* Claude's one-line reason under its two pills; the longer explanation opens on demand. */}
      <ClaudeThreadReason thread={thread} />

      <div className="space-y-3">
        {thread.comments.map((c, i) => (
          <CommentBlock
            key={c.id}
            comment={c}
            usersById={usersById}
            repoId={repoId}
            mlLabel={mlIndex?.get(mlLabelKey('review_comment', c.id))}
            isNew={
              highlightCommentId != null
                ? c.id === highlightCommentId
                : isNewComment(c.createdAt, viewedSince)
            }
            anchor={
              i === 0 ? (
                <CodeAnchor
                  diffHunk={anchorHunk}
                  path={thread.path}
                  threadId={thread.id}
                />
              ) : undefined
            }
            // Replies get their own "Show" (the root is covered by the card-header
            // link above). All review-comment events share the thread's refId, so
            // navigation disambiguates the specific reply by its createdAt instant.
            showLink={
              i > 0 ? (
                <ShowOnTimeline
                  prId={thread.prId}
                  at={c.createdAt}
                  event={{ type: 'review_comment', refId: thread.id }}
                  title="Show this reply on the timeline"
                />
              ) : undefined
            }
          />
        ))}
      </div>

      <div className="mt-2 space-y-1.5 pl-2 text-[11px]">
        <ReplyComposer prId={thread.prId} threadId={thread.id} />
        <div>
          <a
            href={safeExternalUrl(thread.url) ?? `${prUrl}/files`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />{' '}
            {thread.url ? 'View thread on GitHub' : 'Reply on GitHub'}
          </a>
        </div>
      </div>
    </div>
  );
}
