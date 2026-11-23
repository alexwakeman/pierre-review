// The licence reminder's words and the Settings → Licence lines (docs/LICENSING.md). The decision
// itself (when it shows) is pinned on the server: apps/backend licence/licence.test.ts.
import { describe, expect, it } from 'vitest';
import { LICENCE_FREE_USERS } from '@pierre-review/shared';
import { SETTINGS_FOCUS_TAB, SETTINGS_TABS } from '../src/components/settings/settingsTabs.js';

describe('the licence tab', () => {
  it('is where the reminder’s "Enter a key" lands, and holds the licence section', () => {
    expect(SETTINGS_FOCUS_TAB.licence).toBe('licence');
    expect(SETTINGS_TABS.find((t) => t.id === 'licence')?.global).toEqual(['LicenceSection']);
  });
  it('reads the free limit from the one shared constant', () => {
    expect(LICENCE_FREE_USERS).toBe(3);
  });
});
