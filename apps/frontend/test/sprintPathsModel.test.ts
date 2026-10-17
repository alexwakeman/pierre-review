import { describe, expect, it } from 'vitest';
import type { SprintPaths, SprintPathsStatus, SprintSignal } from '@pierre-review/shared';
import { cardFocus, pathsWriting, sprintDatesLine, sprintPathsView, stripCards, stripCardsSig } from '../src/components/Activity/sprintPathsModel.js';

// The critical-paths strip's fold: what it draws, and what a card click focuses.

const paths: SprintPaths = {
  paths: [
    { title: 'Writer first', tickets: ['A-2', 'A-1'], idents: ['a2', 'a1'], advice: 'Review the writer.', risk: 'high' },
    { title: 'Search', tickets: ['A-3'], idents: ['a3'], advice: 'Pair on it.', risk: 'low' },
  ],
  callouts: [{ title: 'Nobody owns these', tickets: ['A-4', 'A-5'], idents: ['a4', 'a5'] }],
  createdAt: '2026-10-14T00:00:00.000Z',
};

const st = (state: SprintPathsStatus['state'], o: Partial<SprintPathsStatus> = {}): SprintPathsStatus => ({
  state,
  stale: false,
  lastAttemptAt: null,
  failure: null,
  ...o,
});

describe('sprintPathsView', () => {
  it('AI off renders nothing, even with paths', () => {
    expect(sprintPathsView({ aiEnabled: false, paths, status: st('writing') })).toEqual({ kind: 'off' });
  });
  it('no paths: one short line per state; nothing when no pass can run', () => {
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('writing') })).toEqual({ kind: 'message', writing: true, text: 'Finding the critical paths…' });
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('queued') })).toMatchObject({ kind: 'message', writing: false });
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('waiting') })).toEqual({
      kind: 'message',
      writing: false,
      text: 'Critical paths come after the next sprint read.',
    });
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('failed', { failure: 'refused' }) })).toEqual({
      kind: 'message',
      writing: false,
      text: 'Couldn’t find the critical paths. Claude’s answer did not pass Limn’s checks. Limn tries again when the sprint changes.',
    });
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('failed', { failure: 'daily_cap' }) })).toMatchObject({
      text: expect.stringContaining('Limn tries again tomorrow.'),
    });
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('none') })).toEqual({ kind: 'none' });
  });
  it('⚠ STALE paths stay on screen: quiet "Updating" while in flight, the failure line when it failed', () => {
    expect(sprintPathsView({ aiEnabled: true, paths, status: st('current') })).toEqual({ kind: 'paths', paths, note: null });
    expect(sprintPathsView({ aiEnabled: true, paths, status: st('writing', { stale: true }) })).toEqual({ kind: 'paths', paths, note: { kind: 'updating' } });
    expect(sprintPathsView({ aiEnabled: true, paths, status: st('waiting', { stale: true }) })).toEqual({ kind: 'paths', paths, note: null });
    expect(sprintPathsView({ aiEnabled: true, paths, status: st('failed', { stale: true, failure: 'stopped' }) })).toMatchObject({
      kind: 'paths',
      note: { kind: 'failed', text: expect.stringContaining('ran out of turns or budget') },
    });
  });
  it('pathsWriting: only while the pass runs, only with AI on', () => {
    expect(pathsWriting(true, st('writing'))).toBe(true);
    expect(pathsWriting(true, st('queued'))).toBe(false);
    expect(pathsWriting(false, st('writing'))).toBe(false);
    expect(pathsWriting(true, undefined)).toBe(false);
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

describe('cardFocus', () => {
  it('focuses a card, switches to another, and clears on a second click', () => {
    expect(cardFocus(null, 'k0', ['a'])).toEqual({ selected: 'k0', idents: ['a'] });
    expect(cardFocus('k0', 'k1', ['b', 'c'])).toEqual({ selected: 'k1', idents: ['b', 'c'] });
    expect(cardFocus('k1', 'k1', ['b', 'c'])).toEqual({ selected: null, idents: [] });
  });
});

describe('stripCards', () => {
  const sig = (kind: SprintSignal['kind'], title = kind): SprintSignal => ({ kind, title, sentence: `${kind}.`, idents: [kind] });
  const signals = [sig('blocked_outside'), sig('out_of_step'), sig('pace'), sig('since_last')];
  it('the ONE order: since you last looked, pace, the paths, the call-outs, out of step, blocked outside; labels visible', () => {
    const cards = stripCards(paths, signals);
    expect(cards.map((c) => c.kind)).toEqual(['since_last', 'pace', 'path', 'path', 'callout', 'out_of_step', 'blocked_outside']);
    expect(cards.map((c) => c.label)).toEqual(['Since you last looked', 'Pace', 'High risk', 'Low risk', 'Call-out', 'Out of step', 'Blocked outside the sprint']);
    expect(cards.map((c) => c.by)).toEqual(['limn', 'limn', 'claude', 'claude', 'claude', 'limn', 'limn']);
    expect(cards[2]).toMatchObject({ tickets: ['A-2', 'A-1'], idents: ['a2', 'a1'], sentence: 'Review the writer.', risk: 'high' });
    expect(cards[4]).toMatchObject({ sentence: null, tickets: ['A-4', 'A-5'] });
  });
  it('no paths (AI off): the code cards alone; nothing at all → []', () => {
    expect(stripCards(null, [sig('pace')]).map((c) => c.label)).toEqual(['Pace']);
    expect(stripCards(null, [])).toEqual([]);
  });
  it('⚠ the selection signature ignores titles ("Since 31 minutes ago" moves every minute)', () => {
    const a = stripCards(null, [sig('since_last', 'Since 31 minutes ago')]);
    const b = stripCards(null, [sig('since_last', 'Since 32 minutes ago')]);
    expect(stripCardsSig(a)).toBe(stripCardsSig(b));
    expect(stripCardsSig(a)).not.toBe(stripCardsSig(stripCards(null, [{ ...sig('since_last'), idents: ['x'] }])));
  });
});
