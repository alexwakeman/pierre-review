import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@pierre-review/shared';
import {
  AI_AUTH_LINE,
  AI_CLOUD_NOTE,
  aiCapabilitiesOf,
} from '../src/lib/aiCapabilities.js';
import { formatUsd } from '../src/lib/ui.js';

// The agentic AI surfaces (Claude Review, review chat, review memory, AI Fix) are FREE and
// local-only. They gate on the TOP-LEVEL `me.ai`, never on a Pro capability.

function me(ai: MeResponse['ai'] | undefined, deploymentMode: 'local' | 'cloud' = 'local'): MeResponse {
  return { deploymentMode, ai } as unknown as MeResponse;
}

const READY: MeResponse['ai'] = {
  enabled: true,
  runtime: 'ready',
  runtimeMessage: null,
  auth: 'ok',
  authMessage: null,
};

describe('aiCapabilitiesOf', () => {
  it('local, set up and signed in ⇒ visible and ready', () => {
    const ai = aiCapabilitiesOf(me(READY));
    expect(ai).toMatchObject({ enabled: true, cloud: false, ready: true });
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

  it('cloud ⇒ off, and flagged so the "runs on your machine" line shows', () => {
    const ai = aiCapabilitiesOf(me({ ...READY, enabled: false }, 'cloud'));
    expect(ai).toMatchObject({ enabled: false, cloud: true, ready: false });
  });

  it('a local kill switch ⇒ off and NOT cloud (nothing renders)', () => {
    const ai = aiCapabilitiesOf(me({ ...READY, enabled: false }));
    expect(ai).toMatchObject({ enabled: false, cloud: false });
  });

  it('no /api/me yet, or an older server with no `ai` block ⇒ off', () => {
    expect(aiCapabilitiesOf(undefined).enabled).toBe(false);
    expect(aiCapabilitiesOf(me(undefined)).enabled).toBe(false);
  });

  it('the copy is the owner-approved wording', () => {
    expect(AI_AUTH_LINE).toBe('Sign in to Claude Code or set ANTHROPIC_API_KEY');
    expect(AI_CLOUD_NOTE).toBe('Review and fix run on your machine: npx limn-review');
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

  it('no SPA file reads an agentic flag off the Pro capabilities', () => {
    for (const f of files) {
      const s = read(f);
      expect(s, f).not.toMatch(/useProCapabilities\(\)\.(aiFix|claudeReview|aiAnalysis|reviewMemory)\b/);
      expect(s, f).not.toMatch(
        /const \{[^}]*\b(aiFix|claudeReview|aiAnalysis|reviewMemory)\b[^}]*\} = useProCapabilities\(\)/,
      );
      expect(s, f).not.toMatch(/caps\.(aiFix|claudeReview|aiAnalysis|reviewMemory)\b/);
    }
  });

  it('no copy tells the reader to set a retired flag', () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/ENABLE_CLAUDE_REVIEW|PRO_ADVANCED_AI_ENABLED/);
    }
  });

  it('the Claude Review tab prints money, not credits', () => {
    const tab = read(join(root, 'components', 'ClaudeReviewTab.tsx'));
    expect(tab).not.toMatch(/usdToCredits/);
    expect(tab).toMatch(/formatUsd\(/);
  });

  it('every agentic start button sits behind the one gate', () => {
    expect(read(join(root, 'components', 'ClaudeReviewTab.tsx'))).toMatch(/<AiRunGate auth=\{data\?\.auth\}>/);
    expect(read(join(root, 'components', 'AiFixTab.tsx'))).toMatch(/<AiRunGate auth=\{data\?\.auth\}>/);
    expect(read(join(root, 'components', 'ClaudeReviewChat.tsx'))).toMatch(/<AiRunGate>/);
  });

  it('the Pro CI-failure card is gone: Claude Review owns why CI failed', () => {
    expect(existsSync(join(root, 'components', 'CiAnalysisCard.tsx'))).toBe(false);
    expect(read(join(root, 'components', 'ChecksTab.tsx'))).not.toMatch(/CiAnalysisCard/);
  });
});
