import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DerivedState,
  EventType,
  PrDetail as PrDetailT,
  ReviewState,
  User,
} from '@pierre-review/shared';
import { usePr } from '../hooks/usePr.js';
import { useMe, useProCapabilities } from '../hooks/useTriage.js';
import { useRepos } from '../hooks/useTimeline.js';
import { usePrBotBehaviour } from '../hooks/useBotTriage.js';
import { WatchedBadge } from './WatchedBadge.js';
import { api } from '../api/client.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs, type PinnedPr } from '../store/pinnedTabs.js';
import {
  buildQuotedReply,
  dateTime,
  indexUsers,
  PR_STATE_META,
  relativeTime,
  safeExternalUrl,
} from '../lib/ui.js';
import { Avatar } from './CommentCard.js';
import { UserName } from './UserName.js';
import { ShowOnTimeline, PrFocusMetaContext } from './ShowOnTimeline.js';
import { ExternalLinkIcon, FeedIcon, MagnifierIcon, OctocatIcon, TimelineIcon } from './Icons.js';
import { ThreadList } from './ThreadList/index.js';
import { ChecksTab } from './ChecksTab.js';
import { AddressedCheckControl } from './AddressedCheck.js';
import { ChangesTab } from './ChangesTab.js';
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

type Tab =
  | 'overview'
  | 'threads'
  | 'activity'
  | 'changes'
  | 'bot_activity'
  | 'claude_review'
  | 'ai_fix';

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
                  · {dateTime(r.time)}
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
            </div>
            <div className="mt-1 text-sm">
              <Markdown>{it.body}</Markdown>
            </div>
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
              {isComment && <AddressedCheckControl kind="pr_comment" targetId={it.id} />}
            </div>
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
  const [tab, setTab] = useState<Tab>('overview');
  const [activitySince, setActivitySince] = useState<string | null>(null);
  const qc = useQueryClient();
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  // "Show in Activity feed" — jump to this PR's repo console (activity sub-tab) with the PR
  // isolated as the feed filter. ORDER IS LOAD-BEARING: setActivityRepo clears feedIsolatedPrId,
  // so isolate AFTER the rail move (mirrors OpenPrsDetail.showInFeed / BotOnlyPrsDetail).
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
    if (selectedThreadId != null) setTab('threads');
  }, [selectedThreadId]);

  // Clicking a review-bot chip in Overview (ChecksTab) sets threadBotFilter → jump to the
  // Threads tab, which then shows only that vendor's threads.
  const threadBotFilter = useFilters((s) => s.threadBotFilter);
  useEffect(() => {
    if (threadBotFilter != null) setTab('threads');
  }, [threadBotFilter]);

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
  useEffect(() => {
    if (threadStateFilter.size > 0) setTab('threads');
  }, [threadStateFilter]);

  // A timeline deep link to an Activity entry (e.g. the commit popover) forces the
  // Activity tab and clears the "since" filter so the target is visible; the list
  // then scrolls to + flashes it.
  useEffect(() => {
    if (activityFocusForPr) {
      setTab('activity');
      setActivitySince(null);
    }
  }, [activityFocusForPr]);

  // The global Claude-review banner deep-links here: open the Claude Review tab
  // for the matching PR, then consume the signal.
  useEffect(() => {
    if (claudeReviewEnabled && claudeTabFocus && pr && claudeTabFocus.prId === pr.id) {
      setTab('claude_review');
      consumeClaudeTabFocus();
    }
  }, [claudeTabFocus, pr, claudeReviewEnabled, consumeClaudeTabFocus]);

  // "Generate fix from this review" (or any deep link) → open the AI Fix tab for the
  // matching PR. The signal is NOT consumed here — AiFixTab reads its `reviewText` to
  // seed the prompt, then consumes it.
  useEffect(() => {
    if (aiFixTabEnabled && aiFixTabFocus && pr && aiFixTabFocus.prId === pr.id) {
      setTab('ai_fix');
    }
  }, [aiFixTabFocus, pr, aiFixTabEnabled]);

  // A timeline deep link to a PR comment (the pr_comment popover's "Open in detail
  // pane") forces the Overview tab, where PrCommentsList then scrolls to + flashes
  // it. PrCommentsList consumes the signal (not here) once it has scrolled.
  useEffect(() => {
    if (commentFocusForPr != null) setTab('overview');
  }, [commentFocusForPr]);

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
  // If the active tab is bot_activity but this PR has no bot reviewers (e.g. switched to a
  // human-only PR while on the tab), fall back to Overview so the content can't strand.
  useEffect(() => {
    if (tab === 'bot_activity' && !botTabVisible) setTab('overview');
  }, [tab, botTabVisible]);

  // Keep a pinned tab's label fresh if the PR detail (re)loads with a new title /
  // author (e.g. a renamed PR). No-op when the PR isn't pinned or nothing changed.
  useEffect(() => {
    if (pr != null) syncPinnedMeta(pinnedMetaOf(pr, usersById));
  }, [pr, usersById, syncPinnedMeta]);

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
          {(() => {
            const summary = newSummary(pr.newSinceLastViewed);
            return summary ? (
              <button
                type="button"
                onClick={() => {
                  setTab('activity');
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
          <span className="inline-flex items-center gap-1">
            {pr.repoFullName}
            {repos?.find((r) => r.id === pr.repoId)?.inboxWatch && (
              <WatchedBadge size={11} />
            )}
          </span>
          <span>·</span>
          <span>opened {relativeTime(pr.openedAt)}</span>
          {pr.changedFilesCount > 0 && (
            <>
              <span>·</span>
              <button
                type="button"
                onClick={() => setTab('changes')}
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
            ...(botTabVisible ? (['bot_activity'] as Tab[]) : []),
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
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs ${
                tab === t
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

      <div className="min-h-0 flex-1 overflow-auto">
        <Suspense
          fallback={<div className="px-4 py-6 text-sm text-gray-400">Loading…</div>}
        >
        {tab === 'overview' ? (
          <div>
            <ChecksTab
              pr={pr}
              usersById={usersById}
              onShowBotActivity={botTabVisible ? () => setTab('bot_activity') : undefined}
            />
            <div className="border-t border-gray-200 dark:border-gray-800">
              <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                PR comments
                {pr.comments.length + reviewCommentCount(pr) > 0 && (
                  <span className="ml-1 font-normal opacity-70">
                    · {pr.comments.length + reviewCommentCount(pr)}
                  </span>
                )}
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
        ) : tab === 'threads' ? (
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
          />
        ) : tab === 'activity' ? (
          <ActivityList
            pr={pr}
            usersById={usersById}
            since={activitySince}
            onClearSince={() => setActivitySince(null)}
            focusEvent={activityFocusForPr}
            onConsumed={consumeActivityFocus}
          />
        ) : tab === 'changes' ? (
          <ChangesTab pr={pr} />
        ) : tab === 'bot_activity' ? (
          <PrBotBehaviourTab pr={pr} />
        ) : tab === 'ai_fix' ? (
          <AiFixTab pr={pr} />
        ) : (
          <ClaudeReviewTab pr={pr} usersById={usersById} />
        )}
        </Suspense>
      </div>
    </div>
    </PrFocusMetaContext.Provider>
  );
}
