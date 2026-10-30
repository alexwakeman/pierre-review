import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  EventType,
  PrDetail as PrDetailT,
  PrFilesResponse,
  ReviewState,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import { usePr } from '../hooks/usePr.js';
import type { ThreadStateBucket } from '../lib/claudeThreadMarker.js';
import { usePrCodeLoc } from '../hooks/useLargePr.js';
import { usePrBlast } from '../hooks/useBlastRadius.js';
import { usePrLiveRefresh } from '../hooks/usePrLiveRefresh.js';
import { usePrArmedIntent } from '../hooks/useAutoMerge.js';
import { useMe } from '../hooks/useTriage.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useClaudeReviewTabPill } from '../hooks/useClaudeReview.js';
import { SEVERITY_CLASS, VERDICT_CLASS } from '../lib/claudeReviewFollowUp.js';
import type { ReviewTabPill } from '../lib/claudeReviewColumn.js';
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
  prHeaderCi,
  relativeTime,
  safeExternalUrl,
} from '../lib/ui.js';
import { CiDot } from './Activity/BranchStatusChip.js';
import { Avatar } from './CommentCard.js';
import { CopyButton, writeClipboard } from './CopyButton.js';
import {
  cx,
  FOCUS_RING,
  IconButton,
  Menu,
  panelId,
  StatusIcon,
  tabId,
  Tabs,
  useRegisterCommands,
  type Command,
  type MenuEntry,
  type TabItem,
} from './ui/index.js';
import { UserName } from './UserName.js';
import { ShowOnTimeline, PrFocusMetaContext } from './ShowOnTimeline.js';
import {
  ChevronIcon,
  DotIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  EyeIcon,
  FeedIcon,
  MagnifierIcon,
  MergeIcon,
  NewTabIcon,
  PendingStalledIcon,
  PullRequestIcon,
  LinkIcon,
  OctocatIcon,
  RefreshIcon,
  TimelineIcon,
  TimerIcon,
  WarningIcon,
} from './Icons.js';
import { VerdictIcon } from './VerdictIcon.js';
import { ThreadList } from './ThreadList/index.js';
import { CheckThreadsButton } from './CheckThreadsButton.js';
import { BotTriageCard } from './BotTriageCard.js';
import { LargePrFlag } from './Activity/LargePrFlag.js';
import { BlastRadiusChip } from './Activity/BlastRadiusChip.js';
import { BlastImpactNote } from './Activity/BlastImpactNote.js';
import { ChecksTab } from './ChecksTab.js';
import type { LimnSeverity, MlSeverity } from '@pierre-review/shared';
import { MlSeverityBadge } from './MlSeverityBadge.js';
import { LimnSeverityChip } from './LimnSeverityChip.js';
import { ReactionBar } from './ReactionBar.js';
import { mlLabelKey, useMlLabelIndex, useMlSeverityEnabled } from '../hooks/useMlLabels.js';
import { ChangesTab } from './ChangesTab.js';
import { anchorLineFromHunk } from '../lib/diff.js';
import type { DiffFocusTarget } from './diff/FileDiffView.js';
import { PrCommentComposer } from './PrCommentComposer.js';
import { SkeletonBlock, SkeletonLine } from './Skeleton.js';
// The two agentic tabs are the heaviest components in the app (~3k LOC combined, pulling their
// own deep imports) and most sessions never open them. Lazy-load them so they leave the initial bundle and fetch on first open. (Named
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

// The tab button uses `capitalize`, which can't produce "AI Review" from a
// key, so labels are mapped explicitly. "AI Review" names the feature: one tab holds every run,
// whichever provider made it (each run names its own).
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  comments: 'Comments',
  // Never listed in the strip (Activity is a section of Overview now); kept for the type.
  activity: 'Activity',
  changes: 'Changes',
  bot_activity: 'Bot activity',
  claude_review: 'AI Review',
  ai_fix: 'AI Fix',
};

// The Claude Review tab label's outcome pill: the verdict in its VERDICT_CLASS colour, or the run
// in flight / failed. 11px, the label floor.
const TAB_PILL = 'ml-1.5 inline-flex items-center gap-1 rounded-ui px-1.5 py-px text-meta font-medium';
function ReviewTabOutcome({ pill }: { pill: ReviewTabPill }): JSX.Element {
  const tone =
    pill.kind === 'verdict'
      ? VERDICT_CLASS[pill.verdict]
      : pill.kind === 'failed'
        ? SEVERITY_CLASS.blocker
        : pill.kind === 'running'
          ? 'bg-ai-signal/10 text-ai-signal'
          : 'bg-gray-500/10 text-gray-600 dark:text-gray-300';
  return (
    <span className={`${TAB_PILL} ${tone}`}>
      {pill.kind === 'running' && (
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-signal-fill" />
      )}
      {pill.kind === 'verdict' && <VerdictIcon verdict={pill.verdict} size={11} />}
      {pill.kind === 'failed' && <WarningIcon size={11} aria-hidden />}
      {pill.label}
    </span>
  );
}

interface ActivityRow {
  key: string;
  time: string;
  label: string;
  actorId: number | null;
  detail?: string;
  href?: string;
  /** A commit row's full SHA — printed as the 7-character short hash, copied in full. */
  sha?: string;
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
      sha: c.sha,
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

  // COMPACT: one line per entry (it used to be a whole tab of three-line cards). Same rows, same
  // order, same two controls — the timeline magnifier and the GitHub link — as icons at the end.
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="pr-activity-list">
      {since && (
        <li className="flex items-center gap-2 bg-sky-500/5 px-4 py-1 text-meta text-sky-700 dark:text-sky-400">
          <span>Showing {rows.length} since you last looked</span>
          <button
            type="button"
            onClick={onClearSince}
            className="hit ml-auto text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Show all
          </button>
        </li>
      )}
      {rows.map((r) => {
        const user = r.actorId != null ? usersById.get(r.actorId) : undefined;
        const href = r.href != null ? safeExternalUrl(r.href) : null;
        return (
          <li
            key={r.key}
            ref={(el) => {
              if (el) rowRefs.current.set(r.key, el);
              else rowRefs.current.delete(r.key);
            }}
            className={`flex items-center gap-1.5 px-4 py-1 text-meta ${
              r.key === flashKey ? 'activity-flash' : ''
            }`}
          >
            <Avatar user={user} size={16} />
            <UserName
              user={user}
              fallbackId={r.actorId}
              repoId={pr.repoId}
              className="shrink-0 font-medium"
            />
            <span className="shrink-0 text-gray-500 dark:text-gray-400">{r.label}</span>
            {r.sha && (
              <span className="inline-flex shrink-0 items-center gap-0.5">
                <a
                  href={safeExternalUrl(r.href ?? `${pr.githubUrl}/commits/${r.sha}`)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hit font-mono text-gray-500 hover:text-blue-500 dark:text-gray-400"
                  aria-label={`Commit ${r.sha.slice(0, 7)} on GitHub`}
                >
                  {r.sha.slice(0, 7)}
                </a>
                <CopyButton text={r.sha} what="commit hash" title="Copy commit hash" />
              </span>
            )}
            <span
              className="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400"
              title={r.detail}
            >
              {r.detail?.split('\n')[0]}
            </span>
            <span
              className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400"
              title={dateTime(r.time)}
            >
              {relativeTime(r.time)}
            </span>
            {/* Opens the PR's OWN timeline tab centred on this event (the one focus-entry funnel
                every "show this moment" control uses). */}
            <ShowOnTimeline
              prId={pr.id}
              at={r.time}
              event={r.event}
              title="Show on this PR's own timeline"
            />
            {href != null && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="hit shrink-0 rounded-ui p-0.5 text-gray-500 hover:text-blue-500 dark:text-gray-400"
                title="Open on GitHub"
                aria-label="Open on GitHub"
              >
                <ExternalLinkIcon size={12} />
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Overview's last section: the PR's Activity (opened, commits, reviews, comments, merged/closed),
 * newest first. It was a tab of its own; now it sits COLLAPSED at the foot of Overview, and the
 * header bar is the toggle (the Default branches strip's pattern). `open` is owned by PrDetail,
 * because a `?prTab=activity` link, the timeline's commit popover and the header's "N new" chip
 * all open it from outside.
 */
export function ActivitySection({
  open,
  onToggle,
  count,
  scrollNonce,
  onScrollConsumed,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  count: number;
  /** Set when something outside asks to SEE the section (the header's "N new" chip, an arrival on
   *  `'activity'`). Consumed after one scroll, so a later return to Overview does not jump. */
  scrollNonce?: number | null;
  onScrollConsumed?: () => void;
  children?: React.ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scrollNonce == null) return;
    ref.current?.scrollIntoView({ block: 'start' });
    onScrollConsumed?.();
    // Keyed on the nonce alone: the callback is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollNonce]);
  return (
    <section
      ref={ref}
      className="mt-2"
      data-testid="pr-activity-section"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cx('flex h-9 w-full items-center gap-2 px-4 text-left hover:bg-ui-hover touch:h-11 md:px-5', FOCUS_RING)}
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={10} className="shrink-0 text-ui-faint" />
        <span className="text-body font-medium text-ui-ink">
          Activity
        </span>
        <span className="ml-auto text-meta tabular-nums text-ui-faint">
          {count} event{count === 1 ? '' : 's'}
        </span>
      </button>
      {open && children}
    </section>
  );
}

// A review that carries a body counts as a "PR comment" for the conversation view (the
// note the reviewer wrote when submitting — a plain "Review: comment", or the summary
// attached to an approval / change-request). Inline review-thread comments live in the
// Changes tab's threads, so they're NOT counted here.
const reviewCommentCount = (pr: PrDetailT): number =>
  pr.reviews.filter((r) => r.body != null && r.body.trim() !== '').length;

/** The Comments tab's badge: issue-level PR comments plus reviews that carried a body — exactly
 *  the items `PrCommentsList` renders, so the badge and the list cannot disagree. */
export const prConversationCount = (pr: PrDetailT): number =>
  pr.comments.length + reviewCommentCount(pr);

// Small state pill next to a review author in the conversation, so an approval-with-note
// reads differently from a plain review comment or a change request.
const REVIEW_TAG: Record<ReviewState, { label: string; cls: string }> = {
  approved: { label: 'approved', cls: 'bg-green-500/10 text-green-700 dark:text-green-400' },
  changes_requested: {
    label: 'changes requested',
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  commented: { label: 'review', cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' },
  dismissed: { label: 'dismissed', cls: 'bg-gray-500/10 text-gray-500 dark:text-gray-400' },
  pending: { label: 'pending', cls: 'bg-gray-500/10 text-gray-500 dark:text-gray-400' },
};

function ReviewStateTag({ state }: { state: ReviewState }): JSX.Element {
  const t = REVIEW_TAG[state];
  return (
    <span
      className={`rounded-ui px-1.5 py-0.5 text-meta font-medium ${t.cls}`}
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
  // A PR-level comment Limn posted as a finding: its severity (PrCommentDetail.limnSeverity).
  limnSeverity?: LimnSeverity | null;
};

// The PR conversation: issue-level comments PLUS reviews that carry a body (a review
// summary / "Review: comment"), merged chronologically. Comments map to a `pr_comment`
// timeline event, reviews to `review_submitted`, so "Show on timeline" reuses the same
// (type, refId) + recenter mechanism as the Activity tab. Inline review-thread comments
// are the Changes tab's concern, not this list.
function PrCommentsList({
  pr,
  usersById,
  viewedSince,
  focusKey,
  selectedCommentId,
  onFocusConsumed,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  viewedSince: string | null;
  // Deep link from the timeline (pr_comment popover → "Open in detail pane"):
  // scroll to + flash this comment card, then consume the request.
  // `${kind}:${id}` — `comment:<pr_comments.id>` or `review:<reviews.id>` (a Pending mention can
  // point at a review body), the same key the rows render under.
  focusKey: string | null;
  // The selected comment gets a PERMANENT amber border (mirrors a selected thread),
  // distinct from the one-shot flash above.
  selectedCommentId: number | null;
  onFocusConsumed: () => void;
}): JSX.Element {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [flashId, setFlashId] = useState<string | null>(null);
  // The item whose expand-in-place reply composer is open (only one at a time). Keyed by
  // `${kind}:${id}` so a review id can't collide with a comment id.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // Scroll to + flash the deep-linked comment once it's rendered, then consume the
  // request (the flash lives on its own state so consuming can't cancel it early).
  useEffect(() => {
    if (focusKey == null) return;
    onFocusConsumed();
    const el = cardRefs.current.get(focusKey);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(focusKey);
  }, [focusKey, onFocusConsumed]);

  useEffect(() => {
    if (flashId == null) return;
    const t = setTimeout(() => setFlashId(null), 1800);
    return () => clearTimeout(t);
  }, [flashId]);

  // ML severity/category labels for this PR — the same one-query-per-PR index the Changes tab's threads
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
        limnSeverity: c.limnSeverity ?? null,
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
      <div className="px-4 py-6 text-center text-body text-ui-mute md:px-5">
        No PR comments on this PR.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-2 px-3 pb-3 md:px-5">
      {items.map((it) => {
        const user = it.authorId != null ? usersById.get(it.authorId) : undefined;
        const isNew = isNewComment(it.at, viewedSince);
        const isComment = it.kind === 'comment';
        const rowKey = `${it.kind}:${it.id}`;
        // The permanent selection targets comment ids only (the pr_comment popover); the
        // one-shot scroll + flash takes either kind (a Pending mention in a review body).
        const selected = isComment && it.id === selectedCommentId;
        const flashing = rowKey === flashId;
        return (
          <div
            key={rowKey}
            ref={(el) => {
              if (el) cardRefs.current.set(rowKey, el);
              else cardRefs.current.delete(rowKey);
            }}
            // A tone, not a border; the selected comment keeps its permanent amber ring.
            className={`rounded-ui bg-ui-surface px-3 py-2.5 ${
              selected ? 'ring-1 ring-amber-400' : ''
            } ${isNew ? 'comment-new' : ''} ${flashing ? 'activity-flash' : ''}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ui-mute">
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
              <Avatar user={user} size={18} />
              <UserName
                user={user}
                fallbackId={it.authorId}
                repoId={pr.repoId}
                className="font-medium text-ui-ink"
              />
              {it.kind === 'review' && it.state != null && <ReviewStateTag state={it.state} />}
              <span className="whitespace-nowrap text-ui-faint" title={dateTime(it.at)}>
                {relativeTime(it.at)}
              </span>
              {isNew && <NewTag />}
              {/* A PR-level comment Limn posted as a finding: its severity. */}
              <LimnSeverityChip severity={it.limnSeverity} />
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
            <div className="mt-1.5 text-body">
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
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta">
              {replyingTo !== rowKey && (
                <button
                  type="button"
                  onClick={() => setReplyingTo(rowKey)}
                  className="text-ui-accent hover:underline touch:min-h-10"
                >
                  Reply
                </button>
              )}
              {it.url && (
                <a
                  href={safeExternalUrl(it.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-ui-accent hover:underline touch:min-h-10"
                >
                  <ExternalLinkIcon size={11} />
                  {isComment ? 'View comment on GitHub' : 'View review on GitHub'}
                </a>
              )}
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
      {/* Header: the title line, then the meta line (state, CI, repo, author). */}
      <div className="px-4 pt-3 md:px-5">
        <div className="flex items-center gap-2">
          <SkeletonLine className="h-4 w-1/2" />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <SkeletonLine className="h-3 w-12" />
          {/* The header's CI readout (dot + word) — open PRs, the common case here. */}
          <SkeletonLine className="h-3 w-20" />
          <SkeletonLine className="h-3 w-32" />
          <SkeletonLine className="h-3 w-20" />
        </div>
      </div>
      {/* Tab strip. */}
      <div className="flex gap-3 px-4 py-3 md:px-5">
        {[16, 14, 14, 14].map((w, i) => (
          <SkeletonLine key={i} className="h-3.5" style={{ width: `${w * 4}px` }} />
        ))}
      </div>
      {/* Content blocks. */}
      <div className="flex flex-1 flex-col gap-3 px-4 md:px-5">
        <SkeletonBlock className="h-20" />
        <SkeletonBlock className="h-16" />
        <SkeletonBlock className="h-16" />
      </div>
    </div>
  );
}

// Stable empty filter for the guarded threadStateFilter (see the effect below) — a fresh Set
// each render would churn the effect deps.
const EMPTY_THREAD_STATE_FILTER: Set<ThreadStateBucket> = new Set();
const EMPTY_THREAD_SEVERITY_FILTER: Set<MlSeverity> = new Set();

// Every icon button in the header toolbar wears ONE class, so the cluster reads as one set: mute
// ink, the one radius, 32px (40px on touch). Hidden below md, where the overflow menu says every
// one of them in words. Refresh's warn-ink stale state is the one exception (it means something,
// so it also stays on screen on a phone).
export const PR_HEADER_ICON_BTN =
  'hidden h-8 w-8 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink md:inline-flex touch:h-10 touch:w-10 motion-safe:transition-colors motion-safe:duration-ui-fast ' +
  FOCUS_RING;

export function PrDetail({
  prId,
  selectedThreadId,
  placement,
}: {
  prId: number;
  selectedThreadId: number | null;
  /** WHERE it is mounted, decided by the mount site (never re-derived from `activeTab`: the pane
   *  can stay mounted under an overlay for another PR). `'pane'` = the bottom pane under the
   *  shared Timeline or a Focus tab; `'fullscreen'` = the pinned PR tab. Required on purpose, so a
   *  new mount cannot silently inherit the pane's "open full-screen" controls. */
  placement: 'pane' | 'fullscreen';
}): JSX.Element {
  const { data: pr, isLoading, error } = usePr(prId);
  // The large-PR flag's two numbers. ⚠ They ride the LEAN LIST payloads, not `/api/prs/:id` — the
  // classifier that decides what counts as "code" lives server-side in `db/code-loc.ts`, and
  // re-summing `pr.files` here would be a second classifier free to disagree with the boards. So
  // the header borrows the measurement the timeline/open-PR caches already hold; a PR in neither
  // resolves to "no measurement" and therefore no flag, exactly like an unmeasured PR.
  const codeLocFields = usePrCodeLoc(prId);
  // ⚠ A CACHE READ, NOT A LOCAL CLASSIFICATION. This pane HAS `pr.files` and could classify them
  // itself — which would put a SECOND path classifier in the SPA, one that disagrees silently
  // with `db/blast-radius.ts` on any file the two lists do not share. See usePrBlast's header.
  const blastFields = usePrBlast(prId);
  const { data: repos } = useRepos();
  // The agentic tabs are local-only: `me.ai.enabled`. Locally they
  // always list; a missing runtime or credential is handled INSIDE the tab, in place of Run.
  const aiEnabled = useAiCapabilities().enabled;
  const claudeReviewEnabled = aiEnabled;
  // The review's outcome on the tab label ("Claude Review [Approve]"): the tab's own cached read.
  const reviewPill = useClaudeReviewTabPill(prId, claudeReviewEnabled);
  const aiFixTabEnabled = aiEnabled;
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
  // The Changes tab's inline-thread OPEN/SHUT decisions, keyed by thread id — the reader's clicks
  // and the reveals that opened a pill, NEVER the default (an undecided pill starts from its
  // thread's CURRENT state: open unless resolved). LOCAL here for the same reason as
  // `changesFocus`: both mounts key PrDetail by prId, so this lives exactly as long as this PR's
  // pane — and it must outlive ChangesTab, which every tab switch remounts. A plain Map mutated in
  // place and read only when a pill MOUNTS, so a click re-renders one pill and never this component.
  const [threadOpenMemory] = useState(() => new Map<number, boolean>());
  // The Changes tab's "Threads only" view (the review threads without the code) — there is no
  // Threads TAB any more. LOCAL for the same reason as `changesFocus`: it belongs to this PR's
  // pane. Owned here, not in ChangesTab, because the deep links below switch it: a selected thread
  // whose file has left the diff, the Overview's Bots chip, a state-pill preset. "Show in context"
  // (`openInChanges`) switches it off.
  const [changesThreadsOnly, setChangesThreadsOnly] = useState(false);
  // The header CI readout's "show me" — a nonce ChecksTab consumes by scrolling its Status row
  // into view, so the click lands there even when Overview is already the tab on screen (the tab
  // body's scroll container is shared by every tab and never reset). Consumed, not sticky: a
  // later return to Overview through the tab bar must not re-scroll.
  const [statusFocus, setStatusFocus] = useState<number | null>(null);
  /**
   * THE ONLY WAY TO CHANGE TABS — every path below goes through this, and the reason is
   * `changesFocus`.
   *
   * A deep-link target is consumed by ChangesTab when Changes is on screen, but nothing
   * un-sets it afterwards, so it OUTLIVES the visit: land on Changes via a finding anchor, let
   * anything move the tab away (a review banner forces Claude Review, a comment deep link forces
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
   * (a Bots chip forces the Changes tab's threads, a review banner forces Claude Review, …).
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
    // as part of the reveal (a resolved thread starts shut there and the reader may have shut
    // any other; a jump landing beside a shut pill reads as a broken link). Claude Review
    // anchors carry none.
    threadId?: number,
  ): void => {
    // THE ONE DELIBERATE EXCEPTION to `goToTab`, and the ordering is the whole point: this path
    // exists to SET a focus, and `goToTab` clears it. Move the tab first, then arm the target, so
    // no clearing sits between the two. It is also "Show in context": the code comes back.
    setPrDetailTab(prId, 'changes');
    setChangesThreadsOnly(false);
    setChangesFocus({ path, line, side, threadId: threadId ?? null, nonce: Date.now() });
  };
  /** The Changes tab with its "Threads only" view on — where every "see the threads" link lands. */
  const openThreadsView = useCallback((): void => {
    goToTab('changes');
    setChangesThreadsOnly(true);
  }, [goToTab]);
  /** The same, made by a deep-link effect rather than the reader: a URL correction. */
  const seedThreadsView = useCallback((): void => {
    markUrlCorrection();
    openThreadsView();
  }, [openThreadsView]);
  const [activitySince, setActivitySince] = useState<string | null>(null);
  // Overview's Activity section: COLLAPSED by default. `'activity'` as the seated tab (an old
  // `?prTab=activity` link, the timeline's commit popover, the header's "N new" chip) means
  // "Overview, with this section open" — DERIVED below, never written back. The local flag holds the
  // reader's own clicks and mirrors an arrival on `'activity'`, so pressing the Overview tab
  // afterwards does not snap the section shut under them.
  const [activityOpenLocal, setActivityOpenLocal] = useState(false);
  const [activityScroll, setActivityScroll] = useState<number | null>(null);
  useEffect(() => {
    if (tab !== 'activity') return;
    setActivityOpenLocal(true);
    // Arriving on it (a Pending card, an old link) should SHOW the section, which sits below the
    // fold of Overview. Not when a single entry is targeted: ActivityList scrolls to that row.
    if (useFilters.getState().activityFocus?.prId !== prId) setActivityScroll((n) => (n ?? 0) + 1);
  }, [tab, prId]);
  const activityOpen = activityOpenLocal || tab === 'activity';
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
   * SHOW ONE THREAD — the ONE landing for every thread link into this PR (a Pending card, My Turn,
   * the Feed, a timeline marker, the Claude Review tab's thread rows): the Changes tab with the
   * code, scrolled to the thread's pill, opened and ringed. It takes the thread → code ladder
   * (`openInChangesFor`); when the thread's file has left the diff (rung 4) it lands on the
   * Threads only view instead, with the thread selected so the list scrolls to it. A thread this
   * pane does not hold (a stale link) lands on the Threads only view too, never on nothing.
   *
   * `handledThreadRef` is the selected-thread effect's record: a selection made HERE is already
   * shown, so the effect must not show it a second time.
   */
  const handledThreadRef = useRef<number | null>(null);
  const showThread = (threadId: number): void => {
    const thread = pr?.threads.find((t) => t.id === threadId);
    const jump = thread != null ? openInChangesFor(thread) : null;
    if (jump != null) {
      jump.run();
      return;
    }
    handledThreadRef.current = threadId;
    // `selectThread` also clears the state/severity pill presets that could filter it out.
    useFilters.getState().selectThread(prId, threadId);
    setPrDetailTab(prId, 'changes');
    setChangesThreadsOnly(true);
  };
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
  const prChangesFocus = useFilters((s) => s.prChangesFocus);
  const consumePrChangesFocus = useFilters((s) => s.consumePrChangesFocus);
  const commentFocusForPr =
    commentFocus && pr && commentFocus.prId === pr.id
      ? `${commentFocus.kind ?? 'comment'}:${commentFocus.commentId}`
      : null;

  // Keep a full-screen pr-detail tab's label fresh if the PR (re)loads renamed.
  const syncPinnedMeta = usePinnedTabs((s) => s.syncMeta);

  // SELECTING A THREAD (a Pending card, My Turn, the Feed, a timeline marker, a `?thread=` link)
  // shows it in the Changes tab — the code, scrolled to its pill and ringed (`showThread`). Waits
  // for the PR (the ladder needs its threads and files) and shows each selection ONCE: a refetch
  // must not yank the reader back to it. A URL correction, like every deep-link effect here.
  const prLoaded = pr != null;
  useEffect(() => {
    if (selectedThreadId == null) {
      handledThreadRef.current = null;
      return;
    }
    if (!prLoaded || handledThreadRef.current === selectedThreadId) return;
    handledThreadRef.current = selectedThreadId;
    markUrlCorrection();
    showThread(selectedThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showThread is a fresh closure each render
  }, [selectedThreadId, prLoaded]);

  // Clicking a review-bot chip in Overview (ChecksTab) sets threadBotFilter → the Changes tab's
  // Threads only view, which then shows only that vendor's threads.
  const threadBotFilter = useFilters((s) => s.threadBotFilter);
  useEffect(() => {
    if (threadBotFilter != null) seedThreadsView();
  }, [threadBotFilter, seedThreadsView]);

  // Arriving from the resolvable-bot-threads tab presets a derived-state pill (likely_addressed)
  // → force the Threads only view so the relevant threads are visible immediately. The preset belongs
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
    if (threadStateFilter.size > 0) seedThreadsView();
  }, [threadStateFilter, seedThreadsView]);

  // A timeline deep link to an Activity entry (e.g. the commit popover) seats `'activity'` —
  // Overview with its Activity section open — and clears the "since" filter so the target is
  // visible; the list then scrolls to + flashes it.
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

  // A design-grid card for ANOTHER PR (a story design) deep-links here: the Changes tab, focused on
  // its file. Routed through `openInChanges` (the one helper that sets the tab THEN the focus), as a
  // URL correction — the open that mounted this pane already pushed the history entry.
  useEffect(() => {
    if (prChangesFocus && pr && prChangesFocus.prId === pr.id) {
      markUrlCorrection();
      const { threadId } = prChangesFocus;
      // A Pending comment card names a THREAD: `showThread` takes the thread → code ladder (live
      // line, else the anchor hunk's, else the file), and when the file has left the diff, lands
      // on the thread in the Threads only view instead.
      const thread = threadId != null ? pr.threads.find((t) => t.id === threadId) : undefined;
      if (thread != null) {
        showThread(thread.id);
      } else {
        openInChanges(prChangesFocus.path, prChangesFocus.line ?? null, 'RIGHT', threadId);
      }
      consumePrChangesFocus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openInChanges is a fresh closure each render
  }, [prChangesFocus, pr, consumePrChangesFocus]);

  // "Generate fix from this review" (or any deep link) → open the AI Fix tab for the
  // matching PR. The signal is NOT consumed here — AiFixTab reads its `reviewId`, then
  // consumes it.
  useEffect(() => {
    if (aiFixTabEnabled && aiFixTabFocus && pr && aiFixTabFocus.prId === pr.id) {
      seedTab('ai_fix');
    }
  }, [aiFixTabFocus, pr, aiFixTabEnabled, seedTab]);

  // A timeline deep link to a PR comment (the pr_comment popover's "Open in detail
  // pane") forces the Comments tab, where PrCommentsList then scrolls to + flashes
  // it. PrCommentsList consumes the signal (not here) once it has scrolled.
  useEffect(() => {
    if (commentFocusForPr != null) seedTab('comments');
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
      // wrong the moment this succeeds. Without these two the card sat on the **Pending**
      // board until its 60s staleTime or the 5-min interval: the user opens the PR the card
      // pointed at, comes back, and the card is still there telling them to look at it.
      // Invalidated at the PREFIX (both keys are `[name, 'ws:<id>']` — see useAttentionCards /
      // useDailyBrief) so every cached workspace refreshes.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      // …and the THIRD read of that fold: the three move together (prCacheSync.ts).
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
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

  // PR-scoped bot behaviour (EXPERIMENTAL): a CHEAP client gate that ENABLES the
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
   * `botsInnerTab` / `insightsInnerTab` follow.
   */
  const botTabResolved = pr != null && (!hasBots || prBotBehaviour !== undefined);
  // `'activity'` is not a screen of its own any more: it renders Overview (section open, above).
  const effectiveTab: Tab =
    tab === 'activity'
      ? 'overview'
      : tab === 'bot_activity' && botTabResolved && !botTabVisible
        ? 'overview'
        : tab;

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

  // ⌘K: this PR's tabs and toolbar, registered only while THIS copy is the one on screen (the pane
  // can stay mounted under another PR's overlay). The handlers are read through a ref so the list
  // is rebuilt only when what it SAYS changes, never on every render.
  const cmdLive = useRef<{ tab: (t: Tab) => void; act: (id: string) => void }>({ tab: () => {}, act: () => {} });
  const cmdTabs = [
    'overview',
    'comments',
    'changes',
    ...(botTabVisible ? (['bot_activity'] as Tab[]) : []),
    ...(claudeReviewEnabled ? (['claude_review'] as Tab[]) : []),
    ...(aiFixTabEnabled ? (['ai_fix'] as Tab[]) : []),
  ] as Tab[];
  const cmdTabsKey = cmdTabs.join(',');
  const prNumber = pr?.number ?? null;
  const prCommands = useMemo((): Command[] | null => {
    if (!liveVisible || prNumber == null) return null;
    const where = `#${prNumber}`;
    const tabs = cmdTabsKey.split(',') as Tab[];
    return [
      ...tabs.map(
        (t, i): Command => ({
          id: `pr-tab:${t}`,
          title: `${TAB_LABELS[t]} (this pull request)`,
          group: 'Go to',
          hint: where,
          shortcut: i < 9 ? String(i + 1) : undefined,
          keywords: ['tab', 'pr', 'pull request'],
          run: () => cmdLive.current.tab(t),
        }),
      ),
      ...(placement === 'pane'
        ? [{ id: 'pr:full', title: 'Open this pull request full-screen', group: 'Actions' as const, hint: where, run: () => cmdLive.current.act('full') }]
        : []),
      { id: 'pr:timeline', title: 'Show this pull request on the timeline', group: 'Actions', hint: where, run: () => cmdLive.current.act('timeline') },
      { id: 'pr:focus', title: 'Focus this pull request in its own timeline tab', group: 'Actions', hint: where, run: () => cmdLive.current.act('focus') },
      { id: 'pr:feed', title: 'Show this pull request in the Activity feed', group: 'Actions', hint: where, run: () => cmdLive.current.act('feed') },
      { id: 'pr:refresh', title: 'Refresh this pull request from GitHub', group: 'Actions', hint: where, run: () => cmdLive.current.act('refresh') },
      { id: 'pr:copy', title: 'Copy the GitHub link to this pull request', group: 'Actions', hint: where, run: () => cmdLive.current.act('copy') },
      { id: 'pr:github', title: 'Open this pull request on GitHub', group: 'Actions', hint: where, run: () => cmdLive.current.act('github') },
      { id: 'pr:ci', title: 'Show CI status (Overview)', group: 'Actions', hint: where, run: () => cmdLive.current.act('ci') },
      { id: 'pr:threads', title: 'Show the review threads (Changes, threads only)', group: 'Actions', hint: where, keywords: ['comments', 'review'], run: () => cmdLive.current.act('threads-view') },
      { id: 'pr:activity', title: 'Show this pull request’s activity (Overview)', group: 'Actions', hint: where, run: () => cmdLive.current.act('activity') },
    ];
  }, [liveVisible, prNumber, cmdTabsKey, placement]);
  useRegisterCommands(`pr-detail:${placement}`, prCommands);

  if (isLoading) {
    return <PrDetailSkeleton />;
  }
  if (error || !pr) {
    return (
      <div className="p-5 text-body text-ui-danger">
        {error ? String(error) : 'PR not found'}
      </div>
    );
  }

  const stateMeta = PR_STATE_META[pr.state];
  const headerCi = prHeaderCi(pr.state, pr.ciStatus);
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  const conversationCount = prConversationCount(pr);

  // "Show in Activity feed" — see the ORDER note by setWorkspace above (isolate LAST).
  const showInFeed = (): void => {
    // Switch scope first when this PR's repo belongs to another workspace. `null` = every repo in
    // the new workspace, which is the REPLACE semantics a scope change wants.
    const prWorkspaceId = repos?.find((r) => r.id === pr.repoId)?.workspaceId ?? null;
    if (prWorkspaceId != null && prWorkspaceId !== activeWorkspaceId) {
      setWorkspace(prWorkspaceId, null);
    }
    setRepoConsoleTab(pr.repoId, 'activity');
    setActivityRepo(pr.repoId);
    setFeedIsolatedPrId(pr.id);
    showActivity();
  };
  const showCiStatus = (): void => {
    goToTab('overview');
    setStatusFocus((n) => (n ?? 0) + 1);
  };
  const showNewActivity = (): void => {
    // Overview, Activity section open and scrolled to, filtered to what's new.
    goToTab('activity');
    setActivitySince(pr.lastViewedAt);
    setActivityScroll((n) => (n ?? 0) + 1);
  };
  const githubHref = safeExternalUrl(pr.githubUrl);
  const newSince = newSummary(pr.newSinceLastViewed);
  cmdLive.current = {
    tab: goToTab,
    act: (id) => {
      if (id === 'full') openPrDetailTab(pinnedMetaOf(pr, usersById));
      else if (id === 'timeline') openPrFocused(pr.id);
      else if (id === 'focus') openPrFocusTab(pinnedMetaOf(pr, usersById));
      else if (id === 'feed') showInFeed();
      else if (id === 'refresh') refreshNow();
      else if (id === 'copy' && githubHref != null) void writeClipboard(githubHref);
      else if (id === 'github' && githubHref != null) window.open(githubHref, '_blank', 'noopener,noreferrer');
      else if (id === 'ci') showCiStatus();
      else if (id === 'threads-view') openThreadsView();
      else if (id === 'activity') {
        goToTab('activity');
        setActivityScroll((n) => (n ?? 0) + 1);
      }
    },
  };
  const failingChecks = pr.checkRuns.filter(
    (c) => !c.limnOwned && (c.state === 'failure' || c.state === 'error'),
  ).length;
  const stateLabel = pr.isDraft ? 'Draft' : stateMeta.label;
  const tabIds: Tab[] = [
    'overview',
    'comments',
    'changes',
    // Also listed while the bot data is still in flight for a reader who ARRIVED on this
    // tab (a deep link / a refresh), so the strip is never showing a screen with no
    // highlighted tab. It disappears again if the answer comes back empty, and
    // `effectiveTab` moves to Overview with it.
    ...(botTabVisible || effectiveTab === 'bot_activity' ? (['bot_activity'] as Tab[]) : []),
    ...(claudeReviewEnabled ? (['claude_review'] as Tab[]) : []),
    ...(aiFixTabEnabled ? (['ai_fix'] as Tab[]) : []),
  ];
  const tabItems: TabItem<Tab>[] = tabIds.map((t) => ({
    id: t,
    label: (
      <>
        {TAB_LABELS[t]}
        {t === 'overview' && failingChecks > 0 && (
          <span className="ml-1 inline-flex text-ui-danger" title={`${failingChecks} failing`}>
            <DotIcon size={7} aria-hidden />
            <span className="sr-only">, {failingChecks} failing</span>
          </span>
        )}
        {t === 'claude_review' && reviewPill != null && <ReviewTabOutcome pill={reviewPill} />}
        {t === 'bot_activity' && botTtfrAnomalies > 0 && (
          <span
            className="ml-1 inline-flex text-ui-danger"
            title={`${botTtfrAnomalies} bot slower than its typical on this PR`}
          >
            <WarningIcon size={12} aria-hidden />
            <span className="sr-only">, a bot slower than typical</span>
          </span>
        )}
      </>
    ),
    count:
      t === 'comments'
        ? conversationCount
        : t === 'changes' && pr.changedFilesCount > 0
          ? pr.changedFilesCount
          : null,
    title:
      t === 'comments'
        ? `${conversationCount} comments`
        : t === 'changes' && pr.changedFilesCount > 0
          ? `${pr.changedFilesCount} files changed`
          : undefined,
  }));
  // Everything the toolbar does, in words — the overflow menu (every width) and, below md, the
  // only way to the actions the icon row hides. Nothing here is unique to the menu.
  const menuItems: MenuEntry[] = [
    ...(placement === 'pane'
      ? [{ id: 'full', label: 'Open full-screen in its own tab', icon: <NewTabIcon size={14} />, onSelect: () => openPrDetailTab(pinnedMetaOf(pr, usersById)) }]
      : []),
    { id: 'timeline', label: 'Show on the timeline', icon: <TimelineIcon size={14} />, onSelect: () => openPrFocused(pr.id) },
    { id: 'focus', label: 'Focus in its own timeline tab', icon: <MagnifierIcon size={14} />, onSelect: () => openPrFocusTab(pinnedMetaOf(pr, usersById)) },
    { id: 'feed', label: 'Show in the Activity feed', icon: <FeedIcon size={14} />, onSelect: showInFeed },
    { id: 'sep', separator: true },
    {
      id: 'refresh',
      label: isRefreshing ? 'Refreshing…' : 'Refresh from GitHub',
      icon: <RefreshIcon size={14} />,
      disabled: isRefreshing,
      onSelect: refreshNow,
    },
    ...(githubHref != null
      ? [
          { id: 'copy', label: 'Copy the GitHub link', icon: <LinkIcon size={14} />, onSelect: () => void writeClipboard(githubHref) },
          { id: 'gh', label: 'Open on GitHub', icon: <OctocatIcon size={14} />, onSelect: () => window.open(githubHref, '_blank', 'noopener,noreferrer') },
        ]
      : []),
  ];

  return (
    <PrFocusMetaContext.Provider value={pinnedMetaOf(pr, usersById)}>
    <div className="flex h-full flex-col bg-ui-bg max-md:overflow-y-auto max-md:overflow-x-clip">
      {/* THE ONE SLIM HEADER: title + toolbar, then one meta line (state, CI, repo, author, age,
          size, reach), then the tabs. pr-12 leaves room for DetailPane's close ✕ in the pane; the
          full-screen tab has none. */}
      <header
        className={cx(
          'shrink-0 px-4 pt-3 md:px-5',
          placement === 'pane' && 'pr-12 md:pr-12',
        )}
      >
        <div className="flex items-start gap-2">
          {/* In the PANE, the title + the ↗ icon both open this PR full-screen as its own
              (focused) tab. Opening a tab IS pinning it, so there's no separate pin control.
              FULL-SCREEN already is that tab: the title is a plain heading and ↗ is absent. */}
          {placement === 'pane' ? (
            <>
              <button
                type="button"
                onClick={() => openPrDetailTab(pinnedMetaOf(pr, usersById))}
                className={cx('hit min-w-0 truncate rounded-ui text-left text-title text-ui-ink hover:underline', FOCUS_RING)}
                title="Open full-screen in its own tab"
              >
                <span className="font-normal text-ui-faint">#{pr.number}</span> {pr.title}
              </button>
              <button
                type="button"
                onClick={() => openPrDetailTab(pinnedMetaOf(pr, usersById))}
                className={PR_HEADER_ICON_BTN}
                title="Open full-screen — this PR in its own tab"
                aria-label="Open this PR full-screen in its own tab"
              >
                <ExternalLinkIcon size={13} />
              </button>
            </>
          ) : (
            <h2 className="min-w-0 text-title text-ui-ink [overflow-wrap:anywhere] md:truncate" title={pr.title}>
              <span className="font-normal text-ui-faint">#{pr.number}</span> {pr.title}
            </h2>
          )}
          {/* THE TOOLBAR — labelled icon buttons (the label is the tooltip and the accessible
              name). Below md only the overflow menu stays (plus Refresh while it is stale); the
              menu says every one of them in words. */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5" role="toolbar" aria-label="This pull request">
            {/* Show on the shared timeline (centre + glow; distinct from Focus Mode). */}
            <button
              type="button"
              onClick={() => openPrFocused(pr.id)}
              className={PR_HEADER_ICON_BTN}
              title="Show this PR on the timeline"
              aria-label="Show this PR on the timeline"
            >
              <TimelineIcon size={15} />
            </button>
            {/* Focus — a magnifier that opens this PR's own isolated timeline tab. */}
            <button
              type="button"
              onClick={() => openPrFocusTab(pinnedMetaOf(pr, usersById))}
              className={PR_HEADER_ICON_BTN}
              title="Focus — open this PR in its own isolated timeline tab (the close button on the tab closes it)"
              aria-label="Focus this PR in its own timeline tab"
            >
              <MagnifierIcon size={15} />
            </button>
            {/* Show in the Activity feed — this PR's repo console with the feed isolated to it. */}
            <button
              type="button"
              onClick={showInFeed}
              className={PR_HEADER_ICON_BTN}
              title="Show this PR in its repo's Activity feed (filtered to this PR)"
              aria-label="Show this PR in the Activity feed"
            >
              <FeedIcon size={15} />
            </button>
            {/* Copy the PR's GitHub link. */}
            {githubHref != null && (
              <span className="hidden md:inline-flex">
                <CopyButton
                  text={githubHref}
                  what="PR link"
                  title="Copy the GitHub link to this PR"
                  icon={<LinkIcon size={14} />}
                  className="h-8 w-8 justify-center"
                  idleClassName="text-ui-mute hover:bg-ui-hover hover:text-ui-ink"
                />
              </span>
            )}
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
              className={
                isStale
                  ? `${PR_HEADER_ICON_BTN} !inline-flex !text-ui-warn disabled:opacity-60`
                  : `${PR_HEADER_ICON_BTN} disabled:opacity-60`
              }
              title={
                isStale
                  ? "Couldn't refresh from GitHub — showing the last synced state. Click to retry."
                  : 'Refresh — re-check GitHub for new activity on this PR'
              }
              aria-label="Refresh this PR from GitHub"
            >
              <RefreshIcon size={14} className={isRefreshing ? 'motion-safe:animate-spin' : undefined} />
            </button>
            {/* Open on GitHub (Octocat). */}
            <a
              href={pr.githubUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={PR_HEADER_ICON_BTN}
              title="Open this PR on GitHub"
              aria-label="Open this PR on GitHub"
            >
              <OctocatIcon size={15} />
            </a>
            <Menu
              label="More actions for this pull request"
              align="end"
              items={menuItems}
              trigger={(p) => (
                <IconButton {...p} label="More actions" icon={<EllipsisIcon size={15} />} className="!inline-flex" />
              )}
            />
          </div>
        </div>
        {/* THE META LINE: state and CI, then the REPO, then the author, age, size and reach.
            13px body ink in the mute tone (both themes clear AA). */}
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-ui-mute"
          data-testid="pr-header-meta"
        >
          <StatusIcon
            tone={pr.state === 'open' && !pr.isDraft ? 'neutral' : 'quiet'}
            icon={pr.state === 'merged' ? <MergeIcon size={14} /> : <PullRequestIcon size={14} />}
            label={stateLabel}
            className="font-medium text-ui-ink"
          />
          {/* CI, visible from EVERY tab because it lives in the header. It reads `pr.ciStatus` —
              the synced rollup the Status row, the Timeline bar and the Pending cards read, never
              the live `checkRuns` — and stays fresh through usePrLiveRefresh's ['pr', prId]
              invalidation (no fetch of its own). Open PRs only: see `prHeaderCi`. The word is an
              AA grey pair, never the CI hex; the dot carries the colour (and a ring for an edge). */}
          {headerCi != null && (
            <button
              type="button"
              data-testid="pr-header-ci"
              onClick={showCiStatus}
              className={cx(
                'inline-flex shrink-0 items-center gap-1.5 rounded-ui px-1 hover:bg-ui-hover hover:text-ui-ink touch:min-h-10',
                headerCi.status === 'failure' || headerCi.status === 'error' ? 'text-ui-danger' : '',
                FOCUS_RING,
              )}
              title="Show CI status in Overview"
              aria-label={`${headerCi.label} — show CI status`}
            >
              <CiDot
                status={headerCi.status}
                size={10}
                title="Show CI status in Overview"
                className={
                  headerCi.status === 'unknown' ? '' : 'ring-1 ring-black/15 dark:ring-white/20'
                }
              />
              {headerCi.label}
            </button>
          )}
          {/* No separator dots: the gap groups the items, and a wrapped line (a phone wraps this
              one twice) never starts or ends on a stray mark. */}
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{pr.repoFullName}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Avatar user={author} size={16} />
              <UserName user={author} fallbackId={pr.authorId} repoId={pr.repoId} />
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-2">
            <span title={dateTime(pr.openedAt)}>opened {relativeTime(pr.openedAt)}</span>
          </span>
          {pr.changedFilesCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-2">
                <button
                type="button"
                onClick={() => goToTab('changes')}
                className={cx('hit inline-flex shrink-0 items-center gap-1 rounded-ui px-0.5 tabular-nums hover:text-ui-ink', FOCUS_RING)}
                title="View the files changed by this PR"
              >
                <span>
                  {pr.changedFilesCount} file{pr.changedFilesCount === 1 ? '' : 's'}
                </span>
                <span className="text-green-700 dark:text-green-400">
                  +{pr.additions.toLocaleString()}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  −{pr.deletions.toLocaleString()}
                </span>
              </button>
            </span>
          )}
          {/* Deliberately OUTSIDE the `changedFilesCount > 0` block: the flag's own resolver is
              the only gate it needs, and it renders nothing for an unmeasured or under-threshold
              PR. Placed right after the raw +/− delta so the two readings sit together — that
              total includes docs, config, lockfiles and generated files; this one does not. */}
          <LargePrFlag pr={codeLocFields} />
          {/* BLAST RADIUS, beside the two size readings. This is the ONE surface that gets the
              EXPANDABLE chip: there is room for the reason list here, and this is where a reader
              who disagrees with a verdict needs to see what decided it. ⚠ It reads the SAME
              `codeLoc` the flag beside it reads, so the two can never quote different line counts
              for one pull request. */}
          <BlastRadiusChip pr={{ ...blastFields, ...codeLocFields }} expandable />
          {pr.isStalled && (
            <span
              className="inline-flex items-center gap-1 text-ui-warn"
              title="Open, no recent commits, and has open threads"
            >
              <PendingStalledIcon size={13} aria-hidden />
              Stalled
            </span>
          )}
          {/* Auto-merge armed — visible from EVERY tab, not just Overview. Display only (the
              disarm affordance lives in the Actions row); honest about the mechanism. */}
          {armedIntent != null && pr.state === 'open' && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-ui-ink"
              title="Auto-merge is armed — Limn updates it from trunk if needed and merges when checks pass, while the app is running. Cancel from Overview → Actions."
            >
              <TimerIcon size={13} aria-hidden />
              Auto-merge armed
            </span>
          )}
          {newSince != null && (
            <button
              type="button"
              onClick={showNewActivity}
              className={cx(
                'inline-flex shrink-0 items-center gap-1 rounded-ui px-1 text-ui-accent hover:bg-ui-hover touch:min-h-10',
                FOCUS_RING,
              )}
              title="Filter activity to what's new since you last looked"
            >
              <EyeIcon size={13} aria-hidden /> {newSince}
            </button>
          )}
        </div>
        {/* The AI half of blast radius, on its own line under the metadata row — two sentences
            need the width, and a click-gated button does not belong inline among the counts.
            ⚠ `hasBlast` gates it on the CHIP having something to explain: with no measurement
            there is no chip and no button. */}
        <BlastImpactNote prId={prId} hasBlast={blastFields.blast != null} />
        {/* THE TABS — counts as facts, 1–9 while this PR is the one on screen. Picking a tab by
            hand drops any pending "show me this finding" target (`goToTab`'s whole job). */}
        <Tabs
          tabs={tabItems}
          value={effectiveTab}
          onChange={goToTab}
          label={`Pull request #${pr.number} tabs`}
          numberKeys={liveVisible}
          idPrefix={`pr-${pr.id}`}
          className="-mx-1 mt-2 pb-2"
        />
      </header>
      <div
        // On a phone the header scrolls away with the content (one scroller, the outer box): a
        // fixed header would leave a third of the screen for the diff.
        className="min-h-0 flex-1 overflow-auto max-md:flex-none max-md:overflow-visible"
        role="tabpanel"
        id={panelId(`pr-${pr.id}`, effectiveTab)}
        aria-labelledby={tabId(`pr-${pr.id}`, effectiveTab)}
      >
        <Suspense
          fallback={<div className="px-5 py-6 text-body text-ui-faint">Loading…</div>}
        >
        {effectiveTab === 'overview' ? (
          <div>
            {/* P3.2: the per-PR bot triage card, compact, in the Overview attention area —
                renders nothing (and fetches nothing) below its bot-comment threshold. */}
            <BotTriageCard
              pr={pr}
              usersById={usersById}
              variant="compact"
              onOpenThreads={openThreadsView}
            />
            <ChecksTab
              pr={pr}
              usersById={usersById}
              onShowBotActivity={botTabVisible ? () => goToTab('bot_activity') : undefined}
              onOpenThreads={openThreadsView}
              statusFocus={statusFocus}
              onStatusFocusConsumed={() => setStatusFocus(null)}
            />
            {/* The PR's Activity, collapsed at the foot of Overview (it was a tab). */}
            <ActivitySection
              open={activityOpen}
              count={buildActivity(pr).length}
              scrollNonce={activityScroll}
              onScrollConsumed={() => setActivityScroll(null)}
              onToggle={() => {
                if (activityOpen) {
                  setActivityOpenLocal(false);
                  // Shutting it while the seated tab still says "activity" must move the tab, or
                  // the derived open state would hold it open.
                  if (tab === 'activity') goToTab('overview');
                } else {
                  setActivityOpenLocal(true);
                }
              }}
            >
              <ActivityList
                pr={pr}
                usersById={usersById}
                since={activitySince}
                onClearSince={() => setActivitySince(null)}
                focusEvent={activityFocusForPr}
                onConsumed={consumeActivityFocus}
              />
            </ActivitySection>
          </div>
        ) : effectiveTab === 'comments' ? (
          // The PR conversation (issue comments + review bodies, oldest first) and the composer —
          // its own tab now, beside Overview.
          <div className="pt-2">
            <PrCommentsList
              pr={pr}
              usersById={usersById}
              viewedSince={pr.lastViewedAt}
              focusKey={commentFocusForPr}
              selectedCommentId={selectedCommentId}
              onFocusConsumed={consumeCommentFocus}
            />
            <PrCommentComposer prId={pr.id} />
          </div>
        ) : effectiveTab === 'changes' ? (
          <ChangesTab
            pr={pr}
            focus={changesFocus}
            threadOpenMemory={threadOpenMemory}
            threadsOnly={changesThreadsOnly}
            onThreadsOnlyChange={setChangesThreadsOnly}
            keysEnabled={liveVisible}
            renderThreads={(visibleThreadIds) => (
              // THE THREADS ONLY VIEW — everything the old Changes tab's threads offered: the full bot
              // triage card, Check threads, the state / severity / vendor pills (guarded to this
              // PR above), reply and resolve on every card, Claude's judgements, and "Show in
              // context" back to the code.
              <>
                {/* P3.2: full triage card — threadSeverities / resolvableBotThreadIds are the
                    list's own folds. Its state counts are the DERIVED states (`rollupCounts`); the
                    list's state chips count what the cards show (`threadStateBucket`). */}
                <BotTriageCard pr={pr} usersById={usersById} variant="full" />
                {/* Check threads: Claude re-judges only the threads that changed (local, me.ai). */}
                {aiEnabled && pr.threads.length > 0 && (
                  <div className="px-3 pt-2">
                    <CheckThreadsButton prId={pr.id} />
                  </div>
                )}
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
                  visibleThreadIds={visibleThreadIds}
                />
              </>
            )}
          />
        ) : effectiveTab === 'bot_activity' ? (
          <PrBotBehaviourTab pr={pr} />
        ) : effectiveTab === 'ai_fix' ? (
          <AiFixTab pr={pr} />
        ) : (
          <ClaudeReviewTab
            pr={pr}
            usersById={usersById}
            onOpenInChanges={openInChanges}
            onOpenThread={showThread}
          />
        )}
        </Suspense>
      </div>
    </div>
    </PrFocusMetaContext.Provider>
  );
}
