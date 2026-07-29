import { useMemo, useState } from 'react';
import type {
  AiConfidence,
  FailingCheckInput,
  PrDetail,
} from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import {
  useCiAnalysis,
  useRefreshCiAnalysis,
  useStartFix,
} from '../hooks/useAiFix.js';
import { Markdown } from './Markdown.js';

// The CI-failure diagnosis ("why did CI fail?"), extracted out of the AI-Fix tab so it can
// sit INLINE on the PR detail pane next to the red checks — which is where the question is
// actually asked. Mirrors the AiSummary pattern: self-contained, self-gated, one shared
// React-Query key (`['ai-fix-ci', prId]`) so generating in one mount updates every other.
//
// TIER: this is the cheap, read-only SUMMARY tier (`prSummary` — the same gate as the AI
// summary and the digest, on in paid cloud and credit-metered), NOT the "pro+" advanced-AI
// tier. The agentic "Fix it →" button is a different thing entirely and stays gated on
// `aiFix`, so a summary-tier cloud user gets the diagnosis without the fixer.
//
// STALENESS: when a stored analysis predates the current head SHA we show the OLD analysis
// with an "out of date" chip and a manual Re-analyze. We deliberately never regenerate
// automatically — that would be one paid generation per push, per red PR.

const CONFIDENCE_STYLE: Record<AiConfidence, string> = {
  high: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  low: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
};

export function ConfidenceBadge({
  label,
  value,
}: {
  label: string;
  value: AiConfidence | null;
}): JSX.Element | null {
  if (!value) return null;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${CONFIDENCE_STYLE[value]}`}
      title={
        label === 'Fixability'
          ? "How confident the analysis is that Limn's agent could fix this"
          : 'How confident the analysis is about the root cause'
      }
    >
      {label}: {value}
    </span>
  );
}

export function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const BTN_SECONDARY =
  'whitespace-nowrap rounded border border-gray-300 px-2.5 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';

export function CiAnalysisCard({ pr }: { pr: PrDetail }): JSX.Element | null {
  const { prSummary, aiFix } = useProCapabilities();
  const { data } = useCiAnalysis(pr.id, prSummary);
  const refresh = useRefreshCiAnalysis(pr.id);
  const startFix = useStartFix(pr.id);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);

  // ALL failing checks (name + optional Actions jobId), not just Actions jobs — so an
  // external gate (SonarCloud etc.) with no jobId is still analyzed.
  const failingChecks: FailingCheckInput[] = useMemo(
    () =>
      pr.checkRuns
        .filter((c) => c.state === 'failure' || c.state === 'error')
        .map((c) => ({ name: c.name, jobId: c.jobId, state: c.state })),
    [pr.checkRuns],
  );

  const analysis = data?.analysis ?? null;
  const stale =
    analysis != null && data?.headSha != null && data.headSha !== pr.headSha;
  const outOfCredits = data?.creditsExhausted === true;
  const hasFailures = failingChecks.length > 0 || (data?.hasFailures ?? false);
  // Open by default only when there is something worth reading right now; an offer to
  // generate collapses to a single line.
  const open = openOverride ?? (analysis != null && !stale);

  if (!prSummary) return null;
  // Presence gate: a green PR with nothing stored shows no card at all.
  if (!hasFailures && analysis == null) return null;

  const analyzeLabel = refresh.isPending
    ? 'Analyzing…'
    : analysis
      ? 'Re-analyze'
      : 'Analyze';
  const analyzeBtn = (
    <button
      type="button"
      className={BTN_SECONDARY}
      disabled={refresh.isPending || outOfCredits || failingChecks.length === 0}
      title={
        failingChecks.length === 0
          ? 'No failing checks on the current head to analyze'
          : 'Diagnose the failing CI from the full logs of every failing check'
      }
      onClick={() => {
        setOpenOverride(true);
        refresh.mutate(failingChecks);
      }}
    >
      {analyzeLabel}
    </button>
  );

  // ---- collapsed offer: one line, no body ----
  if (analysis == null) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Why did CI fail?</span>
        {analyzeBtn}
        {outOfCredits && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            Out of AI credits this month
          </span>
        )}
        {refresh.isError && (
          <span className="text-[11px] text-red-500">{errText(refresh.error)}</span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpenOverride(!open)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-1.5 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="text-[10px] text-gray-400">{open ? '▾' : '▸'}</span>
        <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">
          Why did CI fail?
        </span>
        <ConfidenceBadge label="Root cause" value={data?.rootCauseConfidence ?? null} />
        <ConfidenceBadge label="Fixability" value={data?.fixability ?? null} />
        {stale && (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            title="The PR has new commits since this analysis was generated — re-analyze to refresh it"
          >
            out of date
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-800">
          {stale && (
            <p className="mb-2 text-[11px] text-amber-600 dark:text-amber-400">
              This analysis is from an earlier commit. It is shown as-is — re-analyze to
              diagnose the current head.
            </p>
          )}
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <Markdown>{analysis}</Markdown>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {analyzeBtn}
            {/* The agentic fixer is the pro+ tier — never offered to summary-tier users. */}
            {aiFix && (
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={startFix.isPending}
                onClick={() =>
                  startFix.mutate({ model: 'claude-sonnet-5', seed: 'ci_analysis' })
                }
                title="Launch an agent to fix the CI failure"
              >
                Fix it →
              </button>
            )}
            {aiFix && data?.fixability === 'low' && (
              <span className="text-[11px] text-gray-500">
                low confidence this is auto-fixable
              </span>
            )}
            {outOfCredits && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                Out of AI credits this month
              </span>
            )}
            {refresh.isError && (
              <span className="text-[11px] text-red-500">
                {errText(refresh.error)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
