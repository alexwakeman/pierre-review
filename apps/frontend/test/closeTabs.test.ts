// CLOSING THE LAST DYNAMIC TAB lands on ACTIVITY, wherever the tabs were opened from — never the
// Timeline. (The bug: open a few PR / story tabs from Activity, close them
// all while one of them is active, and the app dropped the reader on the Timeline board.)
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { prDetailKey, ticketTabKey, usePinnedTabs } = await import('../src/store/pinnedTabs.js');

const meta = (id: number) => ({
  id,
  number: id,
  title: `PR ${id}`,
  repoFullName: 'acme/web',
  authorLogin: null,
  authorDisplayName: null,
  authorAvatarUrl: null,
});

const tabs = () => usePinnedTabs.getState();

describe('closing every dynamic tab lands on Activity', () => {
  beforeEach(() => {
    mem.clear();
    tabs().clear();
  });

  it('a cleared store sits on Activity, the default view', () => {
    expect(tabs().activeTab).toBe('activity');
  });

  it('closing the only tab, active, opened from Activity → Activity', () => {
    tabs().showActivity();
    tabs().openPrDetailTab(meta(1));
    tabs().closeTab(prDetailKey(1));
    expect(tabs().activeTab).toBe('activity');
  });

  it('closeAllTabs from an active dynamic tab → Activity (the reported bug)', () => {
    tabs().showActivity();
    tabs().openPrDetailTab(meta(1));
    tabs().openPrDetailTab(meta(2));
    tabs().closeAllTabs();
    expect(tabs().tabs).toEqual([]);
    expect(tabs().activeTab).toBe('activity');
  });

  it('a tab opened from This Sprint, closed → Activity', () => {
    tabs().showSprint();
    tabs().openTicketTab({ ident: 'jira:x#ENG-1', key: 'ENG-1', title: null });
    tabs().closeTab(ticketTabKey('jira:x#ENG-1'));
    expect(tabs().activeTab).toBe('activity');
  });

  it('a tab opened from the Timeline, close all → Activity (the reported bug, commonest form)', () => {
    tabs().showTimeline();
    tabs().openPrDetailTab(meta(1));
    tabs().closeAllTabs();
    expect(tabs().activeTab).toBe('activity');
  });

  it('a tab opened from the Timeline, closed one by one → Activity', () => {
    tabs().showTimeline();
    tabs().openPrDetailTab(meta(1));
    tabs().closeTab(prDetailKey(1));
    expect(tabs().activeTab).toBe('activity');
  });

  it('moving between dynamic tabs, then closing them all → Activity', () => {
    tabs().showSprint();
    tabs().openPrDetailTab(meta(1));
    tabs().openPrDetailTab(meta(2));
    tabs().setActiveTab(prDetailKey(1));
    tabs().closeTab(prDetailKey(2));
    tabs().closeTab(prDetailKey(1));
    expect(tabs().activeTab).toBe('activity');
  });

  it('closing the active tab with others left still lands on a neighbour tab', () => {
    tabs().showActivity();
    tabs().openPrDetailTab(meta(1));
    tabs().openPrDetailTab(meta(2));
    tabs().closeTab(prDetailKey(2));
    expect(tabs().activeTab).toBe(prDetailKey(1));
  });

  it('closing all tabs while on a fixed view stays there', () => {
    tabs().openPrDetailTab(meta(1));
    tabs().showTimeline();
    tabs().closeAllTabs();
    expect(tabs().activeTab).toBe('timeline');
  });

  it('a link that lands straight on a tab falls back to Activity', () => {
    tabs().applyUrlTab(prDetailKey(9));
    tabs().closeTab(prDetailKey(9));
    expect(tabs().activeTab).toBe('activity');
  });
});
