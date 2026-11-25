import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { aiProviderName, aiQuotaWarning, type AiProviderId } from '@pierre-review/shared';
import { useAiBudget } from '../hooks/useAiBudget.js';
import { useSettingsModal } from '../store/settingsModal.js';
import { meterText, pausedSentence, quotaWarningCopy, reviewsPerDayText, runButtonsIn } from '../lib/aiBudget.js';
import { HeaderToast, ToastLineButton } from './HeaderToasts.js';
import { ExclaimIcon } from './Icons.js';

// THE AI SPEND BUDGET'S THREE SMALL SURFACES. All read the ONE query (`useAiBudget`), so the
// header toast, every meter and every confirm share one request. The DECISION is the server's.
//
//  • `AiBudgetMeter` — one compact line beside a Run button ("Ensemble today: 3% of 10% · week 12% of
//    50%" on a subscription, "Today $1.20 of $2.50 · week $4.10 of $25" on an API key).
//    Renders nothing while the budget is off. A click opens Settings at the budget.
//  • `OverBudgetConfirm` — while over budget, the Run control inside it takes TWO presses: the first
//    arms it and says so, the second runs. Only the Run control (`runButtonsIn`); an ⓘ or a Discard
//    beside it works as usual. A run the reader starts is never refused.
//  • `AiBudgetToast` — the header card near a daily or weekly quota, and while automatic runs are paused.
//
// ⚠ `AiRunGate` (components/AiSetup.tsx) mounts the first two, so every AI surface gets them
// without editing the surface.

/** The compact meter beside a Run button. Null while the budget is off or not loaded. */
export function AiBudgetMeter({ provider }: { provider?: AiProviderId | null } = {}): JSX.Element | null {
  const { data } = useAiBudget(provider);
  const openSettings = useSettingsModal((s) => s.openSettings);
  if (data == null) return null;
  const text = meterText(data.status);
  if (text == null || data.status.overBudget) return null;
  const perDay = reviewsPerDayText(data.status.subscription?.reviewsPerDay);
  return (
    <button
      type="button"
      data-ai-budget-meter
      onClick={() => openSettings('claude-spend')}
      title={`${perDay != null ? `Ensemble's share pays for ${perDay}.\n` : ''}AI spend: open Settings`}
      className="hit whitespace-nowrap rounded-ui text-meta text-ui-mute hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
    >
      {text}
    </button>
  );
}

/** How long an armed "press again" waits for the second press. */
const ARM_MS = 15_000;

/**
 * Wrap a Run button. Under budget: the children, untouched. Over budget: the first press on a RUN
 * control (`runButtonsIn`) — or the Enter that would press it from a text box — is held and arms
 * it; the next one runs. Every other button and key inside the gate works as usual.
 *
 * `display: contents`, so the wrapper adds no box and the surface's flex layout is unchanged; the
 * capture-phase handlers still see every event from inside it.
 */
export function OverBudgetConfirm({
  children,
  provider,
}: {
  children: ReactNode;
  /** The provider the run goes to (a per-run pick). Absent ⇒ the default provider's budget. */
  provider?: AiProviderId | null;
}): JSX.Element {
  const { data } = useAiBudget(provider);
  const openSettings = useSettingsModal((s) => s.openSettings);
  const over = data?.status.overBudget === true;
  const [armed, setArmed] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), ARM_MS);
    return () => window.clearTimeout(t);
  }, [armed]);
  useEffect(() => {
    if (!over) setArmed(false);
  }, [over]);

  if (!over) return <>{children}</>;

  const hold = (e: SyntheticEvent): void => {
    if (armed) {
      setArmed(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setArmed(true);
  };
  const onClickCapture = (e: React.MouseEvent): void => {
    const wrap = wrapRef.current;
    const btn = (e.target as HTMLElement).closest('button');
    if (wrap == null || btn == null || btn.disabled || !wrap.contains(btn)) return;
    if (!runButtonsIn(wrap).includes(btn)) return;
    hold(e);
  };
  const onKeyDownCapture = (e: React.KeyboardEvent): void => {
    const wrap = wrapRef.current;
    if (wrap == null || e.key !== 'Enter' || e.shiftKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.tagName !== 'TEXTAREA' && t.tagName !== 'INPUT') return;
    const form = (t as HTMLInputElement | HTMLTextAreaElement).form;
    const runs = runButtonsIn(wrap).filter((b) => !b.disabled);
    // In a form: Enter submits it, so hold only when the form's Run control would run. Outside a
    // form: plain Enter is a new line; only Ctrl/Cmd+Enter sends (the plan box).
    const sends = form != null ? runs.some((b) => form.contains(b)) : (e.metaKey || e.ctrlKey) && runs.length > 0;
    if (!sends) return;
    hold(e);
  };

  return (
    <>
      <span ref={wrapRef} className="contents" onClickCapture={onClickCapture} onKeyDownCapture={onKeyDownCapture}>
        {children}
      </span>
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-meta text-ui-warn" role="status">
        <button
          type="button"
          onClick={() => openSettings('claude-spend')}
          className="hit rounded-ui font-medium hover:underline text-link-phone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          title="Over your AI spend budget: open Settings"
        >
          Over budget
        </button>
        {armed && <span>· press again to run</span>}
      </span>
    </>
  );
}

/** The bouncing "!" the quota cards carry (still for a reader who asked for less motion). */
function QuotaBang(): JSX.Element {
  return <ExclaimIcon size={13} className="motion-safe:animate-bounce" />;
}

/**
 * THE QUOTA CARD in the header's toast cluster: NEAR the daily or weekly quota (≥ 80%, shared
 * `aiQuotaWarning`) it warns; OVER a quota (automatic runs paused) it says so and when they resume.
 * Both carry a bouncing "!" and open Settings → AI spend, where the quotas are changed. Dismissible
 * until the state changes (a new level, quota or reset).
 */
export function AiBudgetToast(): JSX.Element | null {
  const { data } = useAiBudget();
  const openSettings = useSettingsModal((s) => s.openSettings);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  if (data == null) return null;
  const status = data.status;
  const name = aiProviderName(status.provider);
  const change = <ToastLineButton onClick={() => openSettings('claude-spend')}>Change quota</ToastLineButton>;
  if (status.overBudget) {
    const key = `over:${status.limitedBy ?? ''}:${status.resumesAt ?? 'paused'}`;
    if (dismissedFor === key) return null;
    return (
      <HeaderToast
        testId="ai-budget-toast"
        tone="ai"
        icon={<QuotaBang />}
        label={status.limitedBy === 'day' ? 'Daily AI quota used' : `Automatic ${name} runs paused`}
        summary={pausedSentence(status)}
        action={change}
        onDismiss={() => setDismissedFor(key)}
        alert
        footer={<span>Your own use of {name} is not limited. Runs you start still run after you confirm.</span>}
      />
    );
  }
  const warn = aiQuotaWarning(status);
  if (warn == null || warn.level !== 'near') return null;
  const key = `near:${warn.which}:${warn.resetsAt ?? ''}`;
  if (dismissedFor === key) return null;
  const { label, summary } = quotaWarningCopy(warn);
  return (
    <HeaderToast
      testId="ai-quota-toast"
      tone="ai"
      icon={<QuotaBang />}
      label={label}
      summary={summary}
      action={change}
      onDismiss={() => setDismissedFor(key)}
    />
  );
}
