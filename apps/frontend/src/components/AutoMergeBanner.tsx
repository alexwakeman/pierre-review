import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ArmedMergePhase,
  ArmedMergeRequest,
  ArmedMergeState,
} from '@pierre-review/shared';
import { useArmedMerges, useDisarmAutoMerge } from '../hooks/useAutoMerge.js';
import { invalidateAfterPrWrite } from '../hooks/prCacheSync.js';
import { usePinnedTabs, type TabMeta } from '../store/pinnedTabs.js';
import { MergeIcon } from './Icons.js';
import { dateTime, relativeTime } from '../lib/ui.js';
import { HeaderToast, ToastFooterButton, ToastList, ToastShowMore } from './HeaderToasts.js';

// The global auto-merge progress stack, rendered as ONE card in the app's ONE toast cluster
// (HeaderToasts.tsx, mounted in App.tsx): a one-line summary, the rows when it expands.
//
// ONE CARD PER MERGE, FOR THE WHOLE LIFECYCLE. Arming used to produce nothing global at all
// and, up to a poll later, a separate terminal toast — two unrelated surfaces for one action.
// A row now appears the moment the user arms (the arm mutation seeds the list cache), tracks
// the watcher's `phase` while it runs, and is REPLACED IN PLACE by its outcome. There is no
// second toast for a PR this stack was already showing.
//
// Live rows are derived straight from the polled list, so a disarm (which deletes the row)
// removes the card immediately. Outcomes are captured as local state on the transition,
// because the list keeps resolved rows for 24h and a page load must not open with a merged
// card from two hours ago — the FIRST poll seeds a silent baseline, exactly as before.

// How many rows the card draws before collapsing the rest into a "Show N more" control (which
// reveals them all inside the expanded panel). Its own bounded height: the stack is an indicator
// in the header, not a board.
const MAX_ROWS = 4;

// The live sub-state, in the user's words. `phase` is the watcher's enum; `lastReason` carries
// the specifics (which branch, which position, which error) and rides along underneath, so
// nothing here needs to name a branch it doesn't have on the wire.
const PHASE_LABEL: Record<ArmedMergePhase, string> = {
  pending_first_check: 'Armed — waiting for the first check',
  waiting_conflicts: 'Waiting — conflicts with the base branch',
  waiting_behind: 'Waiting — behind the base branch',
  updating_rebase: 'Rebasing onto the base branch…',
  updating_merge: 'Merging the base branch in…',
  awaiting_checks: 'Checks running…',
  awaiting_review: 'Waiting for required reviews',
  blocked_protection: 'Waiting — branch protection not satisfied',
  enqueuing: 'Adding to the merge queue…',
  queued: 'In the merge queue',
  // ⚠ NOT GitHub's merge queue — Limn's own per-repo hold, so the batch lands one PR at a time
  // instead of every intent freshening against a trunk the previous merge just moved. The word
  // "queue" is deliberately absent from this line: `queued` above owns it, and the two are
  // different queues on different sides of the network. `queuedLocalHeadline` refines it with
  // the position when the row carries one.
  queued_local: 'Waiting its turn on this repo',
  merging: 'Merging…',
  retrying: 'Retrying after a GitHub error',
  // The back-off: checks failed once, so Limn stops trying until they pass. A wait, never a
  // spinner — nothing is being attempted.
  checks_failed: 'Waiting for checks to pass',
};

/**
 * The `queued_local` headline, given what the row knows about its place in the repo's landing
 * order. `queuePosition`/`queueDepth`/`yieldedForFailedChecks` are TRAILING OPTIONALS on the
 * wire, so every branch here degrades to the plain label rather than rendering a hole — a row
 * from a backend that predates them, or a `viaMergeQueue` intent, simply has none of them.
 *
 * The repo is not named: `RowHeader` above already carries `owner/name` for this very row.
 */
function queuedLocalHeadline(row: ArmedMergeRequest): string {
  if (row.yieldedForFailedChecks) return 'Waiting — checks failed, letting the next PR through';
  // ⚠ A WAIT NEEDS SOMEBODY AHEAD — `position > 1`, checked here rather than assumed. The two
  // halves of this row are read at different times: `phase` is whatever the watcher last STORED
  // (up to a full tick, two minutes, ago) while `queuePosition`/`queueDepth` are recomputed LIVE
  // on every request. The slot-holder merging inside the same tick that parked this row is the
  // ordinary case, and it left the card reading "Waiting its turn — 1 of 1 on this repo" — a
  // queue of one, with the row itself at the head of it — until the watcher next looked.
  if (row.queuePosition != null && row.queueDepth != null && row.queuePosition > 1) {
    return `Waiting its turn — ${row.queuePosition} of ${row.queueDepth} on this repo`;
  }
  // Position 1 with a stored `queued_local`: its turn has already come and the watcher simply
  // hasn't looked yet. Neutral, and never a count.
  if (row.queuePosition === 1) return 'Next up on this repo';
  // No position at all — a client-side row that predates the fields, or the one tick a
  // queue-disabled intent spends taking its place in the landing order. The plain label is the
  // honest one: it IS waiting a turn, we just can't say which.
  return PHASE_LABEL.queued_local;
}

/**
 * WHERE A LIVE ARMED INTENT STANDS, in one sentence — THE ONE spelling, shared by this stack and
 * by the Pending board's merge row (`PendingMergeActions`). Two surfaces describing the same
 * intent must not phrase it two ways; that is the same rule `myTurnCapDisclosure` enforces for
 * the cap and `KIND_LABEL` for the kinds.
 *
 * Like `queuedLocalHeadline` it never names the repo — both callers already print `owner/name`
 * for the row above it — and a phase the watcher could not honestly characterise comes back as
 * the truthful "Waiting…", never a hole.
 */
/** WHO ARMED IT, when it was not a person — THE one spelling, shown under the headline on the PR's
 *  merge control and the Pending card, and in the row's tooltip in this stack (one status per row). */
export const ARMED_BY_POLICY_LABEL = 'Armed automatically (dependency setting)';

export function armedPhaseHeadline(row: ArmedMergeRequest): string {
  if (row.phase === 'queued_local') return queuedLocalHeadline(row);
  return row.phase != null ? PHASE_LABEL[row.phase] : 'Waiting…';
}

// TERMINALS RENDER OFF `state`, NEVER off `lastReason` — the watcher NULLs the reason on a
// successful merge, so a card whose body is the reason line goes blank at the exact moment it
// should read "Merged".
// EXPORTED so the PR pane's "Auto-merge" row uses the same headline the banner does — the
// `armedPhaseHeadline` rule (one spelling per fact) applied to the terminal half.
export const TERMINAL_LABEL: Partial<Record<ArmedMergeState, string>> = {
  merged: 'Merged automatically',
  disarmed_head_moved: 'Auto-merge disarmed — the branch moved',
  disarmed_blocked: 'Auto-merge stopped',
  expired: 'Auto-merge expired',
  failed: 'Auto-merge failed',
};

// WHERE THE BASELINE LIVES BETWEEN PAGE LOADS.
//
// Per-viewer, per-browser, and worth nothing to anyone else — which is exactly what
// localStorage is for (CLAUDE.md's rule: a lightweight per-viewer convenience, wrapped in
// try/catch, correct when it comes back empty). An empty read degrades to the old behaviour: a
// silent first poll. It is deliberately NOT a server field: what this browser has already told
// this reader is a fact about this browser.
const SEEN_STATES_KEY = 'limn.autoMerge.seenStates.v1';

function readSeenStates(): Map<number, ArmedMergeState> | null {
  try {
    const raw = localStorage.getItem(SEEN_STATES_KEY);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out = new Map<number, ArmedMergeState>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(k);
      // ⚠ ONLY 'armed' IS SEEDED BACK. A terminal state read out of storage would let the fold
      // believe it had already reported an outcome it never showed; the only thing this map has
      // to remember across a reload is which PRs were still in flight when we looked away.
      if (Number.isFinite(id) && v === 'armed') out.set(id, 'armed');
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

function writeSeenStates(next: ReadonlyMap<number, ArmedMergeState>): void {
  try {
    const armed: Record<string, ArmedMergeState> = {};
    for (const [prId, state] of next) if (state === 'armed') armed[String(prId)] = state;
    localStorage.setItem(SEEN_STATES_KEY, JSON.stringify(armed));
  } catch {
    // A private window, blocked site data, or a thumbnail capture that throws on access. The
    // baseline then behaves exactly as it did before this existed.
  }
}

// One finished intent, snapshotted at the transition: the list row itself ages out after 24h
// and we want the card to outlive that, not to re-derive from a row that may be gone.
interface Outcome {
  /** This CAPTURE's identity — the React key and the dismissal key. See `nextOutcomeId`. */
  id: string;
  prId: number;
  state: ArmedMergeState;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  reason: string | null;
  /** When it finished (ISO-8601) — the row's "time since". The watcher's terminal write stamps
   *  `lastCheckedAt`, so that is the finish time; "now" only when the row carries none. ⚠ Never
   *  "when this tab saw it": after a reload the persisted baseline surfaces an hours-old outcome,
   *  which would read "just now". */
  at: string;
}

// ⚠ EVERY CAPTURE GETS ITS OWN IDENTITY, and it is NOT `${prId}:${state}`. A PR reaches the same
// terminal state twice all the time — arm, a teammate pushes ('disarmed_head_moved'), re-arm on
// the new head, the branch moves again — and the whole run happens inside the 24h the list keeps
// resolved rows for. Keying on the pair gave those two captures ONE React key (a duplicate-key
// warning and two rows for one PR) and let the first dismissal permanently suppress the second
// run's news, which is exactly the contract this key was written to protect: a re-arm must show
// its own outcome. The counter is per page load — the same lifetime as `outcomes`/`dismissed`,
// which are local state and start empty on every load.
let outcomeSeq = 0;
const nextOutcomeId = (): string => `o${++outcomeSeq}`;

/**
 * The pure half of one poll: which armed intents just RESOLVED, whose older outcome rows those
 * (or a re-arm) supersede, and whether anything actually landed on GitHub.
 *
 * Split out from the effect so it can be unit-tested — the component owns the refs and the
 * state, this owns the rules.
 */
export interface ArmedPollFold {
  /** Newly captured outcomes, newest-first within this poll. */
  fresh: Outcome[];
  /** PR ids whose PREVIOUSLY captured outcome is now stale news and must be dropped. */
  superseded: Set<number>;
  /** At least one intent transitioned into 'merged' — the PR state really changed on GitHub. */
  landed: boolean;
}

export function foldArmedPoll(
  prev: ReadonlyMap<number, ArmedMergeState>,
  requests: readonly ArmedMergeRequest[],
  nowMs: number = Date.now(),
): ArmedPollFold {
  const fresh: Outcome[] = [];
  const superseded = new Set<number>();
  let landed = false;
  for (const r of requests) {
    const before = prev.get(r.prId);
    // A transition INTO a terminal state, from a state we previously saw as armed. An intent
    // we've never seen before (armed and resolved between two polls) is skipped deliberately:
    // without a prior 'armed' observation we can't tell it apart from a row that was already
    // resolved when this tab loaded.
    if (before === 'armed' && r.state !== 'armed' && TERMINAL_LABEL[r.state]) {
      fresh.push({
        id: nextOutcomeId(),
        prId: r.prId,
        state: r.state,
        repoFullName: `${r.repoOwner}/${r.repoName}`,
        prNumber: r.prNumber,
        prTitle: r.prTitle,
        reason: r.lastReason,
        at: r.lastCheckedAt ?? new Date(nowMs).toISOString(),
      });
      if (r.state === 'merged') landed = true;
    }
    // ONE CARD PER MERGE, FOR THE WHOLE LIFECYCLE: a PR that is armed AGAIN (or that just
    // produced a newer outcome) must not keep a row from its previous run on screen next to
    // its live one — the older terminal stopped being news the moment the user re-armed.
    if (r.state === 'armed') superseded.add(r.prId);
  }
  for (const f of fresh) superseded.add(f.prId);
  return { fresh, superseded, landed };
}

// PrDetail backfills the author chrome via usePinnedTabs.syncMeta once its detail query lands,
// so the identity the armed row carries is enough to open the tab.
function tabMetaOf(row: {
  prId: number;
  prNumber: number;
  prTitle: string;
  repoFullName: string;
}): TabMeta {
  return {
    id: row.prId,
    number: row.prNumber,
    title: row.prTitle,
    repoFullName: row.repoFullName,
    authorLogin: null,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// ── ONE ROW PER ARMING ──────────────────────────────────────────────────────────────────────────
//
// Each row is the PR, ONE status in plain words, and the time since that arming (or since its
// outcome landed), in aligned columns: [dot] [repo#n title] [status] [time] [Cancel | Dismiss].
// ⚠ ONE STATUS, never a phase line plus a reason line: the two said the same thing twice ("Waiting
// for checks to pass" over "checks failed — waiting for them to pass"). The watcher's prose
// (`lastReason`) is only ever the short tail of a "Stopped:"/"Failed:" status and the row's tooltip.

export type MergeRowTone = 'working' | 'waiting' | 'blocked' | 'good' | 'bad';

export interface MergeRowStatus {
  text: string;
  tone: MergeRowTone;
}

/** The watcher's prose, cut to a status tail: no "github:" / "waiting:" prefix, first clause only. */
export function shortMergeReason(reason: string | null, max = 48): string | null {
  if (reason == null) return null;
  let r = reason.trim().replace(/^(github|waiting):\s*/i, '');
  r = r.split(/\s+[—–]\s+|;\s+|\n/)[0]!.trim();
  if (r.length === 0) return null;
  if (r.length > max) r = `${r.slice(0, max - 1).trimEnd()}…`;
  return r;
}

/** A LIVE intent's one status. */
export function liveMergeStatus(row: ArmedMergeRequest): MergeRowStatus {
  switch (row.phase) {
    case 'pending_first_check':
      return { text: 'Armed — first check soon', tone: 'waiting' };
    case 'awaiting_checks':
      return { text: 'Waiting for CI', tone: 'waiting' };
    case 'awaiting_review':
      return { text: 'Blocked: needs approval', tone: 'blocked' };
    case 'blocked_protection':
      return { text: 'Blocked: branch protection', tone: 'blocked' };
    case 'waiting_conflicts':
      return { text: 'Blocked: conflicts', tone: 'blocked' };
    case 'waiting_behind':
      return { text: 'Blocked: behind base branch', tone: 'blocked' };
    case 'checks_failed':
      return { text: 'Blocked: checks failed', tone: 'blocked' };
    case 'updating_rebase':
    case 'updating_merge':
      return { text: 'Updating the branch', tone: 'working' };
    case 'enqueuing':
      return { text: 'Adding to merge queue', tone: 'working' };
    case 'queued':
      return { text: 'In the merge queue', tone: 'waiting' };
    case 'merging':
      return { text: 'Merging', tone: 'working' };
    case 'retrying':
      return { text: 'Retrying after a GitHub error', tone: 'blocked' };
    case 'queued_local':
      if (row.yieldedForFailedChecks) return { text: 'Blocked: checks failed', tone: 'blocked' };
      // ⚠ A wait needs somebody ahead (`position > 1`) — see `queuedLocalHeadline`.
      if (row.queuePosition != null && row.queueDepth != null && row.queuePosition > 1) {
        return { text: `Waiting its turn (${row.queuePosition} of ${row.queueDepth})`, tone: 'waiting' };
      }
      if (row.queuePosition === 1) return { text: 'Next up', tone: 'waiting' };
      return { text: 'Waiting its turn', tone: 'waiting' };
    default:
      return { text: 'Waiting', tone: 'waiting' };
  }
}

/** A FINISHED intent's one status — off `state`, never off `lastReason` (NULL at success). */
export function outcomeMergeStatus(state: ArmedMergeState, reason: string | null): MergeRowStatus {
  const why = shortMergeReason(reason);
  switch (state) {
    case 'merged':
      return { text: 'Merged', tone: 'good' };
    case 'disarmed_head_moved':
      return { text: 'Stopped: the branch moved', tone: 'bad' };
    case 'expired':
      return { text: 'Expired', tone: 'bad' };
    case 'disarmed_blocked':
      return { text: why != null ? `Stopped: ${why}` : 'Stopped', tone: 'bad' };
    case 'failed':
      return { text: why != null ? `Failed: ${why}` : 'Failed', tone: 'bad' };
    default:
      return { text: 'Finished', tone: 'bad' };
  }
}

const DOT: Record<MergeRowTone, string> = {
  working: 'animate-pulse bg-ui-accent-fill',
  waiting: 'bg-ui-accent-fill',
  blocked: 'bg-ui-warn',
  good: 'bg-ui-success',
  bad: 'bg-ui-danger',
};

const STATUS_INK: Record<MergeRowTone, string> = {
  working: 'text-ui-ink',
  waiting: 'text-ui-mute',
  blocked: 'text-ui-ink',
  good: 'text-ui-success',
  bad: 'text-ui-danger',
};

/** Re-render every 30s, so "3 min ago" stays true while the panel is open. */
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
}

// The columns every row shares, so status and time line up down the list.
const ROW_GRID =
  'grid grid-cols-[0.5rem_minmax(0,1fr)_minmax(0,14rem)_5rem_4.75rem] items-center gap-x-3';

/** One arming: the PR (click opens it), its status, the time since, and its one action. */
function MergeRow({
  repoFullName,
  prNumber,
  prTitle,
  status,
  at,
  atWords,
  detail,
  onOpen,
  action,
}: {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  status: MergeRowStatus;
  at: string;
  /** What the time measures ("Armed", "Finished"), for the tooltip. */
  atWords: string;
  /** The full prose for the tooltip (the watcher's reason, who armed it). */
  detail: string | null;
  onOpen: () => void;
  action: ReactNode;
}): JSX.Element {
  useMinuteTick();
  const repoName = repoFullName.split('/').pop() ?? repoFullName;
  return (
    <li className={`${ROW_GRID} px-3 py-1.5 text-meta leading-snug`} data-testid="auto-merge-row">
      <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[status.tone]}`} />
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${repoFullName} #${prNumber}`}
        className="hit flex min-w-0 items-baseline gap-1.5 rounded-ui text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
      >
        <span className="shrink-0 tabular-nums text-ui-mute">
          {repoName}#{prNumber}
        </span>
        <span className="truncate text-ui-ink">{prTitle}</span>
      </button>
      <span className={`truncate ${STATUS_INK[status.tone]}`} title={detail ?? status.text}>
        {status.text}
      </span>
      <time dateTime={at} title={`${atWords} ${dateTime(at)}`} className="whitespace-nowrap text-right tabular-nums text-ui-mute">
        {relativeTime(at)}
      </time>
      <span className="flex justify-end">{action}</span>
    </li>
  );
}

// A LIVE intent. Its own component so it can own the per-PR disarm mutation — Cancel is the
// stack's ONLY action. It deliberately grows no "re-arm", "update now" or "freshen" control:
// arming is consent anchored to a specific head SHA and exactly one UI path (the PR's
// MergeWhenReadyControl) may do it. Cancel goes through the DELETE route, which deletes the
// row FIRST so it beats the watcher's compare-and-set, then best-effort removes any merge-queue
// entry — a client-side "just hide it" would leave the queue to land the PR anyway.
function LiveRow({ row }: { row: ArmedMergeRequest }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const disarm = useDisarmAutoMerge(row.prId);
  const repoFullName = `${row.repoOwner}/${row.repoName}`;
  // The tooltip keeps what the one status line leaves out: the watcher's own words and who armed it.
  const detail = [row.lastReason, row.armedByPolicy ? ARMED_BY_POLICY_LABEL : null]
    .filter((p): p is string => p != null && p !== '')
    .join(' · ');
  return (
    <MergeRow
      repoFullName={repoFullName}
      prNumber={row.prNumber}
      prTitle={row.prTitle}
      status={liveMergeStatus(row)}
      at={row.armedAt}
      atWords="Armed"
      detail={detail || null}
      onOpen={() =>
        openPrDetailTab(tabMetaOf({ prId: row.prId, prNumber: row.prNumber, prTitle: row.prTitle, repoFullName }))
      }
      action={
        <button
          type="button"
          onClick={() => disarm.mutate()}
          disabled={disarm.isPending}
          aria-label={`Cancel merge when ready for ${repoFullName} #${row.prNumber}`}
          className="hit text-meta text-ui-mute hover:text-ui-danger disabled:opacity-50"
        >
          {disarm.isPending ? 'Cancelling…' : 'Cancel'}
        </button>
      }
    />
  );
}

function OutcomeRow({ outcome, onDismiss }: { outcome: Outcome; onDismiss: () => void }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  return (
    <MergeRow
      repoFullName={outcome.repoFullName}
      prNumber={outcome.prNumber}
      prTitle={outcome.prTitle}
      status={outcomeMergeStatus(outcome.state, outcome.reason)}
      at={outcome.at}
      atWords="Finished"
      detail={outcome.reason}
      onOpen={() => openPrDetailTab(tabMetaOf(outcome))}
      action={
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss the result for ${outcome.repoFullName} #${outcome.prNumber}`}
          className="hit text-meta text-ui-mute hover:text-ui-ink"
        >
          Dismiss
        </button>
      }
    />
  );
}


export function AutoMergeBanner(): JSX.Element | null {
  const { data } = useArmedMerges();
  const qc = useQueryClient();
  // prId → last observed state, SEEDED FROM localStorage and written back on every poll.
  //
  // ⚠ IT USED TO START EMPTY ON EVERY PAGE LOAD, AND THAT IS WHY INTENTS DIED IN SILENCE. The
  // fold only reports an outcome for a PR it previously saw ARMED, and this query does not poll
  // in a background tab (`refetchIntervalInBackground: false`). So: arm a PR, switch tabs or
  // reload, and the watcher's verdict — including `failed` — arrived with no prior observation
  // to compare against and was discarded. The armed panel simply vanished, which is exactly the
  // "disarmed for unknown reasons" the user reported.
  //
  // Persisting the baseline closes it: the map survives the reload, so the transition is still a
  // transition. `null` on a genuinely first visit keeps the original silent-baseline behaviour —
  // an account whose intents all resolved before this browser ever looked must not open to a
  // stack of ancient news.
  const seen = useRef<Map<number, ArmedMergeState> | null>(readSeenStates());
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const [showAll, setShowAll] = useState(false);
  const listId = useId();

  const requests: ArmedMergeRequest[] | undefined = data?.requests;

  useEffect(() => {
    if (!requests) return;
    const prev = seen.current;
    const next = new Map<number, ArmedMergeState>();
    for (const r of requests) next.set(r.prId, r.state);

    if (prev == null) {
      seen.current = next;
      writeSeenStates(next);
      return;
    }

    const { fresh, superseded, landed } = foldArmedPoll(prev, requests);
    seen.current = next;
    writeSeenStates(next);
    setOutcomes((t) => {
      const kept = t.filter((o) => !superseded.has(o.prId));
      // Same array when nothing moved: this effect runs on EVERY poll (8s while anything is
      // armed), and a fresh array identity per poll would re-render the stack for nothing.
      if (fresh.length === 0 && kept.length === t.length) return t;
      return [...fresh, ...kept].slice(0, 5);
    });
    if (landed) {
      // The PR really did merge on GitHub — the SAME set the interactive merge refetches
      // (prCacheSync.ts): its own detail, the board, the trunk strip, the maintainer shield.
      // Swept ONCE for every PR that landed between two polls.
      const landedIds = fresh.filter((o) => o.state === 'merged').map((o) => o.prId);
      void invalidateAfterPrWrite(qc, landedIds, { merged: true });
    }
  }, [requests, qc]);

  // Newest arm on top, so the row the user just created is the one they look at.
  const live = (requests ?? [])
    .filter((r) => r.state === 'armed')
    .sort((a, b) => b.armedAt.localeCompare(a.armedAt));
  const shownOutcomes = outcomes.filter((o) => !dismissed[o.id]);

  const total = shownOutcomes.length + live.length;
  if (total === 0) return null;

  // Outcomes first: they are the news, and they are the only rows that need an action from the
  // reader. Live rows below, capped — a hidden live row is still working.
  // "Show N more" lifts the cap; the expanded panel scrolls inside its own max height.
  const cap = showAll ? Infinity : MAX_ROWS;
  const outcomeRows = shownOutcomes.slice(0, cap);
  const liveRows = live.slice(0, Math.max(0, cap - outcomeRows.length));
  const hidden = total - outcomeRows.length - liveRows.length;

  const dismissAll = (): void =>
    setDismissed((prev) => {
      const next = { ...prev };
      for (const o of shownOutcomes) next[o.id] = true;
      return next;
    });

  const mergedCount = shownOutcomes.filter((o) => o.state === 'merged').length;
  const otherOutcomes = shownOutcomes.length - mergedCount;
  const summary = [
    live.length > 0 ? `${live.length} armed` : null,
    mergedCount > 0 ? `${mergedCount} merged` : null,
    otherOutcomes > 0 ? `${otherOutcomes} not merged` : null,
  ]
    .filter((p): p is string => p != null)
    .join(' · ');

  return (
    <HeaderToast
      testId="auto-merge-toast"
      tone="merge"
      label="Merge when ready"
      icon={<MergeIcon size={13} />}
      summary={summary}
      // The X clears the OUTCOMES (the old "Dismiss all"); a live row is cleared only by its own
      // Cancel, so the X is offered only once nothing is still armed.
      onDismiss={live.length === 0 ? dismissAll : undefined}
      dismissLabel="Dismiss merge-when-ready results"
      count={total}
      alert={otherOutcomes > 0}
      footer={
        <>
          <span>Auto-merge only runs while Limn is running.</span>
          <span className="flex items-center gap-3">
            <ToastShowMore
              hidden={hidden}
              showAll={showAll && total > MAX_ROWS}
              onToggle={() => setShowAll((v) => !v)}
              controls={listId}
            />
            {live.length > 0 && shownOutcomes.length > 0 && (
              <ToastFooterButton onClick={dismissAll}>Dismiss finished</ToastFooterButton>
            )}
          </span>
        </>
      }
    >
      <ToastList id={listId}>
        {outcomeRows.map((o) => (
          <OutcomeRow
            key={o.id}
            outcome={o}
            onDismiss={() => setDismissed((prev) => ({ ...prev, [o.id]: true }))}
          />
        ))}
        {liveRows.map((r) => (
          <LiveRow key={r.prId} row={r} />
        ))}
      </ToastList>
    </HeaderToast>
  );
}
