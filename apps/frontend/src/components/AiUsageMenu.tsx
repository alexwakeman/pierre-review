import { useEffect, useId, useRef, useState } from 'react';
import { useAiBudget } from '../hooks/useAiBudget.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useSettingsModal } from '../store/settingsModal.js';
import { headerUsageOf, usageDetailsOf } from '../lib/aiBudget.js';
import { InfoButton } from './InfoModal.js';
import { AI_BUDGET_SHARE_MAX } from '@pierre-review/shared';
import { SparkleIcon } from './Icons.js';

// THE HEADER'S AI USAGE ITEM, beside the light/dark button: ONE figure of budget used so far
// (lib/aiBudget.ts `headerUsageOf` says which), and on click a popover with what is known — Limn's
// share of this 5-hour session and of the week (a bar each: against the reader's limit, else against
// the 50% most Limn can be given), each provider's own account windows with their reset times, Limn's
// runs and tokens this week; on an API key the US$ figures. EVERY provider in use gets its own block —
// the default first, then each other one signed in or run this week (`others`). Unknown pieces are
// left out.
//
// It reads the ONE budget query (`useAiBudget`, ['ai-budget']) that the toast, the meters and
// Settings share, polled every 2 minutes while the tab is visible. Shown only while AI is on and some
// provider holds a credential or ran this week; a signed-out default hands the figure to the first
// other provider that is signed in. The label ("AI quota for Limn:") is screen-reader only: the item shows the icon and the figure.

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

  // A pointer inside the ⓘ's own popover (portalled outside this root) must not close the menu.
  useClickOutside(rootRef, (e) => {
    if (e?.target instanceof Element && e.target.closest('[data-noactivate]') != null) return;
    setOpen(false);
  }, open);
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

  const details = open ? usageDetailsOf(data) : null;
  // The ⓘ explains Limn's share and its bars: it sits on the first block that shows them.
  const infoAt = details?.findIndex((d) => d.hasLimnShare) ?? -1;

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

      {open && details != null && (
        <div
          id={panelId}
          role="dialog"
          aria-label="AI usage"
          className="absolute right-0 top-full z-[60] mt-1 max-h-[calc(100vh-4rem)] overflow-y-auto w-[22rem] max-w-[calc(100vw-1rem)] max-sm:fixed max-sm:inset-x-2 max-sm:top-auto max-sm:w-auto max-sm:max-w-none rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        >
          {details.map((detail, i) => (
            <div
              key={detail.provider}
              data-testid={`ai-usage-provider-${detail.provider}`}
              className={i > 0 ? 'mt-3 border-t border-gray-200 pt-3 dark:border-gray-800' : undefined}
            >
              <div className="flex items-center gap-1">
                <p className="text-[13px] font-semibold text-gray-900 dark:text-gray-50">{detail.heading}</p>
                {i === infoAt && <LimnShareInfo />}
              </div>
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
                        {r.note != null && (
                          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{r.note}</p>
                        )}
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              {detail.updated != null && (
                <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">{detail.updated}</p>
              )}
            </div>
          ))}
          <div className="mt-3 flex items-center justify-end gap-2 border-t border-gray-200 pt-2 dark:border-gray-800">
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

/** What Limn's share means, and what its bar is drawn against. */
function LimnShareInfo(): JSX.Element {
  return (
    <InfoButton title="Limn’s share">
      <p>
        The share of your plan’s allowance that Limn’s own runs used: this 5-hour session and this week. The
        windows are your provider’s own and reset when it says; when Limn has not read a reset time yet it counts the
        last 5 hours and the last 7 days.
      </p>
      <p>
        The bar runs to the limit you set in AI spend settings. With no limit set it runs to {AI_BUDGET_SHARE_MAX}%,
        the most Limn can be given — nothing pauses Limn’s runs until you set a limit.
      </p>
      <p>Claude’s share is an estimate from Anthropic’s unpublished limits. Codex’s is your account’s figure, weighted by Limn’s tokens.</p>
    </InfoButton>
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
