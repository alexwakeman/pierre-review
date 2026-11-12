import { useState } from 'react';
import {
  AUTO_FIX_CI_REVIEW_WAIT_MS,
  AUTO_FIX_CI_WAIT_MAX_MS,
  AUTO_FIX_REVIEW_WAIT_MS,
  type AutoFixHistoryRow,
  type AutoFixQueueState,
} from '@pierre-review/shared';
import { useAutoFixPanel } from '../hooks/useAiFix.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useFilters } from '../store/filters.js';
import { ChevronIcon } from './Icons.js';
import { InfoButton } from './InfoModal.js';

// THE AUTO FIX QUEUE in the AI Review tab (docs/CLAUDE-REVIEW.md § AI Fix → The auto fix queue): what the
// next automatic fix of this PR waits for (one line, with the latest it waits), and every auto fix of the
// PR, newest first. DB only (`GET /api/pro/prs/:id/ai-fix/auto`). Shown while auto AI Fix is on for this
// PR, or once it has any auto fix. A row opens the AI Fix tab.

const minutes = (ms: number): number => Math.round(ms / 60_000);

/** "up to 12 min" from now, or null. Pure. */
export function waitLeftText(until: string | null, nowMs: number): string | null {
  if (until == null) return null;
  const left = Date.parse(until) - nowMs;
  if (!Number.isFinite(left)) return null;
  if (left <= 60_000) return 'less than a minute';
  return `up to ${Math.ceil(left / 60_000)} min`;
}

/** The queue's one line (shared words + how long it may wait). Pure. */
export function autoFixQueueText(q: AutoFixQueueState, nowMs: number): string {
  const left = q.status === 'waiting' ? waitLeftText(q.until, nowMs) : null;
  return left != null ? `${q.line.replace(/\.$/, '')} (${left}).` : q.line;
}

const STATUS_WORDS: Record<string, string> = {
  queued: 'Starting',
  running: 'Fixing',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  planned: 'Planned',
};

/** One history row's words: the status, what it worked on, the outcome. Pure. */
export function autoFixHistoryWords(h: AutoFixHistoryRow): { status: string; source: string; outcome: string | null } {
  const status = h.pushedAt != null ? 'Pushed' : h.error != null && h.status === 'succeeded' ? 'Push failed' : (STATUS_WORDS[h.status] ?? h.status);
  const source = h.sourceReviewId != null ? 'From the AI review' : 'From the CI review';
  const outcome =
    h.addressed != null
      ? `${h.addressed} of ${h.items} ${h.items === 1 ? 'point' : 'points'} addressed`
      : h.items > 0
        ? `${h.items} ${h.items === 1 ? 'point' : 'points'}`
        : null;
  return { status, source, outcome };
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function AutoFixQueuePanel({ prId }: { prId: number }): JSX.Element | null {
  // An AI surface: with AI off its routes are not registered, so ask nothing.
  const q = useAutoFixPanel(prId, useAiCapabilities().enabled);
  const openAiFix = useFilters((s) => s.openAiFixFromReview);
  const [open, setOpen] = useState(false);
  const d = q.data;
  if (d == null || !Array.isArray(d.history) || (!d.on && d.history.length === 0)) return null;
  const now = Date.now();
  return (
    <section data-testid="auto-fix-queue" aria-label="Auto fixes" className="mt-3 rounded-ui bg-ui-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-meta font-medium text-ui-ink">Auto fix</h4>
        <InfoButton title="Auto fix">
          <p>On your own pull requests, Limn starts a fix by itself when there is something to fix.</p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>It waits for the CI jobs on the latest commit to finish (at most {minutes(AUTO_FIX_CI_WAIT_MAX_MS)} minutes).</li>
            <li>When CI fails, it waits for the CI review to explain why (at most {minutes(AUTO_FIX_CI_REVIEW_WAIT_MS)} minutes).</li>
            <li>A CI fix waits up to {minutes(AUTO_FIX_REVIEW_WAIT_MS)} minutes for the AI review of the same commit, so one fix covers both.</li>
            <li>While a fix runs, the next one waits. It starts from what is still open on the latest commit, so nothing already fixed is done again.</li>
          </ul>
          <p className="mt-2">Each fix is pushed on its own when Push automatically is on (Settings → Workspace → Auto review).</p>
        </InfoButton>
        {d.queue != null && (
          <span data-testid="auto-fix-queue-line" data-status={d.queue.status} data-reason={d.queue.reason ?? undefined} className="text-meta text-ui-mute">
            {autoFixQueueText(d.queue, now)}
          </span>
        )}
        {d.queue == null && d.on && <span className="text-meta text-ui-mute">Nothing waiting.</span>}
      </div>
      {d.history.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            data-testid="auto-fix-history-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="hit flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink"
          >
            <ChevronIcon dir={open ? 'down' : 'right'} />
            {d.history.length} auto {d.history.length === 1 ? 'fix' : 'fixes'} on this pull request
          </button>
          {open && (
            <ul data-testid="auto-fix-history" className="mt-1 divide-y divide-ui-line/60">
              {d.history.map((h) => {
                const w = autoFixHistoryWords(h);
                return (
                  <li key={h.id} data-testid="auto-fix-history-row" className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-meta">
                    <span className="text-ui-mute">{when(h.createdAt)}</span>
                    <span className={`font-medium ${w.status === 'Failed' || w.status === 'Push failed' ? 'text-ui-danger' : 'text-ui-ink'}`}>{w.status}</span>
                    <span className="text-ui-mute">{w.source}</span>
                    {w.outcome != null && <span className="text-ui-mute">{w.outcome}</span>}
                    {h.pushedBranch != null && h.pushedAt != null && <span className="font-mono text-ui-mute">{h.pushedBranch}</span>}
                    <button type="button" className="hit ml-auto text-meta text-ui-ink underline" onClick={() => openAiFix(prId)}>
                      Open
                    </button>
                    {h.commitMessage != null && <span className="w-full truncate text-ui-mute">{h.commitMessage.split('\n')[0]}</span>}
                    {h.error != null && <span className="w-full break-words text-ui-danger">{h.error}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
