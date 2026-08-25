import { useMemo, useState } from 'react';
import type {
  PrDetail as PrDetailT,
  ThreadDetail,
  User,
  WorkspaceReviewer,
} from '@pierre-review/shared';
import { useRepos } from '../hooks/useTimeline.js';
import { useDetectedReviewers } from '../hooks/useBotTriage.js';
import { useResolveBotThreads } from '../hooks/usePrWrites.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { annotationKey, useAnnotationIndex } from '../hooks/useAnnotations.js';
import { useMlLabelIndex, useMlSeverityEnabled } from '../hooks/useMlLabels.js';
import { rollupCounts, threadSeverities } from './ThreadList/ThreadCountChips.js';
import {
  resolvableBotThreadIds,
  threadAuthorId,
  type ReviewerRoleInfo,
} from './ThreadList/resolvable.js';
import { DERIVED_STATE_META, ML_SEVERITY_META, userLabel } from '../lib/ui.js';

// The per-PR bot triage card (Plan P3.2 / N2): one sentence that turns a bot-comment flood into
// a decision — "N bot comments: X real issues · Y likely addressed · Z nit-flagged — [Resolve]".
//
// Mounted twice: full at the top of the Threads tab, compact in the Overview attention area.
// Renders ONLY when the PR carries ≥ MIN_BOT_COMMENTS bot-authored review comments; below the
// threshold (or before its inputs load) it renders NOTHING and enables NO extra query — the
// ThreadAssessment 60-empty-boxes lesson. Everything it reads is a query the SPA already shares:
// the workspace reviewer listing (FeedView/useBotColors keep the unnarrowed key warm), the ONE
// per-PR ML label index, and the ONE per-PR annotation index (a pure cached GET — this card can
// never bill).
//
// Bot membership is the CLIENT MIRROR OF THE SERVER'S UNION SET (`hiddenBotUserIds`): the
// workspace's stored judgement wins in both directions (`automated` adds, a manual "human"
// removes), `users.isBot` is the fallback — the same rule FeedView's `isUnionBot` applies.
// Deliberately NOT the legacy login-string classification PrDetail's bot chips still use.
//
// Count discipline: every figure is computed by the SAME fold the Threads tab uses on the same
// rows — `rollupCounts` (the state pills), `threadSeverities` (the severity pills) and
// `resolvableBotThreadIds` (the resolve offer) — restricted to the union-bot thread subset, so
// the card and the tab can never disagree about one population.

const MIN_BOT_COMMENTS = 5;

/** The server's union-bot verdict for one actor, mirrored client-side (see FeedView). */
function isUnionBot(
  userId: number,
  reviewerByUserId: Map<number, WorkspaceReviewer>,
  usersById: Map<number, User>,
): boolean {
  const r = reviewerByUserId.get(userId);
  if (r != null) {
    if (r.automated) return true;
    // A manual "this is a human" beats the global isBot flag.
    if (r.isManualOverride) return false;
  }
  return usersById.get(userId)?.isBot ?? false;
}

function Dot({ color }: { color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 rounded-full"
      style={{ background: color }}
    />
  );
}

export function BotTriageCard({
  pr,
  usersById,
  variant,
  onOpenThreads,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  variant: 'full' | 'compact';
  /** Compact (Overview) only: open the Threads tab, where the threads + per-thread "Check review" buttons live. */
  onOpenThreads?: () => void;
}): JSX.Element | null {
  // ── hooks first, unconditionally (early returns come after) ──────────────────────────────
  const [confirming, setConfirming] = useState(false);
  const resolveBotThreads = useResolveBotThreads();

  // Cheap pre-gate computed from data already in memory: with fewer than MIN_BOT_COMMENTS
  // review comments IN TOTAL the threshold is unreachable, so nothing below may fetch.
  const totalThreadComments = useMemo(
    () => pr.threads.reduce((n, t) => n + t.comments.length, 0),
    [pr.threads],
  );
  const plausible = totalThreadComments >= MIN_BOT_COMMENTS;

  // The PR's OWN workspace, not the selected one — a bot object is keyed per workspace and this
  // PR can be open from elsewhere (deep link, restored tab, search hit). Same rule + same shared
  // cache entry as ThreadList's resolve offer.
  const { data: repos } = useRepos();
  const prWorkspaceId = useMemo(
    () => (repos ?? []).find((r) => r.id === pr.repoId)?.workspaceId ?? null,
    [repos, pr.repoId],
  );
  const { data: detected } = useDetectedReviewers(prWorkspaceId, null, plausible);

  const reviewerByUserId = useMemo(() => {
    const m = new Map<number, WorkspaceReviewer>();
    for (const r of detected?.reviewers ?? []) m.set(r.userId, r);
    return m;
  }, [detected]);

  // Threads OPENED by a union bot (the same author anchor the server's resolve matches on).
  const botThreads = useMemo(
    () =>
      pr.threads.filter((t) => {
        const a = threadAuthorId(t);
        return a != null && isUnionBot(a, reviewerByUserId, usersById);
      }),
    [pr.threads, reviewerByUserId, usersById],
  );

  // Every bot-authored review comment on the PR (replies included, human replies excluded) —
  // the "N bot comments" figure and the render threshold.
  const botCommentCount = useMemo(() => {
    let n = 0;
    for (const t of pr.threads)
      for (const c of t.comments)
        if (c.authorId != null && isUnionBot(c.authorId, reviewerByUserId, usersById)) n += 1;
    return n;
  }, [pr.threads, reviewerByUserId, usersById]);

  // The card exists only above the threshold, and only once the reviewer listing has answered
  // (undefined data = render nothing, never a guess). Both index queries key their `enabled` on
  // this, so a below-threshold PR issues zero extra requests.
  const show =
    plausible && detected != null && botThreads.length > 0 && botCommentCount >= MIN_BOT_COMMENTS;

  const mlEnabled = useMlSeverityEnabled();
  const mlIndex = useMlLabelIndex(pr.id, mlEnabled && show);
  const proEnabled = useProCapabilities().prSummary;
  const annIndex = useAnnotationIndex(pr.id, proEnabled && show);

  // Free grade: the Threads tab's own state fold over the bot subset.
  const stateCounts = useMemo(() => rollupCounts(botThreads), [botThreads]);
  // ML split: bot threads CONTAINING a nit-severity comment — the tab's contains-fold, reused.
  const nitCount = useMemo(
    () => botThreads.filter((t) => threadSeverities(t, mlIndex).has('nit')).length,
    [botThreads, mlIndex],
  );

  // Pro fold, where verdicts are STORED (the cached free GET — no generation from this card):
  // "real issues" = validity says the point holds up AND nothing says it was dealt with.
  const proFold = useMemo(() => {
    if (annIndex == null) return null;
    let judged = 0;
    let real = 0;
    for (const t of botThreads) {
      const root = t.comments[0];
      if (root == null) continue;
      const validity = annIndex.get(annotationKey('validity', 'review_comment', root.id));
      if (validity?.verdict == null) continue;
      judged += 1;
      const addressed = annIndex.get(annotationKey('addressed', 'thread', t.id));
      const dealtWith =
        t.isResolved || addressed?.verdict === 'addressed' || addressed?.verdict === 'likely';
      if (validity.verdict === 'valid' && !dealtWith) real += 1;
    }
    return { judged, real, unjudged: botThreads.length - judged };
  }, [annIndex, botThreads]);

  // The resolve offer — the EXACT predicate the server re-derives (and the Threads tab's own
  // vendor-scoped button uses), over the full thread list with no vendor narrowing.
  const reviewerRoles = useMemo(() => {
    if (detected == null) return null;
    const m = new Map<number, ReviewerRoleInfo>();
    for (const r of detected.reviewers) m.set(r.userId, { automated: r.automated, role: r.role });
    return m;
  }, [detected]);
  const resolvableIds = useMemo(
    () => resolvableBotThreadIds(pr.threads, usersById, null, reviewerRoles),
    [pr.threads, usersById, reviewerRoles],
  );
  const resolvableThreads = useMemo(() => {
    const wanted = new Set(resolvableIds);
    return pr.threads.filter((t) => wanted.has(t.id));
  }, [pr.threads, resolvableIds]);

  // ── render (nothing below the threshold) ─────────────────────────────────────────────────
  if (!show) return null;

  const stillOpen = stateCounts.untouched + stateCounts.replied_unresolved;
  const likelyAddressed = stateCounts.likely_addressed;
  const hasProFold = proFold != null && proFold.judged > 0;

  const segments: JSX.Element[] = [];
  if (hasProFold) {
    segments.push(
      <span key="real" className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
        <Dot color="#e11d48" />
        {proFold.real} real issue{proFold.real === 1 ? '' : 's'}
      </span>,
    );
  } else if (stillOpen > 0) {
    segments.push(
      <span key="open" className="inline-flex items-center gap-1">
        <Dot color={DERIVED_STATE_META.untouched.color} />
        {stillOpen} awaiting a look
      </span>,
    );
  }
  if (likelyAddressed > 0) {
    segments.push(
      <span key="addr" className="inline-flex items-center gap-1">
        <Dot color={DERIVED_STATE_META.likely_addressed.color} />
        {likelyAddressed} likely addressed
      </span>,
    );
  }
  if (nitCount > 0) {
    segments.push(
      <span key="nits" className="inline-flex items-center gap-1">
        <Dot color={ML_SEVERITY_META.nit.color} />
        {nitCount} nit-flagged
      </span>,
    );
  }

  const headline = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-1 font-medium text-gray-700 dark:text-gray-200">
        <span aria-hidden="true">🤖</span>
        {botCommentCount} bot comments
      </span>
      {segments.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i === 0 ? <span className="text-gray-400">:</span> : <span className="text-gray-400">·</span>}
          {s}
        </span>
      ))}
    </span>
  );

  if (variant === 'compact') {
    return (
      <div
        data-testid="bot-triage-card"
        className="mx-4 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300"
      >
        {headline}
        {onOpenThreads && (
          <button
            type="button"
            onClick={onOpenThreads}
            className="ml-auto rounded px-1.5 py-0.5 font-medium text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
            title={
              resolvableIds.length > 0
                ? 'Open the Threads tab — the likely-addressed threads can be resolved from there.'
                : 'Open the Threads tab.'
            }
          >
            {resolvableIds.length > 0
              ? `Resolve the ${resolvableIds.length} addressed →`
              : hasProFold && proFold.unjudged > 0
                ? 'Judge the rest →'
                : 'View threads →'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="bot-triage-card"
      className="mx-3 mt-2 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {headline}
        {/* The remainder is judged with each thread's own "Check review" button below — the one
            existing (billed, per-item) annotation surface; this card never generates. */}
        {hasProFold && proFold.unjudged > 0 && (
          <span
            className="text-gray-400"
            title="Judge the rest with the “Check review” button on each thread below — one judgement per click, nothing runs automatically."
          >
            {proFold.unjudged} unjudged
          </span>
        )}
        {resolvableIds.length > 0 && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={resolveBotThreads.isPending}
            className="ml-auto rounded border border-green-600 px-2 py-0.5 font-medium text-green-700 hover:bg-green-50 disabled:opacity-60 dark:text-green-400 dark:hover:bg-green-950/30"
            title="A later commit touched the file each of these threads flags — review the exact list, then resolve them on GitHub in one click."
          >
            Resolve the {resolvableIds.length} addressed
          </button>
        )}
      </div>

      {/* Confirm step: the exact threads, listed — resolve is user-initiated and confirm-gated,
          always naming what it will touch (nothing ever auto-resolves). */}
      {confirming && (
        <div className="mt-2 rounded border border-green-200 bg-white/60 p-2 dark:border-green-900 dark:bg-gray-950/40">
          <div className="mb-1 font-medium text-gray-700 dark:text-gray-200">
            Resolve {resolvableThreads.length} likely-addressed bot thread
            {resolvableThreads.length === 1 ? '' : 's'} on GitHub?
          </div>
          <ul className="mb-2 max-h-48 space-y-1 overflow-y-auto">
            {resolvableThreads.map((t: ThreadDetail) => {
              const authorId = threadAuthorId(t);
              const author = authorId != null ? usersById.get(authorId) : undefined;
              const excerpt = (t.comments[0]?.body ?? '').replace(/\s+/g, ' ').slice(0, 90);
              return (
                <li key={t.id} className="flex items-baseline gap-1.5">
                  <code className="shrink-0 font-mono text-[10px] text-gray-500">
                    {t.path.split('/').pop() ?? t.path}
                    {t.line != null ? `:${t.line}` : ''}
                  </code>
                  <span className="truncate text-gray-500" title={t.comments[0]?.body ?? ''}>
                    {userLabel(author, authorId)}: {excerpt}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={resolveBotThreads.isPending}
              onClick={() =>
                resolveBotThreads.mutate(
                  { prId: pr.id, threadIds: resolvableIds },
                  { onSettled: () => setConfirming(false) },
                )
              }
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
          </div>
        </div>
      )}

      {resolveBotThreads.data &&
        (resolveBotThreads.data.resolved > 0 || resolveBotThreads.data.failed > 0) && (
          <div className="mt-1 text-gray-500">
            Resolved {resolveBotThreads.data.resolved}
            {resolveBotThreads.data.failed > 0 && ` · ${resolveBotThreads.data.failed} failed`}.
          </div>
        )}
    </div>
  );
}
