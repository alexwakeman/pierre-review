import { useState } from 'react';
import { PRESET_PROMPTS, type DigestPrRef, type PresetPromptKey } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { usePresetPrompt, useRefreshPresetPrompt } from '../../hooks/usePresetPrompt.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { SummaryMarkdown } from './prRefTable.js';

// One-click "ask about this scope" panel (Pro Haiku). The 6 fixed preset questions are now a
// CAROUSEL — page through one at a time with the arrows — driven by a SINGLE "Generate all" button
// that answers every preset for the current team scope (each key is an independent server-side
// throttle/cache row, so unchanged answers stay $0). PR references linkify to the PR detail (same
// treatment as the Sprint/Retro cards). Gated on the activityDigest capability — absent → nothing.

function refMeta(ref: DigestPrRef): PinnedPr {
  return {
    id: ref.prId as number,
    number: ref.prNumber,
    title: ref.title ?? `#${ref.prNumber}`,
    repoFullName: ref.repoFullName,
    authorLogin: ref.authorLogin,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

function PresetSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 py-0.5" aria-hidden="true">
      <div className="digest-skeleton-line h-3.5" style={{ width: '48%' }} />
      {['92%', '84%', '76%', '88%'].map((w, i) => (
        <div key={i} className="digest-skeleton-line h-3" style={{ width: w }} />
      ))}
    </div>
  );
}

// The current carousel slide: one preset's answer (its own react-query GET; the parent's refresh
// mutation writes the same cache key, so a generate/regenerate updates it in place).
function PresetAnswer({
  presetKey,
  scope,
  enabled,
  busy,
  outOfCredits,
  onRegenerate,
}: {
  presetKey: PresetPromptKey;
  scope: string;
  enabled: boolean;
  busy: boolean;
  outOfCredits: boolean;
  onRegenerate: (key: PresetPromptKey) => void;
}): JSX.Element {
  const query = usePresetPrompt(presetKey, enabled, scope);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const result = query.data?.result ?? null;

  return (
    <div className="mt-3 rounded-md border border-violet-200/70 bg-white/60 p-3 dark:border-violet-900/50 dark:bg-gray-900/40">
      {busy ? (
        <PresetSkeleton />
      ) : query.isLoading ? (
        <div className="h-16 animate-pulse rounded bg-violet-500/5" />
      ) : result != null ? (
        <div key={result.generatedAt} className="digest-fade-in">
          <SummaryMarkdown
            markdown={result.markdown}
            prRefs={result.prRefs}
            onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
          />
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-gray-400">
            <span>Generated {new Date(result.generatedAt).toLocaleString()}</span>
            <button
              type="button"
              onClick={() => onRegenerate(presetKey)}
              disabled={busy || outOfCredits}
              className="ml-auto rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
              title={outOfCredits ? 'Out of AI credits — resets next month' : 'Regenerate just this answer'}
            >
              ↻ Regenerate
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500 dark:text-gray-400">
          <span>No answer yet.</span>
          <button
            type="button"
            onClick={() => onRegenerate(presetKey)}
            disabled={busy || outOfCredits}
            className="rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
            title="Generate this one"
          >
            Generate
          </button>
        </div>
      )}
    </div>
  );
}

export function PresetPromptPanel(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const teamScope = useFilters((s) => s.teamScope);
  const scope = scopeToParam(teamScope);

  const [idx, setIdx] = useState(0);
  const [generatingAll, setGeneratingAll] = useState(false);
  // "Generate all" fires 6 concurrent mutations on one shared observer, so the observer's own
  // isError can't represent a PARTIAL failure — track it here from the settled results.
  const [genError, setGenError] = useState<string | null>(null);
  const refresh = useRefreshPresetPrompt(scope);
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.allowanceCredits != null && (usage.data.remainingCredits ?? 0) <= 0;
  const singleBusyKey = refresh.isPending ? (refresh.variables ?? null) : null;

  // The AI digest capability is the gate (shares the digest's Haiku seam + cost throttle).
  if (!activityDigest) return null;

  const total = PRESET_PROMPTS.length;
  const current = PRESET_PROMPTS[idx] ?? PRESET_PROMPTS[0]!;
  const step = (delta: number): void => setIdx((i) => (i + delta + total) % total);

  // The ONE billing entry: generate every preset for the current scope (unchanged ones are $0
  // server-side). Concurrency-safe — each key is an independent throttle/in-flight row.
  const generateAll = async (): Promise<void> => {
    if (outOfCredits || generatingAll) return;
    setGeneratingAll(true);
    setGenError(null);
    try {
      const results = await Promise.allSettled(
        PRESET_PROMPTS.map((p) => refresh.mutateAsync(p.key)),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0)
        setGenError(
          `${failed} of ${PRESET_PROMPTS.length} answers couldn’t be generated — try again.`,
        );
    } finally {
      setGeneratingAll(false);
    }
  };

  const busyCurrent = generatingAll || singleBusyKey === current.key;

  return (
    <div
      className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20"
      data-testid="preset-prompt-panel"
    >
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden="true">✨</span> Sprint questions
        </span>
        <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <button
          type="button"
          onClick={generateAll}
          disabled={generatingAll || outOfCredits}
          className="ml-auto rounded bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          title={outOfCredits ? 'Out of AI credits — resets next month' : 'Generate answers to all six preset questions for this scope'}
        >
          {generatingAll ? 'Generating…' : 'Generate all'}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Six standing questions answered over the selected scope&apos;s repos (runs the Haiku model).
        Page through the answers with the arrows.
      </p>

      {/* Carousel head — arrows + the current question + position. */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => step(-1)}
          className="rounded border border-violet-300 px-2 py-1 text-sm font-medium text-violet-600 hover:bg-violet-500/5 dark:border-violet-800 dark:text-violet-300"
          aria-label="Previous question"
        >
          ◀
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100" title={current.question}>
            {current.question}
          </div>
          <div className="text-[10px] text-gray-400">
            {idx + 1} / {total}
          </div>
        </div>
        <button
          type="button"
          onClick={() => step(1)}
          className="rounded border border-violet-300 px-2 py-1 text-sm font-medium text-violet-600 hover:bg-violet-500/5 dark:border-violet-800 dark:text-violet-300"
          aria-label="Next question"
        >
          ▶
        </button>
      </div>

      {genError && <div className="mt-2 text-[11px] text-red-500">{genError}</div>}
      {refresh.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(refresh.error as Error)?.message ?? 'Couldn’t generate the answer.'}
        </div>
      )}
      {!refresh.isError && refresh.notice && (
        <div className="mt-2 text-[11px] text-gray-400">{refresh.notice}</div>
      )}
      {outOfCredits && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — answers resume on the 1st. Existing answers still show.
        </div>
      )}

      <PresetAnswer
        presetKey={current.key}
        scope={scope}
        enabled={activityDigest}
        busy={busyCurrent}
        outOfCredits={outOfCredits}
        onRegenerate={(k) => refresh.mutate(k)}
      />
    </div>
  );
}
