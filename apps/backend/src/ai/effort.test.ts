// THE EFFORT SETTING (ai/effort.ts; packages/shared ai-effort.ts), pure — no DB, no model:
//   1. the map per provider: a chosen level is sent as the SAME word to Claude and Codex, on a worktree
//      run; a diff-only run one step lower, never below Default's (unless the level is lower still);
//      REVIEW_DIFF_ONLY_EFFORT decides every diff-only review, on both providers, at Default too;
//   2. Default (nothing chosen) is today's behaviour: Claude medium (diff-only medium on Opus, low on
//      Sonnet), Codex by depth (deep high, standard medium, fast low), one step lower diff-only;
//   3. precedence: REVIEW_EFFORT beats the stored level, and the status says who chose;
//   4. (turn caps: removed — a worktree review has no turn limit unless REVIEW_MAX_TURNS is set);
//   5. the run label adds the effort the run stored.
import { afterEach, describe, expect, it } from 'vitest';
import {
  AI_EFFORTS,
  aiEffortWord,
  aiRunLabel,
  isAiEffort,
  stepDownEffort,
  type AiEffort,
} from '@pierre-review/shared';
import {
  agenticRunEffort,
  aiEffortSettingStatus,
  chosenAiEffort,
  defaultRunEffort,
  diffOnlyEffortAt,
  setStoredAiEffort,
} from './effort.js';

afterEach(() => setStoredAiEffort(null));

const NO_ENV = {} as NodeJS.ProcessEnv;

describe('the levels', () => {
  it('are the five words both providers accept, lowest first', () => {
    expect(AI_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(isAiEffort('ultra')).toBe(false); // Codex-only: not offered
    expect(isAiEffort('minimal')).toBe(false); // below Claude's floor: not offered
    expect(isAiEffort('none')).toBe(false);
    expect(stepDownEffort('low')).toBe('low');
    expect(stepDownEffort('high')).toBe('medium');
    expect(stepDownEffort('max')).toBe('xhigh');
  });
});

describe('the map per provider (a chosen level)', () => {
  it('sends the same word to Claude and Codex, at every depth, on a worktree run', () => {
    for (const level of AI_EFFORTS) {
      setStoredAiEffort(level);
      for (const role of ['deep', 'standard'] as const) {
        expect(agenticRunEffort('claude', { role }, 'worktree', NO_ENV)).toBe(level);
        expect(agenticRunEffort('codex', { role }, 'worktree', NO_ENV)).toBe(level);
      }
    }
  });

  it('a diff-only review runs one step lower, never below what Default runs it at (or the level, when lower)', () => {
    // Default diff-only: Opus (Claude deep) medium, Sonnet (Claude standard) low, Codex deep medium,
    // Codex standard low.
    const claudeDeep: Record<AiEffort, AiEffort> = { low: 'low', medium: 'medium', high: 'medium', xhigh: 'high', max: 'xhigh' };
    const claudeStd: Record<AiEffort, AiEffort> = { low: 'low', medium: 'low', high: 'medium', xhigh: 'high', max: 'xhigh' };
    for (const level of AI_EFFORTS) {
      setStoredAiEffort(level);
      expect(agenticRunEffort('claude', { role: 'deep' }, 'diff_only', NO_ENV)).toBe(claudeDeep[level]);
      expect(agenticRunEffort('claude', { role: 'standard' }, 'diff_only', NO_ENV)).toBe(claudeStd[level]);
      expect(agenticRunEffort('codex', { role: 'deep' }, 'diff_only', NO_ENV)).toBe(claudeDeep[level]);
      expect(agenticRunEffort('codex', { role: 'standard' }, 'diff_only', NO_ENV)).toBe(claudeStd[level]);
    }
  });

  it('picking Medium never runs an Opus quick review below Default (the finding: it used to drop to low)', () => {
    const atDefault = agenticRunEffort('claude', { role: 'deep' }, 'diff_only', NO_ENV);
    setStoredAiEffort('medium');
    expect(agenticRunEffort('claude', { role: 'deep' }, 'diff_only', NO_ENV)).toBe(atDefault);
    expect(atDefault).toBe('medium');
  });

  it('diffOnlyEffortAt: never above the level, never below min(level, Default)', () => {
    for (const level of AI_EFFORTS) {
      for (const atDefault of AI_EFFORTS) {
        const got = AI_EFFORTS.indexOf(diffOnlyEffortAt(level, atDefault));
        expect(got).toBeLessThanOrEqual(AI_EFFORTS.indexOf(level));
        expect(got).toBeGreaterThanOrEqual(Math.min(AI_EFFORTS.indexOf(level), AI_EFFORTS.indexOf(atDefault)));
        expect(got).toBeGreaterThanOrEqual(AI_EFFORTS.indexOf(stepDownEffort(level)));
      }
    }
  });

  it('REVIEW_DIFF_ONLY_EFFORT decides every diff-only review when set, on both providers, at Default too', () => {
    const env = { REVIEW_DIFF_ONLY_EFFORT: 'low' } as NodeJS.ProcessEnv;
    for (const level of [null, 'medium', 'high', 'max'] as const) {
      setStoredAiEffort(level);
      for (const provider of ['claude', 'codex'] as const) {
        for (const role of ['deep', 'standard'] as const) {
          expect(agenticRunEffort(provider, { role }, 'diff_only', env)).toBe('low');
        }
      }
    }
    setStoredAiEffort('max');
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', env)).toBe('max');
  });
});

describe('Default (nothing chosen) is today', () => {
  it('Claude: worktree medium; diff-only medium on Opus (the old pin), low on Sonnet', () => {
    expect(chosenAiEffort(NO_ENV)).toBeNull();
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', NO_ENV)).toBe('medium');
    expect(agenticRunEffort('claude', { role: 'deep' }, 'diff_only', NO_ENV)).toBe('medium');
    expect(agenticRunEffort('claude', { role: 'standard' }, 'worktree', NO_ENV)).toBe('medium');
    expect(agenticRunEffort('claude', { role: 'standard' }, 'diff_only', NO_ENV)).toBe('low');
  });

  it('Codex: deep high, standard medium, fast low; one step lower diff-only', () => {
    expect(agenticRunEffort('codex', { role: 'deep' }, 'worktree', NO_ENV)).toBe('high');
    expect(agenticRunEffort('codex', { role: 'deep' }, 'diff_only', NO_ENV)).toBe('medium');
    expect(agenticRunEffort('codex', { role: 'standard' }, 'worktree', NO_ENV)).toBe('medium');
    expect(agenticRunEffort('codex', { role: 'standard' }, 'diff_only', NO_ENV)).toBe('low');
    expect(defaultRunEffort('codex', 'fast', 'worktree')).toBe('low');
    expect(defaultRunEffort('codex', 'fast', 'diff_only')).toBe('low');
  });
});

describe('precedence', () => {
  it('REVIEW_EFFORT beats the stored level and locks the control', () => {
    setStoredAiEffort('low');
    const env = { REVIEW_EFFORT: 'high' } as NodeJS.ProcessEnv;
    expect(chosenAiEffort(env)).toBe('high');
    expect(aiEffortSettingStatus(env)).toEqual({ value: 'high', source: 'env' });
    expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree', env)).toBe('high');
    expect(agenticRunEffort('codex', { role: 'deep' }, 'worktree', env)).toBe('high');
  });

  it('an unknown REVIEW_EFFORT is ignored; the stored level (or Default) stands', () => {
    const env = { REVIEW_EFFORT: 'ultra' } as NodeJS.ProcessEnv;
    expect(aiEffortSettingStatus(env)).toEqual({ value: null, source: 'settings' });
    setStoredAiEffort('xhigh');
    expect(aiEffortSettingStatus(env)).toEqual({ value: 'xhigh', source: 'settings' });
    expect(agenticRunEffort('codex', { role: 'deep' }, 'worktree', env)).toBe('xhigh');
  });
});

describe('the environment reaches only what the control reaches', () => {
  it('defaultRunEffort (every other kind) reads no environment: Opus stays medium under REVIEW_EFFORT=max', () => {
    const saved = { e: process.env.REVIEW_EFFORT, d: process.env.REVIEW_DIFF_ONLY_EFFORT };
    process.env.REVIEW_EFFORT = 'max';
    process.env.REVIEW_DIFF_ONLY_EFFORT = 'low';
    try {
      expect(defaultRunEffort('claude', 'deep', 'worktree')).toBe('medium');
      expect(defaultRunEffort('claude', 'deep', 'diff_only')).toBe('medium');
      expect(defaultRunEffort('claude', 'standard', 'worktree')).toBe('medium');
      expect(defaultRunEffort('codex', 'deep', 'worktree')).toBe('high');
      // …while the review / AI Fix (agenticRunEffort) obeys both.
      expect(agenticRunEffort('claude', { role: 'deep' }, 'worktree')).toBe('max');
      expect(agenticRunEffort('codex', { role: 'deep' }, 'diff_only')).toBe('low');
    } finally {
      if (saved.e === undefined) delete process.env.REVIEW_EFFORT;
      else process.env.REVIEW_EFFORT = saved.e;
      if (saved.d === undefined) delete process.env.REVIEW_DIFF_ONLY_EFFORT;
      else process.env.REVIEW_DIFF_ONLY_EFFORT = saved.d;
    }
  });
});

describe('the run label', () => {
  it('adds the effort the run stored, in plain words', () => {
    expect(aiRunLabel('claude', 'claude-opus-5-5', 'high')).toBe('Claude Opus 5.5 · high');
    expect(aiRunLabel('codex', 'gpt-6-astra', 'xhigh')).toBe('Codex · GPT-6 Astra · extra high');
    expect(aiEffortWord('max')).toBe('max');
  });

  it('an older run (no effort) or an unknown word reads as before', () => {
    expect(aiRunLabel('claude', 'claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(aiRunLabel('claude', 'claude-opus-5-5', null)).toBe('Claude Opus 5.5');
    expect(aiRunLabel('codex', 'gpt-6-astra', 'ultra')).toBe('Codex · GPT-6 Astra');
  });
});
