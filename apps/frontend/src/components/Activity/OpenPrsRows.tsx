import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CiReviewState,
  CiStatus,
  ClaudeReviewPrState,
  ClaudeTeamClaimSkip,
  TicketMergedPr,
  TicketReviewState,
  TimelinePr,
  User,
} from '@pierre-review/shared';
import { useClaudeReviewStarting } from '../../hooks/useClaudeReview.js';
import { useMergedPanelOpen } from '../../hooks/useTicketMergedPrs.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { reviewCellFor, reviewWorkInProgress } from '../../lib/claudeReviewColumn.js';
import { cardTicketLabel, type CardTicket } from '../../lib/cardTickets.js';
import { cardTicketPills, refusalSentence, ticketCoverage, ticketCurrency } from '../../lib/ticketReview.js';
import { useStartTicketReview, useTicketReviewStarting } from '../../hooks/useTicketReview.js';
import { ReviewedAgo } from '../ReviewedAgo.js';
import {
  CI_META,
  dateTime,
  mergeVerdict,
  mergeVerdictWarning,
  relativeTime,
  safeExternalUrl,
  userLabel,
} from '../../lib/ui.js';
import { prCountLabel, stackRollup, stackRollupParts, type OpenPrsStack } from '../../lib/openPrsStacks.js';
import { githubPrUrl } from '../../lib/prLink.js';
import { aiReadyFor, useAiCapabilities, useAiProviderName } from '../../hooks/useAiCapabilities.js';
import { Avatar } from '../CommentCard.js';
import { CopyButton } from '../CopyButton.js';
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CommentIcon,
  ConflictIcon,
  ExternalLinkIcon,
  LinkIcon,
  MergeIcon,
  PullRequestIcon,
  RequestChangesIcon,
  RingIcon,
  SparkleIcon,
  ThreadsIcon,
  TicketIcon,
  WarningIcon,
} from '../Icons.js';
import { VerdictIcon } from '../VerdictIcon.js';
import {
  Button,
  List,
  Row,
  RowLead,
  RowMeta,
  SidePanel,
  StatusIcon,
  cx,
  useIsDesktop,
  useListKeyboard,
  useRegisterCommands,
  type Command,
  type StatusTone,
} from '../ui/index.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { ClaudeReviewPanel } from './ClaudeReviewCell.js';
import { BlastRadiusChip } from './BlastRadiusChip.js';
import { LargePrFlag } from './LargePrFlag.js';
import { filesLabel } from './PrCardShell.js';
import { TicketKeyButton, threadChipLabel } from './OpenPrsCards.js';

// THE OPEN PRs ROWS — Activity → Open PRs in the redesign (docs/redesign/DESIGN.md): one LINE per
// pull request, the detail in a SidePanel. OpenPrsCards still owns every read (one batched request
// per kind, the ticket gate, the sort, the stacks, the merged panels) and hands the folded answers
// here; this file only draws them. The story view and Reports → "Merged so far" keep the cards.
//
// THE ROW, left to right, most important first:
//   lead: can it land? (mergeVerdict — red conflicts/blocked, green ready, grey otherwise, Draft)
//   title · repo#N (· the ticket key in List)
//   CI as an icon · review standing as an icon · open threads (count) · the AI review as ONE quiet
//   marker · size (+A −D) · author · age.
// Every icon carries its words as the tooltip and the accessible name. Every fact the old card
// said is in the SIDE PANEL, in words (status list, tickets, meta, reach, the AI review panel).
//
// KEYS (useListKeyboard): j/k move, ↵ opens the panel and, with the panel open, the pull request;
// `o` opens it on GitHub, `r` its AI review (where AI runs). Double-click opens the pull request.
// ⚠ Nothing here fetches on selection: the panel reads the list's batched answers only.
//
// GROUPED BY TICKET: one collapsible group per ticket (the collapse is the reader's, per session,
// never stored): the ticket line (key + title → the story view, status, type, assignee, the ticket
// review's criteria met + Re-check, the roll-up, the PR count), its rows, then "Merged (n)".

/** Rows drawn per page (the list stays whole for counts, sorts and groups; only drawing pages). */
export const OPEN_PRS_ROWS_PAGE = 60;

export interface OpenPrsRowsData {
  rows: readonly TimelinePr[];
  /** The ticket stacks when grouped; null = the plain list. */
  stacks: readonly OpenPrsStack[] | null;
  usersById: ReadonlyMap<number, User>;
  repoNameById: ReadonlyMap<number, string>;
  claudeOn: boolean;
  ticketReviewOn: boolean;
  claudeStates: ReadonlyMap<number, ClaudeReviewPrState>;
  ciStates: ReadonlyMap<number, CiReviewState>;
  teamClaimSkips: ReadonlyMap<number, Pick<ClaudeTeamClaimSkip, 'kind' | 'login'>>;
  ticketStates: ReadonlyMap<string, TicketReviewState>;
  ticketsOf: (pr: TimelinePr) => CardTicket[];
  mergedStacks: ReadonlyMap<string, readonly TicketMergedPr[]>;
  onOpenMerged: (pr: TicketMergedPr) => void;
  onOpenPr: (pr: TimelinePr) => void;
  onOpenReview: (pr: TimelinePr) => void;
  onOpenFix: (pr: TimelinePr) => void;
  /** The list's identity (workspace, repo filter, sort, layout): a change starts at one page. */
  windowKey: string | null;
  /** "Tickets loaded. [Group by ticket]" — shown above the list when offered. */
  offer?: ReactNode;
}

/** One drawn row: a PR, in a group (or not). A PR in two tickets is two entries. */
interface Entry {
  key: string;
  pr: TimelinePr;
  stackId: string | null;
  alsoIn: CardTicket[];
  ticketKey: string | null;
}

// ---- what the row's icons say (pure, so the panel says the same words) ----

/** The lead: can it land? Red blocks, green ready, grey otherwise. */
export function leadStatus(pr: TimelinePr): { tone: StatusTone; label: string; detail: string | null; icon: ReactNode } {
  // The same input as the card's merge chip had (OpenPrsCards MergeChip).
  const input = { mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft };
  const v: ReturnType<typeof mergeVerdict> | null = pr.isDraft ? mergeVerdictWarning(input) : mergeVerdict(input);
  if (pr.isDraft && (v == null || v.verdict === 'draft' || v.verdict === 'unknown')) {
    return { tone: 'quiet', label: 'Draft', detail: 'mark it ready for review to merge', icon: <PullRequestIcon size={14} /> };
  }
  if (v == null || v.verdict === 'unknown') {
    return { tone: 'neutral', label: 'Open', detail: null, icon: <PullRequestIcon size={14} /> };
  }
  const label = v.label.charAt(0).toUpperCase() + v.label.slice(1);
  if (v.verdict === 'conflicts') return { tone: 'blocked', label, detail: v.detail, icon: <ConflictIcon size={14} /> };
  if (v.tone === 'bad') return { tone: 'blocked', label, detail: v.detail, icon: <PullRequestIcon size={14} /> };
  if (v.tone === 'ok') return { tone: 'ready', label, detail: v.detail, icon: <MergeIcon size={14} /> };
  return { tone: 'neutral', label, detail: v.detail, icon: <PullRequestIcon size={14} /> };
}

/** CI as an icon: failing red, passing and running grey (passing is not news). Null = no reading. */
export function ciStatusIcon(ci: CiStatus | null | undefined): { tone: StatusTone; label: string; icon: ReactNode } | null {
  const meta = ci != null ? CI_META[ci] : null;
  if (meta == null) return null;
  if (ci === 'failure' || ci === 'error') return { tone: 'blocked', label: meta.label, icon: <CloseIcon size={13} /> };
  if (ci === 'success') return { tone: 'quiet', label: meta.label, icon: <CheckIcon size={13} /> };
  return { tone: 'neutral', label: meta.label, icon: <RingIcon size={12} /> };
}

/** Review standing: changes requested (red) or approved (green); nothing otherwise. */
export function reviewStanding(pr: TimelinePr): { tone: StatusTone; label: string; icon: ReactNode } | null {
  if (pr.isChangesRequested) return { tone: 'blocked', label: 'Changes requested', icon: <RequestChangesIcon size={13} /> };
  if (pr.isApproved) return { tone: 'ready', label: 'Approved', icon: <CheckCircleIcon size={13} /> };
  return null;
}

/** "+13 −3" — the size, for the row. */
function sizeText(pr: TimelinePr): string {
  return `+${pr.additions} −${pr.deletions}`;
}

/** The short age of the last activity ("2d"), the full date in the tooltip. */
function shortAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

function repoShort(full: string): string {
  const i = full.indexOf('/');
  return i >= 0 ? full.slice(i + 1) : full;
}

// ---- the window (session memo, so Back from a PR finds the same rows drawn and selected) ----

interface RowsMemo {
  key: string;
  limit: number;
  selectedKey: string | null;
  panelOpen: boolean;
}
let rowsMemo: RowsMemo | null = null;
/** Groups the reader folded this session (never stored). */
const foldedGroups = new Set<string>();

// ---- the AI marker in the row ----

function AiMarker({ prId, state, ciRunning, ticketRunning }: { prId: number; state: ClaudeReviewPrState | undefined; ciRunning: boolean; ticketRunning: boolean }): JSX.Element {
  const starting = useClaudeReviewStarting(prId);
  const aiName = useAiProviderName();
  const work = reviewWorkInProgress({ review: state, starting, ciRunning, ticketRunning });
  const cell = reviewCellFor(state, starting);
  let icon: ReactNode = null;
  let label: string;
  let tone = 'text-ai-muted';
  if (work.length > 0) {
    icon = <SparkleIcon size={13} className="motion-safe:animate-pulse" />;
    label = `${aiName} is working on this PR: ${work.join(', ')}`;
    tone = 'text-ai-signal';
  } else if (cell.kind === 'done') {
    icon = cell.verdict != null ? <VerdictIcon verdict={cell.verdict} size={13} /> : <CommentIcon size={13} />;
    label = `AI review: ${cell.verdictLabel}${cell.headMoved ? ' · newer commits since' : ''}`;
  } else if (cell.kind === 'start' && cell.failed) {
    icon = <WarningIcon size={13} />;
    label = 'AI review failed';
    tone = 'text-ui-danger';
  } else {
    label = 'Not reviewed by AI';
  }
  return (
    <span className={cx('flex w-4 shrink-0 items-center justify-center', tone)} title={label} aria-label={label} role="img">
      {icon}
    </span>
  );
}

// ---- the list ----

export function OpenPrsRows(props: OpenPrsRowsData): JSX.Element {
  const { rows, stacks, windowKey } = props;
  const listId = useId().replace(/:/g, '');
  const listRef = useRef<HTMLUListElement>(null);
  const docked = useIsDesktop();

  // The window and the selection, remembered for the session under the list's identity.
  const memo = rowsMemo != null && rowsMemo.key === windowKey ? rowsMemo : null;
  const [limit, setLimit] = useState(memo?.limit ?? OPEN_PRS_ROWS_PAGE);
  const [selectedKey, setSelectedKey] = useState<string | null>(memo?.selectedKey ?? null);
  const [panelOpen, setPanelOpen] = useState(memo?.panelOpen ?? false);
  const [foldTick, bumpFold] = useState(0);
  useEffect(() => {
    if (rowsMemo?.key !== windowKey) {
      setLimit(OPEN_PRS_ROWS_PAGE);
      setSelectedKey(null);
    }
  }, [windowKey]);
  useEffect(() => {
    rowsMemo = windowKey == null ? null : { key: windowKey, limit, selectedKey, panelOpen };
  }, [windowKey, limit, selectedKey, panelOpen]);

  // Every drawable entry, in order (folded groups contribute none), then the drawn window.
  const all: Entry[] = useMemo(() => {
    if (stacks == null) return rows.map((pr) => ({ key: `${pr.id}`, pr, stackId: null, alsoIn: [], ticketKey: null }));
    const out: Entry[] = [];
    for (const st of stacks) {
      if (foldedGroups.has(st.id)) continue;
      for (const r of st.rows) {
        out.push({ key: `${st.id}:${r.pr.id}`, pr: r.pr, stackId: st.id, alsoIn: r.alsoIn, ticketKey: st.ticket?.key ?? null });
      }
    }
    return out;
    // `foldTick` changes on every fold; the Set itself is read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, stacks, foldTick]);
  const drawn = all.slice(0, limit);
  const total = stacks == null ? rows.length : new Set(stacks.flatMap((s) => s.rows.map((r) => r.pr.id))).size;
  const selectedIndex = selectedKey == null ? null : drawn.findIndex((e) => e.key === selectedKey);
  const sel = selectedIndex != null && selectedIndex >= 0 ? selectedIndex : null;
  const selected = sel != null ? drawn[sel] : undefined;

  const select = useCallback(
    (i: number): void => {
      const e = drawn[i];
      if (e == null) return;
      setSelectedKey(e.key);
      // j/k to the last drawn rows draws the next page.
      if (i >= drawn.length - 3 && drawn.length < all.length) setLimit((l) => l + OPEN_PRS_ROWS_PAGE);
    },
    [drawn, all.length],
  );
  const openPr = (e: Entry | undefined): void => {
    if (e != null) props.onOpenPr(e.pr);
  };
  const githubOf = (e: Entry | undefined): string | null =>
    e == null ? null : githubPrUrl(props.repoNameById.get(e.pr.repoId) ?? '', e.pr.number);

  useListKeyboard({
    containerRef: listRef,
    count: drawn.length,
    selected: sel,
    onSelect: select,
    onOpen: (i) => {
      const e = drawn[i];
      if (e == null) return;
      if (panelOpen && e.key === selectedKey) openPr(e);
      else {
        setSelectedKey(e.key);
        setPanelOpen(true);
      }
    },
    actions: {
      o: (i) => {
        const url = githubOf(drawn[i]);
        if (url != null) window.open(url, '_blank', 'noopener,noreferrer');
      },
      ...(props.claudeOn
        ? {
            r: (i: number) => {
              const e = drawn[i];
              if (e != null) props.onOpenReview(e.pr);
            },
          }
        : {}),
    },
  });

  // ⌘K: act on the selected row.
  const commands = useMemo<Command[] | null>(() => {
    if (selected == null) return null;
    const label = `#${selected.pr.number}`;
    const list: Command[] = [
      { id: 'open', group: 'Actions', title: `Open pull request ${label}`, hint: selected.pr.title, shortcut: '↵', icon: <PullRequestIcon size={14} />, run: () => openPr(selected) },
    ];
    const url = githubOf(selected);
    if (url != null) {
      list.push({ id: 'github', group: 'Actions', title: `Open ${label} on GitHub`, shortcut: 'O', icon: <ExternalLinkIcon size={14} />, run: () => window.open(url, '_blank', 'noopener,noreferrer') });
      list.push({ id: 'copy', group: 'Actions', title: `Copy the GitHub link to ${label}`, icon: <LinkIcon size={14} />, keywords: ['url'], run: () => void navigator.clipboard?.writeText(url) });
    }
    if (props.claudeOn) {
      list.push({ id: 'review', group: 'Actions', title: `Open the AI review of ${label}`, shortcut: 'R', icon: <SparkleIcon size={14} />, run: () => props.onOpenReview(selected.pr) });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key, props.claudeOn]);
  useRegisterCommands('open-prs-row', commands);

  // The scroll trigger: within 600px of the bottom of what scrolls, draw the next page.
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (el == null || typeof IntersectionObserver === 'undefined') return;
    let root: HTMLElement | null = null;
    for (let p = el.parentElement; p != null && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') {
        root = p;
        break;
      }
    }
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) setLimit((l) => l + OPEN_PRS_ROWS_PAGE);
    }, { root, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [drawn.length]);

  const fold = (stackId: string): void => {
    if (foldedGroups.has(stackId)) foldedGroups.delete(stackId);
    else foldedGroups.add(stackId);
    bumpFold((n) => n + 1);
  };
  // "Also in": unfold that group, draw far enough to reach it, scroll to its header.
  const jumpTo = (stackId: string): void => {
    if (foldedGroups.delete(stackId)) bumpFold((n) => n + 1);
    if (stacks != null) {
      let before = 0;
      for (const st of stacks) {
        if (st.id === stackId) break;
        if (!foldedGroups.has(st.id)) before += st.rows.length;
      }
      setLimit((l) => Math.max(l, before + OPEN_PRS_ROWS_PAGE));
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.getElementById(groupDomId(stackId));
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    }));
  };

  const renderRow = (e: Entry, i: number): JSX.Element => (
    <PrRow
      key={e.key}
      listId={listId}
      index={i}
      entry={e}
      selected={sel === i}
      data={props}
      showTicket={stacks == null}
      onSelect={(idx) => {
        select(idx);
        setPanelOpen(true);
      }}
      onDoubleOpen={() => openPr(e)}
    />
  );

  // Draw: the plain list, or the groups (each with whichever of its rows fall in the window).
  let body: ReactNode;
  if (stacks == null) {
    body = drawn.map(renderRow);
  } else {
    let i = 0;
    const out: ReactNode[] = [];
    for (const st of stacks) {
      if (i >= drawn.length && !foldedGroups.has(st.id) && out.length > 0) break;
      const folded = foldedGroups.has(st.id);
      const start = i;
      const mine: ReactNode[] = [];
      if (!folded) {
        for (const _r of st.rows) {
          const e = drawn[i];
          if (e == null || e.stackId !== st.id) break;
          mine.push(renderRow(e, i));
          i++;
        }
      }
      out.push(
        <TicketGroup
          key={st.id}
          stack={st}
          folded={folded}
          onFold={() => fold(st.id)}
          data={props}
          complete={folded || i - start === st.rows.length}
        >
          {mine}
        </TicketGroup>,
      );
    }
    body = out;
  }

  const panel = (
    <SidePanel
      open={panelOpen && selected != null}
      onClose={() => {
        setPanelOpen(false);
        listRef.current?.focus();
      }}
      title={selected?.pr.title ?? ''}
      subtitle={selected != null ? `${props.repoNameById.get(selected.pr.repoId) ?? `repo ${selected.pr.repoId}`}#${selected.pr.number}` : undefined}
      testId="open-prs-panel-detail"
      className={docked ? 'sticky top-0 !h-[calc(100dvh-7rem)] self-start rounded-ui' : undefined}
      headerActions={
        selected != null && githubOf(selected) != null ? (
          <CopyButton text={githubOf(selected) as string} what="PR link" title="Copy the GitHub link to this PR" icon={<LinkIcon />} />
        ) : null
      }
      footer={
        selected != null ? (
          <>
            <Button variant="primary" kbd="↵" icon={<PullRequestIcon size={13} />} onClick={() => openPr(selected)}>
              Open pull request
            </Button>
            {props.claudeOn && (
              <Button kbd="R" icon={<SparkleIcon size={13} />} onClick={() => props.onOpenReview(selected.pr)}>
                AI review
              </Button>
            )}
            {githubOf(selected) != null && (
              <a
                href={githubOf(selected) as string}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-8 items-center gap-1.5 rounded-ui px-3 text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-11"
              >
                <ExternalLinkIcon size={13} />
                <span className="max-sm:sr-only">GitHub</span>
              </a>
            )}
          </>
        ) : null
      }
    >
      {selected != null && <PrPanelBody entry={selected} data={props} onJump={jumpTo} />}
    </SidePanel>
  );

  return (
    <div className="flex min-w-0 items-start gap-4">
      <div className="min-w-0 flex-1">
        {props.offer}
        <List
          id={listId}
          label="Open pull requests"
          selected={sel}
          listRef={listRef}
          className="-mx-1"
          empty={drawn.length === 0 && stacks == null ? 'No open PRs here.' : undefined}
        >
          {body}
        </List>
        {drawn.length < all.length && (
          <div ref={moreRef} data-testid="open-prs-more" className="mt-2 flex items-center justify-center gap-3 text-meta text-ui-faint">
            <span className="tabular-nums">
              {Math.min(drawn.length, total)} of {total} PRs
            </span>
            <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + OPEN_PRS_ROWS_PAGE)}>
              Show more
            </Button>
          </div>
        )}
      </div>
      {panel}
    </div>
  );
}

export const groupDomId = (stackId: string): string => `open-prs-group-${stackId.replace(/[^A-Za-z0-9_-]/g, '-')}`;

// ---- one row ----

function PrRow({
  listId,
  index,
  entry,
  selected,
  data,
  showTicket,
  onSelect,
  onDoubleOpen,
}: {
  listId: string;
  index: number;
  entry: Entry;
  selected: boolean;
  data: OpenPrsRowsData;
  showTicket: boolean;
  onSelect: (i: number) => void;
  onDoubleOpen: () => void;
}): JSX.Element {
  const { pr } = entry;
  const author = pr.authorId != null ? data.usersById.get(pr.authorId) : undefined;
  const repo = data.repoNameById.get(pr.repoId) ?? `repo ${pr.repoId}`;
  const lead = leadStatus(pr);
  const ci = ciStatusIcon(pr.ciStatus);
  const review = reviewStanding(pr);
  const threads = threadChipLabel(pr.threadCounts);
  const openThreads = pr.threadCounts.untouched + pr.threadCounts.replied_unresolved + pr.threadCounts.likely_addressed;
  const tickets = showTicket ? data.ticketsOf(pr) : [];
  const ticketRunning =
    data.ticketReviewOn && data.ticketsOf(pr).some((t) => t.ident != null && data.ticketStates.get(t.ident)?.status === 'running');
  const activity = pr.updatedAt ?? pr.openedAt;
  return (
    <Row listId={listId} index={index} selected={selected} onSelect={onSelect} className="select-none">
      <span className="contents" onDoubleClick={onDoubleOpen}>
        <RowLead>
          <StatusIcon tone={lead.tone} icon={lead.icon} label={lead.label} iconOnly title={lead.detail != null ? `${lead.label}: ${lead.detail}` : lead.label} />
        </RowLead>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={cx('min-w-0 truncate', pr.isDraft ? 'text-ui-mute' : 'text-ui-ink')} title={pr.title}>
            {pr.title}
          </span>
          <span className="shrink-0 truncate text-meta text-ui-faint max-sm:hidden" title={`${repo}#${pr.number}`}>
            {pr.isDraft && 'Draft · '}
            {repoShort(repo)}#{pr.number}
          </span>
          {tickets[0] != null && (
            <span className="shrink-0 font-mono text-meta text-ui-faint max-md:hidden" title={cardTicketLabel(tickets[0])}>
              {tickets[0].key}
              {tickets.length > 1 && ` +${tickets.length - 1}`}
            </span>
          )}
        </span>
        <span className="flex w-4 shrink-0 items-center justify-center max-sm:hidden">
          {ci != null && <StatusIcon tone={ci.tone} icon={ci.icon} label={ci.label} iconOnly />}
        </span>
        <span className="flex w-4 shrink-0 items-center justify-center max-sm:hidden">
          {review != null && <StatusIcon tone={review.tone} icon={review.icon} label={review.label} iconOnly />}
        </span>
        <span
          className={cx(
            // ONE grey number; an untouched thread adds a small red dot, never an amber count.
            'flex w-9 shrink-0 items-center gap-1 text-meta tabular-nums text-ui-faint max-md:hidden',
          )}
          title={threads != null ? `Review threads: ${threads.text}` : undefined}
        >
          {threads != null && openThreads > 0 && (
            <>
              <ThreadsIcon size={12} aria-hidden />
              <span className="sr-only">Review threads: {threads.text}</span>
              <span aria-hidden>{openThreads}</span>
              {pr.threadCounts.untouched > 0 && (
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ui-danger" />
              )}
            </>
          )}
        </span>
        {data.claudeOn && (
          <span className="max-sm:hidden">
            <AiMarker
              prId={pr.id}
              state={data.claudeStates.get(pr.id)}
              ciRunning={data.ciStates.get(pr.id)?.status === 'running'}
              ticketRunning={ticketRunning}
            />
          </span>
        )}
        <RowMeta hideBelow="lg" width={76} className="text-right font-mono">
          <span title={`${filesLabel(pr.changedFiles)} · ${pr.additions} added, ${pr.deletions} removed`}>{sizeText(pr)}</span>
        </RowMeta>
        <RowMeta hideBelow="md" width={112} className="flex items-center gap-1.5 text-ui-mute">
          <Avatar user={author} size={14} />
          <span className="truncate">{userLabel(author, pr.authorId)}</span>
        </RowMeta>
        <RowMeta width={32} className="text-right">
          <span title={`Updated ${dateTime(activity)} · opened ${dateTime(pr.openedAt)}`}>{shortAge(activity)}</span>
        </RowMeta>
      </span>
    </Row>
  );
}

// ---- a ticket group ----

function TicketGroup({
  stack,
  folded,
  onFold,
  data,
  complete,
  children,
}: {
  stack: OpenPrsStack;
  folded: boolean;
  onFold: () => void;
  data: OpenPrsRowsData;
  /** Every row of the group is drawn (the Merged panel waits for the last one). */
  complete: boolean;
  children: ReactNode;
}): JSX.Element {
  const t = stack.ticket;
  const headId = useId();
  const href = t != null ? safeExternalUrl(t.url) : null;
  const rollup = stackRollupParts(stackRollup(stack.rows));
  const merged = data.mergedStacks.get(stack.id) ?? [];
  const review =
    data.ticketReviewOn && t?.ident != null && stack.rows[0] != null
      ? { ident: t.ident, state: data.ticketStates.get(t.ident), prId: stack.rows[0].pr.id }
      : null;
  return (
    <li role="presentation" className="mt-3 first:mt-0">
      <div
        role="group"
        aria-labelledby={headId}
        id={groupDomId(stack.id)}
        tabIndex={-1}
        className="scroll-mt-4 rounded-ui outline-none"
      >
        {/* ONE line at every width: chevron · key + title (→ the story view) … status · type ·
            assignee · criteria met + Re-check · roll-up · PR count. Below md only the title, a red
            dot when something in the group blocks, and the PR count stay on the line — the status,
            criteria and Re-check are one tap away in the ticket's story view. */}
        <div role="presentation" className="flex min-w-0 items-center gap-x-3 gap-y-0.5 rounded-ui px-1 py-1.5 md:flex-wrap">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 md:basis-[18rem]">
            <button
              type="button"
              onClick={onFold}
              aria-expanded={!folded}
              aria-label={folded ? `Show the pull requests for ${t?.key ?? 'no ticket'}` : `Hide the pull requests for ${t?.key ?? 'no ticket'}`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-ui text-ui-faint hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 touch:w-10"
            >
              <ChevronIcon dir={folded ? 'right' : 'down'} size={12} />
            </button>
            <h3 id={headId} className="m-0 flex min-w-0 flex-1 items-baseline gap-2 text-body font-medium text-ui-ink">
              {t == null ? (
                <span className="text-ui-mute">No ticket</span>
              ) : t.ident != null ? (
                <TicketKeyButton ticket={{ ...t, ident: t.ident }} className="flex min-w-0 items-baseline gap-2 hover:underline touch:min-h-10 touch:flex-1 touch:items-center">
                  <span className="inline-flex shrink-0 items-center gap-1 font-mono text-meta text-ui-mute">
                    <TicketIcon size={12} className="shrink-0 self-center" />
                    {t.key}
                    <span className="sr-only">:</span>
                  </span>
                  {t.title != null && <span className="min-w-0 truncate">{t.title}</span>}
                </TicketKeyButton>
              ) : (
                <>
                  {href != null ? (
                    <a href={href} target="_blank" rel="noreferrer noopener" title={`Open ${cardTicketLabel(t)}`} className="hit inline-flex shrink-0 items-center gap-1 font-mono text-meta text-ui-mute hover:underline">
                      <TicketIcon size={12} className="shrink-0 self-center" />
                      {t.key}
                      <span className="sr-only">:</span>
                    </a>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-meta text-ui-mute">
                      <TicketIcon size={12} className="shrink-0 self-center" />
                      {t.key}
                    </span>
                  )}
                  {t.title != null && <span className="min-w-0 truncate">{t.title}</span>}
                </>
              )}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-x-3 gap-y-0.5 text-meta text-ui-mute md:ml-auto md:min-w-0 md:shrink md:flex-wrap md:justify-end">
            {t != null && (
              <span className="contents max-md:hidden">
                <TicketFacts t={t} />
              </span>
            )}
            {review != null && (
              <span className="contents max-md:hidden">
                <GroupCoverage ident={review.ident} state={review.state} prId={review.prId} />
              </span>
            )}
            {rollup.map((p) => (
              <span key={p.text} className={cx('shrink-0 max-md:hidden', p.tone === 'bad' ? 'text-ui-danger' : 'text-ui-success')}>
                {p.text}
              </span>
            ))}
            {rollup.some((p) => p.tone === 'bad') && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ui-danger md:hidden" title={rollup.filter((p) => p.tone === 'bad').map((p) => p.text).join(' · ')}>
                <span className="sr-only">{rollup.filter((p) => p.tone === 'bad').map((p) => p.text).join(', ')}</span>
              </span>
            )}
            <span className="shrink-0 tabular-nums text-ui-faint">{prCountLabel(stack.rows.length)}</span>
          </div>
        </div>
        {!folded && (
          <ul role="presentation" aria-label={t != null ? `Pull requests for ${t.key}` : 'Pull requests with no ticket'} className="m-0 list-none p-0">
            {children}
          </ul>
        )}
        {!folded && complete && merged.length > 0 && <MergedRows stackId={stack.id} prs={merged} onOpen={data.onOpenMerged} />}
      </div>
    </li>
  );
}

/** A group's "Merged (n)": collapsed by default (per session), one quiet line per merged PR. */
function MergedRows({ stackId, prs, onOpen }: { stackId: string; prs: readonly TicketMergedPr[]; onOpen: (pr: TicketMergedPr) => void }): JSX.Element {
  const open = useMergedPanelOpen((s) => s.open.has(stackId));
  const toggle = useMergedPanelOpen((s) => s.toggle);
  const id = useId();
  return (
    <div className="pl-[30px] pt-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => toggle(stackId)}
        className="inline-flex h-7 items-center gap-1.5 rounded-ui px-1.5 text-meta text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={11} />
        Merged ({prs.length})
      </button>
      <ul id={id} hidden={!open} aria-label="Merged pull requests" className="m-0 list-none p-0">
        {prs.map((m) => (
          <li key={m.prId}>
            <button
              type="button"
              onClick={() => onOpen(m)}
              className="flex h-row w-full min-w-0 items-center gap-3 rounded-ui px-2 text-left text-body hover:bg-ui-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ui-accent touch:h-row-touch"
            >
              <MergeIcon size={13} className="shrink-0 text-ui-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ui-mute" title={m.title}>
                {m.title}
                <span className="ml-2 text-meta text-ui-faint">
                  {repoShort(m.repoFullName)}#{m.number}
                </span>
              </span>
              {m.authorLogin != null && (
                <span className="w-28 shrink-0 truncate text-meta text-ui-faint max-md:hidden">{m.authorDisplayName ?? m.authorLogin}</span>
              )}
              <span className="shrink-0 text-meta text-ui-faint" title={`Merged ${dateTime(m.mergedAt)}`}>
                merged {relativeTime(m.mergedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The ticket's status, type and assignee as quiet words (the board's chips, without the colour). */
function TicketFacts({ t }: { t: NonNullable<OpenPrsStack['ticket']> }): JSX.Element {
  const cat = t.statusCategory ?? null;
  const status = t.status ?? (cat === 'done' ? 'Complete' : cat === 'indeterminate' ? 'In progress' : cat === 'new' ? 'To do' : null);
  return (
    <>
      {status != null && (
        <span className="inline-flex shrink-0 items-center gap-1" title="Status in the tracker">
          <span
            aria-hidden
            className={cx('h-1.5 w-1.5 rounded-full', cat === 'done' ? 'bg-ui-success' : cat === 'indeterminate' ? 'bg-ui-mute' : 'bg-ui-faint')}
          />
          {status}
        </span>
      )}
      {t.issueType != null && <span className="shrink-0 text-ui-faint max-lg:hidden">{t.issueType}</span>}
      {t.assignee != null ? (
        <span className="max-w-[9rem] shrink-0 truncate text-ui-faint" title={`Assigned to ${t.assignee.name}`}>
          {t.assignee.name}
        </span>
      ) : (
        status != null && <span className="shrink-0 text-ui-faint">Unassigned</span>
      )}
    </>
  );
}

/** The ticket review's criteria met ("2 of 3 met"; red when none, green when all) and Check / Re-check. */
function GroupCoverage({ ident, state, prId }: { ident: string; state: TicketReviewState | undefined; prId: number }): JSX.Element | null {
  const ready = aiReadyFor(useAiCapabilities(), 'ticket_review');
  const start = useStartTicketReview(ident);
  const starting = useTicketReviewStarting(ident);
  const cov = ticketCoverage(state);
  const currency = state != null ? ticketCurrency(state) : null;
  const running = state?.status === 'running';
  const refused = start.data?.runs.find((r) => r.ident === ident)?.refused ?? null;
  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-x-2">
      {cov != null && (
        <span
          className={cx('inline-flex items-center gap-1', cov.tone === 'bad' ? 'text-ui-danger' : cov.tone === 'ok' ? 'text-ui-success' : 'text-ui-mute')}
          title={cov.title}
        >
          {cov.running && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ai-signal-fill motion-safe:animate-pulse" />}
          {cov.label}
        </span>
      )}
      {cov != null && cov.stale && currency != null && (
        <span className="text-ui-mute" title={currency.title}>
          {currency.label}
        </span>
      )}
      {state?.checkedAt != null && <ReviewedAgo at={state.checkedAt} className="text-meta max-xl:hidden" />}
      {ready && !running && (
        <button
          type="button"
          disabled={starting}
          onClick={() => start.mutate({ prId, ident })}
          title="Check this ticket against all its PRs"
          className="inline-flex h-6 items-center gap-1 rounded-ui px-1.5 font-medium text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-60 touch:h-10"
        >
          <SparkleIcon size={11} className="text-ai-signal" />
          {starting ? 'Starting…' : cov == null ? 'Check story' : 'Re-check'}
        </button>
      )}
      {refused != null && <span className="text-ui-danger">{refusalSentence(refused)}</span>}
      {start.isError && <span className="text-ui-danger">Could not start the check.</span>}
    </span>
  );
}

// ---- the side panel's body ----

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-7 items-start gap-3 py-1">
      <dt className="w-24 shrink-0 pt-px text-meta text-ui-faint">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 text-body text-ui-ink">{children}</dd>
    </div>
  );
}

function PrPanelBody({ entry, data, onJump }: { entry: Entry; data: OpenPrsRowsData; onJump: (stackId: string) => void }): JSX.Element {
  const { pr } = entry;
  const author = pr.authorId != null ? data.usersById.get(pr.authorId) : undefined;
  const lead = leadStatus(pr);
  const ci = ciStatusIcon(pr.ciStatus);
  const review = reviewStanding(pr);
  const threads = threadChipLabel(pr.threadCounts);
  const tickets = data.ticketsOf(pr);
  const openStory = useOpenStory();
  const ticketRunning =
    data.ticketReviewOn && tickets.some((t) => t.ident != null && data.ticketStates.get(t.ident)?.status === 'running');
  return (
    <div className="space-y-5 pt-1">
      <dl className="m-0">
        <Fact label="Can it land">
          <StatusIcon tone={lead.tone} icon={lead.icon} label={lead.label} />
          {lead.detail != null && <p className="m-0 mt-0.5 text-meta text-ui-mute">{lead.detail}</p>}
        </Fact>
        <Fact label="Checks">
          {ci != null ? <StatusIcon tone={ci.tone} icon={ci.icon} label={ci.label} /> : <span className="text-ui-mute">No checks</span>}
        </Fact>
        <Fact label="Reviews">
          {review != null ? <StatusIcon tone={review.tone} icon={review.icon} label={review.label} /> : <span className="text-ui-mute">No approval yet</span>}
        </Fact>
        <Fact label="Threads">
          {threads != null ? (
            <span className={'inline-flex items-center gap-2 text-ui-ink'} title="Review threads: untouched · replied · likely addressed · resolved">
              <ThreadStateBar counts={pr.threadCounts} compact className="!w-10" />
              {threads.text}
            </span>
          ) : (
            <span className="text-ui-mute">No review threads</span>
          )}
        </Fact>
        {data.claudeOn && (
          <AiWorkFact prId={pr.id} state={data.claudeStates.get(pr.id)} ciRunning={data.ciStates.get(pr.id)?.status === 'running'} ticketRunning={ticketRunning} />
        )}
      </dl>

      {(tickets.length > 0 || entry.alsoIn.length > 0) && (
        <section>
          <h3 className="mb-1 text-meta text-ui-faint">Tickets</h3>
          <ul className="m-0 list-none space-y-0.5 p-0">
            {tickets.map((t) => {
              const href = safeExternalUrl(t.url);
              const body = (
                <>
                  <TicketIcon size={12} className="shrink-0 text-ui-faint" />
                  <span className="shrink-0 font-mono text-meta text-ui-mute">{t.key}</span>
                  {t.title != null && <span className="min-w-0 truncate">{t.title}</span>}
                </>
              );
              const cls = 'flex min-h-7 w-full min-w-0 items-center gap-2 rounded-ui px-1 text-left text-body hover:bg-ui-hover touch:min-h-10';
              return (
                <li key={t.key}>
                  {t.ident != null ? (
                    <button type="button" className={cls} title={`Open the ${t.key} story`} onClick={() => openStory({ ident: t.ident as string, key: t.key, title: t.title ?? null })}>
                      {body}
                    </button>
                  ) : href != null ? (
                    <a href={href} target="_blank" rel="noreferrer noopener" className={cls} title={`Open ${cardTicketLabel(t)}`}>
                      {body}
                    </a>
                  ) : (
                    <span className={cls}>{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {entry.alsoIn.length > 0 && (
            <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-meta text-ui-mute">
              Also in
              {entry.alsoIn.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => onJump(`ticket:${t.key}`)}
                  title={`Go to ${cardTicketLabel(t)}`}
                  className="rounded-ui px-1 font-mono text-ui-ink hover:bg-ui-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:min-h-10"
                >
                  {t.key}
                </button>
              ))}
            </p>
          )}
        </section>
      )}

      <section>
        <h3 className="mb-1 text-meta text-ui-faint">Pull request</h3>
        <dl className="m-0">
          <Fact label="Author">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Avatar user={author} size={16} />
              <span className="truncate">{userLabel(author, pr.authorId)}</span>
            </span>
          </Fact>
          <Fact label="Opened">
            <span title={dateTime(pr.openedAt)}>{relativeTime(pr.openedAt)}</span>
          </Fact>
          {pr.updatedAt !== pr.openedAt && (
            <Fact label="Updated">
              <span title={dateTime(pr.updatedAt)}>{relativeTime(pr.updatedAt)}</span>
            </Fact>
          )}
          <Fact label="Size">
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{filesLabel(pr.changedFiles)}</span>
              <span className="font-mono text-meta text-ui-mute">
                +{pr.additions} −{pr.deletions}
              </span>
              <LargePrFlag pr={pr} />
            </span>
          </Fact>
          <Fact label="Reach">
            <BlastRadiusChip pr={pr} expandable />
          </Fact>
        </dl>
      </section>

      {data.claudeOn && (
        <section>
          <h3 className="mb-1.5 text-meta text-ui-faint">AI review</h3>
          <ClaudeReviewPanel
            prId={pr.id}
            state={data.claudeStates.get(pr.id)}
            ciState={data.ciStates.get(pr.id)}
            teamClaimSkip={data.teamClaimSkips.get(pr.id) ?? null}
            onOpenReview={() => data.onOpenReview(pr)}
            onOpenFix={() => data.onOpenFix(pr)}
            ticketPills={data.ticketReviewOn ? cardTicketPills(tickets, data.ticketStates, entry.ticketKey) : []}
          />
        </section>
      )}
    </div>
  );
}

/** "Reviewing · Checking CI" while AI works on the PR (the old card's work chip); nothing otherwise —
 *  the review's own state is the AI review panel below. */
function AiWorkFact({ prId, state, ciRunning, ticketRunning }: { prId: number; state: ClaudeReviewPrState | undefined; ciRunning: boolean; ticketRunning: boolean }): JSX.Element | null {
  const starting = useClaudeReviewStarting(prId);
  const aiName = useAiProviderName();
  const work = reviewWorkInProgress({ review: state, starting, ciRunning, ticketRunning });
  if (work.length === 0) return null;
  return (
    <Fact label="AI working">
      <span className="inline-flex items-center gap-1.5 text-ai-signal" title={`${aiName} is working on this PR`}>
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ai-signal-fill motion-safe:animate-pulse" />
        {work.join(' · ')}
      </span>
    </Fact>
  );
}
