import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type {
  DerivedState,
  MlLabelTargetKind,
  MlSeverity,
  ThemePrRef,
  ThemeThreadRef,
} from '@pierre-review/shared';
import { DERIVED_STATES } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { usePr, DETAIL_GC_TIME } from '../../hooks/usePr.js';
import { prMlLabelsKey, useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { DERIVED_STATE_META, ML_SEVERITY_META, indexUsers } from '../../lib/ui.js';
import { ThreadCard } from '../ThreadView/index.js';
import { CommentCard } from '../CommentCard.js';
import { SeverityPill } from './ThemesReportView.js';

// The "click a theme card → all its threads" drill-down (ephemeral singleton tab). It renders the
// concrete review threads / PR-level comments a Bot or Human theme groups, using the SAME ThreadCard
// (full metadata + follow-up comments) the PR detail Threads tab uses. Grouped by PR; each group
// fetches that PR's detail once and can open the PR in its own tab. The theme is the transient seed
// (store `themeThreadsSeed`); nothing is fetched beyond the involved PRs' detail — the metrics
// strip's queries are byte-identical to the groups'/badges' own, so they dedupe rather than add.

const PR_GROUP_CAP = 12; // PRs rendered (a firehose theme is capped; the rest noted)

export function prRefToMeta(pr: {
  prId: number;
  prNumber: number;
  repoFullName: string;
  title?: string | null;
  authorLogin?: string | null;
}): TabMeta {
  return {
    id: pr.prId,
    number: pr.prNumber,
    title: pr.title ?? `#${pr.prNumber}`,
    repoFullName: pr.repoFullName,
    authorLogin: pr.authorLogin ?? null,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// One PR's member threads/comments. Fetches the PR detail once; renders the threads whose id is in
// the theme's member set (+ member PR-level comments). Header opens the PR in its own detail tab.
function ThemePrGroup({
  prId,
  prNumber,
  repoFullName,
  refs,
}: {
  prId: number;
  prNumber: number;
  repoFullName: string;
  refs: ThemeThreadRef[];
}): JSX.Element {
  const { data: pr, isLoading } = usePr(prId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const usersById = useMemo(() => indexUsers(pr?.users), [pr]);
  const authorLogin = pr?.authorId != null ? usersById.get(pr.authorId)?.githubLogin ?? null : null;
  const openThisPr = (): void =>
    openPrDetailTab(prRefToMeta({ prId, prNumber, repoFullName, title: pr?.title, authorLogin }), {
      fromActivity: true,
    });
  // Deep-link a specific member thread inside the PR: open the detail tab, then select the thread
  // (selectThread clears any state-pill preset, so resolved threads become visible, and PrDetail
  // forces the Threads tab + scrolls to it).
  const openThread = (threadId: number): void => {
    openThisPr();
    useFilters.getState().selectThread(prId, threadId);
  };

  const threadIds = new Set<number>();
  const commentIds = new Set<number>();
  for (const r of refs) {
    if (r.source === 'review' && r.threadId != null) threadIds.add(r.threadId);
    else if (r.source === 'issue' && r.commentId != null) commentIds.add(r.commentId);
  }
  const memberThreads = (pr?.threads ?? []).filter((t) => threadIds.has(t.id));
  const memberComments = (pr?.comments ?? []).filter((c) => commentIds.has(c.id));

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900/50">
        <span
          role="button"
          tabIndex={0}
          onClick={openThisPr}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openThisPr();
            }
          }}
          className="min-w-0 flex-1 cursor-pointer truncate text-sm hover:underline"
          title="Open this PR in its own detail tab"
        >
          <span className="font-mono text-gray-500">{repoFullName}</span>{' '}
          <span className="font-semibold text-gray-800 dark:text-gray-100">#{prNumber}</span>
          {pr?.title ? <span className="text-gray-600 dark:text-gray-300"> — {pr.title}</span> : null}
        </span>
        <button
          type="button"
          onClick={openThisPr}
          className="shrink-0 rounded border border-sky-300 px-2 py-0.5 text-[11px] font-medium text-sky-600 hover:bg-sky-50 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/40"
        >
          Open PR →
        </button>
      </div>
      <div className="space-y-2 p-3">
        {isLoading && !pr ? (
          <div className="h-16 animate-pulse rounded bg-gray-100 dark:bg-gray-900" />
        ) : (
          <>
            {memberThreads.map((t) => (
              <ThreadCard
                key={`t${t.id}`}
                thread={t}
                usersById={usersById}
                prUrl={pr!.githubUrl}
                repoId={pr!.repoId}
                onOpenInPr={() => openThread(t.id)}
              />
            ))}
            {memberComments.map((c) => (
              <CommentCard key={`c${c.id}`} comment={c} usersById={usersById} repoId={pr?.repoId} />
            ))}
            {memberThreads.length === 0 && memberComments.length === 0 && (
              <div className="text-[12px] text-gray-400">
                {refs.length} comment{refs.length === 1 ? '' : 's'} in this PR — not currently loaded
                (the thread may be outdated or still hydrating).
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export interface PrGroup {
  prId: number;
  prNumber: number;
  repoFullName: string;
  refs: ThemeThreadRef[];
}

// ── The deterministic metrics strip ──────────────────────────────────────────────────────────
// A compact stat row between the theme header and the PR groups — every number a client-side JS
// fold over data the view was ALREADY fetching (D4: code computes, the model contributes nothing
// here). Two data classes: ref-derived chips (from the theme's linked member refs — zero fetch,
// render immediately) and detail-derived chips (thread states + ML severity, folded from the
// SHOWN groups' PR detail with a "· n of m PRs loaded" disclosure while partial).

// Structural slices of PrDetail / PrMlLabelsResponse — the fold touches only these fields.
// Typing them structurally keeps it TOTAL under partial/undefined detail (there is no error
// boundary above this) and unit-testable without fabricating whole PrDetail rows.
export interface FoldablePrDetail {
  threads?: Array<{ id: number; derivedState: DerivedState; comments?: Array<{ id: number }> }> | null;
}
export interface FoldableMlLabels {
  labels?: Array<{ targetKind: MlLabelTargetKind; targetId: number; severity: MlSeverity }> | null;
}

export interface ThemeDetailMetrics {
  // Ref-derived (always available). "Linked" members — the refs are the CAPPED member set the
  // server resolved onto the theme, not necessarily every comment it covers.
  memberCount: number;
  reviewMembers: number; // refs that are review threads
  issueMembers: number; // refs that are PR-level comments
  prCount: number; // distinct PRs across ALL refs (== the group count)
  repoCount: number; // distinct repos across ALL refs
  // Detail-derived (over the SHOWN groups only — hidden groups get their own "+N more" line).
  shownPrCount: number;
  loadedPrCount: number; // shown PRs whose detail has arrived
  states: Record<DerivedState, number>; // distinct member threads by derived state
  matchedThreads: number; // Σ states (members whose thread was found in the loaded detail)
  ml: { high: number; minor: number; nit: number; labelled: number }; // major+critical = "high"
}

/**
 * Pure fold of the strip's numbers. Total by construction: a missing PR detail only lowers
 * `loadedPrCount`, a member whose thread isn't in the loaded detail (outdated / still hydrating)
 * is skipped, a target with no ML label counts toward NOTHING (`labelled` gates the chips — no
 * badge is silence, not agreement). Members citing one thread twice count it once; ML targets are
 * deduplicated the same way.
 */
export function foldThemeMetrics(
  members: ThemeThreadRef[],
  shown: PrGroup[],
  prById: Map<number, FoldablePrDetail | undefined>,
  labelsById: Map<number, FoldableMlLabels | undefined>,
): ThemeDetailMetrics {
  let reviewMembers = 0;
  let issueMembers = 0;
  const prIds = new Set<number>();
  const repos = new Set<string>();
  for (const r of members) {
    if (r.source === 'review') reviewMembers += 1;
    else issueMembers += 1;
    prIds.add(r.prId);
    repos.add(r.repoFullName);
  }

  const states: Record<DerivedState, number> = {
    untouched: 0,
    replied_unresolved: 0,
    likely_addressed: 0,
    resolved: 0,
  };
  const ml = { high: 0, minor: 0, nit: 0, labelled: 0 };
  let loadedPrCount = 0;
  let matchedThreads = 0;
  const seenThreads = new Set<number>();
  const seenTargets = new Set<string>();

  for (const g of shown) {
    const pr = prById.get(g.prId);
    if (pr == null) continue; // still loading (or evicted) — disclosed via loadedPrCount
    loadedPrCount += 1;
    const threadById = new Map<number, NonNullable<FoldablePrDetail['threads']>[number]>();
    for (const t of pr.threads ?? []) threadById.set(t.id, t);
    const labelByTarget = new Map<string, MlSeverity>();
    for (const l of labelsById.get(g.prId)?.labels ?? []) {
      labelByTarget.set(`${l.targetKind}|${l.targetId}`, l.severity);
    }
    const tallyMl = (kind: MlLabelTargetKind, targetId: number): void => {
      const key = `${kind}|${targetId}`;
      if (seenTargets.has(key)) return;
      seenTargets.add(key);
      const sev = labelByTarget.get(key);
      if (sev == null) return;
      ml.labelled += 1;
      if (sev === 'major' || sev === 'critical') ml.high += 1;
      else if (sev === 'minor') ml.minor += 1;
      else ml.nit += 1;
    };

    for (const r of g.refs) {
      if (r.source === 'review' && r.threadId != null) {
        const t = threadById.get(r.threadId);
        if (t == null) continue; // not in the loaded detail — the group's own copy says why
        if (!seenThreads.has(t.id) && t.derivedState in states) {
          seenThreads.add(t.id);
          states[t.derivedState] += 1;
          matchedThreads += 1;
        }
        // The label target of a review member is the THREAD'S ROOT comment (the bot's finding);
        // replies are not the finding.
        const rootId = t.comments?.[0]?.id;
        if (rootId != null) tallyMl('review_comment', rootId);
      } else if (r.source === 'issue' && r.commentId != null) {
        tallyMl('pr_comment', r.commentId);
      }
    }
  }

  return {
    memberCount: members.length,
    reviewMembers,
    issueMembers,
    prCount: prIds.size,
    repoCount: repos.size,
    shownPrCount: shown.length,
    loadedPrCount,
    states,
    matchedThreads,
    ml,
  };
}

function MlSevChip({ label, color, count }: { label: string; color: string; count: number }): JSX.Element {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
      style={{ color, background: `${color}1a` }}
    >
      {label} · {count}
    </span>
  );
}

// The strip component. Its queries are BYTE-IDENTICAL to the ones this view already makes — each
// shown ThemePrGroup's own `usePr` (['pr', id], staleTime Infinity, DETAIL_GC_TIME) and, when ML
// severity is live, the per-PR label index the badges read (prMlLabelsKey) — so react-query
// dedupes them and the strip never issues a request the view wasn't already making. With ML off
// the label entries are simply absent (zero fetches), and zero found labels render NO ML chips.
function ThemeMetricsStrip({
  members,
  shown,
}: {
  members: ThemeThreadRef[];
  shown: PrGroup[];
}): JSX.Element {
  const mlEnabled = useMlSeverityEnabled();
  const prQueries = useQueries({
    queries: shown.map((g) => ({
      queryKey: ['pr', g.prId],
      queryFn: () => api.pr(g.prId),
      staleTime: Infinity,
      gcTime: DETAIL_GC_TIME,
    })),
  });
  const labelQueries = useQueries({
    queries: mlEnabled
      ? shown.map((g) => ({
          queryKey: prMlLabelsKey(g.prId),
          queryFn: () => api.prMlLabels(g.prId),
          staleTime: Infinity,
        }))
      : [],
  });

  const prById = new Map<number, FoldablePrDetail | undefined>();
  const labelsById = new Map<number, FoldableMlLabels | undefined>();
  shown.forEach((g, i) => {
    prById.set(g.prId, prQueries[i]?.data);
    labelsById.set(g.prId, labelQueries[i]?.data);
  });
  const m = foldThemeMetrics(members, shown, prById, labelsById);

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-400"
      data-testid="theme-metrics-strip"
    >
      <span title="The theme's linked members — the resolved (capped) member set, not necessarily every comment the theme covers">
        {m.memberCount} linked member{m.memberCount === 1 ? '' : 's'}
        {m.reviewMembers > 0 && m.issueMembers > 0
          ? ` (${m.reviewMembers} in threads · ${m.issueMembers} PR-level)`
          : ''}
      </span>
      <span>
        {m.prCount} PR{m.prCount === 1 ? '' : 's'} · {m.repoCount} repo{m.repoCount === 1 ? '' : 's'}
      </span>
      {matchedStateChips(m)}
      {m.ml.labelled > 0 && (
        <span
          className="flex items-center gap-1"
          title="ML severity of the linked findings (major+critical bucketed as high). Counts the LABELLED ones only — an unlabelled comment is silence, not agreement."
        >
          {m.ml.high > 0 && <MlSevChip label="High" color={ML_SEVERITY_META.major.color} count={m.ml.high} />}
          {m.ml.minor > 0 && <MlSevChip label="Minor" color={ML_SEVERITY_META.minor.color} count={m.ml.minor} />}
          {m.ml.nit > 0 && <MlSevChip label="Nit" color={ML_SEVERITY_META.nit.color} count={m.ml.nit} />}
        </span>
      )}
      {m.loadedPrCount < m.shownPrCount && (
        <span className="text-gray-400 dark:text-gray-500">
          · {m.loadedPrCount} of {m.shownPrCount} PRs loaded
        </span>
      )}
    </div>
  );
}

// The four thread-state chips (existing state colours), rendered only for non-zero states over
// the loaded detail. All-zero (nothing matched yet) renders nothing rather than a row of zeros.
function matchedStateChips(m: ThemeDetailMetrics): JSX.Element | null {
  if (m.matchedThreads === 0) return null;
  return (
    <span className="flex items-center gap-1">
      {DERIVED_STATES.map((s) =>
        m.states[s] > 0 ? (
          <span
            key={s}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
            style={{ color: DERIVED_STATE_META[s].color, background: `${DERIVED_STATE_META[s].color}1a` }}
            title={DERIVED_STATE_META[s].description}
          >
            {DERIVED_STATE_META[s].label} · {m.states[s]}
          </span>
        ) : null,
      )}
    </span>
  );
}

export function ThemeThreadsDetail(): JSX.Element {
  const seed = useFilters((s) => s.themeThreadsSeed);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  if (!seed) return <div className="p-6 text-sm text-gray-400">No theme selected.</div>;
  const { theme, source } = seed;

  // Group member threads by PR (first-appearance order).
  const groups: PrGroup[] = [];
  const byPr = new Map<number, PrGroup>();
  for (const r of theme.threads) {
    let g = byPr.get(r.prId);
    if (!g) {
      g = { prId: r.prId, prNumber: r.prNumber, repoFullName: r.repoFullName, refs: [] };
      byPr.set(r.prId, g);
      groups.push(g);
    }
    g.refs.push(r);
  }
  const shown = groups.slice(0, PR_GROUP_CAP);
  const hiddenGroups = groups.length - shown.length;

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityPill severity={theme.severity} />
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{theme.title}</h2>
          <span className="rounded bg-gray-100 px-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {source === 'bot' ? 'Bot theme' : 'Discussion theme'}
          </span>
        </div>
        {theme.summary && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{theme.summary}</p>}
        {/* No count meta here — the metrics strip below carries the member/PR/repo numbers with
            the right names ("linked members", split threads vs PR-level). The old "N threads
            across M PRs" line counted PR-level refs as threads and contradicted the strip one
            row beneath it. */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
          {theme.prs.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              {theme.prs.map((pr: ThemePrRef) => (
                <button
                  key={pr.prId}
                  type="button"
                  onClick={() => openPrDetailTab(prRefToMeta(pr), { fromActivity: true })}
                  className="rounded px-1 tabular-nums text-sky-600 hover:bg-sky-100 hover:underline dark:text-sky-400 dark:hover:bg-sky-950/50"
                  title={`${pr.repoFullName}#${pr.prNumber} — open PR`}
                >
                  #{pr.prNumber}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>

      {theme.threads.length === 0 ? (
        <div className="text-sm text-gray-400">This theme has no linked threads.</div>
      ) : (
        <>
          <ThemeMetricsStrip members={theme.threads} shown={shown} />
          <div className="space-y-3">
            {shown.map((g) => (
              <ThemePrGroup
                key={g.prId}
                prId={g.prId}
                prNumber={g.prNumber}
                repoFullName={g.repoFullName}
                refs={g.refs}
              />
            ))}
            {hiddenGroups > 0 && (
              <div className="text-[12px] text-gray-400">
                + {hiddenGroups} more PR{hiddenGroups === 1 ? '' : 's'} not shown.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
