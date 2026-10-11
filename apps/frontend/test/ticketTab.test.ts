// THE TICKET TAB (docs/FRONTEND.md § The ticket tab) — `ticket:<ident>`, ephemeral but
// SELF-DESCRIBING: the key is the address, so a URL re-creates it.
//
// Pins: the key round-trips an ident containing ':' '/' '#'; the chip key is parsed off the ident
// (GitHub's `owner/repo#12` included); open / re-open keeps one tab and refreshes its meta;
// `applyUrlTab` re-creates the tab from the key alone; `writeToUrl` emits `view=<key>` and that URL
// lands back on the tab.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketTab.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { jiraTicketIdent, trackerTicketIdent } from '@pierre-review/shared';
import { useFilters, type FilterState } from '../src/store/filters.js';
import { parseTicketTabKey, ticketKeyOfIdent, ticketTabKey, usePinnedTabs } from '../src/store/pinnedTabs.js';

const location = { pathname: '/app/', search: '' };
(globalThis as unknown as { window: unknown }).window = {
  location,
  history: {
    replaceState: (_state: unknown, _title: string, url: string): void => {
      const [path, qs] = String(url).split('?');
      location.pathname = path ?? '/app/';
      location.search = qs ? `?${qs}` : '';
    },
  },
};

const { landingTabFromUrl, writeToUrl } = await import('../src/hooks/useUrlState.js');

const JIRA = jiraTicketIdent('https://acme.atlassian.net', 'BMD-568');
const GH = trackerTicketIdent('github', 'https://github.com', 'acme/web#12');

function state(over: Partial<FilterState>): FilterState {
  return { ...useFilters.getState(), ...over };
}

beforeEach(() => {
  usePinnedTabs.setState({ tabs: [], activeTab: 'activity' });
});

describe('the ticket tab key', () => {
  it('round-trips an ident with : / #', () => {
    expect(parseTicketTabKey(ticketTabKey(JIRA))).toBe(JIRA);
    expect(parseTicketTabKey(ticketTabKey(GH))).toBe(GH);
  });

  it('refuses other keys and an empty ident', () => {
    expect(parseTicketTabKey('user-activity:4')).toBeNull();
    expect(parseTicketTabKey('ticket:')).toBeNull();
    expect(parseTicketTabKey('ticket:   ')).toBeNull();
  });

  it('parses the chip key off the ident', () => {
    expect(ticketKeyOfIdent(JIRA)).toBe('BMD-568');
    expect(ticketKeyOfIdent(GH)).toBe('acme/web#12');
  });
});

describe('opening the tab', () => {
  it('opens once, re-focuses on re-open, and refreshes the meta', () => {
    const s = usePinnedTabs.getState();
    s.openTicketTab({ ident: JIRA, key: 'BMD-568', title: null });
    usePinnedTabs.getState().openPrDetailTab({
      id: 1,
      number: 1,
      title: 'x',
      repoFullName: 'acme/web',
      authorLogin: null,
      authorDisplayName: null,
      authorAvatarUrl: null,
    });
    usePinnedTabs.getState().openTicketTab({ ident: JIRA, key: 'BMD-568', title: 'Cookie banner' });
    const after = usePinnedTabs.getState();
    const tickets = after.tabs.filter((t) => t.kind === 'ticket');
    expect(tickets).toHaveLength(1);
    expect(after.activeTab).toBe(ticketTabKey(JIRA));
    expect(tickets[0]!.ticketMeta).toEqual({ ident: JIRA, key: 'BMD-568', title: 'Cookie banner' });
  });

  it('applyUrlTab re-creates the tab from its key alone', () => {
    usePinnedTabs.getState().applyUrlTab(ticketTabKey(GH));
    const s = usePinnedTabs.getState();
    expect(s.activeTab).toBe(ticketTabKey(GH));
    const tab = s.tabs.find((t) => t.key === ticketTabKey(GH));
    expect(tab?.kind).toBe('ticket');
    expect(tab?.ticketMeta).toEqual({ ident: GH, key: 'acme/web#12', title: null });
  });
});

describe('the URL round trip', () => {
  it('emits view=<key> and that URL lands back on the tab', () => {
    usePinnedTabs.getState().openTicketTab({ ident: JIRA, key: 'BMD-568', title: 'Cookie banner' });
    writeToUrl(state({ workspaceId: 5 }));
    const p = new URLSearchParams(location.search);
    expect(p.get('view')).toBe(ticketTabKey(JIRA));
    expect(landingTabFromUrl(location.search)).toBe(ticketTabKey(JIRA));
  });
});
