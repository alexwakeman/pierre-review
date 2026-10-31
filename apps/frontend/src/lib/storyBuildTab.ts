import { useCallback } from 'react';
import { usePinnedTabs, type TabTicketMeta } from '../store/pinnedTabs.js';

// THE ONE WAY TO OPEN A BUILD TAB ("Implement story", docs/STORY-BUILD.md; docs/FRONTEND.md § The build
// tab). The tab is ONE ticket's build session: key `story-build:<ident>` (shared STORY_BUILD_TAB_PREFIX),
// ephemeral but self-describing like the story tab. Every entry point — the STORY VIEW's Implement /
// Fill gaps / Open build action (This Sprint's tray, the story tab, the PR view's Story tab;
// StoryBuild/StoryBuildEntry.tsx) and its ⌘K commands — calls the function this hook returns:
//
//   const openBuild = useOpenStoryBuild();
//   openBuild({ ident, key, title, offer });
//
// `offer` is what the story view offered (its action, and the story check behind Fill gaps): the tab's
// start state falls back to it when the sprint board's node is not in memory.
// Opening the tab never starts anything: the tab's Start button (inside `AiRunGate`) does.
export interface OpenStoryBuildArgs {
  ident: string;
  key: string;
  title: string | null;
  offer?: TabTicketMeta['buildOffer'];
}

export function useOpenStoryBuild(): (t: OpenStoryBuildArgs) => void {
  const open = usePinnedTabs((s) => s.openStoryBuildTab);
  return useCallback(
    (t: OpenStoryBuildArgs) => open({ ident: t.ident, key: t.key, title: t.title, ...(t.offer != null ? { buildOffer: t.offer } : {}) }),
    [open],
  );
}

/** The build tab's words: the chip, its tooltip / accessible name, and its close button. Pure
 *  (test/storyBuildTab.test.ts). */
export function storyBuildTabLabels(key: string | null | undefined): { chip: string; title: string; closeAria: string } {
  const k = key != null && key.trim() !== '' ? key.trim() : null;
  return {
    chip: k != null ? `${k} · Build` : 'Build',
    title: k != null ? `${k}: implementation` : 'Implementation',
    closeAria: 'Close build tab',
  };
}
