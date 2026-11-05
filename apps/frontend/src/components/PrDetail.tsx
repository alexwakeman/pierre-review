import { PrStoryTab } from './pr/PrStoryTab.js';
import { PrOverviewAiReview } from './pr/PrOverviewAiReview.js';
import { ReviewDecisionPill, reviewDecisionFace } from './pr/ReviewDecisionPill.js';
import { PrActivityTab, prConversationCount } from './pr/PrActivityTab.js';
import { PrThreadsTab } from './pr/PrThreadsTab.js';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateSeenState } from '../hooks/useMarkRepoSeen.js';
import type {
  PrDetail as PrDetailT,
  PrFilesResponse,
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
import { useRepos } from '../hooks/useTimeline.js';
import { usePrBotBehaviour } from '../hooks/useBotTriage.js';
import { api } from '../api/client.js';
import { useFilters, type PrDetailTab } from '../store/filters.js';
import { markUrlCorrection } from '../hooks/useUrlState.js';
import { parseTabKey, usePinnedTabs, type PinnedPr } from '../store/pinnedTabs.js';
import {
  dateTime,
  indexUsers,
  PR_STATE_META,
  prHeaderCi,
  relativeTime,
  safeExternalUrl,
} from '../lib/ui.js';
import { CiDot } from './Activity/BranchStatusChip.js';
import { Avatar } from './CommentCard.js';
import { writeClipboard } from './CopyButton.js';
import {
  cx,
  FOCUS_RING,
  IconButton,
  Menu,
  panelId,
  PAGE_GUTTER,
  PAGE_HEADER_TOP,
  StatusIcon,
  tabId,
  Tabs,
  useRegisterCommands,
  type Command,
  type MenuEntry,
  type TabItem,
} from './ui/index.js';
import { UserName } from './UserName.js';
import { PrFocusMetaContext } from './ShowOnTimeline.js';
import { useOpenStory } from '../lib/ticketTab.js';
import {
  rememberedPrScroll,
  rememberedPrTab,
  rememberPrScroll,
  rememberPrTab,
  restorePaneScroll,
} from '../lib/prViewMemory.js';
import {
  ActivityIcon,
  BotIcon,
  ChevronIcon,
  DiffIcon,
  DotIcon,
  EllipsisIcon,
  EyeIcon,
  FeedIcon,
  MagnifierIcon,
  MergeIcon,
  NewTabIcon,
  PendingStalledIcon,
  PullRequestIcon,
  LinkIcon,
  OctocatIcon,
  OverviewIcon,
  RefreshIcon,
  SparkleIcon,
  ThreadsIcon,
  TicketIcon,
  TimelineIcon,
  TimerIcon,
  WarningIcon,
  WrenchIcon,
} from './Icons.js';
import { BotTriageCard } from './BotTriageCard.js';
import { LargePrFlag } from './Activity/LargePrFlag.js';
import { PrChips } from './Activity/PrChips.js';
import { BlastRadiusChip } from './Activity/BlastRadiusChip.js';
import { ChecksTab } from './ChecksTab.js';
import type { MlSeverity } from '@pierre-review/shared';
import { ChangesTab } from './ChangesTab.js';
import { anchorLineFromHunk } from '../lib/diff.js';
import type { DiffFocusTarget } from './diff/FileDiffView.js';
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
  activity: 'Activity',
  threads: 'Threads',
  changes: 'Changes',
  bot_activity: 'Bot activity',
  claude_review: 'AI Review',
  ai_fix: 'AI Fix',
  // The PR's linked story (the story view, inside the PR) — listed only while it names one.
  story: 'Ticket',
};

// Every tab carries an icon, so the strip reads as a row of buttons (a new reader took the bare
// words for a heading). The two agentic tabs draw theirs in the AI signal colour, as every other AI
// surface does. 14 is the call-site size (it renders at ICON_SCALE). The AI Review label carries NO
// verdict pill: the verdict lives on the tab's own page and the Overview card (2026-11-03).
const TAB_ICONS: Record<Tab, JSX.Element> = {
  overview: <OverviewIcon size={14} />,
  activity: <ActivityIcon size={14} />,
  threads: <ThreadsIcon size={14} />,
  changes: <DiffIcon size={14} />,
  bot_activity: <BotIcon size={14} />,
  claude_review: <SparkleIcon size={14} className="text-ai-signal" />,
  ai_fix: <WrenchIcon size={14} className="text-ai-signal" />,
  story: <TicketIcon size={14} />,
};

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
      <div className="flex gap-1.5 px-4 pb-2 pt-2.5 md:px-5">
        {[26, 26, 24, 22].map((w, i) => (
          <SkeletonLine key={i} className="h-8 rounded-ui" style={{ width: `${w * 4}px` }} />
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
  // Keeps the PR's ['claude-review', prId] read alive (and polling while a run is in flight) for
  // the Overview's AI review card, which reads that cache and fetches nothing itself.
  useClaudeReviewTabPill(prId, claudeReviewEnabled);
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
  // The scroll restore started when this PR's pane ARRIVED (below, `lib/prViewMemory.ts`). Any
  // move the reader or a deep link makes cancels it, so it never fights a reveal.
  const restoreCancelRef = useRef<(() => void) | null>(null);
  const cancelScrollRestore = (): void => {
    restoreCancelRef.current?.();
    restoreCancelRef.current = null;
  };
  const goToTab = useCallback(
    (t: Tab): void => {
      cancelScrollRestore();
      setChangesFocus(null);
      setPrDetailTab(prId, t);
    },
    [prId, setPrDetailTab],
  );
  /**
   * THE SAME MOVE, MADE BY THE APP RATHER THAN THE READER — used by every deep-link effect below
   * (a Bots chip forces the Threads tab, a review banner forces Claude Review, …).
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
    // no clearing sits between the two. It is also the Threads tab's "Show in context".
    cancelScrollRestore();
    setPrDetailTab(prId, 'changes');
    setChangesFocus({ path, line, side, threadId: threadId ?? null, nonce: Date.now() });
  };
  /** The Threads tab — where every "see the threads" link lands. */
  const openThreadsView = useCallback((): void => {
    goToTab('threads');
  }, [goToTab]);
  /** The same, made by a deep-link effect rather than the reader: a URL correction. */
  const seedThreadsView = useCallback((): void => {
    markUrlCorrection();
    openThreadsView();
  }, [openThreadsView]);
  // The Activity tab's "what's new" filter (the header's "N new" chip). Cleared by a deep link to
  // one entry, so the target is never filtered out.
  const [activitySince, setActivitySince] = useState<string | null>(null);
  // PHONE HEADER (below md): the size/reach readings fold behind "Details"
  // (local, ephemeral — every fact stays one tap away), and the tab strip sticks to the top of
  // the one scroller as the header scrolls away. Its height is measured into `--pr-tabs-measured`;
  // the root maps it to `--pr-tabs-h` below md ONLY, so the Changes tab's own sticky bar pins
  // under the strip on a phone and at 0 everywhere else (desktop unchanged).
  const [headerDetailsOpen, setHeaderDetailsOpen] = useState(false);
  const [tabsH, setTabsH] = useState(0);
  const tabsObserver = useRef<ResizeObserver | null>(null);
  const tabsBarRef = useCallback((el: HTMLDivElement | null) => {
    tabsObserver.current?.disconnect();
    tabsObserver.current = null;
    if (el == null) return;
    const measure = (): void => setTabsH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    tabsObserver.current = ro;
  }, []);
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
   * Threads tab instead, with the thread selected so the list scrolls to it. A thread this pane
   * does not hold (a stale link) lands on the Threads tab too, never on nothing.
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
    cancelScrollRestore();
    // `selectThread` also clears the state/severity pill presets that could filter it out.
    useFilters.getState().selectThread(prId, threadId);
    setPrDetailTab(prId, 'threads');
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

  // Clicking a review-bot chip in Overview (ChecksTab) sets threadBotFilter → the Threads tab, which
  // then shows only that vendor's threads.
  const threadBotFilter = useFilters((s) => s.threadBotFilter);
  useEffect(() => {
    if (threadBotFilter != null) seedThreadsView();
  }, [threadBotFilter, seedThreadsView]);

  // The Open PRs drawer's threads link: land on the Threads tab, every thread shown. A
  // request for ANOTHER PR is left for that PR's pane; this one is consumed once.
  const threadsViewRequest = useFilters((s) => s.threadsViewRequest);
  useEffect(() => {
    if (threadsViewRequest !== prId) return;
    useFilters.getState().clearThreadsViewRequest();
    seedThreadsView();
  }, [threadsViewRequest, prId, seedThreadsView]);

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
    if (threadStateFilter.size > 0) seedThreadsView();
  }, [threadStateFilter, seedThreadsView]);

  // A timeline deep link to an Activity entry (e.g. the commit popover) seats the Activity tab and
  // clears the "since" filter so the target is visible; the list then scrolls to + flashes it.
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
      // on the thread in the Threads tab instead.
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
    // Keyed on `prId`, not the loaded `pr`: the tab is seated on the first render, so the AI Fix
    // tab draws the moment the PR arrives instead of one effect later.
    if (aiFixTabEnabled && aiFixTabFocus && aiFixTabFocus.prId === prId) {
      seedTab('ai_fix');
    }
  }, [aiFixTabFocus, prId, aiFixTabEnabled, seedTab]);

  // A deep link to a PR comment or review body (the pr_comment popover's "Open in detail pane", a
  // Pending mention) seats the Activity tab, which opens that card, scrolls to + flashes it, and
  // consumes the signal (not here) once it has.
  useEffect(() => {
    if (commentFocusForPr != null) {
      seedTab('activity');
      setActivitySince(null);
    }
  }, [commentFocusForPr, seedTab]);

  // Capture the last-viewed instant before marking (so new comments highlight
  // on this visit), then mark the PR viewed and refresh the list views' badges.
  // We deliberately do NOT invalidate this PR's own query.
  const markViewed = useMutation({
    mutationFn: (id: number) => api.markPrViewed(id),
    // Every read of the seen stamp — the Pending board's `your_pr` cards and their counts, and the
    // sidebar's blue dot — moves together (hooks/useMarkRepoSeen.ts).
    onSuccess: () => invalidateSeenState(qc),
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
  // The PR's linked stories: its tickets Limn can open as a story (an `ident`; one whose tracker site
  // cannot be folded only links out, from the Overview chip). Most PRs name one. The Story tab shows
  // them in place; the full story view opens ONLY through `useOpenStory`.
  const openStory = useOpenStory();
  // (`pr.tickets` keeps its identity across polls — React Query's structural sharing — so this memo
  // and the ⌘K list below rebuild only when the tickets themselves change.)
  const prTickets = pr?.tickets;
  const storyTickets = useMemo(
    () => (prTickets ?? []).flatMap((t) => (t.ident != null ? [{ ident: t.ident, key: t.key }] : [])),
    [prTickets],
  );
  const storyTabVisible = storyTickets.length > 0;
  // EVERY STORY IS ITS OWN TAB ("Story BMD-1182", "Story BMD-1190"), all at the end of the strip. The
  // store and the URL hold one tab id, `story`; which story it shows is local (the first by default),
  // so a reload or a shared link opens the first.
  const [storyIndex, setStoryIndex] = useState(0);
  const currentStory = storyTickets[storyIndex] ?? storyTickets[0] ?? null;
  const botTabResolved = pr != null && (!hasBots || prBotBehaviour !== undefined);
  const effectiveTab: Tab =
    tab === 'bot_activity' && botTabResolved && !botTabVisible
      ? 'overview'
      : // A PR naming no story (a stale `?prTab=story`): Overview, derived — never written back.
        tab === 'story' && pr != null && !storyTabVisible
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

  /**
   * REOPENING A PR LANDS WHERE THE READER LEFT IT (`lib/prViewMemory.ts`, this session only): the
   * last tab and that tab's scroll position. Read ONCE
   * per ARRIVAL — this copy becoming the one on screen (a mount, or the pane coming back out from
   * under another PR's overlay) — never on a tab switch inside the PR.
   *
   * ⚠ A MEMORY, NEVER AN INSTRUCTION. Anything that asked for a place wins: a `{prId, tab}` pair
   * already naming THIS PR (an explicit `?prTab=`, a Pending card's tab) keeps its tab, and a
   * thread / comment / activity / review / fix / changes deep link skips the restore entirely (its
   * own effect below seats the tab and its reveal does the scrolling). The tab is seated through
   * `seedTab` (a URL correction, never a history entry of its own).
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!liveVisible) return;
    const s = useFilters.getState();
    const deepLink =
      selectedThreadId != null ||
      s.activityFocus?.prId === prId ||
      s.commentFocus?.prId === prId ||
      s.claudeTabFocus?.prId === prId ||
      s.aiFixTabFocus?.prId === prId ||
      s.prChangesFocus?.prId === prId ||
      s.threadsViewRequest === prId ||
      s.threadBotFilter != null ||
      (s.selectedPrId === prId && (s.threadStateFilter.size > 0 || s.threadSeverityFilter.size > 0));
    if (deepLink) return;
    const pairIsOurs = s.prDetailTab?.prId === prId;
    const target = pairIsOurs ? (s.prDetailTab?.tab ?? null) : rememberedPrTab(prId);
    if (target == null) return;
    const top = rememberedPrScroll(prId, target);
    if (!pairIsOurs && target !== 'overview') seedTab(target);
    if (top != null && top > 0) {
      cancelScrollRestore();
      restoreCancelRef.current = restorePaneScroll(() => panelRef.current, top);
    }
    // Leaving the screen (or unmounting) stops a restore still holding the pane.
    return cancelScrollRestore;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arrival (`liveVisible` turning true); the rest is read live
  }, [liveVisible, prId]);
  // What to remember: the tab whenever the pair names this PR.
  useEffect(() => {
    if (prDetailTab?.prId === prId) rememberPrTab(prId, prDetailTab.tab);
  }, [prDetailTab, prId]);
  // The pane's scroll is remembered as the reader scrolls (`onScroll` on the tab panel) and when
  // the tab changes: the tabs share ONE scroller that is never reset, so a switch can leave a tab
  // at a position no scroll event reported. Not on the mount (nothing has moved yet).
  const tabScrollSeen = useRef(false);
  useEffect(() => {
    if (!tabScrollSeen.current) {
      tabScrollSeen.current = true;
      return;
    }
    const pane = panelRef.current;
    if (pane != null && liveVisible) rememberPrScroll(prId, effectiveTab, pane.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a tab change only
  }, [effectiveTab]);
  // "Copy the GitHub link" from the … menu: a short "Link copied" note beside the menu (the menu
  // closes on select, so the note is the only confirmation). Cleared on a timer.
  const [linkCopied, setLinkCopied] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (linkCopied == null) return;
    const t = window.setTimeout(() => setLinkCopied(null), 1600);
    return () => window.clearTimeout(t);
  }, [linkCopied]);

  // This account's live auto-merge intent — drives the header's "Auto-merge armed" chip. A
  // selector over the polled armed list (no new request); MUST sit above the early returns
  // (hooks-order rule). Only `state === 'armed'` counts — the list carries resolved rows too.
  const armedIntent = usePrArmedIntent(prId);

  // ⌘K: this PR's tabs and toolbar, registered only while THIS copy is the one on screen (the pane
  // can stay mounted under another PR's overlay). The handlers are read through a ref so the list
  // is rebuilt only when what it SAYS changes, never on every render.
  const cmdLive = useRef<{ tab: (t: Tab, story?: number) => void; act: (id: string) => void }>({ tab: () => {}, act: () => {} });
  const cmdTabs = [
    'overview',
    'activity',
    'threads',
    'changes',
    ...(botTabVisible ? (['bot_activity'] as Tab[]) : []),
    ...(claudeReviewEnabled ? (['claude_review'] as Tab[]) : []),
    ...(aiFixTabEnabled ? (['ai_fix'] as Tab[]) : []),
    ...(storyTabVisible ? (['story'] as Tab[]) : []),
  ] as Tab[];
  const cmdTabsKey = cmdTabs.join(',');
  const prNumber = pr?.number ?? null;
  const prCommands = useMemo((): Command[] | null => {
    if (!liveVisible || prNumber == null) return null;
    const where = `#${prNumber}`;
    const tabs = cmdTabsKey.split(',') as Tab[];
    return [
      ...tabs
        .flatMap((t): { t: Tab; story: number | null }[] =>
          t === 'story' ? storyTickets.map((_, k) => ({ t, story: k })) : [{ t, story: null }],
        )
        .map(
          ({ t, story }, i): Command => ({
            id: story != null ? `pr-tab:story:${story}` : `pr-tab:${t}`,
            title: `${story != null ? `Ticket ${storyTickets[story]?.key ?? ''}` : TAB_LABELS[t]} (this pull request)`,
            group: 'Go to',
            hint: where,
            shortcut: i < 9 ? String(i + 1) : undefined,
            keywords: ['tab', 'pr', 'pull request'],
            run: () => cmdLive.current.tab(t, story ?? undefined),
          }),
        ),
      ...(placement === 'pane'
        ? [{ id: 'pr:full', title: 'Open this pull request full-screen', group: 'Actions' as const, hint: where, run: () => cmdLive.current.act('full') }]
        : []),
      { id: 'pr:timeline', title: 'Show this pull request on the timeline', group: 'Actions', hint: where, run: () => cmdLive.current.act('timeline') },
      { id: 'pr:focus', title: 'Focus this pull request in its own timeline tab', group: 'Actions', hint: where, run: () => cmdLive.current.act('focus') },
      { id: 'pr:feed', title: 'Show this pull request in the Activity feed', group: 'Actions', hint: where, run: () => cmdLive.current.act('feed') },
      ...storyTickets.map(
        (t): Command => ({
          id: `pr:story:${t.ident}`,
          title: `Open the ${t.key} ticket`,
          group: 'Actions',
          hint: where,
          keywords: ['story', 'ticket'],
          icon: <TicketIcon size={14} />,
          run: () => openStory({ ident: t.ident, key: t.key, title: null }),
        }),
      ),
      { id: 'pr:refresh', title: 'Refresh this pull request from GitHub', group: 'Actions', hint: where, run: () => cmdLive.current.act('refresh') },
      { id: 'pr:copy', title: 'Copy the GitHub link to this pull request', group: 'Actions', hint: where, run: () => cmdLive.current.act('copy') },
      { id: 'pr:github', title: 'Open this pull request on GitHub', group: 'Actions', hint: where, run: () => cmdLive.current.act('github') },
      { id: 'pr:ci', title: 'Show CI status (Overview)', group: 'Actions', hint: where, run: () => cmdLive.current.act('ci') },
    ];
  }, [liveVisible, prNumber, cmdTabsKey, placement, storyTickets, openStory]);
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
  // Something to fold behind the phone header's "Details": the size, the large-PR flag or reach.
  const hasHeaderDetails =
    pr.changedFilesCount > 0 ||
    blastFields.blast != null ||
    codeLocFields.codeLoc != null ||
    pr.branchStack != null ||
    (pr.criteria?.length ?? 0) > 0;
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  const conversationCount = prConversationCount(pr);
  const unresolvedThreads = pr.threads.filter((t) => !t.isResolved).length;

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
    // The Activity tab, filtered to what's new.
    goToTab('activity');
    setActivitySince(pr.lastViewedAt);
  };
  const githubHref = safeExternalUrl(pr.githubUrl);
  const copyLink = (href: string): void => {
    void writeClipboard(href).then((ok) => setLinkCopied(ok ? 'copied' : 'failed'));
  };
  const newSince = newSummary(pr.newSinceLastViewed);
  // The header's third line renders only when it has something on it.
  const headerLine3 =
    reviewDecisionFace(pr) != null ||
    hasHeaderDetails ||
    pr.isStalled ||
    (armedIntent != null && pr.state === 'open') ||
    newSince != null;
  cmdLive.current = {
    tab: (t, story) => {
      if (story != null) setStoryIndex(story);
      goToTab(t);
    },
    act: (id) => {
      if (id === 'full') openPrDetailTab(pinnedMetaOf(pr, usersById));
      else if (id === 'timeline') openPrFocused(pr.id);
      else if (id === 'focus') openPrFocusTab(pinnedMetaOf(pr, usersById));
      else if (id === 'feed') showInFeed();
      else if (id === 'refresh') refreshNow();
      else if (id === 'copy' && githubHref != null) copyLink(githubHref);
      else if (id === 'github' && githubHref != null) window.open(githubHref, '_blank', 'noopener,noreferrer');
      else if (id === 'ci') showCiStatus();
    },
  };
  const failingChecks = pr.checkRuns.filter(
    (c) => !c.limnOwned && (c.state === 'failure' || c.state === 'error'),
  ).length;
  const stateLabel = pr.isDraft ? 'Draft' : stateMeta.label;
  const tabIds: Tab[] = [
    'overview',
    'activity',
    'threads',
    'changes',
    // Also listed while the bot data is still in flight for a reader who ARRIVED on this
    // tab (a deep link / a refresh), so the strip is never showing a screen with no
    // highlighted tab. It disappears again if the answer comes back empty, and
    // `effectiveTab` moves to Overview with it.
    ...(botTabVisible || effectiveTab === 'bot_activity' ? (['bot_activity'] as Tab[]) : []),
    ...(claudeReviewEnabled ? (['claude_review'] as Tab[]) : []),
    ...(aiFixTabEnabled ? (['ai_fix'] as Tab[]) : []),
    // Last, so the 1–9 keys of the tabs before it never move.
    ...(storyTabVisible ? (['story'] as Tab[]) : []),
  ];
  // One strip entry per story (`story:<index>`); every other tab is its own id.
  type StripId = Exclude<Tab, 'story'> | `story:${number}`;
  const stripValue: StripId = effectiveTab === 'story' ? `story:${currentStory != null ? storyTickets.indexOf(currentStory) : 0}` : effectiveTab;
  const onStripChange = (id: StripId): void => {
    if (id.startsWith('story:')) {
      setStoryIndex(Number(id.slice('story:'.length)));
      goToTab('story');
    } else goToTab(id as Tab);
  };
  const storyItems: TabItem<StripId>[] = storyTickets.map((st, k) => ({
    id: `story:${k}`,
    label: `Ticket ${st.key}`,
    title: `${st.key}: the ticket and its pull requests`,
    icon: TAB_ICONS.story,
  }));
  const tabItems: TabItem<StripId>[] = tabIds.flatMap((t): TabItem<StripId>[] => t === 'story' ? storyItems : [{
    id: t,
    icon: TAB_ICONS[t],
    label: (
      <>
        {TAB_LABELS[t]}
        {t === 'overview' && failingChecks > 0 && (
          <span className="ml-1 inline-flex text-ui-danger" title={`${failingChecks} failing`}>
            <DotIcon size={7} aria-hidden />
            <span className="sr-only">, {failingChecks} failing</span>
          </span>
        )}
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
      t === 'activity'
        ? conversationCount > 0
          ? conversationCount
          : null
        : t === 'threads'
          ? unresolvedThreads > 0
            ? unresolvedThreads
            : null
          : t === 'changes' && pr.changedFilesCount > 0
            ? pr.changedFilesCount
            : null,
    title:
      t === 'activity' && conversationCount > 0
        ? `${conversationCount} comments and reviews`
        : t === 'threads' && unresolvedThreads > 0
          ? `${unresolvedThreads} unresolved of ${pr.threads.length} threads`
          : t === 'changes' && pr.changedFilesCount > 0
            ? `${pr.changedFilesCount} files changed`
            : undefined,
  }]);
  // Everything the toolbar does, in words — the overflow menu (every width) and, below md, the
  // only way to the actions the icon row hides. Nothing here is unique to the menu.
  const menuItems: MenuEntry[] = [
    ...(placement === 'pane'
      ? [{ id: 'full', label: 'Open full-screen in its own tab', icon: <NewTabIcon size={14} />, onSelect: () => openPrDetailTab(pinnedMetaOf(pr, usersById)) }]
      : []),
    { id: 'timeline', label: 'Show on the timeline', icon: <TimelineIcon size={14} />, onSelect: () => openPrFocused(pr.id) },
    { id: 'focus', label: 'Focus in its own timeline tab', icon: <MagnifierIcon size={14} />, onSelect: () => openPrFocusTab(pinnedMetaOf(pr, usersById)) },
    { id: 'feed', label: 'Show in the Activity feed', icon: <FeedIcon size={14} />, onSelect: showInFeed },
    // Only when the PR names a story; its key as the hint (a PR naming two lists both).
    ...storyTickets.map((t): MenuEntry => ({
      id: `story:${t.ident}`,
      label: 'Open ticket',
      hint: t.key,
      icon: <TicketIcon size={14} />,
      onSelect: () => openStory({ ident: t.ident, key: t.key, title: null }),
    })),
    { id: 'sep', separator: true },
    {
      id: 'refresh',
      label: isRefreshing ? 'Refreshing…' : 'Refresh from GitHub',
      hint: isStale && !isRefreshing ? 'Last try failed' : undefined,
      icon: <RefreshIcon size={14} />,
      disabled: isRefreshing,
      onSelect: refreshNow,
    },
    ...(githubHref != null
      ? [
          { id: 'copy', label: 'Copy the GitHub link', icon: <LinkIcon size={14} />, onSelect: () => copyLink(githubHref) },
          { id: 'gh', label: 'Open on GitHub', icon: <OctocatIcon size={14} />, onSelect: () => window.open(githubHref, '_blank', 'noopener,noreferrer') },
        ]
      : []),
  ];

  return (
    <PrFocusMetaContext.Provider value={pinnedMetaOf(pr, usersById)}>
    <div
      className="flex h-full flex-col bg-ui-bg max-md:overflow-y-auto max-md:overflow-x-clip max-md:[--pr-tabs-h:var(--pr-tabs-measured)]"
      style={{ '--pr-tabs-measured': `${tabsH}px` } as CSSProperties}
    >
      {/* THE ONE SLIM HEADER: title + toolbar, then the meta line (state, CI, repo, author, age),
          then the review line (GitHub's review decision, size, reach, flags), then the tabs. pr-12 leaves room for DetailPane's close ✕ in the pane; the
          full-screen tab has none. */}
      <header
        className={cx(
          'shrink-0',
          // Full-screen: a page — the same top and gutter as every PageHeader (components/ui/PageHeader.tsx),
          // so its title sits where every page title sits (e2e/header-geometry.spec.ts).
          placement === 'fullscreen' ? cx(PAGE_HEADER_TOP, PAGE_GUTTER) : 'px-4 pt-3 md:px-5',
          placement === 'pane' && 'pr-12 md:pr-12',
        )}
      >
        <div className="flex items-start gap-2">
          {/* In the PANE, the title opens this PR full-screen as its own (focused) tab (the …
              menu says the same in words). Opening a tab IS pinning it, so there's no separate pin
              control. FULL-SCREEN already is that tab: the title is a plain heading. */}
          {placement === 'pane' ? (
              <button
                type="button"
                onClick={() => openPrDetailTab(pinnedMetaOf(pr, usersById))}
                className={cx('hit min-w-0 truncate rounded-ui text-left text-title text-ui-ink hover:underline', FOCUS_RING)}
                title="Open full-screen in its own tab"
              >
                <span className="font-normal text-ui-faint">#{pr.number}</span> {pr.title}
              </button>
          ) : (
            <h2 data-page-title className="min-w-0 text-display text-ui-ink [overflow-wrap:anywhere] md:truncate" title={pr.title}>
              <span className="font-normal text-ui-faint">#{pr.number}</span> {pr.title}
            </h2>
          )}
          {/* THE ONE ACTION CONTROL — the "…" menu says every PR action in words (and ⌘K lists
              the same set, registered above). No icon row: the menu is the toolbar. */}
          <div className="ml-auto flex shrink-0 items-center gap-1" role="toolbar" aria-label="This pull request">
            {/* The two states the old icon row showed, in words: a failed re-read of GitHub (a
                stale note, never an error — the shown data is valid; click retries) and the
                copy confirmation. Nothing renders in the normal case. */}
            {isStale && (
              <button
                type="button"
                onClick={refreshNow}
                disabled={isRefreshing}
                className={cx('hit inline-flex h-8 items-center gap-1 rounded-ui px-1.5 text-meta text-ui-warn hover:bg-ui-hover disabled:opacity-60', FOCUS_RING)}
                title="Couldn't refresh from GitHub — showing the last synced state. Click to retry."
              >
                <RefreshIcon size={12} className={isRefreshing ? 'motion-safe:animate-spin' : undefined} aria-hidden />
                Not refreshed
              </button>
            )}
            <span role="status" className="text-meta text-ui-mute empty:hidden">
              {linkCopied === 'copied' ? 'Link copied' : linkCopied === 'failed' ? "Couldn't copy" : ''}
            </span>
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
        {/* THE META LINE: state and CI, then the REPO, then the author and age.
            13px body ink in the mute tone (both themes clear AA). */}
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-ui-mute"
          data-testid="pr-header-meta"
        >
          {/* The state as a NEUTRAL pill — one look for open and merged (colour only by rule,
              ui/StatusIcon.tsx), ink words; a draft or closed PR keeps the faint words. */}
          <span className="inline-flex shrink-0 items-center rounded-ui bg-ui-raise px-1.5 py-0.5" data-testid="pr-header-state">
            <StatusIcon
              tone={pr.state === 'open' && !pr.isDraft ? 'neutral' : 'quiet'}
              icon={pr.state === 'merged' ? <MergeIcon size={14} /> : <PullRequestIcon size={14} />}
              label={stateLabel}
              className={cx('font-medium', !pr.isDraft && pr.state !== 'closed' && 'text-ui-ink')}
            />
          </span>
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
                  headerCi.status === 'unknown' ? '' : 'ring-1 ring-black/15'
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
        </div>
        {/* THE THIRD LINE: GitHub's review decision first (ReviewDecisionPill — GitHub's claim and
            our reviewer fold drawn apart), then size, reach, chips and the state flags. Nothing
            renders when it would be empty. */}
        {headerLine3 && (
        <div
          className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-ui-mute"
          data-testid="pr-header-review-line"
        >
          <ReviewDecisionPill pr={pr} usersById={usersById} />
          {/* PHONE ONLY: the size and reach readings fold
              behind this toggle; it and the folded group sort LAST so the line's other facts keep
              their place. md+ never sees it — there the group is `contents`, exactly as before. */}
          {hasHeaderDetails && (
            <button
              type="button"
              onClick={() => setHeaderDetailsOpen((o) => !o)}
              aria-expanded={headerDetailsOpen}
              aria-controls={`pr-${pr.id}-header-details`}
              className={cx(
                'inline-flex shrink-0 items-center gap-1 rounded-ui px-1 text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:min-h-10 max-md:order-last md:hidden',
                FOCUS_RING,
              )}
            >
              Details
              <ChevronIcon dir={headerDetailsOpen ? 'up' : 'down'} size={12} aria-hidden />
            </button>
          )}
          <span
            id={`pr-${pr.id}-header-details`}
            className={cx(
              'md:contents max-md:order-last max-md:w-full max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1',
              headerDetailsOpen ? 'max-md:flex' : 'max-md:hidden',
            )}
          >
          {pr.changedFilesCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-2">
                <button
                type="button"
                onClick={() => goToTab('changes')}
                className={cx('inline-flex shrink-0 items-center gap-1 rounded-ui px-0.5 tabular-nums hover:text-ui-ink touch:min-h-10', FOCUS_RING)}
                title="View the files changed by this PR"
              >
                <span>
                  {pr.changedFilesCount} file{pr.changedFilesCount === 1 ? '' : 's'}
                </span>
                <span className="text-ui-success">
                  +{pr.additions.toLocaleString()}
                </span>
                <span className="text-ui-danger">
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
          {/* BLAST RADIUS, beside the two size readings: icon + level, its reasons behind a click.
              ⚠ It reads the SAME `codeLoc` the flag beside it reads, so the two can never quote
              different line counts for one pull request. */}
          <BlastRadiusChip pr={{ ...blastFields, ...codeLocFields }} />
          {/* PR CHIPS — the stack and the criteria (PrChips.tsx), from this PR's own payload. */}
          <PrChips pr={pr} />
          </span>
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
        )}
      </header>
      {/* THE TABS — counts as facts, 1–9 while this PR is the one on screen. Picking a tab by
          hand drops any pending "show me this finding" target (`goToTab`'s whole job). A sibling
          of the header (same gutters) so that, below md, it can STICK to the top of the one
          scroller while the header scrolls away; md+ looks exactly as when it sat inside. */}
      <div
        ref={tabsBarRef}
        className={cx(
          'shrink-0 px-4 pt-2 md:px-5',
          placement === 'pane' && 'pr-12 md:pr-12',
          'max-md:sticky max-md:top-0 max-md:z-30 max-md:bg-ui-bg',
        )}
      >
        <Tabs
          tabs={tabItems}
          value={stripValue}
          onChange={onStripChange}
          label={`Pull request #${pr.number} tabs`}
          numberKeys={liveVisible}
          idPrefix={`pr-${pr.id}`}
          variant="boxed"
          // md+: a strip too wide for the pane WRAPS, so no tab hides behind the edge fade. Below
          // md it stays one sticky scrolling row (two rows would eat the phone's screen).
          className="-mx-[3px] mb-1.5 md:flex-wrap md:gap-y-1.5"
        />
      </div>
      <div
        // On a phone the header scrolls away with the content (one scroller, the outer box): a
        // fixed header would leave a third of the screen for the diff.
        className="min-h-0 flex-1 overflow-auto max-md:flex-none max-md:overflow-visible"
        ref={panelRef}
        // Only the copy on screen records: the board's pane copy of the same PR can sit mounted
        // under the overlay, and its scroller clamps (a scroll event) when the shared tab changes.
        onScroll={(e) => {
          if (liveVisible) rememberPrScroll(prId, effectiveTab, e.currentTarget.scrollTop);
        }}
        role="tabpanel"
        id={panelId(`pr-${pr.id}`, effectiveTab)}
        aria-labelledby={tabId(`pr-${pr.id}`, stripValue)}
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
              aiReview={
                // The Open PRs side panel's AI review facts, above the Checks row.
                <PrOverviewAiReview
                  prId={pr.id}
                  enabled={claudeReviewEnabled}
                  onOpenReview={() => goToTab('claude_review')}
                  onOpenFix={() => goToTab(aiFixTabEnabled ? 'ai_fix' : 'claude_review')}
                />
              }
            />
          </div>
        ) : effectiveTab === 'activity' ? (
          // Every comment, review, commit and lifecycle event, newest first, the composer on top.
          <PrActivityTab
            pr={pr}
            usersById={usersById}
            since={activitySince}
            onClearSince={() => setActivitySince(null)}
            focusEvent={activityFocusForPr}
            onEventFocusConsumed={consumeActivityFocus}
            focusKey={commentFocusForPr}
            onCommentFocusConsumed={consumeCommentFocus}
            selectedCommentId={selectedCommentId}
          />
        ) : effectiveTab === 'threads' ? (
          // The review threads without the code; "Show in context" moves to Changes.
          <PrThreadsTab
            pr={pr}
            usersById={usersById}
            aiEnabled={aiEnabled}
            selectedThreadId={selectedThreadId}
            botFilter={threadBotFilter}
            stateFilter={threadStateFilter}
            severityFilter={threadSeverityFilter}
            openInChangesFor={openInChangesFor}
          />
        ) : effectiveTab === 'changes' ? (
          <ChangesTab
            pr={pr}
            focus={changesFocus}
            threadOpenMemory={threadOpenMemory}
            keysEnabled={liveVisible}
          />
        ) : effectiveTab === 'bot_activity' ? (
          <PrBotBehaviourTab pr={pr} />
        ) : effectiveTab === 'ai_fix' ? (
          <AiFixTab pr={pr} />
        ) : effectiveTab === 'story' ? (
          currentStory != null && <PrStoryTab ticket={currentStory} oneColumn={placement === 'pane'} />
        ) : (
          <ClaudeReviewTab
            pr={pr}
            usersById={usersById}
            onOpenInChanges={openInChanges}
            onOpenThread={showThread}
            oneColumn={placement === 'pane'}
          />
        )}
        </Suspense>
      </div>
    </div>
    </PrFocusMetaContext.Provider>
  );
}
