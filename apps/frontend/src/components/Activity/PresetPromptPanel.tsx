import { PRESET_PROMPTS, type DigestPrRef, type PresetPromptKey } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { usePresetPrompt, useRefreshPresetPrompt } from '../../hooks/usePresetPrompt.js';
import { usePresetPromptOpen } from '../../store/presetPrompt.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { SummaryMarkdown } from './prRefTable.js';

// One-click "ask about this scope" panel (Pro Haiku). A compact row of the 6 fixed preset
// questions; clicking one OPENS its answer for the CURRENT team scope (loads a cached answer if
// one exists, else generates it). Multiple answers can be open at once — each renders as its own
// card so you can compare them — and the open set is RETAINED (per scope) across tab navigation.
// PR references in an answer linkify to the PR detail (same treatment as the Sprint/Retro cards).
// Full width; gated on the activityDigest capability exactly like RetroView — absent → nothing.

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

// One open answer card (its own react-query GET; the parent's refresh mutation writes the same
// cache key, so a generate/regenerate updates it in place). Retained across navigation.
function PresetAnswer({
  presetKey,
  scope,
  enabled,
  busy,
  outOfCredits,
  onRegenerate,
  onClose,
}: {
  presetKey: PresetPromptKey;
  scope: string;
  enabled: boolean;
  busy: boolean;
  outOfCredits: boolean;
  onRegenerate: (key: PresetPromptKey) => void;
  onClose: (key: PresetPromptKey) => void;
}): JSX.Element {
  const query = usePresetPrompt(presetKey, enabled, scope);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const preset = PRESET_PROMPTS.find((p) => p.key === presetKey) ?? null;
  const result = query.data?.result ?? null;

  return (
    <div className="rounded-md border border-violet-200/70 bg-white/60 p-3 dark:border-violet-900/50 dark:bg-gray-900/40">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {preset?.question ?? presetKey}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {result != null && !busy && (
            <button
              type="button"
              onClick={() => onRegenerate(presetKey)}
              disabled={busy || outOfCredits}
              className="flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 text-[11px] font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
              title={
                outOfCredits
                  ? 'Out of AI credits — resets next month'
                  : 'Regenerate this answer (runs the Haiku model)'
              }
            >
              <span aria-hidden="true">↻</span> Regenerate
            </button>
          )}
          <button
            type="button"
            onClick={() => onClose(presetKey)}
            className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            title="Remove this answer from the panel"
            aria-label="Remove answer"
          >
            ✕
          </button>
        </div>
      </div>
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
          <div className="mt-1.5 text-[10px] text-gray-400">
            Generated {new Date(result.generatedAt).toLocaleString()}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          No answer yet — click the question above to generate one.
        </div>
      )}
    </div>
  );
}

export function PresetPromptPanel(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const teamScope = useFilters((s) => s.teamScope);
  const scope = scopeToParam(teamScope);

  const openByScope = usePresetPromptOpen((s) => s.openByScope);
  const openPreset = usePresetPromptOpen((s) => s.open);
  const closePreset = usePresetPromptOpen((s) => s.close);
  const openKeys = openByScope[scope] ?? [];

  const refresh = useRefreshPresetPrompt(scope);
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.allowanceCredits != null && (usage.data.remainingCredits ?? 0) <= 0;
  const busyKey = refresh.isPending ? (refresh.variables ?? null) : null;

  // The AI digest capability is the gate (shares the digest's Haiku seam + cost throttle).
  // Absent → render nothing, exactly like RetroView / the Sprint report card.
  if (!activityDigest) return null;

  // Open the answer (retained) + generate it (unless out of credits — then the empty/cached
  // state shows and the meter note explains). Re-clicking an already-open preset regenerates.
  const ask = (key: PresetPromptKey): void => {
    openPreset(scope, key);
    if (outOfCredits) return;
    refresh.mutate(key);
  };

  return (
    <div
      className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20"
      data-testid="preset-prompt-panel"
    >
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden="true">✨</span> Ask about this scope
        </span>
        <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        One-click questions answered over the selected scope&apos;s repos (runs the Haiku model).
        Open several to compare — answers stay open when you switch tabs.
      </p>

      {/* The 6 presets as a compact wrapping button grid — label as the button text, the full
          question as the hover tooltip. An open preset is highlighted. */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESET_PROMPTS.map((p) => {
          const on = openKeys.includes(p.key);
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => ask(p.key)}
              disabled={busyKey === p.key}
              title={p.question}
              className={`rounded border px-2 py-1 text-[11px] font-medium disabled:opacity-50 ${
                on
                  ? 'border-violet-400 bg-violet-100 text-violet-700 dark:border-violet-600 dark:bg-violet-900/40 dark:text-violet-200'
                  : 'border-violet-300 text-violet-600 hover:border-violet-400 hover:bg-violet-500/5 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

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

      {openKeys.length > 0 && (
        <div className="mt-3 space-y-2.5">
          {openKeys.map((key) => (
            <PresetAnswer
              key={key}
              presetKey={key}
              scope={scope}
              enabled={activityDigest}
              busy={busyKey === key}
              outOfCredits={outOfCredits}
              onRegenerate={(k) => refresh.mutate(k)}
              onClose={(k) => closePreset(scope, k)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
