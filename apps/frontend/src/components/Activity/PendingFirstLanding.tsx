import { useState } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AttentionCardsResponse,
  PendingAuthorLens,
  PendingOwnPr,
  PendingReviewSuggestion,
  PendingTab,
  PendingTabKey,
} from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { useStartReviewFromList, useClaudeReviewStarting } from '../../hooks/useClaudeReview.js';
import { useMe } from '../../hooks/useTriage.js';
import { aiAuthFor } from '../../lib/aiCapabilities.js';
import { ownPrVerdict, pendingSummaryParts } from '../../lib/pendingFirstLanding.js';
import { unlockReviewSound } from '../../lib/sound.js';
import { relativeTime } from '../../lib/ui.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { AiRunGate } from '../AiSetup.js';
import { CheckCircleIcon, CloseIcon, PullRequestIcon, SparkleIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button, IconButton, cx, FOCUS_RING, TEXT_LINK } from '../ui/index.js';

// PENDING ON THE FIRST LANDING (docs/FRONTEND.md § Pending on the first landing). Three pieces, all
// drawn from the board response the page already holds — NOTHING HERE FETCHES ON MOUNT:
//   • `PendingSummaryLine`   — "3 waiting on you · 2 to fix", each part a link to its tab;
//   • `PendingEmptyBoard`    — every tab empty: says so, then the reader's own open PRs, each with
//                              its PLAIN merge verdict (`mergeVerdict()` over synced fields, never the
//                              ranked blockers — those are PR detail's) and a link to the PR;
//   • `ReviewSuggestionCard` — the one-time "Review your PR #n with Claude"; runs only on a click.

const LINK = cx('rounded-ui', TEXT_LINK, FOCUS_RING);

export function PendingSummaryLine({
  tabs,
  lens,
  onOpenTab,
}: {
  tabs: readonly PendingTab[];
  lens: PendingAuthorLens | null;
  onOpenTab: (tab: PendingTabKey) => void;
}): JSX.Element | null {
  const parts = pendingSummaryParts(tabs, lens);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1 text-body text-ui-mute" data-testid="pending-summary">
      {parts.map((p, i) => (
        <span key={p.tab} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-ui-faint">·</span>}
          <button type="button" className={LINK} onClick={() => onOpenTab(p.tab)}>
            {p.text}
          </button>
        </span>
      ))}
    </p>
  );
}

/** The tab meta for opening one of the reader's own PRs (the reader is the author). */
function ownPrMeta(pr: PendingOwnPr, login: string | null): TabMeta {
  return {
    id: pr.prId,
    number: pr.number,
    title: pr.title,
    repoFullName: pr.repoFullName,
    authorLogin: login,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

const TONE: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
  ok: 'text-ui-success',
  warn: 'text-ui-warn',
  bad: 'text-ui-danger',
  muted: 'text-ui-mute',
};

export function PendingEmptyBoard({
  prs,
  total,
}: {
  prs: readonly PendingOwnPr[];
  total: number;
}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const login = useMe().data?.user?.login ?? null;
  return (
    <div className="px-5 py-6 max-md:px-3" data-testid="pending-empty-board">
      <p className="flex items-center gap-2 text-body text-ui-mute">
        <CheckCircleIcon size={14} className="decorative-mark shrink-0 text-ui-faint" />
        Nothing here needs you right now.
      </p>
      {prs.length > 0 && (
        <section className="mt-5" aria-label="Your open pull requests">
          <h3 className="flex items-center gap-1 text-meta font-medium text-ui-faint">
            Your open pull requests
            <InfoButton title="Your open pull requests">
              <p>
                Where each of your open pull requests stands for a merge, from the last sync. Open one to see
                what blocks it, live.
              </p>
            </InfoButton>
          </h3>
          <ul className="mt-1 divide-y divide-ui-line">
            {prs.map((pr) => {
              const { verdict, lines } = ownPrVerdict(pr);
              return (
                <li key={pr.prId} className="flex items-start gap-2 py-2">
                  <PullRequestIcon size={13} className="mt-1 shrink-0 text-ui-faint" />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className={cx(LINK, 'text-left text-body text-ui-ink')}
                      onClick={() => openPrDetailTab(ownPrMeta(pr, login), { fromActivity: true })}
                    >
                      {pr.title}
                    </button>
                    <p className="text-meta text-ui-faint">
                      {pr.repoFullName}#{pr.number} · opened {relativeTime(pr.openedAt)}
                    </p>
                    <p className="text-meta">
                      <span className={cx('font-medium', TONE[verdict.tone])}>{verdict.label}</span>
                      {lines.length > 0 && <span className="text-ui-mute"> · {lines.join(' · ')}</span>}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          {total > prs.length && (
            <p className="pt-2 text-meta text-ui-faint">
              The newest {prs.length} of your {total} open pull requests.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

/** Take the suggestion off every cached board at once — it is account-wide. */
function clearSuggestion(qc: QueryClient): void {
  qc.setQueriesData<AttentionCardsResponse>({ queryKey: ['attention-cards'] }, (d) =>
    d == null ? d : { ...d, reviewSuggestion: null },
  );
}

export function ReviewSuggestionCard({ suggestion }: { suggestion: PendingReviewSuggestion }): JSX.Element | null {
  const ai = useAiCapabilities();
  const costText = useRunCostText();
  const qc = useQueryClient();
  const start = useStartReviewFromList(suggestion.prId);
  const starting = useClaudeReviewStarting(suggestion.prId);
  const openClaudeTab = usePinnedTabs((s) => s.openPrDetailTab);
  const login = useMe().data?.user?.login ?? null;
  const [hidden, setHidden] = useState(false);
  const dismiss = useMutation({
    mutationFn: () => api.dismissReviewSuggestion(),
    onMutate: () => clearSuggestion(qc),
    onSettled: () => qc.invalidateQueries({ queryKey: ['attention-cards'] }),
  });
  // Only where a review can actually run: AI on, its runtime ready, and the provider signed in.
  if (hidden || !ai.enabled || ai.runtime !== 'ready' || aiAuthFor(ai, 'review').auth !== 'ok') return null;
  const cost = costText(suggestion.budgetUsd, ai.provider);
  const run = (): void => {
    unlockReviewSound();
    start.mutate(undefined, {
      onSuccess: () => {
        // A review ran: the server never suggests again. Open the PR so the run is in view.
        setHidden(true);
        clearSuggestion(qc);
        openClaudeTab(
          {
            id: suggestion.prId,
            number: suggestion.number,
            title: suggestion.title,
            repoFullName: suggestion.repoFullName,
            authorLogin: login,
            authorDisplayName: null,
            authorAvatarUrl: null,
          },
          { fromActivity: true },
        );
      },
    });
  };
  return (
    <section
      className="mx-5 mt-3 flex items-start gap-3 rounded-ui border border-ai-border bg-ai-surface px-3 py-2.5 max-md:mx-2"
      aria-label="AI review suggestion"
      data-testid="pending-review-suggestion"
    >
      <SparkleIcon size={14} className="mt-0.5 shrink-0 text-ai-signal" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-ui-ink">
          Review your PR #{suggestion.number} with {ai.providerName}
        </p>
        <p className="truncate text-meta text-ui-mute" title={suggestion.title}>
          {suggestion.repoFullName} · {suggestion.title}
        </p>
        {cost != null && <p className="text-meta text-ui-faint">Up to {cost}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AiRunGate kind="review" meter={false}>
            <Button size="sm" variant="primary" onClick={run} busy={starting} busyLabel="Starting…">
              Run review
            </Button>
          </AiRunGate>
          {start.isError && !starting && (
            <span className="text-meta text-ui-danger">{start.error.message || 'Could not start the review.'}</span>
          )}
        </div>
      </div>
      <IconButton
        label="Dismiss — don’t suggest this again"
        icon={<CloseIcon size={12} />}
        size="sm"
        onClick={() => {
          setHidden(true);
          dismiss.mutate();
        }}
      />
    </section>
  );
}
