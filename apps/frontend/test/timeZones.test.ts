// The Settings time-zone list: the engine's zones under the names people type, with today's offset.
//
// ⚠ V8 LISTS OLD NAMES AND NO "UTC". Measured on Node 24, `Intl.supportedValuesOf('timeZone')`
// spells Kyiv "Europe/Kiev" and Kolkata "Asia/Calcutta" and omits UTC — so a list built straight
// from it cannot find "Kyiv" at all, and a reader searching for the name on their passport sees
// nothing. These pin the mapping, the search, and that a stored old name is still recognised.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/timeZones.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildZoneOptions,
  filterZones,
  findZone,
  offsetOf,
  zoneRows,
} from '../src/components/settings/timeZones.js';

// January, so no zone here is on summer time.
const at = new Date('2026-01-15T12:00:00Z');
const options = buildZoneOptions(['Europe/Kiev', 'Asia/Calcutta', 'Europe/London', 'America/New_York'], at);
const byValue = (v: string) => options.find((o) => o.value === v);

describe('the list', () => {
  it('lists modern names, UTC first, then alphabetical', () => {
    expect(options.map((o) => o.value)).toEqual([
      'UTC',
      'America/New_York',
      'Asia/Kolkata',
      'Europe/Kyiv',
      'Europe/London',
    ]);
    expect(byValue('Europe/Kyiv')?.aliases).toContain('Europe/Kiev');
  });

  it('merges an old name and its modern one into one option', () => {
    const both = buildZoneOptions(['Europe/Kiev', 'Europe/Kyiv'], at);
    expect(both.map((o) => o.value)).toEqual(['UTC', 'Europe/Kyiv']);
  });

  it("shows today's offset beside each", () => {
    expect(byValue('Europe/Kyiv')?.offset).toBe('UTC+2');
    expect(byValue('Europe/London')?.offset).toBe('UTC+0');
    expect(byValue('Asia/Kolkata')?.offset).toBe('UTC+5:30');
    expect(byValue('America/New_York')?.offset).toBe('UTC-5');
    expect(byValue('UTC')?.offset).toBe('UTC+0');
  });

  it('has no offset for a zone the engine does not know', () => {
    expect(offsetOf('Not/AZone', at)).toBeNull();
  });
});

describe('search', () => {
  const first = (q: string) => filterZones(options, q)[0]?.value;

  it('finds a zone by its modern or its old name', () => {
    expect(first('kyiv')).toBe('Europe/Kyiv');
    expect(first('kiev')).toBe('Europe/Kyiv');
    expect(first('calcutta')).toBe('Asia/Kolkata');
    expect(first('kolkata')).toBe('Asia/Kolkata');
  });

  it('reads a space as the underscore in a name', () => {
    expect(first('new york')).toBe('America/New_York');
  });

  it('finds a zone by its offset', () => {
    expect(first('+5:30')).toBe('Asia/Kolkata');
    expect(first('utc+5:30')).toBe('Asia/Kolkata');
    expect(filterZones(options, 'utc-5').map((o) => o.value)).toEqual(['America/New_York']);
  });

  it('puts UTC first for "utc", and finds nothing for nonsense', () => {
    expect(first('utc')).toBe('UTC');
    expect(filterZones(options, 'zzz')).toEqual([]);
  });

  // A city that starts with what was typed beats a region that does, which beats a name that merely
  // contains it — each against the alphabet, which would put them the other way round.
  it('ranks the city, then any part of the name, then anywhere', () => {
    const o = buildZoneOptions(['Australia/Sydney', 'Europe/Chisinau', 'Pacific/Auckland'], at);
    expect(filterZones(o, 'au').map((z) => z.value)).toEqual([
      'Pacific/Auckland',
      'Australia/Sydney',
      'Europe/Chisinau',
    ]);
  });
});

describe('a stored value', () => {
  it('matches by its old name, and not at all when unknown', () => {
    expect(findZone(options, 'Europe/Kiev')?.value).toBe('Europe/Kyiv');
    expect(findZone(options, 'Mars/Base')).toBeNull();
  });
});

describe('the combobox rows', () => {
  it('lead with "Default (<zone>)" — the blank setting — while nothing is typed', () => {
    const rows = zoneRows(options, '', 'Europe/London');
    expect(rows[0]).toEqual({ value: '', label: 'Default (Europe/London)', offset: 'UTC+0' });
    expect(rows[1]?.value).toBe('UTC');
    // A machine still on the old name reads the modern one.
    expect(zoneRows(options, '', 'Europe/Kiev')[0]?.label).toBe('Default (Europe/Kyiv)');
  });

  it('drop the default once a search is under way, unless the search is for it', () => {
    expect(zoneRows(options, 'kyiv', 'Europe/London')[0]?.value).toBe('Europe/Kyiv');
    expect(zoneRows(options, 'def', 'Europe/London')[0]?.value).toBe('');
  });
});
