import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@pierre-review/shared';
import {
  AI_AUTH_LINE,
  aiCapabilitiesOf,
} from '../src/lib/aiCapabilities.js';
import { formatUsd } from '../src/lib/ui.js';

// The agentic AI surfaces (Claude Review, review chat, AI Fix) gate on the TOP-LEVEL `me.ai`.

function me(ai: MeResponse['ai'] | undefined): MeResponse {
  return { ai } as unknown as MeResponse;
}

const READY: MeResponse['ai'] = {
  enabled: true,
  runtime: 'ready',
  runtimeMessage: null,
  auth: 'ok',
  authMessage: null,
  provider: 'claude',
  providers: {
    claude: { auth: 'ok', route: 'login', message: null },
    codex: {
      runtime: 'absent',
      runtimeMessage: null,
      auth: 'none',
      route: 'none',
      signedIn: false,
      plan: null,
      available: false,
      message: null,
    },
  },
};

describe('aiCapabilitiesOf', () => {
  it('set up and signed in ⇒ visible and ready', () => {
    const ai = aiCapabilitiesOf(me(READY));
    expect(ai).toMatchObject({ enabled: true, ready: true });
  });

  it('a missing runtime or credential keeps the surface VISIBLE, only not ready', () => {
    expect(aiCapabilitiesOf(me({ ...READY, runtime: 'absent' }))).toMatchObject({
      enabled: true,
      ready: false,
    });
    expect(aiCapabilitiesOf(me({ ...READY, auth: 'none' }))).toMatchObject({
      enabled: true,
      ready: false,
    });
  });

  it('the kill switch ⇒ off (nothing renders)', () => {
    const ai = aiCapabilitiesOf(me({ ...READY, enabled: false }));
    expect(ai).toMatchObject({ enabled: false, ready: false });
  });

  it('no /api/me yet, or an older server with no `ai` block ⇒ off', () => {
    expect(aiCapabilitiesOf(undefined).enabled).toBe(false);
    expect(aiCapabilitiesOf(me(undefined)).enabled).toBe(false);
  });

  it('the copy is the owner-approved wording', () => {
    expect(AI_AUTH_LINE).toBe('Sign in to Claude Code or set ANTHROPIC_API_KEY');
  });

  it("the auth line prints the server's own sentence when it sent one (e.g. Codex not available yet)", () => {
    const src = readFileSync(new URL('../src/components/AiSetup.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/ai\.authMessage \?\? AI_AUTH_LINE/);
  });
});

describe('formatUsd (local agent runs show money, never credits)', () => {
  it('rounds to cents and never prints a bare zero for a real spend', () => {
    expect(formatUsd(1.234)).toBe('US$1.23');
    expect(formatUsd(0)).toBe('US$0.00');
    expect(formatUsd(0.004)).toBe('under US$0.01');
  });
});

describe('the wiring', () => {
  const root = join(__dirname, '..', 'src');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk(root);
  const read = (p: string): string => readFileSync(p, 'utf8');

  it('no SPA file gates on a paid capability, a lock pane or the AI-credit meter', () => {
    // Nothing in Limn is paid: no capability read, no `me.pro`, no lock pane, no usage meter.
    for (const f of files) {
      const s = read(f);
      expect(s, f).not.toMatch(
        /useProCapabilities|useProGateState|ProLockPanel|ProBadge|ProGate\.js|useAiUsage|TrackUsage/,
      );
      expect(s, f).not.toMatch(/\.data\?\.pro\b|\bme\??\.pro\b/);
    }
  });

  it('no copy tells the reader to set a retired flag', () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/ENABLE_CLAUDE_REVIEW|PRO_ADVANCED_AI_ENABLED/);
    }
  });

  it('the Claude Review tab words a run’s cost through the ONE formatter, never credits', () => {
    // US$ on an API key, the share of the week on a subscription (lib/aiBudget.ts `runCostText`).
    const tab = read(join(root, 'components', 'ClaudeReviewTab.tsx'));
    expect(tab).not.toMatch(/usdToCredits/);
    expect(tab).toMatch(/useRunCostText\(/);
    expect(tab).not.toMatch(/formatUsd\(/);
  });

  it('every agentic start button sits behind the one gate', () => {
    expect(read(join(root, 'components', 'ClaudeReviewTab.tsx'))).toMatch(/<AiRunGate auth=\{data\?\.auth\}>/);
    expect(read(join(root, 'components', 'AiFixTab.tsx'))).toMatch(/<AiRunGate auth=\{data\?\.auth\}>/);
    expect(read(join(root, 'components', 'ClaudeReviewChat.tsx'))).toMatch(/<AiRunGate>/);
  });

  it('every one-shot AI surface shows only while AI is on and runs behind the one gate', () => {
    // Themes, synthesis cards, Chronology pointers, the period-report write-up, the impact note,
    // the work-plan narration, sprint Ask Claude and the docs: one visibility rule (`me.ai.enabled`)
    // and one Run-button swap (AiRunGate), the same as the agentic surfaces.
    const activity = (n: string): string => read(join(root, 'components', 'Activity', n));
    for (const n of [
      'BotThemesPanel.tsx',
      'SynthesisCard.tsx',
      'FlowPointersPanel.tsx',
      'BlastImpactNote.tsx',
      'AttentionView.tsx',
    ]) {
      const s = activity(n);
      expect(s, n).toMatch(/useAiCapabilities\(\)\.enabled/);
      expect(s, n).toMatch(/<AiRunGate>/);
    }
    for (const n of ['PeriodReportsPanel.tsx', 'SprintAskPanel.tsx', 'DocsView.tsx', 'DocsChat.tsx']) {
      expect(activity(n), n).toMatch(/<AiRunGate>/);
    }
    expect(read(join(root, 'components', 'Activity', 'BotsView.tsx'))).toMatch(
      /showThemes = useAiCapabilities\(\)\.enabled/,
    );
  });

  it('the AI copy names both credentials', () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/own Claude Code or Anthropic API key/);
    }
  });

  it('the CI-failure card is gone: Claude Review owns why CI failed', () => {
    expect(existsSync(join(root, 'components', 'CiAnalysisCard.tsx'))).toBe(false);
    expect(read(join(root, 'components', 'ChecksTab.tsx'))).not.toMatch(/CiAnalysisCard/);
  });
});
