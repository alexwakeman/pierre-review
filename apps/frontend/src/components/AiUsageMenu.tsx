import { useEffect, useId, useRef, useState } from 'react';
import { useAiBudget } from '../hooks/useAiBudget.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useSettingsModal } from '../store/settingsModal.js';
import { useFilters } from '../store/filters.js';
import { goTo } from './shell/nav.js';
import { headerUsageOf, usageDetailsOf } from '../lib/aiBudget.js';
import { InfoButton } from './InfoModal.js';
import { AI_BUDGET_DEFAULTS } from '@pierre-review/shared';
import { SparkleIcon } from './Icons.js';

// THE HEADER'S AI USAGE ITEM, beside the light/dark button: ONE figure of budget used so far
// (lib/aiBudget.ts `headerUsageOf` says which), and on click a popover with what is known — Limn's
// share of this 5-hour session and of the week (a bar each: against the reader's limit, else against
// the whole allowance when the budget is switched off), each provider's own account windows with their reset times, Limn's
// runs and tokens this week; on an API key the US$ figures. EVERY provider in use gets its own block —
// the default first, then each other one signed in or run this week (`others`). Unknown pieces are
// left out.
//
// It reads the ONE budget query (`useAiBudget`, ['ai-budget']) that the toast, the meters and
// Settings share, polled every 2 minutes while the tab is visible. Shown only while AI is on and some
// provider holds a credential or ran this week; a signed-out default hands the figure to the first
// other provider that is signed in. The label ("AI quota for Limn:") is screen-reader only: the item shows the icon and the figure.

const TONE: Record<'normal' | 'near' | 'over', string> = {
  normal: 'border-ui-line text-ui-ink',
  near: 'border-ui-line text-ui-warn',
  over: 'border-ui-danger/40 text-ui-danger',
};

const SIDEBAR_TONE: Record<'normal' | 'near' | 'over', string> = {
  normal: 'text-ui-mute',
  near: 'text-ui-warn',
  over: 'text-ui-danger',
};

/**
 * `variant="sidebar"` is the redesign's sidebar foot: a full-width row ("AI usage  40%") whose
 * popover opens UPWARD from the foot. The header variant is the old pill.
 */
export function AiUsageMenu({ variant = 'header' }: { variant?: 'header' | 'sidebar' } = {}): JSX.Element | null {
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
    <div ref={rootRef} className={variant === 'sidebar' ? 'relative w-full' : 'relative'}>
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
        className={
          variant === 'sidebar'
            ? `flex h-8 w-full min-w-0 items-center gap-2 rounded-ui px-2 text-left text-meta outline-none hover:bg-ui-hover focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-11 ${SIDEBAR_TONE[head.tone]}`
            : `inline-flex items-center gap-1 whitespace-nowrap rounded-ui border px-2 py-0.5 text-meta tabular-nums hover:border-ui-line ${TONE[head.tone]}`
        }
      >
        <SparkleIcon size={variant === 'sidebar' ? 14 : 12} className="shrink-0" />
        {variant === 'sidebar' ? (
          <span aria-hidden className="min-w-0 flex-1 truncate">
            AI usage
          </span>
        ) : (
          <span className="sr-only">{head.label}</span>
        )}
        {head.figure != null && <span className="font-medium tabular-nums">{head.figure}</span>}
      </button>

      {open && details != null && (
        <div
          id={panelId}
          role="dialog"
          aria-label="AI usage"
          className={
            variant === 'sidebar'
              ? // Opens UP from the sidebar foot; never wider than the screen in the phone drawer.
                'absolute bottom-full left-0 z-[60] mb-1 max-h-[calc(100vh-6rem)] w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-ui bg-ui-raise p-3 text-meta text-ui-ink shadow-xl shadow-black/30 motion-safe:animate-ui-pop'
              : 'absolute right-0 top-full z-[60] mt-1 max-h-[calc(100vh-4rem)] overflow-y-auto w-[22rem] max-w-[calc(100vw-1rem)] max-sm:fixed max-sm:inset-x-2 max-sm:top-auto max-sm:w-auto max-sm:max-w-none rounded-ui bg-ui-surface p-3 text-meta text-ui-ink shadow-lg'
          }
        >
          {details.map((detail, i) => (
            <div
              key={detail.provider}
              data-testid={`ai-usage-provider-${detail.provider}`}
              className={i > 0 ? 'mt-3 border-t border-ui-line pt-3' : undefined}
            >
              <div className="flex items-center gap-1">
                <p className="text-body font-semibold text-ui-ink">{detail.heading}</p>
                {i === infoAt && <LimnShareInfo />}
              </div>
              {detail.paused != null && (
                <p className="mt-1 font-medium text-ui-warn">{detail.paused}</p>
              )}
              {detail.sections.map((sec) => (
                <div key={sec.title} className="mt-2.5">
                  <p className="text-meta font-medium  text-ui-mute">{sec.title}</p>
                  <dl className="mt-1 space-y-1.5">
                    {sec.rows.map((r) => (
                      <div key={r.label}>
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="shrink-0 text-ui-mute">{r.label}</dt>
                          <dd className="text-right tabular-nums text-ui-ink">{r.value}</dd>
                        </div>
                        {r.barPct != null && <UsageBar pct={r.barPct} />}
                        {r.note != null && (
                          <p className="mt-0.5 text-meta text-ui-mute">{r.note}</p>
                        )}
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              {detail.updated != null && (
                <p className="mt-1.5 text-meta text-ui-mute">{detail.updated}</p>
              )}
            </div>
          ))}
          <div className="mt-3 flex items-center justify-end gap-4 border-t border-ui-line pt-2">
            {/* Where the usage went: Reports → AI usage. */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                useFilters.getState().setInsightsInnerTab('ai-usage');
                goTo('insights');
              }}
              className="hit rounded-ui text-meta text-ui-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              Usage report
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings('claude-spend');
              }}
              className="hit rounded-ui text-meta text-ui-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
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
        The bar runs to Limn’s limit, {AI_BUDGET_DEFAULTS.weekSharePct}% of the week unless you change it in AI spend
        settings; past it, automatic runs pause. Switch the limit off there and the bar runs to your whole allowance.
      </p>
      <p>Claude’s share is an estimate from Anthropic’s unpublished limits. Codex’s is your account’s figure, weighted by Limn’s tokens.</p>
    </InfoButton>
  );
}

/** One row's bar: how full it is, amber from 80%, red at 100%. Decorative — the row's text says the figure. */
function UsageBar({ pct }: { pct: number }) {
  const fill = pct >= 100 ? 'bg-ui-danger' : pct >= 80 ? 'bg-ui-warn' : 'bg-ui-accent-fill';
  return (
    <div aria-hidden="true" className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-ui-hover">
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
