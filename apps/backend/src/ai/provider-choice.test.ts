// THE PROVIDER CHOICE + RUN LABELS (docs/CODEX-PLAN.md Phase 4), pure — no DB, no model:
//   1. `aiProviderSetting()` is the ONE resolver: an explicitly set LIMN_AI_PROVIDER wins, else the
//      stored Settings choice, else 'auto'; an unknown env value is not an override. The status says
//      who chose it. A switch is read by the NEXT `activeProviderId()` call (no restart).
//   2. `ranOn` / `expectedRanOn` name what runs: the provider and ITS model id for the asked choice.
//   3. `requestModelOf` maps a stored Codex id back to the Claude model of the same depth.
//   4. packages/shared `aiRunLabel` / `aiRunProvider` / `aiModelName` / `aiModelChoiceLabel`.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/ai/provider-choice.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.LIMN_DATA_DIR = (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'limn-provider-choice-test-'),
);
delete process.env.OPENAI_API_KEY;
delete process.env.LIMN_AI_PROVIDER;

vi.mock('./runtime.js', () => ({
  claudeExecutableOptions: () => ({ pathToClaudeCodeExecutable: '/x/claude' }),
  getAiRuntimeStatus: () => ({ runtime: 'ready', runtimeMessage: null }),
  codexBinaryPath: () => null,
  getCodexRuntimeStatus: () => ({ runtime: 'absent', runtimeMessage: null }),
  loadAnthropicSdk: async () => {
    throw new Error('not in this test');
  },
  loadAgentSdk: async () => {
    throw new Error('not in this test');
  },
}));

const P = await import('./provider.js');
const shared = await import('@pierre-review/shared');

afterEach(() => P.setStoredAiProviderSetting(null));

describe('the provider choice: LIMN_AI_PROVIDER, else Settings, else auto', () => {
  it('nothing stored and no env ⇒ auto, chosen in Settings', () => {
    expect(P.aiProviderSetting({})).toBe('auto');
    expect(P.aiProviderSettingStatus({})).toEqual({ value: 'auto', source: 'settings' });
  });

  it('the stored choice is used while the env is unset (or empty, or unknown)', () => {
    P.setStoredAiProviderSetting('codex');
    for (const env of [{}, { LIMN_AI_PROVIDER: '' }, { LIMN_AI_PROVIDER: 'gemini' }]) {
      expect(P.aiProviderSetting(env)).toBe('codex');
      expect(P.aiProviderSettingStatus(env)).toEqual({ value: 'codex', source: 'settings' });
      expect(P.aiProviderEnvSetting(env)).toBeNull();
    }
  });

  it('an explicitly set LIMN_AI_PROVIDER wins over the stored choice, and says so', () => {
    P.setStoredAiProviderSetting('codex');
    expect(P.aiProviderSetting({ LIMN_AI_PROVIDER: 'claude' })).toBe('claude');
    expect(P.aiProviderSettingStatus({ LIMN_AI_PROVIDER: ' Claude ' })).toEqual({ value: 'claude', source: 'env' });
    expect(P.activeProviderId({ LIMN_AI_PROVIDER: 'claude' })).toBe('claude');
  });

  it('a switch reaches the next run at once: activeProviderId reads the stored choice per call', () => {
    expect(P.activeProviderId({})).toBe('claude');
    P.setStoredAiProviderSetting('codex');
    expect(P.activeProviderId({})).toBe('codex');
    expect(P.getActiveProvider({}).id).toBe('codex');
    P.setStoredAiProviderSetting('claude');
    expect(P.activeProviderId({})).toBe('claude');
    // auto with no Codex sign-in stays Claude (the decided rule).
    P.setStoredAiProviderSetting('auto');
    expect(P.activeProviderId({})).toBe('claude');
  });

  it('the "Codex cannot run" sentence names Settings, or the env var when that chose Codex', () => {
    expect(P.CODEX_NOT_AVAILABLE_MESSAGE).toContain('Settings → AI');
    expect(P.CODEX_NOT_AVAILABLE_MESSAGE).not.toContain('Unset LIMN_AI_PROVIDER');
    const prev = process.env.LIMN_AI_PROVIDER;
    process.env.LIMN_AI_PROVIDER = 'codex';
    try {
      expect(P.codexKindNotAvailableMessage('review')).toContain('Set LIMN_AI_PROVIDER to claude');
    } finally {
      if (prev === undefined) delete process.env.LIMN_AI_PROVIDER;
      else process.env.LIMN_AI_PROVIDER = prev;
    }
    expect(P.codexKindNotAvailableMessage('review')).toContain('Choose Claude in Settings → AI.');
  });
});

describe('what a run ran on', () => {
  it('ranOn names the provider and ITS model for the asked Claude model', () => {
    const opus = P.claudeModelChoice('claude-opus-5-5');
    expect(P.ranOn(P.getProvider('claude'), opus)).toEqual({ provider: 'claude', model: 'claude-opus-5-5' });
    expect(P.ranOn(P.getProvider('codex'), opus)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
    expect(P.ranOn(P.getProvider('codex'), P.claudeModelChoice('claude-sonnet-5'))).toEqual({
      provider: 'codex',
      model: 'gpt-6.1-terra',
    });
  });

  it('expectedRanOn follows the active provider', () => {
    const opus = P.claudeModelChoice('claude-opus-5-5');
    expect(P.expectedRanOn(opus, {})).toEqual({ provider: 'claude', model: 'claude-opus-5-5' });
    P.setStoredAiProviderSetting('codex');
    expect(P.expectedRanOn(opus, {})).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
  });

  it('requestModelOf maps a stored Codex id back to the same depth, and keeps every other id', () => {
    expect(P.requestModelOf('gpt-6.1-sol')).toBe('claude-opus-5-5');
    expect(P.requestModelOf('gpt-6.1-terra')).toBe('claude-sonnet-5');
    expect(P.requestModelOf('gpt-6-luna')).toBe('claude-haiku-5-5');
    expect(P.requestModelOf('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(P.requestModelOf('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(P.requestModelOf('something-else')).toBe('something-else');
  });

  it('the role table is the shared one (one spelling for both halves)', async () => {
    const { CLAUDE_MODEL_FOR_ROLE } = await import('./providers/claude.js');
    expect(CLAUDE_MODEL_FOR_ROLE).toEqual(shared.AI_MODEL_FOR_ROLE.claude);
    expect(P.CODEX_MODEL_FOR_ROLE).toEqual(shared.AI_MODEL_FOR_ROLE.codex);
  });
});

describe('the run label (packages/shared)', () => {
  it('names the provider and the model that ran', () => {
    expect(shared.aiRunLabel('claude', 'claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(shared.aiRunLabel('claude', 'claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(shared.aiRunLabel('claude', 'claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(shared.aiRunLabel('codex', 'gpt-6.1-sol')).toBe('Codex · GPT-6.1 Sol');
    expect(shared.aiRunLabel('codex', 'gpt-6.1-terra')).toBe('Codex · GPT-6.1 Terra');
    expect(shared.aiRunLabel('codex', 'gpt-6-luna')).toBe('Codex · GPT-6 Luna');
  });

  it('an older row (NULL provider) is Claude, unless its model is a Codex id', () => {
    expect(shared.aiRunProvider(null, 'claude-opus-5-5')).toBe('claude');
    expect(shared.aiRunProvider(null, 'opus')).toBe('claude');
    expect(shared.aiRunProvider(undefined, 'gpt-6.1-sol')).toBe('codex');
    expect(shared.aiRunLabel(null, 'gpt-6.1-sol')).toBe('Codex · GPT-6.1 Sol');
    expect(shared.aiRunLabel(null, 'opus')).toBe('Claude Opus');
    // The stored provider beats the model id.
    expect(shared.aiRunProvider('claude', 'gpt-6.1-sol')).toBe('claude');
  });

  it('a retired or unknown id still names itself, never twice "Claude"', () => {
    expect(shared.aiRunLabel('claude', 'claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(shared.aiRunLabel('claude', 'claude-3-5-sonnet-20240620')).toBe('claude-3-5-sonnet-20240620');
    expect(shared.aiRunLabel('codex', 'mystery')).toBe('Codex · mystery');
    expect(shared.aiRunLabel('codex', null)).toBe('Codex');
  });

  it('a model picker names what will run on the chosen provider', () => {
    expect(shared.aiModelChoiceLabel('claude-opus-5-5', 'claude')).toBe(shared.CLAUDE_REVIEW_MODEL_LABELS['claude-opus-5-5']);
    expect(shared.aiModelChoiceLabel('claude-opus-5-5', 'codex')).toBe('Codex · GPT-6.1 Sol (most thorough)');
    expect(shared.aiModelChoiceLabel('claude-sonnet-5', 'codex')).toBe('Codex · GPT-6.1 Terra (best value)');
    expect(shared.aiModelChoiceLabel('claude-sonnet-5', undefined)).toBe(shared.CLAUDE_REVIEW_MODEL_LABELS['claude-sonnet-5']);
  });

  it('the setting values are checked', () => {
    expect(shared.AI_PROVIDER_SETTINGS).toEqual(['auto', 'claude', 'codex']);
    expect(shared.isAiProviderSetting('codex')).toBe(true);
    expect(shared.isAiProviderSetting('gemini')).toBe(false);
    expect(shared.isAiProviderSetting(null)).toBe(false);
  });
});
