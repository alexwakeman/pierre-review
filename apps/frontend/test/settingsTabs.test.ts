import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SETTINGS_FOCUS_TAB,
  SETTINGS_TABS,
  initialSettingsTab,
  tabForKey,
  visibleSettingsTabs,
} from '../src/components/settings/settingsTabs.js';

// The Settings modal is a tab list; which section lives in which tab is data
// (`settingsTabs.ts`). Nothing under test/ renders, so the wiring is checked structurally.

const dir = fileURLToPath(new URL('../src/components/settings/', import.meta.url));
const modal = readFileSync(`${dir}SettingsModal.tsx`, 'utf8');

const listed = SETTINGS_TABS.flatMap((t) => [...t.global, ...t.workspace]);

describe('every section lives in exactly one tab', () => {
  it('no section is listed twice', () => {
    expect(new Set(listed).size).toBe(listed.length);
  });
  it('every *Section.tsx file is listed in a tab', () => {
    const files = readdirSync(dir)
      .filter((f) => /^[A-Z]\w*Section\.tsx$/.test(f))
      .map((f) => f.replace(/\.tsx$/, ''));
    expect([...files].sort()).toEqual([...listed].sort());
  });
  it('the modal maps every listed name to its component', () => {
    const map = modal.slice(modal.indexOf('const SECTIONS'), modal.indexOf('};', modal.indexOf('const SECTIONS')));
    for (const n of listed) expect(map).toContain(`  ${n},`);
  });
});

describe('opening at a section opens its tab', () => {
  it('each focus names the tab that holds its section', () => {
    const holder: Record<string, string> = {
      'my-turn': 'MyTurnSection',
      'issue-tracker': 'IssueLinksSection',
      'claude-spend': 'ClaudeSpendSection',
    };
    for (const [focus, tabId] of Object.entries(SETTINGS_FOCUS_TAB)) {
      const tab = SETTINGS_TABS.find((t) => t.id === tabId)!;
      expect([...tab.global, ...tab.workspace]).toContain(holder[focus]);
    }
  });
  it('focus beats the last tab; the last tab beats the first', () => {
    expect(initialSettingsTab('issue-tracker', 'bots', true)).toBe('integrations');
    expect(initialSettingsTab(null, 'bots', true)).toBe('bots');
    expect(initialSettingsTab(null, null, true)).toBe('pull-requests');
  });
  it('never opens on a tab that is not shown (AI off)', () => {
    expect(initialSettingsTab(null, 'ai-review', false)).toBe('pull-requests');
    expect(visibleSettingsTabs(false).some((t) => t.aiOnly)).toBe(false);
  });
});

describe('arrow keys move between tabs', () => {
  const tabs = visibleSettingsTabs(true);
  it('wraps both ways in both orientations', () => {
    expect(tabForKey('ArrowDown', 'pull-requests', tabs)).toBe('pending');
    expect(tabForKey('ArrowRight', 'pull-requests', tabs)).toBe('pending');
    expect(tabForKey('ArrowUp', 'pull-requests', tabs)).toBe('bots');
    expect(tabForKey('ArrowLeft', 'bots', tabs)).toBe('integrations');
    expect(tabForKey('ArrowDown', 'bots', tabs)).toBe('pull-requests');
  });
  it('Home and End jump; other keys do nothing', () => {
    expect(tabForKey('End', 'pending', tabs)).toBe('bots');
    expect(tabForKey('Home', 'bots', tabs)).toBe('pull-requests');
    expect(tabForKey('Enter', 'bots', tabs)).toBeNull();
  });
});

describe('the modal wires the tab roles', () => {
  it('tablist, tab with aria-selected and roving tabindex, tabpanel labelled by its tab', () => {
    expect(modal).toContain('role="tablist"');
    expect(modal).toContain('role="tab"');
    expect(modal).toContain('aria-selected={selected}');
    expect(modal).toContain('tabIndex={selected ? 0 : -1}');
    expect(modal).toContain('role="tabpanel"');
    expect(modal).toContain('aria-labelledby={settingsTabDomId(def.id)}');
  });
});
