// Per-model SDK options. ⚠ Opus 5.5 400s on disabled thinking, a thinking budget and a forced
// tool_choice, and its API effort default is 'medium' — so it must get an EXPLICIT effort and an
// explicit adaptive-thinking config, and no model may ever be handed a disabled/budgeted one.
// Its effort is no longer PINNED: a run's own effort (Settings → AI → Effort) reaches it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_EFFORTS } from '@pierre-review/shared';
import { sdkModelOptions } from './model-options.js';
import * as modelOptions from './model-options.js';

const saved = { effort: process.env.REVIEW_EFFORT, diff: process.env.REVIEW_DIFF_ONLY_EFFORT };
beforeEach(() => {
  delete process.env.REVIEW_EFFORT;
  delete process.env.REVIEW_DIFF_ONLY_EFFORT;
});
afterEach(() => {
  if (saved.effort === undefined) delete process.env.REVIEW_EFFORT;
  else process.env.REVIEW_EFFORT = saved.effort;
  if (saved.diff === undefined) delete process.env.REVIEW_DIFF_ONLY_EFFORT;
  else process.env.REVIEW_DIFF_ONLY_EFFORT = saved.diff;
});

describe('sdkModelOptions', () => {
  it("Default: Opus 5.5 runs 'medium' on BOTH paths (today's behaviour), plus adaptive thinking", () => {
    for (const mode of ['diff_only', 'worktree'] as const) {
      expect(sdkModelOptions('claude-opus-5-5', mode)).toEqual({
        effort: 'medium',
        thinking: { type: 'adaptive' },
      });
    }
  });

  it('Default: Sonnet 5 gets medium on a worktree run, low diff-only, and no thinking config', () => {
    expect(sdkModelOptions('claude-sonnet-5', 'worktree')).toEqual({ effort: 'medium' });
    expect(sdkModelOptions('claude-sonnet-5', 'diff_only')).toEqual({ effort: 'low' });
  });

  it('the pin is gone: every level reaches Opus 5.5, still with adaptive thinking', () => {
    expect('PINNED_EFFORT' in modelOptions).toBe(false);
    for (const effort of AI_EFFORTS) {
      expect(sdkModelOptions('claude-opus-5-5', 'worktree', effort)).toEqual({
        effort,
        thinking: { type: 'adaptive' },
      });
    }
  });

  it('with no effort from the caller (every kind but the review and AI Fix), no env var moves it', () => {
    // REVIEW_EFFORT / REVIEW_DIFF_ONLY_EFFORT reach only the runs the Settings control reaches
    // (ai/effort.ts agenticRunEffort); a CI review, diagram or chat on Opus stays medium.
    process.env.REVIEW_EFFORT = 'max';
    process.env.REVIEW_DIFF_ONLY_EFFORT = 'low';
    expect(sdkModelOptions('claude-opus-5-5', 'worktree').effort).toBe('medium');
    expect(sdkModelOptions('claude-opus-5-5', 'diff_only').effort).toBe('medium');
    expect(sdkModelOptions('claude-sonnet-5', 'worktree').effort).toBe('medium');
    expect(sdkModelOptions('claude-sonnet-5', 'diff_only').effort).toBe('low');
  });

  it('a model off the offered list gets nothing', () => {
    expect(sdkModelOptions('claude-haiku-4-5', 'worktree')).toEqual({});
    expect(sdkModelOptions('claude-sonnet-4-6', 'diff_only', 'high')).toEqual({});
  });

  it('never hands any model disabled thinking or a thinking budget', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5']) {
      for (const mode of ['diff_only', 'worktree'] as const) {
        for (const effort of [undefined, ...AI_EFFORTS]) {
          const o = sdkModelOptions(m, mode, effort) as Record<string, unknown>;
          expect(JSON.stringify(o)).not.toMatch(/disabled|budget/i);
          expect(o).not.toHaveProperty('maxThinkingTokens');
          expect(o).not.toHaveProperty('toolChoice');
        }
      }
    }
  });
});
