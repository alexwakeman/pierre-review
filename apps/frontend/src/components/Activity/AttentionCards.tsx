import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutomatedReviewerKind,
  InsightCard,
  InsightPrRef,
  InsightSeverity,
  ReviewerRoutingCard,
  StalledReviewCard,
  UntouchedThreadCard,
  User,
} from '@pierre-review/shared';
import { usePr, useThread } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useRequestReviewers } from '../../hooks/usePrWrites.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import { automatedReviewerMeta, CI_META, indexUsers } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { AiSummary } from '../AiSummary.js';
import { ThreadCard } from '../ThreadView/index.js';

// The attention-card list — the stalled-review / untouched-thread / reviewer-load / needs-a-reviewer
// cards, with the full drill-down behaviour (click a card to open the PR / thread, inline thread
// reply+resolve, suggested-reviewer assign, lazy PR summary, and back-from-a-click flash). Extracted
// from InsightsView so it can be rendered in BOTH the (Pro) Insights pane and the CORE/free Feed
// "Needs attention" tab — the same JSX, just fed from a different data hook. It depends only on core
// stores/hooks (usePinnedTabs / useFilters / usePr / useThread / useRequestReviewers), so it's tier-
// agnostic. Callers pass already-filtered `cards` (bot cards excluded upstream).

// Left-accent + label per severity — the same visual grammar as the Feed's cards.
const SEV: Record<InsightSeverity, { border: string; dot: string }> = {
  high: { border: 'border-l-red-400 dark:border-l-red-500', dot: 'bg-red-500' },
  warn: { border: 'border-l-amber-400 dark:border-l-amber-500', dot: 'bg-amber-500' },
  info: { border: 'border-l-sky-400 dark:border-l-sky-500', dot: 'bg-sky-500' },
};

const KIND_LABEL: Record<InsightCard['kind'], string> = {
  bot_signal: 'Review-bot signal',
  bot_only_review: 'Only a bot reviewed',
  stalled_review: 'Stalled review',
  untouched_thread: 'Untouched thread',
  reviewer_load: 'Review load',
  reviewer_routing: 'Needs a reviewer',
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
      🤖 {meta.label}
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
        {open ? '▾' : '▸'} PR summary
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
          {done
            ? '✓ Requested'
            : request.isPending
              ? 'Assigning…'
              : `Assign${suggestions.length > 1 ? ' all' : ''}`}
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

function CardShell({
  card,
  right,
  onActivate,
  children,
  innerRef,
  flash = false,
}: {
  card: InsightCard;
  right?: React.ReactNode;
  onActivate?: () => void;
  children: React.ReactNode;
  innerRef?: (el: HTMLLIElement | null) => void;
  flash?: boolean;
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
          {KIND_LABEL[card.kind]}
        </span>
        <span className="ml-auto text-gray-400">{right}</span>
      </div>
      {children}
    </li>
  );
}

function PrLine({
  card,
  onOpen,
}: {
  card: StalledReviewCard | UntouchedThreadCard | ReviewerRoutingCard;
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
        ↗
      </a>
    </div>
  );
}

export function AttentionCards({
  cards,
  users,
}: {
  cards: InsightCard[];
  users: User[] | undefined;
}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const selectThread = useFilters((s) => s.selectThread);
  const usersById = useMemo(() => indexUsers(users), [users]);

  // Back-from-a-click flash — EXACT parity with the Feed (FeedView): a real browser Back
  // (navigateBack) sets a one-shot activityFlashItemId (the returnItemId we stamped when opening
  // the PR = the card's id); on return we scroll that card into view and flash it.
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
  const openThread = (card: UntouchedThreadCard): void => {
    openPrDetailTab(metaFor(card, usersById), { fromActivity: true, returnItemId: card.id });
    selectThread(card.prId, card.threadId);
  };

  const renderCard = (card: InsightCard): JSX.Element | null => {
    switch (card.kind) {
      case 'stalled_review':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
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
      case 'reviewer_load':
        return (
          <CardShell
            key={card.id}
            card={card}
            innerRef={(el) => setCardRef(card.id, el)}
            flash={flashId === card.id}
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
      default:
        return null;
    }
  };

  return <ul className="space-y-2">{cards.map((card) => renderCard(card))}</ul>;
}
