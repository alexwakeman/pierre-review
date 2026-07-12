import { useState } from 'react';
import type { AutomatedReviewerKind, DetectedReviewer } from '@pierre-review/shared';
import { automatedReviewerMeta, BOT_VENDOR_META } from '../../lib/ui.js';
import { useAddBotMuteRule, useDetectedReviewers, useReviewerOverride } from '../../hooks/useBotTriage.js';
import { SectionShell, inputCls } from './ui.js';

const ALL_KINDS = Object.keys(BOT_VENDOR_META) as AutomatedReviewerKind[];

// Every distinct reviewer in the account with its automated/human classification (source +
// confidence + volume). CORE — the two-way override (mark automated / not-a-bot), rename/label
// and a one-click "mute this vendor" all POST to /api/bot-reviewers and /api/bot-mute-rules.
// The detection engine seeds each row; a manual override wins and is flagged.
export function DetectedReviewersTable(): JSX.Element {
  const q = useDetectedReviewers();
  const override = useReviewerOverride();
  const addRule = useAddBotMuteRule();
  const [drafts, setDrafts] = useState<Record<number, { kind: AutomatedReviewerKind; label: string }>>({});

  const rowDraft = (r: DetectedReviewer): { kind: AutomatedReviewerKind; label: string } =>
    drafts[r.userId] ?? { kind: r.classification.kind ?? 'in_house', label: r.classification.label };
  const patchDraft = (r: DetectedReviewer, patch: Partial<{ kind: AutomatedReviewerKind; label: string }>): void =>
    setDrafts((prev) => ({ ...prev, [r.userId]: { ...rowDraft(r), ...patch } }));

  const busy = override.isPending;
  const reviewers = q.data?.reviewers ?? [];

  return (
    <SectionShell
      title="Detected reviewers"
      desc="Who is reviewing your PRs, and whether we treat them as an AI/automated reviewer or a human. Override any row — a manual choice sticks."
    >
      {q.isLoading ? (
        <p className="py-3 text-center text-[11px] text-gray-400">Loading…</p>
      ) : q.isError ? (
        <p className="py-3 text-center text-[11px] text-red-500">{(q.error as Error).message}</p>
      ) : reviewers.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-gray-400">No reviewers detected yet — sync a repo first.</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
          {reviewers.map((r) => {
            const c = r.classification;
            const d = rowDraft(r);
            const meta = c.automated ? automatedReviewerMeta(c.kind ?? 'in_house') : null;
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
                  {meta != null ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
                      {meta.label}
                    </span>
                  ) : (
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-300">
                      Human
                    </span>
                  )}
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
                  {c.automated ? (
                    <>
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
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => override.mutate({ userId: r.userId, body: { automated: true, kind: d.kind, label: d.label } })}
                      className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
                    >
                      Treat as review bot
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {override.isError && (
        <p className="text-[11px] text-red-500">{(override.error as Error).message}</p>
      )}
    </SectionShell>
  );
}
