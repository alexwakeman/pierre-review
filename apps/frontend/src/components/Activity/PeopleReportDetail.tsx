import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import type {
  AutomationMetricKey,
  AutomationMetricValue,
  AutomationOutput,
  AutomationOutputResponse,
  BotAnalyticsResponse,
  BotVendorAnalytics,
  BotVendorComment,
  BotVendorCommentsResponse,
  BotVerdict,
  DigestPrRef,
  PersonEvidenceThreadRef,
  PersonReportSectionId,
  User,
} from '@pierre-review/shared';
import { AUTOMATION_METRIC_KEYS } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters, type PeopleReportSelection } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { ACTIVITY_GC_TIME, workspaceKey } from '../../hooks/useActivity.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { usePeriodReportsList } from '../../hooks/usePeriodReports.js';
import { usePersonPeriod } from '../../hooks/usePersonPeriod.js';
import {
  useGenerateSynthesis,
  useSynthesis,
  useSynthesisGenerating,
  type SynthesisDescriptor,
} from '../../hooks/useSynthesis.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import {
  NARRATION_QUEUE_IDLE,
  evidencePrGroups,
  foldWhereItWorks,
  orderSelections,
  reduceNarrationQueue,
  refAnchorKey,
} from '../../lib/peopleReport.js';
import {
  DERIVED_STATE_META,
  automatedReviewerMeta,
  dateTime,
  indexUsers,
  relativeTime,
} from '../../lib/ui.js';
import { ArrowIcon, PersonIcon } from '../Icons.js';
import { Markdown } from '../Markdown.js';
import { MlSeverityBadge } from '../MlSeverityBadge.js';
import { KEY_LABEL, KEY_TITLE, fmtValue } from './PersonPeriodSection.js';
import { periodTitle } from './periodReportMarkdown.js';
import { buildPrRefIndex } from './prRefLinks.js';
import { PrTable } from './prRefTable.js';
import { prRefToMeta } from './ThemeThreadsDetail.js';

// The People report (Reports → People → "Begin report") — an ephemeral pinned drill-down: ONE
// report for one completed period, a SECTION per picked person or bot, sections ALPHABETICAL by
// label with humans and bots interleaved (never metric-sorted, never kind-grouped — PREP, NOT
// SCORING). Seeded by the transient `peopleReportSeed` (themeThreadsSeed discipline: singleton
// tab re-seeded in place; no URL pieces; dies on reload).
//
// Per-section data, one subject per request (the §6 shape — the client LOOPS, the fold stays
// one-person):
//  • humans — the person GET with `evidence=1` (vector verbatim + receipt cards), plus the Pro
//    `person_report` narrative on the ONE synthesis seam, generated SEQUENTIALLY through the
//    narration queue (lib/peopleReport.ts) so two sections never bill concurrently.
//  • bots — deterministic, NO AI: the FREE core bot-analytics row (ONE shared fetch for the
//    whole report, rows picked client-side by `u<userId>`) + the per-bot comment evidence,
//    both period-bounded via the routes' fromMs/toMs. Paid depth stays a "Depth →" link.
//
// Key discipline (the refineQueryKey rule): every per-section query carries `ws:` + its own
// `u:<userId>` + the `pw:<from>-<to>` period slot, so two chips can never share a cache entry.

const MUTED = 'text-gray-400';
// How many evidence/comment cards a group shows before its code-rendered "and N more" line —
// mirrors the server's per-group evidence cap (PERSON_EVIDENCE_CAP) for the bot card list too.
const BOT_COMMENT_SHOW_CAP = 8;
// After a `throttled` POST (another section's generation holds the per-account claim, or the
// 15s billed min-interval), the section withdraws and re-queues once this backoff passes.
const THROTTLE_BACKOFF_MS = 16_000;

const SECTION_TITLE: Record<PersonReportSectionId, string> = {
  worked_on: 'What they worked on',
  nature_of_changes: 'Nature of the changes',
  collaboration: 'Collaboration',
  waiting_and_risk: 'Waiting + risk',
};

// ── Period-bounded bot fetches (report-local hooks) ───────────────────────────────────────────

interface PeriodBounds {
  fromMs: number;
  toMs: number;
}

const boundsSlot = (b: PeriodBounds | null): string => (b ? `pw:${b.fromMs}-${b.toMs}` : 'pw:-');

// ONE bot-analytics fetch serves every bot section (rows picked by key client-side). The enum
// window is 'sprint' — the bounds are what the fold measures (the apiVersion-18 window form);
// the `pw:` slot pins them in the cache key, so no window-enum slot is needed. Distinct by
// construction from useBotAnalytics's key (its second slot is a window enum, never `ws:`), and
// still swept by the reclassify invalidation's ['bot-analytics'] prefix.
function useReportBotAnalytics(
  workspaceId: number | null,
  bounds: PeriodBounds | null,
  enabled: boolean,
) {
  return useQuery<BotAnalyticsResponse>({
    queryKey: ['bot-analytics', workspaceKey(workspaceId), 'r:-', boundsSlot(bounds)],
    queryFn:
      workspaceId == null || bounds == null
        ? skipToken
        : () => api.botAnalytics('sprint', workspaceId, undefined, bounds),
    enabled: enabled && bounds != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// One bot's period comments — the evidence cards' single request (rows carry ML label + thread
// state INLINE; the cards issue no queries, the BotCommentCard discipline).
function useReportBotComments(
  workspaceId: number | null,
  userId: number,
  bounds: PeriodBounds | null,
  enabled: boolean,
) {
  return useQuery<BotVendorCommentsResponse>({
    queryKey: ['bot-vendor-comments', workspaceKey(workspaceId), `u${userId}`, boundsSlot(bounds)],
    queryFn:
      workspaceId == null || bounds == null
        ? skipToken
        : () => api.botVendorComments(`u${userId}`, 'sprint', workspaceId, undefined, bounds),
    enabled: enabled && bounds != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// The AUTHORING half of a bot section (CORE, free). Fetched for EVERY bot, not only the ones the
// review fold came back empty for: a code agent can both author PRs and review them, and deciding
// client-side which half "counts" would be the login heuristic this codebase keeps deleting. The
// server answers `output: null` for anything that has never authored here, and that null is what
// hides the panel.
function useReportBotAuthoring(
  workspaceId: number | null,
  userId: number,
  bounds: PeriodBounds | null,
  enabled: boolean,
) {
  return useQuery<AutomationOutputResponse>({
    queryKey: ['bot-authoring', workspaceKey(workspaceId), `u${userId}`, boundsSlot(bounds)],
    queryFn:
      workspaceId == null || bounds == null
        ? skipToken
        : () => api.botAuthoring(workspaceId, userId, bounds, true),
    enabled: enabled && bounds != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// ── Shared card pieces ────────────────────────────────────────────────────────────────────────

function StateChip({ state }: { state: PersonEvidenceThreadRef['derivedState'] }): JSX.Element {
  const meta = DERIVED_STATE_META[state];
  return (
    <span
      className="shrink-0 rounded px-1 py-px text-[10px] font-medium"
      style={{ color: meta.color, background: `${meta.color}1a` }}
      title={meta.description}
    >
      {meta.label}
    </span>
  );
}

/** A clamped markdown body (the BotCommentCard discipline without its ResizeObserver — a plain
 *  length heuristic keeps this card cheap across many sections). */
function ClampedBody({ body }: { body: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const long = body.length > 400;
  return (
    <div className="mt-1 rounded bg-gray-50 px-2 py-1.5 text-sm dark:bg-gray-900/50">
      <div className={expanded || !long ? '' : 'max-h-32 overflow-hidden'}>
        <Markdown>{body}</Markdown>
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

const TARGET_KIND_LABEL = {
  review_comment: 'inline comment',
  pr_comment: 'PR comment',
  review: 'review summary',
} as const;

/** One evidence comment (a BotVendorComment row — humans' own comments and bots' output share
 *  the shape). ⚠ NO QUERIES from this card — everything renders from the row (ML label + thread
 *  state inline); acting on the comment is the PR tab's job. */
function EvidenceCommentCard({
  c,
  onOpenPr,
  onOpenThread,
}: {
  c: BotVendorComment;
  onOpenPr: (c: BotVendorComment) => void;
  onOpenThread: (c: BotVendorComment, threadId: number) => void;
}): JSX.Element {
  return (
    <article
      data-ev-anchor={
        c.targetKind === 'review_comment'
          ? `rc:${c.targetId}`
          : c.targetKind === 'pr_comment'
            ? `pc:${c.targetId}`
            : undefined
      }
      className="rounded-md border border-gray-200 bg-white p-2 text-sm dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400">
          {TARGET_KIND_LABEL[c.targetKind]}
        </span>
        <button
          type="button"
          onClick={() => onOpenPr(c)}
          className="shrink-0 font-medium text-gray-700 hover:text-sky-600 hover:underline dark:text-gray-200"
          title={`${c.repoFullName} #${c.prNumber} — ${c.prTitle}`}
        >
          {c.repoFullName} #{c.prNumber}
        </button>
        {c.path != null && (
          <span className="min-w-0 truncate font-mono text-gray-400" title={c.path}>
            {c.path}
          </span>
        )}
        {c.mlLabel && <MlSeverityBadge label={c.mlLabel} />}
        {c.derivedState != null && <StateChip state={c.derivedState} />}
        {c.threadId != null && (
          <button
            type="button"
            onClick={() => onOpenThread(c, c.threadId!)}
            className="shrink-0 font-medium text-sky-600 hover:underline dark:text-sky-400"
          >
            Open thread
          </button>
        )}
        <span className={`ml-auto shrink-0 ${MUTED}`} title={dateTime(c.createdAt)}>
          {relativeTime(c.createdAt)}
        </span>
      </div>
      {c.body != null && c.body.trim() !== '' && <ClampedBody body={c.body} />}
    </article>
  );
}

/** One thread-root excerpt on the subject's PRs — today's state chip riding the same row (the
 *  addressed subset is a HIGHLIGHT on this one list, never a second population). Full
 *  ThreadCards stay one click away by design (each would need a usePr per PR). */
function ThreadExcerptCard({
  t,
  onOpen,
}: {
  t: PersonEvidenceThreadRef;
  onOpen: (t: PersonEvidenceThreadRef) => void;
}): JSX.Element {
  return (
    <article
      data-ev-anchor={`th:${t.threadId}`}
      className="rounded-md border border-gray-200 bg-white p-2 text-sm dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="shrink-0 font-medium text-gray-700 dark:text-gray-200">
          {t.repoFullName} #{t.prNumber}
        </span>
        {t.path != null && (
          <span className="min-w-0 truncate font-mono text-gray-400" title={t.path}>
            {t.path}
          </span>
        )}
        <StateChip state={t.derivedState} />
        <button
          type="button"
          onClick={() => onOpen(t)}
          className="shrink-0 font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Open thread
        </button>
        <span className={`ml-auto shrink-0 ${MUTED}`} title={dateTime(t.createdAt)}>
          {relativeTime(t.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-gray-600 dark:text-gray-300">{t.excerpt}</p>
    </article>
  );
}

function MoreLine({ more, unit }: { more: number; unit: string }): JSX.Element | null {
  if (more <= 0) return null;
  return (
    <div className={`text-[11px] ${MUTED}`}>
      and {more} more {unit}
    </div>
  );
}

// ── The Pro narrative ("Claude's read") ───────────────────────────────────────────────────────

function NarrativePanel({
  workspaceId,
  userId,
  fromMs,
  toMs,
  wanted,
  granted,
  request,
  release,
  onRefClick,
}: {
  workspaceId: number | null;
  userId: number;
  fromMs: number | null;
  toMs: number | null;
  /** The section has an admitted person + real bounds — nothing fires without both. */
  wanted: boolean;
  granted: boolean;
  request: (userId: number) => void;
  release: (userId: number) => void;
  onRefClick: (ref: string) => void;
}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const enabled = wanted && activityDigest && fromMs != null && toMs != null;
  const descriptor = useMemo<SynthesisDescriptor>(
    () => ({ kind: 'person_report', window: 'rolling_14', userId, fromMs, toMs }),
    [userId, fromMs, toMs],
  );
  const { data } = useSynthesis(workspaceId, descriptor, enabled);
  const generate = useGenerateSynthesis(workspaceId, descriptor);
  const generating = useSynthesisGenerating(workspaceId, descriptor);

  // The throttle backoff: after a `throttled` POST the section withdraws from the queue and
  // re-requests once the interval passes (the server's claim/min-interval answered — nothing
  // was billed; hammering it would just collect more throttles).
  const [coolingDown, setCoolingDown] = useState(false);
  const cooldownRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (cooldownRef.current != null) window.clearTimeout(cooldownRef.current);
    },
    [],
  );

  // A HARD failure (an ai-tier 429, or a 5xx out of the generation itself) settles with no
  // result: no cooldown is armed and the attempt key stays claimed. That is the useAutoNarration
  // posture — one attempt per staleness observation, then quiet — but the section must also stop
  // ASKING, or it re-requests, is granted, hits the `attemptedRef` early return, and holds the
  // queue's single grant for the tab's lifetime under a "queued…" label with nothing running.
  const [failed, setFailed] = useState(false);
  // A new attempt KEY (different subject/period, or a row generated since) is a genuinely new
  // staleness observation and earns one more attempt; the failed one is never retried on its own.
  useEffect(
    () => setFailed(false),
    [workspaceId, userId, fromMs, toMs, data?.synthesis?.generatedAt],
  );

  const needsGeneration =
    enabled && data?.enabled === true && (data.synthesis == null || data.stale === true);

  // Ask for (or leave) the queue. Dispatches are idempotent reducer transitions, so re-running
  // on unrelated renders is free; leaving covers a cache landing while queued.
  useEffect(() => {
    if (needsGeneration && !generating && !coolingDown && !failed) request(userId);
    else if (!needsGeneration || failed) release(userId);
  }, [needsGeneration, generating, coolingDown, failed, request, release, userId]);
  // Release on unmount so a closed tab never wedges the queue on a vanished section.
  useEffect(() => () => release(userId), [release, userId]);

  // Fire ONLY while granted — one attempt per staleness observation (the useAutoNarration
  // guard), cleared when a throttle schedules a retry so the backoff attempt isn't swallowed.
  const attemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!granted) return;
    if (!needsGeneration || generating || coolingDown || failed || workspaceId == null) {
      // Granted but nothing to do (raced a cache fill / a cooldown / a spent attempt) — hand
      // the turn on. NEVER hold the grant on a branch that will not mutate.
      if (!needsGeneration || coolingDown || failed) release(userId);
      return;
    }
    const attemptKey = `${workspaceId}|${userId}|${fromMs ?? '-'}|${toMs ?? '-'}|${
      data?.synthesis?.generatedAt ?? '-'
    }`;
    if (attemptedRef.current === attemptKey) {
      // This staleness observation has already been spent — releasing is the whole point: the
      // early return used to keep the queue's `current` pinned here with nothing in flight.
      release(userId);
      return;
    }
    attemptedRef.current = attemptKey;
    generate.mutate(undefined, {
      onSettled: (result) => {
        if (result?.throttled) {
          attemptedRef.current = null; // the backoff retry must be allowed to fire
          setCoolingDown(true);
          cooldownRef.current = window.setTimeout(
            () => setCoolingDown(false),
            THROTTLE_BACKOFF_MS,
          );
        } else if (result == null) {
          // Threw (429 / 5xx) — go quiet rather than re-queueing (see `failed`).
          setFailed(true);
        }
        release(userId);
      },
    });
    // `generate` is identity-stable enough for this once-per-key guard; the ref is the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    granted,
    needsGeneration,
    generating,
    coolingDown,
    failed,
    workspaceId,
    userId,
    fromMs,
    toMs,
    data?.synthesis?.generatedAt,
  ]);

  // Free tier / OSS / no bounds yet: absence, never an error — the deterministic vector and
  // evidence cards above are the surface either way (§8.20).
  if (!enabled || data?.enabled === false) return null;

  const synth = data?.synthesis ?? null;
  const sections = synth?.sections ?? [];
  // `failed` drops out of `working`: a spent attempt is not queued and nothing is running, and
  // "queued…" over a dead attempt is a worse lie than the plain "No narrative yet." below.
  const working = generating || granted || (needsGeneration && !failed && data != null);

  return (
    <div className="rounded-lg border border-ai-border bg-ai-surface p-3">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ai-ink">
          Claude’s read
        </span>
        {/* D4, said where the prose is: the model writes digit-free sections; every number on
            this page is computed from the vector/evidence wire fields. */}
        <span className={`text-[11px] ${MUTED}`}>
          evidence-cited prose — every figure on this page is computed, not written
        </span>
        {data?.stale === true && synth != null && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            stale
          </span>
        )}
        {working && (
          <span className={`ml-auto text-[11px] ${MUTED}`}>
            {generating ? 'writing…' : 'queued…'}
          </span>
        )}
      </div>
      {synth == null ? (
        <div className={`text-[11px] ${MUTED}`}>
          {working ? 'Writing this section…' : 'No narrative yet.'}
        </div>
      ) : sections.length === 0 ? (
        // A stored-[] row is a real state (unparseable generation, stored so a click never
        // loop-bills) — the deterministic surface above stays primary.
        <div className={`text-[11px] ${MUTED}`}>
          No narrative for this period — the figures and evidence above are the surface.
        </div>
      ) : (
        <div className="space-y-2">
          {sections.map((s) => (
            <div key={s.id}>
              <div className="text-[11px] font-semibold text-ai-ink">{SECTION_TITLE[s.id]}</div>
              <p className="text-[12px] leading-relaxed text-gray-700 dark:text-gray-200">
                {s.prose}
              </p>
              {s.refs.length > 0 && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {/* The citation chips — count computed (refs.length), each scrolls to /
                      flashes the cited evidence card. */}
                  <span className={`text-[10px] ${MUTED}`}>
                    {s.refs.length} citation{s.refs.length === 1 ? '' : 's'}:
                  </span>
                  {s.refs.map((ref, i) => (
                    <button
                      key={ref}
                      type="button"
                      onClick={() => onRefClick(ref)}
                      title={ref}
                      className="rounded border border-ai-border px-1 text-[10px] tabular-nums text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2"
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Human section ─────────────────────────────────────────────────────────────────────────────

function HumanSection({
  selection,
  workspaceId,
  periodKey,
  granted,
  request,
  release,
}: {
  selection: PeopleReportSelection;
  workspaceId: number | null;
  periodKey: string;
  granted: boolean;
  request: (userId: number) => void;
  release: (userId: number) => void;
}): JSX.Element {
  const { periodReports } = useProCapabilities();
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const sectionRef = useRef<HTMLElement>(null);

  const q = usePersonPeriod(periodReports, workspaceId, selection.userId, periodKey, true);
  const person = q.data?.person ?? null;
  const evidence = person?.evidence ?? null;
  // The narration descriptor needs the REAL bounds, which the person response echoes (never
  // re-derived grid maths client-side — the PersonPeriodSection precedent).
  const fromMs = q.data?.periodStart != null ? Date.parse(q.data.periodStart) : null;
  const toMs = q.data?.periodEnd != null ? Date.parse(q.data.periodEnd) : null;

  const emptyIndex = useMemo(() => buildPrRefIndex([]), []);
  const openPrRef = useCallback(
    (ref: DigestPrRef): void => {
      if (ref.prId == null) return;
      openPrDetailTab(
        prRefToMeta({
          prId: ref.prId,
          prNumber: ref.prNumber,
          repoFullName: ref.repoFullName,
          title: ref.title,
          authorLogin: ref.authorLogin,
        }),
        { fromActivity: true },
      );
    },
    [openPrDetailTab],
  );
  const openComment = useCallback(
    (c: BotVendorComment): void => {
      openPrDetailTab(prRefToMeta({ ...c, title: c.prTitle }), { fromActivity: true });
    },
    [openPrDetailTab],
  );
  // Deep-link a thread: open the PR tab, then select the thread (PrDetail forces the Threads
  // tab and scrolls — the ThemeThreadsDetail flow).
  const openThread = useCallback(
    (
      ref: { prId: number; prNumber: number; repoFullName: string; title?: string | null },
      threadId: number,
    ): void => {
      openPrDetailTab(prRefToMeta(ref), { fromActivity: true });
      useFilters.getState().selectThread(ref.prId, threadId);
    },
    [openPrDetailTab],
  );

  // A narrative citation chip → scroll to + flash the cited card (or vector row) within THIS
  // section. Imperative classList (event-handler-local, no state churn); the class strings are
  // literals so Tailwind emits them. A `pr:` anchor is a zero-height span above its table, so
  // the flash lands on the enclosing evidence group; the bg class is what shows on a <tr>
  // (ring/box-shadow is unreliable on table rows).
  const flashRef = useRef<number | null>(null);
  const onRefClick = useCallback((ref: string): void => {
    const key = refAnchorKey(ref);
    if (key == null || sectionRef.current == null) return;
    const el = sectionRef.current.querySelector<HTMLElement>(
      `[data-ev-anchor="${CSS.escape(key)}"]`,
    );
    if (el == null) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const target = el.closest<HTMLElement>('[data-ev-anchor-group]') ?? el;
    const FLASH = ['ring-2', 'ring-ai-signal/60', 'bg-ai-signal/10'];
    target.classList.add(...FLASH);
    if (flashRef.current != null) window.clearTimeout(flashRef.current);
    flashRef.current = window.setTimeout(() => target.classList.remove(...FLASH), 1600);
  }, []);

  // The evidence PR groups, in the vector's own key order (the tested fold — never a
  // metric-sorted or size-sorted rearrangement).
  const prGroups = evidence ? evidencePrGroups(evidence.prs) : [];

  return (
    <section
      ref={sectionRef}
      aria-label={selection.label}
      className="rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        {selection.avatarUrl != null ? (
          <img
            src={selection.avatarUrl}
            width={18}
            height={18}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-[18px] w-[18px] shrink-0 rounded-full bg-gray-200 dark:bg-gray-800"
          />
        ) : (
          <PersonIcon size={18} className="shrink-0" />
        )}
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {selection.label}
        </span>
        {selection.login != null && selection.login !== selection.label && (
          <span className={`text-[11px] ${MUTED}`}>@{selection.login}</span>
        )}
      </div>

      {q.isLoading ? (
        <div className={`py-1 text-[11px] ${MUTED}`}>Loading period figures…</div>
      ) : person == null ? (
        // The server is the final word on admission — a stranger/bot chip degrades to the
        // section's own null state, never an error.
        <div className={`text-[11px] ${MUTED}`}>
          Nothing to report — no activity from them in this Workspace this period.
        </div>
      ) : (
        <div className="space-y-3">
          {/* Coverage honesty — both grains, stated beside the figures they qualify. */}
          {!person.coverage.complete && (
            <div className="rounded-md border border-amber-300 bg-amber-50/50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
              Partial coverage: {person.coverage.trackedRepos} of {person.coverage.totalRepos}{' '}
              repos in this workspace were being tracked when this period started — these figures
              under-count it.
            </div>
          )}
          {person.firstObservedMidWindow && person.firstSeenAt != null && (
            <div className="rounded-md border border-amber-300 bg-amber-50/50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
              First observed here {new Date(person.firstSeenAt).toLocaleDateString()} — after
              this period began, so the period figures under-count them.
            </div>
          )}

          {/* The person vector, verbatim — the 1:1 table's vocabulary and honesty rules
              (null → —, `thin`, `now`), each row anchorable by a narrative citation. */}
          <table className="w-full text-xs">
            <tbody>
              {person.metrics.map((m) => (
                <tr
                  key={m.key}
                  data-ev-anchor={`metric:${m.key}`}
                  className="border-t border-gray-100 first:border-0 dark:border-gray-800"
                >
                  <td className="py-1 pr-2 text-gray-500 dark:text-gray-400" title={KEY_TITLE[m.key]}>
                    {KEY_LABEL[m.key]}
                    {m.basis === 'live' && (
                      <span
                        className={`ml-1.5 rounded border border-gray-300 px-1 text-[9px] uppercase tracking-wide ${MUTED} dark:border-gray-700`}
                        title="A live reading — today’s state, not a period figure; it keeps moving after the period closes"
                      >
                        now
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-right font-medium tabular-nums text-gray-800 dark:text-gray-100">
                    {/* null is "no data" and renders as a dash — NEVER as 0. */}
                    {fmtValue(m)}
                    {m.lowSample && m.value != null && (
                      <span
                        className={`ml-1 text-[10px] font-normal ${MUTED}`}
                        title="Below this metric’s sample floor — the figure is real, but thin"
                      >
                        · thin
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* The Pro narrative — absence (free tier / OSS / no bounds) renders nothing. */}
          <NarrativePanel
            workspaceId={workspaceId}
            userId={selection.userId}
            fromMs={fromMs}
            toMs={toMs}
            wanted={true}
            granted={granted}
            request={request}
            release={release}
            onRefClick={onRefClick}
          />

          {/* Evidence — the receipt rows the metrics were computed over (same fold, same caps;
              the narrative's citations land on exactly these cards). */}
          {evidence != null && (
            <div className="space-y-3">
              {prGroups.map((g) => (
                <div key={g.key}>
                  <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${MUTED}`}>
                    {KEY_LABEL[g.key]}
                  </div>
                  {/* Rows are DigestPrRefs — the digest table idiom, newest-first as served.
                      Each row anchors under its prId for the `pe<v>:pr:` citations. */}
                  <div data-ev-anchor-group={g.key}>
                    <PrRowAnchors rows={g.rows} />
                    <PrTable
                      groups={[{ prs: g.rows, summary: '' }]}
                      onOpenPr={openPrRef}
                      usersById={usersById}
                      index={emptyIndex}
                    />
                  </div>
                  <MoreLine more={g.more} unit="PRs" />
                </div>
              ))}

              {evidence.comments.rows.length > 0 && (
                <div>
                  {/* The group is a SUPERSET of the metric above it — the cell counts inline
                      review comments, these cards (and their "and N more") span inline + PR
                      comments — so the heading says so. Every other group on this page matches
                      its figure exactly; an undisclosed wider population would read as one of
                      those and quietly contradict the number. */}
                  <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${MUTED}`}>
                    Their review comments{' '}
                    <span className="font-normal normal-case tracking-normal">
                      (inline + PR comments — wider than the inline-only figure above)
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {evidence.comments.rows.map((c) => (
                      <EvidenceCommentCard
                        key={`${c.targetKind}:${c.targetId}`}
                        c={c}
                        onOpenPr={openComment}
                        onOpenThread={(cc, threadId) =>
                          openThread({ ...cc, title: cc.prTitle }, threadId)
                        }
                      />
                    ))}
                  </div>
                  <MoreLine more={evidence.comments.more} unit="comments" />
                </div>
              )}

              {evidence.threads.rows.length > 0 && (
                <div>
                  <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${MUTED}`}>
                    Threads opened on their PRs
                  </div>
                  <div className="space-y-1.5">
                    {evidence.threads.rows.map((t) => (
                      <ThreadExcerptCard
                        key={t.threadId}
                        t={t}
                        onOpen={(tt) => openThread(tt, tt.threadId)}
                      />
                    ))}
                  </div>
                  <MoreLine more={evidence.threads.more} unit="threads" />
                </div>
              )}

              {evidence.pathAreas.length > 0 && (
                <div>
                  <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${MUTED}`}>
                    Where they worked
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {evidence.pathAreas.map((a) => (
                      <span
                        key={a.bucket}
                        data-ev-anchor={`area:${a.bucket}`}
                        className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 dark:border-gray-800 dark:text-gray-300"
                        title={`${a.files} files touched across ${a.commits} commits on PRs they authored this period`}
                      >
                        <span className="font-mono">{a.bucket}</span>
                        <span className={`ml-1 tabular-nums ${MUTED}`}>
                          {a.files} files · {a.commits} commits
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Invisible per-PR anchors for the `pe<v>:pr:<prId>` citations — PrTable owns its row markup,
 *  so the anchors sit as zero-height siblings immediately above the table. Scrolling lands on
 *  the table's top, which contains the row; the flash ring wraps the whole group. */
function PrRowAnchors({ rows }: { rows: DigestPrRef[] }): JSX.Element {
  return (
    <>
      {rows.map((r) =>
        r.prId != null ? <span key={r.prId} data-ev-anchor={`pr:${r.prId}`} /> : null,
      )}
    </>
  );
}

// ── Bot section ───────────────────────────────────────────────────────────────────────────────

const VERDICT_META: Record<BotVerdict, { label: string; cls: string }> = {
  keep: { label: 'keep', cls: 'bg-green-500/10 text-green-700 dark:text-green-300' },
  tune: { label: 'tune', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  noisy: { label: 'noisy', cls: 'bg-red-500/10 text-red-700 dark:text-red-300' },
};

function Stat({
  label,
  value,
  title,
}: {
  label: string;
  // ReactNode, not string: the Inflation cell renders ArrowIcons beside its two counts.
  value: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <div title={title}>
      <div className={`text-[10px] uppercase tracking-wide ${MUTED}`}>{label}</div>
      <div className="text-sm font-semibold tabular-nums text-gray-800 dark:text-gray-100">
        {value}
      </div>
    </div>
  );
}

// Compact human duration ("45m" / "6h" / "1.8d") — the ROI table's spelling.
function dur(ms: number | null): string {
  if (ms == null) return '—';
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h`;
  const days = hrs / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

// ── The authoring vector's presentation ──────────────────────────────────────────────────────
//
// Labels live here rather than in the fold: the fold's job is the number. Every one of these is a
// COUNT or a code-computed median — nothing on this panel is model-authored, which is why the
// section keeps its "deterministic breakdown — no model narrative for bots" caption even now that
// it renders two vectors.
const AUTOMATION_LABEL: Record<AutomationMetricKey, string> = {
  prs_opened: 'PRs opened',
  prs_merged: 'PRs merged',
  prs_closed_unmerged: 'Closed unmerged',
  merge_rate_pct: 'Merge rate',
  median_hours_to_merge: 'Median time to merge',
  median_pr_size_lines: 'Median size',
  prs_merged_without_human_review: 'Merged with no human review',
  human_review_comments_received: 'Human review comments',
  repos_touched: 'Repos touched',
};

const AUTOMATION_TITLE: Record<AutomationMetricKey, string> = {
  prs_opened: 'PRs this automation opened inside the period',
  prs_merged: 'PRs this automation authored that were merged inside the period',
  prs_closed_unmerged:
    'PRs it authored that were closed inside the period WITHOUT merging — the churn it cost for nothing',
  merge_rate_pct:
    'Merged ÷ (merged + closed-unmerged), over PRs RESOLVED in the period — not over PRs opened, since one opened on the last day has not had its chance yet',
  median_hours_to_merge: 'Median open → merged, over the PRs merged inside the period',
  median_pr_size_lines: 'Median added + deleted lines, over the PRs merged inside the period',
  prs_merged_without_human_review:
    'Of the PRs merged in the period, how many no human ever reviewed or commented on — the ones that cost nobody any time',
  human_review_comments_received:
    'Review comments people left on its PRs inside the period — where it did cost time',
  repos_touched: 'Repos it opened or merged a PR in during the period',
};

function fmtAutomation(m: AutomationMetricValue): string {
  if (m.value == null) return '—';
  switch (m.key) {
    case 'merge_rate_pct':
      return `${Math.round(m.value)}%`;
    case 'median_hours_to_merge':
      return m.value < 24 ? `${Math.round(m.value)}h` : `${(m.value / 24).toFixed(1)}d`;
    case 'median_pr_size_lines':
      return `${Math.round(m.value).toLocaleString()} lines`;
    default:
      return Math.round(m.value).toLocaleString();
  }
}

// The authored-PR vector + its receipts. Rendered UNDER the review block when both exist, so a
// code agent that reviews and writes reads as one actor doing two things rather than two rows.
function AuthoringPanel({
  output,
  usersById,
  onOpenPr,
}: {
  output: AutomationOutput;
  usersById: Map<number, User>;
  onOpenPr: (ref: DigestPrRef) => void;
}): JSX.Element {
  // These rows carry no narrative, so there are no `pe<v>:` citations to resolve against — the
  // empty index is the honest argument, not a placeholder.
  const noIndex = useMemo(() => buildPrRefIndex([]), []);
  const ev = output.evidence;
  const byKey = new Map(output.metrics.map((m) => [m.key, m] as const));
  const groups: { label: string; rows: DigestPrRef[]; more: number; title: string }[] = [];
  if (ev != null) {
    if (ev.merged.length > 0)
      groups.push({ label: 'Merged', rows: ev.merged, more: ev.mergedMore, title: 'PRs merged inside the period' });
    if (ev.closedUnmerged.length > 0)
      groups.push({
        label: 'Closed unmerged',
        rows: ev.closedUnmerged,
        more: ev.closedUnmergedMore,
        title: 'Closed inside the period without merging',
      });
    if (ev.humanReviewed.length > 0)
      groups.push({
        label: 'Drew human review',
        rows: ev.humanReviewed,
        more: ev.humanReviewedMore,
        title: 'Its PRs that a person commented on inside the period',
      });
  }

  return (
    <div className="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          What it authored
        </span>
        <span className={`text-[11px] ${MUTED}`}>
          PRs this automation wrote — the output its role is actually measured by
        </span>
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-5">
        {AUTOMATION_METRIC_KEYS.map((k) => {
          const m = byKey.get(k);
          if (m == null) return null;
          return (
            <Stat
              key={k}
              label={AUTOMATION_LABEL[k]}
              value={fmtAutomation(m)}
              title={AUTOMATION_TITLE[k]}
            />
          );
        })}
      </div>
      {output.repos.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`text-[10px] uppercase tracking-wide ${MUTED}`}>Where</span>
          {output.repos.map((r) => (
            <span
              key={r.repoId}
              className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-900 dark:text-gray-300"
            >
              {r.repoFullName.split('/')[1] ?? r.repoFullName} · {r.prs}
            </span>
          ))}
        </div>
      )}
      {groups.map((g) => (
        <div key={g.label}>
          <div
            className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${MUTED}`}
            title={g.title}
          >
            {g.label}
          </div>
          <PrTable
            groups={[{ prs: g.rows, summary: '' }]}
            onOpenPr={onOpenPr}
            usersById={usersById}
            index={noIndex}
          />
          {/* The two closed/merged remainders ARE population figures; the human-review one is
              over what the capped scan saw, so it says "at least". */}
          <MoreLine
            more={g.more}
            unit={g.label === 'Drew human review' ? 'more PRs at least' : 'PRs'}
          />
        </div>
      ))}
    </div>
  );
}

function BotSection({
  selection,
  workspaceId,
  bounds,
  row,
  analyticsLoading,
}: {
  selection: PeopleReportSelection;
  workspaceId: number | null;
  bounds: PeriodBounds | null;
  row: BotVendorAnalytics | null;
  analyticsLoading: boolean;
}): JSX.Element {
  const { botDepth } = useProCapabilities();
  const openBotDetailTab = usePinnedTabs((s) => s.openBotDetailTab);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const botColor = useBotColors(workspaceId);
  const [showAllComments, setShowAllComments] = useState(false);

  const comments = useReportBotComments(workspaceId, selection.userId, bounds, true);
  const authoring = useReportBotAuthoring(workspaceId, selection.userId, bounds, true);
  const authored = authoring.data?.output ?? null;
  const { data: usersForRefs } = useUsers();
  const usersById = useMemo(() => indexUsers(usersForRefs), [usersForRefs]);
  const openPrRef = useCallback(
    (ref: DigestPrRef): void => {
      if (ref.prId == null) return;
      openPrDetailTab(
        prRefToMeta({
          prId: ref.prId,
          prNumber: ref.prNumber,
          repoFullName: ref.repoFullName,
          title: ref.title,
          authorLogin: ref.authorLogin,
        }),
        { fromActivity: true },
      );
    },
    [openPrDetailTab],
  );
  const rows = comments.data?.comments ?? [];
  const shown = showAllComments ? rows : rows.slice(0, BOT_COMMENT_SHOW_CAP);
  // The disclosed client-side sample — folded over the FETCHED rows, captioned with that exact
  // count (never presented as a population figure; the population lives in the row's columns).
  const where = useMemo(() => foldWhereItWorks(rows), [rows]);

  const openComment = useCallback(
    (c: BotVendorComment): void => {
      openPrDetailTab(prRefToMeta({ ...c, title: c.prTitle }), { fromActivity: true });
    },
    [openPrDetailTab],
  );
  const openThread = useCallback(
    (c: BotVendorComment, threadId: number): void => {
      openPrDetailTab(prRefToMeta({ ...c, title: c.prTitle }), { fromActivity: true });
      useFilters.getState().selectThread(c.prId, threadId);
    },
    [openPrDetailTab],
  );

  const color = botColor({ login: selection.login, kind: row?.kind ?? 'in_house' });
  const inf = row?.mlInflation;

  return (
    <section
      aria-label={selection.label}
      className="rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {selection.label}
        </span>
        {row != null && (
          <span className={`text-[11px] ${MUTED}`}>{automatedReviewerMeta(row.kind).label}</span>
        )}
        {row != null && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${VERDICT_META[row.verdict].cls}`}
            title="The ROI table's keep/tune/noisy verdict over this period's thread math"
          >
            {VERDICT_META[row.verdict].label}
          </span>
        )}
        {row?.dormant === true && (
          <span className={`text-[10px] uppercase tracking-wide ${MUTED}`}>dormant</span>
        )}
        {/* The design, said where a reader will look for the missing prose — and the SCOPE
            said with it: every figure below is review output (threads, comments, what humans
            did with them). The picker deliberately offers dependency bots, code agents and
            release automation too, whose real output is PRs they AUTHORED; this section does
            not chart those, so it must not let a wall of zeros read as "it did nothing". */}
        <span className={`ml-auto text-[11px] ${MUTED}`}>
          deterministic breakdown — no model narrative for bots
        </span>
        {botDepth && (
          <button
            type="button"
            onClick={() =>
              openBotDetailTab(selection.userId, {
                id: selection.userId,
                login: selection.login,
                label: selection.label,
                kind: row?.kind ?? 'in_house',
                repoId: null,
              })
            }
            className="rounded border border-sky-300 px-2 py-0.5 text-[11px] font-medium text-sky-600 hover:bg-sky-50 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/40"
            title="Open this bot's paid depth tab — trends, heatmaps, weekly inflation history, per-seat cost"
          >
            Depth →
          </button>
        )}
      </div>

      {analyticsLoading ? (
        <div className={`py-1 text-[11px] ${MUTED}`}>Loading period figures…</div>
      ) : row == null && authored == null ? (
        // BOTH folds are empty. This is now a real "it did nothing here" — it used to be the
        // catch-all for authoring automation, which had output the section simply could not see.
        <div className={`text-[11px] ${MUTED}`}>
          {authoring.isPending
            ? 'Loading period figures…'
            : 'No review output and no authored PRs in this period.'}
        </div>
      ) : row == null ? (
        // Authoring-only automation (dependency bots, most code agents, release bots). Its review
        // columns are legitimately zero, so the section renders the authored vector ALONE rather
        // than a wall of zeros above it.
        <AuthoringPanel output={authored!} usersById={usersById} onOpenPr={openPrRef} />
      ) : (
        <div className="space-y-3">
          {/* The FREE ROI-row facts over the REAL period (the routes' fromMs/toMs bounds). */}
          <div className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-5">
            <Stat label="Threads" value={String(row.threads)} />
            <Stat label="Comments" value={String(row.comments)} />
            <Stat
              label="Acted on"
              value={`${row.actedOn}${row.actedOnPct != null ? ` (${row.actedOnPct}%)` : ''}`}
              title="Threads a human replied to, resolved, or likely addressed"
            />
            <Stat
              label="Untouched"
              value={`${row.untouched}${row.overdueUntouched > 0 ? ` · ${row.overdueUntouched} overdue` : ''}`}
              title="Not-addressed threads; 'overdue' = older than the grace window (genuinely ignored)"
            />
            <Stat
              label="Median addressed"
              value={dur(row.medianAddressedMs)}
              title="This bot's median time-to-addressed (reply | resolve | addressing commit)"
            />
            <Stat
              label="Merged past"
              value={`${row.mergedPastPrs} PRs · ${row.mergedPastThreads} threads`}
              title="PRs merged this period still carrying ≥1 untouched thread by this bot at merge — the team's final answer was to ship anyway"
            />
            {/* ML columns are ABSENT (blanks), never zeros, when nothing is labelled — "no data
                yet" and "zero findings" are different claims. */}
            {row.mlFindings != null && (
              <Stat
                label="Findings (ML)"
                value={String(row.mlFindings)}
                title="Labelled findings this period (summaries/praise excluded)"
              />
            )}
            {row.mlBySeverity != null && (
              <Stat
                label="Severity mix"
                value={`${row.mlBySeverity.critical + row.mlBySeverity.major} high · ${row.mlBySeverity.minor} minor · ${row.mlBySeverity.nit} nit`}
                title="Our model's severity of this bot's labelled findings (major+critical bucketed as high)"
              />
            )}
            {row.notAddressedBySeverity != null && (
              <Stat
                label="Ignored, by severity"
                value={`${row.notAddressedBySeverity.critical + row.notAddressedBySeverity.major} high · ${row.notAddressedBySeverity.minor} minor · ${row.notAddressedBySeverity.nit} nit`}
                title="Untouched threads split by the predicted severity of the finding that opened each one (labelled subset only — these need not sum to Untouched)"
              />
            )}
            <Stat
              label="Inflation"
              value={
                inf == null || inf.badged === 0 ? (
                  '—'
                ) : (
                  <>
                    <ArrowIcon dir="up" size={11} className="inline-block align-[-0.1em]" />
                    {inf.overCall}{' '}
                    <ArrowIcon dir="down" size={11} className="inline-block align-[-0.1em]" />
                    {inf.underCall} of {inf.badged}
                  </>
                )
              }
              title={
                inf == null || inf.badged === 0
                  ? 'Badges nothing — no badge is silence, not agreement'
                  : `Of ${inf.badged} findings carrying the bot's own badge: ${inf.overCall} badged worse than our model rated (inflation), ${inf.underCall} milder`
              }
            />
          </div>

          {/* "Where it works" — a disclosed sample over the fetched cards, never a population
              figure. */}
          {rows.length > 0 && (
            <div>
              <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${MUTED}`}>
                Where it works{' '}
                <span className="font-normal normal-case">
                  — across the {where.sampleSize} most recent comments below
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {where.repos.map(([name, n]) => (
                  <span
                    key={`r:${name}`}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 dark:border-gray-800 dark:text-gray-300"
                  >
                    {name} <span className={`tabular-nums ${MUTED}`}>· {n}</span>
                  </span>
                ))}
                {where.areas.map(([bucket, n]) => (
                  <span
                    key={`a:${bucket}`}
                    className="rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 dark:border-gray-800 dark:text-gray-300"
                  >
                    {bucket} <span className={`font-sans tabular-nums ${MUTED}`}>· {n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Evidence — what it actually said this period (ML label + thread state inline;
              one request, zero queries per card). */}
          {comments.isLoading ? (
            <div className={`text-[11px] ${MUTED}`}>Loading comments…</div>
          ) : rows.length > 0 ? (
            <div>
              <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${MUTED}`}>
                What it said
              </div>
              <div className="space-y-1.5">
                {shown.map((c) => (
                  <EvidenceCommentCard
                    key={`${c.targetKind}:${c.targetId}`}
                    c={c}
                    onOpenPr={openComment}
                    onOpenThread={openThread}
                  />
                ))}
              </div>
              {!showAllComments && rows.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setShowAllComments(true)}
                  className="mt-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
                >
                  Show all {rows.length} comments
                </button>
              )}
              {comments.data?.truncated === true && (
                <div className={`mt-1 text-[11px] ${MUTED}`}>
                  and more — the period holds more comments than were fetched.
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ── The report ────────────────────────────────────────────────────────────────────────────────

export function PeopleReportDetail(): JSX.Element {
  const seed = useFilters((s) => s.peopleReportSeed);
  const workspaceId = useFilters((s) => s.workspaceId);
  const { periodReports } = useProCapabilities();

  // The narration queue — ONE granted section at a time (alphabetical: sections mount in
  // render order and request in effect order; a throttled retry re-queues at the back).
  const [queue, dispatch] = useReducer(reduceNarrationQueue, NARRATION_QUEUE_IDLE);
  const request = useCallback((userId: number) => dispatch({ type: 'request', userId }), []);
  const release = useCallback((userId: number) => dispatch({ type: 'release', userId }), []);

  // The report belongs to the workspace it was begun in. Period keys are cadence-grid strings,
  // so switching workspace with this tab open would otherwise re-key every section query to the
  // new scope while the heading still named only the period — the old selections rendered
  // against new data, with no signal that the artifact changed scope. A mismatch degrades to the
  // same "reopen it from Reports → People" state a dropped period does.
  const seedInScope = seed != null && workspaceId != null && seed.workspaceId === workspaceId;

  // The period resolved against the SAME list the picker gated on (never re-derived grid maths).
  const list = usePeriodReportsList(periodReports, workspaceId);
  const period = seedInScope
    ? (list.data?.periods ?? []).find((p) => p.periodKey === seed!.periodKey) ?? null
    : null;
  const bounds: PeriodBounds | null =
    period != null
      ? { fromMs: Date.parse(period.periodStart), toMs: Date.parse(period.periodEnd) }
      : null;

  const ordered = useMemo(() => orderSelections(seed?.selections ?? []), [seed]);
  const hasBots = ordered.some((s) => s.kind === 'bot');

  // ONE analytics fetch for every bot section; rows picked client-side by `u<userId>`.
  const analytics = useReportBotAnalytics(workspaceId, bounds, hasBots);
  const rowByKey = useMemo(() => {
    const m = new Map<string, BotVendorAnalytics>();
    for (const v of analytics.data?.vendors ?? []) m.set(v.key, v);
    // A picked quality-gate/dependency bot is legitimate — the picker's union spans every
    // automation family, and the row shape is identical.
    for (const v of analytics.data?.qualityChecks ?? []) m.set(v.key, v);
    return m;
  }, [analytics.data]);

  if (seed == null) {
    return (
      <div className="p-6 text-sm text-gray-400">
        No report seeded. Open Reports → People, pick people or bots, and Begin report.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          People report
          {period != null ? ` · ${periodTitle(period.periodStart, period.periodEnd)}` : ''}
        </h2>
        <span className="text-[11px] text-gray-400">
          {ordered.length} section{ordered.length === 1 ? '' : 's'}
        </span>
        {/* The standing caption — the §6 posture, said on the artifact itself. */}
        <span className="text-[11px] text-gray-400">
          one section per person or bot, alphabetical — not a leaderboard
        </span>
      </div>

      {!seedInScope ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          This report was begun in another workspace — reopen it from Reports → People in the
          workspace you want to report on.
        </div>
      ) : list.isLoading ? (
        <div className="text-sm text-gray-400">Loading the period list…</div>
      ) : period == null ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          This period is no longer listed for the current workspace — reopen the report from
          Reports → People.
        </div>
      ) : (
        <div className="space-y-4">
          {ordered.map((sel) =>
            sel.kind === 'human' ? (
              <HumanSection
                key={`human:${sel.userId}`}
                selection={sel}
                workspaceId={workspaceId}
                periodKey={seed.periodKey}
                granted={queue.current === sel.userId}
                request={request}
                release={release}
              />
            ) : (
              <BotSection
                key={`bot:${sel.userId}`}
                selection={sel}
                workspaceId={workspaceId}
                bounds={bounds}
                row={rowByKey.get(`u${sel.userId}`) ?? null}
                analyticsLoading={analytics.isLoading}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
