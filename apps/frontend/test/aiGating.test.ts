import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@pierre-review/shared';
import { aiKindsAll } from '@pierre-review/shared';
import {
  AI_AUTH_LINE,
  aiAuthFor,
  aiCapabilitiesOf,
  aiReadyFor,
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
  providerSetting: { value: 'auto', source: 'settings' },
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
      kinds: aiKindsAll({ auth: 'none', message: null }),
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

  it('the first-boot download: `autoInstall` and its step ride through; an older server reads false', () => {
    const ai = aiCapabilitiesOf(
      me({ ...READY, autoInstall: true, runtime: 'installing', runtimeMessage: 'Downloading Claude (about 110 MB).' }),
    );
    expect(ai).toMatchObject({ autoInstall: true, ready: false, runtimeMessage: 'Downloading Claude (about 110 MB).' });
    expect(aiCapabilitiesOf(me(READY)).autoInstall).toBe(false);
    expect(aiCapabilitiesOf(me({ ...READY, enabled: false, autoInstall: true })).autoInstall).toBe(false);
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
    expect(src).toMatch(/aiAuthFor\(ai, kind\)\.message \?\? aiSignInLine\(ai\.provider\)/);
  });
});

describe('the pre-flight PER RUN KIND (`me.ai.kinds`)', () => {
  const NOT_YET = 'Codex cannot run AI Fix in this version of Limn yet.';
  // Codex as active: the top-level answer stays 'none' (not every kind runs), one kind is ported.
  const CODEX: MeResponse['ai'] = {
    ...READY,
    auth: 'none',
    authMessage: 'Codex is not available in this version of Limn yet.',
    provider: 'codex',
    kinds: {
      ...aiKindsAll({ auth: 'none', message: NOT_YET }),
      review: { auth: 'ok', message: null },
      complete: { auth: 'ok', message: null },
    },
  };

  it('a kind Codex runs is ready while the top-level answer is not', () => {
    const ai = aiCapabilitiesOf(me(CODEX));
    expect(ai.ready).toBe(false);
    expect(aiReadyFor(ai, 'review')).toBe(true);
    expect(aiReadyFor(ai, 'complete')).toBe(true);
    expect(aiReadyFor(ai, 'fix')).toBe(false);
    expect(aiAuthFor(ai, 'fix')).toEqual({ auth: 'none', message: NOT_YET });
    // No kind named: the top-level answer and sentence.
    expect(aiAuthFor(ai, undefined)).toEqual({ auth: 'none', message: 'Codex is not available in this version of Limn yet.' });
  });

  it('on Claude every kind repeats the top-level answer; an older server with no map falls back to it', () => {
    const claude = aiCapabilitiesOf(me({ ...READY, kinds: aiKindsAll({ auth: 'ok', message: null }) }));
    expect(aiReadyFor(claude, 'fix')).toBe(true);
    const older = aiCapabilitiesOf(me(READY));
    expect(older.kinds).toEqual({});
    expect(aiAuthFor(older, 'fix')).toEqual({ auth: 'ok', message: null });
    const olderNone = aiCapabilitiesOf(me({ ...READY, auth: 'none', authMessage: 'x' }));
    expect(aiReadyFor(olderNone, 'review')).toBe(false);
    expect(aiAuthFor(olderNone, 'review')).toEqual({ auth: 'none', message: 'x' });
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

  it('every agentic start button sits behind the one gate, naming its run kind', () => {
    // The picker surfaces may run on ANY ready provider (the per-run choice), so their gates say
    // `anyProvider` and name the provider the run goes to (its budget is the one read). ⚠ A FOLLOW-UP
    // (the chat, a plan pass, the build) goes to ONE provider, so its gate says `followUp`, never
    // `anyProvider` — a ready Codex must not offer Ask on a chat that will run on a signed-out Claude.
    expect(read(join(root, 'components', 'ClaudeReviewTab.tsx'))).toMatch(
      /<AiRunGate kind="review" auth=\{data\?\.auth\} anyProvider provider=\{modelPick\.chosen\.provider\}>/,
    );
    expect(read(join(root, 'components', 'AiFixTab.tsx'))).toMatch(
      /<AiRunGate kind="fix" auth=\{data\?\.auth\} anyProvider provider=\{modelPick\.chosen\.provider\}>/,
    );
    expect(read(join(root, 'components', 'ClaudeReviewChat.tsx'))).toMatch(
      /<AiRunGate kind="review_chat" followUp provider=\{chatProvider\}>/,
    );
    const plan = read(join(root, 'components', 'AiFix', 'PlanPanel.tsx'));
    expect(plan).toMatch(/<AiRunGate kind="plan" auth=\{auth\} meter=\{false\} followUp provider=\{passProvider\}>/);
    expect(plan).toMatch(/<AiRunGate kind="fix" auth=\{auth\} followUp provider=\{buildProvider\}>/);
    expect(plan).not.toMatch(/anyProvider/);
  });

  it('no board button starts a run off the top-level `ready`: each asks its own kind', () => {
    // Under Codex the top-level `auth` stays 'none' while `review` / `ticket_review` are 'ok'.
    for (const f of files) {
      expect(read(f), f).not.toMatch(/useAiCapabilities\(\)\.ready\b|\bai\.ready\b/);
    }
    const act = join(root, 'components', 'Activity');
    expect(read(join(act, 'OpenPrsCards.tsx'))).toMatch(/aiReadyFor\(useAiCapabilities\(\), 'ticket_review'\)/);
    expect(read(join(act, 'PendingClaude.tsx'))).toMatch(/aiReadyFor\(useAiCapabilities\(\), 'review'\)/);
    expect(read(join(act, 'ClaudeReviewCell.tsx'))).toMatch(/aiReadyFor\(useAiCapabilities\(\), 'review'\)/);
  });

  it('the plan panel gates each button on what it runs; Discard runs no model and is never gated', () => {
    const src = read(join(root, 'components', 'AiFix', 'PlanPanel.tsx'));
    const planGate = src.slice(src.indexOf('<AiRunGate kind="plan"'), src.indexOf('</AiRunGate>'));
    expect(planGate).toMatch(/Update plan/);
    expect(planGate).not.toMatch(/Approve and build|Discard plan/);
    const fixGate = src.slice(src.indexOf('<AiRunGate kind="fix"'));
    expect(fixGate.slice(0, fixGate.indexOf('</AiRunGate>'))).toMatch(/Approve and build/);
    // Discard sits after every gate has closed.
    expect(src.lastIndexOf('</AiRunGate>')).toBeLessThan(src.lastIndexOf('Discard plan'));
    // AI Fix offers "Plan first" only when the PICKED provider can run a plan.
    const tab = read(join(root, 'components', 'AiFixTab.tsx'));
    expect(tab).toMatch(/const canPlan = aiProviderReadyFor\(me, modelPick\.chosen\.provider, 'plan'\)/);
    expect(tab).toMatch(/const planFirst = planFirstPicked && canPlan/);
    expect(tab).toMatch(/\{canPlan && \(\s*<label/);
  });

  it('every gate names its run kind (a gate with none reads the strictest, "any agent" answer)', () => {
    for (const f of files) {
      for (const m of read(f).matchAll(/<AiRunGate\b[^>]*>/g)) {
        expect(m[0], f).toMatch(/ kind="[a-z_]+"/);
      }
    }
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
      // A one-shot: it runs on any signed-in provider (Codex too).
      expect(s, n).toMatch(/<AiRunGate kind="complete">/);
    }
    for (const [n, kind] of [
      ['PeriodReportsPanel.tsx', 'complete'],
      ['SprintAskPanel.tsx', 'complete'],
      ['DocsView.tsx', 'docs_build'],
      ['DocsChat.tsx', 'docs_chat'],
    ] as const) {
      expect(activity(n), n).toMatch(new RegExp(`<AiRunGate kind="${kind}">`));
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
