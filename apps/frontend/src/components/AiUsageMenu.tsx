import { useEffect, useId, useRef, useState } from 'react';
import { useAiBudget } from '../hooks/useAiBudget.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useSettingsModal } from '../store/settingsModal.js';
import { headerUsageOf, usageDetailOf } from '../lib/aiBudget.js';
import { SparkleIcon } from './Icons.js';

// THE HEADER'S AI USAGE ITEM, beside the light/dark button: ONE figure of budget used so far
// (lib/aiBudget.ts `headerUsageOf` says which), and on click a popover with what is known — Limn's
// share of the week and of this 5-hour session, the active provider's own account windows (Claude's, or
// Codex's 5-hour and weekly windows on a ChatGPT sign-in) with their reset times,
// Limn's runs and tokens this week; on an API key the US$ figures. Unknown pieces are left out.
//
// It reads the ONE budget query (`useAiBudget`, ['ai-budget']) that the toast, the meters and
// Settings share, polled every 2 minutes while the tab is visible. Shown only while AI is on and a
// Claude login or API key is found. The label ("AI quota for Limn:") is screen-reader only: the item shows the icon and the figure.

const TONE: Record<'normal' | 'near' | 'over', string> = {
  normal: 'border-gray-300 text-gray-700 dark:border-gray-700 dark:text-gray-200',
  near: 'border-amber-400 text-amber-800 dark:border-amber-600 dark:text-amber-300',
  over: 'border-red-400 text-red-700 dark:border-red-700 dark:text-red-300',
};

export function AiUsageMenu(): JSX.Element | null {
  const ai = useAiCapabilities();
  const q = useAiBudget();
  const openSettings = useSettingsModal((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useClickOutside(rootRef, () => setOpen(false), open);
  // Escape closes it and returns focus to the button. stopPropagation so the global `esc` handler
  // (useKeyboard) does not also leave the current tab.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const data = q.data;
  if (!ai.enabled || data == null) return null;
  const head = headerUsageOf(data);
  if (head == null) return null;

  const detail = open ? usageDetailOf(data) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="ai-usage-button"
        onClick={() => {
          if (!open) void q.refetch();
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={head.figure != null ? `${head.label} ${head.figure}. ${head.title}` : head.label}
        title={head.title}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-xs tabular-nums hover:border-gray-400 dark:hover:border-gray-500 ${TONE[head.tone]}`}
      >
        <SparkleIcon size={12} className="shrink-0" />
        <span className="sr-only">{head.label}</span>
        {head.figure != null && <span className="font-medium">{head.figure}</span>}
      </button>

      {open && detail != null && (
        <div
          id={panelId}
          role="dialog"
          aria-label="AI usage"
          className="absolute right-0 top-full z-[60] mt-1 w-[22rem] max-w-[calc(100vw-1rem)] max-sm:fixed max-sm:inset-x-2 max-sm:top-auto max-sm:w-auto max-sm:max-w-none rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        >
          <p className="text-[13px] font-semibold text-gray-900 dark:text-gray-50">{detail.heading}</p>
          {detail.paused != null && (
            <p className="mt-1 font-medium text-amber-700 dark:text-amber-300">{detail.paused}</p>
          )}
          {detail.sections.map((sec) => (
            <div key={sec.title} className="mt-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{sec.title}</p>
              <dl className="mt-1 space-y-1.5">
                {sec.rows.map((r) => (
                  <div key={r.label}>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="shrink-0 text-gray-600 dark:text-gray-300">{r.label}</dt>
                      <dd className="text-right tabular-nums text-gray-900 dark:text-gray-50">{r.value}</dd>
                    </div>
                    {r.barPct != null && <UsageBar pct={r.barPct} />}
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-gray-200 pt-2 dark:border-gray-800">
            <span className="text-[11px] text-gray-500 dark:text-gray-400">{detail.updated ?? ''}</span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings('claude-spend');
              }}
              className="rounded text-xs text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-sky-300"
            >
              AI spend settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One row's bar: how full it is, amber from 80%, red at 100%. Decorative — the row's text says the figure. */
function UsageBar({ pct }: { pct: number }) {
  const fill = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-sky-500';
  return (
    <div aria-hidden="true" className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
