import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DerivedState,
  EventType,
  PrDetail as PrDetailT,
  PrFilesResponse,
  ReviewState,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import { usePr } from '../hooks/usePr.js';
import { usePrLiveRefresh } from '../hooks/usePrLiveRefresh.js';
import { usePrArmedIntent } from '../hooks/useAutoMerge.js';
import { useMe, useProCapabilities } from '../hooks/useTriage.js';
import { useRepos } from '../hooks/useTimeline.js';
import { usePrBotBehaviour } from '../hooks/useBotTriage.js';
import { api } from '../api/client.js';
import { useFilters, type PrDetailTab } from '../store/filters.js';
import { markUrlCorrection } from '../hooks/useUrlState.js';
import { parseTabKey, usePinnedTabs, type PinnedPr } from '../store/pinnedTabs.js';
import {
  buildQuotedReply,
  dateTime,
  indexUsers,
  PR_STATE_META,
  relativeTime,
  safeExternalUrl,
} from '../lib/ui.js';
import { Avatar } from './CommentCard.js';
import { CopyButton } from './CopyButton.js';
import { UserName } from './UserName.js';
import { ShowOnTimeline, PrFocusMetaContext } from './ShowOnTimeline.js';
import {
  ExternalLinkIcon,
  FeedIcon,
  MagnifierIcon,
  OctocatIcon,
  RefreshIcon,
  TimelineIcon,
} from './Icons.js';
import { ThreadList } from './ThreadList/index.js';
import { BotTriageCard } from './BotTriageCard.js';
import { ChecksTab } from './ChecksTab.js';
import { CommentAnnotations, ReviewCheckButton } from './CommentAnnotations.js';
import type { MlSeverity } from '@pierre-review/shared';
import { MlSeverityBadge } from './MlSeverityBadge.js';
import { ReactionBar } from './ReactionBar.js';
import { mlLabelKey, useMlLabelIndex, useMlSeverityEnabled } from '../hooks/useMlLabels.js';
import { ChangesTab } from './ChangesTab.js';
import { anchorLineFromHunk } from '../lib/diff.js';
import type { DiffFocusTarget } from './diff/FileDiffView.js';
import { PrCommentComposer } from './PrCommentComposer.js';
import { SkeletonBlock, SkeletonLine } from './Skeleton.js';
// The two Pro-only agentic tabs are the heaviest components in the app (~3k LOC combined,
// pulling their own deep imports) and are gated behind Pro capabilities most sessions never
// open. Lazy-load them so they leave the initial bundle and fetch on first open. (Named
// exports → mapped to `default` for React.lazy.)
const ClaudeReviewTab = lazy(() =>
  import('./ClaudeReviewTab.js').then((m) => ({ default: m.ClaudeReviewTab })),
);
const AiFixTab = lazy(() => import('./AiFixTab.js').then((m) => ({ default: m.AiFixTab })));
const PrBotBehaviourTab = lazy(() =>
  import('./PrBotBehaviourTab.js').then((m) => ({ default: m.PrBotBehaviourTab })),
);
import { Markdown } from './Markdown.js';
import { isNewComment, NewTag } from './ThreadView/index.js';

function newSummary(n: PrDetailT['newSinceLastViewed']): string | null {
  if (!n) return null;
  const parts: string[] = [];
  if (n.comments > 0) parts.push(`${n.comments} new comment${n.comments === 1 ? '' : 's'}`);
  if (n.reviews > 0) parts.push(`${n.reviews} new review${n.reviews === 1 ? '' : 's'}`);
  if (n.commits > 0) parts.push(`${n.commits} new commit${n.commits === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : null;
}

// The inner tab strip's union now lives in store/filters.ts (`PrDetailTab`), because the CHOICE
// is URL-addressable state — `?view=pr-detail:<id>&prTab=changes` names one screen, so browser
// Back/Forward can move between a PR's diff and its threads like any other view. The local alias
// keeps every use site below reading the way it did.
type Tab = PrDetailTab;

// The lightweight metadata a pinned tab renders from (see store/pinnedTabs.ts).
function pinnedMetaOf(pr: PrDetailT, usersById: Map<number, User>): PinnedPr {
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    repoFullName: pr.repoFullName,
    authorLogin: author?.githubLogin ?? null,
    authorDisplayName: author?.displayName ?? null,
    authorAvatarUrl: author?.avatarUrl ?? null,
  };
}

// The tab button uses `capitalize`, which can't produce "Claude Review" from a
// key, so labels are mapped explicitly.
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  threads: 'Threads',
  activity: 'Activity',
  changes: 'Changes',
  bot_activity: 'Bot activity',
  claude_review: 'Claude Review',
  ai_fix: 'AI Analysis and Fix',
};

interface ActivityRow {
  key: string;
  time: string;
  label: string;
  actorId: number | null;
  detail?: string;
  href?: string;
  // The timeline event this entry maps to, so "Show" can recenter on and glow
  // it. refId matches the event's ref_id (null for lifecycle, which has no
  // marker — "Show" just recenters on the PR bar then).
  event: { type: EventType; refId: number | null };
}

function buildActivity(pr: PrDetailT): ActivityRow[] {
  const rows: ActivityRow[] = [];
  rows.push({
    key: 'opened',
    time: pr.openedAt,
    label: 'opened this PR',
    actorId: pr.authorId,
    href: pr.githubUrl,
    event: { type: 'pr_opened', refId: null },
  });
  for (const c of pr.commits) {
    rows.push({
      key: `commit:${c.id}`,
      time: c.committedAt,
      label: 'pushed a commit',
      actorId: c.authorId ?? c.committerId,
      detail: c.message?.split('\n')[0],
      href: `${pr.githubUrl}/commits/${c.sha}`,
      event: { type: 'commit_pushed', refId: c.id },
    });
  }
  for (const r of pr.reviews) {
    rows.push({
      key: `review:${r.id}`,
      time: r.submittedAt,
      label: `reviewed (${r.state.replace('_', ' ')})`,
      actorId: r.authorId,
      detail: r.body ?? undefined,
      href: r.url ?? pr.githubUrl,
      event: { type: 'review_submitted', refId: r.id },
    });
  }
  for (const c of pr.comments) {
    rows.push({
      key: `comment:${c.id}`,
      time: c.createdAt,
      label: 'commented',
      actorId: c.authorId,
      detail: c.body,
      href: c.url ?? pr.githubUrl,
      event: { type: 'pr_comment', refId: c.id },
    });
  }
  if (pr.mergedAt) {
    rows.push({
      key: 'merged',
      time: pr.mergedAt,
      label: 'merged this PR',
      actorId: pr.authorId,
      href: pr.githubUrl,
      event: { type: 'pr_merged', refId: null },
    });
  } else if (pr.closedAt) {
    rows.push({
      key: 'closed',
      time: pr.closedAt,
      label: 'closed this PR',
      actorId: pr.authorId,
      href: pr.githubUrl,
      event: { type: 'pr_closed', refId: null },
    });
  }
  // Newest first.
  return rows.sort((a, b) => b.time.localeCompare(a.time));
}

function ActivityList({
  pr,
  usersById,
  since,
  onClearSince,
  focusEvent,
  onConsumed,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  since: string | null;
  onClearSince: () => void;
  // Deep link from the timeline (e.g. a commit popover): scroll to + flash the
  // matching entry, then consume the request.
  focusEvent: { type: EventType; refId: number | null } | null;
  onConsumed: () => void;
}): JSX.Element {
  const all = useMemo(() => buildActivity(pr), [pr]);
  const rows = since ? all.filter((r) => r.time > since) : all;
  const showEventOnTimeline = useFilters((s) => s.showEventOnTimeline);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [flashKey, setFlashKey] = useState<string | null>(null);

  // Scroll to + flash the targeted entry once it's rendered.
  useEffect(() => {
    if (!focusEvent) return;
    const row = all.find(
      (r) => r.event.type === focusEvent.type && r.event.refId === focusEvent.refId,
    );
    onConsumed();
    if (!row) return;
    rowRefs.current.get(row.key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashKey(row.key);
  }, [focusEvent, all, onConsumed]);

  // Fade the flash after a beat — kept on its own key so consuming focusEvent
  // (which re-runs the effect above) can't cancel the timer early.
  useEffect(() => {
    if (flashKey == null) return;
    const t = setTimeout(() => setFlashKey(null), 1800);
    return () => clearTimeout(t);
  }, [flashKey]);

  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {since && (
        <li className="flex items-center gap-2 bg-sky-500/5 px-3 py-1.5 text-xs text-sky-600 dark:text-sky-400">
          <span>Showing {rows.length} since you last looked</span>
          <button
            type="button"
            onClick={onClearSince}
            className="ml-auto text-gray-400 hover:text-gray-600"
          >
            show all
          </button>
        </li>
      )}
      {rows.map((r) => {
        const user = r.actorId != null ? usersById.get(r.actorId) : undefined;
        return (
          <li
            key={r.key}
            ref={(el) => {
              if (el) rowRefs.current.set(r.key, el);
              else rowRefs.current.delete(r.key);
            }}
            className={`flex items-start gap-2 px-3 py-2 text-sm ${
              r.key === flashKey ? 'activity-flash' : ''
            }`}
          >
            <Avatar user={user} size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <UserName
                  user={user}
                  fallbackId={r.actorId}
                  repoId={pr.repoId}
                  className="font-medium"
                />
                <span className="text-gray-500">{r.label}</span>
                <span className="text-xs text-gray-400" title={dateTime(r.time)}>
                  · {relativeTime(r.time)}
                </span>
              </div>
              {r.detail && (
                <div className="mt-0.5 truncate text-xs text-gray-500" title={r.detail}>
                  {r.detail.split('\n')[0]}
                </div>
              )}
              <div className="mt-1 flex items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => showEventOnTimeline(pr.id, r.time, r.event)}
                  className="text-blue-500 hover:underline"
                  title="Show this event on the timeline"
                >
                  Show
                </button>
                {r.href && (
                  <a
                    href={safeExternalUrl(r.href)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-gray-400 hover:text-blue-500"
                  >
                    Open on GitHub ↗
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// A review that carries a body counts as a "PR comment" for the conversation view (the
// note the reviewer wrote when submitting — a plain "Review: comment", or the summary
// attached to an approval / change-request). Inline review-thread comments live in the
// Threads tab, so they're NOT counted here.
const reviewCommentCount = (pr: PrDetailT): number =>
  pr.reviews.filter((r) => r.body != null && r.body.trim() !== '').length;

// Small state pill next to a review author in the conversation, so an approval-with-note
// reads differently from a plain review comment or a change request.
const REVIEW_TAG: Record<ReviewState, { label: string; cls: string }> = {
  approved: { label: 'approved', cls: 'bg-green-500/10 text-green-700 dark:text-green-400' },
  changes_requested: {
    label: 'changes requested',
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  commented: { label: 'review', cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' },
  dismissed: { label: 'dismissed', cls: 'bg-gray-500/10 text-gray-500' },
  pending: { label: 'pending', cls: 'bg-gray-500/10 text-gray-500' },
};

function ReviewStateTag({ state }: { state: ReviewState }): JSX.Element {
  const t = REVIEW_TAG[state];
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${t.cls}`}
      title={`Review: ${state.replace('_', ' ')}`}
    >
      {t.label}
    </span>
  );
}

// One entry in the merged conversation: either an issue-level PR comment or a review
// that carried a body. Both are sorted together chronologically so the pane reads like
// the GitHub conversation, not two disjoint lists.
type ConversationItem = {
  kind: 'comment' | 'review';
  id: number;
  authorId: number | null;
  body: string;
  at: string;
  url: string | null;
  state?: ReviewState;
};

// The PR conversation: issue-level comments PLUS reviews that carry a body (a review
// summary / "Review: comment"), merged chronologically. Comments map to a `pr_comment`
// timeline event, reviews to `review_submitted`, so "Show on timeline" reuses the same
// (type, refId) + recenter mechanism as the Activity tab. Inline review-thread comments
// are the Threads tab's concern, not this list.
function PrCommentsList({
  pr,
  usersById,
  viewedSince,
  focusCommentId,
  selectedCommentId,
  onFocusConsumed,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  viewedSince: string | null;
  // Deep link from the timeline (pr_comment popover → "Open in detail pane"):
  // scroll to + flash this comment card, then consume the request.
  focusCommentId: number | null;
  // The selected comment gets a PERMANENT amber border (mirrors a selected thread),
  // distinct from the one-shot flash above.
  selectedCommentId: number | null;
  onFocusConsumed: () => void;
}): JSX.Element {
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const [flashId, setFlashId] = useState<number | null>(null);
  // The item whose expand-in-place reply composer is open (only one at a time). Keyed by
  // `${kind}:${id}` so a review id can't collide with a comment id.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // Scroll to + flash the deep-linked comment once it's rendered, then consume the
  // request (the flash lives on its own state so consuming can't cancel it early).
  useEffect(() => {
    if (focusCommentId == null) return;
    onFocusConsumed();
    const el = cardRefs.current.get(focusCommentId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(focusCommentId);
  }, [focusCommentId, onFocusConsumed]);

  useEffect(() => {
    if (flashId == null) return;
    const t = setTimeout(() => setFlashId(null), 1800);
    return () => clearTimeout(t);
  }, [flashId]);

  // ML severity/category labels for this PR — the same one-query-per-PR index the Threads tab
  // reads, deduped by React Query. Two target kinds meet here: an issue comment is
  // ('pr_comment', prComments.id) and a review body is ('review', reviews.id). Those are
  // SEPARATE id spaces on separate tables, so the lookup must key on `it.kind` — a badge that
  // assumed one kind would find a different row's label and be confidently wrong.
  const mlEnabled = useMlSeverityEnabled();
  const mlIndex = useMlLabelIndex(pr.id, mlEnabled);

  // Merge issue comments + reviews-with-body, oldest first — chronological reading order
  // (matches the GitHub conversation; comments carry createdAt, reviews submittedAt).
  const items: ConversationItem[] = [
    ...pr.comments.map(
      (c): ConversationItem => ({
        kind: 'comment',
        id: c.id,
        authorId: c.authorId,
        body: c.body,
        at: c.createdAt,
        url: c.url,
      }),
    ),
    ...pr.reviews
      .filter((r) => r.body != null && r.body.trim() !== '')
      .map(
        (r): ConversationItem => ({
          kind: 'review',
          id: r.id,
          authorId: r.authorId,
          body: r.body as string,
          at: r.submittedAt,
          url: r.url,
          state: r.state,
        }),
      ),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (items.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-gray-500">
        No PR comments on this PR.
      </div>
    );
  }

  return (
    <div className="space-y-2 px-3 pb-3">
      {items.map((it) => {
        const user = it.authorId != null ? usersById.get(it.authorId) : undefined;
        const isNew = isNewComment(it.at, viewedSince);
        const isComment = it.kind === 'comment';
        const rowKey = `${it.kind}:${it.id}`;
        // Timeline focus/selection deep links target comment ids only (from the
        // pr_comment popover); reviews don't participate, so they never register a
        // cardRef or take the selected/flash styling.
        const selected = isComment && it.id === selectedCommentId;
        const flashing = isComment && it.id === flashId;
        return (
          <div
            key={rowKey}
            ref={
              isComment
                ? (el) => {
                    if (el) cardRefs.current.set(it.id, el);
                    else cardRefs.current.delete(it.id);
                  }
                : undefined
            }
            className={`rounded-md border px-2.5 py-2 ${
              selected
                ? 'border-amber-400 bg-amber-400/5'
                : 'border-gray-200 dark:border-gray-800'
            } ${isNew ? 'comment-new' : ''} ${flashing ? 'activity-flash' : ''}`}
          >
            <div className="flex items-center gap-2 text-xs">
              <ShowOnTimeline
                prId={pr.id}
                at={it.at}
                event={
                  isComment
                    ? { type: 'pr_comment', refId: it.id }
                    : { type: 'review_submitted', refId: it.id }
                }
                title={
                  isComment
                    ? 'Show this comment on the timeline'
                    : 'Show this review on the timeline'
                }
              />
              <span className="text-gray-300 dark:text-gray-600">·</span>
              <Avatar user={user} size={18} />
              <UserName
                user={user}
                fallbackId={it.authorId}
                repoId={pr.repoId}
                className="font-semibold"
              />
              {it.kind === 'review' && it.state != null && <ReviewStateTag state={it.state} />}
              <span className="text-gray-400" title={dateTime(it.at)}>
                {relativeTime(it.at)}
              </span>
              {isNew && <NewTag />}
              <MlSeverityBadge
                label={mlIndex?.get(
                  mlLabelKey(isComment ? 'pr_comment' : 'review', it.id),
                )}
              />
              {/* Right-aligned, matching CommentBlock's, so the control sits in one predictable
                  place across both comment surfaces. A review body copies too — it is where a
                  bot's summary verdict lands, and it is the single most-copied text here. */}
              <CopyButton
                text={it.body}
                what={isComment ? 'comment' : 'review'}
                className="ml-auto"
              />
            </div>
            <div className="mt-1 text-sm">
              <Markdown>{it.body}</Markdown>
            </div>
            {/* Emoji reactions on this conversation item. BOTH kinds are reactable on GitHub —
                an issue comment is `IssueComment` and a review body is `PullRequestReview` —
                and they are SEPARATE id spaces on separate tables, exactly like the ML badge
                above, so the kind rides the same `isComment` discriminator. (A review body is
                the highest-value target in this product: it is where a bot's summary verdict
                lands, and REST has no reactions endpoint for it at all, which is why the whole
                write path is GraphQL.) Renders nothing when there are none and the viewer may
                not add one. */}
            <ReactionBar
              kind={isComment ? 'pr_comment' : 'review'}
              id={it.id}
              className="mt-1.5 pl-2"
            />
            <div className="mt-2 flex items-center gap-3 pl-2 text-[11px]">
              {replyingTo !== rowKey && (
                <button
                  type="button"
                  onClick={() => setReplyingTo(rowKey)}
                  className="text-blue-500 hover:underline"
                >
                  Reply
                </button>
              )}
              {it.url && (
                <a
                  href={safeExternalUrl(it.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-blue-500 hover:underline"
                >
                  ↗ {isComment ? 'View comment on GitHub' : 'View review on GitHub'}
                </a>
              )}
              {/* Pro (prSummary): spend one combined AI check on THIS comment alone — rewrite,
                  is-it-well-founded, and was-it-addressed. Its output renders directly BELOW,
                  under the comment card's body + actions. */}
              {isComment && (
                <ReviewCheckButton
                  prId={pr.id}
                  target={{ targetKind: 'pr_comment', targetId: it.id }}
                />
              )}
            </div>
            {/* AI annotations for a PR-level comment, UNDER the comment they judge (all three
                kinds key on the same ('pr_comment', id), so one component covers them). They used
                to sit above the body; a judgement you read before the thing it judges is
                backwards, and it now matches the per-thread block. Reviews are not annotatable
                targets (only issue comments are), hence the isComment gate. Renders nothing when
                the comment has no stored judgements. */}
            {isComment && (
              <CommentAnnotations prId={pr.id} targetKind="pr_comment" targetId={it.id} />
            )}
            {replyingTo === rowKey && (
              <div className="mt-2">
                <PrCommentComposer
                  prId={pr.id}
                  initialBody={buildQuotedReply(
                    it.body,
                    usersById.get(it.authorId ?? -1)?.githubLogin ?? null,
                  )}
                  autoFocus
                  onCancel={() => setReplyingTo(null)}
                  onDone={() => setReplyingTo(null)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// First-load placeholder for the detail pane: the header (title + meta), the tab strip,
// and a few content blocks — mirrors the real layout so nothing jumps when the PR loads.
// Structural only, using the shared Skeleton primitives (Activity-console pattern).
function PrDetailSkeleton(): JSX.Element {
  return (
    <div className="flex h-full flex-col" aria-hidden="true">
      {/* Header: a state chip + title line, then the author/meta line. */}
      <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <SkeletonLine className="h-4 w-12" />
          <SkeletonLine className="h-4 w-2/5" />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <SkeletonLine className="h-3 w-24" />
          <SkeletonLine className="h-3 w-32" />
          <SkeletonLine className="h-3 w-20" />
        </div>
      </div>
      {/* Tab strip. */}
      <div className="flex gap-3 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        {[16, 14, 14, 14].map((w, i) => (
          <SkeletonLine key={i} className="h-3.5" style={{ width: `${w * 4}px` }} />
        ))}
      </div>
      {/* Content blocks. */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <SkeletonBlock className="h-20" />
        <SkeletonBlock className="h-16" />
        <SkeletonBlock className="h-16" />
      </div>
    </div>
  );
}

// Stable empty filter for the guarded threadStateFilter (see the effect below) — a fresh Set
// each render would churn the effect deps.
const EMPTY_THREAD_STATE_FILTER: Set<DerivedState> = new Set();
const EMPTY_THREAD_SEVERITY_FILTER: Set<MlSeverity> = new Set();

export function PrDetail({
  prId,
  selectedThreadId,
}: {
  prId: number;
  selectedThreadId: number | null;
}): JSX.Element {
  const { data: pr, isLoading, error } = usePr(prId);
  const { data: repos } = useRepos();
  const { aiAnalysis, aiFix, claudeReview: claudeReviewEnabled } = useProCapabilities();
  const aiFixTabEnabled = aiAnalysis || aiFix;
  // The inner tab is STORE state, paired with the PR it belongs to (see `prDetailTab`), so the
  // URL can name it. Read through the pair — a tab seated for ANOTHER PR is not ours, exactly
  // like the `threadStateFilter` guard below; without that a tab left on Changes would follow the
  // reader into the next PR they open from the feed.
  const prDetailTab = useFilters((s) => s.prDetailTab);
  const setPrDetailTab = useFilters((s) => s.setPrDetailTab);
  const tab: Tab = prDetailTab?.prId === prId ? prDetailTab.tab : 'overview';
  // "Show this finding in the Changes tab" — the Claude Review tab's code anchors hand a
  // (path, line, side) here and we switch tabs; ChangesTab turns it into FileDiffView's
  // `focus`. LOCAL state on purpose: both tabs live in THIS PrDetail instance, so unlike
  // threadStateFilter/claudeTabFocus there is no global field to leak across PRs and no
  // `selectedPrId === prId` guard to remember. `nonce` makes re-clicking the same finding
  // re-scroll (an effect keyed on a boolean cannot re-fire).
  const [changesFocus, setChangesFocus] = useState<DiffFocusTarget | null>(null);
  /**
   * THE ONLY WAY TO CHANGE TABS — every path below goes through this, and the reason is
   * `changesFocus`.
   *
   * A deep-link target is consumed by ChangesTab when Changes is on screen, but nothing
   * un-sets it afterwards, so it OUTLIVES the visit: land on Changes via a finding anchor, let
   * anything move the tab away (selecting a thread forces `threads`, a comment deep link forces
   * `overview`, …), and the target is still sitting there. Any later arrival at Changes then
   * re-fires the OLD finding's jump — the user asked for "the diff" and got someone else's line.
   *
   * The tab bar already cleared it by hand, which is exactly why this is a helper rather than a
   * second hand-patched call site: the header's "N files · +X −Y" button didn't, and that was the
   * live bug. Clearing on EVERY tab change makes the stale-target state unrepresentable instead
   * of making each new call site remember.
   */
  const goToTab = useCallback(
    (t: Tab): void => {
      setChangesFocus(null);
      setPrDetailTab(prId, t);
    },
    [prId, setPrDetailTab],
  );
  /**
   * THE SAME MOVE, MADE BY THE APP RATHER THAN THE READER — used by every deep-link effect below
   * (a feed row naming a thread forces Threads, a review banner forces Claude Review, …).
   *
   * Identical to `goToTab` except that it tells the URL layer this write is a CORRECTION, so the
   * entry is REPLACED instead of pushed. Those effects fire one tick after the open that already
   * pushed a history entry; without this the reader's first Back would land on the very PR they
   * are looking at, at Overview, instead of returning to the feed they came from.
   */
  const seedTab = useCallback(
    (t: Tab): void => {
      markUrlCorrection();
      goToTab(t);
    },
    [goToTab],
  );
  const openInChanges = (
    path: string,
    line: number | null,
    side: 'LEFT' | 'RIGHT',
    // Set only by the thread → Changes leg: the target thread's inline pill opens + flashes
    // as part of the reveal (every thread renders collapsed there, and a jump landing beside
    // a shut pill reads as a broken link). Claude Review anchors carry none.
    threadId?: number,
  ): void => {
    // THE ONE DELIBERATE EXCEPTION to `goToTab`, and the ordering is the whole point: this path
    // exists to SET a focus, and `goToTab` clears it. Move the tab first, then arm the target, so
    // no clearing sits between the two.
    setPrDetailTab(prId, 'changes');
    setChangesFocus({ path, line, side, threadId: threadId ?? null, nonce: Date.now() });
  };
  const [activitySince, setActivitySince] = useState<string | null>(null);
  const qc = useQueryClient();
  /**
   * THREAD → CHANGES, with the full fallback ladder. Resolved here because this is the only
   * component holding both the changed-file set and the tab state.
   *
   * The ladder, in order:
   *   1. `thread.line` is live      → jump to that line on the RIGHT side. Always available for a
   *                                   non-outdated thread (measured: 8,844/8,844 have a line).
   *   2. the live line is gone      → reconstruct it from the anchor hunk (`anchorLineFromHunk`)
   *                                   and mark the jump APPROXIMATE — it is the line in the commit
   *                                   the comment was written against. 90% of outdated threads
   *                                   have no stored line, so this rung is the only one they have.
   *   3. no line at all             → reveal the FILE (`line: null`, which DiffFocusTarget already
   *                                   means; ChangesTab scrolls the block header).
   *   4. the file left the diff     → return null, so no control renders at all.
   *
   * ⚠ `changedPaths` is read from the React Query CACHE, never fetched. `GET /api/prs/:id/files`
   * hydrates patches from GitHub and sits on the `prDetail` tier; ThreadCard is mounted in the
   * Feed across MANY PRs, so a fetch from a card would be a request storm. `pr.files` is always
   * present on the detail payload and covers rung 4 on its own; the cached `pr-files` entry, when
   * the Changes tab has been opened, additionally contributes `previousPath` for renames.
   */
  const changedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const f of pr?.files ?? []) set.add(f.path);
    const cached = qc.getQueryData<PrFilesResponse>(['pr-files', pr?.id]);
    for (const f of cached?.files ?? []) {
      set.add(f.path);
      if (f.previousPath) set.add(f.previousPath);
    }
    return set;
  }, [pr?.files, pr?.id, qc]);

  const openInChangesFor = useCallback(
    (thread: ThreadDetail) => {
      // Rung 4: nothing to navigate to. An empty set means we simply don't know yet (a PR detail
      // that has not loaded), and offering the jump is the kinder failure — ChangesTab already
      // renders an explicit "isn't in the diff shown here" banner if it turns out to be wrong.
      if (changedPaths.size > 0 && !changedPaths.has(thread.path)) return null;
      const derived =
        thread.line == null ? anchorLineFromHunk(thread.comments[0]?.diffHunk) : null;
      const line = thread.line ?? derived?.line ?? null;
      const side = thread.line != null ? 'RIGHT' : (derived?.side ?? 'RIGHT');
      return {
        line,
        approximate: thread.line == null && derived != null,
        // Routed through `openInChanges` rather than setting the tab and focus by hand: `goToTab`
        // CLEARS `changesFocus`, and that helper is the one deliberate exception which orders the
        // two correctly. A second path here would land on the diff with no jump.
        run: () => openInChanges(thread.path, line, side, thread.id),
      };
    },
    [changedPaths, openInChanges],
  );

  /**
   * CHANGES → THREADS, the return leg. Deliberately calls `goToTab` ITSELF rather than relying on
   * the `selectedThreadId` effect below: that effect keys on the VALUE, so re-selecting a thread
   * that is already selected — exactly what happens when the reader arrived in Changes FROM that
   * thread a moment ago — would not re-fire and the tab would not move. `selectThread` is still
   * called, because it also clears the state/severity pill presets that could otherwise filter the
   * target thread out of the list entirely.
   */
  const openThreadInThreads = useCallback(
    (threadId: number) => {
      if (pr == null) return;
      useFilters.getState().selectThread(pr.id, threadId);
      goToTab('threads');
    },
    [pr, goToTab],
  );
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  // "Show in Activity feed" — jump to this PR's repo console (activity sub-tab) with the PR
  // isolated as the feed filter. ORDER IS LOAD-BEARING, and there are now THREE steps that clear
  // `feedIsolatedPrId`: `setWorkspace` and `setActivityRepo` both do, so the isolation is set
  // LAST (mirrors OpenPrsDetail.showInFeed / BotOnlyPrsDetail).
  //
  // ⚠ THE WORKSPACE MOVES FIRST WHEN THE PR LIVES ELSEWHERE. A PR tab can hold a PR from any
  // workspace (a `?pr=<id>` deep link, a restored `pierre:tabs` entry, a search hit), and the
  // Activity rail lists only the ACTIVE workspace's repos — so without the switch this lands the
  // console on a repo it has no row for and the feed is scoped to the wrong set entirely.
  const activeWorkspaceId = useFilters((s) => s.workspaceId);
  const setWorkspace = useFilters((s) => s.setWorkspace);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const setRepoConsoleTab = useFilters((s) => s.setRepoConsoleTab);
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const showActivity = usePinnedTabs((s) => s.showActivity);
  const activityFocus = useFilters((s) => s.activityFocus);
  const consumeActivityFocus = useFilters((s) => s.consumeActivityFocus);
  const activityFocusForPr = useMemo(
    () =>
      activityFocus && pr && activityFocus.prId === pr.id
        ? { type: activityFocus.type, refId: activityFocus.refId }
        : null,
    [activityFocus, pr],
  );
  const commentFocus = useFilters((s) => s.commentFocus);
  const consumeCommentFocus = useFilters((s) => s.consumeCommentFocus);
  const selectedCommentId = useFilters((s) => s.selectedCommentId);
  const claudeTabFocus = useFilters((s) => s.claudeTabFocus);
  const consumeClaudeTabFocus = useFilters((s) => s.consumeClaudeTabFocus);
  const aiFixTabFocus = useFilters((s) => s.aiFixTabFocus);
  const commentFocusForPr =
    commentFocus && pr && commentFocus.prId === pr.id ? commentFocus.commentId : null;

  // Keep a full-screen pr-detail tab's label fresh if the PR (re)loads renamed.
  const syncPinnedMeta = usePinnedTabs((s) => s.syncMeta);

  // Selecting a thread (e.g. via a timeline marker) forces the Threads tab,
  // where the thread list lives and auto-scrolls to the selected thread.
  useEffect(() => {
    if (selectedThreadId != null) seedTab('threads');
  }, [selectedThreadId, seedTab]);

  // Clicking a review-bot chip in Overview (ChecksTab) sets threadBotFilter → jump to the
  // Threads tab, which then shows only that vendor's threads.
  const threadBotFilter = useFilters((s) => s.threadBotFilter);
  useEffect(() => {
    if (threadBotFilter != null) seedTab('threads');
  }, [threadBotFilter, seedTab]);

  // Arriving from the resolvable-bot-threads tab presets a derived-state pill (likely_addressed)
  // → force the Threads tab so the relevant threads are visible immediately. The preset belongs
  // to the PR it was set FOR (openPrThreadsFiltered sets selectedPrId + the filter together);
  // guard on selectedPrId === prId — mirroring App's selectedThreadId guard — so opening ANOTHER
  // PR via openPrDetailTab (which never resets the filter) can't inherit it and force the wrong
  // tab / hide a subset of threads.
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const rawThreadStateFilter = useFilters((s) => s.threadStateFilter);
  const threadStateFilter =
    selectedPrId === prId ? rawThreadStateFilter : EMPTY_THREAD_STATE_FILTER;
  // Same GLOBAL-store trap, same guard: an ML-severity preset belongs to the PR it was set for.
  const rawThreadSeverityFilter = useFilters((s) => s.threadSeverityFilter);
  const threadSeverityFilter =
    selectedPrId === prId ? rawThreadSeverityFilter : EMPTY_THREAD_SEVERITY_FILTER;
  useEffect(() => {
    if (threadStateFilter.size > 0) seedTab('threads');
  }, [threadStateFilter, seedTab]);

  // A timeline deep link to an Activity entry (e.g. the commit popover) forces the
  // Activity tab and clears the "since" filter so the target is visible; the list
  // then scrolls to + flashes it.
  useEffect(() => {
    if (activityFocusForPr) {
      seedTab('activity');
      setActivitySince(null);
    }
  }, [activityFocusForPr, seedTab]);

  // The global Claude-review banner deep-links here: open the Claude Review tab
  // for the matching PR, then consume the signal.
  useEffect(() => {
    if (claudeReviewEnabled && claudeTabFocus && pr && claudeTabFocus.prId === pr.id) {
      seedTab('claude_review');
      consumeClaudeTabFocus();
    }
  }, [claudeTabFocus, pr, claudeReviewEnabled, consumeClaudeTabFocus, seedTab]);

  // "Generate fix from this review" (or any deep link) → open the AI Fix tab for the
  // matching PR. The signal is NOT consumed here — AiFixTab reads its `reviewText` to
  // seed the prompt, then consumes it.
  useEffect(() => {
    if (aiFixTabEnabled && aiFixTabFocus && pr && aiFixTabFocus.prId === pr.id) {
      seedTab('ai_fix');
    }
  }, [aiFixTabFocus, pr, aiFixTabEnabled, seedTab]);

  // A timeline deep link to a PR comment (the pr_comment popover's "Open in detail
  // pane") forces the Overview tab, where PrCommentsList then scrolls to + flashes
  // it. PrCommentsList consumes the signal (not here) once it has scrolled.
  useEffect(() => {
    if (commentFocusForPr != null) seedTab('overview');
  }, [commentFocusForPr, seedTab]);

  // Capture the last-viewed instant before marking (so new comments highlight
  // on this visit), then mark the PR viewed and refresh the list views' badges.
  // We deliberately do NOT invalidate this PR's own query.
  const markViewed = useMutation({
    mutationFn: (id: number) => api.markPrViewed(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      // ⚠ VIEWING A PR IS A MY-TURN MUTATION. `your_pr` rows leave getMyTurn's `yourPrs` section
      // the instant this stamps `pr_views` (the section filters on newSinceLastViewed) — so the
      // `my_turn` CARD built from that row, and the daily-brief count OF those cards, are both
      // wrong the moment this succeeds. Without these two the card sat on the "Needs attention"
      // board until its 60s staleTime or the 5-min interval: the user opens the PR the card
      // pointed at, comes back, and the card is still there telling them to look at it.
      // Invalidated at the PREFIX (both keys are `[name, 'ws:<id>']` — see useAttentionCards /
      // useDailyBrief) so every cached workspace refreshes, exactly like useDismissMyTurn.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
    },
  });
  const markedRef = useRef<number | null>(null);
  useEffect(() => {
    if (pr && markedRef.current !== pr.id) {
      markedRef.current = pr.id;
      markViewed.mutate(pr.id);
    }
  }, [pr, markViewed]);

  const usersById = useMemo(() => indexUsers(pr?.users), [pr]);

  // PR-scoped bot behaviour (EXPERIMENTAL, CORE — not Pro): a CHEAP client gate that ENABLES the
  // fetch (the tab's actual visibility is the server's confirmed count, see botTabVisible below).
  // Reviews carry the precise account-scoped `automatedKind`; a thread-opening / commenting bot
  // falls back to the global users.isBot. Known residual: a reviewer manually classified as
  // automated in Settings (isBot stays false) that ONLY comments (never submits a review) won't
  // trip this gate, so the fetch won't fire — a rare edge the cheap client heuristic can't see.
  const hasBots = useMemo(() => {
    if (!pr) return false;
    if (pr.reviews.some((r) => r.automatedKind != null)) return true;
    if (pr.threads.some((t) => t.originalCommenterId != null && usersById.get(t.originalCommenterId)?.isBot))
      return true;
    if (pr.comments.some((c) => c.authorId != null && usersById.get(c.authorId)?.isBot)) return true;
    return false;
  }, [pr, usersById]);
  // Fetched here (deduped with the tab's own call) so the tab label + Overview chip can badge a
  // "slower than typical" bot without opening the tab. `hasBots` is a CHEAP fetch gate (a superset
  // of the server's set — it fires for any isBot/automated participant, incl. dependency bots).
  const { data: prBotBehaviour } = usePrBotBehaviour(pr?.id ?? null, hasBots);
  // The TAB's visibility is gated on the SERVER's confirmed automated-REVIEWER count, not the
  // client heuristic — so a PR whose only bot is a dependency bot (dependabot/renovate, excluded
  // from the review-bot set) never shows a "Bot activity" tab that would render an empty state.
  const botTabVisible = (prBotBehaviour?.bots.length ?? 0) > 0;
  const botTtfrAnomalies = (prBotBehaviour?.bots ?? []).filter((b) => b.ttfrAnomaly != null).length;
  /**
   * ⚠ A VISIBLE SUB-TAB IS DERIVED, NEVER WRITTEN BACK — and `prDetailTab` is URL-owned now
   * (`?prTab=`), which is what turned the old corrective effect here into a link destroyer.
   *
   * It used to be `if (tab === 'bot_activity' && !botTabVisible) seedTab('overview')`, so a
   * refresh or a shared deep link onto `?view=pr-detail:<id>&prTab=bot_activity` lost the tab
   * before the data that decides visibility could arrive: `pr` is still loading on the first run,
   * so `hasBots` is false, so `usePrBotBehaviour` has not even STARTED, so `botTabVisible` is
   * false — and `seedTab` REPLACES the history entry, so `?prTab=` was destroyed rather than
   * corrected, unrecoverable by Back.
   *
   * So the fallback waits for an ANSWER instead of reading "not loaded yet" as "no bots". There
   * are two answers: a LOADED PR whose cheap client gate found nothing (`hasBots` is a superset of
   * the server's automated-reviewer set, so none here means none there — and the fetch is
   * deliberately never made), and a SETTLED `prBotBehaviour`. Until one of them lands the tab
   * stands, and the store keeps the reader's raw choice either way — the same rule
   * `feedInnerTab` / `botsInnerTab` follow.
   */
  const botTabResolved = pr != null && (!hasBots || prBotBehaviour !== undefined);
  const effectiveTab: Tab =
    tab === 'bot_activity' && botTabResolved && !botTabVisible ? 'overview' : tab;

  // Keep a pinned tab's label fresh if the PR detail (re)loads with a new title /
  // author (e.g. a renamed PR). No-op when the PR isn't pinned or nothing changed.
  useEffect(() => {
    if (pr != null) syncPinnedMeta(pinnedMetaOf(pr, usersById));
  }, [pr, usersById, syncPinnedMeta]);

  // Live freshness: the ~5s probe-gated poll runs only while this PR is OPEN and this
  // PrDetail is the copy the user can actually SEE. Mounted ≠ visible: the pane path is
  // visible only under a board-slot Timeline (the shared board or a pr-focus isolate),
  // and the overlay path only when the active tab IS this PR's pr-detail tab —
  // refetchIntervalInBackground:false covers document.hidden but not an in-app overlay.
  // (activeTab is read here, not passed in, so both mount sites get the gate for free.)
  const liveActiveTab = usePinnedTabs((s) => s.activeTab);
  const liveActiveParsed = parseTabKey(liveActiveTab);
  const liveVisible =
    liveActiveParsed?.kind === 'pr-detail'
      ? liveActiveParsed.prId === prId
      : liveActiveTab === 'timeline' || liveActiveParsed?.kind === 'pr-focus';
  // Closed/merged PRs get no auto-poll (nothing to watch); the manual button still works.
  const { refreshNow, isRefreshing, isStale } = usePrLiveRefresh(
    prId,
    liveVisible && pr?.state === 'open',
  );

  // This account's live auto-merge intent — drives the header's "Auto-merge armed" chip. A
  // selector over the polled armed list (no new request); MUST sit above the early returns
  // (hooks-order rule). Only `state === 'armed'` counts — the list carries resolved rows too.
  const armedIntent = usePrArmedIntent(prId);

  if (isLoading) {
    return <PrDetailSkeleton />;
  }
  if (error || !pr) {
    return (
      <div className="p-4 text-sm text-red-500">
        {error ? String(error) : 'PR not found'}
      </div>
    );
  }

  const stateMeta = PR_STATE_META[pr.state];
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;

  return (
    <PrFocusMetaContext.Provider value={pinnedMetaOf(pr, usersById)}>
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 px-4 py-2 pr-28 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-xs font-semibold text-white"
            style={{ backgroundColor: stateMeta.color }}
          >
            {pr.isDraft ? 'Draft' : stateMeta.label}
          </span>
          {/* The title + the ↗ icon both open this PR full-screen as its own (focused)
              tab. Opening a tab IS pinning it, so there's no separate pin control. */}
          <button
            type="button"
            onClick={() => openPrDetailTab(pinnedMetaOf(pr, usersById))}
            className="min-w-0 truncate text-left text-sm font-semibold hover:underline"
            title="Open full-screen in its own tab"
          >
            <span className="text-gray-400">#{pr.number}</span> {pr.title}
          </button>
          <button
            type="button"
            onClick={() => openPrDetailTab(pinnedMetaOf(pr, usersById))}
            className="shrink-0 rounded p-0.5 text-blue-500 hover:text-blue-600"
            title="Open full-screen — this PR in its own tab"
            aria-label="Open this PR full-screen in its own tab"
          >
            <ExternalLinkIcon size={13} />
          </button>
          {/* Show on the shared timeline (centre + glow; distinct from Focus Mode). */}
          <button
            type="button"
            onClick={() => openPrFocused(pr.id)}
            className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title="Show this PR on the timeline"
            aria-label="Show this PR on the timeline"
          >
            <TimelineIcon size={15} />
          </button>
          {/* Focus — a blue magnifier that opens this PR's own isolated timeline tab. */}
          <button
            type="button"
            onClick={() => openPrFocusTab(pinnedMetaOf(pr, usersById))}
            className="shrink-0 rounded p-0.5 text-blue-500 hover:text-blue-600"
            title="Focus — open this PR in its own isolated timeline tab (✕ on the tab to close)"
            aria-label="Focus this PR in its own timeline tab"
          >
            <MagnifierIcon size={15} />
          </button>
          {/* Show in the Activity feed — jump to this PR's repo console with the feed isolated
              to just this PR (order load-bearing: isolate AFTER the rail move). */}
          <button
            type="button"
            onClick={() => {
              // Switch scope first when this PR's repo belongs to another workspace (see the
              // note by setWorkspace above). `null` = every repo in the new workspace, which is
              // the REPLACE semantics a scope change wants.
              const prWorkspaceId =
                repos?.find((r) => r.id === pr.repoId)?.workspaceId ?? null;
              if (prWorkspaceId != null && prWorkspaceId !== activeWorkspaceId) {
                setWorkspace(prWorkspaceId, null);
              }
              setRepoConsoleTab(pr.repoId, 'activity');
              setActivityRepo(pr.repoId);
              setFeedIsolatedPrId(pr.id);
              showActivity();
            }}
            className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title="Show this PR in its repo's Activity feed (filtered to this PR)"
            aria-label="Show this PR in the Activity feed"
          >
            <FeedIcon size={15} />
          </button>
          {/* Refresh — re-read this PR from GitHub now. Shares in-flight state with the
              ~5s live poll via the ['pr-refresh', prId] query key: one spinner, and a
              click can never double a request the poll already has running. Copy stays
              modest ("Refresh"): a targeted sync pages reviewThreads(first:50), so a
              refresh can honestly change nothing. Amber = the last attempt couldn't
              re-read GitHub (a stale note, never an error — the shown data is valid). */}
          <button
            type="button"
            onClick={refreshNow}
            disabled={isRefreshing}
            className={`shrink-0 rounded p-0.5 disabled:opacity-60 ${
              isStale
                ? 'text-amber-500 hover:text-amber-600'
                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
            title={
              isStale
                ? "Couldn't refresh from GitHub — showing the last synced state. Click to retry."
                : 'Refresh — re-check GitHub for new activity on this PR'
            }
            aria-label="Refresh this PR from GitHub"
          >
            <RefreshIcon size={14} className={isRefreshing ? 'animate-spin' : undefined} />
          </button>
          {/* Open on GitHub (Octocat). */}
          <a
            href={pr.githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title="Open this PR on GitHub"
            aria-label="Open this PR on GitHub"
          >
            <OctocatIcon size={15} />
          </a>
          {pr.isStalled && (
            <span
              className="rounded bg-orange-500/15 px-1.5 py-0.5 text-xs font-medium text-orange-500"
              title="Open, no recent commits, and has open threads"
            >
              Stalled
            </span>
          )}
          {/* Auto-merge armed — visible from EVERY tab, not just Overview. Display only (the
              disarm affordance lives in the Actions row); honest about the mechanism. */}
          {armedIntent != null && pr.state === 'open' && (
            <span
              className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-xs font-medium text-violet-600 dark:text-violet-300"
              title="Auto-merge is armed — Limn updates it from trunk if needed and merges when checks pass, while the app is running. Cancel from Overview → Actions."
            >
              <span aria-hidden>⏲</span> Auto-merge armed
            </span>
          )}
          {(() => {
            const summary = newSummary(pr.newSinceLastViewed);
            return summary ? (
              <button
                type="button"
                onClick={() => {
                  goToTab('activity');
                  setActivitySince(pr.lastViewedAt);
                }}
                className="ml-auto shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium text-sky-500 hover:bg-sky-500/25"
                title="Filter activity to what's new since you last looked"
              >
                👁 {summary}
              </button>
            ) : null;
          })()}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
          <Avatar user={author} size={16} />
          <UserName user={author} fallbackId={pr.authorId} repoId={pr.repoId} />
          <span>·</span>
          <span>{pr.repoFullName}</span>
          <span>·</span>
          <span>opened {relativeTime(pr.openedAt)}</span>
          {pr.changedFilesCount > 0 && (
            <>
              <span>·</span>
              <button
                type="button"
                onClick={() => goToTab('changes')}
                className="inline-flex shrink-0 items-center gap-1 font-medium"
                title="View the files changed by this PR"
              >
                <span className="text-gray-500">
                  {pr.changedFilesCount} file{pr.changedFilesCount === 1 ? '' : 's'}
                </span>
                <span className="text-green-600 dark:text-green-400">
                  +{pr.additions.toLocaleString()}
                </span>
                <span className="text-red-500 dark:text-red-400">
                  −{pr.deletions.toLocaleString()}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200 px-3 dark:border-gray-800">
        {(
          [
            'overview',
            'threads',
            'activity',
            'changes',
            // Also listed while the bot data is still in flight for a reader who ARRIVED on this
            // tab (a deep link / a refresh), so the strip is never showing a screen with no
            // highlighted tab. It disappears again if the answer comes back empty, and
            // `effectiveTab` moves to Overview with it.
            ...(botTabVisible || effectiveTab === 'bot_activity' ? (['bot_activity'] as Tab[]) : []),
            ...(claudeReviewEnabled ? (['claude_review'] as Tab[]) : []),
            ...(aiFixTabEnabled ? (['ai_fix'] as Tab[]) : []),
          ] as Tab[]
        ).map((t) => {
          const failing = pr.checkRuns.filter(
            (c) => c.state === 'failure' || c.state === 'error',
          ).length;
          return (
            <button
              key={t}
              type="button"
              // Picking a tab by hand drops any pending "show me this finding" target, so
              // opening Changes to browse the diff doesn't re-jump to the last finding — which
              // is `goToTab`'s whole job, so this is no longer a special case.
              onClick={() => goToTab(t)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs ${
                effectiveTab === t
                  ? 'border-blue-500 text-blue-500'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {TAB_LABELS[t]}
              {t === 'overview' && failing > 0 && (
                <span className="ml-1 text-red-500" title={`${failing} failing`}>
                  ●
                </span>
              )}
              {t === 'threads' && pr.threads.length > 0 && (
                <span className="ml-1 opacity-60" title={`${pr.threads.length} threads`}>
                  {pr.threads.length}
                </span>
              )}
              {t === 'changes' && pr.changedFilesCount > 0 && (
                <span
                  className="ml-1 opacity-60"
                  title={`${pr.changedFilesCount} files changed`}
                >
                  {pr.changedFilesCount}
                </span>
              )}
              {t === 'bot_activity' && botTtfrAnomalies > 0 && (
                <span
                  className="ml-1 text-red-500"
                  title={`${botTtfrAnomalies} bot slower than its typical on this PR`}
                >
                  ⚠
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* There is deliberately NO PR-wide "Check review" bar here any more. A whole-PR sweep on a
          bot-flooded PR is many billed calls and tens of seconds before anything appears, and the
          question a reader actually has is about the one thread or comment in front of them. The
          run surface is now the per-item ReviewCheckButton (thread card header / PR-comment
          actions row) — one anchor, one combined call. */}

      <div className="min-h-0 flex-1 overflow-auto">
        <Suspense
          fallback={<div className="px-4 py-6 text-sm text-gray-400">Loading…</div>}
        >
        {effectiveTab === 'overview' ? (
          <div>
            {/* P3.2: the per-PR bot triage card, compact, in the Overview attention area —
                renders nothing (and fetches nothing) below its bot-comment threshold. */}
            <BotTriageCard
              pr={pr}
              usersById={usersById}
              variant="compact"
              onOpenThreads={() => goToTab('threads')}
            />
            <ChecksTab
              pr={pr}
              usersById={usersById}
              onShowBotActivity={botTabVisible ? () => goToTab('bot_activity') : undefined}
            />
            <div className="border-t border-gray-200 dark:border-gray-800">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-1 pt-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  PR comments
                  {pr.comments.length + reviewCommentCount(pr) > 0 && (
                    <span className="ml-1 font-normal opacity-70">
                      · {pr.comments.length + reviewCommentCount(pr)}
                    </span>
                  )}
                </span>
              </div>
              <PrCommentsList
                pr={pr}
                usersById={usersById}
                viewedSince={pr.lastViewedAt}
                focusCommentId={commentFocusForPr}
                selectedCommentId={selectedCommentId}
                onFocusConsumed={consumeCommentFocus}
              />
              <PrCommentComposer prId={pr.id} />
            </div>
          </div>
        ) : effectiveTab === 'threads' ? (
          <>
            {/* P3.2: full triage card — same folds as the list below it (rollupCounts /
                threadSeverities / resolvableBotThreadIds), so the numbers always agree. */}
            <BotTriageCard pr={pr} usersById={usersById} variant="full" />
            <ThreadList
            threads={pr.threads}
            usersById={usersById}
            prUrl={pr.githubUrl}
            prId={pr.id}
            repoId={pr.repoId}
            selectedThreadId={selectedThreadId}
            viewedSince={pr.lastViewedAt}
            botFilter={threadBotFilter}
            stateFilter={threadStateFilter}
            severityFilter={threadSeverityFilter}
            openInChangesFor={openInChangesFor}
          />
          </>
        ) : effectiveTab === 'activity' ? (
          <ActivityList
            pr={pr}
            usersById={usersById}
            since={activitySince}
            onClearSince={() => setActivitySince(null)}
            focusEvent={activityFocusForPr}
            onConsumed={consumeActivityFocus}
          />
        ) : effectiveTab === 'changes' ? (
          <ChangesTab pr={pr} focus={changesFocus} onOpenThread={openThreadInThreads} />
        ) : effectiveTab === 'bot_activity' ? (
          <PrBotBehaviourTab pr={pr} />
        ) : effectiveTab === 'ai_fix' ? (
          <AiFixTab pr={pr} />
        ) : (
          <ClaudeReviewTab
            pr={pr}
            usersById={usersById}
            onOpenInChanges={openInChanges}
          />
        )}
        </Suspense>
      </div>
    </div>
    </PrFocusMetaContext.Provider>
  );
}
