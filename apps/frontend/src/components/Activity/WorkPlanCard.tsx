import { useMemo, type ReactNode } from 'react';
import type {
  CiStatus,
  MergeStateStatus,
  StoredWorkPlan,
  WorkPlanFacts,
  WorkPlanItem,
  WorkPlanKind,
} from '@pierre-review/shared';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import {
  useGenerateWorkPlan,
  useWorkPlan,
  useWorkPlanGenerating,
} from '../../hooks/useWorkPlan.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { relativeTime, safeExternalUrl } from '../../lib/ui.js';
import {
  CheckCircleIcon,
  CommentIcon,
  CommitIcon,
  ExternalLinkIcon,
  MergeIcon,
  PersonIcon,
  RefreshIcon,
  ReviewIcon,
  SparkleIcon,
  StarIcon,
  ThreadsIcon,
  TimerIcon,
  WarningIcon,
} from '../Icons.js';

// "Plan for today" (Pro) — the prioritised worklist for the active Workspace, sitting directly
// under the daily-brief strip. Three properties define it, and each one is load-bearing:
//
//  1. EVERY FIGURE, ID, LINK AND RANK IS CODE-DERIVED. `evidence.items` arrives already ranked
//     from `getWorkPlan`; each row's chips are read straight off `item.facts` and its one-line
//     `item.reason` is written by CORE. The model may only choose which rows to foreground,
//     order those, and write ONE sentence each about why now — so this component renders the
//     whole worklist WITH OR WITHOUT a plan, and a generation only ever ADDS italic prose to it.
//
//  2. IT AGREES WITH THE BRIEF ABOVE IT. Both fold the same `/api/attention` cards
//     (`evidence.counts` carries the strip's figures precisely so the agreement is assertable).
//     This panel therefore does NOT restate those counts — the strip owns them; the plan owns the
//     ORDER. Two renderings of one number is how they start to disagree.
//
//  3. EVERY CLAIM LINKS TO ITS DATA. Every row carries a real prId/repoId (+ threadId) and a
//     `githubUrl`: the title opens the PR in-app on the tab that matches the row's kind, and the
//     external mark opens the same thing on GitHub. A row whose `prId` is null (a red trunk that
//     resolves to no PR) still renders — it just names no PR and links out only.
//
// ⚠ THE LABELLED-APART RULE. A model-derived figure and a code-derived figure may never share a
// line. Chips and `reason` are DATA (neutral ink); `headline`, each step's `why` and `parked` are
// GENERATED (the `--ai-*` palette, italic, led by a SparkleIcon). The footer says so once, quietly.
//
// ⚠ THE MODEL MAY NOT REMOVE WORK FROM THE BOARD. Items no step mentions still render, below,
// under "Also on the list"; `plan.droppedIds > 0` renders a quiet note that it named references
// the evidence did not contain, because a silent drop lets a hallucination vanish without trace.
//
// Free/OSS posture (the SynthesisCard precedent): capability off + local/OSS → NOTHING (absence,
// never an error); capability off + cloud → a one-line Pro nudge; `enabled: false` from the
// server, a query error, or an unresolved workspace → nothing, and nothing is fetched.

// ---- kind + fact vocabulary (all of it code-derived) ---------------------------------------

type Tone = 'go' | 'warn' | 'stop' | 'info' | 'plain';

const TONE: Record<Tone, string> = {
  go: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  stop: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  plain:
    'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300',
};

const KIND_META: Record<
  WorkPlanKind,
  { label: string; tone: Tone; Icon: (p: { size?: number }) => JSX.Element; hint: string }
> = {
  merge: {
    label: 'Ready to land',
    tone: 'go',
    Icon: MergeIcon,
    hint: 'Approved or clean, and GitHub will take it — the shortest path to a merged PR.',
  },
  update_branch: {
    label: 'Update branch',
    tone: 'warn',
    Icon: CommitIcon,
    // ⚠ NOT "the base branch moved on", which is true of most healthy PRs.
    hint: 'GitHub is refusing the merge until this branch is updated from trunk.',
  },
  unblock_ci: {
    label: 'CI failing',
    tone: 'stop',
    Icon: WarningIcon,
    hint: 'Your own open PR whose head-commit check rollup is red.',
  },
  review: {
    // ⚠ DELIBERATELY NON-SPECIFIC. This kind carries FOUR my_turn reasons — a review requested of
    // you, your own approved PR, your PR with new activity, and a new PR nobody has looked at — so
    // the old "Review requested" / "A review was requested of you" asserted something false about
    // three of the four. The specific truth is per-row and already on screen: `item.reason` says
    // exactly which. A chip that covers a union must claim only what the union shares.
    label: 'Needs a look',
    tone: 'info',
    Icon: ReviewIcon,
    hint: 'This pull request is waiting on a person — the line under the chips says who, and why.',
  },
  reply: {
    label: 'Reply needed',
    tone: 'info',
    Icon: CommentIcon,
    hint: 'A thread is waiting on your reply.',
  },
  thread: {
    label: 'Untouched thread',
    tone: 'warn',
    Icon: ThreadsIcon,
    hint: 'A review thread on an open PR that nobody has answered.',
  },
  nudge: {
    label: 'Waiting on a reviewer',
    tone: 'warn',
    Icon: TimerIcon,
    hint: 'A review was requested of someone and nobody has moved.',
  },
};

/**
 * The chip THIS ROW gets. `KIND_META` is the default, but `unblock_ci` covers two genuinely
 * different situations and a static label asserts something false about one of them.
 *
 * ⚠ A red TRUNK is not "your PR's checks are red". It is a default branch failing in a repo the
 * viewer merely maintains, it often names no pull request at all, and the PR it does name is the
 * one that LANDED the current head — not, on any evidence we hold, the one that broke it.
 */
function chipFor(item: WorkPlanItem): (typeof KIND_META)[WorkPlanKind] {
  const base = KIND_META[item.kind];
  if (item.kind === 'unblock_ci' && item.subject === 'repo') {
    return {
      ...base,
      label: 'Trunk red',
      hint: 'The default branch is failing its checks, so every open PR in this repo builds on a red base. Any pull request named beside it is the one that landed the current head, not necessarily what broke it.',
    };
  }
  return base;
}

const MERGE_STATE_LABEL: Record<MergeStateStatus, { label: string; tone: Tone } | null> = {
  clean: { label: 'clean', tone: 'plain' },
  dirty: { label: 'conflicts', tone: 'warn' },
  // ⚠ `unstable` IS mergeable — only non-required checks are red.
  unstable: { label: 'unstable', tone: 'plain' },
  blocked: { label: 'blocked', tone: 'warn' },
  behind: { label: 'behind trunk', tone: 'warn' },
  has_hooks: { label: 'has hooks', tone: 'plain' },
  unknown: null,
};

// ⚠ Red is ALWAYS the pair `failure` | `error`, never one of them.
const CI_LABEL: Record<CiStatus, { label: string; tone: Tone } | null> = {
  failure: { label: 'checks red', tone: 'stop' },
  error: { label: 'checks red', tone: 'stop' },
  success: { label: 'checks green', tone: 'plain' },
  pending: { label: 'checks running', tone: 'plain' },
  expected: { label: 'checks expected', tone: 'plain' },
  unknown: null,
};

function ageLabel(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The age chip's wording, which is chosen by the CLOCK the server measured against — the four
 * signals age from four different instants, and naming which one is the difference between a fact
 * and a plausible number.
 *
 * ⚠ NO CLOCK ⇒ NO CHIP. A bare duration with no stated origin reads as "open for N days" to every
 * reader, which is exactly the assumption `WorkPlanFacts.clock` exists to forbid — so an age that
 * arrives without its clock is not rendered at all rather than rendered ambiguously.
 */
function ageChip(facts: WorkPlanFacts): string | null {
  if (facts.ageHours == null || facts.clock == null) return null;
  // ⚠ UNDER AN HOUR IS ITS OWN PHRASE, not a rounded number. "seen 0h ago" is a rounding artifact
  // that reads as a bug, and it is the COMMON case on the trunk rows, whose clock is our own
  // snapshot refresh (the poll runs every few minutes). A figure that looks broken undermines the
  // chips beside it, which are the whole evidentiary point of the row. The phrasing has to branch
  // here rather than inside ageLabel, because each clock wraps the duration differently and
  // "requested just now ago" is worse than what it replaced.
  const fresh = facts.ageHours < 1;
  const age = ageLabel(facts.ageHours);
  switch (facts.clock) {
    case 'opened':
      return fresh ? 'just opened' : `open ${age}`;
    case 'requested':
      return fresh ? 'requested just now' : `requested ${age} ago`;
    case 'last_commit':
      return fresh ? 'just committed' : `last commit ${age} ago`;
    case 'thread_created':
      return fresh ? 'new thread' : `thread ${age} old`;
    case 'observed':
      return fresh ? 'seen just now' : `seen ${age} ago`;
  }
}

function Chip({
  tone = 'plain',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * The row's code-derived facts, one chip each. Everything here is a figure a reader can check by
 * following the row's own link — that is the bar for putting a chip on the line. A fact that is
 * ABSENT renders no chip at all: a missing chip must never be readable as a zero.
 */
function FactChips({ facts }: { facts: WorkPlanFacts }): JSX.Element | null {
  const chips: JSX.Element[] = [];

  if (facts.approvals != null) {
    chips.push(
      <Chip key="approvals" tone={facts.approvals > 0 ? 'go' : 'plain'}>
        {facts.approvals > 0 && <CheckCircleIcon size={10} />}
        <span className="tabular-nums">
          {facts.approvals > 0
            ? `${facts.approvals} approval${facts.approvals === 1 ? '' : 's'}`
            : 'no approvals'}
        </span>
      </Chip>,
    );
  }

  const merge = facts.mergeStateStatus ? MERGE_STATE_LABEL[facts.mergeStateStatus] : null;
  if (merge) {
    chips.push(
      <Chip key="merge-state" tone={merge.tone} title={`GitHub merge state: ${facts.mergeStateStatus}`}>
        {merge.label}
      </Chip>,
    );
  }

  const ci = facts.ciStatus ? CI_LABEL[facts.ciStatus] : null;
  if (ci) {
    chips.push(
      <Chip key="ci" tone={ci.tone} title={`Head-commit check rollup: ${facts.ciStatus}`}>
        {ci.label}
      </Chip>,
    );
  }

  if (facts.untouchedThreads != null && facts.untouchedThreads > 0) {
    chips.push(
      <Chip key="untouched" tone="warn">
        <ThreadsIcon size={10} />
        <span className="tabular-nums">{facts.untouchedThreads} untouched</span>
      </Chip>,
    );
  }

  if (facts.pendingReviewers != null && facts.pendingReviewers > 0) {
    chips.push(
      <Chip
        key="reviewers"
        title="Reviewers still on the hook — people and GitHub teams (a team request has no user)."
      >
        <ReviewIcon size={10} />
        <span className="tabular-nums">
          {facts.pendingReviewers} reviewer{facts.pendingReviewers === 1 ? '' : 's'} pending
        </span>
      </Chip>,
    );
  }

  if (facts.changedFiles != null && facts.changedFiles > 0) {
    chips.push(
      <Chip key="files">
        <span className="tabular-nums">
          {facts.changedFiles} file{facts.changedFiles === 1 ? '' : 's'}
        </span>
      </Chip>,
    );
  }

  const age = ageChip(facts);
  if (age) {
    chips.push(
      <Chip key="age">
        <TimerIcon size={10} />
        {age}
      </Chip>,
    );
  }

  if (chips.length === 0) return null;
  return <div className="mt-1 flex flex-wrap items-center gap-1">{chips}</div>;
}

/**
 * The relevance marker — the same three tiers the attention board and My Turn use. `none` renders
 * NOTHING: shared work in scope is real work, but nobody named the reader for it, and a row's copy
 * may never claim ownership its tier does not support.
 */
function RelevanceChip({ item }: { item: WorkPlanItem }): JSX.Element | null {
  if (item.relevance === 'direct') {
    return (
      <Chip tone="info" title="This names you directly — you authored it, were asked for it, or were replied to.">
        <PersonIcon size={10} />
        yours
      </Chip>
    );
  }
  if (item.relevance === 'maintained') {
    return (
      <Chip title="This is in a repo you maintain — orbit, not ownership: nobody named you.">
        <StarIcon size={10} />
        your repos
      </Chip>
    );
  }
  return null;
}

// ---- one row -------------------------------------------------------------------------------

function PlanRow({ item, why }: { item: WorkPlanItem; why?: string }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const setPrDetailTab = useFilters((s) => s.setPrDetailTab);
  const kindMeta = chipFor(item);
  // ⚠ Never straight into `href`: `githubUrl` is data, and React renders `javascript:` URLs.
  const href = safeExternalUrl(item.githubUrl);
  // ⚠ READ OFF THE WIRE, NEVER INFERRED FROM THE ID. Deriving this from the id shape looked
  // equivalent and was not: `wp:thread:<prId>:<threadId>` also fails the `wp:<kind>:<prId>` test,
  // so every review thread rendered as "default branch". The server answers this question itself
  // because it is a DIFFERENT question from the per-PR dedup grain — see `WorkPlanItem.subject`.
  const repoGrained = item.subject === 'repo';

  const openInApp = (): void => {
    // A repo-grained row (a red trunk resolving to no PR) has nothing in-app to open.
    if (item.prId == null || item.prNumber == null) return;
    const tab: TabMeta = {
      id: item.prId,
      number: item.prNumber,
      title: item.prTitle ?? `#${item.prNumber}`,
      repoFullName: item.repoFullName,
      // Author chrome backfills when PrDetail loads and calls syncMeta (the useOpenPrTab
      // precedent) — the plan carries no author, and inventing one would be a claim.
      authorLogin: null,
      authorDisplayName: null,
      authorAvatarUrl: null,
    };
    // Opened FROM the Activity console, so Back returns there (the feed/digest precedent).
    openPrDetailTab(tab, { fromActivity: true });
    // ⚠ Pass the prId THIS row means: `prDetailTab` is a GLOBAL store field read by a per-PR
    // component, so a mis-paired write seats another PR's tab. Thread-grained kinds land on
    // Threads, everything else on Overview.
    setPrDetailTab(
      item.prId,
      item.kind === 'thread' || item.kind === 'reply' ? 'threads' : 'overview',
    );
  };

  return (
    <li className="border-t border-ai-hairline py-2 first:border-t-0 first:pt-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Chip tone={kindMeta.tone} title={kindMeta.hint}>
          <kindMeta.Icon size={10} />
          {kindMeta.label}
        </Chip>
        {repoGrained ? (
          // ⚠ A REPO-GRAINED ROW IS ABOUT THE BRANCH, NOT ABOUT A PR — and it may still carry a
          // prNumber, because the trunk arm resolves the current red head to the PR that LANDED it.
          // Leading with "acme/api#289" beside "trunk is red" reads as an accusation against that
          // PR, which is precisely the claim the underlying card refuses to make (trunk CI is
          // non-monotone, a fifth of commit rows are `unknown`, and about one red head in nine is a
          // direct push belonging to no PR). So the SUBJECT is the branch, and the PR is demoted to
          // a secondary "landed by" reference — the same shape, and the same wording, the
          // ci_failing card on the attention board already uses.
          <span className="min-w-0 flex-1 text-[12px] text-gray-800 dark:text-gray-100">
            <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
              {item.repoFullName}
            </span>{' '}
            <span className="font-medium">default branch</span>
            {item.prId != null && item.prNumber != null && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={openInApp}
                  className="text-[11px] text-gray-500 hover:text-ai-signal hover:underline dark:text-gray-400"
                  title="Open the pull request that landed the current head. It is where the branch is now, not necessarily what broke it."
                >
                  landed by #{item.prNumber}
                </button>
              </>
            )}
          </span>
        ) : item.prId != null && item.prNumber != null ? (
          <button
            type="button"
            onClick={openInApp}
            className="min-w-0 flex-1 text-left text-[12px] text-gray-800 hover:text-ai-signal hover:underline dark:text-gray-100"
            title="Open this PR here"
          >
            <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
              {item.repoFullName}#{item.prNumber}
            </span>{' '}
            <span className="font-medium">{item.prTitle ?? `#${item.prNumber}`}</span>
          </button>
        ) : (
          // No PR resolved: name the repo and nothing more, rather than inventing a subject.
          <span className="min-w-0 flex-1 text-[12px] text-gray-800 dark:text-gray-100">
            <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
              {item.repoFullName}
            </span>{' '}
            <span className="text-gray-500 dark:text-gray-400">(no pull request)</span>
          </span>
        )}
        <RelevanceChip item={item} />
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 text-gray-400 hover:text-ai-signal"
            title="Open on GitHub"
          >
            <ExternalLinkIcon size={12} title="Open on GitHub" />
          </a>
        )}
      </div>

      <FactChips facts={item.facts} />

      {/* CODE-WRITTEN. Renders whether or not anything was ever generated. */}
      <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{item.reason}</p>

      {/* GENERATED. Its own palette, its own type style, its own line — never mixed with a chip. */}
      {why != null && why.trim() !== '' && (
        <p className="mt-1 flex items-start gap-1 text-[11px] italic text-ai-ink">
          <SparkleIcon size={11} className="mt-0.5 shrink-0 not-italic text-ai-signal" />
          <span className="min-w-0">{why}</span>
        </p>
      )}
    </li>
  );
}

// ---- the card ------------------------------------------------------------------------------

export function WorkPlanCard({
  workspaceId: workspaceIdProp,
  className,
}: {
  /**
   * The scope. OMIT IT and the card reads the active workspace off the store itself, so the
   * Activity console can mount `<WorkPlanCard />` and be sure the panel and the brief strip above
   * it are describing the same workspace. Pass it explicitly only to pin a different one.
   */
  workspaceId?: number | null;
  className?: string;
} = {}): JSX.Element | null {
  const storeWorkspaceId = useFilters((s) => s.workspaceId);
  // `undefined` = "not given"; an explicit `null` = "not resolved yet" and is honoured as such.
  const workspaceId = workspaceIdProp === undefined ? storeWorkspaceId : workspaceIdProp;
  const { workPlan: capable } = useProCapabilities();
  const isCloud = useMe().data?.deploymentMode === 'cloud';

  const query = useWorkPlan(workspaceId, capable);
  const generate = useGenerateWorkPlan(workspaceId);
  const busy = useWorkPlanGenerating(workspaceId);
  const usage = useAiUsage(capable);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  const resp = query.data;
  const evidence = resp?.enabled ? (resp.evidence ?? null) : null;
  const plan = resp?.enabled ? (resp.plan ?? null) : null;

  // Split the worklist into "what the model foregrounded, in its order" and "everything else, in
  // rank order". Both halves render — the model may reorder the board, never shorten it.
  const { foreground, rest } = useMemo<{
    foreground: Array<{ item: WorkPlanItem; why: string }>;
    rest: WorkPlanItem[];
  }>(() => {
    const items = evidence?.items ?? [];
    if (!plan || plan.steps.length === 0) return { foreground: [], rest: items };
    const byId = new Map(items.map((i) => [i.id, i]));
    const seen = new Set<string>();
    const fg: Array<{ item: WorkPlanItem; why: string }> = [];
    for (const step of plan.steps) {
      const item = byId.get(step.id);
      // A step naming an id the evidence does not carry has no row to decorate. The server
      // already intersected and COUNTED those (`droppedIds`); this is the client-side floor.
      if (!item || seen.has(step.id)) continue;
      seen.add(step.id);
      fg.push({ item, why: step.why });
    }
    return { foreground: fg, rest: items.filter((i) => !seen.has(i.id)) };
  }, [evidence, plan]);

  // What the cap left off, folded from the UNCAPPED per-kind totals the server carries for
  // exactly this purpose. A "+N" with no denominator is how a disclosure silently vanishes.
  const hiddenCount = useMemo(() => {
    const items = evidence?.items ?? [];
    const totals = evidence?.totals ?? {};
    const shown = new Map<WorkPlanKind, number>();
    for (const i of items) shown.set(i.kind, (shown.get(i.kind) ?? 0) + 1);
    let hidden = 0;
    for (const [kind, total] of Object.entries(totals)) {
      if (typeof total !== 'number') continue;
      hidden += Math.max(0, total - (shown.get(kind as WorkPlanKind) ?? 0));
    }
    return hidden;
  }, [evidence]);

  // Capability off: OSS/local renders NOTHING at all (absence, never an error); cloud renders the
  // one-line Pro nudge. Nothing is fetched either way — useWorkPlan gates on the same flag.
  if (!capable) {
    if (!isCloud) return null;
    return (
      <p className={`text-[10px] text-gray-400 ${className ?? ''}`}>
        <span className="mr-1 rounded bg-ai-signal/15 px-1 text-[10px] font-semibold text-ai-signal">
          Pro
        </span>
        A ranked plan for the day — what is closest to landing and what is about to stall — is part
        of Pro.
      </p>
    );
  }

  // Not resolved yet: nothing workspace-scoped may render (and useWorkPlan issued no request).
  if (workspaceId == null) return null;
  // The plugin tier is off server-side, or the read failed: nothing. The strip above still stands.
  if (query.isError || (resp != null && !resp.enabled)) return null;
  // Still loading, or nothing on the board. A "Plan for today" panel with an empty list is noise
  // — and the brief strip above self-hides on the same population, so the two stay in step. A
  // stored plan does NOT keep it alive: prose about work that has since landed is worse than
  // absence.
  if (evidence == null || evidence.items.length === 0) return null;

  const notice = generate.data?.throttled
    ? 'A plan is already being written — the latest shows here shortly.'
    : generate.data?.creditsExhausted
      ? 'Out of AI credits this month — the plan below is the last one written.'
      : generate.data?.empty
        ? 'Nothing needs doing in this workspace right now.'
        : null;

  return (
    <div
      className={`rounded-lg border border-ai-border bg-ai-surface p-3 ${className ?? ''}`}
      data-testid="work-plan-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SparkleIcon size={13} className="shrink-0 text-ai-signal" />
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          Plan for today
        </span>
        <span className="shrink-0 rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal">
          Pro
        </span>
        {plan && resp?.stale && (
          <span
            className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="The worklist has moved on since this plan was written — the rows below are current, the italic lines describe the list as it stood."
          >
            stale
          </span>
        )}
        {plan && (
          <span className="shrink-0 text-[10px] text-gray-400" title={plan.model}>
            written {relativeTime(plan.generatedAt)}
          </span>
        )}
        <button
          type="button"
          onClick={() => generate.mutate()}
          disabled={busy || outOfCredits}
          className="ml-auto rounded bg-ai-signal px-2.5 py-0.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
          title={
            outOfCredits
              ? 'Out of AI credits — resets next month'
              : 'Have the model foreground and order this list, and say why each item is worth doing now. The rows, figures and ranking are computed either way.'
          }
        >
          {busy ? (
            'Planning…'
          ) : plan ? (
            <span className="inline-flex items-center gap-1">
              <RefreshIcon size={11} />
              Regenerate
            </span>
          ) : (
            'Plan my day'
          )}
        </button>
      </div>

      {generate.isError && (
        <div className="mt-1.5 text-[11px] text-red-500">
          {(generate.error as Error)?.message ?? 'Couldn’t write the plan.'}
        </div>
      )}
      {!generate.isError && notice && (
        <div className="mt-1.5 text-[11px] text-gray-400">{notice}</div>
      )}
      {outOfCredits && (
        <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — the worklist below is unaffected.
        </div>
      )}

      {/* GENERATED — the one sentence framing the day. */}
      {plan && plan.headline.trim() !== '' && (
        <p
          key={plan.generatedAt}
          className="digest-fade-in mt-2 flex items-start gap-1.5 text-[12px] italic text-ai-ink"
        >
          <SparkleIcon size={12} className="mt-0.5 shrink-0 text-ai-signal" />
          <span>{plan.headline}</span>
        </p>
      )}

      {foreground.length > 0 && (
        <ul className="mt-1.5">
          {foreground.map(({ item, why }) => (
            <PlanRow key={item.id} item={item} why={why} />
          ))}
        </ul>
      )}

      {rest.length > 0 && (
        <>
          {foreground.length > 0 && (
            <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Also on the list
            </p>
          )}
          <ul className={foreground.length > 0 ? 'mt-0.5' : 'mt-1.5'}>
            {rest.map((item) => (
              <PlanRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}

      {/* GENERATED — what the model thinks can wait. Still its own line, still its own palette. */}
      {plan?.parked != null && plan.parked.trim() !== '' && (
        <p className="mt-2 flex items-start gap-1.5 border-t border-ai-hairline pt-1.5 text-[11px] italic text-ai-ink/80">
          <SparkleIcon size={11} className="mt-0.5 shrink-0 text-ai-signal" />
          <span>{plan.parked}</span>
        </p>
      )}

      {plan != null && plan.droppedIds > 0 && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          {plan.droppedIds} reference{plan.droppedIds === 1 ? '' : 's'} the model named{' '}
          {plan.droppedIds === 1 ? 'was' : 'were'} not on this list and{' '}
          {plan.droppedIds === 1 ? 'was' : 'were'} discarded.
        </p>
      )}

      <div className="mt-2 border-t border-ai-hairline pt-1.5 text-[10px] text-gray-400">
        {hiddenCount > 0 && (
          <>
            Showing the top {evidence.items.length.toLocaleString()} of{' '}
            {(evidence.items.length + hiddenCount).toLocaleString()} open items.{' '}
          </>
        )}
        Ordered by how close each one is to landing and how likely it is to stall — every row links
        to the pull request or thread it was computed from. The chips and the grey line are read
        from that data; the italic lines are written by the model.
      </div>
    </div>
  );
}
