// Per-model SDK options. ⚠ Opus 5.5 400s on disabled thinking, a thinking budget and a forced
// tool_choice, and its API effort default is 'medium' — so it must get an EXPLICIT effort and an
// explicit adaptive-thinking config, and no model may ever be handed a disabled/budgeted one.
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sdkModelOptions } from './model-options.js';

describe('sdkModelOptions', () => {
  it('Opus 5.5 gets the per-mode effort EXPLICITLY plus adaptive thinking', () => {
    expect(sdkModelOptions('claude-opus-5-5', 'diff_only')).toEqual({
      effort: config.reviewDiffOnlyEffort,
      thinking: { type: 'adaptive' },
    });
    expect(sdkModelOptions('claude-opus-5-5', 'worktree')).toEqual({
      effort: config.reviewEffort,
      thinking: { type: 'adaptive' },
    });
  });

  it('gives Opus 5.5 exactly the effort Sonnet 5 gets on the same path', () => {
    for (const mode of ['diff_only', 'worktree'] as const) {
      expect(sdkModelOptions('claude-opus-5-5', mode).effort).toBe(
        sdkModelOptions('claude-sonnet-5', mode).effort,
      );
    }
  });

  it('Sonnet 5 / Opus 4.8 / Sonnet 4.6 get effort only', () => {
    for (const m of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6']) {
      expect(sdkModelOptions(m, 'worktree')).toEqual({ effort: config.reviewEffort });
      expect(sdkModelOptions(m, 'diff_only')).toEqual({ effort: config.reviewDiffOnlyEffort });
    }
  });

  it('Haiku gets nothing (it rejects effort)', () => {
    expect(sdkModelOptions('claude-haiku-4-5', 'worktree')).toEqual({});
    expect(sdkModelOptions('claude-haiku-4-5', 'diff_only')).toEqual({});
  });

  it('never hands any model disabled thinking or a thinking budget', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      for (const mode of ['diff_only', 'worktree'] as const) {
        const o = sdkModelOptions(m, mode) as Record<string, unknown>;
        expect(JSON.stringify(o)).not.toMatch(/disabled|budget/i);
        expect(o).not.toHaveProperty('maxThinkingTokens');
        expect(o).not.toHaveProperty('toolChoice');
      }
    }
  });
});
