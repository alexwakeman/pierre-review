import { beforeAll, describe, expect, it } from 'vitest';
import { githubPrUrl } from '../src/lib/prLink.js';

beforeAll(() => {
  // safeExternalUrl parses against the page origin.
  (globalThis as { window?: unknown }).window ??= { location: { origin: 'http://localhost:5173' } };
});

describe('githubPrUrl', () => {
  it('builds the PR URL the server spells', () => {
    expect(githubPrUrl('acme/web', 42)).toBe('https://github.com/acme/web/pull/42');
  });
  it('refuses an unknown or malformed repo name', () => {
    expect(githubPrUrl(null, 42)).toBeNull();
    expect(githubPrUrl('', 42)).toBeNull();
    expect(githubPrUrl('repo 7', 42)).toBeNull();
    expect(githubPrUrl('acme/web/extra', 42)).toBeNull();
  });
  it('refuses a non-positive or fractional number', () => {
    expect(githubPrUrl('acme/web', 0)).toBeNull();
    expect(githubPrUrl('acme/web', 1.5)).toBeNull();
  });
});
