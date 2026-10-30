// THE BUILD TAB ("Implement story", docs/FRONTEND.md § The build tab) — `story-build:<ident>`,
// ephemeral but SELF-DESCRIBING like the story tab: the key is the address, so a URL re-creates it.
//
// Pins: the key round-trips an ident with ':' '/' '#', never parses as a story-tab key (and the other
// way round); the chip words; open / re-open keeps one tab; `applyUrlTab` re-creates it from the key;
// `writeToUrl` emits `view=<key>` and that URL lands back on the tab.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyBuildTab.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { jiraTicketIdent, trackerTicketIdent } from '@pierre-review/shared';
import { useFilters, type FilterState } from '../src/store/filters.js';
import { parseStoryBuildTabKey, parseTicketTabKey, storyBuildTabKey, ticketTabKey, usePinnedTabs } from '../src/store/pinnedTabs.js';
import { storyBuildTabLabels } from '../src/lib/storyBuildTab.js';

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

const JIRA = jiraTicketIdent('https://acme.atlassian.net', 'PLAT-310');
const GH = trackerTicketIdent('github', 'https://github.com', 'acme/web#12');

function state(over: Partial<FilterState>): FilterState {
  return { ...useFilters.getState(), ...over };
}

beforeEach(() => {
  usePinnedTabs.setState({ tabs: [], activeTab: 'activity' });
});

describe('the build tab key', () => {
  it('round-trips an ident with : / #', () => {
    expect(parseStoryBuildTabKey(storyBuildTabKey(JIRA))).toBe(JIRA);
    expect(parseStoryBuildTabKey(storyBuildTabKey(GH))).toBe(GH);
  });

  it('never reads as the story tab, nor the story tab as a build', () => {
    expect(parseTicketTabKey(storyBuildTabKey(JIRA))).toBeNull();
    expect(parseStoryBuildTabKey(ticketTabKey(JIRA))).toBeNull();
  });

  it('refuses other keys and an empty ident', () => {
    expect(parseStoryBuildTabKey('user-activity:4')).toBeNull();
    expect(parseStoryBuildTabKey('story-build:')).toBeNull();
    expect(parseStoryBuildTabKey('story-build:   ')).toBeNull();
  });
});

describe('the chip words', () => {
  it('names the key and says what the tab is', () => {
    expect(storyBuildTabLabels('PLAT-310')).toEqual({ chip: 'PLAT-310 · Build', title: 'PLAT-310: implementation', closeAria: 'Close build tab' });
    expect(storyBuildTabLabels(null).chip).toBe('Build');
    expect(storyBuildTabLabels('  ').title).toBe('Implementation');
  });
});

describe('opening the tab', () => {
  it('opens once, re-focuses on re-open, and keeps beside the story tab', () => {
    const s = usePinnedTabs.getState();
    s.openStoryBuildTab({ ident: JIRA, key: 'PLAT-310', title: null });
    usePinnedTabs.getState().openTicketTab({ ident: JIRA, key: 'PLAT-310', title: null });
    usePinnedTabs.getState().openStoryBuildTab({ ident: JIRA, key: 'PLAT-310', title: 'Retry within the budget' });
    const after = usePinnedTabs.getState();
    expect(after.tabs.filter((t) => t.kind === 'story-build')).toHaveLength(1);
    expect(after.tabs.filter((t) => t.kind === 'ticket')).toHaveLength(1);
    expect(after.activeTab).toBe(storyBuildTabKey(JIRA));
    expect(after.tabs.find((t) => t.kind === 'story-build')!.ticketMeta).toEqual({ ident: JIRA, key: 'PLAT-310', title: 'Retry within the budget' });
  });

  it('applyUrlTab re-creates the tab from its key alone', () => {
    usePinnedTabs.getState().applyUrlTab(storyBuildTabKey(GH));
    const s = usePinnedTabs.getState();
    expect(s.activeTab).toBe(storyBuildTabKey(GH));
    const tab = s.tabs.find((t) => t.key === storyBuildTabKey(GH));
    expect(tab?.kind).toBe('story-build');
    expect(tab?.ticketMeta).toEqual({ ident: GH, key: 'acme/web#12', title: null });
  });
});

describe('the URL round trip', () => {
  it('emits view=<key> and that URL lands back on the tab', () => {
    usePinnedTabs.getState().openStoryBuildTab({ ident: JIRA, key: 'PLAT-310', title: null });
    writeToUrl(state({ workspaceId: 5 }));
    const p = new URLSearchParams(location.search);
    expect(p.get('view')).toBe(storyBuildTabKey(JIRA));
    expect(landingTabFromUrl(location.search)).toBe(storyBuildTabKey(JIRA));
  });
});
