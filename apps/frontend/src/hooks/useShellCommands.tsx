import { useCallback, useMemo } from 'react';
import {
  BookIcon,
  BotIcon,
  ChartIcon,
  FeedIcon,
  GearIcon,
  MagnifierIcon,
  MoonIcon,
  PendingBallIcon,
  PullRequestIcon,
  QuestionIcon,
  RefreshIcon,
  TimelineIcon,
  WorkspaceIcon,
} from '../components/Icons.js';
import { TAB_LABEL } from '../components/Activity/pendingTabs.js';
import { SETTINGS_TABS } from '../components/settings/settingsTabs.js';
import { useCommandProvider, useRegisterCommands, type Command } from '../components/ui/commands.js';
import { indexUsers } from '../lib/ui.js';
import { getSyncRoundActions, useFilters } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { useSettingsModal } from '../store/settingsModal.js';
import { PENDING_TABS } from '@pierre-review/shared';
import { useAiCapabilities } from './useAiCapabilities.js';
import { useRepos, useUsers } from './useTimeline.js';
import { useWorkspaceOpenPrs } from './useTriage.js';
import { useWorkspaces } from './useWorkspaces.js';

// THE SHELL'S ⌘K COMMANDS: every destination, every workspace, every Settings tab, the global
// actions, and every open pull request in the workspace (plus "Search everything for …", which
// reaches merged and closed PRs, threads, people and tickets through the existing search tab).
// Mounted once from App.tsx. Each command runs the SAME store action a click runs, in the order
// those actions require (setActivityRepo BEFORE setAttentionTab — filters.ts § ORDERING).

const SPRINT_TABS = [
  ['themes', 'Theme'],
  ['paths', 'Critical path'],
  ['people', 'People'],
  ['merged', 'Merged so far'],
] as const;
const REPORT_TABS = [
  ['overview', 'Overview'],
  ['bottlenecks', 'Chronology'],
  ['stories', 'Stories'],
] as const;
const BOT_TABS = [
  ['roi', 'ROI'],
  ['themes', 'Themes'],
  ['benchmark', 'Benchmark'],
  ['classification', 'Classification'],
] as const;

export function useShellCommands({
  toggleTheme,
  openHelp,
}: {
  toggleTheme: () => void;
  openHelp: () => void;
}): void {
  const aiOn = useAiCapabilities().enabled;
  const { data: workspaces } = useWorkspaces();
  const workspaceId = useFilters((s) => s.workspaceId);

  const commands = useMemo<Command[]>(() => {
    const f = (): ReturnType<typeof useFilters.getState> => useFilters.getState();
    const t = (): ReturnType<typeof usePinnedTabs.getState> => usePinnedTabs.getState();
    const activity = (id: Parameters<ReturnType<typeof useFilters.getState>['setActivityRepo']>[0]) => (): void => {
      f().setActivityRepo(id);
      t().showActivity();
    };
    const out: Command[] = [
      { id: 'open-prs', group: 'Go to', title: 'Open pull requests', icon: <PullRequestIcon size={14} />, keywords: ['prs', 'activity'], run: activity('open-prs') },
      { id: 'pending', group: 'Go to', title: 'Pending', icon: <PendingBallIcon size={14} />, keywords: ['my turn', 'inbox', 'attention'], run: activity('attention') },
      ...PENDING_TABS.map((d, i) => ({
        id: `pending:${d.key}`,
        group: 'Go to' as const,
        title: `Pending: ${TAB_LABEL[d.key]}`,
        // The key that picks this tab once Pending is showing.
        shortcut: String(i + 1),
        icon: <PendingBallIcon size={14} />,
        run: (): void => {
          f().setActivityRepo('attention');
          f().setAttentionTab(d.key);
          t().showActivity();
        },
      })).filter((c) => aiOn || c.id !== 'pending:claude'),
      ...(aiOn
        ? [{ id: 'docs', group: 'Go to' as const, title: 'Docs', icon: <BookIcon size={14} />, keywords: ['reference', 'library'], run: activity('docs') }]
        : []),
      { id: 'feed', group: 'Go to', title: 'Feed', icon: <FeedIcon size={14} />, keywords: ['stream', 'activity'], run: activity('feed') },
      { id: 'reports', group: 'Go to', title: 'Reports', icon: <ChartIcon size={14} />, keywords: ['insights', 'metrics'], run: activity('insights') },
      ...REPORT_TABS.map(([id, label]) => ({
        id: `reports:${id}`,
        group: 'Go to' as const,
        title: `Reports: ${label}`,
        icon: <ChartIcon size={14} />,
        run: (): void => {
          f().setActivityRepo('insights');
          f().setInsightsInnerTab(id);
          t().showActivity();
        },
      })),
      { id: 'bots', group: 'Go to', title: 'Bots Monitoring', icon: <BotIcon size={14} />, run: activity('bots') },
      ...BOT_TABS.filter(([id]) => aiOn || id !== 'themes').map(([id, label]) => ({
        id: `bots:${id}`,
        group: 'Go to' as const,
        title: `Bots: ${label}`,
        icon: <BotIcon size={14} />,
        run: (): void => {
          f().setActivityRepo('bots');
          f().setBotsInnerTab(id);
          t().showActivity();
        },
      })),
      { id: 'sprint', group: 'Go to', title: 'This Sprint', icon: <TimelineIcon size={14} />, keywords: ['tickets', 'jira'], run: () => t().showSprint() },
      ...SPRINT_TABS.map(([id, label]) => ({
        id: `sprint:${id}`,
        group: 'Go to' as const,
        title: `This Sprint: ${label}`,
        icon: <TimelineIcon size={14} />,
        run: (): void => {
          f().setSprintInnerTab(id);
          t().showSprint();
        },
      })),
      { id: 'timeline', group: 'Go to', title: 'Timeline', icon: <TimelineIcon size={14} />, keywords: ['board'], run: () => t().showTimeline() },
      {
        id: 'settings',
        group: 'Settings',
        title: 'Open Settings',
        icon: <GearIcon size={14} />,
        keywords: ['preferences'],
        run: () => useSettingsModal.getState().openSettings(),
      },
      ...SETTINGS_TABS.filter((s) => aiOn || s.aiOnly !== true).map((s) => ({
        id: `settings:${s.id}`,
        group: 'Settings' as const,
        title: `Settings: ${s.label}`,
        icon: <GearIcon size={14} />,
        run: (): void => {
          const m = useSettingsModal.getState();
          m.setLastTab(s.id);
          m.openSettings();
        },
      })),
      { id: 'theme', group: 'Actions', title: 'Switch light / dark theme', icon: <MoonIcon size={14} />, keywords: ['dark mode', 'light mode'], run: toggleTheme },
      {
        id: 'sync',
        group: 'Actions',
        title: 'Sync all repos now',
        icon: <RefreshIcon size={14} />,
        keywords: ['refresh', 'github'],
        run: () => getSyncRoundActions()?.syncAllShallow(),
      },
      { id: 'help', group: 'Help', title: 'Help and keyboard shortcuts', icon: <QuestionIcon size={14} />, keywords: ['keys', 'shortcuts'], run: openHelp },
    ];
    for (const w of workspaces ?? []) {
      if (w.id === workspaceId) continue;
      out.push({
        id: `workspace:${w.id}`,
        group: 'Go to',
        title: `Switch to workspace ${w.name}`,
        icon: <WorkspaceIcon size={14} />,
        hint: `${w.repoCount} repos`,
        run: () => useFilters.getState().switchWorkspaceToOpenPrs(w.id),
      });
    }
    return out;
  }, [aiOn, workspaces, workspaceId, toggleTheme, openHelp]);

  useRegisterCommands('shell', commands);

  // Every open PR in the workspace (data the Open PRs rail line already holds — no new request
  // shape), and the search fallback that reaches everything else.
  const { data: openPrs } = useWorkspaceOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  const prCommands = useMemo<Command[]>(() => {
    const repoName = new Map((repos ?? []).map((r) => [r.id, r.fullName]));
    const byId = indexUsers(users);
    return (openPrs?.prs ?? []).map((p) => {
      const full = repoName.get(p.repoId) ?? '';
      const short = full.split('/')[1] ?? full;
      const author = p.authorId != null ? byId.get(p.authorId) : undefined;
      return {
        id: `pr:${p.id}`,
        group: 'Pull requests' as const,
        title: p.title,
        hint: `${short}#${p.number}`,
        keywords: [`#${p.number}`, String(p.number), full, author?.githubLogin ?? ''],
        icon: <PullRequestIcon size={14} />,
        run: () =>
          usePinnedTabs.getState().openPrDetailTab(
            {
              id: p.id,
              number: p.number,
              title: p.title,
              repoFullName: full,
              authorLogin: author?.githubLogin ?? null,
              authorDisplayName: author?.displayName ?? null,
              authorAvatarUrl: author?.avatarUrl ?? null,
            },
          ),
      };
    });
  }, [openPrs, repos, users]);

  const provider = useCallback(
    (query: string): readonly Command[] => {
      const q = query.trim();
      const search: Command[] =
        q.length >= 2
          ? [
              {
                id: 'search-all',
                group: 'Search',
                // The query is NOT in the title, so a real match (a PR whose title starts with it)
                // always ranks above this fallback; it matches through its keywords instead.
                title: 'Search everything: PRs, threads, people, tickets',
                hint: `“${q}”`,
                icon: <MagnifierIcon size={14} />,
                // Always matches: its keywords are the query itself.
                keywords: q.toLowerCase().split(/\s+/),
                run: () => useFilters.getState().openSearchDetail(q),
              },
            ]
          : [];
      return [...prCommands, ...search];
    },
    [prCommands],
  );
  useCommandProvider('shell:prs', provider);
}
