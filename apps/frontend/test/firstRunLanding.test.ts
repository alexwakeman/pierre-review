import { describe, expect, it } from 'vitest';
import { firstRunLanding } from '../src/lib/firstRunLanding.js';

describe('firstRunLanding', () => {
  it('waits while the repos are loading, whatever the suggestions say', () => {
    expect(firstRunLanding(undefined, undefined, false)).toBe('wait');
    expect(firstRunLanding(undefined, { results: [1] }, false)).toBe('wait');
    expect(firstRunLanding(undefined, undefined, true)).toBe('wait');
  });

  it('does nothing for an account with repos', () => {
    expect(firstRunLanding([1], undefined, false)).toBe('none');
    expect(firstRunLanding([1], { results: [] }, false)).toBe('none');
  });

  it('waits for the suggestions on an empty account', () => {
    expect(firstRunLanding([], undefined, false)).toBe('wait');
  });

  it('shows only the onboarding panel when suggestions were found', () => {
    expect(firstRunLanding([], { results: [1] }, false)).toBe('onboarding');
  });

  it('opens the manager when nothing was found or the lookup failed', () => {
    expect(firstRunLanding([], { results: [] }, false)).toBe('manager');
    expect(firstRunLanding([], undefined, true)).toBe('manager');
  });
});
