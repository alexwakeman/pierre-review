import { useCallback } from 'react';
import { usePinnedTabs } from '../store/pinnedTabs.js';

// THE ONE WAY TO OPEN A BUILD TAB ("Implement story", docs/STORY-BUILD.md; docs/FRONTEND.md § The build
// tab). The tab is ONE ticket's build session: key `story-build:<ident>` (shared STORY_BUILD_TAB_PREFIX),
// ephemeral but self-describing like the story tab. Every entry point — This Sprint's Implement button
// and build mark (owner decision 4: a NOT-STARTED ticket with no pull request), and the ⌘K command for
// the same tickets — calls the function this hook returns:
//
//   const openBuild = useOpenStoryBuild();
//   openBuild({ ident, key, title });
//
// Opening the tab never starts anything: the tab's Start button (inside `AiRunGate`) does.
export interface OpenStoryBuildArgs {
  ident: string;
  key: string;
  title: string | null;
}

export function useOpenStoryBuild(): (t: OpenStoryBuildArgs) => void {
  const open = usePinnedTabs((s) => s.openStoryBuildTab);
  return useCallback((t: OpenStoryBuildArgs) => open({ ident: t.ident, key: t.key, title: t.title }), [open]);
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
