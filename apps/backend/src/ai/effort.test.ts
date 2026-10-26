// THE EFFORT SETTING (ai/effort.ts; packages/shared ai-effort.ts), pure — no DB, no model:
//   1. the map per provider: a chosen level is sent as the SAME word to Claude and Codex, on a worktree
//      run; a diff-only run one step lower (never below low); REVIEW_DIFF_ONLY_EFFORT decides diff-only;
//   2. Default (nothing chosen) is today's behaviour: Claude medium (diff-only medium on Opus, low on
//      Sonnet), Codex by depth (deep high, standard medium, fast low), one step lower diff-only;
//   3. precedence: REVIEW_EFFORT beats the stored level, and the status says who chose;
//   4. turn caps: High / Extra high / Max raise the review cap (30 → 45 / 60 / 75) unless it is pinned;
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
  effortTurnCap,
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

  it('a diff-only review runs one step lower on both, never below low', () => {
    const lower: Record<AiEffort, AiEffort> = { low: 'low', medium: 'low', high: 'medium', xhigh: 'high', max: 'xhigh' };
    for (const level of AI_EFFORTS) {
      setStoredAiEffort(level);
      expect(agenticRunEffort('claude', { role: 'deep' }, 'diff_only', NO_ENV)).toBe(lower[level]);
      expect(agenticRunEffort('codex', { role: 'deep' }, 'diff_only', NO_ENV)).toBe(lower[level]);
    }
  });

  it('REVIEW_DIFF_ONLY_EFFORT decides every diff-only run when set', () => {
    setStoredAiEffort('max');
    const env = { REVIEW_DIFF_ONLY_EFFORT: 'medium' } as NodeJS.ProcessEnv;
    expect(agenticRunEffort('claude', { role: 'deep' }, 'diff_only', env)).toBe('medium');
    expect(agenticRunEffort('codex', { role: 'deep' }, 'diff_only', env)).toBe('medium');
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
    expect(defaultRunEffort('codex', 'fast', 'worktree', NO_ENV)).toBe('low');
    expect(defaultRunEffort('codex', 'fast', 'diff_only', NO_ENV)).toBe('low');
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

describe('turn caps', () => {
  it('High / Extra high / Max raise the review cap; Default, Low and Medium keep it', () => {
    expect(effortTurnCap(30, null, false)).toBe(30);
    expect(effortTurnCap(30, 'low', false)).toBe(30);
    expect(effortTurnCap(30, 'medium', false)).toBe(30);
    expect(effortTurnCap(30, 'high', false)).toBe(45);
    expect(effortTurnCap(30, 'xhigh', false)).toBe(60);
    expect(effortTurnCap(30, 'max', false)).toBe(75);
  });

  it('a cap set in the environment (REVIEW_MAX_TURNS) always wins', () => {
    expect(effortTurnCap(30, 'max', true)).toBe(30);
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
