// db/story-user-value.ts — the code rule behind Story health's "Stories saying who benefits and why".
import { describe, expect, it } from 'vitest';
import { personaStated, userValueStated } from './story-user-value.js';

describe('userValueStated', () => {
  it('accepts the user-story template with its reason', () => {
    expect(userValueStated('As a support agent, I want to filter tickets so that I can answer faster.')).toBe(true);
    expect(userValueStated('*As an* admin\nI need a bulk delete\n*So that* cleanup takes minutes')).toBe(true);
    expect(userValueStated('In order to cut churn, as a PM I want an export')).toBe(true);
  });

  it('accepts a "so that" clause naming someone', () => {
    expect(userValueStated('Add caching so that customers no longer wait on the dashboard.')).toBe(true);
    expect(userValueStated('Cache it so that we can ship the beta.')).toBe(true);
    expect(userValueStated('so that support staff can see the order history')).toBe(true);
  });

  it('rejects the template without a reason, and "so that" with no one in it', () => {
    expect(userValueStated('As an admin I want a delete button')).toBe(false);
    expect(userValueStated('Refactor so that it compiles on Node 20')).toBe(false);
    expect(userValueStated('Retry so that the build will pass')).toBe(false);
    expect(userValueStated('Fix the null check in the parser')).toBe(false);
    expect(userValueStated(null)).toBe(false);
  });

  it('strips Jira colour markup', () => {
    expect(userValueStated('{color:#172b4d}As a user I want X so that I save time{color}')).toBe(true);
  });
});

describe('personaStated', () => {
  it('accepts the template without a reason, and a named beneficiary', () => {
    expect(personaStated('As an admin I want a delete button')).toBe(true);
    expect(personaStated('As a *planning officer*, we need the export')).toBe(true);
    expect(personaStated('Cache it so that customers no longer wait.')).toBe(true);
  });
  it('rejects text naming no one', () => {
    expect(personaStated('Fix the null check in the parser')).toBe(false);
    expect(personaStated('Retry so that the build will pass')).toBe(false);
    expect(personaStated('')).toBe(false);
  });
});
