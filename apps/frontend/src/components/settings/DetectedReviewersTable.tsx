import { useMemo, useState } from 'react';
import type { AutomatedReviewerKind, DetectedReviewer, ReviewerRole } from '@pierre-review/shared';
import { NO_TEAM_KEY } from '@pierre-review/shared';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import {
  useDeleteReviewerOverride,
  useDetectedReviewers,
  useReviewerOverride,
} from '../../hooks/useBotTriage.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { SectionShell, inputCls } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];
const MAX_SEARCH_MATCHES = 8;

// The account's automated reviewers, plus a search box to promote any human reviewer to a bot.
// CORE — the two-way override (mark automated / not-a-bot), the vendor kind/label, and the
// ReviewerRole all POST to /api/bot-reviewers.
//
// `teamId` is the TEAM whose answers are being edited (NO_TEAM_KEY = "No team (default)", which
// is BOTH the No-team scope and the inheritance root every other team falls back to). A row the
// server reports as `inherited` came from the default rather than an explicit row for this team;
// editing it CREATES a team override, and "Reset to default" (only offered on a real override)
// removes it again.
//
// Two lists, because a quality check is not a reviewer: **Review bots** (AI code reviewers — the
// ones every metric counts) and **Quality checks** (static analysis / coverage / lint — still
// automated, still visible in the feed, but excluded from ROI, behaviour, dedup and the
// benchmark). The role is a SEPARATE control from the vendor kind: they are orthogonal axes, so
// DeepSource can be marked a quality check without losing its brand identity or colour.
//
// Only automated reviewers are listed by default (an account can have dozens of human
// maintainers — the full list is unusable); the search below finds a person by login/name and
// marks them a bot, after which they move into the list where kind/label/role are editable.
export function DetectedReviewersTable({
  teamId = NO_TEAM_KEY,
}: { teamId?: number } = {}): JSX.Element {
  const q = useDetectedReviewers(teamId);
  const botColor = useBotColors();
  const override = useReviewerOverride();
  const resetOverride = useDeleteReviewerOverride();
  const [drafts, setDrafts] = useState<
    Record<number, { kind: AutomatedReviewerKind; label: string }>
  >({});
  const [query, setQuery] = useState('');

  const rowDraft = (r: DetectedReviewer): { kind: AutomatedReviewerKind; label: string } =>
    drafts[r.userId] ?? { kind: r.classification.kind ?? 'in_house', label: r.classification.label };
  const patchDraft = (
    r: DetectedReviewer,
    patch: Partial<{ kind: AutomatedReviewerKind; label: string }>,
  ): void => setDrafts((prev) => ({ ...prev, [r.userId]: { ...rowDraft(r), ...patch } }));

  const busy = override.isPending || resetOverride.isPending;
  const reviewers = q.data?.reviewers ?? [];
  const automated = reviewers.filter((r) => r.classification.automated === true);
  const humans = reviewers.filter((r) => r.classification.automated !== true);
  // The role split. `role` is meaningless on a human (callers must gate on `automated` first),
  // which is why it is only read inside the automated subset.
  const reviewBots = automated.filter((r) => r.classification.role !== 'quality_check');
  const qualityChecks = automated.filter((r) => r.classification.role === 'quality_check');

  // Only surface the (potentially huge) human list once the user types — that's the whole point.
  const trimmedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (trimmedQuery === '') return [];
    return humans
      .filter((h) => `${h.login} ${h.displayName ?? ''}`.toLowerCase().includes(trimmedQuery))
      .slice(0, MAX_SEARCH_MATCHES);
  }, [humans, trimmedQuery]);

  // Every write carries the team key — omit it and the edit silently lands on the account
  // default instead of the team being viewed.
  const applyRole = (r: DetectedReviewer, role: ReviewerRole): void => {
    const d = rowDraft(r);
    override.mutate({
      userId: r.userId,
      body: { automated: true, kind: d.kind, label: d.label, role, teamId },
    });
  };

  // Promote a human to an automated reviewer with a sensible default kind; on success the
  // detected-reviewers query refetches and the row re-appears in the bot list, where the exact
  // vendor kind + label + role are editable inline.
  const promote = (r: DetectedReviewer): void => {
    override.mutate({ userId: r.userId, body: { automated: true, kind: 'in_house', teamId } });
    setQuery('');
  };

  const renderRow = (r: DetectedReviewer): JSX.Element => {
    const c = r.classification;
    const d = rowDraft(r);
    const meta = automatedReviewerMeta(c.kind ?? 'in_house');
    // Per-bot colour (brand-aware hybrid) so multiple in-house bots read distinctly,
    // matching their colour in the Bots ROI console + feed.
    const color = botColor({ login: r.login, kind: c.kind ?? 'in_house' });
    const isQuality = c.role === 'quality_check';
    return (
      <li key={r.userId} className="flex flex-col gap-1.5 px-2.5 py-2">
        <div className="flex items-center gap-2">
          {r.avatarUrl != null && (
            <img src={r.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
          )}
          <span
            className="truncate text-xs font-medium text-gray-800 dark:text-gray-100"
            title={r.sampleReviewBody ?? undefined}
          >
            {r.login}
            {r.displayName != null && r.displayName !== r.login && (
              <span className="ml-1 font-normal text-gray-400">{r.displayName}</span>
            )}
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-gray-400">
            {r.threadsLast90d} threads · 90d
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{ color, backgroundColor: `${color}1a` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
            {meta.label}
          </span>
          {c.confidence !== 'high' && (
            <span className="text-[10px] text-amber-500" title={c.reasons.join(' · ')}>
              likely ({c.confidence})
            </span>
          )}
          {r.isManualOverride ? (
            <span className="rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-600 dark:bg-sky-950 dark:text-sky-300">
              manual
            </span>
          ) : (
            <span
              className="text-[9px] uppercase tracking-wide text-gray-300 dark:text-gray-600"
              title={c.reasons.join(' · ')}
            >
              {c.source.replace(/_/g, ' ')}
            </span>
          )}
          {/* Where this answer came from. Only meaningful once a TEAM (not the default) is being
              viewed — at NO_TEAM_KEY every row IS the default, so the badge would be noise. */}
          {teamId !== NO_TEAM_KEY &&
            (r.inherited ? (
              <span
                className="rounded border border-gray-200 px-1 py-0.5 text-[9px] uppercase tracking-wide text-gray-400 dark:border-gray-700"
                title="Using the “No team (default)” answer. Editing this row creates an override for this team."
              >
                inherited
              </span>
            ) : (
              <span className="rounded bg-violet-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-violet-600 dark:bg-violet-950 dark:text-violet-300">
                team override
              </span>
            ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className={`${inputCls} w-auto py-0.5`}
            value={d.kind}
            onChange={(e) => patchDraft(r, { kind: e.target.value as AutomatedReviewerKind })}
            aria-label="Reviewer kind"
          >
            {ALL_KINDS.map((k) => (
              <option key={k} value={k}>
                {automatedReviewerMeta(k).label}
              </option>
            ))}
          </select>
          <input
            className={`${inputCls} w-28 py-0.5`}
            value={d.label}
            placeholder="Label"
            onChange={(e) => patchDraft(r, { label: e.target.value })}
            aria-label="Reviewer label"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              override.mutate({
                userId: r.userId,
                // NO `role` — absent means "leave the stored role alone", so editing the kind or
                // label of a quality check can never silently promote it back to a review bot.
                body: { automated: true, kind: d.kind, label: d.label, teamId },
              })
            }
            className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
          >
            Apply
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => applyRole(r, isQuality ? 'review' : 'quality_check')}
            title={
              isQuality
                ? 'Treat this as a real AI code reviewer again — it re-enters the ROI, behaviour and dedup metrics.'
                : 'Static analysis / coverage / lint. Stays visible in the feed, but is excluded from the review-bot metrics.'
            }
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {isQuality ? 'Treat as review bot' : 'Mark as quality check'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              override.mutate({ userId: r.userId, body: { automated: false, kind: null, teamId } })
            }
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Not a bot
          </button>
          {/* Only on a REAL team override. On an inherited row this would delete nothing, and a
              silent no-op is indistinguishable from a reset that worked. */}
          {teamId !== NO_TEAM_KEY && !r.inherited && (
            <button
              type="button"
              disabled={busy}
              onClick={() => resetOverride.mutate({ userId: r.userId, teamId })}
              title="Remove this team's override so it inherits the “No team (default)” answer again."
              className="rounded border border-violet-300 px-2 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-40 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950"
            >
              Reset to default
            </button>
          )}
        </div>
      </li>
    );
  };

  const listCls =
    'divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700';

  return (
    <SectionShell
      title="Review bots"
      desc="Reviewers we treat as an AI/automated reviewer. Override any row — a manual choice sticks. To mark a human reviewer as a bot, search below."
    >
      {q.isLoading ? (
        <p className="py-3 text-center text-[11px] text-gray-400">Loading…</p>
      ) : q.isError ? (
        <p className="py-3 text-center text-[11px] text-red-500">{(q.error as Error).message}</p>
      ) : reviewers.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-gray-400">
          No reviewers detected yet — sync a repo first.
        </p>
      ) : (
        <>
          {reviewBots.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-gray-400">
              No review bots yet — search below to mark one.
            </p>
          ) : (
            <ul className={listCls}>{reviewBots.map(renderRow)}</ul>
          )}

          {/* Quality checks get their OWN section rather than being hidden: a mis-role must be
              discoverable ("why did SonarQube vanish?") and the reviewer stays reclassifiable. */}
          {qualityChecks.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                  Quality checks
                </h4>
                <span className="text-[10px] text-gray-400">
                  Static analysis, coverage and lint. Still automated and still shown in the feed —
                  but excluded from the review-bot metrics (ROI, behaviour, dedup, benchmark), so
                  their volume can&apos;t make your reviewers look noisy.
                </span>
              </div>
              <ul className={listCls}>{qualityChecks.map(renderRow)}</ul>
            </div>
          )}

          {/* Search-to-promote: find a human reviewer by login/name and mark them a review bot.
              We never render the full human list — only matches once a query is typed. */}
          <div className="mt-1 space-y-1.5">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-gray-600 dark:text-gray-300">Add a review bot</span>
              <input
                className={inputCls}
                value={query}
                placeholder="Search reviewers by name or login…"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search reviewers to mark as a review bot"
              />
            </label>
            {trimmedQuery === '' ? (
              <p className="text-[10px] text-gray-400">
                Type a reviewer&apos;s name to mark them as a bot. They default to In-house AI — set
                the exact vendor above once added (or pick{' '}
                <span className="font-medium">Vendor</span> for a proprietary tool that isn&apos;t
                your own), and use <span className="font-medium">Mark as quality check</span> for a
                linter or coverage tool.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-[10px] text-gray-400">No matching reviewers.</p>
            ) : (
              <ul className={listCls}>
                {matches.map((r) => (
                  <li key={r.userId} className="flex items-center gap-2 px-2.5 py-1.5">
                    {r.avatarUrl != null && (
                      <img src={r.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
                    )}
                    <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                      {r.login}
                      {r.displayName != null && r.displayName !== r.login && (
                        <span className="ml-1 font-normal text-gray-400">{r.displayName}</span>
                      )}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                      {r.threadsLast90d} · 90d
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => promote(r)}
                      className="shrink-0 rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
                    >
                      Treat as review bot
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {override.isError && (
        <p className="text-[11px] text-red-500">{(override.error as Error).message}</p>
      )}
      {resetOverride.isError && (
        <p className="text-[11px] text-red-500">{(resetOverride.error as Error).message}</p>
      )}
    </SectionShell>
  );
}
