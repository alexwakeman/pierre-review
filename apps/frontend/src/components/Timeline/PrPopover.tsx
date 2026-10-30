import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { Repo, TimelinePr, User } from '@pierre-review/shared';
import { claimActivePopover } from '../../lib/activePopover.js';
import { cardTicketLabel, cardTickets } from '../../lib/cardTickets.js';
import { githubPrUrl } from '../../lib/prLink.js';
import { dateTime, relativeTime, userLabel } from '../../lib/ui.js';
import { useTicketLinks } from '../../hooks/useTicketLinks.js';
import { useTrackerOn } from '../../hooks/useWorkspaceTracker.js';
import { useFilters } from '../../store/filters.js';
import { Avatar } from '../CommentCard.js';
import { CloseIcon, ExternalLinkIcon, MergeIcon, PullRequestIcon, TicketIcon } from '../Icons.js';
import { ciStatusIcon, leadStatus, reviewStanding } from '../Activity/OpenPrsRows.js';
import { TicketKeyButton } from '../Activity/OpenPrsCards.js';
import { filesLabel } from '../Activity/PrCardShell.js';
import { Button, IconButton, StatusIcon, cx, type StatusTone } from '../ui/index.js';

// THE TIMELINE'S PR POPOVER (docs/FRONTEND.md § Timeline). Clicking a PR bar on the shared board — or
// ↵ on the PR j/k selected — opens this card beside the bar: the PR's key facts, then "Open details"
// (the PR's own tab, the path every PR tab takes) and "Open on GitHub". It replaced the bottom detail
// pane on the shared board. A PR FOCUS tab keeps its pane and never shows this.
//
// Every fact is read from the LEAN timeline row the board already holds (`TimelinePr`) — nothing is
// fetched to draw it, except the PR's ticket (one batched ticket-links read, only where the workspace
// has a tracker). The status words are the Open PRs rows' own (`leadStatus` → `mergeVerdict()`,
// `ciStatusIcon`, `reviewStanding`), so the two surfaces say the same thing about the same PR.
//
// ⚠ ONE POPOVER SLOT (lib/activePopover.ts): opening this closes any other popover; another opening
// closes this. Escape is captured (the global Escape would clear the selection as well). An outside
// press closes it — EXCEPT one on the timeline canvas, which the board routes itself (another bar
// re-targets this card, an event opens its own popover, empty canvas closes one level at a time).
//
// On a PHONE the same card is a bottom sheet (DESIGN.md § 6: menus and popovers become sheets).

export interface PrPopoverProps {
  pr: TimelinePr;
  repo: Repo | undefined;
  author: User | undefined;
  /** The board's container: presses inside it are the board's to route, and the bar is found in it. */
  container: HTMLElement | null;
  /** The click's x on screen (the card sits under that point of the bar); null = the bar's middle. */
  anchorX: number | null;
  phone: boolean;
  onClose: () => void;
  onOpenDetails: () => void;
}

const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as const;

/** The selected bar's on-screen point to hang the card from: the click's x, kept inside the part of
 *  the bar the board shows (a long bar runs past the window's edges). */
function barAnchorRect(container: HTMLElement | null, anchorX: number | null): DOMRect | null {
  const bar = container?.querySelector<HTMLElement>('.pr-bar.vis-selected');
  if (bar == null) return null;
  const r = bar.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const center = container?.querySelector<HTMLElement>('.vis-panel.vis-center')?.getBoundingClientRect();
  const lo = Math.max(r.left, center?.left ?? r.left);
  const hi = Math.max(lo, Math.min(r.right, center?.right ?? r.right));
  const x = anchorX == null ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, anchorX));
  return { ...EMPTY_RECT, x, left: x, right: x, top: r.top, bottom: r.bottom, y: r.top, height: r.height } as DOMRect;
}

/** One fact: a mute label, the value beside it. */
function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-meta leading-5 text-ui-mute">{label}</dt>
      <dd className="min-w-0 text-body text-ui-ink">{children}</dd>
    </>
  );
}

function stateStatus(pr: TimelinePr): { tone: StatusTone; label: string; icon: ReactNode; title?: string } {
  if (pr.state === 'merged') {
    const at = pr.mergedAt ?? pr.closedAt;
    return { tone: 'quiet', label: at != null ? `Merged ${relativeTime(at)}` : 'Merged', icon: <MergeIcon size={13} />, title: at != null ? dateTime(at) : undefined };
  }
  if (pr.state === 'closed') {
    const at = pr.closedAt;
    return { tone: 'quiet', label: at != null ? `Closed ${relativeTime(at)}` : 'Closed', icon: <CloseIcon size={12} />, title: at != null ? dateTime(at) : undefined };
  }
  if (pr.isDraft) return { tone: 'quiet', label: 'Draft', icon: <PullRequestIcon size={13} /> };
  return { tone: 'neutral', label: pr.isStalled ? 'Open, stalled' : 'Open', icon: <PullRequestIcon size={13} /> };
}

/** The review words for an OPEN PR: the standing when there is one, else whether anyone has looked. */
function reviewWords(pr: TimelinePr): { tone: StatusTone; label: string; icon: ReactNode | null } {
  const standing = reviewStanding(pr);
  if (standing != null) return standing;
  if (pr.reviewRequestedFromMe) return { tone: 'neutral', label: 'Your review is requested', icon: null };
  if (pr.firstReviewAt == null) return { tone: 'neutral', label: 'No review yet', icon: null };
  return { tone: 'neutral', label: 'Reviewed, not approved', icon: null };
}

export function PrPopover({ pr, repo, author, container, anchorX, phone, onClose, onOpenDetails }: PrPopoverProps): JSX.Element {
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const lastRect = useRef<DOMRect | null>(null);
  const workspaceId = useFilters((s) => s.workspaceId);
  const trackerOn = useTrackerOn(workspaceId);
  const { data: ticketData } = useTicketLinks([pr.id], trackerOn);
  const tickets = cardTickets(ticketData?.prs.find((p) => p.prId === pr.id));

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onClose();
    },
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['top-start', 'bottom-end', 'top-end'], padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(200, Math.min(availableHeight, 520))}px`;
        },
      }),
    ],
    // Every frame: the bar moves under the card when the board scrolls, zooms or rebuilds, and the
    // card is portalled to <body>, so vis's own scroll box is not an ancestor autoUpdate watches.
    whileElementsMounted: (ref, float, update) => autoUpdate(ref, float, update, { animationFrame: true }),
  });

  // The reference is a virtual element re-resolved on every frame (the bar's DOM node is replaced on
  // rebuilds). A bar scrolled out of the virtualised rows keeps the last place it was seen.
  useEffect(() => {
    if (phone) return;
    lastRect.current = null;
    refs.setReference({
      getBoundingClientRect: () => {
        const r = barAnchorRect(container, anchorX);
        if (r != null) lastRect.current = r;
        return r ?? lastRect.current ?? ({ ...EMPTY_RECT } as DOMRect);
      },
    });
  }, [refs, container, anchorX, pr.id, phone]);

  const dismiss = useDismiss(context, {
    escapeKey: false,
    // A press on the board is the board's to route (see the header).
    outsidePress: (e) => !(container != null && e.target instanceof Node && container.contains(e.target)),
  });
  const { getFloatingProps } = useInteractions([dismiss]);

  // The one-popover slot, and the captured Escape.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => claimActivePopover(() => closeRef.current()), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const repoName = repo?.fullName ?? null;
  const github = githubPrUrl(repoName, pr.number);
  const open = pr.state === 'open';
  const state = stateStatus(pr);
  const lead = open ? leadStatus(pr) : null;
  const ci = open ? ciStatusIcon(pr.ciStatus) : null;
  const review = open ? reviewWords(pr) : null;
  const who = userLabel(author, pr.authorId);

  const body = (
    <>
      <div className="flex items-start gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-meta tabular-nums text-ui-mute">
            {repoName ?? `repo ${pr.repoId}`}#{pr.number}
          </p>
          <p id={titleId} className="line-clamp-2 text-body font-medium text-ui-ink">
            {pr.title}
          </p>
        </div>
        <IconButton label="Close" icon={<CloseIcon />} size="sm" onClick={onClose} className="-mr-1.5 -mt-0.5" />
      </div>
      <dl className="grid min-h-0 grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 overflow-auto px-4 pb-3 pt-2.5">
        <Fact label="State">
          <StatusIcon tone={state.tone} icon={state.icon} label={state.label} title={state.title} />
        </Fact>
        <Fact label="Author">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Avatar user={author} size={16} />
            <span className="truncate">{who}</span>
          </span>
        </Fact>
        {lead != null && (
          <Fact label="Merge">
            <StatusIcon tone={lead.tone} icon={lead.icon} label={lead.label} title={lead.detail ?? undefined} />
          </Fact>
        )}
        {open && (
          <Fact label="CI">
            {ci != null ? <StatusIcon tone={ci.tone} icon={ci.icon} label={ci.label} /> : <span className="text-ui-mute">No checks</span>}
          </Fact>
        )}
        {review != null && (
          <Fact label="Review">
            {review.icon != null ? (
              <StatusIcon tone={review.tone} icon={review.icon} label={review.label} />
            ) : (
              <span className="text-ui-mute">{review.label}</span>
            )}
          </Fact>
        )}
        <Fact label="Size">
          <span className="tabular-nums">
            +{pr.additions} −{pr.deletions}
            <span className="text-ui-mute"> · {filesLabel(pr.changedFiles)}</span>
          </span>
        </Fact>
        <Fact label="Age">
          <span className="text-ui-mute">
            <span title={dateTime(pr.openedAt)}>Opened {relativeTime(pr.openedAt)}</span>
            {' · '}
            <span title={dateTime(pr.updatedAt)}>active {relativeTime(pr.updatedAt)}</span>
          </span>
        </Fact>
        {tickets.length > 0 && (
          <Fact label="Ticket">
            <span className="flex min-w-0 flex-col gap-0.5">
              {tickets.slice(0, 2).map((t) =>
                t.ident != null ? (
                  <TicketKeyButton key={t.key} ticket={{ ...t, ident: t.ident }} className="hit flex min-w-0 items-center gap-1.5 text-ui-ink hover:underline">
                    <TicketIcon size={12} className="shrink-0 text-ui-mute" />
                    <span className="truncate">{cardTicketLabel(t)}</span>
                  </TicketKeyButton>
                ) : (
                  <span key={t.key} className="flex min-w-0 items-center gap-1.5">
                    <TicketIcon size={12} className="shrink-0 text-ui-mute" />
                    <span className="truncate">{cardTicketLabel(t)}</span>
                  </span>
                ),
              )}
            </span>
          </Fact>
        )}
      </dl>
      <div className="flex items-center gap-2 px-4 pb-3.5 pt-1">
        <Button ref={primaryRef} variant="primary" size="sm" kbd="↵" title="Open the pull request in its own tab" onClick={onOpenDetails} data-testid="pr-popover-open">
          Open details
        </Button>
        {github != null && (
          <a
            href={github}
            target="_blank"
            rel="noreferrer noopener"
            className={cx(
              'inline-flex h-7 items-center gap-1.5 rounded-ui bg-ui-raise px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:h-10 touch:px-3',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent',
            )}
          >
            Open on GitHub <ExternalLinkIcon size={11} />
          </a>
        )}
      </div>
    </>
  );

  if (phone) {
    return (
      <FloatingPortal>
        <div className="fixed inset-0 z-[60] flex items-end bg-ui-scrim/40 motion-safe:animate-ui-fade" onClick={onClose}>
          <FloatingFocusManager context={context} modal initialFocus={primaryRef} returnFocus>
            <div
              ref={refs.setFloating}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              data-testid="pr-popover"
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[85vh] w-full flex-col rounded-t-xl bg-ui-raise pb-[env(safe-area-inset-bottom)] text-ui-ink shadow-2xl shadow-black/30 motion-safe:animate-ui-sheet-up"
            >
              {body}
            </div>
          </FloatingFocusManager>
        </div>
      </FloatingPortal>
    );
  }

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} initialFocus={primaryRef} returnFocus={false}>
        <div
          ref={refs.setFloating}
          style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
          {...getFloatingProps()}
          role="dialog"
          aria-labelledby={titleId}
          data-testid="pr-popover"
          className="z-[60] flex w-[340px] max-w-[92vw] flex-col rounded-ui bg-ui-raise text-ui-ink shadow-xl shadow-black/25 ring-1 ring-ui-line motion-safe:animate-ui-pop"
        >
          {body}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
