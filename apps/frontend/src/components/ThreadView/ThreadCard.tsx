import type { ThreadDetail, User } from '@pierre-review/shared';
import { StateBadge } from '../StateBadge.js';
import { ConfidenceBadge } from '../ConfidenceBadge.js';
import { ReviewCheckButton, ThreadCheckOutput } from '../CommentAnnotations.js';
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
  onOpenInThreads,
}: {
  thread: ThreadDetail;
  usersById: Map<number, User>;
  prUrl: string;
  repoId?: number;
  selected?: boolean;
  viewedSince?: string | null;
  // When set, ONLY this comment is marked "new" (the Activity feed highlights the
  // specific comment a card represents). When null/undefined, fall back to the
  // viewedSince heuristic (the PR-detail Threads tab).
  highlightCommentId?: number | null;
  // When provided, the whole card HEADER becomes a clickable region that deep-links this thread
  // inside its PR (search results + theme drill-downs) — a large, discoverable target. The
  // header's own controls (Show-on-timeline / addressed / resolve, all <button>s) keep working
  // via a closest() guard. Inert (a plain header) when omitted.
  onOpenInPr?: () => void;
  /**
   * "Show this thread's code in the Changes tab." Optional because only ONE of ThreadCard's seven
   * mounts can honour it: `ChangesTab` has a single mount (PrDetail), so only the Threads-tab
   * mount sits beside a Changes tab without BEING one. The single mount inside FileDiffView (the
   * InlineThread pill's expansion — both the table and binary branches route through it) is
   * already in the diff, and the Feed / search / attention / themes mounts have no Changes tab at
   * all — they navigate INTO a PR instead (`onOpenInPr`).
   *
   * `approximate` drives the wording, and the honesty matters: for a thread whose live `line` is
   * gone, the target is reconstructed from the anchor hunk and is the line in the commit the
   * comment was WRITTEN against, so it can land a little off. `line: null` means the file was
   * resolvable but no line was — the jump reveals the file. The caller supplies no handler at all
   * when the file has left the changeset, so the control is absent rather than dead.
   */
  openInChanges?: { run: () => void; approximate: boolean; line: number | null } | null;
  /**
   * "Show this thread in the Threads tab" — the RETURN leg, supplied only by the inline mount
   * inside the diff. Threads render inline in Changes already, so this is not about finding the
   * conversation; it is about getting to the tab that has the filters, the resolve controls and
   * the whole file's other threads.
   */
  onOpenInThreads?: () => void;
}): JSX.Element {
  const anchorHunk = thread.comments[0]?.diffHunk ?? null;
  const lineLabel = thread.line != null ? `line ${thread.line}` : 'file-level';
  // ONE shared per-PR query, whichever of the seven ThreadCard mount sites this is. React Query
  // dedupes it across every card on the same PR, and it is skipped entirely when the deployment
  // has no severity-api (npx), so an OSS install issues nothing.
  const mlEnabled = useMlSeverityEnabled();
  const mlIndex = useMlLabelIndex(thread.prId, mlEnabled);
  // The thread's WORST non-summary severity — triage without expanding the conversation.
  const threadWorst = mlIndex
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
            read uniformly. */}
        <StateBadge state={thread.derivedState} />
        {thread.derivedState === 'likely_addressed' && (
          <ConfidenceBadge
            confidence={thread.addressedConfidence}
            reason={thread.addressedReason}
          />
        )}
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
        <span className="text-gray-300 dark:text-gray-600">·</span>
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
        {/* THE JUMP INTO THE DIFF. A real <button> so ThreadCard's header-click guard
            (`closest('a,button,…')`) swallows it — a <span onClick> here would ALSO fire
            `onOpenInPr` and navigate away from the PR the reader is already in. */}
        {openInChanges != null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openInChanges.run();
            }}
            className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-blue-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/40"
            title={
              openInChanges.line == null
                ? 'Show this file in the Changes tab — this thread’s line is no longer in the diff'
                : openInChanges.approximate
                  ? `Show line ~${openInChanges.line} in the Changes tab (approximate: this thread’s anchor is outdated, so the line is reconstructed from the code it was written against)`
                  : `Show line ${openInChanges.line} in the Changes tab`
            }
          >
            <ArrowIcon size={10} className="mr-0.5 inline-block align-[-0.1em]" />
            {openInChanges.line == null
              ? 'File in Changes'
              : openInChanges.approximate
                ? 'In Changes ~'
                : 'In Changes'}
          </button>
        )}
        {onOpenInThreads != null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenInThreads();
            }}
            className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-blue-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/40"
            title="Open this thread in the Threads tab"
          >
            <ArrowIcon size={10} className="mr-0.5 inline-block align-[-0.1em]" />
            In Threads
          </button>
        )}
        {/* Pro (prSummary): the ONE AI check, spent on this thread alone — rewrite its wall of bot
            text, sanity-check the point, and judge what is actually still open. Deliberately NOT
            gated on `!thread.isResolved`: the rewrite and the validity read are still worth having
            on a resolved thread, and the server omits the addressed judgement for one, so no extra
            judgement is billed that the PR-wide run would not have produced anyway. */}
        <ReviewCheckButton
          prId={thread.prId}
          target={{ targetKind: 'thread', targetId: thread.id }}
        />
        <span className="ml-auto flex items-center">
          <ResolveThread
            prId={thread.prId}
            threadId={thread.id}
            isResolved={thread.isResolved}
          />
        </span>
      </div>

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
                <CodeAnchor diffHunk={anchorHunk} threadId={thread.id} />
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

      {/* Pro (prSummary): the WHOLE "Check review" output for this thread, in ONE block, directly
          under the conversation — i.e. under the last reply, which is where the old standalone
          "Comment check" panel sat. The three judgements key on three different ids (a rewrite per
          comment, validity on the root comment, addressed on the thread), so they cannot be one
          <CommentAnnotations>; ThreadCheckOutput assembles them off the same shared per-PR query.
          Renders NOTHING — and issues no request of its own — when the thread has none.

          COUPLED TO THE BUTTON ABOVE by the anchor, not by a prop: while a check is in flight
          against ('thread', thread.id) this block drops the previous result for a placeholder
          sweep, so changing the button's target without changing that would silently leave the
          stale judgements on screen for the whole re-run. */}
      <ThreadCheckOutput thread={thread} usersById={usersById} />

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
