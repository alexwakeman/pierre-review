import { describe, expect, it } from 'vitest';
import type { SprintSignal, SprintStory, SprintStoryStatus } from '@pierre-review/shared';
import { sprintDatesLine, sprintStoryView, storyWriting, storylineFocus, stripCards, stripCardsSig } from '../src/components/Activity/sprintStoryModel.js';

// The sprint story strip's fold: what it draws, and what a storyline click focuses.

const story: SprintStory = {
  headline: 'Checkout and search.',
  focus: 'The sprint is focused on checkout.',
  storylines: [{ kind: 'chain', title: 'Checkout', sentence: 'Under way.', idents: ['a', 'b'] }],
  createdAt: '2026-10-14T00:00:00.000Z',
};

const st = (state: SprintStoryStatus['state'], o: Partial<SprintStoryStatus> = {}): SprintStoryStatus => ({
  state,
  stale: false,
  lastAttemptAt: null,
  failure: null,
  ...o,
});

describe('sprintStoryView', () => {
  it('AI off renders nothing, even with a story', () => {
    expect(sprintStoryView({ aiEnabled: false, story, status: st('writing') })).toEqual({ kind: 'off' });
  });
  it('no story: one short line per state; nothing when no pass can run', () => {
    expect(sprintStoryView({ aiEnabled: true, story: null, status: st('writing') })).toEqual({ kind: 'message', writing: true, text: 'Writing the sprint story…' });
    expect(sprintStoryView({ aiEnabled: true, story: null, status: st('queued') })).toMatchObject({ kind: 'message', writing: false });
    expect(sprintStoryView({ aiEnabled: true, story: null, status: st('waiting') })).toEqual({
      kind: 'message',
      writing: false,
      text: 'The sprint story is written after the next sprint read.',
    });
    expect(sprintStoryView({ aiEnabled: true, story: null, status: st('failed', { failure: 'number' }) })).toEqual({
      kind: 'message',
      writing: false,
      text: 'Couldn’t write the sprint story. Claude used a number Limn did not count. Limn tries again when the sprint changes.',
    });
    expect(sprintStoryView({ aiEnabled: true, story: null, status: st('none') })).toEqual({ kind: 'none' });
    // A v4 story with no storyline (nothing at risk) still shows its headline + focus.
    const bare = { ...story, storylines: [] };
    expect(sprintStoryView({ aiEnabled: true, story: bare, status: st('current') })).toEqual({ kind: 'story', story: bare, note: null });
  });
  it('⚠ a STALE story stays on screen: quiet "Updating" while in flight, the failure line when it failed', () => {
    expect(sprintStoryView({ aiEnabled: true, story, status: st('current') })).toEqual({ kind: 'story', story, note: null });
    expect(sprintStoryView({ aiEnabled: true, story, status: st('writing', { stale: true }) })).toEqual({ kind: 'story', story, note: { kind: 'updating' } });
    expect(sprintStoryView({ aiEnabled: true, story, status: st('queued', { stale: true }) })).toEqual({ kind: 'story', story, note: { kind: 'updating' } });
    expect(sprintStoryView({ aiEnabled: true, story, status: st('waiting', { stale: true }) })).toEqual({ kind: 'story', story, note: null });
    expect(sprintStoryView({ aiEnabled: true, story, status: st('failed', { stale: true, failure: 'shape' }) })).toMatchObject({
      kind: 'story',
      note: { kind: 'failed', text: expect.stringContaining('not in the expected shape') },
    });
  });
  it('storyWriting: only while the pass runs, only with AI on', () => {
    expect(storyWriting(true, st('writing'))).toBe(true);
    expect(storyWriting(true, st('queued'))).toBe(false);
    expect(storyWriting(false, st('writing'))).toBe(false);
    expect(storyWriting(true, undefined)).toBe(false);
  });
});

describe('sprintDatesLine', () => {
  const D = (s: string) => Date.parse(s);
  const jira = { startsAt: '2026-10-14T10:15:00.000Z', endsAt: '2026-10-27T17:00:00.000Z', source: 'tracker' as const };
  const line = (d: Parameters<typeof sprintDatesLine>[0], now: number) => sprintDatesLine(d, now, 'en-GB', 'UTC');
  it('the range and the day, short dates in the locale; a part day counts', () => {
    expect(line(jira, D('2026-10-14T12:00:00Z'))).toBe('14 Oct – 27 Oct · day 1 of 14');
    expect(line(jira, D('2026-10-27T12:00:00Z'))).toBe('14 Oct – 27 Oct · day 14 of 14');
    expect(sprintDatesLine(jira, D('2026-10-14T12:00:00Z'), 'en-US', 'UTC')).toBe('Oct 14 – Oct 27 · day 1 of 14');
  });
  it('a cadence window ending on midnight ends the day before', () => {
    const cadence = { startsAt: '2026-10-14T00:00:00.000Z', endsAt: '2026-10-28T00:00:00.000Z', source: 'cadence' as const };
    expect(line(cadence, D('2026-10-20T09:00:00Z'))).toBe('14 Oct – 27 Oct · day 7 of 14');
  });
  it('before, after, one end only, none', () => {
    expect(line(jira, D('2026-10-12T12:00:00Z'))).toBe('14 Oct – 27 Oct · starts in 2 days');
    expect(line(jira, D('2026-10-28T12:00:00Z'))).toBe('14 Oct – 27 Oct · ended');
    expect(line({ startsAt: null, endsAt: '2026-10-28T07:00:00.000Z', source: 'tracker' }, D('2026-10-20T00:00:00Z'))).toBe('due 28 Oct');
    expect(line({ startsAt: null, endsAt: '2026-10-28T07:00:00.000Z', source: 'tracker' }, D('2026-10-29T00:00:00Z'))).toBe('ended 28 Oct');
    expect(line({ startsAt: '2026-10-14T10:00:00.000Z', endsAt: null, source: 'tracker' }, D('2026-10-20T00:00:00Z'))).toBe('from 14 Oct');
    expect(line({ startsAt: null, endsAt: null, source: 'tracker' }, D('2026-10-20T00:00:00Z'))).toBeNull();
    expect(line(null, 0)).toBeNull();
  });
});

describe('storylineFocus', () => {
  it('focuses a card, switches to another, and clears on a second click', () => {
    expect(storylineFocus(null, 'k0', ['a'])).toEqual({ selected: 'k0', idents: ['a'] });
    expect(storylineFocus('k0', 'k1', ['b', 'c'])).toEqual({ selected: 'k1', idents: ['b', 'c'] });
    expect(storylineFocus('k1', 'k1', ['b', 'c'])).toEqual({ selected: null, idents: [] });
  });
});

describe('stripCards', () => {
  const sig = (kind: SprintSignal['kind'], title = kind): SprintSignal => ({ kind, title, sentence: `${kind}.`, idents: [kind] });
  const signals = [sig('blocked_outside'), sig('out_of_step'), sig('pace'), sig('since_last')];
  it('the ONE order: since you last looked, pace, the storylines, out of step, blocked outside; labels visible', () => {
    const risk = { kind: 'risk' as const, title: 'Late', sentence: 'Two wait.', idents: ['r'] };
    const cards = stripCards([...story.storylines, risk], signals);
    expect(cards.map((c) => c.kind)).toEqual(['since_last', 'pace', 'chain', 'risk', 'out_of_step', 'blocked_outside']);
    expect(cards.map((c) => c.label)).toEqual(['Since you last looked', 'Pace', 'Dependency path', 'At risk', 'Out of step', 'Blocked outside the sprint']);
    expect(cards.map((c) => c.by)).toEqual(['limn', 'limn', 'claude', 'claude', 'limn', 'limn']);
    expect(cards[0]!.idents).toEqual(['since_last']);
  });
  it('no story (AI off): the code cards alone; nothing at all → []', () => {
    expect(stripCards([], [sig('pace')]).map((c) => c.label)).toEqual(['Pace']);
    expect(stripCards([], [])).toEqual([]);
  });
  it('⚠ the selection signature ignores titles ("Since 31 minutes ago" moves every minute)', () => {
    const a = stripCards([], [sig('since_last', 'Since 31 minutes ago')]);
    const b = stripCards([], [sig('since_last', 'Since 32 minutes ago')]);
    expect(stripCardsSig(a)).toBe(stripCardsSig(b));
    expect(stripCardsSig(a)).not.toBe(stripCardsSig(stripCards([], [{ ...sig('since_last'), idents: ['x'] }])));
  });
});
