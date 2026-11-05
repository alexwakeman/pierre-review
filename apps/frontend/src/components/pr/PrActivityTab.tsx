import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  hasAutoPostFooter,
  hasLimnReviewMarker,
  parseLimnReviewMarker,
  type EventType,
  type LimnSeverity,
  type PrDetail as PrDetailT,
  type ReviewDetail,
  type ReviewState,
  type User,
} from '@pierre-review/shared';
import { buildQuotedReply, dateTime, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { mlLabelKey, useMlLabelIndex, useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { Avatar } from '../CommentCard.js';
import { CopyButton } from '../CopyButton.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { MlSeverityBadge } from '../MlSeverityBadge.js';
import { LimnSeverityChip } from '../LimnSeverityChip.js';
import { ReactionBar } from '../ReactionBar.js';
import { PrCommentComposer } from '../PrCommentComposer.js';
import { isNewComment, NewTag } from '../ThreadView/index.js';
import { cx, FOCUS_RING } from '../ui/index.js';
import {
  CheckCircleIcon,
  ChevronIcon,
  CommentIcon,
  CommitIcon,
  ExternalLinkIcon,
  EyeIcon,
  MergeIcon,
  PullRequestClosedIcon,
  PullRequestIcon,
  ReopenIcon,
  RequestChangesIcon,
  ReviewIcon,
  SparkleIcon,
} from '../Icons.js';

/**
 * THE PR DETAIL'S ACTIVITY TAB — everything that happened on the pull request, NEWEST FIRST, on one
 * git-history rail: the conversation (PR comments and review bodies), reviews, commits and the
 * lifecycle (opened, ready for review, reopened, merged, closed). It replaced the Comments tab and
 * the old collapsed Activity section at the foot of Overview (docs/FRONTEND.md § PrDetail tabs).
 *
 * A comment or a review with a body is a CARD: a clamped Markdown preview (about six lines), and,
 * expanded, the full card — the same block the Comments tab drew (body, reactions, Reply, View on
 * GitHub). Reactions are mounted only on an expanded card, so a long PR fetches none until asked.
 * Nothing here fetches on its own except the one per-PR ML label index the Changes tab also reads.
 */

export type ActivityKind =
  | 'opened'
  | 'ready'
  | 'commit'
  | 'review'
  | 'comment'
  | 'reopened'
  | 'merged'
  | 'closed';

export interface ActivityEntry {
  /** `comment:<id>` / `review:<id>` (the comment-focus keys), `commit:<id>`, or the lifecycle kind. */
  key: string;
  kind: ActivityKind;
  at: string;
  /** Null where the event log does not know who did it (closed, reopened) — never guessed. */
  actorId: number | null;
  /** The timeline event this entry maps to — what an `activityFocus` deep link names. */
  event: { type: EventType; refId: number | null };
  body?: string | null;
  url?: string | null;
  reviewState?: ReviewState;
  sha?: string;
  commitMessage?: string | null;
  /** Posted by Limn (a review summary, or a PR-level finding). */
  limn?: boolean;
  /** The newest review Limn posted on its own (an auto review). */
  autoLatest?: boolean;
  limnSeverity?: LimnSeverity | null;
}

/** Whether a review is Limn's: the stored kind, else the summary marker on its body. */
export function isLimnReview(r: Pick<ReviewDetail, 'automatedKind' | 'body'>): boolean {
  return r.automatedKind === 'pierre' || hasLimnReviewMarker(r.body);
}

/** Whether a Limn review was posted automatically: the marker's run kind, else the footer (older posts). */
export function isLimnAutoReview(r: Pick<ReviewDetail, 'automatedKind' | 'body'>): boolean {
  if (!isLimnReview(r)) return false;
  const run = parseLimnReviewMarker(r.body)?.run ?? null;
  return run != null ? run === 'auto' : hasAutoPostFooter(r.body);
}

const hasBody = (b: string | null | undefined): b is string => b != null && b.trim() !== '';

/** Every Activity entry for a PR, newest first. Pure (tested). */
export function buildPrActivity(pr: PrDetailT): ActivityEntry[] {
  const rows: ActivityEntry[] = [];
  rows.push({
    key: 'opened',
    kind: 'opened',
    at: pr.openedAt,
    actorId: pr.authorId,
    event: { type: 'pr_opened', refId: null },
  });
  for (const e of pr.lifecycle ?? []) {
    rows.push({
      key: `${e.type}:${e.at}`,
      kind: e.type === 'pr_reopened' ? 'reopened' : 'ready',
      at: e.at,
      // The event log records the PR's author for these, which is right for "ready for review" and
      // a guess for a reopen; the reopen is shown without a name.
      actorId: e.type === 'pr_ready_for_review' ? e.actorId : null,
      event: { type: e.type, refId: null },
    });
  }
  for (const c of pr.commits) {
    rows.push({
      key: `commit:${c.id}`,
      kind: 'commit',
      at: c.committedAt,
      actorId: c.authorId ?? c.committerId,
      event: { type: 'commit_pushed', refId: c.id },
      sha: c.sha,
      commitMessage: c.message,
    });
  }
  // The newest auto review gets the "latest" mark.
  let autoLatestId: number | null = null;
  let autoLatestAt = '';
  for (const r of pr.reviews) {
    if (isLimnAutoReview(r) && r.submittedAt >= autoLatestAt) {
      autoLatestAt = r.submittedAt;
      autoLatestId = r.id;
    }
  }
  for (const r of pr.reviews) {
    rows.push({
      key: `review:${r.id}`,
      kind: 'review',
      at: r.submittedAt,
      actorId: r.authorId,
      event: { type: 'review_submitted', refId: r.id },
      body: hasBody(r.body) ? r.body : null,
      url: r.url,
      reviewState: r.state,
      limn: isLimnReview(r),
      autoLatest: r.id === autoLatestId,
    });
  }
  for (const c of pr.comments) {
    rows.push({
      key: `comment:${c.id}`,
      kind: 'comment',
      at: c.createdAt,
      actorId: c.authorId,
      event: { type: 'pr_comment', refId: c.id },
      body: c.body,
      url: c.url,
      limn: c.limnSeverity != null || hasLimnReviewMarker(c.body),
      limnSeverity: c.limnSeverity ?? null,
    });
  }
  if (pr.mergedAt) {
    rows.push({
      key: 'merged',
      kind: 'merged',
      at: pr.mergedAt,
      actorId: pr.mergedById,
      event: { type: 'pr_merged', refId: null },
    });
  } else if (pr.closedAt) {
    rows.push({
      key: 'closed',
      kind: 'closed',
      at: pr.closedAt,
      actorId: null,
      event: { type: 'pr_closed', refId: null },
    });
  }
  // Newest first; a stable tiebreak so a commit and its push-time review never swap on a poll.
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

/** The tab's badge: PR comments plus reviews that carried a body — the cards on the rail. */
export const prConversationCount = (pr: PrDetailT): number =>
  pr.comments.length + pr.reviews.filter((r) => hasBody(r.body)).length;

// The state pill beside a review author, so an approval-with-note reads differently from a plain
// review comment or a change request.
const REVIEW_TAG: Record<ReviewState, { label: string; cls: string }> = {
  approved: { label: 'approved', cls: 'bg-ui-raise text-ui-success' },
  changes_requested: { label: 'changes requested', cls: 'bg-ui-raise text-ui-warn' },
  commented: { label: 'review', cls: 'bg-ui-sel text-ui-accent' },
  dismissed: { label: 'dismissed', cls: 'bg-ui-raise text-ui-mute' },
  pending: { label: 'pending', cls: 'bg-ui-raise text-ui-mute' },
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

/** The rail's marker for one entry: an icon in a disc on the line. */
export function activityMarker(e: ActivityEntry): { icon: JSX.Element; tone: string; label: string } {
  const s = 14;
  if (e.limn && (e.kind === 'review' || e.kind === 'comment')) {
    return { icon: <SparkleIcon size={s} />, tone: 'text-ai-signal', label: 'Limn' };
  }
  switch (e.kind) {
    case 'opened':
      return { icon: <PullRequestIcon size={s} />, tone: 'text-ui-success', label: 'Opened' };
    case 'ready':
      return { icon: <EyeIcon size={s} />, tone: 'text-ui-mute', label: 'Ready for review' };
    case 'reopened':
      return { icon: <ReopenIcon size={s} />, tone: 'text-ui-success', label: 'Reopened' };
    case 'commit':
      return { icon: <CommitIcon size={s} />, tone: 'text-ui-mute', label: 'Commit' };
    case 'comment':
      return { icon: <CommentIcon size={s} />, tone: 'text-ui-mute', label: 'Comment' };
    case 'merged':
      return { icon: <MergeIcon size={s} />, tone: 'text-ui-accent', label: 'Merged' };
    case 'closed':
      return { icon: <PullRequestClosedIcon size={s} />, tone: 'text-ui-danger', label: 'Closed' };
    case 'review':
      return e.reviewState === 'approved'
        ? { icon: <CheckCircleIcon size={s} />, tone: 'text-ui-success', label: 'Approved' }
        : e.reviewState === 'changes_requested'
          ? { icon: <RequestChangesIcon size={s} />, tone: 'text-ui-warn', label: 'Changes requested' }
          : { icon: <ReviewIcon size={s} />, tone: 'text-ui-mute', label: 'Review' };
  }
}

/** The words after the name on a one-line entry. */
function entryVerb(e: ActivityEntry): string {
  switch (e.kind) {
    case 'opened':
      return 'opened this pull request';
    case 'ready':
      return e.actorId != null ? 'marked it ready for review' : 'Marked ready for review';
    case 'reopened':
      return 'Reopened';
    case 'commit':
      return 'pushed a commit';
    case 'comment':
      return 'commented';
    case 'merged':
      return e.actorId != null ? 'merged this pull request' : 'Merged';
    case 'closed':
      return 'Closed without merging';
    case 'review':
      return e.reviewState === 'approved'
        ? 'approved'
        : e.reviewState === 'changes_requested'
          ? 'requested changes'
          : e.reviewState === 'dismissed'
            ? 'reviewed (dismissed)'
            : 'reviewed';
  }
}

function LimnChips({ e }: { e: ActivityEntry }): JSX.Element | null {
  if (!e.limn) return null;
  const chip = 'shrink-0 rounded-ui bg-ai-signal/10 px-1.5 py-0.5 text-meta font-medium text-ai-signal';
  return (
    <>
      <span className={chip} data-testid="activity-limn-chip">
        Limn
      </span>
      {e.autoLatest && (
        <span className={chip} data-testid="activity-auto-latest">
          Auto review · latest
        </span>
      )}
    </>
  );
}

export function PrActivityTab({
  pr,
  usersById,
  since,
  onClearSince,
  focusEvent,
  onEventFocusConsumed,
  focusKey,
  onCommentFocusConsumed,
  selectedCommentId,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  /** "What's new": only entries after this instant (the header's "N new" chip). */
  since: string | null;
  onClearSince: () => void;
  /** A timeline deep link (e.g. the commit popover): scroll to + flash that entry, then consume. */
  focusEvent: { type: EventType; refId: number | null } | null;
  onEventFocusConsumed: () => void;
  /** A comment deep link, `comment:<id>` or `review:<id>`: expand, scroll to + flash, then consume. */
  focusKey: string | null;
  onCommentFocusConsumed: () => void;
  /** The selected PR comment keeps a permanent ring (mirrors a selected thread) and starts open. */
  selectedCommentId: number | null;
}): JSX.Element {
  const all = useMemo(() => buildPrActivity(pr), [pr]);
  const rows = since ? all.filter((r) => r.at > since) : all;
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    selectedCommentId != null ? new Set([`comment:${selectedCommentId}`]) : new Set(),
  );
  const expand = (key: string): void =>
    setExpanded((cur) => (cur.has(key) ? cur : new Set(cur).add(key)));
  const toggle = (key: string): void =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // A selected comment (the pr_comment popover, a Pending card) opens.
  useEffect(() => {
    if (selectedCommentId != null) expand(`comment:${selectedCommentId}`);
  }, [selectedCommentId]);

  const reveal = (key: string): void => {
    rowRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashKey(key);
  };

  useEffect(() => {
    if (!focusEvent) return;
    const row = all.find(
      (r) => r.event.type === focusEvent.type && r.event.refId === focusEvent.refId,
    );
    onEventFocusConsumed();
    if (!row) return;
    if (row.body != null) expand(row.key);
    reveal(row.key);
  }, [focusEvent, all, onEventFocusConsumed]);

  useEffect(() => {
    if (focusKey == null) return;
    onCommentFocusConsumed();
    if (!all.some((r) => r.key === focusKey)) return;
    expand(focusKey);
    reveal(focusKey);
  }, [focusKey, all, onCommentFocusConsumed]);

  // The flash fades on its own key, so consuming a focus cannot cancel the timer early.
  useEffect(() => {
    if (flashKey == null) return;
    const t = setTimeout(() => setFlashKey(null), 1800);
    return () => clearTimeout(t);
  }, [flashKey]);

  // The per-PR ML label index (one query, shared with the Changes tab). A PR comment and a review
  // body are SEPARATE id spaces, so the key carries the kind.
  const mlEnabled = useMlSeverityEnabled();
  const mlIndex = useMlLabelIndex(pr.id, mlEnabled);

  return (
    <div className="mx-auto max-w-4xl pb-4 pt-2" data-testid="pr-activity-tab">
      {/* The composer first: the newest entry sits right under it. */}
      <PrCommentComposer prId={pr.id} />
      {since && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-ui bg-ui-sel px-3 py-1 text-meta text-ui-accent md:mx-5">
          <span>Showing {rows.length} since you last looked</span>
          <button type="button" onClick={onClearSince} className="hit ml-auto text-ui-mute hover:text-ui-ink">
            Show all
          </button>
        </div>
      )}
      <ol className="relative px-3 md:px-5" data-testid="pr-activity-list">
        {/* THE RAIL: one continuous line behind every marker (git-history style). */}
        {rows.length > 1 && (
          <span
            aria-hidden
            className="absolute bottom-4 top-3 w-px bg-ui-line left-[calc(0.75rem+11.5px)] md:left-[calc(1.25rem+11.5px)]"
          />
        )}
        {rows.map((e) => {
          const user = e.actorId != null ? usersById.get(e.actorId) : undefined;
          const marker = activityMarker(e);
          const isCard = e.body != null;
          const open = isCard && expanded.has(e.key);
          return (
            <li
              key={e.key}
              ref={(el) => {
                if (el) rowRefs.current.set(e.key, el);
                else rowRefs.current.delete(e.key);
              }}
              className="relative flex gap-2.5 pb-3 scroll-mt-[var(--pr-tabs-h,0px)]"
              data-activity-kind={e.kind}
            >
              <span
                className={cx(
                  'relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ui-surface ring-1 ring-ui-line',
                  marker.tone,
                )}
                title={marker.label}
              >
                {marker.icon}
                <span className="sr-only">{marker.label}</span>
              </span>
              <div className="min-w-0 flex-1">
                {isCard ? (
                  <ConversationCard
                    pr={pr}
                    entry={e}
                    user={user}
                    usersById={usersById}
                    open={open}
                    onToggle={() => toggle(e.key)}
                    onExpand={() => expand(e.key)}
                    selected={e.kind === 'comment' && e.event.refId === selectedCommentId}
                    flashing={e.key === flashKey}
                    mlLabel={mlIndex?.get(
                      mlLabelKey(e.kind === 'comment' ? 'pr_comment' : 'review', e.event.refId ?? -1),
                    )}
                  />
                ) : (
                  <EntryLine pr={pr} entry={e} user={user} flashing={e.key === flashKey} />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EntryLine({
  pr,
  entry: e,
  user,
  flashing,
}: {
  pr: PrDetailT;
  entry: ActivityEntry;
  user: User | undefined;
  flashing: boolean;
}): JSX.Element {
  const firstLine = e.commitMessage?.split('\n')[0] ?? null;
  return (
    <div
      className={cx(
        'flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-ui py-0.5 text-meta',
        flashing && 'activity-flash',
      )}
    >
      {e.actorId != null && (
        <>
          <Avatar user={user} size={16} />
          <UserName user={user} fallbackId={e.actorId} repoId={pr.repoId} className="shrink-0 font-medium text-ui-ink" />
        </>
      )}
      <span className={e.actorId != null ? 'text-ui-mute' : 'font-medium text-ui-ink'}>{entryVerb(e)}</span>
      <LimnChips e={e} />
      {e.sha && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <code className="font-mono text-ui-mute">{e.sha.slice(0, 7)}</code>
          <CopyButton text={e.sha} what="commit hash" title="Copy commit hash" />
        </span>
      )}
      <span className="ml-auto shrink-0 tabular-nums text-ui-mute" title={dateTime(e.at)}>
        {relativeTime(e.at)}
      </span>
      {firstLine != null && firstLine !== '' && (
        <span className="w-full min-w-0 truncate text-body text-ui-ink" title={e.commitMessage ?? undefined}>
          {firstLine}
        </span>
      )}
    </div>
  );
}

/**
 * A PR comment or a review body. Collapsed: the header and a clamped Markdown preview. Expanded:
 * the full card the Comments tab drew — the whole body, reactions, Reply, View on GitHub.
 */
function ConversationCard({
  pr,
  entry: e,
  user,
  usersById,
  open,
  onToggle,
  onExpand,
  selected,
  flashing,
  mlLabel,
}: {
  pr: PrDetailT;
  entry: ActivityEntry;
  user: User | undefined;
  usersById: Map<number, User>;
  open: boolean;
  onToggle: () => void;
  onExpand: () => void;
  selected: boolean;
  flashing: boolean;
  mlLabel: Parameters<typeof MlSeverityBadge>[0]['label'];
}): JSX.Element {
  const body = e.body ?? '';
  const isComment = e.kind === 'comment';
  const id = e.event.refId ?? -1;
  const isNew = isNewComment(e.at, pr.lastViewedAt);
  const [replying, setReplying] = useState(false);
  // Whether the clamped preview hides anything (images load late, so it is re-measured).
  const previewRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (open || el == null) return;
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [open, body]);
  const href = e.url != null ? safeExternalUrl(e.url) : null;
  // A click on the preview opens the card, unless it was on a link or a control inside it.
  const onPreviewClick = (ev: MouseEvent<HTMLDivElement>): void => {
    if ((ev.target as HTMLElement).closest('a,button,summary,input,textarea')) return;
    onExpand();
  };
  return (
    <div
      className={cx(
        'rounded-ui bg-ui-surface px-3 py-2',
        selected && 'ring-1 ring-ui-warn/40',
        isNew && 'comment-new',
        flashing && 'activity-flash',
      )}
      data-testid="activity-card"
      data-open={open ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ui-mute">
        <Avatar user={user} size={18} />
        <UserName user={user} fallbackId={e.actorId} repoId={pr.repoId} className="font-medium text-ui-ink" />
        {e.kind === 'review' && e.reviewState != null ? (
          <ReviewStateTag state={e.reviewState} />
        ) : (
          <span>commented</span>
        )}
        <LimnChips e={e} />
        <span className="whitespace-nowrap text-ui-faint" title={dateTime(e.at)}>
          {relativeTime(e.at)}
        </span>
        {isNew && <NewTag />}
        <LimnSeverityChip severity={e.limnSeverity} />
        <MlSeverityBadge label={mlLabel} />
        <span className="ml-auto flex items-center gap-1">
          <CopyButton text={body} what={isComment ? 'comment' : 'review'} />
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? 'Show less' : 'Show all'}
            title={open ? 'Show less' : 'Show all'}
            className={cx('hit inline-flex h-6 w-6 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10', FOCUS_RING)}
          >
            <ChevronIcon dir={open ? 'up' : 'down'} size={12} />
          </button>
        </span>
      </div>
      {open ? (
        <>
          <div className="mt-1.5 text-body">
            <Markdown>{body}</Markdown>
          </div>
          {/* Reactions only on an open card: a long PR fetches none until a card is opened. */}
          <ReactionBar kind={isComment ? 'pr_comment' : 'review'} id={id} className="mt-1.5 pl-2" />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta">
            {!replying && (
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="text-ui-ink hover:underline touch:min-h-10"
              >
                Reply
              </button>
            )}
            {href != null && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-ui-ink hover:underline text-link-phone touch:min-h-10"
              >
                <ExternalLinkIcon size={11} />
                View on GitHub
              </a>
            )}
          </div>
          {replying && (
            <div className="-mx-3 mt-2">
              <PrCommentComposer
                prId={pr.id}
                initialBody={buildQuotedReply(body, usersById.get(e.actorId ?? -1)?.githubLogin ?? null)}
                autoFocus
                onCancel={() => setReplying(false)}
                onDone={() => setReplying(false)}
              />
            </div>
          )}
        </>
      ) : (
        <div
          ref={previewRef}
          onClick={onPreviewClick}
          className="relative mt-1.5 max-h-[7.5rem] cursor-pointer overflow-hidden text-body"
          data-testid="activity-preview"
        >
          <Markdown>{body}</Markdown>
          {overflows && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-ui-surface to-transparent"
            />
          )}
        </div>
      )}
    </div>
  );
}
