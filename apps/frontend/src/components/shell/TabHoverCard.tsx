// THE OPEN-TABS HOVER CARD (docs/FRONTEND.md § The tab hover card). Hovering a tab in the sidebar's
// "Open tabs" list (or giving it keyboard focus) shows a short card beside it that says which tab it
// is: for a PR, its repository, author, CI, review, AI review and threads; for every other kind, the
// facts the app already holds about it. It replaces the tab's browser tooltip.
//
//   OPENS      after a short rest (OPEN_MS); once one card has shown, the next tab's opens at once
//              (the list's FloatingDelayGroup), so running down the list reads tab after tab.
//   STATIC     placed once, beside the tab (right, flipping left), and `pointer-events-none`: it never
//              follows the mouse and the pointer cannot rest on it, so it cannot hold itself open.
//   CLOSES     CLOSE_MS after the pointer leaves the tab, on a click, on Escape and when focus moves on.
//   A11Y       role="tooltip" + aria-describedby on the tab while shown (useRole).
//   FAST       ⚠ NOTHING FETCHES PER CARD. The body mounts only while shown and paints from the cache
//              (lib/tabHoverCard.ts). A PR card adds ONE shared, DB-only batch for every PR tab
//              (hooks/usePrTabSummaries.ts) and, with AI on, the Open PRs column's batched AI review
//              states — both 30 s fresh, so moving from tab to tab asks for nothing.
import { useState, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDelayGroup,
  useDismiss,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  pairModelsLabel,
  type AutomatedReviewerKind,
  type ClaudeReviewPrState,
  type ClaudeReviewStatesResponse,
  type ClaudeReviewVerdict,
  type OpenPrsResponse,
  type PrDetail,
  type TicketPrsResponse,
  type TicketStoryResponse,
} from '@pierre-review/shared';
import type { Tab } from '../../store/pinnedTabs.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import { usePlacedFloating } from '../ui/floating.js';
import { cx } from '../ui/index.js';
import type { TabChipCfg } from '../PinnedTabsBar.js';
import { CiDot } from '../Activity/BranchStatusChip.js';
import { LeadVerdict } from '../Activity/ClaudeReviewCell.js';
import { WarningIcon } from '../Icons.js';
import { useMe } from '../../hooks/useTriage.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { CLAUDE_REVIEW_STATES_KEY, useClaudeReviewStates } from '../../hooks/useClaudeReview.js';
import { TAB_CARD_FRESH_MS, usePrTabSummaries } from '../../hooks/usePrTabSummaries.js';
import { workspaceKey } from '../../hooks/useActivity.js';
import { leadCurrency, reviewCellFor } from '../../lib/claudeReviewColumn.js';
import { prTabFacts, prTabIds, reviewDecisionWords, threadStateParts, type PrTabFacts } from '../../lib/tabHoverCard.js';
import { automatedReviewerMeta, MERGE_TONE_CLASS, mergeVerdict, PR_STATE_META, prHeaderCi } from '../../lib/ui.js';

const OPEN_MS = 350;
const CLOSE_MS = 120;
/** The list's delay group: see the header. */
export const TAB_CARD_DELAY = { open: OPEN_MS, close: CLOSE_MS } as const;

const PANEL =
  'pointer-events-none z-[60] w-72 max-w-[90vw] rounded-ui border border-ui-line bg-ui-surface px-3 py-2.5 text-meta leading-snug text-ui-ink shadow-lg';

/**
 * The hover card's wiring for one tab button: spread `referenceProps(own)` onto the button (it merges
 * the button's own handlers) and set `setReference` as its ref; render `card` beside it.
 */
export function useTabHoverCard(tab: Tab, cfg: TabChipCfg) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = usePlacedFloating({
    open,
    onOpenChange: setOpen,
    placement: 'right-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { delay } = useDelayGroup(context, { id: tab.key });
  const hover = useHover(context, { delay, mouseOnly: true });
  const focus = useFocus(context);
  const dismiss = useDismiss(context, { referencePress: true });
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  const card = open ? (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        className={PANEL}
        data-testid="tab-hover-card"
      >
        <TabCardBody tab={tab} cfg={cfg} />
      </div>
    </FloatingPortal>
  ) : null;
  return {
    setReference: refs.setReference,
    /** The whole row (the ✕ included), so the card sits clear of it, outside the sidebar. */
    setPositionReference: refs.setPositionReference,
    referenceProps: getReferenceProps,
    /** Close at once (the row's right-click menu opens over it). */
    close: () => setOpen(false),
    card,
  };
}

function TabCardBody({ tab, cfg }: { tab: Tab; cfg: TabChipCfg }): JSX.Element {
  switch (tab.kind) {
    case 'pr-detail':
    case 'pr-focus':
      return <PrCard tab={tab} />;
    case 'ticket':
    case 'story-build':
      return <TicketCard tab={tab} cfg={cfg} />;
    case 'user-activity':
      return <PersonCard tab={tab} cfg={cfg} />;
    case 'bot-detail':
      return <BotCard tab={tab} cfg={cfg} />;
    default:
      return (
        <>
          <Heading cfg={cfg} />
          <p className="m-0 mt-1 text-ui-mute">{cfg.title}</p>
        </>
      );
  }
}

/** The tab's own icon and words, as the list shows them. */
function Heading({ cfg }: { cfg: TabChipCfg }): JSX.Element {
  return (
    <p className="m-0 flex min-w-0 items-center gap-1.5 text-body font-medium">
      <span className="flex shrink-0">{cfg.icon}</span>
      <span className="min-w-0 truncate">{cfg.label}</span>
    </p>
  );
}

/** One fact: a label column and the value (the Open PRs side panel's own shape, smaller). */
function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <dt className="w-[4.75rem] shrink-0 text-ui-mute">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">{children}</dd>
    </div>
  );
}

const SEP = (
  <span aria-hidden className="text-ui-faint">
    ·
  </span>
);

// ── Pull requests ───────────────────────────────────────────────────────────────────────────────

function cachedDetail(qc: QueryClient, prId: number): { data: PrDetail; at: number } | null {
  const st = qc.getQueryState<PrDetail>(['pr', prId]);
  return st?.data != null ? { data: st.data, at: st.dataUpdatedAt } : null;
}

function cachedOpenPr(qc: QueryClient, prId: number) {
  for (const [, data] of qc.getQueriesData<OpenPrsResponse>({ queryKey: ['open-prs'] })) {
    const hit = data?.prs?.find((p) => p.id === prId);
    if (hit != null) return hit;
  }
  return null;
}

function cachedReviewState(qc: QueryClient, prId: number): ClaudeReviewPrState | undefined {
  for (const [, data] of qc.getQueriesData<ClaudeReviewStatesResponse>({ queryKey: CLAUDE_REVIEW_STATES_KEY })) {
    const hit = data?.states?.find((s) => s.prId === prId);
    if (hit != null) return hit;
  }
  return undefined;
}

function PrCard({ tab }: { tab: Tab }): JSX.Element {
  const qc = useQueryClient();
  const summaries = usePrTabSummaries();
  const aiOn = useMe().data?.ai?.enabled === true;
  const tabs = usePinnedTabs((s) => s.tabs);
  const states = useClaudeReviewStates(prTabIds(tabs), aiOn, { staleTime: TAB_CARD_FRESH_MS });
  const summary = summaries.data?.prs?.find((p) => p.id === tab.prId);
  const facts = prTabFacts({
    meta: tab.meta,
    summary: summary != null ? { data: summary, at: summaries.isPlaceholderData ? 0 : summaries.dataUpdatedAt } : null,
    detail: cachedDetail(qc, tab.prId),
    openPr: cachedOpenPr(qc, tab.prId),
  });
  const reviewState = states.data?.states?.find((s) => s.prId === tab.prId) ?? cachedReviewState(qc, tab.prId);
  const loading = facts.state == null && summaries.isFetching;
  return (
    <>
      <p className="m-0 truncate text-ui-mute">
        {facts.repoFullName ?? 'Pull request'}
        {facts.number != null && ` #${facts.number}`}
      </p>
      <p className="m-0 mt-0.5 line-clamp-2 text-body font-medium">{facts.title ?? 'Pull request'}</p>
      {tab.kind === 'pr-focus' && <p className="m-0 mt-0.5 text-ui-mute">PR focus: this pull request alone on the timeline</p>}
      <dl className="m-0 mt-1.5">
        <AuthorFact facts={facts} />
        {loading ? (
          <p className="m-0 py-0.5 text-ui-mute">Loading…</p>
        ) : (
          <>
            <StateFacts facts={facts} />
            {aiOn && <AiReviewFact state={reviewState} loaded={states.data != null || reviewState != null} />}
            <ThreadsFact facts={facts} />
          </>
        )}
      </dl>
    </>
  );
}

function AuthorFact({ facts }: { facts: PrTabFacts }): JSX.Element | null {
  const login = facts.authorLogin;
  const name = facts.authorDisplayName;
  if (login == null && name == null) return null;
  return (
    <Fact label="Author">
      <span className="min-w-0 truncate">
        {name ?? `@${login}`}
        {name != null && login != null && <span className="text-ui-mute"> @{login}</span>}
      </span>
    </Fact>
  );
}

const cap = (s: string): string => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);

function StateFacts({ facts }: { facts: PrTabFacts }): JSX.Element | null {
  if (facts.state == null) return null;
  const open = facts.state === 'open';
  // ⚠ CI is present tense on an OPEN PR only (`prHeaderCi`): a merged PR's stored CI is history.
  const ci = facts.ciStatus != null ? prHeaderCi(facts.state, facts.ciStatus) : null;
  const verdict =
    open && facts.mergeable != null && facts.mergeStateStatus != null
      ? mergeVerdict({
          mergeable: facts.mergeable,
          mergeStateStatus: facts.mergeStateStatus,
          isDraft: facts.isDraft,
          inMergeQueue: facts.inMergeQueue,
        })
      : null;
  return (
    <>
      <Fact label="State">
        <span>{open && facts.isDraft ? 'Draft' : PR_STATE_META[facts.state].label}</span>
        {verdict != null && verdict.verdict !== 'draft' && (
          <>
            {SEP}
            <span className={MERGE_TONE_CLASS[verdict.tone]}>{cap(verdict.label)}</span>
          </>
        )}
      </Fact>
      {ci != null && (
        <Fact label="CI">
          <CiDot status={ci.status} size={7} title={ci.label} />
          <span>{ci.label}</span>
        </Fact>
      )}
      {facts.reviewDecision !== undefined && (
        <Fact label="Review">
          <span>{reviewDecisionWords(facts.reviewDecision)}</span>
        </Fact>
      )}
    </>
  );
}

// Red means blocks, approval reads green, a comment is ink (the Open PRs side panel's tones).
const VERDICT_TONE: Record<ClaudeReviewVerdict, string> = {
  REQUEST_CHANGES: 'text-ui-danger',
  APPROVE: 'text-ui-success',
  COMMENT: 'text-ui-ink',
};

function AiReviewFact({ state, loaded }: { state: ClaudeReviewPrState | undefined; loaded: boolean }): JSX.Element {
  if (!loaded) {
    return (
      <Fact label="AI review">
        <span className="text-ui-mute">Loading…</span>
      </Fact>
    );
  }
  const cell = reviewCellFor(state, false);
  let body: ReactNode;
  switch (cell.kind) {
    case 'start':
      body = cell.failed ? (
        <span className="inline-flex items-center gap-1 text-ui-danger">
          <WarningIcon size={12} className="shrink-0" />
          Review failed
        </span>
      ) : (
        <span className="text-ui-mute">Not reviewed</span>
      );
      break;
    case 'starting':
    case 'queued':
      body = <span className="text-ui-mute">Queued</span>;
      break;
    case 'running':
      body = (
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ai-signal-fill motion-safe:animate-pulse" />
          Reviewing…
        </span>
      );
      break;
    case 'done': {
      const currency = leadCurrency(state);
      const ranOn = cell.by == null && state?.ranOn != null && state.ranOn.length > 0 ? pairModelsLabel(state.ranOn) : null;
      body = (
        <>
          <span className={cx('inline-flex items-center gap-1 font-medium', cell.verdict != null ? VERDICT_TONE[cell.verdict] : 'text-ui-ink')}>
            <LeadVerdict cell={cell} iconSize={12} />
          </span>
          {(currency != null || ranOn != null) && (
            <span className="w-full text-ui-mute">{[currency?.label, ranOn].filter((x) => x != null).join(' · ')}</span>
          )}
        </>
      );
      break;
    }
  }
  return <Fact label="AI review">{body}</Fact>;
}

function ThreadsFact({ facts }: { facts: PrTabFacts }): JSX.Element | null {
  const c = facts.threadCounts;
  if (c == null) return null;
  const parts = threadStateParts(c);
  return (
    <Fact label="Threads">
      {parts.length === 0 ? (
        <span className="text-ui-mute">None</span>
      ) : (
        parts.map((p) => (
          <span key={p.state} className="inline-flex items-center gap-1">
            <span aria-hidden className="decorative-mark inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="tabular-nums">{p.count}</span> {p.label.toLowerCase()}
          </span>
        ))
      )}
    </Fact>
  );
}

// ── Tickets and build sessions ──────────────────────────────────────────────────────────────────

function TicketCard({ tab, cfg }: { tab: Tab; cfg: TabChipCfg }): JSX.Element {
  const qc = useQueryClient();
  const workspaceId = useFilters((s) => s.workspaceId);
  const ident = tab.ticketMeta?.ident ?? null;
  // Cache only: what the story view read when it was open. Nothing is asked for here.
  const story =
    ident != null ? qc.getQueryData<TicketStoryResponse>(['ticket-story', workspaceKey(workspaceId), ident]) : undefined;
  const prs = ident != null ? qc.getQueryData<TicketPrsResponse>(['ticket-prs', `ws:${workspaceId}`, ident]) : undefined;
  const title = tab.ticketMeta?.title ?? story?.ticket?.title ?? prs?.ticket?.title ?? null;
  const status = story?.ticket?.status ?? prs?.ticket?.status ?? null;
  const assignee = story?.ticket?.assignee ?? null;
  const prParts =
    prs != null && prs.found
      ? [
          prs.open.length > 0 ? `${prs.open.length} open` : null,
          prs.merged.length > 0 ? `${prs.merged.length} merged` : null,
          prs.closed.length > 0 ? `${prs.closed.length} closed` : null,
        ].filter((s): s is string => s != null)
      : null;
  return (
    <>
      <Heading cfg={cfg} />
      {title != null && <p className="m-0 mt-0.5 line-clamp-2 text-body">{title}</p>}
      <p className="m-0 mt-0.5 text-ui-mute">{tab.kind === 'story-build' ? 'Implement story: the build session' : 'The ticket and its pull requests'}</p>
      {(status != null || assignee != null || prParts != null || story?.ticket != null) && (
        <dl className="m-0 mt-1.5">
          {status != null && (
            <Fact label="Status">
              <span>{status.name}</span>
            </Fact>
          )}
          {assignee != null && (
            <Fact label="Assignee">
              <span className="min-w-0 truncate">{assignee.name}</span>
            </Fact>
          )}
          {story?.ticket != null && (
            <Fact label="Sprint">
              <span>{story.ticket.inSprint ? 'In this sprint' : 'Not in this sprint'}</span>
            </Fact>
          )}
          {prParts != null && (
            <Fact label="Pull requests">
              <span>{prParts.length > 0 ? prParts.join(' · ') : 'None yet'}</span>
            </Fact>
          )}
        </dl>
      )}
    </>
  );
}

// ── People and bots ─────────────────────────────────────────────────────────────────────────────

function PersonCard({ tab, cfg }: { tab: Tab; cfg: TabChipCfg }): JSX.Element {
  const u = tab.userMeta;
  return (
    <>
      <Heading cfg={cfg} />
      {u?.displayName != null && u.login != null && <p className="m-0 mt-0.5 text-ui-mute">{u.displayName}</p>}
      <p className="m-0 mt-0.5 text-ui-mute">Their recent activity in this workspace</p>
    </>
  );
}

function BotCard({ tab, cfg }: { tab: Tab; cfg: TabChipCfg }): JSX.Element {
  const b = tab.botMeta;
  const { data: repos } = useRepos();
  const vendor = b != null ? (automatedReviewerMeta(b.kind as AutomatedReviewerKind) as { label: string } | undefined) : undefined;
  const repo = b?.repoId != null ? ((repos ?? []).find((r) => r.id === b.repoId)?.fullName ?? null) : null;
  return (
    <>
      <Heading cfg={cfg} />
      <p className="m-0 mt-0.5 text-ui-mute">What this bot comments on, and how its comments are answered</p>
      <dl className="m-0 mt-1.5">
        {b?.login != null && (
          <Fact label="Account">
            <span className="min-w-0 truncate">@{b.login}</span>
          </Fact>
        )}
        {vendor != null && vendor.label !== b?.label && (
          <Fact label="Kind">
            <span>{vendor.label}</span>
          </Fact>
        )}
        <Fact label="Covers">
          <span className="min-w-0 truncate">{b?.repoId != null ? (repo ?? 'One repository') : 'The whole workspace'}</span>
        </Fact>
      </dl>
    </>
  );
}
