import { useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
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
import { jobIdOf } from './CheckList.js';
import { Markdown } from './Markdown.js';
import { ChevronIcon } from './Icons.js';

// The CI-failure diagnosis ("why did CI fail?"), extracted out of the AI-Fix tab so it can
// sit INLINE on the PR detail pane next to the red checks — which is where the question is
// actually asked. Mirrors the AiSummary pattern: self-contained, self-gated, one shared
// React-Query key (`['ai-fix-ci', prId]`) so generating in one mount updates every other.
//
// TWO MOUNTS, ONE QUERY: the Overview's Checks row (ChecksTab) and the AI Fix tab's CI-status
// section (AiFixTab). PrDetail renders exactly ONE tab body at a time (a ternary chain), so
// they are never in the DOM together and there is no double fetch or double render — the
// shared key means the second mount reads the first's cache entry. The one real hazard the
// second mount opened was per-mount `isPending`: switch tabs mid-run and the button reset to
// "Analyze", inviting a second BILLED POST. That is why in-flight is read from the shared
// mutation key (`useIsMutating`) rather than from this mount's own mutation object.
//
// The Overview mount passes `showFix={false}`: the agentic "Fix it →" run has no progress UI
// outside the AI Fix tab (RegenProgressBar / phase / activity all live in its FixerSection),
// so a Fix button on Overview would start a paid agent run and look like nothing happened.
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

export function CiAnalysisCard({
  pr,
  // The agentic "Fix it →" button (pro+ / `aiFix`). Off on the Overview mount — see the
  // header note: its progress UI only exists on the AI Fix tab.
  showFix = true,
}: {
  pr: PrDetail;
  showFix?: boolean;
}): JSX.Element | null {
  const { prSummary, aiFix } = useProCapabilities();
  const { data } = useCiAnalysis(pr.id, prSummary);
  const refresh = useRefreshCiAnalysis(pr.id);
  const startFix = useStartFix(pr.id);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  // In-flight read off the SHARED mutation key, not this mount's `refresh.isPending` — so a
  // run started on one tab keeps the button truthfully "Analyzing…" and disabled on the other
  // (and after a remount), instead of offering a second paid generation.
  const running = useIsMutating({ mutationKey: ['ai-fix-ci', pr.id] }) > 0;

  // ALL failing checks (name + optional Actions jobId), not just Actions jobs — so an
  // external gate (SonarCloud etc.) with no jobId is still analyzed.
  //
  // LANDMINE: resolve the job id with `jobIdOf`, exactly as the checks list rendered directly
  // above does — a PR detail cached in IndexedDB before the `jobId` column shipped carries the
  // detailsUrl but no field, so reading `c.jobId` raw posts `jobId: null` and the backend then
  // tells the analyzer "external check — no Actions log is available" and it diagnoses blind.
  const failingChecks: FailingCheckInput[] = useMemo(
    () =>
      pr.checkRuns
        .filter((c) => c.state === 'failure' || c.state === 'error')
        .map((c) => ({ name: c.name, jobId: jobIdOf(c), state: c.state })),
    [pr.checkRuns],
  );

  const analysis = data?.analysis ?? null;
  const stale =
    analysis != null && data?.headSha != null && data.headSha !== pr.headSha;
  const outOfCredits = data?.creditsExhausted === true;
  // `pr.ciStatus` is included deliberately, and it is the SAME predicate the server computes
  // (`prHasFailures` reads pullRequests.ciStatus). Without it the card is blank whenever the
  // checkRuns did not hydrate AND the analysis query is still in flight — and the Overview's
  // Checks row now opens for exactly that state, so the card being empty means an empty
  // labelled row. Reading the PR's own stored status makes the offer line render on the first
  // paint instead of one round-trip later.
  const ciRed = pr.ciStatus === 'failure' || pr.ciStatus === 'error';
  const hasFailures = failingChecks.length > 0 || ciRed || (data?.hasFailures ?? false);
  // Open by default only when there is something worth reading right now; an offer to
  // generate collapses to a single line.
  const open = openOverride ?? (analysis != null && !stale);

  if (!prSummary) return null;
  // Presence gate: a green PR with nothing stored shows no card at all.
  if (!hasFailures && analysis == null) return null;

  const analyzeLabel = running ? 'Analyzing…' : analysis ? 'Re-analyze' : 'Analyze';
  const analyzeBtn = (
    <button
      type="button"
      className={BTN_SECONDARY}
      disabled={running || outOfCredits || failingChecks.length === 0}
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
        <span className="text-xs text-gray-500 dark:text-gray-400">Why did CI fail?</span>
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
        <ChevronIcon dir={open ? 'down' : 'right'} size={10} className="text-gray-400" />
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
            {/* The agentic fixer is the pro+ tier — never offered to summary-tier users, and
                never on the Overview mount, whose tab has nowhere to show the run. */}
            {aiFix && showFix && (
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
            {aiFix && showFix && data?.fixability === 'low' && (
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
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
