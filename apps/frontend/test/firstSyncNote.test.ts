import { describe, expect, it } from 'vitest';
import { firstSyncNote, MANY_REPOS_FOR_FIRST_SYNC } from '../src/lib/firstSyncNote.js';

describe('firstSyncNote', () => {
  it('says nothing for the default pick or up to ten repos', () => {
    expect(firstSyncNote(0)).toBeNull();
    expect(firstSyncNote(5)).toBeNull();
    expect(firstSyncNote(MANY_REPOS_FOR_FIRST_SYNC)).toBeNull();
  });

  it('says one plain line past ten', () => {
    expect(firstSyncNote(11)).toBe('The first sync will take longer with this many repositories.');
    expect(firstSyncNote(30)).toBe('The first sync will take longer with this many repositories.');
  });
});
