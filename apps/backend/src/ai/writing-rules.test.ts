import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { REVIEW_WRITING_RULES, WRITING_RULES, withWritingRules, writingStyleFor } from './writing-rules.js';

// THE WRITING RULES ride every model call (ai/writing-rules.ts): appended to the caller's system
// prompt, or sent alone when there was none.
describe('the writing rules', () => {
  it('follow the caller’s system prompt, or stand alone', () => {
    expect(withWritingRules('SYS')).toBe(`SYS\n\n${WRITING_RULES}`);
    expect(withWritingRules(undefined)).toBe(WRITING_RULES);
    expect(withWritingRules('')).toBe(WRITING_RULES);
  });

  it('name ASD-STE100, the sentence limit and brevity, and leave code and formats alone', () => {
    expect(WRITING_RULES).toMatch(/ASD-STE100/);
    expect(WRITING_RULES).toMatch(/maximum of 20 words/);
    expect(WRITING_RULES).toMatch(/Be brief/);
    expect(WRITING_RULES).toMatch(/do not change code/);
  });

  it('are added at both providers’ doors, for every run, completion and image', () => {
    for (const f of ['providers/claude.ts', 'providers/codex.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(src, f).toMatch(/runAgent: \(spec\) => runAgent\(\{ \.\.\.spec, system: withWritingRules\(spec\.system, writingStyleFor\(spec\.kind\)\) \}\)/);
      expect(src, f).toMatch(/complete: \(req\) => complete\(\{ \.\.\.req, system: withWritingRules\(req\.system\) \}\)/);
    }
    const claude = readFileSync(new URL('./providers/claude.ts', import.meta.url), 'utf8');
    expect(claude).toMatch(/describeImage: \(req\) => describeImage\(\{ \.\.\.req, system: withWritingRules\(req\.system\) \}\)/);
  });

  it('reviews get the same technical rules with no length caps, and are told never to cut a finding', () => {
    for (const k of ['review', 'ci_review', 'thread_check', 'review_chat']) expect(writingStyleFor(k), k).toBe('review');
    for (const k of ['ticket_review', 'fix', 'plan', 'diagram', 'sprint_paths', 'docs_chat', undefined]) expect(writingStyleFor(k), String(k)).toBe('brief');
    expect(withWritingRules('SYS', 'review')).toBe(`SYS\n\n${REVIEW_WRITING_RULES}`);
    expect(REVIEW_WRITING_RULES).toMatch(/ASD-STE100/);
    expect(REVIEW_WRITING_RULES).toMatch(/maximum of 20 words/);
    expect(REVIEW_WRITING_RULES).toMatch(/Do not shorten or leave out a finding/);
    expect(REVIEW_WRITING_RULES).not.toMatch(/Be brief|summary has a maximum/);
  });
});
