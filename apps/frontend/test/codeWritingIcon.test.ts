// ONE MARK FOR "A MODEL WRITES CODE": AI Fix and Implement story share the wrench (`WrenchIcon`),
// the hammer (`BuildIcon`) is gone, and the AI Fix toast never wears the merge resolver's wand
// (Icons.tsx § TWO MARKS THAT MUST NEVER BE SWAPPED), and the cluster spreads on a real hover only.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend codeWritingIcon
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');

describe('the code-writing mark', () => {
  it('has no hammer left', () => {
    expect(sourceOf('components/Icons.tsx')).not.toContain('BuildIcon');
  });
  it('puts the wrench on the AI Fix toast, never the wand', () => {
    const banner = sourceOf('components/AiFixBanner.tsx');
    expect(banner).toContain('<WrenchIcon');
    expect(banner).not.toContain('WandIcon');
  });
  it.each([
    'components/TicketCard.tsx',
    'components/PinnedTabsBar.tsx',
    'components/Activity/SprintBoards.tsx',
    'components/StoryBuild/StartPanel.tsx',
    'components/StoryBuild/StoryBuildEntry.tsx',
    'components/StoryBuild/StoryBuildTabView.tsx',
    'components/PrDetail.tsx',
  ])('marks Implement story / AI Fix with the wrench in %s', (file) => {
    expect(sourceOf(file)).toContain('<WrenchIcon');
  });
});

describe('the toast cluster spread', () => {
  const src = sourceOf('components/HeaderToasts.tsx');
  it('spreads on a real hover or keyboard focus, in a named group, with motion-safe transitions', () => {
    expect(src).toContain('[@media(hover:hover)]:group-hover/toasts:ml-2.5');
    expect(src).toContain('group-focus-visible/toasts:ml-2.5');
    expect(src).toContain('group/toasts');
    expect(src).toContain('motion-safe:transition-[margin]');
    // A bare `group-hover:` would spread on a touch tap too.
    expect(src).not.toMatch(/(?<!\]:)group-hover\/toasts/);
  });
});
