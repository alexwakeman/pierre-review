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
import { landsAfterOf } from '@pierre-review/shared';
import { useClaudeReviewStarting } from '../../hooks/useClaudeReview.js';
import { useMergedPanelOpen } from '../../hooks/useTicketMergedPrs.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { leadVerdictText, reviewCellFor, reviewWorkInProgress } from '../../lib/claudeReviewColumn.js';
import { cardTicketLabel, type CardTicket } from '../../lib/cardTickets.js';
import { cardTicketPills } from '../../lib/ticketReview.js';
import {
  CI_META,
  dateTime,
  mergeVerdict,
  mergeVerdictWarning,
  relativeTime,
  safeExternalUrl,
  userLabel,
} from '../../lib/ui.js';
import type { OpenPrsStack } from '../../lib/openPrsStacks.js';
import { githubPrUrl } from '../../lib/prLink.js';
import { useAiProviderName } from '../../hooks/useAiCapabilities.js';
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
  HEADER_ACTION_CLASS,
  SidePanel,
  StatusIcon,
  cx,
  FOCUS_RING,
  TEXT_LINK,
  useIsDesktop,
  useListKeyboard,
  useRegisterCommands,
  type Command,
  type StatusTone,
} from '../ui/index.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { DrawerAiReview, Fact } from './OpenPrsAiReview.js';
import { BlastRadiusChip } from './BlastRadiusChip.js';
import { LargePrFlag } from './LargePrFlag.js';
import { PrChips } from './PrChips.js';
import { filesLabel } from './PrCardShell.js';
import { TicketKeyButton, threadChipLabel } from './OpenPrsCards.js';
import { useFillToPaneBottom } from '../ui/stickyFill.js';

// THE OPEN PRs ROWS — Activity → Open PRs in the redesign (docs/redesign/DESIGN.md): one LINE per
// pull request, the detail in a SidePanel. OpenPrsCards still owns every read (one batched request
// per kind, the ticket gate, the sort, the stacks, the merged panels) and hands the folded answers
// here; this file only draws them. The story view and Open PRs → Merged keep the cards.
//
// THE ROW, left to right, most important first:
//   lead: can it land? (mergeVerdict — red conflicts/blocked, green ready, grey otherwise, Draft)
//   title · repo#N (· the ticket key in List)
//   review standing · CI · open threads (count) · the AI review as ONE quiet marker · size (+A −D) ·
//   author · age — each a FIXED-WIDTH column under a heading row (`openPrsColumns`, ONE spec for the
//   headings and the rows, so a review tick and a CI tick never share a place).
// Every icon carries its words as the tooltip and the accessible name. Every fact the old card
// said is in the SIDE PANEL, in words (status list, tickets, meta, reach, the AI review panel).
//
// KEYS (useListKeyboard): j/k move, ↵ opens the panel and, with the panel open, the pull request;
// `o` opens it on GitHub, `r` its AI review (where AI runs). Double-click opens the pull request.
// ⚠ Nothing here fetches on selection: the panel reads the list's batched answers only.
//
// GROUPED BY TICKET: one collapsible group per ticket (the collapse is the reader's, per session,
// never stored): the ticket line (chevron, key + story name → the story view, the PR count — nothing
// else; status, assignee, criteria and Re-check are in the story view), its rows, then "Merged (n)".

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
  /** The PR's Changes tab, on its Threads only view (the drawer's threads link). */
  onOpenThreads: (pr: TimelinePr) => void;
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
  const input = { mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft, landsAfter: landsAfterOf(pr.branchStack) };
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

// ---- the icon columns: ONE spec shared by the heading row and every PR row ----

export type OpenPrsColumnKey = 'ci' | 'review' | 'threads' | 'ai';

export interface OpenPrsColumn {
  key: OpenPrsColumnKey;
  /** The heading over the column. */
  label: string;
  /** The heading's tooltip: what the column's marks mean. */
  title: string;
  /** Fixed width in px, the same in the heading and every row, so marks never drift. */
  width: number;
  align: 'center' | 'left' | 'right';
  /** Dropped below this width (its fact is still in the side panel). */
  hideBelow: 'sm' | 'md' | 'lg' | null;
}

const COLUMNS: readonly OpenPrsColumn[] = [
  { key: 'review', label: 'Review', title: 'Approved (green) or changes requested (red)', width: 52, align: 'center', hideBelow: 'sm' },
  { key: 'ci', label: 'CI', title: 'Checks failing (red cross), passing (tick) or running (ring)', width: 36, align: 'center', hideBelow: 'sm' },
  { key: 'threads', label: 'Threads', title: 'Open review threads; a red dot means one has no reply', width: 56, align: 'center', hideBelow: 'md' },
  { key: 'ai', label: 'AI review', title: 'The AI review’s verdict; it pulses while a run works', width: 64, align: 'center', hideBelow: 'sm' },
];

/** The columns a row draws: AI review only where AI runs. The author and age sit on the row's second
 *  line and the size is in the drawer, so a row is the SAME with the drawer open or closed (nothing
 *  reflows when it opens). */
export function openPrsColumns({ claudeOn }: { claudeOn: boolean }): OpenPrsColumn[] {
  return COLUMNS.filter((c) => c.key !== 'ai' || claudeOn);
}

const HIDE_BELOW: Record<'sm' | 'md' | 'lg', string> = { sm: 'max-sm:hidden', md: 'max-md:hidden', lg: 'max-lg:hidden' };
const ALIGN: Record<OpenPrsColumn['align'], string> = { center: 'justify-center', left: 'justify-start', right: 'justify-end' };

/** One fixed-width cell of a column (heading or row). */
function ColCell({ col, className, children, title }: { col: OpenPrsColumn; className?: string; children?: ReactNode; title?: string }): JSX.Element {
  return (
    <span
      className={cx('flex shrink-0 items-center', ALIGN[col.align], col.hideBelow != null && HIDE_BELOW[col.hideBelow], className)}
      style={{ width: col.width }}
      title={title}
    >
      {children}
    </span>
  );
}

/** The heading row over the PR rows: the same paddings, gaps and cells as `PrRow`. */
function ColumnHeadings({ columns }: { columns: readonly OpenPrsColumn[] }): JSX.Element {
  return (
    <div
      data-testid="open-prs-headings"
      className="-mx-1 flex h-7 items-center gap-3 border-b border-ui-line px-3 text-meta text-ui-mute"
    >
      <span aria-hidden className="w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Pull request</span>
      {columns.map((c) => (
        // The label truncates INSIDE the cell: a right-aligned flex cell that clipped would cut the
        // label's first letters ("Jpdated"), not its tail.
        <ColCell key={c.key} col={c} title={c.title}>
          <span className="min-w-0 truncate">{c.label}</span>
        </ColCell>
      ))}
    </div>
  );
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
    // A teammate's newer posted review leads: "AI review: Robin · Approve".
    label = `AI review: ${leadVerdictText(cell)}${cell.headMoved ? ' · newer commits since' : ''}`;
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
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const panelHeight = useFillToPaneBottom(panelEl, docked && panelOpen);
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

  // A press outside the docked drawer and outside every PR row closes it. The row stays selected (the
  // "last viewed" highlight) and the list takes keyboard focus, so j/k and Enter carry on from there.
  const closeAndKeepRow = useCallback((): void => {
    setPanelOpen(false);
    listRef.current?.focus({ preventScroll: true });
  }, []);
  const outsideOpen = docked && panelOpen && selected != null;
  useEffect(() => {
    if (!outsideOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !pressClosesDrawer(e, panelEl, listRef.current, moreRef.current)) return;
      setPanelOpen(false);
      // Focus moves on the press itself (a mousedown on a plain area blurs to <body>), so give the list
      // focus once the press is over — unless the press focused a control of its own (a filter input).
      const done = (): void => {
        window.removeEventListener('pointerup', done, true);
        window.removeEventListener('pointercancel', done, true);
        requestAnimationFrame(() => {
          const a = document.activeElement;
          if (a == null || a === document.body || a === document.documentElement) closeAndKeepRow();
        });
      };
      window.addEventListener('pointerup', done, true);
      window.addEventListener('pointercancel', done, true);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [outsideOpen, panelEl, closeAndKeepRow]);

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
      { id: 'open', group: 'Actions', title: `View PR ${label}`, hint: selected.pr.title, shortcut: '↵', icon: <PullRequestIcon size={14} />, run: () => openPr(selected) },
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
      onClose={closeAndKeepRow}
      title={selected?.pr.title ?? ''}
      subtitle={selected != null ? `${props.repoNameById.get(selected.pr.repoId) ?? `repo ${selected.pr.repoId}`}#${selected.pr.number}` : undefined}
      testId="open-prs-panel-detail"
      className={docked ? 'sticky top-0 self-start rounded-ui' : undefined}
      // Docked, it fills from where it sits to the pane's bottom (its footer must stay on screen).
      panelRef={setPanelEl}
      style={docked && panelHeight != null ? { height: panelHeight } : undefined}
      headerActions={
        selected != null && githubOf(selected) != null ? (
          <CopyButton
            text={githubOf(selected) as string}
            what="PR link"
            title="Copy the GitHub link to this PR"
            icon={<LinkIcon size={14} />}
            className={HEADER_ACTION_CLASS}
          />
        ) : null
      }
      footer={
        selected != null ? (
          <>
            <Button variant="primary" kbd="↵" icon={<PullRequestIcon size={13} />} onClick={() => openPr(selected)}>
              View PR
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
        {(stacks != null ? stacks.length > 0 : drawn.length > 0) && <ColumnHeadings columns={openPrsColumns({ claudeOn: props.claudeOn })} />}
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
      {/* Docked, the drawer's column is ALWAYS there (2026-11-03): with no PR open it holds one quiet
          line, so opening or closing the drawer never moves the list's columns. */}
      {docked && !(panelOpen && selected != null) && (
        <div
          data-testid="open-prs-panel-reserved"
          className="sticky top-0 w-panel shrink-0 self-start rounded-ui border border-dashed border-ui-line px-5 py-4 text-meta text-ui-faint"
        >
          Select a pull request to see it here.
        </div>
      )}
    </div>
  );
}

/**
 * Does this press, while the drawer is docked open, close it? Not when it lands in the drawer, on a PR
 * row, on a control inside the list (a group's fold, a ticket link), on "Show more", in a popover or
 * menu portalled out of the drawer (`data-floating-layer` — the toast cluster carries it too, so an
 * Undo press keeps the drawer), in a modal, in the top bar, or on a scrollbar.
 */
export function pressClosesDrawer(
  e: Pick<PointerEvent, 'target' | 'clientX' | 'clientY'>,
  panel: HTMLElement | null,
  list: HTMLElement | null,
  more: HTMLElement | null,
): boolean {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  if (!t.isConnected) return false;
  if (panel?.contains(t) || more?.contains(t)) return false;
  if (t.closest('[data-floating-layer],[aria-modal="true"],[role="dialog"],[data-shell-topbar]') != null) return false;
  if (list?.contains(t) && t.closest('[role="option"],a,button,input,select,textarea,label,summary') != null) return false;
  // A press on a scroll container's scrollbar targets the container itself.
  if (t instanceof HTMLElement) {
    const r = t.getBoundingClientRect();
    if (t.clientWidth > 0 && e.clientX >= r.left + t.clientLeft + t.clientWidth && e.clientX <= r.right) return false;
    if (t.clientHeight > 0 && e.clientY >= r.top + t.clientTop + t.clientHeight && e.clientY <= r.bottom) return false;
  }
  return true;
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
  const columns = openPrsColumns({ claudeOn: data.claudeOn });
  return (
    <Row listId={listId} index={index} selected={selected} onSelect={onSelect} className="select-none !h-auto min-h-row py-1.5">
      <span className="contents" onDoubleClick={onDoubleOpen}>
        <RowLead>
          <StatusIcon tone={lead.tone} icon={lead.icon} label={lead.label} iconOnly title={lead.detail != null ? `${lead.label}: ${lead.detail}` : lead.label} />
        </RowLead>
        {/* Two lines, drawer open or closed: the title, then repo#N · author · age. */}
        <span data-testid="open-prs-row-two-line" className="flex min-w-0 flex-1 flex-col">
          <span className={cx('min-w-0 truncate', pr.isDraft ? 'text-ui-mute' : 'text-ui-ink')} title={pr.title}>
            {pr.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-meta text-ui-faint">
            <span className="min-w-0 shrink-[4] truncate" title={`${repo}#${pr.number}`}>
              {pr.isDraft && 'Draft · '}
              {repoShort(repo)}#{pr.number}
              {tickets[0] != null && ` · ${tickets[0].key}${tickets.length > 1 ? ` +${tickets.length - 1}` : ''}`}
            </span>
            <span aria-hidden>·</span>
            <Avatar user={author} size={12} />
            {/* The author and age keep their room; the repo label gives way first. */}
            <span className="max-w-[12rem] shrink-0 truncate text-ui-mute">{userLabel(author, pr.authorId)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums" title={`Updated ${dateTime(activity)} · opened ${dateTime(pr.openedAt)}`}>
              {shortAge(activity)}
            </span>
            {/* PR chips as text: the row is the control, so no nested button (the drawer has them). */}
            <PrChips pr={pr} interactive={false} className="shrink-0" />
          </span>
        </span>
        {columns.map((col) => {
          switch (col.key) {
            case 'ci':
              return <ColCell key={col.key} col={col}>{ci != null && <StatusIcon tone={ci.tone} icon={ci.icon} label={ci.label} iconOnly />}</ColCell>;
            case 'review':
              return <ColCell key={col.key} col={col}>{review != null && <StatusIcon tone={review.tone} icon={review.icon} label={review.label} iconOnly />}</ColCell>;
            case 'threads':
              // ONE grey number; an untouched thread adds a small red dot, never an amber count.
              return (
                <ColCell
                  key={col.key}
                  col={col}
                  className="gap-1 text-meta tabular-nums text-ui-faint"
                  title={threads != null ? `Review threads: ${threads.text}` : undefined}
                >
                  {threads != null && openThreads > 0 && (
                    <>
                      <ThreadsIcon size={12} aria-hidden />
                      <span className="sr-only">Review threads: {threads.text}</span>
                      <span aria-hidden>{openThreads}</span>
                      {pr.threadCounts.untouched > 0 && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ui-danger" />}
                    </>
                  )}
                </ColCell>
              );
            case 'ai':
              return (
                <ColCell key={col.key} col={col}>
                  <AiMarker
                    prId={pr.id}
                    state={data.claudeStates.get(pr.id)}
                    ciRunning={data.ciStates.get(pr.id)?.status === 'running'}
                    ticketRunning={ticketRunning}
                  />
                </ColCell>
              );
          }
        })}
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
  const merged = data.mergedStacks.get(stack.id) ?? [];
  return (
    <li role="presentation" className="mt-5 first:mt-0">
      <div
        role="group"
        aria-labelledby={headId}
        id={groupDomId(stack.id)}
        tabIndex={-1}
        className="scroll-mt-4 rounded-ui outline-none"
      >
        {/* ONE line at every width: chevron · key + story name (→ the story view). No PR count. The
            ticket's status, assignee, criteria met and Re-check live in the story view, one click away. */}
        <div role="presentation" className="flex min-w-0 items-center gap-3 rounded-ui px-1 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
        </div>
        {/* The group's rows sit INSIDE the ticket: inset so a row's status icon lines up with the
            ticket icon (12px on a phone), with a quiet guide line under the chevron. Every row of
            the grouped list carries the same inset, so the right-hand columns still line up. */}
        {!folded && (
          <div
            data-testid="open-prs-group-body"
            className="relative pl-[22px] before:absolute before:bottom-1 before:left-[15px] before:top-0 before:w-px before:bg-ui-line max-sm:pl-3 max-sm:before:left-[5px]"
          >
            <ul role="presentation" aria-label={t != null ? `Pull requests for ${t.key}` : 'Pull requests with no ticket'} className="m-0 list-none p-0">
              {children}
            </ul>
            {complete && merged.length > 0 && <MergedRows stackId={stack.id} prs={merged} onOpen={data.onOpenMerged} />}
          </div>
        )}
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
    <div className="pt-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => toggle(stackId)}
        className="inline-flex h-7 items-center gap-1.5 rounded-ui px-3 text-meta text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10"
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
              className="flex h-row w-full min-w-0 items-center gap-3 rounded-ui px-3 text-left text-body hover:bg-ui-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ui-accent touch:h-row-touch"
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

// ---- the side panel's body ----

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
            <span className="inline-flex items-center gap-2 text-ui-ink">
              <ThreadStateBar counts={pr.threadCounts} compact className="!w-10" />
              {/* The PR's threads, every one shown (Changes → Threads only). */}
              <button
                type="button"
                onClick={() => data.onOpenThreads(pr)}
                title="Review threads: untouched · replied · likely addressed · resolved. Show them."
                className={cx('hit rounded-ui text-left', TEXT_LINK, FOCUS_RING)}
              >
                {threads.text}
              </button>
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
              // A row that goes somewhere underlines its words (the drawer's links read as links).
              const linked = t.ident != null || href != null;
              const body = (
                <>
                  <TicketIcon size={12} className="shrink-0 text-ui-faint" />
                  <span className={cx('shrink-0 font-mono text-meta text-ui-mute', t.title == null && linked && TEXT_LINK)}>{t.key}</span>
                  {t.title != null && <span className={cx('min-w-0 truncate', linked && TEXT_LINK)}>{t.title}</span>}
                </>
              );
              const cls = 'flex min-h-7 w-full min-w-0 items-center gap-2 rounded-ui px-1 text-left text-body hover:bg-ui-hover touch:min-h-10';
              return (
                <li key={t.key}>
                  {t.ident != null ? (
                    <button type="button" className={cls} title={`Open the ${t.key} ticket`} onClick={() => openStory({ ident: t.ident as string, key: t.key, title: t.title ?? null })}>
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
                  className={cx('rounded-ui px-1 font-mono text-ui-ink hover:bg-ui-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:min-h-10', TEXT_LINK)}
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
        <PrChips pr={pr} className="mt-1.5" />
      </section>

      {data.claudeOn && (
        <DrawerAiReview
          prId={pr.id}
          state={data.claudeStates.get(pr.id)}
          ciState={data.ciStates.get(pr.id)}
          teamClaimSkip={data.teamClaimSkips.get(pr.id) ?? null}
          onOpenReview={() => data.onOpenReview(pr)}
          onOpenFix={() => data.onOpenFix(pr)}
          ticketPills={data.ticketReviewOn ? cardTicketPills(tickets, data.ticketStates, entry.ticketKey) : []}
        />
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
