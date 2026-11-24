import { useEffect, useState } from 'react';
import {
  AI_BUDGET_DEFAULTS,
  AI_BUDGET_SHARE_MAX,
  AI_SUBSCRIPTION_LABELS,
  aiProviderName,
  type AiBudgetResponse,
  type AiSubscriptionKind,
} from '@pierre-review/shared';
import { useAiBudget, useSetAiBudget } from '../../hooks/useAiBudget.js';
import {
  codexWindowLines,
  fiveHourUsedSentence,
  formatUsd,
  pausedSentence,
  reviewsPerDayText,
  usedSentence,
} from '../../lib/aiBudget.js';
import { claudeSpendBodyOf, claudeSpendDraftOf, type ClaudeSpendDraft } from './claudeSpendForm.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SectionShell, inputCls, CheckInput } from './ui.js';
import { SaveState, useAutoSave, useEchoGuard } from './autosave.js';
import { Select } from '../ui/index.js';

// "AI spend" — the ONE budget that pauses Limn's AUTOMATIC AI runs before they eat
// the reader's subscription allowance or API bill (GET/PUT /api/ai/budget; docs/CLAUDE-REVIEW.md
// § The Claude spend budget). ACCOUNT-grained (it guards this machine's Claude login or API key),
// so it sits in the modal's global half. ON by default at 50% of the week on a subscription (the
// reader may change it or switch it off); on an API key nothing applies until the reader sets a figure.
//
// TWO QUOTAS, the DAILY one first: Ensemble's spend since midnight as a share of the week (on an API
// key, of the weekly US$), and the WEEKLY one. The Claude Code login gets two percentages plus the
// subscription (detected, or picked where Claude's report is ambiguous) — never US$; an API key gets a
// weekly US$ budget and the daily share of it. The server decides; this section only edits the
// settings and words the status. They replaced every per-feature daily COUNT (2026-11-24).
//
// THE 5-HOUR SHARE IS ENFORCED BUT NOT SHOWN: it follows the weekly share (every save sends null). Its
// status line and ⓘ sentence show only while the provider reported a 5-hour window lately.
//
// It judges the ACTIVE provider (`status.provider`). On Codex with a ChatGPT sign-in there is no
// subscription to pick: Codex reports its own 5-hour and weekly windows, shown here in percent, and
// Limn's share is token-weighted (shared ai-budget.ts `codexShares`).

/** The heading the modal lands on for `openSettings('claude-spend')` (the meter, the toast). */
export const CLAUDE_SPEND_SECTION_HEADING_ID = 'settings-claude-spend';

type Draft = ClaudeSpendDraft;
const draftOf = claudeSpendDraftOf;
const bodyOf = claudeSpendBodyOf;

const BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent';
const NUM = `${inputCls} w-20`;

export function ClaudeSpendSection(): JSX.Element | null {
  const q = useAiBudget();
  const save = useSetAiBudget();
  const data = q.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const storedKey = data == null ? '' : JSON.stringify(data.settings) + String(data.isDefault);
  const echo = useEchoGuard(JSON.stringify(draft), null);
  useEffect(() => {
    if (echo.keepDraft()) return;
    if (data != null) setDraft(draftOf(data));
    // Re-seed on first load and after a save (the stored settings changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const provider = data?.status.provider ?? 'claude';
  const name = aiProviderName(provider);
  // Unknown (still loading, an older server) ⇒ no 5-hour parts.
  const fiveHourLimit = data?.usage.fiveHourLimit === true;
  const info = <SpendInfo provider={provider} fiveHourLimit={fiveHourLimit} />;

  // SAVES AS YOU GO (./autosave.tsx): the tick and the subscription pick write at once, a typed
  // figure after a pause or on blur. An invalid figure is never written; the reason shows inline.
  const route = data?.status.route ?? 'none';
  const parsed = draft != null ? bodyOf(draft, route) : null;
  const error = parsed != null && 'error' in parsed ? parsed.error : null;
  const dirty = data != null && draft != null && JSON.stringify(draft) !== JSON.stringify(draftOf(data));
  const autosave = useAutoSave({
    key: JSON.stringify(draft),
    ready: route !== 'none' && dirty && parsed != null && 'body' in parsed,
    busy: save.isPending,
    run: () => {
      if (parsed != null && 'body' in parsed) {
        echo.markSent();
        save.mutate(parsed.body);
      }
    },
  });

  if (q.isError) {
    return (
      <SectionShell title="AI spend" headingId={CLAUDE_SPEND_SECTION_HEADING_ID} info={info}>
        <p className="text-body text-ui-danger">Couldn’t load the budget.</p>
      </SectionShell>
    );
  }
  if (data == null || draft == null) {
    return (
      <SectionShell title="AI spend" headingId={CLAUDE_SPEND_SECTION_HEADING_ID} info={info}>
        <p className="text-meta text-ui-mute">Loading…</p>
      </SectionShell>
    );
  }

  const { status, settings } = data;

  if (route === 'none') {
    return (
      <SectionShell
        title="AI spend"
        headingId={CLAUDE_SPEND_SECTION_HEADING_ID}
        info={info}
        desc={
          provider === 'codex'
            ? 'Codex is not signed in, so there is nothing to limit yet.'
            : 'No Claude login or API key found, so there is nothing to limit yet.'
        }
      >
        {null}
      </SectionShell>
    );
  }

  /** A typed figure: written after a pause (or on blur, `autosave.flush`). */
  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });
  /** A tick, a pick or a button: written at once. */
  const setNow = (patch: Partial<Draft>): void => {
    autosave.now();
    set(patch);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') autosave.flush();
  };

  // OFF and not being set up: one line and the button that fills in the suggested values.
  if (!draft.enabled && !settings.enabled) {
    return (
      <SectionShell
        title="AI spend"
        headingId={CLAUDE_SPEND_SECTION_HEADING_ID}
        info={info}
        desc={
          route === 'api_key'
            ? `Off. Set daily and weekly US$ limits for Ensemble’s automatic ${name} runs.`
            : `Off. Give Ensemble’s automatic ${name} runs a daily and a weekly quota.`
        }
      >
        <button
          type="button"
          className={BTN}
          onClick={() =>
            setNow({
              enabled: true,
              weekSharePct: String(AI_BUDGET_DEFAULTS.weekSharePct),
              daySharePct: String(AI_BUDGET_DEFAULTS.daySharePct),
            })
          }
        >
          Set a budget
        </button>
      </SectionShell>
    );
  }

  const sub = status.subscription;
  // The subscription the form shows: Claude's report when it settles it, else the reader's draft pick.
  const pickFrom = sub?.pickFrom ?? null;
  const reportedMax = sub?.reportedSubscription?.trim().toLowerCase() === 'max';
  const shareDirty =
    draft.weekSharePct !== String(settings.weekSharePct) ||
    draft.daySharePct !== String(settings.daySharePct ?? AI_BUDGET_DEFAULTS.daySharePct) ||
    draft.subscription !== settings.subscription;
  const fiveUsed = status.enabled && fiveHourLimit ? fiveHourUsedSentence(status) : null;
  const perDay = shareDirty ? null : reviewsPerDayText(sub?.reviewsPerDay);
  const used = status.enabled ? usedSentence(status) : null;

  return (
    <SectionShell
      title="AI spend"
      headingId={CLAUDE_SPEND_SECTION_HEADING_ID}
      info={info}
      desc={
        route === 'api_key'
          ? 'Your API key: pause automatic runs over these amounts.'
          : `Your ${provider === 'codex' ? 'ChatGPT plan' : 'Claude subscription'}: pause automatic runs once Ensemble has used its quota for the day or the week.`
      }
    >
      <label className="flex items-center gap-2 text-body">
        <CheckInput checked={draft.enabled} onChange={(e) => setNow({ enabled: e.target.checked })} />
        <span className="font-medium text-ui-ink">Pause automatic runs over a quota</span>
      </label>

      <div className={`space-y-2.5 pl-5 ${draft.enabled ? '' : 'opacity-60'}`}>
        <Field
          label={route === 'api_key' ? 'Daily quota (% of the weekly budget)' : `Daily quota (% of your weekly ${name} usage)`}
          htmlFor="ai-budget-day-share"
          hint={(route === 'api_key' ? null : perDay) ?? `1 to ${AI_BUDGET_SHARE_MAX}. Resets at midnight.`}
        >
          <input
            id="ai-budget-day-share"
            type="text"
            inputMode="numeric"
            className={NUM}
            value={draft.daySharePct}
            onChange={(e) => set({ daySharePct: e.target.value })}
            onBlur={autosave.flush}
            onKeyDown={onKeyDown}
          />
        </Field>
        {route === 'api_key' ? (
          <Field label="Weekly budget (US$)" htmlFor="ai-budget-weekly">
            <input
              id="ai-budget-weekly"
              type="text"
              inputMode="decimal"
              className={NUM}
              placeholder={String(AI_BUDGET_DEFAULTS.weeklyUsd)}
              value={draft.weeklyUsd}
              onChange={(e) => set({ weeklyUsd: e.target.value })}
              onBlur={autosave.flush}
              onKeyDown={onKeyDown}
            />
          </Field>
        ) : (
          <>
            <Field
              label={`Weekly quota (% of your weekly ${name} usage)`}
              htmlFor="ai-budget-share"
              hint={`1 to ${AI_BUDGET_SHARE_MAX}`}
            >
              <input
                id="ai-budget-share"
                type="text"
                inputMode="numeric"
                className={NUM}
                value={draft.weekSharePct}
                onChange={(e) => set({ weekSharePct: e.target.value })}
              onBlur={autosave.flush}
              onKeyDown={onKeyDown}
              />
            </Field>
            {/* The subscription shows once the budget is saved on: until then the server has not
                read Claude's report, so there is nothing to offer (a picker with no choices). */}
            {sub == null ? null : provider === 'codex' ? (
              sub.reportedSubscription != null && sub.reportedSubscription.trim() !== '' ? (
                <p className="text-meta text-ui-mute" data-testid="ai-budget-subscription">
                  Plan: ChatGPT {capitalise(sub.reportedSubscription)}
                </p>
              ) : null
            ) : pickFrom == null && sub.subscription != null ? (
              <p className="text-meta text-ui-mute" data-testid="ai-budget-subscription">
                Subscription: {AI_SUBSCRIPTION_LABELS[sub.subscription]}
              </p>
            ) : (
              <Field group label="Your subscription">
                <Select
                  id="ai-budget-subscription"
                  label="Your subscription"
                  value={draft.subscription != null && (pickFrom ?? []).includes(draft.subscription) ? draft.subscription : null}
                  onChange={(v) => setNow({ subscription: v })}
                  options={(pickFrom ?? []).map((k) => ({ value: k, label: AI_SUBSCRIPTION_LABELS[k] }))}
                />
              </Field>
            )}
            {/* Claude reports "max" without saying which: ask, never guess (Max 5x and Ultra differ fourfold). */}
            {provider !== 'codex' && reportedMax && sub?.subscription == null && (
              <p className="text-body text-ui-warn" data-testid="ai-budget-pick-max">
                Claude doesn’t say whether you’re on Max 5x or Ultra. Which one?
              </p>
            )}
          </>
        )}
      </div>

      <SaveState section="AI spend" mutation={save} dirty={dirty} invalid={dirty && draft.enabled ? error : null} />

      {status.enabled && (
        <div className="space-y-0.5 text-meta text-ui-mute" data-testid="ai-budget-status">
          {status.overBudget && <p className="font-medium text-ui-warn">{pausedSentence(status)}</p>}
          {status.mode === 'api_key' && status.apiKey != null && (
            <p>
              This week {formatUsd(status.apiKey.usedUsd)} of {formatUsd(status.apiKey.weeklyUsd)}
            </p>
          )}
          {status.mode === 'subscription' &&
            (used != null ? (
              <>
                <p>{used}.</p>
                {fiveUsed != null && <p>{fiveUsed}.</p>}
              </>
            ) : provider === 'codex' ? (
              <p>Ensemble has not read your Codex usage yet.</p>
            ) : (
              <p>Pick your subscription so Ensemble can work out its share.</p>
            ))}
        </div>
      )}
      <CodexWindows data={data} />
    </SectionShell>
  );
}

function capitalise(v: string): string {
  const t = v.trim();
  return t === '' ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

/** Codex on a ChatGPT sign-in: its own two windows, in percent ("Codex this week: 31% used · resets
 *  Tue 09:00"). Nothing on Claude, an API key, or before Codex has been read. */
function CodexWindows({ data }: { data: AiBudgetResponse }): JSX.Element | null {
  const lines = codexWindowLines(data.usage);
  if (lines.length === 0) return null;
  return (
    <div className="space-y-0.5 text-meta text-ui-mute" data-testid="ai-budget-codex-windows">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

/** The ⓘ: what the budget limits and how, for the provider it judges. */
function SpendInfo({ provider, fiveHourLimit }: { provider: 'claude' | 'codex'; fiveHourLimit: boolean }): JSX.Element {
  const name = aiProviderName(provider);
  return (
    <InfoButton title="AI spend">
      <p>
        Ensemble runs some {name} work by itself: auto review and re-reviews, Check threads, auto fix, the
        CI and ticket reviews, diagrams, This Sprint's briefs and the Slack summary. This limits those
        runs.
      </p>
      <p className="mt-2">
        The daily quota counts from midnight on this computer, as a share of your week. When it is used,
        automatic runs stop until midnight. The weekly quota works the same way over the week. A
        notification warns you at 80% of either.
      </p>
      {provider === 'codex' ? (
        <>
          <p className="mt-2">
            On a ChatGPT plan, Codex reports how much of its {fiveHourLimit ? 'weekly and 5-hour limits' : 'weekly limit'}{' '}
            your account has used, in whole percent. Ensemble's share is that figure times the part of your
            Codex tokens its own runs used, so it moves in coarse steps. When its share is used, Ensemble stops
            starting automatic runs until the window resets.
          </p>
          {fiveHourLimit && (
            <p className="mt-2">Ensemble also takes no more than its weekly share of each 5-hour window.</p>
          )}
        </>
      ) : (
        <>
          <p className="mt-2">
            On a Claude subscription, Claude keeps track of how much of your weekly allowance you have
            used. Ensemble adds up what its own runs use and compares it with your subscription's usual weekly
            allowance. That is an estimate, because Anthropic doesn't publish exact figures. When its share
            is used, Ensemble stops starting automatic runs until your week resets.
          </p>
          {fiveHourLimit && (
            <p className="mt-2">
              Your plan also limits each 5-hour session. Ensemble takes no more than its weekly share of a
              session. Over it, automatic runs wait for the session to reset.
            </p>
          )}
          <p className="mt-2">
            With an API key, the limits are what Ensemble's runs cost today and over the last 7 days.
          </p>
        </>
      )}
      <p className="mt-2">
        Your own use of {name} is never limited, and runs you start yourself still run after you confirm.
      </p>
    </InfoButton>
  );
}
