import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DerivedState,
  MlSeverity,
  ReviewBotKind,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import { DERIVED_STATES, ML_SEVERITIES } from '@pierre-review/shared';
import { useResolveBotThreads } from '../../hooks/usePrWrites.js';
import { useDetectedReviewers, usePrBotDedup } from '../../hooks/useBotTriage.js';
import { useRepos } from '../../hooks/useTimeline.js';
import {
  resolvableBotThreadIds,
  threadBotKind,
  type ReviewerRoleInfo,
} from './resolvable.js';
import { useFilters } from '../../store/filters.js';
import {
  automatedReviewerMeta,
  BOT_VENDOR_META,
  DERIVED_STATE_META,
  ML_SEVERITY_META,
} from '../../lib/ui.js';
import { useMlLabelIndex, useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { BotIcon } from '../Icons.js';
import { FileGroup } from './FileGroup.js';
import { rollupCounts, threadSeverities } from './ThreadCountChips.js';

// Stable empty Set so an absent stateFilter prop doesn't churn the memo deps every render.
const EMPTY_STATE_SET: Set<DerivedState> = new Set();
const EMPTY_SEVERITY_SET: Set<MlSeverity> = new Set();

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


export function ThreadList({
  threads,
  usersById,
  prUrl,
  prId,
  repoId,
  selectedThreadId,
  viewedSince,
  botFilter = null,
  stateFilter,
  severityFilter,
  openInChangesFor,
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
  // Derived-state pill filter (empty = all). ANDs with botFilter. Preset to
  // {likely_addressed} when arriving from the resolvable-bot-threads tab.
  stateFilter?: Set<DerivedState>;
  // ML-severity pill filter (empty = all). ANDs with the other two. Passed in (not read from
  // the store here) for the same reason as `stateFilter`: it is a GLOBAL store field and only
  // PrDetail knows whether it belongs to the PR being rendered.
  severityFilter?: Set<MlSeverity>;
  /**
   * "Show this thread in the Changes tab", resolved per thread by PrDetail — which is the only
   * place that has BOTH the changed-file set and the tab state. Returns null when the thread's
   * file is not in the diff at all, so the control is absent rather than dead (the bottom rung of
   * the fallback ladder). Undefined at every mount that has no Changes tab.
   */
  openInChangesFor?: (
    thread: ThreadDetail,
  ) => { run: () => void; approximate: boolean; line: number | null } | null;
}): JSX.Element {
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const setThreadBotFilter = useFilters((s) => s.setThreadBotFilter);
  const toggleThreadStateFilter = useFilters((s) => s.toggleThreadStateFilter);
  const setThreadStateFilter = useFilters((s) => s.setThreadStateFilter);
  const activeStates = stateFilter ?? EMPTY_STATE_SET;
  const activeSeverities = severityFilter ?? EMPTY_SEVERITY_SET;
  const toggleThreadSeverityFilter = useFilters((s) => s.toggleThreadSeverityFilter);
  const setThreadSeverityFilter = useFilters((s) => s.setThreadSeverityFilter);
  // The ONE shared per-PR label index — the same query the cards themselves read, so the pills
  // cost nothing extra. Undefined until it lands (or forever, with no model configured), which
  // is why the severity row hides itself rather than rendering dead pills.
  const mlEnabled = useMlSeverityEnabled();
  const mlIndex = useMlLabelIndex(prId ?? null, mlEnabled);

  // Every non-summary severity present in a thread — the shared `threadSeverities` fold (also
  // read by BotTriageCard, so the card's nit count and these pills can never disagree). A thread
  // matches the pills when it holds a comment of a selected severity — not when its WORST equals
  // it: filtering to "major" should surface the thread that has one major finding among five
  // nits, which an equality test on the rollup would hide.
  const severitiesOf = useCallback(
    (t: ThreadDetail): Set<MlSeverity> => threadSeverities(t, mlIndex),
    [mlIndex],
  );
  const resolveBotThreads = useResolveBotThreads();
  const [confirming, setConfirming] = useState(false);

  // Cross-bot dedup: (path, ±3-line) spots where ≥2 DISTINCT automated reviewers both left a
  // thread — the backend clusters + flags consensus/conflict; we surface a compact rollup so
  // the reader sees "CodeRabbit + Copilot both flagged line 42" without scanning the whole
  // file for the overlap. Account-scoped, deterministic (no AI). Members arrive collapsed per
  // BOT (`threadIds` = that bot's threads in the cluster) — one pill per bot, never per thread.
  const { data: dedup } = usePrBotDedup(prId ?? null);
  const dedupClusters = dedup?.clusters ?? [];

  // Jump to a clustered thread's row (rowRefs is populated by FileGroup, keyed by thread id).
  const scrollToThread = (threadId: number): void => {
    rowRefs.current.get(threadId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // A ×N pill cycles through its bot's threads on successive clicks. The cursor lives in a ref
  // keyed per (cluster, bot) — no re-render needed, the scroll IS the feedback. Cycle only over
  // threads that currently HAVE a row: the rollup renders unfiltered clusters above a list the
  // state/vendor/severity pills may have narrowed, and rowRefs only holds rendered rows — a
  // click that "advances" onto a hidden thread would silently do nothing (a dead click the
  // pill's own tooltip promises against). With every thread filtered out, the click no-ops
  // without advancing, so the cursor doesn't drift while nothing is visible.
  const dedupCycleRef = useRef(new Map<string, number>());
  const cycleToThread = (clusterKey: string, userId: number, ids: number[]): void => {
    const visible = ids.filter((id) => rowRefs.current.has(id));
    if (visible.length === 0) return;
    const k = `${clusterKey}:${userId}`;
    const i = dedupCycleRef.current.get(k) ?? 0;
    scrollToThread(visible[i % visible.length]!);
    dedupCycleRef.current.set(k, i + 1);
  };

  // Apply the vendor filter (Overview "Bots" chip → scoped to a vendor) AND the derived-state
  // pill filter (empty = all). Both narrow the visible list + its file groups + counts.
  const shown = useMemo(
    () =>
      threads.filter(
        (t) =>
          (botFilter ? threadBotKind(t, usersById) === botFilter : true) &&
          (activeStates.size === 0 || activeStates.has(t.derivedState)) &&
          (activeSeverities.size === 0 ||
            [...severitiesOf(t)].some((sev) => activeSeverities.has(sev))),
      ),
    [threads, botFilter, usersById, activeStates, activeSeverities, severitiesOf],
  );

  // Per-state counts for the pill badges — over the FULL thread list (independent of the active
  // pills, like the feed's whole-stream facet counts), so a pill's badge doesn't drop to 0 when
  // another pill is active.
  const stateCounts = useMemo(() => rollupCounts(threads), [threads]);

  // Per-severity THREAD counts (a thread counts once per distinct severity it contains), over
  // the FULL list like stateCounts — so a pill's badge doesn't drop to 0 when another is active.
  const severityCounts = useMemo(() => {
    const out: Record<MlSeverity, number> = { critical: 0, major: 0, minor: 0, nit: 0 };
    for (const t of threads) for (const sev of severitiesOf(t)) out[sev] += 1;
    return out;
  }, [threads, severitiesOf]);

  // The reviewer JUDGEMENTS — the SAME answers `getResolvableBotThreads` re-derives eligibility
  // from, so the offered count matches what the resolve will accept (see resolvable.ts). Fetched
  // only when a vendor filter is active, because the resolve control only renders there: a PR
  // opened without touching the Bots chip costs no extra request.
  //
  // ⚠ THE LISTING IS FETCHED FOR THE PR'S OWN WORKSPACE, NOT THE SELECTED ONE. A bot object is
  // keyed per WORKSPACE now, and the server re-derives eligibility from the workspace the PR's
  // repo belongs to — but this PR can be open from a different workspace entirely (a `?pr=<id>`
  // deep link, a restored `pierre:tabs` entry, a search hit). Building the offer from
  // `filters.workspaceId` would then read workspace X's judgements while the resolve evaluates
  // workspace Y's: an offered count the server refuses, i.e. the dead button this predicate
  // exists to retire. `Repo.workspaceId` is the only repo→workspace mapping the client has.
  //
  // It is fetched UNNARROWED (no `repoIds`): the judgement is workspace-wide, and that unscoped
  // key is the one entry FeedView and useBotColors already keep warm, so a PR open usually costs
  // no fetch at all.
  //
  // `repoId` is optional on this component (a thread list can be rendered without one); with no
  // repo — or before `useRepos()` lands — there is no workspace, the query stays inert and the map
  // is left null, which resolvable.ts treats as "listing not loaded": it keeps the vendor-login
  // fallback rather than silently offering or refusing threads on no evidence.
  const { data: repos } = useRepos();
  const prWorkspaceId = useMemo(() => {
    if (repoId == null) return null;
    return (repos ?? []).find((r) => r.id === repoId)?.workspaceId ?? null;
  }, [repos, repoId]);
  const { data: detected } = useDetectedReviewers(prWorkspaceId, null, botFilter != null);
  const reviewerRoles = useMemo(() => {
    if (detected == null) return null;
    // ONE row per actor in the workspace — no repo filter left to apply, and no rows/reviewers
    // split to reconcile.
    const m = new Map<number, ReviewerRoleInfo>();
    for (const r of detected.reviewers) {
      m.set(r.userId, { automated: r.automated, role: r.role });
    }
    return m;
  }, [detected]);

  // The bot threads a later commit has LIKELY ADDRESSED — the set the bulk "clear backlog"
  // action can safely resolve (matches the server's getResolvableBotThreads eligibility).
  // Derived from the FULL list (not `shown`) so the resolve target never depends on which
  // state/vendor pills are active — only the vendor filter, which scopes intent.
  const addressedBotThreadIds = useMemo(
    () => resolvableBotThreadIds(threads, usersById, botFilter, reviewerRoles),
    [threads, usersById, botFilter, reviewerRoles],
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
      {/* Sticky filter header: the derived-state pills (always) + the vendor row (when a vendor
          filter is active). The two filters AND together in `shown`. */}
      {threads.length > 0 && (
        <div
          className="sticky top-0 z-10 space-y-2 border-b border-gray-100 bg-white/95 px-3 py-2 backdrop-blur dark:border-gray-800 dark:bg-gray-900/95"
          style={vendor ? { boxShadow: `inset 3px 0 0 ${vendor.color}` } : undefined}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              State
            </span>
            {DERIVED_STATES.map((st) => {
              const meta = DERIVED_STATE_META[st];
              const on = activeStates.has(st);
              const count = stateCounts[st];
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => toggleThreadStateFilter(st)}
                  aria-pressed={on}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    on
                      ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/30 dark:text-sky-300'
                      : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                  }`}
                  title={meta.description}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: meta.color }}
                  />
                  {meta.label}
                  {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
                </button>
              );
            })}
            {activeStates.size > 0 && (
              <button
                type="button"
                onClick={() => setThreadStateFilter(new Set())}
                className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 underline-offset-2 hover:underline"
              >
                Clear
              </button>
            )}
          </div>

          {/* ML severity pills. Hidden entirely when nothing on this PR is labelled — an
              always-present row of zero-count pills on an un-enriched (or OSS) install would
              advertise a filter that can only ever return nothing. */}
          {mlIndex != null && mlIndex.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Severity
              </span>
              {ML_SEVERITIES.map((sev) => {
                const meta = ML_SEVERITY_META[sev];
                const on = activeSeverities.has(sev);
                const count = severityCounts[sev] ?? 0;
                return (
                  <button
                    key={sev}
                    type="button"
                    onClick={() => toggleThreadSeverityFilter(sev)}
                    aria-pressed={on}
                    disabled={count === 0 && !on}
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                      on
                        ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/30 dark:text-sky-300'
                        : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                    }`}
                    title={meta.description}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: meta.color }}
                    />
                    {meta.label}
                    {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
                  </button>
                );
              })}
              {activeSeverities.size > 0 && (
                <button
                  type="button"
                  onClick={() => setThreadSeverityFilter(new Set())}
                  className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 underline-offset-2 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {vendor && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className="inline-flex items-center gap-1 font-medium"
                style={{ color: vendor.color }}
              >
                <BotIcon size={12} />
                {vendor.label}
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
            <BotIcon />
            Multiple bots flagged the same {dedupClusters.length === 1 ? 'line' : 'lines'}
          </div>
          <ul className="space-y-1.5">
            {dedupClusters.map((cluster, i) => {
              const file = cluster.path.split('/').pop() ?? cluster.path;
              const clusterKey = `${cluster.path}:${cluster.line ?? 'x'}:${i}`;
              // Distinct BOTS, computed defensively rather than trusting one-member-per-bot
              // (['bot-dedup'] is NOT IndexedDB-persisted — main.tsx dehydrates only
              // pr/thread/pr-files — this is just cheap insurance against a future shape).
              const distinctBots = new Set(cluster.members.map((m) => m.userId)).size;
              const verb = distinctBots === 2 ? 'both flagged' : 'all flagged';
              return (
                <li
                  key={clusterKey}
                  className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
                >
                  {cluster.members.map((m, idx) => {
                    const meta = automatedReviewerMeta(m.kind);
                    // Absent on stale cached members (pre-collapse shape) — treat as [threadId].
                    const ids = m.threadIds && m.threadIds.length > 0 ? m.threadIds : [m.threadId];
                    return (
                      <Fragment key={m.threadId}>
                        {idx > 0 && <span className="text-gray-400">+</span>}
                        <button
                          type="button"
                          onClick={() => cycleToThread(clusterKey, m.userId, ids)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium hover:opacity-80"
                          style={{ color: meta.color, background: `${meta.color}1a` }}
                          title={
                            ids.length > 1
                              ? `${m.label} left ${ids.length} threads here — click to cycle through them`
                              : `Jump to ${m.label}'s thread`
                          }
                        >
                          {m.label}
                          {ids.length > 1 && <span className="opacity-70">×{ids.length}</span>}
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
          {activeStates.size > 0
            ? 'No threads in the selected state(s).'
            : botFilter
              ? 'No threads from this bot on this PR.'
              : 'No review threads on this PR.'}
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
            registerRef={(id, el) => {
              if (el) rowRefs.current.set(id, el);
              else rowRefs.current.delete(id);
            }}
            openInChangesFor={openInChangesFor}
          />
        ))
      )}
    </div>
  );
}
