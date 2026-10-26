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
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';

// "AI spend" — the ONE optional budget that pauses Limn's AUTOMATIC AI runs before they eat
// the reader's subscription allowance or API bill (GET/PUT /api/ai/budget; docs/CLAUDE-REVIEW.md
// § The Claude spend budget). ACCOUNT-grained (it guards this machine's Claude login or API key),
// so it sits in the modal's global half. OFF until the reader switches it on.
//
// The form follows the CREDENTIAL ROUTE the server reports: the Claude Code login gets ONE number,
// Limn's share of the weekly allowance (1–50%) — the 5-hour share follows it unless the reader opens
// "Set a separate 5-hour limit" (claudeSpendForm.ts) — plus the subscription (detected, or picked where
// Claude's report is ambiguous) — percentages only, never US$; an API key gets a weekly US$ budget.
// The server decides; this section only edits the settings and words the status.
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
  'rounded border border-gray-300 px-2 py-1 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500';
const NUM = `${inputCls} w-20`;

/** " (5%)" for a valid weekly share in the draft, else "". */
function parseShareHint(week: string): string {
  const t = week.trim().replace(/%$/, '');
  return /^\d+$/.test(t) ? ` (${Number(t)}%)` : '';
}

export function ClaudeSpendSection(): JSX.Element | null {
  const q = useAiBudget();
  const save = useSetAiBudget();
  const data = q.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const storedKey = data == null ? '' : JSON.stringify(data.settings) + String(data.isDefault);
  useEffect(() => {
    if (data != null) setDraft(draftOf(data));
    // Re-seed on first load and after a save (the stored settings changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const provider = data?.status.provider ?? 'claude';
  const name = aiProviderName(provider);
  const info = <SpendInfo provider={provider} />;

  if (q.isError) {
    return (
      <SectionShell title="AI spend" headingId={CLAUDE_SPEND_SECTION_HEADING_ID} info={info}>
        <p className="text-xs text-red-600 dark:text-red-400">Couldn’t load the budget.</p>
      </SectionShell>
    );
  }
  if (data == null || draft == null) {
    return (
      <SectionShell title="AI spend" headingId={CLAUDE_SPEND_SECTION_HEADING_ID} info={info}>
        <p className="text-xs text-gray-500 dark:text-gray-400">Loading…</p>
      </SectionShell>
    );
  }

  const { status, settings } = data;
  const route = status.route;

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

  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });
  const parsed = bodyOf(draft, route);
  const error = 'error' in parsed ? parsed.error : null;
  const stored = draftOf(data);
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const submit = (): void => {
    if ('body' in parsed) save.mutate(parsed.body);
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
            ? `Off. Set a weekly US$ limit for Limn’s automatic ${name} runs.`
            : `Off. Give Limn’s automatic ${name} runs a share of your week.`
        }
      >
        <button
          type="button"
          className={BTN}
          onClick={() =>
            set({ enabled: true, weekSharePct: String(AI_BUDGET_DEFAULTS.weekSharePct) })
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
  const shareDirty = draft.weekSharePct !== String(settings.weekSharePct) || draft.subscription !== settings.subscription;
  const fiveUsed = status.enabled ? fiveHourUsedSentence(status) : null;
  const perDay = shareDirty ? null : reviewsPerDayText(sub?.reviewsPerDay);
  const used = status.enabled ? usedSentence(status) : null;

  return (
    <SectionShell
      title="AI spend"
      headingId={CLAUDE_SPEND_SECTION_HEADING_ID}
      info={info}
      desc={
        route === 'api_key'
          ? 'Your API key: pause automatic runs over this much a week.'
          : `Your ${provider === 'codex' ? 'ChatGPT plan' : 'Claude subscription'}: pause automatic runs once Limn has used its share of your week.`
      }
    >
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="font-medium text-gray-700 dark:text-gray-200">Pause automatic runs over budget</span>
      </label>

      <div className={`space-y-2.5 pl-5 ${draft.enabled ? '' : 'opacity-60'}`}>
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
            />
          </Field>
        ) : (
          <>
            <Field
              label={`Limn’s share of your weekly ${name} usage (%)`}
              htmlFor="ai-budget-share"
              hint={perDay ?? `1 to ${AI_BUDGET_SHARE_MAX}`}
            >
              <input
                id="ai-budget-share"
                type="text"
                inputMode="numeric"
                className={NUM}
                value={draft.weekSharePct}
                onChange={(e) => set({ weekSharePct: e.target.value })}
              />
            </Field>
            {/* THE 5-HOUR SHARE: follows the weekly one unless the reader sets their own. Collapsed
                by default; open when a separate figure is stored. Clearing it = same as weekly. */}
            <details open={settings.fiveHourSharePct != null} data-testid="ai-budget-five-hour">
              <summary className="cursor-pointer text-xs text-gray-600 dark:text-gray-300">
                Set a separate 5-hour limit
              </summary>
              <div className="mt-1.5 space-y-1.5">
                <Field
                  label="Limn’s share of each 5-hour session (%)"
                  htmlFor="ai-budget-five-hour-share"
                  hint={
                    draft.fiveHourSharePct.trim() === ''
                      ? `Same as your weekly share${parseShareHint(draft.weekSharePct)}`
                      : `1 to ${AI_BUDGET_SHARE_MAX}`
                  }
                >
                  <input
                    id="ai-budget-five-hour-share"
                    type="text"
                    inputMode="numeric"
                    className={NUM}
                    placeholder={draft.weekSharePct}
                    value={draft.fiveHourSharePct}
                    onChange={(e) => set({ fiveHourSharePct: e.target.value })}
                  />
                </Field>
                {draft.fiveHourSharePct.trim() !== '' && (
                  <button type="button" className={BTN} onClick={() => set({ fiveHourSharePct: '' })}>
                    Use the weekly share
                  </button>
                )}
              </div>
            </details>
            {/* The subscription shows once the budget is saved on: until then the server has not
                read Claude's report, so there is nothing to offer (a picker with no choices). */}
            {sub == null ? null : provider === 'codex' ? (
              sub.reportedSubscription != null && sub.reportedSubscription.trim() !== '' ? (
                <p className="text-xs text-gray-600 dark:text-gray-300" data-testid="ai-budget-subscription">
                  Plan: ChatGPT {capitalise(sub.reportedSubscription)}
                </p>
              ) : null
            ) : pickFrom == null && sub.subscription != null ? (
              <p className="text-xs text-gray-600 dark:text-gray-300" data-testid="ai-budget-subscription">
                Subscription: {AI_SUBSCRIPTION_LABELS[sub.subscription]}
              </p>
            ) : (
              <Field label="Your subscription" htmlFor="ai-budget-subscription">
                <select
                  id="ai-budget-subscription"
                  className={`${inputCls} w-40`}
                  value={draft.subscription != null && (pickFrom ?? []).includes(draft.subscription) ? draft.subscription : ''}
                  onChange={(e) =>
                    set({ subscription: e.target.value === '' ? null : (e.target.value as AiSubscriptionKind) })
                  }
                >
                  <option value="">Pick one</option>
                  {(pickFrom ?? []).map((k) => (
                    <option key={k} value={k}>
                      {AI_SUBSCRIPTION_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {/* Claude reports "max" without saying which: ask, never guess (5x and 20x differ fourfold). */}
            {provider !== 'codex' && reportedMax && sub?.subscription == null && (
              <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="ai-budget-pick-max">
                Claude says you’re on Max. Which one?
              </p>
            )}
          </>
        )}
      </div>

      {error != null && draft.enabled && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {save.isError && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {(save.error as Error)?.message || 'Couldn’t save the budget.'}
        </p>
      )}
      <SaveButton dirty={dirty && error == null} saving={save.isPending} onClick={submit} />

      {status.enabled && (
        <div className="space-y-0.5 text-xs text-gray-600 dark:text-gray-300" data-testid="ai-budget-status">
          {status.overBudget && <p className="font-medium text-amber-700 dark:text-amber-300">{pausedSentence(status)}</p>}
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
              <p>Limn has not read your Codex usage yet.</p>
            ) : (
              <p>Pick your subscription so Limn can work out its share.</p>
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
    <div className="space-y-0.5 text-xs text-gray-600 dark:text-gray-300" data-testid="ai-budget-codex-windows">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

/** The ⓘ: what the budget limits and how, for the provider it judges. */
function SpendInfo({ provider }: { provider: 'claude' | 'codex' }): JSX.Element {
  const name = aiProviderName(provider);
  return (
    <InfoButton title="AI spend">
      <p>
        Limn runs some {name} work by itself: auto review and re-reviews, Check threads, auto fix, the
        CI and ticket reviews, diagrams, This Sprint's briefs and the Slack summary. This limits those
        runs.
      </p>
      {provider === 'codex' ? (
        <>
          <p className="mt-2">
            On a ChatGPT plan, Codex reports how much of its weekly and 5-hour limits your account has
            used, in whole percent. Limn's share is that figure times the part of your Codex tokens its
            own runs used, so it moves in coarse steps. When its share is used, Limn stops starting
            automatic runs until the window resets.
          </p>
          <p className="mt-2">
            Limn takes the same share of a 5-hour window as of the week, unless you set a separate 5-hour
            limit.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2">
            On a Claude subscription, Claude keeps track of how much of your weekly allowance you have
            used. Limn adds up what its own runs use and compares it with your subscription's usual weekly
            allowance. That is an estimate, because Anthropic doesn't publish exact figures. When its share
            is used, Limn stops starting automatic runs until your week resets.
          </p>
          <p className="mt-2">
            Claude also limits each 5-hour session. Limn takes the same share of a session as of the week
            (5% of the week means 5% of each session), unless you set a separate 5-hour limit. Over it,
            automatic runs wait for the session to reset.
          </p>
          <p className="mt-2">With an API key, the limit is what Limn's runs cost over the last 7 days.</p>
        </>
      )}
      <p className="mt-2">
        Your own use of {name} is never limited, and runs you start yourself still run after you confirm.
      </p>
    </InfoButton>
  );
}
