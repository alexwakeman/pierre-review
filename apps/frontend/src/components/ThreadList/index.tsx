import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewBotKind, ThreadDetail, User } from '@pierre-review/shared';
import { reviewBotKind } from '@pierre-review/shared';
import { useMyTurn } from '../../hooks/useTriage.js';
import { useResolveBotThreads } from '../../hooks/usePrWrites.js';
import { usePrBotDedup } from '../../hooks/useBotTriage.js';
import { useFilters } from '../../store/filters.js';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import { FileGroup } from './FileGroup.js';

interface FileBucket {
  path: string;
  threads: ThreadDetail[];
  // The most-recent thread's createdAt in this file, for newest-first ordering.
  newest: string;
}

function groupByFile(threads: ThreadDetail[]): FileBucket[] {
  const byPath = new Map<string, ThreadDetail[]>();
  for (const t of threads) {
    const arr = byPath.get(t.path) ?? [];
    arr.push(t);
    byPath.set(t.path, arr);
  }
  const buckets: FileBucket[] = [...byPath.entries()].map(([path, ts]) => ({
    path,
    threads: ts,
    newest: ts.reduce((m, t) => (t.createdAt > m ? t.createdAt : m), ''),
  }));
  // Files with the most-recent thread first (newest activity rises to the top);
  // path as a stable tiebreak.
  buckets.sort((a, b) => b.newest.localeCompare(a.newest) || a.path.localeCompare(b.path));
  return buckets;
}

// Which review vendor (if any) opened a thread — by its originating commenter's login.
function threadBotKind(t: ThreadDetail, usersById: Map<number, User>): ReviewBotKind | null {
  const authorId = t.originalCommenterId ?? t.comments[0]?.authorId ?? null;
  if (authorId == null) return null;
  return reviewBotKind(usersById.get(authorId)?.githubLogin);
}

export function ThreadList({
  threads,
  usersById,
  prUrl,
  prId,
  repoId,
  selectedThreadId,
  viewedSince,
  botFilter = null,
}: {
  threads: ThreadDetail[];
  usersById: Map<number, User>;
  prUrl: string;
  prId?: number;
  repoId?: number;
  selectedThreadId: number | null;
  viewedSince?: string | null;
  // When set, show ONLY this vendor's threads (from an Overview "Bots" chip click).
  botFilter?: ReviewBotKind | null;
}): JSX.Element {
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const setThreadBotFilter = useFilters((s) => s.setThreadBotFilter);
  const resolveBotThreads = useResolveBotThreads();
  const [confirming, setConfirming] = useState(false);

  // Threads in the user's My Turn set (awaiting their response) — drives the
  // per-thread "Done" affordance. Reads the already-loaded my-turn cache.
  const { data: myTurn } = useMyTurn();
  const awaitingThreadIds = useMemo(
    () => new Set((myTurn?.threadsAwaiting ?? []).map((t) => t.threadId)),
    [myTurn],
  );

  // Cross-bot dedup: (path,line) spots where ≥2 automated reviewers of DISTINCT vendors
  // both left a thread — the backend clusters + flags consensus/conflict; we surface a
  // compact rollup so the reader sees "CodeRabbit + Copilot both flagged line 42" without
  // scanning the whole file for the overlap. Account-scoped, deterministic (no AI).
  const { data: dedup } = usePrBotDedup(prId ?? null);
  const dedupClusters = dedup?.clusters ?? [];

  // Jump to a clustered thread's row (rowRefs is populated by FileGroup, keyed by thread id).
  const scrollToThread = (threadId: number): void => {
    rowRefs.current.get(threadId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Apply the vendor filter (Overview "Bots" chip → Threads tab scoped to that vendor).
  const shown = useMemo(
    () => (botFilter ? threads.filter((t) => threadBotKind(t, usersById) === botFilter) : threads),
    [threads, botFilter, usersById],
  );

  // The bot threads a later commit has LIKELY ADDRESSED — the set the bulk "clear backlog"
  // action can safely resolve (matches the server's getResolvableBotThreads eligibility).
  const addressedBotThreadIds = useMemo(
    () =>
      shown
        .filter(
          (t) => !t.isResolved && t.derivedState === 'likely_addressed' && threadBotKind(t, usersById),
        )
        .map((t) => t.id),
    [shown, usersById],
  );

  // Scroll to a thread selected from a timeline marker / popover.
  useEffect(() => {
    if (selectedThreadId == null) return;
    const el = rowRefs.current.get(selectedThreadId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedThreadId]);

  // A resolve empties the eligible set — leave "confirm" mode once nothing's left.
  useEffect(() => {
    if (addressedBotThreadIds.length === 0) setConfirming(false);
  }, [addressedBotThreadIds.length]);

  const buckets = useMemo(() => groupByFile(shown), [shown]);
  const vendor = botFilter ? BOT_VENDOR_META[botFilter] : null;

  const runBulkResolve = (): void => {
    if (prId == null || addressedBotThreadIds.length === 0) return;
    resolveBotThreads.mutate(
      { prId, threadIds: addressedBotThreadIds },
      { onSettled: () => setConfirming(false) },
    );
  };

  return (
    <div>
      {vendor && (
        <div
          className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-gray-100 bg-white/95 px-3 py-2 text-xs backdrop-blur dark:border-gray-800 dark:bg-gray-900/95"
          style={{ boxShadow: `inset 3px 0 0 ${vendor.color}` }}
        >
          <span className="font-medium" style={{ color: vendor.color }}>
            🤖 {vendor.label}
          </span>
          <span className="text-gray-500">
            {shown.length} thread{shown.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={() => setThreadBotFilter(null)}
            className="rounded px-1.5 py-0.5 text-gray-500 underline-offset-2 hover:underline"
          >
            Show all threads
          </button>

          {/* Phase 3: clear the addressed-bot backlog — never automatic, always confirm-gated. */}
          {addressedBotThreadIds.length > 0 && (
            <span className="ml-auto flex items-center gap-2">
              {confirming ? (
                <>
                  <span className="text-gray-500">
                    Resolve {addressedBotThreadIds.length} likely-addressed thread
                    {addressedBotThreadIds.length === 1 ? '' : 's'} on GitHub?
                  </span>
                  <button
                    type="button"
                    disabled={resolveBotThreads.isPending}
                    onClick={runBulkResolve}
                    className="rounded bg-green-600 px-2 py-0.5 font-medium text-white hover:bg-green-700 disabled:opacity-60"
                  >
                    {resolveBotThreads.isPending ? 'Resolving…' : 'Yes, resolve'}
                  </button>
                  <button
                    type="button"
                    disabled={resolveBotThreads.isPending}
                    onClick={() => setConfirming(false)}
                    className="rounded px-2 py-0.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="rounded border px-2 py-0.5 font-medium hover:opacity-80"
                  style={{ borderColor: vendor.color, color: vendor.color }}
                  title="A later commit touched the file these threads flag — resolve them in one click (you approve each batch)."
                >
                  Resolve {addressedBotThreadIds.length} addressed
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {resolveBotThreads.data && (resolveBotThreads.data.resolved > 0 || resolveBotThreads.data.failed > 0) && (
        <div className="px-3 py-1.5 text-xs text-gray-500">
          Resolved {resolveBotThreads.data.resolved}
          {resolveBotThreads.data.failed > 0 && ` · ${resolveBotThreads.data.failed} failed`}.
        </div>
      )}

      {/* Cross-bot dedup rollup — where ≥2 automated reviewers flagged the same spot. A PR-wide
          signal (independent of the vendor filter): consensus (they agree) vs conflict (they
          disagree). Each vendor chip jumps to its thread. */}
      {dedupClusters.length > 0 && (
        <div
          data-testid="bot-dedup"
          className="mx-3 my-2 rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs dark:border-sky-800 dark:bg-sky-950/30"
        >
          <div className="mb-1.5 flex items-center gap-1.5 font-medium text-sky-800 dark:text-sky-200">
            <span aria-hidden="true">🤖</span>
            Multiple bots flagged the same {dedupClusters.length === 1 ? 'line' : 'lines'}
          </div>
          <ul className="space-y-1.5">
            {dedupClusters.map((cluster, i) => {
              const file = cluster.path.split('/').pop() ?? cluster.path;
              const verb = cluster.members.length === 2 ? 'both flagged' : 'all flagged';
              return (
                <li
                  key={`${cluster.path}:${cluster.line ?? 'x'}:${i}`}
                  className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
                >
                  {cluster.members.map((m, idx) => {
                    const meta = automatedReviewerMeta(m.kind);
                    return (
                      <Fragment key={m.threadId}>
                        {idx > 0 && <span className="text-gray-400">+</span>}
                        <button
                          type="button"
                          onClick={() => scrollToThread(m.threadId)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium hover:opacity-80"
                          style={{ color: meta.color, background: `${meta.color}1a` }}
                          title={`Jump to ${m.label}'s thread`}
                        >
                          {m.label}
                        </button>
                      </Fragment>
                    );
                  })}
                  <span className="text-gray-600 dark:text-gray-300">
                    {verb}{' '}
                    <code className="font-mono">{file}</code>
                    {cluster.line != null ? `:${cluster.line}` : ''}
                  </span>
                  {cluster.conflict ? (
                    <span
                      className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                      title="The bots disagree on severity/verdict here — worth a human look."
                    >
                      bots disagree here
                    </span>
                  ) : cluster.consensus ? (
                    <span
                      className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      title="The bots agree here — one fix likely clears both."
                    >
                      consensus
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-gray-500">
          {botFilter ? 'No threads from this bot on this PR.' : 'No review threads on this PR.'}
        </div>
      ) : (
        buckets.map((b) => (
          <FileGroup
            key={b.path}
            path={b.path}
            threads={b.threads}
            usersById={usersById}
            prUrl={prUrl}
            repoId={repoId}
            selectedThreadId={selectedThreadId}
            viewedSince={viewedSince}
            awaitingThreadIds={awaitingThreadIds}
            registerRef={(id, el) => {
              if (el) rowRefs.current.set(id, el);
              else rowRefs.current.delete(id);
            }}
          />
        ))
      )}
    </div>
  );
}
