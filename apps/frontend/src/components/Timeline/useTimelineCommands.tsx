import { useMemo } from 'react';
import { useFilters, type RangePreset } from '../../store/filters.js';
import { useTimelineLayout } from '../../store/timelineLayout.js';
import { useRegisterCommands, type Command } from '../ui/commands.js';
import { BarsIcon, FilterIcon, TimelineIcon } from '../Icons.js';

// ⌘K FOR THE TIMELINE (docs/redesign/DESIGN.md § Command palette): the board's toolbar as commands,
// registered only while the Timeline is the page (the FilterBar calls this; it is mounted on every
// view, so `enabled` says when). Going TO the Timeline is the shell's command; the filter PANELS
// (Repos, Members, Status, Events, Threads) stay in the bar — they are lists to tick, not one action.

const RANGES: ReadonlyArray<{ preset: Exclude<RangePreset, 'custom'>; words: string }> = [
  { preset: '7d', words: '7 days' },
  { preset: '14d', words: '14 days' },
  { preset: '30d', words: '30 days' },
  { preset: '90d', words: '90 days' },
];

export function useTimelineCommands({ enabled, phone }: { enabled: boolean; phone: boolean }): void {
  const layout = useTimelineLayout((s) => s.phone);
  const commands = useMemo<Command[] | null>(() => {
    if (!enabled) return null;
    const f = () => useFilters.getState();
    const out: Command[] = RANGES.map((r) => ({
      id: `range:${r.preset}`,
      group: 'Actions',
      title: `Timeline: show the last ${r.words}`,
      keywords: ['range', r.preset, 'window'],
      icon: <TimelineIcon size={14} />,
      run: () => f().setPreset(r.preset),
    }));
    out.push(
      {
        id: 'now',
        group: 'Actions',
        title: 'Timeline: centre on now',
        keywords: ['today', 'current time', 'recenter'],
        icon: <TimelineIcon size={14} />,
        run: () => f().centerTimelineNow(),
      },
      {
        id: 'clear',
        group: 'Actions',
        title: 'Timeline: clear filters',
        keywords: ['reset', 'filters'],
        icon: <FilterIcon size={14} />,
        run: () => f().resetAllFilters(),
      },
    );
    if (phone) {
      out.push({
        id: 'layout',
        group: 'Actions',
        title: layout === 'list' ? 'Timeline: show the board' : 'Timeline: show as a list',
        keywords: ['list', 'board', 'layout'],
        icon: layout === 'list' ? <TimelineIcon size={14} /> : <BarsIcon size={14} />,
        run: () => useTimelineLayout.getState().setPhone(layout === 'list' ? 'board' : 'list'),
      });
    }
    return out;
  }, [enabled, phone, layout]);
  useRegisterCommands('timeline', commands);
}
