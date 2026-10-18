import { describe, expect, it } from 'vitest';
import type { SprintPaths, SprintPathsStatus } from '@pierre-review/shared';
import { pathsWriting, sprintDatesLine, sprintPathsView, sprintProgress } from '../src/components/Activity/sprintPathsModel.js';

// The Critical path view's state, the page's progress bar and the header's dates line.

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
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('writing') })).toEqual({ kind: 'message', writing: true, text: 'Working out the critical paths…' });
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
    // Too few tickets is said, never a heading with nothing under it.
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('none'), sprintTickets: 3 })).toEqual({
      kind: 'message',
      writing: false,
      text: 'Critical paths need at least 4 tickets in the sprint.',
    });
    expect(sprintPathsView({ aiEnabled: true, paths: null, status: st('none'), sprintTickets: 4 })).toEqual({ kind: 'none' });
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

describe('sprintProgress', () => {
  const idle = { awaitingRead: false, firstRead: false, fetching: false, briefs: null };
  it('is nothing when nothing is in flight', () => {
    expect(sprintProgress(idle)).toBeNull();
    expect(sprintProgress({ ...idle, briefs: { current: 9, pending: 0 } })).toBeNull();
  });
  it('the sprint builder runs the same indeterminate bar, after a read, a refetch and summaries', () => {
    expect(sprintProgress({ ...idle, pathsWriting: true })).toEqual({ kind: 'busy', label: 'Working out the critical paths' });
    expect(sprintProgress({ ...idle, pathsWriting: true, briefs: { current: 1, pending: 1 } })).toMatchObject({ kind: 'share' });
    expect(sprintProgress({ ...idle, pathsWriting: true, awaitingRead: true })).toEqual({ kind: 'busy', label: 'Reading the sprint' });
  });
  it('is indeterminate while a read or a refetch runs (neither reports progress)', () => {
    expect(sprintProgress({ ...idle, awaitingRead: true })).toEqual({ kind: 'busy', label: 'Reading the sprint' });
    expect(sprintProgress({ ...idle, firstRead: true })).toEqual({ kind: 'busy', label: 'Reading the sprint' });
    expect(sprintProgress({ ...idle, fetching: true, briefs: { current: 1, pending: 3 } })).toEqual({ kind: 'busy', label: 'Refreshing the sprint' });
  });
  it('shows the share of tickets summarised while briefs are written', () => {
    expect(sprintProgress({ ...idle, briefs: { current: 1, pending: 3 } })).toEqual({ kind: 'share', label: 'Summarising tickets', value: 0.25 });
  });
});
