import {
  AI_EFFORT_LABELS,
  AI_EFFORTS,
  AI_PROVIDER_SETTINGS,
  STORY_BUILD_LOOP_ROUNDS_MAX,
  AI_FIX_LOOP_ROUNDS_MAX,
  AI_FIX_LOOP_ROUNDS_MIN,
  STORY_BUILD_LOOP_ROUNDS_MIN,
  aiModelChoiceLabel,
  aiPickerModelProvider,
  aiPickerModels,
  aiPickerRequestModel,
  aiProviderName,
  isAiEffort,
  type AiApiKeySettingStatus,
  type AiClaudeProviderStatus,
  type AiCodexProviderStatus,
  type AiPickerModel,
  type AiProviderId,
  type AiProviderSetting,
  type AiRunKind,
  type AiRunProfiles,
  type AiRunProfilesStatus,
  type CodexLoginResponse,
  type MeResponse,
} from '@pierre-review/shared';
import { useMe } from '../../hooks/useTriage.js';
import { useAiRuntimeInstall, useAiRuntimePoll } from '../../hooks/useAiCapabilities.js';
import { useCodexLogin, useCodexLoginActions, useSetAiApiKey, useSetAiProvider, useSetAiRunProfiles } from '../../hooks/useAiProvider.js';
import { aiProviderReadyFor } from '../../lib/aiCapabilities.js';
import { isLastReviewVendorOn, withReviewVendor, withSurfaceChoice } from '../../lib/runProfiles.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { chatGptPlanLabel } from '../../lib/aiBudget.js';
import { InfoButton } from '../InfoModal.js';
import { SetUpInFeatures } from '../AiSetup.js';
import { SectionShell, RadioInput } from './ui.js';
import { Select, type SelectOption } from '../ui/index.js';

const EFFORT_OPTIONS: readonly SelectOption<string>[] = [
  { value: 'default', label: 'Default' },
  ...AI_EFFORTS.map((e) => ({ value: e, label: AI_EFFORT_LABELS[e] })),
];

// SETTINGS → AI: the DEFAULT provider and each provider's sign-in. The default runs every AUTOMATIC run
// (auto review, auto fix, the CI/ticket auto runs, scheduled summaries) and every surface without a model
// picker, and is a picker's opening choice; a MANUAL run with a picker (AI Review, AI Fix) may pick any
// signed-in provider's model (docs/CODEX-PLAN.md § 6, revised 2026-10-26).
// The choice is stored per machine (PUT /api/ai/provider) and read back from `/api/me`
// (`ai.provider`, `ai.providerSetting`, `ai.providers`). An explicitly set LIMN_AI_PROVIDER wins: the
// control then shows its value, disabled. A switch reaches the NEXT run; a run already going finishes
// where it started. Codex signs in to Limn's OWN Codex folder (~/.limn/codex), with ChatGPT only.
//
// THE RUN PROFILES (PUT /api/ai/run-profiles, read back as `ai.runProfiles`; shared ai-run-profiles.ts,
// docs/CLAUDE-REVIEW.md § The run profiles): three blocks — Review (per vendor: on/off, model, effort),
// AI Fix and Implement story (vendor, model, effort; Implement also its review rounds). They replaced the
// one Effort control (PUT /api/ai/effort stays as a compat path that resets every surface's effort).
// "Default" (null) is each provider's own depth; an explicitly set REVIEW_EFFORT wins and every effort
// control shows it, disabled. A vendor not signed in shows its sign-in line instead of controls.
//
// "USE MY API KEYS FIRST" (PUT /api/ai/api-key, read back as `ai.apiKeySetting`; shared ai-api-key.ts):
// ANTHROPIC_API_KEY ahead of the Claude Code sign-in (OPENAI_API_KEY for Codex is not used yet). The ⓘ
// names both variables; the line under the box says which are set. LIMN_AI_USE_API_KEY wins, disabled.

const BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50';
const MUTED = 'text-ui-mute';

const CHOICE_LABEL: Record<AiProviderSetting, string> = {
  auto: 'Auto',
  claude: 'Claude',
  codex: 'Codex',
};

/** The download's own line while it is not ready; null once it is (then the sign-in line). */
function downloadLine(name: string, runtime: string | undefined, message: string | null | undefined): string | null {
  if (runtime === 'installing') return `Setting up ${name}…${message ? ` ${message}` : ''}`;
  if (runtime === 'failed') return message ?? 'The download failed.';
  if (runtime === 'absent') return message ?? 'Not set up.';
  return null;
}

function claudeLine(c: AiClaudeProviderStatus): string {
  const dl = downloadLine('Claude', c.runtime, c.runtimeMessage);
  if (dl != null) return dl;
  if (c.route === 'login') return 'Signed in to Claude Code.';
  if (c.route === 'api_key') return 'Using ANTHROPIC_API_KEY.';
  return c.message ?? 'Sign in to Claude Code or set ANTHROPIC_API_KEY.';
}

function codexLine(c: AiCodexProviderStatus): string {
  const dl = downloadLine('Codex', c.runtime, c.runtimeMessage);
  if (dl != null) return dl;
  if (c.auth === 'ok') return c.plan ? `Signed in with ${chatGptPlanLabel(c.plan)}.` : 'Signed in with ChatGPT.';
  return c.message ?? 'Not signed in.';
}

/** The heading the modal lands on for `openSettings('ai-effort')` (Reports → AI usage): the AI
 *  section, whose Effort control sits under it. */
export const AI_SECTION_HEADING_ID = 'settings-ai';

export function AiProviderSection(): JSX.Element | null {
  const me = useMe().data;
  const ai = me?.ai;
  const set = useSetAiProvider();
  const install = useAiRuntimeInstall();
  const codexReady = ai?.providers.codex.runtime === 'ready';
  const claudeRuntime = ai?.providers.claude.runtime;
  const codexRuntime = ai?.providers.codex.runtime;
  // Limn downloads both by itself on the first boot: poll while it runs so each line moves on its own.
  useAiRuntimePoll(ai?.enabled === true && (claudeRuntime === 'installing' || codexRuntime === 'installing'));
  // Retry a failed download (both providers, one download), or Set up where the automatic one is off.
  const retryable = (r: string | undefined): boolean => r === 'failed' || (r === 'absent' && ai?.autoInstall !== true);
  const login = useCodexLogin(ai?.enabled === true && codexReady);
  const actions = useCodexLoginActions();

  const info = (
    <InfoButton title="AI provider">
      <p>
        This provider runs every automatic run (auto review, auto fix, ticket and CI reviews, diagrams and the
        summaries) and every AI feature without a model menu.
      </p>
      <p className="mt-2">
        AI Review and AI Fix have a model menu. When both Claude and Codex are signed in, it lists both, starting on
        this provider.
      </p>
      <p className="mt-2">Auto uses Claude when Claude is signed in, and Codex when only Codex is.</p>
      <p className="mt-2">
        Ensemble downloads Claude and Codex by itself the first time it starts. Signing in is the only step.
      </p>
      <p className="mt-2">
        A change applies to the next run. A run already going finishes on the provider it started on, and every run
        keeps the name of the provider and model that ran it.
      </p>
      <p className="mt-2">
        Codex signs in with your ChatGPT account, in Ensemble’s own folder (~/.ensemble/codex). Your own ~/.codex is not used,
        and neither is an OPENAI_API_KEY.
      </p>
    </InfoButton>
  );

  if (ai == null || !ai.enabled) return null;
  const setting = ai.providerSetting ?? { value: 'auto' as const, source: 'settings' as const };
  const fromEnv = setting.source === 'env';
  const chosen = set.isPending && set.variables != null ? set.variables : setting.value;

  return (
    <SectionShell title="AI" headingId={AI_SECTION_HEADING_ID} info={info} desc={`Default: ${aiProviderName(ai.provider)}.`}>
      <fieldset disabled={fromEnv || set.isPending} className="flex flex-wrap items-center gap-3 text-body">
        <legend className="sr-only">Automatic runs and default</legend>
        <span aria-hidden="true" className="text-ui-ink">
          Automatic runs and default:
        </span>
        {AI_PROVIDER_SETTINGS.map((v) => (
          <label key={v} className={`flex items-center gap-1.5 ${fromEnv ? 'opacity-60' : ''}`}>
            <RadioInput
              name="ai-provider"
              value={v}
              checked={chosen === v}
              onChange={() => set.mutate(v)}
            />
            <span className="font-medium text-ui-ink">{CHOICE_LABEL[v]}</span>
          </label>
        ))}
      </fieldset>
      {fromEnv && <p className={`text-body ${MUTED}`}>Set by ENSEMBLE_AI_PROVIDER (or LIMN_AI_PROVIDER).</p>}
      {set.isError && <p className="text-body text-ui-danger">{set.error.message}</p>}

      {ai.runProfiles != null && <RunProfilesControl me={me} status={ai.runProfiles} />}
      {ai.apiKeySetting != null && <ApiKeyControl setting={ai.apiKeySetting} />}

      <dl className="space-y-1.5 text-body">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="w-14 shrink-0 font-medium text-ui-ink">Claude</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className={ai.providers.claude.runtime === 'failed' ? 'text-ui-danger' : MUTED}>
              {claudeLine(ai.providers.claude)}
            </span>
            {/* Downloads happen in ONE place, Settings → Features (components/settings/ToolsSection.tsx). */}
            {retryable(claudeRuntime) && <SetUpInFeatures />}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="w-14 shrink-0 font-medium text-ui-ink">Codex</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className={codexRuntime === 'failed' ? 'text-ui-danger' : MUTED}>{codexLine(ai.providers.codex)}</span>
            {retryable(codexRuntime) && !retryable(claudeRuntime) && <SetUpInFeatures />}
            {codexReady && (
              <CodexSignIn
                signedIn={ai.providers.codex.signedIn}
                login={login.data ?? null}
                busy={actions.start.isPending || actions.cancel.isPending || actions.logout.isPending}
                onStart={(method) => actions.start.mutate(method)}
                onCancel={() => actions.cancel.mutate()}
                onSignOut={() => actions.logout.mutate()}
              />
            )}
          </dd>
        </div>
      </dl>
      {/* The lines above carry a download failure the server recorded; this is one it never saw. */}
      {install.state.phase === 'failed' && install.state.message && claudeRuntime !== 'failed' && codexRuntime !== 'failed' && (
        <p className="text-body text-ui-danger">{install.state.message}</p>
      )}
      <p className={`text-body ${MUTED}`}>Codex signs in with ChatGPT only. An OPENAI_API_KEY is not used.</p>
    </SectionShell>
  );
}

const modelOptions = (provider: AiProviderId): SelectOption<string>[] =>
  aiPickerModels(provider).map((m) => ({ value: m, label: aiModelChoiceLabel(aiPickerRequestModel(m), provider) }));

const vendorLine = (me: MeResponse | undefined, p: AiProviderId): string =>
  me?.ai == null ? 'Not signed in.' : p === 'codex' ? codexLine(me.ai.providers.codex) : claudeLine(me.ai.providers.claude);

const ROUND_OPTIONS: readonly SelectOption<string>[] = Array.from(
  { length: STORY_BUILD_LOOP_ROUNDS_MAX - STORY_BUILD_LOOP_ROUNDS_MIN + 1 },
  (_, i) => ({ value: String(STORY_BUILD_LOOP_ROUNDS_MIN + i), label: String(STORY_BUILD_LOOP_ROUNDS_MIN + i) }),
);

const FIX_ROUND_OPTIONS: readonly SelectOption<string>[] = Array.from(
  { length: AI_FIX_LOOP_ROUNDS_MAX - AI_FIX_LOOP_ROUNDS_MIN + 1 },
  (_, i) => ({ value: String(AI_FIX_LOOP_ROUNDS_MIN + i), label: String(AI_FIX_LOOP_ROUNDS_MIN + i) }),
);

const ROW = 'flex flex-wrap items-center gap-2 text-body';
const NAME = 'w-14 shrink-0 font-medium text-ui-ink';

/**
 * Settings → AI → Review, AI Fix and Implement story: which vendor, model and effort each runs on. The
 * run menus open on these and can pick another model for one run.
 */
function RunProfilesControl({ me, status }: { me: MeResponse | undefined; status: AiRunProfilesStatus }): JSX.Element {
  const set = useSetAiRunProfiles();
  const save = (next: AiRunProfiles) => set.mutate(next);
  const busy = set.isPending;
  const effortLocked = status.effortSource === 'env';
  const effortSelect = (
    id: string,
    label: string,
    value: AiRunProfilesStatus['fix']['effort'],
    onChange: (v: AiRunProfilesStatus['fix']['effort']) => void,
    off = false,
  ) => (
    <Select
      id={id}
      label={label}
      size="sm"
      value={value ?? 'default'}
      disabled={effortLocked || busy || off}
      onChange={(v) => onChange(isAiEffort(v) ? v : null)}
      options={EFFORT_OPTIONS}
    />
  );

  const choiceBlock = (surface: 'fix' | 'build', title: string, kind: AiRunKind, info: JSX.Element) => {
    const r = status[surface];
    const ready = (['claude', 'codex'] as const).filter((p) => aiProviderReadyFor(me, p, kind));
    const vendors = ready.includes(r.provider) ? ready : [r.provider, ...ready];
    return (
      <div className="space-y-1" data-testid={`ai-profile-${surface}`}>
        <div className="flex items-center gap-1 font-medium text-ui-ink">
          {title}
          {info}
        </div>
        {ready.length === 0 ? (
          <p className={`text-body ${MUTED}`}>{vendorLine(me, r.provider)}</p>
        ) : (
          <div className={ROW}>
            <Select
              id={`ai-${surface}-vendor`}
              label={`${title} vendor`}
              size="sm"
              value={r.provider}
              disabled={busy}
              onChange={(v) => save(withSurfaceChoice(status, surface, { provider: v === 'codex' ? 'codex' : 'claude' }))}
              options={vendors.map((p) => ({ value: p, label: aiProviderName(p) }))}
            />
            <Select
              id={`ai-${surface}-model`}
              label={`${title} model`}
              size="sm"
              value={r.model}
              disabled={busy}
              onChange={(v) => {
                if (aiPickerModelProvider(v) === r.provider) save(withSurfaceChoice(status, surface, { model: v as AiPickerModel }));
              }}
              options={modelOptions(r.provider)}
            />
            {effortSelect(`ai-${surface}-effort`, `${title} effort`, r.effort, (e) => save(withSurfaceChoice(status, surface, { effort: e })))}
            {surface === 'build' && (
              <label className="flex items-center gap-1.5 text-ui-ink">
                Review rounds
                <Select
                  id="ai-build-rounds"
                  label="Review rounds"
                  size="sm"
                  value={String(status.build.rounds)}
                  disabled={busy}
                  onChange={(v) => save(withSurfaceChoice(status, 'build', { rounds: Number(v) }))}
                  options={ROUND_OPTIONS}
                />
              </label>
            )}
            {surface === 'fix' && (
              <label className="flex items-center gap-1.5 text-ui-ink">
                Review rounds
                <Select
                  id="ai-fix-rounds"
                  label="AI Fix review rounds"
                  size="sm"
                  value={String(status.fix.rounds)}
                  disabled={busy}
                  onChange={(v) => save(withSurfaceChoice(status, 'fix', { rounds: Number(v) }))}
                  options={FIX_ROUND_OPTIONS}
                />
              </label>
            )}
          </div>
        )}
        {!ready.includes(r.provider) && ready.length > 0 && (
          <p className={`text-body ${MUTED}`}>{aiProviderName(r.provider)} is not signed in, so {aiProviderName(ready[0])} runs.</p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid="ai-run-profiles">
      <div className="space-y-1" data-testid="ai-profile-review">
        <div className="flex items-center gap-1 font-medium text-ui-ink">
          Review
          <InfoButton title="Review">
            <p>
              Every review uses these: AI Review, auto reviews, the CI review, the story check, Check threads and the review
              rounds of Implement story.
            </p>
            <p className="mt-2">
              With both on and signed in, Claude and Codex review together as one review, each at its own model and effort.
              With one on, it reviews alone. One must stay on.
            </p>
            <p className="mt-2">
              Higher effort reads more and finds more, and uses more of your plan or costs more. Default runs Claude at
              medium and Codex at high on its most thorough model. A review of a small change from its diff alone runs one
              level lower, but never below Default unless you pick a lower level.
            </p>
            <p className="mt-2">The AI Review menu can pick another model for one run. Each run shows the model and effort it used.</p>
          </InfoButton>
        </div>
        {(['claude', 'codex'] as const).map((p) => {
          const v = status.review[p];
          const signedIn = aiProviderReadyFor(me, p, 'review');
          // One vendor must stay on: the last one switched on — or the only one on that is signed in —
          // cannot be switched off.
          const other: AiProviderId = p === 'claude' ? 'codex' : 'claude';
          const last = isLastReviewVendorOn(status, p) || (v.enabled && !aiProviderReadyFor(me, other, 'review'));
          return (
            <div key={p} className={ROW} data-testid={`ai-profile-review-${p}`}>
              <span className={NAME}>{aiProviderName(p)}</span>
              {signedIn ? (
                <>
                  <label className="flex items-center gap-1.5 text-ui-ink">
                    <CheckboxBox
                      checked={v.enabled}
                      disabled={busy || last}
                      aria-label={`${aiProviderName(p)} reviews`}
                      onChange={(e) => save(withReviewVendor(status, p, { enabled: e.target.checked }))}
                    />
                    On
                  </label>
                  <Select
                    id={`ai-review-${p}-model`}
                    label={`${aiProviderName(p)} review model`}
                    size="sm"
                    value={v.model}
                    disabled={busy || !v.enabled}
                    onChange={(m) => {
                      if (aiPickerModelProvider(m) === p) save(withReviewVendor(status, p, { model: m as AiPickerModel }));
                    }}
                    options={modelOptions(p)}
                  />
                  {/* Switched off: its model and effort are kept but cannot change (as the model). */}
                  {effortSelect(
                    `ai-review-${p}-effort`,
                    `${aiProviderName(p)} review effort`,
                    v.effort,
                    (e) => save(withReviewVendor(status, p, { effort: e })),
                    !v.enabled,
                  )}
                </>
              ) : (
                <span className={MUTED}>{vendorLine(me, p)}</span>
              )}
            </div>
          );
        })}
      </div>
      {choiceBlock(
        'fix',
        'AI Fix',
        'fix',
        <InfoButton title="AI Fix">
          <p>AI Fix, Plan first and auto fix run on this vendor and model. The AI Fix menu can pick another model for one run.</p>
          <p className="mt-2">
            Review rounds: after each fix, Ensemble reviews the fix and the agent answers, up to this many times, before
            anything is pushed. Every fix uses it, manual and automatic. The reviews use the Review settings above.
          </p>
          <p className="mt-2">
            If this vendor is not signed in or is over its usage limit, the other signed-in vendor runs at its usual model
            and Default effort. The run shows what it used.
          </p>
        </InfoButton>,
      )}
      {choiceBlock(
        'build',
        'Implement story',
        'story_build',
        <InfoButton title="Implement story">
          <p>Implement story plans and builds on this vendor and model. Its start panel can pick another model for one build.</p>
          <p className="mt-2">
            Review rounds: how many times the review loop reviews and fixes the work before it opens the pull request. The
            start panel opens on this number and can change it for one build.
          </p>
          <p className="mt-2">
            If this vendor is not signed in or is over its usage limit, the other signed-in vendor runs at its usual model
            and Default effort.
          </p>
        </InfoButton>,
      )}
      {effortLocked && <p className={`text-body ${MUTED}`}>Effort is set by REVIEW_EFFORT.</p>}
      {set.isError && <p className="text-body text-ui-danger">{set.error.message}</p>}
    </div>
  );
}

const isSet = (name: string, set: boolean): string => `${name} is ${set ? 'set' : 'not set'}.`;

/** Settings → AI → "Use my API keys first": the environment's API key ahead of the sign-in. */
function ApiKeyControl({ setting }: { setting: AiApiKeySettingStatus }): JSX.Element {
  const set = useSetAiApiKey();
  const fromEnv = setting.source === 'env';
  const checked = set.isPending && set.variables !== undefined ? set.variables : setting.value;
  return (
    <div className="space-y-1" data-testid="ai-api-key-setting">
      <div className="flex flex-wrap items-center gap-2 text-body">
        <label className={`flex w-fit cursor-pointer items-center gap-1.5 text-ui-ink ${fromEnv ? 'opacity-60' : ''}`}>
          <CheckboxBox checked={checked} disabled={fromEnv || set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
          Use my API keys first
        </label>
        <InfoButton title="API keys">
          <p>
            Claude: Ensemble looks for <code>ANTHROPIC_API_KEY</code> in the environment it started in (your shell, or the
            .env file). When this is ticked and the key is set, every Claude run uses the key, even while you are signed in
            to Claude Code. Anthropic bills the key per token, and Ensemble shows its spend in US$.
          </p>
          <p className="mt-2">When this is not ticked, Ensemble uses your Claude Code sign-in, and the key only when you are not signed in.</p>
          <p className="mt-2">
            Codex: Ensemble looks for <code>OPENAI_API_KEY</code>. Codex runs on an API key are not available yet, so Codex
            keeps using your ChatGPT sign-in.
          </p>
          <p className="mt-2">
            Ensemble never stores a key. Start Ensemble with <code>ENSEMBLE_AI_USE_API_KEY=true</code> or <code>false</code> to
            decide this from the environment.
          </p>
        </InfoButton>
      </div>
      <p className={`text-body ${MUTED}`}>
        {isSet('ANTHROPIC_API_KEY', setting.anthropicKeySet)} {isSet('OPENAI_API_KEY', setting.openaiKeySet)}
      </p>
      {fromEnv && <p className={`text-body ${MUTED}`}>Set by ENSEMBLE_AI_USE_API_KEY (or LIMN_AI_USE_API_KEY).</p>}
      {set.isError && <p className="text-body text-ui-danger">{set.error.message}</p>}
    </div>
  );
}

/** The Codex sign-in controls: start (browser, or a one-time code), the open page or code, cancel, sign out. */
function CodexSignIn({
  signedIn,
  login,
  busy,
  onStart,
  onCancel,
  onSignOut,
}: {
  signedIn: boolean;
  login: CodexLoginResponse | null;
  busy: boolean;
  onStart: (method: 'browser' | 'device') => void;
  onCancel: () => void;
  onSignOut: () => void;
}): JSX.Element {
  const state = login?.login;
  if (state?.state === 'waiting') {
    const authUrl = safeExternalUrl(state.authUrl);
    const verificationUrl = safeExternalUrl(state.verificationUrl);
    return (
      <span className="flex flex-wrap items-center gap-2">
        {authUrl != null && (
          <a href={authUrl} target="_blank" rel="noreferrer" className="hit text-ui-ink underline">
            Open the ChatGPT sign-in
          </a>
        )}
        {verificationUrl != null && (
          <span className={MUTED}>
            Go to{' '}
            <a href={verificationUrl} target="_blank" rel="noreferrer" className="hit text-ui-ink underline">
              the sign-in page
            </a>{' '}
            and enter <span className="font-mono font-semibold text-ui-ink">{state.userCode}</span>
          </span>
        )}
        <button type="button" className={BTN} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    );
  }
  if (signedIn) {
    return (
      <button type="button" className={BTN} disabled={busy} onClick={onSignOut}>
        Sign out
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className={BTN} disabled={busy} onClick={() => onStart('browser')}>
        Sign in with ChatGPT
      </button>
      <button type="button" className={`${MUTED} underline`} disabled={busy} onClick={() => onStart('device')}>
        Use a code instead
      </button>
      {state?.state === 'failed' && <span className="text-ui-danger">{state.message}</span>}
    </span>
  );
}
