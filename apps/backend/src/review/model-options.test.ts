// Per-model SDK options. ⚠ Opus 5.5 400s on disabled thinking, a thinking budget and a forced
// tool_choice, and its API effort default is 'medium' — so it must get an EXPLICIT effort and an
// explicit adaptive-thinking config, and no model may ever be handed a disabled/budgeted one.
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sdkModelOptions } from './model-options.js';

describe('sdkModelOptions', () => {
  it("Opus 5.5 is pinned to 'medium' on BOTH paths, plus adaptive thinking", () => {
    for (const mode of ['diff_only', 'worktree'] as const) {
      expect(sdkModelOptions('claude-opus-5-5', mode)).toEqual({
        effort: 'medium',
        thinking: { type: 'adaptive' },
      });
    }
  });

  it('Sonnet 5 gets effort only', () => {
    expect(sdkModelOptions('claude-sonnet-5', 'worktree')).toEqual({ effort: config.reviewEffort });
    expect(sdkModelOptions('claude-sonnet-5', 'diff_only')).toEqual({ effort: config.reviewDiffOnlyEffort });
  });

  it('a model off the offered list gets nothing', () => {
    expect(sdkModelOptions('claude-haiku-4-5', 'worktree')).toEqual({});
    expect(sdkModelOptions('claude-sonnet-4-6', 'diff_only')).toEqual({});
  });

  it('never hands any model disabled thinking or a thinking budget', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5']) {
      for (const mode of ['diff_only', 'worktree'] as const) {
        const o = sdkModelOptions(m, mode) as Record<string, unknown>;
        expect(JSON.stringify(o)).not.toMatch(/disabled|budget/i);
        expect(o).not.toHaveProperty('maxThinkingTokens');
        expect(o).not.toHaveProperty('toolChoice');
      }
    }
  });
});
