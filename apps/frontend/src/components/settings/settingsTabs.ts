import type { SettingsFocus } from '../../store/settingsModal.js';

// ── THE SETTINGS MODAL'S TABS, AS DATA ─────────────────────────────────────────────────────────
//
// The modal was one long scrolling panel of sixteen sections. It is now a left-hand tab list (a
// top row on a narrow screen) with ONE AREA showing at a time. This file is the pure half: which
// tabs exist, which section lives in which tab, where each `SettingsFocus` lands and how the arrow
// keys move. `SettingsModal.tsx` renders it; `test/settingsTabs.test.ts` pins it.
//
// ⚠ EVERY SECTION LIVES IN EXACTLY ONE TAB. The test reads SettingsModal.tsx and proves each
// `<…Section />` it mounts sits in the panel of the tab listed here — a section dropped from every
// panel would otherwise vanish with no error.
//
// ⚠ THE GRAIN SPLIT SURVIVES INSIDE A TAB. A tab may hold global AND workspace sections (Pending
// holds the account's My Turn beside a workspace's mute). Global sections come first and the workspace ones sit under the
// one `Workspace · <name>` boundary, which the modal draws in every tab that has workspace
// sections — never a suffix on a section's own title.

export type SettingsTabId =
  | 'pull-requests'
  | 'pending'
  | 'dependencies'
  | 'ai'
  | 'ai-review'
  | 'reports'
  | 'integrations'
  | 'bots';

export interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
  /** What lives in it, in a few words — the phone's list of areas shows it under the label. */
  summary: string;
  /** Shown only where agentic AI runs (`me.ai.enabled`). */
  aiOnly?: boolean;
  /** Section component names, global first, then workspace-scoped — the order they render in. */
  global: readonly string[];
  workspace: readonly string[];
}

export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  {
    id: 'pull-requests',
    label: 'Pull requests', summary: 'Large pull requests, blast radius',
    global: ['LargePrThresholdSection', 'BlastRadiusSection'],
    workspace: [],
  },
  { id: 'pending', label: 'Pending', summary: 'My Turn, muted repositories', global: ['MyTurnSection'], workspace: ['PendingMuteSection'] },
  {
    id: 'dependencies',
    label: 'Dependencies', summary: 'Merge, approve and resolve dependency updates',
    global: [],
    workspace: ['DependencyAutomationSection'],
  },
  {
    id: 'ai',
    label: 'AI', summary: 'Provider, sign-in, effort, AI spend',
    aiOnly: true,
    global: ['AiProviderSection', 'ClaudeSpendSection'],
    workspace: [],
  },
  {
    id: 'ai-review',
    label: 'AI review', summary: 'Auto review, reference docs, Confluence, Notion, related repos',
    aiOnly: true,
    global: [],
    workspace: ['AutoReviewSection', 'ReferenceDocsSection', 'ConfluenceSection', 'NotionSection', 'RelatedReposSection'],
  },
  {
    id: 'reports',
    label: 'Reports and sprint', summary: 'Working hours, budgets, sprint cadence',
    global: [],
    workspace: ['FlowSettingsSection', 'SprintSection'],
  },
  {
    id: 'integrations',
    label: 'Integrations', summary: 'Issue tracker, SonarCloud, Slack',
    global: [],
    workspace: ['IssueLinksSection', 'SonarSection', 'SlackSection'],
  },
  {
    id: 'bots',
    label: 'Bots', summary: 'Bot comment scoring',
    global: ['BotScoringSection'],
    workspace: [],
  },
];

/** The tabs on screen: the AI ones only where agentic AI runs. */
export function visibleSettingsTabs(aiEnabled: boolean): SettingsTabDef[] {
  return SETTINGS_TABS.filter((t) => aiEnabled || t.aiOnly !== true);
}

/** Which tab a `SettingsFocus` opens on. */
export const SETTINGS_FOCUS_TAB: Record<SettingsFocus, SettingsTabId> = {
  'my-turn': 'pending',
  'issue-tracker': 'integrations',
  'claude-spend': 'ai',
};

/** The tab the modal opens on: the focus's tab, else the last one shown, else the first — never a
 *  tab that is not on screen (AI off). */
export function initialSettingsTab(
  focus: SettingsFocus | null,
  lastTab: SettingsTabId | null,
  aiEnabled: boolean,
): SettingsTabId {
  const tabs = visibleSettingsTabs(aiEnabled);
  const want = focus != null ? SETTINGS_FOCUS_TAB[focus] : lastTab;
  return tabs.find((t) => t.id === want)?.id ?? tabs[0]!.id;
}

/** The tab a key moves to (arrows wrap, Home/End jump), or null for any other key. Both arrow
 *  pairs work in both layouts, so the narrow top row and the wide left column behave alike. */
export function tabForKey(
  key: string,
  current: SettingsTabId,
  tabs: readonly SettingsTabDef[],
): SettingsTabId | null {
  const n = tabs.length;
  const i = tabs.findIndex((t) => t.id === current);
  if (i < 0 || n === 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return tabs[(i + 1) % n]!.id;
    case 'ArrowUp':
    case 'ArrowLeft':
      return tabs[(i - 1 + n) % n]!.id;
    case 'Home':
      return tabs[0]!.id;
    case 'End':
      return tabs[n - 1]!.id;
    default:
      return null;
  }
}

export const settingsTabDomId = (id: SettingsTabId): string => `settings-tab-${id}`;
export const settingsPanelDomId = (id: SettingsTabId): string => `settings-panel-${id}`;
