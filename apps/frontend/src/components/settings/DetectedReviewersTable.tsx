import { useMemo, useState } from 'react';
import type { AutomatedReviewerKind, DetectedReviewer } from '@pierre-review/shared';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import { useAddBotMuteRule, useDetectedReviewers, useReviewerOverride } from '../../hooks/useBotTriage.js';
import { SectionShell, inputCls } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];
const MAX_SEARCH_MATCHES = 8;

// The account's automated reviewers, plus a search box to promote any human reviewer to a bot.
// CORE — the two-way override (mark automated / not-a-bot), rename/label and a one-click "mute
// this vendor" all POST to /api/bot-reviewers and /api/bot-mute-rules. Only KNOWN BOTS are
// listed by default (an account can have dozens of human maintainers — the full list is
// unusable); the search below finds a person by login/name and marks them a review bot, after
// which they move into the bot list where kind/label are already editable.
export function DetectedReviewersTable(): JSX.Element {
  const q = useDetectedReviewers();
  const override = useReviewerOverride();
  const addRule = useAddBotMuteRule();
  const [drafts, setDrafts] = useState<Record<number, { kind: AutomatedReviewerKind; label: string }>>({});
  const [query, setQuery] = useState('');

  const rowDraft = (r: DetectedReviewer): { kind: AutomatedReviewerKind; label: string } =>
    drafts[r.userId] ?? { kind: r.classification.kind ?? 'in_house', label: r.classification.label };
  const patchDraft = (r: DetectedReviewer, patch: Partial<{ kind: AutomatedReviewerKind; label: string }>): void =>
    setDrafts((prev) => ({ ...prev, [r.userId]: { ...rowDraft(r), ...patch } }));

  const busy = override.isPending;
  const reviewers = q.data?.reviewers ?? [];
  const automated = reviewers.filter((r) => r.classification.automated === true);
  const humans = reviewers.filter((r) => r.classification.automated !== true);

  // Only surface the (potentially huge) human list once the user types — that's the whole point.
  const trimmedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (trimmedQuery === '') return [];
    return humans
      .filter((h) => `${h.login} ${h.displayName ?? ''}`.toLowerCase().includes(trimmedQuery))
      .slice(0, MAX_SEARCH_MATCHES);
  }, [humans, trimmedQuery]);

  // Promote a human to an automated reviewer with a sensible default kind; on success the
  // detected-reviewers query refetches and the row re-appears in the bot list, where the exact
  // vendor kind + label are editable inline.
  const promote = (r: DetectedReviewer): void => {
    override.mutate({ userId: r.userId, body: { automated: true, kind: 'in_house' } });
    setQuery('');
  };

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
        <p className="py-3 text-center text-[11px] text-gray-400">No reviewers detected yet — sync a repo first.</p>
      ) : (
        <>
          {automated.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-gray-400">No automated reviewers yet — search below to mark one.</p>
          ) : (
            <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
              {automated.map((r) => {
                const c = r.classification;
                const d = rowDraft(r);
                const meta = automatedReviewerMeta(c.kind ?? 'in_house');
                return (
                  <li key={r.userId} className="flex flex-col gap-1.5 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      {r.avatarUrl != null && (
                        <img src={r.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full" />
                      )}
                      <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100" title={r.sampleReviewBody ?? undefined}>
                        {r.login}
                        {r.displayName != null && r.displayName !== r.login && (
                          <span className="ml-1 font-normal text-gray-400">{r.displayName}</span>
                        )}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-gray-400">{r.threadsLast90d} threads · 90d</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}
                      >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
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
                        <span className="text-[9px] uppercase tracking-wide text-gray-300 dark:text-gray-600" title={c.reasons.join(' · ')}>
                          {c.source.replace(/_/g, ' ')}
                        </span>
                      )}
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
                        onClick={() => override.mutate({ userId: r.userId, body: { automated: true, kind: d.kind, label: d.label } })}
                        className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => override.mutate({ userId: r.userId, body: { automated: false, kind: null } })}
                        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        Not a bot
                      </button>
                      <button
                        type="button"
                        disabled={addRule.isPending}
                        onClick={() => addRule.mutate({ vendorKind: c.kind ?? d.kind, action: 'hide' })}
                        title="Hide this vendor's threads (adds a mute rule)"
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        Mute
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
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
                Type a reviewer's name to mark them as a bot. They default to In-house AI — set the exact vendor above once added.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-[10px] text-gray-400">No matching reviewers.</p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
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
                    <span className="ml-auto shrink-0 text-[10px] text-gray-400">{r.threadsLast90d} · 90d</span>
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
    </SectionShell>
  );
}
