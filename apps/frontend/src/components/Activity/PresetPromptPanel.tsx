import { useState } from 'react';
import { PRESET_PROMPTS, type DigestPrRef, type PresetPromptKey } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters } from '../../store/filters.js';
import { usePresetPrompt, useRefreshPresetPrompt } from '../../hooks/usePresetPrompt.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { SummaryMarkdown } from './prRefTable.js';

// One-click "ask about this Workspace" panel (Pro Haiku). The 6 fixed preset questions are now a
// CAROUSEL — page through one at a time with the arrows — driven by a SINGLE "Generate all" button
// that answers every preset for the ACTIVE WORKSPACE (each key is an independent server-side
// throttle/cache row, so unchanged answers stay $0). PR references linkify to the PR detail (same
// treatment as the Sprint report card). Gated on the activityDigest capability — absent → nothing.
//
// ⚠ THIS COMPONENT HAS NO IMPORTERS. The six presets were folded into AdHocChatPanel's
// quick-question pills, which fire the Ask directly. Left in place rather than deleted because the
// server side (`preset-prompt.ts`, its PresetPromptKey cache rows + throttles) is still live and
// this is its only client; delete both together or neither.

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
  workspaceId,
  enabled,
  busy,
  outOfCredits,
  onRegenerate,
}: {
  presetKey: PresetPromptKey;
  workspaceId: number | null;
  enabled: boolean;
  busy: boolean;
  outOfCredits: boolean;
  onRegenerate: (key: PresetPromptKey) => void;
}): JSX.Element {
  const query = usePresetPrompt(presetKey, enabled, workspaceId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const result = query.data?.result ?? null;

  return (
    <div className="mt-3 rounded-md border border-ai-hairline bg-white/60 p-3 dark:bg-gray-900/40">
      {busy ? (
        <PresetSkeleton />
      ) : query.isLoading ? (
        <div className="h-16 animate-pulse rounded bg-ai-surface-2" />
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
              className="ml-auto rounded border border-ai-border px-1.5 py-0.5 font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:opacity-50"
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
            className="rounded border border-ai-border px-1.5 py-0.5 font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:opacity-50"
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
  // The ACTIVE WORKSPACE is the whole scope — a plain id the hooks stamp onto the wire themselves.
  // It is null until the workspaces query resolves the account's Default; the read holds itself
  // idle until then and the billing path refuses outright.
  const workspaceId = useFilters((s) => s.workspaceId);

  const [idx, setIdx] = useState(0);
  const [generatingAll, setGeneratingAll] = useState(false);
  // "Generate all" fires 6 concurrent mutations on one shared observer, so the observer's own
  // isError can't represent a PARTIAL failure — track it here from the settled results.
  const [genError, setGenError] = useState<string | null>(null);
  const refresh = useRefreshPresetPrompt(workspaceId);
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;
  const singleBusyKey = refresh.isPending ? (refresh.variables ?? null) : null;

  // The AI digest capability is the gate (shares the digest's Haiku seam + cost throttle).
  if (!activityDigest) return null;

  const total = PRESET_PROMPTS.length;
  const current = PRESET_PROMPTS[idx] ?? PRESET_PROMPTS[0]!;
  const step = (delta: number): void => setIdx((i) => (i + delta + total) % total);

  // The ONE billing entry: generate every preset for the active Workspace (unchanged ones are $0
  // server-side). Concurrency-safe — each key is an independent throttle/in-flight row.
  const generateAll = async (): Promise<void> => {
    // `workspaceId == null` bails BEFORE the six mutations: the hook throws on an unresolved
    // workspace, which would surface as six rejected promises and a "6 of 6 couldn't be
    // generated" error rather than the harmless no-op it actually is.
    if (outOfCredits || generatingAll || workspaceId == null) return;
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
      className="rounded-lg border border-ai-border bg-ai-surface p-4"
      data-testid="preset-prompt-panel"
    >
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden="true">✨</span> Sprint questions
        </span>
        <span className="shrink-0 rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal">
          Pro
        </span>
        <button
          type="button"
          onClick={generateAll}
          disabled={generatingAll || outOfCredits || workspaceId == null}
          className="ml-auto rounded bg-ai-signal px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:text-gray-950"
          title={outOfCredits ? 'Out of AI credits — resets next month' : 'Generate answers to all six preset questions for this Workspace'}
        >
          {generatingAll ? 'Generating…' : 'Generate all'}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Six standing questions answered over this Workspace&apos;s repos (runs the Haiku model).
        Page through the answers with the arrows.
      </p>

      {/* Carousel head — arrows + the current question + position. */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => step(-1)}
          className="rounded border border-ai-border px-2 py-1 text-sm font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2"
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
          className="rounded border border-ai-border px-2 py-1 text-sm font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2"
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
        workspaceId={workspaceId}
        enabled={activityDigest}
        busy={busyCurrent}
        outOfCredits={outOfCredits}
        // Same guard as generateAll: the hook throws on an unresolved workspace rather than
        // generating for the account's Default, so a click before it settles is a no-op.
        onRegenerate={(k) => {
          if (workspaceId != null) refresh.mutate(k);
        }}
      />
    </div>
  );
}
