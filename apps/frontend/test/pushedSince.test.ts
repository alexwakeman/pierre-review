import { describe, expect, it } from 'vitest';
import type { PushedCommit } from '@pierre-review/shared';
import { pushedCommitHref, pushedSinceAnchor, pushedSinceLabel, pushedSinceRows, pushedSinceTail } from '../src/lib/pushedSince.js';

const c = (sha: string): PushedCommit => ({ sha, headline: `msg ${sha}`, authorId: 1, at: '2026-11-03T10:00:00Z' });

describe('the Pushed since disclosure', () => {
  it('names the action it counts from, never a view', () => {
    expect(pushedSinceLabel(3, 'reviewed')).toBe('3 commits since you last reviewed');
    expect(pushedSinceLabel(1, 'approved')).toBe('1 commit since you approved');
    expect(pushedSinceLabel(2, 'changes_requested')).toBe('2 commits since you requested changes');
    expect(pushedSinceLabel(2, 'commented')).toBe('2 commits since you last commented');
    expect(pushedSinceLabel(2, 'pushed')).toBe('2 commits since you last pushed');
    expect(pushedSinceAnchor(null)).toBe('since your last review or comment');
    for (const a of ['approved', 'reviewed', 'commented', 'pushed', 'changes_requested', null] as const) {
      expect(pushedSinceAnchor(a)).not.toMatch(/look/);
    }
  });

  it('says "Loading the rest…" only while the fetch can add a commit', () => {
    // 3 commits, all 3 inline: nothing more to load.
    expect(pushedSinceTail(pushedSinceRows([c('a1'), c('b2'), c('c3')], 3, null), true)).toBeNull();
    // 5 commits, 3 inline: the fetch is bringing the rest.
    expect(pushedSinceTail(pushedSinceRows([c('a1'), c('b2'), c('c3')], 5, null), true)).toBe('Loading the rest…');
    expect(pushedSinceTail(pushedSinceRows([c('a1'), c('b2'), c('c3')], 5, null), false)).toBe('and 2 more');
  });

  it('lists the inline few until the full list arrives, then every commit', () => {
    const inline = [c('a1'), c('a2')];
    expect(pushedSinceRows(inline, 8, undefined)).toEqual({ commits: inline, total: 8, more: 6 });
    const all = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'].map(c);
    expect(pushedSinceRows(inline, 8, { total: 8, commits: all })).toEqual({ commits: all, total: 8, more: 0 });
    // A bound that bites says so over the same count.
    expect(pushedSinceRows(inline, 8, { total: 400, commits: all }).more).toBe(392);
  });

  it('links a commit under its PR on GitHub', () => {
    expect(pushedCommitHref('https://github.com/acme/api/pull/7', 'abcdef1234')).toBe(
      'https://github.com/acme/api/pull/7/commits/abcdef1234',
    );
    expect(pushedCommitHref('https://github.com/acme/api/pull/7', 'not a sha')).toBeNull();
    expect(pushedCommitHref(null, 'abcdef1234')).toBeNull();
  });
});
