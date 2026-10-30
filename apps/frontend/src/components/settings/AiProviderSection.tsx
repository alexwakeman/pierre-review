import {
  AI_EFFORT_LABELS,
  AI_EFFORTS,
  AI_PROVIDER_SETTINGS,
  aiProviderName,
  isAiEffort,
  type AiEffortSettingStatus,
  type AiClaudeProviderStatus,
  type AiCodexProviderStatus,
  type AiProviderSetting,
  type CodexLoginResponse,
} from '@pierre-review/shared';
import { useMe } from '../../hooks/useTriage.js';
import { useAiRuntimeInstall } from '../../hooks/useAiCapabilities.js';
import { useCodexLogin, useCodexLoginActions, useSetAiEffort, useSetAiProvider } from '../../hooks/useAiProvider.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { chatGptPlanLabel } from '../../lib/aiBudget.js';
import { InfoButton } from '../InfoModal.js';
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
// EFFORT (PUT /api/ai/effort, read back as `ai.effortSetting`): one level for AI Review and AI Fix on
// both providers (packages/shared ai-effort.ts). "Default" (null) is each provider's own depth; an
// explicitly set REVIEW_EFFORT wins and the control shows it, disabled.

const BTN =
  'inline-flex h-7 items-center gap-1 rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50';
const MUTED = 'text-ui-mute';

const CHOICE_LABEL: Record<AiProviderSetting, string> = {
  auto: 'Auto',
  claude: 'Claude',
  codex: 'Codex',
};

function claudeLine(c: AiClaudeProviderStatus): string {
  if (c.route === 'login') return 'Signed in to Claude Code.';
  if (c.route === 'api_key') return 'Using ANTHROPIC_API_KEY.';
  return c.message ?? 'Sign in to Claude Code or set ANTHROPIC_API_KEY.';
}

function codexLine(c: AiCodexProviderStatus): string {
  if (c.runtime === 'installing') return 'Setting up Codex…';
  if (c.runtime !== 'ready') return c.runtimeMessage ?? 'Not set up.';
  if (c.auth === 'ok') return c.plan ? `Signed in with ${chatGptPlanLabel(c.plan)}.` : 'Signed in with ChatGPT.';
  return c.message ?? 'Not signed in.';
}

export function AiProviderSection(): JSX.Element | null {
  const me = useMe().data;
  const ai = me?.ai;
  const set = useSetAiProvider();
  const install = useAiRuntimeInstall();
  const codexReady = ai?.providers.codex.runtime === 'ready';
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
        A change applies to the next run. A run already going finishes on the provider it started on, and every run
        keeps the name of the provider and model that ran it.
      </p>
      <p className="mt-2">
        Codex signs in with your ChatGPT account, in Limn’s own folder (~/.limn/codex). Your own ~/.codex is not used,
        and neither is an OPENAI_API_KEY.
      </p>
    </InfoButton>
  );

  if (ai == null || !ai.enabled) return null;
  const setting = ai.providerSetting ?? { value: 'auto' as const, source: 'settings' as const };
  const fromEnv = setting.source === 'env';
  const chosen = set.isPending && set.variables != null ? set.variables : setting.value;

  return (
    <SectionShell title="AI" info={info} desc={`Default: ${aiProviderName(ai.provider)}.`}>
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
      {fromEnv && <p className={`text-body ${MUTED}`}>Set by LIMN_AI_PROVIDER.</p>}
      {set.isError && <p className="text-body text-ui-danger">{set.error.message}</p>}

      <EffortControl setting={ai.effortSetting ?? { value: null, source: 'settings' }} />

      <dl className="space-y-1.5 text-body">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="w-14 shrink-0 font-medium text-ui-ink">Claude</dt>
          <dd className={MUTED}>{claudeLine(ai.providers.claude)}</dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="w-14 shrink-0 font-medium text-ui-ink">Codex</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className={MUTED}>{codexLine(ai.providers.codex)}</span>
            {!codexReady && ai.providers.codex.runtime !== 'installing' && (
              <button
                type="button"
                className={BTN}
                disabled={install.state.phase === 'running'}
                onClick={() => install.start('codex')}
              >
                {install.state.phase === 'running' ? 'Setting up Codex…' : 'Set up Codex'}
              </button>
            )}
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
      {install.state.phase === 'failed' && install.state.message && (
        <p className="text-body text-ui-danger">{install.state.message}</p>
      )}
      <p className={`text-body ${MUTED}`}>Codex signs in with ChatGPT only. An OPENAI_API_KEY is not used.</p>
    </SectionShell>
  );
}

/** Settings → AI → Effort: Default, then the five levels both providers accept. */
function EffortControl({ setting }: { setting: AiEffortSettingStatus }): JSX.Element {
  const set = useSetAiEffort();
  const fromEnv = setting.source === 'env';
  const chosen = set.isPending && set.variables !== undefined ? set.variables : setting.value;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-body">
        <label htmlFor="ai-effort" className="text-ui-ink">
          Effort for AI Review and AI Fix:
        </label>
        <Select
          id="ai-effort"
          name="ai-effort"
          value={chosen ?? 'default'}
          disabled={fromEnv || set.isPending}
          onChange={(v) => set.mutate(isAiEffort(v) ? v : null)}
          options={EFFORT_OPTIONS}
          size="sm"
        />
        <InfoButton title="Effort">
          <p>Higher effort reads more and finds more, and uses more of your plan or costs more.</p>
          <p className="mt-2">
            It applies to AI Review and AI Fix on Claude and Codex. Default runs Claude at medium and Codex at high on its
            most thorough model. A review of a small change from its diff alone can run one level lower, but
            never below Default unless you pick a lower level.
          </p>
          <p className="mt-2">
            A review has no step limit unless REVIEW_MAX_TURNS is set. Each run shows the effort it used beside its model.
          </p>
        </InfoButton>
      </div>
      {fromEnv && <p className={`text-body ${MUTED}`}>Set by REVIEW_EFFORT.</p>}
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
          <a href={authUrl} target="_blank" rel="noreferrer" className="hit text-ui-accent underline">
            Open the ChatGPT sign-in
          </a>
        )}
        {verificationUrl != null && (
          <span className={MUTED}>
            Go to{' '}
            <a href={verificationUrl} target="_blank" rel="noreferrer" className="hit text-ui-accent underline">
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
