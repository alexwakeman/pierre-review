import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ArmedMergePhase,
  ArmedMergeRequest,
  ArmedMergeState,
} from '@pierre-review/shared';
import { useArmedMerges, useDisarmAutoMerge } from '../hooks/useAutoMerge.js';
import { usePinnedTabs, type TabMeta } from '../store/pinnedTabs.js';
import { CheckIcon, WarningIcon } from './Icons.js';

// The global auto-merge progress stack, rendered as a plain card inside App.tsx's ONE shared
// fixed bottom-right toast column (which owns position/width/z and pointer-events-none; the
// card re-enables its own). Same shape as ClaudeReviewBanner.
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

// How many rows the card draws before collapsing the rest into a "+N more" line. Its own
// bounded height: the stack is an indicator in the corner, not a board.
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
export function armedPhaseHeadline(row: ArmedMergeRequest): string {
  if (row.phase === 'queued_local') return queuedLocalHeadline(row);
  return row.phase != null ? PHASE_LABEL[row.phase] : 'Waiting…';
}

// Phases where Limn (or GitHub) is actively doing something right now, as opposed to waiting
// on a human or a check — the only ones that earn a spinner.
const WORKING_PHASES: ReadonlySet<ArmedMergePhase> = new Set<ArmedMergePhase>([
  'updating_rebase',
  'updating_merge',
  'enqueuing',
  'merging',
]);

// Phases where the intent is parked on something outside our control. Amber, not "in flight".
const STALLED_PHASES: ReadonlySet<ArmedMergePhase> = new Set<ArmedMergePhase>([
  'waiting_conflicts',
  'waiting_behind',
  'blocked_protection',
  'retrying',
]);

// TERMINALS RENDER OFF `state`, NEVER off `lastReason` — the watcher NULLs the reason on a
// successful merge, so a card whose body is the reason line goes blank at the exact moment it
// should read "Merged".
const TERMINAL_LABEL: Partial<Record<ArmedMergeState, string>> = {
  merged: 'Merged automatically',
  disarmed_head_moved: 'Auto-merge disarmed — the branch moved',
  disarmed_blocked: 'Auto-merge stopped',
  expired: 'Auto-merge expired',
  failed: 'Auto-merge failed',
};

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

function StatusDot({
  tone,
}: {
  tone: 'working' | 'waiting' | 'stalled' | 'good' | 'bad';
}): JSX.Element {
  if (tone === 'working') {
    return (
      <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
    );
  }
  const color =
    tone === 'good'
      ? 'bg-green-500'
      : tone === 'bad'
        ? 'bg-red-500'
        : tone === 'stalled'
          ? 'bg-amber-500'
          : 'bg-sky-500 animate-pulse';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

/** A PR title + coordinate, the clickable half of every row. */
function RowHeader({
  repoFullName,
  prNumber,
  prTitle,
  tone,
  onOpen,
}: {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  tone: 'working' | 'waiting' | 'stalled' | 'good' | 'bad';
  onOpen: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onOpen} className="block w-full text-left" title="Open this PR">
      <div className="flex items-center gap-1.5">
        <StatusDot tone={tone} />
        <span className="truncate font-medium text-blue-600 hover:underline dark:text-blue-400">
          {repoFullName} #{prNumber}
        </span>
      </div>
      <div className="mt-0.5 truncate text-gray-500 dark:text-gray-400">{prTitle}</div>
    </button>
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
  const phase = row.phase;
  const tone =
    phase == null
      ? 'waiting'
      : WORKING_PHASES.has(phase)
        ? 'working'
        : STALLED_PHASES.has(phase)
          ? 'stalled'
          : // Waiting its TURN is ordinary progress, but a row that yielded because its checks
            // failed is parked on a human exactly like `blocked_protection` — same phase, two
            // very different states, so the tone reads the field rather than the phase.
            phase === 'queued_local' && row.yieldedForFailedChecks
            ? 'stalled'
            : 'waiting';
  // A phase the watcher couldn't honestly characterise comes back null; the prose is then the
  // only line there is, and "Waiting…" is the truthful headline for it.
  const headline = armedPhaseHeadline(row);

  return (
    <li className="px-3 py-2 text-xs">
      <RowHeader
        repoFullName={repoFullName}
        prNumber={row.prNumber}
        prTitle={row.prTitle}
        tone={tone}
        onOpen={() =>
          openPrDetailTab(
            tabMetaOf({
              prId: row.prId,
              prNumber: row.prNumber,
              prTitle: row.prTitle,
              repoFullName,
            }),
          )
        }
      />
      <div className="mt-0.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-gray-500 dark:text-gray-400">{headline}</div>
          {/* ⚠ `lastReason` is the SPECIFICS under the headline — which branch, which error. For
              a POSITIONED `queued_local` alone it is not: the watcher writes "waiting its turn —
              3rd of 3 armed on acme/mine", which is the same fact the headline already derived
              from `queuePosition`/`queueDepth`, in a second spelling ("3rd of 3" under "3 of 3").
              Both lines are correct and the pair reads as two different statuses. The prose stays
              on the wire — it is the fallback for a client that does not know the phase — and is
              simply not drawn beneath its own restatement. ⚠ The position is what makes it a
              restatement, so the test is the FIELD, not the phase: a `queued_local` row with no
              position (an intent spending one tick taking its place in the landing order after
              its merge queue was disabled) has prose that says something the headline cannot. */}
          {row.lastReason && !(row.phase === 'queued_local' && row.queuePosition != null) && (
            <div className="mt-0.5 text-[11px] leading-snug text-gray-400">{row.lastReason}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => disarm.mutate()}
          disabled={disarm.isPending}
          className="shrink-0 text-[11px] text-gray-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
        >
          {disarm.isPending ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </li>
  );
}

function OutcomeRow({
  outcome,
  onDismiss,
}: {
  outcome: Outcome;
  onDismiss: () => void;
}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const merged = outcome.state === 'merged';
  return (
    <li className="px-3 py-2 text-xs">
      <RowHeader
        repoFullName={outcome.repoFullName}
        prNumber={outcome.prNumber}
        prTitle={outcome.prTitle}
        tone={merged ? 'good' : 'bad'}
        onOpen={() => openPrDetailTab(tabMetaOf(outcome))}
      />
      <div className="mt-0.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={merged ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}>
            {merged ? (
              <CheckIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
            ) : (
              <WarningIcon size={11} className="mr-1 inline-block align-[-0.1em]" />
            )}
            {TERMINAL_LABEL[outcome.state] ?? 'Auto-merge finished'}
          </div>
          {outcome.reason && (
            <div className="mt-0.5 text-[11px] leading-snug text-gray-400">{outcome.reason}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          dismiss
        </button>
      </div>
    </li>
  );
}

export function AutoMergeBanner(): JSX.Element | null {
  const { data } = useArmedMerges();
  const qc = useQueryClient();
  // prId → last observed state. `null` until the first response, which is what makes the first
  // poll a silent baseline rather than a burst of stale outcomes.
  const seen = useRef<Map<number, ArmedMergeState> | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, true>>({});

  const requests: ArmedMergeRequest[] | undefined = data?.requests;

  useEffect(() => {
    if (!requests) return;
    const prev = seen.current;
    const next = new Map<number, ArmedMergeState>();
    for (const r of requests) next.set(r.prId, r.state);

    if (prev == null) {
      seen.current = next;
      return;
    }

    const { fresh, superseded, landed } = foldArmedPoll(prev, requests);
    seen.current = next;
    setOutcomes((t) => {
      const kept = t.filter((o) => !superseded.has(o.prId));
      // Same array when nothing moved: this effect runs on EVERY poll (8s while anything is
      // armed), and a fresh array identity per poll would re-render the stack for nothing.
      if (fresh.length === 0 && kept.length === t.length) return t;
      return [...fresh, ...kept].slice(0, 5);
    });
    if (landed) {
      // The PR really did change state on GitHub — refresh every surface that shows open-PR
      // state, exactly as the interactive merge mutation does.
      for (const key of [
        ['timeline'],
        ['open-prs'],
        ['activity'],
        ['consolidated-feed'],
        ['my-turn'],
        ['me'],
      ]) {
        void qc.invalidateQueries({ queryKey: key });
      }
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
  const outcomeRows = shownOutcomes.slice(0, MAX_ROWS);
  const liveRows = live.slice(0, Math.max(0, MAX_ROWS - outcomeRows.length));
  const hidden = total - outcomeRows.length - liveRows.length;

  const dismissAll = (): void =>
    setDismissed((prev) => {
      const next = { ...prev };
      for (const o of shownOutcomes) next[o.id] = true;
      return next;
    });

  return (
    <div
      role="status"
      aria-label="Auto-merge progress"
      className="pointer-events-auto rounded-lg border border-gray-200 bg-white/95 shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-900/95"
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
        <span className="text-xs font-semibold">
          Merge when ready
          {live.length > 0 && (
            <span className="ml-1 font-normal text-gray-400">· {live.length} armed</span>
          )}
        </span>
        {shownOutcomes.length > 0 && (
          <button
            type="button"
            onClick={dismissAll}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            Dismiss all
          </button>
        )}
      </div>
      <ul className="max-h-72 divide-y divide-gray-100 overflow-auto dark:divide-gray-800">
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
      </ul>
      {hidden > 0 && (
        <div className="border-t border-gray-100 px-3 py-1 text-[11px] text-gray-400 dark:border-gray-800">
          +{hidden} more
        </div>
      )}
      <div className="border-t border-gray-100 px-3 py-1 text-[11px] text-gray-400 dark:border-gray-800">
        Auto-merge only runs while Limn is running.
      </div>
    </div>
  );
}
