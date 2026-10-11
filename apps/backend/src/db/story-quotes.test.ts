// shared story-rules.ts — the rule vocabulary and quote verification (pure).
import { describe, expect, it } from 'vitest';
import {
  STORY_CRITERION_RULE_IDS,
  STORY_ISSUE_IDS,
  STORY_QUOTE_MAX,
  STORY_RULES,
  STORY_RULE_BY_ID,
  STORY_SPEC_GAP_RULE,
  STORY_SPEC_GAP_TYPES,
  isModelStoryRule,
  storyBlockerRule,
  storyRulesOf,
  verifyStoryQuote,
} from '@pierre-review/shared';

describe('the rule vocabulary', () => {
  it('every rule belongs to one of the three issues, with a label and a one-line hover', () => {
    expect(new Set(STORY_RULES.map((r) => r.id)).size).toBe(STORY_RULES.length);
    for (const r of STORY_RULES) {
      expect(STORY_ISSUE_IDS).toContain(r.issue);
      expect(r.label.trim()).not.toBe('');
      expect(r.hover).not.toContain('\n');
    }
    expect(storyRulesOf('unclear_done')).toEqual([
      'no_criteria',
      'no_expected_result',
      'vague_term',
      'no_input_or_state',
      'not_observable',
      'bundled',
    ]);
    expect(storyRulesOf('blocked')).toEqual(['waits_on_ticket', 'waits_on_decision', 'waits_on_team', 'waits_on_external']);
    expect(storyRulesOf('spec_gaps')).toEqual(['edge_case', 'error_handling', 'business_rule', 'data', 'design', 'non_functional']);
  });

  it('no_criteria is code-only: never a model rule, never a criterion rule', () => {
    expect(STORY_RULE_BY_ID.no_criteria.codeOnly).toBe(true);
    expect(STORY_CRITERION_RULE_IDS).not.toContain('no_criteria');
    expect(isModelStoryRule('no_criteria', 'unclear_done')).toBe(false);
    expect(isModelStoryRule('vague_term', 'unclear_done')).toBe(true);
    expect(isModelStoryRule('vague_term', 'spec_gaps')).toBe(false);
    expect(isModelStoryRule('made_up', 'blocked')).toBe(false);
  });

  it('every spec-gap type maps to a spec_gaps rule; blockers map by kind', () => {
    for (const t of STORY_SPEC_GAP_TYPES) expect(STORY_RULE_BY_ID[STORY_SPEC_GAP_RULE[t]].issue).toBe('spec_gaps');
    expect(STORY_SPEC_GAP_RULE.rule).toBe('business_rule');
    expect(storyBlockerRule({ kind: 'api', ticketKey: 'BMD-1', owner: null })).toBe('waits_on_ticket');
    expect(storyBlockerRule({ kind: 'ticket', ticketKey: null, owner: null })).toBe('waits_on_ticket');
    expect(storyBlockerRule({ kind: 'decision', ticketKey: null, owner: 'PO' })).toBe('waits_on_decision');
    expect(storyBlockerRule({ kind: 'design', ticketKey: null, owner: 'UCD team' })).toBe('waits_on_team');
    expect(storyBlockerRule({ kind: 'api', ticketKey: null, owner: null })).toBe('waits_on_external');
  });
});

describe('verifyStoryQuote', () => {
  const src = {
    title: 'Upload a CSV',
    description: 'The page should feel\n   intuitive.  It ships once the API is ready.\nIt’s for admins.',
    criteria: ['The user uploads a file', 'Errors are shown'],
  };

  it('finds an exact passage and says where', () => {
    expect(verifyStoryQuote('once the API is ready', src)).toEqual({ quote: 'once the API is ready', where: 'description' });
    expect(verifyStoryQuote('Errors are shown', src)).toEqual({ quote: 'Errors are shown', where: 'criteria' });
    expect(verifyStoryQuote('a CSV', src)).toEqual({ quote: 'a CSV', where: 'title' });
  });

  it('whitespace is normalised on both sides, and the TICKET’s spelling comes back', () => {
    expect(verifyStoryQuote('feel intuitive', src)).toEqual({ quote: 'feel intuitive', where: 'description' });
    expect(verifyStoryQuote('  feel \n intuitive. It  ships ', src)).toEqual({ quote: 'feel intuitive. It ships', where: 'description' });
  });

  it('case-sensitive first, then case-insensitive (returning the text’s casing)', () => {
    expect(verifyStoryQuote('ONCE THE api', src)).toEqual({ quote: 'once the API', where: 'description' });
    // A case-sensitive hit in a later source beats a case-insensitive one in an earlier source.
    expect(verifyStoryQuote('Upload', src)).toEqual({ quote: 'Upload', where: 'title' });
    expect(verifyStoryQuote('upload', src, { prefer: ['title', 'criteria'] })).toEqual({ quote: 'upload', where: 'criteria' });
  });

  it('curly quotes read as straight', () => {
    expect(verifyStoryQuote("It's for admins", src)).toEqual({ quote: 'It’s for admins.'.slice(0, 15), where: 'description' });
  });

  it('a miss, an empty quote or one over the cap is null — never a guess', () => {
    expect(verifyStoryQuote('once the API is done', src)).toBeNull();
    expect(verifyStoryQuote('', src)).toBeNull();
    expect(verifyStoryQuote('   ', src)).toBeNull();
    expect(verifyStoryQuote(null, src)).toBeNull();
    const long = 'x'.repeat(STORY_QUOTE_MAX + 1);
    expect(verifyStoryQuote(long, { ...src, description: long })).toBeNull();
    expect(verifyStoryQuote(long, { ...src, description: long }, { max: null })).toEqual({ quote: long, where: 'description' });
  });

  it('the preferred source wins when the passage is in two', () => {
    const both = { title: 't', description: 'the user uploads a file', criteria: ['the user uploads a file'] };
    expect(verifyStoryQuote('uploads a file', both)!.where).toBe('criteria');
    expect(verifyStoryQuote('uploads a file', both, { prefer: ['description', 'criteria'] })!.where).toBe('description');
  });
});
