import type { CommentDetail, MlLabel, User } from '@pierre-review/shared';
import { CopyButton } from '../CopyButton.js';
import { MlSeverityBadge } from '../MlSeverityBadge.js';
import { ReactionBar } from '../ReactionBar.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { relativeTime } from '../../lib/ui.js';
import { NewTag } from './NewCommentHighlight.js';

// One comment in a thread conversation. The first block carries the code
// anchor (passed as `anchor`); replies are conversation only. `showLink` is an
// optional "Show on timeline" affordance (a reply navigates to its own marker —
// the thread root already has the card-header link), rendered left-aligned like
// the parent thread's.
export function CommentBlock({
  comment,
  usersById,
  repoId,
  isNew,
  anchor,
  showLink,
  mlLabel,
}: {
  comment: CommentDetail;
  usersById: Map<number, User>;
  repoId?: number;
  isNew?: boolean;
  anchor?: JSX.Element | null;
  showLink?: JSX.Element;
  // The ML severity/category label for THIS comment, already looked up by the parent from the
  // one shared per-PR index. Passed down rather than fetched here: a hook in this component
  // would run once per comment, which is the shape of the request storm the annotation surface
  // was rebuilt to avoid. Undefined ⇒ no badge, no placeholder.
  mlLabel?: MlLabel;
}): JSX.Element {
  const user = comment.authorId != null ? usersById.get(comment.authorId) : undefined;
  return (
    <div className={`pl-2 ${isNew ? 'comment-new' : ''}`}>
      <div className="flex items-center gap-2 text-xs">
        {showLink && (
          <>
            {showLink}
            <span className="text-gray-300 dark:text-gray-600">·</span>
          </>
        )}
        <Avatar user={user} size={18} />
        <UserName
          user={user}
          fallbackId={comment.authorId}
          repoId={repoId}
          className="font-semibold"
        />
        <span className="text-gray-400">{relativeTime(comment.createdAt)}</span>
        {isNew && <NewTag />}
        <MlSeverityBadge label={mlLabel} />
        {/* Right-aligned so it lands in the same place on every comment regardless of how many
            badges precede it — a control that moves per row is one the eye has to hunt for.
            `ml-auto` rather than a spacer keeps the header's existing gap rhythm intact. */}
        <CopyButton text={comment.body} className="ml-auto" />
      </div>
      {anchor && <div className="mt-1.5">{anchor}</div>}
      {/* NO annotation surface here any more. The AI "Simplified" rewrite used to sit above each
          comment body, which scattered up to five panels through one conversation; all of a
          thread's judgements now render as ONE block under the whole conversation
          (ThreadCheckOutput in ThreadCard). The "original is below, unchanged" invariant survives
          — the entire conversation is above that block — and each rewrite is sublabelled with
          whose comment it rewrites, since it is no longer adjacent to it. */}
      <div className="mt-1 text-sm">
        <Markdown>{comment.body}</Markdown>
      </div>
      {/* Emoji reactions, directly under the text they react to. THIS ONE MOUNT reaches all
          eight ThreadCard mount sites (Threads tab, Feed, search results, attention cards, the
          Pro themes drill-down and both diff views) — which is the whole reason the reaction
          loader batches per tick rather than per PR: the Feed spans many PRs, so a per-PR index
          route could not have served it. Renders nothing (and issues no request of its own)
          when the comment has no reactions and the viewer may not add one. */}
      <ReactionBar kind="review_comment" id={comment.id} className="mt-1.5" />
    </div>
  );
}
