import { useCallback, useEffect, useRef } from 'react';
import { flip, FloatingPortal, offset, shift } from '@floating-ui/react';
import type { ClaudeReviewPrState, TimelinePr } from '@pierre-review/shared';
import { landsAfterOf } from '@pierre-review/shared';
import { useAiBudget } from '../../hooks/useAiBudget.js';
import { usePrArmedIntent } from '../../hooks/useAutoMerge.js';
import { useClaudeReviewStarting } from '../../hooks/useClaudeReview.js';
import { useMe } from '../../hooks/useTriage.js';
import { hasActivePopover } from '../../lib/activePopover.js';
import { githubPrUrl } from '../../lib/prLink.js';
import { defaultReviewChoice, startReviewMenuItem, type DefaultReviewChoice } from '../../lib/startReviewMenu.js';
import { mergeVerdict } from '../../lib/ui.js';
import { CloseIcon, CoinIcon, CopyIcon, DiffIcon, MergeIcon, OverviewIcon, ReviewIcon, SparkleIcon, ThreadsIcon } from '../Icons.js';
import { writeClipboard } from '../CopyButton.js';
import { MergeControl } from '../MergeControl.js';
import { ContextMenu, cx, FOCUS_RING, type MenuEntry } from '../ui/index.js';
import { usePlacedFloating } from '../ui/floating.js';

// THE OPEN PRs ROW MENU (docs/FRONTEND.md § Open PRs → the row menu): a right-click on a row, or
// Shift+F10 / the context-menu key on the selected one. Merge (only where it can land), then the
// PR's Overview · Changes · Threads · AI Review — each opens the PR on that tab — then Start review,
// then Copy GitHub URL (the PR's github.com address, `githubPrUrl`; absent when it cannot be built).
//
// START REVIEW (lib/startReviewMenu.ts) starts the run the AI Review tab's Run button starts with
// nothing picked, gated by the same checks: shown only while `me.ai.enabled`; DISABLED with the reason
// as its hint while AI is not set up or signed in, or a review is starting, queued or running (or done
// at the PR's latest commit). Over the spend budget it still runs, after one more choice
// (`OpenPrsBudgetAsk`) — a run the reader starts is never refused.
//
// ⚠ NOTHING HERE FETCHES ON OPEN. Merge is decided from the row's SYNCED facts through the ONE
// `mergeVerdict` (as the Pending board does — `pendingMergeGate`), the repo's synced write
// permission (`OpenPrsResponse.writableRepoIds`) and the armed-intent list the app already polls.
// HIDDEN, never disabled. Choosing Merge is the click that mounts `MergeControl` expanded, and only
// that buys the live merge options (and their method picker).

/** Can the row menu offer Merge? Pure: the row's synced facts only. */
export function rowCanMerge(pr: TimelinePr, writable: boolean, armed: boolean, queued = false): boolean {
  if (!writable || armed || pr.isDraft) return false;
  return mergeVerdict({
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    isDraft: pr.isDraft,
    // ⚠ A QUEUED PR never shows Merge: `mergeVerdict`'s queue branch runs first (canMerge false).
    inMergeQueue: queued,
    landsAfter: landsAfterOf(pr.branchStack),
  }).canMerge;
}

export type RowMenuTab = 'overview' | 'changes';

export function OpenPrsRowMenu({
  x,
  y,
  pr,
  writable,
  queued = false,
  claudeOn,
  returnFocus,
  onClose,
  onMerge,
  onOpenTab,
  onOpenThreads,
  onOpenReview,
  claudeState,
  onStartReview,
  githubUrl = null,
}: {
  x: number;
  y: number;
  pr: TimelinePr;
  writable: boolean;
  /** GitHub's merge queue holds it (`OpenPrsResponse.queuedPrIds`). */
  queued?: boolean;
  claudeOn: boolean;
  /** The row's reading from the list's ONE batched Claude Review states answer. */
  claudeState?: ClaudeReviewPrState | undefined;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onMerge: () => void;
  onOpenTab: (tab: RowMenuTab) => void;
  onOpenThreads: () => void;
  onOpenReview: () => void;
  /** Start review: the choice to run, and whether to ask first (over the spend budget). */
  onStartReview: (choice: DefaultReviewChoice, overBudget: boolean) => void;
  /** The PR's github.com URL (`githubPrUrl`); null hides "Copy GitHub URL". */
  githubUrl?: string | null;
}): JSX.Element {
  const armed = usePrArmedIntent(pr.id) != null;
  const me = useMe().data;
  const choice = defaultReviewChoice(me);
  // The budget of the provider the run goes to (the tab's gate reads the same one).
  const budget = useAiBudget(choice.provider, { enabled: claudeOn }).data;
  const starting = useClaudeReviewStarting(pr.id);
  const start = claudeOn
    ? startReviewMenuItem({ me, state: claudeState, starting, overBudget: budget?.status.overBudget === true })
    : ({ show: false } as const);
  const items: MenuEntry[] = [
    ...(rowCanMerge(pr, writable, armed, queued)
      ? ([
          { id: 'merge', label: 'Merge', icon: <MergeIcon size={14} />, onSelect: onMerge },
          { id: 'sep', separator: true },
        ] as MenuEntry[])
      : []),
    { id: 'overview', label: 'Overview', icon: <OverviewIcon size={14} />, onSelect: () => onOpenTab('overview') },
    { id: 'changes', label: 'Changes', icon: <DiffIcon size={14} />, onSelect: () => onOpenTab('changes') },
    { id: 'threads', label: 'Threads', icon: <ThreadsIcon size={14} />, onSelect: onOpenThreads },
    ...(claudeOn
      ? [{ id: 'ai-review', label: 'AI Review', icon: <SparkleIcon size={14} className="text-ai-signal" />, onSelect: onOpenReview }]
      : []),
    ...(start.show
      ? [
          {
            id: 'start-review',
            label: 'Start review',
            icon: <ReviewIcon size={14} className="text-ai-signal" />,
            ...(start.hint != null ? { hint: start.hint } : {}),
            disabled: start.disabled,
            onSelect: () => onStartReview(choice, start.overBudget),
          },
        ]
      : []),
    ...(githubUrl != null
      ? ([
          { id: 'sep-copy', separator: true },
          { id: 'copy-url', label: 'Copy GitHub URL', icon: <CopyIcon size={14} />, onSelect: () => void writeClipboard(githubUrl) },
        ] as MenuEntry[])
      : []),
  ];
  return <ContextMenu x={x} y={y} items={items} label={`Pull request #${pr.number}`} onClose={onClose} returnFocus={returnFocus} />;
}

/**
 * Start review over the spend budget: the one more choice the Run button's second press stands for
 * (components/AiBudget.tsx `OverBudgetConfirm`), opened where the row menu was. Automatic runs stand
 * down over budget; a run the reader starts is never refused.
 */
export function OpenPrsBudgetAsk({
  x,
  y,
  prNumber,
  returnFocus,
  onClose,
  onStart,
  onOpenSettings,
}: {
  x: number;
  y: number;
  prNumber: number;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onStart: () => void;
  onOpenSettings: () => void;
}): JSX.Element {
  const items: MenuEntry[] = [
    { id: 'over', heading: 'Over your AI spend budget' },
    { id: 'start', label: 'Start review anyway', icon: <ReviewIcon size={14} className="text-ai-signal" />, onSelect: onStart },
    { id: 'settings', label: 'AI spend settings', icon: <CoinIcon size={14} />, onSelect: onOpenSettings },
  ];
  return <ContextMenu x={x} y={y} items={items} label={`Start a review of #${prNumber}`} onClose={onClose} returnFocus={returnFocus} />;
}

/**
 * The row menu's Merge: the PR pane's own `MergeControl`, mounted EXPANDED at the menu's point (the
 * reader's click is what buys the live merge options). Closes on Escape or a press outside it; a
 * press in a list it opened (the method picker, `data-floating-layer`) is inside.
 */
export function OpenPrsMergePopover({
  x,
  y,
  pr,
  repoFullName,
  returnFocus,
  onClose,
}: {
  x: number;
  y: number;
  pr: TimelinePr;
  repoFullName: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const float = usePlacedFloating({
    open: true,
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { setReference } = float.refs;
  useEffect(() => {
    setReference({
      getBoundingClientRect: () => ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect,
    });
  }, [setReference, x, y]);

  const live = useRef({ onClose, returnFocus });
  live.current = { onClose, returnFocus };
  const close = useCallback((refocus = true) => {
    live.current.onClose();
    if (refocus) live.current.returnFocus?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element | null;
      if (panelRef.current?.contains(t) || t?.closest?.('[data-floating-layer]') != null) return;
      close(false);
    };
    // Capture phase, so the app's global Esc never also fires. While the method picker's list holds
    // the popover slot, its Escape is its own.
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || hasActivePopover()) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [close]);

  return (
    <FloatingPortal>
      <div
        ref={(el) => {
          panelRef.current = el;
          float.refs.setFloating(el);
        }}
        style={float.floatingStyles}
        data-floating-layer=""
        role="dialog"
        aria-label={`Merge #${pr.number}`}
        tabIndex={-1}
        data-testid="open-prs-merge-popover"
        className="z-[90] w-80 max-w-[calc(100vw-16px)] space-y-2 rounded-ui bg-ui-raise p-3 shadow-xl shadow-black/20 outline-none motion-safe:animate-ui-pop"
      >
        <div className="flex items-start gap-2">
          <p className="m-0 min-w-0 flex-1 truncate text-body font-medium text-ui-ink" title={pr.title}>
            Merge #{pr.number} · {pr.title}
          </p>
          <button
            type="button"
            aria-label="Close"
            onClick={() => close()}
            className={cx('hit -m-1 shrink-0 rounded-ui p-1 text-ui-mute hover:bg-ui-hover hover:text-ui-ink', FOCUS_RING)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <MergeControl prId={pr.id} githubUrl={githubPrUrl(repoFullName, pr.number) ?? ''} defaultOpen />
      </div>
    </FloatingPortal>
  );
}
