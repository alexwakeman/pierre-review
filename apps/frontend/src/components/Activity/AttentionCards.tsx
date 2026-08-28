import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutomatedReviewerKind,
  CiFailingCard,
  InsightCard,
  InsightPrRef,
  InsightSeverity,
  MergeReadyCard,
  MergeStateStatus,
  MyTurnCard,
  MyTurnCardReason,
  MyTurnDismissKind,
  ReviewerRoutingCard,
  StalledReviewCard,
  UntouchedThreadCard,
  UpdateBranchCard,
  User,
} from '@pierre-review/shared';
import { usePr, useThread } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useRequestReviewers } from '../../hooks/usePrWrites.js';
import { useDismissMyTurn } from '../../hooks/useAttentionCards.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import {
  automatedReviewerMeta,
  CI_META,
  dateTime,
  indexUsers,
  relativeTime,
  safeExternalUrl,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { BotIcon, CheckIcon, ChevronIcon, ExternalLinkIcon, SparkleIcon } from '../Icons.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { AiSummary } from '../AiSummary.js';
import { ThreadCard } from '../ThreadView/index.js';

// The attention-card list — the stalled-review / untouched-thread / reviewer-load / needs-a-reviewer
// cards, with the full drill-down behaviour (click a card to open the PR / thread, inline thread
// reply+resolve, suggested-reviewer assign, lazy PR summary, and back-from-a-click flash). Extracted
// from InsightsView so it can be rendered in BOTH the (Pro) Insights pane and the CORE/free Feed
// **Pending** rail entry — the same JSX, just fed from a different data hook. It depends only on core
// stores/hooks (usePinnedTabs / useFilters / usePr / useThread / useRequestReviewers), so it's tier-
// agnostic. Callers pass already-filtered `cards` (bot cards excluded upstream).

// Left-accent + label per severity — the same visual grammar as the Feed's cards.
const SEV: Record<InsightSeverity, { border: string; dot: string }> = {
  high: { border: 'border-l-red-400 dark:border-l-red-500', dot: 'bg-red-500' },
  warn: { border: 'border-l-amber-400 dark:border-l-amber-500', dot: 'bg-amber-500' },
  info: { border: 'border-l-sky-400 dark:border-l-sky-500', dot: 'bg-sky-500' },
};

// Exported because the isolation banner names the isolated kind with it — one spelling of "what
// this kind is called", so the banner and the card header can never disagree.
//
// ⚠ `my_turn` IS NOT LABELLED "Your turn" HERE, and that is the whole semantic split. The KIND
// means "this needs a review or reply" — of the 149 such cards on the reporting account, 5 were
// actually theirs. Naming the kind after the narrow case made the board claim ownership of work
// belonging to people who had never touched the repo ("50+ items awaiting YOUR review" in a
// project they are not a contributor to). The kind stays neutral; the OWNERSHIP claim is made
// per card, off `relevance`, by `cardKindLabel` below. See docs/FRONTEND.md § "Per-workspace
// 'My Turn'".
export const KIND_LABEL: Record<InsightCard['kind'], string> = {
  my_turn: 'Review or reply',
  // Neutral at the KIND level, like my_turn: the ownership claim ("your PR" vs "trunk in a repo
  // you maintain") is made per card by `cardKindLabel`, off the card's own `arm`.
  ci_failing: 'CI failing',
  bot_signal: 'Review-bot signal',
  bot_only_review: 'Only a bot reviewed',
  stalled_review: 'Stalled review',
  untouched_thread: 'Untouched thread',
  reviewer_load: 'Review load',
  reviewer_routing: 'Needs a reviewer',
  // The two FORWARD kinds — something that is READY rather than something that is wrong. Neutral
  // at the kind level like the rest; `cardKindLabel` is deliberately NOT extended for them,
  // because neither makes an ownership claim to soften.
  merge: 'Ready to merge',
  update_branch: 'Behind trunk',
};

/** GitHub's protection-aware merge state, as a short chip label. Transplanted from the deleted
 *  WorkPlanCard — `lib/ui.ts` carries `MERGE_STATE_STATUSES` and `mergeVerdict()` but no label
 *  map. Kept a total `Record<MergeStateStatus, …>` so a new GitHub state forces a decision here
 *  rather than rendering a raw enum. */
const MERGE_STATE_LABEL: Record<MergeStateStatus, string | null> = {
  clean: 'clean',
  dirty: 'conflicts',
  // ⚠ `unstable` IS mergeable — only non-required checks are red.
  unstable: 'unstable',
  blocked: 'blocked',
  behind: 'behind trunk',
  has_hooks: 'has hooks',
  unknown: null,
};

/**
 * What THIS card is called, as opposed to what its kind is called. THREE labels for `my_turn`,
 * off `MyTurnCard.relevance`, because the boolean it replaced conflated two different
 * relationships:
 *
 *   'direct'     → "Your turn"      — you authored it, you were asked for the review, your
 *                                     thread got a reply, your Claude run finished, or you were
 *                                     @-mentioned (even in a repo you only read).
 *   'maintained' → "In your repos"  — somebody else opened a PR in a repo you maintain. That is
 *                                     ORBIT, not ownership: nobody named you, and calling it
 *                                     "Your turn" is precisely the over-claim the reporter
 *                                     objected to ("work on repos" vs "work tied to me directly
 *                                     through authorship, reply or merge").
 *   'none'       → the neutral KIND label ("Review or reply") — work that needs *someone*.
 *
 * ⚠ AN ABSENT `relevance` RENDERS THE NEUTRAL LABEL, and so does an absent-but-`personal: true`
 * card. That is the opposite of the wire's tolerance rule (absent ⇒ personal, because
 * over-notifying is the safe direction) and it is deliberate: a missing field may never invent an
 * ownership claim ON SCREEN. The only way to see it is a server too old to send the field — where
 * the neutral label is still true, and the notification surfaces (which read `personal`) keep
 * their safe direction independently.
 */
export function cardKindLabel(card: InsightCard): string {
  if (card.kind === 'my_turn') {
    if (card.relevance === 'direct') return 'Your turn';
    if (card.relevance === 'maintained') return 'In your repos';
    return KIND_LABEL.my_turn;
  }
  // The ci_failing arms are the same distinction one layer over: 'your_pr' is a claim of
  // AUTHORSHIP, 'trunk' a claim about your patch of ground. The server only ever emits a card the
  // viewer is on the hook for, so both labels are true — they just are not the same summons.
  if (card.kind === 'ci_failing') {
    return card.arm === 'your_pr' ? 'CI failing on your PR' : 'Trunk CI failing';
  }
  return KIND_LABEL[card.kind];
}

// WHICH My Turn section put this card on your plate. ⚠ Keyed on `MyTurnCardReason` (the six
// sections of GET /api/my-turn), NOT the older `MyTurnReason` participation union that
// lib/ui.ts's MY_TURN_REASON_META covers — they are one `sed` apart and mean opposite things.
const MY_TURN_REASON_LABEL: Record<MyTurnCardReason, string> = {
  review_request: 'Review requested',
  thread: 'Reply needed',
  pr_approved: 'Approved',
  your_pr: 'Your PR',
  watched_repo_pr: 'New PR',
  claude_review: 'Claude review',
};

function ageLabel(hours: number): string {
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function metaFor(
  card: { prId: number; prNumber: number; prTitle: string; repoFullName: string; authorId?: number | null },
  usersById: Map<number, User>,
): PinnedPr {
  const author = card.authorId != null ? usersById.get(card.authorId) : undefined;
  return {
    id: card.prId,
    number: card.prNumber,
    title: card.prTitle,
    repoFullName: card.repoFullName,
    authorLogin: author?.githubLogin ?? null,
    authorDisplayName: author?.displayName ?? null,
    authorAvatarUrl: author?.avatarUrl ?? null,
  };
}

function UserChip({
  id,
  usersById,
}: {
  id: number;
  usersById: Map<number, User>;
}): JSX.Element {
  const u = usersById.get(id);
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px]">
      <Avatar user={u} size={13} />
      <UserName user={u} fallbackId={id} />
    </span>
  );
}

// A small vendor pill for an automated reviewer — the same 🤖 chip grammar the bot-signal
// card + provenance badges use (color from automatedReviewerMeta). Rendered on an untouched
// thread whose original commenter is a classified review bot.
function BotVendorPill({ kind }: { kind: AutomatedReviewerKind }): JSX.Element {
  const meta = automatedReviewerMeta(kind);
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium"
      style={{ color: meta.color, background: `${meta.color}1a` }}
      title="This thread was opened by an automated reviewer"
    >
      <BotIcon size={12} />
      {meta.label}
    </span>
  );
}

// At-a-glance CI dot + files-changed count + a green/red LOC delta — mirrors the
// PR-detail size label (ChangesTab / PrDetail).
export function PrMetaRow({ pr }: { pr: InsightPrRef }): JSX.Element {
  const ci = pr.ciStatus ? CI_META[pr.ciStatus] : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
      <span className="inline-flex items-center gap-1" title={ci?.label ?? 'no checks'}>
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
          aria-hidden
        />
        {ci?.label ?? 'no checks'}
      </span>
      <span>
        {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
      </span>
      <span className="font-mono">
        <span className="text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
        <span className="text-red-500 dark:text-red-400">−{pr.deletions}</span>
      </span>
    </div>
  );
}

// Collapsible PR summary: the plain description (markdown) + the Pro AI summary with its own inline
// Generate/Regenerate action (AiSummary self-gates on the prSummary capability). Lazy: the PR detail
// is fetched only when expanded.
export function InsightPrSummary({ prId }: { prId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronIcon
          dir={open ? 'down' : 'right'}
          size={10}
          className="inline-block align-[-0.1em]"
        />{' '}
        PR summary
      </button>
      {open && <InsightPrSummaryBody prId={prId} />}
    </div>
  );
}

function InsightPrSummaryBody({ prId }: { prId: number }): JSX.Element {
  const { data: pr, isLoading } = usePr(prId);
  if (isLoading) return <div className="mt-1 text-[11px] text-gray-400">Loading…</div>;
  if (!pr) return <div className="mt-1 text-[11px] text-gray-400">Couldn’t load this PR.</div>;
  const hasBody = pr.body != null && pr.body.trim() !== '';
  return (
    <div className="mt-1 space-y-2 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-900/40">
      {hasBody ? (
        <div className="max-h-64 overflow-auto text-sm">
          <Markdown>{pr.body as string}</Markdown>
        </div>
      ) : (
        <div className="text-[11px] italic text-gray-400">No PR description.</div>
      )}
      <AiSummary pr={pr} />
    </div>
  );
}

// The untouched review thread rendered in full, exactly as the Feed does it — code anchor, every
// reply, and the inline Reply + Resolve controls (ThreadCard). Fetched on demand by thread id.
function InsightThread({ card }: { card: UntouchedThreadCard }): JSX.Element {
  const { data: thread, isLoading } = useThread(card.threadId);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const prUrl = `https://github.com/${card.repoFullName}/pull/${card.prNumber}`;
  if (isLoading) return <div className="px-1 py-2 text-xs text-gray-400">Loading conversation…</div>;
  if (!thread)
    return <div className="px-1 py-2 text-xs text-gray-400">Couldn’t load this conversation.</div>;
  return <ThreadCard thread={thread} usersById={usersById} prUrl={prUrl} repoId={card.repoId} />;
}

// Suggested reviewers + rationale + a single "Assign" button that requests them on the PR
// (server-gated on write access; drops the author + bots). Once requested, ['workspace-insights'] +
// ['attention-cards'] are invalidated → the card leaves the board on the next refresh.
//
// ⚠ EVERY "team" BELOW IS GITHUB'S OWN, not a Limn Workspace: `ReviewerSuggestion.kind === 'team'`
// carries an `@org/team` slug that addresses GitHub's review-request API. The word must NOT be
// renamed here — it is the opposite category to a Workspace, which is our own grouping of repos.
function RoutingReviewers({
  card,
  usersById,
}: {
  card: ReviewerRoutingCard;
  usersById: Map<number, User>;
}): JSX.Element {
  const request = useRequestReviewers(card.prId);
  const suggestions = card.suggestedReviewers;
  const userIds = suggestions
    .filter((s) => s.kind === 'user' && s.userId != null)
    .map((s) => s.userId as number);
  const logins = suggestions
    .filter((s) => s.kind === 'user' && s.userId == null && s.login != null)
    .map((s) => s.login as string);
  const teamSlugs = suggestions
    .filter((s) => s.kind === 'team' && s.teamSlug != null)
    .map((s) => s.teamSlug as string);
  const done = request.isSuccess;
  const keyOf = (s: (typeof suggestions)[number]): string =>
    s.kind === 'team' ? `team:${s.teamSlug}` : `user:${s.login ?? s.userId}`;
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <span className="font-medium">Suggested reviewers</span>
        <button
          type="button"
          onClick={() => request.mutate({ userIds, logins, teamSlugs })}
          disabled={request.isPending || done || suggestions.length === 0}
          className="rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/20"
          title="Request these reviewers on GitHub"
        >
          {done ? (
            <>
              <CheckIcon size={11} className="inline-block align-[-0.1em]" /> Requested
            </>
          ) : request.isPending ? (
            'Assigning…'
          ) : (
            `Assign${suggestions.length > 1 ? ' all' : ''}`
          )}
        </button>
      </div>
      <ul className="space-y-1">
        {suggestions.map((s) => (
          <li key={keyOf(s)} className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
            {s.kind === 'team' ? (
              <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] font-medium">
                @{s.teamName}
              </span>
            ) : s.userId != null ? (
              <UserChip id={s.userId} usersById={usersById} />
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px]">
                @{s.login}
              </span>
            )}
            <span className="text-gray-400">{s.reason}</span>
          </li>
        ))}
      </ul>
      {request.isError && (
        <div className="text-[11px] text-red-500">
          {(request.error as Error)?.message ?? 'Couldn’t request reviewers.'}
        </div>
      )}
    </div>
  );
}

// "Done" — the mark-as-seen control on a my_turn card. POSTs /api/my-turn/dismiss; the mutation
// hook drops the card from the cached board immediately (optimistic) and re-fetches on settle, so
// the click is never inert. The dismissal is honoured only until NEWER activity supersedes it —
// a fresh reply on a dismissed thread brings the item back — which is why the copy is "Done" and
// the tooltip says "seen", not "mute" or "dismiss forever".
function MyTurnDoneButton({
  kind,
  refId,
  cardId,
}: {
  kind: MyTurnDismissKind;
  refId: number;
  cardId: string;
}): JSX.Element {
  const dismiss = useDismissMyTurn();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => dismiss.mutate({ kind, refId, cardId })}
        disabled={dismiss.isPending}
        className="rounded border border-emerald-300 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
        title="Mark this as seen. It comes back if there's newer activity."
      >
        {dismiss.isPending ? (
          'Marking…'
        ) : (
          <>
            <CheckIcon size={11} className="inline-block align-[-0.1em]" /> Done
          </>
        )}
      </button>
      {dismiss.isError && (
        <span className="text-[11px] text-red-500">
          {(dismiss.error as Error)?.message ?? 'Couldn’t mark it done.'}
        </span>
      )}
    </span>
  );
}

// The actions row of a my_turn card. Exactly one section — 'your_pr' — has NO dismissal kind:
// opening the PR stamps `pr_views`, which is what drops it from the fold (PrDetail fires
// `markPrViewed` on mount, unconditionally). So that reason gets an honest hint instead of a
// button that would have nothing to POST.
//
// The copy promises "as soon as you come back", not "on the next refresh", because
// `markViewed.onSuccess` invalidates ['attention-cards'] + ['daily-brief'] at the prefix — the
// board is already refetching while the user is still in the PR. If that invalidation is ever
// dropped, this sentence becomes a lie with a 60s staleTime behind it.
function MyTurnActions({ card }: { card: MyTurnCard }): JSX.Element | null {
  if (card.reason === 'your_pr') {
    return (
      <div className="mt-2 text-[11px] italic text-gray-400">
        Opening the PR marks it seen — this card clears as soon as you come back.
      </div>
    );
  }
  // Defensive: the other five reasons all carry a dismissRefId by contract (their `reason` IS
  // the dismissal kind). If one ever arrives without, render no control — a Done button with
  // nothing to POST is the inert card this whole surface exists to remove.
  if (card.dismissRefId == null) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <MyTurnDoneButton kind={card.reason} refId={card.dismissRefId} cardId={card.id} />
    </div>
  );
}

function CardShell({
  card,
  right,
  onActivate,
  children,
  innerRef,
  flash = false,
  why,
  promoted = false,
}: {
  card: InsightCard;
  right?: React.ReactNode;
  onActivate?: () => void;
  children: React.ReactNode;
  innerRef?: (el: HTMLLIElement | null) => void;
  flash?: boolean;
  /**
   * ONE SENTENCE OF MODEL PROSE about why this row is worth doing now (Pro `workPlan`), or
   * undefined on every free account and every un-narrated row.
   *
   * ⚠ THE LABELLED-APART RULE. A model-derived line and a code-derived figure may never share a
   * line. Everything in `children` — chips, counts, `detail` — is DATA in neutral ink and renders
   * whether or not anything was ever generated; this gets its own line, its own palette
   * (`--ai-*`), its own type style and a SparkleIcon. The board is fully usable with every one of
   * these absent, which is what makes the narration safe to sell separately.
   */
  why?: string;
  /** This card's PR is already seated in the "Do next" head above — see AttentionCards'
   *  `promotedPrIds`. It renders a back-reference so the row does not read as a second job. */
  promoted?: boolean;
}): JSX.Element {
  const sev = SEV[card.severity];
  const onClick = onActivate
    ? (e: React.MouseEvent): void => {
        if ((e.target as HTMLElement).closest('a,button,textarea,input,[data-noactivate]')) return;
        onActivate();
      }
    : undefined;
  return (
    <li
      ref={innerRef}
      onClick={onClick}
      className={`rounded-lg border border-l-4 border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40 ${sev.border}${
        flash ? ' ring-2 ring-sky-400/70' : ''
      }${onActivate ? ' cursor-pointer hover:bg-gray-50/70 dark:hover:bg-gray-900/60' : ''}`}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${sev.dot}`} aria-hidden />
        <span className="font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {cardKindLabel(card)}
        </span>
        {promoted && (
          <span
            className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-gray-500 dark:text-gray-400"
            title="This pull request is already listed in “Do next” above — same PR, a different thing to do on it."
          >
            already in Do next
          </span>
        )}
        <span className="ml-auto text-gray-400">{right}</span>
      </div>
      {children}
      {/* GENERATED. Its own line, never mixed with a chip — see the `why` prop's contract. */}
      {why != null && why.trim() !== '' && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] italic text-ai-ink">
          <SparkleIcon size={11} className="mt-0.5 shrink-0 not-italic text-ai-signal" />
          <span className="min-w-0">{why}</span>
        </p>
      )}
    </li>
  );
}

function PrLine({
  card,
  onOpen,
}: {
  card:
    | MyTurnCard
    | StalledReviewCard
    | UntouchedThreadCard
    | ReviewerRoutingCard
    | MergeReadyCard
    | UpdateBranchCard;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 truncate text-left font-medium text-gray-800 hover:underline dark:text-gray-100"
        title="Open this PR on its Overview tab"
      >
        <span className="text-gray-400">
          {card.repoFullName} #{card.prNumber}
        </span>{' '}
        {card.prTitle}
      </button>
      <a
        href={card.githubUrl}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        title="Open on GitHub"
      >
        <ExternalLinkIcon />
      </a>
    </div>
  );
}

// The body of a `ci_failing` card. The REPO is the subject on both arms (it is the one thing that
// is always there), the PR is an optional second line, and the external link goes wherever the
// server pointed it — the PR page on 'your_pr', the COMMIT page on 'trunk', where a trunk run's
// checks actually live.
function CiFailingBody({
  card,
  usersById,
  onOpenPr,
}: {
  card: CiFailingCard;
  usersById: Map<number, User>;
  onOpenPr: (meta: PinnedPr, returnItemId?: string) => void;
}): JSX.Element {
  const ci = CI_META[card.ciStatus] ?? null;
  const href = safeExternalUrl(card.githubUrl);
  const hasPr = card.prId != null && card.prNumber != null && card.prTitle != null;
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
        <span className="min-w-0 truncate font-medium text-gray-800 dark:text-gray-100">
          <span className="text-gray-400">{card.repoFullName}</span>{' '}
          {card.arm === 'trunk' ? 'trunk is red' : 'your PR is red'}
        </span>
        {href != null && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={card.arm === 'trunk' ? 'Open the commit on GitHub' : 'Open the PR on GitHub'}
          >
            <ExternalLinkIcon />
          </a>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1" title={ci?.label ?? card.ciStatus}>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
            aria-hidden
          />
          {ci?.label ?? card.ciStatus}
        </span>
        {card.headSha != null && <span className="font-mono">{card.headSha.slice(0, 7)}</span>}
      </div>
      {hasPr && (
        // ⚠ RENDERED ONLY WHEN THERE IS ONE. On the 'trunk' arm a missing PR is ORDINARY — ~11% of
        // red heads are direct pushes to the default branch — so the card says trunk is red and
        // simply names no PR, rather than showing an empty "landed by" row.
        <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span>{card.arm === 'trunk' ? 'landed by' : 'PR'}</span>
          {card.arm === 'trunk' && card.mergedById != null && (
            <UserChip id={card.mergedById} usersById={usersById} />
          )}
          <button
            type="button"
            onClick={() =>
              onOpenPr(
                metaFor(
                  {
                    prId: card.prId as number,
                    prNumber: card.prNumber as number,
                    prTitle: card.prTitle as string,
                    repoFullName: card.repoFullName,
                  },
                  usersById,
                ),
                card.id,
              )
            }
            className="min-w-0 truncate text-left hover:underline"
            title="Open this PR on its Overview tab"
          >
            <span className="text-gray-400">#{card.prNumber}</span> {card.prTitle}
          </button>
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium text-gray-600 dark:text-gray-300">
          {card.arm === 'your_pr' ? 'Your PR' : 'Your repo'}
        </span>
        <span className="min-w-0">{card.detail}</span>
      </div>
      {card.arm === 'trunk' && (
        // ⚠ THE HONEST CAVEAT, ON THE CARD ITSELF. `viewerMerged` says the viewer LANDED the commit
        // trunk is currently red at — it is NOT a claim that they broke the build. Trunk CI is
        // non-monotone and we store no per-commit transition history, so nothing here can name the
        // commit that turned it red; saying so on the card is cheaper than being asked.
        <div className="mt-1 text-[11px] italic text-gray-400">
          Trunk is red at this commit — not necessarily because of it.
        </div>
      )}
    </>
  );
}

/**
 * Does the "Everything else" divider render, and where?
 *
 * ⚠ BOTH BOUNDS MATTER AND EACH GUARDS A REAL STATE.
 *   • `headCount > 0` — the HEADLESS board, which is COMMON, not an edge: every isolated board
 *     suppresses the head (every daily-brief line click, the Welcome-back banner, every workspace
 *     "Elsewhere" row), as does any response predating `doNextIds`. Without this the board opens
 *     with a divider and nothing above it.
 *   • `headCount < total` — the head swallowing the whole board, where a trailing rule would
 *     introduce an empty section.
 *
 * Exported so this is pinned by a test rather than by reading the JSX.
 */
export function shouldShowDivider(headCount: number | undefined, total: number): boolean {
  return headCount != null && headCount > 0 && headCount < total;
}

export function AttentionCards({
  cards,
  users,
  headCount,
  whyById,
  parked,
  promotedPrIds,
}: {
  /** ALREADY PARTITIONED by the caller: the ranked head first, then everything else. This is one
   *  list, not two — see `headCount`. */
  cards: InsightCard[];
  users: User[] | undefined;
  /**
   * How many leading cards form the "Do next" head. A divider `<li>` is rendered BEFORE index
   * `headCount`, inside the same `<ul>`.
   *
   * ⚠ ZERO IS THE COMMON CASE, NOT AN EDGE — every isolated board (every daily-brief line click,
   * the Welcome-back banner, every workspace "Elsewhere" row) suppresses the head, as does any
   * response predating `doNextIds`. Hence the explicit `headCount > 0` guard below: without it
   * the board opens with an "Everything else" rule and nothing above it.
   */
  headCount?: number;
  /** Pro `workPlan` narration, keyed by CARD id. Absent on every free account. See CardShell's
   *  `why` for the labelled-apart rule. */
  whyById?: Map<string, string>;
  /** Pro: one sentence on what can wait. Rendered on the divider, where "everything else"
   *  literally begins — never above the head, which would frame the day's work as deferrable. */
  parked?: string | null;
  /**
   * PRs already seated in the head. A TAIL card for one of these is a second card about a PR the
   * reader has already been told to do — it renders a quiet back-reference rather than reading as
   * a separate job.
   *
   * ⚠ IT MARKS, IT DOES NOT DROP. Removing the sibling would break `head ∪ tail === cards` and,
   * through it, every cap disclosure on this board (`capFor` gates on `shown === count`).
   */
  promotedPrIds?: Set<number>;
}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const selectThread = useFilters((s) => s.selectThread);
  const usersById = useMemo(() => indexUsers(users), [users]);

  // Back-from-a-click flash — EXACT parity with the Feed (FeedView): a real browser Back pops a
  // URL that lands on Activity, and `applyUrlTab({ fromPop: true })` promotes the pending return
  // target into the one-shot activityFlashItemId (the returnItemId we stamped when opening the
  // PR = the card's id); on return we scroll that card into view and flash it.
  const flashTarget = usePinnedTabs((s) => s.activityFlashItemId);
  const clearFlash = usePinnedTabs((s) => s.clearActivityFlashItem);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (flashTarget == null) return;
    const id = flashTarget;
    const raf = requestAnimationFrame(() => {
      const el = rowRefs.current.get(id);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlashId(id);
        window.setTimeout(() => setFlashId((c) => (c === id ? null : c)), 1800);
      }
      clearFlash();
    });
    return () => cancelAnimationFrame(raf);
  }, [flashTarget, clearFlash]);
  const setCardRef = (id: string, el: HTMLLIElement | null): void => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  };

  // The PR title opens the PR detail on its Overview tab; the card body opens "the event in
  // question". For a thread that event is the thread itself — the PR detail opens on its Threads
  // tab, deep-linked to the thread.
  const open = (meta: PinnedPr, returnItemId?: string): void =>
    openPrDetailTab(meta, { fromActivity: true, returnItemId });
  // Thread-shaped navigation, shared by the untouched-thread card and a my_turn card whose
  // reason is 'thread' (the thread id is on a different field on each, so it's a parameter).
  const openThreadOn = (card: InsightPrRef & { id: string }, threadId: number): void => {
    openPrDetailTab(metaFor(card, usersById), { fromActivity: true, returnItemId: card.id });
    selectThread(card.prId, threadId);
  };
  const openThread = (card: UntouchedThreadCard): void => openThreadOn(card, card.threadId);

  const renderCard = (card: InsightCard, promoted = false): JSX.Element | null => {
    switch (card.kind) {
      // The VIEWER'S OWN inbox as cards — the same population GET /api/my-turn serves, and the
      // list the daily brief's "N need your review or reply" line counts. Clicking opens the PR
      // (or, for a thread, the thread on the PR's Threads tab); "Done" marks it seen.
      //
      // ⚠ Deliberately LEANER than the untouched-thread card: no embedded ThreadCard and no
      // InsightPrSummary. This kind carries its own much larger cap (MY_TURN_CARD_CAP = 50 vs 15
      // for the survey kinds), so a per-card thread fetch would be up to 50 requests to paint one
      // board — the `ThreadAssessment` failure mode. A thread-reason card navigates to the thread
      // instead.
      case 'my_turn':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            promoted={promoted}
            right={<span title={dateTime(card.since)}>{relativeTime(card.since)}</span>}
            onActivate={() =>
              card.reason === 'thread' && card.threadId != null
                ? openThreadOn(card, card.threadId)
                : open(metaFor(card, usersById), card.id)
            }
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} />
            <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium text-gray-600 dark:text-gray-300">
                {MY_TURN_REASON_LABEL[card.reason]}
              </span>
              <span className="min-w-0">{card.detail}</span>
            </div>
            <MyTurnActions card={card} />
          </CardShell>
        );
      // A red build the viewer is on the hook for. TWO ARMS on one kind, and every PR field is
      // NULLABLE because the 'trunk' arm often has no PR at all (a direct push to the default
      // branch, an association not observed yet) — so this renders the REPO as the subject and the
      // PR as an optional line under it, rather than reusing PrLine (which requires all four).
      case 'ci_failing':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            promoted={promoted}
            right={
              card.observedAt != null ? (
                <span title={dateTime(card.observedAt)}>{relativeTime(card.observedAt)}</span>
              ) : undefined
            }
            // Only the 'your_pr' arm has a PR to open by construction; a 'trunk' card without a
            // landing PR has nothing to activate, and a whole-card click that did nothing would be
            // the inert card this board exists to remove.
            onActivate={
              card.prId != null && card.prNumber != null && card.prTitle != null
                ? (): void =>
                    open(
                      metaFor(
                        {
                          prId: card.prId as number,
                          prNumber: card.prNumber as number,
                          prTitle: card.prTitle as string,
                          repoFullName: card.repoFullName,
                        },
                        usersById,
                      ),
                      card.id,
                    )
                : undefined
            }
          >
            <CiFailingBody card={card} usersById={usersById} onOpenPr={open} />
          </CardShell>
        );
      case 'stalled_review':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            promoted={promoted}
            right={`waiting ${ageLabel(card.ageHours)}`}
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
              <span>waiting on</span>
              {card.requestedReviewerIds.length > 0 || card.requestedTeamNames.length > 0 ? (
                <>
                  {card.requestedReviewerIds.map((id) => (
                    <UserChip key={id} id={id} usersById={usersById} />
                  ))}
                  {/* GitHub's own teams (display names), same chip grammar as RoutingReviewers */}
                  {card.requestedTeamNames.map((name) => (
                    <span
                      key={`team:${name}`}
                      className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] font-medium"
                    >
                      @{name}
                    </span>
                  ))}
                </>
              ) : (
                <span className="italic">no reviewer requested</span>
              )}
            </div>
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      case 'untouched_thread':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            promoted={promoted}
            right={`${ageLabel(card.ageHours)} old`}
          >
            {/* Only this header chrome navigates (→ the thread on the PR's Threads tab). The
                embedded conversation + PR summary below are for reading/replying in place. */}
            <div
              className="-m-1 cursor-pointer rounded p-1 hover:bg-gray-50/70 dark:hover:bg-gray-900/60"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a,button')) return;
                openThread(card);
              }}
            >
              <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
              <PrMetaRow pr={card} />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-mono">{card.path}</span>
                <span>· no reply since</span>
                {card.originalCommenterId != null && (
                  <UserChip id={card.originalCommenterId} usersById={usersById} />
                )}
                {card.botKind != null && <BotVendorPill kind={card.botKind} />}
              </div>
            </div>
            <div className="mt-2">
              <InsightThread card={card} />
            </div>
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      case 'reviewer_routing':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            promoted={promoted}
            right="unassigned"
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} />
            {card.topPaths.length > 0 && (
              <div className="mt-1 truncate text-[11px] text-gray-400">
                touches <span className="font-mono">{card.topPaths.slice(0, 3).join(', ')}</span>
              </div>
            )}
            <RoutingReviewers card={card} usersById={usersById} />
            <InsightPrSummary prId={card.prId} />
          </CardShell>
        );
      // ── the two FORWARD kinds, sharing one case ─────────────────────────────────────────
      // ⚠ THIS CASE IS NOT OPTIONAL AND tsc DOES NOT DEMAND IT. The union widening forces
      // `KIND_LABEL` and the server's `kindRank`, but the `default: return null` below swallows a
      // missing case in silence — the card vanishes while the ranked head still names its id and
      // the board comes up a row short. That is exactly how `my_turn` shipped invisible.
      //
      // ⚠ NO "Done" CONTROL, deliberately. These carry no `dismissRefId` because they are
      // SELF-CLEARING: the card is gone the moment the PR merges or falls behind, unlike a
      // "new PR" my_turn row that persists until someone acts on it. Dismissing a fact about
      // GitHub's merge state would be dismissing the world, not an item.
      case 'merge':
      case 'update_branch': {
        const state = MERGE_STATE_LABEL[card.mergeStateStatus];
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            promoted={promoted}
            why={whyById?.get(card.id)}
            right={
              card.lastCommitAt != null ? (
                <span title={dateTime(card.lastCommitAt)}>{relativeTime(card.lastCommitAt)}</span>
              ) : undefined
            }
            onActivate={() => open(metaFor(card, usersById), card.id)}
          >
            <PrLine card={card} onOpen={() => open(metaFor(card, usersById), card.id)} />
            <PrMetaRow pr={card} />
            <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              {state != null && (
                <span className="rounded bg-gray-500/10 px-1.5 py-0.5 font-medium text-gray-600 dark:text-gray-300">
                  {state}
                </span>
              )}
              {/* CODE-WRITTEN, and the ONE spelling — `mergeCardDetail` on the server also writes
                  the ranked row's `reason`. */}
              <span className="min-w-0">{card.detail}</span>
            </div>
          </CardShell>
        );
      }
      case 'reviewer_load':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
            promoted={promoted}
            right={`${card.reviewsThisSprint} review${card.reviewsThisSprint === 1 ? '' : 's'} this sprint`}
          >
            <div className="flex items-center gap-2 text-sm">
              <UserChip id={card.reviewerId} usersById={usersById} />
              <span className="font-semibold text-gray-800 dark:text-gray-100">
                {card.pendingCount} pending review{card.pendingCount === 1 ? '' : 's'}
              </span>
            </div>
            {card.pendingPrs.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {card.pendingPrs.map((p) => (
                  <li key={p.prId} className="truncate text-[11px]">
                    <button
                      type="button"
                      onClick={() =>
                        open(
                          {
                            id: p.prId,
                            number: p.prNumber,
                            title: p.prTitle,
                            repoFullName: p.repoFullName,
                            authorLogin: null,
                            authorDisplayName: null,
                            authorAvatarUrl: null,
                          },
                          card.id,
                        )
                      }
                      className="text-left text-gray-500 hover:underline dark:text-gray-400"
                    >
                      <span className="text-gray-400">
                        {p.repoFullName} #{p.prNumber}
                      </span>{' '}
                      {p.prTitle}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardShell>
        );
      // ⚠ The two bot kinds are filtered out upstream (they live in the free Bots console), so
      // this arm is unreachable for them. It is ALSO where a NEW InsightKind lands, and it
      // renders NOTHING and throws NOTHING — a kind the server emits and this switch has no case
      // for simply vanishes, while the brief line that counts it keeps its number. That is
      // exactly how `my_turn` shipped invisible; add a case whenever the union grows.
      default:
        return null;
    }
  };

  const showDivider = shouldShowDivider(headCount, cards.length);
  /** True for a TAIL card whose PR is already seated in the head — see `promotedPrIds`. */
  const isPromotedSibling = (card: InsightCard, index: number): boolean =>
    headCount != null &&
    index >= headCount &&
    promotedPrIds != null &&
    'prId' in card &&
    card.prId != null &&
    promotedPrIds.has(card.prId);

  // ⚠ ONE `<ul>`, ONE `<AttentionCards>` MOUNT — never a head list and a tail list. Two mounts
  // would race on the single `usePinnedTabs.activityFlashItemId` token: each mount's rAF calls
  // `clearFlash()` unconditionally, so whichever ran second would clear a flash the first had
  // just claimed. Today's correctness there is a scheduling coincidence, not a design.
  return (
    <ul className="space-y-2">
      {cards.flatMap((card, i) =>
        showDivider && i === headCount
          ? [
              <li key="__do-next-divider" className="flex items-baseline gap-2 pt-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  Everything else
                </span>
                <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" aria-hidden />
                {parked != null && parked.trim() !== '' && (
                  <span className="flex items-start gap-1 text-[11px] italic text-ai-ink">
                    <SparkleIcon size={11} className="mt-0.5 shrink-0 not-italic text-ai-signal" />
                    <span className="min-w-0">{parked}</span>
                  </span>
                )}
              </li>,
              renderCard(card, isPromotedSibling(card, i)),
            ]
          : [renderCard(card, isPromotedSibling(card, i))],
      )}
    </ul>
  );
}
