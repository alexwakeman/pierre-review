// The header sync button's freshness lines. Copy, so a failure is silent: the old tooltip promised
// "Syncs automatically every 5 minutes · Next sync ~HH:MM" long after the server stopped working
// that way, and with walks now running only on change, "Last synced" alone would read hours old on
// a quiet workspace the server checked seconds ago.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { Repo } from '@pierre-review/shared';
import { mostRecentCheck, mostRecentSync, syncTooltip } from '../src/lib/syncTooltip.js';

const repo = (over: Partial<Repo>): Repo =>
  ({
    id: 1,
    owner: 'acme',
    name: 'web',
    lastFullSyncAt: null,
    lastIncrementalSyncAt: null,
    ...over,
  }) as Repo;

describe('mostRecentCheck / mostRecentSync', () => {
  it('pick the newest of each field, separately', () => {
    const repos = [
      repo({ id: 1, lastIncrementalSyncAt: '2026-10-28T10:00:00.000Z', lastCheckedAt: '2026-10-28T12:59:40.000Z' }),
      repo({ id: 2, lastIncrementalSyncAt: '2026-10-28T11:00:00.000Z', lastCheckedAt: '2026-10-28T12:58:00.000Z' }),
    ];
    expect(mostRecentSync(repos)).toBe('2026-10-28T11:00:00.000Z');
    expect(mostRecentCheck(repos)).toBe('2026-10-28T12:59:40.000Z');
  });

  it('a repo with no check (a restarted server, the static demo) gives null, not a guess', () => {
    expect(mostRecentCheck([repo({ lastIncrementalSyncAt: '2026-10-28T10:00:00.000Z' })])).toBeNull();
  });
});

describe('syncTooltip', () => {
  it('says when GitHub was last checked AND when data last arrived, with no countdown', () => {
    const text = syncTooltip('2026-10-28T10:00:00.000Z', '2026-10-28T12:59:40.000Z');
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Last checked /);
    expect(lines[1]).toMatch(/^Last synced /);
    expect(lines[2]).toBe('Checks GitHub for changes automatically');
    expect(text).not.toMatch(/Next sync|every 5 minutes/);
  });

  it('omits the line it has no time for', () => {
    expect(syncTooltip('2026-10-28T10:00:00.000Z', null).split('\n')[0]).toMatch(/^Last synced /);
    expect(syncTooltip(null, null)).toBe('Checks GitHub for changes automatically');
  });
});
